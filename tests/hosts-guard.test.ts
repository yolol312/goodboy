import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyHost, readHostRules, removedProduction } from '../lib/outward-command';

// Track G security review: `.goodboy/hosts` production entries are the user's (R2). Files
// are merged up the tree; the model may add hosts but not remove a production one.

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-hosts-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, '.goodboy'), { recursive: true });
  const hosts = join(cwd, '.goodboy', 'hosts');
  writeFileSync(hosts, 'production api.corp.net\nallow staging.corp.net\n');
  const sid = `hosts-${Math.random().toString(36).slice(2)}`;
  const run = async (hook: string, payload: Record<string, unknown>, env: Record<string, string> = {}) => {
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1', ...env },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '', system: String(out.systemMessage ?? '') };
  };
  return { cwd, hosts, run };
}

describe('merged rules', () => {
  test("a nearer file adds entries and never drops a parent's production one", () => {
    const s = sandbox();
    const sub = join(s.cwd, 'pkg');
    mkdirSync(join(sub, '.goodboy'), { recursive: true });
    writeFileSync(join(sub, '.goodboy', 'hosts'), ''); // empty: used to replace the root list
    expect(classifyHost('api.corp.net', readHostRules(sub))).toBe('production');
    writeFileSync(join(sub, '.goodboy', 'hosts'), 'allow api.corp.net\nallow dev.pkg.net\n');
    const rules = readHostRules(sub);
    expect(classifyHost('api.corp.net', rules)).toBe('production'); // production wins
    expect(classifyHost('dev.pkg.net', rules)).toBe('allow');
  });

  test('removedProduction', () => {
    expect(removedProduction('production a\nproduction b\n', 'production b\nallow a\n')).toEqual(['a']);
    expect(removedProduction('production a\n', 'production A\nproduction c\n')).toEqual([]);
    expect(removedProduction('allow a\n', '')).toEqual([]);
  });
});

describe('PreToolUse', () => {
  test('Edit, Write and MultiEdit that drop a production entry are denied; adding is fine', async () => {
    const s = sandbox();
    const edit = await s.run('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: s.hosts, old_string: 'production api.corp.net\n', new_string: '' } });
    expect(edit.denied).toBe(true);
    expect(edit.reason).toContain('api.corp.net');
    const write = await s.run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: s.hosts, content: 'allow api.corp.net\n' } });
    expect(write.denied).toBe(true);
    const multi = await s.run('pre-tool-use', {
      tool_name: 'MultiEdit',
      tool_input: { file_path: s.hosts, edits: [{ old_string: 'production', new_string: 'allow' }] },
    });
    expect(multi.denied).toBe(true);
    const add = await s.run('pre-tool-use', {
      tool_name: 'Edit',
      tool_input: { file_path: s.hosts, old_string: 'allow staging.corp.net\n', new_string: 'allow staging.corp.net\nproduction db.corp.net\n' },
    });
    expect(add.reason).not.toContain('production entries');
  });

  test('a Bash write to the hosts file is denied', async () => {
    const s = sandbox();
    const out = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'echo "allow x" > .goodboy/hosts' } });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('Bash may not write .goodboy/hosts');
  });

  test('a production command wrapped in sh -c is still denied (refactoring review)', async () => {
    const s = sandbox();
    const out = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: "sh -c 'curl -X POST https://api.corp.net/v1/x'" } });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('production');
  });

  test('an unreadable, replaced or redirected hosts file lifts nothing within the session (security review)', async () => {
    const s = sandbox();
    const prod = 'curl -X POST https://api.corp.net/v1/x';
    expect((await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: prod } })).denied).toBe(true);
    for (const swap of [
      () => require('node:fs').chmodSync(s.hosts, 0),
      () => {
        require('node:fs').chmodSync(s.hosts, 0o644);
        rmSync(s.hosts);
        mkdirSync(s.hosts);
      },
      () => {
        rmSync(s.hosts, { recursive: true });
        require('node:fs').symlinkSync('/dev/null', s.hosts);
      },
    ]) {
      swap();
      expect((await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: prod } })).denied).toBe(true);
    }
  });

  test('a hosts file that cannot be read as a plain file makes every external host production, also in a new session', () => {
    const s = sandbox();
    require('node:fs').chmodSync(s.hosts, 0);
    const rules = readHostRules(s.cwd);
    expect(rules.broken).toEqual([s.hosts]);
    expect(classifyHost('api.other.net', rules)).toBe('production');
    expect(classifyHost('localhost', rules)).toBe('local');
    require('node:fs').chmodSync(s.hosts, 0o644);
    rmSync(s.hosts);
    require('node:fs').symlinkSync('/dev/null', s.hosts);
    expect(classifyHost('api.other.net', readHostRules(s.cwd))).toBe('production');
  });

  test('the denial for an unreadable hosts file names it and does not call the host "listed"', async () => {
    const s = sandbox();
    require('node:fs').chmodSync(s.hosts, 0);
    const r = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'curl -X POST https://api.other.net/v1/x -d a=1' } }, { GOODBOY_PUSH_TEST_GATE: 'off' });
    require('node:fs').chmodSync(s.hosts, 0o644);
    expect(r.denied).toBe(true);
    expect(r.reason).toContain(`goodboy cannot read ${s.hosts}`);
    expect(r.reason).toContain('treated as production');
    expect(r.reason).not.toContain('listed as production');
  });

  test('`rm .goodboy/hosts; exit 1` (no post hook) lifts no production entry, and the Stop puts it back', async () => {
    const s = sandbox();
    // The push test check off too: the hosts are remembered before every Bash call anyway.
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_hx', tool_input: { command: 'rm .goodboy/hosts; exit 1' } }, { GOODBOY_PUSH_TEST_GATE: 'off' });
    rmSync(s.hosts); // what the command did; no post hook follows
    const next = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'curl -X POST https://api.corp.net/v1/x' } });
    expect(next.denied).toBe(true); // the open call's snapshot still lists it
    await s.run('stop', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(readFileSync(s.hosts, 'utf8')).toContain('production api.corp.net');
  });
});

describe('after a Bash call', () => {
  test('production entries the command removed are put back, and the user is told', async () => {
    const s = sandbox();
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_h1', tool_input: { command: 'rm .goodboy/hosts' } });
    rmSync(s.hosts); // what the command did
    const post = await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_h1', tool_input: { command: 'rm .goodboy/hosts' }, tool_response: {} });
    expect(readFileSync(s.hosts, 'utf8')).toContain('production api.corp.net');
    expect(post.context).toContain('put back production entries');
    expect(post.system).toContain('production 항목을 되돌렸어요');
  });
});
