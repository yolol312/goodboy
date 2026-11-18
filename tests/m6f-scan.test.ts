// Track M, M6f (plan §19): the commit and push scan on real temp git repos. What a commit would publish (the index, `-a`,
// paths, `--amend`, the message, the paths) and what a push would send (commits behind the remote's head, tags, every
// branch, the commit messages), with a canary of each shape in each place; files that cannot be scanned; the commands
// that run before a commit; which projects are scanned; and the digest the user's approval is bound to.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Acc, commitScanText, DEFAULT_LIMITS, markerHoldsDigest, OBJECT_ID, pushInputFromHook, realDataRootOf, scanCommit, scanPush } from '../lib/commit-scan';
import { commitScanOfCommand, type GuardResult } from '../lib/commit-scan-guard';
import { registerRealData, registryEntryOf } from '../lib/sandbox-registry';
import { sandboxIn } from './m6b-helpers';
import { CANARY, cleanup, commit, type Fixture, fixture, git, KINDS, leaked, put, useEnv, withRemote } from './m6f-helpers';

// Real git repos and spawned processes: slower than the 5 s default on a busy machine.
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
const COMMIT = 'git commit -m "work #1"';
const where = (r: GuardResult | null) => (r?.report.hits ?? []).map((h) => `${h.path}:${h.line} ${h.kind}`);
const whyOf = (r: GuardResult | null) => (r?.report.unscanned ?? []).map((u) => `${u.path} (${u.why})`);
/** Nothing of the result may carry a canary: its JSON, and the denial text built from it. */
const clean = (r: GuardResult | null): void => {
  if (r === null) return;
  expect(leaked(JSON.stringify(r.report))).toBeNull();
  expect(leaked(commitScanText(r.report, r.what, ' tail'))).toBeNull();
};

describe('a commit: the index', () => {
  test('each shape in a staged file is a hit with its path, line and kind', () => {
    for (const [name, value] of Object.entries(CANARY)) {
      put(f, 'notes.txt', `a\nb\nvalue: ${value}\n`);
      git(f, ['add', 'notes.txt']);
      const r = scan(COMMIT);
      expect([name, where(r)]).toEqual([name, [`notes.txt:3 ${KINDS[name as keyof typeof KINDS]}`]]);
      expect(r!.what).toBe('git commit');
      clean(r);
    }
  });

  test('a clean staged file passes; so does a commit with nothing staged', () => {
    put(f, 'ok.txt', 'nothing here\nuser@example.com is reserved; 12-34-56 is no number\n');
    git(f, ['add', 'ok.txt']);
    expect(scan(COMMIT)).toBeNull();
    git(f, ['reset', '-q']);
    expect(scan(COMMIT)).toBeNull();
  });

  test('a plain commit publishes the index: an unstaged edit of a tracked file is not part of it', () => {
    put(f, 'README.md', `readme ${CANARY.phone}\n`);
    expect(scan(COMMIT)).toBeNull();
    git(f, ['add', 'README.md']);
    expect(where(scan(COMMIT))).toEqual(['README.md:1 phone']);
  });

  test('an unchanged file is not read again: only what differs from HEAD', () => {
    commit(f, { 'old.txt': `old ${CANARY.email}\n` }, 'old #1');
    put(f, 'new.txt', 'new\n');
    git(f, ['add', 'new.txt']);
    expect(scan(COMMIT)).toBeNull();
  });

  test('a symlink is scanned as its target, the way git stores it', () => {
    symlinkSync(`/tmp/${CANARY.email}`, join(f.repo, 'link'));
    git(f, ['add', 'link']);
    expect(where(scan(COMMIT))).toEqual(['link:1 email']);
  });
});

