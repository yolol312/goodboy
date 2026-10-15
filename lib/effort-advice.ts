// Effort advice (track G §10.5) — what effort the main session should run at, told to the
// user at the end of a turn. The model cannot change the main session's effort (only the
// user can, with /effort), and a skill's own effort lasts only for the turn that invoked it
// (G0 M2), so a multi-turn workflow continues at the user's setting afterwards.
//
// Signals: a registered workflow command whose skill runs higher than the current effort;
// the same rule blocking twice since the last advice (raise one level); a doc-only change
// at more than medium (lower to medium). Advice repeats only when the recommendation changes.
// An effort change keeps the prompt cache (G0 M11), so advice costs nothing to follow.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import type { GateEvent } from './gate-log';
import { effortRank, type Effort } from './routing-policy';

/** Effort of each workflow skill (§10.4), today's names and the G3 renames. */
export const WORKFLOW_EFFORT: Record<string, Effort> = {
  'add-feature': 'high',
  'fix-bug': 'high',
  debug: 'high',
  'diagnose-failure': 'high',
  refactor: 'high',
  'refactor-code': 'high',
  migrate: 'xhigh',
  'prepare-migration': 'xhigh',
  'write-doc': 'medium',
  'request-review': 'low',
};

const LADDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export type EffortWhy = 'workflow' | 'repeated-block' | 'docs-only';

export interface EffortAdvice {
  level: Effort;
  why: EffortWhy;
}

export interface EffortSignals {
  /** effort.level from the Stop payload, or null when the payload has none. */
  current: string | null;
  /** Category of the registered workflow command, or null. */
  category: string | null;
  /** The same gate denied at least twice since the last advice. */
  repeatedBlock: boolean;
  /** Every edit of the current change is a doc file (and there is at least one). */
  docOnly: boolean;
}

export function recommendEffort(s: EffortSignals): EffortAdvice | null {
  const cur = effortRank(s.current);
  if (cur === 0) return null;
  const wf = s.category ? WORKFLOW_EFFORT[s.category] : undefined;
  if (wf && effortRank(wf) > cur) return { level: wf, why: 'workflow' };
  if (s.repeatedBlock && cur < effortRank('xhigh')) return { level: LADDER[cur]!, why: 'repeated-block' };
  if (s.docOnly && cur > effortRank('medium') && !(wf && effortRank(wf) >= cur)) return { level: 'medium', why: 'docs-only' };
  return null;
}

/** True when one gate denied at least twice after `sinceIso`. */
export function hasRepeatedBlock(events: GateEvent[], sinceIso: string | null): boolean {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.decision !== 'deny') continue;
    if (sinceIso !== null && e.ts <= sinceIso) continue;
    const n = (counts.get(e.gate) ?? 0) + 1;
    if (n >= 2) return true;
    counts.set(e.gate, n);
  }
  return false;
}

const ADVICE_FILE = 'effort-advice.json';

interface AdviceState {
  level: string;
  ts: string;
}

export function readLastAdvice(sessionId: string): AdviceState | null {
  try {
    const p = join(ensureSessionDir(sessionId), ADVICE_FILE);
    if (!existsSync(p)) return null;
    const v = JSON.parse(readFileSync(p, 'utf8')) as AdviceState;
    return typeof v.level === 'string' && typeof v.ts === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function writeLastAdvice(sessionId: string, level: string): void {
  try {
    writeFileSync(join(ensureSessionDir(sessionId), ADVICE_FILE), JSON.stringify({ level, ts: new Date().toISOString() }), 'utf8');
  } catch {
    // best-effort: the advice may repeat
  }
}

const WHY_KO: Record<EffortWhy, (category: string | null) => string> = {
  workflow: (c) => `/${c ?? 'workflow'} 작업은 이 effort로 진행해요`,
  'repeated-block': () => '같은 규칙에 두 번 막혔어요',
  'docs-only': () => '문서만 고치는 중이에요',
};

/** User-facing notice (Korean: it asks the user to run a command). */
export function effortNotice(current: string, advice: EffortAdvice, category: string | null): string {
  return `[goodboy] effort 조언: 지금 ${current} → \`/effort ${advice.level}\` 추천 (${WHY_KO[advice.why](category)})`;
}

const SKILLS_DIR = join(import.meta.dir, '..', 'skills');

/** The `effort:` a goodboy skill's frontmatter declares, or null. */
export function skillEffort(skill: string): Effort | null {
  if (!skill.startsWith('goodboy:')) return null;
  const name = skill.slice('goodboy:'.length);
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  try {
    const text = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const front = text.match(/^---\n([^]*?)\n---/)?.[1] ?? '';
    const effort = front.match(/^effort:\s*(\S+)\s*$/m)?.[1];
    return effort && effortRank(effort) > 0 ? (effort as Effort) : null;
  } catch {
    return null;
  }
}

/** The one-line notice when a skill runs at its own effort (§10.5: applied without a
 *  prompt, for the invoking turn), or null when it matches the session's effort or
 *  GOODBOY_SKILL_EFFORT=off. Korean: the user reads it. */
export function skillEffortNotice(skill: string, sessionEffort: string | undefined): string | null {
  if ((process.env.GOODBOY_SKILL_EFFORT ?? 'auto').trim().toLowerCase() === 'off') return null;
  const effort = skillEffort(skill);
  if (effort === null || effort === (sessionEffort ?? '').toLowerCase()) return null;
  const name = skill.slice('goodboy:'.length);
  return `[goodboy] ${name} 스킬은 effort ${effort}로 실행돼요(이번 턴만, 끝나면 ${sessionEffort ?? '원래'} 설정으로 돌아가요).`;
}
