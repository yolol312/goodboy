import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// 통합 테스트: user-prompt-submit hook을 실제 프로세스로 실행하여
// (1) 알려진 스킬 커맨드 감지 시 self-attestation 체크리스트를 additionalContext로 내보내고
// (2) .claude/.vcf-session-state.json에 risk 분류를 그대로 기록하는지 검증.

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
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-ups-'));
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
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
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
      readFileSync(join(cwd, '.claude', '.vcf-session-state.json'), 'utf8'),
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
      readFileSync(join(cwd, '.claude', '.vcf-session-state.json'), 'utf8');
    } catch {
      stateExists = false;
    }
    expect(stateExists).toBe(false);
  });
});