describe('a commit: -a, paths, --amend', () => {
  beforeEach(() => {
    commit(f, { 'clean.txt': 'clean\n', 'other.txt': 'other\n' }, 'two files #1');
  });

  test('-a scans the tracked files as the work tree has them, and not an untracked file', () => {
    put(f, 'clean.txt', `clean ${CANARY.rrn}\n`);
    put(f, 'untracked.txt', `x ${CANARY.email}\n`);
    expect(scan(COMMIT)).toBeNull();
    for (const c of ['git commit -am "x #1"', 'git commit -a -m "x #1"', 'git commit --all -m "x #1"']) expect([c, where(scan(c))]).toEqual([c, ['clean.txt:1 resident-number']]);
  });

  test('-a: the work tree wins over what is staged for the file', () => {
    put(f, 'clean.txt', `staged ${CANARY.phone}\n`);
    git(f, ['add', 'clean.txt']);
    put(f, 'clean.txt', 'clean again\n');
    expect(scan('git commit -a -m "x #1"')).toBeNull();
    expect(where(scan(COMMIT))).toEqual(['clean.txt:1 phone']);
  });

  test('paths: the work tree of those paths, and not what else is staged', () => {
    put(f, 'clean.txt', `clean ${CANARY.card}\n`);
    put(f, 'other.txt', `other ${CANARY.email}\n`);
    git(f, ['add', 'other.txt']);
    for (const c of ['git commit -m "x #1" clean.txt', 'git commit -m "x #1" -- clean.txt', 'git commit --only -m "x #1" clean.txt', 'git commit -om "x #1" clean.txt']) {
      expect([c, where(scan(c))]).toEqual([c, ['clean.txt:1 card']]);
    }
  });

  test('--include: the work tree wins over the index for a path both name', () => {
    put(f, 'clean.txt', `staged ${CANARY.phone}\n`);
    git(f, ['add', 'clean.txt']);
    put(f, 'clean.txt', 'clean again\n');
    expect(scan('git commit -i clean.txt -m "x #1"')).toBeNull();
    put(f, 'clean.txt', `now ${CANARY.card}\n`);
    expect(where(scan('git commit -i clean.txt -m "x #1"'))).toEqual(['clean.txt:1 card']);
  });

  test('a work-tree file of a binary type is not scanned either (-a)', () => {
    commit(f, { 'logo.png': 'v1\n' }, 'logo #1');
    put(f, 'logo.png', 'v2\n');
    expect(whyOf(scan('git commit -a -m "x #1"'))).toEqual(['logo.png (binary file type)']);
  });

  test('--include: the index and those paths', () => {
    put(f, 'clean.txt', `clean ${CANARY.card}\n`);
    put(f, 'other.txt', `other ${CANARY.email}\n`);
    git(f, ['add', 'other.txt']);
    expect(where(scan('git commit -i clean.txt -m "x #1"'))).toEqual(['clean.txt:1 card', 'other.txt:1 email']);
  });

  test('--amend compares with the parent: the commit it replaces counts', () => {
    commit(f, { 'leak.txt': `leak ${CANARY.secret}\n` }, 'leak #1');
    expect(scan('git commit -m "y #1" --allow-empty')).toBeNull();
    expect(where(scan('git commit --amend -m "y #1"'))).toEqual(['leak.txt:1 secret']);
    expect(where(scan('git commit --amend --no-edit'))).toEqual(['leak.txt:1 secret']);
  });

  test('an amend of the first commit compares with the empty tree', () => {
    const g = fixture({ realData: true });
    put(g, 'a.txt', `${CANARY.email}\n`);
    git(g, ['add', 'a.txt']);
    git(g, ['commit', '-q', '--amend', '-m', 'init #1']);
    const r = commitScanOfCommand('git commit --amend --no-edit', g.repo, g.repo, { env: g.env });
    expect(where(r).sort()).toEqual(['a.txt:1 email']);
  });

  test('before the first commit the base is the empty tree', () => {
    const g = fixture({ realData: true });
    git(g, ['update-ref', '-d', 'HEAD']);
    git(g, ['rm', '-q', '--cached', 'README.md']);
    put(g, 'first.txt', `x ${CANARY.phone}\n`);
    git(g, ['add', 'first.txt']);
    expect(where(commitScanOfCommand(COMMIT, g.repo, g.repo, { env: g.env }))).toEqual(['first.txt:1 phone']);
  });

  test('--dry-run publishes nothing', () => {
    put(f, 'other.txt', `${CANARY.email}\n`);
    git(f, ['add', 'other.txt']);
    expect(scan('git commit --dry-run -m "x #1"')).toBeNull();
  });
});

