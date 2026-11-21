// H2-01 보강 2종 테스트:
//   (1) epoch 리셋 — 컨텍스트 점유율 급락(=압축)을 감지하면 read 기록을 비운다.
//   (2) 위임 재독 주의 — 메인이 읽은 파일 경로가 위임 프롬프트에 있으면 비차단 경고.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // The user's own env must not decide the context limit or the drop threshold of the run.
  const env: Record<string, string | undefined> = {
    ...process.env,
    TMPDIR: tmp,
    HOME: tmp,
    GOODBOY_REGISTRY_DIR: join(tmp, 'registry'),
  };
  delete env.GOODBOY_CONTEXT_LIMIT;
  delete env.GOODBOY_COMPACT_DETECT_DROP_PCT;
  const proc = Bun.spawn(['bun', hookPath], {
    cwd,
    env,
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

function writeTranscript(cwd: string, tokens: number, model: string = STD_MODEL): string {
  const path = join(cwd, 't.jsonl');
  writeFileSync(
    path,
    JSON.stringify({ message: { model, usage: { input_tokens: tokens } } }) + '\n',
    'utf8',
  );
  return path;
}

// A model id with no 1M marker and not a known 200K one: the limit estimate is 200k until the tokens pass it, then 1M.
const UNMARKED_MODEL = 'claude-opus-5-5';

function seedReads(dir: string): void {
  writeFileSync(
    join(dir, 'reads.jsonl'),
    JSON.stringify({ file: '/repo/a.ts', turn: 1, timestamp: new Date().toISOString() }) + '\n',
    'utf8',
  );
}

function stopInput(sessionId: string, cwd: string, transcript: string): Record<string, unknown> {
  return { session_id: sessionId, cwd, hook_event_name: 'Stop', transcript_path: transcript };
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
    writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxTokens: 120_000 }), 'utf8'); // 60 % of 200k
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
    writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxTokens: 60_000 }), 'utf8'); // 30 % of 200k
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
    writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxTokens: 120_000 }), 'utf8');
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

  // v0.37.2: the drop is judged in tokens. For a model id with no 1M marker the limit estimate is 200k until the tokens
  // pass it and 1M after, so the percent fell from 96.7 to 20.2 with no compaction and cleared the reads.
  // Both fields are seeded so the pre-change code (which reads lastCtxPercent) sees its own field.
  test('the limit estimate moving from 200k to 1M (96.7% → 20.2%) is no compaction: reads kept', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = sessionDir(tmp, sessionId);
    seedReads(dir);
    writeFileSync(
      join(dir, 'habit-state.json'),
      JSON.stringify({ lastCtxTokens: 193_331, lastCtxPercent: 96.7 }),
      'utf8',
    );
    const t = writeTranscript(cwd, 202_288, UNMARKED_MODEL);
    await runHook(STOP_HOOK, tmp, cwd, stopInput(sessionId, cwd, t));
    expect(existsSync(join(dir, 'reads.jsonl'))).toBe(true);
    const st = JSON.parse(readFileSync(join(dir, 'habit-state.json'), 'utf8')) as Record<string, unknown>;
    expect(st.lastCtxTokens).toBe(202_288);
  });

  test('a compaction after which the estimate falls back to 200k (250k → 40k tokens) clears the reads', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = sessionDir(tmp, sessionId);
    seedReads(dir);
    // old field: 250k tokens read as 25 % of a 1M limit; 40k tokens is 20 % of 200k, a drop of 5 points only
    writeFileSync(
      join(dir, 'habit-state.json'),
      JSON.stringify({ lastCtxTokens: 250_000, lastCtxPercent: 25 }),
      'utf8',
    );
    const t = writeTranscript(cwd, 40_000, UNMARKED_MODEL);
    await runHook(STOP_HOOK, tmp, cwd, stopInput(sessionId, cwd, t));
    expect(existsSync(join(dir, 'reads.jsonl'))).toBe(false);
  });

  test('the threshold is a share of the current limit: 100k fewer tokens on a 1M window (10%) keeps the reads, 160k (16%) clears them', async () => {
    for (const [now, cleared] of [[400_000, false], [340_000, true]] as const) {
      const { tmp, cwd, sessionId } = newSandbox();
      const dir = sessionDir(tmp, sessionId);
      seedReads(dir);
      writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxTokens: 500_000 }), 'utf8');
      const t = writeTranscript(cwd, now, UNMARKED_MODEL); // above 200k: the estimate is 1M
      await runHook(STOP_HOOK, tmp, cwd, stopInput(sessionId, cwd, t));
      expect([now, existsSync(join(dir, 'reads.jsonl')) === false]).toEqual([now, cleared]);
    }
  });

  test('the next habit state holds lastCtxTokens and no lastCtxPercent', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const dir = sessionDir(tmp, sessionId);
    const t = writeTranscript(cwd, 80_000);
    await runHook(STOP_HOOK, tmp, cwd, stopInput(sessionId, cwd, t));
    const st = JSON.parse(readFileSync(join(dir, 'habit-state.json'), 'utf8')) as Record<string, unknown>;
    expect(st.lastCtxTokens).toBe(80_000);
    expect('lastCtxPercent' in st).toBe(false);
  });

  test('a drop of exactly the threshold (15% of the limit) keeps the reads; one token more clears them', async () => {
    for (const [seeded, cleared] of [[110_000, false], [110_001, true]] as const) {
      const { tmp, cwd, sessionId } = newSandbox();
      const dir = sessionDir(tmp, sessionId);
      seedReads(dir);
      writeFileSync(join(dir, 'habit-state.json'), JSON.stringify({ lastCtxTokens: seeded }), 'utf8');
      const t = writeTranscript(cwd, 80_000); // 200k limit: threshold 30_000 tokens
      await runHook(STOP_HOOK, tmp, cwd, stopInput(sessionId, cwd, t));
      expect([seeded, existsSync(join(dir, 'reads.jsonl')) === false]).toEqual([seeded, cleared]);
    }
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
