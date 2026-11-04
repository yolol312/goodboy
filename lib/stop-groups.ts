// The Stop judges one group per repository (#39, plan §15.30 items 3-5 and 8-11). A project dir that is
// no repo (a plain folder holding `be/` and `fe/`) has no top of its own: the session's edits are grouped
// by the repo each file belongs to (`repoOfFile`), the files in no repo form the project dir's own group,
// and every check that needs git (the start, the net change, the base of a coverage record, a record's
// tree) runs with that group's repo top. A project dir that is a repo has exactly one group, whose top is
// `projectTop(cwd)`: every function here then does what the single-top Stop did.
//
// `groupsOf` is the one helper that both Stop paths (the full Stop and the stop_hook_active accept) ask,
// so they judge the same groups. A group's `top` is spelled as the project dir is (the edit log keeps the
// tool's spelling, and every `relative()` is lexical); `realTop` only keys `trees` and `coverage.changed`.
//
// Names: reasons name a file relative to the project dir (`be/src/x.ts`); the calls into git take the file
// relative to its repo.

import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import {
  blobAtCommit,
  differFromBase,
  divergedFromStart,
  incompleteStart,
  netChangedEdits,
  noteSessionTop,
  repoTop,
  sessionCoverageStart,
  sessionUserGlobs,
  treeContent,
  withSameContent,
  type CoverageStart,
  type GapsOut,
  type UserGlobKey,
} from './changed-coverage';
import { buildCopies } from './build-copies';
import { changedLines } from './diff-coverage';
import { weakenedTests, type Weakened } from './existing-tests';
import { getEditHistory, getEditsSince, getEditsWithLastTimestampSince } from './file-tracker';
import { snapshotMemo, withHashBatch } from './git-run';
import { logGate } from './gate-log';
import { hookLeft } from './hook-clock';
import { nestedRepos, repoOfFile, resetConfirmations, unansweredSoFar, type RepoRef, type RepoWalkMemo } from './nested-repos';
import { realDeep } from './private-files';
import { topIdentity } from './start-pins';
import { detectTestInfrastructure, type TestInfraSignal } from './test-validator';
import { isGeneratedLcov } from './lcov-report';
import { MAX_MANIFEST_BYTES, needsTests } from './verification-scope';
import type { ChangedFileEdit } from './review-validator';
import type { TestResult } from './types';

export type GroupKind =
  /** The project dir's own repo (the project dir is a repo): the only group. */
  | 'repo'
  /** A repo below a project dir that is no repo. */
  | 'nested'
  /** The files of a project dir that is no repo that no repo holds. */
  | 'loose';

export interface Group {
  kind: GroupKind;
  /** The repo top, spelled as the project dir is. For `loose` it is the project dir. */
  top: string;
  /** `top` with every link resolved. */
  realTop: string;
  /** The repo dir relative to the project dir (`be`), `/` separators; '' for `repo` and `loose`. */
  rel: string;
  /** The session's start for this top (`sessionCoverageStart`). */
  start: CoverageStart;
  /** The start commit: null, no commit then (or no repo); undefined, no pin or unknown. */
  head: string | null | undefined;
  /** The session's files in this group (absolute, as the edit log has them). */
  edits: string[];
  /** Git did not answer for this repo dir in time (`RepoRef.unconfirmed`): its start is unknown, and nothing
   *  here asks git about it again. */
  unconfirmed?: true;
}

/** A name for a group in a message: the repo dir, or `.` for the project dir itself. */
export const labelOf = (g: Group): string => (g.rel === '' ? '.' : g.rel);

/** A file's name relative to its repo (`src/x.ts`) as relative to the project dir (`be/src/x.ts`). */
export const nameIn = (g: Group, repoRelative: string): string => (g.rel === '' ? repoRelative : `${g.rel}/${repoRelative}`);

// ── Memos: one Stop is one process, and nothing here changes while it runs ───────────────────────

const noRepoMemo = new Map<string, boolean>();
const failedTopMemo = new Set<string>();
const startMemo = new Map<string, CoverageStart>();
const globMemo = new Map<string, string[]>();
const infraMemo = new Map<string, string[]>();
const walkDownMemo = new Map<string, ReturnType<typeof nestedRepos>>();

