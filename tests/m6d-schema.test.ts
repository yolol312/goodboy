// Track M, M6d (§19): the field lists of lib/record-sanitize.ts (and REGRESSION_SCHEMA of lib/regression.ts) are tied
// to the record types. The lists are typed by the record (a path that is not a field does not compile: see
// BAD_PATHS below), and each test here walks a maximal record of each type, typed `DeepRequired<...>` so a
// field added to the type stops it from compiling until the fixture has it, and fails when a string field of the
// record is in no list: a field added later cannot silently become display text.
import { describe, expect, test } from 'bun:test';
import { REGRESSION_SCHEMA, type RegressionRecord } from '../lib/regression';
import { checkRecordFields, type RecordSchema, REVIEW_SCHEMA, type SchemaLists, sanitizeRecord, TEST_SCHEMA, WITHHELD_TEXT } from '../lib/record-sanitize';
import type { ReviewResult, TestResult } from '../lib/types';

type DeepRequired<T> = T extends readonly (infer U)[] ? DeepRequired<U>[] : T extends object ? { [K in keyof T]-?: DeepRequired<T[K]> } : T;

const RRN = '900101-1234567';

const H = (c: string): string => c.repeat(40);
const CHANGED = {
  covered: 1,
  total: 1,
  files_without_executed_changes: ['src/a.ts'],
  files: { 'src/a.ts': { covered: 1, total: 1 } },
  in_report: ['src/a.ts'],
  diff_lines: { 'src/a.ts': 1 },
  base: H('a'),
  top: '/repo',
  base_source: 'start' as const,
};
const TYPE_COUNT = { suites: 1, tests: 2, duration_ms: 3 };
const TEST_FULL: DeepRequired<TestResult> = {
  timestamp: '2026-11-16T03:18:16.000Z',
  tested_files: ['/repo/src/a.ts'],
  category: 'fix-bug',
  test_files: ['/repo/tests/a.test.ts'],
  environment: { mode: 'container', command: 'docker compose up -d', services: ['db'], evidence: 'healthy' },
  suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: 'ok', type: 'unit', duration_ms: 3 }],
  acceptance: [
    {
      id: 'PT-1',
      description: 'the page loads',
      test: 'tests/a.test.ts',
      red: { command: 'bun test a', output: 'failed', exit_code: 1 },
      green: { command: 'bun test a', output: 'passed', exit_code: 0 },
      mutation: { command: 'sed -i s/1/2/ src/a.ts', output: 'caught', detected: true, file: 'src/a.ts' },
    },
  ],
  prototype_diff: { prototype_path: 'docs/p.html', mismatches: [{ selector: '.a', issue: 'too small', severity: 'low' }] },
  verdict: 'pass',
  blocked: { reason: 'no runner is installed here', evidence: [{ command: 'which bun', output: 'none', exit_code: 1 }] },
  coverage: {
    status: 'measured',
    tool: 'bun test --coverage',
    line_pct: 80,
    branch_pct: 70,
    changed: CHANGED,
    reason: 'none',
    subprocess: [{ file: 'src/a.ts', test: 'tests/a.test.ts', top: '/repo' }],
  },
  notes: 'a note',
  sandbox: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, run: '20261116T031816Z', result_sha256: 'e'.repeat(64) },
  by_type: { unit: TYPE_COUNT, integration: TYPE_COUNT, ui: TYPE_COUNT, e2e: TYPE_COUNT },
  commit: H('a'),
  tree: H('b'),
  trees: { '/repo': H('c') },
  extra_blobs: { '/repo/ignored.ts': H('d') },
  worktree: '/repo-wt',
  repo: '/repo',
};
// the same record with the list form of coverage.changed (one entry per repo)
const TEST_FULL_LIST: DeepRequired<TestResult> = { ...TEST_FULL, coverage: { ...TEST_FULL.coverage, changed: [CHANGED] } };

const REVIEW_FULL: DeepRequired<ReviewResult> = {
  timestamp: '2026-11-16T03:18:16.000Z',
  reviewed_files: ['/repo/src/a.ts'],
  category: 'review-all',
  findings: [{ file: '/repo/src/a.ts', line: 3, issue: 'an issue', severity: 'high', probe: 'a probe', source: 'codex' }],
  unknown_assumptions_checked: [{ assumption: 'an assumption', reasonable: true, note: 'a note' }],
  verdict: 'needs-changes',
  dimensions_checked: ['security'],
  codex: { status: 'ran', reason: 'why', output: 'out' },
  tree: H('b'),
  extra_blobs: { '/repo/ignored.ts': H('d') },
  trees: { '/repo': H('c') },
};

