import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { revisionTree } from '../lib/push-test';
import {
  checkRegression,
  ONE_HOUR_MS,
  readRegressionRecords,
  REGRESSION_DIR,
  type RegressionRecord,
  regressionCommands,
  regressionMessage,
  regressionMode,
  outputSummary,
  STDOUT_TAIL,
  writeRegressionRecord,
} from '../lib/regression';
import { resultCliWrite, resultWriterDenial } from '../lib/role-limits';
import { roleOf } from '../lib/routing-policy';

// Track I, I4 (#5, plan §15.7): a full regression on the pushed tree before a push. goodboy
// runs the project's whole test command itself (`cli.ts regression`) and the push check needs
// a passing run of the exact tree handed off.

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-i4-'));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const TREE = 'a'.repeat(40);
function rec(over: Partial<RegressionRecord> = {}): RegressionRecord {
  return {
    timestamp: new Date().toISOString(),
    commit: null,
    tree: TREE,
    // The tree was the same at the end unless a test says otherwise.
    tree_after: over.tree ?? TREE,
    source: 'package.json scripts.test',
    runs: [{ command: 'bun run test', exit_code: 0, duration_ms: 1000, output_tail: '3 pass' }],
    duration_ms: 1000,
    verdict: 'pass',
    ...over,
  };
}

