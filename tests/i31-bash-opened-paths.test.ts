// #31: the path a Bash command opens. `openedPath` (lib/file-tracker.ts, #29) walks a `..` segment
//   by segment and so returned real spellings (macOS `/private/var`, or a linked parent) even where
//   no link was crossed: a caller comparing the result with `resolve(cwd)` (the Bash read
//   classification) judged an inside path as outside when the cwd was under an alias. It now spells
//   its result back through the nearest ancestor of the cwd that holds it. The Bash write
//   classification and the role-limit path lists take their targets the OS way too (`lnk/../f`
//   goes through the link), where they used `path.resolve`. Two side fixes of the same round:
//   `blobAtCommitResult` without a deadline shares one 5 s deadline across its three git calls, and
//   `versionOnlyChange` (isMetadataNoTest) refuses number literals spelled otherwise. Everything
//   runs on real temp dirs.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { classifyBashRead } from '../lib/bash-read';
import { classifyBashWrite } from '../lib/bash-write';
import { blobAtCommitResult } from '../lib/changed-coverage';
import { openedPath, type RealpathMemo } from '../lib/file-tracker';
import { bashChangedPaths, resultDirWrite } from '../lib/role-limits';
import { needsTests } from '../lib/verification-scope';

setDefaultTimeout(30_000);

const dirs: string[] = [];
const restore: (() => void)[] = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}

/** A scratch world `S` (real path):
 *    S/real/proj/{sub/,deep/,a}   the project, with `sub/in -> ../deep` (relative) and `sub/ext -> S/outside`
 *    S/alias -> real              so `S/alias/proj` is the same project under an alias
 *    S/outside/                   a dir outside the project
 *    S/out/lnk -> S/real/proj/sub a link outside the project that leads in */
function world() {
  const S = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i31-')));
  dirs.push(S);
  const proj = join(S, 'real', 'proj');
  mkdirSync(join(proj, 'sub'), { recursive: true });
  mkdirSync(join(proj, 'deep'));
  mkdirSync(join(S, 'outside'));
  mkdirSync(join(S, 'out'));
  write(proj, 'a', 'a\n');
  symlinkSync('../deep', join(proj, 'sub', 'in'));
  symlinkSync(join(S, 'outside'), join(proj, 'sub', 'ext'));
  symlinkSync(join(proj, 'sub'), join(S, 'out', 'lnk'));
  symlinkSync(join(S, 'real'), join(S, 'alias'));
  return { S, proj, alias: join(S, 'alias', 'proj') };
}

describe('openedPath spells its result like the cwd', () => {
  test('a `..` walk under an aliased cwd keeps the alias spelling', () => {
    const { S, alias } = world();
    expect(openedPath(alias, 'sub/../w.txt')).toBe(`${alias}/w.txt`);
    expect(openedPath(join(S, 'alias', 'proj'), 'sub/../w.txt')).not.toBe(join(S, 'real', 'proj', 'w.txt'));
  });

  test('a link crossed by the walk still shows the real target, spelled through the cwd when inside it', () => {
    const { S, proj, alias } = world();
    // sub/in -> ../deep: `sub/in/../w.txt` is `<proj>/w.txt` (not `<proj>/sub/w.txt`).
    expect(openedPath(proj, 'sub/in/../w.txt')).toBe(`${proj}/w.txt`);
    expect(openedPath(alias, 'sub/in/../w.txt')).toBe(`${alias}/w.txt`);
    // sub/ext -> S/outside: the parent of the target is S, outside the project.
    expect(openedPath(alias, 'sub/ext/../w.txt')).toBe(`${S}/w.txt`);
  });

  test('a path that holds no ancestor of the cwd keeps its real spelling', () => {
    const { S, proj } = world();
    // Outside the project, through a link that leads in: the cwd spelling holds it.
    expect(openedPath(proj, `${S}/out/lnk/../w.txt`)).toBe(`${proj}/w.txt`);
    // A walk to the root from a deep path stays at the root.
    expect(openedPath(proj, '../../../../../../../../../../../../../w.txt')).toBe('/w.txt');
    expect(openedPath('/', '../w.txt')).toBe('/w.txt');
  });

  test('a missing cwd ancestor is skipped, and a missing cwd resolves by name', () => {
    const { S } = world();
    const ghost = join(S, 'real', 'proj', 'not-there', 'deeper');
    expect(openedPath(ghost, 'x/../w.txt')).toBe(`${ghost}/w.txt`);
  });

  test.if(process.platform === 'darwin' && tmpdir().startsWith('/var/'))('the macOS /var alias is kept', () => {
    const d = mkdtempSync(join(tmpdir(), 'goodboy-i31-var-'));
    dirs.push(realpathSync(d));
    mkdirSync(join(d, 'sub'));
    expect(realpathSync(d)).not.toBe(d); // the alias is really there
    expect(openedPath(d, 'sub/../w.txt')).toBe(`${d}/w.txt`);
  });
});

