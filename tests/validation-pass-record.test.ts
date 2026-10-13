// lib/validation-state.ts — the per-project pass record (stabilization plan A3, round 2).
// Complements tests/validation-state.test.ts: how a later record updates a start time, the
// 5-minute clock-skew bound, and which project dirs are trusted.
// Runs against a private TMPDIR: the session and project state dirs both live there.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readValidationFailure, recordValidationPass, writeValidationFailure } from '../lib/validation-state';

let prevTmp: string | undefined;
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'goodboy-vpr-'));
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = box;
});
afterEach(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  try {
    chmodSync(box, 0o700);
  } catch {
    // best-effort
  }
  rmSync(box, { recursive: true, force: true });
});

const TYPECHECK = 'bun run typecheck';
const LINT = 'bun run lint';
const MIN = 60_000;

/** Distinct ISO timestamps: the record order is what is under test. */
function tick(): void {
  const t = Date.now();
  while (Date.now() === t) {
    // spin for the next millisecond
  }
}

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

/** The project state dir the library uses for `root` (inside the private TMPDIR). */
function projectDir(root: string): string {
  return join(box, `goodboy-project-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}`);
}

/** A pass record in both shapes (batch 2's single slot and the per-command map), so a
 *  plant would lift the failure wherever the dir is trusted, on old and new trees alike. */
function plantPass(dir: string, command: string, startedAt: string): void {
  writeFileSync(
    join(dir, 'validation-passed.json'),
    JSON.stringify({ timestamp: startedAt, commands: [command], passes: { [command]: startedAt } }),
    'utf8',
  );
}

describe('the start time a pass record keeps (A3)', () => {
  test('a pass recorded later from a run that started earlier does not move the start time back', () => {
    const slowRunStart = iso(); // a slow check starts on a good tree
    tick();
    writeValidationFailure('sess-a', [TYPECHECK], '/repo'); // another edit breaks it
    tick();
    recordValidationPass('/repo', [TYPECHECK], iso()); // a run that started after the failure passes
    expect(readValidationFailure('sess-a')).toBeNull();
    recordValidationPass('/repo', [TYPECHECK], slowRunStart); // the slow check finishes last
    expect(readValidationFailure('sess-a')).toBeNull();
  });

  test('a run that started at the very moment of the failure does not lift it', () => {
    writeValidationFailure('sess-a', [TYPECHECK], '/repo');
    const failedAt = readValidationFailure('sess-a')?.timestamp ?? '';
    expect(failedAt).not.toBe('');
    recordValidationPass('/repo', [TYPECHECK], failedAt);
    expect(readValidationFailure('sess-a')).not.toBeNull();
  });
});

describe('the 5-minute clock-skew bound (A3)', () => {
  test('a start time 4 minutes ahead is trusted', () => {
    writeValidationFailure('sess-a', [TYPECHECK], '/repo');
    recordValidationPass('/repo', [TYPECHECK], iso(4 * MIN));
    expect(readValidationFailure('sess-a')).toBeNull();
  });

  test('a start time 6 minutes ahead is not', () => {
    writeValidationFailure('sess-b', [LINT], '/repo');
    recordValidationPass('/repo', [LINT], iso(6 * MIN));
    expect(readValidationFailure('sess-b')).not.toBeNull();
  });
});

// POSIX only: the checks compare owner and mode bits.
describe.skipIf(process.platform === 'win32')('which project dirs are trusted (A3)', () => {
  // Any group or other bit: read, write or search. A dir others can only read still lets
  //   them watch the record; one they can search lets them open a file they can guess.
  test.each([['0750'], ['0740'], ['0710'], ['0705'], ['0701']])(
    'a pre-created dir with mode %s is neither read nor written',
    (mode) => {
      const root = `/repo-${mode}`;
      const dir = projectDir(root);
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, Number.parseInt(mode, 8));
      writeValidationFailure('sess-m', [TYPECHECK], root);
      plantPass(dir, TYPECHECK, iso(1000));
      expect(readValidationFailure('sess-m')).not.toBeNull(); // the plant is ignored

      rmSync(join(dir, 'validation-passed.json'));
      recordValidationPass(root, [TYPECHECK], iso(2000));
      expect(existsSync(join(dir, 'validation-passed.json'))).toBe(false); // nothing recorded there
    },
  );

  test('a 0700 dir of this user, made before the first pass, is trusted', () => {
    const root = '/repo-0700';
    const dir = projectDir(root);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    writeValidationFailure('sess-ok', [TYPECHECK], root);
    plantPass(dir, TYPECHECK, iso(1000));
    expect(readValidationFailure('sess-ok')).toBeNull();
  });

  test('a symlink planted as the dir is not read, even to a 0700 dir of this user', () => {
    const root = '/repo-link';
    const target = mkdtempSync(join(box, 'planted-')); // mkdtemp: 0700, owned by this user
    writeValidationFailure('sess-l', [TYPECHECK], root);
    plantPass(target, TYPECHECK, iso(1000));
    symlinkSync(target, projectDir(root));
    expect(readValidationFailure('sess-l')).not.toBeNull();
  });
});
