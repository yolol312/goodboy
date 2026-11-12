// v0.36.19 (#42, plan §15.35): a push from a repo outside the project dir (a sibling repo).
//   V19-AC-1  outsideRepo: a copy only when every condition holds; null for each missing one
//   V19-AC-2  test-write from the sibling: the record stays there, a copy with `repo` goes to the project dir
//   V19-AC-3  regression from the sibling: the same
//   V19-AC-4  test-write --worktree from the sibling: the copy too
//   V19-AC-5  findRecentTestFiles leaves `repo` records out unless asked
//   V19-AC-6  the push check end to end (the hook as a process, hook cwd = the project dir)
//   V19-AC-7  checkRegression: the one-hour relaxation counts the records of the repo handed off only
//   V19-AC-8  the Stop ignores `repo` records
//   V19-AC-9  cliProjectDir / knownProjectDir: the old results, and the noted dir
// Isolation: every spawned CLI/hook gets its own env (own TMPDIR, own CLAUDE_CODE_SESSION_ID, own
// CLAUDE_PROJECT_DIR, no CLAUDE_*/GOODBOY_* of the parent: a Bun child spawned without `env` keeps the
// parent's original environment). The in-process calls run with process.env.TMPDIR and the session
// variables pointed at the same temp dirs, and put everything back afterwards. Repos are real.
// New library members are read off namespaces, so a run on the old tree fails test by test.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as cliLib from '../lib/cli';
import * as pd from '../lib/project-dir';
import * as pt from '../lib/push-test';
import * as reg from '../lib/regression';
import * as validator from '../lib/test-validator';
import { pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import type { RegressionRecord } from '../lib/regression';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const STOP = join(ROOT, 'hooks', 'stop.ts');
setDefaultTimeout(90_000);

// ── harness ─────────────────────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
const KEYS = ['TMPDIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR', 'GOODBOY_OUTWARD_GATE'];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-v19-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
/** The parent's env without any CLAUDE_* / GOODBOY_* variable, git's global config off. */
function cleanEnv(over: Record<string, string>): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE_') && !k.startsWith('GOODBOY_')) e[k] = v;
  return { ...e, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...over };
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({}) });
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
const headTree = (d: string): string => sh(d, 'git rev-parse HEAD^{tree}');
const files = (d: string): string[] => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).sort() : []);
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

/** A repo at `dir`: its own src file (so no two repos share a tree), a test file, a package.json whose test
 *  script exits 0, one commit, a bare remote `origin` that has it, and a second commit the push would send. */
function makeRepo(dir: string, name: string, remote: string): void {
  write(dir, `src/${name}.ts`, `export const ${name} = 1;\n`);
  write(dir, 'a.test.ts', 'test("a", () => {});\n');
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'true' } }));
  write(dir, 'bun.lock', '');
  sh(dir, GIT_INIT);
  commitAll(dir, 'init');
  sh(dir, `git init -q --bare '${remote}' && git remote add origin '${remote}' && git push -q origin main && git fetch -q origin`);
  write(dir, `src/${name}.ts`, `export const ${name} = 2;\n`);
  commitAll(dir, 'ahead');
}

interface World {
  base: string;
  /** The session's project dir: a repo. */
  A: string;
  /** A sibling repo, not inside A. */
  B: string;
  sid: string;
  /** TMPDIR of the children (the session state dir lives there). */
  tmp: string;
  env: Record<string, string>;
  /** The session's edit log gets an edit of `file` (the hooks write it; here by hand, as recordEdit does). */
  edit: (file: string) => void;
  cli: (cwd: string, args: string[], stdin?: string, over?: Record<string, string>) => { code: number | null; out: string; err: string };
  hook: (cwd: string, command: string, over?: Record<string, string>) => Promise<{ denied: boolean; reason: string }>;
  /** test-write in `cwd` for B's file (or `tested`). */
  record: (cwd: string, args?: string[], over?: Record<string, unknown>, tested?: string[]) => { code: number | null; err: string; out: Record<string, string> };
  /** Runs `fn` with this world's session variables in process.env (and TMPDIR), process.cwd() = `cwd`. */
  inProcess: <T>(cwd: string, fn: () => Promise<T> | T) => Promise<T>;
}

