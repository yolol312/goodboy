// (v0.27.9) Read-before-edit 창 20→30턴 정렬 — tokenhabit H2-01 실측 대응.
//   재-Read 게이트(A2)는 "읽은 내용이 30턴 산다"고 판정하는데 read-before-edit만
//   20턴이면, 21~30턴 구간의 편집이 goodboy 자신이 유발하는 전체 재독을 강제했다.

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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-rbe-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-rbe-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** read 기록(readTurn)과 현재 턴(currentTurn)을 심는다. mtime은 있을 때만 기록. */
function seedReadAtTurn(
  tmp: string,
  sessionId: string,
  file: string,
  readTurn: number,
  currentTurn: number,
  mtime?: number,
): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(currentTurn), 'utf8');
  const rec: Record<string, unknown> = {
    file: resolve(file),
    turn: readTurn,
    timestamp: new Date().toISOString(),
  };
  if (mtime !== undefined) rec.mtime = mtime;
  writeFileSync(join(dir, 'reads.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

async function runEdit(tmp: string, cwd: string, sessionId: string, filePath: string): Promise<Out> {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    tool_name: 'Edit',
    // 문서 파일(.md) → 추론 게이트는 면제되고 read-before-edit만 평가된다.
    tool_input: { file_path: filePath, old_string: 'hello', new_string: 'world' },
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, GOODBOY_DISABLE_DELEGATION: '1' },
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as Out;
  } catch {
    return {};
  }
}

const isDenied = (o: Out): boolean => o.hookSpecificOutput?.permissionDecision === 'deny';

describe('pre-tool-use read-before-edit — 창 30턴 정렬 (v0.27.9)', () => {
  test('25턴 전 read는 여전히 유효(창 30턴) — 구 20턴 창이면 헛 재독을 강제했다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const file = join(cwd, 'notes.md');
    writeFileSync(file, 'hello', 'utf8');
    seedReadAtTurn(tmp, sessionId, file, 5, 30); // 25턴 경과
    const out = await runEdit(tmp, cwd, sessionId, file);
    expect(isDenied(out)).toBe(false);
  });

  test('창(30턴)을 넘긴 read는 차단 + 부분 읽기 안내', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const file = join(cwd, 'notes.md');
    writeFileSync(file, 'hello', 'utf8');
    seedReadAtTurn(tmp, sessionId, file, 5, 40); // 35턴 경과 > 30
    const out = await runEdit(tmp, cwd, sessionId, file);
    expect(isDenied(out)).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecisionReason ?? '').toContain('partial read');
  });

  test('창 안의 read라도 그 사이 파일이 바뀌었으면(mtime 불일치) 차단 — 낡은 지식 편집 방지 (리뷰 medium)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const file = join(cwd, 'notes.md');
    writeFileSync(file, 'hello', 'utf8');
    const { statSync } = await import('node:fs');
    const curMtime = statSync(file).mtimeMs;
    // read 시점 mtime을 현재와 다르게 기록 = read 이후 외부 변경이 있었던 상황.
    seedReadAtTurn(tmp, sessionId, file, 25, 30, curMtime - 5000);
    const out = await runEdit(tmp, cwd, sessionId, file);
    expect(isDenied(out)).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecisionReason ?? '').toContain('changed after you last read');
  });

  test('mtime이 일치하면 창 안의 read로 통과, mtime 기록이 없으면 fail-open 통과', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const file = join(cwd, 'notes.md');
    writeFileSync(file, 'hello', 'utf8');
    const { statSync } = await import('node:fs');
    seedReadAtTurn(tmp, sessionId, file, 25, 30, statSync(file).mtimeMs);
    expect(isDenied(await runEdit(tmp, cwd, sessionId, file))).toBe(false);

    const { tmp: tmp2, cwd: cwd2, sessionId: sid2 } = newSandbox();
    const file2 = join(cwd2, 'notes.md');
    writeFileSync(file2, 'hello', 'utf8');
    seedReadAtTurn(tmp2, sid2, file2, 25, 30); // mtime 미기록(구버전 기록 하위호환)
    expect(isDenied(await runEdit(tmp2, cwd2, sid2, file2))).toBe(false);
  });

  test('GOODBOY_READ_BEFORE_EDIT_WINDOW로 창 조정 가능', async () => {
    const prev = process.env.GOODBOY_READ_BEFORE_EDIT_WINDOW;
    process.env.GOODBOY_READ_BEFORE_EDIT_WINDOW = '10';
    try {
      const { tmp, cwd, sessionId } = newSandbox();
      const file = join(cwd, 'notes.md');
      writeFileSync(file, 'hello', 'utf8');
      seedReadAtTurn(tmp, sessionId, file, 5, 20); // 15턴 경과 > 10
      const out = await runEdit(tmp, cwd, sessionId, file);
      expect(isDenied(out)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GOODBOY_READ_BEFORE_EDIT_WINDOW;
      else process.env.GOODBOY_READ_BEFORE_EDIT_WINDOW = prev;
    }
  });
});
