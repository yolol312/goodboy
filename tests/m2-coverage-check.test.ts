// Track M, M2 (§19): the coverage gate. Every non-UI code file of a project reaches 100% lines and
// branches in the merged JaCoCo, lcov and Cobertura reports, minus the user's coverage-exempt
// entries; a malformed report is an error, never a pass.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdCoverageCheck, coverageCheck } from '../lib/coverage-check';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m2-')));
  tmpDirs.push(root);
  const r = Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  if (r.exitCode !== 0) throw new Error('git init failed');
  put(root, files);
  return root;
}

function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const TS = (name: string) => `export function ${name}(x: number) {\n  if (x > 1) return x;\n  return -x;\n}\n`;
const JAVA = (pkg: string, cls: string) => `package ${pkg};\n\npublic class ${cls} {\n  public int run(int x) {\n    return x > 1 ? x : -x;\n  }\n}\n`;

/** An lcov record: `lines` as [nr, hits], `branches` as [nr, block, branch, taken]. */
function lcov(sf: string, lines: [number, number][], branches: [number, number, number, number | '-'][] = []): string {
  return [
    'TN:',
    `SF:${sf}`,
    ...lines.map(([n, h]) => `DA:${n},${h}`),
    ...branches.map(([n, b, k, t]) => `BRDA:${n},${b},${k},${t}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, h]) => h > 0).length}`,
    'end_of_record',
    '',
  ].join('\n');
}

/** JaCoCo: lines as [nr, mi, ci, mb, cb]. */
function jacoco(pkgs: { name: string; files: { name: string; lines: [number, number, number, number, number][] }[] }[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd">',
    '<report name="app">',
    '<sessioninfo id="x" start="1" dump="2"/>',
    ...pkgs.map(
      (p) =>
        `<package name="${p.name}">` +
        p.files.map((f) => `<class name="${p.name}/${f.name}"><method name="m" desc="()V" line="1"><counter type="LINE" missed="0" covered="1"/></method></class><sourcefile name="${f.name}">${f.lines.map(([n, mi, ci, mb, cb]) => `<line nr="${n}" mi="${mi}" ci="${ci}" mb="${mb}" cb="${cb}"/>`).join('')}<counter type="LINE" missed="0" covered="1"/></sourcefile>`).join('') +
        '</package>',
    ),
    '<counter type="LINE" missed="0" covered="1"/>',
    '</report>',
  ].join('\n');
}

/** Cobertura: classes with a filename and lines as [number, hits, 'covered/total' branches?]. */
function cobertura(sources: string[], classes: { filename: string; lines: [number, number, string?][] }[]): string {
  return [
    '<?xml version="1.0" ?>',
    '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">',
    '<coverage version="7" lines-valid="1" lines-covered="1">',
    `<sources>${sources.map((s) => `<source>${s}</source>`).join('')}</sources>`,
    '<packages><package name="p"><classes>',
    ...classes.map(
      (c) =>
        `<class name="c" filename="${c.filename}"><methods><method name="m" signature="()"><lines><line number="${c.lines[0]?.[0] ?? 1}" hits="1"/></lines></method></methods><lines>` +
        c.lines
          .map(([n, h, br]) => (br ? `<line number="${n}" hits="${h}" branch="true" condition-coverage="50% (${br})"/>` : `<line number="${n}" hits="${h}"/>`))
          .join('') +
        '</lines></class>',
    ),
    '</classes></package></packages></coverage>',
  ].join('\n');
}

const policy = (globs: string) => ['## P1 Unreachable code', '- decide: human', '- source: user 2026-10-22', `- coverage-exempt: ${globs}`, ''].join('\n');

function check(root: string, reports: Record<string, string>, rootMap?: Array<[string, string]>) {
  const paths: string[] = [];
  for (const [name, text] of Object.entries(reports)) {
    writeFileSync(join(root, '.reports-' + name), text);
    paths.push(join(root, '.reports-' + name));
  }
  return coverageCheck(root, paths, { rootMap });
}

describe('coverageCheck: one report passes', () => {
  test('lcov at 100% lines and branches passes', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), 'src/util.ts': TS('util') });
    const out = check(root, {
      lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]], [[2, 0, 0, 1], [2, 0, 1, 2]]) + lcov('src/util.ts', [[1, 3], [2, 3], [3, 1]]),
    });
    expect(out).toMatchObject({ ok: true, required: 2, full: 2, gaps: [], problems: [], stale_exemptions: [] });
    expect(out.totals).toEqual({ lines: { covered: 6, total: 6 }, branches: { covered: 2, total: 2 } });
  });

  test('JaCoCo at 100% passes, a line run only partly counts as run', () => {
    const root = repo({ 'src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo') });
    const out = check(root, { jacoco: jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: [[4, 0, 2, 0, 0], [5, 1, 5, 0, 2]] }] }]) });
    expect(out).toMatchObject({ ok: true, required: 1, full: 1 });
    expect(out.totals).toEqual({ lines: { covered: 2, total: 2 }, branches: { covered: 2, total: 2 } });
  });

  test('Cobertura at 100% passes with a source dir', () => {
    const root = repo({ 'pkg/mod.py': 'def f(x):\n    if x:\n        return 1\n    return 2\n' });
    const out = check(root, { cob: cobertura([root], [{ filename: 'pkg/mod.py', lines: [[1, 1], [2, 1], [3, 1], [4, 1]] }]) });
    expect(out).toMatchObject({ ok: true, required: 1, full: 1, problems: [] });
    expect(out.totals.lines).toEqual({ covered: 4, total: 4 });
  });

  test('a Cobertura file name relative to the root works without a source', () => {
    const root = repo({ 'pkg/mod.py': 'def f(x):\n    return x\n' });
    const out = check(root, { cob: cobertura([], [{ filename: 'pkg/mod.py', lines: [[1, 1], [2, 1]] }]) });
    expect(out).toMatchObject({ ok: true, required: 1, full: 1 });
  });
});

