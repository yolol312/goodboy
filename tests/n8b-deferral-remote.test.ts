// N8b follow-up (plan §20.12, v0.38.3, security delta review): what a push sends is read from the remote itself, not from
// the remote-tracking refs of the clone (`git update-ref refs/remotes/origin/x HEAD` emptied `--not --remotes`).
//   AC-11a  remoteTips / unpushedFiles / deferredDueAtPush against real local bare repos (no network): a forged
//           tracking ref excludes nothing, the push URLs (all of them) are the ones read, a model-planted repo config is not run, a remote
//           tip this clone lacks excludes nothing, an unreadable remote is unknown;
//   AC-11b  pushUrlsOf: a name, a URL, a path, what is refused;
//   AC-11c  the push's remote as the hand-off carries it (lib/push-test.ts handoffsOf, pushRemoteOf);
//   AC-11d  spawnGit `remoteRead`: the one call that may talk to a remote, with the env that makes it safe;
//   AC-11g  a remote with several push URLs: git pushes to each, so what any one lacks is owed (security review);
//   AC-11h  a relative URL is resolved from the work tree's top, where git runs a push, not from the cwd;
//   AC-11i  a git older than 2.32 ignores GIT_CONFIG_GLOBAL, so its remote read is refused;
//   AC-11j  one URL that cannot be read makes the whole answer unknown;
//   AC-11k  a URL git expands from a home dir (`~/x.git`, `~user/x.git`) cannot be told: unknown, whatever stands at <top>/~/.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deferMatcher, deferredDueAtPush, gitHonorsConfigGlobal, MAX_PUSH_FILES, pushRewrite, pushUrlsOf, remoteTips, systemConfigTrusted, unpushedFiles } from '../lib/deferral';
import { beginGitSnapshot, endGitSnapshot, spawnGit } from '../lib/git-run';
import { handoffsOf, pushRemoteOf } from '../lib/push-test';

