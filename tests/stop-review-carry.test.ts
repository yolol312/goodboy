// The Stop review gate does not re-block a turn that changed no reviewable file (as the test gate's
// F1, tests/stop-test-gate.test.ts "a turn with no code change is not re-blocked"). The earlier
// edits stay pending (the review cursor holds) and block the next turn that changes a file.
// Real Stop hook, spawned; the session dir and the project dir are temporary. The test gate is off
// so that the review gate is the one under test.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { REVIEW_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';
import { requiredDimensionsFor } from '../lib/review-dimensions';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const CODE_FILE = 'src/a.ts';
const CARRY_WARNING = '파일 변경이 없어 리뷰 게이트가 막지 않았어요';
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function newSandbox(): { tmp: string; cwd: string; sessionId: string; stateDir: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-rc-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-rc-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  const stateDir = join(tmp, `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`);
  return { tmp, cwd, sessionId, stateDir };
}

/** One edit of the code file at the turn the next Stop closes (turn 3); turn.txt holds 3 as in a live session. */
function seedSession(stateDir: string, cwd: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'turn.txt'), '3', 'utf8');
  writeFileSync(
    join(stateDir, 'edits.jsonl'),
    JSON.stringify({ file: resolve(cwd, CODE_FILE), turn: 3, timestamp: new Date().toISOString() }) + '\n',
    'utf8',
  );
  const abs = resolve(cwd, CODE_FILE);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '', 'utf8');
}

/** Records one more edit of the code file in the turn the next Stop closes. */
function editAgain(stateDir: string, cwd: string): void {
  const turn = parseInt(readFileSync(join(stateDir, 'turn.txt'), 'utf8').trim(), 10);
  appendFileSync(
    join(stateDir, 'edits.jsonl'),
    JSON.stringify({ file: resolve(cwd, CODE_FILE), turn, timestamp: new Date().toISOString() }) + '\n',
    'utf8',
  );
}

function reviewCursorPath(stateDir: string, cwd: string): string {
  return join(stateDir, cursorFileName(REVIEW_CURSOR_FILE, cwd));
}

function writeHighSeverityReview(cwd: string): void {
  const dir = join(cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: [resolve(cwd, CODE_FILE)],
      category: 'add-feature',
      findings: [
        { file: resolve(cwd, CODE_FILE), line: 1, issue: 'unchecked input reaches a shell', severity: 'high', probe: 'echo $X | sh -> ran' },
      ],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: ['performance', 'refactoring-quality', 'security-secrets'],
    }),
    'utf8',
  );
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runStop(tmp: string, cwd: string, sessionId: string, stopHookActive = false, transcriptPath?: string): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'off' },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
      }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as StopOut;
  } catch {
    return {};
  }
}

describe('Stop review gate: a turn with no reviewable change is not re-blocked', () => {
  test('no review file: blocked once; the next turn without an edit is carried with a warning; a new edit blocks again', async () => {
    const { tmp, cwd, sessionId, stateDir } = newSandbox();
    seedSession(stateDir, cwd);

    const first = await runStop(tmp, cwd, sessionId);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('Review is required');

    const idle = await runStop(tmp, cwd, sessionId);
    expect(idle.decision).toBeUndefined();
    expect(idle.reason).toBeUndefined();
    expect(JSON.stringify(idle)).toContain(CARRY_WARNING);
    expect(existsSync(reviewCursorPath(stateDir, cwd))).toBe(false); // the edits stay pending

    // Still carried on a further idle turn.
    const idle2 = await runStop(tmp, cwd, sessionId);
    expect(idle2.decision).toBeUndefined();
    expect(JSON.stringify(idle2)).toContain(CARRY_WARNING);

    editAgain(stateDir, cwd);
    const next = await runStop(tmp, cwd, sessionId);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('Review is required');
    expect(JSON.stringify(next)).not.toContain(CARRY_WARNING);
  }, 30_000);

  test('high-severity finding: blocked once; the next turn without an edit is carried; a new edit blocks again', async () => {
    const { tmp, cwd, sessionId, stateDir } = newSandbox();
    seedSession(stateDir, cwd);
    writeHighSeverityReview(cwd);

    const first = await runStop(tmp, cwd, sessionId);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('high severity');

    const idle = await runStop(tmp, cwd, sessionId);
    expect(idle.decision).toBeUndefined();
    expect(idle.reason).toBeUndefined();
    expect(JSON.stringify(idle)).toContain(CARRY_WARNING);
    expect(existsSync(reviewCursorPath(stateDir, cwd))).toBe(false);

    editAgain(stateDir, cwd);
    const next = await runStop(tmp, cwd, sessionId);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('high severity');
  }, 30_000);

  // A stop_hook_active Stop moves the turn counter too; an edit made after a block and before that
  // Stop is still this turn's change at the next full Stop.
  test('an edit made after a block counts as a change past the stop_hook_active Stop', async () => {
    const { tmp, cwd, sessionId, stateDir } = newSandbox();
    seedSession(stateDir, cwd);

    expect((await runStop(tmp, cwd, sessionId)).decision).toBe('block');
    editAgain(stateDir, cwd);
    await runStop(tmp, cwd, sessionId, true);

    const next = await runStop(tmp, cwd, sessionId);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('Review is required');
    expect(JSON.stringify(next)).not.toContain(CARRY_WARNING);
  }, 30_000);
});