describe('coverageCheck: gaps', () => {
  test('a missed line is a gap with its number', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 0], [3, 0]]) });
    expect(out.ok).toBe(false);
    expect(out.gaps).toEqual([{ rel: 'src/calc.ts', lines_missed: [2, 3], branches_missed: [], missing_from_report: false }]);
    expect(out).toMatchObject({ required: 1, full: 0 });
    expect(out.totals.lines).toEqual({ covered: 1, total: 3 });
  });

  test('a missed branch on a run line is a gap, a `-` branch counts as not taken', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]], [[2, 0, 0, 4], [2, 0, 1, 0], [3, 1, 0, '-']]) });
    expect(out.ok).toBe(false);
    expect(out.gaps[0]).toMatchObject({ lines_missed: [], branches_missed: [{ line: 2, missed: 1, total: 2 }, { line: 3, missed: 1, total: 1 }] });
    expect(out.totals.branches).toEqual({ covered: 1, total: 3 });
  });

  test('a Cobertura branch condition-coverage is read', () => {
    const root = repo({ 'pkg/mod.py': 'def f(x):\n    if x:\n        return 1\n' });
    const out = check(root, { cob: cobertura([], [{ filename: 'pkg/mod.py', lines: [[1, 1], [2, 1, '1/2'], [3, 1]] }]) });
    expect(out.gaps[0]!.branches_missed).toEqual([{ line: 2, missed: 1, total: 2 }]);
  });

  test('a required file that no report has counts as 0%', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), 'src/util.ts': TS('util') });
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]]) });
    expect(out.ok).toBe(false);
    expect(out.gaps).toEqual([{ rel: 'src/util.ts', lines_missed: [], branches_missed: [], missing_from_report: true }]);
    expect(out).toMatchObject({ required: 2, full: 1 });
  });
});

