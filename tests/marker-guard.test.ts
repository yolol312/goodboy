import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bashMarkerWrite, isApprovalMarkerPath } from '../lib/approval-marker';

// Track G: approval markers are the user's alone (no model-side escape). PreToolUse denies a
// model's write to a marker; PostToolUse removes a marker that a Bash call created anyway.

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-mg-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  const sid = `mg-${Math.random().toString(36).slice(2)}`;
  const tag = sid.slice(0, 8);
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
    return { raw: out, denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '', system: String(out.systemMessage ?? '') };
  };
  return { cwd, sid, tag, run, marker: (kind: string) => join(cwd, '.claude', `.goodboy-${kind}-approved-${tag}.txt`) };
}

describe('marker names and Bash writes', () => {
  test('isApprovalMarkerPath covers every kind and nothing else', () => {
    for (const k of ['risk', 'bash-write', 'outward', 'stop', 'push-test']) {
      expect(isApprovalMarkerPath(`/r/.claude/.goodboy-${k}-approved-abcd1234.txt`)).toBe(true);
    }
    expect(isApprovalMarkerPath('/r/.claude/.goodboy-last-review.json')).toBe(false);
    expect(isApprovalMarkerPath('/r/notes/goodboy-risk-approved.md')).toBe(false);
  });

  test('bashMarkerWrite: creating or redirecting is a write; reading or removing is not', () => {
    const m = '.claude/.goodboy-stop-approved-abcd1234.txt';
    for (const c of [`touch ${m}`, `echo y > ${m}`, `: >> ${m}`, `cp /dev/null ${m}`, `cat x > ${m}`, `ls && touch ${m}`, `python3 -c "open('${m}','w')"`]) {
      expect([c, bashMarkerWrite(c)]).toEqual([c, m.startsWith('.') ? expect.stringContaining('.goodboy-stop-approved-') : null]);
    }
    for (const c of [`ls ${m}`, `cat ${m}`, `rm -f ${m}`, `test -e ${m} && echo yes`, 'touch notes.txt', 'git status']) {
      expect([c, bashMarkerWrite(c)]).toEqual([c, null]);
    }
  });
});

describe('PreToolUse', () => {
  test('the model may not create a marker with Write, Edit or Bash, in the main session or a subagent', async () => {
    const s = sandbox();
    const w = await s.run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: s.marker('stop'), content: '' } });
    expect(w.denied).toBe(true);
    expect(w.reason).toContain('only be created by the user');
    const b = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: `touch ${s.marker('push-test')}` } });
    expect(b.denied).toBe(true);
    const sub = await s.run('pre-tool-use', {
      tool_name: 'Bash',
      tool_input: { command: `touch ${s.marker('risk')}` },
      agent_type: 'general-purpose',
      agent_id: 'g1',
    });
    expect(sub.denied).toBe(true);
    expect(existsSync(s.marker('stop')) || existsSync(s.marker('push-test')) || existsSync(s.marker('risk'))).toBe(false);
  });

  test('withdrawing a marker is allowed; GOODBOY_MARKER_GUARD=off disables the rule', async () => {
    const s = sandbox();
    expect((await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: `rm -f ${s.marker('stop')}` } })).denied).toBe(false);
    const off = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: `touch ${s.marker('stop')}` } }, { GOODBOY_MARKER_GUARD: 'off' });
    expect(off.reason).not.toContain('only be created by the user');
  });
});

describe('a marker made during a model Bash call that never reported back (`exit N`, G0 M18)', () => {
  test('is refused by the Stop gate and by a push, and removed', async () => {
    const s = sandbox();
    // The model's call started (PreToolUse noted it) and no post hook ever came.
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_exit', tool_input: { command: 'k=stop; touch .claude/.goodboy-$k-approved-x.txt; exit 1' } });
    writeFileSync(s.marker('stop'), '');
    writeFileSync(join(s.cwd, 'a.ts'), 'x');
    const dir = join(s.cwd, '..', `goodboy-session-${s.sid}`);
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: join(s.cwd, 'a.ts'), turn: 0, timestamp: new Date().toISOString() }) + '\n');
    const stop = await s.run('stop', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(stop.raw.decision).toBe('block');
    expect(existsSync(s.marker('stop'))).toBe(false);
  });

  test("a call the hook denied leaves no open note: the user's `! touch` after the denial works", async () => {
    const s = sandbox();
    // A denied Bash call (a project write) fires no post hook.
    const denied = await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_denied', tool_input: { command: 'echo x > src.ts' } });
    expect(denied.denied).toBe(true);
    writeFileSync(s.marker('bash-write'), ''); // the user approves
    const retry = await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_retry', tool_input: { command: 'echo x > src.ts' } });
    expect(retry.denied).toBe(false);
  });

  test("the user's marker from before the call still works", async () => {
    const s = sandbox();
    writeFileSync(s.marker('stop'), ''); // the user's, made first
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_exit2', tool_input: { command: 'sleep 1; exit 1' } });
    writeFileSync(join(s.cwd, 'a.ts'), 'x');
    const dir = join(s.cwd, '..', `goodboy-session-${s.sid}`);
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: join(s.cwd, 'a.ts'), turn: 0, timestamp: new Date().toISOString() }) + '\n');
    const stop = await s.run('stop', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(stop.raw.decision).toBeUndefined();
  });
});

