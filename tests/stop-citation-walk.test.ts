// Layer 0 performance fix, end to end through the real Stop hook.
//
// A bare file name ("a.ts:3") is resolved with one walk of the repo. Each extractCitations
// call used to walk on its own — the answer plus up to three user prompts per Stop — with
// no time limit, which pushed a Stop past its 15 s timeout on directory-heavy trees.
// The Stop hook now passes one CitationCache to every call, and a walk past its time
// budget is incomplete.
//
// The walks are counted with a CommonJS preload that wraps fs.readdirSync before the hook's
// modules load (the hook's `import { readdirSync } from 'node:fs'` binds to the wrapper).
// The walk is the only caller that reads directories with `withFileTypes: true`.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// Logs every directory the walk reads under WALK_ROOT and can slow each read down
// (WALK_DELAY_MS) to stand in for a slow file system.
const PRELOAD_SRC = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const real = fs.readdirSync;
const root = process.env.WALK_ROOT || '';
const log = process.env.WALK_LOG || '';
const delayMs = Number(process.env.WALK_DELAY_MS || 0);
fs.readdirSync = function (dir, opts) {
  const p = String(dir);
  const walking = opts !== null && typeof opts === 'object' && opts.withFileTypes === true;
  if (walking && root !== '' && (p === root || p.startsWith(root + path.sep))) {
    if (log !== '') fs.appendFileSync(log, p + '\n');
    if (delayMs > 0) Bun.sleepSync(delayMs);
  }
  return real.apply(this, arguments);
};
`;

interface Box {
  tmp: string;
  cwd: string;
  preload: string;
}

/** A repo whose files are all below the root, so every bare name needs the walk. */
function newBox(): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-walk-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-walk-cwd-'));
  tmpDirs.push(cwd);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'lib', 'deep'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
  writeFileSync(join(cwd, 'lib', 'b.ts'), 'a\nb\nc\n', 'utf8');
  writeFileSync(join(cwd, 'lib', 'deep', 'c.ts'), 'a\nb\nc\n', 'utf8');
  const preload = join(tmp, 'count-walks.cjs');
  writeFileSync(preload, PRELOAD_SRC, 'utf8');
  return { tmp, cwd, preload };
}

/** One user prompt per entry, each answered; the last answer is `answer`. */
function writeTranscript(box: Box, userTexts: string[], answer: string): string {
  const lines: string[] = [];
  userTexts.forEach((u, i) => {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: u } }));
    const reply = i === userTexts.length - 1 ? answer : 'Looking into it.';
    lines.push(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } }),
    );
  });
  // Low usage on a known 200K model, so the context gates stay quiet.
  lines.push(JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }));
  const path = join(box.tmp, `transcript-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

interface StopOut {
  decision?: string;
  reason?: string;
}

interface Run {
  out: StopOut;
  /** Directories the walk read, in order. */
  reads: string[];
}

