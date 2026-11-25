// How big a review a change needs, and how many review runs it gets (track H, H7: the user's
// choice of 2026-10-16, "the verification is too heavy"; track N, N6). The review gate is
// unchanged; this sizes what it asks for. A small diff gets one review-all for every axis; a
// larger or unknown one at most three runs (N6), not one per axis. Files changed after their
// review get a delta review (`mode: delta`, only what changed since), sized against the review.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { gitOut, OBJECT_ID } from './git-run';
import { AXIS_DIMENSIONS, type ReviewAxis, type ReviewDimension } from './review-dimensions';
import { recordPath } from './record-paths';
import { readRegular } from './safe-read';
import { listsFile } from './test-validator';
import type { ReviewResult } from './types';
import { classifyPath } from './verification-scope';

/** Up to this many substantive changed lines, one review-all covers every axis. */
export const SMALL_DIFF_LINES = 200;
const MAX_COUNTED_BYTES = 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

function git(cwd: string, args: string[], env?: Record<string, string>): string | null {
  return gitOut(cwd, args, { timeoutMs: GIT_TIMEOUT_MS, ...(env ? { env } : {}) });
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

/** (N6) Whether a file's changed lines count toward the size: every file but a document (prose:
 *  Markdown, text, reStructuredText, AsciiDoc and the docs dir's assets, lib/verification-scope.ts).
 *  Tests, SQL, templates, styles and config count (Codex, round 3). */
function countsLines(rel: string): boolean {
  return classifyPath(rel) !== 'document';
}

const blank = (line: string) => line.trim() === '';

/** The non-blank added and removed lines of a `--unified=0` patch. A header is read only outside
 *  the body lines a hunk header announced, so a removed line that reads `-- x` (shown as `--- x`)
 *  is counted, not taken for a file header (the reading of lib/diff-coverage.ts changedLines). */
export function substantivePatchLines(patch: string): number {
  let n = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-') && oldLeft > 0) {
        oldLeft--;
        if (!blank(line.slice(1))) n++;
        continue;
      }
      if (line.startsWith('+') && newLeft > 0) {
        newLeft--;
        if (!blank(line.slice(1))) n++;
        continue;
      }
      if (line.startsWith('\\')) continue;
      // A context line, which `diff.interHunkContext` puts into a `--unified=0` hunk to merge two (review: read as a
      //   header, it ended the hunk and its later changes went uncounted).
      if (line.startsWith(' ') && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
        continue;
      }
      oldLeft = newLeft = 0; // not a body line: read it as a header
    }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      newLeft = h[2] === undefined ? 1 : Number(h[2]);
    }
  }
  return n;
}

/** Repo-relative paths of `files` under git's top-level, or null when one is outside it. */
function relsUnder(top: string, cwd: string, files: readonly string[]): string[] | null {
  const rels: string[] = [];
  for (const f of files) {
    const r = relative(top, realish(resolvePath(cwd, f)));
    if (r === '' || r.startsWith('..') || isAbsolute(r)) return null;
    rels.push(r.split(sep).join('/'));
  }
  return rels;
}

/** The substantive changed lines of `rels` (repo-relative, at `top`) against `base` (a commit or
 *  tree), untracked files counted whole; with `base` null, against the index `env` names (the
 *  delta's index of a review tree), where no file is untracked. Null when a file is binary, too
 *  large, renamed, unchanged or ignored, or git fails: every file must be accounted for. */
