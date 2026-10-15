// Task state set by a category command (/fix-bug, /prepare-migration, …): category and risk level.
//
// UserPromptSubmit writes it; the PreToolUse risk gate and the Stop status snapshot read it.
// They read the copy in the session state dir (stabilization plan A3). The repo-level
// <project>/.claude/.goodboy-session-state.json is a single slot: another session's category
// command in the same repo overwrote it, and this session's risk gate — which trusts only
// state carrying its own sessionId — silently stopped applying. The repo-level file is
// still written, for two reasons: the review/test subagents read the task category from it,
// and it is the gates' fallback when the session copy is missing or unusable (see
// readSessionState).

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';

export interface SessionState {
  category?: string;
  risk?: string;
  /** Why the task is risky (explainRisk): 'keyword:<kw>' | 'default' | 'override' | 'file-count' | 'none'. */
  riskReason?: string;
  turn?: number;
  /** 2-B: the session that wrote this state. State from another session is never applied. */
  sessionId?: string;
  updatedAt?: string;
}

export const SESSION_STATE_FILE = '.goodboy-session-state.json';

/** Writes this session's state to both copies; the session id is stamped here, not taken
 *  from the caller. Each write is attempted on its own. With an unwritable $TMPDIR the
 *  repo-level copy is what keeps the risk gate on; writing it only after a successful
 *  session write left neither copy, and risky commands ran ungated (round-2 review).
 *  A session copy that cannot be overwritten (EACCES) is removed, so the gates fall back to
 *  the repo copy with the new task instead of reading the previous task's risk from it
 *  (round-3 security review). Throws only when neither copy could be written. */
export function writeSessionState(cwd: string, sessionId: string, state: Omit<SessionState, 'sessionId'>): void {
  const json = JSON.stringify({ ...state, sessionId }, null, 2);
  const sessionCopy = join(ensureSessionDir(sessionId), SESSION_STATE_FILE);
  let sessionError: unknown = null;
  try {
    writeFileSync(sessionCopy, json, 'utf8');
  } catch (err) {
    sessionError = err;
    try {
      unlinkSync(sessionCopy);
    } catch {
      // usually there is no copy; one that cannot be removed either still names the old task
    }
  }
  try {
    mkdirSync(resolvePath(cwd, '.claude'), { recursive: true });
    writeFileSync(resolvePath(cwd, '.claude', SESSION_STATE_FILE), json, 'utf8');
  } catch {
    // A read-only checkout still has the session copy, which the gates read first.
    if (sessionError !== null) throw sessionError;
  }
}

/** This session's task state, or null when there is none (no category command yet).
 *  Falls back to the repo-level copy when the session copy is missing or unusable:
 *  - $TMPDIR is not writable;
 *  - the session began on a plugin version that wrote only the repo-level file
 *    (/reload-plugins switches versions mid-session);
 *  - the session copy is broken JSON, or names another session (a sanitized-id collision).
 *  Falling back keeps the risk gate on; returning null would turn it off. Either copy
 *  counts only when it names this session, so another session's state, even one
 *  committed to the repo, never applies. A usable session copy always wins. The repo copy
 *  is writable by the agent, and letting a newer updatedAt win let a planted copy with a
 *  later time beat the fresh risky task (round-3 final security review); a failed session
 *  write removes the session copy instead (writeSessionState). */
export function readSessionState(cwd: string, sessionId: string): SessionState | null {
  try {
    return (
      parseState(join(ensureSessionDir(sessionId), SESSION_STATE_FILE), sessionId) ??
      parseState(resolvePath(cwd, '.claude', SESSION_STATE_FILE), sessionId)
    );
  } catch {
    return null;
  }
}

/** Reads one copy; only string/number fields of the expected types are kept, so a
 *  malformed file cannot crash the gate that formats its deny message from them. */
function parseState(path: string, sessionId: string): SessionState | null {
  try {
    const p = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || p.sessionId !== sessionId) return null;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    return {
      category: str(p.category),
      risk: str(p.risk),
      riskReason: str(p.riskReason),
      turn: typeof p.turn === 'number' && Number.isFinite(p.turn) ? p.turn : undefined,
      sessionId,
      updatedAt: str(p.updatedAt),
    };
  } catch {
    return null;
  }
}
