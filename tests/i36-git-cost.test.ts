// v0.36.6, part 1 (gate cost): one git spawn helper with mandatory protections at every site, the
// resolver that skips the /usr/bin/git shim on macOS, the limited per-Stop memo, and the build-copy
// budgets. Repos are temporary; a `git` first on PATH records every call (arguments, directory,
// the environment that matters) and runs the real one. The new lib modules are imported inside the
// tests that need them, so a red run on an older tree fails those tests and not the whole file.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { blobAtCommit, differFromBase, emptyTree, extraBlobsFor, hookGit, pinCoverageStart, repoTop } from '../lib/changed-coverage';
import { commitIssueDenial } from '../lib/commit-issue';
import { changedLines } from '../lib/diff-coverage';
import { changedStartTests, startTestFiles } from '../lib/existing-tests';
import { privateTerms } from '../lib/field-report';
import { recordEdit } from '../lib/file-tracker';
import { pinWorktrees, projectDir } from '../lib/project-dir';
import { revisionTree, topOf, workTreeState } from '../lib/push-test';
import { requiredDimensionsFor } from '../lib/review-dimensions';
import { changedLineCount } from '../lib/review-scope';
import { productEvidenceProblems } from '../lib/session-criteria';
import { catalogRows } from '../lib/test-catalog';
import { surveyProject } from '../lib/test-survey';
import { statusFiles } from '../lib/write-sweep';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
// Real subprocesses on a loaded machine: generous limits, never a tighter production budget.
setDefaultTimeout(60_000);

const dirs: string[] = [];
const restore: (() => void)[] = [];
afterEach(async () => {
  while (restore.length) restore.pop()!();
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  try {
    (await import('../lib/git-run')).endGitSnapshot();
    (await import('../lib/git-binary')).resetGitBinary();
  } catch {
    // an older tree has neither module
  }
});

