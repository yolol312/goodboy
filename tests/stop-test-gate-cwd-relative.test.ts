// Layer 1 tells test files from code by the path below the cwd, not the absolute path,
// end to end with the real PostToolUse and Stop hooks.
//
// isTestFile() matches tests/, spec/, __tests__/ and e2e/ path segments. Fed the absolute
// path, it made every file of a repo that lives under such a directory a "test file", and
// layer 1 never asked for a test there (layer-1 test run). That applied on every path that
// filters the edits: the gate's change list, the coverage check, and the stop_hook_active
// accept. No lib API is imported, so the file also runs against older trees (red runs).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

/** A repo at <parent>/<segment>/proj, e.g. ~/tests/proj. */
function newBox(segment: string): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-tcr-tmp-'));
  tmpDirs.push(tmp);
  const parent = mkdtempSync(join(tmpdir(), 'goodboy-tcr-parent-'));
  tmpDirs.push(parent);
  const cwd = join(parent, segment, 'proj');
  mkdirSync(cwd, { recursive: true });
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

interface HookOut {
  decision?: string;
  reason?: string;
}

async function run(box: Box, script: string, payload: Record<string, unknown>): Promise<HookOut> {
  const proc = Bun.spawn(['bun', script], {
    cwd: box.cwd,
    env: {
      ...process.env,
      TMPDIR: box.tmp,
      HOME: box.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_TEST_GATE: 'on',
    },
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

async function edit(box: Box, rel: string): Promise<void> {
  const abs = resolve(box.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(box, POST, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
}

async function stop(box: Box, active = false): Promise<HookOut> {
  return run(box, STOP, { hook_event_name: 'Stop', ...(active ? { stop_hook_active: true } : {}) });
}

/** A passing layer-1 result for `files` (repo-relative), with one red-green entry. */
function writeTestResult(box: Box, files: string[]): void {
  const testFile = join(box.cwd, 'tests', 'a.test.ts');
  mkdirSync(dirname(testFile), { recursive: true });
  if (!existsSync(testFile)) writeFileSync(testFile, 'test("x", () => { expect(1).toBe(1); });\n', 'utf8');
  const dir = join(box.cwd, '.claude', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: files.map((f) => join(box.cwd, f)),
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

describe('layer 1 for a repo that lives under a test-like directory', () => {
  for (const segment of ['tests', 'spec', '__tests__', 'e2e']) {
    test(`under ${segment}/: a result that does not cover the change is rejected, and the repo's own test file stays exempt`, async () => {
      const box = newBox(segment);
      await edit(box, 'src/a.ts');
      await edit(box, 'tests/a.test.ts');
      writeTestResult(box, ['src/other.ts']);

      const out = await stop(box);
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('테스트 검증 실패');
      expect(out.reason).toContain(join(box.cwd, 'src', 'a.ts'));
      expect(out.reason ?? '').not.toContain('a.test.ts');
    }, 30_000);
  }

  test('under tests/: a stop_hook_active Stop accepts a pending result and goes on to the review', async () => {
    const box = newBox('tests');
    await edit(box, 'src/a.ts');
    writeTestResult(box, ['src/a.ts']);

    const out = await stop(box, true);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review is required');
    expect(gateLog(box)).toContain('continue-to-review-after-accept');
  }, 30_000);
});
