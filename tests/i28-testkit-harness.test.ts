// #28: the user's regression-verification harness (`testkit/` at the repo top, marked by
// `testkit/testkit.config.json`, and its run output `.testkit-run/`) is a test means like tests/,
// so layer 1 asks no test and no changed-line coverage for it (needsTests, isTestkitHarness).
// Without the marker a `testkit/` dir is judged as any other. The Stop hook is spawned for real
// (as tests/i23-gate-scope-stop.test.ts does). Repos and session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import { isTestkitHarness, needsTests } from '../lib/verification-scope';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function sid(): string {
  const s = `i28${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const CODE = 'export const a = 1;\n';
const CONFIG = '{"sandbox":"compose"}\n';
/** A scratch repo top with real files; `marker` adds testkit/testkit.config.json. */
function tree(marker: boolean, files: Record<string, string> = {}): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i28-')));
  dirs.push(d);
  const all: Record<string, string> = {
    'src/a.ts': CODE,
    'testkit/lib/driver.ts': CODE,
    'testkit/flows/login.flow': 'GET /login\n',
    'testkit/flows/seed.sql': 'select 1;\n',
    'testkit/Dockerfile.app': 'FROM scratch\n',
    'testkit/sandbox.sh': '#!/bin/sh\n',
    'testkit/dummy/server.mjs': CODE,
    '.testkit-run/capture.js': CODE,
    'src/testkit/x.ts': CODE,
    ...(marker ? { 'testkit/testkit.config.json': CONFIG } : {}),
    ...files,
  };
  for (const [p, t] of Object.entries(all)) write(d, p, t);
  return d;
}

const HARNESS = [
  'testkit/lib/driver.ts',
  'testkit/flows/login.flow',
  'testkit/flows/seed.sql',
  'testkit/Dockerfile.app',
  'testkit/sandbox.sh',
  'testkit/dummy/server.mjs',
  'testkit/testkit.config.json',
  '.testkit-run/capture.js',
];

describe('needsTests: the harness is a test means when its marker is a regular file', () => {
  test('with the marker, no file below testkit/ or .testkit-run/ needs a test; code elsewhere still does', () => {
    const d = tree(true);
    for (const rel of HARNESS) {
      expect(isTestkitHarness(join(d, rel), d)).toBe(true);
      expect(needsTests(join(d, rel), d)).toBe(false);
    }
    expect(needsTests(join(d, 'src/a.ts'), d)).toBe(true);
  });

  test('without the marker every file is judged as before', () => {
    const d = tree(false);
    for (const rel of HARNESS.filter((r) => !r.endsWith('testkit.config.json'))) {
      expect(isTestkitHarness(join(d, rel), d)).toBe(false);
      expect(needsTests(join(d, rel), d)).toBe(true);
    }
  });

  test('src/testkit/ is product code, with or without the marker; so is a nested testkit/', () => {
    const d = tree(true, { 'pkg/testkit/y.ts': CODE, 'pkg/testkit/testkit.config.json': CONFIG });
    expect(needsTests(join(d, 'src/testkit/x.ts'), d)).toBe(true);
    expect(needsTests(join(d, 'pkg/testkit/y.ts'), d)).toBe(true);
  });

  test('a repo that lives under a testkit/ dir does not exempt its own files', () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i28-')));
    dirs.push(outer);
    const top = join(outer, 'testkit', 'proj');
    write(top, 'testkit/testkit.config.json', CONFIG);
    write(top, 'src/a.ts', CODE);
    write(outer, 'testkit/testkit.config.json', CONFIG);
    expect(needsTests(join(top, 'src/a.ts'), top)).toBe(true);
    expect(needsTests(join(top, 'testkit/x.ts'), top)).toBe(false);
  });

  test('a symlinked marker does not count', () => {
    const d = tree(false, { 'conf/real.json': CONFIG });
    symlinkSync(join(d, 'conf', 'real.json'), join(d, 'testkit', 'testkit.config.json'));
    expect(needsTests(join(d, 'testkit/lib/driver.ts'), d)).toBe(true);
    expect(needsTests(join(d, '.testkit-run/capture.js'), d)).toBe(true);
  });

  test('a testkit/ dir that is a link into the product does not count, marker or not', () => {
    const d = tree(false, { 'src/kit/testkit.config.json': CONFIG, 'src/kit/lib/z.ts': CODE });
    rmSync(join(d, 'testkit'), { recursive: true, force: true });
    symlinkSync(join(d, 'src', 'kit'), join(d, 'testkit'));
    expect(needsTests(join(d, 'testkit/lib/z.ts'), d)).toBe(true);
  });

  test('a symlink below testkit/ is judged by its target', () => {
    const d = tree(true);
    symlinkSync(join(d, 'src', 'a.ts'), join(d, 'testkit', 'x.ts'));
    symlinkSync(join(d, 'testkit', 'lib', 'driver.ts'), join(d, 'testkit', 'y.ts'));
    expect(needsTests(join(d, 'testkit/x.ts'), d)).toBe(true);
    expect(needsTests(join(d, 'testkit/y.ts'), d)).toBe(false);
  });

  test('a hard link below testkit/ may share content with code, so it is code', () => {
    const d = tree(true);
    linkSync(join(d, 'src', 'a.ts'), join(d, 'testkit', 'linked.ts'));
    expect(needsTests(join(d, 'testkit/linked.ts'), d)).toBe(true);
    expect(needsTests(join(d, 'src/a.ts'), d)).toBe(true);
  });

  test('a deleted harness file needs no test; a path outside the root is not the harness', () => {
    const d = tree(true);
    expect(needsTests(join(d, 'testkit/lib/gone.ts'), d)).toBe(false);
    expect(isTestkitHarness(join(tmpdir(), 'testkit', 'x.ts'), d)).toBe(false);
  });
});

describe('the Stop test gate: a session that edits only testkit/ files', () => {
  const edits = ['testkit/lib/driver.ts', 'testkit/flows/login.flow', 'testkit/Dockerfile.app', 'testkit/sandbox.sh'];

  /** A committed repo, the session pinned there; the harness files are edited after. */
  async function stopAfterEditing(marker: boolean) {
    const d = tree(marker);
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const s = sid();
    pinCoverageStart(s, d);
    for (const rel of edits) {
      writeFileSync(join(d, rel), `${CODE}// changed\n`);
      recordEdit(s, join(d, rel), 0, undefined, Date.now());
    }
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
      cwd: d,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GOODBOY_TEST_GATE: 'on',
        GOODBOY_TEST_TYPES: 'on',
        GOODBOY_DIFF_COVERAGE: 'on',
        GOODBOY_EXISTING_TESTS: 'on',
        GOODBOY_DISABLE_DELEGATION: '1',
        GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
        GOODBOY_DOCS_GATE: 'off',
      },
    });
    const out = (await new Response(p.stdout).text()) || '{}';
    await p.exited;
    return JSON.parse(out) as { decision?: string; reason?: string };
  }
  const NO_RESULT = /No test result covers the changed code/;

  test('without the marker the test gate blocks on them', async () => {
    const out = await stopAfterEditing(false);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(NO_RESULT);
    expect(out.reason).toContain('testkit/lib/driver.ts');
  }, 60_000);

  test('with the marker the test gate asks nothing: no untested files, test types, line coverage or existing tests', async () => {
    const out = await stopAfterEditing(true);
    const reason = out.reason ?? '';
    expect(reason).not.toMatch(NO_RESULT);
    expect(reason).not.toContain('테스트 게이트');
    expect(reason).not.toContain('Test types missing');
    expect(reason).not.toMatch(/changed-line coverage/);
    expect(reason).not.toContain('Existing tests that cover the change');
  }, 60_000);
});
