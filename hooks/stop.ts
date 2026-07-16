#!/usr/bin/env bun
// Stop hook — 턴 증가, 리뷰 강제/검증, 재시도 카운터, 커서/차원 검사

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { StatusSnapshot } from '../lib';
import {
  clearReadRecords,
  clearValidationFailure,
  compactForcePct,
  currentFindings,
  envInt,
  extractRecentAssistantTexts,
  findRecentReviewFiles,
  getContextUsage,
  getCurrentTurn,
  getEditsSince,
  getEditsWithLastTimestampSince,
  hasReasoningSection,
  highSeverityFindings,
  incrementTurn,
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
    if (!forceActive && !state.longSessionWarned) {
      const timeWarnMin = envInt('GOODBOY_SESSION_TIME_WARN_MIN', 35);
      const tokenWarn = envInt('GOODBOY_TOKEN_WARN', 50_000);
      const startMs = state.sessionStartTs ? Date.parse(state.sessionStartTs) : NaN;
      const elapsedMin = Number.isFinite(startMs) ? (nowMs - startMs) / 60000 : 0;
      const timeExceeded = elapsedMin > timeWarnMin;
      const tokenExceeded = usage ? usage.tokens > tokenWarn : false;
      if (timeExceeded || tokenExceeded) {
        // ⚠️ 문구에 '/compact' 문자열을 넣지 않는다(강제 신호와 구분 + 기존 테스트 보존).
        habitWarnings.push(
          '긴 세션이 감지되었습니다 — 새 세션 시작 또는 대화 압축을 권장합니다. (긴 세션 경고, H1-01)',
        );
        state.longSessionWarned = true;
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
    if (!usage) return { output: null, forced: false };
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
        const acceptMsg = tryAcceptPendingReview(sessionId, cwd, input.transcript_path);
        emit(acceptMsg ? { systemMessage: acceptMsg } : {});
        return;
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
              `메인 에이전트가 추론 섹션에서 추측/가정 ${declaredUnknowns}건을 선언했지만, ` +
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
