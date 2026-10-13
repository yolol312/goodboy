// Auto-validation failures are per session, passes per project (stabilization plan A3),
// end to end with the real PostToolUse and Stop hooks.
//
// The checks run on the working tree every session of a project shares, so a pass of the
// same commands in any session, in a run that started after the failure, makes the failure
// stale. "Project" is the root PostToolUse validates in: the nearest directory with a
// package.json above the cwd. A pass elsewhere, or one that started before the failure,
// says nothing about the failure.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const BLOCKED = '자동 검증이 실패한 상태입니다';
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
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

/** A project whose typecheck script is `script`. */
function newProject(script: string): string {
  const cwd = newDir('goodboy-vps-cwd-');
  setTypecheck(cwd, script);
  return cwd;
}

function setTypecheck(project: string, script: string): void {
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: script } }),
    'utf8',
  );
}

async function run(
  tmp: string,
  script: string,
  cwd: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn(['bun', script], {
    cwd,
    env: {
      ...process.env,
      TMPDIR: tmp,
      HOME: tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_TEST_GATE: 'off',
      GOODBOY_AUTOVALIDATE: 'typecheck',
      ...extraEnv,
    },
    stdin: new TextEncoder().encode(JSON.stringify({ cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

/** An Edit in `cwd` as PostToolUse sees it: records it and runs the auto-validation. */
async function edit(
  tmp: string,
  sessionId: string,
  cwd: string,
  rel: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const abs = resolve(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(
    tmp,
    POST,
    cwd,
    { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } },
    extraEnv,
  );
}

async function stopReason(tmp: string, sessionId: string, cwd: string): Promise<string> {
  const out = await run(tmp, STOP, cwd, { session_id: sessionId, hook_event_name: 'Stop' });
  try {
    return (JSON.parse(out) as { reason?: string }).reason ?? '';
  } catch {
    return '';
  }
}

describe('a pass lifts an older failure only in the same project (A3)', () => {
  test('a pass from a session working in a subdirectory of the project lifts it', async () => {
    const tmp = newDir('goodboy-vps-tmp-');
    const project = newProject('exit 1');
    await edit(tmp, 'sess-a', project, 'a.ts'); // A's typecheck fails at the root
    expect(await stopReason(tmp, 'sess-a', project)).toContain(`${BLOCKED}: bun run typecheck`);

    setTypecheck(project, 'exit 0');
    const sub = join(project, 'src');
    mkdirSync(sub, { recursive: true });
    await edit(tmp, 'sess-b', sub, 'b.ts'); // B validates from src/: the same project root

    expect(await stopReason(tmp, 'sess-a', project)).not.toContain(BLOCKED);
    const status = JSON.parse(readFileSync(join(tmp, 'goodboy-session-sess-a', 'status.json'), 'utf8')) as {
      validationFailed?: boolean;
    };
    expect(status.validationFailed).toBe(false);
  }, 30_000);

  test('a pass of the same command in another project does not', async () => {
    const tmp = newDir('goodboy-vps-tmp-');
    const project = newProject('exit 1');
    await edit(tmp, 'sess-a', project, 'a.ts');
    const other = newProject('exit 0');
    await edit(tmp, 'sess-b', other, 'b.ts'); // same TMPDIR, same command, other project

    expect(await stopReason(tmp, 'sess-a', project)).toContain(`${BLOCKED}: bun run typecheck`);
  }, 30_000);

  test('a pass recorded before the failure does not', async () => {
    const tmp = newDir('goodboy-vps-tmp-');
    const project = newProject('exit 0');
    await edit(tmp, 'sess-b', project, 'b.ts'); // B passes first
    setTypecheck(project, 'exit 1');
    await edit(tmp, 'sess-a', project, 'a.ts'); // then A breaks the tree

    expect(await stopReason(tmp, 'sess-a', project)).toContain(`${BLOCKED}: bun run typecheck`);
  }, 30_000);

  // A check that could not run (exit 127: tool not found) is no pass of that check, even in
  //   a run whose other checks passed — that run lifts nothing it did not run.
  test("another session's run that could not run the failed check does not lift it", async () => {
    const tmp = newDir('goodboy-vps-tmp-');
    const project = newDir('goodboy-vps-cwd-');
    const setScripts = (lint: string): void =>
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: 'exit 0', lint } }),
        'utf8',
      );
    setScripts('exit 1');
    await edit(tmp, 'sess-a', project, 'a.ts', { GOODBOY_AUTOVALIDATE: 'all' }); // A: lint fails
    setScripts('exit 127');
    await edit(tmp, 'sess-b', project, 'b.ts', { GOODBOY_AUTOVALIDATE: 'all' }); // B: typecheck ok, lint unavailable

    expect(await stopReason(tmp, 'sess-a', project)).toContain(`${BLOCKED}: bun run lint`);
  }, 30_000);
});
