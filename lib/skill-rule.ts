// Skill rule (track G §10.4) — a code edit in the main session needs a workflow skill for
// the current change, or a recorded note on why none fits.
//
// "The current change" is the set of edits since the last accepted review (the session's
// review cursor for its cwd): after a review passes, the next change needs its own evidence;
// fixing findings or a follow-up prompt within the change does not. Evidence is any of:
//   - the main session invoked a workflow skill (Skill tool, recorded by PostToolUse);
//   - the user typed a workflow command (`/goodboy:fix-bug …`, recorded by UserPromptSubmit:
//     the typed text arrives as the prompt, G0 M12, and the skill runs without a Skill call);
//   - a skill-gap note through `cli.ts skill-gap`: the skills considered, why each did not
//     fit, and what skill would. The notes also go to a persistent log for the monthly
//     review, which uses them to improve or add skills. There is no catch-all skill.
// Doc files, files outside the project and goodboy's own artifacts are exempt, and so are
// subagents (they use tool skills under the role limits).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { bareSkillName } from './role-limits';

/** Workflow skills that count as evidence: today's names and the G3 renames. */
export const WORKFLOW_SKILLS: readonly string[] = [
  'add-feature',
  'fix-bug',
  'debug',
  'diagnose-failure',
  'refactor',
  'refactor-code',
  'migrate',
  'prepare-migration',
  'write-doc',
  'request-review',
];

/** bareSkillName strips only `goodboy:`, so `other:fix-bug` matches nothing. */
export function isWorkflowSkill(skill: string): boolean {
  return WORKFLOW_SKILLS.includes(bareSkillName(skill));
}

export interface SkillGapNote {
  considered: { skill: string; why_not: string }[];
  would_fit: string;
  task?: string;
}

export type SkillEvidence =
  | { k: 'skill'; t: number; name: string; typed?: boolean }
  | { k: 'skill-gap'; t: number; note: SkillGapNote };

const EVIDENCE_FILE = 'skill-evidence.jsonl';
const MIN_REASON = 15;

export function recordSkillEvidence(sessionId: string, rec: SkillEvidence): void {
  try {
    appendFileSync(join(ensureSessionDir(sessionId), EVIDENCE_FILE), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

export function readSkillEvidence(sessionId: string): SkillEvidence[] {
  try {
    const p = join(ensureSessionDir(sessionId), EVIDENCE_FILE);
    if (!existsSync(p)) return [];
    const out: SkillEvidence[] = [];
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const r = JSON.parse(line) as SkillEvidence;
        if (r && typeof r.t === 'number' && (r.k === 'skill' || r.k === 'skill-gap')) out.push(r);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** True when the session has evidence recorded after `sinceMs` (epoch ms). */
export function hasSkillEvidenceSince(sessionId: string, sinceMs: number): boolean {
  return readSkillEvidence(sessionId).some((r) => r.t > sinceMs);
}

/** Checks a skill-gap note: at least one workflow skill considered, each with a reason, and
 *  the skill that would fit. Reasons shorter than 15 characters do not count. */
export function validateSkillGapNote(parsed: unknown): { ok: boolean; errors: string[]; value?: SkillGapNote } {
  const errors: string[] = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['the note must be a JSON object'] };
  }
  const o = parsed as Record<string, unknown>;
  const considered = Array.isArray(o.considered) ? o.considered : null;
  if (!considered || considered.length === 0) errors.push('considered: list at least one workflow skill you considered');
  const items: { skill: string; why_not: string }[] = [];
  (considered ?? []).forEach((c, i) => {
    const item = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const skill = typeof item.skill === 'string' ? item.skill.trim() : '';
    const why = typeof item.why_not === 'string' ? item.why_not.trim() : '';
    if (!isWorkflowSkill(skill)) errors.push(`considered[${i}].skill: "${skill}" is not a workflow skill (${WORKFLOW_SKILLS.join(', ')})`);
    if (why.length < MIN_REASON) errors.push(`considered[${i}].why_not: say why it does not fit (at least ${MIN_REASON} characters)`);
    items.push({ skill, why_not: why });
  });
  const wouldFit = typeof o.would_fit === 'string' ? o.would_fit.trim() : '';
  if (wouldFit.length < MIN_REASON) errors.push(`would_fit: describe the skill that would fit (at least ${MIN_REASON} characters)`);
  if (errors.length > 0) return { ok: false, errors };
  const value: SkillGapNote = { considered: items, would_fit: wouldFit };
  if (typeof o.task === 'string' && o.task.trim() !== '') value.task = o.task.trim();
  return { ok: true, errors: [], value };
}

/** Persistent log dir for the monthly review (GOODBOY_LOG_DIR, default ~/.claude/goodboy/logs). */
export function goodboyLogDir(): string {
  const env = (process.env.GOODBOY_LOG_DIR ?? '').trim();
  return env !== '' ? env : join(homedir(), '.claude', 'goodboy', 'logs');
}

export function appendSkillGapLog(entry: { ts: string; session: string; cwd: string; note: SkillGapNote }): void {
  try {
    const dir = goodboyLogDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'skill-gaps.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // best-effort: the session evidence is what the rule checks
  }
}

/** Deny text: invoke a workflow skill, delegate, or record why none fits. */
export function skillRuleMessage(cliPath: string, sessionId: string): string {
  const names = ['add-feature', 'fix-bug', 'debug', 'refactor', 'migrate', 'write-doc'].map((n) => `goodboy:${n}`).join(', ');
  return (
    'A code edit in the main session needs a workflow skill for this change (skill rule). ' +
    `Invoke the one that fits with the Skill tool (${names}), or delegate the edit to an agent. ` +
    'If none fits, record why, then edit again:\n' +
    `bun "${cliPath}" skill-gap --session ${sessionId} <<'EOF'\n` +
    '{"considered":[{"skill":"fix-bug","why_not":"<why it does not fit>"}],"would_fit":"<the skill that would fit>","task":"<the change>"}\n' +
    'EOF'
  );
}
