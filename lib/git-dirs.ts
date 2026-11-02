// What a checkout is, read from its `.git` with no git call (plan §15.23 rule 2), and (#35) the
// linked worktree of the same repository nested inside a project dir that owns a file. No import
// of the session tracker: lib/file-tracker.ts uses it for the edit scope.

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readRegular } from './safe-read';

/** The admin dir and the common git dir of the checkout at `top`, read from `.git` (no git call);
 *  null when `top` has no `.git` this can read. A linked worktree's `.git` is a file naming its
 *  admin dir `<common>/worktrees/<name>`. */
export function fsDirs(top: string): { admin: string; common: string } | null {
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

/** A short-lived memo: the edit scope asks once per edit record (thousands per query, several
 *  queries per Stop); the tree does not change within a second, and a worktree made later is seen
 *  after it (refactoring review round 1: an unmemoized verdict cost 27 s for 20k records). */
function memo<T>(map: Map<string, { at: number; v: T }>, key: string, make: () => T): T {
  const now = Date.now();
  const hit = map.get(key);
  if (hit !== undefined && now - hit.at < 1000) return hit.v;
  const v = make();
  if (map.size > 10_000) map.clear();
  map.set(key, { at: now, v });
  return v;
}

const linkedSeen = new Map<string, { at: number; v: boolean }>();

/** Whether `d` is a linked worktree of the repository of the checkout at `root`: the one rule the
 *  project dir (lib/project-dir.ts) and the edit scope (nestedCheckoutOf) share, so no dir leaves
 *  `root`'s scope unless a Stop run inside it takes it as its project (refactoring review round 1:
 *  two rules let a planted `.git` move files to where no Stop judged them). Read from the files git
 *  keeps, no git call: `d/.git` is a file naming an admin dir that shares `root`'s common git dir,
 *  is not `root`'s own, is a linked worktree's (not the common dir itself), and whose `gitdir`
 *  back-pointer names `d/.git`, which is how `git worktree list` finds it. A `.git` file planted to
 *  point at another worktree's admin dir, a worktree moved without `git worktree move`, a nested
 *  clone (`.git` is a directory) and a submodule (no `commondir`) all fail it. */
export function linkedWorktreeOf(d: string, root: string): boolean {
  return memo(linkedSeen, `${resolve(root)}\0${resolve(d)}`, () => {
    try {
      if (!lstatSync(join(d, '.git')).isFile()) return false;
      const mine = fsDirs(root);
      const theirs = fsDirs(d);
      if (mine === null || theirs === null) return false;
      if (theirs.common !== mine.common || theirs.admin === mine.admin || theirs.admin === theirs.common) return false;
      const back = readRegular(join(theirs.admin, 'gitdir'), 4096, true);
      if (typeof back === 'string') return false;
      return realpathSync(resolve(theirs.admin, back.text.trim())) === realpathSync(join(d, '.git'));
    } catch {
      return false;
    }
  });
}

const ownerSeen = new Map<string, { at: number; v: string | null }>();

/** (#35) The nearest linked worktree of `root`'s repository strictly between `root` and `file` (its dir,
 *  in `file`'s spelling), or null. Such a worktree is a checkout of its own: its edits are judged in a
 *  Stop run inside it, against its own start, with its own records, and a Stop in `root` leaves them
 *  out of its scope (it reports them as another checkout's, hooks/stop.ts). Claude Code's agent
 *  worktrees under `<root>/.claude/worktrees` keep their place in `root`'s scope, as before. Files
 *  only, no git call; one verdict per directory. */
export function nestedCheckoutOf(file: string, root: string): string | null {
  try {
    const top = resolve(root);
    const f = resolve(file);
    if (!f.startsWith(top + sep)) return null;
    if (f.startsWith(join(top, '.claude', 'worktrees') + sep)) return null;
    return memo(ownerSeen, `${top}\0${dirname(f)}`, () => {
      for (let d = dirname(f); d !== top && d.startsWith(top + sep); d = dirname(d)) {
        if (linkedWorktreeOf(d, top)) return d;
      }
      return null;
    });
  } catch {
    return null;
  }
}
