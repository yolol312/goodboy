// 현재 컨텍스트 점유율 계산. 공식 transcript 스키마 없음 — try/catch로 안전하게.
//
// transcript-parser.ts(누적 합산)와 목적이 다르다:
//   - transcript-parser: 세션 전체 토큰 누적 합 (요금/총량 추정)
//   - 여기:            "지금 컨텍스트에 올라가 있는" 토큰 = 가장 최근 assistant 요청이
//                       모델에 보낸 입력 토큰량(input + cache_read + cache_creation).
//                       이게 현재 점유율에 가장 가깝다(누적이 아님).

import { readFileSync } from 'node:fs';

export interface ContextUsage {
  /** tokens / limit * 100 */
  percent: number;
  /** 가장 최근 요청의 input + cache_read + cache_creation 합 */
  tokens: number;
  /** 판별한 모델 컨텍스트 한도 (예: 200_000 또는 1_000_000) */
  limit: number;
  /** transcript에서 읽은 모델명(없으면 null) */
  model: string | null;
}

// --- 모델 컨텍스트 한도 상수 -------------------------------------------------
// 표준 Claude 모델(Opus/Sonnet/Haiku 기본)의 컨텍스트 한도.
const STANDARD_CONTEXT_LIMIT = 200_000;
// extended context(1M) 모델의 컨텍스트 한도.
const EXTENDED_CONTEXT_LIMIT = 1_000_000;
// 모델 판별 불가 시 보수적으로 표준 한도를 쓴다 — 한도를 작게 잡아야 percent가 커져
// 경고가 더 일찍 뜨므로 컨텍스트 폭주를 더 안전하게 막는다.
const DEFAULT_CONTEXT_LIMIT = STANDARD_CONTEXT_LIMIT;

interface UsageLike {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // camelCase 변형(일부 도구/SDK 래퍼가 이렇게 직렬화)
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  // 짧은 키 변형(드물게 prompt 형태로 기록되기도 함)
  prompt_tokens?: number;
}

/** 후보 값들 중 첫 번째 유효한(유한) 숫자를 반환. 없으면 null. */
function pickNumber(...candidates: Array<unknown>): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

/** usage 객체에서 "현재 컨텍스트 점유 입력 토큰"을 계산한다.
 *  = input + cache_read + cache_creation.
 *  하나라도 유효한 숫자가 있으면 그 합을 반환, 아무 입력 토큰도 없으면 null. */
function contextTokensFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as UsageLike;

  const input = pickNumber(u.input_tokens, u.inputTokens, u.prompt_tokens);
  const cacheRead = pickNumber(u.cache_read_input_tokens, u.cacheReadInputTokens);
  const cacheCreation = pickNumber(u.cache_creation_input_tokens, u.cacheCreationInputTokens);

  if (input === null && cacheRead === null && cacheCreation === null) return null;

  return (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
}

/** 한 객체에서 usage가 있을 법한 위치들을 모두 시도해 컨텍스트 토큰을 추출한다.
 *  알려진 모양(transcript-parser.ts와 동일 방어 수준):
 *    - obj.usage
 *    - obj.message.usage
 *    - obj.response.usage
 *    - obj.message.message.usage (이중 래핑)
 *    - obj.delta.usage / obj.result.usage
 *  여러 곳에서 usage가 보이면 가장 큰 합을 채택(가장 완전한 usage일 가능성).
 *  하나도 없으면 null. */
function contextTokensFromObject(obj: Record<string, unknown>): number | null {
  let best: number | null = null;

  const consider = (container: unknown): void => {
    if (!container || typeof container !== 'object') return;
    const c = container as Record<string, unknown>;
    if (c.usage && typeof c.usage === 'object') {
      const t = contextTokensFromUsage(c.usage);
      if (t !== null && (best === null || t > best)) best = t;
    }
  };

  consider(obj);
  if (obj.message && typeof obj.message === 'object') {
    consider(obj.message);
    const m = obj.message as Record<string, unknown>;
    consider(m.message);
  }
  consider(obj.response);
  consider(obj.delta);
  consider(obj.result);

  return best;
}

/** 한 객체에서 모델명이 있을 법한 위치들을 시도한다.
 *  알려진 모양: obj.model, obj.message.model, obj.response.model,
 *               obj.message.message.model. 없으면 null. */
