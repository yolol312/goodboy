import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { requiredDimensionsFor } from '../lib/review-dimensions';

// 리뷰 회귀 방지 코퍼스의 머신 체크 가능한 부분.
// 각 fixture의 EXPECTED.json은 {dimension, minSeverity, changedFiles}를 명시한다.
// 이 테스트는 requiredDimensionsFor(changedFiles)가 기대 차원을 포함하는지 단언한다.
// 누군가 나중에 파일→차원 매핑을 약화시키면(예: merge/parse 키워드 제거) 여기서 깨진다.

const CORPUS_DIR = join(import.meta.dir, '..', 'fixtures', 'review-corpus');

interface Expected {
  dimension: string;
  minSeverity: string;
  changedFiles: string[];
  fixed?: boolean;
  oneLineDefect?: string;
}

/** corpus 디렉터리 트리에서 모든 EXPECTED.json 경로를 수집한다. */
function collectExpectedFiles(): Array<{ label: string; path: string; expected: Expected }> {
  const out: Array<{ label: string; path: string; expected: Expected }> = [];
  if (!existsSync(CORPUS_DIR)) return out;
  for (const dimDir of readdirSync(CORPUS_DIR)) {
    const dimPath = join(CORPUS_DIR, dimDir);
    let variants: string[];
    try {
      variants = readdirSync(dimPath);
    } catch {
      continue; // README.md / BASELINE.md 같은 파일은 건너뜀
    }
    for (const variant of variants) {
      const expectedPath = join(dimPath, variant, 'EXPECTED.json');
      if (!existsSync(expectedPath)) continue;
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Expected;
      out.push({ label: `${dimDir}/${variant}`, path: expectedPath, expected });
    }
  }
  return out;
}

describe('review-corpus deterministic guard', () => {
  const cases = collectExpectedFiles();

  test('corpus is present and discovered (sanity)', () => {
    // bad+good for 3 dimensions = 6 EXPECTED.json files
    expect(cases.length).toBeGreaterThanOrEqual(6);
  });

  for (const c of cases) {
    test(`requiredDimensionsFor(${c.label}) includes "${c.expected.dimension}"`, () => {
      expect(Array.isArray(c.expected.changedFiles)).toBe(true);
      expect(c.expected.changedFiles.length).toBeGreaterThan(0);
      const required = requiredDimensionsFor(c.expected.changedFiles);
      // 핵심 단언: 파일→차원 매핑이 약화되면(차원이 빠지면) 실패한다.
      expect(required as string[]).toContain(c.expected.dimension);
    });

    test(`${c.label} EXPECTED.json has a valid severity`, () => {
      expect(['high', 'medium', 'low']).toContain(c.expected.minSeverity);
    });
  }
});
