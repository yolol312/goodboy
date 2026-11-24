// N-track quick fixes (plan §20.9), each through the real boundary where one exists:
//   N2  the push check names a pattern that passes without checking anything by file, line and key;
//   N3  a tests-role agent may remove the testkit harness's `.testkit-run/` (only where the marker is a real file);
//   N5  server templates (JSP, FreeMarker, ...) are UI files: the test-type rule asks for a `ui` suite, a review
//       needs the UI dimensions;
//   N7  the file tools (Read, Edit, Write) collapse `..` by name before opening, so their recorders and lookups
//       use the lexical path (`fileToolPath`); a shell command's paths keep the opened one (`openedPath`).
// Repos are temporary, git runs for real, and the PreToolUse hook is spawned as a process.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { fileToolPath, openedPath } from '../lib/file-tracker';
import { checkHandoff } from '../lib/push-test';
import { isFrontendFile, requiredDimensionsFor, SERVER_TEMPLATE_EXTS, UI_FILE_EXT } from '../lib/review-dimensions';
import { isTestkitRunPath, writeDenial } from '../lib/role-limits';
import { roleOf } from '../lib/routing-policy';
import { surveyProject } from '../lib/test-survey';
import { typeNeedOf } from '../lib/test-types';
import type { TestResult } from '../lib/types';
import { denialOf, newSession, recordedFiles, runHook, spell } from './hook-run';

const ROOT = resolve(import.meta.dir, '..');
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-nq-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: GIT_ENV });
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

/** A committed repo of `files`. */
function repo(files: Record<string, string>): string {
  const d = tmp();
  for (const [p, t] of Object.entries({ 'src/a.ts': 'export const a = 1;\n', ...files })) write(d, p, t);
  sh(d, `${GIT_INIT} && git add -A && git commit -q -m init`);
  return d;
}

const session = (): string => newSession('nq', dirs);
/** A PreToolUse call with the tool call (and agent) of `payload`: whether it was denied, and why. */
async function pre(cwd: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ denied: boolean; reason: string }> {
  return denialOf(await runHook('hooks/pre-tool-use.ts', cwd, session(), { hook_event_name: 'PreToolUse', ...payload }, env));
}

// ── N2 ──────────────────────────────────────────────────────────────────────────────────────────────

describe('N2: the push check names the pattern that passes without checking anything', () => {
  const RED_GREEN = [
    {
      id: 'AC-1',
      description: 'a is 1',
      test: 'a.test.ts',
      red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
      green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
    },
  ];
  /** A repo whose test files hold the given texts (no remote: the whole files are scanned). */
  function world(tests: Record<string, string>) {
    const d = repo(Object.fromEntries(Object.entries(tests).map(([n, t]) => [`tests/${n}`, t])));
    const files = Object.keys(tests).map((n) => join(d, 'tests', n));
    const tree = sh(d, 'git rev-parse HEAD^{tree}');
    const record = {
      timestamp: '2026-11-05T00:00:00.000Z',
      tested_files: [],
      category: 'fix-bug',
      test_files: files,
      environment: { mode: 'none' },
      suites: [{ name: 'u', command: 'bun test', passed: 3, failed: 0, output: '' }],
      acceptance: RED_GREEN,
      verdict: 'pass',
      tree,
    } as unknown as TestResult;
    const handoff = { kind: 'push' as const, what: 'git push origin main', cwd: d, revs: ['HEAD'] };
    return { d, files, check: () => checkHandoff(handoff, [record]) };
  }
  const WHY = 'a test file holds a pattern that passes without checking anything: ';
  const clean = 'test("a", () => { expect(1).toBe(1); });\n';

  test('a record whose test files hold none is accepted', () => {
    expect(world({ 'a.test.ts': clean }).check()).toEqual({ ok: true });
  });

  test('one hit: the file, the line and the pattern key', () => {
    const w = world({ 'a.test.ts': `${clean}\ntest.skip("later", () => {});\n` });
    expect(w.check()).toMatchObject({ ok: false, why: 'no-result', rejected: `${WHY}${w.files[0]}:3 (skipped-test)` });
  });

  test('two patterns in one file are two hits, each at its own line', () => {
    const w = world({ 'a.test.ts': `${clean}test("t", async () => { await page.waitForTimeout(10); expect(true).toBe(true); });\n` });
    expect(w.check()).toMatchObject({ rejected: `${WHY}${w.files[0]}:2 (wait-timeout), ${w.files[0]}:2 (always-true-defined)` });
  });

  test('exactly three hits are all named, with no `and N more`', () => {
    const w = world({ 'a.test.ts': `${clean}test.skip("1", () => {});\n`, 'b.test.ts': `${clean}test.todo("2");\n`, 'c.test.ts': `${clean}expect(0).toBeGreaterThanOrEqual(0);\n` });
    const out = w.check() as { rejected: string };
    expect(out.rejected).toBe(`${WHY}${w.files[0]}:2 (skipped-test), ${w.files[1]}:2 (skipped-test), ${w.files[2]}:2 (always-true-count)`);
    expect(out.rejected).not.toContain('more');
  });

  test('more than three: the first three, then `and N more`', () => {
    const t = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`t${i}.test.ts`, `${clean}test.skip("${i}", () => {});\n`]));
    const w = world(t);
    const out = w.check() as { ok: boolean; rejected: string };
    expect(out.ok).toBe(false);
    expect(out.rejected).toBe(`${WHY}${w.files.slice(0, 3).map((f) => `${f}:2 (skipped-test)`).join(', ')} and 2 more`);
    // four hits: and 1 more
    const four = world(Object.fromEntries([1, 2, 3, 4].map((i) => [`t${i}.test.ts`, `${clean}test.skip("${i}", () => {});\n`])));
    expect((four.check() as { rejected: string }).rejected.endsWith(' and 1 more')).toBe(true);
  });

  test('a pattern inside a string or a comment is no hit', () => {
    const w = world({ 'a.test.ts': `${clean}// test.skip("x")\nconst s = "waitForTimeout(1)";\n` });
    expect(w.check()).toEqual({ ok: true });
  });
});