function modelFromObject(obj: Record<string, unknown>): string | null {
  const pickStr = (container: unknown): string | null => {
    if (!container || typeof container !== 'object') return null;
    const c = container as Record<string, unknown>;
    if (typeof c.model === 'string' && c.model.trim() !== '') return c.model;
    return null;
  };

  let m = pickStr(obj);
  if (m) return m;
  if (obj.message && typeof obj.message === 'object') {
    m = pickStr(obj.message);
    if (m) return m;
    const inner = (obj.message as Record<string, unknown>).message;
    m = pickStr(inner);
    if (m) return m;
  }
  m = pickStr(obj.response);
  if (m) return m;
  return null;
}

/** 모델명으로 컨텍스트 한도를 판별한다.
 *  extended context(1M) 표식(`[1m]`, `1m`, `1-million`, `1000k`, `-1m` 등)이 있으면 1_000_000.
 *  명시적으로 표준 모델로 식별되면 200_000.
 *  판별 불가(또는 model 없음) → 보수적으로 DEFAULT(200_000). */
function limitForModel(model: string | null): number {
  if (!model || typeof model !== 'string') return DEFAULT_CONTEXT_LIMIT;
  const m = model.toLowerCase();
  // 1M extended context 표식들. `[1m]`(예: claude-opus-4-8[1m]) 또는 1m/1-million/1000k 등.
  if (
    m.includes('[1m]') ||
    m.includes('1m') ||
    m.includes('1-million') ||
    m.includes('1million') ||
    m.includes('1000k')
  ) {
    return EXTENDED_CONTEXT_LIMIT;
  }
  // 그 외 식별 가능한 Claude 모델은 표준 한도. 식별 불가도 보수적으로 같은 값.
  return STANDARD_CONTEXT_LIMIT;
}

/** transcript(JSONL)에서 "현재 컨텍스트 점유율"을 계산한다.
 *
 *  현재 점유 = 가장 최근 assistant usage의 (input + cache_read + cache_creation).
 *  - usage를 가진 줄들 중 파일에서 가장 마지막(가장 최근) 것을 채택한다(누적 아님).
 *  - 모델 한도는 같은(또는 가장 최근의) model 필드로 판별, 불가 시 200_000.
 *  - transcript 없음/읽기 실패/usage 전무/garbage → null 반환(절대 throw 안 함).
 *    이 null은 "측정 실패" 신호로, 호출측은 경고를 띄우지 않는다.
 *  - 깨진 줄은 조용히 skip. */
export function getContextUsage(transcriptPath: string): ContextUsage | null {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;

  let content: string;
  try {
    content = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  let lines: string[];
  try {
    lines = content.split(/\r?\n/);
  } catch {
    return null;
  }

  // 가장 최근(파일에서 가장 마지막) usage를 추적.
  let lastTokens: number | null = null;
  // 모델은 usage를 가진 마지막 줄의 model을 우선하고, 없으면 가장 최근에 본 어떤 model이라도 사용.
  let lastModel: string | null = null;
  let lastModelAny: string | null = null;

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

    const obj = parsed as Record<string, unknown>;

    // 모델은 보이는 대로 가장 최근 값을 따로 기억(usage 줄에 model이 없을 때의 폴백).
    try {
      const m = modelFromObject(obj);
      if (m) lastModelAny = m;
    } catch {
      // 무시
    }

    let tokens: number | null = null;
    try {
      tokens = contextTokensFromObject(obj);
    } catch {
      // 예상 못 한 모양에서 접근이 throw 하면 그 줄만 버린다
      continue;
    }
    if (tokens !== null) {
      // 더 뒤(더 최근)의 usage가 현재 점유에 가깝다 → 덮어쓴다.
      lastTokens = tokens;
      try {
        lastModel = modelFromObject(obj);
      } catch {
        lastModel = null;
      }
    }
  }

  if (lastTokens === null) return null; // usage를 한 번도 못 찾음 → 측정 실패

  const model = lastModel ?? lastModelAny;
  const limit = limitForModel(model);
  const percent = limit > 0 ? (lastTokens / limit) * 100 : 0;

  return { percent, tokens: lastTokens, limit, model };
}