describe('a marker made in another directory during a finished call (security review round 2)', () => {
  test('is refused by its ctime inside the call window, even after the post hook', async () => {
    const s = sandbox();
    const tuid = 'toolu_other_dir';
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'n=st; touch "pkg/.claude/.goodboy-${n}op-approved-x.txt"' } });
    const pkg = join(s.cwd, 'pkg');
    mkdirSync(join(pkg, '.claude'), { recursive: true });
    const m = join(pkg, '.claude', `.goodboy-stop-approved-${s.tag}.txt`);
    writeFileSync(m, ''); // what the command did, outside the call's cwd
    await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'x' }, tool_response: {} });
    expect(existsSync(m)).toBe(true); // not in the swept directories
    // The Stop runs in pkg/ (the shell moved): the marker is refused and removed.
    const dir = join(s.cwd, '..', `goodboy-session-${s.sid}`);
    writeFileSync(join(pkg, 'a.ts'), 'x');
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: join(pkg, 'a.ts'), turn: 0, timestamp: new Date().toISOString() }) + '\n');
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
      cwd: pkg,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: s.sid, cwd: pkg, hook_event_name: 'Stop' })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: join(s.cwd, '..'), GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { decision?: string };
    await proc.exited;
    expect(out.decision).toBe('block');
    expect(existsSync(m)).toBe(false);
  });
});

describe('round 3', () => {
  test('a symlink is no approval marker (it would lend another file its ctime)', async () => {
    const s = sandbox();
    const old = join(s.cwd, 'old.txt');
    writeFileSync(old, '');
    require('node:fs').symlinkSync(old, s.marker('stop'));
    const dir = join(s.cwd, '..', `goodboy-session-${s.sid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(s.cwd, 'a.ts'), 'x');
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: join(s.cwd, 'a.ts'), turn: 0, timestamp: new Date().toISOString() }) + '\n');
    const stop = await s.run('stop', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(stop.raw.decision).toBe('block');
  });
});

describe('PostToolUse sweep', () => {
  test('a marker made during the call (an obfuscated name) is removed; an older one the user made stays', async () => {
    const s = sandbox();
    // The user's own marker, made a minute before the call.
    writeFileSync(s.marker('risk'), '');
    const before = Date.now() / 1000 - 60;
    utimesSync(s.marker('risk'), before, before);
    const tuid = 'toolu_sweep1';
    const cmd = 'k=stop; touch .claude/.goodboy-$k-approved-x.txt';
    expect((await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: cmd } })).denied).toBe(false);
    writeFileSync(join(s.cwd, '.claude', `.goodboy-stop-approved-${s.tag}.txt`), ''); // what the command did
    const post = await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: cmd }, tool_response: { stdout: '' } });
    expect(existsSync(s.marker('stop'))).toBe(false);
    expect(existsSync(s.marker('risk'))).toBe(true);
    expect(post.context).toContain('removed approval markers');
    expect(post.system).toContain('승인 마커를 지웠어요');
  });

  test('found by name, not mtime: an old mtime (`touch -t`) does not hide a new marker', async () => {
    const s = sandbox();
    const tuid = 'toolu_sweep3';
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'k=stop; touch -t 202001010000 .claude/.goodboy-$k-approved-x.txt' } });
    writeFileSync(s.marker('stop'), '');
    const old = Date.now() / 1000 - 86400 * 365;
    utimesSync(s.marker('stop'), old, old);
    await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'x' }, tool_response: {} });
    expect(existsSync(s.marker('stop'))).toBe(false);
  });

  test('a failing command (PostToolUseFailure, G0 M18) is swept too', async () => {
    const s = sandbox();
    const tuid = 'toolu_sweep4';
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'k=stop; touch .claude/.goodboy-$k-approved-x.txt; false' } });
    writeFileSync(s.marker('stop'), '');
    const out = await s.run('post-tool-use-failure', { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'x' }, error: 'Exit code 1' });
    expect(existsSync(s.marker('stop'))).toBe(false);
    expect(out.system).toContain('승인 마커를 지웠어요');
  });

  test('another letter case is the same marker on a case-insensitive volume, and is caught', async () => {
    const s = sandbox();
    const upper = join(s.cwd, '.claude', `.Goodboy-Stop-Approved-${s.tag}.txt`);
    const w = await s.run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: upper, content: '' } });
    expect(w.denied).toBe(true);
    const b = await s.run('pre-tool-use', { tool_name: 'Bash', tool_input: { command: `touch .claude/.GOODBOY-PUSH-TEST-APPROVED-${s.tag}.txt` } });
    expect(b.denied).toBe(true);
  });

  test('a call that created no marker reports nothing', async () => {
    const s = sandbox();
    const tuid = 'toolu_sweep2';
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'ls' } });
    const post = await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'ls' }, tool_response: { stdout: '' } });
    expect(post.context).not.toContain('removed approval markers');
  });
});
