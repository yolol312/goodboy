import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { claudeBin } from '../lib/checkup';
import { runBounded } from '../lib/bounded';
import { checkHealth, fitHealth, type Health, healthSummary, parseDoctor, parseStartupLog, parseValidate } from '../lib/health';
import { decisionOf, GOODBOY_CASES, readUserCases, runSmoke, SMOKE_FILE } from '../lib/smoke';

// Track K, step K1c (#10): health from Claude Code's own commands (a fake `claude` here, never
// the real one: tests/setup.ts points GOODBOY_CLAUDE_BIN at a missing path) and the zero-turn
// smoke cases, each in a sandbox HOME.

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'lib', 'cli.ts');
const RUN = '20261020T000000Z-1';
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-k1c-')));
  tmpDirs.push(d);
  return d;
}

function put(path: string, text: string, mode?: number): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

// ---- a fake claude ----

const FAKE = `#!/bin/sh
# Answers like claude from files in $FAKE_DIR, and records what it was asked.
echo "$*" >> "$FAKE_DIR/calls"
[ -n "$FAKE_SLEEP" ] && [ "$1" = "$FAKE_SLEEP" ] && sleep 5
case "$1" in
  plugin)
    case "$2" in
      list) cat "$FAKE_DIR/list.json" ;;
      validate) f="$FAKE_DIR/validate-$(basename "$4").json"; [ -f "$f" ] || f="$FAKE_DIR/validate-default.json"; if [ -f "$f" ]; then cat "$f"; else echo '{"success":true,"manifest":{"file":"m","errors":[],"warnings":[]},"contents":[]}'; fi ;;
    esac ;;
  -p)
    log=""; prev=""
    for a in "$@"; do [ "$prev" = "--debug-file" ] && log="$a"; prev="$a"; done
    echo "$log" > "$FAKE_DIR/seen-log"
    env | cut -d= -f1 > "$FAKE_DIR/env-names"
    cp "$FAKE_DIR/debug.log" "$log"
    cat "$FAKE_DIR/skill-doctor.json" ;;
  doctor) cat "$FAKE_DIR/doctor.txt" ;;
esac
`;

const LIST = [
  { id: 'good@m', version: '1.0.0', scope: 'user', enabled: true, installPath: '/plugins/good' },
  { id: 'broken@local', version: '1.0.0', scope: 'user', enabled: true, installPath: '/plugins/broken', errors: ['Marketplace local not found'] },
  { id: 'nohooks@m', version: '1.0.0', scope: 'user', enabled: true, installPath: '/plugins/nohooks' },
  { id: 'off@m', version: '2.0.0', scope: 'user', enabled: false, installPath: '/plugins/off' },
];

const DEBUG_LOG = [
  '2026-10-20T06:30:29.106Z [WARN] plugin "broken@local" not loaded (hooks module, commands, skills, servers: none of it): its marketplace "local" is not known here',
  '2026-10-20T06:30:29.124Z [DEBUG] Read hooks.json for plugin good (enabled=true): /plugins/good/hooks/hooks.json',
  '2026-10-20T06:30:29.163Z [DEBUG] Loading hooks from plugin: good',
  '2026-10-20T06:30:29.178Z [DEBUG] Registered 3 hooks from 2 plugins',
  '2026-10-20T06:30:29.194Z [ERROR] NON-FATAL: Lock acquisition failed (expected in multi-process scenarios)',
  '2026-10-20T06:30:29.949Z [ERROR] MCP server "jira" Server stderr: token=abcdef123456 leaked',
  '2026-10-20T06:30:29.950Z [WARN] settings: api_key: sk-live_abcdefghijklmnopqrstuv in an env value',
].join('\n');

const DOCTOR = `Claude Code doctor

Running: native (2.1.304)

1 warning found
- Leftover npm global installation at /opt/homebrew/bin/claude
  Fix: Run: npm -g uninstall @anthropic-ai/claude-code

For a full setup checkup that can also fix issues, run /doctor in a Claude Code session.
`;

