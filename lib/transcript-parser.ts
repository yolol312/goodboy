// best-effort transcript 파싱. 공식 스키마 없음 — try/catch로 안전하게.

import { existsSync, readFileSync } from 'node:fs';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // camelCase 변형(일부 도구/SDK 래퍼가 이렇게 직렬화)
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  // 짧은 키 변형(드물게 prompt/completion 형태로 기록되기도 함)
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** usage 객체에서 토큰을 acc에 더한다. 더해진 게 있으면 true. */
function safeAdd(acc: TokenUsage, usage: unknown): boolean {
  if (!usage || typeof usage !== 'object') return false;
  const u = usage as UsageLike;
  let touched = false;

  const input = pickNumber(u.input_tokens, u.inputTokens, u.prompt_tokens);
  if (input !== null) {
    acc.input += input;
    touched = true;
  }
  const output = pickNumber(u.output_tokens, u.outputTokens, u.completion_tokens);
  if (output !== null) {
    acc.output += output;
    touched = true;
  }
  const cacheRead = pickNumber(u.cache_read_input_tokens, u.cacheReadInputTokens);
  if (cacheRead !== null) {
    acc.cacheRead += cacheRead;
    touched = true;
  }
  const cacheCreation = pickNumber(u.cache_creation_input_tokens, u.cacheCreationInputTokens);
  if (cacheCreation !== null) {
    acc.cacheCreation += cacheCreation;
    touched = true;
  }

  return touched;
}

/** 후보 값들 중 첫 번째 유효한(유한) 숫자를 반환. 없으면 null. */
function pickNumber(...candidates: Array<unknown>): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

/** 한 객체에서 usage가 있을 법한 위치들을 모두 시도해 acc에 더한다.
 *  알려진 모양:
 *    - obj.usage
 *    - obj.message.usage
 *    - obj.response.usage
 *    - obj.message.message.usage (이중 래핑된 일부 transcript)
 *    - obj.delta.usage / obj.result.usage (스트리밍/결과 래퍼)
 *  reuturns: 이 객체에서 토큰을 하나라도 찾았으면 true. */
function accumulateFromObject(acc: TokenUsage, obj: Record<string, unknown>): boolean {
  let found = false;

  const tryUsageAt = (container: unknown): void => {
    if (!container || typeof container !== 'object') return;
    const c = container as Record<string, unknown>;
    if (c.usage && typeof c.usage === 'object') {
      if (safeAdd(acc, c.usage)) found = true;
    }
  };

  // 최상위 usage
  tryUsageAt(obj);
  // message.usage (+ 이중 래핑 message.message.usage)
  if (obj.message && typeof obj.message === 'object') {
    tryUsageAt(obj.message);
    const m = obj.message as Record<string, unknown>;
    tryUsageAt(m.message);
  }
  // response.usage
  tryUsageAt(obj.response);
  // delta.usage (스트리밍 message_delta 형태)
  tryUsageAt(obj.delta);
  // result.usage (결과 래퍼)
  tryUsageAt(obj.result);

  return found;
}

/** transcript_path는 보통 JSONL. 각 줄을 파싱해 usage 필드 합산 시도.
 *  여러 알려진 모양을 시도하고, 깨진 줄은 건너뛴다.
 *  토큰을 한 번도 찾지 못하면(또는 읽기 실패/garbage) null 반환 — 절대 throw 하지 않는다. */
export function parseTokensFromTranscript(transcriptPath: string): TokenUsage | null {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const acc: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let foundAny = false;

  let lines: string[];
  try {
    lines = content.split(/\r?\n/);
  } catch {
    return null;
  }

  for (const line of lines) {
    let trimmed: string;
    try {
      trimmed = line.trim();
    } catch {
      continue;
    }
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 깨진 줄은 조용히 건너뛴다
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    try {
      if (accumulateFromObject(acc, parsed as Record<string, unknown>)) {
        foundAny = true;
      }
    } catch {
      // 예상 못 한 모양에서 어떤 접근이 throw 해도 그 줄만 버린다
      continue;
    }
  }

  if (!foundAny) return null;
  return acc;
}

// --- assistant 텍스트 추출 (추론 게이트/추측-리뷰 연동 공용) --------------------
//   원래 pre-tool-use.ts 내부 헬퍼였으나, Stop hook(A2 추측-리뷰 연동)도 필요해져
//   lib으로 승격했다. best-effort: 파싱 실패는 조용히 건너뛴다.

/** 한 transcript 줄(JSON 객체)이 assistant message면 그 텍스트를 추출, 아니면 null. */
export function assistantTextFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  // 후보 1: { type: "assistant", message: { content: [...] } }
  const type = obj.type as string | undefined;
  const role = (obj.role ?? (obj.message && (obj.message as Record<string, unknown>).role)) as
    | string
    | undefined;
  if (type !== 'assistant' && role !== 'assistant') return null;

  // content 추출
  const msg = (obj.message ?? obj) as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object') {
        const cc = c as Record<string, unknown>;
        if (cc.type === 'text' && typeof cc.text === 'string') {
          parts.push(cc.text);
        }
      } else if (typeof c === 'string') {
        parts.push(c);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

/** 마지막(가장 최근) 최대 n개의 assistant message 텍스트를 최신순으로 반환.
 *  파싱 실패/없음이면 빈 배열. 게이트는 fail-open을 위해 길이 0을 별도 처리한다. */
export function extractRecentAssistantTexts(transcriptPath: string, n: number): string[] {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return [];
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const texts: string[] = [];
    // 뒤에서부터 훑어 최근 n개의 assistant message 텍스트 수집
    for (let i = lines.length - 1; i >= 0 && texts.length < n; i--) {
      const text = assistantTextFromLine(lines[i] ?? '');
      if (text !== null) texts.push(text);
    }
    return texts;
  } catch {
    return [];
  }
}
