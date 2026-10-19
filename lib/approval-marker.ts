// Approval markers — files in <project>/.claude/ that unlock a gate once the user approves
// (`! touch` by the user): the risk gate, the Bash write gate, R2 production commands, a Stop
// past a gate (`stop`) and a hand-off without passing tests (`push-test`). Only the user
// creates them (track G): PreToolUse denies the model's writes, PostToolUse removes the rest.
//
// Each marker name carries a short session tag (stabilization plan A3). One fixed name per
// repo let an approval given for one session unlock every session in the repo, and one
// session's new category command deleted another session's approval (security-axis
// review). The deny messages print the exact path, so nobody has to know the tag.

import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { hostsFilesFrom, parseHostRules, segmentChanging } from './outward-command';

/** `outward`: one use of a command aimed at a host listed as production (track G, R2).
 *  `stop`: one Stop past a gate the work cannot satisfy (track G: the user's override, which
 *  replaced the count-based escapes). `push-test`: one push or hand-off without a passing test
 *  result for the commit (track G push test check). */
export type ApprovalKind = 'risk' | 'bash-write' | 'outward' | 'stop' | 'push-test';

/** True for a path named like any goodboy approval marker, in any letter case (the default
 *  macOS volume ignores case, so `.Goodboy-Stop-Approved-…` is the same file). Only the user
 *  may create one (`! touch` runs outside the tool hooks); PreToolUse denies the model's
 *  writes to them. */
export function isApprovalMarkerPath(p: string): boolean {
  return /^\.goodboy-(?:risk|bash-write|outward|stop|push-test)-approved-[^/\\]*$/i.test(basename(p));
}

const MARKER_NAME = /\.goodboy-(?:risk|bash-write|outward|stop|push-test)-approved-/i;

/** This session's marker names in `<dir>/.claude`, lower-cased. */
function ownMarkerNames(sessionId: string, dir: string): string[] {
  const own = `-approved-${sessionTag(sessionId)}.txt`.toLowerCase();
  try {
    return readdirSync(join(dir, '.claude'))
      .map((n) => n.toLowerCase())
      .filter((n) => isApprovalMarkerPath(n) && n.endsWith(own));
  } catch {
    return [];
  }
}
/** Commands that only look at or remove a marker (removing withdraws an approval). */
const MARKER_SAFE_PROGS = new Set(['ls', 'cat', 'stat', 'test', '[', 'rm', 'unlink', 'file', 'head', 'tail', 'wc']);

/** The marker a shell command writes, or null: a segment that names a marker (quotes
 *  removed, so `.goodboy-st""op-…` counts) and redirects into it or runs anything but a read
 *  or a removal. A name built at run time is caught afterwards (sweepNewMarkers, and
 *  useUserMarker refuses a marker made while a model Bash call ran). */
export function bashMarkerWrite(command: string): string | null {
  return segmentChanging(command, (w) => MARKER_NAME.test(w), MARKER_SAFE_PROGS);
}

const BASH_START_PREFIX = 'bash-start-';

export interface BashStartNote {
  t: number;
  cwd: string;
  /** The call (so a Stop can finish a call that never reported back). */
  tuid?: string;
  command?: string;
  agent?: string;
  /** This session's markers in `<cwd>/.claude` when the call started (lower-cased names). */
  markers?: string[];
  /** Production entries of each `.goodboy/hosts` in effect when the call started. */
  hosts?: Record<string, string[]>;
  /** git's status when a call that can move files started: the repo top and its files
   *  (absolute). The top tells whether the post hook's status is of the same repo. */
  status?: GitStatusSnapshot;
}

export interface GitStatusSnapshot {
  top: string;
  files: string[];
}

function productionSnapshot(cwd: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of hostsFilesFrom(cwd)) {
    try {
      out[f] = parseHostRules(readFileSync(f, 'utf8')).production;
    } catch {
      // unreadable
    }
  }
  return out;
}

