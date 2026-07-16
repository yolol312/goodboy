import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  currentFindings,
  highSeverityFindings,
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
