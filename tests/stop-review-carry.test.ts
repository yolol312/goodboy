// The Stop review gate does not re-block a turn that changed no reviewable file (as the test gate's
// F1, tests/stop-test-gate.test.ts "a turn with no code change is not re-blocked"). The earlier
// edits stay pending (the review cursor holds) and block the next turn that changes a file.
// Real Stop hook, spawned; the session dir and the project dir are temporary. The test gate is off
// so that the review gate is the one under test.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { REVIEW_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';

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

async function runStop(tmp: string, cwd: string, sessionId: string, stopHookActive = false): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'off' },
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop', stop_hook_active: stopHookActive }),
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
