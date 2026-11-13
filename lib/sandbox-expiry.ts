// When the raw artifacts of a sandbox run expire (track M, M6a; plan §19): the state of a run on the
// host (`out/<ts>/state.json`), the time to live, and which runs the sweep removes. Pure decisions;
// lib/sandbox-store.ts does the reading and removing.

import { RUN_NAME, runStart } from './sandbox-proof';

export const MAX_TTL_HOURS = 24;
/** A run name or a start time that many ms ahead of the clock is no honest start (a clock moved
 *  back, or an edited file): the run counts as expired. */
const CLOCK_SLACK_MS = 3_600_000;
export type RunStatus = 'running' | 'passed' | 'failed';

/** `out/<ts>/state.json`: written when a run starts and when it ends. */
export interface RunState {
  status: RunStatus;
  started: string;
  finished?: string;
}

/** A state file's text, or null when it is not one goodboy wrote (the caller then goes by the run's name). */
export function parseState(text: string): RunState | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown> | null;
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
    if (j.status !== 'running' && j.status !== 'passed' && j.status !== 'failed') return null;
    if (typeof j.started !== 'string') return null;
    if (j.finished !== undefined && typeof j.finished !== 'string') return null;
    return { status: j.status, started: j.started, ...(typeof j.finished === 'string' ? { finished: j.finished } : {}) };
  } catch {
    return null;
  }
}

/** How long a failing or crashed run's raw artifacts live, from `GOODBOY_SANDBOX_RAW_TTL_HOURS`: the
 *  environment may lower it, never raise it above 24 hours; anything that is not a positive number is 24. */
export function rawTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GOODBOY_SANDBOX_RAW_TTL_HOURS?.trim();
  const h = raw === undefined || raw === '' ? NaN : Number(raw);
  const hours = Number.isFinite(h) && h > 0 ? Math.min(h, MAX_TTL_HOURS) : MAX_TTL_HOURS;
  return hours * 3_600_000;
}

/** When a run started, as far as expiry may trust: the older of the state's `started` and the time in
 *  the run's name (goodboy wrote both, and a host file can be edited, so neither alone decides). A
 *  `started` ahead of the clock is ignored for the name's time; a name ahead of the clock, or a time
 *  that does not parse, gives NaN: such a run counts as expired. */
export function runStartedAt(run: string, state: RunState | null, now: number): number {
  if (!RUN_NAME.test(run)) return NaN;
  const named = runStart(run);
  if (!Number.isFinite(named) || named > now + CLOCK_SLACK_MS) return NaN;
  const said = state === null ? NaN : Date.parse(state.started);
  if (state !== null && !Number.isFinite(said)) return NaN;
  return state === null || said > now ? named : Math.min(said, named);
}

/** Which entries of the runs volume the sweep removes: a name that is no run's, a run whose host
 *  state says `passed`, a `failed` or `running` one that started more than `ttlMs` ago, and one with
 *  no readable state that is older than `ttlMs` by the time in its name. Raw artifacts do not wait on
 *  a broken clock (`runStartedAt`). */
export function sweepVictims(names: readonly string[], stateOf: (run: string) => RunState | null, now: number, ttlMs: number): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!RUN_NAME.test(n)) {
      out.push(n);
      continue;
    }
    const st = stateOf(n);
    if (st?.status === 'passed') {
      out.push(n);
      continue;
    }
    const started = runStartedAt(n, st, now);
    if (!Number.isFinite(started) || now - started > ttlMs) out.push(n);
  }
  return out;
}

/** Whether `run` is in progress: its state says `running` and it is not expired. The sweep leaves the
 *  shared scratch volumes alone while one exists. */
export function isLiveRun(run: string, state: RunState | null, now: number, ttlMs: number): boolean {
  if (state?.status !== 'running') return false;
  const started = runStartedAt(run, state, now);
  return Number.isFinite(started) && now - started <= ttlMs;
}
