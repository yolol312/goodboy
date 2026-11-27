// N8b (plan §20.12, #44 item 2) through the real PreToolUse hook (spawned, as tests/i39-nested-repo-push.test.ts does)
// and the real `test-write`, `review-write` and `regression` commands:
//   AC-7   a `git push` that passes the push test and the regression checks is denied with the deferral message when a
//          file the user deferred (`defer-test`, `defer-review`) has no evidence of the pushed content, passes with the
//          evidence, passes once on the user's push-test marker, and only warns under GOODBOY_PUSH_TEST_GATE=warn;
//   AC-8   an Edit or Write that adds a `defer-review` or `defer-test` glob to a human entry is denied with the new
//          message, and the old keys keep the old one.
// The push target is a local bare repository; the hook only inspects the command, nothing is pushed by it.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { notePolicySeen } from '../lib/deferral';
import { getCurrentTurn, recordRead } from '../lib/file-tracker';
import { readGateLog } from '../lib/gate-log';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
setDefaultTimeout(120_000);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-n8bp-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
const V1 = 'export const a = 1;\n';
const V2 = 'export const a = 1;\nexport const b = 2;\n';
const policy = (globs: Record<string, string>, decide = 'human'): string =>
  ['## P1 Deferrals', `- decide: ${decide}`, '- source: user 2026-11-26', ...Object.entries(globs).map(([k, v]) => `- ${k}: ${v}`), ''].join('\n');

const RED_GREEN = [
  {
    id: 'AC-1',
    description: 'a is 1',
    test: 'a.test.ts',
    red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
    green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
  },
];
const testInput = (tested: string[], testFiles: string[]) => ({
  timestamp: new Date().toISOString(),
  tested_files: tested,
  category: 'fix-bug',
  test_files: testFiles,
  environment: { mode: 'local' },
  suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
  acceptance: RED_GREEN,
  verdict: 'pass',
});

interface Out {
  denied: boolean;
  reason: string;
  /** The whole answer, for the warnings that are not the decision. */
  raw: string;
}

interface World {
  /** The project dir (a repo, or a plain folder holding `be/`). */
  proj: string;
  /** The repo the push is made from. */
  repo: string;
  sid: string;
  env: Record<string, string>;
  cli: (cwd: string, args: string[], stdin?: string) => { code: number | null; out: string; err: string };
  record: (tested: string[]) => void;
  regression: (cwd?: string) => void;
  review: (files: string[], over?: Record<string, unknown>) => void;
  push: (opts?: { cwd?: string; env?: Record<string, string>; command?: string }) => Promise<Out>;
  /** The user's marker path that a denial names. */
  markerOf: (o: Out) => string;
}

/** A repo (the project dir) with src/a.ts, src/b.ts and a passing test, pushed once to a local bare repo, and one
 *  unpushed commit that changes both source files. `globs` is the policy the user wrote. */
