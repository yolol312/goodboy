// One trust rule for the timestamps that agents and hooks record: reviews, test results
// and validation passes. Gates compare these from below ("newer than the last edit"), so a
// future timestamp would cover edits that have not happened yet. Before this module each
// reader kept its own 5-minute constant, and the validation pass compared ISO strings
// while the others compared parsed times (round-3 refactoring review).

/** Clock skew allowed for a recorded timestamp. A later one is treated as forged. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

// An ISO 8601 date and time with a zone, as toISOString and the review and test CLIs write it.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Whether `ts` is an ISO date-time no later than `nowMs` plus the allowed skew. Anything
 *  else Date.parse can read is refused: `'9'` and `'9 Jan 2026'` parse as past dates (round-3
 *  final security review). */
export function isTrustedTimestamp(ts: unknown, nowMs: number = Date.now()): ts is string {
  if (typeof ts !== 'string' || !ISO_DATE_TIME.test(ts)) return false;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) && ms <= nowMs + MAX_CLOCK_SKEW_MS;
}

/** The toISOString form of an ISO date-time, or null for anything else. The readers store
 *  this form because the gates order timestamps as strings, which is time order only within
 *  one format. A review stamped `'9'` sorted after every ISO time and so stayed fresh for
 *  every later edit (round-3 final security review). */
export function canonicalTimestamp(ts: unknown): string | null {
  if (typeof ts !== 'string' || !ISO_DATE_TIME.test(ts)) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
