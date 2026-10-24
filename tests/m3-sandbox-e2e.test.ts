// Track M, M3 (plan §19): the logging proxy, the Playwright service, the `uiTest` fixture and the
// coverage plumbing of the sandbox, as rendered. The runs with a fake docker are in
// tests/m1-sandbox.test.ts; one opt-in test here uses a real docker (GOODBOY_DOCKER_IT=1): a caddy
// proxy in front of a busybox httpd on an internal network must log a request with its
// `X-Goodboy-Ui` header as one JSON line.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGES, planSandbox } from '../lib/sandbox-render';
import { C8_VERSION, caddyfile, COVERAGE_PY_VERSION, JACOCO_VERSION, lcovMergeScript, PLAYWRIGHT_DEFAULT, playwrightVersion, uiFixture } from '../lib/sandbox-e2e';
import { staticProblems } from '../lib/sandbox-run';
import type { SandboxLocal, SandboxScan, SandboxStack } from '../lib/sandbox-types';
import { parseAccessLog } from '../lib/ui-check';

setDefaultTimeout(240_000);

const NO_DUMP: SandboxLocal = { dump: null, dumpFormat: null };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function scan(stack: SandboxStack, over: Partial<SandboxScan> = {}): SandboxScan {
  const build = {
    jvm: { tool: 'gradle', runtimeVersion: '21', depsCommand: ['./gradlew', 'dependencies'], buildCommand: ['./gradlew', 'bootJar'], testCommand: ['./gradlew', 'test', '--offline'], startCommand: ['java', '-jar', 'build/libs/app.jar'], artifact: 'build/libs/app.jar' },
    node: { tool: 'npm', runtimeVersion: '20', depsCommand: ['npm', 'ci'], buildCommand: ['npm', 'run', 'build'], testCommand: ['npm', 'test'], startCommand: ['npm', 'start'], artifact: '.next' },
    python: { tool: 'pip', runtimeVersion: '3.12', depsCommand: ['pip', 'install', '-r', 'requirements.txt'], buildCommand: [], testCommand: ['python', '-m', 'pytest'], startCommand: ['uvicorn', 'main:app', '--host', '0.0.0.0'], artifact: null },
  }[stack];
  return {
    root: '/nonexistent',
    stack,
    frameworks: [],
    build,
    app: { port: stack === 'node' ? 3000 : stack === 'python' ? 8000 : 9090, contextPath: '/', healthPath: '/', configFiles: [] },
    stores: [],
    outbound: [],
    secretKeys: [],
    questions: [],
    problems: [],
    ...over,
  };
}

interface Svc {
  image: string;
  profiles?: string[];
  networks?: string[] | Record<string, unknown>;
  ports?: unknown[];
  volumes?: string[];
  environment?: Record<string, string>;
  command?: string[];
  entrypoint?: string[];
  depends_on?: Record<string, { condition: string }>;
}
interface Compose {
  services: Record<string, Svc>;
  networks: Record<string, { internal?: boolean }>;
  volumes: Record<string, unknown>;
}

const plan = (s: SandboxScan, read: (rel: string) => string | null = () => null) => planSandbox(s, NO_DUMP, { readConfig: read });
const compose = (p: { files: Map<string, string> }): Compose => Bun.YAML.parse(p.files.get('compose.yml')!) as Compose;
const nets = (s: Svc): string[] => (s.networks === undefined ? [] : Array.isArray(s.networks) ? s.networks : Object.keys(s.networks));

