# MoAI-ADK 벤치마킹 분석

> goodboy(Claude Code 가드레일 플러그인) 관점에서 본 MoAI-ADK 심층 조사.
> 조사일: 2026-07-30. 사실/추론을 구분했고, 확인 불가한 항목은 명시했다.
> GitHub 리포의 실제 소스 파일(settings.json, 훅 셸 래퍼, Go 핸들러)을 직접 읽고 검증했다.

---

## 1. 개요

| 항목 | 내용 | 출처 |
|---|---|---|
| 정식 명칭 | MoAI-ADK — SPEC-First Agentic Development Kit for Claude Code | [GitHub](https://github.com/modu-ai/moai-adk) |
| 제작 | **modu-ai (모두의AI)** — 한국 조직. 문서·소스 주석·공식 사이트가 한국어 우선 | [GitHub org](https://github.com/modu-ai), [README.ko.md](https://github.com/modu-ai/moai-adk/blob/main/README.ko.md) |
| 라이선스 | Apache-2.0 | GitHub API (검증됨) |
| 활성도 | ★1,149 / fork 212 / open issues 2. 리포 생성 2025-09-16, 최종 push **2026-07-29** (조사 전날) — 매우 활발 | GitHub API (검증됨) |
| 최신 릴리스 | **v3.0.1 (2026-07-24)**. v3.0.0 GA는 2026-07-19. 릴리스 주기 약 1~3주 | GitHub API releases (검증됨) |
| 언어/배포 | Go 1.26+ 단일 바이너리, 외부 의존성 0. 원래 Python이었다가 Go로 포팅됨 (소스 주석에 "ported from the Python pre_tool__security_guard.py" 명시, [PyPI 페이지](https://pypi.org/project/moai-adk/) 잔존) | [pre_tool.go](https://github.com/modu-ai/moai-adk/blob/main/internal/hook/pre_tool.go) |
| 공식 문서 | https://adk.mo.ai.kr (12섹션), 공식 서적 book.mo.ai.kr, Discord 커뮤니티 | [README.ko.md](https://github.com/modu-ai/moai-adk/blob/main/README.ko.md) |

**수치 불일치 주의** (사실 vs 마케팅):

- 리포 설명은 "24 AI agents + 52 skills"라고 주장하지만, 리포의 `.claude/agents/`에는 moai 코어 10개 + harness 스페셜리스트 10개 = **20개 파일**, README 카탈로그는 **11-에이전트**(빌트인 Explore 포함)로 문서화돼 있다. `.claude/skills/`에는 **38개 디렉터리**가 있다 (직접 카운트). 52라는 숫자의 근거는 배포 템플릿 기준으로 추정되나 **확인 불가**.
- 웹 요약에서 "v3.0.2"가 언급되나 GitHub API 릴리스 목록의 최신은 v3.0.1 — v3.0.2는 릴리스로는 **확인 불가**.

## 2. 핵심 개념과 아키텍처

### 2.1 3축 철학 ([README.ko.md](https://github.com/modu-ai/moai-adk/blob/main/README.ko.md))

> "모델은 토큰 단위로 움직이는 확률적 작업자다. 매 턴마다 자기가 돈을 얼마 써야 하는지, 일의 품질이 좋은지, 지난 세션이 어디서 끊겼는지 기억하지 못한다."
> → 모델이 못 하는 것을 **외부 하네스(시스템)가 매 턴 강제**한다.

1. **토크노믹스(비용)** — "비용은 단가가 아니라 배정이 결정한다". 자체 DeepSWE 벤치마크(113과제)로 Opus[low] $1.66/과제·58% vs Sonnet[max] $26.40/과제·54%를 근거로 작업별 모델·effort 라우팅. No-Haiku 정책, CG 모드(Claude 리더 + GLM 워커, 구현 작업 60-70% 절감 주장 — 자체 주장, 독립 검증 불가).
2. **에이전틱 루프(자기 개선)** — 매 실행의 라우팅 결정·게이트 증거를 기록해 다음 실행의 재료로. `/moai goal`(완료조건 선언) + `/moai loop`(기본 30턴 한도 자율 반복). 내부 패키지명이 `internal/ralph`(Ralph loop).
3. **에이전틱 하네스(품질)** — "재작업이 최대의 토큰 낭비". SPEC Tier S/M/L로 검증 깊이 결정, TRUST 5 게이트, worktree 격리.

### 2.2 SPEC-First 3페이즈 워크플로우

```
/moai plan "Add JWT login"   → SPEC 작성 (manager-spec, Opus+high)
/moai run  SPEC-AUTH-001     → TDD/DDD 구현 (manager-develop)
/moai sync SPEC-AUTH-001     → 문서 동기화 + PR (manager-docs, manager-git)
```

- 방법론 자동 선택: 신규/커버리지 10%+ → **TDD**(RED→GREEN→REFACTOR), 레거시 커버리지 <10% → **DDD**(ANALYZE→PRESERVE→IMPROVE).
- 자연어 입력 시 "Analyze-First 라우팅"이 의도 분석 후 plan/run/sync로 자동 분기.
- **평가자 분리**: plan-auditor / sync-auditor는 작성자와 다른 독립 에이전트가 감사(자기채점 편향 방지). sync-auditor는 4차원 채점(Functionality 40% / Security 25% / Craft 20% / Consistency 15%).

### 2.3 TRUST 5 품질 게이트

| 축 | 기준 |
|---|---|
| **T**ested | 커버리지 85%+ , 테스트 통과 |
| **R**eadable | 명확한 네이밍, 린트 오류 0 |
| **U**nified | 포맷팅·import 순서·프로젝트 구조 준수 |
| **S**ecured | OWASP, 입력 검증, 보안 경고 0 |
| **T**rackable | Conventional commits, 이슈 참조, 구조화 로깅 |

`.git_hooks/` pre-commit + Stop hook의 `sync-phase-quality-gate.sh`로 강제.

### 2.4 훅 아키텍처 (소스 직접 검증)

**구조: 얇은 셸 래퍼 → Go 바이너리.** `.claude/hooks/moai/handle-*.sh`(약 30개)는 stdin JSON을 `moai hook <event>` Go 서브커맨드로 포워딩만 한다. **바이너리가 없으면 `exit 0`으로 조용히 통과(fail-open)**. stderr 로그는 10MB 단일 로테이션 + 경로 허용목록.

[.claude/settings.json](https://github.com/modu-ai/moai-adk/blob/main/.claude/settings.json)의 실제 배선:

| 이벤트 | 핸들러 | 특징 |
|---|---|---|
| SessionStart | handle-session-start.sh | matcher `startup\|resume\|clear\|compact\|fork` — **압축/클리어 직후에도 발동**해 핸드오프 주입 |
| PreCompact | handle-compact.sh | 압축 전 상태 보존 |
| SessionEnd | handle-session-end.sh | |
| PreToolUse | handle-pre-tool.sh (matcher `Write\|Edit\|Bash`, timeout 5s) | 보안 정책 + frozen-zone + Bash 위험 신호 |
| PostToolUse | post-tool(async) + status-transition-ownership + security-scan(async) / 전역 harness-observe(async) | **비차단 검사는 async로 분리** |
| Stop | handle-stop → sync-phase-quality-gate(60s) → handle-stop-goal(120s) → security-turn → security-commit → harness-observe(async) | **단일 Stop에 6개 핸들러 체인**, 각기 다른 timeout |

`internal/hook/`에는 60+개의 Go 핸들러 파일: branch_guard, handoff_inject, session_ledger, evidence_writer, reflective_write, quality/(gate, astgrep_gate, linter, formatter), security/(guardian, scanner, patterns), mx/(validator, complexity — tree-sitter 기반) 등.

**PreToolUse 게이트 상세** ([pre_tool.go](https://github.com/modu-ai/moai-adk/blob/main/internal/hook/pre_tool.go)):

- `SecurityPolicy`: **deny 패턴**(secrets/credentials 파일, `.ssh/`, `.pem`, `.git/` 내부, `.aws/`·`.kube/` 등 클라우드 자격증명) / **ask 패턴**(락파일 9종, tsconfig·package.json 등 핵심 설정, `.github/workflows/`, Dockerfile, terraform·k8s) / **위험 Bash 패턴**(Supabase·Neon·PlanetScale·Railway·Vercel의 DB 삭제 CLI, `DROP DATABASE`, `rm -rf /` 변형들) / 민감 콘텐츠 패턴 / 프로젝트 경계 검사 + 외부 경로 허용목록.
- **HARNESS_FROZEN_\* 센티널 8종**: 자기개선 서브에이전트(harness-learner)가 `.claude/agents/moai/`, `.claude/skills/moai-*`, `.claude/rules/`, `.claude/commands/`, `.claude/hooks/`, output-styles, CLAUDE.md, 시스템 config를 수정하려 하면 deny하고 센티널 문자열을 사유로 반환 — **에이전트가 하네스 자체를 못 건드리게** 하는 보호.
- **Bash Risk-Amplifier** ([handle-pre-tool.sh](https://github.com/modu-ai/moai-adk/blob/main/.claude/hooks/moai/handle-pre-tool.sh)): 셸 메타문자(`| && || ; \` $(`)를 세어 서브커맨드 5개 초과 시 **warn-only**로 "스크립트 파일로 분리하거나 위임하라" 경고. 주석에 "MUST NOT block, fail-open, 파서가 아니라 휴리스틱" 명시.

**Stop 훅 상세** ([stop.go](https://github.com/modu-ai/moai-adk/blob/main/internal/hook/stop.go), [session_ledger.go](https://github.com/modu-ai/moai-adk/blob/main/internal/hook/session_ledger.go)):

- `stop_hook_active=true`면 즉시 allow (무한루프 방지 — goodboy와 동일한 교훈).
- 텔레메트리 90일 프루닝(과거 30일/90일 이중 호출이 충돌해 짧은 쪽이 이기던 버그를 주석으로 기록해 둠).
- **반성적 학습(reflective write)**: 세션 텔레메트리를 스킬별로 그룹핑해 개선 제안(LearningEntry)을 생성 — FrozenGuard + RateLimiter 적용, **절대 자동 적용하지 않고 사람 리뷰 대기**.
- **증거 게이트(SPEC-STOP-EVIDENCE-GATE-001)**: 세션 원장(SessionLedger)을 읽어 "성공 주장(Outcome=success/partial)은 있는데 이진 증거(테스트 pass/fail 관측)가 없는" 조합을 stderr로 advisory 표면화. **절대 Stop을 차단하지 않음(fail-open)**. 흥미롭게도 소스 주석에 "현재 텔레메트리 writer가 Outcome=unknown을 하드코딩해 이 게이트는 지금 발화하지 않는다(knowingly-dormant)"고 정직하게 적어 둠.

### 2.5 @MX 어노테이션 시스템

고팬인·복잡·위험 함수에만 선택적으로 붙이는 인라인 어노테이션 (`@MX:ANCHOR`, `@MX:REASON: fan_in >= 3 ...`). 에이전트 간 컨텍스트·불변 계약·위험 구역을 코드 안에서 전달. v2.14.0부터 **린트 억제(ast-grep suppression)에는 1줄 이내 인접한 @MX:REASON 주석을 요구**하는 정책 린트 추가 ([releases](https://github.com/modu-ai/moai-adk/releases)). `/moai mx`로 검증, tree-sitter 기반 복잡도 측정과 연동.

### 2.6 컨텍스트·비용 관리

- **검증 다이어트(verification economy)**: 명령 출력을 디스크로 리다이렉트하고 컨텍스트에는 exit code + 제한된 tail(50줄)만 남김.
- **Token Circuit Breaker**: hard limit(기본 90%) 도달 전 작업 중단 + progress.md에 진행상태 저장.
- **세션 핸드오프**: `moai handoff` + SessionStart 훅(clear/compact matcher)의 handoff_inject로 `/clear` 경계 너머 연속성 유지.
- **스테이터스라인**: 모델·effort·프롬프트 캐시 적중률(♻️)·컨텍스트 사용률(soft ⚠️/hard 🛑 2단계 /clear 마커)·요금제 5H/7D 사용률·SPEC 페이즈·PR 상태·잔여 시간 추정.

## 3. 기능 목록 요약

| 범주 | 내용 |
|---|---|
| CLI (36개, 주요 13) | `moai init/doctor/status/update/cc/glm/cg/worktree/session/spec/goal/harness/handoff/preference/web` |
| 슬래시 커맨드 (15) | `/moai plan/run/sync/goal/loop/fix/review(--deep)/gate/clean/mx/codemaps/feedback/e2e/project/harness` + 자연어 라우팅 |
| 에이전트 | Manager 5(spec/develop/docs/git/design) + Evaluator 2(plan-auditor/sync-auditor) + builder-harness/super-advisor/e2e-tester + 빌트인 Explore. 각 셀에 모델×effort 배정(11×3 매트릭스) |
| 스킬 (리포 내 38) | moai-foundation-\*(core/quality/thinking/cc), moai-workflow-\*(tdd/ddd/spec/loop/ci-loop/testing/worktree/docs-claim-check), moai-domain-\*(backend/frontend/database 등), moai-ref-\*(owasp/llm-security/secops/supply-chain/testing-pyramid 등), moai-harness-learner, moai-meta-harness |
| 훅 | 6개 이벤트에 ~30개 셸 래퍼 + Go 핸들러 60+ (위 2.4) |
| 기타 | git worktree 격리 병렬 SPEC 개발, 16언어 자동 감지, 4개국어 문서, 웹 설정 콘솔(`moai web`), GLM 하이브리드 모드 |

## 4. goodboy와의 대조표

### 4.1 같은 문제를 푸는 기능

| 문제 | goodboy | MoAI-ADK |
|---|---|---|
| Stop 시 품질 강제 | Stop hook이 리뷰 JSON verdict 검사, 미리뷰 시 `decision:block` | Stop 체인 6단계 (sync-phase-quality-gate, stop-goal, security-turn/commit) — 단 stop.go 본체는 항상 allow(advisory 위주) |
| stop_hook_active 데드락 | 동일 가드 (MEMORY.md에 실측 기록) | 동일 가드 (stop.go에 명시) |
| 위험 Bash 차단 | Bash 쓰기 차단, 재귀 탐색 차단, cat 게이트 | 위험 명령 정규식 카탈로그(DB 삭제 CLI 5개 벤더, rm -rf 변형, DROP DATABASE) + 서브커맨드 수 warn |
| 민감/위험 파일 보호 | 위험 키워드 → 위험도 상향 + 승인 마커 | deny(secrets/ssh/클라우드 자격증명) / ask(락파일·CI·인프라) 2단계 정규식 카탈로그 |
| 컨텍스트 관리 | transcript 실측 % 계산, 30%+10%p 경고, 50% 강제 compact 차단(escape 3회) | statusline 2단계 /clear 마커 + Token Circuit Breaker(90%) + progress.md 저장 |
| 환각 억제 | 추론 4분류 가시화 + Read-before-edit + 리뷰 서브에이전트의 환각 검증 | 증거 게이트("성공 주장 vs 이진 증거" 대조, advisory) + docs-claim-check 스킬 + GateGuard Fact-Force PreToolUse 게이트(v3.0.0-rc12, 상세 확인 불가) |
| 리뷰 강제 | review-changes 서브에이전트 → 구조화 JSON → Stop 게이트 | plan-auditor/sync-auditor 독립 감사 + 4차원 채점 |
| 검증 자동 실행 | PostToolUse 자동 타입체크(옵션: 린트/테스트) + 실패 마커 → Stop 차단 | PostToolUse quality gate(린터/포매터/ast-grep) + TRUST pre-commit |
| 출력 홍수 방지 | H2-02 cat 게이트 (256KB deny) | 검증 다이어트 (디스크 리다이렉트 + tail 50줄) |
| 훅 런타임 부재 대응 | Bun 자동 설치 유도 (프롬프트 게이트) | 바이너리 없으면 exit 0 통과 + SessionStart 바이너리 열화 프로브(v3.0.0-rc12) |

### 4.2 MoAI-ADK에만 있는 것

- **SPEC-First 전체 라이프사이클** (plan→run→sync, Tier S/M/L, SPEC ID 추적) — goodboy는 워크플로우가 아니라 가드레일.
- **모델·effort 라우팅 매트릭스 / 토크노믹스 / GLM 하이브리드** — 비용 축 전체.
- **세션 핸드오프 주입** (SessionStart clear/compact matcher + handoff_inject).
- **Stop 증거 게이트** — 세션 원장 기반 "주장 vs 증거" 대조.
- **반성적 학습 루프** — 게이트/스킬 텔레메트리 → 사람 리뷰 대기 개선 제안.
- **Frozen-zone 센티널** — 에이전트의 하네스 자체 수정 차단.
- **@MX 어노테이션 + 억제-이유 강제 린트**.
- **git worktree 격리 병렬 개발**, goal/loop(Ralph) 자율 루프, 웹 설정 콘솔.

### 4.3 goodboy에만 있는 것

- **추론 4분류(사실/추론/가정/추측) 가시화 의무 + 빈 섹션 차단** — MoAI에는 thinking 스킬은 있지만 훅으로 검사되는 추론 분류 게이트는 확인되지 않음.
- **Read-before-edit 결정적 검증** — MoAI의 "Fact-Force pre-edit investigate 게이트"가 유사할 가능성이 있으나 상세 확인 불가.
- **재-Read 방지(H2-01)** — 에이전트별 스코프·30턴 윈도우·mtime 비교·압축 감지 리셋. MoAI에 대응물 없음.
- **탐색 도구 위임 강제** (메인의 Grep/Glob/WebSearch/WebFetch 차단 → 서브에이전트 유도).
- **부족-입력 self-assessment 주입(B2)** — UserPromptSubmit에서 카테고리별 필수 입력 점검 + AskUserQuestion 유도. MoAI는 UserPromptSubmit을 관측(harness-observe)에만 씀.
- **위험도 승인 마커** (`.goodboy-risk-approved.txt`) — 사용자 결정권 보존 메커니즘.
- **transcript 실측 기반 강제 compact** — MoAI statusline은 표시·권고, goodboy는 Stop 차단으로 강제.
- **Bun/TS 단일 레이어 경량 구현** — MoAI는 Go 바이너리 + 셸 래퍼 + 스킬 + 에이전트의 대형 스택.

## 5. goodboy가 벤치마킹할 만한 아이디어 Top 5

### ① Stop 증거 게이트 — "성공 주장 vs 이진 증거" 대조 (최우선)

- **왜**: goodboy의 리뷰 강제는 "리뷰를 했는가"를 보지, "모델의 완료 주장이 관측된 증거로 뒷받침되는가"는 안 본다. MoAI의 SessionLedger 접근(성공 주장 카운트 vs 테스트 pass/fail 관측 플래그)은 환각 억제라는 goodboy 핵심 목표와 정확히 겹치고, **advisory + fail-open이라 철학 충돌이 없다**.
- **어떻게**: (a) PostToolUse에서 이미 실행하는 자동 검증(타입체크 등)의 exit code를 세션 원장 파일(`.claude/.goodboy-ledger.jsonl` 등)에 append. Bash 도구의 test/typecheck 류 명령 exit code도 기록. (b) Stop hook에서 transcript 마지막 어시스턴트 메시지의 완료 주장 패턴("완료", "수정했습니다", "통과") 감지 시 원장에 pass 증거가 없으면 `systemMessage`로 "성공 주장에 대응하는 검증 증거 없음 — 검증 실행 또는 주장 완화" 경고. 코드 변경 세션에서 N회 누적 시에만 1회 block(escape 포함)으로 승격하는 단계 설계 가능. MoAI가 dormant 상태로 남겨둔 부분(Outcome 기록 writer)이 goodboy에서는 PostToolUse 자동 검증 덕분에 곧바로 실현 가능하다는 게 포인트.

### ② 압축/클리어 경계 핸드오프 주입

- **왜**: goodboy는 강제 compact까지는 하지만, **압축 직후 게이트 상태(리뷰 대기, 검증 실패 마커, 위험도, 추론 섹션 이행 여부)가 새 컨텍스트에 남는다는 보장이 없다**. 압축이 goodboy 게이트의 근거 컨텍스트를 날리면 게이트가 헛돌거나(재-Read 기록 리셋은 이미 함) 모델이 규칙을 잊는다. MoAI는 SessionStart matcher `clear|compact|fork`에서 handoff_inject로 상태를 재주입한다.
- **어떻게**: goodboy에 SessionStart 훅 추가(matcher `compact|clear|resume`), `additionalContext`로 (a) 미해소 검증 실패 마커, (b) 리뷰 대기 파일 목록, (c) 현재 위험도/승인 상태, (d) "## 추론 섹션 규칙 요약" 한 단락을 주입. 이미 status.json에 대부분의 상태가 있으므로 구현 비용이 낮다.

### ③ 셀프-무력화 방지 (frozen-zone 축소판)

- **왜**: goodboy의 알려진 약점 — 모델이 `.claude/.goodboy-risk-approved.txt`를 **스스로 touch**하거나(README가 "모델에게 승인 명시 후 모델이 마커 생성"을 허용), env로 게이트를 끄는 편집을 스스로 할 수 있다. MoAI는 HARNESS_FROZEN_\* 센티널 8종으로 에이전트의 하네스 수정을 PreToolUse에서 결정적으로 deny한다.
- **어떻게**: PreToolUse에서 (a) Write/Edit/Bash 대상이 goodboy 마커·설정 파일(`.goodboy-*` 마커, hooks.json, 플러그인 디렉터리)일 때, **사용자 승인 문맥 없이는 deny** + 사유 센티널 반환. (b) 승인 마커 생성은 "사용자 프롬프트에 승인 표현이 있었던 턴"에만 허용(UserPromptSubmit에서 승인 감지 플래그 기록 → PreToolUse가 확인). 완전 차단이 아니라 "사용자 손을 거치게" 하는 것이므로 fail-open 철학과 양립.

### ④ deny/ask 2단계 파일·명령 카탈로그로 위험도 게이트 확장

- **왜**: goodboy 위험도 판별은 키워드 소수(prod, DROP TABLE, rm -rf, --force)다. MoAI의 카탈로그는 실전에서 사고가 나는 지점(락파일 9종, `.github/workflows/`, Dockerfile, terraform/k8s, 벤더별 DB 삭제 CLI — supabase/neon/pscale/railway/vercel)을 정규식으로 망라하고, **deny(절대 금지)와 ask(확인 요구)를 구분**한다.
- **어떻게**: goodboy 위험도 분류기에 파일 경로 티어 테이블 추가 — 자격증명·`.git/` 내부는 즉시 deny, 락파일·CI·인프라 파일은 위험도 `risky`로 자동 상향(기존 승인 마커 흐름 재사용). Bash 게이트에 벤더 DB-삭제 CLI 패턴을 이식. 정규식 목록은 pre_tool.go에서 그대로 참조 가능(Apache-2.0이라 라이선스 문제 없음, 출처 주석 필수).

### ⑤ 게이트 텔레메트리 → 반성적 튜닝 제안 (human-in-the-loop)

- **왜**: goodboy는 게이트 발동 수를 statusline에 표시하지만, "이 세션에서 어떤 게이트가 얼마나 헛발질(오탐)했는가 → 임계/env를 어떻게 조정할까"의 루프가 없다. 최근 커밋 이력(헛 deny 흡수 v0.27.4/0.27.7)이 보여주듯 오탐 튜닝은 수동 리포트에 의존 중이다. MoAI의 reflective write는 **제안만 생성하고 절대 자동 적용하지 않는** 안전 계약을 갖췄다.
- **어떻게**: 각 게이트 발동을 `{gate, verdict, escape_used, ts}`로 jsonl 기록(이미 status.json 갱신 경로 존재). Stop에서 세션당 1회, "H2-01이 12회 발동했고 그중 8회가 escape로 통과 — `GOODBOY_REREAD_GATE=warn` 전환 또는 윈도우 축소 고려" 같은 제안을 systemMessage 1줄로 표면화. 자동 설정 변경은 금지(③과 일관).

**차점(참고만)**: @MX식 "린트 억제엔 이유 주석 강제" — goodboy 리뷰 에이전트의 체크 항목으로 편입 가능. 검증 다이어트(출력 디스크 리다이렉트) — H2-02의 자연스러운 확장.

## 6. 채택하지 말아야 할 것

goodboy 철학(fail-open, 탈출구 있는 게이트, 최소 마찰, 사용자 결정권)과 충돌하거나 정체성을 흐리는 것들:

1. **SPEC-First 전체 라이프사이클** — MoAI는 개발 방법론을 소유하는 프레임워크고, goodboy는 어떤 워크플로우 위에도 얹히는 가드레일 레이어다. SPEC ID·Tier·plan/run/sync를 도입하는 순간 goodboy는 "무거운 플러그인이므로 project 범위 권장"을 넘어 워크플로우 강제 도구가 된다.
2. **TRUST 5의 하드 커버리지 85% 게이트** — 커버리지 절대치 강제는 레거시·프로토타입에서 마찰이 극심하고, goodboy의 "기본은 타입체크만, 확장은 opt-in(GOODBOY_AUTOVALIDATE)" 설계와 정반대.
3. **모델 라우팅 매트릭스·토크노믹스·GLM 하이브리드** — 비용 최적화는 goodboy의 토큰 *습관* 관리(낭비 패턴 억제)와 결이 다르다. 모델 선택은 사용자·하니스의 영역.
4. **30턴 자율 goal/loop(Ralph)** — 자율 반복 루프는 "사용자 결정권 보존" 원칙과 충돌. goodboy의 Stop 게이트는 턴을 *멈추게* 하는 장치지 *계속 달리게* 하는 장치가 아니다.
5. **거대 스택화(에이전트 20+, 스킬 38+, 6이벤트 30훅, Go 바이너리 의존)** — MoAI의 셸 래퍼가 "바이너리 없으면 exit 0"으로 조용히 죽는 것은 배포 복잡성의 대가다. goodboy의 강점은 단일 런타임(Bun) + 4훅의 검증 가능한 작은 표면이다.
6. **Stop 6단계 체인(최대 120s 타임아웃)** — 턴 종료마다 최대 3분대의 훅 대기 가능성은 goodboy의 최소 마찰 원칙과 충돌. 채택 시에도 advisory는 async, 차단 판단은 5s 이내라는 현행 원칙 유지.

## 7. 출처 목록

**1차 출처 (소스 직접 열람·검증)**

- GitHub API `repos/modu-ai/moai-adk` — 스타/포크/라이선스/생성·push 일자 (2026-07-30 조회)
- GitHub API `releases` — v3.0.1(2026-07-24), v3.0.0(2026-07-19), v3.0.0-rc12(2026-07-13), v2.14.0(2026-04-24)
- GitHub API `git/trees/main?recursive=1` — 전체 파일 트리 7,901개 (훅/스킬/에이전트 카운트 근거)
- https://github.com/modu-ai/moai-adk/blob/main/.claude/settings.json — 훅 배선
- https://github.com/modu-ai/moai-adk/blob/main/.claude/hooks/moai/handle-pre-tool.sh — 셸 래퍼, Bash Risk-Amplifier
- https://github.com/modu-ai/moai-adk/blob/main/.claude/hooks/moai/handle-stop.sh
- https://github.com/modu-ai/moai-adk/blob/main/internal/hook/pre_tool.go — SecurityPolicy, FROZEN 센티널
- https://github.com/modu-ai/moai-adk/blob/main/internal/hook/stop.go — Stop 핸들러, 증거 게이트 호출
- https://github.com/modu-ai/moai-adk/blob/main/internal/hook/session_ledger.go — SessionLedger, 증거 평가
- https://github.com/modu-ai/moai-adk/blob/main/internal/hook/reflective_write.go — 반성적 학습

**2차 출처 (문서·페이지, WebFetch 요약 경유 — 세부 수치는 원문 재확인 권장)**

- https://github.com/modu-ai/moai-adk — README(영문)
- https://github.com/modu-ai/moai-adk/blob/main/README.ko.md — 한국어 README (3축 철학, 에이전트 카탈로그, TRUST 5, DeepSWE 표)
- https://github.com/modu-ai/moai-adk/releases — 릴리스 노트 (GateGuard Fact-Force, SessionStart probe 등)
- https://adk.mo.ai.kr — 공식 문서 사이트 (목차 구조)
- https://pypi.org/project/moai-adk/ — Python 시절 패키지 (역사적)
- https://github.com/modu-ai — 조직 페이지 (모두의AI)

**확인 불가로 남긴 것**: "24 agents / 52 skills"의 정확한 산정 기준, v3.0.2 릴리스 존재, CG 모드 60-70% 절감 수치의 독립 검증, GateGuard Fact-Force 게이트의 구현 상세(릴리스 노트 한 줄만 확보), DeepSWE 벤치마크의 재현 가능성.