describe('the whole-suite command', () => {
  const at = (files: Record<string, string>) => {
    const d = tmp();
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
    return regressionCommands(d);
  };
  test('AC-1: package.json scripts by the lockfile, test:all first, an e2e script after', () => {
    expect(at({ 'package.json': '{"scripts":{"test":"bun test"}}', 'bun.lock': '' })).toEqual({ commands: ['bun run test'], source: 'package.json scripts.test' });
    expect(at({ 'package.json': '{"scripts":{"test":"vitest","test:all":"vitest && playwright test"}}', 'pnpm-lock.yaml': '' })!.commands).toEqual(['pnpm run test:all']);
    expect(at({ 'package.json': '{"scripts":{"test":"jest","test:e2e":"playwright test"}}', 'yarn.lock': '' })!.commands).toEqual(['yarn test', 'yarn test:e2e']);
    expect(at({ 'package.json': '{"scripts":{"test":"jest"}}' })!.commands).toEqual(['npm run test']);
    // npm's placeholder is no test command; a script that only mentions the words is one.
    expect(at({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' })).toBeNull();
    expect(at({ 'package.json': '{"scripts":{"test":"jest # no test specified for legacy/"}}' })!.commands).toEqual(['npm run test']);
  });
  test('AC-1: pytest, Go, Cargo and a Makefile test target; none found is null', () => {
    expect(at({ 'pyproject.toml': '[tool.pytest.ini_options]\n' })!.commands).toEqual(['python3 -m pytest']);
    expect(at({ 'go.mod': 'module x\n' })!.commands).toEqual(['go test ./...']);
    expect(at({ 'Cargo.toml': '[package]\n' })!.commands).toEqual(['cargo test']);
    expect(at({ Makefile: 'build:\n\tcc x.c\ntest: build\n\t./run\n' })!.commands).toEqual(['make test']);
    expect(at({ Makefile: 'build:\n\tcc x.c\n' })).toBeNull();
    // Every ecosystem found runs; a Makefile target only when nothing else is found.
    expect(at({ 'package.json': '{"scripts":{"test":"jest"}}', 'pytest.ini': '', 'go.mod': 'module x\n', Makefile: 'test:\n\t./all\n' })).toEqual({
      commands: ['npm run test', 'python3 -m pytest', 'go test ./...'],
      source: 'package.json scripts.test + pytest + go.mod',
    });
    expect(at({ 'README.md': '# x\n' })).toBeNull();
  });
});

describe('cli.ts regression', () => {
  function repo(script: string, extra: Record<string, string> = {}) {
    const cwd = join(tmp(), 'repo');
    mkdirSync(cwd, { recursive: true });
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.email', 't@example.com');
    git(cwd, 'config', 'user.name', 't');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: script, ...extra } }));
    writeFileSync(join(cwd, 'bun.lock'), '');
    writeFileSync(join(cwd, '.gitignore'), '.claude/\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'init');
    return cwd;
  }
  const regression = (cwd: string, args: string[] = []) => {
    const p = Bun.spawnSync(['bun', CLI, 'regression', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test('AC-2: runs the whole command, times it, records it with the tree it ran on', () => {
    const cwd = repo('echo ran-the-whole-suite');
    const r = regression(cwd);
    expect(r.code).toBe(0);
    const recs = readRegressionRecords(cwd);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.verdict).toBe('pass');
    expect(recs[0]!.runs[0]).toMatchObject({ command: 'bun run test', exit_code: 0 });
    expect(recs[0]!.runs[0]!.output_tail).toContain('ran-the-whole-suite');
    expect(recs[0]!.tree).toBe(revisionTree(cwd, 'HEAD')!);
    expect(recs[0]!.source).toBe('package.json scripts.test');
    expect(recs[0]!.runs[0]!.program).toMatch(/bun$/);
  }, 30_000);

  test('AC-2: a failing suite is recorded as failed and exits 1', () => {
    const cwd = repo('echo boom >&2; exit 3');
    const r = regression(cwd);
    expect(r.code).toBe(1);
    expect(r.err).toContain('exited 3');
    const rec0 = readRegressionRecords(cwd)[0]!;
    expect(rec0.verdict).toBe('fail');
    expect(rec0.runs[0]!.exit_code).toBe(3);
    expect(rec0.runs[0]!.output_tail).toContain('boom');
  }, 30_000);

  test('AC-2: a run that changes the working tree fails and names the files', () => {
    const cwd = repo('echo x > made.txt');
    const r = regression(cwd);
    expect(r.code).toBe(1);
    expect(r.err).toContain('changed the working tree (made.txt)');
    const rec0 = readRegressionRecords(cwd)[0]!;
    expect(rec0.verdict).toBe('fail');
    expect(rec0.tree).toBe(revisionTree(cwd, 'HEAD')!);
    expect(rec0.tree_after).not.toBe(rec0.tree);
    expect(rec0.changed_files).toEqual(['made.txt']);
    // A record that says pass but whose tree changed is no pass either.
    expect(checkRegression('main', rec0.tree, [{ ...rec0, verdict: 'pass' }])).toMatchObject({ ok: false, why: 'failed' });
  }, 30_000);

  test('AC-2: every command runs after a failure; output is kept to its tail', () => {
    const cwd = repo(`echo boom; bun -e 'process.stdout.write("x".repeat(20000))'; exit 1`, { 'test:e2e': 'echo e2e-ran' });
    expect(regression(cwd).code).toBe(1);
    const rec0 = readRegressionRecords(cwd)[0]!;
    expect(rec0.runs.map((x) => x.command)).toEqual(['bun run test', 'bun run test:e2e']);
    expect(rec0.runs[1]!.output_tail).toContain('e2e-ran');
    expect(rec0.runs[0]!.output_tail.split('\n[stderr]\n')[0]!.length).toBeLessThanOrEqual(STDOUT_TAIL);
  }, 30_000);

  test('AC-2: a background child does not hold the run or stretch its time; a timeout fails it', () => {
    const bg = repo('sleep 20 & echo started');
    const t0 = Date.now();
    expect(regression(bg).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(readRegressionRecords(bg)[0]!.duration_ms).toBeLessThan(5_000);
    const slow = repo('sleep 20');
    const t1 = Date.now();
    const r = regression(slow, ['--timeout-min', '0.02']);
    expect(Date.now() - t1).toBeLessThan(12_000);
    expect(r.code).toBe(1);
    const rec0 = readRegressionRecords(slow)[0]!;
    expect(rec0.runs[0]!.exit_code).toBe(124);
    expect(rec0.runs[0]!.output_tail).toContain('stopped after');
    // A huge timeout is capped (a longer timer overflows and fires at once).
    expect(regression(repo('echo ok'), ['--timeout-min', '40000']).code).toBe(0);
  }, 40_000);

  test('AC-2: no whole-suite command, or no repo, records nothing and says what to do', () => {
    const cwd = join(tmp(), 'bare');
    mkdirSync(cwd);
    git(cwd, 'init', '-q');
    const none = regression(cwd);
    expect(none.code).toBe(1);
    expect(none.err).toContain('found no whole-suite test command');
    expect(none.err).toContain('`blocked`');
    const outside = tmp();
    expect(regression(outside).err).toContain('not inside a git repository');
  }, 30_000);
});

describe('records and the check', () => {
  test('AC-3: a passing run of the tree passes; none or a failing one does not', () => {
    expect(checkRegression('main', TREE, [rec()])).toEqual({ ok: true });
    expect(checkRegression('main', TREE, [rec({ tree: 'b'.repeat(40) })])).toMatchObject({ ok: false, why: 'none' });
    expect(checkRegression('main', TREE, [])).toMatchObject({ ok: false, why: 'none' });
    const failed = rec({ verdict: 'fail', runs: [{ command: 'bun run test', exit_code: 1, duration_ms: 5, output_tail: '1 fail' }] });
    expect(checkRegression('main', TREE, [failed])).toMatchObject({ ok: false, why: 'failed' });
    // A verdict of pass with a non-zero run is not a pass.
    expect(checkRegression('main', TREE, [rec({ runs: [{ command: 'x', exit_code: 2, duration_ms: 5, output_tail: '' }] })])).toMatchObject({ ok: false });
  });

  test('AC-3: past the one-hour tier a passing run of any tree relaxes the check; a slow failing run does not', () => {
    const long = rec({ tree: 'c'.repeat(40), duration_ms: ONE_HOUR_MS + 1 });
    expect(checkRegression('main', TREE, [long])).toEqual({ ok: true, relaxed: true });
    expect(checkRegression('main', TREE, [rec({ tree: 'c'.repeat(40), duration_ms: ONE_HOUR_MS + 1, verdict: 'fail' })])).toMatchObject({ ok: false });
    expect(checkRegression('main', TREE, [rec({ tree: 'c'.repeat(40) })])).toMatchObject({ ok: false });
    // Only the newest passing run decides: a short newer pass ends an older long one's tier.
    expect(checkRegression('main', TREE, [rec({ tree: 'f'.repeat(40) }), long])).toMatchObject({ ok: false });
  });

  test('AC-4: malformed records are ignored; at most 20 are kept', () => {
    const top = tmp();
    const dir = join(top, REGRESSION_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0-bad.json'), '{"verdict":"pass","tree":"zz"}');
    writeFileSync(join(dir, '0-junk.json'), 'not json');
    writeFileSync(join(dir, '0-empty.json'), JSON.stringify(rec({ runs: [] })));
    expect(readRegressionRecords(top)).toEqual([]);
    for (let i = 0; i < 25; i++) writeRegressionRecord(top, rec({ timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
    expect(readdirSync(dir).filter((n) => n.endsWith('.json')).length).toBe(20);
    expect(readRegressionRecords(top)[0]!.timestamp).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 24)).toISOString());
  });

  test('AC-6: GOODBOY_PUSH_REGRESSION and the messages', () => {
    expect(regressionMode({})).toBe('on');
    expect(regressionMode({ GOODBOY_PUSH_REGRESSION: 'warn' })).toBe('warn');
    expect(regressionMode({ GOODBOY_PUSH_REGRESSION: 'OFF' })).toBe('off');
    const none = regressionMessage('`git push`', { ok: false, why: 'none', rev: 'main', tree: TREE }, '/gb/lib/cli.ts', 'goodboy:test-unit');
    expect(none).toContain('without a passing full regression');
    expect(none).toContain('goodboy:test-unit');
    expect(none).toContain('bun "/gb/lib/cli.ts" regression');
    expect(none).toContain("from this session's directory");
    const failed = rec({ verdict: 'fail', runs: [{ command: 'bun run test', exit_code: 1, duration_ms: 5, output_tail: 'expected 2, got 3' }] });
    const msg = regressionMessage('`git push`', { ok: false, why: 'failed', rev: 'main', tree: TREE, failed }, '/x', 'goodboy:test-unit');
    expect(msg).toContain('`bun run test` exited 1');
    expect(msg).toContain('expected 2, got 3');
    expect(msg).toContain('never weakened or skipped');
    // stderr noise never hides the failing stdout line.
    expect(outputSummary(`FAIL: totals\n[stderr]\n${'warn '.repeat(500)}`)).toContain('FAIL: totals');
  });

  test('AC-7: only test agents run the regression', () => {
    expect(resultCliWrite('bun "$GB/lib/cli.ts" regression')).toBe('test');
    expect(resultCliWrite('bun lib/cli.ts regression')).toBe('test');
    // A script calling the record writer itself counts too; a grep or a commit naming it does not.
    expect(resultCliWrite(`bun -e "import { writeRegressionRecord as w } from '/gb/lib/regression'; w('.', r)"`)).toBe('test');
    expect(resultCliWrite('grep -rn writeRegressionRecord lib')).toBeNull();
    expect(resultCliWrite('git commit -m "fix writeRegressionRecord pruning (#5)"')).toBeNull();
    // Closing check: the name in a variable or a heredoc fed to a JS runtime, or the module loaded.
    expect(resultCliWrite(`n=writeRegressionRecord; bun -e "import('./lib/regression.ts').then(m=>m['$n']({}))"`)).toBe('test');
    expect(resultCliWrite("cat <<'EOF' | bun -\nimport { writeRegressionRecord } from './lib/regression';\nEOF")).toBe('test');
    expect(resultCliWrite(`bun -e "import('/gb/lib/regression.ts').then((m) => m[atob('eA==')])"`)).toBe('test');
    expect(resultWriterDenial('test', undefined, null)).toContain('may not');
    expect(resultWriterDenial('test', 'goodboy:test-unit', roleOf('goodboy:test-unit'))).toBeNull();
  });
});

describe('the push check', () => {
  // A repo with a remote, a commit, and a passing layer-1 result of HEAD's tree.
  async function setup() {
    const base = tmp();
    const cwd = join(base, 'repo');
    mkdirSync(join(cwd, 'src'), { recursive: true });
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.email', 't@example.com');
    git(cwd, 'config', 'user.name', 't');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(cwd, 'a.test.ts'), 'test("a", () => {});\n');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'echo whole-suite' } }));
    writeFileSync(join(cwd, 'bun.lock'), '');
    writeFileSync(join(cwd, '.gitignore'), '.claude/\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'init');
    const env = { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: 'off', GOODBOY_PUSH_REGRESSION: 'on' } as Record<string, string>;
    const result = {
      tested_files: [join(cwd, 'src', 'a.ts')],
      category: 'add-feature',
      test_files: [join(cwd, 'a.test.ts')],
      environment: { mode: 'local' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [
        {
          id: 'AC-1',
          description: 'a is 1',
          test: 'a.test.ts',
          red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
          green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
        },
      ],
      verdict: 'pass',
    };
    const w = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd, env, stdin: new TextEncoder().encode(JSON.stringify(result)), stdout: 'pipe', stderr: 'pipe' });
    if (w.exitCode !== 0) throw new Error(w.stderr.toString());
    const sid = `i4-${Math.random().toString(36).slice(2)}`;
    const push = async (extra: Record<string, string> = {}, command = 'git push origin main', tool: { name: string; input: Record<string, unknown> } = { name: 'Bash', input: { command } }) => {
      const payload = { session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: tool.input };
      const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env: { ...env, ...extra } });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
      await proc.exited;
      const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
      return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', system: String(out.systemMessage ?? ''), context: h.additionalContext ?? '' };
    };
    return { base, cwd, push };
  }

  test('AC-5: a push with the layer-1 result but no regression is denied; after the regression it passes', async () => {
    const { cwd, push } = await setup();
    const before = await push();
    expect(before.denied).toBe(true);
    expect(before.reason).toContain('without a passing full regression');
    expect(before.system).toContain('통과한 전체 회귀 기록');
    expect(Bun.spawnSync(['bun', CLI, 'regression'], { cwd }).exitCode).toBe(0);
    expect((await push()).denied).toBe(false);
  }, 60_000);

  test('AC-5: a failing regression of the tree is named; an edit after the run needs a new one', async () => {
    const { cwd, push } = await setup();
    const top = cwd;
    const tree = revisionTree(cwd, 'main')!;
    writeRegressionRecord(top, rec({ tree, verdict: 'fail', runs: [{ command: 'bun run test', exit_code: 1, duration_ms: 5, output_tail: 'expected 2' }] }));
    const failed = await push();
    expect(failed.denied).toBe(true);
    expect(failed.reason).toContain('full regression failed');
    // A passing run of another tree (the content before a commit) does not count.
    writeRegressionRecord(top, rec({ tree: 'd'.repeat(40) }));
    expect((await push()).denied).toBe(true);
  }, 60_000);

  test('AC-6: warn mode lets the push through with a note; off skips the regression', async () => {
    const { push } = await setup();
    const warn = await push({ GOODBOY_PUSH_REGRESSION: 'warn' });
    expect(warn.denied).toBe(false);
    expect(JSON.stringify(warn)).toContain('without a passing full regression');
    expect((await push({ GOODBOY_PUSH_REGRESSION: 'off' })).denied).toBe(false);
  }, 60_000);

  test('AC-6: past the one-hour tier the layer-1 result suffices, with a note to the user', async () => {
    const { cwd, push } = await setup();
    writeRegressionRecord(cwd, rec({ tree: 'e'.repeat(40), duration_ms: ONE_HOUR_MS + 1 }));
    const out = await push();
    expect(out.denied).toBe(false);
    expect(JSON.stringify(out)).toContain('1시간을 넘는');
  }, 60_000);

  test("AC-5: another checkout's records never count (review high: a forged record in a worktree)", async () => {
    const { base, cwd, push } = await setup();
    const wt = join(base, 'wt');
    git(cwd, 'worktree', 'add', '-q', '--detach', wt, 'main');
    writeRegressionRecord(wt, rec({ tree: revisionTree(cwd, 'main')! }));
    const out = await push({}, `git -C ${wt} push origin main`);
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing full regression');
  }, 60_000);

  test('AC-6: a regression warning still lets the next hand-off be checked', async () => {
    const { cwd, push } = await setup();
    git(cwd, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(cwd, 'src', 'b.ts'), 'export const b = 2;\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'b');
    git(cwd, 'checkout', '-q', 'main');
    // main: layer-1 result, no regression (a warning); other: no layer-1 result (a denial).
    const out = await push({ GOODBOY_PUSH_REGRESSION: 'warn' }, 'git push origin main && git push origin other');
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('without a passing test result');
  }, 60_000);

  test("AC-7: the main session cannot write a regression record itself", async () => {
    const { cwd, push } = await setup();
    const path = join(cwd, REGRESSION_DIR, 'x.json');
    const write = await push({}, '', { name: 'Write', input: { file_path: path, content: JSON.stringify(rec()) } });
    expect(write.denied).toBe(true);
    const cp = await push({}, `mkdir -p ${join(cwd, REGRESSION_DIR)} && cp /etc/hosts ${path}`);
    expect(cp.denied).toBe(true);
  }, 60_000);

  test('AC-5: the regression record dir is outside the layer-1 records', async () => {
    const { cwd } = await setup();
    expect(Bun.spawnSync(['bun', CLI, 'regression'], { cwd }).exitCode).toBe(0);
    const names = readdirSync(join(cwd, '.claude', 'tests'));
    expect(names).toContain('regression');
    expect(readFileSync(join(cwd, REGRESSION_DIR, readdirSync(join(cwd, REGRESSION_DIR))[0]!), 'utf8')).toContain('"source"');
  }, 60_000);
});
