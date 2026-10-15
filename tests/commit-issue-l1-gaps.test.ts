// Layer-1 gaps in the commit issue rule (lib/commit-issue.ts), last G1 round. Each test here
// fails until its finding (F1–F9 in the layer-1 record under .claude/tests/) is fixed.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalMarkerPath, approvalMarkerRelPath, userMarkerPresent } from '../lib/approval-marker';
import { commitIssueDenial, commitIssueRule } from '../lib/commit-issue';

const ROOT = resolve(import.meta.dir, '..');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
}

function tmp(prefix = 'goodboy-ci-l1-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A repo whose last commit message is `head` (`at`: inside an existing dir). */
function repo(head = 'ABC-1 init', at?: string): string {
  const dir = at ?? tmp();
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', head);
  return dir;
}

const sid = () => `cil1-${Math.random().toString(36).slice(2)}`;
const claudeCommit = (subject: string) =>
  `git commit -m "$(cat <<'EOF'\n${subject}\n\nBody.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF\n)"`;

/** One hook run; `killed` when it did not decide within `killAfterMs` (Claude Code then lets
 *  the call through: a hook that times out is a non-blocking error). */
async function hook(
  file: string,
  cwd: string,
  command: string,
  o: { sessionId?: string; toolUseId?: string; env?: Record<string, string>; killAfterMs?: number } = {},
) {
  const payload = {
    session_id: o.sessionId ?? sid(),
    cwd,
    hook_event_name: file === PRE ? 'PreToolUse' : 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: o.toolUseId ?? `tu-${Math.random().toString(36).slice(2)}`,
    ...(file === POST ? { tool_response: { stdout: '', stderr: '' } } : {}),
  };
  const proc = Bun.spawn(['bun', file], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_COMMIT_ISSUE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off', ...(o.env ?? {}) },
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill(9);
  }, o.killAfterMs ?? 20_000);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  let decision: string | undefined;
  try {
    decision = (JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  } catch {
    decision = 'unparsable';
  }
  return { killed, decision };
}

describe('F1: a message file the hook cannot finish reading', () => {
  test('-F naming a FIFO is decided, not read until the hook times out (which lets the call through)', async () => {
    const r = repo();
    expect(Bun.spawnSync(['mkfifo', join(r, 'msg')]).exitCode).toBe(0);
    const out = await hook(PRE, r, 'git commit -F msg', { killAfterMs: 10_000 });
    expect(out).toEqual({ killed: false, decision: 'deny' });
  }, 20_000);
});

describe('F2: a reused-message value reaches `git log` as an option', () => {
  test('-C/-c/--reuse-message/--fixup/--squash values that look like options write no file', () => {
    const r = repo();
    const cases = [
      ['git commit -C --output=out1.txt', 'out1.txt'],
      ['git commit -c --output=out2.txt', 'out2.txt'],
      ['git commit --reuse-message=--output=out3.txt', 'out3.txt'],
      ['git commit --fixup=--output=out4.txt', 'out4.txt'],
      ['git commit --squash=amend:--output=out5.txt', 'out5.txt'],
    ] as const;
    for (const [c] of cases) expect([c, commitIssueDenial(c, r, sid()) === null]).toEqual([c, false]);
    expect(cases.filter(([, f]) => existsSync(join(r, f))).map(([c]) => c)).toEqual([]);
  });

  test("through the hook, it cannot forge the user's Stop marker", async () => {
    const r = repo();
    mkdirSync(join(r, '.claude'));
    const s = sid();
    const marker = approvalMarkerPath(r, 'stop', s);
    expect((await hook(PRE, r, `touch ${approvalMarkerRelPath('stop', s)}`, { sessionId: s })).decision).toBe('deny');
    await hook(PRE, r, `git commit -C --output=${approvalMarkerRelPath('stop', s)}`, { sessionId: s });
    expect(existsSync(marker) && userMarkerPresent(s, marker)).toBe(false);
  }, 30_000);
});

describe('F3: alias lookups are not bounded', () => {
  test('300 unknown git subcommands cost a bounded number of git spawns (3000 ran the hook past 60 s)', async () => {
    const r = repo();
    const bin = tmp('goodboy-ci-l1-bin-');
    const log = join(bin, 'calls.log');
    const realGit = Bun.which('git');
    expect(realGit).not.toBeNull();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const command = Array.from({ length: 300 }, (_, i) => `git zz${i}`).join('; ') + '; git commit -m fix';
    const out = await hook(PRE, r, command, { env: { PATH: `${bin}:${process.env.PATH}` }, killAfterMs: 50_000 });
    expect(out).toEqual({ killed: false, decision: 'deny' });
    const lookups = (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.startsWith('config --get alias.')).length;
    expect(lookups).toBeLessThanOrEqual(20);
  }, 60_000);

  test('300 identical `git commit --amend --no-edit` read the reused message a bounded number of times', async () => {
    const r = repo();
    const bin = tmp('goodboy-ci-l1-bin-');
    const log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${Bun.which('git')}" "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const command = Array.from({ length: 300 }, () => 'git commit --amend --no-edit').join(' && ');
    const out = await hook(PRE, r, command, { env: { PATH: `${bin}:${process.env.PATH}` }, killAfterMs: 50_000 });
    expect(out.killed).toBe(false);
    const reads = (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.startsWith('log -1 --format=%B')).length;
    expect(reads).toBeLessThanOrEqual(20);
  }, 60_000);
});

describe('F4: the session pin follows symlinks', () => {
  test('a .goodboy/commit-issue or .goodboy planted as a link to an old "off" is a new setting', () => {
    const other = tmp();
    mkdirSync(join(other, '.goodboy'));
    writeFileSync(join(other, '.goodboy', 'commit-issue'), 'off\n');
    Bun.sleepSync(20);
    const since = Date.now();
    Bun.sleepSync(20);
    const file = repo();
    mkdirSync(join(file, '.goodboy'));
    symlinkSync(join(other, '.goodboy', 'commit-issue'), join(file, '.goodboy', 'commit-issue'));
    const dir = repo();
    symlinkSync(join(other, '.goodboy'), join(dir, '.goodboy'));
    expect([commitIssueRule(file, since).on, commitIssueRule(dir, since).on]).toEqual([true, true]);
  });
});

describe('F5: the session pin is not gate state', () => {
  test('a Bash call that rewrites commit-issue-since (from an interpreter) does not unpin the session', async () => {
    const r = repo();
    const s = sid();
    expect((await hook(PRE, r, 'git commit -m "ABC-1 x"', { sessionId: s })).decision).toBeUndefined();
    const py = `python3 -c "import os,tempfile;d=os.path.join(tempfile.gettempdir(),'goodboy-'+'session-${s}');open(os.path.join(d,'commit-issue-since'),'w').write('9'*14)"`;
    expect((await hook(PRE, r, py, { sessionId: s, toolUseId: 'tu-py' })).decision).toBeUndefined();
    expect(Bun.spawnSync(['sh', '-c', py], { cwd: r }).exitCode).toBe(0);
    await hook(POST, r, py, { sessionId: s, toolUseId: 'tu-py' });
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    expect((await hook(PRE, r, 'git commit -m fix', { sessionId: s })).decision).toBe('deny');
    rmSync(join(tmpdir(), `goodboy-session-${s}`), { recursive: true, force: true });
  }, 30_000);
});

describe("F6: a project pattern anchored at the subject's start", () => {
  test("matches Claude Code's heredoc commit by its message, not by the command text", () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), '^[A-Z][A-Z0-9]+-\\d+ \n');
    Bun.sleepSync(20);
    expect(commitIssueDenial('git commit -m "ABC-1 subject"', r, sid())).toBeNull();
    expect(commitIssueDenial(claudeCommit('ABC-1 subject'), r, sid())).toBeNull();
    expect(commitIssueDenial(claudeCommit('fix: subject ABC-1'), r, sid())).toContain('no issue number');
  });
});

