// Track L (§18): test backfill for existing projects. L1 the read-only survey, L2 JVM test
// files for the catalog and the existing-test rules, L3 the backfill state and its CLI.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { testStrength, weakenedTests } from '../lib/existing-tests';
import { catalogRows, TEST_FILE, testTypeOf } from '../lib/test-catalog';
import { BACKFILL_FILE, emptyBackfill, markTarget, mergeSurvey, nextBatch, readBackfill } from '../lib/test-backfill';
import { isTestCode, stemOf, surveyProject, type SurveyTarget } from '../lib/test-survey';
import { isTestFile } from '../lib/test-validator';
import { isTestPath } from '../lib/role-limits';
import type { TestResult } from '../lib/types';
import { needsTests } from '../lib/verification-scope';
import { changedLineGaps } from '../lib/changed-coverage';
import type { ChangedFileEdit } from '../lib/review-validator';

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function put(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

function git(root: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function repo(files: Record<string, string>): string {
  const root = dir('goodboy-l-');
  git(root, 'init', '-q');
  put(root, files);
  return root;
}

const JAVA_TEST = (asserts: string) => `package com.acme.user;

import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("user service")
class UserServiceTest {
  // @Test a commented-out case is no case
  @Test
  void findsUser() {
    String s = "@Test assertThat(";
${asserts}
  }

  @ParameterizedTest
  void listsUsers() {}

  @TestConfiguration
  static class Config {}
}
`;

/** A Spring Boot project: a controller, two services, a page template, a copied library, one
 *  unit test naming UserService. */
function jvmProject(): string {
  return repo({
    'build.gradle': "plugins { id 'org.springframework.boot' version '3.3.0'; id 'jacoco' }\ndependencies { testImplementation 'org.springframework.boot:spring-boot-starter-test' }\n",
    'src/main/java/com/acme/user/UserController.java': 'class UserController { /* routes */ }\n'.repeat(5),
    'src/main/java/com/acme/user/UserService.java': 'class UserService {}\n',
    'src/main/java/com/acme/order/OrderService.java': 'class OrderService {}\n'.repeat(3),
    'src/main/resources/templates/index.html': '<html></html>\n',
    'src/main/resources/static/js/lib/jquery.js': 'var jq;\n',
    'src/main/resources/application.yml': 'server.port: 8080\n',
    'src/test/java/com/acme/user/UserServiceTest.java': JAVA_TEST('    assertThat(new UserService()).isNotNull();'),
  });
}

describe('L2: Java and Kotlin test files', () => {
  test('surefire, failsafe and Kotest names count in a test source set only', () => {
    const yes = [
      'src/test/java/a/UserServiceTest.java',
      'src/test/java/a/UserServiceTests.java',
      'src/test/java/a/UserServiceTestCase.java',
      'src/integrationTest/java/a/UserApiIT.java',
      'app/src/test/kotlin/a/UserSpec.kt',
      'app/src/jvmTest/kotlin/a/UserSpec.kt',
      'tests/UserServiceTest.java',
      // Acronyms before the suffix (last review).
      'src/test/java/a/HTTPTest.java',
      'src/test/kotlin/a/JSONSpec.kt',
    ];
    // Production classes named like tests in other source sets (code review of L).
    const no = [
      'src/main/java/a/ABTest.java',
      'src/test/java/a/Testimonial.java',
      'src/test/java/a/UserService.java',
      'src/main/kotlin/a/FooSpec.kt',
      'src/commonMain/kotlin/a/PodSpec.kt',
      'app/src/prod/java/a/RetryTest.java',
      'src/com/acme/web/ProductSpec.java',
      'UserServiceTest.kt',
      // Helpers in a test source set (narrow check of L), a constant class, a Java "spec".
      'src/test/java/a/TestUtils.java',
      'src/test/java/a/TestUserService.java',
      'src/test/java/a/LIMIT.java',
      'src/test/java/a/RequestSpec.java',
    ];
    expect(yes.filter((f) => !TEST_FILE.test(f))).toEqual([]);
    expect(no.filter((f) => TEST_FILE.test(f))).toEqual([]);
    // The older languages are unchanged.
    expect(['a.test.ts', 'x_test.go', 'tests/test_a.py'].every((f) => TEST_FILE.test(f))).toBe(true);
  });

  test('the gates know the Gradle test source sets the catalog knows (final review)', () => {
    const root = repo({
      'src/integrationTest/java/a/UserApiIT.java': 'class UserApiIT {}\n',
      'src/jvmTest/kotlin/a/FooSpec.kt': 'class FooSpec\n',
      'src/integrationTest/java/a/Fixtures.java': 'class Fixtures {}\n',
      'src/latest/Feed.java': 'class Feed {}\n',
      // A JS feature dir named like a source set is code (last review).
      'src/ABTest/Banner.tsx': 'export const Banner = () => null;\n',
    });
    const files = ['src/integrationTest/java/a/UserApiIT.java', 'src/jvmTest/kotlin/a/FooSpec.kt', 'src/integrationTest/java/a/Fixtures.java', 'src/latest/Feed.java', 'src/ABTest/Banner.tsx'];
    expect(files.map((f) => [isTestFile(f), isTestPath(f), needsTests(join(root, f), root), isTestCode(f)])).toEqual([
      [true, true, false, true],
      [true, true, false, true],
      [true, true, false, true],
      [false, false, true, false],
      [false, false, true, false],
    ]);
  });

  test('a JVM test of blank lines types in linear time (the Stop runs it)', () => {
    const t = Date.now();
    expect(testTypeOf('src/test/java/a/FooTest.java', '\n'.repeat(200_000))).toBe('unit');
    expect(Date.now() - t).toBeLessThan(1000);
  });

  test('types: a browser driver is e2e; a failsafe name, a Spring context or MockMvc is integration', () => {
    expect(testTypeOf('src/test/java/a/HomeTest.java', 'import com.microsoft.playwright.Page;\nclass HomeTest {}')).toBe('e2e');
    expect(testTypeOf('src/test/java/a/UserApiIT.java', 'class UserApiIT {}')).toBe('integration');
    expect(testTypeOf('src/test/java/a/UserApiTest.java', '@SpringBootTest\nclass UserApiTest {}')).toBe('integration');
    expect(testTypeOf('src/test/java/a/UserApiTest.java', 'class UserApiTest { MockMvc mvc; }')).toBe('integration');
    expect(testTypeOf('src/test/java/a/UserServiceTest.java', 'class UserServiceTest {}')).toBe('unit');
  });

  test('strength: JUnit cases and checks in code only; @TestConfiguration is no case', () => {
    expect(testStrength(JAVA_TEST('    assertThat(1).isOne();\n    verify(repo).save(any());\n    mvc.perform(get("/")).andExpect(status().isOk());'), '.java')).toEqual({ assertions: 3, cases: 2, skips: 0 });
    // Kotest's infix matchers count as checks.
    expect(testStrength('class A { @Disabled @Test fun a() { x shouldBe 1 } }', '.kt')).toEqual({ assertions: 1, cases: 1, skips: 1 });
    expect(testStrength('class A { @Test fun a() { val shouldnt = 1 } }', '.kt')!.assertions).toBe(0);
    // A test method named `should…` is no check; renaming it is no weakening (code review).
    const named = (n: string) => testStrength(`class A { @Test void ${n}() { assertThat(1).isOne(); } @Test fun ${n}2() {} }`, '.java')!;
    expect([named('shouldFindUser'), named('findsUser')]).toEqual([
      { assertions: 1, cases: 2, skips: 0 },
      { assertions: 1, cases: 2, skips: 0 },
    ]);
    // `@org.junit.jupiter.api.Test` by its full name is a case.
    expect(testStrength('class A { @org.junit.jupiter.api.Test void a() { assertEquals(1, 1); } }', '.java')!.cases).toBe(1);
  });

  test('the catalog lists a Java test with its display name and case count', () => {
    const root = jvmProject();
    const rows = catalogRows(root)!;
    expect(rows).toEqual([{ file: 'src/test/java/com/acme/user/UserServiceTest.java', type: 'unit', features: ['user service'], tests: 2 }]);
  });

  test('I5 now sees a weakened Java test', () => {
    const root = jvmProject();
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'start');
    const head = git(root, 'rev-parse', 'HEAD');
    expect(weakenedTests(root, head)).toEqual([]);
    put(root, { 'src/test/java/com/acme/user/UserServiceTest.java': JAVA_TEST('    // the check was dropped') });
    const w = weakenedTests(root, head);
    expect(w.map((x) => [x.rel, x.before?.assertions, x.after?.assertions])).toEqual([['src/test/java/com/acme/user/UserServiceTest.java', 1, 0]]);
  });
});

describe('L1: the survey', () => {
  test('a Spring project: tools, tests, and the untested code ranked boundary → UI → other', () => {
    const s = surveyProject(jvmProject());
    expect(s.stacks).toEqual(['jvm']);
    expect(s.frameworks).toEqual(['spring-boot']);
    expect(s.tools).toEqual({ runner: ['junit'], coverage: ['jacoco'], integration: ['spring test (MockMvc)'], e2e: [], ui: [] });
    expect(s.tests).toEqual({ unit: 1, integration: 0, ui: 0, e2e: 0 });
    // The copied library under static/js/lib is not the project's code.
    expect(s.code).toEqual({ files: 4, boundary: 1, ui: 1 });
    expect(s.untested.targets.map((t) => [t.rel, t.kind, t.needs])).toEqual([
      ['src/main/java/com/acme/user/UserController.java', 'boundary', ['any', 'integration']],
      ['src/main/resources/templates/index.html', 'ui', ['any', 'ui']],
      ['src/main/java/com/acme/order/OrderService.java', 'code', ['any']],
    ]);
    expect(s.untested.count).toBe(3);
    expect(s.gaps).toEqual(['no-integration-tests', 'no-e2e-tests', 'no-e2e-tool', 'untested-code']);
    expect(s.problems).toEqual([]);
  });

  test('a Node project: a boundary file named only by a unit test still needs an integration suite; e2e covers UI', () => {
    const root = repo({
      'package.json': JSON.stringify({ scripts: { test: 'jest' }, dependencies: { react: '18.3.1', express: '4.19.2' }, devDependencies: { jest: '29.7.0', '@playwright/test': '1.45.0' } }),
      'src/api/users.ts': "import express from 'express';\nexport const users = express.Router();\n",
      'src/api/users.test.ts': "import { users } from './users';\ntest('x', () => expect(users).toBeDefined());\n",
      'src/components/Button/index.tsx': 'export const Button = () => null;\n',
      'src/util/format.ts': 'export const format = (s: string) => s.trim();\n',
      'e2e/home.spec.ts': "import { test } from '@playwright/test';\ntest('home', async () => {});\n",
      'vite.config.ts': 'export default {};\n',
    });
    const s = surveyProject(root);
    expect(s.tools.runner).toEqual(['jest']);
    expect(s.tools.coverage).toEqual(['jest --coverage']);
    expect(s.tools.e2e).toEqual(['playwright']);
    expect(s.frameworks).toEqual(['react', 'express']);
    expect(s.tests).toEqual({ unit: 1, integration: 0, ui: 0, e2e: 1 });
    expect(s.untested.targets.map((t) => [t.rel, t.needs])).toEqual([
      ['src/api/users.ts', ['integration']],
      ['src/components/Button/index.tsx', ['any']],
      ['src/util/format.ts', ['any']],
    ]);
    expect(s.untested.targets[0]!.why).toContain('no integration or e2e test names `users`');
    // The e2e suite counts for the project's boundary tests; the file still needs its own.
    expect(s.gaps).toEqual(['untested-code']);
  });

  test('stems: an index file is named by its dir; a short name matches nothing', () => {
    expect([stemOf('src/a/Button/index.tsx'), stemOf('pkg/__init__.py'), stemOf('src/db.ts'), stemOf('src/user.ts'), stemOf('src/user.service.ts')]).toEqual(['Button', 'pkg', null, 'user', 'user.service']);
  });

  test('code review: dotted names, index files, skipped dirs, links and the user policy', () => {
    const root = repo({
      'package.json': JSON.stringify({ devDependencies: { jest: '29.7.0' } }),
      // Angular/Nest names: the spec imports `./user.service`.
      'src/user.service.ts': 'export class UserService {}\n',
      'src/user.service.spec.ts': "import { UserService } from './user.service';\ntest('x', () => expect(new UserService()).toBeTruthy());\n",
      // An index file counts as named only through an import of its dir, not the bare word `src`.
      'src/index.ts': 'export const a = 1;\n',
      'src/feature/index.ts': 'export const b = 2;\n',
      'tests/app.test.ts': "import { b } from '../src/feature';\n// mentions src and main\ntest('b', () => expect(b).toBe(2));\n",
      // A test inside a vendored dir names nothing of the project's.
      'vendor/lib/orders.test.ts': "import { orders } from '../../src/orders';\n",
      'src/orders.ts': 'export const orders = [];\n',
      // A package named like a build output is code; the build output is not (narrow check).
      'src/main/java/com/acme/build/BuildService.java': 'class BuildService {}\n',
      'build/generated/Gen.java': 'class Gen {}\n',
      'src/main/resources/static/dist/app.js': 'var bundle;\n',
      'docs/example.ts': 'export const e = 1;\n',
      // The user exempted generated clients from coverage.
      'src/gen/client.ts': 'export const c = 1;\n',
      '.goodboy/policy.md': '# Policy\n\n## Generated code\n- decide: human\n- coverage-exempt: src/gen/**\n',
    });
    const outside = dir('goodboy-l-outside-');
    writeFileSync(join(outside, 'secret.ts'), "import { exec } from 'child_process';\n");
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'linked.ts'));
    const s = surveyProject(root);
    expect(s.untested.targets.map((t) => t.rel).sort()).toEqual(['src/index.ts', 'src/main/java/com/acme/build/BuildService.java', 'src/orders.ts']);
    expect(s.tests).toEqual({ unit: 2, integration: 0, ui: 0, e2e: 0 });
  });

  test('a hostile script and an unignored node_modules do not stall or hide the survey', () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ scripts: { test: `node ${'x '.repeat(100_000)}` }, devDependencies: { jest: '29.7.0' } }),
      'src/app.ts': 'export const a = 1;\n',
    };
    const root = repo(files);
    put(root, { 'node_modules/pkg/a.js': 'x', 'node_modules/pkg/b.js': 'y' });
    const t = Date.now();
    const s = surveyProject(root);
    expect(Date.now() - t).toBeLessThan(3000);
    expect([s.stacks, s.code.files, s.tools.runner]).toEqual([['node'], 1, ['jest']]);
  });

  test('it writes nothing in the project', () => {
    const root = jvmProject();
    const before = git(root, 'status', '--porcelain', '--ignored');
    surveyProject(root);
    expect(git(root, 'status', '--porcelain', '--ignored')).toBe(before);
  });

  test('a dir that is no repository names the repositories below it', () => {
    const top = dir('goodboy-l-top-');
    for (const d of ['fe', 'be']) {
      mkdirSync(join(top, d));
      git(join(top, d), 'init', '-q');
    }
    const s = surveyProject(top);
    expect(s.problems).toEqual([`not a git repository; survey its repositories instead: ${join(top, 'be')}, ${join(top, 'fe')}`]);
  });

  test('CLI --all: the current project and the registered ones, with nothing registered by it', () => {
    const a = jvmProject();
    const b = repo({ 'src/x.py': 'import subprocess\n' });
    const checkups = dir('goodboy-l-checkups-');
    const env = { ...process.env, GOODBOY_CHECKUP_DIR: checkups, CLAUDE_PROJECT_DIR: a };
    const reg = Bun.spawnSync(['bun', CLI, 'checkup-projects', '--add', b], { cwd: a, env });
    expect(reg.exitCode).toBe(0);
    const r = Bun.spawnSync(['bun', CLI, 'test-survey', '--all', '--max', '1'], { cwd: a, env, stdout: 'pipe' });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { projects: { root: string; untested: { count: number; targets: unknown[] } }[] };
    const rows = out.projects.map((p) => [p.root, p.untested.count, p.untested.targets.length]);
    expect(rows.sort((x, y) => (x[0]! < y[0]! ? -1 : 1))).toEqual([[a, 3, 1], [b, 1, 1]].sort((x, y) => (x[0]! < y[0]! ? -1 : 1)));
    // Without a checkup dir nothing is made.
    const none = join(dir('goodboy-l-none-'), 'checkups');
    const r2 = Bun.spawnSync(['bun', CLI, 'test-survey', '--all'], { cwd: a, env: { ...env, GOODBOY_CHECKUP_DIR: none }, stdout: 'pipe' });
    expect([r2.exitCode, existsSync(none)]).toEqual([0, false]);
  });

  test('CLI --dir: a repository below a dir that is none, from the shell dir', () => {
    const top = dir('goodboy-l-ws-');
    git(top, 'init', '-q', 'be');
    put(join(top, 'be'), { 'src/Main.py': 'import subprocess\n' });
    // The session's project is the workspace dir; the shell is in it.
    const r = Bun.spawnSync(['bun', CLI, 'test-survey', '--dir', 'be'], { cwd: top, env: { ...process.env, CLAUDE_PROJECT_DIR: top }, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    const s = JSON.parse(r.stdout.toString()) as { root: string; untested: { count: number } };
    expect([s.root, s.untested.count]).toEqual([join(top, 'be'), 1]);
    const both = Bun.spawnSync(['bun', CLI, 'test-survey', '--dir', 'be', '--all'], { cwd: top, env: { ...process.env, CLAUDE_PROJECT_DIR: top }, stderr: 'pipe' });
    expect([both.exitCode, both.stderr.toString()]).toEqual([1, 'test-survey: pass --all or --dir, not both\n']);
  });
});

