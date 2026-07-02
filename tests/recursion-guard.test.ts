import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAX_SAME_PROMPT,
  MAX_TOTAL,
  WINDOW_MS,
  checkRecursionGuard,
  hashPrompt,
} from '../lib/recursion-guard';

// 각 테스트는 고유 sessionId를 써서 상태 디렉터리가 겹치지 않게 한다.
let counter = 0;
const sessions: string[] = [];
function newSession(): string {
  const id = `rg-test-${process.pid}-${Date.now()}-${counter++}`;
  sessions.push(id);
  return id;
}

afterEach(() => {
  while (sessions.length) {
    const id = sessions.pop()!;
    const safe = id.replace(/[^a-zA-Z0-9_\-]/g, '_');
    try {
      rmSync(join(tmpdir(), `vcf-session-${safe}`), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('recursion-guard hashPrompt', () => {
  test('공백/대소문자 정규화 후 동일 해시', () => {
    expect(hashPrompt('Run  Tests\n')).toBe(hashPrompt('run tests'));
  });
  test('다른 프롬프트는 다른 해시', () => {
    expect(hashPrompt('run tests')).not.toBe(hashPrompt('deploy prod'));
  });
});

describe('recursion-guard checkRecursionGuard', () => {
  test('정상 케이스: 소수 호출은 통과', () => {
    const sid = newSession();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const r = checkRecursionGuard(sid, `task ${i}`, now + i);
      expect(r.blocked).toBe(false);
    }
  });

  test('동일 프롬프트 MAX_SAME_PROMPT회째에 차단', () => {
    const sid = newSession();
    const now = 2_000_000;
    let lastBlocked = false;
    let lastSame = 0;
    for (let i = 0; i < MAX_SAME_PROMPT; i++) {
      const r = checkRecursionGuard(sid, 'same prompt', now + i);
      lastBlocked = r.blocked;
      lastSame = r.same;
    }
    // MAX_SAME_PROMPT 번째 호출(같은 프롬프트)에서 same===MAX_SAME_PROMPT → 차단
    expect(lastSame).toBe(MAX_SAME_PROMPT);
    expect(lastBlocked).toBe(true);
  });

  test('동일 프롬프트 차단 직전(MAX_SAME_PROMPT-1)까지는 통과', () => {
    const sid = newSession();
    const now = 2_500_000;
    let blocked = false;
    for (let i = 0; i < MAX_SAME_PROMPT - 1; i++) {
      blocked = checkRecursionGuard(sid, 'same prompt', now + i).blocked || blocked;
    }
    expect(blocked).toBe(false);
  });

  test('총 호출 상한 초과 시 차단 (서로 다른 프롬프트)', () => {
    const sid = newSession();
    const now = 3_000_000;
    let blockedAt = -1;
    // MAX_TOTAL+1 회 => total > MAX_TOTAL 에서 차단. 프롬프트를 모두 다르게 해서
    // 동일 프롬프트 임계와 무관하게 총량 게이트만 검증.
    for (let i = 0; i <= MAX_TOTAL; i++) {
      const r = checkRecursionGuard(sid, `unique-${i}`, now + i);
      if (r.blocked && blockedAt === -1) blockedAt = i;
    }
    // (MAX_TOTAL+1)번째 = index MAX_TOTAL 에서 total===MAX_TOTAL+1 > MAX_TOTAL → 차단
    expect(blockedAt).toBe(MAX_TOTAL);
  });

  test('윈도우 밖 호출은 카운트되지 않아 통과', () => {
    const sid = newSession();
    const base = 5_000_000;
    // 윈도우를 꽉 채울 만큼 오래된 호출들
    for (let i = 0; i < MAX_TOTAL; i++) {
      checkRecursionGuard(sid, `old-${i}`, base + i);
    }
    // WINDOW_MS 이후 시점의 새 호출: 이전 것들은 모두 윈도우 밖 → total=1
    const r = checkRecursionGuard(sid, 'fresh', base + WINDOW_MS + 10_000);
    expect(r.blocked).toBe(false);
    expect(r.total).toBe(1);
  });

  test('fail-open: 상태 저장 불가 상황에서도 통과 (빈 sessionId)', () => {
    // 어떤 입력이든 예외를 던지지 않고 blocked=false 를 낼 수 있어야 한다.
    const r = checkRecursionGuard('', 'anything');
    expect(r.blocked).toBe(false);
  });
});

describe('recursion-guard via pre-tool-use hook', () => {
  const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');

  async function runHook(payload: Record<string, unknown>): Promise<string> {
    const proc = Bun.spawn(['bun', HOOK], {
      env: { ...process.env, VCF_DISABLE_DELEGATION: '1' },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  }

  function isBlocked(stdout: string): boolean {
    const out = JSON.parse(stdout || '{}') as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    return out.hookSpecificOutput?.permissionDecision === 'deny';
  }

  test('Agent/Task 외 도구는 재귀 가드를 타지 않고 통과', async () => {
    const out = await runHook({
      session_id: newSession(),
      cwd: tmpdir(),
      tool_name: 'Read',
      tool_input: { file_path: join(tmpdir(), 'x.txt') },
    });
    expect(isBlocked(out)).toBe(false);
  });

  test('동일 프롬프트 Agent 호출 반복 시 차단', async () => {
    const sid = newSession();
    const payload = {
      session_id: sid,
      cwd: tmpdir(),
      tool_name: 'Agent',
      tool_input: { prompt: 'do the same thing forever' },
    };
    let blocked = false;
    for (let i = 0; i < MAX_SAME_PROMPT; i++) {
      blocked = isBlocked(await runHook(payload));
    }
    expect(blocked).toBe(true);
  });

  test('서브에이전트(agent_type 존재)도 재귀 가드 적용 (면제 없음)', async () => {
    const sid = newSession();
    const payload = {
      session_id: sid,
      cwd: tmpdir(),
      agent_type: 'general-purpose',
      tool_name: 'Task',
      tool_input: { prompt: 'recurse endlessly' },
    };
    let blocked = false;
    for (let i = 0; i < MAX_SAME_PROMPT; i++) {
      blocked = isBlocked(await runHook(payload));
    }
    expect(blocked).toBe(true);
  });
});
