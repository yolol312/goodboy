// Track M, M6a (plan §19): the output boundary of the sandbox commands, with a fake docker that
// prints canary strings on every channel: the suites' output, the restore and docker errors, the
// app's log, the proxy's access log, Playwright titles and annotations, JUnit case names and
// failure text. In a sandbox that holds real data no canary may appear in what a command prints,
// in result.json, ui-check.json, state.json or any file under `.goodboy/sandbox/out/`; without
// real data the old output stays. Also: the counts of a run, the raw artifacts that live in the
// volumes and expire, the real-data flag, and the proof fields of result.json.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESTORE_TAG } from '../lib/sandbox-parts';
import { e2ePassed, readRunResult } from '../lib/sandbox-proof';
import { SANDBOX_DIR } from '../lib/sandbox-mode';
import { type Ctx, loadCtx } from '../lib/sandbox-run';
import { cleanupFakeProjects, type FakeProject, fakeProject, filesUnder } from './m6a-project';

setDefaultTimeout(120_000);
afterEach(cleanupFakeProjects);

const NAME = '김민수';
const NAME_NFD = NAME.normalize('NFD');
const RRN = '900101-1234567';
const MAIL = 'minsu.kim@canary-corp.example';
const CANARIES = [NAME, NAME_NFD, RRN, MAIL, 'canary-corp'];
const CANARY_TEXT = [NAME, NAME_NFD, RRN, MAIL].join(' | ');
const leaks = (text: string): string[] => CANARIES.filter((c) => text.includes(c));

const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const PLAIN = { dump: null, dumpFormat: null } as const;

