import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readRunFile } from '../lib/checkup';
import { compareRuns, issuesOf } from '../lib/compare';
import type { Component, Inventory } from '../lib/inventory';
import { pinnedModels, suggestProjects } from '../lib/inventory';
import { depthVerdict, expectedHooks, fitProbes, matcherFires, parseHookRuns, probeEstimate, type Probes, runProbes } from '../lib/probes';

// Track K, step K1d (#10): the run comparison (problems that were already there kept apart from
// update regressions), the project suggestions, and the integration probes with a fake
// `claude` (never the real one: tests/setup.ts points GOODBOY_CLAUDE_BIN at a missing path).

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'lib', 'cli.ts');
const RUN = '20261020T000000Z-1';
const PREV = '20261019T000000Z-1';
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-k1d-')));
  tmpDirs.push(d);
  return d;
}

function put(path: string, text: string, mode?: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

/** A checkup dir with run dirs holding the given files. */
function runs(files: Record<string, Record<string, unknown>>): string {
  const dir = join(tmp(), 'checkups');
  for (const [run, byName] of Object.entries(files)) {
    mkdirSync(join(dir, 'runs', run), { recursive: true, mode: 0o700 });
    for (const [name, j] of Object.entries(byName)) writeFileSync(join(dir, 'runs', run, name), JSON.stringify(j));
  }
  return dir;
}

/** Whether process `pid` is gone within 2 s: a killed child is reaped by launchd, not at once
 *  on a loaded machine (a single fixed wait flaked). */
async function gone(pid: number): Promise<boolean> {
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(50);
  return !alive();
}

async function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin = '') {
  const proc = Bun.spawn(['bun', CLI, ...args], { cwd, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

// ---- the comparison ----

/** A health.json whose steps all ran (the startup log read, each named plugin validated). */
const health = (...p: [string, string, string][]) => ({
  problems: p.map(([kind, subject, message]) => ({ kind, subject, message })),
  startupLog: { read: true },
  plugins: [...new Set(p.filter(([k]) => k.startsWith('validate')).map(([, s]) => s))].map((id) => ({ id, validate: { ok: true, errors: [], warnings: [] } })),
});

describe('problems that were already there, kept apart from regressions', () => {
  test('a first check has nothing to compare with: everything is baseline', () => {
    const dir = runs({ [RUN]: { 'health.json': health(['not-loaded', 'a@local', 'its marketplace is not known']) } });
    const c = compareRuns(dir, RUN, null);
    expect(c.baseline.map((i) => i.text)).toEqual(['not-loaded a@local: its marketplace is not known']);
    expect([c.new, c.persisting, c.resolved]).toEqual([[], [], []]);
    expect(c.sources).toEqual({ current: ['health'], previous: [] });
  });

  test('new, persisting and resolved against the last completed run; numbers do not make a problem new', () => {
    const dir = runs({
      [PREV]: {
        'health.json': health(['validate-warning', 'p@m', '/cache/p/1.0.0/CLAUDE.md is not loaded'], ['doctor-warning', 'doctor', 'leftover npm install']),
        'smoke-results.json': { results: [{ name: 'edit gates', source: 'goodboy', ok: false, steps: [{ what: 'stop', why: 'no block' }] }], problems: [] },
        'inventory.json': { problems: ['a.md is not readable'], agent_findings: [{ check: 'pinned-model', agents: ['x'], detail: 'model: claude-1-0 is pinned', certainty: 'uncertain' }] },
      },
      [RUN]: {
        'health.json': health(['validate-warning', 'p@m', '/cache/p/1.0.1/CLAUDE.md is not loaded'], ['not-loaded', 'q@local', 'its marketplace is not known']),
        'smoke-results.json': { results: [{ name: 'edit gates', source: 'goodboy', ok: true, steps: [] }], problems: [] },
        'probes.json': { findings: [{ probe: 'session', severity: 'problem', kind: 'hook-error', subject: 's', message: 'exit 1' }, { probe: 'session', severity: 'info', kind: 'depth', subject: 'depth', message: 'confirmed' }] },
      },
    });
    const c = compareRuns(dir, RUN, PREV);
    expect(c.persisting.map((i) => i.text)).toEqual(['validate-warning p@m: /cache/p/1.0.1/CLAUDE.md is not loaded']);
    expect(c.new.map((i) => i.text)).toEqual(['not-loaded q@local: its marketplace is not known']);
    expect(c.resolved.map((i) => i.text).sort()).toEqual(['doctor-warning doctor: leftover npm install', 'edit gates: stop: no block']);
    // The last run did not probe: a probe problem cannot be told new or old. Info is no problem.
    expect(c.baseline.map((i) => i.text)).toEqual(['session hook-error s: exit 1']);
    // This run has no inventory: its old problems are unchecked, not resolved.
    expect(c.resolved.some((i) => i.source === 'inventory' || i.source === 'agents')).toBe(false);
    expect(c.unchecked.map((i) => i.source).sort()).toEqual(['agents', 'inventory']);
  });

  test('numbers that name things stay in the key: two pinned models are two problems', () => {
    // Both runs probed both models; the rejected one changed (durations differ too).
    const probe = (rejected: string, ms: number) => ({
      results: ['claude-opus-4-1', 'claude-opus-4-5'].map((m) => ({ name: `model:${m}` })),
      findings: [{ probe: `model:${rejected}`, severity: 'problem', kind: 'model', subject: rejected, message: `rejected: model ${rejected} not found (${ms} ms)` }],
    });
    const dir = runs({ [PREV]: { 'probes.json': probe('claude-opus-4-1', 640) }, [RUN]: { 'probes.json': probe('claude-opus-4-5', 812) } });
    const c = compareRuns(dir, RUN, PREV);
    expect(c.new.map((i) => i.text)).toEqual(['model:claude-opus-4-5 model claude-opus-4-5: rejected: model claude-opus-4-5 not found (812 ms)']);
    expect(c.resolved.map((i) => i.text)).toEqual(['model:claude-opus-4-1 model claude-opus-4-1: rejected: model claude-opus-4-1 not found (640 ms)']);
    expect([c.persisting, c.baseline]).toEqual([[], []]);
    // The same rejection with another duration is the same problem.
    expect(compareRuns(runs({ [PREV]: { 'probes.json': probe('claude-opus-4-5', 1) }, [RUN]: { 'probes.json': probe('claude-opus-4-5', 2) } }), RUN, PREV).persisting).toHaveLength(1);
  });

  test('a problem resolves only when its check ran again; a failed step is one problem however it fails', () => {
    const dir = runs({
      [PREV]: {
        'health.json': health(['not-loaded', 'a@local', 'not known'], ['step-failed', 'doctor', 'exit 1'], ['validate-warning', 'p@m', 'no version']),
        'probes.json': { results: [{ name: 'session' }], findings: [{ probe: 'session', severity: 'problem', kind: 'hook-error', subject: 'gb Stop', message: 'exit 1' }] },
      },
      [RUN]: {
        // The startup log was not read and the session failed: their old problems are unchecked.
        //   p@m's validate was skipped this time; doctor failed again, differently.
        'health.json': { problems: [{ kind: 'step-failed', subject: 'doctor', message: 'timed out' }], startupLog: { read: false }, plugins: [{ id: 'p@m', validate: { skipped: 'disabled' } }] },
        'probes.json': { results: [{ name: 'session' }], findings: [{ probe: 'session', severity: 'problem', kind: 'session-failed', subject: 'session', message: 'exit 1, no JSON' }] },
      },
    });
    const c = compareRuns(dir, RUN, PREV);
    expect(c.persisting.map((i) => i.text)).toEqual(['step-failed doctor: timed out']);
    expect(c.unchecked.map((i) => i.text).sort()).toEqual(['not-loaded a@local: not known', 'session hook-error gb Stop: exit 1', 'validate-warning p@m: no version']);
    expect(c.resolved).toEqual([]);
    // The session ran last time without failing: its failure now is new.
    expect(c.new.map((i) => i.text)).toEqual(['session session-failed session: exit 1, no JSON']);
  });

  test('a run file that is a link, not JSON, or missing is named and not compared', () => {
    const dir = runs({ [PREV]: {}, [RUN]: { 'health.json': health(['doctor-warning', 'doctor', 'w']) } });
    const outside = put(join(tmp(), 'h.json'), JSON.stringify(health()));
    symlinkSync(outside, join(dir, 'runs', PREV, 'health.json'));
    writeFileSync(join(dir, 'runs', PREV, 'smoke-results.json'), '{not json');
    const c = compareRuns(dir, RUN, PREV);
    expect(c.problems).toEqual([`run ${PREV}: health.json is not a readable regular file of up to the run-file cap`, `run ${PREV}: smoke-results.json is not JSON`]);
    expect(c.baseline.map((i) => i.text)).toEqual(['doctor-warning doctor: w']);
    expect(compareRuns(dir, RUN, '20200101T000000Z-1').problems).toEqual(['run 20200101T000000Z-1: none of its result files is there to compare with']);
  });

  test('readRunFile reads only plain names of real private run dirs', () => {
    const dir = runs({ [RUN]: { 'health.json': {} } });
    expect(readRunFile(dir, RUN, 'health.json')).toBe('{}');
    expect(readRunFile(dir, RUN, '../state.json')).toBe('refused');
    expect(readRunFile(dir, '../x', 'health.json')).toBe('refused');
    expect(readRunFile(dir, PREV, 'health.json')).toBe('absent');
    chmodSync(join(dir, 'runs', RUN), 0o777);
    expect(readRunFile(dir, RUN, 'health.json')).toBe('refused');
  });

  test('readRunFile refuses a group-writable run dir, a linked run dir and a linked file', () => {
    const dir = runs({ [RUN]: { 'health.json': {} }, [PREV]: {} });
    chmodSync(join(dir, 'runs', RUN), 0o770);
    expect(readRunFile(dir, RUN, 'health.json')).toBe('refused');
    chmodSync(join(dir, 'runs', RUN), 0o700);
    expect(readRunFile(dir, RUN, 'health.json')).toBe('{}');
    symlinkSync(put(join(tmp(), 'h.json'), '{}'), join(dir, 'runs', PREV, 'health.json'));
    expect(readRunFile(dir, PREV, 'health.json')).toBe('refused');
    const elsewhere = join(tmp(), 'run');
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(join(elsewhere, 'health.json'), '{}');
    symlinkSync(elsewhere, join(dir, 'runs', '20261018T000000Z-1'));
    expect(readRunFile(dir, '20261018T000000Z-1', 'health.json')).toBe('refused');
  });

  test('issuesOf checks every field of files from older versions', () => {
    expect(issuesOf('health.json', { problems: [null, 3, { kind: 1 }] }).issues).toHaveLength(3);
    expect(issuesOf('smoke-results.json', { results: 'x' })).toEqual({ issues: [], covered: ['smoke:cases'], cut: [] });
    expect(issuesOf('other.json', { problems: ['x'] })).toEqual({ issues: [], covered: [], cut: [] });
  });
});

// ---- project suggestions ----

describe('projects to suggest for the registry', () => {
  function home(): { h: string; dirs: Record<string, string> } {
    const h = tmp();
    mkdirSync(join(h, '.claude'), { recursive: true });
    const dirs = {
      agents: join(h, 'w', 'agents'),
      settings: join(h, 'w', 'settings'),
      plain: join(h, 'w', 'plain'),
      registered: join(h, 'w', 'registered'),
      current: join(h, 'w', 'current'),
    };
    mkdirSync(join(dirs.agents, '.claude', 'agents'), { recursive: true });
    put(join(dirs.settings, '.claude', 'settings.json'), '{}');
    mkdirSync(dirs.plain, { recursive: true });
    mkdirSync(join(dirs.registered, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(dirs.current, '.claude', 'commands'), { recursive: true });
    const keys = [...Object.values(dirs), '/nonexistent/goodboy-k1d', 'relative/dir', h];
    put(join(h, '.claude.json'), JSON.stringify({ projects: Object.fromEntries(keys.map((k) => [k, {}])) }));
    return { h, dirs };
  }

  test('known projects with customizations, not registered, not current, not HOME', () => {
    const { h, dirs } = home();
    const s = suggestProjects({ HOME: h }, [dirs.registered], dirs.current);
    expect(s).toEqual({ suggested: [dirs.agents, dirs.settings], more: 0, problems: [] });
    expect(suggestProjects({ HOME: h }, [], dirs.current, 1)).toMatchObject({ suggested: [dirs.agents], more: 2 });
  });

  test('CLAUDE_CONFIG_DIR has its own global config; a broken one is named', () => {
    const { h, dirs } = home();
    const cfg = join(tmp(), 'cfg');
    put(join(cfg, '.claude.json'), JSON.stringify({ projects: { [dirs.settings]: {} } }));
    expect(suggestProjects({ HOME: h, CLAUDE_CONFIG_DIR: cfg }, [], dirs.current).suggested).toEqual([dirs.settings]);
    put(join(cfg, '.claude.json'), '[');
    expect(suggestProjects({ HOME: h, CLAUDE_CONFIG_DIR: cfg }, [], dirs.current).problems).toEqual([`${join(cfg, '.claude.json')} is not a readable JSON object of up to 16 MB`]);
  });

  test('the CLI only suggests: nothing is registered', async () => {
    const { h, dirs } = home();
    const env = { HOME: h, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: join(tmp(), 'checkups') };
    expect((await cli(['checkup-projects', '--add', dirs.registered], env, dirs.current)).code).toBe(0);
    const r = JSON.parse((await cli(['checkup-projects', '--suggest'], env, dirs.current)).out);
    expect(r).toEqual({ projects: [dirs.registered], suggested: [dirs.agents, dirs.settings], more_suggested: 0, problems: [] });
    expect(JSON.parse((await cli(['checkup-projects'], env, dirs.current)).out)).toEqual({ projects: [dirs.registered] });
  }, 30_000);

  test('skills, commands and local settings count; HOME (the config dir holder) never does', () => {
    const h = tmp();
    mkdirSync(join(h, '.claude', 'agents'), { recursive: true });
    const d = { skills: join(h, 'w', 's'), commands: join(h, 'w', 'c'), local: join(h, 'w', 'l') };
    mkdirSync(join(d.skills, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(d.commands, '.claude', 'commands'), { recursive: true });
    put(join(d.local, '.claude', 'settings.local.json'), '{}');
    put(join(h, '.claude.json'), JSON.stringify({ projects: Object.fromEntries([h, ...Object.values(d)].map((k) => [k, {}])) }));
    expect(suggestProjects({ HOME: h }, [], join(h, 'elsewhere'))).toEqual({ suggested: [d.commands, d.local, d.skills], more: 0, problems: [] });
  });

  test('a relative key is never resolved against the current dir', async () => {
    const { h, dirs } = home();
    mkdirSync(join(dirs.current, 'relative', 'dir', '.claude', 'agents'), { recursive: true });
    const env = { HOME: h, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: join(tmp(), 'checkups') };
    const r = await cli(['checkup-projects', '--suggest'], env, dirs.current);
    expect(JSON.parse(r.out).suggested).toEqual([dirs.agents, dirs.registered, dirs.settings]);
  }, 30_000);
});

// ---- the probes ----

const IDS = { events: [], fields: [], keys: [], flags: [], env: [] } as unknown as Inventory['identifiers'];
const hook = (name: string, scope: Component['scope'], owner: string, command: string): Component => ({ kind: 'hook', name, scope, owner, path: scope === 'plugin' ? '/p/gb/hooks/hooks.json' : '/x', configured: true, command });
const agent = (model: string): Component => ({ kind: 'agent', name: `a-${model}`, scope: 'user', owner: 'user', path: `/a/${model}.md`, configured: true, frontmatter: { model } });
const inventory = (components: Component[]): Inventory => ({ config_dir: '/c', projects: [], components, identifiers: IDS, agent_findings: [], problems: [] });

const LOG = [
  '2026-10-20T08:33:01.231Z [DEBUG] Read hooks.json for plugin gb (enabled=true): /p/gb/hooks/hooks.json',
  '2026-10-20T08:33:01.302Z [DEBUG] Loading hooks from plugin: gb',
  '2026-10-20T08:33:01.312Z [DEBUG] hooks module cc-plugin-telemetry@builtin engine.create settled in 0.8ms (native hop, next() included)',
  '2026-10-20T08:33:02.540Z [DEBUG] Hooks: checkForNewResponses returning 0 responses, 0 hooks still pending',
  '2026-10-20T08:33:02.613Z [DEBUG] Hooks: UserPromptSubmit [sh "/p/gb/bin/run.sh" ups] (plugin gb@m) finished with status 0 (64ms)',
  '2026-10-20T08:33:04.818Z [DEBUG] Hooks: PreToolUse:Read [sh "/p/gb/bin/run.sh" pre] (plugin gb@m) finished with status 0 (81ms)',
  '2026-10-20T08:33:06.070Z [DEBUG] Hooks: PreToolUse:Agent [$HOME/.claude/hooks/guard.sh] finished with status 0 (120ms)',
  '2026-10-20T08:33:07.675Z [DEBUG] Hooks: Stop [bash "/p/gb/stop.sh"] (plugin gb@m) finished with status 1 (21ms)',
  '2026-10-20T08:33:07.676Z [DEBUG] Hooks: PostToolUse:Read [sh "/p/gb/bin/run.sh" post] (plugin gb@m) finished with status 2 (5ms)',
  '2026-10-20T08:33:07.677Z [DEBUG] Hooks: Stop [x] timed out after 60000ms',
].join('\n');

/** The other outcomes 2.1.305 logs (read from its text: cancelled, timed out, moved to the
 *  background, not run, failed to start). */
const OUTCOME_LOG = [
  '2026-10-20T08:33:08.001Z [DEBUG] Hooks: Stop [/u/slow.sh] timed out after 60000ms (60012ms)',
  '2026-10-20T08:33:08.002Z [DEBUG] Hooks: PostToolUse:Read [/u/async.sh] moved to the background (4ms)',
  '2026-10-20T08:33:08.003Z [DEBUG] Hooks: Stop [/u/held.sh] not run (0ms)',
  '2026-10-20T08:33:08.004Z [DEBUG] Hooks: Stop [/nonexistent/x] (plugin gb@m) failed to start (1ms)',
  '2026-10-20T08:33:08.005Z [DEBUG] Hooks: Stop [/u/c.sh] cancelled (3ms)',
  `2026-10-20T08:33:08.006Z [DEBUG] Hooks: Stop [${'] (plugin x'.repeat(3000)}`,
].join('\n');

const COMPONENTS = [
  hook('PreToolUse[Agent|Task]', 'user', 'user', '$HOME/.claude/hooks/guard.sh'),
  hook('PreToolUse[Edit|Write]', 'user', 'user', '/u/edit.sh'),
  hook('Stop[]', 'user', 'user', '/u/never.sh'),
  hook('UserPromptSubmit[]', 'plugin', 'gb@m', 'sh "${CLAUDE_PLUGIN_ROOT}/bin/run.sh" ups'),
  hook('PostToolUse[*]', 'plugin', 'gb@m', 'sh "${CLAUDE_PLUGIN_ROOT}/bin/run.sh" post'),
  hook('SessionStart[]', 'plugin', 'gb@m', 'sh start'),
  hook('Stop[]', 'plugin', 'other@m', 'sh other'),
  hook('Stop[]', 'project', 'project:/p', 'sh project'),
];

const SESSION = { is_error: false, num_turns: 3, total_cost_usd: 0.02, modelUsage: { 'claude-haiku-5-5': {} }, subagent_stats: { spawned: 2, completed: 2, failed: 0, max_depth: 2, refused: { depth_limit: 1 } } };

const FAKE = `#!/bin/sh
# A fake claude for the probes: replays files in $FAKE_DIR and records what it was asked.
echo "$*" >> "$FAKE_DIR/calls"
echo $$ > "$FAKE_DIR/pid"
env | cut -d= -f1 | sort > "$FAKE_DIR/env-names"
echo "$TMPDIR|$CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH|$(pwd)" > "$FAKE_DIR/where"
[ -f README.md ] && [ -d .git ] && echo yes > "$FAKE_DIR/project"
[ -n "$FAKE_SLEEP" ] && sleep 5
log=""; model=""; prev=""; json=""
for a in "$@"; do
  [ "$prev" = "--debug-file" ] && log="$a"
  [ "$prev" = "--model" ] && model="$a"
  [ "$a" = "json" ] && json=1
  prev="$a"
done
if [ -n "$log" ]; then
  # The session probe.
  [ -f "$FAKE_DIR/session.log" ] && cp "$FAKE_DIR/session.log" "$log"
  cat "$FAKE_DIR/session.json"
else
  # A model probe: text mode, then JSON.
  f="$FAKE_DIR/model-$model"
  [ -f "$f.err" ] && [ -z "$json" ] && cat "$f.err" >&2
  [ -f "$f.code" ] && exit "$(cat "$f.code")"
  if [ -z "$json" ]; then echo ok
  elif [ -f "$f.json" ]; then cat "$f.json"
  else printf '{"is_error":false,"num_turns":1,"total_cost_usd":0.001,"modelUsage":{"%s":{}}}' "\${model%%\\[*}"
  fi
fi
exit 0
`;

function fakeClaude(session: unknown = SESSION, log = LOG): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = tmp();
  const bin = put(join(dir, 'claude'), FAKE, 0o755);
  put(join(dir, 'session.json'), typeof session === 'string' ? session : JSON.stringify(session));
  put(join(dir, 'session.log'), log);
  const h = tmp();
  mkdirSync(join(h, '.claude'));
  return { dir, env: { PATH: process.env.PATH, HOME: h, GOODBOY_CLAUDE_BIN: bin, FAKE_DIR: dir } };
}

const findings = (p: Awaited<ReturnType<typeof runProbes>>) => p.findings.map((f) => `${f.severity} ${f.kind} ${f.subject}`);

describe('the session probe', () => {
  test('hook runs are read from the debug log; other lines are skipped, odd ones counted', () => {
    const { runs: r, unparsed } = parseHookRuns(LOG);
    expect(unparsed).toBe(1);
    expect(r.map((x) => [x.event, x.tool, x.plugin, x.status])).toEqual([
      ['UserPromptSubmit', null, 'gb@m', 0],
      ['PreToolUse', 'Read', 'gb@m', 0],
      ['PreToolUse', 'Agent', null, 0],
      ['Stop', null, 'gb@m', 1],
      ['PostToolUse', 'Read', 'gb@m', 2],
    ]);
    expect(r[2]!.command).toBe('$HOME/.claude/hooks/guard.sh');
    const o = parseHookRuns(OUTCOME_LOG);
    expect(o.runs.map((x) => `${x.outcome} ${x.plugin ?? '-'} ${x.command} ${x.ms}`)).toEqual([
      'timed-out - /u/slow.sh 60012',
      'background - /u/async.sh 4',
      'not-run - /u/held.sh 0',
      'failed-to-start gb@m /nonexistent/x 1',
      'cancelled - /u/c.sh 3',
    ]);
    // A long hostile line is counted, quickly (the old regex backtracked on it).
    expect(o.unparsed).toBe(1);
    const t0 = Date.now();
    parseHookRuns(`x] Hooks: Stop [${'] (plugin x'.repeat(8000)}\n`.repeat(50));
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('a timeout or a failed start is a hook error; not run and cancelled are info; background is a run', async () => {
    const comps = [hook('PostToolUse[Read]', 'user', 'user', '/u/async.sh')];
    const f = fakeClaude(SESSION, OUTCOME_LOG);
    const p = await runProbes(inventory(comps), probeEstimate(RUN, inventory(comps)), { env: f.env });
    expect(findings(p).filter((x) => !x.includes('depth')).sort()).toEqual(['info hook-other settings Stop', 'info hook-other settings Stop', 'info unparsed debug log', 'problem hook-error gb@m Stop', 'problem hook-error settings Stop'].sort());
  }, 30_000);

  test('matchers: all, plain names (| , or space lists, Task for Agent) exactly, regexes anywhere', () => {
    expect(['', '*', 'Read', 'Edit|Read', 'Edit, Read', 'Re.*', 'e.d'].map((m) => matcherFires(m, 'Read'))).toEqual([true, true, true, true, true, true, true]);
    expect(['Rea', 'Edit|Write', '(', 'R', 'ReadMe|Edit', 'Rea[a-z]x'].map((m) => matcherFires(m, 'Read'))).toEqual([false, false, false, false, false, false]);
    expect([matcherFires('Task', 'Agent'), matcherFires('Agent', 'Task'), matcherFires('Bash|Task', 'Agent')]).toEqual([true, true, true]);
    // Spaces do not split a list (only `|` and commas do, as 2.1.305 reads it).
    expect([matcherFires('Read Write', 'Read'), matcherFires('Edit , Read', 'Read')]).toEqual([false, true]);
  });

  test('a configured hook counts as run only for its own command (settings) or its own plugin', async () => {
    const log = [
      '2026-10-20T08:33:01.302Z [DEBUG] Loading hooks from plugin: gb',
      '2026-10-20T08:33:01.303Z [DEBUG] Loading hooks from plugin: other',
      '2026-10-20T08:33:02.613Z [DEBUG] Hooks: UserPromptSubmit [sh x] (plugin other@m) finished with status 0 (3ms)',
      '2026-10-20T08:33:07.675Z [DEBUG] Hooks: Stop [/u/other.sh] finished with status 0 (3ms)',
      '2026-10-20T08:33:07.676Z [DEBUG] Hooks: Stop [/u/mine.sh] finished with status 0 (3ms)',
    ].join('\n');
    const comps = [hook('Stop[]', 'user', 'user', '/u/mine.sh'), hook('Stop[]', 'user', 'user', '/u/gone.sh'), hook('UserPromptSubmit[]', 'plugin', 'gb@m', 'sh x')];
    const f = fakeClaude(SESSION, log);
    const p = await runProbes(inventory(comps), probeEstimate(RUN, inventory(comps)), { env: f.env });
    expect(p.findings.filter((x) => x.kind === 'not-run').map((x) => x.subject)).toEqual(['user Stop[]', 'gb@m UserPromptSubmit[]']);
    expect(p.findings.filter((x) => x.kind === 'not-run').every((x) => x.severity === 'problem' && x.certainty === 'uncertain')).toBe(true);
  }, 30_000);

  test('depth is confirmed only when two layers ran and the third was refused', async () => {
    const f = fakeClaude();
    const verdict = async (max_depth: number, depth_limit: number) => {
      put(join(f.dir, 'session.json'), JSON.stringify({ ...SESSION, subagent_stats: { spawned: 2, completed: 2, failed: 0, max_depth, refused: { depth_limit } } }));
      const r = (await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env })).results[0]!;
      return `${max_depth}/${depth_limit} ${r.depth!.verdict}`;
    };
    expect([await verdict(2, 1), await verdict(2, 0), await verdict(1, 1), await verdict(3, 0)]).toEqual(['2/1 confirmed', '2/0 inconclusive', '1/1 inconclusive', '3/0 violated']);
    // More layers than the limit is a problem; under the user's own limit the probe's 2 is not used.
    expect(depthVerdict({ maxDepth: 2, refusedDepth: 1 }, '3', false).verdict).toBe('inconclusive');
    expect(depthVerdict({ maxDepth: 2, refusedDepth: 0 }, '1', false).verdict).toBe('violated');
  }, 30_000);

  test('expected: user hooks and loaded plugins on the events and tools the probe uses', () => {
    const e = expectedHooks([...COMPONENTS, hook('Stop[]', 'user', 'user', '')], ['gb']);
    expect(e.expected.map((h) => `${h.owner} ${h.name}`)).toEqual(['user PreToolUse[Agent|Task]', 'user Stop[]', 'gb@m UserPromptSubmit[]', 'gb@m PostToolUse[*]']);
    // A plugin's command as the log shows it; a hook without a command is counted apart.
    expect([e.expected[2]!.command, e.other]).toEqual(['sh "/p/gb/bin/run.sh" ups', 1]);
  });

  test('verdicts: a hook that did not run, one that failed, one that blocked, and depth confirmed', async () => {
    const f = fakeClaude();
    const inv = inventory(COMPONENTS);
    const p = await runProbes(inv, probeEstimate(RUN, inv), { env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_MESSAGING_TOKEN: 't' } });
    expect(findings(p).sort()).toEqual(['info depth depth', 'info hook-block gb@m PostToolUse:Read', 'info unparsed debug log', 'problem hook-error gb@m Stop', 'problem not-run user Stop[]'].sort());
    const r = p.results[0]!;
    expect(r).toMatchObject({ name: 'session', ok: true, turns: 3, costUsd: 0.02, models: ['claude-haiku-5-5'], subagents: { spawned: 2, completed: 2, failed: 0, maxDepth: 2, refusedDepth: 1 } });
    expect(r.depth?.verdict).toBe('confirmed');
    // A text-free JSON session in a temp git project with a README, with its own TMPDIR, depth 2,
    //   and without the parent session's variables; the project is removed afterwards.
    const args = readFileSync(join(f.dir, 'calls'), 'utf8');
    expect(args).toContain('--model haiku --output-format json --max-turns 8 --debug-file');
    const [tmpd, depth, cwd] = readFileSync(join(f.dir, 'where'), 'utf8').trim().split('|');
    expect([depth, tmpd!.startsWith(dirname(cwd!)), existsSync(cwd!)]).toEqual(['2', true, false]);
    expect(readFileSync(join(f.dir, 'project'), 'utf8')).toBe('yes\n');
    const names = readFileSync(join(f.dir, 'env-names'), 'utf8').split('\n');
    expect([names.includes('CLAUDE_CODE_SESSION_ID'), names.includes('CLAUDE_CODE_MESSAGING_TOKEN'), names.includes('HOME')]).toEqual([false, false, true]);
  }, 30_000);

  test('depth is inconclusive without a refusal, and says when a hook blocked a dispatch first', async () => {
    const st = { ...SESSION, subagent_stats: { spawned: 1, completed: 1, failed: 0, max_depth: 1, refused: { depth_limit: 0 } } };
    const blocked = LOG.replace('[$HOME/.claude/hooks/guard.sh] finished with status 0', '[$HOME/.claude/hooks/guard.sh] finished with status 2');
    const f = fakeClaude(st, blocked);
    const p = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env });
    expect(p.results[0]!.depth).toMatchObject({ verdict: 'inconclusive', setting: null });
    expect(p.results[0]!.depth!.why).toContain('depth reached 1; refused 0; a PreToolUse:Agent hook blocked a dispatch');
  }, 30_000);

  test("the user's depth setting is named; a failed dispatch and another model are problems", async () => {
    const st = { ...SESSION, modelUsage: { 'claude-sonnet-5-5': {} }, subagent_stats: { spawned: 1, completed: 0, failed: 1, max_depth: 1, refused: { depth_limit: 0 } } };
    const f = fakeClaude(st);
    put(join(f.env.HOME!, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1' } }));
    const p = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env });
    expect(p.results[0]!.ok).toBe(false);
    expect(p.results[0]!.depth!.why).toContain('under the depth your settings give (1)');
    expect(findings(p)).toContain('problem dispatch Agent');
    expect(findings(p)).toContain('problem model claude-sonnet-5-5');
  }, 30_000);

  test('a debug log over 16 MB keeps the hook runs of its first 16 MB, and says so', async () => {
    const big = `${LOG}\n${'x'.repeat(17 * 1024 * 1024)}\n`;
    const f = fakeClaude(SESSION, big);
    const p = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env });
    expect(findings(p)).toContain('problem hook-error gb@m Stop');
    expect(p.findings.some((x) => x.message === 'the debug log is over 16 MB: only its first 16 MB were read')).toBe(true);
    expect(findings(p)).not.toContain('problem session-failed debug log');
  }, 30_000);

  test('probes.json is fitted to the run-file cap, keeping the problems and saying it was cut', () => {
    const run = { event: 'Stop', tool: null, command: 'x'.repeat(2000), plugin: null, outcome: 'finished' as const, status: 0, ms: 1 };
    const p: Probes = {
      results: [{ name: 'session', ok: true, turns: 1, costUsd: 0, models: [], subagents: null, hookRuns: Array(200).fill(run), ms: 1 }],
      findings: [{ probe: 'session', severity: 'problem', kind: 'hook-error', subject: 's', message: 'exit 1', certainty: 'confirmed' }],
    };
    const fit = fitProbes(p, 100_000);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(100_000);
    expect(fit.findings.map((x) => x.kind)).toEqual(['hook-error', 'unparsed']);
    expect(fitProbes(p, 10_000_000)).toBe(p);
  });

  test('no JSON, a timeout, or no time left: named, never thrown', async () => {
    const f = fakeClaude('not json');
    const p = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env });
    expect(p.results[0]!.ok).toBe(false);
    expect(p.findings[0]).toMatchObject({ severity: 'problem', kind: 'session-failed' });
    const slow = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: { ...f.env, FAKE_SLEEP: '1' }, sessionMs: 1000 });
    expect(slow.results[0]!.error).toBe('timed out');
    rmSync(join(f.dir, 'calls'));
    const none = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env, totalMs: 0 });
    expect([none.results, findings(none)]).toEqual([[], ['info skipped session']]);
    expect(existsSync(join(f.dir, 'calls'))).toBe(false);
  }, 30_000);
});