// ── N3 ──────────────────────────────────────────────────────────────────────────────────────────────

describe('N3: a tests-role agent may remove the testkit run output', () => {
  const tester = roleOf('test-unit')!;
  const CONFIG = '{"name":"kit"}\n';
  /** A project whose `.testkit-run/` holds a file. `marker`: true adds testkit/testkit.config.json as a real file,
   *  'link' makes it a symlink to conf/real.json, false leaves it out. */
  function project(marker: boolean | 'link'): string {
    const d = repo({ '.testkit-run/capture/x.json': '{}\n', 'tests/t.test.ts': 'test("t", () => {});\n', ...(marker === true ? { 'testkit/testkit.config.json': CONFIG } : {}) });
    if (marker === 'link') {
      write(d, 'conf/real.json', CONFIG);
      mkdirSync(join(d, 'testkit'));
      symlinkSync(join(d, 'conf', 'real.json'), join(d, 'testkit', 'testkit.config.json'));
    }
    return d;
  }

  test('isTestkitRunPath: the dir and what is in it, at the top, with the marker', () => {
    const d = project(true);
    for (const rel of ['.testkit-run', '.testkit-run/capture', '.testkit-run/capture/x.json', '.testkit-run/new/dir']) expect([rel, isTestkitRunPath(rel, d)]).toEqual([rel, true]);
    for (const rel of ['sub/.testkit-run', 'sub/.testkit-run/x', '.testkit-runner', '.testkit-run2/x', 'x/.testkit-run', 'testkit', 'src/a.ts', '', '.testkit-run/../src/a.ts', '.testkit-run/..', '.testkit-run/a/../../src/a.ts'])
      expect([rel, isTestkitRunPath(rel, d)]).toEqual([rel, false]);
  });

  test('isTestkitRunPath: no marker, a marker that is a link, a testkit/ that is a link, a marker that is a dir', () => {
    expect(isTestkitRunPath('.testkit-run/x', project(false))).toBe(false);

    expect(isTestkitRunPath('.testkit-run/x', project('link'))).toBe(false);

    const linkedDir = project(false);
    write(linkedDir, 'elsewhere/testkit.config.json', CONFIG);
    symlinkSync(join(linkedDir, 'elsewhere'), join(linkedDir, 'testkit'));
    expect(isTestkitRunPath('.testkit-run/x', linkedDir)).toBe(false);

    const dirMarker = project(false);
    mkdirSync(join(dirMarker, 'testkit', 'testkit.config.json'), { recursive: true });
    expect(isTestkitRunPath('.testkit-run/x', dirMarker)).toBe(false);
  });

  test('writeDenial: a removal is allowed with the marker, denied without it', () => {
    const withMarker = project(true);
    for (const rel of ['.testkit-run', '.testkit-run/capture', '.testkit-run/capture/x.json']) expect([rel, writeDenial(tester, join(withMarker, rel), withMarker, { removal: true })]).toEqual([rel, null]);
    const without = project(false);
    expect(writeDenial(tester, join(without, '.testkit-run/capture'), without, { removal: true })).toContain('test files only');
  });

  test('writeDenial: writing, copying or creating there is not a removal and stays denied', () => {
    const d = project(true);
    expect(writeDenial(tester, join(d, '.testkit-run/capture/y.json'), d)).toContain('test files only');
    expect(writeDenial(tester, join(d, '.testkit-run/capture/y.json'), d, {})).toContain('test files only');
    expect(writeDenial(tester, join(d, '.testkit-run/capture/y.json'), d, { removal: false })).toContain('test files only');
  });

  test('writeDenial: removing under sub/.testkit-run, a path with `..`, an expanded operand, or src stays denied', () => {
    const d = project(true);
    write(d, 'sub/.testkit-run/x', 'x');
    expect(writeDenial(tester, join(d, 'sub/.testkit-run/x'), d, { removal: true })).toContain('test files only');
    expect(writeDenial(tester, `${d}/.testkit-run/../src/a.ts`, d, { removal: true })).toContain('test files only');
    expect(writeDenial(tester, join(d, '.testkit-run/capture'), d, { removal: true, expanded: true })).toContain('may not remove by a pattern, variable or `..` path');
    expect(writeDenial(tester, join(d, 'src/a.ts'), d, { removal: true })).toContain('test files only');
  });

  test('writeDenial: a link at .testkit-run, or below it, takes the allowance away', () => {
    const top = project(true);
    rmSync(join(top, '.testkit-run'), { recursive: true });
    write(top, 'real-run/x.json', '{}');
    symlinkSync(join(top, 'real-run'), join(top, '.testkit-run'));
    expect(writeDenial(tester, join(top, '.testkit-run'), top, { removal: true })).toContain('test files only');
    expect(writeDenial(tester, join(top, '.testkit-run/x.json'), top, { removal: true })).toContain('test files only');

    const below = project(true);
    write(below, 'elsewhere/y.json', '{}');
    symlinkSync(join(below, 'elsewhere'), join(below, '.testkit-run/lnk'));
    expect(writeDenial(tester, join(below, '.testkit-run/lnk'), below, { removal: true })).toContain('test files only');
    expect(writeDenial(tester, join(below, '.testkit-run/lnk/y.json'), below, { removal: true })).toContain('test files only');
    // the sibling that is no link is still allowed
    expect(writeDenial(tester, join(below, '.testkit-run/capture/x.json'), below, { removal: true })).toBeNull();
  });

  test('writeDenial: a marker that is a link denies even with .testkit-run real', () => {
    const d = project('link');
    expect(writeDenial(tester, join(d, '.testkit-run/capture'), d, { removal: true })).toContain('test files only');
  });

  test('only the tests role: a docs agent may not remove it', () => {
    const d = project(true);
    expect(writeDenial(roleOf('build-docs')!, join(d, '.testkit-run/capture'), d, { removal: true })).not.toBeNull();
  });

  test('the PreToolUse hook: a test-unit agent`s `rm -rf .testkit-run/x` passes with the marker and is denied without it', async () => {
    const withMarker = project(true);
    const run = (d: string, command: string) => pre(d, { tool_name: 'Bash', agent_type: 'goodboy:test-unit', agent_id: 'x1', tool_input: { command } });
    for (const c of ['rm -rf .testkit-run/capture', 'rm -rf .testkit-run', 'rm -rf .testkit-run/capture/x.json']) {
      const r = await run(withMarker, c);
      expect([c, r.denied, r.reason]).toEqual([c, false, '']);
    }
    const without = project(false);
    const denied = await run(without, 'rm -rf .testkit-run/capture');
    expect(denied.denied).toBe(true);
    expect(denied.reason).toContain('test files only');
    // writing into it is denied even with the marker
    const wrote = await run(withMarker, 'touch .testkit-run/capture/y.json');
    expect(wrote.denied).toBe(true);
    // a `..` operand is an expanded one: denied
    expect((await run(withMarker, 'rm -rf .testkit-run/../src/a.ts')).denied).toBe(true);
    // a symlinked marker: denied
    expect((await run(project('link'), 'rm -rf .testkit-run/capture')).denied).toBe(true);
  });
});

