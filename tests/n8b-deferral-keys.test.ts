// N8b (plan §20.12, #44 item 2), the parts that do not need lib/deferral.ts:
//   AC-1  the keys `defer-review` / `defer-test` are user globs: read from `decide: human` entries only, pinned at the
//         session start (lib/changed-coverage.ts);
//   AC-4d the Stop's once-per-session notice is kept in the session's habit state (`deferNoticeShown`,
//         lib/token-habits.ts), which the spawned-Stop tests rely on (tests/n8b-deferral-stop.test.ts);
//   AC-9  the status line shows the deferred files still pending (the script is spawned, as tests/statusline.test.ts
//         does).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { addedUserGlobs, globsInText, pinCoverageStart, policyGlobs, sessionUserGlobs, USER_GLOB_KEYS } from '../lib/changed-coverage';
import { readHabitState, writeHabitState } from '../lib/token-habits';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-n8bk-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function sessionId(): string {
  const s = `n8bk${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
/** A policy file text: one entry (`decide: human` unless told) with the given keys. */
const policy = (globs: Record<string, string>, decide = 'human'): string =>
  ['## P1 Deferrals', `- decide: ${decide}`, '- source: user 2026-11-26', ...Object.entries(globs).map(([k, v]) => `- ${k}: ${v}`), ''].join('\n');

// ── AC-1 ────────────────────────────────────────────────────────────────────────────────────────

describe('AC-1: the deferral keys are user globs', () => {
  test('both keys are in USER_GLOB_KEYS', () => {
    expect(USER_GLOB_KEYS).toContain('defer-review');
    expect(USER_GLOB_KEYS).toContain('defer-test');
  });

  test('globsInText reads them from decide: human entries only, braces kept whole', () => {
    const human = policy({ 'defer-review': 'src/a.ts, src/*.{ts,tsx}', 'defer-test': 'lib/**' });
    expect(globsInText(human, 'defer-review')).toEqual(['src/a.ts', 'src/*.{ts,tsx}']);
    expect(globsInText(human, 'defer-test')).toEqual(['lib/**']);
    const ai = policy({ 'defer-review': 'src/a.ts', 'defer-test': 'lib/**' }, 'ai');
    expect(globsInText(ai, 'defer-review')).toEqual([]);
    expect(globsInText(ai, 'defer-test')).toEqual([]);
    // One human entry with only one of the keys sets only that one.
    expect(globsInText(policy({ 'defer-test': 'lib/**' }), 'defer-review')).toEqual([]);
  });

  test('addedUserGlobs names a deferral glob that the edit adds, and only the added one', () => {
    const before = policy({ 'defer-test': 'lib/a.ts' });
    const after = policy({ 'defer-test': 'lib/a.ts, lib/b.ts', 'defer-review': 'src/**' });
    expect(addedUserGlobs(before, after)).toEqual([
      { key: 'defer-review', glob: 'src/**' },
      { key: 'defer-test', glob: 'lib/b.ts' },
    ]);
    // An ai entry adds nothing.
    expect(addedUserGlobs('', policy({ 'defer-test': 'lib/b.ts' }, 'ai'))).toEqual([]);
  });

  test('policyGlobs reads the policy file at the project dir; pinCoverageStart pins both keys', () => {
    const d = tmp();
    sh(d, 'git init -q -b main');
    write(d, '.goodboy/policy.md', policy({ 'defer-review': 'src/a.ts', 'defer-test': 'src/b.ts' }));
    expect(policyGlobs(d, d, 'defer-review')).toEqual(['src/a.ts']);
    expect(policyGlobs(d, d, 'defer-test')).toEqual(['src/b.ts']);
    const s = sessionId();
    pinCoverageStart(s, d);
    expect(sessionUserGlobs(s, d, d, 'defer-review')).toEqual(['src/a.ts']);
    expect(sessionUserGlobs(s, d, d, 'defer-test')).toEqual(['src/b.ts']);
    // A glob the file gains after the start is not the pin's; one it loses is gone.
    write(d, '.goodboy/policy.md', policy({ 'defer-review': 'src/a.ts, src/new.ts', 'defer-test': 'src/other.ts' }));
    expect(sessionUserGlobs(s, d, d, 'defer-review')).toEqual(['src/a.ts']);
    expect(sessionUserGlobs(s, d, d, 'defer-test')).toEqual([]);
  });
});

// ── AC-4d (state) ───────────────────────────────────────────────────────────────────────────────

describe('AC-4d: the notice flags are kept in the habit state', () => {
  test('deferNoticeShown survives a write and a read, and a later write of another field keeps it', () => {
    const s = sessionId();
    expect(readHabitState(s).deferNoticeShown).toBeUndefined();
    writeHabitState(s, { ...readHabitState(s), deferNoticeShown: { review: true } });
    expect(readHabitState(s).deferNoticeShown).toEqual({ review: true });
    const habit = readHabitState(s);
    habit.deferNoticeShown = { ...habit.deferNoticeShown, test: true, waitingReview: true, waitingTest: true };
    writeHabitState(s, habit);
    expect(readHabitState(s).deferNoticeShown).toEqual({ review: true, test: true, waitingReview: true, waitingTest: true });
  });
});

// ── AC-9 ────────────────────────────────────────────────────────────────────────────────────────

describe('AC-9: the status line shows the deferred files', () => {
  const SCRIPT = join(ROOT, 'statusline', 'statusline.ts');
  async function line(deferred: unknown): Promise<string> {
    const t = tmp('goodboy-n8b-sl-');
    const sid = `n8bsl-${Math.random().toString(36).slice(2)}`;
    const dir = join(t, `goodboy-session-${sid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ updatedAt: new Date().toISOString(), context: null, ...(deferred === undefined ? {} : { deferred }) }));
    const proc = Bun.spawn(['bun', SCRIPT], {
      cwd: t,
      env: { ...process.env, TMPDIR: t, HOME: t },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd: t })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  }

  test('both counts, one of them, none, and no field', async () => {
    expect(await line({ review: 2, test: 3 })).toBe('🐶 ⏸ push 때 리뷰 2·테스트 3');
    expect(await line({ review: 1, test: 0 })).toBe('🐶 ⏸ push 때 리뷰 1');
    expect(await line({ review: 0, test: 4 })).toBe('🐶 ⏸ push 때 테스트 4');
    expect(await line({ review: 0, test: 0 })).toBe('🐶 goodboy');
    expect(await line(undefined)).toBe('🐶 goodboy');
  });
});
