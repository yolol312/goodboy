import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { hashPrompt } from '../lib/recursion-guard';
import { roleOf, spawnCaps } from '../lib/routing-policy';
import {
  decideSpawn,
  type DispatchRecord,
  namedFiles,
  nearKey,
  outcomeOf,
  policyRewrite,
  runningDispatches,
  RUNNING_STALE_MS,
  spawnsClaudeCli,
  type SpawnRequest,
} from '../lib/spawn-guard';

// Track G §10.7. Fixtures use literal names and numbers, not the policy table, so a table
// edit cannot silently rewrite the contract.

const CAPS = { perTask: 8, perLeadCall: 6, concurrent: 3, perSession: 40 };
const NOW = 10_000_000;
const NO_CHANGE = { fileChangedSince: () => false, editsSince: () => false };

function req(over: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    caller: null,
    callerId: null,
    callee: 'general-purpose',
    prompt: 'look up the API limits',
    model: null,
    effort: null,
    files: [],
    ...over,
  };
}

let n = 0;
function dispatch(over: Partial<Extract<DispatchRecord, { k: 'dispatch' }>> = {}): Extract<DispatchRecord, { k: 'dispatch' }> {
  n += 1;
  return {
    k: 'dispatch',
    t: NOW - 60_000,
    tuid: `tu-${n}`,
    caller: null,
    callerId: null,
    callee: 'general-purpose',
    hash: hashPrompt(`other prompt ${n}`),
    model: null,
    effort: null,
    files: [],
    why: 'new',
    ...over,
  };
}

function done(d: { tuid: string }, outcome: 'ok' | 'blocked' = 'ok'): DispatchRecord {
  return { k: 'done', t: NOW - 30_000, tuid: d.tuid, agentId: null, outcome };
}

describe('depth: only leads start agents, and only their members', () => {
  test('a member cannot delegate', () => {
    const d = decideSpawn(req({ caller: 'goodboy:review-all', callerId: 'a1' }), [], CAPS, NOW, NO_CHANGE);
    expect(d.allow).toBe(false);
    expect(d.code).toBe('member-no-delegate');
  });

  test('a built-in agent cannot delegate either', () => {
    const d = decideSpawn(req({ caller: 'general-purpose', callerId: 'a1' }), [], CAPS, NOW, NO_CHANGE);
    expect(d.code).toBe('member-no-delegate');
  });

  test('another plugin named like a lead is not a lead', () => {
    const d = decideSpawn(
      req({ caller: 'other:review-lead', callerId: 'a1', callee: 'goodboy:review-all' }),
      [],
      CAPS,
      NOW,
      NO_CHANGE,
    );
    expect(d.code).toBe('member-no-delegate');
  });

  test('a lead may start its own member, in the foreground, at the member policy', () => {
    const d = decideSpawn(
      req({ caller: 'goodboy:review-lead', callerId: 'L1', callee: 'goodboy:review-security' }),
      [],
      CAPS,
      NOW,
      NO_CHANGE,
    );
    expect(d.allow).toBe(true);
    expect(d.rewrite).toEqual({ run_in_background: false, model: 'opus', effort: 'high' });
  });

  test("a lead may not start another team's agent", () => {
    const d = decideSpawn(
      req({ caller: 'goodboy:review-lead', callerId: 'L1', callee: 'goodboy:test-unit' }),
      [],
      CAPS,
      NOW,
      NO_CHANGE,
    );
    expect(d.code).toBe('not-a-member');
  });

  test('a lead may not start a built-in agent', () => {
    const d = decideSpawn(
      req({ caller: 'goodboy:research-lead', callerId: 'L1', callee: 'general-purpose' }),
      [],
      CAPS,
      NOW,
      NO_CHANGE,
    );
    expect(d.code).toBe('not-a-member');
  });

  test('a lead run is capped at 6 members; another run of the lead has its own budget', () => {
    const log = Array.from({ length: 6 }, () =>
      dispatch({ caller: 'goodboy:test-lead', callerId: 'L1', callee: 'goodboy:test-unit' }),
    );
    const r = req({ caller: 'goodboy:test-lead', callerId: 'L1', callee: 'goodboy:test-spec' });
    expect(decideSpawn(r, log, CAPS, NOW, NO_CHANGE).code).toBe('lead-cap');
    expect(decideSpawn({ ...r, callerId: 'L2' }, log, CAPS, NOW, NO_CHANGE).allow).toBe(true);
  });
});

