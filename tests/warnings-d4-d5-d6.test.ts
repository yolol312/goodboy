// D4(컨텍스트 성장 반복 경고) / D5=H4-03(모델 전환 감지) / D6=H2-04(웹 재페치 경고) 테스트.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const POST_HOOK = resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-warn-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-warn-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** usage 줄들(모델/토큰 배열)로 transcript 작성. */
function writeTranscript(cwd: string, entries: Array<{ model: string; tokens: number }>): string {
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(
    path,
    entries
      .map((e) =>
        JSON.stringify({ message: { model: e.model, usage: { input_tokens: e.tokens } } }),
      )
      .join('\n') + '\n',
    'utf8',
  );
  return path;
}

interface HookOut {
  decision?: string;
  systemMessage?: string;
  hookSpecificOutput?: { additionalContext?: string };
}

async function runHook(
  hookPath: string,
  tmp: string,
  cwd: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<HookOut> {
  const proc = Bun.spawn(['bun', hookPath], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, ...extraEnv },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as HookOut;
  } catch {
    return {};
  }
}

const STD_MODEL = 'claude-3-5-sonnet-20241022'; // 확정 200K

async function runStop(
  tmp: string,
  cwd: string,
  sessionId: string,
  transcript: string,
): Promise<HookOut> {
  return runHook(STOP_HOOK, tmp, cwd, {
    session_id: sessionId,
    cwd,
    hook_event_name: 'Stop',
    transcript_path: transcript,
  });
}

describe('D4 — 컨텍스트 성장 반복 경고', () => {
  test('30% 도달 시 경고, 같은 수준 반복 시 억제, +10%p 상승 시 재경고', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    // 32% (64K/200K)
    const t1 = writeTranscript(cwd, [{ model: STD_MODEL, tokens: 64_000 }]);
    const r1 = await runStop(tmp, cwd, sessionId, t1);
    expect(r1.systemMessage ?? '').toContain('컨텍스트 사용률이 32%');

    // 같은 수준(33%) → 억제 (32 + 10 미만)
    const t2 = writeTranscript(cwd, [{ model: STD_MODEL, tokens: 66_000 }]);
    const r2 = await runStop(tmp, cwd, sessionId, t2);
    expect(r2.systemMessage ?? '').not.toContain('컨텍스트 사용률');

    // 44% (+12%p) → 재경고
    const t3 = writeTranscript(cwd, [{ model: STD_MODEL, tokens: 88_000 }]);
    const r3 = await runStop(tmp, cwd, sessionId, t3);
    expect(r3.systemMessage ?? '').toContain('컨텍스트 사용률이 44%');
  });

  test('시작 임계(기본 30%) 미만이면 경고 없음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const t = writeTranscript(cwd, [{ model: STD_MODEL, tokens: 20_000 }]); // 10%
    const r = await runStop(tmp, cwd, sessionId, t);
    expect(r.systemMessage ?? '').not.toContain('컨텍스트 사용률');
  });
});

describe('D5 (H4-03) — 세션 내 모델 전환 감지', () => {
  test('usage 줄에 상이한 모델 2개 → 세션당 1회 경고', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const t = writeTranscript(cwd, [
      { model: STD_MODEL, tokens: 10_000 },
      { model: 'claude-haiku-4-5-20251001', tokens: 12_000 },
    ]);
    const r1 = await runStop(tmp, cwd, sessionId, t);
    expect(r1.systemMessage ?? '').toContain('H4-03');
    expect(r1.systemMessage ?? '').toContain('모델 전환');
    // 2회째는 억제.
    const r2 = await runStop(tmp, cwd, sessionId, t);
    expect(r2.systemMessage ?? '').not.toContain('H4-03');
  });

  test('단일 모델 세션 → 경고 없음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const t = writeTranscript(cwd, [
      { model: STD_MODEL, tokens: 10_000 },
      { model: STD_MODEL, tokens: 12_000 },
    ]);
    const r = await runStop(tmp, cwd, sessionId, t);
    expect(r.systemMessage ?? '').not.toContain('H4-03');
  });

  test('서브에이전트 모델(usage 줄 아님, resolvedModel만)은 오탐하지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const path = join(cwd, 'transcript.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ message: { model: STD_MODEL, usage: { input_tokens: 10_000 } } }),
        // Task 결과에 남는 서브에이전트 모델 — usage 줄이 아니므로 전환으로 보지 않는다.
        JSON.stringify({ toolUseResult: { resolvedModel: 'claude-haiku-4-5-20251001' } }),
        JSON.stringify({ message: { model: STD_MODEL, usage: { input_tokens: 12_000 } } }),
      ].join('\n') + '\n',
      'utf8',
    );
    const r = await runStop(tmp, cwd, sessionId, path);
    expect(r.systemMessage ?? '').not.toContain('H4-03');
  });
});

describe('D6 (H2-04) — 동일 URL 재페치 경고', () => {
  async function fetchUrl(
    tmp: string,
    cwd: string,
    sessionId: string,
    url: string,
    agentId?: string,
  ): Promise<HookOut> {
    return runHook(POST_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'WebFetch',
      tool_input: { url },
      ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
    });
  }

  test('첫 페치는 경고 없음, 같은 URL 재페치는 경고', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const first = await fetchUrl(tmp, cwd, sessionId, 'https://example.com/docs');
    expect(first.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-04');
    const second = await fetchUrl(tmp, cwd, sessionId, 'https://example.com/docs');
    expect(second.hookSpecificOutput?.additionalContext ?? '').toContain('H2-04');
  });

  test('fragment/후행 슬래시 차이는 같은 URL로 본다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    await fetchUrl(tmp, cwd, sessionId, 'https://example.com/docs/');
    const second = await fetchUrl(tmp, cwd, sessionId, 'https://example.com/docs#section');
    expect(second.hookSpecificOutput?.additionalContext ?? '').toContain('H2-04');
  });

  test('다른 에이전트의 재페치도 잡는다 (세션 스코프)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    await fetchUrl(tmp, cwd, sessionId, 'https://example.com/docs'); // 메인
    const sub = await fetchUrl(tmp, cwd, sessionId, 'https://example.com/docs', 'agent-7');
    expect(sub.hookSpecificOutput?.additionalContext ?? '').toContain('H2-04');
  });

  test('다른 URL은 경고 없음 + off 토글', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    await fetchUrl(tmp, cwd, sessionId, 'https://example.com/a');
    const other = await fetchUrl(tmp, cwd, sessionId, 'https://example.com/b');
    expect(other.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-04');

    const offOut = await runHook(
      POST_HOOK,
      tmp,
      cwd,
      {
        session_id: sessionId,
        cwd,
        hook_event_name: 'PostToolUse',
        tool_name: 'WebFetch',
        tool_input: { url: 'https://example.com/a' },
      },
      { GOODBOY_WEBFETCH_REFETCH_WARN: 'off' },
    );
    expect(offOut.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-04');
  });
});
