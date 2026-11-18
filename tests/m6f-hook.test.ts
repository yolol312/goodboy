// Track M, M6f (plan §19): the commit and push scan through the spawned PreToolUse hook, the way tests/m6b-hook.test.ts
// runs the sandbox rule: the denial and its text, the digest-bound one-use marker, a subagent, every tool that carries a
// shell command, and the projects the scan leaves alone. A canary never reaches the reason or the user's message.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registerRealData, registryEntryOf } from '../lib/sandbox-registry';
import { CANARY, cleanup, commit, digestIn, type Fixture, fixture, git, leaked, put, withRemote } from './m6f-helpers';

// Real git repos and spawned processes: slower than the 5 s default on a busy machine.
setDefaultTimeout(60_000);

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');

let f: Fixture;
beforeEach(() => {
  f = fixture({ realData: true });
});
afterEach(cleanup);

interface Result {
  denied: boolean;
  reason: string;
  system: string;
  raw: string;
}

/** One session: every call is a fresh hook process with the same session id, TMPDIR and HOME. */
function session(cwdDefault?: string) {
  const sid = `m6f-${Math.random().toString(36).slice(2)}`;
  const call = async (command: string, o: { tool?: string; sub?: boolean; cwd?: string; input?: Record<string, unknown> } = {}): Promise<Result> => {
    const cwd = o.cwd ?? cwdDefault ?? f.repo;
    const payload = {
      session_id: sid,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: o.tool ?? 'Bash',
      tool_input: o.input ?? { command },
      tool_use_id: `t-${Math.random().toString(36).slice(2)}`,
      ...(o.sub ? { agent_type: 'goodboy:build-backend', agent_id: 'b1' } : {}),
    };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off', GOODBOY_COMMIT_ISSUE: 'on', ...f.env, TMPDIR: f.base },
    });
    const raw = (await new Response(proc.stdout).text()) || '{}';
    await proc.exited;
    const out = JSON.parse(raw) as Record<string, unknown>;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', system: String(out.systemMessage ?? ''), raw };
  };
  const markerPath = (): string => join(f.repo, `.claude/.goodboy-commit-scan-approved-${sid.slice(0, 8)}.txt`);
  const marker = (content: string): string => {
    mkdirSync(join(f.repo, '.claude'), { recursive: true });
    writeFileSync(markerPath(), content);
    return markerPath();
  };
  return { sid, call, markerPath, marker };
}

const COMMIT = 'git commit -m "work #1"';