// The other carry sites of the review gate (hooks/stop.ts `carryReview`): each blocks once; a turn
// that changes no reviewable file is carried with the warning and a `carried` gate-log line; a new
// edit blocks again. The review (or its flaw) is the one fixture each site needs.
describe('Stop review gate: every other carry site', () => {
  /** A review of the code file; `over` sets what the site under test needs. */
  function writeReview(cwd: string, over: Record<string, unknown> = {}): void {
    const dir = join(cwd, '.claude', 'reviews');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'review.json'),
      JSON.stringify({
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        reviewed_files: [resolve(cwd, CODE_FILE)],
        category: 'add-feature',
        findings: [],
        unknown_assumptions_checked: [],
        verdict: 'pass',
        dimensions_checked: requiredDimensionsFor([resolve(cwd, CODE_FILE)]),
        ...over,
      }),
      'utf8',
    );
  }
  const gateLog = (stateDir: string): string => {
    const p = join(stateDir, 'gate-log.jsonl');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };

  /** Blocked once with `blockText`; carried on the next idle turn; blocked again after a new edit. */
  async function expectCarry(
    sb: ReturnType<typeof newSandbox>,
    blockText: string,
    why: string,
    transcriptPath?: string,
  ): Promise<void> {
    const { tmp, cwd, sessionId, stateDir } = sb;
    const first = await runStop(tmp, cwd, sessionId, false, transcriptPath);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain(blockText);

    const idle = await runStop(tmp, cwd, sessionId, false, transcriptPath);
    expect(idle.decision).toBeUndefined();
    expect(idle.reason).toBeUndefined();
    expect(JSON.stringify(idle)).toContain(CARRY_WARNING);
    expect(gateLog(stateDir)).toContain(`carried (no change this turn): ${why}`);
    expect(existsSync(reviewCursorPath(stateDir, cwd))).toBe(false); // the edits stay pending

    editAgain(stateDir, cwd);
    const next = await runStop(tmp, cwd, sessionId, false, transcriptPath);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain(blockText);
    expect(JSON.stringify(next)).not.toContain(CARRY_WARNING);
  }

  test('invalid review (a review that does not list the changed file)', async () => {
    const sb = newSandbox();
    seedSession(sb.stateDir, sb.cwd);
    writeReview(sb.cwd, { reviewed_files: [resolve(sb.cwd, 'src/other.ts')] });
    await expectCarry(sb, 'Review validation failed', '리뷰되지 않은 변경 파일 1개');
  }, 30_000);

  test('assumptions-unchecked (a declared guess the review did not check)', async () => {
    const sb = newSandbox();
    seedSession(sb.stateDir, sb.cwd);
    writeReview(sb.cwd);
    const transcript = join(sb.tmp, 'transcript.jsonl');
    const reasoning = ['## 추론', '### 사실', '- a.ts를 Read로 확인함', '### 추측', '- ⚠️ 호출자는 항상 문자열을 넘길 것이다'].join('\n');
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reasoning }] } }),
        JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
      ].join('\n') + '\n',
      'utf8',
    );
    await expectCarry(sb, 'did not check them', 'assumptions-unchecked', transcript);
  }, 30_000);

  test('missing-dimensions (a review that assessed none of the dimensions the change needs)', async () => {
    const sb = newSandbox();
    seedSession(sb.stateDir, sb.cwd);
    writeReview(sb.cwd, { dimensions_checked: [] });
    await expectCarry(sb, 'did not assess the quality dimensions', 'missing-dimensions:');
  }, 30_000);
});

