// Two sessions in one repo (stabilization plan A3). The review and test cursors, the
// auto-validation failure marker, and the task state each used to be one file in
// <repo>/.claude/, so whichever session wrote last decided the other session's gates.
//
// Every step runs the real hooks (UserPromptSubmit, PostToolUse, Stop, statusline). The
// only files written directly are the review and test result JSON files, which are the
// documented outputs of the review and test subagents.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const UPS = join(ROOT, 'hooks', 'user-prompt-submit.ts');
const STATUSLINE = join(ROOT, 'statusline', 'statusline.ts');
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

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-cs-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-cs-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd };
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function run(
  repo: Repo,
  script: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn(['bun', script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      TMPDIR: repo.tmp,
      HOME: repo.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_CONCISE_DEFAULT: 'off',
      GOODBOY_ASK_UNCLEAR: 'off',
      GOODBOY_DISABLE_DELEGATION: '1',
      ...extraEnv,
    },
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: repo.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

function parse(stdout: string): HookOut {
  try {
    return JSON.parse(stdout) as HookOut;
  } catch {
    return {};
  }
}

async function stop(repo: Repo, sessionId: string, testGate: 'on' | 'off' = 'off'): Promise<HookOut> {
  return parse(await run(repo, STOP, { session_id: sessionId, hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: testGate }));
}

/** An Edit as PostToolUse sees it: records the edit and runs the auto-validation. */
async function edit(repo: Repo, sessionId: string, rel: string, extraEnv: Record<string, string> = {}): Promise<void> {
  const abs = resolve(repo.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(
    repo,
    POST,
    {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: abs },
    },
    extraEnv,
  );
}

async function submit(repo: Repo, sessionId: string, prompt: string): Promise<void> {
  await run(repo, UPS, { session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt });
}

function setTypecheck(repo: Repo, script: string): void {
  writeFileSync(
    join(repo.cwd, 'package.json'),
    JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: script } }),
    'utf8',
  );
}

/** A passing review of `files` (future-dated: newer than every edit; every dimension). */
function writeReview(
  repo: Repo,
  files: string[],
  opts: { name?: string; findings?: Array<Record<string, unknown>> } = {},
): void {
  const dir = join(repo.cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, opts.name ?? 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files.map((f) => resolve(repo.cwd, f)),
      category: 'fix-bug',
      findings: opts.findings ?? [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
    }),
    'utf8',
  );
}

/** A passing layer-1 test result for `files`, with one red-green acceptance entry. */
function writeTestResult(repo: Repo, files: string[]): void {
  const testFile = resolve(repo.cwd, 'tests', 'a.test.ts');
  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(testFile, 'test("x", () => { expect(1).toBe(1); });\n', 'utf8');
  const dir = join(repo.cwd, '.claude', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: files.map((f) => resolve(repo.cwd, f)),
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

/** Advances a session's turn counter with Stops that have nothing to gate. */
async function idleTurns(repo: Repo, sessionId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const out = await stop(repo, sessionId);
    expect(out.decision).toBeUndefined();
  }
}

describe('two sessions in one repo — review and test cursors (A3)', () => {
  // Session A accepts at turn 4; session B, at its turn 1, accepts afterwards. With one
  // repo-level cursor, B's accept replaced A's, and A's edit from turn 3 was gated again.
  test("another session's review accept does not re-open this session's accepted edits", async () => {
    const repo = newRepo();
    await idleTurns(repo, 'sess-a', 3);
    await edit(repo, 'sess-a', 'src/a.ts');
    await edit(repo, 'sess-b', 'src/b.ts');
    writeReview(repo, ['src/a.ts', 'src/b.ts']);
    expect((await stop(repo, 'sess-a')).decision).toBeUndefined(); // A accepts
    expect((await stop(repo, 'sess-b')).decision).toBeUndefined(); // B accepts
    rmSync(join(repo.cwd, '.claude', 'reviews'), { recursive: true, force: true });

    expect((await stop(repo, 'sess-a')).decision).toBeUndefined();
    expect((await stop(repo, 'sess-b')).decision).toBeUndefined();

    // Control: without a review, an edit nobody accepted is gated, so the passes above
    // come from each session's own cursor.
    await edit(repo, 'sess-c', 'src/c.ts');
    const c = await stop(repo, 'sess-c');
    expect(c.decision).toBe('block');
    expect(c.reason).toContain('Review is required');
  }, 30_000);

  test("another session's test accept does not re-open this session's tested edits", async () => {
    const repo = newRepo();
    await idleTurns(repo, 'sess-a', 3);
    await edit(repo, 'sess-a', 'src/a.ts');
    await edit(repo, 'sess-b', 'src/b.ts');
    writeTestResult(repo, ['src/a.ts', 'src/b.ts']);
    writeReview(repo, ['src/a.ts', 'src/b.ts']);
    expect((await stop(repo, 'sess-a', 'on')).decision).toBeUndefined(); // A accepts both layers
    expect((await stop(repo, 'sess-b', 'on')).decision).toBeUndefined(); // B accepts both layers
    rmSync(join(repo.cwd, '.claude', 'tests'), { recursive: true, force: true });
    rmSync(join(repo.cwd, '.claude', 'reviews'), { recursive: true, force: true });

    expect((await stop(repo, 'sess-a', 'on')).decision).toBeUndefined();
    expect((await stop(repo, 'sess-b', 'on')).decision).toBeUndefined();

    // Control: without a test result, an untested edit is gated by layer 1.
    await edit(repo, 'sess-c', 'src/c.ts');
    const c = await stop(repo, 'sess-c', 'on');
    expect(c.decision).toBe('block');
    expect(c.reason).toContain('No test result covers the changed code');
  }, 30_000);
});

describe('two sessions in one repo — review findings (A3)', () => {
  // Hallucination-axis review: .claude/reviews/ is shared, and with per-session cursors a
  //   session without a cursor saw every open finding — A's high finding blocked B's clean
  //   review. Findings now count only from reviews of the session's own files.
  test("another session's open high finding does not block this session", async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await edit(repo, 'sess-b', 'src/b.ts');
    writeReview(repo, ['src/a.ts'], {
      name: 'a.json',
      findings: [{ file: resolve(repo.cwd, 'src/a.ts'), issue: 'unchecked input', severity: 'high' }],
    });
    writeReview(repo, ['src/b.ts'], { name: 'b.json' });

    expect((await stop(repo, 'sess-b')).decision).toBeUndefined();
    const a = await stop(repo, 'sess-a');
    expect(a.decision).toBe('block');
    expect(a.reason).toContain('unchecked input');
  }, 30_000);
});

