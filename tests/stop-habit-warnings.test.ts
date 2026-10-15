import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// H1-03(강제 자동 compact) + H1-01(긴 세션 경고) 상호작용의 Stop hook 통합 테스트.
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

function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-stop-habit-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-stop-habit-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

function sessionDir(tmp: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed edits so recentEdits is non-empty (Stop reaches the warning + block/pass path). */
function seedSession(
  tmp: string,
  sessionId: string,
  turn: number,
  editFiles: string[],
  cwd = '/repo',
): void {
  const dir = sessionDir(tmp, sessionId);
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8'); // Stop increments first
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

function seedHabitState(tmp: string, sessionId: string, state: Record<string, unknown>): void {
  const dir = sessionDir(tmp, sessionId);
  writeFileSync(join(dir, 'habit-state.json'), JSON.stringify(state), 'utf8');
}

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
  stopReason?: string;
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
    // HOME도 격리: 실제 ~/.claude/settings.json(개발자 머신의 [1m] 모델 등)이
    // 컨텍스트 창 판별에 새어들어와 200K 기준 단정을 뒤집지 않게 한다.
    env: { ...process.env, TMPDIR: tmp, HOME: tmp },
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

// Track G: H1-03 is a notice for the user (only the user can compact), never a block.
describe('Stop hook — H1-03 compaction notice (>=50%)', () => {
  test('context >= 50% → /compact notice, with no block or stop signal of its own', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const t = writeTranscript(cwd, 120_000); // 60% → notice
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage ?? '').toContain('/compact');
    expect(out.systemMessage ?? '').toContain('H1-03');
    expect(out.stopReason).toBeUndefined();
    expect(out.reason ?? '').not.toContain('/compact'); // a block here is the review gate's
  });

  test('the notice suppresses the H1-01 long-session warning on the Stop where it fires', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    // 120k tokens = 60% (>= 50%) AND above token warn 50k → the notice wins, H1-01 suppressed.
    const t = writeTranscript(cwd, 120_000);
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage ?? '').toContain('/compact');
    expect(out.systemMessage ?? '').not.toContain('긴 세션'); // H1-01 suppressed

    // The next Stop is latched (no notice), so the H1-01 warning shows there.
    const next = await runStop(tmp, cwd, sessionId, t);
    expect(next.systemMessage ?? '').not.toContain('/compact');
    expect(next.systemMessage ?? '').toContain('긴 세션');
  });
});

describe('Stop hook — H1-01 long-session warning', () => {
  test('token-based: tokens over GOODBOY_TOKEN_WARN but below force % → long-session warning, no force', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    // 60k tokens = 30% (below 50% force) but above default token warn 50k.
    const t = writeTranscript(cwd, 60_000);
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage).toContain('긴 세션');
    expect(out.systemMessage).toContain('H1-01');
    expect(out.stopReason).toBeUndefined();
    expect(out.reason ?? '').not.toContain('강제');
  });

  test('time-based: old sessionStartTs → long-session warning', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const old = new Date(Date.now() - 60 * 60000).toISOString(); // 60 min ago
    seedHabitState(tmp, sessionId, { sessionStartTs: old });
    const t = writeTranscript(cwd, 10_000); // 5% — nothing else triggers
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage).toContain('긴 세션');
    expect(out.stopReason).toBeUndefined();
  });

  test('fail-open: no transcript → no habit warnings (review enforcement intact)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block'); // review still required
    expect(out.systemMessage ?? '').not.toContain('긴 세션');
    expect(out.stopReason).toBeUndefined();
  });
});

// (v0.27.8) 실사용 버그 리포트: Opus 1M 세션에서 절대 임계 50K가 점유 5% 시점에
//   "긴 세션"을 오판 + 한도 교정(53%→11%) 후에도 경고 래치가 리셋되지 않았다.
describe('Stop hook — H1-01 한도 비례 임계 + 래치 해제 (v0.27.8)', () => {
  /** 1M 확정 모델(fable)의 transcript — 한도 비례 임계(25% = 250K) 검증용. */
  function write1mTranscript(cwd: string, tokens: number): string {
    const path = join(cwd, 'transcript.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ message: { model: 'claude-fable-5', usage: { input_tokens: tokens } } }) +
        '\n',
      'utf8',
    );
    return path;
  }

  const habitStatePath = (tmp: string, sessionId: string): string =>
    join(sessionDir(tmp, sessionId), 'habit-state.json');

  test('1M 세션 111K 토큰(11%)은 "긴 세션"이 아니다 — 임계가 한도의 25%(250K)로 확장', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    // 구버전(절대 50K)이라면 111K > 50K로 경고가 떴다(실사용 리포트 재현).
    const t = write1mTranscript(cwd, 111_234);
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage ?? '').not.toContain('긴 세션');
    expect(out.stopReason).toBeUndefined();
  });

  test('1M 세션도 임계(250K) 초과면 "긴 세션" 경고 — 게이트 자체는 유지', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    const t = write1mTranscript(cwd, 300_000); // 30% — 강제(50%) 미만, 임계(250K) 초과
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage).toContain('긴 세션');
  });

  test('오탐 래치 해제: 조건이 해소되면 longSessionWarned가 리셋된다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    // 한도 오판 구간에서 이미 경고가 래치된 상태를 심는다(리포트의 habit-state 실측 재현).
    seedHabitState(tmp, sessionId, {
      sessionStartTs: new Date().toISOString(),
      longSessionWarned: true,
      lastCtxWarnPct: 53,
    });
    const t = write1mTranscript(cwd, 111_234); // 11% — 시간/토큰 조건 모두 미달
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage ?? '').not.toContain('긴 세션');
    const state = JSON.parse(readFileSync(habitStatePath(tmp, sessionId), 'utf8')) as {
      longSessionWarned?: boolean;
      lastCtxWarnPct?: number;
    };
    expect(state.longSessionWarned).toBe(false); // 래치 해제 — 이후 진짜 긴 세션은 다시 경고
    // 성장 경고 기준도 실제 점유율로 하향 재설정(53 고정이면 63%까지 침묵했다).
    expect(state.lastCtxWarnPct).toBe(11);
  });

  test('기준 하향 후 실제 성장(30%)은 다시 경고된다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE], cwd);
    seedHabitState(tmp, sessionId, {
      sessionStartTs: new Date().toISOString(),
      lastCtxWarnPct: 53,
    });
    // 1) 11%로 하향 재설정.
    await runStop(tmp, cwd, sessionId, write1mTranscript(cwd, 111_234));
    // 2) 30%로 성장 → 시작 임계(30) 이상 + 기준(11)+10 이상 → 컨텍스트 경고.
    //    구버전(단조 증가 고정)이라면 53+10=63%까지 침묵했다.
    const out = await runStop(tmp, cwd, sessionId, write1mTranscript(cwd, 300_000));
    expect(out.systemMessage).toContain('컨텍스트 사용률이 30%');
  });
});
