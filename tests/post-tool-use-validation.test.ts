import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildValidationContext, looksUnavailable } from '../hooks/post-tool-use';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts');
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

describe('looksUnavailable (#5)', () => {
  test('exit code 127 => unavailable', () => {
    expect(looksUnavailable('whatever', 127)).toBe(true);
  });
  test('"command not found" => unavailable', () => {
    expect(looksUnavailable('sh: tsc: command not found', 1)).toBe(true);
  });
  test('"No such file or directory" => unavailable', () => {
    expect(looksUnavailable('bun: No such file or directory', 1)).toBe(true);
  });
  test('a real type error is NOT unavailable', () => {
    expect(
      looksUnavailable("a.ts(3,1): error TS2322: Type 'string' is not assignable", 2),
    ).toBe(false);
  });
});

describe('buildValidationContext (#5)', () => {
  test('real failure => blocked + 수정이 필요합니다', () => {
    const { context, blocked } = buildValidationContext([
      { cmd: 'bun run typecheck', ok: false, output: 'error TS2322' },
    ]);
    expect(blocked).toBe(true);
    expect(context).toContain('수정이 필요합니다');
  });

  test('unavailable only => NOT blocked, informational note only', () => {
    const { context, blocked } = buildValidationContext([
      { cmd: 'bun run typecheck', ok: false, output: 'command not found', unavailable: true },
    ]);
    expect(blocked).toBe(false);
    expect(context).toContain('찾을 수 없어 건너뜀');
    expect(context).not.toContain('수정이 필요합니다');
  });

  test('mix: real failure blocks, unavailable noted, others ignored', () => {
    const { context, blocked } = buildValidationContext([
      { cmd: 'bun run typecheck', ok: false, output: 'error TS1', unavailable: true },
      { cmd: 'bun run lint', ok: false, output: 'real lint error' },
      { cmd: 'bun run test', ok: true, output: 'ok' },
    ]);
    expect(blocked).toBe(true);
    expect(context).toContain('수정이 필요합니다');
    expect(context).toContain('bun run lint');
    expect(context).toContain('찾을 수 없어 건너뜀: bun run typecheck');
  });

  test('all pass => no context, not blocked', () => {
    const { context, blocked } = buildValidationContext([
      { cmd: 'bun run test', ok: true, output: 'ok' },
    ]);
    expect(blocked).toBe(false);
    expect(context).toBeUndefined();
  });
});

// --- 통합: 실제 hook 프로세스로 실행 ---

async function runHook(projectCwd: string): Promise<string> {
  const payload = JSON.stringify({
    session_id: 'test',
    cwd: projectCwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(projectCwd, 'x.ts') },
    tool_response: { success: true },
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd: projectCwd,
    stdin: new TextEncoder().encode(payload),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout;
}

function additionalContext(stdout: string): string | undefined {
  const out = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return out.hookSpecificOutput?.additionalContext;
}

function makeProject(scripts: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-ptu-'));
  tmpDirs.push(cwd);
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts }, null, 2),
    'utf8',
  );
  return cwd;
}

describe('post-tool-use integration (#5)', () => {
  test('missing binary in typecheck script => NO blocking', async () => {
    const cwd = makeProject({
      typecheck: 'this-binary-definitely-does-not-exist-vcf --noEmit',
    });
    const ctx = additionalContext(await runHook(cwd));
    // Either no context at all, or only an informational skip note — never blocking.
    if (ctx !== undefined) {
      expect(ctx).not.toContain('수정이 필요합니다');
      expect(ctx).toContain('찾을 수 없어 건너뜀');
    }
  });

  test('genuine validation failure => DOES block', async () => {
    // A script that runs (sh exists) but exits non-zero with a real-looking error.
    const cwd = makeProject({
      typecheck: 'sh -c \'echo "src.ts(1,1): error TS2322: real type error" >&2; exit 2\'',
    });
    const ctx = additionalContext(await runHook(cwd));
    expect(ctx).toBeDefined();
    expect(ctx).toContain('수정이 필요합니다');
    expect(ctx).toContain('error TS2322');
  });
});
