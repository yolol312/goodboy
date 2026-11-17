// Track M, M6a (plan §19): the pieces of the output boundary that need no docker: the text policy,
// the counts read from JUnit XML and the Playwright report, the volume scripts and their parsers,
// the expiry rules, the stored ui-check verdict, the compose volumes and the real-data flag.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bounded } from '../lib/bounded';
import { boundary, DIAG_CODES, OPEN, realDataOf } from '../lib/sandbox-boundary';
import { writeLocal } from '../lib/sandbox-files';
import { readLocal, realDataForReading, SANDBOX_DIR } from '../lib/sandbox-mode';
import { entrypoint } from '../lib/sandbox-parts';
import { planSandbox } from '../lib/sandbox-render';
import { playwrightConfig } from '../lib/sandbox-e2e';
import { staticProblems } from '../lib/sandbox-run';
import { isLiveRun, parseState, rawTtlMs, runStartedAt, sweepVictims } from '../lib/sandbox-expiry';
import { junitCounts } from '../lib/sandbox-store';
import { MAX_JUNIT_BYTES, parseJUnit, playwrightSummary } from '../lib/sandbox-summary';
import {
  E2E_AFTER_SCRIPT,
  FINISH_SCRIPT,
  frameBudget,
  LIST_SCRIPT,
  moduleDirs,
  outDirMounts,
  outDirVolume,
  OUTPUT_DIRS,
  outputDirsFor,
  parseFrames,
  parseNames,
  READ_SCRIPT,
  readerMounts,
  UNIT_AFTER_SCRIPT,
  volumeMarker,
  volumeNames,
  wroteLog,
} from '../lib/sandbox-volumes';
import { readRunResult } from '../lib/sandbox-proof';
import { cmdUiCheck, parseReport, parseStoredUiCheck, specId, STORED_FILE, storedUiCheck, uiCheck } from '../lib/ui-check';
import type { UiInventory } from '../lib/ui-types';
import { plainScan } from './m6a-project';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (prefix = 'goodboy-m6a-p-'): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

// the shapes a model must never see back
const NAME = '김민수';
const NAME_NFD = NAME.normalize('NFD');
const RRN = '900101-1234567';
const MAIL = 'minsu.kim@canary-corp.example';
const CANARIES = [NAME, NAME_NFD, RRN, MAIL];
const leaks = (text: string): string[] => CANARIES.filter((c) => text.includes(c));

const bounded = (over: Partial<Bounded> = {}): Bounded => ({ code: 1, stdout: `out ${NAME}`, stderr: `err ${MAIL}`, timedOut: false, ms: 5, ...over });

describe('the text policy (lib/sandbox-boundary.ts)', () => {
  test('outside real-data mode every helper gives the raw text, as before', () => {
    const b = boundary(false);
    expect(b.text('raw words', 'internal')).toBe('raw words');
    expect(b.tail(bounded(), 2000)).toBe(`out ${NAME}\nerr ${MAIL}`);
    expect(b.tail(bounded({ code: 0 }), 2000)).toBe('');
    expect(b.tail(bounded({ code: 0, timedOut: true }), 5)).toBe(`\nerr ${MAIL}`.slice(-5));
    expect(b.why(bounded(), 'docker-failed')).toBe(`err ${MAIL}`);
    expect(b.why(bounded({ stderr: '', stdout: '' }), 'docker-failed')).toBe('exit 1');
    expect(b.why(bounded({ timedOut: true }), 'docker-failed')).toBe('timed out');
    expect(b.why(bounded({ error: 'spawn failed' }), 'docker-failed')).toBe('spawn failed');
    expect(b.diag('step-failed', 's')).toBeUndefined();
    expect(b.fail(bounded(), 'docker-failed', 's')).toEqual({ note: `err ${MAIL}` });
    expect([b.appLogs, b.hostCopies, b.reportRef('/host/report.json', 'volume:marker')]).toEqual([true, true, '/host/report.json']);
    expect(b.err('sandbox-run', new Error('the reason'))).toBe('sandbox-run: the reason');
    expect(b.err('sandbox-run', 'plain')).toBe('sandbox-run: plain');
  });

  test('in real-data mode nothing but a code leaves: no tail, no docker words, no message, only the error class', () => {
    const b = boundary(true);
    expect(b.text(`something with ${NAME}`, 'restore-failed')).toBe('restore-failed');
    expect(b.text(`something with ${NAME}`, 'check-failed', 'networks')).toBe('check-failed (networks)');
    expect(b.tail(bounded(), 2000)).toBe('');
    expect(b.why(bounded(), 'docker-failed')).toBe('docker-failed');
    expect(b.why(bounded({ timedOut: true }), 'docker-failed')).toBe('timed-out');
    // one code gives the note and the diagnostic together, so the two cannot drift
    expect(b.fail(bounded(), 'step-failed', 'unit')).toEqual({ note: 'step-failed', diagnostic: { code: 'step-failed', step: 'unit', exit: 1, timedOut: false } });
    expect(b.fail(bounded({ timedOut: true, code: null }), 'step-failed', 'unit')).toEqual({ note: 'timed-out', diagnostic: { code: 'timed-out', step: 'unit', exit: null, timedOut: true } });
    expect(JSON.stringify(b.fail(bounded(), 'docker-failed', 'x'))).not.toContain(MAIL);
    expect(b.diag('internal', 'x')).toEqual({ code: 'internal', step: 'x' });
    expect([b.appLogs, b.hostCopies, b.reportRef('/host/report.json', 'volume:marker')]).toEqual([false, false, 'volume:marker']);
    class StoreError extends Error {}
    expect(b.err('sandbox-run', new StoreError(`row ${NAME}`))).toBe('sandbox-run: internal (StoreError)');
    // a class name that is not a plain identifier (it could be anything a library made up) is not echoed
    const odd = new Error(`row ${RRN}`);
    Object.defineProperty(odd, 'constructor', { value: { name: `${NAME}Error` } });
    expect(b.err('sandbox-run', odd)).toBe('sandbox-run: internal (Error)');
    expect(b.err('sandbox-run', `raw ${MAIL}`)).toBe('sandbox-run: internal (Error)');
  });

  test('the codes are one fixed list, and the preparation step keeps its tails', () => {
    expect(DIAG_CODES).toEqual([
      'step-failed', 'timed-out', 'restore-failed', 'reset-failed', 'proxy-failed', 'app-failed', 'app-down', 'live-failed',
      'artifacts-not-removed', 'coverage-failed', 'data-failed', 'data-refused', 'data-resolve-failed', 'data-collision', 'volume-failed', 'privacy-review-missing', 'privacy-setup-unreadable', 'sweep-failed', 'registry-failed', 'docker-failed', 'check-failed', 'internal', 'withheld',
    ]);
    expect(OPEN.realData).toBe(false);
    expect(OPEN.tail(bounded(), 100)).toContain('out');
  });

  test('real-data mode is the flag or a dump, and a flag without a dump stays', () => {
    expect(realDataOf({ dump: null, dumpFormat: null })).toBe(false);
    expect(realDataOf({ dump: null, dumpFormat: null, realData: false })).toBe(false);
    expect(realDataOf({ dump: null, dumpFormat: null, realData: true })).toBe(true);
    expect(realDataOf({ dump: '/d.sql', dumpFormat: 'sql' })).toBe(true);
    expect(realDataOf({ dump: '/d.sql', dumpFormat: 'sql', realData: false })).toBe(true);
  });
});

