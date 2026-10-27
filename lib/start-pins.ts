// The session's start, per repo top (#33, v0.36.7). Before it, one pin held one {top, head}: a
// linked worktree of the same repository kept the first top's head (its object store has it), so
// the gates judged the worktree's changes against another checkout's commit (existing tests
// listed as deleted, changed lines refused or counted that the session never wrote, a copy of the
// start content passing with no test or review), and a resume from the worktree overwrote the pin.
//
// What is kept, in the session dir (all written only by the hooks; lib/state-guard.ts puts them
// back after a Bash call and removes one a call created):
//   - start-tips.json (once, at the session's first SessionStart): the full commit ids of every
//     ref tip and of every existing worktree's HEAD (detached ones too), keyed by the repository's
//     canonical common git dir, and the worktrees that exist. A failure, a truncation or a
//     deadline writes nothing: a partial list is never a complete one. Refs that move later cannot
//     change it.
//   - start-pin-<key>.json (once per top): the top's start. <key> is the canonical top plus the
//     identity of its git dir (path, inode, birth time). The existing worktrees are pinned at the
//     session's start; a top first seen later is pinned the first time a hook resolves it.
// A checkout made again at a path the session pinned (another git dir: a worktree removed and added,
// a `.git` copied or replaced) never moves the baseline there, forward or back (round 10): its start
// is the original one when it still holds (the checkout is in the repository the session started in,
// the snapshot's canonical common git dir, and the start commit is readable), otherwise unknown and
// incomplete. No git at a pinned path (a hidden or removed `.git`) is unknown and incomplete too,
// never the empty start. A pin that is missing or corrupt never grants one either.
// Both files are made with a hard link, so two hooks never overwrite each other: the first one
// wins and the others read what it wrote.
//
// What a checkout is comes from its `.git`, read without git; when that read fails (a `.git`
// symlink, a file git reads and this does not) git is asked. Only git's own "not a git repository"
// for a path with no `.git` proves a non-repo (nothing to compare with; never pinned). A timeout,
// a corrupt `.git`, a permission error or a disagreement is unknown, never "no repo".
//
// The start is one of: a commit; the empty tree; unknown (with the reason). An unknown start
// never borrows another top's, never grants an exemption and is never read as "nothing to
// compare": the layer-1 and review gates refuse it (hooks/stop.ts). The empty tree is only for a
// checkout with no commit behind it:
//   - in the repository the session started in, when the frozen tip set (detached worktree HEADs
//     included) is empty and HEAD does not resolve now;
//   - in another repository, when its object store holds no commit object (any failure: unknown).
//
// A top first seen mid-session (a worktree made by `git worktree add`, which Claude Code's own
// worktree feature does):
//   - HEAD reachable from the frozen tips: the start is HEAD;
//   - HEAD with new commits and exactly one boundary to the frozen tips: that boundary;
//   - several boundaries (a merge of two old lines: no merge base says which tests either parent
//     had), no relation (an orphan or unrelated history), another repository with history, no
//     snapshot, or any git error: unknown.
// The ancestry is the scope, not an authentication of who made a commit: a commit made on purpose
// with an old parent and a new tree reaches the same state as an honest worktree at that parent
// (plan 15.23). Commit times are never read.
// At first sight the files that differ from the start are recorded as edits of the session, from
// three sets kept apart so they cannot cancel (index against the start, work tree against the
// index, untracked), so a change made before the first hook saw the top (a Bash edit, a staged
// change, a commit past the boundary) is not hidden. When that listing cannot be made (more than
// MAX_FIRST_SIGHT_PATHS files, a git error, no HEAD in a repository that has history) the start is
// unknown and marked `incomplete`: every full Stop judged in that top blocks, whatever its edit list
// holds, since what changed there is not known (a stop_hook_active Stop accepts nothing there and ends the
// turn unverified with a warning). A transient git error pins nothing.
// One deadline per hook bounds the git calls here (startPinDeadline).

import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureSessionDir, getCurrentTurn, recordEdit } from './file-tracker';
import { snapshotMemo, spawnGit, type GitOptions, type GitResult } from './git-run';
import { realDeep } from './private-files';
import { MAX_STATE_BYTES, readRegular } from './safe-read';

