// M6g (track M, #19): the run gate of the privacy review (lib/sandbox-privacy-gate.ts). A real-data `sandbox-run` starts only
// when the current setup (the sandbox's files, data.json, the tests that use the data helper) is covered by passing reviews
// of its current content that list `data-privacy`. The suite sets the switch off for the older run tests (tests/setup.ts);
// these turn it on.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workTreeState } from '../lib/push-test';
import { SANDBOX_DIR } from '../lib/sandbox-mode';
import { PRIVACY_REVIEW_WINDOW_MIN, privacyGate, privacyGateOff } from '../lib/sandbox-privacy-gate';
import { cleanupFakeProjects, type FakeProject, fakeProject } from './m6a-project';

setDefaultTimeout(120_000);
afterEach(cleanupFakeProjects);

const ON = { GOODBOY_SANDBOX_PRIVACY_GATE: 'on' };
const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const PLAIN = { dump: null, dumpFormat: null } as const;
const COMPOSE = `${SANDBOX_DIR}/compose.yml`;
const HELPER_TEST = `import { pick } from '../.goodboy/sandbox/data/goodboy-data';\nexport const u = pick;\n`;
const CANARY = 'CANARY-김민수-900101-1234567';

function put(f: FakeProject, rel: string, text: string): void {
  mkdirSync(dirname(join(f.root, rel)), { recursive: true });
  writeFileSync(join(f.root, rel), text);
}

/** A real-data fake project that is a git repository, with one helper-using test. */
function repoProject(local: typeof REAL | typeof PLAIN = REAL, git = true): FakeProject {
  const f = fakeProject(local);
  put(f, 'tests/users.test.ts', HELPER_TEST);
  if (git) expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: f.root }).exitCode).toBe(0);
  return f;
}

interface ReviewOpts {
  dims?: string[];
  verdict?: string;
  tree?: string | null | 'omit';
  name?: string;
  mtimeDaysAgo?: number;
  commit?: string;
  /** Findings of the record (default none). */
  findings?: { file: string; severity: string; issue: string; probe?: string }[];
  /** How long ago its timestamp is, ms (default one minute). */
  agoMs?: number;
  /** The dir whose `.claude/reviews` holds it (default the project root). */
  base?: string;
}

/** A review record as `review-write` stores one (its tree is the work tree now), written straight into the reviews dir. */
function review(f: FakeProject, rels: string[], o: ReviewOpts = {}): void {
  const dir = join(o.base ?? f.root, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  const rec: Record<string, unknown> = {
    timestamp: new Date(Date.now() - (o.agoMs ?? 60_000)).toISOString(),
    reviewed_files: rels.map((r) => join(f.root, r)),
    category: 'add-feature',
    findings: o.findings ?? [],
    unknown_assumptions_checked: [],
    verdict: o.verdict ?? 'pass',
    dimensions_checked: o.dims ?? ['data-privacy'],
  };
  const tree = o.tree === undefined ? workTreeState(f.root).tree : o.tree;
  if (tree !== 'omit') rec.tree = tree;
  if (o.commit !== undefined) rec.commit = o.commit;
  const p = join(dir, `${o.name ?? 'r1'}.json`);
  writeFileSync(p, JSON.stringify(rec));
  if (o.mtimeDaysAgo !== undefined) {
    const t = new Date(Date.now() - o.mtimeDaysAgo * 86_400_000);
    utimesSync(p, t, t);
  }
}

const run = (f: FakeProject, env: Record<string, string> = ON) => f.inproc('sandbox-run', ['--suite', 'unit'], env);
const outDirExists = (f: FakeProject): boolean => existsSync(join(f.root, SANDBOX_DIR, 'out'));

describe('a real-data run without a covering review is refused', () => {
  test('refused with a fixed code and the files, and nothing is written: no out dir, no result.json', async () => {
    const f = repoProject();
    const r = await run(f);
    expect(r.code).toBe(1);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(r.out.files).toEqual([COMPOSE, 'tests/users.test.ts']);
    expect(r.out.diagnostic).toEqual({ code: 'privacy-review-missing', step: 'privacy-gate' });
    expect(r.out.reason).toContain('axis: data-privacy');
    // the way off is the user's, in their settings; no text a model reads names the switch (the first review finding)
    expect(r.out.reason).toContain('The user can turn this check off in their settings.');
    expect(r.text).not.toContain('GOODBOY_SANDBOX_PRIVACY_GATE');
    expect(r.out.result).toBeUndefined();
    expect(outDirExists(f)).toBe(false);
    expect(f.hostFiles()).toEqual([]);
  });

  test('through the CLI, as a model sees it: exit 1 and the same JSON', () => {
    const f = repoProject();
    const r = f.cli(['sandbox-run', '--suite', 'unit'], ON);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).stopped).toBe('privacy-review-missing');
    expect(outDirExists(f)).toBe(false);
  });

  test('the refusal names relative paths and a fixed text, never a file’s content or the project path', async () => {
    const f = repoProject();
    put(f, 'tests/users.test.ts', `${HELPER_TEST}export const secret = '${CANARY}';\n`);
    const r = await run(f);
    expect(r.text).not.toContain('CANARY');
    expect(r.text).not.toContain('900101');
    expect(r.text).not.toContain(f.root);
    expect(r.text).toContain('tests/users.test.ts');
  });

  test('the files of a long list are cut at twenty in the text, all of them in `files`', async () => {
    const f = repoProject();
    for (let i = 0; i < 22; i++) put(f, `tests/more${i}.test.ts`, HELPER_TEST);
    const r = await run(f);
    expect(r.out.files).toHaveLength(24);
    expect(r.out.reason).toContain('24 file(s)');
    expect(r.out.reason).toContain('and 4 more');
  });
});