describe('the counts of a run (lib/sandbox-summary.ts)', () => {
  const suite = (attrs: string, body = '<testcase name="x" classname="y"/>') => `<?xml version="1.0"?>\n<testsuite ${attrs}>\n${body}\n</testsuite>\n`;

  test('JUnit: the counts of each suite, named only when the name is a class name', () => {
    const r = parseJUnit([
      suite('name="com.acme.UserTest" tests="5" skipped="1" failures="1" errors="0" timestamp="2026-01-01T00:00:00" hostname="h" time="0.52"'),
      suite('name="com.acme.Outer$Inner" tests="2" failures="0" errors="1" skipped="0" time="1"'),
      // a display name an author wrote, in Korean or with spaces or markup, is a number, not text
      suite(`name="${NAME} 조회" tests="1" failures="0" errors="0" skipped="0" time="0"`),
      suite('name="list orders &lt;b&gt;" tests="3" failures="0" errors="0" skipped="0" time="0.1"'),
      `<testsuites><testsuite name="a.B" tests="1" failures="0" errors="0" skipped="0" time="0"/><testsuite name="a.C" tests="2" failures="0" errors="0" skipped="0" time="0"/></testsuites>`,
    ]);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.truncated).toBe(false);
    expect(r.suites).toEqual([
      { name: 'com.acme.UserTest', tests: 5, failures: 1, errors: 0, skipped: 1, time: 0.52 },
      { name: 'com.acme.Outer$Inner', tests: 2, failures: 0, errors: 1, skipped: 0, time: 1 },
      { name: 'suite-3', tests: 1, failures: 0, errors: 0, skipped: 0, time: 0 },
      { name: 'suite-4', tests: 3, failures: 0, errors: 0, skipped: 0, time: 0.1 },
      { name: 'a.B', tests: 1, failures: 0, errors: 0, skipped: 0, time: 0 },
      { name: 'a.C', tests: 2, failures: 0, errors: 0, skipped: 0, time: 0 },
    ]);
  });

  test('JUnit: no case name, message or system-out is read into the counts, and text inside CDATA or a comment is never a tag', () => {
    const body = [
      `<testcase name="${NAME} 조회" classname="c"><failure message="${RRN}">trace ${MAIL}</failure></testcase>`,
      `<system-out><![CDATA[<testsuite name="fake.Suite" tests="99" failures="99" errors="0" skipped="0" time="1"/> ${NAME}]]></system-out>`,
      `<!-- <testsuite name="fake.Two" tests="98" failures="0" errors="0" skipped="0" time="0"/> -->`,
    ].join('\n');
    const r = parseJUnit([suite('name="com.acme.UserTest" tests="1" failures="1" errors="0" skipped="0" time="0.5"', body)]);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.suites).toEqual([{ name: 'com.acme.UserTest', tests: 1, failures: 1, errors: 0, skipped: 0, time: 0.5 }]);
    expect(leaks(JSON.stringify(r))).toEqual([]);
  });

  test('JUnit: a file with no suite, a count that is not a plain number or a tag that is not closed is unreadable, and says nothing of its text', () => {
    expect(parseJUnit([`<html>${NAME}</html>`])).toBe('unreadable');
    expect(parseJUnit([''])).toBe('unreadable');
    expect(parseJUnit([suite('name="a.B" tests="many" failures="0"')])).toBe('unreadable');
    expect(parseJUnit([suite('name="a.B" tests="-1"')])).toBe('unreadable');
    expect(parseJUnit([suite('name="a.B" tests="1" time="soon"')])).toBe('unreadable');
    expect(parseJUnit([`<testsuite name="a.B" tests="1" ${NAME}`])).toBe('unreadable');
    // one bad file among good ones fails the whole read: the counts are all or nothing
    expect(parseJUnit([suite('name="a.B" tests="1"'), 'junk'])).toBe('unreadable');
    expect(JSON.stringify(parseJUnit([`<html>${NAME}</html>`]))).not.toContain(NAME);
  });

  test('JUnit: more suites than the cap are cut off and flagged', () => {
    const many = `<testsuites>${Array.from({ length: 2005 }, (_, i) => `<testsuite name="a.S${i}" tests="1"/>`).join('')}</testsuites>`;
    const r = parseJUnit([many]);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.suites).toHaveLength(2000);
    expect(r.truncated).toBe(true);
  });

  test('JUnit: a suite that wraps others is not counted with them (no double count); a closed one, a self-closing one and a marker inside CDATA after a comment are read right', () => {
    const nested = `<testsuite name="all.Wrapper" tests="5" failures="2" errors="0" skipped="0" time="3"><testsuite name="a.First" tests="2" failures="1" errors="0" skipped="0" time="1"/><testsuite name="a.Second" tests="3" failures="1" errors="0" skipped="0" time="2"><testcase name="x"/></testsuite></testsuite>`;
    const r = parseJUnit([nested]);
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.suites.map((x) => [x.name, x.tests, x.failures])).toEqual([['a.First', 2, 1], ['a.Second', 3, 1]]);
    // a comment opener in one CDATA and a closer in a later one hold no suite hostage
    const tricky = `<testsuites><testsuite name="a.One" tests="1" failures="1"><system-out><![CDATA[<!-- ]]></system-out></testsuite><testsuite name="a.Two" tests="4" failures="3"><system-out><![CDATA[ --> ]]></system-out></testsuite></testsuites>`;
    const t = parseJUnit([tricky]);
    if (t === 'unreadable') throw new Error('unreadable');
    expect(t.suites.map((x) => [x.name, x.tests, x.failures])).toEqual([['a.One', 1, 1], ['a.Two', 4, 3]]);
    // a `>` inside a quoted value does not end the tag
    const gt = parseJUnit([`<testsuite name="a.B" tests="2" failures="0" note="x > y"><testcase name="c"/></testsuite>`]);
    if (gt === 'unreadable') throw new Error('unreadable');
    expect(gt.suites).toEqual([{ name: 'a.B', tests: 2, failures: 0, errors: 0, skipped: 0, time: 0 }]);
  });

  test('JUnit: a suite that wraps others and has cases of its own counts those cases once, with their failures, errors and skips', () => {
    const wrapped = `<testsuite name="all.Wrapper" tests="9" failures="9"><testcase name="own one"/><testcase name="own two"><failure message="m">trace</failure></testcase><testcase name="own three"><error/></testcase><testcase name="own four"><skipped/></testcase><testsuite name="a.Child" tests="3" failures="0" errors="0" skipped="0" time="1"><testcase name="c1"><failure/></testcase></testsuite><testcase name="own five"/></testsuite>`;
    const r = parseJUnit([wrapped]);
    if (r === 'unreadable') throw new Error('unreadable');
    // the child by its own counts (its case is not the wrapper's), then the wrapper's five cases
    expect(r.suites).toEqual([
      { name: 'a.Child', tests: 3, failures: 0, errors: 0, skipped: 0, time: 1 },
      { name: 'all.Wrapper', tests: 5, failures: 1, errors: 1, skipped: 1, time: 0 },
    ]);
    // a wrapper with no case of its own adds nothing
    const none = parseJUnit([`<testsuite name="w.W"><testsuite name="a.A" tests="1"/></testsuite>`]);
    if (none === 'unreadable') throw new Error('unreadable');
    expect(none.suites.map((x) => x.name)).toEqual(['a.A']);
  });

  test('JUnit: markers that are never closed, a close with no open and a suite left open are unreadable', () => {
    for (const bad of [
      '<testsuite name="a.B" tests="1"><!-- never closed',
      '<testsuite name="a.B" tests="1"><![CDATA[ never closed',
      '<?xml version="1.0"',
      '<testsuite name="a.B" tests="1"',
      '<testsuite name="a.B" tests="1">',
      '</testsuite><testsuite name="a.B" tests="1"/>',
      '<testsuite name="a.B" tests="1"/></testsuite>',
      `<testsuite name="a.B" tests="1" x="${'a'.repeat(20_000)}"/>`,
    ]) expect([bad.slice(0, 40), parseJUnit([bad])]).toEqual([bad.slice(0, 40), 'unreadable']);
  });

  test('JUnit: garbled input of 2 MiB is read in linear time (unterminated openers, many tags, long names)', () => {
    const MiB2 = 2 * 1024 * 1024;
    const inputs: Record<string, string> = {
      comments: '<!--'.repeat(MiB2 / 4),
      cdata: '<![CDATA['.repeat(MiB2 / 9),
      'comment after a suite': `<testsuite name="a.B" tests="1"/>${'<!-- '.repeat(MiB2 / 5)}`,
      openers: '<testsuite '.repeat(MiB2 / 11),
      closers: '</testsuite '.repeat(MiB2 / 12),
      'open tags': '<testsuite a="1">'.repeat(MiB2 / 17),
      'other tags': '<a b="'.repeat(MiB2 / 6),
      'long names': `<testsuite ${'a'.repeat(15_000)}>`.repeat(MiB2 / 15_011) + '</testsuite>'.repeat(MiB2 / 15_011),
      'many quotes': `<testsuite ${'a="b" '.repeat(MiB2 / 6)}/>`,
      'open cases': `<testsuite name="a.B">${'<testcase '.repeat(MiB2 / 10)}`,
      'many failures': `<testsuite name="a.B"><testcase name="c">${'<failure '.repeat(MiB2 / 9)}</testcase></testsuite>`,
      'many cases in a wrapper': `<testsuite name="w.W">${'<testcase name="c"/>'.repeat(MiB2 / 20)}<testsuite name="a.A" tests="1"/></testsuite>`,
    };
    for (const [what, text] of Object.entries(inputs)) {
      const t0 = performance.now();
      parseJUnit([text]);
      const ms = performance.now() - t0;
      expect([what, ms < 1500]).toEqual([what, true]);
    }
  });

  test('the counts of the files a reader call returned: a file over the cap is skipped and counted, a JVM run with none says so, a budget that was hit says so', () => {
    const text = (xml: string) => ({ kind: 'text' as const, text: xml });
    const one = '<testsuite name="a.B" tests="2" failures="1"/>';
    const files = (m: Record<string, ReturnType<typeof text> | { kind: 'refused' } | { kind: 'absent' }>, partial = false) => ({ files: new Map(Object.entries(m)), partial });
    expect(junitCounts(files({ '/a': text(one), '/b': { kind: 'refused' } }), true)).toEqual({ suites: [{ name: 'a.B', tests: 2, failures: 1, errors: 0, skipped: 0, time: 0 }], skipped_files: 1 });
    expect(junitCounts(files({ '/b': { kind: 'refused' } }), true)).toEqual({ suites: [], skipped_files: 1 });
    expect(junitCounts(files({}), true)).toEqual({ counts: 'missing' });
    expect(junitCounts(files({}), false)).toEqual({});
    expect(junitCounts(files({ '/a': text(one) }, true), true)).toMatchObject({ partial: true });
    expect(junitCounts(files({ '/a': text('junk') }), true)).toEqual({ unreadable: true });
    expect(junitCounts(null, true)).toEqual({ unreadable: true });
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`/f${i}`, text(one)]));
    expect(junitCounts(files(many), true).truncated).toBe(true);
  });

  const report = (over: Record<string, unknown> = {}) => ({
    stats: { startTime: 't', duration: 1234.5, expected: 2, skipped: 1, unexpected: 1, flaky: 0 },
    suites: [
      {
        title: 'orders.spec.ts',
        file: 'orders.spec.ts',
        specs: [
          { title: `lists ${NAME}`, file: 'orders.spec.ts', tests: [{ status: 'expected', annotations: [{ type: 'goodboy-ui', description: `screen:GET:/${RRN}:ok` }], results: [{ status: 'passed', error: { message: MAIL } }] }] },
          { title: 'saves', file: 'orders.spec.ts', tests: [{ status: 'unexpected', results: [{ status: 'failed' }] }] },
        ],
        suites: [{ title: 'nested', specs: [{ title: 'inner', file: 'sub/x.spec.ts', tests: [{ status: 'expected' }, { status: 'skipped' }] }] }],
      },
    ],
    ...over,
  });

  test('Playwright: the stats and the counts per spec file, no title, annotation or error', () => {
    const r = playwrightSummary(JSON.stringify(report()));
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.stats).toEqual({ expected: 2, unexpected: 1, flaky: 0, skipped: 1, duration: 1234.5 });
    expect(r.files).toEqual([
      { file: 'e2e/orders.spec.ts', passed: 1, failed: 1 },
      { file: 'e2e/sub/x.spec.ts', passed: 1, failed: 0 },
    ]);
    expect(leaks(JSON.stringify(r))).toEqual([]);
  });

  test('Playwright: a file name that is not a plain path is a number, and a report of another shape is unreadable', () => {
    const odd = report();
    (odd.suites[0] as { specs: { file: string }[] }).specs[0]!.file = `${NAME}.spec.ts`;
    const r = playwrightSummary(JSON.stringify(odd));
    if (r === 'unreadable') throw new Error('unreadable');
    expect(r.files.map((f) => f.file).sort()).toEqual(['e2e/orders.spec.ts', 'e2e/sub/x.spec.ts', 'file-1'].sort());
    expect(leaks(JSON.stringify(r))).toEqual([]);
    for (const bad of ['not json', '[]', '{}', JSON.stringify({ suites: [] }), JSON.stringify({ suites: 'x', stats: {} }), JSON.stringify(report({ stats: { expected: 'many' } })), JSON.stringify(report({ suites: [null] })), JSON.stringify(report({ suites: [{ specs: [{ tests: 'x' }] }] }))]) {
      expect([bad, playwrightSummary(bad)]).toEqual([bad, 'unreadable']);
    }
  });
});