export type StartRef =
  | { kind: 'commit'; head: string }
  | { kind: 'empty' }
  /** `incomplete`: what changed in the checkout before its first hook is not known either, so the
   *  edit list cannot be trusted to hold its changes (every full Stop in that top blocks). */
  | { kind: 'unknown'; reason: string; incomplete?: true };

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NULL_ID = /^0{40}(?:0{24})?$/;
const TIPS_FILE = 'start-tips.json';
/** Ref tips kept; more means no snapshot (a truncated list is never a complete one). */
const MAX_TIPS = 100_000;
/** Worktrees pinned at the session's start (and criteria baselines read); the others are pinned when first seen. */
const MAX_EAGER_TOPS = 64;
/** Paths that differ at a top's first sight; more makes its start unknown and incomplete. */
const MAX_FIRST_SIGHT_PATHS = 20_000;
/** One git call here: at most this, and never more than the hook's deadline has left. */
const GIT_LIMIT_MS = 5_000;
/** What each hook's start-pin git calls share (`startPinDeadline`): the timeouts are 15 s for SessionStart
 *  and Stop and 60 s for PostToolUse, and the Stop's own gates need their time too. */
export const START_PIN_BUDGET_MS = { sessionStart: 8_000, postToolUse: 8_000, stop: 6_000 } as const;
/** The coverage pin the first top's registration is read from (written by lib/changed-coverage.ts). */
const COVERAGE_PIN_FILE = 'coverage-pin.json';
/** The most output read to learn whether a repository holds any commit object (one line per object). */
const OBJECT_LIST_BYTES = 64 * 1024 * 1024;

const unknown = (reason: string, incomplete = false): StartRef => ({ kind: 'unknown', reason, ...(incomplete ? { incomplete: true as const } : {}) });

// ── One deadline per hook ───────────────────────────────────────────────────────────────────

let deadlineAt: number | null = null;

/** Starts the hook's one deadline for the git calls of this module: each call gets what is left, at
 *  most GIT_LIMIT_MS. Past it nothing is run: no snapshot at SessionStart (the safe fallback), a
 *  transient unknown at a first sight. Without a call to this (a library caller, a test) only the
 *  per-call limit applies. */
export function startPinDeadline(totalMs: number): void {
  deadlineAt = Date.now() + totalMs;
}

const timeLeft = (): number => (deadlineAt === null ? Infinity : deadlineAt - Date.now());

function git(cwd: string, args: readonly string[], opts: GitOptions = {}): GitResult {
  return spawnGit(cwd, args, { timeoutMs: GIT_LIMIT_MS, left: timeLeft, ...opts });
}

const answered = (r: GitResult): boolean => r.ran && !r.stalled && r.code !== -1;

// ── The worktree list, once per SessionStart ────────────────────────────────────────────────

let sharedLists: Map<string, GitResult> | null = null;

/** `fn` with one `git worktree list` per repository shared by every `listWorktrees` inside it (the
 *  SessionStart's note of the worktrees and the tip snapshot both read it). Nothing is kept outside. */
export function withSharedWorktreeList<T>(fn: () => T): T {
  if (sharedLists !== null) return fn();
  sharedLists = new Map();
  try {
    return fn();
  } finally {
    sharedLists = null;
  }
}

/** `git worktree list --porcelain` run from `dir`. */
export function listWorktrees(dir: string): GitResult {
  let key: string | null = null;
  if (sharedLists !== null) {
    const near = nearestGitTop(dir);
    key = near === null ? null : (fsDirs(near)?.common ?? null);
    const hit = key === null ? undefined : sharedLists.get(key);
    if (hit) return hit;
  }
  const r = git(dir, ['worktree', 'list', '--porcelain']);
  if (key !== null && r.code === 0 && !r.stalled) sharedLists?.set(key, r);
  return r;
}

// ── Identity ────────────────────────────────────────────────────────────────────────────────

/** The admin dir and the common git dir of the checkout at `top`, read from `.git` (no git call);
 *  null when `top` has no `.git` this can read. A linked worktree's `.git` is a file naming its
 *  admin dir `<common>/worktrees/<name>`. */
function fsDirs(top: string): { admin: string; common: string } | null {
  try {
    const dot = join(top, '.git');
    const st = lstatSync(dot);
    if (st.isDirectory()) {
      const admin = realpathSync(dot);
      return { admin, common: admin };
    }
    if (!st.isFile()) return null;
    const r = readRegular(dot, 4096, true);
    const m = typeof r === 'string' ? null : /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(r.text);
    if (!m) return null;
    const admin = realpathSync(resolve(top, m[1]!));
    const c = readRegular(join(admin, 'commondir'), 4096, true);
    // A `commondir` that is there and cannot be read says nothing, and a linked worktree's admin dir
    // (`<common>/worktrees/<name>`, which also has a `gitdir` file pointing back at its checkout) without
    // one is damaged: neither is a repository of its own. A separate git dir under a directory that happens
    // to be named `worktrees` has no `gitdir` file, so it stays a repository of its own.
    if (c === 'refused' || (c === 'absent' && basename(dirname(admin)) === 'worktrees' && readRegular(join(admin, 'gitdir'), 4096, true) !== 'absent')) return null;
    return { admin, common: typeof c === 'string' ? admin : realpathSync(resolve(admin, c.text.trim())) };
  } catch {
    return null;
  }
}

