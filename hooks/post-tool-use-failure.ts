#!/usr/bin/env bun
// PostToolUseFailure hook (track G) — PostToolUse does not fire for a failed call (G0 M16,
// M18), so what must happen after every call happens here too:
//   - Agent/Task: record the call as done (blocked), so the delegation guard stops counting it
//     as running and allows one retry (§10.7).
//   - Bash with a non-zero exit: remove approval markers the call made and record files it
//     wrote indirectly (afterBash), or `touch <marker>; false` would skip both.
// Never blocks; any error is swallowed.

import { afterBash, appendDispatchLog, hookError } from '../lib';

interface PostToolUseFailureInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: unknown };
  agent_id?: string;
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
      const input = (raw.trim() === '' ? {} : JSON.parse(raw)) as PostToolUseFailureInput;
      sid = input?.session_id ?? null;
      if (input && input.tool_name === 'Bash') {
        const agentId = typeof input.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : undefined;
        const after = afterBash(input.session_id ?? 'unknown', input.tool_use_id, input.cwd ?? process.cwd(), input.tool_input?.command, agentId);
        const out: Record<string, unknown> = {};
        if (after.context) out.hookSpecificOutput = { hookEventName: 'PostToolUseFailure', additionalContext: after.context };
        if (after.notice) out.systemMessage = after.notice;
        process.stdout.write(JSON.stringify(out));
        return;
      }
      if (
        (input.tool_name === 'Agent' || input.tool_name === 'Task') &&
        typeof input.tool_use_id === 'string' &&
        input.tool_use_id !== ''
      ) {
        appendDispatchLog(input.session_id ?? 'unknown', {
          k: 'done',
          t: Date.now(),
          tuid: input.tool_use_id,
          agentId: null,
          outcome: 'blocked',
        });
      }
    } catch (err) {
      hookError(sid, 'post-tool-use-failure', '', err);
    }
    process.stdout.write('{}');
  })
  .catch(() => {
    process.stdout.write('{}');
  });
