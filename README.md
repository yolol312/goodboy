# Good Boy

> 세상에 나쁜 AI는 없다 — There Are No Bad Agents

Claude Code 등 agentic LLM-CLI 환경에서 LLM의 약점(컨텍스트 오염·환각·부족한 프롬프트·검증 부재)과 토큰 낭비를 hook + skill 조합으로 결정적으로 억제하는 가드레일 레이어.

## 핵심 원칙

- **결정성은 hook으로** — 모델 판단에 맡기지 않고 hook 4종(PreToolUse / PostToolUse / UserPromptSubmit / Stop)으로 강제
- **결정 근거 기록** — 사실 / 판단 / 가정 / 추측 4분류로 결론과 근거를 작업 전에 짧게 요약 (기본은 권장 + 1회 안내, `GOODBOY_REASONING_GATE=deny`면 차단 강제)
- **검증된 방법만** — 변경 후 별도 서브에이전트가 리뷰하고 구조화 JSON으로 결과 반환
- **사용자 결정권 보존** — 위험 작업은 명시적 승인 마커 없이 진행 불가

## 어떤 문제를 푸나

LLM이 코드 작성 시 자주 발생하는 4가지 약점과 Good Boy의 해결책:

1. **컨텍스트 오염** → 넓게 훑는 탐색 도구를 서브에이전트로 위임 강제 (PreToolUse hook)
2. **환각** → 결정 근거 기록(4분류) + Read-before-edit + 자동 검증 + 리뷰 강제
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
AskUserQuestion으로 묶어 질문**하고, 답 없는 항목은 `## 근거 > 가정`에 기록하라는 규칙.
충분한지의 판단은 모델이 하지만, 묻지 않고 가정으로 진행하면 근거 게이트(A1)와
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
모델: ## 근거 섹션에 결정 근거 요약 (사실/판단/가정/추측 4분류) — 기본은 권장(없거나 비면 1회 안내),
      GOODBOY_REASONING_GATE=deny면 필수 + 내용까지 검사(빈 섹션 차단)
   ↓
위험도 게이트 (PreToolUse hook): 위험도 risky면 사용자 승인 마커 확인
   ↓
모델 작업: Read → Edit/Write
   - Read-before-edit hook이 Edit/Write 시 같은 파일 Read 이력 검증
   - 근거 게이트가 ## 근거 섹션 존재 + 실질 내용 검사 (기본 warn=안내만, deny=차단, off=검사 안 함)
   ↓
PostToolUse hook이 자동 검증 실행 — 기본은 타입체크만 (GOODBOY_AUTOVALIDATE=all이면
린트/테스트까지). 실패 시 실패 마커를 남기고, 마커가 해소될 때까지 Stop hook이
턴 종료를 차단한다(재검증 통과 시 자동 해제).
   ↓
모델이 작업 완료 시도 → Stop hook 층1 **테스트 게이트** (리뷰보다 먼저)
   - 없음 → 차단, "test-changes 서브에이전트 호출하세요"
   ↓
test-changes 서브에이전트가 동작을 검증
   - 컨테이너(docker compose)로 서버/DB 기동 → 단위·통합·E2E(Playwright) 작성·실행
   - dev-cycle 프로토타입이 있으면 **정답지로 대조** (구조·능력·상태, 픽셀 아님)
   - red-green + 뮤테이션 프로브로 "통과하지만 아무것도 검증하지 않는 테스트" 배제
   → .claude/tests/<ts>.json 작성. 테스트 파일 자체는 repo에 남는다
   ↓
Stop hook 재검사(층1): 스위트 실패 0 / test_files 실재 / red가 실패했는지 /
   UI 기준의 뮤테이션 감지 / 수용 기준 커버리지 / 가짜 테스트 패턴 → 하나라도 미달이면 차단
   ↓