/** The repos below the project dir, walked once per Stop (the pins and the test infrastructure both ask). */
function reposBelow(cwd: string): ReturnType<typeof nestedRepos> {
  const key = resolvePath(cwd);
  let r = walkDownMemo.get(key);
  if (r === undefined) {
    r = nestedRepos(cwd);
    walkDownMemo.set(key, r);
  }
  return r;
}
let walkMemo: RepoWalkMemo = new Map();

/** Forgets what this module kept (the unit tests share one process; a Stop is one). */
export function resetStopGroups(): void {
  noRepoMemo.clear();
  failedTopMemo.clear();
  startMemo.clear();
  globMemo.clear();
  infraMemo.clear();
  walkDownMemo.clear();
  testEditsMemo.clear();
  weakenedMemo.clear();
  walkMemo = new Map();
  resetConfirmations();
}

/** `repoTop(cwd)` for the project dir, asked once per Stop (item 6): in a project dir that is no repo the
 *  answer is the failing `git rev-parse --show-cdup`, which the Stop's git snapshot does not keep, and the
 *  grouping asked it about ten times. Outside a snapshot (the other hooks, the CLI, a test) every call asks. */
export function projectTop(cwd: string): string {
  return snapshotMemo(`projectTop\0${resolvePath(cwd)}`, () => repoTop(cwd));
}

/** Whether the project dir is no repo (nor inside one): its top has no git directory. Then the Stop groups
 *  by repo; otherwise it has the one group it always had. */
export function isNoRepoProject(cwd: string): boolean {
  const key = resolvePath(cwd);
  let v = noRepoMemo.get(key);
  if (v === undefined) {
    try {
      v = topIdentity(projectTop(cwd)).id === 'nogit';
    } catch {
      v = false;
    }
    noRepoMemo.set(key, v);
  }
  return v;
}

function startOf(sessionId: string, cwd: string, top: string): CoverageStart {
  const key = `${sessionId}\0${cwd}\0${top}`;
  let s = startMemo.get(key);
  if (s === undefined) {
    s = sessionCoverageStart(sessionId, cwd, top);
    startMemo.set(key, s);
  }
  return s;
}

/** The repo (real top, and its spelled top) a file belongs to, for a project dir that is no repo; null for a
 *  file in none, and always null when the project dir is a repo. One walk per dir. */
export function nestedRepoOf(cwd: string, file: string): RepoRef | null {
  return isNoRepoProject(cwd) ? repoOfFile(file, cwd, walkMemo) : null;
}

const byTop = (a: { top: string }, b: { top: string }): number => (a.top < b.top ? -1 : a.top > b.top ? 1 : 0);

/** Why the start of a repo dir git did not answer for is unknown (`RepoRef.unconfirmed`, item 2d). `others`: the
 *  other dirs git did not answer for in this Stop, relative to the project dir. They share one budget of time, so a
 *  real repo can go unasked because planted ones used it up (delta security review): they are named too. */
