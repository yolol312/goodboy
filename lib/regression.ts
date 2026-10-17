// Full regression before a push (track I, I4; plan §15.7). The push test check (track G,
// lib/push-test.ts) needs a passing layer-1 result for the exact tree handed off; that result
// covers the change's own tests. I4 adds the rest of the suite: goodboy itself runs the
// project's whole test command (`cli.ts regression`, by the test agent), times it, and records
// the exit codes with the tree it ran on. The push check then needs a passing regression of the
// tree handed off. Past the one-hour tier (a regression goodboy timed over an hour), the
// layer-1 result suffices until I5 selects the affected tests.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OBJECT_ID } from './push-test';
import { readRegular } from './safe-read';

export const REGRESSION_DIR = join('.claude', 'tests', 'regression');
/** Regression records kept per project (newest by name); older ones are pruned. */
const KEEP = 20;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 1_000_000;
/** The output kept per command: the last characters of stdout, then of stderr (kept apart,
 *  so stderr noise does not push the failing lines out). */
export const STDOUT_TAIL = 6_000;
export const STDERR_TAIL = 2_000;
/** Past this, a full regression is too long to ask before every push (plan §15.1, H6 tiers). */
export const ONE_HOUR_MS = 60 * 60_000;
/** A run is stopped after this long (`--timeout-min`, at most a day: a longer timer overflows
 *  and fires at once); it then fails. */
export const DEFAULT_TIMEOUT_MS = 180 * 60_000;
export const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
/** After a command exits, its output is read this much longer: a background child that keeps
 *  the pipes open must not hold the run (or stretch its time). */
const PIPE_GRACE_MS = 2_000;

export type RegressionMode = 'on' | 'warn' | 'off';

/** `GOODBOY_PUSH_REGRESSION`: on (default) denies the hand-off, warn tells, off skips. */
export function regressionMode(env: Record<string, string | undefined> = process.env): RegressionMode {
  const v = (env.GOODBOY_PUSH_REGRESSION ?? 'on').trim().toLowerCase();
  return v === 'off' || v === 'warn' ? v : 'on';
}

export interface RegressionRun {
  command: string;
  /** Where the command's program resolved on PATH when it ran (evidence; null: not found). */
  program?: string | null;
  exit_code: number;
  /** From the start to the command's exit. */
  duration_ms: number;
  output_tail: string;
}

/** Written only by `cli.ts regression` (the agent supplies nothing but the call). */
export interface RegressionRecord {
  timestamp: string;
  /** HEAD and the working tree (lib/push-test.ts workTreeState) when the run started. */
  commit: string | null;
  tree: string;
  /** The tree when it ended. A run that changed the tree proves nothing about either tree, so
   *  it fails (`changed_files` says which). */
  tree_after: string | null;
  changed_files?: string[];
  /** Where the commands came from (`package.json scripts.test`, `go.mod` …). */
  source: string;
  runs: RegressionRun[];
  duration_ms: number;
  verdict: 'pass' | 'fail';
}

