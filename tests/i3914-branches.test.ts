// v0.36.14 (#39 follow-up, plan §15.30): the branches of the new and changed library code that the spawned Stop
// hook and CLI cannot show a coverage tool (a child process is not measured), and the error and limit paths that
// no end-to-end run reaches. Each is called in this process, with real temporary repos and real git:
//   lib/stop-groups.ts   the delay seam, a start that cannot be determined, a checkout made again (an
//                        incomplete start), the branch note, the build-copy change set, `judgeGroups`;
//   lib/nested-repos.ts  the `.git` check cap and a dir that cannot be read;
//   lib/coverage-entries.ts  `scopeCoverageTops` (the `top` a record names must be a repo of the project dir);
//   lib/cli.ts           the schema messages of `coverage.changed` and `coverage.subprocess`, and the
//                        review-write warning for repos past the tree limit;
//   lib/start-pins.ts    a nested repo whose git dir is elsewhere (a submodule-like layout) is pinned at its HEAD.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { cmdReviewWrite, validateTestResultInput } from '../lib/cli';
import { scopeCoverageTops } from '../lib/coverage-entries';
import { getCurrentTurn, recordEdit } from '../lib/file-tracker';
import { nestedRepos } from '../lib/nested-repos';
import { readTopStart, takeStartSnapshot, topStart } from '../lib/start-pins';
import {
  branchNote,
  groupDelayForTest,
  incompleteStartProblem,
  isNoRepoProject,
  judgeGroups,
  newDeadline,
  resetStopGroups,
  reviewEditsSince,
  startProblem,
  testEditsByGroup,
  unionOverGroups,
  weakenedNow,
} from '../lib/stop-groups';
import type { CoverageRecord } from '../lib/types';

setDefaultTimeout(90_000);

