// The test survey (track L, L1; plan §18): what a project has for tests and what it lacks. It
// is read-only: git lists the files (with the hook git settings, so the repo's config runs no
// program), the manifests and test files are read, no project tool runs and nothing is
// written. "Untested" is an estimate: a code file counts as tested when a test file names its
// stem, or for an index file imports its dir.

import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { extname, join, posix } from 'node:path';
import { policyGlobs } from './changed-coverage';
import { gitOut } from './git-run';
import { SERVER_TEMPLATE_EXTS } from './review-dimensions';
import { readRegular } from './safe-read';
import { TEST_FILE, testTypeOf } from './test-catalog';
import { type ExtraType, JS_SPECIFIER, SATISFIED_BY, typeNeedOf } from './test-types';
import { isTestFile, JVM_TEST_SOURCE_SET } from './test-validator';
import type { TestType } from './types';

export type ToolKind = 'runner' | 'coverage' | 'integration' | 'e2e' | 'ui';
export type TargetKind = 'boundary' | 'ui' | 'code';

export interface SurveyTarget {
  /** Repo-relative, `/` separators. */
  rel: string;
  kind: TargetKind;
  /** What it lacks: `any` test, or an extra type (I3b) that no test naming it has. */
  needs: ('any' | ExtraType)[];
  why: string;
  bytes: number;
}

export interface ProjectSurvey {
  root: string;
  stacks: string[];
  frameworks: string[];
  tools: Record<ToolKind, string[]>;
  /** Test files per type. */
  tests: Record<TestType, number>;
  code: { files: number; boundary: number; ui: number };
  /** Ranked boundary → UI → other, then by size; `count` is before the cap. */
  untested: { count: number; targets: SurveyTarget[] };
  gaps: string[];
  problems: string[];
}

export const MAX_FILES = 50_000;
const MAX_MANIFESTS = 200;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_TEST_BYTES = 512 * 1024;
const MAX_TEST_TOTAL = 64_000_000;

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.py', '.go', '.java', '.kt',
  '.rs', '.rb', '.php', '.cs', '.scala', '.swift', '.dart',
]);
const JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']);
/** Server-side and static page templates: UI targets of their own, from the one list the UI file rule uses (N5). */
const TEMPLATE_EXT = new Set(['.html', '.htm', ...SERVER_TEMPLATE_EXTS.map((e) => `.${e}`)]);
/** Dirs whose files are not the project's own wherever they sit: dependencies, tool state and
 *  generated code. Neither code targets nor tests nor tool evidence. A name here is no package
 *  name of any real project (a leading dot, a dependency manager's dir, a virtualenv). */
const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', 'webjars', '.next', '.nuxt',
  '.svelte-kit', '.gradle', '__generated__', '.idea', '.vscode', '.goodboy', '.claude', '.github', '.storybook',
  // virtualenvs, tool caches and git's own dir (the sandbox scan skipped these too)
  '.git', 'venv', '.venv', 'site-packages', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
]);
/** Vendored third-party code at the top of a tree or of a module (`vendor/`, `server/vendor/`). These
 *  are also package and template dir names (`com/acme/vendor/`, `templates/vendor/`), so a deeper one
 *  counts for nothing. */
const VENDOR_DIRS = new Set(['vendor', 'vendors', 'third_party', 'third-party']);
/** Build outputs and docs, skipped only outside a `src` dir: inside one they are package
 *  names (`src/main/java/com/acme/build/`). */
const OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'target', 'coverage', 'generated', 'docs']);
/** Under a static web root, these dirs hold copied libraries (`static/js/lib/jquery.js`). */
const STATIC_ROOTS = new Set(['static', 'public', 'assets', 'webapp', 'www', 'wwwroot']);
const STATIC_LIB_DIRS = new Set(['lib', 'libs', 'plugin', 'plugins', 'vendor', 'external', 'ext', 'dist', 'build']);
/** A copied library is script or style: a page or a class in a `lib` dir is the project's own. */
const STATIC_LIB_FILE = /\.(?:[cm]?js|css|map)$/i;
const MINIFIED_NAME = /\.min\.[^.]+$|\.d\.[cm]?ts$|\.bundle\.[cm]?js$/;
const SKIP_NAME = new RegExp(`${MINIFIED_NAME.source}|(?:^|[./-])config\\.[cm]?[jt]s$|\\.stories\\.[cm]?[jt]sx?$`);
/** Dirs of tests at the top of the tree or of a module (`test/`, `web/e2e/`): what the sandbox scan and
 *  the UI inventory read leaves them out. Deeper, `test` and `spec` are package names. */
