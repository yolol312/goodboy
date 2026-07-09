import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'user-prompt-submit.ts');
const PLUGIN_ROOT = resolve(import.meta.dir, '..');
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

async function runHook(
  prompt: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-concise-'));
  tmpDirs.push(cwd);
  const payload = JSON.stringify({ session_id: 'test-session', cwd, prompt });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...extraEnv },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

function ctx(stdout: string): string {
  const out = JSON.parse(stdout || '{}') as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return out.hookSpecificOutput?.additionalContext ?? '';
}

describe('user-prompt-submit H5-04 concise-first', () => {
  test('injects concise-first instruction on a normal prompt (default on)', async () => {
    const out = await runHook('fix the login bug');
    expect(ctx(out)).toContain('H5-04');
    expect(ctx(out)).toContain('요약');
  });

  test('does NOT inject when the prompt requests detail', async () => {
    const out = await runHook('로그인 버그를 자세히 설명해줘');
    expect(ctx(out)).not.toContain('H5-04');
  });

  test('GOODBOY_CONCISE_DEFAULT=off disables injection', async () => {
    const out = await runHook('fix the login bug', { GOODBOY_CONCISE_DEFAULT: 'off' });
    expect(ctx(out)).not.toContain('H5-04');
  });

  test('slash command still gets checklist AND concise instruction merged', async () => {
    const out = await runHook('/add-feature add a todo list');
    expect(ctx(out)).toContain('user_scenario'); // checklist preserved
    expect(ctx(out)).toContain('H5-04'); // concise appended
  });

  test('slash command with detail request keeps checklist but drops concise', async () => {
    const out = await runHook('/add-feature 전체 구조를 상세하게 만들어줘');
    expect(ctx(out)).toContain('user_scenario');
    expect(ctx(out)).not.toContain('H5-04');
  });
});

describe('user-prompt-submit B2 — 일반 프롬프트 부족-입력 질문 유도', () => {
  test('일반 프롬프트에 질문 유도 지시가 주입된다 (기본 on)', async () => {
    const out = await runHook('로그인이 안 돼');
    expect(ctx(out)).toContain('B2');
    expect(ctx(out)).toContain('AskUserQuestion');
    expect(ctx(out)).toContain('확인 필요');
  });

  test('간결 지시(H5-04)와 함께 병합 주입된다', async () => {
    const out = await runHook('로그인 버그 고쳐줘');
    expect(ctx(out)).toContain('B2');
    expect(ctx(out)).toContain('H5-04');
  });

  test('GOODBOY_ASK_UNCLEAR=off로 끌 수 있다', async () => {
    const out = await runHook('로그인이 안 돼', { GOODBOY_ASK_UNCLEAR: 'off' });
    expect(ctx(out)).not.toContain('B2');
  });

  test('카테고리 커맨드에는 주입하지 않는다 (전용 체크리스트가 대신함)', async () => {
    const out = await runHook('/fix-bug 로그인 후 401');
    expect(ctx(out)).toContain('필수 입력 체크리스트'); // 전용 체크리스트
    expect(ctx(out)).not.toContain('(부족 입력 질문 유도, B2)'); // 일반 지시는 중복 주입 안 함
  });

  test('가정 기록 안전망(A1/A2 연계) 문구를 포함한다', async () => {
    const out = await runHook('설정 바꿔줘');
    expect(ctx(out)).toContain('가정');
    expect(ctx(out)).toContain('지어내지');
  });
});