const put = (f: FakeProject, name: string, text: string): void => {
  mkdirSync(join(f.state, ...name.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(f.state, name), text);
};

/** Canaries on every channel the fake can speak on. */
function seedCanaries(f: FakeProject): void {
  put(f, 'runner-out.txt', `suite said ${CANARY_TEXT}\n`);
  put(f, 'runner-err.txt', `suite stderr ${CANARY_TEXT}\n`);
  put(f, 'e2e-out.txt', `browser said ${CANARY_TEXT}\n`);
  put(f, 'e2e-err.txt', `browser stderr ${CANARY_TEXT}\n`);
  put(f, 'app-logs.txt', `app log ${CANARY_TEXT}\n`);
  put(f, 'restore-err.txt', `${RESTORE_TAG} error 42P01 at dump line 12\nclient text ${CANARY_TEXT}\n`);
  put(
    f,
    'junit/test/TEST-com.acme.UserTest.xml',
    `<?xml version="1.0"?>\n<testsuite name="com.acme.UserTest" tests="2" skipped="0" failures="1" errors="0" time="0.5">\n<testcase name="finds ${NAME} (${RRN})" classname="com.acme.UserTest"/>\n<testcase name="${MAIL}" classname="c"><failure message="${NAME_NFD}">stack ${CANARY_TEXT}</failure></testcase>\n<system-out><![CDATA[${CANARY_TEXT}]]></system-out>\n</testsuite>\n`,
  );
  const test1 = (title: string, status: string, claim: string, nonce: string, extra: unknown[] = []) => ({
    title,
    file: 'orders.spec.ts',
    tests: [{ status, expectedStatus: 'passed', annotations: [{ type: 'goodboy-ui', description: claim }, { type: 'goodboy-test', description: nonce }, ...extra], results: [{ status: status === 'expected' ? 'passed' : 'failed', error: { message: CANARY_TEXT } }] }],
  });
  put(
    f,
    'playwright-report.json',
    JSON.stringify({
      stats: { startTime: 'x', duration: 100, expected: 1, skipped: 0, unexpected: 1, flaky: 0 },
      suites: [{ title: `suite ${NAME}`, file: 'orders.spec.ts', specs: [test1(`lists ${NAME} ${RRN}`, 'expected', `screen:GET:/orders-${RRN}:ok`, 'abcdef0123456789'), test1(`saves ${MAIL}`, 'unexpected', `ghost-${MAIL}:ok`, 'fedcba9876543210')] }],
    }),
  );
  put(f, 'access.log', `${JSON.stringify({ request: { method: 'GET', uri: `/orders/${NAME}?ssn=${RRN}&mail=${MAIL}`, headers: { 'x-goodboy-test': 'abcdef0123456789', 'x-goodboy-ui': `screen:GET:/orders-${RRN}:ok` } }, status: 200 })}\nnot json ${CANARY_TEXT}\n`);
}

/** No canary in anything the sandbox wrote to the host. */
function expectHostClean(f: FakeProject): void {
  for (const [rel, text] of filesUnder(join(f.root, SANDBOX_DIR, 'out'))) expect([rel, leaks(text)]).toEqual([rel, []]);
  for (const name of ['local.json', 'compose.yml']) {
    const p = join(f.root, SANDBOX_DIR, name);
    if (existsSync(p)) expect([name, leaks(readFileSync(p, 'utf8'))]).toEqual([name, []]);
  }
}

/** The mode `loadCtx` gives a project from its local file. */
const realOf = (root: string): boolean => (loadCtx(root, true) as Ctx).out.realData;

const volumeHasCanary = (f: FakeProject): boolean => filesUnder(join(f.state, 'vol')).some(([, t]) => leaks(t).length > 0);

describe('real data: a full run prints and records no canary', () => {
  test('a failing run of both suites: stdout, stderr, result.json, ui-check.json, state.json and every host file are clean; the raw output is in the volume', () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const r = f.cli(['sandbox-run', '--suite', 'all'], { FAKE_RUNNER_EXIT: '1', FAKE_E2E_EXIT: '1' });
    expect(r.code).toBe(1);
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
    const o = JSON.parse(r.stdout);
    expect(o.realData).toBe(true);
    expect(o.tail).toBe('');
    expect(o.unit.tail).toBe('');
    expect(o.e2e.tail).toBe('');
    expect(o.coverage.ok).toBe(true);
    // the counts are there instead of the text
    expect(o.summary.unit).toMatchObject({ exit: 1, timedOut: false, suites: [{ name: 'com.acme.UserTest', tests: 2, failures: 1, errors: 0, skipped: 0, time: 0.5 }] });
    expect(o.summary.e2e).toMatchObject({ exit: 1, stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, duration: 100 }, files: [{ file: 'e2e/orders.spec.ts', passed: 1, failed: 1 }] });
    // the host has the result, the state, the verdict and the coverage report: nothing raw
    const names = f.hostFiles().map((n) => n.split('/').slice(1).join('/')).sort();
    expect(names).toEqual(['coverage/jacoco.xml', 'result.json', 'state.json', 'ui-check.json']);
    expectHostClean(f);
    const res = JSON.parse(readFileSync(o.result, 'utf8'));
    expect(res.realData).toBe(true);
    expect(readFileSync(o.result, 'utf8').match(/"realData"/g)).toHaveLength(1);
    expect(res.playwrightReport).toBe(`volume:runout/${o.ts}/playwright-report.json`);
    expect(res.accessLog).toBeNull();
    const verdict = JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'out', o.ts, 'ui-check.json'), 'utf8'));
    expect(verdict).toMatchObject({ schema: 1, run: o.ts, unknown_claims: 2 });
    // a log line that is not JSON is named by its number, never quoted
    expect(verdict.problems).toContain('access log:2 is not a JSON object');
    expect(JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'out', o.ts, 'state.json'), 'utf8'))).toMatchObject({ status: 'failed' });
    // the failing run's raw output is kept in the volume (so this test would fail if the fake printed nothing)
    expect(volumeHasCanary(f)).toBe(true);
    expect(readFileSync(join(f.state, 'vol', 'outroot', o.ts, 'output.log'), 'utf8')).toContain(CANARY_TEXT);
    // ui-check prints the stored verdict
    const ui = f.cli(['ui-check', '--run', o.ts]);
    expect(leaks(ui.stdout + ui.stderr)).toEqual([]);
    expect(JSON.parse(ui.stdout)).toMatchObject({ stored: true, unknown_claims: 2 });
    for (const bad of [['--log', `/tmp/${NAME}`], ['--report', `/tmp/${RRN}`]]) {
      const refused = f.cli(['ui-check', ...bad]);
      expect(refused.code).not.toBe(0);
      expect(leaks(refused.stdout + refused.stderr)).toEqual([]);
    }
  });

  test('a passing run: nothing raw is left in the volume, the counts are in the result, and the proof fields keep their meaning', () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const r = f.cli(['sandbox-run', '--suite', 'all'], { FAKE_RUNNER_EXIT: '0', FAKE_E2E_EXIT: '0' });
    expect(r.code).toBe(0);
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
    const o = JSON.parse(r.stdout);
    expect(o.cleanup).toBe('removed');
    expect(existsSync(join(f.state, 'vol', 'outroot', o.ts))).toBe(false);
    expect(readdirSync(join(f.state, 'vol', 'outdirs', 'tout_build_test_results'))).toEqual([]);
    expect(volumeHasCanary(f)).toBe(false);
    expectHostClean(f);
    expect(JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'out', o.ts, 'state.json'), 'utf8'))).toMatchObject({ status: 'passed' });
    // lib/sandbox-proof.ts reads the same fields as before: the check flags, the exit, the e2e step and its report
    const proof = readRunResult(f.root, o.ts);
    if (proof instanceof Error) throw proof;
    expect(proof).toMatchObject({ run: o.ts, exit: 0, suite: 'all', check: { inner_only: true, egress_blocked: true, hosts_to_dummies: true }, e2e: { exit: 0, timedOut: false, report: true } });
    expect(e2ePassed(proof)).toBe(true);
    expect(proof.command).toEqual(['./gradlew', 'test', '--offline']);
  });

  test('a run of the unit suite alone has a unit summary and no e2e files; a runner that wrote no JUnit XML has exit and duration only', () => {
    const f = fakeProject(REAL);
    const r = f.cli(['sandbox-run', '--suite', 'unit']);
    expect(r.code).toBe(0);
    const o = JSON.parse(r.stdout);
    expect(Object.keys(o.summary)).toEqual(['unit']);
    // a JVM run whose JUnit XML is not in a volume says so (a project whose test output dir is not one of the six)
    expect(o.summary.unit).toEqual({ exit: 0, durationMs: expect.any(Number), timedOut: false, counts: 'missing' });
    expect(f.calls().some((l) => l.includes('up -d proxy'))).toBe(false);
  });

  test('malformed JUnit XML and a Playwright report that is not one are `unreadable`, and the result says nothing of their text', () => {
    const f = fakeProject(REAL);
    put(f, 'junit/test/TEST-bad.xml', `<html>${NAME} ${RRN}</html>`);
    put(f, 'playwright-report.json', `not json ${MAIL}`);
    const r = f.cli(['sandbox-run', '--suite', 'all'], { FAKE_RUNNER_EXIT: '1' });
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
    const o = JSON.parse(r.stdout);
    expect(o.summary.unit.unreadable).toBe(true);
    expect(o.summary.unit.suites).toBeUndefined();
    expect(o.summary.e2e.unreadable).toBe(true);
    expect(o.summary.e2e.stats).toBeUndefined();
    expectHostClean(f);
  });
});

