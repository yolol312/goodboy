// best-effort transcript 파싱. 공식 스키마 없음 — try/catch로 안전하게.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

/** transcript 한 줄이 user 메시지면 그 텍스트를, 아니면 null.
 *  assistantTextFromLine의 대칭 — 층0이 "사용자가 먼저 쓴 인용"을 모델 주장에서 빼는 데 쓴다. */
export function userTextFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = obj.type as string | undefined;
  const role = (obj.role ?? (obj.message && (obj.message as Record<string, unknown>).role)) as
    | string
    | undefined;
  if (type !== 'user' && role !== 'user') return null;

  const msg = (obj.message ?? obj) as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object') {
        const cc = c as Record<string, unknown>;
        // tool_result는 사용자가 쓴 글이 아니라 도구 출력이므로 제외한다.
        if (cc.type === 'text' && typeof cc.text === 'string') parts.push(cc.text);
      } else if (typeof c === 'string') {
        parts.push(c);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

/** 마지막(가장 최근) 최대 n개의 user 메시지 텍스트를 최신순으로 반환. */
export function extractRecentUserTexts(transcriptPath: string, n: number): string[] {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return [];
    const lines = readFileSync(transcriptPath, 'utf8').split('\n');
    const out: string[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const t = userTextFromLine(lines[i] ?? '');
      if (t !== null && t.trim() !== '') out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}

export interface AssistantTextEntry {
  text: string;
  /** transcript 엔트리의 생성 시각(epoch ms). 필드가 없거나 파싱 불가면 null.
   *  ⚠️ 이 시각은 "생성" 시각이다 — 지연 하니스에서는 파일 기록(플러시)이 이보다
   *  수십 초 늦게 일어난다(실측). 추론 게이트의 지연 확정(lag-confirm)이 이 차이를 쓴다. */
  timestampMs: number | null;
}

/** transcript 한 줄에서 엔트리 생성 시각(top-level timestamp)을 epoch ms로 추출. 실패 시 null. */
function timestampFromLine(line: string): number | null {
  try {
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    const ts = obj.timestamp;
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    return null;
  } catch {
    return null;
  }
}

/** 마지막(가장 최근) 최대 n개의 assistant message 텍스트를 생성 시각과 함께 최신순으로 반환.
 *  파싱 실패/없음이면 빈 배열. 게이트는 fail-open을 위해 길이 0을 별도 처리한다. */
export function extractRecentAssistantTextEntries(
  transcriptPath: string,
  n: number,
): AssistantTextEntry[] {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return [];
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const entries: AssistantTextEntry[] = [];
    // 뒤에서부터 훑어 최근 n개의 assistant message 텍스트 수집
    for (let i = lines.length - 1; i >= 0 && entries.length < n; i--) {
      const line = lines[i] ?? '';
      const text = assistantTextFromLine(line);
      if (text !== null) entries.push({ text, timestampMs: timestampFromLine(line) });
    }
    return entries;
  } catch {
    return [];
  }
}

/** 마지막(가장 최근) 최대 n개의 assistant message 텍스트를 최신순으로 반환.
 *  파싱 실패/없음이면 빈 배열. 게이트는 fail-open을 위해 길이 0을 별도 처리한다. */
export function extractRecentAssistantTexts(transcriptPath: string, n: number): string[] {
  return extractRecentAssistantTextEntries(transcriptPath, n).map((e) => e.text);
}

/**
 * 마지막 assistant 텍스트가 **이번 턴의 것**인지에 대한 3값 판정.
 *
 *   'fresh'   — 마지막 사용자 프롬프트 뒤에 답변 텍스트가 있다. 판정 가능.
 *   'pending' — 사용자 프롬프트는 있는데 그 뒤의 답변 텍스트가 아직 없다. 기록 지연 중이므로
 *               호출부가 잠깐 기다려 볼 가치가 있다.
 *   'unknown' — 사용자 프롬프트 자체가 없다(합성 transcript, 도구 전용 기록 등).
 *               기다려도 나타나지 않으므로 **대기 없이** 건너뛴다.
 *
 * Stop 훅은 이번 턴 답변이 transcript에 기록되기 전에 실행될 수 있다 — 라이브 실측(P7):
 * 답변 기록 04:13:31.914Z, 훅 실행 04:13:32.044Z로 130ms 차. 이 구분이 없으면 층0 인용
 * 게이트가 판정 대상을 못 보고 환각 인용을 통째로 놓치거나(P7: 3건 전부 미검출),
 * 반대로 **직전 턴의 답변**을 판정해 이미 정정한 주장을 재차단한다.
 *
 * 사용자 프롬프트만 기준으로 삼는다 — tool_result는 `userTextFromLine`이 이미 걸러낸다.
 * 파싱 실패/파일 없음은 'unknown'.
 */
export type AssistantTextFreshness = 'fresh' | 'pending' | 'unknown';

export function assistantTextFreshness(transcriptPath: string): AssistantTextFreshness {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return 'unknown';
    const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
    let lastUser = -1;
    let lastAssistantText = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '') continue;
      if (userTextFromLine(line) !== null) lastUser = i;
      else if (assistantTextFromLine(line) !== null) lastAssistantText = i;
    }
    if (lastUser < 0) return 'unknown';
    return lastAssistantText > lastUser ? 'fresh' : 'pending';
  } catch {
    return 'unknown';
  }
}

