// lib/claim-check.ts — 층0 인용 검증.
//
// 지키려는 성질: **오탐이 없어야 한다.** 이 게이트는 편집 없는 답변 턴에도 발동하므로,
// 오탐이 잦으면 사용자가 통째로 꺼버린다. 그래서 `파일:줄` 형식만 인용으로 보고,
// 백틱 경로 단순 언급이나 버전 문자열은 건드리지 않는다.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  citationBlockMessage,
  excludeUserOriginated,
  extractCitations,
  hallucinatedCitations,
  unreadBlockMessage,
  unreadCitations,
  verifyCitations,
} from '../lib/claim-check';

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

/** 5줄짜리 src/a.ts 가 있는 프로젝트. */
function newProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-claim-'));
  tmpDirs.push(cwd);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'a\nb\nc\nd\ne\n', 'utf8');
  return cwd;
}

describe('extractCitations', () => {
  test('맨몸 파일:줄 인용을 잡는다', () => {
    const cwd = newProject();
    const cs = extractCitations('보세요 src/a.ts:3 에 있습니다.', cwd);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.raw).toBe('src/a.ts');
    expect(cs[0]!.line).toBe(3);
  });

  test('백틱 안의 인용도 잡는다', () => {
    const cwd = newProject();
    expect(extractCitations('`src/a.ts:2` 참고', cwd)).toHaveLength(1);
  });

  test('./ 접두 경로도 잡는다', () => {
    const cwd = newProject();
    const cs = extractCitations('./src/a.ts:1 을 보면', cwd);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.abs).toBe(resolve(cwd, 'src/a.ts'));
  });

  test('중복 인용은 한 번만', () => {
    const cwd = newProject();
    expect(extractCitations('src/a.ts:3 그리고 다시 src/a.ts:3', cwd)).toHaveLength(1);
  });

  test('마크다운 강조로 감싼 인용도 잡는다 (P10 실측 미검출)', () => {
    const cwd = newProject();
    // 모델은 단정적인 주장일수록 굵게 쓴다 — 강조를 경계로 인정하지 않으면
    // 가장 강한 주장부터 게이트를 빠져나간다.
    expect(extractCitations('**src/a.ts:3** 에 있습니다', cwd)).toHaveLength(1);
    expect(extractCitations('*src/a.ts:3* 참고', cwd)).toHaveLength(1);
    expect(extractCitations('_src/a.ts:3_ 참고', cwd)).toHaveLength(1);
  });

  test('줄 번호 없는 언급은 인용이 아니다 (오탐 방지의 핵심)', () => {
    const cwd = newProject();
    expect(extractCitations('`package.json` 을 고치세요', cwd)).toEqual([]);
    expect(extractCitations('src/a.ts 파일을 보세요', cwd)).toEqual([]);
  });

  test('URL은 인용이 아니다', () => {
    const cwd = newProject();
    expect(extractCitations('https://example.com:443/a.ts 를 참고', cwd)).toEqual([]);
  });

  test('버전 문자열은 인용이 아니다', () => {
    const cwd = newProject();
    expect(extractCitations('bun v1.3:11 에서', cwd)).toEqual([]);
  });

  test('프로젝트 밖 절대경로는 대상이 아니다', () => {
    const cwd = newProject();
    expect(extractCitations('/etc/hosts:1 을 보면', cwd)).toEqual([]);
  });

  test('빈/비문자열 입력은 빈 배열', () => {
    const cwd = newProject();
    expect(extractCitations('', cwd)).toEqual([]);
    // @ts-expect-error 런타임 견고성 확인
    expect(extractCitations(null, cwd)).toEqual([]);
  });
});

describe('verifyCitations — C1/C2 확정 환각', () => {
  test('실재하는 파일의 유효한 줄은 문제 없음', () => {
    const cwd = newProject();
    const cs = extractCitations('src/a.ts:5 참고', cwd);
    expect(verifyCitations(cs)).toEqual([]);
  });

  test('없는 파일 인용 → missing-file', () => {
    const cwd = newProject();
    const cs = extractCitations('src/nope.ts:3 참고', cwd);
    const problems = verifyCitations(cs);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('missing-file');
    expect(hallucinatedCitations(problems)).toHaveLength(1);
  });

  test('줄 수를 넘는 인용 → line-out-of-range', () => {
    const cwd = newProject();
    const cs = extractCitations('src/a.ts:999 참고', cwd);
    const problems = verifyCitations(cs);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('line-out-of-range');
    expect(problems[0]!.detail).toContain('5줄까지');
  });

  test('마지막 줄 개행이 줄 수를 부풀리지 않는다', () => {
    const cwd = newProject(); // 'a\nb\nc\nd\ne\n' = 5줄
    expect(verifyCitations(extractCitations('src/a.ts:5', cwd))).toEqual([]);
    expect(verifyCitations(extractCitations('src/a.ts:6', cwd))).toHaveLength(1);
  });
});

