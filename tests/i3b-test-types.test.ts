import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { addedUserGlobs, pinCoverageStart, repoTop, sessionUserGlobs } from '../lib/changed-coverage';
import { ensureSessionDir } from '../lib/file-tracker';
import {
  boundaryInContent,
  boundaryReason,
  missingTestTypes,
  testerFor,
  testTypesMode,
  typeGapReason,
  typeGapWarning,
  typeNeedOf,
} from '../lib/test-types';
import type { TestResult } from '../lib/types';

// Track I, I3b (#4, plan §15.6): test types per change kind. Every changed code file needs a
// test of any type; boundary code also needs an integration or e2e suite, UI code a ui or e2e
// suite. The user's `test-type-exempt:` globs take the extra types away.

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-i3b-'));
  dirs.push(d);
  return d;
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
// Every record needs evidence for one criterion (validateEvidence).
const ACCEPTANCE = [
  {
    id: 'AC-1',
    description: 'the server answers',
    test: 'tests/x.test.ts',
    red: { command: 'git stash && bun test', output: '1 fail', exit_code: 1 },
    green: { command: 'git stash pop && bun test', output: '1 pass', exit_code: 0 },
  },
];

describe('boundary code', () => {
  test('AC-1: found by a path word, a bin/ dir or a shell script', () => {
    const d = tmp();
    const why = (rel: string) => boundaryReason(join(d, rel), rel);
    for (const rel of ['lib/cli.ts', 'src/server/app.ts', 'routes/user.ts', 'src/userRoutes.ts', 'db/schema.sql', 'migrations/001_init.py', 'src/apiClient.ts', 'bin/run', 'scripts/deploy.sh']) {
      expect(why(rel)).not.toBeNull();
    }
    expect(why('lib/cli.ts')).toBe('path word `cli`');
    expect(why('src/userRoutes.ts')).toBe('path word `routes`');
    expect(why('src/HTTPServer.ts')).toBe('path word `http`');
    expect(why('src/APIClient.ts')).toBe('path word `api`');
    // Words, not substrings: `binary`, `preserve`, `observer` are not boundary words.
    for (const rel of ['lib/format.ts', 'src/binary.ts', 'lib/preserve.ts', 'src/observer.ts', 'README.md']) {
      expect(why(rel)).toBeNull();
    }
  });

  test('AC-2: found by content: JS/TS imports and calls, not in comments, strings or type imports', () => {
    const js = (text: string) => boundaryInContent(text, '.ts');
    expect(js("import { readFileSync } from 'node:fs';")).toBe('imports `fs`');
    expect(js("import { readFile } from 'fs/promises';")).toBe('imports `fs`');
    expect(js("const cp = require('child_process');")).toBe('imports `child_process`');
    expect(js("const { Client } = await import('pg');")).toBe('imports `pg`');
    expect(js("import { PrismaClient } from '@prisma/client';")).toBe('imports `@prisma/client`');
    expect(js("import { Database } from 'bun:sqlite';")).toBe('imports `bun:sqlite`');
    expect(js('const r = await fetch(url);')).toBe('calls `fetch(`');
    expect(js("Bun.spawn(['ls']);")).toBe('calls `Bun.spawn`');
    expect(js('await Bun.$`ls`;')).toBe('calls `Bun.$`');
    expect(js('const args = process.argv.slice(2);')).toBe('calls `process.argv`');
    expect(js('// we used to fetch(url) here\nconst s = "fetch(";\nexport const x = 1;')).toBeNull();
    expect(js("import type { Stats } from 'node:fs';\nexport type { Dirent } from 'fs';\nexport const f = (s: Stats) => s.size;")).toBeNull();
    expect(js("import { join } from 'node:path';\nexport const p = join('a', 'b');")).toBeNull();
    expect(js("import type {\n  Stats,\n  Dirent,\n} from 'node:fs';\nexport const n = 1;")).toBeNull();
    // Review medium: a comment or an earlier type statement never hides a real import.
    expect(js("// export type aliases from here\nimport { readFileSync } from 'node:fs';")).toBe('imports `fs`');
    expect(js("import type { A } from './a'\nconst cp = require('child_process')")).toBe('imports `child_process`');
    expect(js("import { readFileSync } /* export type x */ from 'node:fs';")).toBe('imports `fs`');
    expect(js("export type Id = string\nimport { readFileSync } from 'node:fs'")).toBe('imports `fs`');
    // Named IO imports from `bun`; other names from it are not IO.
    expect(js("import { $ } from 'bun';\nawait $`ls`;")).toBe('imports `$` from `bun`');
    expect(js("import { spawn as run, Glob } from 'bun';")).toBe('imports `spawn` from `bun`');
    expect(js("import { Glob } from 'bun';\nexport const g = new Glob('*');")).toBeNull();
  });

  test('AC-2: content checks stay fast and fail closed on too many specifiers', () => {
    const js = (text: string) => boundaryInContent(text, '.ts');
    const t0 = performance.now();
    expect(js('export type X = 1\n'.repeat(110_000))).toBeNull();
    expect(js(`import type { A } from './a'\n${' '.repeat(1_990)}`.repeat(4_900))).toBeNull();
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(js("import './a';\n".repeat(5_001))).toBe('over 5000 module specifiers');
  });

  test('AC-2: found by content: Python and Go', () => {
    const py = (text: string) => boundaryInContent(text, '.py');
    expect(py('import subprocess\n')).toBe('imports `subprocess`');
    expect(py('from requests import get\n')).toBe('imports `requests`');
    expect(py('with open(path) as f:\n    pass\n')).toBe('calls `open(`');
    expect(py('# import subprocess\nx = 1\n')).toBeNull();
    expect(py('import os, subprocess\n')).toBe('imports `subprocess`');
    expect(py('import socketserver\n')).toBe('imports `socketserver`');
    expect(py('import os, json\n')).toBeNull();
    const go = (text: string) => boundaryInContent(text, '.go');
    expect(go('import (\n\t"os/exec"\n)\n')).toBe('imports `os/exec`');
    expect(go('b, _ := os.ReadFile(p)\n')).toBe('calls `os.ReadFile(`');
    expect(go('// os.ReadFile(p)\nx := 1\n')).toBeNull();
    // Other languages: by path only.
    expect(boundaryInContent('File.read("x")', '.rb')).toBeNull();
  });

  test('AC-2: content that cannot be read as a regular file counts as boundary; a deleted file does not', () => {
    const d = tmp();
    const fifo = join(d, 'lib', 'pipe.ts');
    mkdirSync(dirname(fifo), { recursive: true });
    expect(sh(d, `mkfifo ${JSON.stringify(fifo)}`).exitCode).toBe(0);
    expect(boundaryReason(fifo, 'lib/pipe.ts')).toContain('not readable');
    const big = write(d, 'lib/big.ts', `export const s = ${JSON.stringify('x'.repeat(2_100_000))};\n`);
    expect(boundaryReason(big, 'lib/big.ts')).toContain('not readable');
    expect(boundaryReason(join(d, 'lib/gone.ts'), 'lib/gone.ts')).toBeNull();
    const plain = write(d, 'lib/plain.ts', 'export const a = 1;\n');
    expect(boundaryReason(plain, 'lib/plain.ts')).toBeNull();
  });
});

