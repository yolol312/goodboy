// Build-output copies need no layer-1 test of their own (issue #32, plan §15.21).
//
// A red/green check often copies a tested source file into a git-ignored build dir
// (`cp src/app.js target/app.js`). The write sweep records the copy as an edit, but it is not in
// a record's tree (an ignored file is not in `git add -A`), so the changed-line check reported
// it as lines no test ran, though its bytes are those of a tested source file. The copy leaves
// the layer-1 edit set when every condition holds; the review edit set keeps it. Any read or
// compare error keeps the obligation, and every Stop decides again.
//
//   - a directory segment of the copy's path (not its file name) is `target` or `build`;
//   - the copy is untracked and git-ignored, and the ignore rule that decides it comes from a
//     `.gitignore` the session did not write: a relative path inside the canonical repo top, named
//     `.gitignore`, a regular single-link file with no link on its path, tracked at the session's
//     start HEAD with a regular blob mode and unchanged since (its bytes are that blob's), and the
//     rule is no `!` pattern. The ignore check runs with `core.excludesFile` emptied, so no global
//     or configured excludes file decides; `.git/info/exclude`, a new, untracked or edited
//     `.gitignore` never qualifies;
//   - the copy and the source are distinct regular single-link files inside the repo with no
//     link on either path;
//   - the source is tracked, in the session's change set (a file this session changed, in any
//     turn, that is still subject to layer 1: the red/green run copies it again in a later turn,
//     after the Stop that accepted its test), and its bytes now equal the copy's;
//   - neither is a `.env`, `.env.*` or `*.env` file.
//
// Cost. A git spawn is 6 ms with the real binary and 22-39 ms through the macOS /usr/bin/git shim
// (measured in v0.36.6, plan §15.22), and the Stop hook's 15 s timeout skips the test and review
// gates when it fires. So the checks are batched (one `ls-files` for all candidates, one
// `check-ignore` for all of them, one `ls-files` for the candidate sources), at most
// MAX_BUILD_COPY_CANDIDATES candidates are examined, and the whole call has a wall-clock budget
// (BUILD_COPY_BUDGET_MS) that every step shares as one deadline: each git spawn gets only what is
// left of it (none when nothing is), and the file system scans and the source loop check it. A
// candidate's sources are found by size before any file is read, so a file no source can equal is
// never read; the bytes read and the bytes kept are capped (MAX_BUILD_COPY_READ_BYTES,
// MAX_BUILD_COPY_CACHED_BYTES), and so is the number of sources looked at
// (MAX_BUILD_COPY_SOURCES). A candidate past a cap, the budget or a git failure stays in the layer-1
// set (fail closed), and `onSkipped` says how many and why, for the gate log: every candidate left
// undecided is counted once, under the one cause that stopped it (the candidate cap, the byte
// budget, the time budget, or a git error), however far along it was when the call stopped.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { blobAtCommit, differFromBase, hookGit, relInside } from './changed-coverage';

/** The largest file whose bytes are compared. */
const MAX_COPY_BYTES = 16 * 1024 * 1024;

/** Candidates examined per call; the rest stay in the layer-1 set. */
export const MAX_BUILD_COPY_CANDIDATES = 200;

/** Wall-clock budget of one call, well under the Stop hook's 15 s with room for its other work. */
export const BUILD_COPY_BUDGET_MS = 3_000;

/** Byte-equal sources kept per copy for the tracked check (many identical small files). */
const MAX_EQUAL_SOURCES = 8;

/** Bytes read from files in one call (copies and sources), and bytes of sources kept for the
 *  copies after the first one that has the same size. */
const MAX_BUILD_COPY_READ_BYTES = 64 * 1024 * 1024;
const MAX_BUILD_COPY_CACHED_BYTES = 32 * 1024 * 1024;

/** Files of the session's change set looked at for a source; a source past it is not found, and
 *  its copy stays in the layer-1 set. */
const MAX_BUILD_COPY_SOURCES = 2_000;

const BUILD_SEGMENTS = new Set(['target', 'build']);

/** Why candidates were left undecided: over the candidate cap, over the byte cap, out of time, or
 *  a git call that failed (not for want of time). */
export type SkipReason = 'cap' | 'bytes' | 'budget' | 'git';

export interface BuildCopyLimits {
  maxCandidates?: number;
  budgetMs?: number;
  /** Bytes read from files in all, and bytes of sources kept (a test's; the defaults are the
   *  MAX_BUILD_COPY_ constants). */
  maxReadBytes?: number;
  maxCachedBytes?: number;
  /** The clock in ms (a test's). */
  now?: () => number;
  /** Called with the number of candidates left undecided, and why. Each undecided candidate is
   *  counted in exactly one call. */
  onSkipped?: (count: number, reason: SkipReason) => void;
}

