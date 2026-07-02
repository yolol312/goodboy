import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// H1-03(강제 자동 compact) + H1-01(긴 세션 경고) 상호작용의 Stop hook 통합 테스트.
const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'vcf-stop-habit-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-stop-habit-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

function sessionDir(tmp: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `vcf-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Seed edits so recentEdits is non-empty (Stop reaches the warning + block/pass path). */
function seedSession(tmp: string, sessionId: string, turn: number, editFiles: string[]): void {
  const dir = sessionDir(tmp, sessionId);
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8'); // Stop increments first
  const ts = new Date().toISOString();
  const lines = editFiles
    .map((f) => JSON.stringify({ file: resolve(f), turn, timestamp: ts }))
    .join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
}

function seedHabitState(tmp: string, sessionId: string, state: Record<string, unknown>): void {
  const dir = sessionDir(tmp, sessionId);
  writeFileSync(join(dir, 'habit-state.json'), JSON.stringify(state), 'utf8');
}

function writeTranscript(cwd: string, tokens: number): string {
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(
    path,
    JSON.stringify({
      message: { model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: tokens } },
    }) + '\n',
    'utf8',
  );
  return path;
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  stopReason?: string;
}

async function runStop(
  tmp: string,
  cwd: string,
  sessionId: string,
  transcriptPath?: string,
): Promise<StopOut> {
  const input = JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: 'Stop',
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  });
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp },
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as StopOut;
  } catch {
    return {};
  }
}

const CODE_FILE = '/repo/util.ts';

describe('Stop hook — H1-03 forced auto-compact (>=50%)', () => {
  test('context >= 50% → force block with compact-force reason + stopReason', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    const t = writeTranscript(cwd, 120_000); // 60% → force
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('강제');
    expect(out.reason).toContain('/compact');
    expect(out.stopReason).toBe('compact_needed');
  });

  test('force suppresses H1-01 long-session warning even when tokens are high', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    // 120k tokens = 60% (>= force 50%) AND above token warn 50k → but force wins, H1-01 suppressed.
    const t = writeTranscript(cwd, 120_000);
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('강제');
    expect(out.systemMessage ?? '').not.toContain('긴 세션'); // H1-01 suppressed
  });
});

describe('Stop hook — H1-01 long-session warning', () => {
  test('token-based: tokens over VCF_TOKEN_WARN but below force % → long-session warning, no force', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    // 60k tokens = 30% (below 50% force) but above default token warn 50k.
    const t = writeTranscript(cwd, 60_000);
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage).toContain('긴 세션');
    expect(out.systemMessage).toContain('H1-01');
    expect(out.stopReason).toBeUndefined();
    expect(out.reason ?? '').not.toContain('강제');
  });

  test('time-based: old sessionStartTs → long-session warning', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    const old = new Date(Date.now() - 60 * 60000).toISOString(); // 60 min ago
    seedHabitState(tmp, sessionId, { sessionStartTs: old });
    const t = writeTranscript(cwd, 10_000); // 5% — nothing else triggers
    const out = await runStop(tmp, cwd, sessionId, t);
    expect(out.systemMessage).toContain('긴 세션');
    expect(out.stopReason).toBeUndefined();
  });

  test('fail-open: no transcript → no habit warnings (review enforcement intact)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [CODE_FILE]);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block'); // review still required
    expect(out.systemMessage ?? '').not.toContain('긴 세션');
    expect(out.stopReason).toBeUndefined();
  });
});