function fakeClaude(over: { skillDoctor?: Record<string, unknown>; list?: string } = {}) {
  const d = tmp();
  const bin = put(join(d, 'bin', 'claude'), FAKE, 0o755);
  put(join(d, 'list.json'), over.list ?? JSON.stringify(LIST));
  put(
    join(d, 'validate-broken.json'),
    JSON.stringify({
      success: false,
      manifest: { file: '/plugins/broken/.claude-plugin/plugin.json', errors: [], warnings: [{ message: 'missing description' }] },
      contents: [{ file: '/plugins/broken/hooks/hooks.json', errors: [{ message: 'PreToolUse is declared at the top level' }], warnings: [] }],
    }),
  );
  put(join(d, 'validate-nohooks.json'), JSON.stringify({ success: false, manifest: { file: '/plugins/nohooks', errors: [{ message: 'No manifest found in directory. Expected .claude-plugin/plugin.json' }], warnings: [] }, contents: [] }));
  put(join(d, 'debug.log'), DEBUG_LOG);
  put(join(d, 'skill-doctor.json'), JSON.stringify({ is_error: false, num_turns: 0, total_cost_usd: 0, result: 'Skills loaded this session\n  done  userSettings  3×', ...(over.skillDoctor ?? {}) }));
  put(join(d, 'doctor.txt'), DOCTOR);
  return { dir: d, env: { ...process.env, GOODBOY_CLAUDE_BIN: bin, FAKE_DIR: d } as NodeJS.ProcessEnv };
}

