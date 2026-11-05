// v0.36.14 (#39 follow-up, plan §15.30 item 2 "bounded confirmations"): a `.git` entry git cannot read (a FIFO
// as HEAD makes `git rev-parse` block) must not outlast the Stop's 15 s hook timeout, which passes the Stop
// with no output (fail open). One clock for the hook (lib/hook-clock.ts), a per-call limit and a cumulative
// budget for the nested-repo confirmations (lib/nested-repos.ts), and a dir git did not answer for is
// 'unconfirmed': never walked past, never asked twice, a group whose start is unknown, no tree, no blob.
// Repos are temporary and git runs for real; the Stop hook and the CLI are spawned. Test seams are the env
// names GOODBOY_TEST_CONFIRM_LIMIT_MS and GOODBOY_TEST_CONFIRM_BUDGET_MS.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { noteBashStart } from '../lib/approval-marker';
import { getCurrentTurn, getEditHistory, recordEdit } from '../lib/file-tracker';
import { FLUSH_PAST_CLOCK_MS, HOOK_CLOCK_MS, hookClockRunning, hookLeft, resetHookClock, startHookClock } from '../lib/hook-clock';
import { nestedRepos, repoOfFile, resetConfirmations } from '../lib/nested-repos';
import { repoTrees } from '../lib/push-test';
import { takeStartSnapshot } from '../lib/start-pins';
import { nestedStatus } from '../lib/write-sweep';
import { groupsOf, incompleteStartProblem, newDeadline, resetStopGroups, startProblem } from '../lib/stop-groups';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
setDefaultTimeout(90_000);

const dirs: string[] = [];
const saved = { limit: process.env.GOODBOY_TEST_CONFIRM_LIMIT_MS, budget: process.env.GOODBOY_TEST_CONFIRM_BUDGET_MS };
const restore = (name: string, v: string | undefined): void => {
  if (v === undefined) delete process.env[name];
  else process.env[name] = v;
};
afterEach(() => {
  resetStopGroups();
  resetConfirmations();
  resetHookClock();
  restore('GOODBOY_TEST_CONFIRM_LIMIT_MS', saved.limit);
  restore('GOODBOY_TEST_CONFIRM_BUDGET_MS', saved.budget);
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-i3914c-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
function commitRepo(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  write(dir, 'src/x.ts', `export const ${name} = 1;\n`);
  write(dir, 'x.test.ts', `import { expect, test } from 'bun:test';\ntest('${name}', () => expect(1).toBe(1));\n`);
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'bun test' } }));
  sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
  return dir;
}
/** A `.git` git cannot read: its HEAD is a FIFO, so any git call in the dir blocks reading it. */
function plantFifoRepo(dir: string): string {
  mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
  mkdirSync(join(dir, '.git', 'refs'), { recursive: true });
  sh(dir, 'mkfifo .git/HEAD');
  return dir;
}

let counter = 0;
interface W {
  base: string;
  proj: string;
  be: string;
  home: string;
  sid: string;
}
/** A plain `proj/` holding the repo `be` and a session started in it (before any FIFO exists). */
function world(): W {
  const base = tmp();
  const proj = join(base, 'proj');
  mkdirSync(proj);
  const be = commitRepo(join(proj, 'be'), 'be');
  const sid = `i3914c${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
  pinCoverageStart(sid, proj);
  return { base, proj, be, home: tmp('goodboy-i3914c-home-'), sid };
}
/** An edit of a file: a line appended, in the session's edit log. */
function edit(w: W, abs: string): string {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${(() => { try { return readFileSync(abs, 'utf8'); } catch { return ''; } })()}export const e${Math.random().toString(36).slice(2, 6)} = 2;\n`);
  recordEdit(w.sid, abs, getCurrentTurn(w.sid), undefined, Date.now());
  return abs;
}

