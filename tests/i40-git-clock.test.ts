// v0.36.15 (#40, plan §15.31): a `.git` that git cannot read inside an untracked dir (one whose `HEAD` is a FIFO) makes
// `git status` in the outer repo wait for it. Before the fix a hook's git call used its whole limit and enough of them
// outlasted the hook (killed with no output, which passes), and the shell-write sweep dropped what it could not list, so
// the writes of a `python3 -c` call reached no edit list and no gate asked for their review or tests.
//   1. every git call of a hook stops at the hook's clock (lib/git-run.ts, lib/hook-clock.ts), PreToolUse included;
//   2. the sweep tells "git did not answer" (`statusOf` 'stalled', `nestedStatus().stalled`) from "no repo";
//   3. a call whose writes could not be listed is kept (lib/unswept.ts) and the Stop sweeps it again and blocks while
//      git does not answer (B5.95); the user's Stop marker passes it; a call kept open for a running agent is not kept.
// Repos, FIFOs and session dirs are real and temporary. The Stop, PostToolUse and PreToolUse hooks are spawned as
// Claude Code runs them. The FIFO checks of lib/unswept.ts run in a child process: a write onto a FIFO that nothing
// reads would block the test run itself if the guard against it broke.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerPath, noteBashStart } from '../lib/approval-marker';
import { commitIssueDenial, pinCommitIssueSettings } from '../lib/commit-issue';
import { ensureSessionDir, getEditHistory } from '../lib/file-tracker';
import { STOP_BLOCK_COUNTERS } from '../lib/friction';
import { spawnGit } from '../lib/git-run';
import { handoffsOf } from '../lib/push-test';
import * as pushTest from '../lib/push-test'; // `skillHandsOff` does not exist before #40: a namespace keeps the file loading there
import { HOOK_CLOCK_MS, hookLeft, resetHookClock, startHookClock } from '../lib/hook-clock';
import { MAX_STATE_BYTES } from '../lib/safe-read';
import { restoreGateState, snapshotGateState, writesGateState } from '../lib/state-guard';
import * as sweep from '../lib/write-sweep';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
setDefaultTimeout(90_000);

/** lib/unswept.ts does not exist before #40: loaded per test, so the file still loads (and fails test by test) there. */
const unsweptLib = (): Promise<typeof import('../lib/unswept')> => import('../lib/unswept');

const dirs: string[] = [];
const savedPath = process.env.PATH;
afterEach(() => {
  resetHookClock();
  sweep.resetWriteSweep();
  delete process.env.GOODBOY_TEST_CONFIRM_LIMIT_MS;
  delete process.env.GOODBOY_TEST_CONFIRM_BUDGET_MS;
  delete process.env.CLAUDE_PROJECT_DIR;
  process.env.PATH = savedPath;
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-i40-'): string {
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

/** A `.git` git cannot read: its HEAD is a FIFO, so a git call that reaches it (a status of the repo around it) blocks. */
function plantDecoy(parent: string, name = 'zzz'): string {
  const z = join(parent, name);
  mkdirSync(join(z, '.git', 'objects'), { recursive: true });
  mkdirSync(join(z, '.git', 'refs'), { recursive: true });
  expect(Bun.spawnSync(['mkfifo', join(z, '.git', 'HEAD')]).exitCode).toBe(0);
  return z;
}

let counter = 0;
const newSid = (): string => {
  const sid = `i40${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
  return sid;
};

interface W {
  base: string;
  /** The repo, which is the project dir. */
  r: string;
  /** A tracked subdir of it: where the calls run, and where the decoy goes. */
  sub: string;
  home: string;
  sid: string;
}
/** A repo `r` with one commit and a tracked subdir `sub`. No decoy yet. */
function world(): W {
  const base = tmp();
  const r = join(base, 'r');
  write(r, 'src/x.ts', 'export const x = 1;\n');
  write(r, 'sub/keep.txt', 'keep\n');
  sh(r, `${GIT_INIT} && git add -A && git commit -q -m "init #40"`);
  return { base, r, sub: join(r, 'sub'), home: tmp('goodboy-i40-home-'), sid: newSid() };
}

const PY = `python3 -c "open('out.txt','w').write('x')"`;
/** A Bash call that wrote `out.txt` in `sub` after it started (as `python3 -c` would), reported by its post hook. */
function pyCall(w: W, tuid: string, opts: Parameters<typeof sweep.afterBash>[5] = { gitTimeoutMs: 1_000 }, agent?: string): ReturnType<typeof sweep.afterBash> {
  noteBashStart(w.sid, tuid, w.sub, PY, agent);
  writeFileSync(join(w.sub, 'out.txt'), 'x');
  return sweep.afterBash(w.sid, tuid, w.sub, PY, agent, opts);
}
const gateLog = (sid: string): string => {
  try {
    return readFileSync(join(tmpdir(), `goodboy-session-${sid}`, 'gate-log.jsonl'), 'utf8');
  } catch {
    return '';
  }
};

// ── 1. lib/git-run.ts: every call stops at the hook's clock ─────────────────────────────────────────────

describe('spawnGit stops at the hook clock', () => {
  test('a clock that ran out: git does not run, and the call is stalled (a fake git on PATH is never started)', () => {
    const w = world();
    const mark = join(w.base, 'git-ran.txt');
    const bin = join(w.base, 'bin');
    write(bin, 'git', `#!/bin/sh\necho "$@" >> '${mark}'\nexec '${Bun.which('git')}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    // Control: with no clock the fake runs.
    expect(spawnGit(w.r, ['rev-parse', '--show-cdup'])).toMatchObject({ code: 0, ran: true, stalled: false });
    expect(existsSync(mark)).toBe(true);
    rmSync(mark);

    startHookClock(5);
    Bun.sleepSync(40);
    expect(hookLeft()).toBeLessThanOrEqual(0);
    expect(spawnGit(w.r, ['rev-parse', '--show-cdup'])).toMatchObject({ code: -1, ran: false, stalled: true });
    // A filter command asks for the filter list first: that call is not run either.
    expect(spawnGit(w.r, ['status', '--porcelain'])).toMatchObject({ code: -1, ran: false, stalled: true });
    expect(existsSync(mark)).toBe(false);

    // The clock stopped (the CLI, a test): the same call runs again.
    resetHookClock();
    expect(spawnGit(w.r, ['rev-parse', '--show-cdup'])).toMatchObject({ code: 0, ran: true, stalled: false });
    expect(existsSync(mark)).toBe(true);
  });

  test('a clock with little time left cuts a stalling call to it: a decoy status returns about then, stalled', () => {
    const w = world();
    plantDecoy(w.sub);
    startHookClock(1_500);
    const t0 = Date.now();
    // The call's own limit is 8 s; the clock has 1.5 s.
    const r = spawnGit(w.r, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 8_000 });
    const ms = Date.now() - t0;
    expect(r.stalled).toBe(true);
    expect(r.ran).toBe(true); // git was started and cut off, not skipped
    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThan(4_500);
  });

  test('the caller\'s own `left` still wins when it is the smaller one', () => {
    const w = world();
    plantDecoy(w.sub);
    startHookClock(30_000);
    const t0 = Date.now();
    const r = spawnGit(w.r, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: 20_000, left: () => 700 });
    expect(r.stalled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4_000);
  });

  test('a stalled filter listing makes a filter command say stalled, not a plain "not run"', () => {
    const w = world();
    // `git config` in a dir whose `.git` has a FIFO HEAD blocks reading it: the filter listing stalls.
    const z = plantDecoy(w.sub);
    const t0 = Date.now();
    const r = spawnGit(z, ['status', '--porcelain'], { timeoutMs: 1_000 });
    expect(r).toMatchObject({ code: -1, ran: false, stalled: true });
    expect(Date.now() - t0).toBeLessThan(6_000);
    // A filter listing that fails (a config git cannot parse) is still a plain "not run": the caller reads that as "git failed".
    writeFileSync(join(w.r, '.git', 'config'), '[broken\n');
    expect(spawnGit(w.r, ['status', '--porcelain'], { timeoutMs: 5_000 })).toMatchObject({ code: -1, ran: false, stalled: false });
  });
});

