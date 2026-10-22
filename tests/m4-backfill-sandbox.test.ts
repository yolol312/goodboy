// Track M, M4 (§19): the backfill workflow with a sandbox. A project with
// `.goodboy/sandbox/compose.yml` counts a record as evidence only when it carries the sandbox
// check; test-write accepts and validates that object; the run-sandbox skill is registered for
// the three test agents. Repos are temporary.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { validateTestResultInput } from '../lib/cli';
import { ROLES } from '../lib/routing-policy';
import { backfillSummary, emptyBackfill, evidenceProblem, markTarget } from '../lib/test-backfill';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function project(sandbox: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m4-')));
  tmpDirs.push(root);
  const files: Record<string, string> = { 'src/a.ts': 'x', 'src/a.test.ts': 't' };
  if (sandbox) files['.goodboy/sandbox/compose.yml'] = 'services: {}\n';
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** A passing record for src/a.ts as the L tests build it, plus the sandbox object when given. */
function record(root: string, sandbox?: unknown): TestResult {
  return {
    timestamp: new Date(Date.now() + 1000).toISOString(),
    tested_files: [join(root, 'src/a.ts')],
    category: 'backfill-tests',
    test_files: [join(root, 'src/a.test.ts')],
    environment: { mode: 'container' },
    suites: [{ name: 'unit', command: 'bun test src/a.test.ts', passed: 3, failed: 0, output: '3 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [
      {
        id: 'BF-1',
        description: 'pins the current behavior',
        test: 'src/a.test.ts',
        red: { command: 'bun test (target broken in a scratch copy)', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test', output: '3 pass', exit_code: 0 },
        mutation: { command: 'sed (scratch copy)', output: '1 fail', detected: true, file: 'src/a.ts' },
      },
    ],
    verdict: 'pass',
    ...(sandbox !== undefined ? { sandbox } : {}),
  } as TestResult;
}

const CHECK = { inner_only: true, egress_blocked: true, hosts_to_dummies: true, run: '2026-10-22T10-00-00Z' };

describe('M4: backfill evidence with a sandbox', () => {
  test('without a sandbox the evidence is unchanged: no sandbox object needed', () => {
    const root = project(false);
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [record(root)])).toBeNull();
    // An object that says the run was outside the sandbox does not matter here.
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [record(root, { inner_only: false, egress_blocked: false })])).toBeNull();
  });

  test('with a sandbox a record without the check, or with a false flag, is refused', () => {
    const root = project(true);
    const refused = (r: TestResult) => String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [r]));
    expect(refused(record(root))).toContain('the project has a sandbox');
    expect(refused(record(root))).toContain('sandbox: {inner_only: true, egress_blocked: true}');
    expect(refused(record(root, { inner_only: false, egress_blocked: true }))).toContain('the project has a sandbox');
    expect(refused(record(root, { inner_only: true, egress_blocked: false }))).toContain('the project has a sandbox');
    // Only a strict true counts: a truthy string is no proof.
    expect(refused(record(root, { inner_only: 'true', egress_blocked: true }))).toContain('the project has a sandbox');
    expect(refused(record(root, { inner_only: true }))).toContain('the project has a sandbox');
  });

  test('with a sandbox a record carrying both flags true is accepted, even without the other fields', () => {
    const root = project(true);
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [record(root, CHECK)])).toBeNull();
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [record(root, { inner_only: true, egress_blocked: true })])).toBeNull();
  });

  test('a record without the flags does not count beside one that has them; the other checks stay', () => {
    const root = project(true);
    const plain = record(root);
    // The sandboxed record has no mutation: the unsandboxed one cannot make up for it.
    const noMutation = { ...record(root, CHECK), acceptance: [{ ...record(root).acceptance[0]!, mutation: undefined }] } as TestResult;
    expect(String(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [plain, noMutation]))).toContain('whose mutation of src/a.ts');
    const withMutation = { ...record(root, CHECK), acceptance: record(root).acceptance };
    expect(evidenceProblem(root, root, 'src/a.ts', ['src/a.test.ts'], [plain, withMutation])).toBeNull();
    // A passing record that names another target says nothing about the sandbox of this one.
    expect(String(evidenceProblem(root, root, 'src/b.ts', ['src/a.test.ts'], [record(root, CHECK)]))).toContain('names src/b.ts');
  });

  test('backfill-mark refuses done and suspect without the check, then accepts with it', () => {
    const root = project(true);
    const s = emptyBackfill();
    s.targets = [{ rel: 'src/a.ts', kind: 'code', needs: ['any'], why: 'w', bytes: 1, status: 'todo' }];
    const m = (status: 'done' | 'suspect', r: TestResult) => markTarget(s, root, root, { rel: 'src/a.ts', status, tests: ['src/a.test.ts'], note: 'looks wrong' }, undefined, [r]);
    expect(String(m('done', record(root)))).toContain('the project has a sandbox');
    expect(String(m('suspect', record(root, { inner_only: false, egress_blocked: false })))).toContain('run the suites with sandbox-run');
    expect(s.targets[0]!.status).toBe('todo');
    expect(m('suspect', record(root, CHECK))).toBeNull();
    expect(m('done', record(root, CHECK))).toBeNull();
    expect(s.targets[0]!.status).toBe('done');
  });

  test('skipped needs no record, sandbox or not', () => {
    const root = project(true);
    const s = emptyBackfill();
    s.targets = [{ rel: 'src/a.ts', kind: 'code', needs: ['any'], why: 'w', bytes: 1, status: 'todo' }];
    expect(markTarget(s, root, root, { rel: 'src/a.ts', status: 'skipped', tests: [], note: 'the user declined' }, undefined, [])).toBeNull();
  });

  test('the summary goal is complete with a sandbox, else batches', () => {
    const s = emptyBackfill();
    expect(backfillSummary(s, project(true)).goal).toBe('complete');
    expect(backfillSummary(s, project(false)).goal).toBe('batches');
    expect(backfillSummary(s).goal).toBe('batches');
  });

  test('CLI: backfill-status prints the goal from the repo, and a mark needs the check', () => {
    const root = project(true);
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    expect(JSON.parse(run('backfill-plan').out)).toMatchObject({ goal: 'complete' });
    expect(JSON.parse(run('backfill-status').out)).toMatchObject({ goal: 'complete' });
    mkdirSync(join(root, '.claude', 'tests'), { recursive: true });
    writeFileSync(join(root, '.claude', 'tests', '2026-10-22T00-00-00.json'), JSON.stringify(record(root)));
    const refused = run('backfill-mark', 'src/a.ts', '--status', 'done', '--tests', 'src/a.test.ts');
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('the project has a sandbox');
  });
});