interface Out {
  decision?: string;
  reason?: string;
}
async function stop(w: W, env: Record<string, string> = {}): Promise<{ out: Out; ms: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', STOP], {
    cwd: w.proj,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: w.proj, session_id: w.sid, hook_event_name: 'Stop', stop_hook_active: false })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...(process.env as Record<string, string>),
      HOME: w.home,
      CLAUDE_PROJECT_DIR: w.proj,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DOCS_GATE: 'off',
      GOODBOY_POLICY_GATE: 'off',
      GOODBOY_DIFF_COVERAGE: 'on',
      GOODBOY_TEST_TYPES: 'on',
      GOODBOY_EXISTING_TESTS: 'on',
      ...env,
    },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  expect(err).not.toContain('[goodboy stop]');
  return { out: JSON.parse(text || '{}') as Out, ms: Date.now() - t0 };
}

const withLimits = (limit: number, budget?: number): void => {
  process.env.GOODBOY_TEST_CONFIRM_LIMIT_MS = String(limit);
  if (budget !== undefined) process.env.GOODBOY_TEST_CONFIRM_BUDGET_MS = String(budget);
};

// ── lib/nested-repos.ts and lib/hook-clock.ts ─────────────────────────────────────────────────

describe('confirmations are bounded', () => {
  test('a FIFO `.git` next to a real repo: the walk lists the real repo, names the dir git did not answer for, and is capped', () => {
    const w = world();
    const zzz = plantFifoRepo(join(w.proj, 'zzz'));
    withLimits(300);
    const t0 = Date.now();
    const found = nestedRepos(w.proj);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(found.repos.map((r) => r.top)).toEqual([w.be]);
    expect(found.unanswered).toEqual([zzz]);
    expect(found.capped).toBe(true);
  });

  test('a file in the FIFO dir: the dir is returned as unconfirmed, not walked past; asked once only', () => {
    const w = world();
    const zzz = plantFifoRepo(join(w.proj, 'zzz'));
    const file = join(zzz, 'src', 'y.ts');
    withLimits(500);
    const t0 = Date.now();
    const ref = repoOfFile(file, w.proj);
    const first = Date.now() - t0;
    expect(ref).toEqual({ top: zzz, realTop: zzz, unconfirmed: true });
    expect(first).toBeGreaterThanOrEqual(400); // git was asked, and cut off at the limit
    const t1 = Date.now();
    expect(repoOfFile(file, w.proj)?.unconfirmed).toBe(true); // a new walk: the dir is remembered
    expect(nestedRepos(w.proj).unanswered).toEqual([zzz]);
    expect(Date.now() - t1).toBeLessThan(first);
    // A real repo and a loose file are as before.
    expect(repoOfFile(join(w.be, 'src', 'x.ts'), w.proj)).toEqual({ top: w.be, realTop: w.be });
    expect(repoOfFile(join(w.proj, 'loose.ts'), w.proj)).toBeNull();
  });

  test('the cumulative budget caps the time of many planted FIFOs; the dirs left unasked are unanswered', () => {
    const w = world();
    const planted = Array.from({ length: 8 }, (_, i) => plantFifoRepo(join(w.proj, `f${i}`)));
    withLimits(400, 600);
    const t0 = Date.now();
    const found = nestedRepos(w.proj);
    const took = Date.now() - t0;
    expect(found.unanswered.sort()).toEqual(planted);
    expect(found.repos.map((r) => r.top)).toEqual([w.be]); // `be` sorts before `f0` and is asked first
    expect(took).toBeLessThan(2_400); // 8 x 400 ms unbounded; the budget cuts it at 600 plus slack
  });

  test('the hook clock: with no time left no git runs, and the dir is unconfirmed at once', () => {
    const w = world();
    withLimits(5_000);
    startHookClock(5);
    Bun.sleepSync(20);
    expect(hookLeft()).toBeLessThanOrEqual(0);
    const t0 = Date.now();
    const ref = repoOfFile(join(w.be, 'src', 'x.ts'), w.proj);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(ref).toEqual({ top: w.be, realTop: w.be, unconfirmed: true });
  });

  test('a stopped clock reports Infinity and no clock running; a started one counts down', () => {
    startHookClock(50);
    expect(hookClockRunning()).toBe(true);
    expect(hookLeft()).toBeLessThanOrEqual(50);
    resetHookClock();
    expect(hookClockRunning()).toBe(false);
    expect(hookLeft()).toBe(Infinity);
  });
});