const dirs: string[] = [];
const unlock: string[] = [];
afterEach(() => {
  resetStopGroups();
  while (unlock.length) {
    try {
      chmodSync(unlock.pop()!, 0o755);
    } catch {
      // best-effort
    }
  }
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-i3914b-'): string {
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

/** A repo at `dir` with one commit holding `src/x.ts`. */
function commitRepo(dir: string, name: string, extra: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  write(dir, 'src/x.ts', `export const ${name} = 1;\n`);
  for (const [rel, text] of Object.entries(extra)) write(dir, rel, text);
  sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
  return dir;
}

let counter = 0;
interface W {
  base: string;
  proj: string;
  be: string;
  sid: string;
}
/** A plain `proj/` holding the repo `be` (one commit), the session pinned in it. */
function world(extra: Record<string, string> = {}): W {
  const base = tmp();
  const proj = join(base, 'proj');
  mkdirSync(proj);
  const be = commitRepo(join(proj, 'be'), 'be', extra);
  const sid = `i3914b${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
  pinCoverageStart(sid, proj);
  return { base, proj, be, sid };
}
/** Another session pinned in the project dir as it is now. */
function newSession(proj: string): string {
  const sid = `i3914b${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
  pinCoverageStart(sid, proj);
  return sid;
}
/** Edits `file` of the repo (a line appended) and records the edit in the session's log. */
function edit(w: W, file: string, line = `export const e${Math.random().toString(36).slice(2, 6)} = 2;\n`): string {
  const abs = file.startsWith('/') ? file : join(w.be, file);
  writeFileSync(abs, (existsSync(abs) ? readFileSync(abs, 'utf8') : '') + line);
  recordEdit(w.sid, abs, getCurrentTurn(w.sid), undefined, Date.now());
  return abs;
}

describe('the stop-groups seams and the error paths', () => {
  test('groupDelayForTest sleeps for a positive number of ms and for nothing else', () => {
    const slept = (env: Record<string, string | undefined>): number => {
      const t0 = performance.now();
      groupDelayForTest(env);
      return performance.now() - t0;
    };
    expect(slept({ GOODBOY_TEST_GROUP_DELAY_MS: '250' })).toBeGreaterThanOrEqual(200);
    for (const none of [{}, { GOODBOY_TEST_GROUP_DELAY_MS: '' }, { GOODBOY_TEST_GROUP_DELAY_MS: '0' }, { GOODBOY_TEST_GROUP_DELAY_MS: 'soon' }, { GOODBOY_TEST_GROUP_DELAY_MS: '-5' }]) {
      expect(slept(none)).toBeLessThan(150);
    }
  });

  test('a file list that cannot be grouped is a start that could not be determined; the branch note is empty', () => {
    const w = world();
    const bad = [5 as unknown as string]; // groupsOf throws on a path that is no string
    const reason = startProblem(w.sid, w.proj, bad);
    expect(reason).toContain("The session's start could not be determined");
    expect(reason).toContain('ERR_INVALID_ARG_TYPE');
    expect(branchNote(w.sid, w.proj, bad)).toBe('');
  });

  test('a checkout made again names its repo in the incomplete-start block, and the start problem says why it is unknown', () => {
    const w = world();
    rmSync(join(w.be, '.git'), { recursive: true, force: true });
    sh(w.be, `${GIT_INIT} && git add -A && git commit -q -m again`);
    edit(w, 'src/x.ts');
    resetStopGroups();
    const inc = incompleteStartProblem(w.sid, w.proj);
    expect(inc).toContain(`What changed in ${w.be} before the session's hooks first saw it could not be established`);
    expect(inc).toContain('the checkout at this path was made again');
    const start = startProblem(w.sid, w.proj);
    expect(start).toContain(`The session's start for ${w.be} is unknown`);
  });

  test('branchNote: HEAD on another line than the start; a file equal to its merge-base version is named by its project-dir path', () => {
    const w = world();
    const first = sh(w.be, 'git rev-parse HEAD');
    write(w.be, 'src/x.ts', 'export const be = 2;\n');
    sh(w.be, 'git add -A && git commit -q -m v2');
    const sid = newSession(w.proj); // the start is the v2 commit
    sh(w.be, `git checkout -q -b other ${first}`); // HEAD moves to the commit before it: x.ts is the merge base's version
    resetStopGroups();
    const note = branchNote(sid, w.proj, [join(w.be, 'src', 'x.ts')]);
    expect(note).toContain('Note: be/src/x.ts is an obligation only because HEAD');
    expect(note).toContain(`(${first.slice(0, 12)} is where they part): it equals its version there, so the session did not change it.`);
    expect(note).toContain('This still blocks.');
  });

  test('branchNote: more than five files are listed as the first five and a count', () => {
    const w = world();
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `src/${n}.ts`);
    for (const f of names) write(w.be, f, 'export const v = 1;\n');
    sh(w.be, 'git add -A && git commit -q -m files'); // main now has the files; it is the base both lines share
    sh(w.be, 'git checkout -q -b line2');
    for (const f of names) write(w.be, f, 'export const v = 2;\n');
    sh(w.be, 'git add -A && git commit -q -m v2');
    const sid = newSession(w.proj); // the start is line2: every file is v2
    sh(w.be, 'git checkout -q main'); // HEAD moves to the other line: the files are v1 there, the merge base's version
    resetStopGroups();
    const note = branchNote(sid, w.proj, names.map((f) => join(w.be, f)));
    expect(note).toContain('and 2 more are an obligation only because HEAD');
    expect(note).toContain('be/src/a.ts, be/src/b.ts, be/src/c.ts, be/src/d.ts, be/src/e.ts and 2 more');
    expect(note).toContain('they equal their version there');
    expect(note).not.toContain('be/src/f.ts');
  });

  test('a git-ignored build copy of a tested source file is not in the layer-1 set; the pair is judged against the repo\'s change set', () => {
    const w = world({ '.gitignore': 'target/\n', 'src/app.js': 'export const f = (x) => x + 1;\n' });
    const src = edit(w, 'src/app.js', 'export const g = 2;\n');
    const copy = write(w.be, 'target/app.js', readFileSync(src, 'utf8'));
    recordEdit(w.sid, copy, getCurrentTurn(w.sid), undefined, Date.now());
    resetStopGroups();
    const by = testEditsByGroup(w.sid, w.proj, 0);
    expect(by.map((x) => [x.g.rel, x.files])).toEqual([['be', [src]]]);
  });

  test('judgeGroups: views per group; an error of the content check goes to `onError`, or on when there is none', () => {
    const w = world();
    const fe = commitRepo(join(w.proj, 'fe'), 'fe');
    pinCoverageStart(w.sid, w.proj);
    const be = edit(w, 'src/x.ts');
    const feFile = edit(w, join(fe, 'src', 'x.ts'));
    resetStopGroups();
    const records = [
      { timestamp: new Date().toISOString(), tree: null, trees: { [w.be]: 'a'.repeat(40) } },
      { timestamp: new Date().toISOString(), tree: null },
    ];
    const edits = [{ file: be, lastEditTimestamp: new Date().toISOString() }, { file: feFile, lastEditTimestamp: new Date().toISOString() }];
    const deadline = newDeadline(60_000);
    const judged = judgeGroups({ sessionId: w.sid, cwd: w.proj, edits, records: records as never, deadline });
    expect(judged.map((j) => [j.g.rel, j.edits.map((e) => e.file)])).toEqual([['be', [be]], ['fe', [feFile]]]);
    expect(judged[0]!.views.map((v) => v.tree)).toEqual(['a'.repeat(40), null]); // the group's own tree, or none
    expect(judged[0]!.origOf.get(judged[0]!.views[0]!)).toBe(records[0] as never);

    const boom = (): never => {
      throw new Error('content check failed');
    };
    expect(() => judgeGroups({ sessionId: w.sid, cwd: w.proj, edits, records: records as never, filesOf: boom, deadline })).toThrow('content check failed');
    const seen: string[] = [];
    const kept = judgeGroups({
      sessionId: w.sid,
      cwd: w.proj,
      edits,
      records: records as never,
      filesOf: boom,
      deadline,
      onError: (own) => {
        seen.push(...own.map((e) => e.file));
        return own;
      },
    });
    expect(seen).toEqual([be, feFile]);
    expect(kept.map((j) => j.edits.map((e) => e.file))).toEqual([[be], [feFile]]);
  });
});

describe('nestedRepos limits', () => {
  test('a tree full of `.git` entries stops at the check cap and says so', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    for (let i = 0; i < 260; i++) write(proj, `d${String(i).padStart(3, '0')}/.git`, 'gitdir: /nowhere\n'); // none is a repo top
    write(proj, 'real/x.ts', 'x\n');
    const out = nestedRepos(proj);
    expect(out.capped).toBe(true);
    expect(out.repos).toEqual([]);
  });

  test('a dir that cannot be read ends its own branch of the walk: no repo below it, no cap claimed', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    const be = commitRepo(join(proj, 'be'), 'be');
    mkdirSync(join(proj, 'locked', 'inner'), { recursive: true });
    chmodSync(join(proj, 'locked'), 0o000);
    unlock.push(join(proj, 'locked'));
    const out = nestedRepos(proj);
    expect(out).toEqual({ repos: [{ top: be, realTop: be }], capped: false, unanswered: [] });
  });
});

