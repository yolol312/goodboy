import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ensureSessionDir,
  getEditsSince,
  getLatestEditTimestampSince,
  incrementTurn,
  recordEdit,
  recordRead,
  wasFileEditedRecently,
  wasFileReadRecently,
} from '../lib/file-tracker';
import {
  REVIEW_CURSOR_FILE,
  TEST_CURSOR_FILE,
  cursorFileName,
  readReviewCursor,
  readTestCursor,
  writeReviewCursor,
  writeTestCursor,
} from '../lib/review-cursor';
import { validateReview } from '../lib/review-validator';
import type { ReviewResult } from '../lib/types';

// 각 테스트는 고유한 sessionId를 써서 tmpdir 세션 디렉터리 충돌을 피한다.
const sessions: string[] = [];
function newSession(): string {
  const id = `goodboy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessions.push(id);
  return id;
}

afterEach(() => {
  while (sessions.length) {
    const id = sessions.pop()!;
    try {
      rmSync(ensureSessionDir(id), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const cwds: string[] = [];
function newCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-cursor-'));
  cwds.push(d);
  return d;
}
afterEach(() => {
  while (cwds.length) {
    const d = cwds.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function review(partial: Partial<ReviewResult>): ReviewResult {
  return {
    timestamp: '2026-01-01T00:00:00Z',
    reviewed_files: [],
    category: 'add-feature',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    ...partial,
  };
}

/** temp cwd에 실제 파일을 만들고 절대경로를 돌려준다.
 *  (A) 리뷰 스코프의 existsSync 필터를 통과시키기 위해 실존 파일을 전제한다. */
function touch(cwd: string, name: string): string {
  const abs = resolve(cwd, name);
  writeFileSync(abs, '', 'utf8');
  return abs;
}

describe('getEditsSince', () => {
  // Cursor semantics: getEditsSince(cursorTurn) returns edits with turn >= cursorTurn.
  // The cursor stores the turn of the accepting Stop; edits the agent makes afterward
  // are recorded at that same turn (turn only increments inside Stop), so >= is correct.
  test('returns files edited at or after the cursor turn, excluding earlier features', () => {
    const s = newSession();
    const cwd = newCwd();
    // turn 1: feature-1 files (the accepting Stop set turn=1 and the cursor=1)
    recordEdit(s, touch(cwd, 'tsconfig.json'), 1);
    recordEdit(s, touch(cwd, 'feature1.ts'), 1);
    // turn 2: feature-2 files (next accepting Stop would set cursor=2)
    const f2 = touch(cwd, 'feature2.ts');
    const f2t = touch(cwd, 'feature2.test.ts');
    recordEdit(s, f2, 2);
    recordEdit(s, f2t, 2);

    const sinceTurn2 = getEditsSince(s, 2).map((f) => resolve(f)).sort();
    expect(sinceTurn2).toEqual([f2, f2t].sort());
    // tsconfig.json from feature-1 is NOT included (BUG #2 scope fix)
    expect(sinceTurn2).not.toContain(resolve(cwd, 'tsconfig.json'));
  });

  test('cursorTurn 0 => all session edits (first review / cursor absent)', () => {
    const s = newSession();
    const cwd = newCwd();
    const a = touch(cwd, 'a.ts');
    const b = touch(cwd, 'b.ts');
    recordEdit(s, a, 1);
    recordEdit(s, b, 2);
    const all = getEditsSince(s, 0).map((f) => resolve(f)).sort();
    expect(all).toEqual([a, b].sort());
  });

  test('dedupes the same file edited multiple times', () => {
    const s = newSession();
    const cwd = newCwd();
    const a = touch(cwd, 'a.ts');
    recordEdit(s, a, 2);
    recordEdit(s, a, 3);
    expect(getEditsSince(s, 2)).toHaveLength(1);
  });
});

describe('getLatestEditTimestampSince', () => {
  test('returns the max timestamp among edits at/after the cursor turn', () => {
    const s = newSession();
    const cwd = newCwd();
    recordEdit(s, touch(cwd, 'a.ts'), 1); // before cursor
    const b = touch(cwd, 'b.ts');
    recordEdit(s, b, 2);
    const ts = getLatestEditTimestampSince(s, 2);
    expect(ts).not.toBeNull();
    expect(getEditsSince(s, 2)).toEqual([b]);
  });

  test('null when no edits at/after the cursor turn', () => {
    const s = newSession();
    const cwd = newCwd();
    recordEdit(s, touch(cwd, 'a.ts'), 1);
    expect(getLatestEditTimestampSince(s, 5)).toBeNull();
  });
});

describe('wasFileEditedRecently (FRICTION #4)', () => {
  test('a prior Write/Edit of the path satisfies the recency check', () => {
    const s = newSession();
    incrementTurn(s); // turn 1
    recordEdit(s, '/repo/new.ts', 1);
    expect(wasFileEditedRecently(s, '/repo/new.ts', 1, 20)).toBe(true);
    // a file never edited is not "recently edited"
    expect(wasFileEditedRecently(s, '/repo/other.ts', 1, 20)).toBe(false);
    // and it was never Read either
    expect(wasFileReadRecently(s, '/repo/new.ts', 1, 20)).toBe(false);
  });
});

// Cursors are per session and per project directory (A3): stored in the session state dir.
describe('review cursor persistence', () => {
  test('absent cursor => null; write then read round-trips', () => {
    const s = newSession();
    const cwd = newCwd();
    expect(readReviewCursor(cwd, s)).toBeNull();
    writeReviewCursor(cwd, 7, s);
    const c = readReviewCursor(cwd, s);
    expect(c).not.toBeNull();
    expect(c!.turn).toBe(7);
    expect(c!.sessionId).toBe(s);
    expect(typeof c!.timestamp).toBe('string');
  });

  // The cursor lives in the session state dir, next to the turn counter it refers to.
  test('cursors are stored in the session state dir', () => {
    const s = newSession();
    const cwd = newCwd();
    writeReviewCursor(cwd, 3, s);
    writeTestCursor(cwd, 4, s);
    expect(existsSync(join(ensureSessionDir(s), cursorFileName(REVIEW_CURSOR_FILE, cwd)))).toBe(true);
    expect(existsSync(join(ensureSessionDir(s), cursorFileName(TEST_CURSOR_FILE, cwd)))).toBe(true);
  });

  // A3: turns are per-session, so another session's cursor must not be applied.
  test("another session's cursor reads as null", () => {
    const a = newSession();
    const b = newSession();
    const cwd = newCwd();
    writeReviewCursor(cwd, 22, a);
    expect(readReviewCursor(cwd, b)).toBeNull();
    writeTestCursor(cwd, 18, a);
    expect(readTestCursor(cwd, b)).toBeNull();
    expect(readTestCursor(cwd, a)!.turn).toBe(18);
  });

  // Layer-1 test run: with one repo-level file, session B's accept overwrote session A's
  // cursor, so A's already-accepted edits were gated again from "retry 1/3".
  test("one session's accept does not overwrite another session's cursor", () => {
    const a = newSession();
    const b = newSession();
    const cwd = newCwd();
    writeReviewCursor(cwd, 22, a);
    writeTestCursor(cwd, 21, a);
    writeReviewCursor(cwd, 5, b);
    writeTestCursor(cwd, 4, b);
    expect(readReviewCursor(cwd, a)!.turn).toBe(22);
    expect(readTestCursor(cwd, a)!.turn).toBe(21);
    expect(readReviewCursor(cwd, b)!.turn).toBe(5);
  });

  // Hallucination-axis review: the Stop hook scopes the review set to its cwd, so an
  // accept from a subdirectory must not move the cursor of the repo root.
  test('each project directory of a session has its own cursor', () => {
    const s = newSession();
    const root = newCwd();
    const sub = join(root, 'src');
    writeReviewCursor(sub, 9, s);
    writeTestCursor(sub, 9, s);
    expect(readReviewCursor(root, s)).toBeNull();
    expect(readTestCursor(root, s)).toBeNull();
    expect(readReviewCursor(sub, s)!.turn).toBe(9);
    expect(cursorFileName(REVIEW_CURSOR_FILE, root)).not.toBe(cursorFileName(REVIEW_CURSOR_FILE, sub));
  });

  test('a cursor without a matching sessionId reads as null', () => {
    const s = newSession();
    const cwd = newCwd();
    const path = join(ensureSessionDir(s), cursorFileName(REVIEW_CURSOR_FILE, cwd));
    writeFileSync(path, JSON.stringify({ turn: 22, timestamp: new Date().toISOString() }), 'utf8');
    expect(readReviewCursor(cwd, s)).toBeNull();
    writeFileSync(path, JSON.stringify({ turn: 22, timestamp: new Date().toISOString(), sessionId: 'other' }), 'utf8');
    expect(readReviewCursor(cwd, s)).toBeNull();
  });

  test('a session id that is not a string reads as no cursor instead of throwing', () => {
    expect(readReviewCursor(newCwd(), 42 as unknown as string)).toBeNull();
    expect(() => writeReviewCursor(newCwd(), 1, 42 as unknown as string)).not.toThrow();
  });
});

// BUG #2 regression at the validateReview level: a tight per-feature review covering
// exactly the edits-since-cursor is ACCEPTED even though earlier-feature files exist.
describe('BUG #2 regression: per-feature scope', () => {
  test('review covering only feature-2 files passes when changedFiles is scoped to feature-2', () => {
    const s = newSession();
    const cwd = newCwd();
    // feature-1 (turn 1) then feature-2 (turn 2)
    recordEdit(s, touch(cwd, 'tsconfig.json'), 1);
    recordEdit(s, touch(cwd, 'feature2.ts'), 2);

    const changed = getEditsSince(s, 2); // cursor at turn 2 => only feature-2
    const latest = getLatestEditTimestampSince(s, 2);

    // review only lists feature-2 file, written AFTER the edit.
    //   near-future(now+60s): staleness는 통과하되 미래-거부(스큐 5분) 안에 든다(E 보안).
    const r = validateReview(
      review({
        reviewed_files: changed,
        timestamp: new Date(Date.now() + 60_000).toISOString(),
      }),
      changed,
      latest,
    );
    expect(r.ok).toBe(true);
  });
});
