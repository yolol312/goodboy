import { describe, expect, test } from 'bun:test';
import {
  countDeclaredUnknowns,
  hasReasoningSection,
  isPlaceholderItem,
  parseReasoningSection,
} from '../lib/reasoning-parser';

describe('hasReasoningSection', () => {
  test('detects Korean ## 추론 heading', () => {
    expect(hasReasoningSection('intro\n## 추론\n- 사실')).toBe(true);
  });

  test('detects the current ## 근거 heading', () => {
    expect(hasReasoningSection('intro\n## 근거\n- 사실')).toBe(true);
  });

  test('does not match a mere mention of 근거 in prose or a ### 근거 subheading', () => {
    expect(hasReasoningSection('근거가 부족하다')).toBe(false);
    expect(hasReasoningSection('### 근거\n- x')).toBe(false);
  });

  test('detects English ## Reasoning heading (case-insensitive)', () => {
    expect(hasReasoningSection('## reasoning\nstuff')).toBe(true);
  });

  test('false when no heading', () => {
    expect(hasReasoningSection('just some text\nno heading')).toBe(false);
    expect(hasReasoningSection('')).toBe(false);
  });

  test('does not match a mere mention of 추론 in prose', () => {
    expect(hasReasoningSection('나는 추론 했다')).toBe(false);
  });
});

describe('parseReasoningSection', () => {
  test('parses all four buckets with Korean subheadings and bullets', () => {
    const text = [
      '## 추론',
      '### 사실',
      '- f1',
      '- f2',
      '### 추론',
      '- i1',
      '### 가정',
      '- a1',
      '### 추측',
      '- s1 ⚠️',
    ].join('\n');
    const r = parseReasoningSection(text);
    expect(r).not.toBeNull();
    expect(r!.facts).toEqual(['f1', 'f2']);
    expect(r!.inferences).toEqual(['i1']);
    expect(r!.assumptions).toEqual(['a1']);
    expect(r!.speculations).toEqual(['s1 ⚠️']);
  });

  test('parses ## 근거 with ### 판단 as inferences (new heading scheme)', () => {
    const text = [
      '## 근거',
      '### 사실',
      '- f1',
      '### 판단',
      '- j1',
      '- j2',
      '### 가정',
      '- a1',
      '### 추측 ⚠️',
      '- s1',
    ].join('\n');
    const r = parseReasoningSection(text);
    expect(r).not.toBeNull();
    expect(r!.facts).toEqual(['f1']);
    expect(r!.inferences).toEqual(['j1', 'j2']);
    expect(r!.assumptions).toEqual(['a1']);
    expect(r!.speculations).toEqual(['s1']);
  });

  test('legacy ### 추론 subheading under ## 근거 still counts as inferences', () => {
    const text = ['## 근거', '### 추론', '- i1', '### 판단', '- j1'].join('\n');
    const r = parseReasoningSection(text);
    expect(r!.inferences).toEqual(['i1', 'j1']);
  });

  test('returns null when no reasoning heading', () => {
    expect(parseReasoningSection('no section here')).toBeNull();
    expect(parseReasoningSection('')).toBeNull();
  });

  test('stops at the next ## sibling heading', () => {
    const text = ['## 추론', '### 사실', '- f1', '## 다음 섹션', '- not counted'].join('\n');
    const r = parseReasoningSection(text);
    expect(r!.facts).toEqual(['f1']);
    expect(r!.inferences).toEqual([]);
  });

  test('supports English subheadings', () => {
    const text = ['## Reasoning', '### Facts', '- one', '### Assumptions', '- two'].join('\n');
    const r = parseReasoningSection(text);
    expect(r!.facts).toEqual(['one']);
    expect(r!.assumptions).toEqual(['two']);
  });

  // F3: the English form of `## 근거` for English subagent replies.
  test('parses ## Rationale with Facts / Judgments / Assumptions / Speculation', () => {
    const text = [
      '## Rationale',
      '### Facts',
      '- f1',
      '### Judgments',
      '- j1',
      '### Judgment',
      '- j2',
      '### Assumptions',
      '- a1',
      '### Speculation ⚠️',
      '- s1',
    ].join('\n');
    expect(hasReasoningSection(text)).toBe(true);
    const r = parseReasoningSection(text);
    expect(r!.facts).toEqual(['f1']);
    expect(r!.inferences).toEqual(['j1', 'j2']);
    expect(r!.assumptions).toEqual(['a1']);
    expect(r!.speculations).toEqual(['s1']);
  });

  // The category skills' template (skills/*/SKILL.md) puts a description after each label.
  test('labels followed by a description, as the skill template writes them', () => {
    const text = [
      '## 근거',
      '### 사실 (검증됨)',
      '- f1',
      '### 판단 (확인된 사실에서 나온 결론)',
      '- j1',
      '### 가정 (정보 부족)',
      '- a1',
      '### 추측 ⚠️ (근거 약함)',
      '- s1',
      '### Facts: verified',
      '- f2',
      '### Speculation（weak）',
      '- s2',
    ].join('\n');
    const r = parseReasoningSection(text);
    expect(r!.facts).toEqual(['f1', 'f2']);
    expect(r!.inferences).toEqual(['j1']);
    expect(r!.assumptions).toEqual(['a1']);
    expect(r!.speculations).toEqual(['s1', 's2']);
  });

  test('an unknown label still opens no bucket', () => {
    const r = parseReasoningSection(['## 근거', '### 참고 (사실 아님)', '- x'].join('\n'));
    expect(r!.facts).toEqual([]);
  });

  test('## rationale matches in any case; a mere mention does not', () => {
    expect(hasReasoningSection('## rationale\n### facts\n- x')).toBe(true);
    expect(hasReasoningSection('The rationale is below.')).toBe(false);
    expect(hasReasoningSection('### Rationale\n- x')).toBe(false);
  });

  // (결함 H) 게이트 안내문은 "### 추측 ⚠️"처럼 이모지를 붙이도록 지시한다. 라벨의
  //   후행 장식을 제거하지 않으면 정확 매칭이 깨져 speculations가 통째로 유실되고,
  //   시늉-추론 검사(A1)·추측-리뷰 연동(A2)이 오작동한다.
  test('classifies "### 추측 ⚠️" (emoji-decorated label) as speculations', () => {
    const text = [
      '## 추론',
      '### 사실',
      '- f1',
      '### 추측 ⚠️',
      '- s1',
      '- s2',
    ].join('\n');
    const r = parseReasoningSection(text);
    expect(r).not.toBeNull();
    expect(r!.facts).toEqual(['f1']);
    expect(r!.speculations).toEqual(['s1', 's2']);
  });
});