describe('a commit: the message and the paths', () => {
  test('-m, --message=, a trailer and a -F file each carry a hit at the message line', () => {
    put(f, 'msg.txt', `fix #1\n\ncall ${CANARY.phone}\n`);
    const forms = [
      `git commit -m "fix #1" -m "call ${CANARY.phone}" --allow-empty`,
      `git commit --message="call ${CANARY.phone}" --allow-empty`,
      `git commit -m "fix #1" --trailer "See-also: ${CANARY.email}" --allow-empty`,
      `git commit -F ${join(f.repo, 'msg.txt')} --allow-empty`,
      'git commit -F msg.txt --allow-empty',
      `git commit -am"x ${CANARY.rrn}" --allow-empty`,
    ];
    for (const c of forms) {
      const r = scan(c);
      expect([c, r?.report.hits.map((h) => h.path)]).toEqual([c, ['<commit message>']]);
      clean(r);
    }
    expect(where(scan(forms[3]!))).toEqual(['<commit message>:3 phone']);
  });

  test('a heredoc message, in a substitution or on stdin', () => {
    const sub = `git commit -m "$(cat <<'EOF'\nfix #1\n\nphone ${CANARY.phone}\nEOF\n)"`;
    expect(where(scan(sub))).toEqual(['<commit message>:3 phone']);
    const stdin = `git commit -F - <<'EOF'\nfix #1\n${CANARY.email}\nEOF\n`;
    expect(where(scan(stdin))).toEqual(['<commit message>:2 email']);
  });

  test('a message known only when it runs is not scanned: a variable, a computed substitution', () => {
    const forms: Array<[string, string]> = [
      ['git commit --allow-empty -m "$MSG #1"', 'built from a shell variable'],
      ['git commit --allow-empty -m "${MSG} #1"', 'built from a shell variable'],
      ['git commit --allow-empty -m "$(git log -1 --format=%s) #1"', 'computed by a command'],
      ['git commit --allow-empty -m "$(date)"', 'computed by a command'],
    ];
    for (const [c, why] of forms) expect([c, whyOf(scan(c)).join().includes(why)]).toEqual([c, true]);
    // a heredoc is read, and a literal dollar amount is no variable
    expect(scan(`git commit --allow-empty -m "$(cat <<'EOF'\nfix #1 costs 5 dollars\nEOF\n)"`)).toBeNull();
    expect(scan('git commit --allow-empty -m "price $5 #1"')).toBeNull();
  });

  test('a message file that cannot be read is not scanned', () => {
    expect(whyOf(scan('git commit -F nowhere.txt --allow-empty'))).toEqual(['<message file> (the message file cannot be read)']);
  });

  test('a path with a shape is a hit at line 0 and is shown redacted', () => {
    put(f, `exports/${CANARY.phone}.csv`, 'x\n');
    git(f, ['add', '-A']);
    const r = scan(COMMIT);
    expect(where(r)).toEqual(['exports/[redacted:phone].csv:0 phone']);
    clean(r);
    expect(JSON.stringify(r)).not.toContain(CANARY.phone);
  });

  test('a path that holds a value is redacted in the not-scanned list too', () => {
    put(f, `${CANARY.phone}.png`, 'x\n');
    git(f, ['add', '-A']);
    const r = scan(COMMIT);
    expect(whyOf(r)).toEqual(['[redacted:phone].png (binary file type)']);
    clean(r);
  });
});

describe('names that are special to a JavaScript object', () => {
  test('files and refs called __proto__, constructor and toString are scanned like any other', () => {
    for (const n of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '__proto__.json']) put(f, n, `v ${CANARY.email} in ${n}\n`);
    git(f, ['add', '-A']);
    expect(where(scan(COMMIT)).sort()).toEqual(['__proto__.json:1 email', '__proto__:1 email', 'constructor:1 email', 'hasOwnProperty:1 email', 'toString:1 email']);
    const r = Object.getPrototypeOf(scan(COMMIT)!.report) as object;
    expect(Object.keys(r)).toEqual([]);
    // a pushed ref of that name
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
    git(f, ['commit', '-q', '--no-verify', '-m', 'p #1']);
    git(f, ['branch', '__proto__']);
    expect(where(scan('git push origin __proto__'))).toHaveLength(5);
  });
});

