// Update checkups (track K, K1 #10, plan §17), step K1c: health. What the running Claude Code
// says about the setup, from its own commands, with zero model turns:
//   - `claude plugin list --json`: the installed plugins and their load errors;
//   - `claude plugin validate --json <dir>` for each enabled plugin;
//   - `claude -p /skill-doctor --output-format json --debug-file …`: skill usage, and the
//     startup log with the plugins that were not loaded and the ones whose hooks were;
//   - `claude doctor`: the installation check, which prints its fixes and applies none (a
//     session's `/doctor` can repair; this never runs it).
// Each step is bounded (a timeout, no stdin, capped output); a failed step is reported, never
// thrown. Text kept from the commands is cut, then its secrets are masked.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { type Bounded, onInterrupt, runBounded } from './bounded';
import { claudeBin } from './checkup';
import { readRegular } from './safe-read';
import { maskedClip } from './secret-patterns';

const MAX_LOG = 16 * 1024 * 1024;
const MAX_PLUGINS = 50;
/** All four steps together; past it the rest are skipped and named. */
const TOTAL_MS = 5 * 60_000;

const clip = maskedClip;

/** ANSI colors (`claude doctor` colors its warning line). */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** The parent session's own variables, which a nested `claude` must not take over: it would
 *  run as that session's child and could message it (K1c review). */
const SESSION_VARS = /^(?:CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(?:SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|ENTRYPOINT|EXECPATH|MESSAGING_\w+))$/;

/** The environment for a nested `claude`: the user's, without the parent session's. */
export function nestedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_VARS.test(k)));
}

export interface HealthProblem {
  kind: 'step-failed' | 'list-error' | 'not-loaded' | 'validate-error' | 'validate-warning' | 'skill-doctor-cost' | 'doctor-warning';
  subject: string;
  message: string;
}

export interface PluginHealth {
  id: string;
  version: string | null;
  scope: string | null;
  enabled: boolean;
  installPath: string | null;
  listErrors: string[];
  validate: { ok: boolean; errors: string[]; warnings: string[] } | { skipped: string };
  /** From the startup log: false when it says the plugin was not loaded, true when it does not
   *  (the log names no other way a plugin fails to load); null when the log was not read or
   *  the plugin is disabled. */
  loaded: boolean | null;
  /** Null as well when the log read no hooks.json of the plugin. */
  hooksLoaded: boolean | null;
}

export interface StartupLog {
  read: boolean;
  registered: string | null;
  notLoaded: { id: string; message: string }[];
  /** Plugin names whose hooks.json was read, and whose hooks were loaded. */
  hooksRead: string[];
  hooksFrom: string[];
  /** An MCP server's stderr lines are counted, never kept: they can echo anything. */
  mcpStderr: Record<string, number>;
  other: string[];
}

export interface Health {
  cli: string | null;
  plugins: PluginHealth[];
  skillDoctor: { ok: boolean; turns: number | null; costUsd: number | null; text: string; error?: string };
  startupLog: StartupLog;
  doctor: { ok: boolean; warnings: { text: string; fix?: string }[]; text: string; error?: string };
  problems: HealthProblem[];
}

const stepError = (r: Bounded): string | null => r.error ?? (r.timedOut ? 'timed out' : null);

/** `plugin validate --json` output: errors and warnings across the manifest and the contents. */
export function parseValidate(stdout: string): { ok: boolean; errors: string[]; warnings: string[] } | null {
  let j: any;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const part of [j.manifest, ...(Array.isArray(j.contents) ? j.contents : [])]) {
    if (!part || typeof part !== 'object') continue;
    const where = typeof part.file === 'string' ? part.file : '?';
    for (const [list, into] of [[part.errors, errors], [part.warnings, warnings]] as const) {
      if (!Array.isArray(list)) continue;
      for (const e of list) if (e && typeof e.message === 'string' && into.length < 20) into.push(clip(`${where}: ${e.message}`, 400));
    }
  }
  return { ok: j.success === true, errors, warnings };
}

