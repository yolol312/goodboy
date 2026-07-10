---
name: verify
description: "goodboy 플러그인 변경분의 라이브 검증 레시피 — 실제 Claude Code headless 세션에 플러그인을 장착해 게이트 유도 행동을 관찰한다. 단위테스트(bun test)는 hook 로직 검증일 뿐, 모델이 유도대로 움직이는지는 이 방법으로만 확인된다."
---

# goodboy 라이브 검증

## 핵심 명령

```bash
SCRATCH=<격리 디렉토리>; mkdir -p $SCRATCH/proj $SCRATCH/tmp; cd $SCRATCH/proj; git init -q .
env TMPDIR=$SCRATCH/tmp claude -p "<프롬프트>" \
  --plugin-dir /Users/seongmo/workspace/goodboy \
  --model haiku --dangerously-skip-permissions > out.txt 2>&1
```

- `TMPDIR`를 격리하면 게이트 로그/상태가 `$SCRATCH/tmp/goodboy-session-*/`에 모인다.
- `--model haiku`: 빠르고 저렴. 넛지류(B2 등)의 순응 검증은 sonnet 이상으로 별도 확인
  (haiku는 지시 무시 관측됨, sonnet은 순응 관측됨).
- 권한: 리뷰 루프 검증에는 `--dangerously-skip-permissions` 필요(리뷰 서브에이전트가
  Bash로 review-write CLI를 씀). `acceptEdits`로는 Bash 거부 → 리뷰 파일 저장 실패 → 루프가
  사용자 질문으로 종료됨(무한루프는 안 됨).

## 관찰 지점 (증거)

1. `$SCRATCH/tmp/goodboy-session-*/gate-log.jsonl` — 게이트 발동/판단불가 사실 기록
2. `$SCRATCH/tmp/goodboy-session-*/status.json` — 한도/percent/confident (한도 판별 검증)
3. `$SCRATCH/proj/.claude/reviews/*.json` — 리뷰 루프 수렴 여부
4. transcript: `~/.claude/projects/<경로 인코딩된 proj dir>/*.jsonl` —
   모델의 실제 출력(## 추론 존재, AskUserQuestion 호출 등). `grep -c "## 추론"` 등으로 확인.

## 검증된 프로브 시나리오

- 재-Read: "README.md를 읽고, 곧바로 한 번 더 읽어라. 무슨 일이 있었는지 보고하라"
  → gate-log에 reread deny + 모델이 차단을 보고하고 재시도 안 함.
- bash-search 우회 시도(실측): 차단당한 모델이 `GOODBOY_BASH_SEARCH_GATE=off grep -r ...`로
  env를 인라인 지정해 게이트를 끄려 시도한다. **통하지 않는다** — hook은 별도 프로세스로
  spawn되어 Bash 명령의 인라인 env를 상속하지 않는다(재차 deny 기록됨). 그 후 모델은
  Agent 위임으로 전환 → 게이트 의도대로 수렴. (단, `.claude/settings.json`의 env를 편집하는
  경로는 여전히 열려 있다 — 사용자 권한이므로 의도된 동작이나, 모델이 스스로 끌 수 있음.)
- 리뷰 루프: "hello.txt 만들어라. 작업을 완전히 끝내라" (skip-permissions)
  → review deny(no-review-file) → 리뷰 JSON 생성 → 종료.
- B2 질문 유도: 빈약한 프롬프트 "버그 고쳐줘" → sonnet은 AskUserQuestion 호출(단,
  -p 모드에선 응답 불가로 오래 걸림 — 타임아웃 짧게 잡지 말 것), haiku는 무시하고 진행.

## 함정 (실측)

- **PreToolUse 시점에는 진행 중인 assistant 메시지가 transcript에 아직 없다** —
  추론 게이트는 이전(완료된) 메시지들만 본다. 세션 최초 편집은 fail-open이 정상.
- **Stop 시점에도 마지막 assistant 메시지는 아직 flush 전** — 도구 호출이 하나도 없는
  1턴짜리 프로브는 usage 측정이 `usage-parse-failed`로 나온다(정상). 컨텍스트/compact
  검증은 Read 등 도구를 한 번 이상 쓰는 프롬프트로 해야 한다.
- **가짜 HOME으로 bun 부재를 흉내내지 말 것** — `HOME=<fake> CLAUDE_CONFIG_DIR=~/.claude`
  조합은 claude가 실제 `~/.claude/.claude.json`을 초기화(백업 후 리셋)하는 부작용이 있었다
  (2026-07-10 실측, backups/ 최신본으로 복구함). bun 가드는 unit test(PATH+HOME 격리)로
  검증하고, 라이브는 PATH 격리(→ ~/.bun 폴백 확인)까지만.
- 사용자 `~/.claude/settings.json`의 model이 판별에 새어들 수 있으니(2-D로 방어됨)
  한도 검증 시 status.json의 limit을 반드시 확인할 것.
- `-p` 세션은 haiku 기준 1~3분, 리뷰 루프 포함 시 최대 5분+. 타임아웃 600s 권장.