function countChanged(top: string, rels: readonly string[], base: string | null, env?: Record<string, string>): number | null {
  if (rels.length === 0) return 0;
  const spec = rels.map((r) => `:(literal)${r}`);
  const against = base === null ? [] : [base];
  const numstat = git(top, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', ...against, '--', ...spec], env);
  const untracked = base === null ? '' : git(top, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...spec], env);
  if (numstat === null || untracked === null) return null;
  const seen = new Set<string>();
  // `-z` numstat: `added\tremoved\tpath\0`. A rename has an empty path and then `old\0new\0`;
  //   its files stay unseen, so the size reads as unknown. Numstat names the files and the binary
  //   ones; the patch below counts the lines.
  for (const rec of numstat.split('\0')) {
    const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    if (m[1] === '-' || m[2] === '-') return null; // binary
    if (m[3]) seen.add(m[3]);
  }
  let n = 0;
  const counted = [...seen].filter(countsLines);
  if (counted.length > 0) {
    const patch = git(
      top,
      ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', '--inter-hunk-context=0', ...against, '--', ...counted.map((r) => `:(literal)${r}`)],
      env,
    );
    if (patch === null) return null;
    n += substantivePatchLines(patch);
  }
  for (const rel of untracked.split('\0').filter(Boolean)) {
    // A regular file only, the path's own (no link followed) and opened without blocking: an untracked link to
    //   /dev/zero or a FIFO under a directory argument hung the count (security review). A link, a device, a
    //   larger file or one gone since git listed it leaves the size unknown.
    const read = readRegular(resolvePath(top, rel), MAX_COUNTED_BYTES, true);
    if (typeof read === 'string' || read.text.includes('\0')) return null; // not readable, or binary
    if (countsLines(rel)) n += read.text.split('\n').filter((l) => !blank(l)).length;
    seen.add(rel);
  }
  // Every file must be accounted for: no diff and not untracked means committed or ignored.
  return rels.every((r) => seen.has(r)) ? n : null;
}

/** Substantive lines added and removed in these files against `base` (HEAD by default; the
 *  review-axes command passes the session's start commit, N6), untracked files counted whole; null
 *  when the size is unknown: git cannot tell (not a repo, no commit, a failure or timeout), or a
 *  file is outside the repo, ignored, binary, renamed, or has no change against `base`. Unknown
 *  sizes take the grouped plan, so nothing is under-reviewed (H7 review). */
export function changedLineCount(cwd: string, files: string[], base = 'HEAD'): number | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const rels = relsUnder(top, cwd, files);
  return rels === null ? null : countChanged(top, rels, base);
}

/** (N6) Substantive lines changed in these files since the newest review in `reviews` that lists
 *  each one, read from that review's `tree` (the work tree it reviewed, kept in the repo's objects
 *  by review-write): each tree is read into a scratch index and the work tree is compared with it.
 *  Null when a file has no such review, the review has no tree, the tree is not in this repo, or
 *  the count is unknown for the reasons of changedLineCount. */
