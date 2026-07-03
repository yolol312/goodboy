import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyBashSearch } from '../lib/token-habits';

// H2-03: Bash 재귀 코드베이스 탐색 강제 위임.
//   - classifyBashSearch 단위 판정
//   - pre-tool-use 통합: 메인=deny, 서브에이전트=면제, 파이프/단일파일=통과, off/warn 모드.

describe('classifyBashSearch (H2-03 unit)', () => {
  test('재귀 탐색 명령을 감지한다', () => {
    expect(classifyBashSearch('grep -rn "foo" src/')).toBe('grep -r');
    expect(classifyBashSearch('grep -R foo dir')).toBe('grep -r');
    expect(classifyBashSearch('rg foo')).toBe('rg');
    expect(classifyBashSearch('ag foo')).toBe('ag');
    expect(classifyBashSearch('ack foo')).toBe('ack');
    expect(classifyBashSearch('git grep foo')).toBe('git grep');
    expect(classifyBashSearch('find . -name "*.ts"')).toBe('find');
    expect(classifyBashSearch('find src -type f')).toBe('find');
    expect(classifyBashSearch('sudo grep -r x /etc')).toBe('grep -r'); // 래퍼 제거
    expect(classifyBashSearch('FOO=bar rg x')).toBe('rg'); // env 할당 제거
  });

  test('탐색이 아닌/우회 형태는 null', () => {
    expect(classifyBashSearch('grep foo file.txt')).toBeNull(); // 단일 파일(재귀 아님)
    expect(classifyBashSearch('cat a.txt | grep foo')).toBeNull(); // 파이프 뒤 필터
    expect(classifyBashSearch('echo hi')).toBeNull();
    expect(classifyBashSearch('git status')).toBeNull();
    expect(classifyBashSearch('find . -maxdepth 2')).toBeNull(); // 탐색 술어 없음
    expect(classifyBashSearch('grep --version')).toBeNull();
    expect(classifyBashSearch('')).toBeNull();
    expect(classifyBashSearch('ls -la')).toBeNull();
  });
});

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

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
  systemMessage?: string;
}

async function runBash(
  command: string,
  opts: { agentType?: string; env?: Record<string, string> } = {},
): Promise<Out> {
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-bsearch-'));
  tmpDirs.push(cwd);
  const payload = JSON.stringify({
    session_id: 'sess-bsearch',
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
    ...(opts.agentType ? { agent_type: opts.agentType } : {}),
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
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

describe('pre-tool-use H2-03 Bash search gate (integration)', () => {
  test('DENY: 메인 세션의 재귀 탐색(grep -r)', async () => {
    const out = await runBash('grep -r "foo" .');
    expect(isDenied(out)).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('H2-03');
  });

  test('ALLOW: 서브에이전트(agent_type)는 면제', async () => {
    const out = await runBash('grep -r "foo" .', { agentType: 'general-purpose' });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: 단일 파일 grep', async () => {
    const out = await runBash('grep foo file.txt');
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: 파이프 뒤 필터', async () => {
    const out = await runBash('cat a.txt | grep foo');
    expect(isDenied(out)).toBe(false);
  });

  test('OFF 모드: 게이트 미발동', async () => {
    const out = await runBash('grep -r foo .', { env: { VCF_BASH_SEARCH_GATE: 'off' } });
    expect(isDenied(out)).toBe(false);
  });

  test('WARN 모드: 차단하지 않고 경고(systemMessage)에 H2-03', async () => {
    const out = await runBash('grep -r foo .', { env: { VCF_BASH_SEARCH_GATE: 'warn' } });
    expect(isDenied(out)).toBe(false);
    expect(out.systemMessage ?? '').toContain('H2-03');
  });
});
