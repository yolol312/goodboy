// The output boundary of the sandbox commands (track M, M6a; plan §19): what text may leave a
// `sandbox-*` command when the project holds real data. A sandbox that restored a real dump has
// personal data in its database, in the app's log and in what the suites print; the model sees
// what the commands print, so in real-data mode no text that a suite, the app, the database,
// docker or the probe produced leaves goodboy. Only a fixed code from one list does.
//
// One object decides: `boundary(realData)`, held once in `Ctx.out`. Every place that would print
// foreign text asks it (`text`, `tail`, `why`, `fail`, `err`), and every other choice that depends on
// the mode is a named capability of it (`appLogs`, `hostCopies`, `reportRef`), so no call site tests
// the mode itself. A string that goodboy formed from its own facts (a service name of the compose
// file, a URL it built, a fixed sentence) is not foreign and needs no help.
//
// The threat model is accidental leaks into model-visible output, records and git content; a
// model that writes a program to exfiltrate data on purpose is out of scope (plan §19, M6).

import type { Bounded } from './bounded';
import type { SandboxLocal } from './sandbox-types';

/** The diagnostic codes of a real-data run: the only text a failure leaves behind. */
export const DIAG_CODES = [
  'step-failed', // a suite step (`unit`, `e2e`) of `sandbox-run` exited non-zero: the `diagnostic` of that step and of the result (a timeout is `timed-out`)
  'timed-out',
  'restore-failed', // the database restore
  'reset-failed', // the database reset from its template
  'proxy-failed',
  'app-failed', // the app could not be started or stopped
  'app-down', // the app or the proxy did not answer
  'live-failed', // cleaning or truncating the shared /live volume
  'artifacts-not-removed', // raw artifacts that should be gone are still there
  'coverage-failed',
  'data-failed', // a `sandbox-data` operation: the query, the container or the answer's shape (M6b); the op's name only
  'data-refused', // a `sandbox-data` input that is not allowed, or a refused `data.json`: the field and a fixed reason, never the value (M6b, M6c)
  'data-resolve-failed', // the run's resolve step (M6c): the query, the container or the answer's shape; the statement's fixed reason (`schema`, `matches-timeout`, `write`, `too-large`, ...) only
  'data-collision', // a generator's reserved space is already used by the dump (M6c): the generator's path only
  'volume-failed', // reading or writing a sandbox volume through the reader container
  'privacy-review-missing', // a real-data run without a passing data-privacy review of the setup and the source files that use the data helper (M6g): the files, as relative paths
  'privacy-setup-unreadable', // the privacy setup could not be listed in full: git, a cap or an unreadable file (M6g)
  'sweep-failed', // the expiry sweep of old raw artifacts
  'registry-failed', // the user-level registry of real-data sandboxes could not be read or written (M6b)
  'docker-failed', // any other docker call that failed
  'check-failed', // a finding of sandbox-check that names a container or a network
  'internal', // an exception inside goodboy: only the text `internal (<class>)` of `err` says it, never a `diagnostic`
  'withheld', // text that is not a failure but may hold foreign words (a restore or coverage note)
] as const;
export type DiagCode = (typeof DIAG_CODES)[number];

/** What replaces the text of a failed step in real-data mode. */
export interface Diag {
  code: DiagCode;
  step: string;
  exit?: number | null;
  timedOut?: boolean;
  /** `data-refused`, `data-collision`: the input field that was refused (`where.and[1].col`, `picks.activeUser.n`), a path goodboy builds. */
  field?: string;
  /** `data-refused`, `data-resolve-failed`, `data-collision`: a fixed reason code. `sweep-failed`: `volume-sweep-skipped`
   *  (the runs volume was not swept because the setup is not safe to start a container in). */
  reason?: string;
}

/** Whether the project holds real data: a dump is set now, or was set once (`realData` is kept
 *  when the dump is removed and cleared only by `sandbox-down --volumes`, which drops the DB
 *  volumes), or an input log is registered (M6b). A local file that says nothing and has a dump
 *  counts: the check fails closed. */
export const realDataOf = (local: SandboxLocal): boolean => local.realData === true || local.dump !== null || (local.inputs?.length ?? 0) > 0;

export interface Boundary {
  /** The mode, for the result file and for the one place that builds the boundary; nothing else branches on it. */
  readonly realData: boolean;
  /** The app's own log may be shown (`sandbox-up --app-logs`). */
  readonly appLogs: boolean;
  /** The host keeps copies of the raw output, the access log and the Playwright report next to result.json. */
  readonly hostCopies: boolean;
  /** What `playwrightReport` of result.json holds: the host copy's path, or the marker of the volume when there is no copy. */
  reportRef(hostPath: string, marker: string): string;
  /** `raw` outside real-data mode, else the fixed `code` (with the step in brackets when given). */
  text(raw: string, code: DiagCode, step?: string): string;
  /** The output tail of a failed step (a passing one prints nothing): '' in real-data mode. */
  tail(b: Bounded, maxChars: number): string;
  /** Why a docker call failed: its own words outside real-data mode, else a code (`timed-out`
   *  for a call that ran out of time). */
  why(b: Bounded, code: DiagCode): string;
  /** A failed docker step: its note (as `why`) and, in real-data mode, its diagnostic, from one code. */
  fail(b: Bounded, code: DiagCode, step: string): { note: string; diagnostic?: Diag };
  /** The diagnostic of a step that failed without a docker call, in real-data mode; undefined otherwise. */
  diag(code: DiagCode, step: string): Diag | undefined;
  /** An exception: its message outside real-data mode, else `internal` with the error class. */
  err(prefix: string, e: unknown): string;
}

const rawWhy = (b: Bounded): string => (b.error ?? (b.timedOut ? 'timed out' : (b.stderr || b.stdout).trim().slice(-400))) || `exit ${b.code}`;

/** The error class name when it is a plain identifier, else `Error`: never text of the message. */
const className = (e: unknown): string => {
  const n = e instanceof Error ? e.constructor?.name : undefined;
  return typeof n === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(n) ? n : 'Error';
};

export function boundary(realData: boolean): Boundary {
  const why = (b: Bounded, code: DiagCode): string => (realData ? (b.timedOut ? 'timed-out' : code) : rawWhy(b));
  return {
    realData,
    appLogs: !realData,
    hostCopies: !realData,
    reportRef: (hostPath, marker) => (realData ? marker : hostPath),
    text: (raw, code, step) => (realData ? (step === undefined ? code : `${code} (${step})`) : raw),
    tail(b, maxChars) {
      if (realData) return '';
      return b.code === 0 && !b.timedOut && b.error === undefined ? '' : (b.stdout + (b.stderr ? '\n' + b.stderr : '')).slice(-maxChars);
    },
    why,
    fail: (b, code, step) => ({ note: why(b, code), ...(realData ? { diagnostic: { code: b.timedOut ? 'timed-out' : code, step, exit: b.code, timedOut: b.timedOut } as Diag } : {}) }),
    diag: (code, step) => (realData ? { code, step } : undefined),
    err: (prefix, e) => (realData ? `${prefix}: internal (${className(e)})` : `${prefix}: ${e instanceof Error ? e.message : String(e)}`),
  };
}

/** The boundary that never withholds: the preparation step has network access and never sees
 *  the dump (`sandbox-prepare` is outside real-data handling, plan §19 M6a), so its tails stay. */
export const OPEN: Boundary = boundary(false);
