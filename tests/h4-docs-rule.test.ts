// H4 doc map and docs rule (track H §14.5): a change to a file a doc covers needs that doc
// changed in the task or a recorded check made after the change (bounded by the doc map's own
// edit); the generated test catalog is checked by regenerating it; the Stop hook runs the rule
// in a project only; SessionStart suggests /init once and warns about a long CLAUDE.md.
// Repos, session dirs and the log dir are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordEdit } from '../lib/file-tracker';
import { claudeMdNotice, staleDocs } from '../lib/doc-map';
import { catalogRows, renderCatalog, TEST_CATALOG_FILE, testTypeOf } from '../lib/test-catalog';
import { readDocMap } from '../lib/project-knowledge';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h4-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `h4${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const T0 = '2026-10-16T01:00:00.000Z';
const at = (sec: number) => new Date(Date.parse(T0) + sec * 1000).toISOString();

/** A project whose map says ARCH.md covers src/** and CLAUDE.md covers everything. */
function project(docs?: unknown[]): string {
  const d = tmp();
  mkdirSync(join(d, '.git'));
  mkdirSync(join(d, '.goodboy'));
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, '.goodboy', 'policy.md'), '## P1 X\n- decide: human\n- source: user 2026-10-16\n- date: 2026-10-16\n- checked: 2026-10-16\n');
  writeFileSync(join(d, 'ARCH.md'), '# Arch\n');
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(
    join(d, '.goodboy', 'docs.json'),
    JSON.stringify({
      docs: docs ?? [
        { path: '.goodboy/policy.md', session_start: true, covers: [] },
        { path: 'ARCH.md', session_start: false, covers: ['src/**'] },
      ],
    }),
  );
  return d;
}

const edit = (d: string, rel: string, sec: number) => ({ file: join(d, rel), lastEditTimestamp: at(sec) });

describe('staleDocs', () => {
  test('a covered change without the doc changed names the doc and the files', () => {
    const d = project();
    const got = staleDocs({ root: d, edits: [edit(d, 'src/a.ts', 0)], docs: readDocMap(d).docs });
    expect(got).toEqual([{ doc: 'ARCH.md', changed: ['src/a.ts'] }]);
  });

  test('the doc changed in the task: fine; a file the doc does not cover: fine', () => {
    const d = project();
    const docs = readDocMap(d).docs;
    expect(staleDocs({ root: d, edits: [edit(d, 'src/a.ts', 0), edit(d, 'ARCH.md', 5)], docs })).toEqual([]);
    expect(staleDocs({ root: d, edits: [edit(d, 'lib/b.ts', 0)], docs })).toEqual([]);
    expect(staleDocs({ root: d, edits: [{ file: '/elsewhere/src/a.ts', lastEditTimestamp: at(0) }], docs })).toEqual([]);
  });

  test('a recorded check counts only after the change and no later than the doc map edit', () => {
    const d = project();
    const withCheck = (checked: string) => [{ path: 'ARCH.md', session_start: false, covers: ['src/**'], checked }];
    const change = edit(d, 'src/a.ts', 10);
    const mapEdit = edit(d, '.goodboy/docs.json', 20);
    // after the change, before the map edit: passes (second resolution, as `date -u` writes it)
    expect(staleDocs({ root: d, edits: [change, mapEdit], docs: withCheck('2026-10-16T01:00:10Z') })).toEqual([]);
    // before the change: stale
    expect(staleDocs({ root: d, edits: [change, mapEdit], docs: withCheck('2026-10-16T01:00:05Z') })).toHaveLength(1);
    // written ahead of the map edit (a time in the future): stale
    expect(staleDocs({ root: d, edits: [change, mapEdit], docs: withCheck('2026-10-16T02:00:00Z') })).toHaveLength(1);
    // the map was not edited in the task: an old check says nothing about this change
    expect(staleDocs({ root: d, edits: [change], docs: withCheck('2026-10-16T01:00:15Z') })).toHaveLength(1);
    // not a time
    expect(staleDocs({ root: d, edits: [change, mapEdit], docs: withCheck('yes') })).toHaveLength(1);
  });

  test('editing the doc map or another mapped doc is no covered change', () => {
    const d = project([
      { path: 'CLAUDE.md', session_start: false, covers: ['**'] },
      { path: 'ARCH.md', session_start: false, covers: ['src/**'] },
    ]);
    const docs = readDocMap(d).docs;
    expect(staleDocs({ root: d, edits: [edit(d, '.goodboy/docs.json', 0), edit(d, 'ARCH.md', 1)], docs })).toEqual([]);
    expect(staleDocs({ root: d, edits: [edit(d, 'src/a.ts', 0), edit(d, 'ARCH.md', 1)], docs })).toEqual([{ doc: 'CLAUDE.md', changed: ['src/a.ts'] }]);
  });
});

describe('the test catalog', () => {
  test('test types from the path and the imports', () => {
    expect(testTypeOf('e2e/login.spec.ts', '')).toBe('e2e');
    expect(testTypeOf('tests/x.test.ts', "import { test } from '@playwright/test';")).toBe('e2e');
    expect(testTypeOf('tests/integration/db.test.ts', '')).toBe('integration');
    expect(testTypeOf('src/List.test.tsx', '')).toBe('ui');
    expect(testTypeOf('tests/x.test.ts', "import { render } from '@testing-library/react';")).toBe('ui');
    expect(testTypeOf('tests/x.test.ts', '')).toBe('unit');
    expect(testTypeOf('pkg/x_test.go', '')).toBe('unit');
  });

  test('rows from the git-visible test files, rendered the same every time', () => {
    const d = project();
    mkdirSync(join(d, 'tests'));
    writeFileSync(join(d, 'tests', 'a.test.ts'), "describe('sums', () => { test('adds', () => {}); it('carries', () => {}); });\n");
    writeFileSync(join(d, 'tests', 'helper.ts'), 'export {};\n'); // not a test
    writeFileSync(join(d, 'pkg_test.go'), 'func TestParse(t *testing.T) {}\nfunc TestPrint(t *testing.T) {}\n');
    rmSync(join(d, '.git'), { recursive: true });
    Bun.spawnSync(['git', 'init', '-q', d]);
    const rows = catalogRows(d)!;
    expect(rows.map((r) => [r.file, r.type, r.features, r.tests])).toEqual([
      ['pkg_test.go', 'unit', ['TestParse', 'TestPrint'], 2],
      ['tests/a.test.ts', 'unit', ['sums'], 2],
    ]);
    const md = renderCatalog(rows);
    expect(md).toBe(renderCatalog(catalogRows(d)!));
    expect(md).toContain('| sums | unit | tests/a.test.ts | 2 |');
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no date: regenerating changes nothing
  });

  test('git that cannot list files is not "no tests": no empty catalog, the rule fails open', () => {
    const d = project([{ path: TEST_CATALOG_FILE, session_start: false, covers: ['tests/**'] }]);
    rmSync(join(d, '.git'), { recursive: true }); // not a repo
    expect(catalogRows(d)).toBeNull();
    const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'test-catalog'], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(d, TEST_CATALOG_FILE))).toBe(false);
    expect(staleDocs({ root: d, edits: [edit(d, 'tests/a.test.ts', 0)], docs: readDocMap(d).docs })).toEqual([]);
  });

  test('counting tests stays linear on an unclosed test.each(', () => {
    const d = project();
    rmSync(join(d, '.git'), { recursive: true });
    Bun.spawnSync(['git', 'init', '-q', d]);
    mkdirSync(join(d, 'tests'));
    writeFileSync(join(d, 'tests', 'big.test.ts'), 'test.each('.repeat(30_000));
    writeFileSync(join(d, 'tests', 'test_big.py'), `${'\n'.repeat(120_000)}def test_a():\n    pass\n`);
    const t = Date.now();
    const rows = catalogRows(d)!;
    expect(rows.map((r) => r.tests)).toEqual([30_000, 1]);
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  test('cli.ts test-catalog writes the file; the docs rule checks it by regenerating', () => {
    const d = project([{ path: TEST_CATALOG_FILE, session_start: false, covers: ['tests/**'] }]);
    rmSync(join(d, '.git'), { recursive: true });
    Bun.spawnSync(['git', 'init', '-q', d]);
    mkdirSync(join(d, 'tests'));
    writeFileSync(join(d, 'tests', 'a.test.ts'), "test('one', () => {});\n");
    const docs = () => readDocMap(d).docs;
    // no catalog yet: stale
    expect(staleDocs({ root: d, edits: [edit(d, 'tests/a.test.ts', 0)], docs: docs() })).toEqual([{ doc: TEST_CATALOG_FILE, changed: ['tests/a.test.ts'] }]);
    const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'test-catalog'], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(d, TEST_CATALOG_FILE))).toBe(true);
    // current: fine, though the catalog file has no edit record (the CLI wrote it)
    expect(staleDocs({ root: d, edits: [edit(d, 'tests/a.test.ts', 0)], docs: docs() })).toEqual([]);
    writeFileSync(join(d, 'tests', 'a.test.ts'), "test('one', () => {});\ntest('two', () => {});\n");
    expect(staleDocs({ root: d, edits: [edit(d, 'tests/a.test.ts', 9)], docs: docs() })).toHaveLength(1);
  });
});

async function stop(d: string, s: string, env: Record<string, string> = {}, active = false) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: active })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_TEST_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', ...env },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(out || '{}') as { decision?: string; reason?: string };
}

/** A passing review of these files on disk, every dimension checked. */
function passingReview(d: string, files: string[]): void {
  const dir = join(d, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files.map((f) => join(d, f)),
      category: 'fix-bug',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
    }),
  );
}

describe('through the Stop hook', () => {
  test('blocks on a stale doc, names it, and passes once the doc changed', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    const first = await stop(d, s);
    expect(first.decision).toBe('block');
    expect(first.reason).toMatch(/docs rule/);
    expect(first.reason).toContain('ARCH.md');
    recordEdit(s, join(d, 'ARCH.md'), 0, undefined, Date.now());
    const second = await stop(d, s);
    expect(second.reason ?? '').not.toMatch(/docs rule/);
  }, 30_000);

  test('a second Stop is no way past: no review is accepted while a doc is stale', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    passingReview(d, ['src/a.ts']);
    expect((await stop(d, s)).reason).toMatch(/docs rule/);
    expect(await stop(d, s, {}, true)).toEqual({}); // the active Stop: no block, and no accept
    expect((await stop(d, s)).reason).toMatch(/docs rule/); // the edits are still the task's
  }, 30_000);

  test('an active Stop that answers another gate still gets the one docs block', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    // e.g. the test gate blocked the last Stop; the docs rule has not blocked yet
    expect((await stop(d, s, {}, true)).reason).toMatch(/docs rule/);
    expect(await stop(d, s, {}, true)).toEqual({}); // bounded: the next active Stop ends
  }, 30_000);

  test('a failing earlier gate does not make active Stops re-block over stale docs', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    const env = { GOODBOY_TEST_GATE: 'on' }; // no test result: the test gate keeps failing
    expect((await stop(d, s, env, true)).reason).toMatch(/docs rule/); // the one docs block
    expect(await stop(d, s, env, true)).toEqual({});
    expect(await stop(d, s, env, true)).toEqual({});
  }, 30_000);

  test('a doc fixed after the block goes on to the review in the same turn', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    expect((await stop(d, s)).reason).toMatch(/docs rule/);
    recordEdit(s, join(d, 'ARCH.md'), 0, undefined, Date.now());
    const active = await stop(d, s, {}, true);
    expect(active.decision).toBe('block'); // the review gate, not a silent end
    expect(active.reason ?? '').not.toMatch(/docs rule/);
  }, 30_000);

  test('docs without covers are docs, not code', async () => {
    const d = project([
      { path: '.goodboy/policy.md', session_start: true, covers: [] },
      { path: 'docs/guide.md', session_start: false, covers: [] },
      { path: 'README.md', session_start: false, covers: ['**'] },
    ]);
    mkdirSync(join(d, 'docs'));
    writeFileSync(join(d, 'docs', 'guide.md'), '# Guide\n');
    const s = sid();
    recordEdit(s, join(d, '.goodboy', 'policy.md'), 0, undefined, Date.now());
    recordEdit(s, join(d, 'docs', 'guide.md'), 0, undefined, Date.now());
    expect((await stop(d, s)).reason ?? '').not.toMatch(/docs rule/);
  }, 30_000);

  test('off in a non-project directory and with GOODBOY_DOCS_GATE=off', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    expect((await stop(d, s, { GOODBOY_DOCS_GATE: 'off' })).reason ?? '').not.toMatch(/docs rule/);
    const n = project();
    writeFileSync(join(n, 'CLAUDE.md'), 'goodboy: non-project\n');
    const s2 = sid();
    recordEdit(s2, join(n, 'src', 'a.ts'), 0, undefined, Date.now());
    expect((await stop(n, s2)).reason ?? '').not.toMatch(/docs rule/);
  }, 30_000);
});

describe('CLAUDE.md at SessionStart', () => {
  test('a missing CLAUDE.md gets the /init suggestion once per project', () => {
    const log = tmp();
    const d = project();
    const env = { GOODBOY_LOG_DIR: log };
    expect(claudeMdNotice(d, 'startup', env)).toMatch(/\/init/);
    expect(claudeMdNotice(d, 'startup', env)).toBeNull();
    expect(claudeMdNotice(project(), 'startup', env)).toMatch(/\/init/);
    // a CLAUDE.md the session gets from its cwd (below the root) counts
    const sub = project();
    mkdirSync(join(sub, 'pkg'));
    writeFileSync(join(sub, 'pkg', 'CLAUDE.md'), '# pkg\n');
    expect(claudeMdNotice(sub, 'startup', env, join(sub, 'pkg'))).toBeNull();
  });

  test('a CLAUDE.md over 300 lines is warned about at startup and resume, not after a compaction', () => {
    const log = tmp();
    const d = project();
    writeFileSync(join(d, 'CLAUDE.md'), 'rule\n'.repeat(301));
    const env = { GOODBOY_LOG_DIR: log };
    expect(claudeMdNotice(d, 'startup', env)).toMatch(/301/);
    expect(claudeMdNotice(d, 'resume', env)).toMatch(/301/);
    expect(claudeMdNotice(d, 'compact', env)).toBeNull();
    writeFileSync(join(d, 'CLAUDE.md'), 'rule\n'.repeat(300));
    expect(claudeMdNotice(d, 'startup', env)).toBeNull();
  });

  test('the SessionStart hook shows it to the user in a project only', async () => {
    const log = tmp();
    const run = async (d: string) => {
      const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'session-start.ts')], {
        cwd: d,
        stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: sid(), source: 'startup' })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GOODBOY_LOG_DIR: log },
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return (JSON.parse(out || '{}') as { systemMessage?: string }).systemMessage ?? '';
    };
    expect(await run(project())).toMatch(/\/init/);
    const withSub = project();
    mkdirSync(join(withSub, 'pkg'));
    writeFileSync(join(withSub, 'pkg', 'CLAUDE.md'), '# pkg\n');
    expect(await run(join(withSub, 'pkg'))).not.toMatch(/\/init/); // the hook passes the cwd
    const n = project();
    mkdirSync(join(n, 'sub'));
    writeFileSync(join(n, 'sub', 'CLAUDE.md'), 'goodboy: non-project\n');
    expect(await run(join(n, 'sub'))).not.toMatch(/\/init|CLAUDE\.md/);
  }, 20_000);
});
