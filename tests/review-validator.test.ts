import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { highSeverityFindings, validateReview } from '../lib/review-validator';
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