const real = (p: string) => realpathSync(p);
const tmp = (prefix: string): string => {
  const d = real(mkdtempSync(join(tmpdir(), `goodboy-i36-${prefix}-`)));
  dirs.push(d);
  return d;
};
/** The real git, as `bun test` finds it first on PATH (before any fake is installed). */
const REAL_GIT = Bun.which('git', { PATH: process.env.PATH })!;
const sh = (cwd: string, cmd: string): string => {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  return (p.stdout.toString() + p.stderr.toString()).trim();
};
function write(root: string, rel: string, text: string): string {
  const a = join(root, rel);
  mkdirSync(dirname(a), { recursive: true });
  writeFileSync(a, text);
  return a;
}
function sid(): string {
  const s = `i36${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
const V1 = 'export function f(x) {\n  return x + 1;\n}\n';
const V2 = 'export function f(x) {\n  return x + 2;\n}\n';

interface Repo {
  d: string;
  head: string;
}
/** A committed repo: a.txt, src/app.js, tests/app.test.js, `.gitignore` (target/ and build/). */
function repo(extra: Record<string, string> = {}): Repo {
  const d = tmp('repo');
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  write(d, '.gitignore', 'target/\nbuild/\n');
  write(d, 'a.txt', 'a\n');
  write(d, 'src/app.js', V1);
  write(d, 'tests/app.test.js', 'import { test } from "node:test";\ntest("f", () => {});\n');
  for (const [rel, text] of Object.entries(extra)) write(d, rel, text);
  sh(d, 'git add -A && git commit -q -m "#1 init"');
  return { d, head: sh(d, 'git rev-parse HEAD') };
}

// ── A git first on PATH that records every call ────────────────────────────────────────────────

const FAKE = [
  '#!/bin/sh',
  '{',
  "  printf 'CALL\\n'",
  "  printf 'CWD:%s\\n' \"$PWD\"",
  '  for a in "$@"; do printf \'A:%s\\n\' "$a"; done',
  "  printf 'E:ALLOW=%s\\nE:LAZY=%s\\nE:GRAFT=%s\\nE:INDEX=%s\\nE:EXPLICIT=%s\\nE:EVIL=%s\\n' \"$GIT_ALLOW_PROTOCOL\" \"$GIT_NO_LAZY_FETCH\" \"$GIT_GRAFT_FILE\" \"$GIT_INDEX_FILE\" \"$GB_EXPLICIT\" \"$GB_EVIL\"",
  "  printf 'END\\n'",
  '} >> "$GB_LOG"',
  // GB_FAIL: every call whose arguments contain it fails; GB_FAIL_ONCE: only the first such call.
  'if [ -n "$GB_FAIL" ]; then case "$*" in *"$GB_FAIL"*) exit "${GB_FAIL_CODE:-128}" ;; esac; fi',
  'if [ -n "$GB_FAIL_ONCE" ]; then case "$*" in *"$GB_FAIL_ONCE"*) if [ ! -e "$GB_LOG.once" ]; then : > "$GB_LOG.once"; exit 128; fi ;; esac; fi',
  'if [ -n "$GB_SLEEP_ON" ]; then case "$*" in *"$GB_SLEEP_ON"*) exec sleep 20 ;; esac; fi',
  'if [ -n "$GB_SLEEP_ONCE" ]; then case "$*" in *"$GB_SLEEP_ONCE"*) if [ ! -e "$GB_LOG.slept" ]; then : > "$GB_LOG.slept"; exec sleep 20; fi ;; esac; fi',
  // GB_RM: a file that vanishes when git is first asked (a file removed between two checks).
  'if [ -n "$GB_RM" ]; then rm -f "$GB_RM"; fi',
  // GB_CAPTURE_STDIN: keep what a call is fed (the last one's), and pass it on.
  'if [ -n "$GB_CAPTURE_STDIN" ]; then cat > "$GB_LOG.stdin"; exec "$GB_REAL" "$@" < "$GB_LOG.stdin"; fi',
  'exec "$GB_REAL" "$@"',
  '',
].join('\n');

interface Call {
  cwd: string;
  args: string[];
  env: Record<string, string>;
}
interface Fake {
  dir: string;
  calls: () => Call[];
  /** What the last call was fed (with GB_CAPTURE_STDIN set). */
  stdin: () => string;
  reset: () => void;
}
/** Installs the recording git first on PATH of this process (and so of every spawn that passes
 *  `process.env`); `env` is set too. Undone after the test. */
function fakeGit(env: Record<string, string> = {}): Fake {
  const dir = tmp('fake');
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'git'), FAKE);
  chmodSync(join(dir, 'git'), 0o755);
  const names = ['PATH', 'GB_LOG', 'GB_REAL', ...Object.keys(env)];
  const saved = names.map((n) => process.env[n]);
  process.env.GB_LOG = log;
  process.env.GB_REAL = REAL_GIT;
  Object.assign(process.env, env);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
  restore.push(() => names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i]))));
  const calls = (): Call[] =>
    readFileSync(log, 'utf8')
      .split('CALL\n')
      .filter((b) => b !== '')
      .map((b) => {
        const c: Call = { cwd: '', args: [], env: {} };
        for (const l of b.split('\n')) {
          if (l.startsWith('CWD:')) c.cwd = l.slice(4);
          else if (l.startsWith('A:')) c.args.push(l.slice(2));
          else if (l.startsWith('E:')) c.env[l.slice(2, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
        }
        return c;
      });
  return {
    dir,
    calls,
    stdin: () => (existsSync(`${log}.stdin`) ? readFileSync(`${log}.stdin`, 'latin1') : ''),
    reset: () => {
      writeFileSync(log, '');
      for (const f of [`${log}.once`, `${log}.slept`, `${log}.stdin`]) rmSync(f, { force: true });
    },
  };
}
/** The subcommand of a recorded call: its first word that is no global option or `-c` value. */
const subOf = (c: Call): string => {
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i]!;
    if (a === '-c' || a === '-C') i++;
    else if (!a.startsWith('-')) return a;
  }
  return '';
};
const only = (f: Fake, sub: string): Call[] => f.calls().filter((c) => subOf(c) === sub);

// ── 1. The protections reach every caller ──────────────────────────────────────────────────────

describe('every git a hook or library runs carries the safety settings', () => {
  /** What every call must have, whoever the caller is. `replace`: false for the commit issue rule,
   *  which reads the user's own command as git will run it for them. */
  function expectSafe(f: Fake, why: string, replace = true): void {
    const calls = f.calls();
    expect([why, calls.length > 0]).toEqual([why, true]); // the recording git was the one that ran
    for (const c of calls) {
      const line = `${why}: git ${c.args.join(' ')}`;
      expect([line, c.args.includes('--no-replace-objects')]).toEqual([line, replace]);
      expect([line, c.args.join(' ').includes('-c core.fsmonitor=false')]).toEqual([line, true]);
      expect([line, c.args.join(' ').includes('-c log.showSignature=false')]).toEqual([line, true]);
      expect([line, c.env]).toEqual([line, expect.objectContaining({ ALLOW: 'goodboy-none', LAZY: '1', GRAFT: '/dev/null' })]);
    }
  }

  const sites: [string, (r: Repo) => unknown][] = [
    ['changed-coverage repoTop', (r) => repoTop(r.d)],
    ['changed-coverage emptyTree', (r) => emptyTree(r.d)],
    ['changed-coverage differFromBase', (r) => differFromBase(r.d, r.head, ['a.txt'])],
    ['changed-coverage blobAtCommit', (r) => blobAtCommit(r.d, r.head, 'a.txt', 1_000)],
    ['changed-coverage hookGit', (r) => hookGit(r.d, ['rev-parse', '--git-dir'])],
    ['diff-coverage changedLines', (r) => changedLines(r.d, r.head, ['a.txt'])],
    ['existing-tests startTestFiles', (r) => startTestFiles(r.d, r.head)],
    ['existing-tests changedStartTests', (r) => changedStartTests(r.d, r.head)],
    ['push-test topOf', (r) => topOf(r.d)],
    ['push-test revisionTree', (r) => revisionTree(r.d, 'HEAD')],
    ['push-test workTreeState', (r) => workTreeState(r.d)],
    ['review-scope changedLineCount', (r) => changedLineCount(r.d, [join(r.d, 'a.txt')])],
    ['write-sweep statusFiles', (r) => statusFiles(r.d)],
    ['test-catalog catalogRows', (r) => catalogRows(r.d)],
    ['test-survey surveyProject', (r) => surveyProject(r.d)],
    ['project-dir pinWorktrees', (r) => pinWorktrees(sid(), { CLAUDE_PROJECT_DIR: r.d })],
    ['field-report privateTerms', (r) => privateTerms(r.d)],
  ];
  for (const [name, run] of sites) {
    test(name, () => {
      const r = repo();
      write(r.d, 'a.txt', 'changed\n'); // the diff and status callers have something to look at
      const f = fakeGit({ GB_EXPLICIT: 'kept' });
      run(r);
      expectSafe(f, name);
      expect(f.calls().every((c) => c.env.EXPLICIT === 'kept')).toBe(true); // the process environment goes along
    });
  }

  test('review-scope: the diff names no external diff and no textconv', () => {
    const r = repo();
    write(r.d, 'a.txt', 'changed\n');
    const f = fakeGit();
    changedLineCount(r.d, [join(r.d, 'a.txt')]);
    const diff = only(f, 'diff')[0]!;
    expect(diff.args).toContain('--no-ext-diff');
    expect(diff.args).toContain('--no-textconv');
  });

  test('project-dir: the worktree check (sharesRepo) is protected too', () => {
    const r = repo();
    const wt = join(r.d, '.claude', 'worktrees', 'w1');
    sh(r.d, `git worktree add -q "${wt}" -b w1`);
    const f = fakeGit();
    expect(projectDir(wt, { CLAUDE_PROJECT_DIR: r.d }, sid())).toBe(real(wt));
    expect(only(f, 'worktree').length).toBeGreaterThan(0);
    expectSafe(f, 'sharesRepo');
  });

  test('commit issue rule: protected, and the user command reads replace refs as the user git will', () => {
    const r = repo();
    const f = fakeGit();
    // `--amend --no-edit` reuses HEAD's message: a `git log` of it; an unknown subcommand looks an alias up.
    expect(commitIssueDenial('git commit --amend --no-edit', r.d, sid())).toBeNull();
    commitIssueDenial('git -c user.name=x zz -m fix', r.d, sid());
    expect(only(f, 'log').length).toBeGreaterThan(0);
    expect(only(f, 'config').length).toBeGreaterThan(0);
    expectSafe(f, 'commit-issue', false);
    // The user's own `-c` comes first and the safety settings after it: the safety ones win.
    const alias = only(f, 'config')[0]!;
    expect(alias.args.indexOf('user.name=x')).toBeLessThan(alias.args.indexOf('core.fsmonitor=false'));
  });

  test('probes and smoke start their repo through the helper', () => {
    for (const f of ['probes.ts', 'smoke.ts']) expect([f, readFileSync(join(ROOT, 'lib', f), 'utf8').includes("spawnGit(project, ['init', '-q']")]).toEqual([f, true]);
  });

  /** A raw spawn of git in `src`: a spawn or exec call (Node's, Bun's, shell `$`) whose command is
   *  `git` or a path ending in `/git`, as a quoted first argument (alone or first in an array) or as
   *  the first word of a command string. */
  const SPAWN_OF_GIT = /\b(?:Bun\.spawnSync|Bun\.spawn|execFileSync|execFile|execSync|exec|spawnSync|spawn|fork)\s*\(\s*(?:\[\s*)?(['"`])((?:(?!\1)[^\\\n])*)\1/g;
  const GIT_WORD = /^\s*(?:\S*\/)?git(?:\s|$)/;
  const SHELL_GIT = /\$`\s*(?:\S*\/)?git\b/;
  function spawnsGit(src: string): boolean {
    for (const m of src.matchAll(SPAWN_OF_GIT)) if (GIT_WORD.test(m[2]!)) return true;
    return SHELL_GIT.test(src);
  }

  test('the detector sees every shape of a raw git spawn (and no other)', () => {
    for (const hit of [
      "Bun.spawnSync(['git', 'status'])",
      'spawnSync("git", ["log"])',
      "execFileSync('git', args)",
      'execSync("git status --porcelain")',
      "exec(`git log ${n}`)",
      "execSync('git')",
      "Bun.spawnSync(['/usr/bin/git', 'rev-parse'])",
      "spawn('/opt/homebrew/bin/git', ['diff'])",
      "execFile( '/usr/local/bin/git' , [])",
      'const out = await Bun.$`git status`;',
      "Bun.spawn([ \"git\", 'x'])",
    ]) expect([hit, spawnsGit(hit)]).toEqual([hit, true]);
    for (const miss of [
      "Bun.spawnSync(['claude', '--version'])",
      "spawnSync('gh', ['pr', 'view'])",
      "Bun.spawnSync([bin, ...full], { cwd })",
      "execSync('github-thing')",
      "spawn('gitk')",
      "const git = (args) => spawnGit(cwd, args);",
      "exec('echo git')",
    ]) expect([miss, spawnsGit(miss)]).toEqual([miss, false]);
  });

  test('no hook, library, bin script or status line spawns git itself', () => {
    const offenders: string[] = [];
    const files = [
      ...['lib', 'hooks', 'statusline'].flatMap((dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).map((n) => `${dir}/${n}`) : [])),
    ].filter((f) => f.endsWith('.ts') && f !== 'lib/git-run.ts');
    for (const f of files) if (spawnsGit(readFileSync(join(ROOT, f), 'utf8'))) offenders.push(f);
    // The binary the helper picks is the helper's: nothing else resolves one.
    for (const f of files) if (f !== 'lib/git-binary.ts' && /\bresolveGitBinary\b/.test(readFileSync(join(ROOT, f), 'utf8'))) offenders.push(`${f} (resolveGitBinary)`);
    expect(offenders).toEqual([]);
  });

  test("the safety settings follow the caller's -c and global options, and its environment never overrides them", async () => {
    const { spawnGit } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit({ GB_EVIL: 'process-env' });
    spawnGit(r.d, ['-c', 'core.fsmonitor=/evil', '-C', r.d, 'status', '--porcelain'], { env: { GB_EVIL: 'dropped', GIT_ALLOW_PROTOCOL: 'all', GIT_NO_LAZY_FETCH: '0', GIT_GRAFT_FILE: '/tmp/graft', GIT_INDEX_FILE: join(r.d, 'idx') } });
    const c = only(f, 'status')[0]!;
    expect(c.args.indexOf('core.fsmonitor=/evil')).toBeLessThan(c.args.indexOf('core.fsmonitor=false')); // git: the last `-c` wins
    expect(c.args.indexOf('core.fsmonitor=false')).toBeLessThan(c.args.indexOf('status'));
    expect(c.env.ALLOW).toBe('goodboy-none');
    expect(c.env.LAZY).toBe('1');
    expect(c.env.GRAFT).toBe('/dev/null');
    expect(c.env.INDEX).toBe(join(r.d, 'idx')); // an operational override is kept
    expect(c.env.EVIL).toBe('process-env'); // only the operational names pass from a caller; the process env is as it was
  });

  test("arguments of global options only (no subcommand): the safety settings still come after the caller's, and no filter list is asked", async () => {
    const { spawnGit } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit();
    f.reset();
    const res = spawnGit(r.d, ['-c', 'core.fsmonitor=/evil', '-c', 'a.b=c']);
    expect(res.ran).toBe(true); // git was run (it prints its usage)
    const calls = f.calls();
    expect(calls.length).toBe(1); // no `config --get-regexp` for a filter list: there is no subcommand to run one
    const c = calls[0]!;
    expect(c.args.slice(0, 4)).toEqual(['-c', 'core.fsmonitor=/evil', '-c', 'a.b=c']); // the caller's options stay first
    expect(c.args.indexOf('core.fsmonitor=/evil')).toBeLessThan(c.args.indexOf('core.fsmonitor=false')); // git: the last `-c` wins
    expect(c.args).toContain('--no-replace-objects');
    expect(c.env).toEqual(expect.objectContaining({ ALLOW: 'goodboy-none', LAZY: '1', GRAFT: '/dev/null' }));
    // A value-taking option with no value is global-only too, and not an out-of-range read.
    f.reset();
    spawnGit(r.d, ['-C']);
    expect(f.calls()[0]!.args[0]).toBe('-C');
    expect(f.calls()[0]!.args).toContain('--no-replace-objects');
  });
});

// ── 2. A hostile repo config does not run ──────────────────────────────────────────────────────

describe('hostile filter, fsmonitor, replace and graft configuration', () => {
  /** A repo whose config names a clean filter for every file and an fsmonitor hook; each writes a
   *  marker. a.txt is edited so every diff and status has to read it. */
  function hostile() {
    const r = repo();
    const aux = tmp('hostile');
    const clean = join(aux, 'clean.sh');
    const monitor = join(aux, 'monitor.sh');
    const marks = { filter: join(aux, 'filter-ran'), monitor: join(aux, 'monitor-ran') };
    writeFileSync(clean, `#!/bin/sh\necho ran >> "${marks.filter}"\ncat\n`);
    writeFileSync(monitor, `#!/bin/sh\necho ran >> "${marks.monitor}"\nexit 1\n`);
    chmodSync(clean, 0o755);
    chmodSync(monitor, 0o755);
    write(r.d, '.gitattributes', '* filter=evil\n');
    sh(r.d, `git config filter.evil.clean "${clean}" && git config core.fsmonitor "${monitor}"`);
    write(r.d, 'a.txt', 'edited\n');
    write(r.d, 'tests/new.test.js', 'x\n'); // untracked
    return { ...r, marks };
  }
  const ran = (marks: { filter: string; monitor: string }) => [existsSync(marks.filter), existsSync(marks.monitor)];

  test('the fixture is hostile: plain git runs both programs', () => {
    const h = hostile();
    sh(h.d, 'git hash-object a.txt');
    sh(h.d, 'git status --porcelain');
    expect(ran(h.marks)).toEqual([true, true]);
  });

  const callers: [string, (h: { d: string; head: string }) => unknown][] = [
    ['differFromBase (hash-object)', (h) => differFromBase(h.d, h.head, ['a.txt', 'src/app.js'])],
    ['changedLines (diff)', (h) => changedLines(h.d, h.head, ['a.txt'])],
    ['changedLineCount (diff --numstat)', (h) => changedLineCount(h.d, [join(h.d, 'a.txt')])],
    ['statusFiles (status)', (h) => statusFiles(h.d)],
    ['changedStartTests (diff --raw)', (h) => changedStartTests(h.d, h.head)],
    ['hookGit status', (h) => hookGit(h.d, ['status', '--porcelain'])],
    ['hookGit diff', (h) => hookGit(h.d, ['diff', 'HEAD'])],
    ['hookGit hash-object', (h) => hookGit(h.d, ['hash-object', '--', 'a.txt'])],
  ];
  for (const [name, run] of callers) {
    test(`${name} starts neither the filter nor the fsmonitor hook`, () => {
      const h = hostile();
      const out = run(h);
      expect(ran(h.marks)).toEqual([false, false]);
      expect(out).not.toBeNull();
    });
  }

  test('the filtered work tree still compares: the changed file differs from its base, the others do not', () => {
    const h = hostile();
    expect([...differFromBase(h.d, h.head, ['a.txt', 'src/app.js'])]).toEqual(['a.txt']);
  });

  test('when the filter list cannot be read, no command that could run a filter runs', async () => {
    const { spawnGit } = await import('../lib/git-run');
    const h = hostile();
    const f = fakeGit({ GB_FAIL: '--get-regexp' });
    expect(statusFiles(h.d)).toBeNull(); // no list, no `status`
    expect(only(f, 'status')).toEqual([]);
    const r = spawnGit(h.d, ['hash-object', '--', 'a.txt']);
    expect([r.ran, r.code]).toEqual([false, -1]);
    expect([...differFromBase(h.d, h.head, ['a.txt', 'src/app.js'])].sort()).toEqual(['a.txt', 'src/app.js']); // unknown counts as changed
    expect(only(f, 'hash-object')).toEqual([]);
    expect(ran(h.marks)).toEqual([false, false]);
    // A command that cannot run a filter does not need the list.
    expect(spawnGit(h.d, ['rev-parse', '--git-dir']).code).toBe(0);
  });

  test('no filter configured (exit 1 of the list) runs the command with no -c filter; a configured one is emptied', async () => {
    const { spawnGit } = await import('../lib/git-run');
    const plain = repo();
    const f = fakeGit();
    expect(spawnGit(plain.d, ['status', '--porcelain']).code).toBe(0);
    expect(only(f, 'status')[0]!.args.some((a) => a.startsWith('filter.'))).toBe(false);
    f.reset();
    const h = hostile();
    f.reset();
    spawnGit(h.d, ['status', '--porcelain']);
    const args = only(f, 'status')[0]!.args;
    for (const k of ['clean', 'process']) expect(args).toContain(`filter.evil.${k}=`);
    expect(args).toContain('filter.evil.required=false');
  });

  test("a filter the caller defines with its own -c, and a repo named by -C or --git-dir, are emptied too", async () => {
    const { spawnGit } = await import('../lib/git-run');
    const r = repo();
    const aux = tmp('own-filter');
    const mark = join(aux, 'mine-ran');
    const clean = join(aux, 'clean.sh');
    writeFileSync(clean, `#!/bin/sh\necho ran >> "${mark}"\ncat\n`);
    chmodSync(clean, 0o755);
    write(r.d, '.gitattributes', '* filter=mine\n'); // no `filter.mine` in the repo's config: only the caller's -c defines it
    write(r.d, 'a.txt', 'edited\n');
    // `hash-object --path` runs the clean filter every time; `status` runs it only for racily clean
    //   index entries, which made this fixture depend on timing (it failed under load).
    const file = join(r.d, 'a.txt');
    sh(r.d, `git -c filter.mine.clean="${clean}" hash-object --path=a.txt "${file}"`);
    expect(existsSync(mark)).toBe(true); // the fixture: plain git runs the caller's filter
    rmSync(mark);
    const f = fakeGit();
    const own = spawnGit(r.d, ['-c', `filter.mine.clean=${clean}`, 'hash-object', '--path=a.txt', file]);
    expect([own.ran, own.code, existsSync(mark)]).toEqual([true, 0, false]);
    const hashed = only(f, 'hash-object')[0]!.args;
    expect(hashed.lastIndexOf('filter.mine.clean=')).toBeGreaterThan(hashed.indexOf(`filter.mine.clean=${clean}`)); // after it: git takes the last
    // The list is read as the command sees the repo: a cwd outside any repo, the repo named by -C.
    const elsewhere = tmp('elsewhere');
    sh(r.d, `git config filter.cfg.clean "${clean}"`);
    write(r.d, '.gitattributes', '* filter=cfg\n');
    sh(r.d, `git hash-object --path=a.txt "${file}"`);
    expect(existsSync(mark)).toBe(true); // the fixture again: the repo's own filter runs for plain git
    rmSync(mark);
    const viaC = spawnGit(elsewhere, ['-C', r.d, 'hash-object', '--path=a.txt', file]);
    expect([viaC.ran, viaC.code, existsSync(mark)]).toEqual([true, 0, false]); // before: the list came from `elsewhere`, a non-repo, and the command did not run
    // --git-dir and --work-tree: the shell is in a work tree with no repo of its own, and the filter is
    //   in the config of the repo --git-dir names, so only a listing that carries --git-dir sees it.
    const other = repo();
    sh(other.d, `git config filter.cfg.clean "${clean}"`);
    const wt = tmp('worktree');
    write(wt, '.gitattributes', '* filter=cfg\n');
    write(wt, 'a.txt', 'edited\n');
    const wtFile = join(wt, 'a.txt');
    const dirArgs = ['--git-dir', join(other.d, '.git'), '--work-tree', wt, 'hash-object', '--path=a.txt', wtFile];
    sh(wt, `git ${dirArgs.map((a) => `"${a}"`).join(' ')}`);
    expect(existsSync(mark)).toBe(true); // the fixture: plain git runs the filter of the repo --git-dir names
    rmSync(mark);
    const viaDir = spawnGit(wt, dirArgs);
    expect([viaDir.ran, viaDir.code, existsSync(mark)]).toEqual([true, 0, false]);
    const lists = f.calls().filter((c) => c.args.includes('--get-regexp'));
    expect(lists.some((c) => c.args.includes('-C') && c.args.includes(r.d))).toBe(true); // the listing carried the caller's -C
    expect(lists.some((c) => c.args.includes('--git-dir') && c.args.includes(join(other.d, '.git')))).toBe(true); // and the caller's --git-dir
  });

  test("the listing takes only the caller's options that change which filters git sees, so a Stop keeps its one listing", async () => {
    const { spawnGit, withGitSnapshot } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit();
    withGitSnapshot(() => {
      spawnGit(r.d, ['status', '--porcelain']);
      spawnGit(r.d, ['-c', 'core.quotePath=false', 'diff', '--numstat', 'HEAD']); // another option: the same listing
      spawnGit(r.d, ['-c', 'core.quotePath=false', 'ls-files', '--others']);
    });
    expect(f.calls().filter((c) => c.args.includes('--get-regexp')).length).toBe(1);
    f.reset();
    withGitSnapshot(() => {
      spawnGit(r.d, ['status', '--porcelain']);
      spawnGit(r.d, ['-c', 'filter.mine.clean=cat', 'status', '--porcelain']); // defines a filter: its own listing
      spawnGit(r.d, ['-c', 'include.path=/nonexistent', 'status', '--porcelain']); // may include one
    });
    const lists = f.calls().filter((c) => c.args.includes('--get-regexp'));
    expect(lists.length).toBe(3);
    expect(lists.filter((c) => c.args.includes('core.quotePath=false')).length).toBe(0);
  });

  describe('a command that diffs runs no external diff program and no textconv', () => {
    /** diff.external and a textconv driver for every file, each writing a marker. */
    function programs() {
      const r = repo();
      const aux = tmp('diff-programs');
      const marks = { external: join(aux, 'external-ran'), textconv: join(aux, 'textconv-ran') };
      const external = join(aux, 'external.sh');
      const textconv = join(aux, 'textconv.sh');
      writeFileSync(external, `#!/bin/sh\necho ran >> "${marks.external}"\nexit 0\n`);
      writeFileSync(textconv, `#!/bin/sh\necho ran >> "${marks.textconv}"\ncat "$1"\n`);
      chmodSync(external, 0o755);
      chmodSync(textconv, 0o755);
      write(r.d, '.gitattributes', '* diff=tc\n');
      sh(r.d, `git config diff.external "${external}" && git config diff.tc.textconv "${textconv}"`);
      write(r.d, 'a.txt', 'edited\n');
      sh(r.d, 'git add .gitattributes && git commit -qm "#1 attrs"');
      write(r.d, 'a.txt', 'edited again\n');
      return { ...r, marks };
    }
    const ran = (m: { external: string; textconv: string }) => [existsSync(m.external), existsSync(m.textconv)];

    test('the fixture is hostile: plain git runs both', () => {
      const h = programs();
      sh(h.d, 'git diff HEAD');
      sh(h.d, 'git log -p -1');
      sh(h.d, 'git blame a.txt');
      expect(ran(h.marks)).toEqual([true, true]);
    });

    test('diff, show, log -p, blame and grep through the helper start neither', async () => {
      const { spawnGit } = await import('../lib/git-run');
      const h = programs();
      for (const args of [['diff', 'HEAD'], ['diff', '--numstat', 'HEAD'], ['show', 'HEAD'], ['log', '-p', '-2'], ['blame', 'a.txt'], ['grep', '-I', 'edited', 'HEAD', '--'], ['diff-index', '-p', 'HEAD'], ['diff-files', '-p'], ['diff-tree', '-p', 'HEAD']]) {
        const r = spawnGit(h.d, args);
        expect([args.join(' '), r.ran, r.code <= 1]).toEqual([args.join(' '), true, true]);
      }
      expect(ran(h.marks)).toEqual([false, false]);
      expect(hookGit(h.d, ['diff', 'HEAD']).out).toContain('edited again'); // and the diff itself is still the diff
    });

    test('the flags reach git: both for diff-family commands, textconv only for blame and grep, none elsewhere', async () => {
      const { spawnGit } = await import('../lib/git-run');
      const h = programs();
      const f = fakeGit();
      for (const args of [['diff', 'HEAD', '--'], ['show', 'HEAD'], ['log', '-1', '--end-of-options', 'HEAD', '--'], ['blame', 'a.txt'], ['grep', 'edited', 'HEAD', '--'], ['rev-parse', 'HEAD'], ['-c', 'x.y=z', 'diff', 'HEAD']]) spawnGit(h.d, args);
      const has = (sub: string, flag: string, nth = 0): boolean => only(f, sub)[nth]!.args.includes(flag);
      for (const sub of ['diff', 'show', 'log']) expect([sub, has(sub, '--no-ext-diff'), has(sub, '--no-textconv')]).toEqual([sub, true, true]);
      for (const sub of ['blame', 'grep']) expect([sub, has(sub, '--no-ext-diff'), has(sub, '--no-textconv')]).toEqual([sub, false, true]);
      expect(has('rev-parse', '--no-textconv')).toBe(false);
      const log = only(f, 'log')[0]!.args;
      expect(log.indexOf('--no-textconv')).toBeLessThan(log.indexOf('--end-of-options')); // inside the options
      const grep = only(f, 'grep')[0]!.args;
      expect(grep.indexOf('--no-textconv')).toBeLessThan(grep.indexOf('HEAD')); // before the revision: `grep <rev> --opt` reads it as a revision
      const withC = only(f, 'diff')[1]!.args;
      expect(withC.indexOf('--no-ext-diff')).toBeGreaterThan(withC.indexOf('diff')); // after the subcommand, whatever the global options
    });
  });

  test('the work-tree hash of a hand-off keeps the clean filters (the tree a commit stores)', async () => {
    const { spawnGit } = await import('../lib/git-run');
    const h = hostile();
    const f = fakeGit();
    workTreeState(h.d);
    expect(only(f, 'add')[0]!.args.some((a) => a.startsWith('filter.evil'))).toBe(false);
    expect(spawnGit(h.d, ['add', '-n', 'a.txt'], { keepFilters: true }).ran).toBe(true);
  });

  test('replace refs and grafts are not followed', () => {
    const r = repo();
    write(r.d, 'a.txt', 'two\n');
    sh(r.d, 'git commit -qam "#1 two"');
    const second = sh(r.d, 'git rev-parse HEAD');
    // First commit shows the other commit's tree under a replace ref.
    sh(r.d, `git replace ${r.head} ${second}`);
    expect(sh(r.d, `git cat-file -p ${r.head}:a.txt`)).toBe('two'); // plain git follows it
    expect(blobAtCommit(r.d, r.head, 'a.txt', 100)).toBe('a\n'); // the hook does not
    // A graft that makes an unrelated root commit an ancestor.
    sh(r.d, 'git checkout -q --orphan other && git rm -qrf . && git commit -q --allow-empty -m "#1 other"');
    const other = sh(r.d, 'git rev-parse HEAD');
    sh(r.d, 'git checkout -q main');
    writeFileSync(join(r.d, '.git', 'info', 'grafts'), `${second} ${other}\n`);
    expect(Bun.spawnSync(['git', 'merge-base', '--is-ancestor', other, second], { cwd: r.d, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stderr: 'pipe' }).exitCode).toBe(0); // plain git follows it
    expect(hookGit(r.d, ['merge-base', '--is-ancestor', other, second]).code).toBe(1); // the hook does not
  });
});

