import { describe, expect, test } from 'bun:test';
import { classifyRisk, detectRiskOverride } from '../lib/risk-classifier';

describe('classifyRisk', () => {
  test('userOverride takes precedence over everything', () => {
    expect(
      classifyRisk({
        category: 'fix-bug',
        fileCount: 10,
        prompt: 'drop table users in production',
        riskDefault: 'simple',
        userOverride: 'simple',
      }),
    ).toBe('simple');
  });

  test('starts from riskDefault', () => {
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'hello', riskDefault: 'simple' })).toBe('simple');
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'hello', riskDefault: 'medium' })).toBe('medium');
  });

  test('invalid riskDefault falls back to medium', () => {
    expect(
      classifyRisk({ category: 'x', fileCount: 0, prompt: 'hi', riskDefault: 'bogus' as never }),
    ).toBe('medium');
  });

  test('3+ files bumps one level up', () => {
    expect(classifyRisk({ category: 'x', fileCount: 3, prompt: 'hi', riskDefault: 'simple' })).toBe('medium');
    expect(classifyRisk({ category: 'x', fileCount: 5, prompt: 'hi', riskDefault: 'medium' })).toBe('risky');
  });

  test('bump cannot exceed risky', () => {
    expect(classifyRisk({ category: 'x', fileCount: 9, prompt: 'hi', riskDefault: 'risky' })).toBe('risky');
  });

  test('risky keyword forces risky regardless of base level', () => {
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'deploy to production now', riskDefault: 'simple' })).toBe('risky');
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'run rm -rf /tmp', riskDefault: 'simple' })).toBe('risky');
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: '마이그레이션 진행', riskDefault: 'simple' })).toBe('risky');
  });

  test('keyword match is case-insensitive', () => {
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'DROP TABLE accounts', riskDefault: 'simple' })).toBe('risky');
  });
});

describe('detectRiskOverride', () => {
  test('parses --risk=value, --risk value, --risk:value', () => {
    expect(detectRiskOverride('fix this --risk=risky')).toBe('risky');
    expect(detectRiskOverride('fix this --risk medium')).toBe('medium');
    expect(detectRiskOverride('fix this --risk:simple')).toBe('simple');
  });

  test('case-insensitive flag', () => {
    expect(detectRiskOverride('--risk RISKY')).toBe('risky');
  });

  test('returns undefined when absent or invalid', () => {
    expect(detectRiskOverride('no flag here')).toBeUndefined();
    expect(detectRiskOverride('--risk=banana')).toBeUndefined();
    expect(detectRiskOverride('')).toBeUndefined();
  });
});