describe('not scanned', () => {
  test('binary content, a binary file type, text that is not UTF-8 and a file over the limit are each "not scanned"', () => {
    put(f, 'blob.dat', Buffer.from([1, 2, 0, 3, 4]));
    put(f, 'logo.png', 'x\n');
    put(f, 'latin.txt', Buffer.from([0x63, 0xe9, 0x20, 0x66, 0xff]));
    put(f, 'big.txt', 'x'.repeat(100));
    git(f, ['add', '-A']);
    const r = scan(COMMIT, f.repo, { limits: { ...DEFAULT_LIMITS, maxBlob: 50 } });
    expect(whyOf(r).sort()).toEqual(['big.txt (over the size limit)', 'blob.dat (binary content)', 'latin.txt (not valid UTF-8)', 'logo.png (binary file type)']);
    expect(r!.report.blocked).toBe(true);
    expect(r!.report.hits).toEqual([]);
  });

  test('a work-tree file over the limit and one that cannot be read are not scanned (-a)', () => {
    commit(f, { 'big.txt': 'x\n', 'gone.txt': 'y\n', 'ok.txt': 'z\n' }, 'files #1');
    put(f, 'big.txt', 'x'.repeat(100));
    chmodSync(put(f, 'gone.txt', 'changed\n'), 0o000);
    try {
      const r = scan('git commit -a -m "x #1"', f.repo, { limits: { ...DEFAULT_LIMITS, maxBlob: 50 } });
      // running as root reads a mode-000 file; then there is only the big file
      expect(whyOf(r)).toContain('big.txt (over the size limit)');
      if (process.getuid?.() !== 0) expect(whyOf(r)).toContain('gone.txt (file not readable)');
    } finally {
      chmodSync(join(f.repo, 'gone.txt'), 0o644);
    }
  });

  test('a budget that runs out is one entry for what is left', () => {
    put(f, 'a.txt', 'a\n');
    put(f, 'b.txt', 'b\n');
    put(f, 'c.txt', 'c\n');
    git(f, ['add', '-A']);
    const few = scan(COMMIT, f.repo, { limits: { ...DEFAULT_LIMITS, maxBlobs: 1 } });
    expect(whyOf(few)).toEqual(['<2 objects> (the size budget ran out)']);
    const bytes = scan(COMMIT, f.repo, { limits: { ...DEFAULT_LIMITS, maxBytes: 4 } });
    expect(whyOf(bytes)).toEqual(['<1 objects> (the size budget ran out)']);
    // what the budget skipped is part of the digest (an approval is bound to it)
    expect(few!.report.digest).not.toBe(bytes!.report.digest);
    expect(few!.report.digest).not.toBe(scan(COMMIT, f.repo, { limits: { ...DEFAULT_LIMITS, maxBlobs: 2 } })!.report.digest);
  });

  test('the time budget: spent before the listing it blocks, spent after it the rest is one entry', () => {
    put(f, 'a.txt', 'a\n');
    put(f, 'b.txt', 'b\n');
    put(f, 'c.txt', 'c\n');
    git(f, ['add', '-A']);
    expect(whyOf(scan(COMMIT, f.repo, { limits: { ...DEFAULT_LIMITS, timeMs: -1 } }))).toEqual(['<commit> (git could not list the files of this commit)']);
    const acc = new Acc();
    let asked = 0;
    // three blobs are taken, then the batch finds the time spent
    acc.expired = () => asked++ >= 3;
    scanCommit({ dir: f.repo, globals: [], mode: 'index', paths: [], amend: false, messages: [], files: [], unclear: [], identity: [] }, acc);
    expect(acc.report().unscanned).toEqual([{ path: '<3 objects>', why: 'the time budget ran out' }]);
    // a push: the message batch finds it too
    commit(f, { 'd.txt': 'd\n' }, 'd #1');
    const acc2 = new Acc();
    acc2.expired = () => true;
    scanPush({ dir: f.repo, globals: [], remote: null, revs: ['HEAD'], flags: [], excluding: [], unclear: [] }, acc2);
    expect(acc2.report().unscanned.map((u) => u.why)).toEqual(['the time budget ran out']);
  });

  test('what cannot be read exactly is not scanned: an interactive commit, a pathspec file, a message on stdin, the environment', () => {
    const forms: Array<[string, string]> = [
      ['git commit -p -m "x #1"', 'an interactive commit'],
      ['git commit --interactive', 'an interactive commit'],
      ['git commit --pathspec-from-file=list.txt -m "x #1"', 'takes its paths from a file'],
      ['git commit -F - -m "x #1"', 'read from stdin'],
      ['git commit -a -m "x #1" clean.txt', 'combines -a with paths'],
      ['GIT_DIR=.git git commit -m "x #1"', 'comes from the environment'],
      ['git --config-env=core.x=Y commit -m "x #1"', 'comes from the environment'],
    ];
    for (const [c, why] of forms) {
      const r = scan(c);
      expect([c, r?.report.unscanned.map((u) => u.why).join(' | ').includes(why)]).toEqual([c, true]);
    }
  });
});

describe('what runs before the commit in one command', () => {
  test('a git command that changes the index or the tree is "not scanned": run it as its own command first', () => {
    put(f, 'clean.txt', `${CANARY.email}\n`);
    for (const c of ['git add -A && git commit -m "x #1"', 'git add clean.txt; git commit -m "x #1"', 'git rm -q README.md && git commit -m "x #1"', 'git checkout -q main && git commit -m "x #1"']) {
      const r = scan(c);
      expect([c, whyOf(r).join().includes('before the commit')]).toEqual([c, true]);
    }
    // the message says which command, with no value
    expect(whyOf(scan('git add -A && git commit -m "x #1"'))).toEqual(['<commit> (it runs `git add` before the commit, which can change what the commit reads, and goodboy checks the command before it runs (run that part as its own command first))']);
  });

  test('reads and shell builtins before it are no change; a program counts only for a commit that reads the work tree', () => {
    put(f, 'other.txt', 'x\n');
    git(f, ['add', '-A']);
    for (const c of ['git status && git commit -m "x #1"', 'cd . && git log -1 && echo done && git commit -m "x #1"', 'npm test && git commit -m "x #1"', 'git diff --stat | cat; git commit -m "x #1"']) {
      expect([c, scan(c)]).toEqual([c, null]);
    }
    const r = scan('npm test && git commit -am "x #1"');
    expect(whyOf(r).join()).toContain('runs `npm` before the commit');
  });

  test('a shell -c, eval and xargs run another segment, which is read on its own; a shell running a file is a program', () => {
    commit(f, { 'clean.txt': 'clean\n' }, 'clean #1');
    put(f, 'clean.txt', `${CANARY.card}\n`);
    // the hit alone would also come with a mover: nothing may be left "not scanned"
    for (const c of ['sh -c \'git commit -am "x #1"\'', 'echo a | xargs git commit -a -m "x #1"', 'eval \'git commit -a -m "x #1"\'']) {
      const r = scan(c);
      expect([c, where(r), whyOf(r)]).toEqual([c, ['clean.txt:1 card'], []]);
    }
    expect(whyOf(scan('bash release.sh && git commit -am "x #1"')).join()).toContain('runs `bash` before the commit');
  });

  test('a loop or a function may run any segment first', () => {
    const r = scan('for i in 1; do git commit -m "x #1"; done; git add -A');
    expect(whyOf(r).join()).toContain('runs `git add` before the commit');
  });

  test('an earlier commit of the same command is scanned with it, not counted as a change', () => {
    put(f, 'other.txt', `${CANARY.phone}\n`);
    git(f, ['add', '-A']);
    const r = scan('git commit -m "a #1" && git commit -m "b #1" --allow-empty');
    expect(where(r)).toEqual(['other.txt:1 phone']);
  });
});

