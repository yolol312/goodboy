// Approval markers — files in <project>/.claude/ that unlock a gate once the user approves:
// the risk gate (`! touch` by the user) and the Bash write gate (one-shot).
//
// Each marker name carries a short session tag (stabilization plan A3). One fixed name per
// repo let an approval given for one session unlock every session in the repo, and one
// session's new category command deleted another session's approval (security-axis
// review). The deny messages print the exact path, so nobody has to know the tag.

import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';

export type ApprovalKind = 'risk' | 'bash-write';

/** Session-dir log of the places this session's risk approval was looked up, one JSON
 *  string per line. Appended, never rewritten: a subagent in another cwd notes paths while
 *  the main agent does, and rewriting one JSON array lost a concurrent note (round-3
 *  refactoring review). A lost path is an approval that the next task does not withdraw. */
const RISK_APPROVAL_PATHS_FILE = 'risk-approval-paths.jsonl';

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

/** Creates `<cwd>/.claude/` so the `touch` a deny message prints works. The Stop hook no
 *  longer creates that folder, and in a repo without it the printed command failed
 *  (round-2 layer-1 F6). Best-effort. */
export function ensureApprovalDir(cwd: string): void {
  try {
    mkdirSync(resolvePath(cwd, '.claude'), { recursive: true });
  } catch {
    // best-effort — a read-only checkout cannot hold the marker anyway
  }
}

function notedPaths(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split('\n')) {
    try {
      const p = JSON.parse(line) as unknown;
      if (typeof p === 'string') out.push(p);
    } catch {
      // an empty or torn line
    }
  }
  return out;
}

/** Remembers a place where the risk gate looked up this session's approval. The marker is
 *  relative to the cwd, and a session's cwd moves (cd pkg/). So the next category command
 *  must withdraw an approval left in any of these places, not only under its own cwd
 *  (round-2 security review). */
export function noteRiskApprovalPath(sessionId: string, markerPath: string): void {
  try {
    const file = join(ensureSessionDir(sessionId), RISK_APPROVAL_PATHS_FILE);
    // Newlines on both sides: a torn record (a crash mid-write) stays on a line of its own
    //   and costs only itself, not the record before or after it.
    if (!notedPaths(file).includes(markerPath)) appendFileSync(file, `\n${JSON.stringify(markerPath)}\n`, 'utf8');
  } catch {
    // best-effort — without the note, only the marker under the new task's cwd is withdrawn
  }
}

/** Withdraws this session's risk approval when a new task starts: the marker under `cwd`
 *  and every one noted by noteRiskApprovalPath. Only files named like this session's risk
 *  marker are deleted, whatever the list says. */
export function withdrawRiskApprovals(sessionId: string, cwd: string): void {
  const own = approvalMarkerPath(cwd, 'risk', sessionId);
  const file = join(ensureSessionDir(sessionId), RISK_APPROVAL_PATHS_FILE);
  for (const p of new Set([own, ...notedPaths(file)])) {
    if (basename(p) !== basename(own)) continue;
    try {
      unlinkSync(p);
    } catch {
      // usually there is no marker
    }
  }
  try {
    unlinkSync(file);
  } catch {
    // no list yet
  }
}
