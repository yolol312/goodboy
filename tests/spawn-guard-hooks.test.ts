import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Track G §10.7 end to end: PreToolUse decides and logs, PostToolUse and SubagentStop record
// completions, UserPromptSubmit records user prompts — all in one session's state dir.

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

interface Session {
  dir: string;
  cwd: string;
  run: (hook: string, payload: Record<string, unknown>, env?: Record<string, string>) => Promise<Record<string, unknown>>;
}

function session(): Session {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-spawn-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  require('node:fs').mkdirSync(cwd);
  const sid = `spawn-${Math.random().toString(36).slice(2)}`;
  return {
    dir: join(base, `goodboy-session-${sid}`),
    cwd,
    async run(hook, payload, env = {}) {
      const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
        cwd,
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base, CLAUDE_PLUGIN_ROOT: ROOT, ...env },
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(out || '{}') as Record<string, unknown>;
    },
  };
}

let tu = 0;
function agentCall(input: Record<string, unknown>, by?: { type: string; id: string }): Record<string, unknown> {
  tu += 1;
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_use_id: `toolu_${tu}`,
    tool_input: { description: 'd', ...input },
    ...(by ? { agent_type: by.type, agent_id: by.id } : {}),
  };
}

function hso(out: Record<string, unknown>): Record<string, unknown> {
  return (out.hookSpecificOutput ?? {}) as Record<string, unknown>;
}

const denied = (out: Record<string, unknown>) => hso(out).permissionDecision === 'deny';

describe('who may start agents', () => {
  test('a member is denied; a lead may start its member in the foreground at policy', async () => {
    const s = session();
    const member = await s.run('pre-tool-use', agentCall({ subagent_type: 'general-purpose', prompt: 'x' }, { type: 'goodboy:review-all', id: 'm1' }));
    expect(denied(member)).toBe(true);
    expect(String(hso(member).permissionDecisionReason)).toContain('only -lead agents');

    const lead = await s.run(
      'pre-tool-use',
      agentCall({ subagent_type: 'goodboy:review-security', prompt: 'check auth' }, { type: 'goodboy:review-lead', id: 'L1' }),
    );
    expect(hso(lead).permissionDecision).toBe('allow');
    expect(hso(lead).updatedInput).toMatchObject({
      subagent_type: 'goodboy:review-security',
      prompt: 'check auth',
      run_in_background: false,
      model: 'opus',
      effort: 'high',
    });
  });

  test('GOODBOY_ROUTING_GATE=off keeps the foreground rewrite but not model/effort', async () => {
    const s = session();
    const out = await s.run(
      'pre-tool-use',
      agentCall({ subagent_type: 'goodboy:test-unit', prompt: 'p' }, { type: 'goodboy:test-lead', id: 'L1' }),
      { GOODBOY_ROUTING_GATE: 'off' },
    );
    expect(hso(out).updatedInput).toMatchObject({ run_in_background: false });
    expect((hso(out).updatedInput as Record<string, unknown>).model).toBeUndefined();
  });

  test('GOODBOY_SPAWN_GATE=off lets a member delegate', async () => {
    const s = session();
    const out = await s.run('pre-tool-use', agentCall({ prompt: 'x' }, { type: 'goodboy:review-all', id: 'm1' }), {
      GOODBOY_SPAWN_GATE: 'off',
    });
    expect(denied(out)).toBe(false);
  });

  test('main → a goodboy role gets its policy; a legacy name and built-ins are untouched', async () => {
    const s = session();
    const role = await s.run('pre-tool-use', agentCall({ subagent_type: 'goodboy:review-all', prompt: 'a' }));
    expect(hso(role).updatedInput).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect((hso(role).updatedInput as Record<string, unknown>).run_in_background).toBeUndefined();
    const legacy = await s.run('pre-tool-use', agentCall({ subagent_type: 'goodboy:review-changes', prompt: 'b' }));
    expect(hso(legacy).updatedInput).toBeUndefined();
    expect(denied(legacy)).toBe(false);
    // The log keeps the applied model/effort, not the call's empty ones.
    const log = require('node:fs')
      .readFileSync(join(s.dir, 'dispatch-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l));
    expect(log.find((r: { callee: string }) => r.callee === 'goodboy:review-all')).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(log.find((r: { callee: string }) => r.callee === 'goodboy:review-changes')).toMatchObject({ model: null, effort: null });
  });
});

describe('running agents and completions', () => {
  test('a 4th concurrent call waits; a completion frees a slot', async () => {
    const s = session();
    const calls = [1, 2, 3].map((i) => agentCall({ prompt: `job ${i}` }));
    for (const c of calls) expect(denied(await s.run('pre-tool-use', c))).toBe(false);
    const fourth = await s.run('pre-tool-use', agentCall({ prompt: 'job 4' }));
    expect(denied(fourth)).toBe(true);
    expect(String(hso(fourth).permissionDecisionReason)).toContain('already running');

    await s.run('post-tool-use', {
      tool_name: 'Agent',
      tool_use_id: calls[0]!.tool_use_id,
      tool_input: calls[0]!.tool_input,
      tool_response: { status: 'completed', agentId: 'ag1', content: [{ type: 'text', text: 'done' }], totalTokens: 10 },
    });
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'job 4' })))).toBe(false);
  });

  test('a failed call (PostToolUseFailure) stops counting and allows one retry', async () => {
    const s = session();
    const calls = [1, 2, 3].map((i) => agentCall({ prompt: `job ${i}` }));
    for (const c of calls) await s.run('pre-tool-use', c);
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'job 4' })))).toBe(true);
    await s.run('post-tool-use-failure', {
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Agent',
      tool_use_id: calls[0]!.tool_use_id,
      tool_input: calls[0]!.tool_input,
      error: 'API Error: 529 overloaded',
      is_interrupt: false,
    });
    // The slot is free, and the failed job may run once more.
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'job 1' })))).toBe(false);
    // A failure of another tool records nothing.
    await s.run('post-tool-use-failure', { tool_name: 'Bash', tool_use_id: calls[1]!.tool_use_id, error: 'x' });
    const log = require('node:fs').readFileSync(join(s.dir, 'dispatch-log.jsonl'), 'utf8') as string;
    expect(log.split('\n').filter((l) => l.includes('"k":"done"'))).toHaveLength(1);
  });

  test('a background launch counts until SubagentStop', async () => {
    const s = session();
    const calls = [1, 2, 3].map((i) => agentCall({ prompt: `bg ${i}` }));
    for (const [i, c] of calls.entries()) {
      await s.run('pre-tool-use', c);
      await s.run('post-tool-use', {
        tool_name: 'Agent',
        tool_use_id: c.tool_use_id,
        tool_input: c.tool_input,
        tool_response: { isAsync: true, status: 'async_launched', agentId: `bg${i}` },
      });
    }
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'bg 4' })))).toBe(true);
    await s.run('subagent-stop', { hook_event_name: 'SubagentStop', agent_id: 'bg1', last_assistant_message: 'ok' });
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'bg 4' })))).toBe(false);
  });
});

