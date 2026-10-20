// Update checkups (track K, K1 #10, plan §17), step K1c: zero-turn smoke cases. A hook is fed
// the JSON Claude Code would send and must reach the expected decision with the expected
// consequence (trigger → decision → consequence), never just exit 0:
//   - goodboy's own cases (GOODBOY_CASES) run its hooks through bin/goodboy-run.sh, as Claude
//     Code does, step by step in one session;
//   - the user's cases for other tools' hooks come from `smoke.json` next to the checkup state
//     (the public plugin ships no one's personal setup).
// Every case runs in a new sandbox: a temp HOME that is also TMPDIR and holds the Claude config
// dir and a git project, a unique session id, and the JSON `cwd` equal to the process cwd. The
// sandbox is removed afterwards. goodboy's cases read and write no real state; a user's
// command reaches whatever it names by an absolute path (`~` is the sandbox HOME).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { runBounded } from './bounded';
import { isUnder } from './private-files';
import { readRegular } from './safe-read';
import { maskSecrets } from './secret-patterns';

export type Decision = 'allow' | 'deny' | 'ask' | 'block' | 'error';

export interface Sandbox {
  home: string;
  project: string;
  session: string;
  /** goodboy's session state dir in the sandbox. */
  state: string;
  transcript: string;
}

