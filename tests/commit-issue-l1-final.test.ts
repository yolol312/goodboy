// Layer-1 gaps found in the final G1 round (after the F1–F10 rewrite of lib/commit-issue.ts).
// Each test fails until its finding (G1–G8 in the layer-1 record under .claude/tests/) is
// fixed. The repos, files and session dirs are temporary; nothing is pushed or published
// (PreToolUse only decides; the commands themselves never run here).
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalMarkerPath, userMarkerPresent } from '../lib/approval-marker';
import { commitIssueDenial, commitIssueRule } from '../lib/commit-issue';

const ROOT = resolve(import.meta.dir, '..');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const START = join(ROOT, 'hooks', 'session-start.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sh(cwd: string, command: string, stdin?: string): string {
  const p = Bun.spawnSync(['sh', '-c', command], { cwd, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${command}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function tmp(prefix = 'goodboy-ci-fin-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

/** A repo whose last commit message is `head` (`at`: inside an existing dir). */
function repo(head = 'ABC-1 init', at?: string): string {
  const dir = at ?? tmp();
  mkdirSync(dir, { recursive: true });
  sh(dir, `git init -q -b main && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false && echo a > a.txt && git add -A && git commit -q -m '${head}'`);
  return dir;
}

/** A session id whose state dir is removed after the test. */
function sid(): string {
  const s = `cifin${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

/** A sparse file of `bytes` (no disk blocks are written). */
function sparse(path: string, bytes: number): void {
  const fd = openSync(path, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

/** An executable script under the repo's .git that creates `target` (and passes stdin through). */
function trap(r: string, name: string, target: string): string {
  const p = join(r, '.git', name);
  writeFileSync(p, `#!/bin/sh\n: > "${target}"\ncat\nexit 1\n`);
  chmodSync(p, 0o755);
  return p;
}

const ENV = { GOODBOY_COMMIT_ISSUE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' };

/** One hook run. `crashed`: the hook died without output (a signal or a non-zero exit),
 *  `killed`: it did not decide within `killAfterMs`. Claude Code runs the call in both cases. */
async function hook(
  file: string,
  cwd: string,
  payload: Record<string, unknown>,
  o: { sessionId: string; killAfterMs?: number; env?: Record<string, string> },
) {
  const proc = Bun.spawn(['bun', file], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: o.sessionId, cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...ENV, ...(o.env ?? {}) },
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill(9);
  }, o.killAfterMs ?? 20_000);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timer);
  let decision: string | undefined;
  try {
    decision = (JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  } catch {
    decision = 'unparsable';
  }
  return { killed, crashed: !killed && (code !== 0 || out === ''), decision };
}

const pre = (cwd: string, command: string, sessionId: string, toolUseId = `tu-${Math.random().toString(36).slice(2)}`, killAfterMs?: number) =>
  hook(PRE, cwd, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId }, { sessionId, killAfterMs });
const post = (cwd: string, command: string, sessionId: string, toolUseId: string) =>
  hook(POST, cwd, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: toolUseId, tool_response: { stdout: '', stderr: '' } }, { sessionId });

/** A model Bash call as Claude Code runs it: PreToolUse, the command when allowed, PostToolUse. */
async function modelCall(cwd: string, command: string, sessionId: string): Promise<string | undefined> {
  const toolUseId = `tu-${Math.random().toString(36).slice(2)}`;
  const d = await pre(cwd, command, sessionId, toolUseId);
  if (d.decision === undefined) {
    Bun.spawnSync(['sh', '-c', command], { cwd });
    await post(cwd, command, sessionId, toolUseId);
  }
  return d.decision;
}

const claudeCommit = (message: string) =>
  `git commit -m "$(cat <<'EOF'\n${message}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nEOF\n)"`;

describe("G1: git run by a hook runs programs from the repo's config, outside any model Bash window", () => {
  // A Stop approval marker made that way is taken as the user's (F2 closed only the option route).
  test("the commit rule's read of a reused message (log.showSignature + gpg.program)", async () => {
    const r = repo();
    mkdirSync(join(r, '.claude'));
    const s = sid();
    const marker = approvalMarkerPath(r, 'stop', s);
    const tree = sh(r, "git rev-parse 'HEAD^{tree}'");
    const parent = sh(r, 'git rev-parse HEAD');
    const signed = sh(
      r,
      'git hash-object -t commit -w --literally --stdin',
      `tree ${tree}\nparent ${parent}\nauthor t <t@example.com> 1700000000 +0000\ncommitter t <t@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQ==\n -----END PGP SIGNATURE-----\n\nABC-1 signed\n`,
    );
    sh(r, `git update-ref HEAD ${signed} && git config log.showSignature true && git config gpg.program "${trap(r, 'sig.sh', marker)}"`);
    await modelCall(r, 'git commit --amend --no-edit', s);
    expect(existsSync(marker) && userMarkerPresent(s, marker)).toBe(false);
  }, 30_000);

  // A known limit (docs/stabilization-plan.md §10.10): with clean filters off, the work-tree
  //   hash of an LFS repo would differ from its commits' trees.
  test.todo("the push gate's work-tree hash of a deploy (a clean filter)", async () => {
    const r = repo();
    mkdirSync(join(r, '.claude'));
    const s = sid();
    const marker = approvalMarkerPath(r, 'stop', s);
    writeFileSync(join(r, '.gitattributes'), '* filter=x\n');
    sh(r, `git config filter.x.clean "${trap(r, 'clean.sh', marker)}" && echo new > b.txt`);
    expect((await pre(r, 'npm publish', s)).decision).toBe('deny');
    expect(existsSync(marker) && userMarkerPresent(s, marker)).toBe(false);
  }, 30_000);

  test("the post hook's write sweep of an interpreter call (core.fsmonitor)", async () => {
    const r = repo();
    mkdirSync(join(r, '.claude'));
    const s = sid();
    const marker = approvalMarkerPath(r, 'stop', s);
    sh(r, `git config core.fsmonitor "${trap(r, 'fsmon.sh', marker)}"`);
    expect(await modelCall(r, 'python3 -c "print(1)"', s)).toBeUndefined();
    expect(existsSync(marker) && userMarkerPresent(s, marker)).toBe(false);
  }, 30_000);
});

describe('G2: reading the heredoc scripts of shells costs cubic time', () => {
  test('300 `bash <<E … E` segments (9 KB) and a push are decided, not run past the hook timeout', async () => {
    const r = repo();
    const command = Array.from({ length: 300 }, (_, i) => `bash <<'E${i}'\nbash -s git\nE${i}`).join('\n') + '\ngit push origin main';
    expect(command.length).toBeLessThan(10_000);
    const out = await pre(r, command, sid(), undefined, 15_000);
    expect(out).toEqual({ killed: false, crashed: false, decision: 'deny' });
  }, 30_000);
});

describe('G3: an oversized file the rule reads kills the hook (no output, so the call runs)', () => {
  test('a sparse 3 GB .git/MERGE_MSG with `git commit --no-edit; git push`', async () => {
    const r = repo();
    sparse(join(r, '.git', 'MERGE_MSG'), 3 * 2 ** 30);
    const out = await pre(r, 'git commit --no-edit; git push origin main', sid());
    expect(out).toEqual({ killed: false, crashed: false, decision: 'deny' });
  }, 30_000);

  test('a model call that makes the pins file 3 GB is put back, and later calls are still decided', async () => {
    const r = repo();
    const s = sid();
    await hook(START, r, { hook_event_name: 'SessionStart', source: 'startup' }, { sessionId: s });
    const pins = join(tmpdir(), `goodboy-session-${s}`, 'commit-issue-pins.json');
    expect(existsSync(pins)).toBe(true);
    const py = `python3 -c "import os,tempfile;d=os.path.join(tempfile.gettempdir(),'goodboy-'+'session-${s}');f=open(os.path.join(d,'commit-issue-'+'pins.json'),'wb');f.truncate(3*2**30);f.close()"`;
    expect(await modelCall(r, py, s)).toBeUndefined();
    expect(statSync(pins).size).toBeLessThan(1024 * 1024);
    expect(await pre(r, 'git push origin main', s)).toEqual({ killed: false, crashed: false, decision: 'deny' });
  }, 40_000);
});

describe('G4: a commit in another repo by --git-dir or GIT_DIR reads the cwd repo', () => {
  test('`--amend --no-edit` of a commit without an issue is not judged on the cwd HEAD', () => {
    const r = repo('ABC-1 init');
    repo('no issue here', join(r, 'sub'));
    expect(commitIssueDenial('cd sub && git commit --amend --no-edit', r, sid())).not.toBeNull();
    expect(commitIssueDenial('GIT_DIR=sub/.git git commit --amend --no-edit', r, sid())).not.toBeNull();
    expect(commitIssueDenial('git --git-dir=sub/.git --work-tree=sub commit --amend --no-edit', r, sid())).not.toBeNull();
  });
});

describe('G5: commits the push gate reads (its push forms are denied) and this rule does not', () => {
  test('a chain of three aliases, a heredoc shell inside a heredoc shell, eval of a heredoc', () => {
    const r = repo();
    sh(r, 'git config alias.a b && git config alias.b c && git config alias.c commit');
    expect(commitIssueDenial('git a -m fix', r, sid())).not.toBeNull();
    expect(commitIssueDenial("bash <<'A'\nbash <<'B'\ngit commit -m fix\nB\nA", r, sid())).not.toBeNull();
    expect(commitIssueDenial("eval \"$(cat <<'EOF'\ngit commit -m fix\nEOF\n)\"", r, sid())).not.toBeNull();
  });
});

describe('G6: a session started by /clear has no pins until its first git command', () => {
  test('pins planted by an interpreter before that are not taken', async () => {
    const r = repo();
    const s = sid();
    await hook(START, r, { hook_event_name: 'SessionStart', source: 'clear' }, { sessionId: s });
    const py = `python3 -c "import os,tempfile,json;d=os.path.join(tempfile.gettempdir(),'goodboy-'+'session-${s}');os.makedirs(d,exist_ok=True);open(os.path.join(d,'commit-issue-'+'pins.json'),'w').write(json.dumps({'since':99999999999999,'pins':{}}))"`;
    expect(await modelCall(r, py, s)).toBeUndefined();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    expect((await pre(r, 'git commit -m fix', s)).decision).toBe('deny');
  }, 30_000);
});

describe('G7: an old .goodboy dir moved into place', () => {
  test('a renamed dir keeps its old file times; the setting is still new', () => {
    const other = tmp();
    mkdirSync(join(other, '.goodboy'));
    writeFileSync(join(other, '.goodboy', 'commit-issue'), 'off\n');
    Bun.sleepSync(20);
    const since = Date.now();
    Bun.sleepSync(20);
    const r = repo();
    renameSync(join(other, '.goodboy'), join(r, '.goodboy'));
    expect(commitIssueRule(r, since).on).toBe(true);
  });
});

describe('G8: a commit message line read as a shell script', () => {
  test("Claude Code's heredoc commit next to a `bash <<S` script is judged by its message", () => {
    const r = repo();
    const command = `bash <<'S'\necho hi\nS\n${claudeCommit('ABC-1 subject\n\ngit commit hooks now run')}`;
    expect(commitIssueDenial(command, r, sid())).toBeNull();
  });
});