describe('classifyBashWrite reads a target the way the OS opens it', () => {
  test('under an alias cwd, `sub/../w.txt` is a project write spelled with the alias', () => {
    const { alias } = world();
    expect(classifyBashWrite('echo x > sub/../w.txt', alias)).toEqual([`${alias}/w.txt`]);
  });

  test('a link inside the project that leads out: `sub/ext/../w.txt` is no project write', () => {
    const { alias, proj } = world();
    expect(classifyBashWrite('echo x > sub/ext/../w.txt', alias)).toEqual([]);
    expect(classifyBashWrite('echo x > sub/ext/../w.txt', proj)).toEqual([]);
  });

  test('a path outside the project through a link that leads in is a project write', () => {
    const { S, proj, alias } = world();
    expect(classifyBashWrite(`echo x > ${S}/out/lnk/../w.txt`, proj)).toEqual([`${proj}/w.txt`]);
    expect(classifyBashWrite(`echo x > ${S}/out/lnk/../w.txt`, alias)).toEqual([`${alias}/w.txt`]);
  });

  test('tee follows the same rule', () => {
    const { S, proj } = world();
    expect(classifyBashWrite(`echo x | tee ${S}/out/lnk/../w.txt`, proj)).toEqual([`${proj}/w.txt`]);
  });

  test('a session result dir reached through a link is still denied, spelled as opened', () => {
    const { proj } = world();
    mkdirSync(join(proj, '.claude', 'tests'), { recursive: true });
    expect(classifyBashWrite('echo x > sub/in/../.claude/tests/r.json', proj)).toEqual([`${proj}/.claude/tests/r.json`]);
    expect(classifyBashWrite('echo x > .claude/tests/r.json', proj)).toEqual([`${proj}/.claude/tests/r.json`]);
  });
});

describe('bashChangedPaths takes file and option targets the way the OS opens them', () => {
  test('a copy target outside the project through a link that leads in is reported inside', () => {
    const { S, proj } = world();
    expect(bashChangedPaths(`cp a ${S}/out/lnk/../w.txt`, proj)).toEqual([`${proj}/w.txt`]);
  });

  test('a relative link inside the project: `sub/in/../w.txt` is `<proj>/w.txt`', () => {
    const { proj } = world();
    expect(bashChangedPaths('cp a sub/in/../w.txt', proj)).toEqual([`${proj}/w.txt`]);
    expect(bashChangedPaths('touch sub/in/../t.txt', proj)).toEqual([`${proj}/t.txt`]);
    expect(bashChangedPaths('perl -pi -e s/a/b/ sub/in/../p.txt', proj)).toEqual([`${proj}/p.txt`]);
  });

  test('curl --output-dir and -o go through the link', () => {
    const { proj } = world();
    expect(bashChangedPaths('curl --output-dir sub/in -o ../w.txt http://x.invalid/f', proj)).toEqual([`${proj}/w.txt`]);
    expect(bashChangedPaths('curl -o sub/in/../w.txt http://x.invalid/f', proj)).toEqual([`${proj}/w.txt`]);
    expect(bashChangedPaths('curl --output-dir sub/in/.. -O http://x.invalid/f', proj)).toEqual([proj]);
  });

  test('tar -x -C, unzip -d, wget and rsync go through the link', () => {
    const { proj } = world();
    expect(bashChangedPaths('tar -x -C sub/in/.. -f f.tar', proj)).toEqual([proj]);
    expect(bashChangedPaths('unzip -d sub/in/.. f.zip', proj)).toEqual([proj]);
    expect(bashChangedPaths('wget -O sub/in/../w.txt http://x.invalid/f', proj)).toEqual([`${proj}/w.txt`]);
    expect(bashChangedPaths('rsync -a a sub/in/../r', proj)).toEqual([`${proj}/r`]);
  });

  test('a target through a link that leads out is reported outside the project', () => {
    const { S, proj } = world();
    expect(bashChangedPaths('cp a sub/ext/../w.txt', proj)).toEqual([`${S}/w.txt`]);
  });

  test('cd dirs and the .git target stay logical', () => {
    const { proj } = world();
    expect(bashChangedPaths('cd sub/in && cp ../a w.txt', proj)).toEqual([`${proj}/sub/in/w.txt`]);
    expect(bashChangedPaths('git add -A', proj)).toEqual([`${proj}/.git`]);
  });
});