// ── Callers of an unconfirmed dir fail closed ─────────────────────────────────────────────────

describe('an unconfirmed dir is a group with an unknown start, a repo with no tree', () => {
  test('groupsOf: a nested group whose start is unknown with the reason; no start pin is read for it', () => {
    const w = world();
    const zzz = plantFifoRepo(join(w.proj, 'zzz'));
    withLimits(400);
    const file = write(zzz, 'src/y.ts', 'export const y = 1;\n');
    const groups = groupsOf(w.sid, w.proj, [file]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect([g.kind, g.top, g.rel, g.unconfirmed]).toEqual(['nested', zzz, 'zzz', true]);
    expect(g.head).toBeUndefined();
    expect(g.start.unknown).toContain('git did not answer in time for `zzz`');
    expect(g.start.unknown).toContain('remove its `.git`');
    expect(startProblem(w.sid, w.proj, [file])).toContain('is unknown (git did not answer in time for `zzz`');
    // Not an "incomplete start": nothing more is asked of it.
    expect(incompleteStartProblem(w.sid, w.proj)).toBeNull();
  });

  test('planted dirs that used up the budget are named in the block of the real repo left unasked', () => {
    const w = world();
    for (const n of ['a0', 'a1', 'a2']) plantFifoRepo(join(w.proj, n));
    withLimits(300, 600);
    nestedRepos(w.proj); // the Stop's walk (noteSessionTops): a0 and a1 use the budget, a2 and be are left unasked
    const file = join(w.be, 'src', 'x.ts');
    const g = groupsOf(w.sid, w.proj, [file])[0]!;
    expect([g.rel, g.unconfirmed]).toEqual(['be', true]);
    expect(g.start.unknown).toContain('git did not answer in time for `be`');
    expect(g.start.unknown).toContain('git also did not answer for 3 other `.git` entries in the project dir (`a0`, `a1`, `a2`)');
    expect(g.start.unknown).toContain('remove the `.git` of each that is no real repository');
  });

  test('the other unanswered dirs: a single one is "1 other entry"; more than five are cut with a count', () => {
    const one = world();
    plantFifoRepo(join(one.proj, 'a0'));
    withLimits(300, 300);
    nestedRepos(one.proj); // a0 uses the whole budget; be is left unasked
    const g1 = groupsOf(one.sid, one.proj, [join(one.be, 'src', 'x.ts')])[0]!;
    expect(g1.start.unknown).toContain('git also did not answer for 1 other `.git` entry in the project dir (`a0`), and they share one budget');
    resetStopGroups();
    resetConfirmations();

    const many = world();
    for (let i = 0; i < 7; i++) plantFifoRepo(join(many.proj, `a${i}`));
    withLimits(300, 600);
    nestedRepos(many.proj); // a0 and a1 use the budget; a2..a6 and be are left unasked
    const g = groupsOf(many.sid, many.proj, [join(many.be, 'src', 'x.ts')])[0]!;
    expect(g.start.unknown).toContain('git also did not answer for 7 other `.git` entries in the project dir (`a0`, `a1`, `a2`, `a3`, `a4`, 2 more)');
  });

  test('dirs another project dir left unanswered in the same process are not named for this one', () => {
    const other = world();
    plantFifoRepo(join(other.proj, 'zz'));
    withLimits(300, 600);
    nestedRepos(other.proj); // zz: 300 ms of the 600 ms budget
    const w = world();
    plantFifoRepo(join(w.proj, 'a0'));
    nestedRepos(w.proj); // a0: the rest; be is left unasked
    const g = groupsOf(w.sid, w.proj, [join(w.be, 'src', 'x.ts')])[0]!;
    expect(g.unconfirmed).toBe(true);
    expect(g.start.unknown).toContain('git also did not answer for 1 other `.git` entry in the project dir (`a0`)');
    expect(g.start.unknown).not.toContain('zz');
  });

  test('repoTrees: no tree and no git hash for it; the real repo next to it still has its tree', () => {
    const w = world();
    const zzz = plantFifoRepo(join(w.proj, 'zzz'));
    withLimits(400);
    const t0 = Date.now();
    const r = repoTrees([join(zzz, 'src', 'y.ts'), join(w.be, 'src', 'x.ts')], w.proj);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(Object.keys(r.trees)).toEqual([w.be]);
    expect(r.dropped).toEqual([]);
  });

  test('test-write for a file in the FIFO dir ends fast with no tree, no blob and the warning', () => {
    const w = world();
    const zzz = plantFifoRepo(join(w.proj, 'zzz'));
    const file = write(zzz, 'src/y.ts', 'export const y = 1;\n');
    const input = {
      timestamp: new Date().toISOString(),
      tested_files: [file],
      category: 'fix-bug',
      test_files: [write(zzz, 'y.test.ts', 'test("y", () => {});\n')],
      environment: { mode: 'local' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [{ id: 'AC-1', description: 'y', test: 'y.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } }],
      verdict: 'pass',
    };
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: w.home, CLAUDE_PROJECT_DIR: w.proj, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GOODBOY_TEST_CONFIRM_LIMIT_MS: '400' };
    delete env.CLAUDE_CODE_SESSION_ID;
    const t0 = Date.now();
    const p = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: w.proj, env, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(p.exitCode).toBe(0);
    const rec = JSON.parse(readFileSync((JSON.parse(p.stdout.toString()) as { path: string }).path, 'utf8')) as Record<string, unknown>;
    expect(rec.trees).toBeUndefined();
    expect(rec.extra_blobs).toBeUndefined();
    expect(p.stderr.toString()).toContain('warning: no tested tree recorded');
  });
});

// ── The Stop hook ─────────────────────────────────────────────────────────────────────────────

describe('the Stop hook with a planted `.git`', () => {
  test('a FIFO `.git` beside a real repo: the Stop blocks (no empty output) well within 15 s, naming the real repo\'s file', async () => {
    const w = world();
    edit(w, join(w.be, 'src', 'x.ts'));
    plantFifoRepo(join(w.proj, 'zzz'));
    const { out, ms } = await stop(w);
    expect(ms).toBeLessThan(14_000);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('be/src/x.ts');
  });

  test('the edited file is inside the FIFO `.git` dir: a block that says git did not answer for it', async () => {
    const w = world();
    const zzz = plantFifoRepo(join(w.proj, 'zzz'));
    edit(w, join(zzz, 'src', 'y.ts'));
    const { out, ms } = await stop(w);
    expect(ms).toBeLessThan(14_000);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('git did not answer in time for `zzz`');
  });

  test('many planted FIFOs: the cumulative budget keeps the Stop under the hook timeout, and it still blocks', async () => {
    const w = world();
    edit(w, join(w.be, 'src', 'x.ts'));
    for (let i = 0; i < 12; i++) plantFifoRepo(join(w.proj, `f${String(i).padStart(2, '0')}`));
    const { out, ms } = await stop(w); // default limits: 2 s each, 4 s in all (12 x 2 s unbounded)
    expect(ms).toBeLessThan(14_000);
    expect(out.decision).toBe('block');
  });
});

// ── The post hooks' shell-write sweep ─────────────────────────────────────────────────────────

/** A post hook run for a Bash call that writes indirectly (`python3 -c`), in the project dir. The command names no
 *  file, so only the sweep's git status can find what it wrote. */
async function postHook(w: W, hook: 'post-tool-use' | 'post-tool-use-failure'): Promise<{ context: string; ms: number }> {
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
    cwd: w.proj,
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: w.sid,
        cwd: w.proj,
        hook_event_name: hook === 'post-tool-use' ? 'PostToolUse' : 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_use_id: `tu${Math.random().toString(36).slice(2, 8)}`,
        tool_input: { command: `python3 -c "pass"` },
        tool_response: { stdout: '', stderr: '', interrupted: false },
      }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...(process.env as Record<string, string>), HOME: w.home, CLAUDE_PROJECT_DIR: w.proj, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  const [text] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const out = JSON.parse(text || '{}') as { hookSpecificOutput?: { additionalContext?: string } };
  return { context: out.hookSpecificOutput?.additionalContext ?? '', ms: Date.now() - t0 };
}

describe('the post hooks run on the clock too', () => {
  for (const hook of ['post-tool-use-failure', 'post-tool-use'] as const) {
    test(`${hook}: planted FIFO \`.git\` dirs that sort first cost the confirmation budget, not 2 s each, and the write is recorded`, async () => {
      const w = world();
      expect(takeStartSnapshot(w.sid, w.proj)).toBe(false); // `be` is pinned at the start: a known repo
      for (let i = 0; i < 8; i++) plantFifoRepo(join(w.proj, `a${String(i).padStart(2, '0')}`));
      writeFileSync(join(w.be, 'src', 'x.ts'), 'export const be = 2;\n');
      const { context, ms } = await postHook(w, hook);
      // 8 x 2 s = 16 s with no clock (past PostToolUseFailure's 15 s timeout); the 4 s budget runs with the clock.
      expect(ms).toBeLessThan(9_000);
      expect(context).toContain(join(w.be, 'src', 'x.ts'));
    });
  }

  test('subagent-stop: finishing the agent\'s open Bash call reads the known repo before the walk, and the hook ends on its clock', async () => {
    const w = world();
    expect(takeStartSnapshot(w.sid, w.proj)).toBe(false); // `be` is pinned at the start: a known repo
    noteBashStart(w.sid, 'tuAgent1', w.proj, `python3 -c "pass"`, 'ag1', undefined, Date.now() - 2_000);
    for (let i = 0; i < 8; i++) plantFifoRepo(join(w.proj, `a${String(i).padStart(2, '0')}`));
    const file = join(w.be, 'src', 'x.ts');
    writeFileSync(file, 'export const be = 3;\n');
    const t0 = Date.now();
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', 'subagent-stop.ts')], {
      cwd: w.proj,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: w.sid, agent_id: 'ag1', agent_type: 'goodboy:build-backend', last_assistant_message: 'done' })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...(process.env as Record<string, string>), HOME: w.home, CLAUDE_PROJECT_DIR: w.proj, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    const [text] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    // 8 x 2 s = 16 s with no clock (past SubagentStop's 15 s timeout, which would end it with no output).
    expect(Date.now() - t0).toBeLessThan(9_000);
    expect(text).toBe('{}');
    // The open call's sweep ran on a 3 s git budget: the known repo was read before the walk spent its time.
    expect(getEditHistory(w.sid).files).toContain(file);
  });
});