describe('the proxy and the e2e service', () => {
  for (const stack of ['jvm', 'node', 'python'] as const) {
    test(`${stack}: proxy and e2e are on internal networks only, with no published port, and the compose file passes the static check`, () => {
      const p = plan(scan(stack));
      const c = compose(p);
      for (const name of ['proxy', 'e2e']) {
        const s = c.services[name]!;
        expect(s.ports).toBeUndefined();
        expect(nets(s)).toEqual(['inner']);
        expect(c.networks.inner!.internal).toBe(true);
        expect(s.profiles ?? []).not.toContain('prep');
      }
      expect(c.services['e2e-prep']!.profiles).toEqual(['prep']);
      expect(nets(c.services['e2e-prep']!)).toEqual(['prep']);
      // docker compose config's JSON has the same shape the run-time check reads
      expect(staticProblems({ services: Object.fromEntries(Object.entries(c.services).map(([n, s]) => [n, { ...s, networks: Object.fromEntries(nets(s).map((x) => [x, {}])) }])), networks: c.networks })).toEqual([]);
      expect(p.hasE2e).toBe(true);
    });
  }

  test('the proxy is a pinned caddy that forwards to the app port and logs JSON with every header into the shared dir', () => {
    const p = plan(scan('jvm'));
    const proxy = compose(p).services.proxy!;
    expect(proxy.image).toBe(IMAGES.proxy);
    expect(IMAGES.proxy).toMatch(/^caddy:\d+\.\d+\.\d+-alpine$/);
    expect(proxy.volumes).toEqual(['./proxy/Caddyfile:/etc/caddy/Caddyfile:ro', './out/live:/live']);
    const cf = p.files.get('proxy/Caddyfile')!;
    expect(cf).toContain('reverse_proxy app:9090');
    expect(cf).toContain('output file /live/access.log');
    expect(cf).toContain('format json');
    expect(cf).toContain(':8080 {');
    expect(cf).toContain('admin off');
    expect(cf).toBe(caddyfile(9090));
    expect(p.proxyHealthUrl).toBe('http://proxy:8080/');
    expect(plan(scan('jvm', { app: { port: 8081, contextPath: '/shop', healthPath: '/actuator/health', configFiles: [] } })).proxyHealthUrl).toBe('http://proxy:8080/shop/actuator/health');
  });

  test('the e2e service is a pinned Playwright image with the proxy as its base URL and the e2e dir mounted', () => {
    const p = plan(scan('jvm'));
    const e2e = compose(p).services.e2e!;
    expect(e2e.image).toBe(`mcr.microsoft.com/playwright:v${PLAYWRIGHT_DEFAULT}-jammy`);
    expect(e2e.profiles).toEqual(['tools']);
    expect(e2e.environment).toMatchObject({ GOODBOY_BASE_URL: 'http://proxy:8080', GOODBOY_E2E_DIR: '/work/e2e' });
    expect(e2e.volumes).toEqual(['../..:/work', 'e2edeps:/work/node_modules']);
    expect(e2e.command).toEqual(['/work/node_modules/.bin/playwright', 'test', '--config', '/work/.goodboy/sandbox/e2e/playwright.config.ts']);
    expect(e2e.depends_on).toEqual({ proxy: { condition: 'service_started' } });
    expect(compose(p).volumes).toHaveProperty('e2edeps');
  });

  test('the Playwright version is the one the project\'s e2e dir uses, else a pinned default', () => {
    const files = (m: Record<string, string>) => (rel: string) => m[rel] ?? null;
    expect(playwrightVersion(files({}))).toBe(PLAYWRIGHT_DEFAULT);
    expect(playwrightVersion(files({ 'e2e/package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.44.1' } }) }))).toBe('1.44.1');
    expect(playwrightVersion(files({ 'e2e/package.json': JSON.stringify({ dependencies: { '@playwright/test': '~1.40.0' } }) }))).toBe('1.40.0');
    expect(playwrightVersion(files({ 'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '1.50.0' } }) }))).toBe('1.50.0');
    // the lock file is exact and wins over a range
    expect(
      playwrightVersion(files({ 'e2e/package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.40.0' } }), 'e2e/package-lock.json': JSON.stringify({ packages: { 'node_modules/@playwright/test': { version: '1.47.2' } } }) })),
    ).toBe('1.47.2');
    // not an exact version, not JSON: the default
    expect(playwrightVersion(files({ 'e2e/package.json': JSON.stringify({ devDependencies: { '@playwright/test': 'latest' } }) }))).toBe(PLAYWRIGHT_DEFAULT);
    expect(playwrightVersion(files({ 'e2e/package.json': 'not json' }))).toBe(PLAYWRIGHT_DEFAULT);
    const p = plan(scan('jvm'), files({ 'e2e/package.json': JSON.stringify({ devDependencies: { '@playwright/test': '1.44.1' } }) }));
    expect(compose(p).services.e2e!.image).toBe('mcr.microsoft.com/playwright:v1.44.1-jammy');
    expect(compose(p).services['e2e-prep']!.image).toBe('mcr.microsoft.com/playwright:v1.44.1-jammy');
    expect(compose(p).services['e2e-prep']!.environment).toMatchObject({ E2E_PLAYWRIGHT_VERSION: '1.44.1' });
  });

  test('the e2e preparation installs into a volume with the network on, forces the image\'s version, and never sees the dump', () => {
    const p = planSandbox(scan('jvm'), { dump: '/d/x.sql', dumpFormat: 'sql' }, { readConfig: () => null });
    const prep = compose(p).services['e2e-prep']!;
    expect(prep.volumes).toEqual(['../..:/src:ro', 'e2edeps:/deps', './runtime/e2e-prep.sh:/sandbox/e2e-prep.sh:ro']);
    expect(prep.volumes!.some((v) => v.includes('dump') || v.includes('GOODBOY_DUMP'))).toBe(false);
    const script = p.files.get('runtime/e2e-prep.sh')!;
    expect(script).toContain('npm ci --ignore-scripts');
    expect(script).toContain('"@playwright/test@$VERSION"');
    expect(script).toContain('cp -a node_modules/. /deps/');
  });

  test('no app, no proxy and no e2e service', () => {
    const s = scan('jvm');
    s.build.startCommand = [];
    const p = plan(s);
    expect(Object.keys(compose(p).services)).not.toContain('proxy');
    expect(Object.keys(compose(p).services)).not.toContain('e2e');
    expect(p.hasE2e).toBe(false);
    expect(p.files.has('e2e/goodboy-ui.ts')).toBe(false);
  });

  test('a service or a host named like the new services is not given a dummy alias', () => {
    const s = scan('jvm', { outbound: [{ host: 'proxy', port: 443, scheme: 'https', kind: 'http', where: { file: 'a.yml', line: 1 }, callSite: { file: 'A.java', line: 1 }, hardcoded: false, ipLiteral: false }] });
    expect(plan(s).notes.some((n) => n.includes('name of a sandbox service'))).toBe(true);
  });
});

