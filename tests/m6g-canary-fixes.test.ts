// M6g (track M, #19): the fixes after the M6 canary step (2026-11-18). A real-data run asks no review for a sandbox file
// whose bytes are exactly goodboy's render (the gate re-renders; no file the model can write is proof), goodboy's own
// record files are no privacy file, and the refusal tells "no review" from "a review that does not clear" and says when it
// could not re-render.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isGoodboyRecord, isPrivacyPath, privacyFilesOf, privacySetupOf } from '../lib/privacy-files';
import { workTreeState } from '../lib/push-test';
import { SANDBOX_DIR } from '../lib/sandbox-mode';
import { privacyGate, RENDER_SCAN_BUDGET_MS, renderedUnchanged } from '../lib/sandbox-privacy-gate';
import { sha } from '../lib/sandbox-proof';
import { planSandbox } from '../lib/sandbox-render';
import { SCAN_BUDGET_MS, scanSandbox } from '../lib/sandbox-scan';
import { cleanupFakeProjects, type FakeProject, fakeProject } from './m6a-project';

setDefaultTimeout(120_000);
afterEach(cleanupFakeProjects);

const ON = { GOODBOY_SANDBOX_PRIVACY_GATE: 'on' };
const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const HELPER_TEST = `import { pick } from '../.goodboy/sandbox/data/goodboy-data';\nexport const u = pick;\n`;
const PW = `${SANDBOX_DIR}/e2e/playwright.config.ts`;
const COMPOSE = `${SANDBOX_DIR}/compose.yml`;
const MANIFEST = `${SANDBOX_DIR}/data.json`;
const USERS = 'tests/users.test.ts';
const CANARY = 'CANARY-김민수-900101-1234567';

function put(f: FakeProject, rel: string, text: string): void {
  mkdirSync(dirname(join(f.root, rel)), { recursive: true });
  writeFileSync(join(f.root, rel), text);
}

/** A real-data project, a git repository, whose sandbox dir holds goodboy's whole render (what `sandbox-init` writes). */
function renderedProject(): FakeProject {
  const f = fakeProject(REAL);
  // a small Spring + Postgres project the scanner reads (the gate scans afresh, so the files must scan to what is rendered)
  put(f, 'build.gradle', "plugins { id 'org.springframework.boot' version '3.2.0' }\ndependencies {\n  runtimeOnly 'org.postgresql:postgresql'\n}\n");
  put(f, 'gradlew', '');
  put(f, 'src/main/resources/application.yml', 'server:\n  port: 8080\nspring:\n  datasource:\n    url: jdbc:postgresql://localhost:5432/shop\n');
  expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: f.root }).exitCode).toBe(0);
  // what `sandbox-scan` and `sandbox-init` write: the scan, and the render of it
  const scan = scanSandbox(f.root);
  expect(scan.problems).toEqual([]);
  put(f, `${SANDBOX_DIR}/scan.json`, `${JSON.stringify({ ...scan, root: '.' }, null, 2)}\n`);
  f.ctx.plan = planSandbox(scan, { dump: null, dumpFormat: null, realData: true }, { root: f.root });
  for (const [rel, text] of f.ctx.plan.files) put(f, `${SANDBOX_DIR}/${rel}`, text);
  // the fake docker answers for the compose file of this project
  writeFileSync(join(f.state, 'config.json'), JSON.stringify(Bun.YAML.parse(f.ctx.plan.files.get('compose.yml')!)));
  return f;
}

