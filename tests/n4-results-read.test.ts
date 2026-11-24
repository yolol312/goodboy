// N4 (plan §20.3): `cli.ts results query|show`, a read-only view of the result records by name, so an agent
// need not read a record with a script (which the result guards count as a write, #13).
// In-process on temporary projects (real files, real symlinks), plus one spawned CLI and the guard rule.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resultCliWrite, resultDirWrite } from '../lib/role-limits';
import { DEFAULT_LIMIT, MAX_LIMIT, queryResults, runResults, showResult } from '../lib/results-read';

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-n4-')));
  dirs.push(d);
  return d;
}

type Kind = 'tests' | 'reviews' | 'regression';
const DIR: Record<Kind, string[]> = { tests: ['.claude', 'tests'], reviews: ['.claude', 'reviews'], regression: ['.claude', 'tests', 'regression'] };
/** A record file named after its time, as the CLI names them (`:` becomes `-`). */
const nameAt = (day: number): string => `2026-01-${String(day).padStart(2, '0')}T00-00-00.000Z`;
const isoAt = (day: number): string => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
function put(root: string, kind: Kind, name: string, body: unknown): string {
  const dir = join(root, ...DIR[kind]);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

/** Records of each kind: day 3 tests, day 4 reviews, day 2 regression, day 1 a test record with no timestamp. */
function populated(): string {
  const d = tmp();
  // JSON.stringify writes Infinity as null, so the infinite counts are spelled `1e999` in the raw text (it parses to Infinity).
  const tests3 = JSON.stringify({
    timestamp: isoAt(3),
    verdict: 'pass',
    category: 'fix-bug',
    tree: 'abcdef0123456789abcdef',
    tested_files: ['a.ts', 'b.ts'],
    suites: [{ passed: 3, failed: 1 }, { passed: 2, failed: 0 }, null, { passed: 'x', failed: null }, { passed: '__INF__', failed: '__INF__' }],
    coverage: { changed: { covered: 5, total: 6 } },
  }).split(`"__INF__"`).join('1e999');
  put(d, 'tests', nameAt(3), tests3);
  put(d, 'reviews', nameAt(4), {
    timestamp: isoAt(4),
    verdict: 'fail',
    reviewed_files: ['a.ts'],
    findings: [{ severity: 'high' }, { severity: 'low' }, { severity: 'high' }, 'junk', null, { note: 'no severity' }],
  });
  put(d, 'regression', nameAt(2), { timestamp: isoAt(2), verdict: 'pass', runs: [{}, {}] });
  put(d, 'tests', nameAt(1), { verdict: 'pass' });
  return d;
}

const ok = (root: string, args: string[]) => {
  const out = runResults(root, args);
  if (!out.ok) throw new Error(`not ok: ${out.error}`);
  return out as { ok: true; rows: Record<string, unknown>[]; more: boolean; capped?: boolean };
};
const err = (root: string, args: string[]): string => {
  const out = runResults(root, args);
  if (out.ok) throw new Error('expected an error');
  return out.error;
};

describe('results query', () => {
  test('newest first across the kinds, each row summarized by what the record holds', () => {
    const d = populated();
    const out = ok(d, ['query']);
    expect(out.rows.map((r) => `${r.kind}/${r.name}`)).toEqual([
      `reviews/${nameAt(4)}`,
      `tests/${nameAt(3)}`,
      `regression/${nameAt(2)}`,
      `tests/${nameAt(1)}`,
    ]);
    expect(out.more).toBe(false);
    expect(out.capped).toBeUndefined();
    const [review, test3, regression, bare] = out.rows;
    expect(review).toEqual({ kind: 'reviews', name: nameAt(4), timestamp: isoAt(4), verdict: 'fail', files: 1, findings: { high: 2, low: 1, other: 3 } });
    // suites: the numbers summed (a non-number, a null and an infinite one (`1e999` in the file) count for nothing), the tree cut to 10 characters
    expect(test3).toEqual({
      kind: 'tests',
      name: nameAt(3),
      timestamp: isoAt(3),
      verdict: 'pass',
      category: 'fix-bug',
      tree: 'abcdef0123',
      files: 2,
      suites: { passed: 5, failed: 1 },
    });
    expect(regression).toEqual({ kind: 'regression', name: nameAt(2), timestamp: isoAt(2), verdict: 'pass', runs: 2 });
    expect(bare).toEqual({ kind: 'tests', name: nameAt(1), verdict: 'pass' });
  });

  test('the tests dir lists its own records, never the regression dir as a record', () => {
    const d = populated();
    expect(ok(d, ['query', '--kind', 'tests']).rows.map((r) => r.name)).toEqual([nameAt(3), nameAt(1)]);
    expect(ok(d, ['query', '--kind', 'regression']).rows.map((r) => r.name)).toEqual([nameAt(2)]);
    expect(ok(d, ['query', '--kind', 'reviews']).rows.map((r) => r.name)).toEqual([nameAt(4)]);
  });

  test('--kind takes a comma list; a bad kind is an error that shows the usage', () => {
    const d = populated();
    expect(ok(d, ['query', '--kind', 'reviews,regression']).rows.map((r) => r.kind)).toEqual(['reviews', 'regression']);
    expect(ok(d, ['query', '--kind', 'tests, reviews']).rows.map((r) => r.kind)).toEqual(['reviews', 'tests', 'tests']);
    expect(err(d, ['query', '--kind', 'logs'])).toContain('--kind takes tests, reviews or regression');
    expect(err(d, ['query', '--kind', 'tests,logs'])).toContain('--kind takes');
    expect(err(d, ['query', '--kind', ''])).toContain('--kind takes');
  });

  test('--verdict keeps the matching records only', () => {
    const d = populated();
    expect(ok(d, ['query', '--verdict', 'fail']).rows.map((r) => r.name)).toEqual([nameAt(4)]);
    expect(ok(d, ['query', '--verdict', 'pass']).rows.map((r) => r.name)).toEqual([nameAt(3), nameAt(2), nameAt(1)]);
    expect(ok(d, ['query', '--verdict', 'blocked']).rows).toEqual([]);
  });

  test('--since keeps records stamped at or after the time; a record with no timestamp is left out; a bad time is an error', () => {
    const d = populated();
    expect(ok(d, ['query', '--since', isoAt(3)]).rows.map((r) => r.name)).toEqual([nameAt(4), nameAt(3)]);
    expect(ok(d, ['query', '--since', '2026-01-03T00:00:01Z']).rows.map((r) => r.name)).toEqual([nameAt(4)]);
    expect(ok(d, ['query', '--since', '2020-01-01']).rows.map((r) => r.name)).not.toContain(nameAt(1));
    expect(err(d, ['query', '--since', 'last week'])).toContain('--since takes an ISO time');
    // a record whose timestamp is not a time is left out as well
    put(d, 'tests', nameAt(9), { timestamp: 'soon', verdict: 'pass' });
    expect(ok(d, ['query', '--since', '2020-01-01']).rows.map((r) => r.name)).not.toContain(nameAt(9));
  });

  test('--limit: 1 to 200, more says that further matches exist; the default is 20', () => {
    const d = populated();
    const one = ok(d, ['query', '--limit', '1']);
    expect(one.rows.map((r) => r.name)).toEqual([nameAt(4)]);
    expect(one.more).toBe(true);
    expect(ok(d, ['query', '--limit', '4']).more).toBe(false);
    expect(ok(d, ['query', '--limit', '3']).more).toBe(true);
    for (const bad of ['0', '-1', '201', 'x', '1.5', '']) expect([bad, err(d, ['query', '--limit', bad])]).toEqual([bad, `results query: --limit takes 1 to ${MAX_LIMIT}`]);
    expect(ok(d, ['query', '--limit', '200']).rows).toHaveLength(4);
    for (let day = 10; day < 10 + DEFAULT_LIMIT + 2; day++) put(d, 'tests', nameAt(day), { verdict: 'pass' });
    const many = ok(d, ['query']);
    expect(many.rows).toHaveLength(DEFAULT_LIMIT);
    expect(many.more).toBe(true);
  });

  test('non-JSON, array JSON, a non-object, a name that is no record name and a record that is a link are skipped', () => {
    const d = populated();
    put(d, 'tests', nameAt(11), 'this is not json');
    put(d, 'tests', nameAt(12), '[1, 2]');
    put(d, 'tests', nameAt(13), '42');
    put(d, 'tests', nameAt(14), 'null');
    put(d, 'tests', '.hidden', { verdict: 'pass' });
    put(d, 'tests', 'a b', { verdict: 'pass' });
    writeFileSync(join(d, '.claude', 'tests', 'note.txt'), '{}');
    const real = join(tmp(), 'real.json');
    writeFileSync(real, JSON.stringify({ verdict: 'pass' }));
    symlinkSync(real, join(d, '.claude', 'tests', `${nameAt(15)}.json`));
    expect(ok(d, ['query', '--kind', 'tests']).rows.map((r) => r.name)).toEqual([nameAt(3), nameAt(1)]);
  });

  test('a dir that is a link (.claude, or a kind dir) is skipped, and a missing dir gives no rows', () => {
    const empty = tmp();
    expect(ok(empty, ['query'])).toEqual({ ok: true, rows: [], more: false });

    const outside = tmp();
    put(outside, 'tests', nameAt(5), { verdict: 'pass' });
    const viaClaude = tmp();
    symlinkSync(join(outside, '.claude'), join(viaClaude, '.claude'));
    expect(ok(viaClaude, ['query']).rows).toEqual([]);

    const viaDir = tmp();
    mkdirSync(join(viaDir, '.claude'), { recursive: true });
    put(outside, 'reviews', nameAt(6), { verdict: 'pass' });
    symlinkSync(join(outside, '.claude', 'reviews'), join(viaDir, '.claude', 'reviews'));
    expect(ok(viaDir, ['query']).rows).toEqual([]);

    // a kind dir that is a plain file
    const plain = tmp();
    mkdirSync(join(plain, '.claude'), { recursive: true });
    writeFileSync(join(plain, '.claude', 'reviews'), 'x');
    expect(ok(plain, ['query']).rows).toEqual([]);
  });

  test('a kind dir that cannot be listed gives no rows (and the others still list)', () => {
    const d = populated();
    const dir = join(d, '.claude', 'reviews');
    chmodSync(dir, 0o000);
    try {
      // (a process that may read any dir, as root, lists it anyway: then the review record shows)
      const names = ok(d, ['query']).rows.map((r) => `${r.kind}/${r.name}`);
      expect(names).toContain(`tests/${nameAt(3)}`);
      if (process.getuid?.() !== 0) expect(names).not.toContain(`reviews/${nameAt(4)}`);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test('the scan stops at 1000 records and says so (capped), so a huge dir costs a bounded read', () => {
    const d = tmp();
    for (let i = 0; i < 1002; i++) put(d, 'tests', `r${String(i).padStart(5, '0')}`, { verdict: 'pass' });
    const out = ok(d, ['query', '--verdict', 'fail']);
    expect(out).toEqual({ ok: true, rows: [], more: false, capped: true });
    // a limit reached before the cap is not capped
    expect(ok(d, ['query', '--limit', '2'])).toMatchObject({ more: true });
    expect(ok(d, ['query', '--limit', '2']).capped).toBeUndefined();
  });

  test('regression records spell the milliseconds after a `-`, the others after a `.`: one order by time across kinds', () => {
    const d = tmp();
    put(d, 'tests', '2026-01-03T00-00-00.500Z', { verdict: 'pass' });
    put(d, 'regression', '2026-01-03T00-00-00-700Z', { verdict: 'pass', runs: [] });
    put(d, 'reviews', '2026-01-03T00-00-00.600Z', { verdict: 'pass' });
    put(d, 'regression', '2026-01-03T00-00-00-100Z', { verdict: 'pass', runs: [] });
    expect(ok(d, ['query']).rows.map((r) => `${r.kind}/${r.name}`)).toEqual([
      'regression/2026-01-03T00-00-00-700Z',
      'reviews/2026-01-03T00-00-00.600Z',
      'tests/2026-01-03T00-00-00.500Z',
      'regression/2026-01-03T00-00-00-100Z',
    ]);
    // a name with other text after the seconds keeps its own spelling
    put(d, 'tests', '2026-01-03T00-00-00-5Z', { verdict: 'pass' });
    expect(ok(d, ['query', '--kind', 'tests']).rows).toHaveLength(2);
  });

  test('a link on the way takes the kind away: .claude/tests takes tests and regression, .claude/tests/regression only regression', () => {
    const outside = tmp();
    put(outside, 'tests', nameAt(5), { verdict: 'pass' });
    put(outside, 'regression', nameAt(6), { verdict: 'pass' });

    const viaTests = tmp();
    mkdirSync(join(viaTests, '.claude'), { recursive: true });
    symlinkSync(join(outside, '.claude', 'tests'), join(viaTests, '.claude', 'tests'));
    expect(ok(viaTests, ['query']).rows).toEqual([]);
    expect(runResults(viaTests, ['show', nameAt(6), '--kind', 'regression'])).toMatchObject({ ok: false });

    const viaRegression = tmp();
    put(viaRegression, 'tests', nameAt(7), { verdict: 'pass' });
    symlinkSync(join(outside, '.claude', 'tests', 'regression'), join(viaRegression, '.claude', 'tests', 'regression'));
    expect(ok(viaRegression, ['query']).rows.map((r) => `${r.kind}/${r.name}`)).toEqual([`tests/${nameAt(7)}`]);
  });

  test('a row\'s text is cut at 200 characters, and a finding\'s severity is one of the known names or `other`', () => {
    const d = tmp();
    const long = 'v'.repeat(500);
    put(d, 'tests', nameAt(2), { timestamp: long, verdict: long, category: long, tree: long, tested_files: [], findings: [{ severity: 'weird' }, { severity: '__proto__' }, { severity: 5 }, { severity: 'critical' }, { severity: 'medium' }, { severity: 'info' }] });
    const [row] = ok(d, ['query']).rows as Record<string, unknown>[];
    for (const k of ['timestamp', 'verdict', 'category']) expect([k, (row![k] as string).length]).toEqual([k, 200]);
    expect(row!.tree).toBe('v'.repeat(10));
    expect(row!.findings).toEqual({ other: 3, critical: 1, medium: 1, info: 1 });
    expect(Object.getPrototypeOf(row!.findings)).toBe(Object.prototype);
  });

  test('queryResults directly: kinds in order of name, not of kind', () => {
    const d = populated();
    const out = queryResults(d, { kinds: ['regression', 'tests'], limit: 10 });
    expect(out.rows.map((r) => r.name)).toEqual([nameAt(3), nameAt(2), nameAt(1)]);
  });
});

describe('results show', () => {
  test('the whole record, found in the one kind that has the name', () => {
    const d = populated();
    const out = runResults(d, ['show', nameAt(3)]);
    expect(out).toMatchObject({ ok: true, kind: 'tests', name: nameAt(3) });
    expect((out as unknown as { record: Record<string, unknown> }).record).toMatchObject({ verdict: 'pass', tested_files: ['a.ts', 'b.ts'] });
    expect(out).not.toHaveProperty('missing');
    expect(runResults(d, ['show', nameAt(4)])).toMatchObject({ ok: true, kind: 'reviews' });
    expect(runResults(d, ['show', nameAt(2)])).toMatchObject({ ok: true, kind: 'regression' });
  });

  test('--fields: dotted paths and array indexes; what is not there is listed under missing', () => {
    const d = populated();
    const out = runResults(d, ['show', nameAt(3), '--fields', 'verdict, coverage.changed.covered,suites.0.passed,suites.1.passed,nope,suites.9.passed,suites.01.passed,tested_files.length,verdict.x']);
    expect(out).toEqual({
      ok: true,
      kind: 'tests',
      name: nameAt(3),
      fields: { verdict: 'pass', 'coverage.changed.covered': 5, 'suites.0.passed': 3, 'suites.1.passed': 2 },
      missing: ['nope', 'suites.9.passed', 'suites.01.passed', 'tested_files.length', 'verdict.x'],
    });
    // a field whose value is null or false is found, not missing
    put(d, 'tests', nameAt(20), { gone: null, flag: false, zero: 0, empty: '' });
    expect(runResults(d, ['show', nameAt(20), '--fields', 'gone,flag,zero,empty'])).toMatchObject({ fields: { gone: null, flag: false, zero: 0, empty: '' } });
    expect(runResults(d, ['show', nameAt(20), '--fields', 'gone,flag,zero,empty'])).not.toHaveProperty('missing');
  });

  test('only a record\'s own keys are found: __proto__, constructor and toString are missing', () => {
    const d = populated();
    const out = runResults(d, ['show', nameAt(3), '--fields', '__proto__,constructor,toString,constructor.name,hasOwnProperty']);
    expect(out).toEqual({ ok: true, kind: 'tests', name: nameAt(3), fields: {}, missing: ['__proto__', 'constructor', 'toString', 'constructor.name', 'hasOwnProperty'] });
    // a record that holds those names itself is read as any other key
    put(d, 'tests', nameAt(21), '{"constructor":{"a":1},"toString":2}');
    expect(runResults(d, ['show', nameAt(21), '--fields', 'constructor.a,toString'])).toMatchObject({ fields: { 'constructor.a': 1, toString: 2 } });
  });

  test('the name is a record name: no path, no leading dot; the errors name the problem', () => {
    const d = populated();
    for (const bad of ['../x', 'a/b', '.hidden', 'a\\b', '..', 'x'.repeat(200), 'a b']) {
      const out = runResults(d, ['show', bad]);
      expect([bad, out.ok, out.ok ? '' : out.error.includes('is no record name')]).toEqual([bad, false, true]);
    }
    expect(err(d, ['show'])).toContain('name the record');
    expect(err(d, ['show', '--kind', 'tests'])).toContain('name the record');
    expect(err(d, ['show', 'nothere'])).toBe('results show: no record nothere (see: results query)');
    expect(err(d, ['show', 'nothere', '--kind', 'tests'])).toContain('no record nothere in tests');
    expect(err(d, ['show', nameAt(3), '--kind', 'reviews'])).toContain(`no record ${nameAt(3)} in reviews`);
  });

  test('a name in two kinds asks for --kind; with it the record is the kind\'s', () => {
    const d = populated();
    put(d, 'reviews', nameAt(3), { verdict: 'fail', findings: [] });
    expect(err(d, ['show', nameAt(3)])).toBe(`results show: ${nameAt(3)} is in tests and reviews; pass --kind`);
    expect(runResults(d, ['show', nameAt(3), '--kind', 'reviews'])).toMatchObject({ ok: true, kind: 'reviews', record: { verdict: 'fail' } });
    expect(runResults(d, ['show', nameAt(3), '--kind', 'tests'])).toMatchObject({ ok: true, kind: 'tests', record: { verdict: 'pass' } });
    expect(err(d, ['show', nameAt(3), '--kind', 'logs'])).toContain('--kind takes tests, reviews or regression');
  });

  test('a record over --max-bytes comes back as its keys and their sizes, with a hint', () => {
    const d = populated();
    put(d, 'tests', nameAt(22), { verdict: 'pass', big: 'x'.repeat(500), small: 1 });
    const out = runResults(d, ['show', nameAt(22), '--max-bytes', '100']) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, kind: 'tests', name: nameAt(22), truncated: true, max_bytes: 100 });
    expect(out.bytes).toBeGreaterThan(500);
    expect(out.keys).toEqual({ verdict: 6, big: 502, small: 1 });
    expect(out.hint).toContain('--fields');
    expect(out).not.toHaveProperty('record');
    expect(out).not.toHaveProperty('missing');
    // a selection over the cap is cut the same way and keeps what it could not find
    const sel = runResults(d, ['show', nameAt(22), '--fields', 'big,verdict,none', '--max-bytes', '100']) as Record<string, unknown>;
    expect(sel).toMatchObject({ truncated: true, keys: { big: 502, verdict: 6 }, missing: ['none'] });
    // under the cap: whole
    expect(runResults(d, ['show', nameAt(22), '--fields', 'small,verdict', '--max-bytes', '100'])).toMatchObject({ ok: true, fields: { small: 1, verdict: 'pass' } });
    expect(runResults(d, ['show', nameAt(22), '--max-bytes', '5000'])).toMatchObject({ ok: true, record: { small: 1 } });
    // multibyte text counts in bytes
    put(d, 'tests', nameAt(23), { t: '한'.repeat(40) });
    expect(runResults(d, ['show', nameAt(23), '--max-bytes', '100'])).toMatchObject({ truncated: true, keys: { t: 122 } });
  });

  test('a record that holds `__proto__` as a key shows it as a key, and an output over the cap lists at most 200 keys, each name cut', () => {
    const d = tmp();
    put(d, 'tests', nameAt(2), '{"__proto__":{"polluted":1},"verdict":"pass"}');
    const out = runResults(d, ['show', nameAt(2), '--fields', '__proto__,verdict']);
    expect(JSON.stringify(out)).toContain('"fields":{"__proto__":{"polluted":1},"verdict":"pass"}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const text = JSON.stringify(runResults(d, ['show', nameAt(2), '--max-bytes', '5']));
    expect(text).toContain('"truncated":true');
    expect(text).toContain('"__proto__":');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const wide: Record<string, number> = {};
    for (let i = 0; i < 250; i++) wide[`k${String(i).padStart(3, '0')}`] = i;
    wide['x'.repeat(300)] = 1;
    put(d, 'tests', nameAt(3), wide);
    const cut = runResults(d, ['show', nameAt(3), '--max-bytes', '10']) as unknown as { keys: Record<string, number>; keys_omitted: number; truncated: boolean };
    expect(cut.truncated).toBe(true);
    expect(Object.keys(cut.keys)).toHaveLength(200);
    expect(cut.keys_omitted).toBe(51);
    expect(Object.keys(cut.keys).every((k) => k.length <= 200)).toBe(true);
    // exactly 200 keys: none omitted
    const exact: Record<string, number> = {};
    for (let i = 0; i < 200; i++) exact[`k${i}`] = i;
    put(d, 'tests', nameAt(4), exact);
    expect(runResults(d, ['show', nameAt(4), '--max-bytes', '10'])).not.toHaveProperty('keys_omitted');
    // a long key name on a short record is cut too
    put(d, 'tests', nameAt(5), { ['y'.repeat(300)]: 'z' });
    const longKey = runResults(d, ['show', nameAt(5), '--max-bytes', '5']) as unknown as { keys: Record<string, number> };
    expect(Object.keys(longKey.keys)).toEqual(['y'.repeat(200)]);
  });

  test('the option errors: --max-bytes 1 to 200000, --fields not empty', () => {
    const d = populated();
    for (const bad of ['0', '200001', 'x', '1.5', '']) expect([bad, err(d, ['show', nameAt(3), '--max-bytes', bad])]).toEqual([bad, 'results show: --max-bytes takes 1 to 200000']);
    expect(err(d, ['show', nameAt(3), '--fields', ' , ,'])).toContain('--fields takes a comma-separated list');
    expect(err(d, ['show', nameAt(3), '--fields', ''])).toContain('--fields takes');
  });

  test('a name that lists but holds no JSON object is an error that says which file', () => {
    const d = populated();
    put(d, 'tests', nameAt(24), 'not json');
    put(d, 'tests', nameAt(25), '[]');
    expect(err(d, ['show', nameAt(24)])).toBe(`results show: tests/${nameAt(24)}.json is not a readable JSON object`);
    expect(err(d, ['show', nameAt(25)])).toContain('is not a readable JSON object');
    // a record that is a link is listed by name but never read: show refuses it the same way
    const real = join(tmp(), 'real.json');
    writeFileSync(real, '{"verdict":"pass"}');
    symlinkSync(real, join(d, '.claude', 'tests', `${nameAt(26)}.json`));
    expect(err(d, ['show', nameAt(26)])).toBe(`results show: tests/${nameAt(26)}.json is not a readable JSON object`);
  });

  test('showResult directly with a kind and fields', () => {
    const d = populated();
    expect(showResult(d, nameAt(4), { kind: 'reviews', fields: ['findings.0.severity'], maxBytes: 1000 })).toMatchObject({ fields: { 'findings.0.severity': 'high' } });
  });
});

describe('results: the command word', () => {
  test('anything but query or show is the usage', () => {
    const d = populated();
    for (const args of [[], ['list'], ['QUERY']]) expect(err(d, args)).toContain('results query [--kind');
    expect(err(d, [])).toContain('results show <name>');
  });
});

describe('the CLI process', () => {
  const spawn = (cwd: string, args: string[]) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: cwd, GOODBOY_REGISTRY_DIR: tmp() };
    delete env.CLAUDE_CODE_SESSION_ID;
    const p = Bun.spawnSync(['bun', CLI, 'results', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test('show prints the record as one JSON line and exits 0; query lists; an error goes to stderr with exit 1', () => {
    const d = populated();
    const shown = spawn(d, ['show', nameAt(3), '--fields', 'verdict,suites.0.passed']);
    expect([shown.code, shown.err]).toEqual([0, '']);
    expect(shown.out.endsWith('\n')).toBe(true);
    expect(JSON.parse(shown.out)).toEqual({ ok: true, kind: 'tests', name: nameAt(3), fields: { verdict: 'pass', 'suites.0.passed': 3 } });

    const listed = spawn(d, ['query', '--kind', 'reviews']);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out).rows).toEqual([{ kind: 'reviews', name: nameAt(4), timestamp: isoAt(4), verdict: 'fail', files: 1, findings: { high: 2, low: 1, other: 3 } }]);

    const bad = spawn(d, ['show', '../../etc/passwd']);
    expect(bad.code).toBe(1);
    expect(bad.out).toBe('');
    expect(bad.err).toContain('is no record name');
    const none = spawn(d, ['show', 'missing']);
    expect([none.code, none.err.trim()]).toEqual([1, 'results show: no record missing (see: results query)']);
  });
});

describe('the result guard lets `results` through and still flags a result dir named in the arguments', () => {
  test('resultDirWrite', () => {
    const cwd = '/proj';
    expect(resultDirWrite(`bun /x/lib/cli.ts results show ${nameAt(1)}`, cwd)).toBeNull();
    expect(resultDirWrite('bun /x/lib/cli.ts results query --kind tests --limit 5', cwd)).toBeNull();
    expect(resultDirWrite(`bun /x/lib/cli.ts results show ${nameAt(1)} --fields suites.0.passed`, cwd)).toBeNull();
    // a path under .claude/tests in the arguments of an interpreter is still a write (#13)
    expect(resultDirWrite('bun /x/lib/cli.ts results show .claude/tests/x', cwd)).not.toBeNull();
    expect(resultDirWrite('bun -e "require(\'fs\').writeFileSync(\'.claude/tests/x.json\', 1)"', cwd)).not.toBeNull();
    expect(resultDirWrite('python3 read.py .claude/reviews/x.json', cwd)).not.toBeNull();
  });
});

describe('resultCliWrite: `results` only reads, whatever follows', () => {
  test('`results query --kind regression` and `results show` are no result write; the writers still are', () => {
    const cli = 'bun /x/lib/cli.ts';
    for (const c of [`${cli} results query --kind regression`, `${cli} results query --kind tests,regression --verdict pass`, `${cli} results show ${nameAt(1)} --kind regression`, `${cli} results show ${nameAt(1)} --fields test-write,review-write`, `cd /p && ${cli} results query`, `/x/lib/cli.ts results query --kind regression`]) {
      expect([c, resultCliWrite(c)]).toEqual([c, null]);
    }
    expect(resultCliWrite(`${cli} regression`)).toBe('test');
    expect(resultCliWrite(`${cli} test-write`)).toBe('test');
    expect(resultCliWrite(`${cli} review-write`)).toBe('review');
    // a writer after a `results` read in the same command line is still found
    expect(resultCliWrite(`${cli} results query && ${cli} test-write`)).toBe('test');
    expect(resultCliWrite(`${cli} results query; ${cli} review-write`)).toBe('review');
  });
});
