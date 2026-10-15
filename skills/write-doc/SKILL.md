---
name: write-doc
description: 문서 작성 워크플로 — 대상 독자·톤·분량을 정하고, 코드와 맞는지 확인하며 작성. 사용 예 /write-doc <주제>
effort: medium
risk_default: simple
required_inputs:
  - name: audience
    question: "대상 독자는? (개발자/사용자/팀 내부 등)"
    allow_unknown: true
  - name: tone
    question: "톤은? (튜토리얼/레퍼런스/공지 등)"
    allow_unknown: true
  - name: length
    question: "분량은? (한 줄/한 페이지/긴 가이드)"
    allow_unknown: true
  - name: scope
    question: "다루는 범위는?"
    allow_unknown: true
---

# write-doc

Write a document its reader can act on, true to the code it describes.

## Steps
1. Inputs: ask for what the hook reports missing in one AskUserQuestion (each question with a
   "확인 필요" option); unknown answers become stated assumptions.
2. Rationale: `## 근거` (사실, 판단, 가정, 추측) or `## Rationale`.
3. Read what the doc describes: the code, commands, options and paths, quoted exactly.
4. Write for the reader and the tone; follow the repo's language rules for the file. Hand a
   large doc to `goodboy:build-docs` with the audience, tone, length and scope.
5. Check every command, path and option in the doc against the repo (Grep or Read).
6. Review: a doc-only change needs the hallucination axis: one `goodboy:review-all` with
   `axis: hallucination / files: … / category: write-doc`. Code changes get the full
   `review-axes` set, and tests through `goodboy:test-unit`.

## Done when
- [ ] Every command, path and option in the doc exists in the repo as written.
- [ ] The review has no open high finding.

## Never
- Never document behavior you did not check in the code.
