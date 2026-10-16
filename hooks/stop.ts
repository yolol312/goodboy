#!/usr/bin/env bun
// Stop hook — 턴 증가, 리뷰 강제/검증, 재시도 카운터, 커서/차원 검사

import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import type {
  AcceptanceProblem,
  AcceptanceReading,
  CitationCache,
  CitationProblem,
  ReviewFinding,
  ReviewResult,
  StatusSnapshot,
  TestResult,
} from '../lib';
import { agentName, ROUTE } from '../lib/routing-policy';
import { projectMode } from '../lib/project-mode';
import { knowledgeRoot, readDocMap } from '../lib/project-knowledge';
import { staleDocs, staleDocsReason, type StaleDoc } from '../lib/doc-map';
import { changedLineGaps, changedLineReason, diffCoverageMode, repoTop, sessionCoverageStart } from '../lib/changed-coverage';
import {
  citationBlockMessage,
  CLI_PATH,
  clearReadRecords,
  clearValidationFailure,
  compactForcePct,
  countDeclaredUnknowns,
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
  axesOfDimensions,
  failingSuites,
  isEvidencedBlocked,
  fileModifiedAt,
  findRecentReviewFiles,
  findRecentTestFiles,
  missingTestFiles,
  pruneOldReviewFiles,
  pruneOldTestFiles,
  NO_ACCEPTANCE,
  readAcceptance,
  readTestCursor,
  scanForbiddenPatterns,
  uncoveredCriteria,
  validateEvidence,
  validateTestCoverage,
  writeTestCursor,
  getContextUsage,
  getCurrentTurn,
  getEditHistory,
  getEditsSince,
  getEditsWithLastTimestampSince,
  hasReasoningSection,
  incrementTurn,
  isTestFile,
  logGate,
  parseReasoningSection,
  readGateLog,
  readHabitState,
  readRetryCount,
  readReviewCursor,
  readSessionState,
  readValidationFailure,
  requiredDimensionsFor,
  resetRetryCount,
  validateReviewCoverage,
  writeHabitState,
  writeRetryCount,
  writeReviewCursor,
  writeStatusSnapshot,
  effortNotice,
  hasRepeatedBlock,
  isDocPath,
  projectRelative,
  readLastAdvice,
  recommendEffort,
  writeLastAdvice,
  approvalMarkerPath,
  approvalMarkerRelPath,
  useUserMarker,
  ensureApprovalDir,
  restoreOrphanGateState,
  finishOpenBashCalls,
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
  /** Current effort of the main session (G0: on Stop and tool events). */
  effort?: { level?: string };
  /** Running background work (G0 M10): `{id, type, status, description, agent_type}`. */
  background_tasks?: Array<{ type?: string; status?: string; agent_type?: string }>;
}

interface HookOutput {
  continue?: boolean;
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    additionalContext?: string;
  };
}

// Track G: no count-based escape. A gate blocks until its evidence is there; only the user
// lets a Stop past it, with a one-use marker (`! touch`, which the model cannot create:
// PreToolUse denies its writes to markers) or the gate's env switch. After this many blocks
// in a row the user is told how, in Korean.
const NOTICE_AFTER_BLOCKS = 2;

/** True once the user's one-use Stop marker was used in this Stop run; every later gate in
 *  the same run passes too, so one approval ends one Stop. */
let userPassUsed = false;

/** The user's override for a blocking gate: uses `.claude/.goodboy-stop-approved-<tag>.txt`
 *  once. The caller passes the gate as its old escape did (cursor moves, counter resets). */
function userPass(sessionId: string, cwd: string, gate: string): boolean {
  if (userPassUsed) return true;
  if (!useUserMarker(sessionId, approvalMarkerPath(cwd, 'stop', sessionId))) return false;
  userPassUsed = true;
  logGate(sessionId, gate, 'warn', 'user-override');
  habitWarnings.push(`[goodboy] 사용자 승인 마커로 이번 턴의 ${gate} 게이트를 통과시켰어요. 검증되지 않은 상태예요.`);
  return true;
}

/** A review accepted (on evidence or by the user's marker): the cursor moves and every review
 *  block count restarts, so the next change's first block says `(block 1)` (refactoring review:
 *  an override used to leave the other counter at 2). */
function acceptReview(sessionId: string, cwd: string): void {
  resetRetryCount(sessionId);
  resetRetryCount(sessionId, REVIEW_VALIDATE_COUNT_FILE);
  writeReviewCursor(cwd, getCurrentTurn(sessionId), sessionId);
}

/** A blocking gate's output: the model is told that only the user can let it pass; after
 *  NOTICE_AFTER_BLOCKS blocks in a row the user sees how (marker or env switch). */
function blockOutput(sessionId: string, cwd: string, reason: string, gate: string, envSwitch: string, count: number): HookOutput {
  const out: HookOutput = {
    decision: 'block',
    reason:
      `${reason} (block ${count}) This gate passes only on its evidence. If you cannot provide it, ` +
      'tell the user what is missing and why; only the user can let this Stop pass.',
  };
  if (count >= NOTICE_AFTER_BLOCKS) {
    ensureApprovalDir(cwd);
    out.systemMessage =
      `[goodboy] ${gate} 게이트가 ${count}번 연속 막았어요. 근거 없이 넘어가려면 ` +
      `\`! touch ${approvalMarkerRelPath('stop', sessionId)}\`(이번 한 번)을 실행하세요` +
      (envSwitch !== '' ? `. 계속 끄려면 ${envSwitch}로 설정하세요.` : '.');
  }
  return out;
}


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

// H1-03 compaction notice latch (track G: a notice, not a block), kept apart from the review
// counter (.goodboy-retry-count.txt).
const COMPACT_FORCE_COUNT_FILE = '.goodboy-compact-force-count.txt';

// Block counters, one per gate (track G: they count blocks in a row for the user notice; no
// gate passes on a count). File names keep the old "retry" wording for compatibility.
// (C1) the auto-validation failure gate.
const VALIDATION_COUNT_FILE = '.goodboy-validation-retry-count.txt';

// (D) review validation and "no review at all". Until v0.25.0 this gate had no way out and
//   deadlocked on ghost files (deleted probes and review artifacts); the user's marker is it now.
const REVIEW_VALIDATE_COUNT_FILE = '.goodboy-review-validate-retry-count.txt';

// (layer 1) the test gate, apart from the review counter.
const TEST_COUNT_FILE = '.goodboy-test-retry-count.txt';

// (layer 0) the citation gate: it also fires on turns without edits.
const CLAIM_COUNT_FILE = '.goodboy-claim-retry-count.txt';

// (track H) the docs rule.
const DOCS_COUNT_FILE = '.goodboy-docs-retry-count.txt';

// 이번 Stop 실행에서 사용자에게 보일 토큰-습관 경고들(H1-01 긴 세션 경고, H1-03 compact 안내).
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
 *  - 세션당 1회. H1-03 compact 안내가 이번 Stop에 나갔으면(forceActive) 스팸 방지로 생략한다.
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

    // H1-03 안내가 이번 Stop에 나갔으면 스팸 방지를 위해 H1-01 생략. 세션당 1회.
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