describe('real data: every failure prints a code, never the words of what failed', () => {
  test('a run that stops on a docker step names the step and gives a code', async () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const cases: [string, string, string][] = [
      ['reset.sh', 'resetting db from its template failed', 'reset-failed'],
      [' up -d proxy', 'starting the proxy failed', 'proxy-failed'],
      [' proxy sh -c rm -rf /live', 'cleaning /live failed', 'live-failed'],
      [' up -d app', 'starting the app failed', 'app-failed'],
      [' proxy sh -c : > /live/access.log', 'truncating the access log failed', 'live-failed'],
    ];
    for (const [pattern, said, code] of cases) {
      const r = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_FAIL: pattern, FAKE_FAIL_TEXT: `docker said ${CANARY_TEXT}` });
      expect([pattern, r.code]).toEqual([pattern, 1]);
      expect([pattern, leaks(r.text)]).toEqual([pattern, []]);
      expect(String(r.out.stopped)).toContain(said);
      expect(r.out.diagnostic).toMatchObject({ code });
    }
    expectHostClean(f);
  });

  test('the problems of an e2e run that does not stop are fixed words or codes: the app that did not stop, the coverage step', async () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const r = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_FAIL: ' stop -t 60', FAKE_FAIL_TEXT: `docker said ${CANARY_TEXT}` });
    expect(leaks(r.text)).toEqual([]);
    expect(r.out.e2e.problems).toContain('stopping the app failed, its coverage data may be missing: app-failed');
    const cov = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_COVERAGE_EXIT: '1', FAKE_RUNNER_EXIT: '0' });
    expect(leaks(cov.text)).toEqual([]);
    expect(cov.out.coverage).toMatchObject({ ok: false, exit: 1, note: 'coverage-failed' });
    for (const [exit, note] of [['4', 'the coverage tool is not prepared; run sandbox-prepare'], ['3', 'the run left no coverage data']] as const) {
      const c = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_COVERAGE_EXIT: exit });
      expect(c.out.coverage.note).toBe(note);
    }
    // a successful coverage step has no note text either
    const ok = await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(ok.out.coverage).toMatchObject({ ok: true, note: 'withheld' });
    expectHostClean(f);
  });

  test('a volume that cannot be read or written is a fixed message or a code; nothing of the call is shown', async () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const read = await f.inproc('sandbox-run', ['--suite', 'e2e'], { FAKE_READER_FAIL: 'e2e-after', FAKE_FAIL_TEXT: `reader said ${CANARY_TEXT}` });
    expect(leaks(read.text)).toEqual([]);
    expect(read.out.e2e.problems).toContain('the Playwright report and the access log could not be read from the sandbox volumes');
    expect(read.out.playwrightReport).toBeNull();
    const junit = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_READER_FAIL: 'unit-after', FAKE_FAIL_TEXT: `reader said ${CANARY_TEXT}` });
    expect(leaks(junit.text)).toEqual([]);
    expect(junit.out.summary.unit.unreadable).toBe(true);
    const write = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_READER_FAIL: 'unit-after', FAKE_FAIL_TEXT: `reader said ${CANARY_TEXT}` });
    expect(leaks(write.text)).toEqual([]);
    expect(write.out.problems).toContain('output.log could not be written to the run volume');
    const clear = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_READER_FAIL: 'finish', FAKE_FAIL_TEXT: `reader said ${CANARY_TEXT}` });
    expect(leaks(clear.text)).toEqual([]);
    expect(clear.out.stopped).toBe("clearing the previous run's scratch volumes failed: volume-failed");
    expect(clear.out.diagnostic).toMatchObject({ code: 'volume-failed', step: 'clear scratch' });
    expectHostClean(f);
  });

  test('sandbox-up: a restore that fails, a reset, the stores, the app and the proxy give a step and a code; an app that does not answer shows no log', async () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const text = `docker said ${CANARY_TEXT}`;
    const restore = f.cli(['sandbox-up', '--wait-seconds', '5'], { FAKE_RESTORE_EXIT: '1' });
    expect(restore.code).toBe(1);
    expect(leaks(restore.stdout + restore.stderr)).toEqual([]);
    const last = (r: { out: Record<string, any> }) => r.out.steps[r.out.steps.length - 1];
    expect(last({ out: JSON.parse(restore.stdout) })).toMatchObject({ step: 'restore db', ok: false, note: 'restore-failed', diagnostic: { code: 'restore-failed', step: 'restore db', exit: 1 } });
    // the tagged line the restore script prints (code and line) is withheld too in this mode
    expect(restore.stdout).not.toContain('42P01');
    const cases: [string, string, string][] = [
      [' up -d --wait', 'up stores and dummies', 'docker-failed'],
      ['reset.sh', 'reset', 'reset-failed'],
      [' up -d app', 'start app', 'app-failed'],
      [' up -d proxy', 'start proxy', 'proxy-failed'],
    ];
    for (const [pattern, step, code] of cases) {
      const r = await f.inproc('sandbox-up', ['--wait-seconds', '5'], { FAKE_FAIL: pattern, FAKE_FAIL_TEXT: text });
      expect([pattern, leaks(r.text)]).toEqual([pattern, []]);
      expect(last(r)).toMatchObject({ step, ok: false });
      expect(JSON.stringify(last(r))).toContain(code);
    }
    const slow = await f.inproc('sandbox-up', ['--wait-seconds', '5'], { FAKE_HEALTH_EXIT: '1' });
    expect(slow.code).toBe(1);
    expect(leaks(slow.text)).toEqual([]);
    expect(last(slow)).toMatchObject({ step: 'app health', ok: false, diagnostic: { code: 'app-down' } });
    expect(f.calls().some((l) => l.includes(' logs '))).toBe(false);
  }, 180_000);

  test('sandbox-up --app-logs is refused with a fixed message, and no log is asked for', () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const r = f.cli(['sandbox-up', '--app-logs']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--app-logs is not available in a sandbox that holds real data');
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
    expect(f.calls().some((l) => l.includes(' logs '))).toBe(false);
  });

  test('sandbox-check, a docker that fails to print its config, and sandbox-down give codes, with a container named with a canary', async () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    // a container the project does not own, on the default bridge, named with a canary
    const inspect = JSON.parse(readFileSync(join(f.state, 'inspect.json'), 'utf8'));
    inspect.push({ Id: 'id-x', Name: `/${NAME}-${MAIL}`, Config: { Labels: {} }, HostConfig: { NetworkMode: 'bridge' }, NetworkSettings: { Networks: { bridge: { IPAddress: '172.17.0.9' } } } });
    put(f, 'inspect.json', JSON.stringify(inspect));
    put(f, 'ps.txt', 'id-db\nid-x\n');
    const check = f.cli(['sandbox-check']);
    expect(check.code).toBe(1);
    expect(leaks(check.stdout + check.stderr)).toEqual([]);
    expect(JSON.parse(check.stdout).problems).toContain('check-failed (containers)');
    const cfg = await f.inproc('sandbox-check', [], { FAKE_FAIL: ' config ', FAKE_FAIL_TEXT: `docker said ${CANARY_TEXT}` });
    expect(leaks(cfg.text)).toEqual([]);
    expect(cfg.out.problems).toContain('docker compose config failed: docker-failed');
    const down = await f.inproc('sandbox-down', [], { FAKE_FAIL: ' down ', FAKE_FAIL_TEXT: `docker said ${CANARY_TEXT}` });
    expect(down.code).toBe(1);
    expect(down.out.tail).toBe('');
    expect(leaks(down.text)).toEqual([]);
  });

  test('an exception inside goodboy is its class and no message in real-data mode, and its message otherwise', async () => {
    for (const [local, expected] of [[REAL, 'sandbox-run: internal (Error)'], [PLAIN, 'is a link or not a directory']] as const) {
      const f = fakeProject(local);
      // a file where the `out` dir goes: ensureRealDir throws with a message that names the path
      writeFileSync(join(f.root, SANDBOX_DIR, 'out'), 'x');
      const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
      expect(r.error).toContain(expected);
      if (local === REAL) expect(r.error).toBe(expected);
    }
  });

  test('a sweep that fails is a code next to the command output, and the command still runs', async () => {
    const f = fakeProject(REAL);
    const r = await f.inproc('sandbox-check', [], { FAKE_READER_FAIL: 'list', FAKE_FAIL_TEXT: `reader said ${CANARY_TEXT}` });
    expect(r.code).toBe(0);
    expect(r.out.sweep).toEqual({ code: 'sweep-failed', step: 'sweep' });
    expect(leaks(r.text)).toEqual([]);
    const ok = await f.inproc('sandbox-check');
    expect(ok.out.sweep).toBeUndefined();
  });
});