setDefaultTimeout(90_000);

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  // The in-process git calls read the process environment: no user or system config.
  for (const [k, v] of Object.entries({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '1' })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const restorePath: string[] = [];
afterEach(() => {
  while (restorePath.length) process.env.PATH = restorePath.pop()!;
  endGitSnapshot();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-n8br-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function g(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', '-c', 'user.email=t@e.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: process.env as Record<string, string> });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function commitFile(w: string, name: string, text: string): string {
  writeFileSync(join(w, name), text);
  g(w, 'add', '-A');
  g(w, 'commit', '-q', '-m', name);
  return g(w, 'rev-parse', 'HEAD');
}

interface World {
  base: string;
  /** The work clone; its `origin` is `real` and has `base` (a.txt); `work` (b.txt) is unpushed. */
  w: string;
  real: string;
  fake: string;
  head: string;
  baseId: string;
}
function world(): World {
  const base = tmp();
  const real = join(base, 'real.git');
  const fake = join(base, 'fake.git');
  g(base, 'init', '-q', '--bare', real);
  g(base, 'init', '-q', '--bare', fake);
  const w = join(base, 'w');
  g(base, 'init', '-q', '-b', 'main', w);
  const baseId = commitFile(w, 'a.txt', 'a');
  g(w, 'remote', 'add', 'origin', real);
  g(w, 'push', '-q', 'origin', 'HEAD:main');
  const head = commitFile(w, 'b.txt', 'b');
  return { base, w, real, fake, head, baseId };
}
const owedOf = (x: World, o: Partial<Parameters<typeof deferredDueAtPush>[0]> = {}) =>
  deferredDueAtPush({ cwd: x.w, top: x.w, realTop: x.w, projectDir: x.w, rev: 'HEAD', defaultRemote: pushRemoteOf, testMatch: deferMatcher(['**'], x.w), reviewMatch: deferMatcher([], x.w), passing: [], reviews: [], ...o });

// ── AC-11a ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-11a: the remote\'s own refs say what it has', () => {
  test('the control: the remote has the base commit, so the push sends b.txt', () => {
    const x = world();
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toEqual([[x.baseId]]);
    expect(unpushedFiles(x.w, x.head, [x.baseId])).toEqual(['b.txt']);
    expect(owedOf(x)).toEqual({ test: ['b.txt'], review: [] });
    expect(owedOf(x, { remote: 'origin' })).toEqual({ test: ['b.txt'], review: [] });
  });

  test('a forged remote-tracking ref (`update-ref refs/remotes/origin/x HEAD`) excludes nothing', () => {
    const x = world();
    g(x.w, 'update-ref', 'refs/remotes/origin/x', 'HEAD');
    g(x.w, 'update-ref', 'refs/remotes/other/y', 'HEAD');
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toEqual([[x.baseId]]);
    expect(owedOf(x)).toEqual({ test: ['b.txt'], review: [] });
  });

  test('the push URL is read, not the fetch URL: url=fake (has HEAD), pushurl=real (does not)', () => {
    const x = world();
    g(x.w, 'push', '-q', x.fake, 'HEAD:main');
    g(x.w, 'config', 'remote.origin.url', x.fake);
    expect(owedOf(x)).toBeNull(); // pushing to fake: it has everything
    g(x.w, 'config', 'remote.origin.pushurl', x.real);
    expect(pushUrlsOf(x.w, undefined, pushRemoteOf)).toEqual([x.real]);
    expect(owedOf(x)).toEqual({ test: ['b.txt'], review: [] });
    // `pushInsteadOf` is applied as the push applies it.
    g(x.w, 'config', '--unset', 'remote.origin.pushurl');
    g(x.w, 'config', `url.${x.real}.pushInsteadOf`, x.fake);
    expect(pushUrlsOf(x.w, undefined, pushRemoteOf)).toEqual([x.real]);
    expect(owedOf(x)).toEqual({ test: ['b.txt'], review: [] });
  });

  test('a remote named in the command, a URL and a path are each read as they are', () => {
    const x = world();
    g(x.w, 'push', '-q', x.fake, 'HEAD:main');
    g(x.w, 'remote', 'add', 'mirror', x.fake);
    expect(owedOf(x, { remote: 'mirror' })).toBeNull();
    expect(owedOf(x, { remote: x.fake })).toBeNull();
    expect(owedOf(x, { remote: `file://${x.fake}` })).toBeNull();
    expect(owedOf(x, { remote: x.real })).toEqual({ test: ['b.txt'], review: [] });
    // The default remote the push uses with none named.
    g(x.w, 'config', 'branch.main.remote', 'mirror');
    expect(owedOf(x)).toBeNull();
  });

  test('a repo config a model planted (core.sshCommand) is not run: the remote is read from outside any repo', () => {
    const x = world();
    const marker = join(x.base, 'PWNED');
    g(x.w, 'config', 'core.sshCommand', `touch ${marker}`);
    g(x.w, 'config', 'remote.origin.pushurl', 'ssh://example.invalid/x.git');
    // The premise: git asked from inside the repo does run it.
    Bun.spawnSync(['git', 'ls-remote', '--refs', '--', 'ssh://example.invalid/x.git'], { cwd: x.w, env: process.env as Record<string, string>, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // The check: the remote cannot be read (unknown), and nothing ran.
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(owedOf(x)?.unknown).toBe('git could not read what the remote of the push has (`git ls-remote`; a remote that needs your git or ssh config, or a git older than 2.32, cannot be read)');
    expect(owedOf(x, { remote: 'origin' })?.unknown).toBe('git could not read what the remote origin has (`git ls-remote`; a remote that needs your git or ssh config, or a git older than 2.32, cannot be read)');
    expect(existsSync(marker)).toBe(false);
    // A repo made in the temp dir does not matter either: the read runs from `/`.
    expect(existsSync(join('/', '.git'))).toBe(false);
  });

  test('a transport git does not deem safe (`ext::`) is never run', () => {
    const x = world();
    const marker = join(x.base, 'EXT');
    expect(remoteTips(x.w, `ext::sh -c "touch ${marker}"`, pushRemoteOf)).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  test('a remote that cannot be read (gone, not a repo) is unknown, never "nothing is owed"', () => {
    const x = world();
    g(x.w, 'remote', 'set-url', 'origin', join(x.base, 'gone.git'));
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toBeNull();
    expect(owedOf(x)?.unknown).toContain('could not read what the remote');
    expect(owedOf(x)).toMatchObject({ test: [], review: [] });
    // An empty remote (a new repo) is readable: it has nothing, so every commit is sent.
    const empty = join(x.base, 'empty.git');
    g(x.base, 'init', '-q', '--bare', empty);
    g(x.w, 'remote', 'set-url', 'origin', empty);
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toEqual([[]]);
    expect(owedOf(x)?.test.sort()).toEqual(['a.txt', 'b.txt']);
  });

  test('a remote tip this clone lacks excludes nothing: the commits it does hold count as sent', () => {
    const x = world();
    const other = join(x.base, 'other');
    g(x.base, 'clone', '-q', x.real, other);
    g(other, 'checkout', '-q', '-b', 'main', 'origin/main');
    const theirs = commitFile(other, 'c.txt', 'c');
    g(other, 'push', '-q', 'origin', 'HEAD:main'); // the remote moved on: its tip is a commit x.w does not have
    expect(Bun.spawnSync(['git', 'cat-file', '-e', theirs], { cwd: x.w }).exitCode).not.toBe(0);
    g(other, 'push', '-q', 'origin', `${x.baseId}:refs/heads/old`); // and a branch at a commit it does have
    const tips = remoteTips(x.w, undefined, pushRemoteOf)![0]!;
    expect(tips).toEqual([x.baseId]);
    expect(tips).not.toContain(theirs);
    expect(owedOf(x)).toEqual({ test: ['b.txt'], review: [] });
    // Tags count too (annotated or not), as long as this repo holds them.
    g(x.w, 'tag', '-a', '-m', 'v', 'v1', x.head);
    g(x.w, 'push', '-q', 'origin', 'v1');
    expect(remoteTips(x.w, undefined, pushRemoteOf)![0]).toContain(g(x.w, 'rev-parse', 'v1'));
    expect(owedOf(x)).toBeNull(); // the tag's commit is on the remote now
  });

  test('a file edited only inside a merge commit is listed (a combined diff)', () => {
    const x = world();
    g(x.w, 'checkout', '-q', '-b', 'side', x.baseId);
    commitFile(x.w, 's.txt', 's');
    g(x.w, 'checkout', '-q', 'main');
    // main has b.txt (unpushed); the merge brings s.txt and the model edits x.txt inside the merge commit only.
    g(x.w, 'merge', '-q', '--no-commit', '--no-ff', 'side');
    const merged = commitFile(x.w, 'x.txt', 'evil');
    expect(g(x.w, 'log', '--format=', '--name-only', '-1', merged)).toBe(''); // `git log`'s default shows no diff for a merge
    expect(unpushedFiles(x.w, merged, [x.baseId])?.sort()).toEqual(['b.txt', 's.txt', 'x.txt']); // s.txt is the side commit's own
    expect(owedOf(x, { rev: merged, testMatch: deferMatcher(['x.txt'], x.w) })).toEqual({ test: ['x.txt'], review: [] });
  });

  test('more than MAX_PUSH_FILES still hints at a fetch', () => {
    const x = world();
    const out = owedOf(x, { files: () => null });
    expect(out?.unknown).toBe(`git could not list the files HEAD sends, or they are more than ${MAX_PUSH_FILES} (when the remote has commits this clone lacks, \`git fetch\` first)`);
  });
});

// ── AC-11b ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-11b: pushUrlsOf', () => {
  test('a named remote gives its push URL (a path made absolute), a URL stays, a relative path is made absolute from the repo', () => {
    const x = world();
    expect(pushUrlsOf(x.w, 'origin', pushRemoteOf)).toEqual([x.real]);
    expect(pushUrlsOf(x.w, undefined, pushRemoteOf)).toEqual([x.real]);
    for (const url of ['https://example.com/x.git', 'ssh://git@example.com/x.git', 'git@example.com:x/y.git', 'file:///srv/x.git']) {
      expect([url, pushUrlsOf(x.w, url, pushRemoteOf)]).toEqual([url, [url]]);
    }
    expect(pushUrlsOf(x.w, 'sub/dir.git', pushRemoteOf)).toEqual([resolve(x.w, 'sub/dir.git')]);
    expect(pushUrlsOf(x.w, '../elsewhere.git', pushRemoteOf)).toEqual([resolve(x.w, '../elsewhere.git')]);
    // A configured remote whose URL is relative: made absolute from the repo's dir.
    g(x.w, 'config', 'remote.rel.url', '../real.git');
    expect(pushUrlsOf(x.w, 'rel', pushRemoteOf)).toEqual([resolve(x.w, '../real.git')]);
    // A name that is no configured remote is a path, as git reads it.
    expect(pushUrlsOf(x.w, 'nosuch', pushRemoteOf)).toEqual([resolve(x.w, 'nosuch')]);
  });

  test('an option-like name, a name with a control character, and a URL that holds one are refused', () => {
    const x = world();
    for (const bad of ['--upload-pack=touch x', '-x', '--receive-pack=evil', '']) {
      expect([bad, pushUrlsOf(x.w, bad, pushRemoteOf)]).toEqual([bad, null]);
    }
    expect(pushUrlsOf(x.w, 'a\nb', pushRemoteOf)).toBeNull();
    expect(pushUrlsOf(x.w, 'https://h/x\n.git', pushRemoteOf)).toBeNull();
    expect(pushUrlsOf(x.w, 'https://h/x\r.git', pushRemoteOf)).toBeNull();
    // A configured remote whose push URL starts with a dash.
    g(x.w, 'config', 'remote.dash.url', '-oProxyCommand=evil');
    expect(pushUrlsOf(x.w, 'dash', pushRemoteOf)).toBeNull();
    // A name that git reads as an option (`git push -evil` is "unknown switch `e'") is refused even when a rewrite rule
    //   would turn it into a plain path: the name itself is the refusal, not only the URL it ends in.
    g(x.w, 'config', `url.${x.real}.insteadOf`, '-evil');
    expect(pushRewrite(x.w, '-evil')).toBe(x.real);
    expect(pushUrlsOf(x.w, '-evil', pushRemoteOf)).toBeNull();
    expect(pushUrlsOf(x.w, undefined, () => '-evil')).toBeNull();
    // A default remote that is an option, whatever it is called.
    expect(pushUrlsOf(x.w, undefined, () => '--upload-pack=x')).toBeNull();
    expect(remoteTips(x.w, '--upload-pack=touch x', pushRemoteOf)).toBeNull();
  });

  test('no remote named and the default remote not configured: null (git would not push)', () => {
    const d = tmp();
    g(d, 'init', '-q', '-b', 'main');
    expect(pushUrlsOf(d, undefined, pushRemoteOf)).toBeNull();
    expect(pushUrlsOf(d, undefined, () => 'upstream')).toBeNull();
    expect(remoteTips(d, undefined, pushRemoteOf)).toBeNull();
    // Named in the command, it is whatever git is given.
    expect(pushUrlsOf(d, 'upstream', pushRemoteOf)).toEqual([resolve(d, 'upstream')]);
  });
});

// ── AC-11c ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-11c: the remote of the hand-off', () => {
  const rules = { allow: [], production: [] };
  test('`git push <remote> …` carries its remote; `git push` carries none', () => {
    const x = world();
    const one = (cmd: string) => handoffsOf(cmd, x.w, rules)[0]!;
    expect(one('git push origin main')).toMatchObject({ kind: 'push', remote: 'origin', revs: ['main'] });
    expect(one('git push -u upstream feature')).toMatchObject({ remote: 'upstream', revs: ['feature'] });
    expect(one('git push origin')).toMatchObject({ remote: 'origin', revs: ['HEAD'] });
    expect(one('git push https://example.com/x.git main')).toMatchObject({ remote: 'https://example.com/x.git' });
    const bare = one('git push');
    expect(bare).toMatchObject({ kind: 'push', revs: ['HEAD'] });
    expect(Object.hasOwn(bare, 'remote')).toBe(false);
  });

  test('pushRemoteOf: branch.<b>.pushRemote, then remote.pushDefault, then branch.<b>.remote, then origin', () => {
    const d = tmp();
    g(d, 'init', '-q', '-b', 'main');
    commitFile(d, 'a.txt', 'a');
    expect(pushRemoteOf(d)).toBe('origin');
    g(d, 'config', 'branch.main.remote', 'tracked');
    expect(pushRemoteOf(d)).toBe('tracked');
    g(d, 'config', 'remote.pushDefault', 'dflt');
    expect(pushRemoteOf(d)).toBe('dflt');
    g(d, 'config', 'branch.main.pushRemote', 'special');
    expect(pushRemoteOf(d)).toBe('special');
    // Another branch has none of the branch's own: the shared default.
    g(d, 'checkout', '-q', '-b', 'other');
    expect(pushRemoteOf(d)).toBe('dflt');
    // A detached HEAD has no branch.
    g(d, 'checkout', '-q', '--detach');
    expect(pushRemoteOf(d)).toBe('dflt');
    g(d, 'config', '--unset', 'remote.pushDefault');
    g(d, 'config', '--unset', 'branch.main.remote');
    expect(pushRemoteOf(d)).toBe('origin');
    // An empty value is skipped (it names no remote).
    g(d, 'checkout', '-q', 'main');
    g(d, 'config', 'branch.main.pushRemote', '');
    g(d, 'config', 'remote.pushDefault', '');
    g(d, 'config', 'branch.main.remote', 'tracked');
    expect(pushRemoteOf(d)).toBe('tracked');
  });
});