/** `.env`, `.env.*` and `*.env`: secrets, never treated as a build copy or its source. */
function isEnvName(rel: string): boolean {
  const b = basename(rel);
  return b === '.env' || b.startsWith('.env.') || b.endsWith('.env');
}

/** The files of `files` that are inside `top`: abs -> rel. */
function relsOf(top: string, files: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) {
    const rel = relInside(top, f);
    if (rel !== null) m.set(f, rel);
  }
  return m;
}

/** The size of a regular file with one link, below `top`, with no symbolic link on its path
 *  (checked from the top down); null for anything else and on any error. */
export function plainSize(top: string, rel: string): number | null {
  try {
    const dirs = rel.split('/');
    const leaf = dirs.pop()!;
    let cur = resolve(top);
    for (const d of dirs) {
      cur = join(cur, d);
      if (!lstatSync(cur).isDirectory()) return null; // a link is no directory for lstat
    }
    const st = lstatSync(join(cur, leaf));
    return st.isFile() && st.nlink === 1 ? st.size : null;
  } catch {
    return null;
  }
}

type Git = (args: string[], input?: string) => { code: number; out: string };

/** The files of `rels` that git tracks, in one call; null when git cannot say. Literal
 *  pathspecs: a name with `*` or `:` is that name, never a pattern or a pathspec magic. */
function trackedAmong(git: Git, rels: readonly string[]): Set<string> | null {
  const r = git(['--literal-pathspecs', 'ls-files', '-z', '--', ...rels]);
  return r.code === 0 ? new Set(r.out.split('\0')) : null;
}

/** The largest `.gitignore` compared with its start blob. */
const MAX_GITIGNORE_BYTES = 1024 * 1024;

/** Whether a `.gitignore` named by git (a path relative to `top`) is one the session did not
 *  write: inside the canonical top, a plain file, tracked at `head` as a regular blob, and its
 *  bytes still that blob's. Anything else is a no (also when `left`, the time left of the call's
 *  deadline, runs out: no git call is started then). */
function pristineGitignore(canon: string, top: string, head: string, source: string, left: () => number): boolean {
  if (basename(source) !== '.gitignore') return false;
  // A relative, normalized path inside the canonical top: an absolute name (a global file), a
  //   `..` or `.` segment or a doubled slash does not survive the round trip.
  if (relInside(canon, join(canon, source)) !== source) return false;
  if (plainSize(canon, source) === null) return false;
  // Tracked at HEAD as a regular file (blobAtCommit refuses a symlink or a gitlink mode).
  if (blobAtCommit(top, head, source, MAX_GITIGNORE_BYTES, left) === null) return false;
  // Its content now is that blob's: differFromBase hashes the file as git would store it.
  return differFromBase(top, head, [source], left).size === 0;
}

interface IgnoreRow {
  source: string;
  line: string;
  pattern: string;
}

/** The ignore rule of each ignored path of `rels`, in one `git check-ignore -z -v --stdin` call
 *  (it prints `<source> NUL <line> NUL <pattern> NUL <path> NUL` per ignored path and nothing for
 *  the others; the fields are taken apart on the NULs, never on `:`); null when git fails. The
 *  `core.excludesFile` setting is emptied: a relative one that names a tracked `.gitignore` could
 *  otherwise decide. `check-ignore` refuses `--literal-pathspecs`, so the caller keeps names that
 *  start with `:` (pathspec magic) out of `rels`. */
function ignoreRules(git: Git, rels: readonly string[]): Map<string, IgnoreRow> | null {
  const r = git(['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-z', '-v', '--stdin'], rels.map((x) => `${x}\0`).join(''));
  if (r.code !== 0 && r.code !== 1) return null; // 1: none ignored
  const f = r.out.split('\0');
  if (f.length % 4 !== 1 || f[f.length - 1] !== '') return null;
  const rows = new Map<string, IgnoreRow>();
  for (let i = 0; i + 3 < f.length; i += 4) rows.set(f[i + 3]!, { source: f[i]!, line: f[i + 1]!, pattern: f[i + 2]! });
  return rows;
}


type Pair = [abs: string, rel: string];

/** What every step of one call shares: the repo, the start HEAD, git under the call's deadline, and
 *  the candidates not yet decided (by repo-relative path), so that whatever stops the call counts
 *  each of them once. */
interface Call {
  top: string;
  canon: string;
  head: string;
  git: Git;
  left: () => number;
  undecided: Set<string>;
  limits: BuildCopyLimits;
}

/** Stops the call: the candidates still undecided are reported once, under `reason`. */
function abandon(c: Call, reason: SkipReason): null {
  if (c.undecided.size > 0) c.limits.onSkipped?.(c.undecided.size, reason);
  c.undecided.clear();
  return null;
}