describe('the uiTest fixture and the Playwright config', () => {
  const p = plan(scan('jvm'));

  test('the fixture sets the header for every request of the test and records the claims as annotations', () => {
    const f = p.files.get('e2e/goodboy-ui.ts')!;
    expect(f).toBe(uiFixture());
    expect(f).toContain("export const HEADER = 'x-goodboy-ui'");
    expect(f).toContain("extraHTTPHeaders: { [HEADER]: ids.join(','), [NONCE_HEADER]: nonce }");
    expect(f).toContain('testInfo.annotations.push({ type: ANNOTATION, description: c })');
    expect(f).toContain("export const ANNOTATION = 'goodboy-ui'");
    // a nonce per test joins its requests to it in ui-check (the behavior is run in tests/m-fix-b-e2e.test.ts)
    expect(f).toContain("export const NONCE_HEADER = 'x-goodboy-test'");
    expect(f).toContain("export const NONCE_ANNOTATION = 'goodboy-test'");
    expect(f).toContain('export function uiTest(ids: string[], title: string');
    // a claim is checked before the test runs: <id>:ok|error, ASCII, no comma
    expect(f).toContain('is not <id>:ok|error');
  });

  test('the config runs the project\'s e2e dir against the proxy and keeps traces for failing tests only', () => {
    const f = p.files.get('e2e/playwright.config.ts')!;
    expect(f).toContain("baseURL: process.env.GOODBOY_BASE_URL ?? 'http://proxy:8080'");
    expect(f).toContain("testDir: process.env.GOODBOY_E2E_DIR ?? '/work/e2e'");
    expect(f).toContain("outputDir: '/out/e2e-artifacts'");
    expect(f).toContain("preserveOutput: 'failures-only'");
    expect(f).toContain("trace: 'retain-on-failure'");
    expect(f).toContain("screenshot: 'only-on-failure'");
    expect(f).toContain("outputFile: '/out/playwright-report.json'");
    expect(f).toContain('retries: 0');
  });
});