const TEST_ROOT_DIRS = new Set(['test', 'tests', 'spec', 'specs', 'e2e', 'cypress', 'testdata']);
/** JS test dirs by convention, wherever they sit. */
const JS_TEST_DIRS = new Set(['__tests__', '__mocks__']);
/** Cypress specs (`*.cy.ts`) are e2e tests the shared test-file pattern leaves out. */
const CYPRESS_SPEC = /\.cy\.[cm]?[jt]sx?$/;
/** Stems that name a module by its dir: a JS/TS index file is named by an import of its dir. */
const DIR_NAMED = new Set(['index', '__init__', 'mod']);

type Eco = 'node' | 'jvm' | 'python' | 'go' | 'rust' | 'ruby' | 'php';

const MANIFESTS: [RegExp, Eco][] = [
  [/^package\.json$/, 'node'],
  [/^(?:build\.gradle(?:\.kts)?|pom\.xml)$/, 'jvm'],
  [/^(?:pyproject\.toml|setup\.py|setup\.cfg|Pipfile|tox\.ini|requirements[^/]*\.txt)$/, 'python'],
  [/^go\.mod$/, 'go'],
  [/^Cargo\.toml$/, 'rust'],
  [/^Gemfile$/, 'ruby'],
  [/^composer\.json$/, 'php'],
];

/** `node … --test` in one command of a script (split first: a single regex over a long script
 *  backtracks quadratically). */
const nodeTest = (s: string) => s.split(/[&|;\n]/).some((seg) => /(?:^|\s)node\s/.test(` ${seg}`) && /(?:^|\s)--test(?:\s|=|$)/.test(seg));

interface Rule {
  kind: ToolKind;
  name: string;
  /** A package.json dependency name. */
  dep?: RegExp;
  /** A package.json script. */
  script?: (s: string) => boolean;
  /** The text of the other manifests, per ecosystem. */
  text?: Partial<Record<Eco, RegExp>>;
  /** A file's base name in the project (outside the skipped dirs). */
  file?: RegExp;
}

const bunTest = (s: string) => /\bbun test\b/.test(s);

