// Routing policy table (track G, plan §10.3–10.7) — the one source for goodboy's agent
// roles, their model and effort, who may call whom, which tool skills each may use, and the
// delegation caps. Hooks enforce it because plugin agents ignore the `Agent(...)` and
// `Skill(...)` allowlists and `permissionMode` (G0 M5, M9).

export type Team = 'research' | 'build' | 'review' | 'test';
export type ModelAlias = 'haiku' | 'sonnet' | 'opus';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** What an agent may write: nothing, only its result (through the CLI), test files, docs, or code. */
export type WriteScope = 'none' | 'result' | 'tests' | 'docs' | 'code';

export interface RoleSpec {
  name: string;
  team: Team;
  model: ModelAlias;
  effort: Effort;
  writes: WriteScope;
  /** Members a lead may call; absent for members, which may call nobody. */
  members?: string[];
  /** Tool skills the agent may invoke (follow-agent-rules is preloaded, not invoked). */
  toolSkills: string[];
}

const REVIEWERS = [
  'review-all',
  'review-spec',
  'review-quality',
  'review-security',
  'review-ui',
  'review-infra',
  'review-evidence',
];

export const ROLES: readonly RoleSpec[] = [
  { name: 'research-lead', team: 'research', model: 'opus', effort: 'medium', writes: 'none', members: ['research-web', 'research-code', 'research-cause'], toolSkills: ['cite-sources'] },
  { name: 'research-web', team: 'research', model: 'sonnet', effort: 'medium', writes: 'none', toolSkills: ['cite-sources'] },
  { name: 'research-code', team: 'research', model: 'sonnet', effort: 'medium', writes: 'none', toolSkills: ['summarize-diff'] },
  { name: 'research-cause', team: 'research', model: 'opus', effort: 'high', writes: 'none', toolSkills: ['isolate-cause', 'probe-runtime'] },
  { name: 'build-backend', team: 'build', model: 'sonnet', effort: 'high', writes: 'code', toolSkills: ['write-api-contract'] },
  { name: 'build-frontend', team: 'build', model: 'sonnet', effort: 'high', writes: 'code', toolSkills: ['write-api-contract', 'follow-design-tokens'] },
  { name: 'build-data', team: 'build', model: 'opus', effort: 'high', writes: 'code', toolSkills: ['write-migration'] },
  { name: 'build-infra', team: 'build', model: 'sonnet', effort: 'high', writes: 'code', toolSkills: ['edit-infra-safely'] },
  { name: 'build-docs', team: 'build', model: 'sonnet', effort: 'medium', writes: 'docs', toolSkills: ['keep-project-knowledge'] },
  { name: 'build-run', team: 'build', model: 'haiku', effort: 'low', writes: 'none', toolSkills: ['run-long-command'] },
  { name: 'review-lead', team: 'review', model: 'sonnet', effort: 'high', writes: 'result', members: REVIEWERS, toolSkills: ['summarize-diff', 'record-review', 'run-codex-review'] },
  { name: 'review-all', team: 'review', model: 'sonnet', effort: 'high', writes: 'result', toolSkills: ['summarize-diff', 'record-review', 'check-security', 'check-evidence', 'check-code-quality', 'check-ui-states', 'follow-design-tokens', 'run-codex-review'] },
  { name: 'review-spec', team: 'review', model: 'sonnet', effort: 'high', writes: 'result', toolSkills: ['summarize-diff', 'record-review', 'check-spec-coverage'] },
  { name: 'review-quality', team: 'review', model: 'sonnet', effort: 'medium', writes: 'result', toolSkills: ['summarize-diff', 'record-review', 'check-code-quality'] },
  { name: 'review-security', team: 'review', model: 'opus', effort: 'high', writes: 'result', toolSkills: ['summarize-diff', 'record-review', 'check-security'] },
  { name: 'review-ui', team: 'review', model: 'sonnet', effort: 'medium', writes: 'result', toolSkills: ['summarize-diff', 'record-review', 'follow-design-tokens', 'check-ui-states'] },
  { name: 'review-infra', team: 'review', model: 'sonnet', effort: 'high', writes: 'result', toolSkills: ['summarize-diff', 'record-review', 'check-infra-config'] },
  { name: 'review-evidence', team: 'review', model: 'opus', effort: 'high', writes: 'result', toolSkills: ['summarize-diff', 'record-review', 'check-evidence'] },
  { name: 'test-lead', team: 'test', model: 'sonnet', effort: 'high', writes: 'none', members: ['test-unit', 'test-spec', 'test-ui', 'test-security'], toolSkills: [] },
  { name: 'test-unit', team: 'test', model: 'sonnet', effort: 'high', writes: 'tests', toolSkills: ['record-tests', 'check-spec-coverage', 'write-regression-test', 'measure-coverage'] },
  { name: 'test-spec', team: 'test', model: 'sonnet', effort: 'high', writes: 'tests', toolSkills: ['record-tests', 'check-spec-coverage', 'run-e2e', 'measure-coverage'] },
  { name: 'test-ui', team: 'test', model: 'sonnet', effort: 'high', writes: 'tests', toolSkills: ['record-tests', 'check-ui-states', 'run-e2e'] },
  { name: 'test-security', team: 'test', model: 'opus', effort: 'high', writes: 'tests', toolSkills: ['record-tests', 'attack-sandbox', 'write-regression-test'] },
  { name: 'test-probe', team: 'test', model: 'sonnet', effort: 'high', writes: 'none', toolSkills: ['probe-runtime'] },
];

