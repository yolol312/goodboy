import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// bin/goodboy-run.sh — Bun 부재 가드 + 첫 실행 자동 설치.
// POSIX sh 스크립트이므로 PATH/HOME을 격리해 "bun 없음" 환경을 재현한다.
// 실제 네트워크 설치는 하지 않는다 — GOODBOY_INSTALL_CMD override로 대체.

const GUARD = resolve(import.meta.dir, '..', 'bin', 'goodboy-run.sh');
// bun이 절대 없을 최소 PATH (sh/find/mkdir/curl 등 기본 유틸만)
const BARE_PATH = '/usr/bin:/bin';

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

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'goodboy-guard-'));
  tmpDirs.push(home);
  return home;
}

/** '{}'를 출력하는 가짜 bun 실행 파일을 만들고 그 디렉토리를 반환 */
function makeFakeBunDir(home: string): string {
  const binDir = join(home, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  const bunPath = join(binDir, 'bun');
  writeFileSync(bunPath, '#!/bin/sh\necho "{}"\n', 'utf8');
  chmodSync(bunPath, 0o755);
  return binDir;
}

interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGuard(
  hook: string,
  home: string,
  env: Record<string, string> = {},
): Promise<GuardResult> {
  const proc = Bun.spawn(['sh', GUARD, hook], {
    cwd: home,
    env: { PATH: BARE_PATH, HOME: home, ...env },
    stdin: new TextEncoder().encode('{}'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function markerPath(home: string): string {
  return join(home, '.claude', 'goodboy-runtime', '.install-consent-pending');
}

describe('bun guard — bun이 있으면 그대로 실행', () => {
  test('PATH의 bun으로 hook을 실행한다', async () => {
    const home = makeHome();
    const fakeBin = makeFakeBunDir(home);
    const r = await runGuard('pre-tool-use', home, { PATH: `${fakeBin}:${BARE_PATH}` });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  });

  test('PATH에 없어도 runtime 디렉토리의 bun을 찾는다', async () => {
    const home = makeHome();
    const runtimeBin = join(home, '.claude', 'goodboy-runtime', 'bin');
    mkdirSync(runtimeBin, { recursive: true });
    const bunPath = join(runtimeBin, 'bun');
    writeFileSync(bunPath, '#!/bin/sh\necho "{}"\n', 'utf8');
    chmodSync(bunPath, 0o755);
    const r = await runGuard('stop', home);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  });
});

describe('bun guard — Windows(Git Bash) 대응', () => {
  test('runtime 디렉토리의 bun.exe도 찾는다', async () => {
    const home = makeHome();
    const runtimeBin = join(home, '.claude', 'goodboy-runtime', 'bin');
    mkdirSync(runtimeBin, { recursive: true });
    const bunExe = join(runtimeBin, 'bun.exe');
    writeFileSync(bunExe, '#!/bin/sh\necho "{}"\n', 'utf8');
    chmodSync(bunExe, 0o755);
    const r = await runGuard('stop', home);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  });

  test('~/.bun/bin/bun.exe 폴백도 찾는다', async () => {
    const home = makeHome();
    const bunDir = join(home, '.bun', 'bin');
    mkdirSync(bunDir, { recursive: true });
    const bunExe = join(bunDir, 'bun.exe');
    writeFileSync(bunExe, '#!/bin/sh\necho "{}"\n', 'utf8');
    chmodSync(bunExe, 0o755);
    const r = await runGuard('stop', home);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  });
});

describe('bun guard — bun 없음', () => {
  test('pre-tool-use => exit 2 차단 + 안내', async () => {
    const home = makeHome();
    const r = await runGuard('pre-tool-use', home);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Bun');
    expect(r.stderr).toContain('차단');
  });

  test('post-tool-use / stop => 조용히 통과 (exit 0)', async () => {
    const home = makeHome();
    for (const hook of ['post-tool-use', 'stop']) {
      const r = await runGuard(hook, home);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe('');
    }
  });

  test('user-prompt-submit 1차 => exit 2 + 재입력 안내 + 동의 마커 생성', async () => {
    const home = makeHome();
    const r = await runGuard('user-prompt-submit', home);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('다시 입력');
    expect(existsSync(markerPath(home))).toBe(true);
  });

  test('user-prompt-submit 2차(마커 fresh) => 자동 설치 후 hook 정상 실행 + 마커 제거', async () => {
    const home = makeHome();
    const fakeBin = makeFakeBunDir(home);
    // 1차: 동의 마커 생성
    await runGuard('user-prompt-submit', home);
    // 2차: "설치"는 가짜 bun을 runtime 위치로 복사하는 명령으로 대체
    const installCmd = `mkdir -p "$BUN_INSTALL/bin" && cp "${join(fakeBin, 'bun')}" "$BUN_INSTALL/bin/bun"`;
    const r = await runGuard('user-prompt-submit', home, { GOODBOY_INSTALL_CMD: installCmd });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(existsSync(markerPath(home))).toBe(false);
  });

  test('설치 실패 => exit 2 + 수동 설치 안내', async () => {
    const home = makeHome();
    await runGuard('user-prompt-submit', home);
    const r = await runGuard('user-prompt-submit', home, { GOODBOY_INSTALL_CMD: 'false' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('실패');
  });

  test('GOODBOY_AUTO_INSTALL=off => 마커와 무관하게 차단 + 수동 안내만', async () => {
    const home = makeHome();
    await runGuard('user-prompt-submit', home); // 마커 생성
    const r = await runGuard('user-prompt-submit', home, { GOODBOY_AUTO_INSTALL: 'off' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('bun.sh/install');
    expect(r.stderr).not.toContain('다시 입력');
  });

  test('GOODBOY_BUN_GUARD=off => 모든 hook 조용히 통과 (기존 fail-open)', async () => {
    const home = makeHome();
    for (const hook of ['pre-tool-use', 'post-tool-use', 'user-prompt-submit', 'stop']) {
      const r = await runGuard(hook, home, { GOODBOY_BUN_GUARD: 'off' });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    }
  });
});
