// Commit issue rule (lib/commit-issue.ts): every `git commit` names an issue in its message.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { commitIssueDenial, hasIssueRef, pinCommitIssueSettings } from '../lib/commit-issue';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
}

/** A repo whose last commit message is `head`. */
function repo(head = 'ABC-1 init'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-ci-')));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', head);
  return dir;
}

const sid = () => `ci-${Math.random().toString(36).slice(2)}`;

describe('hasIssueRef', () => {
  test('Jira keys and #numbers count; standards and entities do not', () => {
    for (const t of ['ABC-123 fix', 'fix: PROJ_X-9 login', 'fix #12', 'Refs: owner/repo#3', '(#45)']) expect([t, hasIssueRef(t)]).toEqual([t, true]);
    for (const t of ['fix bug', 'use UTF-8', 'SHA-256 sums', 'abc-123', '&#123; entity', 'v1.2-3', 'ABC-', 'issue#x']) expect([t, hasIssueRef(t)]).toEqual([t, false]);
  });

  test("a project's pattern replaces the default", () => {
    expect(hasIssueRef('ABC-1 fix', /\bPROJ-\d+\b/)).toBe(false);
    expect(hasIssueRef('PROJ-1 fix', /\bPROJ-\d+\b/)).toBe(true);
  });
});

describe('commitIssueDenial', () => {
  test('messages from -m, clusters, several -m and a heredoc', () => {
    const r = repo();
    expect(commitIssueDenial('git commit -m "fix bug"', r, sid())).toContain('no issue number');
    for (const c of ['git commit -m "ABC-12 fix bug"', 'git commit -am "fix #4"', 'git commit -m fix -m "Refs: ABC-9"', 'git commit --message="ABC-3 x"', 'git commit -mABC-5']) {
      expect([c, commitIssueDenial(c, r, sid())]).toEqual([c, null]);
    }
    const heredoc = (subject: string) => `git commit -m "$(cat <<'EOF'\n${subject}\n\nBody.\n\nCo-Authored-By: x <x@example.com>\nEOF\n)"`;
    expect(commitIssueDenial(heredoc('ABC-7 subject'), r, sid())).toBeNull();
    expect(commitIssueDenial(heredoc('subject only'), r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git commit -F - <<EOF\nABC-1 x\nEOF', r, sid())).toBeNull();
  });

  test('a message file, an editor commit, and messages reused from a commit', () => {
    const r = repo('ABC-1 init');
    writeFileSync(join(r, 'ok.txt'), 'ABC-2 from a file\n');
    writeFileSync(join(r, 'bad.txt'), 'from a file\n');
    expect(commitIssueDenial('git commit -F ok.txt', r, sid())).toBeNull();
    expect(commitIssueDenial('git commit -F bad.txt', r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git commit', r, sid())).toContain('would open an editor');
    expect(commitIssueDenial('git commit --amend --no-edit', r, sid())).toBeNull();
    expect(commitIssueDenial('git commit --fixup=HEAD', r, sid())).toBeNull();
    expect(commitIssueDenial('git commit --fixup=amend:HEAD', r, sid())).toBeNull();
    const plain = repo('init');
    expect(commitIssueDenial('git commit --amend --no-edit', plain, sid())).toContain('no issue number');
    expect(commitIssueDenial('git commit -C HEAD', plain, sid())).toContain('no issue number');
  });

  test('aliases, nested shells and other git commands', () => {
    const r = repo();
    git(r, 'config', 'alias.ci', 'commit -v');
    expect(commitIssueDenial('git ci -m "fix"', r, sid())).toContain('no issue number');
    expect(commitIssueDenial(`sh -c 'git commit -m "fix"'`, r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git add -A && git commit -m "ABC-1 x" && git push origin main', r, sid())).toBeNull();
    for (const c of ['git status', 'git log --grep commit', 'echo git commit', 'ls']) expect([c, commitIssueDenial(c, r, sid())]).toEqual([c, null]);
  });

  test('.goodboy/commit-issue sets a pattern or off, read as it was when the session started', () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), '# this project uses PROJ keys\n\\bPROJ-\\d+\\b\n');
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, sid())).toContain('PROJ');
    expect(commitIssueDenial('git commit -m "PROJ-1 x"', r, sid())).toBeNull();
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    expect(commitIssueDenial('git commit -m "x"', r, sid())).toBeNull();
    // A setting written during the session waits for the next session.
    const s = sid();
    writeFileSync(join(r, '.goodboy', 'commit-issue'), '\\bPROJ-\\d+\\b\n');
    expect(commitIssueDenial('git commit -m "PROJ-1 x"', r, s)).toBeNull();
    Bun.sleepSync(20);
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    expect(commitIssueDenial('git commit -m "x"', r, s)).toContain('no issue number');
  });

  // Layer-1 gaps (last G1 round): these held, but no test pinned them (mutants survived).
  test('a setting written during the session and backdated (touch -t) is still new: its ctime counts', () => {
    const r = repo();
    const s = sid();
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, s)).toBeNull();
    Bun.sleepSync(20);
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(r, '.goodboy', 'commit-issue'), old, old);
    expect(commitIssueDenial('git commit -m "fix"', r, s)).toContain('no issue number');
  });

  test('a message piped into -F - is read from the command; `--` ends the options', () => {
    const r = repo();
    expect(commitIssueDenial("printf 'ABC-3 fix\\n' | git commit -F -", r, sid())).toBeNull();
    expect(commitIssueDenial("printf 'fix\\n' | git commit -F -", r, sid())).toContain('no issue number');
    // After `--` every word is a path, even one shaped like `-m<message>`.
    expect(commitIssueDenial('git commit -m fix -- -mABC-1.txt', r, sid())).toContain('no issue number');
  });
});

