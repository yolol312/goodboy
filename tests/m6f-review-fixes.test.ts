// Track M, M6f (plan §19): regression tests for the findings of the security, hallucination, refactoring and performance
// reviews of the commit and push scan. Each block names its finding: H1 the push exclusion by remote, H2 the shapes that
// hide what runs, H3 abbreviated and negated options, M1 the git hook marker, M2 the digest bound to the command, M3 the
// environment names that move the index, M4 a `-F` link, and the lows (a batch header that does not match, the call limit).

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isApprovalMarkerPath, noteBashStart, sweepNewMarkers, takeBashStart } from '../lib/approval-marker';
import { commitIssueDenial } from '../lib/commit-issue';
import { Acc, pushInputFromHook, scanPush, unclear } from '../lib/commit-scan';
import { commitScanOfCommand, type GuardResult } from '../lib/commit-scan-guard';
import { commitScanCommand, gitHooksCommand } from '../lib/git-hooks';
import { CANARY, cleanup, commit, type Fixture, fixture, git, put, useEnv, withRemote } from './m6f-helpers';

setDefaultTimeout(60_000);

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

const scan = (command: string, cwd = f.repo, o: Parameters<typeof commitScanOfCommand>[3] = {}): GuardResult | null => commitScanOfCommand(command, cwd, cwd, { env: f.env, ...o });
const where = (r: GuardResult | null) => (r?.report.hits ?? []).map((h) => `${h.path}:${h.line} ${h.kind}`);
const whyOf = (r: GuardResult | null) => (r?.report.unscanned ?? []).map((u) => `${u.path} (${u.why})`);
const whys = (r: GuardResult | null): string => whyOf(r).join(' | ');

const bare = (name: string): string => {
  const dir = join(f.base, name);
  mkdirSync(dir, { recursive: true });
  git(f, ['init', '-q', '--bare', dir], { cwd: f.base });
  return dir;
};

describe('H1: a push excludes only what its own remote has', () => {
  beforeEach(() => {
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
    commit(f, { 'leak.txt': `a ${CANARY.card}\n` }, 'leak #1');
    git(f, ['push', '-q', 'origin', 'main']);
  });

  test('a URL no remote has, and a name no remote has, exclude nothing: what only another remote holds is scanned', () => {
    const other = bare('other.git');
    expect(scan('git push origin main')).toBeNull();
    for (const c of [`git push ${other} main`, `git push ${other}`, 'git push nowhere main', 'git push --repo=nowhere']) expect([c, where(scan(c))]).toEqual([c, ['leak.txt:1 card']]);
  });

  test('a URL that is exactly the url or the pushurl of a configured remote is that remote', () => {
    const originUrl = join(f.base, 'origin.git');
    const other = bare('other.git');
    expect(scan(`git push ${originUrl} main`)).toBeNull();
    // not the same string: no exclusion
    expect(where(scan(`git push ${originUrl}/ main`))).toEqual(['leak.txt:1 card']);
    git(f, ['config', 'remote.origin.pushurl', other]);
    expect(scan(`git push ${other} main`)).toBeNull();
    expect(scan('git push origin main')).toBeNull();
  });

  test('the hook gets the remote name, or the URL when git had none, and reads it the same way', () => {
    const head = git(f, ['rev-parse', 'HEAD']).out.trim();
    const zero = '0'.repeat(40);
    const stdin = `refs/heads/main ${head} refs/heads/main ${zero}\n`;
    const other = bare('other.git');
    const run = (remote: string): string[] => {
      const acc = new Acc();
      scanPush(pushInputFromHook(f.repo, remote, stdin), acc);
      return acc.report().hits.map((h) => `${h.path}:${h.line} ${h.kind}`);
    };
    expect(run('origin')).toEqual([]);
    expect(run(join(f.base, 'origin.git'))).toEqual([]);
    expect(run(other)).toEqual(['leak.txt:1 card']);
    expect(run('nowhere')).toEqual(['leak.txt:1 card']);
  });

  test('a command that moves a remote-tracking ref is not scanned, so a hand-made one cannot stand for the remote', () => {
    const reason = 'it moves a remote-tracking ref';
    const forms = [
      'git update-ref refs/remotes/origin/main HEAD',
      'git update-ref -d refs/remotes/origin/main',
      'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main',
      'git update-ref refs/Remotes/origin/main HEAD',
      'git -C . update-ref refs/remotes/origin/main HEAD',
      'git update-ref "$REF" HEAD',
      'git update-ref --stdin',
      'git -c alias.zz=update-ref zz refs/remotes/origin/main HEAD',
    ];
    for (const c of forms) expect([c, whys(scan(c)).includes(reason)]).toEqual([c, true]);
    // other refs, and reads of a tracking ref, are no move
    for (const c of ['git update-ref refs/heads/other HEAD', 'git update-ref -m "move" refs/heads/other $(git rev-parse HEAD)', 'git symbolic-ref HEAD', 'git rev-parse refs/remotes/origin/main', 'git branch -r']) expect([c, scan(c)]).toEqual([c, null]);
  });

  test('a project that holds no real data costs no git call for it', () => {
    const g = fixture();
    expect(commitScanOfCommand('git update-ref refs/remotes/origin/main HEAD', g.repo, g.repo, { env: g.env })).toBeNull();
  });
});