/** A tool_use_id as a file-name part; shared by the start notes and the gate-state snapshots. */
export function safeToolUseId(toolUseId: string): string {
  return toolUseId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function noteFile(sessionId: string, toolUseId: string): string {
  return join(ensureSessionDir(sessionId), `${BASH_START_PREFIX}${safeToolUseId(toolUseId)}.json`);
}

/** Notes when a Bash call started, where, and which of this session's markers existed then,
 *  so the post hooks can tell which markers the call created (by name, not by mtime, which the
 *  command controls: `touch -t`). `status`: git's status, for a call that can move files
 *  (lib/write-sweep.ts). `t`: the start, when not now (a call the Stop finished while it may
 *  still run, lib/write-sweep.ts). */
export function noteBashStart(
  sessionId: string,
  toolUseId: string,
  cwd: string,
  command?: string,
  agent?: string,
  status?: GitStatusSnapshot,
  t: number = Date.now(),
): void {
  try {
    const note: BashStartNote = {
      t,
      cwd,
      tuid: toolUseId,
      ...(typeof command === 'string' ? { command: command.slice(0, 20_000) } : {}),
      ...(agent ? { agent } : {}),
      markers: ownMarkerNames(sessionId, cwd),
      hosts: productionSnapshot(cwd),
      ...(status ? { status } : {}),
    };
    writeFileSync(noteFile(sessionId, toolUseId), JSON.stringify(note), 'utf8');
  } catch {
    // best-effort: without it, the sweep falls back to the call's own cwd and a short window
  }
}

export interface BashStart {
  since: number;
  dirs: string[];
  /** The cwd the call started in, when the note had it (the post hook reports where the
   *  shell ended, after any `cd`). */
  cwd?: string;
  /** The start cwd and its marker names then, when the note had them. */
  snapshot?: { dir: string; markers: string[] };
  /** Production entries per hosts file at the start. */
  hosts?: Record<string, string[]>;
  /** git's status at the start, when the note had it. */
  status?: GitStatusSnapshot;
}

/** Puts back production entries of `.goodboy/hosts` that a Bash call removed (a deleted
 *  file is recreated with them). Returns the restored `file: host` pairs. */
export function restoreProductionHosts(start: BashStart): string[] {
  const restored: string[] = [];
  for (const [file, hosts] of Object.entries(start.hosts ?? {})) {
    let now = '';
    try {
      now = readFileSync(file, 'utf8');
    } catch {
      now = '';
    }
    const kept = new Set(parseHostRules(now).production.map((h) => h.toLowerCase()));
    const missing = hosts.filter((h) => !kept.has(h.toLowerCase()));
    if (missing.length === 0) continue;
    try {
      mkdirSync(resolvePath(file, '..'), { recursive: true });
      const prefix = now === '' || now.endsWith('\n') ? '' : '\n';
      appendFileSync(file, `${prefix}${missing.map((h) => `production ${h}`).join('\n')}\n`, 'utf8');
      restored.push(...missing.map((h) => `${file}: ${h}`));
    } catch {
      // read-only: nothing to do
    }
  }
  return restored;
}

/** When and where a Bash call started (noteBashStart), removing the note. Without one, the
 *  call is taken to have started 5 minutes ago in `cwd`. `since` has a 1 s margin for
 *  file-system time resolution. */
export function takeBashStart(sessionId: string, toolUseId: string | undefined, cwd: string): BashStart {
  let since = Date.now() - 5 * 60_000;
  const dirs = new Set([resolvePath(cwd)]);
  let snapshot: BashStart['snapshot'];
  let hosts: BashStart['hosts'];
  let status: GitStatusSnapshot | undefined;
  let startCwd: string | undefined;
  if (toolUseId) {
    const file = noteFile(sessionId, toolUseId);
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<BashStartNote>;
      if (typeof rec.t === 'number') {
        since = rec.t - 1000;
        recordBashWindow(sessionId, rec.t, Date.now());
      }
      if (typeof rec.cwd === 'string') {
        startCwd = resolvePath(rec.cwd);
        dirs.add(startCwd);
        if (Array.isArray(rec.markers)) snapshot = { dir: resolvePath(rec.cwd), markers: rec.markers.map(String) };
      }
      if (rec.hosts && typeof rec.hosts === 'object') hosts = rec.hosts;
      const st = rec.status as Partial<GitStatusSnapshot> | undefined;
      if (st && typeof st.top === 'string' && Array.isArray(st.files)) status = { top: st.top, files: st.files.map(String) };
    } catch {
      // no start note: the short fallback window above
    }
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
  return {
    since,
    dirs: Array.from(dirs),
    ...(startCwd ? { cwd: startCwd } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(hosts ? { hosts } : {}),
    ...(status ? { status } : {}),
  };
}

/** Removes this session's markers that a Bash call created and returns them: in the start
 *  cwd, every marker that was not there when it started (whatever its mtime); in another cwd
 *  the call ended in, those with an mtime at or after the start. The user's own `! touch`
 *  runs outside the tool hooks. Other sessions' markers unlock nothing here and stay. */
export function sweepNewMarkers(sessionId: string, start: BashStart): string[] {
  const removed: string[] = [];
  for (const dir of start.dirs) {
    const claudeDir = join(dir, '.claude');
    let names: string[];
    try {
      names = readdirSync(claudeDir);
    } catch {
      continue;
    }
    const before = start.snapshot && start.snapshot.dir === dir ? new Set(start.snapshot.markers) : null;
    const own = `-approved-${sessionTag(sessionId)}.txt`.toLowerCase();
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!isApprovalMarkerPath(name) || !lower.endsWith(own)) continue;
      const p = join(claudeDir, name);
      try {
        const isNew = before ? !before.has(lower) : statSync(p).mtimeMs >= start.since;
        if (isNew) {
          unlinkSync(p);
          removed.push(p);
        }
      } catch {
        // gone meanwhile
      }
    }
  }
  return removed;
}

