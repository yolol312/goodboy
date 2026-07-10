#!/bin/sh
# goodboy hook 런처 — Bun 부재 가드 + 첫 실행 자동 설치 (POSIX sh, Bun 불필요)
#
# 사용: sh goodboy-run.sh <hook-name>
#   hook-name: pre-tool-use | post-tool-use | user-prompt-submit | stop
#
# 동작:
#   - Bun이 있으면 → 해당 hook 스크립트를 그대로 실행 (기존과 동일)
#   - Bun이 없으면:
#       user-prompt-submit → 1차: 자동 설치 동의 안내와 함께 프롬프트 반려(exit 2)
#                            2차(10분 내 재입력): 플러그인 전용 폴더에 Bun 자동 설치 후 정상 진행
#       pre-tool-use       → 도구 사용 차단(exit 2) — Bun 없이 게이트가 무력화되는 것 방지
#       post-tool-use/stop → 조용히 통과 (차단해도 사용자가 할 수 있는 조치가 없음)
#
# env:
#   GOODBOY_BUN_GUARD=off    가드 전체 끄기 (Bun 없으면 예전처럼 조용히 무동작 — 비상용)
#   GOODBOY_AUTO_INSTALL=off 자동 설치만 끄기 (차단 + 수동 설치 안내는 유지)
#   GOODBOY_RUNTIME_DIR      자동 설치 위치 (기본 $HOME/.claude/goodboy-runtime)
#   GOODBOY_INSTALL_CMD      설치 명령 override (사내 미러/테스트용; BUN_INSTALL이 export됨)

HOOK="$1"

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
ROOT=$(CDPATH= cd -- "$SELF_DIR/.." && pwd) || exit 0
HOOK_FILE="$ROOT/hooks/$HOOK.ts"

RUNTIME_DIR="${GOODBOY_RUNTIME_DIR:-$HOME/.claude/goodboy-runtime}"
MARKER="$RUNTIME_DIR/.install-consent-pending"

find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  for c in "$RUNTIME_DIR/bin/bun" "$HOME/.bun/bin/bun"; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

BUN_BIN=$(find_bun) && exec "$BUN_BIN" "$HOOK_FILE"

# ---- 여기부터는 Bun 없음 ----------------------------------------------------

[ "${GOODBOY_BUN_GUARD:-on}" = "off" ] && exit 0

case "$HOOK" in
  post-tool-use | stop)
    exit 0
    ;;
  pre-tool-use)
    echo "goodboy: Bun 런타임이 없어 안전장치를 실행할 수 없으므로 도구 사용을 차단합니다. 사용자에게 이렇게 안내하세요: \"goodboy 플러그인 실행에 Bun이 필요합니다. 프롬프트를 한 번 더 입력하면 자동 설치가 진행됩니다. (직접 설치: curl -fsSL https://bun.sh/install | bash)\"" >&2
    exit 2
    ;;
  user-prompt-submit) ;;
  *)
    exit 0
    ;;
esac

# ---- user-prompt-submit: 동의 → 자동 설치 흐름 ------------------------------

mkdir -p "$RUNTIME_DIR" 2>/dev/null

if [ "${GOODBOY_AUTO_INSTALL:-on}" = "off" ]; then
  cat >&2 <<EOF
🐶 goodboy: 이 플러그인은 Bun 런타임이 필요합니다 (미설치 감지).
직접 설치: curl -fsSL https://bun.sh/install | bash
(자동 설치는 GOODBOY_AUTO_INSTALL=off 로 꺼져 있습니다. 가드 자체를 끄려면 GOODBOY_BUN_GUARD=off)
EOF
  exit 2
fi

# 마커가 있고 10분 이내면 = 사용자가 안내를 보고 다시 입력한 것 → 설치 동의로 간주
CONSENTED=""
if [ -f "$MARKER" ]; then
  STALE=$(find "$MARKER" -mmin +10 2>/dev/null)
  [ -z "$STALE" ] && CONSENTED=yes
fi

if [ -z "$CONSENTED" ]; then
  : >"$MARKER" 2>/dev/null
  cat >&2 <<EOF
🐶 goodboy: 이 플러그인은 Bun 런타임이 필요합니다 (미설치 감지).
방금 입력한 프롬프트를 그대로 다시 입력하면 Bun을 자동 설치한 뒤 계속 진행합니다.
  - 설치 위치: $RUNTIME_DIR (플러그인 전용 폴더 — 시스템 전역을 건드리지 않습니다)
  - 직접 설치하려면: curl -fsSL https://bun.sh/install | bash
  - 자동 설치를 원치 않으면: 환경변수 GOODBOY_AUTO_INSTALL=off
EOF
  exit 2
fi

rm -f "$MARKER" 2>/dev/null
export BUN_INSTALL="$RUNTIME_DIR"
if [ -n "$GOODBOY_INSTALL_CMD" ]; then
  sh -c "$GOODBOY_INSTALL_CMD" >/dev/null 2>&1
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "🐶 goodboy: curl이 없어 Bun을 자동 설치할 수 없습니다. 직접 설치해 주세요: https://bun.sh" >&2
    exit 2
  fi
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
fi

BUN_BIN=$(find_bun) && exec "$BUN_BIN" "$HOOK_FILE"

echo "🐶 goodboy: Bun 자동 설치에 실패했습니다. 직접 설치해 주세요: curl -fsSL https://bun.sh/install | bash — 설치 후 다시 시도하면 정상 작동합니다. (가드를 끄려면 GOODBOY_BUN_GUARD=off)" >&2
exit 2