/** The common git dir of the checkout at `top`, read from its `.git` with no git call; null when that read fails. */
export function commonDirOf(top: string): string | null {
  return fsDirs(top)?.common ?? null;
}

type Probe = { kind: 'dirs'; admin: string; common: string } | { kind: 'none' } | { kind: 'unknown'; reason: string };

/** What `top` is: its git dirs (read from `.git`, else as git reports them), no repo, or unknown.
 *  Only git's own "not a git repository" for a path with no `.git` is no repo; git answering where
 *  the file read failed is trusted for the dirs only when it places the checkout at `top`. */
function probeDirs(top: string): Probe {
  const fs = fsDirs(top);
  if (fs) return { kind: 'dirs', ...fs };
  // English messages: "not a git repository" is read from the text, and git translates it (exit 128 alone is no evidence).
  const r = git(top, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cLocale: true });
  if (!answered(r)) return { kind: 'unknown', reason: 'git did not answer when asked what the checkout is' };
  if (r.code === 0) {
    const lines = r.out.trim().split('\n');
    if (lines.length !== 3 || !isAbsolute(lines[1]!) || !isAbsolute(lines[2]!)) return { kind: 'unknown', reason: 'git answered with something this cannot read when asked what the checkout is' };
    if (realDeep(lines[0]!) !== realDeep(top)) return { kind: 'unknown', reason: `git places the checkout at ${realDeep(lines[0]!)}, not at ${realDeep(top)}` };
    return { kind: 'dirs', admin: realDeep(lines[1]!), common: realDeep(lines[2]!) };
  }
  if (r.code === 128 && /not a git repository/i.test(r.err)) {
    let hasDot = true;
    try {
      lstatSync(join(top, '.git'));
    } catch (err) {
      hasDot = (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    return hasDot ? { kind: 'unknown', reason: 'it has a .git that git does not accept (corrupt, or not readable)' } : { kind: 'none' };
  }
  return { kind: 'unknown', reason: `git failed when asked what the checkout is (exit ${r.code})` };
}

export interface TopIdentity {
  /** Names the top's files in the session dir. */
  key: string;
  /** The top, canonical. */
  top: string;
  /** The git dir's identity; `nogit` outside a repo (never a key for a pin file). */
  id: string;
  /** The common git dir, canonical; absent outside a repo or when unknown. */
  common?: string;
  /** Set when git could not say what the checkout is: no pin is read or written for it. */
  unknown?: string;
}

/** The canonical top and its git dir's identity: a worktree removed and made again at the same
 *  path has a new admin dir, so another key and a pin file of its own (never another baseline: its
 *  start is the original one or none, `carryOver`). Reads `.git` without git; git is asked only when
 *  that read fails. */
export function topIdentity(top: string): TopIdentity {
  const canonical = realDeep(top);
  const p = probeDirs(top);
  let id = 'nogit';
  let common: string | undefined;
  let why: string | undefined;
  if (p.kind === 'dirs') {
    common = p.common;
    try {
      const st = statSync(p.admin);
      id = `${p.admin}|${st.ino}|${st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : 0}`;
    } catch {
      id = `${p.admin}|?`;
    }
  } else if (p.kind === 'unknown') {
    id = 'unknown';
    why = p.reason;
  }
  return { key: createHash('sha256').update(`${canonical}\0${id}`).digest('hex').slice(0, 16), top: canonical, id, ...(common ? { common } : {}), ...(why ? { unknown: why } : {}) };
}

/** The nearest dir at or above `cwd` that has a `.git`: the repo top, without asking git. */
export function nearestGitTop(cwd: string): string | null {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────

/** Writes `text` at `path` only when nothing is there: a hard link of a finished temp file never
 *  replaces another writer's file. True when this call made it. */
export function writeOnce(path: string, text: string): boolean {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** A session file's JSON, never through a link; 'absent' when there is none, 'bad' when it is not
 *  a regular file, too big, or not JSON. */
function readJsonFile(path: string): unknown | 'absent' | 'bad' {
  const r = readRegular(path, MAX_STATE_BYTES, true);
  if (r === 'absent') return 'absent';
  if (r === 'refused') return 'bad';
  try {
    return JSON.parse(r.text) as unknown;
  } catch {
    return 'bad';
  }
}

const startPinFile = (sessionId: string, key: string): string => join(ensureSessionDir(sessionId), `start-pin-${key}.json`);

/** Whether SessionStart ran for this session: its tip snapshot or any start pin is in the session
 *  dir. A coverage pin that is missing then was lost or removed, not never made. */
export function sessionStartRan(sessionId: string): boolean {
  try {
    const dir = ensureSessionDir(sessionId);
    return existsSync(join(dir, TIPS_FILE)) || readdirSync(dir).some((f) => /^start-pin-[0-9a-f]{16}\.json$/.test(f));
  } catch {
    return false;
  }
}

interface Tips {
  common: string;
  tips: string[];
  worktrees: { top: string; key: string }[];
}

function readTips(sessionId: string): Tips | null {
  const v = readJsonFile(join(ensureSessionDir(sessionId), TIPS_FILE)) as Partial<Tips> & { v?: number };
  if (!v || typeof v !== 'object' || v === null || v.v !== 1 || typeof v.common !== 'string') return null;
  if (!Array.isArray(v.tips) || !v.tips.every((t) => typeof t === 'string' && OBJECT_ID.test(t))) return null;
  const worktrees = Array.isArray(v.worktrees) ? v.worktrees.filter((w) => w && typeof w.top === 'string' && typeof w.key === 'string') : [];
  return { common: v.common, tips: v.tips, worktrees };
}

/** The worktrees that existed when the session started (empty for a session with no snapshot). */
export function worktreesAtStart(sessionId: string): { top: string; key: string }[] {
  try {
    return readTips(sessionId)?.worktrees ?? [];
  } catch {
    return [];
  }
}

interface Entry {
  v: 1;
  top: string;
  id: string;
  start: StartRef;
}

function validStart(s: unknown): s is StartRef {
  if (!s || typeof s !== 'object') return false;
  const k = (s as { kind?: unknown }).kind;
  if (k === 'empty') return true;
  if (k === 'commit') return typeof (s as { head?: unknown }).head === 'string' && OBJECT_ID.test((s as { head: string }).head);
  const inc = (s as { incomplete?: unknown }).incomplete;
  return k === 'unknown' && typeof (s as { reason?: unknown }).reason === 'string' && (inc === undefined || inc === true);
}

/** The pin file of this top and identity: the entry, 'absent', or 'bad' (unreadable, or not this top's). */
function readEntry(sessionId: string, who: TopIdentity): Entry | 'absent' | 'bad' {
  const v = readJsonFile(startPinFile(sessionId, who.key));
  if (v === 'absent' || v === 'bad') return v;
  const e = v as Partial<Entry>;
  return e && e.v === 1 && e.top === who.top && e.id === who.id && validStart(e.start) ? (e as Entry) : 'bad';
}

/** Whether this top already has a start pin (any content): a hook has nothing to pin for it. */
export function hasStartPin(sessionId: string, who: TopIdentity): boolean {
  try {
    return who.unknown === undefined && who.id !== 'nogit' && readEntry(sessionId, who) !== 'absent';
  } catch {
    return false;
  }
}

// ── The snapshot at the session's start ─────────────────────────────────────────────────────

interface Listed {
  top: string;
  head: string | null;
}

/** `git worktree list --porcelain`: the checkouts that exist (bare and prunable ones left out). */
function parseWorktrees(out: string): Listed[] {
  const list: Listed[] = [];
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined || !isAbsolute(path) || lines.includes('bare') || lines.some((l) => l.startsWith('prunable'))) continue;
    if (!existsSync(path)) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length).trim() ?? '';
    list.push({ top: path, head: OBJECT_ID.test(head) && !NULL_ID.test(head) ? head : null });
  }
  return list;
}