describe('verifyCitations — C3 읽은 기록', () => {
  test('읽기 추적이 불가하면 C3를 생략한다 (압축 직후 오차단 방지)', () => {
    const cwd = newProject();
    const cs = extractCitations('src/a.ts:3', cwd);
    const problems = verifyCitations(cs, { readTrackingAvailable: false, wasRead: () => false });
    expect(problems).toEqual([]);
  });

  test('추적 가능한데 읽은 기록이 없으면 unread', () => {
    const cwd = newProject();
    const cs = extractCitations('src/a.ts:3', cwd);
    const problems = verifyCitations(cs, { readTrackingAvailable: true, wasRead: () => false });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('unread');
    expect(unreadCitations(problems)).toHaveLength(1);
    expect(hallucinatedCitations(problems)).toHaveLength(0);
  });

  test('읽은 기록이 있으면 통과', () => {
    const cwd = newProject();
    const cs = extractCitations('src/a.ts:3', cwd);
    expect(verifyCitations(cs, { readTrackingAvailable: true, wasRead: () => true })).toEqual([]);
  });

  test('확정 환각이 우선한다 — 없는 파일은 unread로 중복 보고하지 않는다', () => {
    const cwd = newProject();
    const cs = extractCitations('src/nope.ts:3', cwd);
    const problems = verifyCitations(cs, { readTrackingAvailable: true, wasRead: () => false });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe('missing-file');
  });
});

describe('excludeUserOriginated — 사용자가 먼저 쓴 인용은 모델 주장이 아니다', () => {
  test('사용자 프롬프트의 인용을 그대로 되풀이하면 제외한다', () => {
    const cwd = newProject();
    const cs = extractCitations('말씀하신 src/nope.ts:42 는 존재하지 않습니다.', cwd);
    expect(cs).toHaveLength(1);
    const kept = excludeUserOriginated(cs, ['src/nope.ts:42 의 로직을 설명해줘'], cwd);
    expect(kept).toEqual([]);
  });

  test('사용자가 안 쓴 인용은 남는다', () => {
    const cwd = newProject();
    const cs = extractCitations('src/nope.ts:42 를 보세요.', cwd);
    const kept = excludeUserOriginated(cs, ['다른 얘기'], cwd);
    expect(kept).toHaveLength(1);
  });

  test('같은 파일이라도 줄이 다르면 남는다', () => {
    const cwd = newProject();
    const cs = extractCitations('src/a.ts:2 도 보세요.', cwd);
    const kept = excludeUserOriginated(cs, ['src/a.ts:1 은 뭐야?'], cwd);
    expect(kept).toHaveLength(1);
  });

  test('user 텍스트가 없으면 그대로 반환', () => {
    const cwd = newProject();
    const cs = extractCitations('src/a.ts:2', cwd);
    expect(excludeUserOriginated(cs, [], cwd)).toEqual(cs);
  });
});

describe('메시지', () => {
  test('환각 메시지는 정정 방법을 안내한다', () => {
    const cwd = newProject();
    const problems = verifyCitations(extractCitations('src/nope.ts:3', cwd));
    const msg = citationBlockMessage(problems);
    expect(msg).toContain('src/nope.ts:3');
    expect(msg).toContain('추측');
  });

  test('unread 메시지는 반복 시 hallucination 축 리뷰로 승격한다', () => {
    const cwd = newProject();
    const problems = verifyCitations(extractCitations('src/a.ts:3', cwd), {
      readTrackingAvailable: true,
      wasRead: () => false,
    });
    expect(unreadBlockMessage(problems, false)).toContain('Read');
    expect(unreadBlockMessage(problems, true)).toContain('hallucination');
  });
});
