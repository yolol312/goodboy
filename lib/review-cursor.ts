// 리뷰 커서 — "마지막으로 수락된 리뷰" 이후의 편집만 리뷰 대상으로 삼기 위한 상태.
//
// 단일 근본 원인(BUG #1 stale review, BUG #2 wrong changed-files set) 해결:
//   - Stop hook이 리뷰를 ACCEPT할 때 현재 턴 번호 + ISO 타임스탬프를 기록한다.
//   - 다음 Stop 검사에서 "리뷰 필요 파일" = 커서 턴 이후 편집된 파일.
//   - 수락되는 리뷰는 그 편집들 중 가장 최근 편집보다 더 나중이어야 한다(staleness).
//
// 저장 위치: <project>/.claude/.goodboy-last-review.json
//   { turn: number, timestamp: string }  // turn = 수락 시점의 현재 턴, timestamp = 수락 ISO

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';

export interface ReviewCursor {
  turn: number;
  timestamp: string;
}

const REVIEW_CURSOR_FILE = '.goodboy-last-review.json';
// 층1 테스트 게이트 커서. 리뷰와 **분리**한다 — 공유하면 리뷰 수락이 테스트 요구까지
// 지워버려, 테스트 없이 리뷰만 돌리면 통과하는 우회가 생긴다.
const TEST_CURSOR_FILE = '.goodboy-last-test.json';

function cursorPathFor(cwd: string, file: string): string {
  return resolvePath(cwd, '.claude', file);
}

function cursorPath(cwd: string): string {
  return cursorPathFor(cwd, REVIEW_CURSOR_FILE);
}

/** 마지막으로 수락된 리뷰 커서를 읽는다. 없거나 손상 시 null (커서 부재 = 첫 리뷰처럼 동작). */
export function readReviewCursor(cwd: string): ReviewCursor | null {
  try {
    const path = cursorPath(cwd);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ReviewCursor>;
    if (
      parsed &&
      typeof parsed.turn === 'number' &&
      Number.isFinite(parsed.turn) &&
      typeof parsed.timestamp === 'string'
    ) {
      return { turn: parsed.turn, timestamp: parsed.timestamp };
    }
    return null;
  } catch {
    return null;
  }
}

/** 리뷰 수락 시 커서를 기록한다. best-effort (실패해도 throw하지 않음). */
export function writeReviewCursor(cwd: string, turn: number): void {
  writeCursorFile(cursorPath(cwd), turn);
}

function writeCursorFile(path: string, turn: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const cursor: ReviewCursor = { turn, timestamp: new Date().toISOString() };
    writeFileSync(path, JSON.stringify(cursor), 'utf8');
  } catch {
    // best-effort
  }
}

function readCursorFile(path: string): ReviewCursor | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReviewCursor>;
    if (
      parsed &&
      typeof parsed.turn === 'number' &&
      Number.isFinite(parsed.turn) &&
      typeof parsed.timestamp === 'string'
    ) {
      return { turn: parsed.turn, timestamp: parsed.timestamp };
    }
    return null;
  } catch {
    return null;
  }
}

/** 마지막으로 수락된 테스트 커서. 리뷰 커서와 독립. */
export function readTestCursor(cwd: string): ReviewCursor | null {
  return readCursorFile(cursorPathFor(cwd, TEST_CURSOR_FILE));
}

/** 테스트 수락 시 커서 기록. best-effort. */
export function writeTestCursor(cwd: string, turn: number): void {
  writeCursorFile(cursorPathFor(cwd, TEST_CURSOR_FILE), turn);
}
