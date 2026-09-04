---
name: request-review
description: 리뷰 요청 워크플로우. 변경된 코드를 review-changes 서브에이전트에게 위임. 사용 예 /request-review <기준>
risk_default: simple
required_inputs:
  - name: review_criteria
    question: "리뷰 기준은? (기능/성능/보안/디자인 등)"
    allow_unknown: true
  - name: diff_location
    question: "리뷰할 변경의 위치는? (PR URL, 브랜치, 파일 목록)"
    allow_unknown: true
---

# 리뷰 요청

변경된 코드를 `review-changes` 서브에이전트에게 명시적으로 위임하는 워크플로우입니다. 다른 워크플로우의 마지막 단계와 동일한 리뷰를 독립적으로 호출하고 싶을 때 사용합니다.

## 워크플로우

1. **필수 정보 수집**: UserPromptSubmit hook이 누락 정보를 자동 감지합니다. 누락이 있으면 `AskUserQuestion`으로 묶어서 묻고, 각 질문에 "확인 필요" 옵션을 자동 포함시킵니다.

2. **추론 가시화** ⚠️ 필수: 작업 시작 전에 다음 형식으로 `## 추론` 섹션을 출력하세요. 이게 없으면 PreToolUse hook이 편집을 차단합니다.

   ```markdown
   ## 추론

   ### 사실 (검증됨)
   - 실제 Read한 변경 파일/diff/PR 본문으로 확인된 것만

   ### 추론 (사실에서 도출)
   - 검증 가능한 논리적 추론 (예: 변경 파일 → 영향 받는 호출자)

   ### 가정 (정보 부족)
   - 사용자가 "확인 필요"라 답한 항목들 — 어떻게 가정하고 진행할지

   ### 추측 ⚠️ (근거 약함)
   - 검증 없이 채운 부분. 리뷰가 우선 검증함
   ```

3. **카테고리별 세부 단계** — 아래 섹션 참조.

4. **자동 검증**: 본 워크플로우는 보통 코드 편집을 동반하지 않습니다. 편집이 발생하면 PostToolUse hook이 동일하게 검증을 돌립니다.

5. **리뷰** ⚠️ 필수: 본 워크플로우의 본질이 리뷰 호출입니다. Stop hook이 리뷰 결과 파일이 없으면 종료를 차단합니다.

   띄울 축을 먼저 결정적으로 확인합니다:

   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts review-axes <변경 파일...>
   ```

   그 다음 **한 메시지에서 여러 Agent 호출을 동시에** 보냅니다 — 그래야 실제로 병렬입니다.

   ```
   Agent(review-changes, "축: hallucination / 파일: <변경 파일> / 리뷰 기준: <review_criteria>")
   Agent(review-changes, "축: refactoring  / 파일: <변경 파일> / ...")
   Agent(review-changes, "축: security     / 파일: <변경 파일> / ...")
   Agent(review-changes, "축: performance  / 파일: <변경 파일> / ...")
   ```

   사용자가 `review_criteria` 로 특정 관심사(예: "보안만")를 지정했더라도 **`hallucination` 축은 항상 포함**합니다 — 환각은 기준과 무관하게 확인해야 합니다. 나머지 축은 기준과 `review-axes` 출력의 교집합으로 정합니다.

## 카테고리별 세부 단계

1. 리뷰 기준 + diff 위치 확인 (모호하면 AskUserQuestion으로 재확인)
2. diff 위치에 따라 파일 목록 산출:
   - PR URL: 사용자에게 변경 파일 목록 요청 또는 로컬 브랜치 매핑
   - 브랜치: `git diff --name-only <base>...<branch>` 같은 명령으로 산출
   - 파일 목록: 그대로 사용
3. `review-axes` 로 축을 산출하고, 각 축마다 `Agent(review-changes, "축: … / 파일: …")` 를 **한 메시지에서 동시에** 호출 — 리뷰 기준을 각 프롬프트에 명시
4. 모든 축의 결과를 모아 사용자에게 보고 (축별 verdict, findings 요약, 다음 액션 권고)

## 위험도

이 카테고리의 기본 위험도: **단순(simple)**

- 단순(simple): 자동 진행 게이트 — 추론 가시화만 필수
- 중간(medium): 추측 카테고리에 항목이 있으면 사용자 확인 게이트
- 위험(risky): 항상 사용자 승인 마커(`.claude/.goodboy-risk-approved.txt`)가 있어야 편집 가능. 사용자에게 "진행 승인" 명시 요청.

`--risk <level>` 인자로 override 가능. 예: `/request-review --risk medium <기준>` (보안 리뷰 등 더 엄격하게 가져가고 싶을 때)

## 주의사항

- "확인 필요" 답변은 정당한 입력입니다. 모델이 거짓 답변하지 말고 그대로 가정 단계에서 명시하세요.
- `## 추론 > 가정` 섹션에 "사용자가 X에 대해 모른다 → ~로 가정"이라고 명시.
- 추측이 많을수록 리뷰가 엄격해집니다. 가능하면 사실/추론 비중을 높이세요(Read로 검증).
- 본 워크플로우는 리뷰를 "수행"하는 것이 아니라 서브에이전트에게 "위임"하는 것이 핵심입니다. 모델이 직접 평을 적어 결과로 가장하지 말고, 반드시 Agent 호출 → 결과 파일 확인 흐름을 지키세요.
- 리뷰 기준이 여러 개라면(예: "보안 + 성능") 축으로 나뉘어 **병렬로** 돌아갑니다. 한 에이전트에게 여러 축을 몰아주지 마세요 — 축이 섞이면 각 축의 깊이가 얕아지고 `dimensions_checked` 기록도 부정확해집니다.
- 각 축은 독립적으로 완결합니다. 축끼리 결과를 주고받게 하지 마세요.