// ── 2. lib/write-sweep.ts: statusOf and nestedStatus tell a stall from "no repo" ──────────────────────

describe('statusOf', () => {
  test('stalled with a FIFO-HEAD decoy in an untracked dir; null outside any repo; the files otherwise', () => {
    const w = world();
    const z = plantDecoy(w.sub);
    const t0 = Date.now();
    expect(sweep.statusOf(w.sub, 1_000)).toBe('stalled');
    expect(Date.now() - t0).toBeLessThan(6_000);
    // The old shape: no list for a git that did not answer.
    expect(sweep.statusFiles(w.sub, 1_000)).toBeNull();

    expect(sweep.statusOf(tmp(), 5_000)).toBeNull();
    expect(sweep.statusFiles(tmp(), 5_000)).toBeNull();

    rmSync(z, { recursive: true, force: true });
    const f = write(w.sub, 'out.txt', 'x');
    expect(sweep.statusOf(w.sub, 5_000)).toEqual({ top: w.r, files: [f] });
    expect(sweep.statusFiles(w.sub, 5_000)).toEqual({ top: w.r, files: [f] });
  });

  test('AC-13: a corrupt index and a gitfile naming a missing gitdir are stalled (a repo git cannot list); no repo and a missing dir are null', () => {
    const w = world();
    const gitfile = join(w.base, 'gitfile');
    write(gitfile, '.git', 'gitdir: /nonexistent/x/.git\n');
    expect(sweep.statusOf(gitfile, 5_000)).toBe('stalled'); // git says "not a git repository: <path>": a repo it cannot read
    expect(sweep.statusOf(join(w.base, 'nope'), 5_000)).toBeNull(); // the dir is gone
    expect(sweep.statusOf(tmp(), 5_000)).toBeNull(); // "not a git repository (or any of the parent directories)"
    writeFileSync(join(w.r, '.git', 'index'), 'not an index\n');
    expect(sweep.statusOf(w.sub, 5_000)).toBe('stalled'); // `status` fails fast: the changes are unlisted, not none
    expect(sweep.statusFiles(w.sub, 5_000)).toBeNull();
  });

  test('a clock that ran out is stalled before any git runs', () => {
    const w = world();
    startHookClock(5);
    Bun.sleepSync(40);
    expect(sweep.statusOf(w.sub, 5_000)).toBe('stalled');
  });

  test('the sweep keeps a call whose repo git cannot list (a corrupt index), not only a stall', async () => {
    const U = await unsweptLib();
    const w = world();
    writeFileSync(join(w.r, '.git', 'index'), 'not an index\n');
    const res = pyCall(w, 'tu13', { gitTimeoutMs: 5_000 });
    expect(res.swept).toBe(false);
    expect(U.readUnswept(w.sid).calls).toHaveLength(1);
    expect(U.readUnswept(w.sid).calls[0]!.stalled).toEqual([w.sub]);
  });
});

describe('nestedStatus names what git did not answer for', () => {
  /** A plain `proj/` holding the repo `be`. */
  function proj(): { proj: string; be: string } {
    const base = tmp();
    const p = join(base, 'proj');
    const be = join(p, 'be');
    write(be, 'src/x.ts', 'export const be = 1;\n');
    sh(be, `${GIT_INIT} && git add -A && git commit -q -m "init #40"`);
    return { proj: p, be };
  }

  test('a nested repo whose status stalls (a FIFO index) is named, and so is the repo the time left unread after it', () => {
    const { proj: p, be } = proj();
    const fe = join(p, 'fe');
    write(fe, 'src/y.ts', 'export const fe = 1;\n');
    sh(fe, `${GIT_INIT} && git add -A && git commit -q -m "init #40"`);
    sh(be, 'rm -f .git/index && mkfifo .git/index'); // `git status` reads the index and blocks; `rev-parse` does not
    const t0 = Date.now();
    // One budget for the call: `be` (first in the walk's order) uses it all, so `fe` is never asked.
    const s = sweep.nestedStatus(p, 1_500)!;
    expect(Date.now() - t0).toBeLessThan(9_000);
    expect(s.stalled).toEqual([be, fe]);
    expect(s.complete).toBe(false);
    expect(s.views).toEqual([]);
  });

  test('a nested repo that answers is a view, not a stall; the one whose status stalls is named alone', () => {
    const { proj: p, be } = proj();
    write(be, 'src/x.ts', 'export const be = 2;\n');
    const zz = join(p, 'zz');
    write(zz, 'src/y.ts', 'export const zz = 1;\n');
    sh(zz, `${GIT_INIT} && git add -A && git commit -q -m "init #40"`);
    sh(zz, 'rm -f .git/index && mkfifo .git/index');
    // `be` comes first in the walk's order and answers at once; `zz` waits on its index until the budget ends.
    const s = sweep.nestedStatus(p, 1_500)!;
    expect(s.stalled).toEqual([zz]);
    expect(s.views.map((v) => v.top)).toEqual([be]);
    expect(s.views[0]!.files).toEqual([join(be, 'src', 'x.ts')]);
    expect(s.complete).toBe(false);
  });

  test('a dir the walk could not confirm (a FIFO `.git` that is no repo) is named', () => {
    const { proj: p } = proj();
    process.env.GOODBOY_TEST_CONFIRM_LIMIT_MS = '500';
    const planted = plantDecoy(p, 'planted');
    const s = sweep.nestedStatus(p, 20_000)!;
    expect(s.stalled).toEqual([planted]);
    expect(s.complete).toBe(false);
    expect(s.views).toHaveLength(1); // the real repo `be`
  });

  test('the project dir is named when the time ran out before the walk', () => {
    const { proj: p } = proj();
    const s = sweep.nestedStatus(p, 0)!;
    expect(s.views).toEqual([]);
    expect(s.complete).toBe(false);
    expect(s.stalled).toEqual([resolve(p)]);
  });

  test('a walk cap (a dir deeper than the walk goes) leaves the sweep incomplete with no stall named', () => {
    const { proj: p, be } = proj();
    const fe = join(p, 'fe');
    sh(p, `mkdir fe && cd fe && ${GIT_INIT}`);
    sh(fe, 'git commit -q --allow-empty -m "init #40"');
    const control = sweep.nestedStatus(p, 20_000)!; // everything answers: complete, nothing named
    expect(control).toMatchObject({ complete: true, stalled: [] });
    mkdirSync(join(p, 'a', 'b', 'c', 'd', 'e'), { recursive: true });
    sweep.resetWriteSweep();
    const capped = sweep.nestedStatus(p, 20_000)!;
    expect(capped.complete).toBe(false);
    expect(capped.stalled).toEqual([]);
    expect(capped.views.map((v) => v.top).sort()).toEqual([be, fe].sort());
  });
});

// ── 3. the call is kept: afterBash notes it, retryUnswept sweeps it again ───────────────────────────────

