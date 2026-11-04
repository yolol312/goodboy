// The git repos inside a project dir that is no repo itself (#39, plan §15.30 items 1-2). A plain
// folder holding `be/` and `fe/`, each its own repository, has no top of its own: a file belongs to
// the nearest repo between its dir and the project dir (`repoOfFile`), and the repos that exist when
// a session starts are found by a bounded walk down (`nestedRepos`). Shared by lib/push-test.ts
// (`repoTrees`) and lib/start-pins.ts (a start per repo).
//
// A repo's `top` is spelled the way the project dir is (the project dir plus the walked relative
// path), because the edit log keeps the tool's spelling and every `relative()` and git call is made
// with it; `realTop` (`realDeep`) is only a key.

import { lstatSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnGit } from './git-run';
import { hookClockRunning, hookLeft } from './hook-clock';
import { realDeep } from './private-files';

export interface RepoRef {
  /** The repo's top, spelled like the project dir. */
  top: string;
  /** The same dir with every link resolved. */
  realTop: string;
  /** Set when the dir holds a `.git` entry that git did not answer for in time (a FIFO, a slow disk, a
   *  broken repository): it is treated as a repo nobody can read (no tree, no start), never walked past
   *  and never asked again in this process (plan §15.30 item 2). */
  unconfirmed?: true;
}

/** Repos the walk down returns at most. lib/start-pins.ts `MAX_EAGER_TOPS` is this number. */
export const MAX_NESTED_REPOS = 64;
/** Levels below the project dir the walk reads (the project dir is level 0). */
export const MAX_NESTED_DEPTH = 4;
/** Dirs the walk reads at most. */
export const MAX_NESTED_DIRS = 2_000;
/** Git calls the walk makes to confirm a `.git` entry, at most (a tree full of planted ones). */
const MAX_NESTED_CHECKS = 4 * MAX_NESTED_REPOS;

/** One git call confirming a `.git` entry may take this long, ms. */
export const CONFIRM_LIMIT_MS = 2_000;
/** All the confirmations of a hook process may take this long in all, ms (time spent in them, not a
 *  wall-clock deadline: the Stop's grouping runs late). Kept only while a hook clock runs, which every hook that
 *  walks starts (Stop, SessionStart, both post hooks, SubagentStop): the CLI has no hook timeout to protect, and the unit tests
 *  share one process. */
export const CONFIRM_BUDGET_MS = 4_000;

