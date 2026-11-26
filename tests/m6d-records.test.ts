// Track M, M6d (§19): the records `test-write`, `review-write` and `regression` write keep no personal data.
// Every display string and key is redacted on disk (and in the sibling copy), redacted before the notes and
// tail cuts, the fields the gates compare stay as they are (an id, enum or path that holds personal data stops
// the write), a run on real data records only the M6a result, and the Stop gate's validators still accept such a
// record. Repos are temporary, git runs for real,
// the CLI is spawned as a process with its own env. No docker.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { outputSummary, redactedTail, regressionMessage, type RegressionRecord, STDERR_TAIL, STDOUT_TAIL, writeRegressionRecord } from '../lib/regression';
import { redactText } from '../lib/pii-patterns';
import { WITHHELD_TEXT } from '../lib/record-sanitize';
import { readRunResult, sandboxProof } from '../lib/sandbox-proof';
import { failingSuites, findRecentTestFiles, isEvidencedBlocked, missingTestFiles, validateEvidence } from '../lib/test-validator';
import { findRecentReviewFiles } from '../lib/review-validator';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
setDefaultTimeout(90_000);

// ── canaries: synthetic values only ─────────────────────────────────────────────────────────────────────

const RRN = '900101-1234567';
const CARD = '4111 1111 1111 1111';
const PHONE = '010-1234-5678';
const MAIL = 'canary.person@corp-mail.co.kr';
const KEY = 'ghp_abcdefghijklmnopqrstuvwx';
const ALL = `rrn ${RRN} card ${CARD} phone ${PHONE} mail ${MAIL} key ${KEY}`;
const RAW = [RRN, CARD, PHONE, MAIL, KEY, '1234567', '1111 1111', 'canary.person', 'abcdefghijklmnopqrstuvwx'];
/** A source and a test file with plain names (a file named like personal data is refused: see the refusal tests). */
const SRC = 'src/app.ts';
const TST = 'app.test.ts';

/** No canary left in `text`, and the redaction tokens of every kind there. */
function expectClean(text: string, kinds = ['resident-number', 'card', 'phone', 'email', 'secret']): void {
  for (const r of RAW) expect(text).not.toContain(r);
  for (const k of kinds) expect(text).toContain(`[redacted:${k}]`);
}

// ── harness ─────────────────────────────────────────────────────────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-m6d-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function cleanEnv(over: Record<string, string>): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('CLAUDE_') && !k.startsWith('GOODBOY_')) e[k] = v;
  return { ...e, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...over };
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: cleanEnv({}) });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
const files = (d: string): string[] => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).sort() : []);
const readText = (d: string, only = 0): string => readFileSync(join(d, files(d)[only]!), 'utf8');
const readJson = (d: string, only = 0): Record<string, any> => JSON.parse(readText(d, only)) as Record<string, any>;

/** A repo with a source and a test file, a package.json whose test script runs `gen.ts`, one commit. */
function makeRepo(dir: string, gen = 'console.log("ok")\n'): void {
  write(dir, SRC, 'export const a = 1;\n');
  write(dir, TST, 'test("a", () => {});\n');
  write(dir, `src/${PHONE}.ts`, 'export const b = 1;\n');
  write(dir, `${RRN}.test.ts`, 'test("b", () => {});\n');
  write(dir, 'gen.ts', gen);
  write(dir, 'package.json', JSON.stringify({ scripts: { test: 'bun gen.ts' } }));
  write(dir, 'bun.lock', '');
  write(dir, '.gitignore', '.claude/\n.goodboy/\n');
  sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
}