describe('a Bash call whose writes git could not list is kept', () => {
  test('afterBash with the decoy keeps the python write (before #40: nothing); retryUnswept keeps it while the decoy is there and records the write once it is gone', async () => {
    const U = await unsweptLib();
    const w = world();
    const z = plantDecoy(w.sub);
    const res = pyCall(w, 'tu6');
    expect(res.swept).toBe(false);
    const kept = U.readUnswept(w.sid).calls;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ tuid: 'tu6', command: PY, stalled: [w.sub], startDir: w.sub });
    expect(kept[0]!.dirs).toEqual([w.sub]);
    expect(kept[0]!.since).toBeGreaterThan(Date.now() - 60_000);
    expect(getEditHistory(w.sid).files).toEqual([]); // the write is in no edit list yet
    expect(gateLog(w.sid)).toContain(`unswept: ${w.sub}`);

    // Still there: kept, nothing recorded.
    const again = sweep.retryUnswept(w.sid, 1_200);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ tuid: 'tu6', stalled: [w.sub] });
    expect(U.readUnswept(w.sid).calls).toHaveLength(1);
    expect(getEditHistory(w.sid).files).toEqual([]);

    // The decoy removed: the write is recorded as an edit, and the record is empty.
    rmSync(z, { recursive: true, force: true });
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
    expect(getEditHistory(w.sid).files).toEqual([join(w.sub, 'out.txt')]);
    expect(U.readUnswept(w.sid)).toEqual({ calls: [], refused: false });
    expect(gateLog(w.sid)).toContain('indirect-late(1)');
    // A call with no record left: nothing to do.
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
  });

  test('with no decoy afterBash lists the write as before and keeps nothing', async () => {
    const U = await unsweptLib();
    const w = world();
    const res = pyCall(w, 'tu6b', { gitTimeoutMs: 5_000 });
    expect(res.swept).toBeUndefined();
    expect(res.context).toContain(join(w.sub, 'out.txt'));
    expect(U.readUnswept(w.sid).calls).toEqual([]);
  });

  test('a call kept open for a running agent (keepOpen) is not kept, and neither is the agent call the Stop finishes with keepAgentsOpen; one it does not keep open is', async () => {
    const U = await unsweptLib();
    const w = world();
    plantDecoy(w.sub);
    pyCall(w, 'tu7a', { gitTimeoutMs: 1_000, keepOpen: true });
    expect(U.readUnswept(w.sid).calls).toEqual([]);
    // skipGit (the Stop ran out of sweep time) with keepOpen: nothing either.
    pyCall(w, 'tu7b', { skipGit: true, keepOpen: true });
    expect(U.readUnswept(w.sid).calls).toEqual([]);

    // The Stop's own path: an agent's call kept open for a running subagent is swept again later from its old start.
    startHookClock(1_500);
    noteBashStart(w.sid, 'tuAg', w.sub, PY, 'ag1');
    writeFileSync(join(w.sub, 'out.txt'), 'y');
    sweep.finishOpenBashCalls(w.sid, { keepAgentsOpen: true });
    expect(U.readUnswept(w.sid).calls).toEqual([]);
    // Not kept open (no running subagent): finished, and kept in the record for the Stop's retry, with its agent.
    sweep.finishOpenBashCalls(w.sid, {});
    const kept = U.readUnswept(w.sid).calls;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ tuid: 'tuAg', agent: 'ag1', command: PY });
  });

  test('a Stop that ran out of sweep time (skipGit) keeps the call, naming where it started', async () => {
    const U = await unsweptLib();
    const w = world();
    const res = pyCall(w, 'tu7c', { skipGit: true });
    expect(res.swept).toBe(false);
    const kept = U.readUnswept(w.sid).calls;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ tuid: 'tu7c', command: PY, stalled: [w.sub], dirs: [w.sub] });
    // Nothing stalls now: the retry lists the write the skipped sweep did not.
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
    expect(getEditHistory(w.sid).files).toEqual([join(w.sub, 'out.txt')]);
  });

  test('an incomplete sweep that is no stall (a dir in no repo, a walk cap) keeps nothing', async () => {
    const U = await unsweptLib();
    const w = world();
    const plain = tmp();
    noteBashStart(w.sid, 'tu7d', plain, PY);
    writeFileSync(join(plain, 'out.txt'), 'x');
    const res = sweep.afterBash(w.sid, 'tu7d', plain, PY, undefined, { gitTimeoutMs: 5_000 });
    expect(res.swept).toBe(false); // the sweep did not run in full ...
    expect(U.readUnswept(w.sid).calls).toEqual([]); // ... but no git call stalled: nothing to try again
  });

  test('the record keeps what git did list: a stalled dir and a listed repo of one call', async () => {
    const U = await unsweptLib();
    const w = world();
    const other = join(w.base, 'other');
    write(other, 'a.txt', 'a\n');
    sh(other, `${GIT_INIT} && git add -A && git commit -q -m "init #40"`);
    plantDecoy(w.sub);
    // The call started in `other` and ended in `sub`: both repos are swept; only the decoy's stalls.
    noteBashStart(w.sid, 'tu7e', other, PY);
    writeFileSync(join(other, 'out.txt'), 'x');
    sweep.afterBash(w.sid, 'tu7e', w.sub, PY, undefined, { gitTimeoutMs: 1_000 });
    expect(getEditHistory(w.sid).files).toEqual([join(other, 'out.txt')]); // what git did list is recorded now
    const kept = U.readUnswept(w.sid).calls;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.stalled).toEqual([w.sub]);
    expect(kept[0]!.dirs.sort()).toEqual([other, w.sub].sort());
  });
});