// npm's default `test` script, which runs nothing.
const NPM_PLACEHOLDER = /^echo\s+["']?Error: no test specified["']?\s*&&\s*exit\s+1$/;

function readJson(p: string, max: number): unknown {
  const r = readRegular(p, max);
  if (typeof r === 'string') return null;
  try {
    return JSON.parse(r.text) as unknown;
  } catch {
    return null;
  }
}

function readText(p: string, max: number): string | null {
  const r = readRegular(p, max);
  return typeof r === 'string' ? null : r.text;
}

/** The project's whole test suite as commands run from the repo top, or null when goodboy
 *  finds none. Every ecosystem found counts (a repo with package.json, pytest and Go runs all
 *  three): package.json's `test:all`, else `test`, then an e2e script, by the lockfile's
 *  package manager; pytest; Go; Cargo. A Makefile `test` target only when nothing else is
 *  found (it often wraps the others). */
export function regressionCommands(top: string): { commands: string[]; source: string } | null {
  const commands: string[] = [];
  const sources: string[] = [];
  const pkg = readJson(join(top, 'package.json'), MAX_MANIFEST_BYTES) as { scripts?: Record<string, unknown> } | null;
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {};
  const script = (name: string): boolean => {
    const v = scripts[name];
    return typeof v === 'string' && v.trim() !== '' && !NPM_PLACEHOLDER.test(v.trim());
  };
  const main = script('test:all') ? 'test:all' : script('test') ? 'test' : null;
  if (main) {
    const pm = existsSync(join(top, 'bun.lock')) || existsSync(join(top, 'bun.lockb'))
      ? 'bun'
      : existsSync(join(top, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(join(top, 'yarn.lock'))
          ? 'yarn'
          : 'npm';
    const run = (name: string) => (pm === 'yarn' ? `yarn ${name}` : `${pm} run ${name}`);
    const e2e = ['test:e2e', 'e2e', 'test-e2e'].find(script);
    commands.push(run(main), ...(e2e ? [run(e2e)] : []));
    sources.push(`package.json scripts.${main}${e2e ? ` + scripts.${e2e}` : ''}`);
  }
  const pyproject = readText(join(top, 'pyproject.toml'), MAX_MANIFEST_BYTES);
  if (['pytest.ini', 'conftest.py', 'tox.ini'].some((f) => existsSync(join(top, f))) || (pyproject !== null && /\[tool\.pytest/.test(pyproject))) {
    commands.push('python3 -m pytest');
    sources.push('pytest');
  }
  if (existsSync(join(top, 'go.mod'))) {
    commands.push('go test ./...');
    sources.push('go.mod');
  }
  if (existsSync(join(top, 'Cargo.toml'))) {
    commands.push('cargo test');
    sources.push('Cargo.toml');
  }
  if (commands.length === 0) {
    const make = readText(join(top, 'Makefile'), MAX_MANIFEST_BYTES);
    if (make !== null && /^test\s*:/m.test(make)) {
      commands.push('make test');
      sources.push('Makefile test');
    }
  }
  return commands.length > 0 ? { commands, source: sources.join(' + ') } : null;
}

/** A stream's last `max` characters, read in chunks so a huge output is never held; `stop`
 *  cancels the read (a background child may keep the pipe open). */
function tailOf(stream: ReadableStream<Uint8Array>, max: number): { done: Promise<void>; text: () => string; stop: () => void } {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let kept = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        kept = (kept + dec.decode(value, { stream: true })).slice(-max);
      }
      kept = (kept + dec.decode()).slice(-max);
    } catch {
      // cancelled
    }
  })();
  return { done, text: () => kept, stop: () => void reader.cancel().catch(() => undefined) };
}

/** Runs the commands one after another from `top` (all of them, so one failure does not hide
 *  another), each through `sh -c`. A command still running at `timeoutMs` is killed and fails
 *  (exit 124). Known limit: killing `sh` may leave its children running. */
