import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEditsSince, getLatestEditTimestampSince, recordEdit } from '../lib/file-tracker';

// 라이브 검증에서 나온 두 가지 상충 요구를 동시에 만족해야 한다:
//  (1) 자기참조 루프 방지 — 리뷰 서브에이전트의 프로브 파일이 리뷰 스코프를 넓히면 안 됨
//      → 프로브는 프로젝트 밖(mktemp -d)에만 허용하고, 리뷰 스코프를 프로젝트 안으로 한정.
//  (2) 위임 우회 방지 — 편집을 서브에이전트에 시켜 리뷰를 건너뛸 수 없어야 함
//      → 에이전트로는 거르지 않는다(프로젝트 안 편집이면 누가 했든 리뷰 대상).

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

const PROJ = '/proj';

describe('리뷰 스코프 — 프로젝트 안으로 한정 (루프 방지)', () => {
  test('프로젝트 밖 프로브 파일은 리뷰 대상이 아니다', () => {
    const s = newSession();
    recordEdit(s, '/proj/src/index.ts', 0);
    recordEdit(s, '/var/folders/tmp.XXX/performance_probe.ts', 6, 'review-agent');

    expect(getEditsSince(s, 0, PROJ)).toEqual(['/proj/src/index.ts']);
  });

  test('withinDir 미지정이면 전부 포함 (하위호환)', () => {
    const s = newSession();
    recordEdit(s, '/proj/src/index.ts', 0);
    recordEdit(s, '/tmp/probe.ts', 6, 'sub-1');

    const all = getEditsSince(s, 0);
    expect(all).toContain('/proj/src/index.ts');
    expect(all).toContain('/tmp/probe.ts');
  });

  test('staleness도 같은 집합을 본다 (커버리지/staleness 교착 방지)', () => {
    const s = newSession();
    recordEdit(s, '/proj/src/index.ts', 0);
    const before = getLatestEditTimestampSince(s, 0, PROJ);
    expect(before).not.toBeNull();

    // 리뷰 작성 후 프로젝트 밖에 프로브 생성 → 리뷰가 stale로 뒤집히면 안 된다
    recordEdit(s, '/var/folders/tmp.XXX/probe.ts', 6, 'review-agent');
    expect(getLatestEditTimestampSince(s, 0, PROJ)).toBe(before);
  });
});

describe('리뷰 스코프 — 위임 우회 차단', () => {
  test('서브에이전트가 프로젝트 파일을 편집하면 리뷰 대상이다', () => {
    const s = newSession();
    recordEdit(s, '/proj/src/index.ts', 2, 'a0fc607656c58aee0');

    expect(getEditsSince(s, 0, PROJ)).toEqual(['/proj/src/index.ts']);
  });

  test('메인/서브 혼합 편집 모두 대상', () => {
    const s = newSession();
    recordEdit(s, '/proj/a.ts', 1);
    recordEdit(s, '/proj/b.ts', 2, 'sub-1');

    expect(getEditsSince(s, 0, PROJ).sort()).toEqual(['/proj/a.ts', '/proj/b.ts']);
  });

  test('agent 필드 없는 구버전 기록도 그대로 포함', () => {
    const s = newSession();
    recordEdit(s, '/proj/legacy.ts', 1);
    expect(getEditsSince(s, 0, PROJ)).toEqual(['/proj/legacy.ts']);
  });
});

describe('리뷰 스코프 — 커서 경계', () => {
  test('커서 이전 편집은 제외', () => {
    const s = newSession();
    recordEdit(s, '/proj/old.ts', 1);
    recordEdit(s, '/proj/new.ts', 5);
    recordEdit(s, '/proj/sub.ts', 5, 'sub-1');

    expect(getEditsSince(s, 5, PROJ).sort()).toEqual(['/proj/new.ts', '/proj/sub.ts']);
  });

  test('프로젝트 경로 접두사만 같은 형제 디렉터리는 제외', () => {
    const s = newSession();
    recordEdit(s, '/proj-other/x.ts', 1);
    expect(getEditsSince(s, 0, PROJ)).toEqual([]);
  });
});
