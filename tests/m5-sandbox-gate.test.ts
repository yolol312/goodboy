// M5 trial: a passing sandbox run is the layer-1 test of the sandbox's own files. A changed file
// under `.goodboy/sandbox/` counts as tested when a passing test record is bound to a verified
// sandbox run (`sandbox: {run}`, checked as backfill-mark checks it) that started at or after the
// file's last edit; such files need no changed-line coverage, test type or existing-test edge.
// The Stop hook runs for real (spawned, as tests/i23-gate-scope-stop.test.ts does); repos and
// session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import { SANDBOX_DIR as RENDER_DIR } from '../lib/sandbox-render';
import { isSandboxLayout, SANDBOX_PREFIX, sandboxExemptRel, sandboxGapReason, sandboxGaps, sandboxRel, sandboxTestEdits, sandboxTestRel, sandboxUsed, sandboxUsers } from '../lib/sandbox-gate';
import { planSandbox } from '../lib/sandbox-render';
import type { SandboxLocal, SandboxScan } from '../lib/sandbox-types';

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
  const s = `m5s${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
const V1 = 'export const a = 1;\n';
const TEST = 'import { expect, test } from "bun:test";\nimport { a } from "../src/calc";\ntest("a", () => { expect(a).toBe(1); });\n';

function project(): { d: string; s: string } {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m5s-')));
  dirs.push(d);
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  write(d, 'src/calc.ts', V1);
  write(d, 'tests/a.test.ts', TEST);
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  const s = sid();
  pinCoverageStart(s, d);
  return { d, s };
}
/** A sandbox file the session wrote: on disk and in the edit log. */
function sandboxEdit(d: string, s: string, rel: string, text = 'x: 1\n'): string {
  const abs = write(d, `.goodboy/sandbox/${rel}`, text);
  recordEdit(s, abs, 0, undefined, Date.now());
  return abs;
}
const pad = (n: number) => String(n).padStart(2, '0');
/** The directory name of a sandbox-run started at `ms` (UTC, to the second). */
function runName(ms: number): string {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}
/** `out/<run>/result.json` as sandbox-run writes it; returns its SHA-256. */
function makeRun(d: string, run: string, over: Record<string, unknown> = {}, check: Record<string, boolean> = {}): string {
  const text = JSON.stringify({ ts: run, exit: 0, command: ['docker', 'compose', 'run'], suite: 'unit', check: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, ...check }, ...over });
  write(d, `.goodboy/sandbox/out/${run}/result.json`, text);
  return createHash('sha256').update(text).digest('hex');
}
/** The e2e step a `sandbox-run` that ran the browser suite writes into result.json. */
const E2E_DONE = { e2e: { step: 'e2e', exit: 0, timedOut: false }, playwrightReport: '/out/playwright-report.json' };
function record(d: string, run: string, sha: string, over: Record<string, unknown> = {}) {
  return {
    timestamp: new Date(Date.now() + 2_000).toISOString(),
    tested_files: [join(d, 'src', 'calc.ts')],
    category: 'fix-bug',
    test_files: [join(d, 'tests', 'a.test.ts')],
    environment: { mode: 'none', command: 'none', evidence: 'library' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [
      {
        id: 'AC-1',
        description: 'a is exported',
        test: 'tests/a.test.ts',
        red: { command: 'bun test (before)', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test', output: '1 pass', exit_code: 0 },
      },
    ],
    sandbox: { inner_only: true, egress_blocked: true, hosts_to_dummies: true, run, result_sha256: sha },
    verdict: 'pass',
    ...over,
  };
}
function putRecord(d: string, ...recs: unknown[]) {
  const dir = join(d, '.claude', 'tests');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  recs.forEach((rec, i) => writeFileSync(join(dir, `r${i}.json`), JSON.stringify(rec)));
}
async function stop(d: string, s: string, env: Record<string, string> = {}, active = false) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
    cwd: d,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: active })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_TEST_GATE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off', ...env },
  });
  const out = (await new Response(p.stdout).text()) || '{}';
  await p.exited;
  return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
}
const SANDBOX_ASKED = /Sandbox files changed without a sandbox run that tests them/;
const NO_RESULT = /No test result covers the changed code/;
/** The test gate has nothing to ask (a review block may follow: the review gate asks for these files too). */
const testGateSilent = (out: { reason?: string }) => !/테스트 게이트|Sandbox files changed|No test result covers/.test(out.reason ?? '');
const now = () => Date.now();
/** A run that started a second after the edits, so the second-granular name is not before them. */
const later = () => runName(now() + 1_000);

describe('the sandbox dir and what a sandbox file is', () => {
  test('the path is the one the renderer writes', () => {
    expect(`${RENDER_DIR}/`).toBe(SANDBOX_PREFIX);
  });

  test('sandboxFileRel: below the sandbox dir, links resolved, a hard link is code', () => {
    const { d } = project();
    const compose = write(d, '.goodboy/sandbox/compose.yml', 'x: 1\n');
    expect(sandboxExemptRel(compose, d)).toBe('compose.yml');
    expect(sandboxExemptRel(write(d, '.goodboy/sandbox/db/db/reset.sh', 'x\n'), d)).toBe('db/db/reset.sh');
    expect(sandboxExemptRel(join(d, 'src', 'calc.ts'), d)).toBeNull();
    expect(sandboxExemptRel(write(d, '.goodboy/other.yml', 'x\n'), d)).toBeNull();
    // A link out of the dir is judged by its target; a link into it from outside is the target's.
    symlinkSync(join(d, 'src', 'calc.ts'), join(d, '.goodboy', 'sandbox', 'link.ts'));
    expect(sandboxExemptRel(join(d, '.goodboy', 'sandbox', 'link.ts'), d)).toBeNull();
    sh(d, 'ln src/calc.ts .goodboy/sandbox/hard.ts');
    expect(sandboxExemptRel(join(d, '.goodboy', 'sandbox', 'hard.ts'), d)).toBeNull();
  });

  test('sandbox-run output (out/) is no file a run can test', () => {
    const { d } = project();
    expect(sandboxTestRel(write(d, '.goodboy/sandbox/out/20261026T010101Z/result.json', '{}'), d)).toBeNull();
    expect(sandboxTestRel(write(d, '.goodboy/sandbox/runtime/coverage.sh', 'x\n'), d)).toBe('runtime/coverage.sh');
  });

  test('the Stop hook does not load the sandbox renderer, scanner or file writer', () => {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+'(\.[^']+)'/g)) {
        const target = resolve(dirname(file), `${m[1]!}.ts`);
        try {
          walk(target);
        } catch {
          // not a plain .ts file path
        }
      }
    };
    walk(join(ROOT, 'lib', 'sandbox-gate.ts'));
    const names = [...seen].map((f) => f.slice(ROOT.length + 1));
    for (const heavy of ['lib/sandbox-render.ts', 'lib/sandbox-scan.ts', 'lib/sandbox-files.ts', 'lib/sandbox-run.ts', 'lib/sandbox-e2e.ts']) expect(names).not.toContain(heavy);
  });
});

describe('sandboxGaps (in-process)', () => {
  test('a verified, passing, bound run after the last edit covers every sandbox file', () => {
    const { d } = project();
    const run = later();
    const sha = makeRun(d, run);
    const rec = record(d, run, sha) as never;
    expect(sandboxGaps(d, [{ rel: 'compose.yml', lastEdit: now() }, { rel: 'db/db/reset.sh', lastEdit: now() }], [rec])).toEqual([]);
    expect(sandboxGaps(d, [{ rel: 'compose.yml', lastEdit: now() }], [])[0]!.why).toMatch(/no passing record is bound/);
  });
});

describe('sandboxGaps and sandboxGapReason say what is missing (in-process)', () => {
  test('a run that started before the last edit is no proof, and a run for another file does not help', () => {
    const { d } = project();
    const run = runName(now() - 60_000);
    const rec = record(d, run, makeRun(d, run)) as never;
    const gaps = sandboxGaps(d, [{ rel: 'compose.yml', lastEdit: now() }], [rec]);
    expect(gaps.map((g) => g.rel)).toEqual(['compose.yml']);
    expect(gaps[0]!.why).toBe('every recorded run started before its last edit');
  });

  test('an e2e-only file needs a run whose e2e step passed: a unit run leaves a gap, an e2e run covers it', () => {
    const { d } = project();
    const run = later();
    const unit = record(d, run, makeRun(d, run, { suite: 'unit' })) as never;
    const edits = [{ rel: 'proxy/Caddyfile', lastEdit: now() }, { rel: 'compose.yml', lastEdit: now() }];
    const gaps = sandboxGaps(d, edits, [unit]);
    expect(gaps.map((g) => g.rel)).toEqual(['proxy/Caddyfile']);
    expect(gaps[0]!.why).toMatch(/used only by the e2e path/);
    const run2 = runName(now() + 2_000);
    const e2e = record(d, run2, makeRun(d, run2, { suite: 'e2e', ...E2E_DONE })) as never;
    expect(sandboxGaps(d, edits, [e2e])).toEqual([]);
  });

  test('a record whose run does not verify is named in the gap', () => {
    const { d } = project();
    const run = later();
    const rec = record(d, run, 'f'.repeat(64)) as never;
    makeRun(d, run);
    const gaps = sandboxGaps(d, [{ rel: 'compose.yml', lastEdit: now() }], [rec]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.why).toMatch(/^no passing record is bound to a verified sandbox run \(.+\)$/);
  });

  test('the reason lists five gaps with a count of the rest, and names the command and the exemption', () => {
    const gaps = Array.from({ length: 7 }, (_, i) => ({ rel: `db/d${i}/reset.sh`, why: 'no passing record is bound to a verified sandbox run' }));
    const reason = sandboxGapReason(gaps, '/x/cli.ts');
    expect(reason).toContain('Sandbox files changed without a sandbox run that tests them: ');
    expect(reason).toContain('.goodboy/sandbox/db/d0/reset.sh (no passing record');
    expect(reason).toContain('.goodboy/sandbox/db/d4/reset.sh');
    expect(reason).not.toContain('db/d5/reset.sh');
    expect(reason).toContain(' and 2 more');
    expect(reason).toContain('bun "/x/cli.ts" sandbox-run --suite all');
    expect(reason).toContain('changed-line coverage and test types do not apply');
    expect(sandboxGapReason(gaps.slice(0, 1), '/x/cli.ts')).not.toContain('more');
  });
});

describe('sandboxUsers fails closed on too many changed files', () => {
  test('after 400 readable code files it stops reading and treats every layout file as used', () => {
    const { d } = project();
    const files = Array.from({ length: 401 }, (_, i) => write(d, `src/gen/f${i}.ts`, `export const v${i} = ${i};\n`));
    const few = sandboxUsers(d, files.slice(0, 400));
    expect(few.all).toBe(false);
    const many = sandboxUsers(d, files);
    expect(many.all).toBe(true);
    expect(sandboxTestEdits([{ file: write(d, '.goodboy/sandbox/compose.yml', 'x: 1\n') }], d, () => many)).toEqual([]);
  });
});

describe('Stop, end to end: a session that changed only sandbox files', () => {
  test('blocked without a run record, and the message says how to get one', async () => {
    const { d, s } = project();
    sandboxEdit(d, s, 'compose.yml');
    sandboxEdit(d, s, 'runtime/coverage.sh', '#!/bin/sh\n');
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(SANDBOX_ASKED);
    expect(out.reason).toContain('compose.yml');
    expect(out.reason).toContain('sandbox-run --suite all');
    expect(out.reason).toContain('run-sandbox');
    expect(out.reason).not.toMatch(NO_RESULT);
  }, 60_000);

  test('passes with a passing record bound to a verified run that started after the edits', async () => {
    const { d, s } = project();
    sandboxEdit(d, s, 'compose.yml');
    sandboxEdit(d, s, 'ca/server.crt', 'PEM\n');
    sandboxEdit(d, s, 'db/db/reset.sh', '#!/bin/sh\n');
    const run = later();
    putRecord(d, record(d, run, makeRun(d, run)));
    const out = await stop(d, s);
    expect(testGateSilent(out)).toBe(true);
    expect(out.reason).toMatch(/Review is required/); // the normal review still follows
  }, 60_000);

  test('the run does not count when it started before the last edit', async () => {
    const { d, s } = project();
    const run = runName(now() - 60_000);
    const sha = makeRun(d, run);
    sandboxEdit(d, s, 'compose.yml');
    putRecord(d, record(d, run, sha));
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(SANDBOX_ASKED);
    expect(out.reason).toMatch(/started before its last edit/);
  }, 60_000);

  test('a result.json that changed after the record, a failed check and a non-zero exit do not count', async () => {
    for (const [what, mutate, why] of [
      ['hash', (d: string, run: string) => writeFileSync(join(d, '.goodboy/sandbox/out', run, 'result.json'), JSON.stringify({ ts: run, exit: 0, command: ['x'], check: { inner_only: true, egress_blocked: true, hosts_to_dummies: true }, extra: 1 })), /changed after the record/],
      ['check', null, /did not pass its sandbox check/],
      ['exit', null, /did not exit 0/],
    ] as const) {
      const { d, s } = project();
      sandboxEdit(d, s, 'compose.yml');
      const run = later();
      const sha = makeRun(d, run, what === 'exit' ? { exit: 1 } : {}, what === 'check' ? { egress_blocked: false } : {});
      putRecord(d, record(d, run, sha));
      mutate?.(d, run);
      const out = await stop(d, s);
      expect([what, out.decision]).toEqual([what, 'block']);
      expect([what, out.reason]).toEqual([what, expect.stringMatching(SANDBOX_ASKED)]);
      expect([what, out.reason]).toEqual([what, expect.stringMatching(why)]);
    }
  }, 120_000);

  test('a record without the sandbox claim, or a blocked one, is no proof', async () => {
    // One project per case: a second Stop with no change since the first does not block again (v0.36.8).
    for (const extra of [{ sandbox: undefined }, { verdict: 'blocked', blocked: { reason: 'the sandbox is down for the test', evidence: 'docker ps: no daemon' } }]) {
      const { d, s } = project();
      sandboxEdit(d, s, 'compose.yml');
      const run = later();
      const sha = makeRun(d, run);
      putRecord(d, record(d, run, sha, extra));
      expect((await stop(d, s)).reason).toMatch(SANDBOX_ASKED);
    }
  }, 60_000);

  test('a file only the e2e path uses needs a run whose e2e step ran and passed', async () => {
    const cases: [string, Record<string, unknown>, boolean][] = [
      ['unit run', { suite: 'unit' }, false],
      ['suite all, but no e2e step (`--suite all -- true`, or no e2e tests)', { suite: 'all' }, false],
      ['e2e step failed', { suite: 'e2e', ...E2E_DONE, e2e: { step: 'e2e', exit: 1, timedOut: false } }, false],
      ['e2e step timed out', { suite: 'e2e', ...E2E_DONE, e2e: { step: 'e2e', exit: 0, timedOut: true } }, false],
      ['e2e step wrote no Playwright report', { suite: 'e2e', e2e: E2E_DONE.e2e }, false],
      ['suite e2e, step passed', { suite: 'e2e', ...E2E_DONE }, true],
      ['suite all, step passed', { suite: 'all', ...E2E_DONE }, true],
    ];
    for (const [what, over, ok] of cases) {
      const { d, s } = project();
      sandboxEdit(d, s, 'e2e/goodboy-ui.ts', 'export const x = 1;\n');
      sandboxEdit(d, s, 'compose.yml');
      const run = later();
      putRecord(d, record(d, run, makeRun(d, run, over)));
      const out = await stop(d, s);
      if (ok) expect([what, testGateSilent(out)]).toEqual([what, true]);
      else {
        expect([what, out.decision]).toEqual([what, 'block']);
        expect(out.reason).toContain('e2e/goodboy-ui.ts');
        expect(out.reason).toMatch(/e2e step/);
        expect(out.reason).not.toContain('compose.yml (');
      }
    }
  }, 300_000);

  test('sandbox-run output alone asks for nothing', async () => {
    const { d, s } = project();
    const out = write(d, '.goodboy/sandbox/out/20261026T010101Z/result.json', '{}');
    recordEdit(s, out, 0, undefined, Date.now());
    const r = await stop(d, s);
    expect(testGateSilent(r)).toBe(true);
  }, 60_000);

  test('a link out of the sandbox dir into code is code: it needs unit tests', async () => {
    const { d, s } = project();
    write(d, '.goodboy/sandbox/.keep', '');
    const link = join(d, '.goodboy', 'sandbox', 'calc-link.ts');
    symlinkSync(join(d, 'src', 'calc.ts'), link);
    writeFileSync(join(d, 'src', 'calc.ts'), `${V1}export const b = 2;\n`);
    recordEdit(s, link, 0, undefined, Date.now());
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(NO_RESULT);
  }, 60_000);

  test('a non-sandbox file is unaffected: it still needs its own coverage; the sandbox file adds its own ask', async () => {
    const { d, s } = project();
    const calc = join(d, 'src', 'calc.ts');
    writeFileSync(calc, `${V1}export const b = 2;\n`);
    recordEdit(s, calc, 0, undefined, Date.now());
    sandboxEdit(d, s, 'compose.yml');
    // No record at all: both asks, each in its own words.
    const none = await stop(d, s);
    expect(none.decision).toBe('block');
    expect(none.reason).toContain('테스트 게이트');
    expect(none.reason).toMatch(NO_RESULT);
    expect(none.reason).toContain('src/calc.ts');
    expect(none.reason).toMatch(SANDBOX_ASKED);
    // A bound run after the edits and a record that lists the code file: both satisfied.
    const run = later();
    putRecord(d, record(d, run, makeRun(d, run)));
    const ok = await stop(d, s, { GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_TEST_TYPES: 'off', GOODBOY_EXISTING_TESTS: 'off' });
    expect(testGateSilent(ok)).toBe(true);
  }, 120_000);

  test('a bound run does not cover a code file the record does not list', async () => {
    const { d, s } = project();
    const calc = join(d, 'src', 'calc.ts');
    writeFileSync(calc, `${V1}export const b = 2;\n`);
    recordEdit(s, calc, 0, undefined, Date.now());
    sandboxEdit(d, s, 'compose.yml');
    const run = later();
    putRecord(d, record(d, run, makeRun(d, run), { tested_files: [join(d, 'src', 'other.ts')] }));
    const gap = await stop(d, s, { GOODBOY_DIFF_COVERAGE: 'off', GOODBOY_TEST_TYPES: 'off', GOODBOY_EXISTING_TESTS: 'off' });
    expect(gap.decision).toBe('block');
    expect(gap.reason).toContain('테스트 게이트');
    expect(gap.reason).toContain('src/calc.ts');
    expect(gap.reason ?? '').not.toMatch(SANDBOX_ASKED);
  }, 120_000);
});

describe('only the files the sandbox commands write are exempt', () => {
  test('the layout is what the renderer writes, for every stack', () => {
    const w = (file: string, line: number) => ({ file, line });
    const base = { frameworks: [], app: { port: 8080, contextPath: '/', healthPath: '/health', configFiles: [] }, secretKeys: [], questions: [], problems: [] };
    const scans: SandboxScan[] = (['jvm', 'node', 'python'] as const).map((stack) => ({
      ...base,
      root: '/nonexistent/repo',
      stack,
      build: { tool: 'x', runtimeVersion: '17', depsCommand: ['x'], buildCommand: ['x'], testCommand: ['x', 'test'], startCommand: ['x', 'start'], artifact: null },
      stores: [
        { kind: 'postgres', version: '15', database: 'shop', configKeys: ['DATABASE_URL'], where: w('.env', 1) },
        { kind: 'redis', version: '7', database: null, configKeys: ['REDIS_URL'], where: w('.env', 2) },
      ],
      outbound: [
        { host: 'api.partner.example', port: 443, scheme: 'https', kind: 'http', where: w('.env', 3), callSite: w('a', 1), hardcoded: false, ipLiteral: false },
        { host: 'smtp.corp.example', port: 587, scheme: null, kind: 'smtp', where: w('.env', 4), callSite: w('a', 2), hardcoded: false, ipLiteral: false },
        { host: 'ldap.corp.example', port: 389, scheme: 'ldap', kind: 'ldap', where: w('.env', 5), callSite: w('a', 3), hardcoded: false, ipLiteral: false },
      ],
    })) as SandboxScan[];
    const local: SandboxLocal = { dump: null, dumpFormat: null };
    const names = new Set<string>();
    for (const scan of scans) for (const f of planSandbox(scan, local, { readConfig: () => null }).files.keys()) names.add(f);
    expect(names.size).toBeGreaterThan(12);
    for (const f of [...names, 'scan.json', 'local.json', '.written.json', 'ca/ca.crt', 'ca/ca.key', 'ca/server.crt', 'ca/server.key', 'ca/server.p12', 'ca/server.sans']) {
      expect([f, isSandboxLayout(f)]).toEqual([f, true]);
    }
    for (const f of ['logic.ts', 'src/a.ts', 'runtime/extra.sh', 'e2e/other.ts', 'db/x/seed.sql', 'compose.yml.bak', '../compose.yml']) expect([f, isSandboxLayout(f)]).toEqual([f, false]);
  });

  test('any other file under the dir is ordinary code and needs unit tests', async () => {
    const { d, s } = project();
    sandboxEdit(d, s, 'logic.ts', 'export const hidden = 1;\n');
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('테스트 게이트');
    expect(out.reason).toMatch(NO_RESULT);
    expect(out.reason).not.toMatch(SANDBOX_ASKED);
  }, 60_000);

  test('sandboxRel needs the path below the dir as spelled and as resolved: a link from outside into it is code', () => {
    const { d } = project();
    const target = write(d, '.goodboy/sandbox/runtime/prep.sh', 'x\n');
    mkdirSync(join(d, 'src'), { recursive: true });
    symlinkSync(target, join(d, 'src', 'prep-link.sh'));
    symlinkSync(join(d, '.goodboy', 'sandbox', 'runtime'), join(d, 'src', 'rt'));
    expect(sandboxRel(target, d)).toBe('runtime/prep.sh');
    expect(sandboxRel(join(d, 'src', 'prep-link.sh'), d)).toBeNull();
    expect(sandboxRel(join(d, 'src', 'rt', 'prep.sh'), d)).toBeNull();
    expect(sandboxExemptRel(join(d, 'src', 'rt', 'prep.sh'), d)).toBeNull();
  });

  test('a changed src file that is a link into the sandbox dir needs unit tests', async () => {
    const { d, s } = project();
    const target = write(d, '.goodboy/sandbox/runtime/prep.sh', 'x\n');
    const link = join(d, 'src', 'prep-link.ts');
    symlinkSync(target, link);
    recordEdit(s, link, 0, undefined, Date.now());
    const out = await stop(d, s);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(NO_RESULT);
  }, 60_000);
});

describe('a layout file that a changed file uses loses the exemption', () => {
  test('sandboxUsers: relative imports and requires into the dir, a mention elsewhere, tests and the e2e fixture', () => {
    const { d } = project();
    const f = (rel: string, text: string) => write(d, rel, text);
    const imp = sandboxUsers(d, [f('src/a.ts', "import raw from '../.goodboy/sandbox/overrides/sandbox.env';\n"), f('src/b.js', "const x = require('../.goodboy/sandbox/runtime/flush.cjs');\n")]);
    expect(imp.all).toBe(false);
    expect(sandboxUsed(imp, 'runtime/flush.cjs')).toBe(true);
    expect(sandboxUsed(imp, 'overrides/sandbox.env')).toBe(true);
    expect(sandboxUsed(imp, 'compose.yml')).toBe(false);
    // The directory itself, a path in a string, a Python sys.path entry: all layout files.
    expect(sandboxUsers(d, [f('src/c.ts', "import x from '../.goodboy/sandbox';\n")]).all).toBe(true);
    expect(sandboxUsers(d, [f('src/d.py', "import sys\nsys.path.insert(0, '.goodboy/sandbox/runtime')\n")]).all).toBe(true);
    expect(sandboxUsers(d, [f('src/e.ts', "const p = join(root, '.goodboy/sandbox/overrides/x');\n")]).all).toBe(true);
    // A comment does not use anything; sandbox files and docs are no users.
    expect(sandboxUsers(d, [f('src/g.ts', "// see .goodboy/sandbox/compose.yml\nexport const g = 1;\n")]).all).toBe(false);
    expect(sandboxUsers(d, [write(d, '.goodboy/sandbox/runtime/prep.sh', 'x\n'), f('README.md', 'see .goodboy/sandbox/compose.yml\n')]).all).toBe(false);
    // An e2e test imports the fixture: allowed, and it is a test, so a mention does not count.
    const e2e = sandboxUsers(d, [f('e2e/a.spec.ts', "import { uiTest } from '../.goodboy/sandbox/e2e/goodboy-ui';\nconst c = '.goodboy/sandbox/compose.yml';\n")]);
    expect(e2e.files.size).toBe(0);
    expect(e2e.all).toBe(false);
    // Production code that imports the fixture is a user of it.
    expect(sandboxUsers(d, [f('src/h.ts', "import { uiTest } from '../.goodboy/sandbox/e2e/goodboy-ui';\n")]).files.has('e2e/goodboy-ui')).toBe(true);
  });

  test('Stop: src/calc.ts requires a sandbox script: that script needs unit tests, the other sandbox file still a run', async () => {
    const { d, s } = project();
    const calc = join(d, 'src', 'calc.ts');
    writeFileSync(calc, `${V1}export const flush = require('../.goodboy/sandbox/runtime/flush.cjs');\n`);
    recordEdit(s, calc, 0, undefined, Date.now());
    sandboxEdit(d, s, 'runtime/flush.cjs', 'module.exports = 1;\n');
    sandboxEdit(d, s, 'compose.yml');
    const run = later();
    putRecord(d, record(d, run, makeRun(d, run), { tested_files: [calc] }));
    const out = await stop(d, s, { GOODBOY_DIFF_COVERAGE: 'on', GOODBOY_TEST_TYPES: 'off', GOODBOY_EXISTING_TESTS: 'off' });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('테스트 게이트');
    // The used script is judged as code now: no coverage measured for it, it is named.
    expect(out.reason).toContain('flush.cjs');
    expect(out.reason ?? '').not.toMatch(SANDBOX_ASKED);
  }, 60_000);
});

describe('the stop_hook_active path accepts a sandbox-only session', () => {
  test('a verified run after the edits: the first Stop (active) moves the cursor, so a later full Stop without the record asks nothing', async () => {
    const { d, s } = project();
    sandboxEdit(d, s, 'compose.yml');
    const run = later();
    putRecord(d, record(d, run, makeRun(d, run)));
    const first = await stop(d, s, {}, true);
    expect(testGateSilent(first)).toBe(true);
    rmSync(join(d, '.claude', 'tests'), { recursive: true, force: true });
    const later2 = await stop(d, s);
    expect(testGateSilent(later2)).toBe(true);
  }, 60_000);

  test('without a verified run the active Stop accepts nothing: the full Stop still asks', async () => {
    const { d, s } = project();
    sandboxEdit(d, s, 'compose.yml');
    await stop(d, s, {}, true);
    const full = await stop(d, s);
    expect(full.reason).toMatch(SANDBOX_ASKED);
  }, 60_000);
});

describe('the users of the sandbox files are read only when a sandbox file changed', () => {
  test('sandboxTestEdits calls usersOf only for a sandbox layout edit, never for other edits', () => {
    const { d } = project();
    let calls = 0;
    const users = () => {
      calls++;
      return sandboxUsers(d, []);
    };
    const src = { file: write(d, 'src/x.ts', 'export const x = 1;\n') };
    const out = { file: write(d, '.goodboy/sandbox/out/20261026T010101Z/result.json', '{}') };
    const other = { file: write(d, '.goodboy/sandbox/logic.ts', 'export const l = 1;\n') };
    expect(sandboxTestEdits([src, out, other], d, users)).toEqual([]);
    expect(calls).toBe(0);
    const compose = { file: write(d, '.goodboy/sandbox/compose.yml', 'x: 1\n') };
    const prep = { file: write(d, '.goodboy/sandbox/runtime/prep.sh', 'x\n') };
    expect(sandboxTestEdits([src, compose, prep], d, users).map((e) => e.rel)).toEqual(['compose.yml', 'runtime/prep.sh']);
    expect(calls).toBeGreaterThan(0);
  });
});
