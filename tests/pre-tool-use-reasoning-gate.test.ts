import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // escape 카운터 등 세션 상태 디렉터리도 함께 정리 (sessionIdFor 참조).
    try {
      rmSync(join(tmpdir(), `goodboy-session-${basename(d)}`), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** 테스트별 고유 세션 ID — escape 카운터(reasoning-deny-count.txt)가 세션 단위로
 *  누적되므로, 세션을 공유하면 deny 테스트들이 서로 오염되어 비결정적이 된다. */
function sessionIdFor(cwd: string): string {
  return basename(cwd);
}

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
async function runHook(
  cwd: string,
  transcriptPath: string | null,
  opts?: { agentId?: string; fileName?: string },
): Promise<string> {
  const payload = JSON.stringify({
    session_id: sessionIdFor(cwd),
    cwd,
    transcript_path: transcriptPath ?? '',
    ...(opts?.agentId ? { agent_id: opts.agentId } : {}),
    tool_name: 'Write',
    tool_input: { file_path: join(cwd, opts?.fileName ?? 'newfile.ts'), content: 'x' },
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

  test('stale reasoning OUTSIDE the window (6 back) => block', async () => {
    const cwd = makeCwd();
    // 추론은 6번째 전 메시지 → window(기본 N=5, v0.26.1에서 3→5) 밖이므로 차단되어야 한다.
    const tp = makeTranscript(cwd, [REASONING_TEXT, 'a', 'b', 'c', 'd', 'e']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(true);
  });

  test('reasoning 4 back is INSIDE the widened window (N=5) => allow (v0.26.1)', async () => {
    const cwd = makeCwd();
    // v0.26.0까지는 window=3이라 차단됐던 케이스 — 지연 하니스 대응으로 5로 확장.
    const tp = makeTranscript(cwd, [REASONING_TEXT, 'a', 'b', 'c']);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(false);
  });

  test('GOODBOY_REASONING_WINDOW로 윈도우 조정 가능', async () => {
    const prev = process.env.GOODBOY_REASONING_WINDOW;
    process.env.GOODBOY_REASONING_WINDOW = '2';
    try {
      const cwd = makeCwd();
      const tp = makeTranscript(cwd, [REASONING_TEXT, 'a', 'b']);
      const out = await runHook(cwd, tp);
      expect(isBlocked(out)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GOODBOY_REASONING_WINDOW;
      else process.env.GOODBOY_REASONING_WINDOW = prev;
    }
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

describe('pre-tool-use reasoning gate — 무언 편집 차단 (라이브 검증 발견)', () => {
  /** thinking/tool_use만 있고 text 블록이 없는 assistant 줄 — 실전에서 관측된 형태. */
  function silentAssistantLine(): string {
    return JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: '파일을 만들어야겠다' }],
      },
    });
  }

  test('assistant 메시지가 thinking만 있고 텍스트가 없으면 => block (무언 편집)', async () => {
    const cwd = makeCwd();
    const path = join(cwd, 'transcript.jsonl');
    writeFileSync(path, silentAssistantLine() + '\n', 'utf8');
    const out = await runHook(cwd, path);
    expect(isBlocked(out)).toBe(true);
    expect(out).toContain('무언 편집');
  });

  test('thinking-only 뒤에 추론 텍스트가 있으면 => allow', async () => {
    const cwd = makeCwd();
    const path = join(cwd, 'transcript.jsonl');
    const textLine = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: REASONING_TEXT }] },
    });
    writeFileSync(path, silentAssistantLine() + '\n' + textLine + '\n', 'utf8');
    const out = await runHook(cwd, path);
    expect(isBlocked(out)).toBe(false);
  });

  test('assistant 메시지가 아예 없으면(파싱 실패/신규) => allow (fail-open 유지)', async () => {
    const cwd = makeCwd();
    const path = join(cwd, 'transcript.jsonl');
    writeFileSync(
      path,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      'utf8',
    );
    const out = await runHook(cwd, path);
    expect(isBlocked(out)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v0.26.1 — 텍스트 플러시 지연 fail-open + escape 카운터 (결함 I)
//   실측: 일부 하니스는 assistant 텍스트 블록 기록이 수십 초~수 분 지연되어
//   (thinking/tool_use는 즉시 기록) 게이트가 옛 텍스트만 보고 영구 차단됐다.
// ---------------------------------------------------------------------------

/** thinking만 있는(텍스트 없는) assistant 줄 — 지연 하니스에서 즉시 기록되는 형태. */
function thinkingOnlyLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
  });
}

/** 텍스트 엔트리 1개(추론 없음) 뒤에 thinking-only 엔트리 n개가 붙은 지연형 transcript. */
function makeLaggedTranscript(cwd: string, lagEntries: number): string {
  const path = join(cwd, 'transcript.jsonl');
  const lines = [assistantLine('추론 섹션이 없는 옛 텍스트')];
  for (let i = 0; i < lagEntries; i++) lines.push(thinkingOnlyLine());
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

describe('pre-tool-use reasoning gate — 텍스트 플러시 지연 fail-open (v0.26.1)', () => {
  test('마지막 텍스트 뒤 assistant 엔트리 8개(기본 임계) => allow (fail-open)', async () => {
    const cwd = makeCwd();
    const tp = makeLaggedTranscript(cwd, 8);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(false);
  });

  test('임계 미만(7개)이면 지연으로 보지 않고 정상 판정 => block', async () => {
    const cwd = makeCwd();
    const tp = makeLaggedTranscript(cwd, 7);
    const out = await runHook(cwd, tp);
    expect(isBlocked(out)).toBe(true);
  });

  test('GOODBOY_REASONING_LAG_ENTRIES로 임계 조정 가능', async () => {
    const prev = process.env.GOODBOY_REASONING_LAG_ENTRIES;
    process.env.GOODBOY_REASONING_LAG_ENTRIES = '4';
    try {
      const cwd = makeCwd();
      const tp = makeLaggedTranscript(cwd, 4);
      const out = await runHook(cwd, tp);
      expect(isBlocked(out)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GOODBOY_REASONING_LAG_ENTRIES;
      else process.env.GOODBOY_REASONING_LAG_ENTRIES = prev;
    }
  });
});

describe('pre-tool-use reasoning gate — escape 카운터 (v0.26.1, 탈출구 없는 게이트 금지)', () => {
  test('섹션 미인식 deny 3회째에는 경고와 함께 통과 → sticky 지연 모드 (v0.26.3)', async () => {
    const cwd = makeCwd();
    // 지연 아님(텍스트만 존재) + 추론 섹션 없음 → 정상 deny 경로.
    const tp = makeTranscript(cwd, ['추론 없는 텍스트']);

    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);
    expect(first).toContain('재시도 1/3');

    const second = await runHook(cwd, tp);
    expect(isBlocked(second)).toBe(true);
    expect(second).toContain('재시도 2/3');

    const third = await runHook(cwd, tp);
    expect(isBlocked(third)).toBe(false);
    expect(third).toContain('3회 차단 후에도');

    // v0.26.2까지는 여기서 카운터가 리셋되어 4회째가 다시 1/3부터 차단됐다 —
    // 플러시 지연이 지속되는 동안 편집마다 deny 2회 + escape 1회가 반복(실측).
    // 이제는 지연 모드가 유지되어 인식될 때까지 차단 없이 경고만 나온다.
    const fourth = await runHook(cwd, tp);
    expect(isBlocked(fourth)).toBe(false);
    expect(fourth).toContain('지연 모드');

    const fifth = await runHook(cwd, tp);
    expect(isBlocked(fifth)).toBe(false);
  });

  test('sticky 기본값: 인식 성공 후에도 지연 모드 유지 — 이후 미인식은 경고만 (v0.27.0)', async () => {
    const cwd = makeCwd();
    const noReason = makeTranscript(cwd, ['추론 없는 텍스트']);
    // 3회 미인식 → 지연 모드 진입.
    for (let i = 0; i < 3; i++) await runHook(cwd, noReason);

    // 섹션 인식 성공 → 카운터 리셋, 정상 통과. 단 지연 모드는 유지(sticky).
    const okPath = join(cwd, 'ok.jsonl');
    writeFileSync(okPath, assistantLine(REASONING_TEXT) + '\n', 'utf8');
    const ok = await runHook(cwd, okPath);
    expect(isBlocked(ok)).toBe(false);
    expect(ok).toBe('{}');

    // v0.26.9까지는 여기서 재무장되어 다시 1/3부터 차단됐다 — 지연이 상존하는
    // 세션에서 편집 배치마다 헛 차단 1~2회가 반복(실사용 보고). 이제 경고만 낸다.
    const after = await runHook(cwd, noReason);
    expect(isBlocked(after)).toBe(false);
    expect(after).toContain('지연 모드');
  });

  test('GOODBOY_REASONING_LAG_STICKY=rearm: 인식 성공 시 재무장 — 이후 미인식은 1/3부터 deny', async () => {
    const prev = process.env.GOODBOY_REASONING_LAG_STICKY;
    process.env.GOODBOY_REASONING_LAG_STICKY = 'rearm';
    try {
      const cwd = makeCwd();
      const noReason = makeTranscript(cwd, ['추론 없는 텍스트']);
      for (let i = 0; i < 3; i++) await runHook(cwd, noReason); // 지연 모드 진입
      const lagged = await runHook(cwd, noReason);
      expect(isBlocked(lagged)).toBe(false);
      expect(lagged).toContain('지연 모드');

      // 섹션 인식 → 재무장(구 동작 옵트인).
      const okPath = join(cwd, 'ok.jsonl');
      writeFileSync(okPath, assistantLine(REASONING_TEXT) + '\n', 'utf8');
      const ok = await runHook(cwd, okPath);
      expect(isBlocked(ok)).toBe(false);

      const rearmed = await runHook(cwd, noReason);
      expect(isBlocked(rearmed)).toBe(true);
      expect(rearmed).toContain('재시도 1/3');
    } finally {
      if (prev === undefined) delete process.env.GOODBOY_REASONING_LAG_STICKY;
      else process.env.GOODBOY_REASONING_LAG_STICKY = prev;
    }
  });

  test('문서 파일(.md) 편집은 추론 게이트 면제 (v0.27.0)', async () => {
    const cwd = makeCwd();
    const noReason = makeTranscript(cwd, ['추론 없는 텍스트']);
    const out = await runHook(cwd, noReason, { fileName: 'notes.md' });
    expect(isBlocked(out)).toBe(false);
    expect(out).toBe('{}');
  });

  test('GOODBOY_REASONING_DOC_EXEMPT=off면 문서 파일도 게이트 적용', async () => {
    const prev = process.env.GOODBOY_REASONING_DOC_EXEMPT;
    process.env.GOODBOY_REASONING_DOC_EXEMPT = 'off';
    try {
      const cwd = makeCwd();
      const noReason = makeTranscript(cwd, ['추론 없는 텍스트']);
      const out = await runHook(cwd, noReason, { fileName: 'notes.md' });
      expect(isBlocked(out)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GOODBOY_REASONING_DOC_EXEMPT;
      else process.env.GOODBOY_REASONING_DOC_EXEMPT = prev;
    }
  });

  test('서브에이전트 지연 모드가 메인 게이트를 무장해제하지 않는다 (v0.26.4)', async () => {
    const cwd = makeCwd();
    const mainTp = makeTranscript(cwd, ['추론 없는 메인 텍스트']);
    // 서브에이전트 전용 transcript 레이아웃: <base>/subagents/agent-<id>.jsonl
    const subDir = join(cwd, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-sub1.jsonl'),
      assistantLine('추론 없는 서브 텍스트') + '\n',
      'utf8',
    );

    // 서브 3회 미인식 → 서브 스코프만 지연 모드 진입.
    for (let i = 0; i < 3; i++) await runHook(cwd, mainTp, { agentId: 'sub1' });
    const subLagged = await runHook(cwd, mainTp, { agentId: 'sub1' });
    expect(isBlocked(subLagged)).toBe(false);
    expect(subLagged).toContain('지연 모드');

    // 메인은 여전히 1/3부터 차단되어야 한다 (스코프 미분리 시 경고만으로 통과해버린다).
    const main = await runHook(cwd, mainTp);
    expect(isBlocked(main)).toBe(true);
    expect(main).toContain('재시도 1/3');
  });

  test('메인의 섹션 인식이 서브에이전트 지연 모드를 해제하지 않는다 (v0.26.4)', async () => {
    const cwd = makeCwd();
    const mainNoReason = makeTranscript(cwd, ['추론 없는 메인 텍스트']);
    const subDir = join(cwd, 'transcript', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'agent-sub2.jsonl'),
      assistantLine('추론 없는 서브 텍스트') + '\n',
      'utf8',
    );

    // 서브 3회 미인식 → 서브 스코프 지연 모드 진입.
    for (let i = 0; i < 3; i++) await runHook(cwd, mainNoReason, { agentId: 'sub2' });

    // 메인이 추론 섹션을 인식하며 통과 — 재무장은 main 스코프에만 적용되어야 한다.
    const okPath = join(cwd, 'ok.jsonl');
    writeFileSync(okPath, assistantLine(REASONING_TEXT) + '\n', 'utf8');
    const mainOk = await runHook(cwd, okPath);
    expect(isBlocked(mainOk)).toBe(false);

    // 서브는 여전히 지연 모드(차단 없이 경고만) — 스코프 미분리 시 1/3부터 사이클 재진입했다.
    const sub = await runHook(cwd, mainNoReason, { agentId: 'sub2' });
    expect(isBlocked(sub)).toBe(false);
    expect(sub).toContain('지연 모드');
  });

  test('무언 편집 deny도 escape 카운터 공유 — 3회 후 지연 모드 (v0.26.3)', async () => {
    const cwd = makeCwd();
    const path = join(cwd, 'transcript.jsonl');
    const silent = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
    });
    writeFileSync(path, silent + '\n', 'utf8');

    const first = await runHook(cwd, path);
    expect(isBlocked(first)).toBe(true);
    expect(first).toContain('무언 편집');
    expect(first).toContain('재시도 1/3');

    const second = await runHook(cwd, path);
    expect(isBlocked(second)).toBe(true);
    expect(second).toContain('재시도 2/3');

    // v0.26.2까지는 무언 편집 deny에 escape가 없어 무한 차단 가능성이 있었다.
    const third = await runHook(cwd, path);
    expect(isBlocked(third)).toBe(false);

    const fourth = await runHook(cwd, path);
    expect(isBlocked(fourth)).toBe(false);
  });

  test('섹션 인식 성공 시 카운터 리셋 — 이후 deny는 1/3부터', async () => {
    const cwd = makeCwd();
    const noReason = makeTranscript(cwd, ['추론 없는 텍스트']);

    const d1 = await runHook(cwd, noReason);
    expect(isBlocked(d1)).toBe(true);
    expect(d1).toContain('재시도 1/3');
    const d2 = await runHook(cwd, noReason);
    expect(isBlocked(d2)).toBe(true);
    expect(d2).toContain('재시도 2/3');

    // 섹션 인식 성공 → 리셋.
    const okPath = join(cwd, 'ok.jsonl');
    writeFileSync(okPath, assistantLine(REASONING_TEXT) + '\n', 'utf8');
    const ok = await runHook(cwd, okPath);
    expect(isBlocked(ok)).toBe(false);

    // 다시 미인식 → 3회째가 아니라 1/3부터 시작해야 한다.
    const d3 = await runHook(cwd, noReason);
    expect(isBlocked(d3)).toBe(true);
    expect(d3).toContain('재시도 1/3');
  });
});
