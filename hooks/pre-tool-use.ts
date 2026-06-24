#!/usr/bin/env bun
// PreToolUse hook — 도구 강제 위임, Read-before-edit, 추론 게이트, 위험도 게이트

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  getCurrentTurn,
  hasReasoningSection,
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
}

function readSessionState(cwd: string): SessionState | null {
  try {
    const path = resolvePath(cwd, '.claude', '.vcf-session-state.json');
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
        process.stderr.write(`[vcf pre-tool-use] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? 'unknown';
      const toolName = input.tool_name ?? '';
      const toolInput = input.tool_input ?? {};

      // (A) 도구 강제 위임. 서브에이전트(agent_type 존재)면 면제.
      //   VCF_DISABLE_DELEGATION=1 이면 위임 자체를 끈다.
      if (!input.agent_type && process.env.VCF_DISABLE_DELEGATION !== '1') {
        if (DELEGATED_TOOLS.has(toolName)) {
          emit(
            deny(
              "이 도구는 서브에이전트에게 위임하세요. Agent 도구로 'general-purpose' 등 적합한 서브에이전트를 호출하세요.",
            ),
          );
          return;
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
        if (recentTexts.length > 0) {
          const hasReasoning = recentTexts.some((t) => hasReasoningSection(t));
          if (!hasReasoning) {
            emit(
              deny(
                "편집 전에 '## 추론' 섹션을 출력하세요. 4분류로: ### 사실 / ### 추론 / ### 가정 / ### 추측 ⚠️ . (추론 가시화 정책)",
              ),
            );
            return;
          }
        }
      }

      // (D) 위험도 게이트
      const state = readSessionState(cwd);
      if (state && state.risk === 'risky') {
        const approvedPath = resolvePath(cwd, '.claude', '.vcf-risk-approved.txt');
        if (!existsSync(approvedPath)) {
          emit(
            deny(
              `이 작업은 위험도가 '위험'으로 분류되었습니다(${state.category ?? '미상'}). 사용자에게 진행 승인을 받은 후, .claude/.vcf-risk-approved.txt 파일을 만들고 다시 시도하세요.`,
            ),
          );
          return;
        }
      }

      emit({});
    })
    .catch((err) => {
      process.stderr.write(`[vcf pre-tool-use] fatal: ${String(err)}\n`);
      emit({});
    });
}

main();
