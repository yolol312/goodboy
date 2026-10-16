import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { changedFilesSince, writesIndirectly } from '../lib/write-sweep';

// Track G write-bypass detection: files an interpreter or a nested shell wrote during a Bash
// call reach the edit log, so the review and test gates cover them.

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-ws-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  for (const a of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']]) Bun.spawnSync(['git', ...a], { cwd });
  writeFileSync(join(cwd, '.gitignore'), 'dist/\n');
  writeFileSync(join(cwd, 'src', 'old.ts'), 'old\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd });
  Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'i'], { cwd });
  return { base, cwd };
}

describe('writesIndirectly', () => {
  test('interpreters and nested shells', () => {
    for (const c of [
      'python3 - <<EOF\nopen("a.ts","w")\nEOF',
      'python -c "x"',
      'node -e "require(\'fs\')"',
      'perl -pi -e s/a/b/ f',
      'ruby x.rb',
      'bun -e "1"',
      'bun run build',
      'sh -c "cat > a"',
      'bash -c x',
      'echo a | xargs touch',
      'find . -name x -exec rm {} \\;',
      'awk \'{print > "f"}\' in',
      'cd x && python3 gen.py',
      'FOO=1 /usr/bin/python3 x.py 2>&1',
    ]) {
      expect([c, writesIndirectly(c)]).toEqual([c, true]);
    }
    for (const c of ['bun test', 'git status', 'ls -la', 'cat a.ts', 'echo python', 'grep node file', 'npm test', 'nodejs-tool', 'sh script.sh', 'find . -name x']) {
      expect([c, writesIndirectly(c)]).toEqual([c, false]);
    }
  });
});

describe('changedFilesSince', () => {
  test('modified and untracked files changed since the start; not older ones, ignored ones or goodboy artifacts', () => {
    const r = repo();
    const old = Date.now() / 1000 - 120;
    writeFileSync(join(r.cwd, 'src', 'stale.ts'), 'x'); // untracked, but written before the call
    utimesSync(join(r.cwd, 'src', 'stale.ts'), old, old);
    // The sweep counts ctime too (a rename keeps the mtime: track I), and utimes sets the ctime
    //   to now, so the call starts a little later.
    Bun.sleepSync(300);
    const since = Date.now() - 100;
    writeFileSync(join(r.cwd, 'src', 'old.ts'), 'changed\n');
    writeFileSync(join(r.cwd, 'src', 'new.ts'), 'new\n');
    mkdirSync(join(r.cwd, 'dist'));
    writeFileSync(join(r.cwd, 'dist', 'out.js'), 'x');
    mkdirSync(join(r.cwd, '.claude', 'tests'), { recursive: true });
    writeFileSync(join(r.cwd, '.claude', 'tests', 'r.json'), '{}');
    expect(changedFilesSince(join(r.cwd, 'src'), since).sort()).toEqual([join(r.cwd, 'src', 'new.ts'), join(r.cwd, 'src', 'old.ts')].sort());
  });

  test('outside a git repo: nothing', () => {
    const d = mkdtempSync(join(tmpdir(), 'goodboy-ws-nogit-'));
    tmpDirs.push(d);
    writeFileSync(join(d, 'a.ts'), 'x');
    expect(changedFilesSince(d, 0)).toEqual([]);
  });
});

describe('through the hooks', () => {
  test('a Python heredoc write is recorded as an edit and the model is told', async () => {
    const r = repo();
    const sid = `ws-${Math.random().toString(36).slice(2)}`;
    const env = { ...process.env, TMPDIR: r.base, GOODBOY_DISABLE_DELEGATION: '1' };
    const command = 'python3 - <<EOF\nopen("src/gen.ts","w").write("x")\nEOF';
    const run = async (hook: string, payload: Record<string, unknown>) => {
      const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
        cwd: r.cwd,
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd: r.cwd, tool_name: 'Bash', tool_use_id: 'toolu_ws1', tool_input: { command }, ...payload })),
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { additionalContext?: string } };
      await proc.exited;
      return out;
    };
    await run('pre-tool-use', { hook_event_name: 'PreToolUse' });
    writeFileSync(join(r.cwd, 'src', 'gen.ts'), 'x'); // what the command did
    const post = await run('post-tool-use', { hook_event_name: 'PostToolUse', tool_response: { stdout: '' } });
    expect(post.hookSpecificOutput?.additionalContext ?? '').toContain('wrote project files outside Edit/Write');
    const edits = readFileSync(join(r.base, `goodboy-session-${sid}`, 'edits.jsonl'), 'utf8');
    expect(edits).toContain(join(r.cwd, 'src', 'gen.ts'));
  });
});
