// Field report #44, plan §15.36 item 3: two Stops of one session ask for the agent-deferral clock at the same moment.
// The first to create it (`wx`) wins; the other gets EEXIST and must judge the winner's clock. The race cannot be
// timed from a test, so the loser is made by wrapping `writeFileSync` once: the competitor's clock appears and the
// call fails with EEXIST, as the real second `wx` write does. Everything else is real (a private TMPDIR, real files).

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_DEFERRAL_CAP_MS, DEFERRAL_FILE, deferralOpen } from '../lib/agent-deferral';

const SID = 'sess-44-race';
let prevTmp: string | undefined;
let box = '';

beforeEach(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-v44race-')));
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = box;
});
afterEach(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  rmSync(box, { recursive: true, force: true });
});

const clock = (): string => join(box, `goodboy-session-${SID}`, DEFERRAL_FILE);

/** Runs `fn` while the first write of the clock file loses a race to a competitor that started its clock `competitorStart`. */
function losingTheRace<T>(competitorStart: number, fn: () => T): T {
  const real = fs.writeFileSync;
  const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
    if (typeof path === 'string' && path === clock()) {
      real(path, JSON.stringify({ start: competitorStart }), { mode: 0o600 });
      const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException;
      err.code = 'EEXIST';
      throw err;
    }
    return real(path, data as string, options as fs.WriteFileOptions);
  }) as typeof fs.writeFileSync);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe('deferralOpen when another Stop starts the clock first', () => {
  test('the loser judges the winner clock: open while it is within the 45 minutes', () => {
    const now = Date.now();
    expect(losingTheRace(now - 1000, () => deferralOpen(SID, now))).toBe(true);
    expect(JSON.parse(readFileSync(clock(), 'utf8'))).toEqual({ start: now - 1000 });
  });

  test('and closed when the winner clock is already past the cap (no restart from the loser)', () => {
    const now = Date.now();
    expect(losingTheRace(now - AGENT_DEFERRAL_CAP_MS - 1000, () => deferralOpen(SID, now))).toBe(false);
  });

  test('a write that fails with any other error closes the deferral and starts nothing', () => {
    const real = fs.writeFileSync;
    const spy = spyOn(fs, 'writeFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
      if (typeof path === 'string' && path === clock()) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return real(path, data as string, options as fs.WriteFileOptions);
    }) as typeof fs.writeFileSync);
    try {
      expect(deferralOpen(SID)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(clock())).toBe(false);
  });
});
