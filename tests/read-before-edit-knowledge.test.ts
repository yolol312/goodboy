import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Track G: read-before-edit asks what the editor itself knows of the file.
//   - An own edit counts only while the file is as the edit left it (mtime after the edit).
//   - Only the editor's own reads and edits count (agent_id scope; the main session is 'main').
//   - After a compaction (SessionStart source "compact", G0 M17) nothing from before counts.

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

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-rbek-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(cwd);
  const sid = `rbek-${Math.random().toString(36).slice(2)}`;
  // A doc file: the reasoning gate exempts it, so only read-before-edit decides.
  const file = join(cwd, 'notes.md');
  writeFileSync(file, 'hello\n');
  const run = async (hook: string, payload: Record<string, unknown>) => {
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1' },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  };
  const by = (agent?: { id?: string; type: string }) =>
    agent ? { agent_type: agent.type, ...(agent.id ? { agent_id: agent.id } : {}) } : {};
  const read = (agent?: { id?: string; type: string }) =>
    run('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_response: {}, ...by(agent) });
  const edited = (agent?: { id?: string; type: string }) =>
    run('post-tool-use', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'hello', new_string: 'hello' },
      tool_response: {},
      ...by(agent),
    });
  const tryEdit = async (agent?: { id?: string; type: string }) => {
    const out = await run('pre-tool-use', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'hello', new_string: 'world' },
      ...by(agent),
    });
    return { denied: out.hookSpecificOutput?.permissionDecision === 'deny', reason: out.hookSpecificOutput?.permissionDecisionReason ?? '' };
  };
  /** Someone else writes the file: a newer mtime. */
  const changeElsewhere = () => {
    const t = statSync(file).mtimeMs / 1000 + 5;
    writeFileSync(file, 'hello again\n');
    utimesSync(file, t, t);
  };
  return { file, run, read, edited, tryEdit, changeElsewhere };
}

const SUB = { id: 'agent-1', type: 'goodboy:build-backend' };

describe('an own edit as knowledge', () => {
  test('counts while the file is as the edit left it', async () => {
    const s = sandbox();
    await s.edited();
    expect((await s.tryEdit()).denied).toBe(false);
  });

  test('is stale once someone else changed the file', async () => {
    const s = sandbox();
    await s.edited();
    s.changeElsewhere();
    const r = await s.tryEdit();
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('changed after you last edited');
    // A fresh read is the way out.
    await s.read();
    expect((await s.tryEdit()).denied).toBe(false);
  });

  test('read, then an own edit that changed the file: the edit is the newest knowledge', async () => {
    const s = sandbox();
    await s.read();
    s.changeElsewhere(); // what the model's own Edit wrote
    await s.edited();
    expect((await s.tryEdit()).denied).toBe(false);
  });

  test('a read after an own edit is the newest knowledge, and its mtime is checked', async () => {
    const s = sandbox();
    await s.edited();
    await s.read();
    s.changeElsewhere();
    const r = await s.tryEdit();
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('changed after you last read');
  });
});

describe('whose read counts', () => {
  test("a subagent's read does not let the main session edit", async () => {
    const s = sandbox();
    await s.read(SUB);
    expect((await s.tryEdit()).denied).toBe(true);
    await s.read();
    expect((await s.tryEdit()).denied).toBe(false);
  });

  test("the main session's read or another agent's does not let a subagent edit", async () => {
    const s = sandbox();
    await s.read();
    await s.read({ id: 'agent-2', type: 'goodboy:build-frontend' });
    expect((await s.tryEdit(SUB)).denied).toBe(true);
    await s.read(SUB);
    expect((await s.tryEdit(SUB)).denied).toBe(false);
  });

  test('a subagent without agent_id cannot be told apart, so any read counts for it', async () => {
    const s = sandbox();
    await s.read();
    expect((await s.tryEdit({ type: 'general-purpose' })).denied).toBe(false);
  });
});

describe('after a compaction', () => {
  test('reads and own edits from before do not count; a new read does', async () => {
    const s = sandbox();
    await s.read();
    await s.edited();
    expect((await s.tryEdit()).denied).toBe(false);
    await new Promise((r) => setTimeout(r, 5)); // the epoch must be later than the records
    await s.run('session-start', { hook_event_name: 'SessionStart', source: 'compact' });
    const r = await s.tryEdit();
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('Read this file');
    await new Promise((r) => setTimeout(r, 5));
    await s.read();
    expect((await s.tryEdit()).denied).toBe(false);
  });

  test('startup and resume keep what was known', async () => {
    const s = sandbox();
    await s.edited();
    await s.run('session-start', { hook_event_name: 'SessionStart', source: 'resume' });
    await s.run('session-start', { hook_event_name: 'SessionStart', source: 'startup' });
    expect((await s.tryEdit()).denied).toBe(false);
  });
});
