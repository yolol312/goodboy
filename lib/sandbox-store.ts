// The client of the sandbox's volumes of raw artifacts (track M, M6a; plan §19): the calls to the
// `reader` service (lib/sandbox-volumes.ts has its scripts), the counts read from the JUnit files,
// the state of a run on the host, and the expiry sweep. It needs only a context that can run a
// compose command, so lib/sandbox-run.ts hands it its `Ctx`. What the reader prints is parsed in
// memory under a byte budget and never printed.

import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Bounded } from './bounded';
import type { Boundary, Diag } from './sandbox-boundary';
import { isLiveRun, parseState, type RunState, rawTtlMs, sweepVictims } from './sandbox-expiry';
import { writeAtomic } from './sandbox-files';
import { HOST_RAW_NAMES, RUN_NAME } from './sandbox-mode';
import { noLinksUnder } from './sandbox-proof';
import { readRegular } from './safe-read';
import { MAX_JUNIT_BYTES, MAX_JUNIT_FILES, parseJUnit, type UnitSummary } from './sandbox-summary';
import {
  CLEAR_DATA_SCRIPT,
  E2E_AFTER_SCRIPT,
  E2E_READ_TOTAL,
  FINISH_SCRIPT,
  type FileRead,
  frameBudget,
  JUNIT_READ_TOTAL,
  LIST_SCRIPT,
  MAX_READ_BYTES,
  META_KEY_SCRIPT,
  parseFrames,
  parseMetaKey,
  parseNames,
  READ_SCRIPT,
  readerArgv,
  UNIT_AFTER_SCRIPT,
  wroteLog,
} from './sandbox-volumes';

export interface DockOpts {
  keep?: 'head' | 'tail';
  stdin?: string;
  max?: { stdout: number; stderr: number };
  onSpawn?: (kill: (s: 'SIGTERM' | 'SIGKILL') => void) => void;
}

/** What the volume client needs of a project: where its sandbox dir is, the boundary, a compose call. */
export interface StoreCtx {
  dir: string;
  out: Boundary;
  /** The strict mode comes from a docker that did not answer, not from the local file, a dump or a database
   *  volume: the sweep then leaves the host's raw files alone (they may be a plain project's output). */
  keepHostRaw?: boolean;
  comp(args: string[], timeoutMs: number, o?: DockOpts): Promise<Bounded>;
}

const CALL_MS = 180_000;
const LONG_CALL_MS = 300_000;

/** The diagnostic of a sweep that failed. */
export const SWEEP_FAILED: Diag = { code: 'sweep-failed', step: 'sweep' };

/** One call of the `reader` service: a script of lib/sandbox-volumes.ts, its arguments, an optional
 *  stdin; `totalBytes` is the budget the script keeps, which caps what the host captures. */
export function reader(ctx: Pick<StoreCtx, 'comp'>, script: string, args: string[], o: { stdin?: string; totalBytes?: number; timeoutMs?: number } = {}): Promise<Bounded> {
  return ctx.comp(['run', '--rm', '-T', '--no-deps', ...readerArgv(script, args)], o.timeoutMs ?? CALL_MS, {
    max: { stdout: o.totalBytes === undefined ? 1024 * 1024 : frameBudget(o.totalBytes), stderr: 64 * 1024 },
    ...(o.stdin !== undefined ? { stdin: o.stdin } : {}),
  });
}

const ended = (r: Bounded): boolean => r.code === 0 && r.stdout.split('\n').includes('@@END');

/** The files (absolute paths inside the reader) as read, each up to `maxBytes` and all within `totalBytes`; null when the call failed. */
export async function readFiles(ctx: StoreCtx, paths: string[], maxBytes: number, totalBytes: number = maxBytes): Promise<{ files: Map<string, FileRead>; partial: boolean } | null> {
  const r = await reader(ctx, READ_SCRIPT, [String(maxBytes), String(totalBytes), ...paths], { totalBytes, timeoutMs: LONG_CALL_MS });
  return r.code === 0 ? parseFrames(r.stdout) : null;
}

/** `clear` the scratch volumes (the access log, e2e coverage data, test output dirs) too, and remove the
 *  run dirs `names` from the runs volume, in one call; true when it ran to its end. */
export async function finish(ctx: StoreCtx, names: string[], clear: boolean): Promise<{ ok: boolean; call: Bounded }> {
  const call = await reader(ctx, FINISH_SCRIPT, [clear ? 'clear' : 'keep', ...names]);
  return { ok: ended(call), call };
}

