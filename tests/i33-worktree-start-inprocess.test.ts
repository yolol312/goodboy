// v0.36.7 (#33): the start-pin code run in this process. tests/i33-worktree-start.test.ts drives
// the real SessionStart, PostToolUse and Stop hooks as child processes, which the coverage tool
// cannot see; this file calls the same library functions directly, on real git repositories and
// worktrees in temp dirs and a real session dir, so every changed line of lib/start-pins.ts,
// lib/changed-coverage.ts, lib/session-criteria.ts and lib/project-dir.ts runs in the test process
// and its result is asserted:
//   - the shared worktree list, nearestGitTop, writeOnce, the readers of the session's files and the
//     catches that keep a hook alive when the session dir cannot be used;
//   - the git dir that git names and the file system does not hold;
//   - first-sight pins whose changes cannot be recorded, and a checkout made again with an empty start;
//   - nestedWorktreeStarts, incompleteStart, noteSessionTop, resolvedAsProject and the criteria of the
//     worktrees that exist at the session's start.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { incompleteStart, noteSessionTop, pinCoverageStart } from '../lib/changed-coverage';
import { resetGitBinary } from '../lib/git-binary';
import { ensureSessionDir, sessionDir } from '../lib/file-tracker';
import { pinWorktrees, resolvedAsProject } from '../lib/project-dir';
import { pinSessionCriteria, startedBeforeVerification } from '../lib/session-criteria';
import {
  earlierKeys,
  hasStartPin,
  listWorktrees,
  nearestGitTop,
  nestedWorktreeStarts,
  sessionStartRan,
  takeStartSnapshot,
  topIdentity,
  topStart,
  withSharedWorktreeList,
  worktreesAtStart,
  writeOnce,
} from '../lib/start-pins';

setDefaultTimeout(60_000);

const dirs: string[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
  resetGitBinary();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix = 'goodboy-i33ip-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const sh = (cwd: string, cmd: string): string => {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return (p.stdout.toString() + p.stderr.toString()).trim();
};
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';

let counter = 0;
/** A session id whose dir is removed after the test. */
function session(): string {
  const sid = `i33ip${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(sessionDir(sid));
  return sid;
}
const sessionFiles = (sid: string): string[] => readdirSync(sessionDir(sid));
const startPins = (sid: string): string[] => sessionFiles(sid).filter((f) => /^start-pin-[0-9a-f]{16}\.json$/.test(f));

/** A repository with two commits. */
function repo(): { A: string; head: string } {
  const A = tmp();
  sh(A, GIT_INIT);
  write(A, '.gitignore', '.claude/\n');
  write(A, 'src/calc.ts', 'export const add = (a: number, b: number) => a + b;\n');
  sh(A, "git add -A && git commit -q -m 'ABC-1 one'");
  write(A, 'src/calc2.ts', 'export const two = 2;\n');
  sh(A, "git add -A && git commit -q -m 'ABC-1 two'");
  return { A, head: sh(A, 'git rev-parse HEAD') };
}
const addWorktree = (A: string, dir: string, rev = 'HEAD'): string => {
  sh(A, `git worktree add -q --detach ${JSON.stringify(dir)} ${rev}`);
  return realpathSync(dir);
};

/** A session id that is no string: the session dir cannot be named, which every reader and writer of the
 *  session's files must survive. */
const NOT_A_SESSION = 42 as unknown as string;

/** A session id that names its dir as `real` does, but fails when asked from inside `inside` (a function
 *  name in the stack): the only way to make one step of a flow fail while the others work. */
function failingInside(real: string, inside: string): string {
  const id = {
    toString: () => real,
    replace: (...args: [RegExp, string]) => {
      if (new Error().stack?.includes(inside)) throw new Error(`injected failure inside ${inside}`);
      return real.replace(...args);
    },
  };
  return id as unknown as string;
}

describe('the worktree list shared inside one SessionStart', () => {
  test('inside withSharedWorktreeList the second ask for the same repository is the first one`s answer, not another git call', () => {
    const { A } = repo();
    const B = addWorktree(A, join(tmp(), 'B'));
    const out = withSharedWorktreeList(() => {
      const first = listWorktrees(A);
      const again = listWorktrees(A);
      const fromWorktree = listWorktrees(B); // the same repository by its common git dir
      const nested = withSharedWorktreeList(() => listWorktrees(A)); // an open one is kept, not replaced
      return { first, again, fromWorktree, nested };
    });
    expect(out.first.code).toBe(0);
    expect(out.first.out).toContain(`worktree ${A}`);
    expect(out.again).toBe(out.first);
    expect(out.fromWorktree).toBe(out.first);
    expect(out.nested).toBe(out.first);
    // Nothing is kept outside it: a later ask runs git again.
    expect(listWorktrees(A)).not.toBe(out.first);
  });

  test('a dir with no repository is asked, never shared, and its failure is kept out of the list', () => {
    const { A } = repo();
    const nogit = tmp();
    const out = withSharedWorktreeList(() => {
      const none = listWorktrees(nogit);
      const noneAgain = listWorktrees(nogit);
      const first = listWorktrees(A);
      return { none, noneAgain, first, again: listWorktrees(A) };
    });
    expect(out.none.code).not.toBe(0);
    expect(out.noneAgain).not.toBe(out.none);
    expect(out.again).toBe(out.first);
  });
});