/** (H1-03) Context compaction notice. At GOODBOY_COMPACT_FORCE_PCT (default 50) or more, the
 *  user is told once per crossing to run /compact (track G: it no longer blocks; only the user
 *  can compact). Below the threshold, or unmeasurable, the latch resets. Fails open.
 *
 *  @returns output: always null now (kept for the call site).
 *           forced: whether the notice fired on this Stop — H1-01 spam suppression. */
function maybeForceCompact(
  usage: ReturnType<typeof getContextUsage>,
  sessionId: string,
): { output: HookOutput | null; forced: boolean } {
  try {
    if (!usage) {
      // (v0.27.6) 측정 불가 — 압축 경계 직후(압축 후 usage 미플러시)가 대표 사례.
      //   이전 사이클의 잔존 카운트가 다음 진짜 초과 때 즉시 escape로 튀지 않게 리셋한다.
      try {
        resetRetryCount(sessionId, COMPACT_FORCE_COUNT_FILE);
      } catch {
        // best-effort
      }
      return { output: null, forced: false };
    }
    const forcePct = compactForcePct();
    const pct = Math.round(usage.percent);

    // 임계 미만 → 카운터 리셋 후 아무 동작 없음.
    if (usage.percent < forcePct) {
      resetRetryCount(sessionId, COMPACT_FORCE_COUNT_FILE);
      return { output: null, forced: false };
    }

    // (3-A) 한도가 확정적이지 않으면(1M 지원 모델인데 [1m] 표식 없음 / 미지 모델 → 200K/1M 구분 불가)
    //   안내를 보류한다. 표식 없는 1M 세션이 200K로 오판되어 저토큰인데도 오탐되던 문제 방지.
    //   H1-01(절대 토큰 경고)이 안전망 역할을 하며, GOODBOY_CONTEXT_LIMIT 명시로 안내를 복구할 수 있다.
    if (!usage.confident) {
      // E1: "강제했을 상황인데 한도 미확정으로 보류" — 무력화 상태의 핵심 신호라 기록한다.
      logGate(sessionId, 'compact-force', 'fail-open', `limit-unconfident pct=${pct}`);
      resetRetryCount(sessionId, COMPACT_FORCE_COUNT_FILE);
      return { output: null, forced: false };
    }

    // Track G: a notice to the user, never a block — only the user can run /compact, so a
    //   block asked the model for something it cannot do. Once per crossing: the counter
    //   latches until usage drops below the threshold or becomes unmeasurable (both reset it
    //   above). forced=false on a latched Stop keeps the H1-01/D4 context warnings on.
    if (readRetryCount(sessionId, COMPACT_FORCE_COUNT_FILE) >= 1) return { output: null, forced: false };
    writeRetryCount(sessionId, 1, COMPACT_FORCE_COUNT_FILE);
    logGate(sessionId, 'compact-force', 'warn', `notice pct=${pct}`);
    habitWarnings.push(
      `[goodboy] 컨텍스트 사용률이 ${pct}%예요(기준 ${forcePct}%). 지금 /compact를 실행하거나 새 세션을 시작하는 걸 권해요. (H1-03)`,
    );
    return { output: null, forced: true };
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

// Retry counters (readRetryCount/writeRetryCount/resetRetryCount) live in lib/retry-counter.ts
// and are stored per session (stabilization plan A3).

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
    //   One cache for both sides (and main() runs this at most once per Stop), so the repo
    //   is walked for bare names at most once per Stop.
    const names: CitationCache = {};
    const citations = excludeUserOriginated(
      extractCitations(last, cwd, names),
      extractRecentUserTexts(transcriptPath, 3).filter((t) => !isGateMessage(t)),
      cwd,
      names,
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

function claimGate(sessionId: string, cwd: string, citationCheck: () => CitationProblem[]): HookOutput | null {
  try {
    const problems = citationCheck();
    if (problems.length === 0) {
      resetRetryCount(sessionId, CLAIM_COUNT_FILE);
      return null;
    }

    const hallucinated = hallucinatedCitations(problems);
    const unread = unreadCitations(problems);

    if (userPass(sessionId, cwd, 'claim')) {
      resetRetryCount(sessionId, CLAIM_COUNT_FILE);
      return null;
    }
    const count = readRetryCount(sessionId, CLAIM_COUNT_FILE) + 1;
    writeRetryCount(sessionId, count, CLAIM_COUNT_FILE);

    if (hallucinated.length > 0) {
      logGate(sessionId, 'claim', 'deny', `hallucinated(${hallucinated.length})`);
      return blockOutput(sessionId, cwd, citationBlockMessage(hallucinated), 'claim', 'GOODBOY_CLAIM_GATE=off', count);
    }
    logGate(sessionId, 'claim', 'deny', `unread(${unread.length})`);
    return blockOutput(sessionId, cwd, unreadBlockMessage(unread, count >= 2), 'claim', 'GOODBOY_CLAIM_GATE=off', count);
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
 *
 * `acceptance` is the Stop's one reading of the dev-cycle documents (NO_ACCEPTANCE when
 * the mode is off), which also gives the criteria and the F2 warning.
 */
function testGateActive(cwd: string, acceptance: AcceptanceReading, sessionId: string): { active: boolean; evidence: string } {
  const mode = testGateMode();
  if (mode === 'off') return { active: false, evidence: 'off' };
  if (mode === 'on') return { active: true, evidence: 'on' };
  // (H1) A directory its CLAUDE.md marks non-project has no test gate; the review stays.
  if (projectMode(cwd, sessionId) === 'non-project') return { active: false, evidence: 'non-project directory' };
  if (acceptance.devCycle) {
    return { active: true, evidence: 'dev-cycle 산출물' };
  }
  const infra = detectTestInfrastructure(cwd);
  return { active: infra.present, evidence: infra.evidence };
}

function testGateMode(): string {
  return envStr('GOODBOY_TEST_GATE', 'auto');
}

/** The dev-cycle reading for this Stop: none when layer 1 is off, so the F2 warning stays quiet. */
function acceptanceFor(cwd: string): AcceptanceReading {
  return testGateMode() === 'off' ? NO_ACCEPTANCE : readAcceptance(cwd);
}

/**
 * (층1) 이 파일이 테스트 커버리지 요구 대상인가.
 *
 * 두 부류를 뺀다. 둘 다 "요구해도 해소할 방법이 없어서 escape로만 끝나는" 부류다:
 *   - 테스트 파일 — 테스트를 테스트하라는 무한 후퇴(실측: tests/hello.test.ts)
 *   - 문서 파일 — README를 단위 테스트할 수 없다(실측: README.md 등 5개 요구)
 *
 * Both checks see the path below `cwd` only. On the absolute path, a repo that lives under
 * a tests/ or spec/ directory made every file a "test file" and silently turned layer 1
 * off (layer-1 test run).
 */
function needsTestCoverage(file: string, cwd: string): boolean {
  const rel = relative(resolvePath(cwd), file);
  const scoped = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : file;
  // isDocPath (extension, or anything under docs/) is the rule the skill rule and role limits
  //   use; with no count-based escape, a docs/diagram.svg edit must not demand a test forever.
  return !isTestFile(scoped) && !isDocFile(scoped) && !isDocPath(scoped.split(sep).join('/'));
}

/** (F2) When code was edited: dev-cycle documents exist but yield no acceptance criteria.
 *  Unrecognized keys or headings used to drop the criteria to zero with no sign, and in
 *  auto mode turn layer 1 off. The warning shows once per session; the reading behind it
 *  is the one the gate takes its criteria from. Not a block: a version without new or
 *  changed screens gives zero criteria legitimately. */
function warnAcceptanceProblem(sessionId: string, cwd: string, problem: AcceptanceProblem | null): void {
  if (problem === null) return;
  try {
    const state = readHabitState(sessionId);
    if (state.acceptanceProblemWarned === true) return;
    state.acceptanceProblemWarned = true;
    writeHabitState(sessionId, state);
    logGate(sessionId, 'test', 'warn', `acceptance: ${problem.kind}`);
    habitWarnings.push(
      problem.kind === 'no-version-key'
        ? 'docs/CYCLE.md 에서 현재 버전 줄(`- **현재 버전**:` 또는 `- **Current version**:`)을 찾지 ' +
            '못했습니다 — 층1이 수용 기준을 읽지 못합니다.'
        : problem.kind === 'unreadable'
          ? 'docs/CYCLE.md 를 읽을 수 없습니다(권한 등) — 층1이 수용 기준을 읽지 못합니다.'
          : `dev-cycle 문서(${problem.files.map((f) => relative(cwd, f)).join(', ')})에서 수용 기준을 ` +
            '하나도 읽지 못했습니다 — 표 제목(`화면 목록`/`Screens` 등)이나 구분 값(`신규`/`new` 등)을 ' +
            '확인하세요. 이번 버전에 신규·변경 화면이 정말 없다면 무시해도 됩니다.',
    );
  } catch {
    // fail-open
  }
}

type TestEvaluation =
  | { kind: 'accept' }
  | { kind: 'accept-unverified'; blocked: TestResult }
  | { kind: 'block'; reason: string };

/**
 * The one layer-1 decision, shared by the gate and the stop_hook_active accept so the two
 * cannot drift (refactoring review): coverage and staleness, then every check on the results
 * that ran. An evidence-backed BLOCKED result ends the turn as unverified only when the results
 * that did run pass: a failing unit run next to an e2e run that could not start is a failure.
 */
function evaluateTestResults(
  results: TestResult[],
  changedEdits: ReturnType<typeof getEditsWithLastTimestampSince>,
  acceptance: AcceptanceReading,
  cwd: string,
  sessionId: string,
): TestEvaluation {
  const block = (reason: string): TestEvaluation => ({ kind: 'block', reason });
  const cov = validateTestCoverage(results, changedEdits);
  if (!cov.ok) return block(`테스트 검증 실패: ${cov.reason ?? '알 수 없는 이유'}.`);
  const effective = cov.effective.length > 0 ? cov.effective : results.slice(0, 1);
  const blocked = effective.filter((r) => r.verdict === 'blocked');
  if (!blocked.every(isEvidencedBlocked)) {
    return block(
      'A `blocked` test result needs blocked.reason (at least 15 characters) and blocked.evidence: ' +
        'the commands you ran and their output that show why the tests cannot run.',
    );
  }
  const ran = effective.filter((r) => r.verdict !== 'blocked');

  const suiteFail = failingSuites(ran);
  if (suiteFail) return block(`${suiteFail}. 원인을 수정하고 다시 테스트하세요.`);
  const missingFiles = missingTestFiles(ran);
  if (missingFiles) return block(missingFiles);
  const evidenceIssue = validateEvidence(ran);
  if (evidenceIssue) {
    return block(
      `테스트 증거가 불충분합니다: ${evidenceIssue} ` +
        `되돌린 상태에서 실패(red)하고 지금은 통과(green)함을 실행으로 보여야 합니다.`,
    );
  }
  const forbidden = scanForbiddenPatterns(ran.flatMap((r) => r.test_files ?? []));
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
  // Criteria the blocked runs were for stay uncovered: that is what "unverified" means.
  if (blocked.length > 0) return { kind: 'accept-unverified', blocked: blocked[0]! };
  const uncovered = uncoveredCriteria(ran, acceptance.criteria);
  if (uncovered.length > 0) {
    const list = uncovered
      .slice(0, 3)
      .map((c) => `${c.id}(${c.description})`)
      .join('; ');
    return block(
      `확정된 요구사항/프로토타입이 요구하는 수용 기준이 테스트로 커버되지 않았습니다: ` +
        `${list}${uncovered.length > 3 ? ` 외 ${uncovered.length - 3}건` : ''}. ` +
        `\`bun "${CLI_PATH}" acceptance-list\` 로 전체 목록을 확인하세요.`,
    );
  }
  // (I1, plan §15) Every changed code line ran in a test of the recorded tree; a file no run
  //   loaded counts as not run (lib/changed-coverage.ts). Only the records the checks above
  //   accepted (`ran`), and per file those made after its last edit. Exemptions: the user's
  //   policy globs pinned at the session start, which also pins the HEAD no record's base may
  //   be after.
  const mode = diffCoverageMode();
  if (mode !== 'off') {
    const top = repoTop(cwd);
    const start = sessionCoverageStart(sessionId, cwd, top);
    const out = changedLineGaps({ results: ran, edits: changedEdits, top, exempt: start.exempt, startHead: start.head });
    if (!out.measured || out.gaps.length > 0) {
      if (mode === 'on') return block(changedLineReason(out, CLI_PATH));
      habitWarnings.push(
        `[goodboy] 바뀐 줄 커버리지(경고 모드): ${out.measured ? `테스트가 실행하지 않은 파일 ${out.gaps.map((g) => g.file).slice(0, 3).join(', ')}` : '측정되지 않았어요'}.`,
      );
    }
  }
  return { kind: 'accept' };
}

/** Accepts an evidence-backed BLOCKED test result (track G): the cursor moves and the user
 *  is told, on both paths (the gate itself and the stop_hook_active accept). */
/** Layer 1 accepted (on evidence, BLOCKED evidence or the user's marker): cursor and count. */
function acceptTests(sessionId: string, cwd: string): void {
  resetRetryCount(sessionId, TEST_COUNT_FILE);
  writeTestCursor(cwd, getCurrentTurn(sessionId), sessionId);
  statusSnapshot.testPending = false;
}

function acceptBlockedTests(sessionId: string, cwd: string, r: TestResult, logReason: string): void {
  acceptTests(sessionId, cwd);
  logGate(sessionId, 'test', 'warn', `${logReason}: ${r.blocked?.reason ?? ''}`);
  habitWarnings.push(
    `[goodboy] 테스트를 실행하지 못해 검증되지 않은 상태로 턴을 마쳐요. 사유: ${r.blocked?.reason ?? ''}` +
      ' push나 MR 전에는 통과한 테스트 결과가 필요해요.',
  );
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
function tryAcceptPendingTest(sessionId: string, cwd: string): boolean {
  if (testGateMode() === 'off') return false;
  try {
    const cursor = readTestCursor(cwd, sessionId);
    const cursorTurn = cursor ? cursor.turn : 0;
    const recentEdits = getEditsSince(sessionId, cursorTurn, cwd).filter((f) => needsTestCoverage(f, cwd));
    if (recentEdits.length === 0) return false;
    const acceptance = acceptanceFor(cwd);
    if (!testGateActive(cwd, acceptance, sessionId).active) return false;
    const results = findRecentTestFiles(resolvePath(cwd, '.claude', 'tests'), testWindowMinutes());
    if (results.length === 0) return false;
    const changedEdits = getEditsWithLastTimestampSince(sessionId, cursorTurn, cwd).filter((e) =>
      needsTestCoverage(e.file, cwd),
    );
    const ev = evaluateTestResults(results, changedEdits, acceptance, cwd, sessionId);
    if (ev.kind === 'block') return false;
    if (ev.kind === 'accept-unverified') {
      acceptBlockedTests(sessionId, cwd, ev.blocked, 'blocked-on-stop-active');
      return true;
    }
    // 수락.
    acceptTests(sessionId, cwd);
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
function testGate(sessionId: string, cwd: string): HookOutput | null {
  try {
    const cursor = readTestCursor(cwd, sessionId);
    const cursorTurn = cursor ? cursor.turn : 0;
    // 문서·테스트 파일만 바뀐 턴은 층1의 관심사가 아니다 — 요구해도 해소할 방법이 없다.
    const recentEdits = getEditsSince(sessionId, cursorTurn, cwd).filter((f) => needsTestCoverage(f, cwd));
    if (recentEdits.length === 0) {
      statusSnapshot.testPending = false;
      return null;
    }
    // One reading per Stop serves the gate switch, the F2 warning (also while the gate is
    //   inactive) and the criteria check below.
    const acceptance = acceptanceFor(cwd);
    const gate = testGateActive(cwd, acceptance, sessionId);
    warnAcceptanceProblem(sessionId, cwd, acceptance.problem);
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
      // The user's override (track G) passes as the old escape did: cursor moves, counter resets.
      if (userPass(sessionId, cwd, 'test')) {
        acceptTests(sessionId, cwd);
        return null;
      }
      const count = readRetryCount(sessionId, TEST_COUNT_FILE) + 1;
      writeRetryCount(sessionId, count, TEST_COUNT_FILE);
      // 자르지 않는다 — gate-log가 자체 상한(300자)으로 다듬는다. 80자로 잘랐더니
      //   라이브 로그에서 어떤 파일이 문제인지 보이지 않았다(경로가 `/pr` 에서 끊김).
      logGate(sessionId, 'test', 'deny', reason);
      return blockOutput(
        sessionId,
        cwd,
        `${reason} (테스트 게이트) If the tests cannot run here (no runner, no environment), record a ` +
          '`blocked` result with the commands and output that show it; that ends the turn as unverified.',
        'test',
        'GOODBOY_TEST_GATE=off',
        count,
      );
    };

    if (results.length === 0) {
      const preview = recentEdits.slice(0, 5).join(', ');
      const more = recentEdits.length > 5 ? ` and ${recentEdits.length - 5} more` : '';
      return block(
        `No test result covers the changed code. Run ${agentName(ROUTE.test)} to write and run ` +
          `unit and integration tests and record the result: ${preview}${more}`,
      );
    }

    // 테스트 파일 자체는 커버리지 요구 대상에서 뺀다 — 테스트를 테스트하라는 무한 후퇴가
    //   된다(라이브 실측: `tests/hello.test.ts` 가 "테스트되지 않은 변경 파일"로 잡혔다).
    //   문서도 같은 이유로 뺀다(라이브 실측: README.md 등 5개를 요구했다).
    const changedEdits = getEditsWithLastTimestampSince(sessionId, cursorTurn, cwd).filter((e) =>
      needsTestCoverage(e.file, cwd),
    );
    const ev = evaluateTestResults(results, changedEdits, acceptance, cwd, sessionId);
    if (ev.kind === 'block') return block(ev.reason);
    if (ev.kind === 'accept-unverified') {
      acceptBlockedTests(sessionId, cwd, ev.blocked, 'blocked');
      return null;
    }
    // 통과 → 커서 전진 + 카운터 리셋.
    acceptTests(sessionId, cwd);
    return null;
  } catch (err) {
    // fail-open — 게이트 자체의 오류가 턴을 막지 않는다.
    process.stderr.write(`[goodboy stop] test gate error: ${String(err)}\n`);
    return null;
  }
}

/** (track H §14.5) The docs rule: in a project, a doc whose covered files changed since the
 *  review cursor (the task) while the doc did not, and no check of it was recorded after the
 *  change (lib/doc-map.ts). Runs after the test gate and before the review gate, so a doc
 *  update is reviewed with the change. Fails open. */
function staleDocsNow(sessionId: string, cwd: string): StaleDoc[] | null {
  if ((process.env.GOODBOY_DOCS_GATE ?? 'on').trim().toLowerCase() === 'off') return null;
  if (projectMode(cwd, sessionId) === 'non-project') return null;
  const { root } = knowledgeRoot(cwd);
  const map = readDocMap(root);
  if (map.problem) logGate(sessionId, 'docs', 'fail-open', map.problem);
  // The whole map: a doc without covers still counts as a doc, not as code (H4 review).
  if (!map.docs.some((d) => d.covers.length > 0)) return null;
  const cursor = readReviewCursor(cwd, sessionId);
  const edits = getEditsWithLastTimestampSince(sessionId, cursor ? cursor.turn : 0, root);
  return edits.length === 0 ? [] : staleDocs({ root, edits, docs: map.docs });
}

function docsGate(sessionId: string, cwd: string): HookOutput | null {
  try {
    const stale = staleDocsNow(sessionId, cwd);
    if (stale === null) return null;
    if (stale.length === 0) {
      resetRetryCount(sessionId, DOCS_COUNT_FILE);
      return null;
    }
    if (userPass(sessionId, cwd, 'docs')) {
      resetRetryCount(sessionId, DOCS_COUNT_FILE);
      return null;
    }
    const count = readRetryCount(sessionId, DOCS_COUNT_FILE) + 1;
    writeRetryCount(sessionId, count, DOCS_COUNT_FILE);
    logGate(sessionId, 'docs', 'deny', stale.map((s) => s.doc).join(', '));
    return blockOutput(sessionId, cwd, staleDocsReason(stale, resolvePath(import.meta.dir, '..', 'lib', 'cli.ts')), 'docs', 'GOODBOY_DOCS_GATE=off', count);
  } catch (err) {
    process.stderr.write(`[goodboy stop] docs rule error: ${String(err)}\n`);
    return null;
  }
}

/** Open findings, split by whose work they are about (A3).
 *  - own: from reviews that name a file this session edited, in reviewed_files or in a
 *    finding, whichever session wrote them. These gate the Stop.
 *  - foreign: the high findings of the other reviews written since this session's first
 *    edit. These are shown as a note only. Their medium/low findings are not shown: they
 *    never blocked anyone, and another session's notes are only noise here.
 *  `.claude/reviews/` is shared by every session in the repo. Since cursors are per session,
 *  a session without a cursor used to see every open finding in the window, so another
 *  session's high finding blocked a clean review here (hallucination-axis review). Those
 *  findings still must not vanish silently, which was the v0.26.6 blind spot (round-2
 *  layer-1 F7). Rules that keep a finding from being lost:
 *  - The edited set is the raw edit history, so a file moved or deleted afterwards still
 *    counts (mv/rm are not recorded edits). A review that names only the new path of a
 *    moved file is foreign: the new path is not in the history.
 *  - A finding naming an edited file counts even when its review listed other files.
 *  - Supersession runs over every review, whichever session wrote it, under the rule of
 *    currentFindings: a file the finding's review covered changed after it, and reviews
 *    written after the change list the flagged file and cover every axis of that review.
 *  - Every way the Stop moves the review cursor shows the foreign findings: the passes
 *    and the escapes. The next Stop starts after the cursor and never sees them again.
 *  Those were the round-2 security review's high finding and round-3 review findings.
 *  `source` maps each finding to its review, for the axes a block reason names. */
function splitFindings(
  reviews: ReviewResult[],
  sessionId: string,
  cwd: string,
  cursorTimestamp: string | null,
): { own: ReviewFinding[]; foreign: ReviewFinding[]; source: Map<ReviewFinding, ReviewResult> } {
  const { files, firstEditAt } = getEditHistory(sessionId);
  const mine = new Set(files.map((f) => resolvePath(f)));
  const names = (r: ReviewResult): unknown[] => [
    ...(Array.isArray(r.reviewed_files) ? r.reviewed_files : []),
    ...(Array.isArray(r.findings) ? r.findings.map((f) => f?.file) : []),
  ];
  const ownFindings = new Set<ReviewFinding>();
  const source = new Map<ReviewFinding, ReviewResult>();
  for (const r of reviews) {
    const found = Array.isArray(r.findings) ? r.findings : [];
    for (const f of found) source.set(f, r);
    if (names(r).some((f) => typeof f === 'string' && mine.has(resolvePath(cwd, f)))) {
      for (const f of found) ownFindings.add(f);
    }
  }
  const open = currentFindings(reviews, cursorTimestamp, (file) => fileModifiedAt(resolvePath(cwd, file)));
  // Reviews older than this session's first edit cannot be about its work. A finding's
  //   superseders are newer than its review, so one call serves both bounds.
  const foreignSince =
    [cursorTimestamp, firstEditAt].filter((t): t is string => typeof t === 'string' && t !== '').sort().pop() ??
    null;
  return {
    own: open.filter((f) => ownFindings.has(f)),
    foreign: open.filter(
      (f) =>
        !ownFindings.has(f) &&
        f.severity === 'high' &&
        (foreignSince === null || (source.get(f)?.timestamp ?? '') > foreignSince),
    ),
    source,
  };
}

/** The axes whose re-review can clear `findings` (their reviews' axes), for a block reason. */
function axesToReReview(findings: ReviewFinding[], source: Map<ReviewFinding, ReviewResult>): string {
  const axes = new Set<string>();
  for (const f of findings) {
    const dims = source.get(f)?.dimensions_checked;
    for (const a of axesOfDimensions(Array.isArray(dims) ? dims : [])) axes.add(a);
  }
  return [...axes].join(', ');
}

/** "[sev] file:line — issue; …" for up to three findings, for a systemMessage. Without
 *  the tag when the caller has said the severity already. */
function findingsSummary(findings: ReviewFinding[], tagged = true): string {
  const shown = findings
    .slice(0, 3)
    .map((f) => `${tagged ? `[${f.severity}] ` : ''}${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue}`)
    .join('; ');
  return findings.length > 3 ? `${shown} (외 ${findings.length - 3}개)` : shown;
}

/** The foreign high findings as a note, or ''. "편집 기록에 없는" rather than "편집하지
 *  않은": a file this session moved is foreign under its new path. */
function foreignNote(foreign: ReviewFinding[]): string {
  return foreign.length > 0
    ? `이 세션의 편집 기록에 없는 파일에 대한 high 지적(차단하지 않음): ${findingsSummary(foreign)}`
    : '';
}

/** The note a passing Stop shows: own medium/low findings, then the foreign ones. */
function passNote(prefix: string, own: ReviewFinding[], foreign: ReviewFinding[]): string {
  const parts: string[] = [];
  const others = own.filter((f) => f && f.severity !== 'high');
  if (others.length > 0) parts.push(`${prefix} 참고할 발견사항: ${findingsSummary(others)}`);
  const note = foreignNote(foreign);
  if (note !== '') parts.push(note);
  return parts.join(' / ');
}

/** An escape's message with the foreign findings appended: the escape moves the cursor too. */
function withForeignNote(message: string, foreign: ReviewFinding[]): string {
  const note = foreignNote(foreign);
  return note === '' ? message : `${message} / ${note}`;
}

/** Assumptions and speculations declared in the latest rationale section of the transcript,
 *  without placeholder items such as `- 없음` (countDeclaredUnknowns). 0 when there is no
 *  section or the transcript cannot be read (fail-open). */
function declaredUnknownsIn(transcriptPath: string | undefined): number {
  try {
    if (!transcriptPath) return 0;
    for (const t of extractRecentAssistantTexts(transcriptPath, 50)) {
      if (hasReasoningSection(t)) {
        const sec = parseReasoningSection(t);
        return sec ? countDeclaredUnknowns(sec) : 0;
      }
    }
    return 0;
  } catch {
    return 0;
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
    const cursor = readReviewCursor(cwd, sessionId);
    const cursorTurn = cursor ? cursor.turn : 0;
    const recentEdits = getEditsSince(sessionId, cursorTurn, cwd);
    if (recentEdits.length === 0) return null;
    const reviewsDir = resolvePath(cwd, '.claude', 'reviews');
    const reviews = findRecentReviewFiles(reviewsDir, reviewWindowMinutes());
    if (reviews.length === 0) return null;
    const changedEdits = getEditsWithLastTimestampSince(sessionId, cursorTurn, cwd);
    const v = validateReviewCoverage(reviews, changedEdits);
    if (!v.ok) return null;
    const { own, foreign } = splitFindings(reviews, sessionId, cwd, cursor ? cursor.timestamp : null);
    // (F 상당) high는 수락 보류 — 다음 full Stop이 정식으로 차단/안내한다.
    if (own.some((f) => f && f.severity === 'high')) return null;
    const effective = v.effective;
    // (F1.5 상당) 추측/가정을 선언했는데 리뷰가 가정 검증을 안 했으면 수락 보류.
    const declaredUnknowns = declaredUnknownsIn(transcriptPath);
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
    acceptReview(sessionId, cwd);
    statusSnapshot.reviewPending = false;
    // 수락은 평소 기록하지 않지만, 이 경로는 신설이라 관측 가능성을 위해 남긴다.
    logGate(sessionId, 'review', 'warn', 'accept-on-stop-active');
    // (G 상당) medium/low finding은 조용히 소비하지 않고 표면화한다(v0.26.8). The same holds
    //   for findings from reviews of files this session did not edit (A3).
    return passNote('리뷰 통과(수락).', own, foreign);
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
      // Layer 0 runs at most once per Stop. The stop_hook_active path checks it for a
      //   warning and, after accepting a test result, continues to the full gates; running
      //   it twice doubled the flush wait (past the 15 s hook timeout at the 8 s maximum)
      //   and the bare-name walk (performance review, layer-1 test run).
      let citationProblems: CitationProblem[] | undefined;
      const citationCheck = (): CitationProblem[] =>
        (citationProblems ??= checkCitations(sessionId, cwd, input.transcript_path));

      // (A) 턴 증가
      try {
        incrementTurn(sessionId);
      } catch (err) {
        process.stderr.write(`[goodboy stop] incrementTurn error: ${String(err)}\n`);
      }

      // (A0.2) Track G: gate state that a model Bash call changed and never reported back on
      //   (`exit N` fires no post hook, G0 M18) is put back before the gates read it.
      //   The whole post-hook work runs for those calls (markers, hosts, indirect writes),
      //   then any snapshot left without a note is restored.
      try {
        const finished = finishOpenBashCalls(sessionId);
        if (finished.notice) habitWarnings.push(finished.notice);
        const restored = restoreOrphanGateState(sessionId);
        if (restored.length > 0) {
          logGate(sessionId, 'state-guard', 'deny', `restored ${restored.join(', ')}`);
          habitWarnings.push(`[goodboy] 명령이 바꾼 goodboy 게이트 상태를 되돌렸어요: ${restored.join(', ')}`);
        }
      } catch {
        // best-effort
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
      const st = readSessionState(cwd, sessionId);
      if (st) {
        statusSnapshot.category = st.category ?? null;
        statusSnapshot.risk = st.risk ?? null;
      }

      // (A0.7) Effort advice (track G §10.5, lib/effort-advice.ts) — never blocks; the user
      //   changes effort with /effort. Shown only when the recommendation changes.
      //   env GOODBOY_EFFORT_ADVICE=on|off (default on).
      if (envStr('GOODBOY_EFFORT_ADVICE', 'on') !== 'off') {
        try {
          const current = input.effort?.level ?? null;
          const last = readLastAdvice(sessionId);
          const reviewCursor = readReviewCursor(cwd, sessionId);
          const changed = getEditsSince(sessionId, reviewCursor ? reviewCursor.turn : 0, cwd);
          const root = resolvePath(cwd);
          const docOnly =
            changed.length > 0 &&
            changed.every((f) => {
              const rel = projectRelative(f, root);
              return rel !== null && isDocPath(rel);
            });
          const category = st?.category ?? null;
          const advice = recommendEffort({
            current,
            category,
            repeatedBlock: hasRepeatedBlock(readGateLog(sessionId), last?.ts ?? null),
            docOnly,
          });
          if (advice && current && advice.level !== last?.level) {
            habitWarnings.push(effortNotice(current, advice, category));
            writeLastAdvice(sessionId, advice.level);
          }
        } catch {
          // fail-open: advice only
        }
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
          const stillWrong = hallucinatedCitations(citationCheck());
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
        // (track H) The docs rule in this path too (H4 review): while a doc is stale no review
        //   is accepted here, or one plain second Stop would move the cursor past the change
        //   with no doc change and no check (the v0.26.8 F1.5/F2 mirror). Stale docs that have
        //   not blocked yet (this Stop answers another gate's block) go on to the full
        //   evaluation, so the docs block happens once; it is bounded, since the next active
        //   Stop sees the count. A doc fixed since the docs block goes on to the review, as a
        //   test accept does (P14 below).
        let docsFixed = false;
        let docsPending = false;
        try {
          const docsNow = staleDocsNow(sessionId, cwd);
          const blocked = readRetryCount(sessionId, DOCS_COUNT_FILE) > 0;
          if (docsNow !== null && docsNow.length > 0) {
            if (blocked) {
              logGate(sessionId, 'docs', 'warn', 'stale-on-stop-active');
              emit({});
              return;
            }
            docsPending = true;
          }
          docsFixed = docsNow !== null && docsNow.length === 0 && blocked;
          if (docsFixed) resetRetryCount(sessionId, DOCS_COUNT_FILE);
        } catch {
          // fail-open
        }
        const testAccepted = tryAcceptPendingTest(sessionId, cwd);
        if (docsPending) {
          // The one docs block, given here and not by a full evaluation: an earlier gate that
          //   keeps failing would otherwise re-block every active Stop (H4 confirm review).
          //   It counts, so the next active Stop ends.
          const docsBlock = docsGate(sessionId, cwd);
          if (docsBlock) {
            emit(docsBlock);
            return;
          }
        }
        if (!testAccepted && !docsFixed) {
          const acceptMsg = tryAcceptPendingReview(sessionId, cwd, input.transcript_path);
          emit(acceptMsg ? { systemMessage: acceptMsg } : {});
          return;
        }
        if (!testAccepted) logGate(sessionId, 'docs', 'warn', 'continue-to-review-after-docs-fixed');
        // 층1을 방금 수락했다면 조기 return 하지 않고 **층2까지 이어서 판정한다.**
        //   조기 return의 목적은 "직전 차단에 대응한 턴을 또 막지 않기"인데, 테스트
        //   수락은 그 차단이 **해소됐다**는 뜻이므로 다음 층으로 넘어가는 것이 맞다.
        //   그러지 않으면 층1만 만족시키고 층2를 건너뛸 수 있다 — 라이브 실측(P14):
        //   테스트는 red-green까지 제대로 했는데 리뷰는 gate-log에 흔적조차 없이 종료.
        //   수락은 커서를 전진시켜 1회성이라(다음 Stop에선 recentEdits가 비어 false)
        //   이 경로가 반복되지 않는다 — 무한 루프가 되지 않는 근거다.
        if (testAccepted) logGate(sessionId, 'test', 'warn', 'continue-to-review-after-accept');
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
                  '컨텍스트 자동 관리(경고/compact 안내)가 비활성 상태일 수 있습니다. (계측 canary, E1)',
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

      // (B3) H1-03 — at the threshold (default 50%) the user is told to /compact, once per
      //   crossing. Track G: no block, since only the user can compact.
      const force = maybeForceCompact(usage, sessionId);

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

      // (B5) C1 — 자동 검증 실패 게이트. PostToolUse가 남긴 실패 마커가 살아 있으면
      //   턴 종료를 차단한다(편집→재검증 통과 시 PostToolUse가 마커를 지워 해제됨).
      //   - Session binding: the marker lives in this session's state dir and must name
      //     this session; a later project-wide pass of its commands makes it stale (A3).
      //   - No count-based escape (track G): only the user's marker passes it (userPass).
      // GOODBOY_AUTOVALIDATE=off lifts this gate too: with no validation runs, nothing could
      //   ever clear the marker (the switch the block notice names).
      const autoValidateOff = envStr('GOODBOY_AUTOVALIDATE', 'typecheck') === 'off';
      if (autoValidateOff) clearValidationFailure(sessionId);
      const vf = autoValidateOff ? null : readValidationFailure(sessionId); // this session's marker only
      statusSnapshot.validationFailed = vf !== null;
      if (vf) {
        const cmds = vf.commands.length > 0 ? vf.commands.join(', ') : '자동 검증';
        if (userPass(sessionId, cwd, 'validation')) {
          resetRetryCount(sessionId, VALIDATION_COUNT_FILE);
          clearValidationFailure(sessionId);
        } else {
          const count = readRetryCount(sessionId, VALIDATION_COUNT_FILE) + 1;
          writeRetryCount(sessionId, count, VALIDATION_COUNT_FILE);
          logGate(sessionId, 'validation', 'deny', cmds);
          emit(
            blockOutput(
              sessionId,
              cwd,
              `자동 검증이 실패한 상태입니다: ${cmds}. 원인을 수정하세요 — ` +
                `파일을 편집하면 검증이 자동 재실행되고, 통과하면 이 차단이 해제됩니다. (검증 게이트)`,
              'validation',
              'GOODBOY_AUTOVALIDATE=off',
              count,
            ),
          );
          return;
        }
      } else {
        // No marker, another session's, or a stale one (a later pass) → the block count restarts.
        resetRetryCount(sessionId, VALIDATION_COUNT_FILE);
      }

      // (B5.5) 층0 — 인용 검증. **편집 유무와 무관하게** 매 턴 동작하는 유일한 게이트다.
      //   답변만 하는 턴(코드베이스 설명 등)은 이 게이트가 없으면 통째로 무검증이다.
      const claimBlock = claimGate(sessionId, cwd, citationCheck);
      if (claimBlock) {
        emit(claimBlock);
        return;
      }

      // (B5.8) Running agents (track G, G0 M10): the review and test gates wait while a
      //   background agent runs, since its result (often the review or test the gate asks
      //   for) has not arrived; blocking now made the model start a duplicate. Only agents
      //   count: a long-running background shell (a dev server) would defer the gates forever.
      const runningAgents = (input.background_tasks ?? []).filter(
        (t) => t && t.type === 'subagent' && t.status === 'running',
      );
      if (runningAgents.length > 0) {
        logGate(sessionId, 'stop', 'warn', `deferred-for-agents(${runningAgents.length})`);
        emit({});
        return;
      }

      // (B6) 층1 — 테스트 게이트. 리뷰보다 **먼저** 동작을 검증한다.
      //   리뷰(리팩토링·성능·보안)는 "동작은 맞다"를 전제로 하는 검토라, 테스트가
      //   통과하지 않은 코드를 리뷰하는 것은 순서가 뒤집힌 것이다.
      const testBlock = testGate(sessionId, cwd);
      if (testBlock) {
        emit(testBlock);
        return;
      }

      // (track H) The docs rule, before the review so the doc update is reviewed too.
      const docsBlock = docsGate(sessionId, cwd);
      if (docsBlock) {
        emit(docsBlock);
        return;
      }

      // (C) 변경 검사 — 마지막으로 수락된 리뷰(커서) 이후 편집된 파일만 본다.
      //   커서 부재(첫 리뷰) → turn 0 = 세션 시작 이후 모든 편집.
      //   고정 5턴 윈도우(BUG #2) 대신 커서 기반으로 정확한 per-feature 스코프를 얻는다.
      const cursor = readReviewCursor(cwd, sessionId); // never throws: null when unreadable
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
        // The user's override, as on the other review gates: the cursor moves.
        if (userPass(sessionId, cwd, 'review')) {
          acceptReview(sessionId, cwd);
          statusSnapshot.reviewPending = false;
          emit({});
          return;
        }
        const preview = recentEdits.slice(0, 5).join(', ');
        const more = recentEdits.length > 5 ? ` 외 ${recentEdits.length - 5}개` : '';
        const count = readRetryCount(sessionId, REVIEW_VALIDATE_COUNT_FILE) + 1;
        writeRetryCount(sessionId, count, REVIEW_VALIDATE_COUNT_FILE);
        logGate(sessionId, 'review', 'deny', 'no-review-file');
        emit(
          blockOutput(
            sessionId,
            cwd,
            // A9: point to steps that exist; the agent name comes from the policy table.
            `Review is required for the changed files: ${preview}${more}. ` +
              `Run \`bun "${CLI_PATH}" review-axes <files>\`: its plan says whether one ` +
              `${agentName(ROUTE.review)} covers every axis (a small diff) or one runs per axis (or use /request-review).`,
            'review',
            '',
            count,
          ),
        );
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
        if (!userPass(sessionId, cwd, 'review')) {
          const count = readRetryCount(sessionId, REVIEW_VALIDATE_COUNT_FILE) + 1;
          writeRetryCount(sessionId, count, REVIEW_VALIDATE_COUNT_FILE);
          logGate(sessionId, 'review', 'deny', v.reason ?? 'invalid');
          emit(
            blockOutput(
              sessionId,
              cwd,
              `Review validation failed: ${v.reason ?? 'unknown reason'}. ` +
                ((v.stale?.length ?? 0) > 0 && (v.missing?.length ?? 0) === 0
                  ? // (H7) Only files changed after their review: no full round is needed.
                    `These files changed after their review: ${v.stale!.slice(0, 5).join(', ')}. A delta review is enough: one ` +
                    `${agentName(ROUTE.review)} with \`mode: delta\` and these files; it reads the newest review that lists them ` +
                    `and checks only what changed since, on every dimension \`bun "${CLI_PATH}" review-axes <files>\` lists for them.`
                  : `Run the review again (\`bun "${CLI_PATH}" review-axes <files>\` gives the plan, or /request-review).`),
              'review',
              '',
              count,
            ),
          );
          return;
        }
        // The user's override: the cursor must move — without it the next turn blocks on the
        //   same ghost files again (the structural cause of the v0.25.0 permanent deadlock).
        const passedForeign = (() => {
          try {
            return splitFindings(reviews, sessionId, cwd, cursor ? cursor.timestamp : null).foreign;
          } catch {
            return [] as ReviewFinding[];
          }
        })();
        acceptReview(sessionId, cwd);
        statusSnapshot.reviewPending = false;
        emit({ systemMessage: withForeignNote(`리뷰 검증 실패: ${v.reason ?? '알 수 없음'}`, passedForeign) });
        return;
      }
      // Validation passed → this gate's block count restarts.
      resetRetryCount(sessionId, REVIEW_VALIDATE_COUNT_FILE);

      // 가정 검증(F1.5)/차원(F2)은 커버리지를 실제 구성한 리뷰들(effective) 기준으로
      //   평가한다 — 파일별 최신 리뷰가 이전 리뷰를 대체하는 의미론. 빈 경우(변경
      //   파일 없음 등)는 최신 리뷰 1개로 폴백.
      const effectiveReviews = v.effective.length > 0 ? v.effective : reviews.slice(0, 1);
      // finding 평가(F/G)는 effective만으로는 부족(리뷰 지적 — 변경 집합 밖 파일만
      //   커버한 최신 리뷰의 high finding이 조용히 소실된다). 커서 이후의 모든 신뢰
      //   리뷰에서, 더 새로운 리뷰로 대체되지 않은 finding을 모아 평가한다(v0.26.6).
      //   Findings about this session's files gate; the others are shown as a note (A3, splitFindings).
      const { own: activeFindings, foreign: foreignFindings, source: findingSource } = (() => {
        try {
          return splitFindings(reviews, sessionId, cwd, cursor ? cursor.timestamp : null);
        } catch {
          return {
            own: effectiveReviews.flatMap((r) => (Array.isArray(r.findings) ? r.findings : [])),
            foreign: [] as ReviewFinding[],
            source: new Map<ReviewFinding, ReviewResult>(),
          };
        }
      })();

      // (F) 재시도 카운터 (high severity).
      const highSev = activeFindings.filter((f) => f && f.severity === 'high');
      if (highSev.length > 0) {
        const issues = findingsSummary(highSev, false);
        if (!userPass(sessionId, cwd, 'review')) {
          const count = readRetryCount(sessionId) + 1;
          writeRetryCount(sessionId, count);
          logGate(sessionId, 'review', 'deny', 'high-severity');
          const axes = axesToReReview(highSev, findingSource);
          emit(
            blockOutput(
              sessionId,
              cwd,
              `high severity 발견사항을 수정하세요: ${issues}. A finding clears when, after the fix, ` +
                `the review axes that raised it (${axes || 'unknown'}) review the flagged file again: a delta review ` +
                `(one ${agentName(ROUTE.review)} with \`mode: delta\` and the fixed files) does it.`,
              'review',
              '',
              count,
            ),
          );
          return;
        }
        // The user's override: review accepted → cursor moves.
        acceptReview(sessionId, cwd);
        statusSnapshot.reviewPending = false;
        emit({ systemMessage: withForeignNote(`해소되지 않은 high severity: ${issues}`, foreignFindings) });
        return;
      }

      // (F1.5) A2 — 추측/가정 리뷰 연동. 메인 에이전트가 최근 '## 추론' 섹션에서
      //   추측(### 추측)이나 가정(### 가정)을 선언했다면, 리뷰가 가정 검증
      //   (unknown_assumptions_checked)을 실제로 수행했어야 한다. 필드/CLI 스키마/리뷰 지시는
      //   이미 갖춰져 있고(발견 ②) 여기가 마지막 강제 연결이다.
      //   추론 섹션 탐색: 최근 assistant 텍스트에서 가장 최근 섹션 1개(현재 작업의 것으로 근사 —
      //   추론 게이트가 편집마다 최근 3턴 내 섹션을 요구하므로 최신 섹션이 현재 작업에 해당).
      //   fail-open: transcript 파싱 실패/섹션 없음 → 검사 생략.
      const declaredUnknowns = declaredUnknownsIn(input.transcript_path);
      const checkedAssumptions = effectiveReviews.reduce(
        (sum, r) =>
          sum + (Array.isArray(r.unknown_assumptions_checked) ? r.unknown_assumptions_checked.length : 0),
        0,
      );
      if (declaredUnknowns > 0 && checkedAssumptions === 0) {
        if (!userPass(sessionId, cwd, 'review')) {
          const count = readRetryCount(sessionId) + 1;
          writeRetryCount(sessionId, count);
          logGate(sessionId, 'review', 'deny', 'assumptions-unchecked');
          emit(
            blockOutput(
              sessionId,
              cwd,
              `The main session declared ${declaredUnknowns} guesses or assumptions in its rationale ` +
                `(## 근거 / ## Rationale), but the review did not check them (unknown_assumptions_checked is empty). ` +
                `Run ${agentName(ROUTE.review)} to check each one, record it, and review again. (guess-review link)`,
              'review',
              '',
              count,
            ),
          );
          return;
        }
        // The user's override: review accepted → cursor moves.
        acceptReview(sessionId, cwd);
        statusSnapshot.reviewPending = false;
        emit({
          systemMessage: withForeignNote(`추측/가정 ${declaredUnknowns}건이 리뷰에서 검증되지 않았어요.`, foreignFindings),
        });
        return;
      }

      // (F2) 차원 커버리지 검사 — 변경 파일이 요구하는 품질 차원을 리뷰가 실제로 평가했는지.
      //   리뷰의 dimensions_checked에 누락된 필수 차원이 있으면 BLOCK.
      //   Like high severity, only the user's marker passes it (track G).
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
        const dimList = missingDims.join(', ');
        if (!userPass(sessionId, cwd, 'review')) {
          const count = readRetryCount(sessionId) + 1;
          writeRetryCount(sessionId, count);
          logGate(sessionId, 'review', 'deny', `missing-dimensions: ${dimList}`);
          emit(
            blockOutput(
              sessionId,
              cwd,
              `The review did not assess the quality dimensions this change needs. ` +
                `Missing: ${dimList}. ` +
                `Run ${agentName(ROUTE.review)} for them (with runtime or observation probes), ` +
                `add them to dimensions_checked, and review again.`,
              'review',
              '',
              count,
            ),
          );
          return;
        }
        // The user's override: review accepted → cursor moves.
        acceptReview(sessionId, cwd);
        statusSnapshot.reviewPending = false;
        emit({
          systemMessage: withForeignNote(`리뷰가 다음 품질 차원을 평가하지 않았어요: ${dimList}`, foreignFindings),
        });
        return;
      }

      // (G) medium/low only — 통과 + 알림 (plus findings about files this session did not edit, A3)
      const systemMessage = passNote('리뷰 통과.', activeFindings, foreignFindings) || undefined;
      // 리뷰 수락(blocking high-severity 없음) → 커서 전진.
      //   이후 Stop에서는 이 턴 이후 편집만 리뷰 필요 대상이 된다.
      acceptReview(sessionId, cwd);
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
