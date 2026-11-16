// Track M, M6b (plan §19): the follow-ups of the M6a reviews that M6b fixes: the old-run scan that read 200 dirs
// in no order, a docker outage that made a plain project strict and deleted its raw log, and the way out the
// ui-check message gives a project that counts as real data only because of old files.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_RAW_NAMES, projectName, realDataForReading, realDataOfRoot, realOrSelf, RUN_NAME, SANDBOX_DIR } from '../lib/sandbox-mode';
import { cmdUiCheck } from '../lib/ui-check';
import { cleanupFakeProjects, fakeProject, type FakeProject } from './m6a-project';

setDefaultTimeout(120_000);
afterEach(cleanupFakeProjects);

const runName = (i: number): string => `20250101T${String(Math.floor(i / 3600)).padStart(2, '0')}${String(Math.floor(i / 60) % 60).padStart(2, '0')}${String(i % 60).padStart(2, '0')}Z`;
const runDir = (f: FakeProject, name: string, result: string | null): string => {
  const d = join(f.root, SANDBOX_DIR, 'out', name);
  mkdirSync(d, { recursive: true });
  if (result !== null) writeFileSync(join(d, 'result.json'), result);
  return d;
};

describe('the small module a hook can load (lib/sandbox-mode.ts)', () => {
  test('realOrSelf keeps a path that is not there', () => {
    expect(realOrSelf('/nonexistent/goodboy/x')).toBe('/nonexistent/goodboy/x');
  });

  test('the run-dir name and the raw names are what the writers write: the sweep of a real-data project removes every one of them', async () => {
    expect(RUN_NAME.test('20261022T031816Z')).toBe(true);
    expect(RUN_NAME.test('20261022T031816')).toBe(false);
    expect(RUN_NAME.test('live')).toBe(false);
    expect(new Set(HOST_RAW_NAMES).size).toBe(HOST_RAW_NAMES.length);
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    const d = runDir(f, '20260101T000000Z', '{"realData": true}');
    for (const n of HOST_RAW_NAMES) {
      if (n === 'e2e-artifacts') {
        mkdirSync(join(d, n), { recursive: true });
        writeFileSync(join(d, n, 'trace.zip'), 'raw');
      } else writeFileSync(join(d, n), 'raw');
    }
    await f.inproc('sandbox-check');
    for (const n of HOST_RAW_NAMES) expect([n, existsSync(join(d, n))]).toEqual([n, false]);
    expect(existsSync(join(d, 'result.json'))).toBe(true);
  });
});

describe('old runs with no local.json (rawMayRemain)', () => {
  test('a project with a few runs that all say realData false is plain; one that does not say it is real data', () => {
    const f = fakeProject(null);
    for (let i = 0; i < 50; i++) runDir(f, runName(i), '{"realData": false}');
    expect(realDataForReading(f.root)).toBe(false);
    runDir(f, runName(51), '{"ts": "no field: a run from before M6a"}');
    expect(realDataForReading(f.root)).toBe(true);
    expect(realDataOfRoot(f.root)).toBe(false);
  });

  test('more than 200 runs are more than the scan reads: fail closed, whatever the 200 say', () => {
    const f = fakeProject(null);
    for (let i = 0; i < 200; i++) runDir(f, runName(i), '{"realData": false}');
    expect(realDataForReading(f.root)).toBe(false);
    runDir(f, runName(200), '{"realData": false}');
    expect(realDataForReading(f.root)).toBe(true);
  });

  test('every run up to the cap is read: a real run is found wherever it sorts, first, middle or last', () => {
    for (const at of [0, 100, 199]) {
      const f = fakeProject(null);
      for (let i = 0; i < 200; i++) runDir(f, runName(i), i === at ? '{"realData": true}' : '{"realData": false}');
      expect([at, realDataForReading(f.root)]).toEqual([at, true]);
    }
  });

  test('a local.json that says plain, with the same runs, stays plain (the scan is for a missing file only)', () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: false });
    for (let i = 0; i < 250; i++) runDir(f, runName(i), '{}');
    expect(realDataForReading(f.root)).toBe(false);
  });
});

