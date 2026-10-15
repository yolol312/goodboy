---
name: request-review
description: 리뷰 요청 워크플로 — 변경된 코드를 축별 review-all 에이전트에게 맡기고 결과를 요약. 사용 예 /request-review <기준>
effort: low
risk_default: simple
required_inputs:
  - name: review_criteria
    question: "리뷰 기준은? (기능/성능/보안/디자인 등)"
    allow_unknown: true
  - name: diff_location
    question: "리뷰할 변경의 위치는? (PR URL, 브랜치, 파일 목록)"
    allow_unknown: true
---

# request-review

Run the review goodboy requires for a change, on demand, and report what it found.

## Steps
1. Inputs: ask for what the hook reports missing in one AskUserQuestion (each question with a
   "확인 필요" option); without a location, review the working tree against `HEAD`.
2. List the changed files (`git diff --name-only HEAD`, plus untracked files).
3. Axes: `bun "<plugin root>/lib/cli.ts" review-axes <files>` (the plugin root is two levels
   above this skill's base directory).
4. Run one `goodboy:review-all` per axis, all in one message:
   `axis: <axis> / files: … / category: request-review / criteria: <review_criteria>`.
   A large or risky change can go to `goodboy:review-lead` instead.
5. Summarize: each axis's verdict and result file, and the high and medium findings in your own
   words.

## Done when
- [ ] Every axis review-axes listed has a review result.

## Never
- Never fix findings inside this workflow unless the user asks; report them.
