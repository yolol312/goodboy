// Block counts belong to one session (stabilization plan A3), and so does the user's Stop
// approval (track G: it replaced the count-based escapes). Driven only through real Stop
// calls, so the tests do not depend on where or how the counters are stored.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function newSandbox(): { tmp: string; cwd: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-iso-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-iso-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd };
}

/** File-tracker state for one session: edits at `turn` (Stop increments the turn first). */
function seedSession(tmp: string, sessionId: string, turn: number, editFiles: string[], cwd: string): void {
  const dir = join(tmp, `goodboy-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles.map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts })).join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
  for (const f of editFiles) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
}

/** The PostToolUse auto-validation failure marker, in the session's state dir (A3). */
function seedValidationMarker(tmp: string, sessionId: string): void {
  const dir = join(tmp, `goodboy-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.goodboy-validation-failed.json'),
    JSON.stringify({ sessionId, timestamp: new Date().toISOString(), commands: ['bun run typecheck'] }),
    'utf8',
  );
}

/** A pass review that covers neither session's edits, so review validation keeps failing. */
function writeUncoveringReview(cwd: string): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(
    join(reviewsDir, 'review.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      reviewed_files: [resolve(cwd, 'other.ts')],
      category: 'refactor',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: [],
    }),
    'utf8',
  );
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runStop(tmp: string, cwd: string, sessionId: string): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    // Layer 1 fires before review; turn it off to isolate the gates under test.
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0' },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop' })),
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

// The command the notice prints for each session (the session tag is the id up to 8 chars).
const TOUCH_A = '! touch .claude/.goodboy-stop-approved-sess-a.txt';
const TOUCH_B = '! touch .claude/.goodboy-stop-approved-sess-b.txt';

/** The user's one-use Stop override for `sessionId`: what its notice tells the user to run. */
function approveStop(cwd: string, sessionId: string): string {
  const p = join(cwd, '.claude', `.goodboy-stop-approved-${sessionId}.txt`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf8');
  return p;
}

describe('Stop hook — per-session block counts (A3) and the user override (track G)', () => {
  test("another session's Stop does not reset this session's block count", async () => {
    const { tmp, cwd } = newSandbox();
    seedValidationMarker(tmp, 'sess-a');

    const a1 = await runStop(tmp, cwd, 'sess-a');
    expect(a1.decision).toBe('block');
    expect(a1.reason).toContain('(block 1)');
    const a2 = await runStop(tmp, cwd, 'sess-a');
    expect(a2.decision).toBe('block');
    expect(a2.reason).toContain('(block 2)');
    expect(a2.systemMessage ?? '').toContain(TOUCH_A);

    // Session B has no marker of its own; its Stop resets only its own count.
    const b = await runStop(tmp, cwd, 'sess-b');
    expect(b.decision).toBeUndefined();

    // No escape on the 3rd: still blocked, the count goes on.
    const a3 = await runStop(tmp, cwd, 'sess-a');
    expect(a3.decision).toBe('block');
    expect(a3.reason).toContain('(block 3)');
    expect(a3.systemMessage ?? '').toContain(TOUCH_A);
  });

  test("two sessions blocking in turn count their own blocks; one session's approval does not pass the other", async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-a', 1, ['src/a.ts'], cwd);
    seedSession(tmp, 'sess-b', 1, ['src/b.ts'], cwd);
    writeUncoveringReview(cwd);

    const a1 = await runStop(tmp, cwd, 'sess-a');
    const b1 = await runStop(tmp, cwd, 'sess-b');
    const a2 = await runStop(tmp, cwd, 'sess-a');
    const b2 = await runStop(tmp, cwd, 'sess-b');
    expect([a1.decision, b1.decision, a2.decision, b2.decision]).toEqual(['block', 'block', 'block', 'block']);
    expect(a1.reason).toContain('(block 1)');
    expect(b1.reason).toContain('(block 1)');
    expect(a2.reason).toContain('(block 2)');
    expect(b2.reason).toContain('(block 2)');
    // Each notice names that session's own marker.
    expect(a2.systemMessage ?? '').toContain(TOUCH_A);
    expect(a2.systemMessage ?? '').not.toContain(TOUCH_B);
    expect(b2.systemMessage ?? '').toContain(TOUCH_B);

    // B's user approves: B passes once, A is still blocked.
    const markerB = approveStop(cwd, 'sess-b');
    const a3 = await runStop(tmp, cwd, 'sess-a');
    expect(a3.decision).toBe('block');
    expect(a3.reason).toContain('(block 3)');
    expect(existsSync(markerB)).toBe(true); // A's Stop does not use B's approval
    const b3 = await runStop(tmp, cwd, 'sess-b');
    expect(b3.decision).toBeUndefined();
    expect(b3.systemMessage ?? '').toContain('사용자 승인 마커로 이번 턴의');
    expect(existsSync(markerB)).toBe(false);
  });
});