/** A review record as `review-write` stores one, written straight into the reviews dir. */
function review(f: FakeProject, rels: string[], o: { name?: string; verdict?: string; findings?: { file: string; severity: string; issue: string; probe?: string }[]; agoMs?: number } = {}): void {
  const dir = join(f.root, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${o.name ?? 'r1'}.json`),
    JSON.stringify({
      timestamp: new Date(Date.now() - (o.agoMs ?? 60_000)).toISOString(),
      reviewed_files: rels.map((r) => join(f.root, r)),
      category: 'add-feature',
      findings: o.findings ?? [],
      unknown_assumptions_checked: [],
      verdict: o.verdict ?? 'pass',
      dimensions_checked: ['data-privacy'],
      tree: workTreeState(f.root).tree,
    }),
  );
}

/** The layout files the gate lists for a rendered project. */
const layoutOf = (f: FakeProject): string[] => [...f.ctx.plan.files.keys()].map((k) => `${SANDBOX_DIR}/${k}`).filter((k) => isPrivacyPath(k));

const run = (f: FakeProject) => f.inproc('sandbox-run', ['--suite', 'unit'], ON);
const gate = (f: FakeProject) => privacyGate(f.root, ON);

describe('A: a file that is exactly goodboy’s render is not asked for', () => {
  test('the whole rendered layout, unchanged: the gate lets the run go on with no review at all', async () => {
    const f = renderedProject();
    expect(renderedUnchanged(f.root)).toEqual({ files: new Set([...f.ctx.plan.files.keys()].map((k) => `${SANDBOX_DIR}/${k}`)), failure: null });
    expect(gate(f)).toEqual({ ok: true });
    const r = await run(f);
    expect(r.out.stopped).toBeUndefined();
    expect(r.code).toBe(0);
  });

  test('one byte changed in a rendered file: that file needs a review, the rest stay exempt', async () => {
    const f = renderedProject();
    put(f, PW, `${f.ctx.plan.files.get('e2e/playwright.config.ts')!} `);
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe('privacy-review-missing');
      expect(g.files).toEqual([PW]);
    }
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(r.out.files).toEqual([PW]);
    // a review of the changed content covers it
    review(f, [PW]);
    expect(gate(f)).toEqual({ ok: true });
  });

  test('a rendered file that was replaced by its own render again is exempt again', () => {
    const f = renderedProject();
    const text = f.ctx.plan.files.get('compose.yml')!;
    put(f, `${SANDBOX_DIR}/compose.yml`, `${text}# edited\n`);
    expect(gate(f).ok).toBe(false);
    put(f, `${SANDBOX_DIR}/compose.yml`, text);
    expect(gate(f)).toEqual({ ok: true });
  });

  test('a forged `.written.json` is no proof: a changed file stays asked, whichever hash the ledger holds', () => {
    const f = renderedProject();
    const changed = `${f.ctx.plan.files.get('e2e/playwright.config.ts')!}\n// network access\n`;
    put(f, PW, changed);
    for (const hash of [sha(changed), sha(f.ctx.plan.files.get('e2e/playwright.config.ts')!)]) {
      put(f, `${SANDBOX_DIR}/.written.json`, JSON.stringify({ schema: 1, files: { 'e2e/playwright.config.ts': hash } }));
      const g = gate(f);
      expect(g.ok).toBe(false);
      if (!g.ok) expect(g.files).toEqual([PW]);
    }
  });

  test('data.json and a source file that uses the helper still need a review, though the layout is exempt', async () => {
    const f = renderedProject();
    put(f, MANIFEST, '{}\n');
    put(f, USERS, HELPER_TEST);
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.files).toEqual([MANIFEST, USERS]);
    const r = await run(f);
    expect(r.out.files).toEqual([MANIFEST, USERS]);
    review(f, [MANIFEST, USERS]);
    expect(gate(f)).toEqual({ ok: true });
  });

  test('a layout file the render does not make for this scan is asked (it is nobody’s render)', () => {
    const f = renderedProject();
    const extra = `${SANDBOX_DIR}/runtime/coveragerc`;
    expect(f.ctx.plan.files.has('runtime/coveragerc')).toBe(false);
    put(f, extra, '[run]\n');
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.files).toEqual([extra]);
  });

  test('a hand-edited scan.json is no proof: files rendered from it differ from the fresh render and are asked', async () => {
    const f = renderedProject();
    const edited = JSON.parse(readFileSync(join(f.root, SANDBOX_DIR, 'scan.json'), 'utf8'));
    // a command added to the app service, then `sandbox-init --force` writes the render of that scan
    edited.build.startCommand = [...edited.build.startCommand, '--spring.profiles.active=evil'];
    put(f, `${SANDBOX_DIR}/scan.json`, `${JSON.stringify(edited, null, 2)}\n`);
    const fresh = f.ctx.plan.files;
    const forged = planSandbox(edited, { dump: null, dumpFormat: null, realData: true }, { root: f.root }).files;
    const differing = [...forged.keys()].filter((k) => forged.get(k) !== fresh.get(k)).map((k) => `${SANDBOX_DIR}/${k}`);
    expect(differing).toContain(COMPOSE);
    for (const [rel, text] of forged) put(f, `${SANDBOX_DIR}/${rel}`, text);
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe('privacy-review-missing');
      expect(g.files).toEqual([...differing].sort());
    }
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(r.out.files).toEqual([...differing].sort());
    // a review of that content covers it
    review(f, differing);
    expect(gate(f)).toEqual({ ok: true });
  });

  test('the scan.json is not read: editing it alone leaves goodboy’s unchanged files exempt, and a broken one changes nothing', () => {
    const f = renderedProject();
    put(f, `${SANDBOX_DIR}/scan.json`, 'not json');
    expect(renderedUnchanged(f.root).files.size).toBe(f.ctx.plan.files.size);
    expect(gate(f)).toEqual({ ok: true });
  });

  test('a project that changed since its sandbox was rendered renders differently now: its files are asked', () => {
    const f = renderedProject();
    put(f, 'src/main/resources/application.yml', 'server:\n  port: 9090\nspring:\n  datasource:\n    url: jdbc:postgresql://localhost:5432/shop\n');
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.files.length).toBeGreaterThan(0);
  });

  test('fail closed: a scan that throws, has problems or is too slow, a local file that cannot be read, a render that throws, a link: nothing is exempt, and it says why', () => {
    const f = renderedProject();
    const all = layoutOf(f);
    // the scan throws
    const boom = (): never => {
      throw new Error('scan failed');
    };
    expect(renderedUnchanged(f.root, boom)).toEqual({ files: new Set(), failure: 'scan-threw' });
    const g = privacyGate(f.root, ON, { rendered: (root) => renderedUnchanged(root, boom) });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.files).toEqual([...all].sort());
    // the scan has problems (here: not a git repository), which makes it unusable
    rmSync(join(f.root, '.git'), { recursive: true, force: true });
    expect(scanSandbox(f.root).problems.length).toBeGreaterThan(0);
    expect(renderedUnchanged(f.root)).toEqual({ files: new Set(), failure: 'scan-problems' });
    // the scan ran past its time bound (the clock jumps while it runs); the bound is the scanner's own budget
    const g2 = renderedProject();
    const realNow = Date.now;
    let asked: number | undefined;
    try {
      const slow = (root: string, o?: Parameters<typeof scanSandbox>[1]) => {
        asked = o?.budgetMs;
        const t = realNow();
        Date.now = () => t + RENDER_SCAN_BUDGET_MS + 1;
        return scanSandbox(root, o);
      };
      expect(renderedUnchanged(g2.root, slow)).toEqual({ files: new Set(), failure: 'scan-slow' });
    } finally {
      Date.now = realNow;
    }
    expect(asked).toBe(SCAN_BUDGET_MS);
    expect(RENDER_SCAN_BUDGET_MS).toBe(SCAN_BUDGET_MS);
    expect(renderedUnchanged(g2.root).files.size).toBe(g2.ctx.plan.files.size);

    const h = renderedProject();
    put(h, `${SANDBOX_DIR}/local.json`, 'not json');
    expect(renderedUnchanged(h.root)).toEqual({ files: new Set(), failure: 'local-unreadable' });

    const k = renderedProject();
    const throwing = privacyGate(k.root, ON, {
      rendered: () => {
        throw new Error('boom');
      },
    });
    expect(throwing.ok).toBe(false);

    // a file that is a link to a copy with the render's exact bytes is no regular file of the render
    const l = renderedProject();
    const rel = 'compose.yml';
    rmSync(join(l.root, SANDBOX_DIR, rel));
    put(l, `${SANDBOX_DIR}/copy.yml.txt`, l.ctx.plan.files.get(rel)!);
    symlinkSync(join(l.root, SANDBOX_DIR, 'copy.yml.txt'), join(l.root, SANDBOX_DIR, rel));
    expect(renderedUnchanged(l.root).files.has(`${SANDBOX_DIR}/compose.yml`)).toBe(false);
  });

  test('the refusal says in fixed words that goodboy could not re-render, for each cause', () => {
    const causes = {
      'scan-threw': 'the project scan failed',
      'scan-problems': 'the project scan reports problems',
      'scan-slow': 'the project scan did not finish within its time budget',
      'local-unreadable': 'the local answers file of the sandbox cannot be read',
      'render-failed': 'the render failed',
    } as const;
    for (const [failure, words] of Object.entries(causes)) {
      const f = renderedProject();
      const g = privacyGate(f.root, ON, { rendered: () => ({ files: new Set<string>(), failure: failure as keyof typeof causes }) });
      expect(g.ok).toBe(false);
      if (!g.ok) {
        expect(g.reason).toContain(`goodboy could not re-render its sandbox files (${words}`);
        expect(g.reason).toContain('count as unreviewed even when goodboy wrote them');
        expect(g.reason).toContain('Fix that cause and run sandbox-run again, or have those files reviewed.');
        expect(g.reason).not.toContain(f.root);
      }
    }
    // a render that throws inside the reader reads as a failed render
    const t = renderedProject();
    const g = privacyGate(t.root, ON, {
      rendered: () => {
        throw new Error('x');
      },
    });
    expect(!g.ok && g.reason).toContain('(the render failed)');
    // no sentence when the render worked, or when no file below the sandbox dir is asked
    const ok = renderedProject();
    put(ok, `${SANDBOX_DIR}/data.json`, '{}\n');
    const asked = privacyGate(ok.root, ON);
    expect(!asked.ok && asked.reason).not.toContain('could not re-render');
    const only = renderedProject();
    put(only, USERS, HELPER_TEST);
    review(only, layoutOf(only));
    const g3 = privacyGate(only.root, ON, { rendered: () => ({ files: new Set<string>(), failure: 'scan-threw' }) });
    expect(!g3.ok && g3.reason).not.toContain('could not re-render');
  });

  test('the re-render runs only when an uncovered file lies below the sandbox dir', () => {
    let calls = 0;
    const spy = (root: string) => {
      calls++;
      return renderedUnchanged(root);
    };
    // everything covered by reviews: no re-render, even though the layout is not exempt
    const covered = renderedProject();
    put(covered, `${SANDBOX_DIR}/compose.yml`, '# not goodboy’s\n');
    review(covered, layoutOf(covered));
    expect(privacyGate(covered.root, ON, { rendered: spy })).toEqual({ ok: true });
    expect(calls).toBe(0);
    // only a source file is asked: no re-render
    const src = renderedProject();
    put(src, USERS, HELPER_TEST);
    review(src, layoutOf(src));
    const a = privacyGate(src.root, ON, { rendered: spy });
    expect(!a.ok && a.files).toEqual([USERS]);
    expect(calls).toBe(0);
    // a sandbox file is asked: one re-render, and the answer is the one with it
    const sb = renderedProject();
    review(sb, layoutOf(sb));
    put(sb, PW, 'changed\n');
    const b = privacyGate(sb.root, ON, { rendered: spy });
    expect(!b.ok && b.files).toEqual([PW]);
    expect(calls).toBe(1);
  });
});