export async function runCommands(top: string, commands: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RegressionRun[]> {
  const out: RegressionRun[] = [];
  for (const command of commands) {
    const word = command.split(/\s+/)[0] ?? '';
    const program = Bun.which(word, { PATH: process.env.PATH ?? '', cwd: top }) ?? null;
    const t0 = Date.now();
    const p = Bun.spawn(['sh', '-c', command], { cwd: top, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const so = tailOf(p.stdout, STDOUT_TAIL);
    const se = tailOf(p.stderr, STDERR_TAIL);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    const code = await p.exited;
    const duration_ms = Date.now() - t0;
    clearTimeout(timer);
    await Promise.race([Promise.all([so.done, se.done]), Bun.sleep(PIPE_GRACE_MS)]);
    so.stop();
    se.stop();
    const err = se.text();
    const note = timedOut ? `\n[goodboy] stopped after ${Math.round(timeoutMs / 60_000)} min` : '';
    out.push({ command, program, exit_code: timedOut ? 124 : code, duration_ms, output_tail: so.text() + (err ? `\n[stderr]\n${err}` : '') + note });
  }
  return out;
}

/** Writes a record under `dir`'s REGRESSION_DIR (the CLI's cwd, like test-write) and prunes all
 *  but the newest KEEP. */
export function writeRegressionRecord(dir: string, rec: RegressionRecord): string {
  const at = join(dir, REGRESSION_DIR);
  mkdirSync(at, { recursive: true });
  const base = rec.timestamp.replace(/[:.]/g, '-');
  let path = join(at, `${base}.json`);
  for (let i = 1; existsSync(path); i++) path = join(at, `${base}-${i}.json`);
  writeFileSync(path, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  try {
    const names = readdirSync(at).filter((n) => n.endsWith('.json')).sort().reverse();
    for (const n of names.slice(KEEP)) unlinkSync(join(at, n));
  } catch {
    // pruning is hygiene
  }
  return path;
}

const isRun = (v: unknown): v is RegressionRun => {
  const r = v as RegressionRun;
  return !!r && typeof r.command === 'string' && Number.isInteger(r.exit_code) && Number.isFinite(r.duration_ms) && r.duration_ms >= 0 && typeof r.output_tail === 'string';
};

/** The well-formed regression records under `dir` (the session's cwd: another checkout's
 *  records never count), newest first (by name, as written). */
export function readRegressionRecords(dir: string): RegressionRecord[] {
  const at = join(dir, REGRESSION_DIR);
  let names: string[];
  try {
    if (!statSync(at).isDirectory()) return [];
    names = readdirSync(at).filter((n) => n.endsWith('.json')).sort().reverse().slice(0, KEEP * 2);
  } catch {
    return [];
  }
  const out: RegressionRecord[] = [];
  for (const n of names) {
    const v = readJson(join(at, n), MAX_RECORD_BYTES) as RegressionRecord | null;
    if (
      v &&
      typeof v.timestamp === 'string' &&
      typeof v.tree === 'string' &&
      OBJECT_ID.test(v.tree) &&
      Array.isArray(v.runs) &&
      v.runs.length > 0 &&
      v.runs.every(isRun) &&
      Number.isFinite(v.duration_ms) &&
      (v.verdict === 'pass' || v.verdict === 'fail')
    ) {
      out.push(v);
    }
  }
  return out;
}

/** A pass that holds up: the verdict says pass, every run exited 0, and the tree was the same
 *  when the run ended. */
export function regressionPassed(r: RegressionRecord): boolean {
  return r.verdict === 'pass' && r.runs.every((x) => x.exit_code === 0) && r.tree_after === r.tree;
}

export type RegressionOutcome =
  | { ok: true; relaxed?: boolean }
  | { ok: false; why: 'none' | 'failed'; rev: string; tree: string; failed?: RegressionRecord };

/** Whether `tree` (handed off as `rev`) has a passing full regression. Past the one-hour tier
 *  (the newest passing regression goodboy timed took over an hour, on any tree) the layer-1
 *  result suffices: `relaxed`. A failing run proves no length: a crafted one could be slow. */
export function checkRegression(rev: string, tree: string, records: readonly RegressionRecord[]): RegressionOutcome {
  const forTree = records.filter((r) => r.tree === tree);
  if (forTree.some(regressionPassed)) return { ok: true };
  const lastPass = records.find(regressionPassed);
  if (lastPass && lastPass.duration_ms > ONE_HOUR_MS) return { ok: true, relaxed: true };
  const failed = forTree.find((r) => !regressionPassed(r));
  return failed ? { ok: false, why: 'failed', rev, tree, failed } : { ok: false, why: 'none', rev, tree };
}

/** The model-facing denial (English, per the repo rule). */
/** A run's output for a message: the end of its stdout, then the end of its stderr, so stderr
 *  noise does not hide the failing lines (round-2 review). */
export function outputSummary(tail: string, out = 600, err = 200): string {
  const [so = '', se = ''] = tail.split('\n[stderr]\n');
  return so.slice(-out) + (se ? ` [stderr] ${se.slice(-err)}` : '');
}

export function regressionMessage(what: string, o: Extract<RegressionOutcome, { ok: false }>, cliPath: string, tester: string): string {
  const rev = o.rev === ':worktree' ? 'the working tree as it is' : o.rev;
  if (o.why === 'failed') {
    const bad = o.failed!.runs.find((x) => x.exit_code !== 0);
    const why = bad
      ? `\`${bad.command}\` exited ${bad.exit_code}. Last output: ${outputSummary(bad.output_tail)}`
      : `the run changed the working tree (${(o.failed!.changed_files ?? []).slice(0, 5).join(', ') || 'unknown files'}), so it proves neither tree; ignore or commit what the tests generate`;
    return (
      `${what} hands off ${rev}, whose full regression failed: ${why} Fix the cause (a failing test is never ` +
      'weakened or skipped to pass), run the regression again, then hand off. (push regression check, I4)'
    );
  }
  return (
    `${what} hands off ${rev} without a passing full regression of exactly that content ` +
    `(tree ${o.tree.slice(0, 10)}). Have ${tester} run \`bun "${cliPath}" regression\` from this session's directory ` +
    '(the check reads the records there): goodboy runs the ' +
    "project's whole test command, times it and records it with the tree (run it in the background when the suite is long). " +
    'A commit made after it still matches; any edit after it does not. (push regression check, I4)'
  );
}
