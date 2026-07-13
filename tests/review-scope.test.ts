import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getEditsSince, getLatestEditTimestampSince, recordEdit } from '../lib/file-tracker';

// 라이브 검증에서 나온 두 가지 상충 요구를 동시에 만족해야 한다:
//  (1) 자기참조 루프 방지 — 리뷰 서브에이전트의 프로브 파일이 리뷰 스코프를 넓히면 안 됨
//      → 프로브는 프로젝트 밖(mktemp -d)에만 허용하고, 리뷰 스코프를 프로젝트 안으로 한정.
//  (2) 위임 우회 방지 — 편집을 서브에이전트에 시켜 리뷰를 건너뛸 수 없어야 함
//      → 에이전트로는 거르지 않는다(프로젝트 안 편집이면 누가 했든 리뷰 대상).
//  ⚠️ 리뷰 스코프는 실존 파일만 대상으로 한다(A). 그래서 이 테스트는 가짜 경로 대신
//     실제 파일을 만들어 검증한다 — 프로덕션 필터를 약화시키지 않고 픽스처를 현실화한다.

const sessions: string[] = [];
function newSession(): string {
  const id = `goodboy-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  sessions.push(id);
  return id;
}

const dirs: string[] = [];
function newProj(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-scope-proj-'));
  dirs.push(d);
  return d;
}
function newOutside(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-scope-out-'));
  dirs.push(d);
  return d;
}

/** 실제 파일을 만들고 절대경로를 반환(existsSync 필터 통과용). */
function touch(base: string, name: string): string {
  const abs = resolve(base, name);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '', 'utf8');
  return abs;
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
  while (dirs.length) {
    const d = dirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('리뷰 스코프 — 프로젝트 안으로 한정 (루프 방지)', () => {
  test('프로젝트 밖 프로브 파일은 리뷰 대상이 아니다', () => {
    const s = newSession();
    const proj = newProj();
    const out = newOutside();
    const idx = touch(proj, 'src/index.ts');
    recordEdit(s, idx, 0);
    recordEdit(s, touch(out, 'performance_probe.ts'), 6, 'review-agent');

    expect(getEditsSince(s, 0, proj)).toEqual([idx]);
  });

  test('withinDir 미지정이면 (실존하는) 편집을 전부 포함 (하위호환)', () => {
    const s = newSession();
    const proj = newProj();
    const out = newOutside();
    const idx = touch(proj, 'src/index.ts');
    const probe = touch(out, 'probe.ts');
    recordEdit(s, idx, 0);
    recordEdit(s, probe, 6, 'sub-1');

    const all = getEditsSince(s, 0);
    expect(all).toContain(idx);
    expect(all).toContain(probe);
  });

  test('staleness도 같은 집합을 본다 (커버리지/staleness 교착 방지)', () => {
    const s = newSession();
    const proj = newProj();
    const out = newOutside();
    recordEdit(s, touch(proj, 'src/index.ts'), 0);
    const before = getLatestEditTimestampSince(s, 0, proj);
    expect(before).not.toBeNull();

    // 리뷰 작성 후 프로젝트 밖에 프로브 생성 → 리뷰가 stale로 뒤집히면 안 된다
    recordEdit(s, touch(out, 'probe.ts'), 6, 'review-agent');
    expect(getLatestEditTimestampSince(s, 0, proj)).toBe(before);
  });
});

describe('리뷰 스코프 — 위임 우회 차단', () => {
  test('서브에이전트가 프로젝트 파일을 편집하면 리뷰 대상이다', () => {
    const s = newSession();
    const proj = newProj();
    const idx = touch(proj, 'src/index.ts');
    recordEdit(s, idx, 2, 'a0fc607656c58aee0');

    expect(getEditsSince(s, 0, proj)).toEqual([idx]);
  });

  test('메인/서브 혼합 편집 모두 대상', () => {
    const s = newSession();
    const proj = newProj();
    const a = touch(proj, 'a.ts');
    const b = touch(proj, 'b.ts');
    recordEdit(s, a, 1);
    recordEdit(s, b, 2, 'sub-1');

    expect(getEditsSince(s, 0, proj).sort()).toEqual([a, b].sort());
  });

  test('agent 필드 없는 구버전 기록도 그대로 포함', () => {
    const s = newSession();
    const proj = newProj();
    const legacy = touch(proj, 'legacy.ts');
    recordEdit(s, legacy, 1);
    expect(getEditsSince(s, 0, proj)).toEqual([legacy]);
  });
});

describe('리뷰 스코프 — 커서 경계', () => {
  test('커서 이전 편집은 제외', () => {
    const s = newSession();
    const proj = newProj();
    recordEdit(s, touch(proj, 'old.ts'), 1);
    const nw = touch(proj, 'new.ts');
    const sub = touch(proj, 'sub.ts');
    recordEdit(s, nw, 5);
    recordEdit(s, sub, 5, 'sub-1');

    expect(getEditsSince(s, 5, proj).sort()).toEqual([nw, sub].sort());
  });

  test('프로젝트 경로 접두사만 같은 형제 디렉터리는 제외', () => {
    const s = newSession();
    const proj = newProj();
    // proj 와 접두사만 같은 형제 디렉터리(proj + '-other')에 실제 파일을 만든다.
    const sibling = `${proj}-other`;
    mkdirSync(sibling, { recursive: true });
    recordEdit(s, touch(sibling, 'x.ts'), 1);
    expect(getEditsSince(s, 0, proj)).toEqual([]);
  });
});

describe('리뷰 스코프 — 데드락 대응 필터 (A/B/C)', () => {
  test('(A) 삭제된 파일은 리뷰 대상에서 제외된다 (두 집합 일치)', () => {
    const s = newSession();
    const proj = newProj();
    const gone = touch(proj, 'gone.ts');
    const kept = touch(proj, 'kept.ts');
    recordEdit(s, gone, 3);
    recordEdit(s, kept, 3);
    // 편집 기록 후 파일을 삭제(git checkout/스크립트 rm 등을 모사).
    rmSync(gone, { force: true });

    const edits = getEditsSince(s, 0, proj);
    expect(edits).toContain(kept);
    expect(edits).not.toContain(gone);
    // staleness도 동일 집합을 봐야 교착이 없다: 삭제된 파일의 timestamp는 무시된다.
    // gone/kept가 같은 시각이라도, latest는 kept(실존)의 값과 같아야 한다.
    expect(getLatestEditTimestampSince(s, 0, proj)).not.toBeNull();
    // gone만 있었다면 null이어야 한다(삭제분은 timestamp 집합에서도 빠진다).
    const s2 = newSession();
    const proj2 = newProj();
    const only = touch(proj2, 'only.ts');
    recordEdit(s2, only, 1);
    rmSync(only, { force: true });
    expect(getEditsSince(s2, 0, proj2)).toEqual([]);
    expect(getLatestEditTimestampSince(s2, 0, proj2)).toBeNull();
  });

  test('(B) 리뷰 산출물(.claude/reviews/*.json)은 기록 시점에 제외된다', () => {
    const s = newSession();
    const proj = newProj();
    const src = touch(proj, 'src.ts');
    const reviewJson = touch(proj, '.claude/reviews/2026-01-01T00-00-00Z.json');
    recordEdit(s, src, 1);
    recordEdit(s, reviewJson, 1); // 산출물 — 기록 자체를 남기지 않아야 한다

    const edits = getEditsSince(s, 0, proj);
    expect(edits).toEqual([src]);
    expect(edits).not.toContain(reviewJson);
  });

  test('(C) __probe 패턴 파일은 존재해도 리뷰 대상에서 제외된다', () => {
    const s = newSession();
    const proj = newProj();
    const src = touch(proj, 'src.ts');
    const probe = touch(proj, '__probe_perf.ts'); // 프로젝트 안에 남은 프로브
    recordEdit(s, src, 1);
    recordEdit(s, probe, 1);

    const edits = getEditsSince(s, 0, proj);
    expect(edits).toContain(src);
    expect(edits).not.toContain(probe);
  });

  test('(C) GOODBOY_REVIEW_IGNORE로 프로젝트별 패턴을 추가할 수 있다', () => {
    const s = newSession();
    const proj = newProj();
    const src = touch(proj, 'src.ts');
    const gen = touch(proj, 'generated/schema.ts');
    recordEdit(s, src, 1);
    recordEdit(s, gen, 1);

    const prev = process.env.GOODBOY_REVIEW_IGNORE;
    process.env.GOODBOY_REVIEW_IGNORE = '/generated/';
    try {
      const edits = getEditsSince(s, 0, proj);
      expect(edits).toContain(src);
      expect(edits).not.toContain(gen);
    } finally {
      if (prev === undefined) delete process.env.GOODBOY_REVIEW_IGNORE;
      else process.env.GOODBOY_REVIEW_IGNORE = prev;
    }
  });
});
