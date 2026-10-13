// A new category command resets this session's approval and retry counter, and the risk
// gate reads this session's state (stabilization plan A3), end to end with the real
// UserPromptSubmit and PreToolUse hooks.
//
// The repo-level <project>/.claude/.goodboy-session-state.json is read by the subagents
// (task category) and is the gates' fallback copy. A failed write there used to throw out
// of the state write, so the approval reset and the counter reset after it never ran: the
// previous task's approval then approved the new risky task (security/refactoring review).
// No lib API is imported, so the file also runs against older trees (red runs).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const SESS_A = '7d9ae000-267a-4875-b861-0da0234c82e5';
const SESS_B = '1f2e3d4c-5b6a-4789-8abc-def012345678';
const RETRY_FILE = '.goodboy-retry-count.txt';

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-psw-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-psw-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd };
}

function sessionDir(repo: Repo, sessionId: string): string {
  const dir = join(repo.tmp, `goodboy-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function run(repo: Repo, script: string, sessionId: string, payload: Record<string, unknown>): Promise<string> {
  const proc = Bun.spawn(['bun', script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      TMPDIR: repo.tmp,
      HOME: repo.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CONCISE_DEFAULT: 'off',
      GOODBOY_ASK_UNCLEAR: 'off',
      GOODBOY_DISABLE_DELEGATION: '1',
    },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd: repo.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

async function submit(repo: Repo, sessionId: string, prompt: string): Promise<void> {
  await run(repo, UPS, sessionId, { hook_event_name: 'UserPromptSubmit', prompt });
}

async function bash(repo: Repo, sessionId: string, command: string): Promise<{ denied: boolean; reason: string }> {
  const stdout = await run(repo, PRE, sessionId, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  let out: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } = {};
  try {
    out = JSON.parse(stdout);
  } catch {
    out = {};
  }
  return {
    denied: out.hookSpecificOutput?.permissionDecision === 'deny',
    reason: out.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

/** Makes the repo-level state file unwritable: a directory in its place. */
function blockRepoLevelState(repo: Repo): void {
  mkdirSync(join(repo.cwd, '.claude', '.goodboy-session-state.json'), { recursive: true });
}

describe('a new category command when the repo-level state cannot be written (A3)', () => {
  test("this session's retry counter is reset and its session copy is written", async () => {
    const repo = newRepo();
    blockRepoLevelState(repo);
    writeFileSync(join(sessionDir(repo, SESS_A), RETRY_FILE), '2', 'utf8'); // one block from the escape
    await submit(repo, SESS_A, '/fix-bug the login redirect loops');
    expect(existsSync(join(sessionDir(repo, SESS_A), RETRY_FILE))).toBe(false);
    const copy = JSON.parse(readFileSync(join(sessionDir(repo, SESS_A), '.goodboy-session-state.json'), 'utf8')) as {
      category?: string;
      sessionId?: string;
    };
    expect(copy).toMatchObject({ category: 'fix-bug', sessionId: SESS_A });
  }, 30_000);

  test('the old approval is gone and the new risky task is gated', async () => {
    const repo = newRepo();
    await submit(repo, SESS_A, '/migrate rename the users.email column');
    const deny = await bash(repo, SESS_A, 'npm run migrate');
    const marker = /! touch (\S+?)`/.exec(deny.reason)?.[1] ?? '';
    expect(marker).not.toBe('');
    writeFileSync(join(repo.cwd, marker), '', 'utf8'); // the user approved the first task
    expect((await bash(repo, SESS_A, 'npm run migrate')).denied).toBe(false);

    rmSync(join(repo.cwd, '.claude', '.goodboy-session-state.json'), { force: true });
    blockRepoLevelState(repo);
    await submit(repo, SESS_A, '/migrate drop the legacy table'); // a new risky task
    expect(existsSync(join(repo.cwd, marker))).toBe(false);
    expect((await bash(repo, SESS_A, 'npm run migrate')).denied).toBe(true);
  }, 30_000);
});

describe("another session's category command (A3)", () => {
  test("leaves this session's retry counter alone", async () => {
    const repo = newRepo();
    writeFileSync(join(sessionDir(repo, SESS_A), RETRY_FILE), '2', 'utf8');
    await submit(repo, SESS_B, '/fix-bug the login redirect loops');
    expect(readFileSync(join(sessionDir(repo, SESS_A), RETRY_FILE), 'utf8')).toBe('2');
  }, 30_000);
});

describe('the risk gate on a malformed state (A3)', () => {
  // Security review: a non-string riskReason threw inside the deny message, and the hook's
  //   catch-all then allowed the call. Fields of the wrong type are dropped when read.
  test('wrong-typed fields in this session\'s state still deny, with a readable message', async () => {
    const repo = newRepo();
    writeFileSync(
      join(sessionDir(repo, SESS_A), '.goodboy-session-state.json'),
      JSON.stringify({ category: ['migrate'], risk: 'risky', riskReason: 42, turn: 'nine', sessionId: SESS_A }),
      'utf8',
    );
    const out = await bash(repo, SESS_A, 'echo hi');
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('classified as risky (task /unknown)');
    expect(out.reason).toContain('! touch .claude/.goodboy-risk-approved-7d9ae000.txt');
  }, 30_000);
});
