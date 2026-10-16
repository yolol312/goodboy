// H6 test tier advice (track H §14.7): test-write keeps a per-project test profile (per type:
// tests, duration, when measured; partial runs never shrink it), and SessionStart gives the
// tier advice once a session when the measured total is over ten minutes. Advice only.
// Repos and session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mergeProfile, profileTotalMs, readTestProfile, TEST_PROFILE_FILE, tierAdvice, tierOf } from '../lib/test-profile';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h6-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `h6${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
const MIN = 60_000;
const T = '2026-10-16T02:00:00.000Z';
const daysLater = (n: number) => new Date(Date.parse(T) + n * 86_400_000).toISOString();

function project(profile?: unknown): string {
  const d = tmp();
  Bun.spawnSync(['git', 'init', '-q', d]);
  if (profile !== undefined) {
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, TEST_PROFILE_FILE), JSON.stringify(profile));
  }
  return d;
}

describe('the profile', () => {
  test('a type is added; a run with at least as many tests replaces it; a partial run does not, unless the entry is a month old', () => {
    let p = mergeProfile({}, { unit: { suites: 1, tests: 100, duration_ms: 5 * MIN } }, T);
    expect(p).toEqual({ unit: { tests: 100, duration_ms: 5 * MIN, measured_at: T } });
    p = mergeProfile(p, { e2e: { suites: 1, tests: 10, duration_ms: 20 * MIN } }, daysLater(1));
    expect(Object.keys(p).sort()).toEqual(['e2e', 'unit']);
    // a narrow run (3 tests) keeps the full one
    expect(mergeProfile(p, { unit: { suites: 1, tests: 3, duration_ms: 1000 } }, daysLater(2)).unit!.tests).toBe(100);
    // a bigger or equal one replaces it
    expect(mergeProfile(p, { unit: { suites: 1, tests: 100, duration_ms: 6 * MIN } }, daysLater(2)).unit!.duration_ms).toBe(6 * MIN);
    // an old entry gives way to any new measurement
    expect(mergeProfile(p, { unit: { suites: 1, tests: 3, duration_ms: 1000 } }, daysLater(31)).unit!.tests).toBe(3);
    expect(profileTotalMs(p)).toBe(25 * MIN);
  });

  test('tiers: up to 10 min, up to 1 h, more', () => {
    expect(tierOf(10 * MIN)).toBe(1);
    expect(tierOf(10 * MIN + 1)).toBe(2);
    expect(tierOf(60 * MIN)).toBe(2);
    expect(tierOf(60 * MIN + 1)).toBe(3);
  });

  test('a missing or broken profile reads as empty', () => {
    expect(readTestProfile(project())).toEqual({});
    const d = project();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, TEST_PROFILE_FILE), '{nope');
    expect(readTestProfile(d)).toEqual({});
    writeFileSync(join(d, TEST_PROFILE_FILE), JSON.stringify({ unit: { tests: 'x' }, e2e: { tests: 5, duration_ms: 70 * MIN, measured_at: T } }));
    expect(Object.keys(readTestProfile(d))).toEqual(['e2e']);
  });
});

describe('the advice', () => {
  test('none at ten minutes or less; tier 2 and 3 name what to run and leave the setup to the user', () => {
    expect(tierAdvice(project(profile(2, 7)), sid())).toBeNull();
    const two = tierAdvice(project(profile(3, 22)), sid())!;
    expect(two.context).toMatch(/about 25 min/);
    expect(two.context).toMatch(/unit and integration tests at commit, everything before push/);
    expect(two.context).toMatch(/user's decision/);
    expect(two.systemMessage).toMatch(/약 25분/);
    const three = tierAdvice(project(profile(10, 110)), sid())!;
    expect(three.context).toMatch(/affected tests before push/);
    expect(three.context).toMatch(/about 2 h/);
  });

  test('at most once a session', () => {
    const d = project(profile(3, 22));
    const s = sid();
    expect(tierAdvice(d, s)).not.toBeNull();
    expect(tierAdvice(d, s)).toBeNull();
    expect(tierAdvice(d, sid())).not.toBeNull();
  });
});

describe('through the CLI and the hook', () => {
  const record = (dir: string, tests: number, durationMs: number) => ({
    tested_files: [join(dir, 'src', 'a.ts')],
    category: 'fix-bug',
    test_files: [CLI],
    environment: { mode: 'none' },
    suites: [{ name: 'unit', command: 'bun test', passed: tests, failed: 0, output: `${tests} pass`, type: 'unit', duration_ms: durationMs }],
    acceptance: [{ id: 'AC-1', description: 'x', test: 't', red: { command: 'c', output: 'o', exit_code: 1 }, green: { command: 'c', output: 'o', exit_code: 0 } }],
    verdict: 'pass',
  });
  const write = (dir: string, input: unknown) =>
    Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: dir, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });

  test('test-write keeps the profile; a narrower run does not shrink it', () => {
    const d = project();
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
    expect(write(d, record(d, 120, 15 * MIN)).exitCode).toBe(0);
    expect(readTestProfile(d).unit).toMatchObject({ tests: 120, duration_ms: 15 * MIN });
    expect(write(d, record(d, 4, 2000)).exitCode).toBe(0);
    expect(readTestProfile(d).unit).toMatchObject({ tests: 120, duration_ms: 15 * MIN });
  });

  test('SessionStart sends it once a session, in a project only', async () => {
    const start = async (dir: string, s: string, source: string) => {
      const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'session-start.ts')], {
        cwd: dir,
        stdin: new TextEncoder().encode(JSON.stringify({ cwd: dir, session_id: s, source })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GOODBOY_LOG_DIR: tmp() },
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return JSON.parse(out || '{}') as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
    };
    const d = project(profile(3, 22));
    writeFileSync(join(d, 'CLAUDE.md'), '# p\n');
    const s = sid();
    const first = await start(d, s, 'startup');
    expect(first.hookSpecificOutput?.additionalContext ?? '').toMatch(/test tier advice/);
    expect(first.systemMessage ?? '').toMatch(/약 25분/);
    const again = await start(d, s, 'compact');
    expect(again.hookSpecificOutput?.additionalContext ?? '').not.toMatch(/test tier advice/);
    const n = project(profile(3, 22));
    writeFileSync(join(n, 'CLAUDE.md'), 'goodboy: non-project\n');
    expect((await start(n, sid(), 'startup')).systemMessage ?? '').not.toMatch(/분/);
    expect(existsSync(join(n, TEST_PROFILE_FILE))).toBe(true);
    expect(readFileSync(join(n, TEST_PROFILE_FILE), 'utf8')).toContain('e2e');
  }, 30_000);
});

function profile(unitMin: number, e2eMin: number) {
  return {
    unit: { tests: 900, duration_ms: unitMin * MIN, measured_at: T },
    e2e: { tests: 40, duration_ms: e2eMin * MIN, measured_at: T },
  };
}
