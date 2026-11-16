// Track M, M6c (plan §19): `sandbox-run` with a data manifest, against the fake docker of tests/m6a-fake.ts. The resolve step
// runs between a database reset and the suites, once for each reset, and the values it leaves in the `data` volume are cleared
// right after the suites (pass or fail). A refusal or a failure stops the run with a fixed code. A canary row that was
// resolved into values.tsv appears in no output, result, state or host file.

import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataHelperCjs } from '../lib/sandbox-data-helper';
import { SANDBOX_DIR } from '../lib/sandbox-mode';
import { cleanupFakeProjects, type FakeProject, fakeProject, filesUnder, plainScan } from './m6a-project';

setDefaultTimeout(120_000);
afterEach(cleanupFakeProjects);

const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const PLAIN = { dump: null, dumpFormat: null } as const;

const CANARY = 'Kim-Minsoo-0101234567-seoul';
const KOREAN = '김민수'.normalize('NFC');
const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');
const CANARIES = [CANARY, hex(CANARY), KOREAN, hex(KOREAN), KOREAN.normalize('NFD')];
const leaks = (text: string): string[] => CANARIES.filter((c) => text.includes(c));

const SCHEMA = [
  'C\tpublic\tusers\tid\tinteger\tNO',
  'C\tpublic\tusers\tname\ttext\tYES',
  'C\tpublic\tusers\temail\ttext\tYES',
  'C\tpublic\tusers\tstatus\ttext\tYES',
  'S\t0',
  'K\tpublic\tusers\tid\tp\t1',
].join('\n') + '\n';

const ACTIVE = { col: 'status', op: '=', value: 'active' };
const MANIFEST = {
  version: 1,
  picks: { activeUser: { table: 'users', where: ACTIVE, n: 3, columns: ['name', 'email'] } },
  counts: { activeUsers: { table: 'users', where: ACTIVE } },
  generate: { newUserEmail: { table: 'users', column: 'email', kind: 'email' } },
};

/** What the database leaves in values.tsv for MANIFEST: 3 rows of 2 columns, a count and a generator (8 lines). */
const VALUES =
  [
    ...['aaaa', 'bbbb', 'cccc'].flatMap((r, i) => [`V\tactiveUser\t${r}\tname\t${hex(i === 0 ? CANARY : KOREAN)}`, `V\tactiveUser\t${r}\temail\t${hex(`${CANARY}@canary.example`)}`]),
    'N\tactiveUsers\t27',
    'G\tnewUserEmail\temail\tabcd1234',
  ].join('\n') + '\n';

