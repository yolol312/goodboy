// lib/bash-read.ts — partial-read flag (stabilization plan A7).
//
// The re-Read gate counts only full reads. A Bash command that showed only part of a file
// (head, tail, sed -n) must be recorded as partial, otherwise a later full Read of that
// file is denied as "already read" although the agent never saw most of it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyBashRead, classifyBashReadDetailed } from '../lib/bash-read';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function newProject(files: string[] = ['src/a.ts', 'src/b.ts']): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-brp-'));
  tmpDirs.push(cwd);
  for (const f of files) {
    const abs = resolve(cwd, f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, 'line1\nline2\nline3\nline4\nline5\n', 'utf8');
  }
  return cwd;
}

const partialFlags = (command: string, cwd: string): boolean[] =>
  classifyBashReadDetailed(command, cwd).map((r) => r.partial);

describe('classifyBashReadDetailed — partial flag (A7)', () => {
  test('head and tail are partial reads', () => {
    const cwd = newProject();
    expect(partialFlags('head -n 3 src/a.ts', cwd)).toEqual([true]);
    expect(partialFlags('tail -5 src/a.ts', cwd)).toEqual([true]);
  });

  test('sed -n with a line range is a partial read', () => {
    const cwd = newProject();
    expect(partialFlags("sed -n '1,2p' src/a.ts", cwd)).toEqual([true]);
  });

  test('cat is a full read', () => {
    const cwd = newProject();
    expect(partialFlags('cat src/a.ts', cwd)).toEqual([false]);
  });

  test('a file shown both partially and fully in one command counts as full, in either order', () => {
    const cwd = newProject();
    expect(partialFlags('cat src/a.ts; head -n 2 src/a.ts', cwd)).toEqual([false]);
    expect(partialFlags('head -n 2 src/a.ts; cat src/a.ts', cwd)).toEqual([false]);
    expect(partialFlags("sed -n '1p' src/a.ts && cat src/a.ts", cwd)).toEqual([false]);
  });

  test('each file keeps its own flag; classifyBashRead returns the same paths', () => {
    const cwd = newProject();
    const command = 'head -n 1 src/a.ts && cat src/b.ts';
    const detailed = classifyBashReadDetailed(command, cwd);
    expect(detailed).toEqual([
      { path: resolve(cwd, 'src/a.ts'), partial: true },
      { path: resolve(cwd, 'src/b.ts'), partial: false },
    ]);
    expect(classifyBashRead(command, cwd)).toEqual(detailed.map((r) => r.path));
  });

  test('empty or non-string input yields no records (fail-open)', () => {
    const cwd = newProject();
    expect(classifyBashReadDetailed('', cwd)).toEqual([]);
    expect(classifyBashReadDetailed(undefined as unknown as string, cwd)).toEqual([]);
  });
});
