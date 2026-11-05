// Bash calls whose indirect writes could not be listed (#40). The shell-write sweep (lib/write-sweep.ts) asks git
// which project files a call changed; when git does not answer (a `.git` git cannot read inside an untracked dir, such
// as one whose HEAD is a FIFO, stalls `git status` in the outer repo), the call's writes are unknown. Before #40 the
// sweep dropped them, so they reached no edit list and no gate asked for their review or tests. Now the call is kept
// here; the Stop sweeps it again (from its start) and blocks while git still does not answer.
//
// One JSON line per call in the session dir (`unswept.jsonl`). The state guard keeps its lines append-only for a model
// Bash call (lib/state-guard.ts); only the hooks rewrite it, when a call is listed or the user's marker passes them.

import { appendFileSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { GitStatusSnapshot } from './approval-marker';
import { ensureSessionDir } from './file-tracker';
import { MAX_STATE_BYTES, readRegular } from './safe-read';

export const UNSWEPT_FILE = 'unswept.jsonl';

// No cap on the calls kept (#40 security review: a cap that dropped the oldest let forged appended lines push a genuine
//   call out). A call git can list is dropped by the retry; the file's size is bounded by the read (16 MB, past it the
//   record is refused, which blocks).

/** Stands for calls whose record was replaced (a FIFO, a link or a dir where the file was) or could not be read. */
export const LOST_RECORD: UnsweptCall = { tuid: '', since: 0, dirs: [], command: '(goodboy could not read its record of these commands)', stalled: [] };

export interface UnsweptCall {
  /** The tool use id ('' when the call had none). */
  tuid: string;
  /** Files changed at or after this time (ms) count as the call's writes (its start, less a margin). */
  since: number;
  /** The dirs the call's sweep reads: where it ended and where it started. Empty for LOST_RECORD only. */
  dirs: string[];
  /** Where the call started: the command's own paths resolve from it. */
  startDir?: string;
  command: string;
  agent?: string;
  /** git's status when the call started, when the start note had it. */
  status?: GitStatusSnapshot;
  /** What git did not answer for, the last time it was asked (absolute dirs). */
  stalled: string[];
}

const path = (sessionId: string): string => join(ensureSessionDir(sessionId), UNSWEPT_FILE);

/** The file for a write, with anything there that is no regular file removed first (a FIFO in its place would block
 *  the append, and the hook with it). `replaced` says something was removed: the calls it held are lost, so the
 *  writer keeps LOST_RECORD in their place (#40 security review: removing it silently dropped them). */
function forWrite(sessionId: string): { p: string; replaced: boolean } {
  const p = path(sessionId);
  try {
    if (!lstatSync(p).isFile()) {
      rmSync(p, { recursive: true, force: true });
      return { p, replaced: true };
    }
  } catch {
    // absent
  }
  return { p, replaced: false };
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null);

function parse(line: string): UnsweptCall | null {
  try {
    const r = JSON.parse(line) as Partial<UnsweptCall>;
    const dirs = strings(r.dirs);
    const stalled = strings(r.stalled);
    // Empty dirs is LOST_RECORD's shape: it must read back, or a replaced record would drop its calls silently
    //   (refactoring review, high).
    if (typeof r.tuid !== 'string' || typeof r.since !== 'number' || !Number.isFinite(r.since) || dirs === null || typeof r.command !== 'string' || stalled === null) return null;
    const st = r.status;
    const status = st && typeof st === 'object' && typeof st.top === 'string' && strings(st.files) !== null ? st : undefined;
    return {
      tuid: r.tuid,
      since: r.since,
      dirs,
      ...(typeof r.startDir === 'string' ? { startDir: r.startDir } : {}),
      command: r.command,
      ...(typeof r.agent === 'string' ? { agent: r.agent } : {}),
      ...(status ? { status } : {}),
      stalled,
    };
  } catch {
    return null;
  }
}

/** The calls kept, oldest first. A line that does not parse is skipped; an unreadable file (a FIFO, a link, too
 *  large) reads as none, with `refused` set so the caller can tell. Nothing is removed here. */
export function readUnswept(sessionId: string): { calls: UnsweptCall[]; refused: boolean } {
  try {
    const r = readRegular(path(sessionId), MAX_STATE_BYTES, true);
    if (r === 'absent') return { calls: [], refused: false };
    if (r === 'refused') return { calls: [], refused: true };
    const calls = r.text.split('\n').flatMap((l) => (l.trim() === '' ? [] : [parse(l)].filter((c): c is UnsweptCall => c !== null)));
    return { calls, refused: false };
  } catch {
    return { calls: [], refused: true };
  }
}

const line = (c: UnsweptCall): string => `${JSON.stringify({ ...c, command: c.command.slice(0, 2_000) })}\n`;

/** A path as one shell word (single quotes; plain when it has only safe characters). */
const quoted = (p: string): string => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

/** Keeps a call whose writes git could not list. Best-effort. */
export function noteUnswept(sessionId: string, call: UnsweptCall): void {
  try {
    const { p, replaced } = forWrite(sessionId);
    // The loss is dated, so it never reads as the same line as an earlier one (`replaceUnswept` matches by line:
    //   confirm review, a second loss was taken for the first and dropped).
    appendFileSync(p, (replaced ? line({ ...LOST_RECORD, since: Date.now() }) : '') + line(call), 'utf8');
  } catch {
    // best-effort
  }
}

/** Why the full Stop blocks on calls whose writes git still cannot list (model-facing). Dirs inside `cwd` are shown
 *  relative to it. */
export function unsweptReason(calls: readonly UnsweptCall[], cwd: string): string {
  const shown = (p: string): string => {
    const r = relative(cwd, p);
    return r === '' ? '.' : r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r) ? p : r;
  };
  const dirs = [...new Set(calls.flatMap((c) => c.stalled))];
  const cmds = calls.slice(0, 3).map((c) => `\`${c.command.replace(/\s+/g, ' ').slice(0, 80)}\``);
  const where =
    dirs.length > 0
      ? `git did not list the changes in ${dirs.slice(0, 5).map((d) => `\`${shown(d)}\``).join(', ')}${dirs.length > 5 ? ` and ${dirs.length - 5} more` : ''} (it did not answer in time, or failed)`
      : 'goodboy could not read its record of them';
  return (
    `goodboy could not list the files that ${calls.length} Bash command${calls.length === 1 ? '' : 's'} changed (${cmds.join(', ')}${calls.length > 3 ? ', …' : ''}): ${where}. ` +
    'Until they are listed, those writes are in no edit list, so no review or test is asked for them. ' +
    'A `.git` entry that git cannot read inside an untracked directory (one whose `HEAD` is not a regular file, such as a FIFO) makes `git status` wait for it; ' +
    `\`find ${quoted(dirs.length > 0 ? shown(dirs[0]!) : '.')} -mindepth 2 -path '*/.git/HEAD' ! -type f\` lists such entries. If one is no real repository, remove that \`.git\`. ` +
    'A repository git reports as broken (`git status` fails there) needs repairing the same way, and one with no work tree (`git config core.bare` is true, or a bare repository) needs `core.bare` false, or the command run from a work tree. ' +
    'Every full Stop tries again and blocks while git cannot list them; only the user can let this Stop pass otherwise.'
  );
}