const TOOL_RULES: Rule[] = [
  { kind: 'runner', name: 'jest', dep: /^(?:jest|ts-jest)$/, file: /^jest\.config\./ },
  { kind: 'runner', name: 'vitest', dep: /^vitest$/, file: /^vitest\.config\./ },
  { kind: 'runner', name: 'mocha', dep: /^mocha$/, file: /^\.mocharc/ },
  { kind: 'runner', name: 'karma', dep: /^karma$/, file: /^karma\.conf\./ },
  { kind: 'runner', name: 'bun test', script: bunTest },
  { kind: 'runner', name: 'node --test', script: nodeTest },
  { kind: 'runner', name: 'junit', text: { jvm: /junit|spring-boot-starter-test|\btestng\b|\bkotest\b|\bspock\b/i } },
  { kind: 'runner', name: 'pytest', text: { python: /\bpytest\b/i }, file: /^(?:pytest\.ini|conftest\.py)$/ },
  { kind: 'runner', name: 'go test', file: /^go\.mod$/ },
  { kind: 'runner', name: 'cargo test', file: /^Cargo\.toml$/ },
  { kind: 'runner', name: 'rspec', text: { ruby: /\brspec\b/ }, file: /^\.rspec$/ },
  { kind: 'runner', name: 'phpunit', text: { php: /phpunit/ }, file: /^phpunit\.xml/ },
  { kind: 'coverage', name: 'jest --coverage', dep: /^(?:jest|ts-jest)$/ },
  { kind: 'coverage', name: 'vitest coverage', dep: /^@vitest\/coverage-/ },
  { kind: 'coverage', name: 'c8', dep: /^c8$/ },
  { kind: 'coverage', name: 'nyc', dep: /^nyc$/ },
  { kind: 'coverage', name: 'bun test --coverage', script: bunTest },
  { kind: 'coverage', name: 'jacoco', text: { jvm: /jacoco/i } },
  { kind: 'coverage', name: 'kover', text: { jvm: /kover/i } },
  { kind: 'coverage', name: 'coverage.py', text: { python: /pytest-cov|\bcoverage\b/i } },
  { kind: 'coverage', name: 'go test -cover', file: /^go\.mod$/ },
  { kind: 'integration', name: 'testcontainers', dep: /^(?:testcontainers|@testcontainers\/)/, text: { jvm: /testcontainers/i, python: /testcontainers/i, go: /testcontainers/i } },
  { kind: 'integration', name: 'supertest', dep: /^supertest$/ },
  { kind: 'integration', name: 'spring test (MockMvc)', text: { jvm: /spring-boot-starter-test|spring-test\b/ } },
  { kind: 'integration', name: 'rest-assured', text: { jvm: /rest-assured/i } },
  { kind: 'integration', name: 'wiremock', dep: /^wiremock/, text: { jvm: /wiremock/i } },
  { kind: 'e2e', name: 'playwright', dep: /^(?:@playwright\/test|playwright)$/, file: /^playwright\.config\./, text: { jvm: /com\.microsoft\.playwright/, python: /\bplaywright\b/i } },
  { kind: 'e2e', name: 'cypress', dep: /^cypress$/, file: /^cypress\.config\./ },
  { kind: 'e2e', name: 'puppeteer', dep: /^puppeteer$/ },
  { kind: 'e2e', name: 'webdriverio', dep: /^(?:webdriverio|@wdio\/)/ },
  { kind: 'e2e', name: 'selenium', dep: /^selenium-webdriver$/, text: { jvm: /selenium|selenide/i, python: /selenium/i } },
  { kind: 'ui', name: 'testing-library', dep: /^@testing-library\// },
  { kind: 'ui', name: 'vue test-utils', dep: /^@vue\/test-utils$/ },
  { kind: 'ui', name: 'enzyme', dep: /^enzyme$/ },
];

const FRAMEWORK_RULES: { name: string; dep?: RegExp; text?: Partial<Record<Eco, RegExp>> }[] = [
  { name: 'react', dep: /^react$/ },
  { name: 'vue', dep: /^vue$/ },
  { name: 'svelte', dep: /^svelte$/ },
  { name: 'angular', dep: /^@angular\/core$/ },
  { name: 'next', dep: /^next$/ },
  { name: 'nuxt', dep: /^nuxt$/ },
  { name: 'express', dep: /^express$/ },
  { name: 'fastify', dep: /^fastify$/ },
  { name: 'nestjs', dep: /^@nestjs\/core$/ },
  { name: 'spring-boot', text: { jvm: /spring-boot/ } },
  { name: 'thymeleaf', text: { jvm: /thymeleaf/i } },
  { name: 'jsp', text: { jvm: /tomcat-embed-jasper|\bjstl\b/i } },
  { name: 'mybatis', text: { jvm: /mybatis/i } },
  { name: 'django', text: { python: /\bdjango\b/i } },
  { name: 'flask', text: { python: /\bflask\b/i } },
  { name: 'fastapi', text: { python: /\bfastapi\b/i } },
  { name: 'gin', text: { go: /gin-gonic\/gin/ } },
  { name: 'echo', text: { go: /labstack\/echo/ } },
];

export function listFiles(root: string): string[] | null {
  // null: not a repo, a failure, or no git at all.
  const out = gitOut(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 30_000 });
  if (out === null) return null;
  // sorted: the files a cap keeps, and the order a scan reads them in, do not depend on git's
  return [...new Set(out.split('\0'))].filter((f) => f !== '' && !f.includes('\n')).sort();
}

