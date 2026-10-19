import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { classifyOutward } from '../lib/outward-command';
import { knowledgeSessionNotice } from '../lib/project-knowledge';
import { checkHandoff, docsOnlyBases, pushTestMessage, revisionTree, workTreeState } from '../lib/push-test';
import { type RegressionRecord, writeRegressionRecord } from '../lib/regression';
import { resultDirWrite } from '../lib/role-limits';
import type { TestResult } from '../lib/types';

// Track I, I6 (#13, plan §15.9): fixes for what the first real-use trial ran into.

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-i6-'));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
/** A repo with code and a test, pushed to a local bare remote (origin/main is the base). */
function repo(): { base: string; cwd: string } {
  const base = tmp();
  const cwd = join(base, 'repo');
  mkdirSync(cwd);
  git(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  write(cwd, 'src/a.ts', 'export const a = 1;\n');
  write(cwd, 'a.test.ts', 'test("a", () => {});\n');
  write(cwd, 'README.md', '# app\n');
  write(cwd, '.gitignore', '.claude/\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  git(cwd, 'remote', 'add', 'origin', join(base, 'remote.git'));
  git(cwd, 'push', '-q', 'origin', 'main');
  return { base, cwd };
}

/** A layer-1 result with the evidence the push check asks for (tree added by `test-write`). */
function passingResult(cwd: string): Record<string, unknown> {
  return {
    tested_files: [],
    category: 'add-feature',
    test_files: [join(cwd, 'a.test.ts')],
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 5 }],
    acceptance: [
      { id: 'AC-1', description: 'a is 1', test: 'a.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } },
    ],
    verdict: 'pass',
  };
}
function regression(tree: string, verdict: 'pass' | 'fail'): RegressionRecord {
  return {
    timestamp: new Date().toISOString(),
    commit: null,
    tree,
    tree_after: tree,
    source: 'package.json scripts.test',
    runs: [{ command: 'bun run test', exit_code: verdict === 'pass' ? 0 : 1, duration_ms: 5, output_tail: verdict }],
    duration_ms: 5,
    verdict,
  };
}

describe('finding 1: the project knowledge notice', () => {
  test('AC-1: a missing policy file waits until the task is done; it does not ask first', () => {
    const { cwd } = repo();
    const n = knowledgeSessionNotice(cwd, `i6-${Math.random().toString(36).slice(2)}`);
    expect(n.context).toContain("Do the user's task first; do not ask about it before.");
    expect(n.context).toContain('A directory with a git repo and source code is a project.');
    expect(n.context).not.toContain('Before the first task');
    expect(n.systemMessage).toContain('작업을 마친 뒤 만들지 여쭤볼게요');
  });
});

describe('findings 2–4 and 6: the push test check', () => {
  const passing = (tree: string, over: Partial<TestResult> = {}): TestResult =>
    ({
      timestamp: new Date().toISOString(),
      tested_files: [],
      category: 'add-feature',
      test_files: [join(ROOT, 'tests', 'i6-trial-fixes.test.ts')],
      environment: { mode: 'local' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 5 }],
      acceptance: [
        { id: 'AC-1', description: 'a', test: 'a.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 pass', exit_code: 0 } },
      ],
      verdict: 'pass',
      tree,
      ...over,
    }) as TestResult;

  test('AC-2: prose on top of a tested tree needs no new result; nothing else does', () => {
    const { cwd } = repo();
    const tested = revisionTree(cwd, 'HEAD')!;
    const commit = (files: Record<string, string>): string => {
      for (const [rel, text] of Object.entries(files)) write(cwd, rel, text);
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'c');
      return revisionTree(cwd, 'HEAD')!;
    };
    const docs = commit({ 'docs/guide.md': '# guide\n', 'README.md': '# app\n\nMore.\n', 'CHANGELOG.md': '- x\n' });
    expect(docsOnlyBases(cwd, 'HEAD', docs, [tested, 'f'.repeat(40), tested])).toEqual([tested, tested]);
    const h = { kind: 'push' as const, what: 'git push origin main', cwd, revs: ['HEAD'] };
    expect(checkHandoff(h, [], () => docs, () => null, () => [tested])).toEqual({ ok: true, docsOnly: { HEAD: [tested] } });
    // Not when the tree handed off has a failed result of its own (a README doctest).
    const failed = { verdict: 'fail', tree: docs, suites: [], test_files: [], acceptance: [] } as unknown as TestResult;
    expect(checkHandoff(h, [failed], () => docs, () => null, () => [tested])).toMatchObject({ ok: false, why: 'no-result', rejected: 'its verdict is fail' });
    // No tested tree under it (what the remote has does not count: refs/remotes are the
    //   model's to move), a deploy of the working tree, and code are not.
    expect(docsOnlyBases(cwd, 'HEAD', docs, [])).toEqual([]);
    expect(docsOnlyBases(cwd, ':worktree', docs, [tested])).toEqual([]);
    const docsCommit = git(cwd, 'rev-parse', 'HEAD');
    const code = commit({ 'src/a.ts': 'export const a = 2;\n' });
    expect(docsOnlyBases(cwd, 'HEAD', code, [tested])).toEqual([]);
    // Replace refs do not make code read as prose, or a commit read as a tested one.
    git(cwd, 'replace', code, docs);
    expect(docsOnlyBases(cwd, 'HEAD', code, [tested])).toEqual([]);
    git(cwd, 'replace', 'HEAD', docsCommit);
    expect(revisionTree(cwd, 'HEAD')).toBe(code);
    git(cwd, 'replace', '-d', ...git(cwd, 'replace', '-l').split('\n'));
    // Files a run reads are not prose: dependency lists, a prompt the app loads, a skill that
    //   tests assert, a docs/ requirements file.
    for (const rel of ['requirements/prod.txt', 'dev-requirements.txt', 'runtime.txt', 'src/prompts/system.md', 'skills/x/SKILL.md', 'docs/requirements.txt', 'docs/conf.py']) {
      const t = commit({ [rel]: `${rel}\n` });
      expect([rel, docsOnlyBases(cwd, 'HEAD', t, [code])]).toEqual([rel, []]);
      git(cwd, 'reset', '-q', '--hard', 'HEAD~1');
    }
  }, 30_000);

  test('AC-2: a submodule bump or a symlink beside the prose is no docs-only change, whatever the config says', () => {
    const { cwd } = repo();
    const sha = (c: string) => c.repeat(40);
    const gitlink = (c: string) => git(cwd, 'update-index', '--add', '--cacheinfo', `160000,${sha(c)},vendor/lib`);
    write(cwd, '.gitmodules', '[submodule "lib"]\n\tpath = vendor/lib\n\turl = ./lib\n\tignore = all\n');
    git(cwd, 'add', '.gitmodules');
    gitlink('a');
    git(cwd, 'commit', '-q', '-m', 'sub');
    git(cwd, 'config', 'diff.ignoreSubmodules', 'all');
    git(cwd, 'config', 'diff.relative', 'true');
    const tested = revisionTree(cwd, 'HEAD')!;
    gitlink('b');
    write(cwd, 'docs/guide.md', '# guide\n');
    git(cwd, 'add', 'docs/guide.md');
    git(cwd, 'commit', '-q', '-m', 'bump');
    expect(docsOnlyBases(join(cwd, 'docs'), 'HEAD', revisionTree(cwd, 'HEAD')!, [tested])).toEqual([]);
    git(cwd, 'reset', '-q', '--hard', 'HEAD~1');
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    symlinkSync('../src/a.ts', join(cwd, 'docs', 'run.md'));
    git(cwd, 'add', 'docs/run.md');
    git(cwd, 'commit', '-q', '-m', 'link');
    expect(docsOnlyBases(cwd, 'HEAD', revisionTree(cwd, 'HEAD')!, [tested])).toEqual([]);
  }, 30_000);

  test('AC-3: a result for exactly the tree that does not count says why; the denial names the marker', () => {
    const tree = 'c'.repeat(40);
    const h = { kind: 'push' as const, what: 'git push origin main', cwd: '/x', revs: ['HEAD'] };
    const o = checkHandoff(h, [passing(tree, { acceptance: [] })], () => tree, () => null, () => []);
    expect(o).toMatchObject({ ok: false, why: 'no-result', rejected: 'it has no acceptance criterion with red-green evidence' });
    const msg = pushTestMessage(h.what, o as Exclude<typeof o, { ok: true }>, '.claude/.goodboy-push-test-approved-abc.txt');
    expect(msg).toContain('A result for exactly this tree exists but does not count: it has no acceptance criterion with red-green evidence.');
    expect(msg).toContain('they run `! touch .claude/.goodboy-push-test-approved-abc.txt` (this once)');
    expect(msg).toContain('Commits that change only prose');
    // A failing verdict and a passing result say so too; a subagent gets no marker.
    expect(checkHandoff(h, [passing(tree, { verdict: 'fail' })], () => tree, () => null, () => [])).toMatchObject({ rejected: 'its verdict is fail' });
    expect(checkHandoff(h, [passing(tree)], () => tree, () => null, () => [])).toEqual({ ok: true });
    // Evidence that is there but does not hold is not called missing.
    const badGreen = { id: 'AC-1', description: 'a', test: 'a.test.ts', red: { command: 'bun test', output: '1 fail', exit_code: 1 }, green: { command: 'bun test', output: '1 fail', exit_code: 1 } };
    expect(checkHandoff(h, [passing(tree, { acceptance: [badGreen] } as Partial<TestResult>)], () => tree, () => null, () => [])).toMatchObject({
      rejected: "an acceptance criterion's red-green evidence does not hold (its red run, green run or mutation probe)",
    });
    expect(pushTestMessage(h.what, o as Exclude<typeof o, { ok: true }>)).not.toContain('! touch');
  });

  test("AC-6: goodboy's own project files never count as content, untracked or committed; other files there do", () => {
    const { cwd } = repo();
    const before = workTreeState(cwd).tree;
    write(cwd, '.goodboy/policy.md', '# Project policy\n');
    write(cwd, '.goodboy/docs.json', '{"docs":[]}\n');
    expect(workTreeState(cwd).tree).toBe(before);
    expect(workTreeState(cwd).tree).toBe(revisionTree(cwd, 'HEAD'));
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'policy');
    expect(revisionTree(cwd, 'HEAD')).toBe(before);
    // Other content still counts, under .goodboy/ too (code the project may load), and so does
    //   a directory named like one of goodboy's files.
    write(cwd, '.goodboy/hosts/loader.ts', 'export const x = 1;\n');
    expect(workTreeState(cwd).tree).not.toBe(before);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'loader');
    expect(revisionTree(cwd, 'HEAD')).not.toBe(before);
    rmSync(join(cwd, '.goodboy', 'hosts'), { recursive: true });
    git(cwd, 'commit', '-qam', 'no loader');
    expect(revisionTree(cwd, 'HEAD')).toBe(before);
    write(cwd, '.goodboy/settings.py', 'X = 1\n');
    expect(workTreeState(cwd).tree).not.toBe(before);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'settings');
    expect(revisionTree(cwd, 'HEAD')).not.toBe(before);
    expect(revisionTree(cwd, 'HEAD')).toBe(workTreeState(cwd).tree);
  }, 30_000);

  test('AC-2: through the hook, prose on a tested tree needs that tree\'s regression; code is denied with the marker', async () => {
    const { base, cwd } = repo();
    const sid = `i6-${Math.random().toString(36).slice(2)}`;
    // The policy read gate would ask for the new policy file first; this test is about the push.
    const env = { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: 'off', GOODBOY_PUSH_REGRESSION: 'on', GOODBOY_POLICY_GATE: 'off' } as Record<string, string>;
    const push = async () => {
      const payload = { session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
      const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
      await proc.exited;
      const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
      return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
    };
    const marker = `! touch .claude/.goodboy-push-test-approved-${sid.slice(0, 8)}.txt`;
    // A docs commit with no tested tree under it is denied (the remote's content is no base).
    write(cwd, 'docs/guide.md', '# guide\n');
    git(cwd, 'add', 'docs/guide.md');
    git(cwd, 'commit', '-q', '-m', 'docs');
    const untested = await push();
    expect(untested.denied).toBe(true);
    expect(untested.reason).toContain(marker);
    // The tested tree: a passing layer-1 result (written by the CLI) and a failed regression.
    const tested = revisionTree(cwd, 'HEAD')!;
    const result = { ...passingResult(cwd), tested_files: [join(cwd, 'src', 'a.ts')] };
    const w = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd, env, stdin: new TextEncoder().encode(JSON.stringify(result)), stdout: 'pipe', stderr: 'pipe' });
    expect(w.exitCode).toBe(0);
    writeRegressionRecord(cwd, regression(tested, 'fail'));
    write(cwd, '.goodboy/policy.md', '# Project policy\n');
    write(cwd, 'CHANGELOG.md', '- guide\n');
    git(cwd, 'add', 'CHANGELOG.md');
    git(cwd, 'commit', '-q', '-m', 'changelog');
    // Layer 1 passes as prose on the tested tree, but the regression of neither tree passed:
    //   the denial names the marker (the regression branch too).
    const failed = await push();
    expect(failed.denied).toBe(true);
    expect(failed.reason).toContain('full regression');
    expect(failed.reason).toContain(marker);
    writeRegressionRecord(cwd, regression(tested, 'pass'));
    expect((await push()).denied).toBe(false);
    // A failed run of the tree handed off itself is not outweighed by the base's pass.
    writeRegressionRecord(cwd, regression(revisionTree(cwd, 'HEAD')!, 'fail'));
    const own = await push();
    expect(own.denied).toBe(true);
    expect(own.reason).toContain('full regression failed');
    // Code on top is denied again.
    write(cwd, 'src/a.ts', 'export const a = 3;\n');
    git(cwd, 'commit', '-qam', 'code');
    const code = await push();
    expect(code.denied).toBe(true);
    expect(code.reason).toContain('without a passing test result');
    expect(code.reason).toContain(marker);
  }, 60_000);
});

