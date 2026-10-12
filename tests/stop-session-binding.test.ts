// Stabilization plan A3: review/test cursors and retry counters are session-bound.
// Turn numbers are per-session counters, so state written by session A must never
// exempt (or escape) session B. Before A3, session A accepting a review at turn 22 left a
// repo-level cursor that silently skipped review for session B's first 22 turns. Cursors
// and counters now live in each session's state dir.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { REVIEW_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

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

function newSandbox(): { tmp: string; cwd: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-sb-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-sb-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd };
}

/** Seed file-tracker state for one session (edits at `turn`) and create the files. */
function seedSession(tmp: string, sessionId: string, turn: number, editFiles: string[], cwd: string): void {
  const dir = join(tmp, `goodboy-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles.map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts })).join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
  for (const f of editFiles) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
}

/** Writes a review cursor where `sessionId`'s Stop in `cwd` keeps it: its session state dir. */
function writeCursor(tmp: string, sessionId: string, cwd: string, cursor: Record<string, unknown>): void {
  const dir = join(tmp, `goodboy-session-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, cursorFileName(REVIEW_CURSOR_FILE, cwd)), JSON.stringify(cursor), 'utf8');
}

/** A pass review that does not cover the edited file, so review validation fails. */
function writeUncoveringReview(cwd: string): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(
    join(reviewsDir, 'review.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      reviewed_files: [resolve(cwd, 'other.ts')],
      category: 'refactor',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: [],
    }),
    'utf8',
  );
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runStop(tmp: string, cwd: string, sessionId: string): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    // The layer-1 test gate fires before the review gate; turn it off to isolate review.
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'off' },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop' })),
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

describe('Stop hook — session-bound state (A3)', () => {
  test("another session's review cursor does not exempt this session's edits", async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-b', 1, ['src/a.ts'], cwd);
    writeCursor(tmp, 'sess-a', cwd, { turn: 22, timestamp: new Date().toISOString(), sessionId: 'sess-a' });
    const out = await runStop(tmp, cwd, 'sess-b');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('a.ts');
    // A9: the instruction names a real CLI path, not an unset ${CLAUDE_PLUGIN_ROOT}.
    const cli = /bun "([^"]+)" review-axes/.exec(out.reason ?? '')?.[1] ?? '';
    expect(existsSync(cli)).toBe(true);
    expect(out.reason).not.toContain('/review-changes');
  });

  test("the session's own cursor still scopes review to later edits", async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-b', 1, ['src/a.ts'], cwd);
    writeCursor(tmp, 'sess-b', cwd, { turn: 22, timestamp: new Date().toISOString(), sessionId: 'sess-b' });
    const out = await runStop(tmp, cwd, 'sess-b');
    expect(out.decision).toBeUndefined();
  });

  test('a cursor without sessionId counts as no cursor', async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-b', 1, ['src/a.ts'], cwd);
    writeCursor(tmp, 'sess-b', cwd, { turn: 22, timestamp: new Date().toISOString() });
    const out = await runStop(tmp, cwd, 'sess-b');
    expect(out.decision).toBe('block');
  });

  // Hallucination-axis review: the review set is scoped to the Stop's cwd, so an accept in a
  //   subdirectory must not move the cursor past the session's edits elsewhere in the repo.
  test('an accept from a subdirectory does not exempt the edits outside it', async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-b', 1, ['src/a.ts', 'lib/b.ts'], cwd);
    writeFileSync(join(tmp, 'goodboy-session-sess-b', 'turn.txt'), '5', 'utf8'); // accept after the edits
    const sub = join(cwd, 'src');
    const reviews = join(sub, '.claude', 'reviews');
    mkdirSync(reviews, { recursive: true });
    writeFileSync(
      join(reviews, 'review.json'),
      JSON.stringify({
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        reviewed_files: [resolve(cwd, 'src/a.ts')],
        category: 'refactor',
        findings: [],
        unknown_assumptions_checked: [],
        verdict: 'pass',
        dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
      }),
      'utf8',
    );
    expect((await runStop(tmp, sub, 'sess-b')).decision).toBeUndefined(); // accepted in src/
    const root = await runStop(tmp, cwd, 'sess-b');
    expect(root.decision).toBe('block');
    expect(root.reason).toContain('b.ts');
  });

  // The cursor moved from <project>/.claude/ to the session dir (one repo-level file let
  // concurrent sessions overwrite each other's cursor). The old file is not read at all,
  // even when it carries this session's id.
  test('a legacy repo-level cursor is ignored, even with this session id', async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-b', 1, ['src/a.ts'], cwd);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', '.goodboy-last-review.json'),
      JSON.stringify({ turn: 22, timestamp: new Date().toISOString(), sessionId: 'sess-b' }),
      'utf8',
    );
    const out = await runStop(tmp, cwd, 'sess-b');
    expect(out.decision).toBe('block');
  });

  test("another session's retry counter does not grant an escape", async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-b', 1, ['src/a.ts'], cwd);
    writeUncoveringReview(cwd);
    // Session A already used two of its three attempts (counters live in the session dir).
    mkdirSync(join(tmp, 'goodboy-session-sess-a'), { recursive: true });
    writeFileSync(join(tmp, 'goodboy-session-sess-a', '.goodboy-review-validate-retry-count.txt'), '2', 'utf8');
    const out = await runStop(tmp, cwd, 'sess-b');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('1/3');
    // ...and session B's block leaves session A's budget untouched.
    expect(readFileSync(join(tmp, 'goodboy-session-sess-a', '.goodboy-review-validate-retry-count.txt'), 'utf8')).toBe('2');
  });

  test('a legacy repo-level retry counter is ignored', async () => {
    const { tmp, cwd } = newSandbox();
    seedSession(tmp, 'sess-b', 1, ['src/a.ts'], cwd);
    writeUncoveringReview(cwd);
    writeFileSync(join(cwd, '.claude', '.goodboy-review-validate-retry-count.txt'), '2', 'utf8');
    const out = await runStop(tmp, cwd, 'sess-b');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('1/3');
  });
});