// ── 3. Which git binary ────────────────────────────────────────────────────────────────────────

describe('the git binary the hooks run (macOS shim)', () => {
  /** A shim dir with an executable `git`, a "real" git file, and a fake xcrun that logs its call and
   *  answers as the env says: X_RAW (printf %b), X_EXIT, X_SLEEP. */
  function world() {
    const dir = tmp('bin');
    const shimDir = join(dir, 'shim');
    const realDir = join(dir, 'real');
    const otherDir = join(dir, 'other');
    for (const d of [shimDir, realDir, otherDir]) mkdirSync(d);
    for (const f of [join(shimDir, 'git'), join(realDir, 'git'), join(otherDir, 'git')]) {
      writeFileSync(f, '#!/bin/sh\nexit 0\n');
      chmodSync(f, 0o755);
    }
    const xlog = join(dir, 'xcrun.log');
    const xcrun = join(dir, 'xcrun');
    writeFileSync(
      xcrun,
      `#!/bin/sh\necho "$PWD|$PATH|$DEVELOPER_DIR|$*" >> "${xlog}"\n[ -n "$X_SLEEP" ] && sleep "$X_SLEEP"\n[ -n "$X_RAW" ] && printf '%b' "$X_RAW"\nexit "\${X_EXIT:-0}"\n`,
    );
    chmodSync(xcrun, 0o755);
    const opts = { platform: 'darwin', xcrun, shim: join(shimDir, 'git') };
    const env = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: `${shimDir}${delimiter}/usr/bin${delimiter}/bin`, X_RAW: `${join(realDir, 'git')}\n`, ...extra });
    const xcalls = () => (existsSync(xlog) ? readFileSync(xlog, 'utf8').split('\n').filter(Boolean) : []);
    return { dir, shimDir, realDir, otherDir, opts, env, xcalls, realGit: join(realDir, 'git') };
  }

  test('the first git on PATH is the shim: the path xcrun names is used directly', async () => {
    const { resolveGitBinary } = await import('../lib/git-binary');
    const w = world();
    expect(resolveGitBinary(w.env(), w.dir, w.opts)).toBe(w.realGit);
    expect(resolveGitBinary(w.env({ X_RAW: w.realGit }), w.dir, { ...w.opts, xcrun: w.opts.xcrun })).toBe(w.realGit); // no trailing newline: still one line
  });

  test('xcrun gets the call environment and directory, and --find git', async () => {
    const { resolveGitBinary } = await import('../lib/git-binary');
    const w = world();
    resolveGitBinary(w.env({ DEVELOPER_DIR: '/opt/dev' }), w.dir, w.opts);
    expect(w.xcalls()).toEqual([`${w.dir}|${w.shimDir}:/usr/bin:/bin|/opt/dev|--find git`]);
  });

  test('not darwin, or no shim first on PATH: plain git and xcrun is never run', async () => {
    const { resolveGitBinary } = await import('../lib/git-binary');
    const w = world();
    expect(resolveGitBinary(w.env(), w.dir, { ...w.opts, platform: 'linux' })).toBe('git');
    expect(resolveGitBinary(w.env({ PATH: `${w.otherDir}${delimiter}${w.shimDir}` }), w.dir, w.opts)).toBe('git'); // another git first: already a direct binary
    expect(resolveGitBinary(w.env({ PATH: '/nonexistent' }), w.dir, w.opts)).toBe('git'); // no git at all
    expect(resolveGitBinary(w.env({ PATH: '' }), w.dir, w.opts)).toBe('git');
    // A link to the shim is another path, so it is not the shim.
    rmSync(join(w.otherDir, 'git'));
    symlinkSync(join(w.shimDir, 'git'), join(w.otherDir, 'git'));
    expect(resolveGitBinary(w.env({ PATH: `${w.otherDir}${delimiter}${w.shimDir}` }), w.dir, w.opts)).toBe('git');
    expect(w.xcalls()).toEqual([]);
  });

  test('xcrun failing, timing out, or printing anything but one absolute executable file: plain git', async () => {
    const { resolveGitBinary, resetGitBinary } = await import('../lib/git-binary');
    const w = world();
    const plain = join(w.dir, 'plain-file');
    writeFileSync(plain, 'x');
    chmodSync(plain, 0o644);
    const bad: [string, Record<string, string>][] = [
      ['exit 1', { X_EXIT: '1' }],
      ['exit 1 after printing a path', { X_EXIT: '1', X_RAW: `${w.realGit}\\n` }],
      ['two lines', { X_RAW: `${w.realGit}\\n${w.realGit}\\n` }],
      ['a blank line after', { X_RAW: `${w.realGit}\\n\\n` }],
      ['empty', { X_RAW: '' }],
      ['relative path that exists from here', { X_RAW: `${relative(process.cwd(), w.realGit)}\\n` }],
      ['relative path', { X_RAW: 'usr/bin/git\\n' }],
      ['not executable', { X_RAW: `${plain}\\n` }],
      ['a directory', { X_RAW: `${w.realDir}\\n` }],
      ['missing file', { X_RAW: `${w.dir}/nope/git\\n` }],
      ['a carriage return', { X_RAW: `${w.realGit}\\r\\n` }],
    ];
    for (const [name, extra] of bad) {
      resetGitBinary();
      expect([name, resolveGitBinary(w.env(extra), w.dir, w.opts)]).toEqual([name, 'git']);
    }
    resetGitBinary();
    const t0 = performance.now();
    expect(resolveGitBinary(w.env({ X_SLEEP: '10' }), w.dir, { ...w.opts, timeoutMs: 300 })).toBe('git');
    expect(performance.now() - t0).toBeLessThan(5_000); // cut off at the limit, not at xcrun's 10 s
  });

  test('an xcrun that cannot be started (the spawn throws): plain git, and the answer is not an error', async () => {
    const { resolveGitBinary } = await import('../lib/git-binary');
    const w = world();
    const missing = join(w.dir, 'no-such-dir', 'xcrun');
    expect(existsSync(missing)).toBe(false);
    expect(() => resolveGitBinary(w.env(), w.dir, { ...w.opts, xcrun: missing })).not.toThrow();
    expect(resolveGitBinary(w.env(), w.dir, { ...w.opts, xcrun: missing })).toBe('git');
    // A directory is no program either.
    expect(resolveGitBinary(w.env({ DEVELOPER_DIR: '/opt/dir' }), w.dir, { ...w.opts, xcrun: w.dir })).toBe('git');
    expect(w.xcalls()).toEqual([]); // the fake xcrun was never reached
  });

  test('the answer is kept only while the selecting environment and the directory stay the same', async () => {
    const { resolveGitBinary } = await import('../lib/git-binary');
    const w = world();
    const other = tmp('cwd');
    const same = () => resolveGitBinary(w.env(), w.dir, w.opts);
    same();
    same();
    expect(w.xcalls().length).toBe(1);
    resolveGitBinary(w.env({ UNRELATED: 'x' }), w.dir, w.opts);
    expect(w.xcalls().length).toBe(1); // not a selector
    resolveGitBinary(w.env({ DEVELOPER_DIR: '/opt/a' }), w.dir, w.opts);
    expect(w.xcalls().length).toBe(2);
    resolveGitBinary(w.env({ DEVELOPER_DIR: '/opt/a' }), w.dir, w.opts);
    expect(w.xcalls().length).toBe(2);
    resolveGitBinary(w.env({ DEVELOPER_DIR: '/opt/a', SDKROOT: '/sdk' }), w.dir, w.opts);
    expect(w.xcalls().length).toBe(3);
    resolveGitBinary(w.env({ DEVELOPER_DIR: '/opt/a', SDKROOT: '/sdk' }), other, w.opts); // another directory
    expect(w.xcalls().length).toBe(4);
    resolveGitBinary(w.env({ PATH: `${w.shimDir}${delimiter}/bin` }), other, w.opts); // another PATH
    expect(w.xcalls().length).toBe(5);
    // A failure is kept too: a failing xcrun is not asked again for every git call.
    resolveGitBinary(w.env({ X_EXIT: '3', DEVELOPER_DIR: '/opt/b' }), w.dir, w.opts);
    resolveGitBinary(w.env({ X_EXIT: '3', DEVELOPER_DIR: '/opt/b' }), w.dir, w.opts);
    expect(w.xcalls().length).toBe(6);
  });

  test('on macOS the real answer is plain git or an absolute executable, and the test PATH skips the shim', async () => {
    if (process.platform !== 'darwin' || !existsSync('/usr/bin/xcrun')) return;
    const { resolveGitBinary, resetGitBinary } = await import('../lib/git-binary');
    resetGitBinary();
    const bin = resolveGitBinary({ PATH: '/usr/bin:/bin' }, tmpdir());
    expect(bin === 'git' || (isAbsolute(bin) && existsSync(bin) && bin !== '/usr/bin/git')).toBe(true);
    if (isAbsolute(bin)) expect(Bun.spawnSync([bin, '--version'], { stdout: 'pipe' }).exitCode).toBe(0);
    // tests/setup.ts: a spawn that passes `process.env` finds the real git, not the shim, first.
    expect(Bun.which('git', { PATH: process.env.PATH })).not.toBe('/usr/bin/git');
  });
});