describe('main-session caps', () => {
  test('session cap counts every dispatch, members included', () => {
    const log: DispatchRecord[] = [];
    for (let i = 0; i < 40; i++) {
      const d = dispatch({ caller: i % 2 ? 'goodboy:review-lead' : null, callerId: i % 2 ? 'L' : null });
      log.push(d, done(d));
    }
    expect(decideSpawn(req(), log, CAPS, NOW, NO_CHANGE).code).toBe('session-cap');
  });

  test('task cap counts main dispatches since the last user prompt', () => {
    const before = Array.from({ length: 8 }, () => dispatch({ t: NOW - 500_000 }));
    const log: DispatchRecord[] = [...before.flatMap((d) => [d, done(d)]), { k: 'prompt', t: NOW - 400_000 }];
    expect(decideSpawn(req(), log, CAPS, NOW, NO_CHANGE).allow).toBe(true);
    const after = Array.from({ length: 8 }, () => dispatch({ t: NOW - 100_000 }));
    log.push(...after.flatMap((d) => [d, done(d)]));
    expect(decideSpawn(req(), log, CAPS, NOW, NO_CHANGE).code).toBe('task-cap');
  });

  // (#21) A runaway is told by repetition: the third near-identical brief to one agent in a
  //   task, with nothing edited since the last, is denied; an edit in between (a fix, then a
  //   re-test) lets it run, and other agents or briefs are not counted.
  test('runaway: near-identical briefs repeated without a change', () => {
    // Briefs that differ only in their middle (past the first and before the last 200
    //   characters); one that ends differently is other work (one brief per review axis).
    const head = `Run the unit tests for lib/a.ts and record the result. ${'Keep the same scope and the same rules. '.repeat(5)}`;
    const tail = ` ${'Hand back the record path and the results. '.repeat(5)}`;
    const brief = (v: string) => `${head} attempt ${v}.${tail}`;
    const near = nearKey(brief('1'));
    expect(nearKey(brief('2'))).toBe(near);
    expect(nearKey(`${head}${tail} axis: security`)).not.toBe(nearKey(`${head}${tail} axis: performance`));
    const prev = [
      dispatch({ callee: 'goodboy:test-unit', hash: hashPrompt(brief('1')), near }),
      dispatch({ callee: 'goodboy:test-unit', hash: hashPrompt(brief('2')), near }),
    ];
    const log: DispatchRecord[] = [{ k: 'prompt', t: NOW - 600_000 }, ...prev.flatMap((d) => [d, done(d)])];
    const third = req({ callee: 'goodboy:test-unit', prompt: brief('3') });
    expect(decideSpawn(third, log, CAPS, NOW, NO_CHANGE).code).toBe('runaway');
    expect(decideSpawn(third, log, CAPS, NOW, { ...NO_CHANGE, editsSince: () => true }).allow).toBe(true);
    expect(decideSpawn({ ...third, callee: 'goodboy:review-all' }, log, CAPS, NOW, NO_CHANGE).allow).toBe(true);
    expect(decideSpawn({ ...third, prompt: 'A different brief entirely.' }, log, CAPS, NOW, NO_CHANGE).allow).toBe(true);
    expect(decideSpawn(third, log.slice(0, 3), CAPS, NOW, NO_CHANGE).allow).toBe(true);
    // A new user prompt starts a new task.
    expect(decideSpawn(third, [...log, { k: 'prompt', t: NOW - 1000 }], CAPS, NOW, NO_CHANGE).allow).toBe(true);
  });

  // (#21) AC-1: at the shipped caps the agents a gate asks for are not starved.
  test('at the default caps the 9th to 29th agent of a task is allowed; the 30th is not', () => {
    const caps = spawnCaps();
    const ran = (k: number) => Array.from({ length: k }, () => dispatch()).flatMap((x) => [x, done(x)]);
    expect(decideSpawn(req({ callee: 'goodboy:test-unit' }), ran(8), caps, NOW, NO_CHANGE).allow).toBe(true);
    expect(decideSpawn(req({ callee: 'goodboy:test-unit' }), ran(29), caps, NOW, NO_CHANGE).allow).toBe(true);
    expect(decideSpawn(req({ callee: 'goodboy:test-unit' }), ran(30), caps, NOW, NO_CHANGE).code).toBe('task-cap');
  });

  test('runaway: a brief that names files is judged by those files, not by any edit', () => {
    const brief = `Review lib/a.ts for races. ${'Be thorough and cite lines. '.repeat(10)}`;
    const near = nearKey(brief, ['/p/lib/a.ts']);
    const prev = [dispatch({ callee: 'goodboy:review-all', near, files: ['/p/lib/a.ts'] }), dispatch({ callee: 'goodboy:review-all', near, files: ['/p/lib/a.ts'] })];
    const log: DispatchRecord[] = [{ k: 'prompt', t: NOW - 600_000 }, ...prev.flatMap((d) => [d, done(d)])];
    const third = req({ callee: 'goodboy:review-all', prompt: brief, files: ['/p/lib/a.ts'] });
    // An edit elsewhere does not count; the named file changing does.
    expect(decideSpawn(third, log, CAPS, NOW, { ...NO_CHANGE, editsSince: () => true }).code).toBe('runaway');
    expect(decideSpawn(third, log, CAPS, NOW, { ...NO_CHANGE, fileChangedSince: () => true }).allow).toBe(true);
  });

  // (#21 review) The exact-repeat rule keeps its one retry and one escalation; a rephrased
  //   retry of a blocked run is no loop either.
  test('runaway leaves retries and escalations to the duplicate rule', () => {
    const p = `Check the deploy config. ${'Same scope, same rules, cite the lines. '.repeat(12)}`;
    const near = nearKey(p);
    const first = dispatch({ callee: 'goodboy:review-all', hash: hashPrompt(p), near });
    const retry = dispatch({ callee: 'goodboy:review-all', hash: hashPrompt(p), near, why: 'retry' });
    const log: DispatchRecord[] = [{ k: 'prompt', t: NOW - 600_000 }, first, done(first, 'blocked'), retry, done(retry, 'blocked')];
    expect(decideSpawn(req({ callee: 'goodboy:review-all', prompt: p, model: 'opus' }), log, CAPS, NOW, NO_CHANGE).allow).toBe(true);
    const rephrased = `${p.slice(0, 220)} (again, more carefully) ${p.slice(220)}`;
    expect(nearKey(rephrased)).toBe(near);
    expect(decideSpawn(req({ callee: 'goodboy:review-all', prompt: rephrased }), log, CAPS, NOW, NO_CHANGE).allow).toBe(true);
  });

  // Each exemption of the runaway rule on its own (the test above passes through the
  //   blocked-run exemption for both of its requests).
  test('runaway: an exact repeat that the duplicate rule allows as a retry is not a loop', () => {
    const p = `Check the deploy config. ${'Same scope, same rules, cite the lines. '.repeat(12)}`;
    const near = nearKey(p);
    const mid = (v: string) => `${p.slice(0, 250)} [${v}] ${p.slice(250)}`; // same first and last 200 characters
    expect(nearKey(mid('b'))).toBe(near);
    const first = dispatch({ callee: 'goodboy:review-all', hash: hashPrompt(p), near });
    const b = dispatch({ callee: 'goodboy:review-all', hash: hashPrompt(mid('b')), near });
    const c = dispatch({ callee: 'goodboy:review-all', hash: hashPrompt(mid('c')), near });
    // The exact brief was BLOCKED once, then two rephrasings ran ok: the last near run is ok.
    const log: DispatchRecord[] = [{ k: 'prompt', t: NOW - 600_000 }, first, done(first, 'blocked'), b, done(b), c, done(c)];
    const again = decideSpawn(req({ callee: 'goodboy:review-all', prompt: p }), log, CAPS, NOW, NO_CHANGE);
    expect(again.allow).toBe(true);
    expect(again.why).toBe('retry');
    // A new rephrasing in the same state is the loop.
    expect(decideSpawn(req({ callee: 'goodboy:review-all', prompt: mid('d') }), log, CAPS, NOW, NO_CHANGE).code).toBe('runaway');
  });

  test('runaway: a stronger model or effort than the last near run is not a loop', () => {
    const p = `Check the deploy config. ${'Same scope, same rules, cite the lines. '.repeat(12)}`;
    const near = nearKey(p);
    const mid = (v: string) => `${p.slice(0, 250)} [${v}] ${p.slice(250)}`; // same first and last 200 characters
    expect(nearKey(mid('a'))).toBe(near);
    const mk = (v: string, o: Partial<Extract<DispatchRecord, { k: 'dispatch' }>> = {}) =>
      dispatch({ callee: 'goodboy:review-all', hash: hashPrompt(mid(v)), near, model: 'sonnet', effort: 'medium', ...o });
    const a = mk('a');
    const b = mk('b');
    const log: DispatchRecord[] = [{ k: 'prompt', t: NOW - 600_000 }, a, done(a), b, done(b)];
    const call = (over: Partial<SpawnRequest>) => decideSpawn(req({ callee: 'goodboy:review-all', prompt: mid('c'), model: 'sonnet', effort: 'medium', ...over }), log, CAPS, NOW, NO_CHANGE);
    expect(call({}).code).toBe('runaway');
    expect(call({ model: 'haiku' }).code).toBe('runaway'); // weaker is no escalation
    expect(call({ model: 'opus' }).allow).toBe(true);
    expect(call({ effort: 'high' }).allow).toBe(true);
  });

  test('the task fuse names the user, not "incomplete"', () => {
    const many = Array.from({ length: 30 }, () => dispatch());
    const d = decideSpawn(req(), many.flatMap((x) => [x, done(x)]), { ...CAPS, perTask: 30 }, NOW, NO_CHANGE);
    expect(d.code).toBe('task-cap');
    expect(d.reason).toContain('ask whether to continue');
  });

  test('concurrency cap counts running main dispatches only', () => {
    const running = [dispatch(), dispatch(), dispatch()];
    expect(decideSpawn(req(), running, CAPS, NOW, NO_CHANGE).code).toBe('concurrency');
    const finished = [...running.slice(0, 2), done(running[0]!), running[2]!];
    expect(decideSpawn(req(), finished, CAPS, NOW, NO_CHANGE).allow).toBe(true);
  });

  test("a lead's running members do not use up the main session's concurrency", () => {
    const members = [1, 2, 3].map(() =>
      dispatch({ caller: 'goodboy:review-lead', callerId: 'L1', callee: 'goodboy:review-all' }),
    );
    expect(decideSpawn(req(), members, CAPS, NOW, NO_CHANGE).allow).toBe(true);
  });

  test('a background launch is running until its agent stops', () => {
    const d = dispatch();
    const launched: DispatchRecord = { k: 'launched', t: NOW - 59_000, tuid: d.tuid, agentId: 'ag1' };
    expect(runningDispatches([d, launched], NOW)).toHaveLength(1);
    const stop: DispatchRecord = { k: 'done', t: NOW - 1_000, tuid: null, agentId: 'ag1', outcome: 'ok' };
    expect(runningDispatches([d, launched, stop], NOW)).toHaveLength(0);
  });

  test('a dispatch with no completion stops counting as running after 30 minutes', () => {
    const d = dispatch({ t: NOW - RUNNING_STALE_MS - 1 });
    expect(runningDispatches([d], NOW)).toHaveLength(0);
  });
});

