// M6g (track M, #19): the data-privacy dimension and axis (lib/review-dimensions.ts), `review-axes`, and the Stop's
// review gate in a project that holds real data.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resetHookClock, startHookClock } from '../lib/hook-clock';
import { REVIEW_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';
import { privacyOptionsFor } from '../lib/stop-groups';
import { AXIS_DIMENSIONS, axesFor, axesOfDimensions, missingDimensionsByFile, requiredDimensionsFor, type ReviewDimension } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const STOP_HOOK = join(ROOT, 'hooks', 'stop.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const HELPER_IMPORT = `import { pick } from '../.goodboy/sandbox/data/goodboy-data';\nexport const u = pick;\n`;
const CODE: ReviewDimension[] = ['performance', 'refactoring-quality', 'security-secrets'];
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const only = (...files: string[]) => (f: string) => files.includes(f);

describe('the dimension and the axis', () => {
  test('data-privacy is required only for a file the predicate accepts, on top of what its name asks', () => {
    expect(requiredDimensionsFor(['tests/users.test.ts'])).toEqual([...CODE].sort());
    expect(requiredDimensionsFor(['tests/users.test.ts'], { privacy: only('tests/users.test.ts') })).toEqual([...CODE, 'data-privacy' as ReviewDimension].sort());
    // a file the predicate does not name is unaffected, in the same list
    expect(requiredDimensionsFor(['tests/plain.test.ts'], { privacy: only('tests/users.test.ts') })).toEqual([...CODE].sort());
    // a document or a preview the predicate accepts needs it too (data.json, a README in the sandbox dir)
    expect(requiredDimensionsFor(['.goodboy/sandbox/data.json'], { privacy: () => true })).toContain('data-privacy');
    expect(requiredDimensionsFor(['notes.md'], { privacy: () => true })).toEqual(['data-privacy']);
    expect(requiredDimensionsFor(['preview/a.html'], { privacy: () => true })).toContain('data-privacy');
    // no options, an empty option object and a predicate that says no change nothing
    expect(requiredDimensionsFor(['notes.md'], {})).toEqual([]);
    expect(requiredDimensionsFor(['notes.md'], { privacy: () => false })).toEqual([]);
  });

  test('only a literal true counts, and blank names are never asked', () => {
    const asked: string[] = [];
    const got = requiredDimensionsFor(['', '  ', 'notes.md'], { privacy: ((f: string) => (asked.push(f), 1)) as never });
    expect(got).toEqual([]);
    expect(asked).toEqual(['notes.md']);
  });

  test('the axis lists the one dimension, and axesFor adds it after the others when it is required', () => {
    expect(AXIS_DIMENSIONS['data-privacy']).toEqual(['data-privacy']);
    expect(axesFor(['notes.md'])).toEqual(['hallucination']);
    expect(axesFor(['notes.md'], { privacy: () => true })).toEqual(['hallucination', 'data-privacy']);
    expect(axesFor(['tests/users.test.ts'], { privacy: () => true })).toEqual(['hallucination', 'refactoring', 'security', 'performance', 'data-privacy']);
    expect(axesFor(['tests/users.test.ts'])).toEqual(['hallucination', 'refactoring', 'security', 'performance']);
  });

  test('a review that lists the dimension is the data-privacy axis, not a dimension of no axis', () => {
    expect(axesOfDimensions(['data-privacy'])).toEqual(['data-privacy']);
    expect(axesOfDimensions(['data-privacy', 'hallucination'])).toEqual(['data-privacy', 'hallucination']);
  });

  test('missingDimensionsByFile asks the predicate per file; a review of one file does not satisfy another', () => {
    const reviews: Record<string, { dimensions_checked: string[] }[]> = {
      'tests/a.test.ts': [{ dimensions_checked: [...CODE, 'data-privacy'] }],
      'tests/b.test.ts': [{ dimensions_checked: CODE }],
    };
    const privacy = only('tests/a.test.ts', 'tests/b.test.ts');
    expect(missingDimensionsByFile(['tests/a.test.ts', 'tests/b.test.ts'], (f) => reviews[f], { privacy })).toEqual([{ file: 'tests/b.test.ts', missing: ['data-privacy'] }]);
    // without the predicate neither is missing anything
    expect(missingDimensionsByFile(['tests/a.test.ts', 'tests/b.test.ts'], (f) => reviews[f])).toEqual([]);
  });
});

// ---- a real-data project, on disk ----

function project(local: string | null, files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-m6g-rev-'));
  tmpDirs.push(cwd);
  if (local !== null) put(cwd, '.goodboy/sandbox/local.json', local);
  for (const [rel, text] of Object.entries(files)) put(cwd, rel, text);
  return cwd;
}

function put(cwd: string, rel: string, text: string): void {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
}

const REAL = JSON.stringify({ dump: null, dumpFormat: null, realData: true });
const NOT_REAL = JSON.stringify({ dump: null, dumpFormat: null, realData: false });

const FILES = {
  'tests/users.test.ts': HELPER_IMPORT,
  'tests/plain.test.ts': `import { add } from '../src/add';\nexport const t = add;\n`,
  'tests/other-users.test.ts': HELPER_IMPORT,
  '.goodboy/sandbox/data.json': '{"version":1}\n',
  '.goodboy/sandbox/compose.yml': 'services: {}\n',
};

describe('review-axes in a project', () => {
  function axes(cwd: string, files: string[]): { required_dimensions: string[]; axes: { axis: string; dimensions: string[] }[] } {
    const p = Bun.spawnSync(['bun', CLI, 'review-axes', ...files], { cwd, env: { ...process.env, HOME: cwd }, stdout: 'pipe', stderr: 'pipe' });
    return JSON.parse(p.stdout.toString());
  }

  test('real data: the helper-using test, data.json and a sandbox file list the data-privacy axis; a plain test does not', () => {
    const cwd = project(REAL, FILES);
    for (const f of ['tests/users.test.ts', '.goodboy/sandbox/data.json', '.goodboy/sandbox/compose.yml']) {
      const out = axes(cwd, [f]);
      expect([f, out.required_dimensions.includes('data-privacy')]).toEqual([f, true]);
      expect([f, out.axes.find((a) => a.axis === 'data-privacy')?.dimensions]).toEqual([f, ['data-privacy']]);
    }
    const plain = axes(cwd, ['tests/plain.test.ts']);
    expect(plain.required_dimensions).not.toContain('data-privacy');
    expect(plain.axes.map((a) => a.axis)).not.toContain('data-privacy');
  });

  test('absolute names work, and a relative name is read against the shell dir below the repository top', () => {
    const cwd = project(REAL, FILES);
    expect(axes(cwd, [join(cwd, 'tests/users.test.ts')]).required_dimensions).toContain('data-privacy');
    // the repository top is the project; the shell is in a package below it, and the name is relative to the shell
    const top = project(REAL, { 'pkg/tests/users.test.ts': `import { pick } from '../../.goodboy/sandbox/data/goodboy-data';\nexport const u = pick;\n` });
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: top }).exitCode).toBe(0);
    const p = Bun.spawnSync(['bun', CLI, 'review-axes', 'tests/users.test.ts'], { cwd: join(top, 'pkg'), env: { ...process.env, HOME: top }, stdout: 'pipe', stderr: 'pipe' });
    expect(JSON.parse(p.stdout.toString()).required_dimensions).toContain('data-privacy');
  });

  test('a project without real data lists nothing new, whatever its files hold', () => {
    for (const local of [NOT_REAL, null]) {
      const cwd = project(local, FILES);
      const out = axes(cwd, ['tests/users.test.ts', '.goodboy/sandbox/data.json']);
      expect([local, out.required_dimensions.includes('data-privacy')]).toEqual([local, false]);
      expect(out.axes.map((a) => a.axis)).not.toContain('data-privacy');
    }
  });

  test('a local file goodboy cannot read counts as real data', () => {
    const cwd = project('{ not json', FILES);
    expect(axes(cwd, ['tests/users.test.ts']).required_dimensions).toContain('data-privacy');
  });

  test('a script that is no test and uses the helper lists the axis too', () => {
    const cwd = project(REAL, { 'scripts/leak.ts': HELPER_IMPORT, 'scripts/plain.ts': 'export const a = 1;\n' });
    expect(axes(cwd, ['scripts/leak.ts']).required_dimensions).toContain('data-privacy');
    expect(axes(cwd, ['scripts/plain.ts']).required_dimensions).not.toContain('data-privacy');
  });

  test('a project dir that is no repository decides per nested repository, as the Stop’s groups do (the CLI said the axis was the Stop’s answer)', () => {
    // the project dir holds two repositories: `real` holds real data, `other` does not
    const cwd = project(null, {
      'real/.goodboy/sandbox/local.json': REAL,
      'real/tests/users.test.ts': HELPER_IMPORT,
      'other/.goodboy/sandbox/local.json': NOT_REAL,
      'other/tests/users.test.ts': HELPER_IMPORT,
      'loose/tests/users.test.ts': HELPER_IMPORT,
    });
    for (const d of ['real', 'other']) expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: join(cwd, d) }).exitCode).toBe(0);
    const both = axes(cwd, ['real/tests/users.test.ts']);
    expect(both.required_dimensions).toContain('data-privacy');
    expect(axes(cwd, ['other/tests/users.test.ts']).required_dimensions).not.toContain('data-privacy');
    // one call with files of several repositories: each is decided by its own
    const mixed = axes(cwd, ['other/tests/users.test.ts', 'real/tests/users.test.ts']);
    expect(mixed.required_dimensions).toContain('data-privacy');
    // a loose file belongs to the project dir itself, which holds no real data
    expect(axes(cwd, ['loose/tests/users.test.ts']).required_dimensions).not.toContain('data-privacy');
  });
});

