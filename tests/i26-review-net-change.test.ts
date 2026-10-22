// #26 through the real Stop hook (spawned, as tests/i23-gate-scope-stop.test.ts does): the review
// gate judges this session's change only. An edit restored to the session-start blob needs no
// review (nor a doc update); a review made on the content a file has now is fresh, whenever it
// was made (review-write stamps the working tree as `tree`). Repos and session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart, withSameContent } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';
import { type ChangedFileEdit, validateReviewCoverage } from '../lib/review-validator';
import type { ReviewResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function sid(): string {
  const s = `i26${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const V1 = 'export const a = 1;\n';
const V2 = 'export const a = 1;\nexport const b = 2;\n';

/** A repo with the files committed, and the session pinned at that commit. */
function project(files: Record<string, string> = {}): { d: string; s: string } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i26-')));
  dirs.push(d);
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  for (const [p, t] of Object.entries({ 'src/a.ts': V1, ...files })) write(d, p, t);
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  const s = sid();
  pinCoverageStart(s, d);
  return { d, s };
}
const edited = (s: string, file: string) => recordEdit(s, file, 0, undefined, Date.now());

async function stop(d: string, s: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_TEST_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off', ...env },
  });
  const out = (await new Response(p.stdout).text()) || '{}';
  await p.exited;
  return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
}

/** review-write run for real in the project: the record it writes (with the server's tree). */
function reviewWrite(d: string, files: string[]): ReviewResult {
  const input = { reviewed_files: files, category: 'fix-bug', findings: [], verdict: 'pass', dimensions_checked: Object.values(AXIS_DIMENSIONS).flat() };
  const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'review-write'], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(r.exitCode).toBe(0);
  const { path } = JSON.parse(r.stdout.toString()) as { path: string };
  return JSON.parse(readFileSync(path, 'utf8')) as ReviewResult;
}

const REVIEW_ASKED = /Review is required for the changed files|Review validation failed/;

describe('net change: an edit restored to the start blob needs no review', () => {
  test('a changed file is asked about until it is restored; then the review gate has nothing to ask', async () => {
    const { d, s } = project();
    const a = join(d, 'src', 'a.ts');
    writeFileSync(a, V2);
    edited(s, a);
    const blocked = await stop(d, s);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toMatch(REVIEW_ASKED);
    expect(blocked.reason).toContain('src/a.ts');
    writeFileSync(a, V1); // the start content again
    const restored = await stop(d, s);
    expect(restored.decision).toBeUndefined();
    expect(restored.reason ?? '').not.toMatch(REVIEW_ASKED);
  }, 60_000);

  test('only the restored file drops out: another changed file is still asked about, alone', async () => {
    const { d, s } = project({ 'src/c.ts': V1 });
    const a = join(d, 'src', 'a.ts');
    const c = join(d, 'src', 'c.ts');
    writeFileSync(a, V2);
    edited(s, a);
    writeFileSync(a, V1);
    writeFileSync(c, V2);
    edited(s, c);
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/c.ts');
    expect(out.reason).not.toContain('src/a.ts');
  }, 60_000);

  test('a new untracked file is still a change', async () => {
    const { d, s } = project();
    const n = write(d, 'src/new.ts', V1);
    edited(s, n);
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/new.ts');
  }, 60_000);

  test('the docs rule does not ask for a doc update about a restored file', async () => {
    const { d, s } = project({
      'ARCH.md': '# Arch\n',
      '.goodboy/docs.json': JSON.stringify({ docs: [{ path: 'ARCH.md', session_start: false, covers: ['src/**'] }] }),
    });
    const a = join(d, 'src', 'a.ts');
    writeFileSync(a, V2);
    edited(s, a);
    const changed = await stop(d, s, { GOODBOY_DOCS_GATE: 'on' });
    expect(changed.reason ?? '').toMatch(/docs rule/);
    writeFileSync(a, V1);
    const restored = await stop(d, s, { GOODBOY_DOCS_GATE: 'on' });
    expect(restored.reason ?? '').not.toMatch(/docs rule/);
    expect(restored.decision).toBeUndefined();
  }, 60_000);
});

describe('content freshness: a review made on the content the file has now', () => {
  test('review-write stamps the working tree it ran on as `tree`', () => {
    const { d } = project();
    writeFileSync(join(d, 'src', 'a.ts'), V2);
    const rec = reviewWrite(d, ['src/a.ts']);
    expect(rec.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(d, `git cat-file -p ${rec.tree}:src/a.ts`)).toBe(V2.trimEnd());
  });

  /** a.ts is changed and reviewed; later edits (newer than the review) leave it as `last`. */
  async function editedAfterReview(...later: string[]) {
    const { d, s } = project();
    const a = join(d, 'src', 'a.ts');
    writeFileSync(a, V2);
    edited(s, a);
    reviewWrite(d, [a]);
    for (const text of later) {
      Bun.sleepSync(20);
      writeFileSync(a, text);
      edited(s, a);
    }
    return stop(d, s);
  }

  test('an edit after the review that brings back the reviewed content needs no new review', async () => {
    const same = await editedAfterReview(V2 + 'export const c = 3;\n', V2);
    expect(same.reason ?? '').not.toMatch(REVIEW_ASKED);
    expect(same.decision).toBeUndefined();
  }, 60_000);

  test('an edit after the review to other content still needs one (a delta review)', async () => {
    const other = await editedAfterReview(V2 + 'export const d = 4;\n');
    expect(other.decision).toBe('block');
    expect(other.reason).toMatch(/changed after their review/);
  }, 60_000);

  test('validateReviewCoverage: a stale review counts when its tree holds the content, not otherwise', () => {
    const review = (over: Partial<ReviewResult>): ReviewResult => ({
      timestamp: '2026-10-22T01:00:00.000Z',
      reviewed_files: ['/p/src/a.ts'],
      category: 'fix-bug',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: [],
      ...over,
    });
    const tree = 'b'.repeat(40);
    const edit = { file: '/p/src/a.ts', lastEditTimestamp: '2026-10-22T02:00:00.000Z' };
    expect(validateReviewCoverage([review({ tree })], [edit]).stale).toEqual(['/p/src/a.ts']);
    expect(validateReviewCoverage([review({ tree })], [{ ...edit, sameContentTrees: new Set([tree]) }]).ok).toBe(true);
    expect(validateReviewCoverage([review({})], [{ ...edit, sameContentTrees: new Set([tree]) }]).ok).toBe(false);
    expect(validateReviewCoverage([review({ tree: 'c'.repeat(40) })], [{ ...edit, sameContentTrees: new Set([tree]) }]).ok).toBe(false);
  });
});

describe('withSameContent: which list of files a record names (in-process)', () => {
  test('a review record is read through its reviewed_files; a test record through tested_files by default', () => {
    const { d } = project();
    const abs = join(d, 'src', 'a.ts');
    const tree = sh(d, 'git rev-parse HEAD^{tree}');
    const edit: ChangedFileEdit = { file: abs, lastEditTimestamp: '2026-10-22T02:00:00.000Z' };
    const at = '2026-10-22T01:00:00.000Z';
    const review = { timestamp: at, tree, reviewed_files: [abs] };
    const test = { timestamp: at, tree, tested_files: [abs] };
    expect(withSameContent([edit], [review], d, (r) => r.reviewed_files)[0].sameContentTrees).toEqual(new Set([tree]));
    expect(withSameContent([edit], [test], d)[0].sameContentTrees).toEqual(new Set([tree]));
    // A record that does not list the file says nothing about it.
    expect(withSameContent([edit], [{ ...review, reviewed_files: [] }], d, (r) => r.reviewed_files)[0].sameContentTrees).toBeUndefined();
    expect(withSameContent([edit], [review], d)[0].sameContentTrees).toBeUndefined();
  });
});
