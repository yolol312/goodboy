// #38 through the real Stop hook (spawned, as tests/i26-review-net-change.test.ts does): a high
// finding cleared by a later delta review stays cleared when `git checkout` and a fast-forward merge
// rewrite the files with the same content (and move their mtimes past every review). The review
// records are written by `cli.ts review-write`, so they carry the work-tree `tree`. Repos and
// session dirs are temporary; the test gate and the docs gate are off so the review gate is the
// one under test.
//
// Every Stop that is asserted on follows an edit of the file in its own turn (`edited`): without
// one the review gate carries the turn ("no change this turn") and says nothing about findings.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { getCurrentTurn, recordEdit } from '../lib/file-tracker';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';
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
  const s = `i38${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const V1 = 'export const run = (x: string) => x;\n';
const VULNERABLE = 'import { execSync } from "node:child_process";\nexport const run = (x: string) => execSync(`echo ${x} | sh`);\n';
const FIXED = 'import { execFileSync } from "node:child_process";\nexport const run = (x: string) => execFileSync("echo", [x]);\n';
const ALL_DIMENSIONS = Object.values(AXIS_DIMENSIONS).flat();
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';

/** A repo on `main` with src/a.ts committed, the session pinned there, and a work branch `feat`. */
function project(extra: Record<string, string> = {}): { d: string; s: string; a: string } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i38-')));
  dirs.push(d);
  sh(d, GIT_INIT);
  for (const [p, t] of Object.entries({ 'src/a.ts': V1, ...extra })) write(d, p, t);
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  const s = sid();
  pinCoverageStart(s, d);
  sh(d, 'git checkout -q -b feat');
  return { d, s, a: join(d, 'src', 'a.ts') };
}
const edited = (s: string, file: string) => recordEdit(s, file, getCurrentTurn(s), undefined, Date.now());
const pause = () => Bun.sleepSync(25);

async function stop(d: string, s: string) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_TEST_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off' },
  });
  const out = (await new Response(p.stdout).text()) || '{}';
  await p.exited;
  return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
}

/** review-write run for real in the project (the record carries the server's `tree`). */
function reviewWrite(d: string, files: string[], findings: object[] = []): ReviewResult {
  const input = { reviewed_files: files, category: 'fix-bug', findings, verdict: findings.length > 0 ? 'needs-changes' : 'pass', dimensions_checked: ALL_DIMENSIONS };
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
const highFinding = (file: string) => ({ file, line: 2, issue: 'input reaches a shell', severity: 'high', probe: 'echo $X | sh -> ran' });

const HIGH = /high severity/;
const CARRIED = '파일 변경이 없어 리뷰 게이트가 막지 않았어요';
const REVIEW_ASKED = /Review is required for the changed files|Review validation failed/;

/** The Stop let the turn through: no block, no carry, no review asked for, no finding open. */
function expectClean(out: { decision?: string; reason?: string; systemMessage?: string }): void {
  expect(out.reason ?? '').not.toMatch(HIGH);
  expect(out.reason ?? '').not.toMatch(REVIEW_ASKED);
  expect(JSON.stringify(out)).not.toContain(CARRIED);
  expect(out.decision).toBeUndefined();
}

/** The incident up to the delta review: a high finding on the vulnerable content (blocked once), the
 *  fix, and a delta review of the fix. No Stop after the delta review: the caller does that. */
async function fixedAndReviewed() {
  const p = project();
  writeFileSync(p.a, VULNERABLE);
  edited(p.s, p.a);
  pause();
  const finding = reviewWrite(p.d, [p.a], [highFinding(p.a)]);
  pause();
  const blocked = await stop(p.d, p.s);
  expect(blocked.decision).toBe('block');
  expect(blocked.reason).toMatch(HIGH);
  pause();
  writeFileSync(p.a, FIXED);
  edited(p.s, p.a);
  pause();
  const delta = reviewWrite(p.d, [p.a]);
  pause();
  return { ...p, finding, delta };
}

describe('#38 a cleared finding stays cleared when the files are rewritten with the same content', () => {
  test('baseline: the fix and its delta review clear the finding (by time and content alike)', async () => {
    const { d, s } = await fixedAndReviewed();
    expectClean(await stop(d, s));
  }, 90_000);

  test('git checkout main + merge --ff-only of the reviewed branch (the incident)', async () => {
    const { d, s } = await fixedAndReviewed();
    sh(d, "git add src && git commit -q -m 'ABC-1 fix'");
    pause();
    sh(d, 'git checkout -q main && git merge -q --ff-only feat');
    expect(readFileSync(join(d, 'src', 'a.ts'), 'utf8')).toBe(FIXED);
    expectClean(await stop(d, s));
  }, 90_000);

  test('the same bytes written again after the delta review', async () => {
    const { d, s, a } = await fixedAndReviewed();
    writeFileSync(a, FIXED);
    edited(s, a);
    expectClean(await stop(d, s));
  }, 90_000);

  test('an mtime moved to a later time (touch)', async () => {
    const { d, s, a } = await fixedAndReviewed();
    const later = new Date(Date.now() + 5_000);
    utimesSync(a, later, later);
    edited(s, a);
    expectClean(await stop(d, s));
  }, 90_000);

  test('an mtime older than every review changes nothing either', async () => {
    const { d, s, a } = await fixedAndReviewed();
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(a, past, past);
    edited(s, a);
    expectClean(await stop(d, s));
  }, 90_000);
});

describe('#38 a finding is still open where the content says it is', () => {
  test('the fix taken back (the vulnerable content again, a later mtime): the finding blocks', async () => {
    const { d, s, a } = await fixedAndReviewed();
    pause();
    writeFileSync(a, VULNERABLE);
    edited(s, a);
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(HIGH);
  }, 90_000);

  test('content never reviewed after the fix (a later edit): a delta review is asked for', async () => {
    const { d, s, a } = await fixedAndReviewed();
    pause();
    writeFileSync(a, FIXED + 'export const extra = 1;\n');
    edited(s, a);
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/changed after their review/);
  }, 90_000);

  test('a finding never fixed (no delta review) blocks after a checkout that keeps the content, and the text says so', async () => {
    const p = project();
    writeFileSync(p.a, VULNERABLE);
    edited(p.s, p.a);
    pause();
    reviewWrite(p.d, [p.a], [highFinding(p.a)]);
    pause();
    sh(p.d, "git add src && git commit -q -m 'ABC-1 wip'");
    sh(p.d, 'git checkout -q main && git merge -q --ff-only feat');
    const out = await stop(p.d, p.s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(HIGH);
    expect(out.reason).toContain('review the flagged file as it is now');
    expect(out.reason).toMatch(/a checkout that keeps .*content changes nothing/);
  }, 90_000);
});

describe('#38 files the trees cannot judge fall back to the time rule', () => {
  /** The flagged file is git-ignored (no tree holds it): fixed, and a delta review lists it. */
  async function ignoredFlagged() {
    const p = project({ '.gitignore': 'gen/\n' });
    const g = write(p.d, 'gen/g.ts', VULNERABLE);
    writeFileSync(p.a, FIXED);
    edited(p.s, p.a);
    pause();
    reviewWrite(p.d, [p.a, g], [highFinding(g)]);
    pause();
    writeFileSync(g, FIXED);
    pause();
    reviewWrite(p.d, [p.a, g]);
    pause();
    return { ...p, g };
  }

  test('a git-ignored flagged file fixed before the delta review: cleared by time, as before #38', async () => {
    const { d, s } = await ignoredFlagged();
    edited(s, join(d, 'src', 'a.ts'));
    expectClean(await stop(d, s));
  }, 90_000);

  test('a git-ignored flagged file rewritten after the delta review: still open by time', async () => {
    const { d, s, a, g } = await ignoredFlagged();
    writeFileSync(g, FIXED);
    edited(s, a);
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(HIGH);
  }, 90_000);
});