describe('nearestGitTop', () => {
  test('the repository top from a subdirectory, the dir itself, and null where no .git is above', () => {
    const { A } = repo();
    mkdirSync(join(A, 'src', 'deep'), { recursive: true });
    expect(nearestGitTop(join(A, 'src', 'deep'))).toBe(A);
    expect(nearestGitTop(A)).toBe(A);
    expect(nearestGitTop('/')).toBeNull();
  });
});

describe('writeOnce', () => {
  test('the first writer wins: the second call changes nothing and says so', () => {
    const d = tmp();
    const p = join(d, 'pin.json');
    expect(writeOnce(p, 'first')).toBe(true);
    expect(writeOnce(p, 'second')).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('first');
    expect(readdirSync(d)).toEqual(['pin.json']); // no temp file left
  });
});

describe('the readers of the session files survive a session dir that cannot be named or read', () => {
  test('sessionStartRan: a tips file or a start pin says yes; nothing, or no usable session, says no', () => {
    const { A } = repo();
    const sid = session();
    expect(sessionStartRan(sid)).toBe(false);
    takeStartSnapshot(sid, A);
    expect(sessionStartRan(sid)).toBe(true);
    rmSync(join(sessionDir(sid), 'start-tips.json'));
    expect(sessionStartRan(sid)).toBe(true); // the start pins of the snapshot are enough
    for (const f of startPins(sid)) rmSync(join(sessionDir(sid), f));
    expect(sessionStartRan(sid)).toBe(false);
    expect(sessionStartRan(NOT_A_SESSION)).toBe(false);
  });

  test('worktreesAtStart lists what the snapshot pinned, and nothing for a session with none or no usable one', () => {
    const { A } = repo();
    const B = addWorktree(A, join(tmp(), 'B'));
    const sid = session();
    expect(worktreesAtStart(sid)).toEqual([]);
    takeStartSnapshot(sid, A);
    const listed = worktreesAtStart(sid);
    expect(listed.map((w) => w.top).sort()).toEqual([A, B].sort());
    expect(listed.every((w) => /^[0-9a-f]{16}$/.test(w.key))).toBe(true);
    expect(worktreesAtStart(NOT_A_SESSION)).toEqual([]);
  });

  test('hasStartPin: a pin of any content counts, even a corrupt one; none, no repository and unknown identity do not', () => {
    const { A } = repo();
    const sid = session();
    const who = topIdentity(A);
    expect(hasStartPin(sid, who)).toBe(false);
    ensureSessionDir(sid);
    const file = join(sessionDir(sid), `start-pin-${who.key}.json`);
    writeFileSync(file, '{this is not json');
    expect(hasStartPin(sid, who)).toBe(true); // 'bad' is not 'absent': a hook has nothing to pin over it
    expect(hasStartPin(sid, { ...who, unknown: 'git did not answer' })).toBe(false);
    expect(hasStartPin(sid, { ...who, id: 'nogit' })).toBe(false);
    expect(hasStartPin(NOT_A_SESSION, who)).toBe(false);
  });

  test('earlierKeys: the first top`s coverage pin with no commit registers an empty start there; no usable session has none', () => {
    const { A } = repo();
    const sid = session();
    const who = topIdentity(A);
    expect(earlierKeys(sid, who)).toEqual([]);
    ensureSessionDir(sid);
    writeFileSync(join(sessionDir(sid), 'coverage-pin.json'), JSON.stringify({ top: A, identity: 'aaaaaaaaaaaaaaaa', head: null, exemptions: [] }));
    expect(earlierKeys(sid, who)).toEqual(['aaaaaaaaaaaaaaaa']);
    expect(earlierKeys(NOT_A_SESSION, who)).toEqual([]);
  });

  test('topStart with no usable session is an unknown start that is not pinned and says why', () => {
    const { A } = repo();
    const out = topStart(NOT_A_SESSION, A);
    expect(out).toMatchObject({ kind: 'unknown', incomplete: true });
    expect((out as { reason: string }).reason).toContain('its start could not be read');
  });
});

