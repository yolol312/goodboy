// Commit issue rule bounds (final G1 review, round 3): one call is bounded in git spawns, time
// and bytes read; settings follow the repo's real path; aliases keep the call's `-c` settings.
// Repos, files and session dirs are temporary; the commands themselves never run here.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitIssueDenial, pinCommitIssueSettings } from '../lib/commit-issue';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-ci-b-')));
  dirs.push(dir);
  return dir;
}

function repo(head = 'ABC-1 init'): string {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', head);
  return dir;
}

function sid(): string {
  const s = `cib${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

function timed<T>(f: () => T): { value: T; ms: number } {
  const t = Date.now();
  const value = f();
  return { value, ms: Date.now() - t };
}

describe('bounds of one call', () => {
  test('the same -F file named 1300 times is read once', () => {
    const r = repo();
    writeFileSync(join(r, 'msg.txt'), `fix\n${'x'.repeat(1024 * 1024 - 8)}`);
    const { value, ms } = timed(() => commitIssueDenial(`git commit ${'-F msg.txt '.repeat(1300)}`, r, sid()));
    expect(value).toContain('no issue number');
    expect(ms).toBeLessThan(5000);
  });

  test('message files over 4 MB in all are denied', () => {
    const r = repo();
    for (let k = 0; k < 5; k++) writeFileSync(join(r, `m${k}.txt`), `fix\n${'x'.repeat(1024 * 1024 - 16)}`);
    expect(commitIssueDenial('git commit -F m0.txt -F m1.txt -F m2.txt -F m3.txt -F m4.txt', r, sid())).toContain('more than 4 MB');
  });

  test('`-F -` repeated 4000 times judges the command text once', () => {
    const r = repo();
    const { value, ms } = timed(() => commitIssueDenial(`git commit ${'-F - '.repeat(4000)}<<EOF\nfix\nEOF`, r, sid()));
    expect(value).toContain('no issue number');
    expect(ms).toBeLessThan(3000);
  });

  test('a reused message larger than 1 MB is denied, not read', () => {
    const r = repo();
    writeFileSync(join(r, 'big.txt'), `fix\n${'x'.repeat(2 * 1024 * 1024)}`);
    const big = git(r, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-F', 'big.txt');
    git(r, 'update-ref', 'HEAD', big);
    expect(commitIssueDenial('git commit --amend --no-edit', r, sid())).toContain('could not finish');
  });

  test('an alias lookup that stalls (an include read from a FIFO) denies', () => {
    const r = repo();
    const fifo = join(r, 'cfg.fifo');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    const { value, ms } = timed(() => commitIssueDenial(`git -c include.path=${fifo} zz -m fix`, r, sid()));
    expect(value).toContain('could not finish');
    expect(ms).toBeLessThan(9000);
  }, 20_000);

  test('a message file over 1 MB is refused even when it names an issue', () => {
    const r = repo();
    writeFileSync(join(r, 'big.txt'), `ABC-1 fix\n${'x'.repeat(2 * 1024 * 1024)}`);
    expect(commitIssueDenial('git commit -F big.txt', r, sid())).toContain('at most 1 MB');
  });

  test('3000 commits reading stdin judge the long command text once', () => {
    const r = repo();
    // HTML entities (`&#1`) are matches the scan must look at, and the issue (`#5`) comes
    //   last: judged per commit, each scan reads the whole text.
    const command = `: '${'&#1 '.repeat(25_000)}'\n${Array.from({ length: 3000 }, () => 'git commit -F -').join('; ')}\n: ' #5'`;
    const { value, ms } = timed(() => commitIssueDenial(command, r, sid()));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(3000);
  });

  test('400 heredoc scripts are read once each, not once per shell', () => {
    const r = repo();
    const command = Array.from({ length: 400 }, (_, i) => `bash <<'E${i}'\ngit commit -m 'ABC-1 x'\nE${i}`).join('\n');
    const { value, ms } = timed(() => commitIssueDenial(command, r, sid()));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(3000);
  });

  test('a heredoc shell three deep is denied, not skipped', () => {
    const r = repo();
    expect(commitIssueDenial("bash <<'A'\nbash <<'B'\nbash <<'C'\ngit commit -m fix\nC\nB\nA", r, sid())).toContain('deeper than goodboy follows');
  });

  test('nine `git lfs` calls look the word up once', () => {
    const r = repo();
    expect(commitIssueDenial(Array.from({ length: 9 }, () => 'git lfs pull').join('; '), r, sid())).toBeNull();
  });

  test('a heredoc script too large for the reader denies', () => {
    const r = repo();
    const script = `${Array.from({ length: 6000 }, () => 'true').join(';')};git commit -m x`;
    expect(commitIssueDenial(`bash <<'S'\n${script}\nS`, r, sid())).toContain('too large or nested');
  });
});