describe('scopeCoverageTops: the repo a coverage entry names must be a repo inside the project dir', () => {
  const entry = (top?: string) => ({ covered: 1, total: 1, files_without_executed_changes: [], files: {}, in_report: [], diff_lines: {}, base: 'a'.repeat(40), ...(top === undefined ? {} : { top }) });

  test('entries naming a nested repo (any spelling) are kept as its real top; the others are dropped with one warning each', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    const be = commitRepo(join(proj, 'be'), 'be');
    const fe = commitRepo(join(proj, 'fe'), 'fe');
    const outside = commitRepo(join(base, 'outside'), 'outside');
    const coverage = {
      status: 'measured',
      changed: [entry(be), entry(join(fe, 'src', '..')), entry(outside), entry('relative/path'), entry(be), entry()],
      subprocess: [{ file: 'a.ts', test: 't.ts', top: fe }, { file: 'b.ts', test: 't.ts', top: outside }, { file: 'c.ts', test: 't.ts' }],
    } as unknown as CoverageRecord;
    const warnings = scopeCoverageTops(coverage, proj);
    expect((coverage.changed as { top?: string }[]).map((e) => e.top)).toEqual([be, fe, be, undefined]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain(`coverage.changed[2] names ${outside}, which is not a git repository inside the project dir; it is dropped.`);
    expect(warnings[1]).toContain('coverage.changed[3] names relative/path');
    expect(warnings[2]).toContain(`coverage.subprocess[1] names ${outside}`);
    expect(coverage.subprocess!.map((p) => p.file)).toEqual(['a.ts', 'c.ts']);
  });

  test('a list with no entry left is removed; a single object with a bad `top` is removed; a `top` that is no string is dropped', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    commitRepo(join(proj, 'be'), 'be');
    const none = { status: 'measured', changed: [entry('/nowhere'), entry('/also/nowhere')] } as unknown as CoverageRecord;
    expect(scopeCoverageTops(none, proj)).toHaveLength(2);
    expect('changed' in none).toBe(false);
    const single = { status: 'measured', changed: entry('/nowhere') } as unknown as CoverageRecord;
    expect(scopeCoverageTops(single, proj)).toHaveLength(1);
    expect(single.changed).toBeUndefined();
    const odd = { status: 'measured', changed: [{ ...entry(), top: 7 }] } as unknown as CoverageRecord;
    expect(scopeCoverageTops(odd, proj)[0]).toContain('names a top that is no path');
  });

  test('the project dir\'s own repo is a repo inside the project dir, its top written through a link or not', () => {
    const base = tmp();
    const repo = commitRepo(join(base, 'own'), 'own');
    const sub = join(repo, 'src');
    const cov = { status: 'measured', changed: entry(repo) } as unknown as CoverageRecord;
    expect(scopeCoverageTops(cov, sub)).toEqual([]); // the project dir is a subdir of the repo: the repo is its own
    expect((cov.changed as { top?: string }).top).toBe(repo);
  });
});

