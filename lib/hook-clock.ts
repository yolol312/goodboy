// One clock for a whole hook process (v0.36.14, plan §15.30 item 12). The Stop, SessionStart and the two
// post hooks have hook timeouts (hooks/hooks.json), and a hook that is killed emits nothing, which passes. The
// phases of a hook each keep a budget of their own (the nested-repo walk, the start pins, the test
// groups, the review groups), so a slow git could use all of them in turn and outlast the hook.
// Every phase also asks `hookLeft()`, so the last one to run out blocks or gives up through its own
// path instead of the hook being cut off.
//
// Never started (a library caller, the CLI, a test): `hookLeft()` is Infinity and nothing changes.

/** What each hook's clock runs for, ms, below its timeout in hooks/hooks.json: 15 s for the Stop,
 *  SessionStart, PostToolUseFailure and SubagentStop, 60 s for PostToolUse. The rest of the hook (output, the
 *  gate log, notices) needs the difference. SessionStart's start-pin budget (8 s, lib/start-pins.ts) stays whole
 *  inside its clock. The post hooks and SubagentStop (which finishes an agent's open Bash calls) run the
 *  shell-write sweep, which walks the nested repos of a project dir that is no repo (lib/write-sweep.ts
 *  `nestedStatus`): a hook killed there records no write. */
export const HOOK_CLOCK_MS = { stop: 11_000, sessionStart: 12_000, postToolUse: 45_000, postToolUseFailure: 11_000, subagentStop: 11_000 } as const;

/** How long the Stop's wait for the transcript flush may run past the clock, ms (hooks/stop.ts
 *  `checkCitations`). The Stop's 15 s minus its 11 s clock leaves room for this wait and the output. */
export const FLUSH_PAST_CLOCK_MS = 2_000;

let endsAt: number | null = null;

/** Starts the hook's clock: `totalMs` from now. Call it first thing in a hook's main. Test seam
 *  `GOODBOY_TEST_HOOK_CLOCK_MS` replaces `totalMs` (a spawned hook's test); unset in use. */
export function startHookClock(totalMs: number, env: Record<string, string | undefined> = process.env): void {
  const seam = Number.parseInt((env.GOODBOY_TEST_HOOK_CLOCK_MS ?? '').trim(), 10);
  endsAt = Date.now() + (Number.isFinite(seam) && seam >= 0 ? seam : totalMs);
}

/** Ms left on the hook's clock (at most 0 once it ran out); Infinity when it was never started. */
export function hookLeft(): number {
  return endsAt === null ? Infinity : endsAt - Date.now();
}

/** Whether a hook clock is running (a hook process, as opposed to the CLI or a test). */
export function hookClockRunning(): boolean {
  return endsAt !== null;
}

/** Stops the clock (a test's: the unit tests share one process, a hook is one). */
export function resetHookClock(): void {
  endsAt = null;
}
