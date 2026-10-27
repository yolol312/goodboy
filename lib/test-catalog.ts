// The test catalog (track H §14.5): `.goodboy/test-catalog.md`, feature → test type, generated
// from the project's test files by `cli.ts test-catalog`. It is machine-written, so whether it
// is current is decided by evidence: the docs rule regenerates it and compares
// (lib/doc-map.ts), and the output carries no date so that regenerating changes nothing.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gitOut } from './git-run';
import { JVM_TEST_SOURCE_SET, stripLiteralsAndComments } from './test-validator';
import type { TestType } from './types';

export const TEST_CATALOG_FILE = join('.goodboy', 'test-catalog.md');

const SCRIPT_TEST = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.go|(?:^|\/)test_[^/]*\.py|_test\.py)$/;
/** Java and Kotlin classes named as surefire and failsafe find them (`*Test`, `*Tests`,
 *  `*TestCase`, `*IT`, `*ITCase`) or as Kotest specs (`*Spec.kt`); `IT` only after a lower
 *  case letter or a digit (`LIMIT.java` is none, `HTTPTest.java` is one). Surefire's `Test*`
 *  is left out: in a test source set it names helpers (`TestUtils`, `TestConfig`) far more
 *  often. */
const JVM_TEST_NAME = /^\w*(?:Test|Tests|TestCase)\.(?:java|kt)$|^\w*[a-z0-9](?:IT|ITCase)\.(?:java|kt)$|^\w*Spec\.kt$/;

/** A JVM test: a test class name in a test source set or a `test`/`tests` dir (track L, L2: a
 *  JVM project's tests were invisible to the catalog and the I5 rules). A production class
 *  named like a test in another source set (`src/commonMain/…/PodSpec.kt`) is none. */
export function isJvmTest(rel: string): boolean {
  const segs = rel.split('/');
  if (!JVM_TEST_NAME.test(segs[segs.length - 1]!)) return false;
  return segs.slice(0, -1).some((d) => d === 'test' || d === 'tests') || JVM_TEST_SOURCE_SET.test(rel);
}

/** Test files by name: `*.test.*` / `*.spec.*` (JS, TS), `*_test.go`, `test_*.py` / `*_test.py`,
 *  and JVM tests (isJvmTest). */
export const TEST_FILE = { test: (rel: string): boolean => SCRIPT_TEST.test(rel) || isJvmTest(rel) };
const JVM_TEST = /\.(?:java|kt)$/;
/** A JUnit case: `@Test` and the other annotations that make one, also by their full name (not
 *  `@TestConfiguration`). */
export const JVM_CASE = /@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/g;
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
  if (JVM_TEST.test(rel)) {
    // A browser driver makes e2e; a failsafe name, a Spring context or slice, a container or
    //   an HTTP client against the app makes integration.
    // `[ \t]`, not `\s`: with `m`, `\s*` rescans blank lines from each line start (quadratic).
    if (/^[ \t]*import[ \t]+(?:com\.microsoft\.playwright|org\.openqa\.selenium|com\.codeborne\.selenide)\b/m.test(text)) return 'e2e';
    if (/(?:IT|ITCase)\.(?:java|kt)$/.test(rel)) return 'integration';
    if (/@(?:SpringBootTest|WebMvcTest|WebFluxTest|DataJpaTest|JdbcTest|DataJdbcTest|MybatisTest|Testcontainers)\b|\b(?:MockMvc|WebTestClient|TestRestTemplate|RestAssured)\b/.test(text)) return 'integration';
    return 'unit';
  }
  if (/\.(?:tsx|jsx|vue|svelte)$|\.(?:test|spec)\.[cm]?[jt]sx$/.test(rel) || /from ['"]@testing-library\//.test(text)) return 'ui';
  return 'unit';
}

/** The project's test files as git sees them (tracked and untracked, not ignored), or null when
 *  git cannot list them (no repo, no git, a timeout): that is not "no tests" (H4 review). */
function testFiles(root: string): string[] | null {
  const out = gitOut(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 10_000 });
  if (out === null) return null;
  return [...new Set(out.split('\0'))].filter((f) => f !== '' && TEST_FILE.test(f)).sort();
}

function featuresOf(rel: string, text: string): string[] {
  const names = rel.endsWith('.go')
    ? [...text.matchAll(/^func (Test\w+)\(/gm)].map((m) => m[1]!)
    : rel.endsWith('.py')
      ? [...text.matchAll(/^(?:class (Test\w+)|def (test_\w+))/gm)].map((m) => (m[1] ?? m[2])!)
      : JVM_TEST.test(rel)
        ? [...text.matchAll(/@DisplayName\(\s*"([^"\n]+)"\s*\)/g)].map((m) => m[1]!)
        : [...text.matchAll(/\bdescribe(?:\.\w+)?\(\s*(['"`])((?:(?!\1).)+)\1/g)].map((m) => m[2]!);
  const unique = [...new Set(names.map((n) => n.replace(/\|/g, '/').trim()).filter(Boolean))];
  if (unique.length === 0) return [rel.split('/').pop()!.replace(/\.[^.]+$/, '')];
  return unique.slice(0, MAX_FEATURES);
}

function testCount(rel: string, text: string): number {
  // Linear patterns only: this runs inside the Stop hook (an `each\([^)]*\)` rescan of an
  //   unclosed `test.each(` took 11.7 s on a 360 KB file, H4 review).
  const re = rel.endsWith('.go')
    ? /^func Test\w+\(/gm
    : rel.endsWith('.py')
      ? /^[ \t]*def test_\w+/gm
      : JVM_TEST.test(rel)
        ? JVM_CASE
        : /(?<![.\w$])(?:test|it)(?:\.(?:only|skip|todo|each))*\s*\(/gm;
  // A JVM case is an annotation: one in a comment or a string is none.
  if (JVM_TEST.test(rel)) return [...stripLiteralsAndComments(text, true).matchAll(re)].length;
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
