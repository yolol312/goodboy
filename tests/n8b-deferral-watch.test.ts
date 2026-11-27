// N8b follow-up (plan §20.12 items 2 and 5, v0.38.3): the policy watch. A deferral glob a tool added to the policy file
// must not count in the same session, whatever wrote the file: the edit log names only the paths the file tools and the
// swept Bash writes used, so a write through a link to the file, or one by a script the shell ran, left no trace and the
// glob counted at once (review 2026-11-26T06-56-34, high, lib/deferral.ts:47).
//   AC-10a  notePolicySeen / watchPolicy / policyWrittenThisSession / deferGlobs, in process, on real files;
//   AC-10b  the hooks that run them, spawned: SessionStart, UserPromptSubmit, PostToolUse, PostToolUseFailure (the
//           hook files are named in `HOOKS` below, so that their runs count as evidence of the wiring);
//   AC-10c  the state guard puts the watch's record back after a model call and, when it cannot believe its copy,
//           leaves it saying `written`;
// The Stop's own watch and the PreToolUse link guard are spawned in tests/n8b-deferral-stop.test.ts and
// tests/n8b-deferral-push.test.ts.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pinCoverageStart, pinnedUserGlobs } from '../lib/changed-coverage';
import { deferGlobs, notePolicySeen, POLICY_SEEN_FILE, policyWrittenThisSession, pushDeferGlobs, watchPolicy } from '../lib/deferral';
import { recordEdit } from '../lib/file-tracker';
import { restoreGateState, restoreOrphanGateState, snapshotGateState, untrustedPolicySeen } from '../lib/state-guard';