function world(): World {
  const base = tmp();
  const A = join(base, 'proj');
  const B = join(base, 'sibling');
  makeRepo(A, 'calc', join(base, 'remote-a.git'));
  makeRepo(B, 'sib', join(base, 'remote-b.git'));
  const wtmp = join(base, 'tmp');
  mkdirSync(wtmp, { recursive: true });
  const sid = `v19-${Math.random().toString(36).slice(2, 10)}`;
  const env = cleanEnv({ TMPDIR: wtmp, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: A, GOODBOY_OUTWARD_GATE: 'off' });
  const edit = (file: string): void => {
    const dir = join(wtmp, `goodboy-session-${sid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file, turn: 1, timestamp: new Date().toISOString() }) + '\n', { flag: 'a' });
  };
  const cli: World['cli'] = (cwd, args, stdin = '', over = {}) => {
    const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env: { ...env, ...over }, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const hook: World['hook'] = async (cwd, command, over = {}) => {
    const payload = { session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
    const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env: { ...env, ...over } });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
  };
  const record: World['record'] = (cwd, args = [], over = {}, tested = [join(B, 'src', 'sib.ts')]) => {
    const r = cli(cwd, ['test-write', ...args], JSON.stringify(input(tested, [join(B, 'a.test.ts')], over)));
    return { code: r.code, err: r.err, out: r.code === 0 ? (JSON.parse(r.out) as Record<string, string>) : {} };
  };
  const inProcess: World['inProcess'] = async (cwd, fn) => {
    process.env.TMPDIR = wtmp;
    process.env.CLAUDE_CODE_SESSION_ID = sid;
    process.env.CLAUDE_PROJECT_DIR = A;
    process.env.GOODBOY_OUTWARD_GATE = 'off';
    const cwd0 = process.cwd();
    process.chdir(cwd);
    try {
      return await fn();
    } finally {
      process.chdir(cwd0);
    }
  };
  return { base, A, B, sid, tmp: wtmp, env, edit, cli, hook, record, inProcess };
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
        description: 'works',
        test: 'a.test.ts',
        red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
      },
    ],
    verdict: 'pass',
    ...over,
  };
}

/** cmdTestWrite in this process (stdout/stderr captured, process.exit a throw) with a JSON body file. */
async function testWriteHere(cwd: string, args: string[], body: unknown, shell: string) {
  const file = write(tmp('goodboy-v19-in-'), 'in.json', JSON.stringify(body));
  return captured(() => cliLib.cmdTestWrite(cwd, [...args, file], shell));
}
async function captured(run: () => Promise<void>) {
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
    await run();
  } catch (x) {
    threw = (x as Error).message;
  } finally {
    process.exit = exit;
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { out, err, threw };
}

const A_TESTS = (w: World): string => join(w.A, '.claude', 'tests');
const B_TESTS = (w: World): string => join(w.B, '.claude', 'tests');
const GREEN_PUSH = (w: World): string => `cd ${w.B} && git push origin main`;

// ── V19-AC-1 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-1: outsideRepo gives the copy target only when every condition holds', () => {
  const outsideRepo = (shell: string, env: NodeJS.ProcessEnv) => cliLib.outsideRepo(shell, env);

  test('all hold: the project dir and the real top of the sibling repo', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const env = { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: w.sid };
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, env)).toEqual({ project: w.A, repo: w.B });
      // From a subdir of the sibling repo: its top.
      expect(outsideRepo(join(w.B, 'src'), env)).toEqual({ project: w.A, repo: w.B });
    });
  });

  test('the shell spelled through a link: the repo is its real top', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const link = join(w.base, 'link-to-sibling');
    symlinkSync(w.B, link);
    await w.inProcess(w.B, () => {
      expect(outsideRepo(link, { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: w.sid })).toEqual({ project: w.A, repo: w.B });
    });
  });

  test('the project dir noted by the hooks for the session counts as known', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    await w.inProcess(w.B, () => {
      const env = { CLAUDE_CODE_SESSION_ID: w.sid };
      expect(outsideRepo(w.B, env)).toBeNull(); // not noted yet
      pd.noteProjectDir(w.sid, { CLAUDE_PROJECT_DIR: w.A });
      expect(outsideRepo(w.B, env)).toEqual({ project: w.A, repo: w.B });
    });
  });

  test('no project dir known: null (no variable, nothing noted)', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, { CLAUDE_CODE_SESSION_ID: w.sid })).toBeNull();
      expect(outsideRepo(w.B, { CLAUDE_PROJECT_DIR: ' ', CLAUDE_CODE_SESSION_ID: w.sid })).toBeNull();
    });
  });

  test('no session id: null', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, { CLAUDE_PROJECT_DIR: w.A })).toBeNull();
      expect(outsideRepo(w.B, { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: '  ' })).toBeNull();
      // No lookup of any log happens for no session: not even the nameless session's dir is made.
      expect(existsSync(join(w.tmp, 'goodboy-session-'))).toBe(false);
    });
    // An edit log in the nameless session's dir is no one's.
    const nameless = join(w.tmp, 'goodboy-session-');
    mkdirSync(nameless, { recursive: true });
    writeFileSync(join(nameless, 'edits.jsonl'), JSON.stringify({ file: join(w.B, 'src', 'sib.ts'), turn: 1, timestamp: new Date().toISOString() }) + '\n');
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, { CLAUDE_PROJECT_DIR: w.A })).toBeNull();
      expect(outsideRepo(w.B, { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: '' })).toBeNull();
    });
  });

  test('the shell inside the project dir: null, also for a project dir that is a subdir of its repo', async () => {
    const w = world();
    const sub = join(w.base, 'mono', 'proj');
    write(sub, 'inner/x.ts', 'export const x = 1;\n');
    sh(join(w.base, 'mono'), GIT_INIT);
    w.edit(join(sub, 'inner', 'x.ts'));
    w.edit(join(w.A, 'src', 'calc.ts'));
    await w.inProcess(w.B, () => {
      const env = { CLAUDE_PROJECT_DIR: sub, CLAUDE_CODE_SESSION_ID: w.sid };
      expect(outsideRepo(sub, env)).toBeNull();
      expect(outsideRepo(join(sub, 'inner'), env)).toBeNull();
      expect(outsideRepoNull(w.A, { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: w.sid })).toBe(true);
      // The enclosing repo itself is outside the project dir (a repo above it) and has an edit: its top.
      expect(outsideRepo(join(w.base, 'mono'), env)).toEqual({ project: sub, repo: join(w.base, 'mono') });
    });
  });
  const outsideRepoNull = (shell: string, env: NodeJS.ProcessEnv): boolean => cliLib.outsideRepo(shell, env) === null;

  test('the shell in no repo: null', async () => {
    const w = world();
    const plain = join(w.base, 'plain');
    write(plain, 'x.ts', 'x\n');
    w.edit(join(plain, 'x.ts'));
    await w.inProcess(plain, () => {
      expect(outsideRepo(plain, { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: w.sid })).toBeNull();
    });
  });

  test('no edit of the session inside the sibling repo: null (no log, an edit elsewhere, a path that only shares a prefix)', async () => {
    const w = world();
    const env = { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: w.sid };
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, env)).toBeNull(); // no log at all
    });
    w.edit(join(w.A, 'src', 'calc.ts'));
    w.edit(`${w.B}-other/src/sib.ts`);
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, env)).toBeNull();
    });
    w.edit(join(w.B, 'src', 'sib.ts'));
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, env)).toEqual({ project: w.A, repo: w.B });
    });
  });

  test('another session\'s edit log is not this session\'s', async () => {
    const w = world();
    const other = `${w.sid}-x`;
    const dir = join(w.tmp, `goodboy-session-${other}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: join(w.B, 'src', 'sib.ts'), turn: 1, timestamp: new Date().toISOString() }) + '\n');
    await w.inProcess(w.B, () => {
      expect(outsideRepo(w.B, { CLAUDE_PROJECT_DIR: w.A, CLAUDE_CODE_SESSION_ID: w.sid })).toBeNull();
    });
  });

  test('outsideRepoTop: null inside the dir or in no repo, the real top of an outside repo', () => {
    const w = world();
    const link = join(w.base, 'lnk');
    symlinkSync(w.B, link);
    expect(pt.outsideRepoTop(join(w.A, 'src'), w.A)).toBeNull();
    expect(pt.outsideRepoTop(w.A, w.A)).toBeNull();
    expect(pt.outsideRepoTop(w.base, w.A)).toBeNull();
    expect(pt.outsideRepoTop(join(w.B, 'src'), w.A)).toBe(w.B);
    expect(pt.outsideRepoTop(link, w.A)).toBe(w.B);
  });
});

