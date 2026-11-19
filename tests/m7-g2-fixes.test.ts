// Track M, M7 full review, group G2 (run and boundary): the per-project lock, the result of `--suite all`, the
// step-failed diagnostic, a run that timed out as proof, the skipped volume sweep, the privacy file caps.
// Each test fails on the code before the fix.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privacyFilesOf, privacySetupOf, usesDataHelper } from '../lib/privacy-files';
import { lockSandbox } from '../lib/sandbox-lock';
import { SANDBOX_DIR } from '../lib/sandbox-mode';
import { readRunResult, sandboxProof, sha } from '../lib/sandbox-proof';
import type { TestResult } from '../lib/types';
import { cleanupFakeProjects, type FakeProject, fakeProject } from './m6a-project';

setDefaultTimeout(120_000);
const tmpDirs: string[] = [];
afterEach(() => {
  cleanupFakeProjects();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const PLAIN = { dump: null, dumpFormat: null } as const;

const lockPath = (f: FakeProject): string => join(f.root, SANDBOX_DIR, 'out', '.lock');
const holdLock = (f: FakeProject, pid: number, started = new Date().toISOString(), command = 'sandbox-run'): void => {
  mkdirSync(join(f.root, SANDBOX_DIR, 'out'), { recursive: true });
  writeFileSync(lockPath(f), `${JSON.stringify({ pid, started, command })}\n`);
};
/** A pid that no process has: a child that has exited. */
const deadPid = (): number => {
  const p = Bun.spawnSync(['true']);
  return p.pid;
};

describe('G2-1: one sandbox command at a time per project', () => {
  test('a command that changes state fails at once and names the holder while a live one holds the lock; no docker call is made', async () => {
    for (const command of ['sandbox-run', 'sandbox-up', 'sandbox-down', 'sandbox-prepare']) {
      const f = fakeProject(PLAIN);
      // a start time well inside the 6 h takeover age, relative to now (a fixed date turns stale as the day goes on)
      const started = new Date(Date.now() - 60_000).toISOString();
      holdLock(f, process.pid, started, 'sandbox-run');
      const r = await f.inproc(command, command === 'sandbox-run' ? ['--suite', 'unit'] : []);
      expect([command, r.code]).toEqual([command, 1]);
      expect(r.error).toContain(`${command}: another sandbox command of this project is running: sandbox-run (pid ${process.pid}, started ${started})`);
      // the message names the lock file, so a user can remove a lock held by a reused pid
      expect(r.error).toContain(`remove ${lockPath(f)}`);
      expect([command, f.calls()]).toEqual([command, []]);
      // the lock of the other command is left alone
      expect(JSON.parse(readFileSync(lockPath(f), 'utf8'))).toMatchObject({ pid: process.pid, command: 'sandbox-run' });
    }
  });

  test('two sandbox-run commands started together: one runs, the other is refused, and the lock is gone afterwards', async () => {
    const f = fakeProject(PLAIN);
    const [a, b] = await Promise.all([f.inproc('sandbox-run', ['--suite', 'unit']), f.inproc('sandbox-run', ['--suite', 'unit'])]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(1);
    expect(b.error).toContain('another sandbox command of this project is running: sandbox-run');
    // the refused one cleared and reset nothing: one reset call per run, and only one run
    expect(f.calls().filter((l) => l.includes('reset.sh'))).toHaveLength(1);
    expect(existsSync(lockPath(f))).toBe(false);
    expect(f.hostFiles().filter((n) => n.endsWith('result.json'))).toHaveLength(1);
  });

  test('the lock is released after a command, also one that failed, so the next one runs', async () => {
    const f = fakeProject(PLAIN);
    const failed = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_FAIL: 'reset.sh' });
    expect(failed.code).toBe(1);
    expect(existsSync(lockPath(f))).toBe(false);
    expect((await f.inproc('sandbox-run', ['--suite', 'unit'])).code).toBe(0);
    expect(existsSync(lockPath(f))).toBe(false);
  });

  test('a lock whose process is gone is taken over; so is one older than 6 h (a reused pid), and a broken one after a grace', async () => {
    const f = fakeProject(PLAIN);
    holdLock(f, deadPid());
    expect((await f.inproc('sandbox-run', ['--suite', 'unit'])).code).toBe(0);
    expect(existsSync(lockPath(f))).toBe(false);
    // a live pid that started 7 h ago is a reused pid, not a holder
    holdLock(f, process.pid, new Date(Date.now() - 7 * 3_600_000).toISOString());
    expect((await f.inproc('sandbox-up')).error).toBeUndefined();
    // a file with no usable content: just made is a holder in the middle of writing, old is broken
    writeFileSync(lockPath(f), 'garbage');
    expect((await f.inproc('sandbox-up')).error).toContain('was just made by another sandbox command');
    const t = Date.now() + 60_000;
    const lock = lockSandbox(join(f.root, SANDBOX_DIR, 'out'), 'sandbox-up', () => t);
    expect('release' in lock).toBe(true);
    if ('release' in lock) lock.release();
  });

  test('a lock that is not a regular file is refused with its path, never followed', async () => {
    const f = fakeProject(PLAIN);
    mkdirSync(lockPath(f), { recursive: true });
    const r = await f.inproc('sandbox-up');
    expect(r.error).toContain('is not a regular file');
    expect(f.calls()).toEqual([]);
  });

  test('sandbox-check and sandbox-data only read: a held lock does not stop them', async () => {
    const f = fakeProject(PLAIN);
    holdLock(f, process.pid);
    const r = await f.inproc('sandbox-check');
    expect(r.error).toBeUndefined();
    expect(r.code).toBe(0);
  });
});

describe('G2 low: the result of --suite all, and the step-failed diagnostic', () => {
  test('the top-level duration is both steps and the tail and diagnostic are the failing step\'s', async () => {
    const f = fakeProject(PLAIN);
    writeFileSync(join(f.state, 'e2e-out.txt'), 'browser said it failed\n');
    const r = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_RUNNER_EXIT: '0', FAKE_E2E_EXIT: '1' });
    expect(r.code).toBe(1);
    const o = r.out;
    expect(o.unit.exit).toBe(0);
    expect(o.e2e.exit).toBe(1);
    expect(o.exit).toBe(1);
    expect(o.tail).toBe(o.e2e.tail);
    expect(o.tail).toContain('browser said it failed');
    expect(o.durationMs).toBe(o.unit.durationMs + o.e2e.durationMs);
  });

  test('real data: a failing suite step leaves the code step-failed, a passing one and a plain project none', async () => {
    const f = fakeProject(REAL);
    const bad = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_RUNNER_EXIT: '1', FAKE_E2E_EXIT: '1' });
    expect(bad.out.unit.diagnostic).toEqual({ code: 'step-failed', step: 'unit', exit: 1, timedOut: false });
    expect(bad.out.e2e.diagnostic).toEqual({ code: 'step-failed', step: 'e2e', exit: 1, timedOut: false });
    // the result names the deciding step (the first that failed)
    expect(bad.out.diagnostic).toEqual(bad.out.unit.diagnostic);
    const e2eOnly = await f.inproc('sandbox-run', ['--suite', 'all'], { FAKE_RUNNER_EXIT: '0', FAKE_E2E_EXIT: '1' });
    expect(e2eOnly.out.unit.diagnostic).toBeUndefined();
    expect(e2eOnly.out.diagnostic).toEqual({ code: 'step-failed', step: 'e2e', exit: 1, timedOut: false });
    const unitOnly = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_RUNNER_EXIT: '2' });
    expect(unitOnly.out.diagnostic).toEqual({ code: 'step-failed', step: 'unit', exit: 2, timedOut: false });
    const ok = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(ok.out.diagnostic).toBeUndefined();
    expect(ok.out.unit.diagnostic).toBeUndefined();
    const plain = await fakeProject(PLAIN).inproc('sandbox-run', ['--suite', 'unit'], { FAKE_RUNNER_EXIT: '1' });
    expect(plain.out.diagnostic).toBeUndefined();
  });
});