// ── N5 ──────────────────────────────────────────────────────────────────────────────────────────────

describe('N5: server templates are UI files', () => {
  const TEMPLATES = ['jsp', 'jspx', 'jspf', 'tag', 'xhtml', 'ftl', 'ftlh', 'vm', 'mustache', 'hbs', 'handlebars', 'ejs', 'pug', 'erb', 'twig', 'njk'];
  const OLD_UI = ['html', 'htm', 'css', 'scss', 'sass', 'less', 'jsx', 'tsx', 'vue', 'svelte'];

  test('UI_FILE_EXT and isFrontendFile: every template and the old UI extensions; Java, XML and neighbors are not', () => {
    for (const e of [...TEMPLATES, ...OLD_UI]) {
      expect([e, UI_FILE_EXT.test(`src/x.${e}`), isFrontendFile(`src/x.${e}`)]).toEqual([e, true, true]);
    }
    for (const rel of ['src/main/java/A.java', 'pom.xml', 'web.xml', 'src/x.jspa', 'src/x.jsp.bak', 'src/x.ftlx', 'src/x.tagx', 'src/x.vmx', 'src/x.ts', 'src/x.js', 'src/x.py', 'src/jsp', 'src/x.erb.rb']) {
      expect([rel, isFrontendFile(rel)]).toEqual([rel, false]);
    }
    // the client-side rule is the same as before
    expect(isFrontendFile('src/client/state.ts')).toBe(true);
    expect(isFrontendFile('src/a.client.ts')).toBe(true);
  });

  test('SERVER_TEMPLATE_EXTS is the list, and the UI file rule and the backfill survey are built from it', () => {
    expect([...SERVER_TEMPLATE_EXTS].sort()).toEqual([...TEMPLATES].sort());
    expect(SERVER_TEMPLATE_EXTS).not.toContain('html'); // html is in the UI rule on its own
    expect(SERVER_TEMPLATE_EXTS).not.toContain('j2'); // Jinja/Ansible templates are as often config as pages
    // the survey ranks an untested template of every extension as a ui target; a Java class is not one
    const d = repo({ 'pom.xml': '<project/>\n', 'src/main/java/a/Dao.java': 'class Dao {}\n', ...Object.fromEntries(TEMPLATES.map((e) => [`src/main/webapp/page.${e}`, 'hello\n'])) });
    const survey = surveyProject(d);
    const ui = survey.untested.targets.filter((t) => t.kind === 'ui').map((t) => t.rel);
    expect(ui.sort()).toEqual(TEMPLATES.map((e) => `src/main/webapp/page.${e}`).sort());
    expect(survey.code.ui).toBe(TEMPLATES.length);
    expect(survey.untested.targets.find((t) => t.rel.endsWith('Dao.java'))?.kind).not.toBe('ui');
  });

  test('the test-type rule asks `ui` for a template, and for nothing else of a Java project', () => {
    const d = tmp();
    const need = (rel: string) => typeNeedOf(write(d, rel, '<%@ page %>\n'), d, [])?.types ?? [];
    expect(need('src/main/webapp/WEB-INF/views/list.jsp')).toEqual(['ui']);
    for (const e of TEMPLATES) expect([e, need(`src/main/resources/templates/page.${e}`)]).toEqual([e, ['ui']]);
    expect(need('src/main/java/com/x/ListController.java')).not.toContain('ui');
    expect(need('src/main/webapp/WEB-INF/web.xml')).toEqual([]);
    expect(need('pom.xml')).toEqual([]);
    // a template on a boundary path (a db or http dir) needs both: the UI extension rule keeps `ui` when the path is boundary code
    expect(need('src/db/list.jsp')).toEqual(['integration', 'ui']);
    expect(need('src/http/page.ftl')).toEqual(['integration', 'ui']);
    expect(need('src/db/client.ts')).toEqual(['integration']); // a client path that is no UI extension stays boundary only
  });

  test('a review of a template needs ui-ux-accessibility and plan-completeness; Java and XML need neither', () => {
    expect(requiredDimensionsFor(['src/main/webapp/WEB-INF/views/list.jsp'])).toEqual(expect.arrayContaining(['ui-ux-accessibility', 'plan-completeness']));
    for (const e of TEMPLATES) {
      const dims = requiredDimensionsFor([`src/templates/page.${e}`]);
      expect([e, dims.includes('ui-ux-accessibility'), dims.includes('plan-completeness')]).toEqual([e, true, true]);
    }
    for (const rel of ['src/main/java/com/x/Dao.java', 'src/main/webapp/WEB-INF/web.xml', 'pom.xml']) {
      const dims = requiredDimensionsFor([rel]);
      expect([rel, dims.includes('ui-ux-accessibility')]).toEqual([rel, false]);
    }
  });
});

