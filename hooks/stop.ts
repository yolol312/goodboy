#!/usr/bin/env bun
// Stop hook — 턴 증가, 리뷰 강제/검증, 재시도 카운터, 커서/차원 검사

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  compactForcePct,
  envInt,
  findRecentReviewFile,
  getContextUsage,
  getCurrentTurn,
  getEditsSince,
  getLatestEditTimestampSince,
  highSeverityFindings,
  incrementTurn,
  readHabitState,
  readReviewCursor,
  requiredDimensionsFor,
  validateReview,
  writeHabitState,
  writeReviewCursor,
} from '../lib';

interface StopInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
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

// H1-03 강제 자동 compact 재시도 카운터 파일. review 재시도(.vcf-retry-count.txt)와
// 간섭하지 않도록 별도 파일에 동일 escape 패턴(MAX_RETRIES)으로 관리한다.
const COMPACT_FORCE_COUNT_FILE = '.vcf-compact-force-count.txt';

// 이번 Stop 실행에서 사용자에게 보일 토큰-습관 경고들(H1-01 긴 세션 경고, H1-03 강제 escape 통지).
// emit()이 모든 출력 경로(block/pass)의 systemMessage에 이 경고들을 덧붙인다 —
// 이 권고들은 리뷰 통과/차단과 독립적이어야 하기 때문.
const habitWarnings: string[] = [];

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
      const timeWarnMin = envInt('VCF_SESSION_TIME_WARN_MIN', 35);
      const tokenWarn = envInt('VCF_TOKEN_WARN', 50_000);
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

    if (dirty) writeHabitState(sessionId, state);
  } catch {
    // fail-open — 경고 계산 실패해도 Stop 흐름을 막지 않는다.
  }
}

/** (H1-03) 컨텍스트 자동 compact 강제 판정.
 *  컨텍스트 점유율이 VCF_COMPACT_FORCE_PCT(기본 50) 이상이면:
 *   1) context-watchdog.sh와 동일한 자동 compact 유도 신호
 *      (top-level stopReason: 'compact_needed' + additionalContext)를 실어 하네스 compact를 유도하고,
 *   2) decision:'block' + reason으로 턴 종료를 막아 확실히 compact를 강제한다.
 *  무한 block 방지: stop_hook_active(main B단계에서 조기 return)와 MAX_RETRIES escape를 재사용한다.
 *   - 별도 카운터 파일(.vcf-compact-force-count.txt)을 사용해 review 재시도와 간섭하지 않는다.
 *   - 강제가 MAX_RETRIES회 이상 지속되면 통과시키고 경고만 남긴다(영구 정지 방지).
 *   - 임계 미만이면 카운터를 리셋하고 아무 동작도 하지 않는다.
 *  fail-open: 측정 불가/예외 시 강제하지 않는다(null 반환).
 *
 *  @returns output: emit할 HookOutput(block) 또는 null(강제 안 함/escape 통과).
 *           forced: 이번 Stop에서 강제가 발동했는지(escape 통과 포함) — H1-01 스팸 억제 판단용. */