describe('privacyOptionsFor: the Stop’s predicate is bounded by the shared deadline and the hook’s clock', () => {
  afterEach(() => resetHookClock());

  test('time left reads the files; the deadline run out makes every source file a privacy file (fail closed)', () => {
    const cwd = project(REAL, { 'src/plain.ts': 'export const a = 1;\n', 'src/leak.ts': HELPER_IMPORT, 'notes.md': 'x\n' });
    const files = ['src/plain.ts', 'src/leak.ts', 'notes.md'].map((f) => join(cwd, f));
    const read = privacyOptionsFor('m6g-deadline', cwd, files, { left: () => 1000 }).privacy!;
    expect(files.map((f) => read(f))).toEqual([false, true, false]);
    const late = privacyOptionsFor('m6g-deadline', cwd, files, { left: () => 0 }).privacy!;
    expect(files.map((f) => late(f))).toEqual([true, true, false]);
  });

  test('the hook’s own clock bounds it with no deadline given', () => {
    const cwd = project(REAL, { 'src/plain.ts': 'export const a = 1;\n' });
    const f = join(cwd, 'src/plain.ts');
    expect(privacyOptionsFor('m6g-clock', cwd, [f]).privacy!(f)).toBe(false);
    startHookClock(0);
    expect(privacyOptionsFor('m6g-clock', cwd, [f]).privacy!(f)).toBe(true);
  });

  test('a project that holds no real data is asked nothing, late or not', () => {
    const cwd = project(NOT_REAL, { 'src/plain.ts': 'export const a = 1;\n' });
    const f = join(cwd, 'src/plain.ts');
    expect(privacyOptionsFor('m6g-notreal', cwd, [f], { left: () => 0 }).privacy!(f)).toBe(false);
  });
});

