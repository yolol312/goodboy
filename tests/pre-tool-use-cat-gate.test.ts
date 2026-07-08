// (D3) H2-02 사전 차단 — bare cat 대용량 통짜 출력 게이트 테스트.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyBareCatDump } from '../lib';

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

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-cat-gate-'));
  tmpDirs.push(cwd);
  return cwd;
}

function makeBigFile(cwd: string, name: string, bytes: number): string {
  const path = join(cwd, name);
  writeFileSync(path, 'x'.repeat(bytes), 'utf8');
  return path;
}

const THRESHOLD = 1000; // 테스트용 소형 임계

describe('classifyBareCatDump (pure)', () => {
  test('임계 초과 단일 파일 bare cat → 매칭', () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    const hit = classifyBareCatDump('cat big.log', cwd, THRESHOLD);
    expect(hit).not.toBeNull();
    expect(hit!.bytes).toBe(2000);
  });

  test('파이프가 붙으면(cat big | head) → 통과 (실제 출력 작음)', () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    expect(classifyBareCatDump('cat big.log | head -5', cwd, THRESHOLD)).toBeNull();
  });

  test('리다이렉트(cat a > b)/heredoc(cat <<EOF) → 통과', () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    expect(classifyBareCatDump('cat big.log > copy.log', cwd, THRESHOLD)).toBeNull();
    expect(classifyBareCatDump("cat <<'EOF'\nhello\nEOF", cwd, THRESHOLD)).toBeNull();
  });

  test('임계 이하 파일 → 통과', () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'small.txt', 100);
    expect(classifyBareCatDump('cat small.txt', cwd, THRESHOLD)).toBeNull();
  });

  test('없는 파일/glob/변수 인자 → 통과 (fail-open)', () => {
    const cwd = makeCwd();
    expect(classifyBareCatDump('cat missing.txt', cwd, THRESHOLD)).toBeNull();
    expect(classifyBareCatDump('cat *.log', cwd, THRESHOLD)).toBeNull();
    expect(classifyBareCatDump('cat $FILE', cwd, THRESHOLD)).toBeNull();
  });

  test('여러 파일 합산이 임계 초과 → 매칭', () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'a.txt', 600);
    makeBigFile(cwd, 'b.txt', 600);
    const hit = classifyBareCatDump('cat a.txt b.txt', cwd, THRESHOLD);
    expect(hit).not.toBeNull();
    expect(hit!.bytes).toBe(1200);
  });

  test('cat이 아닌 명령 → 통과', () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    expect(classifyBareCatDump('head big.log', cwd, THRESHOLD)).toBeNull();
  });
});

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  systemMessage?: string;
}

async function runBash(
  cwd: string,
  command: string,
  extraEnv: Record<string, string> = {},
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: 'cat-gate-test',
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: {
      ...process.env,
      TMPDIR: cwd,
      GOODBOY_CAT_DENY_BYTES: String(THRESHOLD),
      GOODBOY_BASH_SEARCH_GATE: 'off',
      ...extraEnv,
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

describe('pre-tool-use cat 사전 차단 (integration)', () => {
  test('대용량 bare cat → DENY (Read/head 안내)', async () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    const out = await runBash(cwd, 'cat big.log');
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason ?? '').toContain('H2-02');
  });

  test('cat big | head → 허용', async () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    const out = await runBash(cwd, 'cat big.log | head -5');
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  test('warn 모드 → 허용 + 경고', async () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    const out = await runBash(cwd, 'cat big.log', { GOODBOY_CAT_GATE: 'warn' });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('H2-02');
  });

  test('off 모드 → 게이트 없음', async () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    const out = await runBash(cwd, 'cat big.log', { GOODBOY_CAT_GATE: 'off' });
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(out.systemMessage ?? '').not.toContain('H2-02');
  });

  test('서브에이전트에도 적용된다', async () => {
    const cwd = makeCwd();
    makeBigFile(cwd, 'big.log', 2000);
    const payload = JSON.stringify({
      session_id: 'cat-gate-test',
      cwd,
      agent_type: 'general-purpose',
      agent_id: 'agent-1',
      tool_name: 'Bash',
      tool_input: { command: 'cat big.log' },
    });
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      env: { ...process.env, TMPDIR: cwd, GOODBOY_CAT_DENY_BYTES: String(THRESHOLD) },
      stdin: new TextEncoder().encode(payload),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    const out = JSON.parse(stdout || '{}') as Out;
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});
