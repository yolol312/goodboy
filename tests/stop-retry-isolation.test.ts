// Escape budgets belong to one session (stabilization plan A3), and escape messages count
// the blocks that actually happened (A9). Driven only through real Stop calls, so the tests
// do not depend on where or how the counters are stored.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('Stop hook — per-session escape budgets (A3) and escape wording (A9)', () => {
  test("another session's Stop does not reset this session's escape budget", async () => {
    const { tmp, cwd } = newSandbox();
    seedValidationMarker(tmp, 'sess-a');

    const a1 = await runStop(tmp, cwd, 'sess-a');
    expect(a1.decision).toBe('block');
    expect(a1.reason).toContain('1/3');
    const a2 = await runStop(tmp, cwd, 'sess-a');
    expect(a2.decision).toBe('block');
    expect(a2.reason).toContain('2/3');

    // Session B has no marker of its own; its Stop resets only its own budget.
    const b = await runStop(tmp, cwd, 'sess-b');
    expect(b.decision).toBeUndefined();

    const a3 = await runStop(tmp, cwd, 'sess-a');
    expect(a3.decision).toBeUndefined();
    // Two blocks happened, then the escape: the message must say 2, not 3.
    expect(a3.systemMessage).toContain('2회 차단 후');
    expect(a3.systemMessage).not.toContain('3회 차단 후');
  });

  test('two sessions blocking in turn each reach their own escape (no endless 1/3 loop)', async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-a', 1, ['src/a.ts'], cwd);
    seedSession(tmp, 'sess-b', 1, ['src/b.ts'], cwd);
    writeUncoveringReview(cwd);

    const a1 = await runStop(tmp, cwd, 'sess-a');
    const b1 = await runStop(tmp, cwd, 'sess-b');
    const a2 = await runStop(tmp, cwd, 'sess-a');
    const b2 = await runStop(tmp, cwd, 'sess-b');
    expect([a1.decision, b1.decision, a2.decision, b2.decision]).toEqual(['block', 'block', 'block', 'block']);
    expect(a1.reason).toContain('retry 1/3');
    expect(b1.reason).toContain('retry 1/3');
    expect(a2.reason).toContain('retry 2/3');
    expect(b2.reason).toContain('retry 2/3');

    const a3 = await runStop(tmp, cwd, 'sess-a');
    const b3 = await runStop(tmp, cwd, 'sess-b');
    expect(a3.decision).toBeUndefined();
    expect(b3.decision).toBeUndefined();
    expect(a3.systemMessage).toContain('2회 차단 후');
    expect(b3.systemMessage).toContain('2회 차단 후');
  });
});