/** Empties the `data` volume (the resolved values of M6c) right after the suites; true when it ran to its end. */
export async function clearData(ctx: Pick<StoreCtx, 'comp'>): Promise<boolean> {
  return ended(await reader(ctx, CLEAR_DATA_SCRIPT, [], { timeoutMs: 60_000 }));
}

/** The handle key of the sandbox (M6b): the one in the `meta` volume, or `candidate` (64 hex digits goodboy made) written
 *  there first when there is none. The key is returned for the length of one call and never written to the host. */
export async function metaKey(ctx: Pick<StoreCtx, 'comp'>, candidate: string): Promise<string | null> {
  const r = await reader(ctx, META_KEY_SCRIPT, [], { stdin: `${candidate}\n`, totalBytes: 4096, timeoutMs: 60_000 });
  return r.code === 0 ? parseMetaKey(r.stdout) : null;
}

/** The entries of the runs volume, or null when the call failed. */
export async function listRuns(ctx: StoreCtx): Promise<string[] | null> {
  const r = await reader(ctx, LIST_SCRIPT, []);
  return r.code === 0 ? parseNames(r.stdout, '@@E') : null;
}

type Counts = Pick<UnitSummary, 'suites' | 'truncated' | 'partial' | 'skipped_files' | 'counts' | 'unreadable'>;

/** The counts of the JUnit files a reader call returned. A file the reader would not read (over the
 *  per-file cap, not a regular file) is left out and counted; one that is not JUnit makes the counts
 *  `unreadable`; a JVM run with no file at all says `counts: 'missing'` (any other runner has exit and
 *  duration only). */
export function junitCounts(frames: { files: Map<string, FileRead>; partial: boolean } | null, jvm: boolean): Counts {
  if (frames === null) return { unreadable: true };
  const texts: string[] = [];
  let skipped = 0;
  for (const v of frames.files.values()) {
    if (v.kind === 'text') texts.push(v.text);
    else skipped++;
  }
  const flags: Counts = { ...(skipped > 0 ? { skipped_files: skipped } : {}), ...(frames.partial ? { partial: true as const } : {}) };
  if (frames.files.size === 0) return jvm ? { counts: 'missing', ...flags } : flags;
  if (texts.length === 0) return { suites: [], ...flags };
  const p = parseJUnit(texts);
  if (p === 'unreadable') return { unreadable: true, ...flags };
  return { suites: p.suites, ...flags, ...(p.truncated || frames.files.size >= MAX_JUNIT_FILES ? { truncated: true as const } : {}) };
}

/** After the unit step, one call: the step's output becomes the run's `output.log` in the volume, and the JUnit
 *  files of the output dirs are read for their counts. */
export async function unitAfter(ctx: StoreCtx, ts: string, log: string, jvm: boolean): Promise<{ wrote: boolean; counts: Counts }> {
  if (!RUN_NAME.test(ts)) return { wrote: false, counts: { unreadable: true } };
  const r = await reader(ctx, UNIT_AFTER_SCRIPT, [ts, String(MAX_JUNIT_BYTES), String(JUNIT_READ_TOTAL), String(MAX_JUNIT_FILES)], { stdin: log, totalBytes: JUNIT_READ_TOTAL, timeoutMs: LONG_CALL_MS });
  return { wrote: r.code === 0 && wroteLog(r.stdout), counts: junitCounts(r.code === 0 ? parseFrames(r.stdout) : null, jvm) };
}

export interface E2eAfter {
  wrote: boolean;
  files: Map<string, FileRead>;
  partial: boolean;
  /** The run left `e2e-artifacts` (traces and screenshots) and, with `remove`, it is still there. */
  present: boolean;
  left: boolean;
}

/** After the e2e step, one call: its output becomes `e2e-output.log`, the Playwright report and the access
 *  log are read (within one budget), and the run's `e2e-artifacts` is looked up and, with `remove`, removed. Null
 *  when the call failed. */
export async function e2eAfter(ctx: StoreCtx, ts: string, log: string, remove: boolean): Promise<E2eAfter | null> {
  if (!RUN_NAME.test(ts)) return null;
  const r = await reader(ctx, E2E_AFTER_SCRIPT, [ts, String(MAX_READ_BYTES), String(E2E_READ_TOTAL), remove ? 'rm' : 'keep'], { stdin: log, totalBytes: E2E_READ_TOTAL, timeoutMs: LONG_CALL_MS });
  const frames = r.code === 0 ? parseFrames(r.stdout) : null;
  if (frames === null) return null;
  const names = parseNames(r.stdout, '@@P') ?? [];
  return { wrote: wroteLog(r.stdout), files: frames.files, partial: frames.partial, present: names.includes('present'), left: names.includes('left') };
}

