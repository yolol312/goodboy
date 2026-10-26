// #32 (v0.36.5): a record's relative paths resolve against the project dir, git-ignored build
// copies need no layer-1 test, and dev-cycle tests that run the product count as product evidence. Repos and session dirs are temporary; the Stop hook and
// the CLI are spawned as the other gate tests do. The new lib modules are imported inside the
// tests that need them, so a red run on an older tree fails those tests and not the whole file.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { changedLineGaps, pinCoverageStart, withSameContent } from '../lib/changed-coverage';
import { getCurrentTurn, recordEdit } from '../lib/file-tracker';
import { requiredDimensionsFor } from '../lib/review-dimensions';
import { validateReview } from '../lib/review-validator';
import { missingTestTypes } from '../lib/test-types';
import { devCycleTestIsProductEvidence, productEvidenceProblems } from '../lib/session-criteria';
import { missingTestFiles, scanForbiddenPatterns } from '../lib/test-validator';
import { afterBash, statusFiles } from '../lib/write-sweep';
import { noteBashStart } from '../lib/approval-marker';
import type { ChangedFileEdit } from '../lib/review-validator';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
/** Limits for the tests of what a copy qualifies by, not of the cost: a loaded machine must not make the budget decide. */
const PATIENT = { budgetMs: 60_000 };
// Each fixture spawns git about ten times; on a loaded machine that took over bun's 5 s default.
setDefaultTimeout(30_000);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const p = dirs.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const sh = (cwd: string, cmd: string) => {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return (p.stdout.toString() + p.stderr.toString()).trim();
};
function write(root: string, rel: string, text: string): string {
  const a = join(root, rel);
  mkdirSync(dirname(a), { recursive: true });
  writeFileSync(a, text);
  return a;
}
function sid(): string {
  const s = `i32${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
const sessionFile = (s: string, name: string) => join(tmpdir(), `goodboy-session-${s}`, name);

const V1 = 'export function f(x) {\n  return x + 1;\n}\n';
const V2 = 'export function f(x) {\n  return x + 2;\n}\n';
const TEST = 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { f } from "../src/app.js";\ntest("f", () => { assert.equal(f(1), 3); });\n';

interface Proj {
  d: string;
  s: string;
  head: string;
  src: string;
}

/** A committed repo (src/app.js, tests/app.test.js, target/ ignored), the session pinned at its
 *  HEAD, then src/app.js edited and the edit recorded. */
function project(extra: Record<string, string> = {}): Proj {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i32-')));
  dirs.push(d);
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  write(d, '.gitignore', 'target/\n');
  write(d, 'package.json', '{"name":"x","scripts":{"test":"node --test"}}\n');
  write(d, 'src/app.js', V1);
  write(d, 'tests/app.test.js', TEST);
  write(d, 'docs/ui/README.md', 'x\n');
  for (const [rel, text] of Object.entries(extra)) write(d, rel, text);
  sh(d, 'git add -A && git commit -q -m init');
  const head = sh(d, 'git rev-parse HEAD');
  const s = sid();
  pinCoverageStart(s, d);
  const src = write(d, 'src/app.js', V2);
  recordEdit(s, src, 0, undefined, Date.now());
  return { d, s, head, src };
}

let recordCounter = 0;
/** A passing layer-1 record, made after every edit so far (a minute ahead, as the other tests do). */
function putTestRecord(p: Proj, tested: string[], opts: { testFiles?: string[]; extra?: Record<string, unknown> } = {}): string {
  const dir = join(p.d, '.claude', 'tests');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `r${recordCounter++}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000 + recordCounter).toISOString(),
      tested_files: tested,
      category: 'fix-bug',
      test_files: opts.testFiles ?? [join(p.d, 'tests', 'app.test.js')],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'unit', command: 'node --test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [
        {
          id: 'AC-1',
          description: 'f adds two',
          test: 'tests/app.test.js',
          red: { command: 'node --test (reverted)', output: '1 fail', exit_code: 1 },
          green: { command: 'node --test', output: '1 pass', exit_code: 0 },
        },
      ],
      verdict: 'pass',
      ...(opts.extra ?? {}),
    }),
  );
  return path;
}

function putReview(p: Proj, reviewed: string[]): void {
  const dir = join(p.d, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `v${recordCounter++}.json`),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: reviewed,
      category: 'fix-bug',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: requiredDimensionsFor([p.src]),
    }),
  );
}

