// 서브에이전트 무한 재위임(재귀 폭주) 방어.
//
// 배경: 2026-06-14~15 한 프로젝트에서 "pytest 실행" 작업이 약 9시간 동안
//       6,000여 개 서브에이전트로 무한 재위임되어 폭주한 사고가 있었다.
//       이 모듈은 vcf의 마지막 안전망으로, Agent/Task 도구 호출에 한해
//       "가볍고 보수적인" 방어선만 둔다.
//
// 역할:
//   - 슬라이딩 윈도우(60초) 내 Agent/Task 총 호출 수가 상한(30)을 넘으면 차단.
//   - 동일(정규화된) 프롬프트 해시가 윈도우(60초) 내 임계값(5회) 이상 반복되면 차단.
//   정상 병렬/재시도는 통과, 순간적 수백~수천 회 폭주만 차단한다.
//
// 안전성(fail-open):
//   - 상태파일 읽기/쓰기/파싱 실패 등 이 모듈 자체의 오류 시 절대 차단하지 않고
//     통과시킨다. 재귀 가드 자체가 정상 작업을 막으면 안 된다.
//
// 상태 저장:
//   file-tracker 와 동일한 세션 디렉터리(/tmp/vcf-session-<sessionId>/)에
//   recursion-guard.jsonl 로 기록. 각 줄: { t: number(epoch ms), h: string(prompt hash) }.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';

// ---- 보수적 임계값 (재귀 폭주 방어 강화 기준) --------------------------------
/** 슬라이딩 윈도우 (밀리초). 60초. */
export const WINDOW_MS = 60_000;
/** 윈도우 내 Agent/Task 총 호출 상한. 이 값을 초과(>)하면 차단. (강화: 60→30) */
export const MAX_TOTAL = 30;
/** 윈도우 내 동일 프롬프트 해시 반복 임계. 이 값 이상(>=)이면 차단. (강화: 12→5) */
export const MAX_SAME_PROMPT = 5;
// -----------------------------------------------------------------------------

const STATE_FILE = 'recursion-guard.jsonl';

interface GuardRecord {
  /** epoch milliseconds */
  t: number;
  /** normalized prompt hash */
  h: string;
}

export interface RecursionGuardResult {
  /** 차단 여부. */
  blocked: boolean;
  /** 차단 사유(한국어). blocked=true 일 때만 채워짐. */
  reason?: string;
  /** 윈도우 내 총 호출 수(이번 호출 포함). */
  total: number;
  /** 윈도우 내 동일 프롬프트 호출 수(이번 호출 포함). */
  same: number;
}

/** 프롬프트 정규화(개행/탭→공백, 공백 압축, trim, 소문자) 후 sha256 해시.
 *  실패해도 예외를 던지지 않고 안정적인 대체 문자열을 반환(fail-open). */
export function hashPrompt(prompt: string): string {
  try {
    const normalized = (prompt ?? '')
      .replace(/[\n\r\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    return createHash('sha256').update(normalized).digest('hex');
  } catch {
    return 'nohash';
  }
}

function readRecords(path: string): GuardRecord[] {
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const out: GuardRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<GuardRecord>;
        if (parsed && typeof parsed.t === 'number' && typeof parsed.h === 'string') {
          out.push({ t: parsed.t, h: parsed.h });
        }
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 이번 Agent/Task 호출을 기록하고 슬라이딩 윈도우 기준으로 폭주 여부를 판정한다.
 *
 * recursion-guard.sh 와 동일하게: 이번 호출을 먼저 기록한 뒤, 윈도우 내
 * (이번 호출 포함) 총 호출 수(total)와 동일 프롬프트 호출 수(same)를 센다.
 *   - same >= MAX_SAME_PROMPT  → 차단
 *   - total >  MAX_TOTAL       → 차단
 *
 * 이 함수는 어떤 경우에도 예외를 던지지 않는다. 내부 오류 시 blocked=false 로
 * 통과시킨다(fail-open).
 *
 * @param sessionId 세션 식별자
 * @param prompt Agent/Task 프롬프트 텍스트(없으면 tool_input 직렬화)
 * @param now 현재 시각(epoch ms). 테스트 주입용. 기본값 Date.now().
 */
export function checkRecursionGuard(
  sessionId: string,
  prompt: string,
  now: number = Date.now(),
): RecursionGuardResult {
  try {
    const dir = ensureSessionDir(sessionId);
    const path = join(dir, STATE_FILE);
    const hash = hashPrompt(prompt);
    const cutoff = now - WINDOW_MS;

    // 이번 호출 기록 (best-effort)
    try {
      appendFileSync(path, JSON.stringify({ t: now, h: hash }) + '\n', 'utf8');
    } catch {
      // 기록 실패해도 판정은 진행(아래 records에는 이번 호출이 빠질 수 있음).
    }

    // 윈도우 내 라인만 유지 + 카운트
    const records = readRecords(path);
    const kept: GuardRecord[] = [];
    let total = 0;
    let same = 0;
    for (const r of records) {
      if (r.t >= cutoff) {
        kept.push(r);
        total += 1;
        if (r.h === hash) same += 1;
      }
    }

    // 기록 실패로 이번 호출이 파일에 없을 수 있으니 최소 1회는 보정.
    if (total === 0) {
      total = 1;
      same = 1;
    }

    // 오래된 라인 제거해 파일 무한 증가 방지 (실패해도 판정엔 영향 없음)
    try {
      writeFileSync(path, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch {
      // best-effort
    }

    if (same >= MAX_SAME_PROMPT) {
      return {
        blocked: true,
        total,
        same,
        reason:
          `재귀 폭주 방어: 동일 프롬프트가 최근 ${WINDOW_MS / 1000}초 내 ${same}회 반복 호출되었습니다(임계 ${MAX_SAME_PROMPT}). ` +
          '무한 재위임(재귀 폭주) 패턴으로 판단하여 Agent/Task 호출을 차단합니다. ' +
          '같은 작업이라면 위임을 멈추고 직접 수행하세요(leaf 실행). 다른 작업이면 프롬프트를 변경하세요.',
      };
    }

    if (total > MAX_TOTAL) {
      return {
        blocked: true,
        total,
        same,
        reason:
          `재귀 폭주 방어: 최근 ${WINDOW_MS / 1000}초간 Agent/Task 호출이 ${total}회로 상한(${MAX_TOTAL})을 초과했습니다. ` +
          '서브에이전트 폭주 방어선에 걸려 호출을 차단합니다. ' +
          '잠시 후 다시 시도하거나, 위임 대신 직접 실행으로 전환하세요.',
      };
    }

    return { blocked: false, total, same };
  } catch {
    // 어떤 오류든 통과 (fail-open)
    return { blocked: false, total: 0, same: 0 };
  }
}
