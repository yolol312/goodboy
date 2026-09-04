// lib/gate-message.ts — 차단 메시지의 출처 표기.
//
// 지키려는 성질 둘:
//  (1) 차단 메시지가 "누가 보냈는지"를 스스로 밝힌다 — 서브에이전트가 게이트 지시를
//      프롬프트 인젝션으로 오인해 무시한 실측 사례가 있다.
//  (2) 훅 발화를 되찾아 식별할 수 있다 — 하니스가 차단 사유를 user 엔트리로 기록하는데,
//      층0이 그걸 "사용자가 먼저 쓴 인용"으로 오인하면 같은 환각이 영구 면역된다(P9).

import { describe, expect, test } from 'bun:test';
import { GATE_MARK, gateMessage, isGateMessage } from '../lib/gate-message';

describe('gateMessage', () => {
  test('출처 표식과 로컬 훅임을 밝히는 문구를 붙인다', () => {
    const msg = gateMessage('테스트가 없습니다.');
    expect(msg).toContain(GATE_MARK);
    expect(msg).toContain('로컬 검증 훅');
    expect(msg).toContain('테스트가 없습니다.');
  });

  test('이미 표식이 있으면 중복해서 붙이지 않는다', () => {
    const once = gateMessage('본문');
    expect(gateMessage(once)).toBe(once);
  });

  test('빈 문자열/비문자열은 그대로 둔다', () => {
    expect(gateMessage('')).toBe('');
    // @ts-expect-error 런타임 견고성 확인
    expect(gateMessage(null)).toBe(null);
  });
});

describe('isGateMessage', () => {
  test('표식이 있으면 훅 발화다', () => {
    expect(isGateMessage(gateMessage('본문'))).toBe(true);
  });

  test('표식이 없던 시절의 하니스 래퍼도 인식한다', () => {
    expect(isGateMessage('Stop hook feedback: 리뷰가 없습니다')).toBe(true);
    expect(isGateMessage('PreToolUse hook feedback: 차단')).toBe(true);
  });

  test('사용자의 평범한 발화는 훅 발화가 아니다', () => {
    expect(isGateMessage('src/a.ts:3 좀 봐줘')).toBe(false);
    expect(isGateMessage('')).toBe(false);
    // @ts-expect-error 런타임 견고성 확인
    expect(isGateMessage(undefined)).toBe(false);
  });
});
