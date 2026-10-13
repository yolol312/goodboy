// bunfig.toml preloads tests/setup.ts, which removes GOODBOY_* from the environment
// (round 3 of phase A: hook tests inherited the developer's GOODBOY_TEST_GATE and
// GOODBOY_BASH_WRITE_GATE). Checked in a child `bun test`, since this process has
// already been cleaned.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Runs a probe test that fails when GOODBOY_TEST_GATE reaches it or a hook it spawns. */
async function probe(cwd: string, probeDir: string): Promise<number> {
  const file = join(probeDir, 'probe.test.ts');
  writeFileSync(
    file,
    [
      "import { expect, test } from 'bun:test';",
      "test('no GOODBOY_* in the environment', async () => {",
      '  expect(process.env.GOODBOY_TEST_GATE).toBeUndefined();',
      "  const p = Bun.spawn(['sh', '-c', 'printf %s \"${GOODBOY_TEST_GATE:-unset}\"'], { env: { ...process.env }, stdout: 'pipe' });",
      "  expect(await new Response(p.stdout).text()).toBe('unset');",
      '});',
    ].join('\n'),
    'utf8',
  );
  const proc = Bun.spawn(['bun', 'test', file], {
    cwd,
    env: { ...process.env, GOODBOY_TEST_GATE: 'on' },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return proc.exited;
}

describe('the test preload', () => {
  test('clears GOODBOY_* for every test run from the repo root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodboy-preload-'));
    dirs.push(dir);
    expect(await probe(ROOT, dir)).toBe(0);
  }, 30_000);

  test('the probe catches a leak: without the repo bunfig it fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goodboy-preload-'));
    dirs.push(dir);
    expect(await probe(dir, dir)).not.toBe(0);
  }, 30_000);
});