const unconfirmedReason = (rel: string, others: readonly string[] = []): string =>
  `git did not answer in time for \`${rel}\` (it holds a \`.git\` entry that git could not read: a FIFO, a slow disk or a broken repository). ` +
  (others.length > 0
    ? `git also did not answer for ${others.length} other \`.git\` ${others.length === 1 ? 'entry' : 'entries'} in the project dir ` +
      `(${others.slice(0, 5).map((o) => `\`${o}\``).join(', ')}${others.length > 5 ? `, ${others.length - 5} more` : ''}), and they share one ` +
      'budget of time for asking with it: remove the `.git` of each that is no real repository; otherwise the next Stop tries again.'
    : 'If it is no real repository, remove its `.git`; otherwise the next Stop tries again.');

/** The other dirs git did not answer for so far, relative to the project dir, `/`-separated; inside it only. */
function othersUnanswered(cwd: string, realTop: string): string[] {
  const root = realDeep(cwd);
  const out: string[] = [];
  for (const d of unansweredSoFar()) {
    if (d === realTop) continue;
    const rel = relative(root, d);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    out.push(rel.split(sep).join('/'));
  }
  return out;
}

/** The groups of `files` (default: every file of the session's edit log). In a project dir that is a repo:
 *  always one group, whatever `files` holds (also none). In one that is no repo: one group per repo holding a
 *  file, sorted by path, then the project dir's own group when some file is in no repo; none for no files. */
export function groupsOf(sessionId: string, cwd: string, files?: readonly string[]): Group[] {
  const list = files ?? getEditHistory(sessionId).files;
  const top0 = projectTop(cwd);
  const make = (kind: GroupKind, top: string, realTop: string, edits: string[], unconfirmed = false): Group => {
    const rel = kind === 'nested' ? relative(resolvePath(cwd), top).split(sep).join('/') : '';
    // A dir git did not answer for is asked nothing more (the start pin would stall the same way): its start is unknown.
    const start: CoverageStart = unconfirmed ? { exempt: [], unknown: unconfirmedReason(rel, othersUnanswered(cwd, realTop)) } : startOf(sessionId, cwd, top);
    return { kind, top, realTop, rel, start, head: start.head, edits, ...(unconfirmed ? { unconfirmed: true as const } : {}) };
  };
  if (!isNoRepoProject(cwd)) return [make('repo', top0, realDeep(top0), [...list])];
  const nested = new Map<string, { top: string; files: string[]; unconfirmed: boolean }>();
  const loose: string[] = [];
  for (const f of list) {
    const ref = repoOfFile(f, cwd, walkMemo);
    if (ref === null) {
      loose.push(f);
      continue;
    }
    const g = nested.get(ref.realTop) ?? { top: ref.top, files: [], unconfirmed: ref.unconfirmed === true };
    g.files.push(f);
    nested.set(ref.realTop, g);
  }
  const out = [...nested.entries()].map(([real, g]) => ({ real, ...g })).sort(byTop).map((g) => make('nested', g.top, g.real, g.files, g.unconfirmed));
  if (loose.length > 0) out.push(make('loose', top0, realDeep(top0), loose));
  return out;
}

// ── The deadline of one grouped evaluation ───────────────────────────────────────────────────────

export interface Deadline {
  /** Ms left; at most 0 when it has run out. */
  left(): number;
}

/** Time the groups of one evaluation share, in ms (item 4): the Stop's hook timeout is 15 s and a timed-out
 *  Stop blocks nothing, so the groups of the test gate (and, apart, of the review gate) get this much in all. */
export function groupBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt((env.GOODBOY_STOP_GROUP_BUDGET_MS ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 6_000;
}

/** A deadline of `ms` that never outlasts the hook's own clock (lib/hook-clock.ts, item 2b): what the Stop's
 *  earlier phases used is not left for this one, so the groups it does not reach block ("ran out of time")
 *  before the hook timeout cuts the process off. */
export function newDeadline(ms: number = groupBudgetMs()): Deadline {
  const end = Date.now() + ms;
  return { left: () => Math.min(end - Date.now(), hookLeft()) };
}

/** Test seam: `GOODBOY_TEST_GROUP_DELAY_MS` makes each group's rules take that long, so a test can run the
 *  shared deadline out with a slow group. Unset in use. */
export function groupDelayForTest(env: Record<string, string | undefined> = process.env): void {
  const n = Number.parseInt((env.GOODBOY_TEST_GROUP_DELAY_MS ?? '').trim(), 10);
  if (Number.isFinite(n) && n > 0) Bun.sleepSync(n);
}

/** The block reason for a group the deadline ran out before. */
export function ranOutOfTime(g: Group): string {
  return (
    `The check ran out of time before the changes in \`${labelOf(g)}\` could be judged (the hook has a few seconds in all for the ` +
    'repositories of the project, and the ones before it used them). This is not "the tests never ran": the next Stop judges it again; ' +
    'if it keeps happening, fewer repositories or smaller changes per turn help.'
  );
}

// ── Globs and classification ─────────────────────────────────────────────────────────────────────

/** The user's globs of `key` pinned at the session's start, read once (item 10): the project dir's own pin.
 *  A nested repo has none of its own, so these serve every group. */
export function projectGlobs(sessionId: string, cwd: string, key: UserGlobKey): string[] {
  const k = `${sessionId}\0${cwd}\0${key}`;
  let g = globMemo.get(k);
  if (g === undefined) {
    g = sessionUserGlobs(sessionId, cwd, projectTop(cwd), key);
    globMemo.set(k, g);
  }
  return g;
}

/** The static-preview globs for files named relative to the project dir: each glob as written and, for a
 *  nested repo, with the repo dir in front of it, so a glob written for the repo (`docs/**`) matches `be/docs/x.html`
 *  as one written for the project dir does. */
export function previewGlobsFor(sessionId: string, cwd: string, repoDirs: readonly string[]): string[] {
  const base = projectGlobs(sessionId, cwd, 'static-preview');
  const prefixes = [...new Set(repoDirs)];
  return prefixes.length === 0 ? base : [...new Set([...base, ...prefixes.flatMap((p) => base.map((g) => `${p}/${g}`))])];
}

