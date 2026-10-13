import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  currentFindings,
  fileModifiedAt,
  findRecentReviewFiles,
  highSeverityFindings,
  pruneOldReviewFiles,
  validateReview,
  validateReviewCoverage,
} from '../lib/review-validator';
import type { ReviewFinding, ReviewResult } from '../lib/types';

function review(partial: Partial<ReviewResult>): ReviewResult {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    reviewed_files: [],
    category: 'fix-bug',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    ...partial,
  };
}

describe('validateReview', () => {
  test('fail verdict => not ok', () => {
    const r = validateReview(review({ verdict: 'fail' }), []);
    expect(r.ok).toBe(false);
  });

  test('pass verdict + no changed files => ok', () => {
    expect(validateReview(review({ verdict: 'pass' }), []).ok).toBe(true);
    expect(validateReview(review({ verdict: 'needs-changes' }), []).ok).toBe(true);
  });

  test('ok when reviewed_files is a superset of changed files (path-normalized)', () => {
    const r = validateReview(
      review({ reviewed_files: ['/repo/a.ts', '/repo/b.ts'] }),
      ['/repo/a.ts'],
    );
    expect(r.ok).toBe(true);
  });

  test('not ok when a changed file was not reviewed', () => {
    const r = validateReview(
      review({ reviewed_files: ['/repo/a.ts'] }),
      ['/repo/a.ts', '/repo/missing.ts'],
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('missing.ts');
  });

  test('paths are normalized before comparison', () => {
    const reviewed = resolve('/repo/sub/../a.ts'); // -> /repo/a.ts
    const r = validateReview(review({ reviewed_files: [reviewed] }), ['/repo/a.ts']);
    expect(r.ok).toBe(true);
  });

  // BUG #1 regression: a review OLDER than the latest edit must be REJECTED (stale).
  test('REJECTS a review older than the latest edit (stale review)', () => {
    const r = validateReview(
      review({
        reviewed_files: ['/repo/a.ts'],
        timestamp: '2026-01-01T16:38:00Z', // review written at 16:38
      }),
      ['/repo/a.ts'],
      '2026-01-01T16:40:00Z', // but file edited at 16:40 — newer than review
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('stale');
  });

  test('ACCEPTS a review newer than the latest edit', () => {
    const r = validateReview(
      review({
        reviewed_files: ['/repo/a.ts'],
        timestamp: '2026-01-01T16:41:00Z', // review newer than edit
      }),
      ['/repo/a.ts'],
      '2026-01-01T16:40:00Z',
    );
    expect(r.ok).toBe(true);
  });

  test('REJECTS when review timestamp exactly equals latest edit (not strictly newer)', () => {
    const r = validateReview(
      review({ reviewed_files: ['/repo/a.ts'], timestamp: '2026-01-01T16:40:00Z' }),
      ['/repo/a.ts'],
      '2026-01-01T16:40:00Z',
    );
    expect(r.ok).toBe(false);
  });

  test('backward compatible: no latestEditTimestamp => no staleness check', () => {
    const r = validateReview(
      review({ reviewed_files: ['/repo/a.ts'], timestamp: '2020-01-01T00:00:00Z' }),
      ['/repo/a.ts'],
    );
    expect(r.ok).toBe(true);
  });

  // (E 보안) 미래 timestamp 우회 차단. staleness는 하한만 보므로, 미래 시각을 넣으면
  //   "앞으로 생길 편집까지 이미 리뷰됨"이 되어 게이트가 우회된다 → 미래는 거부한다.
  test('REJECTS a review timestamp in the future (gate-bypass attempt)', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString(); // +10분(스큐 5분 초과)
    const r = validateReview(
      review({ reviewed_files: ['/repo/a.ts'], timestamp: future }),
      ['/repo/a.ts'],
      new Date().toISOString(),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('미래');
  });

  test('REJECTS a non-ISO review timestamp', () => {
    const r = validateReview(
      review({ reviewed_files: ['/repo/a.ts'], timestamp: 'not-a-date' }),
      ['/repo/a.ts'],
      new Date().toISOString(),
    );
    expect(r.ok).toBe(false);
  });

  test('ACCEPTS a slightly-future timestamp within the allowed clock skew (+60s)', () => {
    const soon = new Date(Date.now() + 60_000).toISOString(); // +60초(스큐 5분 이내)
    const r = validateReview(
      review({ reviewed_files: ['/repo/a.ts'], timestamp: soon }),
      ['/repo/a.ts'],
      new Date(Date.now() - 60_000).toISOString(), // 편집은 1분 전 → 리뷰가 더 최신(통과)
    );
    expect(r.ok).toBe(true);
  });
});

// v0.26.5 — 리뷰 누적 인정(파일별 커버리지). 실측 두더지잡기 회귀:
//   리뷰 A{4파일} 존재 → "README 미리뷰" 차단 → README만 리뷰 B로 커버 →
//   이번엔 "4파일 미리뷰" 차단(최신 리뷰 1개만 검사했기 때문).
describe('validateReviewCoverage (v0.26.5, 리뷰 누적 인정)', () => {
  const T1 = '2026-01-01T10:00:00Z'; // 편집들
  const T2 = '2026-01-01T10:05:00Z'; // 리뷰 A
  const T3 = '2026-01-01T10:10:00Z'; // 리뷰 B

  const edits = (files: string[], ts: string) => files.map((f) => ({ file: f, lastEditTimestamp: ts }));

  test('부분 리뷰 2개의 합집합이 전체를 커버하면 => ok (실측 두더지잡기 회귀)', () => {
    const a = review({ reviewed_files: ['/repo/a.ts', '/repo/b.ts'], timestamp: T2 });
    const b = review({ reviewed_files: ['/repo/readme.md'], timestamp: T3 });
    const r = validateReviewCoverage([b, a], edits(['/repo/a.ts', '/repo/b.ts', '/repo/readme.md'], T1));
    expect(r.ok).toBe(true);
    expect(r.effective.length).toBe(2);
  });

  test('합집합으로도 안 덮이는 파일이 있으면 => 그 파일만 missing으로 차단', () => {
    const a = review({ reviewed_files: ['/repo/a.ts'], timestamp: T2 });
    const r = validateReviewCoverage([a], edits(['/repo/a.ts', '/repo/b.ts'], T1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('b.ts');
    expect(r.reason).not.toContain('a.ts,');
  });

  test('staleness는 파일별 — 편집 안 된 파일의 리뷰는 다른 파일 편집으로 무효화되지 않는다', () => {
    // readme는 T1 편집 + T2 리뷰(유효). a.ts는 T3 이후 편집 → a.ts만 다시 리뷰 필요.
    const a = review({ reviewed_files: ['/repo/a.ts', '/repo/readme.md'], timestamp: T2 });
    const r = validateReviewCoverage([a], [
      { file: '/repo/readme.md', lastEditTimestamp: T1 },
      { file: '/repo/a.ts', lastEditTimestamp: T3 },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('a.ts');
    expect(r.reason).not.toContain('readme');
  });

  test('파일별 최신 커버 리뷰가 fail이면 => 차단 (이전 pass 리뷰로 대체 불가)', () => {
    const oldPass = review({ reviewed_files: ['/repo/a.ts'], timestamp: T2, verdict: 'pass' });
    const newFail = review({ reviewed_files: ['/repo/a.ts'], timestamp: T3, verdict: 'fail' });
    const r = validateReviewCoverage([newFail, oldPass], edits(['/repo/a.ts'], T1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('fail');
  });

  test('fail 리뷰 후 더 새로운 pass 리뷰가 같은 파일을 커버하면 => ok (수정 후 재리뷰)', () => {
    const oldFail = review({ reviewed_files: ['/repo/a.ts'], timestamp: T2, verdict: 'fail' });
    const newPass = review({ reviewed_files: ['/repo/a.ts'], timestamp: T3, verdict: 'pass' });
    const r = validateReviewCoverage([newPass, oldFail], edits(['/repo/a.ts'], T1));
    expect(r.ok).toBe(true);
  });

  test('미래 timestamp 리뷰만 있으면 => 위조 의심으로 전체 거부', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const forged = review({ reviewed_files: ['/repo/a.ts'], timestamp: future });
    const r = validateReviewCoverage([forged], edits(['/repo/a.ts'], T1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('미래');
  });

  test('미래 timestamp 리뷰는 제외하고 정상 리뷰만으로 판정 — 위조 리뷰만 덮은 파일은 missing', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const forged = review({ reviewed_files: ['/repo/b.ts'], timestamp: future });
    const normal = review({ reviewed_files: ['/repo/a.ts'], timestamp: T2 });
    const r = validateReviewCoverage([forged, normal], edits(['/repo/a.ts', '/repo/b.ts'], T1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('b.ts');
    expect(r.reason).toContain('미래');
  });

  test('리뷰가 하나도 없으면 => 리뷰 결과 없음', () => {
    const r = validateReviewCoverage([], edits(['/repo/a.ts'], T1));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('없음');
  });

  test('변경 파일이 없으면 최신 리뷰 verdict만 검사(기존 의미론 유지)', () => {
    const a = review({ timestamp: T2, verdict: 'pass' });
    expect(validateReviewCoverage([a], []).ok).toBe(true);
    const f = review({ timestamp: T2, verdict: 'fail' });
    expect(validateReviewCoverage([f], []).ok).toBe(false);
  });
});

// v0.26.6 — finding 단위 평가(리뷰 사각지대 대응): 변경 집합 밖 파일만 커버한
//   최신 리뷰의 high finding이 effective에서 탈락해 조용히 소실되던 문제.
describe('currentFindings (v0.26.6, finding 단위 대체 의미론)', () => {
  const T1 = '2026-01-01T10:00:00Z';
  const T2 = '2026-01-01T10:05:00Z';
  const T3 = '2026-01-01T10:10:00Z';
  const highOn = (file: string): ReviewFinding => ({ file, issue: 'x', severity: 'high' });

  test('변경 집합 밖 파일만 커버한 최신 리뷰의 high finding도 유지된다 (사각지대 회귀)', () => {
    const outOfScope = review({
      reviewed_files: ['/repo/other.ts'],
      findings: [highOn('/repo/other.ts')],
      timestamp: T3,
      verdict: 'needs-changes',
    });
    const out = currentFindings([outOfScope], null);
    expect(out.length).toBe(1);
    expect(out[0]!.severity).toBe('high');
  });

  test('같은 파일을 커버하는 더 새로운 리뷰가 있으면 finding이 대체되어 제외된다', () => {
    const oldWithFinding = review({
      reviewed_files: ['/repo/a.ts'],
      findings: [highOn('/repo/a.ts')],
      timestamp: T2,
    });
    const newerClean = review({ reviewed_files: ['/repo/a.ts'], findings: [], timestamp: T3 });
    const out = currentFindings([newerClean, oldWithFinding], null);
    expect(out.length).toBe(0);
  });

  test('다른 파일을 커버하는 새 리뷰는 기존 finding을 대체하지 않는다', () => {
    const a = review({ reviewed_files: ['/repo/a.ts'], findings: [highOn('/repo/a.ts')], timestamp: T2 });
    const b = review({ reviewed_files: ['/repo/b.ts'], findings: [], timestamp: T3 });
    const out = currentFindings([b, a], null);
    expect(out.length).toBe(1);
  });

  test('커서(마지막 수락 시각) 이전 리뷰의 finding은 제외 — escape 수락 후 재출현 방지', () => {
    const preCursor = review({
      reviewed_files: ['/repo/a.ts'],
      findings: [highOn('/repo/a.ts')],
      timestamp: T1,
    });
    expect(currentFindings([preCursor], T2).length).toBe(0);
    expect(currentFindings([preCursor], null).length).toBe(1);
  });

  test('미래 timestamp 리뷰의 finding은 신뢰하지 않는다', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const forged = review({
      reviewed_files: ['/repo/a.ts'],
      findings: [highOn('/repo/a.ts')],
      timestamp: future,
    });
    expect(currentFindings([forged], null).length).toBe(0);
  });
});

// Round 3: what supersedes a finding. A newer review of the flagged file used to clear it
//   whatever it checked: in the per-axis flow a later clean axis cleared another axis's high
//   finding, and a re-run with no change cleared it too (security review). The final
//   reviews of the round then showed that matching dimensions left the hallucination axis
//   (no dimensions) open and made a re-review of the fixed file alone never enough, and that
//   reviews written before the change still counted.
describe('currentFindings: what supersedes a finding (round 3)', () => {
  const at = (min: number): string => new Date(Date.parse('2026-01-01T10:00:00.000Z') + min * 60_000).toISOString();
  const SECURITY = ['security-secrets', 'security-authz', 'error-path', 'proto-pollution'];
  /** The finding's review, at minute 0. */
  const flagged = (dims: string[], files = ['/repo/a.ts']): ReviewResult =>
    review({
      reviewed_files: files,
      findings: [{ file: '/repo/a.ts', issue: 'token logged', severity: 'high' }],
      timestamp: at(0),
      dimensions_checked: dims,
    });
  const later = (dims: string[], min: number): ReviewResult =>
    review({ reviewed_files: ['/repo/a.ts'], timestamp: at(min), dimensions_checked: dims });
  /** File mtimes, in minutes after the finding's review (null: missing). Others are older. */
  const mtimes =
    (changes: Record<string, number | null>) =>
    (file: string): number | null => {
      if (!(file in changes)) return Date.parse(at(-60));
      const min = changes[file];
      return min === null || min === undefined ? null : Date.parse(at(min));
    };
  const fixedAt1 = mtimes({ '/repo/a.ts': 1 });

  test("another axis's newer review does not clear the finding, even after a change", () => {
    expect(currentFindings([later(['refactoring-quality'], 2), flagged(SECURITY)], null, fixedAt1)).toHaveLength(1);
  });

  test('the same axis clears it after the change, also with fewer dimensions', () => {
    expect(currentFindings([later(SECURITY, 2), flagged(SECURITY)], null, fixedAt1)).toHaveLength(0);
    expect(currentFindings([later(['security-secrets'], 2), flagged(SECURITY)], null, fixedAt1)).toHaveLength(0);
  });

  test('without a change, a re-review of the same axis does not clear it', () => {
    expect(currentFindings([later(SECURITY, 2), flagged(SECURITY)], null, mtimes({}))).toHaveLength(1);
  });

  test('a review written before the change does not count', () => {
    // Re-reviewed at minute 2, changed at minute 3: the re-review saw the old file.
    expect(currentFindings([later(SECURITY, 2), flagged(SECURITY)], null, mtimes({ '/repo/a.ts': 3 }))).toHaveLength(1);
  });

  test('a hallucination-axis finding (no dimensions) needs a hallucination re-review', () => {
    expect(
      currentFindings([later(SECURITY, 2), later(['refactoring-quality'], 2), flagged([])], null, fixedAt1),
    ).toHaveLength(1);
    expect(currentFindings([later([], 2), flagged([])], null, fixedAt1)).toHaveLength(0);
    expect(currentFindings([later([], 2), flagged(SECURITY)], null, fixedAt1)).toHaveLength(1);
  });

  test('per-axis re-reviews together clear a finding of a review that covered several axes', () => {
    const both = flagged([...SECURITY, 'refactoring-quality']);
    expect(currentFindings([later(SECURITY, 2), both], null, fixedAt1)).toHaveLength(1);
    expect(currentFindings([later(['refactoring-quality'], 3), later(SECURITY, 2), both], null, fixedAt1)).toHaveLength(0);
  });

  test('a change to another file the review covered counts: the fix was in the caller', () => {
    const withCaller = flagged(SECURITY, ['/repo/a.ts', '/repo/caller.ts']);
    expect(currentFindings([later(SECURITY, 2), withCaller], null, mtimes({ '/repo/caller.ts': 1 }))).toHaveLength(0);
    // A file the review did not cover does not.
    expect(currentFindings([later(SECURITY, 2), flagged(SECURITY)], null, mtimes({ '/repo/other.ts': 1 }))).toHaveLength(1);
  });

  test('a missing flagged file counts as changed right after the review', () => {
    expect(currentFindings([later(SECURITY, 2), flagged(SECURITY)], null, mtimes({ '/repo/a.ts': null }))).toHaveLength(0);
  });

  // Round 3 (closing security and hallucination reviews): every axis lists the change set,
  //   deleted paths included. Counting a missing listed file made a clean re-run enough.
  test('another listed file that is missing is no change', () => {
    const withDeleted = flagged(SECURITY, ['/repo/a.ts', '/repo/old.ts']);
    expect(currentFindings([later(SECURITY, 2), withDeleted], null, mtimes({ '/repo/old.ts': null }))).toHaveLength(1);
  });

  // The single run that does every axis marks the hallucination axis (agents/review-changes.md).
  test('the `hallucination` marker: the single run that does every axis', () => {
    const singleRun = flagged([...SECURITY, 'refactoring-quality', 'performance', 'hallucination']);
    // Its finding needs a hallucination re-review too; the other axes are not enough.
    expect(
      currentFindings([later([...SECURITY, 'refactoring-quality', 'performance'], 2), singleRun], null, fixedAt1),
    ).toHaveLength(1);
    expect(
      currentFindings([later([], 3), later([...SECURITY, 'refactoring-quality', 'performance'], 2), singleRun], null, fixedAt1),
    ).toHaveLength(0);
    // And a single run re-review clears a hallucination-axis finding.
    expect(currentFindings([later([...SECURITY, 'hallucination'], 2), flagged([])], null, fixedAt1)).toHaveLength(0);
  });

  test('a dimension of no known axis is matched only by a review that lists it', () => {
    expect(currentFindings([later(SECURITY, 2), flagged(['custom-check'])], null, fixedAt1)).toHaveLength(1);
    expect(currentFindings([later(['custom-check'], 2), flagged(['custom-check'])], null, fixedAt1)).toHaveLength(0);
  });

  test('no file is looked at while no newer review of the axes lists the flagged file', () => {
    const asked: string[] = [];
    currentFindings([later(['refactoring-quality'], 2), flagged(SECURITY)], null, (file) => {
      asked.push(file);
      return null;
    });
    expect(asked).toEqual([]);
  });
});

describe('fileModifiedAt (round 3)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("the file's mtime, or null for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodboy-fma-'));
    dirs.push(dir);
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'x', 'utf8');
    const at = new Date('2026-01-01T10:00:00Z');
    utimesSync(file, at, at);
    expect(fileModifiedAt(file)).toBe(at.getTime());
    expect(fileModifiedAt(join(dir, 'gone.ts'))).toBeNull();
  });
});

// Round 3 (final security review): any string Date.parse reads used to pass the trust check,
//   while the gates order timestamps as strings. A review stamped '9' sorted after every
//   ISO time and stayed fresh for every later edit.
describe('review timestamps on read (round 3)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test('an ISO time is stored in toISOString form; any other form drops the review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodboy-rts-'));
    dirs.push(dir);
    const base = { reviewed_files: ['/repo/a.ts'], category: 'fix-bug', findings: [], verdict: 'pass' };
    writeFileSync(join(dir, 'offset.json'), JSON.stringify({ ...base, timestamp: '2026-10-13T12:00:00+09:00' }));
    writeFileSync(join(dir, 'nine.json'), JSON.stringify({ ...base, timestamp: '9' }));
    writeFileSync(join(dir, 'words.json'), JSON.stringify({ ...base, timestamp: '9 Jan 2026' }));
    const read = findRecentReviewFiles(dir, 60);
    expect(read.map((r) => r.timestamp)).toEqual(['2026-10-13T03:00:00.000Z']);
  });

  test('validateReview applies the same rule', () => {
    const r = validateReview(review({ timestamp: '9 Jan 2026', reviewed_files: ['/repo/a.ts'] }), ['/repo/a.ts']);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('유효한 ISO 시각이 아닙니다');
  });
});

describe('pruneOldReviewFiles (v0.27.5, 리뷰 파일 위생)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) {
      try {
        rmSync(tmpDirs.pop()!, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  function makeReviewsDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'goodboy-prune-'));
    tmpDirs.push(d);
    return d;
  }

  function writeAged(dir: string, name: string, ageMinutes: number): string {
    const p = join(dir, name);
    writeFileSync(p, '{}', 'utf8');
    const t = new Date(Date.now() - ageMinutes * 60000);
    utimesSync(p, t, t);
    return p;
  }

  test('보존 기간 지난 .json만 삭제, 최신 파일과 비-json은 보존', () => {
    const dir = makeReviewsDir();
    const old1 = writeAged(dir, 'old1.json', 60 * 24 * 4); // 4일
    const old2 = writeAged(dir, 'old2.json', 60 * 24 * 10); // 10일
    const fresh = writeAged(dir, 'fresh.json', 30); // 30분
    const notJson = writeAged(dir, 'note.txt', 60 * 24 * 10);

    const pruned = pruneOldReviewFiles(dir, 4320); // 3일
    expect(pruned).toBe(2);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(notJson)).toBe(true);
  });

  // 기준 시각을 주입한다. 주입하지 않으면 픽스처의 Date.now()와 구현의 Date.now()가
  // **같은 밀리초 안에** 끝날 때만 나이가 정확히 경계값이라, 이 테스트는 운으로
  // 통과한다(실측: 격리 재현 10회 중 1회 실패, CI에서 무작위로 터짐).
  test('경계: 보존 기간과 같은 나이는 보존', () => {
    const dir = makeReviewsDir();
    const atBoundary = writeAged(dir, 'boundary.json', 100);
    const exactlyBoundary = statSync(atBoundary).mtimeMs + 100 * 60000;
    expect(pruneOldReviewFiles(dir, 100, exactlyBoundary)).toBe(0);
    expect(existsSync(atBoundary)).toBe(true);
  });

  test('경계: 1ms만 넘어도 삭제한다', () => {
    const dir = makeReviewsDir();
    const justOver = writeAged(dir, 'over.json', 100);
    const oneMsPast = statSync(justOver).mtimeMs + 100 * 60000 + 1;
    expect(pruneOldReviewFiles(dir, 100, oneMsPast)).toBe(1);
    expect(existsSync(justOver)).toBe(false);
  });

  test('nowMs를 안 주면 기존 동작(Date.now 기준)을 유지한다', () => {
    const dir = makeReviewsDir();
    const old = writeAged(dir, 'old.json', 200);
    expect(pruneOldReviewFiles(dir, 100)).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  test('olderThanMinutes가 0 이하 또는 비유한이면 no-op', () => {
    const dir = makeReviewsDir();
    const old = writeAged(dir, 'old.json', 60 * 24 * 30);
    expect(pruneOldReviewFiles(dir, 0)).toBe(0);
    expect(pruneOldReviewFiles(dir, -5)).toBe(0);
    expect(pruneOldReviewFiles(dir, Number.NaN)).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  test('디렉터리가 없으면 0 반환(조용히 통과)', () => {
    expect(pruneOldReviewFiles(join(tmpdir(), 'goodboy-prune-none-없는경로'), 4320)).toBe(0);
  });
});

describe('highSeverityFindings', () => {
  const findings: ReviewFinding[] = [
    { file: 'a.ts', issue: 'x', severity: 'high' },
    { file: 'b.ts', issue: 'y', severity: 'medium' },
    { file: 'c.ts', issue: 'z', severity: 'high' },
  ];

  test('returns only high severity findings', () => {
    const high = highSeverityFindings(review({ findings }));
    expect(high.map((f) => f.file)).toEqual(['a.ts', 'c.ts']);
  });

  test('empty when none high', () => {
    expect(highSeverityFindings(review({ findings: [{ file: 'a', issue: 'i', severity: 'low' }] }))).toEqual([]);
  });
});