describe('without real data the old output stays', () => {
  test('tails, the restore lines, the app log with --app-logs and the host copies are as before', async () => {
    const f = fakeProject(PLAIN);
    seedCanaries(f);
    const r = f.cli(['sandbox-run', '--suite', 'all'], { FAKE_RUNNER_EXIT: '1', FAKE_E2E_EXIT: '1' });
    const o = JSON.parse(r.stdout);
    expect(o.realData).toBe(false);
    expect(o.tail).toContain('suite said');
    expect(o.unit.tail).toContain(CANARY_TEXT);
    expect(o.e2e.tail).toContain('browser said');
    const dir = join(f.root, SANDBOX_DIR, 'out', o.ts);
    for (const n of ['output.log', 'e2e-output.log', 'access.log', 'playwright-report.json', 'result.json', 'state.json', 'ui-check.json']) expect([n, existsSync(join(dir, n))]).toEqual([n, true]);
    expect(readFileSync(join(dir, 'output.log'), 'utf8')).toContain(CANARY_TEXT);
    expect(o.accessLog).toBe(join(dir, 'access.log'));
    expect(o.playwrightReport).toBe(join(dir, 'playwright-report.json'));
    // the stored verdict never holds a title or a claim, in any mode
    expect(leaks(readFileSync(join(dir, 'ui-check.json'), 'utf8'))).toEqual([]);
    // the restore note shows the tagged line only; the app log only with --app-logs
    const restore = await f.inproc('sandbox-up', ['--wait-seconds', '5'], { FAKE_RESTORE_EXIT: '1' });
    expect(JSON.stringify(restore.out)).toContain('42P01');
    expect(leaks(JSON.stringify(restore.out))).toEqual([]);
    const loud = await f.inproc('sandbox-up', ['--wait-seconds', '5', '--app-logs'], { FAKE_HEALTH_EXIT: '1' });
    expect(loud.text).toContain(MAIL);
  }, 120_000);

  test('the counts are in the summary here too', async () => {
    const f = fakeProject(PLAIN);
    seedCanaries(f);
    const r = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_RUNNER_EXIT: '1' });
    expect(r.out.summary.unit.suites).toEqual([{ name: 'com.acme.UserTest', tests: 2, failures: 1, errors: 0, skipped: 0, time: 0.5 }]);
    expect(r.out.summary.e2e.files).toEqual([{ file: 'e2e/orders.spec.ts', passed: 1, failed: 1 }]);
    const clean = fakeProject(PLAIN);
    const ok = await clean.inproc('sandbox-run', ['--suite', 'e2e']);
    expect(ok.out.summary.e2e).toMatchObject({ exit: 0, stats: { expected: 1 }, files: [{ file: 'e2e/a.spec.ts', passed: 1, failed: 0 }] });
    expect(ok.out.summary.unit).toBeUndefined();
  });
});

