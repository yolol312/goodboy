// Track M, M4 (§19): the backfill workflow with a sandbox. A project with
// `.goodboy/sandbox/compose.yml` counts a record as evidence only when it carries the sandbox
// check; test-write accepts and validates that object; the run-sandbox skill is registered for
// the three test agents. Repos are temporary.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateTestResultInput } from '../lib/cli';
import { ROLES } from '../lib/routing-policy';
import { backfillSummary, emptyBackfill, evidenceProblem, markTarget } from '../lib/test-backfill';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function project(sandbox: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m4-')));
  tmpDirs.push(root);
  const files: Record<string, string> = { 'src/a.ts': 'x', 'src/a.test.ts': 't' };
  if (sandbox) files['.goodboy/sandbox/compose.yml'] = 'services: {}\n';
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** A passing record for src/a.ts as the L tests build it, plus the sandbox object when given. */
function record(root: string, sandbox?: unknown): TestResult {
  return {
    timestamp: new Date(Date.now() + 120_000).toISOString(),
    tested_files: [join(root, 'src/a.ts')],
    category: 'backfill-tests',
    test_files: [join(root, 'src/a.test.ts')],
    environment: { mode: 'container' },
    suites: [{ name: 'unit', command: 'bun test src/a.test.ts', passed: 3, failed: 0, output: '3 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [
      {
        id: 'BF-1',
        description: 'pins the current behavior',
        test: 'src/a.test.ts',
        red: { command: 'bun test (target broken in a scratch copy)', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test', output: '3 pass', exit_code: 0 },
        mutation: { command: 'sed (scratch copy)', output: '1 fail', detected: true, file: 'src/a.ts' },
      },
    ],
    verdict: 'pass',
    ...(sandbox !== undefined ? { sandbox } : {}),
  } as TestResult;
}

/** The documented line a tester runs: the sandbox-run of the project's own test command. */
const SANDBOX_CMD = 'bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts';

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

let runSeq = 0;

interface RunOver {
  check?: Partial<Record<'inner_only' | 'egress_blocked' | 'hosts_to_dummies', boolean>>;
  exit?: number | null;
  command?: string[];
  suite?: string;
  /** The directory name; the `ts` inside the result is `ts` (default: the same). */
  run?: string;
  ts?: string;
}

/** A sandbox-run result on disk under the repo, and the sandbox object test-write would record for it. */
function sandboxRun(root: string, over: RunOver = {}): { run: string; sandbox: NonNullable<TestResult['sandbox']>; file: string } {
  // each run of a test gets its own second, from now on: after the files the project() made, before the record (+120 s)
  const run = over.run ?? stamp(new Date(Date.now() + ++runSeq * 1000));
  const dirAbs = join(root, '.goodboy', 'sandbox', 'out', run);
  mkdirSync(dirAbs, { recursive: true });
  const check = { inner_only: true, egress_blocked: true, hosts_to_dummies: true, problems: [], ...over.check };
  const text = JSON.stringify({ ts: over.ts ?? run, suite: over.suite ?? 'unit', check, command: over.command ?? ['bun', 'test', 'src/a.test.ts'], exit: over.exit === undefined ? 0 : over.exit, tail: '' }, null, 2) + '\n';
  const file = join(dirAbs, 'result.json');
  writeFileSync(file, text);
  const sha256 = createHash('sha256').update(text).digest('hex');
  return { run, file, sandbox: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, run, result_sha256: sha256 } };
}

/** A record with a sandbox proof for a fresh run of the repo; its suite went through sandbox-run. */
function sandboxed(root: string, over: RunOver = {}): TestResult {
  const r = record(root, sandboxRun(root, over).sandbox);
  return { ...r, suites: [{ ...r.suites[0]!, command: SANDBOX_CMD }] };
}

describe('M4: backfill evidence with a sandbox', () => {
  test('without a sandbox the evidence is unchanged: no sandbox object needed', () => {
    const root = project(false);
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [record(root)])).toBeNull();
    // An object that says the run was outside the sandbox does not matter here.
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [record(root, { inner_only: false, egress_blocked: false })])).toBeNull();
  });

  test('with a sandbox a record without the check, or with a false flag, is refused', () => {
    const root = project(true);
    const refused = (r: TestResult) => String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [r]));
    expect(refused(record(root))).toContain('the project has a sandbox');
    expect(refused(record(root))).toContain('sandbox: {run: "<ts>"}');
    expect(refused(record(root, { inner_only: false, egress_blocked: true }))).toContain('the project has a sandbox');
    expect(refused(record(root, { inner_only: true, egress_blocked: false }))).toContain('the project has a sandbox');
    // Only a strict true counts: a truthy string is no proof.
    expect(refused(record(root, { inner_only: 'true', egress_blocked: true }))).toContain('the project has a sandbox');
    expect(refused(record(root, { inner_only: true }))).toContain('the project has a sandbox');
    // All three flags are needed.
    expect(refused(record(root, { inner_only: true, egress_blocked: true }))).toContain('the project has a sandbox');
    const run = sandboxRun(root);
    expect(refused(record(root, { ...run.sandbox, hosts_to_dummies: false }))).toContain('hosts_to_dummies');
  });

  test('flags alone prove nothing: a record needs a run on disk with the recorded hash', () => {
    const root = project(true);
    const refused = (r: TestResult) => String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [r]));
    const flagsOnly = { inner_only: true, egress_blocked: true, hosts_to_dummies: true };
    expect(refused(record(root, flagsOnly))).toContain('names no run or result hash');
    expect(refused(record(root, { ...flagsOnly, run: '20261022T100000Z' }))).toContain('names no run or result hash');
    // a run no sandbox-run wrote
    expect(refused(record(root, { ...flagsOnly, run: '20261022T100000Z', result_sha256: 'a'.repeat(64) }))).toContain('does not exist');
    expect(refused(record(root, { ...flagsOnly, run: '../../x', result_sha256: 'a'.repeat(64) }))).toContain('directory name');
  });

  test('a result.json changed after the record, or of a run that failed, does not count', () => {
    const root = project(true);
    const refused = (r: TestResult) => String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [r]));
    const good = sandboxRun(root);
    const rec = { ...record(root, good.sandbox), suites: [{ ...record(root).suites[0]!, command: SANDBOX_CMD }] } as TestResult;
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [rec])).toBeNull();
    writeFileSync(good.file, readFileSync(good.file, 'utf8').replace('"exit": 0', '"exit": 0 '));
    expect(refused(rec)).toContain('changed after the record');
    // the run's own check or exit
    expect(refused(sandboxed(root, { check: { egress_blocked: false } }))).toContain('did not pass its sandbox check');
    expect(refused(sandboxed(root, { check: { hosts_to_dummies: false } }))).toContain('did not pass its sandbox check');
    expect(refused(sandboxed(root, { exit: 1 }))).toContain('did not exit 0');
    expect(refused(sandboxed(root, { exit: null }))).toContain('did not exit 0');
    // a result whose ts is not its directory
    expect(refused(sandboxed(root, { ts: '20250101T000000Z' }))).toContain('is not a result goodboy');
  });

  test('a run made after the record, and a result.json that is a link, do not count', () => {
    const root = project(true);
    const refused = (r: TestResult) => String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [r]));
    const later = sandboxed(root, { run: stamp(new Date(Date.now() + 3_600_000)) });
    expect(refused(later)).toContain('is later than the record');
    const linked = sandboxRun(root, { run: stamp(new Date(Date.now() - 120_000)) });
    const real = join(root, 'real-result.json');
    writeFileSync(real, readFileSync(linked.file, 'utf8'));
    rmSync(linked.file);
    symlinkSync(real, linked.file);
    const rec = record(root, linked.sandbox);
    expect(refused({ ...rec, suites: [{ ...rec.suites[0]!, command: SANDBOX_CMD }] })).toContain('not a regular file');
  });

  test('a counted suite must be the sandbox-run line of that run, word for word; a host command never counts', () => {
    const root = project(true);
    const run = sandboxRun(root, { command: ['bun', 'test', 'src/a.test.ts'] });
    const withCommand = (command: string) => ({ ...record(root, run.sandbox), suites: [{ ...record(root).suites[0]!, command }] }) as TestResult;
    const refused = (r: TestResult) => String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [r]));
    const ran = 'with a passing suite that ran it';
    expect(refused(withCommand('bun test src/ --bail'))).toContain(ran);
    expect(refused(withCommand('npx vitest run src/a.test.ts'))).toContain(ran);
    // the same command on the host, a mention of sandbox-run, another command after --
    expect(refused(withCommand('bun test src/a.test.ts'))).toContain(ran);
    expect(refused(withCommand('bun test src/a.test.ts --some-host-flag'))).toContain(ran);
    expect(refused(withCommand('echo sandbox-run; bun test src/a.test.ts'))).toContain(ran);
    expect(refused(withCommand('echo sandbox-run -- bun test src/a.test.ts'))).toContain(ran);
    expect(refused(withCommand('bun cli.ts sandbox-run --suite unit -- bun test src/a.test.ts --bail'))).toContain(ran);
    // a line for another suite than the run's
    expect(refused(withCommand('bun cli.ts sandbox-run --suite e2e'))).toContain(ran);
    expect(refused(withCommand('bun cli.ts sandbox-run --suite all -- bun test src/a.test.ts'))).toContain(ran);
    // the line must BE the invocation: nothing before it, no separator, no comment, no substitution
    for (const c of [
      'bun test src/a.test.ts # cli.ts sandbox-run -- bun test src/a.test.ts',
      'echo cli.ts sandbox-run -- bun test src/a.test.ts; bun test src/a.test.ts',
      'echo cli.ts sandbox-run -- bun test src/a.test.ts && bun test src/a.test.ts',
      'cd . && bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts',
      'bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts | tail -3',
      'bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts || true',
      'bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts `echo`',
      'bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts $(echo)',
      'bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts\nbun test src/a.test.ts',
      'GB=/tmp bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts',
      'echo bun /p/lib/cli.ts sandbox-run -- bun test src/a.test.ts',
      // a separator before the `--`: the run was another one, the `--` part only follows it
      'bun /p/lib/cli.ts sandbox-run --suite unit && echo -- bun test src/a.test.ts',
      'bun /p/lib/cli.ts sandbox-run --suite unit ; echo -- bun test src/a.test.ts',
      'bun /p/lib/cli.ts sandbox-run --suite unit # -- bun test src/a.test.ts',
      'bun /p/lib/cli.ts sandbox-run --suite unit | cat -- bun test src/a.test.ts',
    ]) expect([c, refused(withCommand(c)).includes(ran)]).toEqual([c, true]);
    // the documented line, with flags, or run as an executable
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [withCommand(SANDBOX_CMD)])).toBeNull();
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [withCommand('bun --bun /p/lib/cli.ts sandbox-run --suite unit --timeout-ms 600000 -- bun test src/a.test.ts')])).toBeNull();
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [withCommand('/p/lib/cli.ts sandbox-run --suite unit -- bun test src/a.test.ts')])).toBeNull();
  });

  test('a run older than the last change of the test or the target does not count', () => {
    const root = project(true);
    const refused = (r: TestResult) => String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [r]));
    // the files were written now; a run from an hour ago says nothing about them
    expect(refused(sandboxed(root, { run: stamp(new Date(Date.now() - 3_600_000)) }))).toContain('made after src/a.test.ts last changed');
    // a run after the test was written but before the target was edited
    const root2 = project(true);
    const run = sandboxRun(root2, { run: stamp(new Date(Date.now() + 1000)) });
    Bun.sleepSync(2200);
    writeFileSync(join(root2, 'src/a.ts'), 'changed');
    const rec = { ...record(root2, run.sandbox), suites: [{ ...record(root2).suites[0]!, command: SANDBOX_CMD }] } as TestResult;
    expect(String(evidenceProblem(root2, root2, 'src/a.ts', ['src/a.test.ts'], [rec]))).toContain('made after src/a.test.ts last changed');
    const later = sandboxed(root2, { run: stamp(new Date(Date.now() + 1000)) });
    expect(evidenceProblem(root2, root2, 'src/a.ts', ['src/a.test.ts'], [later])).toBeNull();
  });

  test('the line with no `--` is the run of its own commands: the project\'s test command counts', () => {
    const root = project(true);
    const run = sandboxRun(root, { command: ['bun', 'test', 'src/a.test.ts'], suite: 'unit' });
    const rec = (command: string) => ({ ...record(root, run.sandbox), suites: [{ ...record(root).suites[0]!, command }] }) as TestResult;
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [rec('bun "$GB/lib/cli.ts" sandbox-run --suite unit')])).toBeNull();
    // no --suite means all: not the run's suite
    expect(String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [rec('bun "$GB/lib/cli.ts" sandbox-run')]))).toContain('ran it');
  });

  test('quoted separators are text (Maven -Dtest=Foo#bar); the same unquoted are refused', () => {
    const root = project(true);
    const run = sandboxRun(root, { command: ['bun', 'test', 'src/a.test.ts', '--define', 'X#Y&Z;W|V'] });
    const rec = (command: string) => ({ ...record(root, run.sandbox), suites: [{ ...record(root).suites[0]!, command }] }) as TestResult;
    const check = (command: string) => evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [rec(command)]);
    expect(check(`bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts --define 'X#Y&Z;W|V'`)).toBeNull();
    expect(check(`bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts --define "X#Y&Z;W|V"`)).toBeNull();
    expect(String(check(`bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts --define X#Y&Z;W|V`))).toContain('with a passing suite that ran it');
    // substitutions stay refused inside double quotes, and an unclosed quote
    expect(String(check('bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts --define "X$(id)"'))).toContain('ran it');
    expect(String(check('bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts --define "X`id`"'))).toContain('ran it');
    expect(String(check('bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts --define \'X#Y'))).toContain('ran it');
  });

  test('an e2e run is recorded with the documented line, no `--`; a refusal names the line it expects', () => {
    const root = project(true);
    mkdirSync(join(root, 'e2e'), { recursive: true });
    writeFileSync(join(root, 'e2e', 'login.spec.ts'), 'x');
    const E2E = 'bun "$GB/lib/cli.ts" sandbox-run --suite e2e';
    const mk = (run: { sandbox: NonNullable<TestResult['sandbox']> }, command: string, file = 'e2e/login.spec.ts') =>
      ({ ...record(root, run.sandbox), test_files: [join(root, file)], suites: [{ ...record(root).suites[0]!, type: 'e2e', command }] }) as TestResult;
    const ev = (r: TestResult, file = 'e2e/login.spec.ts') => evidenceProblem(root, root, 'src/a.ts', [file], [r]);
    const e2eRun = sandboxRun(root, { suite: 'e2e', command: ['playwright', 'test'] });
    expect(ev(mk(e2eRun, E2E))).toBeNull();
    // `-- playwright test` would replace the e2e service's command: not the run's line
    expect(String(ev(mk(e2eRun, `${E2E} -- playwright test`)))).toContain(`counted suite is exactly this one line, with no other shell syntax: ${E2E} (the run must have started after`);
    // a unit line or the unit suite flag does not stand for an e2e run, nor an e2e run for a unit test
    expect(String(ev(mk(e2eRun, 'bun "$GB/lib/cli.ts" sandbox-run --suite unit')))).toContain('ran it');
    expect(String(ev(mk(e2eRun, E2E, 'src/a.test.ts'), 'src/a.test.ts'))).toContain('ran it');
    // a run of both: the unit command after `--` counts for unit tests, and its e2e part for the e2e dir
    const all = sandboxRun(root, { suite: 'all', command: ['bun', 'test', 'src/a.test.ts'] });
    const ALL = 'bun "$GB/lib/cli.ts" sandbox-run --suite all -- bun test src/a.test.ts';
    expect(ev(mk(all, ALL, 'e2e/login.spec.ts'))).toBeNull();
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [mk(all, ALL, 'src/a.test.ts')])).toBeNull();
    // the refusal for a unit run names its line with the run's command
    const unit = sandboxRun(root, { command: ['bun', 'test', 'src/a.test.ts'] });
    expect(String(ev(mk(unit, 'bun test src/a.test.ts'), 'src/a.test.ts'))).toContain('exactly this one line, with no other shell syntax: bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts (');
  });

  test('with a sandbox a record with a proof is accepted', () => {
    const root = project(true);
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [sandboxed(root)])).toBeNull();
  });

  test('a record without the flags does not count beside one that has them; the other checks stay', () => {
    const root = project(true);
    const plain = record(root);
    // The sandboxed record has no mutation: the unsandboxed one cannot make up for it.
    const noMutation = { ...sandboxed(root), acceptance: [{ ...record(root).acceptance[0]!, mutation: undefined }] } as TestResult;
    expect(String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [plain, noMutation]))).toContain('whose mutation of src/a.ts');
    const withMutation = { ...sandboxed(root), acceptance: record(root).acceptance };
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [plain, withMutation])).toBeNull();
    // A passing record that names another target says nothing about the sandbox of this one.
    expect(String(evidenceProblem(root, root, 'src/b.ts', ['src/a.test.ts'], [sandboxed(root)]))).toContain('names src/b.ts');
  });

  test('backfill-mark refuses done and suspect without the check, then accepts with it', () => {
    const root = project(true);
    const s = emptyBackfill();
    s.targets = [{ rel: 'src/a.ts', kind: 'code', needs: ['any'], why: 'w', bytes: 1, status: 'todo' }];
    const m = (status: 'done' | 'suspect', r: TestResult) => markTarget(s, root, root, { rel: 'src/a.ts', status, tests: ['src/a.test.ts'], note: 'looks wrong' }, undefined, [r]);
    expect(String(m('done', record(root)))).toContain('the project has a sandbox');
    expect(String(m('suspect', record(root, { inner_only: false, egress_blocked: false })))).toContain('run the suites with sandbox-run');
    expect(s.targets[0]!.status).toBe('todo');
    expect(m('suspect', sandboxed(root))).toBeNull();
    expect(m('done', sandboxed(root))).toBeNull();
    expect(s.targets[0]!.status).toBe('done');
  });

  test('skipped needs no record, sandbox or not', () => {
    const root = project(true);
    const s = emptyBackfill();
    s.targets = [{ rel: 'src/a.ts', kind: 'code', needs: ['any'], why: 'w', bytes: 1, status: 'todo' }];
    expect(markTarget(s, root, root, { rel: 'src/a.ts', status: 'skipped', tests: [], note: 'the user declined' }, undefined, [])).toBeNull();
  });

  test('the summary goal is complete with a sandbox, else batches', () => {
    const s = emptyBackfill();
    expect(backfillSummary(s, project(true)).goal).toBe('complete');
    expect(backfillSummary(s, project(false)).goal).toBe('batches');
    expect(backfillSummary(s).goal).toBe('batches');
  });

  test('CLI: backfill-status prints the goal from the repo, and a mark needs the check', () => {
    const root = project(true);
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    expect(JSON.parse(run('backfill-plan').out)).toMatchObject({ goal: 'complete' });
    expect(JSON.parse(run('backfill-status').out)).toMatchObject({ goal: 'complete' });
    mkdirSync(join(root, '.claude', 'tests'), { recursive: true });
    writeFileSync(join(root, '.claude', 'tests', '2026-10-22T00-00-00.json'), JSON.stringify(record(root)));
    const refused = run('backfill-mark', 'src/a.ts', '--status', 'done', '--tests', 'src/a.test.ts');
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('the project has a sandbox');
  });
});

