// 토큰 낭비 습관(token-waste habit) 카탈로그 + 공통 헬퍼.
//
// tokenhabit이 식별한 "토큰을 낭비하는 작업 습관"을 goodboy hook이 막기 위한 중앙 카탈로그다.
// 새 습관을 추가할 때도 같은 틀(id / envVars / defaults / description)을 그대로 쓴다.
// 각 게이트/경고는 자신의 habit ID를 메시지/주석에 표기한다.
//
// 설계 원칙(엄수):
//   - fail-open: 모든 헬퍼는 예외를 삼키고 안전한 기본값을 반환. 정상 작업을 막지 않는다.
//   - 스팸 금지: 경고는 세션당/단계당 1회. "이미 경고함"을 habit-state.json에 기록한다.
//   - env 토글: 각 기능은 GOODBOY_ 접두사 env로 끄거나 임계값을 조정할 수 있다.

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureSessionDir } from './file-tracker';

// --- H2-02 임계 기본값(출력 크기 기반) --------------------------------------
// Bash 실행 후 실제 출력이 이 크기를 넘으면 사후 경고한다(사후 교정).
// env로 조정: GOODBOY_BASH_OUTPUT_WARN_CHARS / GOODBOY_BASH_OUTPUT_WARN_LINES.
export const BASH_OUTPUT_WARN_CHARS_DEFAULT = 10_000;
export const BASH_OUTPUT_WARN_LINES_DEFAULT = 200;

// --- habit 카탈로그 ---------------------------------------------------------

export interface TokenHabit {
  /** habit ID (예: 'H1-03'). 게이트/경고 메시지에 표기한다. */
  id: string;
  /** 짧은 제목. */
  title: string;
  /** 이 습관을 제어하는 GOODBOY_ env 이름들. */
  envVars: string[];
  /** env 기본값(토글/임계값). */
  defaults: Record<string, number | string | boolean>;
  /** 한 줄 설명. */
  description: string;
}

