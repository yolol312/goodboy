// Track M, M6f (plan §19): the git hooks (`cli.ts git-hooks install | uninstall`) and the commands they run
// (`commit-scan`, `push-scan`), in real temp repos with real `git commit` and `git push` to a local bare repo. Install
// and uninstall (core.hooksPath, a foreign hook refused, kept and chained, put back), a commit and a push that the hooks
// stop, `--no-verify`, the user's one-use approval, a project with no real data, and no value in any output.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hookScript, HOOK_SIGNATURE } from '../lib/git-hooks';
import { CANARY, cleanup, commit, digestIn, type Fixture, fixture, git, leaked, put, withRemote } from './m6f-helpers';

// Real git repos and spawned processes: slower than the 5 s default on a busy machine.
setDefaultTimeout(60_000);

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');

let f: Fixture;
beforeEach(() => {
  f = fixture({ realData: true });
});
afterEach(cleanup);

interface Out {
  code: number;
  out: string;
  err: string;
}

/** The goodboy CLI in the fixture's repo (or `cwd`), under its environment. */
function cli(args: string[], o: { cwd?: string; input?: string; fx?: Fixture } = {}): Out {
  const fx = o.fx ?? f;
  const p = Bun.spawnSync(['bun', CLI, ...args], { cwd: o.cwd ?? fx.repo, env: { ...process.env, ...fx.env }, stdin: o.input !== undefined ? Buffer.from(o.input) : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

const install = (fx: Fixture = f, ...flags: string[]): Out => cli(['git-hooks', 'install', ...flags], { fx });
const hooksDir = (fx: Fixture = f): string => join(fx.repo, '.git', 'hooks');
const executable = (p: string): boolean => (statSync(p).mode & 0o111) !== 0;
/** The head commit, to tell whether a commit was made. */
const head = (fx: Fixture = f): string => git(fx, ['rev-parse', 'HEAD']).out.trim();
/** The output of runs, joined, to look for a value. */
const all = (...o: Out[]): string => o.map((x) => `${x.out}\n${x.err}`).join('\n');

describe('install and uninstall', () => {
  test('install writes the three hooks, executable, marked as goodboy\'s, pointing at the CLI; run again it just rewrites them', () => {
    const r = install();
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { ok: boolean; dir: string; installed: string[]; kept_as_saved: string[] };
    expect(j.ok).toBe(true);
    expect(j.dir).toBe(hooksDir());
    expect(j.installed).toEqual(['pre-commit', 'commit-msg', 'pre-push']);
    for (const n of j.installed) {
      const p = join(hooksDir(), n);
      expect(executable(p)).toBe(true);
      const text = readFileSync(p, 'utf8');
      expect(text.startsWith('#!/bin/sh\n')).toBe(true);
      expect(text).toContain(HOOK_SIGNATURE);
      expect(text).toContain(`GB_CLI='${CLI}'`);
    }
    expect(readFileSync(join(hooksDir(), 'pre-push'), 'utf8')).toContain('push-scan --hook pre-push');
    expect(readFileSync(join(hooksDir(), 'commit-msg'), 'utf8')).toContain('commit-scan --hook commit-msg "$1"');
    expect(install().code).toBe(0);
  });

  test('install in the repo\'s core.hooksPath, relative or a shared absolute dir', () => {
    git(f, ['config', 'core.hooksPath', '.githooks']);
    expect(install().code).toBe(0);
    expect(readdirSync(join(f.repo, '.githooks')).sort()).toEqual(['commit-msg', 'pre-commit', 'pre-push']);
    expect(existsSync(join(hooksDir(), 'pre-commit'))).toBe(false);
    const shared = join(f.base, 'shared-hooks');
    git(f, ['config', 'core.hooksPath', shared]);
    const r = install();
    expect(JSON.parse(r.out).dir).toBe(shared);
    expect(readdirSync(shared).sort()).toEqual(['commit-msg', 'pre-commit', 'pre-push']);
  });

  test('a hook goodboy did not write is not overwritten: nothing changes, and the error says what to do', () => {
    writeFileSync(join(hooksDir(), 'commit-msg'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const r = install();
    expect(r.code).toBe(1);
    expect(r.err).toContain('is a hook goodboy did not write; nothing was changed');
    expect(r.err).toContain('--force');
    expect(readFileSync(join(hooksDir(), 'commit-msg'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(existsSync(join(hooksDir(), 'pre-commit'))).toBe(false);
    expect(existsSync(join(hooksDir(), 'pre-push'))).toBe(false);
  });

  test('--force keeps it as <name>.goodboy-saved and runs it after goodboy\'s scan, with its arguments and stdin', () => {
    const log = join(f.base, 'saved.log');
    const script = (n: string) => `#!/bin/sh\necho "${n} $* $(cat)" >> ${log}\nexit \${SAVED_EXIT:-0}\n`;
    withRemote(f);
    for (const n of ['pre-commit', 'commit-msg', 'pre-push']) writeFileSync(join(hooksDir(), n), script(n), { mode: 0o755 });
    const r = install(f, '--force');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).kept_as_saved).toEqual(['pre-commit', 'commit-msg', 'pre-push']);
    expect(readFileSync(join(hooksDir(), 'pre-commit.goodboy-saved'), 'utf8')).toBe(script('pre-commit'));
    put(f, 'a.txt', 'a\n');
    git(f, ['add', 'a.txt']);
    git(f, ['commit', '-q', '-m', 'a #1']);
    git(f, ['push', '-q', 'origin', 'main']);
    const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l !== '');
    expect(lines[0]).toBe('pre-commit  ');
    expect(lines[1]!.startsWith('commit-msg .git/COMMIT_EDITMSG')).toBe(true);
    // pre-push gets git's two arguments and the ref lines on stdin
    expect(lines.at(-1)).toMatch(/^pre-push origin .*origin\.git refs\/heads\/main [0-9a-f]{40} refs\/heads\/main [0-9a-f]{40}$/);
    // a saved hook that fails fails the commit, after the scan passed
    const before = head();
    put(f, 'b.txt', 'b\n');
    git(f, ['add', 'b.txt']);
    const failed = git(f, ['commit', '-q', '-m', 'b #1'], { fail: true, env: { SAVED_EXIT: '3' } });
    expect(failed.code).not.toBe(0);
    expect(head()).toBe(before);
  });

  test('a saved name that is taken stops --force before anything is written', () => {
    writeFileSync(join(hooksDir(), 'pre-push'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(hooksDir(), 'pre-push.goodboy-saved'), '#!/bin/sh\n# older\n', { mode: 0o755 });
    const r = install(f, '--force');
    expect(r.code).toBe(1);
    expect(r.err).toContain('pre-push.goodboy-saved already exists');
    expect(existsSync(join(hooksDir(), 'pre-commit'))).toBe(false);
  });

  test('uninstall removes goodboy\'s hooks only and puts a saved hook back', () => {
    writeFileSync(join(hooksDir(), 'pre-commit'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    install(f, '--force');
    // a hook the user wrote after installing: left alone
    writeFileSync(join(hooksDir(), 'commit-msg'), '#!/bin/sh\necho later\n', { mode: 0o755 });
    const r = cli(['git-hooks', 'uninstall']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { removed: string[]; restored: string[]; foreign_left: string[] };
    expect(j.removed).toEqual(['pre-commit', 'pre-push']);
    expect(j.restored).toEqual(['pre-commit']);
    expect(j.foreign_left).toEqual(['commit-msg']);
    expect(readFileSync(join(hooksDir(), 'pre-commit'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(readFileSync(join(hooksDir(), 'commit-msg'), 'utf8')).toBe('#!/bin/sh\necho later\n');
    expect(existsSync(join(hooksDir(), 'pre-push'))).toBe(false);
    expect(existsSync(join(hooksDir(), 'pre-commit.goodboy-saved'))).toBe(false);
  });

  test('a wrong form and a shell outside a repo are errors', () => {
    expect(cli(['git-hooks']).err).toContain('git-hooks: use');
    expect(cli(['git-hooks', 'uninstall', '--force']).err).toContain('git-hooks: use');
    expect(cli(['git-hooks', 'install', '--nope']).err).toContain('git-hooks: use');
    const outside = join(f.base, 'not-a-repo');
    mkdirSync(outside);
    expect(cli(['git-hooks', 'install'], { cwd: outside }).err).toContain('not in a git repository');
  });

  test('a hook whose plugin path is gone stops the commit and says why; its bun is found on PATH when the path is stale', () => {
    writeFileSync(join(hooksDir(), 'pre-commit'), hookScript('pre-commit', '/nonexistent/bun', '/nonexistent/cli.ts'), { mode: 0o755 });
    put(f, 'a.txt', 'a\n');
    git(f, ['add', 'a.txt']);
    const r = git(f, ['commit', '-q', '-m', 'a #1'], { fail: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('/nonexistent/cli.ts is gone');
    // the CLI is there, the bun path is stale: bun from PATH runs it
    writeFileSync(join(hooksDir(), 'pre-commit'), hookScript('pre-commit', '/nonexistent/bun', CLI), { mode: 0o755 });
    expect(git(f, ['commit', '-q', '-m', 'a #1'], { fail: true }).code).toBe(0);
  });
});

describe('a commit through the hooks', () => {
  beforeEach(() => {
    expect(install().code).toBe(0);
  });

  test('a staged value stops the commit with the list and no value; the commit is not made', () => {
    put(f, 'notes.txt', `a\nb\ncall ${CANARY.phone}\n`);
    git(f, ['add', 'notes.txt']);
    const before = head();
    const r = git(f, ['commit', '-m', 'work #1'], { fail: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('Matches (1): notes.txt:3 phone');
    expect(r.err).toMatch(/mkdir -p '.*\/\.claude' && echo [0-9a-f]{16} > '.*\.goodboy-commit-scan-approved-hook\.txt'/);
    expect(leaked(all({ code: r.code, out: r.out, err: r.err }))).toBeNull();
    expect(head()).toBe(before);
  });

  test('-a and a path commit are scanned through git\'s own index for them', () => {
    commit(f, { 'clean.txt': 'clean\n', 'other.txt': 'other\n' }, 'two #1');
    const before = head();
    put(f, 'clean.txt', `x ${CANARY.email}\n`);
    for (const args of [['commit', '-a', '-m', 'x #1'], ['commit', '-m', 'x #1', 'clean.txt']]) {
      const r = git(f, args, { fail: true });
      expect([args.join(' '), r.code === 0]).toEqual([args.join(' '), false]);
      expect(r.err).toContain('clean.txt:1 email');
      expect(leaked(r.err + r.out)).toBeNull();
    }
    // a path commit does not publish another staged file: the hook sees only the named one
    git(f, ['checkout', '--', 'clean.txt']);
    put(f, 'other.txt', `x ${CANARY.email}\n`);
    git(f, ['add', 'other.txt']);
    put(f, 'clean.txt', 'clean 2\n');
    expect(git(f, ['commit', '-q', '-m', 'only clean #1', 'clean.txt'], { fail: true }).code).toBe(0);
    expect(head()).not.toBe(before);
  });

  test('the message is scanned by commit-msg', () => {
    put(f, 'a.txt', 'a\n');
    git(f, ['add', 'a.txt']);
    const before = head();
    const r = git(f, ['commit', '-m', `call ${CANARY.phone} #1`], { fail: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('<commit message>:1 phone');
    expect(leaked(r.err + r.out)).toBeNull();
    expect(head()).toBe(before);
  });

  test('--no-verify skips the hooks (git\'s, stated in the README)', () => {
    put(f, 'notes.txt', `${CANARY.card}\n`);
    git(f, ['add', 'notes.txt']);
    const before = head();
    git(f, ['commit', '-q', '--no-verify', '-m', 'work #1']);
    expect(head()).not.toBe(before);
  });

  test('a binary file is not scanned and stops the commit', () => {
    put(f, 'blob.dat', Buffer.from([0, 1, 2, 3]));
    git(f, ['add', 'blob.dat']);
    const r = git(f, ['commit', '-m', 'work #1'], { fail: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('Not scanned (1): blob.dat (binary content)');
  });

  test('the user\'s approval for exactly that content passes once', () => {
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const first = git(f, ['commit', '-m', 'work #1'], { fail: true });
    const digest = digestIn(first.err);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    const marker = join(f.repo, '.claude', '.goodboy-commit-scan-approved-hook.txt');
    mkdirSync(join(f.repo, '.claude'), { recursive: true });
    // empty, wrong digest: no
    writeFileSync(marker, '');
    expect(git(f, ['commit', '-m', 'work #1'], { fail: true }).code).not.toBe(0);
    writeFileSync(marker, '0123456789abcdef\n');
    expect(git(f, ['commit', '-m', 'work #1'], { fail: true }).code).not.toBe(0);
    writeFileSync(marker, `${digest}\n`);
    const before = head();
    expect(git(f, ['commit', '-q', '-m', 'work #1'], { fail: true }).code).toBe(0);
    expect(head()).not.toBe(before);
    expect(existsSync(marker)).toBe(false);
    // used up, and bound to the content
    put(f, 'more.txt', `${CANARY.email}\n`);
    git(f, ['add', 'more.txt']);
    writeFileSync(marker, `${digest}\n`);
    expect(git(f, ['commit', '-m', 'work #2'], { fail: true }).code).not.toBe(0);
  });

  test('a project that holds no real data is not scanned and nothing is printed', () => {
    const g = fixture();
    expect(install(g).code).toBe(0);
    put(g, 'notes.txt', `${CANARY.email}\n`);
    git(g, ['add', 'notes.txt']);
    const r = git(g, ['commit', '-m', 'work #1'], { fail: true });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });
});

describe('a push through the hooks', () => {
  beforeEach(() => {
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
    expect(install().code).toBe(0);
  });

  test('a push of a commit with a value is stopped, also when it is behind the head; the remote gets nothing', () => {
    git(f, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'empty #1']);
    commit(f, { 'leak.txt': `x ${CANARY.secret}\n` }, 'leak #1');
    git(f, ['commit', '-q', '--allow-empty', '-m', 'tip #1']);
    const r = git(f, ['push', 'origin', 'main'], { fail: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('leak.txt:1 secret');
    expect(leaked(r.err + r.out)).toBeNull();
    expect(git(f, ['ls-remote', 'origin', 'refs/heads/main']).out.split('\t')[0]).not.toBe(head());
    // --no-verify sends it
    git(f, ['push', '-q', '--no-verify', 'origin', 'main']);
    expect(git(f, ['ls-remote', 'origin', 'refs/heads/main']).out.split('\t')[0]).toBe(head());
  });

  test('a clean push passes, a deletion and a ref with a value among others do not', () => {
    commit(f, { 'ok.txt': 'ok\n' }, 'ok #1');
    expect(git(f, ['push', '-q', 'origin', 'main'], { fail: true }).code).toBe(0);
    git(f, ['checkout', '-q', '-b', 'side']);
    commit(f, { 'leak.txt': `x ${CANARY.card}\n` }, 'leak #1');
    git(f, ['checkout', '-q', 'main']);
    const r = git(f, ['push', 'origin', 'main', 'side'], { fail: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('leak.txt:1 card');
    expect(git(f, ['push', '-q', 'origin', 'main'], { fail: true }).code).toBe(0);
    git(f, ['push', '-q', '--no-verify', 'origin', 'side']);
    expect(git(f, ['push', '-q', 'origin', ':side'], { fail: true }).code).toBe(0);
  });

  test('a tag push and a message with a value are scanned too', () => {
    commit(f, { 'a.txt': 'a\n' }, `call ${CANARY.phone} #1`);
    const r = git(f, ['push', 'origin', 'main'], { fail: true });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/<commit message [0-9a-f]{7}>:1 phone/);
    expect(leaked(r.err)).toBeNull();
  });

  test('the user\'s approval for exactly that content passes a push once', () => {
    commit(f, { 'leak.txt': `x ${CANARY.email}\n` }, 'leak #1');
    const first = git(f, ['push', 'origin', 'main'], { fail: true });
    const digest = digestIn(first.err);
    mkdirSync(join(f.repo, '.claude'), { recursive: true });
    const marker = join(f.repo, '.claude', '.goodboy-commit-scan-approved-hook.txt');
    writeFileSync(marker, digest);
    expect(git(f, ['push', '-q', 'origin', 'main'], { fail: true }).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('a project that holds no real data is not scanned', () => {
    const g = fixture();
    git(g, ['config', 'user.email', 'me@corp.io']);
    withRemote(g);
    expect(install(g).code).toBe(0);
    commit(g, { 'leak.txt': `x ${CANARY.email}\n` }, 'leak #1');
    expect(git(g, ['push', '-q', 'origin', 'main'], { fail: true }).code).toBe(0);
  });
});

describe('by hand', () => {
  test('commit-scan prints the scan; it exits 1 only for real data with a match or an unscanned file', () => {
    put(f, 'notes.txt', `a\n${CANARY.rrn}\n`);
    put(f, 'blob.dat', Buffer.from([0, 1]));
    git(f, ['add', '-A']);
    const r = cli(['commit-scan']);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as { real_data: boolean; blocked: boolean; hits: Array<{ path: string; line: number; kind: string }>; unscanned: Array<{ path: string; why: string }>; digest: string };
    expect(j.real_data).toBe(true);
    expect(j.blocked).toBe(true);
    expect(j.hits).toEqual([{ path: 'notes.txt', line: 2, kind: 'resident-number' }]);
    expect(j.unscanned).toEqual([{ path: 'blob.dat', why: 'binary content' }]);
    expect(j.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(leaked(all(r))).toBeNull();
    // without real data the same scan is a report, exit 0
    const g = fixture();
    put(g, 'notes.txt', `a\n${CANARY.rrn}\n`);
    git(g, ['add', '-A']);
    const p = cli(['commit-scan'], { fx: g });
    expect(p.code).toBe(0);
    const pj = JSON.parse(p.out) as { real_data: boolean; blocked: boolean; hits: unknown[] };
    expect([pj.real_data, pj.blocked, pj.hits.length]).toEqual([false, true, 1]);
  });

  test('the hook and the hand scan give one digest for one index', () => {
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', '-A']);
    const byHand = (JSON.parse(cli(['commit-scan']).out) as { digest: string }).digest;
    expect(install().code).toBe(0);
    const r = git(f, ['commit', '-m', 'work #1'], { fail: true });
    expect(digestIn(r.err)).toBe(byHand);
  });

  test('push-scan takes a remote and refspecs like git push', () => {
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
    git(f, ['checkout', '-q', '-b', 'side']);
    commit(f, { 'leak.txt': `x ${CANARY.card}\n` }, 'leak #1');
    git(f, ['checkout', '-q', 'main']);
    expect(cli(['push-scan', 'origin', 'main']).code).toBe(0);
    const r = cli(['push-scan', 'origin', 'side']);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as { hits: unknown[] }).hits).toEqual([{ path: 'leak.txt', line: 1, kind: 'card' }]);
    expect(cli(['push-scan', '--all']).code).toBe(1);
    expect(leaked(all(r))).toBeNull();
  });

  test('wrong forms and a shell outside a repo are errors', () => {
    expect(cli(['commit-scan', '--hook']).err).toContain('commit-scan: use');
    expect(cli(['commit-scan', '--hook', 'pre-commit', 'x']).err).toContain('commit-scan: use');
    expect(cli(['commit-scan', 'extra']).err).toContain('commit-scan: use');
    expect(cli(['push-scan', '--hook', 'pre-push', 'origin']).err).toContain('push-scan: use');
    const outside = join(f.base, 'not-a-repo');
    mkdirSync(outside);
    expect(cli(['commit-scan'], { cwd: outside }).err).toContain('not in a git repository');
    expect(cli(['push-scan'], { cwd: outside }).err).toContain('not in a git repository');
  });

  test('a hook push with ref lines goodboy cannot read is not scanned (fail closed)', () => {
    const r = cli(['push-scan', '--hook', 'pre-push', 'origin', 'url'], { input: 'garbage\n' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Not scanned (1): <push> (a ref line git gave the hook is not one goodboy can read)');
  });

  test('a message file that cannot be read, or is binary, is not scanned by commit-msg', () => {
    const missing = cli(['commit-scan', '--hook', 'commit-msg', 'nowhere.txt']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Not scanned (1): <message file> (the message file cannot be read)');
    put(f, 'msg.bin', Buffer.from([0, 1, 2]));
    const binary = cli(['commit-scan', '--hook', 'commit-msg', 'msg.bin']);
    expect(binary.code).toBe(1);
    expect(binary.err).toContain('<message file> (the message file is binary content)');
  });

  test('install leaves no temp file behind and the hook files are plain files', () => {
    install();
    expect(readdirSync(hooksDir()).filter((n) => n.includes('goodboy-tmp'))).toEqual([]);
    expect(lstatSync(join(hooksDir(), 'pre-commit')).isFile()).toBe(true);
  });
});
