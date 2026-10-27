// How big a review a change needs (track H, H7: the user's choice of 2026-10-16, "the
// verification is too heavy"). The review gate is unchanged; this sizes what it asks for. A
// small diff gets one review-all for every axis instead of one agent per axis, and files
// changed after their review get a delta review (`mode: delta`, only what changed since).

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { gitOut } from './git-run';

/** Up to this many changed lines, one review-all covers every axis. */
export const SMALL_DIFF_LINES = 200;
const MAX_COUNTED_BYTES = 1024 * 1024;

function git(cwd: string, args: string[]): string | null {
  return gitOut(cwd, args, { timeoutMs: 10_000 });
}

/** git's top-level is a real path; so must the files be, or a checkout reached through a
 *  symlink would see every file as outside it (H7 review). */
export function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p)); // a deleted file in a real directory
    } catch {
      return p;
    }
  }
}

/** Lines added and removed in these files against HEAD, untracked files counted whole; null
 *  when the size is unknown: git cannot tell (not a repo, no commit, a failure or timeout), or
 *  a file is outside the repo, ignored, binary, or has no change against HEAD (committed
 *  already). Unknown sizes take the per-axis plan, so nothing is under-reviewed (H7 review). */
export function changedLineCount(cwd: string, files: string[]): number | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const rels: string[] = [];
  for (const f of files) {
    const r = relative(top, realish(resolvePath(cwd, f)));
    if (r === '' || r.startsWith('..') || isAbsolute(r)) return null;
    rels.push(r.split(sep).join('/'));
  }
  if (rels.length === 0) return 0;
  const numstat = git(top, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...rels]);
  const untracked = git(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...rels]);
  if (numstat === null || untracked === null) return null;
  const seen = new Set<string>();
  let n = 0;
  // `-z` numstat: `added\tremoved\tpath\0`. A rename has an empty path and then `old\0new\0`;
  //   its files stay unseen, so the size reads as unknown.
  for (const rec of numstat.split('\0')) {
    const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    if (m[1] === '-' || m[2] === '-') return null; // binary
    n += Number(m[1]) + Number(m[2]);
    if (m[3]) seen.add(m[3]);
  }
  for (const rel of untracked.split('\0').filter(Boolean)) {
    try {
      const abs = resolvePath(top, rel);
      if (statSync(abs).size > MAX_COUNTED_BYTES) return null;
      const text = readFileSync(abs, 'utf8');
      if (text.includes('\0')) return null; // binary
      n += text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      seen.add(rel);
    } catch {
      return null; // gone since git listed it
    }
  }
  // Every file must be accounted for: no diff and not untracked means committed or ignored.
  return rels.every((r) => seen.has(r)) ? n : null;
}

/** One review-all for every axis when the diff is small or there is one axis; one per axis
 *  otherwise, and when the size is unknown. */
export function reviewPlan(changedLines: number | null, axes: number): 'single' | 'per-axis' {
  if (axes <= 1) return 'single';
  return changedLines !== null && changedLines <= SMALL_DIFF_LINES ? 'single' : 'per-axis';
}

export function reviewPlanNote(plan: 'single' | 'per-axis', agent: string): string {
  return plan === 'single'
    ? `one ${agent} for every axis (a small diff)`
    : `one ${agent} per axis, in parallel`;
}