function world(globs: Record<string, string> | null, opts: { nested?: boolean } = {}): World {
  const base = tmp();
  const proj = opts.nested ? join(base, 'proj') : join(base, 'repo');
  const repo = opts.nested ? join(proj, 'be') : proj;
  mkdirSync(repo, { recursive: true });
  write(repo, 'src/a.ts', V1);
  write(repo, 'src/b.ts', V1);
  write(repo, 'a.test.ts', 'test("a", () => {});\n');
  write(repo, 'package.json', JSON.stringify({ scripts: { test: 'true' } }));
  write(repo, 'bun.lock', '');
  if (globs !== null) write(proj, '.goodboy/policy.md', policy(globs));
  sh(repo, `${GIT_INIT}`);
  if (!opts.nested) {
    sh(repo, 'git add -A && git commit -q -m init');
  } else {
    sh(repo, 'git add -A && git commit -q -m init');
  }
  const bare = join(base, 'origin.git');
  sh(base, `git init -q --bare ${bare}`);
  sh(repo, `git remote add origin ${bare} && git push -q origin main`);
  write(repo, 'src/a.ts', V2);
  write(repo, 'src/b.ts', V2);
  sh(repo, 'git add -A && git commit -q -m work');

  const sid = `n8bp-${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.CLAUDE_CODE_SESSION_ID;
  Object.assign(env, { CLAUDE_PROJECT_DIR: proj, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GOODBOY_OUTWARD_GATE: 'off', GOODBOY_PUSH_REGRESSION: 'on', GOODBOY_POLICY_GATE: 'off' });
  const cli = (cwd: string, args: string[], stdin = '') => {
    const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const hook = async (payload: Record<string, unknown>, cwd: string, extra: Record<string, string> = {}): Promise<Out> => {
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, hook_event_name: 'PreToolUse', ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...env, ...extra },
    });
    const raw = (await new Response(proc.stdout).text()) || '{}';
    await proc.exited;
    const h = ((JSON.parse(raw) as Record<string, unknown>).hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', raw };
  };
  return {
    proj,
    repo,
    sid,
    env,
    cli,
    record: (tested) => {
      const r = cli(proj, ['test-write'], JSON.stringify(testInput(tested, [join(repo, 'a.test.ts')])));
      if (r.code !== 0) throw new Error(r.err);
    },
    regression: (cwd = repo) => {
      const r = cli(cwd, ['regression']);
      if (r.code !== 0) throw new Error(`${r.out}${r.err}`);
    },
    review: (files, over = {}) => {
      const input = { reviewed_files: files, category: 'fix-bug', findings: [], verdict: 'pass', dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(), ...over };
      const r = cli(proj, ['review-write'], JSON.stringify(input));
      if (r.code !== 0) throw new Error(`${r.out}${r.err}`);
    },
    push: (o = {}) => hook({ tool_name: 'Bash', tool_input: { command: o.command ?? 'git push origin main' } }, o.cwd ?? repo, o.env ?? {}),
    markerOf: (o) => {
      const m = /`! touch (\S+)`/.exec(o.reason);
      if (!m) throw new Error(`no marker in: ${o.reason}`);
      return resolve(repo, m[1]!);
    },
  };
}
const src = (w: World, name: string): string => join(w.repo, 'src', name);

describe('AC-7: the push, with a deferred test', () => {
  test('a file with no passing record that lists it: denied with the deferral message, after the other checks passed', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('the user deferred to the push');
    expect(out.reason).toContain('tests: src/b.ts');
    expect(out.reason).not.toContain('src/a.ts');
    expect(out.reason).toContain('(deferral due at push, N8b)');
    expect(out.reason).not.toContain('without a passing test result');
    expect(out.reason).toContain('! touch'); // the user's way out is named
    const log = readGateLog(w.sid).filter((e) => e.gate === 'push-test');
    expect(log.map((e) => `${e.decision}:${e.reason}`)).toEqual(['deny:deferred-due git push origin main']);
  });

  test('without the record of the tree the push test check is the one that denies (the deferral is the later check)', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing test result');
    expect(out.reason).not.toContain('deferral due at push');
  });

  test('with the regression missing, that check denies first', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing full regression');
  });

  test('a passing record that lists the deferred file lets the push through', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const out = await w.push();
    expect(out.denied).toBe(false);
    expect(readGateLog(w.sid).filter((e) => e.gate === 'push-test')).toEqual([]);
  });

  test('no deferral in the policy: the unlisted file is not asked about (the control)', async () => {
    const w = world({ 'coverage-exempt': 'zzz/**' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    expect((await w.push()).denied).toBe(false);
    const none = world(null);
    none.record([src(none, 'a.ts')]);
    none.regression();
    expect((await none.push()).denied).toBe(false);
  });

  test('a deferral of an `ai` entry is no deferral', async () => {
    const w = world(null);
    write(w.proj, '.goodboy/policy.md', policy({ 'defer-test': 'src/b.ts' }, 'ai'));
    w.record([src(w, 'a.ts')]);
    w.regression();
    expect((await w.push()).denied).toBe(false);
  });

  test('a push of a branch the user names, a tag push and `git push` alone are all checked', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    for (const command of ['git push', 'git push origin main', 'git push -u origin main', 'git push origin HEAD']) {
      const out = await w.push({ command });
      expect([command, out.denied, out.reason.includes('deferral due at push')]).toEqual([command, true, true]);
    }
  });

  test('the user\'s push-test marker lets one push through, and the next is denied again', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const first = await w.push();
    expect(first.denied).toBe(true);
    const marker = w.markerOf(first);
    writeFileSync(marker, '');
    const passed = await w.push();
    expect(passed.denied).toBe(false);
    expect(existsSync(marker)).toBe(false); // used up
    const again = await w.push();
    expect(again.denied).toBe(true);
    expect(again.reason).toContain('deferral due at push');
  });

  test('GOODBOY_PUSH_TEST_GATE=warn lets the push through and only warns', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const out = await w.push({ env: { GOODBOY_PUSH_TEST_GATE: 'warn' } });
    expect(out.denied).toBe(false);
    expect(out.raw).toContain('deferral due at push');
    expect(out.raw).toContain('warn mode');
    const log = readGateLog(w.sid).filter((e) => e.gate === 'push-test');
    expect(log.map((e) => `${e.decision}:${e.reason}`)).toEqual(['warn:deferred-due git push origin main']);
  });

  test('GOODBOY_PUSH_TEST_GATE=off skips the check, as for the other push checks', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    expect((await w.push({ env: { GOODBOY_PUSH_TEST_GATE: 'off' } })).denied).toBe(false);
  });

  test('a hand-off that is no push (a pull request) is not checked for deferrals', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const out = await w.push({ command: 'gh pr create --title t --body b' });
    expect(out.reason).not.toContain('deferral due at push');
  });
});

describe('AC-7: the push, with a deferred review', () => {
  test('no review of the content pushed: denied naming the file; a clean review of it lets the push through', async () => {
    const w = world({ 'defer-review': 'src/a.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('review: src/a.ts (no review of the content pushed');
    expect(out.reason).not.toContain('src/b.ts');
    // A review of the other file does not cover it.
    w.review([src(w, 'b.ts')]);
    expect((await w.push()).denied).toBe(true);
    w.review([src(w, 'a.ts')]);
    expect((await w.push()).denied).toBe(false);
  });

  test('a review with a high finding on the file: denied as an open high finding, whichever review is newer', async () => {
    const w = world({ 'defer-review': 'src/a.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    w.review([src(w, 'a.ts')], { findings: [{ file: src(w, 'a.ts'), issue: 'a real problem', severity: 'high', suggestion: 'fix it', probe: "bun -e 'console.log(a)' → ReferenceError: a is not defined" }], verdict: 'needs-changes' });
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('review: src/a.ts (an open high finding on the content pushed');
    // A clean review made later of the same content does not clear a high finding on it.
    w.review([src(w, 'a.ts')]);
    const later = await w.push();
    expect(later.denied).toBe(true);
    expect(later.reason).toContain('an open high finding');
  });

  test('a review of other content does not count: an edit committed after the review is asked again', async () => {
    const w = world({ 'defer-review': 'src/a.ts' });
    w.review([src(w, 'a.ts')]);
    write(w.repo, 'src/a.ts', `${V2}export const c = 3;\n`);
    sh(w.repo, 'git add -A && git commit -q -m later');
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('review: src/a.ts (no review of the content pushed');
  });

  test('both deferrals: one denial names the tests and the review', async () => {
    const w = world({ 'defer-review': 'src/a.ts', 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('tests: src/b.ts');
    expect(out.reason).toContain('review: src/a.ts');
  });
});

describe('AC-7: a nested repo under a plain project folder', () => {
  test('a glob written for the repo matches its files; a review is read by the repo\'s tree', async () => {
    const w = world({ 'defer-review': 'src/a.ts', 'defer-test': 'src/b.ts' }, { nested: true });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const denied = await w.push();
    expect(denied.denied).toBe(true);
    expect(denied.reason).toContain('tests: src/b.ts');
    expect(denied.reason).toContain('review: src/a.ts (no review');
    // The record that lists the test file and a review of the other file, both taken from the plain folder.
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    w.review([src(w, 'a.ts')]);
    const record = JSON.parse(readFileSync(join(w.proj, '.claude', 'reviews', readdirNewest(join(w.proj, '.claude', 'reviews'))), 'utf8')) as { tree: unknown; trees: Record<string, string> };
    expect(record.tree).toBeNull();
    expect(Object.keys(record.trees)).toEqual([w.repo]);
    expect((await w.push()).denied).toBe(false);
  });

  test('a glob written for the project dir (`be/src/**`) matches too', async () => {
    const w = world({ 'defer-test': 'be/src/b.ts' }, { nested: true });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const out = await w.push();
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('tests: src/b.ts');
  });
});

describe('AC-7c: the push check holds against what the pushed refs and files can spell (reviews 2026-11-26)', () => {
  const deniedBy = (o: Out): boolean => o.denied && o.reason.includes('deferral due at push');
  /** The hook run with a fault injected into lib/deferral.ts when it is loaded (a preload plugin made in a temp dir). */
  async function pushWithFault(w: World, anchor: string, fault: string): Promise<Out> {
    const lib = readFileSync(join(ROOT, 'lib', 'deferral.ts'), 'utf8');
    expect(lib).toContain(anchor); // the fault lands where it says (a drifted anchor would test nothing)
    const dir = tmp('goodboy-n8bfault-');
    const preload = join(dir, 'fault.ts');
    writeFileSync(
      preload,
      `import { plugin } from 'bun';\nplugin({ name: 'fault', setup(b) { b.onLoad({ filter: /lib\\/deferral\\.ts$/ }, async (a) => ({ contents: (await Bun.file(a.path).text()).replace(${JSON.stringify(anchor)}, ${JSON.stringify(`${anchor}\n${fault}`)}), loader: 'ts' })); } });\n`,
    );
    const proc = Bun.spawn(['bun', '--preload', preload, HOOK], {
      cwd: w.repo,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: w.sid, cwd: w.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: w.env,
    });
    const raw = (await new Response(proc.stdout).text()) || '{}';
    await proc.exited;
    const h = ((JSON.parse(raw) as Record<string, unknown>).hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', raw };
  }

  test('a branch named `--output=<file>` is a name: the file is neither made nor truncated, and the deferred file is still asked for', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const victim = join(tmp(), 'victim.txt');
    writeFileSync(victim, 'precious\n');
    const absent = join(tmp(), 'never-made.txt');
    for (const target of [victim, absent]) {
      const ref = `--output=${target}`;
      sh(w.repo, `git update-ref ${JSON.stringify(`refs/heads/${ref}`)} HEAD`);
      const out = await w.push({ command: `git push origin -- ${JSON.stringify(ref)}` });
      expect([target, deniedBy(out), out.reason.includes('tests: src/b.ts')]).toEqual([target, true, true]);
    }
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
    expect(existsSync(absent)).toBe(false);
  });

  test('a push of more than 5000 new files cannot be judged: denied as unknown, whatever the newest commit hides', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    for (let i = 0; i <= 5000; i++) write(w.repo, `junk/f${i}.txt`, 'x\n');
    sh(w.repo, 'git add -A && git commit -q -m junk');
    w.record([src(w, 'a.ts')]);
    w.regression();
    const out = await w.push();
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('or they are more than 5000 (when the remote has commits this clone lacks, `git fetch` first), so their evidence cannot be checked');
    // The user's marker is the way through, as for the other deferral denials.
    expect(out.reason).toContain('! touch');
  });

  test('a deferred file named with a line break is unknown, not owed nothing', async () => {
    const w = world({ 'defer-test': 'src/**' });
    write(w.repo, 'src/evil\n.ts', V1);
    sh(w.repo, 'git add -A && git commit -q -m odd');
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const out = await w.push();
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('and git could not read the files main sends, so their evidence cannot be checked');
    // The control: the same push without that file passes.
    const ok = world({ 'defer-test': 'src/**' });
    ok.record([src(ok, 'a.ts'), src(ok, 'b.ts')]);
    ok.regression();
    expect((await ok.push()).denied).toBe(false);
  });

  test('a deferral glob that matches docs owes tests for the code only (what layer 1 asks, not every matched file)', async () => {
    const w = world({ 'defer-test': 'src/**, docs/**' });
    write(w.repo, 'docs/logo.png', 'png\n');
    write(w.repo, 'docs/guide.md', '# guide\n');
    write(w.repo, 'src/README.md', '# x\n');
    sh(w.repo, 'git add -A && git commit -q -m docs');
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const out = await w.push();
    expect([out.denied, out.reason]).toEqual([false, '']);
    // A code file under the same glob that no record lists is still owed (and only it).
    write(w.repo, 'src/c.ts', V1);
    sh(w.repo, 'git add -A && git commit -q -m code');
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const owed = await w.push();
    expect(deniedBy(owed)).toBe(true);
    expect(owed.reason).toContain('tests: src/c.ts');
    for (const doc of ['logo.png', 'guide.md', 'README.md']) expect(owed.reason).not.toContain(doc);
  });

  test('a check that throws denies the push also in the main session (it does not fail open like the other push checks)', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    expect((await w.push()).denied).toBe(false); // the control: with the evidence, no fault, the push passes
    const out = await pushWithFault(w, 'export function deferMatcher(globs: readonly string[], projectDir: string): DeferMatch {', "  throw new Error('boom');");
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('the check failed (Error: boom), so their evidence cannot be checked');
    const log = readGateLog(w.sid).filter((e) => e.gate === 'push-test');
    expect(log.map((e) => `${e.decision}:${e.reason}`)).toEqual(['deny:deferred-due git push origin main']);
  });

  test('a forged remote-tracking ref does not make the deferred file "already pushed"', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    sh(w.repo, 'git update-ref refs/remotes/origin/forged HEAD');
    sh(w.repo, 'git update-ref refs/remotes/upstream/main HEAD');
    const out = await w.push();
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('tests: src/b.ts');
  });

  test('a remote that cannot be read is unknown: the push is denied, named or default (the user\'s marker is the way through)', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    expect((await w.push()).denied).toBe(false); // the control: readable, with the evidence
    sh(w.repo, `git remote set-url origin ${JSON.stringify(join(tmp(), 'gone.git'))}`);
    const named = await w.push({ command: 'git push origin main' });
    expect(deniedBy(named)).toBe(true);
    expect(named.reason).toContain('and git could not read what the remote origin has (`git ls-remote`; a remote that needs your git or ssh config, or a git older than 2.32, cannot be read), so their evidence cannot be checked');
    expect(named.reason).toContain('! touch');
    const unnamed = await w.push({ command: 'git push' });
    expect(deniedBy(unnamed)).toBe(true);
    expect(unnamed.reason).toContain('git could not read what the remote of the push has');
    // A planted ssh command in the repo config is not run by the read.
    const marker = join(tmp(), 'PWNED');
    sh(w.repo, `git config core.sshCommand ${JSON.stringify(`touch ${marker}`)} && git remote set-url origin ssh://example.invalid/x.git`);
    expect(deniedBy(await w.push())).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  // AC-11g: the remote has several push URLs (security review): git pushes to each, so the first one that holds the commits
  //   (a mirror) must not stand in for the real remote after it.
  for (const key of ['pushurl', 'url'] as const) {
    test(`two remote.origin.${key} (a mirror that holds the commits first, the real remote second): the deferred file is owed; the mirror alone owes nothing`, async () => {
      const w = world({ 'defer-test': 'src/b.ts' });
      w.record([src(w, 'a.ts')]);
      w.regression();
      const base = dirname(w.repo);
      const real = join(base, 'origin.git');
      const mirror = join(base, 'mirror.git');
      sh(base, `git init -q --bare ${mirror}`);
      sh(w.repo, `git push -q ${mirror} main`);
      sh(w.repo, 'git config --unset-all remote.origin.url');
      if (key === 'pushurl') sh(w.repo, `git config remote.origin.url ${real}`);
      sh(w.repo, `git config --add remote.origin.${key} ${mirror}`);
      // The control: the mirror alone has every commit, so the push sends nothing that is deferred.
      expect([key, (await w.push()).denied]).toEqual([key, false]);
      sh(w.repo, `git config --add remote.origin.${key} ${real}`);
      const out = await w.push();
      expect([key, deniedBy(out), out.reason.includes('tests: src/b.ts')]).toEqual([key, true, true]);
    });
  }

  test('AC-11k: a `~/` URL (configured, or quoted on the command line) is unknown and denied, though a decoy at <top>/~/origin.git holds the commits', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    expect((await w.push()).denied).toBe(false); // the control: the real remote is readable and the evidence is there
    mkdirSync(join(w.repo, '~'));
    const decoy = join(w.repo, '~', 'origin.git');
    sh(w.repo, `git init -q --bare ${JSON.stringify(decoy)} && git push -q ${JSON.stringify(decoy)} main`);
    sh(w.repo, "git config remote.origin.url '~/origin.git'");
    const configured = await w.push();
    expect(deniedBy(configured)).toBe(true);
    expect(configured.reason).toContain('git could not read what the remote');
    sh(w.repo, `git config remote.origin.url ${join(dirname(w.repo), 'origin.git')}`);
    expect((await w.push()).denied).toBe(false);
    const typed = await w.push({ command: "git push '~/origin.git' main" });
    expect(deniedBy(typed)).toBe(true);
    expect(typed.reason).toContain('git could not read what the remote');
  });

  test('inline config that names the remote (`-c remote.<dotted name>.url`, `-c branch.<b>.remote`) is an unclear hand-off: denied', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const mirror = join(dirname(w.repo), 'mirror.git');
    sh(dirname(w.repo), `git init -q --bare ${mirror}`);
    expect((await w.push()).denied).toBe(false); // the control: plainly pushed, evidence there
    for (const command of [`git -c remote.origin.backup.url=${mirror} push origin.backup main`, `git -c branch.main.remote=${mirror} push`, `git -c remote.a.b.pushurl=${mirror} push a.b main`]) {
      const out = await w.push({ command });
      expect([command, out.denied, out.reason.includes('inline config')]).toEqual([command, true, true]);
    }
    // The controls: keys that decide neither are judged as the plain push is.
    for (const key of ['remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*', 'branch.main.merge=refs/heads/main']) {
      expect([key, (await w.push({ command: `git -c ${key} push origin main` })).denied]).toEqual([key, false]);
    }
  });

  test('GOODBOY_PUSH_REGRESSION=warn: the missing regression is warned, and a deferred file that is owed still denies; with nothing owed the push passes with the warning', async () => {
    const owed = world({ 'defer-test': 'src/b.ts' });
    owed.record([src(owed, 'a.ts')]); // no regression record
    const out = await owed.push({ env: { GOODBOY_PUSH_REGRESSION: 'warn' } });
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('tests: src/b.ts');
    // The denial carries the deferral text; the regression warning is in the gate log (a denial drops warnings).
    expect(readGateLog(owed.sid).filter((e) => e.gate === 'push-test').map((e) => `${e.decision}:${(e.reason ?? '').split(' ')[0]}`)).toEqual(['warn:regression-none', 'deny:deferred-due']);
    const clear = world({ 'defer-test': 'src/b.ts' });
    clear.record([src(clear, 'a.ts'), src(clear, 'b.ts')]);
    const ok = await clear.push({ env: { GOODBOY_PUSH_REGRESSION: 'warn' } });
    expect(ok.denied).toBe(false);
    expect(ok.raw).toContain('warn mode');
  });

  test('AC-11h: a relative URL is read from the work tree\'s top, also when the push is made from a subdir that holds a decoy', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts')]);
    w.regression();
    const sub = join(w.repo, 'sub');
    mkdirSync(sub);
    // `../origin.git` from the top is the real remote (<base>/origin.git); from `sub` it is <repo>/origin.git: a decoy.
    const decoy = join(w.repo, 'origin.git');
    sh(w.repo, `git init -q --bare ${decoy} && git push -q ${decoy} main && git config remote.rel.url ../origin.git`);
    const out = await w.push({ cwd: sub, command: 'git push rel main' });
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('tests: src/b.ts');
    const direct = await w.push({ cwd: sub, command: 'git push ../origin.git main' });
    expect(deniedBy(direct)).toBe(true);
  });

  test('the user-level config a model can write (~/.gitconfig) never runs in the remote read: a global core.sshCommand, and a credential helper for an http remote that answers 401', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const home = tmp('goodboy-n8bhome-');
    const cfg = join(home, '.gitconfig');
    const ssh = join(home, 'PWN-SSH');
    const cred = join(home, 'PWN-CRED');
    const env = { GIT_CONFIG_GLOBAL: cfg, HOME: home };
    writeFileSync(cfg, `[core]\n\tsshCommand = touch ${ssh} #\n`);
    const viaSsh = await w.push({ command: 'git push ssh://host.invalid/x main', env });
    expect(deniedBy(viaSsh)).toBe(true);
    expect(viaSsh.reason).toContain('git could not read what the remote ssh://host.invalid/x has');
    expect(existsSync(ssh)).toBe(false);
    writeFileSync(cfg, `[credential]\n\thelper = !touch ${cred} #\n`);
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm=x' } }) });
    try {
      const viaHttp = await w.push({ command: `git push http://127.0.0.1:${server.port}/x main`, env });
      expect(deniedBy(viaHttp)).toBe(true);
      expect(viaHttp.reason).toContain('git could not read what the remote');
    } finally {
      server.stop(true);
    }
    expect(existsSync(cred)).toBe(false);
  });

  test('an inherited GIT_ASKPASS, and GIT_CONFIG_COUNT config with a credential helper, run nothing in the remote read', async () => {
    const w = world({ 'defer-test': 'src/b.ts' });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const home = tmp('goodboy-n8bask-');
    const ask = join(home, 'ask.sh');
    writeFileSync(ask, `#!/bin/sh\ntouch ${join(home, 'PWN-ASK')}\necho x\n`);
    chmodSync(ask, 0o755);
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('no', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm=x' } }) });
    const url = `http://127.0.0.1:${server.port}/x`;
    try {
      const askpass = await w.push({ command: `git push ${url} main`, env: { GIT_ASKPASS: ask } });
      expect(deniedBy(askpass)).toBe(true);
      const count = await w.push({
        command: `git push ${url} main`,
        env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: `!touch ${join(home, 'PWN-CC')} #` },
      });
      expect(count.denied).toBe(true); // denied: the env config may be inline config, the check does not matter here
    } finally {
      server.stop(true);
    }
    expect(existsSync(join(home, 'PWN-ASK'))).toBe(false);
    expect(existsSync(join(home, 'PWN-CC'))).toBe(false);
  });

  test('more than 1000 deferral globs cannot be judged in the hook\'s time: the push is denied as unknown', async () => {
    const globs = Array.from({ length: 1001 }, (_, i) => `gen${i}/**`).join(', ');
    const w = world({ 'defer-test': `src/b.ts, ${globs}` });
    w.record([src(w, 'a.ts'), src(w, 'b.ts')]);
    w.regression();
    const out = await w.push();
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('there are more than 1000 deferral globs, so their evidence cannot be checked');
    // The control: exactly 1000 globs (src/b.ts and 999 more) are judged (and the evidence is there).
    const ok = world({ 'defer-test': `src/b.ts, ${Array.from({ length: 999 }, (_, i) => `gen${i}/**`).join(', ')}` });
    ok.record([src(ok, 'a.ts'), src(ok, 'b.ts')]);
    ok.regression();
    expect((await ok.push()).denied).toBe(false);
  });

  test('a tool that removed the deferral line after the session started does not drop what the push owes', async () => {
    // The pin (SessionStart) holds the glob.
    const pinned = world({ 'defer-test': 'src/b.ts' });
    pinCoverageStart(pinned.sid, pinned.proj);
    write(pinned.proj, '.goodboy/policy.md', policy({ 'coverage-exempt': 'zzz/**' }));
    pinned.record([src(pinned, 'a.ts')]);
    pinned.regression();
    const out = await pinned.push();
    expect(deniedBy(out)).toBe(true);
    expect(out.reason).toContain('tests: src/b.ts');
    // The record of the user's message holds it (no pin).
    const seen = world({ 'defer-test': 'src/b.ts' });
    notePolicySeen(seen.sid, seen.proj);
    write(seen.proj, '.goodboy/policy.md', policy({ 'coverage-exempt': 'zzz/**' }));
    seen.record([src(seen, 'a.ts')]);
    seen.regression();
    expect(deniedBy(await seen.push())).toBe(true);
    // The control: no pin and no record, the line gone: nothing is deferred.
    const none = world({ 'defer-test': 'src/b.ts' });
    write(none.proj, '.goodboy/policy.md', policy({ 'coverage-exempt': 'zzz/**' }));
    none.record([src(none, 'a.ts')]);
    none.regression();
    expect((await none.push()).denied).toBe(false);
  });
});

function readdirNewest(dir: string): string {
  const names = Bun.spawnSync(['ls', '-1', dir], { stdout: 'pipe' }).stdout.toString().split('\n').filter((n) => n.endsWith('.json'));
  return names.sort().pop()!;
}

// ── AC-8: the Edit/Write guard ──────────────────────────────────────────────────────────────────

describe('AC-8: only the user adds a deferral glob', () => {
  /** A project with a policy file holding `existing`, and the guard asked about an edit of it. */
  function guard(existing: string | null) {
    const d = tmp('goodboy-n8bg-');
    sh(d, GIT_INIT);
    const file = join(d, '.goodboy', 'policy.md');
    const sid = `n8bg-${Math.random().toString(36).slice(2, 10)}`;
    dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
    if (existing !== null) {
      write(d, '.goodboy/policy.md', existing);
      // The session has read the file, as the read-before-edit rule asks of an edit of an existing file.
      recordRead(sid, file, getCurrentTurn(sid), statSync(file).mtimeMs);
    }
    const run = async (payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<Out> => {
      const proc = Bun.spawn(['bun', HOOK], {
        cwd: d,
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd: d, hook_event_name: 'PreToolUse', ...payload })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CLAUDE_PROJECT_DIR: d, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GOODBOY_POLICY_GATE: 'off', ...env },
      });
      const raw = (await new Response(proc.stdout).text()) || '{}';
      await proc.exited;
      const h = ((JSON.parse(raw) as Record<string, unknown>).hookSpecificOutput ?? {}) as Record<string, string>;
      return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', raw };
    };
    return {
      d,
      sid,
      write: (content: string, env?: Record<string, string>) => run({ tool_name: 'Write', tool_input: { file_path: file, content } }, env),
      edit: (oldS: string, newS: string, env?: Record<string, string>) => run({ tool_name: 'Edit', tool_input: { file_path: file, old_string: oldS, new_string: newS } }, env),
      writeOther: (rel: string, content: string) => run({ tool_name: 'Write', tool_input: { file_path: join(d, rel), content } }),
      /** A link `rel` to the policy file (or, with `dir`, to the `.goodboy` dir), already read by the session. */
      link: (rel: string, dir = false) => {
        symlinkSync(dir ? join(d, '.goodboy') : file, join(d, rel));
        recordRead(sid, join(d, rel, ...(dir ? ['policy.md'] : [])), getCurrentTurn(sid), statSync(file).mtimeMs);
      },
    };
  }
  const ENTRY = (extra: string): string => `## P1 Deferrals\n- decide: human\n- source: user 2026-11-26\n${extra}\n`;

  test('a Write that adds a defer-review glob is denied with the new message', async () => {
    const g = guard(null);
    const out = await g.write(ENTRY('- defer-review: src/**'));
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('Only the user defers a review to the next push (N8b)');
    expect(out.reason).toContain('this edit adds defer-review: src/**');
    expect(out.reason).toContain('Run the tests and the review the Stop asks for, or ask the user: they add the line themselves, and it counts from their next message (from the next session when a tool changed the policy file in this session).');
    expect(out.reason).not.toContain('Write tests that run the code');
    const log = readGateLog(g.sid).filter((e) => e.gate === 'defer-review');
    expect(log.map((e) => `${e.decision}:${e.reason}`)).toEqual(['deny:defer-review: src/**']);
  });

  test('an Edit that adds a defer-test glob to an entry is denied', async () => {
    const g = guard(ENTRY('- defer-test: lib/a.ts'));
    const out = await g.edit('- defer-test: lib/a.ts', '- defer-test: lib/a.ts, lib/b.ts');
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('Only the user defers tests to the next push (N8b)');
    expect(out.reason).toContain('this edit adds defer-test: lib/b.ts');
    expect(out.reason).toContain('it counts from their next message');
  });

  test('both deferral keys in one edit: both reasons, the deferral wording', async () => {
    const g = guard(null);
    const out = await g.write(ENTRY('- defer-review: a/**\n- defer-test: b/**'));
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('Only the user defers a review to the next push (N8b); Only the user defers tests to the next push (N8b)');
    expect(out.reason).toContain('defer-review: a/**; defer-test: b/**');
    expect(out.reason).toContain('it counts from their next message');
  });

  test('the old keys keep the old message', async () => {
    const g = guard(null);
    const out = await g.write(ENTRY('- static-preview: docs/**'), { GOODBOY_DIFF_COVERAGE: 'on' });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('Only the user declares static previews, which need no test');
    expect(out.reason).toContain('Write tests that run the code, or ask the user: they add the line themselves, and it counts from the next session.');
    expect(out.reason).not.toContain('their next message');
  });

  test('an old key beside a deferral key: the old wording (the edit is not a deferral only)', async () => {
    const g = guard(null);
    const out = await g.write(ENTRY('- static-preview: docs/**\n- defer-test: lib/**'), { GOODBOY_DIFF_COVERAGE: 'on' });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('Only the user declares static previews, which need no test; Only the user defers tests to the next push (N8b)');
    expect(out.reason).toContain('and it counts from the next session.');
    expect(out.reason).not.toContain('their next message');
  });

  test('a Write through a link to the policy file (or to its dir) is the policy file: denied when it adds a deferral glob', async () => {
    const g = guard(ENTRY('- defer-test: lib/a.ts'));
    g.link('notes.md');
    const out = await g.writeOther('notes.md', ENTRY('- defer-test: lib/a.ts, lib/b.ts'));
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('Only the user defers tests to the next push (N8b)');
    expect(out.reason).toContain('this edit adds defer-test: lib/b.ts');
    const via = guard(ENTRY('- defer-review: a/**'));
    via.link('gd', true);
    const dirOut = await via.writeOther('gd/policy.md', ENTRY('- defer-review: a/**, b/**'));
    expect(dirOut.denied).toBe(true);
    expect(dirOut.reason).toContain('this edit adds defer-review: b/**');
    // A link to the policy file that adds nothing is not touched, and a link to another file is none of it.
    const quiet = guard(ENTRY('- defer-test: lib/a.ts'));
    quiet.link('notes.md');
    expect((await quiet.writeOther('notes.md', ENTRY('- defer-test: lib/a.ts\n- note: x'))).denied).toBe(false);
  });

  test('a deferral glob the file already has, an `ai` entry and another file are not touched', async () => {
    const g = guard(ENTRY('- defer-review: src/**'));
    const touched = await g.edit('- source: user 2026-11-26', '- source: user 2026-11-27');
    expect([touched.denied, touched.reason]).toEqual([false, '']);
    expect((await g.write('## P2 Model note\n- decide: ai\n- source: model\n- defer-review: src/**\n- defer-test: src/**\n')).denied).toBe(false);
    expect((await g.writeOther('notes.md', ENTRY('- defer-test: x/**'))).denied).toBe(false);
  });
});