// ── AC-11e ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-11e: no program of the user\'s config runs in the remote read', () => {
  /** `env` set on the process for the call (the in-process git reads it), undone after. */
  function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  /** A plain `git ls-remote` of an ssh URL as git runs it for a user: the planted program runs. */
  const plain = (cwd: string): void => {
    Bun.spawnSync(['git', 'ls-remote', '--refs', '--', 'ssh://host.invalid/x.git'], { cwd, env: process.env as Record<string, string>, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
  };

  test('a global core.sshCommand (a model can write ~/.gitconfig) is not run', () => {
    const x = world();
    const marker = join(x.base, 'GLOBAL-SSH');
    const cfg = join(x.base, 'gitconfig');
    writeFileSync(cfg, `[core]\n\tsshCommand = touch ${marker} #\n`);
    withEnv({ GIT_CONFIG_GLOBAL: cfg }, () => {
      plain(x.w);
      expect(existsSync(marker)).toBe(true); // the premise: it runs when git reads that config
      rmSync(marker);
      expect(remoteTips(x.w, 'ssh://host.invalid/x.git', pushRemoteOf)).toBeNull();
      expect(owedOf(x, { remote: 'ssh://host.invalid/x.git' })?.unknown).toContain('could not read what the remote');
    });
    expect(existsSync(marker)).toBe(false);
  });

  test('a system config the user can write (GIT_CONFIG_SYSTEM) is not trusted, and its program is not run', () => {
    const x = world();
    const marker = join(x.base, 'SYSTEM-SSH');
    const cfg = join(x.base, 'system-gitconfig');
    writeFileSync(cfg, `[core]\n\tsshCommand = touch ${marker} #\n`);
    const link = join(x.base, 'system-link');
    symlinkSync(cfg, link);
    for (const file of [cfg, link]) {
      withEnv({ GIT_CONFIG_SYSTEM: file, GIT_CONFIG_NOSYSTEM: undefined }, () => {
        expect([file, systemConfigTrusted()]).toEqual([file, false]); // owned by this user, not root
        plain(x.w);
        expect([file, existsSync(marker)]).toEqual([file, true]);
        rmSync(marker);
        expect(remoteTips(x.w, 'ssh://host.invalid/x.git', pushRemoteOf)).toBeNull();
      });
      expect([file, existsSync(marker)]).toEqual([file, false]);
    }
  });

  test('no system config at all is not "trusted" (nothing to keep)', () => {
    withEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: undefined }, () => expect(systemConfigTrusted()).toBe(false));
  });
});

