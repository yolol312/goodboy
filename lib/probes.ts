// Update checkups (track K, K1 #10, plan §17), step K1d: integration sessions. Unlike health
// and smoke these make model turns, so they run only after the user approved their estimate
// (the skill asks; `checkup-probe` needs the estimate's id). Each runs in a private temp
// project with the user's real setup (that setup is what is checked), its own TMPDIR, and the
// parent session's variables dropped:
//   - session: one Haiku session that reads a file and dispatches a subagent that dispatches
//     one more, under CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2. Its debug log shows each hook
//     run (event, tool, plugin, outcome), checked against the configured hooks that should
//     have fired. The result's `subagent_stats` show the dispatches and the depth reached or
//     refused: runtime evidence, where a subagent's own account of its tools is not;
//   - model:<id>: per pinned agent model, a one-word reply in text mode (the CLI prints its
//     model warnings to stderr only there), then one in JSON (`modelUsage` names the model
//     that answered).
// The project's own hooks and plugins do not run in the temp project; the zero-turn smoke
// cases cover those.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Bounded, onInterrupt, runBounded } from './bounded';
import { claudeBin } from './checkup';
import { nestedEnv, parseStartupLog } from './health';
import { type Component, type Inventory, pinnedModels } from './inventory';
import { claudeConfigDir } from './private-files';
import { readRegular } from './safe-read';
import { maskedClip as clip } from './secret-patterns';

const MAX_LOG = 16 * 1024 * 1024;
/** A hook line longer than this is counted, not parsed. */
const MAX_LINE = 16 * 1024;
const SESSION_MS = 5 * 60_000;
const MODEL_MS = 2 * 60_000;
const MAX_MODELS = 10;
const MAX_RUNS = 200;
/** A probe dir older than this is left from an interrupted run (removed at the next start). */
const STALE_MS = 60 * 60_000;
const PREFIX = 'goodboy-probe-';
const RETIRING = /retir|deprecat|remap|will be removed|no longer/i;

/** The tools the session probe uses, and the hook events it fires (the ones its debug log
 *  shows as hook runs; SessionStart runs inside a built-in module and is not logged so). */
export const PROBE_TOOLS = ['Read', 'Agent'];
export const PROBE_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

export const SESSION_PROMPT = [
  'This is an automated checkup probe. Do exactly these steps and nothing else.',
  '1. Read README.md.',
  "2. Use the Agent tool once: a general-purpose subagent, model haiku, with this prompt: 'Use the Agent tool once: a general-purpose subagent, model haiku, with the prompt \"Try the Agent tool once with a general-purpose subagent and the prompt Reply ok. If you cannot, reply with the single word blocked.\" Then reply with the single word done.'",
  '3. Reply with the single word finished.',
].join('\n');
export const MODEL_PROMPT = 'Reply with the single word ok.';

export type HookOutcome = 'finished' | 'timed-out' | 'cancelled' | 'background' | 'not-run' | 'failed-to-start';

export interface HookRun {
  event: string;
  tool: string | null;
  command: string;
  plugin: string | null;
  outcome: HookOutcome;
  /** The exit status of a finished run. */
  status: number | null;
  ms: number;
}

/** The end of a hook line (2.1.304/305: `Hooks: <Event>[:<Tool>] [<command>] (plugin <id>)
 *  <outcome> (<ms>ms)`, the plugin part only for a plugin's hook), matched on its last
 *  characters only: the command may be long and hold anything. */
const TAIL = /\]( \(plugin ([^()]{1,300})\))? (finished with status (-?\d+|null|undefined)|timed out after \d+ms|moved to the background|not run|failed to start|cancelled) \((\d+)ms\)\s*$/;
const OUTCOMES: Record<string, HookOutcome> = { 'moved to the background': 'background', 'not run': 'not-run', 'failed to start': 'failed-to-start', cancelled: 'cancelled' };

/** The hook runs in a debug log. Lines that start like one but do not parse (or are longer
 *  than 16 KB) are counted: a new CLI may log differently. */
