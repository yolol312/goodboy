import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Track G, step G1 — UserPromptSubmit (plan §10.10): task notifications are not user
// prompts (G0 M10), typed namespaced commands register (M12), a command inside pasted text
// does not, argument-free commands are allowed, and the general guidance carries R2.

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'user-prompt-submit.ts');
const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

async function runHook(
  prompt: string,
  extraEnv: Record<string, string> = {},
): Promise<{ out: Record<string, unknown>; cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-ups-g1-'));
  tmpDirs.push(cwd);
  const payload = JSON.stringify({ session_id: `ups-g1-${Date.now()}-${Math.random()}`, cwd, prompt });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...extraEnv },
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { out: JSON.parse(stdout || '{}') as Record<string, unknown>, cwd };
}

function ctx(out: Record<string, unknown>): string {
  const h = out.hookSpecificOutput as { additionalContext?: string } | undefined;
  return h?.additionalContext ?? '';
}

function stateOf(cwd: string): { category?: string } | null {
  const p = join(cwd, '.claude', '.goodboy-session-state.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { category?: string }) : null;
}

const NOTIFICATION =
  '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n' +
  '<result>/fix-bug done</result>\n</task-notification>';

describe('task notifications are not user prompts (M10)', () => {
  test('no guidance and no output at all', async () => {
    const { out } = await runHook(NOTIFICATION);
    expect(out).toEqual({});
  });

  test('no task registration', async () => {
    const { cwd } = await runHook(NOTIFICATION);
    expect(stateOf(cwd)).toBeNull();
  });
});

describe('a workflow command is a task prompt', () => {
  test('it carries the R2 stop rule too (hallucination review: only general prompts had it)', async () => {
    const { out } = await runHook('/goodboy:prepare-migration rename the users.email column');
    expect(ctx(out)).toContain('stop rule R2');
    const { out: off } = await runHook('/goodboy:prepare-migration rename the users.email column', { GOODBOY_OUTWARD_GATE: 'off' });
    expect(ctx(off)).not.toContain('stop rule R2');
  });
});

describe('slash commands (M12)', () => {
  test('a goodboy-namespaced command registers its category', async () => {
    const { cwd } = await runHook('/goodboy:fix-bug 로그인 후 401');
    expect(stateOf(cwd)?.category).toBe('fix-bug');
  });

  test("another plugin's command of the same name does not register", async () => {
    const { cwd } = await runHook('/other:fix-bug crash on save');
    expect(stateOf(cwd)).toBeNull();
  });

  test('a command line inside pasted text does not register', async () => {
    const { out, cwd } = await runHook('the log says:\n/fix-bug crash on save\nwhat now?');
    expect(stateOf(cwd)).toBeNull();
    expect(ctx(out)).toContain('B2');
  });

  test('an argument-free command is allowed and registers', async () => {
    const { out, cwd } = await runHook('/fix-bug');
    expect(out.decision).toBeUndefined();
    expect(stateOf(cwd)?.category).toBe('fix-bug');
    expect(ctx(out)).toContain('without a task description');
  });
});

describe('general guidance (English, with R2)', () => {
  test('a normal prompt gets B2, the R2 line and H5-04', async () => {
    const { out } = await runHook('로그인이 안 돼');
    const c = ctx(out);
    expect(c).toContain('B2');
    expect(c).toContain('R2');
    expect(c).toContain('production');
    expect(c).toContain('H5-04');
  });

  test('GOODBOY_OUTWARD_GATE=off drops the R2 line', async () => {
    const { out } = await runHook('로그인이 안 돼', { GOODBOY_OUTWARD_GATE: 'off' });
    expect(ctx(out)).not.toContain('R2');
    expect(ctx(out)).toContain('B2');
  });
});