setDefaultTimeout(90_000);
const ROOT = resolve(import.meta.dir, '..');
/** The hook files whose wiring these tests spawn. */
const HOOKS = {
  sessionStart: join(ROOT, 'hooks', 'session-start.ts'),
  userPrompt: join(ROOT, 'hooks', 'user-prompt-submit.ts'),
  postTool: join(ROOT, 'hooks', 'post-tool-use.ts'),
  postToolFailure: join(ROOT, 'hooks', 'post-tool-use-failure.ts'),
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-n8bw-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
let counter = 0;
function sessionId(): string {
  const s = `n8bw${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(sessionDirOf(s));
  return s;
}
const sessionDirOf = (s: string): string => join(tmpdir(), `goodboy-session-${s}`);
const seenFile = (s: string): string => join(sessionDirOf(s), POLICY_SEEN_FILE);
const rawSeen = (s: string): { hash: string; written?: boolean; globs?: Record<string, string[]> } => JSON.parse(readFileSync(seenFile(s), 'utf8')) as { hash: string; written?: boolean; globs?: Record<string, string[]> };
/** The record's hash and `written` flag (its globs are asserted apart). */
const seenOf = (s: string): { hash: string; written?: boolean } => {
  const { hash, written } = rawSeen(s);
  return { hash, ...(written === true ? { written } : {}) };
};
const sha1 = (t: string): string => createHash('sha1').update(t).digest('hex');
const policy = (globs: Record<string, string>): string =>
  ['## P1 Deferrals', '- decide: human', '- source: user 2026-11-26', ...Object.entries(globs).map(([k, v]) => `- ${k}: ${v}`), ''].join('\n');
const UNTRUSTED_WITH_GLOB = '{"hash":"untrusted","written":true,"globs":{"defer-test":["src/a.ts"]}}';
const POLICY_OLD = policy({ 'defer-test': 'src/a.ts' });
const POLICY_NEW = policy({ 'defer-test': 'src/a.ts, src/new.ts' });

/** A repo with a committed policy (one `defer-test` glob), the session started in it: pinned, and the file noted as the
 *  user's (what SessionStart does). */
function started(): { d: string; s: string; policy: string } {
  const d = tmp();
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  write(d, 'src/a.ts', 'export const a = 1;\n');
  const file = write(d, '.goodboy/policy.md', POLICY_OLD);
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  const s = sessionId();
  pinCoverageStart(s, d);
  notePolicySeen(s, d);
  return { d, s, policy: file };
}

// ── AC-10a ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-10a: the policy watch', () => {
  test('notePolicySeen takes the file as it is; nothing changed since, so nothing was written', () => {
    const w = started();
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_OLD) });
    expect(watchPolicy(w.s, w.d)).toBe(false);
    expect(policyWrittenThisSession(w.s)).toBe(false);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: [] });
  });

  test('a write through a link to the policy file leaves the edit log blind; the watch sees the change', () => {
    const w = started();
    symlinkSync(w.policy, join(w.d, 'notes.md'));
    // The model's Edit/Write of notes.md: the edit log names notes.md, no policy file.
    writeFileSync(join(w.d, 'notes.md'), POLICY_NEW);
    recordEdit(w.s, join(w.d, 'notes.md'), 0, undefined, Date.now());
    expect(readFileSync(w.policy, 'utf8')).toBe(POLICY_NEW);
    // Before the post hook ran, only the log was asked (the case this fix closes): the watch is the one that knows.
    expect(watchPolicy(w.s, w.d)).toBe(true);
    expect(policyWrittenThisSession(w.s)).toBe(true);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: ['src/new.ts'] });
  });

  test('a script the shell ran (no edit log line) is seen the same way, and `written` stays set', () => {
    const w = started();
    writeFileSync(w.policy, POLICY_NEW); // what `bash script.sh` did, outside any logged path
    expect(watchPolicy(w.s, w.d)).toBe(true);
    // A second watch with the file unchanged since: still written, never reset by looking again.
    expect(watchPolicy(w.s, w.d)).toBe(true);
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_NEW), written: true });
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: ['src/new.ts'] });
    // The user's next message takes the file as theirs, but what a tool wrote this session stays a tool's.
    notePolicySeen(w.s, w.d);
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_NEW), written: true });
    expect(policyWrittenThisSession(w.s)).toBe(true);
  });

  test('the user\'s own change between turns is the user\'s: their next message takes it, and the glob counts', () => {
    const w = started();
    writeFileSync(w.policy, POLICY_NEW); // typed by the user while the model was idle
    notePolicySeen(w.s, w.d); // UserPromptSubmit
    expect(watchPolicy(w.s, w.d)).toBe(false);
    expect(policyWrittenThisSession(w.s)).toBe(false);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts', 'src/new.ts'], waiting: [] });
  });

  test('the file removed, or no longer a plain file, is a change too (none and unreadable hashes)', () => {
    const w = started();
    rmSync(w.policy);
    expect(watchPolicy(w.s, w.d)).toBe(true);
    expect(seenOf(w.s)).toEqual({ hash: 'none', written: true });
    const v = started();
    rmSync(v.policy);
    mkdirSync(v.policy); // a directory where the file was
    expect(watchPolicy(v.s, v.d)).toBe(true);
    expect(seenOf(v.s)).toEqual({ hash: 'unreadable', written: true });
    // A project with no policy file at all, noted at the start: `none` is unchanged.
    const d = tmp();
    const s = sessionId();
    notePolicySeen(s, d);
    expect(seenOf(s)).toEqual({ hash: 'none' });
    expect(watchPolicy(s, d)).toBe(false);
  });

  test('no record to compare with counts as written, for the Stop that finds none and for the log reader', () => {
    const w = started();
    rmSync(seenFile(w.s));
    expect(policyWrittenThisSession(w.s)).toBe(true);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: [] }); // nothing new yet: same globs
    writeFileSync(w.policy, POLICY_NEW);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: ['src/new.ts'] });
    // The watch makes the record, saying written (it could not tell the file apart from the start).
    expect(watchPolicy(w.s, w.d)).toBe(true);
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_NEW), written: true });
  });

  test('a record that cannot be read counts as written and stays so through the user\'s message', () => {
    for (const junk of ['not json', 'null', '{"hash":5}', '[]']) {
      const w = started();
      writeFileSync(seenFile(w.s), junk);
      expect([junk, policyWrittenThisSession(w.s)]).toEqual([junk, true]);
      notePolicySeen(w.s, w.d);
      expect([junk, seenOf(w.s)]).toEqual([junk, { hash: sha1(POLICY_OLD), written: true }]);
    }
  });

  test('a link in place of the record is never written through; it is replaced by a plain file saying written', () => {
    const w = started();
    const victim = join(tmp(), 'victim.txt');
    writeFileSync(victim, 'keep me');
    rmSync(seenFile(w.s));
    symlinkSync(victim, seenFile(w.s));
    expect(watchPolicy(w.s, w.d)).toBe(true); // a link is "refused": counts as written
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(lstatSync(seenFile(w.s)).isSymbolicLink()).toBe(false);
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_OLD), written: true });
    // The same for the user's message.
    rmSync(seenFile(w.s));
    symlinkSync(victim, seenFile(w.s));
    notePolicySeen(w.s, w.d);
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_OLD), written: true });
  });

  test('it never throws: a session dir that is no dir makes the watch count as written, the note do nothing', () => {
    const d = tmp();
    const s = `n8bw-nodir${Math.random().toString(36).slice(2, 8)}`;
    const dir = sessionDirOf(s);
    writeFileSync(dir, 'a file where the session dir would be');
    dirs.push(dir);
    expect(() => notePolicySeen(s, d)).not.toThrow();
    expect(watchPolicy(s, d)).toBe(true);
    expect(policyWrittenThisSession(s)).toBe(true);
  });

  test('policyWrittenThisSession: an edit log that names the policy file is a write, also with the record clean', () => {
    const w = started();
    expect(policyWrittenThisSession(w.s)).toBe(false);
    recordEdit(w.s, w.policy, 0, undefined, Date.now());
    expect(policyWrittenThisSession(w.s)).toBe(true);
    // The seams: a log that cannot be read is a write; a watch that says so is one.
    const clean = started();
    expect(policyWrittenThisSession(clean.s, () => ({ files: [] }) as never, () => true)).toBe(true);
    expect(policyWrittenThisSession(clean.s, () => ({ files: [] }) as never, () => false)).toBe(false);
  });
});

describe('AC-10a2: a push owes the globs the user had, whatever a tool did to the line', () => {
  const POLICY_NONE = policy({ 'coverage-exempt': 'zzz/**' });

  test('the record keeps the user\'s globs; a tool\'s change adds none to them, but a push owes the file\'s globs too', () => {
    const w = started();
    expect(rawSeen(w.s).globs).toEqual({ 'defer-test': ['src/a.ts'] });
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
    writeFileSync(w.policy, POLICY_NEW); // a tool added src/new.ts
    expect(watchPolicy(w.s, w.d)).toBe(true);
    expect(rawSeen(w.s).globs).toEqual({ 'defer-test': ['src/a.ts'] });
    // The glob that waits for the next session at the Stop is owed at the push (a push asks more, never less).
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts', 'src/new.ts']);
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-review')).toEqual([]);
  });

  test('a tool that removes or narrows the line does not drop what a push owes (the pin and the record both hold it)', () => {
    const w = started();
    writeFileSync(w.policy, POLICY_NONE);
    expect(watchPolicy(w.s, w.d)).toBe(true);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: [], waiting: [] }); // the Stop: no glob left
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
    // Without the pin (a lost start), the record alone holds it; without the record, the pin does.
    rmSync(join(sessionDirOf(w.s), 'coverage-pin.json'));
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
    const v = started();
    writeFileSync(v.policy, POLICY_NONE);
    rmSync(seenFile(v.s));
    expect(pushDeferGlobs(v.s, v.d, v.d, 'defer-test')).toEqual(['src/a.ts']);
    // The file as the only source: a session with neither.
    const u = started();
    rmSync(join(sessionDirOf(u.s), 'coverage-pin.json'));
    rmSync(seenFile(u.s));
    expect(pushDeferGlobs(u.s, u.d, u.d, 'defer-test')).toEqual(['src/a.ts']);
    writeFileSync(u.policy, POLICY_NONE);
    expect(pushDeferGlobs(u.s, u.d, u.d, 'defer-test')).toEqual([]);
  });

  test('the user\'s next message adds the globs it finds to those kept, and drops none', () => {
    const w = started();
    writeFileSync(w.policy, policy({ 'defer-review': 'docs/**' })); // a tool removed the defer-test line, and the user added a review one
    notePolicySeen(w.s, w.d);
    expect(rawSeen(w.s).globs).toEqual({ 'defer-test': ['src/a.ts'], 'defer-review': ['docs/**'] });
    writeFileSync(w.policy, POLICY_NEW);
    notePolicySeen(w.s, w.d);
    expect(rawSeen(w.s).globs).toEqual({ 'defer-test': ['src/a.ts', 'src/new.ts'], 'defer-review': ['docs/**'] });
    // A user message that finds no policy file keeps them all.
    rmSync(w.policy);
    notePolicySeen(w.s, w.d);
    expect(rawSeen(w.s).globs).toEqual({ 'defer-test': ['src/a.ts', 'src/new.ts'], 'defer-review': ['docs/**'] });
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-review')).toEqual(['docs/**']);
  });

  test('a record that holds a planted glob list: only the strings of the two keys are read, and only more is owed', () => {
    const w = started();
    writeFileSync(seenFile(w.s), JSON.stringify({ hash: sha1(POLICY_OLD), globs: { 'defer-test': [1, 'src/planted.ts', null], 'defer-review': 'nope', other: ['x'] } }));
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts', 'src/planted.ts']);
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-review')).toEqual([]);
    writeFileSync(seenFile(w.s), JSON.stringify({ hash: sha1(POLICY_OLD), globs: null }));
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
    // A record that cannot be read adds no glob and takes none away; so does one over the read cap.
    writeFileSync(seenFile(w.s), 'not json');
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
    writeFileSync(seenFile(w.s), JSON.stringify({ hash: sha1(POLICY_OLD), globs: { 'defer-test': ['src/big.ts'] }, pad: 'x'.repeat(300 * 1024) }));
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
    expect(policyWrittenThisSession(w.s)).toBe(true); // refused counts as written
  });

  test('pinnedUserGlobs: the globs pinned for the top, whether or not the file still has them; none for another top or no pin', () => {
    const w = started();
    expect(pinnedUserGlobs(w.s, w.d, 'defer-test')).toEqual(['src/a.ts']);
    expect(pinnedUserGlobs(w.s, w.d, 'defer-review')).toEqual([]);
    expect(pinnedUserGlobs(w.s, w.d, 'coverage-exempt')).toEqual([]);
    writeFileSync(w.policy, POLICY_NONE);
    expect(pinnedUserGlobs(w.s, w.d, 'defer-test')).toEqual(['src/a.ts']);
    expect(pinnedUserGlobs(w.s, join(w.d, 'other'), 'defer-test')).toEqual([]);
    expect(pinnedUserGlobs(sessionId(), w.d, 'defer-test')).toEqual([]);
    const v = tmp();
    sh(v, 'git init -q -b main');
    write(v, '.goodboy/policy.md', policy({ 'coverage-exempt': 'zzz/**' }));
    const s = sessionId();
    pinCoverageStart(s, v);
    expect(pinnedUserGlobs(s, v, 'coverage-exempt')).toEqual(['zzz/**']);
  });
});

// ── AC-10b ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-10b: the hooks run the watch (spawned)', () => {
  async function run(hookFile: string, w: { d: string; s: string }, payload: Record<string, unknown>): Promise<{ out: string; err: string }> {
    const proc = Bun.spawn(['bun', hookFile], {
      cwd: w.d,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: w.s, cwd: w.d, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CLAUDE_PROJECT_DIR: w.d, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GOODBOY_POLICY_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1' },
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { out, err };
  }

  /** PreToolUse of a Bash call (it takes the state guard's snapshot, as for every Bash call the model makes). */
  const pre = (w: { d: string; s: string }, id: string, command: string): Promise<{ out: string; err: string }> =>
    run(join(ROOT, 'hooks', 'pre-tool-use.ts'), w, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command } });

  test('SessionStart (startup, resume, clear) takes the policy file as the start; a compact does not', async () => {
    for (const source of ['startup', 'resume', 'clear']) {
      const d = tmp();
      sh(d, 'git init -q -b main');
      write(d, '.goodboy/policy.md', POLICY_OLD);
      const s = sessionId();
      const r = await run(HOOKS.sessionStart, { d, s }, { source, hook_event_name: 'SessionStart' });
      expect([source, r.err]).toEqual([source, '']);
      expect([source, seenOf(s)]).toEqual([source, { hash: sha1(POLICY_OLD) }]);
    }
    const d = tmp();
    sh(d, 'git init -q -b main');
    write(d, '.goodboy/policy.md', POLICY_OLD);
    const s = sessionId();
    await run(HOOKS.sessionStart, { d, s }, { source: 'compact', hook_event_name: 'SessionStart' });
    expect(existsSync(seenFile(s))).toBe(false);
  });

  test('UserPromptSubmit takes the file as the user\'s, and keeps what a tool wrote this session a tool\'s', async () => {
    const w = started();
    writeFileSync(w.policy, POLICY_NEW); // the user typed it
    const r = await run(HOOKS.userPrompt, w, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    expect(r.err).toBe('');
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_NEW) });
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts', 'src/new.ts'], waiting: [] });
    // A tool's write, then another user message: written stays.
    const v = started();
    writeFileSync(v.policy, POLICY_NEW);
    expect(watchPolicy(v.s, v.d)).toBe(true);
    await run(HOOKS.userPrompt, v, { hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    expect(seenOf(v.s)).toEqual({ hash: sha1(POLICY_NEW), written: true });
  });

  test('PostToolUse after a Bash call that changed the policy file with no logged path: written, the glob waits', async () => {
    const w = started();
    await pre(w, 'toolu_w1', 'bash script.sh');
    writeFileSync(w.policy, POLICY_NEW); // `bash script.sh` ran; the script is no interpreter call the sweep reads
    const r = await run(HOOKS.postTool, w, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_w1', tool_input: { command: 'bash script.sh' }, tool_response: {} });
    expect(r.err).toBe('');
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_NEW), written: true });
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: ['src/new.ts'] });
  });

  test('PostToolUse after a Write through a link to the policy file: the same', async () => {
    const w = started();
    symlinkSync(w.policy, join(w.d, 'notes.md'));
    writeFileSync(join(w.d, 'notes.md'), POLICY_NEW);
    await run(HOOKS.postTool, w, { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_use_id: 'toolu_w2', tool_input: { file_path: join(w.d, 'notes.md'), content: POLICY_NEW }, tool_response: {} });
    expect(seenOf(w.s).written).toBe(true);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test').waiting).toEqual(['src/new.ts']);
  });

  test('PostToolUse after a call that left the policy file alone: nothing is written', async () => {
    const w = started();
    await pre(w, 'toolu_w3', 'ls');
    await run(HOOKS.postTool, w, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_w3', tool_input: { command: 'ls' }, tool_response: {} });
    await run(HOOKS.postTool, w, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_w4', tool_input: { file_path: join(w.d, 'src', 'a.ts') }, tool_response: {} });
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_OLD) });
  });

  test('PostToolUseFailure after a failed Bash call, and after a failed file tool: written', async () => {
    const w = started();
    await pre(w, 'toolu_f1', 'bash script.sh; exit 1');
    writeFileSync(w.policy, POLICY_NEW);
    const r = await run(HOOKS.postToolFailure, w, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_f1', tool_input: { command: 'bash script.sh; exit 1' }, error: 'exit 1' });
    expect(r.err).toBe('');
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_NEW), written: true });
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test').waiting).toEqual(['src/new.ts']);
    const v = started();
    writeFileSync(v.policy, POLICY_NEW);
    await run(HOOKS.postToolFailure, v, { hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_use_id: 'toolu_f2', tool_input: { file_path: join(v.d, 'src', 'a.ts') }, error: 'no match' });
    expect(seenOf(v.s)).toEqual({ hash: sha1(POLICY_NEW), written: true });
    // A failed call that left the file alone changes nothing.
    const u = started();
    await pre(u, 'toolu_f3', 'false');
    await run(HOOKS.postToolFailure, u, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'toolu_f3', tool_input: { command: 'false' }, error: 'exit 1' });
    expect(seenOf(u.s)).toEqual({ hash: sha1(POLICY_OLD) });
  });
});

// ── AC-10c ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-10c: the state guard and the watch\'s record', () => {
  /** The guard asked in process (its snapshot and restore are what the Bash hooks call around a model command). */
  function guarded(change: (w: ReturnType<typeof started>) => void, id: string, untrusted: boolean): ReturnType<typeof started> {
    const w = started();
    snapshotGateState(w.s, id);
    if (untrusted) {
      // A call that deleted the snapshot's index: the restore cannot believe its copies.
      const snap = Bun.spawnSync(['sh', '-c', `ls -d ${JSON.stringify(sessionDirOf(w.s))}/bash-guard-*`]).stdout.toString().trim();
      rmSync(join(snap, '.index.json'));
    }
    change(w);
    restoreGateState(w.s, id);
    return w;
  }
  const forged = (w: ReturnType<typeof started>): void => writeFileSync(seenFile(w.s), JSON.stringify({ hash: sha1(POLICY_NEW) })); // what makes the new content "seen"

  test('a call that rewrote the record to the new content: put back, and the next watch finds the change', () => {
    const w = guarded((x) => {
      writeFileSync(x.policy, POLICY_NEW);
      forged(x);
    }, 'toolu_g1', false);
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_OLD) });
    expect(watchPolicy(w.s, w.d)).toBe(true);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test').waiting).toEqual(['src/new.ts']);
  });

  test('a call that removed the record: put back', () => {
    const w = guarded((x) => rmSync(seenFile(x.s)), 'toolu_g2', false);
    expect(seenOf(w.s)).toEqual({ hash: sha1(POLICY_OLD) });
  });


  test('a restore that cannot believe its copy leaves the record saying written, with the user\'s globs (a rewrite, a removal)', () => {
    const w = guarded((x) => {
      writeFileSync(x.policy, POLICY_NEW);
      forged(x);
    }, 'toolu_g3', true);
    expect(readFileSync(seenFile(w.s), 'utf8')).toBe(UNTRUSTED_WITH_GLOB);
    expect(policyWrittenThisSession(w.s)).toBe(true);
    expect(deferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual({ globs: ['src/a.ts'], waiting: ['src/new.ts'] });
    const v = guarded((x) => {
      writeFileSync(x.policy, POLICY_NEW);
      rmSync(seenFile(x.s));
    }, 'toolu_g4', true);
    expect(readFileSync(seenFile(v.s), 'utf8')).toBe(UNTRUSTED_WITH_GLOB);
  });

  test('an untrusted restore leaves the record written also when the call left it alone', () => {
    const w = guarded(() => {}, 'toolu_g5', true);
    expect(readFileSync(seenFile(w.s), 'utf8')).toBe(UNTRUSTED_WITH_GLOB);
    expect(policyWrittenThisSession(w.s)).toBe(true);
  });

  test('a call that removed its whole snapshot dir (the note remains) and rewrote the record: written, at the call\'s restore and at the Stop', () => {
    for (const via of ['call', 'stop'] as const) {
      const w = started();
      const id = `toolu_g6${via}`;
      snapshotGateState(w.s, id);
      const snap = Bun.spawnSync(['sh', '-c', `ls -d ${JSON.stringify(sessionDirOf(w.s))}/bash-guard-*`]).stdout.toString().trim();
      rmSync(snap, { recursive: true, force: true });
      writeFileSync(w.policy, POLICY_NEW);
      forged(w);
      if (via === 'call') restoreGateState(w.s, id);
      else restoreOrphanGateState(w.s);
      expect([via, seenOf(w.s)]).toEqual([via, { hash: 'untrusted', written: true }]);
      expect([via, policyWrittenThisSession(w.s)]).toEqual([via, true]);
    }
  });

  test('untrustedPolicySeen: the union of the deferral globs the texts hold, strings of the two keys only', () => {
    const rec = (globs: unknown): string => JSON.stringify({ hash: 'h', globs });
    expect(untrustedPolicySeen([])).toBe('{"hash":"untrusted","written":true}');
    expect(untrustedPolicySeen([null, undefined, 'not json', 'null', '{}', '{"globs":null}', '{"globs":"x"}'])).toBe('{"hash":"untrusted","written":true}');
    const both = untrustedPolicySeen([rec({ 'defer-test': ['a', 'b'], 'defer-review': ['r'] }), rec({ 'defer-test': ['b', 'c'] })]);
    expect(JSON.parse(both)).toEqual({ hash: 'untrusted', written: true, globs: { 'defer-test': ['a', 'b', 'c'], 'defer-review': ['r'] } });
    // Other keys, inherited names, non-arrays and non-strings are dropped.
    const dirty = untrustedPolicySeen([rec({ other: ['x'], 'defer-test': 'nope', 'defer-review': [1, null, 'ok', { a: 1 }] }), '{"globs":{"__proto__":["p"],"constructor":["c"]}}']);
    expect(JSON.parse(dirty)).toEqual({ hash: 'untrusted', written: true, globs: { 'defer-review': ['ok'] } });
  });
});

// ── AC-10d ──────────────────────────────────────────────────────────────────────────────────────

describe('AC-10d: a Bash call that removed its snapshot and its note (security delta review)', () => {
  /** pre-tool-use, the script run for real, then the post hook of the same call: what Claude Code does around a Bash call.
   *  The script removes the guard's `.seal-notes` and `bash-guard-*`, appends a deferral glob to the policy, and rewrites
   *  the watch's record to the policy's new hash (`rm: false` leaves the guard alone: the control). */
  async function call(post: string, rm: boolean): Promise<ReturnType<typeof started>> {
    const w = started();
    const dir = sessionDirOf(w.s);
    const script = join(tmp('goodboy-n8bw-script-'), 'x.sh');
    writeFileSync(
      script,
      `${rm ? `rm -rf "${dir}"/.seal-notes "${dir}"/bash-guard-*\n` : ''}printf '\\n## P1\\n- decide: human\\n- source: user\\n- defer-test: src/new.ts\\n' >> "${w.policy}"\n` +
        `H=$(shasum "${w.policy}" | cut -d' ' -f1)\nprintf '{"hash":"%s"}' "$H" > "${dir}/${POLICY_SEEN_FILE}"\n`,
    );
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: w.d, GOODBOY_POLICY_GATE: 'off', GOODBOY_OUTWARD_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1' };
    delete env.CLAUDE_CODE_SESSION_ID;
    const spawn = async (hookFile: string, payload: Record<string, unknown>): Promise<string> => {
      const proc = Bun.spawn(['bun', hookFile], { cwd: w.d, stdin: new TextEncoder().encode(JSON.stringify({ session_id: w.s, cwd: w.d, ...payload })), stdout: 'pipe', stderr: 'pipe', env });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      expect(err).toBe('');
      return out;
    };
    const id = `toolu_${Math.random().toString(36).slice(2, 10)}`;
    const command = `bash ${script}`;
    const pre = await spawn(join(ROOT, 'hooks', 'pre-tool-use.ts'), { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command } });
    expect(pre).not.toContain('"deny"');
    expect(Bun.spawnSync(['bash', script], { cwd: w.d }).exitCode).toBe(0);
    if (post === 'post-tool-use') {
      await spawn(HOOKS.postTool, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, tool_response: { stdout: '', stderr: '', interrupted: false } });
    } else {
      await spawn(HOOKS.postToolFailure, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: id, tool_input: { command }, error: 'exit 1' });
    }
    return w;
  }

  test('the record it rewrote does not make the glob count: it waits for the next session (after PostToolUse and PostToolUseFailure)', async () => {
    for (const post of ['post-tool-use', 'post-tool-use-failure']) {
      const w = await call(post, true);
      expect(readFileSync(w.policy, 'utf8')).toContain('defer-test: src/new.ts'); // the script did write the policy
      expect([post, seenOf(w.s).written]).toEqual([post, true]);
      expect([post, deferGlobs(w.s, w.d, w.d, 'defer-test')]).toEqual([post, { globs: ['src/a.ts'], waiting: ['src/new.ts'] }]);
    }
  });

  test('the control: the same script without the removal is put back and found by the next watch', async () => {
    for (const post of ['post-tool-use', 'post-tool-use-failure']) {
      const w = await call(post, false);
      expect([post, deferGlobs(w.s, w.d, w.d, 'defer-test')]).toEqual([post, { globs: ['src/a.ts'], waiting: ['src/new.ts'] }]);
    }
  });

  test('restoreGateState for a call that never had a snapshot marks the record written (no call id: nothing)', () => {
    const w = started();
    const before = readFileSync(seenFile(w.s), 'utf8');
    expect(restoreGateState(w.s, undefined)).toEqual([]);
    expect(readFileSync(seenFile(w.s), 'utf8')).toBe(before);
    expect(restoreGateState(w.s, '')).toEqual([]);
    expect(readFileSync(seenFile(w.s), 'utf8')).toBe(before);
    expect(restoreGateState(w.s, 'toolu_never_snapshotted')).toEqual([]);
    expect(readFileSync(seenFile(w.s), 'utf8')).toBe(UNTRUSTED_WITH_GLOB);
    expect(policyWrittenThisSession(w.s)).toBe(true);
    // The other guarded files are left alone (an untrusted restore would remove every cursor).
    const cursor = join(sessionDirOf(w.s), '.goodboy-last-review-0123456789ab.json');
    writeFileSync(cursor, '{"turn":1}');
    restoreGateState(w.s, 'toolu_never_snapshotted_2');
    expect(existsSync(cursor)).toBe(true);
    // No record at all: one saying written is made.
    rmSync(seenFile(w.s));
    restoreGateState(w.s, 'toolu_never_snapshotted_3');
    expect(readFileSync(seenFile(w.s), 'utf8')).toBe('{"hash":"untrusted","written":true}');
  });
});