/** Whether the object store of the repository at `common` holds no commit object (true), some
 *  (false), or git cannot say (null: a failure, the output cut, alternates that hold objects this
 *  list does not show). */
function noCommitObjects(top: string, common: string): boolean | null {
  if (existsSync(join(common, 'objects', 'info', 'alternates'))) return null;
  const r = git(top, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)'], { maxBuffer: OBJECT_LIST_BYTES });
  if (!answered(r) || r.code !== 0) return null;
  return !/(?:^|\n)commit(?:\n|$)/.test(r.out);
}

/** SessionStart, the session's first: the frozen tips and the pins of the worktrees that exist now.
 *  Written once; a session that already has either is left as it is (a resume never refreshes
 *  them). Best-effort: nothing is written on any failure, a truncation or a deadline, and a session
 *  with no snapshot treats every top but its first as unknown. */
export function takeStartSnapshot(sessionId: string, top: string): void {
  try {
    const dirs = probeDirs(top);
    if (dirs.kind !== 'dirs') return;
    const dir = ensureSessionDir(sessionId);
    if (existsSync(join(dir, TIPS_FILE))) return;
    const refs = git(top, ['for-each-ref', '--format=%(objectname) %(objecttype) %(*objectname) %(*objecttype)'], { maxBuffer: 32 * 1024 * 1024 });
    const wts = listWorktrees(top);
    if (refs.code !== 0 || !answered(refs) || wts.code !== 0 || !answered(wts)) return;
    const tips = new Set<string>();
    for (const line of refs.out.split('\n')) {
      const [id, type, peeled, peeledType] = line.split(' ');
      if (type === 'commit' && OBJECT_ID.test(id ?? '')) tips.add(id!);
      else if (peeledType === 'commit' && OBJECT_ID.test(peeled ?? '')) tips.add(peeled!);
      else if (type === 'tag' && peeledType === 'tag') return; // a tag of a tag: its commit is not listed, so the set is not complete
    }
    const listed = parseWorktrees(wts.out);
    for (const w of listed) if (w.head !== null) tips.add(w.head);
    if (tips.size > MAX_TIPS) return;
    const pinned: { top: string; key: string }[] = [];
    for (const w of listed.slice(0, MAX_EAGER_TOPS)) {
      const who = topIdentity(w.top);
      if (who.unknown !== undefined || who.id === 'nogit') continue; // pinned when first seen
      // No commit at its HEAD: empty only when the whole tip set is (the session started with no commit at all).
      const start: StartRef = w.head !== null ? { kind: 'commit', head: w.head } : tips.size === 0 ? { kind: 'empty' } : unknown('its branch has no commit although the repository has commits');
      writeOnce(startPinFile(sessionId, who.key), JSON.stringify({ v: 1, top: who.top, id: who.id, start } satisfies Entry));
      pinned.push({ top: who.top, key: who.key });
    }
    // Last: with no tips file every top but the first reads as unknown, never as partly known.
    writeOnce(join(dir, TIPS_FILE), JSON.stringify({ v: 1, common: dirs.common, tips: [...tips], worktrees: pinned }));
  } catch {
    // best-effort: no snapshot
  }
}