describe('Bash read tracking under an alias cwd', () => {
  test('`cat sub/../f.txt` is tracked as a read at the alias spelling', () => {
    const { alias, proj } = world();
    write(proj, 'f.txt', 'f\n');
    expect(classifyBashRead('cat sub/../f.txt', alias)).toEqual([`${alias}/f.txt`]);
    expect(classifyBashRead('cat sub/../f.txt', proj)).toEqual([`${proj}/f.txt`]);
  });

  test('a read through a link that leads out is no project read', () => {
    const { alias, S } = world();
    write(S, 'f.txt', 'outside\n');
    expect(classifyBashRead('cat sub/ext/../f.txt', alias)).toEqual([]);
  });
});

describe('the realpath memo of one evaluation', () => {
  test('a shared memo is filled with the walked prefixes and the cwd, and a second call agrees with it', () => {
    const { proj } = world();
    const memo: RealpathMemo = new Map();
    const first = openedPath(proj, 'sub/in/../w.txt', memo);
    expect(first).toBe(`${proj}/w.txt`);
    // the `..` after `sub/in` made the prefix real; the cwd was looked at to spell the result
    expect(memo.get(`${proj}/sub/in`)).toBe(`${proj}/deep`);
    expect(memo.get(proj)).toBe(proj);
    const size = memo.size;
    expect(openedPath(proj, 'sub/in/../w.txt', memo)).toBe(first);
    expect(memo.size).toBe(size); // nothing new to look up
    expect(openedPath(proj, 'sub/in/../w.txt')).toBe(first); // same as with no memo
  });

  test('a path that does not exist is memoized as null, and the walk goes up by name', () => {
    const { proj } = world();
    const memo: RealpathMemo = new Map();
    expect(openedPath(proj, 'nope/../w.txt', memo)).toBe(`${proj}/w.txt`);
    expect(memo.has(`${proj}/nope`)).toBe(true);
    expect(memo.get(`${proj}/nope`)).toBeNull();
  });

  test('a lookup goes through the memo: a seeded real path changes the answer', () => {
    const { S, proj } = world();
    const memo: RealpathMemo = new Map([[`${proj}/sub`, `${S}/outside/x`]]);
    // the disk says `sub` is `<proj>/sub`; the memo says it is `<S>/outside/x`, and the memo wins
    expect(openedPath(proj, 'sub/../w.txt', memo)).toBe(`${S}/outside/w.txt`);
    expect(openedPath(proj, 'sub/../w.txt')).toBe(`${proj}/w.txt`);
  });

  test('a null entry means no real path: the walk goes up by name, even for a link', () => {
    const { proj } = world();
    const memo: RealpathMemo = new Map([[`${proj}/sub/in`, null]]);
    // `sub/in` is a link to ../deep, but the memo holds none: up by name gives `<proj>/sub`
    expect(openedPath(proj, 'sub/in/../w.txt', memo)).toBe(`${proj}/sub/w.txt`);
    expect(openedPath(proj, 'sub/in/../w.txt')).toBe(`${proj}/w.txt`);
  });

  test('a null entry for the alias cwd is skipped when spelling the result, not taken for a match', () => {
    const { alias } = world();
    const memo: RealpathMemo = new Map([[alias, null]]);
    expect(openedPath(alias, 'sub/../w.txt', memo)).toBe(`${alias}/w.txt`);
  });

  test('a memo shared by thousands of `..` targets gains no entry after the first', () => {
    const { proj } = world();
    const memo: RealpathMemo = new Map();
    openedPath(proj, '../../x', memo);
    const size = memo.size;
    expect(size).toBeGreaterThan(0);
    for (let i = 0; i < 2000; i++) openedPath(proj, '../../x', memo);
    expect(memo.size).toBe(size);
  });
});