모델이 다시 완료 시도 → Stop hook 층2 **리뷰 게이트**
   - 리뷰 대상 = 마지막 리뷰 이후 **메인이 편집한** 파일 (서브에이전트가 만든 프로브/임시
     파일은 대상 아님 — 리뷰 에이전트가 자기 프로브 파일 때문에 다시 차단되는 자기참조
     루프를 막는다)
   - 없음 → 차단, "review-changes 서브에이전트 호출하세요"
   ↓
review-changes 서브에이전트를 **축별로 병렬 호출** (한 메시지에서 동시에)
   hallucination(항상) · refactoring · security · performance · ui
   → 각 축이 자기 .claude/reviews/<ts>.json 작성. Stop이 합집합으로 커버리지 판정
   ↓
Stop hook 재검사(층2):
   - verdict=pass → 통과
   - high severity finding → 자동 수정 시도 (재시도 3회 cap)
   - ## 근거 섹션에 추측/가정을 선언했는데 리뷰가 가정 검증을 안 했으면 → 차단
   - 필수 차원 누락 → 차단
   - medium/low → 사용자에게 표시 후 결정 위임
```

### 검증 4층

| 층 | 언제 | 무엇을 묻나 | 산출물 |
|---|---|---|---|
| **층0 인용 검증** | **매 턴 (편집 없어도)** | 인용한 `파일:줄`이 실재하는가 · 실제로 읽었는가 | (없음, 기계 판정) |
| **자동 검증** | Edit/Write 직후 | 타입이 맞는가 | (마커) |
| **층1 테스트** | 턴 종료 시, 리뷰보다 먼저 | **동작하는가 · 요구를 만족하는가** | `.claude/tests/*.json` + repo의 테스트 파일 |
| **층2 리뷰** | 테스트 통과 후 | 환각 · 리팩토링 · 성능 · 보안 | `.claude/reviews/*.json` |

순서가 뒤집히면 안 된다 — 리뷰(리팩토링·성능·보안)는 "동작은 맞다"를 전제로 하는 검토다.

## 층0 인용 검증

다른 모든 게이트는 **편집이 있을 때만** 발동한다. 그래서 코드베이스를 설명만 하는 답변 턴은
통째로 무검증이었다 — `파일:줄`을 대고 단정해도 아무도 확인하지 않았다. 층0이 그 구멍을 메운다.

| 검사 | 위반 시 |
|---|---|
| 인용한 파일이 실재하는가 | **확정 환각** → 즉시 차단, 정정 요구 |
| 인용한 줄이 파일 길이 안인가 | **확정 환각** → 즉시 차단 |
| 그 파일을 이 세션에서 읽었는가 | 근거 미확인 → 차단. 반복되면 `hallucination` 축 리뷰로 승격 |

**오탐을 막는 설계**가 핵심이다. 이 게이트는 모든 턴에 발동하므로 오탐이 잦으면 통째로 꺼진다:

- **`파일:줄` 형식만** 인용으로 본다. 백틱 경로 단순 언급(`` `package.json` ``)이나 URL, 버전
  문자열은 건드리지 않는다
- 줄 번호는 **파일 길이 초과**만 본다(내용 일치까지 보지 않음 — 편집으로 줄이 밀리는 것은 정상)
- **읽기 기록이 통째로 없으면 판정을 생략**한다 — 압축(compact) 직후에는 기록이 비므로

이 게이트가 성립하려면 **Bash 읽기 추적**이 필요하다. bypass permissions 모드에서는 시스템이
"파일은 `cat`/`sed -n`으로 읽어라"라고 지시하는데, 예전에는 `Read` 도구만 기록해서 정직하게
읽은 세션조차 읽기 이력이 0이었다. 이제 `cat`/`head`/`tail`/`sed -n`/`bat`/`less` 로 읽은
프로젝트 파일도 읽기로 기록한다(`grep`/`rg`는 제외 — 검색은 "그 파일을 봤다"는 증거가 아니다).

### 판정 대상은 "이번 턴의 답변"이다

Stop 훅은 이번 턴의 답변이 transcript에 기록되기 **전에** 실행될 수 있다(실측 130ms 차).
그대로 두면 게이트가 판정 대상을 못 보고 환각을 통째로 놓치거나, 반대로 **직전 턴 답변**을
판정해 이미 정정한 주장을 재차단한다. 그래서:

- 마지막 사용자 프롬프트 뒤에 답변 텍스트가 있어야 판정한다
- 없으면 최대 3초 폴링한다 (`GOODBOY_CLAIM_FLUSH_WAIT_MS`, 상한 8초)
- 사용자 프롬프트 자체가 없는 transcript는 기다리지 않고 건너뛴다
- 끝내 안 보이면 판정하지 않는다 — 정정된 주장을 재차단하는 쪽이 미검출보다 나쁘다

### 훅 발화는 사용자 발화가 아니다

하니스는 차단 사유를 *user* 엔트리로 되먹인다. 그 사유에는 문제의 인용이 그대로 들어 있어서,
"사용자가 먼저 쓴 인용은 모델 주장이 아니다" 규칙에 걸려 **첫 차단 이후 같은 환각이 영구
면역**됐다(실측). 이제 모든 차단 메시지에 `[goodboy 훅]` 출처가 붙고, 층0은 그 표식이 붙은
발화를 사용자 발화로 세지 않는다. 같은 표식이 **서브에이전트가 게이트 메시지를 프롬프트
인젝션으로 오인해 무시하던 문제**도 함께 막는다.

끄기: `GOODBOY_CLAIM_GATE=off`

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
| H2-03 Bash 재귀 탐색 | deny (rg/grep -r/find → 위임 유도). 출력이 제한된 검색은 허용 — 바로 다음 파이프가 `head`/`tail`/`wc`(모든 검색 도구), grep 계열의 `-l`/`-c`/`-q`. `--exclude-dir`만으로는 허용 안 함 | `GOODBOY_BASH_SEARCH_GATE=deny` |
| (우회 차단) Bash 파일 쓰기 | deny — `> >> tee sed -i dd of=`로 프로젝트 파일 쓰기 금지 (Edit/Write 도구로 유도). 산출물(`dist/ build/ node_modules/ .git/ .claude/`)·`*.log`·프로젝트 밖 경로는 허용 | `GOODBOY_BASH_WRITE_GATE=deny`, 추가 허용 `GOODBOY_BASH_WRITE_ALLOW=a,b` |
| H2-04 웹 재페치 | 동일 URL 재페치 warn (세션 스코프) | `GOODBOY_WEBFETCH_REFETCH_WARN=on` |
| H1-01 컨텍스트 성장 | 30%부터 +10%p마다 반복 경고 | `GOODBOY_CTX_WARN_START_PCT=30`, `GOODBOY_CTX_WARN_STEP_PCT=10` |
| H1-03 compact 막차 | 50% 초과 시 턴 종료 차단 + compact 유도 | `GOODBOY_COMPACT_FORCE_PCT=50` |
| H4-03 모델 전환(캐시 킬) | 세션 내 메인 모델 전환 감지 시 1회 경고 | 상시 |

## 결정 근거 기록 (4분류)

모든 카테고리 Skill이 작업 전에 `## 근거` 섹션에 결론과 근거를 짧게 요약하도록 요구한다.
리뷰(`hallucination` 축)가 이 섹션의 가정·추측을 검증한다. 구 헤딩 `## 추론` / `### 추론`도 계속 인식한다.

```markdown
## 근거

### 사실 (검증됨)
- 실제 Read한 코드/문서로 확인된 것만

### 판단 (확인된 사실에서 나온 결론)
- 결론만 한 줄씩

### 가정 (정보 부족)
- 사용자가 "확인 필요"라 답한 항목 — 어떻게 가정하고 진행할지

### 추측 ⚠️ (근거 약함)
- 검증 없이 채운 부분. 리뷰 서브에이전트가 우선 검증
```

PreToolUse의 근거 게이트는 코드 편집(Edit/Write/MultiEdit) 직전에 최근 assistant 텍스트에서 이 섹션을 찾는다.
문서 파일(.md/.txt 등) 편집은 기본 면제.

| env | 효과 |
|---|---|
| `GOODBOY_REASONING_GATE=warn` (기본) | 차단하지 않는다. 섹션이 없거나 비어 있으면 에이전트 스코프(메인/서브에이전트별)당 1회만 안내하고 이후는 게이트 로그만 남긴다. 텍스트 없이 바로 편집(무언 편집)은 로그만 |
| `GOODBOY_REASONING_GATE=deny` | 섹션 미인식·무언 편집·빈 섹션을 차단 (3회 후 지연 모드 escape, 재시도 플러시 대기, 지연 확정 포함 — 아래 트러블슈팅 참조) |
| `GOODBOY_REASONING_GATE=off` | 근거 게이트 전체를 끈다 |

## 위험도 게이트

룰 기반 위험도 분류:

- 카테고리 기본값 (Skill frontmatter의 `risk_default`)
- 변경 파일 3+개면 한 단계 상향
- 위험 키워드 감지 (prod, production, 운영, DROP TABLE, migrate, rm -rf, --force) → 위험으로 고정

위험도별 게이트:

- **단순(simple)**: 자동 진행 — 결정 근거 기록만 필수
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

> Good Boy는 모든 편집마다 근거·리뷰 게이트가 끼어드는 무거운 플러그인이다.
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

- 점유율 30%부터 +10%p마다 **컨텍스트 경고(H1-01)** 를 `systemMessage`로 띄우고, 점유율이
  **강제 임계(기본 50%, `GOODBOY_COMPACT_FORCE_PCT`)를 넘고 한도가 확정적이면 H1-03이
  턴 종료를 `decision:'block'`으로 막으며 `stopReason:'compact_needed'` 신호를 보낸다**
  (권고가 아니라 강제 — 3회 후 escape로 통과, 한도 미확정이면 보류).
- 모델/환경과 무관하게 작동한다(transcript의 input + cache_read + cache_creation 토큰을 모델
  컨텍스트 한도로 나눠 계산. 1M 모델은 자동으로 1,000,000 한도로 인식).
- **단 hook이 `/compact` 자체를 실행하지는 못한다** — 실제 압축은 사용자(또는
  `compact_needed`를 인식하는 하니스)가 수행한다.
- **긴 세션 경고(H1-01)의 토큰 임계**는 한도의 25%가 기본(200K 창=50K, 1M 창=250K —
  v0.27.8, 절대값 50K가 1M 세션을 상시 "긴 세션"으로 오판하던 문제 수정).
  `GOODBOY_TOKEN_WARN`으로 절대값 지정 가능.
- **압축 경계 인식**(v0.27.6): `/compact` 직후에는 압축 후 usage 기록이 플러시될 때까지
  압축 **전** 수치가 최신으로 읽힐 수 있다(실측: 압축 후 6%인데 53%로 재차단). 이제 경계
  마커 이전의 usage는 버리므로, 압축 직후에는 측정 불가로 강제를 보류하고 새 기록이
  플러시되는 대로 압축 후 수치로 판정한다.

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
│   ├── test-changes.md                 # 층1 — 컨테이너 기동·테스트 작성/실행·프로토타입 대조
│   └── review-changes.md               # 층2 — 축(환각/리팩토링/보안/성능/UI)별 병렬 실행
├── statusline/
│   └── statusline.ts                   # 동봉 상태바 (선택 설치)
├── lib/
│   ├── index.ts
│   ├── types.ts
│   ├── required-inputs.ts
│   ├── reasoning-parser.ts
│   ├── risk-classifier.ts
│   ├── review-validator.ts
│   ├── review-cursor.ts                # 리뷰/테스트 커서 (게이트별 분리)
│   ├── review-dimensions.ts            # 변경 → 필수 차원 + 병렬 리뷰 축 매핑
│   ├── acceptance.ts                   # dev-cycle 산출물 → 수용 기준 (층1 정답지)
│   ├── test-validator.ts               # 테스트 결과 검증 (red-green·뮤테이션·커버리지)
│   ├── claim-check.ts                  # 층0 인용 검증 (파일:줄 실재·읽음 여부)
│   ├── bash-read.ts                    # Bash로 읽은 파일 추적 (cat/head/sed -n …)
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
├── reviews/                            # review-changes 결과 JSON (축별로 여러 개)
├── tests/                              # test-changes 결과 JSON
└── (마커 파일들 — .goodboy-session-state.json, .goodboy-risk-approved.txt,
    .goodboy-retry-count.txt, .goodboy-last-review.json, .goodboy-last-test.json 등)
```

## 층1 테스트 게이트

변경된 코드가 **실제로 동작하는지**, **앞서 확정한 요구사항을 만족하는지**를 실행으로 확인한다.
리뷰보다 먼저 돈다.

### 무엇을 결정적으로 검사하나

| 검사 | 왜 |
|---|---|
| 변경 파일 커버리지 + 파일별 staleness | 편집 후 다시 테스트하지 않으면 통과 못 함 |
| 스위트 실패 0 | — |
| `test_files` 실재 | 임시 디렉터리에 만들고 지운 프로브를 테스트로 위장하는 것을 막음 |
| **red-green** | 되돌린 상태에서 **실패(exit≠0)** 했음을 보여야 함. 통과 사실만으로는 그 테스트가 무언가를 붙잡고 있다는 증거가 안 됨 |
| **뮤테이션 프로브** (`PT-*`/`UIUX-*`) | 검증 대상을 훼손하면 실패해야 함. UI 단언은 훼손해도 통과하기 쉬움 |
| 수용 기준 커버리지 | dev-cycle 산출물이 요구한 항목을 실제로 커버했는가 |
| 가짜 테스트 패턴 | `waitForTimeout`, 빈 `catch`, `toBeGreaterThanOrEqual(0)`, `it.skip` 등 |

### 정답지 — dev-cycle 산출물

`docs/CYCLE.md` 의 현재 버전에서 `docs/versions/<VER>/` 를 찾아 수용 기준을 산출한다:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts acceptance-list
```

| ID | 정답지 |
|---|---|
| `UIUX-NEW-<n>` / `UIUX-CHG-<n>` | `UIUX.md` 의 화면 목록 · 변경 화면 표 |
| `UIUX-COMP-<n>` | `UIUX.md` 의 컴포넌트 표 — 명세된 변형으로 렌더되고 동작 |
| `UIUX-STATE-<n>` | 같은 표의 `상태` 칸 — **빈 상태·에러·로딩이 실제로 표시됨** |
| `PT-STRUCT` | 프로토타입 앱 영역의 구조/클래스가 구현에 존재 |
| `PT-CTRL-<id>` | 이번 버전이 도입한 선택지가 실제로 동작 |
| `PT-REGRESSION` | `수정 전`/`적용 후` 가 같은 항목은 구현에서도 그대로 |

`UIUX-STATE-*` 는 **그 상황을 실제로 만들어서** 확인한다 — 데이터 0건, 요청 실패(`page.route` 로 503),
응답 지연. 코드에 분기가 있다는 것만으로는 충족이 아니다. 이 세 상태가 실무에서 가장 자주
누락되고, 누락되면 아무 안내 없는 빈 화면이 된다. 그래서 컴포넌트 기준 하나로 뭉치지 않고
**상태마다 따로** 기준을 만든다 — 뭉치면 "컴포넌트 만들었다"로 한 번에 커버 처리된다.

프로토타입 대조는 **픽셀 비교가 아니다.** 목업 데이터는 실제 값과 다르므로, 비교하는 것은
구조·클래스·능력·상태의 존재다. 조작 바(`pt-*`)는 앱에 없는 것이므로 대조에서 제외한다
(dev-cycle `PROTOTYPE-SPEC.md` 7절 "대조 계약").

dev-cycle을 쓰지 않는 프로젝트에서는 수용 기준이 비고, 단위/통합 + red-green + 뮤테이션만 남는다.

### 언제 켜지는가

`GOODBOY_TEST_GATE` = **`auto`(기본)** | `on` | `off`.

`auto`는 **테스트를 돌릴 수단이 있을 때만** 강제한다. 무조건 켜면 인프라가 없는 저장소에서
3회 차단 후 escape로 끝나는데, 그건 검증은 0이고 경고만 남는 결말이다(라이브 실측).

| 신호 | 예 |
|---|---|
| 테스트 디렉터리 | `tests/` `test/` `__tests__/` `spec/` `e2e/` |
| 테스트 설정 파일 | `jest.config.*` `vitest.config.*` `playwright.config.*` `pytest.ini` `tox.ini` `phpunit.xml` `.rspec` |
| 패키지 스크립트 | `package.json` 의 `scripts.test` (npm 자리표시자는 제외) |
| 파이썬 | `pyproject.toml` 에 `pytest` 언급 |
| 언어 표준 러너 | `go.mod` `Cargo.toml` |
| dev-cycle 산출물 | `docs/CYCLE.md` + `docs/versions/<VER>/` — 인프라가 없어도 켠다 |

신호가 하나도 없으면 게이트는 조용히 꺼지고, 세션당 1회 안내만 남긴다. 그래도 강제하려면
`GOODBOY_TEST_GATE=on`, 완전히 끄려면 `off`.

## 층2 리뷰 — 축별 병렬

리뷰는 축으로 나뉘어 **병렬 서브에이전트**로 돈다. 각 축은 자기 `dimensions_checked` 만 채우고,
Stop hook이 **합집합**으로 커버리지를 판정한다.

```bash
bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts review-axes <변경 파일...>   # 띄울 축을 결정적으로 산출
```

| 축 | 담당 차원 |
|---|---|
| `hallucination` | (차원 없음 — 환각·근거 4분류·가정 검증). **항상** 돈다 |
| `refactoring` | `refactoring-quality` |
| `security` | `security-secrets`, `security-injection`, `security-authz`, `dependency-risk`, `web-hardening`, `error-path`, `proto-pollution` |
| `performance` | `performance` |
| `ui` | `ui-ux-accessibility`, `plan-completeness` |

호출은 **한 메시지에서 여러 Agent 호출을 동시에** 보내야 실제로 병렬이 된다.

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

편집 전에 같은 파일을 Read 도구로 먼저 읽으세요. 새 파일 생성은 면제. 큰 파일이면 편집할
범위만 offset/limit로 부분 읽기 해도 충분합니다. 창은 기본 30턴
(`GOODBOY_READ_BEFORE_EDIT_WINDOW`) — 재-Read 게이트의 컨텍스트 수명(30턴)과 정렬되어
있어, 창 안의 편집이 불필요한 전체 재독을 강제하지 않습니다(v0.27.9).

### 같은 웹 대상 재요청 주의 (H2-04)

같은 세션에서 동일 URL WebFetch를 반복하면 사후(PostToolUse) 비차단 경고를 냅니다
(앞선 결과 참조 유도). v0.27.9부터 동일 검색어 WebSearch 반복도 잡고, 컨텍스트 압축이
감지되면 웹 기록도 함께 리셋되어(압축 후 "앞선 결과"는 컨텍스트에 없음) 거짓 경고가
없습니다. 페이지 갱신 확인 같은 정당한 재요청은 막지 않습니다.
`GOODBOY_WEBFETCH_REFETCH_WARN=off`로 비활성.

### "Edit가 차단됩니다 — 근거 게이트"

기본(`GOODBOY_REASONING_GATE=warn`)에서는 차단되지 않습니다 — 이 절은 `deny` 모드일 때의 동작입니다.
편집 전에 `## 근거` 섹션에 결정 근거를 요약하세요 (사실/판단/가정/추측 4분류).

같은 응답 안에서 근거를 쓰고 바로 편집하면 transcript 기록 지연으로 아직 인식되지 않을 수
있습니다 — 같은 편집을 다시 시도하세요. **재시도 플러시 대기**(v0.27.7): 차단 직후의 재시도인데
섹션이 아직 안 보이면 즉시 재거부하지 않고 기록이 플러시될 때까지 최대 20초
(`GOODBOY_REASONING_FLUSH_WAIT_MS`, 0=비활성) 기다린 뒤 판정합니다 — 재시도가 플러시보다
빨라 2회째도 헛 차단되던 경우가 대기로 흡수됩니다. 게이트는 두 경로로 **지연 모드**에 진입해
이후 이 세션에서 차단 없이 경고만 냅니다: (1) 3회 연속 미인식(escape), (2) **지연 확정**(v0.27.4) —
재시도에서 인식된 근거 텍스트의 생성 시각이 직전 차단보다 앞서면(= 차단이 기록 지연 오탐이었다는
직접 증거) 1회 차단 만에 즉시 전환. 헛 차단은 세션당 최대 1회로 수렴합니다(hook이 현재 턴의
텍스트를 입력받지 못해 최초 1회는 구조적으로 남음). 차단 이후 새로 출력된 근거(순응)는 전환
사유가 아니므로 지연 없는 하니스에서 게이트 강도가 유지됩니다. 지연 모드는 세션 내내 유지되며,
인식 성공 시 재무장하는 구 동작은 `GOODBOY_REASONING_LAG_STICKY=rearm`, 지연 확정만 끄려면
`GOODBOY_REASONING_LAG_CONFIRM=off`. 문서 파일(.md/.txt/.rst/.adoc 등) 편집은 기본
면제됩니다(`GOODBOY_REASONING_DOC_EXEMPT=off`로 복원). 서브에이전트가 편집할 때는
**서브에이전트 자신이 쓴** 근거 섹션으로 판정합니다(메인의 글이 아님).

### "Stop이 차단됩니다 — 리뷰 필요"

`/review-changes` 슬래시 커맨드를 실행하거나 review-changes 서브에이전트를 호출하세요:

```
Agent(general-purpose, "review-changes 스킬에 따라 다음 파일을 리뷰: <변경 파일 목록>")
```

### `.claude/reviews/*.json`이 쌓입니다

리뷰 결과 파일은 Stop 리뷰 게이트의 판정 근거로, 유효창(기본 24시간) 안의 것만 읽힙니다.
v0.27.5부터 보존 기간(기본 3일, `GOODBOY_REVIEW_RETENTION_MIN` 분 단위)이 지난 파일을
Stop마다 자동 삭제합니다(`0`으로 비활성; 유효창보다 짧게 설정해도 유효한 리뷰는 지우지
않습니다). `.claude/.goodboy-last-review.json`은 리뷰 커서(단일 파일)라 삭제하지 않습니다.
git 추적에서 빼려면 프로젝트 `.gitignore`에 추가하세요:

```
.claude/reviews/
.claude/.goodboy-*
```

### "위험 작업이 차단됩니다"

사용자 승인이 필요합니다. `touch .claude/.goodboy-risk-approved.txt`

### "Bash로 프로젝트 파일을 쓰려 합니다" 라며 차단됩니다

정상 동작입니다. `cat > src/x.ts <<EOF`, `sed -i`, `tee` 같은 Bash 쓰기는 read-before-edit·
근거 게이트를 지나치고 편집 기록에도 남지 않아 **리뷰 강제와 자동 검증까지 통째로 무력화**
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

### "Stop이 차단됩니다 — 층0 인용 검증"

답변에서 인용한 `파일:줄`이 실재하지 않거나, 그 파일을 이 세션에서 읽은 기록이 없습니다.

- **"그런 파일이 없습니다" / "N줄까지입니다"** → 확정 환각입니다. 파일을 실제로 읽어 확인하고
  인용을 정정하거나, 근거가 없으면 `## 근거 > 추측`으로 낮추세요.
- **"읽은 기록이 없습니다"** → `Read`(또는 `cat`/`sed -n`)로 실제 확인한 뒤 답하세요.

3회 차단 후에는 사용자 확인 안내와 함께 통과합니다. 끄기: `GOODBOY_CLAIM_GATE=off`

### "게이트 산출물은 편집 도구로 직접 쓸 수 없습니다"

`.claude/tests/`·`.claude/reviews/`에 Write/Edit으로 직접 파일을 만들려 한 경우입니다.
반드시 CLI를 거쳐야 합니다:

```bash
cat <<'JSON' | bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts test-write     # 또는 review-write
{ ... }
JSON
```

라이브 검증에서 에이전트가 CLI를 쓰지 않고 자기 형식으로 JSON을 써서, 게이트가 읽지 못해
"결과 없음"으로 계속 차단되고 쓰레기 파일만 쌓이는 일이 반복 관측됐습니다. CLI가 스키마를
검증하고 파일명·timestamp를 맞춥니다. 끄기: `GOODBOY_ARTIFACT_WRITE_GATE=off`

### "Stop이 차단됩니다 — 테스트 게이트"

층1 게이트입니다. 사유별로 대응이 다릅니다:

| 사유 | 대응 |
|---|---|
| "테스트가 없습니다" | `test-changes` 서브에이전트를 호출하세요 |
| "테스트되지 않은 변경 파일" | 그 파일까지 커버하도록 다시 테스트 |
| "test_files … 존재하지 않습니다" | 테스트를 `mktemp` 가 아니라 **repo 안에** 만드세요 |
| "red 증거가 성공(exit 0)" | 되돌린 상태에서 실패하는 것을 먼저 보여야 합니다 |
| "뮤테이션 프로브가 없습니다" | UI 기준은 대상을 훼손했을 때 실패하는지 확인이 필요합니다 |
| "acceptance가 비어 있습니다" | dev-cycle 기준이 없어도 무엇을 검증했는지 최소 1건은 red-green으로 적어야 합니다 |
| "수용 기준이 커버되지 않았습니다" | `acceptance-list` 로 목록을 확인하고 채우세요 |
| "아무것도 검증하지 않는 테스트 패턴" | `waitForTimeout`·빈 `catch`·항상 참인 단언을 제거하세요 |

3회 차단 후에는 사용자 확인 안내와 함께 통과합니다. 테스트 인프라가 없는 프로젝트에서는
기본값 `auto`가 게이트를 알아서 끕니다(위 "언제 켜지는가"). 항상 끄려면 `GOODBOY_TEST_GATE=off`.

### 리뷰가 "필수 차원 누락"으로 계속 차단됩니다

축을 나눠 병렬로 돌렸는데 일부 축이 실패했거나, 한 에이전트에게 여러 축을 몰아준 경우입니다.

1. `bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts review-axes <변경 파일...>` 로 필요한 축을 확인
2. 누락된 차원을 담당하는 축을 다시 호출

각 축은 **자기 차원만** `dimensions_checked` 에 적어야 합니다. Stop hook은 커서 이후의
fresh 리뷰 전부를 합집합으로 보므로, 축을 나눠 적어도 커버리지가 채워집니다.

### "Edit가 차단됩니다 — 근거 섹션이 비어 있습니다"

`deny` 모드에서 `## 근거` 제목만 출력하고 내용이 없으면 차단됩니다(기본 warn은 1회 안내만). 4분류 각각에 결론과 근거를 짧게 쓰세요
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