describe('coverageCheck: merging reports', () => {
  test('two lcov runs that cover different lines and branches reach 100% together', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    const out = check(root, {
      unit: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 0]], [[2, 0, 0, 1], [2, 0, 1, 0]]),
      e2e: lcov('src/calc.ts', [[1, 0], [2, 1], [3, 1]], [[2, 0, 0, 0], [2, 0, 1, 1]]),
    });
    expect(out).toMatchObject({ ok: true, gaps: [] });
    expect(out.totals).toEqual({ lines: { covered: 3, total: 3 }, branches: { covered: 2, total: 2 } });
  });

  test('lcov union is by branch id: the same branch taken twice does not make another one taken', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    const out = check(root, {
      a: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]], [[2, 0, 0, 5], [2, 0, 1, 0]]),
      b: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]], [[2, 0, 0, 7], [2, 0, 1, 0]]),
    });
    expect(out.gaps[0]!.branches_missed).toEqual([{ line: 2, missed: 1, total: 2 }]);
  });

  test('JaCoCo reports merge by the larger covered count of the same total', () => {
    const root = repo({ 'src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo') });
    const lines = (cb: number): [number, number, number, number, number][] => [[4, 0, 1, 0, 0], [5, 0, 1, 2 - cb, cb]];
    const pkg = (cb: number) => jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: lines(cb) }] }]);
    expect(check(repo({ 'src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo') }), { a: pkg(1), b: pkg(1) }).gaps[0]!.branches_missed).toEqual([{ line: 5, missed: 1, total: 2 }]);
    expect(check(root, { a: pkg(1), b: pkg(2) })).toMatchObject({ ok: true });
  });

  test('JaCoCo reports with different branch totals never overstate: the larger total wins', () => {
    const root = repo({ 'src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo') });
    const a = jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: [[5, 0, 1, 0, 2]] }] }]); // 2 of 2
    const b = jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: [[5, 0, 1, 3, 1]] }] }]); // 1 of 4
    const out = check(root, { a, b });
    expect(out.ok).toBe(false);
    expect(out.gaps[0]!.branches_missed).toEqual([{ line: 5, missed: 3, total: 4 }]);
  });

  test('a line run in one report is run, whatever the others say; formats merge', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    const out = check(root, {
      lcov: lcov('src/calc.ts', [[1, 1], [2, 0], [3, 0]]),
      cob: cobertura([root], [{ filename: 'src/calc.ts', lines: [[1, 0], [2, 1], [3, 1]] }]),
    });
    expect(out).toMatchObject({ ok: true, gaps: [] });
  });
});

describe('coverageCheck: which files are required', () => {
  test('tests, configs, UI files and a code-free Java interface are not required', () => {
    const root = repo({
      'src/calc.ts': TS('calc'),
      'src/calc.test.ts': TS('t'),
      'vite.config.ts': 'export default { plugins: [] };\n',
      'src/App.tsx': 'export const App = () => null;\nexport const x = 1;\n',
      'src/ui/Widget.vue': '<template><p/></template>\n<script>\nexport default { name: "w" };\n</script>\n',
      'web/page.html': '<html></html>\n',
      'src/main/java/com/acme/Api.java': 'package com.acme;\n\npublic interface Api {\n  int run(int x);\n}\n',
      'src/test/java/com/acme/FooTest.java': JAVA('com.acme', 'FooTest'),
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      'types.d.ts': 'export type A = 1;\n',
    });
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]]) });
    expect(out).toMatchObject({ ok: true, required: 1, full: 1 });
  });

  test('server code under a client dir stays required: only web files count as UI', () => {
    const root = repo({ 'src/main/java/com/acme/client/Remote.java': JAVA('com.acme.client', 'Remote'), 'src/web/client/view.ts': 'export const f = () => 1;\n' });
    const out = check(root, { lcov: lcov('src/main/java/com/acme/client/Remote.java', [[5, 1]]) });
    expect(out).toMatchObject({ ok: true, required: 1 });
  });

  test('a file that is not a regular file of the project (a link) is not required', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    require('node:fs').symlinkSync(join(root, 'src/calc.ts'), join(root, 'src/alias.ts'));
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]]) });
    expect(out).toMatchObject({ ok: true, required: 1 });
  });
});

