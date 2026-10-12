import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';

// 위험도 게이트(2-B) 통합 테스트.
//   - 변경 도구(Bash 등)에만 적용, read-only(Read)는 통과.
//   - state.sessionId가 현재 세션과 일치할 때만 적용(커밋된/타세션 잔재는 무시).
//   Bash를 쓰는 이유: read-before-edit/추론/H2-01 게이트를 거치지 않고 위험 게이트(D)에 바로 도달한다.

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

// Each project gets its own TMPDIR: the gate reads the state from the session state dir
// ($TMPDIR/goodboy-session-<id>/, A3), and the fixed session ids below must not share it.
const tmpOf = new Map<string, string>();

function newCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-risk-'));
  tmpDirs.push(cwd);
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-risk-tmp-'));
  tmpDirs.push(tmp);
  tmpOf.set(cwd, tmp);
  return cwd;
}

function seedRiskyState(
  cwd: string,
  sessionId: string,
  opts: { approved?: boolean; riskReason?: string } = {},
): void {
  const sessionDir = join(tmpOf.get(cwd)!, `goodboy-session-${sessionId}`);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, '.goodboy-session-state.json'),
    JSON.stringify({ category: 'migrate', risk: 'risky', riskReason: opts.riskReason, turn: 0, sessionId }),
    'utf8',
  );
  if (opts.approved) approve(cwd, sessionId);
}

/** The user's approval for one session: its own marker name (A3). */
function approve(cwd: string, sessionId: string): void {
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  writeFileSync(join(cwd, approvalMarkerRelPath('risk', sessionId)), 'ok', 'utf8');
}

interface Out {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
}

async function runTool(
  cwd: string,
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  agentId?: string,
): Promise<Out> {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd,
    tool_name: toolName,
    tool_input: toolInput,
    ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}),
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmpOf.get(cwd), GOODBOY_DISABLE_DELEGATION: '1' },
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as Out;
  } catch {
    return {};
  }
}

function isDenied(o: Out): boolean {
  return o.hookSpecificOutput?.permissionDecision === 'deny';
}

describe('pre-tool-use risk gate (2-B)', () => {
  test('DENY: 변경 도구(Bash) — 현재 세션에 바인딩된 risky state', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A');
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('risky');
  });

  // A4: the deny must name the cause and an exit the agent can actually take (ask the user).
  test('DENY message names the keyword and tells the user to create the marker', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A', { riskReason: 'keyword:prod' });
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'npm run migrate' });
    expect(isDenied(out)).toBe(true);
    const reason = out.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).toContain('"prod"');
    expect(reason).toContain(`! touch ${approvalMarkerRelPath('risk', 'sess-A')}`);
    expect(reason).toContain('--risk simple');
  });

  // A10: when the subagent transcript cannot be found, the rationale gate used to
  //   `emitPass(); return`, skipping the risk gate too — an unapproved subagent Write passed.
  test('DENY: a subagent Write in a risky session is gated even without its transcript', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A');
    const out = await runTool(cwd, 'sess-A', 'Write', { file_path: join(cwd, 'new.ts'), content: 'x' }, 'agent-1');
    expect(isDenied(out)).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('classified as risky');
  });

  test('ALLOW: read-only Bash (git status) passes in a risky session', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A');
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'git status' });
    expect(isDenied(out)).toBe(false);
  });

  test('ALLOW: read-only(Read)는 risky state여도 위험 게이트 대상 아님', async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A');
    const f = join(cwd, 'x.ts');
    writeFileSync(f, 'hello', 'utf8'); // 처음 읽는 파일 → H2-01 통과
    const out = await runTool(cwd, 'sess-A', 'Read', { file_path: f });
    expect(isDenied(out)).toBe(false);
  });

  test("ALLOW: another session's risky state is ignored", async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-OTHER');
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(false);
  });

  // The gate falls back to the repo-level copy when the session copy is missing; a copy
  //   committed by another session must still never apply (DoS on clone, 2-B).
  test('ALLOW: 커밋된 잔재(다른 세션의 repo-level risky state)는 무시 — DoS 방지', async () => {
    const cwd = newCwd();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', '.goodboy-session-state.json'),
      JSON.stringify({ category: 'migrate', risk: 'risky', sessionId: 'sess-OTHER' }),
      'utf8',
    );
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(false);
  });

  test("DENY: this session's repo-level state applies when its session copy is missing", async () => {
    const cwd = newCwd();
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(cwd, '.claude', '.goodboy-session-state.json'),
      JSON.stringify({ category: 'migrate', risk: 'risky', sessionId: 'sess-A' }),
      'utf8',
    );
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(true);
  });

  test("ALLOW: 같은 세션 risky여도 그 세션의 승인 파일이 있으면 통과", async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A', { approved: true });
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(false);
  });

  // Security review (A3): one repo-level marker let an approval for session B unlock A.
  test("DENY: another session's approval, or the old shared marker name, does not unlock this session", async () => {
    const cwd = newCwd();
    seedRiskyState(cwd, 'sess-A');
    approve(cwd, 'sess-B');
    writeFileSync(join(cwd, '.claude', '.goodboy-risk-approved.txt'), 'ok', 'utf8'); // pre-A3 name
    const out = await runTool(cwd, 'sess-A', 'Bash', { command: 'echo hi' });
    expect(isDenied(out)).toBe(true);
  });
});