describe('raw artifacts expire', () => {
  const H = 3_600_000;
  const stamp = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
  const volRun = (f: FakeProject, ts: string): string => join(f.state, 'vol', 'outroot', ts);
  const hostState = (f: FakeProject, ts: string, state: object | null): void => {
    mkdirSync(join(f.root, SANDBOX_DIR, 'out', ts), { recursive: true });
    if (state !== null) writeFileSync(join(f.root, SANDBOX_DIR, 'out', ts, 'state.json'), JSON.stringify(state));
  };
  const leftover = (f: FakeProject, ts: string): void => {
    mkdirSync(volRun(f, ts), { recursive: true });
    writeFileSync(join(volRun(f, ts), 'output.log'), `old ${CANARY_TEXT}`);
  };

  test('a passing run is removed at once, with the scratch volumes; a failing one stays until its TTL has passed, and then goes with the next command', async () => {
    const f = fakeProject(REAL);
    seedCanaries(f);
    const pass = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(pass.out.cleanup).toBe('removed');
    expect(existsSync(volRun(f, pass.out.ts))).toBe(false);
    const fail = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_RUNNER_EXIT: '1' });
    expect(fail.code).toBe(1);
    expect(fail.out.cleanup).toBe('kept');
    expect(existsSync(volRun(f, fail.out.ts))).toBe(true);
    expect(existsSync(join(f.state, 'vol', 'outdirs', 'tout_build_test_results', 'test'))).toBe(true);
    // a command a little later: still there (it is far younger than 24 h)
    await f.inproc('sandbox-check');
    expect(existsSync(volRun(f, fail.out.ts))).toBe(true);
    // its start 25 hours ago: the next command removes it, and, as it is the last run dir, the scratch volumes too
    hostState(f, fail.out.ts, { status: 'failed', started: iso(25 * H), finished: iso(25 * H - 1000) });
    const next = await f.inproc('sandbox-check');
    expect(next.out.sweep).toBeUndefined();
    expect(existsSync(volRun(f, fail.out.ts))).toBe(false);
    expect(existsSync(join(f.state, 'vol', 'outdirs', 'tout_build_test_results', 'test'))).toBe(false);
    expect(volumeHasCanary(f)).toBe(false);
  });

  test('a run that crashed (its state still says running) goes after the TTL; one with no state goes by its name; a foreign entry and a passed run go at once; a fresh one stays', async () => {
    const f = fakeProject(REAL);
    const crashed = stamp(30 * H);
    const nameless = stamp(27 * H);
    const fresh = stamp(2 * H);
    const freshNameless = stamp(3 * H);
    const passed = stamp(1 * H);
    for (const ts of [crashed, nameless, fresh, freshNameless, passed]) leftover(f, ts);
    mkdirSync(join(f.state, 'vol', 'outroot', 'junk'), { recursive: true });
    hostState(f, crashed, { status: 'running', started: iso(30 * H) });
    hostState(f, nameless, null);
    hostState(f, fresh, { status: 'failed', started: iso(2 * H) });
    hostState(f, freshNameless, null);
    hostState(f, passed, { status: 'passed', started: iso(1 * H) });
    const r = await f.inproc('sandbox-check');
    expect(r.out.sweep).toBeUndefined();
    const left = readdirSync(join(f.state, 'vol', 'outroot')).sort();
    expect(left).toEqual([fresh, freshNameless].sort());
  });

  test('the environment can lower the TTL and cannot raise it above 24 hours', async () => {
    const f = fakeProject(REAL);
    const young = stamp(2 * H);
    const old = stamp(25 * H);
    for (const ts of [young, old]) leftover(f, ts);
    hostState(f, young, { status: 'failed', started: iso(2 * H) });
    hostState(f, old, { status: 'failed', started: iso(25 * H) });
    await f.inproc('sandbox-check', [], { GOODBOY_SANDBOX_RAW_TTL_HOURS: '1000' });
    expect(readdirSync(join(f.state, 'vol', 'outroot'))).toEqual([young]);
    leftover(f, old);
    await f.inproc('sandbox-check');
    expect(readdirSync(join(f.state, 'vol', 'outroot')).sort()).toEqual([young]);
    await f.inproc('sandbox-check', [], { GOODBOY_SANDBOX_RAW_TTL_HOURS: '1' });
    expect(readdirSync(join(f.state, 'vol', 'outroot'))).toEqual([]);
  });

  test('sandbox-check, -prepare, -up, -run, -down and -local sweep; a remote daemon, an unsafe compose file and a project with no runs volume start no container for it', async () => {
    const f = fakeProject(REAL);
    const readers = () => f.calls().filter((l) => l.startsWith('reader:list')).length;
    for (const [command, args] of [['sandbox-check', []], ['sandbox-prepare', []], ['sandbox-up', ['--wait-seconds', '5']], ['sandbox-down', []]] as const) {
      const before = readers();
      await f.inproc(command, [...args]);
      expect([command, readers()]).toEqual([command, before + 1]);
    }
    const run = readers();
    await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(readers()).toBe(run + 1);
    // sandbox-local: the dump has to be under the home directory and outside the repository
    const home = join(f.state, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'shop.sql'), 'select 1;');
    const local = await f.inproc('sandbox-local', ['--dump', join(home, 'shop.sql')], { HOME: home });
    expect(local.error).toBeUndefined();
    expect(readers()).toBe(run + 2);
    const remote = await f.inproc('sandbox-check', [], { DOCKER_HOST: 'tcp://203.0.113.9:2375' });
    expect(remote.code).toBe(1);
    expect(readers()).toBe(run + 2);
    const cfg = JSON.parse(readFileSync(join(f.state, 'config.json'), 'utf8'));
    cfg.services.app.privileged = true;
    writeFileSync(join(f.state, 'config.json'), JSON.stringify(cfg));
    await f.inproc('sandbox-check');
    expect(readers()).toBe(run + 2);
    // no runs volume: nothing to sweep, and `docker compose run` would make the network and the volumes just for that
    const g = fakeProject(REAL);
    rmSync(join(g.state, 'volumes.txt'));
    await g.inproc('sandbox-check');
    expect(g.calls().filter((l) => l.startsWith('reader:'))).toEqual([]);
  });

  test('the sweep does not clear the scratch volumes while another run is in progress, even when every run dir in the volume is expired', async () => {
    const f = fakeProject(REAL);
    const old = stamp(30 * H);
    leftover(f, old);
    hostState(f, old, { status: 'failed', started: iso(30 * H) });
    // another run: started a minute ago, its dir in the volume is not made yet (the e2e container has not started)
    hostState(f, stamp(60_000), { status: 'running', started: iso(60_000) });
    const scratch = join(f.state, 'vol', 'outdirs', 'tout_build_test_results', 'test', 'TEST-x.xml');
    mkdirSync(join(f.state, 'vol', 'outdirs', 'tout_build_test_results', 'test'), { recursive: true });
    writeFileSync(scratch, '<testsuite name="a.B" tests="1"/>');
    mkdirSync(join(f.state, 'vol', 'live'), { recursive: true });
    writeFileSync(join(f.state, 'vol', 'live', 'access.log'), 'rows of the run in progress');
    await f.inproc('sandbox-check');
    expect(readdirSync(join(f.state, 'vol', 'outroot'))).toEqual([]);
    expect(existsSync(scratch)).toBe(true);
    expect(readFileSync(join(f.state, 'vol', 'live', 'access.log'), 'utf8')).toBe('rows of the run in progress');
  });
});