describe('the model probes', () => {
  test('pinned models only, in a plain id form; the estimate changes with them', () => {
    const inv = inventory([agent('claude-old-1'), agent('sonnet'), agent('x; rm -rf /'), agent('claude-old-1'), agent('claude-sub-1'), agent('Approved:‮run\nnow')]);
    expect(pinnedModels(inv)).toEqual({ models: ['claude-old-1', 'claude-sub-1'], skipped: ['Approved:‮run\nnow', 'x; rm -rf /'] });
    const e = probeEstimate(RUN, inv);
    expect(e.sessions.map((s) => s.name)).toEqual(['session', 'model:claude-old-1', 'model:claude-sub-1']);
    expect(e.costUsd).toEqual({ low: 0.05, high: 1.1 });
    // Skipped values are quoted data, without control or bidi characters.
    expect(e.notes.at(-1)).toContain('"Approved:?run?now", "x; rm -rf /"');
    expect(probeEstimate(RUN, inv).id).toBe(e.id);
    expect(probeEstimate(RUN, inventory([agent('claude-old-1')])).id).not.toBe(e.id);
    expect(probeEstimate(PREV, inv).id).not.toBe(e.id);
  });

  test('answers as itself, substituted, retirement announced, rejected, or a failure that names no model', async () => {
    const f = fakeClaude();
    put(join(f.dir, 'model-claude-sub-1.json'), JSON.stringify({ is_error: false, modelUsage: { 'claude-new-2': {} } }));
    put(join(f.dir, 'model-claude-dated-1.json'), JSON.stringify({ is_error: false, modelUsage: { 'claude-dated-1-20260101': {}, 'claude-haiku-5-5': {} } }));
    put(join(f.dir, 'model-claude-warn-1.err'), 'Warning: claude-warn-1 will be retired on 2027-01-01');
    put(join(f.dir, 'model-claude-gone-1.err'), 'Error: model claude-gone-1 not found');
    put(join(f.dir, 'model-claude-gone-1.code'), '1');
    put(join(f.dir, 'model-claude-key-1.err'), 'Error: Invalid API key');
    put(join(f.dir, 'model-claude-key-1.code'), '1');
    const ids = ['claude-old-1', 'claude-sub-1', 'claude-warn-1', 'claude-gone-1', 'claude-key-1', 'claude-dated-1', 'claude-wide-1[1m]'];
    const inv = inventory(ids.map(agent));
    const est = probeEstimate(RUN, inv);
    const p = await runProbes(inv, { ...est, sessions: est.sessions.filter((s) => s.name !== 'session') }, { env: f.env });
    const byProbe = (m: string) => p.findings.filter((x) => x.probe === `model:${m}`).map((x) => `${x.severity} ${x.kind} ${x.message.split(':')[0]}`);
    expect(byProbe('claude-old-1')).toEqual(['info model answers as itself, with no warning; pinned, intent unconfirmed']);
    expect(byProbe('claude-sub-1')).toEqual(['problem model substituted']);
    expect(byProbe('claude-warn-1')).toEqual(['problem model retirement or remap announced']);
    expect(byProbe('claude-gone-1')).toEqual(['problem model rejected']);
    expect(byProbe('claude-key-1')).toEqual(['problem session-failed exit 1']);
    // A dated id is the same model; the CLI drops a `[1m]` suffix before the request.
    expect(byProbe('claude-dated-1')).toEqual(['info model answers as itself, with no warning; pinned, intent unconfirmed']);
    expect(byProbe('claude-wide-1[1m]')).toEqual(['info model answers as itself, with no warning; pinned, intent unconfirmed']);
    // Text mode first (the warning goes to stderr only there), then JSON, one turn each; a
    //   failed text request is not repeated in JSON.
    const calls = readFileSync(join(f.dir, 'calls'), 'utf8').trim().split('\n');
    expect(calls.every((c) => c.includes('--max-turns 1'))).toBe(true);
    expect(calls.filter((c) => c.includes('--output-format json')).length).toBe(ids.length - 2);
    expect(p.results.map((r): [string, string | null] => [r.name, r.models[0] ?? null])).toContainEqual(['model:claude-sub-1', 'claude-new-2']);
  }, 30_000);
});

