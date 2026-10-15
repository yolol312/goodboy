// Project mode (track H §14.2): a directory is non-project only when its own CLAUDE.md has the
// line `goodboy: non-project`; everything else is a project. Only the session's cwd counts
// (no inheritance, and ~/.claude/CLAUDE.md is never read for this). Non-project mode turns off
// the project-document rules (policy read gate, docs rule, H2/H4) and the test gate; the review
// gate and the safety rules stay.
//
// Only the user marks a directory non-project. A session uses the mode it started with
// (SessionStart pins it, like the commit issue settings): a marker that appears during the
// session counts only with the user's evidence of this session — the user typed the marker line
// in a prompt, or chose an AskUserQuestion option containing `non-project`. So whatever
// program writes it (cp, an interpreter, another letter case), the model cannot opt a project
// out of its rules. The write guard in PreToolUse is the early, explained denial. Removing
// the marker always counts. A same-user limit stays: a marker written in one session counts
// in the next (docs/stabilization-plan.md §14.2).

import { appendFileSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { commandSegments, plainWord } from './outward-command';

export const NON_PROJECT_MARKER = 'goodboy: non-project';
const EVIDENCE_FILE = 'marker-evidence.jsonl';
const PIN_FILE = 'project-mode-pin.json';
const MAX_CLAUDE_MD = 512 * 1024;

export type ProjectMode = 'project' | 'non-project';

/** True when `text` has the marker as a line of its own (trimmed, exact). */
export function hasMarkerLine(text: string): boolean {
  return text.split('\n').some((l) => l.trim() === NON_PROJECT_MARKER);
}

function realDir(dir: string): string {
  try {
    return realpathSync(resolvePath(dir));
  } catch {
    return resolvePath(dir);
  }
}

/** The mode `<cwd>/CLAUDE.md` says now, and its change time; a symlinked or oversized file
 *  says nothing. */
function markerNow(cwd: string): { mode: ProjectMode; changed: number } {
  const p = join(resolvePath(cwd), 'CLAUDE.md');
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_CLAUDE_MD) return { mode: 'project', changed: 0 };
    const mode = hasMarkerLine(readFileSync(p, 'utf8')) ? 'non-project' : 'project';
    return { mode, changed: Math.max(st.mtimeMs, st.ctimeMs) };
  } catch {
    return { mode: 'project', changed: 0 };
  }
}

interface ModePins {
  since: number;
  modes: Record<string, ProjectMode>;
}

function readModePins(sessionId: string): ModePins | null {
  try {
    const p = JSON.parse(readFileSync(join(ensureSessionDir(sessionId), PIN_FILE), 'utf8')) as ModePins;
    return typeof p?.since === 'number' && p.modes && typeof p.modes === 'object' ? p : null;
  } catch {
    return null;
  }
}

/** SessionStart (startup, resume, clear; not compact): the session uses the cwd's mode as it is now. */
export function pinProjectMode(sessionId: string, cwd: string): void {
  try {
    const state: ModePins = { since: Date.now(), modes: { [realDir(cwd)]: markerNow(cwd).mode } };
    writeFileSync(join(ensureSessionDir(sessionId), PIN_FILE), JSON.stringify(state), 'utf8');
  } catch {
    // best-effort: without a pin, a marker counts only when older than the session dir
  }
}

function sessionStart(sessionId: string, pins: ModePins | null): number {
  if (pins) return pins.since;
  try {
    const born = statSync(ensureSessionDir(sessionId)).birthtimeMs;
    return born > 0 ? born : Date.now();
  } catch {
    return Date.now();
  }
}

/** The mode of `cwd`. With a session: the pinned mode, or for an unpinned dir the marker only
 *  when it is older than the session; a marker newer than that needs the user's evidence. */
export function projectMode(cwd: string, sessionId?: string): ProjectMode {
  const now = markerNow(cwd);
  if (now.mode === 'project' || sessionId === undefined) return now.mode;
  if (hasMarkerEvidence(sessionId)) return 'non-project';
  const pins = readModePins(sessionId);
  const pinned = pins?.modes[realDir(cwd)];
  if (pinned !== undefined) return pinned;
  return now.changed <= sessionStart(sessionId, pins) ? 'non-project' : 'project';
}

