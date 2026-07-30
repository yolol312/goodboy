// (v0.27.9) H2-04 확장 — 동일 검색어 재검색 경고 + 압축 epoch 시 웹 기록 리셋.
//   tokenhabit 실측(웹 호출 270회) 대응. 경고는 PostToolUse additionalContext
//   (에이전트에 확실히 도달하는 채널)로 전달된다 — PreToolUse 사전 경고는 에이전트에
//   닿지 않아(실측) 채택하지 않았다(리뷰 medium 대응).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { clearReadRecords } from '../lib/file-tracker';
import { recordWebFetch, wasUrlFetched } from '../lib/token-habits';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    try {
      rmSync(join(tmpdir(), `goodboy-session-${basename(d)}`), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-postweb-'));
  tmpDirs.push(cwd);
  return cwd;
}

interface Out {
  hookSpecificOutput?: { additionalContext?: string };
}

async function runPost(
  cwd: string,
  toolName: 'WebFetch' | 'WebSearch',
  toolInput: Record<string, unknown>,
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: basename(cwd),
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { ok: true },
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env },
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

const ctx = (o: Out): string => o.hookSpecificOutput?.additionalContext ?? '';

describe('post-tool-use H2-04 — WebSearch 재검색 경고 (v0.27.9)', () => {
  test('같은 검색어 반복이면 additionalContext로 경고, 첫 검색은 무경고', async () => {
    const cwd = makeCwd();
    const first = await runPost(cwd, 'WebSearch', { query: 'bun test timeout' });
    expect(ctx(first)).not.toContain('H2-04');
    const repeat = await runPost(cwd, 'WebSearch', { query: 'bun test timeout' });
    expect(ctx(repeat)).toContain('H2-04');
    expect(ctx(repeat)).toContain('재검색');
  });

  test('검색어 기록(search: 접두)이 URL 기록과 충돌하지 않는다', async () => {
    const cwd = makeCwd();
    await runPost(cwd, 'WebSearch', { query: 'https://example.com/docs' });
    // 같은 문자열이라도 URL 페치는 별도 키 — 재페치 경고가 아니라 무경고여야 한다.
    const fetch = await runPost(cwd, 'WebFetch', { url: 'https://example.com/docs' });
    expect(ctx(fetch)).not.toContain('H2-04');
  });

  test("'#'가 든 검색어는 URL 정규화로 절단되지 않는다 — 'C#' 검색어 충돌 방지 (재리뷰 medium)", async () => {
    const cwd = makeCwd();
    // normalizeUrl을 검색 키에 적용하면 둘 다 'search:C'로 절단되어 거짓 경고가 났다(실측).
    await runPost(cwd, 'WebSearch', { query: 'C# async await' });
    const different = await runPost(cwd, 'WebSearch', { query: 'C# LINQ groupby' });
    expect(ctx(different)).not.toContain('H2-04');
    // 같은 검색어의 진짜 반복은 여전히 경고.
    const repeat = await runPost(cwd, 'WebSearch', { query: 'C# async await' });
    expect(ctx(repeat)).toContain('H2-04');
  });

  test('기존 WebFetch 재페치 경고는 유지된다', async () => {
    const cwd = makeCwd();
    await runPost(cwd, 'WebFetch', { url: 'https://example.com/a' });
    const repeat = await runPost(cwd, 'WebFetch', { url: 'https://example.com/a' });
    expect(ctx(repeat)).toContain('재페치');
  });
});

describe('압축 epoch 리셋 — 웹 기록도 함께 비운다 (v0.27.9, 리뷰 medium)', () => {
  test('clearReadRecords가 webfetch.jsonl을 지워, 압축 후 거짓 "앞선 결과 참조" 경고가 없다', () => {
    const sessionId = `epoch-${Math.random().toString(36).slice(2)}`;
    try {
      recordWebFetch(sessionId, 'https://example.com/page');
      expect(wasUrlFetched(sessionId, 'https://example.com/page')).toBe(true);
      clearReadRecords(sessionId); // 압축 감지 시 Stop hook이 호출하는 epoch 리셋
      expect(wasUrlFetched(sessionId, 'https://example.com/page')).toBe(false);
    } finally {
      try {
        rmSync(join(tmpdir(), `goodboy-session-${sessionId}`), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});
