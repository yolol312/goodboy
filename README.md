# vcf — Vibe Coding Framework

Claude Code 환경에서 LLM의 4대 약점을 hook + skill 조합으로 결정적으로 강제하는 메타 레이어.

## 핵심 원칙

- **결정성은 hook으로** — 모델 판단에 맡기지 않고 hook 4종(PreToolUse / PostToolUse / UserPromptSubmit / Stop)으로 강제
- **추론은 가시화** — 사실 / 추론 / 가정 / 추측 4분류로 작업 전에 출력 의무
- **검증된 방법만** — 변경 후 별도 서브에이전트가 리뷰하고 구조화 JSON으로 결과 반환
- **사용자 결정권 보존** — 위험 작업은 명시적 승인 마커 없이 진행 불가

## 어떤 문제를 푸나

LLM이 코드 작성 시 자주 발생하는 4가지 약점과 vcf의 해결책:

1. **컨텍스트 오염** → 넓게 훑는 탐색 도구를 서브에이전트로 위임 강제 (PreToolUse hook)
2. **환각** → 추론 4분류 가시화 + Read-before-edit + 자동 검증 + 리뷰 강제
3. **부족한 프롬프트** → 카테고리별 필수요소 사전 검증 + "확인 필요" 답변 허용
4. **검증 부재** → 별도 서브에이전트가 리뷰 후 구조화 JSON 결과 → Stop hook이 통과/차단 결정

## 설치

### 로컬 개발 모드 (지금 권장)

```bash
claude --plugin-dir /Users/seongmo/workspace/vcf
```

### Marketplace 설치 (배포 후)

```bash
/plugin marketplace add seongmo/vcf
/plugin install vcf@vcf --scope project   # 또는 user | local. 기본은 user(글로벌)
```