describe('a docker that does not answer', () => {
  const rawLog = (f: FakeProject): string => join(runDir(f, '20260101T000000Z', '{"realData": false}'), 'output.log');

  test('a plain project keeps the old raw log: the outage made the output strict, which does not prove real data', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: false });
    const log = rawLog(f);
    writeFileSync(log, 'plain output of an earlier run');
    const r = await f.inproc('sandbox-check', [], { FAKE_FAIL: 'volume ls', FAKE_FAIL_TEXT: 'Cannot connect to the Docker daemon' });
    // the answer is strict (a code, no text), and nothing was deleted
    expect(r.text).not.toContain('Cannot connect');
    expect(existsSync(log)).toBe(true);
    expect(r.out.sweep).toBeUndefined();
  });

  test('a project that says real data in local.json has its old raw log removed, outage or not', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    const log = rawLog(f);
    writeFileSync(log, 'raw');
    await f.inproc('sandbox-check', [], { FAKE_FAIL: 'volume ls' });
    expect(existsSync(log)).toBe(false);
  });

  test('a database volume is proof: a project with no local.json and a data volume has its old raw log removed', async () => {
    const f = fakeProject(null);
    const log = rawLog(f);
    writeFileSync(log, 'raw');
    writeFileSync(join(f.state, 'volumes.txt'), `${projectName(f.root)}_runout\n${projectName(f.root)}_db1data\n`);
    await f.inproc('sandbox-check');
    expect(existsSync(log)).toBe(false);
  });

  test('a plain project with docker answering keeps its raw log too', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: false });
    const log = rawLog(f);
    writeFileSync(log, 'plain output');
    await f.inproc('sandbox-check');
    expect(existsSync(log)).toBe(true);
  });
});

describe('ui-check on a project that is real data only because of old files', () => {
  const OLD = '20250101T000000Z';

  test('the error says why and the user\'s two ways out', () => {
    const f = fakeProject(null);
    runDir(f, OLD, '{"ts": "20250101T000000Z", "exit": 0}');
    expect(realDataForReading(f.root)).toBe(true);
    const r = cmdUiCheck(f.root, ['--run', OLD]);
    expect('error' in r && r.error).toContain('has no stored verdict');
    const msg = 'error' in r ? r.error : '';
    expect(msg).toContain('counts as real data only because .goodboy/sandbox/local.json is missing');
    expect(msg).toContain('the user can end this by removing those old run dirs');
    expect(msg).toContain('"realData": false');
    const refused = cmdUiCheck(f.root, ['--log', '/tmp/x.log']);
    expect('error' in refused && refused.error).toContain('the user can end this by removing');
  });

  test('a project whose local.json says real data gets no such hint: there is no way out of that by deleting files', () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    runDir(f, OLD, '{"ts": "x"}');
    const r = cmdUiCheck(f.root, ['--run', OLD]);
    expect('error' in r && r.error).toContain('has no stored verdict');
    expect('error' in r && r.error).not.toContain('can end this');
  });

  test('both ways out work: the old run dirs gone, or a local.json that says plain', () => {
    const f = fakeProject(null);
    const d = runDir(f, OLD, '{"ts": "x"}');
    expect(realDataForReading(f.root)).toBe(true);
    // the first way: the old run dirs are removed
    rmSync(join(f.root, SANDBOX_DIR, 'out'), { recursive: true, force: true });
    expect(existsSync(d)).toBe(false);
    expect(realDataForReading(f.root)).toBe(false);
    // the second way: the dirs stay and a local.json says plain
    runDir(f, OLD, '{"ts": "x"}');
    expect(realDataForReading(f.root)).toBe(true);
    writeFileSync(join(f.root, SANDBOX_DIR, 'local.json'), JSON.stringify({ dump: null, dumpFormat: null, realData: false }));
    expect(realDataForReading(f.root)).toBe(false);
    expect(existsSync(d)).toBe(true);
  });
});
