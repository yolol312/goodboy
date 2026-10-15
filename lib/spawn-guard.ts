// Delegation guard (track G, plan §10.7) — who may start agents, how many, and when the
// same agent may run again on the same work.
//
// Rules:
//   - Depth 2: main → lead → member. Only a `-lead` role starts agents, and only its own
//     members; members and every other agent cannot delegate. Plugin agents ignore the
//     `Agent(...)` allowlist (G0 M5), so this is the only enforcement.
//   - A lead's member calls run in the foreground so the lead receives and merges the
//     results; background completions would go to the main session instead (M14, M15).
//   - Caps: per task (main's calls since the last user prompt), per lead run, at once, per
//     session. A spent budget ends the work as incomplete, never as passed.
//   - The same agent with the same prompt runs again only with evidence: a new user prompt
//     since; a file the prompt names (or, when it names none, any edit) changed since; the
//     last result was BLOCKED or is missing (one retry); a stronger model or effort (once).
//
// State: `dispatch-log.jsonl` in the session dir, written by UserPromptSubmit (prompts),
// PreToolUse (dispatches), PostToolUse (launch or completion), PostToolUseFailure (a failed
// call) and SubagentStop (completion).
// Inside a subagent the guard fails closed; in the main session it fails open.

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { commandSegments } from './outward-command';
import { hashPrompt } from './recursion-guard';
import {
  bareAgentName,
  effortRank,
  isLead,
  modelRank,
  roleOf,
  type SpawnCaps,
} from './routing-policy';

const LOG_FILE = 'dispatch-log.jsonl';
/** A dispatch with no completion after this long no longer counts as running. */
export const RUNNING_STALE_MS = 30 * 60_000;

export type DispatchWhy = 'new' | 'user-prompt' | 'scope-changed' | 'retry' | 'escalation';

export type DispatchRecord =
  | { k: 'prompt'; t: number }
  | {
      k: 'dispatch';
      t: number;
      tuid: string;
      caller: string | null;
      callerId: string | null;
      callee: string;
      hash: string;
      model: string | null;
      effort: string | null;
      files: string[];
      why: DispatchWhy;
    }
  | { k: 'launched'; t: number; tuid: string; agentId: string }
  | { k: 'done'; t: number; tuid: string | null; agentId: string | null; outcome: 'ok' | 'blocked'; tokens?: number };

type Dispatch = Extract<DispatchRecord, { k: 'dispatch' }>;