describe('the schema of coverage.changed and coverage.subprocess, in process', () => {
  const be = {
    covered: 1,
    total: 1,
    files_without_executed_changes: [],
    files: { 'src/x.ts': { covered: 1, total: 1 } },
    in_report: ['src/x.ts'],
    diff_lines: { 'src/x.ts': 1 },
    base: 'a'.repeat(40),
    top: '/real/be',
  };
  const input = (coverage: Record<string, unknown>) => ({
    timestamp: new Date().toISOString(),
    tested_files: [import.meta.path],
    category: 'fix-bug',
    test_files: [import.meta.path],
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [
      {
        id: 'AC-1',
        description: 'x',
        test: 'x.test.ts',
        red: { command: 'c', output: '1 fail', exit_code: 1 },
        green: { command: 'c', output: '1 pass', exit_code: 0 },
      },
    ],
    verdict: 'pass',
    coverage: { status: 'measured', ...coverage },
  });
  const errorsOf = (coverage: Record<string, unknown>): string => {
    const v = validateTestResultInput(input(coverage), [dirname(import.meta.dir)]);
    return v.ok ? '' : v.errors.join('\n');
  };

  test('each part of an entry is checked and named by its label', () => {
    expect(errorsOf({ changed: { ...be, in_report: 'src/x.ts' } })).toContain('coverage.changed.in_report must be the list of file paths');
    expect(errorsOf({ changed: [be, { ...be, in_report: [1] }] })).toContain('coverage.changed[1].in_report must be the list of file paths');
    expect(errorsOf({ changed: { ...be, diff_lines: { 'src/x.ts': -1 } } })).toContain('coverage.changed.diff_lines must map each file to its added lines');
    expect(errorsOf({ changed: { ...be, diff_lines: [] } })).toContain('coverage.changed.diff_lines must map each file');
    expect(errorsOf({ changed: { ...be, base: 'HEAD' } })).toContain('coverage.changed.base must be the object id diff-coverage prints.');
    expect(errorsOf({ changed: { ...be, files: { 'src/x.ts': { covered: 2, total: 1 } } } })).toContain('coverage.changed.files must map each file');
    expect(errorsOf({ changed: { ...be, top: ' ' } })).toContain('coverage.changed.top must be the repo path diff-coverage prints.');
    expect(errorsOf({ changed: be })).toBe('');
  });

  test('a list of more than 64 entries is refused; `subprocess` pairs need a file, a test and, when given, a `top` string', () => {
    expect(errorsOf({ changed: Array.from({ length: 65 }, () => be) })).toContain('coverage.changed as a list needs 1 to 64 entries');
    const bad = (pair: unknown) => errorsOf({ changed: be, subprocess: [pair] });
    for (const pair of [null, { file: '', test: 't.ts' }, { file: 'a.ts' }, { file: 'a.ts', test: ' ' }, { file: 'a.ts', test: 't.ts', top: 5 }, { file: 'a.ts', test: 't.ts', top: ' ' }]) {
      expect(bad(pair)).toContain('coverage.subprocess must be a list of {file, test, top?}');
    }
    expect(errorsOf({ changed: be, subprocess: 'a.ts' })).toContain('coverage.subprocess must be a list of {file, test, top?}');
    expect(bad({ file: 'a.ts', test: 't.ts', top: '/real/be' })).toBe('');
    expect(bad({ file: 'a.ts', test: 't.ts' })).toBe('');
  });
});