export function parseHookRuns(text: string): { runs: HookRun[]; unparsed: number } {
  const runs: HookRun[] = [];
  let unparsed = 0;
  for (const line of text.split('\n')) {
    const at = line.indexOf('] Hooks: ');
    if (at < 0) continue;
    const rest = line.slice(at + 9);
    const head = /^([A-Za-z]+)(?::(\S+))? \[/.exec(rest);
    if (!head) continue;
    const win = rest.slice(-500);
    const m = rest.length > MAX_LINE ? null : TAIL.exec(win);
    const cut = m ? rest.length - win.length + m.index : -1;
    if (!m || cut < head[0].length) {
      unparsed++;
      continue;
    }
    const finished = /^finished with status (.+)$/.exec(m[3]!);
    const outcome: HookOutcome = finished ? 'finished' : m[3]!.startsWith('timed out') ? 'timed-out' : OUTCOMES[m[3]!]!;
    const status = finished && /^-?\d+$/.test(finished[1]!) ? Number(finished[1]) : null;
    if (runs.length < MAX_RUNS) runs.push({ event: head[1]!, tool: head[2]?.slice(0, 200) ?? null, command: clip(rest.slice(head[0].length, cut), 2000), plugin: m[2] ?? null, outcome, status, ms: Number(m[5]) });
  }
  return { runs, unparsed };
}

/** Whether a hook's matcher fires for `tool`. Empty or `*` is every tool; plain names (split
 *  on `|` or commas, the old name `Task` taken as `Agent`) match exactly; anything else is a
 *  regex, matched anywhere in the name. Read from the CLI's text in review, not measured; a
 *  hook this gets wrong is only expected or not, never a confirmed problem. */
export function matcherFires(matcher: string, tool: string): boolean {
  const m = matcher.trim();
  if (m === '' || m === '*') return true;
  const name = (s: string) => (s === 'Task' ? 'Agent' : s);
  if (/^[\w|,\s]+$/.test(m)) return m.split(/\s*[|,]\s*/).filter(Boolean).map(name).includes(name(tool));
  try {
    return new RegExp(m).test(tool);
  } catch {
    return false;
  }
}

export interface ExpectedHook {
  name: string;
  owner: string;
  event: string;
  matcher: string;
  /** As the debug log would show it: a plugin's `${CLAUDE_PLUGIN_ROOT}` expanded. */
  command: string;
  plugin: string | null;
}

/** The configured hooks the session probe should fire: the user's settings hooks and the
 *  hooks of the plugins whose hooks the probe's startup log says were loaded, on the events
 *  and tools it uses. Project hooks do not apply in the temp project. A hook without a
 *  command (prompt, agent, http and other types) cannot be matched to a log line and is
 *  counted apart. */
export function expectedHooks(components: readonly Component[], loadedPlugins: readonly string[]): { expected: ExpectedHook[]; other: number } {
  const expected: ExpectedHook[] = [];
  let other = 0;
  for (const c of components) {
    if (c.kind !== 'hook') continue;
    const m = /^(\w+)\[(.*)\]$/.exec(c.name);
    if (!m || !PROBE_EVENTS.includes(m[1]!)) continue;
    const [, event, matcher] = m as unknown as [string, string, string];
    const plugin = c.scope === 'plugin' ? c.owner : null;
    if (plugin === null && c.scope !== 'user') continue;
    if (plugin !== null && !loadedPlugins.includes(plugin.split('@')[0]!)) continue;
    const tools = event === 'PreToolUse' || event === 'PostToolUse';
    if (tools && !PROBE_TOOLS.some((t) => matcherFires(matcher, t))) continue;
    if (!c.command) {
      other++;
      continue;
    }
    // A plugin's hooks.json is `<root>/hooks/hooks.json` (K1b reads only that file).
    const root = dirname(dirname(c.path));
    const command = plugin ? c.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('$CLAUDE_PLUGIN_ROOT', root) : c.command;
    expected.push({ name: c.name, owner: c.owner, event, matcher: tools ? matcher : '', command, plugin });
  }
  return { expected, other };
}

/** Whether `run` is a run of `h`: the same event and a tool its matcher takes; a settings hook
 *  by its command (the CLI appends a hook's args), a plugin's hook by its plugin and command,
 *  or by its plugin alone when that plugin has no other hook for this event and tool (its
 *  install path in the log may differ from the resolved one). */
function isRunOf(run: HookRun, h: ExpectedHook, all: readonly ExpectedHook[]): boolean {
  if (run.event !== h.event) return false;
  if (h.matcher !== '' && (run.tool === null || !matcherFires(h.matcher, run.tool))) return false;
  const same = (c: string) => run.command === c || run.command.startsWith(`${c} `);
  if (h.plugin === null) return run.plugin === null && same(h.command);
  if (run.plugin !== h.plugin) return false;
  if (same(h.command)) return true;
  const siblings = all.filter((o) => o.plugin === h.plugin && o.event === h.event && (h.matcher === '' || (run.tool !== null && matcherFires(o.matcher, run.tool))));
  return siblings.length === 1;
}

export interface ProbeFinding {
  probe: string;
  /** A problem goes to the comparison with the last run; info only to the report. */
  severity: 'problem' | 'info';
  kind: 'session-failed' | 'not-run' | 'hook-error' | 'hook-block' | 'hook-other' | 'unparsed' | 'dispatch' | 'depth' | 'model' | 'skipped';
  subject: string;
  message: string;
  certainty: 'confirmed' | 'uncertain';
}

export interface ProbeResult {
  name: string;
  ok: boolean;
  turns: number | null;
  costUsd: number | null;
  /** The models the result's `modelUsage` names. */
  models: string[];
  subagents: { spawned: number; completed: number; failed: number; maxDepth: number; refusedDepth: number } | null;
  /** `confirmed`: two layers ran and the third was refused; `violated`: more layers ran than
   *  the limit; else `inconclusive` and why. */
  depth?: { verdict: 'confirmed' | 'violated' | 'inconclusive'; why: string; setting: string | null };
  hookRuns: HookRun[];
  ms: number;
  error?: string;
}

export interface Probes {
  results: ProbeResult[];
  findings: ProbeFinding[];
}

export interface ProbeEstimate {
  /** Ties an approval to this estimate: `checkup-probe` runs only with the same id. */
  id: string;
  sessions: { name: string; model: string; what: string }[];
  costUsd: { low: number; high: number };
  minutes: number;
  notes: string[];
}

/** A value from a file any cloned repo can hold, on its way to the model: no control,
 *  zero-width or bidi characters, quoted, bounded. */
const invisible = (c: number): boolean => c <= 0x1f || c === 0x7f || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const quoted = (s: string): string =>
  JSON.stringify(
    [...s]
      .map((ch) => (invisible(ch.codePointAt(0)!) ? '?' : ch))
      .join('')
      .slice(0, 60),
  );

/** What the probes will run and roughly cost, before the user approves them. The session cost
 *  is from a measured run (2.1.304: about $0.01 for a read and one dispatch); a pinned model's
 *  requests cost what that model costs for Claude Code's system prompt. */
export function probeEstimate(run: string, inv: Inventory): ProbeEstimate {
  const pinned = pinnedModels(inv);
  const models = pinned.models.slice(0, MAX_MODELS);
  const sessions = [
    { name: 'session', model: 'haiku', what: 'reads a file and dispatches a subagent that dispatches one more (depth 2): hooks that fire, dispatch, depth' },
    ...models.map((m) => ({ name: `model:${m}`, model: m, what: 'two one-word replies: text mode (the CLI warning, the status), then JSON (the model that answered)' })),
  ];
  const notes = [
    'Each session uses your real setup in a temp project: your user hooks and plugins run in it, as in any session, and Claude Code keeps its transcript as for any session.',
    "The project's own hooks and plugins do not run there; the zero-turn smoke cases cover those.",
  ];
  if (pinned.models.length > MAX_MODELS) notes.push(`only the first ${MAX_MODELS} of ${pinned.models.length} pinned models are probed`);
  if (pinned.skipped.length) notes.push(`pinned values that are not plain model ids are not probed (quoted data from agent files): ${pinned.skipped.slice(0, 5).map(quoted).join(', ')}`);
  const costUsd = { low: 0.01 + models.length * 0.02, high: 0.1 + models.length * 0.5 };
  const minutes = 5 + models.length * 4;
  const id = createHash('sha256').update(JSON.stringify({ run, sessions })).digest('hex').slice(0, 12);
  return { id, sessions, costUsd, minutes, notes };
}

/** Removes probe dirs of this user that an interrupted run left behind. */
function sweepStale(now = Date.now()): void {
  let names: string[] = [];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(PREFIX)) continue;
    const p = join(tmpdir(), n);
    try {
      const st = lstatSync(p);
      const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
      if (st.isDirectory() && mine && now - st.mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true });
    } catch {
      // gone meanwhile
    }
  }
}

