// Stabilization plan A3, round-2 findings. Each test failed on the batch-2 tree
// (commit fc358a9). The layer-1 run wrote F1–F8; the security review added the moved-file,
// unwritable-state and cwd-approval cases.
//
//   F1  skills printed the pre-A3 risk marker name
//   F2  an unwritable $TMPDIR turned the risk gate off (the documented fallback could not help)
//   F3  readSessionState falls back on an unusable session copy, not only a missing one
//   F4  the per-project pass record was one slot: an unrelated pass re-blocked a lifted failure
//   F5  a pass whose run started before the breaking edit lifted the failure
//   F6  the Bash write deny's `touch .claude/…` failed in a repo without .claude/
//   F7  findings about files outside the session's edits vanished silently (the v0.26.6 blind spot)
//   F8  the per-project pass record sat at a predictable $TMPDIR path that was trusted as is
//   H1  a high finding on a file the session moved or deleted was dropped
//   L4  a risk approval given under another cwd survived the next category command

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const PRE = join(ROOT, 'hooks', 'pre-tool-use.ts');
const UPS = join(ROOT, 'hooks', 'user-prompt-submit.ts');
const BLOCKED = '자동 검증이 실패한 상태입니다';
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      chmodSync(d, 0o700);
    } catch {
      // best-effort
    }
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  return { tmp: newDir('goodboy-r2-tmp-'), cwd: newDir('goodboy-r2-cwd-') };
}

function env(repo: Repo, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    TMPDIR: repo.tmp,
    HOME: repo.tmp,
    CLAUDE_PLUGIN_ROOT: ROOT,
    GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
    GOODBOY_CONCISE_DEFAULT: 'off',
    GOODBOY_ASK_UNCLEAR: 'off',
    GOODBOY_DISABLE_DELEGATION: '1',
    GOODBOY_TEST_GATE: 'off',
    ...extra,
  };
}

