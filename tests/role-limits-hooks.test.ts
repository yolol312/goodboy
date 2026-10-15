import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Track G role limits through the PreToolUse hook.

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-role-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'tests'), { recursive: true });
  const sid = `role-${Math.random().toString(36).slice(2)}`;
  const run = async (agentType: string | null, tool: string, toolInput: Record<string, unknown>, env: Record<string, string> = {}) => {
    const payload = {
      session_id: sid,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: toolInput,
      ...(agentType ? { agent_type: agentType, agent_id: 'x1' } : {}),
    };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_REASONING_GATE: 'off', ...env },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
  };
  return { cwd, run };
}

describe('writes', () => {
  test('a reviewer may not Write a project file', async () => {
    const { cwd, run } = setup();
    const r = await run('goodboy:review-all', 'Write', { file_path: join(cwd, 'src', 'fix.ts'), content: 'x' });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('through the goodboy CLI');
  });

  test('a test writer may Write a test file but not Edit source', async () => {
    const { cwd, run } = setup();
    expect((await run('goodboy:test-unit', 'Write', { file_path: join(cwd, 'tests', 'a.test.ts'), content: 'x' })).denied).toBe(false);
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    const r = await run('goodboy:test-unit', 'Edit', { file_path: join(cwd, 'src', 'a.ts'), old_string: '1', new_string: '2' });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('test files only');
  });

  test('Bash writes count too', async () => {
    const { run } = setup();
    const r = await run('goodboy:research-code', 'Bash', { command: 'echo x > src/notes.ts' });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('read-only');
  });

  test('a reviewer may write a probe outside the project', async () => {
    const { run } = setup();
    expect((await run('goodboy:review-security', 'Write', { file_path: '/tmp/goodboy-probe-x/p.ts', content: 'x' })).denied).toBe(false);
  });

  test('built-in agents and the main session are not limited by roles', async () => {
    const { cwd, run } = setup();
    const r = await run('general-purpose', 'Write', { file_path: join(cwd, 'src', 'new.ts'), content: 'x' });
    expect(r.reason).not.toContain('goodboy CLI');
    expect((await run(null, 'Write', { file_path: join(cwd, 'src', 'new2.ts'), content: 'x' })).reason).not.toContain('read-only');
  });
});

describe('Bash changes beyond redirects (security review)', () => {
  test('a read-only role may not cp/mv/rm/touch project files, run a mutating git command, or write .git/.claude', async () => {
    const { run } = setup();
    for (const command of [
      'cp /tmp/x src/a.ts',
      'mv src/a.ts src/b.ts',
      'rm -f src/a.ts',
      'touch src/new.ts',
      'git checkout -- src',
      'git -C . stash',
      "perl -pi -e 's/a/b/' src/a.ts",
      'echo "#!/bin/sh" > .git/hooks/pre-push',
      'echo {} > .claude/settings.local.json',
    ]) {
      const r = await run('goodboy:review-all', 'Bash', { command });
      expect([command, r.denied]).toEqual([command, true]);
    }
  });

  test('reads and writes outside the project pass; a test role may change test files, not code', async () => {
    const { run } = setup();
    for (const command of ['git status', 'git diff', 'ls src', 'cp src/a.ts /tmp/probe.ts', 'mkdir -p /tmp/goodboy-probe-x']) {
      const r = await run('goodboy:review-all', 'Bash', { command });
      expect([command, r.reason]).toEqual([command, expect.not.stringContaining('may not')]);
    }
    expect((await run('goodboy:test-unit', 'Bash', { command: 'cp /tmp/x tests/a.test.ts' })).denied).toBe(false);
    expect((await run('goodboy:test-unit', 'Bash', { command: 'rm src/a.ts' })).denied).toBe(true);
    expect((await run('goodboy:build-backend', 'Bash', { command: 'git checkout -- src' })).reason).not.toContain('may not');
  });
});

describe('tool skills', () => {
  test('own tool skill passes; another role tool skill and a workflow skill are denied', async () => {
    const { run } = setup();
    expect((await run('goodboy:review-security', 'Skill', { skill: 'goodboy:check-security' })).denied).toBe(false);
    expect((await run('goodboy:review-security', 'Skill', { skill: 'goodboy:write-migration' })).denied).toBe(true);
    const wf = await run('goodboy:test-unit', 'Skill', { skill: 'goodboy:fix-bug' });
    expect(wf.denied).toBe(true);
    expect(wf.reason).toContain('Workflow skills belong to the main session');
  });

  test('GOODBOY_ROUTING_GATE=off lifts role limits', async () => {
    const { cwd, run } = setup();
    expect((await run('goodboy:review-all', 'Write', { file_path: join(cwd, 'src', 'f.ts'), content: 'x' }, { GOODBOY_ROUTING_GATE: 'off' })).reason).not.toContain('goodboy CLI');
    expect((await run('goodboy:test-unit', 'Skill', { skill: 'goodboy:fix-bug' }, { GOODBOY_ROUTING_GATE: 'off' })).denied).toBe(false);
  });
});