describe('retryUnswept', () => {
  test('with no time left it keeps every call unread; a file put back with its start content is no write', async () => {
    const U = await unsweptLib();
    const w = world();
    const mk = (tuid: string, extra: Partial<import('../lib/unswept').UnsweptCall> = {}) => ({ tuid, since: Date.now() - 60_000, dirs: [w.sub], command: PY, stalled: [w.sub], ...extra });
    U.noteUnswept(w.sid, mk('a'));
    U.noteUnswept(w.sid, mk('b'));
    const t0 = Date.now();
    expect(sweep.retryUnswept(w.sid, 0).map((c) => c.tuid)).toEqual(['a', 'b']); // no git ran: the budget was 0
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(U.readUnswept(w.sid).calls.map((c) => c.tuid)).toEqual(['a', 'b']);
    expect(getEditHistory(w.sid).files).toEqual([]);

    // (#36) A file the call put back with the content it had at its start is no write of it.
    const f = write(w.sub, 'back.txt', 'same\n');
    sh(w.r, 'git add -A');
    U.writeUnswept(w.sid, [mk('c', { status: { top: w.r, files: [f], hashes: { [f]: sweep.contentHash(f)! } } })]);
    write(w.sub, 'back.txt', 'same\n'); // touched now, same content
    write(w.sub, 'real.txt', 'new\n');
    sh(w.r, 'git reset -q');
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
    expect(getEditHistory(w.sid).files).toEqual([join(w.sub, 'real.txt')]);
  });

  test('calls with the same dirs share one look at git within a retry; each is judged by its own start', async () => {
    const U = await unsweptLib();
    const w = world();
    const mark = join(w.base, 'git-calls.txt');
    const bin = join(w.base, 'bin');
    write(bin, 'git', `#!/bin/sh\necho "$@" >> '${mark}'\nexec '${Bun.which('git')}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const other = join(w.base, 'other');
    write(other, 'a.txt', 'a\n');
    sh(other, `${GIT_INIT} && git add -A && git commit -q -m "init #40"`);
    const f = write(w.sub, 'out.txt', 'x');
    const g = write(other, 'new.txt', 'y');
    const mk = (tuid: string, dirs: string[], since: number) => ({ tuid, since, dirs, command: PY, stalled: [dirs[0]!] });
    U.writeUnswept(w.sid, [mk('a', [w.sub], Date.now() - 60_000), mk('b', [w.sub], Date.now() + 60_000), mk('c', [other], Date.now() - 60_000)]);
    rmSync(mark, { force: true });
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
    const statuses = readFileSync(mark, 'utf8').split('\n').filter((l) => / status /.test(` ${l} `)).length;
    expect(statuses).toBe(2); // one for `sub`'s repo (calls a and b), one for `other`'s (call c)
    expect(getEditHistory(w.sid).files.sort()).toEqual([f, g].sort()); // b started after the file: not its write
  });

  test('a record too large to read stands as one call kept for this Stop and is emptied', async () => {
    const U = await unsweptLib();
    const w = world();
    const p = join(ensureSessionDir(w.sid), U.UNSWEPT_FILE);
    writeFileSync(p, '');
    truncateSync(p, MAX_STATE_BYTES + 1);
    expect(U.readUnswept(w.sid)).toEqual({ calls: [], refused: true });
    const kept = sweep.retryUnswept(w.sid, 1_000);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.command).toContain('could not read its record');
    expect(readFileSync(p, 'utf8')).toBe('');
    expect(gateLog(w.sid)).toContain('unswept record unreadable');
    expect(sweep.retryUnswept(w.sid, 1_000)).toEqual([]);
  });
});

// ── lib/unswept.ts: the record ──────────────────────────────────────────────────────────────────────

describe('the record file', () => {
  test('lines that do not parse are skipped; the fields kept as written', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
    const good = { tuid: 'a', since: 5, dirs: ['/x'], command: 'c', stalled: ['/x'], agent: 'ag', status: { top: '/x', files: ['/x/f'] } };
    const lines = [
      JSON.stringify(good),
      'not json',
      '',
      JSON.stringify({ ...good, since: 'x' }),
      JSON.stringify({ ...good, since: null }),
      JSON.stringify({ ...good, dirs: [1] }),
      JSON.stringify({ ...good, stalled: 'no' }),
      JSON.stringify({ ...good, tuid: 3 }),
      JSON.stringify({ ...good, command: 7 }),
      JSON.stringify({ ...good, tuid: 'b', status: { top: 1, files: [] }, agent: 4 }),
      JSON.stringify({ tuid: 'c', since: 1, dirs: ['/y'], command: 'z', stalled: [], startDir: '/y' }),
      JSON.stringify({ tuid: 'd', since: 1, dirs: [], command: 'lost', stalled: [], startDir: 3 }), // the lost record's shape reads back
    ];
    writeFileSync(p, `${lines.join('\n')}\n`);
    const { calls, refused } = U.readUnswept(sid);
    expect(refused).toBe(false);
    expect(calls).toEqual([good, { tuid: 'b', since: 5, dirs: ['/x'], command: 'c', stalled: ['/x'] }, { tuid: 'c', since: 1, dirs: ['/y'], command: 'z', stalled: [], startDir: '/y' }, { tuid: 'd', since: 1, dirs: [], command: 'lost', stalled: [] }]);
  });

  test('AC-14: there is no cap: 300 appended lines do not evict a genuine call; a command keeps 2 000 characters', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const genuine = { tuid: 'genuine', since: 1, dirs: ['/x'], command: 'python3 real.py', stalled: ['/x'] };
    U.noteUnswept(sid, genuine);
    for (let i = 0; i < 300; i++) U.noteUnswept(sid, { tuid: `forged${i}`, since: 2, dirs: ['/y'], command: i === 299 ? 'x'.repeat(5_000) : 'c', stalled: ['/y'] });
    const back = U.readUnswept(sid).calls;
    expect(back).toHaveLength(301);
    expect(back[0]).toEqual(genuine);
    expect(back[300]!.command).toHaveLength(2_000);
    // writeUnswept writes every call it is given.
    U.writeUnswept(sid, back);
    expect(U.readUnswept(sid).calls).toHaveLength(301);
    U.writeUnswept(sid, []);
    expect(U.readUnswept(sid)).toEqual({ calls: [], refused: false });
  });

  test('reading removes nothing: a link or a directory in the record\'s place is refused and left as it is', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
    const target = write(tmp(), 'target.txt', 'untouched\n');
    symlinkSync(target, p);
    expect(U.readUnswept(sid)).toEqual({ calls: [], refused: true });
    expect(lstatSync(p).isSymbolicLink()).toBe(true);
    rmSync(p);
    mkdirSync(p);
    expect(U.readUnswept(sid)).toEqual({ calls: [], refused: true });
    expect(lstatSync(p).isDirectory()).toBe(true);
  });

  test('a directory or a link in the record\'s place is removed before a write: the link\'s target is never written, and the lost calls are marked', async () => {
    const U = await unsweptLib();
    const call = { tuid: 'n', since: 1, dirs: ['/x'], command: 'c', stalled: ['/x'] };
    const sid = newSid();
    const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
    mkdirSync(join(p, 'inner'), { recursive: true });
    U.noteUnswept(sid, call);
    expect(lstatSync(p).isFile()).toBe(true);
    const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ ...U.LOST_RECORD, since: expect.any(Number) }, call]); // what stood there is gone: the marker comes before the call

    const sid2 = newSid();
    const p2 = join(ensureSessionDir(sid2), U.UNSWEPT_FILE);
    const target = write(tmp(), 'target.txt', 'untouched\n');
    symlinkSync(target, p2);
    U.noteUnswept(sid2, call);
    expect(lstatSync(p2).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
    expect(readFileSync(p2, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([{ ...U.LOST_RECORD, since: expect.any(Number) }, call]);

    // writeUnswept replaces a non-regular entry the same way.
    const sid3 = newSid();
    const p3 = join(ensureSessionDir(sid3), U.UNSWEPT_FILE);
    mkdirSync(p3);
    U.writeUnswept(sid3, [call]);
    expect(lstatSync(p3).isFile()).toBe(true);
    expect(U.readUnswept(sid3).calls).toEqual([call]);
  });

  test('a record replaced by a directory: the next retry returns the lost-record call once (it blocks that Stop) and drops it from the file', async () => {
    const U = await unsweptLib();
    const w = world();
    const p = join(ensureSessionDir(w.sid), U.UNSWEPT_FILE);
    mkdirSync(p);
    U.noteUnswept(w.sid, { tuid: 'n', since: Date.now() - 60_000, dirs: [w.sub], command: PY, stalled: [w.sub] });
    const kept = sweep.retryUnswept(w.sid, 5_000);
    expect(kept).toEqual([{ ...U.LOST_RECORD, since: expect.any(Number) }]); // git answers for `n` now: only what the lost record held is unknown
    expect(readFileSync(p, 'utf8')).toBe('');
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
  });
});

describe('the record is best-effort', () => {
  test('a session dir that cannot be written loses the note without throwing (the hook goes on)', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const dir = ensureSessionDir(sid);
    chmodSync(dir, 0o500);
    try {
      expect(() => U.noteUnswept(sid, { tuid: 'n', since: 1, dirs: ['/x'], command: 'c', stalled: ['/x'] })).not.toThrow();
      expect(() => U.writeUnswept(sid, [])).not.toThrow();
      expect(U.readUnswept(sid)).toEqual({ calls: [], refused: false });
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

test('a read that throws (a session id that is no string) reads as a refused record, not an error', async () => {
  const U = await unsweptLib();
  expect(U.readUnswept(5 as unknown as string)).toEqual({ calls: [], refused: true });
});

describe('unsweptReason', () => {
  const call = (over: Partial<import('../lib/unswept').UnsweptCall> = {}): import('../lib/unswept').UnsweptCall => ({ tuid: 't', since: 1, dirs: ['/p/sub'], command: 'python3 -c "x"\n   more', stalled: ['/p/sub'], ...over });

  test('names the command, the dir (relative to the project) and the find command', async () => {
    const U = await unsweptLib();
    const reason = U.unsweptReason([call()], '/p');
    expect(reason).toContain('1 Bash command ');
    expect(reason).toContain('`python3 -c "x" more`');
    expect(reason).toContain('git did not list the changes in `sub` (it did not answer in time, or failed)');
    expect(reason).toContain('A repository git reports as broken');
    expect(reason).toContain("`find sub -mindepth 2 -path '*/.git/HEAD' ! -type f`");
    expect(reason).toContain('only the user can let this Stop pass otherwise');
  });

  test('the project dir itself is `.`; a dir outside it keeps its absolute path; many calls and dirs are counted', async () => {
    const U = await unsweptLib();
    expect(U.unsweptReason([call({ stalled: ['/p'] })], '/p')).toContain('changes in `.`');
    expect(U.unsweptReason([call({ stalled: ['/q/other'] })], '/p')).toContain('changes in `/q/other`');
    expect(U.unsweptReason([call({ stalled: ['/pp/x'] })], '/p')).toContain('changes in `/pp/x`'); // a sibling that shares the prefix
    const many = U.unsweptReason(
      ['a', 'b', 'c', 'd'].map((c, i) => call({ command: `cmd-${c}`, stalled: [`/p/d${i}`, `/p/e${i}`] })),
      '/p',
    );
    expect(many).toContain('4 Bash commands');
    expect(many).toContain('`cmd-c`, …');
    expect(many).not.toContain('cmd-d');
    expect(many).toContain('and 3 more');
  });

  test('a call with nothing named (a record that could not be read) says so, and searches the project dir', async () => {
    const U = await unsweptLib();
    const reason = U.unsweptReason([call({ command: '(goodboy could not read its record of these commands)', dirs: [], stalled: [] })], '/p');
    expect(reason).toContain('goodboy could not read its record of them');
    expect(reason).toContain("`find . -mindepth 2");
  });
});

// ── FIFO in the record's place (a child process: a write onto a FIFO with no reader blocks) ─────────────

const FIFO_CHILD = `
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const [root, sid, mode] = process.argv.slice(2);
const { ensureSessionDir } = await import(root + '/lib/file-tracker');
const { retryUnswept } = await import(root + '/lib/write-sweep');
const U = await import(root + '/lib/unswept');
const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
const t0 = Date.now();
let kept = null;
if (mode === 'retry') kept = retryUnswept(sid, 1000);
else U.noteUnswept(sid, { tuid: 'n', since: 1, dirs: ['/x'], command: 'c', stalled: ['/x'] });
console.log(JSON.stringify({ ms: Date.now() - t0, kept, isFile: existsSync(p) && lstatSync(p).isFile(), size: existsSync(p) ? statSync(p).size : -1, lines: existsSync(p) && lstatSync(p).isFile() ? readFileSync(p, 'utf8').split('\\n').filter((l) => l !== '') : [] }));
`;
function fifoChild(mode: 'retry' | 'note'): { exit: number | null; out: { ms: number; kept: { command: string }[] | null; isFile: boolean; size: number; lines: string[] } | null; err: string } {
  const sid = newSid();
  const p = join(ensureSessionDir(sid), 'unswept.jsonl');
  expect(Bun.spawnSync(['mkfifo', p]).exitCode).toBe(0);
  const script = write(tmp(), 'fifo-child.ts', FIFO_CHILD);
  const r = Bun.spawnSync(['bun', script, ROOT, sid, mode], { stdout: 'pipe', stderr: 'pipe', timeout: 20_000, env: process.env as Record<string, string> });
  const text = r.stdout.toString().trim();
  return { exit: r.exitCode, out: text === '' ? null : JSON.parse(text), err: r.stderr.toString() };
}

describe('an unswept.jsonl replaced by a FIFO', () => {
  test('noteUnswept removes the FIFO and writes the lost-record marker and the call to a regular file; nothing hangs', () => {
    const r = fifoChild('note');
    expect({ exit: r.exit, err: r.err }).toEqual({ exit: 0, err: '' });
    expect(r.out!.isFile).toBe(true);
    expect(r.out!.lines.map((l) => (JSON.parse(l) as { tuid: string }).tuid)).toEqual(['', 'n']);
    expect(r.out!.ms).toBeLessThan(5_000);
  });

  test('retryUnswept removes the FIFO, returns one call standing for the record it could not read, and does not hang', () => {
    const r = fifoChild('retry');
    expect({ exit: r.exit, err: r.err }).toEqual({ exit: 0, err: '' });
    expect(r.out!.ms).toBeLessThan(5_000);
    expect(r.out!.kept).toHaveLength(1);
    expect(r.out!.kept![0]!.command).toContain('could not read its record');
    expect(r.out!.isFile).toBe(true); // the FIFO is gone: the record is an empty regular file again
    expect(r.out!.size).toBe(0);
  });
});

// ── the state guard keeps the record append-only for a model Bash call ─────────────────────────────────

describe('the state guard and unswept.jsonl', () => {
  const calls = [1, 2].map((i) => ({ tuid: `t${i}`, since: i, dirs: ['/x'], command: `c${i}`, stalled: ['/x'] }));
  const guarded = async (): Promise<{ sid: string; p: string; before: string }> => {
    const U = await unsweptLib();
    const sid = newSid();
    U.writeUnswept(sid, calls);
    const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
    return { sid, p, before: readFileSync(p, 'utf8') };
  };

  test('a call that removes, truncates or rewrites the lines gets them back; one that appends keeps its line', async () => {
    const { sid, p, before } = await guarded();
    snapshotGateState(sid, 'tu11a');
    rmSync(p);
    expect(restoreGateState(sid, 'tu11a')).toEqual(['unswept.jsonl']);
    expect(readFileSync(p, 'utf8')).toBe(before);

    snapshotGateState(sid, 'tu11b');
    writeFileSync(p, '');
    expect(restoreGateState(sid, 'tu11b')).toEqual(['unswept.jsonl']);
    expect(readFileSync(p, 'utf8')).toBe(before);

    snapshotGateState(sid, 'tu11c');
    writeFileSync(p, `${JSON.stringify({ tuid: 'forged', since: 1, dirs: ['/y'], command: 'c', stalled: [] })}\n`);
    expect(restoreGateState(sid, 'tu11c')).toEqual(['unswept.jsonl']);
    expect(readFileSync(p, 'utf8').startsWith(before)).toBe(true); // the old lines are back in front

    snapshotGateState(sid, 'tu11d');
    expect(restoreGateState(sid, 'tu11d')).toEqual([]); // untouched: nothing to put back
  });

  test('a FIFO or a directory put in its place is replaced by the old lines', async () => {
    const { sid, p, before } = await guarded();
    snapshotGateState(sid, 'tu11e');
    rmSync(p);
    expect(Bun.spawnSync(['mkfifo', p]).exitCode).toBe(0);
    expect(restoreGateState(sid, 'tu11e')).toEqual(['unswept.jsonl']);
    expect(readFileSync(p, 'utf8')).toBe(before);

    snapshotGateState(sid, 'tu11f');
    rmSync(p);
    mkdirSync(p);
    expect(restoreGateState(sid, 'tu11f')).toEqual(['unswept.jsonl']);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  test('a command that names the record with a mutating program is denied up front', () => {
    expect(writesGateState('rm -f "$TMPDIR"/goodboy-session-*/unswept.jsonl')).toBe(true);
    expect(writesGateState(': > /tmp/goodboy-session-x/unswept.jsonl')).toBe(true);
    expect(writesGateState('cat /tmp/goodboy-session-x/unswept.jsonl')).toBe(false);
  });
});

test('the friction notice counts the sweep block', () => {
  expect(STOP_BLOCK_COUNTERS['.goodboy-sweep-retry-count.txt']).toBe('sweep');
});

// ── what a stalled git means to the other rules that ask it ──────────────────────────────────────────

describe('retryUnswept without a start status', () => {
  test('AC-15: a directory the command names (`mv <olddir> <repo>/`) counts whole once the stall clears, though its files keep their old times', async () => {
    const U = await unsweptLib();
    const w = world();
    const moved = write(w.r, 'olddir/f.txt', 'moved\n'); // as if `mv` put it here: nothing in git's status marks it as new
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(moved, past, past);
    const cmd = `mv ${join(w.base, 'olddir')} ${w.r}/`;
    // The call's own sweep stalled, and so did the start's status: the record has none. Its start is after the file's
    //   times (a file's ctime is when it was last touched here), so only the named directory brings it in.
    U.noteUnswept(w.sid, { tuid: 'tu15', since: Date.now() + 60_000, dirs: [w.r], command: cmd, stalled: [w.r] });
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
    expect(getEditHistory(w.sid).files).toEqual([moved]);
    expect(U.readUnswept(w.sid).calls).toEqual([]);

    // A command that names nothing of it: the old file is no write of the call.
    const sid2 = newSid();
    U.noteUnswept(sid2, { tuid: 'tu15b', since: Date.now() + 60_000, dirs: [w.r], command: 'python3 -c "pass"', stalled: [w.r] });
    expect(sweep.retryUnswept(sid2, 5_000)).toEqual([]);
    expect(getEditHistory(sid2).files).toEqual([]);
  });
});

describe('retryUnswept: the start dir and the lost record', () => {
  test('AC-15b: the named paths of a command are read from the dir it started in (startDir), not from the last dir it swept', async () => {
    const U = await unsweptLib();
    const w = world();
    const moved = write(w.r, 'olddir/f.txt', 'moved\n');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(moved, past, past);
    const elsewhere = tmp();
    // `mv ../olddir .` run from `sub`: it names <repo>/olddir only relative to where it started.
    U.noteUnswept(w.sid, { tuid: 'tu15c', since: Date.now() + 60_000, dirs: [w.r, elsewhere], startDir: w.sub, command: 'mv ../olddir .', stalled: [w.r] });
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
    expect(getEditHistory(w.sid).files).toEqual([moved]);
  });

  test('a lost-record call in the file is returned once, with the calls still kept after it, and dropped from the file', async () => {
    const U = await unsweptLib();
    const w = world();
    const z = plantDecoy(w.sub);
    const call = { tuid: 'k', since: Date.now() - 60_000, dirs: [w.sub], command: PY, stalled: [w.sub] };
    U.writeUnswept(w.sid, [U.LOST_RECORD, call]);
    const first = sweep.retryUnswept(w.sid, 1_200);
    expect(first.map((c) => c.tuid)).toEqual(['', 'k']);
    expect(U.readUnswept(w.sid).calls.map((c) => c.tuid)).toEqual(['k']); // only what can still be listed stays
    rmSync(z, { recursive: true, force: true });
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
  });

  test('the library index exports the record and its retry', async () => {
    const lib = await import('../lib');
    expect(typeof lib.noteUnswept).toBe('function');
    expect(typeof lib.readUnswept).toBe('function');
    expect(typeof lib.retryUnswept).toBe('function');
    expect(lib.UNSWEPT_FILE).toBe('unswept.jsonl');
  });
});

describe('AC-18: a hand-off skill (/ship) hands off HEAD unless git says there is no commit', () => {
  test('a clock that ran out: it hands off (the unknown tree is checked, not skipped); no commit: no hand-off; a commit: a hand-off', () => {
    const w = world();
    expect(pushTest.skillHandsOff(w.r)).toBe(true);
    const empty = tmp();
    sh(empty, GIT_INIT);
    expect(pushTest.skillHandsOff(empty)).toBe(false); // a repo with no commit
    expect(pushTest.skillHandsOff(tmp())).toBe(false); // no repo at all
    startHookClock(5);
    Bun.sleepSync(40);
    expect(pushTest.skillHandsOff(w.r)).toBe(true); // git was not asked in time: not "no hand-off"
    expect(pushTest.skillHandsOff(empty)).toBe(true);
  });
});

describe('the other git readers read a stalled git as a stall', () => {
  test('AC-16: with a hook clock that ran out, `git ci -m x` (alias ci = commit) is denied, not allowed', () => {
    const w = world();
    sh(w.r, 'git config alias.ci commit');
    const sid = newSid();
    pinCommitIssueSettings(sid, w.r);
    // Control: git answers, so the alias is found to be a commit without an issue number.
    expect(commitIssueDenial('git ci -m x', w.r, sid)).toContain('no issue number');
    startHookClock(5);
    Bun.sleepSync(40);
    expect(hookLeft()).toBeLessThanOrEqual(0);
    // Not "no such alias" (which lets the call through): the lookup was not answered.
    const denied = commitIssueDenial('git ci -m x', w.r, sid);
    expect(denied).toContain('could not finish checking this command in time');
  });

  test('AC-17: with a hook clock that ran out, an alias of push (pp) gives an unclear push hand-off, not none', () => {
    const w = world();
    sh(w.r, 'git config alias.pp push');
    const rules = { allow: [], production: [] };
    const control = handoffsOf('git pp origin main', w.r, rules);
    expect(control).toHaveLength(1);
    expect(control[0]!.unclear).toBeUndefined();
    startHookClock(5);
    Bun.sleepSync(40);
    const late = handoffsOf('git pp origin main', w.r, rules);
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ kind: 'push', what: 'git pp', unclear: 'git did not answer whether it is an alias' });
  });
});

// ── delta review: no lost update, and layouts git refuses are no stall ──────────────────────────────────

/** A `git` ahead of PATH that, on a `status` call while `arm` exists, removes `arm` and appends `line` to `record`
 *  (what a parallel post hook does while a retry waits on git), then runs the real git. */
function armedGit(base: string, arm: string, record: string, line: string): void {
  const bin = join(base, 'bin-armed');
  write(
    bin,
    'git',
    `#!/bin/sh\ncase " $* " in *" status "*) if [ -e '${arm}' ]; then rm -f '${arm}'; printf '%s\\n' '${line}' >> '${record}'; fi;; esac\nexec '${Bun.which('git')}' "$@"\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}
const callOf = (tuid: string, dir: string, over: Partial<import('../lib/unswept').UnsweptCall> = {}): import('../lib/unswept').UnsweptCall => ({ tuid, since: Date.now() - 60_000, dirs: [dir], command: `cmd-${tuid}`, stalled: [dir], ...over });

describe('replaceUnswept keeps what was appended since the read', () => {
  test('AC-19: the calls the caller read are replaced; a call appended after the read stays, duplicates are counted', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const a = callOf('A', '/x');
    U.noteUnswept(sid, a);
    U.noteUnswept(sid, a); // the same line twice
    const read = U.readUnswept(sid).calls;
    expect(read).toHaveLength(2);
    U.noteUnswept(sid, callOf('B', '/x')); // a parallel post hook
    U.noteUnswept(sid, a); // and the same line once more
    const keep = callOf('K', '/x');
    U.replaceUnswept(sid, read, [keep]);
    expect(U.readUnswept(sid).calls.map((c) => c.tuid)).toEqual(['K', 'B', 'A']); // the kept calls first, then what is new
    // Nothing new: only the kept calls.
    U.replaceUnswept(sid, U.readUnswept(sid).calls, []);
    expect(U.readUnswept(sid)).toEqual({ calls: [], refused: false });
  });

  test('AC-19b: a re-read that is refused leaves the lost-record marker with the kept calls', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
    mkdirSync(p); // the record was replaced while the caller was busy
    U.replaceUnswept(sid, [callOf('A', '/x')], [callOf('K', '/x')]);
    expect(lstatSync(p).isFile()).toBe(true);
    expect(U.readUnswept(sid).calls.map((c) => c.tuid)).toEqual(['K', '']);
    expect(U.readUnswept(sid).calls[1]).toEqual({ ...U.LOST_RECORD, since: expect.any(Number) });
  });

  test('AC-20: retryUnswept keeps a call a parallel hook appends while it waits on git, and clears the one it listed', async () => {
    const U = await unsweptLib();
    const w = world();
    U.noteUnswept(w.sid, callOf('A', w.sub));
    write(w.sub, 'out.txt', 'x');
    const record = join(ensureSessionDir(w.sid), U.UNSWEPT_FILE);
    const arm = join(w.base, 'arm');
    writeFileSync(arm, '');
    const b = callOf('B', w.sub);
    armedGit(w.base, arm, record, JSON.stringify(b));
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]); // A lists: nothing of A is kept
    expect(existsSync(arm)).toBe(false); // the append happened during the retry's status
    expect(U.readUnswept(w.sid).calls).toEqual([b]); // B is not lost; A is gone
    expect(getEditHistory(w.sid).files).toEqual([join(w.sub, 'out.txt')]);
  });

  test('AC-21: the user\'s Stop marker drops the calls it passed, not one appended since the Stop\'s retry', async () => {
    const U = await unsweptLib();
    const w = world();
    plantDecoy(w.sub);
    pyCall(w, 'tu21');
    const record = join(ensureSessionDir(w.sid), U.UNSWEPT_FILE);
    const arm = join(w.base, 'arm');
    writeFileSync(arm, '');
    const b = callOf('B', w.sub);
    armedGit(w.base, arm, record, JSON.stringify(b)); // the retry's status (which stalls on the decoy) appends B
    const marker = approvalMarkerPath(w.r, 'stop', w.sid);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '');
    const r = await stop(w);
    expect(r.out.reason ?? '').not.toContain('could not list the files');
    expect(existsSync(marker)).toBe(false); // the marker was used
    expect(existsSync(arm)).toBe(false); // B was appended during the Stop
    expect(U.readUnswept(w.sid).calls).toEqual([b]); // 'tu21' is dropped, B is the next Stop's
  });
});

describe('statusOf: a repo git cannot list is a stall, a dir that is in no repo is not', () => {
  test('AC-22: `core.bare true` and a bare layout are stalled (their writes are unlisted, not none); dubious ownership is null; a corrupt index is stalled', () => {
    const w = world();
    sh(w.r, 'git config core.bare true'); // `status` then fails for want of a work tree: a write now would go unlisted
    expect(sweep.statusOf(w.r, 5_000)).toBe('stalled');
    expect(sweep.statusOf(w.sub, 5_000)).toBe('stalled');
    sh(w.r, 'git config core.bare false');
    expect(sweep.statusOf(w.r, 5_000)).toEqual({ top: w.r, files: [] });

    const bl = join(w.base, 'bl');
    mkdirSync(bl);
    sh(bl, 'git init -q --bare .bare && printf "gitdir: ./.bare\\n" > .git');
    expect(sweep.statusOf(bl, 5_000)).toBe('stalled');

    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    try {
      expect(sweep.statusOf(w.r, 5_000)).toBeNull(); // git: "detected dubious ownership in repository"
    } finally {
      delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
    }

    writeFileSync(join(w.r, '.git', 'index'), 'not an index\n');
    expect(sweep.statusOf(w.sub, 5_000)).toBe('stalled');
  });

  test('AC-22b: a python write between `core.bare true` and `core.bare false` is kept as an unswept call', async () => {
    const U = await unsweptLib();
    const w = world();
    sh(w.r, 'git config core.bare true');
    const res = pyCall(w, 'tu22b', { gitTimeoutMs: 5_000 });
    sh(w.r, 'git config core.bare false');
    expect(res.swept).toBe(false);
    expect(U.readUnswept(w.sid).calls.map((c) => c.tuid)).toEqual(['tu22b']);
    // Once the repo lists again, the retry records the write.
    expect(sweep.retryUnswept(w.sid, 5_000)).toEqual([]);
    expect(getEditHistory(w.sid).files).toEqual([join(w.sub, 'out.txt')]);
  });

  test('AC-22c: a dir inside `.git` is swept as its work tree, whatever the case of the name; a plain dir with no repo is still null', () => {
    const w = world();
    const a = write(w.r, 'src/a.py', 'x\n');
    expect(sweep.statusOf(join(w.r, '.git', 'hooks'), 5_000)).toEqual({ top: w.r, files: [a] });
    expect(sweep.statusOf(join(w.r, '.git'), 5_000)).toEqual({ top: w.r, files: [a] });
    expect(sweep.statusOf(join(w.r, '.GIT', 'x'), 5_000)).toEqual({ top: w.r, files: [a] }); // path-only: no .GIT exists, the owner is what counts
    expect(sweep.statusOf(tmp(), 5_000)).toBeNull();
  });
});

describe('a link spelled `.git` is judged on its real path', () => {
  test('AC-25: `x/.git` -> the project is no redirect to `x` (no repo): git reads the link as before and lists the project\'s files', () => {
    const w = world();
    write(w.r, 'src/x.py', 'x\n');
    const x = join(w.base, 'x');
    mkdirSync(x);
    symlinkSync(w.r, join(x, '.git'));
    const s = sweep.statusOf(join(x, '.git', 'src'), 5_000);
    expect(s).toEqual({ top: join(x, '.git'), files: [join(x, '.git', 'src', 'x.py')] });
    expect(sweep.statusOf(join(x, '.git'), 5_000)).toEqual({ top: join(x, '.git'), files: expect.arrayContaining([join(x, '.git', 'src', 'x.py')]) });
  });

  test('AC-25b: `y/.git` -> `proj/.git` is swept as the project it belongs to, in its real spelling', () => {
    const w = world();
    write(w.r, 'src/x.py', 'x\n');
    const y = join(w.base, 'y');
    mkdirSync(y);
    symlinkSync(join(w.r, '.git'), join(y, '.git'));
    expect(sweep.statusOf(join(y, '.git', 'hooks'), 5_000)).toEqual({ top: realpathSync(w.r), files: [join(realpathSync(w.r), 'src', 'x.py')] });
  });
});

describe('the lost record is dated, and a refused re-read is told to the retry', () => {
  test('AC-24: a second loss is not taken for the first: read [LOST1, B], replaced again [LOST2, C], replace(read, []) leaves [LOST2, C]', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
    mkdirSync(p);
    U.noteUnswept(sid, callOf('B', '/x')); // LOST1 + B
    const first = U.readUnswept(sid).calls;
    expect(first.map((c) => c.tuid)).toEqual(['', 'B']);
    expect(first[0]!.since).toBeGreaterThan(0); // dated
    rmSync(p);
    mkdirSync(p);
    Bun.sleepSync(5);
    U.noteUnswept(sid, callOf('C', '/x')); // LOST2 + C
    expect(U.replaceUnswept(sid, first, [])).toBe(false);
    const left = U.readUnswept(sid).calls;
    expect(left.map((c) => c.tuid)).toEqual(['', 'C']);
    expect(left[0]!.since).toBeGreaterThan(first[0]!.since);
  });

  test('AC-24b: replaceUnswept returns true for a refused re-read; with lostToFile false it writes no lost-record line', async () => {
    const U = await unsweptLib();
    const sid = newSid();
    const p = join(ensureSessionDir(sid), U.UNSWEPT_FILE);
    mkdirSync(p);
    expect(U.replaceUnswept(sid, [], [callOf('K', '/x')], false)).toBe(true);
    expect(U.readUnswept(sid).calls.map((c) => c.tuid)).toEqual(['K']);
    expect(U.replaceUnswept(sid, [], [], true)).toBe(false); // readable now: nothing refused
  });

  test('AC-24c: a record replaced by a FIFO while the retry waits on git: the retry returns the lost-record call, so this Stop blocks', async () => {
    const U = await unsweptLib();
    const w = world();
    U.noteUnswept(w.sid, callOf('A', w.sub));
    write(w.sub, 'out.txt', 'x');
    const record = join(ensureSessionDir(w.sid), U.UNSWEPT_FILE);
    const arm = join(w.base, 'arm');
    writeFileSync(arm, '');
    // The fake git, on the retry's `status`, puts a FIFO where the record was (the retry already read it).
    const bin = join(w.base, 'bin-fifo');
    write(bin, 'git', `#!/bin/sh\ncase " $* " in *" status "*) if [ -e '${arm}' ]; then rm -f '${arm}' '${record}'; mkfifo '${record}'; fi;; esac\nexec '${Bun.which('git')}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const kept = sweep.retryUnswept(w.sid, 5_000);
    expect(kept.map((c) => c.tuid)).toEqual(['']);
    expect(kept[0]!.command).toContain('could not read its record');
    expect(lstatSync(record).isFile()).toBe(true); // the FIFO is gone
    expect(U.readUnswept(w.sid).calls).toEqual([]); // the retry wrote no lost line: it blocks this Stop instead
    expect(getEditHistory(w.sid).files).toEqual([join(w.sub, 'out.txt')]);
  });
});

