// G2 layer-1 end to end (track G §10.3–10.8): the hooks and the CLI run as processes in
// temporary repos. Covers the skill effort notice in PostToolUse, the Stop gate messages that
// name the routed agents, a pre-G2 result writer (goodboy:test-changes) recording through the
// CLI under the PreToolUse result guard, and changed-line coverage from a real
// `bun test --coverage` lcov report carried into test-write.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const QUIET = { GOODBOY_OUTWARD_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `goodboy-g2e-${prefix}-`)));
  dirs.push(d);
  return d;
}

function sh(cwd: string, command: string): string {
  const p = Bun.spawnSync(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${command}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function gitRepo(): string {
  const cwd = tmp('repo');
  sh(cwd, 'git init -q -b main && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false');
  return cwd;
}

interface HookOut {
  json: Record<string, any>;
  stderr: string;
  code: number | null;
}

async function runHook(script: string, cwd: string, base: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<HookOut> {
  const proc = Bun.spawn(['bun', script], {
    cwd,
    env: { ...process.env, TMPDIR: base, HOME: base, ...env },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { json: JSON.parse(out || '{}'), stderr, code: proc.exitCode };
}

const decision = (r: HookOut): string => r.json.hookSpecificOutput?.permissionDecision ?? 'allow';
const reason = (r: HookOut): string => r.json.hookSpecificOutput?.permissionDecisionReason ?? '';

describe('PostToolUse: skill effort notice', () => {
  const post = (cwd: string, base: string, skill: string, level: string | undefined, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    runHook(POST, cwd, base, { session_id: `e2e-${Math.random().toString(36).slice(2)}`, cwd, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill }, tool_response: 'ok', ...(level ? { effort: { level } } : {}), ...extra }, env);

  test('names the skill and its effort only when it differs from the session, in the main session', async () => {
    const base = tmp('base');
    const cwd = tmp('cwd');
    const differs = await post(cwd, base, 'goodboy:write-migration', 'medium');
    expect(differs.json.systemMessage).toContain('write-migration');
    expect(differs.json.systemMessage).toContain('xhigh');
    expect((await post(cwd, base, 'goodboy:write-migration', 'xhigh')).json.systemMessage).toBeUndefined();
    expect((await post(cwd, base, 'goodboy:write-migration', 'medium', {}, { GOODBOY_SKILL_EFFORT: 'off' })).json.systemMessage).toBeUndefined();
    // fix-bug sets no effort of its own; a subagent and another plugin's skill get no notice.
    expect((await post(cwd, base, 'goodboy:fix-bug', 'medium')).json.systemMessage).toBeUndefined();
    expect((await post(cwd, base, 'goodboy:write-migration', 'medium', { agent_type: 'goodboy:test-unit', agent_id: 'a1' })).json.systemMessage).toBeUndefined();
    expect((await post(cwd, base, 'other:write-migration', 'medium')).json.systemMessage).toBeUndefined();
  });
});

describe('legacy result writer, hook level', () => {
  function setup() {
    const base = tmp('base');
    const cwd = gitRepo();
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'tests'));
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(cwd, 'tests', 'a.test.ts'), 'import { test, expect } from "bun:test";\ntest("a", () => { expect(1).toBe(1); });\n');
    sh(cwd, 'git add -A && git commit -q -m init');
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const input = {
      tested_files: [join(cwd, 'src', 'a.ts')],
      category: 'add-feature',
      test_files: [join(cwd, 'tests', 'a.test.ts')],
      environment: { mode: 'none' },
      suites: [{ name: 'unit', type: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', duration_ms: 12 }],
      acceptance: [{ id: 'AC-1', description: 'b exported', test: 'tests/a.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } }],
      verdict: 'pass',
    };
    const inputPath = join(base, 'input.json');
    writeFileSync(inputPath, JSON.stringify(input));
    return { base, cwd, inputPath };
  }

  const pre = (cwd: string, base: string, agent: string | undefined, command: string, env: Record<string, string> = QUIET) =>
    runHook(PRE, cwd, base, { session_id: `e2e-${Math.random().toString(36).slice(2)}`, cwd, ...(agent ? { agent_type: agent, agent_id: 'a1' } : {}), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, env);

  test('goodboy:test-changes and goodboy:review-changes still record their own kind, and only that', async () => {
    const { base, cwd, inputPath } = setup();
    const testCmd = `bun "${CLI}" test-write < "${inputPath}"`;
    const reviewCmd = `bun "${CLI}" review-write < "${inputPath}"`;
    expect(decision(await pre(cwd, base, 'goodboy:test-changes', testCmd))).toBe('allow');
    expect(decision(await pre(cwd, base, 'goodboy:test-changes', testCmd, {}))).toBe('allow'); // default gates
    expect(decision(await pre(cwd, base, 'goodboy:review-changes', reviewCmd))).toBe('allow');
    expect(decision(await pre(cwd, base, 'goodboy:test-unit', testCmd))).toBe('allow');
    // The wrong kind, the main session and another plugin's agent are denied, and the message routes to the new names.
    const wrongKind = await pre(cwd, base, 'goodboy:test-changes', reviewCmd);
    expect(decision(wrongKind)).toBe('deny');
    expect(reason(wrongKind)).toContain('goodboy:review-all');
    const main = await pre(cwd, base, undefined, testCmd);
    expect(decision(main)).toBe('deny');
    expect(reason(main)).toContain('goodboy:test-unit');
    expect(decision(await pre(cwd, base, 'goodboy:review-all', testCmd))).toBe('deny');
    expect(decision(await pre(cwd, base, 'other:test-changes', testCmd))).toBe('deny');
  });

  test('the command the guard allowed records a result, and the Stop gates then move from tests to review', async () => {
    const { base, cwd, inputPath } = setup();
    const sessionId = `e2e-${Math.random().toString(36).slice(2)}`;
    const dir = join(base, `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'turn.txt'), '2');
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: join(cwd, 'src', 'a.ts'), turn: 3, timestamp: new Date().toISOString() }) + '\n');
    const stop = () => runHook(STOP, cwd, base, { session_id: sessionId, cwd, hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'on' });

    const noTests = await stop();
    expect(noTests.json.decision).toBe('block');
    expect(noTests.json.reason).toContain('No test result covers the changed code');
    expect(noTests.json.reason).toContain('goodboy:test-unit');
    expect(noTests.json.reason).not.toContain('test-changes');

    const cmd = `bun "${CLI}" test-write < "${inputPath}"`;
    expect(decision(await pre(cwd, base, 'goodboy:test-changes', cmd))).toBe('allow');
    const rec = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TMPDIR: base } });
    expect(rec.exitCode).toBe(0);
    const files = readdirSync(join(cwd, '.claude', 'tests')).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(join(cwd, '.claude', 'tests', files[0]!), 'utf8'));
    expect(written.by_type.unit).toEqual({ suites: 1, tests: 1, duration_ms: 12 });
    expect(written.tree).toMatch(/^[0-9a-f]{40}$/);

    const post = await runHook(POST, cwd, base, { session_id: sessionId, cwd, agent_type: 'goodboy:test-changes', agent_id: 'a1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: rec.stdout.toString(), stderr: '', interrupted: false } });
    expect(post.code).toBe(0);
    expect(post.stderr).not.toContain('fatal');

    const noReview = await stop();
    expect(noReview.json.decision).toBe('block');
    expect(noReview.json.reason).not.toContain('No test result covers');
    expect(noReview.json.reason).toContain('goodboy:review-all');
    expect(noReview.json.reason).not.toContain('review-changes');
  });
});

describe('changed-line coverage from a real report, into test-write', () => {
  test('bun lcov: executed, unexecuted and never-run changed lines; the warning names the idle file', () => {
    const cwd = gitRepo();
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'tests'));
    writeFileSync(join(cwd, 'src', 'calc.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n');
    writeFileSync(join(cwd, 'tests', 'calc.test.ts'), 'import { test, expect } from "bun:test";\nimport { add } from "../src/calc";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n');
    sh(cwd, 'git add -A && git commit -q -m init');
    // Working-tree change: mul is called by the test, neverCalled is not; dead.ts is loaded but nothing in it runs.
    writeFileSync(join(cwd, 'src', 'calc.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n\nexport function neverCalled(x: number): number {\n  const y = x * 2;\n  return y + 1;\n}\n');
    writeFileSync(join(cwd, 'src', 'dead.ts'), 'export function dead(x: number): number {\n  const y = x + 1;\n  return y * 2;\n}\n');
    writeFileSync(join(cwd, 'tests', 'calc.test.ts'), 'import { test, expect } from "bun:test";\nimport { add, mul } from "../src/calc";\nimport { dead } from "../src/dead";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\ntest("mul", () => { expect(mul(2, 3)).toBe(6); });\ntest("dead is exported", () => { expect(typeof dead).toBe("function"); });\n');

    const ran = Bun.spawnSync(['bun', 'test', '--coverage', '--coverage-reporter=lcov', '--coverage-dir=cov'], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '' } });
    expect(ran.exitCode).toBe(0);

    const dc = Bun.spawnSync(['bun', CLI, 'diff-coverage', 'cov/lcov.info'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(dc.exitCode).toBe(0);
    const cov = JSON.parse(dc.stdout.toString());
    // calc.ts: mul's two lines ran, neverCalled's two did not. dead.ts: both lines idle.
    expect(cov.files['src/calc.ts']).toEqual({ covered: 2, total: 4 });
    expect(cov.files['src/dead.ts']).toEqual({ covered: 0, total: 2 });
    expect(cov.covered).toBe(2);
    expect(cov.total).toBe(6);
    expect(cov.files_without_executed_changes).toEqual([join(cwd, 'src', 'dead.ts')]);

    // The failure modes of the command itself.
    writeFileSync(join(cwd, 'garbage.txt'), 'not a coverage report\n');
    const bad = Bun.spawnSync(['bun', CLI, 'diff-coverage', 'garbage.txt'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain('not lcov, Cobertura XML, JaCoCo XML or a Go coverage profile');
    const missing = Bun.spawnSync(['bun', CLI, 'diff-coverage', 'nope.info'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain('no coverage report at');
    expect(Bun.spawnSync(['bun', CLI, 'diff-coverage'], { cwd, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(1);

    // test-write: suites without type/duration_ms are rejected; with them, by_type and the idle-file warning appear.
    const input = {
      tested_files: [join(cwd, 'src', 'calc.ts'), join(cwd, 'src', 'dead.ts')],
      category: 'add-feature',
      test_files: [join(cwd, 'tests', 'calc.test.ts')],
      environment: { mode: 'none' },
      suites: [{ name: 'unit', command: 'bun test', passed: 3, failed: 0, output: '3 pass' }],
      coverage: { status: 'measured', tool: 'bun test --coverage', changed: cov },
      acceptance: [{ id: 'AC-1', description: 'mul multiplies', test: 'tests/calc.test.ts > mul', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '3 pass', exit_code: 0 } }],
      verdict: 'pass',
    };
    const write = (body: unknown) => Bun.spawnSync(['bun', CLI, 'test-write'], { cwd, stdin: new TextEncoder().encode(JSON.stringify(body)), stdout: 'pipe', stderr: 'pipe' });
    const old = write(input);
    expect(old.exitCode).toBe(1);
    expect(old.stderr.toString()).toContain('suites[0].type must be one of unit|integration|ui|e2e');
    expect(old.stderr.toString()).toContain('suites[0].duration_ms');

    const ok = write({ ...input, suites: [{ name: 'unit', type: 'unit', command: 'bun test', passed: 3, failed: 0, output: '3 pass', duration_ms: 10 }, { name: 'e2e', type: 'e2e', command: 'bunx playwright test', passed: 1, failed: 0, output: '1 passed', duration_ms: 1200 }] });
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr.toString()).toContain(`no changed line of these tested files ran in the tests: ${join(cwd, 'src', 'dead.ts')}`);
    expect(ok.stderr.toString()).not.toContain(join(cwd, 'src', 'calc.ts'));
    const saved = JSON.parse(readFileSync(JSON.parse(ok.stdout.toString()).path, 'utf8'));
    expect(saved.by_type).toEqual({ unit: { suites: 1, tests: 3, duration_ms: 10 }, e2e: { suites: 1, tests: 1, duration_ms: 1200 } });
    expect(saved.coverage.changed.covered).toBe(2);
  });

  test('bun lcov: a name with a space, a name with é, diff.mnemonicPrefix on, and a base that does not exist', () => {
    const cwd = gitRepo();
    sh(cwd, 'git config diff.mnemonicPrefix true');
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'tests'));
    writeFileSync(join(cwd, 'src', 'my file.ts'), 'export function a(x: number): number {\n  return x + 1;\n}\n');
    writeFileSync(join(cwd, 'src', 'café.ts'), 'export function e(x: number): number {\n  return x + 2;\n}\n');
    writeFileSync(join(cwd, 'tests', 'a.test.ts'), 'import { test, expect } from "bun:test";\ntest("t", () => { expect(1).toBe(1); });\n');
    sh(cwd, 'git add -A && git commit -q -m init');
    writeFileSync(join(cwd, 'src', 'my file.ts'), 'export function a(x: number): number {\n  return x + 1;\n}\n\nexport function a2(x: number): number {\n  const y = x * 3;\n  return y;\n}\n');
    writeFileSync(join(cwd, 'src', 'café.ts'), 'export function e(x: number): number {\n  return x + 2;\n}\n\nexport function e2(x: number): number {\n  const y = x * 4;\n  return y;\n}\n');
    writeFileSync(join(cwd, 'tests', 'a.test.ts'), 'import { test, expect } from "bun:test";\nimport { a2 } from "../src/my file";\nimport { e2 } from "../src/café";\ntest("t", () => { expect(a2(2)).toBe(6); expect(e2(2)).toBe(8); });\n');

    const ran = Bun.spawnSync(['bun', 'test', '--coverage', '--coverage-reporter=lcov', '--coverage-dir=cov'], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CI: '' } });
    expect(ran.exitCode).toBe(0);
    const dc = Bun.spawnSync(['bun', CLI, 'diff-coverage', 'cov/lcov.info'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(dc.exitCode).toBe(0);
    const cov = JSON.parse(dc.stdout.toString());
    expect(cov.files['src/my file.ts']).toEqual({ covered: 3, total: 3 });
    expect(cov.files['src/café.ts']).toEqual({ covered: 3, total: 3 });
    expect(cov.files_without_executed_changes).toEqual([]);

    const badBase = Bun.spawnSync(['bun', CLI, 'diff-coverage', 'cov/lcov.info', '--base', 'no-such-rev'], { cwd, stdout: 'pipe', stderr: 'pipe' });
    expect(badBase.exitCode).not.toBe(0);
    expect(badBase.stderr.toString()).toContain('git diff against no-such-rev failed');
  });
});

describe('role limits of the test agents, through the PreToolUse hook', () => {
  const write = (cwd: string, base: string, agent: string, tool: string, rel: string) =>
    runHook(PRE, cwd, base, { session_id: `e2e-${Math.random().toString(36).slice(2)}`, cwd, agent_type: agent, agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: join(cwd, rel), content: 'x', old_string: 'a', new_string: 'b' } });
  const skill = (cwd: string, base: string, agent: string, name: string) =>
    runHook(PRE, cwd, base, { session_id: `e2e-${Math.random().toString(36).slice(2)}`, cwd, agent_type: agent, agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: name } });

  test('test-security and test-ui write under tests/ and not src/; test-security may use write-regression-test', async () => {
    const base = tmp('base');
    const cwd = gitRepo();
    for (const agent of ['goodboy:test-security', 'goodboy:test-ui']) {
      expect(decision(await write(cwd, base, agent, 'Write', 'tests/x.test.ts'))).toBe('allow');
      expect(decision(await write(cwd, base, agent, 'Edit', 'tests/x.test.ts'))).toBe('allow');
      const denied = await write(cwd, base, agent, 'Write', 'src/app.ts');
      expect(decision(denied)).toBe('deny');
      expect(reason(denied)).toContain('writes test files only');
      expect(decision(await write(cwd, base, agent, 'Edit', 'src/app.ts'))).toBe('deny');
    }
    expect(decision(await skill(cwd, base, 'goodboy:test-security', 'goodboy:write-regression-test'))).toBe('allow');
    expect(decision(await skill(cwd, base, 'goodboy:test-security', 'goodboy:attack-sandbox'))).toBe('allow');
    expect(decision(await skill(cwd, base, 'goodboy:test-security', 'goodboy:summarize-diff'))).toBe('deny');
    expect(decision(await skill(cwd, base, 'goodboy:research-lead', 'goodboy:summarize-diff'))).toBe('deny');
  }, 30_000);
});
