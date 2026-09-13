import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentTranscriptPath } from '../lib/transcript-parser';

// 라이브 검증 실측 버그:
//   hook은 서브에이전트의 도구 호출에도 "메인" transcript_path를 넘긴다.
//   그래서 추론 게이트가 서브에이전트가 쓴 ## 추론을 못 보고 메인의 글만 검사했다
//   → 서브에이전트가 추론 섹션을 9번 출력했는데 Edit이 8번 전부 차단됨(위임 편집 원천 불가).
//   → 모델은 `cat > file <<EOF` 로 우회해 모든 편집 게이트를 무력화했다.

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

const REASONING = [
  '## 추론',
  '### 사실',
  '- 대상 파일을 Read로 확인함',
  '### 추론',
  '- 함수를 추가해야 한다',
  '### 가정',
  '- 없음',
  '### 추측',
  '- 없음',
].join('\n');

function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

/** 메인 transcript + (선택) 서브에이전트 transcript 레이아웃을 만든다. */
function makeTranscripts(
  mainTexts: string[],
  agentId?: string,
  agentTexts?: string[],
): { cwd: string; mainPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-subreason-'));
  tmpDirs.push(cwd);
  const sessionUuid = 'session-uuid';
  const mainPath = join(cwd, `${sessionUuid}.jsonl`);
  writeFileSync(mainPath, mainTexts.map(assistantLine).join('\n') + '\n', 'utf8');
  if (agentId && agentTexts) {
    const subDir = join(cwd, sessionUuid, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, `agent-${agentId}.jsonl`),
      agentTexts.map(assistantLine).join('\n') + '\n',
      'utf8',
    );
  }
  return { cwd, mainPath };
}

async function runHook(
  cwd: string,
  transcriptPath: string,
  agentId?: string,
): Promise<{ blocked: boolean; out: string }> {
  const payload: Record<string, unknown> = {
    session_id: `sub-reason-${Math.random().toString(36).slice(2)}`,
    cwd,
    transcript_path: transcriptPath,
    tool_name: 'Write',
    tool_input: { file_path: join(cwd, 'newfile.ts'), content: 'x' },
  };
  if (agentId) payload.agent_id = agentId;
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    // 차단 여부로 판정 대상 transcript를 검증하므로 deny 모드로 고정(기본은 warn=비차단).
    env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'deny' },
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const parsed = JSON.parse(out || '{}') as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  return { blocked: parsed.hookSpecificOutput?.permissionDecision === 'deny', out };
}

describe('agentTranscriptPath', () => {
  test('서브에이전트 전용 transcript를 찾는다', () => {
    const { cwd, mainPath } = makeTranscripts(['메인 글'], 'a4dfcd9c71ae0119a', [REASONING]);
    const p = agentTranscriptPath(mainPath, 'a4dfcd9c71ae0119a');
    expect(p).toBe(join(cwd, 'session-uuid', 'subagents', 'agent-a4dfcd9c71ae0119a.jsonl'));
  });

  test('없으면 null', () => {
    const { mainPath } = makeTranscripts(['메인 글']);
    expect(agentTranscriptPath(mainPath, 'nope')).toBeNull();
  });

  test('경로 조작 문자가 든 agent_id는 거부', () => {
    const { mainPath } = makeTranscripts(['메인 글']);
    expect(agentTranscriptPath(mainPath, '../../etc/passwd')).toBeNull();
  });
});

describe('추론 게이트 — 서브에이전트는 자기 글로 판정 (실측 회귀)', () => {
  test('서브가 추론을 썼고 메인은 안 썼으면 => 통과', async () => {
    const agentId = 'a4dfcd9c71ae0119a';
    const { cwd, mainPath } = makeTranscripts(['서브에이전트에게 위임합니다'], agentId, [
      REASONING,
    ]);
    const r = await runHook(cwd, mainPath, agentId);
    expect(r.blocked).toBe(false);
  });

  test('서브가 추론을 안 썼으면 => 차단 (메인이 썼더라도)', async () => {
    const agentId = 'b1234567890abcdef';
    const { cwd, mainPath } = makeTranscripts([REASONING], agentId, ['그냥 고치겠습니다']);
    const r = await runHook(cwd, mainPath, agentId);
    expect(r.blocked).toBe(true);
  });

  test('서브 전용 transcript를 못 찾으면 => fail-open (편집 허용)', async () => {
    const { cwd, mainPath } = makeTranscripts(['메인 글, 추론 없음']);
    const r = await runHook(cwd, mainPath, 'missing-agent-id');
    expect(r.blocked).toBe(false);
  });

  test('메인(agent_id 없음)은 기존대로 메인 transcript로 판정', async () => {
    const { cwd, mainPath } = makeTranscripts(['추론 없이 편집 시도']);
    const r = await runHook(cwd, mainPath);
    expect(r.blocked).toBe(true);
  });
});
