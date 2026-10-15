---
name: fix-bug
description: 버그 수정 워크플로우. 재현 → 원인 분석(결정 근거 기록) → 수정 → 자동 검증 → 리뷰. 사용 예 /fix-bug <설명>
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

# 버그 수정

기존 동작이 깨진 부분을 재현하고, 최소한의 변경으로 정상화하는 워크플로우입니다.

## 워크플로우

1. **필수 정보 수집**: UserPromptSubmit hook이 누락 정보를 자동 감지합니다. 누락이 있으면 `AskUserQuestion`으로 묶어서 묻고, 각 질문에 "확인 필요" 옵션을 자동 포함시킵니다.

2. **결정 근거 기록** ⚠️ 필수: 작업 시작 전에 다음 형식으로 `## 근거` 섹션에 결론과 근거를 짧게 요약하세요. 리뷰가 이 섹션의 가정·추측을 검증합니다(`GOODBOY_REASONING_GATE=deny`면 섹션 없이 편집할 때 PreToolUse hook이 차단합니다).

   ```markdown
   ## 근거

   ### 사실 (검증됨)
   - 실제 Read한 코드/문서로 확인된 것만

   ### 판단 (확인된 사실에서 나온 결론)
   - 결론만 한 줄씩

   ### 가정 (정보 부족)
   - 사용자가 "확인 필요"라 답한 항목들 — 어떻게 가정하고 진행할지

   ### 추측 ⚠️ (근거 약함)
   - 검증 없이 채운 부분. 리뷰가 우선 검증함
   ```

3. **카테고리별 세부 단계** — 아래 섹션 참조.

4. **자동 검증**: Edit/Write 후 PostToolUse hook이 타입체크/린트/테스트 자동 실행. 실패 결과는 컨텍스트로 주입되니 확인 후 수정.

5. **테스트** ⚠️ 필수: 코드를 고쳤으면 `test-unit` 서브에이전트를 호출하세요. Stop hook의 층1 테스트 게이트가 테스트 결과 파일이 없으면 종료를 차단합니다.

   ```
   Agent(test-unit, "다음 변경을 테스트: <변경 파일> / 카테고리: <이 워크플로우>")
   ```

   컨테이너로 의존 프로세스를 띄우고 단위·통합·E2E를 작성·실행하며, red-green과 뮤테이션 프로브로 "통과하지만 아무것도 검증하지 않는 테스트"를 배제합니다. 테스트 파일은 repo에 남습니다.

6. **리뷰** ⚠️ 필수: 테스트가 통과한 뒤 `review-all` 를 **축별로 병렬 호출**하세요. Stop hook이 리뷰 결과 파일이 없으면 종료를 차단합니다.

   먼저 띄울 축을 결정적으로 확인합니다:

   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts review-axes <변경 파일...>
   ```

   그 다음 **한 메시지에서 여러 Agent 호출을 동시에** 보냅니다 — 그래야 실제로 병렬입니다.

   ```
   Agent(review-all, "축: hallucination / 파일: <변경 파일> / 카테고리: <이 워크플로우>")
   Agent(review-all, "축: refactoring  / 파일: <변경 파일> / ...")
   Agent(review-all, "축: security     / 파일: <변경 파일> / ...")
   Agent(review-all, "축: performance  / 파일: <변경 파일> / ...")
   ```

   `hallucination` 축은 변경 내용과 무관하게 **항상** 포함합니다. 나머지는 `review-axes` 출력이 알려줍니다. 각 축은 자기 차원만 `dimensions_checked` 에 채우고, Stop hook이 합집합으로 커버리지를 판정합니다.


## 카테고리별 세부 단계

1. 재현 단계로 버그 확인 (가능하면 실패하는 테스트로 재현)
2. 관련 파일 Read (Read-before-edit 정책 — Read 안 한 파일은 편집 불가)
3. 원인 가설을 `## 근거` 섹션에 분류 (사실=Read한 내용 / 판단=논리 / 가정=불명 / 추측=환각 위험)
4. 최소한의 변경으로 수정 (스타일 정리, 무관한 리팩토링은 별도)
5. 회귀 방지 테스트 추가 (가능하면 — 같은 버그가 다시 들어오면 실패하도록)
6. 자동 검증 통과 확인 → 리뷰 호출

## 설계 시 반영할 품질 차원 (해당 시)

⚠️ **shift-left**: 리뷰가 잡아낼 때까지 기다리지 말고 수정과 함께 만들어 넣으세요. 전체 체크리스트는 `/add-feature`의 "설계 시 반영할 품질 차원" 섹션 참조. fix-bug에서 특히 챙길 것:

- **회귀(regression)**: 같은 버그가 다시 들어오면 실패하는 테스트를 반드시 추가. 수정 전이면 실패하고 수정 후엔 통과하는지 실제로 확인(리뷰의 회귀 프로브가 이걸 재현함).
- **버그가 건드린 차원**: 버그가 외부 입력 파싱이면 `error-path`(malformed 인코딩 fail-closed) + `proto-pollution`(특수 키 가드), HTTP 응답이면 `web-hardening`(에러 핸들러/헤더), UI면 `ui-ux-accessibility`(접근 가능한 이름/포커스/에러·빈 상태) — 그 차원을 수정 범위 안에서 함께 고치세요(버그 옆에 같은 결함을 남기지 말 것).

## 위험도

이 카테고리의 기본 위험도: **단순(simple)**

- 단순(simple): 자동 진행 게이트 — 결정 근거 기록만 필수
- 중간(medium): 추측 카테고리에 항목이 있으면 사용자 확인 게이트
- 위험(risky): 항상 이 세션의 사용자 승인 마커(`.claude/.goodboy-risk-approved-<세션 태그>.txt` — 정확한 경로와 명령은 위험 게이트의 거부 메시지에 표시됨)가 있어야 편집 가능. 사용자에게 "진행 승인" 명시 요청.

`--risk <level>` 인자로 override 가능. 예: `/fix-bug --risk risky <설명>`

## 주의사항

- "확인 필요" 답변은 정당한 입력입니다. 모델이 거짓 답변하지 말고 그대로 가정 단계에서 명시하세요.
- `## 근거 > 가정` 섹션에 "사용자가 X에 대해 모른다 → ~로 가정"이라고 명시.
- 추측이 많을수록 리뷰가 엄격해집니다. 가능하면 사실/판단 비중을 높이세요(Read로 검증).
- 버그 원인이 불분명하면 곧장 수정하지 말고 `/debug`로 전환을 권장하세요.
