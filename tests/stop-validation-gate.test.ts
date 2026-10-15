// (C1) 자동 검증 실패 → Stop 차단 게이트 테스트.
//   PostToolUse가 남긴 실패 마커가 살아 있는 동안 Stop이 턴 종료를 차단하는지,
//   세션 바인딩/escape/해제 흐름이 맞는지 검증한다.
// Track G: no count-based escape; only the user's one-use Stop marker (or
//   GOODBOY_AUTOVALIDATE=off) lets a Stop past a live failure marker.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const POST_HOOK = resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-vgate-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-vgate-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** The marker lives in the session state dir (A3), under the sandbox TMPDIR. */
function markerPath(tmp: string, sessionId: string): string {
  return join(tmp, `goodboy-session-${sessionId}`, '.goodboy-validation-failed.json');
}

function seedMarker(tmp: string, sessionId: string, commands: string[], owner = sessionId): void {
  mkdirSync(join(tmp, `goodboy-session-${sessionId}`), { recursive: true });
  writeFileSync(
    markerPath(tmp, sessionId),
    JSON.stringify({ sessionId: owner, timestamp: new Date().toISOString(), commands }),
    'utf8',
  );
}

/** The user's one-use Stop override (track G): what `! touch <marker>` creates. */
function approveStop(cwd: string, sessionId: string): string {
  const p = join(cwd, approvalMarkerRelPath('stop', sessionId));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf8');
  return p;
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runHook(
  hookPath: string,
  tmp: string,
  cwd: string,
  input: Record<string, unknown>,
): Promise<HookOut> {
  const proc = Bun.spawn(['bun', hookPath], {
    cwd,
    env: { ...process.env, TMPDIR: tmp },
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as HookOut;
  } catch {
    return {};
  }
}

async function runStop(tmp: string, cwd: string, sessionId: string): Promise<HookOut> {
  return runHook(STOP_HOOK, tmp, cwd, { session_id: sessionId, cwd, hook_event_name: 'Stop' });
}

describe('Stop hook — 자동 검증 실패 게이트 (C1)', () => {
  test("this session's failure marker → BLOCK (failed command and block count)", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(tmp, sessionId,['bun run typecheck']);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('bun run typecheck');
    expect(out.reason).toContain('(block 1)');
    expect(out.reason).toContain('only the user can let this Stop pass');
    expect(out.reason).not.toContain('재시도');
    // 마커는 유지된다(해제는 재검증 통과가 담당).
    expect(existsSync(markerPath(tmp, sessionId))).toBe(true);
  });

  test('다른 세션의 마커(이월/커밋 잔재) → 차단하지 않음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(tmp, 'some-other-session', ['bun run typecheck']);
    // A marker in this session's dir that names another session is ignored too.
    seedMarker(tmp, sessionId, ['bun run typecheck'], 'some-other-session');
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  // Before A3 the marker was one <cwd>/.claude/ file: a legacy one is not read at all.
  test('a legacy repo-level marker is ignored, even with this session id', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', '.goodboy-validation-failed.json'),
      JSON.stringify({ sessionId, timestamp: new Date().toISOString(), commands: ['bun run typecheck'] }),
      'utf8',
    );
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('깨진 마커 JSON → 차단하지 않음 (fail-open)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    mkdirSync(join(tmp, `goodboy-session-${sessionId}`), { recursive: true });
    writeFileSync(markerPath(tmp, sessionId), '{ not json', 'utf8');
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('no retry cap: the 3rd Stop in a row still blocks and names the marker and GOODBOY_AUTOVALIDATE=off', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(tmp, sessionId,['bun run typecheck']);
    // Two blocks already happened. Retry counters are per session (A3): session state dir.
    const sessionDir = join(tmp, `goodboy-session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '.goodboy-validation-retry-count.txt'), '2', 'utf8');
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('(block 3)');
    expect(out.systemMessage ?? '').toContain(`! touch ${approvalMarkerRelPath('stop', sessionId)}`);
    expect(out.systemMessage ?? '').toContain('GOODBOY_AUTOVALIDATE=off');
    expect(existsSync(markerPath(tmp, sessionId))).toBe(true); // the failure stays
  });

  test("the user's Stop marker passes once and clears the failure marker; the next failure blocks again", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(tmp, sessionId,['bun run typecheck']);
    const sessionDir = join(tmp, `goodboy-session-${sessionId}`);
    writeFileSync(join(sessionDir, '.goodboy-validation-retry-count.txt'), '2', 'utf8');
    const approval = approveStop(cwd, sessionId);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('사용자 승인 마커로 이번 턴의');
    expect(out.systemMessage ?? '').toContain('이번 턴의 validation 게이트');
    // The pass clears the failure marker (as the old escape did) and uses the approval once.
    expect(existsSync(markerPath(tmp, sessionId))).toBe(false);
    expect(existsSync(approval)).toBe(false);
    expect(existsSync(join(sessionDir, '.goodboy-validation-retry-count.txt'))).toBe(false);

    seedMarker(tmp, sessionId,['bun run typecheck']);
    const next = await runStop(tmp, cwd, sessionId);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('(block 1)');
  });

  test('검증 게이트는 리뷰 재시도 카운터(.goodboy-retry-count.txt)를 건드리지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedMarker(tmp, sessionId,['bun run typecheck']);
    const sessionDir = join(tmp, `goodboy-session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '.goodboy-retry-count.txt'), '1', 'utf8');
    await runStop(tmp, cwd, sessionId);
    const reviewCount = readFileSync(join(sessionDir, '.goodboy-retry-count.txt'), 'utf8');
    expect(reviewCount.trim()).toBe('1'); // 분리된 카운터 — 리뷰 쪽은 그대로
  });
});

describe('PostToolUse — 검증 실패 마커 기록/해제 (C1)', () => {
  test('typecheck 실패 → 마커 기록(세션 바인딩), 이후 통과 → 마커 해제', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    // 실패하는 typecheck 스크립트
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: 'exit 1' } }),
      'utf8',
    );
    const editedFile = join(cwd, 'a.ts');
    writeFileSync(editedFile, 'export {};\n', 'utf8');
    const editInput = {
      session_id: sessionId,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: editedFile },
    };

    await runHook(POST_HOOK, tmp, cwd, editInput);
    expect(existsSync(markerPath(tmp, sessionId))).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath(tmp, sessionId), 'utf8')) as {
      sessionId: string;
      commands: string[];
    };
    expect(marker.sessionId).toBe(sessionId);
    expect(marker.commands.join(' ')).toContain('typecheck');

    // 통과하는 스크립트로 교체 → 재검증 통과 → 마커 해제
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: 'exit 0' } }),
      'utf8',
    );
    await runHook(POST_HOOK, tmp, cwd, editInput);
    expect(existsSync(markerPath(tmp, sessionId))).toBe(false);
  });

  test('검증이 아예 안 도는 프로젝트(스크립트 없음) → 기존 마커를 오해제하지 않음', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0', scripts: {} }),
      'utf8',
    );
    seedMarker(tmp, sessionId,['bun run typecheck']);
    const editedFile = join(cwd, 'a.ts');
    writeFileSync(editedFile, 'export {};\n', 'utf8');
    await runHook(POST_HOOK, tmp, cwd, {
      session_id: sessionId,
      cwd,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: editedFile },
    });
    // 검증이 실행되지 않았으므로(results 비어있음) 마커는 그대로여야 한다.
    expect(existsSync(markerPath(tmp, sessionId))).toBe(true);
  });

  // A3: a pass recorded for the project lifts only failures older than it — the tree may
  //   have broken again since (see tests/concurrent-sessions.test.ts for the lifting case).
  test("a pass recorded before this session's failure does not lift it", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const setTypecheck = (script: string): void =>
      writeFileSync(
        join(cwd, 'package.json'),
        JSON.stringify({ name: 't', version: '0.0.0', scripts: { typecheck: script } }),
        'utf8',
      );
    const editedFile = join(cwd, 'a.ts');
    writeFileSync(editedFile, 'export {};\n', 'utf8');
    const editBy = (sid: string): Promise<HookOut> =>
      runHook(POST_HOOK, tmp, cwd, {
        session_id: sid,
        cwd,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: editedFile },
      });
    setTypecheck('exit 0');
    await editBy('sess-other'); // another session passes first
    setTypecheck('exit 1');
    await editBy(sessionId); // then this session's typecheck fails

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('bun run typecheck');
  });
});
