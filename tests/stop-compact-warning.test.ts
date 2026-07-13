import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// H1-03 강제 자동 compact(force >= GOODBOY_COMPACT_FORCE_PCT, 기본 50%)의 Stop hook 통합 테스트.
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-stop-compact-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-stop-compact-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** Seed file-tracker session state (mirrors file-tracker.ts layout). */
function seedSession(
  tmp: string,
  sessionId: string,
  turn: number,
  editFiles: string[],
  cwd = '/repo',
): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  // Stop increments turn first, so write turn-1 so it lands on `turn` after increment.
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles
    .map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts }))
    .join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
  // (A) 리뷰 스코프는 실존 파일만 대상 — 편집 대상 파일을 실제로 만든다.
  for (const f of editFiles) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
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

/** Write a transcript whose most-recent usage occupies `tokens` against a given model id. */
function writeTranscriptWithModel(cwd: string, tokens: number, model: string): string {
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(
    path,
    JSON.stringify({ message: { model, usage: { input_tokens: tokens } } }) + '\n',
    'utf8',
  );
  return path;
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  stopReason?: string;
  additionalContext?: string;
}

async function runStop(
  tmp: string,
  cwd: string,
  sessionId: string,
  transcriptPath?: string,
  extraEnv: Record<string, string> = {},
): Promise<StopOut> {
  const input = JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: 'Stop',
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  });
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    // HOME도 격리: 실제 ~/.claude/settings.json(개발자 머신의 [1m] 모델 등)이
    // 컨텍스트 창 판별에 새어들어와 200K 기준 단정을 뒤집지 않게 한다.
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, ...extraEnv },
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

const CODE_FILE = 'util.ts';
const COMPACT_MARKER = '/compact';

/** A passing review for util.ts: future-dated, covers performance dimension. */
function passingReview(cwd: string): Record<string, unknown> {
  return {
    timestamp: new Date(Date.now() + 60000).toISOString(),
    reviewed_files: [resolve(cwd, CODE_FILE)],
    category: 'refactor',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: ['performance'],
  };
}

describe('Stop hook — H1-03 forced auto-compact (>=50%)', () => {
  test('context >= 50% → force BLOCK with auto-compact signal (stopReason + additionalContext)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    // Even with a passing review on disk, force takes precedence.
    writeReview(cwd, passingReview(cwd));
    const transcript = writeTranscript(cwd, 120_000); // 60% of 200K
    const out = await runStop(tmp, cwd, sessionId, transcript);

    expect(out.decision).toBe('block');
    expect(out.reason).toContain('강제');
    expect(out.reason).toContain('60%');
    expect(out.reason).toContain(COMPACT_MARKER);
    // context-watchdog.sh와 동일한 자동 compact 유도 신호.
    expect(out.stopReason).toBe('compact_needed');
    expect(out.additionalContext).toBeDefined();
    expect(out.additionalContext).toContain('60%');
  });

  test('force takes precedence over review-required block', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    // No review file → normally review-required block. But context >= 50% forces compact first.
    const transcript = writeTranscript(cwd, 130_000); // 65%
    const out = await runStop(tmp, cwd, sessionId, transcript);

    expect(out.decision).toBe('block');
    expect(out.reason).toContain('강제'); // compact-force reason, NOT the review reason
    expect(out.reason ?? '').not.toContain('리뷰가 필요합니다');
    expect(out.stopReason).toBe('compact_needed');
  });

  test('context < 50% → NO force; review enforcement intact (review-required block)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const transcript = writeTranscript(cwd, 80_000); // 40% — below force threshold
    const out = await runStop(tmp, cwd, sessionId, transcript);

    expect(out.decision).toBe('block');
    expect(out.reason).toContain('리뷰가 필요합니다');
    expect(out.stopReason).toBeUndefined();
    expect(out.additionalContext).toBeUndefined();
  });

  test('context < 50% + passing review → clean pass (no force fields)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    writeReview(cwd, passingReview(cwd));
    const transcript = writeTranscript(cwd, 80_000); // 40%
    const out = await runStop(tmp, cwd, sessionId, transcript);

    expect(out.decision).toBeUndefined();
    expect(out.stopReason).toBeUndefined();
    expect(out.reason).toBeUndefined();
  });

  test('MAX_RETRIES escape: repeated force eventually passes with a warning (no infinite block)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    writeReview(cwd, passingReview(cwd)); // so the escaped turn can actually pass review
    const transcript = writeTranscript(cwd, 120_000); // 60% — always over threshold

    const out1 = await runStop(tmp, cwd, sessionId, transcript);
    const out2 = await runStop(tmp, cwd, sessionId, transcript);
    const out3 = await runStop(tmp, cwd, sessionId, transcript);

    // First two genuine stops: forced block.
    expect(out1.decision).toBe('block');
    expect(out1.stopReason).toBe('compact_needed');
    expect(out2.decision).toBe('block');
    // Third: MAX_RETRIES(3) escape → not force-blocked; passes with an escape warning.
    expect(out3.decision).toBeUndefined();
    expect(out3.stopReason).toBeUndefined();
    expect(out3.systemMessage ?? '').toContain('H1-03 강제');
    expect(out3.systemMessage ?? '').toContain('3회');
  });

  test('no transcript / unmeasurable → no force; review enforcement intact', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const out = await runStop(tmp, cwd, sessionId); // no transcript
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('리뷰');
    expect(out.stopReason).toBeUndefined();
  });

  // (3-A) 1M 지원 세대(opus-4-8)인데 [1m] 표식이 없으면 200K/1M 구분 불가 → 강제 보류.
  test('ambiguous 1M-capable model without marker (opus-4-8) → NO force', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    writeReview(cwd, passingReview(cwd)); // 강제가 없으면 passing review로 clean pass 되어야 함
    // 150K tokens: 200K 가정 시 75%(강제 대상)이지만, opus-4-8은 1M일 수 있어 미확정 → 강제 안 함.
    const transcript = writeTranscriptWithModel(cwd, 150_000, 'claude-opus-4-8');
    const out = await runStop(tmp, cwd, sessionId, transcript);
    expect(out.stopReason).toBeUndefined();
    expect(out.decision).toBeUndefined(); // 강제도, 리뷰 block도 아님(passing review)
    expect(out.reason ?? '').not.toContain('강제');
  });

  // (3-A) 같은 모호 모델이라도 GOODBOY_CONTEXT_LIMIT으로 한도를 명시하면 강제가 복구된다.
  test('ambiguous model but GOODBOY_CONTEXT_LIMIT set → force applies', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    writeReview(cwd, passingReview(cwd));
    const transcript = writeTranscriptWithModel(cwd, 150_000, 'claude-opus-4-8');
    const out = await runStop(tmp, cwd, sessionId, transcript, { GOODBOY_CONTEXT_LIMIT: '200000' });
    // 200K로 확정 → 75% → 강제 block.
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('강제');
    expect(out.stopReason).toBe('compact_needed');
  });
});