describe('unsweptReason quotes the find dir', () => {
  test('AC-23: a dir with a quote or a space is one shell word; a plain dir is not quoted', async () => {
    const U = await unsweptLib();
    const c = (dir: string) => ({ tuid: 't', since: 1, dirs: [dir], command: 'x', stalled: [dir] });
    expect(U.unsweptReason([c("/p/it's dir")], '/p')).toContain("`find 'it'\\''s dir' -mindepth 2 -path '*/.git/HEAD' ! -type f`");
    expect(U.unsweptReason([c('/p/a b')], '/p')).toContain("`find 'a b' -mindepth 2");
    expect(U.unsweptReason([c('/p/a$(x)')], '/p')).toContain("`find 'a$(x)' -mindepth 2");
    expect(U.unsweptReason([c('/p/sub-1.x')], '/p')).toContain('`find sub-1.x -mindepth 2');
  });
});

// ── the hooks, spawned as Claude Code runs them ────────────────────────────────────────────────────────

interface Out {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: { additionalContext?: string };
}
const baseEnv = (w: W): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  HOME: w.home,
  CLAUDE_PROJECT_DIR: w.r,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GOODBOY_DISABLE_DELEGATION: '1',
  GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
  GOODBOY_DOCS_GATE: 'off',
  GOODBOY_POLICY_GATE: 'off',
});
async function spawnHook(script: string, w: W, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ out: Out; ms: number; err: string }> {
  const t0 = Date.now();
  const proc = Bun.spawn(['bun', script], {
    cwd: w.sub,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: w.sub, session_id: w.sid, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...baseEnv(w), ...env },
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { out: JSON.parse(text || '{}') as Out, ms: Date.now() - t0, err };
}
async function stop(w: W, opts: { active?: boolean; env?: Record<string, string> } = {}): Promise<{ out: Out; ms: number }> {
  const r = await spawnHook(STOP, w, { hook_event_name: 'Stop', stop_hook_active: opts.active === true }, opts.env);
  // A rule that throws makes the gate fail open (a pass): never in these tests.
  expect(r.err).not.toContain('[goodboy stop]');
  return { out: r.out, ms: r.ms };
}
const counterFile = (w: W): string => join(tmpdir(), `goodboy-session-${w.sid}`, '.goodboy-sweep-retry-count.txt');

describe('the Stop and the unswept calls', () => {
  test('a full Stop blocks with the reason; the stop_hook_active Stop warns and does not block; once the decoy is gone the next Stop records the write', async () => {
    const U = await unsweptLib();
    const w = world();
    const z = plantDecoy(w.sub);
    pyCall(w, 'tu8');
    expect(U.readUnswept(w.sid).calls).toHaveLength(1);

    const full = await stop(w);
    expect(full.out.decision).toBe('block');
    expect(full.out.reason).toContain('could not list the files that 1 Bash command changed');
    expect(full.out.reason).toContain('`python3 -c "open(\'out.txt\',\'w\').write(\'x\')"`');
    expect(full.out.reason).toContain('git did not list the changes in `sub`');
    expect(full.out.reason).toContain("`find sub -mindepth 2 -path '*/.git/HEAD' ! -type f`");
    expect(full.ms).toBeLessThan(14_000);
    expect(readFileSync(counterFile(w), 'utf8').trim()).toBe('1');
    expect(U.readUnswept(w.sid).calls).toHaveLength(1); // kept for the next Stop
    expect(getEditHistory(w.sid).files).toEqual([]);

    // The loop-prevention Stop never blocks, and says the writes stay unlisted.
    const active = await stop(w, { active: true });
    expect(active.out.decision).toBeUndefined();
    expect(active.out.systemMessage).toContain('[goodboy] Bash 명령 1개가 바꾼 파일을 확인하지 못했어요');
    expect(U.readUnswept(w.sid).calls).toHaveLength(1);

    // The decoy removed: this Stop's retry lists the write; the sweep block is gone.
    rmSync(z, { recursive: true, force: true });
    const after = await stop(w);
    expect(after.out.reason ?? '').not.toContain('could not list the files');
    expect(getEditHistory(w.sid).files).toEqual([join(w.sub, 'out.txt')]);
    expect(U.readUnswept(w.sid)).toEqual({ calls: [], refused: false });
    expect(existsSync(counterFile(w))).toBe(false);
  });

  test('the user\'s Stop marker passes the sweep block and drops the record', async () => {
    const U = await unsweptLib();
    const w = world();
    plantDecoy(w.sub);
    pyCall(w, 'tu9');
    const marker = approvalMarkerPath(w.r, 'stop', w.sid);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '');
    const r = await stop(w);
    expect(r.out.reason ?? '').not.toContain('could not list the files');
    expect(r.out.systemMessage ?? '').toContain('sweep 게이트를 통과');
    expect(existsSync(marker)).toBe(false); // used once
    expect(U.readUnswept(w.sid)).toEqual({ calls: [], refused: false });
    expect(existsSync(counterFile(w))).toBe(false);
    expect(gateLog(w.sid)).toContain('user-override');
  });

  test('a record that cannot be read blocks the Stop once with the reason that says so', async () => {
    const U = await unsweptLib();
    const w = world();
    const p = join(ensureSessionDir(w.sid), U.UNSWEPT_FILE);
    writeFileSync(p, '');
    truncateSync(p, MAX_STATE_BYTES + 1);
    const r = await stop(w);
    expect(r.out.decision).toBe('block');
    expect(r.out.reason).toContain('goodboy could not read its record of them');
    expect(U.readUnswept(w.sid).calls).toEqual([]); // emptied: the next Stop does not block again
  });
});

