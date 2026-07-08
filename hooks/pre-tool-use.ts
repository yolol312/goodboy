#!/usr/bin/env bun
// PreToolUse hook — 도구 강제 위임, Read-before-edit, 추론 게이트, 위험도 게이트

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  BASH_SEARCH_MESSAGE,
  checkRecursionGuard,
  classifyBashSearch,
  envInt,
  envStr,
  getCurrentTurn,
  getRecentReadMtime,
  hasReasoningSection,
  logGate,
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
const REASONING_GATE_WINDOW = 3;

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

/** 한 transcript 줄(JSON 객체)이 assistant message면 그 텍스트를 추출, 아니면 null. */
function assistantTextFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  // 후보 1: { type: "assistant", message: { content: [...] } }
  const type = obj.type as string | undefined;
  const role = (obj.role ?? (obj.message && (obj.message as Record<string, unknown>).role)) as
    | string
    | undefined;
  if (type !== 'assistant' && role !== 'assistant') return null;

  // content 추출
  const msg = (obj.message ?? obj) as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object') {
        const cc = c as Record<string, unknown>;
        if (cc.type === 'text' && typeof cc.text === 'string') {
          parts.push(cc.text);
        }
      } else if (typeof c === 'string') {
        parts.push(c);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}

/** 마지막(가장 최근) 최대 n개의 assistant message 텍스트를 최신순으로 반환.
 *  파싱 실패/없음이면 빈 배열. 게이트는 fail-open을 위해 길이 0을 별도 처리한다. */
function extractRecentAssistantTexts(transcriptPath: string, n: number): string[] {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return [];
    const raw = readFileSync(transcriptPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const texts: string[] = [];
    // 뒤에서부터 훑어 최근 n개의 assistant message 텍스트 수집
    for (let i = lines.length - 1; i >= 0 && texts.length < n; i--) {
      const text = assistantTextFromLine(lines[i] ?? '');
      if (text !== null) texts.push(text);
    }
    return texts;
  } catch {
    return [];
  }
}

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

      // (A2) H2-01 — 같은 파일 재-Read 게이트.
      //   최근 N턴 내 같은 파일을, 그 사이 mtime 변경도 편집도 없이 다시 Read하면 불필요한 재-Read로 본다.
      //   오탐 방지 예외(허용): 부분읽기(offset/limit), mtime 변경됨, 마지막 read 이후 편집됨.
      //   모든 판정은 fail-open(내부 오류/불확실 → 허용). env GOODBOY_REREAD_GATE=deny|warn|off (기본 deny).
      //   ⚠️ 서브에이전트(agent_type 존재)는 면제한다(delegation 게이트와 동일 정책).
      //   read 기록은 session_id로만 스코프되어 메인과 서브에이전트가 공유되므로, 서브에이전트가
      //   "자신은 처음 읽는" 파일도 메인이 이미 읽었다는 이유로 오차단된다. 서브에이전트는 통과시킨다.
      if (toolName === 'Read' && !input.agent_type) {
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
              const withinTurns = envInt('GOODBOY_REREAD_WINDOW', 3);
              // 최근에 읽지 않았으면 통과.
              if (!wasFileReadRecently(sessionId, absPath, turn, withinTurns)) return false;
              // 마지막 read 이후 편집됐으면 통과(내용이 바뀌었을 수 있음).
              if (wasFileEditedRecently(sessionId, absPath, turn, withinTurns)) return false;
              // 이전 read 시점 mtime을 모르면 비교 불가 → 통과(fail-open).
              const prevMtime = getRecentReadMtime(sessionId, absPath, turn, withinTurns);
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
        const recentTexts = extractRecentAssistantTexts(
          input.transcript_path ?? '',
          REASONING_GATE_WINDOW,
        );
        // recentTexts가 비면 파싱 실패/transcript 없음 → 통과 (fail-open, 안전 옵션)
        if (recentTexts.length === 0) {
          // E1: transcript가 주어졌는데 assistant 텍스트를 하나도 못 뽑았으면 무력화 신호.
          if (input.transcript_path) {
            logGate(sessionId, 'reasoning', 'fail-open', 'transcript-unparsed');
          }
        } else {
          const hasReasoning = recentTexts.some((t) => hasReasoningSection(t));
          if (!hasReasoning) {
            logGate(sessionId, 'reasoning', 'deny');
            emit(
              deny(
                "편집 전에 '## 추론' 섹션을 출력하세요. 4분류로: ### 사실 / ### 추론 / ### 가정 / ### 추측 ⚠️ . (추론 가시화 정책)",
              ),
            );
            return;
          }
        }
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

      if (preWarnings.length > 0) {
        const joined = preWarnings.join('\n');
        // additionalContext = 에이전트(서브에이전트 포함) 컨텍스트에 확실히 주입되는 채널.
        //   permissionDecision은 설정하지 않아 정상 권한 흐름을 유지한다(비차단).
        //   systemMessage는 사용자 UI 표시용으로 함께 남긴다.
        emit({
          systemMessage: joined,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: joined,
          },
        });
      } else {
        emit({});
      }
    })
    .catch((err) => {
      process.stderr.write(`[goodboy pre-tool-use] fatal: ${String(err)}\n`);
      emit({});
    });
}

main();