/** 서브에이전트의 전용 transcript 경로를 해석한다.
 *
 *  ⚠️ 라이브 검증에서 발견된 중대 버그 대응: hook은 서브에이전트의 도구 호출에도
 *  메인 세션의 transcript_path를 넘겨준다. 그래서 추론 게이트가 "서브에이전트가 쓴 ## 추론"이
 *  아니라 "메인이 쓴 글"을 검사했고, 서브에이전트는 추론 섹션을 9번 출력하고도 편집이
 *  8번 전부 차단됐다(= 위임 편집이 원천 불가, 모델은 Bash 우회로 도피).
 *
 *  Claude Code 레이아웃(비공식): <proj>/<sessionUuid>.jsonl 옆에
 *                               <proj>/<sessionUuid>/subagents/agent-<agentId>.jsonl
 *  존재하지 않으면 null (호출부는 fail-open 하거나 게이트를 건너뛴다). */
export function agentTranscriptPath(mainTranscript: string, agentId: string): string | null {
  try {
    if (!mainTranscript || !agentId) return null;
    if (!/^[\w-]+$/.test(agentId)) return null; // path traversal 방지
    const dir = dirname(mainTranscript);
    const base = basename(mainTranscript).replace(/\.jsonl$/, '');
    const p = join(dir, base, 'subagents', `agent-${agentId}.jsonl`);
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** 한 transcript 줄이 assistant 엔트리인지(텍스트 유무 무관 — thinking/tool_use만 있어도 true). */
function isAssistantLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const type = obj.type as string | undefined;
    const role = (obj.role ?? (obj.message && (obj.message as Record<string, unknown>).role)) as
      | string
      | undefined;
    return type === 'assistant' || role === 'assistant';
  } catch {
    return false;
  }
}

/** 마지막 "텍스트를 가진 assistant 엔트리" 이후에 나온 assistant 엔트리 수.
 *  일부 하니스는 텍스트 블록 기록이 지연되어(thinking/tool_use는 즉시 기록)
 *  추론 게이트가 최신 텍스트를 볼 수 없다. 이 수가 크면 "텍스트 플러시 지연 중"
 *  신호로 보고 게이트를 fail-open 한다. 파싱 실패 시 0. */
export function assistantEntriesAfterLastText(transcriptPath: string): number {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return 0;
    const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
    let count = 0;
    for (const line of lines) {
      if (!isAssistantLine(line)) continue;
      if (assistantTextFromLine(line) !== null) {
        // 텍스트를 가진 assistant 엔트리 → 이후 카운트를 리셋
        count = 0;
      } else {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/** transcript에 assistant 메시지가 하나라도 있는지(텍스트 유무 무관 — thinking/tool_use만 있어도 true).
 *  추론 게이트가 "파싱 실패(fail-open 대상)"와 "모델이 아무 텍스트 없이 편집 시도(차단 대상)"를
 *  구별하는 데 쓴다(라이브 검증에서 발견된 무언 편집 우회 대응). 실패는 false. */
export function hasAssistantMessages(transcriptPath: string): boolean {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return false;
    for (const line of readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        const type = obj.type as string | undefined;
        const role = (obj.role ??
          (obj.message && (obj.message as Record<string, unknown>).role)) as string | undefined;
        if (type === 'assistant' || role === 'assistant') return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}
