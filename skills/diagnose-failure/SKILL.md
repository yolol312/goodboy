---
name: diagnose-failure
description: 원인 진단 워크플로 — 원인을 모를 때 재현하고 가설을 좁혀 원인을 증거로 확정 (수정은 /fix-bug). 사용 예 /diagnose-failure <증상>
effort: high
risk_default: simple
required_inputs:
  - name: error_message
    question: "에러 메시지는?"
    allow_unknown: true
  - name: stack_trace
    question: "스택 트레이스는?"
    allow_unknown: true
  - name: reproduction
    question: "재현 단계는?"
    allow_unknown: true
  - name: recent_changes
    question: "최근 변경된 것은? (commit, deploy, config)"
    allow_unknown: true
---

# diagnose-failure

Find why something fails, with evidence, before anyone changes code.

## Steps
1. Inputs: ask for what the hook reports missing in one AskUserQuestion (each question with a
   "확인 필요" option); unknown answers become stated assumptions.
2. Rationale: `## 근거` (사실, 판단, 가정, 추측) or `## Rationale`; every hypothesis starts as a
   guess (추측) until a test confirms it.
3. Reproduce it in the smallest form. Hand the hunt to `goodboy:research-cause` (it uses the
   isolate-cause tool skill) when it needs bisection or many experiments, or run them yourself
   in a temp dir or git worktree.
4. Keep a hypothesis table: hypothesis, the command that tests it, its key output, confirmed
   or killed.
5. Stop at the first confirmed cause that explains every symptom; name its `file:line`.
6. Hand off: report the cause and the evidence, then suggest `/fix-bug` for the change.

## Done when
- [ ] The cause is confirmed by output you can quote, and it explains every symptom.

## Never
- Never edit project code while diagnosing; experiments live in temp dirs or worktrees.
- Never call a guess a cause.