describe('a covering review lets it run', () => {
  test('a passing review with data-privacy, a tree and every file listed: the run goes on', async () => {
    const f = repoProject();
    review(f, [COMPOSE, 'tests/users.test.ts']);
    const r = await run(f);
    expect(r.out.stopped).toBeUndefined();
    expect(r.code).toBe(0);
    expect(f.hostFiles().some((x) => x.endsWith('result.json'))).toBe(true);
  });

  test('two reviews that each cover some of the files add up', async () => {
    const f = repoProject();
    review(f, [COMPOSE], { name: 'a' });
    review(f, ['tests/users.test.ts'], { name: 'b' });
    expect((await run(f)).code).toBe(0);
  });

  test('a review of other files leaves the rest refused, and `files` holds only those', async () => {
    const f = repoProject();
    review(f, [COMPOSE]);
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(r.out.files).toEqual(['tests/users.test.ts']);
  });
});

describe('what does not count as a covering review', () => {
  const refused = async (f: FakeProject): Promise<string[]> => {
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(outDirExists(f)).toBe(false);
    return r.out.files as string[];
  };

  test('a review without a tree, or with `tree: null`', async () => {
    const a = repoProject();
    review(a, [COMPOSE, 'tests/users.test.ts'], { tree: 'omit' });
    expect(await refused(a)).toHaveLength(2);
    const b = repoProject();
    review(b, [COMPOSE, 'tests/users.test.ts'], { tree: null });
    expect(await refused(b)).toHaveLength(2);
  });

  test('a review written before trees, even one that names this checkout’s HEAD, is judged by nothing: no tree, no evidence', async () => {
    const f = repoProject();
    const git = (...a: string[]) => Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: f.root, stdout: 'pipe', stderr: 'pipe' });
    expect(git('commit', '--allow-empty', '-q', '-m', 'start').exitCode).toBe(0);
    const head = git('rev-parse', 'HEAD').stdout.toString().trim();
    review(f, [COMPOSE, 'tests/users.test.ts'], { tree: 'omit', commit: head });
    expect(await refused(f)).toHaveLength(2);
    // the same record with its tree is evidence
    review(f, [COMPOSE, 'tests/users.test.ts'], { commit: head, name: 'treed' });
    expect((await run(f)).code).toBe(0);
  });

  test('a review that does not list data-privacy', async () => {
    const f = repoProject();
    review(f, [COMPOSE, 'tests/users.test.ts'], { dims: ['security-secrets', 'hallucination'] });
    expect(await refused(f)).toHaveLength(2);
    const none = repoProject();
    review(none, [COMPOSE, 'tests/users.test.ts'], { dims: [] });
    expect(await refused(none)).toHaveLength(2);
  });

  test('a review that does not pass', async () => {
    for (const verdict of ['needs-changes', 'fail']) {
      const f = repoProject();
      review(f, [COMPOSE, 'tests/users.test.ts'], { verdict });
      expect([verdict, (await refused(f)).length]).toEqual([verdict, 2]);
    }
  });

  test('a review of a content the file no longer has: the changed file asks for a new review, the others stay covered', async () => {
    const f = repoProject();
    review(f, [COMPOSE, 'tests/users.test.ts']);
    put(f, 'tests/users.test.ts', `${HELPER_TEST}// changed after the review\n`);
    expect(await refused(f)).toEqual(['tests/users.test.ts']);
    review(f, ['tests/users.test.ts'], { name: 'again' });
    expect((await run(f)).code).toBe(0);
  });

  test('a review that lists the file under a tree of other content is not evidence (the tree is not the work tree)', async () => {
    const f = repoProject();
    const before = workTreeState(f.root).tree;
    put(f, 'tests/users.test.ts', `${HELPER_TEST}// edited\n`);
    review(f, [COMPOSE, 'tests/users.test.ts'], { tree: before });
    expect(await refused(f)).toEqual(['tests/users.test.ts']);
  });

  test('a review older than the window is not read', async () => {
    expect(PRIVACY_REVIEW_WINDOW_MIN).toBe(30 * 24 * 60);
    const f = repoProject();
    review(f, [COMPOSE, 'tests/users.test.ts'], { mtimeDaysAgo: 31 });
    expect(await refused(f)).toHaveLength(2);
    const ok = repoProject();
    review(ok, [COMPOSE, 'tests/users.test.ts'], { mtimeDaysAgo: 29 });
    expect((await run(ok)).code).toBe(0);
  });

  test('a review with a timestamp in the future is not trusted', async () => {
    const f = repoProject();
    review(f, [COMPOSE, 'tests/users.test.ts']);
    const p = join(f.root, '.claude', 'reviews', 'r1.json');
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    rec.timestamp = new Date(Date.now() + 3 * 3_600_000).toISOString();
    writeFileSync(p, JSON.stringify(rec));
    expect(await refused(f)).toHaveLength(2);
  });
});

