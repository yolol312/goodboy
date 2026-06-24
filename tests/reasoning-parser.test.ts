import { describe, expect, test } from 'bun:test';
import { hasReasoningSection, parseReasoningSection } from '../lib/reasoning-parser';

describe('hasReasoningSection', () => {
  test('detects Korean ## 추론 heading', () => {
    expect(hasReasoningSection('intro\n## 추론\n- 사실')).toBe(true);
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
});