describe('the same agent on the same prompt', () => {
  test('denied after an ok result; allowed again after a new user prompt; a notification is not one', async () => {
    const s = session();
    const first = agentCall({ subagent_type: 'Explore', prompt: 'map the hooks' });
    await s.run('pre-tool-use', first);
    await s.run('post-tool-use', {
      tool_name: 'Agent',
      tool_use_id: first.tool_use_id,
      tool_input: first.tool_input,
      tool_response: { status: 'completed', agentId: 'e1', content: [{ type: 'text', text: 'map' }] },
    });
    const again = await s.run('pre-tool-use', agentCall({ subagent_type: 'Explore', prompt: 'map the hooks' }));
    expect(denied(again)).toBe(true);
    expect(String(hso(again).permissionDecisionReason)).toContain('already ran');

    await s.run('user-prompt-submit', { prompt: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' });
    expect(denied(await s.run('pre-tool-use', agentCall({ subagent_type: 'Explore', prompt: 'map the hooks' })))).toBe(true);

    await s.run('user-prompt-submit', { prompt: '다시 한 번 봐줘' });
    expect(denied(await s.run('pre-tool-use', agentCall({ subagent_type: 'Explore', prompt: 'map the hooks' })))).toBe(false);
  });

  test('a BLOCKED background result allows one retry', async () => {
    const s = session();
    const first = agentCall({ prompt: 'run the e2e suite' });
    await s.run('pre-tool-use', first);
    await s.run('post-tool-use', {
      tool_name: 'Agent',
      tool_use_id: first.tool_use_id,
      tool_input: first.tool_input,
      tool_response: { status: 'async_launched', agentId: 'r1' },
    });
    await s.run('subagent-stop', { agent_id: 'r1', last_assistant_message: 'BLOCKED: browser missing' });
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'run the e2e suite' })))).toBe(false);
  });

  test('a file the prompt names changed or was removed since: the same agent may run again', async () => {
    const s = session();
    const fs = require('node:fs') as typeof import('node:fs');
    fs.mkdirSync(join(s.cwd, 'src'));
    const file = join(s.cwd, 'src', 'auth.ts');
    fs.writeFileSync(file, 'export const a = 1;\n');
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(file, past, past);
    const prompt = 'review src/auth.ts for token leaks';
    const finish = (call: Record<string, unknown>, agentId: string) =>
      s.run('post-tool-use', {
        tool_name: 'Agent',
        tool_use_id: call.tool_use_id,
        tool_input: call.tool_input,
        tool_response: { status: 'completed', agentId, content: [{ type: 'text', text: 'ok' }] },
      });

    const first = agentCall({ subagent_type: 'Explore', prompt });
    await s.run('pre-tool-use', first);
    await finish(first, 'x1');
    expect(denied(await s.run('pre-tool-use', agentCall({ subagent_type: 'Explore', prompt })))).toBe(true);

    const later = Date.now() / 1000 + 5;
    fs.utimesSync(file, later, later);
    const second = agentCall({ subagent_type: 'Explore', prompt });
    expect(denied(await s.run('pre-tool-use', second))).toBe(false);
    await finish(second, 'x2');

    fs.rmSync(file);
    expect(denied(await s.run('pre-tool-use', agentCall({ subagent_type: 'Explore', prompt })))).toBe(false);
    const log = fs
      .readFileSync(join(s.dir, 'dispatch-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l: string) => JSON.parse(l) as { k: string; why?: string; files?: string[] })
      .filter((r) => r.k === 'dispatch');
    expect(log.map((r) => r.why)).toEqual(['new', 'scope-changed', 'scope-changed']);
    expect(log[0]!.files).toEqual([file]);
  });
});

