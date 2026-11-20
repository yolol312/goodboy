// (#44) Whether a repo holds commits that no remote has: the case where a rebase may rewrite files with the same
// content while the review and test records bound to a git tree still prove that content.

import { snapshotMemo, spawnGit } from './git-run';
import { TREE_RECORD_WINDOW_MIN } from './test-validator';

/** True when any local branch has a commit no remote-tracking ref has (`git rev-list --branches --not --remotes -n1`
 *  prints one). Any failure (not a repo, git cut off, no time left) counts as unpushed: keeping a record is the safe
 *  side. A repo with no remote at all is always unpushed. */
export function unpushedWork(top: string): boolean {
  const r = spawnGit(top, ['rev-list', '--branches', '--not', '--remotes', '-n1'], { timeoutMs: 3000, noMemo: true });
  if (r.code !== 0) return true;
  return r.out.trim() !== '';
}

/** The age (minutes) up to which a record with a `tree` is read and kept: 30 days while a commit is unpushed, else 0
 *  (the plain window and retention apply). A function, asked only when a record is older than the plain window
 *  (lib/test-validator.ts treeWindowCheck), so a Stop whose records are all fresh makes no git call for it; asked at
 *  most once per Stop. */
export function treeRecordWindow(top: string): () => number {
  return () => snapshotMemo(`unpushed\0${top}`, () => (unpushedWork(top) ? TREE_RECORD_WINDOW_MIN : 0));
}