// ── A top's start ───────────────────────────────────────────────────────────────────────────

/** The session's start for the checkout at `top`: its pin, or (first sight) the pin made now from the
 *  frozen tips. Memoized for one Stop. Never throws; an error is an unknown start. */
export function topStart(sessionId: string, top: string): StartRef {
  return snapshotMemo(`start-pin\0${sessionId}\0${top}`, () => {
    try {
      return computeTopStart(sessionId, top);
    } catch (err) {
      return unknown(`its start could not be read (${String(err).slice(0, 120)})`, true);
    }
  });
}

function computeTopStart(sessionId: string, top: string): StartRef {
  const who = topIdentity(top);
  // Git could not say what this is: asked again next time, and what changed there is not known meanwhile.
  if (who.unknown !== undefined) return unknown(`it could not be told what the checkout is (${who.unknown})`, true);
  // Outside a repo: nothing to compare with, and never pinned (a repo made here later is another identity).
  // But no git where the session pinned a checkout is a hidden or removed .git, not an unborn repository.
  if (who.id === 'nogit') {
    const gone = earlier(sessionId, who, readTips(sessionId));
    return gone.starts.length + gone.lost.length > 0 ? unknown('it has no git directory now, although the session pinned a checkout at that path (a hidden or removed .git)', true) : { kind: 'empty' };
  }
  const known = readEntry(sessionId, who); // the hit path reads no other pin
  if (known !== 'absent' && known !== 'bad') return known.start;
  if (known === 'bad') return unknown('its recorded start is unreadable');
  const tips = readTips(sessionId); // none: a session from before v0.36.7, or its snapshot failed
  // Listed at the session's start, so its pin was made then: a missing one is no first sight.
  if (tips?.worktrees.some((w) => w.key === who.key)) return unknown('its start pin, made when the session started, is missing', true);
  const before = earlier(sessionId, who, tips);
  if (before.starts.length + before.lost.length > 0) return carryOver(sessionId, top, who, tips, before);
  const found = discover(top, who, tips);
  if (found.dirty === null) return found.start; // a git error: not pinned, asked again next time
  if (!recordChanges(sessionId, top, found.dirty)) return unknown('the changes already made in it could not be recorded', true);
  writeOnce(startPinFile(sessionId, who.key), JSON.stringify({ v: 1, top: who.top, id: who.id, start: found.start } satisfies Entry));
  const winner = readEntry(sessionId, who);
  return winner === 'absent' || winner === 'bad' ? found.start : winner.start;
}

