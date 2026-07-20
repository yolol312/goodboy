# Good Boy

> 세상에 나쁜 AI는 없다 — There Are No Bad Agents

Claude Code 등 agentic LLM-CLI 환경에서 LLM의 약점(컨텍스트 오염·환각·부족한 프롬프트·검증 부재)과 토큰 낭비를 hook + skill 조합으로 결정적으로 억제하는 가드레일 레이어.

## 핵심 원칙

- **결정성은 hook으로** — 모델 판단에 맡기지 않고 hook 4종(PreToolUse / PostToolUse / UserPromptSubmit / Stop)으로 강제
- **추론은 가시화** — 사실 / 추론 / 가정 / 추측 4분류로 작업 전에 출력 의무
- **검증된 방법만** — 변경 후 별도 서브에이전트가 리뷰하고 구조화 JSON으로 결과 반환
- **사용자 결정권 보존** — 위험 작업은 명시적 승인 마커 없이 진행 불가

## 어떤 문제를 푸나

LLM이 코드 작성 시 자주 발생하는 4가지 약점과 Good Boy의 해결책:

1. **컨텍스트 오염** → 넓게 훑는 탐색 도구를 서브에이전트로 위임 강제 (PreToolUse hook)
2. **환각** → 추론 4분류 가시화 + Read-before-edit + 자동 검증 + 리뷰 강제
3. **부족한 프롬프트** → 카테고리별 필수요소 사전 검증 + "확인 필요" 답변 허용
4. **검증 부재** → 별도 서브에이전트가 리뷰 후 구조화 JSON 결과 → Stop hook이 통과/차단 결정

## 설치

### Marketplace 설치 (권장)

```bash
/plugin marketplace add yolol312/goodboy
/plugin install goodboy@goodboy --scope project   # 또는 user | local. 기본은 user(글로벌)
```

