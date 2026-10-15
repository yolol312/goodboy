// What kind of prompt reached UserPromptSubmit (track G, §10.10).
//
// G0 measurements on Claude Code 2.1.299:
//   - M10: each background-agent completion reaches the main session as a UserPromptSubmit
//     whose prompt is a `<task-notification>` block. It is not a user request: no guidance,
//     no task registration, and never "a new user request" for the delegation guard.
//   - M12: a typed command arrives verbatim, e.g. `/goodboy:migrate add a column`.

export interface SlashCommand {
  /** Plugin namespace (`goodboy` in `/goodboy:migrate`), or null for a bare `/migrate`. */
  namespace: string | null;
  name: string;
  /** Everything after the name, trimmed; may span lines. Empty when none was given. */
  args: string;
}

/** True for a background-task completion block (M10). */
export function isTaskNotification(prompt: string): boolean {
  return typeof prompt === 'string' && prompt.trimStart().startsWith('<task-notification>');
}

// Anchored at the start of the whole prompt (no `m` flag): a command line inside pasted
// text is not a command. The name must end at whitespace or the end of the prompt, so a
// path such as `/Users/me/file.ts` does not match.
const SLASH_RE = /^\s*\/(?:([\w-]+):)?([\w-]+)(?:\s+([\s\S]*))?$/;

/** Parse a prompt that starts with a slash command, or return null. */
export function parseSlashCommand(prompt: string): SlashCommand | null {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(SLASH_RE);
  if (!m) return null;
  return { namespace: m[1] ?? null, name: m[2] ?? '', args: (m[3] ?? '').trim() };
}

/** A bare command or one in goodboy's namespace; another plugin's same-named command is not ours. */
export function isGoodboyCommand(cmd: SlashCommand): boolean {
  return cmd.namespace === null || cmd.namespace === 'goodboy';
}