/** True, the call stopped, when the budget is gone. */
function spent(c: Call): boolean {
  if (c.left() > 0) return false;
  abandon(c, 'budget');
  return true;
}

/** A batch git call returned nothing: out of time (it was cut off at what was left), or a git error. */
function gitFailed(c: Call): null {
  return abandon(c, c.left() > 0 ? 'git' : 'budget');
}

/** The cheap file system checks, under the deadline, then the candidate cap (so a deleted file takes
 *  no slot): the candidates that are plain files, with the size of each (no file is read before the
 *  sizes are compared). */
function plainCandidates(c: Call, candidates: readonly Pair[]): { pending: Pair[]; size: Map<string, number> } | null {
  const size = new Map<string, number>();
  const pending: Pair[] = [];
  for (const cand of candidates) {
    if (spent(c)) return null;
    const n = plainSize(c.top, cand[1]);
    if (n === null) {
      c.undecided.delete(cand[1]);
      continue;
    }
    size.set(cand[1], n);
    pending.push(cand);
  }
  const cap = c.limits.maxCandidates ?? MAX_BUILD_COPY_CANDIDATES;
  if (pending.length > cap) {
    const over = pending.slice(cap);
    for (const [, rel] of over) c.undecided.delete(rel);
    c.limits.onSkipped?.(over.length, 'cap');
  }
  return { pending: pending.slice(0, cap), size };
}

/** One listing for every candidate: a tracked file under build/ or target/ is no copy. */
function untrackedAmong(c: Call, pending: readonly Pair[]): Pair[] | null {
  if (pending.length === 0 || spent(c)) return null;
  const tracked = trackedAmong(c.git, pending.map(([, rel]) => rel));
  if (tracked === null) return gitFailed(c);
  for (const rel of tracked) c.undecided.delete(rel);
  return pending.filter(([, rel]) => !tracked.has(rel));
}

/** One ignore check for every candidate, then one verdict per deciding `.gitignore`: the candidates
 *  an unchanged, committed `.gitignore` ignores. */
function ignoredByPristine(c: Call, pending: readonly Pair[]): Pair[] | null {
  if (pending.length === 0 || spent(c)) return null;
  const rules = ignoreRules(c.git, pending.map(([, rel]) => rel));
  if (rules === null) return gitFailed(c);
  const verdicts = new Map<string, boolean>();
  const qualifying: Pair[] = [];
  for (const [abs, rel] of pending) {
    const row = rules.get(rel);
    if (row !== undefined && /^\d+$/.test(row.line) && row.pattern !== '' && !row.pattern.startsWith('!')) {
      let ok = verdicts.get(row.source);
      if (ok === undefined) {
        if (spent(c)) return null;
        ok = pristineGitignore(c.canon, c.top, c.head, row.source, c.left);
        // A verdict that ran out of time is no verdict: the candidates are undecided, not refused.
        if (!ok && c.left() <= 0) return abandon(c, 'budget');
        verdicts.set(row.source, ok);
      }
      if (ok) {
        qualifying.push([abs, rel]);
        continue;
      }
    }
    c.undecided.delete(rel);
  }
  return qualifying.length === 0 ? null : qualifying;
}

/** The session's change set, bucketed by file size, and only by the sizes a qualifying copy has: a
 *  source of another size is never read (`plainSize` says the path is a regular file: never a FIFO
 *  or a device). */
function sourcesBySize(c: Call, wanted: ReadonlySet<number>, files: readonly string[]): Map<number, Pair[]> | null {
  const bySize = new Map<number, Pair[]>();
  const sources = [...relsOf(c.top, files)].filter(([, rel]) => !isEnvName(rel)).slice(0, MAX_BUILD_COPY_SOURCES);
  for (const [source, sourceRel] of sources) {
    if (spent(c)) return null;
    const size = plainSize(c.top, sourceRel);
    if (size === null || !wanted.has(size)) continue;
    const bucket = bySize.get(size) ?? [];
    bucket.push([source, sourceRel]);
    bySize.set(size, bucket);
  }
  return bySize;
}

/** Reads files under the call's byte caps, keeping sources for the next copy of their size. `over`
 *  turns true when a read was refused for the byte cap (the call stops then). */