describe('review-write for repos past the tree limit', () => {
  test('the review is written with trees for the first repos, and a warning names the repos that have none', async () => {
    const base = tmp();
    const proj = join(base, 'proj');
    const files: string[] = [];
    for (let i = 0; i < 10; i++) {
      const repo = commitRepo(join(proj, `r${String(i).padStart(2, '0')}`), `r${i}`);
      files.push(write(repo, 'src/x.ts', `export const r${i} = 2;\n`));
    }
    const inputPath = join(base, 'review.json');
    writeFileSync(inputPath, JSON.stringify({ reviewed_files: files, category: 'fix-bug', findings: [], unknown_assumptions_checked: [], verdict: 'pass', dimensions_checked: [] }));
    const err: string[] = [];
    const out: string[] = [];
    const realErr = process.stderr.write.bind(process.stderr);
    const realOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((s: string | Uint8Array) => (err.push(String(s)), true)) as typeof process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => (out.push(String(s)), true)) as typeof process.stdout.write;
    try {
      await cmdReviewWrite(proj, [inputPath]);
    } finally {
      process.stderr.write = realErr;
      process.stdout.write = realOut;
    }
    const written = JSON.parse(readFileSync((JSON.parse(out.join('')) as { path: string }).path, 'utf8')) as { trees?: Record<string, string> };
    expect(Object.keys(written.trees ?? {})).toHaveLength(8);
    const warning = err.join('');
    expect(warning).toContain('warning: reviewed files span more repos than goodboy hashes; no tree recorded for ');
    expect(warning).toContain(join(proj, 'r08'));
    expect(warning).toContain(join(proj, 'r09'));
    expect(warning).not.toContain(join(proj, 'r00'));
  });
});

describe('a nested repo whose git dir is elsewhere is pinned at its own HEAD', () => {
  test('takeStartSnapshot in a project dir that is no repo: a repo with commits is pinned at HEAD, one with none as empty', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    mkdirSync(proj);
    const sid = `i3914b${Math.random().toString(36).slice(2, 8)}${counter++}`;
    dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
    const mod = join(proj, 'mod');
    mkdirSync(mod);
    sh(mod, `git init -q -b main --separate-git-dir ${JSON.stringify(join(base, 'mod.git'))} && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false`);
    write(mod, 'a.txt', 'a\n');
    sh(mod, 'git add -A && git commit -q -m a');
    const fresh = join(proj, 'fresh');
    mkdirSync(fresh);
    sh(fresh, `git init -q -b main --separate-git-dir ${JSON.stringify(join(base, 'fresh.git'))}`);
    expect(takeStartSnapshot(sid, proj)).toBe(false);
    expect(topStart(sid, mod)).toEqual({ kind: 'commit', head: sh(mod, 'git rev-parse HEAD') });
    expect(topStart(sid, fresh)).toEqual({ kind: 'empty' });
  });

  test('a top that is no path is no snapshot, and no error', () => {
    const sid = `i3914b${Math.random().toString(36).slice(2, 8)}${counter++}`;
    dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
    for (const top of [Symbol('top'), null, undefined, { toString: () => { throw new Error('no path'); } }]) {
      expect(takeStartSnapshot(sid, top as unknown as string)).toBe(false);
    }
    expect(existsSync(join(tmpdir(), `goodboy-session-${sid}`, 'start-tips.json'))).toBe(false);
  });
});

