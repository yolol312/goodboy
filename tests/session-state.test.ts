// lib/session-state.ts — the task state written by a category command (A3).
// The gates read the session-dir copy; the repo-level copy is kept for the subagents and
// read back only when the session copy is missing.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionDir } from '../lib/file-tracker';
import { SESSION_STATE_FILE, readSessionState, writeSessionState } from '../lib/session-state';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    try {
      rmSync(cleanup.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function newSession(): string {
  const id = `goodboy-ss-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  cleanup.push(ensureSessionDir(id));
  return id;
}

function newCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-ss-cwd-'));
  cleanup.push(d);
  return d;
}

function writeRepoCopy(cwd: string, state: Record<string, unknown>): void {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude', SESSION_STATE_FILE), JSON.stringify(state), 'utf8');
}

describe('session state (A3)', () => {
  test('write then read round-trips, both copies are written, and the session id is stamped', () => {
    const s = newSession();
    const cwd = newCwd();
    writeSessionState(cwd, s, { category: 'migrate', risk: 'risky', riskReason: 'default' });
    expect(readSessionState(cwd, s)).toMatchObject({ category: 'migrate', risk: 'risky', riskReason: 'default', sessionId: s });
    expect(existsSync(join(ensureSessionDir(s), SESSION_STATE_FILE))).toBe(true);
    const repoCopy = JSON.parse(readFileSync(join(cwd, '.claude', SESSION_STATE_FILE), 'utf8'));
    expect(repoCopy.sessionId).toBe(s);
  });

  test('no state yet reads as null', () => {
    expect(readSessionState(newCwd(), newSession())).toBeNull();
  });

  test("one session's write does not replace another session's state", () => {
    const a = newSession();
    const b = newSession();
    const cwd = newCwd();
    writeSessionState(cwd, a, { category: 'migrate', risk: 'risky' });
    writeSessionState(cwd, b, { category: 'fix-bug', risk: 'simple' });
    expect(readSessionState(cwd, a)?.risk).toBe('risky');
    expect(readSessionState(cwd, b)?.risk).toBe('simple');
  });

  // Security/refactoring review: the write threw after the session copy when the
  //   repo-level copy failed, and the caller then skipped the approval reset.
  test('an unwritable repo-level copy does not throw and the session copy is still written', () => {
    const s = newSession();
    const cwd = newCwd();
    mkdirSync(join(cwd, '.claude', SESSION_STATE_FILE), { recursive: true }); // a directory: write fails
    expect(() => writeSessionState(cwd, s, { category: 'migrate', risk: 'risky' })).not.toThrow();
    expect(readSessionState(cwd, s)?.risk).toBe('risky');
  });

  // Hallucination-axis review: a plugin reload mid-session (or an unwritable $TMPDIR)
  //   leaves only the repo-level copy; ignoring it lifted the risk gate.
  test('without a session copy, the repo-level copy counts when it names this session', () => {
    const s = newSession();
    const cwd = newCwd();
    writeRepoCopy(cwd, { category: 'migrate', risk: 'risky', sessionId: s });
    expect(readSessionState(cwd, s)?.risk).toBe('risky');
  });

  test("a repo-level copy from another session (e.g. committed) never applies", () => {
    const s = newSession();
    const cwd = newCwd();
    writeRepoCopy(cwd, { category: 'migrate', risk: 'risky', sessionId: 'someone-else' });
    expect(readSessionState(cwd, s)).toBeNull();
  });

  test('the session copy wins over the repo-level copy', () => {
    const a = newSession();
    const b = newSession();
    const cwd = newCwd();
    writeSessionState(cwd, a, { category: 'migrate', risk: 'risky' });
    writeSessionState(cwd, b, { category: 'fix-bug', risk: 'simple' }); // the repo slot now holds B
    writeRepoCopy(cwd, { category: 'fix-bug', risk: 'simple', sessionId: a }); // even a forged A copy
    expect(readSessionState(cwd, a)?.risk).toBe('risky');
  });

  test('a state that names another session is not applied', () => {
    const s = newSession();
    writeFileSync(join(ensureSessionDir(s), SESSION_STATE_FILE), JSON.stringify({ risk: 'risky', sessionId: 'other' }), 'utf8');
    expect(readSessionState(newCwd(), s)).toBeNull();
  });

  test('a broken state file reads as null (fail-open)', () => {
    const s = newSession();
    writeFileSync(join(ensureSessionDir(s), SESSION_STATE_FILE), '{ not json', 'utf8');
    expect(readSessionState(newCwd(), s)).toBeNull();
  });

  // Security review: a non-string riskReason crashed the deny message and the hook's
  //   catch-all then allowed the call. Fields of the wrong type are dropped.
  test('fields of the wrong type are dropped', () => {
    const s = newSession();
    writeFileSync(
      join(ensureSessionDir(s), SESSION_STATE_FILE),
      JSON.stringify({ risk: 'risky', riskReason: 42, category: ['x'], turn: 'nine', sessionId: s }),
      'utf8',
    );
    const st = readSessionState(newCwd(), s);
    expect(st?.risk).toBe('risky');
    expect(st?.riskReason).toBeUndefined();
    expect(st?.category).toBeUndefined();
    expect(st?.turn).toBeUndefined();
  });
});
