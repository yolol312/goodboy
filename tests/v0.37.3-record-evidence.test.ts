// v0.37.3 (plan §15.38): test output kept out of the recorded tree.
//   AC-2: `untrackedInTree` (lib/push-test.ts) names the untracked, not ignored files the recorded tree holds, and
//   `test-write` (lib/cli.ts) warns on stderr when there are any (never with `--worktree`, never on a clean tree).
// The I5 half (a whole-suite run needs no test_files listing) is in tests/i5-existing-tests.test.ts.
//
// The new function is imported inside the tests that need it, so a red run on the old tree fails those tests and not the file.
// Everything is temporary: the repos, TMPDIR and the registry dir. No docker, no network, no hook installed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const untrackedOf = async (cwd: string, max?: number): Promise<string[]> => {
  const lib = (await import('../lib/push-test')) as { untrackedInTree: (cwd: string, max?: number) => string[] };
  return max === undefined ? lib.untrackedInTree(cwd) : lib.untrackedInTree(cwd, max);
};

let box = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['TMPDIR', 'GOODBOY_REGISTRY_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PROJECT_DIR'];

beforeEach(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-v37-3-')));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.TMPDIR = box;
  process.env.GOODBOY_REGISTRY_DIR = join(box, 'registry');
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_PROJECT_DIR;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(box, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
/** A repo with src/app.js and tests/app.test.js committed. */
function repo(name = 'repo'): string {
  const top = join(box, name);
  mkdirSync(top, { recursive: true });
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 't@example.com');
  git(top, 'config', 'user.name', 't');
  git(top, 'config', 'commit.gpgsign', 'false');
  write(top, 'src/app.js', 'export const f = (x) => x + 1;\n');
  write(top, 'tests/app.test.js', 'import { test } from "node:test";\ntest("f", () => {});\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'start #1');
  return top;
}

// ---- AC-2: untrackedInTree ----

describe('AC-2: untrackedInTree', () => {
  test('lists untracked files repo-relative (a nested dir file by its own path), never a tracked one', async () => {
    const top = repo();
    write(top, 'coverage/lcov.info', 'TN:\n');
    write(top, 'notes/deep/a.txt', 'x\n');
    write(top, 'src/app.js', 'export const f = (x) => x + 2;\n'); // modified, tracked: not untracked
    expect((await untrackedOf(top)).sort()).toEqual(['coverage/lcov.info', 'notes/deep/a.txt']);
  });

  test('is the same from a subdirectory of the repo (names stay relative to the repo top)', async () => {
    const top = repo();
    write(top, 'coverage/lcov.info', 'TN:\n');
    expect((await untrackedOf(join(top, 'src')))).toEqual(['coverage/lcov.info']);
  });

  test('a clean tree has none', async () => {
    expect((await untrackedOf(repo()))).toEqual([]);
  });

  test('leaves out goodboy artifacts: result dirs, markers and the .goodboy project files; other files there count', async () => {
    const top = repo();
    for (const rel of [
      '.claude/tests/result.json',
      '.claude/reviews/r.json',
      '.claude/pending/p.json',
      '.claude/.goodboy-marker',
      '.goodboy/policy.md',
      '.goodboy/docs.json',
      '.goodboy/test-catalog.md',
      '.goodboy/hosts',
      '.goodboy/commit-issue',
    ]) {
      write(top, rel, 'x\n');
    }
    expect((await untrackedOf(top))).toEqual([]);
    // Other files in those places may be code the project loads: they stay in the tree and are named.
    write(top, '.goodboy/other.txt', 'x\n');
    write(top, '.claude/settings.json', '{}\n');
    expect((await untrackedOf(top)).sort()).toEqual(['.claude/settings.json', '.goodboy/other.txt']);
  });

  test('leaves out the artifacts of a project dir below the repo top; other files there are named', async () => {
    const top = repo();
    for (const rel of ['pkg/.claude/tests/r.json', 'pkg/.claude/reviews/r.json', 'pkg/.claude/pending/p.json', 'pkg/.claude/.goodboy-marker', 'deep/pkg/.claude/tests/r.json']) {
      write(top, rel, 'x\n');
    }
    expect(await untrackedOf(top)).toEqual([]);
    write(top, 'pkg/.claude/settings.json', '{}\n');
    write(top, 'pkg/coverage/lcov.info', 'TN:\n');
    expect((await untrackedOf(top)).sort()).toEqual(['pkg/.claude/settings.json', 'pkg/coverage/lcov.info']);
  });

  test('honors .gitignore and .git/info/exclude', async () => {
    const top = repo();
    write(top, '.gitignore', 'ignored.log\ncoverage/\n');
    write(top, '.git/info/exclude', 'local.cfg\n');
    write(top, 'ignored.log', 'x\n');
    write(top, 'coverage/lcov.info', 'TN:\n');
    write(top, 'local.cfg', 'x\n');
    write(top, 'kept.txt', 'x\n');
    // .gitignore itself is untracked here, so it is named; the ignored ones are not.
    expect((await untrackedOf(top)).sort()).toEqual(['.gitignore', 'kept.txt']);
  });

  test('names at most `max` files (5 by default)', async () => {
    const top = repo();
    for (let i = 0; i < 8; i++) write(top, `out/f${i}.txt`, 'x\n');
    expect((await untrackedOf(top))).toHaveLength(5);
    expect((await untrackedOf(top, 2))).toHaveLength(2);
    expect((await untrackedOf(top, 20))).toHaveLength(8);
    expect((await untrackedOf(top, 0))).toEqual([]);
  });

  test('is empty outside a repo, and when git cannot read the repo', async () => {
    const plain = join(box, 'plain');
    mkdirSync(plain);
    write(plain, 'a.txt', 'x\n');
    expect((await untrackedOf(plain))).toEqual([]);
    // A repo whose index is unreadable: the repo is found, git's answer is not.
    const top = repo('broken');
    write(top, 'coverage/lcov.info', 'TN:\n');
    writeFileSync(join(top, '.git', 'index'), 'not an index');
    expect((await untrackedOf(top))).toEqual([]);
  });
});

// ---- AC-2: test-write prints the warning ----

describe('AC-2: test-write warns when the recorded tree holds untracked files', () => {
  const input = (extra: Record<string, unknown> = {}) => ({
    timestamp: new Date().toISOString(),
    tested_files: ['src/app.js'],
    category: 'fix-bug',
    test_files: ['tests/app.test.js'],
    environment: { mode: 'none', command: 'none', evidence: 'library' },
    suites: [{ name: 'unit', command: 'node --test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [{ id: 'AC-1', description: 'd', test: 'tests/app.test.js', red: { command: 'c', output: 'o', exit_code: 1 }, green: { command: 'c', output: 'o', exit_code: 0 } }],
    verdict: 'pass',
    ...extra,
  });
  function inputFile(body: unknown): string {
    return write(box, `in-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(body));
  }
  /** Runs a CLI command in this process, stdout and stderr captured. */
  async function captured(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
    const o = process.stdout.write;
    const e = process.stderr.write;
    let out = '';
    let err = '';
    process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => ((err += String(c)), true)) as typeof process.stderr.write;
    try {
      await fn();
    } finally {
      process.stdout.write = o;
      process.stderr.write = e;
    }
    return { out, err };
  }
  const WARNING = 'warning: the recorded tree holds untracked files';

  test('an untracked coverage/lcov.info in the repo: the record is written and stderr names the file', async () => {
    const { cmdTestWrite } = await import('../lib/cli');
    const top = repo();
    write(top, 'coverage/lcov.info', 'TN:\n');
    const { out, err } = await captured(() => cmdTestWrite(top, [inputFile(input())], top));
    expect(existsSync(JSON.parse(out).path)).toBe(true);
    expect(err).toContain(`${WARNING} (coverage/lcov.info)`);
    expect(err).toContain('Commit new files that belong to the change, remove test output (coverage reports, logs) from the repo');
  }, 60_000);

  test('many untracked files: at most five are named', async () => {
    const { cmdTestWrite } = await import('../lib/cli');
    const top = repo();
    for (let i = 0; i < 8; i++) write(top, `out/f${i}.txt`, 'x\n');
    const { err } = await captured(() => cmdTestWrite(top, [inputFile(input())], top));
    const line = err.split('\n').find((l) => l.startsWith(WARNING)) ?? '';
    expect((line.match(/out\/f\d\.txt/g) ?? []).length).toBe(5);
  }, 60_000);

  test('a clean tree gets no warning (the record dir is goodboy\'s own and never counts)', async () => {
    const { cmdTestWrite } = await import('../lib/cli');
    const top = repo();
    const first = await captured(() => cmdTestWrite(top, [inputFile(input())], top));
    expect(first.err).not.toContain(WARNING);
    // The record just written is untracked in the repo; a second run still sees a clean tree.
    expect(existsSync(join(top, '.claude', 'tests'))).toBe(true);
    const second = await captured(() => cmdTestWrite(top, [inputFile(input())], top));
    expect(second.err).not.toContain(WARNING);
  }, 60_000);

  test('a project dir below the repo top: its own records (untracked, in its .claude/tests) never warn, the first or the second time', async () => {
    const { cmdTestWrite } = await import('../lib/cli');
    const top = repo();
    const sub = join(top, 'pkg');
    mkdirSync(sub);
    const abs = input({ tested_files: [join(top, 'src/app.js')], test_files: [join(top, 'tests/app.test.js')] });
    const first = await captured(() => cmdTestWrite(sub, [inputFile(abs)], sub));
    expect(first.err).not.toContain(WARNING);
    expect(existsSync(join(sub, '.claude', 'tests'))).toBe(true);
    const second = await captured(() => cmdTestWrite(sub, [inputFile(abs)], sub));
    expect(second.err).not.toContain(WARNING);
    // Test output next to them is still named.
    write(top, 'pkg/coverage/lcov.info', 'TN:\n');
    const third = await captured(() => cmdTestWrite(sub, [inputFile(abs)], sub));
    expect(third.err).toContain(`${WARNING} (pkg/coverage/lcov.info)`);
  }, 60_000);

  test('an ignored coverage dir gets no warning', async () => {
    const { cmdTestWrite } = await import('../lib/cli');
    const top = repo();
    write(top, '.git/info/exclude', 'coverage/\n');
    write(top, 'coverage/lcov.info', 'TN:\n');
    const { err } = await captured(() => cmdTestWrite(top, [inputFile(input())], top));
    expect(err).not.toContain(WARNING);
  }, 60_000);

  test('--worktree: the clean linked worktree is the tested tree, so untracked files of the main checkout are no warning', async () => {
    const { cmdTestWrite } = await import('../lib/cli');
    const top = repo();
    const wt = join(box, 'wt');
    git(top, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    write(top, 'coverage/lcov.info', 'TN:\n'); // untracked in the main checkout only
    const { out, err } = await captured(() => cmdTestWrite(top, ['--worktree', wt, inputFile(input())], top));
    const rec = JSON.parse(readFileSync(JSON.parse(out).path, 'utf8')) as { worktree?: string };
    expect(rec.worktree).toBe(wt);
    expect(err).not.toContain(WARNING);
  }, 60_000);

  test('the CLI process prints the warning on stderr and exits 0', () => {
    const top = repo();
    write(top, 'coverage/lcov.info', 'TN:\n');
    const env = { ...process.env, TMPDIR: box, GOODBOY_REGISTRY_DIR: join(box, 'registry') } as Record<string, string>;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CLAUDE_PROJECT_DIR;
    const p = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: top, env, stdin: new TextEncoder().encode(JSON.stringify(input())), stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toContain(`${WARNING} (coverage/lcov.info)`);
    // The same run on a tree without the file.
    rmSync(join(top, 'coverage'), { recursive: true });
    const clean = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: top, env, stdin: new TextEncoder().encode(JSON.stringify(input())), stdout: 'pipe', stderr: 'pipe' });
    expect(clean.exitCode).toBe(0);
    expect(clean.stderr.toString()).not.toContain(WARNING);
  }, 60_000);
});