export function deltaLineCount(cwd: string, files: string[], reviews: readonly ReviewResult[]): number | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return null;
  const rels = relsUnder(top, cwd, files);
  if (rels === null) return null;
  const newest = [...reviews].sort((a, b) => (a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? 1 : -1));
  const byTree = new Map<string, string[]>();
  for (let i = 0; i < files.length; i++) {
    const key = recordPath(resolvePath(cwd, files[i]!));
    const r = newest.find((x) => listsFile(x.reviewed_files, key));
    if (!r || typeof r.tree !== 'string' || !OBJECT_ID.test(r.tree)) return null;
    byTree.set(r.tree, [...(byTree.get(r.tree) ?? []), rels[i]!]);
  }
  let n = 0;
  for (const [tree, group] of byTree) {
    let dir: string;
    try {
      dir = mkdtempSync(join(tmpdir(), 'goodboy-delta-'));
    } catch {
      return null; // no usable temp dir: the size is unknown, not an error (security review)
    }
    try {
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      if (git(top, ['read-tree', tree], env) === null) return null;
      const c = countChanged(top, group, null, env);
      if (c === null) return null;
      n += c;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return n;
}

/** One review run: the axes it covers, their required dimensions, and the words its prompt carries
 *  (`axes: …` and `mode: delta`; empty for one full run of every axis). */
export interface ReviewAssignment {
  axes: ReviewAxis[];
  dimensions: ReviewDimension[];
  brief: string;
}

/** Why the plan has the runs it has. */
export type PlanReason = 'one-axis' | 'small' | 'security-sensitive' | 'large' | 'unknown';

/** (N6) The runs of a larger or unknown change: evidence with design and performance, security with
 *  data privacy, and UI (which holds the requirements dimension, plan-completeness). */
const GROUP_AXES = [
  ['hallucination', 'refactoring', 'performance'],
  ['security', 'data-privacy'],
  ['ui'],
] as const satisfies readonly (readonly ReviewAxis[])[];
// Every axis is in a group: an axis added to ReviewAxis and left out here fails the type check, never drops out
//   of a grouped plan unreviewed (delta review).
const everyAxisGrouped: [Exclude<ReviewAxis, (typeof GROUP_AXES)[number][number]>] extends [never] ? true : never = true;
void everyAxisGrouped;
const GROUPS: readonly (readonly ReviewAxis[])[] = GROUP_AXES;
const SECURITY_GROUP: readonly ReviewAxis[] = GROUPS[1]!;

/** (N6) The dimensions that make a delta security-sensitive, so that it gets a security run of its
 *  own: injection, authorization, web hardening, dependencies, prototype pollution and data privacy.
 *  Not `security-secrets`, which every code and config file needs (lib/review-dimensions.ts), so the
 *  delta's one run checks it; nor `error-path`, which comes only with a dimension listed here (servers
 *  with `web-hardening`, input parsers with `proto-pollution`, shell scripts with `security-injection`). */
const SENSITIVE: readonly ReviewDimension[] = [
  'security-injection',
  'security-authz',
  'web-hardening',
  'dependency-risk',
  'proto-pollution',
  'data-privacy',
];

/** (N6) The review runs for a change: one for every axis when there is one axis or the change is
 *  small (at most SMALL_DIFF_LINES substantive lines); a small delta that is security-sensitive
 *  gets a second, security run; anything larger or of unknown size gets at most three runs
 *  (GROUPS). `dims` are the change's required dimensions. */
export function reviewAssignments(
  axes: readonly ReviewAxis[],
  dims: readonly ReviewDimension[],
  changedLines: number | null,
  opts: { delta?: boolean } = {},
): { reason: PlanReason; assignments: ReviewAssignment[] } {
  const delta = opts.delta === true;
  const small = changedLines !== null && changedLines <= SMALL_DIFF_LINES;
  let reason: PlanReason;
  let groups: ReviewAxis[][];
  if (axes.length <= 1) {
    reason = 'one-axis';
    groups = [[...axes]];
  } else if (small && delta && dims.some((d) => SENSITIVE.includes(d))) {
    reason = 'security-sensitive';
    groups = [axes.filter((a) => !SECURITY_GROUP.includes(a)), axes.filter((a) => SECURITY_GROUP.includes(a))];
  } else if (small) {
    reason = 'small';
    groups = [[...axes]];
  } else {
    reason = changedLines === null ? 'unknown' : 'large';
    groups = GROUPS.map((g) => axes.filter((a) => g.includes(a)));
  }
  groups = groups.filter((g) => g.length > 0);
  const assignments = groups.map((g) => {
    const words = [...(groups.length > 1 ? [`axes: ${g.join(', ')}`] : []), ...(delta ? ['mode: delta'] : [])];
    return { axes: g, dimensions: dims.filter((d) => g.some((a) => AXIS_DIMENSIONS[a].includes(d))), brief: words.join(' / ') };
  });
  return { reason, assignments };
}

/** The plan's one-line summary for the model. */
export function reviewPlanNote(reason: PlanReason, runs: number, agent: string, delta: boolean): string {
  const count = runs === 1 ? `one ${agent}` : `${runs} ${agent} runs`;
  const mode = delta ? ' with `mode: delta`' : '';
  switch (reason) {
    case 'one-axis':
      return `${count}${mode} (one axis)`;
    case 'small':
      return `${count}${mode} for every axis (a small ${delta ? 'delta' : 'diff'})`;
    case 'security-sensitive':
      return `${count}${mode}: one for every axis but security, one for security (a small delta that touches a security-sensitive file)`;
    case 'large':
      return `${count}${mode}, one per assignment (more than ${SMALL_DIFF_LINES} substantive changed lines)`;
    default:
      return `${count}${mode}, one per assignment (the size is unknown)`;
  }
}

/** (N6) When to start the runs, from the free agent slots: the concurrency cap (lib/routing-policy.ts)
 *  less the main session's agents still running (null: not known, no session). */
export function reviewSchedule(runs: number, cap: number, running: number | null): string {
  const free = Math.max(0, cap - (running ?? 0));
  const state = running === null ? `cap ${cap}` : `${running} running, cap ${cap}`;
  if (free >= runs) return runs === 1 ? 'Start it now.' : runs === 2 ? 'Start both in one message.' : `Start all ${runs} in one message.`;
  if (free === 0) return `No agent slot is free (${state}): start ${runs === 1 ? 'it' : 'them'} as running agents finish.`;
  return `Start ${free} now in one message and the other ${runs - free} as running agents finish (${state}).`;
}