describe('a push', () => {
  beforeEach(() => {
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
  });

  test('every commit that is not on the remote is scanned, also the ones behind HEAD', () => {
    commit(f, { 'leak.txt': `a ${CANARY.email}\n` }, 'leak #1');
    commit(f, { 'fine.txt': 'fine\n' }, 'fine #1');
    commit(f, { 'fine2.txt': 'fine\n' }, 'fine2 #1');
    for (const c of ['git push', 'git push origin main', 'git push origin HEAD', 'git push -u origin main', 'git push origin main:refs/heads/other']) {
      const r = scan(c);
      expect([c, where(r)]).toEqual([c, ['leak.txt:1 email']]);
      expect(r!.what).toBe('git push');
      clean(r);
    }
  });

  test('what the remote has already is not scanned', () => {
    commit(f, { 'leak.txt': `a ${CANARY.email}\n` }, 'leak #1');
    expect(scan('git push')).not.toBeNull();
    git(f, ['push', '-q', 'origin', 'main']);
    expect(scan('git push')).toBeNull();
  });

  test('the commit messages of what is sent are scanned, the author address is not', () => {
    commit(f, { 'a.txt': 'a\n' }, `call ${CANARY.phone} #1`);
    const r = scan('git push');
    expect(r!.report.hits.map((h) => `${h.path.replace(/[0-9a-f]{7}/, 'ID')}:${h.line} ${h.kind}`)).toEqual(['<commit message ID>:1 phone']);
    clean(r);
    // the author and committer lines name me@corp.io: no hit for them
    expect(r!.report.hits).toHaveLength(1);
  });

  test('a tag push sends the tag and what only it reaches', () => {
    git(f, ['checkout', '-q', '-b', 'side']);
    commit(f, { 'leak.txt': `a ${CANARY.secret}\n` }, 'leak #1');
    git(f, ['tag', '-a', 'v1', '-m', 'v1 #1']);
    git(f, ['checkout', '-q', 'main']);
    expect(scan('git push origin main')).toBeNull();
    for (const c of ['git push origin v1', 'git push origin refs/tags/v1', 'git push origin tag v1', 'git push --tags', 'git push origin --follow-tags']) {
      const r = scan(c);
      expect([c, where(r), whyOf(r)]).toEqual([c, ['leak.txt:1 secret'], []]);
    }
  });

  test('--all and --branches send every branch, --mirror too; naming main sends only main', () => {
    git(f, ['checkout', '-q', '-b', 'side']);
    commit(f, { 'leak.txt': `a ${CANARY.card}\n` }, 'leak #1');
    git(f, ['checkout', '-q', 'main']);
    expect(scan('git push origin main')).toBeNull();
    expect(scan('git push')).toBeNull();
    for (const c of ['git push --all', 'git push --all origin', 'git push --branches', 'git push --mirror origin', 'git push origin "refs/heads/*:refs/heads/*"', 'git push --repo=origin']) {
      expect([c, where(scan(c))]).toEqual([c, ['leak.txt:1 card']]);
    }
  });

  test('config that decides what is sent: matching, a remote.<name>.push refspec', () => {
    git(f, ['checkout', '-q', '-b', 'side']);
    commit(f, { 'leak.txt': `a ${CANARY.card}\n` }, 'leak #1');
    git(f, ['checkout', '-q', 'main']);
    git(f, ['config', 'push.default', 'matching']);
    expect(where(scan('git push'))).toEqual(['leak.txt:1 card']);
    git(f, ['config', '--unset', 'push.default']);
    expect(scan('git push')).toBeNull();
    expect(where(scan('git -c remote.origin.push=refs/heads/side:refs/heads/side push'))).toEqual(['leak.txt:1 card']);
  });

  test('a deletion and a dry run send nothing; a ref that does not resolve is not scanned', () => {
    commit(f, { 'leak.txt': `a ${CANARY.card}\n` }, 'leak #1');
    expect(scan('git push origin :old')).toBeNull();
    expect(scan('git push origin --delete old')).toBeNull();
    expect(scan('git push --dry-run')).toBeNull();
    expect(scan('git push -n')).toBeNull();
    expect(whyOf(scan('git push origin nothere'))).toEqual(['<pushed ref 1> (a pushed ref does not resolve to an object)']);
  });

  test('a push to a URL scans what no remote-tracking ref has', () => {
    commit(f, { 'leak.txt': `a ${CANARY.card}\n` }, 'leak #1');
    git(f, ['push', '-q', 'origin', 'main']);
    expect(scan('git push origin main')).toBeNull();
    expect(scan(`git push ${join(f.base, 'origin.git')} main`)).toBeNull();
    // another remote name with no tracking refs: everything is outgoing
    const other = join(f.base, 'other.git');
    mkdirSync(other);
    git(f, ['init', '-q', '--bare', other], { cwd: f.base });
    git(f, ['remote', 'add', 'second', other]);
    expect(where(scan('git push second main'))).toEqual(['leak.txt:1 card']);
  });

  test('a push after a command that changes commits is not scanned; a commit in the same command is scanned with it', () => {
    commit(f, { 'a.txt': 'a\n' }, 'a #1');
    for (const c of ['git merge -q other && git push', 'git reset --hard HEAD~1 && git push', 'npm version patch && git push', 'git tag v9 && git push --tags']) {
      const r = scan(c);
      expect([c, whyOf(r).join().includes('before the push')]).toEqual([c, true]);
    }
    expect(scan('git status && git push')).toBeNull();
    put(f, 'b.txt', `x ${CANARY.phone}\n`);
    git(f, ['add', 'b.txt']);
    const r = scan('git commit -m "b #1" && git push');
    expect(where(r)).toEqual(['b.txt:1 phone']);
    expect(r!.what).toBe('git commit and git push');
  });

  test('the objects of a hook push come from the refs git passes; deleted refs and bad lines are handled', () => {
    commit(f, { 'leak.txt': `a ${CANARY.email}\n` }, 'leak #1');
    const head = git(f, ['rev-parse', 'HEAD']).out.trim();
    const zero = '0'.repeat(40);
    const input = pushInputFromHook(f.repo, 'origin', `refs/heads/main ${head} refs/heads/main ${zero}\nrefs/heads/gone ${zero} refs/heads/gone ${head}\nbroken line\n`);
    expect(input.revs).toEqual([head]);
    expect(input.excluding).toEqual([head]);
    expect(input.unclear).toEqual(['a ref line git gave the hook is not one goodboy can read']);
    expect(OBJECT_ID.test(head)).toBe(true);
    const acc = new Acc();
    scanPush({ ...input, excluding: [] }, acc);
    expect(acc.report().hits.map((h) => h.kind)).toEqual(['email']);
  });
});

