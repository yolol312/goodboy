// 리뷰 결과 JSON 파일 검증 (Stop hook에서 사용)

import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { axesOfDimensions } from './review-dimensions';
import { canonicalTimestamp, isTrustedTimestamp, MAX_CLOCK_SKEW_MS } from './trusted-time';
import type { ReviewFinding, ReviewResult, Verdict } from './types';

function isVerdict(v: unknown): v is Verdict {
  return v === 'pass' || v === 'needs-changes' || v === 'fail';
}

function safeReadReview(path: string): ReviewResult | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReviewResult>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Stored in one format, so the string comparisons below follow time order.
    const timestamp = canonicalTimestamp(parsed.timestamp);
    if (timestamp === null) return null;
    parsed.timestamp = timestamp;
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

/** (v0.27.5) 보존 기간이 지난 리뷰 파일 삭제 — 실사용 보고: .claude/reviews/*.json이
 *  무한정 쌓인다. 유효창(기본 24h)을 지난 리뷰는 게이트가 다시는 읽지 않는 죽은
 *  데이터다. Stop 훅이 매번 best-effort로 호출한다. 삭제한 파일 수를 반환.
 *  ⚠️ 호출부는 olderThanMinutes를 유효창 이상으로 클램프해야 한다 — 여기서는
 *  전달값을 그대로 신뢰한다(단위 테스트 용이성).
 *
 *  @param nowMs 기준 시각. 생략하면 `Date.now()`. **경계 테스트를 결정적으로 만들기
 *    위한 것이다** — 픽스처가 `Date.now()-N분` 으로 mtime을 찍고 구현이 자기
 *    `Date.now()` 로 나이를 재면, 두 호출이 같은 밀리초 안에 끝날 때만 나이가 정확히
 *    N분이라 경계 테스트가 운으로 통과한다(실측: 격리 재현 10회 중 1회 실패). */
export function pruneOldReviewFiles(
  reviewsDir: string,
  olderThanMinutes: number,
  nowMs?: number,
): number {
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes <= 0) return 0;
  let pruned = 0;
  try {
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
    for (const name of readdirSync(reviewsDir)) {
      if (!name.endsWith('.json')) continue;
      const full = join(reviewsDir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if ((now - st.mtimeMs) / 60000 <= olderThanMinutes) continue;
        unlinkSync(full);
        pruned++;
      } catch {
        continue;
      }
    }
  } catch {
    // 디렉터리 없음/권한 등 — 정리는 위생 작업이라 조용히 넘어간다.
  }
  return pruned;
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
  // The readers' rule (canonicalTimestamp): an ISO date-time only. Any string Date.parse
  //   reads used to pass here, '9 Jan 2026' included (round-3 closing refactoring review).
  const canonical = canonicalTimestamp(result.timestamp);
  const reviewMs = canonical === null ? NaN : Date.parse(canonical);
  if (!Number.isFinite(reviewMs)) {
    return { ok: false, reason: `리뷰 timestamp가 유효한 ISO 시각이 아닙니다(${String(result.timestamp)}).` };
  }
  if (reviewMs > Date.now() + MAX_CLOCK_SKEW_MS) {
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
  /** (#23) The record trees (`TestResult.tree`, set by test-write) that hold this file's current
   *  content: a record made on one tested what is there now, whenever it was made. */
  sameContentTrees?: ReadonlySet<string>;
}

export interface CoverageResult extends ValidationResult {
  /** Changed files no review lists. */
  missing?: string[];
  /** Changed files whose reviews are all older than their last edit: a delta review of just
   *  these is enough (H7). */
  stale?: string[];
  /** 커버리지를 구성한 리뷰들 — 각 변경 파일을 커버하면서 그 파일의 마지막 편집보다
   *  나중인(fresh) 리뷰 **전부**의 합집합. 후속 검사(가정 검증/차원 커버리지)가 이 집합을 쓴다.
   *
   *  ⚠️ 파일별 "최신 1개"가 아니라 fresh 전부인 이유: 리뷰를 축(리팩토링/보안/성능/환각)으로
   *  나눠 **병렬 서브에이전트**로 돌리면 같은 파일을 커버하는 부분 리뷰가 여러 개 생긴다.
   *  최신 1개만 취하면 나머지 축의 dimensions_checked가 통째로 사라져, 실제로 평가한
   *  차원을 "누락"으로 오판하고 영구 차단된다. 차원·가정 검증은 "했다"는 누적 사실이므로
   *  합집합이 맞다. 대체(supersede) 의미론이 필요한 finding 평가는 currentFindings가 담당한다. */
  effective: ReviewResult[];
}

