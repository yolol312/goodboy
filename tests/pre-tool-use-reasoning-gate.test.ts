import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  opts?: { agentId?: string; fileName?: string; env?: Record<string, string> },
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
    env: {
      ...process.env,
      GOODBOY_DISABLE_DELEGATION: '1',
      // 재시도 플러시 대기(v0.27.7)는 테스트에서 기본 비활성 — deny 반복 테스트가
      // 대기로 느려지지 않게 한다. 대기 동작 자체는 전용 테스트가 opts.env로 켠다.
      GOODBOY_REASONING_FLUSH_WAIT_MS: '0',
      ...(opts?.env ?? {}),
    },
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

  test('지연 확정(v0.27.4): deny 이전에 생성된 추론 텍스트가 재시도에서 인식되면 즉시 지연 모드', async () => {
    const cwd = makeCwd();
    const tp = join(cwd, 'transcript.jsonl');
    // 1) 추론 없는 텍스트만 → deny 1/3 (실사용 재현: 모델은 이미 ## 추론을 출력했지만
    //    아직 transcript에 플러시되지 않은 상태).
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n', 'utf8');
    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);
    expect(first).toContain('재시도 1/3');

    // 2) deny **이전**에 생성된(timestamp가 과거) 추론 텍스트가 뒤늦게 플러시됨.
    const before = new Date(Date.now() - 60_000).toISOString();
    const laggedLine = JSON.stringify({
      type: 'assistant',
      timestamp: before,
      message: { role: 'assistant', content: [{ type: 'text', text: REASONING_TEXT }] },
    });
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n' + laggedLine + '\n', 'utf8');

    // 3) 같은 호출 재시도 → 통과 + 지연 확정으로 즉시 지연 모드 전환.
    const second = await runHook(cwd, tp);
    expect(isBlocked(second)).toBe(false);
    expect(second).toContain('지연 모드로 전환');

    // 4) 다음 편집(다시 미인식 상태) → escape 3회를 기다리지 않고 경고만으로 통과.
    writeFileSync(tp, assistantLine('추론 없는 다음 턴 텍스트') + '\n', 'utf8');
    const next = await runHook(cwd, tp);
    expect(isBlocked(next)).toBe(false);
    expect(next).toContain('지연 모드');
  });

  test('지연 확정 아님: deny 이후 생성된(순응) 추론 텍스트는 지연 모드로 전환하지 않는다', async () => {
    const cwd = makeCwd();
    const tp = join(cwd, 'transcript.jsonl');
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n', 'utf8');
    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);

    // deny를 보고 모델이 순응해 새로 출력한 추론 텍스트(timestamp가 deny 이후 = 미래).
    const after = new Date(Date.now() + 60_000).toISOString();
    const compliedLine = JSON.stringify({
      type: 'assistant',
      timestamp: after,
      message: { role: 'assistant', content: [{ type: 'text', text: REASONING_TEXT }] },
    });
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n' + compliedLine + '\n', 'utf8');
    const second = await runHook(cwd, tp);
    expect(isBlocked(second)).toBe(false);

    // 게이트는 무장 상태 유지 — 다음 미인식은 1/3부터 다시 차단(빠른 하니스 강도 유지).
    writeFileSync(tp, assistantLine('추론 없는 다음 턴 텍스트') + '\n', 'utf8');
    const next = await runHook(cwd, tp);
    expect(isBlocked(next)).toBe(true);
    expect(next).toContain('재시도 1/3');
  });

  test('지연 확정 fail-safe: timestamp가 없는 추론 텍스트는 지연 모드로 전환하지 않는다', async () => {
    const cwd = makeCwd();
    const tp = join(cwd, 'transcript.jsonl');
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n', 'utf8');
    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);

    // timestamp 필드 없는(구형/변형 포맷) 추론 텍스트 — 판정 불가 → 전환 안 함.
    writeFileSync(
      tp,
      assistantLine('추론 없는 텍스트') + '\n' + assistantLine(REASONING_TEXT) + '\n',
      'utf8',
    );
    const second = await runHook(cwd, tp);
    expect(isBlocked(second)).toBe(false);

    writeFileSync(tp, assistantLine('추론 없는 다음 턴 텍스트') + '\n', 'utf8');
    const next = await runHook(cwd, tp);
    expect(isBlocked(next)).toBe(true);
    expect(next).toContain('재시도 1/3');
  });

  /** timestamp를 가진 추론 텍스트 assistant 줄. */
  function reasoningLineAt(iso: string): string {
    return JSON.stringify({
      type: 'assistant',
      timestamp: iso,
      message: { role: 'assistant', content: [{ type: 'text', text: REASONING_TEXT }] },
    });
  }

  test('지연 확정 기준은 현재 시각이 아니라 deny 시각이다 (변이 사살: 리뷰 medium)', async () => {
    const cwd = makeCwd();
    const tp = join(cwd, 'transcript.jsonl');
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n', 'utf8');
    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);

    // deny 시각(deny-count 파일 mtime)을 2분 전으로 밀어, "deny 이후이지만 현재보다는
    // 과거"에 생성된 현실적인 순응 타임라인을 만든다. 비교 기준이 현재 시각으로
    // 잘못 바뀌면(변이) 이 순응 텍스트(1분 전)도 지연 확정으로 오판된다.
    const denyCountPath = join(
      tmpdir(),
      `goodboy-session-${sessionIdFor(cwd)}`,
      'reasoning-deny-count.main.txt',
    );
    const past = new Date(Date.now() - 120_000);
    utimesSync(denyCountPath, past, past);

    writeFileSync(
      tp,
      assistantLine('추론 없는 텍스트') +
        '\n' +
        reasoningLineAt(new Date(Date.now() - 60_000).toISOString()) +
        '\n',
      'utf8',
    );
    const second = await runHook(cwd, tp);
    expect(isBlocked(second)).toBe(false);

    // 순응(생성 시각 > deny 시각)이므로 게이트는 무장 유지 — 다음 미인식은 1/3부터 차단.
    writeFileSync(tp, assistantLine('추론 없는 다음 턴 텍스트') + '\n', 'utf8');
    const next = await runHook(cwd, tp);
    expect(isBlocked(next)).toBe(true);
    expect(next).toContain('재시도 1/3');
  });

  test('지연 확정은 직전 deny가 있을 때만 — 카운터 0 상태의 과거 ts 인식은 전환 안 함 (변이 사살)', async () => {
    const cwd = makeCwd();
    const tp = join(cwd, 'transcript.jsonl');
    // deny 1회 → 순응 인식으로 카운터 0 리셋(deny-count 파일은 0으로 잔존, mtime=리셋 시각).
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n', 'utf8');
    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);
    writeFileSync(
      tp,
      assistantLine('추론 없는 텍스트') +
        '\n' +
        reasoningLineAt(new Date(Date.now() + 60_000).toISOString()) +
        '\n',
      'utf8',
    );
    const reset = await runHook(cwd, tp);
    expect(isBlocked(reset)).toBe(false);

    // 새 턴: 직전 deny 없이(카운터 0) 과거 ts 추론이 인식됨 — priorDenies 가드가 없다면
    // (변이) 리셋 mtime과 비교해 잘못 지연 모드로 전환된다.
    writeFileSync(tp, reasoningLineAt(new Date(Date.now() - 60_000).toISOString()) + '\n', 'utf8');
    const ok = await runHook(cwd, tp);
    expect(isBlocked(ok)).toBe(false);

    // 게이트 무장 유지 — 다음 미인식은 1/3부터 차단되어야 한다.
    writeFileSync(tp, assistantLine('추론 없는 다음 턴 텍스트') + '\n', 'utf8');
    const next = await runHook(cwd, tp);
    expect(isBlocked(next)).toBe(true);
    expect(next).toContain('재시도 1/3');
  });

  test('재시도 플러시 대기(v0.27.7): 대기 중 섹션이 플러시되면 통과 + 지연 확정까지 연결', async () => {
    const cwd = makeCwd();
    const tp = join(cwd, 'transcript.jsonl');
    writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n', 'utf8');
    // 1) deny 1/3 (대기 없음 — 첫 호출은 카운터 0이라 즉시 판정).
    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);
    expect(first).toContain('재시도 1/3');

    // 2) 재시도를 대기 모드(5초)로 실행하면서, 1.2초 뒤 deny 이전 생성 시각의
    //    추론 텍스트가 플러시되는 상황을 재현한다.
    const laggedLine = JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: REASONING_TEXT }] },
    });
    const pending = runHook(cwd, tp, { env: { GOODBOY_REASONING_FLUSH_WAIT_MS: '5000' } });
    setTimeout(() => {
      writeFileSync(tp, assistantLine('추론 없는 텍스트') + '\n' + laggedLine + '\n', 'utf8');
    }, 1200);
    const second = await pending;
    // 즉시 재거부(수정 전 동작)라면 여기서 deny 2/3이 됐다 — 대기가 플러시를 잡아 통과.
    expect(isBlocked(second)).toBe(false);
    // 인식된 텍스트가 deny 이전 생성 → 지연 확정으로 sticky 전환까지 이어진다.
    expect(second).toContain('지연 모드로 전환');

    // 3) 이후 편집은 미인식이어도 차단 없음(sticky).
    writeFileSync(tp, assistantLine('추론 없는 다음 턴') + '\n', 'utf8');
    const next = await runHook(cwd, tp);
    expect(isBlocked(next)).toBe(false);
  });

  test('재시도 플러시 대기: 끝내 플러시가 없으면 기존 deny 경로 유지(2/3)', async () => {
    const cwd = makeCwd();
    const tp = makeTranscript(cwd, ['추론 없는 텍스트']);
    const first = await runHook(cwd, tp);
    expect(isBlocked(first)).toBe(true);
    // 1.5초 대기 후에도 섹션 없음 → 정상 deny 2/3 (안전망 불변).
    const second = await runHook(cwd, tp, { env: { GOODBOY_REASONING_FLUSH_WAIT_MS: '1500' } });
    expect(isBlocked(second)).toBe(true);
    expect(second).toContain('재시도 2/3');
  });

  test('재시도 플러시 대기: 첫 호출(직전 deny 없음)에는 대기하지 않는다', async () => {
    const cwd = makeCwd();
    const tp = makeTranscript(cwd, ['추론 없는 텍스트']);
    const started = Date.now();
    // 대기 한도를 크게 줘도 카운터 0이면 즉시 판정되어야 한다.
    const out = await runHook(cwd, tp, { env: { GOODBOY_REASONING_FLUSH_WAIT_MS: '20000' } });
    expect(isBlocked(out)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
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
