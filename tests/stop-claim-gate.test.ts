// Stop hook — 층0 인용 검증 게이트 (B5.5) 통합 테스트.
//
// 이 게이트의 존재 이유는 하나다: 다른 모든 게이트는 **편집이 있을 때만** 발동하므로,
// 코드베이스를 설명만 하는 답변 턴은 통째로 무검증이었다. 그래서 여기 테스트의 핵심은
// "편집이 하나도 없는데도 발동하는가"이다.

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

function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-cg-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-cg-cwd-'));
  tmpDirs.push(cwd);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'a\nb\nc\nd\ne\n', 'utf8'); // 5줄
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** 편집 기록 없이 턴만 세팅 — "답변만 한 턴"을 재현한다. */
function seedTurnOnly(tmp: string, sessionId: string, turn: number): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  return dir;
}

/** 읽기 기록을 심는다. 없으면 C3(읽은 기록 없음) 판정이 통째로 생략된다. */
function seedRead(sessionDir: string, absFile: string, turn: number): void {
  writeFileSync(
    join(sessionDir, 'reads.jsonl'),
    JSON.stringify({ file: absFile, turn, timestamp: new Date().toISOString() }) + '\n',
    'utf8',
  );
}

/** 마지막 assistant 메시지가 주어진 텍스트인 transcript.
 *  사용자 프롬프트 줄을 반드시 앞에 둔다 — 게이트는 "이번 턴 답변"만 판정하므로,
 *  프롬프트가 없으면 판정 대상을 특정할 수 없어(freshness=unknown) 건너뛴다. */
function writeTranscript(cwd: string, text: string, userText = '설명해줘'): string {
  const path = join(cwd, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: userText } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }),
    // usage 줄(확정 200K 모델, 저점유) — 컨텍스트 게이트가 간섭하지 않게.
    JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
  ];
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
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
  extraEnv: Record<string, string> = {},
): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, ...extraEnv },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'Stop',
        ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
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

describe('Stop hook — 층0 인용 검증 게이트', () => {
  test('편집이 하나도 없는 답변 턴에서도 없는 파일 인용을 차단한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = writeTranscript(cwd, 'src/nope.ts:42 에서 처리합니다.');

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/nope.ts:42');
    expect(out.reason).toContain('그런 파일이 없습니다');
  });

  test('줄 범위를 넘는 인용을 차단한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = seedTurnOnly(tmp, sessionId, 3);
    seedRead(dir, resolve(cwd, 'src/a.ts'), 3);
    const tp = writeTranscript(cwd, '`src/a.ts:999` 를 보세요.');

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('5줄까지');
  });

  test('유효한 인용 + 읽은 기록이 있으면 통과한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = seedTurnOnly(tmp, sessionId, 3);
    seedRead(dir, resolve(cwd, 'src/a.ts'), 3);
    const tp = writeTranscript(cwd, 'src/a.ts:3 에 있습니다.');

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
  });

  test('읽은 기록이 없으면 차단한다 (근거 미확인)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = seedTurnOnly(tmp, sessionId, 3);
    // 다른 파일만 읽은 기록 → 추적은 가능하지만 인용한 파일은 안 읽음
    writeFileSync(join(cwd, 'other.ts'), 'x\n', 'utf8');
    seedRead(dir, resolve(cwd, 'other.ts'), 3);
    const tp = writeTranscript(cwd, 'src/a.ts:3 에 있습니다.');

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('읽은 기록이 없습니다');
  });

  test('읽기 기록이 통째로 없으면 C3를 생략한다 (압축 직후 오차단 방지)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3); // reads.jsonl 없음
    const tp = writeTranscript(cwd, 'src/a.ts:3 에 있습니다.');

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
  });

  test('줄 번호 없는 언급은 발동하지 않는다 (오탐 방지)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = writeTranscript(cwd, '`src/nope.ts` 파일을 새로 만들면 됩니다.');

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
  });

  test('transcript가 없으면 생략한다 (fail-open)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('GOODBOY_CLAIM_GATE=off 면 발동하지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = writeTranscript(cwd, 'src/nope.ts:42 에서 처리합니다.');

    const out = await runStop(tmp, cwd, sessionId, tp, { GOODBOY_CLAIM_GATE: 'off' });
    expect(out.decision).toBeUndefined();
  });

  test('MAX_RETRIES escape: 3회째는 통과 + 사용자 알림 (영구 차단 방지)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = writeTranscript(cwd, 'src/nope.ts:42 에서 처리합니다.');

    expect((await runStop(tmp, cwd, sessionId, tp)).decision).toBe('block');
    expect((await runStop(tmp, cwd, sessionId, tp)).decision).toBe('block');
    const third = await runStop(tmp, cwd, sessionId, tp);
    expect(third.decision).toBeUndefined();
    expect(third.systemMessage ?? '').toContain('인용 검증이');
  });

  test('stop_hook_active 경로에서는 차단하지 않고 경고만 남긴다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = writeTranscript(cwd, 'src/nope.ts:42 에서 처리합니다.');

    const proc = Bun.spawn(['bun', STOP_HOOK], {
      cwd,
      env: { ...process.env, TMPDIR: tmp, HOME: tmp },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          hook_event_name: 'Stop',
          stop_hook_active: true,
          transcript_path: tp,
        }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as StopOut;
    await proc.exited;
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('정정 후에도');
  });

  // P9 실측 결함: 하니스는 Stop 훅의 차단 사유를 *user* 엔트리로 되먹인다. 그 사유에는
  // 문제의 인용이 그대로 들어 있어서, `excludeUserOriginated`가 "사용자가 먼저 쓴 인용"
  // 으로 오인했다 → 첫 차단 이후 **같은 환각이 영구 면역**됐다(정정 후에도 3건 남았는데
  // 재판정 0건). 훅 발화는 사용자 발화로 세지 않아야 한다.
  test('훅 자신의 차단 피드백은 사용자 발화로 세지 않는다 (자기 면역 방지)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = join(cwd, 'transcript.jsonl');
    writeFileSync(
      tp,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '어디서 처리해?' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'src/nope.ts:42 입니다.' }] },
        }),
        // 훅이 되먹인 차단 사유 — 같은 인용이 그대로 들어 있다.
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content:
              'Stop hook feedback: 답변에서 실재하지 않는 위치를 인용했습니다:\n  - src/nope.ts:42 — 그런 파일이 없습니다.',
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '다시 봐도 src/nope.ts:42 입니다.' }],
          },
        }),
        JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
      ].join('\n') + '\n',
      'utf8',
    );

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/nope.ts:42');
  });

  test('사용자가 먼저 쓴 인용은 여전히 제외한다 (정직한 답변을 벌하지 않는다)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = writeTranscript(
      cwd,
      '말씀하신 src/nope.ts:42 는 존재하지 않습니다.',
      'src/nope.ts:42 이 뭐하는 코드야?',
    );

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
  });

  test('차단 사유는 출처(로컬 훅)를 밝힌다 — 프롬프트 인젝션 오인 방지', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedTurnOnly(tmp, sessionId, 3);
    const tp = writeTranscript(cwd, 'src/nope.ts:42 에서 처리합니다.');

    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('[goodboy 훅]');
    expect(out.reason).toContain('로컬 검증 훅');
  });
});
