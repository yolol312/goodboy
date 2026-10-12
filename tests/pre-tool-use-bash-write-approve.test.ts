// (v0.27.0) Bash 쓰기 게이트 — 1회용 승인 마커 (실사용 피드백: 대량 범위 편집 우회로).
//   수백 줄 범위 삭제처럼 Edit의 old_string 재현이 비현실적인 작업의 정식 경로:
//   사용자 승인 → `.claude/.goodboy-bash-write-approved.txt` → 같은 명령 재시도.
//   마커는 1회용으로 소비되고, 대상 파일은 편집 기록에 남아 리뷰 추적이 유지된다.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';

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

/** This session's one-shot marker (A3: approvals are per session; the id is basename(cwd)). */
const markerPath = (cwd: string): string => join(cwd, approvalMarkerRelPath('bash-write', basename(cwd)));

describe('pre-tool-use bash-write gate — 승인 마커 (v0.27.0)', () => {
  test('마커 없으면 차단 + 대량 편집 절차 안내 포함', async () => {
    const cwd = makeCwd();
    const out = await runBash(cwd, 'echo hi > src/a.ts');
    expect(isBlocked(out)).toBe(true);
    expect(out).toContain(approvalMarkerRelPath('bash-write', basename(cwd))); // this session's name
    expect(out).toContain('Write 도구로 파일 전체');
  });

  // A3: one repo-level name let another session's write consume this session's approval.
  test("another session's write does not consume this session's marker", async () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(markerPath(cwd), '', 'utf8');
    const payload = JSON.stringify({
      session_id: 'other-session',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi > src/b.ts' },
    });
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1' },
      stdin: new TextEncoder().encode(payload),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(isBlocked(out)).toBe(true);
    expect(existsSync(markerPath(cwd))).toBe(true);
    try {
      rmSync(join(tmpdir(), 'goodboy-session-other-session'), { recursive: true, force: true });
    } catch {
      // best-effort
    }
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

  test('병렬 Bash 쓰기 2건은 마커 1개로 정확히 1건만 승인된다 (v0.27.2, TOCTOU)', async () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(markerPath(cwd), '', 'utf8');

    // unlink는 정확히 1회만 성공하므로(원자 소비) 어떤 인터리빙에서도 1건만 승인된다.
    const [a, b] = await Promise.all([
      runBash(cwd, 'echo hi > src/a.ts'),
      runBash(cwd, 'echo hi > src/b.ts'),
    ]);
    const approvedCount = [a, b].filter((o) => !isBlocked(o)).length;
    expect(approvedCount).toBe(1);
    expect(existsSync(markerPath(cwd))).toBe(false);
  });

  test('위험 게이트가 deny하면 마커는 소비되지 않고 유령 편집도 기록되지 않는다 (v0.27.1)', async () => {
    const cwd = makeCwd();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(markerPath(cwd), '', 'utf8');
    // 현재 세션에 바인딩된 risky 상태 → 위험 게이트(D)가 Bash를 deny한다.
    //   The gate reads the state from the session state dir (A3).
    const sessionDir = join(tmpdir(), `goodboy-session-${basename(cwd)}`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, '.goodboy-session-state.json'),
      JSON.stringify({ category: 'migrate', risk: 'risky', sessionId: basename(cwd) }),
      'utf8',
    );

    const out = await runBash(cwd, 'echo hi > src/a.ts');
    expect(isBlocked(out)).toBe(true);
    expect(out).toContain('classified as risky');
    // v0.27.0에서는 A1.7 시점에 마커가 먼저 소비되고 실행되지 않은 쓰기가
    // 유령 편집으로 기록됐다(리뷰 지적) — 이제 deny 게이트 통과 후에만 소비한다.
    expect(existsSync(markerPath(cwd))).toBe(true);
    const editsPath = join(tmpdir(), `goodboy-session-${basename(cwd)}`, 'edits.jsonl');
    expect(existsSync(editsPath)).toBe(false);
  });
});
