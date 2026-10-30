// v0.36.9: the push check scans only the lines a push adds for always-true test patterns, as the
// Stop gate scans only the session's added lines. Found at the v0.36.8 release: a documented
// `test.todo` already on the remote made every record that listed its file count as failing.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushedTestLines } from '../lib/push-test';
import { scanForbiddenPatterns } from '../lib/test-validator';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
}

/** A repo whose first commit (a test file with a `test.todo`) is on its remote. */
function pushedRepo(): { d: string; file: string } {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-i369-'));
  dirs.push(base);
  const remote = join(base, 'remote.git');
  const d = join(base, 'repo');
  mkdirSync(d);
  sh(base, 'init', '-q', '--bare', remote);
  sh(d, 'init', '-q');
  sh(d, 'config', 'user.email', 't@example.com');
  sh(d, 'config', 'user.name', 't');
  mkdirSync(join(d, 'tests'));
  const file = join(d, 'tests', 'a.test.ts');
  writeFileSync(file, 'test("a", () => { expect(1).toBe(1); });\ntest.todo("a known limit");\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'one #1');
  sh(d, 'remote', 'add', 'origin', remote);
  sh(d, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  sh(d, 'fetch', '-q', 'origin');
  return { d, file };
}

describe('push check: always-true patterns in the lines the push adds', () => {
  test('a pattern already on the remote does not count; one the push adds does', () => {
    const { d, file } = pushedRepo();
    writeFileSync(file, 'test("a", () => { expect(1).toBe(1); });\ntest.todo("a known limit");\ntest("b", () => { expect(2).toBe(2); });\n');
    sh(d, 'commit', '-q', '-am', 'two #1');
    const lines = pushedTestLines(d, 'HEAD');
    expect(lines).toBeDefined();
    expect([...lines!(file)!]).toEqual([3]);
    expect(scanForbiddenPatterns([file], lines)).toEqual([]);
    // Whole-file scan (no boundary known) still sees the old one.
    expect(scanForbiddenPatterns([file]).map((h) => h.key)).toEqual(['skipped-test']);

    writeFileSync(file, 'test("a", () => { expect(1).toBe(1); });\ntest.todo("a known limit");\ntest("b", () => { expect(2).toBe(2); });\ntest.skip("c", () => {});\n');
    sh(d, 'commit', '-q', '-am', 'three #1');
    expect(scanForbiddenPatterns([file], pushedTestLines(d, 'HEAD')).map((h) => [h.key, h.line])).toEqual([['skipped-test', 4]]);
  });

  test('a file the push does not change has no lines; no remote counts every line', () => {
    const { d, file } = pushedRepo();
    writeFileSync(join(d, 'other.ts'), 'export const x = 1;\n');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'other #1');
    expect([...pushedTestLines(d, 'HEAD')!(file)!]).toEqual([]);

    sh(d, 'remote', 'remove', 'origin');
    // No remote-tracking refs: no single boundary, so the scan counts whole files.
    expect(pushedTestLines(d, 'HEAD')).toBeUndefined();
  });

  // Review round 1: a quoted name, and an added line that reads like a diff header.
  test('a file name git would quote, and an added `++ b/x` line, hide nothing', () => {
    const { d } = pushedRepo();
    // An existing file changed in two hunks: the first adds a line that reads as a header.
    const f = join(d, 'tests', 'f.test.ts');
    writeFileSync(f, ['test("f", () => {});', '', '', '', '', '', '', '', 'test("g", () => {});', ''].join('\n'));
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'f #1');
    sh(d, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    sh(d, 'fetch', '-q', 'origin');
    const quoted = join(d, 'tests', 'q"u.test.ts');
    writeFileSync(quoted, 'test.skip("q", () => {});\n');
    writeFileSync(f, ['test("f", () => {});', '++ b/tests/other.ts', '', '', '', '', '', '', 'test.skip("late", () => {});', ''].join('\n'));
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'four #1');
    const lines = pushedTestLines(d, 'HEAD');
    expect(scanForbiddenPatterns([quoted], lines).map((h) => h.key)).toEqual(['skipped-test']);
    expect(scanForbiddenPatterns([f], lines).map((h) => [h.key, h.line])).toEqual([['skipped-test', 9]]);
  });

  // Review round 2: a name with a leading space, and a cwd below the top.
  test('a name with a leading space is scanned; a subdirectory cwd reads the same lines', () => {
    const { d } = pushedRepo();
    const lead = join(d, ' lead.test.ts');
    writeFileSync(lead, 'test.skip("l", () => {});\n');
    const file = join(d, 'tests', 'a.test.ts');
    writeFileSync(file, 'test("a", () => { expect(1).toBe(1); });\ntest.todo("a known limit");\ntest("b", () => {});\n');
    sh(d, 'add', '-A');
    sh(d, 'commit', '-q', '-m', 'five #1');
    expect(scanForbiddenPatterns([lead], pushedTestLines(d, 'HEAD')).map((h) => h.key)).toEqual(['skipped-test']);
    expect([...pushedTestLines(join(d, 'tests'), 'HEAD')!(file)!]).toEqual([3]);
  });

  test('a rev that looks like an option is not run as one', () => {
    const { d } = pushedRepo();
    expect(pushedTestLines(d, '--output=/tmp/x')).toBeUndefined();
  });
});