describe('M4: test-write and the sandbox object', () => {
  const input = (sandbox?: unknown) => ({
    tested_files: ['/r/src/a.ts'],
    category: 'backfill-tests',
    test_files: [join(ROOT, 'lib', 'cli.ts')],
    environment: { mode: 'container' },
    suites: [{ name: 'unit', command: 'c', passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 5 }],
    acceptance: [],
    verdict: 'pass',
    ...(sandbox !== undefined ? { sandbox } : {}),
  });

  test('the agent passes {run}; the flags and the result hash are copied from that run\'s result.json', () => {
    const root = project(true);
    expect(validateTestResultInput(input(), undefined, root).value!.sandbox).toBeUndefined();
    const run = sandboxRun(root);
    const ok = validateTestResultInput(input({ run: run.run }), undefined, root);
    expect([ok.ok, ok.value!.sandbox]).toEqual([true, run.sandbox]);
    // the same flags may be passed along; extra fields are dropped
    const same = validateTestResultInput(input({ run: run.run, inner_only: true, egress_blocked: true, hosts_to_dummies: true, extra: 'dropped' }), undefined, root);
    expect([same.ok, same.value!.sandbox]).toEqual([true, run.sandbox]);
  });

  test('a run whose check failed is recorded as it was, never as passed', () => {
    const root = project(true);
    const run = sandboxRun(root, { check: { egress_blocked: false } });
    const r = validateTestResultInput(input({ run: run.run }), undefined, root);
    expect(r.ok).toBe(true);
    expect(r.value!.sandbox).toMatchObject({ inner_only: true, egress_blocked: false, run: run.run });
  });

  test('flags that differ from the run\'s result are rejected: a record can not claim a check no run made', () => {
    const root = project(true);
    const run = sandboxRun(root, { check: { egress_blocked: false } });
    const r = validateTestResultInput(input({ run: run.run, inner_only: true, egress_blocked: true }), undefined, root);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('sandbox.egress_blocked is true but the run');
  });

  test('a missing, malformed, linked or forged run is rejected with the reason', () => {
    const root = project(true);
    const errors = (v: unknown) => validateTestResultInput(input(v), undefined, root).errors.join('\n');
    expect(errors('yes')).toContain('sandbox must be {run');
    expect(errors(null)).toContain('sandbox must be {run');
    expect(errors([true, true])).toContain('sandbox must be {run');
    expect(errors({ inner_only: true, egress_blocked: true })).toContain('sandbox must be {run');
    expect(errors({ run: 5 })).toContain('sandbox must be {run');
    expect(errors({ run: ' ' })).toContain('directory name');
    expect(errors({ run: '../../etc' })).toContain('directory name');
    expect(errors({ run: '20261022T100000Z' })).toContain('does not exist');
    const real = sandboxRun(root);
    expect(validateTestResultInput(input({ run: real.run })).errors.join('\n')).toContain('repository root');
    // a result.json that is a link, and one that is not what sandbox-run writes
    const linked = sandboxRun(root, { run: '20260101T000000Z' });
    rmSync(linked.file);
    writeFileSync(join(root, 'x.json'), '{}');
    symlinkSync(join(root, 'x.json'), linked.file);
    expect(errors({ run: linked.run })).toContain('not a regular file');
    const forged = sandboxRun(root, { run: '20260102T000000Z' });
    writeFileSync(forged.file, JSON.stringify({ ts: forged.run, check: { inner_only: true, egress_blocked: true } }));
    expect(errors({ run: forged.run })).toContain('is not a result goodboy');
    // a linked run directory
    const target = join(root, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'result.json'), readFileSync(real.file, 'utf8'));
    symlinkSync(target, join(root, '.goodboy', 'sandbox', 'out', '20260103T000000Z'));
    expect(errors({ run: '20260103T000000Z' })).toContain('is a link');
  });

  test('CLI: test-write reads the run from the repo and writes the copied flags and the hash', () => {
    const root = project(true);
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
    const run = sandboxRun(root);
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const body = { ...input({ run: run.run }), tested_files: [join(root, 'src/a.ts')], test_files: [join(root, 'src/a.test.ts')] };
    const w = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'test-write'], { cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify(body)), stdout: 'pipe', stderr: 'pipe' });
    expect(w.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(JSON.parse(w.stdout.toString()).path, 'utf8')) as TestResult;
    expect(written.sandbox).toEqual(run.sandbox);
    const bad = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'test-write'], { cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify({ ...body, sandbox: { run: '20250101T000000Z' } })), stdout: 'pipe', stderr: 'pipe' });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.toString()).toContain('does not exist');
  });
});

