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

/** reviewsDir 안의 모든 유효 리뷰 파일을 최신순으로 반환 (withinMinutes 이내만).
 *  v0.26.5 — 리뷰 누적 인정: 최신 리뷰 1개만 보면 부분 리뷰 2개가 서로를 무효화하는
 *  두더지잡기가 된다(실측: 리뷰 A{4파일} 후 "README 미리뷰" 차단 → README만 리뷰 B로
 *  돌리면 "4파일 미리뷰" 차단). 파일별 커버리지는 validateReviewCoverage가 판정한다. */
export function findRecentReviewFiles(reviewsDir: string, withinMinutes: number): ReviewResult[] {
  try {
    const entries = readdirSync(reviewsDir);
    const candidates: Array<{ path: string; mtime: number }> = [];
    const now = Date.now();
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = join(reviewsDir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if ((now - st.mtimeMs) / 60000 > withinMinutes) continue;
        candidates.push({ path: full, mtime: st.mtimeMs });
      } catch {
        continue;
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const out: ReviewResult[] = [];
    for (const c of candidates) {
      const r = safeReadReview(c.path);
      if (r !== null) out.push(r);
    }
    return out;
  } catch {
    return [];
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

// ── 파일별 누적 커버리지 검증 (v0.26.5) ────────────────────────────────────

export interface ChangedFileEdit {
  file: string;
  /** 이 파일의 마지막 편집 ISO 시각. 없으면 staleness 검사 생략. */
  lastEditTimestamp: string | null;
}

export interface CoverageResult extends ValidationResult {
  /** 커버리지를 실제로 구성한 리뷰들(파일별 최신 커버 리뷰의 합집합, 최신순).
   *  후속 검사(high-severity/가정 검증/차원 커버리지)는 이 집합 기준으로 평가한다. */
  effective: ReviewResult[];
}

/** 리뷰 timestamp가 유효한 ISO이고 미래(+스큐)가 아닌지. 미래면 위조 의심으로 제외. */
function hasTrustedTimestamp(r: ReviewResult, nowMs: number): boolean {
  const ms = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
  const SKEW_MS = 5 * 60_000;
  return Number.isFinite(ms) && ms <= nowMs + SKEW_MS;
}

/** 파일별 커버리지: 각 변경 파일에 대해 "그 파일의 마지막 편집보다 나중이고 그 파일을
 *  커버하는" 리뷰가 하나라도 있으면 통과. 파일별 최신 커버 리뷰가 fail이면 실패.
 *
 *  단일-리뷰 방식(validateReview)의 두 가지 오차단을 해소한다:
 *   (1) 부분 리뷰 상호 무효화 — 리뷰 A{4파일} + 리뷰 B{1파일}이 함께 있어도 최신 1개만
 *       보면 영원히 커버리지 실패(실측 두더지잡기).
 *   (2) 전역 staleness — 편집 안 된 파일의 유효한 리뷰가 다른 파일 편집으로 무효화.
 *
 *  신뢰 모델은 validateReview와 동일: 미래 timestamp 리뷰는 커버리지에서 제외(위조 방지,
 *  쓰기 시점 서버 시각 강제와 2겹). staleness는 파일별 마지막 편집 시각과 비교한다. */
export function validateReviewCoverage(
  reviews: ReviewResult[],
  changedEdits: ChangedFileEdit[],
): CoverageResult {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { ok: false, reason: '리뷰 결과 없음', effective: [] };
  }
  const nowMs = Date.now();
  const trusted = reviews.filter((r) => hasTrustedTimestamp(r, nowMs));
  const rejectedFuture = reviews.length - trusted.length;
  if (trusted.length === 0) {
    return {
      ok: false,
      reason: '유효한 리뷰가 없습니다(timestamp가 미래이거나 손상됨 — 게이트 우회로 간주해 거부).',
      effective: [],
    };
  }
  if (!Array.isArray(changedEdits) || changedEdits.length === 0) {
    // 변경 파일이 없으면 최신 리뷰의 verdict만 검사(기존 의미론 유지).
    const newest = trusted[0]!;
    if (newest.verdict === 'fail') return { ok: false, reason: '리뷰 verdict이 fail', effective: [newest] };
    return { ok: true, effective: [newest] };
  }
  // 최신순 정렬(호출부가 이미 최신순이어도 안전하게 재정렬). 동률은 입력 순서 유지(0).
  const sorted = [...trusted].sort((a, b) =>
    a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? 1 : -1,
  );
  const missing: string[] = [];
  const stale: string[] = [];
  const failed: string[] = [];
  const effective = new Set<ReviewResult>();
  for (const edit of changedEdits) {
    const key = normalizePath(edit.file);
    // 파일별 최신 커버 리뷰(fresh 우선). fresh가 없고 stale 커버만 있으면 stale로 분류.
    let coveredStale = false;
    let chosen: ReviewResult | null = null;
    for (const r of sorted) {
      if (!(r.reviewed_files ?? []).some((f) => normalizePath(f) === key)) continue;
      const isFresh =
        typeof edit.lastEditTimestamp !== 'string' ||
        edit.lastEditTimestamp === '' ||
        r.timestamp > edit.lastEditTimestamp;
      if (isFresh) {
        chosen = r;
        break; // 최신순이므로 첫 fresh가 파일별 최신 커버 리뷰
      }
      coveredStale = true;
    }
    if (chosen === null) {
      if (coveredStale) stale.push(edit.file);
      else missing.push(edit.file);
      continue;
    }
    if (chosen.verdict === 'fail') {
      failed.push(edit.file);
      continue;
    }
    effective.add(chosen);
  }
  const futureNote = rejectedFuture > 0 ? ` (미래 timestamp 리뷰 ${rejectedFuture}개는 위조 의심으로 무시됨)` : '';
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `리뷰되지 않은 변경 파일 ${missing.length}개: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}${futureNote}`,
      effective: Array.from(effective),
    };
  }
  if (stale.length > 0) {
    return {
      ok: false,
      reason: `리뷰가 마지막 편집보다 오래된 파일 ${stale.length}개: ${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ' …' : ''}. 해당 파일을 다시 리뷰하세요.${futureNote}`,
      effective: Array.from(effective),
    };
  }
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `최신 리뷰 verdict이 fail인 파일 ${failed.length}개: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ' …' : ''}`,
      effective: Array.from(effective),
    };
  }
  return { ok: true, effective: Array.from(effective) };
}

