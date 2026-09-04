// lib/cli.ts `test-write` — TestResult 쓰기 시점의 스키마 검증.
//
// 게이트가 읽기 시점에도 같은 것을 다시 보지만, 쓰기 시점에 거부하면 에이전트가
// 즉시 오류 메시지를 받아 스스로 고칠 수 있다(리뷰 write와 같은 2겹 방어).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateTestResultInput, uniqueJsonPath } from '../lib/cli';

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
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
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-tw-'));
  tmpDirs.push(cwd);
  return cwd;
}

/** cwd 안에 실재하는 테스트 파일을 만들고 절대경로를 반환. */
function realTestFile(cwd: string): string {
  const f = join(cwd, 'a.test.ts');
  writeFileSync(f, 'test("x", () => {});', 'utf8');
  return f;
}

async function runTestWrite(
  cwd: string,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI, 'test-write'], {
    cwd,
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function validResult(cwd: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tested_files: ['/repo/src/a.ts'],
    category: 'add-feature',
    test_files: [realTestFile(cwd)],
    environment: { mode: 'local', command: 'npm run dev', evidence: '200 OK' },
    suites: [{ name: 'unit', command: 'bun test', passed: 2, failed: 0, output: '2 pass' }],
    acceptance: [
      {
        id: 'AC-1',
        description: '동작한다',
        test: 'a.test.ts',
        red: { command: 'git stash && bun test', output: 'fail', exit_code: 1 },
        green: { command: 'git stash pop && bun test', output: 'pass', exit_code: 0 },
      },
    ],
    verdict: 'pass',
    ...over,
  };
}

describe('test-write CLI', () => {
  test('유효한 결과를 .claude/tests/ 에 기록한다', async () => {
    const cwd = newCwd();
    const { code, stdout } = await runTestWrite(cwd, JSON.stringify(validResult(cwd)));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { ok: boolean; path: string };
    expect(out.ok).toBe(true);
    expect(existsSync(out.path)).toBe(true);
    expect(readdirSync(join(cwd, '.claude', 'tests'))).toHaveLength(1);
  });

  test('호출자 timestamp는 무시하고 서버 시각을 쓴다 (미래 시각 우회 차단)', async () => {
    const cwd = newCwd();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const { stdout } = await runTestWrite(
      cwd,
      JSON.stringify(validResult(cwd, { timestamp: future })),
    );
    const out = JSON.parse(stdout) as { timestamp: string };
    expect(out.timestamp).not.toBe(future);
    expect(Date.parse(out.timestamp)).toBeLessThanOrEqual(Date.now() + 5000);
  });

  test('실재하지 않는 test_files는 거부한다', async () => {
    const cwd = newCwd();
    const { code, stderr } = await runTestWrite(
      cwd,
      JSON.stringify(validResult(cwd, { test_files: ['/nowhere/x.test.ts'] })),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('존재하지 않습니다');
  });

  test('red가 성공(exit 0)이면 거부한다', async () => {
    const cwd = newCwd();
    const bad = validResult(cwd);
    (bad.acceptance as Array<Record<string, unknown>>)[0]!.red = {
      command: 'bun test',
      output: 'ok',
      exit_code: 0,
    };
    const { code, stderr } = await runTestWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('아무것도 검증하지 않습니다');
  });

  test('exit_code 없는 증거는 거부한다', async () => {
    const cwd = newCwd();
    const bad = validResult(cwd);
    (bad.acceptance as Array<Record<string, unknown>>)[0]!.red = { command: 'bun test', output: 'fail' };
    const { code, stderr } = await runTestWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('exit_code');
  });

  test('알 수 없는 environment.mode는 거부한다', async () => {
    const cwd = newCwd();
    const { code, stderr } = await runTestWrite(
      cwd,
      JSON.stringify(validResult(cwd, { environment: { mode: 'kubernetes' } })),
    );
    expect(code).toBe(1);
    expect(stderr).toContain('environment.mode');
  });

  test('test_files가 비면 거부한다 — 테스트는 repo에 남는 자산', async () => {
    const cwd = newCwd();
    const { code, stderr } = await runTestWrite(cwd, JSON.stringify(validResult(cwd, { test_files: [] })));
    expect(code).toBe(1);
    expect(stderr).toContain('임시 프로브가 아님');
  });

  test('잘못된 verdict은 거부한다', async () => {
    const cwd = newCwd();
    const { code, stderr } = await runTestWrite(cwd, JSON.stringify(validResult(cwd, { verdict: 'ok' })));
    expect(code).toBe(1);
    expect(stderr).toContain('verdict');
  });
});

describe('validateTestResultInput (직접 호출)', () => {
  test('최상위가 객체가 아니면 거부', () => {
    expect(validateTestResultInput([]).ok).toBe(false);
    expect(validateTestResultInput(null).ok).toBe(false);
  });

  test('mutation.detected가 boolean이 아니면 거부', () => {
    const cwd = newCwd();
    const bad = validResult(cwd);
    (bad.acceptance as Array<Record<string, unknown>>)[0]!.mutation = {
      command: 'remove node',
      output: 'x',
      detected: 'yes',
    };
    const v = validateTestResultInput(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('detected');
  });
});

describe('uniqueJsonPath — 병렬 축이 같은 밀리초에 써도 덮어쓰지 않는다', () => {
  test('빈 디렉터리면 그대로', () => {
    const cwd = newCwd();
    expect(uniqueJsonPath(cwd, 'r')).toBe(join(cwd, 'r.json'));
  });

  test('이미 있으면 -2, -3 으로 비켜간다', () => {
    const cwd = newCwd();
    writeFileSync(join(cwd, 'r.json'), '{}', 'utf8');
    expect(uniqueJsonPath(cwd, 'r')).toBe(join(cwd, 'r-2.json'));
    writeFileSync(join(cwd, 'r-2.json'), '{}', 'utf8');
    expect(uniqueJsonPath(cwd, 'r')).toBe(join(cwd, 'r-3.json'));
  });
});