설치 범위(user/project/local/session)와 이미 설치된 플러그인의 범위 전환은
[설치 범위와 전환](#설치-범위와-전환)을 참고하세요.

### 로컬 개발 모드 (플러그인 자체를 수정할 때)

```bash
claude --plugin-dir /path/to/goodboy
```

### 요구사항

- Claude Code v2.1.138+
- Bun (hook과 CLI 런타임) — **미리 설치할 필요는 없습니다.** 첫 프롬프트에서 자동 설치를
  안내하고, 프롬프트를 한 번 더 입력하면 플러그인 전용 폴더(`~/.claude/goodboy-runtime`)에
  자동 설치됩니다(시스템 전역을 건드리지 않음). 자세한 동작은
  [트러블슈팅 > "Bun 런타임이 필요합니다"](#bun-런타임이-필요합니다-라며-차단됩니다) 참고.
- **macOS / 리눅스**: 추가 요구사항 없음.
- **Windows**: [Git for Windows](https://git-scm.com/downloads/win) **필수** —
  아래 [Windows 지원](#windows-지원) 참고.

### Windows 지원

Claude Code는 Windows 네이티브에서 hook 명령을 **Git Bash가 설치돼 있으면 Git Bash로,
없으면 PowerShell로** 실행합니다. goodboy의 hook 런처(`bin/goodboy-run.sh`)와 Bash 게이트는
POSIX 셸을 전제하므로 **Git for Windows 설치가 필수**입니다. 이는 Claude Code가 Bash 도구를
쓰기 위해 권장하는 구성과 동일합니다.

| 환경 | 동작 |
|---|---|
| macOS / 리눅스 | 전 기능 |
| Windows + Git for Windows | 전 기능 (Bun 자동 설치는 Git Bash에 `unzip`이 없어 실패할 수 있음 → `powershell -c "irm bun.sh/install.ps1 \| iex"` 안내로 폴백) |
| Windows, Git Bash 없음 | **미지원.** hook이 PowerShell로 실행되어 런처가 뜨지 않고, 안전장치 전체가 동작하지 않습니다 |

알려진 공백: Git Bash가 없는 Windows에서 Claude Code는 Bash 도구 대신 PowerShell 도구를
사용합니다. goodboy의 토큰 낭비 게이트 중 Bash 명령을 검사하는 항목(재귀 탐색 차단,
대용량 출력 차단)은 PowerShell 도구 호출에는 적용되지 않습니다.

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

### 일반 프롬프트의 부족-입력 질문 유도 (B2)

슬래시 커맨드 없이 자연어로 요청해도, 매 프롬프트에 self-assessment 지시가 주입된다:
착수에 필요한 핵심 정보(대상/기대 동작/재현 방법 등)가 부족하면 **지어내지 말고
AskUserQuestion으로 묶어 질문**하고, 답 없는 항목은 `## 추론 > 가정`에 기록하라는 규칙.
충분한지의 판단은 모델이 하지만, 묻지 않고 가정으로 진행하면 추론 게이트(A1)와
추측-리뷰 연동(A2)이 그 가정의 기록·검증을 강제한다. 끄기: `GOODBOY_ASK_UNCLEAR=off`

### 동작 흐름 (예: /fix-bug)

```
사용자: /fix-bug 로그인 후 401 떨어짐
   ↓
UserPromptSubmit hook:
   - 인자가 아예 없으면(/fix-bug만) 차단하고 필수 질문 목록 안내 (결정적 차단)
   - 인자가 있으면 필수 입력 체크리스트를 모델에게 주입 → 모델이 자기점검(self-assessment)
     후 실제로 부족한 항목만 AskUserQuestion으로 질문 ("확인 필요" 옵션 포함)
   ↓
모델: ## 추론 섹션 출력 (사실/추론/가정/추측 4분류) ⚠️ 필수 — 내용까지 검사(빈 섹션 차단)
   ↓
위험도 게이트 (PreToolUse hook): 위험도 risky면 사용자 승인 마커 확인
   ↓
모델 작업: Read → Edit/Write
   - Read-before-edit hook이 Edit/Write 시 같은 파일 Read 이력 검증
   - 추론 게이트가 ## 추론 섹션 존재 + 실질 내용 검증
   ↓
PostToolUse hook이 자동 검증 실행 — 기본은 타입체크만 (GOODBOY_AUTOVALIDATE=all이면
린트/테스트까지). 실패 시 실패 마커를 남기고, 마커가 해소될 때까지 Stop hook이
턴 종료를 차단한다(재검증 통과 시 자동 해제).
   ↓
모델이 작업 완료 시도 → Stop hook이 리뷰 결과 파일 검사
   - 리뷰 대상 = 마지막 리뷰 이후 **메인이 편집한** 파일 (서브에이전트가 만든 프로브/임시
     파일은 대상 아님 — 리뷰 에이전트가 자기 프로브 파일 때문에 다시 차단되는 자기참조
     루프를 막는다)
   - 없음 → 차단, "review-changes 서브에이전트 호출하세요"
   ↓
review-changes 서브에이전트가 깊은 리뷰 (변경 파일 Read + 환각 검증 + 추론 분류 검증 + ...)
   → .claude/reviews/<ts>.json 작성 (verdict: pass | needs-changes | fail)
   ↓
Stop hook 재검사:
   - verdict=pass → 통과
   - high severity finding → 자동 수정 시도 (재시도 3회 cap)
   - 추론 섹션에 추측/가정을 선언했는데 리뷰가 가정 검증을 안 했으면 → 차단
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

위임 강제 비활성화 (디버깅용): `GOODBOY_DISABLE_DELEGATION=1`

### 토큰 낭비 게이트 (tokenhabit 카탈로그 기반)

| 습관 | 제어 | 기본 |
|---|---|---|
| H2-01 같은 파일 재-Read | deny (에이전트별 스코프, 30턴 윈도우 + 압축 감지 시 기록 리셋, mtime 비교) + 위임 프롬프트에 기독 파일 포함 시 warn | `GOODBOY_REREAD_GATE=deny`, `GOODBOY_DELEGATED_REREAD_WARN=on` |
| H2-02 출력 홍수 | bare `cat <대용량>` 사전 deny + 사후 경고(패턴별 1회) | `GOODBOY_CAT_GATE=deny`, 임계 `GOODBOY_CAT_DENY_BYTES=256000` |
| H2-03 Bash 재귀 탐색 | deny (rg/grep -r/find → 위임 유도) | `GOODBOY_BASH_SEARCH_GATE=deny` |
| (우회 차단) Bash 파일 쓰기 | deny — `> >> tee sed -i dd of=`로 프로젝트 파일 쓰기 금지 (Edit/Write 도구로 유도). 산출물(`dist/ build/ node_modules/ .git/ .claude/`)·`*.log`·프로젝트 밖 경로는 허용 | `GOODBOY_BASH_WRITE_GATE=deny`, 추가 허용 `GOODBOY_BASH_WRITE_ALLOW=a,b` |
| H2-04 웹 재페치 | 동일 URL 재페치 warn (세션 스코프) | `GOODBOY_WEBFETCH_REFETCH_WARN=on` |
| H1-01 컨텍스트 성장 | 30%부터 +10%p마다 반복 경고 | `GOODBOY_CTX_WARN_START_PCT=30`, `GOODBOY_CTX_WARN_STEP_PCT=10` |
| H1-03 compact 막차 | 50% 초과 시 턴 종료 차단 + compact 유도 | `GOODBOY_COMPACT_FORCE_PCT=50` |
| H4-03 모델 전환(캐시 킬) | 세션 내 메인 모델 전환 감지 시 1회 경고 | 상시 |

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
- **위험(risky)**: 항상 사용자 승인 마커 (`.claude/.goodboy-risk-approved.txt`) 확인

사용자가 위험 작업 승인하려면:

```bash
touch .claude/.goodboy-risk-approved.txt
# 또는 모델에게 "진행 승인" 명시 후 모델이 마커 생성
```

## 설치 범위와 전환

Good Boy는 표준 플러그인 설치 범위를 따른다.

| 범위 | 위치 | 적용 대상 |
|---|---|---|
| **user** (글로벌) | `~/.claude/settings.json` | 내 모든 프로젝트 |
| **project** | `<repo>/.claude/settings.json` | 이 프로젝트 + (git 공유 시) 팀 |
| **local** | `<repo>/.claude/settings.local.json` | 이 프로젝트, 본인만 |
| **session** | `claude --plugin-dir <path>` | 그 세션만 (일시적) |

설치:

```bash
/plugin install goodboy@goodboy --scope project   # 또는 user | local. 기본은 user(글로벌)
```

> Good Boy는 모든 편집마다 추론·리뷰 게이트가 끼어드는 무거운 플러그인이다.
> **글로벌(user)보다 project / local / session 범위를 권장한다.**

### 범위 전환 (이미 설치된 플러그인의 범위 변경)

**범위만 바꾸는 단일 명령은 없다.** 재설치 패턴을 쓴다:

```bash
claude plugin uninstall goodboy@goodboy --scope <기존>
claude plugin install   goodboy@goodboy --scope <새범위>
/reload-plugins
```

UI로:

```
/plugin → Installed 탭(User/Project/Local로 그룹화) → goodboy 선택 → Uninstall
        → Discover 탭에서 원하는 scope로 재설치
```

제거 없이 잠깐 끄려면(비활성화/재활성화):

```bash
claude plugin disable goodboy@goodboy
claude plugin enable  goodboy@goodboy
```

주의:

- 언인스톨은 CLI(`claude plugin uninstall`)가 TUI보다 안정적이다 (이슈 #52456).
- `enabledPlugins`를 `settings.local.json`에만 두면 무시되는 버그가 있다 (이슈 #25086).
  local 범위를 쓸 때는 `settings.json`에도 같은 키를 함께 둘 것.

## 컨텍스트 자동 관리 (auto-compact)

긴 세션에서 컨텍스트가 가득 차는 것을 막기 위해, Good Boy의 **Stop hook이 매 턴 transcript에서
컨텍스트 점유율을 계산**한다.

- 점유율이 **50%를 초과하면 `/compact` 실행을 권고하는 경고를 `systemMessage`로 띄운다.**
- 모델/환경과 무관하게 작동한다(transcript의 input + cache_read + cache_creation 토큰을 모델
  컨텍스트 한도로 나눠 계산. 1M 모델은 자동으로 1,000,000 한도로 인식).
- 임계치는 `hooks/stop.ts`의 `COMPACT_WARN_PCT` 상수(기본 `50`)로 조정한다.
- **단 hook은 `/compact`를 자동 실행하지 못한다(강한 권고일 뿐).** 실제 압축은 사용자가 실행한다.

### 컨텍스트 한도 판별 방식 (모델별 자동 + env 폴백)

강제 compact는 **모델의 컨텍스트 한도를 확신할 수 있을 때만** 발동한다(오탐 방지).
한도는 다음 순서로 판별한다:

1. `GOODBOY_CONTEXT_LIMIT` env (최우선, 사용자 명시)
2. 세션 1M 표식 감지 (`[1m]` — hook 입력 / transcript / settings.json)
3. **모델별 확정 테이블**: Fable/Mythos 패밀리 → **1M 확정**(1M이 기본값이자 최대인
   패밀리라 토글 모호함이 없음, 설정 불필요) · haiku, claude-2/3 세대 → 200K 확정
4. 그 외(1M 토글이 가능한 opus/sonnet 4.6+에 표식이 없는 세션, 미지 신규 패밀리)
   → **한도 미확정으로 간주되어 강제가 보류된다.**

미확정 상태(상태바에 `N%?`로 표시)에서는 셸에서 한도를 명시해 강제를 복구한다
(세션에서 `/context`를 실행하면 창 크기를 확인할 수 있다):

```bash
export GOODBOY_CONTEXT_LIMIT=200000    # 또는 1000000 (1M 세션)
```

(선택) 네이티브 auto-compact도 함께 낮추려면 셸에서:

```bash
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50   # 기본 발동은 ~83%
```

> **주의:** 1M extended-context 모델(예: Opus 1M)에선 이 override가 버그로 무시될 수 있고
> (이슈 #53801), `settings.json`의 `env` 블록도 무시되므로(이슈 #63186) **셸 export로 설정**해야
> 하며, 그래도 동작이 불확실하다. 그래서 **위 Stop hook 경고가 신뢰할 수 있는 기본 메커니즘**이다.

## 상태바 (선택 설치)

Good Boy의 상태는 3층으로 노출된다:

1. **대화 내 경고 (기본)** — 컨텍스트 성장/긴 세션/게이트 차단 사유. 아무 설정 없이 작동.
2. **상태 파일 (공용 원천)** — Stop hook이 매 턴 `$TMPDIR/goodboy-session-<id>/status.json`에
   스냅샷 기록: 컨텍스트 %(게이트가 쓰는 계산값 그대로), 카테고리/위험도, 리뷰 대기,
   검증 실패, 게이트 deny 누계. 같은 디렉터리의 `gate-log.jsonl`에 게이트 발동/판단불가 이력.
3. **상태바 (선택)** — `/setup-statusline` 스킬로 동봉 상태바를 설치하거나,
   **이미 상태바가 있다면** 그 스크립트가 위 status.json을 읽어 한 칸 추가하면 된다
   (설치 스킬이 두 경우를 모두 안내하며, 기존 상태바를 덮어쓰지 않는다).

동봉 상태바 표시 예: `🐶 🧠 16% | 🟡fix-bug | 📋 리뷰대기 | 🚧 3`
`🧠 N%?`처럼 물음표가 붙으면 모델 한도 미확정(강제 compact 보류 중) — `GOODBOY_CONTEXT_LIMIT`을 설정하라.

## 계측 (게이트 무력화 감지)

모든 게이트는 fail-open(불확실하면 조용히 통과)이라, 게이트가 죽어도 겉으로 티가 나지 않는다.
이를 가시화하기 위해:

- 게이트의 deny/warn/판단불가(fail-open)를 세션 디렉터리 `gate-log.jsonl`에 기록한다.
- 컨텍스트 측정이 연속 3회 실패하면 "컨텍스트 자동 관리가 비활성일 수 있다"는 canary 경고를
  세션당 1회 띄운다 (transcript 포맷 변경 등으로 인한 소리 없는 무력화 감지).

## 디렉터리 구조

```
goodboy/                                # 플러그인 루트
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── hooks/                              # hook 4종
│   ├── hooks.json
│   ├── pre-tool-use.ts
│   ├── post-tool-use.ts
│   ├── user-prompt-submit.ts
│   └── stop.ts
├── skills/                             # 작업 카테고리 7종 + 설치 스킬
│   ├── fix-bug/SKILL.md
│   ├── add-feature/SKILL.md
│   ├── refactor/SKILL.md
│   ├── migrate/SKILL.md
│   ├── debug/SKILL.md
│   ├── write-doc/SKILL.md
│   ├── request-review/SKILL.md
│   └── setup-statusline/SKILL.md       # 상태바 설치/연동
├── agents/
│   └── review-changes.md
├── statusline/
│   └── statusline.ts                   # 동봉 상태바 (선택 설치)
├── lib/
│   ├── index.ts
│   ├── types.ts
│   ├── required-inputs.ts
│   ├── reasoning-parser.ts
│   ├── risk-classifier.ts
│   ├── review-validator.ts
│   ├── review-cursor.ts
│   ├── review-dimensions.ts
│   ├── context-usage.ts                # auto-compact 점유율 계산 (게이트/상태바 공용)
│   ├── transcript-parser.ts
│   ├── file-tracker.ts
│   ├── validation-state.ts             # 자동 검증 실패 마커 (Stop 게이트용)
│   ├── gate-log.ts                     # 게이트 발동 로그 + 상태 스냅샷
│   ├── token-habits.ts                 # 토큰 낭비 습관 카탈로그 + 게이트 헬퍼
│   ├── recursion-guard.ts
│   └── cli.ts
├── package.json
└── README.md
```

프로젝트별 데이터:

```
<project>/.claude/
├── reviews/                            # review-changes 결과 JSON
└── (마커 파일들 — .goodboy-session-state.json, .goodboy-risk-approved.txt,
    .goodboy-retry-count.txt, .goodboy-review-cursor.json 등)
```

## 트러블슈팅

### "Bun 런타임이 필요합니다" 라며 차단됩니다

goodboy의 hook은 Bun으로 실행됩니다. Bun이 없으면 hook 앞단의 셸 가드(Bun 불필요)가
개입합니다:

1. **첫 프롬프트**: "다시 입력하면 자동 설치" 안내와 함께 프롬프트 반려
2. **10분 내 재입력**: `~/.claude/goodboy-runtime`에 Bun 자동 설치(공식 설치 스크립트,
   시스템 전역 아님) 후 그대로 정상 진행
3. 설치 전까지 도구 사용(PreToolUse)도 차단됩니다 — 게이트가 조용히 무력화된 채
   작동하는 척하는 것을 막기 위함

관련 스위치:

| env | 효과 |
|---|---|
| `GOODBOY_AUTO_INSTALL=off` | 자동 설치 끔 (차단 + 수동 설치 안내는 유지) |
| `GOODBOY_BUN_GUARD=off` | 가드 전체 끔 — Bun 없으면 예전처럼 조용히 무동작 (비상용) |
| `GOODBOY_RUNTIME_DIR` | 자동 설치 위치 변경 |
| `GOODBOY_INSTALL_CMD` | 설치 명령 대체 (사내 미러 등; `BUN_INSTALL`이 export됨) |

수동 설치를 원하면 macOS/리눅스는 `curl -fsSL https://bun.sh/install | bash`,
Windows(Git Bash)는 `powershell -c "irm bun.sh/install.ps1 | iex"` 후 다시 시도하면 됩니다.
자동 설치가 실패하는 경우(네트워크 차단, `curl`/`unzip` 부재)에도 플랫폼에 맞는 수동 설치
안내가 표시됩니다.

### "WebSearch가 차단됩니다"

정상 동작입니다. WebSearch/WebFetch/Grep/Glob은 메인에서 차단되고 서브에이전트로 위임 강제됩니다.

```
Agent 도구로 서브에이전트 호출 (예: general-purpose)
```

### "Edit가 차단됩니다 — Read-before-edit"

편집 전에 같은 파일을 Read 도구로 먼저 읽으세요. 새 파일 생성은 면제.

### "Edit가 차단됩니다 — 추론 게이트"

편집 전에 `## 추론` 섹션을 출력하세요 (사실/추론/가정/추측 4분류).

같은 응답 안에서 추론을 쓰고 바로 편집하면 transcript 기록 지연으로 아직 인식되지 않을 수
있습니다 — 같은 편집을 다시 시도하세요. 3회 연속 미인식이면 게이트가 **지연 모드**로 전환되어
이후 이 세션에서는 차단 없이 경고만 냅니다(기록 지연이 확인된 세션에서 편집마다 헛 차단이
반복되는 것을 막기 위해 세션 내내 유지 — 인식 성공 시 재무장하는 구 동작은
`GOODBOY_REASONING_LAG_STICKY=rearm`). 문서 파일(.md/.txt/.rst/.adoc 등) 편집은 기본
면제됩니다(`GOODBOY_REASONING_DOC_EXEMPT=off`로 복원). 서브에이전트가 편집할 때는
**서브에이전트 자신이 쓴** 추론 섹션으로 판정합니다(메인의 글이 아님).

### "Stop이 차단됩니다 — 리뷰 필요"

`/review-changes` 슬래시 커맨드를 실행하거나 review-changes 서브에이전트를 호출하세요:

```
Agent(general-purpose, "review-changes 스킬에 따라 다음 파일을 리뷰: <변경 파일 목록>")
```

### "위험 작업이 차단됩니다"

사용자 승인이 필요합니다. `touch .claude/.goodboy-risk-approved.txt`

### "Bash로 프로젝트 파일을 쓰려 합니다" 라며 차단됩니다

정상 동작입니다. `cat > src/x.ts <<EOF`, `sed -i`, `tee` 같은 Bash 쓰기는 read-before-edit·
추론 게이트를 지나치고 편집 기록에도 남지 않아 **리뷰 강제와 자동 검증까지 통째로 무력화**
합니다(라이브 검증에서 서브에이전트가 추론 게이트에 8회 막힌 뒤 heredoc으로 우회한 사례가
실측되었습니다). 파일 생성·수정은 Edit/Write 도구를 쓰세요.

- 임시 프로브 파일은 `mktemp -d`가 만든 프로젝트 밖 디렉터리에 만드세요(허용됨).
- 빌드 산출물(`dist/`, `build/`, `node_modules/`, `.git/`, `.claude/`)과 `*.log`는 허용됩니다.
- 특정 경로를 더 허용하려면 `GOODBOY_BASH_WRITE_ALLOW=scratch,tmpout` (cwd 기준 상대 경로).
- 게이트 해제: `GOODBOY_BASH_WRITE_GATE=off` (또는 `warn`으로 경고만). env는 Claude Code를
  띄운 셸(또는 settings의 env)에 설정해야 hook 프로세스에 전달됩니다 — 대화 중 Bash 명령
  앞에 붙이는 방식은 hook에 적용되지 않습니다.

**대량 범위 편집** (수백 줄 주석 블록 삭제 등 Edit의 old_string 재현이 비현실적인 경우):

1. 권장 — Read로 범위를 확인한 뒤 **Write 도구로 파일 전체를 재작성**합니다.
2. 사용자 승인을 받은 경우 — `touch .claude/.goodboy-bash-write-approved.txt` 후 같은
   명령(`sed -i` 등)을 다시 실행하세요. **1회용** 승인이며, 대상 파일은 편집 기록에
   남아 리뷰 추적·Stop 리뷰 게이트가 그대로 유지됩니다.

**한계**: `python -c "open('x','w')"` 처럼 인터프리터 내부에서 쓰는 경로는 잡지 못합니다.
"무심코 우회"를 막는 것이 목적이며, 결심한 우회를 원천 봉쇄하지는 못합니다.

### 자동 검증 실행 안 됨

- **기본 모드는 typecheck만 실행한다** (`GOODBOY_AUTOVALIDATE=typecheck` 기본).
  린트/테스트까지 돌리려면 `GOODBOY_AUTOVALIDATE=all` (미신뢰 repo의 스크립트 자동 실행
  위험이 있어 기본에서 제외). `off`면 검증 안 함.
- `package.json`에 해당 스크립트(`typecheck`/`lint`/`test`)가 있어야 실행됨
- `pyproject.toml`은 `ruff`(all이면 `pytest`)가 PATH에 있어야 함
- 없으면 검증 스킵 (실패 아님)

### "Stop이 차단됩니다 — 검증 게이트"

자동 검증이 실패한 상태입니다. 실패한 검증(타입 에러 등)을 수정하세요 — 파일을 편집하면
검증이 자동 재실행되고, 통과하면 차단이 해제됩니다. 3회 차단 후에는 사용자 확인 안내와 함께
통과됩니다.

### "Edit가 차단됩니다 — 추론 섹션이 비어 있습니다"

`## 추론` 제목만 출력하고 내용이 없으면 차단됩니다. 4분류 각각에 실제 항목을 쓰세요
(해당 없는 분류는 `- 없음`으로 명시).

### auto-compact 경고가 안 뜸

Stop hook은 transcript의 토큰 usage를 best-effort로 파싱합니다. Claude Code transcript 포맷이
비공식이라 파싱에 실패하면(usage 정보 없음 등) 경고 없이 조용히 통과합니다(측정 실패는 차단이
아닙니다). 점유율이 50% 이하면 경고가 뜨지 않는 것이 정상입니다.

## 개발 상태

배포됨. 현재 버전은 `.claude-plugin/plugin.json` / `package.json`을 기준으로 한다
(README에 버전을 하드코딩하지 않는다 — 갱신 누락으로 실제와 어긋나기 쉬움).

## 라이센스

MIT — [LICENSE](LICENSE) 참고.

## 기여

이슈/PR: https://github.com/yolol312/goodboy
