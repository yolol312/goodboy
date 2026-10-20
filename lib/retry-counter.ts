// Per-session retry counters for gate escapes (stabilization plan A3).
//
// Counters live in the session state dir, not in the repo's .claude/. An escape budget
// belongs to one session: a repo-level slot let session B inherit session A's count (and
// pass on its first Stop), reset it, or overwrite it while both were running.

import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { readRegular } from './safe-read';

/** Default counter: the review gate's retry budget. */
export const REVIEW_RETRY_COUNT_FILE = '.goodboy-retry-count.txt';

function counterPath(sessionId: string, file: string): string {
  return join(ensureSessionDir(sessionId), file);
}

export function readRetryCount(sessionId: string, file: string = REVIEW_RETRY_COUNT_FILE): number {
  try {
    // A regular file only, not followed through a link: a FIFO placed here would hang the
    //   Stop, which reads every counter for the friction notice (J3 review).
    const r = readRegular(counterPath(sessionId, file), 1024, true);
    if (typeof r === 'string') return 0;
    const n = parseInt(r.text.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function writeRetryCount(sessionId: string, n: number, file: string = REVIEW_RETRY_COUNT_FILE): void {
  try {
    writeFileSync(counterPath(sessionId, file), String(n), 'utf8');
  } catch {
    // best-effort
  }
}

export function resetRetryCount(sessionId: string, file: string = REVIEW_RETRY_COUNT_FILE): void {
  try {
    const path = counterPath(sessionId, file);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}