const REGRESSION_FULL: DeepRequired<RegressionRecord> = {
  timestamp: '2026-11-16T03:18:16.000Z',
  commit: H('a'),
  tree: H('b'),
  tree_after: H('b'),
  changed_files: ['made.txt'],
  source: 'package.json scripts.test',
  worktree: '/repo-wt',
  repo: '/repo',
  runs: [{ command: 'bun run test', program: '/usr/bin/bun', exit_code: 1, duration_ms: 5, output_tail: 'boom' }],
  duration_ms: 5,
  verdict: 'fail',
};

// a path that is not a field of the record does not compile
const BAD_PATHS: RecordSchema<ReviewResult> = {
  computed: [],
  // @ts-expect-error `findings.[].line_no` is no field of a review finding
  ids: ['findings.[].line_no'],
  paths: [],
  commands: [],
  display: [],
};
void BAD_PATHS;

type Kind = 'computed' | 'ids' | 'paths' | 'commands' | 'display';
const KINDS: Kind[] = ['computed', 'ids', 'paths', 'commands', 'display'];

interface Leaf {
  /** `acceptance.[].red.output`: the schema's spelling. */
  schema: string;
  /** `acceptance[0].red.output`: where it is in this record. */
  at: string;
  /** The same as keys and indexes (a map key may hold a dot). */
  segs: (string | number)[];
}

/** Every node of `v` (objects, arrays and leaves), by schema path; the string leaves with where they are. */
function nodes(v: unknown, schema = '', at = '', segs: (string | number)[] = [], out: { all: Set<string>; strings: Leaf[] } = { all: new Set(), strings: [] }): { all: Set<string>; strings: Leaf[] } {
  if (schema !== '') out.all.add(schema);
  if (typeof v === 'string') out.strings.push({ schema, at, segs });
  else if (Array.isArray(v)) v.forEach((x, i) => nodes(x, schema === '' ? '[]' : `${schema}.[]`, `${at}[${i}]`, [...segs, i], out));
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) nodes(x, schema === '' ? k : `${schema}.${k}`, at === '' ? k : `${at}.${k}`, [...segs, k], out);
  return out;
}

const kindsOf = (schema: SchemaLists): Map<string, Kind> => {
  const m = new Map<string, Kind>();
  for (const k of KINDS) for (const p of schema[k]) m.set(p, k);
  return m;
};

/** The kind of a path: its own or its nearest listed ancestor's (a listed path covers its subtree); null: in no list. */
function kindOfPath(kinds: Map<string, Kind>, path: string): Kind | null {
  for (let p = path; p !== ''; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') {
    const k = kinds.get(p);
    if (k !== undefined) return k;
  }
  return null;
}

/** A copy of `v` with the string at `at` replaced. */
function withString(v: unknown, segs: (string | number)[], text: string): unknown {
  const copy = structuredClone(v) as Record<string, unknown>;
  let cur: any = copy;
  for (let i = 0; i < segs.length - 1; i++) cur = cur[segs[i]!];
  cur[segs[segs.length - 1]!] = text;
  return copy;
}

const RECORDS: ReadonlyArray<{ name: string; schema: SchemaLists; fixtures: unknown[]; checked: boolean }> = [
  { name: 'test record', schema: TEST_SCHEMA, fixtures: [TEST_FULL, TEST_FULL_LIST], checked: true },
  { name: 'review record', schema: REVIEW_SCHEMA, fixtures: [REVIEW_FULL], checked: true },
  { name: 'regression record', schema: REGRESSION_SCHEMA, fixtures: [REGRESSION_FULL], checked: false },
];

describe('M6d field lists are tied to the record types', () => {
  for (const { name, schema, fixtures } of RECORDS) {
    test(`${name}: every string field of a maximal record is in a list`, () => {
      const kinds = kindsOf(schema);
      const unclassified = new Set<string>();
      for (const f of fixtures) for (const leaf of nodes(f).strings) if (kindOfPath(kinds, leaf.schema) === null) unclassified.add(leaf.schema);
      expect([...unclassified]).toEqual([]);
    });

    test(`${name}: every listed path is a field of the maximal record (no dead or misspelled path)`, () => {
      const all = new Set<string>();
      for (const f of fixtures) for (const p of nodes(f).all) all.add(p);
      const dead = KINDS.flatMap((k) => schema[k].filter((p) => !all.has(p)));
      expect(dead).toEqual([]);
    });

    test(`${name}: no path is listed in two lists`, () => {
      const seen = new Set<string>();
      for (const k of KINDS) for (const p of schema[k]) {
        expect(seen.has(p)).toBe(false);
        seen.add(p);
      }
    });
  }

  test('the fixtures are clean to the writer checks', () => {
    for (const f of [TEST_FULL, TEST_FULL_LIST]) expect(checkRecordFields(f, TEST_SCHEMA)).toEqual([]);
    expect(checkRecordFields(REVIEW_FULL, REVIEW_SCHEMA)).toEqual([]);
  });
});