const put = (f: FakeProject, name: string, text: string): void => {
  mkdirSync(join(f.state, ...name.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(f.state, name), text);
};
const read = (f: FakeProject, name: string): string | null => (existsSync(join(f.state, name)) ? readFileSync(join(f.state, name), 'utf8') : null);
const manifestPath = (f: FakeProject): string => join(f.root, SANDBOX_DIR, 'data.json');

/** A project with the manifest and the database answers a resolve needs. */
function project(local: typeof REAL | typeof PLAIN = REAL, manifest: unknown = MANIFEST): FakeProject {
  const f = fakeProject(local);
  writeFileSync(manifestPath(f), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  put(f, 'db/schema.out', SCHEMA);
  put(f, 'db/enum.out', 'E\t0\t3\n');
  put(f, 'db/matches.out', 'M\t0\t10\n');
  put(f, 'db/collision.out', 'X\t0\t0\n');
  put(f, 'db/resolve.out', VALUES);
  return f;
}

/** How many scripts of the tag the database was given (the fake keeps every script in db-sql.log). */
const asked = (f: FakeProject, tag: string): number => ((read(f, 'db-sql.log') ?? '').match(new RegExp(`^-- goodboy-data: ${tag}$`, 'gm')) ?? []).length;

const idx = (calls: string[], pat: string | RegExp, from = 0): number => {
  const i = calls.findIndex((c, k) => k >= from && (typeof pat === 'string' ? c.includes(pat) : pat.test(c)));
  return i;
};
const RESET = '/goodboy-db/reset.sh';
const WRITE = '/goodboy-data/v.tmp';
const RUNNER = /run --rm -T --no-deps --name \S+-runner-\S+ .* runner/;
const E2E = /run --rm -T --no-deps --name \S+-e2e-\S+ .* e2e/;

describe('the order of a run', () => {
  test('both suites: reset, resolve, runner, reset, resolve, e2e, then the values are cleared before the coverage report', async () => {
    const f = project();
    const r = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(r.code).toBe(0);
    const calls = f.calls();
    const reset1 = idx(calls, RESET);
    const write1 = idx(calls, WRITE);
    const runner = idx(calls, RUNNER);
    const reset2 = idx(calls, RESET, reset1 + 1);
    const write2 = idx(calls, WRITE, write1 + 1);
    const e2e = idx(calls, E2E);
    const cleared = idx(calls, 'reader:clear-data');
    const coverage = idx(calls, 'coverage.sh');
    expect([reset1, write1, runner, reset2, write2, e2e, cleared, coverage].every((i) => i >= 0)).toBe(true);
    expect([reset1, write1, runner, reset2, write2, e2e, cleared, coverage]).toEqual([...[reset1, write1, runner, reset2, write2, e2e, cleared, coverage]].sort((a, b) => a - b));
    // the run starts by clearing the shared volumes (the data volume with them), before the first reset
    expect(idx(calls, 'reader:finish clear')).toBeGreaterThanOrEqual(0);
    expect(idx(calls, 'reader:finish clear')).toBeLessThan(reset1);
    // the phase-1 questions come between the reset and the write, as the reader role
    const schema = idx(calls, "-U goodboy_reader");
    expect(schema).toBeGreaterThan(reset1);
    expect(schema).toBeLessThan(write1);
    // the write is the one exec of the script that holds the data volume's path
    expect(calls[write1]).toContain('exec -T db sh -c');
    expect(f.hostFiles().length).toBeGreaterThan(0);
  });

  test('phase 1 of the resolve (schema, enum, matches, collision) is asked once for a run with two suites, the write after each reset', async () => {
    const f = project();
    expect((await f.inproc('sandbox-run', ['--suite', 'all'])).code).toBe(0);
    expect(['schema', 'enum', 'matches', 'collision'].map((tag) => asked(f, tag))).toEqual([1, 1, 1, 1]);
    expect(f.calls().filter((c) => c.includes(WRITE))).toHaveLength(2);
    // a run of its own asks it again: nothing is kept from one run to the next
    expect((await f.inproc('sandbox-run', ['--suite', 'unit'])).code).toBe(0);
    expect(['schema', 'enum', 'matches', 'collision'].map((tag) => asked(f, tag))).toEqual([2, 2, 2, 2]);
  });

  test('the runner and the e2e container see the resolved values while they run, and the volume is empty after', async () => {
    const f = project();
    expect((await f.inproc('sandbox-run', ['--suite', 'all'])).code).toBe(0);
    expect(read(f, 'data-seen-runner.tsv')).toBe(VALUES);
    expect(read(f, 'data-seen-e2e.tsv')).toBe(VALUES);
    expect(existsSync(join(f.state, 'vol', 'data', 'values.tsv'))).toBe(false);
    expect(existsSync(join(f.state, 'vol', 'data', 'v.tmp'))).toBe(false);
  });

  test('the unit suite alone resolves once, the e2e suite alone resolves once, and each clears afterwards', async () => {
    for (const suite of ['unit', 'e2e']) {
      const f = project();
      expect((await f.inproc('sandbox-run', ['--suite', suite])).code).toBe(0);
      expect(f.calls().filter((c) => c.includes(WRITE))).toHaveLength(1);
      expect(f.calls().filter((c) => c.startsWith('reader:clear-data'))).toHaveLength(1);
      expect(existsSync(join(f.state, 'vol', 'data', 'values.tsv'))).toBe(false);
      expect(read(f, suite === 'unit' ? 'data-seen-runner.tsv' : 'data-seen-e2e.tsv')).toBe(VALUES);
    }
  });

  test('a failing suite clears the values too, and the run still reports its own exit code', async () => {
    const f = project();
    const r = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_RUNNER_EXIT: '1', FAKE_E2E_EXIT: '1' });
    expect(r.code).toBe(1);
    expect(f.calls().some((c) => c.startsWith('reader:clear-data'))).toBe(true);
    expect(existsSync(join(f.state, 'vol', 'data', 'values.tsv'))).toBe(false);
    expect(read(f, 'data-seen-runner.tsv')).toBe(VALUES);
  });

  test('the result records how many entries the manifest has, and nothing of them', async () => {
    const f = project();
    const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(r.out.data).toEqual({ picks: 1, counts: 1, generate: 1 });
    expect(JSON.parse(readFileSync(r.out.result, 'utf8')).data).toEqual({ picks: 1, counts: 1, generate: 1 });
  });

  test('a project with no manifest has no resolve step and no extra call, as before', async () => {
    const f = fakeProject(REAL);
    const r = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(r.code).toBe(0);
    expect(f.calls().some((c) => c.includes(WRITE) || c.includes('clear-data') || c.includes('goodboy-data: '))).toBe(false);
    expect(r.out.data).toBeUndefined();
    expect(read(f, 'data-seen-runner.tsv')).toBeNull();
  });

  test('an empty manifest (version only) resolves nothing and makes no database call, and the data volume is still cleared once at the end', async () => {
    const f = project(REAL, { version: 1 });
    const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(r.code).toBe(0);
    expect(f.calls().some((c) => c.includes(WRITE) || c.includes('-- goodboy-data: '))).toBe(false);
    for (const tag of ['schema', 'enum', 'matches', 'collision', 'precision', 'resolve']) expect([tag, asked(f, tag)]).toEqual([tag, 0]);
    expect(f.calls().filter((c) => c.startsWith('reader:clear-data'))).toHaveLength(1);
    expect(r.out.data).toEqual({ picks: 0, counts: 0, generate: 0 });
  });

  test('an empty manifest needs no SQL store: a project without one runs', async () => {
    const f = project(REAL, { version: 1 });
    const scan = JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'scan.json'), 'utf8'));
    scan.stores = [];
    writeFileSync(join(f.root, SANDBOX_DIR, 'scan.json'), JSON.stringify(scan));
    const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(r.out.diagnostic).toBeUndefined();
    expect(r.code).toBe(0);
  });

  test('the run starts with an empty data volume: what an earlier run left is gone before the suite starts, with or without a manifest', async () => {
    for (const manifest of [true, false]) {
      const f = manifest ? project() : fakeProject(REAL);
      mkdirSync(join(f.state, 'vol', 'data'), { recursive: true });
      writeFileSync(join(f.state, 'vol', 'data', 'values.tsv'), 'stale\n');
      writeFileSync(join(f.state, 'vol', 'data', 'other'), 'x');
      writeFileSync(join(f.state, 'vol', 'data', 'v.tmp'), 'x');
      expect((await f.inproc('sandbox-run', ['--suite', 'unit'])).code).toBe(0);
      // what the runner saw when it started: the resolve write replaces values.tsv, and nothing else of the old volume is there
      // (only the clear at the start of the run can have removed `other` and `v.tmp` by then: the clear at the end comes after)
      expect(read(f, 'data-ls-runner.txt')).toBe(manifest ? 'values.tsv\n' : '');
      expect(read(f, 'data-seen-runner.tsv')).toBe(manifest ? VALUES : null);
      expect(existsSync(join(f.state, 'vol', 'data', 'values.tsv'))).toBe(false);
      expect(existsSync(join(f.state, 'vol', 'data', 'other'))).toBe(false);
    }
  });
});

