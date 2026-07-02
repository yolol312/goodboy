import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildBashOutputWarning } from '../hooks/post-tool-use';

// H2-02 사후 경고: Bash 실제 출력(tool_response) 크기가 임계를 넘을 때만 경고한다.
// 경고는 hookSpecificOutput.additionalContext(에이전트 도달 채널)로 전달된다.

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'vcf-ptu-flood-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-ptu-flood-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

interface Out {
  hookSpecificOutput?: { additionalContext?: string };
}

async function runBash(
  tmp: string,
  cwd: string,
  sessionId: string,
  command: string,
  toolResponse: unknown,
  extraEnv: Record<string, string> = {},
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: toolResponse,
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, ...extraEnv },
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

const bigStdout = 'x'.repeat(20_000); // > 10,000 char default threshold
const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'); // > 200 lines
const smallStdout = 'all good\n';

describe('buildBashOutputWarning (pure)', () => {
  test('large char output => warning with H2-02 + actual size', () => {
    const w = buildBashOutputWarning({ stdout: bigStdout }, 'cat /var/log/app.log');
    expect(w).not.toBeNull();
    expect(w!).toContain('H2-02');
    expect(w!).toContain('자');
    // pattern hint present (cat .log)
    expect(w!).toContain('cat-log');
  });

  test('large line count output => warning', () => {
    const w = buildBashOutputWarning({ stdout: manyLines }, 'some-cmd');
    expect(w).not.toBeNull();
    expect(w!).toContain('H2-02');
  });

  test('small output => no warning', () => {
    expect(buildBashOutputWarning({ stdout: smallStdout }, 'git status')).toBeNull();
  });

  test('accepts string tool_response as raw output', () => {
    expect(buildBashOutputWarning(bigStdout, 'echo big')).not.toBeNull();
    expect(buildBashOutputWarning('tiny', 'echo hi')).toBeNull();
  });

  test('combines stdout + stderr for size', () => {
    const w = buildBashOutputWarning(
      { stdout: 'x'.repeat(6000), stderr: 'y'.repeat(6000) },
      'noisy-cmd',
    );
    expect(w).not.toBeNull();
  });
});

describe('post-tool-use H2-02 integration', () => {
  test('large output => additionalContext carries H2-02', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runBash(tmp, cwd, sessionId, 'cat /var/log/app.log', { stdout: bigStdout });
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('H2-02');
  });

  test('small output => no warning', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runBash(tmp, cwd, sessionId, 'git status', { stdout: smallStdout });
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-02');
  });

  test('warns only once per session (spam suppression)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const first = await runBash(tmp, cwd, sessionId, 'cat /var/log/a.log', { stdout: bigStdout });
    const second = await runBash(tmp, cwd, sessionId, 'cat /var/log/b.log', { stdout: bigStdout });
    expect(first.hookSpecificOutput?.additionalContext ?? '').toContain('H2-02');
    expect(second.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-02');
  });

  test('VCF_BASH_FLOOD_WARN=off disables the warning', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runBash(tmp, cwd, sessionId, 'cat /var/log/app.log', { stdout: bigStdout }, {
      VCF_BASH_FLOOD_WARN: 'off',
    });
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-02');
  });

  test('env thresholds are adjustable (VCF_BASH_OUTPUT_WARN_CHARS)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    // Lower the char threshold so even small output triggers.
    const out = await runBash(tmp, cwd, sessionId, 'echo hi', { stdout: 'hello' }, {
      VCF_BASH_OUTPUT_WARN_CHARS: '3',
    });
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain('H2-02');
  });

  test('fail-open: missing/garbage tool_response => no crash, no warning', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runBash(tmp, cwd, sessionId, 'cat /var/log/app.log', undefined);
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-02');
  });
});