describe('the spelling walk stops at the first ancestor that is its own real path', () => {
  test('a real cwd: an outside `..` target is the real path, and the cwd ancestors above are never looked at', () => {
    const { S, proj } = world();
    const memo: RealpathMemo = new Map();
    expect(openedPath(proj, '../../x', memo)).toBe(`${S}/x`);
    // looked at: the prefixes the walk went up from (proj, S/real). Not S, nor anything above it.
    expect([...memo.keys()].sort()).toEqual([proj, `${S}/real`].sort());
    expect(memo.get(proj)).toBe(proj);
  });

  test('a real cwd, a target above the whole tree: the root, and the walk looked at nothing past the cwd', () => {
    const { proj } = world();
    const memo: RealpathMemo = new Map();
    expect(openedPath(proj, '../../../../../../../../../../../../../x', memo)).toBe('/x');
    expect(memo.has(proj)).toBe(true);
    expect(memo.has('/')).toBe(false);
  });

  test('an alias cwd is not real: the walk goes on up to the alias link and respells there', () => {
    const { S, alias } = world();
    const memo: RealpathMemo = new Map();
    expect(openedPath(alias, 'sub/../w.txt', memo)).toBe(`${alias}/w.txt`);
    expect(memo.get(alias)).toBe(join(S, 'real', 'proj')); // not its own real path: not the stop
    // a target below the alias link but not below the cwd is spelled with the alias too
    expect(openedPath(alias, '../w.txt', memo)).toBe(`${join(S, 'alias')}/w.txt`);
    expect(openedPath(alias, '../w.txt')).toBe(`${join(S, 'alias')}/w.txt`);
  });
});

describe('a command with thousands of `..` targets is cheap', () => {
  /** A cwd DEPTH dirs below a temp dir, as a real path and as a path under an alias link. */
  function deepWorld(depth: number) {
    const S = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i31-deep-')));
    dirs.push(S);
    const parts = Array.from({ length: depth }, (_, i) => `d${i}`);
    const real = join(S, 'deepreal', ...parts);
    mkdirSync(real, { recursive: true });
    symlinkSync(join(S, 'deepreal'), join(S, 'deepalias'));
    return { real, alias: join(S, 'deepalias', ...parts), S };
  }
  /** Best of three, to leave a noisy first run (module warm-up, a busy machine) out of it. */
  const best = (run: () => void): number => {
    let min = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      run();
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };

  test('`rm` with 5000 `../../x` operands under a deep real cwd', () => {
    const { real } = deepWorld(14);
    const cmd = 'rm ' + Array.from({ length: 5000 }, () => '../../x').join(' ');
    const out = bashChangedPaths(cmd, real);
    expect(out.length).toBe(5000);
    expect(out[0]).toBe(join(real, '..', '..', 'x')); // two dirs up
    // one realpath per ancestor per target took ~1.5 s; with the memo it is ~70 ms
    expect(best(() => bashChangedPaths(cmd, real))).toBeLessThan(600);
  });

  test('2000 `> ../../y` redirects under a deep alias cwd', () => {
    const { alias } = deepWorld(14);
    const cmd = Array.from({ length: 2000 }, () => 'echo x > ../../y').join('; ');
    const out = classifyBashWrite(cmd, alias);
    expect(out).toEqual([]); // two dirs up is outside the project: no project write
    // an alias cwd walks its ancestors per target: ~1 s without the memo, ~30 ms with it
    expect(best(() => classifyBashWrite(cmd, alias))).toBeLessThan(400);
  });

  test('2000 `> ../../y` redirects under a deep real cwd', () => {
    const { real } = deepWorld(14);
    const cmd = Array.from({ length: 2000 }, () => 'echo x > ../../y').join('; ');
    expect(classifyBashWrite(cmd, real)).toEqual([]);
    expect(best(() => classifyBashWrite(cmd, real))).toBeLessThan(400); // ~1 s without the memo or the early stop
  });
});

describe('the callers still reach a target through a link', () => {
  test('curl -o and --output-dir name the result dir through a link that leads in', () => {
    const { S, proj } = world();
    const via = `${S}/out/lnk/..`; // the OS opens this as <proj>
    expect(resultDirWrite(`curl -o ${via}/.claude/tests/r.json http://x.invalid/f`, proj)).not.toBeNull();
    expect(resultDirWrite(`curl --output-dir ${via} -o .claude/tests/r.json http://x.invalid/f`, proj)).not.toBeNull();
    // the same names with no link are no result dir of this project
    expect(resultDirWrite(`curl -o ${S}/out/.claude/tests/r.json http://x.invalid/f`, proj)).toBeNull();
  });

  test('curl --output-dir through a relative link is a project path', () => {
    const { proj } = world();
    expect(bashChangedPaths('curl --output-dir sub/in/.. -o w.txt http://x.invalid/f', proj)).toEqual([`${proj}/w.txt`]);
  });
});