describe('duplicates need evidence', () => {
  const prompt = 'review the auth change';
  const same = () => dispatch({ callee: 'goodboy:review-all', hash: hashPrompt(prompt) });
  const r = req({ callee: 'goodboy:review-all', prompt });

  test('same agent and prompt still running → wait', () => {
    expect(decideSpawn(r, [same()], CAPS, NOW, NO_CHANGE).code).toBe('duplicate-running');
  });

  test('same agent and prompt, finished ok, nothing changed → deny', () => {
    const d = same();
    expect(decideSpawn(r, [d, done(d)], CAPS, NOW, NO_CHANGE).code).toBe('duplicate');
  });

  test('prompt normalization: whitespace and case do not make it new', () => {
    const d = same();
    const loud = { ...r, prompt: '  Review   the AUTH change ' };
    expect(decideSpawn(loud, [d, done(d)], CAPS, NOW, NO_CHANGE).code).toBe('duplicate');
  });

  test('a new user prompt since → allowed', () => {
    const d = same();
    const log: DispatchRecord[] = [d, done(d), { k: 'prompt', t: NOW - 10_000 }];
    const out = decideSpawn(r, log, CAPS, NOW, NO_CHANGE);
    expect(out.allow).toBe(true);
    expect(out.why).toBe('user-prompt');
  });

  test('a named file changed since → allowed', () => {
    const d = { ...same(), files: ['/repo/src/auth.ts'] };
    const deps = { fileChangedSince: (p: string) => p === '/repo/src/auth.ts', editsSince: () => false };
    expect(decideSpawn(r, [d, done(d)], CAPS, NOW, deps).why).toBe('scope-changed');
  });

  test('no files named: any edit since counts; an unrelated changed file does not when files are named', () => {
    const d = same();
    expect(decideSpawn(r, [d, done(d)], CAPS, NOW, { fileChangedSince: () => false, editsSince: () => true }).why).toBe(
      'scope-changed',
    );
    const named = { ...same(), files: ['/repo/a.ts'] };
    const deps = { fileChangedSince: (p: string) => p === '/repo/b.ts', editsSince: () => true };
    expect(decideSpawn(r, [named, done(named)], CAPS, NOW, deps).code).toBe('duplicate');
  });

  test('BLOCKED result → one retry, not two', () => {
    const d = same();
    const log: DispatchRecord[] = [d, done(d, 'blocked')];
    expect(decideSpawn(r, log, CAPS, NOW, NO_CHANGE).why).toBe('retry');
    const retry = { ...same(), why: 'retry' as const };
    log.push(retry, done(retry, 'blocked'));
    expect(decideSpawn(r, log, CAPS, NOW, NO_CHANGE).code).toBe('duplicate');
  });

  test('missing result (stale, never completed) → one retry', () => {
    const d = { ...same(), t: NOW - RUNNING_STALE_MS - 5 };
    expect(decideSpawn(r, [d], CAPS, NOW, NO_CHANGE).why).toBe('retry');
  });

  test('stronger model or effort → once', () => {
    const d = { ...same(), model: 'sonnet' };
    const log: DispatchRecord[] = [d, done(d)];
    expect(decideSpawn({ ...r, model: 'opus' }, log, CAPS, NOW, NO_CHANGE).why).toBe('escalation');
    const esc = { ...same(), model: 'opus', why: 'escalation' as const };
    log.push(esc, done(esc));
    expect(decideSpawn({ ...r, model: 'opus', effort: 'max' }, log, CAPS, NOW, NO_CHANGE).code).toBe('duplicate');
  });

  test('a different agent with the same prompt is not a duplicate', () => {
    const d = same();
    expect(decideSpawn({ ...r, callee: 'goodboy:review-security' }, [d, done(d)], CAPS, NOW, NO_CHANGE).allow).toBe(true);
  });
});