async function runStop(
  box: Box,
  transcriptPath: string,
  extraEnv: Record<string, string> = {},
  opts: { sessionId?: string; stopHookActive?: boolean } = {},
): Promise<Run> {
  const log = join(box.tmp, `walk-${Math.random().toString(36).slice(2)}.log`);
  const sessionId = opts.sessionId ?? `sess-${Math.random().toString(36).slice(2)}`;
  const proc = Bun.spawn(['bun', '--preload', box.preload, STOP_HOOK], {
    cwd: box.cwd,
    env: {
      ...process.env,
      TMPDIR: box.tmp,
      HOME: box.tmp,
      GOODBOY_TEST_GATE: 'off',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      WALK_ROOT: box.cwd,
      WALK_LOG: log,
      ...extraEnv,
    },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: sessionId,
        cwd: box.cwd,
        hook_event_name: 'Stop',
        transcript_path: transcriptPath,
        ...(opts.stopHookActive ? { stop_hook_active: true } : {}),
      }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const reads = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') : [];
  let out: StopOut = {};
  try {
    out = JSON.parse(stdout) as StopOut;
  } catch {
    out = {};
  }
  return { out, reads };
}

/** How many walks started: each one reads the repo root first. */
function walks(box: Box, run: Run): number {
  return run.reads.filter((p) => p === box.cwd).length;
}

describe('Stop hook — bare-name walk (layer 0 performance)', () => {
  test('the answer and the recent user prompts share one walk', async () => {
    const box = newBox();
    const tp = writeTranscript(
      box,
      ['Why does b.ts:2 throw?', 'And what calls c.ts:1 here?', 'Where does a.ts:3 start?'],
      'It starts at a.ts:1 and then calls b.ts:2.',
    );
    const run = await runStop(box, tp);
    // a.ts and b.ts name one repo file each, and those lines exist: nothing to block.
    expect(run.out.decision).toBeUndefined();
    // Four texts carry bare names; one walk resolves all of them.
    expect(walks(box, run)).toBe(1);
  });

  test('an answer without citations does not walk the repo for the user prompts', async () => {
    const box = newBox();
    const prompts = ['Why does b.ts:2 throw?', 'And what calls c.ts:1 here?'];
    const quiet = await runStop(box, writeTranscript(box, prompts, 'Done. The build is green now.'));
    expect(quiet.out.decision).toBeUndefined();
    expect(walks(box, quiet)).toBe(0);
    // Control: the same prompts with a bare name in the answer walk once, so the zero above
    // comes from the hook, not from a counter that never fires.
    const cited = await runStop(box, writeTranscript(box, prompts, 'It is thrown at a.ts:2.'));
    expect(walks(box, cited)).toBe(1);
  });

  test('a walk past its time budget leaves a bare name unresolvable, never a missing file', async () => {
    const box = newBox();
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(box.cwd, 'pkg', `d${i}`), { recursive: true });
      writeFileSync(join(box.cwd, 'pkg', `d${i}`, 'index.ts'), 'x\n', 'utf8');
    }
    const tp = writeTranscript(box, ['What does the parser do?'], 'The parser lives in zzz.ts:1.');

    // Control: a complete walk shows the name exists nowhere, a definite missing file.
    const fast = await runStop(box, tp);
    expect(fast.out.decision).toBe('block');
    expect(fast.out.reason).toContain('zzz.ts:1 — no such file');
    expect(fast.reads.length).toBeGreaterThan(41);

    // 25 ms per directory: reading all of them would take about a second.
    const slow = await runStop(box, tp, { WALK_DELAY_MS: '25' });
    expect(slow.out.decision).toBe('block');
    expect(slow.out.reason).toContain('zzz.ts:1 — could not resolve this file name; cite the repo-relative path');
    expect(slow.out.reason ?? '').not.toContain('no such file');
    // The walk stopped at its budget instead of reading every directory.
    expect(slow.reads.length).toBeLessThan(fast.reads.length / 2);
  });

  // A stop_hook_active Stop checks the citations for its still-wrong warning, and when it
  // has just accepted a pending layer-1 result it goes on through the layer-0 gate too —
  // two checks in one Stop. They must share the walk ("at most once per Stop").
  test('a stop_hook_active Stop that accepts a pending test result still walks once', async () => {
    const box = newBox();
    const sessionId = seedPendingTestResult(box);
    const tp = writeTranscript(box, ['Where does the flow start?'], 'It starts at a.ts:1.');

    const run = await runStop(box, tp, { GOODBOY_TEST_GATE: 'on' }, { sessionId, stopHookActive: true });
    // The layer-1 result was accepted and the Stop went on to layer 2 (no review yet).
    expect(run.out.decision).toBe('block');
    expect(run.out.reason).toContain('Review is required');
    expect(walks(box, run)).toBe(1);
  });

  // The same path with an answer that is not in the transcript yet: layer 0 polls for the
  // flush before it checks anything. Two checks waited twice — at the 8 s maximum that is
  // past the 15 s Stop timeout. Each wait leaves one flush-wait entry in the gate log.
  test('a stop_hook_active Stop that accepts a pending test result waits for the flush once', async () => {
    const box = newBox();
    const sessionId = seedPendingTestResult(box);
    const tp = join(box.tmp, 'pending-transcript.jsonl');
    writeFileSync(
      tp,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Where does the flow start?' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It starts at a.ts:1.' }] } }),
        // The latest prompt, whose answer has not been flushed yet.
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'And where does it end?' } }),
      ].join('\n') + '\n',
      'utf8',
    );

    const run = await runStop(
      box,
      tp,
      { GOODBOY_TEST_GATE: 'on', GOODBOY_CLAIM_FLUSH_WAIT_MS: '400' },
      { sessionId, stopHookActive: true },
    );
    expect(run.out.decision).toBe('block');
    expect(run.out.reason).toContain('Review is required');
    const log = readFileSync(join(box.tmp, `goodboy-session-${sessionId}`, 'gate-log.jsonl'), 'utf8');
    expect(log).toContain('continue-to-review-after-accept');
    expect(log.split('\n').filter((l) => l.includes('flush-wait-'))).toHaveLength(1);
  });
});

/** A session with one edit at turn 2 and a passing layer-1 result for it that no Stop has
 *  accepted yet. Returns the session id. */
function seedPendingTestResult(box: Box): string {
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  const sessionDir = join(box.tmp, `goodboy-session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, 'turn.txt'), '2', 'utf8');
  writeFileSync(
    join(sessionDir, 'edits.jsonl'),
    JSON.stringify({ file: join(box.cwd, 'src', 'a.ts'), turn: 2, timestamp: new Date().toISOString() }) + '\n',
    'utf8',
  );
  const testFile = join(box.cwd, 'tests', 'a.test.ts');
  mkdirSync(join(box.cwd, 'tests'), { recursive: true });
  writeFileSync(testFile, 'test("x", () => { expect(1).toBe(1); });\n', 'utf8');
  mkdirSync(join(box.cwd, '.claude', 'tests'), { recursive: true });
  writeFileSync(
    join(box.cwd, '.claude', 'tests', 'result.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: [join(box.cwd, 'src', 'a.ts')],
      category: 'fix-bug',
      test_files: [testFile],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass' }],
      acceptance: [
        {
          id: 'AC-1',
          description: 'the fix works',
          test: 'tests/a.test.ts',
          red: { command: 'bun test (before the fix)', output: '1 fail', exit_code: 1 },
          green: { command: 'bun test', output: '1 pass', exit_code: 0 },
        },
      ],
      verdict: 'pass',
    }),
    'utf8',
  );
  return sessionId;
}
