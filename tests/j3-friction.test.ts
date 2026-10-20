import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { frictionMessage, frictionNotice, frictionNoticeOn, frictionSignals, REPEAT_BLOCKS, STOP_BLOCK_COUNTERS, switchesOff } from '../lib/friction';
import { type GateEvent, hookError, logGate, readGateLog } from '../lib/gate-log';
import type { DispatchRecord } from '../lib/spawn-guard';

// Track J3 (#11): the friction notice at Stop. Each signal from a recorded fixture, a clean
// session shows nothing, and the notice appears once per session.

const REPO = resolve(import.meta.dir, '..');
const HOOK = join(REPO, 'hooks', 'stop.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** A project dir with one document and one code file. */
function project(): { root: string; doc: string; code: string } {
  const root = tmp('goodboy-j3-proj-');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const doc = join(root, 'docs', 'guide.md');
  const code = join(root, 'src', 'app.ts');
  writeFileSync(doc, '# Guide\n');
  writeFileSync(code, 'export const x = 1;\n');
  return { root, doc, code };
}

/** A fresh session id whose state dir is removed after the test. */
function session(): string {
  const sid = `j3-${Math.random().toString(36).slice(2)}`;
  tmpDirs.push(join(tmpdir(), `goodboy-session-${sid}`));
  return sid;
}

const T0 = Date.parse('2026-10-20T03:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, gate: string, decision: GateEvent['decision'], reason?: string): GateEvent => ({ ts: at(min), gate, decision, ...(reason ? { reason } : {}) });
const dispatch = (min: number, tuid: string, callee: string, files: string[]): DispatchRecord => ({
  k: 'dispatch',
  t: T0 + min * 60_000,
  tuid,
  caller: null,
  callerId: null,
  callee,
  hash: 'h',
  model: null,
  effort: null,
  files,
  why: 'new',
});

function signals(
  gateLog: GateEvent[],
  dispatchLog: DispatchRecord[] = [],
  root = '/nonexistent',
  before: string[] = [],
  now: string[] = [],
  more: { edits?: { file: string; t: number }[]; blockCounts?: Record<string, number> } = {},
) {
  return frictionSignals({ gateLog, dispatchLog, root, switchesBefore: before, switchesNow: now, ...more });
}
const edit = (min: number, file: string) => ({ file, t: T0 + min * 60_000 });

describe('signals from recorded fixtures', () => {
  test('a hook error', () => {
    const s = signals([ev(1, 'hook-error', 'fail-open', 'pre-tool-use fatal: TypeError: x is undefined')]);
    expect(s.map((x) => [x.kind, x.subject])).toEqual([['hook-error', 'pre-tool-use']]);
  });

  test('a fail-open from an error counts; the routine transcript waits do not', () => {
    const routine = [
      ev(1, 'reasoning', 'fail-open', 'text-flush-lag(10)'),
      ev(2, 'compact-force', 'fail-open', 'limit-unconfident pct=81'),
      ev(3, 'reasoning', 'fail-open', 'subagent-transcript-not-found'),
    ];
    expect(signals(routine)).toEqual([]);
    const s = signals([...routine, ev(4, 'push-test', 'fail-open', 'Error: spawn failed')]);
    expect(s.map((x) => [x.kind, x.subject])).toEqual([['fail-open', 'push-test']]);
    // A fail-open without a reason is not routine.
    expect(signals([ev(5, 'docs', 'fail-open')]).map((x) => x.kind)).toEqual(['fail-open']);
  });

  test(`a Stop gate blocking ${REPEAT_BLOCKS} times in a row; PreToolUse denies do not count`, () => {
    expect(signals([], [], '/x', [], [], { blockCounts: { review: 3, test: 0 } }).map((x) => [x.kind, x.subject])).toEqual([['repeated-block', 'review']]);
    expect(signals([], [], '/x', [], [], { blockCounts: { review: 2, test: 2 } })).toEqual([]);
    // The model's own mistakes that a PreToolUse gate corrects are normal work.
    const denies = [1, 2, 3, 4, 5].map((m) => ev(m, 'bash-write', 'deny', 'sed -i'));
    expect(signals([...denies, ev(6, 'read-before-edit', 'deny'), ev(7, 'read-before-edit', 'deny'), ev(8, 'read-before-edit', 'deny')])).toEqual([]);
  });

  test('the block counters are the files the Stop hook writes', () => {
    const stop = readFileSync(HOOK, 'utf8');
    for (const file of Object.keys(STOP_BLOCK_COUNTERS)) expect({ file, inStop: stop.includes(`'${file}'`) || file === '.goodboy-retry-count.txt' }).toEqual({ file, inStop: true });
    // The default counter is the review gate's (lib/retry-counter.ts).
    expect(readFileSync(join(REPO, 'lib', 'retry-counter.ts'), 'utf8')).toContain("'.goodboy-retry-count.txt'");
  });

  test('a document change: a review past its budget, or any test run', () => {
    const p = project();
    const launchedDone = (tuid: string, agent: string, endMs: number): DispatchRecord[] => [
      { k: 'launched', t: T0 + 1, tuid, agentId: agent },
      { k: 'done', t: T0 + endMs, tuid: null, agentId: agent, outcome: 'ok' },
    ];
    const docEdit = [edit(-5, p.doc)];
    const long = [dispatch(0, 'r1', 'goodboy:review-all', []), ...launchedDone('r1', 'ag1', 12 * 60_000)];
    expect(signals([], long, p.root, [], [], { edits: docEdit }).map((x) => [x.kind, x.subject])).toEqual([['over-budget', 'review-all']]);
    expect(signals([], long, p.root, [], [], { edits: docEdit })[0].text).toContain('12분');
    // The budget is 10 minutes: exactly 10 is within it, one second more is not.
    expect(signals([], [dispatch(0, 'r2', 'goodboy:review-all', []), ...launchedDone('r2', 'ag2', 10 * 60_000)], p.root, [], [], { edits: docEdit })).toEqual([]);
    const over = signals([], [dispatch(0, 'r2b', 'goodboy:review-all', []), ...launchedDone('r2b', 'ag2b', 10 * 60_000 + 1000)], p.root, [], [], { edits: docEdit });
    expect(over.map((x) => x.kind)).toEqual(['over-budget']);
    expect(over[0].text).toContain('11분');
    // A code edit in the change, or no edit at all: not a document change.
    expect(signals([], long, p.root, [], [], { edits: [...docEdit, edit(-4, p.code)] })).toEqual([]);
    expect(signals([], long, p.root)).toEqual([]);
    // The session's edits decide, not the files a prompt names: a review of a code change
    //   whose prompt names only a spec document is not a document change.
    const named = [dispatch(0, 'r3', 'goodboy:review-all', [p.doc]), ...launchedDone('r3', 'ag3', 30 * 60_000)];
    expect(signals([], named, p.root, [], [], { edits: [edit(-5, p.code)] })).toEqual([]);
    // The change of a run starts after the previous run of the same team: a code change
    //   reviewed before, then a doc-only fix reviewed again.
    const two = [
      dispatch(0, 'r4', 'goodboy:review-all', []),
      ...launchedDone('r4', 'ag4', 60_000),
      dispatch(20, 'r5', 'goodboy:review-all', []),
      { k: 'done', t: T0 + 35 * 60_000, tuid: 'r5', agentId: null, outcome: 'ok' } as DispatchRecord,
    ];
    expect(signals([], two, p.root, [], [], { edits: [edit(-5, p.code), edit(10, p.doc)] }).map((x) => x.text)).toEqual([expect.stringContaining('15분')]);
    // An edit after the dispatch belongs to the next run.
    expect(signals([], long, p.root, [], [], { edits: [edit(1, p.doc)] })).toEqual([]);
    // Still running: not judged yet.
    expect(signals([], [dispatch(0, 'r6', 'goodboy:review-all', [])], p.root, [], [], { edits: docEdit })).toEqual([]);
    // A foreground run ends on its tool-use id; the pre-G2 name is the same role.
    const fg: DispatchRecord[] = [dispatch(0, 'r7', 'goodboy:review-changes', []), { k: 'done', t: T0 + 15 * 60_000, tuid: 'r7', agentId: null, outcome: 'ok' }];
    expect(signals([], fg, p.root, [], [], { edits: docEdit }).map((x) => x.subject)).toEqual(['review-all']);
    // Any test run on a document change, finished or not; none on a code change.
    expect(signals([], [dispatch(0, 't1', 'goodboy:test-unit', [])], p.root, [], [], { edits: docEdit }).map((x) => [x.kind, x.subject])).toEqual([['over-budget', 'test-unit']]);
    expect(signals([], [dispatch(0, 't2', 'goodboy:test-unit', [])], p.root, [], [], { edits: [edit(-5, p.code)] })).toEqual([]);
    // A role outside the review and test teams is never judged.
    expect(signals([], [dispatch(0, 'b1', 'goodboy:build-code', [])], p.root, [], [], { edits: docEdit })).toEqual([]);
  });

  test('a name from the records that is not a plain short name is shown as unknown', () => {
    const s = signals([ev(1, 'x\n[goodboy] fake', 'fail-open', 'Error'), ev(2, 'hook-error', 'fail-open', `${'h'.repeat(60)} fatal: E`)]);
    expect(s.map((x) => x.subject)).toEqual(['unknown', 'unknown']);
    expect(frictionMessage(s)).not.toContain('fake');
  });

  test("the user's marker letting a gate pass", () => {
    const s = signals([ev(1, 'review', 'warn', 'user-override')]);
    expect(s.map((x) => [x.kind, x.subject])).toEqual([['user-override', 'review']]);
    expect(signals([ev(1, 'review', 'warn', 'no-section')])).toEqual([]);
  });

  test('a switch turned off during the session; one off from the start is not', () => {
    expect(signals([], [], '/x', [], ['GOODBOY_TEST_GATE']).map((x) => [x.kind, x.subject])).toEqual([['switched-off', 'GOODBOY_TEST_GATE']]);
    expect(signals([], [], '/x', ['GOODBOY_TEST_GATE'], ['GOODBOY_TEST_GATE'])).toEqual([]);
    expect(switchesOff({ GOODBOY_TEST_GATE: ' OFF ', GOODBOY_REVIEW_GATE: 'on', GOODBOY_FRICTION_NOTICE: 'off', GOODBOY_INBOX_NOTICE: 'off', OTHER: 'off' })).toEqual(['GOODBOY_TEST_GATE']);
  });

  test('a clean session shows nothing, and repeats of one signal count once', () => {
    const clean = [
      ev(1, 'reasoning', 'warn', 'no-section'),
      ev(2, 'reasoning', 'fail-open', 'text-flush-lag(3)'),
      ev(3, 'bash-write', 'deny', 'sed -i'),
      ev(4, 'review', 'deny'),
      ev(5, 'claim', 'warn', 'flush-wait-hit(390ms)'),
    ];
    expect(signals(clean, [{ k: 'prompt', t: T0 }])).toEqual([]);
    const twice = signals([ev(1, 'hook-error', 'fail-open', 'stop fatal: E'), ev(2, 'hook-error', 'fail-open', 'stop track error: E')]);
    expect(twice).toHaveLength(1);
  });

  test('the notice names the first signal, how many more, the command and the switch', () => {
    const s = signals([ev(1, 'hook-error', 'fail-open', 'stop fatal: E'), ev(2, 'review', 'warn', 'user-override')]);
    const m = frictionMessage(s);
    expect(m).toContain('goodboy stop 훅에서 오류가 났어요');
    expect(m).toContain('외 1건');
    expect(m).toContain('/report-goodboy');
    expect(m).toContain('GOODBOY_FRICTION_NOTICE=off');
  });
});

describe('once per session, and where it is on', () => {
  test('the notice appears once; a clean session gets none', () => {
    const p = project();
    const env = { GOODBOY_FRICTION_NOTICE: 'on' };
    const clean = session();
    logGate(clean, 'reasoning', 'fail-open', 'text-flush-lag(2)');
    expect(frictionNotice({ sessionId: clean, cwd: p.root, root: p.root, env })).toBeNull();

    const sid = session();
    logGate(sid, 'push-test', 'fail-open', 'Error: boom');
    const first = frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env });
    expect(first).toContain('push-test 게이트가 판단하지 못하고 통과시켰어요');
    logGate(sid, 'hook-error', 'fail-open', 'stop fatal: E');
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env })).toBeNull();
  });

  test('a switch turned off between two Stops of one session', () => {
    const p = project();
    const sid = session();
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env: { GOODBOY_FRICTION_NOTICE: 'on' } })).toBeNull();
    const m = frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env: { GOODBOY_FRICTION_NOTICE: 'on', GOODBOY_DOCS_GATE: 'off' } });
    expect(m).toContain('GOODBOY_DOCS_GATE=off');
  });

  test('off with the switch; off by default in goodboy\'s own repo, on elsewhere', () => {
    const p = project();
    const sid = session();
    logGate(sid, 'hook-error', 'fail-open', 'stop fatal: E');
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env: { GOODBOY_FRICTION_NOTICE: 'off' } })).toBeNull();
    expect(frictionNoticeOn(REPO, { HOME: tmp('goodboy-j3-home-') })).toBe(false);
    expect(frictionNoticeOn(REPO, { HOME: tmp('goodboy-j3-home-'), GOODBOY_FRICTION_NOTICE: 'on' })).toBe(true);
    expect(frictionNoticeOn(p.root, { HOME: tmp('goodboy-j3-home-') })).toBe(true);
    // The switch was off, so nothing was latched: it still shows once turned on.
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env: { GOODBOY_FRICTION_NOTICE: 'on' } })).toContain('/report-goodboy');
  });

  test('a broken state file never throws and never repeats the notice forever', () => {
    const p = project();
    const sid = session();
    logGate(sid, 'hook-error', 'fail-open', 'stop fatal: E');
    const dir = join(tmpdir(), `goodboy-session-${sid}`);
    writeFileSync(join(dir, 'friction-notice.json'), '{not json');
    const env = { GOODBOY_FRICTION_NOTICE: 'on' };
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env })).toContain('/report-goodboy');
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env })).toBeNull();
  });

  test('a FIFO at the state file or at a block counter never hangs the Stop', async () => {
    const p = project();
    const sid = session();
    const dir = join(tmpdir(), `goodboy-session-${sid}`);
    mkdirSync(dir, { recursive: true });
    for (const f of ['friction-notice.json', '.goodboy-test-retry-count.txt']) expect(Bun.spawnSync(['mkfifo', join(dir, f)]).exitCode).toBe(0);
    // In a child process with a deadline: a blocking read would stall this test runner too.
    const script = `import { frictionNotice } from ${JSON.stringify(join(REPO, 'lib', 'friction.ts'))};
      import { logGate } from ${JSON.stringify(join(REPO, 'lib', 'gate-log.ts'))};
      logGate(${JSON.stringify(sid)}, 'hook-error', 'fail-open', 'stop fatal: E');
      process.stdout.write(String(frictionNotice({ sessionId: ${JSON.stringify(sid)}, cwd: ${JSON.stringify(p.root)}, root: ${JSON.stringify(p.root)}, env: { GOODBOY_FRICTION_NOTICE: 'on' } })));`;
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    const timer = setTimeout(() => proc.kill(), 5000);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    // It answers in time; the latch at a FIFO cannot be written, so no notice.
    expect({ code, out }).toEqual({ code: 0, out: 'null' });
  });

  test('a latch that cannot be written shows nothing rather than a notice on every Stop', () => {
    const p = project();
    const sid = session();
    logGate(sid, 'hook-error', 'fail-open', 'stop fatal: E');
    mkdirSync(join(tmpdir(), `goodboy-session-${sid}`, 'friction-notice.json'));
    const env = { GOODBOY_FRICTION_NOTICE: 'on' };
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env })).toBeNull();
    expect(frictionNotice({ sessionId: sid, cwd: p.root, root: p.root, env })).toBeNull();
  });

  test('reads the Stop block counters and the edit log of the session', () => {
    const p = project();
    const env = { GOODBOY_FRICTION_NOTICE: 'on' };
    const blocked = session();
    const dir = join(tmpdir(), `goodboy-session-${blocked}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.goodboy-test-retry-count.txt'), '3');
    expect(frictionNotice({ sessionId: blocked, cwd: p.root, root: p.root, env })).toContain('test 게이트가 3번 연속 막았어요');

    const docs = session();
    const ddir = join(tmpdir(), `goodboy-session-${docs}`);
    mkdirSync(ddir, { recursive: true });
    const t = Date.now();
    writeFileSync(join(ddir, 'edits.jsonl'), JSON.stringify({ file: p.doc, turn: 1, timestamp: new Date(t - 60_000).toISOString() }) + '\n');
    writeFileSync(join(ddir, 'dispatch-log.jsonl'), JSON.stringify({ ...dispatch(0, 'x1', 'goodboy:test-unit', []), t }) + '\n');
    expect(frictionNotice({ sessionId: docs, cwd: p.root, root: p.root, env })).toContain('테스트 에이전트(test-unit)');
  });
});

describe('hook errors are recorded', () => {
  test('hookError writes stderr as before and a hook-error line to the gate log', () => {
    const sid = session();
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => {
      written.push(String(s));
      return true;
    };
    try {
      hookError(sid, 'stop', 'fatal', new Error('boom'));
      hookError(sid, 'subagent-stop', '', new Error('bad'));
      hookError(null, 'stop', 'fatal', new Error('no session'));
    } finally {
      (process.stderr as { write: unknown }).write = orig;
    }
    expect(written).toEqual(['[goodboy stop] fatal: Error: boom\n', '[goodboy subagent-stop] Error: bad\n', '[goodboy stop] fatal: Error: no session\n']);
    expect(readGateLog(sid).map((e) => [e.gate, e.decision, e.reason])).toEqual([
      ['hook-error', 'fail-open', 'stop fatal: Error: boom'],
      ['hook-error', 'fail-open', 'subagent-stop Error: bad'],
    ]);
  });

  test('every hook error path with a session goes through hookError', () => {
    const files = [
      ...['pre-tool-use', 'post-tool-use', 'post-tool-use-failure', 'stop', 'subagent-stop', 'user-prompt-submit', 'session-start'].map((f) => join('hooks', `${f}.ts`)),
      join('lib', 'write-sweep.ts'),
    ];
    for (const f of files) {
      const src = readFileSync(join(REPO, f), 'utf8');
      const raw = src.split('\n').filter((l) => l.includes('process.stderr.write') && !l.includes('stdin parse error'));
      expect({ f, raw }).toEqual({ f, raw: [] });
    }
    // Session-start wrote nothing on its fatal path before; now it records the error.
    expect(readFileSync(join(REPO, 'hooks', 'session-start.ts'), 'utf8')).toContain("hookError(errorSession, 'session-start', 'fatal', err)");
  });

  test('a hook given `null` on stdin still exits 0 with an empty answer', async () => {
    const base = tmp('goodboy-j3-null-');
    for (const f of ['pre-tool-use', 'post-tool-use', 'post-tool-use-failure', 'stop', 'subagent-stop', 'user-prompt-submit', 'session-start']) {
      const proc = Bun.spawn(['bun', join(REPO, 'hooks', `${f}.ts`)], {
        cwd: base,
        stdin: new TextEncoder().encode('null'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base, HOME: base },
      });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect({ f, code, out: JSON.parse(out || 'null') }).toEqual({ f, code: 0, out: {} });
    }
  });
});

describe('the Stop hook', () => {
  function stopSetup() {
    const base = tmp('goodboy-j3-stop-');
    const cwd = join(base, 'repo');
    mkdirSync(cwd, { recursive: true });
    const sid = `j3stop-${Math.random().toString(36).slice(2)}`;
    const dir = join(base, `goodboy-session-${sid}`);
    mkdirSync(dir, { recursive: true });
    const stop = async (env: Record<string, string>) => {
      const proc = Bun.spawn(['bun', HOOK], {
        cwd,
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, hook_event_name: 'Stop' })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base, HOME: base, GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off', ...env },
      });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
      await proc.exited;
      return out;
    };
    return { cwd, dir, stop };
  }

  test('shows the notice once with a recorded hook error, never as a block', async () => {
    const s = stopSetup();
    writeFileSync(join(s.dir, 'gate-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), gate: 'hook-error', decision: 'fail-open', reason: 'pre-tool-use fatal: E' }) + '\n');
    const first = await s.stop({ GOODBOY_FRICTION_NOTICE: '' });
    expect(first.decision).toBeUndefined();
    expect(String(first.systemMessage ?? '')).toContain('goodboy pre-tool-use 훅에서 오류가 났어요');
    expect(JSON.stringify(first.hookSpecificOutput ?? {})).not.toContain('report-goodboy');
    const second = await s.stop({ GOODBOY_FRICTION_NOTICE: '' });
    expect(String(second.systemMessage ?? '')).not.toContain('/report-goodboy');
    expect(existsSync(join(s.dir, 'friction-notice.json'))).toBe(true);
  });

  test('a Stop gate blocking for the third time in a row shows the notice next to the block', async () => {
    const s = stopSetup();
    // An unreviewed code edit, blocked twice before (stop-g1's setup).
    mkdirSync(join(s.cwd, 'src'), { recursive: true });
    writeFileSync(join(s.cwd, 'src', 'a.ts'), 'x\n');
    writeFileSync(join(s.dir, 'edits.jsonl'), JSON.stringify({ file: join(s.cwd, 'src', 'a.ts'), turn: 0, timestamp: new Date().toISOString() }) + '\n');
    for (const f of ['.goodboy-retry-count.txt', '.goodboy-review-validate-retry-count.txt']) writeFileSync(join(s.dir, f), '2');
    const out = await s.stop({ GOODBOY_FRICTION_NOTICE: '' });
    expect(out.decision).toBe('block');
    expect(String(out.reason)).toContain('(block 3)');
    expect(String(out.systemMessage ?? '')).toContain('review 게이트가 3번 연속 막았어요');
    expect(String(out.reason)).not.toContain('report-goodboy');
  });

  test('a clean session shows no notice', async () => {
    const s = stopSetup();
    const out = await s.stop({ GOODBOY_FRICTION_NOTICE: '' });
    expect(String(out.systemMessage ?? '')).not.toContain('/report-goodboy');
  });
});