describe('a run that stops at the data', () => {
  const stopped = async (f: FakeProject, extra: Record<string, string> = {}) => {
    const r = await f.inproc('sandbox-run', ['--suite', 'all'], extra);
    expect(r.code).toBe(1);
    expect(r.out.stopped).toBeString();
    // neither suite ran and the stopped result is on disk
    expect(f.calls().some((c) => RUNNER.test(c) || E2E.test(c))).toBe(false);
    const file = JSON.parse(readFileSync(r.out.result, 'utf8'));
    expect(file.stopped).toBe(r.out.stopped);
    expect(file.diagnostic).toEqual(r.out.diagnostic);
    return r;
  };

  test('a manifest that is refused stops before any reset, with the field and the reason', async () => {
    const f = project(REAL, { version: 1, picks: { a: { table: 'users', where: ACTIVE } } });
    const r = await stopped(f);
    expect(r.out.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'picks.a.columns', reason: 'missing' });
    expect(r.out.stopped).toBe('data.json is refused at picks.a.columns: missing');
    expect(f.calls().some((c) => c.includes(RESET))).toBe(false);
  });

  test('a refused manifest stops before the sandbox check, which costs several docker calls (no check in the result)', async () => {
    const f = project(REAL, { version: 1, picks: { a: { table: 'users', where: ACTIVE } } });
    const r = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(r.code).toBe(1);
    expect(r.out.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'picks.a.columns', reason: 'missing' });
    // the check inspects the network and the containers and probes from a container: none of that has happened
    expect(f.calls().filter((c) => /^inspect |^network inspect|CTL_DNS/.test(c))).toEqual([]);
    expect(r.out.check).toBeUndefined();
    const file = JSON.parse(readFileSync(r.out.result, 'utf8'));
    expect(file.check).toBeUndefined();
    expect(file.stopped).toBe(r.out.stopped);
    // with a good manifest the same project does run its check
    const g = project();
    expect((await g.inproc('sandbox-run', ['--suite', 'unit'])).out.check).toBeDefined();
  });

  test('a manifest that is not JSON, and one that is a link, are refused the same way', async () => {
    const f = project(REAL, '{"version":');
    expect((await stopped(f)).out.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'data.json', reason: 'bad-json' });
    const g = project(REAL);
    writeFileSync(join(g.root, 'elsewhere.json'), JSON.stringify(MANIFEST));
    Bun.spawnSync(['rm', manifestPath(g)]);
    Bun.spawnSync(['ln', '-s', join(g.root, 'elsewhere.json'), manifestPath(g)]);
    expect((await stopped(g)).out.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'data.json', reason: 'unreadable' });
  });

  test('a manifest the schema does not fit stops after the reset, before the suites', async () => {
    const f = project(REAL, { version: 1, picks: { a: { table: 'nope', where: ACTIVE, columns: ['x'] } } });
    const r = await stopped(f);
    expect(r.out.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'picks.a.table', reason: 'unknown-table' });
    expect(f.calls().some((c) => c.includes(WRITE))).toBe(false);
    // the data volume is cleared on the way out
    expect(f.calls().some((c) => c.startsWith('reader:clear-data'))).toBe(true);
  });

  test('a generator whose space the dump uses is a collision: nothing written', async () => {
    const f = project();
    put(f, 'db/collision.out', 'X\t0\t1\n');
    const r = await stopped(f);
    expect(r.out.diagnostic).toEqual({ code: 'data-collision', step: 'resolve', field: 'generate.newUserEmail' });
    expect(f.calls().some((c) => c.includes(WRITE))).toBe(false);
    expect(existsSync(join(f.state, 'vol', 'data', 'values.tsv'))).toBe(false);
  });

  test('a write that fails, or prints another number of lines, is data-resolve-failed and the text of the database stays out', async () => {
    const f = project();
    put(f, 'db/resolve.err', `ERROR: relation "${CANARY}" does not exist\n`);
    put(f, 'db/resolve.exit', '1\n');
    const r = await stopped(f);
    expect(r.out.diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'write' });
    expect(leaks(JSON.stringify(r.out) + readFileSync(r.out.result, 'utf8'))).toEqual([]);
    const g = project();
    put(g, 'db/resolve.lines', '3 10\n');
    expect((await stopped(g)).out.diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'lines' });
    // the file the failed write left is cleared with the rest
    expect(existsSync(join(g.state, 'vol', 'data', 'values.tsv'))).toBe(false);
  });

  test('a write that ran into a time limit, or came out over the byte limit, has its own reason (the script\'s exit codes 124 and 125)', async () => {
    for (const [code, reason] of [['124', 'write-timeout'], ['125', 'too-large']]) {
      const f = project();
      put(f, 'db/resolve.exit', `${code}\n`);
      expect((await stopped(f)).out.diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason });
    }
  });

  test('a statement of phase 1 that ran into the time limit stops the run with its own reason, and the answers are not shown', async () => {
    const f = project();
    put(f, 'db/collision.exit', '3\n');
    put(f, 'db/collision.err', `psql:<stdin>:4: ERROR:  57014 ${CANARY}\n`);
    const r = await stopped(f);
    expect(r.out.diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'collision-timeout' });
    expect(leaks(JSON.stringify(r.out) + readFileSync(r.out.result, 'utf8'))).toEqual([]);
    expect(f.calls().some((c) => c.includes(WRITE))).toBe(false);
  });

  test('a data volume that could not be cleared on a stopped run is in its result and its output, and the stop is still the reason', async () => {
    const f = project(REAL, { version: 1, picks: { a: { table: 'nope', where: ACTIVE, columns: ['x'] } } });
    const r = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_FAIL: 'goodboy-reader: clear-data' });
    expect(r.code).toBe(1);
    expect(r.out.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'picks.a.table', reason: 'unknown-table' });
    const note = 'the data volume could not be cleared; the next run clears it';
    expect(r.out.problems).toEqual([note]);
    expect(JSON.parse(readFileSync(r.out.result, 'utf8')).problems).toEqual([note]);
    // a stopped run whose clear worked has no such note
    const g = project(REAL, { version: 1, picks: { a: { table: 'nope', where: ACTIVE, columns: ['x'] } } });
    const s = await g.inproc('sandbox-run', ['--suite', 'unit']);
    expect(s.out.problems).toBeUndefined();
  });

  test('a data volume that could not be cleared after a passing run is a problem of the result, not a failure of the run', async () => {
    const f = project();
    const r = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_FAIL: 'goodboy-reader: clear-data' });
    expect(r.code).toBe(0);
    expect(r.out.problems).toEqual(['the data volume could not be cleared; the next run clears it']);
  });

  test('the second resolve (after the second reset) stops the run too, after the unit suite ran', async () => {
    const f = project();
    put(f, 'db/resolve.exit.2', '1\n');
    const r = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(r.code).toBe(1);
    expect(r.out.diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'write' });
    // the unit suite ran with the first values, the e2e suite did not run, and the values are gone
    expect(f.calls().some((c) => RUNNER.test(c))).toBe(true);
    expect(f.calls().some((c) => E2E.test(c))).toBe(false);
    expect(f.calls().filter((c) => c.includes(WRITE))).toHaveLength(2);
    expect(existsSync(join(f.state, 'vol', 'data', 'values.tsv'))).toBe(false);
  });

  test('a sandbox set up before M6c (no data volume in the compose file) is told to run sandbox-init --force, and nothing runs', async () => {
    const f = project();
    const cfg = JSON.parse(readFileSync(join(f.state, 'config.json'), 'utf8'));
    for (const svc of Object.values<any>(cfg.services)) if (Array.isArray(svc.volumes)) svc.volumes = svc.volumes.filter((v: unknown) => !String(v).includes('/goodboy-data'));
    delete cfg.volumes.data;
    writeFileSync(join(f.state, 'config.json'), JSON.stringify(cfg));
    const r = await stopped(f);
    expect(r.out.diagnostic).toEqual({ code: 'data-resolve-failed', step: 'resolve', reason: 'no-data-volume' });
    expect(r.out.stopped).toContain('sandbox-init --force');
    expect(f.calls().some((c) => c.includes(RESET) || c.includes('reader:finish'))).toBe(false);
  });

  test('the same old compose file runs as before when there is no manifest', async () => {
    const f = fakeProject(REAL);
    const cfg = JSON.parse(readFileSync(join(f.state, 'config.json'), 'utf8'));
    for (const svc of Object.values<any>(cfg.services)) if (Array.isArray(svc.volumes)) svc.volumes = svc.volumes.filter((v: unknown) => !String(v).includes('/goodboy-data'));
    writeFileSync(join(f.state, 'config.json'), JSON.stringify(cfg));
    expect((await f.inproc('sandbox-run', ['--suite', 'unit'])).code).toBe(0);
  });

  test('a manifest in a project with no SQL store is refused by field and reason, before anything runs', async () => {
    const f = project();
    const scan = JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'scan.json'), 'utf8'));
    scan.stores = [];
    writeFileSync(join(f.root, SANDBOX_DIR, 'scan.json'), JSON.stringify(scan));
    const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(r.code).toBe(1);
    expect(r.out.diagnostic).toEqual({ code: 'data-refused', step: 'resolve', field: 'store', reason: 'no-sql-store' });
    expect(f.calls().some((c) => c.includes(RESET))).toBe(false);
  });
});