describe('a git dir that git names and the file system does not hold', () => {
  test('topIdentity keeps the name git gave, with an unreadable id (never a throw)', () => {
    const top = tmp();
    const gone = join(tmp(), 'gone');
    symlinkSync(join(gone, 'nowhere'), join(top, '.git')); // a dangling link: this module cannot read it, git is asked
    const bin = tmp('goodboy-i33ip-fake-');
    writeFileSync(
      join(bin, 'git'),
      ['#!/bin/sh', 'case "$*" in *--absolute-git-dir*) printf \'%s\\n%s\\n%s\\n\' "$GB_TOP" "$GB_ADMIN" "$GB_COMMON"; exit 0 ;; esac', 'exec "$GB_REAL" "$@"', ''].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);
    const names = ['PATH', 'GB_TOP', 'GB_ADMIN', 'GB_COMMON', 'GB_REAL'];
    const saved = names.map((n) => process.env[n]);
    process.env.GB_REAL = Bun.which('git', { PATH: process.env.PATH })!;
    process.env.GB_TOP = top;
    process.env.GB_ADMIN = join(gone, 'admin');
    process.env.GB_COMMON = join(gone, 'common');
    process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
    restore.push(() => names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i]))));
    resetGitBinary();
    const who = topIdentity(top);
    expect(who.unknown).toBeUndefined();
    expect(who.id).toBe(`${join(gone, 'admin')}|?`);
    expect(who.common).toBe(join(gone, 'common'));
    expect(who.key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('a first sight whose changes cannot be recorded', () => {
  function laterWorktreeWithWork(): { sid: string; A: string; B: string } {
    const { A } = repo();
    const sid = session();
    takeStartSnapshot(sid, A);
    const B = addWorktree(A, join(tmp(), 'B')); // made after the start: first sight when asked
    write(B, 'src/new.ts', 'export const added = 1;\n'); // a change made before the first hook saw it
    return { sid, A, B };
  }

  test('control: the first sight pins the start and records the file as an edit of the session', () => {
    const { sid, B } = laterWorktreeWithWork();
    expect(topStart(sid, B)).toMatchObject({ kind: 'commit' });
    expect(startPins(sid).length).toBe(2);
    expect(readFileSync(join(sessionDir(sid), 'edits.jsonl'), 'utf8')).toContain(join(B, 'src', 'new.ts'));
  });

  test('when the edit log cannot be written the start is unknown and incomplete, and nothing is pinned for the checkout', () => {
    const { sid, B } = laterWorktreeWithWork();
    const before = startPins(sid).length;
    const out = topStart(failingInside(sid, 'recordEdit'), B);
    expect(out).toMatchObject({ kind: 'unknown', incomplete: true });
    expect((out as { reason: string }).reason).toContain('could not be recorded');
    expect(startPins(sid).length).toBe(before);
  });
});

describe('a checkout made again where the session started with no commit', () => {
  function unbornSession(): { sid: string; A: string } {
    const A = tmp();
    sh(A, GIT_INIT);
    const sid = session();
    takeStartSnapshot(sid, A);
    expect(JSON.parse(readFileSync(join(sessionDir(sid), `start-pin-${topIdentity(A).key}.json`), 'utf8')).start).toEqual({ kind: 'empty' });
    return { sid, A };
  }
  const makeAgain = (A: string) => sh(A, `rm -rf .git && ${GIT_INIT}`);

  test('no commit in the new one either: the empty start stays, pinned for the new identity', () => {
    const { sid, A } = unbornSession();
    const old = topIdentity(A).key;
    makeAgain(A);
    const now = topIdentity(A);
    expect(now.key).not.toBe(old);
    expect(topStart(sid, A)).toEqual({ kind: 'empty' });
    expect(existsSync(join(sessionDir(sid), `start-pin-${now.key}.json`))).toBe(true);
  });

  test('the first top`s coverage pin alone (no start pin file) is enough to carry the empty start over', () => {
    const A = tmp();
    sh(A, GIT_INIT);
    const sid = session();
    pinCoverageStart(sid, A); // the coverage pin records head null; the snapshot pins the worktree
    expect(JSON.parse(readFileSync(join(sessionDir(sid), 'coverage-pin.json'), 'utf8')).head).toBeNull();
    for (const f of startPins(sid)) rmSync(join(sessionDir(sid), f));
    makeAgain(A);
    write(A, 'src/made.ts', 'export const made = 1;\n');
    sh(A, "git add -A && git commit -q -m 'ABC-1 made'");
    // With history now, a first sight would call it unrelated (unknown); the carried-over start is the empty one.
    expect(topStart(sid, A)).toEqual({ kind: 'empty' });
    expect(readFileSync(join(sessionDir(sid), 'edits.jsonl'), 'utf8')).toContain(join(A, 'src', 'made.ts'));
  });

  test('commits made in the new one count as the session`s changes (the files of HEAD are recorded)', () => {
    const { sid, A } = unbornSession();
    makeAgain(A);
    write(A, 'src/made.ts', 'export const made = 1;\n');
    sh(A, "git add -A && git commit -q -m 'ABC-1 made'");
    expect(topStart(sid, A)).toEqual({ kind: 'empty' });
    expect(readFileSync(join(sessionDir(sid), 'edits.jsonl'), 'utf8')).toContain(join(A, 'src', 'made.ts'));
  });
});

describe('nestedWorktreeStarts: linked worktrees inside the checkout that hold some of the files', () => {
  function nested(): { sid: string; A: string; B: string } {
    const { A } = repo();
    const sid = session();
    takeStartSnapshot(sid, A);
    const B = addWorktree(A, join(A, 'wt', 'b'));
    return { sid, A, B };
  }

  test('a file in the nested worktree names it with its own start; other files, and files outside, name none', () => {
    const { sid, A, B } = nested();
    mkdirSync(join(B, 'src', 'sub'), { recursive: true });
    const files = [join(B, 'src', 'calc.ts'), join(B, 'src', 'sub', 'x.ts'), join(A, 'src', 'calc.ts'), A, dirname(A), join(tmp(), 'out.ts')];
    const out = nestedWorktreeStarts(sid, A, files, () => false);
    expect(out.length).toBe(1);
    expect(out[0]!.dir).toBe(B);
    expect(out[0]!.start).toMatchObject({ kind: 'commit' });
  });

  test('a worktree the hooks resolve as a project of its own is left to them', () => {
    const { sid, A, B } = nested();
    expect(nestedWorktreeStarts(sid, A, [join(B, 'src', 'calc.ts')], (wt) => wt === B)).toEqual([]);
  });

  test('a nested clone (its .git is a directory) and a worktree of another repository are no nested worktree of this one', () => {
    const { sid, A } = nested();
    const clone = join(A, 'vendor', 'clone');
    mkdirSync(clone, { recursive: true });
    sh(clone, GIT_INIT);
    const other = repo();
    const foreign = addWorktree(other.A, join(A, 'vendor', 'foreign'));
    expect(nestedWorktreeStarts(sid, A, [write(clone, 'a.ts', 'x\n'), write(foreign, 'b.ts', 'y\n')], () => false)).toEqual([]);
  });

  test('a checkout with no .git has no worktrees to name', () => {
    const plain = tmp();
    expect(nestedWorktreeStarts(session(), plain, [join(plain, 'a.ts')], () => false)).toEqual([]);
  });
});

describe('what the hooks see of a checkout that is not the session`s first (lib/changed-coverage.ts)', () => {
  function started(): { sid: string; A: string } {
    const { A } = repo();
    const sid = session();
    pinCoverageStart(sid, A);
    expect(existsSync(join(sessionDir(sid), 'start-tips.json'))).toBe(true);
    return { sid, A };
  }

  test('incompleteStart: null for the first top, for a known start and with no pin; the reason when the start is unknown and incomplete', () => {
    const { sid, A } = started();
    expect(incompleteStart(session(), A)).toBeNull(); // no coverage pin
    expect(incompleteStart(sid, A)).toBeNull(); // the first top
    const B = addWorktree(A, join(tmp(), 'B'));
    expect(incompleteStart(sid, B)).toBeNull(); // first sight: HEAD is where the session started
    const C = addWorktree(A, join(tmp(), 'C'));
    const sid2 = session();
    pinCoverageStart(sid2, A); // C exists at this start, so it was pinned then
    for (const f of startPins(sid2)) if (readFileSync(join(sessionDir(sid2), f), 'utf8').includes(JSON.stringify(C))) rmSync(join(sessionDir(sid2), f));
    expect(incompleteStart(sid2, C)).toContain('start pin');
  });

  test('noteSessionTop pins a worktree the session has not seen; a first top, a pinned one and a non-repository change nothing', () => {
    const { sid, A } = started();
    const before = startPins(sid).length;
    noteSessionTop(session(), A); // no coverage pin: nothing
    noteSessionTop(sid, tmp()); // no .git above
    noteSessionTop(sid, A); // the first top
    expect(startPins(sid).length).toBe(before);
    const B = addWorktree(A, join(tmp(), 'B'));
    noteSessionTop(sid, B); // new to the session: pinned now
    expect(startPins(sid).length).toBe(before + 1);
    noteSessionTop(sid, B); // pinned already: no change
    expect(startPins(sid).length).toBe(before + 1);
  });

  test('noteSessionTop leaves another repository alone when the session edited nothing in it', () => {
    const { sid, A } = started();
    const before = startPins(sid).length;
    const other = repo();
    noteSessionTop(sid, other.A);
    expect(startPins(sid).length).toBe(before);
  });

  test('noteSessionTop goes ahead when it cannot tell what the checkout is (a .git it cannot read proves nothing)', () => {
    const { sid, A } = started();
    const before = startPins(sid).length;
    const broken = tmp();
    write(broken, '.git', 'this is not a gitdir line\n'); // a .git file this module cannot read, and git does not accept
    noteSessionTop(sid, broken);
    expect(startPins(sid).length).toBe(before); // unknown is never pinned, but discovery was asked
    expect(topIdentity(broken).unknown).toBeDefined();
    expect(A).not.toBe(broken);
  });
});

describe('resolvedAsProject (lib/project-dir.ts)', () => {
  test('a worktree under .claude/worktrees or one noted at the session`s start is a project; another below the dir is not', () => {
    const { A } = repo();
    const sid = session();
    const inside = addWorktree(A, join(A, '.claude', 'worktrees', 'in'));
    const noted = addWorktree(A, join(tmp(), 'noted'));
    pinWorktrees(sid, { CLAUDE_PROJECT_DIR: A }); // SessionStart's note of the worktrees that exist
    const later = addWorktree(A, join(A, 'wt', 'later'));
    expect(resolvedAsProject(inside, A, sid)).toBe(true);
    expect(resolvedAsProject(noted, A, sid)).toBe(true);
    expect(resolvedAsProject(later, A, sid)).toBe(false);
    expect(resolvedAsProject(later, A, session())).toBe(false); // a session with no note
  });
});

describe('the criteria of the worktrees that exist at the session`s start (lib/session-criteria.ts)', () => {
  test('pinSessionCriteria pins each other worktree from its own work tree, keyed by its identity', () => {
    const { A } = repo();
    const B = addWorktree(A, join(tmp(), 'B'));
    const sid = session();
    pinCoverageStart(sid, A);
    pinSessionCriteria(sid, A);
    const key = topIdentity(B).key;
    const pin = JSON.parse(readFileSync(join(sessionDir(sid), `criteria-pin-${key}.json`), 'utf8'));
    expect(pin).toMatchObject({ top: B, rows: null, policy: null });
    expect(existsSync(join(sessionDir(sid), 'criteria-pin.json'))).toBe(true);
    expect(sessionFiles(sid).filter((f) => f.startsWith('criteria-pin-')).length).toBe(1); // none for the first top beyond criteria-pin.json
  });

  test('a document that cannot be read pins an unknown baseline for that worktree', () => {
    const { A } = repo();
    const B = addWorktree(A, join(tmp(), 'B'));
    mkdirSync(join(B, '.goodboy', 'policy.md'), { recursive: true }); // a policy file that is a directory
    const sid = session();
    pinCoverageStart(sid, A);
    pinSessionCriteria(sid, A);
    const pin = JSON.parse(readFileSync(join(sessionDir(sid), `criteria-pin-${topIdentity(B).key}.json`), 'utf8'));
    expect(pin.unknown).toContain('cannot be read');
  });

  test('a worktree made again since the snapshot has another identity and gets no pin from the old listing', () => {
    const { A } = repo();
    const dir = join(tmp(), 'B');
    addWorktree(A, dir);
    const sid = session();
    pinCoverageStart(sid, A);
    sh(A, `git worktree remove --force ${JSON.stringify(dir)}`);
    addWorktree(A, dir);
    pinSessionCriteria(sid, A);
    expect(sessionFiles(sid).filter((f) => /^criteria-pin-[0-9a-f]{16}\.json$/.test(f))).toEqual([]);
  });

  test('startedBeforeVerification asks the pin of the checkout it is given, also when the session`s files cannot be listed for the key', () => {
    const { A } = repo();
    const B = addWorktree(A, join(tmp(), 'B'));
    const sid = session();
    pinCoverageStart(sid, A);
    pinSessionCriteria(sid, A);
    const key = topIdentity(B).key;
    // The pin of B at the start of the session names a stage before verification.
    writeFileSync(join(sessionDir(sid), `criteria-pin-${key}.json`), JSON.stringify({ top: B, rows: null, policy: null, stage: 0 }));
    expect(startedBeforeVerification(sid, B)).toBe(true);
    // The key's lookup fails inside: it falls back to the checkout's own key, which is where the pin is.
    expect(startedBeforeVerification(failingInside(sid, 'criteriaKey'), B)).toBe(true);
  });
});