describe('H2: what hides the program or the subcommand is not scanned', () => {
  const PROGRAM = 'a command word is built at run time';
  const SUBCOMMAND = 'a git subcommand is not a literal name';
  const EVAL = '`eval` runs text built at run time';
  const STDIN = 'a shell reads its script from stdin or a pipe';
  const XARGS = '`xargs` runs git with a subcommand that comes from its input';
  const CONFIG = 'a `git config` write comes before a git call';
  const forms: Array<[string, string]> = [
    ['g=git; $g push origin main', PROGRAM],
    ['`echo git` push origin main', PROGRAM],
    ['$(echo git) push origin main', PROGRAM],
    ['sudo $(echo git) push origin main', PROGRAM],
    ['cmd="git push"; $cmd', PROGRAM],
    ['"$GIT" push origin main', PROGRAM],
    ['g=git; $HOME/bin/$g push origin main', PROGRAM],
    ['S=push; git $S origin main', SUBCOMMAND],
    ['git $(echo push) origin main', SUBCOMMAND],
    ['git "$S" origin main', SUBCOMMAND],
    ['cmd="git commit -m x"; eval "$cmd"', EVAL],
    ['eval git $VERB', EVAL],
    ['echo git push | sh', STDIN],
    ['sh < git-script.sh', STDIN],
    ['echo "git push" | bash -s', STDIN],
    ['bash <<< "git push"', STDIN],
    ['echo push | xargs git', XARGS],
    ['git config alias.zz commit; git zz -m "x #1"', CONFIG],
    ['git config --global core.hooksPath /x && git commit -m "x #1"', CONFIG],
    ['git config user.name x; git push', CONFIG],
  ];

  test('each shape is "not scanned" with its own fixed reason, and the reason holds no command text', () => {
    for (const [c, why] of forms) {
      const r = scan(c);
      expect([c, whys(r).includes(why)]).toEqual([c, true]);
      expect([c, whys(r).includes('goodboy cannot read this command well enough')]).toEqual([c, true]);
      expect([c, JSON.stringify(r!.report).includes('echo')]).toEqual([c, false]);
    }
  });

  test('the same shapes cost a project with no real data nothing', () => {
    const g = fixture();
    for (const [c] of forms) expect([c, commitScanOfCommand(c, g.repo, g.repo, { env: g.env })]).toEqual([c, null]);
  });

  test('a git environment name exported or assigned before a call moves it, in any form that sets it', () => {
    const moved = 'comes from the environment';
    for (const c of ['export GIT_DIR=.git; git commit -m "x #1"', 'declare -x GIT_WORK_TREE=/tmp; git commit -am "x #1"', 'typeset -x GIT_DIR=.git; git push', 'GIT_DIR=.git; git commit -m "x #1"', 'readonly GIT_CONFIG_COUNT=1; git commit -m "x #1"']) {
      expect([c, whys(scan(c)).includes(moved)]).toEqual([c, true]);
    }
    // an alias defined by exported config is not followed: the call is "not scanned"
    expect(whys(scan('export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.zz GIT_CONFIG_VALUE_0=commit; git zz -m "x #1"'))).toContain('goodboy cannot read this command well enough');
  });

  test('what is read stays read: literal commands, read-only config, heredoc scripts, an env prefix of another segment', () => {
    for (const c of [
      'git config --get user.name && git commit -m "x #1"',
      'git config --list; git push --dry-run',
      'git config --get-regexp remote; git status',
      'env GIT_DIR=x true; git commit -m "x #1"',
      'export GIT_AUTHOR_NAME=a; git commit -m "x #1"',
      'eval \'git commit -m "x #1"\'',
      'sh -c \'git commit -m "x #1"\'',
      'bash <<\'EOF\'\ngit commit -m "x #1"\nEOF',
      'cat <<EOF | sh\ngit commit -m "x #1"\nEOF',
      'echo a | xargs git commit -m "x #1"',
      '$(which env) git commit -m "x #1"',
      '$HOME/bin/tool --flag && git commit -m "x #1" --allow-empty',
      '"${PLUGIN_DIR}/run.sh" x; git commit -m "x #1" --allow-empty',
      'git ls-files | xargs git add',
    ]) {
      expect([c, scan(c)]).toEqual([c, null]);
    }
  });

  test('a shell reading a heredoc and another reading a pipe in one command: the pipe is not scanned', () => {
    const r = scan('cat <<EOF > notes.txt\nhello\nEOF\necho git push | sh');
    expect(whys(r)).toContain(STDIN);
  });
});

describe('H3: options are read by their full names', () => {
  const UNKNOWN = 'does not know by its full name';
  const NEGATED = 'negates an option that changes what it reads or sends';

  test('an abbreviated long option of commit is not scanned', () => {
    for (const c of [
      'git commit --pathspec-from=list.txt -m "x #1"',
      'git commit --mess="x #1"',
      'git commit --amen -m "x #1"',
      'git commit --all-ow -m "x #1"',
      'git commit --dry -m "x #1"',
      'git commit --end-of-options -m "x #1"',
      'git commit --nosuchoption -m "x #1"',
    ]) {
      expect([c, whys(scan(c)).includes(UNKNOWN)]).toEqual([c, true]);
    }
  });

  test('a negation of an option that changes what is read is not scanned; so is one that undoes --dry-run', () => {
    put(f, 'a.txt', `${CANARY.email}\n`);
    git(f, ['add', 'a.txt']);
    for (const c of ['git commit -a --no-all -m "x #1"', 'git commit --no-amend -m "x #1"', 'git commit --no-include a.txt -m "x #1"', 'git commit --no-message', 'git commit --no-pathspec-from-file -m "x #1"']) {
      expect([c, whys(scan(c)).includes(NEGATED)]).toEqual([c, true]);
    }
    // `--no-dry-run` does not leave the commit skipped: the staged value is a hit
    const r = scan('git commit --dry-run --no-dry-run -m "x #1"');
    expect(where(r)).toEqual(['a.txt:1 email']);
    expect(whys(r)).toContain(NEGATED);
    expect(whys(scan('git commit --dry-run --dry -m "x #1"'))).toContain(UNKNOWN);
    // a plain dry run still publishes nothing
    expect(scan('git commit --dry-run -m "x #1"')).toBeNull();
  });

  test('every full name git 2.39 lists, and the negations that change nothing read, are known', () => {
    const names = 'quiet verbose file author date message reedit-message reuse-message fixup squash reset-author trailer signoff template edit cleanup status gpg-sign all include interactive patch only no-verify verify dry-run short branch ahead-behind porcelain long null amend no-post-rewrite post-rewrite untracked-files pathspec-from-file pathspec-file-nul allow-empty allow-empty-message'.split(' ');
    for (const n of names) {
      const r = scan(`git commit --${n}=x --allow-empty -m "x #1"`);
      expect([n, whys(r).includes(UNKNOWN), whys(r).includes(NEGATED)]).toEqual([n, false, false]);
    }
    for (const n of ['edit', 'verify', 'signoff', 'gpg-sign', 'status', 'quiet', 'verbose', 'reset-author', 'allow-empty', 'cleanup', 'untracked-files', 'verify']) {
      const r = scan(`git commit --no-${n} -m "x #1" --allow-empty`);
      expect([n, whys(r).includes(UNKNOWN), whys(r).includes(NEGATED)]).toEqual([n, false, false]);
    }
    expect(scan('git commit --no-verify --no-edit -m "x #1" --allow-empty')).toBeNull();
  });

  describe('push', () => {
    beforeEach(() => {
      git(f, ['config', 'user.email', 'me@corp.io']);
      withRemote(f);
      git(f, ['checkout', '-q', '-b', 'side']);
      commit(f, { 'leak.txt': `a ${CANARY.email}\n` }, 'leak #1');
      git(f, ['checkout', '-q', 'main']);
    });

    test('an abbreviated long option of push is not scanned (--mir sends every branch)', () => {
      const url = join(f.base, 'origin.git');
      for (const c of [`git push --mir ${url}`, `git push --mirr ${url}`, 'git push --del origin side', 'git push --tag', 'git push --all-', 'git push --end-of-options origin main', 'git push --dry origin main']) {
        expect([c, whys(scan(c)).includes(UNKNOWN)]).toEqual([c, true]);
      }
    });

    test('a negation that changes what is sent is not scanned; --no-dry-run does not leave the push skipped', () => {
      for (const c of ['git push --all --no-all', 'git push --no-mirror origin main', 'git push --no-delete origin main', 'git push --no-tags origin main', 'git push --no-follow-tags origin main']) {
        expect([c, whys(scan(c)).includes(NEGATED)]).toEqual([c, true]);
      }
      const r = scan('git push --dry-run --no-dry-run --all');
      expect(where(r)).toEqual(['leak.txt:1 email']);
      expect(whys(r)).toContain(NEGATED);
      expect(scan('git push --dry-run --all')).toBeNull();
    });

    test('the full names git lists are known, with their values', () => {
      for (const c of [
        'git push --verbose --quiet --force --force-with-lease=main:abc --force-if-includes --thin --set-upstream --progress --prune --no-verify --verify --atomic --ipv4 --ipv6 origin main',
        'git push --push-option=x --receive-pack=git-receive-pack --exec=git-receive-pack --recurse-submodules=check --signed=if-asked --porcelain origin main',
        'git push --no-thin --no-force --no-set-upstream --no-signed --no-atomic origin main',
        'git push --follow-tags origin main',
        'git push --branches origin main',
      ]) {
        const r = scan(c);
        expect([c, whys(r).includes(UNKNOWN), whys(r).includes(NEGATED)]).toEqual([c, false, false]);
      }
    });
  });
});

