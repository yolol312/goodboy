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
   *  true 조건: GOODBOY_CONTEXT_LIMIT 명시 / 1M로 확정(표식·안전상향) / 1M 미지원 세대의 확정 200K.
   *  false: 1M 지원 세대(opus/sonnet 4+)인데 [1m] 표식 없음, 또는 미지 모델. */
  confident: boolean;
  /** H4-03: usage 줄에서 관측된 상이한 모델 ID들(등장 순서 유지).
   *  usage 줄은 메인 루프 요청에서만 나오므로(서브에이전트 usage는 별도 transcript),
   *  2개 이상이면 세션 내 메인 모델 전환(캐시 무효화)으로 본다. */
  modelsSeen: string[];
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
 *  GOODBOY_CONTEXT_LIMIT이 양의 정수로 설정돼 있으면 그 값을 반환, 아니면 null.
 *
 *  ⚠️ 왜 필요한가: transcript usage 줄에 찍히는 실제 모델 ID(예: `claude-opus-4-8`)에는
 *  1M 확장 컨텍스트 표식(`[1m]` 등)이 없다. 1M은 세션 토글이라 모델 ID로는 200K/1M을
 *  구분할 수 없다. 따라서 1M 창을 쓰는 사용자는 이 env로 한도를 명시하는 것이 가장 정확하다.
 *  (예: `GOODBOY_CONTEXT_LIMIT=1000000`) 파싱 실패/음수/0/비수치 → null(무시). */
function envContextLimitOverride(): number | null {
  try {
    const v = process.env.GOODBOY_CONTEXT_LIMIT;
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

/** 모델 ID가 "1M이 기본값이자 최대인 패밀리"인지 판별한다(모델별 확정 테이블).
 *
 *  Opus/Sonnet 4.6+는 1M이 세션 토글이라 모델 ID만으로 창을 확정할 수 없지만,
 *  Fable/Mythos 패밀리는 토글이 아니라 **1M이 기본값이자 최대**다(공식 모델 카탈로그 기준,
 *  Models API `max_input_tokens`로도 확인 가능). 즉 ID만으로 창이 확정된다 →
 *  표식 없이도 1M로 신뢰하고 강제 compact를 정상 작동시킨다.
 *
 *  유지보수: 새 "항상 1M" 패밀리가 나오면 여기에 추가한다. 목록에 없는 신규 패밀리는
 *  기존 원칙대로 미확정 처리되며(GOODBOY_CONTEXT_LIMIT으로 복구), 완전 동적 조회
 *  (Models API GET /v1/models/{id})는 hook 환경의 네트워크/인증 제약으로 채택하지 않았다. */
export function modelIsAlwaysExtended(model: string | null | undefined): boolean {
  if (!model || typeof model !== 'string') return false;
  return /fable|mythos/.test(model.toLowerCase());
}

/** settings.json(주어진 경로)의 `model` 문자열. 없거나 읽기/파싱 실패면 null.
 *  신뢰도 중간: CLI `--model` 오버라이드로 실제 세션 모델과 다를 수 있어 폴백으로만 쓴다.
 *  경로는 호출측이 `$HOME/.claude/settings.json`처럼 HOME 기반으로 넘긴다(하드코딩 금지). */
function settingsModelString(settingsPath: string | null | undefined): string | null {
  if (!settingsPath || typeof settingsPath !== 'string') return null;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { model?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string') {
      return parsed.model;
    }
  } catch {
    // 조용히 skip (파일 없음/권한/깨진 JSON 등)
  }
  return null;
}

/** 모델 ID의 베이스(표식 `[...]` 제거 + 소문자). */
function modelBase(m: string): string {
  return m.toLowerCase().replace(/\[[^\]]*\]/g, '').trim();
}

/** 두 모델 ID가 같은 베이스인지(한쪽이 다른 쪽의 접두 — 날짜 접미사 허용). */
function sameModelBase(a: string, b: string): boolean {
  const x = modelBase(a);
  const y = modelBase(b);
  if (x === '' || y === '') return false;
  return x.startsWith(y) || y.startsWith(x);
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
 *   1) GOODBOY_CONTEXT_LIMIT env override — 최우선(모델 판별 무시).
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
  // 2c) settings.json 폴백 — 단, 관측된 세션 모델과 충돌하면 무시한다(2-D, 라이브 검증 발견).
  //   settings의 기본 모델에 [1m]이 있어도, 이 세션이 `--model`로 다른 모델을 쓰고 있다면
  //   (usage 줄/훅 모델의 베이스가 settings 모델과 다름) 그 표식은 이 세션의 신호가 아니다.
  //   실측 사고: settings에 claude-fable-5[1m] + `--model haiku` 세션 → haiku가 1M로
  //   오판되어 compact 강제가 사실상 비활성화됐다.
  const settingsModel = settingsModelString(inp.settingsPath);
  if (settingsModel && modelHasExtendedMarker(settingsModel)) {
    const observed = inp.usageLineModel ?? inp.hookModel ?? null;
    if (!observed || sameModelBase(observed, settingsModel)) return EXTENDED_CONTEXT_LIMIT;
  }

  // 2.5) 모델별 확정 테이블: 1M이 기본값이자 최대인 패밀리(Fable/Mythos)는
  //      표식 없이도 모델 ID만으로 1M 확정(세션 토글이 아니므로 모호함이 없다).
  if (modelIsAlwaysExtended(inp.usageLineModel) || modelIsAlwaysExtended(inp.hookModel)) {
    return EXTENDED_CONTEXT_LIMIT;
  }

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

