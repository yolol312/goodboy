import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writesGateState } from '../lib/state-guard';

// Track G security review: the Stop gates' state in the session dir is guarded around every
// model Bash call (lib/state-guard.ts).

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-sg-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(cwd);
  const sid = `sg-${Math.random().toString(36).slice(2)}`;
  const dir = join(base, `goodboy-session-${sid}`);
  mkdirSync(dir, { recursive: true });
  const edits = join(dir, 'edits.jsonl');
  const line = JSON.stringify({ file: join(cwd, 'a.ts'), turn: 0, timestamp: new Date().toISOString() });
  writeFileSync(edits, `${line}\n`);
  writeFileSync(join(cwd, 'a.ts'), 'x');
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
    return { raw: out, denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '' };
  };
  return { cwd, dir, edits, line, run };
}

describe('writesGateState', () => {
  test('changes to a session dir are caught; reads and other paths pass', () => {
    for (const c of [
      'rm -f "$TMPDIR"/goodboy-session-*/edits.jsonl',
      ': > /tmp/goodboy-session-x/edits.jsonl',
      'mv /tmp/goodboy-session-x/edits.jsonl /tmp/e',
      'find /tmp -name "goodboy-*" -delete',
      'python3 -c "import os; os.remove(\'/tmp/goodboy-session-x/edits.jsonl\')"',
    ]) {
      expect([c, writesGateState(c)]).toEqual([c, true]);
    }
    for (const c of ['cat /tmp/goodboy-session-x/gate-log.jsonl', 'ls $TMPDIR/goodboy-session-*', 'tail -3 /tmp/goodboy-session-x/edits.jsonl | jq .', 'rm -f notes.txt']) {
      expect([c, writesGateState(c)]).toEqual([c, false]);
    }
  });
});

describe('through the hooks', () => {
  test('a named session-dir change is denied up front', async () => {
    const s = sandbox();
    const out = await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s0', tool_input: { command: `rm -f ${s.edits}` } });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain("goodboy's own session state");
  });

  test('an edit log the call removed or rewrote is put back after it', async () => {
    const s = sandbox();
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s1', tool_input: { command: 'sh ./wipe.sh' } });
    writeFileSync(s.edits, ''); // what the (obfuscated) command did
    const post = await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s1', tool_input: { command: 'sh ./wipe.sh' }, tool_response: {} });
    expect(readFileSync(s.edits, 'utf8')).toContain(s.line);
    expect(post.context).toContain('put back its gate state');
  });

  test('a review cursor the call created is removed', async () => {
    const s = sandbox();
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s2', tool_input: { command: 'sh ./x.sh' } });
    const forged = join(s.dir, '.goodboy-last-review-0123456789ab.json');
    writeFileSync(forged, JSON.stringify({ turn: 99, timestamp: new Date().toISOString(), sessionId: 'x' }));
    await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s2', tool_input: { command: 'sh ./x.sh' }, tool_response: {} });
    expect(existsSync(forged)).toBe(false);
  });

  test('a call that never reported back (`exit N`) is restored at the next Stop, which still blocks', async () => {
    const s = sandbox();
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s3', tool_input: { command: 'sh ./wipe.sh; exit 1' } });
    rmSync(s.edits);
    const stop = await s.run('stop', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(readFileSync(s.edits, 'utf8')).toContain(s.line);
    expect(stop.raw.decision).toBe('block'); // the unreviewed edit still needs a review
    expect(String(stop.raw.systemMessage)).toContain('게이트 상태를 되돌렸어요');
  });

  // (#21 round-2 review) The worktree pin is SessionStart's: a line a call adds is taken back,
  //   and a pin a call creates is removed, so a worktree made mid-session never becomes its own
  //   project.
  test('the worktree pin is put back after a call, and one a call creates is removed', async () => {
    const s = sandbox();
    const pin = join(s.dir, 'worktrees.txt');
    writeFileSync(pin, `${s.cwd}\n`);
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s5', tool_input: { command: 'sh ./x.sh' } });
    writeFileSync(pin, `${s.cwd}\n${join(s.cwd, 'docs', '.v2')}\n`);
    await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s5', tool_input: { command: 'sh ./x.sh' }, tool_response: {} });
    expect(readFileSync(pin, 'utf8')).toBe(`${s.cwd}\n`);
    rmSync(pin);
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s6', tool_input: { command: 'sh ./y.sh' } });
    writeFileSync(pin, `${join(s.cwd, 'docs', '.v2')}\n`);
    await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s6', tool_input: { command: 'sh ./y.sh' }, tool_response: {} });
    expect(existsSync(pin)).toBe(false);
  });

  test('lines appended during the call by other hooks are kept', async () => {
    const s = sandbox();
    await s.run('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s4', tool_input: { command: 'ls' } });
    const extra = JSON.stringify({ file: join(s.cwd, 'b.ts'), turn: 0, timestamp: new Date().toISOString() });
    writeFileSync(s.edits, `${s.line}\n${extra}\n`);
    const post = await s.run('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_s4', tool_input: { command: 'ls' }, tool_response: {} });
    expect(readFileSync(s.edits, 'utf8')).toBe(`${s.line}\n${extra}\n`);
    expect(post.context).not.toContain('put back its gate state');
  });
});