// ── V19-AC-2 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-2: test-write from the sibling repo keeps its record there and copies it to the project dir', () => {
  test('the record in the sibling is unchanged (no repo); the copy in the project dir has repo; stdout names it', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const r = w.record(w.B);
    expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
    expect(r.out.path.startsWith(B_TESTS(w))).toBe(true);
    expect(r.out.copy.startsWith(A_TESTS(w))).toBe(true);
    expect(files(B_TESTS(w))).toHaveLength(1);
    expect(files(A_TESTS(w))).toHaveLength(1);
    const own = readJson(r.out.path);
    const copy = readJson(r.out.copy);
    expect(own.repo).toBeUndefined();
    expect(copy.repo).toBe(w.B);
    expect(own.tree).toBe(headTree(w.B));
    // The copy is the record plus repo.
    expect(copy).toEqual({ ...own, repo: w.B });
  });

  test('an agent-supplied repo is dropped: not in the sibling record, and the copy carries goodboy\'s own value', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const r = w.record(w.B, [], { repo: '/somewhere/else' });
    expect(r.code).toBe(0);
    expect(readJson(r.out.path).repo).toBeUndefined();
    expect(readJson(r.out.copy).repo).toBe(w.B);
    // And from the project dir (no copy), the supplied repo never reaches the stored record.
    const own = w.record(w.A, [], { repo: '/somewhere/else' }, [join(w.A, 'src', 'calc.ts')]);
    expect(own.code).toBe(0);
    expect(own.out.copy).toBeUndefined();
    expect(readJson(own.out.path).repo).toBeUndefined();
  });

  test('no copy when a condition is missing: shell in the project dir, no edit in the sibling, no session id', () => {
    const w = world();
    // No edit of the sibling in the log.
    const noEdit = w.record(w.B);
    expect(noEdit.code).toBe(0);
    expect(noEdit.out.copy).toBeUndefined();
    expect(files(A_TESTS(w))).toEqual([]);
    expect(files(B_TESTS(w))).toHaveLength(1);
    // With the edit but no session id.
    w.edit(join(w.B, 'src', 'sib.ts'));
    const noSid = w.cli(w.B, ['test-write'], JSON.stringify(input([join(w.B, 'src', 'sib.ts')], [join(w.B, 'a.test.ts')])), { CLAUDE_CODE_SESSION_ID: '' });
    expect(noSid.code).toBe(0);
    expect((JSON.parse(noSid.out) as { copy?: string }).copy).toBeUndefined();
    expect(files(A_TESTS(w))).toEqual([]);
    // The shell in the project dir: a project record, no copy.
    w.edit(join(w.A, 'src', 'calc.ts'));
    const inside = w.record(w.A, [], {}, [join(w.A, 'src', 'calc.ts')]);
    expect(inside.code).toBe(0);
    expect(inside.out.copy).toBeUndefined();
    expect(inside.out.path.startsWith(A_TESTS(w))).toBe(true);
    expect(files(A_TESTS(w))).toHaveLength(1);
  });

  test('in this process: the record, the copy and the stdout line; none without an edit', async () => {
    const w = world();
    const body = input([join(w.B, 'src', 'sib.ts')], [join(w.B, 'a.test.ts')]);
    const none = await w.inProcess(w.B, () => testWriteHere(w.B, [], body, w.B));
    expect(none.threw).toBe('');
    expect((JSON.parse(none.out) as { copy?: string }).copy).toBeUndefined();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const some = await w.inProcess(w.B, () => testWriteHere(w.B, [], body, w.B));
    expect(some.threw).toBe('');
    const out = JSON.parse(some.out) as { path: string; copy: string };
    expect(out.copy.startsWith(A_TESTS(w))).toBe(true);
    expect(readJson(out.copy).repo).toBe(w.B);
    expect(readJson(out.path).repo).toBeUndefined();
    expect(files(A_TESTS(w))).toHaveLength(1);
    expect(files(B_TESTS(w))).toHaveLength(2);
  });
});

