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
  /** 3-A: limit을 신뢰할 수 있는지. false면 강제 compact를 하지 않는다(모호한 200K 가정 회피).
   *  true 조건: VCF_CONTEXT_LIMIT 명시 / 1M로 확정(표식·안전상향) / 1M 미지원 세대의 확정 200K.
   *  false: 1M 지원 세대(opus/sonnet 4+)인데 [1m] 표식 없음, 또는 미지 모델. */
  confident: boolean;
}

// --- 모델 컨텍스트 한도 상수 -------------------------------------------------
// 표준 Claude 모델(Opus/Sonnet/Haiku 기본)의 컨텍스트 한도.
const STANDARD_CONTEXT_LIMIT = 200_000;
// extended context(1M) 모델의 컨텍스트 한도.
const EXTENDED_CONTEXT_LIMIT = 1_000_000;
// 모델 판별 불가 시 보수적으로 표준 한도를 쓴다 — 한도를 작게 잡아야 percent가 커져
// 경고가 더 일찍 뜨므로 컨텍스트 폭주를 더 안전하게 막는다.
const DEFAULT_CONTEXT_LIMIT = STANDARD_CONTEXT_LIMIT;

/** env override로 강제할 컨텍스트 한도(토큰수)를 읽는다.
 *  VCF_CONTEXT_LIMIT이 양의 정수로 설정돼 있으면 그 값을 반환, 아니면 null.
 *
 *  ⚠️ 왜 필요한가: transcript usage 줄에 찍히는 실제 모델 ID(예: `claude-opus-4-8`)에는
 *  1M 확장 컨텍스트 표식(`[1m]` 등)이 없다. 1M은 세션 토글이라 모델 ID로는 200K/1M을
 *  구분할 수 없다. 따라서 1M 창을 쓰는 사용자는 이 env로 한도를 명시하는 것이 가장 정확하다.
 *  (예: `VCF_CONTEXT_LIMIT=1000000`) 파싱 실패/음수/0/비수치 → null(무시). */