describe('M1: the git hooks\' marker made by a model Bash call is swept', () => {
  let dir: string;
  const sid = `m6f-fix-${process.pid}`;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goodboy-m6f-marker-'));
    mkdirSync(join(dir, '.claude'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a marker with any name, made while the call ran, is removed; one that was there before the call stays', () => {
    const mine = join(dir, '.claude', '.goodboy-commit-scan-approved-hook.txt');
    writeFileSync(mine, 'abcdef0123456789\n');
    noteBashStart(sid, 'tu-m1', dir, 'a=.goodboy-commit-scan; echo d > ".claude/${a}-approved-built.txt"');
    // a name built at run time, in the case the file system keeps or folds
    const built = join(dir, '.claude', '.goodboy-commit-scan-approved-built.txt');
    const folded = join(dir, '.claude', '.Goodboy-Commit-Scan-Approved-ZZ.txt');
    writeFileSync(built, 'abcdef0123456789\n');
    writeFileSync(folded, 'abcdef0123456789\n');
    const removed = sweepNewMarkers(sid, takeBashStart(sid, 'tu-m1', dir)).map((p) => p.split('/').pop());
    expect(removed.sort()).toEqual(['.Goodboy-Commit-Scan-Approved-ZZ.txt', '.goodboy-commit-scan-approved-built.txt']);
    expect(existsSync(built)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  test('without the start note a marker newer than the call is removed too, and only markers are', () => {
    const start = takeBashStart(sid, undefined, dir);
    writeFileSync(join(dir, '.claude', '.goodboy-commit-scan-approved-late.txt'), 'x\n');
    writeFileSync(join(dir, '.claude', 'notes.txt'), 'x\n');
    writeFileSync(join(dir, '.claude', '.goodboy-commit-scan-approved.txt'), 'x\n');
    const removed = sweepNewMarkers(sid, { ...start, since: Date.now() - 5000 }).map((p) => p.split('/').pop());
    expect(removed).toEqual(['.goodboy-commit-scan-approved-late.txt']);
    expect(readdirSync(join(dir, '.claude')).sort()).toEqual(['.goodboy-commit-scan-approved.txt', 'notes.txt']);
    expect(isApprovalMarkerPath('/p/.claude/.goodboy-commit-scan-approved-hook.txt')).toBe(true);
  });
});

describe('M2: a "not scanned" reason of the command is bound to the command', () => {
  test('two commands with the same reason have different digests; the same command has one', () => {
    put(f, 'ok.txt', 'fine\n');
    put(f, 'secret.txt', `${CANARY.rrn}\n`);
    const a = scan('git add ok.txt && git commit -m "fixtures #1"')!;
    const b = scan('git add -A && git commit -m "everything #1"')!;
    const c = scan('git add secret.txt && git commit -m "real #1"')!;
    expect(whyOf(a)).toEqual(whyOf(b));
    expect(new Set([a.report.digest, b.report.digest, c.report.digest]).size).toBe(3);
    expect(scan('git add ok.txt && git commit -m "fixtures #1"')!.report.digest).toBe(a.report.digest);
    // -p and a computed -C dir are command-level reasons too
    expect(scan('git commit -p -m "one #1"')!.report.digest).not.toBe(scan('git commit -p -m "two #1"')!.report.digest);
    expect(scan('git -C "$X" commit -m "a #1"')!.report.digest).not.toBe(scan('git -C "$Y" commit -m "a #1"')!.report.digest);
  });

  test('the git hooks\' reasons keep the digest of the reason alone', () => {
    const acc = new Acc();
    unclear(acc, '<commit>', 'why');
    const key = createHash('sha256').update('why').digest('hex');
    const lines = `<commit>\0${key}\0unscanned:why`;
    expect(acc.report().digest).toBe(createHash('sha256').update(lines).digest('hex').slice(0, 16));
    const salted = new Acc(undefined, 'a command');
    unclear(salted, '<commit>', 'why');
    expect(salted.report().digest).not.toBe(acc.report().digest);
  });
});

describe('M3: the environment names that move the index and the objects', () => {
  const moved = 'comes from the environment';

  test('an index, an object directory or a namespace from the environment makes the call not scanned', () => {
    git(f, ['update-index', '--add', '--cacheinfo', '100644,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,x.txt']);
    for (const c of [
      `GIT_INDEX_FILE=${f.base}/alt git commit -m "x #1"`,
      `export GIT_INDEX_FILE=${f.base}/alt; git commit -m "x #1"`,
      `env GIT_INDEX_FILE=${f.base}/alt git commit -m "x #1"`,
      'GIT_OBJECT_DIRECTORY=/tmp/o git commit -m "x #1"',
      'export GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp/o; git commit -m "x #1"',
      'GIT_NAMESPACE=a git push origin main',
      'export GIT_DIR=.git; git commit -m "x #1"',
      'export GIT_WORK_TREE=/tmp; git commit -a -m "x #1"',
    ]) {
      expect([c, whys(scan(c)).includes(moved)]).toEqual([c, true]);
    }
  });

  test('an assignment inside a loop still reaches every call, and an unrelated name does not', () => {
    expect(whys(scan('for i in 1; do git commit -m "x #1"; done; export GIT_INDEX_FILE=/tmp/alt'))).toContain(moved);
    expect(scan('export GIT_AUTHOR_DATE=1; git commit -m "x #1" --allow-empty')).toBeNull();
    expect(scan('env GIT_INDEX_FILE=/tmp/alt true; git commit -m "x #1" --allow-empty')).toBeNull();
  });

  test('the commit issue rule keeps its own list: GIT_INDEX_FILE is no environment move there', () => {
    expect(commitIssueDenial('GIT_INDEX_FILE=/tmp/alt git commit -m "x ABC-1"', f.repo, `m6f-fix-issue-${process.pid}`)).toBeNull();
    expect(commitIssueDenial('export GIT_INDEX_FILE=/tmp/alt; git commit -m "x ABC-1"', f.repo, `m6f-fix-issue-${process.pid}`)).toBeNull();
    expect(commitIssueDenial('GIT_DIR=.git git commit --amend --no-edit', f.repo, `m6f-fix-issue-${process.pid}`)).not.toBeNull();
  });
});

describe('M4: a -F link is followed to the file git reads', () => {
  test('the message of the file a link names is scanned; a link that leads nowhere is not scanned', () => {
    put(f, 'real-msg.txt', `contact ${CANARY.email} #1\n`);
    symlinkSync(join(f.repo, 'real-msg.txt'), join(f.repo, 'link-msg'));
    for (const c of ['git commit --allow-empty -F link-msg', 'git commit --allow-empty --file=link-msg', 'git commit --allow-empty -Flink-msg']) {
      expect([c, where(scan(c))]).toEqual([c, ['<commit message>:1 email']]);
    }
    symlinkSync(join(f.base, 'absent-target'), join(f.repo, 'dangling'));
    expect(whys(scan('git commit --allow-empty -F dangling'))).toContain('the message file cannot be read');
    // a link into a directory of the same repo, and one that is relative
    mkdirSync(join(f.repo, 'sub'));
    put(f, 'sub/m.txt', `x ${CANARY.phone}\n`);
    symlinkSync('sub/m.txt', join(f.repo, 'rel-link'));
    expect(where(scan('git commit --allow-empty -F rel-link'))).toEqual(['<commit message>:1 phone']);
  });
});

describe('lows', () => {
  /** A `git` first on PATH that answers `cat-file --batch` with a header for another object, and is git otherwise. */
  function withFakeGit<T>(body: () => T): T {
    const real = Bun.which('git')!;
    const dir = mkdtempSync(join(tmpdir(), 'goodboy-m6f-fakegit-'));
    const script = `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--batch" ]; then\n    cat > /dev/null\n    printf '0000000000000000000000000000000000000000 blob 3\\nabc\\n'\n    exit 0\n  fi\ndone\nexec '${real}' "$@"\n`;
    writeFileSync(join(dir, 'git'), script);
    chmodSync(join(dir, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      return body();
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a batch header that is not the one asked for marks that object and the rest of the batch "not scanned"', () => {
    for (const n of ['a', 'b', 'c']) put(f, `${n}.txt`, `${n}\n`);
    git(f, ['add', '-A']);
    const r = withFakeGit(() => scan('git commit -m "x #1"'));
    expect(whyOf(r)).toEqual(['a.txt (git could not read the object)', 'b.txt (git could not read the object)', 'c.txt (git could not read the object)']);
  });

  test('the same for the commit and tag messages of a push', () => {
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
    for (const n of ['one', 'two', 'three']) commit(f, { [`${n}.txt`]: `${n}\n` }, `${n} #1`);
    const r = withFakeGit(() => scan('git push origin main'));
    expect(whyOf(r).filter((w) => w.startsWith('<message of ')).map((w) => w.replace(/[0-9a-f]{7}/, 'ID'))).toEqual([
      '<message of ID> (git could not read the object)',
      '<message of ID> (git could not read the object)',
      '<message of ID> (git could not read the object)',
    ]);
  });

  test('only the calls that are scanned count against the limit of six', () => {
    const plain = fixture();
    const outside = Array.from({ length: 7 }, () => `git -C ${plain.repo} commit --allow-empty -m "x #1"`);
    expect(scan([...outside, 'git commit --allow-empty -m "y #1"'].join(' && '))).toBeNull();
    const r = scan([...outside, ...Array.from({ length: 7 }, () => 'git commit --allow-empty -m "y #1"')].join(' && '));
    expect(whyOf(r)).toEqual(['<command> (this command runs more than 6 git commits and pushes)']);
  });

  test('install writes every hook to a temp name first: a write that fails displaces no hook of the user', () => {
    const hooks = join(f.repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const n of ['pre-commit', 'commit-msg']) writeFileSync(join(hooks, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // a directory where the last hook's temp file goes
    mkdirSync(join(hooks, `pre-push.goodboy-tmp-${process.pid}`));
    expect(() => gitHooksCommand(['install', '--force'], f.repo, '/cli.ts', '/bun')).toThrow();
    expect(readdirSync(hooks).filter((n) => n.endsWith('.goodboy-saved'))).toEqual([]);
    expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
  });
});

describe('round 3, item 1: an address is no hit in a message only when it is a no-reply address or the commit\'s own', () => {
  const TRAILER = 'Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>';
  const OWN = 'dev@naver.com';

  test('the Claude Code trailer passes in -m, a heredoc, a -F file, the commit-msg hook and a pushed commit or tag', () => {
    git(f, ['config', 'user.email', 'me@naver.com']);
    withRemote(f);
    expect(scan(`git commit --allow-empty -m "work #1" -m "${TRAILER}"`)).toBeNull();
    expect(scan(`git commit --allow-empty -m "$(cat <<'EOF'\nwork #1\n\n${TRAILER}\nEOF\n)"`)).toBeNull();
    put(f, 'msg.txt', `work #1\n\n${TRAILER}\n`);
    expect(scan('git commit --allow-empty -F msg.txt')).toBeNull();
    const hook = commitScanCommand(['--hook', 'commit-msg', join(f.repo, 'msg.txt')], f.repo);
    expect('code' in hook ? hook.code : -1).toBe(0);
    git(f, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `work #1\n\n${TRAILER}`]);
    expect(scan('git push origin main')).toBeNull();
    git(f, ['tag', '-a', 'v1', '-m', `v1 #1\n\n${TRAILER}`]);
    expect(scan('git push origin v1')).toBeNull();
  });

  test('no-reply addresses: noreply and no-reply with a +tag, any case, and users.noreply.github.com; not a lookalike', () => {
    const pass = (a: string) => scan(`git commit --allow-empty -m "work #1" -m "Co-authored-by: A <${a}>"`);
    for (const a of ['noreply@x.io', 'no-reply@x.io', 'NoReply+tag@x.io', 'no-reply+a.b@x.io', '1234+user@users.noreply.github.com', 'user@Users.NoReply.GitHub.com']) expect([a, pass(a)]).toEqual([a, null]);
    for (const a of ['noreply2@x.io', 'fake-noreply@x.io', 'noreply@x.io.evil.com@naver.com', 'user@noreply.github.com', 'a@users.noreply.github.com.evil.io']) expect([a, where(pass(a)).length]).toEqual([a, 1]);
  });

  test('the commit\'s own address passes: the configured user, on any line, in a commit and in a push', () => {
    git(f, ['config', 'user.email', 'Dev@Naver.Com']);
    expect(scan(`git commit --allow-empty -m "work #1" -m "Signed-off-by: Dev <${OWN}>"`)).toBeNull();
    expect(scan(`git commit --allow-empty -m "ping ${OWN} #1"`)).toBeNull();
    put(f, 'msg.txt', `work #1\n\nSigned-off-by: Dev <${OWN}>\n`);
    expect(scan('git commit --allow-empty -F msg.txt')).toBeNull();
    const hook = commitScanCommand(['--hook', 'commit-msg', join(f.repo, 'msg.txt')], f.repo);
    expect('code' in hook ? hook.code : -1).toBe(0);
    withRemote(f);
    git(f, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `work #1\n\nSigned-off-by: Dev <${OWN}>`]);
    expect(scan('git push origin main')).toBeNull();
  });

  test('a pushed commit is exempt for its own headers only: another commit\'s author address in a message hits', () => {
    git(f, ['config', 'user.email', 'me@naver.com']);
    withRemote(f);
    git(f, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `work #1\n\nSigned-off-by: Dev <${OWN}>\nCo-authored-by: Me <me@naver.com>`]);
    expect(where(scan('git push origin main')).map((h) => h.replace(/[0-9a-f]{7}/, 'ID'))).toEqual(['<commit message ID>:3 email']);
    // a tag's own tagger (the commit is on the remote, a local bare repo, by now)
    git(f, ['push', '-q', '--no-verify', 'origin', 'main']);
    git(f, ['tag', '-a', 'v2', '-m', 'v2 #1\n\nby me@naver.com']);
    expect(scan('git push origin v2')).toBeNull();
  });

  test('every other address hits, wherever it is: Reported-by, Leaked-By, a teammate\'s co-author, the body', () => {
    const hit = (m: string) => where(scan(`git commit --allow-empty -m "work #1" -m "${m}"`));
    expect(hit(`Reported-by: X <${CANARY.email}>`)).toEqual(['<commit message>:3 email']);
    expect(hit('Leaked-By: a@naver.com, b@naver.com')).toEqual(['<commit message>:3 email']);
    expect(hit('Co-authored-by: T <t@naver.com>')).toEqual(['<commit message>:3 email']);
    expect(hit(`contact ${CANARY.email}`)).toEqual(['<commit message>:3 email']);
    expect(where(scan(`git commit --allow-empty -m "work #1" --trailer 'Reported-by: ${CANARY.email}'`))).toEqual(['<commit message>:3 email']);
    // other kinds are unaffected, also next to a no-reply address
    expect(hit(`Co-Authored-By: A <noreply@anthropic.com> ${CANARY.phone}`)).toEqual(['<commit message>:3 phone']);
    // a file is never read this way
    put(f, 'notes.txt', `${TRAILER}\n`);
    git(f, ['add', 'notes.txt']);
    expect(where(scan('git commit -m "x #1"'))).toEqual(['notes.txt:1 email']);
  });

  test('a git var that fails gives no exemption, and a project that holds no real data is not asked', () => {
    git(f, ['config', 'user.useConfigOnly', 'true']);
    git(f, ['config', '--unset', 'user.email']);
    expect(where(scan(`git commit --allow-empty -m "work #1" -m "Signed-off-by: Dev <${OWN}>"`)).length).toBe(1);
    expect(scan(`git commit --allow-empty -m "work #1" -m "${TRAILER}"`)).toBeNull();
  });
});

describe('round 2, item 2: re-pointing a remote is not scanned', () => {
  const REASON = 'it re-points a remote';
  beforeEach(() => {
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
  });

  test('git remote set-url and rename, and a config write of a url key, are "not scanned"', () => {
    const other = bare('public.git');
    const forms = [
      `git remote set-url origin ${other}`,
      `git remote set-url --push origin ${other}`,
      'git remote rename origin old',
      `git config remote.origin.url ${other}`,
      `git config --add remote.origin.pushurl ${other}`,
      `git config --replace-all remote.origin.url ${other}`,
      'git config --unset remote.origin.url',
      'git config --global url.https://x/.insteadOf git://x/',
      'git config url.https://x/.pushInsteadOf git://x/',
      'git config REMOTE.origin.URL x',
      'git config --remove-section remote.origin',
      `git -C . remote set-url origin ${other}`,
    ];
    for (const c of forms) expect([c, whys(scan(c)).includes(REASON)]).toEqual([c, true]);
  });

  test('reads and other remote commands are no re-pointing', () => {
    for (const c of ['git remote -v', 'git remote add pub /tmp/x', 'git remote get-url origin', 'git config remote.origin.url', 'git config --get remote.origin.url', 'git config remote.origin.fetch', 'git config user.name x', 'git remote show origin']) {
      expect([c, whys(scan(c)).includes(REASON)]).toEqual([c, false]);
    }
  });

  test('-c of a url key on the push itself is "not scanned", and the push is scanned too', () => {
    commit(f, { 'leak.txt': `a ${CANARY.card}\n` }, 'leak #1');
    git(f, ['push', '-q', 'origin', 'main']);
    const other = bare('public.git');
    for (const c of [`git -c remote.origin.url=${other} push origin main`, `git -c url.${other}/.insteadOf=x push origin main`, `git -c remote.origin.pushurl=${other} push origin main`, `git -c URL.x.INSTEADOF=y push origin main`]) {
      expect([c, whys(scan(c)).includes(REASON)]).toEqual([c, true]);
    }
    // a -c of another key is nothing
    expect(scan('git -c core.quotepath=off push origin main')).toBeNull();
  });

  test('a project that holds no real data costs no git call for it', () => {
    const g = fixture();
    expect(commitScanOfCommand('git remote set-url origin /tmp/x', g.repo, g.repo, { env: g.env })).toBeNull();
  });
});

describe('round 2, item 3: a redirect that writes a file counts as a change before the commit', () => {
  const BEFORE = 'before the commit';

  test('echo, printf and cat with a redirect, and tee and sort -o, before a commit that reads the work tree', () => {
    commit(f, { 'tracked.md': 'x\n' }, 'tracked #1');
    for (const c of [
      `echo "e ${CANARY.email}" >> tracked.md && git commit -a -m "x #1"`,
      `printf 'x' > tracked.md; git commit -a -m "x #1"`,
      'cat real.txt > tracked.md; git commit -a -m "x #1"',
      'cat real.txt >> tracked.md; git commit tracked.md -m "x #1"',
      'echo hi &> tracked.md; git commit -a -m "x #1"',
      'echo hi >| tracked.md; git commit -a -m "x #1"',
      '> tracked.md; git commit -a -m "x #1"',
      'echo hi | tee tracked.md; git commit -a -m "x #1"',
      'sort -o tracked.md tracked.md && git commit -a -m "x #1"',
      'sort --output=tracked.md tracked.md && git commit -a -m "x #1"',
    ]) {
      expect([c, whys(scan(c)).includes(BEFORE)]).toEqual([c, true]);
    }
  });

  test('a -F file is read from the work tree: a segment before the commit may write it', () => {
    for (const c of ['echo "m #1" > msg.txt && git commit --allow-empty -F msg.txt', 'cp x msg.txt && git commit --allow-empty -F msg.txt', 'git commit --allow-empty -F msg.txt']) {
      put(f, 'msg.txt', 'm #1\n');
      const r = scan(c);
      expect([c, whys(r).includes(BEFORE)]).toEqual([c, c.includes('&&')]);
    }
  });

  test('a redirect to a descriptor or /dev/null, a read, and a push after a redirect are not changes', () => {
    commit(f, { 'tracked.md': 'x\n' }, 'tracked #1');
    for (const c of ['echo hi > /dev/null && git commit -a -m "x #1" --allow-empty', 'cat tracked.md 2>&1 | head -1; git commit -a -m "x #1" --allow-empty', 'echo hi >&2; git commit -a -m "x #1" --allow-empty', 'cat < tracked.md; git commit -a -m "x #1" --allow-empty']) {
      expect([c, scan(c)]).toEqual([c, null]);
    }
    // the plain commit reads the index: a file write before it is no change to it
    expect(scan('echo hi > notes.txt && git commit -m "x #1" --allow-empty')).toBeNull();
    // and a redirect on the commit itself is no earlier segment
    expect(scan('git commit -a -m "x #1" --allow-empty > /tmp/commit.log')).toBeNull();
  });
});

describe('round 2, item 4: a message file that is a pipe is not scanned', () => {
  const PIPE = 'a pipe or a process substitution';

  test('-F with a process substitution, an empty value or a descriptor path', () => {
    for (const c of [
      `git commit -F <(echo '${CANARY.email} #1')`,
      'git commit --file=/dev/fd/63 --allow-empty',
      'git commit -F /proc/self/fd/3 --allow-empty',
      "git commit -F '' --allow-empty",
      'git commit --allow-empty -F <(cat real.txt)',
    ]) {
      expect([c, whys(scan(c)).includes(PIPE)]).toEqual([c, true]);
    }
  });

  test('an option with no value is not scanned; a heredoc message file still is read', () => {
    expect(whys(scan('git commit -m <(echo hi) --allow-empty'))).toContain('takes a value goodboy cannot read');
    expect(scan('git commit --allow-empty -F /dev/stdin <<\'EOF\'\nwork #1\nEOF')).toBeNull();
    expect(where(scan(`git commit --allow-empty -F /dev/fd/0 <<'EOF'\nmail ${CANARY.email}\nEOF`))).toEqual(['<commit message>:1 email']);
  });
});

describe('round 3, item 2: a redirect glued into a word is a write', () => {
  const BEFORE = 'before the commit';

  test('echo hi>README.md, printf x>>f, cat a>b before a commit that reads the work tree; a target under /dev/../ is no /dev', () => {
    commit(f, { 'tracked.md': 'x\n' }, 'tracked #1');
    for (const c of ['echo hi>tracked.md; git commit -a -m "x #1"', 'printf x>>tracked.md && git commit -a -m "x #1"', 'cat a>tracked.md; git commit tracked.md -m "x #1"', 'echo a &>tracked.md; git commit -a -m "x #1"', 'echo a>|tracked.md; git commit -a -m "x #1"', 'echo a>/dev/../tmp/x; git commit -a -m "x #1"', 'echo a > /dev/../tmp/x; git commit -a -m "x #1"']) {
      expect([c, whys(scan(c)).includes(BEFORE)]).toEqual([c, true]);
    }
    for (const c of ['echo a>/dev/null; git commit -a -m "x #1" --allow-empty', 'echo a 2>&1; git commit -a -m "x #1" --allow-empty', 'echo a>&2; git commit -a -m "x #1" --allow-empty', 'echo a 2>/dev/null; git commit -a -m "x #1" --allow-empty']) {
      expect([c, scan(c)]).toEqual([c, null]);
    }
  });
});

describe('round 3, item 3: the message is tied to the commit', () => {
  const COMPUTED = 'computed by a command';
  const NOT_HEREDOC = 'exactly one heredoc of this commit';
  const PIPE = 'a pipe or a process substitution';

  test('the natural form: a heredoc -m next to another heredoc -m is read; a file read by cat is not', () => {
    const both = `git commit --allow-empty -m "$(cat <<'A'\nfix #1 ${CANARY.phone}\nA\n)" -m "$(cat <<'B'\nmore ${CANARY.card}\nB\n)"`;
    expect(where(scan(both)).sort()).toEqual(['<commit message>:1 phone', '<commit message>:3 card'].sort());
    put(f, 'notes.txt', `mail ${CANARY.email}\n`);
    for (const c of [
      `git commit --allow-empty -m "$(cat <<'EOF'\nfix #1\nEOF\n)" -m "$(cat notes.txt)"`,
      'git commit --allow-empty -m "$(cat notes.txt)"',
      'git commit --allow-empty -m "$(cat < notes.txt)"',
      'git commit --allow-empty -m "$(cat -- notes.txt)"',
      'git commit --allow-empty -m "`cat notes.txt`"',
    ]) {
      expect([c, whys(scan(c)).includes(COMPUTED)]).toEqual([c, true]);
    }
  });

  test('a decoy heredoc elsewhere in the command stands for no message', () => {
    put(f, 'notes.txt', `mail ${CANARY.email}\n`);
    // a `cat` heredoc substitution that is no message does not stand for a `$(cat FILE)` message either
    expect(whys(scan('echo "$(cat <<\'EOF\'\nnothing\nEOF\n)"\ngit commit --allow-empty -m "$(cat notes.txt)"'))).toContain(COMPUTED);
    const decoy = 'cat <<EOF >/dev/null\nnothing\nEOF\n';
    expect(whys(scan(`${decoy}git commit --allow-empty -m "$(cat notes.txt)"`))).toContain(COMPUTED);
    expect(whys(scan(`${decoy}git commit --allow-empty -F <(echo '${CANARY.email} #1')`))).toContain(PIPE);
    expect(whys(scan(`${decoy}echo '${CANARY.email} #1' | git commit --allow-empty -F -`))).toContain(NOT_HEREDOC);
    expect(whys(scan(`${decoy}git commit --allow-empty -F -  < notes.txt`))).toContain(NOT_HEREDOC);
    expect(whys(scan(`${decoy}git commit --allow-empty -F /dev/stdin`))).toContain(NOT_HEREDOC);
  });

  test('a heredoc that is the commit\'s own stdin is read: on the commit, or piped into it by cat', () => {
    expect(where(scan(`git commit --allow-empty -F - <<'EOF'\nfix #1 ${CANARY.phone}\nEOF`))).toEqual(['<commit message>:1 phone']);
    expect(where(scan(`git commit --allow-empty -F /dev/stdin <<'EOF'\nfix #1 ${CANARY.phone}\nEOF`))).toEqual(['<commit message>:1 phone']);
    expect(where(scan(`cat <<'EOF' | git commit --allow-empty -F -\nfix #1 ${CANARY.card}\nEOF`))).toEqual(['<commit message>:1 card']);
    expect(scan(`cat <<'EOF' | git commit --allow-empty -F -\nfix #1\nEOF`)).toBeNull();
  });

  test('-F <(…) is never read, a heredoc in the command or not', () => {
    for (const c of ["git commit --allow-empty -F <(echo 'x #1')", "git commit --allow-empty -F <(cat <<'EOF'\nx #1\nEOF\n)", "cat <<'EOF' | git commit --allow-empty -F <(echo hi)\nx #1\nEOF"]) {
      expect([c, whys(scan(c)).includes(PIPE)]).toEqual([c, true]);
    }
  });
});

describe('round 3, item 4: a computed config key or remote subcommand is a re-point', () => {
  const REASON = 'it re-points a remote';
  test('git config "$K" x, git config "$(…)" x, git remote "$A" origin x', () => {
    for (const c of ['git config "$K" x', 'git config "$(echo remote.origin.url)" x', 'git remote "$A" origin x', 'git config --add "$K" x', 'git config --unset "$K"', 'git remote $(echo set-url) origin x']) {
      expect([c, whys(scan(c)).includes(REASON)]).toEqual([c, true]);
    }
    // a computed value, or a read of a computed key, is none
    for (const c of ['git config user.name "$NAME"', 'git config "$K"', 'git config --get "$K"', 'git remote -v']) expect([c, whys(scan(c)).includes(REASON)]).toEqual([c, false]);
  });
});

describe('round 3, item 5: sort --output and rg --pre', () => {
  const BEFORE = 'before the commit';
  test('sort --output FILE, --output=FILE and its abbreviations write; rg --pre runs a program; plain rg does not', () => {
    for (const c of ['sort --output=README.md real.txt; git commit -a -m "x #1"', 'sort --output README.md real.txt; git commit -a -m "x #1"', 'sort --out=README.md real.txt; git commit -a -m "x #1"', 'sort --o=README.md x; git commit -a -m "x #1"', 'rg --pre sh . ; git commit -a -m "x #1"', 'rg --pre=sh x; git commit -a -m "x #1"', 'rg --hostname-bin=sh x; git commit -a -m "x #1"']) {
      expect([c, whys(scan(c)).includes(BEFORE)]).toEqual([c, true]);
    }
    for (const c of ['sort real.txt | head -1; git commit -a -m "x #1" --allow-empty', 'rg foo . ; git commit -a -m "x #1" --allow-empty', 'sort --reverse x; git commit -a -m "x #1" --allow-empty']) expect([c, scan(c)]).toEqual([c, null]);
  });
});

describe('round 4, item 1: a stdin message is tied to its own commit', () => {
  const NOT_HEREDOC = 'exactly one heredoc of this commit';

  test('a later `< file`, a `cat FILE` operand, a here-string, two heredocs, a second producer: not the heredoc\'s message', () => {
    put(f, 'real.txt', `mail ${CANARY.email} #1\n`);
    for (const c of [
      'git commit --allow-empty -F - <<EOF < real.txt\nfix #1\nEOF',
      'cat real.txt <<EOF | git commit --allow-empty -F -\nfix #1\nEOF',
      'cat <<EOF real.txt | git commit --allow-empty -F -\nfix #1\nEOF',
      'git commit --allow-empty -F - <<< "fix #1"',
      "git commit --allow-empty -F - <<'A' <<'B'\na\nA\nb\nB",
      'cat <<EOF | tee x | git commit --allow-empty -F -\nfix #1\nEOF',
      'echo a | cat <<EOF | git commit --allow-empty -F -\nfix #1\nEOF',
      'cat <<EOF < real.txt | git commit --allow-empty -F -\nfix #1\nEOF',
      'cat <<EOF | git commit --allow-empty -F - < real.txt\nfix #1\nEOF',
      'x="$(cat <<\'EOF\'\nhi\nEOF\n)"\ngit commit --allow-empty -m "$(cat)" < real.txt',
      'x="$(cat <<\'EOF\'\nhi\nEOF\n)"\ngit commit --allow-empty -m "$(cat)"',
    ]) {
      expect([c, whys(scan(c)).includes(NOT_HEREDOC)]).toEqual([c, true]);
    }
  });

  test('a second commit never reuses another commit\'s heredoc', () => {
    put(f, 'real.txt', `mail ${CANARY.email} #1\n`);
    const first = `git commit --allow-empty -F - <<EOF\nfix #1 ${CANARY.phone}\nEOF\n`;
    for (const second of ['git commit --allow-empty -F - < real.txt', `echo '${CANARY.email} #1' | git commit --allow-empty -F -`, 'git commit --allow-empty -F -']) {
      const r = scan(first + second);
      expect([second, whys(r).includes(NOT_HEREDOC), where(r)]).toEqual([second, true, ['<commit message>:1 phone']]);
    }
    // each commit with a heredoc of its own takes its own, in order
    const both = scan(`${first}git commit --allow-empty -F - <<EOF\nmore ${CANARY.card}\nEOF\n`);
    expect(where(both).sort()).toEqual(['<commit message>:1 card', '<commit message>:1 phone']);
    expect(whys(both)).toBe('');
  });

  test('a commit that reads its message from its own stdin heredoc is read: -F -, /dev/stdin, a bare $(cat), a plain cat pipe', () => {
    for (const c of [
      `git commit --allow-empty -F - <<'EOF'\nfix #1 ${CANARY.phone}\nEOF`,
      `git commit --allow-empty -F /dev/stdin <<'EOF'\nfix #1 ${CANARY.phone}\nEOF`,
      `git commit --allow-empty -m "$(cat)" <<'EOF'\nfix #1 ${CANARY.phone}\nEOF`,
      `cat <<'EOF' | git commit --allow-empty -F -\nfix #1 ${CANARY.phone}\nEOF`,
      `cat -u <<'EOF' | git commit --allow-empty -F -\nfix #1 ${CANARY.phone}\nEOF`,
    ]) {
      expect([c, where(scan(c)), whys(scan(c))]).toEqual([c, ['<commit message>:1 phone'], '']);
    }
  });

  test('a shell whose stdin is redirected from a file is not read from its heredoc', () => {
    expect(whys(scan('sh <<EOF < s.sh\ngit push origin main\nEOF'))).toContain('a shell reads its script from stdin or a pipe');
    expect(whys(scan('cat s.sh <<EOF | sh\ngit push origin main\nEOF'))).toContain('a shell reads its script from stdin or a pipe');
    expect(scan('bash <<\'EOF\'\ngit commit --allow-empty -m "x #1"\nEOF')).toBeNull();
  });

  test('many heredocs and a long line of repeated words cost no square', () => {
    const t0 = Date.now();
    scan(`cat <<EOF >/dev/null\nx\nEOF\n${'cat '.repeat(16000)}\ngit commit --allow-empty -F - <<EOF\nx #1\nEOF`);
    scan(`${'cat <<A '.repeat(3000)}\n${'A\n'.repeat(3000)}git commit --allow-empty -m "x #1"`);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('round 4, item 2: who the commit is by', () => {
  const FAKE = 'kim.minsu@naver.com';

  test('the settings and the environment the command gives are scanned as text at <author>', () => {
    for (const [c, hit] of [
      [`git -c user.name=${CANARY.rrn} commit --allow-empty -m "x #1"`, '<author>:1 resident-number'],
      [`git -c user.email=${FAKE} commit --allow-empty -m "x #1"`, '<author>:1 email'],
      [`git -c author.email=${FAKE} commit --allow-empty -m "x #1"`, '<author>:1 email'],
      [`git -c committer.name=${CANARY.phone} commit --allow-empty -m "x #1"`, '<author>:1 phone'],
      [`git commit --allow-empty -m "x #1" --author='${CANARY.rrn} <a@b.example>'`, '<author>:1 resident-number'],
      [`git commit --allow-empty -m "x #1" --author ${CANARY.card}`, '<author>:1 card'],
      [`GIT_AUTHOR_NAME=${CANARY.rrn} git commit --allow-empty -m "x #1"`, '<author>:1 resident-number'],
      [`export GIT_COMMITTER_EMAIL=${FAKE}; git commit --allow-empty -m "x #1"`, '<author>:1 email'],
      [`GIT_COMMITTER_NAME=${CANARY.phone}; git commit --allow-empty -m "x #1"`, '<author>:1 phone'],
      [`env EMAIL=${FAKE} git commit --allow-empty -m "x #1"`, '<author>:1 email'],
    ] as const) {
      expect([c, where(scan(c)).includes(hit)]).toEqual([c, true]);
    }
  });

  test('a value the words do not show is not scanned; one that is no personal data passes', () => {
    for (const c of ['GIT_AUTHOR_NAME="$N" git commit --allow-empty -m "x #1"', 'export EMAIL; git commit --allow-empty -m "x #1"', 'export GIT_AUTHOR_EMAIL="$(whoami)@x.io"; git commit --allow-empty -m "x #1"', 'git -c user.email="$X" commit --allow-empty -m "x #1"', 'git commit --allow-empty -m "x #1" --author="$A"']) {
      expect([c, whys(scan(c)).includes('whose value goodboy cannot see')]).toEqual([c, true]);
    }
    for (const c of ['GIT_AUTHOR_NAME="Some One" git commit --allow-empty -m "x #1"', 'git -c user.name="A B" commit --allow-empty -m "x #1"', 'git commit --allow-empty -m "x #1" --author="A B <a@b.example>"', 'GIT_AUTHOR_DATE=1 git commit --allow-empty -m "x #1"']) expect([c, scan(c)]).toEqual([c, null]);
  });

  test('the exemption is the configured identity, not the command\'s: a -c user.email does not exempt the message', () => {
    const r = scan(`git -c user.email=${FAKE} commit --allow-empty -m "x #1 ${FAKE}"`);
    expect(where(r).sort()).toEqual(['<author>:1 email', '<commit message>:1 email']);
    git(f, ['config', 'user.email', 'Dev@Naver.Com']);
    expect(scan('git commit --allow-empty -m "x #1 dev@naver.com"')).toBeNull();
    expect(where(scan('git -c user.email=other@naver.com commit --allow-empty -m "x #1 other@naver.com"')).sort()).toEqual(['<author>:1 email', '<commit message>:1 email']);
  });

  describe('the commit-msg hook', () => {
    const run = (env: Record<string, string | undefined>): { code: number; text: string } => {
      put(f, 'msg.txt', `work #1 ping ${FAKE}\n`);
      const keys = Object.keys(env);
      const was = keys.map((k) => process.env[k]);
      for (const k of keys) {
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k]!;
      }
      try {
        const r = commitScanCommand(['--hook', 'commit-msg', join(f.repo, 'msg.txt')], f.repo);
        return 'code' in r ? { code: r.code, text: `${'stderr' in r ? r.stderr : ''}` } : { code: -1, text: '' };
      } finally {
        keys.forEach((k, i) => (was[i] === undefined ? delete process.env[k] : (process.env[k] = was[i]!)));
      }
    };

    test('git\'s environment that overrides the identity is scanned at <author>; without one nothing is read', () => {
      git(f, ['config', 'user.email', 'me@naver.com']);
      expect(run({ GIT_AUTHOR_NAME: CANARY.rrn }).text).toContain('<author>:1 resident-number');
      expect(run({ GIT_COMMITTER_EMAIL: 'x@naver.com' }).text).toContain('<author>:1 email');
      expect(run({ GIT_CONFIG_PARAMETERS: `'user.name=${CANARY.phone}'` }).text).toContain('<author>:1 phone');
    });

    test('the configured identity is read without the command\'s settings: a GIT_CONFIG_PARAMETERS or GIT_AUTHOR_EMAIL does not exempt the message', () => {
      git(f, ['config', 'user.email', 'me@naver.com']);
      for (const env of [{ GIT_CONFIG_PARAMETERS: `'user.email=${FAKE}'` }, { GIT_AUTHOR_EMAIL: FAKE }, { GIT_COMMITTER_EMAIL: FAKE }, { EMAIL: FAKE }]) {
        const r = run(env);
        expect([JSON.stringify(env), r.code, r.text.includes('<commit message>:1 email')]).toEqual([JSON.stringify(env), 1, true]);
      }
      git(f, ['config', 'user.email', FAKE]);
      expect(run({}).code).toBe(0);
    });
  });
});

describe('round 4, item 3: lows', () => {
  const REASON = 'it re-points a remote';
  const BEFORE = 'before the commit';

  test('a computed key after a value-taking option, and the git 2.46 subcommands, are re-points', () => {
    for (const c of ['git config --file .git/config "$K" x', 'git config -f .git/config "$K" x', 'git config set "$K" x', 'git config unset "$K"', 'git config remove-section remote.origin', 'git config rename-section remote.origin remote.o2', 'git config set remote.origin.url x', 'git config unset url.x.insteadOf']) {
      expect([c, whys(scan(c)).includes(REASON)]).toEqual([c, true]);
    }
    for (const c of ['git config get remote.origin.url', 'git config list', 'git config --file x.cfg user.name "$V"', 'git config set user.name "$V"', 'git config unset user.name']) expect([c, whys(scan(c)).includes(REASON)]).toEqual([c, false]);
  });

  test('uniq with an output file and git commands that change the tree count as changes before a work-tree commit', () => {
    commit(f, { 'tracked.md': 'x\n' }, 'tracked #1');
    for (const c of ['uniq real.txt tracked.md; git commit -a -m "x #1"', 'git stash pop; git commit -a -m "x #1"', 'git stash; git commit -a -m "x #1"', 'git checkout other -- tracked.md; git commit -a -m "x #1"', 'git switch -; git commit -a -m "x #1"', 'git reset -q; git commit -a -m "x #1"', 'git merge x; git commit -a -m "x #1"', 'git pull; git commit -a -m "x #1"', 'git cherry-pick x; git commit -a -m "x #1"', 'git revert x; git commit -a -m "x #1"', 'git rebase x; git commit -a -m "x #1"', 'git am x; git commit -a -m "x #1"', 'git restore tracked.md; git commit -a -m "x #1"']) {
      expect([c, whys(scan(c)).includes(BEFORE)]).toEqual([c, true]);
    }
    for (const c of ['uniq real.txt; git commit -a -m "x #1" --allow-empty', 'git stash list; git commit -a -m "x #1" --allow-empty', 'git stash show; git commit -a -m "x #1" --allow-empty']) expect([c, scan(c)]).toEqual([c, null]);
  });

  test('only /dev/null, stdout, stderr, tty and fd/N are no file', () => {
    commit(f, { 'tracked.md': 'x\n' }, 'tracked #1');
    for (const c of ['echo hi >/dev/shm/x; git commit -a -m "x #1"', 'echo hi > /dev/shm/x; git commit -a -m "x #1"', 'echo hi >/dev/zero; git commit -a -m "x #1"']) expect([c, whys(scan(c)).includes(BEFORE)]).toEqual([c, true]);
    for (const c of ['echo hi >/dev/null; git commit -a -m "x #1" --allow-empty', 'echo hi >/dev/stderr; git commit -a -m "x #1" --allow-empty', 'echo hi >/dev/tty; git commit -a -m "x #1" --allow-empty', 'echo hi >/dev/fd/2; git commit -a -m "x #1" --allow-empty']) expect([c, scan(c)]).toEqual([c, null]);
  });
});
