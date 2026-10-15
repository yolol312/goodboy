---
name: debug
description: 디버깅 워크플로우. 원인 모를 때 진단부터 시작. 결정 근거 기록로 가설 분리. 사용 예 /debug <증상>
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

# 디버깅

원인이 불분명할 때 가설을 분리해 좁혀가는 워크플로우입니다. 수정은 별도로 (`/fix-bug`) 전환을 권장합니다.

## 워크플로우

1. **필수 정보 수집**: UserPromptSubmit hook이 누락 정보를 자동 감지합니다. 누락이 있으면 `AskUserQuestion`으로 묶어서 묻고, 각 질문에 "확인 필요" 옵션을 자동 포함시킵니다.

2. **결정 근거 기록** ⚠️ 필수: 작업 시작 전에 다음 형식으로 `## 근거` 섹션에 결론과 근거를 짧게 요약하세요. 리뷰가 이 섹션의 가정·추측을 검증합니다(`GOODBOY_REASONING_GATE=deny`면 섹션 없이 편집할 때 PreToolUse hook이 차단합니다).

   ```markdown
   ## 근거

   ### 사실 (검증됨)
   - 실제 Read한 코드/로그/에러 메시지로 확인된 것만

   ### 판단 (확인된 사실에서 나온 결론)
   - 결론만 한 줄씩 (예: 스택 프레임 → 함수 호출 흐름)

   ### 가정 (정보 부족)
   - 사용자가 "확인 필요"라 답한 항목들 — 어떻게 가정하고 진행할지

   ### 추측 ⚠️ (근거 약함)
   - 검증 없이 채운 부분. 리뷰가 우선 검증함
   ```

3. **카테고리별 세부 단계** — 아래 섹션 참조.

4. **자동 검증**: Edit/Write 후 PostToolUse hook이 타입체크/린트/테스트 자동 실행. 디버깅은 보통 진단 로그/임시 출력 정도이므로 실패 결과를 확인하고 임시 코드를 정리하세요.

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

   디버그 도중 임시로 넣은 로그/주석/디버거 호출은 `hallucination` 축에서 발견되어야 합니다.


## 카테고리별 세부 단계

1. 에러 메시지 + 스택 트레이스 분석 (가능한 한 원본 그대로 Read)
2. **가설을 여러 개** `## 근거`에 분류 (각 가설이 사실/판단/가정/추측 중 어느 것인지 명시 — 단일 가설로 좁히지 말 것)
3. 가설별 검증 (로그 추가, breakpoint, 데이터 확인, 최근 변경과의 시간 상관관계 점검)
4. 원인 확정 → 수정은 별도 워크플로우로 (`/fix-bug` 권장)
5. 디버그 중 추가한 임시 로그/주석 정리 → 리뷰 호출

## 위험도

이 카테고리의 기본 위험도: **단순(simple)**

- 단순(simple): 자동 진행 게이트 — 결정 근거 기록만 필수
- 중간(medium): 추측 카테고리에 항목이 있으면 사용자 확인 게이트
- 위험(risky): 항상 이 세션의 사용자 승인 마커(`.claude/.goodboy-risk-approved-<세션 태그>.txt` — 정확한 경로와 명령은 위험 게이트의 거부 메시지에 표시됨)가 있어야 편집 가능. 사용자에게 "진행 승인" 명시 요청.

`--risk <level>` 인자로 override 가능. 예: `/debug --risk medium <증상>` (프로덕션에서 직접 디버깅할 때 등)

## 주의사항

- "확인 필요" 답변은 정당한 입력입니다. 모델이 거짓 답변하지 말고 그대로 가정 단계에서 명시하세요.
- `## 근거 > 가정` 섹션에 "사용자가 X에 대해 모른다 → ~로 가정"이라고 명시.
- 추측이 많을수록 리뷰가 엄격해집니다. 가능하면 사실/판단 비중을 높이세요(Read로 검증).
- "원인은 X일 거예요"라고 단일 가설에 곧장 베팅하지 마세요. 가설을 최소 2~3개 늘어놓고 차례로 기각하는 식으로 좁혀가세요.
- 디버깅 단계에서 임시로 넣은 `console.log`, `print`, `debugger`, 주석 코드 블록은 작업 종료 전에 모두 정리하세요. 리뷰가 잡아냅니다.