describe('last review: normal commits read right, settings pinned at the session start', () => {
  test('keys next to text, license and standard tokens', () => {
    expect(hasIssueRef('ABC-12-login page')).toBe(true);
    for (const t of ['GPL-3 license', 'PHP-8 support', 'LGPL-2 x']) expect([t, hasIssueRef(t)]).toEqual([t, false]);
  });

  test('-S keys, trailers, /dev/stdin and a merge in progress', () => {
    const r = repo();
    expect(commitIssueDenial('git commit -SDEADBEEF -m "ABC-1 x"', r, sid())).toBeNull();
    expect(commitIssueDenial('git commit -m fix --trailer "Refs: ABC-1"', r, sid())).toBeNull();
    expect(commitIssueDenial('git commit -F /dev/stdin <<EOF\nABC-2 x\nEOF', r, sid())).toBeNull();
    // A conflicted merge: `--no-edit` commits MERGE_MSG, which names no issue.
    git(r, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(r, 'a.txt'), 'side\n');
    git(r, 'commit', '-qam', 'ABC-3 side');
    git(r, 'checkout', '-q', 'main');
    writeFileSync(join(r, 'a.txt'), 'main\n');
    git(r, 'commit', '-qam', 'ABC-4 main');
    expect(Bun.spawnSync(['git', 'merge', 'side'], { cwd: r, stdout: 'pipe', stderr: 'pipe' }).exitCode).not.toBe(0);
    expect(commitIssueDenial('git commit --no-edit', r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git commit --no-edit -m "ABC-5 merge side"', r, sid())).toBeNull();
  });

  test('SessionStart pins the settings: a later change or removal waits for the next session', () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), '\\bPROJ-\\d+\\b\n');
    const s = sid();
    pinCommitIssueSettings(s, r);
    writeFileSync(join(r, '.goodboy', 'commit-issue'), 'off\n');
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, s)).toContain('PROJ');
    rmSync(join(r, '.goodboy', 'commit-issue'));
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, s)).toContain('PROJ');
    // A resumed session pins again: the user's change applies.
    pinCommitIssueSettings(s, r);
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, s)).toBeNull();
  });

  test('the SessionStart hook pins, and a Bash rewrite of the pins is put back', async () => {
    const r = repo();
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'commit-issue'), '\\bPROJ-\\d+\\b\n');
    const s = sid();
    const start = Bun.spawn(['bun', resolve(import.meta.dir, '..', 'hooks', 'session-start.ts')], {
      cwd: r,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, source: 'startup', cwd: r, hook_event_name: 'SessionStart' })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await start.exited;
    rmSync(join(r, '.goodboy', 'commit-issue'));
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, s)).toContain('PROJ');
    const pins = join(tmpdir(), `goodboy-session-${s}`, 'commit-issue-pins.json');
    snapshotGateState(s, 'tu-1');
    writeFileSync(pins, JSON.stringify({ since: 9e15, pins: {} }));
    restoreGateState(s, 'tu-1');
    expect(commitIssueDenial('git commit -m "ABC-1 x"', r, s)).toContain('PROJ');
    rmSync(join(tmpdir(), `goodboy-session-${s}`), { recursive: true, force: true });
  }, 20_000);

  test('a reused commit named like an option is refused by name; the same reuse is read once', () => {
    const r = repo();
    expect(commitIssueDenial('git commit -C --output=x.txt', r, sid())).toContain('looks like an option');
    // Twenty amends of the same HEAD read its message once (the 8-call cap would deny them otherwise).
    expect(commitIssueDenial(Array.from({ length: 20 }, () => 'git commit --amend --no-edit').join(' && '), r, sid())).toBeNull();
  });

  test('`--fixup` takes only the subject of the commit it fixes', () => {
    const r = repo('subject only\n\nRefs: ABC-1');
    expect(commitIssueDenial('git commit --fixup=HEAD', r, sid())).toContain('no issue number');
    expect(commitIssueDenial('git commit -C HEAD', r, sid())).toBeNull();
  });
});

describe('through the PreToolUse hook', () => {
  async function run(cwd: string, command: string, env: Record<string, string>, agent?: string) {
    const payload = {
      session_id: sid(),
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      ...(agent ? { agent_type: agent, agent_id: 'a1' } : {}),
    };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off', ...env },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string }; systemMessage?: string };
    await proc.exited;
    return out;
  }

  test('denies a commit without an issue, in the main session and in agents; off lets it run', async () => {
    const r = repo();
    const on = { GOODBOY_COMMIT_ISSUE: 'on' };
    const denied = await run(r, 'git commit -am "fix bug"', on);
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(denied.systemMessage).toContain('이슈 번호');
    expect((await run(r, 'git commit -am "fix bug"', on, 'goodboy:build-backend')).hookSpecificOutput?.permissionDecision).toBe('deny');
    expect((await run(r, 'git commit -am "ABC-1 fix bug"', on)).hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect((await run(r, 'git commit -am "fix bug"', { GOODBOY_COMMIT_ISSUE: 'off' })).hookSpecificOutput?.permissionDecision).toBeUndefined();
  }, 30_000);
});
