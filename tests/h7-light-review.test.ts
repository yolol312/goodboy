// H7 lighter verification (track H, the user's choice of 2026-10-16): a small diff gets one
// review-all for every axis, files changed after their review get a delta review, and a new
// round runs only on a high. The gates are unchanged; what changes is what review-axes, the
// Stop messages and the review skills tell the model to run. Repos are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { changedLineCount, reviewPlan, SMALL_DIFF_LINES } from '../lib/review-scope';
import { validateReviewCoverage } from '../lib/review-validator';
import type { ReviewResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sh(cwd: string, cmd: string): void {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
}
function repo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h7-')));
  dirs.push(d);
  sh(d, 'git init -q -b main && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false');
  writeFileSync(join(d, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  return d;
}

describe('the review size', () => {
  test('changed lines: tracked edits (added + removed) and untracked files; null outside git', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
    writeFileSync(join(d, 'new.ts'), 'x\ny\nz\n');
    expect(changedLineCount(d, [join(d, 'a.ts')])).toBe(3); // 2 added, 1 removed
    expect(changedLineCount(d, [join(d, 'a.ts'), join(d, 'new.ts')])).toBe(6);
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h7-bare-')));
    dirs.push(bare);
    expect(changedLineCount(bare, [join(bare, 'x.ts')])).toBeNull();
  });

  test('an unknown size is null, never 0: committed, ignored, binary or outside files', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 3;\n');
    sh(d, "git commit -qam 'ABC-2 change'");
    expect(changedLineCount(d, [join(d, 'a.ts')])).toBeNull(); // committed already
    writeFileSync(join(d, '.gitignore'), 'gen.ts\n');
    writeFileSync(join(d, 'gen.ts'), 'x\n');
    expect(changedLineCount(d, [join(d, 'gen.ts')])).toBeNull(); // ignored
    writeFileSync(join(d, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
    expect(changedLineCount(d, [join(d, 'blob.bin')])).toBeNull(); // binary
    expect(changedLineCount(d, ['/etc/hosts'])).toBeNull(); // outside the repo
  });

  test('a checkout reached through a symlink still counts', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\n');
    const link = join(realpathSync(tmpdir()), `goodboy-h7-link-${Math.random().toString(36).slice(2, 8)}`);
    symlinkSync(d, link);
    dirs.push(link);
    expect(changedLineCount(link, [join(link, 'a.ts')])).toBe(2);
  });

  test('one review-all for a small diff or a single axis; one per axis otherwise, and when unknown', () => {
    expect(reviewPlan(SMALL_DIFF_LINES, 4)).toBe('single');
    expect(reviewPlan(SMALL_DIFF_LINES + 1, 4)).toBe('per-axis');
    expect(reviewPlan(5000, 1)).toBe('single');
    expect(reviewPlan(null, 3)).toBe('per-axis');
  });

  test('review-axes reports the changed lines and the plan', () => {
    const d = repo();
    writeFileSync(join(d, 'a.ts'), 'export const a = 10;\nexport const b = 2;\n');
    const r = Bun.spawnSync(['bun', CLI, 'review-axes', join(d, 'a.ts')], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
    const out = JSON.parse(r.stdout.toString()) as { changed_lines: number | null; plan: string; plan_note: string };
    expect(out.changed_lines).toBe(2);
    expect(out.plan).toBe('single');
    expect(out.plan_note).toMatch(/one goodboy:review-all for every axis/);
  });
});

describe('delta reviews', () => {
  const review = (files: string[], ts: string): ReviewResult =>
    ({ timestamp: ts, reviewed_files: files, category: 'fix-bug', findings: [], verdict: 'pass', dimensions_checked: [] }) as unknown as ReviewResult;

  test('the coverage check names the files changed after their review', () => {
    const v = validateReviewCoverage(
      [review(['/r/a.ts', '/r/b.ts'], '2026-10-16T01:00:00.000Z')],
      [
        { file: '/r/a.ts', lastEditTimestamp: '2026-10-16T02:00:00.000Z' },
        { file: '/r/b.ts', lastEditTimestamp: '2026-10-16T00:30:00.000Z' },
      ],
    );
    expect(v.ok).toBe(false);
    expect(v.stale).toEqual(['/r/a.ts']);
    expect(v.missing ?? []).toEqual([]);
  });

  test('the Stop hook offers a delta review for files changed after their review', async () => {
    const d = repo();
    const s = `h7${Math.random().toString(36).slice(2, 10)}`;
    dirs.push(join(tmpdir(), `goodboy-session-${s}`));
    const { recordEdit } = await import('../lib/file-tracker');
    const old = new Date(Date.now() - 60_000).toISOString();
    const reviews = join(d, '.claude', 'reviews');
    sh(d, `mkdir -p ${reviews}`);
    writeFileSync(join(reviews, 'r.json'), JSON.stringify({ ...review([join(d, 'a.ts')], old), unknown_assumptions_checked: [] }));
    recordEdit(s, join(d, 'a.ts'), 0, undefined, Date.now());
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
      cwd: d,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GOODBOY_TEST_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0' },
    });
    const out = JSON.parse((await new Response(p.stdout).text()) || '{}') as { decision?: string; reason?: string };
    await p.exited;
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/mode: delta/);
    expect(out.reason).toContain(join(d, 'a.ts'));
    expect(out.reason).toMatch(/every dimension .*review-axes/); // not just the last review's
  }, 30_000);
});

describe('the review skills', () => {
  test('review-all knows the delta mode; request-review sizes the review and re-rounds only on a high', () => {
    const agent = readFileSync(join(ROOT, 'agents', 'review-all.md'), 'utf8');
    expect(agent).toMatch(/mode: delta/);
    expect(agent).toMatch(/every dimension `review-axes` lists/);
    // The workflow skills most sessions follow size the review by the plan too.
    for (const s of ['fix-bug', 'add-feature', 'refactor-code', 'prepare-migration']) {
      const body = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
      expect([s, /`plan`/.test(body), /one `goodboy:review-all` per axis[,;]/.test(body)]).toEqual([s, true, false]);
    }
    const skill = readFileSync(join(ROOT, 'skills', 'request-review', 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/plan/);
    expect(skill).toMatch(/only when .*high/i);
    expect(skill).toMatch(/mode: delta/);
  });
});