function maybeForceCompact(
  usage: ReturnType<typeof getContextUsage>,
  cwd: string,
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

    const count = readRetryCount(claudeDir, COMPACT_FORCE_COUNT_FILE) + 1;

    // MAX_RETRIES escape — 강제를 반복했는데도 해소되지 않음 → 통과 + 경고(무한 block 방지).
    if (count >= MAX_RETRIES) {
      resetRetryCount(claudeDir, COMPACT_FORCE_COUNT_FILE);
      habitWarnings.push(
        `컨텍스트 사용률 ${pct}%가 지속됩니다. 자동 압축 강제를 ${MAX_RETRIES}회 시도했으나 ` +
          '해소되지 않아 이번 턴은 통과시킵니다. 수동으로 /compact 또는 새 세션을 권장합니다. (H1-03 강제)',
      );
      return { output: null, forced: true };
    }

    writeRetryCount(claudeDir, count, COMPACT_FORCE_COUNT_FILE);
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

function readRetryCount(claudeDir: string, file: string = '.vcf-retry-count.txt'): number {
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

function writeRetryCount(claudeDir: string, n: number, file: string = '.vcf-retry-count.txt'): void {
  try {
    writeFileSync(resolvePath(claudeDir, file), String(n), 'utf8');
  } catch {
    // best-effort
  }
}

function resetRetryCount(claudeDir: string, file: string = '.vcf-retry-count.txt'): void {
  try {
    const path = resolvePath(claudeDir, file);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

function main(): void {
  readStdin()
    .then((raw) => {
      let input: StopInput = {};
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as StopInput);
      } catch (err) {
        process.stderr.write(`[vcf stop] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? 'unknown';

      // (A) 턴 증가
      try {
        incrementTurn(sessionId);
      } catch (err) {
        process.stderr.write(`[vcf stop] incrementTurn error: ${String(err)}\n`);
      }

      // (B) 무한루프 방지
      if (input.stop_hook_active === true) {
        emit({});
        return;
      }

      // (B2) 컨텍스트 사용량 측정. 측정 실패(null)면 강제/경고를 모두 생략한다(fail-open).
      let usage: ReturnType<typeof getContextUsage> = null;
      if (input.transcript_path) {
        try {
          usage = getContextUsage(input.transcript_path);
        } catch {
          usage = null;
        }
      }

      // (B3) H1-03 강제 자동 compact — 컨텍스트 점유율이 강제 임계(기본 50%) 이상이면
      //   자동 compact 신호 + decision:block으로 턴 종료를 막아 확실히 compact를 강제한다.
      //   무한 block은 stop_hook_active(위 B)와 MAX_RETRIES escape로 방지한다.
      const force = maybeForceCompact(usage, cwd);

      // (B4) H1-01 긴 세션 경고 준비 — 강제가 발동했으면(force.forced) 스팸 방지로 생략.
      //   emit()이 이후 모든 출력 경로의 systemMessage에 habitWarnings를 덧붙인다.
      maybeSetLongSessionWarning(usage, sessionId, force.forced);

      // 강제 block이 결정되면 리뷰 검사보다 우선해 즉시 emit하고 종료한다.
      //   (B)의 무한루프 early-return은 위에서 끝나므로 강제/경고가 붙지 않는다.
      if (force.output) {
        emit(force.output);
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
      const recentEdits = (() => {
        try {
          return getEditsSince(sessionId, cursorTurn);
        } catch {
          return [];
        }
      })();
      if (recentEdits.length === 0) {
        emit({});
        return;
      }

      // (D) 리뷰 검사
      const reviewsDir = resolvePath(cwd, '.claude', 'reviews');
      const result = (() => {
        try {
          return findRecentReviewFile(reviewsDir, 30);
        } catch {
          return null;
        }
      })();
      if (!result) {
        const preview = recentEdits.slice(0, 5).join(', ');
        const more = recentEdits.length > 5 ? ` 외 ${recentEdits.length - 5}개` : '';
        emit({
          decision: 'block',
          reason: `변경된 파일에 대해 리뷰가 필요합니다. /review-changes 슬래시 커맨드 또는 review-changes 서브에이전트를 호출하여 다음 파일을 리뷰하세요: ${preview}${more}`,
        });
        return;
      }

      // (E) validateReview — 커버리지 + staleness(BUG #1) 동시 검사.
      //   리뷰 필요 파일 중 가장 최근 편집 시각보다 리뷰가 더 나중이어야 한다.
      const latestEditTs = (() => {
        try {
          return getLatestEditTimestampSince(sessionId, cursorTurn);
        } catch {
          return null;
        }
      })();
      const v = (() => {
        try {
          return validateReview(result, recentEdits, latestEditTs);
        } catch (err) {
          return { ok: false, reason: `validateReview 에러: ${String(err)}` };
        }
      })();
      if (!v.ok) {
        emit({
          decision: 'block',
          reason: `리뷰 검증 실패: ${v.reason ?? '알 수 없는 이유'}. /review-changes 를 다시 실행하세요.`,
        });
        return;
      }

      // (F) 재시도 카운터 (high severity)
      const claudeDir = ensureClaudeDir(cwd);
      const highSev = highSeverityFindings(result);
      if (highSev.length > 0) {
        const count = readRetryCount(claudeDir) + 1;
        writeRetryCount(claudeDir, count);
        const issues = highSev
          .slice(0, 3)
          .map((f) => `${f.file}${f.line ? `:${f.line}` : ''} — ${f.issue}`)
          .join('; ');
        const more = highSev.length > 3 ? ` (외 ${highSev.length - 3}개)` : '';
        if (count < MAX_RETRIES) {
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
        Array.isArray(result.dimensions_checked) ? result.dimensions_checked : [],
      );
      const missingDims = requiredDims.filter((d) => !checkedDims.has(d));
      if (missingDims.length > 0) {
        const count = readRetryCount(claudeDir) + 1;
        const dimList = missingDims.join(', ');
        if (count < MAX_RETRIES) {
          writeRetryCount(claudeDir, count);
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
      const otherFindings = result.findings.filter((f) => f && f.severity !== 'high');
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

      const out: HookOutput = {};
      if (systemMessage) out.systemMessage = systemMessage;
      emit(out);
    })
    .catch((err) => {
      process.stderr.write(`[vcf stop] fatal: ${String(err)}\n`);
      emit({});
    });
}

main();
