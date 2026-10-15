import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Track G stop rule R2 through the PreToolUse hook (plan §10.6).

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function setup(hosts?: string) {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-r2-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(cwd);
  if (hosts !== undefined) {
    mkdirSync(join(cwd, '.goodboy'));
    writeFileSync(join(cwd, '.goodboy', 'hosts'), hosts);
  }
  const sid = `r2-${Math.random().toString(36).slice(2)}`;
  const run = async (command: string, opts: { sub?: boolean; env?: Record<string, string> } = {}) => {
    const payload = {
      session_id: sid,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      ...(opts.sub ? { agent_type: 'goodboy:build-infra', agent_id: 'b1' } : {}),
    };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, ...(opts.env ?? {}) },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '', system: String(out.systemMessage ?? '') };
  };
  return { base, cwd, sid, run };
}

/** The two one-use markers of a session, created as the user's `! touch` would. */
function approve(cwd: string, sid: string, kinds: Array<'outward' | 'bash-write'>): Record<string, string> {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const paths: Record<string, string> = {};
  for (const k of kinds) {
    paths[k] = join(cwd, `.claude/.goodboy-${k}-approved-${sid.slice(0, 8)}.txt`);
    writeFileSync(paths[k]!, '');
  }
  return paths;
}

const POST = 'curl -X POST https://api.stripe.com/v1/charges -d amount=1';

describe('unlisted external hosts', () => {
  test('a subagent is denied with a retarget hint', async () => {
    const { run } = setup();
    const r = await run(POST, { sub: true });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('R2');
    expect(r.reason).toContain('curl → api.stripe.com');
    expect(r.reason).toContain('BLOCKED');
  });

  test('the main session gets advice once per target', async () => {
    const { run } = setup();
    const first = await run(POST);
    expect(first.denied).toBe(false);
    expect(first.context).toContain('[R2] curl → api.stripe.com');
    const second = await run(POST);
    expect(second.context).not.toContain('[R2]');
  });

  test('reads pass, also in subagents', async () => {
    const { run } = setup();
    const r = await run('curl -s https://api.stripe.com/v1/charges', { sub: true });
    expect(r.denied).toBe(false);
    expect(r.context).not.toContain('[R2]');
  });

  test('an allow-listed or local target passes in a subagent', async () => {
    const { run } = setup('allow *.sandbox.corp.net\n');
    expect((await run('curl -X POST https://pay.sandbox.corp.net/v1/x', { sub: true })).denied).toBe(false);
    expect((await run('curl -X POST http://localhost:4000/v1/x', { sub: true })).denied).toBe(false);
  });
});

