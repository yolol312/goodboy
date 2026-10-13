// Risk approvals per session (stabilization plan A3, round 2). Complements
// tests/approval-marker.test.ts and the F6/L4 cases of tests/a3-round2-regressions.test.ts:
//
//   - withdrawal deletes only files named like this session's risk marker, even when the
//     noted list names other approval files (another session's risk marker, this
//     session's Bash write marker);
//   - the risk deny in a directory without .claude/ creates it, so the `! touch` it prints
//     works there (F6 checks the Bash write deny).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalMarkerPath } from '../lib/approval-marker';

const ROOT = resolve(import.meta.dir, '..');
const UPS = join(ROOT, 'hooks', 'user-prompt-submit.ts');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
// Claude Code session ids are UUIDs; these two differ in their first 8 characters.
const SESS_A = '7d9ae000-267a-4875-b861-0da0234c82e5';
const SESS_B = '1f2e3d4c-5b6a-4789-8abc-def012345678';

let prevTmp: string | undefined;
let box = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'goodboy-ras-'));
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = box;
});
afterEach(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  rmSync(box, { recursive: true, force: true });
});

describe('risk approval withdrawal deletes this session’s risk marker only (A3)', () => {
  // Imported when the test runs: older trees lack these, and the hook test below still runs there.
  test('other approval files named in the noted list are kept', async () => {
    const { noteRiskApprovalPath, withdrawRiskApprovals } = await import('../lib/approval-marker');
    const repo = mkdtempSync(join(box, 'repo-'));
    mkdirSync(join(repo, '.claude'), { recursive: true });
    const mine = approvalMarkerPath(repo, 'risk', SESS_A);
    const otherSession = approvalMarkerPath(repo, 'risk', SESS_B);
    const myWriteApproval = approvalMarkerPath(repo, 'bash-write', SESS_A);
    for (const p of [mine, otherSession, myWriteApproval]) writeFileSync(p, '', 'utf8');

    // As if the list were tampered with: it names approval files that are not this marker.
    noteRiskApprovalPath(SESS_A, otherSession);
    noteRiskApprovalPath(SESS_A, myWriteApproval);
    withdrawRiskApprovals(SESS_A, repo);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(otherSession)).toBe(true);
    expect(existsSync(myWriteApproval)).toBe(true);
  });
});

async function run(cwd: string, script: string, payload: Record<string, unknown>): Promise<string> {
  const proc = Bun.spawn(['bun', script], {
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
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: SESS_A, cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

async function bash(cwd: string, command: string): Promise<{ decision: string; reason: string }> {
  const stdout = await run(cwd, PRE, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  let out: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  try {
    out = JSON.parse(stdout) as typeof out;
  } catch {
    return { decision: `unparsable output: ${stdout.slice(0, 80)}`, reason: '' };
  }
  return {
    decision: out.hookSpecificOutput?.permissionDecision ?? 'pass',
    reason: out.hookSpecificOutput?.permissionDecisionReason ?? '',
  };
}

describe('the risk deny in a directory without .claude/ (A3)', () => {
  test('the printed `! touch` command works there and unlocks the session', async () => {
    const repo = mkdtempSync(join(box, 'repo-'));
    const pkg = join(repo, 'pkg');
    mkdirSync(pkg, { recursive: true });
    await run(repo, UPS, { hook_event_name: 'UserPromptSubmit', prompt: '/migrate add a column' });
    expect(existsSync(join(pkg, '.claude'))).toBe(false);

    const denied = await bash(pkg, 'npm run migrate'); // the session works in pkg/ now
    expect(denied.decision).toBe('deny');
    const printed = /! touch (\S+?)`/.exec(denied.reason)?.[1] ?? '';
    expect(printed).toBe('.claude/.goodboy-risk-approved-7d9ae000.txt');

    // The user's `! touch` runs in the session's cwd.
    expect(Bun.spawnSync(['touch', printed], { cwd: pkg }).exitCode).toBe(0);
    expect((await bash(pkg, 'npm run migrate')).decision).toBe('pass');
  }, 30_000);
});