const LOG_LINE = /^\S+ \[(WARN|ERROR)\] (.*)$/;

/** The startup log's plugin facts, from a `--debug-file` log of Claude Code 2.1.30x. */
export function parseStartupLog(text: string): StartupLog {
  // A server named `constructor` or `__proto__` is just a name: no prototype.
  const out: StartupLog = { read: true, registered: null, notLoaded: [], hooksRead: [], hooksFrom: [], mcpStderr: Object.create(null) as Record<string, number>, other: [] };
  const once = (list: string[], v: string) => {
    if (list.length < 100 && !list.includes(v)) list.push(v);
  };
  for (const line of text.split('\n')) {
    const read = /\[DEBUG\] Read hooks\.json for plugin (\S+) \(enabled=true\)/.exec(line);
    if (read) once(out.hooksRead, read[1]!);
    const from = /\[DEBUG\] Loading hooks from plugin: (\S+)/.exec(line);
    if (from) once(out.hooksFrom, from[1]!);
    const reg = /\[DEBUG\] (Registered \d+ hooks from \d+ plugins)/.exec(line);
    if (reg) out.registered = reg[1]!;
    const m = LOG_LINE.exec(line);
    if (!m) continue;
    const msg = m[2]!;
    const nl = /^plugin "([^"]+)" not loaded\b/.exec(msg);
    const mcp = /^MCP server "([^"]+)" Server stderr:/.exec(msg);
    if (nl) {
      if (out.notLoaded.length < 50 && !out.notLoaded.some((n) => n.id === nl[1])) out.notLoaded.push({ id: nl[1]!.slice(0, 200), message: clip(msg, 400) });
    } else if (mcp) {
      const k = mcp[1]!.slice(0, 100);
      if (k in out.mcpStderr || Object.keys(out.mcpStderr).length < 50) out.mcpStderr[k] = (out.mcpStderr[k] ?? 0) + 1;
    } else if (!/^NON-FATAL:/.test(msg) && out.other.length < 30) out.other.push(clip(`[${m[1]}] ${msg}`, 300));
  }
  return out;
}

/** `claude doctor`'s warnings: the `- ` items under "N warning(s) found", each with its Fix. */
export function parseDoctor(text: string): { text: string; fix?: string }[] {
  const out: { text: string; fix?: string }[] = [];
  let inList = false;
  for (const line of plain(text).split('\n')) {
    if (/^\d+ warnings? found\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const item = /^- (.+)$/.exec(line);
    const fix = /^\s+Fix: (.+)$/.exec(line);
    if (item && out.length < 30) out.push({ text: clip(item[1]!, 300) });
    else if (fix && out.length) out[out.length - 1]!.fix = clip(fix[1]!, 300);
    else if (line.trim() === '') inList = false;
  }
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 1000) : null);

/** Runs the four health steps from `cwd` (the project the checkup runs in): each command at
 *  most `timeoutMs` (skill-doctor at least 2 minutes), all of them at most `totalMs`. */