export interface SmokeStep {
  /** goodboy's hook name (goodboy-run.sh), or a shell command for a user case. */
  hook?: string;
  command?: string;
  event: string;
  input: (b: Sandbox) => Record<string, unknown>;
  before?: (b: Sandbox) => void;
  expect: { decision: Decision; includes?: string; exit?: number };
  /** A file the step must leave holding the text, relative to goodboy's session dir
   *  (goodboy's cases) or to the sandbox HOME (`base: 'home'`, user cases). */
  consequence?: (b: Sandbox) => { file: string; includes: string; base?: 'state' | 'home' };
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SmokeCase {
  name: string;
  source: 'goodboy' | 'user';
  steps: SmokeStep[];
}

/** Events whose exit 2 blocks something besides a tool or a permission; on the others
 *  (SessionStart, Notification, …) it only shows an error. */
const BLOCKING = new Set(['UserPromptSubmit', 'Stop', 'SubagentStop', 'PostToolUse']);

/** What Claude Code would make of a hook's exit and output. */
export function decisionOf(event: string, code: number | null, stdout: string, stderr: string): { decision: Decision; text: string } {
  if (code === 2) {
    if (event === 'PreToolUse' || event === 'PermissionRequest') return { decision: 'deny', text: stderr };
    return { decision: BLOCKING.has(event) ? 'block' : 'error', text: stderr };
  }
  if (code !== 0) return { decision: 'error', text: stderr };
  const out = stdout.trim();
  let j: any = null;
  if (out.startsWith('{')) {
    try {
      j = JSON.parse(out);
    } catch {
      return { decision: 'error', text: `invalid JSON: ${out.slice(0, 200)}` };
    }
  }
  if (!j || typeof j !== 'object') return { decision: 'allow', text: out };
  const hso = j.hookSpecificOutput && typeof j.hookSpecificOutput === 'object' ? j.hookSpecificOutput : {};
  const text = (...v: unknown[]) => v.filter((x): x is string => typeof x === 'string').join('\n');
  if (j.continue === false) return { decision: 'block', text: text(j.stopReason) };
  if (event === 'PermissionRequest') {
    // 2.1.304: `hookSpecificOutput.decision.behavior`; with none, the user is asked as usual.
    const d = hso.decision && typeof hso.decision === 'object' ? hso.decision : {};
    if (d.behavior === 'allow' || d.behavior === 'deny') return { decision: d.behavior, text: text(d.message, j.systemMessage) };
    return { decision: 'ask', text: text(j.systemMessage) };
  }
  if (event === 'PreToolUse') {
    const d = hso.permissionDecision;
    if (d === 'deny' || d === 'ask' || d === 'allow') return { decision: d, text: text(hso.permissionDecisionReason, j.systemMessage) };
    if (j.decision === 'block') return { decision: 'deny', text: text(j.reason) };
    return { decision: 'allow', text: text(hso.additionalContext, j.systemMessage) };
  }
  if (j.decision === 'block') return { decision: 'block', text: text(j.reason) };
  return { decision: 'allow', text: text(hso.additionalContext, j.systemMessage) };
}

// ---- goodboy's own cases ----

const SRC = 'src/a.ts';
const source = (b: Sandbox) => join(b.project, SRC);
const edit = (b: Sandbox) => ({ tool_name: 'Edit', tool_input: { file_path: source(b), old_string: '1', new_string: '2' } });
const gate = (name: string, decision: string) => () => ({ file: 'gate-log.jsonl', includes: `"gate":"${name}","decision":"${decision}"` });

/** goodboy's hooks under its default settings. They change with goodboy and are checked
 *  against its own hooks by tests/k1c-health-smoke.test.ts. */
export const GOODBOY_CASES: SmokeCase[] = [
  {
    name: 'session start: a project without a policy file is told so',
    source: 'goodboy',
    steps: [{ hook: 'session-start', event: 'SessionStart', input: () => ({ source: 'startup' }), expect: { decision: 'allow', includes: 'no .goodboy/policy.md' } }],
  },
  {
    name: 'edit gates: the skill rule and read-before-edit deny, a read lets the edit pass, Stop asks for review',
    source: 'goodboy',
    steps: [
      { hook: 'user-prompt-submit', event: 'UserPromptSubmit', input: () => ({ prompt: `fix the bug in ${SRC}` }), expect: { decision: 'allow', includes: 'self-assessment' }, consequence: () => ({ file: 'dispatch-log.jsonl', includes: '"k":"prompt"' }) },
      { hook: 'pre-tool-use', event: 'PreToolUse', input: edit, expect: { decision: 'deny', includes: 'skill rule' }, consequence: gate('skill-rule', 'deny') },
      { hook: 'post-tool-use', event: 'PostToolUse', input: () => ({ tool_name: 'Skill', tool_input: { skill: 'goodboy:fix-bug' }, tool_response: 'ok' }), expect: { decision: 'allow' }, consequence: () => ({ file: 'skill-evidence.jsonl', includes: '"name":"fix-bug"' }) },
      { hook: 'pre-tool-use', event: 'PreToolUse', input: edit, expect: { decision: 'deny', includes: 'Read this file' }, consequence: gate('read-before-edit', 'deny') },
      {
        hook: 'post-tool-use',
        event: 'PostToolUse',
        input: (b) => ({ tool_name: 'Read', tool_input: { file_path: source(b) }, tool_response: { type: 'text', file: { filePath: source(b), content: 'export const a = 1;\n', numLines: 1, startLine: 1, totalLines: 1 } } }),
        expect: { decision: 'allow' },
        consequence: (b) => ({ file: 'reads.jsonl', includes: source(b) }),
      },
      { hook: 'pre-tool-use', event: 'PreToolUse', input: edit, expect: { decision: 'allow' } },
      {
        hook: 'post-tool-use',
        event: 'PostToolUse',
        before: (b) => writeFileSync(source(b), 'export const a = 2;\n'),
        input: (b) => ({ ...edit(b), tool_response: { filePath: source(b) } }),
        expect: { decision: 'allow' },
        consequence: (b) => ({ file: 'edits.jsonl', includes: source(b) }),
      },
      { hook: 'stop', event: 'Stop', input: () => ({ stop_hook_active: false }), expect: { decision: 'block', includes: 'Review is required' }, consequence: () => ({ file: '.goodboy-review-validate-retry-count.txt', includes: '1' }) },
    ],
  },
  {
    name: 'bash: a bare cat of a large file is denied',
    source: 'goodboy',
    steps: [
      {
        hook: 'pre-tool-use',
        event: 'PreToolUse',
        before: (b) => writeFileSync(join(b.project, 'big.log'), 'x'.repeat(300_000)),
        input: () => ({ tool_name: 'Bash', tool_input: { command: 'cat big.log' } }),
        expect: { decision: 'deny' },
        consequence: gate('cat-dump', 'deny'),
      },
    ],
  },
];

// ---- the user's cases ----

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SubagentStart', 'SessionStart', 'SessionEnd', 'Notification', 'PreCompact', 'PermissionRequest'];
const DECISIONS: Decision[] = ['allow', 'deny', 'ask', 'block', 'error'];
/** The sandbox's own variables, which a case cannot set. */
const SANDBOX_KEYS = new Set(['HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECT_DIR']);
export const SMOKE_FILE = 'smoke.json';
const MAX_SMOKE_BYTES = 256 * 1024;
const MAX_CASES = 50;

/** The user's cases from `smoke.json` in the checkup dir:
 *  `{"cases": [{"name", "event", "command", "input"?, "expect": {"decision"?, "includes"?,
 *  "exit"?}, "files"?: [{"path", "includes"?}], "env"?, "timeoutMs"?}]}`. Its commands run, so
 *  the file must be a regular file of this user that others cannot write. A bad case is named
 *  as a problem and does not run. */
export function readUserCases(dir: string): { cases: SmokeCase[]; problems: string[] } {
  const r = readRegular(join(dir, SMOKE_FILE), MAX_SMOKE_BYTES, true);
  if (r === 'absent') return { cases: [], problems: [] };
  if (r === 'refused') return { cases: [], problems: [`${SMOKE_FILE} is not a regular file up to ${MAX_SMOKE_BYTES} bytes`] };
  if (typeof process.getuid === 'function' && r.st.uid !== process.getuid()) return { cases: [], problems: [`${SMOKE_FILE} is not owned by this user`] };
  if ((r.st.mode & 0o022) !== 0) return { cases: [], problems: [`${SMOKE_FILE} is writable by others`] };
  let j: any;
  try {
    j = JSON.parse(r.text);
  } catch (e) {
    return { cases: [], problems: [`${SMOKE_FILE} is not JSON: ${String((e as Error).message).slice(0, 120)}`] };
  }
  if (!j || !Array.isArray(j.cases)) return { cases: [], problems: [`${SMOKE_FILE} has no "cases" list`] };
  const cases: SmokeCase[] = [];
  const problems: string[] = [];
  j.cases.slice(0, MAX_CASES).forEach((c: any, i: number) => {
    const why = badCase(c);
    if (why) {
      problems.push(`case ${i + 1}${typeof c?.name === 'string' ? ` (${c.name.slice(0, 80)})` : ''}: ${why}`);
      return;
    }
    const input = (c.input ?? {}) as Record<string, unknown>;
    const file = (c.files as { path: string; includes?: string }[] | undefined)?.[0];
    cases.push({
      name: c.name,
      source: 'user',
      steps: [
        {
          command: c.command,
          event: c.event,
          input: () => input,
          expect: { decision: c.expect.decision ?? 'allow', includes: c.expect.includes, exit: c.expect.exit },
          consequence: file ? () => ({ file: file.path, includes: file.includes ?? '', base: 'home' }) : undefined,
          env: c.env,
          timeoutMs: c.timeoutMs,
        },
      ],
    });
  });
  if (j.cases.length > MAX_CASES) problems.push(`only the first ${MAX_CASES} of ${j.cases.length} cases run`);
  return { cases, problems };
}

function badCase(c: any): string | null {
  if (!c || typeof c !== 'object') return 'not an object';
  if (typeof c.name !== 'string' || c.name.trim() === '' || c.name.length > 80) return 'needs a "name" up to 80 characters';
  if (!HOOK_EVENTS.includes(c.event)) return `"event" must be one of ${HOOK_EVENTS.join(', ')}`;
  if (typeof c.command !== 'string' || c.command.trim() === '' || c.command.length > 2000) return 'needs a "command" up to 2000 characters';
  if (c.input !== undefined && (!c.input || typeof c.input !== 'object' || Array.isArray(c.input))) return '"input" must be an object';
  const e = c.expect;
  if (!e || typeof e !== 'object') return 'needs an "expect" object';
  if (e.decision !== undefined && !DECISIONS.includes(e.decision)) return `"expect.decision" must be one of ${DECISIONS.join(', ')}`;
  if (e.includes !== undefined && typeof e.includes !== 'string') return '"expect.includes" must be a string';
  if (e.exit !== undefined && !Number.isInteger(e.exit)) return '"expect.exit" must be an integer';
  if (e.decision === undefined && e.includes === undefined && e.exit === undefined && c.files === undefined) return 'expects nothing: name a decision, a text, an exit code or a file';
  if (c.files !== undefined) {
    if (!Array.isArray(c.files) || c.files.length !== 1) return '"files" must list one file';
    const f = c.files[0];
    if (!f || typeof f.path !== 'string' || f.path === '' || isAbsolute(f.path) || f.path.split(/[/\\]/).includes('..')) return 'a file path must be relative to the sandbox HOME, without ..';
    if (f.includes !== undefined && typeof f.includes !== 'string') return '"files[].includes" must be a string';
  }
  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== 'object' || Array.isArray(c.env)) return '"env" must be an object';
    for (const [k, v] of Object.entries(c.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string') return `"env.${k.slice(0, 40)}" must be a string with a plain name`;
      if (SANDBOX_KEYS.has(k)) return `"env.${k}" is the sandbox's own`;
    }
  }
  if (c.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 60_000)) return '"timeoutMs" must be 100–60000';
  return null;
}