// ---- the CLI ----

describe('the CLI', () => {
  test('checkup-probe runs only with the estimate the user saw, and a wrong run runs nothing', async () => {
    const f = fakeClaude();
    const checkups = join(tmp(), 'checkups');
    const env = { ...f.env, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: checkups };
    const cwd = tmp();
    const b = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], env, cwd)).out) as { run: string };
    const e = JSON.parse((await cli(['checkup-probe', '--run', b.run, '--estimate'], env, cwd)).out) as { id: string; sessions: unknown[] };
    expect(e.sessions).toHaveLength(1);
    const none = await cli(['checkup-probe', '--run', b.run], env, cwd);
    expect([none.code, none.err]).toEqual([1, 'checkup-probe: run --estimate first, show it to the user, and pass --estimate-id <id> only after they approved it\n']);
    // The refusal never hands out the id that passes.
    const wrong = await cli(['checkup-probe', '--run', b.run, '--estimate-id', '000000000000'], env, cwd);
    expect(wrong.err).toBe('checkup-probe: the estimate changed since the user approved it; run --estimate again and ask the user\n');
    const other = await cli(['checkup-probe', '--run', '20200101T000000Z-1', '--estimate-id', e.id], env, cwd);
    expect(other.err).toContain('is not the pending run');
    expect(existsSync(join(f.dir, 'calls'))).toBe(false);
    const ok = await cli(['checkup-probe', '--run', b.run, '--estimate-id', e.id], env, cwd);
    expect(ok.code).toBe(0);
    const s = JSON.parse(ok.out) as { sessions: { ok: boolean }[]; written: string };
    expect(s.sessions[0]!.ok).toBe(true);
    expect(JSON.parse(readFileSync(s.written, 'utf8')).results).toHaveLength(1);
    // The same approval again pays for nothing: the probes ran already for this run.
    const calls = readFileSync(join(f.dir, 'calls'), 'utf8');
    const again = await cli(['checkup-probe', '--run', b.run, '--estimate-id', e.id], env, cwd);
    expect([again.code, again.err]).toEqual([1, 'checkup-probe: probes.json exists for this run; the probes ran already (a new checkup run probes again)\n']);
    expect(readFileSync(join(f.dir, 'calls'), 'utf8')).toBe(calls);
  }, 60_000);

  test('an interrupted probe run kills its session and removes its temp project; old leftovers are swept', async () => {
    const f = fakeClaude();
    const t = tmp();
    const old = join(t, 'goodboy-probe-old');
    const fresh = join(t, 'goodboy-probe-fresh');
    mkdirSync(old);
    mkdirSync(fresh);
    utimesSync(old, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    const checkups = join(tmp(), 'checkups');
    const env = { ...f.env, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: checkups, TMPDIR: t, FAKE_SLEEP: '1' };
    const cwd = tmp();
    const b = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], env, cwd)).out) as { run: string };
    const e = JSON.parse((await cli(['checkup-probe', '--run', b.run, '--estimate'], env, cwd)).out) as { id: string };
    const proc = Bun.spawn(['bun', CLI, 'checkup-probe', '--run', b.run, '--estimate-id', e.id], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
    for (let i = 0; i < 100 && !existsSync(join(f.dir, 'pid')); i++) await Bun.sleep(50);
    const pid = Number(readFileSync(join(f.dir, 'pid'), 'utf8'));
    // The old leftover is swept; the fresh one and this run's own project are there. (Not a
    //   sort with a matcher in it: the random name sorts either side of `fresh`.)
    const during = readdirSync(t);
    expect(during).toContain('goodboy-probe-fresh');
    expect(during.filter((n) => n !== 'goodboy-probe-fresh')).toEqual([expect.stringMatching(/^goodboy-probe-\w{6}$/)]);
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(143);
    expect([await gone(pid), readdirSync(t)]).toEqual([true, ['goodboy-probe-fresh']]);
    expect(existsSync(join(checkups, 'runs', b.run, 'probes.json'))).toBe(false);
  }, 60_000);

  test('a run compared with the last completed one, and the changelog written to the run', async () => {
    const h = tmp();
    const checkups = join(tmp(), 'checkups');
    const env = { HOME: h, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: checkups, CLAUDE_CODE_SESSION_ID: 's-1' };
    const log = put(join(h, 'changelog.md'), '# Changelog\n\n## 2.1.304\n\n- Fixed `PreToolUse` hooks\n\n## 2.1.303\n\n- Other\n');
    const a = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.303'], env, h)).out) as { run: string };
    await cli(['checkup-write', '--run', a.run, '--name', 'health.json'], env, h, JSON.stringify(health(['doctor-warning', 'doctor', 'old'], ['doctor-warning', 'doctor', 'fixed later'])));
    expect((await cli(['checkup-complete', '--run', a.run], env, h)).code).toBe(0);
    const b = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], env, h)).out) as { run: string };
    // A wrong run fails before the range is noted in the state.
    const bad = await cli(['checkup-changelog', '--changelog', log, '--run', a.run], env, h);
    expect(bad.err).toContain('is not the pending run');
    expect(JSON.parse(readFileSync(join(checkups, 'state.json'), 'utf8')).pending.range).toBeNull();
    const c = JSON.parse((await cli(['checkup-changelog', '--changelog', log, '--ids', 'PreToolUse', '--run', b.run], env, h)).out) as { written: string; counts: { matched: number } };
    expect(c.counts.matched).toBe(1);
    expect(JSON.parse(readFileSync(c.written, 'utf8')).versions).toEqual(['2.1.304']);
    await cli(['checkup-write', '--run', b.run, '--name', 'health.json'], env, h, JSON.stringify(health(['doctor-warning', 'doctor', 'old'], ['not-loaded', 'n@local', 'new'])));
    const r = await cli(['checkup-compare', '--run', b.run], env, h);
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out) as Record<string, unknown>;
    expect(s).toMatchObject({ previous: a.run, counts: { new: 1, persisting: 1, resolved: 1, baseline: 0 }, new: ['[health] not-loaded n@local: new'], resolved: ['[health] doctor-warning doctor: fixed later'] });
    expect(JSON.parse(readFileSync(join(checkups, 'runs', b.run, 'compare.json'), 'utf8')).persisting).toHaveLength(1);
  }, 60_000);
});

