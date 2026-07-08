---
name: setup-statusline
description: "Good Boy 동봉 상태바 설치/연동. 컨텍스트 %(게이트와 동일 계산), 작업 위험도, 리뷰 대기, 검증 실패, 게이트 발동 수를 상태바에 표시한다. 기존 상태바가 있으면 덮어쓰지 않고 status.json 연동 가이드를 안내."
---

# Good Boy 상태바 설치

이 스킬은 Good Boy 동봉 상태바를 사용자 설정에 등록하거나, 기존 상태바에 Good Boy 상태를 통합하는 방법을 안내합니다.

## 반드시 지킬 것

- **설정 변경 전에 사용자 승인을 받는다.** settings.json은 사용자 소유 파일이다.
- **기존 statusLine 설정이 있으면 절대 덮어쓰지 않는다.** 상태바 자리는 하나뿐이므로, 기존 것을 지우는 대신 아래 "기존 상태바 연동"을 안내한다.

## 절차

### 1단계: 현재 상태 확인

`~/.claude/settings.json`을 Read하고 `statusLine` 키 유무를 확인한다.

### 2단계-A: statusLine이 없는 경우 (신규 설치)

사용자에게 설치 여부를 확인한 후, settings.json에 추가한다:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun <플러그인루트>/statusline/statusline.ts"
  }
}
```

`<플러그인루트>`는 이 스킬 파일이 위치한 플러그인의 루트 절대경로로 치환한다
(이 SKILL.md의 상위 상위 디렉터리). `CLAUDE_PLUGIN_ROOT` 환경변수가 있으면 그 값을 쓴다.
settings.json의 다른 키는 건드리지 않는다.

### 2단계-B: statusLine이 이미 있는 경우 (기존 상태바 연동)

덮어쓰지 말고 사용자에게 두 가지 선택지를 제시한다:

1. **연동(권장)**: 기존 상태바 스크립트가 Good Boy 상태 파일을 읽어 한 칸 추가.
   - 상태 파일 경로: `$TMPDIR/goodboy-session-<session_id>/status.json`
     (session_id는 상태바 stdin JSON의 `session_id` 필드. `<session_id>`의 영숫자/`-`/`_` 외 문자는 `_`로 치환됨)
   - JSON 필드: `context.percent`(게이트 기준 컨텍스트 %), `context.confident`(false면 한도 미확정 = 강제 보류 상태),
     `category`, `risk`(simple|medium|risky), `validationFailed`, `reviewPending`, `gateDenies`, `updatedAt`
   - 파일이 없거나 오래됐으면(스탬프 확인) 해당 칸을 생략하도록 안내.
2. **교체**: 사용자가 원하면 기존 command를 백업으로 주석 남기고 2단계-A로 교체.

### 3단계: 확인

사용자에게 새 세션을 열거나 상태바가 갱신될 때 `🐶` 프리픽스가 보이는지 확인하도록 안내한다.

## 표시 형식

```
🐶 🧠 16% | 🟡fix-bug | 📋 리뷰대기 | 🚧 3
```

- `🧠 N%` — 컨텍스트 점유율. **강제 compact 게이트가 쓰는 것과 동일한 계산값**.
  `N%?`처럼 물음표가 붙으면 모델 한도 미확정(강제 보류 중) — `GOODBOY_CONTEXT_LIMIT` 설정을 안내할 것.
- `🟢/🟡/🔴<카테고리>` — 현재 작업 카테고리와 위험도.
- `🔧 검증실패` — 자동 검증 실패 마커가 살아 있음(턴 종료 차단 중).
- `📋 리뷰대기` — 리뷰되지 않은 편집이 있음.
- `🚧 N` — 이번 세션 게이트 deny 누계.
