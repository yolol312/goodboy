import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { autoValidateMode, buildValidationContext, looksUnavailable, runCmd } from '../hooks/post-tool-use';

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
  test('localized shell message with 127 => unavailable', () => {
    // bun run / npm run both propagate the shell's 127; the message itself may be localized.
    expect(looksUnavailable('bash: 줄 1: tsc: 명령을 찾을 수 없음', 127)).toBe(true);
  });
  test('a real type error is NOT unavailable', () => {
    expect(
      looksUnavailable("a.ts(3,1): error TS2322: Type 'string' is not assignable", 2),
    ).toBe(false);
  });
  // A5: output substrings used to classify genuine failures as "tool unavailable".
  test('TS6053 "File not found" with a failing exit code is a real failure', () => {
    expect(looksUnavailable("error TS6053: File '/repo/src/missing.ts' not found.", 2)).toBe(false);
  });
  test('"No such file or directory" / ENOENT in output with exit 1 is a real failure', () => {
    expect(looksUnavailable('Error: ENOENT: no such file or directory, open fixture.json', 1)).toBe(false);
    expect(looksUnavailable('sh: tsc: command not found', 1)).toBe(false);
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

  test('runCmd maps a real timeout to timedOut, a missing tool to unavailable, a failure to neither', () => {
    const slow = runCmd('sleep 2', tmpdir(), 200);
    expect(slow.timedOut).toBe(true);
    expect(slow.unavailable).toBeFalsy();
    const missing = runCmd('definitely-missing-tool-xyz', tmpdir(), 5000);
    expect(missing.unavailable).toBe(true);
    const failing = runCmd(`sh -c "echo \\"error TS6053: File 'x.ts' not found.\\" >&2; exit 2"`, tmpdir(), 5000);
    expect(failing.ok).toBe(false);
    expect(failing.unavailable).toBeFalsy();
    expect(failing.timedOut).toBeFalsy();
  });

  // A5: a slow but healthy check must not leave a failure marker on every edit.
  test('timeout => NOT blocked, noted as inconclusive, and not a confirmed pass', () => {
    const { context, blocked, failedCmds, confirmedPass } = buildValidationContext([
      { cmd: 'bun run typecheck', ok: false, output: 'spawnSync /bin/sh ETIMEDOUT', timedOut: true },
    ]);
    expect(blocked).toBe(false);
    expect(failedCmds).toEqual([]);
    // A timeout must not clear an earlier real-failure marker.
    expect(confirmedPass).toBe(false);
    expect(context).toContain('timed out');
    expect(context).toContain('bun run typecheck');
  });

  test('failedCmds excludes unavailable and timed-out commands; a real pass is confirmed', () => {
    const mixed = buildValidationContext([
      { cmd: 'bun run typecheck', ok: false, output: 'x', unavailable: true },
      { cmd: 'bun run lint', ok: false, output: 'slow', timedOut: true },
      { cmd: 'bun run test', ok: false, output: 'real failure' },
    ]);
    expect(mixed.failedCmds).toEqual(['bun run test']);
    expect(buildValidationContext([{ cmd: 'bun run typecheck', ok: true, output: '' }]).confirmedPass).toBe(true);
    expect(
      buildValidationContext([{ cmd: 'bun run typecheck', ok: false, output: '', unavailable: true }]).confirmedPass,
    ).toBe(false);
  });
});

// --- 통합: 실제 hook 프로세스로 실행 ---

async function runHook(
  projectCwd: string,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const payload = JSON.stringify({
    session_id: 'test',
    cwd: projectCwd,
    tool_name: 'Edit',
    tool_input: { file_path: join(projectCwd, 'x.ts') },
    tool_response: { success: true },
  });
  const proc = Bun.spawn(['bun', HOOK], {
    cwd: projectCwd,
    // 기본 모드(typecheck-only)를 명시해 부모 프로세스의 잔여 GOODBOY_AUTOVALIDATE 오염을 차단.
    env: { ...process.env, GOODBOY_AUTOVALIDATE: 'typecheck', ...extraEnv },
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
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-ptu-'));
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
      typecheck: 'this-binary-definitely-does-not-exist-goodboy --noEmit',
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

describe('autoValidate mode (2-A)', () => {
  // typecheck는 통과, test는 실패하는 프로젝트. 어떤 명령이 실제로 실행됐는지로 모드를 판별한다.
  const scriptsTcOkTestFail = {
    typecheck: 'sh -c "exit 0"',
    test: 'sh -c \'echo "test failure" >&2; exit 1\'',
  };

  test('default(typecheck) mode: test는 실행 안 함 → 블로킹 없음', async () => {
    const cwd = makeProject(scriptsTcOkTestFail);
    const ctx = additionalContext(await runHook(cwd));
    // test가 돌지 않으므로 "수정이 필요합니다"가 없어야 한다.
    expect(ctx === undefined || !ctx.includes('수정이 필요합니다')).toBe(true);
  });

  test('GOODBOY_AUTOVALIDATE=all: test까지 실행 → test 실패로 블로킹', async () => {
    const cwd = makeProject(scriptsTcOkTestFail);
    const ctx = additionalContext(await runHook(cwd, { GOODBOY_AUTOVALIDATE: 'all' }));
    expect(ctx).toBeDefined();
    expect(ctx).toContain('수정이 필요합니다');
  });

  test('GOODBOY_AUTOVALIDATE=off: 아무것도 실행 안 함 → 실패 typecheck여도 블로킹 없음', async () => {
    const cwd = makeProject({
      typecheck: 'sh -c \'echo "tc error" >&2; exit 2\'',
    });
    const ctx = additionalContext(await runHook(cwd, { GOODBOY_AUTOVALIDATE: 'off' }));
    expect(ctx === undefined || !ctx.includes('수정이 필요합니다')).toBe(true);
  });
});

describe('autoValidateMode (2-A unit)', () => {
  test('기본은 typecheck, all/off는 그대로, 그 외는 typecheck로 폴백', () => {
    const saved = process.env.GOODBOY_AUTOVALIDATE;
    try {
      delete process.env.GOODBOY_AUTOVALIDATE;
      expect(autoValidateMode()).toBe('typecheck');
      process.env.GOODBOY_AUTOVALIDATE = 'all';
      expect(autoValidateMode()).toBe('all');
      process.env.GOODBOY_AUTOVALIDATE = 'off';
      expect(autoValidateMode()).toBe('off');
      process.env.GOODBOY_AUTOVALIDATE = 'bogus';
      expect(autoValidateMode()).toBe('typecheck');
    } finally {
      if (saved === undefined) delete process.env.GOODBOY_AUTOVALIDATE;
      else process.env.GOODBOY_AUTOVALIDATE = saved;
    }
  });
});