// ── 4. The memo ────────────────────────────────────────────────────────────────────────────────

describe('the per-Stop memo of git answers', () => {
  const count = (f: Fake, match: (c: Call) => boolean) => f.calls().filter(match).length;
  const isCdup = (c: Call) => c.args.includes('--show-cdup');
  const isFilterList = (c: Call) => c.args.includes('--get-regexp');
  const isLsTree = (c: Call) => subOf(c) === 'ls-tree';

  test('inside a snapshot the repo top, the filter list and object reads by full id are asked once; outside, every time', async () => {
    const { spawnGit, withGitSnapshot } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit();
    const ask = () => {
      repoTop(r.d);
      spawnGit(r.d, ['config', '--name-only', '--get-regexp', '^filter\\.']);
      spawnGit(r.d, ['ls-tree', '-z', '--end-of-options', r.head, '--', 'a.txt']);
      spawnGit(r.d, ['cat-file', '-s', '--end-of-options', `${r.head}:a.txt`]);
      spawnGit(r.d, ['cat-file', 'blob', '--end-of-options', `${r.head}:a.txt`]);
      spawnGit(r.d, ['cat-file', '--batch-check'], { input: `${r.head}:a.txt\n` });
      spawnGit(r.d, ['rev-parse', '--verify', '-q', '--end-of-options', `${r.head}^{commit}`]);
    };
    withGitSnapshot(() => [ask(), ask(), ask()]);
    expect(f.calls().length).toBe(7); // each question once
    f.reset();
    [ask(), ask(), ask()];
    expect(f.calls().length).toBe(21); // no snapshot: nothing kept
  });

  test('results are identical with the memo on and off, and a file changed inside a batch is read again', async () => {
    const { withGitSnapshot, withHashBatch } = await import('../lib/git-run');
    const r = repo();
    const digest = (): unknown => {
      const out: unknown[] = [repoTop(r.d), [...differFromBase(r.d, r.head, ['a.txt', 'src/app.js'])].sort(), blobAtCommit(r.d, r.head, 'a.txt', 100), blobAtCommit(r.d, r.head, 'missing.txt', 100)];
      write(r.d, 'a.txt', 'b\n'); // the same size, other content
      out.push([...differFromBase(r.d, r.head, ['a.txt', 'src/app.js'])].sort());
      write(r.d, 'a.txt', 'a\n'); // back to the base
      out.push([...differFromBase(r.d, r.head, ['a.txt', 'src/app.js'])].sort());
      return out;
    };
    const off = digest();
    const on = withGitSnapshot(() => withHashBatch(digest));
    expect(on).toEqual(off);
    expect(off).toEqual([r.d, [], 'a\n', null, ['a.txt'], []]);
  });

  test('within a hash batch a file is hashed once while its stat is the same; a snapshot alone keeps no hash', async () => {
    const { withGitSnapshot, withHashBatch } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit();
    const ask = () => differFromBase(r.d, r.head, ['a.txt', 'src/app.js']);
    const hashes = () => only(f, 'hash-object').length;
    withHashBatch(() => [ask(), ask(), ask()]);
    expect(hashes()).toBe(1);
    f.reset();
    withGitSnapshot(() => [ask(), ask(), ask()]);
    expect(hashes()).toBe(3); // the current content of a file is never kept past a batch: not by a snapshot, not by the next batch
    f.reset();
    [ask(), ask(), ask()];
    expect(hashes()).toBe(3);
    f.reset();
    withHashBatch(ask);
    withHashBatch(ask);
    expect(hashes()).toBe(2);
    f.reset();
    withHashBatch(() => {
      differFromBase(r.d, r.head, ['a.txt']);
      write(r.d, 'a.txt', 'z\n');
      differFromBase(r.d, r.head, ['a.txt', 'src/app.js']); // a.txt again (its stat changed), src/app.js new
    });
    expect(only(f, 'hash-object').map((c) => c.args.slice(c.args.indexOf('--') + 1))).toEqual([['a.txt'], ['a.txt', 'src/app.js']]);
  });

  test('HEAD is resolved once per snapshot, a symbolic name only that way, and the next snapshot sees a new HEAD', async () => {
    const { beginGitSnapshot, endGitSnapshot, spawnGit } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit();
    // A generous limit: this test is about the memo, and a loaded machine must not time a call out.
    const patient = { timeoutMs: 30_000 };
    const head = () => spawnGit(r.d, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], patient).out.trim();
    beginGitSnapshot();
    expect([head(), head(), head()]).toEqual([r.head, r.head, r.head]);
    expect(count(f, (c) => subOf(c) === 'rev-parse')).toBe(1);
    spawnGit(r.d, ['ls-tree', '-z', 'HEAD'], patient);
    spawnGit(r.d, ['ls-tree', '-z', 'HEAD'], patient);
    expect(only(f, 'ls-tree').length).toBe(2); // HEAD is no immutable object: a read by that name is never kept
    write(r.d, 'a.txt', 'two\n');
    sh(r.d, 'git commit -qam "#1 two"');
    expect(head()).toBe(r.head); // this snapshot keeps the HEAD it resolved
    endGitSnapshot();
    beginGitSnapshot();
    const next = head();
    expect(next).not.toBe(r.head);
    expect(next).toBe(sh(r.d, 'git rev-parse HEAD'));
  });

  test('an error or a timeout is never kept as an answer', async () => {
    const { withGitSnapshot, spawnGit } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit({ GB_FAIL_ONCE: 'ls-tree' });
    withGitSnapshot(() => {
      const ask = () => spawnGit(r.d, ['ls-tree', '-z', '--end-of-options', r.head, '--', 'a.txt']);
      const first = ask();
      expect(first.code).toBe(128);
      const second = ask();
      expect([second.code, second.out.includes('a.txt')]).toEqual([0, true]);
      expect(ask().code).toBe(0); // the success is kept
    });
    expect(only(f, 'ls-tree').length).toBe(2);
    f.reset();
    const g = fakeGit({ GB_SLEEP_ONCE: 'cat-file' });
    withGitSnapshot(() => {
      const ask = () => spawnGit(r.d, ['cat-file', '-s', '--end-of-options', `${r.head}:a.txt`], { timeoutMs: 400 });
      const first = ask();
      expect([first.stalled, first.code]).toEqual([true, -1]);
      expect([ask().code, ask().out.trim()]).toEqual([0, '2']);
    });
    expect(only(g, 'cat-file').length).toBe(2);
  });

  test('a call with an environment override, or another directory, is not shared', async () => {
    const { withGitSnapshot, spawnGit } = await import('../lib/git-run');
    const a = repo();
    const b = repo();
    const f = fakeGit();
    withGitSnapshot(() => {
      spawnGit(a.d, ['rev-parse', '--show-cdup'], { env: { GIT_INDEX_FILE: join(a.d, 'i1') } });
      spawnGit(a.d, ['rev-parse', '--show-cdup'], { env: { GIT_INDEX_FILE: join(a.d, 'i1') } });
      spawnGit(a.d, ['rev-parse', '--show-cdup']);
      spawnGit(b.d, ['rev-parse', '--show-cdup']);
      spawnGit(b.d, ['rev-parse', '--show-cdup']);
    });
    expect(count(f, isCdup)).toBe(4); // two overridden, one per directory
  });

  test('what reads the work tree or the index is never kept', async () => {
    const { withGitSnapshot, spawnGit } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit();
    withGitSnapshot(() => {
      for (let i = 0; i < 2; i++) {
        spawnGit(r.d, ['status', '--porcelain']);
        spawnGit(r.d, ['diff', '--numstat', 'HEAD']);
        spawnGit(r.d, ['ls-files', '-z', '--others']);
        spawnGit(r.d, ['check-ignore', '-z', '--stdin'], { input: 'target/x\0' });
        spawnGit(r.d, ['rev-parse', '--git-dir']);
        spawnGit(r.d, ['rev-parse', '--show-toplevel']);
      }
    });
    for (const sub of ['status', 'diff', 'ls-files', 'check-ignore']) expect([sub, only(f, sub).length]).toEqual([sub, 2]);
    expect(count(f, (c) => c.args.includes('--git-dir'))).toBe(2);
    expect(count(f, (c) => c.args.includes('--show-toplevel'))).toBe(2);
  });

  test('workTreeState is never memoized: a change and a commit inside a snapshot show in the next one', async () => {
    const { withGitSnapshot } = await import('../lib/git-run');
    const r = repo();
    const f = fakeGit();
    const [one, two, three] = withGitSnapshot(() => {
      const one = workTreeState(r.d);
      write(r.d, 'a.txt', 'second\n');
      const two = workTreeState(r.d);
      sh(r.d, 'git commit -qam "#1 second"');
      return [one, two, workTreeState(r.d)];
    });
    expect(one!.tree).not.toBe(two!.tree);
    expect(two!.commit).toBe(r.head);
    expect(three!.commit).not.toBe(r.head); // HEAD is read each time
    expect(three!.tree).toBe(two!.tree);
    expect(only(f, 'add').length).toBe(3);
    expect(only(f, 'write-tree').length).toBe(3);
    expect(f.calls().filter((c) => c.args.join(' ').includes('rev-parse --verify -q HEAD')).length).toBe(3);
  });
});

