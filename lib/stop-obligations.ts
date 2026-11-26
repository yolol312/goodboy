// (N8, plan §20.11) One Stop block for every known unmet obligation.
//
// The Stop's gates used to block one at a time: a test block hid the docs and review gates behind it, so meeting one
// obligation uncovered the next, one Stop each (one field requirement took 26 blocks, plan §20.1). Now every gate the
// Stop runs adds its unmet obligation to one list, and one block names them all, each with a stable id (an obligation
// keeps its id across Stops until it is met) and the smallest rerun plan: the order that meets them all with one run
// of each kind (the fixes, one test run, the docs, one review plan last, since an edit after a review makes it stale).

/** Stable ids, one per rule kind. A gate whose rules already collect their gaps (the test gate) is one id. */
export type ObligationId =
  | 'validation'
  | 'claim'
  | 'start.incomplete'
  | 'sweep'
  | 'state'
  | 'start.unknown'
  | 'checkout'
  | 'test'
  | 'docs'
  | 'review.missing'
  | 'review.invalid'
  | 'review.high'
  | 'review.assumptions'
  | 'review.dimensions'
  | 'review.weakened';

export interface Obligation {
  id: ObligationId;
  /** The gate's name, as the gate log, the user's marker notice and the block counter name it. */
  gate: string;
  /** The gate's own text: what is unmet and how to meet it. */
  reason: string;
  /** This gate's blocks in a row, this one included. */
  count: number;
  /** No evidence can end it (the start, sweep and state gates): the reason says what can. */
  userOnly?: boolean;
  /** The env switch that turns the gate off, named in the user's notice ('' or absent: none). */
  envSwitch?: string;
}

/** The plan's phases in the order to act. The type check below keeps every id in at least one; an id belongs to the
 *  first phase that lists it, and each is listed once. */
const PHASES = [
  { ids: ['validation', 'claim'], step: 'fix first: what the validation runs report (an edit runs them again) and the citations the answer gets wrong' },
  { ids: ['start.incomplete', 'sweep', 'state', 'start.unknown'], step: 'tell the user: no evidence ends these, only the user can let this Stop pass' },
  { ids: ['checkout'], step: 'verify the other checkout from inside it' },
  { ids: ['test'], step: 'one test run that covers every test item' },
  { ids: ['docs'], step: 'update or check the stale docs' },
  {
    ids: ['review.missing', 'review.invalid', 'review.high', 'review.assumptions', 'review.dimensions', 'review.weakened'],
    step: 'review last and once: one `review-axes` plan for every review item (fix the high findings before it), since an edit after a review makes it stale',
  },
] as const satisfies readonly { ids: readonly ObligationId[]; step: string }[];
const everyIdPlanned: [Exclude<ObligationId, (typeof PHASES)[number]['ids'][number]>] extends [never] ? true : never = true;
void everyIdPlanned;

const EVIDENCE_TAIL =
  'This gate passes only on its evidence. If you cannot provide it, tell the user what is missing and why; only the user can let this Stop pass.';
const EVIDENCE_TAIL_MANY =
  'These gates pass only on their evidence. If you cannot provide it, tell the user what is missing and why; only the user can let this Stop pass.';

function phaseOf(id: ObligationId): number {
  return PHASES.findIndex((p) => (p.ids as readonly ObligationId[]).includes(id));
}

/** The obligations in plan order, one per id and per text (the first kept: two gates can find the same start
 *  problem). The input order breaks ties, so the gates' own order holds within a phase. */
export function plannedObligations(obs: readonly Obligation[]): Obligation[] {
  const ids = new Set<string>();
  const texts = new Set<string>();
  const kept: Obligation[] = [];
  for (const o of obs) {
    if (ids.has(o.id) || texts.has(o.reason)) continue;
    ids.add(o.id);
    texts.add(o.reason);
    kept.push(o);
  }
  return kept
    .map((o, i) => ({ o, i }))
    .sort((a, b) => phaseOf(a.o.id) - phaseOf(b.o.id) || a.i - b.i)
    .map((x) => x.o);
}

/** The block reason for the obligations (none: ''). One obligation reads as the gate's block always did, with its id
 *  in front; several are numbered in plan order, followed by the rerun plan. */
export function obligationsReason(obs: readonly Obligation[]): string {
  const list = plannedObligations(obs);
  if (list.length === 0) return '';
  const item = (o: Obligation) => `[${o.id}] ${o.reason} (block ${o.count})`;
  if (list.length === 1) {
    const o = list[0]!;
    return o.userOnly ? item(o) : `${item(o)} ${EVIDENCE_TAIL}`;
  }
  const phases = [...new Set(list.map((o) => phaseOf(o.id)))];
  const plan = phases.map((p, i) => `${i + 1}) ${PHASES[p]!.step}`).join('; ');
  return (
    `This Stop has ${list.length} unmet obligations; each keeps its id across Stops until it is met. ` +
    list.map((o, i) => `(${i + 1}/${list.length}) ${item(o)}`).join(' ') +
    ` Smallest rerun plan, in this order: ${plan}.` +
    (list.some((o) => !o.userOnly) ? ` ${EVIDENCE_TAIL_MANY}` : '')
  );
}

/** The gates whose count reached `after`, once each (their highest count), with their env switches, for the user's
 *  notice of how to pass. */
export function noticeGates(obs: readonly Obligation[], after: number): { gate: string; count: number; envSwitch: string }[] {
  const out = new Map<string, { gate: string; count: number; envSwitch: string }>();
  for (const o of plannedObligations(obs)) {
    if (o.count < after) continue;
    const had = out.get(o.gate);
    if (!had || had.count < o.count) out.set(o.gate, { gate: o.gate, count: o.count, envSwitch: o.envSwitch || had?.envSwitch || '' });
  }
  return [...out.values()];
}
