import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { approvalMarkerRelPath } from '../lib/approval-marker';
import { REVIEW_CURSOR_FILE, cursorFileName } from '../lib/review-cursor';
import * as dims from '../lib/review-dimensions';
import { validateReviewCoverage } from '../lib/review-validator';
import type { ReviewResult } from '../lib/types';

// v0.36.18 (plan §15.34 item 2, #27): the review gate judges the required dimensions per changed
// file, shell scripts need `error-path` and `security-injection`, and a failure while working the
// dimensions out blocks the Stop instead of passing it.
//
// `dims` is a namespace import so that, run against code from before the change, a missing export
// fails its own test and not the whole file.

const ROOT = resolve(import.meta.dir, '..');
const STOP_HOOK = join(ROOT, 'hooks', 'stop.ts');
const UI = ['ui-ux-accessibility', 'plan-completeness'];
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('V18-AC-7 shell scripts: required dimensions and review axes', () => {
  test('.sh, .bash, .zsh and .ps1 require error-path and security-injection, and nothing else', () => {
    for (const f of ['deploy.sh', 'scripts/run.bash', 'a/b/setup.zsh', 'tools/build.ps1', 'DEPLOY.SH', 'Setup.PS1']) {
      expect([f, dims.requiredDimensionsFor([f])]).toEqual([f, ['error-path', 'security-injection']]);
    }
  });

  test('other names are not scripts', () => {
    for (const f of ['notes.sh.md', 'shell.txt', 'sh', 'a.shx', 'run.fish', 'docs/deploy.sh.png']) {
      const got = dims.requiredDimensionsFor([f]);
      expect([f, got.includes('security-injection')]).toEqual([f, false]);
    }
  });

  test('a script next to a code file adds its two dimensions to the code file ones', () => {
    const got = dims.requiredDimensionsFor(['src/a.ts', 'run.sh']);
    expect(got).toContain('error-path');
    expect(got).toContain('security-injection');
    expect(got).toContain('performance');
  });

  test('review-axes gives the hallucination and security axes for a script, with the two dimensions', () => {
    for (const f of ['x.sh', 'x.bash', 'x.zsh', 'x.ps1']) {
      expect([f, dims.axesFor([f])]).toEqual([f, ['hallucination', 'security']]);
    }
    const proc = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'review-axes', 'deploy.sh'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    const out = JSON.parse(new TextDecoder().decode(proc.stdout)) as { required_dimensions: string[]; axes: { axis: string; dimensions: string[] }[] };
    expect(out.required_dimensions).toEqual(['error-path', 'security-injection']);
    expect(out.axes.map((a) => a.axis)).toEqual(['hallucination', 'security']);
    expect(out.axes.find((a) => a.axis === 'security')!.dimensions).toEqual(['security-injection', 'error-path']);
  });
});