describe('coverageCheck: exemptions', () => {
  test('a whole-file glob exempts the file and is listed as used', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), 'src/legacy/old.ts': TS('old'), '.goodboy/policy.md': policy('src/legacy/**') });
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]]) });
    expect(out).toMatchObject({ ok: true, required: 1, exempt_used: [{ entry: 'src/legacy/**', files: ['src/legacy/old.ts'] }], stale_exemptions: [] });
  });

  test('a #L range exempts those lines and their branches only', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), '.goodboy/policy.md': policy('src/calc.ts#L2-L3') });
    const report = lcov('src/calc.ts', [[1, 1], [2, 0], [3, 0], [4, 0]], [[2, 0, 0, 0], [2, 0, 1, 1]]);
    const out = check(root, { lcov: report });
    expect(out.ok).toBe(false);
    expect(out.gaps[0]).toMatchObject({ lines_missed: [4], branches_missed: [] });
    expect(out.exempt_used).toEqual([{ entry: 'src/calc.ts#L2-L3', files: ['src/calc.ts'] }]);
    // The lines the range covers leave the totals; a single line, `#L4`, works too.
    expect(out.totals.lines).toEqual({ covered: 1, total: 2 });
    writeFileSync(join(root, '.goodboy/policy.md'), policy('src/calc.ts#L2-L3, src/calc.ts#L4'));
    expect(check(root, { lcov: report })).toMatchObject({ ok: true, stale_exemptions: [] });
  });

  test('an entry without a range still exempts the whole file next to ranged ones', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), 'src/util.ts': TS('util'), '.goodboy/policy.md': policy('src/util.ts, src/calc.ts#L3') });
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 0]]) });
    expect(out).toMatchObject({ ok: true, required: 1 });
    expect(out.exempt_used.map((u) => u.entry)).toEqual(['src/calc.ts#L3', 'src/util.ts']);
  });

  test('an exemption that matches nothing is stale, and so is a range over covered code', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), '.goodboy/policy.md': policy('src/gone/**, src/calc.ts#L2-L3') });
    const out = check(root, { lcov: lcov('src/calc.ts', [[1, 1], [2, 1], [3, 1]]) });
    expect(out.ok).toBe(true);
    expect(out.stale_exemptions.sort()).toEqual(['src/calc.ts#L2-L3', 'src/gone/**']);
    expect(out.exempt_used).toEqual([]);
  });

  test('an `ai` entry exempts nothing', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), '.goodboy/policy.md': policy('src/**').replace('human', 'ai') });
    expect(check(root, { lcov: lcov('src/other.ts', [[1, 1]]) })).toMatchObject({ ok: false });
  });
});

