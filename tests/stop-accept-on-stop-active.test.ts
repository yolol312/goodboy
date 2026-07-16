// (v0.26.7) stop_hook_active 조기 return 경로의 비차단 리뷰 수락.
//   실측 데드락: "차단 → 리뷰 실행 → 턴 종료"의 턴 종료는 항상 stop_hook_active=true라
//   조기 return되어 pass 리뷰가 수락(커서 전진)되지 못했다. 다음 full Stop 전에
//   리뷰가 유효창을 넘기면(사용자가 오래 읽는 등) 같은 파일 집합으로 재차단.
//   이제 이 경로에서 커버리지 통과 + high finding 부재면 커서를 전진시킨다.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-asa-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-asa-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** file-tracker 세션 상태를 심고 실제 파일도 만든다(A 필터 통과). 편집 시각은 1분 전. */
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
  const ts = new Date(Date.now() - 60_000).toISOString();
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

/** 편집 파일을 커버하는 신선한 리뷰(편집보다 나중 시각).
 *  기본 dimensions_checked는 ['performance'] — src/a.ts(.ts 코드 파일)의 필수 차원.
 *  v0.26.8: 수락 조건이 full Stop과 동일해져 차원 누락 리뷰는 수락되지 않는다. */
function writeCoveringReview(
  cwd: string,
  files: string[],
  opts?: { high?: boolean; medium?: boolean; dims?: string[]; assumptionsChecked?: boolean },
): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  const findings: Array<Record<string, unknown>> = [];
  if (opts?.high) findings.push({ file: resolve(cwd, files[0]!), issue: '심각한 문제', severity: 'high' });
  if (opts?.medium) findings.push({ file: resolve(cwd, files[0]!), issue: '참고할 문제', severity: 'medium' });
  writeFileSync(
    join(reviewsDir, 'review.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      reviewed_files: files.map((f) => resolve(cwd, f)),
      category: 'fix-bug',
      findings,
      unknown_assumptions_checked: opts?.assumptionsChecked
        ? [{ assumption: '입력은 항상 문자열', reasonable: true }]
        : [],
      verdict: 'pass',
      dimensions_checked: opts?.dims ?? ['performance'],
    }),
    'utf8',
  );
}

/** ## 추론 섹션에 가정 1건을 선언한 assistant transcript를 만들고 경로를 반환. */
function writeTranscriptWithAssumption(cwd: string): string {
  const path = join(cwd, 'transcript.jsonl');
  const text = ['## 추론', '### 사실', '- 파일 확인함', '### 가정', '- 입력은 항상 문자열'].join('\n');
  writeFileSync(
    path,
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }) + '\n',
    'utf8',
  );
  return path;
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
  stopHookActive: boolean,
  transcriptPath?: string,
): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: sessionId,
        cwd,
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
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

const cursorPath = (cwd: string): string => join(cwd, '.claude', '.goodboy-last-review.json');

describe('Stop hook — stop_hook_active 경로의 비차단 리뷰 수락 (v0.26.7)', () => {
  test('펜딩 편집 + 커버 리뷰 + stop_hook_active => 통과하며 커서 전진(수락)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    // 실제 흐름 반영: 편집(turn 1) 이후 턴이 진행된 상태에서 수락된다.
    //   커서는 현재 턴으로 기록되므로, 현재 턴 > 편집 턴이어야 편집이 소비된다.
    const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    writeFileSync(join(tmp, `goodboy-session-${safe}`, 'turn.txt'), '5', 'utf8');
    writeCoveringReview(cwd, ['src/a.ts']);

    const out = await runStop(tmp, cwd, sessionId, true);
    expect(out.decision).toBeUndefined(); // 조기 return 경로는 절대 차단하지 않는다
    // v0.26.6까지는 여기서 커서가 전진하지 않아, 리뷰가 만료되면 같은 집합으로 재차단됐다.
    expect(existsSync(cursorPath(cwd))).toBe(true);

    // 수락됐으므로 다음 full Stop은 펜딩 편집 없음 → 재차단 없이 통과.
    const next = await runStop(tmp, cwd, sessionId, false);
    expect(next.decision).toBeUndefined();
  });

  test('high finding이 있으면 stop_hook_active 경로에서 수락하지 않는다(다음 full Stop이 차단)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    writeCoveringReview(cwd, ['src/a.ts'], { high: true });

    const out = await runStop(tmp, cwd, sessionId, true);
    expect(out.decision).toBeUndefined(); // 그래도 차단은 하지 않는다
    expect(existsSync(cursorPath(cwd))).toBe(false); // 수락도 하지 않는다

    // 다음 full Stop이 high finding으로 정식 차단.
    const next = await runStop(tmp, cwd, sessionId, false);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('high severity');
  });

  test('커버 리뷰가 없으면 stop_hook_active 경로는 아무 것도 하지 않는다(기존 동작 유지)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);

    const out = await runStop(tmp, cwd, sessionId, true);
    expect(out.decision).toBeUndefined();
    expect(existsSync(cursorPath(cwd))).toBe(false);
  });

  test('필수 차원 누락 리뷰는 수락하지 않는다 — F2 우회 차단 (v0.26.8)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    writeCoveringReview(cwd, ['src/a.ts'], { dims: [] }); // performance 누락

    const out = await runStop(tmp, cwd, sessionId, true);
    expect(out.decision).toBeUndefined(); // 차단은 하지 않는다
    expect(existsSync(cursorPath(cwd))).toBe(false); // 수락도 하지 않는다

    // 다음 full Stop이 차원 누락으로 정식 차단.
    const next = await runStop(tmp, cwd, sessionId, false);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('차원');
  });

  test('가정 선언 + 가정 검증 없는 리뷰는 수락 보류 — F1.5 우회 차단 (v0.26.8)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    const transcript = writeTranscriptWithAssumption(cwd);
    writeCoveringReview(cwd, ['src/a.ts']); // unknown_assumptions_checked: []

    const out = await runStop(tmp, cwd, sessionId, true, transcript);
    expect(out.decision).toBeUndefined(); // 차단은 하지 않는다
    expect(existsSync(cursorPath(cwd))).toBe(false); // 수락도 하지 않는다
  });

  test('가정 선언 + 가정 검증 수행 리뷰는 수락된다 (F1.5 충족)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    writeFileSync(join(tmp, `goodboy-session-${safe}`, 'turn.txt'), '5', 'utf8');
    const transcript = writeTranscriptWithAssumption(cwd);
    writeCoveringReview(cwd, ['src/a.ts'], { assumptionsChecked: true });

    const out = await runStop(tmp, cwd, sessionId, true, transcript);
    expect(out.decision).toBeUndefined();
    expect(existsSync(cursorPath(cwd))).toBe(true);
  });

  test('수락 시 medium/low finding을 systemMessage로 표면화한다 (v0.26.8)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    writeFileSync(join(tmp, `goodboy-session-${safe}`, 'turn.txt'), '5', 'utf8');
    writeCoveringReview(cwd, ['src/a.ts'], { medium: true });

    const out = await runStop(tmp, cwd, sessionId, true);
    expect(out.decision).toBeUndefined();
    expect(existsSync(cursorPath(cwd))).toBe(true); // medium은 수락을 막지 않는다
    expect(out.systemMessage ?? '').toContain('참고할 발견사항'); // 조용히 소비하지 않는다
    expect(out.systemMessage ?? '').toContain('[medium]');
  });
});