/** 모델 ID가 "확정적으로 200K 표준 컨텍스트만 지원하는 것으로 아는 모델"인지 판별한다(3-A 개정).
 *
 *  ⚠️ 설계 전환(v0.10): 이전에는 "1M 지원 세대(opus/sonnet 4+)"를 나열하고 나머지 Claude 계열을
 *  확정 200K로 간주했다. 이 방식은 새 모델 패밀리(예: claude-fable-5)가 나올 때마다
 *  자동으로 "확정 200K"로 오판되어, 실제 1M 세션에서 저토큰인데도 compact가 오강제되는
 *  구멍을 만든다(오판 목록이 아니라 오판 기본값이 문제). → 반대로 뒤집어
 *  "확정 200K로 아는 모델만" 화이트리스트로 나열하고, 그 외 모든 미지/신규 Claude 패밀리는
 *  "미확정"으로 처리해 강제 compact를 보류한다(H1-01 경고는 유지, GOODBOY_CONTEXT_LIMIT으로 복구).
 *
 *  확정 200K 목록: haiku 전 세대(1M 미지원), claude-2.x, claude-3.x(3-opus/3-5-sonnet 등).
 *  불매칭(→미확정): opus/sonnet 4+ 표식 없음, fable/mythos 등 신규 패밀리, 미래 ID 전부. */
export function modelIsKnownStandard(model: string | null | undefined): boolean {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase();
  // haiku 계열: 현재까지 전 세대 200K. (미래 haiku가 1M을 지원하게 되면 이 줄을 갱신할 것)
  if (m.includes('haiku')) return true;
  // claude-2.x / claude-3.x 세대: 1M 미지원 확정. 버전 첫 자리를 2-3으로 강제해
  // 날짜(YYYYMMDD)나 다른 숫자와의 오매칭을 막는다. 예: claude-3-5-sonnet-20241022, claude-3-opus.
  if (/claude[-_]?[23]([-._]|\b)/.test(m)) return true;
  if (/(^|[^0-9.])3[-.]5?[-.]?(opus|sonnet)/.test(m)) return true;
  return false;
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
  // H4-03: usage 줄에서 관측된 상이한 모델들(등장 순서).
  const modelsSeen: string[] = [];
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

    // (v0.27.6) 압축 경계 — 실사용 오탐: /compact 직후에도 assistant usage 엔트리의
    //   플러시 지연 때문에 압축 **전** 마지막 usage(예: 528K/1M=53%)가 "최신"으로 읽혀
    //   H1-03이 재차단됐다(실측: 압축 후 실제 64K=6%인데 pct=53 deny). 경계 마커
    //   (system/compact_boundary 또는 isCompactSummary 요약 엔트리)를 만나면 그 이전
    //   usage를 버린다 — 압축 후 usage가 아직 없으면 측정 실패(null)로 fail-open 되어
    //   강제가 발동하지 않고, 플러시되는 대로 압축 후 수치가 반영된다.
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      lastTokens = null;
      lastModel = null;
      continue;
    }
    if (obj.isCompactSummary === true) {
      lastTokens = null;
      lastModel = null;
      continue;
    }

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
      // H4-03: usage 줄의 모델을 관측 목록에 추가(중복 제외, 순서 유지).
      if (lastModel && !modelsSeen.includes(lastModel)) modelsSeen.push(lastModel);
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

  // 3-A(개정): limit 신뢰도 계산. 강제 compact는 confident일 때만 수행한다(모호한 200K 오탐 방지).
  //   - env 명시 또는 1M로 확정(표식/안전상향) → 신뢰.
  //   - limit=200K이고 모델이 "확정 200K 화이트리스트"(haiku, claude-2/3 세대) → 확정 200K.
  //   - 그 외 전부(opus/sonnet 4+ 표식 없음, fable 등 신규 패밀리, 비 Claude 미지 ID) → 미확정.
  //     미확정이어도 H1-01 절대 토큰 경고는 유지되고, GOODBOY_CONTEXT_LIMIT 명시로 강제를 복구한다.
  const anyModel = model ?? hookModel ?? null;
  const knownStandard = modelIsKnownStandard(anyModel) || modelIsKnownStandard(hookModel);
  const confident =
    envContextLimitOverride() !== null || limit === EXTENDED_CONTEXT_LIMIT || knownStandard;

  return { percent, tokens: lastTokens, limit, model, confident, modelsSeen };
}
