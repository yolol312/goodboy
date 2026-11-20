// A passing validation run in the shell clears the failed-validation marker (field report #44,
// plan §15.36 item 3).
//
// The marker (lib/validation-state.ts) names the commands that failed after an edit. Re-running one in
// the shell used to leave it blocking the Stop until the next Edit/Write re-ran the checks, because only
// the file-tool path recorded a pass. PostToolUse fires for a Bash call only when it ended with exit 0, so
// a call whose command is exactly one of the marker's commands, run from the marker's root, is the same
// check. It records a pass that started when the call started; passedSince then lifts the marker once all of
// its commands passed after the failure.
//
// Only an exact command counts. `x || true`, a pipe, `;`, `&`, a redirect, `$(…)`, a backtick or a newline
// make the exit code say nothing about the check, so any of them is no pass. The one prefix allowed is
// `cd <root> &&`, and the RTK proxy words `rtk ` / `rtk proxy ` before the command. The pass record is guarded against a shell write by lib/state-guard.ts.

import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { peekBashStart } from './approval-marker';
import { readValidationFailure } from './validation-state';

export interface ShellValidationPass {
  root: string;
  /** The marker command the call ran. */
  command: string;
  /** ISO start time of the call. */
  startedAt: string;
}

/** Characters that let a command succeed without its check passing, or run something else. */
const UNSAFE = /[|;&<>`\n\r]|\$\(/;
/** `cd <dir> &&` in front: a bare word or one quoted word, no expansion. */
//  Separators are an ASCII space or tab only (the shell's blanks): `\s` and `trim()` also take a no-break space or a
//  line separator, which the shell keeps in its word, so `bun run typecheck<NBSP>` passes an argument.
const CD_PREFIX = /^cd[ \t]+("[^"$`\\]*"|'[^']*'|[^ \t"'$`\\~*?[\]{}()<>|;&]+)[ \t]*&&[ \t]*/;

/** `rtk ` or `rtk proxy `, as bare words. */
const RTK_PREFIX = /^rtk[ \t]+(?:proxy[ \t]+)?/;

/** `text` without leading and trailing ASCII spaces and tabs only. */
const stripBlanks = (text: string): string => text.replace(/^[ \t]+|[ \t]+$/g, '');

function sameDir(a: string, b: string): boolean {
  if (resolvePath(a) === resolvePath(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** The marker command `command` is exactly, when the call also ran in `root`; else null. `startCwd` is where
 *  the shell was when the call started (relative `cd` targets resolve from it). */
export function exactMarkerCommand(command: string, markerCommands: readonly string[], root: string, startCwd: string): string | null {
  let rest = stripBlanks(command);
  let cwd = startCwd;
  const m = CD_PREFIX.exec(rest);
  if (m) {
    const target = m[1]!.replace(/^(["'])(.*)\1$/, '$2');
    if (target === '') return null;
    cwd = resolvePath(startCwd, target);
    rest = rest.slice(m[0].length);
  }
  // The user's RTK hook rewrites a command to `rtk <cmd>` (`rtk proxy <cmd>` runs it unfiltered), and the proxy keeps
  //   the exit code: either prefix, once, is the same check. Any flag or other subcommand is not (lib/commit-issue.ts
  //   pastRtk reads past the same two words, and the prefix commands after them, which are not accepted here).
  rest = rest.replace(RTK_PREFIX, '');
  if (rest === '' || UNSAFE.test(rest) || !markerCommands.includes(rest)) return null;
  return sameDir(cwd, root) ? rest : null;
}

/** The pass this finished Bash call proves, or null. Read it before afterBash removes the start note.
 *  No work when the session has no failed validation. */
export function shellValidationPass(
  sessionId: string,
  toolUseId: string | undefined,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
): ShellValidationPass | null {
  try {
    const command = toolInput.command;
    if (typeof command !== 'string' || toolInput.run_in_background === true) return null;
    // A response that reports an error or an interruption is no clean run, whatever the hook event.
    if (toolResponse && typeof toolResponse === 'object') {
      const r = toolResponse as Record<string, unknown>;
      if (r.is_error === true || r.error || r.interrupted === true) return null;
    }
    const failure = readValidationFailure(sessionId);
    if (failure === null || failure.root === undefined || failure.commands.length === 0) return null;
    const note = peekBashStart(sessionId, toolUseId);
    if (note === null) return null; // no start time to vouch with
    const matched = exactMarkerCommand(command, failure.commands, failure.root, note.cwd);
    if (matched === null) return null;
    return { root: failure.root, command: matched, startedAt: new Date(Math.min(note.t, Date.now())).toISOString() };
  } catch {
    return null;
  }
}