function envContextLimitOverride(): number | null {
  try {
    const v = process.env.VCF_CONTEXT_LIMIT;
    if (v === undefined || v.trim() === '') return null;
    const n = parseInt(v.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

/** 모델 문자열에 1M 확장 컨텍스트 표식(`[1m]` 등)이 있으면 true. (limitForModel 재사용) */
function modelHasExtendedMarker(model: string | null | undefined): boolean {
  if (!model || typeof model !== 'string') return false;
  return limitForModel(model) === EXTENDED_CONTEXT_LIMIT;
}

/** settings.json(주어진 경로)의 `model` 필드에 1M 표식이 있으면 true.
 *  신뢰도 중간: CLI `--model` 오버라이드로 실제 세션 모델과 다를 수 있어 폴백으로만 쓴다.
 *  경로 미제공/읽기 실패/파싱 실패 → 조용히 false(fail-open). 경로는 호출측이
 *  `$HOME/.claude/settings.json`처럼 HOME 기반으로 넘긴다(여기서 하드코딩하지 않음). */
function settingsModelHasExtended(settingsPath: string | null | undefined): boolean {
  if (!settingsPath || typeof settingsPath !== 'string') return false;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { model?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string') {
      return modelHasExtendedMarker(parsed.model);
    }
  } catch {
    // 조용히 skip (파일 없음/권한/깨진 JSON 등)
  }
  return false;
}

/** 한 transcript 줄(객체)에서 "구조적(파싱된) 모델 필드"에 1M 표식이 있는지 검사한다.
 *  검사 대상: obj.model / obj.resolvedModel / obj.message.model / obj.message.message.model /
 *            obj.response.model / obj.toolUseResult.resolvedModel.
 *  ⚠️ 대화 본문 텍스트에 우연히 들어간 "[1m]"(예: 사용자가 붙여넣은 로그/문서)을 오탐하지 않도록
 *     반드시 파싱된 모델 필드만 본다(원문 line을 문자열 검색하지 않는다).
 *  근거: 실제 transcript에서 usage 줄의 message.model은 표식이 없지만(`claude-opus-4-8`),
 *        Task/Agent tool 결과의 toolUseResult.resolvedModel에는 `claude-opus-4-8[1m]`이 남는다. */
function objectHasExtendedModelMarker(obj: Record<string, unknown>): boolean {
  const candidates: unknown[] = [];
  const push = (c: unknown): void => {
    if (!c || typeof c !== 'object') return;
    const o = c as Record<string, unknown>;
    candidates.push(o.model, o.resolvedModel);
  };
  push(obj);
  if (obj.message && typeof obj.message === 'object') {
    push(obj.message);
    push((obj.message as Record<string, unknown>).message);
  }
  push(obj.response);
  push(obj.toolUseResult);
  for (const c of candidates) {
    if (typeof c === 'string' && modelHasExtendedMarker(c)) return true;
  }
  return false;
}

interface LimitInputs {
  /** usage 줄에서 읽은 모델(표시/기본 판별용). */
  usageLineModel: string | null;
  /** 현재 점유 토큰(안전 상향 판단용). */
  tokens: number;
  /** 훅 입력(Stop/PreToolUse stdin)의 model 필드. 있으면 최우선 동적 신호. */
  hookModel?: string | null;
  /** transcript의 구조적 모델 필드에서 1M 표식을 본 적이 있으면 true. */
  transcriptExtended?: boolean;
  /** settings.json 경로($HOME 기반). 미제공 시 settings 폴백을 건너뛴다. */
  settingsPath?: string | null;
}

/** 최종 컨텍스트 한도를 결정한다(우선순위 명확).
 *   1) VCF_CONTEXT_LIMIT env override — 최우선(모델 판별 무시).
 *   2) 런타임 동적 감지 — 신뢰 순서대로:
 *        (a) 훅 입력의 model 필드에 1M 표식 → 1M (있으면 가장 신뢰; 현재 CC 훅엔 대개 없음).
 *        (b) transcript 구조적 모델 필드(resolvedModel 등)에 1M 표식 → 1M (실측 가능·신뢰).
 *        (c) settings.json의 model에 1M 표식 → 1M (신뢰도 중간; CLI 오버라이드 가능, 폴백).
 *      → 표식 없는 1M 세션이 저토큰(예: 150K)일 때 200K로 오판되던 구멍을 닫는다.
 *   3) 기존 usage-줄 모델 표식 기반 판별(limitForModel). (2b가 사실상 포함하지만 방어적으로 유지)
 *   4) 안전 상향(오탐 회피): 관측 토큰이 (3)의 한도를 초과하면 물리적으로 그 창일 수 없으므로
 *      최소 1M으로 올린다. (추측이 아니라 논리적 하한 보정)
 *   5) 기본 200K.
 *  ⚠️ 어떤 1M 신호도 없으면 전역 기본은 그대로 200K를 유지한다(정상 200K 세션의 H1-03 유지).
 *  fail-open: 모든 소스 읽기는 실패해도 예외 없이 다음 순위로 진행한다. */
function resolveContextLimit(inp: LimitInputs): number {
  // 1) env override — 최우선
  const override = envContextLimitOverride();
  if (override !== null) return override;

  // 2) 런타임 동적 감지: 훅 모델 → transcript 구조적 표식 → settings.json
  if (modelHasExtendedMarker(inp.hookModel)) return EXTENDED_CONTEXT_LIMIT;
  if (inp.transcriptExtended === true) return EXTENDED_CONTEXT_LIMIT;
  if (settingsModelHasExtended(inp.settingsPath)) return EXTENDED_CONTEXT_LIMIT;

  // 3) 기존 usage-줄 모델 표식 판별
  const modelLimit = limitForModel(inp.usageLineModel);
  if (modelLimit === EXTENDED_CONTEXT_LIMIT) return EXTENDED_CONTEXT_LIMIT;

  // 4) 토큰이 후보 한도를 넘음 → 창이 더 크다. 최소 1M으로 보정.
  if (Number.isFinite(inp.tokens) && inp.tokens > modelLimit) {
    return Math.max(modelLimit, EXTENDED_CONTEXT_LIMIT);
  }

  // 5) 기본(200K)
  return modelLimit;
}

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
  // 1M extended context 표식들. `[1m]`(예: claude-opus-4-8[1m]) 또는 -1m 등.
  //   4-4: bare '1m'을 includes로 보면 임의 문자열(날짜/해시)에 우연히 섞인 '1m'을 1M로 오판할 수 있어,
  //   앞뒤가 영숫자가 아닌 "경계 있는" 1m만 인정한다(예: [1m], -1m). `41m`/`1mb` 같은 건 매칭 안 함.
  const bounded1m = /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(m);
  if (
    m.includes('[1m]') ||
    bounded1m ||
    m.includes('1-million') ||
    m.includes('1million') ||
    m.includes('1000k')
  ) {
    return EXTENDED_CONTEXT_LIMIT;
  }
  // 그 외 식별 가능한 Claude 모델은 표준 한도. 식별 불가도 보수적으로 같은 값.
  return STANDARD_CONTEXT_LIMIT;
}

/** 모델 ID가 "1M 확장 컨텍스트를 지원하는 세대"인지 대략 판별한다(휴리스틱, 3-A).
 *  1M 창은 세션 토글이라, 지원 세대(opus/sonnet 4.x+)는 [1m] 표식 없이는 200K/1M을 구분할 수 없다.
 *  → 표식이 없을 때 이 함수가 true면 한도를 "미확정"으로 보고 강제 compact를 보류한다.
 *  매칭: opus-4-8 / sonnet-4-5 / sonnet-5 등. 불매칭: claude-3-5-sonnet-YYYYMMDD(날짜의 두 자리
 *  오매칭을 막으려 버전 첫 자리를 4-9로 강제), 3-opus, haiku 등(1M 미지원 → 확정 200K).
 *  미지/미래 ID는 여기선 false지만, confident 계산에서 "Claude 계열로 안 보이면 미확정"으로 처리한다. */
export function modelIsExtendedCapable(model: string | null | undefined): boolean {
  if (!model || typeof model !== 'string') return false;
  return /(opus|sonnet)-[4-9]\d?(?:[-.]|\b)/.test(model.toLowerCase());
}

/** transcript(JSONL)에서 "현재 컨텍스트 점유율"을 계산한다.
 *
 *  현재 점유 = 가장 최근 assistant usage의 (input + cache_read + cache_creation).
 *  - usage를 가진 줄들 중 파일에서 가장 마지막(가장 최근) 것을 채택한다(누적 아님).
 *  - 모델 한도는 같은(또는 가장 최근의) model 필드로 판별, 불가 시 200_000.
 *  - transcript 없음/읽기 실패/usage 전무/garbage → null 반환(절대 throw 안 함).
 *    이 null은 "측정 실패" 신호로, 호출측은 경고를 띄우지 않는다.
 *  - 깨진 줄은 조용히 skip. */
export interface GetContextUsageOptions {
  /** 훅 입력 객체(Stop/PreToolUse stdin). model 필드 접근용. 없으면 무시. */
  hookInput?: { model?: unknown } | null;
  /** settings.json 경로($HOME 기반). 미제공 시 settings 폴백을 건너뛴다. */
  settingsPath?: string | null;
}

export function getContextUsage(
  transcriptPath: string,
  opts?: GetContextUsageOptions,
): ContextUsage | null {
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
  // transcript 어느 줄이든 구조적 모델 필드에 1M 표식이 있었으면 true(런타임 동적 감지 핵심 소스).
  let sawExtendedMarker = false;

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

    // 구조적 모델 필드(resolvedModel 등)에 1M 표식을 관측하면 기억한다(대화 본문 텍스트는 검사 안 함).
    try {
      if (!sawExtendedMarker && objectHasExtendedModelMarker(obj)) sawExtendedMarker = true;
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
  // 훅 입력의 model 필드(있으면). 표식 유무만 쓰므로 문자열이면 그대로 넘긴다.
  const hookModel = (() => {
    try {
      const m = opts?.hookInput?.model;
      return typeof m === 'string' && m.trim() !== '' ? m : null;
    } catch {
      return null;
    }
  })();
  // 한도 결정: env override > 런타임 동적 감지(훅 모델 → transcript 표식 → settings.json)
  //           > usage-줄 모델 표식 > 토큰 기반 안전 상향 > 기본 200K.
  const limit = resolveContextLimit({
    usageLineModel: model,
    tokens: lastTokens,
    hookModel,
    transcriptExtended: sawExtendedMarker,
    settingsPath: opts?.settingsPath ?? null,
  });
  const percent = limit > 0 ? (lastTokens / limit) * 100 : 0;

  // 3-A: limit 신뢰도 계산. 강제 compact는 confident일 때만 수행한다(모호한 200K 오탐 방지).
  //   - env 명시 또는 1M로 확정(표식/안전상향) → 신뢰.
  //   - limit=200K이고 모델이 "Claude 계열이면서 1M 미지원 세대"(예: 3.5-sonnet, haiku) → 확정 200K.
  //   - 1M 지원 세대(opus/sonnet 4+)인데 표식 없음, 또는 Claude 계열로 안 보이는 미지 ID → 미확정.
  const anyModel = model ?? hookModel ?? null;
  const looksClaude =
    typeof anyModel === 'string' && /claude|opus|sonnet|haiku/.test(anyModel.toLowerCase());
  const extendedCapable = modelIsExtendedCapable(anyModel) || modelIsExtendedCapable(hookModel);
  const confident =
    envContextLimitOverride() !== null ||
    limit === EXTENDED_CONTEXT_LIMIT ||
    (looksClaude && !extendedCapable);

  return { percent, tokens: lastTokens, limit, model, confident };
}
