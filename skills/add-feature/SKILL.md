---
name: add-feature
description: 기능 추가 워크플로우. 시나리오 → 설계(추론 가시화) → 구현 → 자동 검증 → 리뷰. 사용 예 /add-feature <설명>
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

# 기능 추가

새로운 기능을 시나리오에서 출발해 설계·구현·검증·리뷰까지 일관되게 끝내는 워크플로우입니다.

## 워크플로우

1. **필수 정보 수집**: UserPromptSubmit hook이 누락 정보를 자동 감지합니다. 누락이 있으면 `AskUserQuestion`으로 묶어서 묻고, 각 질문에 "확인 필요" 옵션을 자동 포함시킵니다.

2. **추론 가시화** ⚠️ 필수: 작업 시작 전에 다음 형식으로 `## 추론` 섹션을 출력하세요. 이게 없으면 PreToolUse hook이 편집을 차단합니다.

   ```markdown
   ## 추론

   ### 사실 (검증됨)
   - 실제 Read한 코드/문서로 확인된 것만

   ### 추론 (사실에서 도출)
   - 검증 가능한 논리적 추론

   ### 가정 (정보 부족)
   - 사용자가 "확인 필요"라 답한 항목들 — 어떻게 가정하고 진행할지

   ### 추측 ⚠️ (근거 약함)
   - 검증 없이 채운 부분. 리뷰가 우선 검증함
   ```

3. **카테고리별 세부 단계** — 아래 섹션 참조.

4. **자동 검증**: Edit/Write 후 PostToolUse hook이 타입체크/린트/테스트 자동 실행. 실패 결과는 컨텍스트로 주입되니 확인 후 수정.

5. **리뷰** ⚠️ 필수: 작업 완료 직전에 `review-changes` 서브에이전트를 호출하세요. Stop hook이 리뷰 결과 파일이 없으면 종료를 차단합니다.

   ```
   Agent(general-purpose, "review-changes 스킬에 따라 다음 파일을 리뷰: <변경 파일>")
   ```

   또는 review-changes 슬래시 커맨드/스킬 호출.

## 카테고리별 세부 단계

1. 사용자 시나리오 → 입출력 명세 명확화 (모호하면 AskUserQuestion으로 재확인)
2. 기존 코드 Read로 패턴 파악 (이름 규칙, 디렉터리 구조, 테스트 위치)
3. 설계를 `## 추론` 섹션에 분류 (사실=기존 코드 / 추론=설계 결론 / 가정=불명 / 추측=환각 위험)
4. 구현 + 테스트를 작은 단위로 진행
5. 자동 검증 통과 확인 → 리뷰 호출

## 설계 시 반영할 품질 차원 (해당 시)

⚠️ **shift-left**: 아래는 작업 종료 시 `review-changes`의 **필수 프로브(7.5단계)가 그대로 검사**하는 항목입니다. 리뷰가 잡아낼 때까지 기다리지 말고, 변경이 아래 트리거에 해당하면 **구현하면서 처음부터 만들어 넣으세요**. 해당하는 트리거만 골라 consult하는 체크리스트입니다(전부 다 적용하라는 뜻 아님).

- **프론트엔드 변경** (HTML/CSS/클라이언트 JS/JSX/TSX 또는 HTML 문자열) → 트리거: `ui-ux-accessibility` + `plan-completeness`
  - 모든 상호작용 컨트롤에 접근 가능한 이름(`<label for>` 또는 `aria-label`).
  - 보이는 포커스 스타일(`outline:none` 했으면 반드시 대체 포커스 인디케이터 제공).
  - 로딩 / 에러 / 빈(empty) 상태를 실제로 렌더.
  - 반응형: 모바일 폭(≤400px)에서 가로 오버플로 없음.
  - 시맨틱 HTML(`<button>`/`<nav>`/`<main>` 등, `<div>` 떡칠 금지).
  - **plan-completeness**: 명세/required-inputs가 암시하는 능력을 UI가 실제로 노출하는가? API에만 있고 UI가 없는 능력·막다른 흐름(dead-end)을 남기지 말 것.

- **HTTP 서버 변경** (`Bun.serve`/express/`http`, 또는 server/route/app/api 네이밍) → 트리거: `web-hardening` + `error-path`
  - 보안 헤더(CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy).
  - 잘못된 메서드에 405(+`Allow`), 알 수 없는 라우트에 404, HEAD 처리.
  - **명시적 프레임워크 에러 핸들러** — malformed 입력이 dev 에러 오버레이/소스/절대경로를 노출하지 못하게(이게 노출되면 리뷰는 `high`).
  - 요청 바디 + 필드 크기 상한(무한 증가 금지).

- **외부 입력 파싱 코드** (쿠키/헤더/URL/쿼리/JSON, 사용자 입력으로 키잉되는 객체) → 트리거: `error-path` + `proto-pollution`
  - malformed 인코딩 처리: `decodeURIComponent` 등은 try/catch로 감싸 **fail-closed**(예외를 그대로 throw해 노출하지 말 것).
  - JSON 파싱·객체 키잉 시 `__proto__`/`constructor`/중첩 특수 키를 가드(프로토타입 오염 방지).

- **non-trivial 데이터 경로** → 트리거: `performance`
  - 요청/핫 경로의 동기 IO 회피, 요청마다 O(n) 전체 재작성·무한 증가 회피.
  - 트레이드오프가 있으면 `## 추론` 섹션에 명시(예: "데모라 동기 IO 허용 — 부하 시 교체 필요").

## 위험도

이 카테고리의 기본 위험도: **중간(medium)**

- 단순(simple): 자동 진행 게이트 — 추론 가시화만 필수
- 중간(medium): 추측 카테고리에 항목이 있으면 사용자 확인 게이트
- 위험(risky): 항상 사용자 승인 마커(`.claude/.vcf-risk-approved.txt`)가 있어야 편집 가능. 사용자에게 "진행 승인" 명시 요청.

`--risk <level>` 인자로 override 가능. 예: `/add-feature --risk risky <설명>`

## 주의사항

- "확인 필요" 답변은 정당한 입력입니다. 모델이 거짓 답변하지 말고 그대로 가정 단계에서 명시하세요.
- `## 추론 > 가정` 섹션에 "사용자가 X에 대해 모른다 → ~로 가정"이라고 명시.
- 추측이 많을수록 리뷰가 엄격해집니다. 가능하면 사실/추론 비중을 높이세요(Read로 검증).
- 영향 범위가 큰 변경(여러 모듈/스키마/공개 API)이라면 `--risk risky`로 올리고 마이그레이션 항목은 `/migrate`로 분리하는 것을 고려하세요.
