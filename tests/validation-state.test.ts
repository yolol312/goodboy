// lib/validation-state.ts — failures per session, passes per project (A3).
// Runs against a private TMPDIR: the session and project state dirs both live there.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** A pass of `commands` in a run that starts now. */
function pass(root: string, commands: string[]): void {
  recordValidationPass(root, commands, new Date().toISOString());
}

/** The project state dir the library uses for `root` (inside the private TMPDIR). */
function projectDir(root: string): string {
  return join(box, `goodboy-project-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}`);
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

  test('a pass of the same commands that started after the failure makes it stale', () => {
    writeValidationFailure('sess-a', ['bun run typecheck'], '/repo');
    tick();
    pass('/repo', ['bun run typecheck']);
    expect(readValidationFailure('sess-a')).toBeNull();
  });

  test('a pass in another project, of other commands, or before the failure does not', () => {
    pass('/repo', ['bun run typecheck']);
    tick();
    writeValidationFailure('sess-a', ['bun run typecheck', 'bun run lint'], '/repo');
    expect(readValidationFailure('sess-a')).not.toBeNull(); // the pass came first
    tick();
    pass('/other-repo', ['bun run typecheck', 'bun run lint']);
    expect(readValidationFailure('sess-a')).not.toBeNull(); // another project
    pass('/repo', ['bun run typecheck']);
    expect(readValidationFailure('sess-a')).not.toBeNull(); // lint has not passed
    pass('/repo', ['bun run lint']);
    expect(readValidationFailure('sess-a')).toBeNull(); // both passed since, in separate runs
  });

  test('a run that started before the failure does not lift it, even when it is recorded after', () => {
    const startedEarlier = new Date().toISOString();
    tick();
    writeValidationFailure('sess-a', ['bun run typecheck'], '/repo');
    tick();
    recordValidationPass('/repo', ['bun run typecheck'], startedEarlier); // finished after the failure
    expect(readValidationFailure('sess-a')).not.toBeNull();
  });

  test('a later pass of other commands keeps the passes already recorded', () => {
    writeValidationFailure('sess-a', ['bun run lint'], '/repo');
    tick();
    pass('/repo', ['bun run typecheck', 'bun run lint']);
    expect(readValidationFailure('sess-a')).toBeNull();
    tick();
    pass('/repo', ['bun run typecheck']); // typecheck only
    expect(readValidationFailure('sess-a')).toBeNull();
  });

  test('a pass that starts beyond the clock skew is not trusted', () => {
    writeValidationFailure('sess-a', ['bun run typecheck'], '/repo');
    recordValidationPass('/repo', ['bun run typecheck'], '2999-01-01T00:00:00.000Z');
    expect(readValidationFailure('sess-a')).not.toBeNull();
  });

  test('a failure without commands is never stale', () => {
    writeValidationFailure('sess-a', [], '/repo');
    tick();
    pass('/repo', ['bun run typecheck']);
    expect(readValidationFailure('sess-a')).not.toBeNull();
  });

  test('a marker without a project root is never made stale by a pass', () => {
    writeValidationFailure('sess-a', ['bun run typecheck']);
    tick();
    pass('/repo', ['bun run typecheck']);
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

// The project dir name can be computed from the project path, so on a shared /tmp someone
// else can create it first. POSIX only: the checks compare owner and mode bits.
describe.skipIf(process.platform === 'win32')('project pass record trust (A3)', () => {
  test('a pass planted in a directory others can write to is ignored', () => {
    const dir = projectDir('/repo');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777);
    writeValidationFailure('sess-a', ['bun run typecheck'], '/repo');
    writeFileSync(
      join(dir, 'validation-passed.json'),
      JSON.stringify({ passes: { 'bun run typecheck': new Date(Date.now() + 1000).toISOString() } }),
      'utf8',
    );
    expect(readValidationFailure('sess-a')).not.toBeNull();
  });

  test('a pass is not written through a symlink planted as the directory', () => {
    const target = mkdtempSync(join(box, 'elsewhere-'));
    symlinkSync(target, projectDir('/repo'));
    pass('/repo', ['bun run typecheck']);
    expect(() => readFileSync(join(target, 'validation-passed.json'), 'utf8')).toThrow();
  });

  test('a pass is not written through a symlink planted as the record', () => {
    const victim = join(box, 'victim.txt');
    writeFileSync(victim, 'precious\n', 'utf8');
    pass('/repo', ['bun run typecheck']); // creates the trusted dir
    const record = join(projectDir('/repo'), 'validation-passed.json');
    rmSync(record);
    symlinkSync(victim, record);
    pass('/repo', ['bun run typecheck']);
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
  });
});