export const TOKEN_HABITS: Record<string, TokenHabit> = {
  'H1-01': {
    id: 'H1-01',
    title: '긴 세션(시간/절대토큰) 경고',
    envVars: ['GOODBOY_SESSION_TIME_WARN_MIN', 'GOODBOY_TOKEN_WARN'],
    defaults: { GOODBOY_SESSION_TIME_WARN_MIN: 35, GOODBOY_TOKEN_WARN: 50_000 },
    description:
      '세션 경과시간 또는 절대 컨텍스트 토큰이 크면 새 세션/압축을 권장(비차단, 세션당 1회).',
  },
  'H1-03': {
    id: 'H1-03',
    title: '컨텍스트 자동 compact 강제',
    envVars: ['GOODBOY_COMPACT_FORCE_PCT', 'GOODBOY_CONTEXT_LIMIT'],
    defaults: { GOODBOY_COMPACT_FORCE_PCT: 50 },
    description:
      '컨텍스트 점유율이 강제 임계(기본 50%) 이상이면 자동 compact 신호(stopReason: compact_needed)와 ' +
      'decision:block으로 턴 종료를 막아 compact를 강제(공격적). ' +
      'MAX_RETRIES 초과 시 통과+경고(무한 block 방지). 임계 미만이면 아무 동작 없음. ' +
      '점유율은 (현재 입력 토큰 / 컨텍스트 한도)로 계산하는데, 한도는 모델 ID의 1M 표식으로 판별한다. ' +
      '⚠️ 1M 확장 컨텍스트는 세션 토글이라 실제 모델 ID(예: claude-opus-4-8)에는 표식이 없어 200K로 오판될 수 있다 ' +
      '(percent가 수 배로 부풀어 오탐 강제 발생). 1M 창을 쓰면 GOODBOY_CONTEXT_LIMIT=1000000처럼 한도를 명시하면 정확하다 ' +
      '(env가 모델 판별보다 최우선). env 미설정이어도 관측 토큰이 200K를 넘으면 자동으로 최소 1M 창으로 간주해 오탐을 회피한다.',
  },
  'H2-01': {
    id: 'H2-01',
    title: '같은 파일 재-Read 게이트',
    envVars: ['GOODBOY_REREAD_GATE', 'GOODBOY_REREAD_WINDOW'],
    defaults: { GOODBOY_REREAD_GATE: 'deny', GOODBOY_REREAD_WINDOW: 3 },
    description:
      '최근 N턴 내 같은 파일을 mtime 변경 없이 재-Read하면 차단(부분읽기/변경/편집은 예외). ' +
      '서브에이전트(agent_type 존재)는 면제 — read 기록이 session_id로만 스코프되어 메인과 공유되므로 ' +
      '서브에이전트가 처음 읽는 파일도 오차단되던 문제를 막는다.',
  },
  'H2-02': {
    id: 'H2-02',
    title: 'Bash 대량출력 사후 경고(출력 크기 기반)',
    envVars: ['GOODBOY_BASH_FLOOD_WARN', 'GOODBOY_BASH_OUTPUT_WARN_CHARS', 'GOODBOY_BASH_OUTPUT_WARN_LINES'],
    defaults: {
      GOODBOY_BASH_FLOOD_WARN: 'on',
      GOODBOY_BASH_OUTPUT_WARN_CHARS: BASH_OUTPUT_WARN_CHARS_DEFAULT,
      GOODBOY_BASH_OUTPUT_WARN_LINES: BASH_OUTPUT_WARN_LINES_DEFAULT,
    },
    description:
      'Bash 실행 후 실제 출력(tool_response)이 임계(문자수/줄수)를 넘으면 PostToolUse에서 ' +
      'additionalContext로 비차단 경고(사후 교정, 세션당 1회, 실제 필터링은 rtk 담당). ' +
      'classifyBashFlood 패턴은 보조 신호로 함께 표기.',
  },
  'H2-03': {
    id: 'H2-03',
    title: 'Bash 검색 강제 위임',
    envVars: ['GOODBOY_BASH_SEARCH_GATE'],
    defaults: { GOODBOY_BASH_SEARCH_GATE: 'deny' },
    description:
      '메인 세션에서 Bash로 수행하는 재귀 코드베이스 탐색(grep -r/rg/ag/ack/git grep/find -name)을 ' +
      '감지해 차단하고 서브에이전트 위임을 유도(도구 위임 게이트가 Bash로 우회되는 것을 막음). ' +
      '파이프 뒤 필터(... | grep)·단일 파일 grep은 예외. 서브에이전트(agent_type)는 면제. ' +
      'GOODBOY_BASH_SEARCH_GATE=deny|warn|off (기본 deny).',
  },
  'H5-04': {
    id: 'H5-04',
    title: '요약 먼저 / 요청 시 상세',
    envVars: ['GOODBOY_CONCISE_DEFAULT'],
    defaults: { GOODBOY_CONCISE_DEFAULT: 'on' },
    description:
      '일반 프롬프트에 간결-우선 지시를 주입. 상세 요청 신호가 있으면 주입하지 않음(소프트 규칙).',
  },
};

// --- env 헬퍼 ---------------------------------------------------------------

/** env 정수. 미설정/빈값/파싱실패 → dflt.
 *  4-3: min/max를 주면 [min, max]로 클램프한다(설정 오용으로 음수/거대값이 게이트를 무력화하거나
 *  상시 발동시키는 것을 막는다). 파싱된 값이 유한할 때만 클램프하고, 실패 시 dflt는 클램프하지 않는다. */
export function envInt(name: string, dflt: number, min?: number, max?: number): number {
  try {
    const v = process.env[name];
    if (v === undefined || v.trim() === '') return dflt;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    let clamped = n;
    if (typeof min === 'number' && clamped < min) clamped = min;
    if (typeof max === 'number' && clamped > max) clamped = max;
    return clamped;
  } catch {
    return dflt;
  }
}

