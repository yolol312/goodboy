// H2-01 보강 2종 테스트:
//   (1) epoch 리셋 — 컨텍스트 점유율 급락(=압축)을 감지하면 read 기록을 비운다.
//   (2) 위임 재독 주의 — 메인이 읽은 파일 경로가 위임 프롬프트에 있으면 비차단 경고.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const PRE_HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-epoch-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-epoch-cwd-'));
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

async function runHook(
  hookPath: string,
  tmp: string,
  cwd: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(['bun', hookPath], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const STD_MODEL = 'claude-3-5-sonnet-20241022'; // 확정 200K

function writeTranscript(cwd: string, tokens: number): string {
  const path = join(cwd, 't.jsonl');
  writeFileSync(
    path,
    JSON.stringify({ message: { model: STD_MODEL, usage: { input_tokens: tokens } } }) + '\n',
    'utf8',
  );
  return path;
}

describe('H2-01 epoch 리셋 — 압축 감지 시 read 기록 초기화', () => {
  test('점유율 급락(60%→30%) → reads.jsonl 삭제', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = sessionDir(tmp, sessionId);
    writeFileSync(
      join(dir, 'reads.jsonl'),
      JSON.stringify({ file: '/repo/a.ts', turn: 1, timestamp: new Date().toISOString() }) + '\n',
      'utf8',
    );
    writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxPercent: 60 }), 'utf8');
    const t = writeTranscript(cwd, 60_000); // 30% — 직전 60%에서 급락 = 압축
    await runHook(STOP_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'Stop',
      transcript_path: t,
    });
    expect(existsSync(join(dir, 'reads.jsonl'))).toBe(false);
  });

  test('점유율 상승(30%→40%, 정상 성장) → 기록 유지', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = sessionDir(tmp, sessionId);
    writeFileSync(
      join(dir, 'reads.jsonl'),
      JSON.stringify({ file: '/repo/a.ts', turn: 1, timestamp: new Date().toISOString() }) + '\n',
      'utf8',
    );
    writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxPercent: 30 }), 'utf8');
    const t = writeTranscript(cwd, 80_000); // 40%
    await runHook(STOP_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'Stop',
      transcript_path: t,
    });
    expect(existsSync(join(dir, 'reads.jsonl'))).toBe(true);
  });

  test('edits.jsonl은 압축 감지에도 지우지 않는다 (리뷰 스코프 보존)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = sessionDir(tmp, sessionId);
    writeFileSync(
      join(dir, 'reads.jsonl'),
      JSON.stringify({ file: '/repo/a.ts', turn: 1, timestamp: new Date().toISOString() }) + '\n',
      'utf8',
    );
    // edits는 리뷰 대상이 되지 않게 README.md(차원 0개)로.
    writeFileSync(
      join(dir, 'edits.jsonl'),
      JSON.stringify({ file: '/repo/README.md', turn: 1, timestamp: new Date().toISOString() }) +
        '\n',
      'utf8',
    );
    writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxPercent: 60 }), 'utf8');
    const t = writeTranscript(cwd, 60_000);
    await runHook(STOP_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'Stop',
      transcript_path: t,
    });
    expect(existsSync(join(dir, 'reads.jsonl'))).toBe(false);
    expect(existsSync(join(dir, 'edits.jsonl'))).toBe(true);
  });
});

describe('위임 재독 주의 (비차단)', () => {
  function seedMainRead(tmp: string, sessionId: string, absFile: string): void {
    const dir = sessionDir(tmp, sessionId);
    writeFileSync(join(dir, 'turn.txt'), '2', 'utf8');
    writeFileSync(
      join(dir, 'reads.jsonl'),
      JSON.stringify({ file: absFile, turn: 1, timestamp: new Date().toISOString() }) + '\n',
      'utf8',
    );
  }

  async function runAgentCall(
    tmp: string,
    cwd: string,
    sessionId: string,
    prompt: string,
    extraEnv: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const proc = Bun.spawn(['bun', PRE_HOOK], {
      cwd,
      env: { ...process.env, TMPDIR: tmp, ...extraEnv },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          tool_name: 'Agent',
          tool_input: { prompt },
        }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(stdout || '{}') as Record<string, unknown>;
  }

  test('메인이 읽은 파일 경로가 위임 프롬프트에 있으면 경고 (허용 + additionalContext)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMainRead(tmp, sessionId, resolve(cwd, 'lib/foo.ts'));
    const out = await runAgentCall(tmp, cwd, sessionId, 'lib/foo.ts 를 분석해서 보고해줘');
    const hso = out.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(hso?.permissionDecision).toBeUndefined(); // 차단 아님
    expect(String(hso?.additionalContext ?? '')).toContain('위임 재독 주의');
    expect(String(hso?.additionalContext ?? '')).toContain('lib/foo.ts');
  });

  test('읽은 적 없는 경로면 경고 없음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMainRead(tmp, sessionId, resolve(cwd, 'lib/foo.ts'));
    const out = await runAgentCall(tmp, cwd, sessionId, 'src/other.ts 를 분석해줘');
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  test('경로가 아예 없는 위임(탐색 위임 등)은 경고 없음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMainRead(tmp, sessionId, resolve(cwd, 'lib/foo.ts'));
    const out = await runAgentCall(tmp, cwd, sessionId, '인증 관련 코드를 넓게 탐색해줘');
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  test('GOODBOY_DELEGATED_REREAD_WARN=off로 끌 수 있다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMainRead(tmp, sessionId, resolve(cwd, 'lib/foo.ts'));
    const out = await runAgentCall(tmp, cwd, sessionId, 'lib/foo.ts 를 분석해줘', {
      GOODBOY_DELEGATED_REREAD_WARN: 'off',
    });
    expect(out.hookSpecificOutput).toBeUndefined();
  });
});