describe('the types a file needs', () => {
  test('AC-3: UI files need ui, boundary files integration, both when both; the user exempts', () => {
    const d = tmp();
    const need = (rel: string, text: string, exempt: string[] = []) => typeNeedOf(write(d, rel, text), d, exempt)?.types ?? [];
    expect(need('src/App.tsx', 'export const App = () => null;\n')).toEqual(['ui']);
    expect(need('src/Card.vue', '<template><p/></template>\n')).toEqual(['ui']);
    expect(need('src/client/state.ts', 'export const s = 1;\n')).toEqual(['ui']);
    expect(need('src/Upload.tsx', "import { readFile } from 'node:fs';\n")).toEqual(['integration', 'ui']);
    expect(need('lib/store.ts', "import { Database } from 'bun:sqlite';\n")).toEqual(['integration']);
    expect(need('lib/math.ts', 'export const add = (a: number, b: number) => a + b;\n')).toEqual([]);
    expect(need('lib/cli.ts', 'export {};\n', ['lib/cli.ts'])).toEqual([]);
    // A `client` path is UI unless it is boundary code; a deleted file needs nothing.
    expect(need('src/db/client.ts', 'export {};\n')).toEqual(['integration']);
    expect(need('src/client/view.ts', 'export {};\n')).toEqual(['ui']);
    expect(typeNeedOf(join(d, 'src/server/gone.ts'), d, [])).toBeNull();
    expect(need('src/Login.tsx', 'export {};\n', ['src/**'])).toEqual([]);
    // Outside the repo top: none.
    const other = tmp();
    expect(typeNeedOf(write(other, 'server.ts', 'x'), d, [])).toBeNull();
  });

  test('AC-5: the tester: test-lead when the change needs ui and another type', () => {
    const ui = { abs: '/r/a.tsx', rel: 'a.tsx', types: ['ui' as const], why: {} };
    const io = { abs: '/r/s.ts', rel: 's.ts', types: ['integration' as const], why: {} };
    expect(testerFor([null])).toBe('test-unit');
    expect(testerFor([io, null])).toBe('test-unit');
    expect(testerFor([ui])).toBe('test-ui');
    expect(testerFor([ui, null])).toBe('test-lead');
    expect(testerFor([ui, io])).toBe('test-lead');
  });

  test('AC-8: GOODBOY_TEST_TYPES is on by default, warn and off as set', () => {
    expect(testTypesMode({})).toBe('on');
    expect(testTypesMode({ GOODBOY_TEST_TYPES: ' WARN ' })).toBe('warn');
    expect(testTypesMode({ GOODBOY_TEST_TYPES: 'off' })).toBe('off');
    expect(testTypesMode({ GOODBOY_TEST_TYPES: 'nonsense' })).toBe('on');
  });
});

