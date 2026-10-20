// Friction notice at Stop (track J3, issue #11, plan §16). When goodboy's own records show that
// goodboy went wrong or cost too much in this session, the user is told once, in Korean, and
// pointed to /report-goodboy. It reads only what goodboy records (the gate log, the Stop
// gates' block counters, the dispatch and edit logs, the GOODBOY_* switches each Stop sees),
// asks the model nothing, injects nothing and never blocks. Free-form improvement ideas are
// out: the user runs the skill for those.
//
// Signals:
//   - hook-error: a hook caught an error (lib/gate-log.ts hookError);
//   - fail-open: a gate could not decide and let the call pass, except the routine waits on
//     Claude Code's transcript (ROUTINE_FAIL_OPEN);
//   - repeated-block: a Stop gate blocked REPEAT_BLOCKS times in a row (its block counter).
//     PreToolUse denies do not count: in real sessions they are mostly the model's own
//     mistakes that the gate corrects (J3 review: 3 of 4 sessions would have shown it);
//   - over-budget: verification beyond the budget of a document change (I1b): a review run
//     longer than DOC_REVIEW_BUDGET_MINUTES, or any test run;
//   - user-override: the user's one-use Stop marker let a blocking gate pass;
//   - switched-off: a GOODBOY_* switch that was not `off` at the session's first Stop is now.
//
// env GOODBOY_FRICTION_NOTICE=off|on: off everywhere, or on also in goodboy's own repo (off
// there by default, where the maintainer triages instead).

import { closeSync, constants, fstatSync, ftruncateSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOC_REVIEW_BUDGET_MINUTES, isDocumentChange } from './doc-verification';
import { inGoodboyRepo } from './field-report';
import { ensureSessionDir, getEditTimeline } from './file-tracker';
import { type GateEvent, readGateLog } from './gate-log';
import { readRetryCount } from './retry-counter';
import { MAX_STATE_BYTES, readRegular } from './safe-read';
import { LEGACY_AGENTS, ROLES } from './routing-policy';
import { type DispatchRecord, readDispatchLog } from './spawn-guard';

export type FrictionKind = 'hook-error' | 'fail-open' | 'repeated-block' | 'over-budget' | 'user-override' | 'switched-off';

export interface FrictionSignal {
  kind: FrictionKind;
  /** The gate, hook, agent role or switch it is about. */
  subject: string;
  /** Korean, for the notice. */
  text: string;
}

/** Fail-opens that only wait on Claude Code's transcript flush or on an unsure usage reading:
 *  they happen in healthy sessions (this repo's own session logged over a hundred). */
const ROUTINE_FAIL_OPEN = /^(?:text-flush-lag|limit-unconfident|subagent-transcript-not-found)\b/;

/** Blocks in a row of one Stop gate that count as blocking again and again: the retry limit
 *  the gates had before track G. */
export const REPEAT_BLOCKS = 3;

/** The Stop gates' block counters (session dir files written by hooks/stop.ts) and their
 *  gates. Not the H1-03 compaction latch, which is a notice. */
export const STOP_BLOCK_COUNTERS: Readonly<Record<string, string>> = {
  '.goodboy-retry-count.txt': 'review',
  '.goodboy-review-validate-retry-count.txt': 'review',
  '.goodboy-test-retry-count.txt': 'test',
  '.goodboy-claim-retry-count.txt': 'claim',
  '.goodboy-docs-retry-count.txt': 'docs',
  '.goodboy-validation-retry-count.txt': 'validation',
};

/** Switches that only silence goodboy's own notices; switching them off is no friction. */
const NOTICE_SWITCHES = new Set(['GOODBOY_FRICTION_NOTICE', 'GOODBOY_INBOX_NOTICE']);

const STATE_FILE = 'friction-notice.json';

interface FrictionState {
  /** The GOODBOY_* switches that were `off` at the session's first Stop. */
  switches: string[];
  /** The notice was shown in this session. */
  noticed: boolean;
}

function readState(sessionId: string): FrictionState | null {
  try {
    // A regular file only, not followed through a link: a FIFO here would hang the Stop.
    const r = readRegular(join(ensureSessionDir(sessionId), STATE_FILE), MAX_STATE_BYTES, true);
    if (typeof r === 'string') return null;
    const s = JSON.parse(r.text) as Partial<FrictionState>;
    if (!Array.isArray(s.switches) || typeof s.noticed !== 'boolean') return null;
    return { switches: s.switches.filter((x): x is string => typeof x === 'string'), noticed: s.noticed };
  } catch {
    return null;
  }
}