describe('what the gate leaves alone, and what it cannot read', () => {
  test('the user’s switch skips it; any other value keeps it', async () => {
    const f = repoProject();
    expect((await run(f, { GOODBOY_SANDBOX_PRIVACY_GATE: 'off' })).code).toBe(0);
    const g = repoProject();
    expect((await run(g, { GOODBOY_SANDBOX_PRIVACY_GATE: 'maybe' })).out.stopped).toBe('privacy-review-missing');
    expect(privacyGateOff({ GOODBOY_SANDBOX_PRIVACY_GATE: ' OFF ' })).toBe(true);
    expect(privacyGateOff({})).toBe(false);
  });

  test('a project with no real data is not asked: no review, no repository, the run is the one it always was', async () => {
    const f = repoProject(PLAIN);
    expect((await run(f)).code).toBe(0);
    const g = repoProject(PLAIN, false);
    expect((await run(g)).code).toBe(0);
  });

  test('a setup that cannot be listed (no git repository) is refused with its own code and no files', async () => {
    const f = repoProject(REAL, false);
    const r = await run(f);
    expect(r.code).toBe(1);
    expect(r.out.stopped).toBe('privacy-setup-unreadable');
    expect(r.out.files).toEqual([]);
    expect(r.out.diagnostic).toEqual({ code: 'privacy-setup-unreadable', step: 'privacy-gate' });
    expect(r.out.reason).toContain('could not be listed in full');
    expect(outDirExists(f)).toBe(false);
  });

  test('a test too big to read makes the setup unreadable, whatever the reviews say', async () => {
    const f = repoProject();
    put(f, 'tests/big.test.ts', `export const x = '${'x'.repeat(600 * 1024)}';\n`);
    review(f, [COMPOSE, 'tests/users.test.ts', 'tests/big.test.ts']);
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-setup-unreadable');
    expect(r.out.reason).toContain('git could not list the files, or one could not be read');
    expect(r.out.reason).toContain('the user can turn this check off in their settings.');
    expect(r.text).not.toContain('GOODBOY_SANDBOX_PRIVACY_GATE');
  });

  test('the codes are DiagCodes, and the gate result carries the reason it prints', () => {
    const f = repoProject();
    const g = privacyGate(f.root, ON);
    expect(g.ok).toBe(false);
    if (!g.ok) expect([g.code, g.files]).toEqual(['privacy-review-missing', [COMPOSE, 'tests/users.test.ts']]);
    expect(privacyGate(f.root, { GOODBOY_SANDBOX_PRIVACY_GATE: 'off' })).toEqual({ ok: true });
  });

  test('a gate that fails while reading is closed: an unreadable setup refuses, unreadable reviews cover nothing', () => {
    const f = repoProject();
    const g = privacyGate(f.root, ON, {
      setup: () => {
        throw new Error('boom');
      },
    });
    expect(g.ok).toBe(false);
    if (!g.ok) expect([g.code, g.files]).toEqual(['privacy-setup-unreadable', []]);
    const h = privacyGate(f.root, ON, {
      reviews: () => {
        throw new Error('boom');
      },
    });
    expect(h.ok).toBe(false);
    if (!h.ok) expect([h.code, h.files]).toEqual(['privacy-review-missing', [COMPOSE, 'tests/users.test.ts']]);
    // reviews that cover nothing in a project with nothing to review: nothing to refuse
    expect(privacyGate(f.root, ON, { setup: () => ({ ok: true, files: [] }), reviews: () => [] })).toEqual({ ok: true });
  });

  test('a run that fails its arguments is refused for them first, as before', async () => {
    const f = repoProject();
    const r = await f.inproc('sandbox-run', ['--suite', 'bogus'], ON);
    expect(r.error).toContain('--suite is unit, e2e or all');
  });

  test('the CLI still honors the switch from its own process environment (the user’s settings), and no other value', () => {
    const f = repoProject();
    const off = f.cli(['sandbox-run', '--suite', 'unit'], { GOODBOY_SANDBOX_PRIVACY_GATE: 'off' });
    expect(off.code).toBe(0);
    expect(JSON.parse(off.stdout).stopped).toBeUndefined();
    const g = repoProject();
    expect(JSON.parse(g.cli(['sandbox-run', '--suite', 'unit'], { GOODBOY_SANDBOX_PRIVACY_GATE: 'maybe' }).stdout).stopped).toBe('privacy-review-missing');
  });
});

