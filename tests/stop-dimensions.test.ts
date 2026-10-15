import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';

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

/** Isolated TMPDIR so file-tracker session state lives in its own sandbox. */
function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-stop-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-stop-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** Seed file-tracker session state inside the sandboxed TMPDIR.
 *  Mirrors file-tracker.ts layout: tmp/goodboy-session-<sanitized>/ {turn.txt, edits.jsonl} */
function seedSession(
  tmp: string,
  sessionId: string,
  turn: number,
  editFiles: string[],
  cwd = '/repo',
): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  // Stop increments turn first, so write turn-1 so it lands on `turn` after increment.
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles
    .map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts }))
    .join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
  // (A) 리뷰 스코프는 실존 파일만 대상으로 한다 — 편집 대상 파일을 실제로 만들어
  //   getEditsSince의 existsSync 필터를 통과시킨다(프로덕션 필터 약화 대신 픽스처를 현실화).
  for (const f of editFiles) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
}

function writeReview(cwd: string, review: Record<string, unknown>): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  // Filename irrelevant; findRecentReviewFile picks newest by mtime.
  writeFileSync(join(reviewsDir, 'review.json'), JSON.stringify(review), 'utf8');
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

async function runStop(
  tmp: string,
  cwd: string,
  sessionId: string,
): Promise<StopOut> {
  const input = JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: 'Stop',
  });
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    // 층1 테스트 게이트는 차원 게이트보다 앞서 발동한다 → 이 파일에서는 끈다.
    env: { ...process.env, TMPDIR: tmp, GOODBOY_TEST_GATE: 'off' },
    stdin: new TextEncoder().encode(input),
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

const FRONTEND_FILE = 'index.html';

function baseReview(cwd: string, dimensions: string[]): Record<string, unknown> {
  return {
    timestamp: new Date(Date.now() + 60000).toISOString(), // future-dated: never stale
    reviewed_files: [resolve(cwd, FRONTEND_FILE)],
    category: 'add-feature',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: dimensions,
  };
}

describe('Stop hook — dimension coverage enforcement', () => {
  test('BLOCKS when frontend changed but ui-ux-accessibility not in dimensions_checked', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [FRONTEND_FILE], cwd);
    // dimensions omits ui-ux-accessibility
    writeReview(cwd, baseReview(cwd, ['plan-completeness']));
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('ui-ux-accessibility');
    expect(out.reason).toContain('(block 1)');
  });

  test('PASSES when all required dimensions are present', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [FRONTEND_FILE], cwd);
    writeReview(cwd, baseReview(cwd, ['ui-ux-accessibility', 'plan-completeness']));
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  // Track G: no retry cap. The 3rd Stop in a row blocks like the 1st.
  test('no retry cap: the 3rd Stop in a row still blocks and tells the user about the marker', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [FRONTEND_FILE], cwd);
    // Two blocks already happened. Retry counters are per session (A3): session state dir.
    const sessionDir = join(tmp, `goodboy-session-${sessionId}`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, '.goodboy-retry-count.txt'), '2', 'utf8');
    writeReview(cwd, baseReview(cwd, ['plan-completeness'])); // still missing ui-ux
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('ui-ux-accessibility');
    expect(out.reason).toContain('(block 3)');
    expect(out.reason).toContain('only the user can let this Stop pass');
    expect(out.systemMessage ?? '').toContain(`! touch ${approvalMarkerRelPath('stop', sessionId)}`);
    expect(out.systemMessage ?? '').not.toContain('GOODBOY_'); // review gates have no env switch
  });

  test("the user's Stop marker lets the missing dimension pass once", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [FRONTEND_FILE], cwd);
    writeReview(cwd, baseReview(cwd, ['plan-completeness'])); // still missing ui-ux
    const marker = approveStop(cwd, sessionId);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('ui-ux-accessibility');
    expect(out.systemMessage ?? '').toContain('사용자 승인 마커로 이번 턴의');
    expect(existsSync(marker)).toBe(false); // used once
  });

  test('BACKWARD COMPAT: old review (no dimensions_checked) + change requiring no dimensions → no block, no crash', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    // README.md change requires zero dimensions.
    seedSession(tmp, sessionId, 1, ['README.md'], cwd);
    const old = {
      timestamp: new Date(Date.now() + 60000).toISOString(),
      reviewed_files: [resolve(cwd, 'README.md')],
      category: 'write-doc',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      // no dimensions_checked field at all (old on-disk format)
    };
    writeReview(cwd, old);
    const out = await runStop(tmp, cwd, sessionId);
    // No required dimensions → no dimension block; old format must not crash Stop.
    expect(out.decision).toBeUndefined();
  });

  test('old review (no dimensions_checked) + code change requiring performance → clean block, no crash', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['util.ts'], cwd);
    const old = {
      timestamp: new Date(Date.now() + 60000).toISOString(),
      reviewed_files: [resolve(cwd, 'util.ts')],
      category: 'refactor',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
    };
    writeReview(cwd, old);
    const out = await runStop(tmp, cwd, sessionId);
    // util.ts requires "performance"; old review lacks it → clean block (proves no crash + sane msg).
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('performance');
  });
});