describe('coverageCheck: malformed and unusual input', () => {
  const root1 = () => repo({ 'src/calc.ts': TS('calc') });

  test.each([
    ['truncated XML', jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: [[1, 0, 1, 0, 0]] }] }]).slice(0, -30)],
    ['mismatched tags', '<report name="x"><package name="p"></report>'],
    ['an unquoted attribute', '<report name=x></report>'],
    ['text outside the root', '<report/>stray'],
    ['two roots', '<report/><report/>'],
    ['a bad JaCoCo number', '<report><package name="p"><sourcefile name="a.ts"><line nr="x" mi="0" ci="1" mb="0" cb="0"/></sourcefile></package></report>'],
    ['a sourcefile outside a package', '<report><sourcefile name="a.ts"/></report>'],
    ['an unknown XML root', '<html><body/></html>'],
    ['an internal DTD subset', '<!DOCTYPE report [<!ENTITY a "aaaa">]><report/>'],
    ['a truncated lcov record', 'SF:src/calc.ts\nDA:1,1\n'],
    ['a bad lcov DA', 'SF:src/calc.ts\nDA:one,1\nend_of_record\n'],
    ['an lcov record without SF', 'DA:1,1\nend_of_record\n'],
    ['an unknown format', 'hello world\n'],
    ['an empty file', ''],
  ])('%s is an error, not a pass', (_name, text) => {
    const root = root1();
    const out = check(root, { bad: text });
    expect(out.ok).toBe(false);
    expect(out.report_errors).toHaveLength(1);
    expect(out.problems.length).toBeGreaterThan(0);
    writeFileSync(join(root, 'bad.txt'), text);
    expect(cmdCoverageCheck(root, [join(root, 'bad.txt')])).toHaveProperty('error');
  });

  test('entities are never expanded: a billion-laughs document is refused fast', () => {
    const lol = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><report name="&lol2;"/>';
    const t0 = Date.now();
    const out = check(root1(), { bomb: lol });
    expect(out.report_errors[0]).toContain('DTD');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('predefined and numeric entities in a name are decoded', () => {
    const root = repo({ 'src/a&b.ts': TS('ab') });
    const xml = cobertura([], [{ filename: 'src/a&amp;b.ts', lines: [[1, 1], [2, 1], [3, 1]] }]);
    expect(check(root, { cob: xml })).toMatchObject({ ok: true, required: 1 });
  });

  test('a large flat document is parsed in linear time', () => {
    const root = root1();
    const lines = Array.from({ length: 200_000 }, (_, i) => `<line nr="${i + 1}" mi="0" ci="1" mb="0" cb="0"/>`).join('');
    const t0 = Date.now();
    const out = check(root, { big: `<report name="x"><package name="src"><sourcefile name="calc.ts">${lines}</sourcefile></package></report>` });
    expect(out).toMatchObject({ ok: true, required: 1 });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test('a missing report file is an error', () => {
    const root = root1();
    expect(coverageCheck(root, [join(root, 'nope.info')])).toMatchObject({ ok: false, report_errors: [expect.stringContaining('no such file')] });
  });

  test('a report none of whose files is in the project says so', () => {
    const root = root1();
    const out = check(root, { lcov: lcov('/elsewhere/src/calc.ts', [[1, 1]]) });
    expect(out.ok).toBe(false);
    expect(out.problems.join('\n')).toContain('--root-map');
  });

  test('outside a git repo the check fails with a problem', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m2-nogit-')));
    tmpDirs.push(dir);
    expect(coverageCheck(dir, [])).toMatchObject({ ok: false, problems: [expect.stringContaining('git')] });
  });
});

describe('coverageCheck: report paths', () => {
  test('a container path maps through --root-map', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), 'pkg/mod.py': 'def f(x):\n    return x\n' });
    const reports = {
      lcov: lcov('/work/src/calc.ts', [[1, 1], [2, 1], [3, 1]]),
      cob: cobertura(['/work/pkg'], [{ filename: 'mod.py', lines: [[1, 1], [2, 1]] }]),
    };
    expect(check(root, reports, [['/work', '.']])).toMatchObject({ ok: true, required: 2, full: 2, problems: [] });
    const without = check(root, reports);
    expect(without.ok).toBe(false);
    expect(without.gaps.map((g) => g.rel)).toEqual(['pkg/mod.py', 'src/calc.ts']);
  });

  test('a root map can point at a subdirectory, and the longest prefix wins', () => {
    const root = repo({ 'api/src/calc.ts': TS('calc'), 'src/calc.ts': TS('calc') });
    const out = check(root, { lcov: lcov('/app/src/calc.ts', [[1, 1], [2, 1], [3, 1]]) + lcov('/app/web/src/calc.ts', [[1, 1], [2, 1], [3, 1]]) }, [['/app', 'api'], ['/app/web', '.']]);
    expect(out).toMatchObject({ ok: true, required: 2 });
  });

  test('an absolute path under the root and a ./ path need no map; a path escaping the root is no file', () => {
    const root = repo({ 'src/calc.ts': TS('calc'), 'src/util.ts': TS('util') });
    const out = check(root, { lcov: lcov(join(root, 'src/calc.ts'), [[1, 1], [2, 1], [3, 1]]) + lcov('./src/util.ts', [[1, 1], [2, 1], [3, 1]]) + lcov('../outside.ts', [[1, 0]]) });
    expect(out).toMatchObject({ ok: true, required: 2 });
  });

  test('a JaCoCo package path and file name match the one project file that ends with it', () => {
    const root = repo({ 'app/src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo') });
    const out = check(root, { jacoco: jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: [[4, 0, 1, 0, 0], [5, 0, 1, 0, 2]] }] }]) });
    expect(out).toMatchObject({ ok: true, required: 1, problems: [] });
  });

  test('an ambiguous JaCoCo suffix is a problem and its coverage is not used', () => {
    const root = repo({ 'a/src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo'), 'b/src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo') });
    const out = check(root, { jacoco: jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: [[4, 0, 1, 0, 0]] }] }]) });
    expect(out.ok).toBe(false);
    expect(out.problems.join('\n')).toContain('com/acme/Foo.java matches 2 files');
    expect(out.gaps.map((g) => [g.rel, g.missing_from_report])).toEqual([['a/src/main/java/com/acme/Foo.java', true], ['b/src/main/java/com/acme/Foo.java', true]]);
  });

  test('a test class of the same name does not make a JaCoCo suffix ambiguous', () => {
    const root = repo({ 'src/main/java/com/acme/Foo.java': JAVA('com.acme', 'Foo'), 'src/test/java/com/acme/Foo.java': JAVA('com.acme', 'Foo') });
    const out = check(root, { jacoco: jacoco([{ name: 'com/acme', files: [{ name: 'Foo.java', lines: [[4, 0, 1, 0, 0], [5, 0, 1, 0, 2]] }] }]) });
    expect(out).toMatchObject({ ok: true, required: 1, problems: [] });
  });
});

