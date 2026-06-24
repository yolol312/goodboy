import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

/** Isolated TMPDIR so file-tracker session state lives in its own sandbox. */
function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'vcf-stop-compact-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-stop-compact-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** Seed file-tracker session state (mirrors file-tracker.ts layout). */
function seedSession(tmp: string, sessionId: string, turn: number, editFiles: string[]): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `vcf-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  // Stop increments turn first, so write turn-1 so it lands on `turn` after increment.
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles
    .map((f) => JSON.stringify({ file: resolve(f), turn, timestamp: ts }))
    .join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
}

function writeReview(cwd: string, review: Record<string, unknown>): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(join(reviewsDir, 'review.json'), JSON.stringify(review), 'utf8');
}

/** Write a transcript JSONL whose most-recent usage occupies `tokens` against a
 *  standard (200K) model, then return its path. */
function writeTranscript(cwd: string, tokens: number): string {
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: tokens } },
    }) + '\n',
    'utf8',
  );
  return path;
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runStop(
  tmp: string,
  cwd: string,
  sessionId: string,
  transcriptPath?: string,
): Promise<StopOut> {
  const input = JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: 'Stop',
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  });
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp },
    stdin: new TextEncoder().encode(input),
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

const CODE_FILE = '/repo/util.ts';

/** A passing review for util.ts: future-dated, covers performance dimension. */
function passingReview(): Record<string, unknown> {
  return {
    timestamp: new Date(Date.now() + 60000).toISOString(),
    reviewed_files: [resolve(CODE_FILE)],
    category: 'refactor',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: ['performance'],
  };
}

const COMPACT_MARKER = '/compact';

describe('Stop hook — auto-compact warning', () => {
  test('PASS path: context > 50% → compact warning appended to systemMessage', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    writeReview(cwd, passingReview());
    const transcript = writeTranscript(cwd, 120_000); // 60% of 200K
    const out = await runStop(tmp, cwd, sessionId, transcript);
    // Review passes (no block) and the compact warning rides along.
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toBeDefined();
    expect(out.systemMessage).toContain(COMPACT_MARKER);
    expect(out.systemMessage).toContain('60%');
  });

  test('BLOCK path: context > 50% → compact warning appears even while review BLOCKS', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    // No review file on disk → Stop blocks demanding a review.
    const transcript = writeTranscript(cwd, 150_000); // 75% of 200K
    const out = await runStop(tmp, cwd, sessionId, transcript);
    expect(out.decision).toBe('block');
    // Compact warning must be independent of the block decision.
    expect(out.systemMessage).toBeDefined();
    expect(out.systemMessage).toContain(COMPACT_MARKER);
    expect(out.systemMessage).toContain('75%');
  });

  test('context < 50% → NO compact warning (pass path stays clean)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    writeReview(cwd, passingReview());
    const transcript = writeTranscript(cwd, 80_000); // 40% of 200K
    const out = await runStop(tmp, cwd, sessionId, transcript);
    expect(out.decision).toBeUndefined();
    // Passing review with no other findings → no systemMessage at all here.
    expect(out.systemMessage ?? '').not.toContain(COMPACT_MARKER);
  });

  test('context < 50% → NO compact warning on a BLOCK path either', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    const transcript = writeTranscript(cwd, 90_000); // 45% of 200K
    const out = await runStop(tmp, cwd, sessionId, transcript);
    expect(out.decision).toBe('block');
    expect(out.systemMessage ?? '').not.toContain(COMPACT_MARKER);
  });

  test('no transcript_path / unmeasurable → no warning, review enforcement intact', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    // No transcript at all → measurement fails → silent pass-through (no warning).
    const out = await runStop(tmp, cwd, sessionId);
    // Existing review enforcement must still BLOCK (no review file present).
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('리뷰');
    expect(out.systemMessage ?? '').not.toContain(COMPACT_MARKER);
  });

  test('existing review enforcement unchanged when context is high (block reason intact)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    const transcript = writeTranscript(cwd, 180_000); // 90% — well over threshold
    const out = await runStop(tmp, cwd, sessionId, transcript);
    // The review-required block must still fire with its original reason...
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('리뷰가 필요합니다');
    // ...and the compact warning is additive, not a replacement.
    expect(out.systemMessage).toContain(COMPACT_MARKER);
  });
});