const testMs = (name: string, env: Record<string, string | undefined>): number | null => {
  const n = Number.parseInt((env[name] ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** The two limits. Test seams `GOODBOY_TEST_CONFIRM_LIMIT_MS` and `GOODBOY_TEST_CONFIRM_BUDGET_MS` (the
 *  second also turns the budget on without a hook clock); unset in use. */
function confirmLimits(env: Record<string, string | undefined> = process.env): { limitMs: number; budgetMs: number | null } {
  return {
    limitMs: testMs('GOODBOY_TEST_CONFIRM_LIMIT_MS', env) ?? CONFIRM_LIMIT_MS,
    budgetMs: testMs('GOODBOY_TEST_CONFIRM_BUDGET_MS', env) ?? (hookClockRunning() ? CONFIRM_BUDGET_MS : null),
  };
}

/** The dirs git did not answer for, and the time the confirmations took, in this process. */
const unansweredDirs = new Set<string>();
let confirmSpentMs = 0;

/** The dirs (real) git did not answer for so far in this process, in the order they were asked. */
export function unansweredSoFar(): readonly string[] {
  return [...unansweredDirs];
}

/** Forgets both (the unit tests share one process; a hook is one). */
export function resetConfirmations(): void {
  unansweredDirs.clear();
  confirmSpentMs = 0;
}

/** The repo's top directory in cwd's own spelling, or null outside a repo. */
export function topOf(cwd: string, timeoutMs = 15_000): string | null {
  // A hand-off check reads the repo as it is now: no answer comes from a Stop's snapshot (`noMemo`).
  const r = spawnGit(cwd, ['rev-parse', '--show-cdup'], { timeoutMs, noMemo: true });
  return r.code === 0 ? resolve(cwd, r.out.trim() || '.') : null;
}

const hasDotGit = (dir: string): boolean => {
  try {
    lstatSync(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
};

/** Whether `dir` (real) is itself a repo top: it holds a `.git` entry and git says its top is `dir`.
 *  A `.git` that is not a repo top (a planted or empty `be/src/.git`: git goes on up to `be`) is no.
 *  'unanswered': git did not answer (it timed out, stalled or was killed, or no time was left to ask: the
 *  call gets the smallest of the per-call limit, what the process's confirmation budget has left and what
 *  the hook's clock has left), and the dir is remembered as such: it is never asked twice. Answers of 'yes'
 *  and 'no' are not kept (a test turns a dir into a repo between calls). */
function confirmRepoTop(dir: string): 'yes' | 'no' | 'unanswered' {
  if (!hasDotGit(dir)) return 'no';
  if (unansweredDirs.has(dir)) return 'unanswered';
  const { limitMs, budgetMs } = confirmLimits();
  const left = Math.min(limitMs, budgetMs === null ? Infinity : budgetMs - confirmSpentMs, hookLeft());
  if (!(left >= 1)) {
    unansweredDirs.add(dir);
    return 'unanswered';
  }
  const t0 = Date.now();
  // A hand-off check reads the repo as it is now: no answer comes from a Stop's snapshot (`noMemo`).
  const r = spawnGit(dir, ['rev-parse', '--show-cdup'], { timeoutMs: Math.ceil(left), noMemo: true });
  confirmSpentMs += Date.now() - t0;
  if (!r.ran || r.stalled || r.code === -1) {
    unansweredDirs.add(dir);
    return 'unanswered';
  }
  return r.code === 0 && realDeep(resolve(dir, r.out.trim() || '.')) === dir ? 'yes' : 'no';
}

/** The answers of one set of `repoOfFile` calls: a real dir → the repo it is in, or null. */
export type RepoWalkMemo = Map<string, RepoRef | null>;

/** The repo a file belongs to: the nearest dir from the file's dir up to the project dir (both inside
 *  it, the project dir included) that holds a `.git` entry the repo-top check confirms. A `.git` that
 *  is not a repo top is passed over and the walk goes on up; one git did not answer for is returned as
 *  `unconfirmed` (fails closed: it is not walked past). A submodule or linked worktree (a `.git`
 *  file) counts. Null for a loose file (no repo up to the project dir) and for a file outside the
 *  project dir. No git call for a dir without a `.git` entry; `memo` keeps every dir walked, so the
 *  files of one dir cost one walk. */
export function repoOfFile(file: string, projectDir: string, memo: RepoWalkMemo = new Map()): RepoRef | null {
  const spelledRoot = resolve(projectDir);
  const root = realDeep(projectDir);
  const dir = realDeep(dirname(resolve(projectDir, file)));
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const walked: string[] = [];
  let found: RepoRef | null = null;
  for (let d = dir; ; ) {
    const known = memo.get(d);
    if (known !== undefined) {
      found = known;
      break;
    }
    walked.push(d);
    const answer = confirmRepoTop(d);
    if (answer !== 'no') {
      found = { top: join(spelledRoot, relative(root, d)), realTop: d, ...(answer === 'unanswered' ? { unconfirmed: true as const } : {}) };
      break;
    }
    const up = dirname(d);
    if (d === root || up === d) break;
    d = up;
  }
  for (const w of walked) memo.set(w, found);
  return found;
}

export interface NestedLimits {
  depth: number;
  dirs: number;
  repos: number;
}

export interface NestedRepos {
  repos: RepoRef[];
  /** A cap stopped the walk: the dirs, the repos, or a plain dir chain deeper than the depth limit, so
   *  a repo may exist that is not listed. (A level limit inside a repo found does not count: the code of
   *  a repo is deeper than 4 levels as a rule, and a clone inside one is the case `repoOfFile` handles.) */
  capped: boolean;
  /** The dirs (spelled like the project dir) with a `.git` entry git did not answer for (`confirmRepoTop`):
   *  not listed in `repos`, and the walk is `capped` because of them. */
  unanswered: string[];
}

/** The repos below `projectDir`, by a bounded walk down that follows no links (a symlink is never
 *  read as a dir): at most `depth` levels (4), `dirs` dirs read (2 000), `repos` repos (64); dot dirs
 *  and `node_modules` are skipped; it descends into the repos it finds (a clone inside one is listed
 *  too). Breadth first and sorted, so a cap keeps the shallow repos and the same ones every time.
 *  The project dir itself is not listed. */
export function nestedRepos(projectDir: string, limits: Partial<NestedLimits> = {}): NestedRepos {
  const max: NestedLimits = { depth: MAX_NESTED_DEPTH, dirs: MAX_NESTED_DIRS, repos: MAX_NESTED_REPOS, ...limits };
  const spelledRoot = resolve(projectDir);
  const root = realDeep(projectDir);
  const repos: RepoRef[] = [];
  const unanswered: string[] = [];
  let capped = false;
  let stopped = false; // a hard cap: nothing more is read
  let read = 0;
  let checks = 0;
  const queue: { rel: string; depth: number; inRepo: boolean }[] = [{ rel: '', depth: 0, inRepo: false }];
  for (let i = 0; i < queue.length && !stopped; i++) {
    const { rel, depth } = queue[i]!;
    let inRepo = queue[i]!.inRepo;
    if (read >= max.dirs) {
      capped = stopped = true;
      break;
    }
    read++;
    const real = join(root, rel);
    if (depth >= 1 && hasDotGit(real)) {
      if (checks >= MAX_NESTED_CHECKS) {
        capped = stopped = true;
        break;
      }
      checks++;
      const answer = confirmRepoTop(real);
      if (answer === 'unanswered') {
        unanswered.push(join(spelledRoot, rel));
        capped = true; // a repo may be there that is not listed
      } else if (answer === 'yes') {
        if (repos.length >= max.repos) {
          capped = stopped = true;
          break;
        }
        repos.push({ top: join(spelledRoot, rel), realTop: real });
        inRepo = true;
      }
    }
    let names: string[];
    try {
      names = readdirSync(real, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => e.name)
        .sort();
    } catch {
      continue; // unreadable: nothing below it is known (no cap is claimed for a permission error)
    }
    if (depth >= max.depth) {
      if (names.length > 0 && !inRepo) capped = true;
      continue;
    }
    for (const n of names) queue.push({ rel: join(rel, n), depth: depth + 1, inRepo });
  }
  return { repos, capped, unanswered };
}