// Round 3 (security review): the rationale gate asks for `- 없음` in an empty category.
//   The parser keeps it (the gate counts it as content); the Stop's assumption-review link
//   must not count it as a declared assumption.
describe('placeholder items', () => {
  test('isPlaceholderItem: an item that only says the category is empty', () => {
    for (const t of ['없음', '없음.', '(없음)', '해당 없음', '해당없음', '없습니다', 'None', 'none.', 'N/A', 'n/a', 'nothing', '-', '—', '*none*']) {
      expect(isPlaceholderItem(t)).toBe(true);
    }
    for (const t of ['none of the callers pass null', 'CI 이미지에 bun 1.3이 있다', 'nan']) {
      expect(isPlaceholderItem(t)).toBe(false);
    }
  });

  // Round 3 (final security review): placeholders with a note still counted as declared.
  test('isPlaceholderItem: common longer forms, and a placeholder followed by a note', () => {
    for (const t of [
      '해당 사항 없음',
      '특별히 없음',
      'No assumptions',
      'none so far',
      '없음 (모두 Read로 확인)',
      '없음 — 사용자 확인 완료',
      '없음: 전부 확인',
      '없음 - 확인함',
      'N/A (not applicable)',
      '**없음** (확인함)',
    ]) {
      expect(isPlaceholderItem(t)).toBe(true);
    }
    for (const t of ['none of x (y)', '백엔드가 JSON을 반환한다고 가정 (확인 필요)', '없는 경우 API가 404를 준다']) {
      expect(isPlaceholderItem(t)).toBe(false);
    }
  });

  // Round 3 (closing security review): the note may state the assumption itself.
  test('isPlaceholderItem: a note that states an assumption makes the item count', () => {
    for (const t of [
      '없음 — 단, 백엔드가 JSON을 반환한다고 가정',
      '없음 (다만 사용자가 OAuth2 표준을 쓴다고 가정)',
      'None: we assume the API is idempotent',
      'N/A (assuming default config)',
    ]) {
      expect(isPlaceholderItem(t)).toBe(false);
    }
    expect(isPlaceholderItem('No assumptions (checked)')).toBe(true); // the head says it, not the note
  });

  test('the parser keeps placeholders; countDeclaredUnknowns skips them', () => {
    const text = [
      '## 근거',
      '### 사실 (검증됨)',
      '- f1',
      '### 가정 (정보 부족)',
      '- 없음',
      '### 추측 ⚠️ (근거 약함)',
      '- none',
    ].join('\n');
    const r = parseReasoningSection(text)!;
    expect(r.assumptions).toEqual(['없음']);
    expect(r.speculations).toEqual(['none']);
    expect(countDeclaredUnknowns(r)).toBe(0);
    const mixed = parseReasoningSection(`${text}\n- the cache is warm`)!;
    expect(countDeclaredUnknowns(mixed)).toBe(1);
  });
});