// ---- the Stop ----

const sessionDirOf = (tmp: string, sessionId: string): string => join(tmp, `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`);

function sandbox(local: string | null, files: Record<string, string> = FILES): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-m6g-tmp-'));
  tmpDirs.push(tmp);
  return { tmp, cwd: project(local, files), sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

/** One turn's edits of files that already exist in the project. */
function seed(s: { tmp: string; cwd: string; sessionId: string }, files: string[], counter = 0): void {
  const dir = sessionDirOf(s.tmp, s.sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(counter));
  const ts = new Date().toISOString();
  writeFileSync(join(dir, 'edits.jsonl'), files.map((f) => JSON.stringify({ file: resolve(s.cwd, f), turn: 1, timestamp: ts })).join('\n') + '\n');
}

function review(cwd: string, name: string, files: string[], dimensions: string[]): void {
  mkdirSync(join(cwd, '.claude', 'reviews'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude', 'reviews', name),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files.map((f) => resolve(cwd, f)),
      category: 'add-feature',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: dimensions,
    }),
  );
}

async function runStop(s: { tmp: string; cwd: string; sessionId: string }, active = false): Promise<{ decision?: string; reason?: string }> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd: s.cwd,
    env: { ...process.env, TMPDIR: s.tmp, HOME: s.tmp, GOODBOY_TEST_GATE: 'off' },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: s.sessionId, cwd: s.cwd, hook_event_name: 'Stop', ...(active ? { stop_hook_active: true } : {}) })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    return {};
  }
}

const cursorOf = (s: { tmp: string; cwd: string; sessionId: string }): string => join(sessionDirOf(s.tmp, s.sessionId), cursorFileName(REVIEW_CURSOR_FILE, s.cwd));

