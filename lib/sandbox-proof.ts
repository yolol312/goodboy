// What a sandbox run proves (track M, M4; plan §19): the result of one `sandbox-run`
// (`.goodboy/sandbox/out/<run>/result.json`) read from the repo top without following a link, and
// whether a test record's `sandbox: {run}` claim stands on it. Kept apart from lib/sandbox-files.ts
// so the Stop hook can load it without the sandbox renderer; backfill-mark (lib/test-backfill.ts)
// and the Stop's sandbox-file rule (lib/sandbox-gate.ts) use the same code.

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DOC_BYTES, readRegular } from './safe-read';
import { RUN_NAME } from './sandbox-mode';
import type { TestResult } from './types';

export const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Whether `base/parts…` exists with no link on the way (each part below `base` is looked at with
 *  lstat) and the last part is a regular file, or a directory with `last: 'dir'`. */
export function noLinksUnder(base: string, parts: readonly string[], last: 'file' | 'dir'): boolean {
  if (parts.length === 0) return false;
  try {
    let cur = base;
    for (const [i, part] of parts.entries()) {
      cur = join(cur, part);
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || (i < parts.length - 1 || last === 'dir' ? !st.isDirectory() : !st.isFile())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** What a record needs from the result of one `sandbox-run`. */
export interface RunProof {
  /** The run's directory name, which is also the `ts` inside its result. */
  run: string;
  /** SHA-256 of `result.json` as read. */
  sha256: string;
  exit: number | null;
  command: string[];
  /** `unit`, `e2e` or `all`: what the run ran (null in a result that does not say). */
  suite: string | null;
  /** What the e2e step of the run did, from the `e2e` object and the Playwright report path of its
   *  result.json; null when the run has no `e2e` step (a unit-only run, or `--suite all` where
   *  the project has no e2e tests). The requested `suite` alone does not say the step ran. */
  e2e: { exit: number | null; timedOut: boolean; report: boolean } | null;
  check: { inner_only: boolean; egress_blocked: boolean; hosts_to_dummies: boolean };
  /** Whether the run held real data (M6a writes `realData`); a result with no such field is from before M6a and
   *  counts as real data (fail closed). Records of such a run keep no display text (M6d). */
  realData: boolean;
}

/** The result of a sandbox run (`out/<run>/result.json`), read from the repo top without
 *  following a link (not the file, not a directory above it), or an Error saying what is wrong.
 *  The check flags a record carries come from here, never from the agent. */
export function readRunResult(root: string, run: string): RunProof | Error {
  // never echoes what it was given: a wrong value may be text the model copied from somewhere sensitive (M6a)
  if (!RUN_NAME.test(run)) return new Error("sandbox.run must be the run's directory name (like 20261022T031816Z)");
  const dirParts = ['.goodboy', 'sandbox', 'out', run];
  const cur = join(root, ...dirParts);
  if (!noLinksUnder(root, dirParts, 'dir')) return new Error(`${cur} does not exist, or it or a directory above it is a link: no sandbox-run wrote run ${run} in this repository`);
  const p = join(cur, 'result.json');
  const r = readRegular(p, MAX_DOC_BYTES, true);
  if (r === 'absent') return new Error(`${p} does not exist: the run ${run} wrote no result`);
  if (r === 'refused') return new Error(`${p} is not a regular file of at most ${MAX_DOC_BYTES} bytes`);
  try {
    const j = JSON.parse(r.text) as Record<string, unknown>;
    const c = j.check as Record<string, unknown> | null | undefined;
    const exit = j.exit;
    if (
      typeof j === 'object' &&
      j !== null &&
      j.ts === run &&
      typeof c === 'object' &&
      c !== null &&
      typeof c.inner_only === 'boolean' &&
      typeof c.egress_blocked === 'boolean' &&
      typeof c.hosts_to_dummies === 'boolean' &&
      (exit === null || typeof exit === 'number') &&
      isStrings(j.command)
    ) {
      const e = j.e2e;
      const e2e = typeof e === 'object' && e !== null ? { exit: typeof (e as { exit?: unknown }).exit === 'number' ? ((e as { exit: number }).exit) : null, timedOut: (e as { timedOut?: unknown }).timedOut === true, report: typeof j.playwrightReport === 'string' } : null;
      return { run, sha256: sha(r.text), exit: exit as number | null, command: j.command as string[], suite: typeof j.suite === 'string' ? j.suite : null, e2e, realData: j.realData !== false, check: { inner_only: c.inner_only, egress_blocked: c.egress_blocked, hosts_to_dummies: c.hosts_to_dummies } };
    }
  } catch {
    // below
  }
  return new Error(`${p} is not a result goodboy's sandbox-run wrote (it needs ts equal to the run, a check with three booleans, exit and command)`);
}

/** The start of a sandbox run (its directory name is a UTC timestamp to the second). */
export function runStart(run: string): number {
  const m = RUN_NAME_PARTS.exec(run)!;
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

/** Whether a run counts for a file last changed at `editMs`: it started in or after the second of
 *  the change (the run's name has second granularity). A run before the last edit proves nothing
 *  about the file. */
export function runStartsAfter(run: string, editMs: number): boolean {
  return Math.floor(runStart(run) / 1000) >= Math.floor(editMs / 1000);
}

/** Whether the run's e2e step ran, exited 0 within its time and wrote a Playwright report: the
 *  evidence that a browser suite exercised the e2e-only sandbox files. */
export function e2ePassed(proof: RunProof): boolean {
  return proof.e2e !== null && proof.e2e.exit === 0 && !proof.e2e.timedOut && proof.e2e.report;
}
const RUN_NAME_PARTS = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** The run a record's sandbox claim stands on, or why it does not hold: all three check flags
 *  true in the record, a run and the hash of its result.json, and that file read again now
 *  (no link) with the same hash, the same three flags true, exit 0, made before the record. */
export function sandboxProof(root: string, r: TestResult): RunProof | string {
  const sb = r.sandbox;
  if (!(sb?.inner_only === true && sb.egress_blocked === true && sb.hosts_to_dummies === true)) return 'the record lacks sandbox flags inner_only, egress_blocked and hosts_to_dummies all true';
  if (typeof sb.run !== 'string' || typeof sb.result_sha256 !== 'string') return 'the record names no run or result hash (record with sandbox: {run})';
  const proof = readRunResult(root, sb.run);
  if (proof instanceof Error) return proof.message;
  if (proof.sha256 !== sb.result_sha256) return `result.json of run ${sb.run} changed after the record`;
  if (!proof.check.inner_only || !proof.check.egress_blocked || !proof.check.hosts_to_dummies) return `run ${sb.run} did not pass its sandbox check`;
  if (proof.exit !== 0) return `run ${sb.run} did not exit 0`;
  if (runStart(sb.run) > Date.parse(r.timestamp)) return `run ${sb.run} is later than the record`;
  return proof;
}
