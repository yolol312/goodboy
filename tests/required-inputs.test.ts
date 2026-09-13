import { describe, expect, test } from 'bun:test';
import {
  buildRequiredInputsChecklist,
  detectMissingInputs,
} from '../lib/required-inputs';
import type { RequiredInput } from '../lib/types';

const inputs: RequiredInput[] = [
  { name: 'reproduction_steps', question: '버그를 어떻게 재현하나요?', allow_unknown: true },
  { name: 'expected_behavior', question: 'expected behavior?', allow_unknown: false },
];

describe('detectMissingInputs', () => {
  test('empty required list => nothing missing', () => {
    expect(detectMissingInputs('anything', [])).toEqual([]);
  });

  test('all missing when prompt is empty', () => {
    const missing = detectMissingInputs('', inputs);
    expect(missing.map((m) => m.name)).toEqual(['reproduction_steps', 'expected_behavior']);
  });

  test('matches by name token', () => {
    const missing = detectMissingInputs('the reproduction is flaky', inputs);
    expect(missing.map((m) => m.name)).toEqual(['expected_behavior']);
  });

  test('matches when a full question token appears in the prompt', () => {
    // tokens for reproduction_steps include the question word '재현하나요';
    // the matcher uses prompt.includes(token), so the whole token must appear.
    const missing = detectMissingInputs('버그를 어떻게 재현하나요 알려드릴게요', inputs);
    expect(missing.map((m) => m.name)).not.toContain('reproduction_steps');
  });

  test('partial Korean substring does NOT satisfy (no word-boundary matching)', () => {
    // '재현' is a substring of token '재현하나요' but is not itself a token of length>=2
    // present as a full token, so it stays missing — documents current behavior.
    const missing = detectMissingInputs('재현 방법은 이렇습니다', inputs);
    expect(missing.map((m) => m.name)).toContain('reproduction_steps');
  });

  test('nothing missing when both covered', () => {
    const missing = detectMissingInputs('reproduction steps and expected behavior described', inputs);
    expect(missing).toEqual([]);
  });
});

const addFeatureInputs: RequiredInput[] = [
  { name: 'user_scenario', question: '사용자 시나리오는?', allow_unknown: true },
  { name: 'inputs_outputs', question: '입력과 출력 명세는?', allow_unknown: true },
  { name: 'scope', question: '영향 범위는?', allow_unknown: true },
  { name: 'test_strategy', question: '테스트 전략은?', allow_unknown: false },
];

describe('buildRequiredInputsChecklist', () => {
  test('empty required list => empty string', () => {
    expect(buildRequiredInputsChecklist([])).toBe('');
  });

  test('lists ALL required inputs regardless of prompt (no missing-N logic)', () => {
    const out = buildRequiredInputsChecklist(addFeatureInputs);
    for (const input of addFeatureInputs) {
      expect(out).toContain(input.name);
      expect(out).toContain(input.question);
    }
  });

  test('does NOT claim a fixed number of missing items', () => {
    const out = buildRequiredInputsChecklist(addFeatureInputs);
    // The old brittle behavior emitted "N missing"; the new checklist must not.
    expect(out).not.toMatch(/\d+\s*개/);
    expect(out).toContain('self-assessment');
  });

  test('includes the no-fabrication instruction and 가정 routing', () => {
    const out = buildRequiredInputsChecklist(addFeatureInputs);
    expect(out).toContain('지어내지 마세요');
    expect(out).toContain('## 근거 > 가정');
  });

  test('marks allow_unknown=false items as 확인 필수', () => {
    const out = buildRequiredInputsChecklist(addFeatureInputs);
    // test_strategy has allow_unknown:false
    const line = out.split('\n').find((l) => l.startsWith('- test_strategy'));
    expect(line).toBeDefined();
    expect(line).toContain('사용자 확인 필수');
  });

  test('instructs to use AskUserQuestion only for uncovered items', () => {
    const out = buildRequiredInputsChecklist(addFeatureInputs);
    expect(out).toContain('AskUserQuestion');
    expect(out).toContain('확인 필요');
  });
});
