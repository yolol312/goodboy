import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  abortRun,
  beginRun,
  changelogRange,
  checkedCheckupDir,
  checkupDir,
  completeRun,
  emptyState,
  limitFindings,
  makeRunDir,
  newRunId,
  normalizeVersion,
  noteRange,
  observe,
  parseChangelog,
  PENDING_TTL_MS,
  readCheckupState,
  RUN_ID,
  triageChangelog,
  updateCheckupState,
  writeRunFile,
} from '../lib/checkup';

// Track K, step K1a (#10): the checkup state, the changelog range and the run writer.

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'lib', 'cli.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-k1a-'));
  tmpDirs.push(d);
  return d;
}

/** A private checkup dir in a temp HOME. */
function home(): { home: string; dir: string; env: NodeJS.ProcessEnv } {
  const h = tmp();
  const dir = join(h, 'checkups');
  const env = { HOME: h, GOODBOY_CHECKUP_DIR: dir };
  checkedCheckupDir(env);
  return { home: h, dir, env };
}

const NOW = new Date('2026-10-20T05:00:00.000Z');
const DEAD_PID = 2 ** 22 + 12345;
const RUN = '20261020T050000Z-1';

describe('state transitions', () => {
  test('only a completed run advances lastChecked', () => {
    let s = observe(emptyState(), '2.1.300', NOW);
    expect(s.lastChecked).toBeNull();
    expect(s.observed?.cli).toBe('2.1.300');
    s = beginRun(s, '2.1.304', RUN, NOW);
    expect(s.pending).toEqual({ cli: '2.1.304', run: RUN, started: NOW.toISOString(), session: null, range: null });
    expect(s.lastChecked).toBeNull();
    expect(s.observed?.cli).toBe('2.1.304');
    // An aborted run leaves lastChecked where it was.
    expect(abortRun(s, RUN)).toMatchObject({ pending: null, lastChecked: null });
    const done = completeRun(s, RUN, NOW);
    expect(done.pending).toBeNull();
    expect(done.lastChecked).toEqual({ cli: '2.1.304', at: NOW.toISOString(), run: RUN, range: null });
    // Observing a newer CLI later never counts as checked.
    expect(observe(done, '2.1.305', NOW).lastChecked?.cli).toBe('2.1.304');
    // Aborting the next run keeps the last completed one.
    const next = beginRun(done, '2.1.305', '20261020T050001Z-1', NOW);
    expect(abortRun(next, '20261020T050001Z-1').lastChecked).toEqual(done.lastChecked);
  });

  test('a run that is not the pending one cannot complete or abort; bad input is refused', () => {
    const s = beginRun(emptyState(), '2.1.304', RUN, NOW);
    expect(() => completeRun(s, '20261020T050000Z-2', NOW)).toThrow('not the pending run');
    expect(() => abortRun(emptyState(), RUN)).toThrow('not the pending run');
    expect(() => beginRun(emptyState(), 'latest', RUN)).toThrow('not a CLI version');
    expect(() => beginRun(emptyState(), '2.1.304', '../x')).toThrow('not a run id');
  });

  test("another session's recent pending run blocks a new one unless replaced; its own or an old one does not", () => {
    const A = 'aaaaaaaa-1111-2222-3333-444444444444';
    const B = 'bbbbbbbb-1111-2222-3333-444444444444';
    const pending = beginRun(emptyState(), '2.1.303', RUN, NOW, A);
    const later = new Date(NOW.getTime() + 60 * 60_000);
    expect(() => beginRun(pending, '2.1.304', '20261020T060000Z-2', later, B)).toThrow('still pending');
    expect(() => beginRun(pending, '2.1.304', '20261020T060000Z-2', later, null)).toThrow('still pending');
    expect(beginRun(pending, '2.1.304', '20261020T060000Z-2', later, B, true).pending).toMatchObject({ run: '20261020T060000Z-2', session: B });
    expect(beginRun(pending, '2.1.304', '20261020T060000Z-2', later, A).pending?.run).toBe('20261020T060000Z-2');
    const dayLater = new Date(NOW.getTime() + PENDING_TTL_MS + 1000);
    expect(beginRun(pending, '2.1.304', '20261021T050001Z-2', dayLater, B).pending?.run).toBe('20261021T050001Z-2');
    // A session id that is not one is recorded as none.
    expect(beginRun(emptyState(), '2.1.304', RUN, NOW, '../x').pending?.session).toBeNull();
  });

  test('only the session that began a run completes it or notes its range; any session may abort it', () => {
    const A = 'aaaaaaaa-1111-2222-3333-444444444444';
    const B = 'bbbbbbbb-1111-2222-3333-444444444444';
    const s = beginRun(emptyState(), '2.1.304', RUN, NOW, A);
    expect(() => completeRun(s, RUN, NOW, B)).toThrow('another session');
    expect(() => completeRun(s, RUN, NOW, null)).toThrow('another session');
    expect(() => noteRange(s, RUN, { status: 'complete', gaps: [] }, B)).toThrow('another session');
    expect(completeRun(s, RUN, NOW, A).lastChecked?.cli).toBe('2.1.304');
    expect(abortRun(s, RUN).pending).toBeNull();
    // Outside Claude Code on both sides.
    const none = beginRun(emptyState(), '2.1.304', RUN, NOW, null);
    expect(completeRun(none, RUN, NOW, null).lastChecked?.cli).toBe('2.1.304');
    expect(() => completeRun(none, RUN, NOW, A)).toThrow('another session');
  });

  test('the range a run saw is kept when it completes', () => {
    let s = beginRun(emptyState(), '2.1.304', RUN, NOW);
    s = noteRange(s, RUN, { status: 'incomplete', gaps: ['the changelog cache has no entry for 2.1.304'] });
    expect(completeRun(s, RUN, NOW).lastChecked?.range).toEqual({ status: 'incomplete', gaps: ['the changelog cache has no entry for 2.1.304'] });
    expect(() => noteRange(s, '20261020T050000Z-9', { status: 'complete', gaps: [] })).toThrow('not the pending run');
  });

  test('versions: a leading v is dropped; anything else that is not x.y.z is refused', () => {
    expect(normalizeVersion('v2.1.301')).toBe('2.1.301');
    expect(() => normalizeVersion('latest')).toThrow('not a CLI version');
    const s = parseChangelog('## 2.1.304\n- a\n## 2.1.303\n- b\n## 2.1.301\n- c\n');
    expect(changelogRange(s, 'v2.1.301', '2.1.304').sections.map((x) => x.version)).toEqual(['2.1.304', '2.1.303']);
    expect(() => changelogRange(s, 'latest', '2.1.304')).toThrow('not a CLI version');
    expect(() => changelogRange(s, '2.1.301', 'v2')).toThrow('not a CLI version');
  });

  test('run ids', () => {
    expect(newRunId(NOW, 42)).toBe('20261020T050000Z-42');
    expect(RUN_ID.test(newRunId())).toBe(true);
  });
});

