import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  affectedGaps,
  affectedReason,
  affectedTests,
  changedStartTests,
  existingTestsMode,
  judgedWeakened,
  pinJudgedWeakened,
  startTestFiles,
  suiteRan,
  testStrength,
  unjudgedWeakened,
  weakenedReason,
  weakenedTests,
} from '../lib/existing-tests';
import { ensureSessionDir } from '../lib/file-tracker';
import { workTreeState } from '../lib/push-test';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';
import type { ReviewResult, TestResult } from '../lib/types';

// Track I, I5 (#6, plan §15.8): the existing tests that load a changed file run with the
// change, and weakening an existing test is a review finding.

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-i5-'));
  dirs.push(d);
  return d;
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
/** A repo with the files committed; returns the top and the commit (the session's start). */
function repo(files: Record<string, string>): { top: string; head: string } {
  const top = join(tmp(), 'repo');
  mkdirSync(top, { recursive: true });
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 't@example.com');
  git(top, 'config', 'user.name', 't');
  git(top, 'config', 'commit.gpgsign', 'false');
  for (const [f, t] of Object.entries(files)) write(top, f, t);
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'start');
  return { top, head: git(top, 'rev-parse', 'HEAD') };
}

const T = 'import { expect, test } from "bun:test";\n';
/** Shared lines, so git sees an edited file as renamed (over half the same). */
const FIXTURE = Array.from({ length: 12 }, (_, i) => `const fixture${i} = { id: ${i}, name: "case ${i}" };\n`).join('');

