import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

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
    // 층1 테스트 게이트는 리뷰/compact 게이트보다 앞서 발동해 이 파일의 전제를 가린다 → 끈다.
    // 층0 플러시 대기도 끈다 — 합성 transcript에는 답변 텍스트가 영영 나타나지 않아
    // 매 실행마다 대기 상한만큼 잡아먹는다(이 파일의 관심사가 아니다).
    env: {
      ...process.env,
      TMPDIR: tmp,
      HOME: tmp,
      GOODBOY_TEST_GATE: 'off',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      ...extraEnv,
    },
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

/** A passing review for util.ts: future-dated and checks every dimension. A code file needs
 *  performance + refactoring-quality + security-secrets, but requiredDimensionsFor() also
 *  matches tokens in the absolute path, so a random mkdtemp suffix (e.g. "url") can add
 *  more; this file tests the compact gate, not review coverage. */
function passingReview(cwd: string): Record<string, unknown> {
  return {
    timestamp: new Date(Date.now() + 60000).toISOString(),
    reviewed_files: [resolve(cwd, CODE_FILE)],
    category: 'refactor',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
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
    expect(out.reason ?? '').not.toContain('Review is required');
    expect(out.stopReason).toBe('compact_needed');
  });

  test('context < 50% → NO force; review enforcement intact (review-required block)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const transcript = writeTranscript(cwd, 80_000); // 40% — below force threshold
    const out = await runStop(tmp, cwd, sessionId, transcript);

    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review is required');
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
    // Counts the blocks that happened, like every other escape message (A9).
    expect(out3.systemMessage ?? '').toContain('2회 차단 후에도');
  });

  // A7: resetting on escape made an endless block/block/pass cycle; the escape now latches.
  test('escape latches for the session until usage drops below the threshold', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    writeReview(cwd, passingReview(cwd));
    const transcript = writeTranscript(cwd, 120_000); // 60%
    for (let i = 0; i < 3; i++) await runStop(tmp, cwd, sessionId, transcript); // block, block, escape

    const out4 = await runStop(tmp, cwd, sessionId, transcript);
    const out5 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out4.decision).toBeUndefined();
    expect(out4.stopReason).toBeUndefined();
    expect(out5.decision).toBeUndefined();
    // The latch must not silence the context warning (it only suppresses re-forcing).
    expect(out4.systemMessage ?? '').toContain('H1-01');

    // Usage drops (compaction happened) → latch clears → a new excess starts at 1/3.
    const low = writeTranscript(cwd, 12_000);
    expect((await runStop(tmp, cwd, sessionId, low)).decision).toBeUndefined();
    const again = await runStop(tmp, cwd, sessionId, writeTranscript(cwd, 120_000));
    expect(again.decision).toBe('block');
    expect(again.reason).toContain('1/3');
  });

  test('no transcript / unmeasurable → no force; review enforcement intact', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const out = await runStop(tmp, cwd, sessionId); // no transcript
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review is required');
    expect(out.stopReason).toBeUndefined();
  });

  // (v0.27.6) 압축 경계 직후 — 실측 오탐: /compact 후에도 압축 전 usage가 플러시 지연으로
  //   최신으로 읽혀 재차단됐다(pct=53 deny, 실제 6%). 경계 이후 usage가 없으면 강제 금지.
  test('compact 경계 직후(압축 후 usage 미플러시) → NO force + 카운터 리셋', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    writeReview(cwd, passingReview(cwd));
    // 1) 압축 전 60% → 강제 block(카운터 1).
    const transcript = writeTranscript(cwd, 120_000);
    const out1 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out1.decision).toBe('block');
    expect(out1.stopReason).toBe('compact_needed');

    // 2) 사용자가 /compact — 경계 마커가 기록되지만 압축 후 usage는 아직 플러시 전.
    const boundary =
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: '요약' } }) +
      '\n' +
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }) +
      '\n';
    writeFileSync(
      transcript,
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 120_000 } },
      }) +
        '\n' +
        boundary,
      'utf8',
    );
    // 수정 전에는 압축 전 120K(60%)가 그대로 읽혀 2/3 재차단됐다(실측 재현).
    const out2 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out2.stopReason).toBeUndefined();
    expect(out2.reason ?? '').not.toContain('강제');
    expect(out2.decision).toBeUndefined(); // passing review → clean pass

    // 3) 압축 후 usage가 플러시되면 압축 후 수치 기준으로 판정(6% → 강제 없음),
    //    카운터도 리셋됐으므로 이후 진짜 초과는 1/3부터 시작한다.
    writeFileSync(
      transcript,
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 120_000 } },
      }) +
        '\n' +
        boundary +
        JSON.stringify({
          message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 12_000 } },
        }) +
        '\n',
      'utf8',
    );
    const out3 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out3.decision).toBeUndefined();
    expect(out3.stopReason).toBeUndefined();

    // 4) 카운터 리셋 검증: 다시 초과하면 3회째(escape)가 아니라 1/3부터 차단.
    writeFileSync(
      transcript,
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 120_000 } },
      }) + '\n',
      'utf8',
    );
    const out4 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out4.decision).toBe('block');
    expect(out4.reason).toContain('1/3');
  });

  // (v0.27.6 변이 사살, 리뷰 medium) usage-null 카운터 리셋이 어느 테스트로도 고정되지
  //   않았다 — 기존 통합 시나리오는 null 다음에 임계 미만(6%) 단계가 있어 그 경로의
  //   기존 리셋이 변이를 가렸다. 여기서는 null 직후 곧바로 재초과시켜 구속한다.
  test('측정 불가(경계 직후)가 강제 카운터를 리셋한다 — 직후 재초과는 1/3부터', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    writeReview(cwd, passingReview(cwd));

    // 1) 60% → 강제 block(카운터 1).
    const transcript = writeTranscript(cwd, 120_000);
    const out1 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out1.decision).toBe('block');
    expect(out1.reason).toContain('1/3');

    // 2) 경계 직후(압축 후 usage 미플러시) → 측정 불가, 강제 없음 + 카운터 리셋.
    writeFileSync(
      transcript,
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 120_000 } },
      }) +
        '\n' +
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }) +
        '\n',
      'utf8',
    );
    const out2 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out2.stopReason).toBeUndefined();

    // 3) 곧바로 다시 초과 — 리셋이 없었다면(변이) 2/3로 이어졌을 것.
    writeFileSync(
      transcript,
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 120_000 } },
      }) + '\n',
      'utf8',
    );
    const out3 = await runStop(tmp, cwd, sessionId, transcript);
    expect(out3.decision).toBe('block');
    expect(out3.reason).toContain('1/3');
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