describe('G2 low: a run that timed out is no proof', () => {
  const run = '20261101T000000Z';
  function proofOf(result: Record<string, unknown>): { root: string; record: TestResult } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g2-proof-')));
    tmpDirs.push(root);
    mkdirSync(join(root, SANDBOX_DIR, 'out', run), { recursive: true });
    const text = JSON.stringify({ ts: run, command: ['npm', 'test'], check: { inner_only: true, egress_blocked: true, hosts_to_dummies: true }, ...result });
    writeFileSync(join(root, SANDBOX_DIR, 'out', run, 'result.json'), text);
    const record = { timestamp: '2026-11-02T00:00:00.000Z', sandbox: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, run, result_sha256: sha(text) } } as unknown as TestResult;
    return { root, record };
  }

  test('exit 0 with timedOut true is refused with its own reason; without it the proof stands', () => {
    const timed = proofOf({ exit: 0, timedOut: true });
    expect((readRunResult(timed.root, run) as { timedOut: boolean }).timedOut).toBe(true);
    expect(sandboxProof(timed.root, timed.record)).toBe(`run ${run} ran out of time (result.json says timedOut)`);
    const fine = proofOf({ exit: 0, timedOut: false });
    expect(typeof sandboxProof(fine.root, fine.record)).toBe('object');
    // a result that does not say counts as not timed out (results of earlier runs)
    const older = proofOf({ exit: 0 });
    expect(typeof sandboxProof(older.root, older.record)).toBe('object');
  });
});

