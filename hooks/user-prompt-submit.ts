#!/usr/bin/env bun
// UserPromptSubmit hook — 슬래시 커맨드 필수요소 검증 + 위험도 사전 분류

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  appendDispatchLog,
  ASK_WHEN_UNCLEAR_INSTRUCTION,
  buildRequiredInputsChecklist,
  CONCISE_INSTRUCTION,
  detectRiskOverride,
  envStr,
  explainRisk,
  getCurrentTurn,
  isGoodboyCommand,
  isTaskNotification,
  OUTWARD_EFFECT_INSTRUCTION,
  parseSkillFrontmatter,
  parseSlashCommand,
  recordSkillEvidence,
  resetRetryCount,
  wantsDetail,
  withdrawRiskApprovals,
  writeSessionState,
} from '../lib';

interface PromptInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  prompt?: string;
}

interface HookOutput {
  continue?: boolean;
  systemMessage?: string;
  // B1: 인자 없는 카테고리 커맨드 차단. decision:'block'이면 프롬프트가 처리되지 않고
  // reason이 사용자에게 표시된다(UserPromptSubmit hook 공식 스키마).
  decision?: 'block';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: 'UserPromptSubmit';
    additionalContext?: string;
  };
}

const KNOWN_CATEGORIES = new Set([
  'fix-bug',
  'add-feature',
  'refactor',
  'migrate',
  'debug',
  'write-doc',
  'request-review',
]);

/** Prepended to the checklist of a category command typed without a description (track G:
 *  argument-free commands are allowed, since the conversation or the diff often names the target). */
const NO_ARGS_NOTE =
  'The command came without a task description. Work out the target from the conversation ' +
  'and the working tree (git status / git diff); ask only for what you cannot find there.';

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

/** cwd/skills 후보를 신뢰할지 여부(2-C). 미신뢰 repo가 skills/<cmd>/SKILL.md의 frontmatter
 *  (risk_default 등)로 위험 게이트를 낮추는 것을 막기 위해 기본적으로 신뢰하지 않는다.
 *  개발 중 cwd가 곧 plugin root인 경우를 위해 opt-in env로만 허용한다(1/on/true/yes). */