describe('which commands and which projects', () => {
  test('a project that holds no real data is not scanned', () => {
    const g = fixture();
    put(g, 'a.txt', `${CANARY.email}\n`);
    git(g, ['add', 'a.txt']);
    expect(commitScanOfCommand(COMMIT, g.repo, g.repo, { env: g.env })).toBeNull();
    expect(realDataRootOf(g.repo, g.env)).toBeNull();
  });

  test('a project whose sandbox says no real data is not scanned, and one whose local file cannot be read is', () => {
    const g = fixture();
    sandboxIn(g.repo, { dump: null, dumpFormat: null, realData: false });
    put(g, 'a.txt', `${CANARY.email}\n`);
    git(g, ['add', 'a.txt']);
    expect(commitScanOfCommand(COMMIT, g.repo, g.repo, { env: g.env })).toBeNull();
    sandboxIn(g.repo, '{ not json');
    expect(where(commitScanOfCommand(COMMIT, g.repo, g.repo, { env: g.env }))).toEqual(['a.txt:1 email']);
  });

  test('a project the user-level registry holds is scanned although its local file is gone', () => {
    const g = fixture();
    put(g, 'a.txt', `${CANARY.email}\n`);
    git(g, ['add', 'a.txt']);
    expect(registerRealData(registryEntryOf(g.repo, { dump: null, dumpFormat: null, realData: true }), g.env)).toBeNull();
    expect(where(commitScanOfCommand(COMMIT, g.repo, g.repo, { env: g.env }))).toEqual(['a.txt:1 email']);
    expect(realDataRootOf(join(g.repo, 'sub', 'deeper'), g.env)).toBe(g.repo);
  });

  test('git -C reaches another repo: scanned when that repo holds real data, wherever the shell is', () => {
    put(f, 'a.txt', `${CANARY.email}\n`);
    git(f, ['add', 'a.txt']);
    const plain = fixture();
    // the shell is in a project with no real data; the registry names the other
    expect(scan(`git -C ${f.repo} commit -m "x #1"`, plain.repo)).toBeNull();
    expect(registerRealData(registryEntryOf(f.repo, { dump: null, dumpFormat: null, realData: true }), f.env)).toBeNull();
    expect(where(scan(`git -C ${f.repo} commit -m "x #1"`, plain.repo))).toEqual(['a.txt:1 email']);
    expect(where(scan(`cd ${f.repo} && git commit -m "x #1"`, plain.repo))).toEqual(['a.txt:1 email']);
    // a repo that is not real data is not scanned, from a real-data shell either
    put(plain, 'p.txt', `${CANARY.email}\n`);
    git(plain, ['add', 'p.txt']);
    expect(scan(`git -C ${plain.repo} commit -m "x #1"`, f.repo)).toBeNull();
  });

  test('aliases, shells, xargs and the rtk proxy are read to the commit', () => {
    put(f, 'a.txt', `${CANARY.email}\n`);
    git(f, ['add', 'a.txt']);
    git(f, ['config', 'alias.ci', 'commit -m "ali #1"']);
    for (const c of ['git ci', 'git -c alias.zz=commit zz -m "x #1"', 'sh -c \'git commit -m "x #1"\'', 'rtk git commit -m "x #1"', 'rtk proxy git commit -m "x #1"', 'echo a | xargs git commit -m "x #1"', 'GIT_AUTHOR_NAME=a git commit -m "x #1"']) {
      expect([c, where(scan(c))]).toEqual([c, ['a.txt:1 email']]);
    }
  });

  test('what is no commit and no push is not scanned: status, add, log, a dry run', () => {
    put(f, 'a.txt', `${CANARY.email}\n`);
    git(f, ['add', 'a.txt']);
    for (const c of ['git status', 'git add -A', 'git log -1', 'git diff --cached', 'echo hello', 'ls', 'git commit --dry-run -m "x #1"', 'git stash list']) expect([c, scan(c)]).toEqual([c, null]);
  });

  test('a command the reader cannot follow, run in a real-data project, is not scanned', () => {
    const r = scan('eval "$(printf \'git commit -m x\')"');
    // the general reason, and the word the eval runs: a substitution that stands where the program is
    expect(whyOf(r)).toEqual([
      '<command> (goodboy cannot read this command well enough to tell what it commits or pushes)',
      '<command> (a command word is built at run time (a variable or a substitution), so what runs is not known)',
    ]);
    // elsewhere it is nothing
    const g = fixture();
    expect(commitScanOfCommand('eval "$(printf \'git commit -m x\')"', g.repo, g.repo, { env: g.env })).toBeNull();
  });

  test('a command that makes goodboy read more git config than a call may is not scanned in a real-data shell', () => {
    const many = Array.from({ length: 12 }, (_, i) => `git zz${i} 1`).join('; ');
    expect(whyOf(scan(`${many}; git commit -m "x #1"`))).toEqual(['<command> (goodboy cannot read this command well enough to tell what it commits or pushes)']);
  });

  test('a git command whose repo cannot be told is not scanned in a real-data shell only', () => {
    expect(whyOf(scan('git -C "$REPO" commit -m "x #1"'))).toEqual(['<command> (goodboy cannot tell which repository a git command in this command runs in)']);
    const g = fixture();
    expect(commitScanOfCommand('git -C "$REPO" commit -m "x #1"', g.repo, g.repo, { env: g.env })).toBeNull();
  });

  test('a scan that fails inside a real-data project is not clean', () => {
    put(f, 'a.txt', 'a\n');
    git(f, ['add', 'a.txt']);
    const broken = new Proxy({ ...DEFAULT_LIMITS }, { get: (t, k) => (k === 'maxBlob' ? (() => { throw new Error('boom'); })() : t[k as keyof typeof t]) });
    expect(whyOf(scan(COMMIT, f.repo, { limits: broken }))).toEqual(['<command> (the scan failed)']);
  });

  test('more than six commits or pushes in one command are not all scanned', () => {
    const r = scan(Array.from({ length: 8 }, () => 'git commit --allow-empty -m "x #1"').join(' && '));
    expect(whyOf(r)).toEqual(['<command> (this command runs more than 6 git commits and pushes)']);
  });

  test('a repo that git cannot read is not scanned (fail closed)', () => {
    const dir = join(f.base, 'plain');
    mkdirSync(join(dir, '.goodboy', 'sandbox'), { recursive: true });
    writeFileSync(join(dir, '.goodboy', 'sandbox', 'local.json'), JSON.stringify({ dump: null, dumpFormat: null, realData: true }));
    const r = scan('git commit -m "x #1"', dir);
    expect(whyOf(r)).toEqual(['<repository> (git could not tell the repository of this commit)']);
  });
});