export async function checkHealth(cwd: string, opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; totalMs?: number; cli?: string | null } = {}): Promise<Health> {
  const env = nestedEnv(opts.env ?? process.env);
  const bin = claudeBin(env);
  const t = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + (opts.totalMs ?? TOTAL_MS);
  const problems: HealthProblem[] = [];
  const failed = (step: string, why: string) => problems.push({ kind: 'step-failed', subject: step, message: why });
  // The running command, killed on an interrupting signal.
  let kill: ((s: 'SIGTERM' | 'SIGKILL') => void) | null = null;
  const run = async (argv: string[], ms: number): Promise<Bounded> => {
    const left = deadline - Date.now();
    if (left < 1000) return { code: null, stdout: '', stderr: '', timedOut: false, ms: 0, error: "skipped: the checkup's time ran out" };
    return runBounded([bin, ...argv], { cwd, env, timeoutMs: Math.min(ms, left), onSpawn: (k) => (kill = k) });
  };

  // 1. The installed plugins.
  const plugins: PluginHealth[] = [];
  const list = await run(['plugin', 'list', '--json'], t);
  let rows: unknown[] = [];
  try {
    const j: unknown = JSON.parse(list.stdout);
    if (Array.isArray(j)) rows = j;
    else failed('plugin list', 'the output is not a list');
  } catch {
    failed('plugin list', stepError(list) ?? `exit ${list.code}, no JSON: ${clip(list.stderr || list.stdout, 200)}`);
  }
  if (rows.length > MAX_PLUGINS) failed('plugin list', `only the first ${MAX_PLUGINS} of ${rows.length} plugins are checked`);
  for (const r of rows.slice(0, MAX_PLUGINS) as any[]) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
    const id = r.id.slice(0, 200);
    const listErrors: string[] = Array.isArray(r.errors) ? r.errors.filter((e: unknown) => typeof e === 'string').slice(0, 10).map((e: string) => clip(e, 300)) : [];
    for (const e of listErrors) problems.push({ kind: 'list-error', subject: id, message: e });
    plugins.push({ id, version: str(r.version), scope: str(r.scope), enabled: r.enabled === true, installPath: str(r.installPath), listErrors, validate: { skipped: 'not checked' }, loaded: null, hooksLoaded: null });
  }

  // 2. Validate each enabled plugin.
  for (const p of plugins) {
    if (!p.enabled) p.validate = { skipped: 'disabled' };
    else if (!p.installPath || !isAbsolute(p.installPath)) p.validate = { skipped: 'no install path' };
    else {
      const r = await run(['plugin', 'validate', '--json', p.installPath], t);
      const v = parseValidate(r.stdout);
      if (!v) {
        p.validate = { skipped: stepError(r) ?? `exit ${r.code}, no JSON` };
        failed(`plugin validate ${p.id}`, p.validate.skipped);
        continue;
      }
      // A plugin its marketplace defines has no manifest in its dir and loads fine (2.1.304:
      //   rust-analyzer-lsp); validate cannot check it.
      if (v.errors.length > 0 && v.errors.every((e) => /: No manifest found in directory\b/.test(e))) {
        p.validate = { skipped: 'no manifest in the install dir (its marketplace defines it)' };
        continue;
      }
      p.validate = v;
      for (const e of v.errors) problems.push({ kind: 'validate-error', subject: p.id, message: e });
      for (const w of v.warnings) problems.push({ kind: 'validate-warning', subject: p.id, message: w });
    }
  }

  // 3. skill-doctor, with the startup log in a private temp dir removed afterwards.
  const skillDoctor: Health['skillDoctor'] = { ok: false, turns: null, costUsd: null, text: '' };
  let startupLog: StartupLog = { read: false, registered: null, notLoaded: [], hooksRead: [], hooksFrom: [], mcpStderr: {}, other: [] };
  const logDir = mkdtempSync(join(tmpdir(), 'goodboy-checkup-log-'));
  try {
    const logFile = join(logDir, 'debug.log');
    // A signal kills the nested session and removes its log (it holds hook commands).
    const r = await onInterrupt(
      () => {
        kill?.('SIGTERM');
        rmSync(logDir, { recursive: true, force: true });
      },
      () => run(['-p', '/skill-doctor', '--output-format', 'json', '--debug-file', logFile], Math.max(t, 120_000)),
    );
    try {
      const j = JSON.parse(r.stdout);
      skillDoctor.turns = typeof j.num_turns === 'number' ? j.num_turns : null;
      skillDoctor.costUsd = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null;
      skillDoctor.text = clip(typeof j.result === 'string' ? j.result : '', 20_000);
      skillDoctor.ok = j.is_error === false;
      if ((skillDoctor.turns ?? 0) > 0 || (skillDoctor.costUsd ?? 0) > 0) {
        problems.push({ kind: 'skill-doctor-cost', subject: 'skill-doctor', message: `it made ${skillDoctor.turns} model turns ($${skillDoctor.costUsd}); it made none on 2.1.304` });
      }
    } catch {
      skillDoctor.error = stepError(r) ?? `exit ${r.code}, no JSON: ${clip(r.stderr || r.stdout, 200)}`;
      failed('skill-doctor', skillDoctor.error);
    }
    const log = readRegular(logFile, MAX_LOG, true);
    if (typeof log === 'object') startupLog = parseStartupLog(log.text);
    else failed('startup log', `the debug log is ${log}`);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
  if (startupLog.read) {
    for (const n of startupLog.notLoaded) problems.push({ kind: 'not-loaded', subject: n.id, message: n.message });
    for (const p of plugins) {
      if (!p.enabled) continue;
      p.loaded = !startupLog.notLoaded.some((n) => n.id === p.id);
      // The log names a plugin by its name, without the marketplace.
      const name = p.id.split('@')[0]!;
      p.hooksLoaded = startupLog.hooksRead.includes(name) ? startupLog.hooksFrom.includes(name) : null;
    }
  }

  // 4. The installation check, which prints fixes and applies none.
  const doctor: Health['doctor'] = { ok: false, warnings: [], text: '' };
  const d = await run(['doctor'], t);
  const dErr = stepError(d) ?? (d.code !== 0 ? `exit ${d.code}` : null);
  if (dErr) {
    doctor.error = dErr;
    failed('doctor', dErr);
  }
  doctor.ok = dErr === null;
  doctor.text = clip(plain(d.stdout), 8000);
  doctor.warnings = parseDoctor(d.stdout);
  for (const w of doctor.warnings) problems.push({ kind: 'doctor-warning', subject: 'doctor', message: w.fix ? `${w.text} (fix: ${w.fix})` : w.text });

  return { cli: opts.cli ?? null, plugins, skillDoctor, startupLog, doctor, problems };
}

