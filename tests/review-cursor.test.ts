import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { readReviewCursor, writeReviewCursor } from '../lib/review-cursor';
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

describe('review cursor persistence', () => {
  test('absent cursor => null; write then read round-trips', () => {
    const cwd = newCwd();
    expect(readReviewCursor(cwd)).toBeNull();
    writeReviewCursor(cwd, 7);
    const c = readReviewCursor(cwd);
    expect(c).not.toBeNull();
    expect(c!.turn).toBe(7);
    expect(typeof c!.timestamp).toBe('string');
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
