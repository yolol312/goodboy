import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveSkillPath } from '../hooks/user-prompt-submit';

// 통합 테스트: user-prompt-submit hook을 실제 프로세스로 실행하여
// (1) 알려진 스킬 커맨드 감지 시 self-attestation 체크리스트를 additionalContext로 내보내고
// (2) .claude/.goodboy-session-state.json에 risk 분류를 그대로 기록하는지 검증.

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'user-prompt-submit.ts');
const PLUGIN_ROOT = resolve(import.meta.dir, '..');

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

async function runHook(prompt: string): Promise<{ stdout: string; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-ups-'));
  tmpDirs.push(cwd);
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd,
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
    // H5-04 간결-우선/B2 질문 유도 주입은 별도 테스트에서 검증. 여기선 꺼서 격리 검증.
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      GOODBOY_CONCISE_DEFAULT: 'off',
      GOODBOY_ASK_UNCLEAR: 'off',
    },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { stdout, cwd };
}

function parseAdditionalContext(stdout: string): string {
  const out = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return out.hookSpecificOutput?.additionalContext ?? '';
}

describe('user-prompt-submit 빈 카테고리 커맨드 차단 (B1)', () => {
  function parseBlock(stdout: string): { decision?: string; reason?: string } {
    return JSON.parse(stdout) as { decision?: string; reason?: string };
  }

  test('인자 없는 /fix-bug → block + 필수 질문 안내', async () => {
    const { stdout } = await runHook('/fix-bug');
    const out = parseBlock(stdout);
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('/fix-bug');
    expect(out.reason ?? '').toContain('다시 입력');
  });

  test('옵션만 있는 /fix-bug --risk risky → block (내용 없음)', async () => {
    const { stdout } = await runHook('/fix-bug --risk risky');
    const out = parseBlock(stdout);
    expect(out.decision).toBe('block');
  });

  test('내용이 있으면 차단하지 않는다 (의미 판정은 모델 몫)', async () => {
    const { stdout } = await runHook('/fix-bug 로그인 후 401');
    const out = parseBlock(stdout);
    expect(out.decision).toBeUndefined();
  });

  test('빈 커맨드로는 session-state를 기록하지 않는다', async () => {
    const { cwd } = await runHook('/migrate');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(cwd, '.claude', '.goodboy-session-state.json'))).toBe(false);
  });

  test('알려지지 않은 커맨드(/unknown)는 차단 대상 아님', async () => {
    const { stdout } = await runHook('/unknown');
    const out = parseBlock(stdout);
    expect(out.decision).toBeUndefined();
  });
});

describe('user-prompt-submit self-attestation checklist (#3)', () => {
  test('clear prompt still gets the full checklist (no false "N missing")', async () => {
    const { stdout, cwd } = await runHook('/add-feature add and list todo tasks in a CLI');
    const ctx = parseAdditionalContext(stdout);
    // All four add-feature required inputs must be present in the checklist.
    expect(ctx).toContain('user_scenario');
    expect(ctx).toContain('inputs_outputs');
    expect(ctx).toContain('scope');
    expect(ctx).toContain('test_strategy');
    expect(ctx).toContain('self-assessment');
    // Must NOT use the old "N개 누락" phrasing.
    expect(ctx).not.toMatch(/\d+\s*개/);

    // session-state must still be written with the risk classification.
    const state = JSON.parse(
      readFileSync(join(cwd, '.claude', '.goodboy-session-state.json'), 'utf8'),
    ) as { category: string; risk: string };
    expect(state.category).toBe('add-feature');
    expect(['simple', 'medium', 'risky']).toContain(state.risk);
  });

  test('vague prompt gets the SAME checklist (not a longer "missing" list)', async () => {
    const { stdout } = await runHook('/add-feature do stuff');
    const ctx = parseAdditionalContext(stdout);
    expect(ctx).toContain('user_scenario');
    expect(ctx).toContain('test_strategy');
    expect(ctx).toContain('지어내지 마세요');
  });

  test('keyword-stuffing does not change the checklist (not gameable)', async () => {
    const stuffed = await runHook(
      '/add-feature user_scenario inputs_outputs scope test_strategy',
    );
    const clear = await runHook('/add-feature add and list todo tasks in a CLI');
    // The checklist body is identical regardless of stuffing — it is no longer
    // a "these N are missing" computation that stuffing could suppress.
    expect(parseAdditionalContext(stuffed.stdout)).toBe(
      parseAdditionalContext(clear.stdout),
    );
  });

  test('non-skill prompt emits no additionalContext and no session-state', async () => {
    const { stdout, cwd } = await runHook('just a normal message');
    const out = JSON.parse(stdout) as { hookSpecificOutput?: unknown };
    expect(out.hookSpecificOutput).toBeUndefined();
    let stateExists = true;
    try {
      readFileSync(join(cwd, '.claude', '.goodboy-session-state.json'), 'utf8');
    } catch {
      stateExists = false;
    }
    expect(stateExists).toBe(false);
  });
});

describe('resolveSkillPath cwd opt-in (2-C)', () => {
  // goodboy/skills 에 존재하지 않는 이름 → import.meta.dir(../skills) 후보가 배제되어 cwd 판정만 남는다.
  const FAKE = 'zzz-fake-skill-goodboy';

  function seedCwdSkill(): string {
    const cwd = mkdtempSync(join(tmpdir(), 'goodboy-skill-'));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, 'skills', FAKE), { recursive: true });
    writeFileSync(join(cwd, 'skills', FAKE, 'SKILL.md'), '---\nrisk_default: simple\n---\n', 'utf8');
    return cwd;
  }

  test('default: cwd/skills는 신뢰하지 않음 → null', () => {
    const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const savedAllow = process.env.GOODBOY_ALLOW_CWD_SKILLS;
    try {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      delete process.env.GOODBOY_ALLOW_CWD_SKILLS;
      const cwd = seedCwdSkill();
      expect(resolveSkillPath(FAKE, cwd)).toBeNull();
    } finally {
      if (savedRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
      if (savedAllow === undefined) delete process.env.GOODBOY_ALLOW_CWD_SKILLS;
      else process.env.GOODBOY_ALLOW_CWD_SKILLS = savedAllow;
    }
  });

  test('GOODBOY_ALLOW_CWD_SKILLS=1: cwd/skills를 후보로 인정 → 경로 반환', () => {
    const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const savedAllow = process.env.GOODBOY_ALLOW_CWD_SKILLS;
    try {
      delete process.env.CLAUDE_PLUGIN_ROOT;
      process.env.GOODBOY_ALLOW_CWD_SKILLS = '1';
      const cwd = seedCwdSkill();
      const p = resolveSkillPath(FAKE, cwd);
      expect(p).not.toBeNull();
      expect(p!).toContain(join('skills', FAKE, 'SKILL.md'));
    } finally {
      if (savedRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
      if (savedAllow === undefined) delete process.env.GOODBOY_ALLOW_CWD_SKILLS;
      else process.env.GOODBOY_ALLOW_CWD_SKILLS = savedAllow;
    }
  });
});