describe('G2 low: the volume sweep that cannot run says so', () => {
  test('a runs volume with an unsafe compose file is not swept and the diagnostic carries the reason; a safe one has none', async () => {
    const f = fakeProject(PLAIN);
    expect((await f.inproc('sandbox-check')).out.sweep).toBeUndefined();
    writeFileSync(join(f.state, 'config.json'), JSON.stringify({ services: { app: { image: 'x', ports: [{ target: 80, published: '80' }] } } }));
    const r = await f.inproc('sandbox-check');
    expect(r.out.sweep).toEqual({ code: 'sweep-failed', step: 'sweep', reason: 'volume-sweep-skipped' });
  });
});

describe('G2 low: the privacy file caps count bytes, and the helper words are looked for first', () => {
  const dir = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g2-priv-')));
    tmpDirs.push(root);
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    return root;
  };

  test('a file of two-byte characters counts its bytes against the total, in a changed-files answer and in a setup', () => {
    const top = dir();
    writeFileSync(join(top, 'a.ts'), 'é'.repeat(100)); // 100 characters, 200 bytes
    writeFileSync(join(top, 'b.ts'), 'export {};\n');
    // after a.ts the total is 200 bytes, over 150: b.ts is not read and counts as a privacy file
    expect([...privacyFilesOf(top, ['a.ts', 'b.ts'], top, { totalBytes: 150 })]).toEqual(['b.ts']);
    expect(privacySetupOf(top, { totalBytes: 150 })).toEqual({ ok: false, why: 'cap' });
    expect(privacySetupOf(top, { totalBytes: 250 })).toEqual({ ok: true, files: [] });
  });

  test('a mention is found as before, whatever the case of the word, and a text with none is no user', () => {
    const uses = (text: string, rel = 'src/a.ts'): boolean => usesDataHelper(rel, text);
    expect(uses("import { pick } from '../.goodboy/sandbox/data/goodboy-data';")).toBe(true);
    expect(uses('const v = process.env.GOODBOY_DATA;')).toBe(true);
    expect(uses('class X { GoodboyData d; }', 'A.java')).toBe(true);
    expect(uses('const p = ".goodboy/sandbox/data/x";')).toBe(true);
    expect(uses('// GOODBOY_DATA only in a comment')).toBe(false);
    expect(uses('export const nothing = 1;\n/* a comment */')).toBe(false);
    expect(uses('')).toBe(false);
  });
});
