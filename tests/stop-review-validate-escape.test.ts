// (결함 D) validateReview 실패 게이트의 영구 데드락 방지.
//   커버리지 실패(리뷰가 변경 파일을 커버하지 않음)로 리뷰 검증이 실패하면 Stop이
//   차단한다. v0.25.0까지 이 게이트만 escape가 없어, 삭제된 유령 파일이 남으면
//   영원히 통과할 수 없었다.
// Track G: no count-based escape. The gate blocks on every Stop; only the user's one-use
//   marker passes it, and that pass moves the review cursor (without it the next turn blocks
//   on the same ghost files again).

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';
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

/** The user's one-use Stop override (track G): what `! touch <marker>` creates. */
function approveStop(cwd: string, sessionId: string): string {
  const p = join(cwd, approvalMarkerRelPath('stop', sessionId));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf8');
  return p;
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

describe('Stop hook — validateReview failure gate: user override (defect D, track G)', () => {
  test("coverage failure blocks on every Stop; only the user's marker passes it and moves the cursor", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    writeUncoveringReview(cwd);
    const touch = `! touch ${approvalMarkerRelPath('stop', sessionId)}`;

    // 1st: block, no notice for the user yet.
    const out1 = await runStop(tmp, cwd, sessionId);
    expect(out1.decision).toBe('block');
    expect(out1.reason).toContain('Review validation failed');
    expect(out1.reason).toContain('(block 1)');
    expect(out1.reason).toContain('only the user can let this Stop pass');
    expect(out1.reason).not.toContain('/review-changes'); // A9: no such command
    expect(out1.reason).not.toContain('retry');
    expect(out1.systemMessage ?? '').not.toContain(touch);

    // 2nd: block, and the user is told how to override (no env switch for review gates).
    const out2 = await runStop(tmp, cwd, sessionId);
    expect(out2.decision).toBe('block');
    expect(out2.reason).toContain('(block 2)');
    expect(out2.systemMessage ?? '').toContain(touch);
    expect(out2.systemMessage ?? '').not.toContain('GOODBOY_');

    // 3rd: still a block (the old escape passed here).
    const out3 = await runStop(tmp, cwd, sessionId);
    expect(out3.decision).toBe('block');
    expect(out3.reason).toContain('(block 3)');
    expect(existsSync(cursorPath(tmp, sessionId, cwd))).toBe(false);

    // The user's marker: pass + notice + cursor moves (the deadlock ends), marker used once.
    const marker = approveStop(cwd, sessionId);
    const out4 = await runStop(tmp, cwd, sessionId);
    expect(out4.decision).toBeUndefined();
    expect(out4.systemMessage ?? '').toContain('리뷰 검증 실패');
    expect(out4.systemMessage ?? '').toContain('사용자 승인 마커로 이번 턴의');
    expect(existsSync(cursorPath(tmp, sessionId, cwd))).toBe(true);
    expect(existsSync(marker)).toBe(false);

    // A new edit after the cursor, still not covered: blocked again, counting from 1.
    const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    appendFileSync(
      join(tmp, `goodboy-session-${safe}`, 'edits.jsonl'),
      JSON.stringify({ file: resolve(cwd, 'src/a.ts'), turn: 4, timestamp: new Date().toISOString() }) + '\n',
      'utf8',
    );
    const out5 = await runStop(tmp, cwd, sessionId);
    expect(out5.decision).toBe('block');
    expect(out5.reason).toContain('(block 1)');
  });
});