describe('V18-AC-6 missingDimensionsByFile (unit)', () => {
  const rv = (d: string[] | undefined): { dimensions_checked?: string[] } => (d === undefined ? {} : { dimensions_checked: d });

  test('review 1 covers A with the dimension, review 2 covers B with none: B is missing it (the union would pass)', () => {
    const reviews: Record<string, ReturnType<typeof rv>[]> = { 'a.html': [rv(UI)], 'b.html': [rv(['plan-completeness'])] };
    const got = dims.missingDimensionsByFile(['a.html', 'b.html'], (f) => reviews[f] as never);
    expect(got).toEqual([{ file: 'b.html', missing: ['ui-ux-accessibility'] }]);
  });

  test('each file satisfied by its own reviews passes', () => {
    const reviews: Record<string, ReturnType<typeof rv>[]> = { 'a.html': [rv(UI)], 'b.html': [rv(UI)] };
    expect(dims.missingDimensionsByFile(['a.html', 'b.html'], (f) => reviews[f] as never)).toEqual([]);
  });

  test("several reviews of one file add up for that file (parallel axes)", () => {
    const got = dims.missingDimensionsByFile(['run.sh'], () => [rv(['error-path']), rv(['security-injection'])] as never);
    expect(got).toEqual([]);
  });

  test('a file with no reviews has every dimension missing; a document needs none', () => {
    expect(dims.missingDimensionsByFile(['run.sh'], () => undefined)).toEqual([{ file: 'run.sh', missing: ['error-path', 'security-injection'] }]);
    expect(dims.missingDimensionsByFile(['README.md', 'notes.txt'], () => undefined)).toEqual([]);
  });

  test('a review without dimensions_checked (old format) adds nothing, and does not throw', () => {
    expect(dims.missingDimensionsByFile(['run.sh'], () => [rv(undefined), { dimensions_checked: 'x' as never }])).toEqual([
      { file: 'run.sh', missing: ['error-path', 'security-injection'] },
    ]);
  });

  test('a file is judged once, in the order given; blank and non-string names are skipped', () => {
    const got = dims.missingDimensionsByFile(['b.sh', 'a.sh', 'b.sh', '', '  ', 5 as never], () => undefined);
    expect(got.map((m) => m.file)).toEqual(['b.sh', 'a.sh']);
  });

  test('a throw in the lookup is not caught here (the caller fails closed)', () => {
    expect(() =>
      dims.missingDimensionsByFile(['a.sh'], () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  test('describeMissingDimensions words one entry per file, five at most', () => {
    expect(dims.describeMissingDimensions([{ file: 'a.sh', missing: ['error-path', 'security-injection'] }, { file: 'b.sh', missing: ['error-path'] }] as never)).toBe(
      'a.sh: error-path, security-injection; b.sh: error-path',
    );
    const seven = Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.sh`, missing: ['error-path'] }));
    const text = dims.describeMissingDimensions(seven as never);
    expect(text).toContain('f4.sh: error-path');
    expect(text).not.toContain('f5.sh');
    expect(text).toEndWith('; and 2 more file(s)');
    expect(dims.describeMissingDimensions([])).toBe('');
  });
});

describe('V18-AC-6 validateReviewCoverage byFile', () => {
  const now = Date.now();
  const rev = (files: string[], d: string[], ago: number): ReviewResult =>
    ({
      timestamp: new Date(now - ago).toISOString(),
      reviewed_files: files,
      category: 'fix-bug',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: d,
    }) as unknown as ReviewResult;
  const edit = (file: string) => ({ file, lastEditTimestamp: new Date(now - 60_000).toISOString() });

  test('each changed file maps to its own fresh covering reviews, newest first', () => {
    const r1 = rev(['/p/a.html'], UI, 1000);
    const r2 = rev(['/p/b.html'], ['plan-completeness'], 2000);
    const r3 = rev(['/p/a.html', '/p/b.html'], ['error-path'], 3000);
    const v = validateReviewCoverage([r1, r2, r3], [edit('/p/a.html'), edit('/p/b.html')]);
    expect(v.ok).toBe(true);
    expect(v.byFile?.get('/p/a.html')).toEqual([r1, r3]);
    expect(v.byFile?.get('/p/b.html')).toEqual([r2, r3]);
  });

  test('a stale review is not in byFile; a file with no fresh review has no entry', () => {
    const old = rev(['/p/a.html'], UI, 120_000); // before the last edit
    const fresh = rev(['/p/b.html'], UI, 1000);
    const v = validateReviewCoverage([old, fresh], [edit('/p/a.html'), edit('/p/b.html')]);
    expect(v.ok).toBe(false);
    expect(v.byFile?.has('/p/a.html')).toBe(false);
    expect(v.byFile?.get('/p/b.html')).toEqual([fresh]);
  });

  test('a file with a fresh and a stale review maps to the fresh one only', () => {
    const stale = rev(['/p/a.html'], ['ui-ux-accessibility'], 120_000);
    const fresh = rev(['/p/a.html'], ['plan-completeness'], 1000);
    const v = validateReviewCoverage([stale, fresh], [edit('/p/a.html')]);
    expect(v.ok).toBe(true);
    expect(v.byFile?.get('/p/a.html')).toEqual([fresh]);
  });
});

// ---- the spawned Stop ----

function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-v18d-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-v18d-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

const sessionDirOf = (tmp: string, sessionId: string): string => join(tmp, `goodboy-session-${sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_')}`);

/** The edits of one turn; turn.txt holds turn-1 so the Stop's own increment lands on `turn`. */
function seedSession(tmp: string, sessionId: string, turn: number, files: string[], cwd: string, counter = turn - 1): void {
  const dir = sessionDirOf(tmp, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'turn.txt'), String(counter), 'utf8');
  const ts = new Date().toISOString();
  writeFileSync(join(dir, 'edits.jsonl'), files.map((f) => JSON.stringify({ file: resolve(cwd, f), turn, timestamp: ts })).join('\n') + '\n', 'utf8');
  for (const f of files) {
    const abs = resolve(cwd, f);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, '', 'utf8');
  }
}

/** A review file; future-dated a minute so it is never older than an edit. */
function writeReviewFile(cwd: string, name: string, files: string[], d: string[]): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(
    join(reviewsDir, name),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: files.map((f) => resolve(cwd, f)),
      category: 'add-feature',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: d,
    }),
    'utf8',
  );
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runStop(tmp: string, cwd: string, sessionId: string, opts: { active?: boolean; env?: Record<string, string>; preload?: string } = {}): Promise<StopOut> {
  const proc = Bun.spawn(['bun', ...(opts.preload ? ['--preload', opts.preload] : []), STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp, HOME: tmp, GOODBOY_TEST_GATE: 'off', ...opts.env },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'Stop', ...(opts.active ? { stop_hook_active: true } : {}) })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as StopOut;
  } catch {
    return {};
  }
}

function approveStop(cwd: string, sessionId: string): string {
  const p = join(cwd, approvalMarkerRelPath('stop', sessionId));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '', 'utf8');
  return p;
}

describe('V18-AC-6 the Stop judges dimensions per file', () => {
  test('the premise: b.html and a.html each need the two UI dimensions', () => {
    expect(dims.requiredDimensionsFor(['a.html']) as string[]).toEqual([...UI].sort());
    expect(dims.requiredDimensionsFor(['b.html']) as string[]).toEqual([...UI].sort());
  });

  test('review 1 checks the dimension for a.html, review 2 covers b.html without it: BLOCKS, naming b.html only', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['a.html', 'b.html'], cwd);
    writeReviewFile(cwd, 'r1.json', ['a.html'], UI);
    writeReviewFile(cwd, 'r2.json', ['b.html'], ['plan-completeness']);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('b.html: ui-ux-accessibility');
    expect(out.reason).not.toContain('a.html:');
    expect(out.reason).toContain('per file');
  });

  test('a review with no dimensions for b.html blocks it with both dimensions', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['a.html', 'b.html'], cwd);
    writeReviewFile(cwd, 'r1.json', ['a.html'], UI);
    writeReviewFile(cwd, 'r2.json', ['b.html'], []);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(/b\.html: [a-z, -]*plan-completeness/);
    expect(out.reason).toContain('ui-ux-accessibility');
  });

  test('each file satisfied by its own review passes', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['a.html', 'b.html'], cwd);
    writeReviewFile(cwd, 'r1.json', ['a.html'], UI);
    writeReviewFile(cwd, 'r2.json', ['b.html'], UI);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('one review that covers both files with the dimensions passes; parallel axes on one file add up', async () => {
    const one = newSandbox();
    seedSession(one.tmp, one.sessionId, 1, ['a.html', 'b.html'], one.cwd);
    writeReviewFile(one.cwd, 'r1.json', ['a.html', 'b.html'], UI);
    expect((await runStop(one.tmp, one.cwd, one.sessionId)).decision).toBeUndefined();

    const par = newSandbox();
    seedSession(par.tmp, par.sessionId, 1, ['a.html'], par.cwd);
    writeReviewFile(par.cwd, 'r1.json', ['a.html'], ['ui-ux-accessibility']);
    writeReviewFile(par.cwd, 'r2.json', ['a.html'], ['plan-completeness']);
    expect((await runStop(par.tmp, par.cwd, par.sessionId)).decision).toBeUndefined();
  });

  test("the user's Stop marker lets a per-file gap pass once", async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['a.html', 'b.html'], cwd);
    writeReviewFile(cwd, 'r1.json', ['a.html'], UI);
    writeReviewFile(cwd, 'r2.json', ['b.html'], ['plan-completeness']);
    const marker = approveStop(cwd, sessionId);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('b.html: ui-ux-accessibility');
    expect(existsSync(marker)).toBe(false);
  });

  test('a script file needs error-path and security-injection from a review that covers it', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['scripts/deploy.sh'], cwd);
    writeReviewFile(cwd, 'r1.json', ['scripts/deploy.sh'], ['error-path']);
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('scripts/deploy.sh: security-injection');

    const ok = newSandbox();
    seedSession(ok.tmp, ok.sessionId, 1, ['scripts/deploy.sh'], ok.cwd);
    writeReviewFile(ok.cwd, 'r1.json', ['scripts/deploy.sh'], ['error-path', 'security-injection']);
    expect((await runStop(ok.tmp, ok.cwd, ok.sessionId)).decision).toBeUndefined();
  });
});

