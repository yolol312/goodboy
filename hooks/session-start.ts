#!/usr/bin/env bun
// SessionStart hook (track G §10.5) — configuration warnings for new and resumed sessions:
// environment settings that override goodboy's routing policy (user-facing, so Korean). After
// a compaction (source "compact", G0 M17) it resets what read-before-edit counts as known:
// file contents read or edited before it left the context. In a project it also sends the
// knowledge files to read first (H2), the decision authority (H3), the user's CLAUDE.md
// notice (H4) and the test tier advice (H6). It pins the coverage exemptions and the start
// HEAD (I1). Never blocks.

import { pinCommitIssueSettings } from '../lib/commit-issue';
import { pinProjectMode, projectMode } from '../lib/project-mode';
import { knowledgeRoot, knowledgeSessionNotice } from '../lib/project-knowledge';
import { claudeMdNotice } from '../lib/doc-map';
import { tierAdvice } from '../lib/test-profile';
import { decisionAuthorityContext } from '../lib/decision-authority';
import { clearReadRecords } from '../lib/file-tracker';
import { pinCoverageStart } from '../lib/changed-coverage';
import { pinSessionCriteria } from '../lib/session-criteria';

interface SessionStartInput {
  session_id?: string;
  source?: string;
  cwd?: string;
}

/** Warnings for the current environment (exported for tests). */
export function configWarnings(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const effort = (env.CLAUDE_CODE_EFFORT_LEVEL ?? '').trim();
  if (effort !== '') {
    out.push(
      `[goodboy] 환경변수 CLAUDE_CODE_EFFORT_LEVEL=${effort}이 모든 effort 설정(스킬·에이전트 포함)을 덮어써요. goodboy의 역할별 effort가 적용되지 않아요.`,
    );
  }
  const subagentModel = (env.CLAUDE_CODE_SUBAGENT_MODEL ?? '').trim();
  if (subagentModel !== '') {
    out.push(
      `[goodboy] 환경변수 CLAUDE_CODE_SUBAGENT_MODEL=${subagentModel}이 모든 서브에이전트의 모델을 덮어써요. goodboy의 역할별 모델이 적용되지 않아요.`,
    );
  }
  const depthRaw = (env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH ?? '').trim();
  const depth = parseInt(depthRaw, 10);
  if (depthRaw !== '' && Number.isFinite(depth) && depth < 2) {
    out.push(
      `[goodboy] CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=${depthRaw}이라 리드 에이전트가 멤버를 부를 수 없어요(2 이상이 필요해요).`,
    );
  }
  return out;
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

if (import.meta.main) {
  readStdin()
    .then((raw) => {
      let input: SessionStartInput = {};
      try {
        input = raw.trim() === '' ? {} : (JSON.parse(raw) as SessionStartInput);
      } catch {
        input = {};
      }
      const source = input.source ?? 'startup';
      const sessionId = typeof input.session_id === 'string' && input.session_id !== '' ? input.session_id : null;
      if (source === 'compact' && sessionId) clearReadRecords(sessionId);
      // A new, resumed or cleared session uses the commit issue settings on disk now
      //   (lib/commit-issue.ts; `/clear` starts a new session id).
      if ((source === 'startup' || source === 'resume' || source === 'clear') && sessionId) {
        try {
          pinCommitIssueSettings(sessionId, input.cwd ?? process.cwd());
        } catch {
          // best-effort: without pins, a later file counts only when unchanged since the session dir was made
        }
        // …and the project mode its cwd has now (lib/project-mode.ts; not on compact, which
        //   would trust a marker written during the session).
        pinProjectMode(sessionId, input.cwd ?? process.cwd());
        // …and the user's policy globs with the start HEAD (I1, lib/changed-coverage.ts). Pinned
        //   whatever the changed-line mode: the static previews (I3a) count without it.
        pinCoverageStart(sessionId, input.cwd ?? process.cwd());
        // …and the requirement rows and policy `test:` lines it starts from (I2).
        pinSessionCriteria(sessionId, input.cwd ?? process.cwd());
      }
      const warnings = source === 'startup' || source === 'resume' ? configWarnings(process.env) : [];
      // (H2) Every source, project mode: the project's knowledge files to read first, or the
      //   skill to create them (lib/project-knowledge.ts).
      let knowledge: { context?: string; systemMessage?: string } = {};
      if (sessionId && (process.env.GOODBOY_POLICY_GATE ?? 'on').trim().toLowerCase() !== 'off') {
        try {
          knowledge = knowledgeSessionNotice(input.cwd ?? process.cwd(), sessionId);
        } catch {
          knowledge = {};
        }
      }
      // (H3) Every source, project mode: which checks are ai and which the user decides
      //   (lib/decision-authority.ts); not tied to the read gate's switch.
      let decisions: string | null = null;
      if (sessionId) {
        try {
          decisions = decisionAuthorityContext(input.cwd ?? process.cwd(), sessionId);
        } catch {
          decisions = null;
        }
      }
      // (H4) The user's CLAUDE.md notice: /init once per project, or over its size budget.
      //   (H6) The test tier advice, once a session, when the measured tests are long.
      let claudeMd: string | null = null;
      let tier: { context: string; systemMessage: string } | null = null;
      if (sessionId) {
        const dir = input.cwd ?? process.cwd();
        try {
          if (projectMode(dir, sessionId) !== 'non-project') {
            const root = knowledgeRoot(dir).root;
            claudeMd = claudeMdNotice(root, source, process.env, dir);
            tier = tierAdvice(root, sessionId);
          }
        } catch {
          // best-effort notices
        }
      }
      const messages = [
        ...warnings,
        ...(knowledge.systemMessage ? [knowledge.systemMessage] : []),
        ...(claudeMd ? [claudeMd] : []),
        ...(tier ? [tier.systemMessage] : []),
      ];
      const context = [knowledge.context, decisions, tier?.context].filter((c): c is string => !!c).join('\n\n');
      const out: Record<string, unknown> = {};
      if (messages.length > 0) out.systemMessage = messages.join('\n');
      if (context !== '') out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context };
      process.stdout.write(JSON.stringify(out));
    })
    .catch(() => {
      process.stdout.write('{}');
    });
}
