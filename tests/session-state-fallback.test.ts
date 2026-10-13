// lib/session-state.ts — when the gates fall back to the repo-level copy (stabilization
// plan A3, round 2). Complements tests/session-state.test.ts and the F3 case of
// tests/a3-round2-regressions.test.ts:
//
//   - a session copy that names another session (a sanitized-id collision) is unusable,
//     like a missing or broken one, and the repo copy of this session applies instead;
//   - a repo copy of another session never applies, whatever the session copy is;
//   - a usable session copy wins over any repo copy, and a session copy that cannot be
//     overwritten is removed so the repo copy with the new task applies (round 3);
//   - end to end, the risk gate stays on through that fallback.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureSessionDir } from '../lib/file-tracker';
import { SESSION_STATE_FILE, readSessionState, writeSessionState } from '../lib/session-state';

const ROOT = resolve(import.meta.dir, '..');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
const UPS = join(ROOT, 'hooks', 'user-prompt-submit.ts');
const SID = 'sess-fallback';
const OTHER = 'sess-somebody-else';

let prevTmp: string | undefined;
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'goodboy-ssf2-'));
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = box;
});
afterEach(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  rmSync(box, { recursive: true, force: true });
});

function newCwd(): string {
  return mkdtempSync(join(box, 'cwd-'));
}

function writeSessionCopy(sessionId: string, content: string): void {
  writeFileSync(join(ensureSessionDir(sessionId), SESSION_STATE_FILE), content, 'utf8');
}

function writeRepoCopy(cwd: string, state: Record<string, unknown>): void {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, '.claude', SESSION_STATE_FILE), JSON.stringify(state), 'utf8');
}

const RISKY = { category: 'migrate', risk: 'risky', riskReason: 'default' };

describe('readSessionState fallback (A3)', () => {
  test('a session copy that names another session falls back to the repo copy of this session', () => {
    const cwd = newCwd();
    writeSessionCopy(SID, JSON.stringify({ category: 'fix-bug', risk: 'simple', sessionId: OTHER }));
    writeRepoCopy(cwd, { ...RISKY, sessionId: SID });
    expect(readSessionState(cwd, SID)).toMatchObject({ category: 'migrate', risk: 'risky', sessionId: SID });
  });

  test('a repo copy of another session never applies, whatever the session copy is', () => {
    const cwd = newCwd();
    writeRepoCopy(cwd, { ...RISKY, sessionId: OTHER });
    writeSessionCopy(SID, JSON.stringify({ risk: 'risky', sessionId: 'sess-third' }));
    expect(readSessionState(cwd, SID)).toBeNull();
    writeSessionCopy(SID, '{ not json');
    expect(readSessionState(cwd, SID)).toBeNull();
  });

  // Round 3 (final security review): the agent can write the repo copy. Letting a newer
  //   updatedAt win let a planted copy ('9999-…', 'zzz', now + 4 min) beat the fresh risky task.
  test('a usable session copy wins over any repo copy of this session, whatever its updatedAt', () => {
    const cwd = newCwd();
    writeSessionCopy(SID, JSON.stringify({ ...RISKY, sessionId: SID, updatedAt: new Date().toISOString() }));
    for (const updatedAt of ['9999-12-31T00:00:00.000Z', 'zzz', new Date(Date.now() + 4 * 60_000).toISOString()]) {
      writeRepoCopy(cwd, { category: 'fix-bug', risk: 'simple', sessionId: SID, updatedAt });
      expect(readSessionState(cwd, SID)).toMatchObject({ category: 'migrate', risk: 'risky' });
    }
  });

  // Round 3 (security review): a session write that fails on an existing file (EACCES)
  //   used to leave the previous task's risk in the copy the gates read first.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a session copy that cannot be overwritten is removed, so the repo copy with the new task applies',
    () => {
      const cwd = newCwd();
      writeSessionState(cwd, SID, { category: 'fix-bug', risk: 'simple' });
      const own = join(ensureSessionDir(SID), SESSION_STATE_FILE);
      chmodSync(own, 0o444);
      writeSessionState(cwd, SID, { category: 'migrate', risk: 'risky' });
      expect(existsSync(own)).toBe(false);
      expect(readSessionState(cwd, SID)).toMatchObject({ category: 'migrate', risk: 'risky' });
    },
  );
});

/** The PreToolUse decision for a Bash call: 'deny', or 'pass' when the hook emitted no decision. */
async function riskDecision(cwd: string, command: string): Promise<string> {
  const proc = Bun.spawn(['bun', PRE], {
    cwd,
    env: {
      ...process.env,
      TMPDIR: box,
      HOME: box,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_DISABLE_DELEGATION: '1',
    },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: SID,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  // No output at all (a crash) is neither: the caller's expectation fails on it.
  let out: { hookSpecificOutput?: { permissionDecision?: string } };
  try {
    out = JSON.parse(stdout) as typeof out;
  } catch {
    return `unparsable output: ${stdout.slice(0, 80)}`;
  }
  return out.hookSpecificOutput?.permissionDecision ?? 'pass';
}

describe('the risk gate through the fallback (A3)', () => {
  test.each([
    ['broken JSON', '{ not json'],
    ['a copy naming another session', JSON.stringify({ category: 'fix-bug', risk: 'simple', sessionId: OTHER })],
  ])('a session copy that is %s: the repo copy of this session keeps the gate on', async (_label, content) => {
    const cwd = newCwd();
    writeSessionCopy(SID, content);
    writeRepoCopy(cwd, { ...RISKY, sessionId: SID });
    expect(await riskDecision(cwd, 'npm run migrate')).toBe('deny');
  }, 30_000);

  test("a broken session copy never brings in another session's risky repo copy", async () => {
    const cwd = newCwd();
    writeSessionCopy(SID, '{ not json');
    writeRepoCopy(cwd, { ...RISKY, sessionId: OTHER });
    expect(await riskDecision(cwd, 'npm run migrate')).toBe('pass');
  }, 30_000);

  // As root the chmod blocks nothing and the test would prove nothing.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a session copy that cannot be overwritten: the new risky task in the repo copy applies',
    async () => {
      const cwd = newCwd();
      await submit(cwd, '/fix-bug the login redirect loops');
      expect(await riskDecision(cwd, 'npm run migrate')).toBe('pass');
      chmodSync(join(ensureSessionDir(SID), SESSION_STATE_FILE), 0o444); // EACCES on the next write
      await submit(cwd, '/migrate rename the users.email column');
      expect(await riskDecision(cwd, 'npm run migrate')).toBe('deny');
    },
    30_000,
  );
});

async function submit(cwd: string, prompt: string): Promise<void> {
  const proc = Bun.spawn(['bun', UPS], {
    cwd,
    env: {
      ...process.env,
      TMPDIR: box,
      HOME: box,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CONCISE_DEFAULT: 'off',
      GOODBOY_ASK_UNCLEAR: 'off',
      GOODBOY_DISABLE_DELEGATION: '1',
    },
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: SID, cwd, hook_event_name: 'UserPromptSubmit', prompt }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await new Response(proc.stdout).text();
  await proc.exited;
}