/** Replaces the kept calls (the hooks only: the Stop when its record was unreadable). */
export function writeUnswept(sessionId: string, calls: readonly UnsweptCall[]): void {
  try {
    writeFileSync(forWrite(sessionId).p, calls.map(line).join(''), 'utf8');
  } catch {
    // best-effort
  }
}

/** Puts `kept` in place of the calls `read` held, and keeps every call appended since that read (#40 delta review:
 *  a background subagent's call, appended by its post hook while the Stop retried for up to 3 s, was lost when the Stop
 *  wrote back only what it had read, and nothing blocked for its writes). A call reads as the same when its line is
 *  the same. True when the record is unreadable now: what was appended is lost, and LOST_RECORD stands for it, in the
 *  file unless `lostToFile` is false (a caller that blocks for it now: confirm review, the Stop passed and only the next
 *  one blocked). The hooks only: the Stop after its retry, or when the user's marker passes the calls. An append in the
 *  moment between this read and the write can still be lost. */
export function replaceUnswept(sessionId: string, read: readonly UnsweptCall[], kept: readonly UnsweptCall[], lostToFile = true): boolean {
  const left = new Map<string, number>();
  for (const c of read) left.set(line(c), (left.get(line(c)) ?? 0) + 1);
  const now = readUnswept(sessionId);
  const added = now.refused
    ? lostToFile
      ? [{ ...LOST_RECORD, since: Date.now() }]
      : []
    : now.calls.filter((c) => {
        const n = left.get(line(c)) ?? 0;
        if (n === 0) return true;
        left.set(line(c), n - 1);
        return false;
      });
  writeUnswept(sessionId, [...kept, ...added]);
  return now.refused;
}