describe('M4: test-write and the sandbox object', () => {
  const input = (sandbox?: unknown) => ({
    tested_files: ['/r/src/a.ts'],
    category: 'backfill-tests',
    test_files: [join(ROOT, 'lib', 'cli.ts')],
    environment: { mode: 'container' },
    suites: [{ name: 'unit', command: 'c', passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 5 }],
    acceptance: [],
    verdict: 'pass',
    ...(sandbox !== undefined ? { sandbox } : {}),
  });

  test('a valid object is kept with its known fields; none is fine', () => {
    expect(validateTestResultInput(input()).value!.sandbox).toBeUndefined();
    const ok = validateTestResultInput(input(CHECK));
    expect([ok.ok, ok.value!.sandbox]).toEqual([true, CHECK]);
    const min = validateTestResultInput(input({ inner_only: true, egress_blocked: false, extra: 'dropped' }));
    expect([min.ok, min.value!.sandbox]).toEqual([true, { inner_only: true, egress_blocked: false }]);
  });

  test('other types are rejected, each with its field named', () => {
    const errors = (v: unknown) => validateTestResultInput(input(v)).errors.join('\n');
    expect(errors('yes')).toContain('sandbox must be');
    expect(errors(null)).toContain('sandbox must be');
    expect(errors([true, true])).toContain('sandbox must be');
    expect(errors({})).toContain('sandbox.inner_only must be a boolean');
    expect(errors({})).toContain('sandbox.egress_blocked must be a boolean');
    expect(errors({ inner_only: 'true', egress_blocked: true })).toContain('sandbox.inner_only must be a boolean');
    expect(errors({ inner_only: true, egress_blocked: 1 })).toContain('sandbox.egress_blocked must be a boolean');
    expect(errors({ inner_only: true, egress_blocked: true, hosts_to_dummies: 'yes' })).toContain('sandbox.hosts_to_dummies must be a boolean');
    expect(errors({ inner_only: true, egress_blocked: true, run: 5 })).toContain('sandbox.run must be');
    expect(errors({ inner_only: true, egress_blocked: true, run: ' ' })).toContain('sandbox.run must be');
    expect(validateTestResultInput(input({ inner_only: true })).ok).toBe(false);
  });
});

describe('M4: the run-sandbox skill', () => {
  const skill = () => readFileSync(join(ROOT, 'skills', 'run-sandbox', 'SKILL.md'), 'utf8');

  test('the three test agents list it, and their files name it', () => {
    for (const name of ['test-unit', 'test-ui', 'test-spec']) {
      expect([name, ROLES.find((r) => r.name === name)!.toolSkills.includes('run-sandbox')]).toEqual([name, true]);
      expect([name, /\brun-sandbox\b/.test(readFileSync(join(ROOT, 'agents', `${name}.md`), 'utf8'))]).toEqual([name, true]);
    }
    for (const name of ['test-lead', 'test-security', 'test-probe', 'build-run']) {
      expect([name, ROLES.find((r) => r.name === name)!.toolSkills.includes('run-sandbox')]).toEqual([name, false]);
    }
  });

  test('it names the commands, the fixture, the record field and the never rules', () => {
    const t = skill();
    for (const need of ['sandbox-check', 'sandbox-run --suite unit|e2e|all', 'coverage-check', '--root-map /work=.', 'ui-check --run', 'ui-inventory', 'uiTest', '.goodboy/sandbox/e2e/goodboy-ui', '<id>:ok', '<id>:error', 'input: true', 'sandbox: {inner_only', 'characterization']) {
      expect([need, t.includes(need)]).toEqual([need, true]);
    }
    expect(t).toContain('Never point a test, a config or a command at a real host');
    expect(t).toContain('Never put rows or personal data from the database copy');
    expect(t).toContain('Never keep the traces of a passing run');
  });

  test('backfill-tests and setup-test-infra point to the sandbox', () => {
    const bf = readFileSync(join(ROOT, 'skills', 'backfill-tests', 'SKILL.md'), 'utf8');
    for (const need of ['sandbox-scan', 'sandbox-local --dump', 'sandbox-init', 'sandbox-prepare', 'sandbox-up', 'sandbox-check', 'run-sandbox', 'coverage-check', 'ui-check', 'ui-inventory', 'coverage-exempt:', 'keep-project-knowledge']) {
      expect([need, bf.includes(need)]).toEqual([need, true]);
    }
    expect(readFileSync(join(ROOT, 'skills', 'setup-test-infra', 'SKILL.md'), 'utf8')).toContain('run-sandbox');
  });
});