// ── 5. A Stop ──────────────────────────────────────────────────────────────────────────────────

describe('a Stop with changed files, a build copy, records and a review', () => {
  /** The mixed Stop of the cost research: two edited sources, an edited test and doc, an ignored
   *  build copy, a test record and a review record. */
  function mixed() {
    const r = repo({ 'src/m1.js': V1, 'docs/README.md': 'a\n', 'target/m0.js': V1 });
    const s = sid();
    dirs.push(join(tmpdir(), `goodboy-session-${s}`));
    pinCoverageStart(s, r.d);
    const edits = [write(r.d, 'src/app.js', V2), write(r.d, 'src/m1.js', V2), write(r.d, 'tests/app.test.js', 'import { test } from "node:test";\ntest("f", () => { 1; });\n'), write(r.d, 'docs/README.md', 'b\n'), write(r.d, 'target/m0.js', V2)];
    for (const a of edits) recordEdit(s, a, 0, undefined, Date.now());
    const srcs = [join(r.d, 'src/app.js'), join(r.d, 'src/m1.js')];
    mkdirSync(join(r.d, '.claude/tests'), { recursive: true });
    mkdirSync(join(r.d, '.claude/reviews'), { recursive: true });
    // As `cli.ts test-write` and `review-write` store a record now (v0.36.6): the commit and the
    //   work-tree hash taken when it is written, and the content ids of listed files the tree lacks.
    const state = workTreeState(r.d);
    const reviewed = [...srcs, join(r.d, 'tests/app.test.js'), join(r.d, 'docs/README.md')];
    const stored = (files: string[]) => {
      const extra = extraBlobsFor(r.d, state.tree, files);
      return extra === undefined ? {} : { extra_blobs: extra };
    };
    const later = new Date().toISOString();
    writeFileSync(
      join(r.d, '.claude/tests/r1.json'),
      JSON.stringify({
        timestamp: later,
        commit: state.commit,
        tree: state.tree,
        ...stored(srcs),
        tested_files: srcs,
        category: 'fix-bug',
        test_files: [join(r.d, 'tests/app.test.js')],
        environment: { mode: 'none', command: 'none', evidence: 'library' },
        suites: [{ name: 'unit', command: 'node --test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
        acceptance: [{ id: 'AC-1', description: 'f', test: 'tests/app.test.js', red: { command: 'x', output: '1 fail', exit_code: 1 }, green: { command: 'x', output: '1 pass', exit_code: 0 } }],
        verdict: 'pass',
        coverage: { status: 'measured', changed: { covered: 2, total: 2, files_without_executed_changes: [], files: { 'src/app.js': { covered: 1, total: 1 }, 'src/m1.js': { covered: 1, total: 1 } }, in_report: ['src/app.js', 'src/m1.js'], diff_lines: { 'src/app.js': 1, 'src/m1.js': 1 }, base: r.head } },
      }),
    );
    writeFileSync(
      join(r.d, '.claude/reviews/v1.json'),
      JSON.stringify({ timestamp: later, tree: state.tree, ...stored(reviewed), reviewed_files: reviewed, category: 'fix-bug', findings: [], unknown_assumptions_checked: [], verdict: 'pass', dimensions_checked: requiredDimensionsFor(srcs) }),
    );
    return { ...r, s };
  }

  const isKeptKind = (c: Call): boolean => ['ls-tree', 'cat-file', 'config'].includes(subOf(c)) || c.args.includes('--show-cdup');

  async function runStop(p: { d: string; s: string }): Promise<{ decision?: string; reason?: string }> {
    const proc = Bun.spawn(['bun', STOP], {
      cwd: p.d,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: p.d, session_id: p.s, hook_event_name: 'Stop', stop_hook_active: false })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECT_DIR: p.d, GOODBOY_TEST_GATE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off' },
    });
    const text = (await new Response(proc.stdout).text()) || '{}';
    await proc.exited;
    return JSON.parse(text);
  }

  test('the Stop asks git no question twice that a snapshot can answer, and makes far fewer calls than the 24 before', async () => {
    const p = mixed();
    const f = fakeGit();
    f.reset();
    const out = await runStop(p);
    // Every gate before the review passed on records as test-write and review-write store them (a
    //   commit and a work-tree tree), so the Stop got as far as the review, which names the build
    //   copy: the counts below are those of a whole Stop, not of an early exit.
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review validation failed');
    expect(out.reason).toContain(join(p.d, 'target/m0.js'));
    expect(out.reason).not.toContain('Could not verify');
    expect(out.reason).not.toContain('(테스트 게이트)');
    const calls = f.calls();
    expect(calls.length).toBeGreaterThan(10); // the recording git was the one that ran
    // Measured (plan 15.22, this fixture with the suite's rule switches): 19 calls, 2 of them
    //   byte-identical repeats; the same Stop on v0.36.5 made 24, 9 of them repeats.
    expect(calls.length).toBeLessThanOrEqual(19);
    // No byte-identical call among the kinds a snapshot keeps.
    const key = (c: Call) => `${c.cwd}\0${c.args.join('\0')}`;
    const kept = calls.filter((c) => isKeptKind(c));
    expect(kept.map(key).filter((k, i, all) => all.indexOf(k) !== i)).toEqual([]);
    expect(calls.filter((c) => c.args.includes('--show-cdup')).length).toBe(1);
    expect(calls.filter((c) => c.args.includes('--get-regexp')).length).toBe(1);
    // 5 (4 in v0.36.5): R4 hashes each edited file's content now to compare it with a record's tree.
    //   The two byte-identical repeats left are these hashes, taken once by the test evaluation and
    //   once by the review's (a hash batch is one evaluation's: nothing is kept across evaluations).
    expect(calls.filter((c) => subOf(c) === 'hash-object').length).toBeLessThanOrEqual(5);
  });
});

