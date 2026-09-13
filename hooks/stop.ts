#!/usr/bin/env bun
// Stop hook — 턴 증가, 리뷰 강제/검증, 재시도 카운터, 커서/차원 검사

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { CitationProblem, StatusSnapshot } from '../lib';
import {
  citationBlockMessage,
  clearReadRecords,
  clearValidationFailure,
  compactForcePct,
  currentFindings,
  envInt,
  envStr,
  excludeUserOriginated,
  extractCitations,
  extractRecentAssistantTexts,
  extractRecentUserTexts,
  assistantTextFreshness,
  gateMessage,
  isDocFile,
  isGateMessage,
  hallucinatedCitations,
  hasAnyReadRecords,
  unreadBlockMessage,
  unreadCitations,
  verifyCitations,
  wasFileReadRecently,
  detectTestInfrastructure,
  failingSuites,
  findDevCycleArtifacts,
  findRecentReviewFiles,
  findRecentTestFiles,
  missingTestFiles,
  pruneOldReviewFiles,
  pruneOldTestFiles,
  readTestCursor,
  requiredAcceptanceCriteria,
  scanForbiddenPatterns,
  uncoveredCriteria,
  validateEvidence,
  validateTestCoverage,
  writeTestCursor,
  getContextUsage,
  getCurrentTurn,
  getEditsSince,
  getEditsWithLastTimestampSince,
  hasReasoningSection,
  highSeverityFindings,
  incrementTurn,
  isTestFile,
  logGate,
  parseReasoningSection,
  readGateLog,
  readHabitState,
  readReviewCursor,
  readValidationFailure,
  requiredDimensionsFor,
  validateReviewCoverage,
  writeHabitState,
  writeReviewCursor,
  writeStatusSnapshot,
} from '../lib';

interface StopInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  // 일부/향후 Claude Code 버전이 세션 모델을 넘길 수 있음(예: `claude-opus-4-8[1m]`).
  // 있으면 컨텍스트 창 동적 감지의 최우선 신호로 쓴다(없으면 무시).
  model?: string;
}

interface HookOutput {
  continue?: boolean;
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
  // context-watchdog.sh와 동일한 자동 compact 유도 신호(H1-03 강제):
  //   top-level stopReason: 'compact_needed' + top-level additionalContext.
  stopReason?: string;
  additionalContext?: string;
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    additionalContext?: string;
  };
}

const MAX_RETRIES = 3;

/** $HOME/.claude/settings.json 경로. HOME 미설정/오류 시 null(설정 폴백을 건너뜀).
 *  하드코딩 대신 process.env.HOME 기반으로 구성한다. */
function settingsJsonPath(): string | null {
  try {
    const home = process.env.HOME;
    if (!home || typeof home !== 'string' || home.trim() === '') return null;
    return resolvePath(home, '.claude', 'settings.json');
  } catch {
    return null;
  }
}

// H1-03 강제 자동 compact 재시도 카운터 파일. review 재시도(.goodboy-retry-count.txt)와
// 간섭하지 않도록 별도 파일에 동일 escape 패턴(MAX_RETRIES)으로 관리한다.
const COMPACT_FORCE_COUNT_FILE = '.goodboy-compact-force-count.txt';

// (C1) 자동 검증 실패 게이트 재시도 카운터 파일. 게이트마다 카운터를 분리해
// 서로의 재시도 기회를 깎지 않게 한다(리뷰/compact 카운터와 독립).
const VALIDATION_COUNT_FILE = '.goodboy-validation-retry-count.txt';

// (D) validateReview 실패 게이트 재시도 카운터. 다른 게이트와 분리 관리.
//   v0.25.0까지 이 게이트만 escape가 없어 영구 데드락을 만들었다(라이브 재현:
//   삭제된 프로브/리뷰 산출물이 유령 파일로 남아 커버리지가 영원히 실패).
const REVIEW_VALIDATE_COUNT_FILE = '.goodboy-review-validate-retry-count.txt';

// (층1) 테스트 게이트 재시도 카운터. 리뷰 카운터와 분리 — 테스트 재시도가 리뷰의
// 재시도 기회를 깎으면, 테스트를 고치는 동안 리뷰 게이트가 escape로 새어나간다.
const TEST_COUNT_FILE = '.goodboy-test-retry-count.txt';

// (층0) 인용 검증 게이트 재시도 카운터. 다른 게이트와 분리 — 층0은 편집 없는 턴에도
// 발동하므로, 카운터를 공유하면 답변 턴의 재시도가 리뷰의 기회를 깎는다.
const CLAIM_COUNT_FILE = '.goodboy-claim-retry-count.txt';

// 이번 Stop 실행에서 사용자에게 보일 토큰-습관 경고들(H1-01 긴 세션 경고, H1-03 강제 escape 통지).
// emit()이 모든 출력 경로(block/pass)의 systemMessage에 이 경고들을 덧붙인다 —
// 이 권고들은 리뷰 통과/차단과 독립적이어야 하기 때문.
const habitWarnings: string[] = [];

// (E1) 상태 스냅샷 — main()이 진행하며 채우고, emit()이 어떤 출력 경로로 끝나든
// 세션 디렉터리 status.json에 기록한다(상태바/외부 도구 소비용). 이 hook은 1회성
// 프로세스이므로 모듈 전역으로 충분하다. 기록 실패는 조용히 무시(fail-open).
let snapshotSessionId: string | null = null;
const statusSnapshot: Partial<Omit<StatusSnapshot, 'updatedAt'>> = {};

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

/** (H1-01) 긴 세션(경과시간/절대토큰) 경고를 계산해 habitWarnings에 채운다.
 *  - fail-open: 예외/측정불가면 조용히 통과(경고 없음). 절대 throw 하지 않는다.
 *  - 세션당 1회. H1-03 강제가 이번 Stop에 발동했으면(forceActive) 스팸 방지로 생략한다.
 *  - 세션 시작 시각(sessionStartTs)은 최초 1회 기록한다(시간 기반 판단용). */
function maybeSetLongSessionWarning(
  usage: ReturnType<typeof getContextUsage>,
  sessionId: string,
  forceActive: boolean,
): void {
  try {
    const state = readHabitState(sessionId);
    let dirty = false;

    // 세션 시작 시각 최초 1회 기록. 첫 Stop에선 경과시간 ~0이라 경고가 뜨지 않는다.
    const nowMs = Date.now();
    if (!state.sessionStartTs) {
      state.sessionStartTs = new Date(nowMs).toISOString();
      dirty = true;
    }

    // H1-03 강제가 이번 Stop에 발동했으면 스팸 방지를 위해 H1-01 생략. 세션당 1회.
    if (!forceActive) {
      const timeWarnMin = envInt('GOODBOY_SESSION_TIME_WARN_MIN', 35);
      // (v0.27.8) 토큰 임계 기본값을 한도 비례(25%)로 — 실사용 버그: 절대값 50K는
      //   1M 세션에서 점유 5% 시점에 "긴 세션"을 오판했다. 25%는 200K 창에서 정확히
      //   기존 기본값(50K)이라 표준 세션 동작이 보존되고, 1M 창에선 250K로 확장된다.
      //   env GOODBOY_TOKEN_WARN 명시 시 절대값이 우선한다. 한도 미측정이면 50K 유지.
      const tokenWarnEnv = envStr('GOODBOY_TOKEN_WARN', '');
      const tokenWarn =
        tokenWarnEnv !== '' && Number.isFinite(parseInt(tokenWarnEnv, 10))
          ? parseInt(tokenWarnEnv, 10)
          : usage
            ? Math.round(usage.limit * 0.25)
            : 50_000;
      const startMs = state.sessionStartTs ? Date.parse(state.sessionStartTs) : NaN;
      const elapsedMin = Number.isFinite(startMs) ? (nowMs - startMs) / 60000 : 0;
      const timeExceeded = elapsedMin > timeWarnMin;
      const tokenExceeded = usage ? usage.tokens > tokenWarn : false;
      if (!state.longSessionWarned && (timeExceeded || tokenExceeded)) {
        // ⚠️ 문구에 '/compact' 문자열을 넣지 않는다(강제 신호와 구분 + 기존 테스트 보존).
        habitWarnings.push(
          '긴 세션이 감지되었습니다 — 새 세션 시작 또는 대화 압축을 권장합니다. (긴 세션 경고, H1-01)',
        );
        state.longSessionWarned = true;
        dirty = true;
      } else if (state.longSessionWarned && !timeExceeded && !tokenExceeded) {
        // (v0.27.8) 오탐 래치 해제 — 한도 재확정(200K→1M) 또는 압축으로 판정 조건이
        //   해소됐으면 다시 무장한다. 이후 진짜 긴 세션은 다시 1회 경고된다.
        state.longSessionWarned = false;
        dirty = true;
      }
    }

    // (D4) 컨텍스트 성장 반복 경고 — 1회성이 아니라 점유율이 +step%p 오를 때마다 다시 알린다.
    //   상태바가 없는 사용자에게는 이것이 컨텍스트 상태를 알 유일한 기본 채널이다
    //   (상태바가 있으면 GOODBOY_CTX_WARN_STEP_PCT를 크게 잡아 줄일 수 있다).
    //   강제(H1-03)가 발동한 턴은 생략(스팸 방지). ⚠️ 문구에 '/compact'/'강제'를 넣지 않는다.
    if (!forceActive && usage) {
      const startPct = envInt('GOODBOY_CTX_WARN_START_PCT', 30);
      const stepPct = envInt('GOODBOY_CTX_WARN_STEP_PCT', 10);
      const last = state.lastCtxWarnPct ?? 0;
      if (usage.percent >= startPct && usage.percent >= last + stepPct) {
        habitWarnings.push(
          `컨텍스트 사용률이 ${Math.round(usage.percent)}%입니다. ` +
            '불필요한 맥락이 쌓였다면 대화 압축 또는 새 세션을 고려하세요. (컨텍스트 경고, H1-01)',
        );
        state.lastCtxWarnPct = Math.floor(usage.percent);
        dirty = true;
      } else if (usage.percent < last) {
        // (v0.27.8) 기준 하향 재설정 — 한도 재확정(53%→11% 실측)이나 압축으로 점유율이
        //   내려갔으면 성장 경고 기준도 따라 내린다. 단조 증가 고정이면 교정 후의
        //   실제 성장(11%→21%…)이 옛 최고치(53%)를 넘을 때까지 경고가 침묵한다.
        state.lastCtxWarnPct = Math.floor(usage.percent);
        dirty = true;
      }
    }

    if (dirty) writeHabitState(sessionId, state);
  } catch {
    // fail-open — 경고 계산 실패해도 Stop 흐름을 막지 않는다.
  }
}

