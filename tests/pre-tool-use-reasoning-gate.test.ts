import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
  }
});

const REASONING_TEXT = [
  '## 추론',
  '### 사실',
  '- 파일이 존재한다',
  '### 추론',
  '- 이 함수를 고쳐야 한다',
  '### 가정',
  '- 입력은 항상 문자열',
  '### 추측',
  '- ⚠️ 아마 캐시 문제일 것',
].join('\n');

/** assistant message 한 줄(JSONL) 생성 */
function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

/** transcript 파일을 만들고 경로 반환 */
function makeTranscript(cwd: string, texts: string[]): string {
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(path, texts.map(assistantLine).join('\n') + '\n', 'utf8');
  return path;
}

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-ptu-reason-'));
  tmpDirs.push(cwd);
  return cwd;
}

/** Write(새 파일)로 hook 실행 → read-before-edit는 통과하고 추론 게이트만 평가됨. */
async function runHook(cwd: string, transcriptPath: string | null): Promise<string> {
  const payload = JSON.stringify({
    session_id: 'test',
    cwd,
    transcript_path: transcriptPath ?? '',
    tool_name: 'Write',
    tool_input: { file_path: join(cwd, 'newfile.ts'), content: 'x' },
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

describe('pre-tool-use reasoning gate (recent-window)', () => {
  test('reasoning in the LAST assistant message => allow', async () => {
    const cwd = makeCwd();
    const tp = makeTranscript(cwd, ['이전 작업', REASONING_TEXT]);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(false);
    expect(out).toBe('{}');
  });

  test('reasoning in 2nd-to-last with trailing "now editing" message => allow (the bug fix)', async () => {
    const cwd = makeCwd();
    // 추론 섹션 다음에 도구 호출 직전 "이제 수정하겠습니다" 메시지가 한 줄 더 옴.
    const tp = makeTranscript(cwd, [REASONING_TEXT, '이제 파일을 수정하겠습니다']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(false);
    expect(out).toBe('{}');
  });

  test('reasoning 3 messages back (within window N=3) => allow', async () => {
    const cwd = makeCwd();
    const tp = makeTranscript(cwd, [REASONING_TEXT, '중간 메시지', '이제 수정하겠습니다']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(false);
  });

  test('no reasoning in any of the last N messages => block', async () => {
    const cwd = makeCwd();
    const tp = makeTranscript(cwd, ['첫 메시지', '둘째 메시지', '셋째 메시지', '넷째 메시지']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(true);
  });

  test('stale reasoning OUTSIDE the window (4 back) => block', async () => {
    const cwd = makeCwd();
    // 추론은 4번째 전 메시지 → window(N=3) 밖이므로 차단되어야 한다.
    const tp = makeTranscript(cwd, [REASONING_TEXT, 'a', 'b', 'c']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(true);
  });

  test('unparseable / missing transcript => allow (fail-open)', async () => {
    const cwd = makeCwd();
    const out = await runHook(cwd, join(cwd, 'does-not-exist.jsonl'));
    expect(isBlocked(out)).toBe(false);
    expect(out).toBe('{}');
  });

  test('garbage (non-JSON) transcript lines => allow (fail-open)', async () => {
    const cwd = makeCwd();
    const path = join(cwd, 'garbage.jsonl');
    writeFileSync(path, 'not json\n{{{broken\n', 'utf8');
    const out = await runHook(cwd, path);
    expect(isBlocked(out)).toBe(false);
  });
});

describe('pre-tool-use reasoning gate — 실질 검사 (A1)', () => {
  test('제목만 있는 빈 추론 섹션 => block (시늉 추론 차단)', async () => {
    const cwd = makeCwd();
    const tp = makeTranscript(cwd, ['## 추론']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(true);
    expect(out).toContain('비어');
  });

  test('서브헤딩만 있고 항목이 없는 섹션 => block', async () => {
    const cwd = makeCwd();
    const empty = ['## 추론', '### 사실', '### 추론', '### 가정', '### 추측'].join('\n');
    const tp = makeTranscript(cwd, [empty]);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(true);
  });

  test('한 분류라도 실제 항목이 있으면 => allow', async () => {
    const cwd = makeCwd();
    const minimal = ['## 추론', '### 사실', '- 대상 파일을 Read로 확인함'].join('\n');
    const tp = makeTranscript(cwd, [minimal]);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(false);
  });

  test('빈 섹션 + 윈도우 내 다른 메시지에 내용 있는 섹션 => allow (ANY 규칙)', async () => {
    const cwd = makeCwd();
    const tp = makeTranscript(cwd, [REASONING_TEXT, '## 추론']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(false);
  });
});