describe('a very large report', () => {
  test('hits past the cap are counted, listed as "more", and keep the call blocked', () => {
    put(f, 'many.txt', Array.from({ length: 5100 }, (_, i) => `u${i}@naver.com`).join('\n'));
    git(f, ['add', 'many.txt']);
    const r = scan(COMMIT)!;
    expect(r.report.hits).toHaveLength(5000);
    expect(r.report.moreHits).toBe(100);
    expect(r.report.blocked).toBe(true);
    const text = commitScanText(r.report, r.what, '');
    expect(text).toContain('Matches (5100): many.txt:1 email');
    expect(text).toContain('and 5080 more');
    // the digest counts what is not listed: one more hit is another digest
    put(f, 'many.txt', Array.from({ length: 5101 }, (_, i) => `u${i}@naver.com`).join('\n'));
    git(f, ['add', 'many.txt']);
    expect(scan(COMMIT)!.report.digest).not.toBe(r.report.digest);
  });

  test('a commit or tag message over the size limit is not read', () => {
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
    git(f, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `big #1\n\n${'x'.repeat(200)}`]);
    const r = scan('git push', f.repo, { limits: { ...DEFAULT_LIMITS, maxBlob: 100 } });
    expect(whyOf(r).map((w) => w.replace(/[0-9a-f]{7}/, 'ID'))).toEqual(['<commit message ID> (over the size limit)']);
  });
});