describe('the tests that load a changed file', () => {
  test('AC-1: JS/TS relative imports with extension and index resolution', () => {
    const { top, head } = repo({
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'src/util/index.ts': 'export const id = <T>(x: T) => x;\n',
      'tests/calc.test.ts': `${T}import { add } from "../src/calc";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
      'tests/calc-esm.test.ts': `${T}import { add } from "../src/calc.js";\ntest("add", () => expect(add(1, 1)).toBe(2));\n`,
      'tests/util.test.ts': `${T}import { id } from "../src/util";\ntest("id", () => expect(id(1)).toBe(1));\n`,
      'tests/other.test.ts': `${T}// mentions calc but does not load it\ntest("x", () => expect(1).toBe(1));\n`,
    });
    const got = affectedTests(top, head, [join(top, 'src/calc.ts'), join(top, 'src/util/index.ts')]);
    expect(got.get('src/calc.ts')).toEqual(['tests/calc-esm.test.ts', 'tests/calc.test.ts']);
    expect(got.get('src/util/index.ts')).toEqual(['tests/util.test.ts']);
  });

  test('AC-1: the start content decides; a renamed test is followed, a deleted one left to the weakened rule', () => {
    const { top, head } = repo({
      'index.ts': 'export const main = () => 1;\n',
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'tests/main.test.ts': `${T}import { main } from "..";\ntest("main", () => expect(main()).toBe(1));\n`,
      'tests/calc.test.ts': `${T}import { add } from "../src/calc";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
      'tests/calc2.test.ts': `${T}import { add } from "../src/calc";\ntest("add2", () => expect(add(2, 2)).toBe(4));\n`,
      'tests/calc3.test.ts': `${T}import { add } from "../src/calc";\ntest("add3", () => expect(add(3, 3)).toBe(6));\n`,
    });
    // A root index file is found through "..", not through a stem of "." that matches every file.
    expect(affectedTests(top, head, [join(top, 'index.ts')]).get('index.ts')).toEqual(['tests/main.test.ts']);
    // Emptied (no import now), renamed with a plain mv, deleted.
    write(top, 'tests/calc.test.ts', `${T}test("x", () => expect(1).toBe(1));\n`);
    renameSync(join(top, 'tests/calc2.test.ts'), join(top, 'tests/calc-two.test.ts'));
    unlinkSync(join(top, 'tests/calc3.test.ts'));
    expect(affectedTests(top, head, [join(top, 'src/calc.ts')]).get('src/calc.ts')).toEqual(['tests/calc-two.test.ts', 'tests/calc.test.ts']);
    expect(changedStartTests(top, head).get('tests/calc3.test.ts')?.now).toBeNull();
    // Staged: git's rename detection.
    git(top, 'add', '-A');
    expect(changedStartTests(top, head).get('tests/calc2.test.ts')?.now).toBe('tests/calc-two.test.ts');
    expect(affectedTests(top, head, [join(top, 'src/calc.ts')]).get('src/calc.ts')).toEqual(['tests/calc-two.test.ts', 'tests/calc.test.ts']);
  });

  test('AC-1: Python modules (a src layout too) and Go package dirs; tests added later are not existing', () => {
    const { top, head } = repo({
      'pkg/mod.py': 'def f():\n    return 1\n',
      'src/lib2/core.py': 'def g():\n    return 2\n',
      'tests/test_mod.py': 'from pkg.mod import f\n\ndef test_f():\n    assert f() == 1\n',
      'tests/test_pkg.py': 'from pkg import mod\n\ndef test_m():\n    assert mod.f() == 1\n',
      'tests/test_core.py': 'import lib2.core\n\ndef test_g():\n    assert lib2.core.g() == 2\n',
      'tests/test_none.py': '# from pkg.mod import f\ndef test_x():\n    assert True\n',
      'calc/calc.go': 'package calc\n\nfunc Add(a, b int) int { return a + b }\n',
      'calc/calc_test.go': 'package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) { if Add(1, 2) != 3 { t.Error("x") } }\n',
    });
    write(top, 'tests/test_new.py', 'from pkg.mod import f\n\ndef test_new():\n    assert f()\n');
    const got = affectedTests(top, head, [join(top, 'pkg/mod.py'), join(top, 'src/lib2/core.py'), join(top, 'calc/calc.go')]);
    expect(got.get('pkg/mod.py')).toEqual(['tests/test_mod.py', 'tests/test_pkg.py']);
    expect(got.get('src/lib2/core.py')).toEqual(['tests/test_core.py']);
    expect(got.get('calc/calc.go')).toEqual(['calc/calc_test.go']);
    expect(startTestFiles(top, head)).not.toContain('tests/test_new.py');
    // Unclosed parens in a Python test stay linear to parse.
    write(top, 'tests/test_parens.py', 'from pkg.mod import (\n'.repeat(20_000));
    git(top, 'add', 'tests/test_parens.py');
    git(top, 'commit', '-q', '-m', 'parens');
    const t0 = performance.now();
    affectedTests(top, git(top, 'rev-parse', 'HEAD'), [join(top, 'pkg/mod.py')]);
    expect(performance.now() - t0).toBeLessThan(3_000);
    // No start commit: nothing is existing.
    expect(affectedTests(top, null, [join(top, 'pkg/mod.py')]).size).toBe(0);
    // A module name with regex characters neither throws nor matches anything else.
    expect(() => affectedTests(top, head, [join(top, 'pkg/c++/mod.py')])).not.toThrow();
    // A deleted Go test is not required any more.
    unlinkSync(join(top, 'calc/calc_test.go'));
    expect(affectedTests(top, head, [join(top, 'calc/calc.go')]).has('calc/calc.go')).toBe(false);
  });

  test('AC-2: a suite ran a test when it names it, or runs the whole suite without a name filter', () => {
    expect(suiteRan('bun test', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('bun run test', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('bun test tests/a.test.ts tests/b.test.ts', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('bun test a.test.ts', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('bun test tests/b.test.ts', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('bun test -t "adds"', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('python3 -m pytest -k mod', 'tests/test_mod.py')).toBe(false);
    expect(suiteRan('go test ./...', 'calc/calc_test.go')).toBe(true);
  });

  test('AC-2: filters, node ids and other packages are partial; dirs and absolute paths are runs', () => {
    // A named file with a name filter is partial.
    expect(suiteRan('bun test tests/a.test.ts -t adds', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('npx jest --testNamePattern=adds', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('npx mocha --fgrep adds', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('pytest tests/test_mod.py::test_f', 'tests/test_mod.py')).toBe(false);
    expect(suiteRan('python3 -m pytest -m slow', 'tests/test_mod.py')).toBe(false);
    expect(suiteRan('python3 -m pytest -q', 'tests/test_mod.py')).toBe(true);
    expect(suiteRan('cargo test parse', 'tests/a_test.go')).toBe(false);
    // Another package, or the top package only.
    expect(suiteRan('go test ./other/...', 'calc/calc_test.go')).toBe(false);
    expect(suiteRan('go test ./calc/...', 'calc/calc_test.go')).toBe(true);
    expect(suiteRan('go test ./calc', 'calc/sub/x_test.go')).toBe(false);
    expect(suiteRan('go test', 'calc/calc_test.go')).toBe(false);
    // Another file whose name contains this one's.
    expect(suiteRan('bun test tests/new-calc.test.ts', 'tests/calc.test.ts')).toBe(false);
    // Whole dirs, and a path filter that is part of the path (bun, jest, vitest).
    expect(suiteRan('pytest tests/', 'tests/test_mod.py')).toBe(true);
    expect(suiteRan('bun test ./tests/', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('npx vitest run test/', 'test/a.test.ts')).toBe(true);
    expect(suiteRan('npx vitest run test/', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('bun test calc.test.ts', 'tests/calc.test.ts')).toBe(true);
    expect(suiteRan('pytest tests/unit', 'tests/integration/test_x.py')).toBe(false);
    // Absolute paths, a config value and redirects are not mistaken.
    expect(suiteRan('bun test /repo/tests/a.test.ts', 'tests/a.test.ts', '/repo')).toBe(true);
    expect(suiteRan('npx jest --config ./jest.config.js > /tmp/out.txt 2>&1', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('cd /repo && bun test', 'tests/a.test.ts')).toBe(true);
  });

  test('AC-2: only the test runs of a command count; setup steps, redirects and report dirs are not test paths', () => {
    expect(suiteRan('node scripts/setup.js && npm test', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('bun build src/index.ts --outdir dist && bun test', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('bun test &>/tmp/log', 'tests/a.test.ts')).toBe(true);
    expect(suiteRan('npx vitest run --coverage.reportsDirectory /tmp/cov', 'tests/a.test.ts', '/repo')).toBe(true);
    expect(suiteRan('npx vitest run --coverage.reportsDirectory cov', 'tests/a.test.ts', '/repo')).toBe(true);
    expect(suiteRan('sh scripts/run-tests.sh', 'tests/a.test.ts')).toBe(true);
    // Projects and dirs limit a run.
    expect(suiteRan('npx vitest run --project unit', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('npx jest --selectProjects api', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('npx vitest run --dir packages/a', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('npx vitest run --dir=packages/a', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('npx vitest run --dir tests', 'tests/a.test.ts')).toBe(true);
    // No test run at all ran nothing known.
    expect(suiteRan('', 'tests/a.test.ts')).toBe(false);
    expect(suiteRan('./build.sh', 'tests/a.test.ts')).toBe(false);
  });
});

describe('affected gaps', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  function setup() {
    const { top, head } = repo({
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'tests/calc.test.ts': `${T}import { add } from "../src/calc";\ntest("add", () => expect(add(1, 2)).toBe(3));\n`,
    });
    const newTest = write(top, 'tests/calc-new.test.ts', `${T}import { add } from "../src/calc";\ntest("neg", () => expect(add(-1, 1)).toBe(0));\n`);
    return { top, head, newTest, code: join(top, 'src/calc.ts'), old: join(top, 'tests/calc.test.ts') };
  }
  function record(testFiles: string[], command: string, over: Partial<TestResult> = {}): TestResult {
    return {
      timestamp: at(1_000),
      tested_files: [],
      category: 'fix-bug',
      test_files: testFiles,
      environment: { mode: 'local' },
      suites: [{ name: 's', command, passed: 2, failed: 0, output: '2 pass', type: 'unit', duration_ms: 5 }],
      acceptance: [],
      verdict: 'pass',
      ...over,
    } as TestResult;
  }

  test('AC-3: the existing test must be listed and run by a passing, fresh record', () => {
    const s = setup();
    const edits = [{ file: s.code, lastEditTimestamp: at(5_000) }];
    const gaps = (results: TestResult[]) => affectedGaps({ results, accepted: new Set(results), edits, top: s.top, head: s.head }).map((g) => `${g.rel}:${g.tests.join(',')}`);
    expect(gaps([record([s.newTest], 'bun test tests/calc-new.test.ts')])).toEqual(['src/calc.ts:tests/calc.test.ts']);
    expect(gaps([record([s.newTest, s.old], 'bun test')])).toEqual([]);
    expect(gaps([record([s.newTest, s.old], 'bun test tests/calc-new.test.ts tests/calc.test.ts')])).toEqual([]);
    // Listed but not run (a name filter), stale, failing, or a failed verdict: not run.
    expect(gaps([record([s.old], 'bun test -t neg')])).toHaveLength(1);
    expect(gaps([record([s.old], 'bun test', { timestamp: at(10_000) })])).toHaveLength(1);
    expect(gaps([record([s.old], 'bun test', { suites: [{ name: 's', command: 'bun test', passed: 1, failed: 1, output: '', type: 'unit', duration_ms: 5 }] })])).toHaveLength(1);
    expect(gaps([record([s.old], 'bun test', { verdict: 'fail' })])).toHaveLength(1);
    // A record outside the accepted set must stand alone.
    const r = record([s.old], 'bun test');
    expect(affectedGaps({ results: [r], accepted: new Set(), edits, top: s.top, head: s.head, standsAlone: () => false })).toHaveLength(1);
    expect(affectedGaps({ results: [r], accepted: new Set(), edits, top: s.top, head: s.head, standsAlone: () => true })).toHaveLength(0);
    expect(affectedReason([{ rel: 'src/calc.ts', tests: ['tests/calc.test.ts'] }], 'goodboy:test-unit')).toContain('src/calc.ts is loaded by tests/calc.test.ts');
  });

  test('AC-8: GOODBOY_EXISTING_TESTS is on by default', () => {
    expect(existingTestsMode({})).toBe('on');
    expect(existingTestsMode({ GOODBOY_EXISTING_TESTS: 'warn' })).toBe('warn');
    expect(existingTestsMode({ GOODBOY_EXISTING_TESTS: 'off' })).toBe('off');
  });
});

describe('weakened tests', () => {
  test('AC-4: assertions, cases and skips per language', () => {
    expect(testStrength(`${T}test("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\ntest.skip("b", () => {});\n// expect(3)\n`, '.ts')).toEqual({ assertions: 2, cases: 1, skips: 1 });
    expect(testStrength('def test_a():\n    assert 1\n    self.assertEqual(1, 1)\n\n@pytest.mark.skip\ndef test_b():\n    pass\n', '.py')).toEqual({ assertions: 2, cases: 2, skips: 1 });
    expect(testStrength('func TestA(t *testing.T) {\n\tif x { t.Errorf("x") }\n\tt.Skip("later")\n}\n', '.go')).toEqual({ assertions: 1, cases: 1, skips: 1 });
    expect(testStrength('x', '.rb')).toBeNull();
    // Focused tests skip the rest; conditional and runtime skips count.
    expect(testStrength(`${T}test.only("a", () => { expect(1).toBe(1); });\ntest("b", () => { expect(2).toBe(2); });\n`, '.ts')?.skips).toBe(1);
    expect(testStrength('@pytest.mark.skipif(True, reason="x")\ndef test_a():\n    assert 1\n\ndef test_b(self):\n    self.skipTest("later")\n', '.py')?.skips).toBe(2);
  });

  test('AC-4: counting stays linear on hostile input', () => {
    const t0 = performance.now();
    testStrength('test.each('.repeat(40_000), '.ts');
    testStrength(`${'\n'.repeat(200_000)}x`, '.py');
    testStrength(`${' \n'.repeat(100_000)}x`, '.go');
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test('AC-4: checks in a Go block comment or a Python docstring do not count', () => {
    expect(testStrength('func TestA(t *testing.T) {\n\t/* t.Errorf("x") */\n}\n', '.go')).toEqual({ assertions: 0, cases: 1, skips: 0 });
    expect(testStrength('def test_a():\n    """\n    assert 1\n    """\n    pass\n', '.py')).toEqual({ assertions: 0, cases: 1, skips: 0 });
  });

  test('AC-4: a clean filter the repo configures does not run in the hook', () => {
    const { top, head } = repo({ '.gitattributes': '*.ts filter=probe\n', 'tests/a.test.ts': `${T}test("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\n` });
    const marker = join(dirname(top), 'filter-ran');
    git(top, 'config', 'filter.probe.clean', `touch '${marker}'; cat`);
    write(top, 'tests/a.test.ts', `${T}test("a", () => { expect(1).toBe(1); });\n`);
    expect(weakenedTests(top, head).map((w) => w.rel)).toEqual(['tests/a.test.ts']);
    expect(existsSync(marker)).toBe(false);
  });

  test('AC-4: a start test with fewer checks, more skips, or deleted is weakened; a new or stronger one is not', () => {
    const { top, head } = repo({
      'tests/a.test.ts': `${T}test("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\n`,
      'tests/b.test.ts': `${T}test("b", () => { expect(1).toBe(1); });\n`,
      'tests/c.test.ts': `${T}test("c", () => { expect(1).toBe(1); });\n`,
      'tests/d.test.ts': `${T}test("d", () => { expect(1).toBe(1); });\n`,
      'tests/test_e.py': 'def test_e():\n    assert 1\n',
      'tests/g.test.ts': `${T}test("g", () => { expect(1).toBe(1); });\n`,
    });
    const g = write(top, 'tests/g.test.ts', `${T}test("g", () => { expect(1).toBe(1); });\ntest.skip("g2", () => {});\n`);
    const a = write(top, 'tests/a.test.ts', `${T}test("a", () => { expect(1).toBe(1); });\n`);
    const b = write(top, 'tests/b.test.ts', `${T}test.skip("b", () => { expect(1).toBe(1); });\n`);
    const c = join(top, 'tests/c.test.ts');
    unlinkSync(c);
    const d = write(top, 'tests/d.test.ts', `${T}test("d", () => { expect(1).toBe(1); expect(2).toBe(2); });\n`);
    const e = write(top, 'tests/test_e.py', 'def test_e():\n    pass\n');
    const f = write(top, 'tests/f.test.ts', `${T}test("f", () => {});\n`);
    void [b, d, e, f, g];
    const w = weakenedTests(top, head).map((x) => x.rel).sort();
    expect(w).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/g.test.ts', 'tests/test_e.py']);
    expect(weakenedTests(top, null)).toEqual([]);
    const weak = weakenedTests(top, head).filter((x) => x.abs[0] === a);
    expect(weakenedReason(weak, 'goodboy:review-all')).toContain('tests/a.test.ts (assertions 2 → 1)');
    expect(weakenedReason(weakenedTests(top, head).filter((x) => x.abs[0] === c), 'r')).toContain('tests/c.test.ts (deleted)');
    // Only under the given dir.
    expect(weakenedTests(top, head, join(top, 'src'))).toEqual([]);
  });

  test('AC-4: a rename is compared with its source; a rename to a non-test name or a large test fails closed', () => {
    const { top, head } = repo({
      'tests/a.test.ts': `${T}test("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\n`,
      'tests/b.test.ts': `${T}${FIXTURE}test("b", () => { expect(1).toBe(1); });\n`,
      'tests/c.test.ts': `${T}test("c", () => { expect(1).toBe(1); });\n`,
      'tests/d.test.ts': `${T}test("d", () => { expect(1).toBe(1); });\n`,
      'tests/e1.test.ts': `${T}test("e", () => { expect(1).toBe(1); });\n`,
      'tests/e2.test.ts': `${T}test("e", () => { expect(1).toBe(1); });\n`,
    });
    // A plain mv, unchanged: not weakened.
    renameSync(join(top, 'tests/a.test.ts'), join(top, 'tests/a2.test.ts'));
    // git mv, then weakened.
    git(top, 'mv', 'tests/b.test.ts', 'tests/b2.test.ts');
    write(top, 'tests/b2.test.ts', `${T}${FIXTURE}test.skip("b", () => { expect(1).toBe(1); });\n`);
    // Renamed to a name no runner picks up.
    renameSync(join(top, 'tests/c.test.ts'), join(top, 'tests/c.test.ts.bak'));
    // Too large to count.
    write(top, 'tests/d.test.ts', `${T}// ${'x'.repeat(1_100_000)}\ntest("d", () => { expect(1).toBe(1); });\n`);
    // Two deleted tests with the same content and one untracked copy: one moved, one deleted.
    renameSync(join(top, 'tests/e1.test.ts'), join(top, 'tests/e3.test.ts'));
    unlinkSync(join(top, 'tests/e2.test.ts'));
    const w = weakenedTests(top, head);
    expect(w.filter((x) => x.rel === 'tests/e1.test.ts' || x.rel === 'tests/e2.test.ts').map((x) => x.now)).toEqual([null]);
    const by = (rel: string) => w.find((x) => x.rel === rel);
    expect(by('tests/a.test.ts')).toBeUndefined();
    expect(by('tests/b.test.ts')?.now).toBe('tests/b2.test.ts');
    expect(by('tests/c.test.ts')?.now).toBeNull();
    expect(by('tests/d.test.ts')?.after).toBeNull();
    expect(weakenedReason(w, 'r')).toContain('tests/b.test.ts (renamed to tests/b2.test.ts, cases 1 → 0, skips 0 → 1)');
    expect(weakenedReason(w, 'r')).toContain('tests/d.test.ts (too large to count)');
  });

  test('AC-4: deleting a start test with no counted checks still weakens it', () => {
    const { top, head } = repo({ 'tests/table.test.ts': 'import { runTable } from "./table";\nrunTable([1, 2, 3]);\n' });
    unlinkSync(join(top, 'tests/table.test.ts'));
    expect(testStrength('import { runTable } from "./table";\nrunTable([1, 2, 3]);\n', '.ts')).toEqual({ assertions: 0, cases: 0, skips: 0 });
    expect(weakenedTests(top, head).map((w) => `${w.rel}:${w.now}`)).toEqual(['tests/table.test.ts:null']);
  });

  test('AC-5: judged-weakened.json is the Stop\'s: a Bash call that rewrote, removed or created it is undone', () => {
    const sid = `i5-guard-${Math.random().toString(36).slice(2)}`;
    const dir = ensureSessionDir(sid);
    dirs.push(dir);
    const pin = join(dir, 'judged-weakened.json');
    snapshotGateState(sid, 'toolu_i5created');
    writeFileSync(pin, JSON.stringify(['/repo/tests/a.test.ts|tests/a.test.ts|0,0,0']));
    expect(restoreGateState(sid, 'toolu_i5created')).toEqual(['judged-weakened.json']);
    expect(existsSync(pin)).toBe(false);
    writeFileSync(pin, JSON.stringify(['kept']));
    snapshotGateState(sid, 'toolu_i5rewritten');
    writeFileSync(pin, JSON.stringify(['kept', 'forged']));
    expect(restoreGateState(sid, 'toolu_i5rewritten')).toEqual(['judged-weakened.json']);
    expect(readFileSync(pin, 'utf8')).toBe(JSON.stringify(['kept']));
    snapshotGateState(sid, 'toolu_i5removed');
    rmSync(pin);
    expect(restoreGateState(sid, 'toolu_i5removed')).toEqual(['judged-weakened.json']);
    expect(readFileSync(pin, 'utf8')).toBe(JSON.stringify(['kept']));
  });

  test('AC-5: a finding from a review made after the change judges it', async () => {
    const { top, head } = repo({ 'tests/a.test.ts': `${T}test("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\n` });
    const a = write(top, 'tests/a.test.ts', `${T}test("a", () => { expect(1).toBe(1); });\n`);
    const weak = weakenedTests(top, head);
    await Bun.sleep(5);
    const review = (file: string, agoMs = 0) =>
      ({ timestamp: new Date(Date.now() - agoMs).toISOString(), findings: [{ file, issue: 'dropped the overflow check', severity: 'low' }] }) as unknown as ReviewResult;
    // A review older than the change does not judge it, nor one without a trusted timestamp.
    expect(unjudgedWeakened(weak, [review('tests/a.test.ts', 60_000)], [top])).toHaveLength(1);
    expect(unjudgedWeakened(weak, [{ ...review('tests/a.test.ts'), timestamp: '9' }], [top])).toHaveLength(1);
    expect(unjudgedWeakened(weak, [review('tests/other.test.ts')], [top])).toHaveLength(1);
    expect(unjudgedWeakened(weak, [review('tests/a.test.ts')], [top])).toHaveLength(0);
    expect(unjudgedWeakened(weak, [review('tests/a.test.ts:3')], [top])).toHaveLength(0);
    expect(unjudgedWeakened(weak, [review(a)], [top])).toHaveLength(0);
    // From a subdirectory: a path relative to the repo top judges it too.
    expect(unjudgedWeakened(weak, [review('tests/a.test.ts')], [join(top, 'pkg'), top])).toHaveLength(0);
    // A pinned state is judged; a changed state is not.
    const sid = `i5-pin-${Math.random().toString(36).slice(2)}`;
    dirs.push(ensureSessionDir(sid));
    pinJudgedWeakened(sid, weak);
    expect(unjudgedWeakened(weak, [], [top], judgedWeakened(sid))).toHaveLength(0);
    // Another content with the same counts is a new state.
    write(top, 'tests/a.test.ts', `${T}test("a", () => { expect(9).toBe(9); });\n`);
    expect(unjudgedWeakened(weakenedTests(top, head), [], [top], judgedWeakened(sid))).toHaveLength(1);
    write(top, 'tests/a.test.ts', `${T}test("a", () => {});\n`);
    expect(unjudgedWeakened(weakenedTests(top, head), [], [top], judgedWeakened(sid))).toHaveLength(1);
  });
});

describe('the Stop', () => {
  async function hook(cwd: string, base: string, sid: string, script: string, payload: Record<string, unknown>, env: Record<string, string> = {}, preload?: string) {
    const p = Bun.spawn(['bun', ...(preload ? ['--preload', preload] : []), join(ROOT, 'hooks', script)], {
      cwd,
      env: { ...process.env, TMPDIR: base, HOME: base, CLAUDE_PLUGIN_ROOT: ROOT, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_POLICY_GATE: 'off', ...env },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }
  const ACCEPTANCE = [
    { id: 'AC-1', description: 'add adds', test: 'tests/calc-new.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } },
  ];
  async function session(edit: (top: string) => string) {
    const base = tmp();
    const { top } = repo({
      'package.json': '{"scripts":{"test":"bun test"}}',
      'src/calc.ts': 'export const add = (a: number, b: number) => a + b;\n',
      'tests/calc.test.ts': `${T}import { add } from "../src/calc";\ntest("add", () => { expect(add(1, 2)).toBe(3); expect(add(0, 0)).toBe(0); });\n`,
    });
    const sid = `i5-${Math.random().toString(36).slice(2)}`;
    await hook(top, base, sid, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });
    const record = (file: string) => hook(top, base, sid, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file } });
    const file = edit(top);
    await record(file);
    const stop = (env: Record<string, string> = {}, active = false, preload?: string) =>
      hook(top, base, sid, 'stop.ts', { hook_event_name: 'Stop', ...(active ? { stop_hook_active: true } : {}) }, { GOODBOY_TEST_GATE: 'on', GOODBOY_EXISTING_TESTS: 'on', ...env }, preload);
    return { top, file, stop, record, base, sid };
  }
  const DIMS = ['hallucination', 'performance', 'refactoring-quality', 'security-secrets', 'security-authz', 'security-injection', 'error-path', 'test-quality'];
  function reviewRecord(top: string, name: string, files: string[], findingFile: string | null) {
    write(
      top,
      `.claude/reviews/${name}.json`,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        tree: workTreeState(top).tree, // as review-write stores it
        reviewed_files: files,
        category: 'fix-bug',
        findings: findingFile ? [{ file: findingFile, issue: 'the zero case was dropped on purpose: add(0, 0) is covered elsewhere', severity: 'low', probe: 'read the diff' }] : [],
        unknown_assumptions_checked: [],
        verdict: 'pass',
        dimensions_checked: DIMS,
      }),
    );
  }
  function testRecord(top: string, testFiles: string[], command: string) {
    write(
      top,
      '.claude/tests/result.json',
      JSON.stringify({
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        // As test-write stores them (v0.36.6, R4): the HEAD and the work tree the record ran on.
        ...workTreeState(top),
        tested_files: [join(top, 'src/calc.ts')],
        category: 'fix-bug',
        test_files: testFiles.map((t) => join(top, t)),
        environment: { mode: 'local' },
        suites: [{ name: 'unit', command, passed: 3, failed: 0, output: '3 pass', type: 'unit', duration_ms: 5 }],
        acceptance: ACCEPTANCE,
        verdict: 'pass',
      }),
    );
  }

  test('AC-6: layer 1 blocks until the existing test of the changed file ran; warn tells; off skips', async () => {
    const run = async (testFiles: string[], command: string, env: Record<string, string> = {}) => {
      const s = await session((top) => {
        write(top, 'tests/calc-new.test.ts', `${T}import { add } from "../src/calc";\ntest("neg", () => expect(add(-1, 1)).toBe(0));\n`);
        return write(top, 'src/calc.ts', 'export const add = (a: number, b: number): number => a + b;\n');
      });
      testRecord(s.top, testFiles, command);
      return s.stop(env);
    };
    expect(await run(['tests/calc-new.test.ts'], 'bun test tests/calc-new.test.ts')).toContain('Existing tests that cover the change did not run with it: src/calc.ts is loaded by tests/calc.test.ts');
    expect(await run(['tests/calc-new.test.ts', 'tests/calc.test.ts'], 'bun test')).not.toContain('Existing tests that cover');
    const warn = await run(['tests/calc-new.test.ts'], 'bun test tests/calc-new.test.ts', { GOODBOY_EXISTING_TESTS: 'warn' });
    expect(warn).not.toContain('Existing tests that cover');
    expect(warn).toContain('기존 테스트(경고 모드)');
    expect(await run(['tests/calc-new.test.ts'], 'bun test tests/calc-new.test.ts', { GOODBOY_EXISTING_TESTS: 'off' })).not.toContain('기존 테스트');
  }, 120_000);

  test('AC-6: an error in the existing-test rule is logged and the changed-line rule after it still runs', async () => {
    // The rule made to throw: a preload swaps affectedGaps for one that throws.
    const lib = join(ROOT, 'lib', 'existing-tests.ts');
    const pre = join(tmp(), 'throw.ts');
    writeFileSync(
      pre,
      `import { mock } from 'bun:test';\nimport * as real from ${JSON.stringify(lib)};\n` +
        `mock.module(${JSON.stringify(lib)}, () => ({ ...real, affectedGaps: () => { throw new Error('i5 boom'); } }));\n`,
    );
    const s = await session((top) => write(top, 'src/calc.ts', 'export const add = (a: number, b: number): number => a + b;\n'));
    testRecord(s.top, ['tests/calc.test.ts'], 'bun test');
    const out = await s.stop({ GOODBOY_DIFF_COVERAGE: 'on' }, false, pre);
    expect(out).toContain('(changed-line coverage)');
    expect(readFileSync(join(s.base, `goodboy-session-${s.sid}`, 'gate-log.jsonl'), 'utf8')).toContain('existing-tests error: Error: i5 boom');
  }, 120_000);

  test('AC-7: the review gate needs a finding on a weakened existing test', async () => {
    const run = async (findingFile: string | null) => {
      const s = await session((top) => write(top, 'tests/calc.test.ts', `${T}import { add } from "../src/calc";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n`));
      write(
        s.top,
        '.claude/reviews/review.json',
        JSON.stringify({
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          tree: workTreeState(s.top).tree, // as review-write stores it
          reviewed_files: [s.file],
          category: 'fix-bug',
          findings: findingFile ? [{ file: findingFile, issue: 'the zero case was dropped on purpose: add(0, 0) is covered elsewhere', severity: 'low', probe: 'read the diff' }] : [],
          unknown_assumptions_checked: [],
          verdict: 'pass',
          dimensions_checked: ['hallucination', 'performance', 'refactoring-quality', 'security-secrets', 'security-authz', 'security-injection', 'error-path', 'test-quality'],
        }),
      );
      return s.stop();
    };
    const unjudged = await run(null);
    expect(unjudged).toContain('These existing tests lost checks since the session started: tests/calc.test.ts (assertions 2 → 1)');
    const judged = await run('tests/calc.test.ts');
    expect(judged).not.toContain('lost checks');
  }, 120_000);

  test('AC-7: a test deleted by a command (no edit record) still needs a finding, and the code change does not ask for it to run', async () => {
    const s = await session((top) => {
      unlinkSync(join(top, 'tests/calc.test.ts'));
      return write(top, 'src/calc.ts', 'export const add = (a: number, b: number): number => a + b;\n');
    });
    reviewRecord(s.top, 'r1', [s.file], null);
    const out = await s.stop({ GOODBOY_TEST_GATE: 'off' });
    expect(out).toContain('tests/calc.test.ts (deleted)');
    // A review that lists only the deleted test judges it too.
    reviewRecord(s.top, 'r2', [join(s.top, 'tests/calc.test.ts')], 'tests/calc.test.ts');
    expect(await s.stop({ GOODBOY_TEST_GATE: 'off' })).not.toContain('lost checks');
    expect(existsSync(join(s.top, 'tests/calc.test.ts'))).toBe(false);
  }, 120_000);

  test('AC-7: the accept on an active Stop waits for the finding; an accepted state is not asked again', async () => {
    const s = await session((top) => write(top, 'tests/calc.test.ts', `${T}import { add } from "../src/calc";\ntest("add", () => { expect(add(1, 2)).toBe(3); });\n`));
    const env = { GOODBOY_TEST_GATE: 'off' };
    reviewRecord(s.top, 'r1', [s.file], null);
    // The active Stop does not accept, so the next full Stop still blocks.
    expect(await s.stop(env, true)).not.toContain('lost checks');
    expect(await s.stop(env)).toContain('lost checks');
    // With the finding the active Stop accepts, and the state is pinned.
    reviewRecord(s.top, 'r1', [s.file], 'tests/calc.test.ts');
    await s.stop(env, true);
    // A later change to another file, reviewed without a word on the test: not asked again.
    const other = write(s.top, 'src/other.md', '# notes\n');
    await s.record(other);
    reviewRecord(s.top, 'r2', [other], null);
    expect(await s.stop(env)).not.toContain('lost checks');
    // Weakened further: asked again; the older finding in r1 does not judge the new state.
    write(s.top, 'tests/calc.test.ts', `${T}test("add", () => {});\n`);
    await s.record(join(s.top, 'tests/calc.test.ts'));
    reviewRecord(s.top, 'r3', [join(s.top, 'tests/calc.test.ts')], null);
    expect(await s.stop(env)).toContain('lost checks');
  }, 120_000);
});
