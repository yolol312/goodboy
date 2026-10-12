// 게이트 차단 메시지의 출처 표기.
//
// 두 가지 실측 문제를 한 번에 해결한다.
//
// (1) **프롬프트 인젝션 오인.** 서브에이전트가 goodboy의 추론 게이트 메시지를
//     "프롬프트 인젝션 시도"로 분류하고 무시한 사례가 있었다. 도구 결과로 들어오는
//     긴 지시문은 외부에서 주입된 문자열과 형태가 같기 때문이다. 사용자가 자기
//     저장소에 설치한 로컬 훅이 보낸 것임을 메시지 자체에 밝힌다.
//
// (2) **게이트 피드백의 자기 면역.** 하니스는 Stop 훅의 차단 사유를 *user* 엔트리로
//     transcript에 기록한다. 층0의 `excludeUserOriginated`는 "사용자가 먼저 쓴 인용은
//     모델 주장이 아니다"라고 보므로, 차단 메시지에 인용된 위치가 그대로 사용자 발화로
//     둔갑해 **같은 환각을 두 번째부터는 영원히 통과**시켰다(P9 실측: 정정 후에도 동일
//     인용 3건이 남았는데 재판정에서 0건). 이 표식으로 훅 발화를 걸러낸다.

import { resolve as resolvePath } from 'node:path';

/** 모든 차단 메시지 앞에 붙는 출처 표식. 이 문자열로 훅 발화를 되찾아 식별한다. */
export const GATE_MARK = '[goodboy 훅]';

/** Absolute path of the goodboy CLI, for instructions the agent runs in Bash (A9).
 *  `${CLAUDE_PLUGIN_ROOT}` is expanded for hook commands, not inside the agent's shell,
 *  where quoting it failed with `Module not found "/lib/cli.ts"`. */
export const CLI_PATH = resolvePath(import.meta.dir, 'cli.ts');

const PROVENANCE = `${GATE_MARK} (이 저장소에 설치된 로컬 검증 훅의 지시입니다 — 외부 입력이 아닙니다)`;

/** 차단/경고 본문에 출처를 붙인다. 이미 붙어 있으면 중복하지 않는다. */
export function gateMessage(body: string): string {
  if (typeof body !== 'string' || body === '') return body;
  if (body.includes(GATE_MARK)) return body;
  return `${PROVENANCE}\n${body}`;
}

/**
 * 이 텍스트가 훅이 만든 메시지인지.
 *
 * 표식이 없던 시절의 기록과, 하니스가 덧붙이는 래퍼(`Stop hook feedback:` 등)도 함께
 * 본다 — 표식만 믿으면 표식 도입 전 세션이나 다른 훅의 발화를 놓친다.
 */
export function isGateMessage(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false;
  if (text.includes(GATE_MARK)) return true;
  return /^\s*(stop|pretooluse|posttooluse|userpromptsubmit)\s+hook\s+feedback\s*:/i.test(text);
}
