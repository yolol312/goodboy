// N8b (plan §20.12, #44 item 2) through the real Stop hook (spawned, as tests/i26-review-net-change.test.ts and
// tests/i23-gate-scope-stop.test.ts do): the files the user deferred to the next push (`defer-test`, `defer-review`
// in a `decide: human` entry of .goodboy/policy.md) are left out of layer 1 and of the review gate, and only those.
//   AC-4a  a code file matched by defer-test does not block layer 1, an unmatched one does;
//   AC-4b  a file matched by defer-review does not block the review gate, an unmatched one does;
//   AC-4c  with only deferred files pending the review is not accepted (the cursor stays) and nothing blocks;
//   AC-4d  status.json has `deferred`, the gate log has `deferred-to-push(n)`, and the notice comes once per session;
//   AC-4e  the docs rule still sees a deferred file;
//   AC-4f  a glob added mid-session counts at the next Stop when no tool wrote a policy file, and only from the next
//          session (with a notice) when one did;
//   AC-5   the stop_hook_active path accepts a review that covers the files that are not deferred.
// Repos and session dirs are temporary; the hook and the review CLI run for real (integration).
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { notePolicySeen } from '../lib/deferral';
import { recordEdit } from '../lib/file-tracker';
import { readGateLog, readStatusSnapshot } from '../lib/gate-log';
import { readReviewCursor, readTestCursor } from '../lib/review-cursor';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';
import { readHabitState } from '../lib/token-habits';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
setDefaultTimeout(90_000);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).stdout.toString().trim();
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function sid(): string {
  const s = `n8bs${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const V1 = 'export const a = 1;\n';
const V2 = 'export const a = 1;\nexport const b = 2;\n';
const policy = (globs: Record<string, string>): string =>
  ['## P1 Deferrals', '- decide: human', '- source: user 2026-11-26', ...Object.entries(globs).map(([k, v]) => `- ${k}: ${v}`), ''].join('\n');

interface Project {
  d: string;
  s: string;
  a: string;
  b: string;
}
/** A repo with src/a.ts and src/b.ts committed (and a policy with `globs`, when given); the session pinned there. */
function project(globs: Record<string, string> | string | null, files: Record<string, string> = {}): Project {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-n8bs-')));
  dirs.push(d);
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  for (const [p, t] of Object.entries({ 'src/a.ts': V1, 'src/b.ts': V1, ...files })) write(d, p, t);
  if (globs !== null) write(d, '.goodboy/policy.md', typeof globs === 'string' ? globs : policy(globs));
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  const s = sid();
  pinCoverageStart(s, d);
  // The session start (SessionStart does both): the policy file as it is now is the user's.
  notePolicySeen(s, d);
  return { d, s, a: join(d, 'src', 'a.ts'), b: join(d, 'src', 'b.ts') };
}
/** The file changed (V2) and its edit logged. */
function edit(p: Project, file: string): void {
  writeFileSync(file, V2);
  recordEdit(p.s, file, 0, undefined, Date.now());
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
async function stop(p: Project, opts: { active?: boolean; env?: Record<string, string> } = {}): Promise<StopOut> {
  const proc = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: p.d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: p.d, session_id: p.s, hook_event_name: 'Stop', stop_hook_active: opts.active === true })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_TEST_GATE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...opts.env },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  // A rule that throws makes the gate fail open (a pass): never in these tests.
  expect(err).not.toContain('[goodboy stop]');
  return JSON.parse(text || '{}') as StopOut;
}

/** The user's next message: the real UserPromptSubmit hook runs (it notes the policy file as the user's). */
async function userMessage(p: Project): Promise<void> {
  const proc = Bun.spawn(['bun', join(ROOT, 'hooks', 'user-prompt-submit.ts')], {
    cwd: p.d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: p.d, session_id: p.s, hook_event_name: 'UserPromptSubmit', prompt: 'carry on' })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CLAUDE_PROJECT_DIR: p.d, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  await new Response(proc.stdout).text();
  await proc.exited;
}

/** review-write run for real in the project, for `files`. */
function reviewWrite(d: string, files: string[]): void {
  const input = { reviewed_files: files, category: 'fix-bug', findings: [], verdict: 'pass', dimensions_checked: Object.values(AXIS_DIMENSIONS).flat() };
  const r = Bun.spawnSync(['bun', CLI, 'review-write'], { cwd: d, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
  expect(r.exitCode).toBe(0);
}

const TEST = 'import { expect, test } from "bun:test";\ntest("a", () => { expect(1).toBe(1); });\n';
/** A passing layer-1 record, made after the edits, that lists `files` as tested. */
function putTestRecord(p: Project, files: string[]): void {
  const dir = join(p.d, '.claude', 'tests');
  mkdirSync(dir, { recursive: true });
  const rec = {
    timestamp: new Date(Date.now() + 60_000).toISOString(),
    commit: sh(p.d, 'git rev-parse HEAD'),
    tested_files: files,
    category: 'fix-bug',
    test_files: [join(p.d, 'tests', 'a.test.ts')],
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
  };
  writeFileSync(join(dir, 'r0.json'), JSON.stringify(rec));
}

const NO_RESULT = /No test result covers the changed code/;
const REVIEW_ASKED = /Review is required for the changed files|Review validation failed/;
/** The part of a block that names the test gate's files (the review item of the same block lists them all). */
const testItem = (o: StopOut): string => /\[test\] (.*?) \(block \d+\)/s.exec(o.reason ?? '')?.[1] ?? '';
/** The session's gate log lines that note a deferral: `<gate>:<decision>:<reason>`. */
const deferLog = (s: string): string[] => readGateLog(s).filter((e) => e.reason?.startsWith('deferred-to-push')).map((e) => `${e.gate}:${e.decision}:${e.reason}`);

describe('AC-4a: defer-test leaves the matched file out of layer 1', () => {
  test('a deferred file alone: layer 1 asks nothing (the review gate still asks about it)', async () => {
    const p = project({ 'defer-test': 'src/a.ts' });
    edit(p, p.a);
    const out = await stop(p);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').not.toMatch(NO_RESULT);
    expect(out.reason).toMatch(REVIEW_ASKED);
    expect(out.reason).toContain('src/a.ts');
  });

  test('an unmatched file beside it is asked about, alone', async () => {
    const p = project({ 'defer-test': 'src/a.ts' });
    edit(p, p.a);
    edit(p, p.b);
    const out = await stop(p);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(NO_RESULT);
    expect(testItem(out)).toContain('src/b.ts');
    expect(testItem(out)).not.toContain('src/a.ts');
  });

  test('without the deferral the same file is asked about (the control)', async () => {
    const p = project({ 'coverage-exempt': 'zzz/**' });
    edit(p, p.a);
    const out = await stop(p);
    expect(out.reason).toMatch(NO_RESULT);
    expect(testItem(out)).toContain('src/a.ts');
  });
});

describe('AC-4b: defer-review leaves the matched file out of the review gate', () => {
  test('a deferred file alone: nothing blocks', async () => {
    const p = project({ 'defer-review': 'src/a.ts' });
    edit(p, p.a);
    const out = await stop(p, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBeUndefined();
    expect(out.reason ?? '').not.toMatch(REVIEW_ASKED);
  });

  test('an unmatched file beside it is asked about, alone', async () => {
    const p = project({ 'defer-review': 'src/a.ts' });
    edit(p, p.a);
    edit(p, p.b);
    const out = await stop(p, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(REVIEW_ASKED);
    expect(out.reason).toContain('src/b.ts');
    expect(out.reason).not.toContain('src/a.ts');
  });

  test('both deferrals on one file: nothing blocks at all', async () => {
    const p = project({ 'defer-review': 'src/a.ts', 'defer-test': 'src/a.ts' });
    edit(p, p.a);
    const out = await stop(p);
    expect(out.decision).toBeUndefined();
    expect(out.reason ?? '').toBe('');
  });

  test('a defer entry of an `ai` decision defers nothing', async () => {
    const p = project(['## P1 Deferrals', '- decide: ai', '- source: model', '- defer-review: src/a.ts', '- defer-test: src/a.ts', ''].join('\n'));
    edit(p, p.a);
    const out = await stop(p);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(NO_RESULT);
    expect(out.reason).toMatch(REVIEW_ASKED);
  });
});

describe('AC-4c: only deferred files pending, the review is not accepted', () => {
  test('a review that covers the deferred file: nothing blocks and the review cursor does not move', async () => {
    const p = project({ 'defer-review': 'src/a.ts' });
    edit(p, p.a);
    reviewWrite(p.d, [p.a]);
    const out = await stop(p, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBeUndefined();
    expect(readReviewCursor(p.d, p.s)).toBeNull();
  });

  test('the same review without the deferral is accepted: the cursor moves (the control)', async () => {
    const p = project({ 'coverage-exempt': 'zzz/**' });
    edit(p, p.a);
    reviewWrite(p.d, [p.a]);
    const out = await stop(p, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBeUndefined();
    expect(readReviewCursor(p.d, p.s)).not.toBeNull();
  });

  test('a review of the file that is not deferred is accepted, the deferred one stays out of the judgment', async () => {
    const p = project({ 'defer-review': 'src/a.ts' });
    edit(p, p.a);
    edit(p, p.b);
    reviewWrite(p.d, [p.b]);
    const out = await stop(p, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBeUndefined();
    expect(readReviewCursor(p.d, p.s)).not.toBeNull();
  });
});

describe('AC-4d: the status, the gate log and the notice', () => {
  test('status.json has the deferred counts, the gate log the line, and the notice comes once per kind and session', async () => {
    const p = project({ 'defer-review': 'src/a.ts', 'defer-test': 'src/a.ts, src/b.ts' });
    edit(p, p.a);
    edit(p, p.b);
    const first = await stop(p, { env: { GOODBOY_TEST_GATE: 'on' } });
    expect(readStatusSnapshot(p.s)?.deferred).toEqual({ review: 1, test: 2 });
    const notices = (o: StopOut) => (o.systemMessage ?? '').match(/미룸\(defer-(review|test)\)/g) ?? [];
    expect(notices(first).sort()).toEqual(['미룸(defer-review)', '미룸(defer-test)']);
    expect(first.systemMessage).toContain('파일 1개의 리뷰를');
    expect(first.systemMessage).toContain('파일 2개의 테스트를');
    expect(first.systemMessage).toContain('다음 push 때 확인해요');
    expect(deferLog(p.s).sort()).toEqual(['review:warn:deferred-to-push(1)', 'test:warn:deferred-to-push(2)']);
    // The next Stop of the session: the status and the log again, no second notice.
    const second = await stop(p, { env: { GOODBOY_TEST_GATE: 'on' } });
    expect(readStatusSnapshot(p.s)?.deferred).toEqual({ review: 1, test: 2 });
    expect(notices(second)).toEqual([]);
    expect(deferLog(p.s)).toHaveLength(4);
  });

  test('the count goes when the deferred files are brought back to their start content', async () => {
    const p = project({ 'defer-review': 'src/a.ts', 'defer-test': 'src/a.ts' });
    edit(p, p.a);
    await stop(p);
    expect(readStatusSnapshot(p.s)?.deferred).toEqual({ review: 1, test: 1 });
    writeFileSync(p.a, V1); // the start content again: no change of this session left
    const out = await stop(p);
    expect(out.decision).toBeUndefined();
    expect(readStatusSnapshot(p.s)?.deferred).toBeUndefined();
  });

  test('a session with no deferral has no `deferred` in its status', async () => {
    const p = project({ 'coverage-exempt': 'zzz/**' });
    edit(p, p.a);
    const out = await stop(p);
    expect(readStatusSnapshot(p.s)?.deferred).toBeUndefined();
    expect(out.systemMessage ?? '').not.toContain('미룸');
    expect(deferLog(p.s)).toEqual([]);
  });

  test('a deferral that matches no edited file leaves no count and no notice', async () => {
    const p = project({ 'defer-review': 'docs/**', 'defer-test': 'docs/**' });
    edit(p, p.a);
    const out = await stop(p);
    expect(readStatusSnapshot(p.s)?.deferred).toBeUndefined();
    expect(out.systemMessage ?? '').not.toContain('미룸');
  });
});

describe('AC-4e: the docs rule still sees a deferred file', () => {
  test('a mapped doc is still asked for when the only changed file is deferred from the review and the tests', async () => {
    const p = project(
      { 'defer-review': 'src/a.ts', 'defer-test': 'src/a.ts' },
      { 'ARCH.md': '# Arch\n', '.goodboy/docs.json': JSON.stringify({ docs: [{ path: 'ARCH.md', session_start: false, covers: ['src/**'] }] }) },
    );
    edit(p, p.a);
    const out = await stop(p, { env: { GOODBOY_DOCS_GATE: 'on' } });
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toMatch(/docs rule/);
    expect(out.reason ?? '').not.toMatch(NO_RESULT);
    expect(out.reason ?? '').not.toMatch(REVIEW_ASKED);
  });
});

describe('AC-4f: a glob added during the session', () => {
  test('no tool wrote the policy file: the glob the file gained counts at the next Stop', async () => {
    const p = project({ 'defer-test': 'src/a.ts' });
    edit(p, p.a);
    edit(p, p.b);
    const before = await stop(p);
    expect(testItem(before)).toContain('src/b.ts');
    // The user adds the glob by hand: no tool of this session wrote the file, and their next message (the real
    //   UserPromptSubmit hook) takes the file as it is as theirs.
    write(p.d, '.goodboy/policy.md', policy({ 'defer-test': 'src/a.ts, src/b.ts' }));
    await userMessage(p);
    const after = await stop(p);
    expect(after.reason ?? '').not.toMatch(NO_RESULT);
    expect(readStatusSnapshot(p.s)?.deferred?.test).toBe(2);
    expect(after.systemMessage ?? '').not.toContain('다음 세션부터');
  });

  test('a tool wrote the policy file: the glob waits for the next session, with a notice once', async () => {
    const p = project({ 'defer-test': 'src/a.ts' });
    edit(p, p.a);
    edit(p, p.b);
    write(p.d, '.goodboy/policy.md', policy({ 'defer-test': 'src/a.ts, src/b.ts' }));
    recordEdit(p.s, join(p.d, '.goodboy', 'policy.md'), 0, undefined, Date.now());
    const first = await stop(p);
    expect(first.reason).toMatch(NO_RESULT);
    expect(testItem(first)).toContain('src/b.ts');
    expect(testItem(first)).not.toContain('src/a.ts');
    expect(first.systemMessage).toContain('다음 세션부터 적용돼요');
    expect(first.systemMessage).toContain('src/b.ts');
    expect(readStatusSnapshot(p.s)?.deferred?.test).toBe(1);
    // The next Stop of the session: the glob still waits (the status keeps the count), and the notice is not repeated.
    const second = await stop(p);
    expect(readStatusSnapshot(p.s)?.deferred?.test).toBe(1);
    expect(second.systemMessage ?? '').not.toContain('다음 세션부터');
  });

  test('a write no hook saw (a link, a script, a call that ended with no post hook): the Stop\'s own watch makes the glob wait', async () => {
    const p = project({ 'defer-test': 'src/a.ts' });
    edit(p, p.a);
    edit(p, p.b);
    // Nothing in the edit log names the policy file and no post hook ran: only the file changed.
    write(p.d, '.goodboy/policy.md', policy({ 'defer-test': 'src/a.ts, src/b.ts' }));
    const out = await stop(p);
    expect(out.reason).toMatch(NO_RESULT);
    expect(testItem(out)).toContain('src/b.ts');
    expect(testItem(out)).not.toContain('src/a.ts');
    expect(out.systemMessage).toContain('다음 세션부터 적용돼요');
    expect(readStatusSnapshot(p.s)?.deferred?.test).toBe(1);
    expect(JSON.parse(readFileSync(join(tmpdir(), `goodboy-session-${p.s}`, 'policy-seen.json'), 'utf8'))).toMatchObject({ written: true });
  });

  test('globs that wait for both kinds get one notice each, kept apart in the habit state', async () => {
    const p = project({ 'defer-review': 'docs/**', 'defer-test': 'docs/**' });
    edit(p, p.b);
    write(p.d, '.goodboy/policy.md', policy({ 'defer-review': 'docs/**, src/a.ts', 'defer-test': 'docs/**, src/a.ts' }));
    recordEdit(p.s, join(p.d, '.goodboy', 'policy.md'), 0, undefined, Date.now());
    const first = await stop(p);
    expect(first.systemMessage).toContain('defer-review glob(src/a.ts)');
    expect(first.systemMessage).toContain('defer-test glob(src/a.ts)');
    expect(readHabitState(p.s).deferNoticeShown).toEqual({ waitingReview: true, waitingTest: true });
    // Said once: the next Stop of the session does not repeat either.
    const second = await stop(p);
    expect(second.systemMessage ?? '').not.toContain('다음 세션부터');
    expect(readHabitState(p.s).deferNoticeShown).toEqual({ waitingReview: true, waitingTest: true });
  });

  test('a waiting glob alone, with nothing deferred yet, still gets its notice', async () => {
    const p = project({ 'defer-review': 'docs/**' });
    edit(p, p.b);
    write(p.d, '.goodboy/policy.md', policy({ 'defer-review': 'docs/**, src/a.ts' }));
    recordEdit(p.s, join(p.d, '.goodboy', 'policy.md'), 0, undefined, Date.now());
    const out = await stop(p, { env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/b.ts');
    expect(out.systemMessage).toContain('다음 세션부터 적용돼요');
    expect(out.systemMessage).toContain('src/a.ts');
    expect(readStatusSnapshot(p.s)?.deferred).toBeUndefined();
  });
});

describe('AC-5: the stop_hook_active path', () => {
  test('a review that covers the files that are not deferred is accepted: the cursor moves', async () => {
    const p = project({ 'defer-review': 'src/a.ts' });
    edit(p, p.a);
    edit(p, p.b);
    reviewWrite(p.d, [p.b]);
    const out = await stop(p, { active: true, env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBeUndefined();
    expect(readReviewCursor(p.d, p.s)).not.toBeNull();
  });

  test('the same review without the deferral does not cover the other file: nothing is accepted (the control)', async () => {
    const p = project({ 'coverage-exempt': 'zzz/**' });
    edit(p, p.a);
    edit(p, p.b);
    reviewWrite(p.d, [p.b]);
    await stop(p, { active: true, env: { GOODBOY_TEST_GATE: 'off' } });
    expect(readReviewCursor(p.d, p.s)).toBeNull();
  });

  test('only deferred files pending: the cursor does not move', async () => {
    const p = project({ 'defer-review': 'src/a.ts' });
    edit(p, p.a);
    reviewWrite(p.d, [p.a]);
    const out = await stop(p, { active: true, env: { GOODBOY_TEST_GATE: 'off' } });
    expect(out.decision).toBeUndefined();
    expect(readReviewCursor(p.d, p.s)).toBeNull();
  });

  test('layer 1: a passing record of the file that is not deferred is accepted, the deferred file is not asked about', async () => {
    const p = project({ 'defer-test': 'src/a.ts' }, { 'tests/a.test.ts': TEST });
    edit(p, p.a);
    edit(p, p.b);
    putTestRecord(p, [p.b]);
    const out = await stop(p, { active: true });
    // Layer 1 is accepted, and the Stop goes on to the review gate (which has no review yet): the test gate asks nothing.
    expect(readTestCursor(p.d, p.s)).not.toBeNull();
    expect(out.reason ?? '').not.toMatch(NO_RESULT);
    expect(out.reason).toMatch(REVIEW_ASKED);
  });

  test('layer 1: the same record without the deferral does not cover the other file: nothing is accepted (the control)', async () => {
    const p = project({ 'coverage-exempt': 'zzz/**' }, { 'tests/a.test.ts': TEST });
    edit(p, p.a);
    edit(p, p.b);
    putTestRecord(p, [p.b]);
    await stop(p, { active: true });
    expect(readTestCursor(p.d, p.s)).toBeNull();
  });

  test('layer 1: only deferred test files pending, nothing is accepted and the test cursor does not move', async () => {
    const p = project({ 'defer-test': 'src/a.ts' }, { 'tests/a.test.ts': TEST });
    edit(p, p.a);
    putTestRecord(p, [p.a]);
    const out = await stop(p, { active: true });
    expect(out.decision).toBeUndefined();
    expect(readTestCursor(p.d, p.s)).toBeNull();
  });

  test('the unresolved-start check leaves the deferred files out: no "ended unverified" warning for them', async () => {
    const deferred = project({ 'defer-review': 'src/a.ts', 'defer-test': 'src/a.ts' });
    edit(deferred, deferred.a);
    rmSync(join(tmpdir(), `goodboy-session-${deferred.s}`, 'coverage-pin.json')); // the start of the session is now unknown
    const quiet = await stop(deferred, { active: true });
    expect(quiet.decision).toBeUndefined();
    expect(quiet.systemMessage ?? '').not.toContain('검증 없이 끝났습니다');
    // The control: the same unknown start with no deferral is told to the user.
    const plain = project({ 'coverage-exempt': 'zzz/**' });
    edit(plain, plain.a);
    rmSync(join(tmpdir(), `goodboy-session-${plain.s}`, 'coverage-pin.json'));
    const told = await stop(plain, { active: true });
    expect(told.systemMessage).toContain('검증 없이 끝났습니다');
  });
});
