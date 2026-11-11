// v0.36.17 (#41, #25 part 3, #36 part 4, plan §15.33): a push from a repo that keeps local-only files.
//   V17-AC-1  test-write --worktree on a clean linked worktree records the worktree's commit and tree;
//             the push check passes it although the project dir holds an untracked local-only file
//   V17-AC-2  refusals (dirty, own checkout, foreign repo, no git, no value, files outside) and what is not dirt
//   V17-AC-3  regression --worktree runs in the worktree and records it
//   V17-AC-4  the push denial names `.git/info/exclude` and `--worktree` for a commit, not for the working tree
//   V17-AC-5  mutationSuiteWarnings
//   V17-AC-6  absentRecordWarnings, and the Stop shows the warning once
//   V17-AC-7  the tree/file patterns are in tests/small-fixes-0.36.16.test.ts (S16-AC-2b)
// Repos are real (`git init`, `git worktree add`) in temp dirs; the CLI and the hooks run as processes, and
// cmdTestWrite and cleanWorktreeFor also in this process (the coverage run sees only those). New library
// members are read off namespaces, so a run on the old tree fails test by test.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as cliLib from '../lib/cli';
import * as pt from '../lib/push-test';
import * as validator from '../lib/test-validator';
import { pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const STOP = join(ROOT, 'hooks', 'stop.ts');
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-v17-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const GENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: GENV });
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
const commitAll = (d: string, msg: string): string => (sh(d, `git add -A && git commit -q -m ${msg}`), sh(d, 'git rev-parse HEAD'));
const treeOfCommit = (d: string, c: string): string => sh(d, `git rev-parse ${c}^{tree}`);

interface World {
  base: string;
  proj: string;
  first: string;
  env: Record<string, string>;
  cli: (cwd: string, args: string[], stdin?: string) => { code: number | null; out: string; err: string };
  /** A linked worktree of proj at `rev`, detached. */
  worktree: (where: string, rev?: string) => string;
  record: (args: string[], over?: Record<string, unknown>) => { code: number | null; err: string; path: string; saved: Record<string, unknown> };
}