/** The first-sight changes count as the session's own, even with no edit-log entry (a Bash edit, a
 *  commit). False when they could not be recorded. */
function recordChanges(sessionId: string, top: string, dirty: readonly string[]): boolean {
  try {
    const turn = getCurrentTurn(sessionId);
    for (const rel of dirty) {
      const abs = join(top, rel);
      let mtime: number | undefined;
      try {
        mtime = statSync(abs).mtimeMs;
      } catch {
        mtime = undefined;
      }
      recordEdit(sessionId, abs, turn, undefined, mtime);
    }
    return true;
  } catch {
    return false;
  }
}

interface Earlier {
  /** Keys of the other identities registered there. */
  keys: string[];
  starts: StartRef[];
  /** A registration the session made there that is missing or unreadable now. */
  lost: string[];
}

/** What the session registered at `who`'s path under another identity: the first top's coverage pin,
 *  the start pins in the session dir, and the worktrees the snapshot lists (a listed one whose pin is
 *  gone or unreadable is lost). For a checkout with no git, also at a path above it: git finds the
 *  repository from a subdirectory, so a checkout under a pinned top that has none lost its `.git`. */
function earlier(sessionId: string, who: TopIdentity, tips: Tips | null): Earlier {
  const out: Earlier = { keys: [], starts: [], lost: [] };
  const above = who.id === 'nogit';
  const at = (p: unknown): p is string => typeof p === 'string' && (p === who.top || (above && who.top.startsWith(p.endsWith(sep) ? p : p + sep)));
  const dir = ensureSessionDir(sessionId);
  const cp = readJsonFile(join(dir, COVERAGE_PIN_FILE)) as { top?: unknown; identity?: unknown; head?: unknown } | 'absent' | 'bad';
  if (typeof cp === 'object' && cp !== null && typeof cp.top === 'string' && at(realDeep(cp.top)) && typeof cp.identity === 'string' && cp.identity !== who.key) {
    out.keys.push(cp.identity);
    if (typeof cp.head === 'string' && OBJECT_ID.test(cp.head)) out.starts.push({ kind: 'commit', head: cp.head });
    else if (cp.head === null) out.starts.push({ kind: 'empty' });
    else out.lost.push('the coverage pin has no start commit');
  }
  for (const f of readdirSync(dir)) {
    const m = /^start-pin-([0-9a-f]{16})\.json$/.exec(f);
    if (!m || m[1] === who.key) continue;
    const e = readJsonFile(join(dir, f)) as Partial<Entry> | 'absent' | 'bad';
    if (typeof e !== 'object' || e === null || e.v !== 1 || !at(e.top) || !validStart(e.start)) continue;
    out.keys.push(m[1]!);
    out.starts.push(e.start);
  }
  for (const w of tips?.worktrees ?? []) if (at(w.top) && w.key !== who.key && !out.keys.includes(w.key)) out.lost.push(`the start pin of ${w.top} is missing or unreadable`);
  return out;
}

/** The keys of the identities the session registered at `who`'s path before this one (empty: none, or unreadable). */
export function earlierKeys(sessionId: string, who: TopIdentity): string[] {
  try {
    return earlier(sessionId, who, readTips(sessionId)).keys;
  } catch {
    return [];
  }
}

/** A checkout made again at a path the session had pinned (its git dir has another identity: a worktree
 *  removed and added, a `.git` copied or replaced). Its HEAD tells nothing about where the session
 *  started, forward or back: a session commit would launder a deletion, a reset would move the baseline
 *  to an older commit. The original start stays when it still holds: the checkout is in the repository
 *  the session started in (the snapshot's canonical common git dir) and the start commit is readable.
 *  Otherwise the start is unknown and incomplete. The files in which the checkout's commits differ from
 *  the original start count as the session's changes (`committedDifferences`, `recordChanges`); the
 *  index, the work tree and untracked files are not listed (the user's work in progress from before the
 *  session is not the session's). The result is pinned for the new identity, except when git did not
 *  answer. */