describe('the newest review of a file decides, and an open high or medium finding is no pass', () => {
  const both = [COMPOSE, 'tests/users.test.ts'];
  const refused = async (f: FakeProject): Promise<string[]> => {
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(outDirExists(f)).toBe(false);
    return r.out.files as string[];
  };
  const finding = (severity: string) => [{ file: join('x', 'y.ts'), severity, issue: 'a leak', probe: 'ran it' }];

  test('an older pass does not outlive a newer needs-changes or fail on the same content', async () => {
    for (const verdict of ['needs-changes', 'fail']) {
      const f = repoProject();
      review(f, both, { name: 'older', agoMs: 120_000 });
      review(f, both, { name: 'newer', agoMs: 30_000, verdict });
      expect([verdict, await refused(f)]).toEqual([verdict, both]);
    }
  });

  test('a newer pass after an older needs-changes covers it, and the verdict of each file is its own', async () => {
    const f = repoProject();
    review(f, both, { name: 'older', agoMs: 120_000, verdict: 'needs-changes' });
    review(f, both, { name: 'newer', agoMs: 30_000 });
    expect((await run(f)).code).toBe(0);
    // a newer needs-changes that lists one file only revokes that file
    const g = repoProject();
    review(g, both, { name: 'older', agoMs: 120_000 });
    review(g, ['tests/users.test.ts'], { name: 'newer', agoMs: 30_000, verdict: 'needs-changes' });
    expect(await refused(g)).toEqual(['tests/users.test.ts']);
  });

  test('a record with verdict pass and an open high or medium finding does not cover its files; a low one does', async () => {
    for (const severity of ['high', 'medium']) {
      const f = repoProject();
      review(f, both, { findings: finding(severity) });
      expect([severity, await refused(f)]).toEqual([severity, both]);
    }
    const low = repoProject();
    review(low, both, { findings: finding('low') });
    expect((await run(low)).code).toBe(0);
  });

  test('a finding is fixed by a new review of the new content, not by an older pass: the older pass of the old content is stale', async () => {
    const f = repoProject();
    review(f, both, { name: 'first', agoMs: 120_000, findings: finding('high') });
    put(f, 'tests/users.test.ts', `${HELPER_TEST}// the fix\n`);
    review(f, both, { name: 'second', agoMs: 30_000 });
    expect((await run(f)).code).toBe(0);
  });

  test('a record with malformed findings never covers: not a list, or a list with an entry that is a high one', () => {
    const f = repoProject();
    review(f, both);
    expect(privacyGate(f.root, ON).ok).toBe(true);
    const p = join(f.root, '.claude', 'reviews', 'r1.json');
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    rec.findings = 'none';
    writeFileSync(p, JSON.stringify(rec));
    expect(privacyGate(f.root, ON).ok).toBe(false);
    rec.findings = [null, 7, { severity: 'high' }];
    writeFileSync(p, JSON.stringify(rec));
    expect(privacyGate(f.root, ON).ok).toBe(false);
  });
});

