// The test catalog (track H §14.5): `.goodboy/test-catalog.md`, feature → test type, generated
// from the project's test files by `cli.ts test-catalog`. It is machine-written, so whether it
// is current is decided by evidence: the docs rule regenerates it and compares
// (lib/doc-map.ts), and the output carries no date so that regenerating changes nothing.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_GIT_ARGS, HOOK_GIT_ENV } from './hook-git';
import type { TestType } from './types';

export const TEST_CATALOG_FILE = join('.goodboy', 'test-catalog.md');

/** Test files by name: `*.test.*` / `*.spec.*` (JS, TS), `*_test.go`, `test_*.py` / `*_test.py`. */
export const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go|(?:^|\/)test_[^/]*\.py|_test\.py)$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FEATURES = 6;

export interface CatalogRow {
  file: string;
  type: TestType;
  features: string[];
  tests: number;
}

/** The type a test file most likely is, from its path and imports. */
export function testTypeOf(rel: string, text: string): TestType {
  if (/(?:^|\/)e2e\/|\.e2e\./.test(rel) || /from ['"](?:@playwright\/test|cypress)['"]/.test(text)) return 'e2e';
  if (/(?:^|\/)integration\/|\.(?:int|integration)\./.test(rel)) return 'integration';
  if (/\.(?:tsx|jsx|vue|svelte)$|\.(?:test|spec)\.[cm]?[jt]sx$/.test(rel) || /from ['"]@testing-library\//.test(text)) return 'ui';
  return 'unit';
}

/** The project's test files as git sees them (tracked and untracked, not ignored), or null when
 *  git cannot list them (no repo, no git, a timeout): that is not "no tests" (H4 review). */
function testFiles(root: string): string[] | null {
  const r = Bun.spawnSync(['git', ...HOOK_GIT_ARGS, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    env: { ...process.env, ...HOOK_GIT_ENV },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  if (r.exitCode !== 0) return null;
  return [...new Set(r.stdout.toString().split('\0'))].filter((f) => f !== '' && TEST_FILE.test(f)).sort();
}

function featuresOf(rel: string, text: string): string[] {
  const names = rel.endsWith('.go')
    ? [...text.matchAll(/^func (Test\w+)\(/gm)].map((m) => m[1]!)
    : rel.endsWith('.py')
      ? [...text.matchAll(/^(?:class (Test\w+)|def (test_\w+))/gm)].map((m) => (m[1] ?? m[2])!)
      : [...text.matchAll(/\bdescribe(?:\.\w+)?\(\s*(['"`])((?:(?!\1).)+)\1/g)].map((m) => m[2]!);
  const unique = [...new Set(names.map((n) => n.replace(/\|/g, '/').trim()).filter(Boolean))];
  if (unique.length === 0) return [rel.split('/').pop()!.replace(/\.[^.]+$/, '')];
  return unique.slice(0, MAX_FEATURES);
}

function testCount(rel: string, text: string): number {
  // Linear patterns only: this runs inside the Stop hook (an `each\([^)]*\)` rescan of an
  //   unclosed `test.each(` took 11.7 s on a 360 KB file, H4 review).
  const re = rel.endsWith('.go') ? /^func Test\w+\(/gm : rel.endsWith('.py') ? /^[ \t]*def test_\w+/gm : /(?<![.\w$])(?:test|it)(?:\.(?:only|skip|todo|each))*\s*\(/gm;
  return [...text.matchAll(re)].length;
}

/** The catalog's rows, or null when git cannot list the test files. */
export function catalogRows(root: string): CatalogRow[] | null {
  const files = testFiles(root);
  if (files === null) return null;
  const rows: CatalogRow[] = [];
  for (const file of files) {
    let text = '';
    try {
      const abs = join(root, file);
      if (!statSync(abs).isFile() || statSync(abs).size > MAX_FILE_BYTES) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // listed but gone (deleted, not staged)
    }
    rows.push({ file, type: testTypeOf(file, text), features: featuresOf(file, text), tests: testCount(file, text) });
  }
  return rows;
}

export function renderCatalog(rows: CatalogRow[]): string {
  const totals = new Map<TestType, { files: number; tests: number }>();
  for (const r of rows) {
    const t = totals.get(r.type) ?? { files: 0, tests: 0 };
    totals.set(r.type, { files: t.files + 1, tests: t.tests + r.tests });
  }
  return [
    '# Test catalog',
    '',
    'Feature → test type, generated from the test files by goodboy (`cli.ts test-catalog`).',
    'Regenerate it instead of editing it; the docs rule compares it with a fresh copy.',
    '',
    `Totals: ${[...totals].map(([type, t]) => `${type} ${t.files} files, ${t.tests} tests`).join('; ') || 'no test files'}.`,
    '',
    '| Feature | Type | File | Tests |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.features.join('; ')} | ${r.type} | ${r.file} | ${r.tests} |`),
    '',
  ].join('\n');
}

/** True when the catalog file matches a fresh one; false when it differs, is missing or cannot
 *  be read. When git cannot list the test files nothing can be compared, so it fails open
 *  (true), as the read gate does for a file it cannot read. */
export function catalogIsCurrent(root: string): boolean {
  const rows = catalogRows(root);
  if (rows === null) return true;
  try {
    return readFileSync(join(root, TEST_CATALOG_FILE), 'utf8') === renderCatalog(rows);
  } catch {
    return false;
  }
}
