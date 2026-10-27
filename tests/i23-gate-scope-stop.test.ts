// #23 through the real Stop hook (spawned, as tests/i1-changed-lines.test.ts does): the test gate
// judges this session's change only. An edit restored to the session-start blob is no change; a
// record made on the content a file has now is fresh; every failing rule is named in one block
// ("(1/N) … (2/N) …"); a todo that was already in an unchanged test file does not block, an
// added one does; a file a test runs as a process counts on the record's subprocess evidence.
// Repos and session dirs are temporary; the hook runs for real (integration).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';

const ROOT = resolve(import.meta.dir, '..');
const BASE = 'a'.repeat(40);
/** The commit the session started from. */
const headOf = (d: string) => sh(d, 'git rev-parse HEAD');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function sid(): string {
  const s = `i23${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const V1 = 'export const a = 1;\n';
const V2 = 'export const a = 1;\nexport const b = 2;\n';
const TEST = 'import { expect, test } from "bun:test";\nimport { a } from "../src/calc";\ntest("a", () => { expect(a).toBe(1); });\n';

/** A repo with the files committed, and the session pinned at that commit. */
function project(files: Record<string, string> = {}): { d: string; s: string } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i23s-')));
  dirs.push(d);
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  const all = { 'src/calc.ts': V1, 'tests/a.test.ts': TEST, ...files };
  for (const [p, t] of Object.entries(all)) write(d, p, t);
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  const s = sid();
  pinCoverageStart(s, d);
  return { d, s };
}
const edited = (s: string, file: string) => recordEdit(s, file, 0, undefined, Date.now());

function record(d: string, over: Record<string, unknown> = {}) {
  return {
    timestamp: new Date(Date.now() + 60_000).toISOString(),
    // As test-write stores it (v0.36.6, R4): the HEAD the record ran on. With no tree, a record is
    //   judged by time only while its checkout is HEAD or before it.
    commit: sh(d, 'git rev-parse HEAD'),
    tested_files: [join(d, 'src', 'calc.ts')],
    category: 'fix-bug',
    test_files: [join(d, 'tests', 'a.test.ts')],
    environment: { mode: 'none', command: 'none', evidence: 'library' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [
      {
        id: 'AC-1',
        description: 'b is exported',
        test: 'tests/a.test.ts',
        red: { command: 'bun test (before)', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test', output: '1 pass', exit_code: 0 },
      },
    ],
    verdict: 'pass',
    ...over,
  };
}
const cov = (file: string, covered: number, total: number, extra: Record<string, unknown> = {}, base = BASE) => ({
  status: 'measured',
  changed: { covered, total, files_without_executed_changes: [], files: { [file]: { covered, total } }, in_report: [file], diff_lines: { [file]: 1 }, base },
  ...extra,
});
function putRecord(d: string, ...recs: unknown[]) {
  const dir = join(d, '.claude', 'tests');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  recs.forEach((rec, i) => writeFileSync(join(dir, `r${i}.json`), JSON.stringify(rec)));
}
async function stop(d: string, s: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_TEST_GATE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off', ...env },
  });
  const out = (await new Response(p.stdout).text()) || '{}';
  await p.exited;
  return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
}
const NO_RESULT = /No test result covers the changed code/;

describe('net change: an edit restored to the start blob', () => {
  test('a changed file blocks until it is restored; then the gate has nothing to ask', async () => {
    const { d, s } = project();
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    edited(s, a);
    const blocked = await stop(d, s);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toMatch(NO_RESULT);
    writeFileSync(a, V1); // the start content again
    const restored = await stop(d, s);
    expect(restored.reason ?? '').not.toMatch(NO_RESULT);
    expect(restored.reason ?? '').not.toContain('테스트 게이트');
  }, 60_000);

  test('a new untracked file is still a change', async () => {
    const { d, s } = project();
    const n = write(d, 'src/new.ts', 'export const n = 1;\n');
    edited(s, n);
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(NO_RESULT);
    expect(out.reason).toContain('src/new.ts');
  }, 60_000);
});

describe('content freshness: a record made on the content the file has now', () => {
  /** The file is V2 in a commit the record's tree holds; the edit is newer than the record. */
  async function staleRecord(treeOf: (d: string) => string | undefined) {
    const { d, s } = project();
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    sh(d, "git commit -qam 'ABC-1 v2'");
    const tree = treeOf(d);
    putRecord(d, record(d, { timestamp: new Date(Date.now() - 30_000).toISOString(), ...(tree ? { tree } : {}) }));
    Bun.sleepSync(20);
    edited(s, a); // edit after the record, same content
    return stop(d, s);
  }

  test('without a tree the record is stale; with the tree of the same content it counts', async () => {
    const stale = await staleRecord(() => undefined);
    expect(stale.decision).toBe('block');
    expect(stale.reason).toContain('테스트 검증 실패');
    const fresh = await staleRecord((d) => sh(d, 'git rev-parse HEAD^{tree}'));
    expect(fresh.reason ?? '').not.toContain('테스트 검증 실패');
    expect(fresh.reason ?? '').not.toMatch(NO_RESULT);
  }, 120_000);

  test('a tree whose content differs keeps the record stale', async () => {
    const out = await staleRecord((d) => sh(d, 'git rev-parse HEAD~1^{tree}')); // the start tree: a.ts is V1
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('테스트 검증 실패');
  }, 60_000);
});

describe('all gaps at once', () => {
  const server = "import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n";
  const server2 = `${server}export const q = 2;\n`;
  async function twoGaps(env: Record<string, string>) {
    const { d, s } = project({ 'src/server.ts': server });
    const f = join(d, 'src', 'server.ts');
    writeFileSync(f, server2);
    edited(s, f);
    // A unit suite for a boundary file (a type gap) with one changed line that did not run.
    putRecord(d, record(d, { tested_files: [f], coverage: cov('src/server.ts', 1, 2, {}, headOf(d)) }));
    return stop(d, s, { GOODBOY_TEST_TYPES: 'on', GOODBOY_DIFF_COVERAGE: 'on', ...env });
  }

  test('two failing rules are numbered in one block reason', async () => {
    const out = await twoGaps({});
    expect(out.decision).toBe('block');
    const reason = out.reason ?? '';
    expect(reason).toContain('(1/2) Test types missing: src/server.ts needs an integration or e2e suite');
    expect(reason).toContain('(2/2) ');
    expect(reason).toMatch(/\(2\/2\) .*changed-line coverage/);
    expect(reason).not.toContain('(3/');
  }, 60_000);

  test('a record that tests none of the changed files is judged by the coverage rule alone', async () => {
    const { d, s } = project();
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    edited(s, a);
    // It lists another file and has a failing suite: the rules after the coverage one would
    // only judge an unrelated record.
    const suites = [{ name: 'unit', command: 'bun test', passed: 0, failed: 1, output: '1 fail', type: 'unit', duration_ms: 10 }];
    putRecord(d, record(d, { tested_files: [join(d, 'tests', 'a.test.ts')], suites }));
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('테스트 검증 실패');
    expect(out.reason).not.toContain('(1/');
    expect(out.reason).not.toContain('실패한 테스트 스위트');
  }, 60_000);

  test('one failing rule is reported plainly, with no numbering', async () => {
    const out = await twoGaps({ GOODBOY_TEST_TYPES: 'off' });
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/changed-line coverage/);
    expect(out.reason).not.toContain('(1/');
    expect(out.reason).not.toContain('Test types missing');
  }, 60_000);
});

describe('forbidden patterns on added lines', () => {
  const OLD_TODO = `${TEST}test.todo("later");\n`;
  const env = { GOODBOY_EXISTING_TESTS: 'on' };

  test('a todo already in an unchanged test file does not block the record that lists it', async () => {
    const { d, s } = project({ 'tests/a.test.ts': OLD_TODO });
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    edited(s, a);
    putRecord(d, record(d));
    const out = await stop(d, s, env);
    expect(out.reason ?? '').not.toContain('skip/todo');
    expect(out.reason ?? '').not.toContain('Existing tests that cover the change');
    expect(out.reason ?? '').not.toContain('테스트 게이트');
  }, 60_000);

  test('the existing-tests rule still asks for that test when the record does not list it', async () => {
    const { d, s } = project({ 'tests/a.test.ts': OLD_TODO });
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    edited(s, a);
    const other = write(d, 'tests/new.test.ts', 'test("n", () => { expect(2).toBe(2); });\n');
    putRecord(d, record(d, { test_files: [other] }));
    const out = await stop(d, s, env);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Existing tests that cover the change did not run with it');
    expect(out.reason).not.toContain('skip/todo');
  }, 60_000);

  test('a todo added in the session is caught, with its line', async () => {
    const { d, s } = project({ 'tests/a.test.ts': OLD_TODO });
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    edited(s, a);
    const t = join(d, 'tests', 'a.test.ts');
    writeFileSync(t, `${OLD_TODO}test.skip("added", () => {});\n`); // line 5 (the old todo is line 4)
    putRecord(d, record(d));
    const out = await stop(d, s, env);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`${t}:5: `);
    expect(out.reason).toContain('skip/todo');
    expect(out.reason).not.toContain(`${t}:4: `);
  }, 60_000);
});

describe('forbidden patterns: a test file git does not show as changed', () => {
  const OLD_TODO = `${TEST}test.todo("later");\n`;
  const env = { GOODBOY_EXISTING_TESTS: 'on' };
  async function run(committed: string, now: string) {
    const { d, s } = project({ 'tests/a.test.ts': committed });
    sh(d, 'git update-index --assume-unchanged tests/a.test.ts'); // git's diff no longer sees the file
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    edited(s, a);
    const t = join(d, 'tests', 'a.test.ts');
    writeFileSync(t, now);
    putRecord(d, record(d));
    return { out: await stop(d, s, env), t };
  }

  test('one that differs from its start blob gets every line scanned: an added skip is caught', async () => {
    const { out, t } = await run(TEST, `${TEST}test.skip("hidden", () => {});\n`);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`${t}:4: `);
    expect(out.reason).toContain('skip/todo');
  }, 60_000);

  test('one equal to its start blob is not scanned: its old todo does not block', async () => {
    const { out } = await run(OLD_TODO, OLD_TODO);
    expect(out.reason ?? '').not.toContain('skip/todo');
    expect(out.reason ?? '').not.toContain('테스트 게이트');
  }, 60_000);
});

describe('subprocess evidence through the hook', () => {
  const SPAWNING = 'test("hook", () => { Bun.spawn(["bun", "src/calc.ts"]); });\n';
  const rec = (d: string, subprocess: boolean, suiteType = 'integration') =>
    record(d, {
      suites: [{ name: 's', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: suiteType, duration_ms: 10 }],
      coverage: cov('src/calc.ts', 1, 2, subprocess ? { subprocess: [{ file: 'src/calc.ts', test: 'tests/a.test.ts' }] } : {}, headOf(d)),
    });
  async function run(testText: string, subprocess: boolean, suiteType?: string) {
    // The changed file is a program (an entry point): only such a file runs as a subprocess.
    const { d, s } = project({ 'tests/a.test.ts': testText, 'src/calc.ts': `${V1}if (import.meta.main) console.log(a);\n` });
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, `${V2}if (import.meta.main) console.log(a);\n`);
    edited(s, a);
    putRecord(d, rec(d, subprocess, suiteType));
    return stop(d, s, { GOODBOY_DIFF_COVERAGE: 'on' });
  }

  test('a file a passing integration test spawns counts at file level, with a warning', async () => {
    const out = await run(SPAWNING, true);
    expect(out.reason ?? '').not.toMatch(/changed-line coverage/);
    expect(out.systemMessage ?? '').toContain('하위 프로세스로 실행된 파일 1개');
    expect(out.systemMessage ?? '').toContain('src/calc.ts');
  }, 60_000);

  test('a library file (no entry point) is no subprocess evidence, whatever the test spawns', async () => {
    const { d, s } = project({ 'tests/a.test.ts': SPAWNING });
    const a = join(d, 'src', 'calc.ts');
    writeFileSync(a, V2);
    edited(s, a);
    putRecord(d, rec(d, true));
    const out = await stop(d, s, { GOODBOY_DIFF_COVERAGE: 'on' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/calc.ts (1 of 2 lines ran)');
  }, 60_000);

  test('without a spawn call, with a unit-only suite, or without the listing, the lines are still a gap', async () => {
    for (const out of [await run(TEST, true), await run(SPAWNING, true, 'unit'), await run(SPAWNING, false)]) {
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('src/calc.ts (1 of 2 lines ran)');
      expect(out.systemMessage ?? '').not.toContain('하위 프로세스로 실행된 파일');
    }
  }, 120_000);
});