// ── AC-11f ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-11f: the URL a push goes to, as git rewrites it', () => {
  const rules = (cfg: Record<string, string>): string => {
    const d = tmp();
    g(d, 'init', '-q', '-b', 'main');
    for (const [k, v] of Object.entries(cfg)) g(d, 'config', '--add', k, v);
    return d;
  };

  test('pushRewrite: the longest pushInsteadOf, else the longest insteadOf, else the URL itself', () => {
    const none = rules({});
    expect(pushRewrite(none, 'https://h.example/team/x.git')).toBe('https://h.example/team/x.git');
    const d = rules({
      'url.https://a.example/.insteadOf': 'https://h.example/',
      'url.https://b.example/.insteadOf': 'https://h.example/team/',
      'url.https://push.example/.pushInsteadOf': 'https://h.example/',
    });
    // A pushInsteadOf rule wins over every insteadOf one, whatever the lengths.
    expect(pushRewrite(d, 'https://h.example/team/x.git')).toBe('https://push.example/team/x.git');
    const only = rules({
      'url.https://a.example/.insteadOf': 'https://h.example/',
      'url.https://b.example/.insteadOf': 'https://h.example/team/',
    });
    // Among insteadOf rules the longest prefix wins; a URL under no prefix stays.
    expect(pushRewrite(only, 'https://h.example/team/x.git')).toBe('https://b.example/x.git');
    expect(pushRewrite(only, 'https://h.example/other/x.git')).toBe('https://a.example/other/x.git');
    expect(pushRewrite(only, 'https://elsewhere.example/x.git')).toBe('https://elsewhere.example/x.git');
    // Among pushInsteadOf rules, too.
    const pushes = rules({ 'url.P1.pushInsteadOf': '/srv/', 'url.P2.pushInsteadOf': '/srv/mirror/' });
    expect(pushRewrite(pushes, '/srv/mirror/x.git')).toBe('P2x.git');
    expect(pushRewrite(pushes, '/srv/y.git')).toBe('P1y.git');
    // An empty prefix is a prefix of every URL, as git reads it (`url.<x>.pushInsteadOf ''` sends `git push . main` to <x>).
    const empty = rules({ 'url.https://z.example/.insteadOf': '' });
    expect(pushRewrite(empty, 'https://h.example/x.git')).toBe('https://z.example/https://h.example/x.git');
    expect(pushRewrite(empty, '.')).toBe('https://z.example/.');
    // A longer real prefix still wins over the empty one.
    const both = rules({ 'url.https://z.example/.insteadOf': '', 'url.https://y.example/.insteadOf': 'https://h.example/' });
    expect(pushRewrite(both, 'https://h.example/x.git')).toBe('https://y.example/x.git');
    // A rule of another kind in the same section is no rewrite.
    const other = rules({ 'url.https://z.example/.pushurl': 'https://h.example/' });
    expect(pushRewrite(other, 'https://h.example/x.git')).toBe('https://h.example/x.git');
  });

  test('pushRewrite: git cannot list the rules (no such dir): null', () => {
    expect(pushRewrite(join(tmp(), 'no-such-dir'), 'https://h.example/x.git')).toBeNull();
  });

  test('a mirror path plus `url.<real>.pushInsteadOf=<mirror>`: the push goes to the real remote, and its tips are read', () => {
    const x = world();
    const mirror = join(x.base, 'mirror.git');
    g(x.base, 'clone', '-q', '--bare', x.real, mirror);
    g(x.w, 'push', '-q', mirror, 'HEAD:main'); // the mirror has every commit; the real remote lacks b.txt's commit
    expect(owedOf(x, { remote: mirror })).toBeNull(); // no rule: the mirror is where it goes
    g(x.w, 'config', `url.${x.real}.pushInsteadOf`, mirror);
    expect(pushUrlsOf(x.w, mirror, pushRemoteOf)).toEqual([x.real]);
    expect(owedOf(x, { remote: mirror })).toEqual({ test: ['b.txt'], review: [] });
    // A configured remote goes through `remote get-url --push`, which applies the same rules.
    g(x.w, 'remote', 'add', 'viamirror', mirror);
    expect(pushUrlsOf(x.w, 'viamirror', pushRemoteOf)).toEqual([x.real]);
  });

  test('an empty pushInsteadOf value sends `git push . main` to the rewrite target: its tips are read, not the repo\'s own', () => {
    const x = world();
    expect(owedOf(x, { remote: '.' })).toBeNull(); // no rule: `.` is this repo, which has every commit
    g(x.w, 'config', `url.${x.real}/.pushInsteadOf`, '');
    expect(owedOf(x, { remote: '.' })).toEqual({ test: ['b.txt'], review: [] });
  });

  test('inline `-c url.*`, `-c remote.<name>.url`/`pushurl` (dotted names too) and `-c branch.<b>.remote` make the hand-off unclear (the push may go elsewhere than the repo says)', () => {
    const x = world();
    const rules = { allow: [], production: [] };
    for (const cmd of [
      `git -c url.${x.real}.pushInsteadOf=${x.fake} push ${x.fake} main`,
      `git -c url.${x.real}.insteadOf=${x.fake} push ${x.fake} main`,
      `git -c remote.origin.url=${x.fake} push origin main`,
      'git -c remote.origin.url=/x push',
    ]) {
      const h = handoffsOf(cmd, x.w, rules)[0]!;
      expect([cmd, h.kind, h.unclear ?? '']).toEqual([cmd, 'push', expect.stringContaining('inline config')]);
    }
    // Dotted remote names, `pushurl` and a branch's remote (the default remote of a push naming none) decide it too.
    for (const cmd of [
      `git -c remote.origin.backup.url=${x.fake} push origin.backup main`,
      `git -c remote.a.b.pushurl=${x.fake} push a.b main`,
      `git -c remote.a.pushurl=${x.fake} push a main`,
      `git -c branch.main.remote=${x.fake} push`,
      `git -c branch.feat.x.remote=${x.fake} push`,
    ]) {
      const h = handoffsOf(cmd, x.w, rules)[0]!;
      expect([cmd, h.kind, h.unclear ?? '']).toEqual([cmd, 'push', expect.stringContaining('`-c branch.*.remote`')]);
    }
    // A dotted remote name's `push`/`mirror` decides which refs go.
    for (const cmd of ['git -c remote.a.b.push=refs/heads/*:refs/heads/* push a.b', 'git -c remote.a.b.mirror=true push a.b', 'git -c branch.x.y.pushremote=a push']) {
      expect([cmd, handoffsOf(cmd, x.w, rules)[0]!.unclear]).toEqual([cmd, 'git config decides which refs it pushes']);
    }
    // The controls: keys that decide neither stay judged normally.
    for (const key of ['remote.origin.fetch=+refs/heads/*:refs/remotes/origin/*', 'branch.main.merge=refs/heads/main', 'remote.origin.urlx=1', 'remote.origin.tagopt=--no-tags']) {
      const h = handoffsOf(`git -c ${key} push origin main`, x.w, rules)[0]!;
      expect([key, h.unclear, h.remote, h.revs]).toEqual([key, undefined, 'origin', ['main']]);
    }
    // The control: no such key, a checkable push.
    expect(handoffsOf('git -c core.quotepath=off push origin main', x.w, rules)[0]).toMatchObject({ revs: ['main'], remote: 'origin' });
    expect(handoffsOf('git -c core.quotepath=off push origin main', x.w, rules)[0]!.unclear).toBeUndefined();
  });
});

