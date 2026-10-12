// End-to-end read-record chain (stabilization plan A2, A7).
// PostToolUse writes read records; PreToolUse gates on them. Other tests seed reads.jsonl
// directly, so a PostToolUse that stopped recording reads would break every real session
// (all edits of existing files denied) while the suite stayed green. These tests run both
// real hooks in sequence against one TMPDIR.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PRE = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const POST = resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts');
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

function newSandbox(): { tmp: string; cwd: string; sessionId: string; file: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-chain-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-chain-cwd-'));
  tmpDirs.push(cwd);
  const file = join(cwd, 'a.ts');
  writeFileSync(file, Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n'), 'utf8');
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}`, file };
}

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

async function runHook(
  hook: string,
  box: { tmp: string; cwd: string; sessionId: string },
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: box.sessionId,
    cwd: box.cwd,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: { success: true },
  });
  const proc = Bun.spawn(['bun', hook], {
    cwd: box.cwd,
    env: {
      ...process.env,
      TMPDIR: box.tmp,
      HOME: box.tmp,
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_AUTOVALIDATE: 'off',
    },
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as Out;
  } catch {
    return {};
  }
}

const denied = (o: Out): boolean => o.hookSpecificOutput?.permissionDecision === 'deny';
const edit = (file: string): Record<string, unknown> => ({ file_path: file, old_string: 'v0', new_string: 'w0' });

describe('read-record chain: PostToolUse record -> PreToolUse decision (A2)', () => {
  test('a Read recorded by PostToolUse satisfies read-before-edit', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.file });
    expect(denied(await runHook(PRE, box, 'Edit', edit(box.file)))).toBe(false);
  });

  test('control: without the Read, the Edit is denied', async () => {
    const box = newSandbox();
    expect(denied(await runHook(PRE, box, 'Edit', edit(box.file)))).toBe(true);
  });

  test('a Bash cat recorded by PostToolUse satisfies read-before-edit', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Bash', { command: `cat ${box.file}` });
    expect(denied(await runHook(PRE, box, 'Edit', edit(box.file)))).toBe(false);
  });
});

describe('re-Read gate counts only full reads (A7)', () => {
  test('control: full Read then full Read of an unchanged file is denied', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.file });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.file }))).toBe(true);
  });

  test('Read(limit) then full Read is allowed', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.file, limit: 20 });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.file }))).toBe(false);
  });

  test('head -n then full Read is allowed; cat then full Read is denied', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Bash', { command: `head -n 3 ${box.file}` });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.file }))).toBe(false);

    const box2 = newSandbox();
    await runHook(POST, box2, 'Bash', { command: `cat ${box2.file}` });
    expect(denied(await runHook(PRE, box2, 'Read', { file_path: box2.file }))).toBe(true);
  });

  test('Read with pages is a partial read (PDF ranges past the first one stay readable)', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.file });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.file, pages: '6-10' }))).toBe(false);
  });

  test('the deny message points to partial reads as the way out', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.file });
    const out = await runHook(PRE, box, 'Read', { file_path: box.file });
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('offset/limit');
  });
});