/** The scope the classifiers use: the project dir as the root (names like `be/src/x.ts`) and the preview
 *  globs of the repos the session edited (no start is read for them: this is asked on every output path). */
export function scopeFor(sessionId: string, cwd: string): { top: string; previews: string[] } {
  const top = projectTop(cwd);
  if (!isNoRepoProject(cwd)) return { top, previews: projectGlobs(sessionId, cwd, 'static-preview') };
  const dirs = new Set<string>();
  for (const f of getEditHistory(sessionId).files) {
    const ref = repoOfFile(f, cwd, walkMemo);
    if (ref !== null) dirs.add(relative(resolvePath(cwd), ref.top).split(sep).join('/'));
  }
  return { top, previews: previewGlobsFor(sessionId, cwd, [...dirs]) };
}

/** A hook saw the project dir (#33): the checkout it is in is pinned if new to the session; and (#39) in a project
 *  dir that is no repo, so is every repo below it, before any gate reads the edit log. A repo that was pinned when
 *  the session started costs no git call (its pin file answers); one first seen now is pinned and the changes
 *  already in it, a shell command's among them, are recorded as the session's own. */
export function noteSessionTops(sessionId: string, cwd: string): void {
  noteSessionTop(sessionId, cwd);
  if (!isNoRepoProject(cwd)) return;
  for (const repo of reposBelow(cwd).repos) noteSessionTop(sessionId, repo.top);
}

/** (I3a) Whether a file needs a layer-1 test, in its group: the classification is by the project dir's name
 *  (`be/src/x.ts`); the rules that need git (the manifest rule and its start blob, a generated lcov report) use
 *  the group's repo top. */
export function needsTestCoverageIn(file: string, g: Group, scope: { top: string; previews: readonly string[] }): boolean {
  const baseline = (rel: string): string | null => (typeof g.head === 'string' ? blobAtCommit(g.top, g.head, rel, MAX_MANIFEST_BYTES) : null);
  if (isGeneratedLcov(file, g.top, () => g.head)) return false;
  return needsTests(file, scope.top, scope.previews, baseline, g.top);
}

// ── The files layer 1 and the review ask about, per group ────────────────────────────────────────

const testEditsMemo = new Map<string, { g: Group; files: string[] }[]>();

/** (#23) The code files edited since the cursor that layer 1 asks about, per group: a file whose content is
 *  its blob at the group's start HEAD is no change of this session (an edit undone, or brought back by a
 *  branch switch). Once per Stop: the edit log and the tree do not change while the hook runs, and both layer-1
 *  paths ask. */
export function testEditsByGroup(sessionId: string, cwd: string, cursorTurn: number): { g: Group; files: string[] }[] {
  const key = `${sessionId}\0${cwd}\0${cursorTurn}`;
  const known = testEditsMemo.get(key);
  if (known) return known;
  const scope = scopeFor(sessionId, cwd);
  // (v0.36.6) One evaluation: the net-change check, the build copies' `.gitignore` check and the
  //   change set's own net-change check hash the same files; each is hashed once (a hash batch).
  const out = withHashBatch(() => {
    const groups = groupsOf(sessionId, cwd, getEditsSince(sessionId, cursorTurn, cwd));
    const history = groupsOf(sessionId, cwd);
    const res: { g: Group; files: string[] }[] = [];
    for (const g of groups) {
      const files = g.edits.filter((f) => needsTestCoverageIn(f, g, scope));
      const net = netChangedEdits(files.map((file) => ({ file })), g.top, g.head).map((e) => e.file);
      // (#32) A git-ignored build copy of a tested source file is no change of its own (the review
      //   edit set keeps it). Decided again each Stop; the pair is in the gate log.
      const copies = buildCopies(net, g.top, g.head, () => {
        // The session's change set: every file of this repo it edited (any turn) that is still subject to
        //   layer 1 and differs from its start blob.
        const mine = history.find((h) => h.realTop === g.realTop && h.kind === g.kind)?.edits ?? [];
        return netChangedEdits(mine.filter((f) => needsTestCoverageIn(f, g, scope)).map((file) => ({ file })), g.top, g.head).map((e) => e.file);
      }, {
        // Past the cap or the time budget, the rest stay in the layer-1 set; the log says how many.
        onSkipped: (count, why) => logGate(sessionId, 'test', 'warn', `build-copy: ${count} candidate(s) kept in the test set (${why === 'cap' ? 'over the candidate cap' : why === 'bytes' ? 'over the byte cap' : why === 'git' ? 'git failed' : 'out of time'})`),
      });
      for (const [copy, source] of copies) logGate(sessionId, 'test', 'warn', `build-copy: ${relative(g.top, copy)} -> ${relative(g.top, source)}`);
      const kept = copies.size === 0 ? net : net.filter((f) => !copies.has(f));
      if (kept.length > 0 || g.kind === 'repo') res.push({ g: { ...g, edits: kept }, files: kept });
    }
    return res;
  });
  testEditsMemo.set(key, out);
  return out;
}