describe('the post hook keeps the call, and PreToolUse runs on a clock', () => {
  test('PostToolUse after a python write in a repo with the decoy keeps the call within its clock', async () => {
    const U = await unsweptLib();
    const w = world();
    plantDecoy(w.sub);
    noteBashStart(w.sid, 'tu6p', w.sub, PY);
    writeFileSync(join(w.sub, 'out.txt'), 'x');
    const r = await spawnHook(
      POST,
      w,
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tu6p', tool_input: { command: PY }, tool_response: { stdout: '', stderr: '', interrupted: false } },
      { GOODBOY_TEST_HOOK_CLOCK_MS: '1500' },
    );
    expect(r.err).toBe('');
    // 12 s (the sweep's own limit) with no clock; the clock has 1.5 s.
    expect(r.ms).toBeLessThan(9_000);
    const kept = U.readUnswept(w.sid).calls;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ tuid: 'tu6p', command: PY, stalled: [w.sub] });
  });

  test('PreToolUse starts its clock: with none left, the Bash start snapshot runs no git', async () => {
    const w = world();
    const note = (tuid: string): { status?: { top: string } } | null => {
      try {
        return JSON.parse(readFileSync(join(tmpdir(), `goodboy-session-${w.sid}`, `bash-start-${tuid}.json`), 'utf8'));
      } catch {
        return null;
      }
    };
    const pre = (tuid: string, env: Record<string, string> = {}) => spawnHook(PRE, w, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: tuid, tool_input: { command: 'python3 -c "pass"' } }, env);
    expect((await pre('tuOk')).err).toBe('');
    expect(note('tuOk')?.status?.top).toBe(w.r); // git ran for the snapshot
    expect((await pre('tuLate', { GOODBOY_TEST_HOOK_CLOCK_MS: '0' })).err).toBe('');
    expect(note('tuLate')).not.toBeNull(); // the call is noted ...
    expect(note('tuLate')?.status).toBeUndefined(); // ... with no snapshot: the clock was out
  });

  test('PreToolUse has a clock below its hook timeout', () => {
    expect(HOOK_CLOCK_MS.preToolUse).toBeGreaterThan(0);
    const cfg = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, { hooks: { timeout?: number }[] }[]> };
    const timeout = Math.max(...(cfg.hooks.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.timeout ?? 0)));
    expect(timeout * 1000 - HOOK_CLOCK_MS.preToolUse).toBeGreaterThanOrEqual(2_000);
  });
});