describe('the Stop in a project that holds real data', () => {
  test('a changed helper-using test with a review that lacks data-privacy blocks, naming the file and the dimension', async () => {
    const s = sandbox(REAL);
    seed(s, ['tests/users.test.ts']);
    review(s.cwd, 'r1.json', ['tests/users.test.ts'], CODE);
    const out = await runStop(s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('users.test.ts: data-privacy');
  });

  test('the same change with a review that lists data-privacy passes', async () => {
    const s = sandbox(REAL);
    seed(s, ['tests/users.test.ts']);
    review(s.cwd, 'r1.json', ['tests/users.test.ts'], [...CODE, 'data-privacy']);
    expect((await runStop(s)).decision).toBeUndefined();
  });

  test('the dimension may come from a second, parallel review of the same file', async () => {
    const s = sandbox(REAL);
    seed(s, ['tests/users.test.ts']);
    review(s.cwd, 'r1.json', ['tests/users.test.ts'], CODE);
    review(s.cwd, 'r2.json', ['tests/users.test.ts'], ['data-privacy']);
    expect((await runStop(s)).decision).toBeUndefined();
  });

  test('a script that is no test and uses the helper needs it too; without a review of the dimension the Stop blocks', async () => {
    const s = sandbox(REAL, { ...FILES, 'scripts/leak.ts': HELPER_IMPORT });
    seed(s, ['scripts/leak.ts']);
    review(s.cwd, 'r1.json', ['scripts/leak.ts'], CODE);
    const out = await runStop(s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('leak.ts: data-privacy');
    review(s.cwd, 'r2.json', ['scripts/leak.ts'], ['data-privacy']);
    expect((await runStop(s)).decision).toBeUndefined();
  });

  test('a plain test of the project needs no more than before', async () => {
    const s = sandbox(REAL);
    seed(s, ['tests/plain.test.ts']);
    review(s.cwd, 'r1.json', ['tests/plain.test.ts'], CODE);
    expect((await runStop(s)).decision).toBeUndefined();
  });

  test('data.json and a sandbox file need it; the local answers do not', async () => {
    for (const f of ['.goodboy/sandbox/data.json', '.goodboy/sandbox/compose.yml']) {
      const s = sandbox(REAL);
      seed(s, [f]);
      review(s.cwd, 'r1.json', [f], [...requiredDimensionsFor([f])]);
      const out = await runStop(s);
      expect([f, out.decision, out.reason?.includes('data-privacy')]).toEqual([f, 'block', true]);
    }
    const s = sandbox(REAL, { ...FILES, '.goodboy/sandbox/scan.json': '{}\n' });
    seed(s, ['.goodboy/sandbox/scan.json']);
    review(s.cwd, 'r1.json', ['.goodboy/sandbox/scan.json'], []);
    expect((await runStop(s)).reason ?? '').not.toContain('data-privacy');
  });

  test('each file needs the dimension from a review of its own: the other test’s review does not do', async () => {
    const s = sandbox(REAL);
    seed(s, ['tests/users.test.ts', 'tests/other-users.test.ts']);
    review(s.cwd, 'r1.json', ['tests/users.test.ts'], [...CODE, 'data-privacy']);
    review(s.cwd, 'r2.json', ['tests/other-users.test.ts'], CODE);
    const out = await runStop(s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('other-users.test.ts: data-privacy');
    expect(out.reason).not.toContain('/users.test.ts: data-privacy');
  });

  test('a project that is not real data, or has no sandbox, asks for nothing new', async () => {
    for (const local of [NOT_REAL, null]) {
      const s = sandbox(local);
      seed(s, ['tests/users.test.ts']);
      review(s.cwd, 'r1.json', ['tests/users.test.ts'], CODE);
      expect([local, (await runStop(s)).decision]).toEqual([local, undefined]);
    }
  });

  test('a local file goodboy cannot read is real data: the dimension is asked for', async () => {
    const s = sandbox('{ not json');
    seed(s, ['tests/users.test.ts']);
    review(s.cwd, 'r1.json', ['tests/users.test.ts'], CODE);
    const out = await runStop(s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('data-privacy');
  });

  test('a test too big to read counts as a privacy file (fail closed)', async () => {
    const s = sandbox(REAL, { 'tests/big.test.ts': `export const x = '${'x'.repeat(600 * 1024)}';\n` });
    seed(s, ['tests/big.test.ts']);
    review(s.cwd, 'r1.json', ['tests/big.test.ts'], CODE);
    const out = await runStop(s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('big.test.ts: data-privacy');
  });

  test('the stop_hook_active acceptance does not accept a review without the dimension, and accepts one with it', async () => {
    const no = sandbox(REAL);
    seed(no, ['tests/users.test.ts'], 5);
    review(no.cwd, 'r1.json', ['tests/users.test.ts'], CODE);
    expect((await runStop(no, true)).decision).toBeUndefined();
    expect(existsSync(cursorOf(no))).toBe(false);

    const yes = sandbox(REAL);
    seed(yes, ['tests/users.test.ts'], 5);
    review(yes.cwd, 'r1.json', ['tests/users.test.ts'], [...CODE, 'data-privacy']);
    expect((await runStop(yes, true)).decision).toBeUndefined();
    expect(existsSync(cursorOf(yes))).toBe(true);
  });
});
