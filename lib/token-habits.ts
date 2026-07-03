// 토큰 낭비 습관(token-waste habit) 카탈로그 + 공통 헬퍼.
//
// tokenhabit이 식별한 "토큰을 낭비하는 작업 습관"을 vcf hook이 막기 위한 중앙 카탈로그다.
// 새 습관을 추가할 때도 같은 틀(id / envVars / defaults / description)을 그대로 쓴다.
// 각 게이트/경고는 자신의 habit ID를 메시지/주석에 표기한다.
//
// 설계 원칙(엄수):
//   - fail-open: 모든 헬퍼는 예외를 삼키고 안전한 기본값을 반환. 정상 작업을 막지 않는다.
//   - 스팸 금지: 경고는 세션당/단계당 1회. "이미 경고함"을 habit-state.json에 기록한다.
//   - env 토글: 각 기능은 VCF_ 접두사 env로 끄거나 임계값을 조정할 수 있다.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';

// --- H2-02 임계 기본값(출력 크기 기반) --------------------------------------
// Bash 실행 후 실제 출력이 이 크기를 넘으면 사후 경고한다(사후 교정).
// env로 조정: VCF_BASH_OUTPUT_WARN_CHARS / VCF_BASH_OUTPUT_WARN_LINES.
export const BASH_OUTPUT_WARN_CHARS_DEFAULT = 10_000;
export const BASH_OUTPUT_WARN_LINES_DEFAULT = 200;

// --- habit 카탈로그 ---------------------------------------------------------

export interface TokenHabit {
  /** habit ID (예: 'H1-03'). 게이트/경고 메시지에 표기한다. */
  id: string;
  /** 짧은 제목. */
  title: string;
  /** 이 습관을 제어하는 VCF_ env 이름들. */
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
    envVars: ['VCF_SESSION_TIME_WARN_MIN', 'VCF_TOKEN_WARN'],
    defaults: { VCF_SESSION_TIME_WARN_MIN: 35, VCF_TOKEN_WARN: 50_000 },
    description:
      '세션 경과시간 또는 절대 컨텍스트 토큰이 크면 새 세션/압축을 권장(비차단, 세션당 1회).',
  },
  'H1-03': {
    id: 'H1-03',
    title: '컨텍스트 자동 compact 강제',
    envVars: ['VCF_COMPACT_FORCE_PCT', 'VCF_CONTEXT_LIMIT'],
    defaults: { VCF_COMPACT_FORCE_PCT: 50 },
    description:
      '컨텍스트 점유율이 강제 임계(기본 50%) 이상이면 자동 compact 신호(stopReason: compact_needed)와 ' +
      'decision:block으로 턴 종료를 막아 compact를 강제(공격적). ' +
      'MAX_RETRIES 초과 시 통과+경고(무한 block 방지). 임계 미만이면 아무 동작 없음. ' +
      '점유율은 (현재 입력 토큰 / 컨텍스트 한도)로 계산하는데, 한도는 모델 ID의 1M 표식으로 판별한다. ' +
      '⚠️ 1M 확장 컨텍스트는 세션 토글이라 실제 모델 ID(예: claude-opus-4-8)에는 표식이 없어 200K로 오판될 수 있다 ' +
      '(percent가 수 배로 부풀어 오탐 강제 발생). 1M 창을 쓰면 VCF_CONTEXT_LIMIT=1000000처럼 한도를 명시하면 정확하다 ' +
      '(env가 모델 판별보다 최우선). env 미설정이어도 관측 토큰이 200K를 넘으면 자동으로 최소 1M 창으로 간주해 오탐을 회피한다.',
  },
  'H2-01': {
    id: 'H2-01',
    title: '같은 파일 재-Read 게이트',
    envVars: ['VCF_REREAD_GATE', 'VCF_REREAD_WINDOW'],
    defaults: { VCF_REREAD_GATE: 'deny', VCF_REREAD_WINDOW: 3 },
    description:
      '최근 N턴 내 같은 파일을 mtime 변경 없이 재-Read하면 차단(부분읽기/변경/편집은 예외). ' +
      '서브에이전트(agent_type 존재)는 면제 — read 기록이 session_id로만 스코프되어 메인과 공유되므로 ' +
      '서브에이전트가 처음 읽는 파일도 오차단되던 문제를 막는다.',
  },
  'H2-02': {
    id: 'H2-02',
    title: 'Bash 대량출력 사후 경고(출력 크기 기반)',
    envVars: ['VCF_BASH_FLOOD_WARN', 'VCF_BASH_OUTPUT_WARN_CHARS', 'VCF_BASH_OUTPUT_WARN_LINES'],
    defaults: {
      VCF_BASH_FLOOD_WARN: 'on',
      VCF_BASH_OUTPUT_WARN_CHARS: BASH_OUTPUT_WARN_CHARS_DEFAULT,
      VCF_BASH_OUTPUT_WARN_LINES: BASH_OUTPUT_WARN_LINES_DEFAULT,
    },
    description:
      'Bash 실행 후 실제 출력(tool_response)이 임계(문자수/줄수)를 넘으면 PostToolUse에서 ' +
      'additionalContext로 비차단 경고(사후 교정, 세션당 1회, 실제 필터링은 rtk 담당). ' +
      'classifyBashFlood 패턴은 보조 신호로 함께 표기.',
  },
  'H5-04': {
    id: 'H5-04',
    title: '요약 먼저 / 요청 시 상세',
    envVars: ['VCF_CONCISE_DEFAULT'],
    defaults: { VCF_CONCISE_DEFAULT: 'on' },
    description:
      '일반 프롬프트에 간결-우선 지시를 주입. 상세 요청 신호가 있으면 주입하지 않음(소프트 규칙).',
  },
};

// --- env 헬퍼 ---------------------------------------------------------------

/** env 정수. 미설정/빈값/파싱실패 → dflt. */
export function envInt(name: string, dflt: number): number {
  try {
    const v = process.env[name];
    if (v === undefined || v.trim() === '') return dflt;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
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
 *  VCF_COMPACT_FORCE_PCT로 조정, 기본 50. (하위 경고 단계 없이 전부 "강제"로 통일) */
export function compactForcePct(): number {
  return envInt('VCF_COMPACT_FORCE_PCT', 50);
}

// --- H2-02: Bash 대량출력 패턴 판정 -----------------------------------------

/** 명령이 대량출력을 유발할 위험이 높은 패턴인지 보수적으로 분류.
 *  매칭되면 패턴 키(스팸 억제용), 아니면 null.
 *  출력 제한(head/tail/grep/wc/less | -n)이 이미 있으면 경고하지 않는다.
 *  ⚠️ rtk가 Bash 토큰 필터링을 이미 수행하므로 vcf는 "경고"만 담당한다(deny 안 함). */
export function classifyBashFlood(command: string): string | null {
  if (typeof command !== 'string') return null;
  const cmd = command.trim();
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
  //  - cat 으로 glob(*) 다중 파일 출력
  const catGlob = /\bcat\b\s+[^|&;]*\*/.test(cmd);
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
    chars: envInt('VCF_BASH_OUTPUT_WARN_CHARS', BASH_OUTPUT_WARN_CHARS_DEFAULT),
    lines: envInt('VCF_BASH_OUTPUT_WARN_LINES', BASH_OUTPUT_WARN_LINES_DEFAULT),
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
