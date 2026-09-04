// PreToolUse — 게이트 산출물 직접 쓰기 차단 (B0).
//
// 라이브 검증에서 반복 관측된 실패: test-changes/review-changes 에이전트가 CLI를 쓰지 않고
// `.claude/tests/hello-unit-test.json`, `.claude/reviews/review-core.json` 처럼 자기 형식으로
// Write했다. 스키마가 달라 게이트가 읽지 못하니 "결과 없음"으로 계속 차단되고, 프로젝트에는
// 쓰레기 파일만 쌓였다. 산문 지시로는 막히지 않아(haiku 실측) 결정적으로 차단한다.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-aw-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-aw-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

interface HookOut {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

async function runHook(
  tmp: string,
  cwd: string,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<HookOut> {
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, ...extraEnv },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ),
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

function decision(out: HookOut): string | undefined {
  return out.hookSpecificOutput?.permissionDecision;
}
function reason(out: HookOut): string {
  return out.hookSpecificOutput?.permissionDecisionReason ?? '';
}

describe('PreToolUse — 산출물 쓰기 게이트', () => {
  test('.claude/tests/ 에 Write 하면 차단하고 test-write CLI로 유도한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runHook(tmp, cwd, sessionId, 'Write', {
      file_path: join(cwd, '.claude', 'tests', 'hello-unit-test.json'),
      content: '{}',
    });
    expect(decision(out)).toBe('deny');
    expect(reason(out)).toContain('test-write');
    expect(reason(out)).toContain('TestResult');
  });

  test('.claude/reviews/ 에 Write 하면 차단하고 review-write CLI로 유도한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runHook(tmp, cwd, sessionId, 'Write', {
      file_path: join(cwd, '.claude', 'reviews', 'review-core.json'),
      content: '{}',
    });
    expect(decision(out)).toBe('deny');
    expect(reason(out)).toContain('review-write');
    expect(reason(out)).toContain('ReviewResult');
  });

  test('Edit 도구도 동일하게 차단한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    mkdirSync(join(cwd, '.claude', 'tests'), { recursive: true });
    const f = join(cwd, '.claude', 'tests', 'r.json');
    writeFileSync(f, '{}', 'utf8');
    const out = await runHook(tmp, cwd, sessionId, 'Edit', {
      file_path: f,
      old_string: '{}',
      new_string: '{"a":1}',
    });
    expect(decision(out)).toBe('deny');
  });

  test('.claude 아래여도 tests/reviews 밖이면 막지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runHook(tmp, cwd, sessionId, 'Write', {
      file_path: join(cwd, '.claude', 'settings.json'),
      content: '{}',
    });
    expect(reason(out)).not.toContain('산출물 쓰기 게이트');
  });

  test('일반 소스 파일은 이 게이트가 건드리지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runHook(tmp, cwd, sessionId, 'Write', {
      file_path: join(cwd, 'src', 'a.ts'),
      content: 'export const a = 1;',
    });
    expect(reason(out)).not.toContain('산출물 쓰기 게이트');
  });

  test('프로젝트 밖의 같은 이름 경로는 막지 않는다 (cwd 기준 판정)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const outside = join(tmp, '.claude', 'tests', 'x.json');
    const out = await runHook(tmp, cwd, sessionId, 'Write', { file_path: outside, content: '{}' });
    expect(reason(out)).not.toContain('산출물 쓰기 게이트');
  });

  test('GOODBOY_ARTIFACT_WRITE_GATE=off 면 통과시킨다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runHook(
      tmp,
      cwd,
      sessionId,
      'Write',
      { file_path: join(cwd, '.claude', 'tests', 'r.json'), content: '{}' },
      { GOODBOY_ARTIFACT_WRITE_GATE: 'off' },
    );
    expect(reason(out)).not.toContain('산출물 쓰기 게이트');
  });
});
