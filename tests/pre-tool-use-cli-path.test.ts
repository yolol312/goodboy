// A9: instructions the agent runs in Bash must name the real CLI path.
// `${CLAUDE_PLUGIN_ROOT}` is expanded for hook commands only; inside the agent's shell it
// is unset, so `bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts …` failed with Module not found.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

async function denyReason(fileUnderClaude: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-cli-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-cli-cwd-'));
  tmpDirs.push(cwd);
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: 'sess-cli',
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(cwd, '.claude', fileUnderClaude), content: '{}' },
      }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const out = JSON.parse(stdout) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  return out.hookSpecificOutput?.permissionDecisionReason ?? '';
}

describe('PreToolUse — artifact-write deny names a runnable CLI path (A9)', () => {
  test('test-write instruction points to an existing lib/cli.ts', async () => {
    const reason = await denyReason(join('tests', 'result.json'));
    expect(reason).not.toContain('CLAUDE_PLUGIN_ROOT');
    const cli = /bun "([^"]+)" test-write/.exec(reason)?.[1] ?? '';
    expect(cli.endsWith(join('lib', 'cli.ts'))).toBe(true);
    expect(existsSync(cli)).toBe(true);
  });

  test('review-write instruction points to the same CLI', async () => {
    const reason = await denyReason(join('reviews', 'review.json'));
    expect(reason).not.toContain('CLAUDE_PLUGIN_ROOT');
    const cli = /bun "([^"]+)" review-write/.exec(reason)?.[1] ?? '';
    expect(existsSync(cli)).toBe(true);
  });
});
