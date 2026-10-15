// Approval markers are per session (stabilization plan A3), end to end with the real
// UserPromptSubmit and PreToolUse hooks.
//
// The marker is `.claude/.goodboy-{risk,bash-write}-approved-<tag>.txt`, tag = the first 8
// characters of the session id. Nobody is expected to know the tag: the deny message prints
// the path, and the user (risk gate, `! touch <path>`) or the agent after the user's
// approval (Bash write gate) creates exactly that file in the project directory. So every
// test here takes the path from the deny message itself and creates it with `touch` in the
// session's cwd, the way the printed command runs. No lib API is imported, so the file also
// runs against older trees (red runs).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// Claude Code session ids are UUIDs; these two differ in their first 8 characters.
const SESS_A = '7d9ae000-267a-4875-b861-0da0234c82e5';
const SESS_B = '1f2e3d4c-5b6a-4789-8abc-def012345678';

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-amf-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-amf-cwd-'));
  tmpDirs.push(cwd);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  return { tmp, cwd };
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

interface Decision {
  denied: boolean;
  reason: string;
}

async function bash(repo: Repo, sessionId: string, command: string): Promise<Decision> {
  const stdout = await run(repo, PRE, sessionId, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
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

/** The marker path inside the printed command, e.g. "! touch <path>" or "`touch <path>`". */
function printedMarker(reason: string, prefix: '! touch ' | '`touch '): string {
  const at = reason.indexOf(prefix);
  expect(at).toBeGreaterThan(-1);
  const rest = reason.slice(at + prefix.length);
  return rest.slice(0, rest.search(/[`\s]/));
}

/** Runs `touch <path>` in the project directory, as the printed command does. */
function touchInCwd(repo: Repo, rel: string): void {
  const p = Bun.spawnSync(['touch', rel], { cwd: repo.cwd });
  expect(p.exitCode).toBe(0);
}

describe('risk approval — the deny message names the marker that unlocks this session (A3)', () => {
  test('touching the printed path unlocks this session only', async () => {
    const repo = newRepo();
    await submit(repo, SESS_A, '/migrate rename the users.email column');
    await submit(repo, SESS_B, '/migrate drop the legacy table');

    const a = await bash(repo, SESS_A, 'npm run migrate');
    expect(a.denied).toBe(true);
    const marker = printedMarker(a.reason, '! touch ');
    expect(marker).toBe('.claude/.goodboy-risk-approved-7d9ae000.txt');

    touchInCwd(repo, marker); // the user's `! touch` runs in the project directory
    expect((await bash(repo, SESS_A, 'npm run migrate')).denied).toBe(false);
    expect((await bash(repo, SESS_A, 'npm run migrate')).denied).toBe(false); // not one-shot

    const b = await bash(repo, SESS_B, 'npm run migrate');
    expect(b.denied).toBe(true);
    expect(printedMarker(b.reason, '! touch ')).toBe('.claude/.goodboy-risk-approved-1f2e3d4c.txt');
  }, 30_000);

  test('the pre-A3 shared marker name unlocks no session', async () => {
    const repo = newRepo();
    await submit(repo, SESS_A, '/migrate rename the users.email column');
    writeFileSync(join(repo.cwd, '.claude', '.goodboy-risk-approved.txt'), '', 'utf8');
    expect((await bash(repo, SESS_A, 'npm run migrate')).denied).toBe(true);
    expect(existsSync(join(repo.cwd, '.claude', '.goodboy-risk-approved.txt'))).toBe(true);
  }, 30_000);
});

describe('Bash write approval — one shot, for the session the message names (A3)', () => {
  test("touching the printed path allows this session's next write once; another session's write neither uses nor consumes it", async () => {
    const repo = newRepo();
    const first = await bash(repo, SESS_A, 'echo hi > src/a.ts');
    expect(first.denied).toBe(true);
    // Track G: the message asks the user to run `! touch <path>`.
    const marker = printedMarker(first.reason, '! touch ');
    expect(marker).toBe('.claude/.goodboy-bash-write-approved-7d9ae000.txt');

    // .claude/ is created here on purpose: in a repo without one the printed command fails
    // (see the layer-1 findings); this test is about which session the marker belongs to.
    mkdirSync(join(repo.cwd, '.claude'), { recursive: true });
    touchInCwd(repo, marker);

    const other = await bash(repo, SESS_B, 'echo hi > src/b.ts');
    expect(other.denied).toBe(true);
    expect(existsSync(join(repo.cwd, marker))).toBe(true); // B did not consume A's approval

    expect((await bash(repo, SESS_A, 'echo hi > src/a.ts')).denied).toBe(false);
    expect(existsSync(join(repo.cwd, marker))).toBe(false); // consumed
    expect((await bash(repo, SESS_A, 'echo again > src/a.ts')).denied).toBe(true); // one shot
  }, 30_000);

  test('the pre-A3 shared marker name is neither honored nor consumed', async () => {
    const repo = newRepo();
    const legacy = join(repo.cwd, '.claude', '.goodboy-bash-write-approved.txt');
    mkdirSync(join(repo.cwd, '.claude'), { recursive: true });
    writeFileSync(legacy, '', 'utf8');
    expect((await bash(repo, SESS_A, 'echo hi > src/a.ts')).denied).toBe(true);
    expect(existsSync(legacy)).toBe(true);
  }, 30_000);

  // The risk gate restores a Bash write approval it consumed before denying (v0.27.1/2).
  //   The restore has to put back this session's marker, under this session's name.
  test("in a risky session the risk gate's deny puts this session's write approval back", async () => {
    const repo = newRepo();
    await submit(repo, SESS_A, '/migrate rename the users.email column');
    const write = await bash(repo, SESS_A, 'echo hi > src/a.ts');
    expect(write.denied).toBe(true);
    const writeMarker = printedMarker(write.reason, '! touch ');
    touchInCwd(repo, writeMarker);

    const denied = await bash(repo, SESS_A, 'echo hi > src/a.ts');
    expect(denied.denied).toBe(true); // the risk gate: no risk approval yet
    expect(existsSync(join(repo.cwd, writeMarker))).toBe(true); // restored, same name

    touchInCwd(repo, printedMarker(denied.reason, '! touch '));
    expect((await bash(repo, SESS_A, 'echo hi > src/a.ts')).denied).toBe(false);
    expect(existsSync(join(repo.cwd, writeMarker))).toBe(false); // now consumed
  }, 30_000);
});
