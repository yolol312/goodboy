import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 위험도 게이트(2-B) 통합 테스트.
//   - 변경 도구(Bash 등)에만 적용, read-only(Read)는 통과.
//   - state.sessionId가 현재 세션과 일치할 때만 적용(커밋된/타세션 잔재는 무시).
//   Bash를 쓰는 이유: read-before-edit/추론/H2-01 게이트를 거치지 않고 위험 게이트(D)에 바로 도달한다.

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

function newCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-risk-'));
  tmpDirs.push(cwd);
  return cwd;
}

function seedRiskyState(cwd: string, sessionId: string, opts: { approved?: boolean } = {}): void {
  const dir = join(cwd, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.vcf-session-state.json'),
    JSON.stringify({ category: 'migrate', risk: 'risky', turn: 0, sessionId }),
    'utf8',
  );
  if (opts.approved) {
    writeFileSync(join(dir, '.vcf-risk-approved.txt'), 'ok', 'utf8');
  }
}

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

async function runTool(
  cwd: string,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, VCF_DISABLE_DELEGATION: '1' },
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

describe('pre-tool-use risk gate (2-B)', () => {
  test('DENY: 변경 도구(Bash) — 현재 세션에 바인딩된 risky state', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A');
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('위험');
  });

  test('ALLOW: read-only(Read)는 risky state여도 위험 게이트 대상 아님', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A');
    const f = join(cwd, 'x.ts');
    writeFileSync(f, 'hello', 'utf8'); // 처음 읽는 파일 → H2-01 통과
    const out = await runTool(cwd, 'sess-A', 'Read', { file_path: f });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: 다른 세션에서 기록된 risky state는 무시(커밋된 잔재 DoS 방지)', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-OTHER');
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: 같은 세션 risky여도 승인 파일(.vcf-risk-approved.txt) 있으면 통과', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A', { approved: true });
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(false);
  });
});
