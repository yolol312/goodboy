import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// H2-02는 PreToolUse(사전 경고)에서 PostToolUse(사후 경고)로 이동했다.
// PreToolUse의 additionalContext는 도구 호출 에이전트에 주입되지 않기 때문이다.
// 이 파일은 "PreToolUse에서 H2-02가 완전히 사라졌는지"를 회귀 방지로 검증한다.
// 실제 사후 경고 동작은 post-tool-use-bash-flood.test.ts 참고.

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
  const tmp = mkdtempSync(join(tmpdir(), 'vcf-flood-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-flood-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string };
  systemMessage?: string;
}

async function runBash(
  tmp: string,
  cwd: string,
  sessionId: string,
  command: string,
  extraEnv: Record<string, string> = {},
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
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

describe('pre-tool-use no longer emits H2-02 (moved to PostToolUse)', () => {
  test('cat of a .log file produces no H2-02 warning and no deny', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runBash(tmp, cwd, sessionId, 'cat /var/log/app.log');
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-02');
    expect(out.systemMessage ?? '').not.toContain('H2-02');
  });

  test('the live-missed form (path glob + redirect + || echo) is not flagged pre-run', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runBash(
      tmp,
      cwd,
      sessionId,
      'cat /Users/x/workspace/vcf/*.log 2>/dev/null || echo NO_LOG',
    );
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(out.hookSpecificOutput?.additionalContext ?? '').not.toContain('H2-02');
  });

  test('normal short command still passes cleanly', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const out = await runBash(tmp, cwd, sessionId, 'git status');
    expect(out.systemMessage ?? '').not.toContain('H2-02');
    expect(out.hookSpecificOutput).toBeUndefined();
  });
});
