// Stop hook — 층1 테스트 게이트 (B6) 통합 테스트.
//
// 이 게이트는 리뷰보다 **앞서** 발동한다. 리뷰(리팩토링·성능·보안)는 "동작은 맞다"를
// 전제로 하는 검토이기 때문이다. 그래서 차단 케이스에는 리뷰 파일을 두지 않는다 —
// 테스트 게이트에서 막히면 리뷰 게이트까지 가지 않는 것이 정상 동작이다.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';
import { TEST_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';

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
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-tg-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-tg-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** The test cursor lives in the session state dir (A3), one file per project directory. */
function testCursorPath(tmp: string, sessionId: string, cwd: string): string {
  return join(
    tmp,
    `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`,
    cursorFileName(TEST_CURSOR_FILE, cwd),
  );
}

function seedSession(tmp: string, sessionId: string, turn: number, editFiles: string[], cwd: string): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `goodboy-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  // Stop이 턴을 먼저 증가시키므로 turn-1을 써서 증가 후 turn이 되게 한다.
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles.map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts })).join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
  // getEditsSince는 실존 파일만 남기므로 편집 대상 파일을 실제로 만든다.
  for (const f of editFiles) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
}

/** repo에 실재하는 테스트 파일을 만들고 절대경로를 반환. */
function makeTestFile(cwd: string, rel: string, content = 'test("x", () => { expect(1).toBe(1); });'): string {
  const abs = resolve(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

interface TestResultOpts {
  testedFiles: string[];
  testFiles: string[];
  suites?: Array<{ name: string; command: string; passed: number; failed: number; output: string }>;
  acceptance?: Array<Record<string, unknown>>;
  verdict?: string;
  /** With verdict `blocked` (track G): why the tests could not run, and the evidence. */
  blocked?: Record<string, unknown>;
}

function writeTestResult(cwd: string, opts: TestResultOpts): void {
  const dir = join(cwd, '.claude', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({
      // 미래 시각: 편집보다 항상 나중 → staleness로 걸리지 않는다.
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      tested_files: opts.testedFiles,
      category: 'add-feature',
      test_files: opts.testFiles,
      environment: { mode: 'local', command: 'npm run dev', evidence: 'HTTP/1.1 200 OK' },
      suites: opts.suites ?? [{ name: 'unit', command: 'bun test', passed: 3, failed: 0, output: '3 pass' }],
      acceptance: opts.acceptance ?? [],
      verdict: opts.verdict ?? 'pass',
      ...(opts.blocked ? { blocked: opts.blocked } : {}),
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

/** 통과 케이스는 리뷰 게이트까지 흘러가므로 통과 리뷰가 함께 필요하다. */
function writePassingReview(cwd: string, files: string[]): void {
  const dir = join(cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files,
      category: 'add-feature',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: ['performance', 'refactoring-quality', 'security-secrets'],
    }),
    'utf8',
  );
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
  extraEnv: Record<string, string> = {},
): Promise<StopOut> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    // 게이트 판정 로직이 아니라 **게이트 본문**을 검증하는 파일이라 명시적으로 켠다.
    // 기본값 auto는 테스트 인프라가 없는 샌드박스에서 게이트를 끄므로(설계대로),
    // 여기서 auto를 쓰면 모든 케이스가 통과로 위장된다.
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'on', ...extraEnv },
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

const CODE_FILE = 'src/a.ts';

function goodAcceptance(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'AC-1',
    description: '기능이 동작한다',
    test: 'tests/a.test.ts',
    red: { command: 'git stash && bun test', output: '1 fail', exit_code: 1 },
    green: { command: 'git stash pop && bun test', output: '1 pass', exit_code: 0 },
    ...over,
  };
}

describe('Stop hook — 층1 테스트 게이트', () => {
  test('편집이 있는데 테스트 결과가 없으면 BLOCK', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    expect(out.reason).toContain('goodboy:test-unit');
  });

  // Layer-1 test run: isTestFile() saw the absolute path, so for a repo that lives under a
  //   tests/ directory every file was a "test file" and layer 1 never fired.
  test('a repo that lives under a tests/ directory is still gated', async () => {
    const { tmp, cwd: parent, sessionId } = newSandbox();
    const cwd = join(parent, 'tests', 'proj');
    mkdirSync(cwd, { recursive: true });
    seedSession(tmp, sessionId, 3, [CODE_FILE, 'tests/a.test.ts'], cwd);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    expect(out.reason).toContain('a.ts');
    expect(out.reason).not.toContain('a.test.ts'); // the repo's own test file is still exempt
  });

  // 라이브 실측: 문서만 고친 턴에 README.md·agents/*.md·skills/*.md 5개를 두고
  // "테스트되지 않은 변경 파일"로 차단했다. 해소할 방법이 없어 escape로만 끝난다.
  test('문서만 바뀐 턴은 발동하지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, ['README.md', 'docs/GUIDE.md'], cwd);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.reason ?? '').not.toContain('No test result covers the changed code');
    expect(out.reason ?? '').not.toContain('테스트되지 않은 변경 파일');
  });

  test('문서와 코드가 섞이면 코드만 요구한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, ['README.md', CODE_FILE], cwd);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('No test result covers the changed code');
    expect(out.reason).toContain(CODE_FILE);
    expect(out.reason).not.toContain('README.md');
  });

  test('편집이 없으면 게이트가 발동하지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [], cwd);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('GOODBOY_TEST_GATE=off 면 게이트를 건너뛴다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);

    const out = await runStop(tmp, cwd, sessionId, { GOODBOY_TEST_GATE: 'off' });
    // 테스트 게이트는 건너뛰고 리뷰 게이트가 대신 막는다 — 사유가 테스트 사유면 안 된다.
    expect(out.reason ?? '').not.toContain('No test result covers the changed code');
  });

  test('모든 조건을 만족하면 통과하고 테스트 커서가 전진한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [goodAcceptance()],
    });
    writePassingReview(cwd, [resolve(cwd, CODE_FILE)]);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
    expect(existsSync(testCursorPath(tmp, sessionId, cwd))).toBe(true);
  });

  test('변경 파일을 커버하지 않으면 BLOCK', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE, 'src/b.ts'], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, { testedFiles: [resolve(cwd, CODE_FILE)], testFiles: [tf] });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('테스트되지 않은 변경 파일');
  });

  test('스위트가 실패하면 BLOCK', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 2, output: '2 fail' }],
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('unit(2건 실패)');
  });

  test('test_files가 실재하지 않으면 BLOCK — 임시 프로브를 테스트로 위장한 경우', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: ['/nowhere/probe.test.ts'],
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('존재하지 않습니다');
  });

  test('red 증거가 성공(exit 0)이면 BLOCK — 되돌려도 통과하는 테스트는 무효', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [goodAcceptance({ red: { command: 'bun test', output: 'ok', exit_code: 0 } })],
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('테스트 증거가 불충분합니다');
  });

  test('UI 기준에 뮤테이션 프로브가 없으면 BLOCK', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [goodAcceptance({ id: 'PT-STRUCT' })],
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('뮤테이션 프로브가 없습니다');
  });

  test('가짜 테스트 패턴(waitForTimeout)이 있으면 BLOCK', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts', 'await page.waitForTimeout(3000);');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [goodAcceptance()],
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('아무것도 검증하지 않는 테스트 패턴');
  });

  test('dev-cycle 수용 기준이 미커버면 BLOCK', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    // dev-cycle 산출물: 신규 화면 1건이 확정돼 있다.
    mkdirSync(join(cwd, 'docs', 'versions', 'v0.1'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'CYCLE.md'), '- **현재 버전**: v0.1\n', 'utf8');
    writeFileSync(
      join(cwd, 'docs', 'versions', 'v0.1', 'UIUX.md'),
      '## 화면 목록\n\n| 화면 | 구분 |\n|---|---|\n| 설정 | 신규 |\n',
      'utf8',
    );
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [goodAcceptance()], // AC-1만 커버 — UIUX-NEW-1 누락
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('UIUX-NEW-1');
  });

  // (I11, #20) Before the verification stage a UI criterion is pending: its screen may have no
  //   product code yet. From stage 6 (and at 완료) it blocks; an unknown stage blocks too. The
  //   stage pinned at the session's start counts as well: setting it back relaxes nothing.
  test.each([
    ['5', 5, false],
    ['3', 3, false],
    ['5', 6, true], // set back from 6 to 5 during the session
    ['5', undefined, true], // no stage in the pin (an older pin)
    ['6', 6, true],
    ['완료', 'done', true],
    ['', null, true],
  ])('UI criteria at stage "%s" (pinned %p): block = %p', async (stage, pinned, blocks) => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const pin = { top: cwd, rows: null, policy: null, ...(pinned === undefined ? {} : { stage: pinned }) };
    writeFileSync(join(tmp, `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`, 'criteria-pin.json'), JSON.stringify(pin), 'utf8');
    mkdirSync(join(cwd, 'docs', 'versions', 'v0.1'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'CYCLE.md'), `- **현재 버전**: v0.1\n- **현재 단계**: ${stage}\n`, 'utf8');
    writeFileSync(
      join(cwd, 'docs', 'versions', 'v0.1', 'UIUX.md'),
      '## 화면 목록\n\n| 화면 | 구분 |\n|---|---|\n| 설정 | 신규 |\n',
      'utf8',
    );
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, { testedFiles: [resolve(cwd, CODE_FILE)], testFiles: [tf], acceptance: [goodAcceptance()] });

    const out = await runStop(tmp, cwd, sessionId);
    const blockedForUi = out.decision === 'block' && String(out.reason).includes('UIUX-NEW-1');
    expect(blockedForUi).toBe(blocks);
    if (!blocks) expect(JSON.stringify(out)).toContain('UIUX-NEW-1');
  });

  test('acceptance가 비면 BLOCK — red-green 전체를 건너뛰는 우회 (라이브 실측)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    // 스위트는 전부 통과하고 파일도 실재하지만, 무엇을 검증했는지가 없다.
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [],
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('acceptance가 비어 있습니다');
  });

  test('테스트 결과 JSON 자체는 리뷰/테스트 대상이 되지 않는다 (자기참조 순환 방지)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    // .claude/tests/ 안의 파일만 편집된 상태 — 게이트가 이걸 "변경"으로 보면
    // 결과를 쓸 때마다 다시 차단되는 순환이 된다(라이브 실측).
    mkdirSync(join(cwd, '.claude', 'tests'), { recursive: true });
    seedSession(tmp, sessionId, 3, ['.claude/tests/20260904-015156.json'], cwd);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('stop_hook_active 경로에서 수락하면 커서를 전진시키고 층2까지 이어간다', async () => {
    // 표준 경로("차단 → 테스트 실행 → 턴 종료")의 종료는 항상 stop_hook_active=true다.
    // 여기서 수락하지 않으면 결과가 검증되지 않은 채 세션이 끝난다(라이브 실측).
    //
    // 그리고 수락에서 **멈추면 안 된다**: 라이브 실측(P14)에서 테스트는 red-green까지
    // 제대로 했는데 리뷰는 gate-log에 흔적조차 없이 세션이 끝났다 — 층1만 만족시키면
    // 층2를 통째로 건너뛸 수 있었다. 수락 = 직전 차단 해소이므로 다음 층으로 넘어간다.
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [goodAcceptance()],
    });

    const proc = Bun.spawn(['bun', STOP_HOOK], {
      cwd,
      env: { ...process.env, TMPDIR: tmp, HOME: tmp },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          hook_event_name: 'Stop',
          stop_hook_active: true,
        }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as StopOut;
    await proc.exited;
    expect(existsSync(testCursorPath(tmp, sessionId, cwd))).toBe(true); // 커서 전진
    // 층1은 통과했고(테스트 사유가 아니고), 층2가 리뷰를 요구한다.
    expect(out.reason ?? '').not.toContain('No test result covers the changed code');
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('Review is required');
  });

  test('stop_hook_active 경로에서 조건 미달이면 수락하지 않는다 (차단도 안 함)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const tf = makeTestFile(cwd, 'tests/a.test.ts');
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [tf],
      acceptance: [], // 증거 없음 → 수락 보류
    });

    const proc = Bun.spawn(['bun', STOP_HOOK], {
      cwd,
      env: { ...process.env, TMPDIR: tmp, HOME: tmp },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          session_id: sessionId,
          cwd,
          hook_event_name: 'Stop',
          stop_hook_active: true,
        }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as StopOut;
    await proc.exited;
    expect(out.decision).toBeUndefined();
    expect(existsSync(testCursorPath(tmp, sessionId, cwd))).toBe(false);
  });

  // Round 3: the accept takes its criteria from the Stop's one dev-cycle reading. No test
  //   noticed when that check was dropped (mutant M109).
  test('stop_hook_active: a result that leaves a dev-cycle criterion uncovered is not accepted', async () => {
    const accepted = async (acceptance: Array<Record<string, unknown>>): Promise<boolean> => {
      const { tmp, cwd, sessionId } = newSandbox();
      seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
      mkdirSync(join(cwd, 'docs', 'versions', 'v0.1'), { recursive: true });
      writeFileSync(join(cwd, 'docs', 'CYCLE.md'), '- **현재 버전**: v0.1\n', 'utf8');
      writeFileSync(
        join(cwd, 'docs', 'versions', 'v0.1', 'UIUX.md'),
        '## 화면 목록\n\n| 화면 | 구분 |\n|---|---|\n| 설정 | 신규 |\n',
        'utf8',
      );
      const tf = makeTestFile(cwd, 'tests/a.test.ts');
      writeTestResult(cwd, { testedFiles: [resolve(cwd, CODE_FILE)], testFiles: [tf], acceptance });
      const proc = Bun.spawn(['bun', STOP_HOOK], {
        cwd,
        env: { ...process.env, TMPDIR: tmp, HOME: tmp },
        stdin: new TextEncoder().encode(
          JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop', stop_hook_active: true }),
        ),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await new Response(proc.stdout).text();
      await proc.exited;
      return existsSync(testCursorPath(tmp, sessionId, cwd));
    };
    expect(await accepted([goodAcceptance()])).toBe(false); // UIUX-NEW-1 uncovered
    const screen = goodAcceptance({
      id: 'UIUX-NEW-1',
      description: '설정 화면',
      // A UI criterion needs one, naming the product file it broke (I2).
      mutation: { command: 'remove the settings route', output: '1 failed', detected: true, file: CODE_FILE },
    });
    expect(await accepted([goodAcceptance(), screen])).toBe(true);
  }, 30_000);

  // Track G: no count-based escape. The gate blocks on every full Stop until its evidence is
  //   there; from the 2nd block on, the user is told how to override it.
  test('no retry cap: the 3rd Stop still blocks; from the 2nd the user sees the marker and GOODBOY_TEST_GATE=off', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const touch = `! touch ${approvalMarkerRelPath('stop', sessionId)}`;

    const first = await runStop(tmp, cwd, sessionId);
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('No test result covers the changed code');
    expect(first.reason).toContain('(block 1)');
    expect(first.reason).toContain('only the user can let this Stop pass');
    expect(first.reason).not.toContain('재시도');
    expect(first.systemMessage ?? '').not.toContain(touch);

    const second = await runStop(tmp, cwd, sessionId);
    expect(second.decision).toBe('block');
    expect(second.reason).toContain('(block 2)');
    expect(second.systemMessage ?? '').toContain(touch);
    expect(second.systemMessage ?? '').toContain('GOODBOY_TEST_GATE=off');

    const third = await runStop(tmp, cwd, sessionId);
    expect(third.decision).toBe('block');
    expect(third.reason).toContain('No test result covers the changed code');
    expect(third.reason).toContain('(block 3)');
    expect(existsSync(testCursorPath(tmp, sessionId, cwd))).toBe(false);
  });

  test("the user's Stop marker passes the test gate once and moves the test cursor", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    const marker = approveStop(cwd, sessionId);

    // The test gate passes and its cursor moves. The review gate may still block with its
    // own reason, so this is judged by the reason, not the decision.
    const passed = await runStop(tmp, cwd, sessionId);
    expect(passed.reason ?? '').not.toContain('No test result covers the changed code');
    expect(passed.systemMessage ?? '').toContain('사용자 승인 마커로 이번 턴의');
    expect(passed.systemMessage ?? '').toContain('이번 턴의 test 게이트');
    expect(existsSync(testCursorPath(tmp, sessionId, cwd))).toBe(true);
    expect(existsSync(marker)).toBe(false); // used once

    // The edit is still untested: the next Stop blocks again, counting from 1.
    const next = await runStop(tmp, cwd, sessionId);
    expect(next.decision).toBe('block');
    expect(next.reason).toContain('No test result covers the changed code');
    expect(next.reason).toContain('(block 1)');
  });

  // Track G: tests that cannot run here end the turn as unverified, on evidence only.
  test('an evidence-backed blocked result covering the changed files passes: cursor moves, the user is told', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [],
      suites: [],
      verdict: 'blocked',
      blocked: {
        reason: 'no test runner is installed in this repo',
        evidence: [{ command: 'bun test', output: 'bun: command not found', exit_code: 127 }],
      },
    });
    writePassingReview(cwd, [resolve(cwd, CODE_FILE)]);

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.reason ?? '').not.toContain('(테스트 게이트)'); // layer 1 did not block
    expect(out.systemMessage ?? '').toContain('테스트를 실행하지 못해');
    expect(out.systemMessage ?? '').toContain('no test runner is installed in this repo');
    expect(existsSync(testCursorPath(tmp, sessionId, cwd))).toBe(true);
  });

  test('a blocked result next to a run that failed blocks: unverified only when what ran passed (refactoring review)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    const OTHER = 'src/other.ts';
    seedSession(tmp, sessionId, 3, [CODE_FILE, OTHER], cwd);
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [],
      suites: [],
      verdict: 'blocked',
      blocked: { reason: 'the e2e browser cannot start here', evidence: [{ command: 'npx playwright test', output: 'browserType.launch: Executable does not exist' }] },
    });
    const testFile = join(cwd, 'tests', 'other.test.ts');
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, 'test("o", () => {});\n');
    writeFileSync(
      join(cwd, '.claude', 'tests', 'unit.json'),
      JSON.stringify({
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        tested_files: [resolve(cwd, OTHER)],
        category: 'add-feature',
        test_files: [testFile],
        environment: { mode: 'local' },
        suites: [{ name: 'unit', command: 'bun test', passed: 2, failed: 1, output: '2 pass 1 fail' }],
        acceptance: [],
        verdict: 'needs-changes',
      }),
    );
    writePassingReview(cwd, [resolve(cwd, CODE_FILE), resolve(cwd, OTHER)]);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('실패한 테스트 스위트');
    expect(out.systemMessage ?? '').not.toContain('테스트를 실행하지 못해');
  });

  test('a blocked result without evidence still blocks', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 3, [CODE_FILE], cwd);
    writeTestResult(cwd, {
      testedFiles: [resolve(cwd, CODE_FILE)],
      testFiles: [],
      suites: [],
      verdict: 'blocked',
      blocked: { reason: 'no test runner is installed in this repo', evidence: [] },
    });

    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('blocked.evidence');
    expect(out.reason).toContain('(테스트 게이트)');
    expect(out.reason).toContain('(block 1)');
    expect(out.systemMessage ?? '').not.toContain('테스트를 실행하지 못해');
    expect(existsSync(testCursorPath(tmp, sessionId, cwd))).toBe(false);
  });
});

// 기본값 `auto`의 판정. 무조건 켜 두면 테스트를 돌릴 수단이 없는 저장소에서 3회 차단 후
// escape로 끝난다 — 아무것도 검증하지 못하면서 경고만 남는, 게이트의 최악 결말이다.
// (라이브 실측) 그래서 "수단이 있는가"를 먼저 보고, 없으면 조용히 끄되 1회 알린다.
describe('Stop hook — 층1 테스트 게이트 활성 판정 (auto)', () => {
  /** auto 기본값으로 실행 — GOODBOY_TEST_GATE를 넘기지 않는다. */
  async function runAuto(tmp: string, cwd: string, sessionId: string): Promise<StopOut> {
    const proc = Bun.spawn(['bun', STOP_HOOK], {
      cwd,
      env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'auto' },
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

  test('테스트 인프라가 없으면 차단하지 않고 1회 안내만 한다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);

    // 층1을 지나 층2(리뷰)에서 막히는 것은 정상 — 층1이 막지 않았음만 본다.
    const out = await runAuto(tmp, cwd, sessionId);
    expect(out.reason ?? '').not.toContain('No test result covers the changed code');
    expect(out.systemMessage ?? '').toContain('테스트 게이트가 이 저장소에서 비활성');
    // Track L (L4): the notice names the backfill command.
    expect(out.systemMessage ?? '').toContain('/goodboy:backfill-tests');
  });

  test('같은 세션에서 안내는 반복하지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);

    await runAuto(tmp, cwd, sessionId);
    const second = await runAuto(tmp, cwd, sessionId);
    expect(second.systemMessage ?? '').not.toContain('테스트 게이트가 이 저장소에서 비활성');
  });

  test('tests/ 디렉터리가 있으면 켜진다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    mkdirSync(join(cwd, 'tests'), { recursive: true });

    const out = await runAuto(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('No test result covers the changed code');
  });

  test('package.json scripts.test 가 있으면 켜진다 (npm 자리표시자는 제외)', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      'utf8',
    );
    expect((await runAuto(tmp, cwd, sessionId)).reason ?? '').not.toContain('No test result covers the changed code');

    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'bun test' } }),
      'utf8',
    );
    expect((await runAuto(tmp, cwd, sessionId)).decision).toBe('block');
  });

  test('dev-cycle 산출물이 있으면 인프라가 없어도 켜진다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);
    mkdirSync(join(cwd, 'docs', 'versions', 'v0.1'), { recursive: true });
    // The key in bold, as dev-cycle writes it. Without the bold the documents were never
    //   recognized, and the block this test saw came from the review gate (round-3 closing
    //   refactoring review).
    writeFileSync(join(cwd, 'docs', 'CYCLE.md'), '# 사이클\n\n- **현재 버전**: v0.1\n', 'utf8');

    const out = await runAuto(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('테스트 게이트'); // layer 1, not the review gate
  });

  test('off 는 안내도 하지 않는다', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['src/a.ts'], cwd);

    const out = await runStop(tmp, cwd, sessionId, { GOODBOY_TEST_GATE: 'off' });
    expect(out.reason ?? '').not.toContain('No test result covers the changed code');
    expect(out.systemMessage ?? '').not.toContain('테스트 게이트가 이 저장소에서 비활성');
  });
});