// ── 6. Build copies: sizes, caps and one deadline ──────────────────────────────────────────────

describe('build copies: the cost limits', () => {
  /** A repo with `src/app.js` edited and committed `target/`-ignoring `.gitignore`. */
  function project(): Repo & { src: string } {
    const r = repo();
    return { ...r, src: write(r.d, 'src/app.js', V2) };
  }
  const copies = (p: Repo, n: number, text = V2) => Array.from({ length: n }, (_, i) => write(p.d, `target/c${String(i).padStart(3, '0')}.js`, text));

  test('the scan of the candidates is under the deadline: a clock that runs out there starts no git', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const cs = copies(p, 40);
    const f = fakeGit();
    f.reset();
    let t = 0;
    const skipped: [number, string][] = [];
    // The clock advances 100 ms per read; the first read is t0.
    const got = buildCopies([p.src, ...cs], p.d, p.head, undefined, { budgetMs: 1_000, now: () => (t += 100), onSkipped: (n, why) => skipped.push([n, why]) });
    expect(got.size).toBe(0);
    // The budget is gone at the 10th candidate. Exact counting (Part 2): the 9 already looked at are
    //   plain files whose fate is not decided yet, so all 40 are undecided, each counted once.
    expect(skipped).toEqual([[40, 'budget']]);
    expect(f.calls()).toEqual([]); // and no git ran
  });

  test('one deadline reaches every git spawn of the .gitignore check: none starts with no time, one is cut off at what is left', async () => {
    const r = repo();
    const f = fakeGit({ GB_SLEEP_ON: 'ls-tree' });
    const { spawnGit } = await import('../lib/git-run');
    for (const left of [0, -5, Number.NaN]) expect([left, spawnGit(r.d, ['rev-parse', '--git-dir'], { left: () => left }).ran]).toEqual([left, false]); // no time, no spawn
    expect(blobAtCommit(r.d, r.head, '.gitignore', 1_000, () => 0)).toBeNull();
    expect([...differFromBase(r.d, r.head, ['.gitignore'], () => 0)]).toEqual(['.gitignore']);
    expect(f.calls()).toEqual([]);
    const t0 = performance.now();
    expect(blobAtCommit(r.d, r.head, '.gitignore', 1_000, () => 300)).toBeNull(); // the ls-tree hangs; its limit is the 300 ms left, not 5 s
    expect(performance.now() - t0).toBeLessThan(2_500);
    const t1 = performance.now();
    expect([...differFromBase(r.d, r.head, ['.gitignore'], () => 300)]).toEqual(['.gitignore']);
    expect(performance.now() - t1).toBeLessThan(2_500);
    // The hash of the file now is the same deadline's.
    const g = fakeGit({ GB_SLEEP_ON: 'hash-object' });
    const t2 = performance.now();
    expect([...differFromBase(r.d, r.head, ['.gitignore'], () => 300)]).toEqual(['.gitignore']);
    expect(performance.now() - t2).toBeLessThan(2_500);
    expect(only(g, 'hash-object').length).toBe(1); // started, and cut off
  });

  for (const hang of ['ls-tree', 'hash-object']) {
    test(`through buildCopies: a hung ${hang} in the .gitignore check is cut off at the budget, and the copy stays`, async () => {
      const { buildCopies } = await import('../lib/build-copies');
      const p = project();
      const [c] = copies(p, 1);
      const f = fakeGit({ GB_SLEEP_ON: hang });
      f.reset();
      const t0 = performance.now();
      const got = buildCopies([p.src, c!], p.d, p.head, undefined, { budgetMs: 1_500 });
      expect(performance.now() - t0).toBeLessThan(4_500); // the spawn had what was left of 1.5 s, not its own 5 s
      expect(got.size).toBe(0);
      expect(only(f, hang).length).toBeGreaterThan(0);
      expect(only(f, 'ls-files').length).toBe(1); // nothing after the cut-off: the source listing never ran
    });
  }

  test('the source loop checks the clock for each source it looks at', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const reads = (sources: number) => {
      const p = project();
      const [c] = copies(p, 1);
      // `sources` files of the copy's size, none equal to it; all in the change set.
      const others = Array.from({ length: sources }, (_, i) => write(p.d, `src/o${i}.js`, V2.replace('x + 2', `x + ${String.fromCharCode(97 + (i % 26))}`)));
      let n = 0;
      buildCopies([p.src, c!, ...others], p.d, p.head, undefined, { budgetMs: 60_000, now: () => (n++, 0) });
      return n;
    };
    const few = reads(3);
    const many = reads(23);
    expect(many - few).toBeGreaterThanOrEqual(40); // 20 more sources, each looked at (size) and compared: two checks of the clock
  });

  test('the number of candidates is capped, and the rest are named', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const cs = copies(p, 5);
    const skipped: [number, string][] = [];
    const got = buildCopies([p.src, ...cs], p.d, p.head, undefined, { budgetMs: 60_000, maxCandidates: 2, onSkipped: (n, why) => skipped.push([n, why]) });
    expect([...got.keys()]).toEqual(cs.slice(0, 2));
    expect(skipped).toEqual([[3, 'cap']]);
  });

  test('the bytes read are capped: past the cap the copies stay and the log is told', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const size = V2.length;
    const cs = copies(p, 3);
    const run = (limits: Record<string, number>) => {
      const skipped: [number, string][] = [];
      // The change set is the one source (the copies are edits too, and would be sources of each other).
      const got = buildCopies([p.src, ...cs], p.d, p.head, () => [p.src], { budgetMs: 60_000, ...limits, onSkipped: (n, why) => skipped.push([n, why]) });
      return { got, skipped };
    };
    // Three copies and one source of one size: with the source kept, 3 copies + 1 source are read.
    const cached = run({ maxReadBytes: 5 * size, maxCachedBytes: 10 * size });
    expect([...cached.got.keys()]).toEqual(cs);
    expect(cached.skipped).toEqual([]);
    // Not kept: the source is read again for each copy, 6 reads; the 6th is past the cap. Exact counting
    //   (Part 2): the two copies already found equal still wait for the tracked check of their source,
    //   so they are undecided too: 3 in all, once.
    const uncached = run({ maxReadBytes: 5 * size, maxCachedBytes: 0 });
    expect(uncached.got.size).toBe(0);
    expect(uncached.skipped).toEqual([[3, 'bytes']]);
    // Under any cap the pairs are the full run's or none (checked above), never a partial pair.
    const tight = run({ maxReadBytes: size });
    expect(tight.got.size).toBe(0);
    expect(tight.skipped).toEqual([[3, 'bytes']]);
  });

  test('a copy no source of its size can equal is not read at all', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const odd = write(p.d, 'target/odd.js', `${V2}// a longer copy\n`.repeat(20));
    const skipped: [number, string][] = [];
    // A byte cap below the copy's size: reading it would trip the cap.
    const got = buildCopies([p.src, odd], p.d, p.head, undefined, { budgetMs: 60_000, maxReadBytes: 50, onSkipped: (n, why) => skipped.push([n, why]) });
    expect(got.size).toBe(0);
    expect(skipped).toEqual([]);
  });
});