// ── AC-11d ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-11d: spawnGit remoteRead', () => {
  /** A `git` first on PATH that records the environment that matters, then runs the real one. */
  function recorder(): { log: () => string[] } {
    const real = Bun.which('git', { PATH: process.env.PATH })!;
    const dir = tmp('goodboy-n8br-bin-');
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    writeFileSync(join(dir, 'git'), `#!/bin/sh\nprintf 'ALLOW=%s PROMPT=%s GLOBAL=%s NOSYSTEM=%s SSH=%s VARIANT=%s ASK=%s SASK=%s SREQ=%s GSSH=%s PROXY=%s CC=%s K0=%s V0=%s PARAMS=%s ARGS=%s\\n' "$GIT_ALLOW_PROTOCOL" "$GIT_TERMINAL_PROMPT" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_NOSYSTEM" "$GIT_SSH_COMMAND" "$GIT_SSH_VARIANT" "$GIT_ASKPASS" "$SSH_ASKPASS" "$SSH_ASKPASS_REQUIRE" "$GIT_SSH" "$GIT_PROXY_COMMAND" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" "$GIT_CONFIG_PARAMETERS" "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`);
    chmodSync(join(dir, 'git'), 0o755);
    restorePath.push(process.env.PATH!);
    process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
    return { log: () => readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('ls-remote')) };
  }

  test('a normal call allows no transport; a remoteRead call allows file, git, http, https and ssh, and never prompts', () => {
    const x = world();
    const rec = recorder();
    spawnGit('/', ['ls-remote', '--', x.real]);
    spawnGit('/', ['ls-remote', '--', x.real], { remoteRead: true });
    spawnGit('/', ['ls-remote', '--', x.real], { remoteRead: 'system' });
    const [normal, remote, system] = rec.log();
    expect(normal).toContain('ALLOW=goodboy-none');
    expect(normal).toContain('PROMPT=1'); // the process's own value: a normal call leaves it alone
    expect(normal).not.toContain('SSH=ssh -F /dev/null');
    expect(remote).toContain('ALLOW=file:git:http:https:ssh');
    expect(remote).toContain('PROMPT=0');
    // No user or system git config, and ssh with no config file and no prompt.
    expect(remote).toContain('GLOBAL=/dev/null NOSYSTEM=1');
    expect(remote).toContain('SSH=ssh -F /dev/null -o BatchMode=yes VARIANT=ssh');
    // `'system'` keeps the system config (only the machine's own, root-owned one is asked for) and nothing else.
    expect(system).toContain('GLOBAL=/dev/null NOSYSTEM= ');
    expect(system).toContain('SSH=ssh -F /dev/null -o BatchMode=yes VARIANT=ssh');
    expect(system).toContain('PROMPT=0');
  });

  test('a remoteRead call drops the inherited names that run a program or add config; a normal call keeps its environment', () => {
    const x = world();
    const evil = { GIT_ASKPASS: '/bin/true', SSH_ASKPASS: '/bin/true', SSH_ASKPASS_REQUIRE: 'force', GIT_SSH: '/bin/true', GIT_PROXY_COMMAND: '/bin/true', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'planted', GIT_CONFIG_PARAMETERS: "'user.email=planted@x'" };
    const saved = Object.fromEntries(Object.keys(evil).map((k) => [k, process.env[k]]));
    Object.assign(process.env, evil);
    try {
      const rec = recorder();
      spawnGit('/', ['ls-remote', '--', x.real]);
      spawnGit('/', ['ls-remote', '--', x.real], { remoteRead: true });
      spawnGit('/', ['ls-remote', '--', x.real], { remoteRead: 'system' });
      const [normal, remote, system] = rec.log();
      expect(normal).toContain('ASK=/bin/true');
      expect(normal).toContain('CC=1');
      for (const line of [remote, system]) {
        expect(line).toContain('ASK= SASK= SREQ= GSSH= PROXY= CC= K0= V0= PARAMS= ');
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('the effect: a local remote is unreachable by a normal call and readable by a remoteRead call; ext:: is neither', () => {
    const x = world();
    expect(spawnGit('/', ['ls-remote', '--refs', '--', x.real]).code).not.toBe(0);
    const ok = spawnGit('/', ['ls-remote', '--refs', '--', x.real], { remoteRead: true });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain(x.baseId);
    const marker = join(x.base, 'EXT2');
    expect(spawnGit('/', ['ls-remote', '--', `ext::sh -c "touch ${marker}"`], { remoteRead: true }).code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test('a remoteRead answer is never kept for the Stop: asked again, it is read again', () => {
    const x = world();
    beginGitSnapshot();
    const before = spawnGit('/', ['ls-remote', '--refs', '--', x.real], { remoteRead: true });
    expect(before.out).not.toContain(x.head);
    g(x.w, 'push', '-q', 'origin', 'HEAD:main');
    const after = spawnGit('/', ['ls-remote', '--refs', '--', x.real], { remoteRead: true });
    expect(after.out).toContain(x.head);
    // `ls-remote` is no kept kind, so that check alone cannot tell a kept remoteRead answer: a call of a kept kind
    //   (`rev-parse HEAD`) made with `remoteRead` is read again too, though the same call without it is kept.
    const tip = spawnGit(x.w, ['rev-parse', 'HEAD'], { remoteRead: true });
    expect(tip.out.trim()).toBe(x.head);
    const next = commitFile(x.w, 'c.txt', 'c');
    expect(spawnGit(x.w, ['rev-parse', 'HEAD'], { remoteRead: true }).out.trim()).toBe(next);
    // The control: an ordinary immutable answer is kept within the snapshot (the call is the same twice, even
    //   after the commit it names moved on).
    const first = spawnGit(x.w, ['rev-parse', 'HEAD']);
    const second = spawnGit(x.w, ['rev-parse', 'HEAD']);
    expect(second).toBe(first);
    commitFile(x.w, 'd.txt', 'd');
    expect(spawnGit(x.w, ['rev-parse', 'HEAD'])).toBe(first);
  });
});

// ── AC-11g: every URL of the remote ─────────────────────────────────────────────────────────────

describe('AC-11g: a remote with several push URLs is pushed to each', () => {
  /** `fake` (which holds every commit) first, `real` (which lacks the unpushed ones) second. */
  function mirrored(key: 'pushurl' | 'url'): World {
    const x = world();
    g(x.w, 'push', '-q', x.fake, 'HEAD:main');
    g(x.w, 'config', '--unset-all', 'remote.origin.url');
    if (key === 'pushurl') g(x.w, 'config', 'remote.origin.url', x.real);
    g(x.w, 'config', '--add', `remote.origin.${key}`, x.fake);
    g(x.w, 'config', '--add', `remote.origin.${key}`, x.real);
    return x;
  }

  for (const key of ['pushurl', 'url'] as const) {
    test(`two remote.origin.${key} (the mirror holds the commits first, the real remote lacks them): the file is owed`, () => {
      const x = mirrored(key);
      expect(pushUrlsOf(x.w, undefined, pushRemoteOf)).toEqual([x.fake, x.real]);
      expect(pushUrlsOf(x.w, 'origin', pushRemoteOf)).toEqual([x.fake, x.real]);
      expect(remoteTips(x.w, undefined, pushRemoteOf)).toEqual([[x.head], [x.baseId]]);
      expect(owedOf(x)).toEqual({ test: ['b.txt'], review: [] });
      expect(owedOf(x, { remote: 'origin' })).toEqual({ test: ['b.txt'], review: [] });
    });
  }

  test('the control: every URL holds the commits, so nothing is owed; the same URL twice is read once', () => {
    const x = mirrored('pushurl');
    g(x.w, 'push', '-q', x.real, 'HEAD:main');
    expect(owedOf(x)).toBeNull();
    g(x.w, 'config', '--unset-all', 'remote.origin.pushurl');
    g(x.w, 'config', '--add', 'remote.origin.pushurl', x.fake);
    g(x.w, 'config', '--add', 'remote.origin.pushurl', x.fake);
    expect(pushUrlsOf(x.w, undefined, pushRemoteOf)).toEqual([x.fake]);
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toEqual([[x.head]]);
  });

  test('the files are the union over the URLs: the one URL that lacks a file makes it owed, whichever it is (first or second)', () => {
    // Both URLs hold b.txt's commit; then c.txt's commit goes to one of them only.
    const first = mirrored('pushurl'); // [fake, real]
    g(first.w, 'push', '-q', first.real, 'HEAD:main');
    commitFile(first.w, 'c.txt', 'c');
    g(first.w, 'push', '-q', first.real, 'HEAD:main'); // the second URL has c; the first lacks it
    expect(owedOf(first)).toEqual({ test: ['c.txt'], review: [] });
    const second = mirrored('pushurl');
    g(second.w, 'push', '-q', second.real, 'HEAD:main');
    commitFile(second.w, 'c.txt', 'c');
    g(second.w, 'push', '-q', second.fake, 'HEAD:main'); // the first URL has c; the second lacks it
    expect(owedOf(second)).toEqual({ test: ['c.txt'], review: [] });
  });

  test('the seam: files from every distinct tip set are joined, a tip set that cannot be listed is unknown, more than MAX_PUSH_FILES in the union is unknown', () => {
    const x = world();
    const seen: string[][] = [];
    const out = owedOf(x, {
      tips: () => [[x.baseId], [x.baseId], [x.head]],
      files: (_c, _h, tips) => {
        seen.push([...tips]);
        return tips[0] === x.baseId ? ['b.txt'] : ['a.txt'];
      },
    });
    expect(seen).toEqual([[x.baseId], [x.head]]); // the repeated tip set is listed once
    expect(out).toEqual({ test: ['b.txt', 'a.txt'], review: [] });
    expect(owedOf(x, { tips: () => [[x.baseId], [x.head]], files: (_c, _h, tips) => (tips[0] === x.head ? null : ['b.txt']) })?.unknown).toContain('could not list the files');
    const half = Array.from({ length: Math.floor(MAX_PUSH_FILES / 2) + 1 }, (_, i) => `f${i}.txt`);
    const other = Array.from({ length: Math.floor(MAX_PUSH_FILES / 2) + 1 }, (_, i) => `g${i}.txt`);
    expect(owedOf(x, { tips: () => [[x.baseId], [x.head]], files: (_c, _h, tips) => (tips[0] === x.head ? other : half) })?.unknown).toContain('more than');
  });
});

// ── AC-11h: where a relative URL is resolved from ───────────────────────────────────────────────

describe('AC-11h: a relative URL is resolved from the work tree\'s top', () => {
  /** The clone with a subdir, and a decoy bare repo at `<subdir>/../real.git`, i.e. `<top>/real.git`, that holds every commit. */
  function withDecoy(): { x: World; sub: string; decoy: string } {
    const x = world();
    const sub = join(x.w, 'sub');
    mkdirSync(sub);
    const decoy = join(x.w, 'real.git');
    g(x.base, 'init', '-q', '--bare', decoy);
    g(x.w, 'push', '-q', decoy, 'HEAD:main');
    return { x, sub, decoy };
  }

  test('a configured relative URL, asked from a subdir, is the real remote (resolved from the top), not the decoy at <subdir>/<path>', () => {
    const { x, sub } = withDecoy();
    g(x.w, 'config', 'remote.rel.url', '../real.git'); // from the top (x.w): <base>/real.git
    expect(pushUrlsOf(sub, 'rel', pushRemoteOf)).toEqual([x.real]);
    expect(pushUrlsOf(x.w, 'rel', pushRemoteOf)).toEqual([x.real]);
    expect(remoteTips(sub, 'rel', pushRemoteOf)).toEqual([[x.baseId]]);
    expect(owedOf(x, { cwd: sub, remote: 'rel' })).toEqual({ test: ['b.txt'], review: [] });
  });

  test('a relative path on the command line is resolved the same way', () => {
    const { x, sub } = withDecoy();
    expect(pushUrlsOf(sub, '../real.git', pushRemoteOf)).toEqual([x.real]);
    expect(owedOf(x, { cwd: sub, remote: '../real.git' })).toEqual({ test: ['b.txt'], review: [] });
    // The git that makes the push resolves it from the top too (the fact this rests on).
    g(sub, 'push', '-q', '../real.git', 'HEAD:refs/heads/probe');
    expect(g(x.real.replace(/real\.git$/, ''), 'ls-remote', '--refs', x.real)).toContain('refs/heads/probe');
  });

  test('a bare repo has no work tree: its own dir is the base', () => {
    const x = world();
    const b = join(x.base, 'bare.git');
    g(x.base, 'clone', '-q', '--bare', x.w, b);
    g(b, 'config', 'remote.rel.url', 'sibling.git');
    expect(pushUrlsOf(b, 'rel', pushRemoteOf)).toEqual([join(b, 'sibling.git')]);
  });
});

// ── AC-11i: git older than 2.32 ─────────────────────────────────────────────────────────────────

describe('AC-11i: a git that ignores GIT_CONFIG_GLOBAL cannot make a remote read', () => {
  const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
  const REAL_GIT = Bun.which('git') ?? 'git';

  /** `gitHonorsConfigGlobal()` and `remoteTips` of `cwd` in a fresh process (the answer is kept per process) whose `git`
   *  reports `version` and otherwise is the real git. */
  function asked(cwd: string, version: string): { honors: boolean; tips: string[][] | null } {
    const bin = tmp();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do if [ "$a" = version ]; then echo "git version ${version}"; exit 0; fi; done\nexec "${REAL_GIT}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const script = join(tmp(), 'ask.ts');
    writeFileSync(
      script,
      `import { gitHonorsConfigGlobal, remoteTips } from ${JSON.stringify(join(ROOT, 'lib', 'deferral.ts'))};\n` +
        `import { pushRemoteOf } from ${JSON.stringify(join(ROOT, 'lib', 'push-test.ts'))};\n` +
        `console.log(JSON.stringify({ honors: gitHonorsConfigGlobal(), tips: remoteTips(process.argv[2]!, undefined, pushRemoteOf) }));\n`,
    );
    const p = Bun.spawnSync([process.execPath, script, cwd], {
      cwd,
      env: { ...(process.env as Record<string, string>), PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return JSON.parse(p.stdout.toString().trim().split('\n').pop()!);
  }

  test('2.31 and older: the remote is not read (null) though it is reachable; 2.32 and newer: it is', () => {
    const x = world();
    for (const old of ['2.31.0', '2.31.9', '2.9.5', '1.9.1', 'garbage']) {
      expect([old, asked(x.w, old)]).toEqual([old, { honors: false, tips: null }]);
    }
    for (const fresh of ['2.32.0', '2.32.0.windows.1', '2.45.1', '3.0.0', '10.1.0']) {
      expect([fresh, asked(x.w, fresh)]).toEqual([fresh, { honors: true, tips: [[x.baseId]] }]);
    }
  });

  test('the real git here honors it (the control the fake versions are measured against)', () => {
    expect(gitHonorsConfigGlobal()).toBe(true);
  });

  test('an unreadable remote or an old git is told to the user with the same words', () => {
    const x = world();
    const out = owedOf(x, { tips: () => null });
    expect(out?.unknown).toContain('a remote that needs your git or ssh config, or a git older than 2.32, cannot be read');
  });
});

// ── AC-11j: one unreadable URL ──────────────────────────────────────────────────────────────────

describe('AC-11j: one URL that cannot be read makes the whole answer unknown', () => {
  test('a readable URL and an unreadable one, in either order: null (the readable one stands in for nothing)', () => {
    const x = world();
    const gone = join(x.base, 'gone.git');
    const orders = [[x.real, gone], [gone, x.real]];
    orders.forEach((order, i) => {
      const name = `two${i}`;
      for (const u of order) g(x.w, 'config', '--add', `remote.${name}.pushurl`, u);
      expect([order, pushUrlsOf(x.w, name, pushRemoteOf)]).toEqual([order, order]);
      expect([order, remoteTips(x.w, name, pushRemoteOf)]).toEqual([order, null]);
      expect(owedOf(x, { remote: name })?.unknown).toContain('git could not read what the remote');
    });
  });

  test('the guards: a rewrite that yields nothing (`url..insteadOf`), and a remote whose url is empty (get-url prints nothing), are null', () => {
    const x = world();
    g(x.w, 'config', 'url..insteadOf', 'xx:');
    expect(pushRewrite(x.w, 'xx:')).toBe('');
    expect(pushUrlsOf(x.w, 'xx:', pushRemoteOf)).toBeNull();
    g(x.w, 'config', 'remote.e.url', '');
    expect(spawnGit(x.w, ['remote', 'get-url', '--push', '--all', 'e']).out.trim()).toBe('');
    expect(pushUrlsOf(x.w, 'e', pushRemoteOf)).toBeNull();
    expect(remoteTips(x.w, 'e', pushRemoteOf)).toBeNull();
  });

  test('a URL that is refused (an option, a line break) among good ones makes the URL list null', () => {
    const x = world();
    g(x.w, 'config', '--add', 'remote.origin.pushurl', x.real);
    g(x.w, 'config', '--add', 'remote.origin.pushurl', '-oProxyCommand=evil');
    expect(pushUrlsOf(x.w, undefined, pushRemoteOf)).toBeNull();
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toBeNull();
  });
});

// ── AC-11k: a URL git expands from a home dir ───────────────────────────────────────────────────

describe('AC-11k: a `~` URL is expanded by git from $HOME, which the push\'s own command can set: unknown', () => {
  /** A decoy bare repo at `<top>/~/origin.git` that holds every commit (where a `~/origin.git` resolved under the top lands). */
  function decoyed(): World {
    const x = world();
    mkdirSync(join(x.w, '~'));
    const decoy = join(x.w, '~', 'origin.git');
    g(x.base, 'init', '-q', '--bare', decoy);
    g(x.w, 'push', '-q', decoy, 'HEAD:main');
    return x;
  }

  test('the fact this rests on: git reads `~/real.git` from $HOME, not from the work tree', () => {
    const x = decoyed();
    const env = { ...(process.env as Record<string, string>), HOME: x.base };
    const ls = Bun.spawnSync(['git', 'ls-remote', '--refs', '--', '~/real.git'], { cwd: x.w, env, stdout: 'pipe', stderr: 'pipe' });
    expect(ls.exitCode).toBe(0);
    expect(ls.stdout.toString()).toContain(x.baseId); // x.real is <base>/real.git, not the decoy <top>/~/real.git
  });

  test('a configured remote.origin.url of `~/origin.git` (with the decoy that holds the commits): null, unknown', () => {
    const x = decoyed();
    g(x.w, 'config', 'remote.origin.url', '~/origin.git');
    expect(pushUrlsOf(x.w, undefined, pushRemoteOf)).toBeNull();
    expect(pushUrlsOf(x.w, 'origin', pushRemoteOf)).toBeNull();
    expect(remoteTips(x.w, undefined, pushRemoteOf)).toBeNull();
    const out = owedOf(x);
    expect(out?.unknown).toContain('git could not read what the remote of the push has');
    expect(out?.test).toEqual([]);
  });

  test('a `~/x.git` or `~user/x.git` on the command line, a pushurl, and a rewrite that ends in one are all unknown; one of several URLs is enough', () => {
    const x = decoyed();
    for (const named of ['~/origin.git', '~user/origin.git', '~', '~/']) {
      expect([named, pushUrlsOf(x.w, named, pushRemoteOf)]).toEqual([named, null]);
      expect([named, remoteTips(x.w, named, pushRemoteOf)]).toEqual([named, null]);
      expect([named, owedOf(x, { remote: named })?.unknown !== undefined]).toEqual([named, true]);
    }
    g(x.w, 'config', 'remote.origin.pushurl', '~/origin.git');
    expect(pushUrlsOf(x.w, 'origin', pushRemoteOf)).toBeNull();
    g(x.w, 'config', '--unset-all', 'remote.origin.pushurl');
    g(x.w, 'config', '--add', 'remote.origin.pushurl', x.real);
    g(x.w, 'config', '--add', 'remote.origin.pushurl', '~user/origin.git');
    expect(pushUrlsOf(x.w, 'origin', pushRemoteOf)).toBeNull();
    g(x.w, 'config', `url.~/origin.git.insteadOf`, 'mirror:');
    expect(pushUrlsOf(x.w, 'mirror:', pushRemoteOf)).toBeNull();
  });

  test('the control: a tilde that is not the first character, `./~/x.git` and a URL with `~` in it are not home-relative', () => {
    const x = decoyed();
    expect(pushUrlsOf(x.w, './~/origin.git', pushRemoteOf)).toEqual([join(x.w, '~', 'origin.git')]);
    expect(pushUrlsOf(x.w, 'a~/origin.git', pushRemoteOf)).toEqual([join(x.w, 'a~', 'origin.git')]);
    expect(pushUrlsOf(x.w, 'https://h/~user/x.git', pushRemoteOf)).toEqual(['https://h/~user/x.git']);
    expect(pushUrlsOf(x.w, 'ssh://git@h/~/x.git', pushRemoteOf)).toEqual(['ssh://git@h/~/x.git']);
    // And through the decoy path written out, the commits are there, so nothing is owed.
    expect(owedOf(x, { remote: './~/origin.git' })).toBeNull();
  });
});