describe('a canary row that was resolved never leaves the volume', () => {
  /** Every file under the project, and what the process printed, holds no canary (plain, NFD or hex). */
  function expectNoLeak(f: FakeProject, printed: string): void {
    expect(leaks(printed)).toEqual([]);
    for (const [rel, text] of filesUnder(f.root)) expect([rel, leaks(text)]).toEqual([rel, []]);
    for (const rel of f.hostFiles()) expect(rel).not.toContain(CANARY);
    // the database SQL that goodboy sent holds the manifest's conditions and the run token, no value of the database
    const sql = read(f, 'db-sql.log') ?? '';
    expect(leaks(sql)).toEqual([]);
    expect(sql).toMatch(/'G', 'newUserEmail', 'email', '[0-9a-f]{8}'/);
    // docker was called with no value either
    expect(leaks(f.calls().join('\n'))).toEqual([]);
  }

  test('a passing run through the CLI: stdout, stderr, result.json, state.json and the host files are clean', () => {
    const f = project();
    const r = f.cli(['sandbox-run', '--suite', 'all']);
    expect(r.code).toBe(0);
    expectNoLeak(f, r.stdout + r.stderr);
    expect(JSON.parse(r.stdout).data).toEqual({ picks: 1, counts: 1, generate: 1 });
    expect(read(f, 'data-seen-runner.tsv')).toBe(VALUES);
  });

  test('a failing run, in either suite, and a stopped one are clean too', () => {
    const f = project();
    const r = f.cli(['sandbox-run', '--suite', 'all'], { FAKE_RUNNER_EXIT: '1', FAKE_E2E_EXIT: '1' });
    expect(r.code).toBe(1);
    expectNoLeak(f, r.stdout + r.stderr);
    const g = project();
    put(g, 'db/resolve.exit', '1\n');
    put(g, 'db/resolve.err', `${CANARY}\n`);
    const s = g.cli(['sandbox-run', '--suite', 'all']);
    expect(s.code).toBe(1);
    expectNoLeak(g, s.stdout + s.stderr);
  });

  test('the values are in the volume while the suites run and nowhere on the host', () => {
    const f = project();
    const r = f.cli(['sandbox-run', '--suite', 'unit']);
    expect(r.code).toBe(0);
    // the fake kept what the runner saw: that file is in the state dir (the volume's side), not in the project
    expect(read(f, 'data-seen-runner.tsv')).toContain(hex(CANARY));
    expect(filesUnder(f.root).some(([, t]) => t.includes(hex(CANARY)))).toBe(false);
  });

  test('without real data the same holds: the values are never read by goodboy, whatever the mode', () => {
    const f = project(PLAIN);
    const r = f.cli(['sandbox-run', '--suite', 'all']);
    expect(r.code).toBe(0);
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
    for (const [rel, text] of filesUnder(f.root)) expect([rel, leaks(text)]).toEqual([rel, []]);
  });
});

