// Track M, M6a (plan §19): the failure paths of the output boundary that the canary tests do not
// reach: an atomic write that fails, the real-data flag that cannot be cleared, host raw files the
// sweep cannot list or look at, a sweep that gets a broken context, a volume sweep with no host
// `out/`, and a ui-check verdict that cannot be stored.

import { afterEach, describe, expect, setDefaultTimeout, setSystemTime, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRealData, writeAtomic } from '../lib/sandbox-files';
import { readLocal, SANDBOX_DIR } from '../lib/sandbox-mode';
import { type StoreCtx, SWEEP_FAILED, sweepRaw } from '../lib/sandbox-store';
import { cleanupFakeProjects, fakeProject } from './m6a-project';

setDefaultTimeout(120_000);

const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const notRoot = process.getuid?.() !== 0;
const scratch: string[] = [];
const toRestore: string[] = [];

afterEach(() => {
  // a mode that cannot be put back (the dir is gone) must not skip the removal of everything else
  try {
    setSystemTime();
    for (const p of toRestore.splice(0)) {
      try {
        chmodSync(p, 0o755);
      } catch {
        // gone
      }
    }
  } finally {
    cleanupFakeProjects();
    while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
  }
});

describe('writeAtomic', () => {
  test('a write that fails throws the error and leaves no temp file behind', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6a-gap-')));
    scratch.push(dir);
    expect(() => writeAtomic(join(dir, 'missing', 'x.json'), 'text')).toThrow(/ENOENT/);
    expect(readdirSync(dir)).toEqual([]);
    // a parent that exists is written, and no temp name is left
    writeAtomic(join(dir, 'x.json'), 'text');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  test('a rename that fails, after the temp file was written, removes the temp file and throws', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6a-gap-')));
    scratch.push(dir);
    // a non-empty directory where the file goes: writing the temp name works, the rename onto it does not
    mkdirSync(join(dir, 'x.json', 'keep'), { recursive: true });
    expect(() => writeAtomic(join(dir, 'x.json'), 'text')).toThrow();
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(dir)).toEqual(['x.json']);
    expect(existsSync(join(dir, 'x.json', 'keep'))).toBe(true);
  });
});

describe('clearRealData', () => {
  test.skipIf(!notRoot)('a local file that cannot be rewritten gives the error and keeps the flag', () => {
    const f = fakeProject(REAL);
    const dir = join(f.root, SANDBOX_DIR);
    chmodSync(dir, 0o555);
    toRestore.push(dir);
    let r: Error | null;
    try {
      r = clearRealData(f.root);
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(r).toBeInstanceOf(Error);
    const local = readLocal(f.root);
    expect(local instanceof Error ? null : local.realData).toBe(true);
  });
});

describe('the sweep of host raw files and of a broken context', () => {
  test.skipIf(!notRoot)('an out/ that cannot be listed is not a failure and not a crash', async () => {
    const f = fakeProject(REAL);
    const out = join(f.root, SANDBOX_DIR, 'out');
    mkdirSync(out, { recursive: true });
    chmodSync(out, 0o000);
    toRestore.push(out);
    expect(await sweepRaw(f.ctx, false)).toBeNull();
  });

  test.skipIf(!notRoot)('a run dir that cannot be looked at is one failed entry: the sweep says it failed', async () => {
    const f = fakeProject(REAL);
    const out = join(f.root, SANDBOX_DIR, 'out');
    mkdirSync(join(out, '20261001T000000Z'), { recursive: true });
    // listable but not searchable: the entry is listed and cannot be looked at
    chmodSync(out, 0o444);
    toRestore.push(out);
    expect(await sweepRaw(f.ctx, false)).toEqual(SWEEP_FAILED);
  });

  test('a context that is broken gives the failed diagnostic, never a throw', async () => {
    expect(await sweepRaw(null as unknown as StoreCtx, true)).toEqual(SWEEP_FAILED);
  });

  test('an old run in the volume goes when the host has no out/ at all', async () => {
    const f = fakeProject(REAL);
    const old = join(f.state, 'vol', 'outroot', '20260101T000000Z');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'output.log'), 'raw');
    expect(existsSync(join(f.root, SANDBOX_DIR, 'out'))).toBe(false);
    const r = await f.inproc('sandbox-check');
    expect(r.out.sweep).toBeUndefined();
    expect(readdirSync(join(f.state, 'vol', 'outroot'))).toEqual([]);
    // it was the last run and none is in progress: the scratch volumes are cleared in the same call
    expect(f.calls().filter((l) => l.startsWith('reader:finish'))).toEqual(['reader:finish clear 20260101T000000Z']);
  });
});

describe('a ui-check verdict that cannot be stored', () => {
  test('the run says so as a problem, keeps its result, and writes no verdict', async () => {
    const f = fakeProject(REAL);
    // a frozen clock: the run's directory name is known before the run
    setSystemTime(new Date('2026-12-01T00:00:00.000Z'));
    const ts = '20261201T000000Z';
    const verdict = join(f.root, SANDBOX_DIR, 'out', ts, 'ui-check.json');
    // a non-empty directory where the verdict goes: the rename onto it fails
    mkdirSync(join(verdict, 'keep'), { recursive: true });
    const r = await f.inproc('sandbox-run', ['--suite', 'e2e']);
    setSystemTime();
    expect(r.out.ts).toBe(ts);
    expect(JSON.stringify(r.out.e2e.problems)).toContain('the ui-check verdict could not be stored');
    expect(existsSync(join(verdict, 'keep'))).toBe(true);
    expect(existsSync(join(f.root, SANDBOX_DIR, 'out', ts, 'result.json'))).toBe(true);
    expect(readFileSync(join(f.root, SANDBOX_DIR, 'out', ts, 'result.json'), 'utf8')).toContain('"realData": true');
  });
});