describe('production hosts', () => {
  test('the main session is denied until the user approves one use', async () => {
    const { cwd, sid, run } = setup('production api.corp.net\n');
    const cmd = 'curl -X DELETE https://api.corp.net/v1/users/7';
    const r = await run(cmd);
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('production');
    expect(r.system).toContain('운영(production)');
    const rel = r.reason.match(/`! touch ([^`]+)`/)?.[1];
    expect(rel).toBe(`.claude/.goodboy-outward-approved-${sid.slice(0, 8)}.txt`);
    writeFileSync(join(cwd, rel!), '');
    expect((await run(cmd)).denied).toBe(false);
    expect(existsSync(join(cwd, rel!))).toBe(false); // used up
    expect((await run(cmd)).denied).toBe(true);
  });

  // Source bug found in the G1 test round (hooks/pre-tool-use.ts A0.9): the outward approval is
  // consumed before the later gates run, so when the risk gate (D) then denies the same
  // command, the user's one approval is spent on a command that never ran. The Bash write
  // approval restores its marker in exactly this case (v0.27.1/2); this one should too.
  test('a later risk-gate denial keeps the production approval for the retry', async () => {
    const { cwd, sid, run } = setup('production api.corp.net\n');
    const sessionDir = join(cwd, '..', `goodboy-session-${sid}`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, '.goodboy-session-state.json'),
      JSON.stringify({ category: 'migrate', risk: 'risky', riskReason: 'default', turn: 0, sessionId: sid }),
    );
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const marker = join(cwd, `.claude/.goodboy-outward-approved-${sid.slice(0, 8)}.txt`);
    writeFileSync(marker, '');
    const r = await run('curl -X POST https://api.corp.net/v1/x');
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('risky'); // denied by the risk gate, not by R2
    expect(existsSync(marker)).toBe(true);
  });

  test('a subagent is denied even with an approval marker', async () => {
    const { cwd, sid, run } = setup('production api.corp.net\n');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(join(cwd, `.claude/.goodboy-outward-approved-${sid.slice(0, 8)}.txt`), '');
    const r = await run('curl -X POST https://api.corp.net/v1/x', { sub: true });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('never act on production');
  });

  // The approval is used only after every later gate passed (A0.9). The risk gate is covered
  // above; the Bash write gate (A1.7) and the search gate (A1) also deny a main-session Bash
  // command after the outward rule. (The skill rule and role limits cannot: the first covers
  // Edit tools only, the second subagents only, where no approval is honored.)
  test('a later Bash-write or search denial keeps the production approval', async () => {
    const { cwd, sid, run } = setup('production api.corp.net\n');
    const { outward } = approve(cwd, sid, ['outward']);
    const write = await run('curl -X POST https://api.corp.net/v1/x > out.json');
    expect(write.denied).toBe(true);
    expect(write.reason).toContain('Bash로 프로젝트 파일을 쓰려');
    expect(existsSync(outward!)).toBe(true);
    const search = await run('grep -r foo / ; curl -X POST https://api.corp.net/v1/x');
    expect(search.denied).toBe(true);
    expect(search.reason).toContain('H2-03');
    expect(existsSync(outward!)).toBe(true);
    // The approval is still worth exactly one use.
    expect((await run('curl -X POST https://api.corp.net/v1/x')).denied).toBe(false);
    expect(existsSync(outward!)).toBe(false);
  });

  test('a command that needs both approvals runs once and uses both', async () => {
    const { cwd, sid, run } = setup('production api.corp.net\n');
    const m = approve(cwd, sid, ['outward', 'bash-write']);
    const cmd = 'curl -X POST https://api.corp.net/v1/x > out.json';
    const r = await run(cmd);
    expect(r.denied).toBe(false);
    expect([existsSync(m.outward!), existsSync(m['bash-write']!)]).toEqual([false, false]);
    expect(readdirSync(join(cwd, '.claude')).filter((f) => f.includes('.consumed-'))).toEqual([]);
    expect((await run(cmd)).denied).toBe(true);
  });

  test('concurrent commands share one approval: exactly one runs', async () => {
    const { cwd, sid, run } = setup('production api.corp.net\n');
    const { outward } = approve(cwd, sid, ['outward']);
    const results = await Promise.all(Array.from({ length: 6 }, () => run('curl -X POST https://api.corp.net/v1/x')));
    expect(results.filter((r) => !r.denied)).toHaveLength(1);
    expect(existsSync(outward!)).toBe(false);
  });

  // The loser of the race for the approval (its rename fails) is denied, and gives back the
  // Bash-write approval it already took. The rename is made to fail deterministically: the
  // hook moves the marker to `<marker>.consumed-<pid>`, and a non-empty directory sits there.
  // The hook waits for stdin, so the directory exists before it starts deciding.
  test('the loser of the race is denied and restores the Bash-write approval', async () => {
    const { base, cwd, sid } = setup('production api.corp.net\n');
    const m = approve(cwd, sid, ['outward', 'bash-write']);
    const payload = {
      session_id: sid,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'curl -X POST https://api.corp.net/v1/x > out.json' },
    };
    const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TMPDIR: base } });
    const blocker = `${m.outward}.consumed-${proc.pid}`;
    mkdirSync(blocker);
    writeFileSync(join(blocker, 'x'), '');
    proc.stdin.write(JSON.stringify(payload));
    await proc.stdin.end();
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: Record<string, string> };
    await proc.exited;
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('already used');
    expect(existsSync(m['bash-write']!)).toBe(true);
    expect(existsSync(`${m['bash-write']}.consumed-${proc.pid}`)).toBe(false);
  });
});

describe('gate modes', () => {
  test('warn turns denials into advice; off disables the rule', async () => {
    const { run } = setup('production api.corp.net\n');
    const warn = await run(POST, { sub: true, env: { GOODBOY_OUTWARD_GATE: 'warn' } });
    expect(warn.denied).toBe(false);
    expect(warn.context).toContain('[R2]');
    const prod = await run('curl -X POST https://api.corp.net/x', { env: { GOODBOY_OUTWARD_GATE: 'warn' } });
    expect(prod.denied).toBe(false);
    expect(prod.context).toContain('production');
    const off = await run(POST, { sub: true, env: { GOODBOY_OUTWARD_GATE: 'off' } });
    expect(off.denied).toBe(false);
    expect(off.context).not.toContain('[R2]');
  });
});