describe('raw files of runs before M6a and of non-real-data runs', () => {
  const rawFiles = (f: FakeProject, ts: string): void => {
    const d = join(f.root, SANDBOX_DIR, 'out', ts);
    mkdirSync(join(d, 'e2e-artifacts'), { recursive: true });
    for (const n of ['output.log', 'e2e-output.log', 'access.log', 'playwright-report.json', 'result.json', 'state.json']) writeFileSync(join(d, n), `old ${CANARY_TEXT}`);
    writeFileSync(join(d, 'e2e-artifacts', 'trace.zip'), CANARY_TEXT);
    mkdirSync(join(f.root, SANDBOX_DIR, 'out', 'live'), { recursive: true });
    writeFileSync(join(f.root, SANDBOX_DIR, 'out', 'live', 'access.log'), CANARY_TEXT);
  };

  test('in real-data mode the sweep removes them from the host (and the old out/live), keeping result.json and state.json; without it they stay', async () => {
    const real = fakeProject(REAL);
    rawFiles(real, '20261001T000000Z');
    await real.inproc('sandbox-check');
    expect(real.hostFiles().sort()).toEqual(['20261001T000000Z/result.json', '20261001T000000Z/state.json']);
    // also where there is no runs volume to sweep: the host files are the host's own business
    const bare = fakeProject(REAL);
    rmSync(join(bare.state, 'volumes.txt'));
    rawFiles(bare, '20261001T000000Z');
    await bare.inproc('sandbox-check');
    expect(bare.hostFiles().sort()).toEqual(['20261001T000000Z/result.json', '20261001T000000Z/state.json']);
    const plain = fakeProject(PLAIN);
    rawFiles(plain, '20261001T000000Z');
    await plain.inproc('sandbox-check');
    expect(plain.hostFiles()).toContain('20261001T000000Z/output.log');
    expect(plain.hostFiles()).toContain('live/access.log');
  });

  test.skipIf(process.getuid?.() === 0)('a host file that cannot be removed is one failed entry: the other files and the runs volume are still swept, and the sweep says it failed', async () => {
    const f = fakeProject(REAL);
    const stuck = '20261001T000000Z';
    const fine = '20261002T000000Z';
    rawFiles(f, stuck);
    rawFiles(f, fine);
    // a read-only dir: its content cannot be unlinked (a root-owned leftover of an old run does the same)
    const trap = join(f.root, SANDBOX_DIR, 'out', stuck, 'e2e-artifacts');
    Bun.spawnSync(['chmod', '555', trap]);
    const old = '20260101T000000Z';
    mkdirSync(join(f.state, 'vol', 'outroot', old), { recursive: true });
    writeFileSync(join(f.state, 'vol', 'outroot', old, 'output.log'), CANARY_TEXT);
    try {
      const r = await f.inproc('sandbox-check');
      expect(r.out.sweep).toEqual({ code: 'sweep-failed', step: 'sweep' });
      expect(r.code).toBe(0);
      expect(leaks(r.text)).toEqual([]);
      expect(existsSync(join(f.root, SANDBOX_DIR, 'out', fine, 'output.log'))).toBe(false);
      expect(existsSync(join(f.root, SANDBOX_DIR, 'out', stuck, 'output.log'))).toBe(false);
      expect(existsSync(join(f.root, SANDBOX_DIR, 'out', 'live'))).toBe(false);
      expect(readdirSync(join(f.state, 'vol', 'outroot'))).toEqual([]);
    } finally {
      Bun.spawnSync(['chmod', '755', trap]);
    }
  });

  test('a link above out/ (.goodboy itself) stops the host removal: nothing is deleted outside the checkout', async () => {
    const f = fakeProject(REAL);
    const outside = join(f.state, 'outside');
    mkdirSync(outside);
    renameSync(join(f.root, '.goodboy'), join(outside, '.goodboy'));
    symlinkSync(join(outside, '.goodboy'), join(f.root, '.goodboy'));
    const elsewhere = join(outside, '.goodboy', 'sandbox', 'out');
    mkdirSync(join(elsewhere, 'live'), { recursive: true });
    writeFileSync(join(elsewhere, 'live', 'access.log'), 'KEEP');
    mkdirSync(join(elsewhere, '20261001T000000Z'));
    writeFileSync(join(elsewhere, '20261001T000000Z', 'output.log'), 'KEEP');
    await f.inproc('sandbox-check');
    expect(readFileSync(join(elsewhere, 'live', 'access.log'), 'utf8')).toBe('KEEP');
    expect(readFileSync(join(elsewhere, '20261001T000000Z', 'output.log'), 'utf8')).toBe('KEEP');
  });

  test('a link in place of a run dir or of out/live is removed or passed over, never followed', async () => {
    const f = fakeProject(REAL);
    const victim = join(f.state, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'output.log'), 'VICTIM');
    mkdirSync(join(f.root, SANDBOX_DIR, 'out'), { recursive: true });
    symlinkSync(victim, join(f.root, SANDBOX_DIR, 'out', '20261001T000000Z'));
    symlinkSync(victim, join(f.root, SANDBOX_DIR, 'out', 'live'));
    await f.inproc('sandbox-check');
    expect(readFileSync(join(victim, 'output.log'), 'utf8')).toBe('VICTIM');
  });
});

