import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { approvalMarkerRelPath, safeToolUseId } from '../lib/approval-marker';
import { ensureSessionDir } from '../lib/file-tracker';
import * as ft from '../lib/file-tracker';
import * as safeRead from '../lib/safe-read';
import * as adv from '../lib/effort-advice';
import * as gl from '../lib/gate-log';
import * as sk from '../lib/skill-rule';
import * as hab from '../lib/token-habits';
import * as am from '../lib/approval-marker';
import * as sg from '../lib/state-guard';
import { restoreGateState, restoreOrphanGateState, snapshotGateState, writesGateState } from '../lib/state-guard';

// v0.36.18 (plan §15.34 item 1, #12): the state guard's remaining gaps. Every session file a hook
// reads goes through `readStateText` (a FIFO is never opened), `turn.txt` is guarded (it never goes
// down), a guarded name a Bash call made as no regular file is removed, and the snapshot index is
// sealed with a keyed hash so a call cannot rewrite what the restore believes.
//
// `safeRead` is a namespace import so that, run against code from before the change, the missing
// `readStateText` fails its own tests and not the whole file.
//
// Real files, real FIFOs (mkfifo), and real spawned hooks. Whatever could hang on a FIFO runs in a
// child process with a timeout, so a regression fails the test and does not stall the run.

const ROOT = resolve(import.meta.dir, '..');
const CHILD_TIMEOUT_MS = 20_000;
const tmpDirs: string[] = [];
let savedTmpdir: string | undefined;

