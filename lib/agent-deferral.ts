// (#44 item 3) Running agents and the Stop gates that wait for them.
//
// The Stop payload lists `background_tasks` (`type`, `status`, `agent_type`; G0 M10). A gate waits only for the agents
// whose result it asks for: the test and validation gates for a `goodboy:test-*` agent, the review gate for a
// `goodboy:review-*` agent. Any other agent (research, a plain subagent) and a background shell defer nothing.
// A deferral is a pause, never evidence: the record must still exist and match when the agent is done. It ends 45
// minutes after the first deferral of the wait, so an agent that hangs cannot keep a gate open for good. (N8, plan
// §20.11) A wait ends at a Stop that sees no `goodboy:test-*` or `goodboy:review-*` agent running (`endDeferralWait`);
// the next deferral starts a new clock. Before, the clock ran from the session's first deferral, so in a long session
// a later agent run deferred nothing (the v0.38.1 run blocked three times while its agents ran). A pass does not end
// the wait: an agent that hangs stays listed as running, so its clock is never renewed.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { readRegular } from './safe-read';

/** The deferral clock's file in the session dir: `{"start": <epoch ms>}`, written by the Stop only. It is a state-guard
 *  file (lib/state-guard.ts GUARDED and HOOK_ONLY), so a model Bash call that deletes or rewrites it is put back. */
export const DEFERRAL_FILE = 'agent-deferral.json';

export type BackgroundTask = { type?: string; status?: string; agent_type?: string };

/** How long, from the first deferral of a wait, the gates keep waiting for agents. */
export const AGENT_DEFERRAL_CAP_MS = 45 * 60 * 1000;

const TEST_AGENT = /^goodboy:test-/;
const REVIEW_AGENT = /^goodboy:review-/;

export interface RunningAgents {
  /** The `agent_type` of every running subagent (`?` when it names none). */
  types: string[];
  /** Running `goodboy:test-*` agents. */
  test: string[];
  /** Running `goodboy:review-*` agents. */
  review: string[];
}

/** The subagents `tasks` lists as running, by kind. A malformed entry or list counts as none. */
export function runningAgents(tasks: unknown): RunningAgents {
  const out: RunningAgents = { types: [], test: [], review: [] };
  if (!Array.isArray(tasks)) return out;
  for (const t of tasks as unknown[]) {
    if (typeof t !== 'object' || t === null) continue;
    const task = t as BackgroundTask;
    if (task.type !== 'subagent' || task.status !== 'running') continue;
    const type = typeof task.agent_type === 'string' && task.agent_type !== '' ? task.agent_type : '?';
    out.types.push(type);
    if (TEST_AGENT.test(type)) out.test.push(type);
    if (REVIEW_AGENT.test(type)) out.review.push(type);
  }
  return out;
}

/** One line for the gate log: how many tasks the payload lists and what each is (`type/status/agent`). `absent` when the
 *  payload has no `background_tasks` (an older Claude Code), so a log tells "none running" from "not reported". */
export function tasksSummary(tasks: unknown): string {
  if (!Array.isArray(tasks)) return 'background_tasks absent';
  const parts = (tasks as unknown[]).slice(0, 8).map((t) => {
    if (typeof t !== 'object' || t === null) return '?';
    const task = t as BackgroundTask;
    const field = (v: unknown) => (typeof v === 'string' && v !== '' ? v.slice(0, 40) : '-');
    return `${field(task.type)}/${field(task.status)}/${field(task.agent_type)}`;
  });
  const more = tasks.length > 8 ? ` +${tasks.length - 8} more` : '';
  return `background_tasks ${tasks.length}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}${more}`;
}

/** (N8) Ends the wait: removes the session's deferral clock, when there is one, and then calls `onEnded` (the Stop
 *  snapshots the open agent calls again, so a call's post hook does not put the removed clock back). Does nothing
 *  while `agents` lists a running test or review agent. Never throws; a clock it cannot remove stays (closed later by
 *  its own age). */
export function endDeferralWait(sessionId: string, agents: RunningAgents, onEnded?: () => void): boolean {
  if (agents.test.length > 0 || agents.review.length > 0) return false;
  try {
    const path = join(ensureSessionDir(sessionId), DEFERRAL_FILE);
    if (readRegular(path, 4096, true) === 'absent') return false;
    rmSync(path, { force: true });
    try {
      onEnded?.();
    } catch {
      // best-effort
    }
    return true;
  } catch {
    return false;
  }
}

/** Whether a gate may wait for agents now. The first call of a wait starts the 45-minute clock (the session's
 *  `agent-deferral.json`, created exclusively); a later call is true until the clock runs out. It fails CLOSED: a clock
 *  that cannot be read (not a plain file, too large, malformed, dated in the future) or started (the write failed) means
 *  no deferral, so the gate blocks as it would without an agent. */
export function deferralOpen(sessionId: string, nowMs: number = Date.now(), onStarted?: () => void): boolean {
  try {
    const path = join(ensureSessionDir(sessionId), DEFERRAL_FILE);
    let read = readRegular(path, 4096, true);
    if (read === 'absent') {
      try {
        writeFileSync(path, JSON.stringify({ start: nowMs }), { flag: 'wx', mode: 0o600 });
        // The clock is new: `onStarted` lets the caller tell the state guard (an open agent call's snapshot predates it,
        //   and the guard removes a hook-only file that appeared after the snapshot, which would restart the clock).
        try {
          onStarted?.();
        } catch {
          // best-effort
        }
        return true;
      } catch (err) {
        // Another Stop's first deferral won the race: judge that clock. Any other failure: closed.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
        read = readRegular(path, 4096, true);
      }
    }
    if (read === 'absent' || read === 'refused') return false;
    const start = (JSON.parse(read.text) as { start?: unknown } | null)?.start;
    if (typeof start !== 'number' || !Number.isFinite(start) || start > nowMs) return false;
    return nowMs - start <= AGENT_DEFERRAL_CAP_MS;
  } catch {
    return false;
  }
}
