#!/usr/bin/env bun
// UserPromptSubmit hook — 슬래시 커맨드 필수요소 검증 + 위험도 사전 분류

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  buildRequiredInputsChecklist,
  classifyRisk,
  CONCISE_INSTRUCTION,
  detectRiskOverride,
  envStr,
  getCurrentTurn,
  parseSkillFrontmatter,
  wantsDetail,
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

const SLASH_REGEX = /^\s*\/([\w-]+)(?:\s+([\s\S]*))?$/m;

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

function resolveSkillPath(cmd: string, cwd: string): string | null {
  const candidates: string[] = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    candidates.push(resolvePath(process.env.CLAUDE_PLUGIN_ROOT, 'skills', cmd, 'SKILL.md'));
  }
  // cwd 자체가 plugin root이거나, 그 위에 있을 수도 있음 (개발 중)
  candidates.push(resolvePath(cwd, 'skills', cmd, 'SKILL.md'));
  // 이 hook 스크립트의 ../skills/ — bun으로 실행 시 import.meta.dir
  try {
    const here = import.meta.dir;
    if (here) {
      candidates.push(resolvePath(here, '..', 'skills', cmd, 'SKILL.md'));
    }
  } catch {
    // ignore
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function ensureClaudeDir(cwd: string): string {
  const dir = resolvePath(cwd, '.claude');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  return dir;
}

function main(): void {
  readStdin()
    .then((raw) => {
      let input: PromptInput = {};
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as PromptInput);
      } catch (err) {
        process.stderr.write(`[vcf user-prompt-submit] stdin parse error: ${String(err)}\n`);
        emit({});
        return;
      }

      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? 'unknown';
      const prompt = input.prompt ?? '';

      // (H5-04) 간결-우선 지시(소프트 규칙 — 모델 유도용). 상세 요청 신호가 있으면 주입하지 않는다.
      //   env VCF_CONCISE_DEFAULT=on|off (기본 on). 슬래시/일반 프롬프트 모두에 적용.
      const conciseContext =
        envStr('VCF_CONCISE_DEFAULT', 'on') !== 'off' && !wantsDetail(prompt)
          ? CONCISE_INSTRUCTION
          : '';
      const emitConcise = (): void => {
        if (conciseContext) {
          emit({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: conciseContext,
            },
          });
        } else {
          emit({});
        }
      };

      // (A) 슬래시 커맨드 감지
      const m = prompt.match(SLASH_REGEX);
      if (!m) {
        emitConcise();
        return;
      }
      const cmd = m[1] ?? '';
      const args = m[2] ?? '';
      if (!KNOWN_CATEGORIES.has(cmd)) {
        emitConcise();
        return;
      }

      // (B) 필수요소 검증
      let additionalContext: string | undefined;
      const skillPath = resolveSkillPath(cmd, cwd);
      let fmRiskDefault: 'simple' | 'medium' | 'risky' = 'medium';
      if (skillPath) {
        const fm = parseSkillFrontmatter(skillPath);
        if (fm) {
          fmRiskDefault = fm.risk_default;
          // 키워드 매칭으로 "누락"을 판정하지 않는다. required_inputs 전체를 self-attestation
          // 체크리스트로 모델에게 제시하고, 각 항목 충족 여부는 모델이 직접 판단하게 한다.
          const checklist = buildRequiredInputsChecklist(fm.required_inputs);
          if (checklist !== '') {
            additionalContext = checklist;
          }
        }
      }

      // (C) 위험도 사전 분류
      try {
        const userOverride = detectRiskOverride(args);
        const risk = classifyRisk({
          category: cmd,
          fileCount: 0,
          prompt: args,
          riskDefault: fmRiskDefault,
          userOverride,
        });
        const claudeDir = ensureClaudeDir(cwd);
        const stateFile = resolvePath(claudeDir, '.vcf-session-state.json');
        const turn = getCurrentTurn(sessionId);
        const state = {
          category: cmd,
          risk,
          turn,
          updatedAt: new Date().toISOString(),
        };
        writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        // 새 작업 시작 → 이전 risk 승인 마커 삭제
        const approvedPath = resolvePath(claudeDir, '.vcf-risk-approved.txt');
        try {
          if (existsSync(approvedPath)) unlinkSync(approvedPath);
        } catch {
          // best-effort
        }
        // 재시도 카운터도 리셋
        const retryPath = resolvePath(claudeDir, '.vcf-retry-count.txt');
        try {
          if (existsSync(retryPath)) unlinkSync(retryPath);
        } catch {
          // best-effort
        }
      } catch (err) {
        process.stderr.write(`[vcf user-prompt-submit] state write error: ${String(err)}\n`);
      }

      // 체크리스트(있으면)와 H5-04 간결-우선 지시를 합쳐 additionalContext로 내보낸다.
      const combined = [additionalContext, conciseContext]
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
      process.stderr.write(`[vcf user-prompt-submit] fatal: ${String(err)}\n`);
      emit({});
    });
}

main();
