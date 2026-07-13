import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assistantEntriesAfterLastText,
  parseTokensFromTranscript,
} from '../lib/transcript-parser';

const tmpDirs: string[] = [];

function writeTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-transcript-'));
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

describe('parseTokensFromTranscript', () => {
  test('sums usage across multiple known shapes (top-level, message.usage, response.usage)', () => {
    const path = writeTranscript([
      JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
      JSON.stringify({
        message: { usage: { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 3 } },
      }),
      JSON.stringify({ response: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 4 } } }),
    ]);
    const t = parseTokensFromTranscript(path);
    expect(t).not.toBeNull();
    expect(t!.input).toBe(31);
    expect(t!.output).toBe(13);
    expect(t!.cacheRead).toBe(3);
    expect(t!.cacheCreation).toBe(4);
  });

  test('supports camelCase and prompt/completion key variants', () => {
    const path = writeTranscript([
      JSON.stringify({ usage: { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 2 } }),
      JSON.stringify({ delta: { usage: { prompt_tokens: 8, completion_tokens: 3 } } }),
    ]);
    const t = parseTokensFromTranscript(path);
    expect(t).not.toBeNull();
    expect(t!.input).toBe(108);
    expect(t!.output).toBe(43);
    expect(t!.cacheRead).toBe(2);
  });

  test('supports double-wrapped message.message.usage and result.usage', () => {
    const path = writeTranscript([
      JSON.stringify({ message: { message: { usage: { input_tokens: 5, output_tokens: 2 } } } }),
      JSON.stringify({ result: { usage: { input_tokens: 6, output_tokens: 1 } } }),
    ]);
    const t = parseTokensFromTranscript(path);
    expect(t).not.toBeNull();
    expect(t!.input).toBe(11);
    expect(t!.output).toBe(3);
  });

  test('skips malformed lines gracefully and still sums the valid ones', () => {
    const path = writeTranscript([
      'this is not json',
      '{ broken json',
      '',
      '   ',
      JSON.stringify({ usage: { input_tokens: 9, output_tokens: 4 } }),
      '[1,2,3]', // valid JSON but an array, not a usage-bearing object
      'null',
      JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);
    const t = parseTokensFromTranscript(path);
    expect(t).not.toBeNull();
    expect(t!.input).toBe(10);
    expect(t!.output).toBe(5);
  });

  test('ignores non-numeric / non-finite usage values without crashing', () => {
    const path = writeTranscript([
      JSON.stringify({ usage: { input_tokens: 'lots', output_tokens: null } }),
      JSON.stringify({ usage: { input_tokens: 7, output_tokens: 2 } }),
    ]);
    const t = parseTokensFromTranscript(path);
    expect(t).not.toBeNull();
    expect(t!.input).toBe(7);
    expect(t!.output).toBe(2);
  });

  test('returns null on a fully garbage transcript', () => {
    const path = writeTranscript(['garbage', '{nope', '<html></html>', '42 not usage']);
    expect(parseTokensFromTranscript(path)).toBeNull();
  });

  test('returns null on an empty transcript', () => {
    const path = writeTranscript(['', '   ', '']);
    expect(parseTokensFromTranscript(path)).toBeNull();
  });

  test('returns null on a missing file (never throws)', () => {
    expect(parseTokensFromTranscript('/nonexistent/path/transcript.jsonl')).toBeNull();
  });

  test('returns null on empty/invalid path argument', () => {
    expect(parseTokensFromTranscript('')).toBeNull();
    // @ts-expect-error testing runtime robustness
    expect(parseTokensFromTranscript(null)).toBeNull();
    // @ts-expect-error testing runtime robustness
    expect(parseTokensFromTranscript(undefined)).toBeNull();
  });
});

// v0.26.1 — 텍스트 플러시 지연 감지용 헬퍼 (결함 I)
describe('assistantEntriesAfterLastText', () => {
  const textEntry = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  const thinkingEntry = () =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
    });
  const userEntry = () =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });

  test('마지막 텍스트 엔트리 이후의 assistant 엔트리만 센다', () => {
    const path = writeTranscript([
      textEntry('오래된 텍스트'),
      thinkingEntry(),
      userEntry(), // user 엔트리는 세지 않는다
      thinkingEntry(),
      thinkingEntry(),
    ]);
    expect(assistantEntriesAfterLastText(path)).toBe(3);
  });

  test('마지막 엔트리가 텍스트면 0 (지연 없음)', () => {
    const path = writeTranscript([thinkingEntry(), thinkingEntry(), textEntry('최신 텍스트')]);
    expect(assistantEntriesAfterLastText(path)).toBe(0);
  });

  test('텍스트 엔트리가 하나도 없으면 assistant 엔트리 전체를 센다', () => {
    const path = writeTranscript([thinkingEntry(), thinkingEntry()]);
    expect(assistantEntriesAfterLastText(path)).toBe(2);
  });

  test('깨진 줄은 건너뛴다', () => {
    const path = writeTranscript(['not json', textEntry('t'), '{broken', thinkingEntry()]);
    expect(assistantEntriesAfterLastText(path)).toBe(1);
  });

  test('없는 파일/빈 경로는 0 (fail-open)', () => {
    expect(assistantEntriesAfterLastText('/nonexistent/x.jsonl')).toBe(0);
    expect(assistantEntriesAfterLastText('')).toBe(0);
  });
});
