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
 *    이유: mtime은 복사/이동 시 보존되거나 touch로 위조되기 쉽지만, timestamp는
 *    리뷰 실행이 "이 시점의 코드를 봤다"는 의미적 선언이라 더 신뢰할 수 있다.
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