/** (H1-03) 컨텍스트 자동 compact 강제 판정.
 *  컨텍스트 점유율이 GOODBOY_COMPACT_FORCE_PCT(기본 50) 이상이면:
 *   1) context-watchdog.sh와 동일한 자동 compact 유도 신호
 *      (top-level stopReason: 'compact_needed' + additionalContext)를 실어 하네스 compact를 유도하고,
 *   2) decision:'block' + reason으로 턴 종료를 막아 확실히 compact를 강제한다.
 *  무한 block 방지: stop_hook_active(main B단계에서 조기 return)와 MAX_RETRIES escape를 재사용한다.
 *   - 별도 카운터 파일(.goodboy-compact-force-count.txt)을 사용해 review 재시도와 간섭하지 않는다.
 *   - 강제가 MAX_RETRIES회 이상 지속되면 통과시키고 경고만 남긴다(영구 정지 방지).
 *   - 임계 미만이면 카운터를 리셋하고 아무 동작도 하지 않는다.
 *  fail-open: 측정 불가/예외 시 강제하지 않는다(null 반환).
 *
 *  @returns output: emit할 HookOutput(block) 또는 null(강제 안 함/escape 통과).
 *           forced: 이번 Stop에서 강제가 발동했는지(escape 통과 포함) — H1-01 스팸 억제 판단용. */
function maybeForceCompact(
  usage: ReturnType<typeof getContextUsage>,
  cwd: string,
  sessionId: string,
): { output: HookOutput | null; forced: boolean } {
  try {
    if (!usage) {
      // (v0.27.6) 측정 불가 — 압축 경계 직후(압축 후 usage 미플러시)가 대표 사례.
      //   이전 사이클의 잔존 카운트가 다음 진짜 초과 때 즉시 escape로 튀지 않게 리셋한다.
      try {
        resetRetryCount(ensureClaudeDir(cwd), COMPACT_FORCE_COUNT_FILE);
      } catch {
        // best-effort
      }
      return { output: null, forced: false };
    }
    const forcePct = compactForcePct();
    const pct = Math.round(usage.percent);
    const claudeDir = ensureClaudeDir(cwd);

    // 임계 미만 → 카운터 리셋 후 아무 동작 없음.
    if (usage.percent < forcePct) {
      resetRetryCount(claudeDir, COMPACT_FORCE_COUNT_FILE);
      return { output: null, forced: false };
    }

    // (3-A) 한도가 확정적이지 않으면(1M 지원 모델인데 [1m] 표식 없음 / 미지 모델 → 200K/1M 구분 불가)
    //   강제 block을 보류한다. 표식 없는 1M 세션이 200K로 오판되어 저토큰인데도 오탐 강제되던 문제 방지.
    //   H1-01(절대 토큰 경고)이 안전망 역할을 하며, 하드 강제는 GOODBOY_CONTEXT_LIMIT 명시로 복구할 수 있다.
    if (!usage.confident) {
      // E1: "강제했을 상황인데 한도 미확정으로 보류" — 무력화 상태의 핵심 신호라 기록한다.
      logGate(sessionId, 'compact-force', 'fail-open', `limit-unconfident pct=${pct}`);
      resetRetryCount(claudeDir, COMPACT_FORCE_COUNT_FILE);
      return { output: null, forced: false };
    }

    const count = readRetryCount(claudeDir, COMPACT_FORCE_COUNT_FILE) + 1;

    // MAX_RETRIES escape — 강제를 반복했는데도 해소되지 않음 → 통과 + 경고(무한 block 방지).
    if (count >= MAX_RETRIES) {
      resetRetryCount(claudeDir, COMPACT_FORCE_COUNT_FILE);
      logGate(sessionId, 'compact-force', 'warn', `escape pct=${pct}`);
      habitWarnings.push(
        `컨텍스트 사용률 ${pct}%가 지속됩니다. 자동 압축 강제를 ${MAX_RETRIES}회 시도했으나 ` +
          '해소되지 않아 이번 턴은 통과시킵니다. 수동으로 /compact 또는 새 세션을 권장합니다. (H1-03 강제)',
      );
      return { output: null, forced: true };
    }

    writeRetryCount(claudeDir, count, COMPACT_FORCE_COUNT_FILE);
    logGate(sessionId, 'compact-force', 'deny', `pct=${pct} retry=${count}`);
    return {
      output: {
        decision: 'block',
        reason:
          `컨텍스트 사용률 ${pct}%로 임계 초과. 자동 압축이 필요합니다. ` +
          `/compact 후 계속하세요. (H1-03 강제, ${count}/${MAX_RETRIES})`,
        // context-watchdog.sh와 동일한 자동 compact 유도 신호(하네스가 인식하면 자동 compact 수행).
        stopReason: 'compact_needed',
        additionalContext:
          `🔴 컨텍스트 사용량 ${pct}% (강제 임계 ${forcePct}% 초과). 자동 /compact를 실행합니다. ` +
          '현재 작업의 핵심 결정사항과 남은 작업에 집중하여 compact하세요.',
      },
      forced: true,
    };
  } catch {
    // fail-open — 판정 실패 시 강제하지 않는다.
    return { output: null, forced: false };
  }
}

function emit(out: HookOutput): void {
  // 차단 사유에 출처를 붙인다 — 하니스는 이걸 user 엔트리로 되먹이므로,
  //   (a) 서브에이전트가 프롬프트 인젝션으로 오인하지 않게 하고
  //   (b) 층0이 훅 자신의 발화를 "사용자가 쓴 인용"으로 착각하지 않게 한다.
  if (out.decision === 'block' && typeof out.reason === 'string') {
    out.reason = gateMessage(out.reason);
  }
  // 토큰-습관 경고들을 systemMessage에 덧붙인다(기존 systemMessage가 있으면 줄바꿈 append).
  // 리뷰 block/pass 어느 경로로 emit하든 사용자에게 보이도록 출력 단계에서 합친다.
  if (habitWarnings.length > 0) {
    const joined = habitWarnings.join('\n');
    out.systemMessage = out.systemMessage ? `${out.systemMessage}\n${joined}` : joined;
  }
  // (E1) 어떤 경로로 끝나든 상태 스냅샷을 남긴다 — updatedAt이 "hook 생존" 증명이다.
  if (snapshotSessionId) {
    try {
      const denies = readGateLog(snapshotSessionId).filter((e) => e.decision === 'deny').length;
      writeStatusSnapshot(snapshotSessionId, {
        context: null,
        ...statusSnapshot,
        gateDenies: denies,
      });
    } catch {
      // best-effort
    }
  }
  try {
    process.stdout.write(JSON.stringify(out));
  } catch {
    // best-effort
  }
}

function ensureClaudeDir(cwd: string): string {
  const dir = resolvePath(cwd, '.claude');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  return dir;
}

