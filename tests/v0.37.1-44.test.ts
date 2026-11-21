// v0.37.1, field report #44 (plan §15.36), items 1, 3 and 5:
//   1. review and test records that carry a git tree outlive a rebase while a commit is unpushed;
//   3. the test and validation gates wait only for a running `goodboy:test-*` agent, the review gate
//      only for a `goodboy:review-*` one, and both stop waiting 45 minutes after the first deferral;
//   5. the Stop regenerates a stale `.goodboy/test-catalog.md` (the CLI's generator) before the docs rule.
// Repos, session dirs and records are temporary; no network (the "remote" is a bare repo on disk).
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AGENT_DEFERRAL_CAP_MS, DEFERRAL_FILE, deferralOpen, runningAgents, tasksSummary } from '../lib/agent-deferral';
import { pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import { noteBashStart } from '../lib/approval-marker';
import { readGateLog } from '../lib/gate-log';
import { snapshotGateState } from '../lib/state-guard';
import { afterBash } from '../lib/write-sweep';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';
import { findRecentReviewFiles, pruneOldReviewFiles } from '../lib/review-validator';
import { catalogIsCurrent, catalogRows, refreshCatalog, renderCatalog, takeJudgedRows, TEST_CATALOG_FILE, writeCatalog } from '../lib/test-catalog';
import { findRecentTestFiles, isTreeBoundFile, pruneOldTestFiles, TREE_RECORD_WINDOW_MIN } from '../lib/test-validator';
import { readValidationFailure, writeValidationFailure } from '../lib/validation-state';
import { unpushedWork } from '../lib/unpushed-work';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-v0371-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `v0371${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const DAY_MS = 24 * 60 * 60 * 1000;
/** Sets a file's mtime to `ageMs` ago. */
function age(path: string, ageMs: number): void {
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
}

/** A repo with one commit; `pushed` adds a bare "remote" on disk and pushes to it. */
function repo(files: Record<string, string> = {}, pushed = false): string {
  const d = tmp();
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  for (const [p, t] of Object.entries({ 'src/a.ts': 'export const a = 1;\n', ...files })) write(d, p, t);
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  if (pushed) {
    const bare = tmp();
    sh(bare, 'git init -q --bare');
    sh(d, `git remote add origin '${bare}' && git push -q origin main`);
  }
  return d;
}

async function stop(d: string, s: string, payload: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_TEST_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off', GOODBOY_CLAIM_GATE: 'off', ...env },
  });
  const out = (await new Response(p.stdout).text()) || '{}';
  await p.exited;
  return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
}

// ── item 1: records across a rebase ─────────────────────────────────────────────────────────────

/** A minimal record file with the given extra fields; `ageMs` old. */
function record(dir: string, name: string, extra: Record<string, unknown>, ageMs: number): string {
  const p = write(
    dir,
    name,
    JSON.stringify({
      timestamp: new Date(Date.now() - ageMs).toISOString(),
      category: 'fix-bug',
      verdict: 'pass',
      reviewed_files: [],
      findings: [],
      tested_files: [],
      test_files: [],
      suites: [],
      ...extra,
    }),
  );
  age(p, ageMs);
  return p;
}
const names = (rs: Array<{ timestamp: string }>) => rs.map((r) => r.timestamp).sort();

describe('item 1: tree-bound records are read longer while a commit is unpushed', () => {
  test('findRecentReviewFiles: a tree-bound review 3 days old is read with the tree window, a tree-less one is not', () => {
    const dir = tmp();
    record(dir, 'bound.json', { tree: 'a'.repeat(40) }, 3 * DAY_MS);
    record(dir, 'nulltree.json', { tree: null }, 3 * DAY_MS);
    record(dir, 'plain.json', {}, 3 * DAY_MS);
    record(dir, 'fresh.json', {}, 1000);
    expect(findRecentReviewFiles(dir, 1440)).toHaveLength(1); // as before: only the fresh one
    expect(findRecentReviewFiles(dir, 1440, TREE_RECORD_WINDOW_MIN)).toHaveLength(2); // fresh + tree-bound
  });

  test('findRecentReviewFiles: past the tree window nothing is read', () => {
    const dir = tmp();
    record(dir, 'old.json', { tree: 'a'.repeat(40) }, 31 * DAY_MS);
    expect(findRecentReviewFiles(dir, 1440, TREE_RECORD_WINDOW_MIN)).toHaveLength(0);
  });

  test('findRecentTestFiles: the same rule, and the outside-repo rule still holds', () => {
    const dir = tmp();
    record(dir, 'bound.json', { tree: 'b'.repeat(40) }, 3 * DAY_MS);
    record(dir, 'outside.json', { tree: 'c'.repeat(40), repo: '/elsewhere' }, 3 * DAY_MS);
    record(dir, 'plain.json', {}, 3 * DAY_MS);
    expect(findRecentTestFiles(dir, 1440)).toHaveLength(0);
    expect(findRecentTestFiles(dir, 1440, false, TREE_RECORD_WINDOW_MIN)).toHaveLength(1);
    expect(findRecentTestFiles(dir, 1440, true, TREE_RECORD_WINDOW_MIN)).toHaveLength(2);
  });

  test('pruneOld*: a tree-bound record survives the 3-day prune only when asked, never past 30 days', () => {
    for (const [prune, label] of [
      [pruneOldReviewFiles, 'review'],
      [pruneOldTestFiles, 'test'],
    ] as const) {
      const dir = tmp();
      const bound = record(dir, 'bound.json', { tree: 'a'.repeat(40) }, 4 * DAY_MS);
      const plain = record(dir, 'plain.json', {}, 4 * DAY_MS);
      const dead = record(dir, 'dead.json', { tree: 'a'.repeat(40) }, 31 * DAY_MS);
      const broken = write(dir, 'broken.json', '{not json');
      age(broken, 4 * DAY_MS);
      expect(prune(dir, 4320, undefined, TREE_RECORD_WINDOW_MIN)).toBe(3);
      expect([label, existsSync(bound), existsSync(plain), existsSync(dead), existsSync(broken)]).toEqual([label, true, false, false, false]);
      // without the extra window: as before, every record past 3 days goes
      expect(prune(dir, 4320)).toBe(1);
      expect(existsSync(bound)).toBe(false);
    }
  });

  test('a function window is asked only for a record older than the plain window, and once (a Stop with fresh records asks git nothing)', () => {
    const dir = tmp();
    record(dir, 'fresh.json', { tree: 'a'.repeat(40) }, 1000);
    record(dir, 'ancient.json', { tree: 'a'.repeat(40) }, 31 * DAY_MS);
    let asked = 0;
    const window = () => {
      asked++;
      return TREE_RECORD_WINDOW_MIN;
    };
    expect(findRecentReviewFiles(dir, 1440, window)).toHaveLength(1);
    expect(findRecentTestFiles(dir, 1440, false, window)).toHaveLength(1);
    expect(asked).toBe(0); // nothing between the plain window and the 30 days
    record(dir, 'old1.json', { tree: 'a'.repeat(40) }, 3 * DAY_MS);
    record(dir, 'old2.json', { tree: 'a'.repeat(40) }, 4 * DAY_MS);
    expect(findRecentReviewFiles(dir, 1440, window)).toHaveLength(3);
    expect(asked).toBe(1);
    expect(pruneOldTestFiles(dir, 4320, undefined, window)).toBe(1); // only the ancient one goes
    expect(asked).toBe(2); // one ask per call
  });

  test('an old tree-bound record is parsed once by the prune and the read that follows, and the stash shares nothing', () => {
    for (const [prune, find] of [
      [pruneOldReviewFiles, findRecentReviewFiles],
      [pruneOldTestFiles, findRecentTestFiles],
    ] as const) {
      const dir = tmp();
      const old = record(dir, 'old.json', { tree: 'a'.repeat(40) }, 4 * DAY_MS);
      const original = JSON.parse;
      let parses = 0;
      JSON.parse = ((...a: Parameters<typeof JSON.parse>) => {
        parses++;
        return original(...a);
      }) as typeof JSON.parse;
      try {
        expect(prune(dir, 4320, undefined, TREE_RECORD_WINDOW_MIN)).toBe(0);
        const first = (find as (d: string, w: number, ...r: unknown[]) => Array<{ tree?: string | null }>)(dir, 1440, ...(find === findRecentTestFiles ? [false, TREE_RECORD_WINDOW_MIN] : [TREE_RECORD_WINDOW_MIN]));
        expect(first).toHaveLength(1);
        expect(parses).toBe(1); // before: the prune's parse and the read's
        // the stash was taken out by that read: a second read parses again, and its record is its own
        const second = (find as (d: string, w: number, ...r: unknown[]) => Array<{ tree?: string | null }>)(dir, 1440, ...(find === findRecentTestFiles ? [false, TREE_RECORD_WINDOW_MIN] : [TREE_RECORD_WINDOW_MIN]));
        expect(parses).toBe(2);
        expect(second[0]).not.toBe(first[0]);
      } finally {
        JSON.parse = original;
      }
      expect(existsSync(old)).toBe(true);
    }
  });

  test('a record changed after the prune is read again, not taken from the stash', () => {
    const dir = tmp();
    const old = record(dir, 'old.json', { tree: 'a'.repeat(40), category: 'fix-bug' }, 4 * DAY_MS);
    expect(pruneOldTestFiles(dir, 4320, undefined, TREE_RECORD_WINDOW_MIN)).toBe(0);
    writeFileSync(old, readFileSync(old, 'utf8').replace('"fix-bug"', '"refactor-code"'));
    age(old, 4 * DAY_MS);
    expect(findRecentTestFiles(dir, 1440, false, TREE_RECORD_WINDOW_MIN).map((r) => r.category)).toEqual(['refactor-code']);
  });

  test('isTreeBoundFile reads a regular file within a cap: a FIFO is not waited on, a huge file is not read', () => {
    const dir = tmp();
    const fifo = join(dir, 'pipe.json');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    const started = Date.now();
    expect(isTreeBoundFile(fifo)).toBe(false); // readFileSync would wait here for a writer
    expect(Date.now() - started).toBeLessThan(2_000);
    const huge = join(dir, 'huge.json');
    writeFileSync(huge, `{"tree":"${'a'.repeat(40)}","pad":"${'x'.repeat(17 * 1024 * 1024)}"}`);
    expect(isTreeBoundFile(huge)).toBe(false);
    const small = write(dir, 'small.json', JSON.stringify({ tree: 'a'.repeat(40) }));
    expect(isTreeBoundFile(small)).toBe(true);
  });

  test('unpushedWork: true with a commit no remote has, false once pushed, true when git cannot say', () => {
    const local = repo({}, false); // no remote at all
    expect(unpushedWork(local)).toBe(true);
    const pushed = repo({}, true);
    expect(unpushedWork(pushed)).toBe(false);
    write(pushed, 'src/b.ts', 'export const b = 2;\n');
    sh(pushed, "git add -A && git commit -q -m 'ABC-2 more'");
    expect(unpushedWork(pushed)).toBe(true);
    expect(unpushedWork(tmp())).toBe(true); // not a repo: the safe side
  });

  test('the Stop prunes old records except tree-bound ones while a commit is unpushed', async () => {
    for (const pushed of [false, true]) {
      const d = repo({}, pushed);
      const s = sid();
      const files = ['reviews', 'tests'].flatMap((k) => [
        record(join(d, '.claude', k), 'bound.json', { tree: 'a'.repeat(40) }, 4 * DAY_MS),
        record(join(d, '.claude', k), 'plain.json', {}, 4 * DAY_MS),
        record(join(d, '.claude', k), 'dead.json', { tree: 'a'.repeat(40) }, 31 * DAY_MS),
      ]);
      await stop(d, s);
      const left = files.map((f) => existsSync(f));
      // [bound, plain, dead] for reviews then for tests
      expect(left).toEqual(pushed ? [false, false, false, false, false, false] : [true, false, false, true, false, false]);
    }
  }, 60_000);
});

const V1 = 'export const a = 1;\n';
const V2 = 'export const a = 1;\nexport const b = 2;\n';

/** review-write run for real in the project: the record it writes (with the server's tree). */
function reviewWrite(d: string, files: string[]): string {
  const input = { reviewed_files: files, category: 'fix-bug', findings: [], verdict: 'pass', dimensions_checked: Object.values(AXIS_DIMENSIONS).flat() };
  const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'review-write'], { cwd: d, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
  expect(r.exitCode).toBe(0);
  return (JSON.parse(r.stdout.toString()) as { path: string }).path;
}

describe('item 1: the review gate through the Stop', () => {
  test('a review of this content made 2 days ago still counts while a commit is unpushed, and not once everything is pushed', async () => {
    for (const pushed of [false, true]) {
      const d = repo({}, pushed);
      const s = sid();
      pinCoverageStart(s, d);
      const a = join(d, 'src', 'a.ts');
      writeFileSync(a, V2);
      recordEdit(s, a, 0, undefined, Date.now());
      const path = reviewWrite(d, [a]);
      expect(JSON.parse(readFileSync(path, 'utf8')).tree).toMatch(/^[0-9a-f]{40,}$/);
      age(path, 2 * DAY_MS);
      const out = await stop(d, s);
      if (pushed) {
        expect(out.decision).toBe('block');
        expect(out.reason).toMatch(/Review is required for the changed files|Review validation failed/);
      } else {
        expect(out.decision).toBeUndefined();
        expect(out.reason ?? '').not.toMatch(/Review is required|Review validation failed/);
      }
    }
  }, 90_000);
});

// ── item 3: running agents ──────────────────────────────────────────────────────────────────────

const agent = (type: string, status = 'running', kind = 'subagent') => ({ id: `t-${type}`, type: kind, status, description: 'x', agent_type: type });

describe('item 3: agent kinds, the summary and the 45-minute cap', () => {
  test('runningAgents sorts running subagents into test and review kinds; others defer nothing', () => {
    const got = runningAgents([
      agent('goodboy:test-unit'),
      agent('goodboy:review-changes'),
      agent('general-purpose'),
      agent('goodboy:test-e2e', 'completed'),
      agent('goodboy:test-shell', 'running', 'shell'),
      null,
      'x',
    ]);
    expect(got.test).toEqual(['goodboy:test-unit']);
    expect(got.review).toEqual(['goodboy:review-changes']);
    expect(got.types).toEqual(['goodboy:test-unit', 'goodboy:review-changes', 'general-purpose']);
    expect(runningAgents(undefined)).toEqual({ types: [], test: [], review: [] });
    expect(runningAgents('nope')).toEqual({ types: [], test: [], review: [] });
  });

  test('tasksSummary tells "none running" from "not reported"', () => {
    expect(tasksSummary(undefined)).toBe('background_tasks absent');
    expect(tasksSummary([])).toBe('background_tasks 0');
    expect(tasksSummary([agent('goodboy:test-unit'), { type: 'shell', status: 'running' }])).toBe('background_tasks 2: subagent/running/goodboy:test-unit, shell/running/-');
  });

  test('deferralOpen starts the clock at the first call and closes it 45 minutes later', () => {
    const s = sid();
    const t0 = 1_800_000_000_000;
    expect(clock(s)).toBeNull();
    expect(deferralOpen(s, t0)).toBe(true);
    expect(clock(s)).toBe(t0);
    expect(deferralOpen(s, t0 + AGENT_DEFERRAL_CAP_MS)).toBe(true);
    expect(deferralOpen(s, t0 + AGENT_DEFERRAL_CAP_MS + 1)).toBe(false);
    expect(clock(s)).toBe(t0); // the first deferral stays the start
  });

  test('deferralOpen fails closed when the clock cannot be read: no deferral, and nothing restarts it', () => {
    const t0 = 1_800_000_000_000;
    const broken: Array<[string, (file: string) => void]> = [
      ['malformed', (f) => writeFileSync(f, '{not json')],
      ['no start', (f) => writeFileSync(f, '{}')],
      ['a string start', (f) => writeFileSync(f, JSON.stringify({ start: String(t0) }))],
      ['a start in the future', (f) => writeFileSync(f, JSON.stringify({ start: t0 + 1000 }))],
      ['too large', (f) => writeFileSync(f, ' '.repeat(5000))],
      ['a directory', (f) => mkdirSync(f)],
      ['a symlink', (f) => symlinkSync(write(tmp(), 'clock.json', JSON.stringify({ start: t0 })), f)],
    ];
    for (const [label, make] of broken) {
      const s = sid();
      mkdirSync(sessionDir(s), { recursive: true });
      const file = join(sessionDir(s), DEFERRAL_FILE);
      make(file);
      expect([label, deferralOpen(s, t0)]).toEqual([label, false]);
      expect([label, deferralOpen(s, t0 + 1)]).toEqual([label, false]);
    }
  });

  test('deferralOpen fails closed when the clock cannot be started', () => {
    const s = sid();
    const dir = sessionDir(s);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500); // no write: the first deferral cannot start its clock
    try {
      // root can write anywhere: only judge where the directory really refuses
      let refused = false;
      try {
        writeFileSync(join(dir, 'probe'), 'x');
        rmSync(join(dir, 'probe'));
      } catch {
        refused = true;
      }
      if (refused) expect(deferralOpen(s, 1_800_000_000_000)).toBe(false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

function sessionDir(s: string): string {
  return join(tmpdir(), `goodboy-session-${s}`);
}

/** The deferral clock's start (epoch ms), or null when there is none. */
function clock(s: string): number | null {
  try {
    return (JSON.parse(readFileSync(join(sessionDir(s), DEFERRAL_FILE), 'utf8')) as { start: number }).start;
  } catch {
    return null;
  }
}

/** Sets the clock to a first deferral that was made `agoMs` ago. */
function setClock(s: string, agoMs: number): void {
  writeFileSync(join(sessionDir(s), DEFERRAL_FILE), JSON.stringify({ start: Date.now() - agoMs }));
}

/** Another edit of the file in the turn the next Stop closes: the gates no longer block a turn that changed nothing
 *  (tests/stop-review-carry.test.ts), so each block needs a change. */
function again(s: string, file: string): void {
  const turn = parseInt(readFileSync(join(sessionDir(s), 'turn.txt'), 'utf8').trim() || '0', 10);
  recordEdit(s, file, turn, undefined, Date.now());
}

describe('item 3: the review gate through the Stop', () => {
  function unreviewed() {
    const d = repo();
    const s = sid();
    pinCoverageStart(s, d);
    const a = join(d, 'src', 'a.ts');
    writeFileSync(a, V2);
    recordEdit(s, a, 0, undefined, Date.now());
    return { d, s };
  }

  test('a running review agent defers (as before); a test agent, another agent or a shell does not', async () => {
    const { d, s } = unreviewed();
    expect((await stop(d, s, { background_tasks: [agent('goodboy:review-changes')] })).decision).toBeUndefined();
    const a = join(d, 'src', 'a.ts');
    expect((await stop(d, s, { background_tasks: [agent('goodboy:test-unit')] })).decision).toBe('block');
    again(s, a);
    expect((await stop(d, s, { background_tasks: [agent('general-purpose')] })).decision).toBe('block');
    again(s, a);
    expect((await stop(d, s, { background_tasks: [agent('goodboy:review-changes', 'running', 'shell')] })).decision).toBe('block');
  }, 90_000);

  test('the deferral ends 45 minutes after the first one', async () => {
    const { d, s } = unreviewed();
    const tasks = [agent('goodboy:review-changes')];
    expect((await stop(d, s, { background_tasks: tasks })).decision).toBeUndefined();
    expect(typeof clock(s)).toBe('number');
    setClock(s, AGENT_DEFERRAL_CAP_MS + 60_000);
    expect((await stop(d, s, { background_tasks: tasks })).decision).toBe('block');
  }, 90_000);

  test('a clock that was deleted or garbled does not reopen the deferral', async () => {
    const { d, s } = unreviewed();
    const tasks = [agent('goodboy:review-changes')];
    expect((await stop(d, s, { background_tasks: tasks })).decision).toBeUndefined();
    writeFileSync(join(sessionDir(s), DEFERRAL_FILE), '{garbled');
    expect((await stop(d, s, { background_tasks: tasks })).decision).toBe('block');
  }, 90_000);
});

describe('item 3: the test gate through the Stop', () => {
  const ON = { GOODBOY_TEST_GATE: 'on' };
  function untested() {
    const d = repo();
    const s = sid();
    pinCoverageStart(s, d);
    const a = join(d, 'src', 'a.ts');
    writeFileSync(a, V2);
    recordEdit(s, a, 0, undefined, Date.now());
    return { d, s };
  }
  const denies = (s: string) => readGateLog(s).filter((e) => e.gate === 'test' && e.decision === 'deny');

  test('a running test agent turns the block into a warning with a gate-log line that names it; no record counts for it', async () => {
    const { d, s } = untested();
    const out = await stop(d, s, { background_tasks: [agent('goodboy:test-unit')] }, ON);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('goodboy:test-unit');
    expect(readGateLog(s).some((e) => e.gate === 'test' && e.decision === 'warn' && (e.reason ?? '').startsWith('deferred-for-agents(goodboy:test-unit)'))).toBe(true);
    expect(denies(s)).toHaveLength(0);
    // The agent is done and no record exists: the same Stop blocks, though no code changed since (the turn mark was put back).
    const after = await stop(d, s, { background_tasks: [] }, ON);
    expect(after.decision).toBe('block');
    expect(after.reason).toMatch(/No test result covers the changed code/);
  }, 90_000);

  test('another agent or a shell named like a test agent does not defer the test gate', async () => {
    const { d, s } = untested();
    expect((await stop(d, s, { background_tasks: [agent('general-purpose')] }, ON)).decision).toBe('block');
    again(s, join(d, 'src', 'a.ts'));
    const shell = await stop(d, s, { background_tasks: [agent('goodboy:test-unit', 'running', 'shell')] }, ON);
    expect(shell.decision).toBe('block');
  }, 90_000);

  test('every test deny logs one line of what background_tasks said', async () => {
    const { d, s } = untested();
    await stop(d, s, { background_tasks: [agent('general-purpose'), { type: 'shell', status: 'running', description: 'npm run dev' }] }, ON);
    const log = readGateLog(s);
    expect(denies(s)).toHaveLength(1);
    expect(log.some((e) => e.gate === 'test' && (e.reason ?? '') === 'background_tasks 2: subagent/running/general-purpose, shell/running/-')).toBe(true);
    again(s, join(d, 'src', 'a.ts'));
    await stop(d, s, {}, ON);
    expect(denies(s)).toHaveLength(2);
    expect(readGateLog(s).some((e) => e.gate === 'test' && (e.reason ?? '') === 'background_tasks absent')).toBe(true);
  }, 90_000);

  test('the deferral ends 45 minutes after the first deferral of the session', async () => {
    const { d, s } = untested();
    const tasks = [agent('goodboy:test-unit')];
    expect((await stop(d, s, { background_tasks: tasks }, ON)).decision).toBeUndefined();
    setClock(s, AGENT_DEFERRAL_CAP_MS + 60_000);
    expect((await stop(d, s, { background_tasks: tasks }, ON)).decision).toBe('block');
  }, 90_000);
});

describe('item 3: the deferral clock and the state guard', () => {
  test("an open agent Bash call's post hook does not delete the clock the Stop started: the 45 minutes do not restart", async () => {
    const d = repo();
    const s = sid();
    pinCoverageStart(s, d);
    const a = join(d, 'src', 'a.ts');
    writeFileSync(a, V2);
    recordEdit(s, a, 0, undefined, Date.now());
    // The agent's call began before any deferral: its snapshot (taken by PreToolUse) has no clock in it.
    noteBashStart(s, 'toolu_agentcall', d, 'sleep 30', 'agent1');
    snapshotGateState(s, 'toolu_agentcall', d);
    expect(clock(s)).toBeNull();
    const out = await stop(d, s, { background_tasks: [agent('goodboy:test-unit')] }, { GOODBOY_TEST_GATE: 'on' });
    expect(out.decision).toBeUndefined(); // deferred: the test agent runs
    const started = clock(s);
    expect(typeof started).toBe('number');
    // The agent's call ends: its post hook runs.
    afterBash(s, 'toolu_agentcall', d, 'sleep 30', 'agent1');
    expect(clock(s)).toBe(started);
    // And the clock still bounds the wait.
    setClock(s, AGENT_DEFERRAL_CAP_MS + 60_000);
    again(s, a);
    expect((await stop(d, s, { background_tasks: [agent('goodboy:test-unit')] }, { GOODBOY_TEST_GATE: 'on' })).decision).toBe('block');
  }, 90_000);
});

describe('item 3: the validation gate through the Stop', () => {
  function failing() {
    const d = repo();
    const s = sid();
    writeValidationFailure(s, ['bun run typecheck'], d);
    return { d, s };
  }
  const denied = (s: string) => readGateLog(s).filter((e) => e.gate === 'validation' && e.decision === 'deny');

  test('a failed validation blocks; a running test agent turns that into a warning, and the marker stays', async () => {
    const { d, s } = failing();
    const out = await stop(d, s, { background_tasks: [agent('goodboy:test-unit')] });
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('bun run typecheck');
    expect(readGateLog(s).some((e) => e.gate === 'validation' && e.decision === 'warn' && (e.reason ?? '') === 'deferred-for-agents(goodboy:test-unit)')).toBe(true);
    expect(denied(s)).toHaveLength(0);
    expect(readValidationFailure(s)).not.toBeNull(); // a deferral clears nothing
    const after = await stop(d, s, { background_tasks: [] });
    expect(after.decision).toBe('block');
    expect(after.reason).toContain('bun run typecheck');
  }, 90_000);

  test('the deferral skips only the validation block: the claim gate and the review gate still judge the Stop', async () => {
    const { d, s } = failing();
    // The claim gate: an answer that cites a file that does not exist.
    mkdirSync(sessionDir(s), { recursive: true });
    writeFileSync(join(sessionDir(s), 'turn.txt'), '2');
    const transcript = join(d, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'explain' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It is handled in src/nope.ts:42.' }] } }),
        JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
      ].join('\n') + '\n',
    );
    const claim = await stop(d, s, { background_tasks: [agent('goodboy:test-unit')], transcript_path: transcript }, { GOODBOY_CLAIM_GATE: 'on' });
    expect(claim.decision).toBe('block');
    expect(claim.reason).toContain('src/nope.ts:42');
    expect(readGateLog(s).some((e) => e.gate === 'validation' && e.decision === 'warn' && (e.reason ?? '').startsWith('deferred-for-agents'))).toBe(true);
    expect(denied(s)).toHaveLength(0);
    // The review gate: an unreviewed edit.
    const e = failing();
    pinCoverageStart(e.s, e.d);
    const a = join(e.d, 'src', 'a.ts');
    writeFileSync(a, V2);
    recordEdit(e.s, a, 0, undefined, Date.now());
    const review = await stop(e.d, e.s, { background_tasks: [agent('goodboy:test-unit')] });
    expect(review.decision).toBe('block');
    expect(review.reason).toMatch(/Review is required for the changed files|Review validation failed/);
    expect(denied(e.s)).toHaveLength(0);
  }, 90_000);

  test('a review agent, another agent or a shell does not defer it', async () => {
    const { d, s } = failing();
    for (const t of [agent('goodboy:review-changes'), agent('general-purpose'), agent('goodboy:test-unit', 'running', 'shell')]) {
      const out = await stop(d, s, { background_tasks: [t] });
      // a review agent defers the later gates only (B5.8); the validation block comes before it
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('bun run typecheck');
    }
  }, 90_000);

  test('the deferral ends 45 minutes after the first deferral of the session', async () => {
    const { d, s } = failing();
    const tasks = [agent('goodboy:test-unit')];
    expect((await stop(d, s, { background_tasks: tasks })).decision).toBeUndefined();
    setClock(s, AGENT_DEFERRAL_CAP_MS + 60_000);
    expect((await stop(d, s, { background_tasks: tasks })).decision).toBe('block');
  }, 90_000);
});

// ── item 5: the test catalog ────────────────────────────────────────────────────────────────────

/** A repo whose doc map says the catalog covers tests/**, in a project (policy file present). */
function catalogProject(): string {
  const d = repo({
    '.goodboy/policy.md': '## P1 X\n- decide: human\n- source: user 2026-10-16\n- date: 2026-10-16\n- checked: 2026-10-16\n',
    '.goodboy/docs.json': JSON.stringify({
      docs: [
        { path: '.goodboy/policy.md', session_start: true, covers: [] },
        { path: TEST_CATALOG_FILE, session_start: false, covers: ['tests/**'] },
      ],
    }),
    'tests/a.test.ts': "test('one', () => {});\n",
  });
  return d;
}
const catalogPath = (d: string) => join(d, TEST_CATALOG_FILE);
const DOCS_RULE = /docs rule/;

describe('item 5: writeCatalog', () => {
  test('writes the file once, and again only when the content differs', () => {
    const d = catalogProject();
    const first = writeCatalog(d);
    expect(first).toMatchObject({ ok: true, changed: true, files: 1 });
    expect(readFileSync(catalogPath(d), 'utf8')).toBe(renderCatalog(catalogRows(d)!));
    age(catalogPath(d), 5 * DAY_MS); // an untouched file keeps this mtime
    const before = statSync(catalogPath(d)).mtimeMs;
    expect(writeCatalog(d)).toMatchObject({ ok: true, changed: false });
    expect(statSync(catalogPath(d)).mtimeMs).toBe(before);
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    expect(writeCatalog(d)).toMatchObject({ ok: true, changed: true, files: 2 });
    expect(readdirSync(join(d, '.goodboy')).filter((f) => f.endsWith('.tmp'))).toEqual([]); // written by rename: no temp left
  });

  test('git that cannot list the files writes nothing', () => {
    const d = tmp();
    expect(writeCatalog(d)).toEqual({ ok: false, why: 'git' });
    expect(existsSync(catalogPath(d))).toBe(false);
  });

  test('a symlinked catalog or .goodboy dir is not written through', () => {
    const d = catalogProject();
    const elsewhere = write(tmp(), 'target.md', 'keep me\n');
    symlinkSync(elsewhere, catalogPath(d));
    expect(writeCatalog(d)).toEqual({ ok: false, why: 'symlink' });
    expect(readFileSync(elsewhere, 'utf8')).toBe('keep me\n');
    expect(lstatSync(catalogPath(d)).isSymbolicLink()).toBe(true);
    const e = catalogProject();
    const realDir = tmp();
    rmSync(join(e, '.goodboy'), { recursive: true });
    symlinkSync(realDir, join(e, '.goodboy'));
    expect(writeCatalog(e)).toEqual({ ok: false, why: 'symlink' });
    expect(readdirSync(realDir)).toEqual([]);
  });

  test('cli.ts test-catalog uses it: same file, and a refusal for a link', () => {
    const d = catalogProject();
    const run = () => Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'test-catalog'], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
    const ok = run();
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout.toString())).toMatchObject({ ok: true, files: 1 });
    expect(readFileSync(catalogPath(d), 'utf8')).toBe(renderCatalog(catalogRows(d)!));
    rmSync(catalogPath(d));
    symlinkSync(write(tmp(), 'target.md', 'keep\n'), catalogPath(d));
    expect(run().exitCode).not.toBe(0);
  });

  test('refreshCatalog does not write during a rebase or a merge', () => {
    for (const marker of ['rebase-merge/', 'rebase-apply/', 'MERGE_HEAD']) {
      const d = catalogProject();
      if (marker.endsWith('/')) mkdirSync(join(d, '.git', marker));
      else writeFileSync(join(d, '.git', marker), 'abc\n');
      expect(refreshCatalog(d)).toEqual({ ok: false, why: 'busy' });
      expect(existsSync(catalogPath(d))).toBe(false);
      rmSync(join(d, '.git', marker), { recursive: true });
      expect(refreshCatalog(d)).toMatchObject({ ok: true, changed: true });
    }
  });
});

describe('item 5: what goes into the catalog', () => {
  const row = (file: string, features: string[]) => ({ file, type: 'unit' as const, features, tests: 1 });

  test('a line break or a pipe in a file name or a title cannot start a line or split a cell', () => {
    const md = renderCatalog([row('tests/a\n# Forged heading.test.ts', ['sums\r\n## Also forged']), row('tests/p|ipe.test.ts', ['one|two'])]);
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual(['# Test catalog']);
    expect(md).toContain('| sums ## Also forged | unit | tests/a # Forged heading.test.ts | 1 |');
    expect(md).toContain('| one\\|two | unit | tests/p\\|ipe.test.ts | 1 |');
    // the Unicode line and paragraph separators and NEL too
    const sep = renderCatalog([row(`tests/x${String.fromCharCode(0x2028)}y${String.fromCharCode(0x85)}z.test.ts`, ['t'])]);
    expect(sep).toContain('| t | unit | tests/x y z.test.ts | 1 |');
    // ordinary names are rendered as before
    expect(renderCatalog([row('tests/a.test.ts', ['sums', 'carries'])])).toContain('| sums; carries | unit | tests/a.test.ts | 1 |');
  });

  test('catalogRows with a real file name that holds a newline: one row, no extra line in the catalog', () => {
    const d = catalogProject();
    write(d, 'tests/b\n# Forged.test.ts', "test('x', () => {});\n");
    const rows = catalogRows(d)!;
    expect(rows.map((r) => r.file)).toContain('tests/b\n# Forged.test.ts');
    expect(renderCatalog(rows).split('\n').filter((l) => l.startsWith('#'))).toEqual(['# Test catalog']);
  });

  test('a symlinked test file is skipped: its title is not read from where it points', () => {
    const d = catalogProject();
    const outside = write(tmp(), 'secret.test.ts', "describe('Secret outside title', () => { test('x', () => {}); });\n");
    symlinkSync(outside, join(d, 'tests', 'link.test.ts'));
    const rows = catalogRows(d)!;
    expect(rows.map((r) => r.file)).toEqual(['tests/a.test.ts']);
    expect(renderCatalog(rows)).not.toContain('Secret');
  });

  test('a fifo named like a test file is not waited on', () => {
    const d = catalogProject();
    expect(Bun.spawnSync(['mkfifo', join(d, 'tests', 'pipe.test.ts')]).exitCode).toBe(0);
    const started = Date.now();
    expect(catalogRows(d)!.map((r) => r.file)).toEqual(['tests/a.test.ts']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('item 5: the rows of the docs judge are reused', () => {
  test('takeJudgedRows hands over the rows of the latest catalogIsCurrent once; writeCatalog writes the rows it is given', () => {
    const d = catalogProject();
    expect(takeJudgedRows(d)).toBeUndefined();
    expect(catalogIsCurrent(d)).toBe(false); // no catalog yet
    const rows = takeJudgedRows(d)!;
    expect(rows.map((r) => r.file)).toEqual(['tests/a.test.ts']);
    expect(takeJudgedRows(d)).toBeUndefined(); // once
    catalogIsCurrent(d);
    expect(takeJudgedRows(join(d, 'elsewhere'))).toBeUndefined(); // another root's rows are no answer
    // given rows are written as they are, with no listing of the test files
    const given = [{ file: 'tests/given.test.ts', type: 'unit' as const, features: ['given'], tests: 3 }];
    expect(writeCatalog(d, given)).toMatchObject({ ok: true, changed: true, files: 1 });
    expect(readFileSync(catalogPath(d), 'utf8')).toBe(renderCatalog(given));
  });

  test('a Stop that regenerates the catalog lists the test files once', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    const bin = tmp();
    const log = join(bin, 'ls-files.log');
    writeFileSync(log, '');
    const real = Bun.which('git')!;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" ls-files "*"--others"*) echo x >> '${log}';; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const out = await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'on', PATH: `${bin}:${process.env.PATH}` });
    expect(out.reason ?? '').not.toMatch(DOCS_RULE);
    expect(readFileSync(catalogPath(d), 'utf8')).toBe(renderCatalog(catalogRows(d)!));
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1); // the judge's; before: the judge, the write, a second judge
  }, 90_000);
});

describe('item 5: the docs rule through the Stop', () => {
  const ON = { GOODBOY_DOCS_GATE: 'on' };
  const edits = (s: string) => readFileSync(join(sessionDir(s), 'edits.jsonl'), 'utf8');

  test('a stale catalog is regenerated and the rule passes; the write is no session edit', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    write(d, 'tests/b.test.ts', "test('two', () => {});\ntest('three', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    const before = edits(s);
    const out = await stop(d, s, {}, ON);
    expect(out.reason ?? '').not.toMatch(DOCS_RULE);
    expect(readFileSync(catalogPath(d), 'utf8')).toBe(renderCatalog(catalogRows(d)!));
    expect(readFileSync(catalogPath(d), 'utf8')).toContain('tests/b.test.ts | 2');
    expect(edits(s)).toBe(before); // not recorded as an edit
    expect(readGateLog(s).some((e) => e.gate === 'docs' && e.reason === 'catalog-regenerated')).toBe(true);
    expect(out.systemMessage ?? '').toContain('test-catalog.md');
  }, 90_000);

  test('a current catalog is not rewritten', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    writeCatalog(d);
    sh(d, "git add -A && git commit -q -m 'ABC-3 catalog'");
    age(catalogPath(d), 5 * DAY_MS);
    const mtime = statSync(catalogPath(d)).mtimeMs;
    pinCoverageStart(s, d);
    recordEdit(s, join(d, 'tests', 'a.test.ts'), 0, undefined, Date.now());
    const out = await stop(d, s, {}, ON);
    expect(out.reason ?? '').not.toMatch(DOCS_RULE);
    expect(statSync(catalogPath(d)).mtimeMs).toBe(mtime);
  }, 90_000);

  test('not during a rebase: the file stays and the rule blocks as before', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    mkdirSync(join(d, '.git', 'rebase-merge'));
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    const out = await stop(d, s, {}, ON);
    expect(existsSync(catalogPath(d))).toBe(false);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(DOCS_RULE);
  }, 90_000);

  test('a symlinked catalog is left alone and the rule blocks as before', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    const elsewhere = write(tmp(), 'target.md', 'keep me\n');
    symlinkSync(elsewhere, catalogPath(d));
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    const out = await stop(d, s, {}, ON);
    expect(readFileSync(elsewhere, 'utf8')).toBe('keep me\n');
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(DOCS_RULE);
  }, 90_000);

  // Live verify of v0.37.1: the docs block usually comes on the Stop that answers another gate's block, and a
  //   full-Stop-only rewrite left the model to run `cli.ts test-catalog` itself.
  test('the stop_hook_active Stop regenerates the catalog too, so it gives no docs block', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    const out = await stop(d, s, { stop_hook_active: true }, ON);
    expect(out.decision).not.toBe('block');
    expect(out.reason ?? '').not.toMatch(DOCS_RULE);
    expect(readFileSync(catalogPath(d), 'utf8')).toBe(renderCatalog(catalogRows(d)!));
    expect(readGateLog(s).some((e) => e.gate === 'docs' && e.reason === 'catalog-regenerated')).toBe(true);
  }, 90_000);

  test('after a docs block, the stop_hook_active Stop counts the regenerated catalog as the fix', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    mkdirSync(join(d, '.git', 'rebase-merge'));
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    const first = await stop(d, s, {}, ON);
    expect(first.reason).toMatch(DOCS_RULE); // nothing is written during the rebase: the docs block
    rmSync(join(d, '.git', 'rebase-merge'), { recursive: true });
    await stop(d, s, { stop_hook_active: true }, ON);
    expect(readFileSync(catalogPath(d), 'utf8')).toBe(renderCatalog(catalogRows(d)!));
    const log = readGateLog(s);
    expect(log.some((e) => e.gate === 'docs' && e.reason === 'stale-on-stop-active')).toBe(false);
    expect(log.some((e) => e.gate === 'docs' && e.reason === 'continue-to-review-after-docs-fixed')).toBe(true);
  }, 90_000);

  // v0.37.2: the active Stop hands the docs it already judged to the docs gate; the gate used to judge and try the
  //   rewrite a second time (a second listing of the test files, a second `catalog-not-regenerated` line).
  test('the stop_hook_active Stop judges the docs once: one listing of the test files, one not-regenerated line, one block', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    mkdirSync(join(d, '.git', 'rebase-merge')); // nothing is written during the rebase: the rule blocks
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    const bin = tmp();
    const log = join(bin, 'ls-files.log');
    writeFileSync(log, '');
    const real = Bun.which('git')!;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" ls-files "*"--others"*) echo x >> '${log}';; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const out = await stop(d, s, { stop_hook_active: true }, { ...ON, PATH: `${bin}:${process.env.PATH}` });
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(DOCS_RULE);
    const entries = readGateLog(s);
    expect(entries.filter((e) => e.gate === 'docs' && String(e.reason).startsWith('catalog-not-regenerated'))).toHaveLength(1);
    expect(entries.filter((e) => e.gate === 'docs' && e.decision === 'deny')).toHaveLength(1);
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  }, 90_000);

  test('off with GOODBOY_DOCS_GATE=off and in a non-project directory: nothing is written', async () => {
    const d = catalogProject();
    const s = sid();
    pinCoverageStart(s, d);
    write(d, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s, join(d, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    await stop(d, s, {}, { GOODBOY_DOCS_GATE: 'off' });
    expect(existsSync(catalogPath(d))).toBe(false);
    const n = catalogProject();
    writeFileSync(join(n, 'CLAUDE.md'), 'goodboy: non-project\n');
    const s2 = sid();
    pinCoverageStart(s2, n);
    write(n, 'tests/b.test.ts', "test('two', () => {});\n");
    recordEdit(s2, join(n, 'tests', 'b.test.ts'), 0, undefined, Date.now());
    await stop(n, s2, {}, ON);
    expect(existsSync(catalogPath(n))).toBe(false);
  }, 90_000);
});