interface Out {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}
async function stop(p: Proj, opts: { shellCwd?: string; active?: boolean; env?: Record<string, string> } = {}): Promise<Out> {
  const shell = opts.shellCwd ?? p.d;
  const proc = Bun.spawn(['bun', STOP], {
    cwd: shell,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: shell, session_id: p.s, hook_event_name: 'Stop', stop_hook_active: opts.active === true })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: p.d,
      GOODBOY_TEST_GATE: 'on',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DOCS_GATE: 'off',
      ...(opts.env ?? {}),
    },
  });
  const text = (await new Response(proc.stdout).text()) || '{}';
  await proc.exited;
  return JSON.parse(text) as Out;
}
const testBlock = (o: Out) => o.decision === 'block' && (o.reason ?? '').includes('(테스트 게이트)');
const reviewBlock = (o: Out) => o.decision === 'block' && /Review is required|Review validation failed/.test(o.reason ?? '');
const gateLog = (s: string): string[] => {
  try {
    return readFileSync(sessionFile(s, 'gate-log.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
  } catch {
    return [];
  }
};

// ── 1. A record's relative paths resolve against the project dir ──────────────────────────

describe('relative record paths with the shell in a subdirectory', () => {
  test('a test record with relative tested_files and test_files still covers the edit from docs/ui', async () => {
    // One project per Stop: a passing Stop moves the test cursor.
    const p = project();
    putTestRecord(p, ['src/app.js'], { testFiles: ['tests/app.test.js'] });
    const sub = await stop(p, { shellCwd: join(p.d, 'docs', 'ui') });
    expect(testBlock(sub)).toBe(false);
    expect(sub.reason ?? '').not.toContain('테스트되지 않은');
    const q = project();
    putTestRecord(q, ['src/app.js'], { testFiles: ['tests/app.test.js'] });
    expect(testBlock(await stop(q))).toBe(false); // from the project root, as before
  }, 60_000);

  test('a relative record that does not name the edited file is still rejected from the subdirectory', async () => {
    const p = project();
    putTestRecord(p, ['src/other.js']);
    const sub = await stop(p, { shellCwd: join(p.d, 'docs', 'ui') });
    expect(testBlock(sub)).toBe(true);
    expect(sub.reason).toContain('테스트되지 않은');
  }, 60_000);

  test('a review record with relative reviewed_files covers the edit from docs/ui', async () => {
    const p = project();
    putTestRecord(p, [p.src]);
    putReview(p, ['src/app.js']);
    const sub = await stop(p, { shellCwd: join(p.d, 'docs', 'ui') });
    expect(sub.decision).toBeUndefined();
  }, 60_000);

  test('a review record that names another file is still a block from the subdirectory', async () => {
    const p = project();
    putTestRecord(p, [p.src]);
    putReview(p, ['src/other.js']);
    expect(reviewBlock(await stop(p, { shellCwd: join(p.d, 'docs', 'ui') }))).toBe(true);
  }, 60_000);

  test('test-write and review-write store absolute paths, resolved against the project dir', () => {
    const p = project();
    const input = {
      timestamp: new Date().toISOString(),
      tested_files: ['src/app.js'],
      category: 'fix-bug',
      test_files: ['tests/app.test.js'],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'unit', command: 'node --test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [
        {
          id: 'AC-1',
          description: 'd',
          test: 'tests/app.test.js',
          red: { command: 'c', output: 'o', exit_code: 1 },
          green: { command: 'c', output: 'o', exit_code: 0 },
        },
      ],
      verdict: 'pass',
    };
    const w = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: join(p.d, 'docs', 'ui'), env: { ...process.env, CLAUDE_PROJECT_DIR: p.d }, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
    expect([w.exitCode, w.stderr.toString()]).toEqual([0, '']);
    const saved = JSON.parse(readFileSync(JSON.parse(w.stdout.toString()).path, 'utf8'));
    expect(saved.tested_files).toEqual([join(p.d, 'src', 'app.js')]);
    expect(saved.test_files).toEqual([join(p.d, 'tests', 'app.test.js')]);
    const review = {
      timestamp: new Date().toISOString(),
      reviewed_files: ['src/app.js'],
      category: 'fix-bug',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: ['plan-completeness'],
    };
    const r = Bun.spawnSync(['bun', CLI, 'review-write'], { cwd: join(p.d, 'docs', 'ui'), env: { ...process.env, CLAUDE_PROJECT_DIR: p.d }, stdin: new TextEncoder().encode(JSON.stringify(review)), stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(JSON.parse(r.stdout.toString()).path, 'utf8')).reviewed_files).toEqual([join(p.d, 'src', 'app.js')]);
  });

  test('recordPath: relative against the base, absolute as is', async () => {
    const { recordPath } = await import('../lib/record-paths');
    expect(recordPath('a/b.ts', '/x/y')).toBe('/x/y/a/b.ts');
    expect(recordPath('/abs/b.ts', '/x/y')).toBe('/abs/b.ts');
  });
});

// ── 2. Product evidence under docs/versions ─────────────────────────────────────────────────

describe('a test under docs/versions as product evidence', () => {
  const PAGE = 'docs/versions/v1/e2e/page.test.js';
  function repo(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i32-pe-')));
    dirs.push(d);
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    write(d, '.gitignore', 'target/\nbuild/\n');
    write(d, 'src/app.js', V1);
    write(d, 'src/other.js', V1);
    write(d, 'tests/app.test.js', TEST);
    write(d, 'README.md', '# x\n');
    write(d, 'docs/versions/v1/notes.md', 'notes\n');
    write(d, PAGE, 'import "../../../../../src/app.js";\n');
    write(d, 'docs/versions/v1/tests/spec.md', '# spec\n');
    write(d, 'testkit/testkit.config.json', '{}\n');
    write(d, 'testkit/run.js', 'x\n');
    write(d, 'target/app.js', V1);
    write(d, '__probe_app.js', V1);
    sh(d, 'git add -A && git commit -q -m init');
    return d;
  }
  const entry = (id: string, test: string, mutation?: Record<string, unknown>) => ({
    id,
    description: 'd',
    test,
    red: { command: 'bun e2e (reverted)', output: 'fail', exit_code: 1 },
    green: { command: 'bun e2e', output: 'ok', exit_code: 0 },
    ...(mutation ? { mutation } : {}),
  });
  const mut = (file: string | undefined, extra: Record<string, unknown> = {}) => ({ command: 'sed -i s/x/y/ src/app.js', output: 'fails', detected: true, ...(file ? { file } : {}), ...extra });
  const problems = (d: string, ...entries: unknown[]) => productEvidenceProblems([{ acceptance: entries } as unknown as TestResult], d);

  test('valid: this entry has red, green and a detected mutation of an existing product file (UIUX and REQ)', () => {
    const d = repo();
    expect(problems(d, entry('UIUX-1', PAGE, mut('src/app.js')))).toEqual([]);
    expect(problems(d, entry('REQ-3', PAGE, mut('src/app.js')))).toEqual([]);
    expect(problems(d, entry('PT-2', PAGE, mut(join(d, 'src/app.js'))))).toEqual([]);
  });

  test('without a mutation, or an undetected one, the dev-cycle test counts as a document and the message names both ways out', () => {
    const d = repo();
    for (const e of [entry('REQ-3', PAGE), entry('UIUX-1', PAGE), entry('REQ-3', PAGE, mut('src/app.js', { detected: false })), entry('REQ-3', PAGE, mut('src/app.js', { command: '  ' }))]) {
      const out = problems(d, e);
      expect(out.some((l) => l.includes('dev-cycle folder'))).toBe(true);
      expect(out.join(' ')).toContain('Move the test out of docs/versions');
      expect(out.join(' ')).toContain('detected mutation of the product file');
    }
  });

  test("another entry's mutation does not count", () => {
    const d = repo();
    const out = problems(d, entry('REQ-3', PAGE), entry('REQ-4', 'tests/app.test.js', mut('src/app.js')));
    expect(out.filter((l) => l.startsWith('REQ-3') && l.includes('dev-cycle folder')).length).toBe(1);
    expect(out.filter((l) => l.startsWith('REQ-4')).length).toBe(0);
  });

  test('a mutation of a document, a test, a harness, a scratch or ignored copy, a missing or outside file does not count', () => {
    const d = repo();
    const outside = join(tmpdir(), 'not-the-repo.js');
    for (const file of ['README.md', 'docs/versions/v1/notes.md', 'tests/app.test.js', PAGE, 'testkit/run.js', 'target/app.js', '__probe_app.js', 'src/missing.js', outside, 'src']) {
      const out = problems(d, entry('REQ-3', PAGE, mut(file)));
      expect([file, out.some((l) => l.includes('dev-cycle folder'))]).toEqual([file, true]);
    }
  });

  test('Markdown (also under a tests/ dir) is a document: its own message, whatever the mutation', () => {
    const d = repo();
    for (const test of ['docs/versions/v1/tests/spec.md', 'docs/versions/v1/notes.md']) {
      const out = problems(d, entry('REQ-3', test, mut('src/app.js')));
      expect(out.some((l) => l.includes('its test is a document'))).toBe(true);
    }
  });

  test('a test that is no test file by its name stays a document: only a test file under the version dir counts', () => {
    const d = repo();
    write(d, 'docs/versions/v1/helper.js', 'x\n');
    sh(d, 'git add -A && git commit -q -m h');
    expect(problems(d, entry('REQ-3', 'docs/versions/v1/helper.js', mut('src/app.js'))).some((l) => l.includes('dev-cycle folder'))).toBe(true);
  });

  test('a hard link, or a link to a file outside the repo, is no evidence', () => {
    const d = repo();
    linkSync(join(d, PAGE), join(d, 'docs/versions/v1/e2e/twin.test.js'));
    expect(problems(d, entry('REQ-3', 'docs/versions/v1/e2e/twin.test.js', mut('src/app.js'))).some((l) => l.includes('dev-cycle folder'))).toBe(true);
    expect(problems(d, entry('REQ-3', PAGE, mut('src/app.js'))).some((l) => l.includes('dev-cycle folder'))).toBe(true); // the first name has two links now
    const outsideFile = join(tmpdir(), `i32-out-${Math.random().toString(36).slice(2)}.test.js`);
    writeFileSync(outsideFile, 'x\n');
    dirs.push(outsideFile);
    symlinkSync(outsideFile, join(d, 'docs/versions/v1/e2e/out.test.js'));
    expect(problems(d, entry('REQ-3', 'docs/versions/v1/e2e/out.test.js', mut('src/app.js'))).some((l) => l.includes('not in this repo'))).toBe(true);
  });

  test('a mutation file that is a link to a scratch copy or has two links is no product file', () => {
    const d = repo();
    linkSync(join(d, 'src/other.js'), join(d, 'src/other-twin.js'));
    expect(problems(d, entry('REQ-3', PAGE, mut('src/other.js'))).some((l) => l.includes('dev-cycle folder'))).toBe(true);
  });

  test('the Stop reports it once, naming both ways out; a valid entry passes the product-evidence rule', async () => {
    const d = repo();
    const s = sid();
    pinCoverageStart(s, d);
    const abs = write(d, 'src/app.js', V2);
    recordEdit(s, abs, 0, undefined, Date.now());
    const p: Proj = { d, s, head: '', src: abs };
    putTestRecord(p, [abs], { extra: { acceptance: [entry('UIUX-1', PAGE)] } });
    const bad = await stop(p);
    expect(testBlock(bad)).toBe(true);
    expect(bad.reason).toContain('Move the test out of docs/versions');
    putTestRecord(p, [abs], { extra: { acceptance: [entry('UIUX-1', PAGE, mut('src/app.js'))] } });
    expect((await stop(p)).reason ?? '').not.toContain('dev-cycle folder');
  }, 60_000);
});

// ── 3. Build-output copies ───────────────────────────────────────────────────────────────────

describe('git-ignored build copies of a tested source file', () => {
  async function copies(p: Proj, edits: string[]): Promise<Map<string, string>> {
    const { buildCopies } = await import('../lib/build-copies');
    return buildCopies(edits, p.d, p.head, undefined, PATIENT);
  }
  const copyOf = (p: Proj, dest = 'target/app.js') => write(p.d, dest, V2);

  test('a qualifying copy is dropped and paired with its source', async () => {
    const p = project();
    const c = copyOf(p);
    expect([...(await copies(p, [p.src, c]))]).toEqual([[c, p.src]]);
    write(p.d, '.gitignore', 'target/\nbuild/\n');
    const b = copyOf(p, 'build/app.js');
    expect((await copies(p, [p.src, b])).get(b)).toBe(undefined); // .gitignore changed since the start
    const p2 = project({ '.gitignore': 'target/\nbuild/\n' });
    const b2 = copyOf(p2, 'build/app.js');
    expect((await copies(p2, [p2.src, b2])).get(b2)).toBe(p2.src);
  });

  test('a copy that diverged from the source, or an empty edit set around it, is kept', async () => {
    const p = project();
    const c = write(p.d, 'target/app.js', V2 + '// more\n');
    expect((await copies(p, [p.src, c])).size).toBe(0);
    const same = copyOf(p);
    expect((await copies(p, [same])).size).toBe(0); // the source is not in the change set
  });

  test('a source that is untracked, or not changed in this session, does not make a copy', async () => {
    const p = project();
    const fresh = write(p.d, 'src/new.js', 'export const n = 1;\n');
    const c = write(p.d, 'target/new.js', 'export const n = 1;\n');
    expect((await copies(p, [fresh, c])).size).toBe(0); // untracked source
    const c2 = copyOf(p);
    expect((await copies(p, [c2, c])).size).toBe(0);
  });

  test('an edited or removed .gitignore keeps the copy; back to the start content it qualifies again', async () => {
    const p = project();
    const c = copyOf(p);
    expect((await copies(p, [p.src, c])).size).toBe(1);
    write(p.d, '.gitignore', 'target/\nextra/\n');
    expect((await copies(p, [p.src, c])).size).toBe(0);
    write(p.d, '.gitignore', 'target/\n');
    expect((await copies(p, [p.src, c])).size).toBe(1); // back to the start's content
    write(p.d, 'sub/.gitignore', 'x\n');
    expect((await copies(p, [p.src, c])).size).toBe(1); // a new .gitignore that decides nothing here
    rmSync(join(p.d, 'sub'), { recursive: true });
    rmSync(join(p.d, '.gitignore'));
    expect((await copies(p, [p.src, c])).size).toBe(0); // no rule ignores it now
  });

  test('an ignore from .git/info/exclude is no .gitignore ignore', async () => {
    const p = project();
    write(p.d, '.git/info/exclude', 'build/\n');
    const c = write(p.d, 'build/app.js', V2);
    expect(sh(p.d, 'git check-ignore -q build/app.js; echo $?')).toBe('0'); // ignored, but not by a .gitignore
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('a copy whose bytes differ from its tracked source stays in the layer-1 set', async () => {
    const p = project();
    const c = write(p.d, 'target/app.js', V2.replace('x + 2', 'x + 3'));
    expect((await copies(p, [p.src, c])).size).toBe(0);
    // Same size, other bytes: the size shortcut does not pair them either.
    const same = write(p.d, 'target/app.js', V2.replace('x + 2', 'x + 9'));
    expect(same).toBe(c);
    expect((await copies(p, [p.src, c])).size).toBe(0);
    write(p.d, 'target/app.js', V2);
    expect((await copies(p, [p.src, c])).get(c)).toBe(p.src); // the same bytes pair
  });

  test('a copy ignored only by a global core.excludesFile named .gitignore stays', async () => {
    const p = project({ '.gitignore': 'node_modules/\n' }); // the repo .gitignore does not ignore target/
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i32-home-')));
    dirs.push(home);
    const global = write(home, '.gitignore', 'target/\n');
    sh(p.d, `git config core.excludesFile '${global}'`);
    const c = copyOf(p);
    expect(sh(p.d, 'git check-ignore -v target/app.js')).toContain(`${global}:1:target/`); // ignored, by the global file
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('a copy ignored by a .gitignore that is untracked, new since HEAD, or edited since HEAD stays', async () => {
    // Untracked: the ignore file exists on disk but was never committed.
    const p = project({ '.gitignore': 'node_modules/\n' });
    write(p.d, 'src/.gitignore', 'x\n'); // an unrelated untracked one decides nothing
    write(p.d, 'target/.gitignore', '*\n'); // untracked, and the one that decides the copy
    const c = copyOf(p);
    expect(sh(p.d, 'git check-ignore -v target/app.js')).toContain('target/.gitignore:1:*');
    expect((await copies(p, [p.src, c])).size).toBe(0);
    // New since HEAD (staged, not in the start commit).
    sh(p.d, 'git add target/.gitignore');
    expect((await copies(p, [p.src, c])).size).toBe(0);
    // Tracked at HEAD, edited since.
    const q = project({ 'target/.gitignore': '*.log\n', '.gitignore': 'target/*\n!target/.gitignore\n' });
    const c2 = copyOf(q);
    expect(sh(q.d, 'git check-ignore -v target/app.js')).toContain('.gitignore:1:target/*');
    expect((await copies(q, [q.src, c2])).size).toBe(1); // unchanged and tracked: qualifies
    write(q.d, '.gitignore', 'target/*\n!target/.gitignore\n# edited\n');
    expect((await copies(q, [q.src, c2])).size).toBe(0);
  });

  test('a copy ignored by a tracked, unchanged repo .gitignore is dropped (root and nested)', async () => {
    const p = project({ 'build/.gitignore': '*\n!.gitignore\n' });
    const root = copyOf(p);
    const nested = copyOf(p, 'build/app.js');
    expect(sh(p.d, 'git check-ignore -v build/app.js')).toContain('build/.gitignore:1:*');
    const got = await copies(p, [p.src, root, nested]);
    expect(new Map([...got].sort())).toEqual(new Map([[nested, p.src], [root, p.src]]));
  });

  test('a tracked, unchanged ignore file that is not named .gitignore stays (core.excludesFile, inside or outside the repo)', async () => {
    const p = project({ 'ignore-rules': 'target/\n', '.gitignore': 'node_modules/\n' });
    sh(p.d, 'git config core.excludesFile ignore-rules');
    const c = copyOf(p);
    expect(sh(p.d, 'git check-ignore -v target/app.js')).toContain('ignore-rules:1:target/');
    expect((await copies(p, [p.src, c])).size).toBe(0);
    const outer = write(dirname(p.d), `outer-${p.s}/.gitignore`, 'target/\n'); // named .gitignore, above the repo top
    dirs.push(dirname(outer));
    sh(p.d, `git config core.excludesFile '../outer-${p.s}/.gitignore'`);
    expect(sh(p.d, 'git check-ignore -v target/app.js')).toContain(`outer-${p.s}/.gitignore:1:target/`);
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('a .gitignore with two links stays, even when tracked and unchanged', async () => {
    const p = project();
    const c = copyOf(p);
    expect((await copies(p, [p.src, c])).size).toBe(1);
    linkSync(join(p.d, '.gitignore'), join(p.d, 'src', 'second-link'));
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('a .gitignore that was a symlink at HEAD stays although a regular file now holds the same bytes', async () => {
    const p = project();
    sh(p.d, "git rm -q --cached .gitignore && rm .gitignore && ln -s 'target/' .gitignore && git add .gitignore && git commit -q -m symlink");
    const head = sh(p.d, 'git rev-parse HEAD');
    rmSync(join(p.d, '.gitignore'));
    writeFileSync(join(p.d, '.gitignore'), 'target/'); // the link's text, no newline: the same blob id
    expect(sh(p.d, 'git hash-object .gitignore')).toBe(sh(p.d, 'git rev-parse HEAD:.gitignore'));
    const c = copyOf(p);
    expect(sh(p.d, 'git check-ignore -v target/app.js')).toContain('.gitignore:1:target/');
    const { buildCopies } = await import('../lib/build-copies');
    expect(buildCopies([p.src, c], p.d, head).size).toBe(0);
  });

  test('a tracked source whose name looks like pathspec magic is still found (literal pathspecs)', async () => {
    const p = project({ ':(top)app.js': V1 });
    const magic = write(p.d, ':(top)app.js', V2);
    const c = write(p.d, 'target/magic.js', V2);
    expect(sh(p.d, "git ls-files -- ':(top)app.js'")).toBe(''); // as a pathspec it names no file
    const { buildCopies } = await import('../lib/build-copies');
    expect(buildCopies([magic, c], p.d, p.head, undefined, PATIENT).get(c)).toBe(magic);
  });

  test('a name that starts with a colon is never a copy', async () => {
    const p = project({ '.gitignore': 'target/\nbuild/\n' });
    const c = write(p.d, ':odd/build/app.js', V2);
    expect(sh(p.d, "git check-ignore -v -- ':odd/build/app.js'")).toContain('.gitignore:2:build/');
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('a negated pattern stays', async () => {
    const p = project({ '.gitignore': 'target/*\n!target/app.js\n' });
    const c = copyOf(p);
    expect(sh(p.d, 'git check-ignore -v target/app.js')).toContain('!target/app.js'); // the deciding rule un-ignores it
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('a cheap per-copy check runs first: a tracked file under build/ costs no change-set listing', async () => {
    const p = project();
    const c = copyOf(p);
    sh(p.d, 'git add -f target/app.js');
    let listed = 0;
    const { buildCopies } = await import('../lib/build-copies');
    expect(buildCopies([p.src, c], p.d, p.head, () => (listed++, [p.src])).size).toBe(0);
    expect(listed).toBe(0);
  });

  test('a tracked copy is kept (it is in the record tree like any file)', async () => {
    const p = project();
    const c = copyOf(p);
    sh(p.d, 'git add -f target/app.js');
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('.env, .env.* and *.env names are never copies or sources', async () => {
    const p = project({ 'src/conf.env': 'A=1\n', 'src/.env': 'A=1\n', 'src/.env.local': 'A=1\n' });
    for (const [srcRel, copyRel] of [['src/conf.env', 'target/conf.env'], ['src/.env', 'target/.env'], ['src/.env.local', 'target/.env.local']] as const) {
      write(p.d, srcRel, 'A=2\n');
      const src = join(p.d, srcRel);
      const c = write(p.d, copyRel, 'A=2\n');
      expect([copyRel, (await copies(p, [src, c])).size]).toEqual([copyRel, 0]);
    }
  });

  test('links: a symlinked copy, a symlinked build dir, a hard link and a linked source are kept', async () => {
    const p = project();
    mkdirSync(join(p.d, 'target'), { recursive: true });
    symlinkSync(p.src, join(p.d, 'target', 'app.js'));
    expect((await copies(p, [p.src, join(p.d, 'target', 'app.js')])).size).toBe(0);
    rmSync(join(p.d, 'target'), { recursive: true });
    mkdirSync(join(p.d, 'out'));
    write(p.d, 'out/app.js', V2);
    symlinkSync(join(p.d, 'out'), join(p.d, 'target'));
    expect((await copies(p, [p.src, join(p.d, 'target', 'app.js')])).size).toBe(0);
    rmSync(join(p.d, 'target'));
    mkdirSync(join(p.d, 'target'));
    linkSync(p.src, join(p.d, 'target', 'app.js')); // two links: the source and the copy
    expect((await copies(p, [p.src, join(p.d, 'target', 'app.js')])).size).toBe(0);
  });

  test('an unreadable copy keeps the obligation', async () => {
    const p = project();
    const c = copyOf(p);
    chmodSync(c, 0o000);
    try {
      expect((await copies(p, [p.src, c])).size).toBe(0);
    } finally {
      chmodSync(c, 0o644);
    }
  });

  test('a copy outside target/ and build/ is not a build copy', async () => {
    const p = project();
    write(p.d, '.gitignore', 'target/\ncache/\n');
    const c = write(p.d, 'cache/app.js', V2);
    expect((await copies(p, [p.src, c])).size).toBe(0);
  });

  test('through the Stop: the copy needs no record of its own, the source still does, and the pair is logged', async () => {
    const p = project();
    const c = copyOf(p);
    recordEdit(p.s, c, 0, undefined, Date.now());
    putTestRecord(p, [p.src]);
    const out = await stop(p);
    expect(testBlock(out)).toBe(false);
    expect(gateLog(p.s).some((l) => l.includes('build-copy: target/app.js -> src/app.js'))).toBe(true);
  }, 60_000);

  test('a source edited in an earlier turn is in the change set: copying it again later is no new obligation', async () => {
    const p = project();
    const c = copyOf(p);
    const { buildCopies } = await import('../lib/build-copies');
    expect(buildCopies([c], p.d, p.head).size).toBe(0); // alone, the copy has no source in its set
    expect(buildCopies([c], p.d, p.head, () => [p.src], PATIENT).get(c)).toBe(p.src);
  });

  test('through the Stop: a red/green run that copies the source again in a later turn needs no new record', async () => {
    const p = project();
    putTestRecord(p, [p.src]);
    expect(testBlock(await stop(p))).toBe(false); // the test gate accepts: its cursor moves
    const c = copyOf(p);
    recordEdit(p.s, c, getCurrentTurn(p.s), undefined, Date.now());
    const out = await stop(p);
    expect(testBlock(out)).toBe(false);
    expect(gateLog(p.s).some((l) => l.includes('build-copy: target/app.js -> src/app.js'))).toBe(true);
    // The same edit of a copy that differs from the source is an obligation.
    write(p.d, 'target/app.js', V2 + '// diverged\n');
    recordEdit(p.s, c, getCurrentTurn(p.s), undefined, Date.now());
    expect(testBlock(await stop(p))).toBe(true);
  }, 90_000);

  test('through the Stop: the source without a record still blocks, and the copy is not named', async () => {
    const p = project();
    const c = copyOf(p);
    recordEdit(p.s, c, 0, undefined, Date.now());
    putTestRecord(p, [join(p.d, 'src', 'elsewhere.js')]);
    const out = await stop(p);
    expect(testBlock(out)).toBe(true);
    expect(out.reason).toContain('src/app.js');
    expect(out.reason).not.toContain('target/app.js');
  }, 60_000);

  test('through the Stop: a source edited after the copy brings the copy back (decided each Stop)', async () => {
    const p = project();
    const c = copyOf(p);
    recordEdit(p.s, c, 0, undefined, Date.now());
    putTestRecord(p, [join(p.d, 'src', 'elsewhere.js')]); // names neither: every Stop blocks
    const first = await stop(p);
    expect(testBlock(first)).toBe(true);
    expect(first.reason).toContain('src/app.js');
    expect(first.reason).not.toContain('target/app.js');
    write(p.d, 'src/app.js', V2 + '// later\n'); // the copy no longer equals the source
    recordEdit(p.s, p.src, 0, undefined, Date.now());
    const second = await stop(p);
    expect(second.reason).toContain('target/app.js');
  }, 90_000);

  test('through the Stop: the review gate still asks about the copy', async () => {
    const p = project();
    const c = copyOf(p);
    recordEdit(p.s, c, 0, undefined, Date.now());
    putTestRecord(p, [p.src]);
    const out = await stop(p);
    expect(reviewBlock(out)).toBe(true);
    expect(out.reason).toContain('target/app.js');
  }, 60_000);

  test('through the Stop with changed-line coverage on: the copy is no changed line no test ran', async () => {
    const p = project();
    const c = copyOf(p);
    recordEdit(p.s, c, 0, undefined, Date.now());
    const coverage = { status: 'measured', changed: { covered: 1, total: 1, files_without_executed_changes: [], files: { 'src/app.js': { covered: 1, total: 1 } }, in_report: ['src/app.js'], diff_lines: { 'src/app.js': 1 }, base: p.head } };
    putTestRecord(p, [p.src], { extra: { coverage } });
    const out = await stop(p, { env: { GOODBOY_DIFF_COVERAGE: 'on' } });
    expect(testBlock(out)).toBe(false);
  }, 60_000);

  test('the real write sweep records the cp; the Stop passes with a record that names only the source', async () => {
    const p = project();
    const bash = (cmd: string, tuid: string) => {
      noteBashStart(p.s, tuid, p.d, cmd, undefined, statusFiles(p.d) ?? undefined);
      Bun.sleepSync(1100);
      sh(p.d, cmd);
      return afterBash(p.s, tuid, p.d, cmd, undefined);
    };
    bash('mkdir -p target && cp src/app.js target/app.js', 't1');
    expect(readFileSync(sessionFile(p.s, 'edits.jsonl'), 'utf8')).toContain('target/app.js');
    putTestRecord(p, [p.src]);
    expect(testBlock(await stop(p))).toBe(false);
  }, 60_000);
});

// ── 4. Build copies: batching, the cap and the budget, failures ───────────────────────────────

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const real = (d: string) => realpathSync(d);

/** A `git` first on PATH that logs every call and can fail or stall chosen ones (a spawn costs
 *  about 60 ms and a hung git must not outlast the budget). Restores the environment after. */
function withGitShim<T>(opts: { failIgnore?: boolean; failLs?: number; sleep?: number }, fn: (calls: () => string[]) => T): T {
  const dir = real(mkdtempSync(join(tmpdir(), 'goodboy-i32-shim-')));
  dirs.push(dir);
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  writeFileSync(
    join(dir, 'git'),
    [
      '#!/bin/sh',
      'echo "$*" >> "$GB_SHIM_LOG"',
      'case "$*" in',
      '  *check-ignore*) [ -n "$GB_SHIM_FAIL_IGNORE" ] && exit 128 ;;',
      '  *ls-files*) [ "$(grep -c ls-files "$GB_SHIM_LOG")" = "$GB_SHIM_FAIL_LS" ] && exit 128 ;;',
      'esac',
      '[ -n "$GB_SHIM_SLEEP" ] && exec sleep "$GB_SHIM_SLEEP"',
      'exec "$GB_SHIM_REAL" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);
  const names = ['PATH', 'GB_SHIM_LOG', 'GB_SHIM_REAL', 'GB_SHIM_FAIL_IGNORE', 'GB_SHIM_FAIL_LS', 'GB_SHIM_SLEEP'];
  const saved = names.map((n) => process.env[n]);
  const realGit = Bun.which('git')!;
  process.env.GB_SHIM_REAL = realGit;
  process.env.GB_SHIM_LOG = log;
  if (opts.failIgnore) process.env.GB_SHIM_FAIL_IGNORE = '1';
  if (opts.failLs !== undefined) process.env.GB_SHIM_FAIL_LS = String(opts.failLs);
  if (opts.sleep !== undefined) process.env.GB_SHIM_SLEEP = String(opts.sleep);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  try {
    return fn(() => readFileSync(log, 'utf8').split('\n').filter((l) => l !== ''));
  } finally {
    names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
  }
}

describe('build copies: batching, the cap and the budget', () => {
  const many = (p: Proj, n: number) => Array.from({ length: n }, (_, i) => write(p.d, `target/c${String(i).padStart(3, '0')}.js`, V2));

  test('300 ignored copies: the call stays within the budget, and the copies over the cap stay in the set', async () => {
    const { buildCopies, BUILD_COPY_BUDGET_MS, MAX_BUILD_COPY_CANDIDATES } = await import('../lib/build-copies');
    const p = project();
    const cs = many(p, MAX_BUILD_COPY_CANDIDATES + 100);
    const skipped: [number, string][] = [];
    const t0 = performance.now();
    const got = buildCopies([p.src, ...cs], p.d, p.head, undefined, { onSkipped: (n, why) => skipped.push([n, why]) });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(BUILD_COPY_BUDGET_MS);
    expect([...got.keys()]).toEqual(cs.slice(0, MAX_BUILD_COPY_CANDIDATES)); // the first ones are paired
    expect([...got.values()].every((s) => s === p.src)).toBe(true);
    expect(skipped).toEqual([[100, 'cap']]); // the rest are named by count and stay in the layer-1 set
  }, 60_000);

  test('the git calls do not grow with the candidates: one ls-files and one check-ignore for all, one ls-files for the sources', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    for (const n of [3, 60]) {
      const p = project();
      const cs = many(p, n);
      const got = withGitShim({}, (calls) => {
        const r = buildCopies([p.src, ...cs], p.d, p.head, undefined, PATIENT);
        const log = calls();
        expect(log.length).toBeGreaterThan(0); // the shim was the git that ran
        expect(log.filter((l) => l.includes('check-ignore')).length).toBe(1);
        expect(log.filter((l) => l.includes('ls-files')).length).toBe(2);
        return r;
      });
      expect(got.size).toBe(n);
    }
  }, 60_000);

  test('check-ignore runs with core.excludesFile emptied', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const c = copyOf(p);
    const log = withGitShim({}, (calls) => (buildCopies([p.src, c], p.d, p.head), calls()));
    expect(log.find((l) => l.includes('check-ignore'))).toContain('-c core.excludesFile=/dev/null');
  }, 30_000);

  function copyOf(p: Proj, dest = 'target/app.js') {
    return write(p.d, dest, V2);
  }

  test('a relative core.excludesFile naming a tracked, unchanged .gitignore no longer decides', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project({ '.gitignore': 'node_modules/\n', 'cfg/.gitignore': 'target/\n' });
    sh(p.d, 'git config core.excludesFile cfg/.gitignore');
    const c = copyOf(p);
    expect(sh(p.d, 'git check-ignore -v target/app.js')).toContain('cfg/.gitignore:1:target/'); // git itself says so
    expect(buildCopies([p.src, c], p.d, p.head).size).toBe(0);
    // The repo's own .gitignore still decides.
    const q = project();
    sh(q.d, 'git config core.excludesFile cfg/.gitignore');
    const c2 = copyOf(q);
    expect(buildCopies([q.src, c2], q.d, q.head, undefined, PATIENT).get(c2)).toBe(q.src);
  }, 30_000);

  test('no time at all: nothing is decided, every candidate stays, and git is not run', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const cs = many(p, 4);
    const skipped: [number, string][] = [];
    const log = withGitShim({}, (calls) => {
      expect(buildCopies([p.src, ...cs], p.d, p.head, undefined, { budgetMs: 0, onSkipped: (n, why) => skipped.push([n, why]) }).size).toBe(0);
      return calls();
    });
    expect(log).toEqual([]);
    expect(skipped).toEqual([[4, 'budget']]);
  }, 30_000);

  test('a clock that runs out at any point leaves only verdicts that the full run also gives, and says so', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project({ 'build/.gitignore': '*\n!.gitignore\n' });
    const cs = [...many(p, 3), write(p.d, 'build/x.js', V2)];
    const full = buildCopies([p.src, ...cs], p.d, p.head, undefined, PATIENT);
    expect(full.size).toBe(4);
    const reasons = new Set<string>();
    let calls = 0;
    const clock = () => calls++;
    buildCopies([p.src, ...cs], p.d, p.head, undefined, { now: clock }); // counts the clock reads of a full run
    const reads = calls;
    let partial = 0;
    for (let n = 0; n <= reads + 1; n++) {
      let i = 0;
      const seen: string[] = [];
      const got = buildCopies([p.src, ...cs], p.d, p.head, undefined, { budgetMs: 1_000, now: () => (i++ < n ? 0 : 10_000), onSkipped: (_c, why) => seen.push(why) });
      for (const [k, v] of got) expect(full.get(k)).toBe(v); // never a pair the full run lacks
      if (got.size < full.size) {
        partial++;
        expect(seen).toContain('budget'); // and the log is told
      }
      seen.forEach((w) => reasons.add(w));
    }
    expect(partial).toBeGreaterThan(2);
    expect([...reasons]).toEqual(['budget']);
  }, 120_000);

  test('a git that hangs is cut off at the budget, and its candidates stay', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const c = copyOf(p);
    const skipped: [number, string][] = [];
    const t0 = performance.now();
    const got = withGitShim({ sleep: 5 }, () => buildCopies([p.src, c], p.d, p.head, undefined, { budgetMs: 400, onSkipped: (n, why) => skipped.push([n, why]) }));
    expect(performance.now() - t0).toBeLessThan(3_000);
    expect(got.size).toBe(0);
    expect(skipped).toEqual([[1, 'budget']]);
  }, 30_000);

  test('a git that fails at the first listing, at the ignore check or at the source listing keeps every copy', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const c = copyOf(p);
    expect(withGitShim({}, () => buildCopies([p.src, c], p.d, p.head, undefined, PATIENT)).size).toBe(1); // the shim alone changes nothing
    for (const opts of [{ failLs: 1 }, { failIgnore: true }, { failLs: 2 }]) {
      const skipped: string[] = [];
      expect([JSON.stringify(opts), withGitShim(opts, () => buildCopies([p.src, c], p.d, p.head, undefined, { ...PATIENT, onSkipped: (_n, why) => skipped.push(why) })).size]).toEqual([JSON.stringify(opts), 0]);
      expect(skipped).toEqual([]); // not out of time: no budget line
    }
  }, 60_000);

  test('no git at all, or a top that is no repo, keeps the copy', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const c = copyOf(p);
    const saved = process.env.PATH;
    process.env.PATH = real(mkdtempSync(join(tmpdir(), 'goodboy-i32-nogit-')));
    dirs.push(process.env.PATH);
    try {
      expect(buildCopies([p.src, c], p.d, p.head).size).toBe(0);
    } finally {
      process.env.PATH = saved;
    }
    const plain = real(mkdtempSync(join(tmpdir(), 'goodboy-i32-norepo-')));
    dirs.push(plain);
    const lone = write(plain, 'build/app.js', V2);
    expect(buildCopies([lone], plain, p.head).size).toBe(0);
    expect(buildCopies([join(plain, 'gone', 'build', 'app.js')], join(plain, 'gone'), p.head).size).toBe(0); // the top does not exist
  }, 30_000);

  test('a copy that is gone, or under a build path that is a file, is not a candidate', async () => {
    const { buildCopies } = await import('../lib/build-copies');
    const p = project();
    const c = copyOf(p);
    rmSync(c);
    expect(buildCopies([p.src, c], p.d, p.head).size).toBe(0);
    rmSync(join(p.d, 'target'), { recursive: true });
    write(p.d, 'target', 'a file where the build dir would be\n');
    expect(buildCopies([p.src, join(p.d, 'target', 'app.js')], p.d, p.head).size).toBe(0);
  }, 30_000);

  test('through the Stop: 230 ignored copies finish well within the hook timeout, the cap is logged, and the rest are still named', async () => {
    const { MAX_BUILD_COPY_CANDIDATES } = await import('../lib/build-copies');
    const p = project();
    const n = MAX_BUILD_COPY_CANDIDATES + 30;
    for (const c of many(p, n)) recordEdit(p.s, c, 0, undefined, Date.now());
    putTestRecord(p, [p.src]);
    const t0 = performance.now();
    const out = await stop(p);
    expect(performance.now() - t0).toBeLessThan(12_000); // the hook's own timeout is 15 s
    expect(gateLog(p.s).filter((l) => l.includes('build-copy: target/c')).length).toBe(MAX_BUILD_COPY_CANDIDATES);
    expect(gateLog(p.s).some((l) => l.includes('build-copy: 30 candidate(s) kept in the test set (over the candidate cap)'))).toBe(true);
    expect(testBlock(out)).toBe(true); // the 30 over the cap are untested files
    expect(out.reason).toContain('target/c');
  }, 90_000);
});

// ── 5. Record paths: the pinned base and links before `..` ────────────────────────────────────

describe('record paths in this process', () => {
  /** Runs `fn` with the record base pinned to `dir`, then unpins. */
  async function pinned<T>(dir: string, fn: () => T): Promise<T> {
    const { setRecordBase } = await import('../lib/record-paths');
    setRecordBase(dir);
    try {
      return fn();
    } finally {
      setRecordBase();
    }
  }
  function tree(): string {
    const d = real(mkdtempSync(join(tmpdir(), 'goodboy-i32-rp-')));
    dirs.push(d);
    write(d, 'tests/app.test.js', TEST);
    write(d, 'real/sub/keep', 'x\n');
    write(d, 'real/t.test.js', TEST);
    symlinkSync(join(d, 'real', 'sub'), join(d, 'lnk'));
    return d;
  }

  test('setRecordBase pins the dir, recordBase reads it, and no argument unpins it', async () => {
    const { recordBase, setRecordBase } = await import('../lib/record-paths');
    expect(recordBase()).toBe(process.cwd());
    setRecordBase('/x/y/../z');
    try {
      expect(recordBase()).toBe('/x/z');
    } finally {
      setRecordBase();
    }
    expect(recordBase()).toBe(process.cwd());
  }, 30_000);

  test('recordPath follows a link before a `..`, as the OS opens it; a lexical resolve would not', async () => {
    const { recordPath } = await import('../lib/record-paths');
    const d = tree();
    expect(recordPath('lnk/../t.test.js', d)).toBe(join(d, 'real', 't.test.js')); // lnk -> real/sub, so `..` is real/
    expect(resolve(d, 'lnk/../t.test.js')).toBe(join(d, 't.test.js')); // what the old code said
    expect(recordPath('tests/../tests/app.test.js', d)).toBe(join(d, 'tests', 'app.test.js')); // no link: plain
    expect(recordPath('nope/../a.js', d)).toBe(join(d, 'a.js')); // a missing prefix goes up by name
    await pinned(d, () => expect(recordPath('lnk/../t.test.js')).toBe(join(d, 'real', 't.test.js')));
  }, 30_000);

  test('missingTestFiles and scanForbiddenPatterns read a relative record path from the pinned dir', async () => {
    const d = tree();
    write(d, 'tests/todo.test.js', 'test.todo("x");\n');
    const rec = (files: string[]) => [{ test_files: files }] as unknown as TestResult[];
    expect(await pinned(d, () => missingTestFiles(rec(['tests/app.test.js', 'lnk/../t.test.js'])))).toBeNull();
    expect(missingTestFiles(rec(['tests/app.test.js']))).not.toBeNull(); // from the process dir it is not there
    expect(await pinned(d, () => missingTestFiles(rec(['tests/gone.test.js'])))).toContain('tests/gone.test.js');
    expect((await pinned(d, () => scanForbiddenPatterns(['tests/todo.test.js']))).map((h) => h.key)).toEqual(['skipped-test']);
    expect(scanForbiddenPatterns(['tests/todo.test.js'])).toEqual([]); // unreadable from the process dir
  }, 30_000);

  test('withSameContent and changedLineGaps match a relative tested_files entry against the pinned dir', async () => {
    const d = real(mkdtempSync(join(tmpdir(), 'goodboy-i32-rp2-')));
    dirs.push(d);
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    write(d, 'src/a.ts', 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m init");
    const base = sh(d, 'git rev-parse HEAD');
    const treeId = sh(d, 'git rev-parse HEAD^{tree}');
    const a = join(d, 'src', 'a.ts');
    const edit: ChangedFileEdit = { file: a, lastEditTimestamp: iso(30_000) };
    const same = { timestamp: iso(60_000), tree: treeId, tested_files: ['src/a.ts'] } as unknown as TestResult;
    const out = await pinned(d, () => withSameContent([edit], [same], d));
    expect([...out[0]!.sameContentTrees!]).toEqual([treeId]); // the relative name is this file
    const edits = [edit];
    expect(withSameContent(edits, [same], d)).toBe(edits); // against the process dir it is another file

    write(d, 'src/a.ts', 'export const a = 2;\n');
    const changed = { covered: 1, total: 1, files_without_executed_changes: [], files: { 'src/a.ts': { covered: 1, total: 1 } }, in_report: ['src/a.ts'], diff_lines: { 'src/a.ts': 1 }, base };
    const measured = { timestamp: iso(1_000), verdict: 'pass', tested_files: ['src/a.ts'], coverage: { status: 'measured', changed } } as unknown as TestResult;
    const args = { results: [measured], edits: [{ file: a, lastEditTimestamp: null }], top: d, exempt: [], startHead: base };
    expect((await pinned(d, () => changedLineGaps(args))).gaps).toEqual([]);
    expect(changedLineGaps(args).gaps.map((g) => g.file)).toEqual(['src/a.ts']); // not tested, from the process dir
  }, 30_000);

  test('validateReview and missingTestTypes read relative record paths from the pinned dir', async () => {
    const d = tree();
    const a = write(d, 'src/server.ts', 'export {};\n');
    const review = { timestamp: iso(1_000), reviewed_files: ['src/server.ts'], category: 'fix-bug', findings: [], unknown_assumptions_checked: [], verdict: 'pass' } as never;
    expect((await pinned(d, () => validateReview(review, [a]))).ok).toBe(true);
    expect(validateReview(review, [a]).ok).toBe(false); // from the process dir it names another file
    const rec = {
      timestamp: iso(1_000),
      tested_files: ['src/server.ts'],
      category: 'add-feature',
      test_files: [join(d, 'tests', 'app.test.js')],
      environment: { mode: 'local' },
      suites: [{ name: 's', command: 'bun test', passed: 2, failed: 0, output: '2 pass', type: 'integration', duration_ms: 5 }],
      acceptance: [],
      verdict: 'pass',
    } as unknown as TestResult;
    const args = { results: [rec], accepted: new Set([rec]), edits: [{ file: a, lastEditTimestamp: iso(5_000) }], top: d, exempt: [] };
    expect((await pinned(d, () => missingTestTypes(args))).gaps).toEqual([]); // server code has its integration suite
    expect(missingTestTypes(args).gaps.map((g) => g.missing.join(','))).toEqual(['integration']);
  }, 30_000);
});

/** Runs a CLI command in this process, with its stdout and stderr captured. */
async function captured(fn: () => Promise<void>): Promise<{ out: string; err: string }> {
  const o = process.stdout.write;
  const e = process.stderr.write;
  let out = '';
  let err = '';
  process.stdout.write = ((c: string | Uint8Array) => ((out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((err += String(c)), true)) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
  return { out, err };
}

describe('test-write and review-write in this process', () => {
  const input = (d: string, extra: Record<string, unknown> = {}) => ({
    timestamp: new Date().toISOString(),
    tested_files: ['src/app.js'],
    category: 'fix-bug',
    test_files: ['tests/app.test.js'],
    environment: { mode: 'none', command: 'none', evidence: 'library' },
    suites: [{ name: 'unit', command: 'node --test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [{ id: 'AC-1', description: 'd', test: 'tests/app.test.js', red: { command: 'c', output: 'o', exit_code: 1 }, green: { command: 'c', output: 'o', exit_code: 0 } }],
    verdict: 'pass',
    ...extra,
  });
  function inputFile(body: unknown): string {
    const dir = real(mkdtempSync(join(tmpdir(), 'goodboy-i32-in-')));
    dirs.push(dir);
    return write(dir, 'in.json', JSON.stringify(body));
  }

  test('test-write stores absolute paths; a test file is found from the project dir, then from the shell dir; idle files are warned about', async () => {
    const { cmdTestWrite } = await import('../lib/cli');
    const p = project();
    // A test file that exists only from the process dir: spelled relative to it.
    const outside = write(real(mkdtempSync(join(tmpdir(), 'goodboy-i32-out-'))), 't.test.js', TEST);
    dirs.push(dirname(outside));
    const fromShell = relative(process.cwd(), outside);
    const changed = { covered: 0, total: 1, files_without_executed_changes: ['src/app.js'], files: { 'src/app.js': { covered: 0, total: 1 } }, in_report: ['src/app.js'], diff_lines: { 'src/app.js': 1 }, base: p.head };
    const file = inputFile(input(p.d, { test_files: ['tests/app.test.js', fromShell], coverage: { status: 'measured', changed } }));
    const { out, err } = await captured(() => cmdTestWrite(p.d, [file]));
    const saved = JSON.parse(readFileSync(JSON.parse(out).path, 'utf8'));
    expect(saved.tested_files).toEqual([join(p.d, 'src', 'app.js')]);
    expect(saved.test_files).toEqual([join(p.d, 'tests', 'app.test.js'), outside]);
    expect(err).toContain('warning: no changed line of these tested files ran in the tests: src/app.js');
  }, 60_000);

  test('review-write stores absolute reviewed_files, resolved against the project dir', async () => {
    const { cmdReviewWrite } = await import('../lib/cli');
    const p = project();
    const review = { timestamp: new Date().toISOString(), reviewed_files: ['src/app.js', 'lnk/../f.js'], category: 'fix-bug', findings: [], unknown_assumptions_checked: [], verdict: 'pass', dimensions_checked: ['plan-completeness'] };
    mkdirSync(join(p.d, 'real', 'sub'), { recursive: true });
    symlinkSync(join(p.d, 'real', 'sub'), join(p.d, 'lnk'));
    const { out } = await captured(() => cmdReviewWrite(p.d, [inputFile(review)]));
    expect(JSON.parse(readFileSync(JSON.parse(out).path, 'utf8')).reviewed_files).toEqual([join(p.d, 'src', 'app.js'), join(p.d, 'real', 'f.js')]);
  }, 60_000);
});

describe('dev-cycle product evidence fails closed', () => {
  test('a read that throws is no evidence', () => {
    const d = real(mkdtempSync(join(tmpdir(), 'goodboy-i32-pe2-')));
    dirs.push(d);
    write(d, 'docs/versions/v1/e2e/page.test.js', 'x\n');
    const hostile = {
      get red(): never {
        throw new Error('unreadable');
      },
    } as never;
    expect(devCycleTestIsProductEvidence('docs/versions/v1/e2e/page.test.js', hostile, d)).toBe(false);
  }, 30_000);
});
