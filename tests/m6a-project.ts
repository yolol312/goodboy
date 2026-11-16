// A project with the fake docker (tests/m6a-fake.ts) in place, for tests/m6a-*.test.ts (track M,
// M6a; plan §19): its scan, local file and compose file, the docker answers that make the sandbox
// check pass, and ways to run a `sandbox-*` command through the CLI (what a model would see) or in
// this process.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { projectName, SANDBOX_DIR } from '../lib/sandbox-mode';
import { SCAN_FILE } from '../lib/sandbox-render';
import { type Ctx, loadCtx, sandboxCommand } from '../lib/sandbox-run';
import type { SandboxLocal, SandboxScan } from '../lib/sandbox-types';
import { FAKE_DOCKER } from './m6a-fake';

export const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');

/** A JVM project with one Postgres store and no outbound host: the check needs no dummy. */
export function plainScan(): SandboxScan {
  return {
    root: '/nonexistent/repo',
    stack: 'jvm',
    frameworks: ['spring-boot'],
    build: {
      tool: 'gradle',
      runtimeVersion: '17',
      depsCommand: ['./gradlew', 'dependencies'],
      buildCommand: ['./gradlew', 'bootJar', '-x', 'test'],
      testCommand: ['./gradlew', 'test', '--offline'],
      startCommand: ['java', '-jar', 'build/libs/app.jar'],
      artifact: 'build/libs/app.jar',
    },
    app: { port: 8080, contextPath: '/', healthPath: '/actuator/health', configFiles: [] },
    stores: [{ kind: 'postgres', version: '15', database: 'shop', configKeys: [], where: { file: 'application.yml', line: 3 } }],
    outbound: [],
    secretKeys: [],
    questions: [],
    problems: [],
  };
}

export interface FakeProject {
  root: string;
  state: string;
  bin: string;
  /** The dir of this project's user-level registry of real-data sandboxes (GOODBOY_REGISTRY_DIR of its commands). */
  registry: string;
  ctx: Ctx;
  /** The docker calls so far, one per line (a reader call by its kind). */
  calls: () => string[];
  /** The command through the CLI: what a model would see. */
  cli: (args: string[], env?: Record<string, string>) => { code: number; stdout: string; stderr: string };
  /** The same command in this process (faster). `text` is the JSON the CLI would print or the error message. */
  inproc: (command: string, args?: string[], env?: Record<string, string>) => Promise<{ out: Record<string, any>; code: number; error?: string; text: string }>;
  /** The files below `.goodboy/sandbox/out/`, relative to it. */
  hostFiles: () => string[];
}

const made: string[] = [];
/** The registry dir the process had before the first fake project pointed it at its own (restored by the cleanup). */
let registryBefore: { value: string | undefined } | null = null;
export function cleanupFakeProjects(): void {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
  if (registryBefore !== null) {
    if (registryBefore.value === undefined) delete process.env.GOODBOY_REGISTRY_DIR;
    else process.env.GOODBOY_REGISTRY_DIR = registryBefore.value;
    registryBefore = null;
  }
}

const tmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
};

/** A project whose sandbox check passes against the fake docker, with `local` as its local.json
 *  (null: none). The e2e dir has one test, so `--suite all` runs both suites. */