describe('M4: the run-sandbox skill', () => {
  const skill = () => readFileSync(join(ROOT, 'skills', 'run-sandbox', 'SKILL.md'), 'utf8');

  test('the three test agents list it, and their files name it', () => {
    for (const name of ['test-unit', 'test-ui', 'test-spec']) {
      expect([name, ROLES.find((r) => r.name === name)!.toolSkills.includes('run-sandbox')]).toEqual([name, true]);
      expect([name, /\brun-sandbox\b/.test(readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8'))]).toEqual([name, true]);
    }
    for (const name of ['test-lead', 'test-security', 'test-probe', 'build-run']) {
      expect([name, ROLES.find((r) => r.name === name)!.toolSkills.includes('run-sandbox')]).toEqual([name, false]);
    }
  });

  test('it names the commands, the fixture, the record field and the never rules', () => {
    const t = skill();
    for (const need of ['sandbox-check', 'sandbox-run --suite unit|e2e|all', 'coverage-check', '--root-map /work=.', 'ui-check --run', 'ui-inventory', 'uiTest', '.goodboy/sandbox/e2e/goodboy-ui', '<id>:ok', '<id>:error', 'input: true', 'sandbox: {run', 'characterization']) {
      expect([need, t.includes(need)]).toEqual([need, true]);
    }
    expect(t).toContain('Never point a test, a config or a command at a real host');
    expect(t).toContain('Never put rows or personal data from the database copy');
    expect(t).toContain('Never keep the traces of a passing run');
  });

  test('it keeps two clauses a tightening dropped once: a record without a run does not count, and real data keeps raw artifacts in volumes only', () => {
    const flat = skill().replace(/\s+/g, ' ');
    expect(flat).toContain('A record without a run, or whose run failed its check, exited non-zero or changed afterwards, does not count for a backfill target');
    expect(flat).toContain('(real data keeps them in volumes only)');
    // the skill cap of tests/g2-agents-skills.test.ts, counted the way it counts
    expect(skill().split('\n').length).toBeLessThanOrEqual(90);
  });

  test('backfill-tests and setup-test-infra point to the sandbox', () => {
    const bf = readFileSync(join(ROOT, 'skills', 'backfill-tests', 'SKILL.md'), 'utf8');
    for (const need of ['sandbox-scan', 'sandbox-local --dump', 'sandbox-init', 'sandbox-prepare', 'sandbox-up', 'sandbox-check', 'run-sandbox', 'coverage-check', 'ui-check', 'ui-inventory', 'coverage-exempt:', 'keep-project-knowledge']) {
      expect([need, bf.includes(need)]).toEqual([need, true]);
    }
    expect(readFileSync(join(ROOT, 'skills', 'setup-test-infra', 'SKILL.md'), 'utf8')).toContain('run-sandbox');
  });
});