const hexDirs: string[] = [];
afterAll(() => {
  while (hexDirs.length) rmSync(hexDirs.pop()!, { recursive: true, force: true });
});

describe('the hex of a value reaches the helpers in lowercase on every engine', () => {
  // what MySQL and MariaDB `HEX()` return: uppercase digits (the fake keeps the V lines as given and lowers them only when the
  // SQL of the write says LOWER(HEX(...)); Postgres `encode(..., 'hex')` is lowercase to begin with)
  const upper = VALUES.replace(/^(V\t[^\t]*\t[^\t]*\t[^\t]*\t)(.*)$/gm, (_m, head: string, h: string) => `${head}${h.toUpperCase()}`);
  const scanOf = (kind: 'mysql' | 'mariadb') => {
    const scan = plainScan();
    return { ...scan, stores: [{ ...scan.stores[0]!, kind, version: kind === 'mysql' ? '8.0' : '11' }] };
  };
  /** What `valueOf(pick('activeUser', 0), 'name')` of the CJS helper gives over a values file: the value, or the error's message. */
  const readName = (values: string): { ok?: string; err?: string } => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-hex-')));
    hexDirs.push(dir);
    writeFileSync(join(dir, 'goodboy-data.cjs'), dataHelperCjs());
    writeFileSync(join(dir, 'values.tsv'), values);
    writeFileSync(join(dir, 'driver.cjs'), "const h = require('./goodboy-data.cjs');\ntry { process.stdout.write(JSON.stringify({ ok: h.valueOf(h.pick('activeUser', 0), 'name') })); } catch (e) { process.stdout.write(JSON.stringify({ err: e.message })); }\n");
    const r = Bun.spawnSync(['bun', join(dir, 'driver.cjs')], { env: { ...process.env, GOODBOY_DATA: join(dir, 'values.tsv') }, stdout: 'pipe', stderr: 'pipe' });
    return JSON.parse(r.stdout.toString());
  };

  test('the fixture really is uppercase, and the strict helper does not take it', () => {
    expect(upper).not.toBe(VALUES);
    expect(upper).toMatch(/^V\tactiveUser\taaaa\tname\t[0-9A-F]+$/m);
    expect(readName(upper)).toEqual({ err: 'goodboy-data: malformed data' });
    expect(readName(VALUES)).toEqual({ ok: CANARY });
  });

  for (const kind of ['mysql', 'mariadb'] as const) {
    test(`${kind}: values.tsv holds lowercase hex after the write, and the helper reads it`, async () => {
      const f = fakeProject(REAL, scanOf(kind));
      writeFileSync(manifestPath(f), JSON.stringify(MANIFEST));
      for (const [name, text] of [['db/schema.out', SCHEMA], ['db/enum.out', 'E\t0\t3\n'], ['db/matches.out', 'M\t0\t10\n'], ['db/collision.out', 'X\t0\t0\n'], ['db/resolve.out', upper], ['db/resolve.hex-upper', '']] as const) put(f, name, text);
      const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
      expect(r.code).toBe(0);
      // the client was given a script that lowers each hex, and the file the runner saw is the lowercase one
      expect(read(f, 'db-sql.log')).toContain('LOWER(HEX(');
      const seen = read(f, 'data-seen-runner.tsv');
      expect(seen).toBe(VALUES);
      expect(readName(seen!)).toEqual({ ok: CANARY });
    });
  }

  test('postgres: its own lowercase hex needs no change, and its script holds no LOWER', async () => {
    const f = project();
    put(f, 'db/resolve.hex-upper', '');
    expect((await f.inproc('sandbox-run', ['--suite', 'unit'])).code).toBe(0);
    expect(read(f, 'db-sql.log')).not.toContain('LOWER(');
    expect(read(f, 'data-seen-runner.tsv')).toBe(VALUES);
  });
});
