// Task state set by a category command (/fix-bug, /migrate, …): category and risk level.
//
// UserPromptSubmit writes it; the PreToolUse risk gate and the Stop status snapshot read it.
// They read the copy in the session state dir (stabilization plan A3). The repo-level
// <project>/.claude/.goodboy-session-state.json is a single slot: another session's category
// command in the same repo overwrote it, and this session's risk gate — which trusts only
// state carrying its own sessionId — silently stopped applying. The repo-level file is
// still written because the review/test subagents read the task category from it, and it
// is read back only when the session copy is missing (see readSessionState).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Writes this session's state; the session id is stamped here, not taken from the caller.
 *  Throws only when the session copy (the one the gates read) cannot be written. The
 *  repo-level copy is informational and best-effort. */
export function writeSessionState(cwd: string, sessionId: string, state: Omit<SessionState, 'sessionId'>): void {
  const json = JSON.stringify({ ...state, sessionId }, null, 2);
  writeFileSync(join(ensureSessionDir(sessionId), SESSION_STATE_FILE), json, 'utf8');
  try {
    mkdirSync(resolvePath(cwd, '.claude'), { recursive: true });
    writeFileSync(resolvePath(cwd, '.claude', SESSION_STATE_FILE), json, 'utf8');
  } catch {
    // best-effort — a read-only checkout must not lose the session copy or the caller's
    //   follow-up steps (approval reset, counter reset).
  }
}

/** This session's task state, or null when there is none (no category command yet).
 *  Falls back to the repo-level copy when the session copy is missing — $TMPDIR not
 *  writable, or the session began on a plugin version that wrote only the repo-level file
 *  (/reload-plugins switches versions mid-session). Either copy counts only when it names
 *  this session, so another session's state, even one committed to the repo, never applies. */
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