describe('missing types', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  function record(d: string, files: string[], suites: Array<Partial<TestResult['suites'][number]>>, over: Partial<TestResult> = {}): TestResult {
    const testFile = write(d, 'tests/x.test.ts', 'test("x", () => { expect(1).toBe(1); });\n');
    return {
      timestamp: at(1_000),
      tested_files: files,
      category: 'add-feature',
      test_files: [testFile],
      environment: { mode: 'local' },
      suites: suites.map((s, i) => ({ name: `s${i}`, command: 'bun test', passed: 2, failed: 0, output: '2 pass', duration_ms: 5, ...s })),
      acceptance: ACCEPTANCE,
      verdict: 'pass',
      ...over,
    } as TestResult;
  }

  test('AC-4: a type counts from a passing, fresh suite of a satisfying type in a record that lists the file', () => {
    const d = tmp();
    const server = write(d, 'src/server.ts', 'export {};\n');
    const edits = [{ file: server, lastEditTimestamp: at(5_000) }];
    const gaps = (results: TestResult[], accepted: TestResult[] = results) =>
      missingTestTypes({ results, accepted: new Set(accepted), edits, top: d, exempt: [] }).gaps.map((g) => `${g.rel}:${g.missing.join(',')}`);
    expect(gaps([record(d, [server], [{ type: 'unit' }])])).toEqual(['src/server.ts:integration']);
    expect(gaps([record(d, [server], [{ type: 'unit' }, { type: 'integration' }])])).toEqual([]);
    expect(gaps([record(d, [server], [{ type: 'e2e' }])])).toEqual([]);
    // Not counted: a stale record, another file's record, a failing or empty suite, a failed
    //   verdict, a suite without a type.
    expect(gaps([record(d, [server], [{ type: 'integration' }], { timestamp: at(10_000) })])).toEqual(['src/server.ts:integration']);
    expect(gaps([record(d, [join(d, 'src/other.ts')], [{ type: 'integration' }])])).toEqual(['src/server.ts:integration']);
    expect(gaps([record(d, [server], [{ type: 'integration', failed: 1 }])])).toEqual(['src/server.ts:integration']);
    expect(gaps([record(d, [server], [{ type: 'integration', passed: 0 }])])).toEqual(['src/server.ts:integration']);
    expect(gaps([record(d, [server], [{ type: 'integration' }], { verdict: 'fail' })])).toEqual(['src/server.ts:integration']);
    expect(gaps([record(d, [server], [{}])])).toEqual(['src/server.ts:integration']);
    // A timestamp too far in the future is not trusted.
    expect(gaps([record(d, [server], [{ type: 'integration' }], { timestamp: new Date(Date.now() + 86_400_000).toISOString() })])).toEqual(['src/server.ts:integration']);
    // An accepted record counts as it is; any other only when it stands alone.
    const r = record(d, [server], [{ type: 'integration' }]);
    const run = (accepted: TestResult[]) =>
      missingTestTypes({ results: [r], accepted: new Set(accepted), edits, top: d, exempt: [], standsAlone: () => false }).gaps.length;
    expect(run([r])).toBe(0);
    expect(run([])).toBe(1);
    // A file that needs no extra type has no gap.
    const math = write(d, 'lib/math.ts', 'export const a = 1;\n');
    expect(missingTestTypes({ results: [], accepted: new Set(), edits: [{ file: math, lastEditTimestamp: at(5_000) }], top: d, exempt: [] }).gaps).toEqual([]);
  });

  test("AC-4: a test-lead run's member records add up; one outside the accepted set must stand alone", () => {
    const d = tmp();
    const upload = write(d, 'src/Upload.tsx', "import { readFile } from 'node:fs';\n");
    const edits = [{ file: upload, lastEditTimestamp: at(5_000) }];
    const unit = record(d, [upload], [{ type: 'integration' }]);
    const ui = record(d, [upload], [{ type: 'ui' }], { timestamp: at(500) });
    const run = (accepted: TestResult[]) =>
      missingTestTypes({ results: [ui, unit], accepted: new Set(accepted), edits, top: d, exempt: [] }).gaps.map((g) => g.missing.join(','));
    expect(run([ui])).toEqual([]);
    // A record whose test file is gone does not stand alone.
    const lost = { ...unit, test_files: [join(d, 'tests/gone.test.ts')] };
    expect(missingTestTypes({ results: [ui, lost], accepted: new Set([ui]), edits, top: d, exempt: [] }).gaps.map((g) => g.missing.join(','))).toEqual(['integration']);
  });

  test('AC-4: the messages name each file, its missing types and why, and the user exemption', () => {
    const gaps = [{ rel: 'lib/db.ts', missing: ['integration' as const], why: { integration: 'imports `pg`' } }];
    const reason = typeGapReason(gaps, 'goodboy:test-unit');
    expect(reason).toContain('lib/db.ts needs an integration or e2e suite (imports `pg`)');
    expect(reason).toContain('goodboy:test-unit');
    expect(reason).toContain('test-type-exempt:');
    expect(typeGapWarning(gaps)).toContain('lib/db.ts: 통합(또는 E2E)');
  });
});

