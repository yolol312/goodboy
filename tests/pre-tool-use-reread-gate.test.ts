import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
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

function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'vcf-reread-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-reread-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** Create a real file in cwd and return its absolute path + mtimeMs. */
function makeFile(cwd: string, name: string, content = 'hello'): { path: string; mtime: number } {
  const path = join(cwd, name);
  writeFileSync(path, content, 'utf8');
  return { path, mtime: statSync(path).mtimeMs };
}

/** Seed a read record (optionally with mtime) at a given turn. */
function seedRead(tmp: string, sessionId: string, file: string, turn: number, mtime?: number): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `vcf-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(turn), 'utf8');
  const rec: Record<string, unknown> = { file: resolve(file), turn, timestamp: new Date().toISOString() };
  if (mtime !== undefined) rec.mtime = mtime;
  writeFileSync(join(dir, 'reads.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

function seedEdit(tmp: string, sessionId: string, file: string, turn: number): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `vcf-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'edits.jsonl'),
    JSON.stringify({ file: resolve(file), turn, timestamp: new Date().toISOString() }) + '\n',
    'utf8',
  );
}

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  systemMessage?: string;
}

async function runRead(
  tmp: string,
  cwd: string,
  sessionId: string,
  toolInput: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    tool_name: 'Read',
    tool_input: toolInput,
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, VCF_DISABLE_DELEGATION: '1', ...extraEnv },
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

function isDenied(o: Out): boolean {
  return o.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('pre-tool-use H2-01 re-read gate', () => {
  test('DENY: re-read same file, mtime unchanged, not edited (default deny)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path, mtime } = makeFile(cwd, 'a.ts');
    seedRead(tmp, sessionId, path, 0, mtime);
    const out = await runRead(tmp, cwd, sessionId, { file_path: path });
    expect(isDenied(out)).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('H2-01');
  });

  test('ALLOW: partial read (offset present) is exempt', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path, mtime } = makeFile(cwd, 'a.ts');
    seedRead(tmp, sessionId, path, 0, mtime);
    const out = await runRead(tmp, cwd, sessionId, { file_path: path, offset: 10 });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: mtime changed since last read', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path, mtime } = makeFile(cwd, 'a.ts');
    // Seed a stale (different) mtime → current file mtime differs → allow.
    seedRead(tmp, sessionId, path, 0, mtime - 99999);
    const out = await runRead(tmp, cwd, sessionId, { file_path: path });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: file was edited since last read', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path, mtime } = makeFile(cwd, 'a.ts');
    seedRead(tmp, sessionId, path, 0, mtime);
    seedEdit(tmp, sessionId, path, 0);
    const out = await runRead(tmp, cwd, sessionId, { file_path: path });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: previous read had no recorded mtime (fail-open)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path } = makeFile(cwd, 'a.ts');
    seedRead(tmp, sessionId, path, 0); // no mtime
    const out = await runRead(tmp, cwd, sessionId, { file_path: path });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: file not previously read', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path } = makeFile(cwd, 'fresh.ts');
    const out = await runRead(tmp, cwd, sessionId, { file_path: path });
    expect(isDenied(out)).toBe(false);
  });

  test('WARN mode: allow + systemMessage instead of deny', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path, mtime } = makeFile(cwd, 'a.ts');
    seedRead(tmp, sessionId, path, 0, mtime);
    const out = await runRead(tmp, cwd, sessionId, { file_path: path }, { VCF_REREAD_GATE: 'warn' });
    expect(isDenied(out)).toBe(false);
    expect(out.systemMessage ?? '').toContain('H2-01');
  });

  test('OFF mode: no gating at all', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const { path, mtime } = makeFile(cwd, 'a.ts');
    seedRead(tmp, sessionId, path, 0, mtime);
    const out = await runRead(tmp, cwd, sessionId, { file_path: path }, { VCF_REREAD_GATE: 'off' });
    expect(isDenied(out)).toBe(false);
    expect(out.systemMessage ?? '').not.toContain('H2-01');
  });
});