/** (#26) The files edited since the review cursor that are a change of this session, per group, judged as layer 1
 *  judges them: a file whose content is its blob at the group's start HEAD needs no review and no doc update.
 *  All kept when that check fails. With their last edit times. */
export function reviewEditsSince(sessionId: string, cwd: string, cursorTurn: number, withinDir = cwd): { file: string; lastEditTimestamp: string }[] {
  const edits = getEditsWithLastTimestampSince(sessionId, cursorTurn, withinDir);
  try {
    const byFile = new Map(edits.map((e) => [e.file, e]));
    const out: { file: string; lastEditTimestamp: string }[] = [];
    for (const g of groupsOf(sessionId, cwd, edits.map((e) => e.file))) {
      out.push(...netChangedEdits(g.edits.map((f) => byFile.get(f)!), g.top, g.head));
    }
    return out;
  } catch {
    return edits;
  }
}

// ── Starts ────────────────────────────────────────────────────────────────────────────────────────

/** (#33) Why neither layer 1 nor the review can judge `files` against the session's start, or null: the start
 *  of the checkout holding one is unknown (a worktree whose history no rule relates to the start, a session from
 *  before the start snapshot, a repo first seen during the session, a git error): nothing is judged against a
 *  guessed one and nothing passes on it. One reason for every such repo. A session with no pin at all (SessionStart
 *  never ran) keeps the old behavior: the base checks are skipped. Any error is a block. */
export function startProblem(sessionId: string, cwd: string, files?: readonly string[]): string | null {
  try {
    const reasons: string[] = [];
    for (const g of groupsOf(sessionId, cwd, files)) {
      if (g.start.unknown === undefined) continue;
      reasons.push(
        `The session's start for ${g.top} is unknown (${g.start.unknown}), so the gates cannot tell which changes there are this session's. ` +
          'No test result or review is accepted for changes judged against a guessed start, and none you could record changes that. ' +
          'Start a new session inside that checkout so its start is pinned, or ask the user to let this Stop pass once with their Stop approval marker.',
      );
    }
    return reasons.length === 0 ? null : reasons.join(' ');
  } catch (err) {
    return `The session's start could not be determined (${String(err).slice(0, 160)}), so the changes cannot be judged against it. Start a new session in this checkout, or ask the user to let this Stop pass once with their Stop approval marker.`;
  }
}

/** (#33) Why every full Stop judged in this checkout blocks whatever its edit list holds, or null: the first sight
 *  of a checkout could not list what changed in it before a hook saw it (more files than the cap, a git error,
 *  no HEAD in a repository that has history), so a change made by a shell command or a commit is in no list. Only
 *  the user's marker passes it, once per Stop; the stop_hook_active Stop ends the turn unverified with a warning.
 *  An error is a block, as in `startProblem`. (#39) The repos of the edit log. */
export function incompleteStartProblem(sessionId: string, cwd: string): string | null {
  const text = (where: string, why: string) =>
    `What changed in ${where} before the session's hooks first saw it could not be established (${why}), so no list of this session's ` +
    'changes there can be trusted, and every full Stop in it is blocked, whether or not you edited anything. No test result or review changes that. ' +
    'Start a new session inside that checkout so its start is pinned, or ask the user to let this Stop pass once with their Stop approval marker.';
  try {
    const reasons: string[] = [];
    for (const g of groupsOf(sessionId, cwd)) {
      if (g.unconfirmed) continue; // git did not answer for it: nothing more is asked of it (`startProblem` blocks it)
      const why = incompleteStart(sessionId, g.top);
      if (why !== null) reasons.push(text(g.top, why));
    }
    return reasons.length === 0 ? null : reasons.join(' ');
  } catch (err) {
    return text(cwd, `it could not be read: ${String(err).slice(0, 160)}`);
  }
}