describe('F7: commits the push gate reads but this rule does not', () => {
  test('an inline (-c alias.x=commit), shell (!git commit) or chained alias', () => {
    const r = repo();
    expect(commitIssueDenial('git -c alias.ci=commit ci -m fix', r, sid())).toContain('no issue number');
    git(r, 'config', 'alias.sci', '!git commit');
    expect(commitIssueDenial('git sci -m fix', r, sid())).not.toBeNull();
    git(r, 'config', 'alias.ci', 'commit');
    git(r, 'config', 'alias.c', 'ci');
    expect(commitIssueDenial('git c -m fix', r, sid())).not.toBeNull();
  });

  test('a shell reading its script from a heredoc; a plain heredoc stays data', () => {
    const r = repo();
    expect(commitIssueDenial("bash <<'EOF'\ngit commit -m fix\nEOF", r, sid())).not.toBeNull();
    expect(commitIssueDenial("sh -s <<'EOF'\ngit commit -m fix\nEOF", r, sid())).not.toBeNull();
    expect(commitIssueDenial("cat <<'EOF'\ngit commit -m fix\nEOF", r, sid())).toBeNull();
  });
});

describe('F8: git -C <dir> commits in <dir>', () => {
  test('the reused message and the project setting come from <dir>, not from the cwd', () => {
    const r = repo('ABC-1 init');
    const sub = repo('no issue here', join(r, 'sub'));
    expect(commitIssueDenial('git -C sub commit --amend --no-edit', r, sid())).toContain('no issue number');
    mkdirSync(join(sub, '.goodboy'));
    writeFileSync(join(sub, '.goodboy', 'commit-issue'), 'off\n');
    Bun.sleepSync(20);
    expect(commitIssueDenial('git -C sub commit -m fix', r, sid())).toBeNull();
  });
});