// ── The other phases end at the hook's clock too ──────────────────────────────────────────────

describe('the hook clock bounds the phases after the confirmations', () => {
  test('newDeadline: never more than the hook has left; the whole budget when no clock runs', () => {
    expect(newDeadline(60_000).left()).toBeGreaterThan(50_000); // no clock: the group budget alone
    startHookClock(60);
    expect(newDeadline(60_000).left()).toBeLessThanOrEqual(60);
    Bun.sleepSync(80);
    expect(newDeadline(60_000).left()).toBeLessThanOrEqual(0); // the groups not reached then block "ran out of time"
    resetHookClock();
    expect(newDeadline(60_000).left()).toBeGreaterThan(50_000);
  });

  test('every hook clock ends before its hook timeout in hooks/hooks.json, with room for the output', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { timeout: number }[] }[]>;
    };
    const timeoutMs = (event: string): number => cfg.hooks[event]![0]!.hooks[0]!.timeout * 1000;
    const pairs: [string, number][] = [
      ['Stop', HOOK_CLOCK_MS.stop + FLUSH_PAST_CLOCK_MS],
      ['SessionStart', HOOK_CLOCK_MS.sessionStart],
      ['PreToolUse', HOOK_CLOCK_MS.preToolUse],
      ['PostToolUse', HOOK_CLOCK_MS.postToolUse],
      ['PostToolUseFailure', HOOK_CLOCK_MS.postToolUseFailure],
      ['SubagentStop', HOOK_CLOCK_MS.subagentStop],
    ];
    for (const [event, used] of pairs) expect({ event, room: timeoutMs(event) - used >= 2_000 }).toEqual({ event, room: true });
  });

  test('the Stop\'s flush wait ends at the clock plus FLUSH_PAST_CLOCK_MS, not at its own 8 s maximum', async () => {
    const w = world();
    // A transcript whose last entry is the user's prompt: the answer is "pending", so the Stop waits for it.
    const transcript = write(w.base, 't.jsonl', `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
    const t0 = Date.now();
    const proc = Bun.spawn(['bun', STOP], {
      cwd: w.proj,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: w.proj, session_id: w.sid, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...(process.env as Record<string, string>), HOME: w.home, CLAUDE_PROJECT_DIR: w.proj, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '8000', GOODBOY_TEST_HOOK_CLOCK_MS: '0' },
    });
    await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    const ms = Date.now() - t0;
    // 8 s unbounded; the clock is out at once, so the wait gets FLUSH_PAST_CLOCK_MS (2 s) at most.
    expect(ms).toBeLessThan(6_000);
    const log = readFileSync(join(tmpdir(), `goodboy-session-${w.sid}`, 'gate-log.jsonl'), 'utf8');
    const waited = /flush-wait-(?:hit|miss)\((\d+)ms\)/.exec(log);
    expect(waited).not.toBeNull();
    expect(Number(waited![1])).toBeLessThanOrEqual(FLUSH_PAST_CLOCK_MS + 300);
  });

  test('nestedStatus: the statuses end at the hook\'s clock, not at the call\'s own timeout', () => {
    const w = world();
    // `git status` reads .git/index and blocks on a FIFO there; `git rev-parse` (the walk's confirmation) does not.
    sh(w.be, 'rm -f .git/index && mkfifo .git/index');
    startHookClock(1_500);
    const t0 = Date.now();
    const r = nestedStatus(w.proj, 60_000);
    const ms = Date.now() - t0;
    // 60 s with the call's timeout alone; the clock has 1.5 s.
    expect(ms).toBeLessThan(8_000);
    expect(r).not.toBeNull();
    expect(r!.views).toEqual([]);
    expect(r!.complete).toBe(false);
  });

  test('the start snapshot runs no git once the hook has no time left, and runs it with no clock', () => {
    const w = world();
    const tips = (sid: string): string => join(tmpdir(), `goodboy-session-${sid}`, 'start-tips.json');
    const late = `${w.sid}late`;
    dirs.push(join(tmpdir(), `goodboy-session-${late}`));
    startHookClock(5);
    Bun.sleepSync(20);
    expect(hookLeft()).toBeLessThanOrEqual(0);
    // `be` is a repo itself: no walk down, so only the start-pin module's own git calls decide.
    expect(takeStartSnapshot(late, w.be)).toBe(false);
    expect(existsSync(tips(late))).toBe(false);
    resetHookClock();
    expect(takeStartSnapshot(late, w.be)).toBe(false);
    expect(existsSync(tips(late))).toBe(true);
  });
});