/** env 문자열(소문자 trim). 미설정/빈값 → dflt. */
export function envStr(name: string, dflt: string): string {
  try {
    const v = process.env[name];
    if (v === undefined || v.trim() === '') return dflt;
    return v.trim().toLowerCase();
  } catch {
    return dflt;
  }
}

// --- 세션별 habit 경고 상태 (스팸 억제용) -----------------------------------

export interface HabitState {
  /** H1-01: 세션 시작 시각(ISO). 최초 1회 기록. */
  sessionStartTs?: string;
  /** H1-01: 긴 세션 경고를 이미 냈는지. */
  longSessionWarned?: boolean;
  /** H2-02(구): 이미 경고한 Bash flood 패턴 키 목록(사전 경고 시절 잔재, 하위호환용). */
  bashFloodPatterns?: string[];
  /** H2-02: Bash 대량출력 사후 경고를 이번 세션에 이미 냈는지(세션당 1회). */
  bashOutputWarned?: boolean;
  /** E1 canary: 컨텍스트 사용량 측정 연속 실패 횟수(성공 시 0으로 리셋). */
  ctxMeasureFailStreak?: number;
  /** E1 canary: 측정 실패 지속(무력화 가능성) 경고를 이미 냈는지(세션당 1회). */
  ctxParseWarned?: boolean;
  /** D4: 컨텍스트 성장 반복 경고를 마지막으로 낸 시점의 점유율(%). 다음 경고는 +step 이상일 때. */
  lastCtxWarnPct?: number;
  /** H2-01 epoch: 직전 Stop에서 관측한 컨텍스트 점유율(%). 급락(=압축) 감지에 사용. */
  lastCtxPercent?: number;
  /** H4-03: 세션 내 모델 전환 경고를 이미 냈는지(세션당 1회). */
  modelSwitchWarned?: boolean;
}

const HABIT_STATE_FILE = 'habit-state.json';

