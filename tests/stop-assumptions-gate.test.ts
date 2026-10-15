// (A2) 추측-리뷰 강제 연동 테스트.
//   메인이 추론 섹션에서 추측/가정을 선언했으면, 리뷰의 unknown_assumptions_checked가
//   비어 있을 때 Stop이 차단해야 한다.

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

function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-assume-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-assume-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

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
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles
    .map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts }))
    .join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
  // (A) 리뷰 스코프는 실존 파일만 대상 — 편집 대상 파일을 실제로 만든다.
  for (const f of editFiles) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
}

const DOC_FILE = 'README.md'; // 필수 차원 0개 → 가정 게이트만 격리 평가

function writeReview(cwd: string, unknownChecked: unknown[]): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(
    join(reviewsDir, 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60000).toISOString(),
      reviewed_files: [resolve(cwd, DOC_FILE)],
      category: 'write-doc',
      findings: [],
      unknown_assumptions_checked: unknownChecked,
      verdict: 'pass',
      dimensions_checked: [],
    }),
    'utf8',
  );
}

/** 추측/가정이 담긴 추론 섹션 transcript 생성 */
function writeTranscript(cwd: string, reasoningText: string | null): string {
  const path = join(cwd, 'transcript.jsonl');
  const lines: string[] = [];
  if (reasoningText !== null) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: reasoningText }] },
      }),
    );
  }
  // usage 줄(확정 200K 모델, 저점유) — 컨텍스트 게이트가 간섭하지 않게.
  lines.push(
    JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
  );
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

const REASONING_WITH_SPECULATION = [
  '## 추론',
  '### 사실',
  '- README를 Read로 확인함',
  '### 추측',
  '- ⚠️ 백엔드가 OAuth2 표준 응답을 쓸 것이다',
].join('\n');

const REASONING_FACTS_ONLY = ['## 추론', '### 사실', '- README를 Read로 확인함'].join('\n');

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
  transcriptPath: string,
): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    // 층1 테스트 게이트는 가정 검증 게이트보다 앞서 발동한다 → 이 파일에서는 끈다.
    env: { ...process.env, TMPDIR: tmp, GOODBOY_TEST_GATE: 'off' },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'Stop',
        transcript_path: transcriptPath,
      }),
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

describe('Stop hook — 추측-리뷰 연동 (A2)', () => {
  test('추측 선언 + 리뷰의 가정 검증 비어 있음 → BLOCK', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [DOC_FILE], cwd);
    writeReview(cwd, []);
    const tp = writeTranscript(cwd, REASONING_WITH_SPECULATION);
    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('추측-리뷰 연동');
    expect(out.reason).toContain('1건');
  });

  test('추측 선언 + 리뷰가 가정을 검증함 → PASS', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [DOC_FILE], cwd);
    writeReview(cwd, [
      { assumption: '백엔드 OAuth2 표준 응답', reasonable: true, note: '스펙 문서로 확인' },
    ]);
    const tp = writeTranscript(cwd, REASONING_WITH_SPECULATION);
    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
  });

  test('추측/가정 없는 추론(사실만) → 가정 검증 없어도 PASS', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [DOC_FILE], cwd);
    writeReview(cwd, []);
    const tp = writeTranscript(cwd, REASONING_FACTS_ONLY);
    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
  });

  test('추론 섹션 자체가 없으면 → 검사 생략 (fail-open)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [DOC_FILE], cwd);
    writeReview(cwd, []);
    const tp = writeTranscript(cwd, null);
    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
  });

  // Track G: no count-based escape. The 3rd Stop in a row blocks like the 1st; from the 2nd
  //   block on, the user is told how to let it pass.
  test('no retry cap: the 3rd Stop in a row still blocks and tells the user about the marker', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [DOC_FILE], cwd);
    writeReview(cwd, []);
    // Retry counters are per session (A3): they live in the session state dir.
    writeFileSync(join(tmp, `goodboy-session-${sessionId}`, '.goodboy-retry-count.txt'), '2', 'utf8');
    const tp = writeTranscript(cwd, REASONING_WITH_SPECULATION);
    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('추측-리뷰 연동');
    expect(out.reason).toContain('(block 3)');
    expect(out.reason).toContain('only the user can let this Stop pass');
    expect(out.reason).not.toContain('재시도');
    expect(out.systemMessage ?? '').toContain(`! touch ${approvalMarkerRelPath('stop', sessionId)}`);
    expect(out.systemMessage ?? '').not.toContain('GOODBOY_'); // review gates have no env switch
  });

  test("the user's Stop marker passes the gate once; the next Stop blocks again", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [DOC_FILE], cwd);
    writeReview(cwd, []);
    const marker = approveStop(cwd, sessionId);
    const tp = writeTranscript(cwd, REASONING_WITH_SPECULATION);
    const out = await runStop(tmp, cwd, sessionId, tp);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('검증되지 않았어요');
    expect(out.systemMessage ?? '').toContain('사용자 승인 마커로 이번 턴의');
    expect(existsSync(marker)).toBe(false); // used once

    // The edit is still in scope and still unverified: blocked again, counting from 1.
    const next = await runStop(tmp, cwd, sessionId, tp);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('(block 1)');
  });
});
