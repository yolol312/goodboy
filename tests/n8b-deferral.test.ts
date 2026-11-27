// N8b (plan §20.12, #44 item 2): a review or a test the user defers to the next push. The units, with real temp
// repos and the library read in this process (the Stop and PreToolUse hooks are spawned in
// tests/n8b-deferral-stop.test.ts and tests/n8b-deferral-push.test.ts; the keys and the status line are in
// tests/n8b-deferral-keys.test.ts):
//   AC-2  deferGlobs: the file's globs when no tool wrote a policy file this session, the pinned ones when one did;
//   AC-3  deferMatcher: a glob matches from the project dir and from a repo top; no glob matches nothing;
//   AC-5  the Stop's file sets: layer 1 and the review gate leave the deferred files out (stop-groups);
//   AC-6  deferredDueAtPush and its message, with real git and the seams;
//   AC-6b passingForTree and realRepoTop (lib/push-test.ts).
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import {
  commitOf,
  deferGlobs,
  deferMatcher,
  deferredDueAtPush,
  deferredDueMessage,
  type DeferredDue,
  type PushDeferralInput,
  MAX_PUSH_FILES,
  notePolicySeen,
  objectIds,
  policyWrittenThisSession,
  remoteTips,
  pushDeferGlobs,
  unpushedFiles,
  watchPolicy,
} from '../lib/deferral';
import * as deferral from '../lib/deferral';
import { getCurrentTurn, recordEdit } from '../lib/file-tracker';
import { passingForTree, pushRemoteOf, realRepoTop, revisionTree } from '../lib/push-test';
import { deferMatchOf, deferredTestEdits, resetStopGroups, reviewGateEdits, testEditsByGroup } from '../lib/stop-groups';
import type { ReviewResult, TestResult } from '../lib/types';

setDefaultTimeout(90_000);

