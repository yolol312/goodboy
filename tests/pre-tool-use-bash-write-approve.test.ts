// (v0.27.0) Bash 쓰기 게이트 — 1회용 승인 마커 (실사용 피드백: 대량 범위 편집 우회로).
//   수백 줄 범위 삭제처럼 Edit의 old_string 재현이 비현실적인 작업의 정식 경로:
//   사용자 승인 → `.claude/.goodboy-bash-write-approved.txt` → 같은 명령 재시도.
//   마커는 1회용으로 소비되고, 대상 파일은 편집 기록에 남아 리뷰 추적이 유지된다.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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
    try {
      rmSync(join(tmpdir(), `goodboy-session-${basename(d)}`), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-bwa-'));
  tmpDirs.push(cwd);
  return cwd;
}

async function runBash(cwd: string, command: string): Promise<string> {
  const payload = JSON.stringify({
    session_id: basename(cwd),
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1' },
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

function isBlocked(stdout: string): boolean {
  const out = JSON.parse(stdout || '{}') as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return out.hookSpecificOutput?.permissionDecision === 'deny';
}

const markerPath = (cwd: string): string =>
  join(cwd, '.claude', '.goodboy-bash-write-approved.txt');

describe('pre-tool-use bash-write gate — 승인 마커 (v0.27.0)', () => {
  test('마커 없으면 차단 + 대량 편집 절차 안내 포함', async () => {
    const cwd = makeCwd();
    const out = await runBash(cwd, 'echo hi > src/a.ts');
    expect(isBlocked(out)).toBe(true);
    expect(out).toContain('goodboy-bash-write-approved');
    expect(out).toContain('Write 도구로 파일 전체');
  });

  test('마커 있으면 1회 허용 — 마커 소비 + 편집 기록 + 경고 표면화', async () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(markerPath(cwd), '', 'utf8');

    const out = await runBash(cwd, 'echo hi > src/a.ts');
    expect(isBlocked(out)).toBe(false);
    expect(out).toContain('승인 마커');
    // 1회용 — 소비됨.
    expect(existsSync(markerPath(cwd))).toBe(false);
    // 편집 기록에 남아 리뷰 추적 유지.
    const editsPath = join(tmpdir(), `goodboy-session-${basename(cwd)}`, 'edits.jsonl');
    expect(existsSync(editsPath)).toBe(true);
    expect(readFileSync(editsPath, 'utf8')).toContain(resolve(cwd, 'src/a.ts'));

    // 다음 쓰기는 다시 차단(1회용 확인).
    const second = await runBash(cwd, 'echo hi > src/b.ts');
    expect(isBlocked(second)).toBe(true);
  });
});