describe('two sessions in one repo — auto-validation failure marker (A3)', () => {
  // The checks run on the tree both sessions share: once any session passes the same
  //   command again, this session's older failure is stale (hallucination-axis review —
  //   per-session markers alone kept blocking A after B had fixed the tree).
  test("another session's later pass of the same check lifts this session's stale failure", async () => {
    const repo = newRepo();
    setTypecheck(repo, 'exit 1');
    await edit(repo, 'sess-a', 'a.ts'); // A's typecheck fails
    setTypecheck(repo, 'exit 0');
    await edit(repo, 'sess-b', 'b.ts'); // B's typecheck passes on the fixed tree

    for (const s of ['sess-a', 'sess-b']) {
      const out = await stop(repo, s);
      expect(out.reason ?? '').not.toContain('자동 검증이 실패한 상태입니다');
    }
  }, 30_000);

  test("a pass of other checks does not lift this session's failure", async () => {
    const repo = newRepo();
    writeFileSync(
      join(repo.cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: 'exit 0', lint: 'exit 1' } }),
      'utf8',
    );
    await edit(repo, 'sess-a', 'a.ts', { GOODBOY_AUTOVALIDATE: 'all' }); // A's lint fails
    await edit(repo, 'sess-b', 'b.ts'); // B checks only the typecheck, which passes

    const a = await stop(repo, 'sess-a');
    expect(a.decision).toBe('block');
    expect(a.reason).toContain('자동 검증이 실패한 상태입니다: bun run lint');
  }, 30_000);

  test("another session's failing validation does not take over this session's marker", async () => {
    const repo = newRepo();
    setTypecheck(repo, 'exit 1');
    await edit(repo, 'sess-a', 'a.ts');
    await edit(repo, 'sess-b', 'b.ts');

    for (const s of ['sess-a', 'sess-b']) {
      const out = await stop(repo, s);
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('자동 검증이 실패한 상태입니다: bun run typecheck');
    }
  }, 30_000);
});

describe('two sessions in one repo — task state (A3)', () => {
  function snapshot(repo: Repo, sessionId: string): { category?: string | null; risk?: string | null } {
    return JSON.parse(readFileSync(join(repo.tmp, `goodboy-session-${sessionId}`, 'status.json'), 'utf8')) as {
      category?: string | null;
      risk?: string | null;
    };
  }

  test("the Stop snapshot and the statusline keep this session's category after another session's command", async () => {
    const repo = newRepo();
    await submit(repo, 'sess-a', '/migrate rename the users.email column');
    await submit(repo, 'sess-b', '/fix-bug add a product search page');

    await stop(repo, 'sess-a');
    expect(snapshot(repo, 'sess-a')).toMatchObject({ category: 'migrate', risk: 'risky' });
    const line = await run(repo, STATUSLINE, { session_id: 'sess-a' });
    expect(line).toContain('🔴migrate');

    await stop(repo, 'sess-b');
    expect(snapshot(repo, 'sess-b')).toMatchObject({ category: 'fix-bug', risk: 'simple' });
  }, 30_000);
});