const dirs: string[] = [];
afterEach(() => {
  resetStopGroups();
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-n8b-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
let counter = 0;
function sessionId(): string {
  const s = `n8bu${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

/** A policy file text: one `decide: human` entry (or `ai`) with the given keys. */
const policy = (globs: Record<string, string>, decide = 'human'): string =>
  ['## P1 Deferrals', `- decide: ${decide}`, '- source: user 2026-11-26', ...Object.entries(globs).map(([k, v]) => `- ${k}: ${v}`), ''].join('\n');

const V1 = 'export const a = 1;\n';
const V2 = 'export const a = 1;\nexport const b = 2;\n';

// ── AC-2 ────────────────────────────────────────────────────────────────────────────────────────

describe('AC-2: deferGlobs', () => {
  function started(globs: Record<string, string>): { d: string; s: string } {
    const d = tmp();
    sh(d, GIT_INIT);
    write(d, '.goodboy/policy.md', policy(globs));
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const s = sessionId();
    pinCoverageStart(s, d);
    notePolicySeen(s, d); // the session start: the file as it is now is the user's
    return { d, s };
  }

  test('no globs in the file: nothing, and the edit log is not asked', () => {
    const { d, s } = started({ 'coverage-exempt': 'x/**' });
    expect(deferGlobs(s, d, d, 'defer-test', () => { throw new Error('asked'); })).toEqual({ globs: [], waiting: [] });
  });

  test('no policy-file write this session: the file\'s current globs count, a glob added after the start too', () => {
    const { d, s } = started({ 'defer-test': 'src/a.ts' });
    write(d, '.goodboy/policy.md', policy({ 'defer-test': 'src/a.ts, src/b.ts' }));
    expect(deferGlobs(s, d, d, 'defer-test', () => false)).toEqual({ globs: ['src/a.ts', 'src/b.ts'], waiting: [] });
    // The default reader is the real edit log: a code edit is no policy write.
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    expect(deferGlobs(s, d, d, 'defer-test')).toEqual({ globs: ['src/a.ts', 'src/b.ts'], waiting: [] });
  });

  test('a policy-file write this session: the pinned globs only, the rest wait', () => {
    const { d, s } = started({ 'defer-test': 'src/a.ts', 'defer-review': 'docs/**' });
    write(d, '.goodboy/policy.md', policy({ 'defer-test': 'src/a.ts, src/b.ts', 'defer-review': 'docs/**' }));
    expect(deferGlobs(s, d, d, 'defer-test', () => true)).toEqual({ globs: ['src/a.ts'], waiting: ['src/b.ts'] });
    expect(deferGlobs(s, d, d, 'defer-review', () => true)).toEqual({ globs: ['docs/**'], waiting: [] });
    // The real edit log: a recorded edit of the policy file (any spelling of the name) is a write.
    recordEdit(s, join(d, '.goodboy', 'policy.md'), 0, undefined, Date.now());
    expect(deferGlobs(s, d, d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: ['src/b.ts'] });
  });

  test('a session that never started has no pin: a glob the file gained counts only through the file age rule', () => {
    const d = tmp();
    sh(d, GIT_INIT);
    write(d, '.goodboy/policy.md', policy({ 'defer-test': 'src/a.ts' }));
    const s = sessionId();
    // Written before the session dir exists: the file is older than the session; a policy write then waits for nothing.
    expect(deferGlobs(s, d, d, 'defer-test', () => false).globs).toEqual(['src/a.ts']);
  });

  test('policyWrittenThisSession: false with no edits or a code edit, true for a policy edit and for an unreadable log', () => {
    const d = tmp();
    const s = sessionId();
    notePolicySeen(s, d); // the watch has a record to compare with (none: the file counts as written)
    expect(policyWrittenThisSession(s)).toBe(false);
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    expect(policyWrittenThisSession(s)).toBe(false);
    // A policy.md that is not in a .goodboy dir is no policy file.
    recordEdit(s, join(d, 'docs', 'policy.md'), 0, undefined, Date.now());
    expect(policyWrittenThisSession(s)).toBe(false);
    recordEdit(s, join(d, '.goodboy', 'POLICY.MD'), 0, undefined, Date.now());
    expect(policyWrittenThisSession(s)).toBe(true);
    const broken = (() => {
      throw new Error('log unreadable');
    }) as unknown as Parameters<typeof policyWrittenThisSession>[1];
    expect(policyWrittenThisSession(sessionId(), broken)).toBe(true);
  });
});

// ── AC-3 ────────────────────────────────────────────────────────────────────────────────────────

describe('AC-3: deferMatcher', () => {
  test('no globs: any is false and nothing matches', () => {
    const m = deferMatcher([], '/p');
    expect(m.any).toBe(false);
    expect(m.test('/p/src/a.ts')).toBe(false);
    expect(m.test('/p/src/a.ts', '/p')).toBe(false);
  });

  test('a glob matches the name from the project dir', () => {
    const m = deferMatcher(['src/**', 'docs/*.md'], '/p');
    expect(m.any).toBe(true);
    expect(m.test('/p/src/deep/a.ts')).toBe(true);
    expect(m.test('/p/docs/x.md')).toBe(true);
    expect(m.test('/p/lib/a.ts')).toBe(false);
    expect(m.test('/p/docs/x.txt')).toBe(false);
  });

  test('a nested repo\'s file matches a glob written for the repo only with the repo top, and one written for the project dir without it', () => {
    const forRepo = deferMatcher(['src/**'], '/p');
    expect(forRepo.test('/p/be/src/a.ts')).toBe(false);
    expect(forRepo.test('/p/be/src/a.ts', '/p/be')).toBe(true);
    const forProject = deferMatcher(['be/src/**'], '/p');
    expect(forProject.test('/p/be/src/a.ts')).toBe(true);
    expect(forProject.test('/p/be/src/a.ts', '/p/be')).toBe(true);
  });

  test('a file outside the project dir (and outside the given top) never matches, and neither does the dir itself', () => {
    const m = deferMatcher(['**'], '/p/proj');
    expect(m.test('/p/other/a.ts')).toBe(false);
    expect(m.test('/p/proj')).toBe(false);
    expect(m.test('/p/proj/../other/a.ts')).toBe(false);
    expect(m.test('/p/other/a.ts', '/p/other')).toBe(true); // inside the given repo top
    expect(m.test('/p/other/a.ts', '/p/proj')).toBe(false);
    expect(m.test('/elsewhere/a.ts', '/p/proj')).toBe(false);
    // A name that starts with `..` but is a plain dir name is inside.
    expect(m.test('/p/proj/..odd/a.ts')).toBe(true);
  });
});

// ── AC-5 (stop-groups): the sets the Stop judges ────────────────────────────────────────────────

describe('stop-groups: layer 1 and the review gate leave the deferred files out', () => {
  /** A repo with src/a.ts, src/b.ts and docs/x.md committed, a policy, and the session pinned. */
  function world(globs: Record<string, string>, edit = true): { d: string; s: string; a: string; b: string; md: string } {
    const d = tmp();
    sh(d, GIT_INIT);
    write(d, 'src/a.ts', V1);
    write(d, 'src/b.ts', V1);
    write(d, 'docs/x.md', '# x\n');
    write(d, '.goodboy/policy.md', policy(globs));
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const s = sessionId();
    pinCoverageStart(s, d);
    notePolicySeen(s, d);
    const a = join(d, 'src', 'a.ts');
    const b = join(d, 'src', 'b.ts');
    const md = join(d, 'docs', 'x.md');
    if (edit) {
      for (const f of [a, b]) writeFileSync(f, V2);
      writeFileSync(md, '# x\nmore\n');
      for (const f of [a, b, md]) recordEdit(s, f, getCurrentTurn(s), undefined, Date.now());
    }
    return { d, s, a, b, md };
  }
  const filesOf = (s: string, d: string, turn = 0): string[] => testEditsByGroup(s, d, turn).flatMap((g) => g.files).sort();

  test('no defer-test glob: both code files are asked about and nothing is deferred', () => {
    const w = world({ 'defer-review': 'docs/**' });
    expect(filesOf(w.s, w.d)).toEqual([w.a, w.b].sort());
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([]);
  });

  test('defer-test: the matched code file is left out of layer 1 and listed as deferred; the unmatched one stays', () => {
    const w = world({ 'defer-test': 'src/a.ts' });
    expect(filesOf(w.s, w.d)).toEqual([w.b]);
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([w.a]);
  });

  test('a deferred file that is no code (a doc) is no test obligation to defer; a deferred file restored to its start is no change', () => {
    const w = world({ 'defer-test': 'src/a.ts, docs/**' });
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([w.a]);
    writeFileSync(w.a, V1); // the start content again
    resetStopGroups();
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([]);
    expect(filesOf(w.s, w.d)).toEqual([w.b]);
  });

  test('the sets are read once per Stop: a policy change between calls is not seen until resetStopGroups', () => {
    const w = world({ 'defer-test': 'src/a.ts' });
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([w.a]);
    write(w.d, '.goodboy/policy.md', policy({ 'defer-test': 'src/b.ts' }));
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([w.a]);
    expect(deferMatchOf(w.s, w.d, 'defer-test')).toBe(deferMatchOf(w.s, w.d, 'defer-test'));
    resetStopGroups();
    // No tool wrote the policy file in this session, so the file as it is now counts: it names src/b.ts.
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([w.b]);
    // Once a tool has written it, only the pinned src/a.ts counts, and src/b.ts waits for the next session.
    recordEdit(w.s, join(w.d, '.goodboy', 'policy.md'), 0, undefined, Date.now());
    resetStopGroups();
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([]);
    expect(deferMatchOf(w.s, w.d, 'defer-test').waiting).toEqual(['src/b.ts']);
  });

  test('another cursor turn is its own set', () => {
    const w = world({ 'defer-test': 'src/a.ts' }, false);
    writeFileSync(w.a, V2);
    recordEdit(w.s, w.a, 0, undefined, Date.now());
    writeFileSync(w.b, V2);
    recordEdit(w.s, w.b, 5, undefined, Date.now());
    expect(deferredTestEdits(w.s, w.d, 0)).toEqual([w.a]);
    expect(deferredTestEdits(w.s, w.d, 5)).toEqual([]);
    expect(filesOf(w.s, w.d, 5)).toEqual([w.b]);
  });

  test('deferMatchOf: the waiting globs of a session that wrote the policy file; no glob: any is false', () => {
    const w = world({ 'defer-test': 'src/a.ts' }, false);
    write(w.d, '.goodboy/policy.md', policy({ 'defer-test': 'src/a.ts, src/b.ts' }));
    recordEdit(w.s, join(w.d, '.goodboy', 'policy.md'), 0, undefined, Date.now());
    const m = deferMatchOf(w.s, w.d, 'defer-test');
    expect(m.waiting).toEqual(['src/b.ts']);
    expect(m.match.test(w.a)).toBe(true);
    expect(m.match.test(w.b)).toBe(false);
    expect(deferMatchOf(w.s, w.d, 'defer-review').match.any).toBe(false);
    expect(deferMatchOf(w.s, w.d, 'defer-review').waiting).toEqual([]);
  });

  test('deferMatchOf: a policy that cannot be read defers nothing', () => {
    const w = world({ 'defer-test': 'src/a.ts' }, false);
    // The lookup throws (no input makes the real one throw, so it is replaced for this call): the gates then judge
    // every file, as before N8b.
    const spy = spyOn(deferral, 'deferGlobs').mockImplementation(() => {
      throw new Error('policy unreadable');
    });
    try {
      const m = deferMatchOf(w.s, w.d, 'defer-test');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(m.match.any).toBe(false);
      expect(m.match.test(w.a)).toBe(false);
      expect(m.waiting).toEqual([]);
    } finally {
      spy.mockRestore();
      resetStopGroups();
    }
    expect(deferMatchOf(w.s, w.d, 'defer-test').match.any).toBe(true); // the real lookup again
  });

  test('reviewGateEdits: no glob keeps every edit; a glob splits them, the doc stays with the review', () => {
    const none = world({ 'defer-test': 'src/a.ts' });
    const all = reviewGateEdits(none.s, none.d, 0);
    expect(all.edits.map((e) => e.file).sort()).toEqual([none.a, none.b, none.md].sort());
    expect(all.deferred).toEqual([]);

    const w = world({ 'defer-review': 'src/a.ts' });
    const split = reviewGateEdits(w.s, w.d, 0);
    expect(split.deferred).toEqual([w.a]);
    expect(split.edits.map((e) => e.file).sort()).toEqual([w.b, w.md].sort());
  });

  test('reviewGateEdits: a glob that matches no edited file leaves the set whole; no edit at all is empty', () => {
    const w = world({ 'defer-review': 'lib/**' });
    const r = reviewGateEdits(w.s, w.d, 0);
    expect(r.deferred).toEqual([]);
    expect(r.edits).toHaveLength(3);
    const quiet = world({ 'defer-review': 'src/**' }, false);
    expect(reviewGateEdits(quiet.s, quiet.d, 0)).toEqual({ edits: [], deferred: [] });
  });

  test('reviewGateEdits: every edited file deferred leaves no review edit', () => {
    const w = world({ 'defer-review': 'src/**, docs/**' });
    const r = reviewGateEdits(w.s, w.d, 0);
    expect(r.edits).toEqual([]);
    expect(r.deferred.sort()).toEqual([w.a, w.b, w.md].sort());
  });

  test('a project dir that is a plain folder of repos: a glob written for a repo matches its files, one for the project dir does too', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    mkdirSync(proj);
    for (const r of ['be', 'fe']) {
      const dir = join(proj, r);
      write(dir, 'src/a.ts', V1);
      sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
    }
    write(proj, '.goodboy/policy.md', policy({ 'defer-review': 'src/**', 'defer-test': 'fe/src/a.ts' }));
    const s = sessionId();
    pinCoverageStart(s, proj);
    notePolicySeen(s, proj);
    const be = join(proj, 'be', 'src', 'a.ts');
    const fe = join(proj, 'fe', 'src', 'a.ts');
    for (const f of [be, fe]) {
      writeFileSync(f, V2);
      recordEdit(s, f, getCurrentTurn(s), undefined, Date.now());
    }
    // `src/**` written for the repos matches both repos' files (from each repo's top).
    const rv = reviewGateEdits(s, proj, 0);
    expect(rv.edits).toEqual([]);
    expect(rv.deferred.sort()).toEqual([be, fe].sort());
    // `fe/src/a.ts` is written for the project dir: only fe's file is deferred from layer 1.
    expect(deferredTestEdits(s, proj, 0)).toEqual([fe]);
    expect(testEditsByGroup(s, proj, 0).flatMap((g) => g.files)).toEqual([be]);
  });
});

// ── AC-6: what a push still owes ────────────────────────────────────────────────────────────────

const hex = (c: string): string => c.repeat(40);

interface Repo {
  d: string;
  /** The bare remote `origin` has the commit before the unpushed work. */
  bare: string;
  push: (rev?: string) => Pick<PushDeferralInput, 'cwd' | 'top' | 'realTop' | 'projectDir' | 'rev' | 'defaultRemote'>;
}

/** A local bare repo as the remote `origin` of `dir` (the work tree's branch `main` pushed to it): what the push check
 *  reads with `git ls-remote`, no network. Returns the bare repo's path. */
function addOrigin(dir: string): string {
  const bare = join(tmp('goodboy-n8b-bare-'), 'origin.git');
  sh(dir, `git init -q --bare ${JSON.stringify(bare)} && git remote add origin ${JSON.stringify(bare)} && git push -q origin main`);
  return bare;
}

/** A repo whose remote `origin` (a local bare repo) has the first commit; `commit(files, msg)` adds commits on top (unpushed). */
function repo(initial: Record<string, string> = {}): Repo & { commit: (files: Record<string, string | null>, msg?: string) => string } {
  const d = tmp();
  write(d, 'README.md', 'x\n');
  for (const [p, t] of Object.entries(initial)) write(d, p, t);
  sh(d, `${GIT_INIT} && git add -A && git commit -q -m init`);
  const bare = addOrigin(d);
  const commit = (files: Record<string, string | null>, msg = 'work'): string => {
    for (const [p, t] of Object.entries(files)) {
      if (t === null) rmSync(join(d, p), { force: true });
      else write(d, p, t);
    }
    sh(d, `git add -A && git commit -q -m ${msg}`);
    return sh(d, 'git rev-parse HEAD');
  };
  return {
    d,
    bare,
    commit,
    push: (rev = 'HEAD') => ({ cwd: d, top: d, realTop: d, projectDir: d, rev, defaultRemote: pushRemoteOf }),
  };
}
const treeOfCommit = (d: string, rev: string): string => sh(d, `git rev-parse ${rev}^{tree}`);

const testRecord = (...files: string[]): TestResult => ({ tested_files: files, verdict: 'pass' }) as unknown as TestResult;
function reviewRecord(over: Record<string, unknown>): ReviewResult {
  return { timestamp: new Date().toISOString(), reviewed_files: [], category: 'add-feature', findings: [], unknown_assumptions_checked: [], verdict: 'pass', ...over } as unknown as ReviewResult;
}
const finding = (file: string, severity: string) => ({ severity, file, issue: 'x', suggestion: 'y' });

function due(r: ReturnType<typeof repo>, o: Partial<PushDeferralInput>): DeferredDue | null {
  return deferredDueAtPush({
    ...r.push(),
    testMatch: deferMatcher([], r.d),
    reviewMatch: deferMatcher([], r.d),
    passing: [],
    reviews: [],
    ...o,
  });
}

describe('AC-6: deferredDueAtPush, tests', () => {
  test('nothing deferred: null, without asking git', () => {
    const r = repo();
    const boom = () => {
      throw new Error('git asked');
    };
    expect(due(r, { files: boom, ids: boom })).toBeNull();
  });

  test('a deferred test file with no passing record that lists it is owed; one that lists it clears it', () => {
    const r = repo({ 'src/a.ts': V1 });
    r.commit({ 'src/a.ts': V2, 'src/other.ts': V1 });
    const testMatch = deferMatcher(['src/a.ts'], r.d);
    const a = join(r.d, 'src', 'a.ts');
    expect(due(r, { testMatch })).toEqual({ test: ['src/a.ts'], review: [] });
    expect(due(r, { testMatch, passing: [testRecord(join(r.d, 'src', 'other.ts'))] })).toEqual({ test: ['src/a.ts'], review: [] });
    expect(due(r, { testMatch, passing: [testRecord(a)] })).toBeNull();
    // Any passing record of the tree that lists it, not the newest only.
    expect(due(r, { testMatch, passing: [testRecord('/elsewhere/x.ts'), testRecord(a)] })).toBeNull();
  });

  test('only the files the push sends are asked: an unmatched file, and a matched one the remote already has, are not', () => {
    const r = repo({ 'src/old.ts': V1 });
    r.commit({ 'src/old.ts': V2 }); // matched, unpushed
    sh(r.d, 'git push -q origin main'); // now on the remote
    r.commit({ 'src/new.ts': V1, 'docs/x.md': 'd\n' });
    const testMatch = deferMatcher(['src/old.ts', 'docs/**'], r.d);
    expect(due(r, { testMatch })).toEqual({ test: ['docs/x.md'], review: [] });
    expect(due(r, { testMatch: deferMatcher(['src/old.ts'], r.d) })).toBeNull();
  });

  test('a file the push deletes owes nothing', () => {
    const r = repo({ 'src/a.ts': V1, 'src/b.ts': V1 });
    r.commit({ 'src/a.ts': V2 });
    r.commit({ 'src/a.ts': null });
    const both = { testMatch: deferMatcher(['src/a.ts'], r.d), reviewMatch: deferMatcher(['src/a.ts'], r.d) };
    expect(due(r, both)).toBeNull();
    // The same file kept (not deleted at the pushed rev) is owed.
    r.commit({ 'src/a.ts': V1 });
    expect(due(r, both)).toEqual({ test: ['src/a.ts'], review: [{ file: 'src/a.ts', why: 'no-review' }] });
  });

  test('the nested repo\'s name: a glob written for the repo matches, a record lists the absolute path', () => {
    const base = tmp();
    const be = join(base, 'proj', 'be');
    write(be, 'src/a.ts', V1);
    sh(be, `${GIT_INIT} && git add -A && git commit -q -m init`);
    addOrigin(be);
    write(be, 'src/a.ts', V2);
    sh(be, 'git add -A && git commit -q -m work');
    const input = { cwd: be, top: be, realTop: be, projectDir: join(base, 'proj'), rev: 'HEAD', defaultRemote: pushRemoteOf } as const;
    const testMatch = deferMatcher(['src/**'], join(base, 'proj'));
    expect(deferredDueAtPush({ ...input, testMatch, reviewMatch: deferMatcher([], be), passing: [], reviews: [] })).toEqual({ test: ['src/a.ts'], review: [] });
    expect(deferredDueAtPush({ ...input, testMatch, reviewMatch: deferMatcher([], be), passing: [testRecord(join(be, 'src', 'a.ts'))], reviews: [] })).toBeNull();
  });
});

describe('AC-6: deferredDueAtPush, reviews', () => {
  /** v1 committed at origin/main, v2 pushed; the review matcher holds src/a.ts. */
  function setup() {
    const r = repo({ 'src/a.ts': V1 });
    const v1Tree = treeOfCommit(r.d, 'HEAD');
    r.commit({ 'src/a.ts': V2 });
    const v2Tree = treeOfCommit(r.d, 'HEAD');
    return { r, v1Tree, v2Tree, a: join(r.d, 'src', 'a.ts'), reviewMatch: deferMatcher(['src/a.ts'], r.d) };
  }

  test('no review: owed as no-review', () => {
    const { r, reviewMatch } = setup();
    expect(due(r, { reviewMatch })).toEqual({ test: [], review: [{ file: 'src/a.ts', why: 'no-review' }] });
  });

  test('a clean review of exactly the pushed content clears it, whatever the other files in its tree', () => {
    const { r, reviewMatch, v2Tree, a } = setup();
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: v2Tree, reviewed_files: [a] })] })).toBeNull();
    // A review made on a tree that differs elsewhere but holds the same blob of the file counts too.
    r.commit({ 'other.txt': 'o\n' });
    const later = treeOfCommit(r.d, 'HEAD');
    expect(later).not.toBe(v2Tree);
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: v2Tree, reviewed_files: [a] })] })).toBeNull();
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: later, reviewed_files: [a] })] })).toBeNull();
  });

  test('a review of other content does not count: the older content, or a review that does not list the file', () => {
    const { r, reviewMatch, v1Tree, v2Tree, a } = setup();
    const owed: DeferredDue = { test: [], review: [{ file: 'src/a.ts', why: 'no-review' }] };
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: v1Tree, reviewed_files: [a] })] })).toEqual(owed);
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: v2Tree, reviewed_files: [join(r.d, 'src', 'zzz.ts')] })] })).toEqual(owed);
    // A record with no usable tree is skipped; the tree id must be a git object id.
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: null, reviewed_files: [a] }), reviewRecord({ tree: 'not-a-tree', reviewed_files: [a] }), reviewRecord({ reviewed_files: [a] })] })).toEqual(owed);
    // A tree that is not in the repo names no blob.
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: hex('d'), reviewed_files: [a] })] })).toEqual(owed);
  });

  test('a covering review with a high finding on the file owes it as high, whichever review is newer', () => {
    const { r, reviewMatch, v2Tree, a } = setup();
    const clean = reviewRecord({ tree: v2Tree, reviewed_files: [a] });
    const withHigh = reviewRecord({ tree: v2Tree, reviewed_files: [a], findings: [finding(a, 'high')], verdict: 'needs-changes' });
    const expected: DeferredDue = { test: [], review: [{ file: 'src/a.ts', why: 'high' }] };
    expect(due(r, { reviewMatch, reviews: [withHigh] })).toEqual(expected);
    expect(due(r, { reviewMatch, reviews: [clean, withHigh] })).toEqual(expected);
    expect(due(r, { reviewMatch, reviews: [withHigh, clean] })).toEqual(expected);
    // The finding names the file by a relative path from the project dir.
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: v2Tree, reviewed_files: [a], findings: [finding('src/a.ts', 'high')] })] })).toEqual(expected);
  });

  test('a finding that is not high, or is on another file, or malformed, owes nothing', () => {
    const { r, reviewMatch, v2Tree, a } = setup();
    for (const findings of [[finding(a, 'medium')], [finding(join(r.d, 'src', 'other.ts'), 'high')], [{ severity: 'high' }], [null], undefined]) {
      expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree: v2Tree, reviewed_files: [a], findings })] })).toBeNull();
    }
  });

  test('the newest covering verdict fail owes it; an older fail under a newer pass does not', () => {
    const { r, reviewMatch, v2Tree, a } = setup();
    const pass = reviewRecord({ tree: v2Tree, reviewed_files: [a], verdict: 'pass' });
    const fail = reviewRecord({ tree: v2Tree, reviewed_files: [a], verdict: 'fail' });
    expect(due(r, { reviewMatch, reviews: [fail, pass] })).toEqual({ test: [], review: [{ file: 'src/a.ts', why: 'fail' }] });
    expect(due(r, { reviewMatch, reviews: [pass, fail] })).toBeNull();
  });

  test('two deferred files: each is judged by its own coverage', () => {
    const r = repo({ 'src/a.ts': V1, 'src/b.ts': V1 });
    r.commit({ 'src/a.ts': V2, 'src/b.ts': V2 });
    const tree = treeOfCommit(r.d, 'HEAD');
    const reviewMatch = deferMatcher(['src/*.ts'], r.d);
    const a = join(r.d, 'src', 'a.ts');
    expect(due(r, { reviewMatch, reviews: [reviewRecord({ tree, reviewed_files: [a] })] })).toEqual({ test: [], review: [{ file: 'src/b.ts', why: 'no-review' }] });
  });

  test('a nested repo\'s review is read by its tree under the repo\'s real top, not by `tree`', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    const be = join(proj, 'be');
    write(be, 'src/a.ts', V1);
    sh(be, `${GIT_INIT} && git add -A && git commit -q -m init`);
    addOrigin(be);
    write(be, 'src/a.ts', V2);
    sh(be, 'git add -A && git commit -q -m work');
    const beTree = sh(be, 'git rev-parse HEAD^{tree}');
    const a = join(be, 'src', 'a.ts');
    const input = { cwd: be, top: be, realTop: be, projectDir: proj, rev: 'HEAD', defaultRemote: pushRemoteOf, testMatch: deferMatcher([], proj), reviewMatch: deferMatcher(['be/src/**'], proj), passing: [] } as const;
    const reviews = [reviewRecord({ tree: hex('a'), trees: { [be]: beTree }, reviewed_files: [a] })];
    expect(deferredDueAtPush({ ...input, reviews })).toBeNull();
    // Another repo's entry, or a malformed `trees`, falls back to `tree` (not a repo object here).
    expect(deferredDueAtPush({ ...input, reviews: [reviewRecord({ tree: hex('a'), trees: { [join(proj, 'fe')]: beTree }, reviewed_files: [a] })] })).toEqual({ test: [], review: [{ file: 'src/a.ts', why: 'no-review' }] });
    expect(deferredDueAtPush({ ...input, reviews: [reviewRecord({ tree: beTree, trees: null as unknown as Record<string, string>, reviewed_files: [a] })] })).toBeNull();
  });
});