/** A project repo with one commit (and a second one) and a tiny test script. */
function world(): World {
  const base = tmp();
  const proj = join(base, 'proj');
  write(proj, 'src/a.ts', 'export const a = 1;\n');
  write(proj, 'a.test.ts', 'test("a", () => {});\n');
  write(proj, 'package.json', JSON.stringify({ scripts: { test: 'echo ran-in-$(basename "$PWD")' } }));
  write(proj, 'bun.lock', '');
  write(proj, '.gitignore', 'ignored.log\n');
  sh(proj, GIT_INIT);
  const first = commitAll(proj, 'first');
  const env: Record<string, string> = { ...(GENV as Record<string, string>), TMPDIR: base, CLAUDE_PROJECT_DIR: proj, GOODBOY_OUTWARD_GATE: 'off' };
  delete env.CLAUDE_CODE_SESSION_ID;
  const cli: World['cli'] = (cwd, args, stdin = '') => {
    const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const worktree = (where: string, rev = 'HEAD') => {
    sh(proj, `git worktree add -q --detach '${where}' ${rev}`);
    return realpathSync(where);
  };
  const record: World['record'] = (args, over = {}) => {
    const r = cli(proj, ['test-write', ...args], JSON.stringify(input(['src/a.ts'], ['a.test.ts'], over)));
    let path = '';
    let saved: Record<string, unknown> = {};
    if (r.code === 0) {
      path = (JSON.parse(r.out) as { path: string }).path;
      saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    }
    return { code: r.code, err: r.err, path, saved };
  };
  return { base, proj, first, env, cli, worktree, record };
}

function input(tested: string[], testFiles: string[], over: Record<string, unknown> = {}) {
  return {
    timestamp: new Date().toISOString(),
    tested_files: tested,
    category: 'fix-bug',
    test_files: testFiles,
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [
      {
        id: 'AC-1',
        description: 'a is 1',
        test: 'a.test.ts',
        red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
      },
    ],
    verdict: 'pass',
    ...over,
  };
}

/** A second commit in proj (so a worktree at `first` is behind HEAD), and an untracked local-only file. */
function localOnly(w: World): string {
  write(w.proj, 'src/b.ts', 'export const b = 2;\n');
  const second = commitAll(w.proj, 'second');
  write(w.proj, 'local.cfg', 'mine\n');
  return second;
}

const handoff = (w: World, rev: string) => ({ kind: 'push' as const, what: 'git push origin main', cwd: w.proj, revs: [rev] });

// ── V17-AC-1 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V17-AC-1: test-write --worktree records the clean worktree\'s commit and tree', () => {
  test('control (the old behavior): a record from the project dir holds the local-only file, so the push is denied', () => {
    const w = world();
    localOnly(w);
    const r = w.record([]);
    expect(r.code).toBe(0);
    const out = pt.checkHandoff(handoff(w, 'HEAD'), [r.saved as unknown as TestResult]);
    expect(out).toMatchObject({ ok: false, why: 'no-result', differs: ['local.cfg'] });
  });

  for (const where of ['inside', 'outside']) {
    test(`a worktree ${where} the project dir: commit, tree and worktree are its own, no trees; the push passes`, () => {
      const w = world();
      const second = localOnly(w);
      const wt = w.worktree(where === 'inside' ? join(w.proj, 'wt-in') : join(w.base, 'wt-out'));
      const r = w.record(['--worktree', wt]);
      expect([r.code, r.err]).toEqual([0, '']);
      expect(r.saved.commit).toBe(second);
      expect(r.saved.tree).toBe(treeOfCommit(w.proj, second));
      expect(r.saved.worktree).toBe(wt);
      expect(r.saved.trees).toBeUndefined();
      expect(r.saved.tested_files).toEqual([join(wt, 'src/a.ts')]);
      expect(r.saved.test_files).toEqual([join(wt, 'a.test.ts')]);
      expect(r.path.startsWith(join(w.proj, '.claude', 'tests'))).toBe(true);
      expect(pt.checkHandoff(handoff(w, 'HEAD'), [r.saved as unknown as TestResult])).toEqual({ ok: true });
    });
  }

  test('a worktree behind HEAD: its commit passes and HEAD does not; `--worktree=<dir>` spells the same', () => {
    const w = world();
    localOnly(w);
    const wt = w.worktree(join(w.base, 'wt-old'), w.first);
    const r = w.record([`--worktree=${wt}`]);
    expect(r.code).toBe(0);
    expect(r.saved.commit).toBe(w.first);
    const rec = [r.saved as unknown as TestResult];
    expect(pt.checkHandoff(handoff(w, w.first), rec)).toEqual({ ok: true });
    expect(pt.checkHandoff(handoff(w, 'HEAD'), rec)).toMatchObject({ ok: false, why: 'no-result' });
  });

  test('a relative worktree resolves from the shell\'s dir (here the project dir), relative files in the worktree', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt-rel'));
    const r = w.cli(w.proj, ['test-write', '--worktree', '../wt-rel'], JSON.stringify(input(['src/a.ts'], ['a.test.ts'])));
    expect([r.code, r.err]).toEqual([0, '']);
    const saved = JSON.parse(readFileSync((JSON.parse(r.out) as { path: string }).path, 'utf8')) as Record<string, unknown>;
    expect(saved.worktree).toBe(wt);
  });

  test('a forged `worktree` in the input is dropped when there is no --worktree', () => {
    const w = world();
    const r = w.record([], { worktree: '/forged' });
    expect(r.code).toBe(0);
    expect(r.saved.worktree).toBeUndefined();
  });

  test('end to end: the PreToolUse hook lets the push through on a worktree record and its regression, local file present', async () => {
    const w = world();
    localOnly(w);
    const wt = w.worktree(join(w.base, 'wt-e2e'));
    expect(w.record(['--worktree', wt]).code).toBe(0);
    const reg = w.cli(w.proj, ['regression', '--worktree', wt]);
    expect([reg.code, reg.err]).toEqual([0, '']);
    const env = { ...w.env, GOODBOY_PUSH_REGRESSION: 'on' };
    const payload = { session_id: 'v17e2e', cwd: w.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
    const proc = Bun.spawn(['bun', HOOK], { cwd: w.proj, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    await proc.exited;
    expect([out.hookSpecificOutput?.permissionDecision, out.hookSpecificOutput?.permissionDecisionReason]).toEqual([undefined, undefined]);
  });
});

// ── V17-AC-2 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V17-AC-2: refusals, and what is no dirt', () => {
  /** Runs test-write with --worktree and unreadable input: a refusal comes before the input is read. */
  function refused(w: World, dir: string | null, extra: string[] = []) {
    const args = dir === null ? ['test-write', ...extra, '--worktree'] : ['test-write', '--worktree', dir, ...extra];
    const r = w.cli(w.proj, args, 'not json');
    expect(existsSync(join(w.proj, '.claude', 'tests'))).toBe(false);
    return r;
  }

  test('a dirty worktree: an untracked file, an edit of a tracked file, a staged change', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    write(wt, 'new.txt', 'x\n');
    let r = refused(w, wt);
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not clean (new.txt)');
    rmSync(join(wt, 'new.txt'));
    write(wt, 'src/a.ts', 'export const a = 2;\n');
    r = refused(w, wt);
    expect([r.code, r.err.includes('is not clean (src/a.ts)')]).toEqual([1, true]);
    sh(wt, 'git add src/a.ts');
    r = refused(w, wt);
    expect([r.code, r.err.includes('is not clean (src/a.ts)')]).toEqual([1, true]);
  });

  test('a long list of dirt names five files and the count of the rest', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    for (let i = 0; i < 8; i++) write(wt, `d${i}.txt`, 'x');
    const r = refused(w, wt);
    expect(r.err).toContain('and 3 more');
  });

  test('the project\'s own checkout, a nested clone, an unrelated repo and a non-git dir', () => {
    const w = world();
    expect(refused(w, w.proj).err).toContain("is the project dir's own checkout");
    sh(w.proj, `git clone -q '${w.proj}' nested-clone`);
    const nested = refused(w, join(w.proj, 'nested-clone'));
    expect([nested.code, nested.err.includes('is not a linked worktree of the project')]).toEqual([1, true]);
    const other = join(w.base, 'other');
    write(other, 'f.txt', 'x');
    sh(other, `${GIT_INIT} && git add -A && git commit -q -m x`);
    expect(refused(w, other).err).toContain('is not a linked worktree of the project');
    const plain = join(w.base, 'plain');
    mkdirSync(plain);
    const p = refused(w, plain);
    expect([p.code, p.err.includes('is not inside a git checkout')]).toEqual([1, true]);
  });

  test('a project dir that is no repo has no worktrees', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    const folder = join(w.base, 'folder');
    mkdirSync(folder);
    const env = { ...w.env, CLAUDE_PROJECT_DIR: folder };
    const p = Bun.spawnSync(['bun', CLI, 'test-write', '--worktree', wt], { cwd: folder, env, stdin: new TextEncoder().encode('x'), stdout: 'pipe', stderr: 'pipe' });
    expect([p.exitCode, p.stderr.toString().includes('no git checkout')]).toEqual([1, true]);
  });

  test('`--worktree` with no value, or an empty one', () => {
    const w = world();
    const r = refused(w, null);
    expect([r.code, r.err]).toEqual([1, 'test-write: --worktree needs a directory.\n']);
    expect(w.cli(w.proj, ['test-write', '--worktree='], 'x').err).toContain('--worktree needs a directory');
    expect(w.cli(w.proj, ['regression', '--worktree'], '').err).toContain('regression: --worktree needs a directory');
  });

  test('a tested or a test file outside the worktree', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    for (const [tested, tests, bad] of [
      [[join(w.proj, 'src/a.ts')], ['a.test.ts'], join(w.proj, 'src/a.ts')],
      [['src/a.ts'], [join(w.proj, 'a.test.ts')], join(w.proj, 'a.test.ts')],
    ] as const) {
      const r = w.cli(w.proj, ['test-write', '--worktree', wt], JSON.stringify(input([...tested], [...tests])));
      expect([r.code, r.err.includes(`${bad} is not in the worktree ${wt}`)]).toEqual([1, true]);
    }
    expect(existsSync(join(w.proj, '.claude', 'tests'))).toBe(false);
  });

  test('a file reached through a link out of the worktree is outside', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    symlinkSync(join(w.proj, 'src'), join(wt, '..', 'wt-link'));
    const r = w.cli(w.proj, ['test-write', '--worktree', wt], JSON.stringify(input([join(w.base, 'wt-link', 'a.ts')], ['a.test.ts'])));
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not in the worktree');
  });

  test('ignored files and goodboy artifacts are no dirt', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    write(wt, 'ignored.log', 'x');
    write(wt, '.claude/tests/x.json', '{}');
    write(wt, '.claude/reviews/y.json', '{}');
    write(wt, '.goodboy/policy.md', 'p');
    const r = w.record(['--worktree', wt]);
    expect([r.code, r.err]).toEqual([0, '']);
  });

  test('V17-AC-10: a rename is parsed with its old path: between two artifact paths it is clean, a source renamed away names both', () => {
    const w = world();
    write(w.proj, '.claude/tests/a.json', '{}');
    commitAll(w.proj, 'artifact');
    const wt = w.worktree(join(w.base, 'wt'));
    sh(wt, 'git mv .claude/tests/a.json .claude/tests/b.json');
    expect(w.record(['--worktree', wt]).code).toBe(0);
    sh(wt, 'git mv src/a.ts src/renamed.ts');
    const r = w.cli(w.proj, ['test-write', '--worktree', wt], 'x');
    expect(r.err).toContain('is not clean (src/renamed.ts, src/a.ts)');
  });

  test('V17-AC-10: a source file renamed INTO an artifact dir is refused (HEAD still holds it)', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    mkdirSync(join(wt, '.claude', 'pending'), { recursive: true });
    sh(wt, 'git mv a.test.ts .claude/pending/a.test.ts');
    const r = w.cli(w.proj, ['test-write', '--worktree', wt], 'x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not clean');
    expect(r.err).toContain('a.test.ts');
    expect(existsSync(join(w.proj, '.claude', 'tests'))).toBe(false);
  });

  test('V17-AC-11: a repo with a clean filter: a file the filter maps to the committed content is clean', async () => {
    const w = world();
    write(w.proj, '.gitattributes', '*.dat filter=up\n');
    sh(w.proj, "git config filter.up.clean 'tr a-z A-Z'");
    write(w.proj, 'f.dat', 'abc\n');
    commitAll(w.proj, 'filtered');
    expect(sh(w.proj, 'git show HEAD:f.dat')).toBe('ABC');
    const wt = w.worktree(join(w.base, 'wt'));
    write(wt, 'f.dat', 'abc\n'); // the clean filter turns it into the committed ABC
    const { cleanWorktreeFor } = await import('../lib/clean-worktree');
    expect(cleanWorktreeFor(w.proj, wt, w.base)).toMatchObject({ ok: true });
    write(wt, 'f.dat', 'xyz\n');
    expect(cleanWorktreeFor(w.proj, wt, w.base)).toMatchObject({ ok: false });
  });
});