/** Records that the user, in this session, said the directory is not a project. */
export function recordMarkerEvidence(sessionId: string, how: 'typed' | 'answered'): void {
  try {
    appendFileSync(join(ensureSessionDir(sessionId), EVIDENCE_FILE), JSON.stringify({ t: Date.now(), how }) + '\n', 'utf8');
  } catch {
    // best-effort: without it the marker write is denied (fail closed)
  }
}

export function hasMarkerEvidence(sessionId: string): boolean {
  try {
    return readFileSync(join(ensureSessionDir(sessionId), EVIDENCE_FILE), 'utf8').trim() !== '';
  } catch {
    return false;
  }
}

/** A prompt the user typed with the marker line in it. */
export function promptHasMarker(prompt: string): boolean {
  return hasMarkerLine(prompt) || prompt.includes(NON_PROJECT_MARKER);
}

/** An AskUserQuestion result whose chosen answer says non-project. */
export function answerChoseNonProject(toolResponse: unknown): boolean {
  const answers = (toolResponse as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') return false;
  return Object.values(answers as Record<string, unknown>).some((a) => typeof a === 'string' && /\bnon-project\b/i.test(a));
}

/** CLAUDE.md in any letter case (macOS file systems ignore case). */
const isClaudeMd = (p: string) => basename(p).toLowerCase() === 'claude.md';

/** The CLAUDE.md path a tool call would give the marker line, or null. Early feedback only:
 *  the session pin is what holds, so a copy onto CLAUDE.md (`cp CLAUDE.md.bak CLAUDE.md`) is
 *  not denied here. */
export function markerWriteTarget(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
  const file = typeof input.file_path === 'string' ? resolvePath(cwd, input.file_path) : null;
  if ((toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') && file && isClaudeMd(file)) {
    const added =
      toolName === 'Write'
        ? String(input.content ?? '')
        : toolName === 'Edit'
          ? String(input.new_string ?? '')
          : (Array.isArray(input.edits) ? input.edits : []).map((e) => String((e as { new_string?: unknown })?.new_string ?? '')).join('\n');
    if (!hasMarkerLine(added)) return null;
    try {
      if (hasMarkerLine(readFileSync(file, 'utf8'))) return null; // already marked
    } catch {
      // a new file
    }
    return file;
  }
  if (toolName === 'Bash' && typeof input.command === 'string') {
    // A segment that writes a CLAUDE.md (a redirect or tee target), with the marker text in the
    //   command; a read (`grep`) or a commit message that names both is no write.
    const marked = plainWord(input.command).includes(NON_PROJECT_MARKER);
    if (!marked) return null;
    for (const words of commandSegments(input.command, { keepRedirects: true })) {
      const plain = words.map((w) => plainWord(w));
      const prog = basename(plain[0] ?? '');
      for (let i = 0; i < plain.length; i++) {
        const w = plain[i]!;
        const redirect = w.match(/^\d*>>?(.*)$/);
        const target = redirect ? redirect[1] || plain[i + 1] || '' : '';
        if (target && isClaudeMd(target)) return resolvePath(cwd, target);
      }
      if (prog === 'tee') {
        const t = plain.slice(1).find((w) => !w.startsWith('-') && isClaudeMd(w));
        if (t) return resolvePath(cwd, t);
      }
    }
  }
  return null;
}

/** Why this call may not add the marker, or null. */
export function markerWriteDenial(sessionId: string, toolName: string, input: Record<string, unknown>, cwd: string): string | null {
  const target = markerWriteTarget(toolName, input, cwd);
  if (target === null || hasMarkerEvidence(sessionId)) return null;
  return (
    `Only the user can mark a directory as non-project (\`${NON_PROJECT_MARKER}\` in ${target}). ` +
    'Ask with AskUserQuestion whether this directory is a project, with an option labeled "non-project (프로젝트 아님)"; ' +
    'after the user chooses it, write the marker again. (project mode)'
  );
}