describe('caps and gate modes through the hook', () => {
  test('a spent task budget denies with a user notice; warn mode advises; a user prompt resets it', async () => {
    const s = session();
    const env = { GOODBOY_SPAWN_LIMIT: '1' };
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'job a' }), env))).toBe(false);
    const over = await s.run('pre-tool-use', agentCall({ prompt: 'job b' }), env);
    expect(denied(over)).toBe(true);
    expect(String(hso(over).permissionDecisionReason)).toContain('cap 1');
    expect(String(over.systemMessage)).toContain('작업당 에이전트 호출 상한');

    const warn = await s.run('pre-tool-use', agentCall({ prompt: 'job b' }), { ...env, GOODBOY_SPAWN_GATE: 'warn' });
    expect(denied(warn)).toBe(false);
    expect(String(hso(warn).additionalContext)).toContain('delegation guard, warn mode');

    await s.run('user-prompt-submit', { prompt: 'now do the next part' });
    expect(denied(await s.run('pre-tool-use', agentCall({ prompt: 'job c' }), env))).toBe(false);
  });
});

describe('headless Claude runs', () => {
  test('a subagent may not run claude -p; the main session may', async () => {
    const s = session();
    const sub = await s.run('pre-tool-use', {
      tool_name: 'Bash',
      tool_input: { command: 'claude -p "run pytest"' },
      agent_type: 'general-purpose',
      agent_id: 'g1',
    });
    expect(denied(sub)).toBe(true);
    expect(String(hso(sub).permissionDecisionReason)).toContain('claude -p');
    const main = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'claude -p "hi"' } });
    expect(String(hso(main).permissionDecisionReason ?? '')).not.toContain('claude -p');
  });

  test('GOODBOY_SPAWN_GATE=warn advises instead of denying; off is silent', async () => {
    const s = session();
    const sub = { tool_name: 'Bash', tool_input: { command: 'claude -p "run pytest"' }, agent_type: 'general-purpose', agent_id: 'g1' };
    const warn = await s.run('pre-tool-use', sub, { GOODBOY_SPAWN_GATE: 'warn' });
    expect(denied(warn)).toBe(false);
    expect(String(hso(warn).additionalContext ?? '')).toContain('claude -p');
    const off = await s.run('pre-tool-use', sub, { GOODBOY_SPAWN_GATE: 'off' });
    expect(denied(off)).toBe(false);
    expect(String(hso(off).additionalContext ?? '')).not.toContain('claude -p');
  });
});
