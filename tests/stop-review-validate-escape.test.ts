// (결함 D) validateReview 실패 게이트의 영구 데드락 방지.
//   커버리지 실패(리뷰가 변경 파일을 커버하지 않음)로 리뷰 검증이 실패하면 Stop이
//   차단한다. v0.25.0까지 이 게이트만 escape가 없어, 삭제된 유령 파일이 남으면
//   영원히 통과할 수 없었다. 이제 MAX_RETRIES(3) 후에는 통과 + 사용자 알림 + 커서
//   전진(전진 없이는 다음 턴에 같은 집합으로 재차단)으로 데드락을 끊는다.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { REVIEW_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-rve-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-rve-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** Seed file-tracker session state AND create the real files (A 필터 통과). */
function seedSession(
  tmp: string,
  sessionId: string,
  turn: number,
  editFiles: string[],
  cwd: string,
): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles
    .map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts }))
    .join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
  for (const f of editFiles) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
}

/** 커버리지 실패 리뷰: verdict pass, timestamp 현재시각, 그러나 편집 파일을 커버하지 않음. */
function writeUncoveringReview(cwd: string): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(
    join(reviewsDir, 'review.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      reviewed_files: [resolve(cwd, 'other.ts')], // src/a.ts를 커버하지 않음 → coverage 실패
      category: 'refactor',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: [],
    }),
    'utf8',
  );
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runStop(tmp: string, cwd: string, sessionId: string): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    // 층1 테스트 게이트는 리뷰 검증 게이트보다 앞서 발동한다 → 이 파일에서는 끈다.
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'off' },
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop' }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as StopOut;
  } catch {
    return {};
  }
}

/** The review cursor lives in the session state dir (A3), one file per project directory. */
const cursorPath = (tmp: string, sessionId: string, cwd: string): string =>
  join(
    tmp,
    `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`,
    cursorFileName(REVIEW_CURSOR_FILE, cwd),
  );

describe('Stop hook — validateReview 실패 게이트 escape (결함 D)', () => {
  test('커버리지 실패는 1·2회 차단(재시도 카운터), 3회째 통과 + 커서 전진', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    writeUncoveringReview(cwd);

    // 1회: block, 재시도 1/3
    const out1 = await runStop(tmp, cwd, sessionId);
    expect(out1.decision).toBe('block');
    expect(out1.reason).toContain('Review validation failed');
    expect(out1.reason).toContain('retry 1/3');
    expect(out1.reason).not.toContain('/review-changes'); // A9: no such command

    // 2회: block, 재시도 2/3
    const out2 = await runStop(tmp, cwd, sessionId);
    expect(out2.decision).toBe('block');
    expect(out2.reason).toContain('retry 2/3');

    // 3회째: escape → 통과 + 사용자 확인 알림 + 커서 전진(데드락 해소).
    const out3 = await runStop(tmp, cwd, sessionId);
    expect(out3.decision).toBeUndefined();
    expect(out3.systemMessage).toContain('사용자 확인');
    // 커서 파일이 생겨 다음 턴에 같은 유령 집합으로 재차단되지 않는다.
    expect(existsSync(cursorPath(tmp, sessionId, cwd))).toBe(true);
  });
});