/** False when the state could not be written. Opened without blocking and never through a
 *  link, and written only into a regular file: a FIFO here would hang the Stop. */
function writeState(sessionId: string, s: FrictionState): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(
      join(ensureSessionDir(sessionId), STATE_FILE),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    if (!fstatSync(fd).isFile()) return false;
    ftruncateSync(fd, 0);
    writeFileSync(fd, JSON.stringify(s) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/** A name from a record, as the notice shows it: a short plain name, else `unknown` (the gate
 *  log is goodboy's, but its text goes to the user as goodboy's own words). */
function shown(name: string): string {
  return /^[\w.:-]{1,40}$/.test(name) ? name : 'unknown';
}

/** The GOODBOY_* switches set to `off` (case and spaces ignored), sorted. */
export function switchesOff(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => /^GOODBOY_[A-Z0-9_]+$/.test(k) && !NOTICE_SWITCHES.has(k) && (env[k] ?? '').trim().toLowerCase() === 'off')
    .sort();
}

/** The agent role of a dispatch's callee (`goodboy:review-all` → `review-all`; pre-G2 names
 *  map to their roles). */
function roleOf(callee: string): string {
  const bare = callee.replace(/^goodboy:/, '');
  return LEGACY_AGENTS[bare] ?? bare;
}

/** Review and test runs of a document change that went past its budget. A run's change is the
 *  files the session edited after the previous run of the same team was dispatched, up to
 *  this one (what the I1b note judges too, the session's edits; a prompt can name a spec
 *  document for a code change). A run with no edit in that window is not judged. */
function overBudget(log: DispatchRecord[], edits: readonly { file: string; t: number }[], root: string, previews: readonly string[]): FrictionSignal[] {
  const agentOf = new Map<string, string>();
  const doneAt = new Map<string, number>();
  for (const r of log) {
    if (r.k === 'launched') agentOf.set(r.tuid, r.agentId);
    if (r.k === 'done') {
      if (r.tuid) doneAt.set(`t:${r.tuid}`, r.t);
      if (r.agentId) doneAt.set(`a:${r.agentId}`, r.t);
    }
  }
  const out: FrictionSignal[] = [];
  const lastOfTeam = new Map<string, number>();
  for (const r of log) {
    if (r.k !== 'dispatch') continue;
    const role = roleOf(r.callee);
    const team = ROLES.find((x) => x.name === role)?.team;
    if (team !== 'review' && team !== 'test') continue;
    const from = lastOfTeam.get(team) ?? -Infinity;
    lastOfTeam.set(team, r.t);
    const files = Array.from(new Set(edits.filter((e) => e.t > from && e.t <= r.t).map((e) => e.file)));
    if (!isDocumentChange(files, root, previews)) continue;
    if (team === 'test') {
      out.push({ kind: 'over-budget', subject: role, text: `문서만 바꾼 변경에 테스트 에이전트(${shown(role)})가 실행됐어요(예산: 테스트 없음)` });
      continue;
    }
    const agent = agentOf.get(r.tuid);
    const end = doneAt.get(`t:${r.tuid}`) ?? (agent ? doneAt.get(`a:${agent}`) : undefined);
    if (end === undefined) continue;
    if (end - r.t > DOC_REVIEW_BUDGET_MINUTES * 60_000) {
      const minutes = Math.ceil((end - r.t) / 60_000);
      out.push({ kind: 'over-budget', subject: role, text: `문서 변경 리뷰(${shown(role)})가 ${minutes}분 걸렸어요(예산 ${DOC_REVIEW_BUDGET_MINUTES}분)` });
    }
  }
  return out;
}

/** Every friction signal in the session's records, in the notice's order (errors first). */
export function frictionSignals(opts: {
  gateLog: GateEvent[];
  dispatchLog: DispatchRecord[];
  /** The session's edits with their times (lib/file-tracker.ts getEditTimeline). */
  edits?: readonly { file: string; t: number }[];
  /** Blocks in a row per Stop gate now (STOP_BLOCK_COUNTERS). */
  blockCounts?: Readonly<Record<string, number>>;
  root: string;
  previews?: readonly string[];
  switchesBefore: readonly string[];
  switchesNow: readonly string[];
}): FrictionSignal[] {
  const out: FrictionSignal[] = [];
  const seen = new Set<string>();
  const add = (s: FrictionSignal) => {
    const key = `${s.kind}:${s.subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const e of opts.gateLog) {
    if (e.gate === 'hook-error') {
      const hook = shown((e.reason ?? '').split(' ')[0] ?? '');
      add({ kind: 'hook-error', subject: hook, text: `goodboy ${hook} 훅에서 오류가 났어요` });
    }
  }
  for (const e of opts.gateLog) {
    if (e.decision === 'fail-open' && e.gate !== 'hook-error' && !ROUTINE_FAIL_OPEN.test(e.reason ?? '')) {
      const gate = shown(e.gate);
      add({ kind: 'fail-open', subject: gate, text: `${gate} 게이트가 판단하지 못하고 통과시켰어요` });
    }
  }
  for (const [gate, n] of Object.entries(opts.blockCounts ?? {})) {
    if (n >= REPEAT_BLOCKS) add({ kind: 'repeated-block', subject: gate, text: `${shown(gate)} 게이트가 ${n}번 연속 막았어요` });
  }
  for (const s of overBudget(opts.dispatchLog, opts.edits ?? [], opts.root, opts.previews ?? [])) add(s);
  for (const e of opts.gateLog) {
    if (e.decision === 'warn' && e.reason === 'user-override') {
      const gate = shown(e.gate);
      add({ kind: 'user-override', subject: gate, text: `승인 마커로 ${gate} 게이트를 넘겼어요` });
    }
  }
  for (const k of opts.switchesNow) {
    if (!opts.switchesBefore.includes(k)) add({ kind: 'switched-off', subject: k, text: `세션 중에 ${k}=off로 바뀌었어요` });
  }
  return out;
}

/** The Korean notice for the first signals. */
export function frictionMessage(signals: readonly FrictionSignal[]): string {
  const more = signals.length > 1 ? ` 외 ${signals.length - 1}건` : '';
  return (
    `[goodboy] 이번 세션에서 goodboy가 매끄럽지 않았던 흔적이 있어요: ${signals[0].text}${more}. ` +
    'goodboy 문제라고 생각되면 /report-goodboy로 리포트를 남길 수 있어요 ' +
    '(세션당 한 번만 알려요. 끄려면 GOODBOY_FRICTION_NOTICE=off).'
  );
}

/** Whether the notice is on here: GOODBOY_FRICTION_NOTICE=off|on, else on outside goodboy's
 *  own repo. */
export function frictionNoticeOn(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GOODBOY_FRICTION_NOTICE ?? '').trim().toLowerCase();
  if (v === 'off') return false;
  if (v === 'on') return true;
  return !inGoodboyRepo(cwd, env);
}

/** At a Stop: the notice once per session when a signal shows, else null. The first Stop
 *  records which switches were off from the start. The notice shows only once its latch is
 *  written, so a state dir that cannot be written never repeats it on every Stop. Never
 *  throws. */
export function frictionNotice(opts: {
  sessionId: string;
  cwd: string;
  root: string;
  previews?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): string | null {
  try {
    const env = opts.env ?? process.env;
    if (!frictionNoticeOn(opts.cwd, env)) return null;
    const now = switchesOff(env);
    const state = readState(opts.sessionId);
    if (state === null) {
      writeState(opts.sessionId, { switches: now, noticed: false });
      // The first Stop still checks the records: a hook may have failed before it.
    } else if (state.noticed) {
      return null;
    }
    const before = state?.switches ?? now;
    const blockCounts: Record<string, number> = {};
    for (const [file, gate] of Object.entries(STOP_BLOCK_COUNTERS)) {
      blockCounts[gate] = Math.max(blockCounts[gate] ?? 0, readRetryCount(opts.sessionId, file));
    }
    const signals = frictionSignals({
      gateLog: readGateLog(opts.sessionId),
      dispatchLog: readDispatchLog(opts.sessionId),
      edits: getEditTimeline(opts.sessionId),
      blockCounts,
      root: opts.root,
      previews: opts.previews,
      switchesBefore: before,
      switchesNow: now,
    });
    if (signals.length === 0) return null;
    if (!writeState(opts.sessionId, { switches: before, noticed: true })) return null;
    return frictionMessage(signals);
  } catch {
    return null;
  }
}