describe('blobAtCommitResult without a deadline shares one 5 s deadline', () => {
  /** A repo with a.txt committed, and a git first on PATH that waits SECS before ls-tree and before
   *  cat-file -s (the `sleep` has its output closed, so a cut-off call does not wait for it). */
  function slowRepo(secs: number) {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i31-git-')));
    dirs.push(d);
    write(d, 'a.txt', 'hi\n');
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const head = sh(d, 'git rev-parse HEAD');
    const real = Bun.which('git', { PATH: process.env.PATH })!;
    const bin = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i31-fake-')));
    dirs.push(bin);
    writeFileSync(
      join(bin, 'git'),
      ['#!/bin/sh', `case "$*" in *ls-tree*|*"cat-file -s"*) sleep ${secs} >/dev/null 2>&1 </dev/null ;; esac`, `exec "${real}" "$@"`, ''].join('\n'),
    );
    chmodSync(join(bin, 'git'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${saved}`;
    restore.push(() => (process.env.PATH = saved));
    return { d, head };
  }

  test('two 3 s calls cost about 5 s in all, not their sum, and the answer is an error', () => {
    const { d, head } = slowRepo(3);
    const t0 = performance.now();
    expect(blobAtCommitResult(d, head, 'a.txt', 1_000)).toEqual({ kind: 'error' });
    const took = performance.now() - t0;
    expect(took).toBeGreaterThan(4_000);
    expect(took).toBeLessThan(5_900); // the sum of two calls alone is 6 s
  });

  test('a caller-supplied deadline is used as it is', () => {
    const { d, head } = slowRepo(1);
    const t0 = performance.now();
    expect(blobAtCommitResult(d, head, 'a.txt', 1_000, () => 300)).toEqual({ kind: 'error' });
    expect(performance.now() - t0).toBeLessThan(2_500);
  });

  test('a quick git still reads the text and the unknown commit is an error', () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i31-ok-')));
    dirs.push(r);
    write(r, 'a.txt', 'hi\n');
    sh(r, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    sh(r, "git add -A && git commit -q -m 'ABC-1 init'");
    const head = sh(r, 'git rev-parse HEAD');
    expect(blobAtCommitResult(r, head, 'a.txt', 1_000)).toEqual({ kind: 'text', text: 'hi\n' });
    expect(blobAtCommitResult(r, head, 'a.txt', 1)).toEqual({ kind: 'refused' });
    expect(blobAtCommitResult(r, head, 'nope.txt', 1_000)).toEqual({ kind: 'absent' });
    expect(blobAtCommitResult(r, 'not-an-id', 'a.txt', 1_000)).toEqual({ kind: 'error' });
    expect(existsSync(join(r, '.git'))).toBe(true);
  });
});

describe('a version-only manifest change needs the number literals to match as written', () => {
  const tree = (files: Record<string, string>): string => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i31-man-')));
    dirs.push(d);
    for (const [p, t] of Object.entries(files)) write(d, p, t);
    return d;
  };
  const needs = (before: string, after: string): boolean => {
    const d = tree({ 'package.json': after });
    return needsTests(join(d, 'package.json'), d, [], () => before);
  };

  test('big numbers that parse equal but are spelled otherwise are not metadata', () => {
    expect(needs('{"version":"1.0.0","n":12345678901234567890}', '{"version":"1.0.1","n":12345678901234567891}')).toBe(true);
  });

  test('a real version bump with the numbers unchanged is still exempt', () => {
    const same = '"n":12345678901234567890,"m":[-1.5e+3,0,2]';
    expect(needs(`{"version":"1.0.0",${same}}`, `{"version":"1.0.1",${same}}`)).toBe(false);
    expect(needs(`{"version":"1.0.0",${same}}\n`, `{\n  "version": "1.0.1",\n  "n": 12345678901234567890,\n  "m": [-1.5e+3, 0, 2]\n}\n`)).toBe(false);
  });

  test('a number re-spelled (1.0 to 1, 1e3 to 1E3) is not metadata', () => {
    expect(needs('{"version":"1.0.0","n":1.0}', '{"version":"1.0.1","n":1}')).toBe(true);
    expect(needs('{"version":"1.0.0","n":1e3}', '{"version":"1.0.1","n":1E3}')).toBe(true);
  });

  test('a number added or removed is not metadata', () => {
    expect(needs('{"version":"1.0.0"}', '{"version":"1.0.1","n":1}')).toBe(true);
    expect(needs('{"version":"1.0.0","n":1}', '{"version":"1.0.1"}')).toBe(true);
  });

  test('digits inside strings, escaped quotes included, are not number literals', () => {
    const s = '"s":"a 12 \\" 34 \\\\","t":"-9"';
    expect(needs(`{"version":"1.0.0",${s}}`, `{"version":"1.0.1",${s}}`)).toBe(false);
  });
});