const target = (rel: string, kind: SurveyTarget['kind'] = 'code'): SurveyTarget => ({ rel, kind, needs: ['any'], why: 'w', bytes: 1 });

/** A passing record naming `tested` and `tests` (repo-relative), stamped `at`: a suite that ran
 *  the tests, and the mutation of the first tested file detected. */
function record(root: string, tested: string[], tests: string[], at = new Date(Date.now() + 1000).toISOString(), extra: Partial<TestResult> = {}): TestResult {
  return {
    timestamp: at,
    tested_files: tested.map((f) => join(root, f)),
    category: 'backfill-tests',
    test_files: tests.map((f) => join(root, f)),
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: `bun test ${tests.join(' ')}`, passed: 3, failed: 0, output: '3 pass', type: 'unit', duration_ms: 10 }],
    acceptance: [
      {
        id: 'BF-1',
        description: 'pins the current behavior',
        test: tests[0]!,
        red: { command: 'bun test (target broken in a scratch copy)', output: '1 fail', exit_code: 1 },
        green: { command: 'bun test', output: '3 pass', exit_code: 0 },
        mutation: { command: 'sed -i s/x/y/ (scratch copy)', output: '1 fail', detected: true, file: tested[0]! },
      },
    ],
    verdict: 'pass',
    ...extra,
  } as TestResult;
}

