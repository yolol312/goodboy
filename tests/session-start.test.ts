import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configWarnings } from '../hooks/session-start';

// Track G §10.5: configuration warnings at session start.

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'session-start.ts');

async function run(source: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(['bun', HOOK], {
    stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: 'SessionStart', source })),
    stdout: 'pipe',
    stderr: 'pipe',
    // GOODBOY_INBOX_DIR points at a missing directory, so the developer's real field-report inbox
    // never adds its notice to the output.
    env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: '', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '', GOODBOY_INBOX_DIR: resolve(import.meta.dir, '..', 'no-such-inbox-dir'), ...env },
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

// (#21) SessionStart notes the project's worktrees, so a nested worktree outside
// .claude/worktrees counts as its own project only when it existed at the start.
describe('worktree pins', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function start(source: string, project: string, sid: string, tmp: string): Promise<void> {
    const proc = Bun.spawn(['bun', HOOK], {
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: sid, cwd: project })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        TMPDIR: tmp,
        CLAUDE_PROJECT_DIR: project,
        GOODBOY_INBOX_DIR: join(tmp, 'no-inbox'),
        CLAUDE_CODE_EFFORT_LEVEL: '',
        CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    await new Response(proc.stdout).text();
    await proc.exited;
  }

  test('the hook writes the worktrees that exist at the start, once, and not on a compaction', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'goodboy-ss-tmp-'));
    const project = mkdtempSync(join(tmpdir(), 'goodboy-ss-proj-'));
    dirs.push(tmp, project);
    const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.email=p@x', '-c', 'user.name=p', ...a], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    writeFileSync(join(project, 'a.txt'), 'a\n');
    git('init', '-q');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('worktree', 'add', '-q', '.worktrees/v2');
    const note = join(tmp, 'goodboy-session-ss-1', 'worktrees.txt');

    await start('compact', project, 'ss-1', tmp);
    expect(existsSync(note)).toBe(false);

    await start('startup', project, 'ss-1', tmp);
    const listed = readFileSync(note, 'utf8').split('\n');
    expect(listed).toContain(realpathSync(project));
    expect(listed).toContain(realpathSync(join(project, '.worktrees', 'v2')));

    // A worktree added later is not in the note, and a resume keeps the note as it was.
    git('worktree', 'add', '-q', '--detach', 'docs/.late', 'HEAD');
    await start('resume', project, 'ss-1', tmp);
    expect(readFileSync(note, 'utf8')).not.toContain('.late');
  }, 30_000);
});