function allowCwdSkills(): boolean {
  const v = (process.env.GOODBOY_ALLOW_CWD_SKILLS ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true' || v === 'yes';
}

export function resolveSkillPath(cmd: string, cwd: string): string | null {
  const candidates: string[] = [];
  // 신뢰 소스 1: 플러그인 설치 루트.
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    candidates.push(resolvePath(process.env.CLAUDE_PLUGIN_ROOT, 'skills', cmd, 'SKILL.md'));
  }
  // 신뢰 소스 2: 이 hook 스크립트의 ../skills/ (설치 경로 — bun 실행 시 import.meta.dir).
  try {
    const here = import.meta.dir;
    if (here) {
      candidates.push(resolvePath(here, '..', 'skills', cmd, 'SKILL.md'));
    }
  } catch {
    // ignore
  }
  // 미신뢰 소스: cwd/skills — opt-in(GOODBOY_ALLOW_CWD_SKILLS)일 때만 후보에 추가한다.
  if (allowCwdSkills()) {
    candidates.push(resolvePath(cwd, 'skills', cmd, 'SKILL.md'));
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function main(): void {
  readStdin()
    .then((raw) => {
      let input: PromptInput = {};
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as PromptInput);
      } catch (err) {
        process.stderr.write(`[goodboy user-prompt-submit] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? 'unknown';
      const prompt = input.prompt ?? '';

      // (G1) A background-task completion is not a user prompt (G0 M10): no guidance, no
      //   task registration. It used to get the full B2/H5-04 text on every completion.
      if (isTaskNotification(prompt)) {
        emit({});
        return;
      }
      // (G1) A real user prompt starts a new delegation budget and is evidence that the same
      //   agent may run again (lib/spawn-guard.ts).
      appendDispatchLog(sessionId, { k: 'prompt', t: Date.now() });

      // (H5-04) 간결-우선 지시(소프트 규칙 — 모델 유도용). 상세 요청 신호가 있으면 주입하지 않는다.
      //   env GOODBOY_CONCISE_DEFAULT=on|off (기본 on). 슬래시/일반 프롬프트 모두에 적용.
      const conciseContext =
        envStr('GOODBOY_CONCISE_DEFAULT', 'on') !== 'off' && !wantsDetail(prompt)
          ? CONCISE_INSTRUCTION
          : '';

      // (B2 확장) 일반 프롬프트 부족-입력 질문 유도 — 카테고리 커맨드의 self-assessment를
      //   일반 자연어 요청으로 일반화한다. 충분한지의 의미 판정은 모델 몫(hook은 판정 불가),
      //   무시 시에는 가정 기록 의무(A1) + 가정-리뷰 검증(A2)이 안전망으로 이어받는다.
      //   카테고리 커맨드에는 전용 체크리스트가 붙으므로 여기서는 주입하지 않는다(중복 방지).
      //   env GOODBOY_ASK_UNCLEAR=on|off (기본 on).
      const askUnclearContext =
        envStr('GOODBOY_ASK_UNCLEAR', 'on') !== 'off' ? ASK_WHEN_UNCLEAR_INSTRUCTION : '';
      // (G1, R2) Outward-effect stop rule; off together with the outward-command gate.
      const outwardContext =
        envStr('GOODBOY_OUTWARD_GATE', 'on') !== 'off' ? OUTWARD_EFFECT_INSTRUCTION : '';
      const emitGeneral = (): void => {
        const combined = [askUnclearContext, outwardContext, conciseContext]
          .filter((x) => x !== '')
          .join('\n\n');
        if (combined !== '') {
          emit({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: combined,
            },
          });
        } else {
          emit({});
        }
      };

      // (A) 슬래시 커맨드 감지 — only a command that starts the prompt (G1: a command line
      //   inside pasted text used to register a task), bare or in goodboy's namespace (G0 M12:
      //   `/goodboy:fix-bug …` arrives verbatim and used to be missed).
      const slash = parseSlashCommand(prompt);
      if (!slash || !isGoodboyCommand(slash) || !KNOWN_CATEGORIES.has(slash.name)) {
        emitGeneral();
        return;
      }
      const cmd = slash.name;
      const args = slash.args;

      // (B) 필수요소 검증
      let additionalContext: string | undefined;
      const skillPath = resolveSkillPath(cmd, cwd);
      const fm = skillPath ? parseSkillFrontmatter(skillPath) : null;
      const fmRiskDefault: 'simple' | 'medium' | 'risky' = fm ? fm.risk_default : 'medium';

      // (B0) An argument-free command is allowed (G1; it used to be blocked): the target is
      //   often in the conversation or the working diff. The model is told where to look.
      const contentArgs = args.replace(/--risk[=:\s]+(simple|medium|risky)\b/gi, '').trim();
      const noArgsNote = contentArgs === '' ? NO_ARGS_NOTE : '';

      // 키워드 매칭으로 "누락"을 판정하지 않는다. required_inputs 전체를 self-attestation
      // 체크리스트로 모델에게 제시하고, 각 항목 충족 여부는 모델이 직접 판단하게 한다.
      const checklist = fm ? buildRequiredInputsChecklist(fm.required_inputs) : '';
      const merged = [noArgsNote, checklist].filter((x) => x !== '').join('\n\n');
      if (merged !== '') additionalContext = merged;

      // (C) 위험도 사전 분류
      try {
        const userOverride = detectRiskOverride(args);
        // riskReason lets the risk gate's deny message name the cause (A4).
        const { level: risk, reason: riskReason } = explainRisk({
          category: cmd,
          fileCount: 0,
          prompt: args,
          riskDefault: fmRiskDefault,
          userOverride,
        });
        const turn = getCurrentTurn(sessionId);
        // 새 작업 시작 → 이전 risk 승인 마커 삭제, 재시도 카운터 리셋. Both come before the
        //   state write so a failed write cannot skip them (security review: a read-only
        //   repo copy used to leave the old approval in place for the new risky task).
        //   This session's markers and counters only — approvals are per session (A3) —
        //   including markers under other directories the session's gate looked in.
        withdrawRiskApprovals(sessionId, cwd);
        resetRetryCount(sessionId);
        // 2-B: 세션 바인딩. pre-tool-use 위험 게이트가 다른 세션/커밋된 잔재 state를 무시하게 한다.
        //   The gates read the session-dir copy, so another session's command cannot replace it (A3).
        writeSessionState(cwd, sessionId, {
          category: cmd,
          risk,
          riskReason,
          turn,
          updatedAt: new Date().toISOString(),
        });
        // (G1) A typed workflow command arrives as the prompt itself (G0 M12) and the skill
        //   runs without a Skill tool call, so the typed command is the skill rule's evidence.
        recordSkillEvidence(sessionId, { k: 'skill', t: Date.now(), name: cmd, typed: true });
      } catch (err) {
        process.stderr.write(`[goodboy user-prompt-submit] state write error: ${String(err)}\n`);
      }

      // 체크리스트(있으면), R2와 H5-04 간결-우선 지시를 합쳐 additionalContext로 내보낸다.
      //   A workflow command is a task prompt, so it gets the R2 line too.
      const combined = [additionalContext, outwardContext, conciseContext]
        .filter((x) => x !== undefined && x !== '')
        .join('\n\n');
      const out: HookOutput = {};
      if (combined !== '') {
        out.hookSpecificOutput = {
          hookEventName: 'UserPromptSubmit',
          additionalContext: combined,
        };
      }
      emit(out);
    })
    .catch((err) => {
      process.stderr.write(`[goodboy user-prompt-submit] fatal: ${String(err)}\n`);
      emit({});
    });
}

main();