describe('V18-AC-6 the stop_hook_active acceptance path judges per file too', () => {
  const cursor = (tmp: string, sessionId: string, cwd: string): string => join(sessionDirOf(tmp, sessionId), cursorFileName(REVIEW_CURSOR_FILE, cwd));

  test('a per-file gap is not accepted (and never blocks there); a complete set is accepted', async () => {
    const gap = newSandbox();
    seedSession(gap.tmp, gap.sessionId, 1, ['a.html', 'b.html'], gap.cwd, 5);
    writeReviewFile(gap.cwd, 'r1.json', ['a.html'], UI);
    writeReviewFile(gap.cwd, 'r2.json', ['b.html'], ['plan-completeness']);
    const out = await runStop(gap.tmp, gap.cwd, gap.sessionId, { active: true });
    expect(out.decision).toBeUndefined();
    expect(existsSync(cursor(gap.tmp, gap.sessionId, gap.cwd))).toBe(false);

    const full = newSandbox();
    seedSession(full.tmp, full.sessionId, 1, ['a.html', 'b.html'], full.cwd, 5);
    writeReviewFile(full.cwd, 'r1.json', ['a.html'], UI);
    writeReviewFile(full.cwd, 'r2.json', ['b.html'], UI);
    const ok = await runStop(full.tmp, full.cwd, full.sessionId, { active: true });
    expect(ok.decision).toBeUndefined();
    expect(existsSync(cursor(full.tmp, full.sessionId, full.cwd))).toBe(true);
  });
});