// ---- the runner ----

export interface StepResult {
  what: string;
  event: string;
  expected: Decision;
  decision: Decision;
  ok: boolean;
  why?: string;
  ms: number;
}

export interface CaseResult {
  name: string;
  source: 'goodboy' | 'user';
  ok: boolean;
  steps: StepResult[];
}

/** A new sandbox, removed again if it cannot be set up. Without git the project is a plain
 *  dir (goodboy's hooks fail open there; their cases then fail and say why). */
function makeSandbox(run: string, i: number): Sandbox {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-smoke-')));
  try {
    const project = join(home, 'project');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, SRC), 'export const a = 1;\n');
    try {
      // Without the user's git config: an init.templateDir would copy their hooks in.
      Bun.spawnSync(['git', 'init', '-q'], { cwd: project, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    } catch {
      // no git
    }
    const transcript = join(home, 'transcript.jsonl');
    writeFileSync(transcript, '');
    const session = `checkup-smoke-${run.replace(/[^\w-]/g, '').slice(0, 40)}-${i}-${Math.random().toString(36).slice(2, 8)}`;
    return { home, project, session, state: join(home, `goodboy-session-${session}`), transcript };
  } catch (e) {
    rmSync(home, { recursive: true, force: true });
    throw e;
  }
}

/** A clean environment: PATH (with this Bun first, unless the case sets its own), the case's
 *  variables and the sandbox's dirs; nothing else of the user's environment. */