describe('AC-6: git failures, caps and the message', () => {
  test('git cannot list the files: unknown, naming the rev', () => {
    const d = tmp(); // no repo
    const r = deferredDueAtPush({ cwd: d, top: d, realTop: d, projectDir: d, rev: 'HEAD', defaultRemote: pushRemoteOf, testMatch: deferMatcher(['**'], d), reviewMatch: deferMatcher([], d), passing: [], reviews: [] });
    expect(r?.unknown).toBe('git could not resolve HEAD');
    expect(r).toMatchObject({ test: [], review: [] });
    const seam = repo();
    expect(due(seam, { testMatch: deferMatcher(['**'], seam.d), files: () => null })?.unknown).toContain('could not list');
    expect(due(seam, { testMatch: deferMatcher(['**'], seam.d), commit: () => null })?.unknown).toBe('git could not resolve HEAD');
  });

  test('git cannot read the files pushed: unknown; nothing matched: null without reading', () => {
    const r = repo();
    r.commit({ 'src/a.ts': V1 });
    const testMatch = deferMatcher(['src/a.ts'], r.d);
    expect(due(r, { testMatch, ids: () => null })).toMatchObject({ test: [], review: [], unknown: 'git could not read the files HEAD sends' });
    expect(due(r, { testMatch: deferMatcher(['zzz/**'], r.d), ids: () => { throw new Error('read'); } })).toBeNull();
  });

  test('git cannot read the reviewed trees: unknown, keeping the tests owed', () => {
    const r = repo();
    r.commit({ 'src/a.ts': V1 });
    const tree = treeOfCommit(r.d, 'HEAD');
    const a = join(r.d, 'src', 'a.ts');
    let calls = 0;
    const ids = (cwd: string, specs: readonly string[]) => (++calls === 1 ? objectIds(cwd, specs) : null);
    const out = due(r, { testMatch: deferMatcher(['src/a.ts'], r.d), reviewMatch: deferMatcher(['src/a.ts'], r.d), reviews: [reviewRecord({ tree, reviewed_files: [a] })], ids });
    expect(out).toEqual({ test: ['src/a.ts'], review: [], unknown: 'git could not read the reviewed trees' });
  });

  test('a review that covers no deferred file never asks git about trees', () => {
    const r = repo();
    r.commit({ 'src/a.ts': V1 });
    let calls = 0;
    const ids = (cwd: string, specs: readonly string[]) => (calls++, objectIds(cwd, specs));
    const out = due(r, { reviewMatch: deferMatcher(['src/a.ts'], r.d), reviews: [reviewRecord({ tree: hex('a'), reviewed_files: ['/x/y.ts'] })], ids });
    expect(out).toEqual({ test: [], review: [{ file: 'src/a.ts', why: 'no-review' }] });
    expect(calls).toBe(1);
  });

  test('unpushedFiles: the names changed in the commits no remote ref has, deduplicated; null outside a repo', () => {
    const r = repo({ 'src/a.ts': V1 });
    r.commit({ 'src/a.ts': V2, 'weird name.ts': V1 });
    r.commit({ 'src/a.ts': V1, 'src/new.ts': V1 });
    const head = sh(r.d, 'git rev-parse HEAD');
    const first = sh(r.d, 'git rev-parse origin/main');
    expect(unpushedFiles(r.d, head, [first])?.sort()).toEqual(['src/a.ts', 'src/new.ts', 'weird name.ts']);
    expect(unpushedFiles(r.d, first, [first])).toEqual([]);
    expect(unpushedFiles(r.d, head, [head])).toEqual([]);
    // With no tip, every commit counts as sent.
    expect(unpushedFiles(r.d, head, [])?.sort()).toEqual(['README.md', 'src/a.ts', 'src/new.ts', 'weird name.ts']);
    expect(unpushedFiles(tmp(), head, [])).toBeNull();
    // Only object ids are taken: a name (or an option) is never passed on to git, as a commit or as a tip.
    expect(unpushedFiles(r.d, 'HEAD', [first])).toBeNull();
    expect(unpushedFiles(r.d, '--output=/x', [])).toBeNull();
    expect(unpushedFiles(r.d, head, ['--output=/x'])).toBeNull();
    expect(unpushedFiles(r.d, head, ['HEAD\n'])).toBeNull();
  });

  test('unpushedFiles: more than MAX_PUSH_FILES names cannot be judged (null), exactly MAX_PUSH_FILES can', () => {
    const r = repo();
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_PUSH_FILES; i++) files[`many/f${i}.txt`] = 'x\n';
    const head = r.commit(files);
    const tips = remoteTips(r.d, undefined, pushRemoteOf)![0]!;
    expect(unpushedFiles(r.d, head, tips)).toHaveLength(MAX_PUSH_FILES);
    const over = r.commit({ 'many/one-more.txt': 'x\n' });
    expect(unpushedFiles(r.d, over, tips)).toBeNull();
  });

  test('objectIds: a blob id per spec, null for a missing path, null overall for a line break or when git fails', () => {
    const r = repo({ 'src/a.ts': V1 });
    const blob = sh(r.d, 'git rev-parse HEAD:src/a.ts');
    const got = objectIds(r.d, ['HEAD:src/a.ts', 'HEAD:src/missing.ts', 'HEAD:src']);
    expect(got?.get('HEAD:src/a.ts')).toBe(blob);
    expect(got?.get('HEAD:src/missing.ts')).toBeNull();
    expect(got?.get('HEAD:src')).toBeNull(); // a tree, not a blob
    // A repeated spec is asked once and answered for each.
    expect(objectIds(r.d, ['HEAD:src/a.ts', 'HEAD:src/a.ts'])?.get('HEAD:src/a.ts')).toBe(blob);
    // A spec with a line break cannot be asked (it would split the batch): the call cannot answer, so it is not read as
    // a deleted file (the whole call is null, also when other specs are askable, and with no git call at all).
    expect(objectIds(r.d, ['HEAD:src/a.ts', 'HEAD:bad\nname'])).toBeNull();
    expect(objectIds(r.d, ['HEAD:bad\rname'])).toBeNull();
    expect(objectIds(tmp(), ['HEAD:a\nb'])).toBeNull();
    expect(objectIds(tmp(), [])?.size).toBe(0);
    expect(objectIds(tmp(), ['HEAD:a'])).toBeNull();
  });

  test('deferredDueMessage: the head, the tests, the reviews, the high findings, and "and N more"', () => {
    const head = 'git push sends files whose review or tests the user deferred to the push';
    const t = deferredDueMessage('git push', { test: ['a.ts'], review: [] }, 'the test agent');
    expect(t).toContain(head);
    expect(t).toContain('tests: a.ts (no passing layer-1 record of the pushed tree lists them; run the test agent on them)');
    expect(t).not.toContain('review:');
    const r = deferredDueMessage('git push', { test: [], review: [{ file: 'b.ts', why: 'no-review' }, { file: 'c.ts', why: 'high' }] }, 'x');
    expect(r).toContain('review: b.ts (no review of the content pushed; run the `review-axes` plan on them)');
    expect(r).toContain('review: c.ts (an open high finding on the content pushed; fix it and review again)');
    expect(r).toContain('Then push again. (deferral due at push, N8b)');
    const many = deferredDueMessage('git push', { test: ['1', '2', '3', '4', '5', '6', '7'], review: [] }, 'x');
    expect(many).toContain('1, 2, 3, 4, 5 and 2 more');
    const five = deferredDueMessage('git push', { test: ['1', '2', '3', '4', '5'], review: [] }, 'x');
    expect(five).toContain('1, 2, 3, 4, 5 (');
    expect(five).not.toContain('more');
    const unknown = deferredDueMessage('git push', { test: [], review: [], unknown: 'git could not list the files HEAD sends' }, 'x');
    expect(unknown).toContain(', and git could not list the files HEAD sends, so their evidence cannot be checked. (deferral due at push, N8b)');
    expect(unknown).not.toContain('the push is where they are due');
  });
});