export function highSeverityFindings(result: ReviewResult): ReviewFinding[] {
  if (!result || !Array.isArray(result.findings)) return [];
  return result.findings.filter((f) => f && f.severity === 'high');
}

/** 커서(마지막 수락) 이후의 신뢰 리뷰들에서 "아직 유효한" finding을 모은다 (v0.26.6).
 *
 *  리뷰 지적(사각지대) 대응: finding 평가를 effective(커버리지 구성 리뷰)로만 하면,
 *  변경 집합 밖 파일만 커버한 최신 리뷰의 high finding이 조용히 소실된다.
 *  여기서는 finding 단위로 판정한다 — 그 finding의 파일을 커버하는 더 새로운 리뷰가
 *  있으면 대체(superseded)된 것으로 제외(수정 후 재리뷰 의미론), 아니면 유효.
 *  sinceTimestamp(리뷰 커서의 수락 시각) 이전 리뷰는 이미 표면화/수락된 것이므로 제외
 *  — escape로 수락된 finding이 다음 턴마다 재출현해 게이트를 재차단하는 퇴행을 막는다. */
export function currentFindings(
  reviews: ReviewResult[],
  sinceTimestamp: string | null,
): ReviewFinding[] {
  if (!Array.isArray(reviews) || reviews.length === 0) return [];
  const nowMs = Date.now();
  const pool = reviews.filter(
    (r) =>
      hasTrustedTimestamp(r, nowMs) &&
      (typeof sinceTimestamp !== 'string' || sinceTimestamp === '' || r.timestamp > sinceTimestamp),
  );
  const out: ReviewFinding[] = [];
  for (const r of pool) {
    if (!Array.isArray(r.findings)) continue;
    for (const f of r.findings) {
      if (!f || typeof f.file !== 'string') continue;
      const key = normalizePath(f.file);
      const superseded = pool.some(
        (o) =>
          o !== r &&
          o.timestamp > r.timestamp &&
          (o.reviewed_files ?? []).some((rf) => normalizePath(rf) === key),
      );
      if (!superseded) out.push(f);
    }
  }
  return out;
}
