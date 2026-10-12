// Approval markers — files in <project>/.claude/ that unlock a gate once the user approves:
// the risk gate (`! touch` by the user) and the Bash write gate (one-shot).
//
// Each marker name carries a short session tag (stabilization plan A3). One fixed name per
// repo let an approval given for one session unlock every session in the repo, and one
// session's new category command deleted another session's approval (security-axis
// review). The deny messages print the exact path, so nobody has to know the tag.

import { resolve as resolvePath } from 'node:path';

export type ApprovalKind = 'risk' | 'bash-write';

/** Short, file-name-safe tag of a session: the first 8 characters of its sanitized id.
 *  Claude Code session ids are UUIDs, so two live sessions do not share a tag. */
export function sessionTag(sessionId: string): string {
  const safe = String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 8);
  return safe === '' ? 'unknown' : safe;
}

/** The marker path relative to the project, as the deny messages print it,
 *  e.g. `.claude/.goodboy-risk-approved-7d9ae000.txt`. */
export function approvalMarkerRelPath(kind: ApprovalKind, sessionId: string): string {
  return `.claude/.goodboy-${kind}-approved-${sessionTag(sessionId)}.txt`;
}

export function approvalMarkerPath(cwd: string, kind: ApprovalKind, sessionId: string): string {
  return resolvePath(cwd, approvalMarkerRelPath(kind, sessionId));
}
