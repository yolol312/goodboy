// (#41, v0.36.17) A test run recorded from a clean linked worktree of the project's repository.
//
// The tested tree of a layer-1 result is the project dir's whole working tree (lib/push-test.ts
// workTreeState): every untracked file that is not ignored and every uncommitted edit is in it. A repo
// that keeps local-only files on purpose (local config overrides, IDE metadata, notes) therefore never
// had a result whose tree matched the commit it pushed. `test-write --worktree <dir>` and `regression
// --worktree <dir>`, run from the project dir, take the tree of such a worktree instead: one that
// holds a commit and nothing else. The record stays in the project dir, where the push check reads it.

import { isAbsolute, resolve } from 'node:path';
import { linkedWorktreeOf } from './git-dirs';
import { spawnGit } from './git-run';
import { isArtifactPath, OBJECT_ID, revisionTree, topOf } from './push-test';
import { realDeep } from './private-files';

export type CleanWorktree = { ok: true; top: string; commit: string; tree: string } | { ok: false; why: string };

/** Most files a refusal names. */
const SHOWN = 5;

/** `git status --porcelain=v1 -z` entries as paths, a rename's or copy's old path (the field after it) too: a
 *  file renamed into an artifact dir left its old path changed (security review: `git mv a.test.ts
 *  .claude/pending/` read as clean while HEAD's tree still held the file). */
function statusPaths(out: string): string[] {
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    if (/[RC]/.test(f.slice(0, 2)) && i + 1 < fields.length) paths.push(fields[++i]!);
  }
  return paths.filter((p) => p !== '');
}

/** The worktree `dir` (resolved from `shell`) when it is a linked worktree of the repository of the
 *  project dir's checkout, other than that checkout, with a commit checked out and no change git
 *  shows (no untracked file that is not ignored, no edit, no staged change, no submodule change;
 *  goodboy's artifacts aside): its top, HEAD and HEAD's tree as `revisionTree` gives it, which is
 *  the tree a push of that commit hands off. Otherwise why not. */
export function cleanWorktreeFor(projectDir: string, dir: string, shell: string): CleanWorktree {
  const at = isAbsolute(dir) ? dir : resolve(shell, dir);
  const top = topOf(at);
  if (top === null) return { ok: false, why: `${at} is not inside a git checkout (or git did not answer)` };
  const own = topOf(projectDir);
  if (own === null) return { ok: false, why: 'the project dir is no git checkout, so it has no linked worktrees' };
  if (realDeep(top) === realDeep(own)) return { ok: false, why: `${top} is the project dir's own checkout; record without --worktree` };
  if (!linkedWorktreeOf(top, own)) {
    return { ok: false, why: `${top} is not a linked worktree of the project's repository (make one with \`git worktree add <dir> <commit>\`)` };
  }
  const headNow = (): string => {
    const head = spawnGit(top, ['rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: 15_000, noMemo: true });
    return head.code === 0 ? head.out.trim() : '';
  };
  const commit = headNow();
  if (!OBJECT_ID.test(commit)) return { ok: false, why: `${top} has no commit checked out` };
  // The repo's clean filters stay on, as in workTreeState's `git add`: without them every filtered file (LFS) read
  //   as modified (security review, low).
  const st = spawnGit(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], {
    timeoutMs: 60_000,
    noMemo: true,
    keepFilters: true,
  });
  if (st.code !== 0) return { ok: false, why: `git status did not answer in ${top}` };
  // HEAD moved while status ran: the status was of another commit.
  if (headNow() !== commit) return { ok: false, why: `HEAD moved in ${top} while it was checked; run again` };
  const dirty = statusPaths(st.out).filter((p) => !isArtifactPath(p));
  if (dirty.length > 0) {
    const more = dirty.length > SHOWN ? ` and ${dirty.length - SHOWN} more` : '';
    return {
      ok: false,
      why: `${top} is not clean (${dirty.slice(0, SHOWN).join(', ')}${more}); the record must hold one commit: commit, stash or remove those files (ignored files may stay)`,
    };
  }
  const tree = revisionTree(top, commit);
  if (tree === null) return { ok: false, why: `git could not read the tree of ${commit.slice(0, 10)} in ${top}` };
  return { ok: true, top, commit, tree };
}

/** Takes `--worktree <dir>` out of `args`: the dir (null when absent), the other args, and an error
 *  when the flag has no value. */
export function worktreeArg(args: readonly string[]): { dir: string | null; rest: string[]; error?: string } {
  const rest: string[] = [];
  let dir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--worktree' || a.startsWith('--worktree=')) {
      const v = a === '--worktree' ? args[++i] : a.slice('--worktree='.length);
      if (v === undefined || v.trim() === '') return { dir: null, rest, error: '--worktree needs a directory' };
      dir = v;
      continue;
    }
    rest.push(a);
  }
  return { dir, rest };
}
