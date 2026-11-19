// Track M, M7 (delta review D1 of the G3/G2 fixes): regression tests for the role-limit finding. The data-guard findings are in
// tests/m7-g3-fixes.test.ts.
// 1 a docs role's removal by a pattern behind `..` or a link is judged where it expands; a link made at the sandbox's data file.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bashChangedPaths, writeDenial } from '../lib/role-limits';
import { roleOf } from '../lib/routing-policy';
import { put } from './m6b-helpers';

let root = '';
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7-d1-')));
  put(join(root, 'src', 'a.ts'));
  put(join(root, 'src', 'b.ts'));
  put(join(root, 'docs', 'guide.md'));
  put(join(root, 'docs', 'api', 'x.md'));
  put(join(root, 'tests', 'a.test.ts'));
  mkdirSync(join(root, '.goodboy', 'sandbox'), { recursive: true });
  put(join(root, 'elsewhere', 'real.json'));
  symlinkSync(join(root, 'src'), join(root, 'docs', 'lnk'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What the PreToolUse hook does for a role's Bash command (hooks/pre-tool-use.ts): the first denial, or null. */
function judge(roleName: string, command: string, cwd = root): string | null {
  const role = roleOf(roleName)!;
  const removed: string[] = [];
  const expanded: string[] = [];
  const changed = bashChangedPaths(command, cwd, { removed, expanded });
  for (const f of changed) {
    const d = writeDenial(role, resolve(cwd, f), root);
    if (d) return d;
  }
  for (const f of removed) {
    const d = writeDenial(role, resolve(cwd, f), root, { removal: true });
    if (d) return d;
  }
  for (const f of expanded) {
    const d = writeDenial(role, resolve(cwd, f), root, { expanded: true });
    if (d) return d;
  }
  return null;
}

describe('item 1: a docs role removing by a pattern is judged where the pattern expands, `..` and links resolved', () => {
  test('denied: a pattern behind `..`, behind `../..`, or below a link that leads out of the docs', () => {
    for (const cmd of ['cd docs && rm ../src/*.ts', 'cd docs/api && rm -r ../../*', 'cd docs/api && rm ../../src/*.ts', 'rm docs/lnk/*.ts', 'rm -f docs/../src/*.ts', 'cd docs && rm ../*', 'rm docs/lnk/{a,b}.ts']) {
      expect([cmd, judge('build-docs', cmd)]).not.toEqual([cmd, null]);
    }
  });
  test('denied: a pattern in a cwd that is a link out of the docs (the cwd is judged as the real dir it is)', () => {
    for (const cmd of ['cd docs/lnk && rm *', 'cd docs/lnk && rm -rf ./*', 'cd docs/lnk && rm *.ts', 'cd docs/lnk && rm {a,b}.ts', 'pushd docs/lnk && rm *', 'cd docs/lnk && rm -r ../lnk/*', '(cd docs/lnk && rm *)']) {
      expect([cmd, judge('build-docs', cmd)]).not.toEqual([cmd, null]);
    }
  });
  test('allowed: a pattern that expands inside the docs', () => {
    for (const cmd of ['rm docs/*.md', 'cd docs && rm *.md', 'cd docs && rm ../docs/api/*.md', 'cd docs/api && rm ../*.md', 'rm docs/api/*.md']) {
      expect([cmd, judge('build-docs', cmd)]).toEqual([cmd, null]);
    }
  });
  test('a tests role is still denied for every pattern, `..` ones included', () => {
    for (const cmd of ['rm tests/*.ts', 'cd tests && rm ../src/*.ts', 'rm tests/../src/*.ts']) expect([cmd, judge('test-unit', cmd)]).not.toEqual([cmd, null]);
  });
});

describe('item 1: the sandbox data file of a test role cannot be a link made by a command', () => {
  const DATA = '.goodboy/sandbox/data.json';
  test('denied: ln, and a link copied or moved onto it', () => {
    symlinkSync(join(root, 'elsewhere', 'real.json'), join(root, 'a-link'));
    for (const cmd of [`ln -s elsewhere/real.json ${DATA}`, `ln elsewhere/real.json ${DATA}`, `ln -sf ../../elsewhere/real.json ${DATA}`, `cp -P a-link ${DATA}`, `mv a-link ${DATA}`]) {
      expect([cmd, judge('test-unit', cmd)]).not.toEqual([cmd, null]);
    }
  });
  test('allowed: a plain file written there, and links elsewhere', () => {
    for (const cmd of [`cp tests/a.test.ts ${DATA}`, `touch ${DATA}`, 'ln -s ../src tests/lnk', 'ln -s ../tests/a.test.ts tests/b.test.ts']) {
      expect([cmd, judge('test-unit', cmd)]).toEqual([cmd, null]);
    }
  });
  test('a write to a data.json that is a link is denied', () => {
    const role = roleOf('test-unit')!;
    symlinkSync(join(root, 'elsewhere', 'real.json'), join(root, '.goodboy', 'sandbox', 'data.json'));
    try {
      expect(writeDenial(role, join(root, DATA), root)).not.toBeNull();
    } finally {
      rmSync(join(root, DATA), { force: true });
    }
    expect(writeDenial(role, join(root, DATA), root)).toBeNull();
  });
});
