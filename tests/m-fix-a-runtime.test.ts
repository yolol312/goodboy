// Track M fix round 1, fixer A (plan §19): the sandbox's runtime scripts and compose details —
// the start command with a glob (A1), the health URL (A2) — run against fake tools in temp dirs.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImage, testPhasePrep } from '../lib/sandbox-parts';
import { planSandbox } from '../lib/sandbox-render';
import { probeScript } from '../lib/sandbox-run';
import type { SandboxLocal, SandboxScan } from '../lib/sandbox-types';

setDefaultTimeout(60_000);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function dir(prefix = 'goodboy-mfa-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const NO_DUMP: SandboxLocal = { dump: null, dumpFormat: null };

/** A small JVM scan: no stores, no outbound hosts. */
function scanOf(over: Partial<SandboxScan['build']> = {}, app: Partial<SandboxScan['app']> = {}): SandboxScan {
  return {
    root: '/nonexistent/repo',
    stack: 'jvm',
    frameworks: ['spring-boot'],
    build: {
      tool: 'gradle',
      runtimeVersion: '17',
      depsCommand: ['./gradlew', 'dependencies'],
      buildCommand: ['./gradlew', 'bootJar'],
      testCommand: ['./gradlew', 'test', '--offline'],
      startCommand: ['java', '-jar', 'build/libs/*.jar'],
      artifact: 'build/libs/*.jar',
      ...over,
    },
    app: { port: 8080, contextPath: '/', healthPath: '/actuator/health', configFiles: [], ...app },
    stores: [],
    outbound: [],
    secretKeys: [],
    questions: [],
    problems: [],
  };
}

const plan = (scan: SandboxScan, local: SandboxLocal = NO_DUMP) => planSandbox(scan, local, { readConfig: () => null });

interface Svc {
  command?: string[];
}
const composeOf = (p: { files: Map<string, string> }) => Bun.YAML.parse(p.files.get('compose.yml')!) as { services: Record<string, Svc> };

/** What compose does with a command before the container sees it: `$$` becomes `$`. */
const unescape = (argv: string[]): string[] => argv.map((a) => a.replace(/\$\$/g, '$'));

describe('A1: a start command with a glob is resolved through a shell', () => {
  /** Runs the app's rendered command in a temp /build with a fake `java` that prints its argv. */
  function start(files: string[], argv = ['java', '-jar', 'build/libs/*.jar']): { code: number; out: string; err: string } {
    const build = dir();
    mkdirSync(join(build, 'build', 'libs'), { recursive: true });
    for (const f of files) writeFileSync(join(build, 'build', 'libs', f), 'x');
    const bin = dir('goodboy-mfa-bin-');
    writeFileSync(join(bin, 'java'), '#!/bin/sh\necho "java $*"\n');
    chmodSync(join(bin, 'java'), 0o755);
    const cmd = unescape(composeOf(plan(scanOf({ startCommand: argv }))).services.app!.command!);
    const r = Bun.spawnSync(cmd, { cwd: build, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test('the compose command is a shell script, not the bare glob', () => {
    const cmd = composeOf(plan(scanOf())).services.app!.command!;
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c']);
    expect(cmd.join(' ')).not.toContain('java -jar build/libs/*.jar');
  });

  test('one archive: java runs it', () => {
    const r = start(['app-1.0.jar']);
    expect(r).toMatchObject({ code: 0, out: 'java -jar build/libs/app-1.0.jar\n' });
  });

  test('plain, sources, javadoc and original archives are ignored', () => {
    const r = start(['app-1.0.jar', 'app-1.0-plain.jar', 'app-1.0-sources.jar', 'app-1.0-javadoc.jar', 'original-app.jar']);
    expect(r).toMatchObject({ code: 0, out: 'java -jar build/libs/app-1.0.jar\n' });
  });

  test('no archive and two archives both fail with a message, java never runs', () => {
    const none = start(['app-plain.jar']);
    expect(none.code).toBe(1);
    expect(none.err).toContain('found 0');
    expect(none.out).toBe('');
    const two = start(['a.jar', 'b.jar']);
    expect(two.code).toBe(1);
    expect(two.err).toContain('found 2');
    expect(two.out).toBe('');
  });

  test('a war works the same, and other arguments are kept', () => {
    const r = start(['app.war'], ['java', '-Xmx64m', '-jar', 'build/libs/*.war', '--x=1']);
    expect(r).toMatchObject({ code: 0, out: 'java -Xmx64m -jar build/libs/app.war --x=1\n' });
  });

  test('a command without a glob, or already a sh -c, is left alone', () => {
    expect(composeOf(plan(scanOf({ startCommand: ['java', '-jar', 'build/libs/app.jar'] }))).services.app!.command).toEqual(['java', '-jar', 'build/libs/app.jar']);
    expect(composeOf(plan(scanOf({ startCommand: ['sh', '-c', 'java -jar build/libs/*.jar'] }))).services.app!.command).toEqual(['sh', '-c', 'java -jar build/libs/*.jar']);
  });
});

describe('A2: the health URL joins the context path once', () => {
  test('a health path equal to the context path is not doubled', () => {
    const s = scanOf({}, { contextPath: '/shop', healthPath: '/shop' });
    const p = plan(s);
    expect(p.healthUrl).toBe('http://app:8080/shop');
    expect(p.proxyHealthUrl).toBe('http://proxy:8080/shop');
  });

  test('a trailing slash on the context path and a health path under it', () => {
    expect(plan(scanOf({}, { contextPath: '/shop/', healthPath: '/shop' })).healthUrl).toBe('http://app:8080/shop');
    expect(plan(scanOf({}, { contextPath: '/shop', healthPath: '/shopping' })).healthUrl).toBe('http://app:8080/shop/shopping');
  });
});

describe('A3: no wrapper means the official build image, and the offline test run is prepared', () => {
  interface Full {
    image: string;
    environment?: Record<string, string>;
    volumes?: string[];
  }
  const services = (p: { files: Map<string, string> }) => (Bun.YAML.parse(p.files.get('compose.yml')!) as { services: Record<string, Full> }).services;
  const bare = (tool: 'maven' | 'gradle', jdk: string | null = '17') =>
    scanOf(
      tool === 'maven'
        ? { tool, runtimeVersion: jdk, depsCommand: ['mvn', '-B', 'dependency:go-offline'], buildCommand: ['mvn', '-B', '-o', 'package', '-DskipTests'], testCommand: ['mvn', '-B', '-o', 'test'], startCommand: ['java', '-jar', 'target/app.jar'] }
        : { tool, runtimeVersion: jdk, depsCommand: ['gradle', '--no-daemon', 'dependencies'], buildCommand: ['gradle', '--no-daemon', 'build', '-x', 'test'], testCommand: ['gradle', '--offline', 'test'], startCommand: ['java', '-jar', 'build/libs/app.jar'] },
    );

  test('bare mvn and gradle: prep and the runner use the tool image at the project JDK, the app keeps the JDK image', () => {
    const m = services(plan(bare('maven')));
    expect([m.prep!.image, m.runner!.image, m.app!.image]).toEqual(['maven:3.9-eclipse-temurin-17', 'maven:3.9-eclipse-temurin-17', 'eclipse-temurin:17-jdk']);
    const g = services(plan(bare('gradle', '11')));
    expect([g.prep!.image, g.runner!.image, g.app!.image]).toEqual(['gradle:8-jdk11', 'gradle:8-jdk11', 'eclipse-temurin:11-jdk']);
  });

  test('a wrapper brings its own tool: every service keeps the JDK image', () => {
    const s = services(plan(scanOf()));
    for (const name of ['prep', 'runner', 'app']) expect(s[name]!.image).toBe('eclipse-temurin:17-jdk');
  });

  test('a JDK the images do not come in is run on the next one up, newer than 21 on 21', () => {
    expect(buildImage('mvn', 8)).toBe('maven:3.9-eclipse-temurin-8');
    expect(buildImage('mvn', 12)).toBe('maven:3.9-eclipse-temurin-17');
    expect(buildImage('gradle', 21)).toBe('gradle:8-jdk21');
    expect(buildImage('gradle', 25)).toBe('gradle:8-jdk21');
    expect(services(plan(bare('maven', '1.8'))).prep!.image).toBe('maven:3.9-eclipse-temurin-8');
  });

  test('the Gradle cache is in /gradle-home on every JVM service, not under the image\'s linked /root/.gradle', () => {
    const s = services(plan(bare('gradle')));
    for (const name of ['prep', 'runner', 'app']) expect(s[name]!.environment!.GRADLE_USER_HOME).toBe('/gradle-home');
    expect(s.prep!.volumes).toContain('gradle:/gradle-home');
    expect(s.runner!.volumes).toContain('gradle:/gradle-home');
    expect(s.prep!.volumes!.some((v) => v.includes('/root/.gradle'))).toBe(false);
  });

  /** Runs the test-phase step of prep.sh in a temp dir with a fake mvn or gradle that logs its argv. */
  function phase(tool: 'maven' | 'gradle', files: string[]): { code: number; out: string; calls: string; script: string } {
    const work = dir();
    for (const f of files) {
      mkdirSync(join(work, f, '..'), { recursive: true });
      writeFileSync(join(work, f), 'x');
    }
    const bin = dir('goodboy-mfa-bin-');
    for (const name of ['mvn', 'gradle']) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${bin}/calls.log"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const init = join(bin, 'resolve.gradle');
    const script = testPhasePrep(bare(tool)).join('\n').replaceAll('/tmp/goodboy-resolve.gradle', init);
    const r = Bun.spawnSync(['sh', '-c', `set -eu\n${script}`], { cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const log = join(bin, 'calls.log');
    return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), calls: existsSync(log) ? readFileSync(log, 'utf8') : '', script: existsSync(init) ? readFileSync(init, 'utf8') : '' };
  }

  test('Maven: one test class is run with a method that does not exist, online, so the test plugins are fetched', () => {
    const r = phase('maven', ['src/test/java/demo/CalcTest.java', 'src/main/java/demo/Calc.java']);
    expect(r.code).toBe(0);
    expect(r.calls).toBe('mvn -B test -Dtest=CalcTest#GoodboyNoSuchMethod -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false\n');
    expect(r.calls).not.toContain(' -o ');
  });

  test('Maven: a test class in a module is found; a test resource named Test-something is not a class; no class means a note and no run', () => {
    expect(phase('maven', ['api/src/test/java/x/UserIT.java']).calls).toContain('-Dtest=UserIT#GoodboyNoSuchMethod');
    expect(phase('maven', ['src/test/kotlin/x/FooTests.kt']).calls).toContain('-Dtest=FooTests#GoodboyNoSuchMethod');
    const none = phase('maven', ['src/test/resources/Test-data.xml', 'src/main/java/A.java']);
    expect(none.code).toBe(0);
    expect(none.calls).toBe('');
    expect(none.out).toContain('no test class found');
  });

  test('Gradle: an init script that resolves every resolvable configuration runs as a task', () => {
    const r = phase('gradle', []);
    expect(r.code).toBe(0);
    expect(r.calls).toMatch(/^gradle --no-daemon --init-script \S+resolve\.gradle goodboyResolveAll\n$/);
    expect(r.script).toContain("tasks.register('goodboyResolveAll')");
    expect(r.script).toContain('configurations.matching { it.canBeResolved }');
  });

  test('a build with another tool or no test command has no test-phase step', () => {
    expect(testPhasePrep(scanOf({ tool: 'npm', testCommand: ['npm', 'test'] }))).toEqual([]);
    expect(testPhasePrep(scanOf({ tool: 'maven', testCommand: [] }))).toEqual([]);
    expect(testPhasePrep({ ...scanOf({ tool: 'npm' }), stack: 'node' })).toEqual([]);
  });
});

describe('the gateway probe runs its attempts side by side', () => {
  /** Runs the gateway part of the probe script with a fake ping and nc that each wait 2 s. */
  function gateway(o: { open?: 'ping' | 'tcp' | 'both'; noPingAnswer?: boolean }): { marks: string; ms: number } {
    const work = dir();
    const bin = join(work, 'bin');
    mkdirSync(bin);
    const tool = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh
${body}
`);
      chmodSync(join(bin, name), 0o755);
    };
    tool('ping', `sleep 2
exit ${o.open === 'ping' || o.open === 'both' ? 0 : 1}`);
    tool('nc', `sleep 2
[ "$5" = 80 ] && [ "${o.open === 'tcp' || o.open === 'both' ? 'y' : 'n'}" = y ] && exit 0
exit 1`);
    const full = probeScript([], '10.231.0.1').replaceAll('/tmp/gw', join(work, 'gw'));
    const from = full.indexOf('mkdir -p');
    const to = full.indexOf('echo GW_TCP=$GW') + 'echo GW_TCP=$GW'.length;
    const t0 = Date.now();
    const r = Bun.spawnSync(['sh', '-c', full.slice(from, to)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    return { marks: r.stdout.toString().trim().split('\n').join(' '), ms: Date.now() - t0 };
  }

  test('seven 2-second attempts take about 2 s, not 14 s, and the marks are right', () => {
    const blocked = gateway({});
    expect(blocked.marks).toBe('GW_PING=blocked GW_TCP=blocked');
    expect(blocked.ms).toBeLessThan(6000);
    expect(gateway({ open: 'ping' }).marks).toBe('GW_PING=open GW_TCP=blocked');
    expect(gateway({ open: 'tcp' }).marks).toBe('GW_PING=blocked GW_TCP=open');
    expect(gateway({ open: 'both' }).marks).toBe('GW_PING=open GW_TCP=open');
  });
});