const PRODUCTION_SEEN_FILE = 'production-hosts.json';

/** Adds the production hosts R2 sees now to the ones seen earlier in this session and returns
 *  them all: within a session a production entry never disappears, so `chmod 000`, a
 *  directory in its place or a symlink to /dev/null cannot lift it (security review). The user
 *  removes a host by editing the file; the change applies from the next session. */
export function rememberProduction(sessionId: string, now: string[]): string[] {
  const file = join(ensureSessionDir(sessionId), PRODUCTION_SEEN_FILE);
  let seen: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (Array.isArray(parsed)) seen = parsed.filter((h): h is string => typeof h === 'string');
  } catch {
    seen = [];
  }
  const all = Array.from(new Set([...seen, ...now]));
  if (all.length !== seen.length) {
    try {
      writeFileSync(file, JSON.stringify(all), 'utf8');
    } catch {
      // best-effort
    }
  }
  return all;
}

/** The session's Bash calls that started and never reported back, oldest first. */
export function openBashCalls(sessionId: string): BashStartNote[] {
  return openBashStarts(sessionId).sort((a, b) => a.t - b.t);
}

/** Model Bash calls of this session that started but got no post hook yet (no PostToolUse or
 *  PostToolUseFailure took their start note): still running, or ended by `exit N`, which
 *  fires no post hook at all (G0 M18). Notes older than 30 minutes are ignored. */
function openBashStarts(sessionId: string, exceptToolUseId?: string): BashStartNote[] {
  const out: BashStartNote[] = [];
  try {
    const dir = ensureSessionDir(sessionId);
    const except = exceptToolUseId ? `${BASH_START_PREFIX}${safeToolUseId(exceptToolUseId)}.json` : '';
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(BASH_START_PREFIX) || name === except) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<BashStartNote>;
        if (typeof rec.t === 'number' && Date.now() - rec.t < 30 * 60_000) {
          out.push({
            t: rec.t,
            cwd: String(rec.cwd ?? ''),
            ...(typeof rec.tuid === 'string' ? { tuid: rec.tuid } : {}),
            ...(typeof rec.command === 'string' ? { command: rec.command } : {}),
            ...(typeof rec.agent === 'string' ? { agent: rec.agent } : {}),
            ...(Array.isArray(rec.markers) ? { markers: rec.markers.map(String) } : {}),
            ...(rec.hosts && typeof rec.hosts === 'object' ? { hosts: rec.hosts } : {}),
          });
        }
      } catch {
        // a torn note
      }
    }
  } catch {
    // no session dir
  }
  return out;
}

