// Build-output copies need no layer-1 test of their own (issue #32, plan §15.21).
//
// A red/green check often copies a tested source file into a git-ignored build dir
// (`cp src/app.js target/app.js`). The write sweep records the copy as an edit, but it is not in
// a record's tree (an ignored file is not in `git add -A`), so the changed-line check reported
// it as lines no test ran, though its bytes are those of a tested source file. The copy leaves
// the layer-1 edit set when every condition holds; the review edit set keeps it. Any read or
// compare error keeps the obligation, and every Stop decides again.
//
//   - a path segment of the copy is `target` or `build`;
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
// Cost. A git spawn is about 60 ms, and the Stop hook's 15 s timeout skips the test and review
// gates when it fires. So the checks are batched (one `ls-files` for all candidates, one
// `check-ignore` for all of them, one `ls-files` for the candidate sources), at most
// MAX_BUILD_COPY_CANDIDATES candidates are examined, and the whole call has a wall-clock budget
// (BUILD_COPY_BUDGET_MS). A candidate past the cap or the budget stays in the layer-1 set (fail
// closed) and `onSkipped` says how many, for the gate log.

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { blobAtCommit, differFromBase, hookGit } from './changed-coverage';

/** The largest file whose bytes are compared. */
const MAX_COPY_BYTES = 16 * 1024 * 1024;

/** Candidates examined per call; the rest stay in the layer-1 set. */
export const MAX_BUILD_COPY_CANDIDATES = 200;

/** Wall-clock budget of one call, well under the Stop hook's 15 s with room for its other work. */
export const BUILD_COPY_BUDGET_MS = 3_000;

/** Byte-equal sources kept per copy for the tracked check (many identical small files). */
const MAX_EQUAL_SOURCES = 8;

const BUILD_SEGMENTS = new Set(['target', 'build']);

export interface BuildCopyLimits {
  maxCandidates?: number;
  budgetMs?: number;
  /** The clock in ms (a test's). */
  now?: () => number;
  /** Called with the number of candidates left undecided, and why: over the cap, or out of time. */
  onSkipped?: (count: number, reason: 'cap' | 'budget') => void;
}

/** `.env`, `.env.*` and `*.env`: secrets, never treated as a build copy or its source. */
export function isEnvName(rel: string): boolean {
  const b = basename(rel);
  return b === '.env' || b.startsWith('.env.') || b.endsWith('.env');
}

/** The repo-relative path (with `/`) of a file inside `top`, or null. */
function relIn(top: string, file: string): string | null {
  const r = relative(top, resolve(file));
  if (r === '' || r === '..' || r.startsWith(`..${sep}`) || resolve(top, r) !== resolve(file)) return null;
  return r.split(sep).join('/');
}

/** The files of `files` that are inside `top`: abs -> rel. */
function relsOf(top: string, files: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) {
    const rel = relIn(top, f);
    if (rel !== null) m.set(f, rel);
  }
  return m;
}

/** The size of a regular file with one link, below `top`, with no symbolic link on its path
 *  (checked from the top down); null for anything else and on any error. */
