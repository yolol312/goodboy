// v0.37.2 (AC-3): the test catalog counts a JS/TS case outside comments. A header comment such as "create it (`wx`)"
// or a commented-out `// test(` is no case (tests/v0.37.1-44-race.test.ts was counted 4 instead of 3). Go and Python
// are counted as before (a line-anchored pattern).
//
// Everything runs on a throwaway git repo under the system temp dir; no hook is installed, nothing outside it is touched.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogRows } from '../lib/test-catalog';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A fresh git repo (init only) holding the given files. */
function repoWith(files: Record<string, string>): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-catalog-count-')));
  dirs.push(d);
  Bun.spawnSync(['git', 'init', '-q', d]);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), text);
  }
  return d;
}

const counts = (d: string): Record<string, number> =>
  Object.fromEntries((catalogRows(d) ?? []).map((r) => [r.file, r.tests]));

describe('the test count of the catalog', () => {
  test('a JS/TS call named in a comment is no case: only the real test( / it( calls count', () => {
    const d = repoWith({
      'tests/race.test.ts': [
        '// Two runs race to create it (`wx`); the loser must see the winner\'s file.',
        '// test( commented out: not a case',
        '/* it(\'old\', () => {}); */',
        '/**',
        ' * test(\'in a block comment\', () => {})',
        ' */',
        "describe('race', () => {",
        "  test('first', () => {});",
        "  it('second', () => {});",
        "  test.skip('third', () => {});",
        '});',
        '',
      ].join('\n'),
    });
    expect(counts(d)['tests/race.test.ts']).toBe(3);
  });

  test('without any comment the count is the same as before', () => {
    const d = repoWith({
      'tests/plain.test.ts': "describe('sums', () => { test('adds', () => {}); it('carries', () => {}); });\n",
    });
    expect(counts(d)['tests/plain.test.ts']).toBe(2);
  });

  test('Go and Python counts are unchanged', () => {
    const d = repoWith({
      'pkg_test.go': '// func TestNotACase(t *testing.T) {}\nfunc TestParse(t *testing.T) {}\nfunc TestPrint(t *testing.T) {}\n',
      'tests/test_calc.py': '# def test_comment(): pass\nclass TestCalc:\n    def test_add(self):\n        pass\n\n    def test_sub(self):\n        pass\n\ndef test_top():\n    pass\n',
    });
    const c = counts(d);
    expect(c['pkg_test.go']).toBe(2);
    expect(c['tests/test_calc.py']).toBe(3);
  });
});