// ── 7. The acceptance check-ignore, batched ────────────────────────────────────────────────────

describe('dev-cycle product evidence: one check-ignore for all', () => {
  const PAGE = 'docs/versions/v1/e2e/page.test.js';
  function devRepo(): string {
    const r = repo({ '.gitignore': 'target/\nbuild/\ngen/\n', 'src/other.js': V1, [PAGE]: 'import "../../../../../src/app.js";\n', 'docs/versions/v1/e2e/page2.test.js': 'x\n', 'docs/versions/v1/e2e/page3.test.js': 'x\n' });
    write(r.d, 'gen/out.js', V1); // ignored, and no build or scratch path by name
    return r.d;
  }
  const entry = (id: string, test: string, file: string) => ({
    id,
    description: 'd',
    test,
    red: { command: 'bun e2e (reverted)', output: 'fail', exit_code: 1 },
    green: { command: 'bun e2e', output: 'ok', exit_code: 0 },
    mutation: { command: 'sed -i s/x/y/ src/app.js', output: 'fails', detected: true, file },
  });
  const problems = (d: string, ...entries: unknown[]) => productEvidenceProblems([{ acceptance: entries } as unknown as TestResult], d);

  test('three entries naming two product files (one by two spellings) ask git once, and the verdicts are the same', () => {
    const d = devRepo();
    const one = (...entries: unknown[]) => problems(d, ...entries);
    const f = fakeGit({ GB_CAPTURE_STDIN: '1' });
    f.reset();
    const all = problems(
      d,
      entry('REQ-1', PAGE, 'src/app.js'),
      entry('REQ-2', 'docs/versions/v1/e2e/page2.test.js', 'docs/../src/app.js'),
      entry('REQ-3', 'docs/versions/v1/e2e/page3.test.js', 'src/other.js'),
    );
    expect(all).toEqual([]);
    expect(only(f, 'check-ignore').length).toBe(1);
    expect(f.stdin()).toBe('src/app.js\0src/other.js\0'); // canonical paths, each once
    // The same verdicts one entry at a time.
    f.reset();
    expect(one(entry('REQ-1', PAGE, 'src/app.js'))).toEqual([]);
    expect(one(entry('REQ-1', PAGE, 'gen/out.js')).some((l) => l.includes('dev-cycle folder'))).toBe(true); // an ignored file is no product
  });

  test('an ignored file among them fails only its own entry, and a failing git keeps every obligation', () => {
    const d = devRepo();
    const f = fakeGit();
    f.reset();
    const mixedOut = problems(d, entry('REQ-1', PAGE, 'src/app.js'), entry('REQ-2', 'docs/versions/v1/e2e/page2.test.js', 'gen/out.js'));
    expect(mixedOut.filter((l) => l.startsWith('REQ-1'))).toEqual([]);
    expect(mixedOut.filter((l) => l.startsWith('REQ-2') && l.includes('dev-cycle folder')).length).toBe(1);
    expect(only(f, 'check-ignore').length).toBe(1);
    const g = fakeGit({ GB_FAIL: 'check-ignore' });
    g.reset();
    const failed = problems(d, entry('REQ-1', PAGE, 'src/app.js'), entry('REQ-3', 'docs/versions/v1/e2e/page3.test.js', 'src/other.js'));
    expect(failed.filter((l) => l.includes('dev-cycle folder')).length).toBe(2);
    expect(only(g, 'check-ignore').length).toBe(1);
  });

  test('entries that fail the cheap checks ask git nothing', () => {
    const d = devRepo();
    const f = fakeGit();
    f.reset();
    problems(d, entry('REQ-1', PAGE, 'README-missing.md'), entry('REQ-2', 'tests/app.test.js', 'src/app.js'));
    expect(only(f, 'check-ignore')).toEqual([]);
  });
});

