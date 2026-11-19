// Track M, M6f (plan §19): the same commands the git hooks and the CLI run (lib/git-hooks.ts, lib/commit-scan.ts
// `scanIndex`), called in this process on real temp repos, so the coverage tool sees them (tests/m6f-git-hooks.test.ts
// runs them as spawned hooks, which it cannot see). The install, uninstall, approval and push cases restate those of that
// file on purpose: the same lines, run where the coverage tool sees them. Plus the five push-option forms and a too deeply
// nested script of the command reader, on the way the PreToolUse check takes them.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Acc, commitScanText, scanIndex } from '../lib/commit-scan';
import { commitScanOfCommand, type GuardResult } from '../lib/commit-scan-guard';
import { commitScanCommand, gitHooksCommand, HOOK_SIGNATURE, pushScanCommand } from '../lib/git-hooks';
import { CANARY, cleanup, commit, digestIn, type Fixture, fixture, git, leaked, put, useEnv, withRemote } from './m6f-helpers';

setDefaultTimeout(60_000);

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const BUN = process.execPath;

let f: Fixture;
let undo: () => void;
beforeEach(() => {
  f = fixture({ realData: true });
  undo = useEnv(f);
});
afterEach(() => {
  undo();
  cleanup();
});

const hooksDir = (): string => join(f.repo, '.git', 'hooks');
const install = (...flags: string[]) => gitHooksCommand(['install', ...flags], f.repo, CLI, BUN);
const uninstall = () => gitHooksCommand(['uninstall'], f.repo, CLI, BUN);
const stage = (rel: string, text: string): void => {
  put(f, rel, text);
  git(f, ['add', rel]);
};
const marker = (name: string, content: string): string => {
  mkdirSync(join(f.repo, '.claude'), { recursive: true });
  const p = join(f.repo, '.claude', name);
  writeFileSync(p, content);
  return p;
};

