---
name: add-feature
description: 기능 추가 워크플로 — 시나리오, 설계, 구현, 테스트, 리뷰. 사용 예 /add-feature <설명>
effort: high
risk_default: medium
required_inputs:
  - name: user_scenario
    question: "사용자 시나리오는? (어떤 사용자가 어떤 상황에서 어떻게 쓰나)"
    allow_unknown: true
  - name: inputs_outputs
    question: "입력과 출력 명세는?"
    allow_unknown: true
  - name: scope
    question: "영향 범위는? (수정될 모듈/파일/API)"
    allow_unknown: true
  - name: test_strategy
    question: "테스트 전략은? (어떻게 검증할 것인지)"
    allow_unknown: true
---

# add-feature

Build a feature from its user scenario to tested, reviewed code.

## Steps
1. Inputs: ask for what the hook reports missing in one AskUserQuestion (each question with a
   "확인 필요" option); unknown answers become stated assumptions.
2. Rationale before the first edit: `## 근거` (사실, 판단, 가정, 추측) or `## Rationale`
   (Facts, Judgments, Assumptions, Speculations).
3. Design: the scenario's inputs, outputs, errors and states; the API contract first when a
   client calls an endpoint (tool skill write-api-contract). Read the code you will touch.
4. Build in the main session, or hand parts to `goodboy:build-backend`,
   `goodboy:build-frontend`, `goodboy:build-data` or `goodboy:build-infra` with clear scope.
5. Build in the quality the review checks, where it applies: input parsing fails closed on
   malformed input (`error-path`), keyed objects reject `__proto__` (`proto-pollution`), HTTP
   code has headers, limits and an error handler (`web-hardening`), UI has accessible names,
   focus and empty/error/loading states (`ui-ux-accessibility`).
6. Tests: run `goodboy:test-unit` with the changed files, category `add-feature` and the
   scenario; it covers the dev-cycle acceptance criteria when there are any.
7. Review: `bun "<plugin root>/lib/cli.ts" review-axes <files>` (the plugin root is two levels
   above this skill's base directory), then as its `plan` says: one `goodboy:review-all` for
   every axis, or one per axis in one message: `axis: <axis> / files: … / category: add-feature / rationale: …`.
8. Fix high findings; repeat tests and review for the fixed files only.

## Done when
- [ ] The test result passes and covers the scenario (and every acceptance criterion).
- [ ] The review has no open high finding.

## Never
- Never build past the agreed scope; never leave a state the spec names unhandled.