/** (v0.36.6) The note a layer-1 block adds when some of its files differ from the session's start only because
 *  HEAD is on another line than the start (each equals its blob at the merge base): the block stands, and a
 *  session started on this branch does not count them. Empty when none, or on any error. */
export function branchNote(sessionId: string, cwd: string, files: readonly string[]): string {
  try {
    const notes: string[] = [];
    for (const g of groupsOf(sessionId, cwd, files)) {
      const rels = g.edits
        .map((f) => relative(g.top, resolvePath(f)))
        .filter((r) => r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
        .map((r) => r.split(sep).join('/'));
      const d = divergedFromStart(g.top, g.head, rels);
      if (d === null) continue;
      const shown = d.files.map((f) => nameIn(g, f));
      const list = shown.slice(0, 5).join(', ') + (shown.length > 5 ? ` and ${shown.length - 5} more` : '');
      notes.push(
        `Note: ${list} ${d.files.length === 1 ? 'is' : 'are'} an obligation only because HEAD (${d.head.slice(0, 12)}) is no longer on the line this session started from ` +
          `(${d.mergeBase.slice(0, 12)} is where they part): ${d.files.length === 1 ? 'it equals its' : 'they equal their'} version there, so the session did not change ` +
          `${d.files.length === 1 ? 'it' : 'them'}. This still blocks. A new session started on this branch does not count ${d.files.length === 1 ? 'it' : 'them'}.`,
      );
    }
    return notes.join(' ');
  } catch {
    return '';
  }
}

// ── Records as a group sees them ─────────────────────────────────────────────────────────────────

interface Treed {
  tree?: string | null;
  trees?: Record<string, string>;
}

/** A record as a group judges it (item 5). For a repo below a project dir that is no repo: the record with its
 *  `tree` replaced by `trees[realTop]`, or null where it has none, which freshness reads as unverified (a
 *  nested top is a repo: a record with no tree there is never judged by time). For every other group the
 *  record itself: it is judged as before. */
export function viewFor<R extends Treed>(r: R, g: Group): R {
  if (g.kind !== 'nested') return r;
  const t = r.trees !== null && typeof r.trees === 'object' && !Array.isArray(r.trees) && Object.hasOwn(r.trees, g.realTop) ? r.trees[g.realTop] : undefined;
  return { ...r, tree: typeof t === 'string' ? t : null };
}

export interface Judged<E, R> {
  g: Group;
  /** The group's edits, with what its records say about their current content. */
  edits: E[];
  /** The group's records: the records themselves in a repo, copies with the group's tree in a nested repo. Built
   *  once, and every check of the group takes them (freshness looks a record up by identity). */
  views: R[];
  /** A view → the record it is a view of. */
  origOf: Map<R, R>;
}

/** The record views and the edits with their content flags, per group, within a shared deadline (item 4).
 *  `onError` gives the edits when the content check itself fails (without it the error propagates). */
export function judgeGroups<E extends ChangedFileEdit, R extends Treed & Pick<TestResult, 'timestamp' | 'tree' | 'commit' | 'extra_blobs'>>(args: {
  sessionId: string;
  cwd: string;
  edits: E[];
  records: readonly R[];
  filesOf?: (r: R) => readonly unknown[] | undefined;
  deadline: Deadline;
  onError?: (edits: E[], views: R[]) => E[];
}): Judged<E, R>[] {
  const byFile = new Map(args.edits.map((e) => [e.file, e]));
  return groupsOf(args.sessionId, args.cwd, args.edits.map((e) => e.file)).map((g) => {
    const views = args.records.map((r) => viewFor(r, g));
    const origOf = new Map<R, R>(views.map((v, i) => [v, args.records[i]!]));
    const own = g.edits.map((f) => byFile.get(f)!);
    let edits: E[];
    try {
      edits = withSameContent(own, views, g.top, args.filesOf, { until: args.deadline.left });
    } catch (err) {
      if (!args.onError) throw err;
      edits = args.onError(own, views);
    }
    return { g, edits, views, origOf };
  });
}

/** The distinct reasons of several validations as one text, in order. */
export function joinReasons(reasons: readonly (string | undefined)[]): string | undefined {
  const distinct = [...new Set(reasons.filter((r): r is string => typeof r === 'string' && r !== ''))];
  return distinct.length === 0 ? undefined : distinct.join(' ');
}

/** The union of a coverage check run once per group (item 5): `validate` gets the group's views of the records and
 *  its edits; the records that were effective in any group come back as the records themselves (`origOf`, not
 *  their views), the reasons as one text (one per distinct text), and `ok` only when every group is ok. `parts`
 *  keeps each group's own answer (a caller that unions more of it, such as the review's lists). */
export function unionOverGroups<E, R, V extends { ok: boolean; reason?: string; effective: readonly R[] }>(
  judged: readonly Judged<E, R>[],
  validate: (views: R[], edits: E[]) => V,
): { ok: boolean; reason?: string; effective: R[]; parts: V[] } {
  const parts = judged.map((j) => validate(j.views, j.edits));
  const effective = new Set<R>();
  judged.forEach((j, i) => {
    for (const r of parts[i]!.effective) effective.add(j.origOf.get(r) ?? r);
  });
  const reason = joinReasons(parts.map((p) => p.reason));
  return { ok: parts.every((p) => p.ok), ...(reason !== undefined ? { reason } : {}), effective: [...effective], parts };
}

// ── What a group's repo holds that the Stop reads ───────────────────────────────────────────────

export type LinesOf = (file: string) => ReadonlySet<number> | null;

/** (#23) The forbidden-pattern scan's lines: per test file of the records, the lines added since the repo's
 *  start HEAD; none for a file that is its start blob. Every line counts for a file the diff does not show but
 *  that is not its start blob (assume-unchanged, a binary or ignored file, a symlink, a path spelled otherwise:
 *  security review), for a file outside the repo, and for all when the start is unknown, had no commit, or git
 *  fails. One diff and one blob comparison per evaluation. */
export function addedTestLines(cwd: string, top: string, head: string | null | undefined, testFiles: readonly string[]): LinesOf | undefined {
  if (typeof head !== 'string') return undefined;
  const relOf = (file: string): string | null => {
    const r = relative(top, resolvePath(cwd, file));
    return r === '' || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r) ? null : r.split(sep).join('/');
  };
  const rels = [...new Set(testFiles.filter((f) => typeof f === 'string').map(relOf).filter((r): r is string => r !== null))];
  // Only the test files (performance review: the whole diff read every untracked file).
  const changed = changedLines(top, head, rels);
  if (changed === null || 'error' in changed) return undefined;
  const unseen = new Set(rels.filter((r) => !changed.files.has(r)));
  const differ = differFromBase(top, head, [...unseen]);
  const none: ReadonlySet<number> = new Set();
  return (file) => {
    const r = relOf(file);
    if (r === null) return null;
    return changed.files.get(r) ?? (unseen.has(r) && !differ.has(r) ? none : null);
  };
}

