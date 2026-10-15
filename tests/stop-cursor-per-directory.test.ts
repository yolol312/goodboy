// Review and test cursors are per session and per project directory (stabilization plan A3).
//
// The Stop hook scopes its review and test sets to its cwd, so an accept in a subdirectory
// covers only the edits below it. With one cursor per session, that accept moved the
// cursor past the session's edits elsewhere in the repo, and a later Stop at the repo root
// let them through with no review and no test (hallucination-axis review).
//
// Every step runs the real hooks: PostToolUse records the edits, Stop accepts or blocks.
// Only the review and test result JSON files are written directly; they are the
// documented outputs of the review and test subagents. No lib API is imported, so the
// file also runs against older trees (red runs).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
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

interface Box {
  tmp: string;
  /** The repo root. */
  root: string;
  /** A subdirectory of the repo the session also works from. */
  sub: string;
  sessionId: string;
}

function newBox(): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-cpd-tmp-'));
  tmpDirs.push(tmp);
  const root = mkdtempSync(join(tmpdir(), 'goodboy-cpd-cwd-'));
  tmpDirs.push(root);
  const sub = join(root, 'src');
  mkdirSync(sub, { recursive: true });
  return { tmp, root, sub, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function run(box: Box, script: string, cwd: string, payload: Record<string, unknown>, env: Record<string, string>): Promise<HookOut> {
  const proc = Bun.spawn(['bun', script], {
    cwd,
    env: {
      ...process.env,
      TMPDIR: box.tmp,
      HOME: box.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DISABLE_DELEGATION: '1',
      ...env,
    },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: box.sessionId, cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as HookOut;
  } catch {
    return {};
  }
}

/** An Edit as PostToolUse sees it, from the repo root (no package.json: no auto-validation). */
async function edit(box: Box, rel: string): Promise<void> {
  const abs = resolve(box.root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(box, POST, box.root, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } }, {});
}

async function stop(box: Box, cwd: string, opts: { testGate?: 'on' | 'off'; active?: boolean } = {}): Promise<HookOut> {
  return run(
    box,
    STOP,
    cwd,
    { hook_event_name: 'Stop', ...(opts.active ? { stop_hook_active: true } : {}) },
    { GOODBOY_TEST_GATE: opts.testGate ?? 'off' },
  );
}

/** A passing review of `files`, stored under `cwd` (where a Stop in `cwd` looks for it). */
function writeReview(cwd: string, files: string[]): void {
  const dir = join(cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files,
      category: 'fix-bug',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
    }),
    'utf8',
  );
}

/** A passing layer-1 result for `files`, stored under `cwd`, with one red-green entry. */
function writeTestResult(box: Box, cwd: string, files: string[]): void {
  const testFile = join(box.root, 'tests', 'a.test.ts');
  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(testFile, 'test("x", () => { expect(1).toBe(1); });\n', 'utf8');
  const dir = join(cwd, '.claude', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: files,
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
}

function gateLog(box: Box): string {
  const p = join(box.tmp, `goodboy-session-${box.sessionId}`, 'gate-log.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

describe('cursors per project directory — accepts in a subdirectory (A3)', () => {
  test("a layer-1 accept in a subdirectory leaves the session's other edits gated at the repo root", async () => {
    const box = newBox();
    await edit(box, 'src/a.ts');
    await edit(box, 'lib/b.ts');
    writeTestResult(box, box.sub, [join(box.root, 'src', 'a.ts')]);
    writeReview(box.sub, [join(box.root, 'src', 'a.ts')]);

    // From src/: only src/a.ts is in scope, and it is tested and reviewed.
    expect((await stop(box, box.sub, { testGate: 'on' })).decision).toBeUndefined();
    expect((await stop(box, box.sub, { testGate: 'on' })).decision).toBeUndefined(); // src/ stays accepted

    // From the root: lib/b.ts was never tested.
    const atRoot = await stop(box, box.root, { testGate: 'on' });
    expect(atRoot.decision).toBe('block');
    expect(atRoot.reason).toContain('No test result covers the changed code');
    expect(atRoot.reason).toContain(join(box.root, 'lib', 'b.ts'));
  }, 30_000);

  test("a stop_hook_active review accept in a subdirectory leaves the session's other edits gated at the repo root", async () => {
    const box = newBox();
    await edit(box, 'src/a.ts');
    await edit(box, 'lib/b.ts');
    writeReview(box.sub, [join(box.root, 'src', 'a.ts')]);

    // The usual end of "block -> review -> end of turn": a stop_hook_active Stop accepts.
    expect((await stop(box, box.sub, { active: true })).decision).toBeUndefined();
    expect(gateLog(box)).toContain('accept-on-stop-active');
    expect((await stop(box, box.sub)).decision).toBeUndefined(); // the accept holds in src/

    const atRoot = await stop(box, box.root);
    expect(atRoot.decision).toBe('block');
    expect(atRoot.reason).toContain('Review is required');
    expect(atRoot.reason).toContain(join(box.root, 'lib', 'b.ts'));
  }, 30_000);

  test('an accept at the repo root covers the whole repo there, and a later root edit is gated again', async () => {
    const box = newBox();
    await edit(box, 'src/a.ts');
    await edit(box, 'lib/b.ts');
    writeReview(box.root, [join(box.root, 'src', 'a.ts'), join(box.root, 'lib', 'b.ts')]);
    expect((await stop(box, box.root)).decision).toBeUndefined();
    rmSync(join(box.root, '.claude', 'reviews'), { recursive: true, force: true });
    expect((await stop(box, box.root)).decision).toBeUndefined(); // the root cursor holds

    await edit(box, 'lib/c.ts');
    const out = await stop(box, box.root);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(join(box.root, 'lib', 'c.ts'));
    expect(out.reason ?? '').not.toContain(join(box.root, 'lib', 'b.ts'));
  }, 30_000);
});
