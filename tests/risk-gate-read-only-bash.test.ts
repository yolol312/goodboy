// The PreToolUse risk gate and read-only Bash (A4), with the task state set by the real
// UserPromptSubmit hook. isReadOnlyBash scans the whole command, so the gate now runs it
// only once the session is known to be risky; these cases pin what that may not change:
// read-only commands pass, and commands that write — even behind a read-only prefix — stay
// denied.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const UPS = join(ROOT, 'hooks', 'user-prompt-submit.ts');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

interface Box {
  tmp: string;
  cwd: string;
  sessionId: string;
}

function newBox(): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-robash-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-robash-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

async function run(hook: string, box: Box, payload: Record<string, unknown>): Promise<string> {
  const proc = Bun.spawn(['bun', hook], {
    cwd: box.cwd,
    env: {
      ...process.env,
      TMPDIR: box.tmp,
      HOME: box.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CONCISE_DEFAULT: 'off',
      GOODBOY_ASK_UNCLEAR: 'off',
      GOODBOY_DISABLE_DELEGATION: '1',
    },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: box.sessionId, cwd: box.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

async function bashDecision(box: Box, command: string): Promise<string> {
  const stdout = await run(PRE, box, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  try {
    const out = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? 'pass';
  } catch {
    return 'pass';
  }
}

describe('risk gate — read-only Bash in a risky session', () => {
  test('read-only commands pass; writes, also behind a read-only prefix, are denied', async () => {
    const box = newBox();
    await run(UPS, box, { hook_event_name: 'UserPromptSubmit', prompt: '/migrate rename the users.email column' });

    const decisions: Record<string, string> = {};
    for (const c of ['git status', 'git log --oneline -3', 'ls -la', 'echo hi', 'git status > out.txt', 'git status && rm -rf src']) {
      decisions[c] = await bashDecision(box, c);
    }
    expect(decisions).toEqual({
      'git status': 'pass',
      'git log --oneline -3': 'pass',
      'ls -la': 'pass',
      'echo hi': 'deny',
      'git status > out.txt': 'deny',
      'git status && rm -rf src': 'deny',
    });
  }, 30_000);

  test('a session that is not risky is not gated, read-only or not', async () => {
    const box = newBox();
    await run(UPS, box, { hook_event_name: 'UserPromptSubmit', prompt: '/fix-bug add a product search page' });
    expect(await bashDecision(box, 'echo hi')).toBe('pass');
    expect(await bashDecision(box, 'git status')).toBe('pass');
  }, 30_000);
});
