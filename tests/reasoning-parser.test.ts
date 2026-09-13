import { describe, expect, test } from 'bun:test';
import { hasReasoningSection, parseReasoningSection } from '../lib/reasoning-parser';

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