interface World {
  base: string;
  /** The session's project dir (a repo). */
  A: string;
  /** A sibling repo outside it. */
  B: string;
  env: Record<string, string>;
  /** The session's edit log has an edit of `file`: a record made in B then gets a copy in A. */
  edit: (file: string) => void;
  cli: (cwd: string, args: string[], stdin?: string) => { code: number | null; out: string; err: string };
}
function world(gen?: string): World {
  const base = tmp();
  const A = join(base, 'proj');
  const B = join(base, 'sibling');
  makeRepo(A, gen);
  makeRepo(B, gen);
  const wtmp = join(base, 'tmp');
  mkdirSync(wtmp, { recursive: true });
  const sid = `m6d-${Math.random().toString(36).slice(2, 10)}`;
  const env = cleanEnv({ TMPDIR: wtmp, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PROJECT_DIR: A, GOODBOY_OUTWARD_GATE: 'off' });
  const edit = (file: string): void => {
    const dir = join(wtmp, `goodboy-session-${sid}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file, turn: 1, timestamp: new Date().toISOString() }) + '\n', { flag: 'a' });
  };
  const cli: World['cli'] = (cwd, args, stdin = '') => {
    const p = Bun.spawnSync(['bun', CLI, ...args], { cwd, env, stdin: new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  return { base, A, B, env, edit, cli };
}

/** A test-write body for `repo` with the canaries in every display field. */
function testBody(repo: string, over: Record<string, unknown> = {}): Record<string, any> {
  const exactSrc = join(repo, SRC);
  const exactTest = join(repo, TST);
  return {
    tested_files: [exactSrc],
    category: 'fix-bug',
    test_files: [exactTest],
    environment: { mode: 'container', command: `docker compose up --who ${PHONE}`, services: [`db ${MAIL}`], evidence: ALL },
    suites: [{ name: `suite ${ALL}`, command: `bun test ${RRN}`, passed: 1, failed: 0, output: ALL, type: 'unit', duration_ms: 10, [`extra ${MAIL}`]: ALL }],
    acceptance: [
      {
        id: 'AC-1',
        description: ALL,
        test: TST,
        red: { command: `bun test ${RRN}.test.ts`, output: ALL, exit_code: 1 },
        green: { command: 'bun test', output: ALL, exit_code: 0 },
        mutation: { command: 'sed -i s/1/2/', output: ALL, detected: true, file: SRC },
      },
    ],
    coverage: { status: 'unavailable', reason: ALL, tool: ALL },
    prototype_diff: { prototype_path: 'docs/p.html', mismatches: [{ selector: ALL, issue: ALL, severity: 'low' }] },
    verdict: 'pass',
    notes: ALL,
    ...over,
  };
}

const testsDir = (d: string): string => join(d, '.claude', 'tests');
const reviewsDir = (d: string): string => join(d, '.claude', 'reviews');
const regDir = (d: string): string => join(d, '.claude', 'tests', 'regression');

// ── test-write ──────────────────────────────────────────────────────────────────────────────────────────

describe('M6d test-write', () => {
  test('canaries in every display field are redacted on disk; the exact fields are byte-identical', () => {
    const w = world();
    const r = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A)));
    expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
    const text = readText(testsDir(w.A));
    // the kept fields, whole
    const rec = JSON.parse(text) as Record<string, any>;
    expect(rec.tested_files).toEqual([join(w.A, SRC)]);
    expect(rec.test_files).toEqual([join(w.A, TST)]);
    expect(rec.acceptance[0].id).toBe('AC-1');
    expect(rec.acceptance[0].test).toBe(TST);
    expect(rec.acceptance[0].mutation.file).toBe(SRC);
    expect(rec.verdict).toBe('pass');
    expect(rec.environment.mode).toBe('container');
    expect(rec.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.by_type.unit).toMatchObject({ suites: 1, tests: 1 });
    // everything else: no raw canary, with a token per kind in each display field
    const without = JSON.stringify({ ...rec, tested_files: 0, test_files: 0, acceptance: rec.acceptance.map((a: any) => ({ ...a, test: 0, mutation: { ...a.mutation, file: 0 } })) });
    expectClean(without);
    for (const field of [rec.environment.evidence, rec.suites[0].name, rec.suites[0].output, rec.acceptance[0].description, rec.acceptance[0].red.output, rec.acceptance[0].green.output, rec.acceptance[0].mutation.output, rec.coverage.reason, rec.coverage.tool, rec.prototype_diff.mismatches[0].selector, rec.prototype_diff.mismatches[0].issue, rec.notes, rec.suites[0][`extra [redacted:email]`]]) {
      expectClean(String(field));
    }
    // commands: redacted by span; the program and the subcommand stay
    expect(rec.suites[0].command).toBe('bun test [redacted:resident-number]');
    expect(rec.environment.command).toBe('docker compose up --who [redacted:phone]');
    expect(rec.acceptance[0].red.command).toBe('bun test [redacted:resident-number].test.ts');
    expect(rec.environment.services).toEqual(['db [redacted:email]']);
    // the key of an unknown field is redacted too
    expect(Object.keys(rec.suites[0])).toContain('extra [redacted:email]');
  });

  test('a blocked record: the reason and the evidence output are redacted, and it is still an evidenced block', () => {
    const w = world();
    const body = testBody(w.A, { verdict: 'blocked', blocked: { reason: `no runner: ${ALL}`, evidence: [{ command: `which bun ${PHONE}`, output: ALL }] }, test_files: [], suites: [], acceptance: [] });
    const r = w.cli(w.A, ['test-write'], JSON.stringify(body));
    expect([r.code, r.err]).toEqual([0, '']);
    const rec = readJson(testsDir(w.A));
    expectClean(JSON.stringify(rec.blocked), ['resident-number', 'card', 'phone', 'email', 'secret']);
    expect(rec.blocked.evidence[0].command).toBe('which bun [redacted:phone]');
    const found = findRecentTestFiles(testsDir(w.A), 10);
    expect(found).toHaveLength(1);
    expect(isEvidencedBlocked(found[0]!)).toBe(true);
  });

  test('the sibling copy is redacted too, and the copy keeps its exact fields', () => {
    const w = world();
    w.edit(join(w.B, SRC));
    const r = w.cli(w.B, ['test-write'], JSON.stringify(testBody(w.B)));
    expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
    const out = JSON.parse(r.out) as { path: string; copy?: string };
    expect(out.copy).toBeDefined();
    for (const dir of [testsDir(w.B), testsDir(w.A)]) {
      const rec = readJson(dir);
      expect(rec.tested_files).toEqual([join(w.B, SRC)]);
      expectClean(JSON.stringify({ ...rec, tested_files: 0, test_files: 0, repo: 0, acceptance: rec.acceptance.map((a: any) => ({ ...a, test: 0, mutation: { ...a.mutation, file: 0 } })) }));
    }
    expect(readJson(testsDir(w.A)).repo).toBe(w.B);
  });

  test('notes are redacted before the cut at 4000 characters: a card across the cut is never half visible', () => {
    const w = world();
    for (const pad of [3990, 3996, 3999]) {
      const notes = `${'x'.repeat(pad)}${CARD} and a tail`;
      const r = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { notes })));
      expect(r.code).toBe(0);
    }
    for (let i = 0; i < files(testsDir(w.A)).length; i++) {
      const n = readJson(testsDir(w.A), i).notes as string;
      expect(n.length).toBeLessThanOrEqual(4000);
      expect(n).not.toMatch(/4111|1111 1/);
    }
    expect(files(testsDir(w.A))).toHaveLength(3);
  });

  test('a 1 MB suite output is redacted in one pass and stays quick', () => {
    const w = world();
    const big = `${'lorem ipsum dolor 42 sit amet. '.repeat(33_000)}${ALL}`;
    const body = testBody(w.A);
    body.suites[0].output = big;
    const t0 = performance.now();
    const r = w.cli(w.A, ['test-write'], JSON.stringify(body));
    expect(r.code).toBe(0);
    // measured 0.7 s with the spawn and the repo; the bound is a tenth of the old 30 s
    expect(performance.now() - t0).toBeLessThan(6_000);
    const rec = readJson(testsDir(w.A));
    expect(rec.suites[0].output.length).toBeGreaterThan(900_000);
    expectClean(rec.suites[0].output);
  });
});

// ── review-write ────────────────────────────────────────────────────────────────────────────────────────

describe('M6d review-write', () => {
  const body = (file: string, over: Record<string, unknown> = {}) => ({
    reviewed_files: [file],
    category: 'review-all',
    findings: [
      { file, line: 3, issue: ALL, severity: 'high', probe: ALL },
      { file, issue: ALL, severity: 'low', source: 'codex' },
    ],
    unknown_assumptions_checked: [{ assumption: ALL, reasonable: true, note: ALL }],
    verdict: 'needs-changes',
    dimensions_checked: ['security'],
    codex: { status: 'skipped', reason: ALL, output: ALL },
    ...over,
  });

  test('canaries in every display field are redacted; paths, enums and numbers stay byte-identical', () => {
    const w = world();
    const file = join(w.A, SRC);
    const r = w.cli(w.A, ['review-write'], JSON.stringify(body(file)));
    expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
    const rec = readJson(reviewsDir(w.A));
    expect(rec.reviewed_files).toEqual([file]);
    expect(rec.findings.map((f: any) => f.file)).toEqual([file, file]);
    expect(rec.findings[0]).toMatchObject({ line: 3, severity: 'high' });
    expect(rec.findings[1].source).toBe('codex');
    expect([rec.verdict, rec.category, rec.dimensions_checked, rec.codex.status]).toEqual(['needs-changes', 'review-all', ['security'], 'skipped']);
    for (const field of [rec.findings[0].issue, rec.findings[0].probe, rec.findings[1].issue, rec.unknown_assumptions_checked[0].assumption, rec.unknown_assumptions_checked[0].note, rec.codex.reason, rec.codex.output]) expectClean(String(field));
    expectClean(JSON.stringify({ ...rec, reviewed_files: 0, findings: rec.findings.map((f: any) => ({ ...f, file: 0 })) }));
  });

  test('the Stop reader still takes the record', () => {
    const w = world();
    const r = w.cli(w.A, ['review-write'], JSON.stringify(body(join(w.A, 'gen.ts'))));
    expect(r.code).toBe(0);
    const found = findRecentReviewFiles(reviewsDir(w.A), 10);
    expect(found).toHaveLength(1);
    expect(found[0]!.findings).toHaveLength(2);
    expect(found[0]!.verdict).toBe('needs-changes');
  });

  test('a key of an unknown nested object and a `__proto__` key are handled without pollution', () => {
    const w = world();
    const evil = JSON.parse(`{"__proto__": {"x": "${MAIL}"}, "${PHONE}": "${RRN}"}`);
    const b = body(join(w.A, 'gen.ts'));
    (b.findings[0] as Record<string, unknown>).detail = evil;
    const r = w.cli(w.A, ['review-write'], JSON.stringify(b));
    expect(r.code).toBe(0);
    const text = readText(reviewsDir(w.A));
    expectClean(text, ['email', 'resident-number', 'phone']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

// ── regression ──────────────────────────────────────────────────────────────────────────────────────────

describe('M6d regression', () => {
  const GEN_FAIL = `console.log(${JSON.stringify(ALL)});\nconsole.error(${JSON.stringify(ALL)});\nprocess.exit(1);\n`;

  test('the output tail is redacted on disk, in the sibling copy and in the stderr summary', () => {
    const w = world(GEN_FAIL);
    w.edit(join(w.B, SRC));
    const r = w.cli(w.B, ['regression']);
    expect(r.code).toBe(1);
    expectClean(r.err, ['resident-number']);
    for (const dir of [regDir(w.B), regDir(w.A)]) {
      const text = readText(dir);
      const rec = JSON.parse(text) as RegressionRecord;
      expectClean(rec.runs[0]!.output_tail);
      expect(rec.runs[0]).toMatchObject({ command: 'bun run test', exit_code: 1 });
      expect(rec.verdict).toBe('fail');
      expect(rec.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(rec.runs[0]!.output_tail).toContain('\n[stderr]\n');
      expectClean(text);
    }
    expect(readJson(regDir(w.A)).repo).toBe(w.B);
  });

  test('redacted before the tail cut: a card the cut would split is never half visible', () => {
    // 50 filler characters, the card, then filler so that the last STDOUT_TAIL raw characters start inside the card
    const after = STDOUT_TAIL - 8;
    const gen = `process.stdout.write("z".repeat(50) + ${JSON.stringify(CARD)} + "y".repeat(${after}) + "\\n");\nprocess.exit(1);\n`;
    const w = world(gen);
    expect(w.cli(w.A, ['regression']).code).toBe(1);
    const stdout = (readJson(regDir(w.A)).runs[0].output_tail as string).split('\n[stderr]\n')[0]!;
    expect(stdout.length).toBeLessThanOrEqual(STDOUT_TAIL);
    // bun's own `$ bun gen.ts` line is cut away with the rest of the head; nothing of the card is left
    expect(stdout).not.toMatch(/\d/);
    expect(stdout).not.toContain('1111');
  });

  test('the same for the stderr tail', () => {
    // ten cards in a row, then filler: the start of the last 2000 raw characters falls inside one of them
    // (bun adds a line of its own to stderr after the program's, so the filler is a little short of 2000)
    const gen = `process.stderr.write("z".repeat(50) + (${JSON.stringify(CARD + ' ')}).repeat(10) + "y".repeat(1850) + "\\n");\nprocess.exit(1);\n`;
    const w = world(gen);
    expect(w.cli(w.A, ['regression']).code).toBe(1);
    const tail = readJson(regDir(w.A)).runs[0].output_tail as string;
    const own = tail.split('\n[stderr]\n')[1]!.split('\n')[0]!;
    expect(own.length).toBeLessThanOrEqual(2_000);
    expect(own).toContain('y'.repeat(1000));
    expect(own).not.toMatch(/\d/);
  });

  test('a passing run is untouched: output kept, the record is a pass', () => {
    const w = world('console.log("ran the whole suite 12 tests in 3 files");\n');
    expect(w.cli(w.A, ['regression']).code).toBe(0);
    const rec = readJson(regDir(w.A));
    expect(rec.verdict).toBe('pass');
    expect(rec.runs[0].output_tail).toContain('ran the whole suite 12 tests in 3 files');
  });

  test('writeRegressionRecord redacts every string and key of a record handed to it, and keeps the kept fields', () => {
    const dir = tmp();
    const rec = {
      timestamp: '2026-11-16T03:18:16.000Z',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      tree_after: 'c'.repeat(40),
      changed_files: [`src/${RRN}.ts`],
      source: 'package.json scripts.test',
      runs: [{ command: `bun test ${PHONE}`, program: '/usr/bin/bun', exit_code: 1, duration_ms: 5, output_tail: ALL, [`k ${MAIL}`]: ALL }],
      duration_ms: 5,
      verdict: 'fail',
    } as unknown as RegressionRecord;
    const path = writeRegressionRecord(dir, rec);
    const out = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
    expect(out.changed_files).toEqual(['src/[redacted:resident-number].ts']);
    expect([out.tree, out.tree_after, out.commit, out.verdict, out.runs[0].program]).toEqual(['b'.repeat(40), 'c'.repeat(40), 'a'.repeat(40), 'fail', '/usr/bin/bun']);
    expect(out.runs[0].command).toBe('bun test [redacted:phone]');
    expectClean(out.runs[0].output_tail);
    expectClean(JSON.stringify(out), ['resident-number', 'card', 'phone', 'email', 'secret']);
    // the record in memory is as it was
    expect(rec.runs[0]!.output_tail).toBe(ALL);
  });

  test('outputSummary and the denial message redact what an older record kept raw', () => {
    expect(outputSummary(`boom ${ALL}\n[stderr]\nerr ${ALL}`)).not.toContain('1234567');
    expectClean(outputSummary(`boom ${ALL}\n[stderr]\nerr ${ALL}`), ['resident-number']);
    // redacted before the cut: a number at the cut of the summary window is not half shown
    const text = `${CARD}${'y'.repeat(594)}`;
    expect(outputSummary(text, 600)).not.toMatch(/\d/);
    const rec: RegressionRecord = {
      timestamp: '2026-11-16T03:18:16.000Z',
      commit: null,
      tree: 'b'.repeat(40),
      tree_after: 'b'.repeat(40),
      source: 'package.json scripts.test',
      runs: [{ command: 'bun run test', exit_code: 1, duration_ms: 5, output_tail: `boom ${ALL}` }],
      duration_ms: 5,
      verdict: 'fail',
    };
    const msg = regressionMessage('git push', { ok: false, why: 'failed', rev: 'HEAD', tree: rec.tree, failed: rec }, '/gb/lib/cli.ts', 'the tester');
    expectClean(msg, ['resident-number']);
    expect(msg).toContain('exited 1');
  });
});

// ── a run on real data ──────────────────────────────────────────────────────────────────────────────────

describe('M6d real-data runs record only the M6a result', () => {
  const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let seq = 0;
  /** A sandbox-run result under `root`; `realData` undefined leaves the field out (a run from before M6a). */
  function run(root: string, realData?: unknown, command: string[] = ['bun', 'test']): { run: string; sha: string } {
    const name = stamp(new Date(Date.now() - (30 + ++seq) * 1000));
    const text = JSON.stringify({ ts: name, suite: 'unit', check: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, problems: [] }, command, exit: 0, tail: '', ...(realData === undefined ? {} : { realData }) }, null, 2) + '\n';
    write(root, `.goodboy/sandbox/out/${name}/result.json`, text);
    return { run: name, sha: createHash('sha256').update(text).digest('hex') };
  }

  test('readRunResult: realData is false only when the result says false', () => {
    const root = tmp();
    expect((readRunResult(root, run(root, true).run) as { realData: boolean }).realData).toBe(true);
    expect((readRunResult(root, run(root, false).run) as { realData: boolean }).realData).toBe(false);
    expect((readRunResult(root, run(root).run) as { realData: boolean }).realData).toBe(true);
    expect((readRunResult(root, run(root, 'no').run) as { realData: boolean }).realData).toBe(true);
    expect((readRunResult(root, run(root, null).run) as { realData: boolean }).realData).toBe(true);
  });

  for (const [name, real] of [['true', true], ['absent (a run from before M6a)', undefined]] as const) {
    test(`realData ${name}: display text and commands are withheld, the run's own sandbox-run line stays (redacted by span), the kept fields stay, the Stop validators still accept it`, () => {
      const w = world();
      const sb = run(w.A, real, ['bun', 'test', '--who', RRN]);
      const body = testBody(w.A, { sandbox: { run: sb.run } });
      body.suites[0].command = `bun "${CLI}" sandbox-run --suite unit -- bun test --who ${RRN}`;
      const r = w.cli(w.A, ['test-write'], JSON.stringify(body));
      expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
      const rec = readJson(testsDir(w.A));
      expect(rec.suites[0].output).toBe(WITHHELD_TEXT);
      expect(rec.suites[0].name).toBe(WITHHELD_TEXT);
      expect(rec.acceptance[0].description).toBe(WITHHELD_TEXT);
      for (const k of ['red', 'green', 'mutation'] as const) expect(rec.acceptance[0][k].output).toBe(WITHHELD_TEXT);
      expect(rec.environment.evidence).toBe(WITHHELD_TEXT);
      expect(rec.environment.services).toEqual([WITHHELD_TEXT]);
      expect([rec.coverage.reason, rec.coverage.tool]).toEqual([WITHHELD_TEXT, WITHHELD_TEXT]);
      expect([rec.prototype_diff.mismatches[0].selector, rec.prototype_diff.mismatches[0].issue]).toEqual([WITHHELD_TEXT, WITHHELD_TEXT]);
      expect(rec.notes).toBe(WITHHELD_TEXT);
      expect(rec.suites[0]['extra [redacted:email]']).toBe(WITHHELD_TEXT);
      // the run's own line stays, redacted by span; every other command is withheld
      expect(rec.suites[0]).toMatchObject({ command: `bun "${CLI}" sandbox-run --suite unit -- bun test --who [redacted:resident-number]`, passed: 1, failed: 0, type: 'unit', duration_ms: 10 });
      expect(rec.acceptance[0]).toMatchObject({ id: 'AC-1', test: TST });
      expect(rec.acceptance[0].red).toMatchObject({ exit_code: 1, command: WITHHELD_TEXT });
      expect([rec.acceptance[0].green.command, rec.acceptance[0].mutation.command, rec.environment.command]).toEqual([WITHHELD_TEXT, WITHHELD_TEXT, WITHHELD_TEXT]);
      expect(rec.sandbox).toMatchObject({ run: sb.run, result_sha256: sb.sha, inner_only: true, egress_blocked: true, hosts_to_dummies: true });
      expect(rec.verdict).toBe('pass');
      expect(JSON.stringify(rec)).not.toContain('canary');
      // the Stop's readers
      const [found] = findRecentTestFiles(testsDir(w.A), 10) as TestResult[];
      expect(found).toBeDefined();
      expect(validateEvidence([found!])).toBeNull();
      expect(failingSuites([found!])).toBeNull();
      expect(missingTestFiles([found!])).toBeNull();
      expect(typeof sandboxProof(w.A, found!)).toBe('object');
    });
  }

  test('a blocked record of a real-data run keeps its reason and evidence valid (the withheld text satisfies the length and non-empty rules)', () => {
    const w = world();
    const sb = run(w.A, true);
    const body = testBody(w.A, { verdict: 'blocked', blocked: { reason: `no runner ${ALL}`, evidence: [{ command: 'which bun', output: ALL }] }, test_files: [], suites: [], acceptance: [], sandbox: { run: sb.run } });
    const r = w.cli(w.A, ['test-write'], JSON.stringify(body));
    expect([r.code, r.err]).toEqual([0, '']);
    const found = findRecentTestFiles(testsDir(w.A), 10);
    expect(found[0]!.blocked).toEqual({ reason: WITHHELD_TEXT, evidence: [{ command: WITHHELD_TEXT, output: WITHHELD_TEXT }] });
    expect(isEvidencedBlocked(found[0]!)).toBe(true);
  });

  test('a suite command that is not the run\'s own sandbox-run line is withheld, a different run\'s line too', () => {
    const w = world();
    const sb = run(w.A, true, ['bun', 'test']);
    const body = testBody(w.A, { sandbox: { run: sb.run } });
    body.suites = [
      { name: 'a', command: `bun test ${RRN}`, passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 1 },
      { name: 'b', command: `bun "${CLI}" sandbox-run --suite unit -- bun test --other ${RRN}`, passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 1 },
      { name: 'c', command: `bun "${CLI}" sandbox-run --suite unit -- bun test`, passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 1 },
      { name: 'd', command: `echo ${RRN}; bun "${CLI}" sandbox-run --suite unit -- bun test`, passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 1 },
      // the run's own line with a flag a caller chose: a name has no shape the detectors know (delta review)
      { name: 'e', command: `bun "${CLI}" sandbox-run --suite unit --who=Hong-Gildong -- bun test`, passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 1 },
      { name: 'f', command: `bun --note Hong-Gildong "${CLI}" sandbox-run --suite unit -- bun test`, passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 1 },
      { name: 'g', command: `bun "${CLI}" sandbox-run --suite unit --timeout-ms 600000 -- bun test`, passed: 1, failed: 0, output: 'o', type: 'unit', duration_ms: 1 },
    ];
    expect(w.cli(w.A, ['test-write'], JSON.stringify(body)).code).toBe(0);
    const rec = readJson(testsDir(w.A));
    expect(rec.suites.map((x: any) => x.command)).toEqual([
      WITHHELD_TEXT,
      WITHHELD_TEXT,
      `bun "${CLI}" sandbox-run --suite unit -- bun test`,
      WITHHELD_TEXT,
      WITHHELD_TEXT,
      WITHHELD_TEXT,
      `bun "${CLI}" sandbox-run --suite unit --timeout-ms 600000 -- bun test`,
    ]);
    expect(JSON.stringify(rec)).not.toContain('Hong-Gildong');
  });

  test('realData false: the record is redacted, not withheld; a record with no sandbox run is not withheld either', () => {
    const w = world();
    const sb = run(w.A, false);
    expect(w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { sandbox: { run: sb.run } }))).code).toBe(0);
    const kept = readJson(testsDir(w.A));
    expect(kept.suites[0].output).not.toBe(WITHHELD_TEXT);
    expectClean(kept.suites[0].output);
    const w2 = world();
    expect(w2.cli(w2.A, ['test-write'], JSON.stringify(testBody(w2.A))).code).toBe(0);
    expect(readJson(testsDir(w2.A)).suites[0].output).not.toBe(WITHHELD_TEXT);
  });

  test('the sibling copy of a real-data record is withheld too', () => {
    const w = world();
    w.edit(join(w.B, SRC));
    const sb = run(w.B, true);
    const r = w.cli(w.B, ['test-write'], JSON.stringify(testBody(w.B, { sandbox: { run: sb.run } })));
    expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
    for (const dir of [testsDir(w.B), testsDir(w.A)]) {
      const rec = readJson(dir);
      expect(rec.suites[0].output).toBe(WITHHELD_TEXT);
      expect(rec.notes).toBe(WITHHELD_TEXT);
    }
    expect(readJson(testsDir(w.A)).repo).toBe(w.B);
  });
});