const WINDOWS_FILE = 'bash-windows.jsonl';

/** Records when a model Bash call ran (from its start note to its post hook). The marker
 *  checks compare a marker's ctime with these windows: ctime is set by the kernel on every
 *  change, so `touch -t` cannot move it, and it catches a marker made in another directory
 *  during the call (security review). */
export function recordBashWindow(sessionId: string, start: number, end: number): void {
  try {
    appendFileSync(join(ensureSessionDir(sessionId), WINDOWS_FILE), JSON.stringify({ s: start, e: end }) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

function bashWindows(sessionId: string): Array<{ s: number; e: number }> {
  try {
    return readFileSync(join(ensureSessionDir(sessionId), WINDOWS_FILE), 'utf8')
      .split('\n')
      .slice(-2000)
      .flatMap((l) => {
        try {
          const w = JSON.parse(l) as { s?: number; e?: number };
          return typeof w.s === 'number' && typeof w.e === 'number' ? [{ s: w.s, e: w.e }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** True when a marker may have been made by the model: its ctime (or, in the start cwd of an
 *  open call, its absence from the call's snapshot) falls inside a model Bash call: a finished
 *  call's window, or a call that started and has not reported back. */
function madeDuringModelBash(sessionId: string, markerPath: string, exceptToolUseId?: string): boolean {
  let changed: number;
  try {
    const st = statSync(markerPath);
    changed = Math.max(st.ctimeMs, st.mtimeMs);
  } catch {
    return false;
  }
  const markerDir = resolvePath(markerPath, '..', '..');
  const name = basename(markerPath).toLowerCase();
  // No margin: the start is taken after PreToolUse's gates, before the command runs, and
  //   ctime has sub-millisecond resolution; a margin would refuse the user's marker made just
  //   before the call.
  if (bashWindows(sessionId).some((w) => changed >= w.s && changed <= w.e)) return true;
  return openBashStarts(sessionId, exceptToolUseId).some((n) =>
    n.markers && resolvePath(n.cwd) === markerDir ? !n.markers.includes(name) : changed >= n.t,
  );
}

/** Whether the user's marker is there to use. A marker made during an open model Bash call
 *  is removed instead and does not count (`touch …; exit 1` skips every post hook). */
export function userMarkerPresent(sessionId: string, markerPath: string, exceptToolUseId?: string): boolean {
  if (!existsSync(markerPath)) return false;
  // A marker is a plain file the user touched: a symlink would lend it another file's ctime
  //   (security review round 3), so it is no approval.
  let plain = false;
  try {
    plain = lstatSync(markerPath).isFile();
  } catch {
    plain = false;
  }
  if (plain && !madeDuringModelBash(sessionId, markerPath, exceptToolUseId)) return true;
  try {
    unlinkSync(markerPath);
  } catch {
    // gone meanwhile
  }
  return false;
}

/** Uses the user's marker once (userMarkerPresent, then consumeApprovalMarker). */
export function useUserMarker(sessionId: string, markerPath: string, exceptToolUseId?: string): boolean {
  return userMarkerPresent(sessionId, markerPath, exceptToolUseId) && consumeApprovalMarker(markerPath);
}

/** Uses a marker once: rename succeeds for exactly one process, where two concurrent
 *  unlink(2) calls can both succeed on macOS (A1.7). False when there is none to use. */
export function consumeApprovalMarker(markerPath: string): boolean {
  const consumed = `${markerPath}.consumed-${process.pid}`;
  try {
    renameSync(markerPath, consumed);
  } catch {
    return false;
  }
  try {
    unlinkSync(consumed);
  } catch {
    // a leftover consumed file unlocks nothing
  }
  return true;
}

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