function readRetryCount(claudeDir: string, file: string = '.goodboy-retry-count.txt'): number {
  try {
    const path = resolvePath(claudeDir, file);
    if (!existsSync(path)) return 0;
    const raw = readFileSync(path, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeRetryCount(claudeDir: string, n: number, file: string = '.goodboy-retry-count.txt'): void {
  try {
    writeFileSync(resolvePath(claudeDir, file), String(n), 'utf8');
  } catch {
    // best-effort
  }
}

function resetRetryCount(claudeDir: string, file: string = '.goodboy-retry-count.txt'): void {
  try {
    const path = resolvePath(claudeDir, file);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** 리뷰 유효창(분). v0.26.7: 기본 30분 → 24시간(env GOODBOY_REVIEW_WINDOW_MIN).
 *  staleness가 파일별 편집 시각 기준(v0.26.5)이라 벽시계 창은 정합성 담보가 아니라
 *  위생 상한일 뿐인데, 30분은 "수락 전에 만료 → 같은 파일 재차단" 루프를 실측 유발했다. */
function reviewWindowMinutes(): number {
  return envInt('GOODBOY_REVIEW_WINDOW_MIN', 1440);
}

/**
 * (층0) 인용 검증 게이트 — **편집이 있든 없든** 매 턴 동작한다.
 *
 * 다른 모든 게이트는 편집이 있을 때만 발동한다. 그래서 코드베이스를 길게 설명하는
 * 답변 턴은 통째로 무방비였다 — `파일:줄`을 대고 단정해도 아무도 확인하지 않았다.
 *
 * 판정은 전부 결정적이다(LLM 없음):
 *   - 파일 없음 / 줄 범위 밖  → 확정 환각. 즉시 차단하고 정정을 요구한다.
 *   - 읽은 기록 없음          → 근거 미확인. 차단하되, 반복되면 hallucination 축 리뷰로 승격.
 *
 * fail-open 지점:
 *   - transcript를 못 읽으면 생략
 *   - 읽기 기록이 통째로 없으면(압축 직후 등) '읽은 기록 없음' 판정을 생략
 *   - `파일:줄` 형식이 아닌 단순 언급(백틱 경로)은 인용으로 보지 않는다
 *
 * @returns block 출력(차단) 또는 null(통과/비활성)
 */
function checkCitations(
  sessionId: string,
  cwd: string,
  transcriptPath: string | undefined,
): CitationProblem[] {
  if (envStr('GOODBOY_CLAIM_GATE', 'on') === 'off') return [];
  if (!transcriptPath) return [];
  try {
    // (플러시 대기) Stop 훅은 이번 턴 답변이 transcript에 기록되기 **전에** 실행될 수 있다.
    //   라이브 실측(P7): 답변 기록과 훅 실행이 130ms 차이라 게이트가 판정 대상을 못 보고
    //   환각 인용 3건을 전부 놓쳤다. 신선하지 않으면 짧게 폴링한다.
    //   상한 8초: Stop 훅 timeout(15초) 안에서 나머지 게이트에 여유를 남긴다.
    //   끝내 안 보이면 **직전 턴 답변을 판정하지 않고** 통과시킨다 — 이미 정정된 주장을
    //   재차단하는 것이 미검출보다 나쁘다. GOODBOY_CLAIM_FLUSH_WAIT_MS=0으로 비활성.
    //   사용자 프롬프트 자체가 없는 transcript('unknown')는 기다려도 답변이 나타나지
    //   않으므로 대기하지 않는다 — 이걸 구분하지 않으면 매 턴 헛되이 대기한다.
    const waitMs = Math.min(envInt('GOODBOY_CLAIM_FLUSH_WAIT_MS', 3000), 8000);
    const freshness = assistantTextFreshness(transcriptPath);
    if (freshness === 'unknown') return [];
    if (freshness === 'pending') {
      if (waitMs <= 0) return [];
      const startMs = Date.now();
      const deadline = startMs + waitMs;
      let fresh = false;
      while (Date.now() < deadline) {
        Bun.sleepSync(200);
        if (assistantTextFreshness(transcriptPath) === 'fresh') {
          fresh = true;
          break;
        }
      }
      logGate(
        sessionId,
        'claim',
        'warn',
        `${fresh ? 'flush-wait-hit' : 'flush-wait-miss'}(${Date.now() - startMs}ms)`,
      );
      if (!fresh) return [];
    }
    const last = extractRecentAssistantTexts(transcriptPath, 1)[0] ?? '';
    if (last === '') return [];
    // 사용자가 프롬프트에 먼저 쓴 인용은 모델의 주장이 아니다 — 존재하지 않는 경로를
    //   사용자가 대고 모델이 "그런 파일 없습니다"라고 답하는 정직한 경우를 벌하지 않는다.
    //   단, **훅 자신의 차단 메시지는 제외한다.** 하니스가 Stop 훅 피드백을 user 엔트리로
    //   기록하는데, 그 안에 문제의 인용이 그대로 들어 있어서 "사용자가 먼저 쓴 것"으로
    //   둔갑했다 — 첫 차단 이후 같은 환각이 영구 면역되던 실측 결함(P9).
    const citations = excludeUserOriginated(
      extractCitations(last, cwd),
      extractRecentUserTexts(transcriptPath, 3).filter((t) => !isGateMessage(t)),
      cwd,
    );
    if (citations.length === 0) return [];
    const turn = getCurrentTurn(sessionId);
    return verifyCitations(citations, {
      readTrackingAvailable: hasAnyReadRecords(sessionId),
      // 세션 전체를 창으로 본다 — 인용의 근거는 "언제 읽었나"가 아니라 "읽었나"다.
      wasRead: (abs) => wasFileReadRecently(sessionId, abs, turn, turn + 1),
    });
  } catch (err) {
    process.stderr.write(`[goodboy stop] citation check error: ${String(err)}\n`);
    return [];
  }
}

function claimGate(
  sessionId: string,
  cwd: string,
  claudeDir: string,
  transcriptPath: string | undefined,
): HookOutput | null {
  try {
    const problems = checkCitations(sessionId, cwd, transcriptPath);
    if (problems.length === 0) {
      resetRetryCount(claudeDir, CLAIM_COUNT_FILE);
      return null;
    }

    const hallucinated = hallucinatedCitations(problems);
    const unread = unreadCitations(problems);

    const count = readRetryCount(claudeDir, CLAIM_COUNT_FILE) + 1;
    if (count >= MAX_RETRIES) {
      // 영구 차단 방지 — 통과시키되 사용자에게 알린다.
      resetRetryCount(claudeDir, CLAIM_COUNT_FILE);
      logGate(sessionId, 'claim', 'warn', 'escape');
      habitWarnings.push(
        `인용 검증이 ${MAX_RETRIES}회 차단 후에도 해소되지 않아 이번 턴은 통과시킵니다. ` +
          `사용자 확인이 필요합니다. (${(hallucinated[0] ?? unread[0])?.detail ?? ''})`,
      );
      return null;
    }
    writeRetryCount(claudeDir, count, CLAIM_COUNT_FILE);

    if (hallucinated.length > 0) {
      logGate(sessionId, 'claim', 'deny', `hallucinated(${hallucinated.length})`);
      return {
        decision: 'block',
        reason: `${citationBlockMessage(hallucinated)} (재시도 ${count}/${MAX_RETRIES})`,
      };
    }
    logGate(sessionId, 'claim', 'deny', `unread(${unread.length})`);
    return {
      decision: 'block',
      reason: `${unreadBlockMessage(unread, count >= 2)} (재시도 ${count}/${MAX_RETRIES})`,
    };
  } catch (err) {
    // fail-open — 게이트 자체의 오류가 턴을 막지 않는다.
    process.stderr.write(`[goodboy stop] claim gate error: ${String(err)}\n`);
    return null;
  }
}

/** 테스트 결과 유효창(분). 리뷰와 같은 기본값(24h) — 근거도 같다(벽시계 창은 위생 상한). */
function testWindowMinutes(): number {
  return envInt('GOODBOY_TEST_WINDOW_MIN', 1440);
}

/**
 * (층1) 이 저장소에서 테스트 게이트를 켤 것인가.
 *
 * `GOODBOY_TEST_GATE` = `auto`(기본) | `on` | `off`.
 *
 * `auto`인 이유: 무조건 켜면 **테스트를 돌릴 수단이 없는 저장소**에서 마찰만 남는다.
 * 라이브 실측에서 빈 저장소에 파일 하나 만드는 작업이 3회 차단 후 escape로 끝났다 —
 * 아무것도 검증하지 못하면서 경고만 남는, 게이트의 최악 결말이다. 반대로 dev-cycle
 * 산출물이 있으면(요구사항·프로토타입이 확정된 작업) 인프라 유무와 무관하게 켠다.
 * 테스트를 새로 도입해서라도 검증해야 하는 상황이기 때문이다.
 */
function testGateActive(cwd: string): { active: boolean; evidence: string } {
  const mode = envStr('GOODBOY_TEST_GATE', 'auto');
  if (mode === 'off') return { active: false, evidence: 'off' };
  if (mode === 'on') return { active: true, evidence: 'on' };
  if (findDevCycleArtifacts(cwd) !== null) {
    return { active: true, evidence: 'dev-cycle 산출물' };
  }
  const infra = detectTestInfrastructure(cwd);
  return { active: infra.present, evidence: infra.evidence };
}

/**
 * (층1) 이 파일이 테스트 커버리지 요구 대상인가.
 *
 * 두 부류를 뺀다. 둘 다 "요구해도 해소할 방법이 없어서 escape로만 끝나는" 부류다:
 *   - 테스트 파일 — 테스트를 테스트하라는 무한 후퇴(실측: tests/hello.test.ts)
 *   - 문서 파일 — README를 단위 테스트할 수 없다(실측: README.md 등 5개 요구)
 */
function needsTestCoverage(file: string): boolean {
  return !isTestFile(file) && !isDocFile(file);
}

/**
 * (층1) stop_hook_active 조기 return 경로의 **비차단** 테스트 수락 시도.
 *
 * "차단 → 테스트 실행 → 턴 종료"가 테스트 게이트 해소의 표준 경로인데, 그 턴 종료는
 * 항상 stop_hook_active=true라 조기 return되어 검증·수락이 다음 full Stop으로 미뤄진다.
 * 다음 턴이 없으면(예: `-p` 단발 세션) 결과가 **영영 검증되지 않은 채 세션이 끝난다**
 * — 라이브 실측: 테스트 결과 JSON이 만들어졌는데 커서가 전진하지 않고 세션 종료.
 *
 * 리뷰의 tryAcceptPendingReview와 같은 원칙이다: 여기서는 절대 차단하지 않고,
 * 조건이 충족될 때만 조용히 수락(커서 전진)한다.
 *
 * @returns 이번 호출에서 실제로 수락(커서 전진)했으면 true. 호출부는 이 신호로
 *          "직전 차단이 해소됐다"를 알고 다음 층(리뷰)까지 이어서 판정한다.
 */
function tryAcceptPendingTest(sessionId: string, cwd: string, claudeDir: string): boolean {
  if (!testGateActive(cwd).active) return false;
  try {
    const cursor = readTestCursor(cwd);
    const cursorTurn = cursor ? cursor.turn : 0;
    const recentEdits = getEditsSince(sessionId, cursorTurn, cwd).filter(needsTestCoverage);
    if (recentEdits.length === 0) return false;
    const results = findRecentTestFiles(resolvePath(cwd, '.claude', 'tests'), testWindowMinutes());
    if (results.length === 0) return false;
    const changedEdits = getEditsWithLastTimestampSince(sessionId, cursorTurn, cwd).filter((e) =>
      needsTestCoverage(e.file),
    );
    const cov = validateTestCoverage(results, changedEdits);
    if (!cov.ok) return false;
    const effective = cov.effective.length > 0 ? cov.effective : results.slice(0, 1);
    if (failingSuites(effective)) return false;
    if (missingTestFiles(effective)) return false;
    if (validateEvidence(effective)) return false;
    if (scanForbiddenPatterns(effective.flatMap((r) => r.test_files ?? [])).length > 0) return false;
    if (uncoveredCriteria(effective, requiredAcceptanceCriteria(cwd)).length > 0) return false;
    // 수락.
    resetRetryCount(claudeDir, TEST_COUNT_FILE);
    writeTestCursor(cwd, getCurrentTurn(sessionId));
    statusSnapshot.testPending = false;
    logGate(sessionId, 'test', 'warn', 'accept-on-stop-active');
    return true;
  } catch {
    // fail-open — 수락 시도 실패가 조기 return 경로를 막지 않는다.
    return false;
  }
}

/**
 * (층1) 테스트 게이트 — 리뷰 게이트 **앞**에서 동작 검증을 강제한다.
 *
 * 순서가 중요하다: 리뷰(리팩토링·성능·보안)는 "동작은 맞다"를 전제로 하는 검토라,
 * 테스트가 통과하지 않은 코드를 리뷰하는 것은 순서가 뒤집힌 것이다.
 *
 * 검사하는 것(전부 결정적):
 *   - 변경 파일 커버리지 + 파일별 staleness
 *   - 스위트 실패 0
 *   - test_files 실재 — 임시 프로브를 테스트로 위장하는 것을 막는다
 *   - red-green 증거 — 되돌린 상태에서 실패함을 종료 코드로 보였는가
 *   - 뮤테이션 프로브(UI 축) — 대상을 훼손하면 실패하는가
 *   - 수용 기준 커버리지 — dev-cycle 산출물이 요구한 항목을 커버했는가
 *   - 가짜 테스트 패턴 정적 검사
 *
 * @returns block 출력(차단) 또는 null(통과/게이트 비활성)
 */
function testGate(sessionId: string, cwd: string, claudeDir: string): HookOutput | null {
  const gate = testGateActive(cwd);
  try {
    const cursor = readTestCursor(cwd);
    const cursorTurn = cursor ? cursor.turn : 0;
    // 문서·테스트 파일만 바뀐 턴은 층1의 관심사가 아니다 — 요구해도 해소할 방법이 없다.
    const recentEdits = getEditsSince(sessionId, cursorTurn, cwd).filter(needsTestCoverage);
    if (recentEdits.length === 0) {
      statusSnapshot.testPending = false;
      return null;
    }
    // 비활성 판정은 **편집이 있을 때** 알린다 — 편집도 없는 턴에 "테스트 층이 꺼져 있다"고
    //   말해봐야 소음이다. 조용히 꺼져 있으면 사용자가 층의 부재를 눈치채지 못한다.
    if (!gate.active) {
      statusSnapshot.testPending = false;
      if (gate.evidence !== 'off') {
        const state = readHabitState(sessionId);
        if (state.testGateInactiveWarned !== true) {
          state.testGateInactiveWarned = true;
          writeHabitState(sessionId, state);
          logGate(sessionId, 'test', 'warn', 'inactive: no-test-infrastructure');
          habitWarnings.push(
            `층1 테스트 게이트가 이 저장소에서 비활성입니다 — 테스트를 돌릴 수단을 찾지 ` +
              `못했습니다(테스트 디렉터리/설정 파일/package.json scripts.test 등). ` +
              `강제하려면 \`GOODBOY_TEST_GATE=on\` 으로 켜세요.`,
          );
        }
      }
      return null;
    }
    statusSnapshot.testPending = true;

    const testsDir = resolvePath(cwd, '.claude', 'tests');
    const results = findRecentTestFiles(testsDir, testWindowMinutes());

    const block = (reason: string): HookOutput | null => {
      const count = readRetryCount(claudeDir, TEST_COUNT_FILE) + 1;
      if (count < MAX_RETRIES) {
        writeRetryCount(claudeDir, count, TEST_COUNT_FILE);
        // 자르지 않는다 — gate-log가 자체 상한(300자)으로 다듬는다. 80자로 잘랐더니
        //   라이브 로그에서 어떤 파일이 문제인지 보이지 않았다(경로가 `/pr` 에서 끊김).
        logGate(sessionId, 'test', 'deny', reason);
        return {
          decision: 'block',
          reason: `${reason} (테스트 게이트, 재시도 ${count}/${MAX_RETRIES})`,
        };
      }
      // 한계 초과 → 통과 + 알림 + 커서 전진(영구 차단 방지 — 리뷰 게이트와 동일 패턴).
      resetRetryCount(claudeDir, TEST_COUNT_FILE);
      writeTestCursor(cwd, getCurrentTurn(sessionId));
      // 사유를 함께 남긴다 — 라이브 검증에서 'escape'만 기록돼 3번째 차단 이유를
      //   사후에 알 수 없었다(계측 원칙: 게이트가 왜 새어나갔는지 추적 가능해야 한다).
      logGate(sessionId, 'test', 'warn', `escape: ${reason}`);
      habitWarnings.push(
        `테스트 게이트가 ${MAX_RETRIES}회 차단 후에도 해소되지 않아 이번 턴은 통과시킵니다. ` +
          `사용자 확인이 필요합니다. (사유: ${reason})`,
      );
      return null;
    };

    if (results.length === 0) {
      const preview = recentEdits.slice(0, 5).join(', ');
      const more = recentEdits.length > 5 ? ` 외 ${recentEdits.length - 5}개` : '';
      return block(
        `변경된 코드에 대한 테스트가 없습니다. test-changes 서브에이전트를 호출해 ` +
          `단위/통합 테스트를 작성·실행하고 결과를 기록하세요: ${preview}${more}`,
      );
    }

    // 테스트 파일 자체는 커버리지 요구 대상에서 뺀다 — 테스트를 테스트하라는 무한 후퇴가
    //   된다(라이브 실측: `tests/hello.test.ts` 가 "테스트되지 않은 변경 파일"로 잡혔다).
    //   문서도 같은 이유로 뺀다(라이브 실측: README.md 등 5개를 요구했다).
    const changedEdits = getEditsWithLastTimestampSince(sessionId, cursorTurn, cwd).filter((e) =>
      needsTestCoverage(e.file),
    );
    const cov = validateTestCoverage(results, changedEdits);
    if (!cov.ok) {
      return block(`테스트 검증 실패: ${cov.reason ?? '알 수 없는 이유'}.`);
    }
    const effective = cov.effective.length > 0 ? cov.effective : results.slice(0, 1);

    const suiteFail = failingSuites(effective);
    if (suiteFail) return block(`${suiteFail}. 원인을 수정하고 다시 테스트하세요.`);

    const missingFiles = missingTestFiles(effective);
    if (missingFiles) return block(missingFiles);

    const evidenceIssue = validateEvidence(effective);
    if (evidenceIssue) {
      return block(
        `테스트 증거가 불충분합니다: ${evidenceIssue} ` +
          `되돌린 상태에서 실패(red)하고 지금은 통과(green)함을 실행으로 보여야 합니다.`,
      );
    }

    const forbidden = scanForbiddenPatterns(effective.flatMap((r) => r.test_files ?? []));
    if (forbidden.length > 0) {
      const list = forbidden
        .slice(0, 3)
        .map((h) => `${h.file}: ${h.message}`)
        .join(' / ');
      return block(
        `통과하지만 아무것도 검증하지 않는 테스트 패턴이 있습니다: ${list}` +
          `${forbidden.length > 3 ? ` 외 ${forbidden.length - 3}건` : ''}`,
      );
    }

    const required = requiredAcceptanceCriteria(cwd);
    const uncovered = uncoveredCriteria(effective, required);
    if (uncovered.length > 0) {
      const list = uncovered
        .slice(0, 3)
        .map((c) => `${c.id}(${c.description})`)
        .join('; ');
      return block(
        `확정된 요구사항/프로토타입이 요구하는 수용 기준이 테스트로 커버되지 않았습니다: ` +
          `${list}${uncovered.length > 3 ? ` 외 ${uncovered.length - 3}건` : ''}. ` +
          `\`bun \${CLAUDE_PLUGIN_ROOT}/lib/cli.ts acceptance-list\` 로 전체 목록을 확인하세요.`,
      );
    }

    // 통과 → 커서 전진 + 카운터 리셋.
    resetRetryCount(claudeDir, TEST_COUNT_FILE);
    writeTestCursor(cwd, getCurrentTurn(sessionId));
    statusSnapshot.testPending = false;
    return null;
  } catch (err) {
    // fail-open — 게이트 자체의 오류가 턴을 막지 않는다.
    process.stderr.write(`[goodboy stop] test gate error: ${String(err)}\n`);
    return null;
  }
}

/** (v0.26.7, v0.26.8 보강) stop_hook_active 조기 return 경로의 비차단 리뷰 수락 시도.
 *
 *  "차단 → 리뷰 실행 → 턴 종료"가 리뷰 게이트 해소의 표준 경로인데, 그 턴 종료는
 *  항상 stop_hook_active=true라 조기 return되어 수락(커서 전진)이 영원히 다음
 *  full Stop으로 미뤄진다 — 그 사이 리뷰가 만료되면 같은 파일 집합으로 재차단(실측).
 *
 *  수락 조건은 full Stop의 차단 게이트와 동일하다(v0.26.8 — 리뷰 high 지적 대응:
 *  여기서 F1.5/F2를 건너뛰면 표준 경로에서 그 게이트들이 사실상 발화하지 않는
 *  우회가 된다). 조건 미달이면 수락하지 않고 다음 full Stop의 정식 차단에 맡긴다
 *  — 유효창이 24h라 수락 보류가 만료 루프를 만들지 않는다. 어떤 경우에도 여기서
 *  차단하지는 않는다(무한 block 방지 속성 유지).
 *
 *  반환: 수락 시 사용자에게 표면화할 systemMessage(발견사항 없으면 빈 문자열),
 *  수락하지 않으면 null. medium/low finding을 조용히 소비하지 않기 위함(v0.26.8). */
function tryAcceptPendingReview(
  sessionId: string,
  cwd: string,
  transcriptPath: string | undefined,
): string | null {
  try {
    const cursor = readReviewCursor(cwd);
    const cursorTurn = cursor ? cursor.turn : 0;
    const recentEdits = getEditsSince(sessionId, cursorTurn, cwd);
    if (recentEdits.length === 0) return null;
    const reviewsDir = resolvePath(cwd, '.claude', 'reviews');
    const reviews = findRecentReviewFiles(reviewsDir, reviewWindowMinutes());
    if (reviews.length === 0) return null;
    const changedEdits = getEditsWithLastTimestampSince(sessionId, cursorTurn, cwd);
    const v = validateReviewCoverage(reviews, changedEdits);
    if (!v.ok) return null;
    const active = currentFindings(reviews, cursor ? cursor.timestamp : null);
    // (F 상당) high는 수락 보류 — 다음 full Stop이 정식으로 차단/안내한다.
    if (active.some((f) => f && f.severity === 'high')) return null;
    const effective = v.effective;
    // (F1.5 상당) 추측/가정을 선언했는데 리뷰가 가정 검증을 안 했으면 수락 보류.
    const declaredUnknowns = (() => {
      try {
        if (!transcriptPath) return 0;
        for (const t of extractRecentAssistantTexts(transcriptPath, 50)) {
          if (hasReasoningSection(t)) {
            const sec = parseReasoningSection(t);
            return sec ? sec.speculations.length + sec.assumptions.length : 0;
          }
        }
        return 0;
      } catch {
        return 0;
      }
    })();
    const checkedAssumptions = effective.reduce(
      (sum, r) =>
        sum + (Array.isArray(r.unknown_assumptions_checked) ? r.unknown_assumptions_checked.length : 0),
      0,
    );
    if (declaredUnknowns > 0 && checkedAssumptions === 0) return null;
    // (F2 상당) 필수 차원 누락이면 수락 보류.
    const requiredDims = requiredDimensionsFor(recentEdits);
    const checkedDims = new Set(
      effective.flatMap((r) => (Array.isArray(r.dimensions_checked) ? r.dimensions_checked : [])),
    );
    if (requiredDims.some((d) => !checkedDims.has(d))) return null;
    // 수락.
    writeReviewCursor(cwd, getCurrentTurn(sessionId));
    const claudeDir = ensureClaudeDir(cwd);
    resetRetryCount(claudeDir, REVIEW_VALIDATE_COUNT_FILE);
    resetRetryCount(claudeDir);
    statusSnapshot.reviewPending = false;
    // 수락은 평소 기록하지 않지만, 이 경로는 신설이라 관측 가능성을 위해 남긴다.
    logGate(sessionId, 'review', 'warn', 'accept-on-stop-active');
    // (G 상당) medium/low finding은 조용히 소비하지 않고 표면화한다(v0.26.8).
    const others = active.filter((f) => f && f.severity !== 'high');
    if (others.length === 0) return '';
    const sev = others
      .slice(0, 3)
      .map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue}`)
      .join('; ');
    const more = others.length > 3 ? ` (외 ${others.length - 3}개)` : '';
    return `리뷰 통과(수락). 참고할 발견사항: ${sev}${more}`;
  } catch {
    // fail-open — 수락 시도 실패가 조기 return 경로를 막지 않는다.
    return null;
  }
}

function main(): void {
  readStdin()
    .then((raw) => {
      let input: StopInput = {};
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as StopInput);
      } catch (err) {
        process.stderr.write(`[goodboy stop] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? 'unknown';
      snapshotSessionId = sessionId;

      // (A) 턴 증가
      try {
        incrementTurn(sessionId);
      } catch (err) {
        process.stderr.write(`[goodboy stop] incrementTurn error: ${String(err)}\n`);
      }

      // (A0.5, v0.27.5) 리뷰 파일 위생 — 실사용 보고: .claude/reviews/*.json이 무한정
      //   쌓인다. 유효창을 지난 리뷰는 게이트가 다시는 읽지 않으므로 보존 기간
      //   (GOODBOY_REVIEW_RETENTION_MIN, 기본 3일; 0 이하로 비활성) 경과분을 삭제한다.
      //   유효창보다 짧게 설정돼도 아직 유효한 리뷰는 지우지 않게 클램프한다.
      try {
        const retention = envInt('GOODBOY_REVIEW_RETENTION_MIN', 4320);
        if (retention > 0) {
          const pruned = pruneOldReviewFiles(
            resolvePath(cwd, '.claude', 'reviews'),
            Math.max(retention, reviewWindowMinutes()),
          );
          if (pruned > 0) logGate(sessionId, 'review', 'warn', `pruned-old-reviews(${pruned})`);
        }
      } catch {
        // best-effort — 위생 실패가 Stop 처리를 막지 않는다.
      }

      // (A0.6) 테스트 결과 파일 위생 — 리뷰와 동일 정책.
      try {
        const retention = envInt('GOODBOY_TEST_RETENTION_MIN', 4320);
        if (retention > 0) {
          const pruned = pruneOldTestFiles(
            resolvePath(cwd, '.claude', 'tests'),
            Math.max(retention, testWindowMinutes()),
          );
          if (pruned > 0) logGate(sessionId, 'test', 'warn', `pruned-old-tests(${pruned})`);
        }
      } catch {
        // best-effort
      }

      // (E1) 스냅샷: 카테고리/위험도(session-state에서, 현재 세션 것만).
      try {
        const statePath = resolvePath(cwd, '.claude', '.goodboy-session-state.json');
        if (existsSync(statePath)) {
          const st = JSON.parse(readFileSync(statePath, 'utf8')) as {
            category?: string;
            risk?: string;
            sessionId?: string;
          };
          if (st && st.sessionId === sessionId) {
            statusSnapshot.category = st.category ?? null;
            statusSnapshot.risk = st.risk ?? null;
          }
        }
      } catch {
        // best-effort
      }

      // (B) 무한루프 방지 — 단, 리뷰 수락은 여기서도 시도한다(v0.26.7).
      //   "차단 → 리뷰 실행 → 턴 종료(stop_hook_active=true)"가 리뷰 게이트 해소의
      //   표준 경로인데, 이 조기 return이 수락(커서 전진)까지 건너뛰면 pass 리뷰가
      //   소비되지 않은 채 유효창을 넘겨 만료되고 같은 파일 집합으로 재차단되는
      //   루프가 된다(실측: 07:00 pass 리뷰가 커서 미전진 상태로 07:42에 만료 차단).
      //   tryAcceptPendingReview는 절대 차단하지 않는다 — 조건이 안 되면 조용히 통과.
      if (input.stop_hook_active === true) {
        // 층0: 이 경로에서는 절대 차단하지 않지만, 정정 후에도 여전히 실재하지 않는
        //   위치를 인용하고 있으면 사용자에게 보이도록 경고만 남긴다(무한 block 방지 유지).
        try {
          const stillWrong = hallucinatedCitations(
            checkCitations(sessionId, cwd, input.transcript_path),
          );
          if (stillWrong.length > 0) {
            logGate(sessionId, 'claim', 'warn', 'still-hallucinated-on-stop-active');
            habitWarnings.push(
              `정정 후에도 실재하지 않는 위치를 인용하고 있습니다: ${stillWrong[0]!.detail}`,
            );
          }
        } catch {
          // fail-open
        }
        // 층1도 같은 이유로 여기서 수락을 시도한다 — 표준 경로("차단 → 테스트 실행 →
        //   턴 종료")의 종료가 항상 stop_hook_active라, 여기서 수락하지 않으면 결과가
        //   검증되지 않은 채 세션이 끝난다(라이브 실측).
        const testAccepted = tryAcceptPendingTest(sessionId, cwd, ensureClaudeDir(cwd));
        if (!testAccepted) {
          const acceptMsg = tryAcceptPendingReview(sessionId, cwd, input.transcript_path);
          emit(acceptMsg ? { systemMessage: acceptMsg } : {});
          return;
        }
        // 층1을 방금 수락했다면 조기 return 하지 않고 **층2까지 이어서 판정한다.**
        //   조기 return의 목적은 "직전 차단에 대응한 턴을 또 막지 않기"인데, 테스트
        //   수락은 그 차단이 **해소됐다**는 뜻이므로 다음 층으로 넘어가는 것이 맞다.
        //   그러지 않으면 층1만 만족시키고 층2를 건너뛸 수 있다 — 라이브 실측(P14):
        //   테스트는 red-green까지 제대로 했는데 리뷰는 gate-log에 흔적조차 없이 종료.
        //   수락은 커서를 전진시켜 1회성이라(다음 Stop에선 recentEdits가 비어 false)
        //   이 경로가 반복되지 않는다 — 무한 루프가 되지 않는 근거다.
        logGate(sessionId, 'test', 'warn', 'continue-to-review-after-accept');
      }

      // (B2) 컨텍스트 사용량 측정. 측정 실패(null)면 강제/경고를 모두 생략한다(fail-open).
      let usage: ReturnType<typeof getContextUsage> = null;
      if (input.transcript_path) {
        try {
          usage = getContextUsage(input.transcript_path, {
            hookInput: input,
            settingsPath: settingsJsonPath(),
          });
        } catch {
          usage = null;
        }
        // (E1 canary) transcript가 있는데 측정이 계속 실패하면 컨텍스트 게이트가
        //   통째로 무력화된 상태일 수 있다(비공식 포맷 변경 등). fail-open의 맹점을
        //   가시화한다: 매 실패를 기록하고, 연속 3회부터 세션당 1회 사용자에게 알린다.
        if (usage === null) {
          logGate(sessionId, 'context-usage', 'fail-open', 'usage-parse-failed');
          try {
            const st = readHabitState(sessionId);
            st.ctxMeasureFailStreak = (st.ctxMeasureFailStreak ?? 0) + 1;
            if (st.ctxMeasureFailStreak >= 3 && !st.ctxParseWarned) {
              st.ctxParseWarned = true;
              habitWarnings.push(
                '컨텍스트 사용량 측정이 계속 실패하고 있습니다(transcript 포맷 변경 가능성). ' +
                  '컨텍스트 자동 관리(경고/강제 compact)가 비활성 상태일 수 있습니다. (계측 canary, E1)',
              );
            }
            writeHabitState(sessionId, st);
          } catch {
            // fail-open
          }
        } else {
          try {
            const st = readHabitState(sessionId);
            if ((st.ctxMeasureFailStreak ?? 0) !== 0) {
              st.ctxMeasureFailStreak = 0;
              writeHabitState(sessionId, st);
            }
          } catch {
            // fail-open
          }
        }
      }
      // (E1) 스냅샷: 게이트가 실제로 쓰는 컨텍스트 계산값.
      statusSnapshot.context = usage
        ? {
            percent: Math.round(usage.percent),
            tokens: usage.tokens,
            limit: usage.limit,
            confident: usage.confident,
          }
        : null;

      // (B2.5) H2-01 epoch 리셋 — 세션 내 컨텍스트 점유율은 원래 단조 증가하므로,
      //   큰 폭의 하락은 압축(/compact, auto-compact)이 일어났다는 신호다. 압축 후에는
      //   앞서 읽은 파일 내용이 모델 컨텍스트에서 사라졌으므로 재-Read 차단의 전제가 깨진다
      //   → read 기록을 비워 "압축 이후"를 새 기준으로 삼는다. 이 리셋이 있어 재-Read
      //   윈도우를 길게(기본 30턴) 잡아도 압축 직후 오차단이 없다. fail-open.
      try {
        if (usage) {
          const st = readHabitState(sessionId);
          const dropPct = envInt('GOODBOY_COMPACT_DETECT_DROP_PCT', 15);
          if (typeof st.lastCtxPercent === 'number' && usage.percent < st.lastCtxPercent - dropPct) {
            clearReadRecords(sessionId);
          }
          st.lastCtxPercent = usage.percent;
          writeHabitState(sessionId, st);
        }
      } catch {
        // fail-open
      }

      // (B3) H1-03 강제 자동 compact — 컨텍스트 점유율이 강제 임계(기본 50%) 이상이면
      //   자동 compact 신호 + decision:block으로 턴 종료를 막아 확실히 compact를 강제한다.
      //   무한 block은 stop_hook_active(위 B)와 MAX_RETRIES escape로 방지한다.
      const force = maybeForceCompact(usage, cwd, sessionId);

      // (B4) H1-01 긴 세션 경고 준비 — 강제가 발동했으면(force.forced) 스팸 방지로 생략.
      //   emit()이 이후 모든 출력 경로의 systemMessage에 habitWarnings를 덧붙인다.
      maybeSetLongSessionWarning(usage, sessionId, force.forced);

      // (B4.5) H4-03 — 세션 내 메인 모델 전환 감지(세션당 1회 경고).
      //   usage 줄의 모델만 비교하므로 서브에이전트의 다른 모델(정상 패턴)은 오탐하지 않는다.
      //   전환 자체를 막을 수는 없다(사용자 행동) — 캐시 무효화 비용을 알리는 권고까지가 상한.
      if (usage && usage.modelsSeen.length > 1) {
        try {
          const st = readHabitState(sessionId);
          if (!st.modelSwitchWarned) {
            st.modelSwitchWarned = true;
            writeHabitState(sessionId, st);
            habitWarnings.push(
              `이 세션에서 모델 전환이 감지되었습니다(${usage.modelsSeen.join(' → ')}). ` +
                '모델 전환은 프롬프트 캐시를 무효화해 비용을 높입니다 — 전환이 필요하면 새 세션을 권장합니다. (캐시 킬 방지, H4-03)',
            );
          }
        } catch {
          // fail-open
        }
      }

      // 강제 block이 결정되면 리뷰 검사보다 우선해 즉시 emit하고 종료한다.
      //   (B)의 무한루프 early-return은 위에서 끝나므로 강제/경고가 붙지 않는다.
      if (force.output) {
        emit(force.output);
        return;
      }

      // (B5) C1 — 자동 검증 실패 게이트. PostToolUse가 남긴 실패 마커가 살아 있으면
      //   턴 종료를 차단한다(편집→재검증 통과 시 PostToolUse가 마커를 지워 해제됨).
      //   - 세션 바인딩: 현재 세션이 남긴 마커만 신뢰(이월/커밋 잔재로 인한 오차단 방지).
      //   - 무한 block 방지: 전용 카운터 + MAX_RETRIES escape(초과 시 통과 + 사용자 알림).
      const claudeDir = ensureClaudeDir(cwd);
      const vf = (() => {
        try {
          return readValidationFailure(cwd);
        } catch {
          return null;
        }
      })();
      statusSnapshot.validationFailed = !!(vf && vf.sessionId === sessionId);
      if (vf && vf.sessionId === sessionId) {
        const cmds = vf.commands.length > 0 ? vf.commands.join(', ') : '자동 검증';
        const count = readRetryCount(claudeDir, VALIDATION_COUNT_FILE) + 1;
        if (count < MAX_RETRIES) {
          writeRetryCount(claudeDir, count, VALIDATION_COUNT_FILE);
          logGate(sessionId, 'validation', 'deny', cmds);
          emit({
            decision: 'block',
            reason:
              `자동 검증이 실패한 상태입니다: ${cmds}. 원인을 수정하세요 — ` +
              `파일을 편집하면 검증이 자동 재실행되고, 통과하면 이 차단이 해제됩니다. ` +
              `(검증 게이트, 재시도 ${count}/${MAX_RETRIES})`,
          });
          return;
        }
        // 한계 초과 → 통과 + 사용자 알림 + 마커/카운터 정리(영구 차단 방지).
        resetRetryCount(claudeDir, VALIDATION_COUNT_FILE);
        clearValidationFailure(cwd);
        logGate(sessionId, 'validation', 'warn', 'escape');
        habitWarnings.push(
          `자동 검증 실패가 ${MAX_RETRIES}회 차단 후에도 해소되지 않아 이번 턴은 통과시킵니다. ` +
            `사용자 확인이 필요합니다. (실패: ${cmds})`,
        );
      } else {
        // 마커 없음/타 세션 마커 → 카운터 리셋(다음 실패는 새로 3회 기회).
        resetRetryCount(claudeDir, VALIDATION_COUNT_FILE);
      }

      // (B5.5) 층0 — 인용 검증. **편집 유무와 무관하게** 매 턴 동작하는 유일한 게이트다.
      //   답변만 하는 턴(코드베이스 설명 등)은 이 게이트가 없으면 통째로 무검증이다.
      const claimBlock = claimGate(sessionId, cwd, claudeDir, input.transcript_path);
      if (claimBlock) {
        emit(claimBlock);
        return;
      }

      // (B6) 층1 — 테스트 게이트. 리뷰보다 **먼저** 동작을 검증한다.
      //   리뷰(리팩토링·성능·보안)는 "동작은 맞다"를 전제로 하는 검토라, 테스트가
      //   통과하지 않은 코드를 리뷰하는 것은 순서가 뒤집힌 것이다.
      const testBlock = testGate(sessionId, cwd, claudeDir);
      if (testBlock) {
        emit(testBlock);
        return;
      }

      // (C) 변경 검사 — 마지막으로 수락된 리뷰(커서) 이후 편집된 파일만 본다.
      //   커서 부재(첫 리뷰) → turn 0 = 세션 시작 이후 모든 편집.
      //   고정 5턴 윈도우(BUG #2) 대신 커서 기반으로 정확한 per-feature 스코프를 얻는다.
      const cursor = (() => {
        try {
          return readReviewCursor(cwd);
        } catch {
          return null;
        }
      })();
      // 커서 부재(첫 리뷰) → baseline 0: getEditsSince(>=0)로 세션 전체 편집을 포함.
      const cursorTurn = cursor ? cursor.turn : 0;
      // withinDir=cwd: 프로젝트 안의 파일만 리뷰 대상. 리뷰 에이전트의 프로브 파일은
      //   `mktemp -d`(프로젝트 밖)에 만들도록 강제하므로 자기참조 루프가 끊긴다.
      //   에이전트로는 거르지 않는다 — 서브에이전트 편집도 리뷰 대상(위임 우회 차단).
      const recentEdits = (() => {
        try {
          return getEditsSince(sessionId, cursorTurn, cwd);
        } catch {
          return [];
        }
      })();
      if (recentEdits.length === 0) {
        statusSnapshot.reviewPending = false;
        emit({});
        return;
      }
      statusSnapshot.reviewPending = true;

      // (D) 리뷰 검사 — 30분 유효창 내 모든 리뷰 파일(v0.26.5: 리뷰 누적 인정).
      //   최신 1개만 보면 부분 리뷰 2개가 서로를 무효화하는 두더지잡기가 된다(실측).
      const reviewsDir = resolvePath(cwd, '.claude', 'reviews');
      const reviews = (() => {
        try {
          return findRecentReviewFiles(reviewsDir, reviewWindowMinutes());
        } catch {
          return [] as ReturnType<typeof findRecentReviewFiles>;
        }
      })();
      if (reviews.length === 0) {
        const preview = recentEdits.slice(0, 5).join(', ');
        const more = recentEdits.length > 5 ? ` 외 ${recentEdits.length - 5}개` : '';
        logGate(sessionId, 'review', 'deny', 'no-review-file');
        emit({
          decision: 'block',
          reason: `변경된 파일에 대해 리뷰가 필요합니다. /review-changes 슬래시 커맨드 또는 review-changes 서브에이전트를 호출하여 다음 파일을 리뷰하세요: ${preview}${more}`,
        });
        return;
      }

      // (E) 파일별 커버리지 + staleness(v0.26.5) — 각 변경 파일은 "그 파일의 마지막
      //   편집보다 나중인 커버 리뷰"가 있으면 된다. 전역 staleness(최신 편집 1개 시각)는
      //   편집 안 된 파일의 유효한 리뷰까지 무효화하는 오차단이라 파일별로 판정한다.
      const changedEdits = (() => {
        try {
          // recentEdits와 동일 필터(withinDir)여야 커버리지 집합이 어긋나지 않는다.
          return getEditsWithLastTimestampSince(sessionId, cursorTurn, cwd);
        } catch {
          return recentEdits.map((f) => ({ file: f, lastEditTimestamp: null }));
        }
      })();
      const v = (() => {
        try {
          return validateReviewCoverage(reviews, changedEdits);
        } catch (err) {
          return { ok: false, reason: `validateReview 에러: ${String(err)}`, effective: [] };
        }
      })();
      if (!v.ok) {
        const count = readRetryCount(claudeDir, REVIEW_VALIDATE_COUNT_FILE) + 1;
        if (count < MAX_RETRIES) {
          writeRetryCount(claudeDir, count, REVIEW_VALIDATE_COUNT_FILE);
          logGate(sessionId, 'review', 'deny', v.reason ?? 'invalid');
          emit({
            decision: 'block',
            reason: `리뷰 검증 실패: ${v.reason ?? '알 수 없는 이유'}. /review-changes 를 다시 실행하세요. (재시도 ${count}/${MAX_RETRIES})`,
          });
          return;
        }
        // 한계 초과 → 통과 + 사용자 알림. 커서 전진이 핵심 — 전진 없이는 다음 턴에
        // 같은 유령 파일 집합으로 재차단된다(v0.25.0 영구 데드락의 구조적 원인).
        resetRetryCount(claudeDir, REVIEW_VALIDATE_COUNT_FILE);
        writeReviewCursor(cwd, getCurrentTurn(sessionId));
        statusSnapshot.reviewPending = false;
        logGate(sessionId, 'review', 'warn', 'validate-escape');
        emit({
          systemMessage:
            `리뷰 검증이 ${MAX_RETRIES}회 차단 후에도 실패해 이번 턴은 통과시킵니다. ` +
            `사용자 확인이 필요합니다. (사유: ${v.reason ?? '알 수 없음'})`,
        });
        return;
      }
      // 검증 통과 → 이 게이트의 카운터 리셋(다음 실패는 새로 3회 기회).
      resetRetryCount(claudeDir, REVIEW_VALIDATE_COUNT_FILE);

      // 가정 검증(F1.5)/차원(F2)은 커버리지를 실제 구성한 리뷰들(effective) 기준으로
      //   평가한다 — 파일별 최신 리뷰가 이전 리뷰를 대체하는 의미론. 빈 경우(변경
      //   파일 없음 등)는 최신 리뷰 1개로 폴백.
      const effectiveReviews = v.effective.length > 0 ? v.effective : reviews.slice(0, 1);
      // finding 평가(F/G)는 effective만으로는 부족(리뷰 지적 — 변경 집합 밖 파일만
      //   커버한 최신 리뷰의 high finding이 조용히 소실된다). 커서 이후의 모든 신뢰
      //   리뷰에서, 더 새로운 리뷰로 대체되지 않은 finding을 모아 평가한다(v0.26.6).
      const activeFindings = (() => {
        try {
          return currentFindings(reviews, cursor ? cursor.timestamp : null);
        } catch {
          return effectiveReviews.flatMap((r) => (Array.isArray(r.findings) ? r.findings : []));
        }
      })();

      // (F) 재시도 카운터 (high severity) — claudeDir은 (B5)에서 확보됨.
      const highSev = activeFindings.filter((f) => f && f.severity === 'high');
      if (highSev.length > 0) {
        const count = readRetryCount(claudeDir) + 1;
        writeRetryCount(claudeDir, count);
        const issues = highSev
          .slice(0, 3)
          .map((f) => `${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue}`)
          .join('; ');
        const more = highSev.length > 3 ? ` (외 ${highSev.length - 3}개)` : '';
        if (count < MAX_RETRIES) {
          logGate(sessionId, 'review', 'deny', 'high-severity');
          emit({
            decision: 'block',
            reason: `high severity 발견사항을 수정하세요: ${issues}${more}. (재시도 ${count}/${MAX_RETRIES})`,
          });
          return;
        }
        // 한계 초과 → 통과 + 사용자에게 알림. 리뷰 수락 → 커서 전진.
        resetRetryCount(claudeDir);
        writeReviewCursor(cwd, getCurrentTurn(sessionId));
        emit({
          systemMessage: `재시도 ${MAX_RETRIES}회를 초과했습니다. 사용자 확인이 필요합니다. (high severity: ${issues}${more})`,
        });
        return;
      }

      // (F1.5) A2 — 추측/가정 리뷰 연동. 메인 에이전트가 최근 '## 추론' 섹션에서
      //   추측(### 추측)이나 가정(### 가정)을 선언했다면, 리뷰가 가정 검증
      //   (unknown_assumptions_checked)을 실제로 수행했어야 한다. 필드/CLI 스키마/리뷰 지시는
      //   이미 갖춰져 있고(발견 ②) 여기가 마지막 강제 연결이다.
      //   추론 섹션 탐색: 최근 assistant 텍스트에서 가장 최근 섹션 1개(현재 작업의 것으로 근사 —
      //   추론 게이트가 편집마다 최근 3턴 내 섹션을 요구하므로 최신 섹션이 현재 작업에 해당).
      //   fail-open: transcript 파싱 실패/섹션 없음 → 검사 생략.
      const declaredUnknowns = (() => {
        try {
          if (!input.transcript_path) return 0;
          const texts = extractRecentAssistantTexts(input.transcript_path, 50);
          for (const t of texts) {
            if (hasReasoningSection(t)) {
              const sec = parseReasoningSection(t);
              return sec ? sec.speculations.length + sec.assumptions.length : 0;
            }
          }
          return 0;
        } catch {
          return 0;
        }
      })();
      const checkedAssumptions = effectiveReviews.reduce(
        (sum, r) =>
          sum + (Array.isArray(r.unknown_assumptions_checked) ? r.unknown_assumptions_checked.length : 0),
        0,
      );
      if (declaredUnknowns > 0 && checkedAssumptions === 0) {
        const count = readRetryCount(claudeDir) + 1;
        if (count < MAX_RETRIES) {
          writeRetryCount(claudeDir, count);
          logGate(sessionId, 'review', 'deny', 'assumptions-unchecked');
          emit({
            decision: 'block',
            reason:
              `메인 에이전트가 ## 근거 섹션에서 추측/가정 ${declaredUnknowns}건을 선언했지만, ` +
              `리뷰가 가정 검증을 수행하지 않았습니다(unknown_assumptions_checked 비어 있음). ` +
              `review-changes 서브에이전트로 각 추측/가정을 검증해 결과에 기록한 뒤 다시 리뷰하세요. ` +
              `(추측-리뷰 연동, 재시도 ${count}/${MAX_RETRIES})`,
          });
          return;
        }
        // 한계 초과 → 통과 + 사용자에게 알림. 리뷰 수락 → 커서 전진.
        resetRetryCount(claudeDir);
        writeReviewCursor(cwd, getCurrentTurn(sessionId));
        statusSnapshot.reviewPending = false;
        emit({
          systemMessage:
            `재시도 ${MAX_RETRIES}회를 초과했습니다. 사용자 확인이 필요합니다. ` +
            `(추측/가정 ${declaredUnknowns}건이 리뷰에서 검증되지 않음)`,
        });
        return;
      }

      // (F2) 차원 커버리지 검사 — 변경 파일이 요구하는 품질 차원을 리뷰가 실제로 평가했는지.
      //   리뷰의 dimensions_checked에 누락된 필수 차원이 있으면 BLOCK.
      //   high-severity와 동일한 MAX_RETRIES escape를 재사용해 영구 차단을 막는다.
      const requiredDims = (() => {
        try {
          return requiredDimensionsFor(recentEdits);
        } catch {
          return [];
        }
      })();
      const checkedDims = new Set(
        effectiveReviews.flatMap((r) => (Array.isArray(r.dimensions_checked) ? r.dimensions_checked : [])),
      );
      const missingDims = requiredDims.filter((d) => !checkedDims.has(d));
      if (missingDims.length > 0) {
        const count = readRetryCount(claudeDir) + 1;
        const dimList = missingDims.join(', ');
        if (count < MAX_RETRIES) {
          writeRetryCount(claudeDir, count);
          logGate(sessionId, 'review', 'deny', `missing-dimensions: ${dimList}`);
          emit({
            decision: 'block',
            reason:
              `리뷰가 변경 내용이 요구하는 품질 차원을 평가하지 않았습니다. ` +
              `누락된 차원: ${dimList}. ` +
              `review-changes 서브에이전트로 해당 차원(런타임/관찰 프로브 포함)을 평가하고 ` +
              `결과의 dimensions_checked에 추가한 뒤 다시 리뷰하세요. (재시도 ${count}/${MAX_RETRIES})`,
          });
          return;
        }
        // 한계 초과 → 통과 + 사용자에게 알림. 리뷰 수락 → 커서 전진.
        resetRetryCount(claudeDir);
        writeReviewCursor(cwd, getCurrentTurn(sessionId));
        emit({
          systemMessage:
            `재시도 ${MAX_RETRIES}회를 초과했습니다. 사용자 확인이 필요합니다. ` +
            `(리뷰가 다음 품질 차원을 평가하지 않음: ${dimList})`,
        });
        return;
      }

      // (G) medium/low only — 통과 + 알림
      const otherFindings = activeFindings.filter((f) => f && f.severity !== 'high');
      let systemMessage: string | undefined;
      if (otherFindings.length > 0) {
        const sev = otherFindings
          .slice(0, 3)
          .map((f) => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue}`)
          .join('; ');
        const more = otherFindings.length > 3 ? ` (외 ${otherFindings.length - 3}개)` : '';
        systemMessage = `리뷰 통과. 참고할 발견사항: ${sev}${more}`;
      }
      // 리뷰 수락(blocking high-severity 없음) → 커서 전진.
      //   이후 Stop에서는 이 턴 이후 편집만 리뷰 필요 대상이 된다.
      resetRetryCount(claudeDir);
      writeReviewCursor(cwd, getCurrentTurn(sessionId));
      statusSnapshot.reviewPending = false;

      const out: HookOutput = {};
      if (systemMessage) out.systemMessage = systemMessage;
      emit(out);
    })
    .catch((err) => {
      process.stderr.write(`[goodboy stop] fatal: ${String(err)}\n`);
      emit({});
    });
}

main();