describe('B: goodboy’s record files are no privacy file; nothing else of `.claude/` is excluded', () => {
  const RECORD = JSON.stringify({ reviewed_files: ['/p/.goodboy/sandbox/data/goodboy-data.ts', '/p/.goodboy/sandbox/compose.yml'], note: 'GOODBOY_DATA GoodboyData' });
  const RECORDS = ['.claude/reviews/2026-11-18T01-27-44.389Z.json', '.claude/tests/r.json', '.claude/tests/regression/r.json', 'sub/.claude/reviews/r.json'];

  test('a review record that names helper paths is none: the Stop’s predicate and the setup listing', () => {
    const f = renderedProject();
    for (const rel of RECORDS) put(f, rel, RECORD);
    // the Stop review gate (privacyFilesOf) and review-axes
    expect([...privacyFilesOf(f.root, RECORDS)]).toEqual([]);
    expect([...privacyFilesOf(f.root, [join(f.root, RECORDS[0]!)], '/elsewhere')]).toEqual([]);
    // the run gate's listing (privacySetupOf) and the gate itself
    const setup = privacySetupOf(f.root);
    expect(setup.ok).toBe(true);
    if (setup.ok) expect(setup.files.filter((x) => x.includes('.claude/'))).toEqual([]);
    expect(gate(f)).toEqual({ ok: true });
  });

  test('a test or script below `.claude/` that names the helper IS a privacy file: the Stop’s predicate and the run gate', async () => {
    const f = renderedProject();
    const own = ['.claude/x.test.ts', '.claude/scripts/a.js', '.claude/reviews/helper.ts', '.claude/reviews/sub/r.json', '.claude/settings.json', '.claude/tests/regression/deep/r.json'];
    put(f, own[0]!, HELPER_TEST);
    put(f, own[1]!, `require('../../.goodboy/sandbox/data/goodboy-data.cjs');\n`);
    put(f, own[2]!, HELPER_TEST);
    put(f, own[3]!, RECORD);
    put(f, own[4]!, RECORD);
    put(f, own[5]!, RECORD);
    expect([...privacyFilesOf(f.root, own)].sort()).toEqual([...own].sort());
    const setup = privacySetupOf(f.root);
    expect(setup.ok && setup.files.filter((x) => x.startsWith('.claude/'))).toEqual([...own].sort());
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.files).toEqual([...own].sort());
    const r = await run(f);
    expect(r.out.files).toEqual([...own].sort());
  });

  test('the same text anywhere else is a privacy file (the check was catching it by its text)', () => {
    const f = renderedProject();
    put(f, 'notes/review-copy.json', RECORD);
    expect([...privacyFilesOf(f.root, ['notes/review-copy.json'])]).toEqual(['notes/review-copy.json']);
    const setup = privacySetupOf(f.root);
    expect(setup.ok && setup.files.includes('notes/review-copy.json')).toBe(true);
  });

  test('isGoodboyRecord: a `.json` directly in a record dir, at any depth of the tree; isPrivacyPath leaves a helper copy there alone', () => {
    for (const rel of RECORDS) expect([rel, isGoodboyRecord(rel)]).toEqual([rel, true]);
    for (const rel of ['.claude', '.claude/settings.json', '.claude/reviews/a.ts', '.claude/reviews/sub/a.json', '.claude/tests/regression/x/a.json', '.claudex/reviews/a.json', 'x.claude/reviews/a.json', '.claude/pending/a.json']) {
      expect([rel, isGoodboyRecord(rel)]).toEqual([rel, false]);
    }
    expect(isPrivacyPath('.claude/tests/goodboy-data.json')).toBe(false);
    expect(isPrivacyPath('.claude/tests/goodboy-data.ts')).toBe(true);
    expect(isPrivacyPath('tests/goodboy-data.ts')).toBe(true);
  });

  test('a review the run gate reads does not add its own record to the setup: write a review, run again', async () => {
    const f = renderedProject();
    put(f, USERS, HELPER_TEST);
    review(f, [USERS, `${SANDBOX_DIR}/data/goodboy-data.ts`]);
    // the record names the helper's dir and does not change the setup the gate lists
    expect((await run(f)).code).toBe(0);
  });
});

