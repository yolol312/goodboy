// I10, from the fourth real-use trial: the hooks read the project's records, edit scope, state
// and approval markers from CLAUDE_PROJECT_DIR, not from the hook's `cwd`. Claude Code hands the
// hooks the shell's current dir, which follows a model's `cd` (measured on 2.1.306); a Stop from
// a subdir counted only the edits below it and passed an untested change elsewhere.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalMarkerShown } from '../lib/approval-marker';
import { cliProjectDir, noteProjectDir, projectDir } from '../lib/project-dir';

const PRE_HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

describe('projectDir', () => {
  test('CLAUDE_PROJECT_DIR when the cwd is it or below it; else the cwd', () => {
    const p = dir('goodboy-i10-p-');
    const sub = join(p, 'docs', 'sub');
    mkdirSync(sub, { recursive: true });
    const other = dir('goodboy-i10-o-');
    expect(projectDir(sub, { CLAUDE_PROJECT_DIR: p })).toBe(p);
    expect(projectDir(p, { CLAUDE_PROJECT_DIR: p })).toBe(p);
    // A worktree or any dir outside the project, an unset or relative variable: the cwd.
    expect(projectDir(other, { CLAUDE_PROJECT_DIR: p })).toBe(other);
    expect(projectDir(sub, {})).toBe(sub);
    expect(projectDir(sub, { CLAUDE_PROJECT_DIR: 'rel/dir' })).toBe(sub);
    // A sibling whose name starts like the project's is outside it.
    expect(projectDir(`${p}-x`, { CLAUDE_PROJECT_DIR: p })).toBe(`${p}-x`);
  });

  test('a cwd that reaches the project through a link counts as inside it', () => {
    const p = dir('goodboy-i10-p-');
    mkdirSync(join(p, 'sub'));
    const links = dir('goodboy-i10-l-');
    const link = join(links, 'to-sub');
    symlinkSync(join(p, 'sub'), link);
    expect(projectDir(link, { CLAUDE_PROJECT_DIR: p })).toBe(p);
  });
});

describe('the Stop gates after a cd into a subdir', () => {
  /** A git repo with one committed file changed since, and a session that recorded that edit
   *  with no test or review record. */
  function sandbox(): { root: string; sub: string; tmp: string } {
    const base = dir('goodboy-i10-');
    const root = join(base, 'repo');
    const tmp = join(base, 'tmp');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'docs', 'sub'), { recursive: true });
    mkdirSync(join(root, 'tests'));
    mkdirSync(tmp);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'bun test' } }));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'tests', 'a.test.ts'), 'import { test, expect } from "bun:test";\ntest("a", () => expect(1).toBe(1));\n');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const c of [['init', '-q'], ['add', '.'], ['-c', 'user.email=p@x', '-c', 'user.name=p', 'commit', '-qm', 'init']]) Bun.spawnSync(['git', ...c], { cwd: root, env });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
    return { root, sub: join(root, 'docs', 'sub'), tmp };
  }

  async function stop(s: ReturnType<typeof sandbox>, cwd: string, env: Record<string, string>): Promise<{ decision?: string; reason?: string }> {
    const sid = `sess-${Math.random().toString(36).slice(2)}`;
    const sdir = join(s.tmp, `goodboy-session-${sid}`);
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'turn.txt'), '3');
    writeFileSync(join(sdir, 'edits.jsonl'), JSON.stringify({ file: join(s.root, 'src', 'a.ts'), turn: 3, timestamp: new Date().toISOString() }) + '\n');
    const tp = join(s.tmp, `${sid}.jsonl`);
    writeFileSync(tp, [JSON.stringify({ type: 'user', message: { role: 'user', content: 'change a' } }), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Changed a to 2.' }] } })].join('\n') + '\n');
    const p = Bun.spawn(['bun', STOP_HOOK], {
      cwd,
      env: { ...process.env, TMPDIR: s.tmp, HOME: s.tmp, GOODBOY_SKILL_GATE: 'off', ...env },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, hook_event_name: 'Stop', transcript_path: tp })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    try {
      return JSON.parse(out);
    } catch {
      return {};
    }
  }

  test('an untested change outside the subdir is still blocked, as from the root', async () => {
    const s = sandbox();
    const fromRoot = await stop(s, s.root, { CLAUDE_PROJECT_DIR: s.root });
    const fromSub = await stop(s, s.sub, { CLAUDE_PROJECT_DIR: s.root });
    expect([fromRoot.decision, fromSub.decision]).toEqual(['block', 'block']);
    expect(fromSub.reason).toContain('No test result covers the changed code');
  }, 60_000);
});

describe('PreToolUse after a cd into a subdir', () => {
  test('a push with no test record is denied and the approval dir lands at the project root', async () => {
    const base = dir('goodboy-i10-pre-');
    const root = join(base, 'repo');
    const tmp = join(base, 'tmp');
    const sub = join(root, 'docs', 'sub');
    mkdirSync(sub, { recursive: true });
    mkdirSync(tmp);
    writeFileSync(join(root, 'a.txt'), 'a\n');
    const genv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    for (const c of [['init', '-q'], ['add', '.'], ['-c', 'user.email=p@x', '-c', 'user.name=p', 'commit', '-qm', 'init'], ['remote', 'add', 'origin', 'https://example.invalid/x.git']]) Bun.spawnSync(['git', ...c], { cwd: root, env: genv });
    const p = Bun.spawn(['bun', PRE_HOOK], {
      cwd: sub,
      env: { ...process.env, TMPDIR: tmp, HOME: tmp, CLAUDE_PROJECT_DIR: root, GOODBOY_SKILL_GATE: 'off' },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'i10-pre', cwd: sub, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, tool_use_id: 'tu1' })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain('"deny"');
    expect(existsSync(join(root, '.claude'))).toBe(true);
    expect(existsSync(join(sub, '.claude'))).toBe(false);
  }, 60_000);
});