/** The repos one level below a dir that is no repo (separate FE and BE repos under one dir). */
function reposBelow(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, '.git')))
      .map((d) => join(root, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** The dirs of a path that are dirs, not the package part of a JVM source path:
 *  `src/main/java/com/acme/vendor/A.java` → `src/main/java`. `vendor`, `lib`, `test` and `spec` below
 *  a JVM source root are package names, and a class there is the project's own. */
function pathDirs(rel: string): string[] {
  const dirs = rel.split('/').slice(0, -1);
  const j = dirs.findIndex((d, i) => i >= 2 && dirs[i - 2] === 'src' && (d === 'java' || d === 'kotlin' || d === 'scala' || d === 'groovy'));
  return j < 0 ? dirs : dirs.slice(0, j + 1);
}

/** Why a path is not the project's own by the dir it sits in, or null. */
function skippedDirReason(rel: string): string | null {
  const dirs = rel.split('/').slice(0, -1);
  if (dirs.some((d) => SKIP_DIRS.has(d))) return 'dependency and tool dirs';
  const src = dirs.indexOf('src');
  if (dirs.some((d, i) => OUTPUT_DIRS.has(d) && (src < 0 || i < src))) return 'build output';
  if (dirs.slice(0, 2).some((d) => VENDOR_DIRS.has(d))) return 'vendored code';
  return null;
}

export function inSkippedDir(rel: string): boolean {
  return skippedDirReason(rel) !== null;
}

/** Not the project's own code: a skipped dir, a library copied under a static web root, a
 *  minified, declaration, bundle, config or story file. */
export function notOwnCode(rel: string): boolean {
  return inStaticLib(rel) || SKIP_NAME.test(posix.basename(rel));
}

/** A library copied under a static web root (`static/js/lib/jquery.js`). */
function inStaticLib(rel: string): boolean {
  if (!STATIC_LIB_FILE.test(rel)) return false;
  const dirs = pathDirs(rel);
  const s = dirs.findIndex((d) => STATIC_ROOTS.has(d));
  return s >= 0 && dirs.slice(s + 1).some((d) => STATIC_LIB_DIRS.has(d));
}

/** Test code by where it sits: a test source set, the top of the tree or of a module, a JS test dir. */
function inTestRoot(rel: string): boolean {
  const dirs = pathDirs(rel);
  if (dirs.some((d) => JS_TEST_DIRS.has(d))) return true;
  if (/(^|\/)src\/test\//.test(rel) || JVM_TEST_SOURCE_SET.test(rel)) return true;
  return dirs.slice(0, 2).some((d) => TEST_ROOT_DIRS.has(d));
}

/** A test file by its name alone (the shared pattern, Cypress specs): no dir rule of its own. */
const testNamed = (rel: string): boolean => TEST_FILE.test(rel) || CYPRESS_SPEC.test(rel);

/** Whether a file sits under a static web root (`static/`, `public/`, `webapp/`, …): code a
 *  browser loads, with no server-side call sites. */
export function isBrowserAsset(rel: string): boolean {
  return rel.split('/').slice(0, -1).some((d) => STATIC_ROOTS.has(d));
}

/** The project's own non-test file, for the tools that read source for what it says (the
 *  sandbox scan, the UI inventory): `notOwnCode` without its config and story rule (a proxy
 *  target in `vite.config.ts` is an outbound host), and with test code left out. */
export function ownFile(rel: string): boolean {
  return notOwnReason(rel) === null;
}

/** Why `ownFile` leaves a file out, or null when it keeps it. Only places that are unambiguous:
 *  dependency and tool dirs, build output, vendored code at the top of a tree, a copied script or
 *  style under a static web root, a minified or declaration file, test code in a test source set, at
 *  the top of the tree or of a module, or named as a test. A `vendor`, `lib`, `test` or `spec` dir
 *  inside the package part of a JVM source path is none of them: its classes are the project's own. */
export function notOwnReason(rel: string): string | null {
  const dir = skippedDirReason(rel);
  if (dir !== null) return dir;
  if (inStaticLib(rel)) return 'a library under a static web root';
  if (MINIFIED_NAME.test(posix.basename(rel))) return 'minified and declaration files';
  if (inTestRoot(rel) || testNamed(rel)) return 'test code';
  return null;
}

/** A test file by its name (the shared pattern, Cypress specs), or code in a test dir. */
export function isTestCode(rel: string): boolean {
  return TEST_FILE.test(rel) || CYPRESS_SPEC.test(rel) || (isTestFile(rel) && CODE_EXT.has(extname(rel).toLowerCase()));
}

/** The name a test would use for a code file: its stem without the last extension
 *  (`user.service`), or its dir's name for an index file. */
export function stemOf(rel: string): string | null {
  const stem = posix.basename(rel).replace(/\.[^.]+$/, '');
  if (!DIR_NAMED.has(stem)) return stem.length >= 3 ? stem : null;
  const dir = posix.basename(posix.dirname(rel));
  return dir !== '.' && dir.length >= 3 ? dir : null;
}

/** Identifier-like words of a test's text, `-` included so that a kebab-case module named in
 *  an import (`../user-service`) is one word. */
function wordsOf(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$-]*/g) ?? [];
}

/** The last segment of each module a JS/TS test imports, without its extension
 *  (`../user.service` → `user.service`, `./Button/index` → `Button`). */
function importTails(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(JS_SPECIFIER)) {
    const segs = m[2]!.split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
    let last = segs.pop();
    if (last && /^index(?:\.[cm]?[jt]sx?)?$/.test(last)) last = segs.pop();
    if (last) out.push(last.replace(/\.[cm]?[jt]sx?$/, ''));
  }
  return out;
}