describe('policy rewrite', () => {
  test('goodboy roles are raised to their policy model and effort', () => {
    expect(policyRewrite('goodboy:review-security', null, null)).toEqual({ model: 'opus', effort: 'high' });
    expect(policyRewrite('build-run', null, null)).toEqual({ model: 'haiku', effort: 'low' });
  });

  test('a stronger per-call value is kept (never lowered)', () => {
    expect(policyRewrite('goodboy:build-backend', 'opus', 'xhigh')).toEqual({});
    expect(policyRewrite('goodboy:build-backend', 'claude-opus-5-5', null)).toEqual({ effort: 'high' });
  });

  test('built-ins, legacy names and other plugins are left alone', () => {
    expect(policyRewrite('general-purpose', null, null)).toEqual({});
    expect(policyRewrite('goodboy:review-changes', null, null)).toEqual({});
    expect(policyRewrite('other:review-all', null, null)).toEqual({});
  });
});

describe('spawnsClaudeCli (headless runs bypass the Agent guard)', () => {
  test('detects claude -p / --print, also behind env, npx and paths', () => {
    for (const c of [
      'claude -p "run pytest"',
      'claude --print "x"',
      'cd /tmp && claude -c -p hi',
      'FOO=1 claude -p hi',
      'env FOO=1 claude --print=json hi',
      'npx -y @anthropic-ai/claude-code -p hi',
      '/usr/local/bin/claude -p hi',
      'x=$(claude -p hi)',
      // Security review: the prefixes models use for long runs, wrappers and quotes.
      'timeout 600 claude -p "run pytest"',
      'nohup claude -p hi &',
      'time claude -p hi',
      'nice -n 5 claude -p hi',
      "sh -c 'claude -p hi'",
      'bash -c "cd x && claude --print y"',
      'eval claude -p hi',
      '"claude" -p hi',
      'claude -p hi 2>&1 | tee log',
      // Round 2: flag clusters and launchers.
      "bash -lc 'claude -p hi'",
      'echo x | xargs claude -p',
      'find . -name x -exec claude -p hi \\;',
      'node "$(command -v claude)" -p hi',
      'bun x @anthropic-ai/claude-code -p hi',
      'npm exec @anthropic-ai/claude-code -- -p hi',
    ]) {
      expect([c, spawnsClaudeCli(c)]).toEqual([c, true]);
    }
  });

  test('other uses of the word pass', () => {
    for (const c of [
      'claude --version',
      'claude mcp list',
      'echo claude -p',
      'grep -n claude README.md',
      'ls ~/.claude/plugins',
      'claude-code-helper -p',
    ]) {
      expect([c, spawnsClaudeCli(c)]).toEqual([c, false]);
    }
  });
});