describe('I10 review: worktrees, approval paths, the CLI', () => {
  test("an agent's git worktree is its own project; any other nested `.git` is not", () => {
    const p = dir('goodboy-i10-p-');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    writeFileSync(join(p, 'a.txt'), 'a\n');
    for (const c of [['init', '-q'], ['add', '.'], ['-c', 'user.email=p@x', '-c', 'user.name=p', 'commit', '-qm', 'init'], ['worktree', 'add', '-q', '.claude/worktrees/agent-1']]) {
      Bun.spawnSync(['git', ...c], { cwd: p, env });
    }
    const wt = join(p, '.claude', 'worktrees', 'agent-1');
    mkdirSync(join(wt, 'src'), { recursive: true });
    expect(projectDir(join(wt, 'src'), { CLAUDE_PROJECT_DIR: p })).toBe(wt);
    expect(projectDir(wt, { CLAUDE_PROJECT_DIR: p })).toBe(wt);
    // A `.git` a model makes elsewhere, or a fake worktree dir, narrows nothing (review 2).
    mkdirSync(join(p, 'docs', 'sub', '.git'), { recursive: true });
    expect(projectDir(join(p, 'docs', 'sub'), { CLAUDE_PROJECT_DIR: p })).toBe(p);
    mkdirSync(join(p, '.claude', 'worktrees', 'fake', '.git'), { recursive: true });
    expect(projectDir(join(p, '.claude', 'worktrees', 'fake'), { CLAUDE_PROJECT_DIR: p })).toBe(p);
    // A project dir of `/` is never used.
    expect(projectDir(p, { CLAUDE_PROJECT_DIR: '/' })).toBe(p);
  });

  test("the approval path is relative from the project dir, absolute and quoted from elsewhere (the user's `!` runs there)", () => {
    const p = dir("goodboy-i10-it's-");
    expect(approvalMarkerShown(p, 'stop', 'sess-1', p)).toMatch(/^\.claude\/\.goodboy-stop-approved-[\w-]+\.txt$/);
    const shown = approvalMarkerShown(p, 'stop', 'sess-1', join(p, 'docs'));
    expect(shown.startsWith(`'${p.replaceAll("'", `'\\''`)}/.claude/.goodboy-stop-approved-`)).toBe(true);
    // The shell reads the quoted path back as the marker's absolute path.
    const echoed = Bun.spawnSync(['sh', '-c', `printf %s ${shown}`]).stdout.toString();
    expect(echoed.startsWith(`${p}/.claude/.goodboy-stop-approved-`)).toBe(true);
  });

  test("the CLI resolves a file named on the command line from the shell's dir (review 2)", () => {
    const p = dir('goodboy-i10-p-');
    mkdirSync(join(p, 'pkg'));
    writeFileSync(join(p, 'pkg', 'lcov.info'), 'SF:a.ts\nDA:1,1\nend_of_record\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: p, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const cli = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
    const r = Bun.spawnSync(['bun', cli, 'diff-coverage', 'lcov.info'], { cwd: join(p, 'pkg'), env: { ...process.env, CLAUDE_PROJECT_DIR: p }, stdout: 'pipe', stderr: 'pipe' });
    const said = `${r.stdout}${r.stderr}`;
    expect(said).not.toContain('not inside a git repository');
    expect(said).not.toContain('no coverage report');
  });

  test('the CLI finds the project dir the hooks noted for its session', () => {
    const t = dir('goodboy-i10-t-');
    const p = dir('goodboy-i10-p-');
    mkdirSync(join(p, 'sub'));
    const old = process.env.TMPDIR;
    process.env.TMPDIR = t;
    try {
      expect(cliProjectDir(join(p, 'sub'), { CLAUDE_CODE_SESSION_ID: 'sess-i10' })).toBe(join(p, 'sub'));
      noteProjectDir('sess-i10', { CLAUDE_PROJECT_DIR: p });
      expect(cliProjectDir(join(p, 'sub'), { CLAUDE_CODE_SESSION_ID: 'sess-i10' })).toBe(p);
      // Another session's note, a cwd outside the noted dir, and CLAUDE_PROJECT_DIR itself.
      expect(cliProjectDir(join(p, 'sub'), { CLAUDE_CODE_SESSION_ID: 'sess-other' })).toBe(join(p, 'sub'));
      expect(cliProjectDir(t, { CLAUDE_CODE_SESSION_ID: 'sess-i10' })).toBe(t);
      expect(cliProjectDir(join(p, 'sub'), { CLAUDE_PROJECT_DIR: p })).toBe(p);
      // A link planted at the note's name is replaced, never written through.
      const victim = join(t, 'victim.txt');
      writeFileSync(victim, 'ORIG');
      const note = join(t, 'goodboy-session-sess-link', 'project-dir.txt');
      mkdirSync(join(t, 'goodboy-session-sess-link'));
      symlinkSync(victim, note);
      noteProjectDir('sess-link', { CLAUDE_PROJECT_DIR: p });
      expect(readFileSync(victim, 'utf8')).toBe('ORIG');
      expect(cliProjectDir(join(p, 'sub'), { CLAUDE_CODE_SESSION_ID: 'sess-link' })).toBe(p);
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
  });
});
