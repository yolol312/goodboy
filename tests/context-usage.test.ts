import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getContextUsage } from '../lib/context-usage';

const tmpDirs: string[] = [];

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vcf-ctxusage-'));
  tmpDirs.push(dir);
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

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

describe('getContextUsage', () => {
  test('uses the MOST RECENT usage (not cumulative) for current occupancy', () => {
    // 누적이면 100k+50k=150k이 되지만, 현재 점유는 "마지막" 요청의 50k여야 한다.
    const path = writeTranscript([
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 100_000 } },
      }),
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 50_000 } },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(50_000);
    expect(u!.limit).toBe(200_000);
    expect(u!.percent).toBeCloseTo(25, 5);
  });

  test('sums input + cache_read + cache_creation as current occupancy', () => {
    const path = writeTranscript([
      JSON.stringify({
        message: {
          model: 'claude-3-5-sonnet',
          usage: {
            input_tokens: 10_000,
            cache_read_input_tokens: 30_000,
            cache_creation_input_tokens: 5_000,
            output_tokens: 999, // output은 점유 계산에서 제외돼야 함
          },
        },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(45_000); // 10k + 30k + 5k, output 제외
  });

  test('standard model 50% boundary — just BELOW threshold', () => {
    // 200_000 한도에서 99,800 토큰 = 49.9% < 50%
    const path = writeTranscript([
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 99_800 } },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(200_000);
    expect(u!.percent).toBeLessThan(50);
  });

  test('standard model 50% boundary — just ABOVE threshold', () => {
    // 200_000 한도에서 100,200 토큰 = 50.1% > 50%
    const path = writeTranscript([
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 100_200 } },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(200_000);
    expect(u!.percent).toBeGreaterThan(50);
  });

  test('1M extended-context model gets 1_000_000 limit (via [1m] tag)', () => {
    // 600k 토큰: 표준 한도면 300%(경고)지만 1M이면 60%.
    const path = writeTranscript([
      JSON.stringify({
        message: { model: 'claude-opus-4-8[1m]', usage: { input_tokens: 600_000 } },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(1_000_000);
    expect(u!.percent).toBeCloseTo(60, 5);
    expect(u!.model).toBe('claude-opus-4-8[1m]');
  });

  test('various "1m" style identifiers map to 1M limit', () => {
    for (const model of ['some-model-1m', 'claude-1-million-ctx', 'model-1000k']) {
      const path = writeTranscript([
        JSON.stringify({ message: { model, usage: { input_tokens: 1 } } }),
      ]);
      const u = getContextUsage(path);
      expect(u).not.toBeNull();
      expect(u!.limit).toBe(1_000_000);
    }
  });

  test('model unidentifiable / absent → conservative 200K assumption', () => {
    const path = writeTranscript([
      // model 필드가 전혀 없음
      JSON.stringify({ usage: { input_tokens: 120_000 } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.model).toBeNull();
    expect(u!.limit).toBe(200_000); // 보수적 기본값
    expect(u!.percent).toBeGreaterThan(50);
  });

  test('reads usage from various positions (top-level, message.usage, response.usage, double-wrap)', () => {
    // 마지막(가장 최근) usage가 채택되는지 위치별로 확인 — 마지막 줄이 response.usage.
    const topLevel = writeTranscript([JSON.stringify({ usage: { input_tokens: 11_111 } })]);
    expect(getContextUsage(topLevel)!.tokens).toBe(11_111);

    const messageUsage = writeTranscript([
      JSON.stringify({ message: { usage: { input_tokens: 22_222 } } }),
    ]);
    expect(getContextUsage(messageUsage)!.tokens).toBe(22_222);

    const responseUsage = writeTranscript([
      JSON.stringify({ response: { usage: { input_tokens: 33_333 } } }),
    ]);
    expect(getContextUsage(responseUsage)!.tokens).toBe(33_333);

    const doubleWrap = writeTranscript([
      JSON.stringify({ message: { message: { usage: { input_tokens: 44_444 } } } }),
    ]);
    expect(getContextUsage(doubleWrap)!.tokens).toBe(44_444);
  });

  test('supports camelCase and prompt_tokens key variants', () => {
    const path = writeTranscript([
      JSON.stringify({
        usage: {
          inputTokens: 1_000,
          cacheReadInputTokens: 2_000,
          cacheCreationInputTokens: 500,
        },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(3_500);

    const promptPath = writeTranscript([JSON.stringify({ usage: { prompt_tokens: 7_777 } })]);
    expect(getContextUsage(promptPath)!.tokens).toBe(7_777);
  });

  test('falls back to a model seen on a non-usage line when the usage line lacks model', () => {
    const path = writeTranscript([
      // 모델만 있는 줄(예: system/init 라인)
      JSON.stringify({ model: 'claude-opus-4-8[1m]' }),
      // usage는 있지만 model 없음 → 위에서 본 1M 모델로 폴백돼야 함
      JSON.stringify({ usage: { input_tokens: 600_000 } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(1_000_000);
    expect(u!.model).toBe('claude-opus-4-8[1m]');
  });

  test('skips malformed lines and still reads the valid most-recent usage', () => {
    const path = writeTranscript([
      'not json',
      '{ broken',
      '',
      '   ',
      JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 80_000 } } }),
      '[1,2,3]',
      'null',
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(80_000);
  });

  test('ignores non-numeric usage values without crashing', () => {
    const path = writeTranscript([
      JSON.stringify({ usage: { input_tokens: 'lots', cache_read_input_tokens: null } }),
      JSON.stringify({ usage: { input_tokens: 42_000 } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(42_000);
  });

  test('returns null on a transcript with no usage at all', () => {
    const path = writeTranscript([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ role: 'user', content: 'hi' }),
    ]);
    expect(getContextUsage(path)).toBeNull();
  });

  test('returns null on a fully garbage transcript', () => {
    const path = writeTranscript(['garbage', '{nope', '<html></html>', '42']);
    expect(getContextUsage(path)).toBeNull();
  });

  test('returns null on an empty transcript', () => {
    const path = writeTranscript(['', '   ', '']);
    expect(getContextUsage(path)).toBeNull();
  });

  test('returns null on a missing file (never throws)', () => {
    expect(getContextUsage('/nonexistent/path/transcript.jsonl')).toBeNull();
  });

  test('returns null on empty/invalid path argument', () => {
    expect(getContextUsage('')).toBeNull();
    // @ts-expect-error testing runtime robustness
    expect(getContextUsage(null)).toBeNull();
    // @ts-expect-error testing runtime robustness
    expect(getContextUsage(undefined)).toBeNull();
  });
});
