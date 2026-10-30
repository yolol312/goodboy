// G2 result fields (track G §10.8): suites typed and timed with a per-type summary, coverage
// recorded (line and branch never a gate; changed lines are one since I1), Codex findings
// marked, changed-line coverage from four report formats, and the skill effort notice. Repos
// are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { byTestType, validateReviewResultInput, validateTestResultInput } from '../lib/cli';
import { changedLines, diffCoverage, diffCoverageOf, parseReport, reportFormat } from '../lib/diff-coverage';
import { skillEffort, skillEffortNotice } from '../lib/effort-advice';
import { resultWriterDenial } from '../lib/role-limits';
import { CHECKED_ROLES, ROUTE, roleOf } from '../lib/routing-policy';
import { outcomeOf } from '../lib/spawn-guard';

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.GOODBOY_SKILL_EFFORT;
});

function sh(cwd: string, command: string): string {
  const p = Bun.spawnSync(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${command}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-g2-')));
  dirs.push(dir);
  sh(dir, "git init -q -b main && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false");
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  sh(dir, "git add -A && git commit -q -m 'ABC-1 init'");
  return dir;
}

const suite = (over: Record<string, unknown> = {}) => ({ name: 'unit', command: 'bun test', passed: 3, failed: 1, output: '3 pass 1 fail', type: 'unit', duration_ms: 1200, ...over });
const result = (over: Record<string, unknown> = {}) => ({
  tested_files: ['/r/src/a.ts'],
  category: 'fix-bug',
  test_files: [CLI],
  environment: { mode: 'none' },
  suites: [suite()],
  acceptance: [{ id: 'AC-1', description: 'x', test: 't', red: { command: 'c', output: 'o', exit_code: 1 }, green: { command: 'c', output: 'o', exit_code: 0 } }],
  verdict: 'needs-changes',
  ...over,
});

describe('test results: suites per type', () => {
  test('type and duration_ms are required, and test-write adds by_type', () => {
    const errors = validateTestResultInput(result({ suites: [{ name: 'u', command: 'c', passed: 1, failed: 0, output: '' }] })).errors.join('\n');
    expect(errors).toContain('suites[0].type must be one of unit|integration|ui|e2e');
    expect(errors).toContain('suites[0].duration_ms');
    expect(validateTestResultInput(result({ suites: [suite({ type: 'smoke' })] })).ok).toBe(false);
    expect(validateTestResultInput(result({ suites: [suite({ duration_ms: -1 })] })).ok).toBe(false);
    const ok = validateTestResultInput(result({ suites: [suite(), suite({ type: 'e2e', passed: 2, failed: 0, duration_ms: 9000 }), suite({ duration_ms: 300 })] }));
    expect(ok.ok).toBe(true);
    expect(ok.value!.by_type).toEqual({ unit: { suites: 2, tests: 8, duration_ms: 1500 }, e2e: { suites: 1, tests: 2, duration_ms: 9000 } });
  });

  test('byTestType skips untyped (old) suites', () => {
    expect(byTestType([{ name: 'u', command: 'c', passed: 1, failed: 0, output: '' }])).toEqual({});
  });
});

describe('test results: coverage, recorded not gated', () => {
  test('measured with changed lines, or unavailable with a reason', () => {
    const measured = { status: 'measured', tool: 'bun test --coverage', line_pct: 80.5, branch_pct: 60, changed: { covered: 3, total: 4, files_without_executed_changes: [] } };
    expect(validateTestResultInput(result({ coverage: measured })).value!.coverage).toEqual(measured as never);
    expect(validateTestResultInput(result({ coverage: { status: 'unavailable', reason: 'no coverage tool' } })).ok).toBe(true);
    const bad = (c: unknown) => validateTestResultInput(result({ coverage: c })).errors.join('\n');
    expect(bad({ status: 'unavailable' })).toContain('needs a reason');
    expect(bad({ status: 'measured', line_pct: 120 })).toContain('0 to 100');
    expect(bad({ status: 'measured', changed: { covered: 5, total: 4, files_without_executed_changes: [] } })).toContain('diff-coverage');
    expect(bad({ status: 'guessed' })).toContain('measured');
  });
});

describe('review results: Codex', () => {
  const review = (over: Record<string, unknown> = {}) => ({ reviewed_files: ['/r/a.ts'], category: 'x', findings: [], verdict: 'pass', ...over });
  test('a finding may be marked codex; the round records ran or skipped with a reason', () => {
    const f = { file: '/r/a.ts', issue: 'x', severity: 'low', source: 'codex' };
    expect(validateReviewResultInput(review({ findings: [f], codex: { status: 'ran' } })).value!.codex).toEqual({ status: 'ran' });
    expect(validateReviewResultInput(review({ findings: [{ ...f, source: 'gpt' }] })).errors.join()).toContain('source can only be "codex"');
    expect(validateReviewResultInput(review({ codex: { status: 'skipped' } })).errors.join()).toContain('needs a reason');
    expect(validateReviewResultInput(review({ codex: { status: 'skipped', reason: 'codex not installed', output: 'not found' } })).ok).toBe(true);
    expect(validateReviewResultInput(review({ codex: { status: 'maybe' } })).ok).toBe(false);
  });
});

describe('changed-line coverage', () => {
  test('the four report formats', () => {
    const lcov = 'TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n';
    const cob = '<coverage><packages><package><classes><class filename="src/a.ts"><lines><line number="1" hits="2"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>';
    const jac = '<report name="r"><package name="src"><sourcefile name="a.ts"><line nr="1" mi="0" ci="3"/><line nr="2" mi="2" ci="0"/></sourcefile></package></report>';
    const go = 'mode: set\nsrc/a.ts:1.1,1.20 1 1\nsrc/a.ts:2.1,2.20 1 0\n';
    for (const [text, fmt] of [[lcov, 'lcov'], [cob, 'cobertura'], [jac, 'jacoco'], [go, 'go']] as const) {
      expect(reportFormat(text)).toBe(fmt);
      expect([fmt, [...(parseReport(text, fmt).get('src/a.ts') ?? new Map())]]).toEqual([fmt, [[1, true], [2, false]]]);
    }
    expect(reportFormat('hello')).toBeNull();
    // A Go block spans lines: every line in it counts.
    expect([...parseReport('mode: set\nsrc/a.ts:1.1,3.2 2 1\n', 'go').get('src/a.ts')!.keys()]).toEqual([1, 2, 3]);
  });

  // (#25) A code-free file (an interface) is a self-closing element; it must not take the next file's lines.
  test('self-closing JaCoCo sourcefile and Cobertura class elements', () => {
    const jac =
      '<report name="r"><package name="src"><sourcefile name="I.java"/><sourcefile name="a.ts"><line nr="1" mi="0" ci="3"/></sourcefile></package></report>';
    const j = parseReport(jac, 'jacoco');
    expect([...(j.get('src/a.ts') ?? new Map())]).toEqual([[1, true]]);
    expect(j.has('src/I.java')).toBe(false);
    const cob =
      '<coverage><packages><package><classes><class filename="src/I.java"/><class filename="src/a.ts"><lines><line number="1" hits="2"/></lines></class></classes></package></packages></coverage>';
    const c = parseReport(cob, 'cobertura');
    expect([...(c.get('src/a.ts') ?? new Map())]).toEqual([[1, true]]);
    expect(c.has('src/I.java')).toBe(false);
  });

  test('test-write warns about a tested file whose changed lines never ran', () => {
    const r = repo();
    mkdirSync(join(r, 'tests'));
    writeFileSync(join(r, 'tests', 'a.test.ts'), 'test("x", () => {});\n');
    const file = join(r, 'src', 'a.ts');
    const input = result({
      tested_files: [file],
      test_files: [join(r, 'tests', 'a.test.ts')],
      coverage: { status: 'measured', changed: { covered: 0, total: 2, files_without_executed_changes: [file] } },
    });
    const p = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: r, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toContain(`no changed line of these tested files ran in the tests: ${file}`);
  });

  test('working-tree changes against a report, by file; an idle changed file is listed', () => {
    const r = repo();
    writeFileSync(join(r, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 20;\nexport const c = 30;\n');
    writeFileSync(join(r, 'src', 'new.ts'), 'export const n = 1;\n');
    const changed = changedLines(r) as { top: string; files: Map<string, Set<number>> };
    expect([...changed.files.get('src/a.ts')!].sort()).toEqual([2, 3]);
    expect([...changed.files.get('src/new.ts')!]).toEqual([1]);
    writeFileSync(join(r, 'lcov.info'), `SF:${join(r, 'src', 'a.ts')}\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\nSF:src/new.ts\nDA:1,0\nend_of_record\n`);
    const out = diffCoverageOf(r, 'lcov.info');
    expect(out).toEqual({
      covered: 1,
      total: 3,
      files_without_executed_changes: [join(r, 'src', 'new.ts')],
      files: { 'src/a.ts': { covered: 1, total: 2 }, 'src/new.ts': { covered: 0, total: 1 } },
      in_report: ['src/a.ts', 'src/new.ts'],
      diff_lines: { 'lcov.info': 8, 'src/a.ts': 2, 'src/new.ts': 1 }, // the report itself is an untracked file
      base: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: r }).stdout.toString().trim(),
    });
  });

  test('names with spaces and non-ASCII letters, prefix config, and a base that does not exist', () => {
    const r = repo();
    writeFileSync(join(r, 'src', 'my file.ts'), 'export const x = 1;\n');
    writeFileSync(join(r, 'src', 'café.ts'), 'export const y = 1;\n');
    sh(r, "git add -A && git commit -q -m 'ABC-2 more' && git config diff.mnemonicPrefix true && git config core.quotePath true");
    writeFileSync(join(r, 'src', 'my file.ts'), 'export const x = 2;\n');
    writeFileSync(join(r, 'src', 'café.ts'), 'export const y = 2;\n');
    const changed = changedLines(r) as { top: string; files: Map<string, Set<number>> };
    expect([...changed.files.keys()].sort()).toEqual(['src/café.ts', 'src/my file.ts']);
    expect(changedLines(r, 'no-such-rev')).toEqual({ error: 'git diff against no-such-rev failed (is it a commit?)' });
    writeFileSync(join(r, 'lcov.info'), 'SF:src/a.ts\nDA:1,1\nend_of_record\n');
    expect(diffCoverageOf(r, 'lcov.info', 'no-such-rev')).toEqual({ error: 'git diff against no-such-rev failed (is it a commit?)' });
  });

  test('the CLI command, and its errors', () => {
    const r = repo();
    writeFileSync(join(r, 'src', 'a.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
    writeFileSync(join(r, 'cover.out'), 'mode: set\nsrc/a.ts:1.1,1.22 1 1\n');
    const p = Bun.spawnSync(['bun', CLI, 'diff-coverage', 'cover.out'], { cwd: r, stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toMatchObject({ covered: 1, total: 1 });
    const missing = Bun.spawnSync(['bun', CLI, 'diff-coverage', 'nope.info'], { cwd: r, stdout: 'pipe', stderr: 'pipe' });
    expect(missing.exitCode).not.toBe(0);
    expect(diffCoverage(new Map(), r, new Map())).toEqual({ covered: 0, total: 0, files_without_executed_changes: [], files: {}, in_report: [], diff_lines: {} });
  });
});

describe('skill effort notice', () => {
  test('a goodboy skill above or below the session effort says so once; equal or off says nothing', () => {
    expect(skillEffort('goodboy:write-migration')).toBe('xhigh');
    expect(skillEffort('goodboy:follow-agent-rules')).toBeNull();
    expect(skillEffort('other:write-migration')).toBeNull();
    expect(skillEffort('goodboy:../../etc')).toBeNull();
    expect(skillEffortNotice('goodboy:write-migration', 'high')).toContain('effort xhigh');
    expect(skillEffortNotice('goodboy:record-review', 'low')).toBeNull();
    process.env.GOODBOY_SKILL_EFFORT = 'off';
    expect(skillEffortNotice('goodboy:write-migration', 'high')).toBeNull();
  });

  test('the PostToolUse hook shows it for a main-session Skill call', async () => {
    const r = repo();
    const sid = `g2e${Math.random().toString(36).slice(2, 10)}`;
    dirs.push(join(tmpdir(), `goodboy-session-${sid}`));
    const proc = Bun.spawn(['bun', resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts')], {
      cwd: r,
      stdin: new TextEncoder().encode(
        JSON.stringify({ session_id: sid, cwd: r, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'goodboy:write-migration' }, tool_response: {}, effort: { level: 'high' } }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GOODBOY_AUTOVALIDATE: 'off' },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { systemMessage?: string };
    expect(out.systemMessage ?? '').toContain('write-migration 스킬은 effort xhigh');
  }, 20_000);
});

describe('agent outcomes', () => {
  test('the hand-back line `status: blocked` counts as blocked, in any case', () => {
    expect(outcomeOf('done\nrun_id: x\nstatus: blocked\nsummary: no runner')).toBe('blocked');
    expect(outcomeOf('Status: Blocked')).toBe('blocked');
    expect(outcomeOf('BLOCKED: which database?')).toBe('blocked');
    expect(outcomeOf('status: done\nsummary: nothing was blocked here')).toBe('ok');
  });
});

describe('result writers after the renames', () => {
  test('the pre-G2 agents still record their results; messages name the new agents', () => {
    expect(resultWriterDenial('test', 'goodboy:test-changes', roleOf('goodboy:test-changes'))).toBeNull();
    expect(resultWriterDenial('review', 'goodboy:review-changes', roleOf('goodboy:review-changes'))).toBeNull();
    expect(resultWriterDenial('unknown', 'goodboy:review-changes', null)).toBeNull();
    expect(resultWriterDenial('test', 'goodboy:test-unit', roleOf('goodboy:test-unit'))).toBeNull();
    expect(resultWriterDenial('test', 'goodboy:review-changes', null)).toContain('goodboy:test-unit');
    expect(resultWriterDenial('review', undefined, null)).toContain('Run goodboy:review-all');
    expect(resultWriterDenial('test', 'other:test-changes', null)).not.toBeNull();
  });

  test('the gates route only to agents whose capability check passed', () => {
    for (const role of Object.values(ROUTE)) expect([role, CHECKED_ROLES.has(role)]).toEqual([role, true]);
  });
});
