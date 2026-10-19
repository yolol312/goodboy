import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { recordOutsideRepo } from '../lib/cli';
import { readRegressionRecords, regressionCommands } from '../lib/regression';
import { detectTestInfrastructure } from '../lib/test-validator';

// Track I, I7 (#14, plan §15.10): fixes for what the second real-use trial ran into.

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-i7-'));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function repo(files: Record<string, string>): string {
  const cwd = join(tmp(), 'repo');
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  for (const [rel, text] of Object.entries({ '.gitignore': '.claude/\n', ...files })) write(cwd, rel, text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  return cwd;
}

describe('finding 1: layer 1 in JVM projects', () => {
  test('AC-1: Gradle and Maven builds, and the src/test layout, are test infrastructure', () => {
    const at = (files: Record<string, string>) => {
      const d = tmp();
      for (const [rel, text] of Object.entries(files)) write(d, rel, text);
      return detectTestInfrastructure(d);
    };
    expect(at({ 'build.gradle': "plugins { id 'java' }\n" })).toEqual({ present: true, evidence: 'build.gradle (gradle test)' });
    expect(at({ 'build.gradle.kts': 'plugins { java }\n' })).toEqual({ present: true, evidence: 'build.gradle.kts (gradle test)' });
    expect(at({ 'pom.xml': '<project/>\n' })).toEqual({ present: true, evidence: 'pom.xml (mvn test)' });
    expect(at({ 'src/test/java/a/ATest.java': 'class ATest {}\n' })).toEqual({ present: true, evidence: 'src/test/' });
    // `gradle init`'s layout: the root has only the settings file.
    expect(at({ 'settings.gradle.kts': '', 'app/build.gradle.kts': '' })).toEqual({ present: true, evidence: 'settings.gradle.kts (gradle test)' });
    expect(at({ 'settings.gradle': '', 'app/build.gradle': '' })).toEqual({ present: true, evidence: 'settings.gradle (gradle test)' });
    expect(at({ 'src/main/java/a/A.java': 'class A {}\n' }).present).toBe(false);
  });
});

describe('finding 2: a full regression for Gradle and Maven', () => {
  const at = (files: Record<string, string>, exec: string[] = []) => {
    const d = tmp();
    for (const [rel, text] of Object.entries(files)) write(d, rel, text);
    for (const rel of exec) chmodSync(join(d, rel), 0o755);
    return regressionCommands(d);
  };
  test("AC-2: the repo's wrapper first (sh when it is not executable), else the tool", () => {
    expect(at({ 'build.gradle': '', gradlew: '#!/bin/sh\n' }, ['gradlew'])).toEqual({ commands: ['./gradlew test'], source: 'Gradle' });
    expect(at({ 'build.gradle.kts': '', gradlew: '#!/bin/sh\n' })!.commands).toEqual(['sh ./gradlew test']);
    expect(at({ 'settings.gradle.kts': '' })!.commands).toEqual(['gradle test']);
    expect(at({ 'pom.xml': '<project/>', mvnw: '#!/bin/sh\n' }, ['mvnw'])).toEqual({ commands: ['./mvnw test'], source: 'pom.xml' });
    expect(at({ 'pom.xml': '<project/>' })!.commands).toEqual(['mvn test']);
    // A directory named like a wrapper is none; both tools run when both are there.
    expect(at({ 'build.gradle': '', 'gradlew/x': '' })!.commands).toEqual(['gradle test']);
    expect(at({ 'build.gradle': '', 'pom.xml': '<project/>' })).toEqual({ commands: ['gradle test', 'mvn test'], source: 'Gradle + pom.xml' });
  });

  test('AC-2: cli.ts regression runs the Gradle wrapper and records its exit code', () => {
    const run = (exit: number) => {
      const cwd = repo({ 'build.gradle': "plugins { id 'java' }\n", gradlew: `#!/bin/sh\necho "ran gradlew $*"\nexit ${exit}\n` });
      chmodSync(join(cwd, 'gradlew'), 0o755);
      git(cwd, 'commit', '-qam', 'exec');
      const p = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'regression'], { cwd, stdout: 'pipe', stderr: 'pipe' });
      return { code: p.exitCode, rec: readRegressionRecords(cwd)[0]! };
    };
    const ok = run(0);
    expect(ok.code).toBe(0);
    expect(ok.rec).toMatchObject({ verdict: 'pass', source: 'Gradle' });
    expect(ok.rec.runs[0]).toMatchObject({ command: './gradlew test', exit_code: 0 });
    expect(ok.rec.runs[0]!.output_tail).toContain('ran gradlew test');
    const bad = run(1);
    expect(bad.code).toBe(1);
    expect(bad.rec.verdict).toBe('fail');
  }, 30_000);
});

