// (E1) 게이트 발동 로그 + 상태 스냅샷 + canary 테스트.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PRE_HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-gatelog-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-gatelog-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

function sessionDir(tmp: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return join(tmp, `goodboy-session-${safe}`);
}

interface GateEvent {
  ts: string;
  gate: string;
  decision: string;
  reason?: string;
}

function readLog(tmp: string, sessionId: string): GateEvent[] {
  const path = join(sessionDir(tmp, sessionId), 'gate-log.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as GateEvent);
}

async function runHook(
  hookPath: string,
  tmp: string,
  cwd: string,
  input: Record<string, unknown>,
): Promise<{ out: Record<string, unknown> }> {
  const proc = Bun.spawn(['bun', hookPath], {
    cwd,
    env: { ...process.env, TMPDIR: tmp },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return { out: JSON.parse(stdout) as Record<string, unknown> };
  } catch {
    return { out: {} };
  }
}

describe('게이트 로그 (E1)', () => {
  test('위임 게이트 deny가 gate-log.jsonl에 기록된다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    await runHook(PRE_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'x' },
    });
    const events = readLog(tmp, sessionId);
    expect(events.length).toBe(1);
    expect(events[0]!.gate).toBe('delegation');
    expect(events[0]!.decision).toBe('deny');
    expect(events[0]!.reason).toBe('Grep');
  });

  test('서브에이전트 면제 통과는 기록하지 않는다 (allow는 노이즈)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    await runHook(PRE_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'PreToolUse',
      agent_type: 'general-purpose',
      tool_name: 'Grep',
      tool_input: { pattern: 'x' },
    });
    expect(readLog(tmp, sessionId).length).toBe(0);
  });
});

describe('상태 스냅샷 (E1)', () => {
  test('Stop이 status.json을 남긴다 (updatedAt + reviewPending)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    await runHook(STOP_HOOK, tmp, cwd, { session_id: sessionId, cwd, hook_event_name: 'Stop' });
    const statusPath = join(sessionDir(tmp, sessionId), 'status.json');
    expect(existsSync(statusPath)).toBe(true);
    const status = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>;
    expect(typeof status.updatedAt).toBe('string');
    expect(status.reviewPending).toBe(false); // 편집 없음
    expect(status.context).toBeNull(); // transcript 없음 → 측정 불가
  });

  test('검증 실패 마커가 살아 있으면 validationFailed=true + gateDenies 반영', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, '.goodboy-validation-failed.json'),
      JSON.stringify({ sessionId, timestamp: new Date().toISOString(), commands: ['x'] }),
      'utf8',
    );
    const { out } = await runHook(STOP_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'Stop',
    });
    expect(out.decision).toBe('block');
    const status = JSON.parse(
      readFileSync(join(sessionDir(tmp, sessionId), 'status.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(status.validationFailed).toBe(true);
    expect(status.gateDenies as number).toBeGreaterThanOrEqual(1);
  });
});

describe('컨텍스트 측정 canary (E1)', () => {
  test('usage 없는 transcript로 3회 연속 실패 → 세션당 1회 canary 경고', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const transcript = join(cwd, 'transcript.jsonl');
    writeFileSync(transcript, '{"type":"user","message":{"content":"hi"}}\n', 'utf8');
    const input = {
      session_id: sessionId,
      cwd,
      hook_event_name: 'Stop',
      transcript_path: transcript,
    };
    const r1 = await runHook(STOP_HOOK, tmp, cwd, input);
    const r2 = await runHook(STOP_HOOK, tmp, cwd, input);
    expect(String(r1.out.systemMessage ?? '')).not.toContain('canary');
    expect(String(r2.out.systemMessage ?? '')).not.toContain('canary');
    const r3 = await runHook(STOP_HOOK, tmp, cwd, input);
    expect(String(r3.out.systemMessage ?? '')).toContain('canary');
    // 4회째는 다시 경고하지 않는다(세션당 1회).
    const r4 = await runHook(STOP_HOOK, tmp, cwd, input);
    expect(String(r4.out.systemMessage ?? '')).not.toContain('canary');
    // fail-open 이벤트는 매번 기록된다.
    const failOpens = readLog(tmp, sessionId).filter(
      (e) => e.gate === 'context-usage' && e.decision === 'fail-open',
    );
    expect(failOpens.length).toBe(4);
  });

  test('측정 성공 시 streak이 리셋된다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const bad = join(cwd, 'bad.jsonl');
    writeFileSync(bad, '{"type":"user"}\n', 'utf8');
    const good = join(cwd, 'good.jsonl');
    writeFileSync(
      good,
      JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }) +
        '\n',
      'utf8',
    );
    const mk = (t: string) => ({
      session_id: sessionId,
      cwd,
      hook_event_name: 'Stop',
      transcript_path: t,
    });
    await runHook(STOP_HOOK, tmp, cwd, mk(bad));
    await runHook(STOP_HOOK, tmp, cwd, mk(bad));
    await runHook(STOP_HOOK, tmp, cwd, mk(good)); // 성공 → 리셋
    const r = await runHook(STOP_HOOK, tmp, cwd, mk(bad)); // streak 1부터 다시
    expect(String(r.out.systemMessage ?? '')).not.toContain('canary');
  });
});