// weakened-tests needs a repo and a session start pinned at its commit (the weakened rule compares
// with it), so this one runs the real SessionStart and PostToolUse hooks, as tests/i5-existing-tests.test.ts.
describe('Stop review gate: the weakened-tests carry site', () => {
  const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
  const T = 'import { expect, test } from "bun:test";\n';
  const ROOT = resolve(import.meta.dir, '..');
  async function hook(cwd: string, base: string, sid: string, script: string, payload: Record<string, unknown>): Promise<string> {
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', script)], {
      cwd,
      env: { ...process.env, TMPDIR: base, HOME: base, CLAUDE_PLUGIN_ROOT: ROOT, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_POLICY_GATE: 'off', GOODBOY_TEST_GATE: 'off', GOODBOY_DOCS_GATE: 'off', GOODBOY_EXISTING_TESTS: 'on' },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }

  test('a weakened existing test: blocked once; the next turn without an edit is carried; a new edit blocks again', async () => {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-rc-weak-'));
    tmpDirs.push(base);
    const top = realpathSync(mkdtempSync(join(base, 'repo-')));
    sh(top, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    const testFile = join(top, 'tests', 'calc.test.ts');
    mkdirSync(join(top, 'tests'), { recursive: true });
    writeFileSync(join(top, 'package.json'), '{"scripts":{"test":"bun test"}}');
    writeFileSync(testFile, `${T}test("add", () => { expect(1 + 2).toBe(3); expect(0 + 0).toBe(0); });\n`);
    sh(top, "git add -A && git commit -q -m 'ABC-1 start'");
    const sid = `rc-${Math.random().toString(36).slice(2)}`;
    const stateDir = join(base, `goodboy-session-${sid}`);
    await hook(top, base, sid, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });
    const record = () => hook(top, base, sid, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: testFile } });
    const stop = async (): Promise<StopOut> => {
      const out = await hook(top, base, sid, 'stop.ts', { hook_event_name: 'Stop', stop_hook_active: false });
      try {
        return JSON.parse(out) as StopOut;
      } catch {
        return {};
      }
    };

    writeFileSync(testFile, `${T}test("add", () => { expect(1 + 2).toBe(3); });\n`); // one check fewer
    await record();
    const { workTreeState } = await import('../lib/push-test');
    mkdirSync(join(top, '.claude', 'reviews'), { recursive: true });
    writeFileSync(
      join(top, '.claude', 'reviews', 'review.json'),
      JSON.stringify({
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        tree: workTreeState(top).tree, // as review-write stores it
        reviewed_files: [testFile],
        category: 'fix-bug',
        findings: [],
        unknown_assumptions_checked: [],
        verdict: 'pass',
        dimensions_checked: requiredDimensionsFor([testFile]),
      }),
    );

    const first = await stop();
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('lost checks');

    const idle = await stop();
    expect(idle.decision).toBeUndefined();
    expect(JSON.stringify(idle)).toContain(CARRY_WARNING);
    expect(readFileSync(join(stateDir, 'gate-log.jsonl'), 'utf8')).toContain('carried (no change this turn): weakened-tests: tests/calc.test.ts');

    await record(); // the same content, edited again: a new change this turn
    const next = await stop();
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('lost checks');
    expect(JSON.stringify(next)).not.toContain(CARRY_WARNING);
  }, 120_000);
});