describe('V19-AC-2b: a copy that cannot be written warns and the command still succeeds', () => {
  /** The project dir's .claude/tests is a file, so no copy can be made there. */
  function blockCopies(w: World): void {
    write(w.A, '.claude/tests', 'not a dir\n');
  }

  test('test-write as a process: exit 0, the record in the sibling, no copy in stdout, a warning on stderr', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    blockCopies(w);
    const r = w.record(w.B);
    expect(r.code).toBe(0);
    expect(r.out.copy).toBeUndefined();
    expect(readJson(r.out.path).repo).toBeUndefined();
    expect(files(B_TESTS(w))).toHaveLength(1);
    expect(r.err).toContain("warning: the copy of this record for the session's project dir was not written");
    expect(r.err).toContain('a push from this repo will find no result');
  });

  test('test-write in this process: the same', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    blockCopies(w);
    const run = await w.inProcess(w.B, () => testWriteHere(w.B, [], input([join(w.B, 'src', 'sib.ts')], [join(w.B, 'a.test.ts')]), w.B));
    expect(run.threw).toBe('');
    expect((JSON.parse(run.out) as { copy?: string }).copy).toBeUndefined();
    expect(run.err).toContain('warning: the copy of this record');
    expect(files(B_TESTS(w))).toHaveLength(1);
  });

  test('regression as a process: exit 0, no copy, a warning', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    blockCopies(w);
    const r = w.cli(w.B, ['regression']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { path: string; copy?: string; verdict: string };
    expect([out.verdict, out.copy]).toEqual(['pass', undefined]);
    expect(r.err).toContain('warning: the copy of this record');
    expect(files(join(B_TESTS(w), 'regression'))).toHaveLength(1);
  });
});

// ── V19-AC-3 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-3: regression from the sibling repo keeps its record there and copies it to the project dir', () => {
  const regDir = (d: string): string => join(d, '.claude', 'tests', 'regression');

  test('as a process: the record in the sibling (no repo), the copy in the project dir (repo)', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const r = w.cli(w.B, ['regression']);
    expect([r.code, r.err]).toEqual([0, '']);
    const out = JSON.parse(r.out) as { path: string; copy: string; verdict: string; tree: string };
    expect(out.verdict).toBe('pass');
    expect(out.path.startsWith(regDir(w.B))).toBe(true);
    expect(out.copy.startsWith(regDir(w.A))).toBe(true);
    expect(readJson(out.path).repo).toBeUndefined();
    expect(readJson(out.copy)).toEqual({ ...readJson(out.path), repo: w.B });
    expect(out.tree).toBe(headTree(w.B));
  });

  test('no edit of the sibling in the log: only the sibling\'s own record', () => {
    const w = world();
    const r = w.cli(w.B, ['regression']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { copy?: string }).copy).toBeUndefined();
    expect(files(regDir(w.A))).toEqual([]);
    expect(files(regDir(w.B))).toHaveLength(1);
  });

  test('in this process (cwd = the sibling): the copy too', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const run = await w.inProcess(w.B, () => captured(() => cliLib.cmdRegression(w.B, [])));
    expect(run.threw).toBe('');
    const out = JSON.parse(run.out) as { path: string; copy: string };
    expect(readJson(out.copy).repo).toBe(w.B);
    expect(readJson(out.path).repo).toBeUndefined();
    // Without an edit in the log: no copy.
    const w2 = world();
    const none = await w2.inProcess(w2.B, () => captured(() => cliLib.cmdRegression(w2.B, [])));
    expect((JSON.parse(none.out) as { copy?: string }).copy).toBeUndefined();
  });
});

