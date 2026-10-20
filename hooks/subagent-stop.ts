#!/usr/bin/env bun
// SubagentStop hook (track G §10.7) — records that an agent finished, and whether its final
// text says BLOCKED, so the delegation guard stops counting it as running. A background
// agent's Agent call returned at launch (G0 M10), so this is the hook event that carries its
// completion (the main session also gets a <task-notification> prompt). It also finishes the
// agent's open Bash calls (lib/write-sweep.ts). Never blocks; any error is swallowed.

import { appendDispatchLog, finishOpenBashCalls, hookError, outcomeOf } from '../lib';

interface SubagentStopInput {
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  last_assistant_message?: unknown;
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

readStdin()
  .then((raw) => {
    // (J3) The session for the hook-error record (lib/gate-log.ts hookError).
    let sid: string | null = null;
    try {
      const input = (raw.trim() === '' ? {} : JSON.parse(raw)) as SubagentStopInput;
      sid = input.session_id ?? null;
      if (typeof input.agent_id === 'string' && input.agent_id !== '') {
        const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
        appendDispatchLog(input.session_id ?? 'unknown', {
          k: 'done',
          t: Date.now(),
          tuid: null,
          agentId: input.agent_id,
          outcome: outcomeOf(last),
        });
        // (#14) The agent has ended, so its Bash calls have: finish the ones that never
        //   reported back (`exit N`), or that the main session's Stop noted again.
        try {
          finishOpenBashCalls(input.session_id ?? 'unknown', { agent: input.agent_id });
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      hookError(sid, 'subagent-stop', '', err);
    }
    process.stdout.write('{}');
  })
  .catch(() => {
    process.stdout.write('{}');
  });