describe('the denial', () => {
  test('a commit with a match is denied with the list, the digest and the way past, and no value anywhere', async () => {
    const s = session();
    put(f, 'notes.txt', `a\nb\ncontact ${CANARY.email} or ${CANARY.phone}\n`);
    git(f, ['add', 'notes.txt']);
    const r = await s.call(COMMIT);
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('(commit scan)');
    expect(r.reason).toContain('Matches (2): notes.txt:3 email, notes.txt:3 phone');
    expect(r.reason).toMatch(/`! echo [0-9a-f]{16} > \.claude\/\.goodboy-commit-scan-approved-m6f-[0-9a-z]{4}\.txt`/);
    expect(r.reason).toContain('one use, bound to exactly this content');
    expect(r.system).toContain('[goodboy]');
    expect(r.system).toContain(digestIn(r.reason));
    expect(leaked(r.raw)).toBeNull();
    // the approval dir exists so the user's command works
    expect(existsSync(join(f.repo, '.claude'))).toBe(true);
  });

  test('a clean commit, a commit with nothing staged and other git commands pass', async () => {
    const s = session();
    put(f, 'ok.txt', 'fine\n');
    git(f, ['add', 'ok.txt']);
    for (const c of [COMMIT, 'git status', 'git log -1', 'git add -A', 'echo hi']) expect([c, (await s.call(c)).denied]).toEqual([c, false]);
  });

  test('Bash, Monitor and PowerShell are read the same way; other tools are not asked', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.card}\n`);
    git(f, ['add', 'notes.txt']);
    for (const tool of ['Bash', 'Monitor', 'PowerShell']) expect([tool, (await s.call(COMMIT, { tool })).denied]).toEqual([tool, true]);
    expect((await s.call(COMMIT, { tool: 'Read' })).denied).toBe(false);
  });

  test('a push is denied for what it sends', async () => {
    const s = session();
    git(f, ['config', 'user.email', 'me@corp.io']);
    withRemote(f);
    commit(f, { 'leak.txt': `x ${CANARY.secret}\n` }, 'leak #1');
    commit(f, { 'fine.txt': 'fine\n' }, 'fine #1');
    const r = await s.call('git push origin main');
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('`git push`');
    expect(r.reason).toContain('leak.txt:1 secret');
    expect(leaked(r.raw)).toBeNull();
  });

  test('what cannot be scanned is listed as not scanned', async () => {
    const s = session();
    put(f, 'blob.dat', Buffer.from([0, 1, 2]));
    git(f, ['add', 'blob.dat']);
    const r = await s.call(COMMIT);
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('Not scanned (1): blob.dat (binary content)');
    expect(r.reason).not.toContain('Matches');
  });

  test('git add in the same command is not scanned: the denial names the command, run it first', async () => {
    const s = session();
    put(f, 'new.txt', 'x\n');
    const r = await s.call('git add -A && git commit -m "x #1"');
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('runs `git add` before the commit');
    expect((await s.call('git add -A')).denied).toBe(false);
  });
});

describe('the user\'s one-use approval, bound to the content', () => {
  test('an empty marker or a wrong digest does not pass; the digest the denial printed does, once', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const first = await s.call(COMMIT);
    const digest = digestIn(first.reason);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    s.marker('');
    expect((await s.call(COMMIT)).denied).toBe(true);
    s.marker('0123456789abcdef\n');
    expect((await s.call(COMMIT)).denied).toBe(true);
    expect(existsSync(s.markerPath())).toBe(true);
    s.marker(`${digest}\n`);
    const pass = await s.call(COMMIT);
    expect(pass.denied).toBe(false);
    // used up
    expect(existsSync(s.markerPath())).toBe(false);
    expect((await s.call(COMMIT)).denied).toBe(true);
  });

  test('a changed file is another digest: the old approval does not cover it', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const digest = digestIn((await s.call(COMMIT)).reason);
    put(f, 'notes.txt', `${CANARY.email}\nand one more line\n`);
    git(f, ['add', 'notes.txt']);
    s.marker(digest);
    const again = await s.call(COMMIT);
    expect(again.denied).toBe(true);
    expect(digestIn(again.reason)).not.toBe(digest);
    s.marker(digestIn(again.reason));
    expect((await s.call(COMMIT)).denied).toBe(false);
  });

  test('the approval does not pass a denial in the same command that has another list', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const digest = digestIn((await s.call(COMMIT)).reason);
    s.marker(digest);
    // a different commit (a message with a value) has a different digest
    const r = await s.call(`git commit -m "call ${CANARY.phone} #1"`);
    expect(r.denied).toBe(true);
    expect(digestIn(r.reason)).not.toBe(digest);
    expect(leaked(r.raw)).toBeNull();
  });

  test('a subagent is never approved, and is told to return BLOCKED, with no way past for it', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const first = await s.call(COMMIT);
    s.marker(digestIn(first.reason));
    const r = await s.call(COMMIT, { sub: true });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('return BLOCKED');
    expect(r.reason).not.toContain('echo ');
    expect(r.system).toBe('');
    expect(existsSync(s.markerPath())).toBe(true);
    expect(leaked(r.raw)).toBeNull();
  });

  test('a marker made while a model Bash call ran is not the user\'s: it is removed', async () => {
    const s = session();
    put(f, 'ok.txt', 'fine\n');
    git(f, ['add', 'ok.txt']);
    // a passing call leaves an open start note; a marker made after it is taken as the model's
    expect((await s.call('git status')).denied).toBe(false);
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const digest = digestIn((await s.call(COMMIT)).reason);
    s.marker(digest);
    expect((await s.call(COMMIT)).denied).toBe(true);
    expect(existsSync(s.markerPath())).toBe(false);
  });

  test('the model cannot write the marker, with Bash or with a file tool', async () => {
    const s = session();
    for (const tool of ['Write', 'Edit']) {
      const w = await s.call('', { tool, input: { file_path: s.markerPath(), content: '0123456789abcdef', new_string: 'x', old_string: 'y' } });
      expect([tool, w.denied, w.reason.includes('approval markers can only be created by the user')]).toEqual([tool, true, true]);
    }
    const r = await s.call(`echo 0123456789abcdef > .claude/.goodboy-commit-scan-approved-${s.sid.slice(0, 8)}.txt`);
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('approval markers can only be created by the user');
  });
});

describe('the hook\'s clock', () => {
  test('with no time left no git call runs, and a real-data commit is then not clean: it is denied', async () => {
    put(f, 'ok.txt', 'fine\n');
    git(f, ['add', 'ok.txt']);
    const payload = { session_id: 'm6f-clock', cwd: f.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: COMMIT }, tool_use_id: 't-clock' };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd: f.repo,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off', ...f.env, TMPDIR: f.base, GOODBOY_TEST_HOOK_CLOCK_MS: '0' },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    await proc.exited;
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('<repository> (git could not tell the repository of this commit)');
  });
});

describe('a check that fails', () => {
  test('passes in the main session (logged) and is denied inside a subagent', async () => {
    const run = async (sub: boolean): Promise<Result> => {
      const payload = { session_id: 'm6f-fail', cwd: f.repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: COMMIT }, tool_use_id: 't-fail', ...(sub ? { agent_type: 'goodboy:build-backend', agent_id: 'b1' } : {}) };
      const proc = Bun.spawn(['bun', HOOK], {
        cwd: f.repo,
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off', ...f.env, TMPDIR: f.base, GOODBOY_TEST_COMMIT_SCAN_FAIL: '1' },
      });
      const raw = (await new Response(proc.stdout).text()) || '{}';
      await proc.exited;
      const h = (JSON.parse(raw) as { hookSpecificOutput?: Record<string, string> }).hookSpecificOutput ?? {};
      return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', system: '', raw };
    };
    expect((await run(false)).denied).toBe(false);
    const sub = await run(true);
    expect(sub.denied).toBe(true);
    expect(sub.reason).toContain('The commit scan could not check this command, so it is denied inside a subagent');
  });
});

describe('where the scan applies', () => {
  test('a project that holds no real data is left alone', async () => {
    const g = fixture();
    put(g, 'notes.txt', `${CANARY.email}\n`);
    git(g, ['add', 'notes.txt']);
    const s = session();
    expect((await s.call(COMMIT, { cwd: g.repo })).denied).toBe(false);
  });

  test('a project of the registry is scanned from a shell elsewhere with git -C, and from a subdirectory', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const elsewhere = fixture();
    registerRealData(registryEntryOf(f.repo, { dump: null, dumpFormat: null, realData: true }), f.env);
    const r = await s.call(`git -C ${f.repo} commit -m "x #1"`, { cwd: elsewhere.repo });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('notes.txt:1 email');
    mkdirSync(join(f.repo, 'sub'));
    expect((await s.call(COMMIT, { cwd: join(f.repo, 'sub') })).denied).toBe(true);
  });

  test('the commit issue rule still comes first for a message with no issue number', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const r = await s.call('git commit -m "no issue"');
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('no issue number');
  });

  test('the user\'s marker file is a plain file: a link to one is no approval', async () => {
    const s = session();
    put(f, 'notes.txt', `${CANARY.email}\n`);
    git(f, ['add', 'notes.txt']);
    const digest = digestIn((await s.call(COMMIT)).reason);
    writeFileSync(join(f.base, 'real.txt'), digest);
    mkdirSync(join(f.repo, '.claude'), { recursive: true });
    Bun.spawnSync(['ln', '-s', join(f.base, 'real.txt'), s.markerPath()]);
    expect((await s.call(COMMIT)).denied).toBe(true);
    expect(readFileSync(join(f.base, 'real.txt'), 'utf8')).toBe(digest);
  });
});