// ── N7 ──────────────────────────────────────────────────────────────────────────────────────────────

describe('N7: a file tool\'s path is judged by name (`..` collapsed), a shell command\'s by the file the OS opens', () => {
  /** A scratch repo `P` with `P/<link>` -> a dir OUTSIDE it (`ext/<deep>` below a second temp dir). */
  function outsideLink(link: string, deep: string, files: Record<string, string> = {}): { d: string; ext: string } {
    const d = repo({ 'notes.md': 'hello\n', ...files });
    const ext = tmp('goodboy-nq-ext-');
    mkdirSync(join(ext, deep), { recursive: true });
    mkdirSync(dirname(join(d, link)), { recursive: true });
    symlinkSync(join(ext, deep), join(d, link));
    return { d, ext };
  }
  const run = runHook;
  const recorded = recordedFiles;

  test('fileToolPath is resolve (the `..` goes by name); openedPath goes through the link first', () => {
    const { d } = outsideLink('w/lnk', 'a/b', { 'f.txt': 'f\n' });
    for (const raw of ['w/lnk/../x', 'w/lnk/../../x', './w//lnk/../x']) {
      expect([raw, fileToolPath(d, raw)]).toEqual([raw, resolve(d, raw)]);
      expect([raw, fileToolPath('/elsewhere', spell(d, raw))]).toEqual([raw, resolve(spell(d, raw))]);
    }
    expect(fileToolPath(d, 'w/lnk/../x')).toBe(join(d, 'w', 'x'));
    expect(fileToolPath(d, 'w/lnk/../../x')).toBe(join(d, 'x'));
    expect(openedPath(d, 'w/lnk/../x')).not.toBe(fileToolPath(d, 'w/lnk/../x'));
    expect(openedPath(d, 'w/lnk/../x')).toBe(join(realpathSync(join(d, 'w', 'lnk')), '..', 'x'));
    // no `..`: the same
    expect(fileToolPath(d, 'src/a.ts')).toBe(openedPath(d, 'src/a.ts'));
    expect(fileToolPath('/work', '/abs/x.ts')).toBe('/abs/x.ts');
  });

  test('PostToolUse records an Edit through `docs/lnk/../../src/app.ts` (docs/lnk -> a dir outside) as src/app.ts, and the Stop asks for its tests', async () => {
    const { d } = outsideLink('docs/lnk', 'a/b', { 'src/app.ts': 'export const app = 1;\n', 'tests/ok.test.ts': 'test("ok", () => {});\n' });
    write(d, 'src/app.ts', 'export const app = 2;\n'); // the edit's effect
    const s = session();
    const post = await run('hooks/post-tool-use.ts', d, s, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: spell(d, 'docs/lnk/../../src/app.ts'), old_string: '1', new_string: '2' },
      tool_response: {},
    });
    expect(post.decision).toBeUndefined();
    expect(recorded('edits', s)).toEqual([join(d, 'src', 'app.ts')]);
    const stop = await run('hooks/stop.ts', d, s, { hook_event_name: 'Stop', stop_hook_active: false }, { GOODBOY_TEST_GATE: 'on', GOODBOY_TEST_TYPES: 'on', GOODBOY_DIFF_COVERAGE: 'on', GOODBOY_EXISTING_TESTS: 'on', GOODBOY_DOCS_GATE: 'off' });
    expect(stop.decision).toBe('block');
    expect(stop.reason).toMatch(/No test result covers the changed code/);
    expect(stop.reason).toContain('src/app.ts');
  });

  test('PostToolUse records Write and MultiEdit (its file_path and each edit\'s) by name too', async () => {
    const { d } = outsideLink('w/lnk', 'a/b');
    const s = session();
    const post = (tool: string, input: Record<string, unknown>) => run('hooks/post-tool-use.ts', d, s, { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: {} });
    await post('Write', { file_path: spell(d, 'w/lnk/../w.md'), content: 'x' });
    await post('MultiEdit', { file_path: spell(d, 'w/lnk/../m.md'), edits: [{ old_string: 'a', new_string: 'b' }, { file_path: spell(d, 'w/lnk/../n.md'), old_string: 'a', new_string: 'b' }] });
    expect(recorded('edits', s)).toEqual([join(d, 'w', 'w.md'), join(d, 'w', 'm.md'), join(d, 'w', 'n.md')]);
  });

  test('read-before-edit: a Read through `w/lnk/../notes.md` then an Edit of the same spelling or of w/notes.md passes; a Bash cat of it is a read of the link side only', async () => {
    const { d, ext } = outsideLink('w/lnk', 'a/b', { 'w/notes.md': 'hello\n' });
    write(ext, 'a/notes.md', 'hello\n'); // what `cat w/lnk/../notes.md` reads: the parent of the link's target
    const tryEdit = async (s: string, file: string) =>
      denialOf(await run('hooks/pre-tool-use.ts', d, s, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'hello', new_string: 'world' } }));
    const raw = spell(d, 'w/lnk/../notes.md'); // by name: w/notes.md
    const s = session();
    expect((await tryEdit(s, raw)).denied).toBe(true); // no read yet: denied, naming the file the tool opens
    expect((await tryEdit(session(), raw)).reason).toContain(join(d, 'w', 'notes.md'));
    await run('hooks/post-tool-use.ts', d, s, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: raw }, tool_response: {} });
    expect(recorded('reads', s)).toEqual([join(d, 'w', 'notes.md')]);
    expect((await tryEdit(s, raw)).denied).toBe(false);
    expect((await tryEdit(s, join(d, 'w', 'notes.md'))).denied).toBe(false);

    // a Bash cat reads through the link: the file beside the link target, not w/notes.md
    const s2 = session();
    await run('hooks/post-tool-use.ts', d, s2, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `cat ${raw}` }, tool_response: { stdout: 'hello\n' } });
    // (a read outside the project is not recorded at all; what matters is that w/notes.md is not credited)
    expect(recorded('reads', s2)).not.toContain(join(d, 'w', 'notes.md'));
    expect((await tryEdit(s2, join(d, 'w', 'notes.md'))).denied).toBe(true);
    expect((await tryEdit(s2, raw)).denied).toBe(true);
  });

  // A is the session's first top; B is a worktree of A that the session has not seen. B/docs/lnk -> a dir outside,
  // so by name `B/docs/lnk/../../src/x.ts` is in B, while the OS-opened spelling would leave every repo.
  // Edit, Write and MultiEdit are also recorded as edits; NotebookEdit (its `notebook_path`) only reaches editedDirs.
  const FILE_TOOLS: [string, (file: string) => Record<string, unknown>, boolean][] = [
    ['Edit', (file) => ({ file_path: file, old_string: 'a', new_string: 'b' }), true],
    ['NotebookEdit', (file) => ({ notebook_path: file, new_source: 'x' }), false],
  ];
  for (const [tool, input, isRecorded] of FILE_TOOLS) {
    test(`PostToolUse pins the checkout of the ${tool} tool through a link by the edited path's name (editedDirs)`, async () => {
      const A = repo({});
      const B = join(tmp('goodboy-nq-wt-'), 'B');
      const s = session();
      pinCoverageStart(s, A); // B does not exist yet: it is new to the session when a hook sees it
      sh(A, `git worktree add -q -b nqb '${B}'`);
      const ext = tmp('goodboy-nq-ext-');
      mkdirSync(join(ext, 'a/b'), { recursive: true });
      mkdirSync(join(B, 'docs'), { recursive: true });
      mkdirSync(join(B, 'src'), { recursive: true });
      symlinkSync(join(ext, 'a/b'), join(B, 'docs', 'lnk'));
      const pins = () => readdirSync(join(tmpdir(), `goodboy-session-${s}`)).filter((f) => /^start-pin-[0-9a-f]{16}\.json$/.test(f)).length;
      const before = pins();
      await run('hooks/post-tool-use.ts', A, s, {
        hook_event_name: 'PostToolUse',
        tool_name: tool,
        tool_input: input(spell(B, 'docs/lnk/../../src/x.ts')),
        tool_response: {},
      });
      expect(recorded('edits', s).includes(join(B, 'src', 'x.ts'))).toBe(isRecorded);
      expect(pins()).toBe(before + 1);
    });
  }

  test('the re-Read gate: a second Read through `w/lnk/../notes.md` is a re-Read of w/notes.md, spelled either way', async () => {
    const { d } = outsideLink('w/lnk', 'a/b', { 'w/notes.md': 'hello\n' });
    const s = session();
    const raw = spell(d, 'w/lnk/../notes.md');
    await run('hooks/post-tool-use.ts', d, s, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: raw }, tool_response: {} });
    const again = (file: string) => run('hooks/pre-tool-use.ts', d, s, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file } });
    for (const file of [raw, join(d, 'w', 'notes.md')]) {
      const out = await again(file);
      expect([file, out.hookSpecificOutput?.permissionDecision]).toEqual([file, 'deny']);
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('H2-01');
    }
    // the file beside the link target is another file: no re-Read
    expect((await again(join(d, 'notes.md'))).hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  describe('the PreToolUse write guard judges a file tool\'s path by name, as the tool opens it', () => {
    // tests/lnk -> <outside>/a/b. The file tools collapse `..` by name before opening (measured, plan §20.9), so
    // `tests/lnk/../../src/a.ts` is src/a.ts: judged by name it is code, which a test role may not write. Judged by
    // the OS-opened path (`openedPath`, which goes through the link first) it would be <outside>/src/a.ts, outside the
    // project, and pass while the tool wrote src/a.ts.
    const tester = { agent_type: 'goodboy:test-unit', agent_id: 'tu1' };
    const scene = () => outsideLink('tests/lnk', 'a/b', { 'tests/keep.test.ts': 'test("k", () => {});\n' }).d;

    for (const tool of ['Write', 'Edit']) {
      test(`a test role's ${tool} of tests/lnk/../../src/a.ts is denied, naming src/a.ts`, async () => {
        const d = scene();
        const input = tool === 'Write' ? { content: 'x' } : { old_string: '1', new_string: '2' };
        const out = await pre(d, { tool_name: tool, ...tester, tool_input: { file_path: spell(d, 'tests/lnk/../../src/a.ts'), ...input } });
        expect(out.denied).toBe(true);
        expect(out.reason).toContain('test-unit writes test files only, not src/a.ts.');
      });
    }

    test('a test role\'s Write of tests/lnk/../ok.test.ts is tests/ok.test.ts: allowed', async () => {
      const d = scene();
      const out = await pre(d, { tool_name: 'Write', ...tester, tool_input: { file_path: spell(d, 'tests/lnk/../ok.test.ts'), content: 'test("ok", () => {});\n' } });
      expect([out.denied, out.reason]).toEqual([false, '']);
    });
  });

  describe('the PreToolUse result guard: `results` reads, `regression` records', () => {
    const cli = join(ROOT, 'lib', 'cli.ts');
    const bash = (d: string, command: string, agent_type?: string) => pre(d, { tool_name: 'Bash', ...(agent_type ? { agent_type, agent_id: 'a1' } : {}), tool_input: { command } });

    test('a test role may run `results query --kind regression` (and its own `regression`)', async () => {
      const d = repo({});
      expect(await bash(d, `bun ${cli} results query --kind regression`, 'goodboy:test-unit')).toEqual({ denied: false, reason: '' });
      expect((await bash(d, `bun ${cli} regression`, 'goodboy:test-unit')).denied).toBe(false);
    });

    test('a review agent and the main session: `results query --kind regression` passes, `regression` is denied as a test record', async () => {
      const d = repo({});
      for (const agent of ['goodboy:review-all', undefined]) {
        const read = await bash(d, `bun ${cli} results query --kind regression`, agent);
        expect([agent, read.denied, read.reason]).toEqual([agent, false, '']);
        const record = await bash(d, `bun ${cli} regression`, agent);
        expect([agent, record.denied]).toEqual([agent, true]);
        expect(record.reason).toContain('Only goodboy test agents record test results');
      }
    });
  });
});