/** 세션 habit 상태 읽기. 없거나 실패 시 빈 객체(fail-open). */
export function readHabitState(sessionId: string): HabitState {
  try {
    const dir = ensureSessionDir(sessionId);
    const p = join(dir, HABIT_STATE_FILE);
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as HabitState;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 세션 habit 상태 쓰기(best-effort). */
export function writeHabitState(sessionId: string, state: HabitState): void {
  try {
    const dir = ensureSessionDir(sessionId);
    writeFileSync(join(dir, HABIT_STATE_FILE), JSON.stringify(state), 'utf8');
  } catch {
    // best-effort — 상태 저장 실패해도 정상 작업을 막지 않는다.
  }
}

// --- H1-03: 컨텍스트 자동 compact 강제 --------------------------------------

/** 강제 자동 compact 임계(%). 컨텍스트 점유율이 이 값 이상이면 Stop 훅이 compact를 강제한다.
 *  GOODBOY_COMPACT_FORCE_PCT로 조정, 기본 50. (하위 경고 단계 없이 전부 "강제"로 통일) */
export function compactForcePct(): number {
  // 4-3: [0, 100]으로 클램프. 음수면 상시 강제, 100 초과면 사실상 비활성 되던 오용을 막는다.
  return envInt('GOODBOY_COMPACT_FORCE_PCT', 50, 0, 100);
}

// --- H2-02: Bash 대량출력 패턴 판정 -----------------------------------------

/** 명령이 대량출력을 유발할 위험이 높은 패턴인지 보수적으로 분류.
 *  매칭되면 패턴 키(스팸 억제용), 아니면 null.
 *  출력 제한(head/tail/grep/wc/less | -n)이 이미 있으면 경고하지 않는다.
 *  ⚠️ rtk가 Bash 토큰 필터링을 이미 수행하므로 Good Boy는 "경고"만 담당한다(deny 안 함). */
export function classifyBashFlood(command: string): string | null {
  if (typeof command !== 'string') return null;
  // 4-2: 정규식 백트래킹 시간을 상한하려 앞 8KB만 검사한다(초대형 command 방어). 판정 신호로 충분.
  const cmd = command.trim().slice(0, 8192);
  if (cmd === '') return null;

  // 출력 제한/스트리밍 축소가 이미 있으면 정상 명령으로 간주하고 경고하지 않는다.
  const hasLimiter =
    /\|\s*(head|tail|grep|egrep|fgrep|rg|wc|less|more|awk|sed|jq|sort\s+-u)\b/.test(cmd) ||
    /\bhead\b|\btail\b/.test(cmd) ||
    /(^|\s)-n\s*\d+/.test(cmd) ||
    /\bwc\b/.test(cmd);

  // 고위험 패턴(보수적):
  //  - cat 으로 .log 파일 출력
  const catLog = /\bcat\b[^|&;]*\.log\b/.test(cmd);
  //  - cat 으로 glob(*) 다중 파일 출력. (4-2: `\s+`와 `[^|&;]*`가 공백에서 겹쳐 준2차 백트래킹을
  //    유발하던 것을 단일 `[^|&;]*`(공백 포함)로 단순화해 모호성 제거.)
  const catGlob = /\bcat\b[^|&;]*\*/.test(cmd);
  //  - 루트/광범위 find (find / ...)
  const findBroad = /\bfind\s+\/(\s|$)/.test(cmd);
  //  - 전체 로그 스트리밍(journalctl / dmesg 전체 등)
  const wholeLog = /\b(journalctl|dmesg)\b(?![^|]*\b(-n|--lines|tail|head)\b)/.test(cmd);

  let key: string | null = null;
  if (catLog) key = 'cat-log';
  else if (catGlob) key = 'cat-glob';
  else if (findBroad) key = 'find-broad';
  else if (wholeLog) key = 'whole-log';

  if (key === null) return null;
  if (hasLimiter) return null; // 이미 제한됨 → 경고 불필요
  return key;
}

/** @deprecated 사전 경고(pre-tool-use) 시절 메시지. 사후 경고는 bashOutputFloodMessage 사용. */
export const BASH_FLOOD_MESSAGE =
  '출력이 클 수 있습니다. head/grep으로 제한하거나 파일로 저장 후 경로를 전달하세요. ' +
  '(로그 flood 방지, H2-02) [실제 필터링은 rtk가 일부 수행]';

/** H2-02 사후 경고 임계값(env로 조정). chars/lines 둘 중 하나만 넘어도 트리거. */
export function bashOutputWarnThresholds(): { chars: number; lines: number } {
  return {
    chars: envInt('GOODBOY_BASH_OUTPUT_WARN_CHARS', BASH_OUTPUT_WARN_CHARS_DEFAULT),
    lines: envInt('GOODBOY_BASH_OUTPUT_WARN_LINES', BASH_OUTPUT_WARN_LINES_DEFAULT),
  };
}

/** Bash tool_response에서 실제 출력 텍스트를 견고하게 추출.
 *  문자열이면 그대로, 객체면 stdout/stderr/output 문자열을 합친다. 실패 시 ''. */
export function extractBashOutput(response: unknown): string {
  try {
    if (typeof response === 'string') return response;
    if (!response || typeof response !== 'object') return '';
    const r = response as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ['stdout', 'stderr', 'output']) {
      const v = r[key];
      if (typeof v === 'string' && v.length > 0) parts.push(v);
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/** 출력 크기(문자수/줄수)를 측정. */
export function measureOutput(output: string): { chars: number; lines: number } {
  const chars = output.length;
  const lines = output === '' ? 0 : output.split(/\r?\n/).length;
  return { chars, lines };
}

/** H2-02 사후 경고 문구. 실제 크기를 알리고, 패턴 신호가 있으면 함께 표기한다. */
export function bashOutputFloodMessage(
  chars: number,
  lines: number,
  patternKey?: string | null,
): string {
  const patternNote = patternKey ? ` (위험 패턴: ${patternKey})` : '';
  return (
    `이번 Bash 출력이 컸습니다(약 ${chars.toLocaleString()}자 / ${lines}줄)${patternNote}. ` +
    '다음엔 head/grep/tail로 제한하거나 파일로 저장 후 경로를 전달하세요. ' +
    '(로그 flood 방지, H2-02) [실제 필터링은 rtk가 일부 수행]'
  );
}

// --- H2-02 사전 차단: bare cat 대용량 통짜 출력 --------------------------------

/** bare cat 사전 차단 임계(바이트). env GOODBOY_CAT_DENY_BYTES로 조정. */
export function catDumpThresholdBytes(): number {
  return envInt('GOODBOY_CAT_DENY_BYTES', 256_000);
}

/** 따옴표로 감싼 경로 인자에서 따옴표 제거. */
function stripArgQuotes(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** "후처리 없이 bare cat으로 대용량 파일을 통째로 출력"하는 명령을 감지한다(H2-02 사전 차단).
 *
 *  실행 전에 크기를 아는 유일한 케이스가 "파일 인자 cat"이다 — 임의 명령의 출력 크기는
 *  실행 전 예측 불가라 사후 경고만 가능하지만, cat <file>은 statSync로 미리 알 수 있다.
 *
 *  오탐 방지(전부 통과):
 *   - 파이프/리다이렉트/체이닝/서브셸/개행이 있으면 실제 출력이 작을 수 있음 → 판정 안 함
 *     (예: `cat big.log | head -5`는 정당). heredoc(`cat <<EOF`)도 `<` 규칙으로 걸러진다.
 *   - glob/변수 등 크기를 확정할 수 없는 인자 → 판정 안 함(사후 경고가 담당).
 *   - stat 실패/파일 아님 → 판정 안 함(fail-open).
 *  매칭 시 { bytes: 합계, files } 반환, 아니면 null. */
export function classifyBareCatDump(
  command: string,
  cwd: string,
  thresholdBytes: number,
): { bytes: number; files: string[] } | null {
  try {
    if (typeof command !== 'string') return null;
    const trimmed = command.trim();
    if (trimmed === '') return null;
    // 후처리/합성 흔적이 있으면 통과(실제 출력이 작을 수 있음).
    if (/[|;&><`]/.test(trimmed) || /\r?\n/.test(trimmed)) return null;

    let seg = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    seg = seg.replace(/^(?:sudo|time|nice|nohup|command)\s+/, '');
    const tokens = seg.split(/\s+/).filter(Boolean);
    if ((tokens[0] ?? '') !== 'cat') return null;

    const fileArgs = tokens.slice(1).filter((t) => !t.startsWith('-'));
    if (fileArgs.length === 0) return null; // stdin cat 등
    // glob/변수 인자는 크기 확정 불가 → 통과(classifyBashFlood의 사후 경고가 담당).
    if (fileArgs.some((f) => /[*?\[\]$~]/.test(f))) return null;

    let total = 0;
    const files: string[] = [];
    for (const f of fileArgs) {
      const abs = resolve(cwd, stripArgQuotes(f));
      const st = statSync(abs); // 실패 → catch → null(fail-open)
      if (!st.isFile()) return null;
      total += st.size;
      files.push(abs);
    }
    if (total <= thresholdBytes) return null;
    return { bytes: total, files };
  } catch {
    return null;
  }
}

/** bare cat 사전 차단 안내 문구. */
export function bareCatDumpMessage(bytes: number): string {
  const kb = Math.round(bytes / 1024);
  return (
    `대용량 파일(약 ${kb.toLocaleString()}KB)을 후처리 없이 통째로 출력하려 합니다. ` +
    'Read 도구(offset/limit)로 필요한 부분만 읽거나, head/tail/rg로 범위를 제한하세요. ' +
    '(출력 홍수 사전 차단, H2-02)'
  );
}

// --- H2-04: 동일 URL 재페치 경고 -----------------------------------------------

const WEBFETCH_LOG_FILE = 'webfetch.jsonl';

/** URL 정규화: 공백 제거 + fragment(#...) 제거(같은 문서) + 후행 슬래시 제거. */
function normalizeUrl(url: string): string {
  let u = url.trim();
  const hashIdx = u.indexOf('#');
  if (hashIdx >= 0) u = u.slice(0, hashIdx);
  if (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

/** (v0.27.9, 리뷰 지적) 기록 키 정규화 — URL만 normalizeUrl을 거친다.
 *  'search:' 접두 검색어 키에 URL 정규화를 적용하면 '#'가 fragment로 절단되어
 *  "C# async await"와 "C# LINQ"가 둘 다 'search:C'로 충돌한다(거짓 재검색 경고 실측). */
function normalizeWebKey(key: string): string {
  return key.startsWith('search:') ? key.trim() : normalizeUrl(key);
}

/** WebFetch URL 기록(세션 스코프). 서브에이전트 포함 — 세션 전체에서 같은 페이지
 *  재페치를 감지하기 위해 일부러 에이전트 스코프를 두지 않는다. */
export function recordWebFetch(sessionId: string, url: string): void {
  try {
    const dir = ensureSessionDir(sessionId);
    const record = { url: normalizeWebKey(url), timestamp: new Date().toISOString() };
    appendFileSync(join(dir, WEBFETCH_LOG_FILE), JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

/** 이 세션에서 같은 URL을 이미 가져왔는지. 실패 시 false(fail-open). */
export function wasUrlFetched(sessionId: string, url: string): boolean {
  try {
    const path = join(ensureSessionDir(sessionId), WEBFETCH_LOG_FILE);
    if (!existsSync(path)) return false;
    const target = normalizeWebKey(url);
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as { url?: unknown };
        if (typeof parsed.url === 'string' && parsed.url === target) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** H2-04 재페치 경고 문구. */
export function webRefetchMessage(url: string): string {
  return (
    `이 URL은 이번 세션에서 이미 가져왔습니다: ${url} — 앞선 결과를 참조하세요. ` +
    '원격 내용이 바뀌었을 근거가 있을 때만 다시 가져오세요. (웹 재페치 방지, H2-04)'
  );
}

/** (v0.27.9) H2-04 동일 검색어 반복 문구 — tokenhabit 실측(웹 호출 270회) 대응으로
 *  재페치 경고를 WebSearch까지 확장했다. */
export function webRepeatSearchMessage(query: string): string {
  return (
    `이 검색어는 이번 세션에서 이미 검색했습니다: ${query} — 앞선 결과를 참조하세요. ` +
    '새 정보가 필요하면 검색어를 좁히거나 바꾸세요. (웹 재검색 방지, H2-04)'
  );
}

// --- H2-03: Bash 재귀 코드베이스 탐색 감지(강제 위임) --------------------------

/** 메인 세션에서 Bash로 수행하는 "재귀 코드베이스 탐색"을 감지한다(서브에이전트 위임 유도용).
 *  매칭되면 감지된 검색 도구 라벨(예: 'grep -r', 'rg', 'find'), 아니면 null.
 *  보수적 판정(오탐 최소화):
 *   - 첫 세그먼트(선행 명령)만 본다 — 파이프/논리연산 뒤의 grep 등(필터링)은 대상 아님.
 *   - grep은 재귀 플래그(-r/-R/--recursive/--include)가 있을 때만 — 단일 파일 grep은 통과.
 *   - rg/ag/ack는 기본 재귀라 선행 명령이면 매칭. git grep 매칭.
 *   - find는 -name/-path/-regex/-type 등 탐색 술어가 있을 때 매칭.
 *   - 선행 환경변수 할당(FOO=bar) 및 래퍼(sudo/time/nice/nohup/command)는 건너뛴다.
 *   - --version/--help/-V는 제외.
 *  fail-safe: 비문자열/예외는 null(게이트 미발동). */
export function classifyBashSearch(command: string): string | null {
  try {
    if (typeof command !== 'string') return null;
    const trimmed = command.trim();
    if (trimmed === '') return null;

    // 첫 세그먼트만(파이프/;/&& 이전). 뒤쪽 grep은 필터링이므로 대상 아님.
    const firstSeg = (trimmed.split(/\||;|&&|\n/)[0] ?? '').trim();
    if (firstSeg === '') return null;

    // 선행 환경변수 할당 + 래퍼 명령 제거.
    let seg = firstSeg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '');
    seg = seg.replace(/^(?:sudo|time|nice|nohup|command)\s+/, '');
    const tokens = seg.split(/\s+/).filter(Boolean);
    const bin = tokens[0] ?? '';

    if (/(^|\s)(--version|--help|-V)(\s|$)/.test(seg)) return null;

    if (bin === 'rg' || bin === 'ripgrep') return 'rg';
    if (bin === 'ag') return 'ag';
    if (bin === 'ack') return 'ack';
    if (bin === 'git' && tokens[1] === 'grep') return 'git grep';

    if (bin === 'grep' || bin === 'egrep' || bin === 'fgrep' || bin === 'rgrep') {
      if (bin === 'rgrep') return 'grep -r';
      // 재귀 플래그가 있을 때만. 단일 파일 grep(재귀 아님)은 통과.
      const recursive =
        /(^|\s)-[a-z]*[rR][a-z]*(\s|=|$)/i.test(seg) ||
        /--recursive\b/.test(seg) ||
        /--include\b/.test(seg);
      return recursive ? 'grep -r' : null;
    }

    if (bin === 'find') {
      // 탐색 술어(-name/-path/-regex/-type 등)가 있을 때만. 단순 디렉터리 지정은 통과.
      if (/(^|\s)-(i?name|i?path|i?regex|type)\b/.test(seg)) return 'find';
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

export const BASH_SEARCH_MESSAGE =
  'Bash로 코드베이스를 직접 재귀 탐색하지 마세요(도구 위임 게이트 우회). ' +
  "이런 검색은 서브에이전트에 위임하세요: Agent 도구로 'general-purpose'/'Explore' 서브에이전트를 " +
  '호출해 검색을 수행하게 하고 결과만 받으세요. (Bash 검색 강제 위임, H2-03) [끄려면 GOODBOY_BASH_SEARCH_GATE=off]';

// --- H5-04: 요약 먼저 / 요청 시 상세 ----------------------------------------

/** 프롬프트가 "상세 설명 요청" 신호를 담고 있는지. 담고 있으면 간결-우선 지시를 주입하지 않는다. */
export function wantsDetail(prompt: string): boolean {
  if (typeof prompt !== 'string' || prompt === '') return false;
  const raw = prompt;
  const low = prompt.toLowerCase();
  // 한국어 신호(원문 검사)
  const ko = ['자세히', '상세', '전체', '길게', '풀어서', '구체적', '자세하게'];
  if (ko.some((s) => raw.includes(s))) return true;
  // 영어 신호(소문자 검사)
  const en = ['more detail', 'in detail', 'expand', 'verbose', 'elaborate', 'full detail'];
  return en.some((s) => low.includes(s));
}

export const CONCISE_INSTRUCTION =
  '답변은 먼저 핵심을 요약해 제시하고, 사용자가 명시적으로 더 상세한 설명을 요청할 때만 ' +
  '장황하게 출력하세요. (간결 우선, H5-04)';