describe('the digest the approval is bound to', () => {
  test('the same content is the same digest, whatever order the files are in; other content is another', () => {
    put(f, 'a.txt', `${CANARY.email}\n`);
    put(f, 'b.txt', `${CANARY.phone}\n`);
    git(f, ['add', '-A']);
    const first = scan(COMMIT)!.report.digest;
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(scan(COMMIT)!.report.digest).toBe(first);
    put(f, 'a.txt', `${CANARY.email}\nmore\n`);
    git(f, ['add', '-A']);
    expect(scan(COMMIT)!.report.digest).not.toBe(first);
    put(f, 'a.txt', `${CANARY.email}\n`);
    git(f, ['add', '-A']);
    expect(scan(COMMIT)!.report.digest).toBe(first);
  });

  test('the digest differs for a message hit, a path hit and a not-scanned file with the same name', () => {
    put(f, 'x.txt', `${CANARY.email}\n`);
    git(f, ['add', '-A']);
    const file = scan(COMMIT)!.report.digest;
    const msg = scan(`git commit --allow-empty -m "${CANARY.email}"`, f.repo)!.report.digest;
    expect(file).not.toBe(msg);
  });

  test('a work-tree file and the same content staged give one digest (blob ids both)', () => {
    commit(f, { 'a.txt': 'a\n' }, 'a #1');
    put(f, 'a.txt', `${CANARY.email}\n`);
    const viaWork = scan('git commit -a -m "x #1"')!.report.digest;
    git(f, ['add', 'a.txt']);
    expect(scan(COMMIT)!.report.digest).toBe(viaWork);
  });

  test('markerHoldsDigest: exactly the digest, a plain file, a short file', () => {
    const p = join(f.base, 'marker.txt');
    writeFileSync(p, 'abcdef0123456789\n');
    expect(markerHoldsDigest(p, 'abcdef0123456789')).toBe(true);
    expect(markerHoldsDigest(p, 'abcdef0123456780')).toBe(false);
    writeFileSync(p, '');
    expect(markerHoldsDigest(p, 'abcdef0123456789')).toBe(false);
    writeFileSync(p, `abcdef0123456789${' '.repeat(300)}`);
    expect(markerHoldsDigest(p, 'abcdef0123456789')).toBe(false);
    expect(markerHoldsDigest(join(f.base, 'absent'), 'abcdef0123456789')).toBe(false);
    writeFileSync(p, 'abcdef0123456789\n');
    const link = join(f.base, 'link.txt');
    symlinkSync(p, link);
    expect(markerHoldsDigest(link, 'abcdef0123456789')).toBe(false);
    rmSync(link);
  });
});

describe('the denial text', () => {
  test('lists up to 20 entries as path:line kind, counts the rest, and never prints a value', () => {
    for (let i = 0; i < 25; i++) put(f, `f${String(i).padStart(2, '0')}.txt`, `v ${CANARY.email}\n`);
    put(f, 'blob.bin', Buffer.from([0, 1]));
    git(f, ['add', '-A']);
    const r = scan(COMMIT)!;
    const text = commitScanText(r.report, r.what, ' TAIL');
    expect(text).toContain('Matches (25): f00.txt:1 email');
    expect(text).toContain('and 5 more');
    expect(text).toContain('Not scanned (1): blob.bin (binary file type)');
    expect(text.endsWith(' TAIL')).toBe(true);
    expect(text.match(/f\d\d\.txt:1 email/g)).toHaveLength(20);
    expect(leaked(text)).toBeNull();
  });
});
