import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configWarnings } from '../hooks/session-start';

// Track G §10.5: configuration warnings at session start.

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'session-start.ts');

async function run(source: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(['bun', HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: 'SessionStart', source })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '', ...env },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out || '{}') as Record<string, unknown>;
}

describe('configWarnings', () => {
  test('an effort override and a depth below 2', () => {
    expect(configWarnings({ CLAUDE_CODE_EFFORT_LEVEL: 'low' })).toHaveLength(1);
    expect(configWarnings({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' })[0]).toContain('리드 에이전트');
    expect(configWarnings({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2' })).toEqual([]);
    expect(configWarnings({ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' })[0]).toContain('CLAUDE_CODE_SUBAGENT_MODEL=haiku');
    expect(configWarnings({})).toEqual([]);
  });
});

describe('the hook', () => {
  test('warns on startup and resume, not after a compaction', async () => {
    expect(String((await run('startup', { CLAUDE_CODE_EFFORT_LEVEL: 'max' })).systemMessage)).toContain('CLAUDE_CODE_EFFORT_LEVEL=max');
    expect(String((await run('resume', { CLAUDE_CODE_EFFORT_LEVEL: 'max' })).systemMessage)).toContain('max');
    expect(await run('compact', { CLAUDE_CODE_EFFORT_LEVEL: 'max' })).toEqual({});
    expect(await run('startup', {})).toEqual({});
  });

  test('is registered for startup, resume, clear and compact', () => {
    const hooks = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(hooks.hooks.SessionStart?.[0]?.matcher).toBe('startup|resume|clear|compact');
    expect(hooks.hooks.SessionStart?.[0]?.hooks[0]?.command).toContain('session-start');
    expect(hooks.hooks.SubagentStop?.[0]?.hooks[0]?.command).toContain('subagent-stop');
  });
});