function sandboxEnv(b: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: [dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter),
    ...extra,
    HOME: b.home,
    TMPDIR: b.home,
    CLAUDE_CONFIG_DIR: join(b.home, '.claude'),
    CLAUDE_PROJECT_DIR: b.project,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    // A missing Bun must never start an install from a smoke case.
    GOODBOY_AUTO_INSTALL: 'off',
  };
}

async function runStep(step: SmokeStep, b: Sandbox, root: string): Promise<StepResult> {
  const what = step.hook ?? 'command';
  const started = Date.now();
  const res = (ok: boolean, decision: Decision, why?: string): StepResult => ({ what, event: step.event, expected: step.expect.decision, decision, ok, ...(why ? { why: maskSecrets(why.slice(0, 300)) } : {}), ms: Date.now() - started });
  try {
    step.before?.(b);
  } catch (e) {
    return res(false, 'error', `setup failed: ${(e as Error).message}`);
  }
  const payload = { session_id: b.session, transcript_path: b.transcript, cwd: b.project, hook_event_name: step.event, ...step.input(b) };
  const argv = step.hook ? ['sh', join(root, 'bin', 'goodboy-run.sh'), step.hook] : ['sh', '-c', step.command!];
  const env = sandboxEnv(b, { ...(step.env ?? {}), ...(step.hook ? { CLAUDE_PLUGIN_ROOT: root } : {}) });
  const out = await runBounded(argv, { cwd: b.project, env, timeoutMs: step.timeoutMs ?? 30_000, stdin: JSON.stringify(payload) });
  if (out.error) return res(false, 'error', out.error);
  if (out.timedOut) return res(false, 'error', 'timed out');
  const { decision, text } = decisionOf(step.event, out.code, out.stdout, out.stderr);
  if (step.expect.exit !== undefined && out.code !== step.expect.exit) return res(false, decision, `exit ${out.code}, expected ${step.expect.exit}`);
  if (decision !== step.expect.decision) return res(false, decision, `${decision}, expected ${step.expect.decision}: ${text.slice(0, 200)}`);
  if (step.expect.includes && !text.includes(step.expect.includes)) return res(false, decision, `the hook's text lacks "${step.expect.includes}": ${text.slice(0, 200)}`);
  if (step.consequence) {
    const c = step.consequence(b);
    const p = resolve(c.base === 'home' ? b.home : b.state, c.file);
    if (!isUnder(p, b.home)) return res(false, decision, `${c.file} is outside the sandbox`);
    const f = readRegular(p, 4 * 1024 * 1024, true);
    if (typeof f !== 'object') return res(false, decision, `no consequence: ${c.file} is ${f}`);
    if (!f.text.includes(c.includes)) return res(false, decision, `no consequence: ${c.file} lacks "${c.includes}"`);
  }
  return res(true, decision);
}