// ---- the state of a run on the host ----

export function readRunState(dir: string, run: string): RunState | null {
  if (!RUN_NAME.test(run)) return null;
  const r = readRegular(join(dir, 'out', run, 'state.json'), 4096, true);
  return typeof r === 'object' ? parseState(r.text) : null;
}

export const writeState = (outDir: string, st: RunState): void => writeAtomic(join(outDir, 'state.json'), `${JSON.stringify(st)}\n`);

/** The raw files that runs before M6a (and non-real-data runs) left next to result.json, and the old
 *  `out/live` bind dir: gone in real-data mode, where the host keeps no raw copy. Nothing is touched unless
 *  every part of the path from the project top (`dir` is `<top>/.goodboy/sandbox`) down to `out/` is a real
 *  directory; links inside are removed, not followed. Each entry goes on its own: one that cannot be removed
 *  (a root-owned leftover, a read-only dir, a race with another command) is counted, and the others still go.
 *  Returns how many entries could not be removed. Known limit (plan §19 M6b): the link check of the path and the
 *  removal are two steps, so a process that swaps a directory of the path for a link in between can send a removal
 *  elsewhere. */
function removeHostRaw(dir: string): number {
  const top = join(dir, '..', '..');
  if (!noLinksUnder(top, ['.goodboy', 'sandbox', 'out'], 'dir')) return 0;
  const out = join(dir, 'out');
  let names: string[];
  try {
    names = readdirSync(out);
  } catch {
    return 0;
  }
  let failed = 0;
  const rm = (p: string): void => {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      failed++;
    }
  };
  for (const n of names) {
    const p = join(out, n);
    if (n === 'live') {
      rm(p);
      continue;
    }
    try {
      if (!RUN_NAME.test(n) || !lstatSync(p).isDirectory()) continue;
    } catch {
      failed++;
      continue;
    }
    for (const f of HOST_RAW_NAMES) rm(join(p, f));
  }
  return failed;
}

/** Whether a run is in progress on this host, by the states in `out/`. */
function anyLiveRun(dir: string, now: number, ttlMs: number): boolean {
  try {
    return readdirSync(join(dir, 'out')).some((n) => RUN_NAME.test(n) && isLiveRun(n, readRunState(dir, n), now, ttlMs));
  } catch {
    return false;
  }
}

/** The expiry sweep (M6a): the raw artifacts of runs in the runs volume are removed when the run passed,
 *  or failed or crashed more than the TTL ago (24 h at most, `GOODBOY_SANDBOX_RAW_TTL_HOURS` may lower
 *  it), or has no state and is that old by its name, and so is any foreign entry. When the last run dir
 *  goes, and no run is in progress, the scratch volumes are cleared too. Where the host keeps no raw copy
 *  (real-data mode), old raw files on the host go as well. Never throws; null when it did its work or
 *  had nothing to do, else the diagnostic. `volume` says the caller has checked that the runs volume exists
 *  and that the daemon and the compose file are safe; without it only the host files are looked at. */
export async function sweepRaw(ctx: StoreCtx, volume: boolean): Promise<Diag | null> {
  try {
    // a host file that cannot be removed is a failed sweep in the end, but never stops the sweep of the volume
    const hostFailed = ctx.out.hostCopies || ctx.keepHostRaw === true ? 0 : removeHostRaw(ctx.dir);
    if (!volume) return hostFailed > 0 ? SWEEP_FAILED : null;
    const names = await listRuns(ctx);
    if (names === null) return SWEEP_FAILED;
    const now = Date.now();
    const ttl = rawTtlMs();
    const victims = sweepVictims(names, (run) => readRunState(ctx.dir, run), now, ttl);
    if (victims.length > 0) {
      const last = victims.length === names.length && !anyLiveRun(ctx.dir, now, ttl);
      if (!(await finish(ctx, victims, last)).ok) return SWEEP_FAILED;
    }
    return hostFailed > 0 ? SWEEP_FAILED : null;
  } catch {
    return SWEEP_FAILED;
  }
}