describe("finding 3: results written from goodboy's own directory", () => {
  test('AC-3: a record for files outside the repo the CLI runs in is refused there, and only there', () => {
    const project = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const inProject = join(project, 'src', 'a.ts');
    expect(recordOutsideRepo(ROOT, [inProject])).toBe(inProject);
    expect(recordOutsideRepo(join(ROOT, 'lib'), ['cli.ts', inProject])).toBe(inProject);
    // goodboy's own files (a deleted one too) from its own directory, and any files from a
    //   project, pass.
    expect(recordOutsideRepo(ROOT, [join(ROOT, 'lib', 'cli.ts'), 'lib/cli.ts', join(ROOT, 'lib', 'gone.ts')])).toBeNull();
    // A relative name that is no goodboy file is another project's.
    expect(recordOutsideRepo(ROOT, ['src/a.ts'])).toBe('src/a.ts');
    expect(recordOutsideRepo(project, [inProject, join(ROOT, 'lib', 'cli.ts')])).toBeNull();
  });

  test('AC-3: through the CLI of a goodboy copy, review-write and test-write refuse; from the project they write', () => {
    // A copy of goodboy's lib/ as the plugin root (no git repo, like an installed plugin), so a
    //   regression never writes into this repo; the CLI runs from its lib/.
    const plugin = join(tmp(), 'goodboy');
    cpSync(join(ROOT, 'lib'), join(plugin, 'lib'), { recursive: true });
    const project = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const file = join(project, 'src', 'a.ts');
    const review = { category: 'add-feature', reviewed_files: [file], dimensions_checked: ['security-authz'], findings: [], verdict: 'pass', summary: 'ok' };
    const cli = (cwd: string, cmd: string, body: unknown) => {
      const p = Bun.spawnSync(['bun', join(plugin, 'lib', 'cli.ts'), cmd], { cwd, stdin: new TextEncoder().encode(JSON.stringify(body)), stdout: 'pipe', stderr: 'pipe' });
      return { code: p.exitCode, err: p.stderr.toString() + p.stdout.toString() };
    };
    const refused = cli(join(plugin, 'lib'), 'review-write', review);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("is outside goodboy's own directory, where this command runs");
    expect(existsSync(join(plugin, 'lib', '.claude'))).toBe(false);
    const result = {
      tested_files: [file],
      category: 'add-feature',
      test_files: [write(project, 'a.test.ts', 'test("a", () => {});\n')],
      environment: { mode: 'local' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 5 }],
      acceptance: [{ id: 'AC-1', description: 'a', test: 'a.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } }],
      verdict: 'pass',
    };
    expect(cli(plugin, 'test-write', result).code).not.toBe(0);
    expect(existsSync(join(plugin, '.claude', 'tests'))).toBe(false);
    expect(cli(project, 'review-write', review).code).toBe(0);
    expect(readdirSync(join(project, '.claude', 'reviews'))).toHaveLength(1);
  }, 30_000);
});

describe('finding 4: open Bash calls at Stop while agents run', () => {
  test("AC-4: the Stop finishes a running agent's call and watches the rest of it from there; its SubagentStop closes it", async () => {
    const base = tmp();
    const cwd = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const plain = tmp(); // no git repo: the Stop cannot sweep a call that ran there
    const sid = `i7-${Math.random().toString(36).slice(2)}`;
    const session = join(base, `goodboy-session-${sid}`);
    const env = { ...process.env, TMPDIR: base, GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' } as Record<string, string>;
    const run = (code: string) => {
      const p = Bun.spawnSync(['bun', '-e', code], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
      return p.stdout.toString();
    };
    const hook = async (name: string, payload: Record<string, unknown>) => {
      const proc = Bun.spawn(['bun', join(ROOT, 'hooks', name)], { cwd, stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })), stdout: 'pipe', stderr: 'pipe', env });
      await new Response(proc.stdout).text();
      await proc.exited;
    };
    const stop = (status: 'running' | 'completed') =>
      hook('stop.ts', { hook_event_name: 'Stop', background_tasks: [{ id: 'a1', type: 'subagent', status, agent_type: 'goodboy:review-changes' }] });
    const open = () =>
      Object.fromEntries(
        (JSON.parse(run(`import { openBashCalls } from '${ROOT}/lib/approval-marker'; console.log(JSON.stringify(openBashCalls('${sid}').map((n) => [n.tuid, n.t])));`)) as [string, number][]),
      );
    const edits = () =>
      readFileSync(join(session, 'edits.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => (JSON.parse(l) as { file: string }).file.replace(/^.*\/src\//, 'src/'));
    // An edit from two minutes ago, inside the post hook's five-minute fallback window.
    const old = write(cwd, 'src/a.ts', 'export const a = 2;\n');
    utimesSync(old, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    await Bun.sleep(1_200);
    run(`import { noteBashStart } from '${ROOT}/lib/approval-marker';
         noteBashStart('${sid}', 'toolu_agentcall', process.cwd(), "python3 -c 'pass'", 'agent1');
         noteBashStart('${sid}', 'toolu_endedcall', process.cwd(), "python3 -c 'pass'", 'agent2');
         noteBashStart('${sid}', 'toolu_plaincall', '${plain}', "python3 -c 'pass'", 'agent3');
         noteBashStart('${sid}', 'toolu_maincall', process.cwd(), "python3 -c 'pass'");`);
    writeFileSync(join(session, 'edits.jsonl'), JSON.stringify({ file: join(cwd, 'src', 'z.ts'), turn: 0, timestamp: new Date().toISOString() }) + '\n');
    const before = open();
    expect(Object.keys(before).sort()).toEqual(['toolu_agentcall', 'toolu_endedcall', 'toolu_maincall', 'toolu_plaincall']);
    await stop('running');
    // The main session's call is finished; the agents' calls are finished and noted again, as
    //   they may still run: from this Stop, or from their own start when it could not sweep
    //   their writes. Nothing recorded the old edit.
    const after = open();
    expect(Object.keys(after).sort()).toEqual(['toolu_agentcall', 'toolu_endedcall', 'toolu_plaincall']);
    expect(after.toolu_agentcall).toBeGreaterThan(before.toolu_agentcall!);
    expect(after.toolu_plaincall).toBe(before.toolu_plaincall!);
    expect(edits()).toEqual(['src/z.ts']);
    // agent2 ended (`exit N` fired no post hook): its SubagentStop finishes its call only.
    await hook('subagent-stop.ts', { hook_event_name: 'SubagentStop', agent_id: 'agent2', agent_type: 'goodboy:test-changes', last_assistant_message: 'done' });
    expect(Object.keys(open()).sort()).toEqual(['toolu_agentcall', 'toolu_plaincall']);
    // agent1's call goes on after the Stop: it writes a file, makes a marker and empties the
    //   edit log. Its post hook records that write only, removes the marker and puts the log back.
    await Bun.sleep(1_200);
    write(cwd, 'src/b.ts', 'export const b = 1;\n');
    const marker = write(cwd, `.claude/.goodboy-stop-approved-${sid.slice(0, 8)}.txt`, '');
    writeFileSync(join(session, 'edits.jsonl'), '');
    run(`import { afterBash } from '${ROOT}/lib/write-sweep'; afterBash('${sid}', 'toolu_agentcall', process.cwd(), "python3 -c 'pass'", 'agent1');`);
    expect(edits()).toEqual(['src/z.ts', 'src/b.ts']);
    expect(existsSync(marker)).toBe(false);
    // With no subagent running (the task completed), the Stop finishes what is left and notes
    //   nothing again.
    await stop('completed');
    expect(open()).toEqual({});
  }, 40_000);
});