// ── AC-6c: the push check's hardening (reviews 2026-11-26T06-56 and T07-02) ──────────────────────

describe('AC-6c: the pushed rev is never an option, and a push that cannot be listed or read is unknown', () => {
  test('commitOf: an object id for a rev; null for what git cannot resolve, and a name that starts with a dash is a name', () => {
    const r = repo({ 'src/a.ts': V1 });
    const head = sh(r.d, 'git rev-parse HEAD');
    expect(commitOf(r.d, 'HEAD')).toBe(head);
    expect(commitOf(r.d, 'main')).toBe(head);
    expect(commitOf(r.d, 'no-such-branch')).toBeNull();
    expect(commitOf(r.d, '--output=/nowhere')).toBeNull(); // no such ref: unresolved, never an option
    expect(commitOf(r.d, '--help')).toBeNull();
    expect(commitOf(tmp(), 'HEAD')).toBeNull();
  });

  test('a branch named `--output=<file>`: the file is not created or truncated, and the push is asked for what it sends', () => {
    const r = repo({ 'src/a.ts': V1 });
    r.commit({ 'src/a.ts': V2 });
    const victim = join(tmp(), 'victim.txt');
    writeFileSync(victim, 'precious\n');
    const absent = join(tmp(), 'never-made.txt');
    for (const [target, existing] of [[victim, true], [absent, false]] as const) {
      const rev = `--output=${target}`;
      sh(r.d, `git update-ref ${JSON.stringify(`refs/heads/${rev}`)} HEAD`);
      const out = deferredDueAtPush({ ...r.push(rev), testMatch: deferMatcher(['src/**'], r.d), reviewMatch: deferMatcher([], r.d), passing: [], reviews: [] });
      // The listing was taken from the commit the name resolves to: src/a.ts is owed, as for `git push origin HEAD`.
      expect(out).toEqual({ test: ['src/a.ts'], review: [] });
      expect(readFileSync(victim, 'utf8')).toBe('precious\n');
      expect([target, existsSync(target)]).toEqual([target, existing]);
    }
  });

  test('deferredDueAtPush: more than MAX_PUSH_FILES new names is unknown (a newest commit of junk cannot hide an older file)', () => {
    const r = repo({ 'src/a.ts': V1 });
    r.commit({ 'src/a.ts': V2 });
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_PUSH_FILES; i++) files[`junk/f${i}.txt`] = 'x\n';
    r.commit(files);
    const testMatch = deferMatcher(['src/**'], r.d);
    const out = due(r, { testMatch });
    expect(out?.unknown).toBe(`git could not list the files HEAD sends, or they are more than ${MAX_PUSH_FILES} (when the remote has commits this clone lacks, \`git fetch\` first)`);
    expect(out).toMatchObject({ test: [], review: [] });
    // Without the junk commit the same deferred file is owed by name.
    expect(due({ ...r, push: () => ({ cwd: r.d, top: r.d, realTop: r.d, projectDir: r.d, rev: 'HEAD~1', defaultRemote: pushRemoteOf }) }, { testMatch })).toEqual({ test: ['src/a.ts'], review: [] });
  });

  test('a deferred file whose name holds a line break is unknown, not "deleted"; the name is listed as it is', () => {
    const r = repo({ 'src/ok.ts': V1 });
    const odd = 'src/evil\n.ts';
    r.commit({ 'src/ok.ts': V2, [odd]: V1, '\nlead.ts': V1, 'src/cr\rname.ts': V1 });
    const head = sh(r.d, 'git rev-parse HEAD');
    expect(unpushedFiles(r.d, head, remoteTips(r.d, undefined, pushRemoteOf)![0]!)?.sort()).toEqual(['\nlead.ts', 'src/cr\rname.ts', 'src/evil\n.ts', 'src/ok.ts']);
    const testMatch = deferMatcher(['src/**'], r.d);
    const out = due(r, { testMatch });
    expect(out?.unknown).toBe('git could not read the files HEAD sends');
    expect(out).toMatchObject({ test: [], review: [] });
    // The deferred review of such a file: the same.
    expect(due(r, { reviewMatch: deferMatcher(['src/**'], r.d) })?.unknown).toBe('git could not read the files HEAD sends');
    // A line-break name that no glob matches is not asked about.
    expect(due(r, { testMatch: deferMatcher(['src/ok.ts'], r.d) })).toEqual({ test: ['src/ok.ts'], review: [] });
  });

  test('the push owes a test only for the files layer 1 asks one for (the `asked` seam); the review side owes every deferred file', () => {
    const r = repo({ 'src/a.ts': V1 });
    r.commit({ 'src/a.ts': V2, 'src/logo.png': 'png\n', 'src/README.md': '# x\n', 'src/data.json': '{}\n' });
    const testMatch = deferMatcher(['src/**'], r.d);
    const asked = (abs: string): boolean => abs.endsWith('.ts');
    // With nothing set, every matched file is asked of (the default).
    expect(due(r, { testMatch })?.test.sort()).toEqual(['src/README.md', 'src/a.ts', 'src/data.json', 'src/logo.png']);
    expect(due(r, { testMatch, asked })).toEqual({ test: ['src/a.ts'], review: [] });
    expect(due(r, { testMatch, asked, passing: [testRecord(join(r.d, 'src', 'a.ts'))] })).toBeNull();
    // A review is owed for a doc and an image too.
    const reviewMatch = deferMatcher(['src/**'], r.d);
    expect(due(r, { reviewMatch, asked })?.review.map((x) => x.file).sort()).toEqual(['src/README.md', 'src/a.ts', 'src/data.json', 'src/logo.png']);
  });

  test('a relative high finding resolves against the project dir, also for a nested repo, never against the process dir', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    const be = join(proj, 'be');
    write(be, 'src/a.ts', V1);
    sh(be, `${GIT_INIT} && git add -A && git commit -q -m init`);
    addOrigin(be);
    write(be, 'src/a.ts', V2);
    sh(be, 'git add -A && git commit -q -m work');
    const tree = sh(be, 'git rev-parse HEAD^{tree}');
    const a = join(be, 'src', 'a.ts');
    expect(process.cwd()).not.toBe(proj);
    const input = { cwd: be, top: be, realTop: be, projectDir: proj, rev: 'HEAD', defaultRemote: pushRemoteOf, testMatch: deferMatcher([], proj), reviewMatch: deferMatcher(['be/src/**'], proj), passing: [] } as const;
    const withHigh = (file: string): ReviewResult => reviewRecord({ tree, trees: { [be]: tree }, reviewed_files: [a], findings: [finding(file, 'high')], verdict: 'needs-changes' });
    expect(deferredDueAtPush({ ...input, reviews: [withHigh('be/src/a.ts')] })).toEqual({ test: [], review: [{ file: 'src/a.ts', why: 'high' }] });
    // A path relative to the repo is another file from the project dir: not this finding.
    expect(deferredDueAtPush({ ...input, reviews: [withHigh('src/a.ts')] })).toBeNull();
    // Another project dir resolves it elsewhere.
    expect(deferredDueAtPush({ ...input, projectDir: base, reviews: [withHigh('be/src/a.ts')] })).toBeNull();
  });

  test('the file sets are made once per record: a push of hundreds of files against dozens of records is quick', () => {
    const N = 600;
    const R = 40;
    const names = Array.from({ length: N }, (_, i) => `src/f${i}.ts`);
    const abs = (n: string): string => join('/proj', ...n.split('/'));
    const records = Array.from({ length: R }, (_, i) => testRecord(...names.slice(0, N - 1 - (i % 3)).map(abs)));
    const reviews = Array.from({ length: R }, (_, i) => reviewRecord({ tree: hex('a'), reviewed_files: names.slice(0, N - 1 - (i % 3)).map(abs) }));
    const asked: string[] = [];
    const t0 = Date.now();
    const out = deferredDueAtPush({
      cwd: '/proj',
      top: '/proj',
      realTop: '/proj',
      projectDir: '/proj',
      rev: 'HEAD',
      defaultRemote: () => 'origin',
      tips: () => [[]], // one URL, with no tip this clone holds
      testMatch: deferMatcher(['src/**'], '/proj'),
      reviewMatch: deferMatcher(['src/**'], '/proj'),
      passing: records,
      reviews,
      commit: () => hex('c'),
      files: () => names,
      ids: (_cwd, specs) => {
        asked.push(...specs);
        return new Map(specs.map((x) => [x, hex('b')]));
      },
    });
    const ms = Date.now() - t0;
    // Only the last file is listed by no record: owed. Each other is judged against records' sets made once.
    expect(out?.test).toEqual(names.slice(N - 1));
    expect(out?.review.every((x) => x.why === 'no-review')).toBe(true);
    expect(ms).toBeLessThan(4000);
  });

  test('deferredDueMessage: a failed review has its own text, not the open-high one', () => {
    const m = deferredDueMessage('git push', { test: [], review: [{ file: 'f.ts', why: 'fail' }] }, 'x');
    expect(m).toContain('review: f.ts (the newest review of the content pushed failed; fix what it found and review again)');
    expect(m).not.toContain('an open high finding');
    const mixed = deferredDueMessage('git push', { test: [], review: [{ file: 'a.ts', why: 'high' }, { file: 'b.ts', why: 'fail' }, { file: 'c.ts', why: 'no-review' }] }, 'x');
    expect(mixed).toContain('review: a.ts (an open high finding');
    expect(mixed).toContain('review: b.ts (the newest review of the content pushed failed');
    expect(mixed).toContain('review: c.ts (no review of the content pushed');
  });
});