// ── V19-AC-4 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-4: test-write --worktree from the sibling repo copies too', () => {
  test('a clean linked worktree of the sibling: the record in the sibling, the copy (repo = the sibling) in the project dir', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const wt = join(w.base, 'wt-b');
    sh(w.B, `git worktree add -q --detach '${wt}' HEAD`);
    const r = w.cli(w.B, ['test-write', '--worktree', wt], JSON.stringify(input(['src/sib.ts'], ['a.test.ts'])));
    expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
    const out = JSON.parse(r.out) as { path: string; copy: string };
    expect(out.path.startsWith(B_TESTS(w))).toBe(true);
    expect(out.copy.startsWith(A_TESTS(w))).toBe(true);
    const own = readJson(out.path);
    const copy = readJson(out.copy);
    expect(own.worktree).toBe(realpathSync(wt));
    expect(own.repo).toBeUndefined();
    expect(copy).toEqual({ ...own, repo: w.B });
    expect(copy.tree).toBe(headTree(w.B));
  });

  test('regression --worktree from the sibling: the copy too', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    const wt = join(w.base, 'wt-b2');
    sh(w.B, `git worktree add -q --detach '${wt}' HEAD`);
    const r = w.cli(w.B, ['regression', '--worktree', wt]);
    expect([r.code, r.err]).toEqual([0, '']);
    const out = JSON.parse(r.out) as { path: string; copy: string };
    expect(readJson(out.copy)).toEqual({ ...readJson(out.path), repo: w.B });
    expect(readJson(out.copy).worktree).toBe(realpathSync(wt));
  });
});

// ── V19-AC-5 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-5: findRecentTestFiles leaves repo records out unless asked', () => {
  test('the project\'s own record is always found; the repo copy only with withOutside', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    w.edit(join(w.A, 'src', 'calc.ts'));
    const sib = w.record(w.B);
    const own = w.record(w.A, [], {}, [join(w.A, 'src', 'calc.ts')]);
    expect([sib.code, own.code]).toEqual([0, 0]);
    const dir = A_TESTS(w);
    expect(files(dir)).toHaveLength(2);
    const plain = validator.findRecentTestFiles(dir, 1440);
    expect(plain).toHaveLength(1);
    expect(plain[0]!.repo).toBeUndefined();
    expect(plain[0]!.tested_files).toEqual([join(w.A, 'src', 'calc.ts')]);
    const all = validator.findRecentTestFiles(dir, 1440, true);
    expect(all.map((r) => r.repo)).toEqual(expect.arrayContaining([undefined, w.B]));
    expect(all).toHaveLength(2);
    expect(validator.findRecentTestFiles(dir, 1440, false)).toHaveLength(1);
  });

  test('a record with a repo that is the only one: nothing by default, one with withOutside', () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    w.record(w.B);
    expect(validator.findRecentTestFiles(A_TESTS(w), 1440)).toEqual([]);
    expect(validator.findRecentTestFiles(A_TESTS(w), 1440, true)).toHaveLength(1);
  });
});

// ── V19-AC-6 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-6: the push check end to end, hook cwd = the project dir, command `cd <sibling> && git push`', () => {
  test('no-result without the copy; with the copy the layer-1 check passes; the regression is the next ask', async () => {
    const w = world();
    // The old behavior: the record only in the sibling (no edit of it in the session's log: no copy).
    const lone = w.record(w.B);
    expect(lone.code).toBe(0);
    expect(lone.out.copy).toBeUndefined();
    const denied = await w.hook(w.A, GREEN_PUSH(w), { GOODBOY_PUSH_REGRESSION: 'off' });
    expect(denied.denied).toBe(true);
    expect(denied.reason).toContain('without a passing test result');
    // The denial names the dir it read, and for an outside repo the copy.
    expect(denied.reason).toContain(`goodboy reads test results from ${A_TESTS(w)} only.`);
    expect(denied.reason).toContain('stores a copy of its record here once the session has edited a file in that repo');
    expect(denied.reason).toContain('record the run again');

    // The session edited the sibling: the same call now leaves a copy, and the push passes.
    w.edit(join(w.B, 'src', 'sib.ts'));
    const again = w.record(w.B);
    expect(again.out.copy).toBeDefined();
    const ok = await w.hook(w.A, GREEN_PUSH(w), { GOODBOY_PUSH_REGRESSION: 'off' });
    expect(ok).toEqual({ denied: false, reason: '' });

    // With the full-regression check on (the default): denied until `regression` ran in the sibling.
    const needReg = await w.hook(w.A, GREEN_PUSH(w));
    expect(needReg.denied).toBe(true);
    expect(needReg.reason).toContain('without a passing full regression');
    expect(w.cli(w.B, ['regression']).code).toBe(0);
    expect(await w.hook(w.A, GREEN_PUSH(w))).toEqual({ denied: false, reason: '' });
  });

  test('a copy of a stale tree (the sibling changed after the test run) does not pass', async () => {
    const w = world();
    w.edit(join(w.B, 'src', 'sib.ts'));
    expect(w.record(w.B).code).toBe(0);
    write(w.B, 'src/sib.ts', 'export const sib = 3;\n');
    commitAll(w.B, 'later');
    const out = await w.hook(w.A, GREEN_PUSH(w), { GOODBOY_PUSH_REGRESSION: 'off' });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing test result');
  });

  test('the project\'s own repo: the denial names the dir, with no copy sentence', async () => {
    const w = world();
    const out = await w.hook(w.A, 'git push origin main', { GOODBOY_PUSH_REGRESSION: 'off' });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain(`goodboy reads test results from ${A_TESTS(w)} only.`);
    expect(out.reason).not.toContain('stores a copy of its record');
  });

  test('pushTestMessage: the where-read text only for a no-result outcome, the copy sentence only for an outside repo', () => {
    const noResult = { ok: false as const, why: 'no-result' as const, rev: 'HEAD', tree: 'a'.repeat(40) };
    const here = pt.pushTestMessage('git push', noResult, undefined, { dir: '/p/.claude/tests', outside: false });
    expect(here).toContain('goodboy reads test results from /p/.claude/tests only.');
    expect(here).not.toContain('copy');
    const away = pt.pushTestMessage('git push', noResult, undefined, { dir: '/p/.claude/tests', outside: true });
    expect(away).toContain('goodboy reads test results from /p/.claude/tests only.');
    expect(away).toContain('stores a copy of its record here once the session has edited a file in that repo');
    expect(away).not.toContain('0.36');
    expect(pt.pushTestMessage('git push', noResult)).not.toContain('goodboy reads test results');
    expect(pt.pushTestMessage('git push', noResult, undefined, undefined)).not.toContain('goodboy reads test results');
    const other = pt.pushTestMessage('git push', { ...noResult, why: 'stale' } as never, undefined, { dir: '/p/.claude/tests', outside: true });
    expect(other).not.toContain('goodboy reads test results');
  });
});

