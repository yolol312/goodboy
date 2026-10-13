// Review findings count for a session only from reviews of its own files (stabilization
// plan A3), end to end with the real PostToolUse and Stop hooks.
//
// .claude/reviews/ is shared by every session of the repo. With per-session cursors, a
// session without a cursor saw every open finding in the window: another session's high
// finding blocked a clean review, held the stop_hook_active accept, and its medium
// findings were reported as this session's (hallucination-axis review).
// No lib API is imported, so the file also runs against older trees (red runs).

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

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-ssf-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-ssf-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd };
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function run(repo: Repo, script: string, payload: Record<string, unknown>): Promise<HookOut> {
  const proc = Bun.spawn(['bun', script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      TMPDIR: repo.tmp,
      HOME: repo.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_TEST_GATE: 'off',
    },
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: repo.cwd, ...payload })),
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

async function edit(repo: Repo, sessionId: string, rel: string): Promise<void> {
  const abs = resolve(repo.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(repo, POST, { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
}

async function stop(repo: Repo, sessionId: string, active = false): Promise<HookOut> {
  return run(repo, STOP, { session_id: sessionId, hook_event_name: 'Stop', ...(active ? { stop_hook_active: true } : {}) });
}

/** A review of `files` (future-dated: newer than every edit; every dimension). */
function writeReview(repo: Repo, name: string, files: string[], findings: Array<Record<string, unknown>> = []): void {
  const dir = join(repo.cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files.map((f) => resolve(repo.cwd, f)),
      category: 'fix-bug',
      findings,
      unknown_assumptions_checked: [],
      verdict: findings.length > 0 ? 'needs-changes' : 'pass',
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
    }),
    'utf8',
  );
}

function acceptedOnStopActive(repo: Repo, sessionId: string): boolean {
  const p = join(repo.tmp, `goodboy-session-${sessionId}`, 'gate-log.jsonl');
  return existsSync(p) && readFileSync(p, 'utf8').includes('accept-on-stop-active');
}

describe('findings per session — the stop_hook_active accept (A3)', () => {
  test("another session's open high finding does not hold this session's accept; its own does", async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await edit(repo, 'sess-b', 'src/b.ts');
    writeReview(repo, 'a.json', ['src/a.ts'], [{ file: resolve(repo.cwd, 'src/a.ts'), issue: 'unchecked input', severity: 'high' }]);
    writeReview(repo, 'b.json', ['src/b.ts']);

    expect((await stop(repo, 'sess-b', true)).decision).toBeUndefined();
    expect(acceptedOnStopActive(repo, 'sess-b')).toBe(true);
    const b = await stop(repo, 'sess-b');
    expect(b.decision).toBeUndefined();
    expect(`${b.reason ?? ''}${b.systemMessage ?? ''}`).not.toContain('unchecked input');

    expect((await stop(repo, 'sess-a', true)).decision).toBeUndefined(); // never blocks on this path
    expect(acceptedOnStopActive(repo, 'sess-a')).toBe(false); // held by its own high finding
    const a = await stop(repo, 'sess-a');
    expect(a.decision).toBe('block');
    expect(a.reason).toContain('unchecked input');
  }, 30_000);
});

describe('findings per session — files the session edited before its last accept (A3, v0.26.6)', () => {
  // v0.26.6: findings are evaluated over every trusted review since the cursor, so a newer
  //   review of a file outside the current change set still counts. The session filter has
  //   to keep that for files this session edited earlier, not only since its cursor.
  test('a newer review of an earlier-accepted file still blocks on its high finding', async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    writeReview(repo, 'a1.json', ['src/a.ts']);
    expect((await stop(repo, 'sess-a')).decision).toBeUndefined(); // a.ts accepted

    await edit(repo, 'sess-a', 'src/b.ts'); // the next change set is b.ts only
    writeReview(repo, 'b.json', ['src/b.ts']);
    writeReview(repo, 'a2.json', ['src/a.ts'], [{ file: resolve(repo.cwd, 'src/a.ts'), issue: 'token logged in plain text', severity: 'high' }]);
    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('token logged in plain text');
  }, 30_000);
});

describe("findings per session — a review of this session's file (A3)", () => {
  // A review counts for the session because it reviewed the session's file; its findings
  //   count in full, also one that names a file the session did not edit (the review of
  //   this change found the problem there).
  test('its high finding on a file the session did not edit still blocks', async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    writeReview(repo, 'a.json', ['src/a.ts'], [{ file: resolve(repo.cwd, 'src/util.ts'), issue: 'caller now passes null', severity: 'high' }]);
    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('caller now passes null');
  }, 30_000);
});

describe('findings per session — medium findings in the accept message (A3)', () => {
  test("another session's medium finding is not reported to this session; its own is", async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await edit(repo, 'sess-b', 'src/b.ts');
    await edit(repo, 'sess-c', 'src/c.ts');
    writeReview(repo, 'a.json', ['src/a.ts'], [{ file: resolve(repo.cwd, 'src/a.ts'), issue: 'naming nit in a', severity: 'medium' }]);
    writeReview(repo, 'b.json', ['src/b.ts']);
    writeReview(repo, 'c.json', ['src/c.ts']);

    const b = await stop(repo, 'sess-b'); // the full Stop accept
    expect(b.decision).toBeUndefined();
    expect(b.systemMessage ?? '').not.toContain('naming nit in a');

    const c = await stop(repo, 'sess-c', true); // the stop_hook_active accept
    expect(acceptedOnStopActive(repo, 'sess-c')).toBe(true);
    expect(c.systemMessage ?? '').not.toContain('naming nit in a');

    const a = await stop(repo, 'sess-a');
    expect(a.decision).toBeUndefined();
    expect(a.systemMessage).toContain('naming nit in a');
  }, 30_000);
});