function spawn(repo: Repo, script: string, payload: Record<string, unknown>, extra: Record<string, string> = {}, cwd = repo.cwd) {
  return Bun.spawn(['bun', script], {
    cwd,
    env: env(repo, extra),
    stdin: new TextEncoder().encode(JSON.stringify({ cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function finish(p: ReturnType<typeof spawn>): Promise<Record<string, unknown>> {
  const out = await new Response(p.stdout).text();
  await p.exited;
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function hook(
  repo: Repo,
  script: string,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
  cwd = repo.cwd,
) {
  return finish(spawn(repo, script, payload, extra, cwd));
}

function editPayload(repo: Repo, sessionId: string, rel: string): Record<string, unknown> {
  const abs = resolve(repo.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  return { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } };
}

async function edit(repo: Repo, sessionId: string, rel: string, extra: Record<string, string> = {}): Promise<void> {
  await hook(repo, POST, editPayload(repo, sessionId, rel), extra);
}

async function stop(repo: Repo, sessionId: string): Promise<{ decision?: string; reason?: string; systemMessage?: string }> {
  return (await hook(repo, STOP, { session_id: sessionId, hook_event_name: 'Stop' })) as {
    decision?: string;
    reason?: string;
    systemMessage?: string;
  };
}

async function riskDecision(repo: Repo, sessionId: string, command: string, cwd = repo.cwd): Promise<string | undefined> {
  const out = (await hook(
    repo,
    PRE,
    { session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },
    {},
    cwd,
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  return out.hookSpecificOutput?.permissionDecision;
}

function scripts(repo: Repo, s: Record<string, string>): void {
  writeFileSync(join(repo.cwd, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0', scripts: s }), 'utf8');
}

function writeReview(repo: Repo, name: string, files: string[], findings: Array<Record<string, unknown>>, ageMs: number): void {
  const dir = join(repo.cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000 - ageMs).toISOString(),
      reviewed_files: files.map((f) => resolve(repo.cwd, f)),
      category: 'fix-bug',
      findings,
      unknown_assumptions_checked: [],
      verdict: findings.length > 0 ? 'needs-changes' : 'pass',
      dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
    }),
    'utf8',
  );
}

const text = (o: { reason?: string; systemMessage?: string }): string => `${o.reason ?? ''}${o.systemMessage ?? ''}`;

describe('F1 — skills name the approval marker the gate checks', () => {
  test('no skill tells the user to create the pre-A3 risk marker name', () => {
    const hits: string[] = [];
    for (const dir of readdirSync(join(ROOT, 'skills'))) {
      const p = join(ROOT, 'skills', dir, 'SKILL.md');
      if (existsSync(p) && readFileSync(p, 'utf8').includes('.goodboy-risk-approved.txt')) hits.push(`skills/${dir}/SKILL.md`);
    }
    expect(hits).toEqual([]);
  });
});

describe('F2 — the risk gate with an unwritable $TMPDIR', () => {
  test('a /migrate task is still gated when $TMPDIR is not writable', async () => {
    const repo = newRepo();
    chmodSync(repo.tmp, 0o500);
    await hook(repo, UPS, { session_id: 'sess-ro', hook_event_name: 'UserPromptSubmit', prompt: '/migrate rename the users.email column' });
    expect(await riskDecision(repo, 'sess-ro', 'npm run migrate')).toBe('deny');
  }, 30_000);

  test('the state is lost only when neither copy can be written', async () => {
    const tmp = newDir('goodboy-r2-unit-tmp-');
    const cwd = newDir('goodboy-r2-unit-cwd-');
    const readOnly = newDir('goodboy-r2-unit-ro-');
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const { readSessionState, writeSessionState } = await import('../lib/session-state');
      chmodSync(tmp, 0o500);
      writeSessionState(cwd, 'sess-u', { category: 'migrate', risk: 'risky' }); // repo copy only
      expect(readSessionState(cwd, 'sess-u')?.risk).toBe('risky');
      chmodSync(readOnly, 0o500); // no .claude/ can be created here
      expect(() => writeSessionState(readOnly, 'sess-v', { category: 'migrate', risk: 'risky' })).toThrow();
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
    }
  });
});

describe('F3 — readSessionState falls back when the session copy is unusable', () => {
  // Falling back keeps the risk gate on; returning null would turn it off.
  test("a corrupt session copy falls back to the repo-level copy of this session", async () => {
    const tmp = newDir('goodboy-r2-f3-tmp-');
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const { readSessionState } = await import('../lib/session-state');
      const cwd = newDir('goodboy-r2-f3-cwd-');
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      const dir = join(tmp, 'goodboy-session-sess-f3');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.goodboy-session-state.json'), '{ not json', 'utf8');
      const repoCopy = join(cwd, '.claude', '.goodboy-session-state.json');
      writeFileSync(repoCopy, JSON.stringify({ category: 'migrate', risk: 'risky', sessionId: 'sess-f3' }), 'utf8');
      expect(readSessionState(cwd, 'sess-f3')?.risk).toBe('risky');
      writeFileSync(repoCopy, JSON.stringify({ category: 'migrate', risk: 'risky', sessionId: 'sess-other' }), 'utf8');
      expect(readSessionState(cwd, 'sess-f3')).toBeNull(); // another session's copy never applies
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
    }
  });
});

describe('F4 — a lifted failure stays lifted', () => {
  test("an unrelated later pass does not bring back a failure another session's pass made stale", async () => {
    const repo = newRepo();
    scripts(repo, { typecheck: 'exit 0', lint: 'exit 1' });
    await edit(repo, 'sess-a', 'a.ts', { GOODBOY_AUTOVALIDATE: 'all' }); // A: lint fails
    scripts(repo, { typecheck: 'exit 0', lint: 'exit 0' });
    await edit(repo, 'sess-b', 'b.ts', { GOODBOY_AUTOVALIDATE: 'all' }); // B: lint passes later
    expect((await stop(repo, 'sess-a')).reason ?? '').not.toContain(BLOCKED); // lifted

    await edit(repo, 'sess-c', 'c.ts', { GOODBOY_AUTOVALIDATE: 'typecheck' }); // C: typecheck only
    expect((await stop(repo, 'sess-a')).reason ?? '').not.toContain(BLOCKED); // still lifted
  }, 30_000);
});

describe('F5 — a pass that started before the breaking edit', () => {
  test('does not lift the failure that edit caused', async () => {
    const repo = newRepo();
    // Decides at start, like tsc reading the sources, then takes a while.
    writeFileSync(join(repo.cwd, 'check.sh'), 'touch STARTED; if [ -f BROKEN ]; then exit 1; fi; sleep 2; exit 0\n', 'utf8');
    scripts(repo, { typecheck: 'sh check.sh' });
    const b = spawn(repo, POST, editPayload(repo, 'sess-b', 'b.ts')); // B's check starts on a good tree
    while (!existsSync(join(repo.cwd, 'STARTED'))) await Bun.sleep(20);
    writeFileSync(join(repo.cwd, 'BROKEN'), '', 'utf8');
    await edit(repo, 'sess-a', 'a.ts'); // A's edit breaks the tree; A's check fails
    expect((await stop(repo, 'sess-a')).reason).toContain(BLOCKED);
    await finish(b); // B's check, which never saw A's edit, passes
    expect(existsSync(join(repo.cwd, 'BROKEN'))).toBe(true);
    expect((await stop(repo, 'sess-a')).reason).toContain(BLOCKED);
  }, 30_000);
});

describe('F6 — the Bash write deny message in a repo without .claude/', () => {
  test('the printed touch command creates the marker', async () => {
    const repo = newRepo();
    mkdirSync(join(repo.cwd, 'src'), { recursive: true });
    await stop(repo, 'sess-f6'); // an ordinary turn end first
    const out = (await hook(repo, PRE, {
      session_id: 'sess-f6',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi > src/a.ts' },
    })) as { hookSpecificOutput?: { permissionDecisionReason?: string } };
    // Track G: the message tells the user to run `! touch <marker>` (the model cannot).
    const marker = /`! touch ([^`]+)`/.exec(out.hookSpecificOutput?.permissionDecisionReason ?? '')?.[1] ?? '';
    expect(marker).not.toBe('');
    expect(Bun.spawnSync(['touch', marker], { cwd: repo.cwd }).exitCode).toBe(0);
  }, 30_000);
});

describe('F7 — findings outside the session files are not dropped silently', () => {
  test('one session: a newer review of another file with a high finding is shown, not blocking', async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    writeReview(repo, 'a.json', ['src/a.ts'], [], 30_000);
    writeReview(repo, 'other.json', ['src/other.ts'], [{ file: resolve(repo.cwd, 'src/other.ts'), issue: 'SQL built from input', severity: 'high' }], 0);
    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('SQL built from input');
  }, 30_000);

  test('a foreign finding shown at one acceptance is not repeated at the next', async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await Bun.sleep(20);
    writeReview(repo, 'a.json', ['src/a.ts'], [], 0); // covers a.ts, timestamped a minute ahead
    // Between the first edit and the first acceptance: shown once.
    writeReview(repo, 'other.json', ['src/other.ts'], [{ file: resolve(repo.cwd, 'src/other.ts'), issue: 'SQL built from input', severity: 'high' }], 60_000);
    expect((await stop(repo, 'sess-a')).systemMessage ?? '').toContain('SQL built from input');
    await edit(repo, 'sess-a', 'src/a.ts'); // the next task; a.json still covers it
    const next = await stop(repo, 'sess-a');
    expect(next.decision).toBeUndefined();
    expect(next.systemMessage ?? '').not.toContain('SQL built from input');
  }, 30_000);

  test("a high finding on this session's file, in a review that lists only another file, blocks", async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await edit(repo, 'sess-b', 'src/b.ts');
    writeReview(repo, 'a.json', ['src/a.ts'], [], 30_000);
    writeReview(repo, 'b.json', ['src/b.ts'], [{ file: resolve(repo.cwd, 'src/a.ts'), issue: 'b calls a without the lock', severity: 'high' }], 0);
    const a = await stop(repo, 'sess-a');
    expect(a.decision).toBe('block');
    expect(text(a)).toContain('b calls a without the lock');
  }, 30_000);
});

describe('H1 — a high finding on a file the session moved or deleted', () => {
  // mv/rm are not recorded edits, and the review-scope filter drops files that no longer
  // exist; the session's own high finding on such a file used to vanish with no block.
  async function flaggedThen(change: (abs: string) => void): Promise<{ decision?: string; reason?: string }> {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await edit(repo, 'sess-a', 'src/c.ts');
    writeReview(repo, 'a.json', ['src/a.ts'], [{ file: resolve(repo.cwd, 'src/a.ts'), issue: 'token logged in clear', severity: 'high' }], 0);
    writeReview(repo, 'c.json', ['src/c.ts'], [], 0);
    change(resolve(repo.cwd, 'src/a.ts'));
    return stop(repo, 'sess-a');
  }

  test('moved', async () => {
    const out = await flaggedThen((abs) => renameSync(abs, resolve(dirname(abs), 'moved.ts')));
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('token logged in clear');
  }, 30_000);

  test('deleted', async () => {
    const out = await flaggedThen((abs) => unlinkSync(abs));
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('token logged in clear');
  }, 30_000);
});

describe('F8 — the per-project pass record at a predictable path', () => {
  // $TMPDIR/goodboy-project-<sha256(root)[:16]>/validation-passed.json: anyone who knows the
  //   project path can compute it. Where $TMPDIR is a shared /tmp (Linux without TMPDIR),
  //   another local user can create the directory first.
  async function projectDir(repo: Repo): Promise<string> {
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update(resolve(repo.cwd)).digest('hex').slice(0, 16);
    const dir = join(repo.tmp, `goodboy-project-${key}`);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777); // created first, by someone else
    return dir;
  }

  test.skipIf(process.platform === 'win32')('a pass record planted in a pre-created directory does not lift a failure', async () => {
    const repo = newRepo();
    const dir = await projectDir(repo);
    scripts(repo, { typecheck: 'exit 1' });
    await edit(repo, 'sess-a', 'a.ts');
    // Both record shapes (batch 2's and the current one), so the plant would lift the failure
    //   wherever the directory is trusted as is.
    const soon = new Date(Date.now() + 1000).toISOString();
    writeFileSync(
      join(dir, 'validation-passed.json'),
      JSON.stringify({ timestamp: soon, commands: ['bun run typecheck'], passes: { 'bun run typecheck': soon } }),
      'utf8',
    );
    expect((await stop(repo, 'sess-a')).reason).toContain(BLOCKED);
  }, 30_000);

  test.skipIf(process.platform === 'win32')('a pass does not write through a symlink planted as the record', async () => {
    const repo = newRepo();
    const dir = await projectDir(repo);
    const victim = join(repo.tmp, 'victim.txt');
    writeFileSync(victim, 'precious\n', 'utf8');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(victim, join(dir, 'validation-passed.json'));
    scripts(repo, { typecheck: 'exit 0' });
    await edit(repo, 'sess-b', 'b.ts');
    expect(readFileSync(victim, 'utf8')).toBe('precious\n');
  }, 30_000);
});

describe('L4 — a risk approval given under another cwd', () => {
  test('the next category command withdraws it there too', async () => {
    const repo = newRepo();
    const pkg = join(repo.cwd, 'pkg');
    mkdirSync(pkg, { recursive: true });
    const sid = 'sess-l4';
    await hook(repo, UPS, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: '/migrate add a column' });
    expect(await riskDecision(repo, sid, 'npm run migrate', pkg)).toBe('deny'); // the gate looks under pkg/
    writeFileSync(join(pkg, approvalMarkerRelPath('risk', sid)), '', 'utf8'); // the user approves there
    expect(await riskDecision(repo, sid, 'npm run migrate', pkg)).toBeUndefined();

    // A new task, submitted from the repo root: the approval under pkg/ is withdrawn too.
    await hook(repo, UPS, { session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: '/migrate drop a column' });
    expect(existsSync(join(pkg, approvalMarkerRelPath('risk', sid)))).toBe(false);
    expect(await riskDecision(repo, sid, 'npm run migrate', pkg)).toBe('deny');
  }, 30_000);
});
