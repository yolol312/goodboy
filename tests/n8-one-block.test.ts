// N8 (plan §20.11): one Stop block for every unmet obligation, with stable ids and the smallest rerun plan.
//
//   1. lib/stop-obligations.ts: dedupe by id and by text, plan order, the one-item and the many-item text,
//      noticeGates (highest count per gate, env switches).
//   2. The real Stop hook, spawned (hooks/stop.ts is coverage-exempt, plan P5, so its behavior is proved here):
//      several obligations in one block, the review accepted only with nothing else pending, the review checks
//      each an item, the gates that end the judging, the agent deferrals.
//   3. endDeferralWait (lib/agent-deferral.ts): the clock per wait.
//   4. test-write refuses a coverage.changed entry that lacks files, in_report, diff_lines or base.
//
// Projects, session dirs and records are temporary. Every spawned Stop runs with the test, docs and claim gates off
// unless the case turns the one under test on.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AGENT_DEFERRAL_CAP_MS, DEFERRAL_FILE, deferralOpen, endDeferralWait, runningAgents } from '../lib/agent-deferral';
import { approvalMarkerRelPath } from '../lib/approval-marker';
import { validateTestResultInput } from '../lib/cli';
import { pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import { readReviewCursor } from '../lib/review-cursor';
import { readHabitState } from '../lib/token-habits';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';
import { noticeGates, obligationsReason, plannedObligations, type Obligation, type ObligationId } from '../lib/stop-obligations';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-n8-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `n8${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const sessionDir = (s: string): string => join(tmpdir(), `goodboy-session-${s}`);

// ── 1. lib/stop-obligations.ts ──────────────────────────────────────────────────────────────────────

const ob = (id: ObligationId, extra: Partial<Obligation> = {}): Obligation => ({ id, gate: id.split('.')[0]!, reason: `text of ${id}`, count: 1, ...extra });

describe('plannedObligations', () => {
  test('puts the obligations in plan order (fixes, the user\'s part, checkout, test, docs, review) whatever order the gates found them in', () => {
    const all: ObligationId[] = ['review.weakened', 'docs', 'review.high', 'test', 'checkout', 'state', 'claim', 'review.missing', 'validation', 'sweep', 'start.incomplete', 'start.unknown', 'review.invalid', 'review.assumptions', 'review.dimensions'];
    const got = plannedObligations(all.map((id) => ob(id))).map((o) => o.id);
    // The phases come in plan order; inside a phase the input order holds (the gates' own order).
    expect(got.slice(0, 2).sort()).toEqual(['claim', 'validation']);
    expect(got.slice(2, 6).sort()).toEqual(['start.incomplete', 'start.unknown', 'state', 'sweep']);
    expect(got.slice(6)).toEqual(['checkout', 'test', 'docs', 'review.weakened', 'review.high', 'review.missing', 'review.invalid', 'review.assumptions', 'review.dimensions']);
  });

  test('inside one phase the gates\' own order holds', () => {
    expect(plannedObligations([ob('review.invalid'), ob('review.high'), ob('review.assumptions')]).map((o) => o.id)).toEqual(['review.invalid', 'review.high', 'review.assumptions']);
    expect(plannedObligations([ob('claim'), ob('validation')]).map((o) => o.id)).toEqual(['claim', 'validation']);
    expect(plannedObligations([ob('validation'), ob('claim')]).map((o) => o.id)).toEqual(['validation', 'claim']);
  });

  test('keeps one obligation per id (the first) and one per text (two gates found the same start problem)', () => {
    const got = plannedObligations([
      ob('test', { reason: 'first' }),
      ob('test', { reason: 'second' }),
      ob('start.incomplete', { reason: 'same start problem', gate: 'start' }),
      ob('start.unknown', { reason: 'same start problem', gate: 'review' }),
      ob('docs', { reason: 'other' }),
    ]);
    expect(got.map((o) => [o.id, o.reason])).toEqual([
      ['start.incomplete', 'same start problem'],
      ['test', 'first'],
      ['docs', 'other'],
    ]);
  });

  test('no obligation: nothing, and an empty reason', () => {
    expect(plannedObligations([])).toEqual([]);
    expect(obligationsReason([])).toBe('');
  });
});

describe('obligationsReason', () => {
  test('one obligation reads as its gate\'s text with the id in front, the count behind and the evidence tail', () => {
    const r = obligationsReason([ob('test', { reason: 'No test result covers the changed code.', count: 3 })]);
    expect(r).toBe(
      '[test] No test result covers the changed code. (block 3) This gate passes only on its evidence. If you cannot provide it, tell the user what is missing and why; only the user can let this Stop pass.',
    );
    expect(r).not.toContain('unmet obligations');
    expect(r).not.toContain('Smallest rerun plan');
  });

  test('one user-only obligation has no evidence tail (its text says what can end it)', () => {
    const r = obligationsReason([ob('state', { reason: 'Logs are padded. Only the user can let this Stop pass.', userOnly: true })]);
    expect(r).toBe('[state] Logs are padded. Only the user can let this Stop pass. (block 1)');
  });

  test('several: numbered in plan order with id and block count each, then the plan of the phases present, in order', () => {
    const r = obligationsReason([
      ob('review.missing', { reason: 'Review is required.', count: 2 }),
      ob('test', { reason: 'No test result.', count: 4 }),
      ob('docs', { reason: 'Docs are stale.', count: 1 }),
    ]);
    expect(r).toContain('This Stop has 3 unmet obligations; each keeps its id across Stops until it is met.');
    expect(r).toContain('(1/3) [test] No test result. (block 4)');
    expect(r).toContain('(2/3) [docs] Docs are stale. (block 1)');
    expect(r).toContain('(3/3) [review.missing] Review is required. (block 2)');
    const at = (s: string) => r.indexOf(s);
    expect(at('(1/3)')).toBeLessThan(at('(2/3)'));
    expect(at('(2/3)')).toBeLessThan(at('(3/3)'));
    expect(r).toMatch(/Smallest rerun plan, in this order: 1\) one test run that covers every test item; 2\) update or check the stale docs; 3\) review last and once: one `review-axes` plan/);
    expect(r).toContain('These gates pass only on their evidence.');
  });

  test('one phase appears once in the plan however many items it has, and only the phases present appear', () => {
    const r = obligationsReason([ob('review.high'), ob('review.invalid'), ob('review.assumptions')]);
    expect(r.match(/review last and once/g)).toHaveLength(1);
    expect(r).toContain('Smallest rerun plan, in this order: 1) review last and once');
    expect(r).not.toContain('one test run');
    expect(r).not.toContain('stale docs');
  });

  test('user-only items alone: the plan says only the user can pass, and no evidence tail follows', () => {
    const r = obligationsReason([ob('sweep', { userOnly: true }), ob('state', { userOnly: true })]);
    expect(r).toContain('1) tell the user: no evidence ends these, only the user can let this Stop pass');
    expect(r).not.toContain('pass only on their evidence');
  });

  test('a user-only item next to an evidence item keeps the evidence tail', () => {
    const r = obligationsReason([ob('claim'), ob('start.incomplete', { userOnly: true })]);
    expect(r).toContain('These gates pass only on their evidence.');
    expect(r).toMatch(/1\) fix first: .*; 2\) tell the user/);
  });

  test('the same id twice, or the same text twice, is listed once', () => {
    const r = obligationsReason([ob('docs'), ob('docs', { reason: 'again' })]);
    expect(r.match(/\[docs\]/g)).toHaveLength(1);
    expect(r).not.toContain('unmet obligations'); // it is one obligation
  });
});

describe('noticeGates', () => {
  test('the gates whose count reached the bar, once each, at their highest count', () => {
    const got = noticeGates(
      [
        ob('review.missing', { gate: 'review', count: 1 }),
        ob('review.invalid', { gate: 'review', count: 2, envSwitch: 'GOODBOY_X=off' }),
        ob('review.high', { gate: 'review', count: 3, envSwitch: '' }),
        ob('test', { gate: 'test', count: 2, envSwitch: 'GOODBOY_TEST_GATE=off' }),
        ob('docs', { gate: 'docs', count: 1, envSwitch: 'GOODBOY_DOCS_GATE=off' }),
      ],
      2,
    );
    // The review gate once, at its highest count (3), and it keeps the switch the replaced item named.
    expect(got).toEqual([
      { gate: 'test', count: 2, envSwitch: 'GOODBOY_TEST_GATE=off' },
      { gate: 'review', count: 3, envSwitch: 'GOODBOY_X=off' },
    ]);
  });

  test('nothing reached the bar: no notice; an item with no switch has an empty one', () => {
    expect(noticeGates([ob('test', { count: 1 })], 2)).toEqual([]);
    expect(noticeGates([ob('sweep', { gate: 'sweep', count: 5 })], 2)).toEqual([{ gate: 'sweep', count: 5, envSwitch: '' }]);
  });

  test('a duplicate obligation does not count twice', () => {
    expect(noticeGates([ob('test', { count: 2 }), ob('test', { count: 9, reason: 'other' })], 2)).toEqual([{ gate: 'test', count: 2, envSwitch: '' }]);
  });
});

// ── 2. the Stop hook, spawned ───────────────────────────────────────────────────────────────────────

const T0 = '2026-11-26T01:00:00.000Z';
void T0;

/** A project (a `.git` dir marks the root) whose doc map says ARCH.md covers src/**. */
function project(): string {
  const d = tmp();
  mkdirSync(join(d, '.git'));
  write(d, '.goodboy/policy.md', '## P1 X\n- decide: human\n- source: user 2026-11-26\n- date: 2026-11-26\n- checked: 2026-11-26\n');
  write(d, 'ARCH.md', '# Arch\n');
  write(d, 'src/a.ts', 'export const a = 1;\n');
  write(
    d,
    '.goodboy/docs.json',
    JSON.stringify({
      docs: [
        { path: '.goodboy/policy.md', session_start: true, covers: [] },
        { path: 'ARCH.md', session_start: false, covers: ['src/**'] },
      ],
    }),
  );
  return d;
}
const edited = (d: string, s: string, rel = 'src/a.ts') => recordEdit(s, join(d, rel), 0, undefined, Date.now());
/** Another edit in the turn the next Stop closes (a gate does not block a turn that changed nothing). */
function again(d: string, s: string, rel = 'src/a.ts'): void {
  const turn = parseInt(readFileSync(join(sessionDir(s), 'turn.txt'), 'utf8').trim() || '0', 10);
  recordEdit(s, join(d, rel), turn, undefined, Date.now());
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
const OFF = { GOODBOY_TEST_GATE: 'off', GOODBOY_DOCS_GATE: 'off', GOODBOY_CLAIM_GATE: 'off' };
async function stop(d: string, s: string, payload: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<StopOut> {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_REASONING_FLUSH_WAIT_MS: '0', ...OFF, ...env },
  });
  const out = (await new Response(p.stdout).text()) || '{}';
  await p.exited;
  return JSON.parse(out) as StopOut;
}

/** The block's text without the line every goodboy hook puts in front. */
const body = (reason: string | undefined): string => (reason ?? '').replace(/^\[goodboy 훅\][^\n]*\n/, '');

/** The ids a block names, in the order it lists them. */
const idsOf = (reason: string | undefined): string[] => [...(reason ?? '').matchAll(/\((?:\d+\/\d+)\) \[([a-z.]+)\]/g)].map((m) => m[1]!);

/** A review record in the project's reviews dir (newer than any edit, so only its content judges). */
function reviewFile(d: string, over: Record<string, unknown> = {}, name = 'review.json'): void {
  write(
    d,
    `.claude/reviews/${name}`,
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: [join(d, 'src', 'a.ts')],
      category: 'add-feature',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
      ...over,
    }),
  );
}
const HIGH = { file: 'src/a.ts', line: 1, issue: 'input reaches a shell', severity: 'high', probe: 'echo $X | sh -> ran' };

/** The validation failure marker the post hook leaves in the session dir. */
function failValidation(s: string, commands = ['bun run typecheck']): void {
  mkdirSync(sessionDir(s), { recursive: true });
  writeFileSync(join(sessionDir(s), '.goodboy-validation-failed.json'), JSON.stringify({ sessionId: s, timestamp: new Date().toISOString(), commands }));
}
/** A transcript whose last answer cites a file that does not exist (the claim gate blocks it). */
function claimTranscript(d: string, text = 'The handler is in src/nope.ts:42 and works.'): string {
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'explain' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
  ];
  return write(d, 'transcript.jsonl', `${lines.join('\n')}\n`);
}
/** A transcript with a rationale that declares an assumption (the assumptions item). */
function assumptionTranscript(d: string): string {
  const text = ['## 추론', '### 사실', '- README를 Read로 확인함', '### 추측', '- ⚠️ 백엔드가 OAuth2 표준 응답을 쓸 것이다'].join('\n');
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
  ];
  return write(d, 'assumptions.jsonl', `${lines.join('\n')}\n`);
}
const approve = (d: string, s: string): void => {
  write(d, approvalMarkerRelPath('stop', s), '');
};

describe('N8-1: several unmet obligations are one block', () => {
  test('no test record and no review: one block names both with ids, counts and the plan, the test first', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const out = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBe('block');
    const r = out.reason!;
    expect(r).toContain('This Stop has 2 unmet obligations');
    expect(idsOf(r)).toEqual(['test', 'review.missing']);
    expect(r).toMatch(/\(1\/2\) \[test\] .*\(block 1\) \(2\/2\) \[review\.missing\] Review is required for the changed files: .*src\/a\.ts.*\(block 1\) Smallest rerun plan/);
    expect(r).toMatch(/Smallest rerun plan, in this order: 1\) one test run that covers every test item; 2\) review last and once/);
    expect(r).toContain('These gates pass only on their evidence.');
  }, 60_000);

  test('the ids stay across Stops and the counts grow; the user is told how to pass from the second block on', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const first = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(first.systemMessage ?? '').not.toContain('연속 막았어요');
    again(d, s);
    const second = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(idsOf(second.reason)).toEqual(['test', 'review.missing']);
    expect(second.reason).toMatch(/\[test\] .*\(block 2\)/);
    expect(second.reason).toMatch(/\[review\.missing\] .*\(block 2\)/);
    expect(second.systemMessage).toContain('test 게이트가 2번');
    expect(second.systemMessage).toContain('review 게이트가 2번');
    expect(second.systemMessage).toContain('GOODBOY_TEST_GATE=off');
  }, 90_000);

  test('a stale doc and a missing review: the docs item first, the review last', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const out = await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(idsOf(out.reason)).toEqual(['docs', 'review.missing']);
    expect(out.reason).toContain('ARCH.md');
    expect(out.reason).toMatch(/1\) update or check the stale docs; 2\) review last and once/);
  }, 60_000);

  test('a validation failure and a claim: both, the fixes in one phase', async () => {
    const d = project();
    const s = sid();
    failValidation(s);
    const out = await stop(d, s, { transcript_path: claimTranscript(d) }, { GOODBOY_CLAIM_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(idsOf(out.reason)).toEqual(['validation', 'claim']);
    expect(out.reason).toContain('bun run typecheck');
    expect(out.reason).toContain('src/nope.ts:42');
    expect(out.reason).toMatch(/Smallest rerun plan, in this order: 1\) fix first: /);
    expect(out.reason!.match(/\) fix first/g)).toHaveLength(1);
    expect(out.reason).not.toContain('; 2) ');
  }, 60_000);

  test('one obligation: the gate\'s own text with its id in front, the count and the evidence tail, no plan', async () => {
    const d = project();
    const s = sid();
    failValidation(s);
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(body(out.reason)).toMatch(/^\[validation\] 자동 검증이 실패한 상태입니다: bun run typecheck\..*\(block 1\) This gate passes only on its evidence\./);
    expect(out.reason).not.toContain('unmet obligations');
    expect(out.reason).not.toContain('Smallest rerun plan');
  }, 60_000);

  test('the user\'s marker passes the gate that used it: the Stop goes on to the next gate in the same run', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    failValidation(s);
    approve(d, s);
    const out = await stop(d, s, {}, {});
    // One approval ends one Stop: it passes the validation gate and every later gate of this run, so nothing is
    // pending and the review (which had no record) is accepted by the marker.
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('validation 게이트');
    expect(readReviewCursor(d, s)).not.toBeNull();
  }, 60_000);
});

describe('N8-2: a review that passes next to another obligation is not accepted', () => {
  test('docs pending: the passing review is left (cursor unchanged), the docs item alone is the block; the next Stop with the doc fixed accepts it', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d, { reviewed_files: [join(d, 'src', 'a.ts'), join(d, 'ARCH.md')] });
    const first = await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on' });
    expect(first.decision).toBe('block');
    expect(idsOf(first.reason)).toEqual([]); // one item: the single-item form
    expect(body(first.reason)).toMatch(/^\[docs\] /);
    expect(readReviewCursor(d, s)).toBeNull();
    // Still pending on a second Stop with another edit of the code: still not accepted.
    again(d, s);
    expect(body((await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on' })).reason)).toMatch(/^\[docs\] /);
    expect(readReviewCursor(d, s)).toBeNull();
    // The doc is updated: nothing pending, and the review is accepted.
    edited(d, s, 'ARCH.md');
    const done = await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on' });
    expect(done.decision).toBeUndefined();
    expect(readReviewCursor(d, s)).not.toBeNull();
  }, 120_000);

  test('a test item pending: the passing review is left unaccepted; with the test gate off it is accepted', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d);
    const blocked = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(blocked.decision).toBe('block');
    expect(body(blocked.reason)).toMatch(/^\[test\] /);
    expect(blocked.reason).not.toContain('[review');
    expect(readReviewCursor(d, s)).toBeNull();
    again(d, s);
    const passed = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'off' });
    expect(passed.decision).toBeUndefined();
    expect(readReviewCursor(d, s)).not.toBeNull();
  }, 90_000);

  test('with nothing pending a passing review is accepted at once', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d);
    const out = await stop(d, s);
    expect(out.decision).toBeUndefined();
    expect(readReviewCursor(d, s)).not.toBeNull();
  }, 60_000);

  test('a validation item pending: the passing review is not accepted either', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d);
    failValidation(s);
    const out = await stop(d, s);
    expect(body(out.reason)).toMatch(/^\[validation\] /);
    expect(readReviewCursor(d, s)).toBeNull();
  }, 60_000);
});

describe('N8-3: the review checks are each an item', () => {
  test('high findings and an invalid coverage are listed together, the dimensions are not', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    // A review of another file only: the coverage of src/a.ts fails; it carries a high finding and no dimensions.
    reviewFile(d, { reviewed_files: [join(d, 'other.ts')], findings: [HIGH], verdict: 'needs-changes', dimensions_checked: [] });
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(idsOf(out.reason)).toEqual(['review.invalid', 'review.high']);
    expect(out.reason).toContain('Review validation failed');
    expect(out.reason).toContain('high severity');
    expect(out.reason).toContain('input reaches a shell');
    expect(out.reason).not.toContain('review.dimensions');
    expect(out.reason).not.toContain('quality dimensions');
    expect(out.reason!.match(/review last and once/g)).toHaveLength(1);
    expect(readReviewCursor(d, s)).toBeNull();
  }, 60_000);

  test('the dimensions are an item once the coverage holds, and alone when nothing else is open', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d, { dimensions_checked: [] });
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(body(out.reason)).toMatch(/^\[review\.dimensions\] /);
    expect(out.reason).toContain('did not assess the quality dimensions');
  }, 60_000);

  test('high findings with a valid coverage and missing dimensions: both, in the review phase', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d, { findings: [HIGH], verdict: 'needs-changes', dimensions_checked: [] });
    const out = await stop(d, s);
    expect(idsOf(out.reason)).toEqual(['review.high', 'review.dimensions']);
  }, 60_000);

  test('assumptions are listed with no review at all, next to the missing review', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const out = await stop(d, s, { transcript_path: assumptionTranscript(d) });
    expect(out.decision).toBe('block');
    expect(idsOf(out.reason)).toEqual(['review.missing', 'review.assumptions']);
    expect(out.reason).toContain('declared 1 guesses or assumptions');
  }, 60_000);

  test('assumptions with an invalid coverage are listed too; a review that checked them clears the item', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d, { reviewed_files: [join(d, 'other.ts')] });
    const tp = assumptionTranscript(d);
    const invalid = await stop(d, s, { transcript_path: tp });
    expect(idsOf(invalid.reason)).toEqual(['review.invalid', 'review.assumptions']);
    reviewFile(d, { unknown_assumptions_checked: [{ assumption: 'OAuth2 response', result: 'confirmed', evidence: 'curl' }] });
    again(d, s);
    const fixed = await stop(d, s, { transcript_path: tp });
    expect(fixed.decision).toBeUndefined();
  }, 90_000);

  test('the count: one per counter and Stop, the coverage counter and the findings counter apart', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d, { reviewed_files: [join(d, 'other.ts')], findings: [HIGH], verdict: 'needs-changes' });
    const first = await stop(d, s);
    expect(first.reason).toMatch(/\[review\.invalid\] .*\(block 1\)/);
    expect(first.reason).toMatch(/\[review\.high\] .*\(block 1\)/);
    again(d, s);
    const second = await stop(d, s);
    expect(second.reason).toMatch(/\[review\.invalid\] .*\(block 2\)/);
    expect(second.reason).toMatch(/\[review\.high\] .*\(block 2\)/);
  }, 90_000);

  test('the user\'s marker passes every review item at once and the review is accepted with a notice for each', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    reviewFile(d, { reviewed_files: [join(d, 'other.ts')], findings: [HIGH], verdict: 'needs-changes' });
    approve(d, s);
    const out = await stop(d, s);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain('리뷰 검증 실패');
    expect(out.systemMessage).toContain('해소되지 않은 high severity');
    expect(readReviewCursor(d, s)).not.toBeNull();
  }, 60_000);
});

describe('N8-4: an incomplete start, unlisted writes and a padded log end the judging', () => {
  /** A session with a change that would otherwise get the test, docs and review items. */
  function changed(): { d: string; s: string } {
    const d = project();
    const s = sid();
    edited(d, s);
    return { d, s };
  }
  const ON = { GOODBOY_TEST_GATE: 'on', GOODBOY_DOCS_GATE: 'on' };

  test('state (padded log): its item and a fix found before it only; no test, docs or review item; nothing accepted', async () => {
    const { d, s } = changed();
    reviewFile(d); // would be accepted by a Stop that judged it
    writeFileSync(join(sessionDir(s), 'oversized-logs.json'), JSON.stringify(['dispatch-log.jsonl']));
    failValidation(s);
    const out = await stop(d, s, {}, ON);
    expect(out.decision).toBe('block');
    expect(idsOf(out.reason)).toEqual(['validation', 'state']);
    expect(out.reason).not.toMatch(/\[(test|docs|review)/);
    expect(readReviewCursor(d, s)).toBeNull();
  }, 60_000);

  test('state alone: the single-item form without the evidence tail', async () => {
    const { d, s } = changed();
    writeFileSync(join(sessionDir(s), 'oversized-logs.json'), JSON.stringify(['dispatch-log.jsonl']));
    const out = await stop(d, s, {}, ON);
    expect(body(out.reason)).toMatch(/^\[state\] .*Only the user can let this Stop pass\. \(block 1\)$/);
  }, 60_000);

  test('sweep (a Bash call whose writes are unknown): its item, no later gate', async () => {
    const { d, s } = changed();
    reviewFile(d);
    writeFileSync(join(sessionDir(s), 'unswept.jsonl'), `${JSON.stringify({ tuid: 'lost', since: 1, dirs: [], command: 'lost', stalled: [] })}\n`);
    const out = await stop(d, s, {}, ON);
    expect(out.decision).toBe('block');
    expect(body(out.reason)).toMatch(/^\[sweep\] /);
    expect(out.reason).not.toMatch(/\[(test|docs|review)/);
    expect(readReviewCursor(d, s)).toBeNull();
  }, 60_000);

  test('start.incomplete (a checkout first seen with no HEAD in a repository with history): its item, no test, docs or review item, and a claim found before it', async () => {
    // The session starts in repo A; the Stop runs in a later worktree B, first seen at this Stop, on an orphan branch.
    const a = tmp();
    sh(a, `${GIT_INIT}`);
    write(a, 'src/a.ts', 'export const a = 1;\n');
    sh(a, "git add -A && git commit -q -m 'ABC-1 init'");
    const s = sid();
    pinCoverageStart(s, a);
    const d = join(tmp(), 'B');
    sh(a, `git worktree add -q --detach '${d}' HEAD`);
    sh(d, 'git checkout -q --orphan o');
    edited(d, s);
    const out = await stop(d, s, { transcript_path: claimTranscript(d) }, { ...ON, GOODBOY_CLAIM_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(idsOf(out.reason)).toEqual(['claim', 'start.incomplete']);
    expect(out.reason).toContain('could not be established');
    expect(out.reason).not.toMatch(/\[(test|docs|review)/);
    expect(readReviewCursor(d, s)).toBeNull();
  }, 60_000);

  test('an item found with under two seconds of the hook clock left: the docs and review gates wait for the next Stop', async () => {
    const { d, s } = changed();
    failValidation(s);
    // Control: with the clock whole, the docs and review items come with the validation item.
    const whole = await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on' });
    expect(idsOf(whole.reason)).toEqual(['validation', 'docs', 'review.missing']);
    again(d, s);
    const short = await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on', GOODBOY_TEST_HOOK_CLOCK_MS: '1500' });
    expect(short.decision).toBe('block');
    expect(body(short.reason)).toMatch(/^\[validation\] /);
    expect(short.reason).not.toMatch(/\[(docs|review)/);
    expect(readReviewCursor(d, s)).toBeNull();
  }, 90_000);

  test('a short clock with nothing found changes nothing: the docs and review gates run', async () => {
    const { d, s } = changed();
    const out = await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on', GOODBOY_TEST_HOOK_CLOCK_MS: '1500' });
    expect(idsOf(out.reason)).toEqual(['docs', 'review.missing']);
  }, 60_000);

  test('a user-only item does not end the judging when it is passed by the marker: the later gates run', async () => {
    const { d, s } = changed();
    writeFileSync(join(sessionDir(s), 'oversized-logs.json'), JSON.stringify(['dispatch-log.jsonl']));
    approve(d, s);
    const out = await stop(d, s, {}, ON);
    // The marker passed the state gate and every later gate of this Stop, so nothing blocks.
    expect(out.reason ?? '').not.toContain('[state]');
  }, 60_000);
});

describe('N8-5: running agents', () => {
  const agent = (type: string, status = 'running') => ({ id: `t-${type}`, type: 'subagent', status, description: 'x', agent_type: type });
  const clock = (s: string): number | null => {
    try {
      return (JSON.parse(readFileSync(join(sessionDir(s), DEFERRAL_FILE), 'utf8')) as { start: number }).start;
    } catch {
      return null;
    }
  };

  test('a running review agent with nothing else pending defers and starts the clock', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const out = await stop(d, s, { background_tasks: [agent('goodboy:review-changes')] });
    expect(out.decision).toBeUndefined();
    expect(typeof clock(s)).toBe('number');
  }, 60_000);

  test('a running review agent with a validation item pending: the block is the validation item alone, and no clock starts', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    failValidation(s);
    const out = await stop(d, s, { background_tasks: [agent('goodboy:review-changes')] });
    expect(out.decision).toBe('block');
    expect(body(out.reason)).toMatch(/^\[validation\] /);
    expect(out.reason).not.toContain('[review');
    expect(clock(s)).toBeNull();
  }, 60_000);

  test('a running review agent with a claim and a validation item: both, no clock', async () => {
    const d = project();
    const s = sid();
    failValidation(s);
    const out = await stop(d, s, { background_tasks: [agent('goodboy:review-changes')], transcript_path: claimTranscript(d) }, { GOODBOY_CLAIM_GATE: 'on' });
    expect(idsOf(out.reason)).toEqual(['validation', 'claim']);
    expect(clock(s)).toBeNull();
  }, 60_000);

  test('a running test agent with a claim item found before the test gate: the Stop ends with the claim, with no test, docs or review item', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const out = await stop(d, s, { background_tasks: [agent('goodboy:test-unit')], transcript_path: claimTranscript(d) }, { GOODBOY_TEST_GATE: 'on', GOODBOY_DOCS_GATE: 'on', GOODBOY_CLAIM_GATE: 'on' });
    expect(out.decision).toBe('block');
    expect(body(out.reason)).toMatch(/^\[claim\] /);
    expect(out.reason).not.toMatch(/\[(test|docs|review)/);
  }, 60_000);

  test('a running test agent with nothing found before: the test gate waits and the Stop ends without a block', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const out = await stop(d, s, { background_tasks: [agent('goodboy:test-unit')] }, { GOODBOY_TEST_GATE: 'on', GOODBOY_DOCS_GATE: 'on' });
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('goodboy:test-unit');
  }, 60_000);
});

// ── The carry marks ("no change since the gate last judged") move only when nothing earlier is pending ──────────

/** A passing test record of `src/a.ts`, newer than any edit (the test gate has its evidence). */
function passingTestRecord(d: string, tested = ['src/a.ts']): void {
  write(d, 'tests/a.test.ts', 'test("x", () => { expect(1).toBe(1); });\n');
  write(
    d,
    '.claude/tests/result.json',
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: tested.map((f) => join(d, f)),
      category: 'add-feature',
      test_files: [join(d, 'tests', 'a.test.ts')],
      environment: { mode: 'local', command: 'bun test', evidence: 'ok' },
      suites: [{ name: 'unit', command: 'bun test', passed: 3, failed: 0, output: '3 pass' }],
      acceptance: [],
      verdict: 'pass',
    }),
  );
}
const CARRIED_REVIEW = '리뷰 게이트가 막지 않았어요';
const CARRIED_TEST = '테스트 게이트가 막지 않았어요';

describe('N8-8: a gate\'s carry mark moves only when no earlier gate holds an obligation', () => {
  test('(a) test + review at Stop 1; the test met at Stop 2 with no edit: the review blocks alone; Stop 3 with no edit carries it', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const first = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(idsOf(first.reason)).toEqual(['test', 'review.missing']);
    // The test is met; no file changed since. The review gate was held behind the test item at Stop 1, so its mark did
    // not move: this Stop is its first judgment of the change.
    passingTestRecord(d);
    const second = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(second.decision).toBe('block');
    expect(body(second.reason)).toMatch(/^\[review\.missing\] /);
    expect(second.reason).not.toContain('[test]');
    // Judged now: with no edit the review is carried, with a warning.
    const third = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(third.decision).toBeUndefined();
    expect(third.systemMessage ?? '').toContain(CARRIED_REVIEW);
  }, 120_000);

  test('(b) an earlier validation item beside [test] at Stop 1; Stop 2 meets only it, with no code edit: [test] still blocks', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    failValidation(s);
    const first = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(idsOf(first.reason)).toEqual(['validation', 'test', 'review.missing']);
    // The validation is met (the post hook removes the marker after a passing run); no code changed since.
    rmSync(join(sessionDir(s), '.goodboy-validation-failed.json'));
    const second = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(second.decision).toBe('block');
    expect(second.reason).toContain('[test]');
    expect(second.reason).not.toContain('[validation]');
    expect(second.systemMessage ?? '').not.toContain(CARRIED_TEST);
  }, 120_000);

  test('(b2) an earlier claim item beside [test] at Stop 1, met at Stop 2: [test] still blocks (the claim gate comes first too)', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const first = await stop(d, s, { transcript_path: claimTranscript(d) }, { GOODBOY_TEST_GATE: 'on', GOODBOY_CLAIM_GATE: 'on' });
    expect(idsOf(first.reason)).toEqual(['claim', 'test', 'review.missing']);
    const second = await stop(d, s, { transcript_path: claimTranscript(d, 'Nothing is cited here.') }, { GOODBOY_TEST_GATE: 'on', GOODBOY_CLAIM_GATE: 'on' });
    expect(second.decision).toBe('block');
    expect(second.reason).toContain('[test]');
    expect(second.reason).not.toContain('[claim]');
  }, 120_000);

  // The checkout mark cannot be told apart by behavior in a spawned Stop: the Stop's own start-pin sweep records the
  // other checkout's dirty file again at the turn it runs, so a Stop 2 sees a change whatever the mark. The three marks
  // are read from the session's habit state instead (the file the gates write them to).
  test('(c) the marks in the habit state: each moves only when no earlier gate holds an obligation (checkout, test, review in turn)', async () => {
    const d = project();
    const s = sid();
    edited(d, s);
    const marks = () => {
      const h = readHabitState(s);
      return { checkout: h.checkoutGateTurns?.[d], test: h.testGateTurns?.[d], review: h.reviewGateTurns?.[d] };
    };
    // Stop 1: a validation item is pending before every later gate: no mark moves.
    failValidation(s);
    const first = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(idsOf(first.reason)).toEqual(['validation', 'test', 'review.missing']);
    expect(marks()).toEqual({ checkout: undefined, test: undefined, review: undefined });
    // Stop 2: the validation is met. The checkout and test gates judge with nothing earlier pending, so their marks move;
    // the review gate is held behind the test item, so its mark does not.
    rmSync(join(sessionDir(s), '.goodboy-validation-failed.json'));
    const second = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(idsOf(second.reason)).toEqual(['test', 'review.missing']);
    const afterSecond = marks();
    expect(typeof afterSecond.checkout).toBe('number');
    expect(typeof afterSecond.test).toBe('number');
    expect(afterSecond.review).toBeUndefined();
    // Stop 3: the test is met; the review gate judges with nothing earlier pending, and its mark moves.
    passingTestRecord(d);
    const third = await stop(d, s, {}, { GOODBOY_TEST_GATE: 'on' });
    expect(body(third.reason)).toMatch(/^\[review\.missing\] /);
    expect(typeof marks().review).toBe('number');
  }, 120_000);
});

// ── 3. endDeferralWait ──────────────────────────────────────────────────────────────────────────────

describe('N8-6: endDeferralWait', () => {
  const agent = (type: string, status = 'running') => ({ id: `t-${type}`, type: 'subagent', status, description: 'x', agent_type: type });
  const setClock = (s: string, agoMs: number): void => {
    mkdirSync(sessionDir(s), { recursive: true });
    writeFileSync(join(sessionDir(s), DEFERRAL_FILE), JSON.stringify({ start: Date.now() - agoMs }));
  };
  const clockFile = (s: string): string => join(sessionDir(s), DEFERRAL_FILE);
  const clockStart = (s: string): number | null => (existsSync(clockFile(s)) ? (JSON.parse(readFileSync(clockFile(s), 'utf8')) as { start: number }).start : null);

  test('removes the clock when no test or review agent runs, and calls onEnded once', () => {
    const s = sid();
    setClock(s, 1000);
    let called = 0;
    expect(endDeferralWait(s, runningAgents([]), () => called++)).toBe(true);
    expect(existsSync(clockFile(s))).toBe(false);
    expect(called).toBe(1);
  });

  test('other agents and finished ones do not keep the wait open', () => {
    const s = sid();
    setClock(s, 1000);
    expect(endDeferralWait(s, runningAgents([agent('general-purpose'), agent('goodboy:test-unit', 'completed')]))).toBe(true);
    expect(existsSync(clockFile(s))).toBe(false);
  });

  test('a running test agent or a running review agent keeps the clock', () => {
    for (const type of ['goodboy:test-unit', 'goodboy:review-changes']) {
      const s = sid();
      setClock(s, 1000);
      const before = clockStart(s);
      let called = 0;
      expect(endDeferralWait(s, runningAgents([agent(type)]), () => called++)).toBe(false);
      expect(clockStart(s)).toBe(before);
      expect(called).toBe(0);
    }
  });

  test('no clock: nothing to end, and onEnded is not called', () => {
    const s = sid();
    mkdirSync(sessionDir(s), { recursive: true });
    let called = 0;
    expect(endDeferralWait(s, runningAgents([]), () => called++)).toBe(false);
    expect(called).toBe(0);
  });

  test('a throwing onEnded is swallowed: the clock stays removed', () => {
    const s = sid();
    setClock(s, 1000);
    expect(
      endDeferralWait(s, runningAgents([]), () => {
        throw new Error('boom');
      }),
    ).toBe(true);
    expect(existsSync(clockFile(s))).toBe(false);
  });

  test('after the wait ended a new deferral starts a fresh clock', () => {
    const s = sid();
    setClock(s, AGENT_DEFERRAL_CAP_MS + 60_000); // the old clock ran out
    const t = Date.now();
    expect(deferralOpen(s, t)).toBe(false);
    expect(endDeferralWait(s, runningAgents([]))).toBe(true);
    expect(deferralOpen(s, t)).toBe(true);
    expect(clockStart(s)).toBe(t);
    expect(deferralOpen(s, t + AGENT_DEFERRAL_CAP_MS)).toBe(true);
    expect(deferralOpen(s, t + AGENT_DEFERRAL_CAP_MS + 1)).toBe(false);
  });

  test('a clock that is not a plain file is not removed (and nothing throws)', () => {
    const s = sid();
    mkdirSync(clockFile(s), { recursive: true }); // a directory where the file belongs
    expect(endDeferralWait(s, runningAgents([]))).toBe(false);
    expect(existsSync(clockFile(s))).toBe(true);
  });

  describe('through the Stop', () => {
    function unreviewed() {
      const d = project();
      const s = sid();
      edited(d, s);
      return { d, s };
    }

    test('a Stop that lists the tasks with no agent running ends the wait: the old clock goes, and the next deferral is a new 45 minutes', async () => {
      const { d, s } = unreviewed();
      const tasks = [agent('goodboy:review-changes')];
      expect((await stop(d, s, { background_tasks: tasks })).decision).toBeUndefined();
      setClock(s, AGENT_DEFERRAL_CAP_MS + 60_000); // the first wait ran out
      // The agent finished: the Stop that sees none ends the wait (and asks for the review).
      again(d, s);
      const between = await stop(d, s, { background_tasks: [] });
      expect(between.decision).toBe('block');
      expect(existsSync(clockFile(s))).toBe(false);
      // A later review agent defers again, on a clock that starts now.
      again(d, s);
      const before = Date.now();
      expect((await stop(d, s, { background_tasks: tasks })).decision).toBeUndefined();
      expect(clockStart(s)!).toBeGreaterThanOrEqual(before - 1000);
    }, 120_000);

    test('a hung agent that stays listed as running keeps the old clock: once it ran out the Stop blocks', async () => {
      const { d, s } = unreviewed();
      const tasks = [agent('goodboy:review-changes')];
      expect((await stop(d, s, { background_tasks: tasks })).decision).toBeUndefined();
      setClock(s, AGENT_DEFERRAL_CAP_MS + 60_000);
      const old = clockStart(s);
      expect((await stop(d, s, { background_tasks: tasks })).decision).toBe('block');
      expect(clockStart(s)).toBe(old);
    }, 90_000);

    test('a payload without background_tasks does not end the wait', async () => {
      const { d, s } = unreviewed();
      expect((await stop(d, s, { background_tasks: [agent('goodboy:review-changes')] })).decision).toBeUndefined();
      const old = clockStart(s);
      again(d, s);
      await stop(d, s, {}); // an older Claude Code: no list
      expect(clockStart(s)).toBe(old);
    }, 90_000);

    test('a test agent keeps the clock a review deferral started', async () => {
      const { d, s } = unreviewed();
      expect((await stop(d, s, { background_tasks: [agent('goodboy:review-changes')] })).decision).toBeUndefined();
      const old = clockStart(s);
      again(d, s);
      await stop(d, s, { background_tasks: [agent('goodboy:test-unit')] });
      expect(clockStart(s)).toBe(old);
    }, 90_000);
  });
});

// ── 4. test-write checks a coverage.changed entry ───────────────────────────────────────────────────

describe('N8-7: test-write refuses a partial coverage.changed entry', () => {
  const CLI = join(ROOT, 'lib', 'cli.ts');
  interface Cli {
    code: number | null;
    out: string;
    err: string;
  }
  function cli(cwd: string, args: string[], stdin = ''): Cli {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CLAUDE_PROJECT_DIR: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    delete env.CLAUDE_CODE_SESSION_ID;
    const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  }
  const RED_GREEN = [
    {
      id: 'AC-1',
      description: 'x is 1',
      test: 'x.test.ts',
      red: { command: 'bun test x.test.ts', output: '1 fail', exit_code: 1 },
      green: { command: 'bun test x.test.ts', output: '1 pass', exit_code: 0 },
    },
  ];
  /** A repo with one commit, one changed line in src/x.ts that a report says ran, and that `diff-coverage` output. */
  function measured(): { repo: string; whole: Record<string, unknown> } {
    const repo = tmp();
    write(repo, 'src/x.ts', 'export const x = 1;\n');
    write(repo, 'x.test.ts', 'test("x", () => {});\n');
    write(repo, 'package.json', JSON.stringify({ scripts: { test: 'true' } }));
    sh(repo, `${GIT_INIT} && git add -A && git commit -q -m init`);
    write(repo, 'src/x.ts', 'export const x = 1;\nexport const edit = 9;\n');
    const report = join(tmp(), 'cov.lcov');
    writeFileSync(report, 'TN:\nSF:src/x.ts\nDA:1,1\nDA:2,1\nend_of_record\n');
    const r = cli(repo, ['diff-coverage', report]);
    expect([r.code, r.err]).toEqual([0, '']);
    return { repo, whole: JSON.parse(r.out) as Record<string, unknown> };
  }
  const input = (repo: string, changed: unknown) => ({
    timestamp: new Date().toISOString(),
    tested_files: [join(repo, 'src', 'x.ts')],
    category: 'fix-bug',
    test_files: [join(repo, 'x.test.ts')],
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: RED_GREEN,
    verdict: 'pass',
    coverage: { status: 'measured', changed },
  });

  describe('the validator in process (validateTestResultInput)', () => {
    const whole = { covered: 1, total: 1, files_without_executed_changes: [], files: { 'src/a.ts': { covered: 1, total: 1 } }, in_report: ['src/a.ts'], diff_lines: { 'src/a.ts': 1 }, base: 'b'.repeat(40), top: '/r' };
    const base = {
      tested_files: ['/r/src/a.ts'],
      category: 'fix-bug',
      test_files: [CLI],
      environment: { mode: 'none' },
      suites: [{ name: 'unit', command: 'bun test', passed: 3, failed: 0, output: '3 pass', type: 'unit', duration_ms: 10 }],
      acceptance: RED_GREEN,
      verdict: 'needs-changes',
    };
    const errorsOf = (changed: unknown): string => validateTestResultInput({ ...base, coverage: { status: 'measured', changed } }).errors.join('\n');

    test('the whole entry passes; each of the four fields missing is named', () => {
      expect(errorsOf(whole)).toBe('');
      for (const field of ['files', 'in_report', 'diff_lines', 'base'] as const) {
        const partial: Record<string, unknown> = { ...whole };
        delete partial[field];
        expect(errorsOf(partial)).toContain(`coverage.changed lacks ${field}: record the whole \`cli.ts diff-coverage\` output`);
      }
    });

    test('all four missing are named in one error, in the order of the entry\'s fields; a list names the entry', () => {
      expect(errorsOf({ covered: 1, total: 1, files_without_executed_changes: [] })).toContain('coverage.changed lacks files, in_report, diff_lines, base: ');
      expect(errorsOf([whole, { covered: 1, total: 1, files_without_executed_changes: [], files: {} }])).toContain('coverage.changed[1] lacks in_report, diff_lines, base: ');
    });

    test('a field that is present but wrong keeps its own message and is not reported as missing', () => {
      const e = errorsOf({ ...whole, base: 'HEAD' });
      expect(e).toContain('coverage.changed.base must be the object id');
      expect(e).not.toContain('lacks');
    });
  });

  test('the whole diff-coverage output is recorded', () => {
    const { repo, whole } = measured();
    for (const k of ['files', 'in_report', 'diff_lines', 'base', 'top']) expect(whole[k]).toBeDefined();
    const r = cli(repo, ['test-write'], JSON.stringify(input(repo, whole)));
    expect([r.code, r.err.replace(/warning:.*\n?/g, '')]).toEqual([0, '']);
    const { path } = JSON.parse(r.out) as { path: string };
    expect((JSON.parse(readFileSync(path, 'utf8')) as { coverage: { changed: unknown } }).coverage.changed).toEqual(whole);
  }, 60_000);

  test.each([['files'], ['in_report'], ['diff_lines'], ['base']])('an entry without %s is refused, naming it', (field) => {
    const { repo, whole } = measured();
    const partial = { ...whole };
    delete partial[field];
    const r = cli(repo, ['test-write'], JSON.stringify(input(repo, partial)));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`coverage.changed lacks ${field}:`);
    expect(r.err).toContain('record the whole `cli.ts diff-coverage` output');
    expect(r.out).toBe('');
  }, 60_000);

  test('several missing fields are named together; the old minimal entry is refused', () => {
    const { repo } = measured();
    const old = { covered: 3, total: 4, files_without_executed_changes: [] };
    const r = cli(repo, ['test-write'], JSON.stringify(input(repo, old)));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('coverage.changed lacks files, in_report, diff_lines, base:');
  }, 60_000);

  test('in a list each entry is checked, named by its index', () => {
    const { repo, whole } = measured();
    const partial = { ...whole };
    delete partial.base;
    const r = cli(repo, ['test-write'], JSON.stringify(input(repo, [whole, partial])));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('coverage.changed[1] lacks base:');
    expect(r.err).not.toContain('coverage.changed[0] lacks');
  }, 60_000);
});
