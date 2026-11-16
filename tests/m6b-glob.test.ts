// Track M, M6b (plan §19), round 3: the glob matcher of the PreToolUse rule (lib/sandbox-data-guard.ts `globMatches`) against
// the results of bash 5.3.12 with `shopt -s globstar`. The table was made by expanding each pattern in a fixture tree
// (the files below) and keeping the files it named; it is a table so that no shell has to run in the test. The matcher
// once went back to its last star only and under-matched a dump two dirs below the prefix (`**/*.sql`).

import { describe, expect, test } from 'bun:test';
import { globMatches } from '../lib/sandbox-data-guard';

const ROOT = '/r';
const FILES = [
  'a.sql',
  'top.log',
  'd1/a.sql',
  'd1/d2/dump.sql',
  'd1/d2/note.txt',
  'd1/d2/d3/x.log',
  'd1/d2/d3/dump.sql',
  'd1/x/b.sql',
  'e/e.sql',
];

/** [pattern, the files of FILES that bash expands it to]. */
const TABLE: [string, string[]][] = [
  ['**/*', ['a.sql', 'd1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/d3/x.log', 'd1/d2/dump.sql', 'd1/d2/note.txt', 'd1/x/b.sql', 'e/e.sql', 'top.log']],
  ['**/*.sql', ['a.sql', 'd1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/dump.sql', 'd1/x/b.sql', 'e/e.sql']],
  ['**/dump.sql', ['d1/d2/d3/dump.sql', 'd1/d2/dump.sql']],
  ['**/d2/*', ['d1/d2/dump.sql', 'd1/d2/note.txt']],
  ['**/d2/**/*', ['d1/d2/d3/dump.sql', 'd1/d2/d3/x.log', 'd1/d2/dump.sql', 'd1/d2/note.txt']],
  ['d1/**/*.sql', ['d1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/dump.sql', 'd1/x/b.sql']],
  ['d1/**', ['d1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/d3/x.log', 'd1/d2/dump.sql', 'd1/d2/note.txt', 'd1/x/b.sql']],
  ['**/d*/*.sql', ['d1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/dump.sql']],
  ['**/*/dump.sql', ['d1/d2/d3/dump.sql', 'd1/d2/dump.sql']],
  ['*/*.sql', ['d1/a.sql', 'e/e.sql']],
  ['*/**/*.log', ['d1/d2/d3/x.log']],
  ['d1/*/*', ['d1/d2/dump.sql', 'd1/d2/note.txt', 'd1/x/b.sql']],
  ['**/x.log', ['d1/d2/d3/x.log']],
  ['**/*.{sql,log}', ['a.sql', 'd1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/d3/x.log', 'd1/d2/dump.sql', 'd1/x/b.sql', 'e/e.sql', 'top.log']],
  ['d1/**/d3/*', ['d1/d2/d3/dump.sql', 'd1/d2/d3/x.log']],
  ['**/[a-d]*.sql', ['a.sql', 'd1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/dump.sql', 'd1/x/b.sql']],
  ['**/?/*', ['d1/x/b.sql', 'e/e.sql']],
  ['**/**/*.sql', ['a.sql', 'd1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/dump.sql', 'd1/x/b.sql', 'e/e.sql']],
  ['d1/**/**/*', ['d1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/d3/x.log', 'd1/d2/dump.sql', 'd1/d2/note.txt', 'd1/x/b.sql']],
  ['**/d1/**/*', ['d1/a.sql', 'd1/d2/d3/dump.sql', 'd1/d2/d3/x.log', 'd1/d2/dump.sql', 'd1/d2/note.txt', 'd1/x/b.sql']],
  ['d1/d2/**/*.sql', ['d1/d2/d3/dump.sql', 'd1/d2/dump.sql']],
  ['**/d3/**', ['d1/d2/d3/dump.sql', 'd1/d2/d3/x.log']],
  ['**/*.txt', ['d1/d2/note.txt']],
  ['*', ['a.sql', 'top.log']],
  ['*.sql', ['a.sql']],
  ['d1/*', ['d1/a.sql']],
  ['d1/*/*.sql', ['d1/d2/dump.sql', 'd1/x/b.sql']],
  ['**/e*.sql', ['e/e.sql']],
  ['e/**/*', ['e/e.sql']],
  ['**/d?/dump.sql', ['d1/d2/d3/dump.sql', 'd1/d2/dump.sql']],
  ['**/[!a]*.sql', ['d1/d2/d3/dump.sql', 'd1/d2/dump.sql', 'd1/x/b.sql', 'e/e.sql']],
  ['d1/**/*/*.sql', ['d1/d2/d3/dump.sql', 'd1/d2/dump.sql', 'd1/x/b.sql']],
  ['**/*dump*', ['d1/d2/d3/dump.sql', 'd1/d2/dump.sql']],
  ['**/d2/**/d3/*', ['d1/d2/d3/dump.sql', 'd1/d2/d3/x.log']],
  ['d1/**/x/*', ['d1/x/b.sql']],
];

describe('the glob matcher agrees with bash on the forms of `**`', () => {
  test('every pattern of the table matches exactly the files bash expands it to', () => {
    const wrong: string[] = [];
    for (const [pattern, expected] of TABLE) {
      for (const f of FILES) {
        const got = globMatches(`${ROOT}/${pattern}`, `${ROOT}/${f}`);
        if (got !== expected.includes(f)) wrong.push(`${pattern} vs ${f}: got ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test('a dump two or more dirs below the prefix is matched by the recursive forms (the under-match of round 3)', () => {
    const deep = '/home/u/deep/2026/11/dump.sql';
    for (const g of ['/home/u/deep/**/*', '/home/u/deep/**/*.sql', '/home/u/deep/**/**/*', '/home/u/deep/**/2026/*/*.sql', '/home/u/deep/**/11/*', '/home/u/**/*.{sql,csv}', '/home/u/deep/**']) {
      expect([g, globMatches(g, deep)]).toEqual([g, true]);
    }
    for (const g of ['/home/u/deep/**/*.csv', '/home/u/deep/*/*.sql', '/home/u/other/**/*', '/home/u/deep/**/12/*']) expect([g, globMatches(g, deep)]).toEqual([g, false]);
  });

  test('where zsh reads `**` as `*` the matcher still crosses a `/`: it fails closed (a dump is never missed for it)', () => {
    expect(globMatches('/r/d1/**', '/r/d1/d2/dump.sql')).toBe(true);
    expect(globMatches('/r/d1/a**b', '/r/d1/axx/yyb')).toBe(true);
  });

  test('a long pattern and a long path cost one pass over the text, not a search (no exponential time)', () => {
    const t0 = performance.now();
    expect(globMatches(`/r/${'*/'.repeat(30)}x`, `/r/${'a/'.repeat(60)}y`)).toBe(false);
    expect(globMatches(`/r/${'**/a'.repeat(5)}z`, `/r/${'a/'.repeat(200)}y`)).toBe(false);
    expect(globMatches(`/r/${'**/*'.repeat(25)}z`, `/r/${'ab/'.repeat(100)}y`)).toBeNull(); // 2^25 forms of `**/`: past the bound, unread
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
