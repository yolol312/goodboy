// lib/validation-state.ts — failures per session, passes per project (A3).
// Runs against a private TMPDIR: the session and project state dirs both live there.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearValidationFailure,
  readValidationFailure,
  recordValidationPass,
  writeValidationFailure,
} from '../lib/validation-state';

let prevTmp: string | undefined;
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'goodboy-vs-'));
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = box;
});
afterEach(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  rmSync(box, { recursive: true, force: true });
});

/** Distinct ISO timestamps: the record order is what is under test. */
function tick(): void {
  const t = Date.now();
  while (Date.now() === t) {
    // spin for the next millisecond
  }
}

describe('validation failure marker (A3)', () => {
  test('a failure blocks its own session only', () => {
    writeValidationFailure('sess-a', ['bun run typecheck'], '/repo');
    expect(readValidationFailure('sess-a')?.commands).toEqual(['bun run typecheck']);
    expect(readValidationFailure('sess-b')).toBeNull();
  });

  test("another session's failure does not replace this session's marker", () => {
    writeValidationFailure('sess-a', ['bun run typecheck'], '/repo');
    writeValidationFailure('sess-b', ['bun run lint'], '/repo');
    expect(readValidationFailure('sess-a')?.commands).toEqual(['bun run typecheck']);
  });

  test('a later pass of the same commands in the same project makes the failure stale', () => {
    writeValidationFailure('sess-a', ['bun run typecheck'], '/repo');
    tick();
    recordValidationPass('/repo', ['bun run typecheck']);
    expect(readValidationFailure('sess-a')).toBeNull();
  });

  test('a pass in another project, of other commands, or before the failure does not', () => {
    recordValidationPass('/repo', ['bun run typecheck']);
    tick();
    writeValidationFailure('sess-a', ['bun run typecheck', 'bun run lint'], '/repo');
    expect(readValidationFailure('sess-a')).not.toBeNull(); // the pass came first
    tick();
    recordValidationPass('/other-repo', ['bun run typecheck', 'bun run lint']);
    expect(readValidationFailure('sess-a')).not.toBeNull(); // another project
    recordValidationPass('/repo', ['bun run typecheck']);
    expect(readValidationFailure('sess-a')).not.toBeNull(); // lint has not passed
    recordValidationPass('/repo', ['bun run lint', 'bun run typecheck']);
    expect(readValidationFailure('sess-a')).toBeNull();
  });

  test('a marker without a project root is never made stale by a pass', () => {
    writeValidationFailure('sess-a', ['bun run typecheck']);
    tick();
    recordValidationPass('/repo', ['bun run typecheck']);
    expect(readValidationFailure('sess-a')).not.toBeNull();
  });

  test('clear removes this session marker only', () => {
    writeValidationFailure('sess-a', ['x'], '/repo');
    writeValidationFailure('sess-b', ['x'], '/repo');
    clearValidationFailure('sess-b');
    expect(readValidationFailure('sess-a')).not.toBeNull();
    expect(readValidationFailure('sess-b')).toBeNull();
  });
});