// ── ids and paths that hold personal data stop the write ───────────────────────────────────────────────────

describe('M6d an id or a path that holds personal data stops test-write and review-write', () => {
  const refused = (w: World, cmd: 'test-write' | 'review-write', body: unknown, ...fields: string[]): void => {
    const r = w.cli(w.A, [cmd], JSON.stringify(body));
    expect(r.code).toBe(1);
    expect(r.err).toContain('the record is not written');
    for (const f of fields) expect(r.err).toContain(f);
    // the field and the kind, never the value
    for (const v of [...RAW, '9999-8888', '5555']) expect(r.err).not.toContain(v);
    expect(files(cmd === 'test-write' ? testsDir(w.A) : reviewsDir(w.A))).toEqual([]);
  };

  test('test-write: a tested or test file named like personal data is refused, by field and kind', () => {
    const w = world();
    refused(w, 'test-write', testBody(w.A, { tested_files: [join(w.A, 'src', `${PHONE}.ts`)] }), 'tested_files[0] holds a phone');
    refused(w, 'test-write', testBody(w.A, { test_files: [join(w.A, `${RRN}.test.ts`)] }), 'test_files[0] holds a resident-number');
  });

  test('test-write: a category, an acceptance id, a test and a mutation file that hold text or personal data are refused', () => {
    const w = world();
    refused(w, 'test-write', testBody(w.A, { category: `add-feature for Kim ${PHONE}` }), 'category not an identifier');
    const bad = (patch: Record<string, unknown>) => {
      const b = testBody(w.A);
      Object.assign(b.acceptance[0], patch);
      return b;
    };
    refused(w, 'test-write', bad({ id: `T-1 ${CARD}` }), 'acceptance[0].id not an identifier');
    refused(w, 'test-write', bad({ test: `${TST} :: ${MAIL}` }), 'acceptance[0].test holds a email');
    const m = testBody(w.A);
    m.acceptance[0].mutation.file = `src/${PHONE}.ts`;
    refused(w, 'test-write', m, 'acceptance[0].mutation.file holds a phone');
  });

  test('test-write: a coverage.changed key and list item, and a subprocess pair, that hold personal data are refused', () => {
    const w = world();
    // (N8) With the fields test-write requires of every entry (files, in_report, diff_lines, base).
    const changed = (over: Record<string, unknown>) => ({ covered: 1, total: 1, files_without_executed_changes: [] as string[], files: { [SRC]: { covered: 1, total: 1 } }, in_report: [SRC], diff_lines: { [SRC]: 1 }, base: 'a'.repeat(40), ...over });
    refused(w, 'test-write', testBody(w.A, { coverage: { status: 'measured', changed: changed({ files: { [`src/${PHONE}.ts`]: { covered: 1, total: 1 } } }) } }), 'coverage.changed.files.{a key} holds a phone');
    refused(w, 'test-write', testBody(w.A, { coverage: { status: 'measured', changed: changed({ files_without_executed_changes: [`leak ${MAIL}`] }) } }), 'coverage.changed.files_without_executed_changes[0] holds a email');
    refused(w, 'test-write', testBody(w.A, { coverage: { status: 'measured', changed: [changed({ diff_lines: { [`${RRN}.ts`]: 1 } })] } }), 'coverage.changed[0].diff_lines.{a key} holds a resident-number');
    refused(w, 'test-write', testBody(w.A, { coverage: { status: 'measured', subprocess: [{ file: SRC, test: `${TST} ${PHONE}` }] } }), 'coverage.subprocess[0].test holds a phone');
  });

  test('test-write: an unknown key and an item of coverage.changed or of a subprocess pair are redacted like display text', () => {
    const w = world();
    const cov = {
      status: 'measured',
      // (N8) With the fields test-write requires of every entry (files, in_report, diff_lines, base).
      changed: { covered: 1, total: 1, files_without_executed_changes: [], files: { [SRC]: { covered: 1, total: 1 } }, in_report: [SRC], diff_lines: { [SRC]: 1 }, base: 'a'.repeat(40), note: ALL, [`k ${MAIL}`]: ALL },
      subprocess: [{ file: SRC, test: TST, extra: ALL }],
    };
    const r = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { coverage: cov })));
    expect([r.code, r.err.includes('Error')]).toEqual([0, false]);
    const rec = readJson(testsDir(w.A));
    expectClean(JSON.stringify({ ...rec.coverage.changed, files: 0 }));
    expectClean(String(rec.coverage.subprocess[0].extra));
    expect(rec.coverage.changed.files).toEqual({ [SRC]: { covered: 1, total: 1 } });
    expect(rec.coverage.subprocess[0]).toMatchObject({ file: SRC, test: TST });
  });

  test('test-write: a mismatch severity that is free text is refused by the validator, a real one is kept', () => {
    const w = world();
    const r = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { prototype_diff: { prototype_path: 'docs/p.html', mismatches: [{ selector: 's', issue: 'i', severity: `note ${PHONE}` }] } })));
    expect(r.code).toBe(1);
    expect(r.err).toContain('prototype_diff.mismatches[0].severity');
    expect(r.err).not.toContain(PHONE);
    // an identifier-shaped value that is no severity is refused by the validator too
    const r2 = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { prototype_diff: { prototype_path: 'docs/p.html', mismatches: [{ selector: 's', issue: 'i', severity: 'urgent' }, { selector: 't', issue: 'j' }] } })));
    expect(r2.code).toBe(1);
    expect(r2.err).toContain('prototype_diff.mismatches[0].severity');
    expect(r2.err).toContain('prototype_diff.mismatches[1].severity');
    expect(w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A))).code).toBe(0);
    expect(readJson(testsDir(w.A)).prototype_diff.mismatches[0].severity).toBe('low');
  });

  test('test-write: the sibling copy\'s `repo` is checked too: a repo directory named like a phone number stops the write before either record', () => {
    const w = world();
    const B2 = join(w.base, `sib-${PHONE}`);
    makeRepo(B2);
    w.edit(join(B2, SRC));
    // the tested files are the project's own, so the record's other paths hold nothing; only the copy's `repo` does
    const r = w.cli(B2, ['test-write'], JSON.stringify(testBody(w.A)));
    expect(r.code).toBe(1);
    expect(r.err).toContain('repo holds a phone');
    expect(r.err).not.toContain(PHONE);
    expect(files(testsDir(B2))).toEqual([]);
    expect(files(testsDir(w.A))).toEqual([]);
  });

  test('review-write: a category, a dimension, a reviewed file and a finding file that hold text or personal data are refused', () => {
    const w = world();
    const body = (over: Record<string, unknown>) => ({ reviewed_files: [join(w.A, 'gen.ts')], category: 'review-all', findings: [{ file: join(w.A, 'gen.ts'), issue: 'i', severity: 'low' }], unknown_assumptions_checked: [], verdict: 'pass', dimensions_checked: ['security'], ...over });
    refused(w, 'review-write', body({ category: `x@${'corp.co.kr'}` }), 'category not an identifier');
    refused(w, 'review-write', body({ dimensions_checked: ['security', `security ${RRN}`] }), 'dimensions_checked[1] not an identifier');
    refused(w, 'review-write', body({ reviewed_files: [join(w.A, `${PHONE}.ts`)] }), 'reviewed_files[0] holds a phone');
    refused(w, 'review-write', body({ findings: [{ file: `see ${MAIL}`, issue: 'i', severity: 'low' }] }), 'findings[0].file holds a email');
  });

  test('a record with plain ids and paths is written and keeps them byte for byte (the three identifiers of each kind)', () => {
    const w = world();
    expect(w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { category: 'add-feature', acceptance: [{ ...testBody(w.A).acceptance[0], id: 'UIUX-NEW-3' }] }))).code).toBe(0);
    const rec = readJson(testsDir(w.A));
    expect([rec.category, rec.acceptance[0].id, rec.acceptance[0].test]).toEqual(['add-feature', 'UIUX-NEW-3', TST]);
  });
});

