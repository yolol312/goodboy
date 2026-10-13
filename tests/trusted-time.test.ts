// lib/trusted-time.ts — the one trust rule for recorded timestamps (round 3 of phase A).

import { describe, expect, test } from 'bun:test';
import { canonicalTimestamp, isTrustedTimestamp, MAX_CLOCK_SKEW_MS } from '../lib/trusted-time';

describe('isTrustedTimestamp', () => {
  const now = Date.parse('2026-10-13T10:00:00.000Z');

  test('a valid time up to the allowed skew ahead is trusted', () => {
    expect(isTrustedTimestamp('2026-10-13T09:00:00.000Z', now)).toBe(true);
    expect(isTrustedTimestamp(new Date(now + MAX_CLOCK_SKEW_MS).toISOString(), now)).toBe(true);
    expect(isTrustedTimestamp('2026-10-13T19:04:00+09:00', now)).toBe(true); // 10:04Z
    expect(isTrustedTimestamp('2026-10-13T09:00:00Z', now)).toBe(true); // no milliseconds
  });

  test('a time beyond the skew, an unparsable string, or a non-string is not', () => {
    expect(isTrustedTimestamp(new Date(now + MAX_CLOCK_SKEW_MS + 1).toISOString(), now)).toBe(false);
    expect(isTrustedTimestamp('2026-10-13T19:06:00+09:00', now)).toBe(false); // 10:06Z
    expect(isTrustedTimestamp('yesterday', now)).toBe(false);
    expect(isTrustedTimestamp(Date.now(), now)).toBe(false);
    expect(isTrustedTimestamp(undefined, now)).toBe(false);
  });

  // Round 3 (final security review): Date.parse reads these as past dates, but as strings
  //   they sort after every ISO time.
  test('a string Date.parse reads but that is no ISO date-time is not trusted', () => {
    for (const ts of ['9', '9 Jan 2026', 'Tue, 13 Oct 2026 09:00:00 GMT', '2026-10-13', '2026-10-13 09:00:00']) {
      expect(Number.isFinite(Date.parse(ts))).toBe(true);
      expect(isTrustedTimestamp(ts, now)).toBe(false);
    }
  });

  test('the skew is five minutes', () => {
    expect(MAX_CLOCK_SKEW_MS).toBe(5 * 60_000);
  });
});

describe('canonicalTimestamp', () => {
  test('an ISO date-time in toISOString form; null for anything else', () => {
    expect(canonicalTimestamp('2026-10-13T12:00:00+09:00')).toBe('2026-10-13T03:00:00.000Z');
    expect(canonicalTimestamp('2026-10-13T03:00:00Z')).toBe('2026-10-13T03:00:00.000Z');
    expect(canonicalTimestamp('2026-10-13T03:00:00.000Z')).toBe('2026-10-13T03:00:00.000Z');
    for (const ts of ['9', '9 Jan 2026', '', null, 42]) expect(canonicalTimestamp(ts)).toBeNull();
  });
});
