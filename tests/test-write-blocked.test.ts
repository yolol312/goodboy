import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateTestResultInput } from '../lib/cli';

// Track G: `test-write` accepts a `blocked` result only with evidence, and records the tested
// content (commit and tree) itself; the agent cannot set them.

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const base = {
  tested_files: ['/repo/src/a.ts'],
  category: 'add-feature',
  test_files: [] as string[],
  environment: { mode: 'none' },
  suites: [],
  acceptance: [],
  verdict: 'blocked',
};
const evidence = [{ command: 'docker info', output: 'zsh: command not found: docker' }];

describe('a blocked result', () => {
  test('needs a reason of 15+ characters and commands with output', () => {
    expect(validateTestResultInput({ ...base, blocked: { reason: 'no container runtime here', evidence } }).ok).toBe(true);
    const errs = (v: unknown) => validateTestResultInput(v).errors.join('\n');
    expect(errs({ ...base })).toContain('blocked: {reason');
    expect(errs({ ...base, blocked: { reason: 'no docker', evidence } })).toContain('at least 15');
    expect(errs({ ...base, blocked: { reason: 'no container runtime here', evidence: [] } })).toContain('blocked.evidence');
    expect(errs({ ...base, blocked: { reason: 'no container runtime here', evidence: [{ command: 'docker info', output: '  ' }] } })).toContain('output is empty');
  });

  test('may name no test files; any other verdict still must', () => {
    expect(validateTestResultInput({ ...base, verdict: 'pass' }).errors.join('\n')).toContain('test_files');
  });

  test('the CLI records commit and tree, ignoring values the agent sends', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goodboy-twb-'));
    tmpDirs.push(cwd);
    for (const a of [['init', '-q'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 't']]) Bun.spawnSync(['git', ...a], { cwd });
    writeFileSync(join(cwd, 'a.ts'), 'x');
    Bun.spawnSync(['git', 'add', '-A'], { cwd });
    Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'i'], { cwd });
    const input = { ...base, blocked: { reason: 'no container runtime here', evidence }, commit: 'forged', tree: 'forged' };
    const proc = Bun.spawn(['bun', CLI, 'test-write'], { cwd, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
    const out = JSON.parse(await new Response(proc.stdout).text()) as { path: string };
    expect(await proc.exited).toBe(0);
    const saved = JSON.parse(readFileSync(out.path, 'utf8')) as Record<string, unknown>;
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd }).stdout.toString().trim();
    const tree = Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}'], { cwd }).stdout.toString().trim();
    expect(saved).toMatchObject({ verdict: 'blocked', commit: head, tree, blocked: { reason: 'no container runtime here' } });
  });

  test('outside a git repo commit and tree are null', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'goodboy-twb-'));
    tmpDirs.push(cwd);
    const input = { ...base, blocked: { reason: 'no container runtime here', evidence } };
    const proc = Bun.spawn(['bun', CLI, 'test-write'], { cwd, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
    const out = JSON.parse(await new Response(proc.stdout).text()) as { path: string };
    await proc.exited;
    expect(JSON.parse(readFileSync(out.path, 'utf8'))).toMatchObject({ commit: null, tree: null });
  });
});
