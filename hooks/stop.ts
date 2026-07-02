#!/usr/bin/env bun
// Stop hook — 턴 증가, 리뷰 강제/검증, 재시도 카운터, 커서/차원 검사

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  compactMessageForStage,
  compactStages,
  envInt,
  findRecentReviewFile,
  getContextUsage,
  getCurrentTurn,
  getEditsSince,
  getLatestEditTimestampSince,
  highSeverityFindings,
  highestStageReached,
  incrementTurn,
  isStrongCompactStage,
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
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    additionalContext?: string;
  };
}

const MAX_RETRIES = 3;

// 이번 Stop 실행에서 사용자에게 보일 토큰-습관 경고들(H1-03 compact 단계 경고, H1-01 긴 세션 경고).
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

/** H1-03(다단계 compact 경고) + H1-01(긴 세션 경고)을 계산해 habitWarnings에 채운다.
 *  - fail-open: 예외/측정불가면 조용히 통과(경고 없음). 절대 throw 하지 않는다.
 *  - 스팸 억제: compact 경고는 같은 단계 세션당 1회(더 높은 단계로 올라갈 때만 재경고).
 *    긴 세션 경고는 세션당 1회.
 *  - 중복 방지: H1-03가 이번 Stop에 강한 경고(70%+)를 냈으면 H1-01은 생략한다. */
function maybeSetHabitWarnings(transcriptPath: string | undefined, sessionId: string): void {
  try {
    const state = readHabitState(sessionId);
    let dirty = false;

    // (H1-01) 세션 시작 시각 최초 1회 기록. 첫 Stop에선 경과시간 ~0이라 경고가 뜨지 않는다.
    const nowMs = Date.now();
    if (!state.sessionStartTs) {
      state.sessionStartTs = new Date(nowMs).toISOString();
      dirty = true;
    }

    // 컨텍스트 사용량(측정 실패 시 null → compact/token 경고 생략).
    let usage: ReturnType<typeof getContextUsage> = null;
    if (transcriptPath) {
      try {
        usage = getContextUsage(transcriptPath);
      } catch {
        usage = null;
      }
    }

    // --- H1-03: 다단계 compact 경고 (50/70/85, 최저 임계는 VCF_COMPACT_WARN_PCT) ---
    let strongCompactThisRun = false;
    if (usage) {
      const stages = compactStages();
      const reached = highestStageReached(usage.percent, stages);
      const lastStage = typeof state.compactWarnStage === 'number' ? state.compactWarnStage : 0;
      if (reached > 0 && reached > lastStage) {
        // 더 높은 단계로 처음 올라감 → 경고.
        habitWarnings.push(compactMessageForStage(reached, usage.percent));
        state.compactWarnStage = reached;
        dirty = true;
      }
      // 현재 강한 단계(70%+)에 있으면 H1-01 중복 억제 판단에 반영(이미 경고했든 아니든).
      if (reached > 0 && isStrongCompactStage(reached)) strongCompactThisRun = true;
    }

    // --- H1-01: 긴 세션(경과시간/절대토큰) 경고 ---
    // H1-03가 이번 Stop에 강한 경고를 냈으면 스팸 방지를 위해 생략. 세션당 1회.
    if (!strongCompactThisRun && !state.longSessionWarned) {
      const timeWarnMin = envInt('VCF_SESSION_TIME_WARN_MIN', 35);
      const tokenWarn = envInt('VCF_TOKEN_WARN', 50_000);
      const startMs = state.sessionStartTs ? Date.parse(state.sessionStartTs) : NaN;
      const elapsedMin = Number.isFinite(startMs) ? (nowMs - startMs) / 60000 : 0;
      const timeExceeded = elapsedMin > timeWarnMin;
      const tokenExceeded = usage ? usage.tokens > tokenWarn : false;
      if (timeExceeded || tokenExceeded) {
        // ⚠️ 문구에 '/compact' 문자열을 넣지 않는다(compact 경고와 구분 + 기존 테스트 보존).
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

function readRetryCount(claudeDir: string): number {
  try {
    const path = resolvePath(claudeDir, '.vcf-retry-count.txt');
    if (!existsSync(path)) return 0;
    const raw = readFileSync(path, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeRetryCount(claudeDir: string, n: number): void {
  try {
    writeFileSync(resolvePath(claudeDir, '.vcf-retry-count.txt'), String(n), 'utf8');
  } catch {
    // best-effort
  }
}

function resetRetryCount(claudeDir: string): void {
  try {
    const path = resolvePath(claudeDir, '.vcf-retry-count.txt');
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

      // (B2) auto-compact 경고 — 컨텍스트 점유율이 임계치를 넘으면 /compact 권고를
      //   준비한다. emit()이 이후 모든 출력 경로(리뷰 block/pass)의 systemMessage에
      //   이 경고를 덧붙이므로, 리뷰 통과/차단과 독립적으로 사용자에게 노출된다.
      //   (B)의 무한루프 early-return은 이 위에서 끝나므로 그 경로엔 경고가 붙지 않는다.
      maybeSetHabitWarnings(input.transcript_path, sessionId);

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