// ── V19-AC-7 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-7: the one-hour regression relaxation counts only the records of the repo handed off', () => {
  const T = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const SLOW = 61 * 60_000;
  const rec = (over: Partial<RegressionRecord> = {}): RegressionRecord => ({
    timestamp: '2026-11-12T01:00:00.000Z',
    commit: null,
    tree: OTHER,
    tree_after: OTHER,
    source: 'package.json scripts.test',
    runs: [{ command: 'bun test', exit_code: 0, duration_ms: SLOW, output_tail: 'ok' }],
    duration_ms: SLOW,
    verdict: 'pass',
    ...over,
  });

  test('the project\'s own repo (repo null): a slow pass without repo relaxes; one with repo does not', () => {
    expect(reg.checkRegression('HEAD', T, [rec()], null)).toEqual({ ok: true, relaxed: true });
    expect(reg.checkRegression('HEAD', T, [rec()])).toEqual({ ok: true, relaxed: true });
    expect(reg.checkRegression('HEAD', T, [rec({ repo: '/x/sibling' })], null)).toMatchObject({ ok: false, why: 'none' });
    expect(reg.checkRegression('HEAD', T, [rec({ repo: '/x/sibling' })])).toMatchObject({ ok: false, why: 'none' });
  });

  test('an outside repo: only the slow passes with its own repo relax', () => {
    expect(reg.checkRegression('HEAD', T, [rec({ repo: '/x/sibling' })], '/x/sibling')).toEqual({ ok: true, relaxed: true });
    expect(reg.checkRegression('HEAD', T, [rec()], '/x/sibling')).toMatchObject({ ok: false, why: 'none' });
    expect(reg.checkRegression('HEAD', T, [rec({ repo: '/x/other' })], '/x/sibling')).toMatchObject({ ok: false, why: 'none' });
  });

  test('the first matching slow pass counts even when newer records of other repos come first', () => {
    const records = [rec({ repo: '/x/other', timestamp: '2026-11-12T03:00:00.000Z' }), rec({ timestamp: '2026-11-12T02:00:00.000Z' }), rec({ repo: '/x/sibling' })];
    expect(reg.checkRegression('HEAD', T, records, '/x/sibling')).toEqual({ ok: true, relaxed: true });
    expect(reg.checkRegression('HEAD', T, records, null)).toEqual({ ok: true, relaxed: true });
    expect(reg.checkRegression('HEAD', T, records.slice(0, 1), null)).toMatchObject({ ok: false });
  });

  test('a fast pass of the repo, or a failing one, does not relax; a pass of the tree itself always passes', () => {
    const fast = rec({ repo: '/x/sibling', duration_ms: 60_000 });
    expect(reg.checkRegression('HEAD', T, [fast], '/x/sibling')).toMatchObject({ ok: false, why: 'none' });
    const failing = rec({ repo: '/x/sibling', verdict: 'fail' });
    expect(reg.checkRegression('HEAD', T, [failing], '/x/sibling')).toMatchObject({ ok: false, why: 'none' });
    expect(reg.checkRegression('HEAD', OTHER, [failing], '/x/sibling')).toMatchObject({ ok: false, why: 'failed' });
    expect(reg.checkRegression('HEAD', OTHER, [fast], null)).toEqual({ ok: true });
    expect(reg.checkRegression('HEAD', OTHER, [fast], '/x/else')).toEqual({ ok: true });
  });

  test('end to end: a slow pass of the sibling does not relax the project\'s own push, and the project\'s does not relax the sibling\'s', async () => {
    const w = world();
    const slow = (dir: string, extra: Partial<RegressionRecord>): void => {
      const rdir = join(dir, '.claude', 'tests', 'regression');
      mkdirSync(rdir, { recursive: true });
      writeFileSync(join(rdir, '2026-11-12T01-00-00-000Z.json'), JSON.stringify({ ...rec(), ...extra }));
    };
    // A passing layer-1 result for each repo, so only the regression check is in play.
    w.edit(join(w.B, 'src', 'sib.ts'));
    expect(w.record(w.B).code).toBe(0);
    expect(w.record(w.A, [], {}, [join(w.A, 'src', 'calc.ts')]).code).toBe(0);
    // Only a slow pass of the sibling (repo = B) exists: the sibling's push relaxes, the project's own does not.
    slow(w.A, { repo: w.B });
    expect(await w.hook(w.A, GREEN_PUSH(w))).toEqual({ denied: false, reason: '' });
    const own = await w.hook(w.A, 'git push origin main');
    expect(own.denied).toBe(true);
    expect(own.reason).toContain('without a passing full regression');
    // Now the other way round: a slow pass of the project's own repo (no repo) relaxes it and not the sibling's.
    rmSync(join(w.A, '.claude', 'tests', 'regression'), { recursive: true, force: true });
    slow(w.A, {});
    expect((await w.hook(w.A, 'git push origin main')).denied).toBe(false);
    const sib = await w.hook(w.A, GREEN_PUSH(w));
    expect(sib.denied).toBe(true);
    expect(sib.reason).toContain('without a passing full regression');
  });
});