describe('coverage across the unit and the e2e run', () => {
  test('JVM: the JaCoCo jars are fetched in prep with their checksums into a volume; the app and the runner load the agent through the entrypoint', () => {
    const p = plan(scan('jvm'));
    const c = compose(p);
    const prep = p.files.get('runtime/prep.sh')!;
    expect(prep).toContain(`org.jacoco.agent/${JACOCO_VERSION}/org.jacoco.agent-${JACOCO_VERSION}-runtime.jar`);
    expect(prep).toContain(`org.jacoco.cli/${JACOCO_VERSION}/org.jacoco.cli-${JACOCO_VERSION}-nodeps.jar`);
    expect(prep).toContain('sha1sum -c -');
    expect(prep).toMatch(/jacocoagent\.jar org\.jacoco\.agent\/[\d.]+\/\S+ [0-9a-f]{40}/);
    expect(c.services.prep!.volumes).toContain('jacoco:/jacoco');
    expect(c.services.app!.volumes).toEqual(expect.arrayContaining(['jacoco:/jacoco:ro', './out/live:/live']));
    expect(c.services.runner!.volumes).toEqual(expect.arrayContaining(['jacoco:/jacoco', 'build:/build:ro', './out/live:/live', './runtime/coverage.sh:/sandbox/coverage.sh:ro']));
    expect(c.services.app!.environment).toMatchObject({ GOODBOY_COVERAGE_OUT: '/live/jacoco-e2e.exec', GOODBOY_COVERAGE_APPEND: 'false' });
    expect(c.services.runner!.environment).toMatchObject({ GOODBOY_COVERAGE_OUT: '/out/coverage-raw/unit/jacoco.exec', GOODBOY_COVERAGE_APPEND: 'true' });
    const entry = p.files.get('runtime/entrypoint.sh')!;
    expect(entry).toContain('-javaagent:/jacoco/jacocoagent.jar=output=file,destfile=${GOODBOY_COVERAGE_OUT}');
    // the agent goes in after the CA import, so keytool is not instrumented
    expect(entry.indexOf('keytool -importcert')).toBeLessThan(entry.indexOf('JAVA_TOOL_OPTIONS'));
    expect(entry.trimEnd().endsWith('exec "$@"')).toBe(true);
    const sh = p.files.get('runtime/coverage.sh')!;
    expect(sh).toContain('jacococli.jar merge $EXECS --destfile /out/coverage-raw/merged.exec');
    expect(sh).toContain('--xml /out/coverage/jacoco.xml');
    expect(sh).toContain('mv /live/jacoco-e2e.exec /out/coverage-raw/e2e/jacoco.exec');
    expect(sh).toContain('/build/classes/java/main');
    expect(sh).toContain('--sourcefiles');
  });

  test('Node: c8 is installed in prep; the app writes V8 coverage and flushes it on SIGTERM; the report is lcov with repo-relative paths', () => {
    const p = plan(scan('node'));
    const c = compose(p);
    expect(p.files.get('runtime/prep.sh')).toContain(`npm install --prefix /goodboy-tools --no-save --no-package-lock --ignore-scripts --no-audit --no-fund c8@${C8_VERSION}`);
    expect(c.services.app!.environment).toMatchObject({ NODE_V8_COVERAGE: '/live/v8-e2e', NODE_OPTIONS: '--require /sandbox/flush.cjs' });
    expect(c.services.app!.volumes).toContain('./runtime/flush.cjs:/sandbox/flush.cjs:ro');
    expect(c.services.runner!.environment).toMatchObject({ NODE_V8_COVERAGE: '/out/coverage-raw/unit/v8' });
    expect(c.services.runner!.volumes).toContain('tools:/goodboy-tools');
    expect(p.files.get('runtime/flush.cjs')).toContain("process.once(sig");
    const sh = p.files.get('runtime/coverage.sh')!;
    // c8 reads a file only below its working dir: the unit data from /work, the e2e data from /build
    expect(sh).toContain('(cd /work && "$C8" report --temp-directory /out/coverage-raw/unit/v8 --reporter lcovonly');
    expect(sh).toContain('(cd /build && "$C8" report --temp-directory /out/coverage-raw/e2e --reporter lcovonly');
    expect(sh).toContain('node /sandbox/lcov-merge.cjs /out/coverage/lcov.info $PARTS');
    expect(c.services.runner!.volumes).toContain('./runtime/lcov-merge.cjs:/sandbox/lcov-merge.cjs:ro');
    expect(p.files.get('runtime/lcov-merge.cjs')).toBe(lcovMergeScript());
  });

  test('lcov-merge.cjs adds the hits of the unit and the e2e report into one record per file', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m3-lcov-')));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'merge.cjs'), lcovMergeScript());
    writeFileSync(join(dir, 'unit.info'), 'SF:src/a.js\nFN:1,f\nFNDA:2,f\nDA:1,2\nDA:2,0\nBRDA:2,0,0,0\nBRDA:2,0,1,-\nend_of_record\nSF:src/b.js\nDA:1,1\nend_of_record\n');
    writeFileSync(join(dir, 'e2e.info'), 'SF:src/a.js\nFN:1,f\nFNDA:1,f\nDA:1,1\nDA:2,3\nBRDA:2,0,0,1\nBRDA:2,0,1,-\nend_of_record\nSF:src/c.js\nDA:5,0\nend_of_record\n');
    const r = Bun.spawnSync([process.execPath, join(dir, 'merge.cjs'), join(dir, 'out.info'), join(dir, 'unit.info'), join(dir, 'e2e.info')], { stdout: 'pipe', stderr: 'pipe' });
    expect(r.stderr.toString()).toBe('');
    expect(r.exitCode).toBe(0);
    const out = readFileSync(join(dir, 'out.info'), 'utf8');
    expect(out.match(/^SF:/gm)).toHaveLength(3);
    const a = out.slice(out.indexOf('SF:src/a.js'), out.indexOf('SF:src/b.js'));
    expect(a).toContain('FNDA:3,f');
    expect(a).toContain('DA:1,3');
    expect(a).toContain('DA:2,3');
    expect(a).toContain('BRDA:2,0,0,1');
    expect(a).toContain('BRDA:2,0,1,-');
    expect(a).toContain('LF:2\nLH:2');
    expect(a).toContain('BRF:2\nBRH:1');
    expect(out).toContain('SF:src/c.js\nFNF:0\nFNH:0\nBRF:0\nBRH:0\nDA:5,0\nLF:1\nLH:0');
    expect(Bun.spawnSync([process.execPath, join(dir, 'merge.cjs')], { stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(2);
  });

  test('Python: coverage.py and its startup hook are installed in prep; the app and the runner write their own data files; the report is Cobertura XML', () => {
    const p = plan(scan('python'));
    const c = compose(p);
    const prep = p.files.get('runtime/prep.sh')!;
    expect(prep).toContain(`pip install --only-binary=:all: --no-deps coverage==${COVERAGE_PY_VERSION}`);
    expect(prep).toContain('goodboy-coverage.pth');
    expect(prep).toContain('coverage.process_startup()');
    expect(c.services.app!.environment).toMatchObject({ COVERAGE_PROCESS_START: '/sandbox/coveragerc', COVERAGE_FILE: '/live/py-e2e/.coverage' });
    expect(c.services.runner!.environment).toMatchObject({ COVERAGE_PROCESS_START: '/sandbox/coveragerc', COVERAGE_FILE: '/out/coverage-raw/unit/py/.coverage' });
    expect(c.services.app!.volumes).toContain('./runtime/coveragerc:/sandbox/coveragerc:ro');
    expect(p.files.get('runtime/coveragerc')).toContain('parallel = True');
    expect(p.files.get('runtime/coveragerc')).toContain('relative_files = True');
    const sh = p.files.get('runtime/coverage.sh')!;
    expect(sh).toContain('coverage combine --keep');
    expect(sh).toContain('coverage xml');
    expect(sh).toContain('-o /out/coverage/coverage.xml');
  });

  test('a poetry or uv project gets a note: the hook is for the system Python only', () => {
    const s = scan('python');
    s.build.tool = 'poetry';
    const p = plan(s);
    expect(p.notes.some((n) => n.includes('poetry or uv'))).toBe(true);
    expect(p.files.get('runtime/prep.sh')).toContain('poetry or uv environment');
  });

  test('the report script takes e2e data of /live only in report-e2e mode, and exits with a distinct code per failure', () => {
    for (const stack of ['jvm', 'node', 'python'] as const) {
      const sh = plan(scan(stack)).files.get('runtime/coverage.sh')!;
      expect(sh).toContain('report-e2e) stage=1 ;;');
      expect(sh).toContain('exit 4');
      expect(sh).toContain('exit 3');
      expect(sh).toContain('"$stage" = 1');
      expect(sh).toContain('exit 2');
    }
  });

  test('no rendered shell script has a syntax error', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m3-sh-')));
    tmpDirs.push(dir);
    for (const stack of ['jvm', 'node', 'python'] as const) {
      const files = plan(scan(stack)).files;
      for (const rel of ['runtime/coverage.sh', 'runtime/prep.sh', 'runtime/entrypoint.sh', 'runtime/e2e-prep.sh']) {
        const text = files.get(rel);
        if (text === undefined) continue;
        const f = join(dir, `${stack}-${rel.replace(/\W/g, '_')}.sh`);
        writeFileSync(f, text);
        const r = Bun.spawnSync(['sh', '-n', f], { stdout: 'pipe', stderr: 'pipe' });
        expect({ stack, rel, err: r.stderr.toString() }).toEqual({ stack, rel, err: '' });
      }
    }
  });
});

// ---- a real docker: opt in with GOODBOY_DOCKER_IT=1 (pulls caddy and busybox, both small) ----

describe.skipIf(process.env.GOODBOY_DOCKER_IT !== '1')('real docker: the logging proxy', () => {
  const docker = (args: string[]) => Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });

  test('a request with the X-Goodboy-Ui header through the proxy appears in the JSON log; the app only answers behind the proxy', () => {
    const base = realpathSync(mkdtempSync(join(process.env.HOME ?? tmpdir(), '.goodboy-m3-it-')));
    tmpDirs.push(base);
    const live = join(base, 'live');
    mkdirSync(live);
    chmodSync(live, 0o755);
    writeFileSync(join(base, 'Caddyfile'), caddyfile(8080));
    const tag = `gbm3-${Math.random().toString(36).slice(2, 8)}`;
    const net = `${tag}-net`;
    const names = [`${tag}-app`, `${tag}-proxy`];
    try {
      expect(docker(['network', 'create', '--internal', net]).exitCode).toBe(0);
      const app = docker(['run', '-d', '--name', names[0]!, '--network', net, '--network-alias', 'app', IMAGES.probe, 'sh', '-c', 'echo hello > /tmp/index.html; mkdir -p /tmp/orders; echo orders > /tmp/orders/index.html; exec httpd -f -p 8080 -h /tmp']);
      expect(app.stderr.toString()).toBe('');
      expect(app.exitCode).toBe(0);
      const validate = docker(['run', '--rm', '-v', `${join(base, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${live}:/live`, IMAGES.proxy, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
      expect({ exit: validate.exitCode, err: validate.stderr.toString().includes('Error') }).toEqual({ exit: 0, err: false });
      const proxy = docker(['run', '-d', '--name', names[1]!, '--network', net, '--network-alias', 'proxy', '-v', `${join(base, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${live}:/live`, IMAGES.proxy, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
      expect(proxy.stderr.toString()).toBe('');
      expect(proxy.exitCode).toBe(0);
      // a client on the same internal network: busybox wget with the header
      const get = (path: string, header?: string) => {
        for (let i = 0; i < 20; i++) {
          const r = docker(['run', '--rm', '--network', net, IMAGES.probe, 'wget', '-q', '-T', '3', '-O', '-', ...(header ? [`--header=X-Goodboy-Ui: ${header}`] : []), `http://proxy:8080${path}`]);
          if (r.exitCode === 0) return r.stdout.toString();
          Bun.sleepSync(500);
        }
        throw new Error(`the proxy never answered ${path}`);
      };
      expect(get('/', 'screen:GET:/:ok')).toContain('hello');
      expect(get('/orders/?x=1', 'screen:GET:/orders:ok,link:GET:/orders/new:ok')).toContain('orders');
      get('/orders/');
      // the log is a file in the shared dir the host can read
      const log = readFileSync(join(live, 'access.log'), 'utf8');
      const problems: string[] = [];
      const reqs = parseAccessLog(log, 'access.log', problems);
      expect(problems).toEqual([]);
      const home = reqs.find((r) => r.path === '/' && r.claims.has('screen:GET:/:ok'));
      expect(home).toMatchObject({ method: 'GET', status: 200 });
      const orders = reqs.find((r) => r.path === '/orders' && r.claims.size === 2);
      expect([...orders!.claims].sort()).toEqual(['link:GET:/orders/new:ok', 'screen:GET:/orders:ok']);
      expect(reqs.some((r) => r.path === '/orders' && r.claims.size === 0)).toBe(true);
      // the same log through the container, as `sandbox-run` truncates it
      expect(docker(['exec', names[1]!, 'sh', '-c', ': > /live/access.log']).exitCode).toBe(0);
      expect(readFileSync(join(live, 'access.log'), 'utf8')).toBe('');
    } finally {
      for (const n of names) docker(['rm', '-f', n]);
      docker(['network', 'rm', net]);
    }
  });
});