// ── AC-6b: passingForTree, realRepoTop ──────────────────────────────────────────────────────────

describe('AC-6b: passingForTree and realRepoTop (lib/push-test.ts)', () => {
  const ran = [{ name: 'u', command: 'c', passed: 3, failed: 0, output: '' }];
  const RG = [
    {
      id: 'AC-1',
      description: 'a is 1',
      test: 'a.test.ts',
      red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
      green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
    },
  ];
  const result = (tree: string | null, over: Record<string, unknown> = {}): TestResult =>
    ({ timestamp: '', tested_files: [], category: '', test_files: [__filename], environment: { mode: 'none' }, suites: ran, acceptance: RG, verdict: 'pass', tree, ...over }) as unknown as TestResult;

  test('the records of the tree that pass, as the push test check judges them', () => {
    const r = repo({ 'src/a.ts': V1 });
    r.commit({ 'src/a.ts': V2 });
    const tree = revisionTree(r.d, 'HEAD')!;
    const good = result(tree);
    const other = result(hex('e'));
    const failed = result(tree, { verdict: 'needs-changes' });
    const noSuite = result(tree, { suites: [] });
    const noTestFile = result(tree, { test_files: ['/nonexistent/x.test.ts'] });
    expect(passingForTree(r.d, 'HEAD', tree, [other, failed, good, noSuite, noTestFile])).toEqual([good]);
    // No record of the tree: nothing, without reading the pushed lines.
    expect(passingForTree(r.d, 'HEAD', tree, [other])).toEqual([]);
    expect(passingForTree(r.d, 'HEAD', tree, [])).toEqual([]);
  });

  test('a record that checkHandoff would not pass is not passing here either: the tree it holds must be a tested one', () => {
    const r = repo({ 'src/a.ts': V1 });
    const tree = revisionTree(r.d, 'HEAD')!;
    const noTree = result(null);
    expect(passingForTree(r.d, 'HEAD', tree, [noTree])).toEqual([]);
    // A record holding the tree in `trees` of its repo only (a nested layout) is a record of the tree when the key matches.
    const nested = result(null, { trees: { [r.d]: tree } });
    expect(passingForTree(r.d, 'HEAD', tree, [nested])).toEqual([nested]);
  });

  test('realRepoTop: the real top of the repo a dir is in, through a link; null outside a repo', () => {
    const r = repo();
    mkdirSync(join(r.d, 'sub'));
    expect(realRepoTop(r.d)).toBe(r.d);
    expect(realRepoTop(join(r.d, 'sub'))).toBe(r.d);
    const link = join(tmp(), 'link');
    symlinkSync(r.d, link);
    expect(realRepoTop(link)).toBe(r.d);
    expect(realRepoTop(tmp())).toBeNull();
  });
});
