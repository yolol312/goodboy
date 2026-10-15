// A7, track G: H1-03 is a notice, not a block. Once it has fired, it stays latched for the
// session: later Stops above the threshold do not repeat it; the latch clears when usage
// drops below the threshold. (Before A7 the forced-compact escape reset its counter, giving
// an endless block/block/pass cycle; track G removed the block itself.)

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const CODE_FILE = 'util.ts';
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

function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-latch-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-latch-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  // One reviewed code edit, so Stops that are not compact-forced pass cleanly.
  const dir = join(tmp, `goodboy-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), '0', 'utf8');
  const abs = resolve(cwd, CODE_FILE);
  writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: abs, turn: 1, timestamp: new Date().toISOString() }) + '\n', 'utf8');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '', 'utf8');
  mkdirSync(join(cwd, '.claude', 'reviews'), { recursive: true });
  writeFileSync(
    join(cwd, '.claude', 'reviews', 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60000).toISOString(),
      reviewed_files: [abs],
      category: 'refactor',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      // Every dimension: requiredDimensionsFor() also matches tokens in the absolute path
      // (e.g. "url" in a random mkdtemp suffix adds error-path/proto-pollution), and this
      // test is about the compact latch, not review coverage.
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
    }),
    'utf8',
  );
  return { tmp, cwd, sessionId };
}

/** Transcript whose latest usage is `tokens` on a 200K-context model. */
function transcript(cwd: string, tokens: number): string {
  const path = join(cwd, `transcript-${tokens}.jsonl`);
  writeFileSync(
    path,
    JSON.stringify({ message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: tokens } } }) + '\n',
    'utf8',
  );
  return path;
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  stopReason?: string;
}

async function runStop(box: { tmp: string; cwd: string; sessionId: string }, transcriptPath: string): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd: box.cwd,
    env: {
      ...process.env,
      TMPDIR: box.tmp,
      HOME: box.tmp,
      GOODBOY_TEST_GATE: 'off',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
    },
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: box.sessionId, cwd: box.cwd, hook_event_name: 'Stop', transcript_path: transcriptPath }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as StopOut;
  } catch {
    return {};
  }
}

describe('Stop hook — compaction notice latch (A7, track G)', () => {
  test('the notice fires once; later Stops over the threshold pass silently', async () => {
    const box = newSandbox();
    const high = transcript(box.cwd, 120_000); // 60%
    const outs: StopOut[] = [];
    for (let i = 0; i < 5; i++) outs.push(await runStop(box, high));

    // On failure, show which gate produced each outcome (a one-off failure was seen once in a
    // full-suite run and could not be explained from the decisions alone).
    const trace = JSON.stringify(outs.map((o) => [o.decision ?? 'pass', (o.reason ?? o.systemMessage ?? '').slice(-100)]));
    expect(outs.map((o) => o.decision), trace).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(outs[0]!.systemMessage ?? '').toContain('H1-03');
    expect(outs[0]!.systemMessage ?? '').toContain('/compact');
    for (const o of outs) expect(o.stopReason).toBeUndefined();
    for (const o of outs.slice(1)) expect(o.systemMessage ?? '').not.toContain('H1-03');
  });

  test('the latch is per session: another session over the threshold gets its own notice', async () => {
    const box = newSandbox();
    const high = transcript(box.cwd, 120_000);
    expect((await runStop(box, high)).systemMessage ?? '').toContain('H1-03'); // notice, then latched

    const other = { ...box, sessionId: `${box.sessionId}-other` };
    const first = await runStop(other, high);
    expect(first.decision).toBeUndefined();
    expect(first.systemMessage ?? '').toContain('H1-03');

    // The first session is still latched.
    const again = await runStop(box, high);
    expect(again.decision).toBeUndefined();
    expect(again.systemMessage ?? '').not.toContain('H1-03');
  });
});
