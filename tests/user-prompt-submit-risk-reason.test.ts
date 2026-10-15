// UserPromptSubmit records why a task is risky; the PreToolUse risk gate names that cause
// (stabilization plan A4). Runs both real hooks against one sandbox, so the
// riskReason written by user-prompt-submit is what the deny message reads.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';
import type { SessionState } from '../lib/session-state';

const UPS = resolve(import.meta.dir, '..', 'hooks', 'user-prompt-submit.ts');
const PRE = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const PLUGIN_ROOT = resolve(import.meta.dir, '..');
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

function newSandbox(): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-rr-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-rr-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

function hookEnv(box: Box): Record<string, string | undefined> {
  return {
    ...process.env,
    TMPDIR: box.tmp,
    HOME: box.tmp,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    GOODBOY_CONCISE_DEFAULT: 'off',
    GOODBOY_ASK_UNCLEAR: 'off',
    GOODBOY_DISABLE_DELEGATION: '1',
  };
}

async function run(hook: string, box: Box, payload: Record<string, unknown>): Promise<string> {
  const proc = Bun.spawn(['bun', hook], {
    cwd: box.cwd,
    env: hookEnv(box),
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: box.sessionId, cwd: box.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

async function submit(box: Box, prompt: string): Promise<void> {
  await run(UPS, box, { hook_event_name: 'UserPromptSubmit', prompt });
}

function readState(box: Box): SessionState {
  return JSON.parse(readFileSync(join(box.cwd, '.claude', '.goodboy-session-state.json'), 'utf8')) as SessionState;
}

interface PreOut {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

async function preTool(box: Box, toolName: string, toolInput: Record<string, unknown>): Promise<PreOut> {
  const stdout = await run(PRE, box, { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput });
  try {
    return JSON.parse(stdout) as PreOut;
  } catch {
    return {};
  }
}

describe('user-prompt-submit — riskReason in the session state (A4)', () => {
  test('a risky keyword is recorded as keyword:<label>', async () => {
    const box = newSandbox();
    await submit(box, '/fix-bug deploy the hotfix to prod');
    const st = readState(box);
    expect(st.risk).toBe('risky');
    expect(st.riskReason).toBe('keyword:prod');
    expect(st.sessionId).toBe(box.sessionId);
  });

  test('"product" is not the "prod" keyword: the task keeps its default risk', async () => {
    const box = newSandbox();
    await submit(box, '/fix-bug add a product search page');
    const st = readState(box);
    expect(st.risk).toBe('simple');
    expect(typeof st.riskReason).toBe('string');
    expect(st.riskReason).not.toMatch(/^keyword:/);
  });

  test('a command that is risky by default, without keywords, is recorded as default', async () => {
    const box = newSandbox();
    await submit(box, '/prepare-migration rename the users.email column');
    const st = readState(box);
    expect(st.risk).toBe('risky');
    expect(st.riskReason).toBe('default');
  });

  test('a --risk override is recorded as override', async () => {
    const box = newSandbox();
    await submit(box, '/fix-bug tweak the login copy --risk risky');
    const st = readState(box);
    expect(st.risk).toBe('risky');
    expect(st.riskReason).toBe('override');
  });
});

describe('user-prompt-submit -> pre-tool-use risk gate chain (A4)', () => {
  test('the deny names the keyword, the user-run exits, and read-only Bash still passes', async () => {
    const box = newSandbox();
    await submit(box, '/fix-bug deploy the hotfix to prod');

    const write = await preTool(box, 'Bash', { command: 'npm run deploy' });
    expect(write.hookSpecificOutput?.permissionDecision).toBe('deny');
    const reason = write.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('risky keyword "prod"');
    expect(reason).toContain(`! touch ${approvalMarkerRelPath('risk', box.sessionId)}`);
    expect(reason).toContain('--risk simple');

    const look = await preTool(box, 'Bash', { command: 'git status' });
    expect(look.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  test('a "product" task does not gate Bash at all', async () => {
    const box = newSandbox();
    await submit(box, '/fix-bug add a product search page');
    const out = await preTool(box, 'Bash', { command: 'npm run build' });
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});

// A3: the risk gate reads this session's own copy of the state. The repo-level file is a
// single slot: another session's category command overwrote it, and this session's gate,
// which ignores state from other sessions, silently stopped applying.
describe('concurrent sessions in one repo (A3)', () => {
  test("another session's category command does not lift this session's risk gate", async () => {
    const a = newSandbox();
    const b: Box = { ...a, sessionId: `sess-${Math.random().toString(36).slice(2)}` }; // same repo
    await submit(a, '/prepare-migration rename the users.email column');
    await submit(b, '/fix-bug add a product search page');
    expect(readState(a).sessionId).toBe(b.sessionId); // the repo-level slot now holds B

    const outA = await preTool(a, 'Bash', { command: 'npm run migrate' });
    expect(outA.hookSpecificOutput?.permissionDecision).toBe('deny');
    const outB = await preTool(b, 'Bash', { command: 'npm run build' });
    expect(outB.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  // Security review: B's category command used to delete the shared approval marker,
  //   re-blocking A's approved task; and A's approval used to unlock B.
  test("approvals are per session: B's command keeps A's approval, and A's approval does not unlock B", async () => {
    const a = newSandbox();
    const b: Box = { ...a, sessionId: `sess-${Math.random().toString(36).slice(2)}` }; // same repo
    await submit(a, '/prepare-migration rename the users.email column');
    writeFileSync(join(a.cwd, approvalMarkerRelPath('risk', a.sessionId)), '', 'utf8'); // the user approves A
    await submit(b, '/prepare-migration drop the legacy table');
    expect(existsSync(join(a.cwd, approvalMarkerRelPath('risk', a.sessionId)))).toBe(true);

    const outA = await preTool(a, 'Bash', { command: 'npm run migrate' });
    expect(outA.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    const outB = await preTool(b, 'Bash', { command: 'npm run migrate' });
    expect(outB.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // Security/refactoring review: a failed repo-level state write used to skip the
  //   approval reset, so the previous task's approval approved the new risky task.
  test("a new task resets this session's approval even when the repo-level state cannot be written", async () => {
    const box = newSandbox();
    mkdirSync(join(box.cwd, '.claude', '.goodboy-session-state.json'), { recursive: true }); // write fails
    writeFileSync(join(box.cwd, approvalMarkerRelPath('risk', box.sessionId)), '', 'utf8'); // old approval
    await submit(box, '/prepare-migration rename the users.email column');
    expect(existsSync(join(box.cwd, approvalMarkerRelPath('risk', box.sessionId)))).toBe(false);
    const out = await preTool(box, 'Bash', { command: 'npm run migrate' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  test('each session keeps its own copy of the state in its session dir', async () => {
    const a = newSandbox();
    await submit(a, '/prepare-migration rename the users.email column');
    const copy = JSON.parse(
      readFileSync(join(a.tmp, `goodboy-session-${a.sessionId}`, '.goodboy-session-state.json'), 'utf8'),
    ) as SessionState;
    expect(copy).toMatchObject({ category: 'prepare-migration', risk: 'risky', riskReason: 'default', sessionId: a.sessionId });
  });
});