export function fakeProject(local: SandboxLocal | null, scan: SandboxScan = plainScan()): FakeProject {
  const root = tmp('goodboy-m6a-');
  mkdirSync(join(root, SANDBOX_DIR), { recursive: true });
  writeFileSync(join(root, SCAN_FILE), JSON.stringify({ ...scan, root }));
  if (local !== null) writeFileSync(join(root, SANDBOX_DIR, 'local.json'), JSON.stringify(local));
  writeFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'services: {}\n');
  mkdirSync(join(root, 'e2e'), { recursive: true });
  writeFileSync(join(root, 'e2e', 'a.spec.ts'), 'export {};\n');
  const state = tmp('goodboy-m6a-fake-');
  const bin = join(state, 'docker');
  writeFileSync(bin, FAKE_DOCKER);
  chmodSync(bin, 0o755);
  const ctx = loadCtx(root, true);
  if (ctx instanceof Error) throw ctx;
  const p = projectName(root);
  const inner = `${p}_inner`;
  const opts = { 'com.docker.network.bridge.inhibit_ipv4': 'true' };
  const w = (f: string, text: string) => writeFileSync(join(state, f), text);
  w('config.json', JSON.stringify(Bun.YAML.parse(ctx.plan.files.get('compose.yml')!)));
  // the runs volume exists (a project that has run before): the sweep has something to look at
  w('volumes.txt', `${p}_runout\n`);
  w('ps.txt', 'id-db\n');
  w('inspect.json', JSON.stringify([{ Id: 'id-db', Name: `/${p}-db-1`, Config: { Labels: { 'com.docker.compose.service': 'db' } }, HostConfig: { NetworkMode: inner }, NetworkSettings: { Networks: { [inner]: { IPAddress: '10.231.0.6' } } } }]));
  w('network.json', JSON.stringify([{ Name: inner, Internal: true, Options: opts, IPAM: { Config: [{ Subnet: '10.231.0.0/24' }] } }]));
  w('probe.txt', 'CTL_DNS=ok\nCTL_NC=ok\nCTL_WGET=ok\nCTL_PING=ok\nDNS=blocked\nTCP=blocked\nHTTP=blocked\nGW_PING=blocked\nGW_TCP=blocked\n@@END\n');
  w('playwright-report.json', JSON.stringify(passingReport()));
  w('access.log', '{"request":{"method":"GET","uri":"/","headers":{}},"status":200}\n');
  // each project has a registry of its own (lib/sandbox-registry.ts): a test never writes the developer's, and never
  // fills the one of the whole run
  const registry = tmp('goodboy-m6a-registry-');
  registryBefore ??= { value: process.env.GOODBOY_REGISTRY_DIR };
  process.env.GOODBOY_REGISTRY_DIR = registry;
  const env = (extra: Record<string, string> = {}): Record<string, string> => ({ GOODBOY_DOCKER_BIN: bin, FAKE_DOCKER_DIR: state, CLAUDE_PROJECT_DIR: root, GOODBOY_REGISTRY_DIR: registry, ...extra });
  const hostFiles = (): string[] => {
    const out: string[] = [];
    const walk = (rel: string): void => {
      for (const n of readdirSync(join(root, SANDBOX_DIR, 'out', rel), { withFileTypes: true })) {
        if (n.isDirectory()) walk(join(rel, n.name));
        else out.push(join(rel, n.name));
      }
    };
    if (existsSync(join(root, SANDBOX_DIR, 'out'))) walk('');
    return out;
  };
  return {
    root,
    state,
    bin,
    registry,
    ctx,
    calls: () => (existsSync(join(state, 'calls.log')) ? readFileSync(join(state, 'calls.log'), 'utf8').trim().split('\n') : []),
    cli: (args, extra = {}) => {
      const r = Bun.spawnSync(['bun', CLI, ...args], { cwd: root, env: { ...process.env, ...env(extra) }, stdout: 'pipe', stderr: 'pipe' });
      return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    },
    inproc: async (command, args = [], extra = {}) => {
      const e = env(extra);
      const saved = Object.keys(e).map((k) => [k, process.env[k]] as const);
      for (const [k, v] of Object.entries(e)) process.env[k] = v;
      try {
        const r = await sandboxCommand(command, root, args);
        if ('error' in r) return { out: {}, code: 1, error: r.error, text: r.error };
        return { out: r.out as Record<string, any>, code: r.code, text: JSON.stringify(r.out, null, 2) };
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    },
    hostFiles,
  };
}

/** A Playwright JSON report with one passing test (the shape `ui-check` and the summary read). */
export function passingReport(): Record<string, unknown> {
  return {
    stats: { startTime: 'x', duration: 5, expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 't', file: 'a.spec.ts', tests: [{ status: 'expected', expectedStatus: 'passed', annotations: [], results: [{ status: 'passed' }] }] }] }],
  };
}

/** Every file under `dir` (recursive, links not followed) as `[relative path, text]`. */
export function filesUnder(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = join(rel, n.name);
      if (n.isDirectory()) walk(r);
      else if (n.isFile() && statSync(join(dir, r)).size < 50 * 1024 * 1024) out.push([r, readFileSync(join(dir, r), 'utf8')]);
    }
  };
  if (existsSync(dir)) walk('');
  return out;
}