// ── what reaches stderr ─────────────────────────────────────────────────────────────────────────────────────

describe('M6d stderr shows no caller text', () => {
  test('a validation error shows the caller\'s value redacted and cut, never raw', () => {
    const w = world();
    const r1 = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { verdict: `call ${PHONE} ${'z'.repeat(300)}` })));
    expect(r1.code).toBe(1);
    expect(r1.err).toContain('[redacted:phone]');
    expect(r1.err).not.toContain(PHONE);
    expect(r1.err).not.toContain('z'.repeat(100));
    const b = testBody(w.A);
    b.environment.mode = `x ${MAIL}`;
    b.suites[0].type = `y ${RRN}`;
    const r2 = w.cli(w.A, ['test-write'], JSON.stringify(b));
    expect(r2.code).toBe(1);
    for (const v of [MAIL, RRN]) expect(r2.err).not.toContain(v);
    const r3 = w.cli(w.A, ['review-write'], JSON.stringify({ reviewed_files: ['a.ts'], category: 'c', findings: [{ file: 'a.ts', issue: 'i', severity: `s ${PHONE}` }], verdict: `v ${RRN}` }));
    expect(r3.code).toBe(1);
    for (const v of [PHONE, RRN]) expect(r3.err).not.toContain(v);
    expect(r3.err).toContain('[redacted:');
  });

  test('the refusal of a record written from goodboy\'s own directory names the file redacted', () => {
    // a copy of lib/ as the plugin root (no git repo, like an installed plugin); the CLI runs from there
    const plugin = join(tmp(), 'goodboy');
    mkdirSync(plugin, { recursive: true });
    cpSync(join(ROOT, 'lib'), join(plugin, 'lib'), { recursive: true });
    const elsewhere = join(tmp(), `made-${PHONE}.ts`);
    const body = { category: 'add-feature', reviewed_files: [elsewhere], dimensions_checked: ['security-authz'], findings: [], verdict: 'pass', summary: 'ok' };
    const p = Bun.spawnSync(['bun', join(plugin, 'lib', 'cli.ts'), 'review-write'], { cwd: join(plugin, 'lib'), stdin: new TextEncoder().encode(JSON.stringify(body)), stdout: 'pipe', stderr: 'pipe', env: cleanEnv({}) });
    const err = p.stderr.toString() + p.stdout.toString();
    expect(p.exitCode).toBe(1);
    expect(err).toContain("is outside goodboy's own directory");
    expect(err).toContain('[redacted:phone]');
    expect(err).not.toContain(PHONE);
    expect(existsSync(join(plugin, 'lib', '.claude'))).toBe(false);
  });

  test('a missing test file is named redacted', () => {
    const w = world();
    const r = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { test_files: [`missing-${PHONE}.test.ts`] })));
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing-[redacted:phone].test.ts');
    expect(r.err).not.toContain(PHONE);
  });

  test('the mutation-run warning names the suite redacted, and not at all for a run on real data', () => {
    const w = world();
    const body = testBody(w.A);
    body.suites[0] = { ...body.suites[0], name: `mutation run ${PHONE}`, failed: 2 };
    delete body.suites[0][`extra ${MAIL}`];
    const r = w.cli(w.A, ['test-write'], JSON.stringify(body));
    expect(r.code).toBe(0);
    expect(r.err).toContain('warning: suite "mutation run [redacted:phone]"');
    expect(r.err).not.toContain(PHONE);
  });

  test('a run on real data: an error shows none of the input, the mutation-run warning shows no suite name', () => {
    const w = world();
    const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const name = stamp(new Date(Date.now() - 45_000));
    const text = JSON.stringify({ ts: name, suite: 'unit', check: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, problems: [] }, command: ['bun', 'test'], exit: 0, tail: '', realData: true }, null, 2) + '\n';
    write(w.A, `.goodboy/sandbox/out/${name}/result.json`, text);
    const bad = testBody(w.A, { sandbox: { run: name }, verdict: 'Kim Minsu' });
    const r = w.cli(w.A, ['test-write'], JSON.stringify(bad));
    expect(r.code).toBe(1);
    expect(r.err).toContain('[withheld]');
    expect(r.err).not.toContain('Kim Minsu');
    const body = testBody(w.A, { sandbox: { run: name } });
    body.suites[0] = { ...body.suites[0], name: 'mutation run of Kim Minsu', failed: 2 };
    const ok = w.cli(w.A, ['test-write'], JSON.stringify(body));
    expect(ok.code).toBe(0);
    expect(ok.err).toContain('warning: suite "[withheld]"');
    expect(ok.err).not.toContain('Kim Minsu');
  });

  test('a sandbox flag the caller adds that the run\'s result contradicts is shown redacted, and withheld for a run on real data', () => {
    const w = world();
    const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const mk = (secs: number, realData: boolean): string => {
      const name = stamp(new Date(Date.now() - secs * 1000));
      const text = JSON.stringify({ ts: name, suite: 'unit', check: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, problems: [] }, command: ['bun', 'test'], exit: 0, tail: '', realData }, null, 2) + '\n';
      write(w.A, `.goodboy/sandbox/out/${name}/result.json`, text);
      return name;
    };
    const real = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { sandbox: { run: mk(61, true), inner_only: `Kim ${PHONE}` } })));
    expect(real.code).toBe(1);
    expect(real.err).toContain('sandbox.inner_only is [withheld]');
    for (const v of ['Kim', PHONE]) expect(real.err).not.toContain(v);
    const fake = w.cli(w.A, ['test-write'], JSON.stringify(testBody(w.A, { sandbox: { run: mk(62, false), inner_only: `Kim ${PHONE}` } })));
    expect(fake.code).toBe(1);
    expect(fake.err).toContain('sandbox.inner_only is Kim [redacted:phone]');
    expect(fake.err).not.toContain(PHONE);
  });

  test('regression: the names of the files a run changed are redacted on stderr and in the record', () => {
    const w = world(`require('fs').writeFileSync('made-${PHONE}.txt', 'x');\n`);
    const r = w.cli(w.A, ['regression']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('made-[redacted:phone].txt');
    expect(r.err).not.toContain(PHONE);
    const rec = readJson(regDir(w.A));
    expect(rec.changed_files).toEqual(['made-[redacted:phone].txt']);
  });
});

