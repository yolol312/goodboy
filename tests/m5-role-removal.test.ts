// M5 trial: a tests-role agent clears the test output dirs before a re-run (`rm -rf
// build/test-results/test` was denied). Only parsed rm / rmdir / unlink operands count, each must
// resolve (`..` applied, no symlink on the way) to one of the dirs or inside one; anything else
// is judged as before. Through the real PreToolUse hook (spawned), in a temporary project.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { roleOf } from '../lib/routing-policy';
import { bashChangedPaths, isTestOutputPath, writeDenial } from '../lib/role-limits';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function project(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m5rm-')));
  dirs.push(d);
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main'], { cwd: d });
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(d, 'build', 'test-results', 'test'), { recursive: true });
  return d;
}

async function run(cwd: string, command: string, agent = 'goodboy:test-unit'): Promise<{ denied: boolean; reason: string }> {
  const sessionId = `m5r${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${sessionId}`));
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, GOODBOY_CLAIM_FLUSH_WAIT_MS: '0' },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: agent, tool_input: { command } })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const o = JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return { denied: o.hookSpecificOutput?.permissionDecision === 'deny', reason: o.hookSpecificOutput?.permissionDecisionReason ?? '' };
}

describe('a tests-role agent removes test output', () => {
  test('rm of a test output dir and of what is in it is allowed', async () => {
    const d = project();
    mkdirSync(join(d, 'mod'), { recursive: true });
    writeFileSync(join(d, 'mod', 'build.gradle'), '');
    for (const c of ['rm -rf build/test-results/test', 'rm -rf build/test-results', 'rm -rf build/reports', 'rm -rf target/surefire-reports target/site/jacoco', 'rmdir build/test-results/test', 'unlink build/test-results/a.xml', 'rm -rf mod/build/reports/x']) {
      const r = await run(d, c);
      expect([c, r.denied]).toEqual([c, false]);
    }
  }, 60_000);

  test('copy, move and writes into them, and other paths, stay denied', async () => {
    const d = project();
    for (const c of [
      'cp x build/test-results/',
      'mv x build/reports/y',
      'touch build/test-results/a.xml',
      'rm -rf build',
      'rm -rf target/site',
      'rm -rf build/test-results/test src/a.ts',
      'rm -rf build/test-results/../../src',
      'rm -rf build/test-results/../../src/a.ts',
    ]) {
      const r = await run(d, c);
      expect([c, r.denied]).toEqual([c, true]);
    }
  }, 60_000);

  test('an operand the shell expands, after a project path, is no recognizable removal: judged as a write', async () => {
    const d = project();
    for (const c of [
      'rm -rf build/test-results/{x,../../src/main}',
      'rm -rf build/test-results/*',
      'rm -rf src/*',
      'rm -rf ./{a,b}',
      'rm -rf build/test-results/?',
      'rm -rf build/test-results/[a-z]',
      'rm -rf build/test-results/$X',
      'rm -rf build/test-results/`echo x`',
      'rmdir build/reports/{a,b}',
      'unlink build/test-results/*.xml',
    ]) {
      const r = await run(d, c);
      expect([c, r.denied]).toEqual([c, true]);
    }
  }, 60_000);

  test('an expansion after a TEST path is denied too (the prefix does not make it safe)', async () => {
    const d = project();
    mkdirSync(join(d, 'tests'), { recursive: true });
    for (const c of ['rm -rf tests/{x,../src/a.ts}', 'rm -rf tests/$X/../src/a.ts', 'rm -rf tests/*', 'rm -rf build/test-results/../../src/a.ts', 'rm -rf tests/../src/a.ts']) {
      const r = await run(d, c);
      expect([c, r.denied]).toEqual([c, true]);
    }
  }, 60_000);

  test('`..` after a symlink inside an output dir is denied (the kernel follows the link first)', async () => {
    const d = project();
    symlinkSync(join(d, 'src'), join(d, 'build', 'test-results', 'lnk2'));
    expect((await run(d, 'rm -rf build/test-results/lnk2/../src/a.ts')).denied).toBe(true);
    expect((await run(d, 'rm -rf build/test-results/lnk2')).denied).toBe(true);
  }, 60_000);

  test('name-only output dirs are source: a Go package, node_modules, a src dir; a module with a build file is not', async () => {
    const d = project();
    for (const m of ['internal/build/reports', 'node_modules/pkg/build/reports', 'src/m/build/reports', 'mod/build/reports']) mkdirSync(join(d, m), { recursive: true });
    writeFileSync(join(d, 'mod', 'pom.xml'), '');
    writeFileSync(join(d, 'src/m', 'pom.xml'), '');
    for (const c of ['rm -rf internal/build/reports', 'rm -rf node_modules/pkg/build/reports', 'rm -rf src/m/build/reports']) {
      expect([c, (await run(d, c)).denied]).toEqual([c, true]);
    }
    expect((await run(d, 'rm -rf mod/build/reports')).denied).toBe(false);
  }, 60_000);

  test('a pure variable or home operand cannot be resolved and is skipped, as before (mktemp cleanup)', async () => {
    const d = project();
    for (const c of ['rm -rf "$D"', 'rm -rf "$D/x"', 'rm -rf $D/x', 'rm -rf "${TMP}"/probe', 'rm -rf ~/probe', 'D=$(mktemp -d); rm -rf "$D"']) {
      const r = await run(d, c);
      expect([c, r.denied]).toEqual([c, false]);
    }
  }, 60_000);

  test('rmdir -p, which removes the parents too, is a write', async () => {
    const d = project();
    for (const c of ['rmdir -p build/reports/x', 'rmdir --parents build/test-results/test']) {
      const r = await run(d, c);
      expect([c, r.denied]).toEqual([c, true]);
    }
  }, 60_000);

  test('a symlinked output dir is not an output dir', async () => {
    const d = project();
    symlinkSync(join(d, 'src'), join(d, 'build', 'reports'));
    expect((await run(d, 'rm -rf build/reports/a.ts')).denied).toBe(true);
    expect((await run(d, 'rm -rf build/reports')).denied).toBe(true);
  }, 60_000);

  test('only the tests role: a docs agent may not remove them', async () => {
    const d = project();
    expect((await run(d, 'rm -rf build/test-results/test', 'goodboy:build-docs')).denied).toBe(true);
  }, 60_000);
});

