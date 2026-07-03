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

describe('getContextUsage — VCF_CONTEXT_LIMIT env override & safe 1M defaulting', () => {
  const ORIG = process.env.VCF_CONTEXT_LIMIT;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.VCF_CONTEXT_LIMIT;
    else process.env.VCF_CONTEXT_LIMIT = ORIG;
  });

  test('VCF_CONTEXT_LIMIT sets the limit used for percent', () => {
    process.env.VCF_CONTEXT_LIMIT = '1000000';
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 310_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(1_000_000);
    expect(u!.percent).toBeCloseTo(31, 5); // 310k / 1M = 31%
  });

  test('real-world bug case: ~310K tokens on a 1M window computes ~31% (not ~155%)', () => {
    // 실제 모델 ID(claude-opus-4-8)에는 1m 표식이 없다. env로 1M을 명시하면 정확.
    process.env.VCF_CONTEXT_LIMIT = '1000000';
    const path = writeTranscript([
      JSON.stringify({
        message: {
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 2,
            cache_creation_input_tokens: 2_130,
            cache_read_input_tokens: 307_868,
          },
        },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(310_000);
    expect(u!.limit).toBe(1_000_000);
    expect(u!.percent).toBeCloseTo(31, 5);
    // 200K 기준이었다면 155% → H1-03 오탐. 이제 31%로 임계(50%) 미만.
    expect(u!.percent).toBeLessThan(50);
  });

  test('env override takes priority over model [1m] marker', () => {
    // 모델 표식은 1M이지만 env로 500K를 강제하면 env가 이긴다.
    process.env.VCF_CONTEXT_LIMIT = '500000';
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8[1m]', usage: { input_tokens: 250_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(500_000);
    expect(u!.percent).toBeCloseTo(50, 5);
  });

  test('invalid/zero/negative VCF_CONTEXT_LIMIT is ignored (falls back to detection)', () => {
    for (const bad of ['0', '-100', 'abc', '   ']) {
      process.env.VCF_CONTEXT_LIMIT = bad;
      const path = writeTranscript([
        JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 100_000 } } }),
      ]);
      const u = getContextUsage(path);
      expect(u).not.toBeNull();
      expect(u!.limit).toBe(200_000); // env 무시 → 모델 기반
    }
  });

  test('safe defaulting: tokens exceeding 200K (no marker, no env) bump limit to at least 1M', () => {
    // env 없음 + 표식 없는 모델. 관측 토큰이 200K를 넘으면 200K 창일 수 없으므로 1M으로 상향.
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 310_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(1_000_000); // 오탐 회피용 안전 상향
    expect(u!.percent).toBeCloseTo(31, 5);
    expect(u!.percent).toBeLessThan(50); // H1-03 오탐 발동 안 함
  });

  test('safe defaulting does NOT fire below 200K (normal 200K sessions keep H1-03)', () => {
    // 표식 없는 정상 200K 세션이 150K이면 여전히 200K 한도(75%)로 남아 H1-03가 작동해야 한다.
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(200_000);
    expect(u!.percent).toBeCloseTo(75, 5);
  });

  test('tokens exceeding even 1M yield legitimate >100% (real overflow, not false positive)', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 1_200_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(1_000_000);
    expect(u!.percent).toBeGreaterThan(100);
  });
});