describe('namedFiles', () => {
  test('keeps existing files the prompt names, drops the rest', () => {
    const files = namedFiles(
      'review lib/spawn-guard.ts and tests/spawn-guard.test.ts, not lib/nope.ts or https://x.io/a.js',
      resolve(import.meta.dir, '..'),
    );
    expect(files).toEqual([
      resolve(import.meta.dir, '..', 'lib', 'spawn-guard.ts'),
      resolve(import.meta.dir, '..', 'tests', 'spawn-guard.test.ts'),
    ]);
  });
});

describe('helpers', () => {
  test('outcomeOf reads a whole-word BLOCKED', () => {
    expect(outcomeOf('BLOCKED: no test runner')).toBe('blocked');
    expect(outcomeOf('status: BLOCKED')).toBe('blocked');
    expect(outcomeOf('UNBLOCKED now')).toBe('ok');
    expect(outcomeOf(undefined)).toBe('ok');
  });

  test('roleOf strips only the goodboy namespace', () => {
    expect(roleOf('goodboy:test-unit')?.name).toBe('test-unit');
    expect(roleOf('test-unit')?.name).toBe('test-unit');
    expect(roleOf('other:test-unit')).toBeNull();
    expect(roleOf('Explore')).toBeNull();
  });

  test('caps come from env with the documented defaults', () => {
    // Restore key by key: replacing process.env itself breaks os.tmpdir() for later tests.
    const keys = ['GOODBOY_SPAWN_LIMIT', 'GOODBOY_SPAWN_LIMIT_LEAD', 'GOODBOY_SPAWN_CONCURRENCY', 'GOODBOY_SPAWN_LIMIT_SESSION'];
    const saved = keys.map((k) => [k, process.env[k]] as const);
    try {
      for (const k of keys) delete process.env[k];
      // (#21) The task and session counts are fuses, not budgets.
      expect(spawnCaps()).toEqual({ perTask: 30, perLeadCall: 6, concurrent: 3, perSession: 150 });
      process.env.GOODBOY_SPAWN_LIMIT = '2';
      process.env.GOODBOY_SPAWN_CONCURRENCY = 'x';
      expect(spawnCaps().perTask).toBe(2);
      expect(spawnCaps().concurrent).toBe(3);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
