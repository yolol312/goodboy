// (C1) 자동 검증 실패 → Stop 차단 게이트 테스트.
//   PostToolUse가 남긴 실패 마커가 살아 있는 동안 Stop이 턴 종료를 차단하는지,
//   세션 바인딩/escape/해제 흐름이 맞는지 검증한다.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-vgate-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-vgate-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

function markerPath(cwd: string): string {
  return join(cwd, '.claude', '.goodboy-validation-failed.json');
}

function seedMarker(cwd: string, sessionId: string, commands: string[]): void {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    markerPath(cwd),
    JSON.stringify({ sessionId, timestamp: new Date().toISOString(), commands }),
    'utf8',
  );
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runHook(
  hookPath: string,
  tmp: string,
  cwd: string,
  input: Record<string, unknown>,
): Promise<HookOut> {
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
    return JSON.parse(stdout) as HookOut;
  } catch {
    return {};
  }
}

async function runStop(tmp: string, cwd: string, sessionId: string): Promise<HookOut> {
  return runHook(STOP_HOOK, tmp, cwd, { session_id: sessionId, cwd, hook_event_name: 'Stop' });
}

describe('Stop hook — 자동 검증 실패 게이트 (C1)', () => {
  test('현재 세션의 실패 마커 → BLOCK (실패 명령 + 재시도 카운터 인용)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(cwd, sessionId, ['bun run typecheck']);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('bun run typecheck');
    expect(out.reason).toContain('재시도 1/3');
    // 마커는 유지된다(해제는 재검증 통과가 담당).
    expect(existsSync(markerPath(cwd))).toBe(true);
  });

  test('다른 세션의 마커(이월/커밋 잔재) → 차단하지 않음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(cwd, 'some-other-session', ['bun run typecheck']);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('깨진 마커 JSON → 차단하지 않음 (fail-open)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(markerPath(cwd), '{ not json', 'utf8');
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('MAX_RETRIES escape: 3회째는 통과 + 사용자 알림 + 마커 정리', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(cwd, sessionId, ['bun run typecheck']);
    writeFileSync(join(cwd, '.claude', '.goodboy-validation-retry-count.txt'), '2', 'utf8');
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain('사용자 확인');
    expect(out.systemMessage).toContain('bun run typecheck');
    // escape 시 마커를 지워 영구 차단을 방지한다.
    expect(existsSync(markerPath(cwd))).toBe(false);
  });

  test('검증 게이트는 리뷰 재시도 카운터(.goodboy-retry-count.txt)를 건드리지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(cwd, sessionId, ['bun run typecheck']);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, '.claude', '.goodboy-retry-count.txt'), '1', 'utf8');
    await runStop(tmp, cwd, sessionId);
    const reviewCount = readFileSync(join(cwd, '.claude', '.goodboy-retry-count.txt'), 'utf8');
    expect(reviewCount.trim()).toBe('1'); // 분리된 카운터 — 리뷰 쪽은 그대로
  });
});

describe('PostToolUse — 검증 실패 마커 기록/해제 (C1)', () => {
  test('typecheck 실패 → 마커 기록(세션 바인딩), 이후 통과 → 마커 해제', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    // 실패하는 typecheck 스크립트
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: 'exit 1' } }),
      'utf8',
    );
    const editedFile = join(cwd, 'a.ts');
    writeFileSync(editedFile, 'export {};\n', 'utf8');
    const editInput = {
      session_id: sessionId,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: editedFile },
    };

    await runHook(POST_HOOK, tmp, cwd, editInput);
    expect(existsSync(markerPath(cwd))).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath(cwd), 'utf8')) as {
      sessionId: string;
      commands: string[];
    };
    expect(marker.sessionId).toBe(sessionId);
    expect(marker.commands.join(' ')).toContain('typecheck');

    // 통과하는 스크립트로 교체 → 재검증 통과 → 마커 해제
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: 'exit 0' } }),
      'utf8',
    );
    await runHook(POST_HOOK, tmp, cwd, editInput);
    expect(existsSync(markerPath(cwd))).toBe(false);
  });

  test('검증이 아예 안 도는 프로젝트(스크립트 없음) → 기존 마커를 오해제하지 않음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: {} }),
      'utf8',
    );
    seedMarker(cwd, sessionId, ['bun run typecheck']);
    const editedFile = join(cwd, 'a.ts');
    writeFileSync(editedFile, 'export {};\n', 'utf8');
    await runHook(POST_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: editedFile },
    });
    // 검증이 실행되지 않았으므로(results 비어있음) 마커는 그대로여야 한다.
    expect(existsSync(markerPath(cwd))).toBe(true);
  });
});