function byteReader(limits: BuildCopyLimits): { read: (abs: string, size: number, keep: boolean) => Buffer | null; over: () => boolean } {
  const maxRead = limits.maxReadBytes ?? MAX_BUILD_COPY_READ_BYTES;
  const maxCached = limits.maxCachedBytes ?? MAX_BUILD_COPY_CACHED_BYTES;
  let readBytes = 0;
  let cachedBytes = 0;
  let over = false;
  const kept = new Map<string, Buffer>();
  const read = (abs: string, size: number, keep: boolean): Buffer | null => {
    const known = kept.get(abs);
    if (known) return known;
    if (size > MAX_COPY_BYTES) return null;
    if (readBytes + size > maxRead) {
      over = true;
      return null;
    }
    try {
      const b = readFileSync(abs);
      readBytes += b.length;
      if (keep && cachedBytes + b.length <= maxCached) {
        kept.set(abs, b);
        cachedBytes += b.length;
      }
      return b;
    } catch {
      return null;
    }
  };
  return { read, over: () => over };
}

/** For each qualifying copy, the sources of the same size whose bytes equal its own (at most
 *  MAX_EQUAL_SOURCES). A copy with none is decided (no copy); one with some waits for the tracked
 *  check of its sources. Stops for the budget or the byte cap. */
function byteEqualSources(c: Call, qualifying: readonly Pair[], size: ReadonlyMap<string, number>, bySize: ReadonlyMap<number, Pair[]>): Map<string, { copy: string; found: Pair[] }> | null {
  const { read, over } = byteReader(c.limits);
  const equal = new Map<string, { copy: string; found: Pair[] }>(); // by the copy's rel
  for (const [copy, copyRel] of qualifying) {
    if (spent(c)) return null;
    const n = size.get(copyRel)!;
    const sameSize = (bySize.get(n) ?? []).filter(([source, sourceRel]) => source !== copy && sourceRel !== copyRel);
    const mine = sameSize.length === 0 ? null : read(copy, n, false);
    if (mine === null && over()) return abandon(c, 'bytes');
    const found: Pair[] = [];
    for (const [source, sourceRel] of mine === null ? [] : sameSize) {
      if (found.length >= MAX_EQUAL_SOURCES) break;
      if (spent(c)) return null;
      const theirs = read(source, n, true);
      if (theirs === null && over()) return abandon(c, 'bytes');
      if (theirs !== null && mine!.equals(theirs)) found.push([source, sourceRel]);
    }
    if (found.length > 0) equal.set(copyRel, { copy, found });
    else c.undecided.delete(copyRel); // no source of its size, unreadable, or no equal one: no copy
  }
  return equal;
}

/** The copy -> source pairs (absolute paths) among `edits` (absolute files of the layer-1 edit
 *  set). `changeSet` lists the session's change set the source must be in (absolute files; read
 *  only when a copy qualifies by its path); it defaults to `edits`. Empty when `head` (the
 *  session's start HEAD) is unknown. */
export function buildCopies(edits: readonly string[], top: string, head: string | null | undefined, changeSet?: () => readonly string[], limits: BuildCopyLimits = {}): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (typeof head !== 'string' || edits.length === 0) return out;
    const now = limits.now ?? Date.now;
    const t0 = now();
    const budget = limits.budgetMs ?? BUILD_COPY_BUDGET_MS;
    // One deadline for every step: git spawns, file system scans and the source loop.
    const left = (): number => budget - (now() - t0);
    const underBuild = ([, rel]: Pair) => rel.split('/').slice(0, -1).some((s) => BUILD_SEGMENTS.has(s)) && !isEnvName(rel) && !rel.startsWith(':');
    const candidates = [...relsOf(top, edits)].filter(underBuild);
    if (candidates.length === 0) return out;
    const c: Call = { top, canon: realpathSync(top), head, git: (args, input) => hookGit(top, args, input, budget, left), left, undecided: new Set(candidates.map(([, rel]) => rel)), limits };

    const plain = plainCandidates(c, candidates);
    const untracked = plain && untrackedAmong(c, plain.pending);
    const qualifying = untracked && ignoredByPristine(c, untracked);
    if (!plain || !qualifying) return out;
    const wanted = new Set(qualifying.map(([, rel]) => plain.size.get(rel)!));
    const bySize = sourcesBySize(c, wanted, changeSet ? changeSet() : edits);
    const equal = bySize && byteEqualSources(c, qualifying, plain.size, bySize);
    if (!equal || equal.size === 0 || spent(c)) return out;

    // One listing for the candidate sources: the source must be tracked.
    const trackedSources = trackedAmong(c.git, [...new Set([...equal.values()].flatMap((e) => e.found.map(([, rel]) => rel)))]);
    if (trackedSources === null) {
      gitFailed(c);
      return out;
    }
    for (const [copyRel, { copy, found }] of equal) {
      const hit = found.find(([, rel]) => trackedSources.has(rel));
      if (hit) out.set(copy, hit[0]);
      c.undecided.delete(copyRel);
    }
  } catch {
    return new Map();
  }
  return out;
}