describe('state file', () => {
  test('written atomically and privately, read back the same', () => {
    const h = home();
    const s = updateCheckupState(h.dir, (st) => observe(st, '2.1.304', NOW));
    expect(readCheckupState(h.dir)).toEqual(s);
    expect(statSync(join(h.dir, 'state.json')).mode & 0o777).toBe(0o600);
    // No temp file or lock is left behind.
    expect(readdirSync(h.dir).sort()).toEqual(['state.json']);
  });

  test('a broken state is never reset silently', () => {
    const h = home();
    writeFileSync(join(h.dir, 'state.json'), '{not json');
    expect(() => readCheckupState(h.dir)).toThrow('not valid JSON');
    writeFileSync(join(h.dir, 'state.json'), JSON.stringify({ schema: 1, observed: null, pending: null, lastChecked: { cli: 'x', at: '', run: RUN } }));
    expect(() => readCheckupState(h.dir)).toThrow('not a checkup state');
    expect(() => updateCheckupState(h.dir, (st) => st)).toThrow('not a checkup state');
    // Another schema is not read as this one.
    writeFileSync(join(h.dir, 'state.json'), JSON.stringify({ ...emptyState(), schema: 2 }));
    expect(() => readCheckupState(h.dir)).toThrow('not a checkup state');
    // The lock is released after the failure.
    expect(existsSync(join(h.dir, 'state.lock'))).toBe(false);
  });

  test('a link or a FIFO at the state is refused', () => {
    const h = home();
    const target = join(h.home, 'elsewhere.json');
    writeFileSync(target, JSON.stringify(emptyState()));
    symlinkSync(target, join(h.dir, 'state.json'));
    expect(() => readCheckupState(h.dir)).toThrow('not a regular file');
    rmSync(join(h.dir, 'state.json'));
    expect(Bun.spawnSync(['mkfifo', join(h.dir, 'state.json')]).exitCode).toBe(0);
    expect(() => readCheckupState(h.dir)).toThrow('not a regular file');
  });

  test('a live lock fails the command; a dead or old one is taken over', () => {
    const h = home();
    const lock = join(h.dir, 'state.lock');
    writeFileSync(lock, `${process.ppid} ${NOW.getTime()}`);
    expect(() => updateCheckupState(h.dir, (st) => observe(st, '2.1.304'), NOW.getTime() + 1000)).toThrow('holds');
    expect(readFileSync(lock, 'utf8')).toBe(`${process.ppid} ${NOW.getTime()}`);
    writeFileSync(lock, `${DEAD_PID} ${NOW.getTime()}`);
    expect(updateCheckupState(h.dir, (st) => observe(st, '2.1.304'), NOW.getTime() + 1000).observed?.cli).toBe('2.1.304');
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, `${process.ppid} ${NOW.getTime()}`);
    expect(updateCheckupState(h.dir, (st) => observe(st, '2.1.305'), NOW.getTime() + 11 * 60_000).observed?.cli).toBe('2.1.305');
    // A lock left empty by a crash is stale too; a dir at the lock is named, not retried forever.
    writeFileSync(lock, '');
    expect(updateCheckupState(h.dir, (st) => observe(st, '2.1.306')).observed?.cli).toBe('2.1.306');
    mkdirSync(lock);
    expect(() => updateCheckupState(h.dir, (st) => st)).toThrow('not a regular file');
  });

  test('a command whose lock was taken away before its write writes nothing', () => {
    const h = home();
    updateCheckupState(h.dir, (st) => observe(st, '2.1.303'));
    const lock = join(h.dir, 'state.lock');
    expect(() =>
      updateCheckupState(h.dir, (st) => {
        // Another command's stale takeover moved this lock and a third took the name.
        writeFileSync(lock, `${process.ppid} ${Date.now()} other`);
        return observe(st, '2.1.304');
      }),
    ).toThrow('nothing was written');
    expect(readCheckupState(h.dir).observed?.cli).toBe('2.1.303');
    // The other command's lock is left alone.
    expect(readFileSync(lock, 'utf8')).toContain('other');
  });

  test('concurrent commands never lose an update', async () => {
    const h = home();
    // Each worker adds 1 to a counter kept in `observed` 40 times, retrying while another
    //   holds the lock (K1a review: 561 of 600 kept before the fix).
    const worker = `import { observe, updateCheckupState } from ${JSON.stringify(join(REPO, 'lib', 'checkup.ts'))};
      for (let i = 0; i < 40; i++) {
        for (;;) {
          try { updateCheckupState(${JSON.stringify(h.dir)}, (s) => observe(s, '1.0.' + (Number((s.observed?.cli ?? '1.0.0').split('.')[2]) + 1))); break; }
          catch (e) { if (!/holds|could not take/.test(String(e))) throw e; }
        }
      }`;
    const procs = [0, 1, 2, 3].map(() => Bun.spawn(['bun', '-e', worker], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(readCheckupState(h.dir).observed?.cli).toBe('1.0.160');
    expect(readdirSync(h.dir).sort()).toEqual(['state.json']);
  }, 60_000);
});

describe('the checkup dir', () => {
  test('never inside the plugins dir or goodboy itself; private only', () => {
    const h = tmp();
    expect(() => checkedCheckupDir({ HOME: h, GOODBOY_CHECKUP_DIR: join(h, '.claude', 'plugins', 'cache', 'x') })).toThrow("Claude Code's plugins dir");
    expect(() => checkedCheckupDir({ HOME: h, CLAUDE_CONFIG_DIR: join(h, 'cfg'), GOODBOY_CHECKUP_DIR: join(h, 'cfg', 'plugins', 'x') })).toThrow("Claude Code's plugins dir");
    expect(() => checkedCheckupDir({ HOME: h, GOODBOY_CHECKUP_DIR: join(REPO, '.tmp-checkups') })).toThrow("goodboy's own directory");
    expect(existsSync(join(REPO, '.tmp-checkups'))).toBe(false);
    const open = join(h, 'open');
    mkdirSync(open, { mode: 0o700 });
    chmodSync(open, 0o777);
    expect(() => checkedCheckupDir({ HOME: h, GOODBOY_CHECKUP_DIR: open })).toThrow('writable by others');
    // A relative override is ignored: the default under HOME.
    expect(checkupDir({ HOME: h, GOODBOY_CHECKUP_DIR: 'rel' })).toBe(join(h, '.claude', 'goodboy', 'checkups'));
    expect(checkedCheckupDir({ HOME: h, GOODBOY_CHECKUP_DIR: join(h, 'missing') }, false)).toBeNull();
  });
});

const CHANGELOG = `# Changelog

stray text before any version

## 2.1.304

- Added \`stop_hook_active\` to the StopFailure hook input
- Fixed a plugin hook running twice
  when two marketplaces list it
- Improved scrolling

## 2.1.303

- Fixed PreToolUse hooks ignoring \`permissionDecision\`
- Added CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH docs

## v2.1.301

* Fixed --debug-file writing to the wrong place
`;

describe('the changelog', () => {
  test('parse: versions, entries and continued lines', () => {
    const s = parseChangelog(CHANGELOG);
    expect(s.map((x) => x.version)).toEqual(['2.1.304', '2.1.303', '2.1.301']);
    expect(s[0].entries).toEqual(['Added `stop_hook_active` to the StopFailure hook input', 'Fixed a plugin hook running twice when two marketplaces list it', 'Improved scrolling']);
    expect(s[2].entries).toEqual(['Fixed --debug-file writing to the wrong place']);
  });

  test('range: complete, empty, downgrade, first run', () => {
    const s = parseChangelog(CHANGELOG);
    const c = changelogRange(s, '2.1.301', '2.1.304');
    expect([c.status, c.sections.map((x) => x.version), c.gaps]).toEqual(['complete', ['2.1.304', '2.1.303'], []]);
    expect(changelogRange(s, '2.1.304', '2.1.304')).toMatchObject({ status: 'empty', sections: [] });
    const d = changelogRange(s, '2.1.304', '2.1.301');
    expect([d.status, d.sections.map((x) => x.version)]).toEqual(['downgrade', ['2.1.304', '2.1.303']]);
    const f = changelogRange(s, null, '2.1.303');
    expect([f.status, f.sections.map((x) => x.version)]).toEqual(['first-run', ['2.1.303']]);
  });

  test('a range the cache does not cover is incomplete, never "nothing changed"', () => {
    const s = parseChangelog(CHANGELOG);
    // The running CLI is newer than the cache.
    const top = changelogRange(s, '2.1.303', '2.1.306');
    expect(top.status).toBe('incomplete');
    expect(top.gaps.join(' ')).toContain('no entry for 2.1.306');
    expect(top.sections.map((x) => x.version)).toEqual(['2.1.304']);
    // The last check is older than the cache's oldest entry.
    const bottom = changelogRange(s, '2.1.200', '2.1.304');
    expect(bottom.status).toBe('incomplete');
    expect(bottom.gaps.join(' ')).toContain('starts at 2.1.301');
    // No cache at all, also on a first run.
    expect(changelogRange([], '2.1.300', '2.1.304').status).toBe('incomplete');
    expect(changelogRange([], null, '2.1.304').status).toBe('incomplete');
  });

  test('triage: identifiers first, then topics; the rest is only counted', () => {
    const sections = parseChangelog(CHANGELOG);
    const t = triageChangelog(sections, ['Stop', 'stop_hook_active', 'PreToolUse', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', '--debug-file', '']);
    expect(t.counts).toEqual({ matched: 4, unmapped: 1, other: 1 });
    const by = (v: string, i: number) => t.findings.filter((f) => f.version === v)[i];
    // `Stop` is not in `StopFailure`; the field is.
    expect(by('2.1.304', 0)).toMatchObject({ bucket: 'matched', contracts: ['stop_hook_active'], confidence: 'high' });
    expect(by('2.1.304', 0).probe).toContain('recorded hook payloads');
    expect(by('2.1.304', 1)).toMatchObject({ bucket: 'unmapped', contracts: ['plugin'], confidence: 'low' });
    expect(by('2.1.303', 0).probe).toContain("goodboy's PreToolUse hook");
    expect(by('2.1.303', 1).probe).toContain('with and without CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH');
    expect(by('2.1.301', 0).probe).toContain('with --debug-file');
    // Nor at the end of a longer name; a later whole-token use still counts.
    expect(triageChangelog([{ version: '1.0.0', entries: ['Fixed SubagentStop payloads'] }], ['Stop']).counts.matched).toBe(0);
    expect(triageChangelog([{ version: '1.0.0', entries: ['Fixed StopFailure and Stop hooks'] }], ['Stop']).counts.matched).toBe(1);
    // The output can be capped; what is left out is counted.
    const many = triageChangelog([{ version: '1.0.0', entries: ['PreToolUse a', 'PreToolUse b', 'plugin c', 'plugin d', 'plugin e'] }], ['PreToolUse']);
    const lim = limitFindings(many.findings, 1, 2);
    expect(lim.listed.map((f) => f.excerpt)).toEqual(['PreToolUse a', 'plugin c', 'plugin d']);
    expect(lim.left_out).toEqual({ matched: 1, unmapped: 1 });
    const long = triageChangelog([{ version: '1.0.0', entries: [`Fixed PreToolUse ${'x'.repeat(400)}`] }], ['PreToolUse']);
    expect(long.findings[0].excerpt.length).toBe(300);
  });
});

describe('the run writer stays in runs/<run>/', () => {
  function pending() {
    const h = home();
    updateCheckupState(h.dir, (st) => beginRun(st, '2.1.304', RUN, NOW));
    const rd = makeRunDir(h.dir, RUN);
    return { ...h, rd };
  }

  test('writes a new report file of the pending run', () => {
    const p = pending();
    const path = writeRunFile(p.dir, RUN, 'report.md', '# r\n');
    expect(path).toBe(join(p.rd, 'report.md'));
    expect(readFileSync(path, 'utf8')).toBe('# r\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeRunFile(p.dir, RUN, 'report.md', 'again')).toThrow('exists');
  });

  test('refuses names that leave the dir or are not reports', () => {
    const p = pending();
    for (const name of ['../x.md', '/tmp/x.md', 'a/b.md', '.hidden.md', 'x.sh', 'x', 'x..md', `${'a'.repeat(90)}.md`]) {
      expect({ name, threw: (() => { try { writeRunFile(p.dir, RUN, name, 'x'); return false; } catch { return true; } })() }).toEqual({ name, threw: true });
    }
    expect(() => writeRunFile(p.dir, RUN, 'big.txt', 'x'.repeat(2 * 1024 * 1024 + 1))).toThrow('larger than');
  });

  test('never writes through a link, into a linked dir, or for another run', () => {
    const p = pending();
    const outside = join(p.home, 'outside.md');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(p.rd, 'linked.md'));
    expect(() => writeRunFile(p.dir, RUN, 'linked.md', 'x')).toThrow('exists');
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    // The run dir replaced by a link to elsewhere.
    const elsewhere = join(p.home, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    rmSync(p.rd, { recursive: true });
    symlinkSync(elsewhere, p.rd);
    expect(() => writeRunFile(p.dir, RUN, 'r.md', 'x')).toThrow('not a directory');
    expect(readdirSync(elsewhere)).toEqual([]);
    // A run that is not the pending one.
    expect(() => writeRunFile(p.dir, '20261020T050000Z-9', 'r.md', 'x')).toThrow('not the pending run');
    // The runs dir replaced by a link.
    const p2 = pending();
    rmSync(join(p2.dir, 'runs'), { recursive: true });
    symlinkSync(elsewhere, join(p2.dir, 'runs'));
    expect(() => writeRunFile(p2.dir, RUN, 'r.md', 'x')).toThrow('not a directory');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('the CLI', () => {
  async function cli(args: string[], env: NodeJS.ProcessEnv, stdin = '') {
    const proc = Bun.spawn(['bun', CLI, ...args], { cwd: REPO, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  }

  test('a whole run, with the changelog from the last check, in a temp HOME only', async () => {
    const h = tmp();
    const env = { HOME: h, GOODBOY_CHECKUP_DIR: '', CLAUDE_CONFIG_DIR: '' };
    const log = join(h, 'changelog.md');
    writeFileSync(log, CHANGELOG);
    // A first run, then a later one: the range starts at the last checked version.
    for (const [cli0, from, versions] of [
      ['2.1.303', null, ['2.1.303']],
      ['2.1.304', '2.1.303', ['2.1.304']],
    ] as const) {
      const b = await cli(['checkup-begin', '--cli', cli0], env);
      expect(b.code).toBe(0);
      const begun = JSON.parse(b.out) as { run: string; from: string | null; to: string };
      expect([begun.from, begun.to]).toEqual([from, cli0]);
      const c = await cli(['checkup-changelog', '--changelog', log, '--ids', 'PreToolUse,stop_hook_active'], env);
      const ch = JSON.parse(c.out) as { status: string; versions: string[] };
      expect(ch.versions).toEqual([...versions]);
      expect(ch.status).toBe(from === null ? 'first-run' : 'complete');
      expect((await cli(['checkup-write', '--run', begun.run, '--name', 'report.md'], env, '# report\n')).code).toBe(0);
      expect((await cli(['checkup-complete', '--run', begun.run], env)).code).toBe(0);
    }
    const st = JSON.parse((await cli(['checkup-state'], env)).out) as { dir: string; state: { lastChecked: { cli: string } } };
    expect(st.dir).toBe(join(h, '.claude', 'goodboy', 'checkups'));
    expect(st.state.lastChecked.cli).toBe('2.1.304');
  });

  test('a write for a run that is not pending fails with a message', async () => {
    const h = home();
    const r = await cli(['checkup-write', '--run', RUN, '--name', 'r.md'], h.env, 'x');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('not the pending run');
  });

  test('a write over the cap stops reading and fails', async () => {
    const h = home();
    const b = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], h.env)).out) as { run: string };
    const r = await cli(['checkup-write', '--run', b.run, '--name', 'big.md'], h.env, 'x'.repeat(2 * 1024 * 1024 + 10));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('larger than');
    expect(readdirSync(join(h.dir, 'runs', b.run))).toEqual([]);
  });

  test('the range a run saw reaches the next run; another session needs --replace', async () => {
    const h = home();
    const log = join(h.home, 'changelog.md');
    writeFileSync(log, '## 2.1.303\n- a\n');
    const sA = { ...h.env, CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111-2222-3333-444444444444' };
    const b1 = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], sA)).out) as { run: string };
    // The cache has no entry for the running version: incomplete, noted in the pending run.
    const c1 = JSON.parse((await cli(['checkup-changelog', '--changelog', log], sA)).out) as { status: string };
    expect(c1.status).toBe('incomplete');
    // Another session cannot take the run over by accident.
    const sB = { ...h.env, CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-1111-2222-3333-444444444444' };
    const other = await cli(['checkup-begin', '--cli', '2.1.304'], sB);
    expect(other.code).not.toBe(0);
    expect(other.err).toContain('--replace');
    // Nor complete it: that would mark a version checked that it never checked.
    const steal = await cli(['checkup-complete', '--run', b1.run], sB);
    expect(steal.code).not.toBe(0);
    expect(steal.err).toContain('another session');
    expect((await cli(['checkup-complete', '--run', b1.run], sA)).code).toBe(0);
    const b2 = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.305'], sB)).out) as { run: string; last_range: { status: string } | null; replaced: string | null };
    expect(b2.last_range?.status).toBe('incomplete');
    expect(b2.replaced).toBeNull();
    const c2 = JSON.parse((await cli(['checkup-changelog', '--changelog', log], sB)).out) as { previous_range: { status: string } | null };
    expect(c2.previous_range?.status).toBe('incomplete');
    // With --replace, the replaced run is named.
    const b3 = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.305', '--replace'], sA)).out) as { replaced: string | null };
    expect(b3.replaced).toBe(b2.run);
  });
});
