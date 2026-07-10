import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getEditsSince,
  getLatestEditTimestampSince,
  recordEdit,
} from '../lib/file-tracker';

// 라이브 검증에서 발견된 자기참조 루프 회귀 방지:
//   리뷰 서브에이전트가 프로젝트에 프로브 파일을 만들면 그 파일이 다시
//   "리뷰되지 않은 변경 파일"로 잡혀 리뷰가 무한 재요구된다.
//   → 리뷰 스코프(getEditsSince(mainOnly=true))는 메인 편집만 본다.

const sessions: string[] = [];
function newSession(): string {
  const id = `goodboy-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessions.push(id);
  return id;
}

afterEach(() => {
  while (sessions.length) {
    const id = sessions.pop()!;
    try {
      rmSync(join(tmpdir(), `goodboy-session-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`), {
        recursive: true,
        force: true,
      });
    } catch {
      // best-effort
    }
  }
});

describe('리뷰 스코프 — mainOnly', () => {
  test('서브에이전트 편집은 리뷰 대상에서 제외된다', () => {
    const s = newSession();
    recordEdit(s, '/proj/src/index.ts', 0);
    recordEdit(s, '/proj/performance_probe.ts', 6, 'a71f62222e3f3f065');

    expect(getEditsSince(s, 0, true)).toEqual(['/proj/src/index.ts']);
  });

  test('mainOnly=false(기본)는 기존대로 전부 포함한다 (하위호환)', () => {
    const s = newSession();
    recordEdit(s, '/proj/src/index.ts', 0);
    recordEdit(s, '/proj/probe.ts', 6, 'sub-1');

    const all = getEditsSince(s, 0);
    expect(all).toContain('/proj/src/index.ts');
    expect(all).toContain('/proj/probe.ts');
  });

  test('agent 필드 없는 구버전 기록은 메인으로 간주된다', () => {
    const s = newSession();
    recordEdit(s, '/proj/legacy.ts', 1); // agent 미지정
    expect(getEditsSince(s, 0, true)).toEqual(['/proj/legacy.ts']);
  });

  test('서브에이전트만 편집했으면 리뷰 대상이 비어 종료가 막히지 않는다', () => {
    const s = newSession();
    recordEdit(s, '/proj/probe.ts', 3, 'sub-1');
    expect(getEditsSince(s, 0, true)).toEqual([]);
  });

  test('staleness 타임스탬프도 서브에이전트 편집을 무시한다 (교착 방지)', () => {
    const s = newSession();
    recordEdit(s, '/proj/src/index.ts', 0);
    const mainTs = getLatestEditTimestampSince(s, 0, true);
    expect(mainTs).not.toBeNull();

    // 리뷰가 작성된 뒤 서브에이전트가 프로브 파일을 만든 상황
    recordEdit(s, '/proj/performance_probe.ts', 6, 'sub-1');

    // mainOnly면 최신 편집 시각이 앞당겨지지 않는다 → 리뷰가 stale로 뒤집히지 않는다
    expect(getLatestEditTimestampSince(s, 0, true)).toBe(mainTs);
    // 반면 전체 스코프로 보면 더 나중 시각이 잡힌다(= 기존 루프의 원인)
    expect(getLatestEditTimestampSince(s, 0, false)! >= mainTs!).toBe(true);
  });

  test('커서 전진 후에도 메인 편집만 스코프에 남는다', () => {
    const s = newSession();
    recordEdit(s, '/proj/old.ts', 1);
    recordEdit(s, '/proj/new.ts', 5);
    recordEdit(s, '/proj/probe.ts', 5, 'sub-1');

    expect(getEditsSince(s, 5, true)).toEqual(['/proj/new.ts']);
  });
});