function carryOver(sessionId: string, top: string, who: TopIdentity, tips: Tips | null, before: Earlier): StartRef {
  const lost = (reason: string) => {
    const start = unknown(`the checkout at this path was made again and ${reason}`, true);
    writeOnce(startPinFile(sessionId, who.key), JSON.stringify({ v: 1, top: who.top, id: who.id, start } satisfies Entry));
    return start;
  };
  const first = before.starts[0];
  if (before.lost.length > 0 || first === undefined) return lost('a start the session pinned there is missing or unreadable');
  if (!before.starts.every((s) => sameStart(s, first))) return lost('the starts the session pinned there disagree');
  if (first.kind === 'unknown') return lost(`its earlier start was unknown (${first.reason})`);
  if (tips === null || who.common !== tips.common) return lost('it is not in the repository the session started in (or the session has no snapshot of that)');
  if (first.kind === 'commit') {
    const r = git(top, ['rev-parse', '--verify', '-q', `${first.head}^{commit}`]);
    if (!answered(r)) return unknown('git did not answer when asked whether the start commit is still in the checkout', true); // asked again, pinned nowhere
    if (r.code !== 0) return lost(`its original start commit ${first.head.slice(0, 12)} is not in it`);
  }
  // What the new checkout's commits differ from the original start in counts as the session's changes (a commit
  // made before the git dir was made again, a worktree added at a newer commit). The index, the work tree and
  // the untracked files do not: the session's hooks followed the checkout (or, for the first top, the user's own
  // work in progress was there before the session), so the edit log has what the session wrote.
  // A listing that fails leaves what changed unknown (asked again); one over the cap is pinned unknown.
  const dirty = committedDifferences(top, first);
  if (dirty === null) return unknown('git could not list the files that differ from the original start', true);
  if (dirty === 'many') return lost(`more than ${MAX_FIRST_SIGHT_PATHS} files differ from its original start`);
  if (!recordChanges(sessionId, top, dirty)) return unknown('the changes already made in it could not be recorded', true);
  writeOnce(startPinFile(sessionId, who.key), JSON.stringify({ v: 1, top: who.top, id: who.id, start: first } satisfies Entry));
  const winner = readEntry(sessionId, who);
  return winner === 'absent' || winner === 'bad' ? first : winner.start;
}

/** The repo-relative paths in which HEAD differs from the carried-over start (`diff --name-only -z <start> HEAD`,
 *  renames off; for an empty start, the files of HEAD). Null when git fails or ran out of time; 'many' past the cap. */
function committedDifferences(top: string, start: StartRef): string[] | null | 'many' {
  const limit = { maxBuffer: 32 * 1024 * 1024, cLocale: true };
  let r: GitResult;
  if (start.kind === 'commit') r = git(top, ['diff', '--name-only', '-z', '--no-renames', '--ignore-submodules', '--end-of-options', start.head, 'HEAD', '--'], limit);
  else {
    r = git(top, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], limit);
    // An unborn HEAD has no files; any other failure is no answer.
    if (r.code === 128 && answered(r) && /not a valid object name HEAD/i.test(r.err)) return [];
  }
  if (!answered(r) || r.code !== 0) return null;
  const paths = r.out.split('\0').filter((p) => p !== '');
  return paths.length > MAX_FIRST_SIGHT_PATHS ? 'many' : paths;
}

/** Relates the checkout's HEAD to the frozen tips. `dirty`: the repo-relative paths that differ from
 *  the start now, or null when git failed or ran out of time (the answer is then not pinned). */