// ── V19-AC-8 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-8: the Stop ignores repo records', () => {
  /** A session whose project dir A has an uncommitted edit of src/calc.ts, recorded in the edit log, with the
   *  start pinned (as the SessionStart hook does). */
  async function edited(w: World): Promise<string> {
    const calc = write(w.A, 'src/calc.ts', 'export const calc = 2;\nexport const more = 3;\n');
    write(w.A, 'tests/a.test.ts', 'test("a", () => {});\n');
    await w.inProcess(w.A, () => {
      pinCoverageStart(w.sid, w.A);
      recordEdit(w.sid, calc, 0, undefined, Date.now());
    });
    return calc;
  }
  const bodyFor = (calc: string, over: Record<string, unknown> = {}) => ({
    ...input([calc], [join(ROOT, 'tests', 'v0.36.19-sibling-repo.test.ts')], over),
    acceptance: [
      {
        id: 'AC-1',
        description: 'calc works',
        test: 'tests/a.test.ts',
        red: { command: 'bun test', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test', output: '1 pass', exit_code: 0 },
      },
    ],
  });
  /** The project's own record of the edit, written by the CLI from A. */
  function ownRecord(w: World, calc: string): string {
    const r = w.cli(w.A, ['test-write'], JSON.stringify(bodyFor(calc)));
    expect(r.code).toBe(0);
    return (JSON.parse(r.out) as { path: string }).path;
  }
  /** A copy as test-write would leave it in A, made newer than anything there; `mutate` edits the record. */
  function plant(w: World, from: string, mutate: (r: Record<string, unknown>) => void, name: string): void {
    const r = readJson(from);
    mutate(r);
    const path = join(A_TESTS(w), name);
    writeFileSync(path, JSON.stringify(r));
    const t = new Date(Date.now() + 5_000);
    // mtime decides the order findRecentTestFiles returns.
    utimesSync(path, t, t);
  }
  async function stop(w: World) {
    const p = Bun.spawn(['bun', STOP], {
      cwd: w.A,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: w.A, session_id: w.sid, hook_event_name: 'Stop', stop_hook_active: false })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...w.env, GOODBOY_TEST_GATE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off', GOODBOY_DIFF_COVERAGE: 'off' },
    });
    const out = (await new Response(p.stdout).text()) || '{}';
    await p.exited;
    return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
  }
  const testBlock = (o: { reason?: string }): string => (o.reason ?? '').split('\n').filter((l) => l.includes('테스트 게이트')).join('\n');

  test('control: the project\'s own passing record, and the Stop\'s test layer does not block', async () => {
    const w = world();
    const calc = await edited(w);
    ownRecord(w, calc);
    expect(testBlock(await stop(w))).toBe('');
  });

  test('a newer failing repo copy that lists the edited file blocks nothing and counts for nothing', async () => {
    const w = world();
    const calc = await edited(w);
    const own = ownRecord(w, calc);
    plant(w, own, (r) => {
      r.repo = w.B;
      r.verdict = 'fail';
      r.suites = [{ name: 'unit', command: 'bun test', passed: 0, failed: 3, output: '3 fail', type: 'unit', duration_ms: 10 }];
    }, 'z-copy-fail.json');
    expect(files(A_TESTS(w))).toHaveLength(2);
    expect(testBlock(await stop(w))).toBe('');
  });

  test('the same failing record without repo does block (so the filter is what lets the Stop pass)', async () => {
    const w = world();
    const calc = await edited(w);
    const own = ownRecord(w, calc);
    plant(w, own, (r) => {
      r.verdict = 'fail';
      r.suites = [{ name: 'unit', command: 'bun test', passed: 0, failed: 3, output: '3 fail', type: 'unit', duration_ms: 10 }];
    }, 'z-own-fail.json');
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(testBlock(out)).not.toBe('');
  });

  test('a passing repo copy that lists the edited file is no evidence of it: the Stop still asks for a result', async () => {
    const w = world();
    const calc = await edited(w);
    const own = ownRecord(w, calc);
    plant(w, own, (r) => {
      r.repo = w.B;
    }, 'z-copy-pass.json');
    rmSync(own);
    expect(files(A_TESTS(w))).toEqual(['z-copy-pass.json']);
    const out = await stop(w);
    expect(out.decision).toBe('block');
    expect(testBlock(out)).toContain('No test result covers the changed code');
  });
});

// ── V19-AC-9 ────────────────────────────────────────────────────────────────────────────────────────────