describe('finding 5: the result guard', () => {
  test('AC-5: interpreter code that names a result dir still counts as a write; the denial says how to read one', async () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.claude', 'tests'), { recursive: true });
    // Reading code is not told apart from writing code (the I6 review wrote a fake result
    //   through "read-only" inline python), so every interpreter call that names the dir counts.
    for (const c of [
      `python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('verdict'))" .claude/tests/a.json`,
      `python3 -c "from os import remove as r; r('.claude/tests/a.json')"`,
      `perl -p fix.pl .claude/tests/a.json`,
      `node -e "require('fs')['writeFileSync']('.claude/tests/a.json', '{}')"`,
    ]) {
      expect([c, resultDirWrite(c, cwd) === null]).toEqual([c, false]);
    }
    for (const c of ['cat .claude/tests/a.json', "jq '.verdict' .claude/tests/a.json", 'jq -r .verdict .claude/reviews/*.json']) {
      expect([c, resultDirWrite(c, cwd)]).toEqual([c, null]);
    }
    const payload = { session_id: `i6-${Math.random().toString(36).slice(2)}`, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `python3 -c "import json; print(json.load(open('.claude/tests/a.json')))"` } };
    const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TMPDIR: cwd, GOODBOY_POLICY_GATE: 'off' } });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: Record<string, string> };
    await proc.exited;
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('To read a result, use the Read tool, `cat` or `jq`');
  }, 30_000);
});