describe('bashChangedPaths and isTestOutputPath', () => {
  test('removals go to `removed` only when asked, and never for rmdir -p', () => {
    const removed: string[] = [];
    expect(bashChangedPaths('rm -rf build/reports/x && cp a b', '/p', { removed })).toEqual(['/p/b']);
    expect(removed).toEqual(['/p/build/reports/x']);
    expect(bashChangedPaths('rm -rf build/reports/x', '/p')).toEqual(['/p/build/reports/x']);
    const r2: string[] = [];
    expect(bashChangedPaths('rmdir -p build/reports/x', '/p', { removed: r2 })).toEqual(['/p/build/reports/x']);
    expect(r2).toEqual([]);
  });

  test('expanded and `..` operands go to `expanded`, a pure variable to nowhere', () => {
    const removed: string[] = [];
    const expanded: string[] = [];
    expect(bashChangedPaths('rm -rf tests/{x,../src/a.ts} tests/$X/../src/a.ts "$D" "$D/x" ../y tests/../src/b.ts', '/p', { removed, expanded })).toEqual([]);
    expect(expanded).toEqual(['/p/tests', '/p/tests', '/y', '/p/src/b.ts']);
    expect(removed).toEqual([]);
  });

  test('the dirs: at the repo top, or in a module dir that holds a build file; never under node_modules or src', () => {
    const root = project();
    for (const m of ['mod', 'a/b', 'internal', 'node_modules/pkg', 'src/m']) mkdirSync(join(root, m), { recursive: true });
    writeFileSync(join(root, 'mod', 'build.gradle.kts'), '');
    writeFileSync(join(root, 'a/b', 'pom.xml'), '');
    writeFileSync(join(root, 'node_modules/pkg', 'package.json'), '{}');
    writeFileSync(join(root, 'src/m', 'pom.xml'), '');
    for (const p of ['build/test-results', 'build/test-results/test/a.xml', 'build/reports', 'mod/build/reports/x', 'a/b/target/surefire-reports', 'target/failsafe-reports/x', 'target/site/jacoco']) expect([p, isTestOutputPath(p, root)]).toEqual([p, true]);
    for (const p of ['build', 'target/site', 'target', 'src/build/reports/x', 'build/test-resultsX', 'build/classes', 'a/b/c/build/reports', 'internal/build/reports', 'node_modules/pkg/build/reports', 'src/m/build/reports', 'nomod/build/reports']) expect([p, isTestOutputPath(p, root)]).toEqual([p, false]);
  });
});

describe('writeDenial with removal and expanded (in-process)', () => {
  const tester = roleOf('test-unit')!;
  test('a removal inside a test output dir is allowed; writing there, and removing elsewhere, is not', () => {
    const root = project();
    expect(writeDenial(tester, join(root, 'build/test-results/test'), root, { removal: true })).toBeNull();
    expect(writeDenial(tester, join(root, 'build/test-results/test'), root)).toContain('test files only');
    expect(writeDenial(tester, join(root, 'src/a.ts'), root, { removal: true })).toContain('test files only');
  });

  test('a symlink on the way from the project root takes the allowance away, a missing tail does not', () => {
    const root = project();
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    mkdirSync(join(root, 'build', 'reports'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(root, 'build', 'reports', 'link'));
    expect(writeDenial(tester, join(root, 'build/reports/link/x'), root, { removal: true })).toContain('test files only');
    expect(writeDenial(tester, join(root, 'build/reports/link'), root, { removal: true })).toContain('test files only');
    expect(writeDenial(tester, join(root, 'build/reports/not-yet/x'), root, { removal: true })).toBeNull();
  });

  test('an expanded operand is denied for the tests role even inside a test output dir', () => {
    const root = project();
    const why = writeDenial(tester, join(root, 'build/test-results'), root, { removal: true, expanded: true });
    expect(why).toContain('may not remove by a pattern');
    expect(why).toContain('build/test-results');
  });
});