// ── the tail cut ────────────────────────────────────────────────────────────────────────────────────────────

describe('M6d redactedTail', () => {
  test('a window that starts inside a value never shows its head, even when the redaction shrinks it below the tail', () => {
    // the window starts inside a card; a long key block follows and shrinks to one placeholder
    const raw = `1111 1111 1111 ${'x'.repeat(100)}-----BEGIN PRIVATE KEY-----${'A'.repeat(21_000)}-----END PRIVATE KEY-----done`;
    const tail = redactedTail(raw, 6_000);
    expect(tail).not.toContain('1111');
    expect(tail).not.toContain('xxxx');
    expect(tail).toBe('done');
    // the old order (redact, then keep the last 6000) would have kept the head
    expect(redactText(raw).slice(-6_000)).toContain('1111 1111 1111');
  });

  test('a span the cut falls in is dropped whole, the text after it is kept, and the result is at most n long', () => {
    const raw = `${'a'.repeat(50)}${CARD}${'b'.repeat(40)}`;
    for (let n = 30; n <= 100; n++) {
      const t = redactedTail(raw, n);
      expect(t.length).toBeLessThanOrEqual(n);
      expect(t).not.toMatch(/\d/);
      expect(t.endsWith('b'.repeat(Math.min(n, 40)))).toBe(true);
    }
    expect(redactedTail('short 900101-1234567', 6_000)).toBe('short [redacted:resident-number]');
    expect(redactedTail('x'.repeat(10_000), 6_000)).toBe('x'.repeat(6_000));
  });

  test('a placeholder longer than the short value it replaced still leaves a result of at most n characters', () => {
    // the cut falls exactly before a phone number: its placeholder (16 characters) is longer than the number (13)
    const raw = `${'x'.repeat(100)}010-1234-5678`;
    for (const n of [13, 14, 15]) {
      const t = redactedTail(raw, n);
      expect(t.length).toBeLessThanOrEqual(n);
      expect(t).not.toMatch(/\d/);
    }
    expect(redactedTail(raw, 13)).toBe(redactText(raw.slice(-13)).slice(-13));
  });

  test('stdout and stderr tails use it: the sizes are the constants', () => {
    expect(STDOUT_TAIL).toBe(6_000);
    expect(STDERR_TAIL).toBe(2_000);
  });
});