describe('V18-AC-8 a failure while working the dimensions out blocks the Stop', () => {
  // A preload that makes `requiredDimensionsFor` throw when V18_FAULT is set, for this spawned Stop only
  // (the module's source is rewritten as it loads; nothing in the repo changes).
  function faultPreload(base: string): string {
    const needle = 'export function requiredDimensionsFor(changedFiles: string[], opts?: DimensionOptions): ReviewDimension[] {';
    const src = readFileSync(join(ROOT, 'lib', 'review-dimensions.ts'), 'utf8');
    expect(src).toContain(needle); // the injection point must exist, or this test proves nothing
    const p = join(base, 'fault-preload.ts');
    writeFileSync(
      p,
      `import { plugin } from 'bun';
plugin({
  name: 'v18-fault',
  setup(build) {
    build.onLoad({ filter: /lib[\\\\/]review-dimensions\\.ts$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      const needle = ${JSON.stringify(needle)};
      return { contents: text.replace(needle, needle + "\\n  if (process.env.V18_FAULT === '1') throw new Error('injected dimension fault');"), loader: 'ts' };
    });
  },
});
`,
      'utf8',
    );
    return p;
  }

  function seeded() {
    const s = newSandbox();
    seedSession(s.tmp, s.sessionId, 1, ['a.html'], s.cwd);
    writeReviewFile(s.cwd, 'r1.json', ['a.html'], UI); // a complete review: only the fault can block
    return { ...s, preload: faultPreload(s.tmp) };
  }

  test('without the fault the same review passes (the preload alone changes nothing)', async () => {
    const s = seeded();
    const out = await runStop(s.tmp, s.cwd, s.sessionId, { preload: s.preload });
    expect(out.decision).toBeUndefined();
  });

  test('with the fault the Stop BLOCKS with a reason that says the dimensions could not be worked out', async () => {
    const s = seeded();
    const out = await runStop(s.tmp, s.cwd, s.sessionId, { preload: s.preload, env: { V18_FAULT: '1' } });
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('could not be worked out');
    expect(out.reason).toContain('injected dimension fault');
  });

  test("the user's marker passes it, once", async () => {
    const s = seeded();
    const marker = approveStop(s.cwd, s.sessionId);
    const out = await runStop(s.tmp, s.cwd, s.sessionId, { preload: s.preload, env: { V18_FAULT: '1' } });
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('injected dimension fault');
    expect(existsSync(marker)).toBe(false);
  });

  test('on the stop_hook_active path the fault leaves the review unaccepted and does not block there', async () => {
    const s = newSandbox();
    seedSession(s.tmp, s.sessionId, 1, ['a.html'], s.cwd, 5);
    writeReviewFile(s.cwd, 'r1.json', ['a.html'], UI);
    const pre = faultPreload(s.tmp);
    const out = await runStop(s.tmp, s.cwd, s.sessionId, { active: true, preload: pre, env: { V18_FAULT: '1' } });
    expect(out.decision).toBeUndefined();
    expect(existsSync(join(sessionDirOf(s.tmp, s.sessionId), cursorFileName(REVIEW_CURSOR_FILE, s.cwd)))).toBe(false);
  });
});