describe('C: the refusal tells "no review" from "a review that does not clear"', () => {
  const finding = (file: string, severity: string) => ({ file: join('/x', file), severity, issue: `a ${CANARY} finding`, probe: 'x' });

  function twoFiles(): FakeProject {
    const f = renderedProject();
    put(f, USERS, HELPER_TEST);
    put(f, MANIFEST, '{}\n');
    return f;
  }

  test('no review at all: one group, "no data-privacy review"', async () => {
    const f = twoFiles();
    const r = await run(f);
    expect(r.out.stopped).toBe('privacy-review-missing');
    expect(r.out.reason).toContain(`2 file(s) have no data-privacy review of their current content: ${MANIFEST}, ${USERS}.`);
    expect(r.out.reason).not.toContain('does not clear');
  });

  test('a review with a high or medium finding: its own group, with what to do; not "no review"', async () => {
    for (const severity of ['high', 'medium']) {
      const f = twoFiles();
      review(f, [USERS], { name: 'a' });
      review(f, [MANIFEST], { name: 'b', verdict: 'needs-changes', findings: [finding('data.json', severity)] });
      const r = await run(f);
      expect(r.out.stopped).toBe('privacy-review-missing');
      expect(r.out.files).toEqual([MANIFEST]);
      const reason = r.out.reason as string;
      expect([severity, reason.includes('no data-privacy review')]).toEqual([severity, false]);
      expect(reason).toContain(`1 file(s) have a data-privacy review of their current content that does not clear them`);
      expect(reason).toContain('high or medium finding');
      expect(reason).toContain(`${MANIFEST}.`);
      expect(reason).toContain('Fix the finding in the file, or answer it, and review the file again');
      // fixed text, no file content and no finding text
      expect(reason).not.toContain('CANARY');
      expect(reason).not.toContain(f.root);
    }
  });

  test('a passing record that still holds a medium finding does not clear either', () => {
    const f = twoFiles();
    review(f, [USERS, MANIFEST], { findings: [finding('tests/users.test.ts', 'medium')] });
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.files).toEqual([MANIFEST, USERS]);
      expect(g.reason).not.toContain('no data-privacy review');
      expect(g.reason).toContain('2 file(s) have a data-privacy review');
    }
  });

  test('both groups at once, and a low finding clears', () => {
    const f = twoFiles();
    review(f, [MANIFEST], { verdict: 'needs-changes', findings: [finding('data.json', 'high')] });
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.files).toEqual([USERS, MANIFEST]);
      expect(g.reason).toContain(`1 file(s) have no data-privacy review of their current content: ${USERS}.`);
      expect(g.reason).toContain(`1 file(s) have a data-privacy review of their current content that does not clear them`);
      expect(g.reason).toContain('axis: data-privacy');
      expect(g.reason).toContain('The user can turn this check off in their settings.');
    }
    const low = twoFiles();
    review(low, [USERS, MANIFEST], { findings: [finding('data.json', 'low')] });
    expect(gate(low)).toEqual({ ok: true });
  });

  test('a newest review with verdict fail is a review that does not clear, not a missing one', () => {
    const f = twoFiles();
    review(f, [USERS, MANIFEST], { verdict: 'fail' });
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).not.toContain('no data-privacy review');
      expect(g.reason).toContain('2 file(s) have a data-privacy review');
    }
  });

  test('the groups are cut at twenty each', () => {
    const f = renderedProject();
    for (let i = 0; i < 22; i++) put(f, `tests/more${i}.test.ts`, HELPER_TEST);
    const g = gate(f);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.files).toHaveLength(22);
      expect(g.reason).toContain('22 file(s) have no data-privacy review');
      expect(g.reason).toContain('and 2 more');
    }
  });
});

describe('the two guards of renderedUnchanged that need a broken input', () => {
  test('a local file that cannot even be looked up (a root that is no path) is local-unreadable, and nothing is exempt', () => {
    expect(renderedUnchanged(42 as unknown as string)).toEqual({ files: new Set(), failure: 'local-unreadable' });
  });

  test('a scan the renderer cannot use (a render that throws) exempts nothing and is render-failed', () => {
    const f = renderedProject();
    const broken = (): ReturnType<typeof scanSandbox> => ({ problems: [] }) as unknown as ReturnType<typeof scanSandbox>;
    expect(renderedUnchanged(f.root, broken)).toEqual({ files: new Set(), failure: 'render-failed' });
    // through the gate: the same failure is named in the refusal and every layout file is asked
    const g = privacyGate(f.root, ON, { rendered: (root) => renderedUnchanged(root, broken) });
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toContain('(the render failed)');
      expect(g.files).toEqual([...layoutOf(f)].sort());
    }
  });
});
