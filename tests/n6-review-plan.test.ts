// Track N, N6 (v0.38.1): the review plan. A review is sized by its substantive changed lines (non-blank,
// documents not counted), a change gets at most three runs (`assignments`), a delta is sized against the
// newest review that lists each file (`deltaLineCount`), and `review-axes` says when to start the runs from the
// free agent slots. Real git repos and real spawned CLIs in temp dirs; the session state (TMPDIR), the config dir
// (transcripts) and HOME are temp dirs too, so nothing of the live session is read or written.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pinCoverageStart, readCoverageStartHead } from '../lib/changed-coverage';
import { topStart } from '../lib/start-pins';
import type { ReviewAxis, ReviewDimension } from '../lib/review-dimensions';
import { reviewWindowMinutes } from '../lib/review-validator';
import {
  changedLineCount,
  deltaLineCount,
  realish,
  reviewAssignments,
  reviewPlanNote,
  reviewSchedule,
  SMALL_DIFF_LINES,
  substantivePatchLines,
} from '../lib/review-scope';
import { appendDispatchLog, type DispatchRecord } from '../lib/spawn-guard';
import type { ReviewResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');

// ── the sandbox: temp TMPDIR, HOME, config dir and registry for this process and the CLIs it spawns ──

const saved: Record<string, string | undefined> = {};
const dirs: string[] = [];
let sandbox = '';
const ENV_KEYS = ['TMPDIR', 'HOME', 'CLAUDE_CONFIG_DIR', 'GOODBOY_REGISTRY_DIR', 'GIT_CONFIG_GLOBAL', 'CLAUDE_CODE_SESSION_ID', 'GOODBOY_SPAWN_CONCURRENCY', 'CLAUDE_PROJECT_DIR'];

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-n6-')));
  for (const sub of ['tmp', 'home', 'config', 'registry']) mkdirSync(join(sandbox, sub));
  process.env.TMPDIR = join(sandbox, 'tmp');
  process.env.HOME = join(sandbox, 'home');
  process.env.CLAUDE_CONFIG_DIR = join(sandbox, 'config');
  process.env.GOODBOY_REGISTRY_DIR = join(sandbox, 'registry');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.GOODBOY_SPAWN_CONCURRENCY;
  delete process.env.CLAUDE_PROJECT_DIR; // a spawned CLI must not take the live session's project
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(sandbox, { recursive: true, force: true });
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sh(cwd: string, cmd: string, env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const A_TS = 'export const a = 1;\nexport const b = 2;\n';
/** A fresh dir whose own name is fixed: the review dimensions read the parent dir name of a file (a random one such as
 *  `repo-sqlx1b` would trigger an injection rule now and then). */
function freshDir(): string {
  const parent = realpathSync(mkdtempSync(join(sandbox, 'w-')));
  dirs.push(parent);
  const d = join(parent, 'proj');
  mkdirSync(d);
  return d;
}
function emptyRepo(): string {
  const d = freshDir();
  sh(d, 'git init -q -b main && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false');
  return d;
}
function repo(files: Record<string, string> = { 'a.ts': A_TS }): string {
  const d = emptyRepo();
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  return d;
}
const headOf = (d: string) => sh(d, 'git rev-parse HEAD');
/** a.ts with its first line changed: two substantive lines (-a +a) against A_TS. */
const editA = (d: string): void => writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\n');
/** The tree of the work tree as it is now, written through a scratch index (what review-write keeps in `tree`). */
function workTree(d: string): string {
  const idx = join(realpathSync(mkdtempSync(join(sandbox, 'idx-'))), 'index');
  return sh(d, 'git add -A && git write-tree', { GIT_INDEX_FILE: idx });
}
/** A linked worktree of the repo, made now: another checkout of the same repository (the only kind whose start the
 *  session can tell: a separate repository with history has an unknown start). */
function worktreeOf(d: string): string {
  const parent = realpathSync(mkdtempSync(join(sandbox, 'wt-')));
  dirs.push(parent);
  const wt = join(parent, 'proj');
  sh(d, `git worktree add -q -b wt-${Math.random().toString(36).slice(2, 8)} "${wt}"`);
  return wt;
}
function review(files: string[], timestamp: string, tree?: string): ReviewResult {
  return {
    timestamp,
    reviewed_files: files,
    category: 'fix-bug',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: [],
    ...(tree !== undefined ? { tree } : {}),
  } as unknown as ReviewResult;
}
const uuid = () => crypto.randomUUID();

// ── substantivePatchLines ──────────────────────────────────────────────────────────────────────────

describe('substantivePatchLines: the non-blank added and removed lines of a --unified=0 patch', () => {
  const head = 'diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n';

  test('blank and whitespace-only lines, added or removed, do not count; the file headers do not either', () => {
    const patch = `${head}@@ -1,3 +1,4 @@\n-old\n-\n- \t\n+new\n+\n+   \n+two\n`;
    expect(substantivePatchLines(patch)).toBe(3); // -old, +new, +two
  });

  test('a removed SQL comment, shown as `--- x` inside a hunk, is a body line and counts', () => {
    const patch = `${head}@@ -3 +3 @@\n--- x\n+SELECT 1;\n`;
    expect(substantivePatchLines(patch)).toBe(2);
  });

  test('an added line that reads `++ x` (shown as `+++ x`) counts too', () => {
    expect(substantivePatchLines(`${head}@@ -1 +1 @@\n-a\n+++ x\n`)).toBe(2);
  });

  test('"\\ No newline at end of file" is ignored, in the middle of a hunk and after it', () => {
    const patch = `${head}@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n`;
    expect(substantivePatchLines(patch)).toBe(2);
  });

  test('several hunks and files add up; a hunk header without counts is one line each side', () => {
    const patch = `${head}@@ -1,0 +2,2 @@\n+x\n+y\n@@ -9 +10 @@\n-q\n+r\ndiff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -4,1 +4,0 @@\n-gone\n`;
    expect(substantivePatchLines(patch)).toBe(5);
  });

  test('a hunk merged by diff.interHunkContext holds context lines: they are consumed, and the changes after them count', () => {
    // Two changes with three unchanged lines between them, as git writes them into one hunk of 5 old and 5 new lines.
    const patch = `${head}@@ -1,5 +1,5 @@\n-a\n+A\n c1\n c2\n c3\n-b\n+B\n`;
    expect(substantivePatchLines(patch)).toBe(4);
    // A blank context line is a single space; the next hunk is still read as a header afterwards.
    const blankCtx = `${head}@@ -1,3 +1,3 @@\n-a\n+A\n \n x\n@@ -9 +9 @@\n-q\n+r\n`;
    expect(substantivePatchLines(blankCtx)).toBe(4);
  });

  test('a hunk that announces more lines than the patch holds ends at the next header, which is not counted as a body line', () => {
    const patch = `${head}@@ -1,3 +1,3 @@\n-a\n+A\ndiff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-q\n+r\n`;
    expect(substantivePatchLines(patch)).toBe(4);
  });

  test('an empty patch, or text without hunks, is 0', () => {
    expect(substantivePatchLines('')).toBe(0);
    expect(substantivePatchLines(`${head}Binary files a/f and b/f differ\n`)).toBe(0);
  });
});

// ── changedLineCount ───────────────────────────────────────────────────────────────────────────────

describe('changedLineCount: substantive lines against a base', () => {
  test('blank lines added to a tracked file do not count, and the result is 0, not unknown', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n\n   \nexport const b = 2;\n\n');
    expect(changedLineCount(d, [join(d, 'a.ts')])).toBe(0);
  });

  test('blank lines of an untracked file do not count', () => {
    const d = repo();
    writeFileSync(join(d, 'new.ts'), 'x\n\n\ny\n  \n');
    expect(changedLineCount(d, [join(d, 'new.ts')])).toBe(2);
  });

  test('a Markdown file does not count but is accounted for: tracked or untracked, never null; code beside it counts', () => {
    const d = repo({ 'a.ts': A_TS, 'README.md': '# t\n' });
    writeFileSync(join(d, 'README.md'), '# t\nmore\nlines\nhere\n');
    expect(changedLineCount(d, [join(d, 'README.md')])).toBe(0);
    writeFileSync(join(d, 'NOTES.md'), 'a\nb\nc\n');
    expect(changedLineCount(d, [join(d, 'NOTES.md')])).toBe(0);
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\nexport const b = 2;\n');
    expect(changedLineCount(d, [join(d, 'a.ts'), join(d, 'README.md'), join(d, 'NOTES.md')])).toBe(2);
  });

  test('a test, SQL and config file count (only documents do not)', () => {
    const d = repo({ 'a.ts': A_TS });
    writeFileSync(join(d, 'a.test.ts'), 'x\n');
    writeFileSync(join(d, 'q.sql'), 'select 1;\nselect 2;\n');
    writeFileSync(join(d, 'cfg.json'), '{}\n');
    expect(changedLineCount(d, [join(d, 'a.test.ts'), join(d, 'q.sql'), join(d, 'cfg.json')])).toBe(4);
  });

  test('a removed SQL comment line is counted from the real diff', () => {
    const d = repo({ 'q.sql': '-- note\nselect 1;\n' });
    writeFileSync(join(d, 'q.sql'), 'select 1;\n');
    expect(changedLineCount(d, [join(d, 'q.sql')])).toBe(1);
  });

  test('diff.interHunkContext in the user\'s git config does not change the count (changes far apart are all counted)', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `export const v${i} = ${i};`);
    const d = repo({ 'a.ts': lines.join('\n') + '\n' });
    const edited = [...lines];
    edited[0] = 'export const v0 = 100;';
    edited[13] = 'export const v13 = 100;';
    writeFileSync(join(d, 'a.ts'), edited.join('\n') + '\n');
    const plain = changedLineCount(d, [join(d, 'a.ts')]);
    expect(plain).toBe(4); // two lines changed, each -old +new
    sh(d, 'git config diff.interHunkContext 100'); // git then merges the two hunks and pads them with context
    expect(changedLineCount(d, [join(d, 'a.ts')])).toBe(4);
  });

  test('a deleted tracked file counts its removed lines', () => {
    const d = repo();
    rmSync(join(d, 'a.ts'));
    expect(changedLineCount(d, [join(d, 'a.ts')])).toBe(2);
  });

  test('a commit made mid-session: against the start commit the file still counts, against HEAD it is unknown', () => {
    const d = repo();
    const start = headOf(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
    sh(d, "git commit -qam 'ABC-2 mid-session'");
    expect(changedLineCount(d, [join(d, 'a.ts')], start)).toBe(3); // -a, +a, +c
    expect(changedLineCount(d, [join(d, 'a.ts')])).toBeNull();
    expect(changedLineCount(d, [join(d, 'a.ts')], 'HEAD')).toBeNull();
  });

  test('no files is 0; a file outside the repo, a non-repo dir, a binary, an ignored or an oversized untracked file are unknown', () => {
    const d = repo();
    expect(changedLineCount(d, [])).toBe(0);
    expect(changedLineCount(d, ['/etc/hosts'])).toBeNull();
    writeFileSync(join(d, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
    expect(changedLineCount(d, [join(d, 'blob.bin')])).toBeNull();
    writeFileSync(join(d, 'big.ts'), 'x\n'.repeat(600_000)); // over the 1 MiB read cap
    expect(changedLineCount(d, [join(d, 'big.ts')])).toBeNull();
    writeFileSync(join(d, 'a.ts'), 'export const a = 3;\n');
    writeFileSync(join(d, 'bin2.dat'), Buffer.from([1, 0, 2]));
    expect(changedLineCount(d, [join(d, 'a.ts'), join(d, 'bin2.dat')])).toBeNull(); // one unknown file makes the size unknown
    const bare = realpathSync(mkdtempSync(join(sandbox, 'bare-')));
    dirs.push(bare);
    expect(changedLineCount(bare, [join(bare, 'x.ts')])).toBeNull();
  });

  test('an untracked symlink whose target is gone (git lists it, it cannot be read) makes the size unknown', () => {
    const d = repo();
    symlinkSync(join(d, 'nowhere'), join(d, 'dangling.ts'));
    expect(changedLineCount(d, [join(d, 'dangling.ts')])).toBeNull();
  });

  test('realish: a real path, a deleted file in a real dir, and a path in no real dir as it is', () => {
    const d = repo();
    expect(realish(join(d, 'a.ts'))).toBe(join(d, 'a.ts'));
    expect(realish(join(d, 'gone.ts'))).toBe(join(d, 'gone.ts'));
    const lost = join(d, 'no-dir', 'deeper', 'x.ts');
    expect(realish(lost)).toBe(lost);
  });

  // An untracked link, FIFO or device under a directory argument was read whole (git lists the link, the read followed
  //   it): /dev/zero hung the count (security review). The count runs in a child with its own limit, so that a
  //   regression fails the test and does not hang the suite.
  function countInChild(cwd: string, files: string[]): { code: number | null; out: string; ms: number } {
    const code =
      `import { changedLineCount } from ${JSON.stringify(join(ROOT, 'lib', 'review-scope.ts'))};` +
      `console.log(JSON.stringify(changedLineCount(${JSON.stringify(cwd)}, ${JSON.stringify(files)})));`;
    const t0 = Date.now();
    const p = Bun.spawnSync(['bun', '-e', code], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 20_000, env: { ...process.env } });
    return { code: p.exitCode, out: p.stdout.toString().trim(), ms: Date.now() - t0 };
  }

  test('an untracked symlink to /dev/zero under a directory argument is unknown, promptly (it is never read)', () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    symlinkSync('/dev/zero', join(d, 'sub', 'zero.ts'));
    writeFileSync(join(d, 'sub', 'real.ts'), 'x\n');
    const r = countInChild(d, [join(d, 'sub')]);
    expect(r.code).toBe(0); // a hung count would be killed by the limit: no exit code
    expect(r.out).toBe('null');
    expect(r.ms).toBeLessThan(15_000);
    expect(countInChild(d, [join(d, 'sub', 'zero.ts')]).out).toBe('null'); // named directly: the same
  });

  test('an untracked FIFO under a directory argument does not block the count', () => {
    const d = repo();
    mkdirSync(join(d, 'sub'));
    sh(d, 'mkfifo sub/pipe.ts');
    writeFileSync(join(d, 'sub', 'real.ts'), 'x\n');
    const r = countInChild(d, [join(d, 'sub')]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('null');
    expect(countInChild(d, [join(d, 'sub', 'pipe.ts')]).out).toBe('null'); // named directly: nothing to count
  });

  test('a regular untracked file counts; a link to it named directly is the file it points to, one met in a directory is not read', () => {
    const d = repo();
    writeFileSync(join(d, 'real.ts'), 'x\ny\n');
    expect(changedLineCount(d, [join(d, 'real.ts')])).toBe(2);
    mkdirSync(join(d, 'sub'));
    symlinkSync(join(d, 'real.ts'), join(d, 'sub', 'link.ts'));
    expect(changedLineCount(d, [join(d, 'sub')])).toBeNull(); // a directory is never one accounted file
    symlinkSync(join(d, 'real.ts'), join(d, 'link.ts'));
    expect(changedLineCount(d, [join(d, 'link.ts')])).toBe(2); // the file names are resolved first (realish)
  });

  test('a renamed file (old and new both named) is unknown, not under-counted', () => {
    const d = repo({ 'a.ts': A_TS.repeat(5) });
    sh(d, 'git mv a.ts b.ts');
    expect(changedLineCount(d, [join(d, 'a.ts'), join(d, 'b.ts')])).toBeNull();
  });

  test('a tracked file that git changed against an empty-tree base counts as wholly added', () => {
    const d = repo();
    const empty = sh(d, 'git hash-object -t tree /dev/null');
    expect(changedLineCount(d, [join(d, 'a.ts')], empty)).toBe(2);
  });
});

// ── deltaLineCount ─────────────────────────────────────────────────────────────────────────────────

describe('deltaLineCount: lines changed since the newest review that lists each file', () => {
  test('only what changed since the review tree counts, not the whole change since HEAD', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
    const tree = workTree(d);
    const r = review([join(d, 'a.ts')], '2026-11-25T10:00:00.000Z', tree);
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\n\n');
    expect(deltaLineCount(d, [join(d, 'a.ts')], [r])).toBe(1); // +e (the blank line does not count)
    expect(changedLineCount(d, [join(d, 'a.ts')])).toBe(5); // against HEAD: -a +a +c +d +e
  });

  test('a file the review saw as untracked is compared with its reviewed content, not counted whole', () => {
    const d = repo();
    writeFileSync(join(d, 'new.ts'), 'x\ny\nz\n');
    const tree = workTree(d);
    const r = review([join(d, 'new.ts')], '2026-11-25T10:00:00.000Z', tree);
    writeFileSync(join(d, 'new.ts'), 'x\ny\nz\nw\n');
    expect(deltaLineCount(d, [join(d, 'new.ts')], [r])).toBe(1);
  });

  test('the newest review that lists the file is the base; files of different reviews add up', () => {
    const d = repo({ 'a.ts': A_TS, 'b.ts': 'one\n' });
    const t0 = workTree(d); // HEAD content
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\nexport const b = 2;\nexport const c = 3;\n');
    const t1 = workTree(d);
    const old = review([join(d, 'a.ts'), join(d, 'b.ts')], '2026-11-25T09:00:00.000Z', t0);
    const mid = review([join(d, 'a.ts')], '2026-11-25T10:00:00.000Z', t1);
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
    writeFileSync(join(d, 'b.ts'), 'one\ntwo\nthree\n');
    // a.ts: from t1 (the newest review listing it): +d = 1 (from t0 it would be 4); b.ts: from t0 (only `old` lists it): +two +three = 2
    expect(deltaLineCount(d, [join(d, 'a.ts')], [old, mid])).toBe(1);
    expect(deltaLineCount(d, [join(d, 'a.ts')], [mid, old])).toBe(1); // the order of the list does not matter
    expect(deltaLineCount(d, [join(d, 'a.ts'), join(d, 'b.ts')], [old, mid])).toBe(3);
    expect(deltaLineCount(d, [join(d, 'b.ts')], [mid, old])).toBe(2);
  });

  test('a document counts 0 but is accounted for', () => {
    const d = repo({ 'a.ts': A_TS, 'README.md': '# t\n' });
    const tree = workTree(d);
    const r = review([join(d, 'README.md')], '2026-11-25T10:00:00.000Z', tree);
    writeFileSync(join(d, 'README.md'), '# t\nmore\n');
    expect(deltaLineCount(d, [join(d, 'README.md')], [r])).toBe(0);
  });

  test('unknown (null): no review lists the file, the review has no tree, a malformed or absent tree, a file unchanged since', () => {
    const d = repo({ 'a.ts': A_TS, 'b.ts': 'one\n' });
    const tree = workTree(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\nexport const b = 2;\n');
    writeFileSync(join(d, 'b.ts'), 'two\n');
    const a = join(d, 'a.ts');
    expect(deltaLineCount(d, [a], [])).toBeNull(); // no review at all
    expect(deltaLineCount(d, [a], [review([join(d, 'b.ts')], '2026-11-25T10:00:00.000Z', tree)])).toBeNull(); // lists another file
    expect(deltaLineCount(d, [a], [review([a], '2026-11-25T10:00:00.000Z')])).toBeNull(); // no tree
    expect(deltaLineCount(d, [a], [review([a], '2026-11-25T10:00:00.000Z', 'not-a-tree')])).toBeNull(); // not an object id
    expect(deltaLineCount(d, [a], [review([a], '2026-11-25T10:00:00.000Z', '0'.repeat(40))])).toBeNull(); // not in this repo
    expect(deltaLineCount(d, [a, join(d, 'b.ts')], [review([a], '2026-11-25T10:00:00.000Z', tree)])).toBeNull(); // one file has no review
    const clean = review([a], '2026-11-25T10:00:00.000Z', workTree(d)); // reviewed as it is now
    expect(deltaLineCount(d, [a], [clean])).toBeNull(); // nothing changed since: not accounted for
  });

  test('unknown for a file outside the repo and a dir that is no repo; no files is 0', () => {
    const d = repo();
    const tree = workTree(d);
    expect(deltaLineCount(d, ['/etc/hosts'], [review(['/etc/hosts'], '2026-11-25T10:00:00.000Z', tree)])).toBeNull();
    const bare = realpathSync(mkdtempSync(join(sandbox, 'bare-')));
    dirs.push(bare);
    expect(deltaLineCount(bare, [join(bare, 'x.ts')], [review([join(bare, 'x.ts')], '2026-11-25T10:00:00.000Z', tree)])).toBeNull();
    expect(deltaLineCount(d, [], [])).toBe(0);
  });

  test('an unusable temp dir makes the size unknown instead of throwing', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\n');
    const tree = workTree(d);
    const r = review([join(d, 'a.ts')], '2026-11-25T10:00:00.000Z', tree);
    writeFileSync(join(d, 'a.ts'), 'export const a = 3;\n');
    expect(deltaLineCount(d, [join(d, 'a.ts')], [r])).toBe(2); // with the temp dir, it is known
    const good = process.env.TMPDIR;
    process.env.TMPDIR = join(sandbox, 'no-such-dir');
    try {
      expect(deltaLineCount(d, [join(d, 'a.ts')], [r])).toBeNull();
    } finally {
      process.env.TMPDIR = good;
    }
  });

  test('the scratch index dir is removed after the count', () => {
    const d = repo();
    const tree = workTree(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\n');
    const ls = () => Bun.spawnSync(['ls', process.env.TMPDIR!], { stdout: 'pipe' }).stdout.toString().split('\n').filter((n) => n.startsWith('goodboy-delta-'));
    const before = ls();
    expect(deltaLineCount(d, [join(d, 'a.ts')], [review([join(d, 'a.ts')], '2026-11-25T10:00:00.000Z', tree)])).toBe(3);
    expect(ls()).toEqual(before);
  });
});

// ── reviewAssignments ──────────────────────────────────────────────────────────────────────────────

describe('reviewAssignments: the runs of a review', () => {
  const ALL: ReviewAxis[] = ['hallucination', 'refactoring', 'security', 'performance', 'ui', 'data-privacy'];
  const DIMS: ReviewDimension[] = ['refactoring-quality', 'security-secrets', 'error-path', 'performance', 'ui-ux-accessibility', 'plan-completeness', 'data-privacy'];
  const axesOf = (r: ReturnType<typeof reviewAssignments>) => r.assignments.map((a) => a.axes);

  test('one axis is one run, whatever the size; the brief is empty (or `mode: delta`)', () => {
    for (const lines of [0, 5000, null]) {
      const r = reviewAssignments(['hallucination'], [], lines);
      expect(r.reason).toBe('one-axis');
      expect(r.assignments).toEqual([{ axes: ['hallucination'], dimensions: [], brief: '' }]);
    }
    const s = reviewAssignments(['security'], ['security-secrets', 'performance'], 9999, { delta: true });
    expect(s.assignments).toEqual([{ axes: ['security'], dimensions: ['security-secrets'], brief: 'mode: delta' }]);
  });

  test('a small change (up to SMALL_DIFF_LINES, 0 included) is one run for every axis with every dimension', () => {
    for (const lines of [0, SMALL_DIFF_LINES]) {
      const r = reviewAssignments(ALL, DIMS, lines);
      expect(r.reason).toBe('small');
      expect(r.assignments).toEqual([{ axes: ALL, dimensions: DIMS, brief: '' }]);
    }
  });

  test('a larger change is up to three runs in group order, each with its own dimensions and an `axes:` brief', () => {
    const r = reviewAssignments(ALL, DIMS, SMALL_DIFF_LINES + 1);
    expect(r.reason).toBe('large');
    expect(axesOf(r)).toEqual([['hallucination', 'refactoring', 'performance'], ['security', 'data-privacy'], ['ui']]);
    expect(r.assignments.map((a) => a.brief)).toEqual(['axes: hallucination, refactoring, performance', 'axes: security, data-privacy', 'axes: ui']);
    expect(r.assignments.map((a) => a.dimensions)).toEqual([
      ['refactoring-quality', 'performance'],
      ['security-secrets', 'error-path', 'data-privacy'],
      ['ui-ux-accessibility', 'plan-completeness'],
    ]);
  });

  test('an unknown size takes the same grouped plan, with its own reason', () => {
    const r = reviewAssignments(ALL, DIMS, null);
    expect(r.reason).toBe('unknown');
    expect(axesOf(r)).toEqual([['hallucination', 'refactoring', 'performance'], ['security', 'data-privacy'], ['ui']]);
  });

  test('only the groups with a present axis become runs; one group left is one run with no `axes:` brief', () => {
    const two = reviewAssignments(['hallucination', 'security'], ['security-secrets'], null);
    expect(two.assignments.map((a) => a.brief)).toEqual(['axes: hallucination', 'axes: security']);
    const ui = reviewAssignments(['hallucination', 'ui'], [], 1000);
    expect(axesOf(ui)).toEqual([['hallucination'], ['ui']]);
    const one = reviewAssignments(['hallucination', 'refactoring'], ['refactoring-quality'], 1000);
    expect(one.reason).toBe('large');
    expect(one.assignments).toEqual([{ axes: ['hallucination', 'refactoring'], dimensions: ['refactoring-quality'], brief: '' }]);
  });

  test('a small delta that is not security-sensitive is one run `mode: delta`, with `security-secrets` and `error-path` alone', () => {
    const r = reviewAssignments(['hallucination', 'refactoring', 'security'], ['refactoring-quality', 'security-secrets', 'error-path'], 12, { delta: true });
    expect(r.reason).toBe('small');
    expect(r.assignments).toEqual([
      { axes: ['hallucination', 'refactoring', 'security'], dimensions: ['refactoring-quality', 'security-secrets', 'error-path'], brief: 'mode: delta' },
    ]);
  });

  test('a small delta with a sensitive dimension gets a second, security run (data-privacy with it)', () => {
    for (const dim of ['security-injection', 'security-authz', 'web-hardening', 'dependency-risk', 'proto-pollution'] as ReviewDimension[]) {
      const r = reviewAssignments(['hallucination', 'refactoring', 'security', 'performance'], ['refactoring-quality', 'performance', 'security-secrets', dim], 40, { delta: true });
      expect([dim, r.reason]).toEqual([dim, 'security-sensitive']);
      expect(axesOf(r)).toEqual([['hallucination', 'refactoring', 'performance'], ['security']]);
      expect(r.assignments.map((a) => a.brief)).toEqual(['axes: hallucination, refactoring, performance / mode: delta', 'axes: security / mode: delta']);
      expect(r.assignments[1]!.dimensions).toEqual(['security-secrets', dim]); // only the security group's
      expect(r.assignments[0]!.dimensions).toEqual(['refactoring-quality', 'performance']);
    }
    const priv = reviewAssignments(['hallucination', 'data-privacy'], ['data-privacy'], 3, { delta: true });
    expect(priv.reason).toBe('security-sensitive');
    expect(axesOf(priv)).toEqual([['hallucination'], ['data-privacy']]);
  });

  test('sensitivity only matters for a small delta: a small full review is one run, a large delta is grouped with ` / mode: delta`', () => {
    const dims: ReviewDimension[] = ['security-authz', 'security-secrets'];
    const axes: ReviewAxis[] = ['hallucination', 'security', 'ui'];
    expect(reviewAssignments(axes, dims, 10).reason).toBe('small');
    const large = reviewAssignments(axes, dims, SMALL_DIFF_LINES + 1, { delta: true });
    expect(large.reason).toBe('large');
    expect(large.assignments.map((a) => a.brief)).toEqual(['axes: hallucination / mode: delta', 'axes: security / mode: delta', 'axes: ui / mode: delta']);
    const unknown = reviewAssignments(axes, dims, null, { delta: true });
    expect(unknown.reason).toBe('unknown');
    expect(unknown.assignments).toHaveLength(3);
  });
});

describe('reviewPlanNote and reviewSchedule', () => {
  test('the plan note names the runs, the mode and the reason', () => {
    expect(reviewPlanNote('one-axis', 1, 'goodboy:review-all', false)).toBe('one goodboy:review-all (one axis)');
    expect(reviewPlanNote('small', 1, 'goodboy:review-all', false)).toBe('one goodboy:review-all for every axis (a small diff)');
    expect(reviewPlanNote('small', 1, 'goodboy:review-all', true)).toBe('one goodboy:review-all with `mode: delta` for every axis (a small delta)');
    expect(reviewPlanNote('security-sensitive', 2, 'goodboy:review-all', true)).toBe(
      '2 goodboy:review-all runs with `mode: delta`: one for every axis but security, one for security (a small delta that touches a security-sensitive file)',
    );
    expect(reviewPlanNote('large', 3, 'goodboy:review-all', false)).toBe(`3 goodboy:review-all runs, one per assignment (more than ${SMALL_DIFF_LINES} substantive changed lines)`);
    expect(reviewPlanNote('unknown', 2, 'goodboy:review-all', true)).toBe('2 goodboy:review-all runs with `mode: delta`, one per assignment (the size is unknown)');
  });

  test('enough free slots: start all in one message', () => {
    expect(reviewSchedule(1, 3, 0)).toBe('Start it now.');
    expect(reviewSchedule(1, 3, 2)).toBe('Start it now.');
    expect(reviewSchedule(2, 3, 1)).toBe('Start both in one message.');
    expect(reviewSchedule(3, 3, 0)).toBe('Start all 3 in one message.');
  });

  test('running agents not known (no session): the cap alone decides', () => {
    expect(reviewSchedule(3, 3, null)).toBe('Start all 3 in one message.');
    expect(reviewSchedule(3, 2, null)).toBe('Start 2 now in one message and the other 1 as running agents finish (cap 2).');
  });

  test('some slots free: start those now and the rest as agents finish', () => {
    expect(reviewSchedule(3, 3, 2)).toBe('Start 1 now in one message and the other 2 as running agents finish (2 running, cap 3).');
    expect(reviewSchedule(2, 3, 2)).toBe('Start 1 now in one message and the other 1 as running agents finish (2 running, cap 3).');
  });

  test('no slot free (running at or over the cap): start them as agents finish', () => {
    expect(reviewSchedule(2, 3, 3)).toBe('No agent slot is free (3 running, cap 3): start them as running agents finish.');
    expect(reviewSchedule(1, 3, 7)).toBe('No agent slot is free (7 running, cap 3): start it as running agents finish.');
  });
});

describe('reviewWindowMinutes (moved to lib/review-validator.ts so review-axes reads the reviews the Stop reads)', () => {
  test('24 hours unless GOODBOY_REVIEW_WINDOW_MIN says otherwise', () => {
    const was = process.env.GOODBOY_REVIEW_WINDOW_MIN;
    try {
      delete process.env.GOODBOY_REVIEW_WINDOW_MIN;
      expect(reviewWindowMinutes()).toBe(1440);
      process.env.GOODBOY_REVIEW_WINDOW_MIN = '90';
      expect(reviewWindowMinutes()).toBe(90);
      process.env.GOODBOY_REVIEW_WINDOW_MIN = 'soon';
      expect(reviewWindowMinutes()).toBe(1440);
    } finally {
      if (was === undefined) delete process.env.GOODBOY_REVIEW_WINDOW_MIN;
      else process.env.GOODBOY_REVIEW_WINDOW_MIN = was;
    }
  });
});

// ── the CLI ────────────────────────────────────────────────────────────────────────────────────────

interface AxesOut {
  ok: boolean;
  files: string[];
  changed_lines: number | null;
  size_base: 'last review' | 'session start' | 'HEAD';
  plan: 'single' | 'grouped';
  plan_note: string;
  assignments: { axes: string[]; dimensions: string[]; brief: string }[];
  slots: { cap: number; running: number | null; free: number | null };
  schedule: string;
  required_dimensions: string[];
}
function axes(cwd: string, args: string[], env: Record<string, string> = {}): { out: AxesOut; code: number; stderr: string } {
  const p = Bun.spawnSync(['bun', CLI, 'review-axes', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  let out = {} as AxesOut;
  try {
    out = JSON.parse(p.stdout.toString()) as AxesOut;
  } catch {
    // a failing command prints no JSON
  }
  return { out, code: p.exitCode ?? -1, stderr: p.stderr.toString() };
}
/** A transcript, so that `--session` finds the session (Claude Code keeps it under the config dir). */
function transcript(cwd: string, id: string): void {
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
}
const dispatch = (sid: string, tuid: string, caller: string | null, t = Date.now()): void => {
  const rec: DispatchRecord = { k: 'dispatch', t, tuid, caller, callerId: null, callee: 'goodboy:review-all', hash: tuid, model: null, effort: null, files: [], why: 'new' };
  appendDispatchLog(sid, rec);
};
const BIG = Array.from({ length: SMALL_DIFF_LINES + 20 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';

/** The session dir's files with their content, to see that a command left it as it was. */
function sessionState(sid: string): Record<string, string> {
  const dir = join(process.env.TMPDIR!, `goodboy-session-${sid}`);
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).sort().map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
}

describe('readCoverageStartHead: the start of a checkout for a session, read and nothing written', () => {
  test('no pin: unknown (undefined), and no session dir is made', () => {
    const d = repo();
    const sid = uuid();
    expect(readCoverageStartHead(sid, d)).toBeUndefined();
    // No file is written. (readPin makes the session dir itself, empty: noted in the record as a low.)
    expect(sessionState(sid)).toEqual({});
  });

  test("the session's first checkout: the pinned head (a commit, null for no commit, undefined for none recorded)", () => {
    const d = repo();
    const sid = uuid();
    pinCoverageStart(sid, d);
    const start = headOf(d);
    writeFileSync(join(d, 'a.ts'), A_TS + 'export const c = 3;\n');
    sh(d, "git commit -qam 'ABC-2 later'");
    expect(readCoverageStartHead(sid, d)).toBe(start); // not the head now
    const fresh = emptyRepo(); // a first checkout with no commit
    const sid2 = uuid();
    pinCoverageStart(sid2, fresh);
    expect(readCoverageStartHead(sid2, fresh)).toBeNull();
    const pinFile = join(process.env.TMPDIR!, `goodboy-session-${sid}`, 'coverage-pin.json');
    const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as Record<string, unknown>;
    delete pin.head;
    writeFileSync(pinFile, JSON.stringify(pin));
    expect(readCoverageStartHead(sid, d)).toBeUndefined();
  });

  test('another checkout: its start pin gives a commit or null; none, or an unreadable one, is undefined; nothing is written', () => {
    const first = repo();
    const sid = uuid();
    pinCoverageStart(sid, first);
    const other = worktreeOf(first); // made after the session started: no pin for it yet
    const before = sessionState(sid);
    expect(readCoverageStartHead(sid, other)).toBeUndefined(); // no hook has seen it: no pin
    expect(sessionState(sid)).toEqual(before); // and none was made
    // A hook sees it first (topStart pins it): its start is its head then, whatever it commits later
    topStart(sid, other);
    const pinned = headOf(other);
    writeFileSync(join(other, 'a.ts'), 'export const a = 2;\n');
    sh(other, "git commit -qam 'ABC-2 later'");
    expect(headOf(other)).not.toBe(pinned);
    expect(readCoverageStartHead(sid, other)).toBe(pinned);
    // A checkout that had no commit when it was first seen
    const unborn = emptyRepo();
    topStart(sid, unborn);
    expect(readCoverageStartHead(sid, unborn)).toBeNull();
    // Its pin file damaged: not known
    const dir = join(process.env.TMPDIR!, `goodboy-session-${sid}`);
    const pinFile = readdirSync(dir).find((n) => /^start-pin-[0-9a-f]{16}\.json$/.test(n) && readFileSync(join(dir, n), 'utf8').includes(other))!;
    writeFileSync(join(dir, pinFile), '{not json');
    expect(readCoverageStartHead(sid, other)).toBeUndefined();
  });
});

describe('review-axes (the spawned CLI)', () => {
  test('a small change: the fields of the output, one run, HEAD as the base, no session', () => {
    const d = repo();
    editA(d);
    const { out, code } = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' });
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.files).toEqual([join(d, 'a.ts')]);
    expect(out.changed_lines).toBe(2);
    expect(out.size_base).toBe('HEAD');
    expect(out.plan).toBe('single');
    expect(out.plan_note).toBe('one goodboy:review-all for every axis (a small diff)');
    expect(out.assignments).toHaveLength(1);
    expect(out.assignments[0]!.brief).toBe('');
    expect(out.assignments[0]!.axes).toEqual(['hallucination', 'refactoring', 'security', 'performance']);
    expect(out.assignments[0]!.dimensions).toEqual(['performance', 'refactoring-quality', 'security-secrets']);
    expect(out.slots).toEqual({ cap: 3, running: null, free: null });
    expect(out.schedule).toBe('Start it now.');
  });

  test('a large change: grouped runs and the schedule against the cap', () => {
    const d = repo({ 'a.ts': A_TS, 'page.html': '<p>x</p>\n' });
    writeFileSync(join(d, 'a.ts'), BIG);
    writeFileSync(join(d, 'page.html'), '<p>y</p>\n');
    const { out } = axes(d, [join(d, 'a.ts'), join(d, 'page.html')], { CLAUDE_CODE_SESSION_ID: '' });
    expect(out.changed_lines).toBeGreaterThan(SMALL_DIFF_LINES);
    expect(out.plan).toBe('grouped');
    expect(out.assignments.map((a) => a.brief)).toEqual(['axes: hallucination, refactoring, performance', 'axes: security', 'axes: ui']);
    expect(out.plan_note).toContain('3 goodboy:review-all runs');
    expect(out.schedule).toBe('Start all 3 in one message.');
  });

  test('a change of documents only is 0 lines and one run', () => {
    const d = repo({ 'README.md': '# t\n' });
    writeFileSync(join(d, 'README.md'), '# t\n' + 'text\n'.repeat(400));
    const { out } = axes(d, [join(d, 'README.md')], { CLAUDE_CODE_SESSION_ID: '' });
    expect(out.changed_lines).toBe(0);
    expect(out.plan).toBe('single');
  });

  test('a session that pinned its start: a mid-session commit still counts, the size base is the session start', () => {
    const d = repo();
    const sid = uuid();
    expect(pinCoverageStart(sid, d)).toBeDefined();
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
    sh(d, "git commit -qam 'ABC-2 mid-session'");
    // Without the session, the committed file is unknown (HEAD): the unknown size takes the grouped plan.
    const none = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' });
    expect(none.out.changed_lines).toBeNull();
    expect(none.out.size_base).toBe('HEAD');
    expect(none.out.plan).toBe('grouped');
    // Through the environment of the session that runs the command
    const env = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: sid });
    expect(env.out.changed_lines).toBe(3);
    expect(env.out.size_base).toBe('session start');
    expect(env.out.plan).toBe('single');
    expect(env.out.slots).toEqual({ cap: 3, running: 0, free: 3 });
    // And through --session, which needs the session's transcript
    transcript(d, sid);
    const opt = axes(d, ['--session', sid, join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' });
    expect(opt.out.changed_lines).toBe(3);
    expect(opt.out.size_base).toBe('session start');
    // The 8-character tag of that session resolves through its transcript too
    const tag = axes(d, [join(d, 'a.ts'), '--session', sid.slice(0, 8)], { CLAUDE_CODE_SESSION_ID: '' });
    expect(tag.out.size_base).toBe('session start');
  });

  test('a session that started in a repo with no commit: files are sized against the empty tree', () => {
    const d = emptyRepo();
    const sid = uuid();
    pinCoverageStart(sid, d);
    writeFileSync(join(d, 'a.ts'), A_TS);
    sh(d, "git add -A && git commit -q -m 'ABC-1 first'");
    const { out } = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: sid });
    expect(out.size_base).toBe('session start');
    expect(out.changed_lines).toBe(2);
  });

  test('a session with no pin, or a pin whose start is unknown, is sized against HEAD', () => {
    const d = repo();
    editA(d);
    const nopin = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: uuid() });
    expect(nopin.out.size_base).toBe('HEAD');
    expect(nopin.out.changed_lines).toBe(2);
    expect(nopin.out.slots.running).toBe(0); // the session is known, no agent runs
    const sid = uuid();
    pinCoverageStart(sid, d);
    const pinFile = join(process.env.TMPDIR!, `goodboy-session-${sid}`, 'coverage-pin.json');
    const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as Record<string, unknown>;
    delete pin.head; // git could not resolve HEAD when the session started
    writeFileSync(pinFile, JSON.stringify(pin));
    const unknown = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: sid });
    expect(unknown.out.size_base).toBe('HEAD');
  });

  test('inside a checkout that is not the session\'s first: nothing is pinned or recorded, and the size is against HEAD', () => {
    const first = repo();
    const sid = uuid();
    pinCoverageStart(sid, first);
    const other = repo();
    editA(other); // already dirty when the command first sees it
    const before = sessionState(sid);
    const { out, code } = axes(other, [join(other, 'a.ts')], { CLAUDE_CODE_SESSION_ID: sid });
    expect(code).toBe(0);
    expect(out.size_base).toBe('HEAD');
    expect(out.changed_lines).toBe(2);
    expect(out.slots.running).toBe(0); // the session is known: its agents are counted
    // No start pin for that checkout and no edit-log entry for its dirty file: the session dir is as it was
    expect(sessionState(sid)).toEqual(before);
  });

  test('inside a checkout that is not the first but has its start pin: the size base is the session start', () => {
    const first = repo();
    const sid = uuid();
    pinCoverageStart(sid, first);
    const other = worktreeOf(first);
    topStart(sid, other); // a hook pinned it when it first saw it
    writeFileSync(join(other, 'a.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
    sh(other, "git commit -qam 'ABC-2 mid-session'"); // committed since the start: HEAD would say unknown
    const before = sessionState(sid);
    const { out } = axes(other, [join(other, 'a.ts')], { CLAUDE_CODE_SESSION_ID: sid });
    expect(out.size_base).toBe('session start');
    expect(out.changed_lines).toBe(3);
    expect(axes(other, [join(other, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' }).out.changed_lines).toBeNull();
    expect(sessionState(sid)).toEqual(before);
  });

  test('a planted pin head that is no object id (an option for git diff) is not used and writes no file', () => {
    const d = repo();
    editA(d);
    const sid = uuid();
    pinCoverageStart(sid, d);
    const planted = join(sandbox, 'planted-output');
    const pinFile = join(process.env.TMPDIR!, `goodboy-session-${sid}`, 'coverage-pin.json');
    const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as Record<string, unknown>;
    pin.head = `--output=${planted}`;
    writeFileSync(pinFile, JSON.stringify(pin));
    const { out, code } = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: sid });
    expect(code).toBe(0);
    expect(out.size_base).toBe('HEAD');
    expect(out.changed_lines).toBe(2);
    expect(existsSync(planted)).toBe(false);
  });

  test('--session of an id with no transcript (a made-up one) is not a session: HEAD, running null, no state dir', () => {
    const d = repo();
    editA(d);
    const made = uuid();
    const { out, code } = axes(d, ['--session', made, join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' });
    expect(code).toBe(0);
    expect(out.size_base).toBe('HEAD');
    expect(out.slots.running).toBeNull();
    expect(existsSync(join(process.env.TMPDIR!, `goodboy-session-${made}`))).toBe(false);
    // Not even when the command runs inside that session: --session is the one asked for, and it is not found
    const inside = axes(d, ['--session', made, join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: made });
    expect(inside.out.slots.running).toBeNull();
    // An 8-character tag no transcript starts with
    expect(axes(d, ['--session', 'deadbeef', join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' }).out.slots.running).toBeNull();
  });

  test('--session that is no id fails; a session id in the environment that is no UUID is no session', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\n');
    const bad = axes(d, ['--session', 'not an id', join(d, 'a.ts')]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('--session takes a session id');
    const odd = axes(d, [join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: 'sess-a' });
    expect(odd.out.size_base).toBe('HEAD');
    expect(odd.out.slots.running).toBeNull();
  });

  test('running agents of the dispatch log take the free slots: the main session\'s own, not finished, not a lead\'s callee', () => {
    const d = repo({ 'a.ts': A_TS, 'page.html': '<p>x</p>\n' });
    writeFileSync(join(d, 'a.ts'), BIG);
    writeFileSync(join(d, 'page.html'), '<p>y</p>\n');
    const files = [join(d, 'a.ts'), join(d, 'page.html')];
    const sid = uuid();
    pinCoverageStart(sid, d);
    expect(axes(d, files, { CLAUDE_CODE_SESSION_ID: sid }).out.slots).toEqual({ cap: 3, running: 0, free: 3 });
    dispatch(sid, 't1', null);
    dispatch(sid, 't2', null);
    dispatch(sid, 't3', null);
    dispatch(sid, 't4', 'goodboy:review-lead'); // a lead's own member: not the main session's agent
    appendDispatchLog(sid, { k: 'done', t: Date.now(), tuid: 't3', agentId: null, outcome: 'ok' }); // finished
    dispatch(sid, 't5', null, Date.now() - 31 * 60_000); // too old to be running
    const two = axes(d, files, { CLAUDE_CODE_SESSION_ID: sid });
    expect(two.out.slots).toEqual({ cap: 3, running: 2, free: 1 });
    expect(two.out.plan).toBe('grouped');
    expect(two.out.schedule).toBe('Start 1 now in one message and the other 2 as running agents finish (2 running, cap 3).');
    // The cap is the policy's: GOODBOY_SPAWN_CONCURRENCY
    const full = axes(d, files, { CLAUDE_CODE_SESSION_ID: sid, GOODBOY_SPAWN_CONCURRENCY: '2' });
    expect(full.out.slots).toEqual({ cap: 2, running: 2, free: 0 });
    expect(full.out.schedule).toBe('No agent slot is free (2 running, cap 2): start them as running agents finish.');
    const wide = axes(d, files, { CLAUDE_CODE_SESSION_ID: sid, GOODBOY_SPAWN_CONCURRENCY: '5' });
    expect(wide.out.schedule).toBe('Start all 3 in one message.');
  });

  describe('--delta', () => {
    function reviewed(d: string, files: string[], tree: string): void {
      mkdirSync(join(d, '.claude', 'reviews'), { recursive: true });
      writeFileSync(join(d, '.claude', 'reviews', 'r.json'), JSON.stringify({ ...review(files, new Date(Date.now() - 60_000).toISOString(), tree) }));
    }

    test('sized by what changed since the review that lists the file, base "last review", `mode: delta` in the brief', () => {
      const d = repo();
      writeFileSync(join(d, 'a.ts'), BIG);
      reviewed(d, [join(d, 'a.ts')], workTree(d));
      writeFileSync(join(d, 'a.ts'), BIG + 'export const extra = 1;\n');
      const { out } = axes(d, ['--delta', join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' });
      expect(out.changed_lines).toBe(1);
      expect(out.size_base).toBe('last review');
      expect(out.plan).toBe('single');
      expect(out.assignments).toHaveLength(1);
      expect(out.assignments[0]!.brief).toBe('mode: delta');
      expect(out.plan_note).toBe('one goodboy:review-all with `mode: delta` for every axis (a small delta)');
      // The flag may come after the files
      expect(axes(d, [join(d, 'a.ts'), '--delta'], { CLAUDE_CODE_SESSION_ID: '' }).out.changed_lines).toBe(1);
    });

    test('a small delta of a security-sensitive file gets a second, security run', () => {
      const d = repo({ 'src/auth.ts': 'export const auth = 1;\n', 'a.ts': A_TS });
      reviewed(d, [join(d, 'src/auth.ts'), join(d, 'a.ts')], workTree(d));
      writeFileSync(join(d, 'src/auth.ts'), 'export const auth = 2;\n');
      writeFileSync(join(d, 'a.ts'), 'export const a = 2;\nexport const b = 2;\n');
      const sens = axes(d, ['--delta', join(d, 'src/auth.ts')], { CLAUDE_CODE_SESSION_ID: '' });
      expect(sens.out.plan).toBe('grouped');
      expect(sens.out.assignments.map((a) => a.brief)).toEqual(['axes: hallucination, refactoring, performance / mode: delta', 'axes: security / mode: delta']);
      expect(sens.out.assignments[1]!.dimensions).toContain('security-authz');
      expect(sens.out.schedule).toBe('Start both in one message.');
      const plain = axes(d, ['--delta', join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' });
      expect(plain.out.plan).toBe('single');
    });

    test('no review lists the file (or no review at all): the size is unknown and the plan is grouped', () => {
      const d = repo();
      writeFileSync(join(d, 'a.ts'), 'export const a = 10;\n');
      const none = axes(d, ['--delta', join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: '' });
      expect(none.out.changed_lines).toBeNull();
      expect(none.out.size_base).toBe('last review');
      expect(none.out.plan).toBe('grouped');
      expect(none.out.assignments.every((a) => a.brief.endsWith('mode: delta'))).toBe(true);
      expect(none.out.plan_note).toContain('the size is unknown');
    });

    test('run from a subdirectory with CLAUDE_PROJECT_DIR set: the reviews are the project\'s, the file names the shell\'s', () => {
      const d = repo({ 'sub/s.ts': 'export const s = 1;\n', 'a.ts': A_TS });
      const sid = uuid();
      pinCoverageStart(sid, d);
      transcript(d, sid); // the session's transcript is under the project dir
      writeFileSync(join(d, 'sub/s.ts'), 'export const s = 2;\n');
      reviewed(d, [join(d, 'sub/s.ts')], workTree(d));
      writeFileSync(join(d, 'sub/s.ts'), 'export const s = 3;\nexport const t = 4;\n');
      const env = { CLAUDE_PROJECT_DIR: d, CLAUDE_CODE_SESSION_ID: '' };
      const sub = join(d, 'sub');
      const rel = axes(sub, ['--delta', 's.ts'], env); // relative to the shell dir
      expect(rel.out.size_base).toBe('last review');
      expect(rel.out.changed_lines).toBe(3); // -s=2 +s=3 +t=4 since the review
      expect(rel.out.assignments[0]!.brief).toBe('mode: delta');
      // Without the project dir the reviews of <repo>/.claude/reviews are not read from the subdirectory
      const lost = axes(sub, ['--delta', 's.ts'], { CLAUDE_PROJECT_DIR: '', CLAUDE_CODE_SESSION_ID: '' });
      expect(lost.out.changed_lines).toBeNull();
      // The session is looked up from the project dir as well
      const bySession = axes(sub, ['--session', sid, 's.ts'], env);
      expect(bySession.out.size_base).toBe('session start');
      expect(bySession.out.slots.running).toBe(0);
    });

    test('the session start is not the base of a delta, even with a pinned session', () => {
      const d = repo();
      const sid = uuid();
      pinCoverageStart(sid, d);
      editA(d);
      reviewed(d, [join(d, 'a.ts')], workTree(d));
      writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 3;\n');
      const { out } = axes(d, ['--delta', join(d, 'a.ts')], { CLAUDE_CODE_SESSION_ID: sid });
      expect(out.size_base).toBe('last review');
      expect(out.changed_lines).toBe(2); // -b +b since the review, not -a +a -b +b since the start
    });
  });
});