/** 리뷰 timestamp가 유효한 ISO이고 미래(+스큐)가 아닌지. 미래면 위조 의심으로 제외. */
function hasTrustedTimestamp(r: ReviewResult, nowMs: number): boolean {
  return isTrustedTimestamp(r.timestamp, nowMs);
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
    // fresh 커버 리뷰를 전부 모은다(병렬 축 리뷰 지원). chosen = 그중 최신 —
    //   verdict=fail 판정은 "가장 최근 판단"만 따라야 하므로 최신 1개로 한다.
    const freshCovering: ReviewResult[] = [];
    for (const r of sorted) {
      if (!(r.reviewed_files ?? []).some((f) => normalizePath(f) === key)) continue;
      const isFresh =
        typeof edit.lastEditTimestamp !== 'string' ||
        edit.lastEditTimestamp === '' ||
        r.timestamp > edit.lastEditTimestamp;
      if (isFresh) {
        if (chosen === null) chosen = r; // 최신순이므로 첫 fresh가 파일별 최신 커버 리뷰
        freshCovering.push(r);
        continue;
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
    for (const r of freshCovering) effective.add(r);
  }
  const futureNote = rejectedFuture > 0 ? ` (미래 timestamp 리뷰 ${rejectedFuture}개는 위조 의심으로 무시됨)` : '';
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `리뷰되지 않은 변경 파일 ${missing.length}개: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}${futureNote}`,
      effective: Array.from(effective),
      missing,
      stale,
    };
  }
  if (stale.length > 0) {
    return {
      ok: false,
      reason: `리뷰가 마지막 편집보다 오래된 파일 ${stale.length}개: ${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ' …' : ''}. 해당 파일을 다시 리뷰하세요.${futureNote}`,
      effective: Array.from(effective),
      stale,
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

/** When `file` was last modified (epoch ms), or null when it does not exist. Supersession
 *  asks it: a newer review clears a finding only when there was a change to review. */
export type ModifiedAt = (file: string) => number | null;

/** The default ModifiedAt: the file's mtime, with the path resolved as the review paths are. */
export function fileModifiedAt(file: string): number | null {
  try {
    return statSync(normalizePath(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** 커서(마지막 수락) 이후의 신뢰 리뷰들에서 "아직 유효한" finding을 모은다 (v0.26.6).
 *
 *  리뷰 지적(사각지대) 대응: finding 평가를 effective(커버리지 구성 리뷰)로만 하면,
 *  변경 집합 밖 파일만 커버한 최신 리뷰의 high finding이 조용히 소실된다.
 *  여기서는 finding 단위로 판정한다 — 대체(superseded, 수정 후 재리뷰 의미론)된 것은
 *  제외하고 나머지는 유효. A finding is superseded (fixed, then re-reviewed) when:
 *   - a file its review covered changed after that review: the flagged file, or another
 *     file of its reviewed_files (a fix in the caller). A missing file counts as changed
 *     right after the review;
 *   - reviews written after that change list the flagged file; and
 *   - together they cover every axis of the finding's review (axesOfDimensions: a review
 *     without dimensions is the hallucination axis).
 *  The v0.26.6 rule took any newer review of the file. In the parallel per-axis flow every
 *  axis lists every changed file, so a high finding survived only if its axis wrote last:
 *  a clean refactoring review cleared a security high, and a re-run with no change cleared
 *  it too (round-3 security review). Matching dimensions instead of axes left the
 *  hallucination axis (no dimensions) unprotected and made a re-review of the fixed file
 *  alone, which lists fewer dimensions, never enough. Counting reviews from before the
 *  change let a bare `touch` clear a finding with the batch's later axes (round-3 final
 *  reviews).
 *  sinceTimestamp(리뷰 커서의 수락 시각) 이전 리뷰는 이미 표면화/수락된 것이므로 제외
 *  — escape로 수락된 finding이 다음 턴마다 재출현해 게이트를 재차단하는 퇴행을 막는다. */
export function currentFindings(
  reviews: ReviewResult[],
  sinceTimestamp: string | null,
  modifiedAt: ModifiedAt = fileModifiedAt,
): ReviewFinding[] {
  if (!Array.isArray(reviews) || reviews.length === 0) return [];
  const nowMs = Date.now();
  const sinceMs = typeof sinceTimestamp === 'string' && sinceTimestamp !== '' ? Date.parse(sinceTimestamp) : NaN;
  // Per review, once: its time, the files it lists and its axes. Resolving reviewed_files
  //   inside the finding loop made the Stop quadratic in the number of reviews (12 s at 800,
  //   round-3 final performance review).
  const pool = reviews
    .filter((r) => hasTrustedTimestamp(r, nowMs))
    .map((r) => ({
      r,
      ms: Date.parse(r.timestamp),
      files: new Set((r.reviewed_files ?? []).map((f) => normalizePath(f))),
      axes: axesOfDimensions(Array.isArray(r.dimensions_checked) ? r.dimensions_checked : []),
    }))
    .filter((e) => !(e.ms <= sinceMs));
  const mtimes = new Map<string, number | null>();
  const mtimeOf = (file: string): number | null => {
    const key = normalizePath(file);
    if (!mtimes.has(key)) mtimes.set(key, modifiedAt(file));
    return mtimes.get(key) ?? null;
  };
  // The axes that reviews newer than `afterMs` and listing `key` cover together.
  const axesAfter = (afterMs: number, key: string): Set<string> => {
    const out = new Set<string>();
    for (const o of pool) if (o.ms > afterMs && o.files.has(key)) for (const a of o.axes) out.add(a);
    return out;
  };
  const out: ReviewFinding[] = [];
  for (const e of pool) {
    if (!Array.isArray(e.r.findings)) continue;
    for (const f of e.r.findings) {
      if (!f || typeof f.file !== 'string') continue;
      const key = normalizePath(f.file);
      const covers = (axes: Set<string>): boolean => e.axes.every((a) => axes.has(a));
      // Cheap test first: without newer reviews of its axes the finding stays, and no file
      //   is stat'ed.
      if (!covers(axesAfter(e.ms, key))) {
        out.push(f);
        continue;
      }
      let changedAt = Infinity;
      for (const file of [f.file, ...(e.r.reviewed_files ?? [])]) {
        const m = mtimeOf(file);
        // Only the flagged file's absence is a change (deleted or moved). Another listed file
        //   may have been missing when the review was written (a path the change deleted, a
        //   typo), and counting it made one clean re-run enough (round-3 closing reviews).
        if (m === null) {
          if (normalizePath(file) === key) changedAt = Math.min(changedAt, e.ms);
        } else if (m > e.ms) changedAt = Math.min(changedAt, m);
      }
      if (changedAt === Infinity || !covers(axesAfter(changedAt, key))) out.push(f);
    }
  }
  return out;
}