describe('getContextUsage — runtime dynamic 1M detection (low-token false-positive fix)', () => {
  const ORIG = process.env.VCF_CONTEXT_LIMIT;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.VCF_CONTEXT_LIMIT;
    else process.env.VCF_CONTEXT_LIMIT = ORIG;
  });

  /** Write a settings.json in a fresh temp dir and return its path (cleaned via shared tmpDirs). */
  function writeSettings(model: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'vcf-ctx-settings-'));
    tmpDirs.push(dir);
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ model }), 'utf8');
    return path;
  }

  test('KEY SCENARIO: 1M session at 150K tokens → 15% (no false 75% force) via transcript resolvedModel', () => {
    // usage 줄 model엔 표식이 없지만(claude-opus-4-8), Task 결과 resolvedModel엔 [1m]이 있다.
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({
        type: 'user',
        toolUseResult: { resolvedModel: 'claude-opus-4-8[1m]', status: 'completed' },
      }),
      JSON.stringify({
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u).not.toBeNull();
    expect(u!.limit).toBe(1_000_000);
    expect(u!.tokens).toBe(150_000);
    expect(u!.percent).toBeCloseTo(15, 5); // 200K였다면 75% → H1-03 오탐. 이제 15%.
    expect(u!.percent).toBeLessThan(50);
  });

  test('structural resolvedModel [1m] anywhere (even after the usage line) is detected', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 120_000 } } }),
      JSON.stringify({ toolUseResult: { resolvedModel: 'claude-sonnet-4-5[1m]' } }),
    ]);
    const u = getContextUsage(path);
    expect(u!.limit).toBe(1_000_000);
  });

  test('hook input model with [1m] forces 1M even at low tokens', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 100_000 } } }),
    ]);
    const u = getContextUsage(path, { hookInput: { model: 'claude-opus-4-8[1m]' } });
    expect(u!.limit).toBe(1_000_000);
    expect(u!.percent).toBeCloseTo(10, 5);
  });

  test('hook input model WITHOUT marker → existing 200K logic preserved', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } } }),
    ]);
    const u = getContextUsage(path, { hookInput: { model: 'claude-opus-4-8' } });
    expect(u!.limit).toBe(200_000);
    expect(u!.percent).toBeCloseTo(75, 5);
  });

  test('env override still wins over hook/transcript/settings dynamic signals', () => {
    process.env.VCF_CONTEXT_LIMIT = '500000';
    const path = writeTranscript([
      JSON.stringify({ toolUseResult: { resolvedModel: 'claude-opus-4-8[1m]' } }),
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 250_000 } } }),
    ]);
    const u = getContextUsage(path, {
      hookInput: { model: 'claude-opus-4-8[1m]' },
      settingsPath: writeSettings('claude-opus-4-8[1m]'),
    });
    expect(u!.limit).toBe(500_000); // env가 최우선
    expect(u!.percent).toBeCloseTo(50, 5);
  });

  test('settings.json fallback: model [1m] → 1M when no higher-priority signal', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } } }),
    ]);
    const u = getContextUsage(path, { settingsPath: writeSettings('claude-opus-4-8[1m]') });
    expect(u!.limit).toBe(1_000_000);
    expect(u!.percent).toBeCloseTo(15, 5);
  });

  test('settings.json without marker does NOT force 1M', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } } }),
    ]);
    const u = getContextUsage(path, { settingsPath: writeSettings('claude-opus-4-8') });
    expect(u!.limit).toBe(200_000);
  });

  test('fail-open: missing/garbage settings path never throws, falls through to default', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } } }),
    ]);
    const missing = getContextUsage(path, { settingsPath: '/nonexistent/x/settings.json' });
    expect(missing!.limit).toBe(200_000);

    const garbageDir = mkdtempSync(join(tmpdir(), 'vcf-ctx-badsettings-'));
    tmpDirs.push(garbageDir);
    const garbagePath = join(garbageDir, 'settings.json');
    writeFileSync(garbagePath, '{ not json', 'utf8');
    const garbage = getContextUsage(path, { settingsPath: garbagePath });
    expect(garbage!.limit).toBe(200_000);
  });

  test('false-positive guard: "[1m]" only in message CONTENT text (not a model field) → still 200K', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8', // 표식 없음
          content: [{ type: 'text', text: 'docs mention claude-opus-4-8[1m] here' }],
          usage: { input_tokens: 150_000 },
        },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u!.limit).toBe(200_000); // 본문 텍스트의 [1m]은 구조적 신호가 아니므로 무시
    expect(u!.percent).toBeCloseTo(75, 5);
  });
});

describe('getContextUsage confident (3-A)', () => {
  test('confirmed 200K-only model (3.5-sonnet) → confident true', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({
        message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 120_000 } },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u!.limit).toBe(200_000);
    expect(u!.confident).toBe(true);
  });

  test('1M-capable model without marker (opus-4-8) → confident false', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u!.limit).toBe(200_000);
    expect(u!.confident).toBe(false);
  });

  test('1M marker present (resolvedModel) → limit 1M and confident true', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({
        toolUseResult: { resolvedModel: 'claude-opus-4-8[1m]' },
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } },
      }),
    ]);
    const u = getContextUsage(path);
    expect(u!.limit).toBe(1_000_000);
    expect(u!.confident).toBe(true);
  });

  test('VCF_CONTEXT_LIMIT env → confident true even for ambiguous model', () => {
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 150_000 } } }),
    ]);
    process.env.VCF_CONTEXT_LIMIT = '200000';
    try {
      const u = getContextUsage(path);
      expect(u!.limit).toBe(200_000);
      expect(u!.confident).toBe(true);
    } finally {
      delete process.env.VCF_CONTEXT_LIMIT;
    }
  });

  test('unknown (non-Claude) model → confident false (conservative)', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'some-random-model-x', usage: { input_tokens: 120_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u!.confident).toBe(false);
  });

  test('tokens over 200K → safe-upgrade to 1M and confident true', () => {
    delete process.env.VCF_CONTEXT_LIMIT;
    const path = writeTranscript([
      JSON.stringify({ message: { model: 'claude-opus-4-8', usage: { input_tokens: 250_000 } } }),
    ]);
    const u = getContextUsage(path);
    expect(u!.limit).toBe(1_000_000);
    expect(u!.confident).toBe(true);
  });
});