// ---- checks added with the layer-1 record of the round-1 fixes ----

describe('the comparison, check by check (layer-1 additions)', () => {
  test('a failed step leaves its old problems unchecked; a cap note is no failure', () => {
    const dir = runs({
      [PREV]: { 'health.json': health(['doctor-warning', 'doctor', 'leftover npm install'], ['list-error', 'x@m', 'not installed'], ['not-loaded', 'a@local', 'not known']) },
      [RUN]: {
        'health.json': {
          problems: [
            { kind: 'step-failed', subject: 'doctor', message: 'timed out' },
            { kind: 'step-failed', subject: 'plugin list', message: 'only the first 50 of 60 plugins are checked' },
          ],
          startupLog: { read: true },
          plugins: [],
        },
      },
    });
    const c = compareRuns(dir, RUN, PREV);
    expect(c.unchecked.map((i) => i.text)).toEqual(['doctor-warning doctor: leftover npm install']);
    expect(c.resolved.map((i) => i.text).sort()).toEqual(['list-error x@m: not installed', 'not-loaded a@local: not known']);
  });

  test('a list this run cut to its cap resolves nothing from it', () => {
    const prev = {
      'health.json': health(['doctor-warning', 'doctor', 'w']),
      'inventory.json': { problems: ['a.md is not readable'], agent_findings: [{ check: 'pinned-model', agents: ['x'], detail: 'pinned' }] },
      'probes.json': { results: [{ name: 'session' }], findings: [{ probe: 'session', severity: 'problem', kind: 'not-run', subject: 'user Stop[]', message: 'no run' }] },
    };
    const cutNotes = [
      { probe: 'probes', severity: 'info', kind: 'unparsed', subject: 'probes.json', message: 'details were cut to fit the run-file cap' },
      { probe: 'session', severity: 'info', kind: 'unparsed', subject: 'debug log', message: 'the debug log is over 16 MB: only its first 16 MB were read' },
    ];
    for (const note of cutNotes) {
      const dir = runs({
        [PREV]: prev,
        [RUN]: {
          'health.json': { problems: [{ kind: 'step-failed', subject: 'health.json', message: 'details were cut to fit the run-file cap' }], startupLog: { read: true }, plugins: [] },
          'inventory.json': { problems: ['inventory.json holds the first 100 of 900 components (size cap)'], agent_findings: [] },
          'probes.json': { results: [{ name: 'session' }], findings: [note] },
        },
      });
      const c = compareRuns(dir, RUN, PREV);
      expect(c.resolved).toEqual([]);
      expect(c.unchecked.map((i) => i.source).sort()).toEqual(['agents', 'health', 'inventory', 'probes']);
    }
  });

  test('hashes, times and costs drop from the key; an exit status stays; a failed session or smoke step is one problem however it fails', () => {
    const run = (hash: string, time: string, cost: string, status: number, why: string, failure: string) => ({
      'probes.json': {
        results: [{ name: 'session' }, { name: 'model:claude-x-1' }],
        findings: [
          { probe: 'session', severity: 'problem', kind: 'hook-error', subject: 'gb@m Stop', message: `it exited with status 1: sh /c/gb/${hash}/run.sh at ${time} (${cost})` },
          { probe: 'session', severity: 'problem', kind: 'hook-error', subject: 'gb@m PostToolUse:Read', message: `it exited with status ${status}: sh post.sh` },
          { probe: 'model:claude-x-1', severity: 'problem', kind: 'session-failed', subject: 'claude-x-1', message: failure },
        ],
      },
      'smoke-results.json': { results: [{ name: 'edit gates', source: 'goodboy', ok: false, steps: [{ what: 'stop', why }] }], problems: [] },
    });
    const dir = runs({
      [PREV]: run('0a1b2c3d4e5f', '2026-10-19T08:00:00.000Z', '$0.02', 1, 'no block', 'exit 1: overloaded'),
      [RUN]: run('9f8e7d6c5b4a', '2026-10-20T09:11:12.123Z', '$0.03', 3, 'blocked too late', 'timed out'),
    });
    const c = compareRuns(dir, RUN, PREV);
    expect(c.persisting.map((i) => i.text).sort()).toEqual([
      'edit gates: stop: blocked too late',
      'model:claude-x-1 session-failed claude-x-1: timed out',
      'session hook-error gb@m Stop: it exited with status 1: sh /c/gb/9f8e7d6c5b4a/run.sh at 2026-10-20T09:11:12.123Z ($0.03)',
    ]);
    expect(c.new.map((i) => i.text)).toEqual(['session hook-error gb@m PostToolUse:Read: it exited with status 3: sh post.sh']);
    expect(c.resolved.map((i) => i.text)).toEqual(['session hook-error gb@m PostToolUse:Read: it exited with status 1: sh post.sh']);
    expect([c.baseline, c.unchecked]).toEqual([[], []]);
  });

  test('a bucket over 500 is cut, and that is named', () => {
    const dir = runs({ [RUN]: { 'inventory.json': { problems: Array.from({ length: 501 }, (_, i) => `p${i}.md is not readable`), agent_findings: [] } } });
    const c = compareRuns(dir, RUN, null);
    expect([c.baseline.length, c.problems]).toEqual([500, ['baseline: 1 more were left out']]);
  });
});