describe('aliases keep the call settings', () => {
  test('an inline alias chain, and an alias from `-c include.path`', () => {
    const r = repo();
    expect(commitIssueDenial('git -c alias.a=b -c alias.b=commit a -m fix', r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git -c alias.a=b -c alias.b=commit a -m "fix #1"', r, sid())).toBeNull();
    writeFileSync(join(r, 'inc.cfg'), '[alias]\n\tci = commit\n');
    expect(commitIssueDenial(`git -c include.path=${join(r, 'inc.cfg')} ci -m fix`, r, sid())).toContain('no issue number');
  });

  test('an alias run with config from the environment is denied', () => {
    const r = repo();
    expect(commitIssueDenial('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.ci GIT_CONFIG_VALUE_0=commit git ci -m fix', r, sid())).toContain('from the environment');
    // Built-in words pass: an alias never hides one.
    expect(commitIssueDenial('HOME=/nowhere git status', r, sid())).toBeNull();
  });
});

describe('messages as git cleans them', () => {
  test('`--cleanup=strip` drops a `#N` line; the default keeps it', () => {
    const r = repo();
    expect(commitIssueDenial('git commit -m fix -m "#12"', r, sid())).toBeNull();
    expect(commitIssueDenial('git commit --cleanup=strip -m fix -m "#12"', r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git commit -e -m fix -m "#12"', r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git commit --cleanup=whitespace -e -m fix -m "#12"', r, sid())).toBeNull();
  });

  test('eval of a heredoc reads its commit; eval of other output that commits is denied', () => {
    const r = repo();
    expect(commitIssueDenial("eval \"$(cat <<'EOF'\ngit commit -m 'ABC-2 x'\nEOF\n)\"", r, sid())).toBeNull();
    expect(commitIssueDenial("eval \"$(printf 'git commit -m fix')\"", r, sid())).toContain('output of a command substitution');
  });

  test('a script piped to a shell from `cat <<EOF` is still read', () => {
    const r = repo();
    expect(commitIssueDenial("cat <<'EOF' | bash\ngit commit -m fix\nEOF", r, sid())).toContain('no issue number');
  });
});

describe('settings', () => {
  test('every Bash call makes the pins, git or not', () => {
    const r = repo();
    const s = sid();
    expect(commitIssueDenial('ls', r, s)).toBeNull();
    expect(existsSync(join(tmpdir(), `goodboy-session-${s}`, 'commit-issue-pins.json'))).toBe(true);
  });

  test('a pins file that is not pins trusts no unpinned setting', () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    Bun.sleepSync(20);
    const s = sid();
    mkdirSync(join(tmpdir(), `goodboy-session-${s}`), { recursive: true });
    writeFileSync(join(tmpdir(), `goodboy-session-${s}`, 'commit-issue-pins.json'), 'not json');
    expect(commitIssueDenial('git commit -m fix', r, s)).toContain('no issue number');
  });

  test('SessionStart after /clear pins the settings', async () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), '\\bPROJ-\\d+\\b\n');
    const s = sid();
    const start = Bun.spawn(['bun', join(import.meta.dir, '..', 'hooks', 'session-start.ts')], {
      cwd: r,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, source: 'clear', cwd: r, hook_event_name: 'SessionStart' })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await start.exited;
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, s)).toContain('PROJ');
  }, 20_000);

  test('a symlinked spelling of the repo finds its pin', () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), '\\bPROJ-\\d+\\b\n');
    const s = sid();
    pinCommitIssueSettings(s, r);
    Bun.sleepSync(20);
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    const link = join(tmp(), 'link');
    symlinkSync(r, link);
    expect(commitIssueDenial('git commit -m "ABC-1 x"', link, s)).toContain('PROJ');
  });

  test('a nearer config changed in the session leaves the default, not a farther `off`', () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    const s = sid();
    pinCommitIssueSettings(s, r);
    Bun.sleepSync(20);
    mkdirSync(join(r, 'pkg', '.goodboy'), { recursive: true });
    writeFileSync(join(r, 'pkg', '.goodboy', 'commit-issue'), '\\bPKG-\\d+\\b\n');
    expect(commitIssueDenial('git commit -m fix', r, s)).toBeNull();
    expect(commitIssueDenial('git commit -m fix', join(r, 'pkg'), s)).toContain('no issue number');
  });
});