afterEach(() => {
  if (savedTmpdir !== undefined) process.env.TMPDIR = savedTmpdir;
  savedTmpdir = undefined;
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function mkfifo(p: string): void {
  const r = Bun.spawnSync(['mkfifo', p]);
  if (r.exitCode !== 0) throw new Error(`mkfifo failed: ${new TextDecoder().decode(r.stderr)}`);
}

/** A temp base used as $TMPDIR (the session dir and the seal key live in it) and a project dir. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-v18sg-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'a.ts'), 'x');
  const sid = `v18sg-${Math.random().toString(36).slice(2)}`;
  const line = JSON.stringify({ file: join(cwd, 'a.ts'), turn: 0, timestamp: new Date().toISOString() });
  const dir = join(base, `goodboy-session-${sid}`);
  mkdirSync(dir, { recursive: true });
  const spawnHook = async (hook: string, payload: Record<string, unknown>, env: Record<string, string> = {}) => {
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1', ...env },
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const out = JSON.parse(text || '{}') as Record<string, unknown>;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { raw: out, killed: proc.signalCode !== null, denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '' };
  };
  const inProcess = <T>(fn: () => T): T => {
    if (savedTmpdir === undefined) savedTmpdir = process.env.TMPDIR ?? '';
    process.env.TMPDIR = base;
    return fn();
  };
  return { base, cwd, sid, dir, line, key: join(dir, '.seal-key'), spawnHook, inProcess };
}

type Box = ReturnType<typeof sandbox>;

/** A child process that runs a small script against the lib with TMPDIR set; the result is its JSON line. */
async function child(base: string, body: string): Promise<{ result: unknown; killed: boolean; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-v18sg-script-'));
  tmpDirs.push(dir);
  const file = join(dir, 'probe.ts');
  writeFileSync(file, `const lib = (n: string) => import(${JSON.stringify(ROOT + '/lib/')} + n);\nconst out = await (async () => {\n${body}\n})();\nconsole.log(JSON.stringify(out));\n`);
  const proc = Bun.spawn(['bun', file], { cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', env: { ...process.env, TMPDIR: base } });
  const text = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  let result: unknown = null;
  try {
    result = JSON.parse(text.trim().split('\n').pop() ?? 'null');
  } catch {
    result = null;
  }
  return { result, killed: proc.signalCode !== null, stderr };
}

// ---------------------------------------------------------------------------------------------
const readStateText = (p: string, max?: number): string => safeRead.readStateText(p, max);

describe('V18-AC-1 readStateText', () => {
  test('a regular file reads, within the cap (the cap itself included)', () => {
    const s = sandbox();
    const p = join(s.base, 'f.txt');
    writeFileSync(p, 'hello\n');
    expect(readStateText(p)).toBe('hello\n');
    expect(readStateText(p, 6)).toBe('hello\n');
    writeFileSync(p, '');
    expect(readStateText(p)).toBe('');
  });

  test('an absent file throws ENOENT, as readFileSync does', () => {
    const s = sandbox();
    let code = '';
    try {
      readStateText(join(s.base, 'nope'));
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? '';
    }
    expect(code).toBe('ENOENT');
  });

  test('a directory and an oversized file throw', () => {
    const s = sandbox();
    const d = join(s.base, 'dir');
    mkdirSync(d);
    expect(() => readStateText(d)).toThrow();
    const big = join(s.base, 'big');
    writeFileSync(big, 'x'.repeat(100));
    expect(() => readStateText(big, 99)).toThrow();
    expect(readStateText(big, 100)).toHaveLength(100);
  });

  test('a FIFO is never opened: it throws at once, with no writer and no hang', async () => {
    const s = sandbox();
    const fifo = join(s.base, 'turn-fifo');
    mkfifo(fifo);
    const r = await child(s.base, `const { readStateText } = await lib('safe-read'); try { readStateText(${JSON.stringify(fifo)}); return { threw: false }; } catch (e) { return { threw: true, code: (e as any).code }; }`);
    expect(r.killed).toBe(false);
    expect(r.result).toEqual({ threw: true, code: 'EINVAL' });
  });

  test('a link to a device is no regular file', () => {
    const s = sandbox();
    const l = join(s.base, 'zero');
    symlinkSync('/dev/zero', l);
    expect(() => readStateText(l)).toThrow();
  });
});

describe('V18-AC-1 callers neither hang nor crash on a FIFO or a directory at their file', () => {
  // [label, file name, script that uses the lib and returns a JSON value, expected value]
  const CASES: Array<[string, string, string, unknown]> = [
    ['getCurrentTurn', 'turn.txt', `const t = await lib('file-tracker'); return t.getCurrentTurn('SID');`, 0],
    ['readLastAdvice', 'effort-advice.json', `const t = await lib('effort-advice'); return t.readLastAdvice('SID');`, null],
    ['readHabitState', 'habit-state.json', `const t = await lib('token-habits'); return t.readHabitState('SID');`, {}],
    ['readDispatchLog', 'dispatch-log.jsonl', `const t = await lib('spawn-guard'); return t.readDispatchLog('SID');`, []],
    ['getEditHistory', 'edits.jsonl', `const t = await lib('file-tracker'); return t.getEditHistory('SID');`, { files: [], firstEditAt: null }],
    ['readValidationFailure', '.goodboy-validation-failed.json', `const t = await lib('validation-state'); return t.readValidationFailure('SID');`, null],
    ['readSessionState', '.goodboy-session-state.json', `const t = await lib('session-state'); return t.readSessionState(process.cwd(), 'SID');`, null],
  ];

  for (const kind of ['fifo', 'directory'] as const) {
    for (const [label, name, script, want] of CASES) {
      test(`${label} with a ${kind} at ${name}`, async () => {
        const s = sandbox();
        const at = join(s.dir, name);
        if (kind === 'fifo') mkfifo(at);
        else mkdirSync(at);
        const r = await child(s.base, script.replaceAll('SID', s.sid));
        expect(r.stderr).toBe('');
        expect(r.killed).toBe(false);
        expect(r.result).toEqual(want as never);
      });
    }
  }

  test('incrementTurn replaces a FIFO or a directory at turn.txt with a counter', async () => {
    for (const kind of ['fifo', 'directory'] as const) {
      const s = sandbox();
      const at = join(s.dir, 'turn.txt');
      if (kind === 'fifo') mkfifo(at);
      else mkdirSync(at);
      const r = await child(s.base, `const t = await lib('file-tracker'); return t.incrementTurn(${JSON.stringify(s.sid)});`);
      expect([kind, r.killed, r.result]).toEqual([kind, false, 1]);
      expect(lstatSync(at).isFile()).toBe(true);
      expect(readFileSync(at, 'utf8')).toBe('1');
    }
  });

  test('an edit is recorded though a directory or a FIFO sits at edits.jsonl', async () => {
    for (const kind of ['fifo', 'directory'] as const) {
      const s = sandbox();
      const at = join(s.dir, 'edits.jsonl');
      if (kind === 'fifo') mkfifo(at);
      else mkdirSync(at);
      const r = await child(
        s.base,
        `const t = await lib('file-tracker'); t.recordEdit(${JSON.stringify(s.sid)}, ${JSON.stringify(join(s.cwd, 'a.ts'))}, 0); return t.getEditHistory(${JSON.stringify(s.sid)}).files;`,
      );
      expect([kind, r.killed]).toEqual([kind, false]);
      expect((r.result as string[]).length).toBe(1);
      expect(lstatSync(at).isFile()).toBe(true);
    }
  });

  test('a read log kept as a regular file still reads (the swap changes nothing for the normal case)', async () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'turn.txt'), '41\n');
    const r = await child(s.base, `const t = await lib('file-tracker'); return [t.getCurrentTurn(${JSON.stringify(s.sid)}), t.incrementTurn(${JSON.stringify(s.sid)})];`);
    expect(r.result).toEqual([41, 42]);
  });

  test('a turn counter file far over its cap is no counter (0), not read whole', async () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'turn.txt'), '7' + ' '.repeat(100));
    const r = await child(s.base, `const t = await lib('file-tracker'); return t.getCurrentTurn(${JSON.stringify(s.sid)});`);
    expect(r.result).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('V18-AC-2 turn.txt is guarded: it never goes down', () => {
  const seedTurn = (s: Box, n = '5') => writeFileSync(join(s.dir, 'turn.txt'), n);

  test('a call that lowers it: put back', () => {
    const s = sandbox();
    seedTurn(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    writeFileSync(join(s.dir, 'turn.txt'), '2');
    const restored = s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe('5');
    expect(restored).toContain('turn.txt');
  });

  test('a call that removes it: put back', () => {
    const s = sandbox();
    seedTurn(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    rmSync(join(s.dir, 'turn.txt'));
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_a'))).toContain('turn.txt');
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe('5');
  });

  test('a call that replaces it with a non-counter (text, empty, a number too large, a directory): put back', () => {
    for (const bad of ['abc', '', '5 6', '-3', '9'.repeat(30), 'dir'] as const) {
      const s = sandbox();
      seedTurn(s);
      s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
      const p = join(s.dir, 'turn.txt');
      rmSync(p);
      if (bad === 'dir') mkdirSync(p);
      else writeFileSync(p, bad);
      s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
      expect([bad, lstatSync(p).isFile(), readFileSync(p, 'utf8')]).toEqual([bad, true, '5']);
    }
  });

  test('a call that replaces it with a FIFO: put back, with no hang', async () => {
    const s = sandbox();
    seedTurn(s);
    await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_f', tool_input: { command: 'sh ./x.sh' } });
    rmSync(join(s.dir, 'turn.txt'));
    mkfifo(join(s.dir, 'turn.txt'));
    const post = await s.spawnHook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_f', tool_input: { command: 'sh ./x.sh' }, tool_response: {} });
    expect(post.killed).toBe(false);
    expect(lstatSync(join(s.dir, 'turn.txt')).isFile()).toBe(true);
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe('5');
  });

  test('a higher value stands, and an unchanged counter is not reported', () => {
    const s = sandbox();
    seedTurn(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    writeFileSync(join(s.dir, 'turn.txt'), '6');
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_a'))).not.toContain('turn.txt');
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe('6');

    s.inProcess(() => snapshotGateState(s.sid, 'toolu_b'));
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_b'))).toEqual([]);
  });

  test("the Stop's own increment between the snapshot and the restore is not undone", () => {
    const s = sandbox();
    seedTurn(s, '5');
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a')); // a call never reports back
    writeFileSync(join(s.dir, 'turn.txt'), '6'); // the Stop's increment, which runs before the orphan restore
    const restored = s.inProcess(() => restoreOrphanGateState(s.sid));
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe('6');
    expect(restored).not.toContain('turn.txt');
  });

  test('a turn.txt the call created is removed when it is no counter, and stays when it is one', () => {
    const s = sandbox();
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a')); // none at the snapshot
    writeFileSync(join(s.dir, 'turn.txt'), 'forged');
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_a'))).toContain('turn.txt');
    expect(existsSync(join(s.dir, 'turn.txt'))).toBe(false);

    s.inProcess(() => snapshotGateState(s.sid, 'toolu_b'));
    writeFileSync(join(s.dir, 'turn.txt'), '3');
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_b'))).not.toContain('turn.txt');
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe('3');
  });

  test('through the hooks: a Bash call that lowers it is put back by its post hook', async () => {
    const s = sandbox();
    seedTurn(s, '7');
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_h1', tool_input: { command: 'sh ./lower.sh' } });
    writeFileSync(join(s.dir, 'turn.txt'), '0');
    const post = await s.spawnHook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_h1', tool_input: { command: 'sh ./lower.sh' }, tool_response: {} });
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe('7');
    expect(post.context).toContain('turn.txt');
  });

  test('through the Stop: a call that never reported back and lowered it; the Stop counts on from the old value', async () => {
    const s = sandbox();
    seedTurn(s, '7');
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_h2', tool_input: { command: 'sh ./lower.sh; exit 1' } });
    writeFileSync(join(s.dir, 'turn.txt'), '0');
    // The Stop reads the counter before it restores: it increments what it finds (1), and the restore then
    // keeps the counter from staying below the snapshot's 7 (a lowered counter put later edits before the cursor).
    const stop = await s.spawnHook('stop', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(stop.killed).toBe(false);
    expect(Number(readFileSync(join(s.dir, 'turn.txt'), 'utf8'))).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------------------------
describe('V18-AC-3 a guarded name a call created as no regular file is removed', () => {
  test('a directory at edits.jsonl made before the first edit', () => {
    const s = sandbox();
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a')); // no edit log yet
    mkdirSync(join(s.dir, 'edits.jsonl'));
    writeFileSync(join(s.dir, 'edits.jsonl', 'inner'), 'x');
    const restored = s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(restored).toContain('edits.jsonl');
    expect(existsSync(join(s.dir, 'edits.jsonl'))).toBe(false);
  });

  test('a FIFO at a guarded log the call created: removed after, with no hang', async () => {
    const s = sandbox();
    await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_b', tool_input: { command: 'sh ./x.sh' } });
    mkfifo(join(s.dir, 'edits.jsonl'));
    mkfifo(join(s.dir, 'dispatch-log.jsonl'));
    const post = await s.spawnHook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_b', tool_input: { command: 'sh ./x.sh' }, tool_response: {} });
    expect(post.killed).toBe(false);
    expect(existsSync(join(s.dir, 'edits.jsonl'))).toBe(false);
    expect(existsSync(join(s.dir, 'dispatch-log.jsonl'))).toBe(false);
    expect(post.context).toContain('put back its gate state');
  });

  test('the next edit is then recorded (the directory no longer blocks the log)', async () => {
    const s = sandbox();
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    mkdirSync(join(s.dir, 'edits.jsonl'));
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    const r = await child(s.base, `const t = await lib('file-tracker'); t.recordEdit(${JSON.stringify(s.sid)}, ${JSON.stringify(join(s.cwd, 'a.ts'))}, 0); return t.getEditHistory(${JSON.stringify(s.sid)}).files.length;`);
    expect(r.result).toBe(1);
  });

  test('a plain edit log the call created (a hook wrote the first edit during it) stays', () => {
    const s = sandbox();
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_a'))).not.toContain('edits.jsonl');
    expect(readFileSync(join(s.dir, 'edits.jsonl'), 'utf8')).toBe(`${s.line}\n`);
  });

  test('a directory that replaced an existing edit log: the log is put back', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    rmSync(join(s.dir, 'edits.jsonl'));
    mkdirSync(join(s.dir, 'edits.jsonl'));
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(lstatSync(join(s.dir, 'edits.jsonl')).isFile()).toBe(true);
    expect(readFileSync(join(s.dir, 'edits.jsonl'), 'utf8')).toBe(`${s.line}\n`);
  });

  test('a link at a guarded name the call created is removed too', () => {
    const s = sandbox();
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    symlinkSync('/etc/hosts', join(s.dir, 'edits.jsonl'));
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(existsSync(join(s.dir, 'edits.jsonl'))).toBe(false);
    expect(lstatSync(join(s.dir, '..')).isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('V18-AC-4 the snapshot index is sealed', () => {
  const CURSOR = '.goodboy-last-review-0123456789ab.json';
  const FORGED_CURSOR = '.goodboy-last-test-fedcba987654.json';
  const HOOK_ONLY = 'coverage-pin.json';

  function seed(s: Box): string {
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    writeFileSync(join(s.dir, 'judged-weakened.json'), '{"keep":true}');
    writeFileSync(join(s.dir, CURSOR), '{"turn":1}');
    writeFileSync(join(s.dir, 'turn.txt'), '5');
    return join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`);
  }

  /** What a call does that the guard exists to undo. */
  function attack(s: Box): void {
    writeFileSync(join(s.dir, 'edits.jsonl'), '');
    rmSync(join(s.dir, 'judged-weakened.json'));
    writeFileSync(join(s.dir, FORGED_CURSOR), '{"turn":99}');
    writeFileSync(join(s.dir, HOOK_ONLY), '{"forged":true}');
  }

  const indexOf = (snap: string): Record<string, unknown> => JSON.parse(readFileSync(join(snap, '.index.json'), 'utf8')) as Record<string, unknown>;
  const setIndex = (snap: string, patch: Record<string, unknown>) => writeFileSync(join(snap, '.index.json'), JSON.stringify({ ...indexOf(snap), ...patch }));
  /** An index the attacker rewrote to believe what it wants: no files to put back, forged files "existed". */
  const lie = (snap: string) => {
    const idx = indexOf(snap);
    setIndex(snap, { names: [], sums: [], present: [...(idx.present as string[]), FORGED_CURSOR, HOOK_ONLY] });
  };

  /** The untrusted restore (v0.36.18 review rule): the edit log keeps its lines plus the copy's; every cursor and
   *  evidence log now there is taken for forged and removed (the gates ask again); a hook-only file stays (a missing
   *  pin makes the gates skip what they compare with it), and one the call removed comes back from the copy. */
  function expectFailClosed(s: Box): void {
    expect(readFileSync(join(s.dir, 'edits.jsonl'), 'utf8')).toContain(s.line); // the log keeps its lines plus the copy's
    expect(readFileSync(join(s.dir, 'judged-weakened.json'), 'utf8')).toBe('{"keep":true}'); // removed by the call: back
    expect(existsSync(join(s.dir, FORGED_CURSOR))).toBe(false);
    expect(existsSync(join(s.dir, HOOK_ONLY))).toBe(true); // a pin the call made is left (a removed pin fails open)
    expect(existsSync(join(s.dir, CURSOR))).toBe(false); // even the cursor that existed: nothing is believed
  }

  test('a genuine index restores as before', () => {
    const s = sandbox();
    const snap = seed(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    expect(indexOf(snap).seal).toMatch(/^[0-9a-f]{64}$/);
    attack(s);
    const restored = s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    // trusted: the files put back, what the call created removed, what existed and was not touched stays
    expect(readFileSync(join(s.dir, 'edits.jsonl'), 'utf8')).toContain(s.line);
    expect(readFileSync(join(s.dir, 'judged-weakened.json'), 'utf8')).toBe('{"keep":true}');
    expect(existsSync(join(s.dir, FORGED_CURSOR))).toBe(false);
    expect(existsSync(join(s.dir, HOOK_ONLY))).toBe(false);
    expect(existsSync(join(s.dir, CURSOR))).toBe(true);
    expect(restored.sort()).toEqual(['edits.jsonl', 'judged-weakened.json', FORGED_CURSOR, HOOK_ONLY].sort());
    expect(existsSync(snap)).toBe(false); // the snapshot dir goes with the restore
  });

  test('a genuine index also keeps a hook-only file that already existed, and a skill-gap note the call added', () => {
    const s = sandbox();
    const snap = seed(s);
    writeFileSync(join(s.dir, 'skill-evidence.jsonl'), '{"k":"skill","n":1}\n');
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    writeFileSync(join(s.dir, 'skill-evidence.jsonl'), '{"k":"skill","n":1}\n{"k":"skill","n":99}\n{"k":"skill-gap","n":2}\n');
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(readFileSync(join(s.dir, 'skill-evidence.jsonl'), 'utf8')).toBe('{"k":"skill","n":1}\n{"k":"skill-gap","n":2}\n');
    expect(existsSync(snap)).toBe(false);
  });

  const TAMPERS: Array<[string, (s: Box, snap: string) => void]> = [
    ['a forged index (names and present rewritten, the seal kept)', (_s, snap) => lie(snap)],
    ['a forged index with no seal', (_s, snap) => {
      lie(snap);
      const idx = indexOf(snap);
      delete idx.seal;
      writeFileSync(join(snap, '.index.json'), JSON.stringify(idx));
    }],
    ['a forged index with a made-up seal', (_s, snap) => {
      lie(snap);
      setIndex(snap, { seal: 'ab'.repeat(32) });
    }],
    ['an index of another call (an id that is not this call)', (_s, snap) => {
      lie(snap);
      setIndex(snap, { id: 'toolu_other' });
    }],
    ['an index that is not JSON', (_s, snap) => writeFileSync(join(snap, '.index.json'), '{not json')],
    ['an index of the wrong shape (names not strings)', (_s, snap) => setIndex(snap, { names: [1, 2], present: [FORGED_CURSOR] })],
    ['a missing index', (_s, snap) => rmSync(join(snap, '.index.json'))],
    ['an index replaced by a directory', (_s, snap) => {
      rmSync(join(snap, '.index.json'));
      mkdirSync(join(snap, '.index.json'));
    }],
    ['a tampered snapshot copy (the index lists the forged names)', (_s, snap) => {
      lie(snap);
      writeFileSync(join(snap, 'judged-weakened.json'), '{"keep":true}'); // same content: only the index lies
      writeFileSync(join(snap, CURSOR), '{"turn":1}');
    }],
  ];

  for (const [label, tamper] of TAMPERS) {
    test(`${label}: the restore is fail closed`, () => {
      const s = sandbox();
      const snap = seed(s);
      s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
      tamper(s, snap);
      attack(s);
      s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
      expectFailClosed(s);
    });
  }

  test('a genuine index of another call, copied in (its own seal is valid): not this call’s, so untrusted', () => {
    const s = sandbox();
    seed(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_b')); // the same state: same names, copies and sums
    const snapA = join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`);
    const snapB = join(s.dir, `bash-guard-${safeToolUseId('toolu_b')}`);
    writeFileSync(join(snapB, '.index.json'), readFileSync(join(snapA, '.index.json'), 'utf8'));
    attack(s);
    s.inProcess(() => restoreGateState(s.sid, 'toolu_b'));
    expect(existsSync(join(s.dir, CURSOR))).toBe(false); // untrusted: even the old cursor goes
    expect(existsSync(join(s.dir, FORGED_CURSOR))).toBe(false);
  });

  test('a tampered snapshot copy with the index intact: the edit log takes its lines (a union only adds); cursors are removed', () => {
    const s = sandbox();
    const snap = seed(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const extra = '{"file":"/extra","turn":0,"timestamp":"2020-01-01T00:00:00.000Z"}';
    writeFileSync(join(snap, 'edits.jsonl'), `${s.line}\n${extra}\n`);
    writeFileSync(join(snap, 'judged-weakened.json'), '{"keep":"planted"}');
    attack(s);
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    const edits = readFileSync(join(s.dir, 'edits.jsonl'), 'utf8');
    expect(edits).toContain(s.line);
    expect(edits).toContain(extra);
    expect(existsSync(join(s.dir, FORGED_CURSOR))).toBe(false);
    expect(existsSync(join(s.dir, CURSOR))).toBe(false);
    expect(existsSync(join(s.dir, HOOK_ONLY))).toBe(true); // hook-only files stay
  });

  // What a trusted index adds over the dir's own files: a guarded name that existed at the snapshot but was never
  // copied (here a directory) is "what the call did not create" and stays; with no trusted index the only list is
  // the copies, so it counts as created and goes. This separates the two paths by what the restore does.
  test('a trusted index leaves a non-regular guarded name that existed at the snapshot; a changed copy makes the restore remove it', () => {
    const trusted = sandbox();
    seed(trusted);
    mkdirSync(join(trusted.dir, 'dispatch-log.jsonl'));
    trusted.inProcess(() => snapshotGateState(trusted.sid, 'toolu_a'));
    trusted.inProcess(() => restoreGateState(trusted.sid, 'toolu_a'));
    expect(lstatSync(join(trusted.dir, 'dispatch-log.jsonl')).isDirectory()).toBe(true);

    const changed = sandbox();
    const snap = seed(changed);
    mkdirSync(join(changed.dir, 'dispatch-log.jsonl'));
    changed.inProcess(() => snapshotGateState(changed.sid, 'toolu_a'));
    writeFileSync(join(snap, 'judged-weakened.json'), '{"keep":"changed"}'); // the index is intact, a copy is not
    changed.inProcess(() => restoreGateState(changed.sid, 'toolu_a'));
    expect(existsSync(join(changed.dir, 'dispatch-log.jsonl'))).toBe(false);
  });

  test('a snapshot copy that is gone with the index lying: what is left is put back, the rest fails closed', () => {
    const s = sandbox();
    const snap = seed(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    lie(snap);
    rmSync(join(snap, 'judged-weakened.json'));
    attack(s);
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(readFileSync(join(s.dir, 'edits.jsonl'), 'utf8')).toContain(s.line);
    expect(existsSync(join(s.dir, FORGED_CURSOR))).toBe(false);
    expect(existsSync(join(s.dir, 'judged-weakened.json'))).toBe(false); // no copy left to put back
  });

  test('a missing key at the restore (deleted, replaced by another key, a link, a directory): fail closed', () => {
    const variants: Array<(s: Box) => void> = [
      (s) => rmSync(s.key),
      (s) => writeFileSync(s.key, 'cd'.repeat(32)),
      (s) => {
        const real = join(s.base, 'real-key');
        writeFileSync(real, readFileSync(s.key, 'utf8'));
        rmSync(s.key);
        symlinkSync(real, s.key);
      },
      (s) => {
        rmSync(s.key);
        mkdirSync(s.key);
      },
      (s) => writeFileSync(s.key, 'not hex'),
      (s) => chmodSync(s.key, 0o644), // the right key, readable by others: not used
      (s) => chmodSync(s.key, 0o660),
    ];
    for (const [i, vary] of variants.entries()) {
      const s = sandbox();
      const snap = seed(s);
      s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
      lie(snap);
      vary(s);
      attack(s);
      s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
      try {
        expectFailClosed(s);
      } catch (e) {
        throw new Error(`key variant ${i}: ${(e as Error).message}`);
      }
    }
  });

  // The key lives in the session dir, where a snapshot can always make one: a bad entry at its path (even a non-empty
  // directory) is removed and a good key made, so a snapshot is always sealed.
  test('a directory at the key path is replaced by a good key: the snapshot is sealed', () => {
    const s = sandbox();
    const snap = seed(s);
    mkdirSync(join(s.key, 'x'), { recursive: true }); // a non-empty directory
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    expect(indexOf(snap).seal).toMatch(/^[0-9a-f]{64}$/);
    expect(lstatSync(s.key).isFile()).toBe(true);
    attack(s);
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(readFileSync(join(s.dir, 'judged-weakened.json'), 'utf8')).toBe('{"keep":true}'); // trusted
    expect(existsSync(join(s.dir, CURSOR))).toBe(true); // the cursor that existed stays: a trusted restore
  });

  // An unsealed index is never trusted (no legacy path, whatever a note says): the attacker removes the seal and the
  // restore treats the snapshot as untrusted, so even a cursor that existed goes.
  test('an unsealed index is always untrusted', () => {
    const s = sandbox();
    const snap = seed(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const idx = indexOf(snap);
    delete idx.seal;
    writeFileSync(join(snap, '.index.json'), JSON.stringify(idx));
    attack(s);
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(existsSync(join(s.dir, CURSOR))).toBe(false);
    expect(existsSync(join(s.dir, FORGED_CURSOR))).toBe(false);
  });

  test('a notes dir that is a link is never written, listed or emptied: the files it points to stay', () => {
    const s = sandbox();
    seed(s);
    const elsewhere = join(s.base, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'toolu_victim'), 'keep me');
    symlinkSync(elsewhere, join(s.dir, '.seal-notes'));
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    expect(readdirSync(elsewhere)).toEqual(['toolu_victim']); // nothing written through the link
    s.inProcess(() => restoreOrphanGateState(s.sid)); // lists no note through the link, removes nothing
    expect(readFileSync(join(elsewhere, 'toolu_victim'), 'utf8')).toBe('keep me');
    expect(readdirSync(elsewhere)).toEqual(['toolu_victim']);
    // the snapshot itself was still taken, and the post-hook restore still works (it needs no note)
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_a'))).toEqual([]);
    expect(readFileSync(join(elsewhere, 'toolu_victim'), 'utf8')).toBe('keep me');
  });

  test('the orphan restore lists only plain note files with plain names', () => {
    const s = sandbox();
    seed(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const notes = join(s.dir, '.seal-notes');
    mkdirSync(join(notes, 'a-dir')); // a directory is no note
    writeFileSync(join(notes, 'bad name.x'), ''); // a name outside [A-Za-z0-9_-]
    rmSync(join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`), { recursive: true, force: true });
    writeFileSync(join(s.dir, CURSOR.replace('0123', '4567')), '{"turn":5}');
    s.inProcess(() => restoreOrphanGateState(s.sid));
    expect(existsSync(join(notes, 'a-dir'))).toBe(true);
    expect(existsSync(join(notes, 'bad name.x'))).toBe(true);
    expect(existsSync(join(notes, 'toolu_a'))).toBe(false); // the real note was handled
  });

  test('a hook-only file the call removed comes back from an untrusted copy, one it made is left, a cursor goes', () => {
    const s = sandbox();
    const snap = seed(s);
    writeFileSync(join(s.dir, 'start-tips.json'), '{"real":true}');
    writeFileSync(join(s.dir, 'coverage-pin.json'), '{"pin":1}');
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    rmSync(join(snap, '.index.json'));
    rmSync(join(s.dir, 'coverage-pin.json'));
    writeFileSync(join(s.dir, 'criteria-pin.json'), '{"made":1}');
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(readFileSync(join(s.dir, 'start-tips.json'), 'utf8')).toBe('{"real":true}'); // kept
    expect(readFileSync(join(s.dir, 'coverage-pin.json'), 'utf8')).toBe('{"pin":1}'); // removed by the call: back
    expect(existsSync(join(s.dir, 'criteria-pin.json'))).toBe(true); // made by the call: left (a removed pin fails open)
    expect(existsSync(join(s.dir, CURSOR))).toBe(false);
  });

  test('the key file: made by the snapshot in the session dir, 32 random bytes in hex, mode 0600, no temp left, reused, never copied', () => {
    const s = sandbox();
    seed(s);
    expect(existsSync(s.key)).toBe(false);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const st = statSync(s.key);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    const key = readFileSync(s.key, 'utf8');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    // under the session dir name (the write gates cover it), and nothing of it in $TMPDIR itself
    expect(resolve(s.key).startsWith(s.dir)).toBe(true);
    expect(readdirSync(s.base).filter((n) => n.includes('session-key') || n.includes('session-seals'))).toEqual([]);
    expect(readdirSync(s.dir).filter((n) => n.startsWith(`${basename(s.key)}.`))).toEqual([]); // no temp left
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_b'));
    expect(readFileSync(s.key, 'utf8')).toBe(key);
    expect(statSync(s.key).mode & 0o777).toBe(0o600);
    // the key is no guarded name: a snapshot never holds a copy of it
    expect(readdirSync(join(s.dir, `bash-guard-${safeToolUseId('toolu_b')}`))).not.toContain('.seal-key');
  });

  test('a key file that is a link or has a wrong mode is not used: the next snapshot replaces it with a good key of its own', () => {
    for (const bad of ['link', 'mode-644', 'junk'] as const) {
      const s = sandbox();
      const snap = seed(s);
      const real = join(s.base, 'real-key');
      const planted = 'ab'.repeat(32);
      if (bad === 'link') {
        writeFileSync(real, planted, { mode: 0o600 });
        symlinkSync(real, s.key);
      } else if (bad === 'mode-644') {
        writeFileSync(s.key, planted);
        chmodSync(s.key, 0o644);
      } else {
        writeFileSync(s.key, 'not a key', { mode: 0o600 });
      }
      s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
      expect([bad, indexOf(snap).seal]).toEqual([bad, expect.stringMatching(/^[0-9a-f]{64}$/)]);
      const st = lstatSync(s.key);
      expect([bad, st.isFile(), st.mode & 0o777]).toEqual([bad, true, 0o600]);
      expect([bad, readFileSync(s.key, 'utf8')]).not.toEqual([bad, planted]); // the planted key is gone
      if (bad === 'link') expect(readFileSync(real, 'utf8')).toBe(planted); // the link's target is left alone
      // and the sealed snapshot then restores as a trusted one
      attack(s);
      s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
      expect([bad, readFileSync(join(s.dir, 'judged-weakened.json'), 'utf8')]).toEqual([bad, '{"keep":true}']);
    }
  });

  test('through the hooks: the key is made by the pre hook with mode 0600, and a forged index is not believed by the post hook', async () => {
    const s = sandbox();
    seed(s);
    const snap = join(s.dir, `bash-guard-${safeToolUseId('toolu_hk')}`);
    await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_hk', tool_input: { command: 'sh ./x.sh' } });
    expect(statSync(s.key).mode & 0o777).toBe(0o600);
    lie(snap);
    attack(s);
    const post = await s.spawnHook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_hk', tool_input: { command: 'sh ./x.sh' }, tool_response: {} });
    expectFailClosed(s);
    expect(post.context).toContain('put back its gate state');
  });

  test('a snapshot taken again for the same call starts from an empty dir (no copy of a file since gone)', () => {
    const s = sandbox();
    const snap = seed(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    expect(existsSync(join(snap, 'judged-weakened.json'))).toBe(true);
    rmSync(join(s.dir, 'judged-weakened.json'));
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    expect(existsSync(join(snap, 'judged-weakened.json'))).toBe(false);
    expect(indexOf(snap).names as string[]).not.toContain('judged-weakened.json');
  });
});

describe('V18-AC-4 the key file and the notes are under the session dir name write gates', () => {
  test('a Bash command that writes it is a gate-state write', () => {
    for (const c of [
      'echo x > "$TMPDIR/goodboy-session-abc/.seal-key"',
      'echo deadbeef > /tmp/goodboy-session-abc/.seal-key',
      'rm -f /tmp/goodboy-session-*/.seal-key',
      'cp /tmp/evil /tmp/goodboy-session-abc/.seal-key',
      'mv /tmp/evil "$TMPDIR/goodboy-session-abc/.seal-key"',
      'chmod 666 /tmp/goodboy-session-abc/.seal-key',
      'printf %s abc | tee /tmp/goodboy-session-abc/.seal-key',
      'rm -rf /tmp/goodboy-session-abc/.seal-notes',
      ': > /var/folders/ab/T/goodboy-session-abc/.seal-notes/toolu_x',
    ]) {
      expect([c, writesGateState(c)]).toEqual([c, true]);
    }
  });

  test('an unrelated command and a different file name are not', () => {
    for (const c of ['echo x > /tmp/other-key', 'rm -f notes.txt', 'ls /tmp', 'rm config/session-key.yml', 'rm -f app/session-keys.json']) {
      expect([c, writesGateState(c)]).toEqual([c, false]);
    }
  });

  test('through PreToolUse: the write is denied up front', async () => {
    const s = sandbox();
    const r = await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_k', tool_input: { command: `echo 00 > ${s.key}` } });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain("goodboy's own session state");
  });
});

// ---------------------------------------------------------------------------------------------
describe('V18-AC-5 (#12 part 2) a Stop while a Bash call is still open keeps its snapshot', () => {
  const RUNNING = [{ id: 'a1', type: 'subagent', status: 'running', agent_type: 'goodboy:build-backend' }];

  async function openCall(s: Box, tuid: string) {
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    writeFileSync(join(s.dir, 'turn.txt'), '2');
    const pre = await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: tuid, agent_id: 'x1', agent_type: 'general-purpose', tool_input: { command: 'sh ./slow.sh' } });
    expect(pre.denied).toBe(false);
    return join(s.dir, `bash-guard-${safeToolUseId(tuid)}`);
  }

  test('the snapshot survives the Stop; what the call changes later is put back by its own post hook', async () => {
    const s = sandbox();
    const snap = await openCall(s, 'toolu_run');
    expect(existsSync(snap)).toBe(true);

    const stop = await s.spawnHook('stop', { hook_event_name: 'Stop', background_tasks: RUNNING }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(stop.killed).toBe(false);
    expect(existsSync(snap)).toBe(true); // kept for the call's own post hook
    expect(JSON.stringify(stop.raw)).not.toContain('되돌렸어요'); // the Stop restored nothing

    // what the still running call does later
    writeFileSync(join(s.dir, 'edits.jsonl'), '');
    writeFileSync(join(s.dir, '.goodboy-last-review-0123456789ab.json'), '{"turn":99}');
    const post = await s.spawnHook('post-tool-use', {
      tool_name: 'Bash',
      tool_use_id: 'toolu_run',
      agent_id: 'x1',
      agent_type: 'general-purpose',
      tool_input: { command: 'sh ./slow.sh' },
      tool_response: {},
    });
    expect(post.killed).toBe(false);
    expect(readFileSync(join(s.dir, 'edits.jsonl'), 'utf8')).toContain(s.line);
    expect(existsSync(join(s.dir, '.goodboy-last-review-0123456789ab.json'))).toBe(false);
    expect(post.context).toContain('put back its gate state');
    expect(existsSync(snap)).toBe(false);
  });

  test('the call own post hook cannot lower the counter the Stop incremented (the snapshot was taken after the increment)', async () => {
    const s = sandbox();
    await openCall(s, 'toolu_run2'); // turn.txt holds 2 at the first snapshot
    await s.spawnHook('stop', { hook_event_name: 'Stop', background_tasks: RUNNING }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    const turnAfterStop = readFileSync(join(s.dir, 'turn.txt'), 'utf8');
    expect(Number(turnAfterStop)).toBeGreaterThanOrEqual(3); // the Stop's own increment
    writeFileSync(join(s.dir, 'turn.txt'), '0');
    await s.spawnHook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_run2', agent_id: 'x1', agent_type: 'general-purpose', tool_input: { command: 'sh ./slow.sh' }, tool_response: {} });
    expect(readFileSync(join(s.dir, 'turn.txt'), 'utf8')).toBe(turnAfterStop); // not the 0, not the 2 of the first snapshot
  });

  test('without a running agent the same call is closed at the Stop: its snapshot is restored and gone', async () => {
    const s = sandbox();
    const snap = await openCall(s, 'toolu_gone');
    writeFileSync(join(s.dir, 'edits.jsonl'), '');
    const stop = await s.spawnHook('stop', { hook_event_name: 'Stop', background_tasks: [] }, { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' });
    expect(stop.killed).toBe(false);
    expect(existsSync(snap)).toBe(false);
    expect(readFileSync(join(s.dir, 'edits.jsonl'), 'utf8')).toContain(s.line);
  });

  test('restoreOrphanGateState keeps only the snapshots of the calls it is told are open', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    s.inProcess(() => {
      snapshotGateState(s.sid, 'toolu_open');
      snapshotGateState(s.sid, 'toolu_orphan');
    });
    writeFileSync(join(s.dir, 'edits.jsonl'), '');
    const restored = s.inProcess(() => restoreOrphanGateState(s.sid, ['toolu_open']));
    expect(restored).toContain('edits.jsonl');
    expect(existsSync(join(s.dir, `bash-guard-${safeToolUseId('toolu_open')}`))).toBe(true);
    expect(existsSync(join(s.dir, `bash-guard-${safeToolUseId('toolu_orphan')}`))).toBe(false);
    // the kept one still restores for its own post hook
    writeFileSync(join(s.dir, 'edits.jsonl'), '');
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_open'))).toContain('edits.jsonl');
  });
});

// ---------------------------------------------------------------------------------------------
// The untrusted restore and the seal notes (v0.36.18 review fixes, plan §15.34 item 1 "As built").
describe('V18-AC-4 the untrusted restore writes no copy back and removes what it cannot believe', () => {
  const CURSOR = '.goodboy-last-review-0123456789ab.json';
  const FORGED_CURSOR = '.goodboy-last-test-fedcba987654.json';
  const notesOf = (s: Box): string => join(s.dir, '.seal-notes');
  const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
  const snapOf = (s: Box, id = 'toolu_a'): string => join(s.dir, `bash-guard-${safeToolUseId(id)}`);

  /** The index and the note gone with it: what a call that deletes the index leaves. */
  function untrusted(s: Box, id = 'toolu_a'): string {
    const snap = snapOf(s, id);
    rmSync(join(snap, '.index.json'));
    return snap;
  }
  const take = (s: Box, id = 'toolu_a') => s.inProcess(() => snapshotGateState(s.sid, id));
  const restore = (s: Box, id = 'toolu_a') => s.inProcess(() => restoreGateState(s.sid, id));
  const read = (s: Box, name: string): string => readFileSync(join(s.dir, name), 'utf8');

  test('planted copies of a cursor and an evidence log are never written', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    writeFileSync(join(s.dir, 'turn.txt'), '5');
    take(s);
    const snap = untrusted(s);
    writeFileSync(join(snap, CURSOR), '{"turn":99}');
    writeFileSync(join(snap, 'skill-evidence.jsonl'), '{"k":"skill","s":"forged"}\n');
    writeFileSync(join(snap, 'marker-evidence.jsonl'), '{"k":"marker"}\n');
    writeFileSync(join(s.dir, 'edits.jsonl'), '');
    restore(s);
    for (const n of [CURSOR, 'skill-evidence.jsonl', 'marker-evidence.jsonl']) {
      expect([n, existsSync(join(s.dir, n))]).toEqual([n, false]);
    }
    expect(read(s, 'edits.jsonl')).toContain(s.line); // the edit log's copy joins what is there
  });

  test('every cursor and evidence log now present is removed (an evidence log keeping only skill-gap lines); hook-only files stay', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'skill-evidence.jsonl'), '{"k":"skill","n":1}\n');
    writeFileSync(join(s.dir, 'marker-evidence.jsonl'), '{"k":"marker","n":1}\n');
    writeFileSync(join(s.dir, CURSOR), '{"turn":1}');
    writeFileSync(join(s.dir, 'judged-weakened.json'), '{"a":1}');
    writeFileSync(join(s.dir, 'start-tips.json'), '{}');
    take(s);
    untrusted(s);
    writeFileSync(join(s.dir, 'skill-evidence.jsonl'), '{"k":"skill","n":1}\n{"k":"skill","n":2}\n{"k":"skill-gap","n":3}\n');
    const restored = restore(s);
    expect(read(s, 'skill-evidence.jsonl')).toBe('{"k":"skill-gap","n":3}\n');
    for (const n of ['marker-evidence.jsonl', CURSOR]) {
      expect([n, existsSync(join(s.dir, n))]).toEqual([n, false]);
    }
    for (const n of ['judged-weakened.json', 'start-tips.json']) {
      expect([n, existsSync(join(s.dir, n))]).toEqual([n, true]); // a removed pin would fail the gates open
    }
    expect(restored).toContain('skill-evidence.jsonl');
  });

  test('the dispatch log keeps its own lines: neither the copy’s nor a lost line comes back', () => {
    const s = sandbox();
    const d1 = JSON.stringify({ k: 'launched', t: 1, tuid: 'a', agentId: 'x' });
    const d2 = JSON.stringify({ k: 'launched', t: 2, tuid: 'b', agentId: 'y' });
    writeFileSync(join(s.dir, 'dispatch-log.jsonl'), `${d1}\n`);
    take(s);
    const snap = untrusted(s);
    writeFileSync(join(snap, 'dispatch-log.jsonl'), `${d1}\n${d2}\n`); // planted
    restore(s);
    expect(read(s, 'dispatch-log.jsonl')).toBe(`${d1}\n`);
    // and a call that emptied it leaves it emptied (its copy is not believed)
    const t = sandbox();
    writeFileSync(join(t.dir, 'dispatch-log.jsonl'), `${d1}\n`);
    take(t);
    untrusted(t);
    writeFileSync(join(t.dir, 'dispatch-log.jsonl'), '');
    restore(t);
    expect(read(t, 'dispatch-log.jsonl')).toBe('');
  });

  test('the edit and unswept logs keep their lines plus the copy’s', () => {
    const s = sandbox();
    const l2 = JSON.stringify({ file: join(s.cwd, 'b.ts'), turn: 1, timestamp: new Date().toISOString() });
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    writeFileSync(join(s.dir, 'unswept.jsonl'), '{"u":1}\n');
    take(s);
    untrusted(s);
    writeFileSync(join(s.dir, 'edits.jsonl'), `${l2}\n`); // replaced by a call
    writeFileSync(join(s.dir, 'unswept.jsonl'), '{"u":2}\n');
    restore(s);
    expect(read(s, 'edits.jsonl')).toBe(`${s.line}\n${l2}\n`);
    expect(read(s, 'unswept.jsonl')).toBe('{"u":1}\n{"u":2}\n');
  });

  test('turn.txt takes the highest valid value of the copy, the file and the edit log, never lower', () => {
    // [copy, file, edit-log turn, expected]
    const cases: Array<[string | null, string | null, number, string | null]> = [
      ['5', '3', 0, '5'], // a lowered file: back to the copy's
      ['5', '7', 0, '7'], // the Stop's increment stands
      ['5', 'junk', 9, '9'], // no counter in the file: the edit log's highest turn
      ['5', null, 0, '5'], // removed
      ['5', '9'.repeat(15), 4, '5'], // 15 digits is no counter
      ['junk', '2', 6, '6'], // a copy that is no counter counts for nothing
    ];
    for (const [copy, file, floor, want] of cases) {
      const s = sandbox();
      writeFileSync(join(s.dir, 'edits.jsonl'), `${JSON.stringify({ file: join(s.cwd, 'a.ts'), turn: floor, timestamp: new Date().toISOString() })}\n`);
      if (copy !== null) writeFileSync(join(s.dir, 'turn.txt'), copy);
      take(s);
      untrusted(s);
      if (file === null) rmSync(join(s.dir, 'turn.txt'), { force: true });
      else writeFileSync(join(s.dir, 'turn.txt'), file);
      restore(s);
      expect([copy, file, floor, existsSync(join(s.dir, 'turn.txt')) ? read(s, 'turn.txt') : null]).toEqual([copy, file, floor, want]);
    }
  });

  test('a lost validation failure comes back; one that is there is left as it is', () => {
    const lost = sandbox();
    writeFileSync(join(lost.dir, '.goodboy-validation-failed.json'), '{"failed":true}');
    take(lost);
    untrusted(lost);
    rmSync(join(lost.dir, '.goodboy-validation-failed.json'));
    restore(lost);
    expect(read(lost, '.goodboy-validation-failed.json')).toBe('{"failed":true}');

    const kept = sandbox();
    writeFileSync(join(kept.dir, '.goodboy-validation-failed.json'), '{"failed":true}');
    take(kept);
    const snap = untrusted(kept);
    writeFileSync(join(kept.dir, '.goodboy-validation-failed.json'), '{"failed":"changed"}');
    writeFileSync(join(snap, '.goodboy-validation-failed.json'), '{"failed":"planted"}');
    restore(kept);
    expect(read(kept, '.goodboy-validation-failed.json')).toBe('{"failed":"changed"}');
  });

  test('a sealed index that names ../x is not trusted: nothing is written outside the session dir', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    writeFileSync(join(s.dir, 'judged-weakened.json'), '{"keep":true}');
    take(s);
    const snap = snapOf(s);
    const key = readFileSync(s.key, 'utf8').trim();
    const idx = JSON.parse(readFileSync(join(snap, '.index.json'), 'utf8')) as { id: string; names: string[]; present: string[]; sums: string[] };
    writeFileSync(join(s.dir, 'x'), 'evil'); // what join(snap, '../x') reads
    const body = { id: idx.id, names: [...idx.names, '../x'], present: [...idx.present, '../x'], sums: [...idx.sums, sha('evil')] };
    const seal = createHmac('sha256', key).update(JSON.stringify([body.id, body.names, body.present, body.sums])).digest('hex');
    writeFileSync(join(snap, '.index.json'), JSON.stringify({ t: Date.now(), ...body, seal }));
    writeFileSync(join(s.dir, 'edits.jsonl'), '');
    rmSync(join(s.dir, 'judged-weakened.json'));
    restore(s);
    expect(existsSync(join(s.base, 'x'))).toBe(false); // join(session dir, '../x')
    expect(read(s, 'judged-weakened.json')).toBe('{"keep":true}'); // untrusted: a pin the call removed comes back from the copy
    expect(read(s, 'edits.jsonl')).toContain(s.line);
  });

  test('a snapshot leaves an empty note outside its dir (in the session dir’s .seal-notes), mode 0600, and the restore removes it', () => {
    const s = sandbox();
    take(s);
    const note = join(notesOf(s), 'toolu_a');
    expect(statSync(note).isFile()).toBe(true);
    expect(statSync(note).size).toBe(0);
    expect(statSync(note).mode & 0o777).toBe(0o600);
    expect(statSync(notesOf(s)).mode & 0o777).toBe(0o700);
    expect(resolve(note).startsWith(snapOf(s))).toBe(false); // outside the snapshot dir a call may delete
    expect(readdirSync(s.base).filter((n) => n.includes('seals'))).toEqual([]);
    restore(s);
    expect(existsSync(note)).toBe(false);
    expect(existsSync(snapOf(s))).toBe(false);
  });

  test('a deleted snapshot dir with its note stays: restoreGateState removes the cursor the call created', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    take(s);
    rmSync(snapOf(s), { recursive: true, force: true });
    writeFileSync(join(s.dir, CURSOR), '{"turn":5}');
    writeFileSync(join(s.dir, FORGED_CURSOR), '{"turn":6}');
    const restored = restore(s);
    expect(existsSync(join(s.dir, CURSOR))).toBe(false);
    expect(existsSync(join(s.dir, FORGED_CURSOR))).toBe(false);
    expect(restored).toContain(CURSOR);
    expect(existsSync(join(notesOf(s), 'toolu_a'))).toBe(false); // handled once
    expect(read(s, 'edits.jsonl')).toBe(`${s.line}\n`); // the edit log is left alone
  });

  test('the same found by the Stop: restoreOrphanGateState; a call it is told is open is left', () => {
    const s = sandbox();
    take(s, 'toolu_a');
    take(s, 'toolu_open');
    rmSync(snapOf(s, 'toolu_a'), { recursive: true, force: true });
    rmSync(snapOf(s, 'toolu_open'), { recursive: true, force: true });
    writeFileSync(join(s.dir, CURSOR), '{"turn":5}');
    s.inProcess(() => restoreOrphanGateState(s.sid, ['toolu_open']));
    expect(existsSync(join(s.dir, CURSOR))).toBe(false); // toolu_a's note: untrusted restore
    expect(existsSync(join(notesOf(s), 'toolu_a'))).toBe(false);
    expect(existsSync(join(notesOf(s), 'toolu_open'))).toBe(true); // the open call keeps its note
    writeFileSync(join(s.dir, CURSOR), '{"turn":5}');
    s.inProcess(() => restoreOrphanGateState(s.sid, ['toolu_open']));
    expect(existsSync(join(s.dir, CURSOR))).toBe(true); // nothing for it to do
    s.inProcess(() => restoreOrphanGateState(s.sid));
    expect(existsSync(join(s.dir, CURSOR))).toBe(false);
  });

  test('no snapshot and no note: nothing happens', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, CURSOR), '{"turn":5}');
    expect(restore(s, 'never-taken')).toEqual([]);
    expect(s.inProcess(() => restoreOrphanGateState(s.sid))).toEqual([]);
    expect(existsSync(join(s.dir, CURSOR))).toBe(true);
    expect(s.inProcess(() => restoreGateState(s.sid, undefined))).toEqual([]);
  });

  test('another session’s notes are not this session’s', () => {
    const a = sandbox();
    take(a, 'toolu_a');
    rmSync(snapOf(a), { recursive: true, force: true });
    const b = sandbox();
    writeFileSync(join(b.dir, CURSOR), '{"turn":5}');
    expect(b.inProcess(() => restoreOrphanGateState(b.sid))).toEqual([]);
    expect(existsSync(join(b.dir, CURSOR))).toBe(true);
  });

  test('through the hooks: a call that deletes its snapshot dir and plants a cursor is undone by its post hook', async () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    await s.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_hk2', tool_input: { command: 'sh ./x.sh' } });
    rmSync(join(s.dir, `bash-guard-${safeToolUseId('toolu_hk2')}`), { recursive: true, force: true });
    writeFileSync(join(s.dir, CURSOR), '{"turn":9}');
    const post = await s.spawnHook('post-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_hk2', tool_input: { command: 'sh ./x.sh' }, tool_response: {} });
    expect(existsSync(join(s.dir, CURSOR))).toBe(false);
    expect(post.context).toContain('put back its gate state');
  });
});

// ---------------------------------------------------------------------------------------------
describe('V18-AC-2 the turn counter: bounded raise, 12 digits, a floor from the edit log', () => {
  const take = (s: Box, id: string) => s.inProcess(() => snapshotGateState(s.sid, id));
  const restore = (s: Box, id: string) => s.inProcess(() => restoreGateState(s.sid, id));
  const turn = (s: Box): string => readFileSync(join(s.dir, 'turn.txt'), 'utf8');
  const editAt = (s: Box, n: number): void =>
    writeFileSync(join(s.dir, 'edits.jsonl'), `${JSON.stringify({ file: join(s.cwd, 'a.ts'), turn: n, timestamp: new Date().toISOString() })}\n`);

  test('parseTurn: 1 to 12 digits only; MAX_TURN is 999999999999', () => {
    expect(ft.MAX_TURN).toBe(999_999_999_999);
    expect(ft.parseTurn('0')).toBe(0);
    expect(ft.parseTurn(' 42\n')).toBe(42);
    expect(ft.parseTurn('999999999999')).toBe(999_999_999_999);
    for (const bad of ['1000000000000', '999999999999999', '', ' ', '-1', '1.5', '1e3', '0x10', 'abc', '5 6', '+5']) {
      expect([bad, ft.parseTurn(bad)]).toEqual([bad, null]);
    }
    expect(ft.parseTurn(null)).toBeNull();
  });

  test('a raise of up to two stands (a Stop or two); more goes back to the snapshot’s value', () => {
    for (const [wrote, want] of [['6', '6'], ['7', '7'], ['8', '5'], ['20', '5'], ['999999999999', '5'], ['999999999999999', '5'], ['1000000000000', '5']] as const) {
      const s = sandbox();
      writeFileSync(join(s.dir, 'turn.txt'), '5');
      take(s, 'toolu_a');
      writeFileSync(join(s.dir, 'turn.txt'), wrote);
      restore(s, 'toolu_a');
      expect([wrote, turn(s)]).toEqual([wrote, want]);
    }
  });

  test('the 15-digit chain of the security review ends at the real counter', () => {
    const s = sandbox();
    editAt(s, 5);
    writeFileSync(join(s.dir, 'turn.txt'), '5');
    take(s, 'toolu_1');
    writeFileSync(join(s.dir, 'turn.txt'), '999999999999999'); // call 1 raises it far
    restore(s, 'toolu_1');
    expect(turn(s)).toBe('5');
    expect(s.inProcess(() => ft.incrementTurn(s.sid))).toBe(6); // the Stop's own increment counts on from the real value
    take(s, 'toolu_2');
    writeFileSync(join(s.dir, 'turn.txt'), '0'); // call 2 sets it to 0
    restore(s, 'toolu_2');
    expect(turn(s)).toBe('6');
    expect(s.inProcess(() => ft.getCurrentTurn(s.sid))).toBe(6);
  });

  test('incrementTurn stays at MAX_TURN', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'turn.txt'), '999999999999');
    expect(s.inProcess(() => ft.incrementTurn(s.sid))).toBe(999_999_999_999);
    expect(turn(s)).toBe('999999999999');
    expect(ft.parseTurn(turn(s))).not.toBeNull(); // still a counter
  });

  test('a file that is no counter reads as the highest turn of the edit log, never 0; no file is 0', async () => {
    for (const bad of ['junk', '9'.repeat(13), '9'.repeat(15), '-3', '']) {
      const s = sandbox();
      editAt(s, 7);
      writeFileSync(join(s.dir, 'turn.txt'), bad);
      expect([bad.length, s.inProcess(() => ft.getCurrentTurn(s.sid))]).toEqual([bad.length, 7]);
    }
    const dirCase = sandbox();
    editAt(dirCase, 7);
    mkdirSync(join(dirCase.dir, 'turn.txt'));
    expect(dirCase.inProcess(() => ft.getCurrentTurn(dirCase.sid))).toBe(7);
    const fifoCase = sandbox();
    editAt(fifoCase, 7);
    mkfifo(join(fifoCase.dir, 'turn.txt'));
    const r = await child(fifoCase.base, `const t = await lib('file-tracker'); return t.getCurrentTurn(${JSON.stringify(fifoCase.sid)});`);
    expect([r.killed, r.result]).toEqual([false, 7]);
    const none = sandbox();
    editAt(none, 7);
    expect(none.inProcess(() => ft.getCurrentTurn(none.sid))).toBe(0); // no counter yet: 0
  });

  test('turnFloor: the highest valid turn of the edit log (a huge, negative or fractional turn counts for nothing)', () => {
    const s = sandbox();
    const rec = (n: number) => JSON.stringify({ file: join(s.cwd, 'a.ts'), turn: n, timestamp: new Date().toISOString() });
    writeFileSync(join(s.dir, 'edits.jsonl'), [rec(3), rec(1e15), rec(-5), rec(1.5), rec(4)].join('\n') + '\n');
    expect(s.inProcess(() => ft.turnFloor(s.dir))).toBe(4);
    const fraction = sandbox();
    writeFileSync(join(fraction.dir, 'edits.jsonl'), `${JSON.stringify({ file: join(fraction.cwd, 'a.ts'), turn: 2.5, timestamp: new Date().toISOString() })}\n`);
    expect(fraction.inProcess(() => ft.turnFloor(fraction.dir))).toBe(0); // 2.5 is no turn
    const empty = sandbox();
    expect(empty.inProcess(() => ft.turnFloor(empty.dir))).toBe(0);
  });

  test('a turn.txt the call created as no counter is removed, or set to the edit log’s floor when that is above 0', () => {
    const withFloor = sandbox();
    editAt(withFloor, 4);
    take(withFloor, 'toolu_a'); // no counter at the snapshot
    writeFileSync(join(withFloor.dir, 'turn.txt'), 'forged');
    withFloor.inProcess(() => restoreGateState(withFloor.sid, 'toolu_a'));
    expect(turn(withFloor)).toBe('4');

    const noFloor = sandbox();
    take(noFloor, 'toolu_a');
    writeFileSync(join(noFloor.dir, 'turn.txt'), '9'.repeat(15));
    noFloor.inProcess(() => restoreGateState(noFloor.sid, 'toolu_a'));
    expect(existsSync(join(noFloor.dir, 'turn.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('V18-AC-1 readStateTail: an oversized append-only log reads as its recent part, never as empty', () => {
  const MAX = 16 * 1024 * 1024;
  const tail = (p: string, max?: number): string => safeRead.readStateTail(p, max);

  test('within the cap: the whole file (the cap itself included, and empty)', () => {
    const s = sandbox();
    const p = join(s.base, 'log');
    writeFileSync(p, 'L1\nL2\nL3\n');
    expect(tail(p)).toBe('L1\nL2\nL3\n');
    expect(tail(p, 9)).toBe('L1\nL2\nL3\n');
    writeFileSync(p, '');
    expect(tail(p)).toBe('');
  });

  test('past the cap: the last bytes from a line boundary, the partial first line dropped', () => {
    const s = sandbox();
    const p = join(s.base, 'log');
    writeFileSync(p, 'L1\nL2\nL3\n');
    expect(tail(p, 7)).toBe('L2\nL3\n');
    expect(tail(p, 5)).toBe('L3\n');
    writeFileSync(p, 'abcdefghij'); // no line boundary in the window: nothing whole to read
    expect(tail(p, 4)).toBe('');
  });

  // The window starts one byte early, so a window that begins exactly on a line start keeps its first line.
  test('a window that begins on a line boundary keeps its first line', () => {
    const s = sandbox();
    const p = join(s.base, 'log');
    writeFileSync(p, 'aaa\nbbb\nccc\n');
    expect(tail(p, 8)).toBe('bbb\nccc\n');
    expect(tail(p, 7)).toBe('ccc\n'); // one byte short of the boundary: the partial line goes
    expect(tail(p, 9)).toBe('bbb\nccc\n'); // the cut line (its last byte) is dropped
    writeFileSync(p, 'L1\nL2\nL3\n');
    expect(tail(p, 6)).toBe('L2\nL3\n');
  });

  test('a directory, an absent file and a FIFO throw like readStateText (a FIFO is never opened)', async () => {
    const s = sandbox();
    const d = join(s.base, 'adir');
    mkdirSync(d);
    expect(() => tail(d)).toThrow();
    let code = '';
    try {
      tail(join(s.base, 'nope'));
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? '';
    }
    expect(code).toBe('ENOENT');
    const fifo = join(s.base, 'fifo');
    mkfifo(fifo);
    const r = await child(s.base, `const { readStateTail } = await lib('safe-read'); try { readStateTail(${JSON.stringify(fifo)}); return { threw: false }; } catch (e) { return { threw: true, code: (e as any).code }; }`);
    expect(r.killed).toBe(false);
    expect(r.result).toEqual({ threw: true, code: 'EINVAL' });
  });

  /** A log whose old part is one huge line (cheap to write), then the records a gate asks for: past the 16 MB state
   *  cap, so a reader gets its tail. */
  function bigLog(p: string, records: string[]): void {
    writeFileSync(p, 'x'.repeat(MAX + 1024) + '\n' + records.join('\n') + '\n');
  }

  test('the edit log past the 16 MB cap reads as its recent records (file-tracker), not as empty', async () => {
    const s = sandbox();
    const rec = (f: string, n: number) => JSON.stringify({ file: join(s.cwd, f), turn: n, timestamp: new Date().toISOString() });
    bigLog(join(s.dir, 'edits.jsonl'), [rec('a.ts', 8), rec('b.ts', 9)]);
    const r = await child(s.base, `const t = await lib('file-tracker'); return { files: t.getEditHistory(${JSON.stringify(s.sid)}).files.length, floor: t.turnFloor(t.ensureSessionDir(${JSON.stringify(s.sid)})) };`);
    expect(r.result).toEqual({ files: 2, floor: 9 });
  });

  test('the dispatch log and the WebFetch record past 16 MB read as their recent records', async () => {
    const s = sandbox();
    bigLog(join(s.dir, 'dispatch-log.jsonl'), [JSON.stringify({ k: 'launched', t: 5, tuid: 'a', agentId: 'x' })]);
    bigLog(join(s.dir, 'webfetch.jsonl'), [JSON.stringify({ url: 'https://example.com/a', timestamp: new Date().toISOString() })]);
    const r = await child(
      s.base,
      `const g = await lib('spawn-guard'); const h = await lib('token-habits'); return { dispatch: g.readDispatchLog(${JSON.stringify(s.sid)}).length, fetched: h.wasUrlFetched(${JSON.stringify(s.sid)}, 'https://example.com/a') };`,
    );
    expect(r.result).toEqual({ dispatch: 1, fetched: true });
  });

  test('an append still works on a log past the cap', async () => {
    const s = sandbox();
    bigLog(join(s.dir, 'edits.jsonl'), []);
    const r = await child(s.base, `const t = await lib('file-tracker'); t.recordEdit(${JSON.stringify(s.sid)}, ${JSON.stringify(join(s.cwd, 'a.ts'))}, 3); return t.getEditHistory(${JSON.stringify(s.sid)}).files.length;`);
    expect(r.result).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('V18-AC-3 a guarded log past the state cap: not copied, and the Stop blocks on it (B5.96)', () => {
  const MAX = 16 * 1024 * 1024;
  /** A log of `size` bytes: lines of 'x', cheap to write. */
  const logOf = (p: string, size: number): void => writeFileSync(p, `${'x'.repeat(size - 1)}\n`);
  const over = (s: Box): string[] => s.inProcess(() => sg.oversizedLogs(s.sid));

  test('oversizedLogs names the guarded .jsonl files over the cap, and only those', () => {
    const s = sandbox();
    logOf(join(s.dir, 'dispatch-log.jsonl'), MAX + 1);
    logOf(join(s.dir, 'edits.jsonl'), MAX + 10);
    expect(over(s).sort()).toEqual(['dispatch-log.jsonl', 'edits.jsonl']);
  });

  test('a log at the cap, a smaller one, a non-guarded log, a guarded .json file and a directory are not', () => {
    const s = sandbox();
    logOf(join(s.dir, 'dispatch-log.jsonl'), MAX); // exactly the cap
    writeFileSync(join(s.dir, 'edits.jsonl'), 'x\n');
    logOf(join(s.dir, 'reads.jsonl'), MAX + 5); // not a guarded name
    logOf(join(s.dir, 'judged-weakened.json'), MAX + 5); // guarded, but not an append-only log
    mkdirSync(join(s.dir, 'unswept.jsonl'));
    expect(over(s)).toEqual([]);
  });

  test('a link to a big file is no oversized log; no session dir: nothing to judge', () => {
    const s = sandbox();
    logOf(join(s.base, 'big'), MAX + 5);
    symlinkSync(join(s.base, 'big'), join(s.dir, 'dispatch-log.jsonl'));
    expect(over(s)).toEqual([]);
    expect(sg.oversizedLogs('v18-never-made-a-dir')).toEqual([]);
  });

  test('oversizedLogsReason names the files and the limit, tells the model to leave the state alone, and that only the user can pass', () => {
    const r = sg.oversizedLogsReason(['dispatch-log.jsonl', 'edits.jsonl']);
    expect(r).toContain('dispatch-log.jsonl, edits.jsonl');
    expect(r).toContain('16 MB');
    expect(r).toContain('Only the user can let this Stop pass');
  });

  test('a snapshot does not copy it, and still lists it among the names that existed', () => {
    const s = sandbox();
    logOf(join(s.dir, 'dispatch-log.jsonl'), MAX + 1);
    writeFileSync(join(s.dir, 'edits.jsonl'), `${s.line}\n`);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const snap = join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`);
    const idx = JSON.parse(readFileSync(join(snap, '.index.json'), 'utf8')) as { names: string[]; present: string[] };
    expect([...idx.names].sort()).toEqual(['edits.jsonl', 'oversized-logs.json']); // the small flag is copied, the log is not
    expect(idx.present).toContain('dispatch-log.jsonl');
    expect(existsSync(join(snap, 'dispatch-log.jsonl'))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.dir, 'oversized-logs.json'), 'utf8'))).toEqual(['dispatch-log.jsonl']);
  });

  /** The round-3 review's sequence: a log a hook's append pushed past the cap, then a call that deletes it. */
  function padJustUnder(s: Box): string {
    const p = join(s.dir, 'edits.jsonl');
    logOf(p, MAX - 100);
    expect(statSync(p).size).toBeLessThanOrEqual(MAX); // under the cap: nothing to flag yet
    appendFileSync(p, `${'y'.repeat(200)}\n`); // a hook's append (the edit record) takes it past
    expect(statSync(p).size).toBeGreaterThan(MAX);
    return p;
  }

  test('a log a hook append pushed past the cap, then deleted by a call, is still named (the snapshot flagged it)', () => {
    const s = sandbox();
    const p = padJustUnder(s);
    expect(existsSync(join(s.dir, 'oversized-logs.json'))).toBe(false); // nothing flagged before a snapshot
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    expect(JSON.parse(readFileSync(join(s.dir, 'oversized-logs.json'), 'utf8'))).toEqual(['edits.jsonl']);
    rmSync(p); // the call deletes the log and the flag
    rmSync(join(s.dir, 'oversized-logs.json'));
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(existsSync(p)).toBe(false); // the log itself is gone for good
    expect(over(s)).toEqual(['edits.jsonl']); // but the flag came back: the Stop still blocks
    s.inProcess(() => sg.clearOversizedLogs(s.sid));
    expect(over(s)).toEqual([]);
    expect(existsSync(join(s.dir, 'oversized-logs.json'))).toBe(false);
  });

  test('the flag only grows with a snapshot; a log back under the cap is not dropped by another snapshot; a call-made flag still names real logs only', () => {
    const s = sandbox();
    logOf(join(s.dir, 'dispatch-log.jsonl'), MAX + 1);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    rmSync(join(s.dir, 'dispatch-log.jsonl'));
    logOf(join(s.dir, 'edits.jsonl'), MAX + 1);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_b'));
    expect(over(s)).toEqual(['dispatch-log.jsonl', 'edits.jsonl']);
    writeFileSync(join(s.dir, 'oversized-logs.json'), JSON.stringify(['../../etc/passwd', 'notes.txt', 'unswept.jsonl']));
    expect(over(s).sort()).toEqual(['edits.jsonl', 'unswept.jsonl']); // only guarded names count (plus what is really big)
  });

  const STOP_ENV = { GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' };

  test('a full Stop BLOCKS on it, naming the file; the count file is the state gate’s own', async () => {
    const s = sandbox();
    logOf(join(s.dir, 'dispatch-log.jsonl'), MAX + 1);
    const out = await s.spawnHook('stop', { hook_event_name: 'Stop' }, STOP_ENV);
    expect(out.killed).toBe(false);
    expect(out.raw.decision).toBe('block');
    expect(String(out.raw.reason)).toContain('dispatch-log.jsonl');
    expect(String(out.raw.reason)).toContain('Only the user can let this Stop pass');
    expect(readFileSync(join(s.dir, '.goodboy-state-retry-count.txt'), 'utf8').trim()).toBe('1');
    const again = await s.spawnHook('stop', { hook_event_name: 'Stop' }, STOP_ENV);
    expect(again.raw.decision).toBe('block');
    expect(readFileSync(join(s.dir, '.goodboy-state-retry-count.txt'), 'utf8').trim()).toBe('2');
  });

  test('a Stop blocks on the flag alone (the log deleted), and the user’s marker passes it and clears the flag', async () => {
    const s = sandbox();
    padJustUnder(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    rmSync(join(s.dir, 'edits.jsonl'));
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    const blocked = await s.spawnHook('stop', { hook_event_name: 'Stop' }, STOP_ENV);
    expect(blocked.raw.decision).toBe('block');
    expect(String(blocked.raw.reason)).toContain('edits.jsonl');
    expect(existsSync(join(s.dir, 'oversized-logs.json'))).toBe(true);

    const marker = join(s.cwd, approvalMarkerRelPath('stop', s.sid));
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '');
    const passed = await s.spawnHook('stop', { hook_event_name: 'Stop' }, STOP_ENV);
    expect(passed.raw.decision).toBeUndefined();
    expect(existsSync(join(s.dir, 'oversized-logs.json'))).toBe(false); // cleared by the pass
    expect(existsSync(marker)).toBe(false);
    const after = await s.spawnHook('stop', { hook_event_name: 'Stop' }, STOP_ENV);
    expect(after.raw.decision).toBeUndefined(); // nothing left to block on
  });

  // Round-4 review: the flag is written under a temp name and renamed into place, after removing a directory or a FIFO
  // at its path, so what a call left there neither hangs the snapshot nor is written through.
  test('a link at the flag path is replaced, never followed: its target is untouched and the flag names the log', () => {
    const s = sandbox();
    logOf(join(s.dir, 'edits.jsonl'), MAX + 1);
    const target = join(s.base, 'victim.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, join(s.dir, 'oversized-logs.json'));
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    const flag = join(s.dir, 'oversized-logs.json');
    expect(lstatSync(flag).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(flag, 'utf8'))).toEqual(['edits.jsonl']);
    expect(existsSync(join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`, '.index.json'))).toBe(true);
  });

  test('a directory or a FIFO at the flag path: the snapshot is still taken, with no hang, and the flag is written', async () => {
    const dirCase = sandbox();
    logOf(join(dirCase.dir, 'edits.jsonl'), MAX + 1);
    mkdirSync(join(dirCase.dir, 'oversized-logs.json', 'inner'), { recursive: true });
    dirCase.inProcess(() => snapshotGateState(dirCase.sid, 'toolu_a'));
    expect(lstatSync(join(dirCase.dir, 'oversized-logs.json')).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(dirCase.dir, 'oversized-logs.json'), 'utf8'))).toEqual(['edits.jsonl']);
    expect(existsSync(join(dirCase.dir, `bash-guard-${safeToolUseId('toolu_a')}`, '.index.json'))).toBe(true);

    const fifoCase = sandbox();
    logOf(join(fifoCase.dir, 'edits.jsonl'), MAX + 1);
    mkfifo(join(fifoCase.dir, 'oversized-logs.json'));
    const pre = await fifoCase.spawnHook('pre-tool-use', { tool_name: 'Bash', tool_use_id: 'toolu_f', tool_input: { command: 'sh ./x.sh' } });
    expect(pre.killed).toBe(false);
    expect(lstatSync(join(fifoCase.dir, 'oversized-logs.json')).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(fifoCase.dir, 'oversized-logs.json'), 'utf8'))).toEqual(['edits.jsonl']);
    expect(existsSync(join(fifoCase.dir, `bash-guard-${safeToolUseId('toolu_f')}`, '.index.json'))).toBe(true);
  });

  test('with the index gone, a flag rewritten to [] and the log deleted: an untrusted restore keeps the copy’s names', () => {
    const s = sandbox();
    padJustUnder(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const snap = join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`);
    rmSync(join(snap, '.index.json')); // untrusted from here
    writeFileSync(join(s.dir, 'oversized-logs.json'), '[]'); // the call clears the flag ...
    rmSync(join(s.dir, 'edits.jsonl')); // ... and deletes the log
    s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
    expect(over(s)).toEqual(['edits.jsonl']);
  });

  test('an untrusted restore adds nothing when the flag already holds the copy’s names, and ignores unguarded names in the copy', () => {
    const s = sandbox();
    padJustUnder(s);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const snap = join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`);
    rmSync(join(snap, '.index.json'));
    writeFileSync(join(snap, 'oversized-logs.json'), JSON.stringify(['edits.jsonl', '../x', 'notes.txt']));
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_a'))).not.toContain('oversized-logs.json');
    expect(JSON.parse(readFileSync(join(s.dir, 'oversized-logs.json'), 'utf8'))).toEqual(['edits.jsonl']);
  });

  test('without an oversized log the same Stop passes, and the count is reset', async () => {
    const s = sandbox();
    writeFileSync(join(s.dir, '.goodboy-state-retry-count.txt'), '3');
    const out = await s.spawnHook('stop', { hook_event_name: 'Stop' }, STOP_ENV);
    expect(out.raw.decision).toBeUndefined();
    expect(existsSync(join(s.dir, '.goodboy-state-retry-count.txt'))).toBe(false);
  });

  test("the user's marker passes it once", async () => {
    const s = sandbox();
    logOf(join(s.dir, 'dispatch-log.jsonl'), MAX + 1);
    const marker = join(s.cwd, approvalMarkerRelPath('stop', s.sid));
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '');
    const out = await s.spawnHook('stop', { hook_event_name: 'Stop' }, STOP_ENV);
    expect(out.raw.decision).toBeUndefined();
    expect(existsSync(marker)).toBe(false); // used once
  });
});

// ---------------------------------------------------------------------------------------------
// In-process runs of the session-file readers that went through `readStateText`, and of the guard's failure paths that
// need a hostile file system (a child process is not in this process's coverage, so these run here).
describe('V18-AC-1 the session-file readers, in process: a regular file reads, anything else is the fail-open answer', () => {
  test('habit state, effort advice, status snapshot, skill evidence and the production-seen list round-trip', () => {
    const s = sandbox();
    s.inProcess(() => {
      hab.writeHabitState(s.sid, { absentRecordsShown: ['x'] });
      expect(hab.readHabitState(s.sid)).toEqual({ absentRecordsShown: ['x'] });
      adv.writeLastAdvice(s.sid, 'high');
      expect(adv.readLastAdvice(s.sid)?.level).toBe('high');
      gl.writeStatusSnapshot(s.sid, {} as never);
      expect(typeof gl.readStatusSnapshot(s.sid)?.updatedAt).toBe('string');
      sk.recordSkillEvidence(s.sid, { k: 'skill', t: 1, name: 'fix-bug' });
      appendFileSync(join(s.dir, 'skill-evidence.jsonl'), 'not json\n');
      expect(sk.readSkillEvidence(s.sid)).toEqual([{ k: 'skill', t: 1, name: 'fix-bug' }]);
      expect(am.rememberProduction(s.sid, ['a.example'])).toEqual(['a.example']);
      expect(am.rememberProduction(s.sid, ['b.example']).sort()).toEqual(['a.example', 'b.example']);
    });
  });

  test('a directory in the place of each of them reads as nothing, and the production list still accumulates', () => {
    const s = sandbox();
    for (const n of ['habit-state.json', 'effort-advice.json', 'status.json', 'skill-evidence.jsonl', 'production-hosts.json']) mkdirSync(join(s.dir, n));
    s.inProcess(() => {
      expect(hab.readHabitState(s.sid)).toEqual({});
      expect(adv.readLastAdvice(s.sid)).toBeNull();
      expect(gl.readStatusSnapshot(s.sid)).toBeNull();
      expect(sk.readSkillEvidence(s.sid)).toEqual([]);
      expect(am.rememberProduction(s.sid, ['a.example'])).toEqual(['a.example']);
    });
  });

  test('the bash windows are read from the log: a marker made inside a window is the model’s, one outside it is the user’s', () => {
    const s = sandbox();
    const marker = join(s.cwd, '.claude', 'approval-marker.txt');
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '');
    const now = Date.now();
    s.inProcess(() => {
      expect(am.userMarkerPresent(s.sid, marker)).toBe(true); // no window yet
      am.recordBashWindow(s.sid, now - 60_000, now + 60_000);
      expect(am.userMarkerPresent(s.sid, marker)).toBe(false); // made during a window
    });
    expect(existsSync(marker)).toBe(false); // removed, not used
    const other = sandbox();
    const m2 = join(other.cwd, '.claude', 'approval-marker.txt');
    mkdirSync(dirname(m2), { recursive: true });
    writeFileSync(m2, '');
    other.inProcess(() => {
      am.recordBashWindow(other.sid, now - 120_000, now - 90_000); // an old window
      appendFileSync(join(other.dir, 'bash-windows.jsonl'), 'junk line\n'); // a line that is no window is skipped
      expect(am.userMarkerPresent(other.sid, m2)).toBe(true);
    });
  });
});

describe('V18-AC-3/4 the guard’s failure paths on a hostile file system', () => {
  const notRoot = process.getuid?.() !== 0;

  test('a restore of a call with no note, while the session has other notes, does nothing', () => {
    const s = sandbox();
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a')); // the notes dir now exists
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_other'))).toEqual([]);
    expect(existsSync(join(s.dir, '.seal-notes', 'toolu_a'))).toBe(true);
  });

  test('a flag that is not JSON names nothing; an untrusted copy of it that is not JSON adds nothing', () => {
    const s = sandbox();
    writeFileSync(join(s.dir, 'oversized-logs.json'), 'not json');
    expect(s.inProcess(() => sg.oversizedLogs(s.sid))).toEqual([]);
    s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
    const snap = join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`);
    rmSync(join(snap, '.index.json')); // untrusted
    expect(s.inProcess(() => restoreGateState(s.sid, 'toolu_a'))).not.toContain('oversized-logs.json');
    expect(s.inProcess(() => sg.oversizedLogs(s.sid))).toEqual([]);
  });

  if (notRoot) {
    test('a turn.txt the call made unreadable is no counter: removed (the file system refuses the read)', () => {
      const s = sandbox();
      s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
      writeFileSync(join(s.dir, 'turn.txt'), '7');
      chmodSync(join(s.dir, 'turn.txt'), 0o000);
      s.inProcess(() => restoreGateState(s.sid, 'toolu_a'));
      expect(existsSync(join(s.dir, 'turn.txt'))).toBe(false);
    });

    test('a notes dir the call made unlistable is not listed (the Stop goes on)', () => {
      const s = sandbox();
      s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'));
      const notes = join(s.dir, '.seal-notes');
      chmodSync(notes, 0o000);
      try {
        expect(() => s.inProcess(() => restoreOrphanGateState(s.sid, ['toolu_a']))).not.toThrow();
      } finally {
        chmodSync(notes, 0o700);
      }
      expect(existsSync(join(notes, 'toolu_a'))).toBe(true);
    });

    // With the temp name held by a directory that cannot be emptied, writeFlag's catch must not throw out of it: a
    // throw abandoned the snapshot before its index was written (the snapshot dir was made and left empty).
    test('a flag that cannot be written leaves the snapshot taken, index included (the temp name is held by a dir that cannot be emptied)', () => {
      const s = sandbox();
      writeFileSync(join(s.dir, 'edits.jsonl'), `${'x'.repeat(16 * 1024 * 1024)}\n`);
      const hold = join(s.dir, `oversized-logs.json.${process.pid}.tmp`);
      mkdirSync(join(hold, 'inner'), { recursive: true });
      writeFileSync(join(hold, 'inner', 'f'), '');
      chmodSync(join(hold, 'inner'), 0o500);
      try {
        expect(() => s.inProcess(() => snapshotGateState(s.sid, 'toolu_a'))).not.toThrow();
        expect(existsSync(join(s.dir, 'oversized-logs.json'))).toBe(false); // no flag could be written
        const snap = join(s.dir, `bash-guard-${safeToolUseId('toolu_a')}`);
        expect(existsSync(join(snap, '.index.json'))).toBe(true); // but the snapshot was completed
        expect(JSON.parse(readFileSync(join(snap, '.index.json'), 'utf8')).seal).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        chmodSync(join(hold, 'inner'), 0o700);
      }
    });
  }

  // macOS PATH_MAX is 1024: a session dir whose own path fits, with a file name that does not, makes every lstat of a
  // file in it fail. The restore must not throw on that.
  if (process.platform === 'darwin') {
    test('a session dir too deep for a file path in it: the restore goes on without throwing', () => {
      const s = sandbox();
      let deep = s.base;
      while (deep.length < 780) {
        deep = join(deep, 'd'.repeat(120));
        mkdirSync(deep);
      }
      const prefix = join(deep, 'goodboy-session-');
      const sid = 'z'.repeat(1000 - prefix.length); // the dir path fits (even with /private spelled out), a file in it does not
      const dir = join(deep, `goodboy-session-${sid}`);
      mkdirSync(dir);
      const here = process.cwd();
      try {
        process.chdir(dir);
        writeFileSync('start-tips-0123456789abcdef.json', '{}'); // a hook-only name, too long to lstat by its full path
        mkdirSync('bash-guard-x'); // a snapshot dir the restore finds by listing
      } finally {
        process.chdir(here);
      }
      const saved = process.env.TMPDIR;
      process.env.TMPDIR = deep;
      try {
        expect(() => restoreOrphanGateState(sid)).not.toThrow();
      } finally {
        process.env.TMPDIR = saved;
      }
    });
  }
});

// A sanity check that the helper lays the session dir where the lib looks for it.
describe('sandbox', () => {
  test('the in-process session dir is the one the hooks use', () => {
    const s = sandbox();
    expect(s.inProcess(() => ensureSessionDir(s.sid))).toBe(s.dir);
  });
});