describe('suggestions, the estimate and the session probe (layer-1 additions)', () => {
  test('a linked settings file is a real setup; a dangling link is not', () => {
    const h = tmp();
    mkdirSync(join(h, '.claude'), { recursive: true });
    const linked = join(h, 'w', 'linked');
    const dangling = join(h, 'w', 'dangling');
    mkdirSync(join(linked, '.claude'), { recursive: true });
    mkdirSync(join(dangling, '.claude'), { recursive: true });
    symlinkSync(put(join(h, 'dotfiles', 'settings.json'), '{}'), join(linked, '.claude', 'settings.json'));
    symlinkSync(join(h, 'nowhere.json'), join(dangling, '.claude', 'settings.local.json'));
    put(join(h, '.claude.json'), JSON.stringify({ projects: { [linked]: {}, [dangling]: {} } }));
    expect(suggestProjects({ HOME: h }, [], join(h, 'elsewhere')).suggested).toEqual([linked]);
  });

  test('only the first 10 pinned models are probed, and that is named', () => {
    const many = inventory(Array.from({ length: 12 }, (_, i) => agent(`claude-m-${String(i).padStart(2, '0')}`)));
    const e = probeEstimate(RUN, many);
    expect(e.sessions.map((s) => s.name).at(-1)).toBe('model:claude-m-09');
    expect(e.sessions).toHaveLength(11);
    expect(e.notes).toContain('only the first 10 of 12 pinned models are probed');
  });

  test('the probes get the minutes the user approved, not more', async () => {
    const f = fakeClaude();
    const p = await runProbes(inventory([]), { ...probeEstimate(RUN, inventory([])), minutes: 0 }, { env: f.env });
    expect([p.results, findings(p)]).toEqual([[], ['info skipped session']]);
    expect(existsSync(join(f.dir, 'calls'))).toBe(false);
  }, 30_000);

  test('hook commands are masked and clipped; at most 200 runs are kept', () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const line = (cmd: string) => `2026-10-20T08:33:02.613Z [DEBUG] Hooks: Stop [${cmd}] finished with status 0 (1ms)`;
    const one = parseHookRuns(line(`curl -H "Authorization: token ${secret}" x`)).runs[0]!;
    expect([one.command.includes(secret), one.command.includes('[secret]')]).toEqual([false, true]);
    expect(parseHookRuns(line('y'.repeat(5000))).runs[0]!.command).toHaveLength(2000);
    const many = parseHookRuns(Array.from({ length: 250 }, (_, i) => line(`/u/h${i}.sh`)).join('\n'));
    expect([many.runs.length, many.unparsed]).toEqual([200, 0]);
  });

  test("the outcome is read from the line's end: a command holding a fake ending, and a line over 16 KB", () => {
    const r = parseHookRuns('2026-10-20T08:33:02.613Z [DEBUG] Hooks: Stop [echo "] (plugin evil@m) finished with status 0 (1ms)"] finished with status 1 (5ms)');
    expect(r.runs.map((x) => [x.plugin, x.status, x.ms, x.command])).toEqual([[null, 1, 5, 'echo "] (plugin evil@m) finished with status 0 (1ms)"']]);
    const long = parseHookRuns(`2026-10-20T08:33:02.613Z [DEBUG] Hooks: Stop [${'z'.repeat(17 * 1024)}] finished with status 1 (5ms)`);
    expect([long.runs.length, long.unparsed]).toEqual([0, 1]);
  });

  test('a $CLAUDE_PLUGIN_ROOT command is expanded too', () => {
    expect(expectedHooks([hook('Stop[]', 'plugin', 'gb@m', '$CLAUDE_PLUGIN_ROOT/stop.sh')], ['gb']).expected.map((h) => h.command)).toEqual(['/p/gb/stop.sh']);
  });

  test('a run is matched by event, tool and command (args appended), or as the only hook of its plugin there', async () => {
    const at = (s: string) => `2026-10-20T08:33:05.000Z [DEBUG] Hooks: ${s}`;
    const log = [
      '2026-10-20T08:33:01.302Z [DEBUG] Loading hooks from plugin: gb',
      at('Stop [/u/a.sh --flag] finished with status 0 (3ms)'),
      at('Stop [/u/abc] finished with status 0 (3ms)'),
      at('PreToolUse:Read [/u/agent.sh] finished with status 0 (3ms)'),
      at('Stop [/u/ups.sh] finished with status 0 (3ms)'),
      at('PostToolUse:Read [sh "/cache/gb/1.2.3/post.sh"] (plugin gb@m) finished with status 0 (3ms)'),
      at('Stop [sh "/cache/gb/1.2.3/stop1.sh"] (plugin gb@m) finished with status 0 (3ms)'),
    ].join('\n');
    const comps = [
      hook('Stop[]', 'user', 'user', '/u/a.sh'),
      hook('Stop[]', 'user', 'user', '/u/ab'),
      hook('PreToolUse[Agent]', 'user', 'user', '/u/agent.sh'),
      hook('UserPromptSubmit[]', 'user', 'user', '/u/ups.sh'),
      hook('Stop[]', 'user', 'user', ''),
      // The plugin's install path in the log differs from the resolved one.
      hook('PostToolUse[Read]', 'plugin', 'gb@m', 'sh "${CLAUDE_PLUGIN_ROOT}/post.sh"'),
      hook('Stop[]', 'plugin', 'gb@m', 'sh "${CLAUDE_PLUGIN_ROOT}/stop1.sh"'),
      hook('Stop[]', 'plugin', 'gb@m', 'sh "${CLAUDE_PLUGIN_ROOT}/stop2.sh"'),
    ];
    const f = fakeClaude(SESSION, log);
    const p = await runProbes(inventory(comps), probeEstimate(RUN, inventory(comps)), { env: f.env });
    expect(p.findings.filter((x) => x.kind === 'not-run').map((x) => x.subject).sort()).toEqual(['gb@m Stop[]', 'gb@m Stop[]', 'user PreToolUse[Agent]', 'user Stop[]', 'user UserPromptSubmit[]']);
    expect(findings(p)).toContain('info hook-other hooks');
  }, 30_000);

  test('a session that ends with an error, writes no debug log or only a link to one, failed; findings stop at 500', async () => {
    const f = fakeClaude({ ...SESSION, is_error: true, subtype: 'error_max_turns', result: 'stopped' });
    const errored = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env });
    expect([errored.results[0]!.ok, findings(errored).includes('problem session-failed session')]).toEqual([false, true]);
    put(join(f.dir, 'session.json'), JSON.stringify(SESSION));
    // A wrapper that leaves only a link where the debug log should be.
    const wrap = put(
      join(f.dir, 'claude-link'),
      `#!/bin/sh\n"${join(f.dir, 'claude')}" "$@"; code=$?\nprev=""; for a in "$@"; do [ "$prev" = "--debug-file" ] && log="$a"; prev="$a"; done\n[ -n "$log" ] && mv "$log" "$log.real" && ln -s "$log.real" "$log"\nexit $code\n`,
      0o755,
    );
    const linked = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: { ...f.env, GOODBOY_CLAUDE_BIN: wrap } });
    expect(findings(linked)).toContain('problem session-failed debug log');
    rmSync(join(f.dir, 'session.log'));
    const none = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env });
    expect(findings(none)).toContain('problem session-failed debug log');
    const comps = Array.from({ length: 600 }, (_, i) => hook('Stop[]', 'user', 'user', `/u/n${i}.sh`));
    put(join(f.dir, 'session.log'), LOG);
    const capped = await runProbes(inventory(comps), probeEstimate(RUN, inventory(comps)), { env: f.env });
    expect(capped.findings).toHaveLength(500);
  }, 30_000);

  test('depth: violated is a problem, confirmed is certain info, inconclusive is uncertain; a number in the settings is the limit', async () => {
    const three = { ...SESSION, subagent_stats: { spawned: 3, completed: 3, failed: 0, max_depth: 3, refused: { depth_limit: 0 } } };
    const f = fakeClaude(three);
    const depth = async () => {
      const p = await runProbes(inventory([]), probeEstimate(RUN, inventory([])), { env: f.env });
      return { verdict: p.results[0]!.depth, found: p.findings.filter((x) => x.kind === 'depth').map((x) => `${x.severity} ${x.certainty} ${x.message.split(':')[0]}`) };
    };
    expect((await depth()).found).toEqual(['problem confirmed violated']);
    put(join(f.dir, 'session.json'), JSON.stringify(SESSION));
    expect((await depth()).found).toEqual(['info confirmed confirmed']);
    put(join(f.dir, 'session.json'), JSON.stringify({ ...SESSION, subagent_stats: { ...SESSION.subagent_stats, refused: { depth_limit: 0 } } }));
    expect((await depth()).found).toEqual(['info uncertain inconclusive']);
    put(join(f.env.HOME!, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: 3 } }));
    put(join(f.dir, 'session.json'), JSON.stringify(three));
    expect((await depth()).verdict).toMatchObject({ verdict: 'inconclusive', setting: '3' });
  }, 30_000);

  test('a pinned dated id answered by its short form, a [1m] usage key, and a JSON reply without modelUsage', async () => {
    const f = fakeClaude();
    put(join(f.dir, 'model-claude-long-1-20260101.json'), JSON.stringify({ is_error: false, modelUsage: { 'claude-long-1': {} } }));
    put(join(f.dir, 'model-claude-ctx-1[1m].json'), JSON.stringify({ is_error: false, modelUsage: { 'claude-ctx-1[1m]': {} } }));
    put(join(f.dir, 'model-claude-bare-1.json'), JSON.stringify({ is_error: false, result: 'ok' }));
    const inv = inventory(['claude-long-1-20260101', 'claude-ctx-1[1m]', 'claude-bare-1'].map(agent));
    const est = probeEstimate(RUN, inv);
    const p = await runProbes(inv, { ...est, sessions: est.sessions.filter((s) => s.name !== 'session') }, { env: f.env });
    const byProbe = (m: string) => p.findings.filter((x) => x.probe === `model:${m}`).map((x) => `${x.severity} ${x.kind} ${x.message.split(':')[0]}`);
    expect(byProbe('claude-long-1-20260101')).toEqual(['info model answers as itself, with no warning; pinned, intent unconfirmed']);
    expect(byProbe('claude-ctx-1[1m]')).toEqual(['info model answers as itself, with no warning; pinned, intent unconfirmed']);
    expect(byProbe('claude-bare-1')).toEqual(['problem session-failed the JSON request gave no modelUsage (exit 0, no modelUsage)']);
  }, 30_000);

  test('fitting drops info before problems, then trims messages, and cuts hook runs to 50 of 300 characters', () => {
    type Finding = Probes['findings'][number];
    const info = (i: number): Finding => ({ probe: 'session', severity: 'info', kind: 'hook-other', subject: `s${i}`, message: 'i'.repeat(500), certainty: 'confirmed' });
    const problem = (i: number): Finding => ({ probe: 'session', severity: 'problem', kind: 'hook-error', subject: `s${i}`, message: 'p'.repeat(500), certainty: 'confirmed' });
    const result = { name: 'session', ok: true, turns: 1, costUsd: 0, models: [], subagents: null, hookRuns: [] as Probes['results'][number]['hookRuns'], ms: 1 };
    const a = fitProbes({ results: [result], findings: [problem(0), ...Array.from({ length: 300 }, (_, i) => info(i))] }, 100_000);
    expect(a.findings.map((x) => x.kind)).toEqual(['hook-error', 'unparsed']);
    const b = fitProbes({ results: [result], findings: Array.from({ length: 200 }, (_, i) => problem(i)) }, 100_000);
    expect([b.findings.length, b.findings.every((x) => x.message.length <= 200), JSON.stringify(b).length <= 100_000]).toEqual([201, true, true]);
    const run = { event: 'Stop', tool: null, command: 'x'.repeat(2000), plugin: null, outcome: 'finished' as const, status: 0, ms: 1 };
    const c = fitProbes({ results: [{ ...result, hookRuns: Array(200).fill(run) }], findings: [problem(0)] }, 100_000);
    expect([c.results[0]!.hookRuns.length, c.results[0]!.hookRuns[0]!.command.length]).toEqual([50, 300]);
  });
});