function discover(top: string, who: TopIdentity, tips: Tips | null): { start: StartRef; dirty: string[] | null } {
  const transient = (reason: string) => ({ start: unknown(reason, true), dirty: null });
  const common = who.common!; // a repo: topIdentity gave no `unknown` and was not `nogit`
  const sameRepo = tips !== null && common === tips.common;
  const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!answered(head)) return transient('git did not answer');
  let start: StartRef;
  let base: string | null; // what the first-sight listing compares the index with (null: no commit)
  if (head.code !== 0) {
    base = null;
    if (sameRepo && tips.tips.length === 0) start = { kind: 'empty' }; // the session started with no commit at all
    else if (sameRepo) return { start: unknown('its HEAD does not resolve to a commit although the repository has history', true), dirty: [] };
    else {
      const none = noCommitObjects(top, common);
      if (none === null) return transient('git could not tell whether its repository holds any commit');
      if (!none) return { start: unknown('its HEAD does not resolve to a commit although the repository holds commits', true), dirty: [] };
      start = { kind: 'empty' };
    }
  } else {
    const h = head.out.trim();
    base = h;
    if (tips === null) start = unknown('the session has no start snapshot (it began before v0.36.7, or the snapshot could not be taken), so only the checkout it started in has a known start');
    else if (!sameRepo) start = unknown(`it belongs to another repository (${common}) than the one the session started in, and it has history`);
    else {
      const input = `${h}\n${tips.tips.map((t) => `^${t}\n`).join('')}`;
      const r = git(top, ['rev-list', '--boundary', '--stdin'], { input, maxBuffer: 8 * 1024 * 1024 });
      if (!answered(r) || r.code !== 0) return transient('git could not relate its HEAD to the commits the session started with');
      const lines = r.out.split('\n').filter((l) => l !== '');
      const boundaries = lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
      const fresh = lines.length - boundaries.length;
      if (fresh === 0) start = { kind: 'commit', head: h };
      else if (boundaries.length === 1 && OBJECT_ID.test(boundaries[0]!)) start = { kind: 'commit', head: boundaries[0]! };
      else if (boundaries.length === 0) start = unknown('its history is unrelated to the commits the session started with (an orphan or a separate line)');
      else start = unknown(`its HEAD merges ${boundaries.length} lines that existed before the session, so no single commit is where it started`);
    }
    // The listing below compares with the start when there is one; with none, with HEAD.
    if (start.kind === 'commit') base = start.head;
  }
  const dirty = dirtyPaths(top, base);
  if (dirty === null) return transient('git could not list the files that differ from its start');
  if (dirty === 'many') return { start: unknown(`more than ${MAX_FIRST_SIGHT_PATHS} files differ from its start at first sight`, true), dirty: [] };
  return { start, dirty };
}

/** The repo-relative paths that differ from `base` (a commit; null: none yet), from three sets kept
 *  apart: the index against `base`, the work tree against the index, and the untracked files that
 *  are not ignored. One set cannot hide another: a staged change reverted in the work tree is in
 *  both of the first two. Null when git fails; 'many' past the cap. */
function dirtyPaths(top: string, base: string | null): string[] | null | 'many' {
  const limit = { maxBuffer: 32 * 1024 * 1024 };
  const list = (args: string[]): string[] | null => {
    const r = git(top, args, limit);
    return r.code === 0 && answered(r) ? r.out.split('\0').filter((p) => p !== '') : null;
  };
  const sets = [
    base !== null ? list(['diff', '--cached', '--name-only', '-z', '--no-renames', '--ignore-submodules', '--end-of-options', base, '--']) : list(['ls-files', '-z', '--cached']),
    list(['diff', '--name-only', '-z', '--no-renames', '--ignore-submodules', '--']),
    list(['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--exclude-standard']),
  ];
  const out = new Set<string>();
  for (const set of sets) {
    if (set === null) return null;
    for (const p of set) out.add(p);
  }
  return out.size > MAX_FIRST_SIGHT_PATHS ? 'many' : [...out];
}

// ── Nested worktrees (rule 11) ──────────────────────────────────────────────────────────────

/** The linked worktrees of `top`'s repository that lie inside it and hold some of `files`, with
 *  the start of each. Only those the hooks do not resolve as a project of their own (not under
 *  `.claude/worktrees`, not noted at the session's start): a Stop run in `top` judges their files
 *  with `top`'s start. Files only; no git call except a first sight. */
export function nestedWorktreeStarts(sessionId: string, top: string, files: readonly string[], resolvedBySession: (wt: string) => boolean): { dir: string; start: StartRef }[] {
  const mine = fsDirs(top);
  if (mine === null) return [];
  const seenDirs = new Map<string, string | null>();
  const found = new Map<string, StartRef>();
  for (const file of files) {
    const rel = relative(top, resolve(file));
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    // From the file's dir up to (not including) the top: the nearest linked worktree.
    for (let d = dirname(resolve(file)); d !== top && d.startsWith(top + sep); d = dirname(d)) {
      let nested = seenDirs.get(d);
      if (nested === undefined) {
        nested = null;
        try {
          if (lstatSync(join(d, '.git')).isFile()) {
            const theirs = fsDirs(d);
            if (theirs !== null && theirs.common === mine.common && theirs.admin !== mine.admin && !resolvedBySession(d)) nested = d;
          }
        } catch {
          nested = null;
        }
        seenDirs.set(d, nested);
      }
      if (nested !== null) {
        if (!found.has(nested)) found.set(nested, topStart(sessionId, nested));
        break;
      }
    }
  }
  return [...found].map(([dir, start]) => ({ dir, start }));
}

/** Whether two starts are the same point (a commit, or both the empty tree). */
export function sameStart(a: StartRef, b: StartRef): boolean {
  return (a.kind === 'commit' && b.kind === 'commit' && a.head === b.head) || (a.kind === 'empty' && b.kind === 'empty');
}