/** The lines scan's `linesOf` for the test files of the records (item 3): one `addedTestLines` per repo, and
 *  a file asks the one of its own repo (its start and its diff); a file in no repo asks the project dir's. */
export function testLinesOf(sessionId: string, cwd: string, testFiles: readonly string[]): LinesOf | undefined {
  const top0 = projectTop(cwd);
  if (!isNoRepoProject(cwd)) return addedTestLines(cwd, top0, startOf(sessionId, cwd, top0).head, testFiles);
  const per = new Map<string, { top: string; files: string[] }>();
  const keyOf = (f: string): { key: string; top: string } => {
    const ref = repoOfFile(f, cwd, walkMemo);
    return { key: ref?.realTop ?? '', top: ref?.top ?? top0 };
  };
  for (const f of testFiles) {
    if (typeof f !== 'string' || f === '') continue;
    const { key, top } = keyOf(f);
    const p = per.get(key) ?? { top, files: [] };
    p.files.push(f);
    per.set(key, p);
  }
  const fns = new Map<string, LinesOf | undefined>();
  for (const [key, p] of per) fns.set(key, addedTestLines(cwd, p.top, startOf(sessionId, cwd, p.top).head, p.files));
  return (file) => fns.get(keyOf(file).key)?.(file) ?? null;
}

// ── Weakened tests, per group ────────────────────────────────────────────────────────────────────

const weakenedMemo = new Map<string, { g: Group; list: Weakened[] }[]>();

/** (I5) The start test files under the cwd that lost checks since each group's start HEAD, per repo of the
 *  edit log (once per Stop: the tree does not change while the hook runs, and the review gate and acceptReview
 *  both ask). A test's `rel` is named relative to the project dir. */