describe('health parsers', () => {
  test('validate: errors and warnings from the manifest and each file; not JSON is null', () => {
    const v = parseValidate(readFileSync(join(fakeClaude().dir, 'validate-broken.json'), 'utf8'))!;
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(['/plugins/broken/hooks/hooks.json: PreToolUse is declared at the top level']);
    expect(v.warnings).toEqual(['/plugins/broken/.claude-plugin/plugin.json: missing description']);
    expect(parseValidate('Validating…')).toBeNull();
    expect(parseValidate('[1]')).toBeNull();
    expect(parseValidate('{"success":true,"contents":[]}')).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test('startup log: plugins not loaded, hooks read and loaded, MCP stderr only counted, secrets masked', () => {
    const l = parseStartupLog(DEBUG_LOG);
    expect(l.notLoaded.map((n) => n.id)).toEqual(['broken@local']);
    expect(l.hooksRead).toEqual(['good']);
    expect(l.hooksFrom).toEqual(['good']);
    expect(l.registered).toBe('Registered 3 hooks from 2 plugins');
    expect(l.mcpStderr).toEqual({ jira: 1 });
    // NON-FATAL is noise; the other warning is kept with its secret masked.
    expect(l.other).toEqual(['[WARN] settings: [secret] in an env value']);
    expect(JSON.stringify(l)).not.toContain('abcdef123456');
  });

  test('doctor: each warning with its fix; the list ends at a blank line', () => {
    expect(parseDoctor(DOCTOR)).toEqual([{ text: 'Leftover npm global installation at /opt/homebrew/bin/claude', fix: 'Run: npm -g uninstall @anthropic-ai/claude-code' }]);
    expect(parseDoctor('All good\n- not a warning\n')).toEqual([]);
  });

  test('the claude binary is the one on PATH unless an absolute override is set', () => {
    expect(claudeBin({})).toBe('claude');
    expect(claudeBin({ GOODBOY_CLAUDE_BIN: '/x/claude' })).toBe('/x/claude');
    expect(() => claudeBin({ GOODBOY_CLAUDE_BIN: 'bin/claude' })).toThrow('absolute');
  });

  test('a bounded run stops at the timeout even when a child keeps the pipes open', async () => {
    const started = Date.now();
    const r = await runBounded(['sh', '-c', 'sleep 5 & echo started; sleep 5'], { cwd: tmp(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe('started\n');
    expect(Date.now() - started).toBeLessThan(4500);
  }, 10_000);

  test('a run that exits while a child keeps the pipes open is done after the grace, not timed out', async () => {
    const started = Date.now();
    const r = await runBounded(['sh', '-c', 'sleep 5 & echo hi'], { cwd: tmp(), timeoutMs: 8000 });
    expect(r).toMatchObject({ code: 0, timedOut: false, stdout: 'hi\n' });
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  test('the timeout sends SIGTERM first, so a command can end cleanly', async () => {
    const started = Date.now();
    const r = await runBounded(['sh', '-c', 'trap "echo term; exit 0" TERM; sleep 10 & wait'], { cwd: tmp(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe('term\n');
    expect(r.ms).toBeLessThan(1500);
  }, 15_000);

  test('the regression runner keeps the tail of the output', async () => {
    const { runCommands } = await import('../lib/regression');
    const [run] = await runCommands(tmp(), ['seq 1 5000'], 10_000);
    expect(run!.exit_code).toBe(0);
    expect(run!.output_tail.endsWith('4999\n5000\n')).toBe(true);
    expect(run!.output_tail.startsWith('1\n')).toBe(false);
  });

  test('a command that ignores SIGTERM is killed two seconds later', async () => {
    const started = Date.now();
    const r = await runBounded(['sh', '-c', 'trap "" TERM; sleep 10'], { cwd: tmp(), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeGreaterThan(2000);
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);

  test('output is capped at its head or its tail; a command that cannot start is an error', async () => {
    const big = await runBounded(['sh', '-c', 'head -c 1100000 /dev/zero | tr "\\0" a'], { cwd: tmp(), timeoutMs: 10_000 });
    expect(big.stdout).toHaveLength(1024 * 1024);
    const small = { max: { stdout: 3, stderr: 3 } };
    expect((await runBounded(['sh', '-c', 'printf abcdefgh'], { cwd: tmp(), timeoutMs: 5000, ...small })).stdout).toBe('abc');
    expect((await runBounded(['sh', '-c', 'printf abcdefgh'], { cwd: tmp(), timeoutMs: 5000, ...small, keep: 'tail' })).stdout).toBe('fgh');
    const none = await runBounded([join(tmp(), 'missing')], { cwd: tmp(), timeoutMs: 1000 });
    expect(none.code).toBeNull();
    expect(none.error).toBeTruthy();
  });

  test('parser caps and edges: 20 validate messages, colored doctor output, a blank line ends its list', () => {
    const many = { success: false, manifest: { file: 'm', errors: Array.from({ length: 25 }, (_, i) => ({ message: `e${i}` })), warnings: [] } };
    expect(parseValidate(JSON.stringify(many))!.errors).toHaveLength(20);
    expect(parseDoctor('\x1b[33m1 warning found\x1b[39m\n- \x1b[1mx\x1b[22m\n')).toEqual([{ text: 'x' }]);
    expect(parseDoctor('2 warnings found\n- one\n\n- not in the list\n')).toEqual([{ text: 'one' }]);
  });

  test("the startup log: an MCP server's name is only a name; a secret across the cut is still masked", () => {
    const l = parseStartupLog([
      '2026-10-20T00:00:00Z [ERROR] MCP server "constructor" Server stderr: x',
      '2026-10-20T00:00:00Z [ERROR] MCP server "__proto__" Server stderr: x',
      `2026-10-20T00:00:00Z [WARN] ${'x'.repeat(283)} ghp_abcdefghijklmnopqrstuvwxyz0123`,
    ].join('\n'));
    expect(Object.entries(l.mcpStderr)).toEqual([['constructor', 1], ['__proto__', 1]]);
    expect(l.other[0]).not.toContain('ghp_');
  });

  test('masking stays fast on long dotted text', async () => {
    const { maskSecrets } = await import('../lib/secret-patterns');
    const started = Date.now();
    maskSecrets('a.'.repeat(32_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('checkHealth with a fake claude', () => {
  test('plugins are listed, validated when enabled, and matched against the startup log', async () => {
    const f = fakeClaude();
    const h = await checkHealth(tmp(), { env: f.env, cli: '2.1.304' });
    const by = Object.fromEntries(h.plugins.map((p) => [p.id, p]));
    expect(by['good@m']).toMatchObject({ loaded: true, hooksLoaded: true });
    // Not loaded at all; and a plugin whose hooks.json the log never read has no hooks verdict.
    expect(by['broken@local']).toMatchObject({ loaded: false, hooksLoaded: null });
    expect(by['nohooks@m']).toMatchObject({ loaded: true, hooksLoaded: null });
    // Defined by its marketplace: no manifest in its dir is not an error.
    expect(by['nohooks@m']!.validate).toEqual({ skipped: 'no manifest in the install dir (its marketplace defines it)' });
    expect(by['broken@local']!.validate).toEqual({ ok: false, errors: ['/plugins/broken/hooks/hooks.json: PreToolUse is declared at the top level'], warnings: ['/plugins/broken/.claude-plugin/plugin.json: missing description'] });
    expect(by['off@m']).toMatchObject({ validate: { skipped: 'disabled' }, loaded: null });
    expect(h.problems.map((p) => `${p.kind} ${p.subject}`).sort()).toEqual(['doctor-warning doctor', 'list-error broken@local', 'not-loaded broken@local', 'validate-error broken@local', 'validate-warning broken@local']);
    expect(h.skillDoctor).toMatchObject({ ok: true, turns: 0, costUsd: 0 });
    expect(h.doctor).toMatchObject({ ok: true, warnings: [{ fix: 'Run: npm -g uninstall @anthropic-ai/claude-code' }] });
    // The disabled plugin is never validated; the debug log is gone afterwards.
    const calls = readFileSync(join(f.dir, 'calls'), 'utf8');
    expect(calls).not.toContain('/plugins/off');
    expect(calls).toContain('-p /skill-doctor --output-format json --debug-file');
    expect(existsSync(dirname(readFileSync(join(f.dir, 'seen-log'), 'utf8').trim()))).toBe(false);
    expect(healthSummary(h)).toMatchObject({ plugins: 4, enabled: 3, not_loaded: ['broken@local'], hooks_not_loaded: [], validate_errors: 1, doctor_warnings: 1, failed_steps: [] });
  });

  test('a step that times out or prints no JSON is reported, and the others still run', async () => {
    const f = fakeClaude({ list: 'not json' });
    const h = await checkHealth(tmp(), { env: { ...f.env, FAKE_SLEEP: 'doctor' }, timeoutMs: 500 });
    expect(h.plugins).toEqual([]);
    expect(h.problems.filter((p) => p.kind === 'step-failed').map((p) => `${p.subject}: ${p.message}`)).toEqual(['plugin list: exit 0, no JSON: not json', 'doctor: timed out']);
    expect(h.skillDoctor.ok).toBe(true);
    expect(h.doctor.ok).toBe(false);
  }, 15_000);

  test('a missing claude fails every step, named, without a throw', async () => {
    const h = await checkHealth(tmp(), { env: { ...process.env, GOODBOY_CLAUDE_BIN: join(tmp(), 'no-claude') } });
    expect(h.problems.filter((p) => p.kind === 'step-failed').map((p) => p.subject)).toEqual(['plugin list', 'skill-doctor', 'startup log', 'doctor']);
  });

  test('a skill-doctor that makes model turns, or only costs, is a problem', async () => {
    const h = await checkHealth(tmp(), { env: fakeClaude({ skillDoctor: { num_turns: 2, total_cost_usd: 0.01 } }).env });
    expect(h.problems.find((p) => p.kind === 'skill-doctor-cost')?.message).toContain('2 model turns');
    const c = await checkHealth(tmp(), { env: fakeClaude({ skillDoctor: { num_turns: 0, total_cost_usd: 0.02 } }).env });
    expect(c.problems.find((p) => p.kind === 'skill-doctor-cost')?.message).toContain('($0.02)');
  });

  test("the nested claude runs without the parent session's variables", async () => {
    const f = fakeClaude();
    await checkHealth(tmp(), { env: { ...f.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_CHILD_SESSION: '1', ANTHROPIC_MODEL: 'kept', CLAUDE_CONFIG_DIR: tmp(), CLAUDE_CODE_USE_BEDROCK: '0' } });
    const names = readFileSync(join(f.dir, 'env-names'), 'utf8').split('\n');
    for (const n of ['ANTHROPIC_MODEL', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK']) expect(names).toContain(n);
    for (const n of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_CHILD_SESSION']) expect(names).not.toContain(n);
  });

  test('all steps share one deadline; the ones past it are skipped and named', async () => {
    const f = fakeClaude();
    const started = Date.now();
    const h = await checkHealth(tmp(), { env: { ...f.env, FAKE_SLEEP: 'plugin' }, timeoutMs: 60_000, totalMs: 1500 });
    expect(Date.now() - started).toBeLessThan(6000);
    const failed = h.problems.filter((p) => p.kind === 'step-failed');
    expect(failed[0]).toMatchObject({ subject: 'plugin list', message: 'timed out' });
    expect(failed.filter((p) => p.message === "skipped: the checkup's time ran out").map((p) => p.subject)).toEqual(['skill-doctor', 'doctor']);
  }, 15_000);

  test('"No manifest found" is skipped only when it is the only error', async () => {
    const f = fakeClaude();
    put(join(f.dir, 'validate-nohooks.json'), JSON.stringify({ success: false, manifest: { file: '/plugins/nohooks', errors: [{ message: 'No manifest found in directory.' }, { message: 'Invalid skill' }], warnings: [] } }));
    const h = await checkHealth(tmp(), { env: f.env });
    expect(h.plugins.find((p) => p.id === 'nohooks@m')!.validate).toMatchObject({ ok: false, errors: ['/plugins/nohooks: No manifest found in directory.', '/plugins/nohooks: Invalid skill'] });
  });

  test('a report past the run-file cap keeps its counts and cuts its details', () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => `${'m'.repeat(380)}${i}`);
    const h: Health = {
      cli: '2.1.304',
      plugins: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}@m`, version: null, scope: null, enabled: true, installPath: '/p', listErrors: [], validate: { ok: false, errors: big(20), warnings: big(20) }, loaded: true, hooksLoaded: null })),
      skillDoctor: { ok: true, turns: 0, costUsd: 0, text: 's'.repeat(20_000) },
      startupLog: { read: true, registered: null, notLoaded: [], hooksRead: [], hooksFrom: [], mcpStderr: {}, other: [] },
      doctor: { ok: true, warnings: [], text: '' },
      problems: big(2000).map((message) => ({ kind: 'validate-error' as const, subject: 'p', message })),
    };
    const fit = fitHealth(h, 1_000_000);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThan(1_000_000);
    expect(fit.problems).toHaveLength(101);
    expect(fit.problems.at(-1)).toEqual({ kind: 'step-failed', subject: 'health.json', message: 'details were cut to fit the run-file cap' });
    expect(fit.plugins[0]!.validate).toMatchObject({ errors: big(3), warnings: big(3) });
    expect(fit.skillDoctor.text).toHaveLength(2000);
    expect(fitHealth({ ...h, plugins: [], problems: [] }, 1_000_000).problems).toEqual([]);
  });
});

// ---- smoke ----

describe('decisions', () => {
  test('exit codes and JSON decide like Claude Code', () => {
    expect(decisionOf('PreToolUse', 2, '', 'no').decision).toBe('deny');
    expect(decisionOf('Stop', 2, '', 'no').decision).toBe('block');
    expect(decisionOf('Stop', 1, '', 'boom')).toEqual({ decision: 'error', text: 'boom' });
    expect(decisionOf('PreToolUse', 0, '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"r"}}', '')).toEqual({ decision: 'deny', text: 'r' });
    expect(decisionOf('PreToolUse', 0, '{"decision":"block","reason":"old"}', '').decision).toBe('deny');
    expect(decisionOf('Stop', 0, '{"decision":"block","reason":"why"}', '')).toEqual({ decision: 'block', text: 'why' });
    expect(decisionOf('Stop', 0, '{"continue":false,"stopReason":"halt"}', '')).toEqual({ decision: 'block', text: 'halt' });
    expect(decisionOf('UserPromptSubmit', 0, 'plain context', '')).toEqual({ decision: 'allow', text: 'plain context' });
    expect(decisionOf('UserPromptSubmit', 0, '{"hookSpecificOutput":{"additionalContext":"ctx"}}', '')).toEqual({ decision: 'allow', text: 'ctx' });
    expect(decisionOf('Stop', 0, '{bad', '').decision).toBe('error');
  });

  test('a permission request decides through decision.behavior; exit 2 blocks nothing on SessionStart', () => {
    const pr = (o: unknown) => decisionOf('PermissionRequest', 0, JSON.stringify(o), '');
    expect(pr({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } } })).toEqual({ decision: 'deny', text: 'no' });
    expect(pr({ hookSpecificOutput: { decision: { behavior: 'allow' } } }).decision).toBe('allow');
    expect(pr({}).decision).toBe('ask');
    expect(decisionOf('PermissionRequest', 2, '', 'x').decision).toBe('deny');
    expect(decisionOf('SessionStart', 2, '', 'x').decision).toBe('error');
    expect(decisionOf('Notification', 2, '', 'x').decision).toBe('error');
    expect(decisionOf('UserPromptSubmit', 2, '', 'x').decision).toBe('block');
    expect(decisionOf('PostToolUse', 2, '', 'x').decision).toBe('block');
    expect(decisionOf('SubagentStop', 2, '', 'x').decision).toBe('block');
  });
});

describe("goodboy's smoke cases", () => {
  test("pass against goodboy's own hooks, leaving no sandbox behind", async () => {
    // A TMPDIR of its own: other runs share the system one (the test record saw a race).
    const own = tmp();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = own;
    try {
      expect(tmpdir()).toBe(own);
      const results = await runSmoke(GOODBOY_CASES, RUN, REPO);
      expect(results.map((r) => ({ name: r.name, ok: r.ok, why: r.steps.find((s) => !s.ok)?.why }))).toEqual(GOODBOY_CASES.map((c) => ({ name: c.name, ok: true, why: undefined })));
      expect(results[1]!.steps.map((s) => s.decision)).toEqual(['allow', 'deny', 'allow', 'deny', 'allow', 'allow', 'allow', 'block']);
      expect(readdirSync(own)).toEqual([]);
    } finally {
      process.env.TMPDIR = saved;
    }
  }, 60_000);

  test('a hook that only exits 0 fails them all: each case checks a decision or a text', async () => {
    const root = tmp();
    put(join(root, 'bin', 'goodboy-run.sh'), 'cat > /dev/null\necho "{}"\n');
    const results = await runSmoke(GOODBOY_CASES, RUN, root);
    expect(results.map((r) => r.ok)).toEqual(GOODBOY_CASES.map(() => false));
    expect(results[1]!.steps.map((s) => s.ok)).toEqual([false]);
    expect(results[1]!.steps[0]!.why).toContain('lacks "self-assessment"');
  }, 30_000);

  test('a missing consequence fails a step whose decision is right', async () => {
    const root = tmp();
    // Denies like goodboy but writes no gate log.
    put(join(root, 'bin', 'goodboy-run.sh'), 'cat > /dev/null\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"x"}}\'\n');
    const [cat] = await runSmoke(GOODBOY_CASES.slice(2), RUN, root);
    expect(cat!.ok).toBe(false);
    expect(cat!.steps[0]).toMatchObject({ decision: 'deny', ok: false, why: 'no consequence: gate-log.jsonl is absent' });
  });
});

/** User cases as `smoke.json` would give them. */
function readUserCasesFrom(cases: unknown[]) {
  const dir = tmp();
  put(join(dir, SMOKE_FILE), JSON.stringify({ cases }), 0o600);
  const u = readUserCases(dir);
  expect(u.problems).toEqual([]);
  return u.cases;
}

describe("the user's smoke cases", () => {
  const good = {
    name: 'echo hook',
    event: 'PreToolUse',
    command: 'cat > "$HOME/input.json"; echo "{\\"hookSpecificOutput\\":{\\"permissionDecision\\":\\"deny\\",\\"permissionDecisionReason\\":\\"home=$HOME flag=$MY_FLAG\\"}}"',
    input: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    expect: { decision: 'deny', includes: 'flag=on' },
    files: [{ path: 'input.json', includes: '"rm -rf /"' }],
    env: { MY_FLAG: 'on' },
  };

  test('run in a sandbox HOME with the hook JSON on stdin; the decision, the text and the file are checked', async () => {
    const dir = tmp();
    put(join(dir, SMOKE_FILE), JSON.stringify({ cases: [good, { ...good, name: 'wrong', expect: { decision: 'allow' } }, { ...good, name: 'no file', files: [{ path: 'other.json' }] }] }), 0o600);
    const u = readUserCases(dir);
    expect(u.problems).toEqual([]);
    const [ok, wrong, nofile] = await runSmoke(u.cases, RUN, REPO);
    expect(ok!.ok).toBe(true);
    expect(wrong!.steps[0]).toMatchObject({ ok: false, decision: 'deny' });
    expect(wrong!.steps[0]!.why).toContain('deny, expected allow: home=');
    // The hook saw the sandbox HOME, not the real one.
    expect(wrong!.steps[0]!.why).not.toContain(`home=${process.env.HOME} `);
    expect(nofile!.steps[0]!.why).toBe('no consequence: other.json is absent');
  });

  test("bad cases are named and none of them runs; the sandbox's variables are not a case's to set", () => {
    const dir = tmp();
    const bad = [
      { ...good, name: 'home', env: { HOME: '/Users/me' } },
      { ...good, name: 'escape', files: [{ path: '../x' }] },
      { ...good, name: 'abs', files: [{ path: '/etc/passwd' }] },
      { ...good, name: 'event', event: 'Nope' },
      { name: 'nothing', event: 'Stop', command: 'true', expect: {} },
      { ...good, name: 'slow', timeoutMs: 600_000 },
    ];
    put(join(dir, SMOKE_FILE), JSON.stringify({ cases: bad }), 0o600);
    const u = readUserCases(dir);
    expect(u.cases).toEqual([]);
    expect(u.problems.map((p) => p.split(': ')[0])).toEqual(['case 1 (home)', 'case 2 (escape)', 'case 3 (abs)', 'case 4 (event)', 'case 5 (nothing)', 'case 6 (slow)']);
  });

  test('a case that cannot get a sandbox fails alone, without a throw', async () => {
    const cases = readUserCasesFrom([{ name: 'a', event: 'Stop', command: 'true', expect: { decision: 'allow' } }, { name: 'b', event: 'Stop', command: 'true', expect: { decision: 'allow' } }]);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = join(tmp(), 'missing');
    try {
      const results = await runSmoke(cases, RUN, REPO);
      expect(results.map((r) => [r.name, r.ok, r.steps[0]!.what])).toEqual([['a', false, 'sandbox'], ['b', false, 'sandbox']]);
      expect(results[0]!.steps[0]!.why).toStartWith('sandbox setup failed: ');
    } finally {
      process.env.TMPDIR = saved;
    }
  });

  test('an exit code, a file without its text, and a case PATH are checked or kept', async () => {
    const dir = tmp();
    const cases = [
      { name: 'exit', event: 'Stop', command: 'cat >/dev/null; exit 3', expect: { decision: 'error', exit: 0 } },
      { name: 'text', event: 'Stop', command: 'cat >/dev/null; echo other > "$HOME/out.txt"', expect: {}, files: [{ path: 'out.txt', includes: 'wanted' }] },
      { name: 'path', event: 'UserPromptSubmit', command: 'cat >/dev/null; echo "$PATH"', expect: { includes: '/my/tools' }, env: { PATH: `/my/tools:${process.env.PATH}` } },
    ];
    put(join(dir, SMOKE_FILE), JSON.stringify({ cases }), 0o600);
    const [exit, text, path] = await runSmoke(readUserCases(dir).cases, RUN, REPO);
    expect(exit!.steps[0]!.why).toBe('exit 3, expected 0');
    expect(text!.steps[0]!.why).toBe('no consequence: out.txt lacks "wanted"');
    expect(path!.ok).toBe(true);
  });

  test('a file others can write, or a link, is refused; no file is no cases', () => {
    const dir = tmp();
    put(join(dir, SMOKE_FILE), JSON.stringify({ cases: [good] }), 0o620);
    expect(readUserCases(dir).problems).toEqual(['smoke.json is writable by others']);
    chmodSync(join(dir, SMOKE_FILE), 0o602);
    expect(readUserCases(dir).problems).toEqual(['smoke.json is writable by others']);
    rmSync(join(dir, SMOKE_FILE));
    symlinkSync(put(join(tmp(), 'real.json'), JSON.stringify({ cases: [good] }), 0o600), join(dir, SMOKE_FILE));
    expect(readUserCases(dir)).toEqual({ cases: [], problems: ['smoke.json is not a regular file up to 262144 bytes'] });
    expect(readUserCases(tmp())).toEqual({ cases: [], problems: [] });
  });
});

describe('the CLI', () => {
  async function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    const proc = Bun.spawn(['bun', CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  }

  test('health and smoke write their reports to the run dir and print summaries', async () => {
    const f = fakeClaude();
    const checkups = join(tmp(), 'checkups');
    const env = { ...f.env, GOODBOY_CHECKUP_DIR: checkups };
    const cwd = tmp();
    const b = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], env, cwd)).out) as { run: string };
    const h = await cli(['checkup-health', '--run', b.run], env, cwd);
    expect(h.code).toBe(0);
    const hs = JSON.parse(h.out) as { not_loaded: string[]; written: string; problems: unknown[] };
    expect(hs.not_loaded).toEqual(['broken@local']);
    expect(hs.written).toBe(join(checkups, 'runs', b.run, 'health.json'));
    expect(JSON.parse(readFileSync(hs.written, 'utf8')).cli).toBe('2.1.304');

    put(join(checkups, SMOKE_FILE), JSON.stringify({ cases: [{ name: 'user ok', event: 'Stop', command: 'cat >/dev/null; echo "{}"', expect: { decision: 'allow' } }, { name: 'bad', event: 'Stop' }] }), 0o600);
    const s = await cli(['checkup-smoke', '--run', b.run], env, cwd);
    expect(s.code).toBe(0);
    const ss = JSON.parse(s.out) as { cases: number; passed: number; failed: unknown[]; case_problems: string[]; written: string };
    expect(ss).toMatchObject({ cases: GOODBOY_CASES.length + 1, passed: GOODBOY_CASES.length + 1, failed: [] });
    expect(ss.case_problems).toEqual(['case 2 (bad): needs a "command" up to 2000 characters']);
    expect(ss.written).toBe(join(checkups, 'runs', b.run, 'smoke-results.json'));
    expect(JSON.parse(readFileSync(ss.written, 'utf8')).results).toHaveLength(GOODBOY_CASES.length + 1);
  }, 60_000);

  test('a run that is not the pending one fails before claude or a hook runs', async () => {
    const f = fakeClaude();
    const checkups = join(tmp(), 'checkups');
    const env = { ...f.env, GOODBOY_CHECKUP_DIR: checkups };
    const cwd = tmp();
    await cli(['checkup-begin', '--cli', '2.1.304'], env, cwd);
    // A user case that would leave a mark if anything ran.
    const mark = join(tmp(), 'ran');
    put(join(checkups, SMOKE_FILE), JSON.stringify({ cases: [{ name: 'mark', event: 'Stop', command: `cat >/dev/null; touch ${mark}`, expect: { decision: 'allow' } }] }), 0o600);
    for (const cmd of ['checkup-health', 'checkup-smoke']) {
      const r = await cli([cmd, '--run', '20200101T000000Z-1'], env, cwd);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain('is not the pending run');
    }
    expect(existsSync(join(f.dir, 'calls'))).toBe(false);
    expect(existsSync(mark)).toBe(false);
  }, 30_000);

  test("the sandbox's git init ignores the user's git config (no template hooks copied in)", async () => {
    // Through the CLI: a spawn without its own env takes the process's startup env, so the
    //   variable must be there from the start.
    const tpl = tmp();
    put(join(tpl, 'hooks', 'marker'), 'x');
    const cfg = put(join(tmp(), 'gitconfig'), `[init]\n\ttemplateDir = ${tpl}\n`);
    const checkups = join(tmp(), 'checkups');
    put(join(checkups, SMOKE_FILE), JSON.stringify({ cases: [{ name: 'git', event: 'UserPromptSubmit', command: 'cat >/dev/null; if [ -f "$CLAUDE_PROJECT_DIR/.git/hooks/marker" ]; then echo copied; else echo clean; fi', expect: { includes: 'clean' } }] }), 0o600);
    const r = await cli(['checkup-smoke'], { GOODBOY_CHECKUP_DIR: checkups, GIT_CONFIG_GLOBAL: cfg }, tmp());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ cases: GOODBOY_CASES.length + 1, failed: [] });
  }, 60_000);

  test('a health report past the run-file cap is written cut, not refused', async () => {
    const f = fakeClaude();
    // 50 plugins whose validate messages are control characters: six bytes each in JSON.
    const msgs = Array.from({ length: 20 }, () => ({ message: '\u0001'.repeat(400) }));
    put(join(f.dir, 'list.json'), JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ id: `p${i}@m`, enabled: true, installPath: `/plugins/p${i}` }))));
    put(join(f.dir, 'validate-default.json'), JSON.stringify({ success: false, manifest: { file: 'm', errors: msgs, warnings: msgs } }));
    const checkups = join(tmp(), 'checkups');
    const env = { ...f.env, GOODBOY_CHECKUP_DIR: checkups };
    const cwd = tmp();
    const b = JSON.parse((await cli(['checkup-begin', '--cli', '2.1.304'], env, cwd)).out) as { run: string };
    const r = await cli(['checkup-health', '--run', b.run], env, cwd);
    expect(r.code).toBe(0);
    const written = JSON.parse(r.out).written as string;
    expect(Buffer.byteLength(readFileSync(written))).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((JSON.parse(readFileSync(written, 'utf8')) as Health).problems.at(-1)!.subject).toBe('health.json');
  }, 60_000);
});