describe('real data found in the volumes when local.json is gone', () => {
  const failing = { FAKE_RUNNER_EXIT: '1', FAKE_E2E_EXIT: '1' };

  test('a database volume of the project makes the run real-data whatever local.json says, and the project is not given its raw output back', async () => {
    const f = fakeProject(null);
    seedCanaries(f);
    put(f, 'volumes.txt', `${f.ctx.project}_runout\n${f.ctx.project}_dbdata\n`);
    const r = f.cli(['sandbox-run', '--suite', 'all'], failing);
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
    const o = JSON.parse(r.stdout);
    expect(o.realData).toBe(true);
    expect(o.tail).toBe('');
    expect(f.hostFiles().map((n) => n.split('/').slice(1).join('/')).sort()).toEqual(['coverage/jacoco.xml', 'result.json', 'state.json', 'ui-check.json']);
    expectHostClean(f);
    // the same project with no database volume is a plain one
    const g = fakeProject(null);
    seedCanaries(g);
    const plain = JSON.parse(g.cli(['sandbox-run', '--suite', 'unit'], failing).stdout);
    expect(plain.realData).toBe(false);
    expect(plain.tail).toContain('suite said');
    // volumes of other names (a cache, the e2e packages) are not the database
    put(g, 'volumes.txt', `${g.ctx.project}_gradle\n${g.ctx.project}_e2edeps\n${g.ctx.project}_runout\n`);
    expect(JSON.parse(g.cli(['sandbox-run', '--suite', 'unit']).stdout).realData).toBe(false);
    // a second SQL store and the Mongo store hold data too
    for (const v of ['db2data', 'mongodata']) {
      put(g, 'volumes.txt', `${g.ctx.project}_${v}\n`);
      expect([v, JSON.parse(g.cli(['sandbox-run', '--suite', 'unit']).stdout).realData]).toEqual([v, true]);
    }
  });

  test('docker that cannot list the volumes means real data (fail closed), and what it said is not shown', async () => {
    const f = fakeProject(null);
    seedCanaries(f);
    const r = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_FAIL: ' volume ls ', FAKE_FAIL_TEXT: `docker said ${CANARY_TEXT}`, FAKE_RUNNER_EXIT: '1' });
    expect(leaks(r.text)).toEqual([]);
    expect(r.out.realData).toBe(true);
    expect(r.out.tail).toBe('');
    // the sweep had nothing it could trust: no reader was started
    expect(f.calls().filter((l) => l.startsWith('reader:list'))).toEqual([]);
  });

  test('sandbox-down --volumes ends real-data mode only when no database volume and no dump is left; it prints what is true', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    put(f, 'volumes.txt', `${f.ctx.project}_runout\n${f.ctx.project}_dbdata\n`);
    // the fake does not remove volumes: the database volume is still there after the down
    const stays = await f.inproc('sandbox-down', ['--volumes']);
    expect(stays.out.realData).toBe('kept');
    expect(JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'local.json'), 'utf8')).realData).toBe(true);
    put(f, 'volumes.txt', `${f.ctx.project}_runout\n`);
    expect((await f.inproc('sandbox-down', ['--volumes'])).out.realData).toBe('cleared');
    expect(realOf(f.root)).toBe(false);
    // a dump still named in local.json keeps the mode, and the output says so
    const g = fakeProject({ dump: '/home/me/shop.sql', dumpFormat: 'sql', realData: true });
    expect((await g.inproc('sandbox-down', ['--volumes'])).out.realData).toBe('kept');
    // docker that cannot answer after the down: kept
    const h = fakeProject({ dump: null, dumpFormat: null, realData: true });
    const out = await h.inproc('sandbox-down', ['--volumes'], { FAKE_FAIL: ' volume ls ' });
    expect(out.out.realData).toBe('kept');
  });
});

