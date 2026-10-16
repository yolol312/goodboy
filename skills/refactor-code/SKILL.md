---
name: refactor-code
description: 리팩토링 워크플로 — 동작은 그대로, 구조만 개선하고 동일성을 테스트로 증명. 사용 예 /refactor-code <설명>
effort: high
risk_default: medium
required_inputs:
  - name: behavior_equivalence
    question: "동작 동일성을 어떻게 보장하나요? (테스트, 비교 등)"
    allow_unknown: true
  - name: scope
    question: "리팩토링 범위는?"
    allow_unknown: true
  - name: existing_test_coverage
    question: "기존 테스트가 이 영역을 커버하나요?"
    allow_unknown: true
---

# refactor-code

Improve structure without changing behavior, and prove the behavior did not change.

## Steps
1. Inputs: ask for what the hook reports missing in one AskUserQuestion (each question with a
   "확인 필요" option); unknown answers become stated assumptions.
2. Rationale before the first edit: `## 근거` (사실, 판단, 가정, 추측) or `## Rationale`.
3. Pin the behavior first: run the tests that cover the area; where coverage is thin, have
   `goodboy:test-unit` add characterization tests before you change anything.
4. Refactor in small steps; run the pinned tests after each; no behavior change, no feature.
5. Tests: run `goodboy:test-unit` with the changed files and category `refactor-code`; the
   pinned tests must pass unchanged.
6. Review: `bun "<plugin root>/lib/cli.ts" review-axes <files>` (the plugin root is two levels
   above this skill's base directory), then as its `plan` says: one `goodboy:review-all` for
   every axis, or one per axis in one message: `axis: <axis> / files: … / category: refactor-code / rationale: …`.
7. Fix high findings; repeat tests and review for the fixed files only.

## Done when
- [ ] The tests that pinned the behavior pass unchanged before and after.
- [ ] The review has no open high finding.

## Never
- Never change behavior or public interfaces under a refactor; that is a feature or a fix.
- Never edit a test to make it pass after the refactor.