export function weakenedNow(sessionId: string, cwd: string): { g: Group; list: Weakened[] }[] {
  const key = `${sessionId}\0${cwd}`;
  const known = weakenedMemo.get(key);
  if (known) return known;
  let out: { g: Group; list: Weakened[] }[];
  try {
    out = groupsOf(sessionId, cwd).map((g) => ({ g, list: weakenedTests(g.top, g.head, cwd).map((w) => (g.kind === 'nested' ? { ...w, rel: nameIn(g, w.rel) } : w)) }));
  } catch {
    out = [];
  }
  weakenedMemo.set(key, out);
  return out;
}

// ── Test infrastructure, for the `auto` gate (item 9) ────────────────────────────────────────────

/** The repo dirs where a test runner counts for the `auto` test gate besides the project dir: in a project dir
 *  that is no repo, every repo the walk finds and every repo of an edit group; none otherwise. */
export function infrastructureDirs(sessionId: string, cwd: string): string[] {
  if (!isNoRepoProject(cwd)) return [];
  const key = `${sessionId}\0${cwd}`;
  let dirs = infraMemo.get(key);
  if (dirs === undefined) {
    const tops = new Set<string>(reposBelow(cwd).repos.map((r) => r.top));
    for (const g of groupsOf(sessionId, cwd)) if (g.kind === 'nested') tops.add(g.top);
    dirs = [...tops].sort();
    infraMemo.set(key, dirs);
  }
  return dirs;
}

/** `detectTestInfrastructure` for the project dir, then for each repo of `infrastructureDirs`. */
export function detectInfrastructure(sessionId: string, cwd: string): TestInfraSignal {
  const own = detectTestInfrastructure(cwd);
  if (own.present) return own;
  for (const dir of infrastructureDirs(sessionId, cwd)) {
    const s = detectTestInfrastructure(dir);
    if (s.present) return { present: true, evidence: `${relative(resolvePath(cwd), dir)}/${s.evidence}` };
  }
  return own;
}

// ── The review's trees, per repo (item 5) ────────────────────────────────────────────────────────

/** `treeContent` once per repo: each tree is asked about the files of one repo, with that repo's top and the
 *  time left of the shared deadline, and the answers are merged by the file's repo. A project dir that is a
 *  repo is one `treeContent` call, as before. */
export function treeContentByRepo(
  cwd: string,
  asks: ReadonlyMap<string, ReadonlySet<string>>,
  deadline: Deadline,
): (tree: string, abs: string) => boolean | undefined {
  const top0 = projectTop(cwd);
  if (!isNoRepoProject(cwd)) return treeContent(top0, asks, { until: deadline.left });
  const keyOf = (abs: string): { key: string; top: string } => {
    const ref = repoOfFile(abs, cwd, walkMemo);
    return { key: ref?.realTop ?? '', top: ref?.top ?? top0 };
  };
  const per = new Map<string, { top: string; asks: Map<string, Set<string>> }>();
  for (const [tree, files] of asks) {
    for (const abs of files) {
      const { key, top } = keyOf(abs);
      const p = per.get(key) ?? { top, asks: new Map<string, Set<string>>() };
      p.asks.set(tree, (p.asks.get(tree) ?? new Set<string>()).add(abs));
      per.set(key, p);
    }
  }
  const answers = new Map<string, (tree: string, abs: string) => boolean | undefined>();
  for (const [key, p] of per) answers.set(key, treeContent(p.top, p.asks, { until: deadline.left }));
  return (tree, abs) => answers.get(keyOf(abs).key)?.(tree, abs);
}

/** A file's repo for `currentFindings`: the real top of the repo below a project dir that is no repo, else null. */
export function repoOfFileFor(cwd: string): (abs: string) => string | null {
  return (abs) => nestedRepoOf(cwd, abs)?.realTop ?? null;
}

// ── Reasons ───────────────────────────────────────────────────────────────────────────────────────

/** A gap list's file names as the project dir names them (`be/src/x.ts`). */
export function namedGaps(out: GapsOut, g: Group): GapsOut {
  if (g.kind !== 'nested') return out;
  return { ...out, gaps: out.gaps.map((x) => ({ ...x, file: nameIn(g, x.file) })), ...(out.subprocess ? { subprocess: out.subprocess.map((f) => nameIn(g, f)) } : {}) };
}
