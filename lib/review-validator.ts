// 리뷰 결과 JSON 파일 검증 (Stop hook에서 사용)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReviewFinding, ReviewResult, Verdict } from './types';

function isVerdict(v: unknown): v is Verdict {
  return v === 'pass' || v === 'needs-changes' || v === 'fail';
}

function safeReadReview(path: string): ReviewResult | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReviewResult>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.timestamp !== 'string') return null;
    if (!Array.isArray(parsed.reviewed_files)) return null;
    if (typeof parsed.category !== 'string') return null;
    if (!Array.isArray(parsed.findings)) return null;
    if (!isVerdict(parsed.verdict)) return null;
    if (!Array.isArray(parsed.unknown_assumptions_checked)) {
      // 누락 허용: 빈 배열로 채움
      parsed.unknown_assumptions_checked = [];
    }
    // dimensions_checked: 구버전 리뷰는 이 필드가 없다. 누락/비배열은 []로 채워 안전하게.
    if (!Array.isArray(parsed.dimensions_checked)) {
      parsed.dimensions_checked = [];
    } else {
      parsed.dimensions_checked = parsed.dimensions_checked.filter((d) => typeof d === 'string');
    }
    return parsed as ReviewResult;
  } catch {
    return null;
  }
}

/** <project>/.claude/reviews/ 안의 가장 최근 리뷰 파일을 읽어 ReviewResult로 반환.
 *  withinMinutes 안의 것만 유효. 없으면 null. */
export function findRecentReviewFile(reviewsDir: string, withinMinutes: number): ReviewResult | null {
  try {
    const entries = readdirSync(reviewsDir);
    const candidates: Array<{ path: string; mtime: number }> = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = join(reviewsDir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        candidates.push({ path: full, mtime: st.mtimeMs });
      } catch {
        continue;
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    const newest = candidates[0]!;
    const ageMin = (Date.now() - newest.mtime) / 60000;
    if (ageMin > withinMinutes) return null;
    return safeReadReview(newest.path);
  } catch {
    return null;
  }
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** reviewed_files가 changedFiles와 충분히 일치하는지(부분집합 허용).
 *  - reviewed_files ⊇ changedFiles 면 OK (모든 변경 파일이 리뷰됨)
 *  - verdict이 'fail'이면 ok=false
 *  - changedFiles가 비어있으면 verdict만 검사
 *  - latestEditTimestamp(ISO)가 주어지면 BUG #1 방지: 리뷰가 그보다 더 나중이어야 한다.
 *    staleness 판정에는 ReviewResult.timestamp(리뷰가 자체 기록한 작성 시각)를 쓴다.
 *  ⚠️ 신뢰 모델(E 보안): timestamp는 리뷰 에이전트가 쓰는 필드라 위조 가능하다.
 *    staleness는 하한만 보므로 미래 시각을 넣으면 "앞으로 생길 편집까지 이미 리뷰됨"이
 *    되어 게이트가 우회된다. 이를 2겹으로 막는다:
 *      (1) 쓰기 시점 — cli.ts가 호출자 timestamp를 무시하고 항상 서버 시각을 기록한다.
 *      (2) 검증 시점 — 여기서 timestamp가 유효한 ISO인지, 미래(+허용 스큐 초과)가
 *          아닌지 확인하고, 미래면 게이트 우회로 간주해 거부한다.
 */
export function validateReview(
  result: ReviewResult,
  changedFiles: string[],
  latestEditTimestamp?: string | null,
): ValidationResult {
  if (!result) return { ok: false, reason: '리뷰 결과 없음' };
  if (result.verdict === 'fail') {
    return { ok: false, reason: '리뷰 verdict이 fail' };
  }
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { ok: true };
  }
  const reviewed = new Set(
    (result.reviewed_files ?? []).map((f) => normalizePath(f)),
  );
  const missing: string[] = [];
  for (const f of changedFiles) {
    if (!reviewed.has(normalizePath(f))) missing.push(f);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `리뷰되지 않은 변경 파일 ${missing.length}개: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}`,
    };
  }
  // (E 보안) timestamp 자체 검증 — staleness는 하한만 보므로, 미래 시각을 쓰면
  //   "앞으로 생길 편집까지 이미 리뷰됨"으로 게이트가 우회된다(라이브에서 시도 관측).
  //   쓰기 시점(cli.ts: 서버 시각 강제)과 검증 시점(여기) 두 겹으로 방어한다.
  const SKEW_MS = 5 * 60_000; // 정상적인 시계 오차 허용치
  const reviewMs = typeof result.timestamp === 'string' ? Date.parse(result.timestamp) : NaN;
  if (!Number.isFinite(reviewMs)) {
    return { ok: false, reason: `리뷰 timestamp가 유효한 ISO 시각이 아닙니다(${String(result.timestamp)}).` };
  }
  if (reviewMs > Date.now() + SKEW_MS) {
    return {
      ok: false,
      reason: `리뷰 timestamp가 미래입니다(${result.timestamp}) — 게이트 우회로 간주해 거부합니다.`,
    };
  }
  // BUG #1: 리뷰가 최신 편집보다 더 오래되었으면(stale) 거부.
  // ISO 8601 문자열은 사전식 비교로 시간 순서가 보존된다.
  if (typeof latestEditTimestamp === 'string' && latestEditTimestamp !== '') {
    const reviewTs = result.timestamp;
    if (typeof reviewTs !== 'string' || reviewTs <= latestEditTimestamp) {
      return {
        ok: false,
        reason: `리뷰가 최신 편집보다 오래되었습니다(stale). 편집 후 다시 리뷰하세요. (리뷰: ${reviewTs ?? '없음'}, 최신 편집: ${latestEditTimestamp})`,
      };
    }
  }
  return { ok: true };
}

function normalizePath(p: string): string {
  try {
    return resolve(p);
  } catch {
    return p;
  }
}

export function highSeverityFindings(result: ReviewResult): ReviewFinding[] {
  if (!result || !Array.isArray(result.findings)) return [];
  return result.findings.filter((f) => f && f.severity === 'high');
}