/** A private temp project: a git repo (without the user's git config: an init.templateDir
 *  would copy their hooks in) with a README, and a TMPDIR of its own. */
function makeProject(): { dir: string; project: string; tmp: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)));
  try {
    const project = join(dir, 'project');
    const tmp = join(dir, 'tmp');
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(tmp, { mode: 0o700 });
    writeFileSync(join(project, 'README.md'), '# probe\nA tiny project for a goodboy checkup probe.\n');
    try {
      Bun.spawnSync(['git', 'init', '-q'], { cwd: project, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    } catch {
      // no git: the session still runs
    }
    return { dir, project, tmp };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** The debug log's first 16 MB (a regular file, never through a link), and whether it was
 *  longer: hook runs are kept, never lost to the size. */
function readLog(path: string): { text: string; cut: boolean } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return { text: '', cut: false };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { text: '', cut: false };
    const n = Math.min(st.size, MAX_LOG);
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const k = readSync(fd, buf, got, n - got, got);
      if (k === 0) break;
      got += k;
    }
    return { text: buf.subarray(0, got).toString('utf8'), cut: st.size > MAX_LOG };
  } finally {
    closeSync(fd);
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The depth setting the user's settings give, which overrides the probe's own value. */
function depthSetting(env: NodeJS.ProcessEnv): string | null {
  const r = readRegular(join(claudeConfigDir(env), 'settings.json'), 1024 * 1024, true);
  if (typeof r !== 'object') return null;
  try {
    const v = JSON.parse(r.text)?.env?.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    return typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 20) : null;
  } catch {
    return null;
  }
}

/** Runs the approved probes from the estimate: the session, then each pinned model. An
 *  interrupting signal kills the running child and removes its temp project first. */
export async function runProbes(inv: Inventory, estimate: ProbeEstimate, opts: { env?: NodeJS.ProcessEnv; totalMs?: number; sessionMs?: number; modelMs?: number } = {}): Promise<Probes> {
  const base = nestedEnv(opts.env ?? process.env);
  const bin = claudeBin(base);
  // All probes together get the minutes the user approved; past them the rest are skipped
  //   and named (K1d review 2: a fixed 15 minutes cut runs the estimate promised).
  const deadline = Date.now() + (opts.totalMs ?? estimate.minutes * 60_000);
  const results: ProbeResult[] = [];
  const findings: ProbeFinding[] = [];
  const find = (f: ProbeFinding) => findings.length < 500 && findings.push({ ...f, subject: f.subject.slice(0, 200), message: f.message.slice(0, 500) });

  sweepStale();
  let current: { dir: string; kill: ((s: 'SIGTERM' | 'SIGKILL') => void) | null } | null = null;
  const cleanup = () => {
    if (!current) return;
    current.kill?.('SIGTERM');
    rmSync(current.dir, { recursive: true, force: true });
  };
  await onInterrupt(cleanup, async () => {
    for (const s of estimate.sessions) {
      if (deadline - Date.now() < 1000) {
        find({ probe: s.name, severity: 'info', kind: 'skipped', subject: s.name, message: "skipped: the probes' time ran out", certainty: 'confirmed' });
        continue;
      }
      const p = makeProject();
      current = { dir: p.dir, kill: null };
      const run = (argv: string[], ms: number, env: NodeJS.ProcessEnv) =>
        runBounded([bin, ...argv], { cwd: p.project, env, timeoutMs: Math.max(0, Math.min(ms, deadline - Date.now())), onSpawn: (k) => (current!.kill = k) });
      try {
        const env = { ...base, TMPDIR: p.tmp };
        if (s.name === 'session') {
          const log = join(p.dir, 'debug.log');
          const r = await run(['-p', SESSION_PROMPT, '--model', 'haiku', '--output-format', 'json', '--max-turns', '8', '--debug-file', log], opts.sessionMs ?? SESSION_MS, { ...env, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '2' });
          const res = emptyResult(s.name, r);
          sessionVerdicts(res, r, readLog(log), inv, depthSetting(base), find);
          results.push(res);
        } else {
          const ms = opts.modelMs ?? MODEL_MS;
          const text = await run(['-p', MODEL_PROMPT, '--model', s.model, '--max-turns', '1'], ms, env);
          const json = text.code === 0 && !text.timedOut && !text.error ? await run(['-p', MODEL_PROMPT, '--model', s.model, '--max-turns', '1', '--output-format', 'json'], ms, env) : null;
          const res = emptyResult(s.name, text);
          modelVerdicts(res, s.model, text, json, find);
          results.push(res);
        }
      } finally {
        rmSync(p.dir, { recursive: true, force: true });
        current = null;
      }
    }
  });
  return { results, findings };
}

type Find = (f: ProbeFinding) => unknown;

const emptyResult = (name: string, r: Bounded): ProbeResult => ({ name, ok: false, turns: null, costUsd: null, models: [], subagents: null, hookRuns: [], ms: r.ms });
const failure = (r: Bounded): string | null => r.error ?? (r.timedOut ? 'timed out' : null);

function parseJson(stdout: string): any {
  try {
    const j = JSON.parse(stdout);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function sessionVerdicts(res: ProbeResult, r: Bounded, log: { text: string; cut: boolean }, inv: Inventory, setting: string | null, find: Find): void {
  const probe = 'session';
  const j = parseJson(r.stdout);
  if (!j) {
    res.error = failure(r) ?? `exit ${r.code}, no JSON: ${clip(r.stderr || r.stdout, 200)}`;
    find({ probe, severity: 'problem', kind: 'session-failed', subject: 'session', message: res.error, certainty: 'confirmed' });
    return;
  }
  res.turns = typeof j.num_turns === 'number' ? j.num_turns : null;
  res.costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
  res.models = j.modelUsage && typeof j.modelUsage === 'object' ? Object.keys(j.modelUsage).slice(0, 10).map((m) => m.slice(0, 100)) : [];
  if (j.is_error !== false) {
    res.error = `the session ended with an error (${clip(String(j.subtype ?? ''), 50)}): ${clip(typeof j.result === 'string' ? j.result : '', 200)}`;
    find({ probe, severity: 'problem', kind: 'session-failed', subject: 'session', message: res.error, certainty: 'confirmed' });
  }
  for (const m of res.models) {
    if (!/haiku/i.test(m)) find({ probe, severity: 'problem', kind: 'model', subject: m, message: `the session asked for haiku and the result names ${m}`, certainty: 'confirmed' });
  }

  // Hooks: each expected one fired, and none failed.
  if (log.text === '') {
    find({ probe, severity: 'problem', kind: 'session-failed', subject: 'debug log', message: 'the session wrote no debug log: hook runs cannot be checked', certainty: 'confirmed' });
  } else {
    const hooks = parseHookRuns(log.text);
    res.hookRuns = hooks.runs;
    if (log.cut) find({ probe, severity: 'info', kind: 'unparsed', subject: 'debug log', message: 'the debug log is over 16 MB: only its first 16 MB were read', certainty: 'confirmed' });
    const { expected, other } = expectedHooks(inv.components, parseStartupLog(log.text).hooksFrom);
    for (const h of expected) {
      if (!hooks.runs.some((x) => isRunOf(x, h, expected))) {
        find({ probe, severity: 'problem', kind: 'not-run', subject: `${h.owner} ${h.name}`, message: `no run of it is in the debug log; it should fire on ${h.event}${h.matcher ? ` for Read or Agent, which the probe asks for` : ''} (or it is logged under another command text)`, certainty: 'uncertain' });
      }
    }
    if (other > 0) find({ probe, severity: 'info', kind: 'hook-other', subject: 'hooks', message: `${other} hooks without a command (prompt, agent, http and other types) are not matched against the log`, certainty: 'confirmed' });
    for (const x of hooks.runs) {
      const who = `${x.plugin ?? 'settings'} ${x.event}${x.tool ? `:${x.tool}` : ''}`;
      const cmd = x.command.slice(0, 200);
      if (x.outcome === 'finished' && x.status === 2) find({ probe, severity: 'info', kind: 'hook-block', subject: who, message: `it blocked (exit 2): ${cmd}`, certainty: 'confirmed' });
      else if (x.outcome === 'finished' && x.status !== 0) find({ probe, severity: 'problem', kind: 'hook-error', subject: who, message: `it exited with status ${x.status}: ${cmd}`, certainty: 'confirmed' });
      else if (x.outcome === 'timed-out' || x.outcome === 'failed-to-start') find({ probe, severity: 'problem', kind: 'hook-error', subject: who, message: `it ${x.outcome === 'timed-out' ? `timed out after ${x.ms} ms` : 'failed to start'}: ${cmd}`, certainty: 'confirmed' });
      else if (x.outcome === 'not-run' || x.outcome === 'cancelled') find({ probe, severity: 'info', kind: 'hook-other', subject: who, message: `${x.outcome === 'not-run' ? 'not run (withheld by the CLI)' : 'cancelled'}: ${cmd}`, certainty: 'confirmed' });
    }
    if (hooks.unparsed > 0) find({ probe, severity: 'info', kind: 'unparsed', subject: 'debug log', message: `${hooks.unparsed} hook lines in a format goodboy does not read; this CLI may log hook runs differently`, certainty: 'confirmed' });
  }

  // Dispatch and depth, from the CLI's own counts.
  const st = j.subagent_stats;
  if (!st || typeof st !== 'object') {
    find({ probe, severity: 'info', kind: 'dispatch', subject: 'subagent_stats', message: 'the result has no subagent_stats: dispatch and depth cannot be checked on this CLI', certainty: 'confirmed' });
    res.depth = { verdict: 'inconclusive', why: 'no subagent_stats in the result', setting };
  } else {
    const s = { spawned: num(st.spawned), completed: num(st.completed), failed: num(st.failed), maxDepth: num(st.max_depth), refusedDepth: num(st.refused?.depth_limit) };
    res.subagents = s;
    if (s.spawned === 0 || s.completed === 0 || s.failed > 0) {
      find({ probe, severity: 'problem', kind: 'dispatch', subject: 'Agent', message: `spawned ${s.spawned}, completed ${s.completed}, failed ${s.failed}: a dispatch did not complete`, certainty: 'confirmed' });
    }
    res.depth = depthVerdict(s, setting, res.hookRuns.some((x) => x.event === 'PreToolUse' && x.tool === 'Agent' && x.outcome === 'finished' && x.status === 2));
    const problem = res.depth.verdict === 'violated';
    find({ probe, severity: problem ? 'problem' : 'info', kind: 'depth', subject: 'depth', message: `${res.depth.verdict}: ${res.depth.why}`, certainty: res.depth.verdict === 'inconclusive' ? 'uncertain' : 'confirmed' });
  }
  res.ok = !res.error && res.subagents !== null && res.subagents.completed > 0 && res.subagents.failed === 0;
}

/** The depth verdict. The CLI normally does not offer the Agent tool at its limit (its result
 *  schema says `depth_limit` stays near zero), and the probe cannot see a subagent's tool
 *  schema; so a refusal is rare, and without one the verdict stays inconclusive. */
export function depthVerdict(s: { maxDepth: number; refusedDepth: number }, setting: string | null, hookBlocked: boolean): NonNullable<ProbeResult['depth']> {
  const limit = setting !== null && /^\d+$/.test(setting) ? Number(setting) : 2;
  const under = setting === null ? 'under depth 2' : `under the depth your settings give (${setting}), which overrides the probe's 2`;
  if (s.maxDepth > limit) return { verdict: 'violated', why: `${under}: ${s.maxDepth} layers of subagents ran, more than the limit`, setting };
  if (limit === 2 && s.maxDepth === 2 && s.refusedDepth >= 1) return { verdict: 'confirmed', why: `${under}: two layers of subagents ran and the third was refused (${s.refusedDepth})`, setting };
  const ran = s.maxDepth >= 2 ? 'two layers of subagents ran, so a subagent could start one' : `depth reached ${s.maxDepth}`;
  return {
    verdict: 'inconclusive',
    why: `${under}: ${ran}; refused ${s.refusedDepth}${hookBlocked ? '; a PreToolUse:Agent hook blocked a dispatch' : ''}. The CLI normally removes the Agent tool at its limit, which the probe cannot see, and a subagent's own account of its tools is not evidence`,
    setting,
  };
}

/** A pinned model's lifecycle (plan §17): announced retirement is a breakage risk, a verified
 *  rejection makes it unavailable, a verified substitution changes behavior. Silence proves
 *  nothing: a model that answers as itself is still "pinned; intent unconfirmed". */
function modelVerdicts(res: ProbeResult, model: string, text: Bounded, json: Bounded | null, find: Find): void {
  const probe = `model:${model}`;
  // The CLI drops a context suffix such as `[1m]` before the request, and may put it back on
  //   the `modelUsage` key (K1d review 2, read from 2.1.305's text): both sides lose it.
  const bare = (s: string) => s.replace(/\[[^\]]*\]$/, '');
  const base = bare(model);
  const said = clip(`${text.stderr}\n${text.stdout}`.trim(), 500);
  const failed = failure(text);
  if (failed || text.code !== 0) {
    const rejected = !failed && said.toLowerCase().includes(base.toLowerCase());
    res.error = failed ?? `exit ${text.code}: ${said.slice(0, 200)}`;
    find({ probe, severity: 'problem', kind: rejected ? 'model' : 'session-failed', subject: model, message: rejected ? `rejected: ${said.slice(0, 300)}` : res.error, certainty: rejected ? 'confirmed' : 'uncertain' });
    return;
  }
  const warned = RETIRING.test(text.stderr);
  if (warned) find({ probe, severity: 'problem', kind: 'model', subject: model, message: `retirement or remap announced: ${clip(text.stderr.trim(), 300)}`, certainty: 'confirmed' });
  const j = json ? parseJson(json.stdout) : null;
  if (!j || !j.modelUsage || typeof j.modelUsage !== 'object') {
    res.error = json ? (failure(json) ?? `exit ${json.code}, no modelUsage`) : 'no JSON request';
    find({ probe, severity: 'problem', kind: 'session-failed', subject: model, message: `the JSON request gave no modelUsage (${res.error}): substitution cannot be checked`, certainty: 'uncertain' });
    return;
  }
  res.ok = true;
  res.turns = typeof j.num_turns === 'number' ? j.num_turns : null;
  res.costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
  res.models = Object.keys(j.modelUsage).slice(0, 10).map((m) => m.slice(0, 100));
  // A dated id and its short form are the same model.
  const same = (key: string) => {
    const k = bare(key);
    return k === base || k.startsWith(`${base}-`) || base.startsWith(`${k}-`);
  };
  if (!res.models.some(same)) {
    find({ probe, severity: 'problem', kind: 'model', subject: model, message: `substituted: ${res.models.join(', ') || 'no model'} answered instead (a behavior change)`, certainty: 'confirmed' });
  } else if (!warned) {
    find({ probe, severity: 'info', kind: 'model', subject: model, message: 'answers as itself, with no warning; pinned, intent unconfirmed', certainty: 'confirmed' });
  }
}

/** Fits the probes to the run-file cap: hook runs, then findings, are cut, and that is named. */
export function fitProbes(p: Probes, max: number): Probes {
  const size = (x: Probes) => Buffer.byteLength(JSON.stringify(x), 'utf8');
  if (size(p) <= max) return p;
  const note: ProbeFinding = { probe: 'probes', severity: 'info', kind: 'unparsed', subject: 'probes.json', message: 'details were cut to fit the run-file cap', certainty: 'confirmed' };
  let out: Probes = { results: p.results.map((r) => ({ ...r, hookRuns: r.hookRuns.slice(0, 50).map((h) => ({ ...h, command: h.command.slice(0, 300) })) })), findings: [...p.findings, note] };
  if (size(out) > max) out = { ...out, findings: [...p.findings.filter((f) => f.severity === 'problem').slice(0, 200), note] };
  if (size(out) > max) out = { results: out.results.map((r) => ({ ...r, hookRuns: [] })), findings: out.findings.map((f) => ({ ...f, message: f.message.slice(0, 200) })) };
  return out;
}

/** The lines the CLI prints; the whole result goes to the run dir. */
export function probesSummary(p: Probes): Record<string, unknown> {
  return {
    sessions: p.results.map((r) => ({ name: r.name, ok: r.ok, turns: r.turns, cost_usd: r.costUsd, models: r.models, ...(r.subagents ? { subagents: r.subagents } : {}), ...(r.depth ? { depth: r.depth } : {}), hook_runs: r.hookRuns.length, ...(r.error ? { error: r.error } : {}) })),
    problems: p.findings.filter((f) => f.severity === 'problem').slice(0, 30),
    info: p.findings.filter((f) => f.severity === 'info').slice(0, 30),
  };
}
