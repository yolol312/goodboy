import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// hooks/post-tool-use-failure.ts (track G §10.7): a failed Agent/Task call is logged as done
// (blocked), so the delegation guard stops counting it. It never blocks, whatever it gets.

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'post-tool-use-failure.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-ptuf-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(cwd);
  const sid = `ptuf-${Math.random().toString(36).slice(2)}`;
  const logFile = join(base, `goodboy-session-${sid}`, 'dispatch-log.jsonl');
  const run = async (stdin: string) => {
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stdout, stderr };
  };
  const failure = (fields: Record<string, unknown>) =>
    JSON.stringify({ session_id: sid, cwd, hook_event_name: 'PostToolUseFailure', error: 'API Error: 529', is_interrupt: false, duration_ms: 12, ...fields });
  const records = () =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { run, failure, records };
}

describe('post-tool-use-failure hook', () => {
  test('a failed Task call is logged like a failed Agent call', async () => {
    const s = sandbox();
    const r = await s.run(s.failure({ tool_name: 'Task', tool_use_id: 'toolu_task1', tool_input: { prompt: 'p' } }));
    expect([r.code, r.stdout]).toEqual([0, '{}']);
    const recs = s.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ k: 'done', tuid: 'toolu_task1', agentId: null, outcome: 'blocked' });
    expect(typeof recs[0]!.t).toBe('number');
  });

  test('a user interrupt is logged too (one retry is allowed)', async () => {
    const s = sandbox();
    await s.run(s.failure({ tool_name: 'Agent', tool_use_id: 'toolu_int', is_interrupt: true, error: 'interrupted' }));
    expect(s.records()).toMatchObject([{ k: 'done', tuid: 'toolu_int', outcome: 'blocked' }]);
  });

  test('without a usable tool_use_id nothing is logged', async () => {
    const s = sandbox();
    for (const tuid of [undefined, '', 42, null]) {
      const r = await s.run(s.failure({ tool_name: 'Agent', ...(tuid === undefined ? {} : { tool_use_id: tuid }) }));
      expect([String(tuid), r.code, r.stdout]).toEqual([String(tuid), 0, '{}']);
    }
    expect(s.records()).toEqual([]);
  });

  test('empty, invalid or non-object stdin passes with {} and logs nothing', async () => {
    const s = sandbox();
    for (const stdin of ['', '   \n', '{not json', 'null', '[]', '"Agent"']) {
      const r = await s.run(stdin);
      expect([stdin, r.code, r.stdout]).toEqual([stdin, 0, '{}']);
    }
    expect(s.records()).toEqual([]);
    expect((await s.run('{not json')).stderr).toContain('[goodboy post-tool-use-failure]');
  });

  test('is registered for Agent, Task and Bash failures (a failing Bash skips PostToolUse, G0 M18)', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
    };
    const groups = cfg.hooks.PostToolUseFailure ?? [];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe('Agent|Task|Bash');
    expect(groups[0]!.hooks.map((h) => h.command)).toEqual(['sh "${CLAUDE_PLUGIN_ROOT}/bin/goodboy-run.sh" post-tool-use-failure']);
  });
});