describe('what fails inside the group helpers fails closed (or keeps everything), never silently', () => {
  // `5` is no path: `path.resolve` throws inside each helper's own try block, the way a corrupt argument would.
  const noPath = 5 as unknown as string;

  test('reviewEditsSince: a grouping that fails keeps every edit of the log, with their times', () => {
    const w = world();
    const f = edit(w, 'src/x.ts');
    const kept = reviewEditsSince(w.sid, noPath, 0, w.proj);
    expect(kept.map((e) => e.file)).toEqual([f]);
    expect(typeof kept[0]!.lastEditTimestamp).toBe('string');
  });

  test('incompleteStartProblem: a grouping that fails is a block that says it could not be read', () => {
    const w = world();
    const why = incompleteStartProblem(w.sid, noPath);
    expect(why).toContain('could not be established');
    expect(why).toContain('it could not be read');
  });

  test('weakenedNow: a grouping that fails finds nothing weakened, and the answer is kept', () => {
    const w = world();
    expect(weakenedNow(w.sid, noPath)).toEqual([]);
    expect(weakenedNow(w.sid, noPath)).toEqual([]);
  });

  test('isNoRepoProject: a dir that cannot be asked about is not a project dir that is no repo (one group, as before)', () => {
    expect(isNoRepoProject(`${tmpdir()}/goodboy-no\0path`)).toBe(false);
  });

  test('readTopStart: a top that is no path is an unknown start with the reason, never a throw', () => {
    const s = readTopStart('i3914b-nopath', noPath);
    expect(s.kind).toBe('unknown');
    expect(s.kind === 'unknown' && s.reason).toContain('its start could not be read');
  });

  test('a session id whose directory cannot be named while the project dir is asked about: the old no-snapshot reason, not a throw', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    mkdirSync(proj);
    const late = commitRepo(join(proj, 'late'), 'late');
    const real = `i3914b${Math.random().toString(36).slice(2, 8)}${counter++}`;
    dirs.push(join(tmpdir(), `goodboy-session-${real}`));
    // sessionDir(id) sanitizes with `id.replace(...)`: it fails only for the call made by projectIsNoRepo.
    const sid = {
      toString: () => real,
      replace(re: RegExp, to: string): string {
        if ((new Error().stack ?? '').includes('projectIsNoRepo')) throw new Error('the session dir cannot be named');
        return real.replace(re, to);
      },
    } as unknown as string;
    const s = topStart(sid, late);
    expect(s.kind).toBe('unknown');
    expect(s.kind === 'unknown' && s.reason).toContain('the session has no start snapshot (it began before v0.36.7');
  });
});

describe('unionOverGroups', () => {
  type Rec = { id: string };
  const rec1: Rec = { id: 'one' };
  const rec2: Rec = { id: 'two' };
  const group = {} as Parameters<typeof unionOverGroups>[0][number]['g'];
  // Each group sees copies (views) of the records; `origOf` says which record a view is of.
  const judgedOf = (views: Rec[][], origs: Rec[][], edits: string[][]) =>
    views.map((v, i) => ({ g: group, edits: edits[i]!, views: v, origOf: new Map(v.map((x, j) => [x, origs[i]![j]!])) }));

  test('the records that were effective in any group come back as the records themselves, once each', () => {
    const v1 = { ...rec1 };
    const v2 = { ...rec2 };
    const v3 = { ...rec1 };
    const judged = judgedOf([[v1, v2], [v3]], [[rec1, rec2], [rec1]], [['a'], ['b']]);
    // Group `a` finds both views effective, group `b` finds its view of rec1 effective.
    const u = unionOverGroups(judged, (views, edits) => ({ ok: true, effective: edits[0] === 'a' ? views : [views[0]!] }));
    expect(u.ok).toBe(true);
    expect(u.effective).toHaveLength(2);
    expect(u.effective[0]).toBe(rec1); // the record, not v1 or v3
    expect(u.effective[1]).toBe(rec2);
    expect(u.parts).toHaveLength(2);
    expect(u.reason).toBeUndefined();
  });

  test('a view that is no known record stays as it is; ok needs every group; distinct reasons are joined in order', () => {
    const stray = { id: 'stray' };
    const judged = judgedOf([[{ ...rec1 }], [{ ...rec2 }]], [[rec1], [rec2]], [['a'], ['b']]);
    const u = unionOverGroups(judged, (_views, edits) =>
      edits[0] === 'a' ? { ok: false, reason: 'not covered in a', effective: [stray] } : { ok: true, reason: 'not covered in a', effective: [] },
    );
    expect(u.ok).toBe(false);
    expect(u.reason).toBe('not covered in a'); // one text, not two
    expect(u.effective).toEqual([stray]);
    const two = unionOverGroups(judged, (_views, edits) => ({ ok: false, reason: `no ${edits[0]}`, effective: [] }));
    expect(two.reason).toBe('no a no b');
  });
});