describe('finding 8: a local database socket', () => {
  test('AC-8: a literal socket dir is local; a host in a variable is not, and the denial says how to write it', async () => {
    for (const c of ['psql -h /tmp/pgsock -p 5432 -c "drop table x"', 'psql "-h/tmp/pg sock" -c "select 1"', 'psql -h /tmp/a,/tmp/b -c "drop table x"', 'mysql -S /tmp/m.sock -e "drop table x"']) {
      expect([c, classifyOutward(c, '/tmp')]).toEqual([c, []]);
    }
    // Every host counts: a libpq host list, a later -h, mysql's -S socket beside an -h host.
    for (const c of ['psql -h /nonexistent,prod-db -c "drop table x"', 'psql -h /tmp -h prod-db -c "drop table x"', 'psql --host=/tmp --host=prod-db -c "drop table x"']) {
      expect([c, classifyOutward(c, '/tmp')]).toEqual([c, [{ kind: 'psql', host: 'prod-db', mutating: true }]]);
    }
    expect(classifyOutward('mysql -S /tmp/m.sock -h prod-db -e "drop table x"', '/tmp')).toEqual([{ kind: 'mysql', host: 'prod-db', mutating: true }]);
    // A variable's value cannot be read from the command text: assigned later, as a command
    //   prefix, inside a string, or by read/for/printf -v (I6 review).
    for (const c of [
      'D=$(mktemp -d); psql -h $D -c "drop table x"',
      'D=db.example.com; psql -h $D -c "drop table x"; D=/tmp',
      'D=/tmp psql -h $D -c "drop table x"',
      'read D <<< db.example.com; psql -h "$D" -c "drop table x"',
    ]) {
      expect([c, classifyOutward(c, '/tmp')]).toEqual([c, [{ kind: 'psql', host: '$d', mutating: true }]]);
    }
    expect(classifyOutward('psql -h db.example.com -c "select 1"', '/tmp')).toEqual([{ kind: 'psql', host: 'db.example.com', mutating: true }]);
    const cwd = tmp();
    const payload = { session_id: `i6-${Math.random().toString(36).slice(2)}`, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'goodboy:test-changes', tool_input: { command: 'D=$(mktemp -d); psql -h $D -c "drop table x"' } };
    const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TMPDIR: cwd, GOODBOY_POLICY_GATE: 'off' } });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: Record<string, string> };
    await proc.exited;
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('a unix socket directory written as a literal absolute path');
  }, 30_000);
});