export function readDispatchLog(sessionId: string): DispatchRecord[] {
  try {
    const p = join(ensureSessionDir(sessionId), LOG_FILE);
    if (!existsSync(p)) return [];
    const out: DispatchRecord[] = [];
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const r = JSON.parse(line) as DispatchRecord;
        if (r && typeof r === 'object' && typeof r.t === 'number' && typeof r.k === 'string') out.push(r);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function appendDispatchLog(sessionId: string, rec: DispatchRecord): void {
  try {
    appendFileSync(join(ensureSessionDir(sessionId), LOG_FILE), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

/** Existing files a delegation prompt names (path-like tokens resolved against cwd), at most 20. */
export function namedFiles(prompt: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const tok of prompt.match(/[\w.~-]*\/[\w./-]+\.\w{1,8}/g) ?? []) {
    try {
      const abs = resolvePath(cwd, tok);
      if (existsSync(abs) && statSync(abs).isFile()) out.add(abs);
    } catch {
      continue;
    }
    if (out.size >= 20) break;
  }
  return Array.from(out);
}

/** True when a shell command starts a headless Claude Code run (`claude -p`, `--print`), the
 *  route around the Agent-tool guard. Checked per command segment, so `echo claude -p` passes. */
export function spawnsClaudeCli(command: string): boolean {
  // The shared shell reader (quotes removed; sudo, env, time, nohup, timeout, nice, exec,
  //   command stripped; `sh -c` and `eval` scripts read again — security review).
  // The CLI by name or path, its npm package, or a lookup of it (`"$(command -v claude)"`,
  //   `` `which claude` ``), which stays one word inside quotes.
  const isCli = (w: string) =>
    /(^|\/)claude$/.test(w) ||
    /^@anthropic-ai\/claude-code(@\S+)?$/.test(w) ||
    /(?:\$\(|`)\s*(?:command\s+-v|which|type\s+-p)\s+claude\s*(?:\)|`)/.test(w);
  const isPrint = (w: string) => w === '-p' || w === '--print' || /^-[a-zA-Z]*p[a-zA-Z]*$/.test(w) || w.startsWith('--print=');
  // Programs that run another program from their arguments (security review): `xargs claude
  //   -p`, `find … -exec claude -p`, `node "$(command -v claude)" -p`, `bun x …`, `npm exec …`.
  const LAUNCHERS = /^(?:npx|bunx|pnpx|bun|npm|pnpm|yarn|node|deno|xargs|find|parallel|exec|command|env)$/;
  for (const words of commandSegments(command)) {
    const prog = basename(words[0] ?? '');
    let at = -1;
    if (isCli(words[0] ?? '')) at = 0;
    else if (LAUNCHERS.test(prog)) at = words.findIndex((w, i) => i > 0 && isCli(w));
    if (at < 0) continue;
    if (words.slice(at + 1).some(isPrint)) return true;
  }
  return false;
}

/** Outcome of a finished agent from its final text: BLOCKED (whole word) or ok. */
export function outcomeOf(text: string | undefined | null): 'ok' | 'blocked' {
  return /\bBLOCKED\b/.test(text ?? '') ? 'blocked' : 'ok';
}

/** Log record for an Agent call's PostToolUse response (G0): a background call returns
 *  `{status: 'async_launched', agentId}` at once; a foreground call returns
 *  `{status: 'completed', agentId, content: [{type: 'text', text}], totalTokens}`. */
export function agentCallRecord(tuid: string | null, resp: unknown, now: number): DispatchRecord | null {
  if (!resp || typeof resp !== 'object' || tuid === null) return null;
  const r = resp as Record<string, unknown>;
  const agentId = typeof r.agentId === 'string' ? r.agentId : null;
  if (r.status === 'async_launched' && agentId) return { k: 'launched', t: now, tuid, agentId };
  if (r.status !== 'completed') return null;
  const text = Array.isArray(r.content)
    ? r.content
        .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
        .join('\n')
    : '';
  const rec: DispatchRecord = { k: 'done', t: now, tuid, agentId, outcome: outcomeOf(text) };
  if (typeof r.totalTokens === 'number') rec.tokens = r.totalTokens;
  return rec;
}

export interface SpawnRequest {
  /** agent_type of the caller, or null for the main session. */
  caller: string | null;
  /** agent_id of the caller (one lead run), or null. */
  callerId: string | null;
  /** subagent_type of the call (general-purpose when absent). */
  callee: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  /** Existing files the prompt names (absolute paths). */
  files: string[];
}

export interface SpawnDeps {
  /** True when the file's mtime is later than t (epoch ms). */
  fileChangedSince: (path: string, t: number) => boolean;
  /** True when the session recorded any edit after t (epoch ms). */
  editsSince: (t: number) => boolean;
}

export type SpawnCode =
  | 'member-no-delegate'
  | 'not-a-member'
  | 'lead-cap'
  | 'session-cap'
  | 'task-cap'
  | 'concurrency'
  | 'duplicate-running'
  | 'duplicate';

export interface SpawnDecision {
  allow: boolean;
  code?: SpawnCode;
  reason?: string;
  why?: DispatchWhy;
  /** Fields to set on the call's tool_input (foreground for leads; policy model/effort). */
  rewrite?: Record<string, unknown>;
}

function dispatches(log: DispatchRecord[]): Dispatch[] {
  return log.filter((r): r is Dispatch => r.k === 'dispatch');
}

/** Dispatches without a completion that are recent enough to still be running. */
export function runningDispatches(log: DispatchRecord[], now: number): Dispatch[] {
  const doneTuids = new Set<string>();
  const doneAgents = new Set<string>();
  const agentOf = new Map<string, string>();
  for (const r of log) {
    if (r.k === 'done') {
      if (r.tuid) doneTuids.add(r.tuid);
      if (r.agentId) doneAgents.add(r.agentId);
    } else if (r.k === 'launched') {
      agentOf.set(r.tuid, r.agentId);
    }
  }
  return dispatches(log).filter((d) => {
    if (now - d.t > RUNNING_STALE_MS) return false;
    if (doneTuids.has(d.tuid)) return false;
    const agent = agentOf.get(d.tuid);
    return !(agent && doneAgents.has(agent));
  });
}

function outcomeOfDispatch(log: DispatchRecord[], d: Dispatch): 'ok' | 'blocked' | 'missing' {
  let agent: string | null = null;
  for (const r of log) if (r.k === 'launched' && r.tuid === d.tuid) agent = r.agentId;
  for (const r of log) {
    if (r.k !== 'done') continue;
    if (r.tuid === d.tuid || (agent !== null && r.agentId === agent)) return r.outcome;
  }
  return 'missing';
}

/** Policy model/effort for a goodboy callee, raised (never lowered) to the call's own values. */
export function policyRewrite(
  callee: string,
  model: string | null,
  effort: string | null,
): Record<string, unknown> {
  const role = roleOf(callee);
  if (!role) return {};
  const out: Record<string, unknown> = {};
  if (modelRank(model) < modelRank(role.model)) out.model = role.model;
  if (effortRank(effort) < effortRank(role.effort)) out.effort = role.effort;
  return out;
}

const LEAF_HINT = 'Do the work yourself with your own tools and report the result (you are a leaf executor).';

export function decideSpawn(
  req: SpawnRequest,
  log: DispatchRecord[],
  caps: SpawnCaps,
  now: number,
  deps: SpawnDeps,
): SpawnDecision {
  const calleeRole = roleOf(req.callee);

  // ---- inside a subagent -------------------------------------------------------------
  if (req.caller !== null) {
    const callerRole = roleOf(req.caller);
    if (!isLead(callerRole)) {
      return {
        allow: false,
        code: 'member-no-delegate',
        reason: `Agent ${req.caller} may not start other agents; only -lead agents start their own members. ${LEAF_HINT}`,
      };
    }
    const members = callerRole!.members ?? [];
    const calleeName = bareAgentName(req.callee);
    if (!calleeRole || !members.includes(calleeName)) {
      return {
        allow: false,
        code: 'not-a-member',
        reason: `${req.caller} may start only its members (${members.join(', ')}), not ${req.callee}.`,
      };
    }
    const mine = dispatches(log).filter((d) => d.callerId !== null && d.callerId === req.callerId);
    if (mine.length >= caps.perLeadCall) {
      return {
        allow: false,
        code: 'lead-cap',
        reason: `This lead run already started ${mine.length} members (cap ${caps.perLeadCall}). Merge what you have and report the rest as not covered.`,
      };
    }
    return {
      allow: true,
      why: 'new',
      rewrite: { run_in_background: false, ...policyRewrite(req.callee, req.model, req.effort) },
    };
  }

  // ---- main session ------------------------------------------------------------------
  const all = dispatches(log);
  if (all.length >= caps.perSession) {
    return {
      allow: false,
      code: 'session-cap',
      reason: `This session already started ${all.length} agents (cap ${caps.perSession}). Finish the task yourself or stop and report it to the user as incomplete.`,
    };
  }
  let taskStart = 0;
  for (const r of log) if (r.k === 'prompt' && r.t > taskStart) taskStart = r.t;
  const mainSinceTask = all.filter((d) => d.caller === null && d.t >= taskStart);
  if (mainSinceTask.length >= caps.perTask) {
    return {
      allow: false,
      code: 'task-cap',
      reason: `This task already started ${mainSinceTask.length} agents (cap ${caps.perTask}). Finish it yourself or report it to the user as incomplete.`,
    };
  }
  const running = runningDispatches(log, now).filter((d) => d.caller === null);
  const hash = hashPrompt(req.prompt);
  const sameRunning = running.find((d) => d.callee === req.callee && d.hash === hash);
  if (sameRunning) {
    return {
      allow: false,
      code: 'duplicate-running',
      reason: `The same agent (${req.callee}) with the same prompt is still running; wait for its result instead of starting it again.`,
    };
  }
  if (running.length >= caps.concurrent) {
    return {
      allow: false,
      code: 'concurrency',
      reason: `${running.length} agents are already running (cap ${caps.concurrent}). Wait for one to finish, or do this part yourself.`,
    };
  }

  const prev = [...all].reverse().find((d) => d.caller === null && d.callee === req.callee && d.hash === hash);
  let why: DispatchWhy = 'new';
  if (prev) {
    const outcome = outcomeOfDispatch(log, prev);
    const userPromptSince = log.some((r) => r.k === 'prompt' && r.t > prev.t);
    const scopeChanged =
      prev.files.length > 0
        ? prev.files.some((f) => deps.fileChangedSince(f, prev.t))
        : deps.editsSince(prev.t);
    const stronger =
      modelRank(req.model) > modelRank(prev.model) || effortRank(req.effort) > effortRank(prev.effort);
    if (userPromptSince) why = 'user-prompt';
    else if (scopeChanged) why = 'scope-changed';
    else if (outcome !== 'ok' && prev.why !== 'retry') why = 'retry';
    else if (stronger && prev.why !== 'escalation') why = 'escalation';
    else {
      return {
        allow: false,
        code: 'duplicate',
        reason:
          `${req.callee} already ran with this prompt (result: ${outcome}); use that result. ` +
          'It runs again only when a file it covers changed, the user asked again, its result was ' +
          'BLOCKED or missing (one retry), or with a stronger model or effort (once).',
      };
    }
  }
  return { allow: true, why, rewrite: policyRewrite(req.callee, req.model, req.effort) };
}