function readText(abs: string, max: number): string | null {
  const r = readRegular(abs, max, true);
  return typeof r === 'object' ? r.text : null;
}

const add = (m: Map<string, Set<TestType>>, w: string, type: TestType) => {
  const s = m.get(w);
  if (s) s.add(type);
  else m.set(w, new Set([type]));
};

/** The survey of one project root. */
export function surveyProject(root: string, maxTargets = 30): ProjectSurvey {
  const survey: ProjectSurvey = {
    root,
    stacks: [],
    frameworks: [],
    tools: { runner: [], coverage: [], integration: [], e2e: [], ui: [] },
    tests: { unit: 0, integration: 0, ui: 0, e2e: 0 },
    code: { files: 0, boundary: 0, ui: 0 },
    untested: { count: 0, targets: [] },
    gaps: [],
    problems: [],
  };
  const listed = listFiles(root);
  if (listed === null) {
    const below = reposBelow(root);
    survey.problems.push(
      below.length > 0 ? `not a git repository; survey its repositories instead: ${below.join(', ')}` : 'git cannot list the files (not a git repository, or git is missing)',
    );
    return survey;
  }
  // Dependencies and builds go first, so that an unignored node_modules cannot use up the cap.
  let files = listed.filter((f) => !inSkippedDir(f));
  if (files.length > MAX_FILES) {
    survey.problems.push(`${files.length} files; only the first ${MAX_FILES} were surveyed`);
    files = files.slice(0, MAX_FILES);
  }

  // Manifests and tools.
  const deps = new Set<string>();
  const scripts: string[] = [];
  const texts: Partial<Record<Eco, string[]>> = {};
  const ecos = new Set<Eco>();
  const names = new Set<string>();
  let manifests = 0;
  for (const rel of files) {
    const base = posix.basename(rel);
    names.add(base);
    const eco = MANIFESTS.find(([re]) => re.test(base))?.[1];
    if (!eco) continue;
    ecos.add(eco);
    if (++manifests > MAX_MANIFESTS) continue;
    const text = readText(join(root, rel), MAX_MANIFEST_BYTES);
    if (text === null) continue;
    if (eco === 'node') {
      try {
        const pkg = JSON.parse(text) as Record<string, unknown>;
        for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const v = pkg[k];
          if (v && typeof v === 'object') for (const d of Object.keys(v)) deps.add(d);
        }
        const s = pkg.scripts;
        if (s && typeof s === 'object') for (const v of Object.values(s)) if (typeof v === 'string') scripts.push(v);
      } catch {
        survey.problems.push(`${rel} is not valid JSON`);
      }
    } else (texts[eco] ??= []).push(text);
  }
  if (manifests > MAX_MANIFESTS) survey.problems.push(`${manifests} manifests; only the first ${MAX_MANIFESTS} were read`);
  survey.stacks = [...ecos].sort();
  const textHit = (t: Partial<Record<Eco, RegExp>> | undefined) => !!t && (Object.entries(t) as [Eco, RegExp][]).some(([eco, re]) => (texts[eco] ?? []).some((x) => re.test(x)));
  const depHit = (re: RegExp | undefined) => !!re && [...deps].some((d) => re.test(d));
  for (const r of TOOL_RULES) {
    const hit = depHit(r.dep) || (!!r.script && scripts.some(r.script)) || textHit(r.text) || (!!r.file && [...names].some((n) => r.file!.test(n)));
    if (hit && !survey.tools[r.kind].includes(r.name)) survey.tools[r.kind].push(r.name);
  }
  for (const f of FRAMEWORK_RULES) if (depHit(f.dep) || textHit(f.text)) survey.frameworks.push(f.name);

  // Test files: their types, the words they use and the modules they import.
  const named = new Map<string, Set<TestType>>();
  const imported = new Map<string, Set<TestType>>();
  let total = 0;
  let unread = 0;
  const testSet = new Set<string>();
  for (const rel of files) {
    // A helper in a test dir (`src/test/java/…/Fixtures.java`) is no code target and is not
    //   counted as a test, but the words it uses count.
    if (!isTestCode(rel)) continue;
    testSet.add(rel);
    const isTest = TEST_FILE.test(rel) || CYPRESS_SPEC.test(rel);
    const text = total < MAX_TEST_TOTAL ? readText(join(root, rel), MAX_TEST_BYTES) : null;
    if (text === null) unread++;
    else total += text.length;
    const type: TestType = CYPRESS_SPEC.test(rel) ? 'e2e' : testTypeOf(rel, text ?? '');
    if (isTest) survey.tests[type]++;
    if (text === null) continue;
    for (const w of new Set(wordsOf(text))) add(named, w, type);
    if (JS_EXT.has(extname(rel).toLowerCase())) {
      for (const w of new Set(importTails(text))) {
        add(named, w, type);
        add(imported, w, type);
      }
    }
  }
  if (unread > 0) survey.problems.push(`${unread} test files were not read (over ${MAX_TEST_BYTES} bytes, not regular files, or past the total cap)`);

  // Code files and the untested ones; the user's policy globs leave files out (coverage-exempt)
  //   or take their extra types away (test-type-exempt), as the gates do.
  const exempt = policyGlobs(root, root, 'coverage-exempt');
  const typeExempt = policyGlobs(root, root, 'test-type-exempt');
  const targets: SurveyTarget[] = [];
  for (const rel of files) {
    if (testSet.has(rel) || notOwnCode(rel)) continue;
    const ext = extname(rel).toLowerCase();
    const template = TEMPLATE_EXT.has(ext);
    if (!CODE_EXT.has(ext) && !template) continue;
    if (exempt.some((g) => new Bun.Glob(g).match(rel))) continue;
    const abs = join(root, rel);
    let bytes: number;
    try {
      // A link is no file of the project's own (its target may be outside it).
      const st = lstatSync(abs);
      if (!st.isFile()) continue;
      bytes = st.size;
    } catch {
      continue; // listed but gone
    }
    survey.code.files++;
    const need = typeNeedOf(abs, root, typeExempt);
    const extra = new Set<ExtraType>(need?.types ?? []);
    if (template && !typeExempt.some((g) => new Bun.Glob(g).match(rel))) extra.add('ui');
    const kind: TargetKind = extra.has('integration') ? 'boundary' : extra.has('ui') ? 'ui' : 'code';
    if (kind === 'boundary') survey.code.boundary++;
    if (extra.has('ui')) survey.code.ui++;
    const stem = stemOf(rel);
    // An index file counts as named only through an import of its dir.
    const dirNamed = DIR_NAMED.has(posix.basename(rel).replace(/\.[^.]+$/, '')) && JS_EXT.has(ext);
    const by = stem ? (dirNamed ? imported : named).get(stem) : undefined;
    const needs: SurveyTarget['needs'] = [];
    let why: string;
    if (!by || by.size === 0) {
      needs.push('any');
      why = stem ? `no test names \`${stem}\`` : 'its name is too short to match';
    } else {
      // An e2e suite reaches pages by URL, not by file name: with any e2e test in the project,
      //   a UI file named by some test is not asked for more.
      for (const t of extra) {
        if (t === 'ui' && survey.tests.e2e > 0) continue;
        if (!SATISFIED_BY[t].some((s) => by.has(s))) needs.push(t);
      }
      why = needs.map((t) => `no ${SATISFIED_BY[t as ExtraType].join(' or ')} test names \`${stem}\``).join('; ');
    }
    if (needs.length === 0) continue;
    if (needs.includes('any')) for (const t of extra) if (!(t === 'ui' && survey.tests.e2e > 0)) needs.push(t);
    const reasons = [need?.why.integration, need?.why.ui, template ? 'a page template' : undefined].filter(Boolean);
    targets.push({ rel, kind, needs, why: reasons.length > 0 ? `${why} (${reasons.join('; ')})` : why, bytes });
  }
  const rank: Record<TargetKind, number> = { boundary: 0, ui: 1, code: 2 };
  targets.sort((a, b) => rank[a.kind] - rank[b.kind] || b.bytes - a.bytes || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  survey.untested = { count: targets.length, targets: targets.slice(0, Math.max(0, maxTargets)) };

  // Gaps.
  const testFiles = Object.values(survey.tests).reduce((a, b) => a + b, 0);
  if (survey.tools.runner.length === 0 && testFiles === 0) survey.gaps.push('no-test-runner');
  if (survey.tools.coverage.length === 0) survey.gaps.push('no-coverage-tool');
  if (survey.code.boundary > 0 && survey.tests.integration + survey.tests.e2e === 0) survey.gaps.push('no-integration-tests');
  if (survey.code.ui > 0 && survey.tests.e2e === 0) survey.gaps.push('no-e2e-tests');
  if (survey.code.ui > 0 && survey.tools.e2e.length === 0) survey.gaps.push('no-e2e-tool');
  if (targets.length > 0) survey.gaps.push('untested-code');
  return survey;
}