function plainSize(top: string, rel: string): number | null {
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
 *  bytes still that blob's. Anything else is a no. */
function pristineGitignore(canon: string, top: string, head: string, source: string): boolean {
  if (basename(source) !== '.gitignore') return false;
  // A relative, normalized path inside the canonical top: an absolute name (a global file), a
  //   `..` or `.` segment or a doubled slash does not survive the round trip.
  if (relIn(canon, join(canon, source)) !== source) return false;
  if (plainSize(canon, source) === null) return false;
  // Tracked at HEAD as a regular file (blobAtCommit refuses a symlink or a gitlink mode).
  if (blobAtCommit(top, head, source, MAX_GITIGNORE_BYTES) === null) return false;
  // Its content now is that blob's: differFromBase hashes the file as git would store it.
  return differFromBase(top, head, [source]).size === 0;
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

/** The copy -> source pairs (absolute paths) among `edits` (absolute files of the layer-1 edit
 *  set). `changeSet` lists the session's change set the source must be in (absolute files; read
 *  only when a copy qualifies by its path); it defaults to `edits`. Empty when `head` (the
 *  session's start HEAD) is unknown. */
export function buildCopies(edits: readonly string[], top: string, head: string | null | undefined, changeSet?: () => readonly string[], limits: BuildCopyLimits = {}): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (typeof head !== 'string' || edits.length === 0) return out;
    const underBuild = ([, rel]: [string, string]) => rel.split('/').slice(0, -1).some((s) => BUILD_SEGMENTS.has(s)) && !isEnvName(rel) && !rel.startsWith(':');
    const candidates = [...relsOf(top, edits)].filter(underBuild);
    if (candidates.length === 0) return out;
    const canon = realpathSync(top);
    // Cheap file system checks first; then the cap, so a deleted file takes no slot.
    let pending = candidates.filter(([, rel]) => plainSize(top, rel) !== null);
    const cap = limits.maxCandidates ?? MAX_BUILD_COPY_CANDIDATES;
    if (pending.length > cap) limits.onSkipped?.(pending.length - cap, 'cap');
    pending = pending.slice(0, cap);
    const now = limits.now ?? Date.now;
    const t0 = now();
    const left = (): number => (limits.budgetMs ?? BUILD_COPY_BUDGET_MS) - (now() - t0);
    /** True, with the undecided count reported, once the budget is gone. */
    const spent = (undecided: number): boolean => {
      if (left() > 0) return false;
      limits.onSkipped?.(undecided, 'budget');
      return true;
    };
    const git: Git = (args, input) => hookGit(top, args, input, Math.max(1, left()));

    // One listing for every candidate: a tracked file under build/ or target/ is no copy.
    if (pending.length === 0 || spent(pending.length)) return out;
    const tracked = trackedAmong(git, pending.map(([, rel]) => rel));
    if (tracked === null) {
      spent(pending.length); // a timed-out git is the budget
      return out;
    }
    pending = pending.filter(([, rel]) => !tracked.has(rel));
    if (pending.length === 0 || spent(pending.length)) return out;

    // One ignore check for every candidate, then one verdict per deciding `.gitignore`.
    const rules = ignoreRules(git, pending.map(([, rel]) => rel));
    if (rules === null) {
      spent(pending.length);
      return out;
    }
    const verdicts = new Map<string, boolean>();
    const qualifying: [string, string][] = [];
    for (const [i, [abs, rel]] of pending.entries()) {
      const row = rules.get(rel);
      if (row === undefined || !/^\d+$/.test(row.line) || row.pattern === '' || row.pattern.startsWith('!')) continue;
      let ok = verdicts.get(row.source);
      if (ok === undefined) {
        if (spent(pending.length - i)) return out;
        ok = pristineGitignore(canon, top, head, row.source);
        verdicts.set(row.source, ok);
      }
      if (ok) qualifying.push([abs, rel]);
    }
    if (qualifying.length === 0) return out;

    // Read only after `plainSize` said the path is a regular file (never a FIFO or a device).
    const bytes = new Map<string, Buffer | null>();
    const read = (abs: string): Buffer | null => {
      if (!bytes.has(abs)) {
        let b: Buffer | null = null;
        try {
          if (lstatSync(abs).size <= MAX_COPY_BYTES) b = readFileSync(abs);
        } catch {
          b = null;
        }
        bytes.set(abs, b);
      }
      return bytes.get(abs) ?? null;
    };
    // The session's change set is listed once, and only for a copy that passed the checks above.
    const sources = [...relsOf(top, changeSet ? changeSet() : edits)].filter(([, rel]) => !isEnvName(rel));
    const sizes = new Map<string, number | null>();
    const sizeOf = (rel: string): number | null => {
      if (!sizes.has(rel)) sizes.set(rel, plainSize(top, rel));
      return sizes.get(rel) ?? null;
    };
    const equal = new Map<string, [string, string][]>(); // copy -> byte-equal sources (abs, rel)
    for (const [i, [copy, copyRel]] of qualifying.entries()) {
      if (spent(qualifying.length - i)) return out;
      const mine = read(copy);
      if (mine === null) continue;
      const found: [string, string][] = [];
      for (const [source, sourceRel] of sources) {
        if (found.length >= MAX_EQUAL_SOURCES) break;
        if (source === copy || sourceRel === copyRel || sizeOf(sourceRel) !== mine.length) continue; // no read of a file of another size
        const theirs = read(source);
        if (theirs !== null && mine.equals(theirs)) found.push([source, sourceRel]);
      }
      if (found.length > 0) equal.set(copy, found);
    }

    // One listing for the candidate sources: the source must be tracked.
    const rels = [...new Set([...equal.values()].flatMap((l) => l.map(([, rel]) => rel)))];
    if (rels.length === 0 || spent(equal.size)) return out;
    const trackedSources = trackedAmong(git, rels);
    if (trackedSources === null) {
      spent(equal.size);
      return out;
    }
    for (const [copy, list] of equal) {
      const hit = list.find(([, rel]) => trackedSources.has(rel));
      if (hit) out.set(copy, hit[0]);
    }
  } catch {
    return new Map();
  }
  return out;
}