describe('docker calls per command', () => {
  /** The docker invocations of a command (not the lines of the probe script the fake logs). */
  const calls = (f: FakeProject, from: number): string[] => f.calls().slice(from).filter((l) => /^(reader:|context |volume |ps |network |inspect |compose )/.test(l));
  const count = (list: string[], re: RegExp): number => list.filter((l) => re.test(l)).length;

  test('--suite all asks docker for the daemon, the compose file and the volumes once each, and starts six reader containers', async () => {
    const f = fakeProject(REAL);
    const from = f.calls().length;
    const r = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(r.code).toBe(0);
    const c = calls(f, from);
    expect(count(c, /^context /)).toBe(1);
    expect(count(c, / config --format json/)).toBe(1);
    expect(count(c, /^volume ls /)).toBe(1);
    // the sweep's list, the scratch clear, the unit step's log and JUnit, the e2e step's log, report, access log and traces, the coverage report, the final remove and clear
    expect(c.filter((l) => l.startsWith('reader:')).map((l) => l.split(' ')[0])).toEqual(['reader:list', 'reader:finish', 'reader:unit-after', 'reader:e2e-after', 'reader:read', 'reader:finish']);
  });

  test('sandbox-down of a project that never ran asks for the daemon and the volumes and takes the project down: no reader, no compose config', async () => {
    const f = fakeProject(REAL);
    rmSync(join(f.state, 'volumes.txt'));
    const from = f.calls().length;
    await f.inproc('sandbox-down');
    const c = calls(f, from);
    expect(c.map((l) => l.replace(/^compose -f \S+ -p \S+ /, 'compose '))).toEqual(['context inspect --format {{.Endpoints.docker.Host}}', 'volume ls --filter label=com.docker.compose.project=' + f.ctx.project + ' --format {{.Name}}', 'compose --profile * down --remove-orphans']);
  });

  test('one command asks the daemon and the compose file once, however many steps use the answer', async () => {
    const f = fakeProject(REAL);
    for (const [command, args] of [['sandbox-check', []], ['sandbox-up', ['--wait-seconds', '5']], ['sandbox-prepare', []]] as const) {
      const from = f.calls().length;
      await f.inproc(command, [...args]);
      const c = calls(f, from);
      expect([command, count(c, /^context /), count(c, / config --format json/)]).toEqual([command, 1, 1]);
    }
  });
});

describe('the real-data flag over the life of a sandbox', () => {
  test('removing the dump from local.json keeps real-data mode; sandbox-down --volumes clears it; a dump that is still set keeps the mode', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    expect(realOf(f.root)).toBe(true);
    const keep = await f.inproc('sandbox-down');
    expect(keep.out).toMatchObject({ volumes: 'kept' });
    expect(keep.out.realData).toBeUndefined();
    expect(realOf(f.root)).toBe(true);
    const gone = await f.inproc('sandbox-down', ['--volumes']);
    expect(gone.out).toMatchObject({ volumes: 'removed', realData: 'cleared' });
    expect(JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'local.json'), 'utf8'))).toEqual({ dump: null, dumpFormat: null, realData: false });
    expect(realOf(f.root)).toBe(false);
    // a dump file that is still named in local.json is still real data
    const g = fakeProject({ dump: '/home/me/shop.sql', dumpFormat: 'sql', realData: true });
    await g.inproc('sandbox-down', ['--volumes']);
    expect(JSON.parse(readFileSync(join(g.root, SANDBOX_DIR, 'local.json'), 'utf8')).realData).toBe(false);
    expect(realOf(g.root)).toBe(true);
    // no local.json at all: nothing to clear and no error
    const none = fakeProject(null);
    expect((await none.inproc('sandbox-down', ['--volumes'])).out.realData).toBe('cleared');
    // nothing to clear; the command's preflight found no real data and wrote the plain local file (M6b)
    expect(JSON.parse(readFileSync(join(none.root, SANDBOX_DIR, 'local.json'), 'utf8'))).toEqual({ dump: null, dumpFormat: null, realData: false });
  });

  test('a failed docker down does not clear the flag', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    const r = await f.inproc('sandbox-down', ['--volumes'], { FAKE_FAIL: ' down ' });
    expect(r.code).toBe(1);
    expect(r.out.realData).toBeUndefined();
    expect(realOf(f.root)).toBe(true);
  });
});
