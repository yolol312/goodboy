import { describe, expect, test } from 'bun:test';
import { effortNotice, hasRepeatedBlock, recommendEffort } from '../lib/effort-advice';

// Track G §10.5.

const base = { current: 'medium', category: null, repeatedBlock: false, docOnly: false };

describe('recommendEffort', () => {
  test('a workflow command above the current effort', () => {
    expect(recommendEffort({ ...base, category: 'fix-bug' })).toEqual({ level: 'high', why: 'workflow' });
    expect(recommendEffort({ ...base, current: 'high', category: 'migrate' })).toEqual({ level: 'xhigh', why: 'workflow' });
    expect(recommendEffort({ ...base, current: 'high', category: 'fix-bug' })).toBeNull();
    expect(recommendEffort({ ...base, current: 'xhigh', category: 'write-doc' })).toBeNull();
  });

  test('a repeated block raises one level, up to xhigh', () => {
    expect(recommendEffort({ ...base, repeatedBlock: true })).toEqual({ level: 'high', why: 'repeated-block' });
    expect(recommendEffort({ ...base, current: 'high', repeatedBlock: true })).toEqual({ level: 'xhigh', why: 'repeated-block' });
    expect(recommendEffort({ ...base, current: 'xhigh', repeatedBlock: true })).toBeNull();
  });

  test('a doc-only change above medium lowers to medium, unless its workflow wants more', () => {
    expect(recommendEffort({ ...base, current: 'high', docOnly: true })).toEqual({ level: 'medium', why: 'docs-only' });
    expect(recommendEffort({ ...base, current: 'medium', docOnly: true })).toBeNull();
    expect(recommendEffort({ ...base, current: 'high', docOnly: true, category: 'fix-bug' })).toBeNull();
  });

  test('no effort in the payload means no advice', () => {
    expect(recommendEffort({ ...base, current: null, category: 'migrate' })).toBeNull();
  });
});

describe('hasRepeatedBlock', () => {
  const ev = (gate: string, ts: string, decision: 'deny' | 'warn' = 'deny') => ({ gate, ts, decision });

  test('two denials of one gate after the last advice', () => {
    const events = [ev('skill-rule', '2026-10-14T01:00:00Z'), ev('outward', '2026-10-14T01:01:00Z'), ev('skill-rule', '2026-10-14T01:02:00Z')];
    expect(hasRepeatedBlock(events, null)).toBe(true);
    expect(hasRepeatedBlock(events, '2026-10-14T01:00:30Z')).toBe(false);
  });

  test('different gates or warnings do not count', () => {
    expect(hasRepeatedBlock([ev('a', '2026-10-14T01:00:00Z'), ev('b', '2026-10-14T01:01:00Z')], null)).toBe(false);
    expect(hasRepeatedBlock([ev('a', '2026-10-14T01:00:00Z', 'warn'), ev('a', '2026-10-14T01:01:00Z', 'warn')], null)).toBe(false);
  });
});

test('the notice names the command to run', () => {
  expect(effortNotice('medium', { level: 'high', why: 'workflow' }, 'fix-bug')).toBe(
    '[goodboy] effort 조언: 지금 medium → `/effort high` 추천 (/fix-bug 작업은 이 effort로 진행해요)',
  );
});