describe('V19-AC-9: cliProjectDir and knownProjectDir', () => {
  test('CLAUDE_PROJECT_DIR set: absolute, relative, "/" and blank, with the shell inside and outside it', () => {
    const w = world();
    const sub = join(w.A, 'src');
    // Absolute: the project dir when the shell is inside it, else the shell's dir.
    expect(pd.cliProjectDir(sub, { CLAUDE_PROJECT_DIR: w.A })).toBe(w.A);
    expect(pd.cliProjectDir(w.A, { CLAUDE_PROJECT_DIR: w.A })).toBe(w.A);
    expect(pd.cliProjectDir(w.B, { CLAUDE_PROJECT_DIR: w.A })).toBe(w.B);
    expect(pd.cliProjectDir(sub, { CLAUDE_PROJECT_DIR: `${w.A}/` })).toBe(w.A);
    // Relative or "/": the shell's dir, as before.
    expect(pd.cliProjectDir(sub, { CLAUDE_PROJECT_DIR: 'proj' })).toBe(sub);
    expect(pd.cliProjectDir(sub, { CLAUDE_PROJECT_DIR: '/' })).toBe(sub);
    expect(pd.cliProjectDir(sub, { CLAUDE_PROJECT_DIR: '/../' })).toBe(sub);
    // A set variable wins over the session's noted dir, and a session id changes nothing.
    expect(pd.cliProjectDir(sub, { CLAUDE_PROJECT_DIR: 'proj', CLAUDE_CODE_SESSION_ID: w.sid })).toBe(sub);
    // Blank: as unset.
    expect(pd.cliProjectDir(sub, { CLAUDE_PROJECT_DIR: '  ' })).toBe(sub);
    expect(pd.cliProjectDir(sub, {})).toBe(sub);
  });

  test('a linked worktree nested in the project dir is its own project, as before', () => {
    const w = world();
    const wt = join(w.A, '.claude', 'worktrees', 'x');
    sh(w.A, `git worktree add -q --detach '${wt}' HEAD`);
    expect(pd.cliProjectDir(join(wt, 'src'), { CLAUDE_PROJECT_DIR: w.A })).toBe(wt);
    expect(pd.cliProjectDir(wt, { CLAUDE_PROJECT_DIR: w.A })).toBe(wt);
  });

  test('cliProjectDir with the dir noted for the session: used when the variable is unset; the shell\'s dir otherwise', async () => {
    const w = world();
    const sub = join(w.A, 'src');
    await w.inProcess(w.A, () => {
      const env = { CLAUDE_CODE_SESSION_ID: w.sid };
      // Nothing noted: the shell's dir; no session id: the shell's dir.
      expect(pd.cliProjectDir(sub, env)).toBe(sub);
      expect(pd.cliProjectDir(sub, {})).toBe(sub);
      pd.noteProjectDir(w.sid, { CLAUDE_PROJECT_DIR: w.A });
      expect(pd.cliProjectDir(sub, env)).toBe(w.A);
      expect(pd.cliProjectDir(w.B, env)).toBe(w.B);
      // A noted dir that is gone, relative or "/": the shell's dir.
      const file = join(w.tmp, `goodboy-session-${w.sid}`, 'project-dir.txt');
      for (const bad of [join(w.base, 'gone'), 'proj', '/', '']) {
        writeFileSync(file, `${bad}\n`);
        expect(pd.cliProjectDir(sub, env)).toBe(sub);
      }
    });
  });

  test('knownProjectDir: the variable (absolute, not "/"), else the noted dir, else null', async () => {
    const w = world();
    expect(pd.knownProjectDir({ CLAUDE_PROJECT_DIR: w.A })).toBe(w.A);
    expect(pd.knownProjectDir({ CLAUDE_PROJECT_DIR: `${w.A}/` })).toBe(w.A);
    expect(pd.knownProjectDir({ CLAUDE_PROJECT_DIR: 'proj' })).toBeNull();
    expect(pd.knownProjectDir({ CLAUDE_PROJECT_DIR: '/' })).toBeNull();
    expect(pd.knownProjectDir({ CLAUDE_PROJECT_DIR: '/../' })).toBeNull();
    // A set variable is never replaced by the noted dir, even when it is unusable.
    expect(pd.knownProjectDir({ CLAUDE_PROJECT_DIR: 'proj', CLAUDE_CODE_SESSION_ID: w.sid })).toBeNull();
    expect(pd.knownProjectDir({})).toBeNull();
    await w.inProcess(w.A, () => {
      const env = { CLAUDE_CODE_SESSION_ID: w.sid };
      expect(pd.knownProjectDir(env)).toBeNull();
      pd.noteProjectDir(w.sid, { CLAUDE_PROJECT_DIR: w.A });
      expect(pd.knownProjectDir(env)).toBe(w.A);
      expect(pd.knownProjectDir({ ...env, CLAUDE_PROJECT_DIR: w.B })).toBe(w.B);
      expect(pd.knownProjectDir({ CLAUDE_CODE_SESSION_ID: ' ' })).toBeNull();
      const file = join(w.tmp, `goodboy-session-${w.sid}`, 'project-dir.txt');
      for (const bad of [join(w.base, 'gone'), 'proj', '/', '']) {
        writeFileSync(file, `${bad}\n`);
        expect(pd.knownProjectDir(env)).toBeNull();
      }
    });
  });
});
