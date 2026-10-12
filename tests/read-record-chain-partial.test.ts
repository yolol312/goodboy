// Partial reads through the real hooks (stabilization plan A7), PostToolUse -> PreToolUse.
// Complements read-record-chain.test.ts: PDF page ranges (the plan's "pages 6-10 after 1-5"
// case), the PostToolUse side of `pages`, read-before-edit still accepting partial reads,
// and the mtime comparison using the last *full* read.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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

interface Box {
  tmp: string;
  cwd: string;
  sessionId: string;
  file: string;
  pdf: string;
}

function newSandbox(): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-chainp-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-chainp-cwd-'));
  tmpDirs.push(cwd);
  const file = join(cwd, 'a.ts');
  writeFileSync(file, Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n'), 'utf8');
  const pdf = join(cwd, 'manual.pdf');
  writeFileSync(pdf, '%PDF-1.4 fixture', 'utf8');
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}`, file, pdf };
}

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

async function runHook(hook: string, box: Box, toolName: string, toolInput: Record<string, unknown>): Promise<Out> {
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

describe('re-Read gate and PDF page ranges (A7)', () => {
  test('Read pages 1-5, then pages 6-10 of the same PDF is allowed', async () => {
    const box = newSandbox();
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.pdf, pages: '1-5' }))).toBe(false);
    await runHook(POST, box, 'Read', { file_path: box.pdf, pages: '1-5' });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.pdf, pages: '6-10' }))).toBe(false);
  });

  test('a pages read is recorded as partial: a later full Read is allowed', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.pdf, pages: '1-5' });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.pdf }))).toBe(false);
  });

  test('control: a full Read of the PDF, then another full Read, is denied', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.pdf });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.pdf }))).toBe(true);
  });
});

describe('partial reads elsewhere (A7)', () => {
  test('read-before-edit still accepts a partial Read (limit)', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.file, limit: 20 });
    const out = await runHook(PRE, box, 'Edit', { file_path: box.file, old_string: 'v0', new_string: 'w0' });
    expect(denied(out)).toBe(false);
  });

  test('the changed-file check compares against the last full read, not a later partial one', async () => {
    const box = newSandbox();
    // Full read at mtime M1.
    await runHook(POST, box, 'Read', { file_path: box.file });
    // The file changes outside the agent's tools (M2), then the agent reads only part of it.
    const later = new Date(statSync(box.file).mtimeMs + 60_000);
    utimesSync(box.file, later, later);
    await runHook(POST, box, 'Read', { file_path: box.file, offset: 1, limit: 5 });
    // The full view the agent holds is stale (M1 != M2), so a full re-Read is legitimate.
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.file }))).toBe(false);
  });

  test('control: full read, no change, partial read, then full Read is still denied', async () => {
    const box = newSandbox();
    await runHook(POST, box, 'Read', { file_path: box.file });
    await runHook(POST, box, 'Read', { file_path: box.file, offset: 1, limit: 5 });
    expect(denied(await runHook(PRE, box, 'Read', { file_path: box.file }))).toBe(true);
  });
});
