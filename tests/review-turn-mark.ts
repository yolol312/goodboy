// (v0.36.10) The review gate carries a Stop whose turn changed no file (hooks/stop.ts,
// `reviewGateTurns`; tests/stop-review-carry.test.ts covers that). Tests about what the gate
// judges on repeated Stops call this before each Stop: it drops the session's review mark, so the
// Stop is judged as one that follows a change, as those tests assumed before the carry existed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function forgetReviewTurnMark(tmp: string, sessionId: string): void {
  const p = join(tmp, `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`, 'habit-state.json');
  if (!existsSync(p)) return;
  const state = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  delete state.reviewGateTurns;
  writeFileSync(p, JSON.stringify(state), 'utf8');
}