describe('M6d each field list does what it says, on every string field of each record', () => {
  for (const { name, schema, fixtures, checked } of RECORDS) {
    const kinds = kindsOf(schema);
    for (const [i, fixture] of fixtures.entries()) {
      test(`${name} ${i}: kept fields stay byte for byte, commands and display text are redacted`, () => {
        for (const leaf of nodes(fixture).strings) {
          const kind = kindOfPath(kinds, leaf.schema)!;
          // an identifier would not hold this text, but the sanitizer itself does not check, it keeps
          const dirty = withString(fixture, leaf.segs, `x ${RRN} y`);
          const out = JSON.stringify(sanitizeRecord(dirty, schema));
          if (kind === 'commands' || kind === 'display') {
            expect([leaf.at, out.includes('1234567')]).toEqual([leaf.at, false]);
            expect(out).toContain('x [redacted:resident-number] y');
          } else {
            expect([leaf.at, out.includes('x 900101-1234567 y')]).toEqual([leaf.at, true]);
          }
        }
      });

      test(`${name} ${i}: with withhold, display text and commands are the fixed text, the kept fields stay`, () => {
        const out = JSON.stringify(sanitizeRecord(fixture, schema, { withhold: true }));
        const whole = nodes(fixture).strings;
        for (const leaf of whole) {
          const kind = kindOfPath(kinds, leaf.schema)!;
          const clean = withString(fixture, leaf.segs, 'a marker text');
          const o = JSON.stringify(sanitizeRecord(clean, schema, { withhold: true }));
          expect([leaf.at, kind === 'commands' || kind === 'display' ? !o.includes('a marker text') : o.includes('a marker text')]).toEqual([leaf.at, true]);
        }
        expect(out).toContain(WITHHELD_TEXT);
      });

      if (checked) {
        test(`${name} ${i}: the writer check refuses an identifier that is not one and a path that holds personal data, naming the field`, () => {
          for (const leaf of nodes(fixture).strings) {
            const kind = kindOfPath(kinds, leaf.schema)!;
            if (kind !== 'ids' && kind !== 'paths') continue;
            const bad = kind === 'ids' ? `for Kim ${RRN}` : `src/${RRN}.ts`;
            const problems = checkRecordFields(withString(fixture, leaf.segs, bad), schema);
            expect([leaf.at, problems.map((p) => p.path)]).toEqual([leaf.at, [leaf.at]]);
            expect(JSON.stringify(problems)).not.toContain('1234567');
            expect(JSON.stringify(problems)).not.toContain('Kim');
          }
        });
      }
    }
  }

  test('a map of paths is checked by its keys: coverage.changed.files and diff_lines name the file', () => {
    const rec = structuredClone(TEST_FULL) as any;
    rec.coverage.changed.files = { [`src/${RRN}.ts`]: { covered: 1, total: 1 } };
    rec.coverage.changed.diff_lines = { 'src/ok.ts': 1, '010-1234-5678.ts': 2 };
    const problems = checkRecordFields(rec, TEST_SCHEMA);
    expect(problems.map((p) => [p.path, p.why])).toEqual([
      ['coverage.changed.files.{a key}', 'holds a resident-number'],
      ['coverage.changed.diff_lines.{a key}', 'holds a phone'],
    ]);
  });

  test('an unknown key in coverage.changed or in a subprocess pair, and a severity that is no severity, are not kept', () => {
    const rec = structuredClone(TEST_FULL) as any;
    rec.coverage.changed.note = `see ${RRN}`;
    rec.coverage.subprocess[0].extra = `call ${RRN}`;
    rec.coverage.changed[`k ${RRN}`] = 1;
    const out = JSON.stringify(sanitizeRecord(rec, TEST_SCHEMA));
    expect(out).not.toContain('1234567');
    expect(out).toContain('see [redacted:resident-number]');
    expect(out).toContain('call [redacted:resident-number]');
    // a severity that is free text is no identifier
    const bad = structuredClone(TEST_FULL) as any;
    bad.prototype_diff.mismatches[0].severity = `note ${RRN}`;
    expect(checkRecordFields(bad, TEST_SCHEMA).map((p) => p.path)).toEqual(['prototype_diff.mismatches[0].severity']);
  });

  test('a list entry of coverage.changed is checked and kept like the single form', () => {
    const rec = structuredClone(TEST_FULL_LIST) as any;
    rec.coverage.changed[0].files_without_executed_changes = ['ok.ts', `leak ${RRN}`];
    rec.coverage.changed[0].top = '/repo';
    expect(checkRecordFields(rec, TEST_SCHEMA).map((p) => p.path)).toEqual(['coverage.changed[0].files_without_executed_changes[1]']);
    const out = sanitizeRecord(rec, TEST_SCHEMA) as any;
    expect(out.coverage.changed[0].files).toEqual(CHANGED.files);
    expect(out.coverage.changed[0].files_without_executed_changes).toEqual(['ok.ts', `leak ${RRN}`]);
  });
});