describe('L3: the backfill state', () => {
  test('merge: known targets keep their status; a todo target the survey drops goes, the others stay', () => {
    const s = emptyBackfill('2026-10-21T00:00:00.000Z');
    s.targets = [
      { ...target('a.ts'), status: 'done', tests: ['a.test.ts'] },
      { ...target('b.ts'), status: 'todo', batch: 1 },
      { ...target('c.ts'), status: 'todo' },
      { ...target('d.ts'), status: 'skipped', note: 'no local db' },
    ];
    const { state, added, dropped } = mergeSurvey(s, [target('b.ts', 'boundary'), target('a.ts'), target('e.ts')]);
    expect(state.targets.map((t) => [t.rel, t.status, t.kind, t.batch])).toEqual([
      ['b.ts', 'todo', 'boundary', 1],
      ['a.ts', 'done', 'code', undefined],
      ['e.ts', 'todo', 'code', undefined],
      ['d.ts', 'skipped', 'code', undefined],
    ]);
    expect([added, dropped]).toEqual([1, 1]);
    // A handed-out todo target stays even when the survey no longer lists it (code review).
    const again = mergeSurvey(state, [target('e.ts')]);
    expect([again.state.targets.map((t) => t.rel), again.dropped]).toEqual([['e.ts', 'b.ts', 'a.ts', 'd.ts'], 0]);
  });

  test('batches: rank order, an open batch comes back, picks are checked', () => {
    const s = emptyBackfill();
    s.targets = ['a', 'b', 'c', 'd'].map((r) => ({ ...target(`${r}.ts`), status: 'todo' as const }));
    const b1 = nextBatch(s, 2) as Exclude<ReturnType<typeof nextBatch>, Error>;
    expect([b1.n, b1.resumed, b1.targets.map((t) => [t.rel, t.tester])]).toEqual([1, false, [['a.ts', 'test-unit'], ['b.ts', 'test-unit']]]);
    const again = nextBatch(s, 2) as Exclude<ReturnType<typeof nextBatch>, Error>;
    expect([again.n, again.resumed, again.targets.length, s.batches.length]).toEqual([1, true, 2, 1]);
    expect(String(nextBatch(s, 2, ['c.ts']))).toContain('batch 1 is still open');
    s.targets[0]!.status = 'done';
    s.targets[1]!.status = 'skipped';
    expect(String(nextBatch(s, 2, ['zz.ts']))).toContain('zz.ts is not a target');
    expect(String(nextBatch(s, 2, ['a.ts']))).toContain('a.ts is done, not todo');
    const b2 = nextBatch(s, 5, ['d.ts']) as Exclude<ReturnType<typeof nextBatch>, Error>;
    expect([b2.n, b2.targets.map((t) => t.rel)]).toEqual([2, ['d.ts']]);
  });

  test('a UI target goes to test-ui; boundary and UI together to test-lead', () => {
    const s = emptyBackfill();
    s.targets = [
      { ...target('p.html', 'ui'), needs: ['any', 'ui'], status: 'todo' },
      { ...target('api.ts', 'boundary'), needs: ['any', 'integration'], status: 'todo' },
      { ...target('Page.tsx', 'boundary'), needs: ['any', 'integration', 'ui'], status: 'todo' },
      { ...target('util.ts'), status: 'todo' },
    ];
    const b = nextBatch(s, 5) as Exclude<ReturnType<typeof nextBatch>, Error>;
    expect(b.targets.map((t) => t.tester)).toEqual(['test-ui', 'test-unit', 'test-lead', 'test-unit']);
  });

  test('done needs a passing record made after the tests changed, naming the target and the tests', () => {
    const root = repo({ 'src/a.ts': 'x', 'src/a.test.ts': 't', 'src/b.test.ts': 't', 'notes.md': 'n' });
    const s = emptyBackfill();
    s.targets = [{ ...target('src/a.ts'), status: 'todo' }];
    const mark = (m: Parameters<typeof markTarget>[3], recs: TestResult[]) => markTarget(s, root, root, m, undefined, recs);
    const later = new Date(Date.now() + 1000).toISOString();
    expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: [] }, []))).toContain('done needs --tests');
    expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: ['notes.md'] }, []))).toContain('is not a test file');
    expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: ['../x.test.ts'] }, []))).toContain('outside the project');
    expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: ['src/a.test.ts'] }, []))).toContain('no passing layer-1 record');
    // Another target, a failing verdict or suite, no acceptance evidence: no record fits.
    const base = record(root, ['src/a.ts'], ['src/a.test.ts']);
    for (const r of [
      record(root, ['src/other.ts'], ['src/a.test.ts']),
      { ...base, verdict: 'fail' as const },
      { ...base, suites: [{ ...base.suites[0]!, passed: 0, failed: 7 }] },
      { ...base, acceptance: [] },
    ]) {
      expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: ['src/a.test.ts'] }, [r]))).toContain('no passing layer-1 record that stands on its own');
    }
    // Made before the test last changed, even with its modification time set back: the
    //   status change time counts (code review).
    const old = new Date(Date.now() - 60_000).toISOString();
    utimesSync(join(root, 'src/a.test.ts'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: ['src/a.test.ts'] }, [record(root, ['src/a.ts'], ['src/a.test.ts'], old)]))).toContain('made after src/a.test.ts last changed');
    // A record that lists the test but whose suite ran another file.
    const other = { ...base, suites: [{ ...base.suites[0]!, command: 'bun test src/b.test.ts' }] };
    expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: ['src/a.test.ts'] }, [other]))).toContain('a passing suite that ran it');
    // The mutation must be of this target.
    const elsewhere = { ...base, acceptance: [{ ...base.acceptance[0]!, mutation: { ...base.acceptance[0]!.mutation!, file: 'src/other.ts' } }] };
    expect(String(mark({ rel: 'src/a.ts', status: 'done', tests: ['src/a.test.ts'] }, [elsewhere]))).toContain('whose mutation of src/a.ts the tests detected');
    expect(s.targets[0]!.status).toBe('todo');
    // Two members' records (a test-lead batch) prove the target together (docs review).
    const one = record(root, ['src/a.ts'], ['src/a.test.ts'], later);
    const two = { ...record(root, ['src/a.ts'], ['src/b.test.ts'], later), acceptance: [{ ...one.acceptance[0]!, mutation: undefined, id: 'BF-2' }] };
    expect(mark({ rel: './src/a.ts', status: 'done', tests: [join(root, 'src/a.test.ts'), 'src/b.test.ts'] }, [one, two])).toBeNull();
    expect(s.targets[0]).toMatchObject({ status: 'done', tests: ['src/a.test.ts', 'src/b.test.ts'] });
  });

  test('suspect needs a note and evidence; skipped needs a note and no tests', () => {
    const root = repo({ 'src/a.ts': 'x', 'src/a.test.ts': 't' });
    const s = emptyBackfill();
    s.targets = [{ ...target('src/a.ts'), status: 'todo' }, { ...target('src/b.ts'), status: 'todo' }];
    const rec = record(root, ['src/a.ts'], ['src/a.test.ts']);
    expect(String(markTarget(s, root, root, { rel: 'src/a.ts', status: 'suspect', tests: ['src/a.test.ts'] }, undefined, [rec]))).toContain('suspect needs --note');
    expect(markTarget(s, root, root, { rel: 'src/a.ts', status: 'suspect', tests: ['src/a.test.ts'], note: 'returns 200 on a failed save' }, undefined, [rec])).toBeNull();
    expect(String(markTarget(s, root, root, { rel: 'src/b.ts', status: 'skipped', tests: [] }, undefined, []))).toContain('skipped needs --note');
    expect(markTarget(s, root, root, { rel: 'src/b.ts', status: 'skipped', tests: [], note: 'needs the payment gateway' }, undefined, [])).toBeNull();
    expect(s.targets.map((t) => [t.status, t.note, t.tests])).toEqual([
      ['suspect', 'returns 200 on a failed save', ['src/a.test.ts']],
      ['skipped', 'needs the payment gateway', undefined],
    ]);
  });

  test('a state goodboy did not write is refused, never overwritten', () => {
    const root = repo({ [BACKFILL_FILE]: '{"targets": "x"}' });
    expect(String(readBackfill(root))).toContain('is not a backfill state goodboy wrote');
    const r = Bun.spawnSync(['bun', CLI, 'backfill-plan'], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stderr: 'pipe' });
    expect([r.exitCode, readFileSync(join(root, BACKFILL_FILE), 'utf8')]).toEqual([1, '{"targets": "x"}']);
    // A target without its fields, or a batch number that is no integer (code review).
    const s = { ...emptyBackfill(), targets: [{ rel: 'a.ts', status: 'todo' }] };
    writeFileSync(join(root, BACKFILL_FILE), JSON.stringify(s));
    expect(readBackfill(root)).toBeInstanceOf(Error);
    writeFileSync(join(root, BACKFILL_FILE), JSON.stringify({ ...emptyBackfill(), batches: [{ n: '1', at: 'x', targets: [] }] }));
    expect(readBackfill(root)).toBeInstanceOf(Error);
    // The lock was released after the refusal.
    expect(existsSync(join(root, '.goodboy', 'test-backfill.lock'))).toBe(false);
  });

  test('a linked .goodboy dir is never written through', () => {
    const root = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const elsewhere = dir('goodboy-l-elsewhere-');
    symlinkSync(elsewhere, join(root, '.goodboy'));
    const r = Bun.spawnSync(['bun', CLI, 'backfill-plan'], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, stderr: 'pipe' });
    expect([r.exitCode, r.stderr.toString().includes('is a link or not a directory'), readdirSync(elsewhere)]).toEqual([1, true, []]);
  });

  test('docs review (high): a tool setup can pass — runner configs need no test, Gradle Kotlin scripts no coverage', () => {
    const root = repo({ 'vitest.config.ts': 'export default {};\n', 'jest.config.js': 'module.exports = {};\n', 'build.gradle.kts': 'plugins { jacoco }\n', 'src/a.ts': 'export const a = () => 1;\n' });
    expect(['vitest.config.ts', 'jest.config.js', 'src/a.ts'].map((f) => needsTests(join(root, f), root))).toEqual([false, false, true]);
    // A runner-config name linked to code is code.
    symlinkSync(join(root, 'src/a.ts'), join(root, 'playwright.config.ts'));
    expect(needsTests(join(root, 'playwright.config.ts'), root)).toBe(true);
    const gaps = (f: string) => changedLineGaps({ results: [], edits: [{ file: join(root, f), lastEditTimestamp: new Date().toISOString() } as ChangedFileEdit], top: root, exempt: [] });
    expect(gaps('build.gradle.kts')).toEqual({ measured: true, gaps: [] });
    expect(gaps('src/a.ts').gaps.length + (gaps('src/a.ts').measured ? 0 : 1)).toBeGreaterThan(0);
  });

  test('marks run in parallel keep each other (the lock)', async () => {
    const root = repo({});
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    put(root, Object.fromEntries(names.map((n) => [`src/${n}.ts`, `export const ${n} = 1;\n`])));
    expect(Bun.spawnSync(['bun', CLI, 'backfill-plan'], { cwd: root, env }).exitCode).toBe(0);
    const procs = names.map((n) => Bun.spawn(['bun', CLI, 'backfill-mark', `src/${n}.ts`, '--status', 'skipped', '--note', 'no seam'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' }));
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual(names.map(() => 0));
    const st = readBackfill(root) as Exclude<ReturnType<typeof readBackfill>, Error>;
    expect(st.targets.filter((t) => t.status === 'skipped').length).toBe(names.length);
  }, 30_000);

  test('CLI: plan, next, mark with a record from the project dir, status', () => {
    const root = jvmProject();
    const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(['bun', CLI, ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    expect(run('backfill-next').err).toContain('run backfill-plan first');
    const plan = run('backfill-plan');
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.out)).toMatchObject({ added: 3, dropped: 0, counts: { todo: 3, done: 0, skipped: 0, suspect: 0 } });
    const next = JSON.parse(run('backfill-next', '--size', '1').out) as { n: number; targets: { rel: string; tester: string }[] };
    expect([next.n, next.targets.map((t) => [t.rel, t.tester])]).toEqual([1, [['src/main/java/com/acme/user/UserController.java', 'test-unit']]]);
    const ctl = 'src/main/java/com/acme/user/UserController.java';
    const testRel = 'src/test/java/com/acme/user/UserControllerTest.java';
    put(root, { [testRel]: 'class UserControllerTest { @Test void a() { assertThat(1).isOne(); } }\n' });
    expect(run('backfill-mark', ctl, '--status', 'done', '--tests', testRel).err).toContain('no passing layer-1 record');
    const rec = record(root, [ctl], [testRel], new Date(Date.now() + 1000).toISOString());
    put(root, { '.claude/tests/2026-10-21T00-00-00.json': JSON.stringify(rec) });
    const marked = run('backfill-mark', ctl, '--status', 'done', '--tests', testRel);
    expect([marked.code, marked.err]).toEqual([0, '']);
    expect(JSON.parse(run('backfill-status').out)).toMatchObject({ counts: { todo: 2, done: 1 }, batches: 1, open: [] });
    // A re-plan keeps the done target; the survey now finds it named by its test.
    expect(JSON.parse(run('backfill-plan').out)).toMatchObject({ counts: { todo: 2, done: 1 } });
    expect(readdirSync(join(root, '.goodboy')).sort()).toEqual(['test-backfill.json']);
  });
});
