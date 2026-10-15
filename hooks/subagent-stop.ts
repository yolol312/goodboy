#!/usr/bin/env bun
// SubagentStop hook (track G §10.7) — records that an agent finished, and whether its final
// text says BLOCKED, so the delegation guard stops counting it as running. A background
// agent's Agent call returned at launch (G0 M10), so this is the hook event that carries its
// completion (the main session also gets a <task-notification> prompt).
// Never blocks; any error is swallowed.

import { appendDispatchLog, outcomeOf } from '../lib';

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
    try {
      const input = (raw.trim() === '' ? {} : JSON.parse(raw)) as SubagentStopInput;
      if (typeof input.agent_id === 'string' && input.agent_id !== '') {
        const last = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
        appendDispatchLog(input.session_id ?? 'unknown', {
          k: 'done',
          t: Date.now(),
          tuid: null,
          agentId: input.agent_id,
          outcome: outcomeOf(last),
        });
      }
    } catch (err) {
      process.stderr.write(`[goodboy subagent-stop] ${String(err)}\n`);
    }
    process.stdout.write('{}');
  })
  .catch(() => {
    process.stdout.write('{}');
  });
