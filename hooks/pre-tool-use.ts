#!/usr/bin/env bun
// PreToolUse hook — 도구 강제 위임, Read-before-edit, 추론 게이트, 위험도 게이트

import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  assistantEntriesAfterLastText,
  bareCatDumpMessage,
  agentTranscriptPath,
  BASH_SEARCH_MESSAGE,
  bashWriteMessage,
  catDumpThresholdBytes,
  checkRecursionGuard,
  classifyBareCatDump,
  classifyBashSearch,
  classifyBashWrite,
  ensureSessionDir,
  envInt,
  envStr,
  extractRecentAssistantTexts,
  getCurrentTurn,
  getRecentReadMtime,
  hasAssistantMessages,
  hasReasoningSection,
  logGate,
  parseReasoningSection,
  wasFileEditedRecently,
  wasFileReadRecently,
} from '../lib';

interface PreToolInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

interface HookOutput {
  continue?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

// 추론 게이트가 살펴볼 최근 assistant 메시지 개수.
// 모델이 '## 추론' 섹션을 출력한 뒤 도구 호출 직전에 다른 말(예: "이제 파일을 수정하겠습니다")을
// 한 줄 더 하더라도, 최근 N개 turn 안에 추론 섹션이 있으면 게이트를 통과시킨다.
// N을 작게 유지해 한참 전의 stale 추론 섹션이 게이트를 만족시키지 못하게 한다.
// v0.26.1: 일부 하니스의 텍스트 플러시 지연(차단→재시도 안내 텍스트가 윈도우를 밀어냄)에
//   대응해 기본값을 3 → 5로 올렸다. env GOODBOY_REASONING_WINDOW로 조정 가능.
function reasoningGateWindow(): number {
  return envInt('GOODBOY_REASONING_WINDOW', 5);
}

// 추론 게이트 escape 카운터 (v0.26.1, D 원칙 "탈출구 없는 게이트 금지"):
//   섹션 미인식 deny가 같은 세션에서 3회 누적되면 경고와 함께 통과시킨다.
//   transcript 텍스트 플러시가 지연되는 하니스에서 "한 번 더 시도하면 인식됩니다"가
//   영원히 거짓이 되는 영구 차단을 끊는 탈출구다. 인식 성공 시 리셋.
//
// v0.26.3 — sticky 지연 모드: escape 후 카운터만 리셋하면 다음 편집이 다시 1/3부터
//   차단되어, 플러시 지연이 지속되는 동안 "deny 2회 + escape 1회"가 편집마다 반복된다
//   (실측: 편집 15회 중 10회가 차단 낭비, 텍스트 반영까지 20~40초 지연).
//   escape 시 지연 모드 마커를 남기고, 섹션이 실제로 인식될 때까지 차단하지 않는다.
//   인식 성공 = 지연 해소의 증거이므로 그때 마커를 지우고 게이트를 재무장한다.
const REASONING_DENY_ESCAPE = 3;

// v0.26.4 — 상태 파일을 에이전트 스코프로 분리(리뷰 지적): sessionId만으로 키잉하면
//   서브에이전트의 지연 모드가 메인 게이트까지 무장해제하고, 메인의 섹션 인식이
//   서브의 지연 모드를 해제해 차단 사이클이 혼합(메인+서브) 세션에서 재발한다.
//   게이트 판정(transcript 선택)과 동일하게 agent_id ?? 'main'으로 스코핑한다
//   (재-Read 게이트의 rereadScope 선례).
function scopedStateFile(base: string, scope: string): string {
  const safe = (scope || 'main').replace(/[^\w-]/g, '_');
  return `${base}.${safe}.txt`;
}

function isReasoningLagMode(sessionId: string, scope: string): boolean {
  try {
    return existsSync(join(ensureSessionDir(sessionId), scopedStateFile('reasoning-lag-mode', scope)));
  } catch {
    return false;
  }
}

function setReasoningLagMode(sessionId: string, scope: string): void {
  try {
    writeFileSync(
      join(ensureSessionDir(sessionId), scopedStateFile('reasoning-lag-mode', scope)),
      '1',
      'utf8',
    );
  } catch {
    // best-effort
  }
}

function clearReasoningLagMode(sessionId: string, scope: string): void {
  try {
    const p = join(ensureSessionDir(sessionId), scopedStateFile('reasoning-lag-mode', scope));
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best-effort
  }
}

function readReasoningDenyCount(sessionId: string, scope: string): number {
  try {
    const p = join(ensureSessionDir(sessionId), scopedStateFile('reasoning-deny-count', scope));
    if (!existsSync(p)) return 0;
    const n = parseInt(readFileSync(p, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeReasoningDenyCount(sessionId: string, scope: string, n: number): void {
  try {
    writeFileSync(
      join(ensureSessionDir(sessionId), scopedStateFile('reasoning-deny-count', scope)),
      String(n),
      'utf8',
    );
  } catch {
    // best-effort — 카운터 기록 실패가 게이트 동작을 막지 않는다.
  }
}

function resetReasoningDenyCount(sessionId: string, scope: string): void {
  try {
    if (readReasoningDenyCount(sessionId, scope) > 0) writeReasoningDenyCount(sessionId, scope, 0);
  } catch {
    // best-effort
  }
}

// 도구 강제 위임 대상 — 이 도구들은 메인이 직접 쓰지 않고 서브에이전트에게 위임한다.
const DELEGATED_TOOLS = new Set(['WebSearch', 'WebFetch', 'Grep', 'Glob']);

// 위험도 게이트(2-B) 대상 — 변경(부작용) 도구에만 위험 게이트를 적용한다.
//   read-only/조회 도구(Read/Grep/Glob 등)는 통과시켜, 커밋된 risky state로 인한 전체 차단 DoS를 막는다.
const RISK_GATED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function emit(out: HookOutput): void {
  try {
    process.stdout.write(JSON.stringify(out));
  } catch {
    // best-effort
  }
}

function deny(reason: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** 통과(비차단) 출력. 경고가 있으면 함께 실어 보낸다.
 *  additionalContext = 에이전트(서브에이전트 포함) 컨텍스트에 확실히 주입되는 채널.
 *  permissionDecision은 설정하지 않아 정상 권한 흐름을 유지한다. systemMessage는 사용자 UI용. */
function emitPass(warnings: string[]): void {
  if (warnings.length === 0) {
    emit({});
    return;
  }
  const joined = warnings.join('\n');
  emit({
    systemMessage: joined,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: joined,
    },
  });
}

// assistantTextFromLine / extractRecentAssistantTexts는 lib/transcript-parser.ts로
// 승격되었다(Stop hook의 추측-리뷰 연동 A2도 사용). 여기서는 import해서 쓴다.

interface SessionState {
  category?: string;
  risk?: string;
  turn?: number;
  /** 2-B: 이 state를 기록한 세션 ID. 현재 세션과 다르면(다른 세션/리포에 커밋된 잔재) 무시한다. */
  sessionId?: string;
}

function readSessionState(cwd: string): SessionState | null {
  try {
    const path = resolvePath(cwd, '.claude', '.goodboy-session-state.json');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

function main(): void {
  let input: PreToolInput = {};
  readStdin()
    .then((raw) => {
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as PreToolInput);
      } catch (err) {
        process.stderr.write(`[goodboy pre-tool-use] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? 'unknown';
      const toolName = input.tool_name ?? '';
      const toolInput = input.tool_input ?? {};

      // 비차단 사전 경고 누적기(현재 H2-01 warn 모드 전용). deny가 아닌 allow 경로에서
      //   hookSpecificOutput.additionalContext로 최종 emit에 실어 보낸다.
      //   ⚠️ systemMessage는 사용자 UI에만 노출되고 도구를 호출한 (서브)에이전트 컨텍스트에는
      //   주입되지 않는다. additionalContext는 에이전트에 확실히 도달하는 채널이다.
      //   호환/가시성을 위해 systemMessage도 함께 실어 준다. 위험도 게이트(D) deny가 나면 드롭된다.
      //   NOTE: H2-02(Bash 대량출력)는 사전 경고로는 에이전트에 닿지 않아(PreToolUse additionalContext
      //   미주입) PostToolUse 사후 경고로 이동함. 여기서는 더 이상 다루지 않는다.
      const preWarnings: string[] = [];

      // (A0) 재귀 폭주 방어 — Agent/Task 호출에 한해, 60초 슬라이딩 윈도우로
      //   총 호출 상한/동일 프롬프트 반복을 검사한다. agent_type 존재 여부와
      //   무관하게 적용한다(서브에이전트가 또 서브에이전트를 부르는 폭주를 막기 위함).
      //   내부 오류는 삼키고 통과(fail-open)하므로 정상 작업을 막지 않는다.
      if (toolName === 'Agent' || toolName === 'Task') {
        const promptText =
          typeof toolInput.prompt === 'string'
            ? (toolInput.prompt as string)
            : JSON.stringify(toolInput);
        const guard = checkRecursionGuard(sessionId, promptText);
        if (guard.blocked && guard.reason) {
          logGate(sessionId, 'recursion-guard', 'deny', guard.reason);
          emit(deny(guard.reason));
          return;
        }
      }

      // (A0.5) 위임 재독 주의 (비차단) — 메인이 최근 읽은 파일 경로가 위임 프롬프트에
      //   들어 있으면, 서브에이전트가 같은 파일을 다시 읽게 될 가능성이 높다.
      //   서브의 재독은 필요비용일 수 있어(서브 컨텍스트엔 그 내용이 없다) 차단하지 않고,
      //   "직접 처리할 수 있는 작업인지 / 필요한 부분만 프롬프트에 담을 수 있는지"의
      //   판단을 유도하는 주의만 준다. env GOODBOY_DELEGATED_REREAD_WARN=on|off (기본 on).
      if (
        (toolName === 'Agent' || toolName === 'Task') &&
        !input.agent_type &&
        envStr('GOODBOY_DELEGATED_REREAD_WARN', 'on') !== 'off'
      ) {
        try {
          const promptText = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
          // 경로처럼 생긴 토큰(슬래시 + 확장자)만 후보로 본다. URL 등 오매칭은
          //   read 기록 대조에서 걸러진다(기록에 없으면 무시).
          const candidates = promptText.match(/[\w.~-]*\/[\w./-]+\.\w{1,8}/g) ?? [];
          if (candidates.length > 0) {
            const turn = getCurrentTurn(sessionId);
            const withinTurns = envInt('GOODBOY_REREAD_WINDOW', 30);
            const hits: string[] = [];
            for (const c of new Set(candidates)) {
              const abs = resolvePath(cwd, c);
              if (wasFileReadRecently(sessionId, abs, turn, withinTurns, 'main')) {
                hits.push(c);
                if (hits.length >= 3) break;
              }
            }
            if (hits.length > 0) {
              preWarnings.push(
                `위임 프롬프트에 메인이 이미 읽은 파일이 포함되어 있습니다: ${hits.join(', ')}. ` +
                  '서브에이전트는 그 내용을 모르므로 다시 읽게 됩니다 — 직접 처리할 수 있는 작업인지, ' +
                  '필요한 부분만 프롬프트에 담아 전달할 수 있는지 먼저 판단하세요. (위임 재독 주의, H2-01)',
              );
            }
          }
        } catch {
          // fail-open — 주의 계산 실패는 위임을 막지 않는다.
        }
      }

      // (A) 도구 강제 위임. 서브에이전트(agent_type 존재)면 면제.
      //   GOODBOY_DISABLE_DELEGATION=1 이면 위임 자체를 끈다.
      if (!input.agent_type && process.env.GOODBOY_DISABLE_DELEGATION !== '1') {
        if (DELEGATED_TOOLS.has(toolName)) {
          logGate(sessionId, 'delegation', 'deny', toolName);
          emit(
            deny(
              "이 도구는 서브에이전트에게 위임하세요. Agent 도구로 'general-purpose' 등 적합한 서브에이전트를 호출하세요.",
            ),
          );
          return;
        }
      }

      // (A1) H2-03 — Bash 재귀 코드베이스 탐색 강제 위임. 서브에이전트(agent_type)는 면제.
      //   위임 게이트(A)는 Grep/Glob만 막아 Bash의 grep -r/rg/find로 우회된다. 이를 막는다.
      //   env GOODBOY_BASH_SEARCH_GATE=deny|warn|off (기본 deny).
      //   ⚠️ warn은 PreToolUse additionalContext가 에이전트에 닿지 않아 효과가 약하다(사용자 UI만).
      //   확실히 유도하려면 deny를 쓴다(deny의 permissionDecisionReason은 에이전트에 도달).
      if (!input.agent_type && toolName === 'Bash') {
        const gate = envStr('GOODBOY_BASH_SEARCH_GATE', 'deny'); // deny | warn | off
        if (gate !== 'off') {
          const command =
            typeof toolInput.command === 'string' ? (toolInput.command as string) : '';
          const hit = classifyBashSearch(command);
          if (hit) {
            const msg = `${BASH_SEARCH_MESSAGE} (감지: ${hit})`;
            if (gate === 'warn') {
              logGate(sessionId, 'bash-search', 'warn', hit);
              preWarnings.push(msg);
            } else {
              logGate(sessionId, 'bash-search', 'deny', hit);
              emit(deny(msg));
              return;
            }
          }
        }
      }

      // (A1.5) H2-02 사전 차단 — 후처리 없는 bare cat 대용량 통짜 출력.
      //   실행 전에 출력 크기를 알 수 있는 유일한 케이스(파일 인자 cat)만 statSync로 판정.
      //   파이프/리다이렉트가 붙은 정당한 사용(cat big | head)은 lib에서 전부 통과시킨다.
      //   서브에이전트에도 적용 — 통짜 출력은 어느 컨텍스트에서든 낭비다.
      //   env GOODBOY_CAT_GATE=deny|warn|off (기본 deny), 임계 GOODBOY_CAT_DENY_BYTES.
      if (toolName === 'Bash') {
        const gate = envStr('GOODBOY_CAT_GATE', 'deny');
        if (gate !== 'off') {
          const command =
            typeof toolInput.command === 'string' ? (toolInput.command as string) : '';
          const hit = classifyBareCatDump(command, cwd, catDumpThresholdBytes());
          if (hit) {
            const msg = bareCatDumpMessage(hit.bytes);
            if (gate === 'warn') {
              logGate(sessionId, 'cat-dump', 'warn', `${hit.bytes}B`);
              preWarnings.push(msg);
            } else {
              logGate(sessionId, 'cat-dump', 'deny', `${hit.bytes}B`);
              emit(deny(msg));
              return;
            }
          }
        }
      }

      // (A1.7) Bash 파일 쓰기 게이트 — 편집 게이트 우회 차단.
      //   라이브 검증 실측: 추론 게이트에 8회 막힌 서브에이전트가 `cat > src/x.ts <<EOF`로
      //   소스를 덮어썼다. Bash 쓰기는 read-before-edit·추론 게이트를 지나치고 PostToolUse의
      //   편집 기록에도 남지 않아 리뷰 강제·자동 검증까지 통째로 무력화한다.
      //   메인/서브에이전트 모두에 적용. env GOODBOY_BASH_WRITE_GATE=deny|warn|off (기본 deny).
      if (toolName === 'Bash') {
        const gate = envStr('GOODBOY_BASH_WRITE_GATE', 'deny');
        if (gate !== 'off') {
          const command =
            typeof toolInput.command === 'string' ? (toolInput.command as string) : '';
          const writes = classifyBashWrite(command, cwd);
          if (writes.length > 0) {
            const msg = bashWriteMessage(writes);
            if (gate === 'warn') {
              logGate(sessionId, 'bash-write', 'warn', `${writes.length}개`);
              preWarnings.push(msg);
            } else {
              logGate(sessionId, 'bash-write', 'deny', `${writes.length}개`);
              emit(deny(msg));
              return;
            }
          }
        }
      }

      // (A2) H2-01 — 같은 파일 재-Read 게이트.
      //   최근 N턴 내 같은 파일을, 그 사이 mtime 변경도 편집도 없이 다시 Read하면 불필요한 재-Read로 본다.
      //   오탐 방지 예외(허용): 부분읽기(offset/limit), mtime 변경됨, 마지막 read 이후 편집됨.
      //   모든 판정은 fail-open(내부 오류/불확실 → 허용). env GOODBOY_REREAD_GATE=deny|warn|off (기본 deny).
      //   D2(스코프 개정): read 기록에 agent_id를 태깅하므로 서브에이전트도 "자기 기록" 기준으로
      //   공정하게 게이트한다(전면 면제 해제). 단 agent_type만 있고 agent_id가 없으면(식별 불가)
      //   기존 면제를 유지한다 — 동일 타입 서브 간 교차 오차단(남이 읽은 기록으로 내가 차단) 방지.
      const rereadScope: string | null = input.agent_id
        ? input.agent_id
        : input.agent_type
          ? null // 식별 불가 서브에이전트 → 면제
          : 'main';
      if (toolName === 'Read' && rereadScope !== null) {
        const gate = envStr('GOODBOY_REREAD_GATE', 'deny'); // deny | warn | off
        const filePath = (toolInput.file_path as string | undefined) ?? '';
        // 부분 읽기(offset/limit)는 정당한 재-Read → 예외.
        const isPartial = toolInput.offset !== undefined || toolInput.limit !== undefined;
        if (gate !== 'off' && filePath && !isPartial) {
          const rereadMsg =
            '이미 최근에 읽었고 파일이 안 바뀌었습니다. 앞서 읽은 내용을 참조하세요. (재-Read 방지, H2-01)';
          const blockReread = (() => {
            try {
              const absPath = resolvePath(cwd, filePath);
              const turn = getCurrentTurn(sessionId);
              // 윈도우 기본 30턴(D2 개정): "읽은 내용이 아직 컨텍스트에 살아있는가"의 근사치.
              //   mtime 비교가 파일 변경 오탐을 막고, 압축(/compact) 감지 시 Stop hook이
              //   read 기록을 리셋(epoch)하므로 길게 잡아도 압축 직후 오차단이 없다.
              //   더 엄격하게(사실상 무제한) 하려면 env로 크게 설정한다.
              const withinTurns = envInt('GOODBOY_REREAD_WINDOW', 30);
              // 최근에 읽지 않았으면 통과.
              if (!wasFileReadRecently(sessionId, absPath, turn, withinTurns, rereadScope))
                return false;
              // 마지막 read 이후 편집됐으면 통과(내용이 바뀌었을 수 있음).
              if (wasFileEditedRecently(sessionId, absPath, turn, withinTurns, rereadScope))
                return false;
              // 이전 read 시점 mtime을 모르면 비교 불가 → 통과(fail-open).
              const prevMtime = getRecentReadMtime(sessionId, absPath, turn, withinTurns, rereadScope);
              if (prevMtime === null) return false;
              // 현재 mtime을 못 구하면 통과(fail-open).
              let curMtime: number | null = null;
              try {
                curMtime = statSync(absPath).mtimeMs;
              } catch {
                curMtime = null;
              }
              if (curMtime === null) return false;
              // mtime이 바뀌었으면 파일 변경 → 통과.
              if (curMtime !== prevMtime) return false;
              // 여기까지 오면 불필요한 재-Read.
              return true;
            } catch {
              return false; // 내부 오류는 통과(fail-open)
            }
          })();
          if (blockReread) {
            if (gate === 'warn') {
              // warn 모드: deny 대신 allow + systemMessage.
              logGate(sessionId, 'reread', 'warn', filePath);
              preWarnings.push(rereadMsg);
            } else {
              logGate(sessionId, 'reread', 'deny', filePath);
              emit(deny(rereadMsg));
              return;
            }
          }
        }
      }

      // (B) Read-before-edit
      const isEditTool = toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit';
      if (isEditTool) {
        const filePath = (toolInput.file_path as string | undefined) ?? '';
        if (filePath) {
          const absPath = resolvePath(cwd, filePath);
          const fileExists = (() => {
            try {
              return existsSync(absPath);
            } catch {
              return false;
            }
          })();
          // Write로 새 파일 생성은 예외
          const isNewFileViaWrite = toolName === 'Write' && !fileExists;
          if (!isNewFileViaWrite && fileExists) {
            const turn = getCurrentTurn(sessionId);
            // FRICTION #4: 세션 내에서 직접 Read 했거나, 직접 Write/Edit 한 파일이면
            // 이미 내용을 알고 있으므로 read-before-edit를 만족한 것으로 본다.
            const ok =
              wasFileReadRecently(sessionId, absPath, turn, 20) ||
              wasFileEditedRecently(sessionId, absPath, turn, 20);
            if (!ok) {
              logGate(sessionId, 'read-before-edit', 'deny', absPath);
              emit(
                deny(
                  `이 파일을 먼저 Read 도구로 읽은 후 편집하세요: ${absPath}. (Read-before-edit 정책)`,
                ),
              );
              return;
            }
          }
        }
      }

      // (C) 추론 게이트
      // 마지막 메시지 하나만 보면, 모델이 추론 섹션을 출력한 뒤 도구 호출 직전에
      // 다른 말("이제 파일을 수정하겠습니다")을 한 줄 더 하면 잘못 차단된다.
      // → 최근 N개 turn 중 ANY가 추론 섹션을 담고 있으면 통과시킨다.
      if (isEditTool) {
        // 서브에이전트의 편집은 "서브에이전트가 쓴 글"로 판정해야 한다.
        //   hook은 서브에이전트 호출에도 메인 transcript_path를 넘긴다 → 그대로 쓰면
        //   서브가 ## 추론을 아무리 써도 메인의 글만 검사되어 영구 차단된다(실측: 9회 출력, 8회 차단).
        //   전용 transcript를 못 찾으면 판정 불가 → fail-open(게이트 건너뜀).
        const mainTranscript = input.transcript_path ?? '';
        let reasoningTranscript: string | null = mainTranscript;
        if (input.agent_id) {
          reasoningTranscript = agentTranscriptPath(mainTranscript, input.agent_id);
          if (reasoningTranscript === null) {
            logGate(sessionId, 'reasoning', 'fail-open', 'subagent-transcript-not-found');
          }
        }
        if (reasoningTranscript === null) {
          // 서브에이전트 전용 기록을 찾지 못함 → 이 편집은 게이트하지 않는다.
          emitPass(preWarnings);
          return;
        }
        // (C-lag) 텍스트 플러시 지연 감지 (fail-open, v0.26.1) — 일부 하니스는 assistant
        //   텍스트 블록의 transcript 기록이 수십 초~수 분 지연된다(thinking/tool_use는 즉시 기록).
        //   그 상태에서는 모델이 '## 추론'을 아무리 출력해도 게이트가 옛 텍스트만 보게 되어
        //   deny 메시지("한 번 더 시도하면 인식됩니다")가 거짓이 되는 영구 차단이 된다(실측).
        //   마지막 텍스트 엔트리 이후 assistant 엔트리가 임계 이상 쌓였으면 "플러시 지연 중"으로
        //   보고 이 게이트 블록만 건너뛴다(조기 return 없음 — 이후 위험도 게이트(D)는 유지).
        const lagThreshold = envInt('GOODBOY_REASONING_LAG_ENTRIES', 8);
        const lagEntries = assistantEntriesAfterLastText(reasoningTranscript);
        if (lagEntries >= lagThreshold) {
          logGate(sessionId, 'reasoning', 'fail-open', `text-flush-lag(${lagEntries})`);
        } else {
        const recentTexts = extractRecentAssistantTexts(reasoningTranscript, reasoningGateWindow());
        // (C-escape v0.26.3) 섹션 미인식 처리 공용 경로 — 무언 편집/미인식 deny 모두
        //   같은 카운터를 쓴다. 지연 모드면 차단하지 않고 경고만, 아니면 3회까지 deny 후
        //   지연 모드로 전환한다. true를 반환하면 이번 편집을 통과시킨다는 뜻.
        // 상태 스코프는 판정 대상 transcript와 동일 기준(agent_id ?? 'main')으로 잡는다.
        const reasoningScope = input.agent_id ?? 'main';
        const lagModeWarning =
          '추론 게이트 지연 모드: transcript 기록 지연으로 섹션을 인식할 수 없어 차단하지 않습니다. ' +
          '## 추론 섹션을 계속 출력해 주세요 — 인식되는 즉시 게이트가 정상 복원됩니다.';
        const passUnrecognized = (denyReason: string, denyMessage: (n: number) => string): boolean => {
          if (isReasoningLagMode(sessionId, reasoningScope)) {
            logGate(sessionId, 'reasoning', 'warn', 'lag-mode');
            preWarnings.push(lagModeWarning);
            return true;
          }
          const denyCount = readReasoningDenyCount(sessionId, reasoningScope) + 1;
          if (denyCount >= REASONING_DENY_ESCAPE) {
            // 카운터 리셋 후 재무장하면 지연이 지속되는 동안 편집마다 deny 2회가
            //   반복된다(실측) — sticky 지연 모드로 전환하고 인식 성공 시 재무장한다.
            setReasoningLagMode(sessionId, reasoningScope);
            writeReasoningDenyCount(sessionId, reasoningScope, 0);
            logGate(sessionId, 'reasoning', 'warn', 'escape');
            preWarnings.push(
              '추론 게이트가 3회 차단 후에도 섹션을 인식하지 못했습니다. transcript 기록 지연으로 보고 ' +
                '지연 모드로 전환합니다 — 섹션이 인식될 때까지 편집을 차단하지 않습니다. ## 추론 섹션을 계속 출력해 주세요.',
            );
            return true;
          }
          writeReasoningDenyCount(sessionId, reasoningScope, denyCount);
          logGate(sessionId, 'reasoning', 'deny', denyReason);
          emit(deny(denyMessage(denyCount)));
          return false;
        };
        // recentTexts가 비면 두 경우를 구별한다(라이브 검증 발견 — 무언 편집 우회):
        //   (a) assistant 메시지 자체가 파싱됨(thinking/tool_use만 존재) → 모델이 아무 텍스트
        //       없이 편집하려는 것. 추론 섹션이 없음이 확정이므로 차단한다.
        //   (b) assistant 메시지를 하나도 못 찾음 → 파싱 실패/포맷 변경 가능성 → fail-open.
        if (recentTexts.length === 0) {
          if (hasAssistantMessages(reasoningTranscript)) {
            const passed = passUnrecognized(
              'silent-edit',
              (n) =>
                "편집 전에 '## 추론' 섹션을 텍스트로 출력하세요. 4분류로: ### 사실 / ### 추론 / ### 가정 / ### 추측 ⚠️ . " +
                '출력했는데도 이 메시지가 보이면 기록 반영이 지연된 것입니다 — 같은 도구 호출을 다시 시도하세요. ' +
                `(추론 가시화 정책 — 무언 편집 불허, 재시도 ${n}/${REASONING_DENY_ESCAPE}, 3회 후 지연 모드로 통과)`,
            );
            if (!passed) return;
          } else if (reasoningTranscript !== '') {
            // E1: transcript가 주어졌는데 assistant 메시지를 하나도 못 찾았으면 무력화 신호.
            logGate(sessionId, 'reasoning', 'fail-open', 'transcript-unparsed');
          }
        } else {
          const hasReasoning = recentTexts.some((t) => hasReasoningSection(t));
          if (!hasReasoning) {
            const passed = passUnrecognized(
              'no-section',
              (n) =>
                "편집 전에 '## 추론' 섹션을 출력하세요. 4분류로: ### 사실 / ### 추론 / ### 가정 / ### 추측 ⚠️ . " +
                '주의: 방금 출력한 텍스트는 기록 반영이 지연되어 아직 인식되지 않을 수 있습니다 — 이미 출력했다면 같은 도구 호출을 그대로 다시 시도하세요. ' +
                `(추론 가시화 정책, 재시도 ${n}/${REASONING_DENY_ESCAPE}, 3회 후 지연 모드로 통과)`,
            );
            if (!passed) return;
          } else {
            // 섹션 인식 성공 = 기록 지연 해소의 증거 → escape 카운터 리셋 + 지연 모드 해제(재무장).
            resetReasoningDenyCount(sessionId, reasoningScope);
            clearReasoningLagMode(sessionId, reasoningScope);
          }
          // (A1) 실질 검사: 제목만 찍고 내용이 텅 빈 '시늉 추론'은 통과 불가.
          //   윈도우 내 추론 섹션 중 하나라도 4분류에 실제 항목이 있으면 통과.
          //   파싱이 전부 실패(null)하면 헤딩 존재만으로 통과(fail-open 유지).
          const parsed = recentTexts
            .filter((t) => hasReasoningSection(t))
            .map((t) => parseReasoningSection(t))
            .filter((s): s is NonNullable<typeof s> => s !== null);
          if (parsed.length > 0) {
            const hasContent = parsed.some(
              (s) =>
                s.facts.length + s.inferences.length + s.assumptions.length + s.speculations.length >
                0,
            );
            if (!hasContent) {
              logGate(sessionId, 'reasoning', 'deny', 'empty-section');
              emit(
                deny(
                  "'## 추론' 섹션이 비어 있습니다. 4분류(### 사실 / ### 추론 / ### 가정 / ### 추측 ⚠️)에 " +
                    "실제 내용을 작성하세요. 해당 없는 분류는 '- 없음'으로 명시합니다. (추론 실질화, A1)",
                ),
              );
              return;
            }
          }
        }
        } // (C-lag) else 끝 — 플러시 지연이면 위 추론 게이트 블록 전체를 건너뛴다(위험도 게이트(D)는 계속 적용).
      }

      // (D) 위험도 게이트 — 변경 도구에만, 그리고 현재 세션에서 기록된 state에만 적용(2-B).
      //   ⚠️ 위험 게이트가 read-only 도구까지 막으면, 리포에 커밋된/오래된 risky state 하나로
      //   클론 시 모든 도구가 차단되는 DoS가 된다. 그래서:
      //     - 변경 도구(Edit/Write/MultiEdit/Bash)에만 건다(탐색/조회는 통과).
      //     - state.sessionId가 현재 세션과 일치할 때만 신뢰한다(다른 세션/커밋된 잔재는 무시).
      //       정상 흐름은 user-prompt-submit이 같은 세션에 state를 쓰므로 항상 일치한다.
      if (RISK_GATED_TOOLS.has(toolName)) {
        const state = readSessionState(cwd);
        if (state && state.risk === 'risky' && state.sessionId === sessionId) {
          const approvedPath = resolvePath(cwd, '.claude', '.goodboy-risk-approved.txt');
          if (!existsSync(approvedPath)) {
            logGate(sessionId, 'risk', 'deny', state.category ?? 'unknown');
            emit(
              deny(
                `이 작업은 위험도가 '위험'으로 분류되었습니다(${state.category ?? '미상'}). 사용자에게 진행 승인을 받은 후, .claude/.goodboy-risk-approved.txt 파일을 만들고 다시 시도하세요.`,
              ),
            );
            return;
          }
        }
      }

      emitPass(preWarnings);
    })
    .catch((err) => {
      process.stderr.write(`[goodboy pre-tool-use] fatal: ${String(err)}\n`);
      emit({});
    });
}

main();
