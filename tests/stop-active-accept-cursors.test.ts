// The stop_hook_active accept paths and the session-dir cursors (stabilization plan A3).
//
// A stop_hook_active Stop never blocks on its own, but it may accept a pending layer-1
// result or review and advance this session's cursor. These cases pin the cursor that
// each accept reads and writes: the one in this session's state dir.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { TEST_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';
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
  cwd: string;
  sessionId: string;
}

function newBox(): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-aac-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-aac-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function run(box: Box, script: string, payload: Record<string, unknown>, extraEnv: Record<string, string>): Promise<HookOut> {
  const proc = Bun.spawn(['bun', script], {
    cwd: box.cwd,
    env: { ...process.env, TMPDIR: box.tmp, HOME: box.tmp, GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', ...extraEnv },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: box.sessionId, cwd: box.cwd, ...payload })),
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

async function stop(box: Box, testGate: 'on' | 'off', stopHookActive = false): Promise<HookOut> {
  return run(box, STOP, { hook_event_name: 'Stop', ...(stopHookActive ? { stop_hook_active: true } : {}) }, { GOODBOY_TEST_GATE: testGate });
}

/** An Edit as PostToolUse sees it: records the edit and runs the auto-validation. */
async function edit(box: Box, rel: string): Promise<void> {
  const abs = resolve(box.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(box, POST, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } }, {});
}

function writeReview(box: Box, files: string[], findings: Array<Record<string, unknown>> = []): void {
  const dir = join(box.cwd, '.claude', 'reviews');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files.map((f) => resolve(box.cwd, f)),
      category: 'fix-bug',
      findings,
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
    }),
    'utf8',
  );
}

function writeTestResult(box: Box, files: string[]): void {
  const testFile = resolve(box.cwd, 'tests', 'a.test.ts');
  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(testFile, 'test("x", () => { expect(1).toBe(1); });\n', 'utf8');
  const dir = join(box.cwd, '.claude', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: files.map((f) => resolve(box.cwd, f)),
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

describe('Stop hook — stop_hook_active accepts use this session\'s cursors (A3)', () => {
  // The accept is followed by the later gates. When one of them blocks the turn, the
  // layer-1 gate is not reached again, so the accept's own cursor write is what persists.
  test('a test accept keeps its cursor when a later gate blocks the turn', async () => {
    const box = newBox();
    writeFileSync(
      join(box.cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: 'exit 1' } }),
      'utf8',
    );
    await edit(box, 'src/a.ts'); // recorded, and the typecheck fails
    writeTestResult(box, ['src/a.ts']);

    const out = await stop(box, 'on', true);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('자동 검증이 실패한 상태입니다');
    expect(existsSync(join(box.tmp, `goodboy-session-${box.sessionId}`, cursorFileName(TEST_CURSOR_FILE, box.cwd)))).toBe(true);
  }, 30_000);

  // An edit accepted at an earlier Stop is behind this session's review cursor, so a new
  // review needs to cover only the later edit.
  test('a review accept is scoped by this session\'s cursor', async () => {
    const box = newBox();
    await edit(box, 'src/old.ts');
    writeReview(box, ['src/old.ts']);
    expect((await stop(box, 'off')).decision).toBeUndefined(); // accepted: the cursor moves past old.ts

    await edit(box, 'src/new.ts');
    writeReview(box, ['src/new.ts'], [{ file: resolve(box.cwd, 'src/new.ts'), issue: 'naming', severity: 'medium' }]);
    const active = await stop(box, 'off', true);
    expect(active.decision).toBeUndefined();
    expect(active.systemMessage ?? '').toContain('참고할 발견사항'); // accepted on this path

    expect((await stop(box, 'off')).decision).toBeUndefined();
  }, 30_000);
});