describe('the CLI (layer-1 additions)', () => {
  async function begin(env: NodeJS.ProcessEnv, cwd: string): Promise<{ run: string; id: string }> {
    const b = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], env, cwd)).out) as { run: string };
    const e = JSON.parse((await cli(['checkup-probe', '--run', b.run, '--estimate'], env, cwd)).out) as { id: string };
    return { run: b.run, id: e.id };
  }

  test('a probes.json that cannot be written still prints what the paid sessions found', async () => {
    const f = fakeClaude();
    const checkups = join(tmp(), 'checkups');
    // The file appears while the session runs, after the CLI checked for it.
    const wrap = put(join(f.dir, 'claude-taken'), `#!/bin/sh\n: > "$TAKEN"\nexec "${join(f.dir, 'claude')}" "$@"\n`, 0o755);
    const env = { ...f.env, GOODBOY_CLAUDE_BIN: wrap, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: checkups };
    const cwd = tmp();
    const g = await begin(env, cwd);
    const r = await cli(['checkup-probe', '--run', g.run, '--estimate-id', g.id], { ...env, TAKEN: join(checkups, 'runs', g.run, 'probes.json') }, cwd);
    expect(r.code).toBe(1);
    const s = JSON.parse(r.out) as { sessions: { ok: boolean }[]; written?: string; write_error: string };
    expect([s.sessions.map((x) => x.ok), s.written, s.write_error]).toEqual([[true], undefined, expect.stringContaining('exists')]);
  }, 60_000);

  test('the CLI fits probes.json to the run-file cap', async () => {
    // Control characters take six bytes each in JSON: 200 runs of 2000 are over 2 MB.
    const cmd = '\u0001'.repeat(2000);
    const log = Array.from({ length: 200 }, (_, i) => `2026-10-20T08:33:02.613Z [DEBUG] Hooks: Stop [${cmd}${i}] finished with status 0 (1ms)`).join('\n');
    const f = fakeClaude(SESSION, log);
    const checkups = join(tmp(), 'checkups');
    const env = { ...f.env, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: checkups };
    const cwd = tmp();
    const g = await begin(env, cwd);
    const r = await cli(['checkup-probe', '--run', g.run, '--estimate-id', g.id], env, cwd);
    expect([r.code, r.err]).toEqual([0, '']);
    const text = readFileSync((JSON.parse(r.out) as { written: string }).written, 'utf8');
    const j = JSON.parse(text) as Probes;
    expect([Buffer.byteLength(text) <= 2 * 1024 * 1024, j.results[0]!.hookRuns.length, j.findings.some((x) => x.subject === 'probes.json')]).toEqual([true, 50, true]);
  }, 60_000);

  test('an interrupted health check kills its skill-doctor session and removes its debug log', async () => {
    const d = tmp();
    const t = tmp();
    const bin = put(
      join(d, 'claude'),
      `#!/bin/sh\ncase "$*" in\n  "plugin list --json") echo '[]' ;;\n  *skill-doctor*) echo $$ > "$FAKE_DIR/pid"; sleep 5; echo '{}' ;;\n  *) echo '{}' ;;\nesac\n`,
      0o755,
    );
    const h = tmp();
    mkdirSync(join(h, '.claude'));
    const env = { HOME: h, GOODBOY_CLAUDE_BIN: bin, FAKE_DIR: d, TMPDIR: t, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: join(tmp(), 'checkups') };
    const proc = Bun.spawn(['bun', CLI, 'checkup-health'], { cwd: tmp(), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
    for (let i = 0; i < 100 && !existsSync(join(d, 'pid')); i++) await Bun.sleep(50);
    const pid = Number(readFileSync(join(d, 'pid'), 'utf8'));
    expect(readdirSync(t)).toEqual([expect.stringMatching(/^goodboy-checkup-log-/)]);
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(143);
    expect([await gone(pid), readdirSync(t)]).toEqual([true, []]);
  }, 60_000);

  test('the sweep removes only old probe dirs: not other names, files or links', async () => {
    const f = fakeClaude();
    const t = tmp();
    const old = new Date(Date.now() - 2 * 3600_000);
    for (const n of ['goodboy-probe-old', 'other-old', 'target-old']) {
      mkdirSync(join(t, n));
      utimesSync(join(t, n), old, old);
    }
    put(join(t, 'goodboy-probe-file'), 'x');
    utimesSync(join(t, 'goodboy-probe-file'), old, old);
    symlinkSync(join(t, 'target-old'), join(t, 'goodboy-probe-link'));
    const checkups = join(tmp(), 'checkups');
    const env = { ...f.env, CLAUDE_CONFIG_DIR: '', GOODBOY_CHECKUP_DIR: checkups, TMPDIR: t };
    const cwd = tmp();
    const g = await begin(env, cwd);
    expect((await cli(['checkup-probe', '--run', g.run, '--estimate-id', g.id], env, cwd)).code).toBe(0);
    expect(readdirSync(t).sort()).toEqual(['goodboy-probe-file', 'goodboy-probe-link', 'other-old', 'target-old']);
  }, 60_000);
});