설치 범위(user/project/local/session)와 이미 설치된 플러그인의 범위 전환은
[설치 범위와 전환](#설치-범위와-전환)을 참고하세요.

### 요구사항

- Claude Code v2.1.138+
- Bun (hook과 CLI 런타임)

## 사용법

### 카테고리 슬래시 커맨드

7개 카테고리:

- `/fix-bug <설명>` — 버그 수정
- `/add-feature <설명>` — 기능 추가
- `/refactor <설명>` — 리팩토링
- `/migrate <설명>` — 마이그레이션 (위험도: 위험)
- `/debug <증상>` — 디버깅
- `/write-doc <주제>` — 문서 작성
- `/request-review <기준>` — 리뷰 요청

각 카테고리에 위험도 override 가능: `/fix-bug --risk risky <설명>`

### 동작 흐름 (예: /fix-bug)

```
사용자: /fix-bug 로그인 후 401 떨어짐
   ↓
UserPromptSubmit hook이 필수 요소 누락 검출 → AskUserQuestion으로 묶어 질문
"재현 방법?", "기대 동작?", "현재 동작?", "관련 파일?" (각 "확인 필요" 옵션 포함)
   ↓
모델: ## 추론 섹션 출력 (사실/추론/가정/추측 4분류) ⚠️ 필수
   ↓
위험도 게이트 (PreToolUse hook): 위험도 risky면 사용자 승인 마커 확인
   ↓
모델 작업: Read → Edit/Write
   - Read-before-edit hook이 Edit/Write 시 같은 파일 Read 이력 검증
   - 추론 게이트가 ## 추론 섹션 존재 검증
   ↓
PostToolUse hook이 자동 검증 (타입체크/린트/테스트) 실행
   ↓
모델이 작업 완료 시도 → Stop hook이 리뷰 결과 파일 검사
   - 없음 → 차단, "review-changes 서브에이전트 호출하세요"
   ↓
review-changes 서브에이전트가 깊은 리뷰 (변경 파일 Read + 환각 검증 + 추론 분류 검증 + ...)
   → .claude/reviews/<ts>.json 작성 (verdict: pass | needs-changes | fail)
   ↓
Stop hook 재검사:
   - verdict=pass → 통과
   - high severity finding → 자동 수정 시도 (재시도 3회 cap)
   - medium/low → 사용자에게 표시 후 결정 위임
```

### 도구 위임

탐색 도구는 서브에이전트로 강제 위임하고, 콕 집어 읽기·고치기·판단은 메인이 직접 한다.
한 줄로: **"넓게 훑기는 서브에, 콕 집어 읽기·고치기는 메인에."**

| 동작 | 도구 | 수행 주체 |
|---|---|---|
| 넓게 훑기 (강제 위임) | WebSearch / WebFetch / Grep / Glob | 서브에이전트 |
| 콕 집어 읽기 | Read | 메인 |
| 편집·판단 | Edit / Write / 그 외 | 메인 |

PreToolUse hook이 메인에서 탐색 도구 4종 호출을 차단하고 서브에이전트 위임을 유도한다.
(서브에이전트 내부에서는 면제 — 서브가 직접 Grep/Glob 등을 쓴다.)

위임 강제 비활성화 (디버깅용): `VCF_DISABLE_DELEGATION=1`

## 추론 4분류

모든 카테고리 Skill이 작업 전에 `## 추론` 섹션 출력을 의무화. PreToolUse hook이 없으면 Edit/Write 차단.

```markdown
## 추론

### 사실 (검증됨)
- 실제 Read한 코드/문서로 확인된 것만

### 추론 (사실에서 도출, 검증 가능)
- 검증 가능한 논리적 추론

### 가정 (정보 부족)
- 사용자가 "확인 필요"라 답한 항목 — 어떻게 가정하고 진행할지

### 추측 ⚠️ (근거 약함)
- 검증 없이 채운 부분. 리뷰 서브에이전트가 우선 검증
```

## 위험도 게이트

룰 기반 위험도 분류:

- 카테고리 기본값 (Skill frontmatter의 `risk_default`)
- 변경 파일 3+개면 한 단계 상향
- 위험 키워드 감지 (prod, production, 운영, DROP TABLE, migrate, rm -rf, --force) → 위험으로 고정

위험도별 게이트:

- **단순(simple)**: 자동 진행 — 추론 가시화만 필수
- **중간(medium)**: 추측 카테고리에 항목 있으면 사용자 확인 권장
- **위험(risky)**: 항상 사용자 승인 마커 (`.claude/.vcf-risk-approved.txt`) 확인

사용자가 위험 작업 승인하려면:

```bash
touch .claude/.vcf-risk-approved.txt
# 또는 모델에게 "진행 승인" 명시 후 모델이 마커 생성
```

## 설치 범위와 전환

vcf는 표준 플러그인 설치 범위를 따른다.

| 범위 | 위치 | 적용 대상 |
|---|---|---|
| **user** (글로벌) | `~/.claude/settings.json` | 내 모든 프로젝트 |
| **project** | `<repo>/.claude/settings.json` | 이 프로젝트 + (git 공유 시) 팀 |
| **local** | `<repo>/.claude/settings.local.json` | 이 프로젝트, 본인만 |
| **session** | `claude --plugin-dir <path>` | 그 세션만 (일시적) |

설치:

```bash
/plugin install vcf@vcf --scope project   # 또는 user | local. 기본은 user(글로벌)
```

> vcf는 모든 편집마다 추론·리뷰 게이트가 끼어드는 무거운 플러그인이다.
> **글로벌(user)보다 project / local / session 범위를 권장한다.**

### 범위 전환 (이미 설치된 플러그인의 범위 변경)

**범위만 바꾸는 단일 명령은 없다.** 재설치 패턴을 쓴다:

```bash
claude plugin uninstall vcf@vcf --scope <기존>
claude plugin install   vcf@vcf --scope <새범위>
/reload-plugins
```

UI로:

```
/plugin → Installed 탭(User/Project/Local로 그룹화) → vcf 선택 → Uninstall
        → Discover 탭에서 원하는 scope로 재설치
```

제거 없이 잠깐 끄려면(비활성화/재활성화):

```bash
claude plugin disable vcf@vcf
claude plugin enable  vcf@vcf
```

주의:

- 언인스톨은 CLI(`claude plugin uninstall`)가 TUI보다 안정적이다 (이슈 #52456).
- `enabledPlugins`를 `settings.local.json`에만 두면 무시되는 버그가 있다 (이슈 #25086).
  local 범위를 쓸 때는 `settings.json`에도 같은 키를 함께 둘 것.

## 컨텍스트 자동 관리 (auto-compact)

긴 세션에서 컨텍스트가 가득 차는 것을 막기 위해, vcf의 **Stop hook이 매 턴 transcript에서
컨텍스트 점유율을 계산**한다.

- 점유율이 **50%를 초과하면 `/compact` 실행을 권고하는 경고를 `systemMessage`로 띄운다.**
- 모델/환경과 무관하게 작동한다(transcript의 input + cache_read + cache_creation 토큰을 모델
  컨텍스트 한도로 나눠 계산. 1M 모델은 자동으로 1,000,000 한도로 인식).
- 임계치는 `hooks/stop.ts`의 `COMPACT_WARN_PCT` 상수(기본 `50`)로 조정한다.
- **단 hook은 `/compact`를 자동 실행하지 못한다(강한 권고일 뿐).** 실제 압축은 사용자가 실행한다.

(선택) 네이티브 auto-compact도 함께 낮추려면 셸에서:

```bash
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50   # 기본 발동은 ~83%
```

> **주의:** 1M extended-context 모델(예: Opus 1M)에선 이 override가 버그로 무시될 수 있고
> (이슈 #53801), `settings.json`의 `env` 블록도 무시되므로(이슈 #63186) **셸 export로 설정**해야
> 하며, 그래도 동작이 불확실하다. 그래서 **위 Stop hook 경고가 신뢰할 수 있는 기본 메커니즘**이다.

## 디렉터리 구조

```
vcf/                                    # 플러그인 루트
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/                              # hook 4종
│   ├── hooks.json
│   ├── pre-tool-use.ts
│   ├── post-tool-use.ts
│   ├── user-prompt-submit.ts
│   └── stop.ts
├── skills/                             # 작업 카테고리 7종
│   ├── fix-bug/SKILL.md
│   ├── add-feature/SKILL.md
│   ├── refactor/SKILL.md
│   ├── migrate/SKILL.md
│   ├── debug/SKILL.md
│   ├── write-doc/SKILL.md
│   └── request-review/SKILL.md
├── agents/
│   └── review-changes.md
├── lib/
│   ├── index.ts
│   ├── types.ts
│   ├── required-inputs.ts
│   ├── reasoning-parser.ts
│   ├── risk-classifier.ts
│   ├── review-validator.ts
│   ├── review-cursor.ts
│   ├── review-dimensions.ts
│   ├── context-usage.ts                # auto-compact 점유율 계산
│   ├── transcript-parser.ts
│   ├── file-tracker.ts
│   └── cli.ts
├── package.json
└── README.md
```

프로젝트별 데이터:

```
<project>/.claude/
├── reviews/                            # review-changes 결과 JSON
└── (마커 파일들 — .vcf-session-state.json, .vcf-risk-approved.txt,
    .vcf-retry-count.txt, .vcf-review-cursor.json 등)
```

## 트러블슈팅

### "WebSearch가 차단됩니다"

정상 동작입니다. WebSearch/WebFetch/Grep/Glob은 메인에서 차단되고 서브에이전트로 위임 강제됩니다.

```
Agent 도구로 서브에이전트 호출 (예: general-purpose)
```

### "Edit가 차단됩니다 — Read-before-edit"

편집 전에 같은 파일을 Read 도구로 먼저 읽으세요. 새 파일 생성은 면제.

### "Edit가 차단됩니다 — 추론 게이트"

편집 전에 `## 추론` 섹션을 출력하세요 (사실/추론/가정/추측 4분류).

### "Stop이 차단됩니다 — 리뷰 필요"

`/review-changes` 슬래시 커맨드를 실행하거나 review-changes 서브에이전트를 호출하세요:

```
Agent(general-purpose, "review-changes 스킬에 따라 다음 파일을 리뷰: <변경 파일 목록>")
```

### "위험 작업이 차단됩니다"

사용자 승인이 필요합니다. `touch .claude/.vcf-risk-approved.txt`

### 자동 검증 실행 안 됨

- `package.json`에 `typecheck` / `lint` / `test` 스크립트가 있어야 자동 실행됨
- `pyproject.toml`은 `ruff`, `pytest`가 PATH에 있어야 함
- 없으면 검증 스킵 (실패 아님)

### auto-compact 경고가 안 뜸

Stop hook은 transcript의 토큰 usage를 best-effort로 파싱합니다. Claude Code transcript 포맷이
비공식이라 파싱에 실패하면(usage 정보 없음 등) 경고 없이 조용히 통과합니다(측정 실패는 차단이
아닙니다). 점유율이 50% 이하면 경고가 뜨지 않는 것이 정상입니다.

## 개발 상태

🚧 v0.1.0 — 개발 중.

## 라이센스

(미정 — 추후 결정)

## 기여

이슈/PR: (저장소 URL 추후)