/** The lines the CLI prints; the whole result goes to the run dir. */
export function healthSummary(h: Health): Record<string, unknown> {
  const count = (k: HealthProblem['kind']) => h.problems.filter((p) => p.kind === k).length;
  return {
    plugins: h.plugins.length,
    enabled: h.plugins.filter((p) => p.enabled).length,
    not_loaded: h.startupLog.notLoaded.map((n) => n.id).slice(0, 30),
    hooks_not_loaded: h.plugins.filter((p) => p.hooksLoaded === false).map((p) => p.id).slice(0, 30),
    validate_errors: count('validate-error'),
    validate_warnings: count('validate-warning'),
    doctor_warnings: count('doctor-warning'),
    failed_steps: h.problems.filter((p) => p.kind === 'step-failed').map((p) => p.subject).slice(0, 30),
    skill_doctor_turns: h.skillDoctor.turns,
  };
}

/** The report within `max` bytes as JSON: past it, the details are cut (3 validate messages
 *  per plugin, 100 problems, 2000 characters of the skill table), and that is named. */
export function fitHealth(h: Health, max: number): Health {
  if (Buffer.byteLength(JSON.stringify(h), 'utf8') <= max) return h;
  return {
    ...h,
    plugins: h.plugins.map((p) => ('skipped' in p.validate ? p : { ...p, validate: { ...p.validate, errors: p.validate.errors.slice(0, 3), warnings: p.validate.warnings.slice(0, 3) } })),
    skillDoctor: { ...h.skillDoctor, text: h.skillDoctor.text.slice(0, 2000) },
    problems: [...h.problems.slice(0, 100), { kind: 'step-failed', subject: 'health.json', message: 'details were cut to fit the run-file cap' }],
  };
}
