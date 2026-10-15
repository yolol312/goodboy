---
name: fix-bug
description: 버그 수정 워크플로 — 재현, 원인, 최소 수정, 회귀 테스트, 리뷰. 사용 예 /fix-bug <설명>
effort: high
risk_default: simple
required_inputs:
  - name: reproduction_steps
    question: "버그를 어떻게 재현하나요?"
    allow_unknown: true
  - name: expected_behavior
    question: "기대 동작은?"
    allow_unknown: true
  - name: current_behavior
    question: "현재 동작/에러는?"
    allow_unknown: true
  - name: related_files
    question: "관련 파일 또는 모듈은?"
    allow_unknown: true
---

# fix-bug

Make broken behavior right again with the smallest change, and leave a test that keeps it right.

## Steps
1. Inputs: ask for what the hook reports missing in one AskUserQuestion (each question with a
   "확인 필요" option). An answer of "확인 필요" becomes an assumption, never an invented fact.
2. Rationale before the first edit: `## 근거` with `### 사실`, `### 판단`, `### 가정`,
   `### 추측` (or `## Rationale` with Facts, Judgments, Assumptions, Speculations).
3. Reproduce the bug, as a failing test when you can. With no cause in sight, switch to
   `/diagnose-failure` instead of guessing.
4. Read the files involved, then fix with the smallest change; no unrelated cleanup.
5. Fix the same defect class next to it when the bug touched input parsing (`error-path`,
   `proto-pollution`), HTTP responses (`web-hardening`) or UI (`ui-ux-accessibility`).
6. Tests: run the agent `goodboy:test-unit` with the changed files, the category `fix-bug`
   and what changed. It writes the regression test and records the result.
7. Review: `bun "<plugin root>/lib/cli.ts" review-axes <files>` (the plugin root is two levels
   above this skill's base directory), then one `goodboy:review-all` per axis, all in one
   message: `axis: <axis> / files: … / category: fix-bug / rationale: …`.
8. Fix high findings and repeat steps 6–7 for the fixed files only.

## Done when
- [ ] A test fails without the fix and passes with it (in the test result).
- [ ] The review has no open high finding.

## Never
- Never widen the change beyond the bug; never skip the rationale's assumptions.