// ── in this process: the same functions, for the coverage run ───────────────────────────────────────────

describe('V17-AC-2 (in process): cleanWorktreeFor, worktreeArg and cmdTestWrite', () => {
  const lib = () => import('../lib/clean-worktree');

  test('cleanWorktreeFor answers with the top, the commit and its tree, or why not', async () => {
    const { cleanWorktreeFor } = await lib();
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    expect(cleanWorktreeFor(w.proj, wt, w.base)).toEqual({ ok: true, top: wt, commit: w.first, tree: treeOfCommit(w.proj, w.first) });
    expect(cleanWorktreeFor(w.proj, 'wt', w.base)).toMatchObject({ ok: true, top: wt });
    write(wt, 'x.txt', 'x');
    expect(cleanWorktreeFor(w.proj, wt, w.base)).toMatchObject({ ok: false });
    expect(cleanWorktreeFor(w.proj, w.proj, w.base)).toMatchObject({ ok: false });
    expect(cleanWorktreeFor(join(w.base, 'nope'), wt, w.base)).toMatchObject({ ok: false });
    expect(cleanWorktreeFor(w.base, wt, w.base)).toMatchObject({ ok: false, why: 'the project dir is no git checkout, so it has no linked worktrees' });
  });

  test('a clone of the project and an unrelated repo are no linked worktree of it', async () => {
    const { cleanWorktreeFor } = await lib();
    const w = world();
    sh(w.base, `git clone -q '${w.proj}' clone`);
    const other = join(w.base, 'other');
    write(other, 'f.txt', 'x');
    sh(other, `${GIT_INIT} && git add -A && git commit -q -m x`);
    for (const d of [join(w.base, 'clone'), other]) {
      const r = cleanWorktreeFor(w.proj, d, w.base);
      expect(r).toMatchObject({ ok: false });
      expect((r as { why: string }).why).toContain('is not a linked worktree of the project');
    }
  });

  test('a worktree with no commit checked out (an unborn branch) is refused', async () => {
    const { cleanWorktreeFor } = await lib();
    const w = world();
    const wt = join(w.base, 'wt-unborn');
    sh(w.proj, `git worktree add -q --detach '${wt}'`);
    sh(wt, 'git checkout -q --orphan unborn');
    const r = cleanWorktreeFor(w.proj, wt, w.base);
    expect(r).toMatchObject({ ok: false });
    expect((r as { why: string }).why).toContain('has no commit checked out');
  });

  test('HEAD that moves while git status runs is refused (a fake git commits in the worktree on its `status`)', async () => {
    const { cleanWorktreeFor } = await lib();
    const w = world();
    const wt = w.worktree(join(w.base, 'wt-moves'));
    const real = Bun.which('git')!;
    const arm = join(w.base, 'arm');
    writeFileSync(arm, '');
    const bin = join(w.base, 'bin-move');
    write(bin, 'git', `#!/bin/sh\ncase " $* " in *" status "*) if [ -e '${arm}' ]; then rm -f '${arm}'; '${real}' -C '${wt}' commit -q --allow-empty -m moved; fi;; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const r = cleanWorktreeFor(w.proj, wt, w.base);
      expect(r).toMatchObject({ ok: false });
      expect((r as { why: string }).why).toContain('HEAD moved');
    } finally {
      process.env.PATH = saved;
    }
  });

  test('isUnder (the in-worktree check test-write uses) and worktreeArg', async () => {
    const { worktreeArg } = await lib();
    const { isUnder } = await import('../lib/private-files');
    const w = world();
    const link = join(w.base, 'ln');
    symlinkSync(w.proj, link);
    expect(isUnder(join(w.proj, 'src/a.ts'), w.proj)).toBe(true);
    expect(isUnder(w.proj, w.proj)).toBe(true);
    expect(isUnder(join(link, 'src/a.ts'), w.proj)).toBe(true);
    expect(isUnder(join(w.base, 'projx', 'a'), w.proj)).toBe(false);
    expect(worktreeArg(['f.json'])).toEqual({ dir: null, rest: ['f.json'] });
    expect(worktreeArg(['--worktree', 'd', 'f.json'])).toEqual({ dir: 'd', rest: ['f.json'] });
    expect(worktreeArg(['f.json', '--worktree=d'])).toEqual({ dir: 'd', rest: ['f.json'] });
    expect(worktreeArg(['--worktree'])).toMatchObject({ dir: null, error: '--worktree needs a directory' });
    expect(worktreeArg(['--worktree', ' '])).toMatchObject({ error: '--worktree needs a directory' });
  });

  /** cmdTestWrite here, with process.exit turned into a throw and stdio captured. */
  async function inProcess(cwd: string, args: string[], body: unknown, shell: string) {
    const file = write(tmp('goodboy-v17-in-'), 'in.json', JSON.stringify(body));
    const { cmdTestWrite } = cliLib;
    const exit = process.exit;
    const o = process.stdout.write;
    const e = process.stderr.write;
    let out = '';
    let err = '';
    process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => ((err += String(c)), true)) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit;
    let threw = '';
    try {
      await cmdTestWrite(cwd, [...args, file], shell);
    } catch (x) {
      threw = (x as Error).message;
    } finally {
      process.exit = exit;
      process.stdout.write = o;
      process.stderr.write = e;
    }
    return { out, err, threw };
  }

  test('cmdTestWrite --worktree in this process: the record, the refusals, the warnings', async () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    const ok = await inProcess(w.proj, ['--worktree', wt], input(['src/a.ts'], ['a.test.ts']), w.base);
    expect([ok.threw, ok.err]).toEqual(['', '']);
    const saved = JSON.parse(readFileSync((JSON.parse(ok.out) as { path: string }).path, 'utf8')) as Record<string, unknown>;
    expect(saved).toMatchObject({ commit: w.first, tree: treeOfCommit(w.proj, w.first), worktree: wt });
    expect(saved.trees).toBeUndefined();
    const out = await inProcess(w.proj, ['--worktree', wt], input([join(w.proj, 'src/a.ts')], ['a.test.ts']), w.base);
    expect(out.threw).toBe('exit 1');
    expect(out.err).toContain('is not in the worktree');
    const bad = await inProcess(w.proj, ['--worktree', join(w.base, 'nope')], input(['src/a.ts'], ['a.test.ts']), w.base);
    expect([bad.threw, bad.err.includes('test-write --worktree:')]).toEqual(['exit 1', true]);
    const none = await inProcess(w.proj, ['--worktree='], input(['src/a.ts'], ['a.test.ts']), w.base);
    expect(none.err).toContain('--worktree needs a directory');
    // Without --worktree nothing changes: the project dir's tree, no `worktree`.
    const plain = await inProcess(w.proj, [], input([join(w.proj, 'src/a.ts')], [join(w.proj, 'a.test.ts')]), w.base);
    const p = JSON.parse(readFileSync((JSON.parse(plain.out) as { path: string }).path, 'utf8')) as Record<string, unknown>;
    expect(p.worktree).toBeUndefined();
    expect(p.tree).toBe(pt.workTreeState(w.proj).tree);
  });

  test('a mutation run among the suites is warned about after the write (stderr), and still recorded', async () => {
    const w = world();
    const suites = [{ name: 'mutants', command: 'bun test mutants', passed: 1, failed: 2, output: '2 fail', type: 'unit', duration_ms: 5 }];
    const r = await inProcess(w.proj, [], input([join(w.proj, 'src/a.ts')], [join(w.proj, 'a.test.ts')], { suites, verdict: 'fail' }), w.base);
    expect(r.err).toContain('suite "mutants" has 2 failure(s) and looks like a mutation run');
    expect(readdirSync(join(w.proj, '.claude', 'tests'))).toHaveLength(1);
  });
});

// ── V17-AC-3 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V17-AC-3: regression --worktree', () => {
  test('runs in the worktree and records `worktree` and the commit\'s tree; the project dir\'s local file is not in it', () => {
    const w = world();
    localOnly(w);
    const wt = w.worktree(join(w.base, 'wt-reg'), w.first);
    const r = w.cli(w.proj, ['regression', '--worktree', wt]);
    expect([r.code, r.err]).toEqual([0, '']);
    const rec = JSON.parse(readFileSync((JSON.parse(r.out) as { path: string }).path, 'utf8')) as Record<string, unknown> & { runs: { output_tail: string }[] };
    expect(rec.worktree).toBe(wt);
    expect(rec.tree).toBe(treeOfCommit(w.proj, w.first));
    expect(rec.commit).toBe(w.first);
    expect(rec.verdict).toBe('pass');
    expect(rec.runs[0]!.output_tail).toContain('ran-in-wt-reg');
    expect(readdirSync(join(w.proj, '.claude', 'tests', 'regression'))).toHaveLength(1);
  });

  test('in this process: cmdRegression --worktree records the worktree; a dirty one and a missing value exit 1', async () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt-ip'));
    const cwd0 = process.cwd();
    const exit = process.exit;
    const o = process.stdout.write;
    const e = process.stderr.write;
    let out = '';
    let err = '';
    const run = async (args: string[]) => {
      out = '';
      err = '';
      process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
      process.stderr.write = ((c: string | Uint8Array) => ((err += String(c)), true)) as typeof process.stderr.write;
      process.exit = ((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as typeof process.exit;
      process.chdir(w.proj);
      try {
        await cliLib.cmdRegression(w.proj, args);
        return '';
      } catch (x) {
        return (x as Error).message;
      } finally {
        process.chdir(cwd0);
        process.exit = exit;
        process.stdout.write = o;
        process.stderr.write = e;
      }
    };
    expect(await run(['--worktree', wt])).toBe('');
    const rec = JSON.parse(readFileSync((JSON.parse(out) as { path: string }).path, 'utf8')) as Record<string, unknown>;
    expect([rec.worktree, rec.verdict, rec.tree]).toEqual([wt, 'pass', treeOfCommit(w.proj, w.first)]);
    expect(await run(['--worktree'])).toBe('exit 1');
    expect(err).toContain('regression: --worktree needs a directory');
    write(wt, 'dirt.txt', 'x');
    expect(await run(['--worktree', wt])).toBe('exit 1');
    expect(err).toContain('regression --worktree:');
    expect(await run([])).toBe('');
    expect((JSON.parse(readFileSync((JSON.parse(out) as { path: string }).path, 'utf8')) as Record<string, unknown>).worktree).toBeUndefined();
  });

  test('without --worktree the record has no `worktree`', () => {
    const w = world();
    const r = w.cli(w.proj, ['regression']);
    expect(r.code).toBe(0);
    const rec = JSON.parse(readFileSync((JSON.parse(r.out) as { path: string }).path, 'utf8')) as Record<string, unknown>;
    expect(rec.worktree).toBeUndefined();
  });

  test('a dirty or foreign worktree is refused, with no record', () => {
    const w = world();
    const wt = w.worktree(join(w.base, 'wt'));
    write(wt, 'dirt.txt', 'x');
    const r = w.cli(w.proj, ['regression', '--worktree', wt]);
    expect([r.code, r.err.includes('regression --worktree:'), r.err.includes('is not clean (dirt.txt)')]).toEqual([1, true, true]);
    const own = w.cli(w.proj, ['regression', '--worktree', w.proj]);
    expect([own.code, own.err.includes("own checkout")]).toEqual([1, true]);
    expect(existsSync(join(w.proj, '.claude', 'tests', 'regression'))).toBe(false);
  });
});

// ── V17-AC-4 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V17-AC-4: the push denial names the way out for a commit', () => {
  const noResult = (rev: string, differs?: string[]) => ({ ok: false as const, why: 'no-result' as const, rev, tree: 'a'.repeat(40), ...(differs ? { differs } : {}) });

  test('a commit that differs: `.git/info/exclude` and `--worktree`', () => {
    const msg = pt.pushTestMessage('`git push`', noResult('HEAD', ['local.cfg']));
    expect(msg).toContain('`.git/info/exclude`');
    // The main session makes the worktree (a test agent may not write .git); the test agent runs the tests there.
    expect(msg).toContain('the main session makes it');
    expect(msg).toContain('git worktree add --detach <dir> <commit>');
    expect(msg).toContain('test-write --worktree <dir>');
    expect(msg).toContain('regression --worktree <dir>');
    expect(msg).toContain('differs from the newest passing result in: local.cfg');
  });

  test('the working tree, or no difference: no hint', () => {
    const wtree = pt.pushTestMessage('`deploy`', noResult(pt.WORKTREE, ['local.cfg']));
    expect(wtree).not.toContain('.git/info/exclude');
    expect(pt.pushTestMessage('`git push`', noResult('HEAD'))).not.toContain('.git/info/exclude');
  });

  test('isArtifactPath is exported and knows goodboy\'s paths', () => {
    expect(pt.isArtifactPath('.claude/tests/a.json')).toBe(true);
    expect(pt.isArtifactPath('.goodboy/policy.md')).toBe(true);
    expect(pt.isArtifactPath('src/a.ts')).toBe(false);
  });
});

// ── V17-AC-5 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V17-AC-5: mutationSuiteWarnings', () => {
  const suite = (over: Record<string, unknown>) => ({ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '', type: 'unit', duration_ms: 1, ...over }) as TestResult['suites'][number];

  test('a failing suite named or run as mutants/mutation warns, once each', () => {
    const w = cliLib.mutationSuiteWarnings([suite({ name: 'Mutants', failed: 2 }), suite({ command: 'run-mutation.sh', failed: 1 }), suite({ name: 'mutation probe', failed: 3 })]);
    expect(w).toHaveLength(3);
    expect(w[0]).toContain('suite "Mutants" has 2 failure(s)');
    expect(w[0]).toContain("criterion's `mutation`");
  });

  test('silent: a passing mutation suite, a failing one with another name, no suites, a malformed entry', () => {
    expect(cliLib.mutationSuiteWarnings([suite({ name: 'mutants', failed: 0 })])).toEqual([]);
    expect(cliLib.mutationSuiteWarnings([suite({ name: 'unit', failed: 4 })])).toEqual([]);
    expect(cliLib.mutationSuiteWarnings(undefined)).toEqual([]);
    expect(cliLib.mutationSuiteWarnings([null as never, suite({ name: 'mutants', failed: 'x' as never })])).toEqual([]);
  });

  test('through the CLI: the warning is on stderr after the write', () => {
    const w = world();
    const suites = [{ name: 'mutants', command: 'x', passed: 0, failed: 1, output: 'f', type: 'unit', duration_ms: 1 }];
    const r = w.record([], { suites, verdict: 'fail' });
    expect(r.err).toContain('looks like a mutation run');
  });
});

// ── V17-AC-6 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V17-AC-6: absentRecordWarnings, and the Stop shows the warning once', () => {
  const rec = (tested: string[], over: Record<string, unknown> = {}) =>
    ({ timestamp: '2026-11-05T01:02:03.000Z', category: 'fix-bug', tested_files: tested, test_files: ['/gone/a.test.ts'], verdict: 'pass', ...over }) as unknown as TestResult;

  test('a dropped record that tested an edited file: one Korean line, once per record key', () => {
    const dropped = [{ record: rec(['/p/a.ts']), file: '/gone/a.test.ts' }];
    const first = validator.absentRecordWarnings(dropped, ['/p/a.ts'], []);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toContain('2026-11-05T01:02:03.000Z');
    expect(first.lines[0]).toContain('/gone/a.test.ts');
    expect(first.lines[0]).toContain('증거로 세지 않았어요');
    expect(first.shown).toEqual(['2026-11-05T01:02:03.000Z|fix-bug']);
    const again = validator.absentRecordWarnings(dropped, ['/p/a.ts'], first.shown);
    expect(again).toEqual({ lines: [], shown: first.shown });
  });

  test('a dropped record of other files shows none; two records with the same key show one', () => {
    expect(validator.absentRecordWarnings([{ record: rec(['/p/other.ts']), file: '/g' }], ['/p/a.ts'], []).lines).toEqual([]);
    expect(validator.absentRecordWarnings([{ record: rec([]), file: '/g' }], ['/p/a.ts'], []).lines).toEqual([]);
    const two = validator.absentRecordWarnings([{ record: rec(['/p/a.ts']), file: '/g' }, { record: rec(['/p/a.ts']), file: '/g' }], ['/p/a.ts'], []);
    expect(two.lines).toHaveLength(1);
  });

  test('the remembered keys are capped at 200, newest kept', () => {
    const shown = Array.from({ length: 200 }, (_, i) => `k${i}`);
    const r = validator.absentRecordWarnings([{ record: rec(['/p/a.ts']), file: '/g' }], ['/p/a.ts'], shown);
    expect(r.shown).toHaveLength(200);
    expect(r.shown[199]).toBe('2026-11-05T01:02:03.000Z|fix-bug');
    expect(r.shown[0]).toBe('k1');
  });

  test('at most 5 lines per call, then one count line; every key is remembered', () => {
    const dropped = Array.from({ length: 8 }, (_, i) => ({ record: rec(['/p/a.ts'], { timestamp: `2026-11-05T01:02:0${i}.000Z` }), file: '/g' }));
    const r = validator.absentRecordWarnings(dropped, ['/p/a.ts'], []);
    expect(r.lines).toHaveLength(6);
    expect(r.lines[5]).toBe('[goodboy] 같은 이유로 세지 않은 테스트 기록이 3건 더 있어요.');
    expect(r.shown).toHaveLength(8);
    expect(validator.absentRecordWarnings(dropped, ['/p/a.ts'], r.shown).lines).toEqual([]);
    // Exactly 5: no count line.
    expect(validator.absentRecordWarnings(dropped.slice(0, 5), ['/p/a.ts'], []).lines).toHaveLength(5);
  });

  test('withoutAbsentTests hands back the dropped records with the missing file', () => {
    const gone = rec(['/p/a.ts']);
    const out = validator.withoutAbsentTests([gone, rec(['/p/b.ts'], { test_files: [] })]);
    expect(out.dropped).toEqual([{ record: gone, file: '/gone/a.test.ts' }]);
    expect(out.kept).toHaveLength(1);
  });

  // The Stop as a process (hooks/stop.ts is exempt from changed-line coverage, policy P5: this is its proof).
  function project() {
    const d = tmp('goodboy-v17s-');
    write(d, 'src/calc.ts', 'export const a = 1;\n');
    write(d, 'src/other.ts', 'export const o = 1;\n');
    write(d, 'tests/a.test.ts', 'test("a", () => {});\n');
    sh(d, GIT_INIT);
    commitAll(d, 'init');
    const s = `v17${Math.random().toString(36).slice(2, 10)}`;
    dirs.push(join(tmpdir(), `goodboy-session-${s}`));
    pinCoverageStart(s, d);
    const a = write(d, 'src/calc.ts', 'export const a = 1;\nexport const b = 2;\n');
    recordEdit(s, a, 0, undefined, Date.now());
    return { d, s, a };
  }
  function putGone(d: string, tested: string[]): void {
    const dir = join(d, '.claude', 'tests');
    mkdirSync(dir, { recursive: true });
    const r = {
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      commit: sh(d, 'git rev-parse HEAD'),
      tested_files: tested,
      category: 'fix-bug',
      test_files: [join(d, 'tests', 'removed-worktree.test.ts')],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [
        { id: 'AC-1', description: 'b', test: 'tests/a.test.ts', red: { command: 'x', output: '1 fail', exit_code: 1 }, green: { command: 'x', output: '1 pass', exit_code: 0 } },
      ],
      verdict: 'pass',
    };
    writeFileSync(join(dir, 'r.json'), JSON.stringify(r));
  }
  async function stop(d: string, s: string) {
    const p = Bun.spawn(['bun', STOP], {
      cwd: d,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECT_DIR: d, GOODBOY_TEST_GATE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off' },
    });
    const out = (await new Response(p.stdout).text()) || '{}';
    await p.exited;
    return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
  }

  test('the Stop: a dropped record that tested the edited file shows one warning line, and not again at the next Stop', async () => {
    const { d, s, a } = project();
    putGone(d, [a]);
    const first = await stop(d, s);
    expect(first.decision).toBe('block');
    const lines = (first.systemMessage ?? '').split('\n').filter((l) => l.includes('증거로 세지 않았어요'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('removed-worktree.test.ts');
    const second = await stop(d, s);
    expect(second.systemMessage ?? '').not.toContain('증거로 세지 않았어요');
  });

  test('the Stop: a dropped record of other files shows none', async () => {
    const { d, s } = project();
    putGone(d, [join(d, 'src', 'other.ts')]);
    const out = await stop(d, s);
    expect(out.systemMessage ?? '').not.toContain('증거로 세지 않았어요');
  });
});

// ── V17-AC-8 ────────────────────────────────────────────────────────────────────────────────────────────

describe("V17-AC-8: a worktree record's test files are scanned at their path in the worktree", () => {
  const TODO = 'test("a", () => { expect(1).toBe(1); });\ntest.todo("a known limit");\n';

  /** proj with a bare remote that holds a commit whose a.test.ts has an old todo; HEAD is one commit ahead. */
  function pushed(addTodo: boolean): World {
    const w = world();
    write(w.proj, 'a.test.ts', TODO);
    commitAll(w.proj, 'todo');
    const remote = join(w.base, 'remote.git');
    sh(w.base, `git init -q --bare '${remote}'`);
    sh(w.proj, `git remote add origin '${remote}' && git push -q origin HEAD:refs/heads/main && git fetch -q origin`);
    if (addTodo) write(w.proj, 'a.test.ts', TODO + 'test.todo("added by this push");\n');
    else write(w.proj, 'src/b.ts', 'export const b = 2;\n');
    commitAll(w.proj, 'ahead');
    return w;
  }
  const verdictOf = (w: World, wt: string) => {
    const r = w.record(['--worktree', wt]);
    expect([r.code, r.err]).toEqual([0, '']);
    return pt.checkHandoff(handoff(w, 'HEAD'), [r.saved as unknown as TestResult]);
  };

  for (const where of ['nested', 'outside']) {
    const at = (w: World) => (where === 'nested' ? join(w.proj, '.claude', 'worktrees', 'x') : join(w.base, 'wt-scan'));

    test(`${where} worktree: a todo the push adds is refused`, () => {
      const w = pushed(true);
      const out = verdictOf(w, w.worktree(at(w)));
      expect(out).toMatchObject({ ok: false, why: 'no-result', rejected: 'a test file has an always-true pattern' });
    });

    test(`${where} worktree: an old todo the push does not add passes`, () => {
      const w = pushed(false);
      expect(verdictOf(w, w.worktree(at(w)))).toEqual({ ok: true });
    });
  }

  test('pushedTestLines: the root argument maps a file of another checkout; the default is the handed-off top', () => {
    const w = pushed(true);
    const wt = w.worktree(join(w.base, 'wt-root'));
    const lines = pt.pushedTestLines(w.proj, 'HEAD')!;
    expect([...lines(join(wt, 'a.test.ts'), wt)!]).toEqual([3]);
    expect([...lines(join(w.proj, 'a.test.ts'))!]).toEqual([3]);
    expect(lines(join(wt, 'a.test.ts'))).toBeNull(); // outside the default root, no root given: read whole
  });
});

// ── V17-AC-9 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V17-AC-9: with --worktree the test files are looked up in the worktree only', () => {
  test('a relative test file that exists only in the worktree is accepted; one only in the project dir is refused', () => {
    const w = world();
    write(w.proj, 'wt-only.test.ts', 'test("w", () => {});\n');
    commitAll(w.proj, 'wtonly');
    const wt = w.worktree(join(w.base, 'wt-look'));
    sh(w.proj, 'git rm -q wt-only.test.ts && git commit -q -m rm');
    write(w.proj, 'proj-only.test.ts', 'test("p", () => {});\n');
    const ok = w.cli(w.proj, ['test-write', '--worktree', wt], JSON.stringify(input(['src/a.ts'], ['wt-only.test.ts'])));
    expect([ok.code, ok.err]).toEqual([0, '']);
    const saved = JSON.parse(readFileSync((JSON.parse(ok.out) as { path: string }).path, 'utf8')) as { test_files: string[] };
    expect(saved.test_files).toEqual([join(wt, 'wt-only.test.ts')]);
    const bad = w.cli(w.proj, ['test-write', '--worktree', wt], JSON.stringify(input(['src/a.ts'], ['proj-only.test.ts'])));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('proj-only.test.ts');
  });
});
