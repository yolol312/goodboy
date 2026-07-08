// 동봉 상태바 스크립트 테스트 — 게이트와 동일 계산기로 컨텍스트 %를 표시하는지,
// status.json 스냅샷 상태를 반영하는지, 어떤 실패에도 한 줄은 출력하는지(fail-open).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', 'statusline', 'statusline.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-sl-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-sl-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

function seedStatus(tmp: string, sessionId: string, status: Record<string, unknown>): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), context: null, ...status }),
    'utf8',
  );
}

async function runStatusline(
  tmp: string,
  cwd: string,
  input: Record<string, unknown> | string,
): Promise<string> {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  const proc = Bun.spawn(['bun', SCRIPT], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp },
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

describe('goodboy statusline', () => {
  test('transcript에서 게이트와 동일 계산으로 컨텍스트 % 표시 (확정 모델)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const transcript = join(cwd, 't.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 80_000 } },
      }) + '\n',
      'utf8',
    );
    const out = await runStatusline(tmp, cwd, {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
    });
    expect(out).toContain('🐶');
    expect(out).toContain('🧠 40%'); // 80K/200K — 물음표 없음(확정)
    expect(out).not.toContain('40%?');
  });

  test('미확정 모델(fable)은 %에 ? 표기 (강제 보류 상태 가시화)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const transcript = join(cwd, 't.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ message: { model: 'claude-fable-5', usage: { input_tokens: 80_000 } } }) +
        '\n',
      'utf8',
    );
    const out = await runStatusline(tmp, cwd, {
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
    });
    expect(out).toContain('%?');
  });

  test('status.json의 위험도/리뷰/검증/게이트 상태를 반영', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedStatus(tmp, sessionId, {
      category: 'fix-bug',
      risk: 'risky',
      validationFailed: true,
      reviewPending: true,
      gateDenies: 3,
    });
    const out = await runStatusline(tmp, cwd, { session_id: sessionId, cwd });
    expect(out).toContain('🔴fix-bug');
    expect(out).toContain('🔧 검증실패');
    expect(out).toContain('📋 리뷰대기');
    expect(out).toContain('🚧 3');
  });

  test('fail-open: 빈/깨진 입력에도 최소 한 줄 출력', async () => {
    const { tmp, cwd } = newSandbox();
    expect(await runStatusline(tmp, cwd, '')).toContain('🐶');
    expect(await runStatusline(tmp, cwd, '{ not json')).toContain('🐶');
    expect(await runStatusline(tmp, cwd, {})).toContain('🐶');
  });
});