// ── 7. extraBlobsFor never throws and leaves out what it cannot read ───────────────────────────

describe('extraBlobsFor: a repo or file that cannot be read is left out', () => {
  const TREE = 'a'.repeat(40);

  test('a top that does not resolve (missing, or a dangling link) gives nothing', () => {
    const d = tmp('top');
    const files = [join(d, 'gone', 'x.js')];
    expect(() => extraBlobsFor(join(d, 'gone'), TREE, files)).not.toThrow();
    expect(extraBlobsFor(join(d, 'gone'), TREE, files)).toBeUndefined();
    symlinkSync(join(d, 'nowhere'), join(d, 'dangling'));
    expect(extraBlobsFor(join(d, 'dangling'), TREE, [join(d, 'dangling', 'x.js')])).toBeUndefined();
  });

  test('a file that disappears after it was accepted is left out, and the others are still kept', () => {
    const r = repo();
    const gone = write(r.d, 'target/gone.js', 'module.exports = 1;\n');
    const kept = write(r.d, 'target/kept.js', 'module.exports = 2;\n');
    const tree = workTreeState(r.d).tree as string;
    const keptId = sh(r.d, 'git hash-object target/kept.js');
    // The first git call (the tree read, after both files passed the first look) removes `gone`.
    fakeGit({ GB_RM: gone });
    const got = extraBlobsFor(r.d, tree, [gone, kept]);
    expect(existsSync(gone)).toBe(false); // it was removed between the two looks
    expect(got).toEqual({ [kept]: keptId });
  });

  test('when the only accepted file disappears there is nothing to keep', () => {
    const r = repo();
    const gone = write(r.d, 'target/only.js', 'module.exports = 1;\n');
    const tree = workTreeState(r.d).tree as string;
    fakeGit({ GB_RM: gone });
    expect(extraBlobsFor(r.d, tree, [gone])).toBeUndefined();
    expect(existsSync(gone)).toBe(false);
  });
});