/** Runs the cases, each in its own sandbox, and stops a case at its first failed step (the
 *  later steps build on its state). `root` is goodboy's root (the CLI's own). */
export async function runSmoke(cases: SmokeCase[], run: string, root: string): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const [i, c] of cases.entries()) {
    let b: Sandbox;
    try {
      b = makeSandbox(run, i);
    } catch (e) {
      // One case that cannot get a sandbox fails alone.
      out.push({ name: c.name, source: c.source, ok: false, steps: [{ what: 'sandbox', event: c.steps[0]?.event ?? '', expected: c.steps[0]?.expect.decision ?? 'allow', decision: 'error', ok: false, why: `sandbox setup failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`, ms: 0 }] });
      continue;
    }
    const steps: StepResult[] = [];
    try {
      for (const s of c.steps) {
        const r = await runStep(s, b, root);
        steps.push(r);
        if (!r.ok) break;
      }
    } finally {
      rmSync(b.home, { recursive: true, force: true });
    }
    out.push({ name: c.name, source: c.source, ok: steps.length === c.steps.length && steps.every((s) => s.ok), steps });
  }
  return out;
}

/** The lines the CLI prints; the whole result goes to the run dir. */
export function smokeSummary(results: CaseResult[], problems: string[]): Record<string, unknown> {
  return {
    cases: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results
      .filter((r) => !r.ok)
      .slice(0, 30)
      .map((r) => ({ name: r.name, source: r.source, step: r.steps.length, ...(r.steps.at(-1)?.why ? { why: r.steps.at(-1)!.why } : {}) })),
    case_problems: problems.slice(0, 30),
  };
}