/** The agents goodboy's gates send work to, by job. Every hook message takes its agent names
 *  from here, so a rename is one change (§10.3). */
export const ROUTE = {
  /** A review of the changed files (one all-axes run, or one run per axis). */
  review: 'review-all',
  /** Layer-1 tests of the changed code. */
  test: 'test-unit',
} as const;

/** Names of the agents before G2, still recognized as their roles (a session started before
 *  an upgrade keeps the old agents). */
export const LEGACY_AGENTS: Readonly<Record<string, string>> = { 'review-changes': 'review-all', 'test-changes': 'test-unit' };

/** The plugin's name for a role: `goodboy:review-all`. */
export function agentName(role: string): string {
  return `goodboy:${role}`;
}

/** Roles whose capability check passed (§10.3: a live run produced its artifact; plan §10.12
 *  M19). Only these are routed to: a gate names no other agent. The others can still be
 *  called, and join when their check passes. */
export const CHECKED_ROLES: ReadonlySet<string> = new Set([ROUTE.review, ROUTE.test]);

/** Delegation caps (§10.7), each tunable by env. The task and session counts are fuses (#21):
 *  at 8 per task they starved the test and review agents the gates ask for; runaways are told
 *  by repetition (lib/spawn-guard.ts), depth and concurrency. */
export interface SpawnCaps {
  perTask: number;
  perLeadCall: number;
  concurrent: number;
  perSession: number;
}

export const DEFAULT_CAPS: SpawnCaps = { perTask: 30, perLeadCall: 6, concurrent: 3, perSession: 150 };

function envPositiveInt(name: string, fallback: number): number {
  const n = parseInt((process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function spawnCaps(): SpawnCaps {
  return {
    perTask: envPositiveInt('GOODBOY_SPAWN_LIMIT', DEFAULT_CAPS.perTask),
    perLeadCall: envPositiveInt('GOODBOY_SPAWN_LIMIT_LEAD', DEFAULT_CAPS.perLeadCall),
    concurrent: envPositiveInt('GOODBOY_SPAWN_CONCURRENCY', DEFAULT_CAPS.concurrent),
    perSession: envPositiveInt('GOODBOY_SPAWN_LIMIT_SESSION', DEFAULT_CAPS.perSession),
  };
}

/** Bare role name of an agent type: `goodboy:review-all` → `review-all`. Other plugins'
 *  agents and built-ins keep their full name and match no goodboy role. */
export function bareAgentName(agentType: string | undefined | null): string {
  const t = (agentType ?? '').trim();
  return t.startsWith('goodboy:') ? t.slice('goodboy:'.length) : t;
}

/** The goodboy role for an agent type, or null (built-ins, other plugins, legacy names). */
export function roleOf(agentType: string | undefined | null): RoleSpec | null {
  // bareAgentName strips only `goodboy:`, so `other:review-all` keeps its prefix and matches nothing.
  const name = bareAgentName(agentType);
  return ROLES.find((r) => r.name === name) ?? null;
}

export function isLead(role: RoleSpec | null): boolean {
  return !!role && Array.isArray(role.members) && role.members.length > 0;
}

const MODEL_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };
const EFFORT_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

/** Rank of a model alias or full model id (`claude-opus-5-5` → opus); 0 when unknown. */
export function modelRank(model: string | undefined | null): number {
  const m = (model ?? '').toLowerCase();
  for (const [alias, rank] of Object.entries(MODEL_RANK)) {
    if (m === alias || m.includes(`-${alias}-`) || m.startsWith(`${alias}-`) || m.endsWith(`-${alias}`)) {
      return rank;
    }
  }
  return 0;
}

export function effortRank(effort: string | undefined | null): number {
  return EFFORT_RANK[(effort ?? '').toLowerCase()] ?? 0;
}