describe('the reviews of the repository top and of the project dir both count', () => {
  const both = [COMPOSE, 'tests/users.test.ts'];

  test('a review written in the project dir’s .claude/reviews (a subdirectory of the repository) is read; without it the run is refused', () => {
    const f = repoProject();
    const pkg = join(f.root, 'pkg');
    mkdirSync(pkg, { recursive: true });
    review(f, both, { base: pkg });
    // only the top's dir: nothing covers
    expect(privacyGate(f.root, ON).ok).toBe(false);
    // with the project dir: covered
    expect(privacyGate(f.root, ON, {}, pkg)).toEqual({ ok: true });
    // the project dir equal to the top (or a link to it) is read once, and a dir with no reviews adds nothing
    expect(privacyGate(f.root, ON, {}, f.root).ok).toBe(false);
    expect(privacyGate(f.root, ON, {}, join(f.root, 'other')).ok).toBe(false);
  });

  test('records of both dirs add up, and the newest of them decides', () => {
    const f = repoProject();
    const pkg = join(f.root, 'pkg');
    mkdirSync(pkg, { recursive: true });
    review(f, [COMPOSE], { name: 'top' });
    review(f, ['tests/users.test.ts'], { name: 'sub', base: pkg });
    expect(privacyGate(f.root, ON, {}, pkg)).toEqual({ ok: true });
    review(f, both, { name: 'newest', base: pkg, agoMs: 10_000, verdict: 'needs-changes' });
    review(f, both, { name: 'older', agoMs: 90_000 });
    expect(privacyGate(f.root, ON, {}, pkg).ok).toBe(false);
  });

  test('through the CLI from a subdirectory: the review-write location is read (the third review finding)', () => {
    const f = repoProject();
    const pkg = join(f.root, 'pkg');
    mkdirSync(pkg, { recursive: true });
    const spawn = (): { code: number; stdout: string } => {
      const r = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'lib', 'cli.ts'), 'sandbox-run', '--suite', 'unit'], {
        cwd: pkg,
        env: { ...process.env, GOODBOY_DOCKER_BIN: f.bin, FAKE_DOCKER_DIR: f.state, GOODBOY_REGISTRY_DIR: f.registry, CLAUDE_PROJECT_DIR: pkg, ...ON },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return { code: r.exitCode ?? -1, stdout: r.stdout.toString() };
    };
    const before = spawn();
    expect(before.code).toBe(1);
    expect(JSON.parse(before.stdout).stopped).toBe('privacy-review-missing');
    review(f, both, { base: pkg });
    const after = spawn();
    expect([after.code, JSON.parse(after.stdout).stopped]).toEqual([0, undefined]);
  });
});

describe('what the setup holds', () => {
  test('a script that is no test and uses the helper is part of the setup, and is refused until reviewed', async () => {
    const f = repoProject();
    put(f, 'scripts/leak.ts', `import { pick } from '../.goodboy/sandbox/data/goodboy-data';\nexport const p = pick;\n`);
    put(f, 'scripts/plain.ts', 'export const a = 1;\n');
    review(f, [COMPOSE, 'tests/users.test.ts']);
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(r.out.files).toEqual(['scripts/leak.ts']);
    review(f, ['scripts/leak.ts'], { name: 'script' });
    expect((await run(f)).code).toBe(0);
  });
});