describe('the volume scripts and what they print (lib/sandbox-volumes.ts)', () => {
  /** Runs a reader script under the host's `sh` with the volume paths moved into a temp dir (the way the fake docker does). */
  function run(vol: string, script: string, args: string[], stdin = ''): { code: number; stdout: string } {
    const map = (s: string) => s.replace(/\/outroot/g, `${vol}/outroot`).replace(/\/live/g, `${vol}/live`).replace(/\/outdirs/g, `${vol}/outdirs`);
    const r = Bun.spawnSync(['sh', '-c', map(script), 'sh', ...args.map(map)], { stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString().split(vol).join('') };
  }
  const volume = (): string => {
    const v = tmp('goodboy-m6a-vol-');
    for (const d of ['outroot', 'live', 'outdirs']) mkdirSync(join(v, d));
    return v;
  };
  const TS = '20261113T010101Z';

  test('every script names its kind in its first line (the fake docker and the tests key on it, not on its words)', () => {
    for (const [kind, script] of [['read', READ_SCRIPT], ['unit-after', UNIT_AFTER_SCRIPT], ['e2e-after', E2E_AFTER_SCRIPT], ['finish', FINISH_SCRIPT], ['list', LIST_SCRIPT]] as const) {
      expect([kind, script.split('\n')[0]]).toEqual([kind, `# goodboy-reader: ${kind}`]);
    }
  });

  test('read: a regular file comes back as text, an absent one, a link, a link in the path, a directory and a large file are said apart', () => {
    const v = volume();
    writeFileSync(join(v, 'live', 'access.log'), `line ${NAME}\nline two\n`);
    writeFileSync(join(v, 'live', 'big.log'), 'x'.repeat(100));
    mkdirSync(join(v, 'outroot', 'real'));
    writeFileSync(join(v, 'outroot', 'real', 'f.txt'), 'in a real dir');
    symlinkSync(join(v, 'outroot', 'real'), join(v, 'outroot', 'linked'));
    symlinkSync(join(v, 'live', 'access.log'), join(v, 'live', 'alias.log'));
    mkdirSync(join(v, 'live', 'adir'));
    const r = run(v, READ_SCRIPT, ['50', '1000', '/live/access.log', '/live/absent', '/live/alias.log', '/outroot/linked/f.txt', '/live/adir', '/live/big.log', '/outroot/real/f.txt']);
    expect(r.code).toBe(0);
    const frames = parseFrames(r.stdout)!;
    expect(frames.partial).toBe(false);
    expect(frames.files.get('/live/access.log')).toEqual({ kind: 'text', text: `line ${NAME}\nline two\n` });
    expect(frames.files.get('/live/absent')).toEqual({ kind: 'absent' });
    for (const p of ['/live/alias.log', '/outroot/linked/f.txt', '/live/adir', '/live/big.log']) expect([p, frames.files.get(p)]).toEqual([p, { kind: 'refused' }]);
    expect(frames.files.get('/outroot/real/f.txt')).toEqual({ kind: 'text', text: 'in a real dir' });
  });

  test('read: a file with Korean letters and no final newline survives the base64 framing, and an empty file is an empty text', () => {
    const v = volume();
    writeFileSync(join(v, 'live', 'f'), `${NAME} ${NAME_NFD}`);
    writeFileSync(join(v, 'live', 'empty'), '');
    const frames = parseFrames(run(v, READ_SCRIPT, ['1000', '2000', '/live/f', '/live/empty']).stdout)!;
    expect(frames.files.get('/live/f')).toEqual({ kind: 'text', text: `${NAME} ${NAME_NFD}` });
    expect(frames.files.get('/live/empty')).toEqual({ kind: 'text', text: '' });
  });

  test('read: a total budget stops the call before the file that would pass it, says so, and prints no more than the budget', () => {
    const v = volume();
    for (const n of ['a', 'b', 'c']) writeFileSync(join(v, 'live', n), `${n}`.repeat(60));
    const r = run(v, READ_SCRIPT, ['100', '130', '/live/a', '/live/b', '/live/c']);
    const frames = parseFrames(r.stdout)!;
    expect(frames.partial).toBe(true);
    expect([...frames.files.keys()]).toEqual(['/live/a', '/live/b']);
    expect(frames.files.get('/live/b')).toEqual({ kind: 'text', text: 'b'.repeat(60) });
    // 120 bytes of file in base64 and framing is below the host's capture cap for that budget
    expect(r.stdout.length).toBeLessThanOrEqual(frameBudget(130));
  });

  test('unit-after: stdin becomes output.log, the JUnit files are read sorted within the count and the budget, and a file over the cap is refused', () => {
    const v = volume();
    for (const d of ['tout_build_test_results/test', 'tout_target_surefire_reports']) mkdirSync(join(v, 'outdirs', d), { recursive: true });
    for (const [rel, text] of [['tout_build_test_results/test/TEST-b.xml', '<b/>'], ['tout_build_test_results/test/TEST-a.xml', '<a/>'], ['tout_build_test_results/test/other.xml', '<o/>'], ['tout_target_surefire_reports/TEST-c.xml', '<c/>']] as const) writeFileSync(join(v, 'outdirs', rel), text);
    symlinkSync(join(v, 'live'), join(v, 'outdirs', 'tout_build_test_results', 'TEST-link.xml'));
    writeFileSync(join(v, 'outdirs', 'tout_target_surefire_reports', 'TEST-big.xml'), 'y'.repeat(200));
    const all = run(v, UNIT_AFTER_SCRIPT, [TS, '100', '1000', '10'], `output ${NAME}\n`);
    expect(wroteLog(all.stdout)).toBe(true);
    expect(readFileSync(join(v, 'outroot', TS, 'output.log'), 'utf8')).toBe(`output ${NAME}\n`);
    const frames = parseFrames(all.stdout)!;
    expect([...frames.files.keys()].sort()).toEqual(['/outdirs/tout_build_test_results/test/TEST-a.xml', '/outdirs/tout_build_test_results/test/TEST-b.xml', '/outdirs/tout_target_surefire_reports/TEST-big.xml', '/outdirs/tout_target_surefire_reports/TEST-c.xml']);
    expect(frames.files.get('/outdirs/tout_target_surefire_reports/TEST-big.xml')).toEqual({ kind: 'refused' });
    expect(frames.files.get('/outdirs/tout_build_test_results/test/TEST-a.xml')).toEqual({ kind: 'text', text: '<a/>' });
    expect(parseFrames(run(v, UNIT_AFTER_SCRIPT, [TS, '100', '1000', '2'], 'x').stdout)!.files.size).toBe(2);
    // a budget of 5 bytes holds the first small file and then stops
    const tight = parseFrames(run(v, UNIT_AFTER_SCRIPT, [TS, '100', '5', '10'], 'x').stdout)!;
    expect(tight.partial).toBe(true);
    expect(tight.files.size).toBe(1);
  });

  test('unit-after: a link planted as output.log is replaced and never written through, a dir planted there fails the write and not the read', () => {
    const v = volume();
    const victim = join(v, 'victim.txt');
    writeFileSync(victim, 'VICTIM');
    mkdirSync(join(v, 'outroot', TS));
    mkdirSync(join(v, 'outdirs', 'tout_build_test_results'), { recursive: true });
    writeFileSync(join(v, 'outdirs', 'tout_build_test_results', 'TEST-a.xml'), '<a/>');
    symlinkSync(victim, join(v, 'outroot', TS, 'output.log'));
    const ok = run(v, UNIT_AFTER_SCRIPT, [TS, '100', '1000', '10'], 'text');
    expect(wroteLog(ok.stdout)).toBe(true);
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM');
    expect(lstatSync(join(v, 'outroot', TS, 'output.log')).isFile()).toBe(true);
    rmSync(join(v, 'outroot', TS, 'output.log'));
    mkdirSync(join(v, 'outroot', TS, 'output.log'));
    const bad = run(v, UNIT_AFTER_SCRIPT, [TS, '100', '1000', '10'], 'x');
    expect(wroteLog(bad.stdout)).toBe(false);
    expect(parseFrames(bad.stdout)!.files.size).toBe(1);
  });

  test('e2e-after: the log, the report and the access log in one call; the traces are looked up and, with rm, removed in the same call', () => {
    const v = volume();
    mkdirSync(join(v, 'outroot', TS, 'e2e-artifacts'), { recursive: true });
    writeFileSync(join(v, 'outroot', TS, 'playwright-report.json'), '{"suites":[]}');
    writeFileSync(join(v, 'live', 'access.log'), 'GET /\n');
    const keep = run(v, E2E_AFTER_SCRIPT, [TS, '1000', '5000', 'keep'], `e2e out ${NAME}`);
    expect(wroteLog(keep.stdout)).toBe(true);
    expect(parseNames(keep.stdout, '@@P')).toEqual(['present']);
    const frames = parseFrames(keep.stdout)!;
    expect(frames.files.get(`/outroot/${TS}/playwright-report.json`)).toEqual({ kind: 'text', text: '{"suites":[]}' });
    expect(frames.files.get('/live/access.log')).toEqual({ kind: 'text', text: 'GET /\n' });
    expect(existsSync(join(v, 'outroot', TS, 'e2e-artifacts'))).toBe(true);
    const gone = run(v, E2E_AFTER_SCRIPT, [TS, '1000', '5000', 'rm'], 'x');
    expect(parseNames(gone.stdout, '@@P')).toEqual(['present']);
    expect(existsSync(join(v, 'outroot', TS, 'e2e-artifacts'))).toBe(false);
    expect(parseNames(run(v, E2E_AFTER_SCRIPT, [TS, '1000', '5000', 'rm'], 'x').stdout, '@@P')).toEqual([]);
    // a budget that holds one of the two files: the second is not printed and the call says so
    const tight = parseFrames(run(v, E2E_AFTER_SCRIPT, [TS, '1000', '14', 'keep'], 'x').stdout)!;
    expect(tight.partial).toBe(true);
    expect(tight.files.has(`/outroot/${TS}/playwright-report.json`)).toBe(true);
    expect(tight.files.has('/live/access.log')).toBe(false);
  });

  test('list and finish: names only, nothing outside the runs volume is touched, a name with .. is skipped, clear empties the scratch volumes', () => {
    const v = volume();
    mkdirSync(join(v, 'outroot', TS), { recursive: true });
    mkdirSync(join(v, 'outroot', '.hidden'));
    writeFileSync(join(v, 'outroot', 'stray file'), 'x');
    writeFileSync(join(v, 'live', 'keep.txt'), 'keep');
    mkdirSync(join(v, 'live', 'v8-e2e'));
    writeFileSync(join(v, 'live', 'jacoco-e2e.exec'), 'x');
    writeFileSync(join(v, 'live', 'access.log'), 'rows');
    mkdirSync(join(v, 'outdirs', 'tout_build_test_results', 'test'), { recursive: true });
    writeFileSync(join(v, 'outdirs', 'tout_build_test_results', 'test', 'TEST-a.xml'), '<a/>');
    writeFileSync(join(v, 'outdirs', 'tout_build_test_results', '.hidden'), 'h');
    expect(parseNames(run(v, LIST_SCRIPT, []).stdout, '@@E')!.sort()).toEqual(['.hidden', TS, 'stray file']);
    const keep = run(v, FINISH_SCRIPT, ['keep', '../live/keep.txt', '/live/keep.txt', '', '.hidden', 'stray file']);
    expect(keep.stdout).toContain('@@END');
    expect(existsSync(join(v, 'outroot', '.hidden'))).toBe(false);
    expect(existsSync(join(v, 'outroot', 'stray file'))).toBe(false);
    expect(existsSync(join(v, 'outroot', TS))).toBe(true);
    expect(readFileSync(join(v, 'live', 'keep.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(join(v, 'live', 'access.log'), 'utf8')).toBe('rows');
    expect(run(v, FINISH_SCRIPT, ['clear', TS]).stdout).toContain('@@END');
    expect(existsSync(join(v, 'outroot', TS))).toBe(false);
    expect(existsSync(join(v, 'live', 'v8-e2e'))).toBe(false);
    expect(existsSync(join(v, 'live', 'jacoco-e2e.exec'))).toBe(false);
    expect(readFileSync(join(v, 'live', 'access.log'), 'utf8')).toBe(''); // truncated, not removed: the proxy keeps it open
    expect(existsSync(join(v, 'outdirs', 'tout_build_test_results'))).toBe(true);
    expect(existsSync(join(v, 'outdirs', 'tout_build_test_results', 'test'))).toBe(false);
    expect(existsSync(join(v, 'outdirs', 'tout_build_test_results', '.hidden'))).toBe(false);
    // a log that became a link is dropped: the truncation must not write through it
    const victim = join(v, 'victim.txt');
    writeFileSync(victim, 'VICTIM');
    rmSync(join(v, 'live', 'access.log'));
    symlinkSync(victim, join(v, 'live', 'access.log'));
    run(v, FINISH_SCRIPT, ['clear']);
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM');
    expect(existsSync(join(v, 'live', 'access.log'))).toBe(false);
  });

  test('finish: a step that fails leaves out the end mark, so the host sees the failure', () => {
    const v = volume();
    // a dir that cannot be removed: a read-only parent
    mkdirSync(join(v, 'outroot', 'locked'));
    writeFileSync(join(v, 'outroot', 'locked', 'f'), 'x');
    Bun.spawnSync(['chmod', '555', join(v, 'outroot', 'locked')]);
    const r = run(v, FINISH_SCRIPT, ['keep', 'locked']);
    Bun.spawnSync(['chmod', '755', join(v, 'outroot', 'locked')]);
    if (process.getuid?.() !== 0) expect(r.stdout).not.toContain('@@END');
  });

  test('parseFrames and parseNames: no end mark (a failed or cut-off run) is null, a bad data line is refused, text is read as UTF-8', () => {
    expect(parseFrames('@@F /a\nQUJD\n')).toBeNull();
    expect(parseFrames('')).toBeNull();
    expect(parseNames('@@E x\n', '@@E')).toBeNull();
    expect(parseFrames('@@F /a\nQUJD\n@@F /b\nnot base64!\n@@F /c\n@@A /d\n@@R /e\n@@PARTIAL\n@@END\n')).toEqual({
      partial: true,
      files: new Map([
        ['/a', { kind: 'text', text: 'ABC' }],
        ['/b', { kind: 'refused' }],
        ['/c', { kind: 'refused' }],
        ['/d', { kind: 'absent' }],
        ['/e', { kind: 'refused' }],
      ]),
    });
    expect(parseFrames(`@@F /k\n${Buffer.from(NAME).toString('base64')}\n@@END\n`)!.files.get('/k')).toEqual({ kind: 'text', text: NAME });
    expect(parseNames('@@E a\n@@E b c\n@@P x\n@@PARTIAL\n@@END\n', '@@E')).toEqual(['a', 'b c']);
    expect(wroteLog('@@W ok\n@@END\n')).toBe(true);
    expect(wroteLog('@@W fail\n@@END\n')).toBe(false);
  });

  test('the layout: one volume per output dir over /work, the same ones side by side in the reader, and the marker names the volume', () => {
    expect(OUTPUT_DIRS).toEqual(['build/test-results', 'build/reports', 'target/surefire-reports', 'target/failsafe-reports', 'test-results', 'playwright-report']);
    expect(outDirVolume('build/test-results')).toBe('tout_build_test_results');
    expect(outDirMounts()).toContain('tout_build_test_results:/work/build/test-results');
    expect(readerMounts()).toContain('tout_build_test_results:/outdirs/tout_build_test_results');
    expect(volumeNames()).toEqual(['runout', 'live', 'meta', 'data', ...OUTPUT_DIRS.map(outDirVolume)]);
    expect(volumeMarker('20261113T010101Z', 'playwright-report.json')).toBe('volume:runout/20261113T010101Z/playwright-report.json');
    expect(MAX_JUNIT_BYTES).toBe(2 * 1024 * 1024);
  });

  test('modules: the test command names them (Gradle task paths, Maven -pl, --project-dir), and their JVM dirs get a volume of their own', () => {
    expect(moduleDirs(['./gradlew', ':app:test', '--offline'])).toEqual(['app']);
    expect(moduleDirs(['./gradlew', ':services:billing:integrationTest', ':web:test'])).toEqual(['services/billing', 'web']);
    expect(moduleDirs(['mvn', '-o', '-pl', 'api,core', '-am', 'test'])).toEqual(['api', 'core']);
    expect(moduleDirs(['mvn', '--projects', 'api', 'test'])).toEqual(['api']);
    expect(moduleDirs(['gradle', '--project-dir', 'backend', 'test'])).toEqual(['backend']);
    expect(moduleDirs(['gradle', '-p', 'backend', 'test'])).toEqual(['backend']);
    expect(moduleDirs(['gradle', '--project-dir=backend/app', 'test'])).toEqual(['backend/app']);
    // no module: the root task, an artifactId, an exclusion, an absolute or climbing path, a repeat
    for (const none of [['./gradlew', 'test'], ['./gradlew', ':test'], ['mvn', '-pl', ':artifact-id', 'test'], ['mvn', '-pl', '!web', 'test'], ['gradle', '-p', '/etc', 'test'], ['gradle', '-p', '../x', 'test'], ['gradle', '-p', 'a b', 'test'], ['npm', 'test']]) expect([none, moduleDirs(none)]).toEqual([none, []]);
    expect(moduleDirs([':app:test', ':app:check', '-pl', 'app'])).toEqual(['app']);
    expect(moduleDirs(Array.from({ length: 20 }, (_, i) => `:m${i}:test`))).toHaveLength(8);
    const dirs = outputDirsFor(['./gradlew', ':app:test']);
    expect(dirs).toEqual([...OUTPUT_DIRS, 'app/build/test-results', 'app/build/reports', 'app/target/surefire-reports', 'app/target/failsafe-reports']);
    const vols = dirs.map(outDirVolume);
    expect(new Set(vols).size).toBe(vols.length);
    expect(outDirVolume('app/build/test-results')).toMatch(/^tout_app_build_test_results_[0-9a-f]{6}$/);
    // two paths that differ only in a separator do not share a volume
    expect(outDirVolume('a/b/build/test-results')).not.toBe(outDirVolume('a_b/build/test-results'));
    expect(outDirMounts(dirs)).toContain(`${outDirVolume('app/build/test-results')}:/work/app/build/test-results`);
    expect(readerMounts(dirs)).toContain(`${outDirVolume('app/build/test-results')}:/outdirs/${outDirVolume('app/build/test-results')}`);
    expect(volumeNames(dirs)).toContain(outDirVolume('app/target/failsafe-reports'));
  });
});

describe('expiry (lib/sandbox-expiry.ts)', () => {
  const H = 3_600_000;
  const NOW = Date.parse('2026-11-13T12:00:00Z');
  const name = (msAgo: number): string => new Date(NOW - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

  test('the TTL is 24 h, the environment can only lower it, and anything that is not a positive number is 24 h', () => {
    expect(rawTtlMs({})).toBe(24 * H);
    expect(rawTtlMs({ GOODBOY_SANDBOX_RAW_TTL_HOURS: '6' })).toBe(6 * H);
    expect(rawTtlMs({ GOODBOY_SANDBOX_RAW_TTL_HOURS: '0.5' })).toBe(0.5 * H);
    for (const raised of ['25', '48', '1e9', 'Infinity']) expect([raised, rawTtlMs({ GOODBOY_SANDBOX_RAW_TTL_HOURS: raised })]).toEqual([raised, 24 * H]);
    for (const junk of ['', ' ', '0', '-3', 'soon', 'NaN']) expect([junk, rawTtlMs({ GOODBOY_SANDBOX_RAW_TTL_HOURS: junk })]).toEqual([junk, 24 * H]);
  });

  test('a passed run goes at once; a failed or crashed one when its start is older than the TTL; one with no state by its name; foreign names always', () => {
    const states = new Map<string, ReturnType<typeof parseState>>();
    const set = (n: string, status: 'running' | 'passed' | 'failed', msAgo: number) => states.set(n, { status, started: iso(msAgo) });
    const passed = name(1000);
    const failedFresh = name(2 * H);
    const failedOld = name(25 * H);
    const crashedFresh = name(1 * H);
    const crashedOld = name(30 * H);
    const noStateFresh = name(3 * H);
    const noStateOld = name(26 * H);
    const brokenStart = name(2 * H + 5000);
    set(passed, 'passed', 1000);
    set(failedFresh, 'failed', 2 * H);
    set(failedOld, 'failed', 25 * H);
    set(crashedFresh, 'running', 1 * H);
    set(crashedOld, 'running', 30 * H);
    states.set(brokenStart, { status: 'failed', started: 'not a time' });
    const names = [passed, failedFresh, failedOld, crashedFresh, crashedOld, noStateFresh, noStateOld, brokenStart, 'junk', '.hidden'];
    const v = sweepVictims(names, (n) => states.get(n) ?? null, NOW, 24 * H);
    expect(v.sort()).toEqual([passed, failedOld, crashedOld, noStateOld, brokenStart, 'junk', '.hidden'].sort());
    // a lowered TTL takes the fresh failures too; an unlowered default does not
    const lowered = sweepVictims(names, (n) => states.get(n) ?? null, NOW, 0.5 * H);
    expect(lowered).toContain(failedFresh);
    expect(lowered).toContain(crashedFresh);
    expect(lowered).toContain(noStateFresh);
    expect(sweepVictims([failedFresh], (n) => states.get(n) ?? null, NOW, rawTtlMs({ GOODBOY_SANDBOX_RAW_TTL_HOURS: '99' }))).toEqual([]);
  });

  test('a start time that is in the future, or edited to be, does not defeat the TTL: the run name is a second clock and the older time counts', () => {
    const old = name(30 * H);
    // `started` 400 days ahead: the name's time decides, so the run is long expired
    expect(sweepVictims([old], () => ({ status: 'failed', started: new Date(NOW + 400 * 24 * H).toISOString() }), NOW, 24 * H)).toEqual([old]);
    expect(sweepVictims([old], () => ({ status: 'running', started: new Date(NOW + 1000).toISOString() }), NOW, 24 * H)).toEqual([old]);
    // `started` older than the name says: the older one counts (the name was made at the start, the file can lag or be edited)
    const young = name(1 * H);
    expect(sweepVictims([young], () => ({ status: 'failed', started: iso(30 * H) }), NOW, 24 * H)).toEqual([young]);
    // `started` a little younger than the name does not make the run younger
    expect(runStartedAt(old, { status: 'failed', started: iso(2 * H) }, NOW)).toBe(Date.parse('2026-11-12T06:00:00Z'));
    // a name in the future (a clock moved back, or a made-up name) is expired; an hour of slack is allowed
    const future = new Date(NOW + 5 * H).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    expect(sweepVictims([future], () => null, NOW, 24 * H)).toEqual([future]);
    const soon = new Date(NOW + 10 * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    expect(sweepVictims([soon], () => null, NOW, 24 * H)).toEqual([]);
  });

  test('a run in progress is a running state that has not expired; nothing else is', () => {
    const live = name(1 * H);
    expect(isLiveRun(live, { status: 'running', started: iso(1 * H) }, NOW, 24 * H)).toBe(true);
    expect(isLiveRun(live, { status: 'failed', started: iso(1 * H) }, NOW, 24 * H)).toBe(false);
    expect(isLiveRun(live, null, NOW, 24 * H)).toBe(false);
    expect(isLiveRun(name(30 * H), { status: 'running', started: iso(30 * H) }, NOW, 24 * H)).toBe(false);
    expect(isLiveRun('junk', { status: 'running', started: iso(1 * H) }, NOW, 24 * H)).toBe(false);
  });

  test('a state file is read only when it is one goodboy wrote, and its text is never echoed', () => {
    expect(parseState(JSON.stringify({ status: 'passed', started: '2026-01-01T00:00:00Z', finished: '2026-01-01T00:01:00Z' }))).toEqual({ status: 'passed', started: '2026-01-01T00:00:00Z', finished: '2026-01-01T00:01:00Z' });
    expect(parseState(JSON.stringify({ status: 'running', started: 'x' }))).toEqual({ status: 'running', started: 'x' });
    for (const bad of ['', 'not json', '[]', 'null', JSON.stringify({ status: 'done', started: 'x' }), JSON.stringify({ status: 'passed' }), JSON.stringify({ status: 'passed', started: 1 }), JSON.stringify({ status: 'passed', started: 'x', finished: 3 })]) {
      expect([bad, parseState(bad)]).toEqual([bad, null]);
    }
  });
});

describe('the ui-check verdict without titles (lib/ui-check.ts)', () => {
  const INVENTORY: UiInventory = {
    root: '.',
    contextPath: '/',
    notes: [],
    items: [{ id: 'screen:GET:/orders', kind: 'screen', method: 'GET', route: '/orders', file: 'a.html', line: 1, input: false, label: 'orders' }],
  };
  const log = `${JSON.stringify({ request: { method: 'GET', uri: `/orders?q=${NAME}`, headers: { 'x-goodboy-ui': 'screen:GET:/orders:ok', 'x-goodboy-test': 'abcdef0123456789', accept: 'text/html' } }, status: 200 })}\n`;
  const rep = (title: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      suites: [{ title: 'o.spec.ts', file: 'o.spec.ts', specs: [{ title, file: 'o.spec.ts', tests: [{ status: 'expected', expectedStatus: 'passed', annotations: [{ type: 'goodboy-ui', description: 'screen:GET:/orders:ok' }, { type: 'goodboy-test', description: 'abcdef0123456789' }, ...((over.extra as unknown[]) ?? [])], results: [{ status: 'passed' }] }] }] }],
    });

  test('a spec id is stable and holds no part of the title', () => {
    const a = specId('o.spec.ts', `o.spec.ts > shows ${NAME}`);
    expect(a).toMatch(/^spec-[0-9a-f]{12}$/);
    expect(specId('o.spec.ts', `o.spec.ts > shows ${NAME}`)).toBe(a);
    expect(specId('p.spec.ts', `o.spec.ts > shows ${NAME}`)).not.toBe(a);
    expect(a).not.toContain(NAME);
  });

  test('with redactTitles a problem names the test by id; without it, as before', () => {
    const bad = rep(`shows ${NAME}`, { extra: [{ type: 'goodboy-test', description: 'other0123456789' }] }); // two nonces
    const plain: string[] = [];
    parseReport(bad, 'Playwright report', plain);
    expect(plain.join('\n')).toContain(`"o.spec.ts > shows ${NAME}"`);
    const red: string[] = [];
    parseReport(bad, 'Playwright report', red, true);
    expect(red).toEqual([expect.stringMatching(/^Playwright report: spec-[0-9a-f]{12} has several goodboy-test nonces$/)]);
    expect(leaks(red.join('\n'))).toEqual([]);
    // the same through uiCheck: a passing test with claims and no nonce
    const noNonce = JSON.stringify({ suites: [{ title: 's', file: 's.spec.ts', specs: [{ title: `t ${RRN}`, tests: [{ status: 'expected', expectedStatus: 'passed', annotations: [{ type: 'goodboy-ui', description: 'screen:GET:/orders:ok' }], results: [{ status: 'passed' }] }] }] }] });
    expect(uiCheck(INVENTORY, [log], [noNonce]).problems.join('\n')).toContain(RRN);
    const hidden = uiCheck(INVENTORY, [log], [noNonce], { redactTitles: true });
    expect(leaks(hidden.problems.join('\n'))).toEqual([]);
    expect(hidden.problems[0]).toMatch(/^spec-[0-9a-f]{12} passed with ui claims but has no goodboy-test nonce/);
  });

  test('the stored verdict keeps counts and inventory ids, reduces unknown claims to a count, and is read back only when it is well formed', () => {
    const r = uiCheck(INVENTORY, [log], [rep(`shows ${NAME}`)], { redactTitles: true });
    expect(r.ok).toBe(true);
    const stored = storedUiCheck('20261113T010101Z', { ...r, unknown_claims: [`ghost:${RRN}:ok`, 'other:ok'] });
    expect(stored).toEqual({ schema: 1, run: '20261113T010101Z', ok: true, items: 1, covered: 1, gaps: [], unknown_claims: 2, problems: [] });
    expect(leaks(JSON.stringify(stored))).toEqual([]);
    expect(parseStoredUiCheck(JSON.stringify(stored))).toEqual(stored);
    expect(parseStoredUiCheck(JSON.stringify({ ...stored, gaps: [{ id: 'a', missing: ['ok'] }] }))!.gaps).toEqual([{ id: 'a', missing: ['ok'] }]);
    for (const bad of ['', 'x', '[]', JSON.stringify({ ...stored, schema: 2 }), JSON.stringify({ ...stored, ok: 'yes' }), JSON.stringify({ ...stored, items: -1 }), JSON.stringify({ ...stored, unknown_claims: ['a'] }), JSON.stringify({ ...stored, problems: [1] }), JSON.stringify({ ...stored, gaps: [{ id: 'a', missing: ['bogus'] }] }), JSON.stringify({ ...stored, gaps: [1] })]) {
      expect([bad, parseStoredUiCheck(bad)]).toEqual([bad, null]);
    }
  });

  function runDir(root: string, ts: string, files: Record<string, string>): string {
    const d = join(root, SANDBOX_DIR, 'out', ts);
    mkdirSync(d, { recursive: true });
    for (const [n, t] of Object.entries(files)) writeFileSync(join(d, n), t);
    return d;
  }
  const verdict = (ok: boolean) => JSON.stringify(storedUiCheck('20261113T010101Z', { ok, items: 2, covered: ok ? 2 : 1, gaps: ok ? [] : [{ id: 'screen:GET:/x', missing: ['ok'] }], unknown_claims: [], problems: [] }));

  test('in a sandbox with real data ui-check prints the stored verdict of the run, and refuses files, a report, an inventory and a missing verdict without echoing them', () => {
    const root = tmp();
    mkdirSync(join(root, SANDBOX_DIR), { recursive: true });
    writeFileSync(join(root, SANDBOX_DIR, 'local.json'), JSON.stringify({ dump: null, dumpFormat: null, realData: true }));
    runDir(root, '20261113T010101Z', { [STORED_FILE]: verdict(false) });
    runDir(root, '20261113T020202Z', { [STORED_FILE]: verdict(true) });
    runDir(root, '20261113T030303Z', { 'result.json': '{}' });
    const newest = cmdUiCheck(root, []);
    expect('out' in newest && newest.code).toBe(0); // the newest run with a verdict is the second one
    expect('out' in newest && (newest.out as { run: string; stored: boolean }).run).toBe(join(root, SANDBOX_DIR, 'out', '20261113T020202Z'));
    const first = cmdUiCheck(root, ['--run', '20261113T010101Z']);
    expect('out' in first && first.code).toBe(1);
    expect('out' in first && (first.out as { gaps: unknown[]; stored: boolean }).gaps).toEqual([{ id: 'screen:GET:/x', missing: ['ok'] }]);
    for (const args of [['--log', `/tmp/${NAME}.log`], ['--report', `/tmp/${RRN}.json`], ['--inventory', `/tmp/${MAIL}.json`]]) {
      const r = cmdUiCheck(root, args);
      expect('error' in r && r.error).toContain('real data');
      expect(leaks(JSON.stringify(r))).toEqual([]);
    }
    // the raw files of an old run are not read in this mode, even when they are there
    runDir(root, '20261113T040404Z', { 'access.log': log, 'playwright-report.json': rep('x') });
    const raw = cmdUiCheck(root, ['--run', '20261113T040404Z']);
    expect('error' in raw && raw.error).toContain('has no stored verdict');
    const none = cmdUiCheck(root, ['--run', '20261113T030303Z']);
    expect('error' in none && none.error).toContain('has no stored verdict');
    runDir(root, '20261113T050505Z', { [STORED_FILE]: `broken ${NAME}` });
    const broken = cmdUiCheck(root, ['--run', '20261113T050505Z']);
    expect('error' in broken && broken.error).toContain('is not a verdict goodboy wrote');
    expect(leaks(JSON.stringify(broken))).toEqual([]);
  });

  test('with no local.json (it goes with git clean), raw host files that may have held real data make it real data; a run that says it was plain, or has no result, does not', () => {
    const root = tmp();
    const raw = { 'access.log': log, 'playwright-report.json': rep('shows it') };
    const inv = join(root, 'inv.json');
    writeFileSync(inv, JSON.stringify(INVENTORY));
    runDir(root, '20261113T010101Z', raw);
    // no result.json: nothing says a real run was here (a run that stopped at once, a hand-made dir)
    expect(realDataForReading(root)).toBe(false);
    expect('out' in cmdUiCheck(root, ['--run', '20261113T010101Z', '--inventory', inv])).toBe(true);
    // a run that says it was plain
    runDir(root, '20261113T020202Z', { ...raw, 'result.json': JSON.stringify({ ts: '20261113T020202Z', realData: false }) });
    expect(realDataForReading(root)).toBe(false);
    // a result from before M6a has no flag: such a run may have been real
    runDir(root, '20261113T030303Z', { ...raw, 'result.json': JSON.stringify({ ts: '20261113T030303Z' }) });
    expect(realDataForReading(root)).toBe(true);
    const r = cmdUiCheck(root, ['--run', '20261113T010101Z']);
    expect('error' in r && r.error).toContain('has no stored verdict');
    const files = cmdUiCheck(root, ['--log', join(root, '.goodboy', 'sandbox', 'out', '20261113T020202Z', 'access.log')]);
    expect('error' in files && files.error).toContain('real data');
    // a result that is not JSON, a real run, and the old out/live dir count too; with local.json present the file decides
    const a = tmp();
    runDir(a, '20261113T010101Z', { 'result.json': `not json ${NAME}` });
    expect(realDataForReading(a)).toBe(true);
    const b = tmp();
    runDir(b, '20261113T010101Z', { 'result.json': JSON.stringify({ realData: true }) });
    expect(realDataForReading(b)).toBe(true);
    const c = tmp();
    mkdirSync(join(c, SANDBOX_DIR, 'out', 'live'), { recursive: true });
    expect(realDataForReading(c)).toBe(true);
    writeFileSync(join(c, SANDBOX_DIR, 'local.json'), JSON.stringify({ dump: null, dumpFormat: null }));
    expect(realDataForReading(c)).toBe(false);
    expect(realDataForReading(tmp())).toBe(false);
  });

  test('a local file that cannot be read counts as real data (fail closed)', () => {
    const root = tmp();
    mkdirSync(join(root, SANDBOX_DIR), { recursive: true });
    writeFileSync(join(root, SANDBOX_DIR, 'local.json'), `{ not json ${NAME}`);
    const r = cmdUiCheck(root, ['--log', 'a.log']);
    expect('error' in r && r.error).toContain('real data');
    expect(leaks(JSON.stringify(r))).toEqual([]);
  });

  test('without real data the raw files are read as before; a run with only a stored verdict prints it', () => {
    const root = tmp();
    const inv = join(root, 'inv.json');
    writeFileSync(inv, JSON.stringify(INVENTORY));
    runDir(root, '20261113T010101Z', { 'access.log': log, 'playwright-report.json': rep(`shows ${NAME}`), [STORED_FILE]: verdict(false) });
    const raw = cmdUiCheck(root, ['--run', '20261113T010101Z', '--inventory', inv]);
    // judged from the raw files again (the stored verdict says failed; the files say covered)
    expect('out' in raw && raw.code).toBe(0);
    runDir(root, '20261113T020202Z', { [STORED_FILE]: verdict(true) });
    const stored = cmdUiCheck(root, ['--run', '20261113T020202Z']);
    expect('out' in stored && stored.code).toBe(0);
    expect('out' in stored && (stored.out as { stored: boolean }).stored).toBe(true);
    runDir(root, '20261113T030303Z', {});
    const none = cmdUiCheck(root, ['--run', '20261113T030303Z']);
    expect('error' in none && none.error).toContain('does not exist');
  });
});

describe('the real-data flag in local.json', () => {
  test('a flag that is not a boolean is a file goodboy did not write; a flag with no dump is read as real data', () => {
    const root = tmp();
    mkdirSync(join(root, SANDBOX_DIR), { recursive: true });
    const put = (j: unknown) => writeFileSync(join(root, SANDBOX_DIR, 'local.json'), JSON.stringify(j));
    put({ dump: null, dumpFormat: null, realData: 'yes' });
    expect(readLocal(root)).toBeInstanceOf(Error);
    expect(((readLocal(root) as Error).message)).not.toContain('yes');
    put({ dump: null, dumpFormat: null, realData: true });
    expect(readLocal(root)).toEqual({ dump: null, dumpFormat: null, realData: true });
    put({ dump: null, dumpFormat: null });
    expect(readLocal(root)).toEqual({ dump: null, dumpFormat: null, realData: false });
  });

  test('sandbox-local --dump sets it, and removing the dump from the file keeps it', () => {
    const home = tmp('goodboy-m6a-home-');
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const root = join(home, 'repo');
      mkdirSync(root);
      const dump = join(home, 'shop.sql');
      writeFileSync(dump, 'select 1;');
      const w = writeLocal(root, dump, null);
      if (w instanceof Error) throw w;
      expect(w.local).toEqual({ dump, dumpFormat: 'sql', realData: true });
      expect(JSON.parse(readFileSync(join(root, SANDBOX_DIR, 'local.json'), 'utf8')).realData).toBe(true);
      // the dump is removed from the file: the real data are still in the database volume
      writeFileSync(join(root, SANDBOX_DIR, 'local.json'), JSON.stringify({ dump: null, dumpFormat: null, realData: true }));
      expect(realDataOf(readLocal(root) as { dump: null; dumpFormat: null }) ).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  });
});

describe('the compose file keeps raw artifacts out of the checkout', () => {
  const plan = () => planSandbox(plainScan(), { dump: null, dumpFormat: null }, { readConfig: () => null });
  const compose = (): { services: Record<string, { volumes?: string[]; networks?: string[] | Record<string, unknown>; profiles?: string[]; image?: string; environment?: Record<string, string> }>; volumes: Record<string, unknown> } => Bun.YAML.parse(plan().files.get('compose.yml')!) as never;

  test('/live and the run dir are named volumes, the output dirs have a volume over their place in /work, and nothing binds out/', () => {
    const c = compose();
    for (const v of volumeNames()) expect([v, Object.keys(c.volumes).includes(v)]).toEqual([v, true]);
    expect(c.services.app!.volumes).toContain('live:/live');
    expect(c.services.proxy!.volumes).toContain('live:/live');
    for (const svc of ['runner', 'e2e']) {
      expect(c.services[svc]!.volumes).toEqual(expect.arrayContaining(['runout:/outroot', ...outDirMounts()]));
    }
    expect(c.services.runner!.volumes).toContain('live:/live');
    const all = JSON.stringify(c.services);
    expect(all).not.toContain('./out');
    expect(all).not.toContain(':/out:');
    expect(all).not.toContain(':/out"');
  });

  test('the reader is a pinned busybox with no network and no bind, only the volumes; the static check lets `network_mode: none` through and nothing else', () => {
    const c = compose() as ReturnType<typeof compose> & { services: Record<string, { network_mode?: string }> };
    const reader = c.services.reader!;
    expect(reader.image).toMatch(/^busybox:\d+\.\d+$/);
    expect(reader.profiles).toEqual(['tools']);
    expect(reader.volumes).toEqual(['runout:/outroot', 'live:/live', 'meta:/meta', 'data:/goodboy-data', ...readerMounts()]);
    expect(reader.network_mode).toBe('none');
    expect(reader.networks).toBeUndefined();
    const inner = { inner: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' } } };
    expect(staticProblems({ services: { reader: { network_mode: 'none', volumes: ['runout:/outroot'] } }, networks: inner })).toEqual([]);
    expect(staticProblems({ services: { x: { network_mode: 'host' } }, networks: inner })).toEqual(['service x sets network_mode host', 'service x is on network default, which is not internal']);
    expect(staticProblems({ services: { x: { network_mode: 'bridge' } }, networks: inner })[0]).toContain('sets network_mode bridge');
    // `none` is for the reader alone: another service with it is refused
    expect(staticProblems({ services: { x: { network_mode: 'none' } }, networks: inner })).toEqual(['service x sets network_mode none', 'service x is on network default, which is not internal']);
    const nets = (s: { networks?: string[] | Record<string, unknown> }) => (Array.isArray(s.networks) ? s.networks : Object.keys(s.networks ?? {}));
    const cfg = { services: Object.fromEntries(Object.entries(c.services).map(([n, s]) => [n, { ...s, networks: Object.fromEntries(nets(s).map((x) => [x, {}])) }])), networks: { inner: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' } }, prep: {} } };
    expect(staticProblems(cfg, '/work/repo')).toEqual([]);
  });

  test('a test command that names a module gives the runner, the e2e service and the reader the volumes of the module\'s output dirs too', () => {
    const scan = plainScan();
    scan.build.testCommand = ['./gradlew', ':app:test', '--offline'];
    const c = Bun.YAML.parse(planSandbox(scan, { dump: null, dumpFormat: null }, { readConfig: () => null }).files.get('compose.yml')!) as ReturnType<typeof compose>;
    const dirs = outputDirsFor(scan.build.testCommand);
    for (const v of volumeNames(dirs)) expect([v, Object.keys(c.volumes).includes(v)]).toEqual([v, true]);
    for (const svc of ['runner', 'e2e']) expect(c.services[svc]!.volumes).toEqual(expect.arrayContaining(outDirMounts(dirs)));
    expect(c.services.runner!.volumes).toContain(`${outDirVolume('app/build/test-results')}:/work/app/build/test-results`);
    expect(c.services.reader!.volumes).toEqual(['runout:/outroot', 'live:/live', 'meta:/meta', 'data:/goodboy-data', ...readerMounts(dirs)]);
    // the plain project has only the root's dirs
    expect(Object.keys(compose().volumes).filter((v) => v.startsWith('tout_'))).toHaveLength(OUTPUT_DIRS.length);
  });

  test('the runner entrypoint links /out to the run dir when GOODBOY_OUT is set, before it runs the command', () => {
    for (const stack of ['jvm', 'node'] as const) {
      const e = entrypoint(stack, '17');
      expect(e).toContain('ln -sfn "$GOODBOY_OUT" /out');
      expect(e.indexOf('GOODBOY_OUT')).toBeLessThan(e.lastIndexOf('exec "$@"'));
      const r = Bun.spawnSync(['sh', '-n'], { stdin: new TextEncoder().encode(e), stdout: 'pipe', stderr: 'pipe' });
      expect(r.stderr.toString()).toBe('');
    }
  });

  test('the Playwright config writes its artifacts and report into GOODBOY_OUT', () => {
    const c = playwrightConfig();
    expect(c).toContain("process.env.GOODBOY_OUT ?? '/tmp/goodboy-out'");
    expect(c).not.toContain("'/out/");
  });
});

describe('the proof of a run never echoes what it was given', () => {
  test('a run name that is wrong says what a run name looks like and nothing of the value', () => {
    for (const bad of [NAME, `../${RRN}`, MAIL, '']) {
      const r = readRunResult('/nonexistent', bad);
      expect(r).toBeInstanceOf(Error);
      expect((r as Error).message).toContain('directory name');
      expect(leaks((r as Error).message)).toEqual([]);
      expect((r as Error).message).not.toContain(bad || 'zz-never');
    }
  });
});