describe('cmdCoverageCheck', () => {
  test('exit 0 when ok, 1 with gaps, and --root-map in both spellings', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    writeFileSync(join(root, 'ok.info'), lcov('/work/src/calc.ts', [[1, 1], [2, 1], [3, 1]]));
    writeFileSync(join(root, 'bad.info'), lcov('/work/src/calc.ts', [[1, 1], [2, 0], [3, 1]]));
    const ok = cmdCoverageCheck(root, [join(root, 'ok.info'), '--root-map', '/work=.']);
    expect(ok).toMatchObject({ code: 0, out: { ok: true } });
    expect(cmdCoverageCheck(root, ['--root-map=/work=.', join(root, 'bad.info')])).toMatchObject({ code: 1, out: { ok: false, gaps: [{ lines_missed: [2] }] } });
    // Reports are read relative to the root too.
    expect(cmdCoverageCheck(root, ['ok.info', '--root-map', '/work=.'])).toMatchObject({ code: 0 });
  });

  test('bad arguments are errors', () => {
    const root = repo({ 'src/calc.ts': TS('calc') });
    expect(cmdCoverageCheck(root, [])).toHaveProperty('error');
    expect(cmdCoverageCheck(root, ['x.info', '--root-map'])).toHaveProperty('error');
    expect(cmdCoverageCheck(root, ['x.info', '--root-map', 'nowhere'])).toHaveProperty('error');
    expect(cmdCoverageCheck(root, ['x.info', '--root-map', '=.'])).toHaveProperty('error');
    expect(cmdCoverageCheck(root, ['x.info', '--bogus'])).toHaveProperty('error');
    expect(cmdCoverageCheck(root, ['nope.info'])).toHaveProperty('error');
  });
});