describe('git-hooks install and uninstall, in process', () => {
  test('a wrong form is an error, and so is a shell outside a repository', () => {
    for (const args of [[], ['bogus'], ['install', '--nope'], ['uninstall', '--force']]) {
      expect(gitHooksCommand(args, f.repo, CLI, BUN)).toEqual({ error: 'git-hooks: use `git-hooks install [--force]` or `git-hooks uninstall`' });
    }
    const outside = join(f.base, 'not-a-repo');
    mkdirSync(outside);
    const r = gitHooksCommand(['install'], outside, CLI, BUN);
    expect('error' in r && r.error).toContain('the shell is not in a git repository');
  });

  test('install writes the three hooks marked as goodboy\'s and says what it did; run again it rewrites them', () => {
    const r = install();
    expect(r).toMatchObject({ code: 0, out: { ok: true, dir: hooksDir(), installed: ['pre-commit', 'commit-msg', 'pre-push'], kept_as_saved: [] } });
    for (const n of ['pre-commit', 'commit-msg', 'pre-push']) {
      const text = readFileSync(join(hooksDir(), n), 'utf8');
      expect(text).toContain(HOOK_SIGNATURE);
      expect(text).toContain(`GB_CLI='${CLI}'`);
    }
    expect(install()).toMatchObject({ code: 0 });
  });

  test('a foreign hook is refused without --force, kept as saved with it, and put back by uninstall', () => {
    writeFileSync(join(hooksDir(), 'commit-msg'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const refused = install();
    expect('error' in refused && refused.error).toContain('is a hook goodboy did not write; nothing was changed');
    expect(existsSync(join(hooksDir(), 'pre-commit'))).toBe(false);

    const kept = install('--force');
    expect(kept).toMatchObject({ code: 0, out: { kept_as_saved: ['commit-msg'] } });
    expect(readFileSync(join(hooksDir(), 'commit-msg.goodboy-saved'), 'utf8')).toContain('echo mine');
    expect(readFileSync(join(hooksDir(), 'commit-msg'), 'utf8')).toContain(HOOK_SIGNATURE);

    const gone = uninstall();
    expect(gone).toMatchObject({ code: 0, out: { ok: true, removed: ['pre-commit', 'commit-msg', 'pre-push'], restored: ['commit-msg'], foreign_left: [] } });
    expect(readFileSync(join(hooksDir(), 'commit-msg'), 'utf8')).toContain('echo mine');
    expect(existsSync(join(hooksDir(), 'pre-commit'))).toBe(false);
    expect(existsSync(join(hooksDir(), 'commit-msg.goodboy-saved'))).toBe(false);
  });

  test('a saved name that is taken stops --force before anything is written', () => {
    writeFileSync(join(hooksDir(), 'pre-push'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(hooksDir(), 'pre-push.goodboy-saved'), '#!/bin/sh\n# older\n', { mode: 0o755 });
    const r = install('--force');
    expect('error' in r && r.error).toContain('pre-push.goodboy-saved already exists');
    expect(existsSync(join(hooksDir(), 'pre-commit'))).toBe(false);
  });

  test('uninstall removes goodboy\'s hooks only: a foreign one is listed and left', () => {
    expect(install()).toMatchObject({ code: 0 });
    writeFileSync(join(hooksDir(), 'pre-push'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    expect(uninstall()).toMatchObject({ code: 0, out: { removed: ['pre-commit', 'commit-msg'], restored: [], foreign_left: ['pre-push'] } });
    expect(readdirSync(hooksDir()).filter((n) => ['pre-commit', 'commit-msg'].includes(n))).toEqual([]);
    expect(readFileSync(join(hooksDir(), 'pre-push'), 'utf8')).toContain('echo mine');
    // nothing installed: nothing to do
    expect(uninstall()).toMatchObject({ code: 0, out: { removed: [], foreign_left: ['pre-push'] } });
  });
});

describe('commit-scan, in process', () => {
  test('a wrong form and a shell outside a repository are errors', () => {
    for (const args of [['--nope'], ['--hook'], ['--hook', 'pre-push'], ['--hook', 'pre-commit', 'x'], ['--hook', 'commit-msg']]) {
      expect(commitScanCommand(args, f.repo)).toEqual({ error: 'commit-scan: use `commit-scan` or `commit-scan --hook pre-commit|commit-msg <file>`' });
    }
    const outside = join(f.base, 'not-a-repo');
    mkdirSync(outside);
    expect(commitScanCommand([], outside)).toEqual({ error: 'commit-scan: the shell is not in a git repository' });
    expect(commitScanCommand(['--hook', 'pre-commit'], outside)).toEqual({ error: 'commit-scan: not in a git repository' });
  });

  test('by hand: the list as data, exit 1 only in a real-data project with a match', () => {
    stage('notes.txt', `a\nb\ncall ${CANARY.phone}\n`);
    const r = commitScanCommand([], f.repo);
    expect(r).toMatchObject({ code: 1, out: { real_data: true, blocked: true, hits: [{ path: 'notes.txt', line: 3, kind: 'phone' }] } });
    expect(leaked(JSON.stringify(r))).toBeNull();
    git(f, ['reset', '-q']);
    expect(commitScanCommand([], f.repo)).toMatchObject({ code: 0, out: { real_data: true, blocked: false, hits: [] } });
  });

  test('by hand in a project with no real data: reported, never an exit code', () => {
    const plain = fixture();
    const off = useEnv(plain);
    try {
      put(plain, 'notes.txt', `x ${CANARY.email}\n`);
      git(plain, ['add', 'notes.txt']);
      expect(commitScanCommand([], plain.repo)).toMatchObject({ code: 0, out: { real_data: false, blocked: true } });
      // as a hook it scans nothing at all
      expect(commitScanCommand(['--hook', 'pre-commit'], plain.repo)).toEqual({ code: 0 });
    } finally {
      off();
    }
  });

  test('pre-commit: a staged value stops it with the list and the approval command, never the value; the digest approves it once', () => {
    stage('notes.txt', `a\nb\ncall ${CANARY.phone}\n`);
    const r = commitScanCommand(['--hook', 'pre-commit'], f.repo);
    expect(r).toMatchObject({ code: 1 });
    const stderr = 'stderr' in r ? (r.stderr ?? '') : '';
    expect(stderr).toContain('Matches (1): notes.txt:3 phone');
    expect(stderr).toMatch(/mkdir -p '.*\/\.claude' && echo [0-9a-f]{16} > '.*\.goodboy-commit-scan-approved-hook\.txt'/);
    expect(leaked(stderr)).toBeNull();
    const digest = digestIn(stderr);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);

    // another content's digest, a link to a file with the right digest and a name that is no marker approve nothing
    marker('.goodboy-commit-scan-approved-hook.txt', '0000000000000000\n');
    marker('not-a-marker.txt', `${digest}\n`);
    const target = join(f.base, 'approval-target.txt');
    writeFileSync(target, `${digest}\n`);
    symlinkSync(target, join(f.repo, '.claude', '.goodboy-commit-scan-approved-link.txt'));
    expect(commitScanCommand(['--hook', 'pre-commit'], f.repo)).toMatchObject({ code: 1 });
    // the right digest passes once and is used up
    const m = marker('.goodboy-commit-scan-approved-hook.txt', `${digest}\n`);
    expect(commitScanCommand(['--hook', 'pre-commit'], f.repo)).toEqual({ code: 0 });
    expect(existsSync(m)).toBe(false);
    expect(commitScanCommand(['--hook', 'pre-commit'], f.repo)).toMatchObject({ code: 1 });
  });

  test('pre-commit: a marker that cannot be examined (a .claude dir without search permission) approves nothing', () => {
    stage('notes.txt', `a\ncall ${CANARY.phone}\n`);
    const first = commitScanCommand(['--hook', 'pre-commit'], f.repo);
    const digest = digestIn('stderr' in first ? (first.stderr ?? '') : '');
    const m = marker('.goodboy-commit-scan-approved-hook.txt', `${digest}\n`);
    const dir = join(f.repo, '.claude');
    // read but no search permission: the entry is listed, but looking at it fails (root is not stopped by modes)
    chmodSync(dir, 0o444);
    try {
      // as root (modes do not stop it) this assertion is skipped, so the case checks less there than anywhere else
      if (process.getuid?.() !== 0) expect(commitScanCommand(['--hook', 'pre-commit'], f.repo)).toMatchObject({ code: 1 });
    } finally {
      chmodSync(dir, 0o755);
    }
    // the same marker, reachable again, approves it
    expect(commitScanCommand(['--hook', 'pre-commit'], f.repo)).toEqual({ code: 0 });
    expect(existsSync(m)).toBe(false);
  });

  test('pre-commit: a clean index passes without a word', () => {
    stage('ok.txt', 'nothing here\n');
    expect(commitScanCommand(['--hook', 'pre-commit'], f.repo)).toEqual({ code: 0 });
  });

  test('commit-msg: the message file is scanned; with an identity override the identity is too', () => {
    const msg = join(f.base, 'MSG');
    writeFileSync(msg, `fix #1 ${CANARY.card}\n`);
    const r = commitScanCommand(['--hook', 'commit-msg', msg], f.repo);
    expect(r).toMatchObject({ code: 1 });
    expect('stderr' in r && r.stderr).toContain('card');
    expect(leaked(JSON.stringify(r))).toBeNull();

    writeFileSync(msg, 'fix #1\n');
    expect(commitScanCommand(['--hook', 'commit-msg', msg], f.repo)).toEqual({ code: 0 });
    const was = process.env.GIT_AUTHOR_EMAIL;
    process.env.GIT_AUTHOR_EMAIL = CANARY.email;
    try {
      const o = commitScanCommand(['--hook', 'commit-msg', msg], f.repo);
      expect(o).toMatchObject({ code: 1 });
      expect('stderr' in o && o.stderr).toContain('<author>:1 email');
      expect(leaked(JSON.stringify(o))).toBeNull();
    } finally {
      if (was === undefined) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = was;
    }
  });

  test('scanIndex reads a staged file: a hit with its path and line, and the report is blocked (against HEAD: m6f-scan.test.ts)', () => {
    stage('data/a.txt', `1\n2\n${CANARY.rrn}\n`);
    const acc = new Acc();
    scanIndex(f.repo, acc);
    const report = acc.report();
    expect(report.hits.map((h) => `${h.path}:${h.line} ${h.kind}`)).toEqual(['data/a.txt:3 resident-number']);
    expect(report.blocked).toBe(true);
    expect(leaked(commitScanText(report, 'git commit', ''))).toBeNull();
  });
});

describe('push-scan, in process', () => {
  const zeros = '0'.repeat(40);

  test('a wrong form and a shell outside a repository are errors', () => {
    for (const args of [['--hook'], ['--hook', 'pre-commit', 'origin', 'url'], ['--hook', 'pre-push', 'origin']]) {
      expect(pushScanCommand(args, f.repo, '')).toEqual({ error: 'push-scan: use `push-scan [<remote> [<refspec>...]]` or `push-scan --hook pre-push <remote> <url>`' });
    }
    const outside = join(f.base, 'not-a-repo');
    mkdirSync(outside);
    expect(pushScanCommand([], outside, '')).toEqual({ error: 'push-scan: the shell is not in a git repository' });
  });

  test('by hand: what the push would send as data, exit 1 only with a match in a real-data project', () => {
    withRemote(f);
    commit(f, { 'leak.txt': `card ${CANARY.card}\n` });
    const r = pushScanCommand(['origin', 'main'], f.repo, '');
    expect(r).toMatchObject({ code: 1, out: { real_data: true, blocked: true, hits: [{ path: 'leak.txt', line: 1, kind: 'card' }] } });
    expect(leaked(JSON.stringify(r))).toBeNull();
    git(f, ['push', '-q', '--no-verify', 'origin', 'main']);
    expect(pushScanCommand(['origin', 'main'], f.repo, '')).toMatchObject({ code: 0, out: { blocked: false } });
  });

  test('as the hook: the refs on stdin are what is sent; a project with no real data is not scanned', () => {
    const bare = withRemote(f);
    commit(f, { 'leak.txt': `mail ${CANARY.email}\n` });
    const sha = git(f, ['rev-parse', 'HEAD']).out.trim();
    const stdin = `refs/heads/main ${sha} refs/heads/main ${git(f, ['rev-parse', 'origin/main']).out.trim()}\n`;
    const r = pushScanCommand(['--hook', 'pre-push', 'origin', bare], f.repo, stdin);
    expect(r).toMatchObject({ code: 1 });
    const stderr = 'stderr' in r ? (r.stderr ?? '') : '';
    expect(stderr).toContain('leak.txt:1 email');
    expect(leaked(stderr)).toBeNull();
    // the user's approval, once
    const m = marker('.goodboy-commit-scan-approved-any.txt', `${digestIn(stderr)}\n`);
    expect(pushScanCommand(['--hook', 'pre-push', 'origin', bare], f.repo, stdin)).toEqual({ code: 0 });
    expect(existsSync(m)).toBe(false);
    // a deleted ref sends nothing
    expect(pushScanCommand(['--hook', 'pre-push', 'origin', bare], f.repo, `(delete) ${zeros} refs/heads/old ${sha}\n`)).toEqual({ code: 0 });

    const plain = fixture();
    const off = useEnv(plain);
    try {
      expect(pushScanCommand(['--hook', 'pre-push', 'origin', 'url'], plain.repo, stdin)).toEqual({ code: 0 });
    } finally {
      off();
    }
  });
});

describe('the command reader, in process', () => {
  const scan = (command: string): GuardResult | null => commitScanOfCommand(command, f.repo, f.repo, { env: f.env });
  const whys = (r: GuardResult | null): string[] => (r?.report.unscanned ?? []).map((u) => u.why);

  test('push options that take a value, and --repo with its value apart, do not hide what the push sends', () => {
    withRemote(f);
    commit(f, { 'leak.txt': `key ${CANARY.secret}\n` });
    for (const c of ['git push --repo origin', 'git push --receive-pack git-receive-pack origin main', 'git push -o ci.skip origin main', 'git push --push-option=x origin main', 'git push --exec git-receive-pack origin main']) {
      const r = scan(c);
      expect([c, (r?.report.hits ?? []).map((h) => `${h.path}:${h.line} ${h.kind}`)]).toEqual([c, ['leak.txt:1 secret']]);
    }
  });

  test('a script nested past the reader\'s depth is "not scanned", never silently passed', () => {
    const nested = ['bash <<\'A\'', 'bash <<\'B\'', 'bash <<\'C\'', 'git commit --allow-empty -m "x #1"', 'C', 'B', 'A'].join('\n');
    const r = scan(nested);
    expect(r?.report.blocked).toBe(true);
    expect(whys(r)).toContain('goodboy cannot read this command well enough to tell what it commits or pushes');
    // the control: one level less is read, and a commit with an issue number passes
    expect(scan(['bash <<\'A\'', 'bash <<\'B\'', 'git commit --allow-empty -m "x #1"', 'B', 'A'].join('\n'))).toBeNull();
  });
});
