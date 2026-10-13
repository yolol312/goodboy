// 리뷰 커서 — "마지막으로 수락된 리뷰" 이후의 편집만 리뷰 대상으로 삼기 위한 상태.
//
// 단일 근본 원인(BUG #1 stale review, BUG #2 wrong changed-files set) 해결:
//   - Stop hook이 리뷰를 ACCEPT할 때 현재 턴 번호 + ISO 타임스탬프를 기록한다.
//   - 다음 Stop 검사에서 "리뷰 필요 파일" = 커서 턴 이후 편집된 파일.
//   - 수락되는 리뷰는 그 편집들 중 가장 최근 편집보다 더 나중이어야 한다(staleness).
//
// Location: the session state dir ($TMPDIR/goodboy-session-<id>/), next to turn.txt and
//   edits.jsonl that the cursor's turn number refers to — one file per project directory
//   (cursorFileName). The Stop hook scopes the review set to its cwd, so one cursor for
//   every cwd let an accept in a subdirectory move past the session's edits elsewhere in
//   the repo, which no Stop had looked at (hallucination-axis review).
//   { turn: number, timestamp: string, sessionId: string }
//   turn = 수락 시점의 현재 턴, timestamp = 수락 ISO
//
// Session binding (stabilization plan A3): turn numbers are per-session counters, so a
// cursor may only be compared with its own session's turns. One repo-level file in
// <project>/.claude/ broke that three ways: session A's accept at turn 22 exempted session
// B's first 22 turns; B's accept overwrote A's cursor and re-gated A's edits; and after a
// reboot cleared $TMPDIR, a resumed session restarted at turn 0 below its old cursor.
// The file still names its session, and a mismatch reads as "no cursor": the directory
// name is only a sanitized id.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';

export interface ReviewCursor {
  turn: number;
  timestamp: string;
  sessionId: string;
}

// Name bases, not file names: the file is cursorFileName(base, cwd), one per project
// directory. A path built from the base alone points at a file nothing writes.
export const REVIEW_CURSOR_FILE = '.goodboy-last-review';
// 층1 테스트 게이트 커서. 리뷰와 **분리**한다 — 공유하면 리뷰 수락이 테스트 요구까지
// 지워버려, 테스트 없이 리뷰만 돌리면 통과하는 우회가 생긴다.
export const TEST_CURSOR_FILE = '.goodboy-last-test';

/** File name of a cursor for one project directory, e.g. `.goodboy-last-review-<hash>.json`. */
export function cursorFileName(base: string, cwd: string): string {
  const key = createHash('sha256').update(resolvePath(cwd)).digest('hex').slice(0, 12);
  return `${base}-${key}.json`;
}

/** 마지막으로 수락된 리뷰 커서를 읽는다. 없거나 손상 시 null (커서 부재 = 첫 리뷰처럼 동작).
 *  Returns null as well when the cursor names another session. Never throws. */
export function readReviewCursor(cwd: string, sessionId: string): ReviewCursor | null {
  return readCursorFile(cwd, sessionId, REVIEW_CURSOR_FILE);
}

/** 리뷰 수락 시 커서를 기록한다. best-effort (실패해도 throw하지 않음). */
export function writeReviewCursor(cwd: string, turn: number, sessionId: string): void {
  writeCursorFile(cwd, sessionId, REVIEW_CURSOR_FILE, turn);
}

/** 마지막으로 수락된 테스트 커서. 리뷰 커서와 독립. Session- and cwd-bound like the review cursor. */
export function readTestCursor(cwd: string, sessionId: string): ReviewCursor | null {
  return readCursorFile(cwd, sessionId, TEST_CURSOR_FILE);
}

/** 테스트 수락 시 커서 기록. best-effort. */
export function writeTestCursor(cwd: string, turn: number, sessionId: string): void {
  writeCursorFile(cwd, sessionId, TEST_CURSOR_FILE, turn);
}

function writeCursorFile(cwd: string, sessionId: string, base: string, turn: number): void {
  try {
    const cursor: ReviewCursor = { turn, timestamp: new Date().toISOString(), sessionId };
    writeFileSync(join(ensureSessionDir(sessionId), cursorFileName(base, cwd)), JSON.stringify(cursor), 'utf8');
  } catch {
    // best-effort
  }
}

function readCursorFile(cwd: string, sessionId: string, base: string): ReviewCursor | null {
  try {
    const path = join(ensureSessionDir(sessionId), cursorFileName(base, cwd));
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReviewCursor>;
    if (
      parsed &&
      typeof parsed.turn === 'number' &&
      Number.isFinite(parsed.turn) &&
      typeof parsed.timestamp === 'string' &&
      parsed.sessionId === sessionId
    ) {
      return { turn: parsed.turn, timestamp: parsed.timestamp, sessionId };
    }
    return null;
  } catch {
    return null;
  }
}