describe('the user globs', () => {
  const human = (key: string, globs: string) => ['## P1 Fixtures', '- decide: human', '- source: user 2026-10-17', `- ${key}: ${globs}`, ''].join('\n');

  test('AC-7: test-type-exempt is a user glob, pinned at the session start', () => {
    expect(addedUserGlobs('', human('test-type-exempt', 'scripts/**'))).toEqual([{ key: 'test-type-exempt', glob: 'scripts/**' }]);
    const d = tmp();
    sh(d, 'git init -q .');
    write(d, '.goodboy/policy.md', human('test-type-exempt', 'scripts/**'));
    const s = `i3b-${Math.random().toString(36).slice(2, 10)}`;
    dirs.push(join(tmpdir(), `goodboy-session-${s}`));
    pinCoverageStart(s, d);
    const pin = JSON.parse(readFileSync(join(ensureSessionDir(s), 'coverage-pin.json'), 'utf8')) as { globs?: Record<string, string[]> };
    expect(pin.globs?.['test-type-exempt']).toEqual(['scripts/**']);
    expect(sessionUserGlobs(s, d, repoTop(d), 'test-type-exempt')).toEqual(['scripts/**']);
  });

  function box() {
    const b = tmp();
    const cwd = join(b, 'proj');
    mkdirSync(cwd);
    sh(cwd, 'git init -q . && printf \'{"scripts":{"test":"bun test"}}\' > package.json');
    return { b, cwd, s: `i3bh-${Math.random().toString(36).slice(2)}` };
  }
  type Box = ReturnType<typeof box>;
  async function hook(x: Box, script: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', script)], {
      cwd: x.cwd,
      env: { ...process.env, TMPDIR: x.b, HOME: x.b, CLAUDE_PLUGIN_ROOT: ROOT, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_POLICY_GATE: 'off', ...env },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: x.s, cwd: x.cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }

  test('AC-7: PreToolUse denies adding a test-type-exempt glob while the rule is on', async () => {
    const x = box();
    const policy = join(x.cwd, '.goodboy', 'policy.md');
    const add = (env: Record<string, string>) =>
      hook(x, 'pre-tool-use.ts', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: policy, content: human('test-type-exempt', 'scripts/**') } }, env);
    const on = await add({ GOODBOY_TEST_TYPES: 'on' });
    expect(on).toContain('"permissionDecision":"deny"');
    expect(on).toContain('Only the user exempts files from the test-type rule');
    expect(await add({ GOODBOY_TEST_TYPES: 'off' })).not.toContain('"permissionDecision":"deny"');
  }, 30_000);

  // The Stop: a boundary file edited, a passing record with a unit suite only.
  async function stopWith(x: Box, env: Record<string, string>, opts: { policy?: string; record?: boolean; file?: string; types?: string[] } = {}) {
    if (opts.policy) write(x.cwd, '.goodboy/policy.md', opts.policy);
    await hook(x, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });
    const file = write(x.cwd, opts.file ?? 'src/server.ts', 'export const port = 1;\n');
    await hook(x, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file } });
    if (opts.record !== false) {
      const testFile = write(x.cwd, 'tests/server.test.ts', 'test("x", () => { expect(1).toBe(1); });\n');
      // One record per type, the first one oldest (a test-lead run: one record per member).
      (opts.types ?? ['unit']).forEach((type, i) => write(
        x.cwd,
        `.claude/tests/result-${i}.json`,
        JSON.stringify({
          timestamp: new Date(Date.now() + 1_000 + i * 1_000).toISOString(),
          tested_files: [file],
          category: 'add-feature',
          test_files: [testFile],
          environment: { mode: 'local' },
          suites: [{ name: type, command: 'bun test', passed: 1, failed: 0, output: '1 pass', type, duration_ms: 3 }],
          acceptance: ACCEPTANCE,
          verdict: 'pass',
        }),
      ));
    }
    return hook(x, 'stop.ts', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'on', GOODBOY_DIFF_COVERAGE: 'off', ...env });
  }

  test('AC-6: the Stop blocks a boundary file tested by a unit suite only; warn tells the user; off skips', async () => {
    const on = await stopWith(box(), { GOODBOY_TEST_TYPES: 'on' });
    expect(on).toContain('Test types missing: src/server.ts needs an integration or e2e suite (path word `server`)');
    const warn = await stopWith(box(), { GOODBOY_TEST_TYPES: 'warn' });
    expect(warn).not.toContain('Test types missing');
    expect(warn).toContain('테스트 유형(경고 모드)');
    const off = await stopWith(box(), { GOODBOY_TEST_TYPES: 'off' });
    expect(off).not.toContain('Test types missing');
    expect(off).not.toContain('테스트 유형');
  }, 90_000);

  test('AC-6: the Stop adds up member records: an older integration record next to a newer unit one', async () => {
    const out = await stopWith(box(), { GOODBOY_TEST_TYPES: 'on' }, { types: ['integration', 'unit'] });
    expect(out).not.toContain('Test types missing');
    expect(await stopWith(box(), { GOODBOY_TEST_TYPES: 'on' }, { types: ['unit', 'unit'] })).toContain('Test types missing');
  }, 60_000);

  test("AC-6: the Stop honours the user's pinned test-type-exempt glob", async () => {
    const out = await stopWith(box(), { GOODBOY_TEST_TYPES: 'on' }, { policy: human('test-type-exempt', 'src/server.ts') });
    expect(out).not.toContain('Test types missing');
  }, 60_000);

  test('AC-5: with no record, the block names the types and a checked tester', async () => {
    const io = await stopWith(box(), { GOODBOY_TEST_TYPES: 'on' }, { record: false });
    expect(io).toContain('src/server.ts: integration or e2e (path word `server`)');
    expect(io).toContain('goodboy:test-unit');
    const ui = await stopWith(box(), { GOODBOY_TEST_TYPES: 'on' }, { record: false, file: 'src/App.tsx' });
    expect(ui).toContain('src/App.tsx: ui or e2e (a UI file)');
    // test-ui has no capability check yet (CHECKED_ROLES, plan §10.3): the gate names test-unit.
    expect(ui).toContain('goodboy:test-unit');
    expect(ui).not.toContain('goodboy:test-ui');
    const off = await stopWith(box(), { GOODBOY_TEST_TYPES: 'off' }, { record: false });
    expect(off).toContain('goodboy:test-unit to write and run unit and integration tests');
  }, 90_000);
});
