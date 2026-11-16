// Track M, M1b (plan §19): the sandbox's files (lib/sandbox-render.ts), their writer
// (lib/sandbox-files.ts) and the docker side (lib/sandbox-run.ts), with a fake docker for the
// check logic and one opt-in test against a real docker (GOODBOY_DOCKER_IT=1).

import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkSandbox, type Ctx, loadCtx, parseNslookup, probeScript, sandboxCommand, staticProblems } from '../lib/sandbox-run';
import { RESTORE_TAG } from '../lib/sandbox-parts';
import { configKeyAt, IMAGES, planSandbox, renderSandbox, SCAN_FILE } from '../lib/sandbox-render';
import { initSandbox, outOfDate, readScan, writeLocal, writeScan } from '../lib/sandbox-files';
import { projectName, readLocal, SANDBOX_DIR } from '../lib/sandbox-mode';
import { FAKE_DOCKER } from './m6a-fake';
import type { SandboxLocal, SandboxOutbound, SandboxScan, SandboxStore } from '../lib/sandbox-types';

// Each CLI run starts bun and loads the whole CLI: a test with a few of them takes seconds.
setDefaultTimeout(60_000);

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const tmpDirs: string[] = [];
const savedBin = process.env.GOODBOY_DOCKER_BIN;
const savedFakeDir = process.env.FAKE_DOCKER_DIR;
/** fake() points the process at its fake docker; the file leaves the environment as it found it. */
function restoreDockerEnv(): void {
  if (savedBin === undefined) delete process.env.GOODBOY_DOCKER_BIN;
  else process.env.GOODBOY_DOCKER_BIN = savedBin;
  if (savedFakeDir === undefined) delete process.env.FAKE_DOCKER_DIR;
  else process.env.FAKE_DOCKER_DIR = savedFakeDir;
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  restoreDockerEnv();
});
afterAll(restoreDockerEnv);

function dir(prefix = 'goodboy-m1-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const w = (file: string, line: number) => ({ file, line });
const NO_DUMP: SandboxLocal = { dump: null, dumpFormat: null };
const APP_YML = 'src/main/resources/application.yml';

/** The Spring config the JVM fixture's hosts are written in, with a credential in a URL and a
 *  real-looking password that must never reach a rendered file. */
const CONFIG = `spring:
  datasource:
    url: jdbc:postgresql://prod-db.corp:5432/shop
    username: shop_rw
    password: Pr0dPassw0rd!
    driver-class-name: org.postgresql.Driver
  redis:
    host: redis.corp
    port: 6379
partner:
  base-url: https://admin:S3cretToken@api.partner.example/v2?apikey=XYZ123
mail:
  host: smtp.corp.example
ldap:
  url: ldap://ldap.corp.example:389/dc=corp,dc=example
jwt:
  secret: RealJwtSecretValue
`;

const lineOf = (text: string, needle: string): number => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

function out(host: string, kind: SandboxOutbound['kind'], over: Partial<SandboxOutbound> = {}, needle = host): SandboxOutbound {
  return {
    host,
    port: kind === 'smtp' ? 587 : kind === 'ldap' ? 389 : 443,
    scheme: kind === 'http' ? 'https' : kind === 'ldap' ? 'ldap' : null,
    kind,
    where: w(APP_YML, lineOf(CONFIG, needle)),
    callSite: w('src/main/java/A.java', 10),
    hardcoded: false,
    ipLiteral: false,
    ...over,
  };
}

function store(kind: SandboxStore['kind'], over: Partial<SandboxStore> = {}): SandboxStore {
  return { kind, version: kind === 'postgres' ? '15' : '7', database: kind === 'postgres' ? 'shop' : null, configKeys: [], where: w(APP_YML, 3), ...over };
}

function jvmScan(): SandboxScan {
  return {
    root: '/nonexistent/repo',
    stack: 'jvm',
    frameworks: ['spring-boot', 'thymeleaf'],
    build: {
      tool: 'gradle',
      runtimeVersion: '17',
      depsCommand: ['./gradlew', 'dependencies'],
      buildCommand: ['./gradlew', 'bootJar', '-x', 'test'],
      testCommand: ['./gradlew', 'test', '--offline'],
      startCommand: ['java', '-jar', 'build/libs/app.jar'],
      artifact: 'build/libs/app.jar',
    },
    app: { port: 8080, contextPath: '/', healthPath: '/actuator/health', configFiles: [APP_YML] },
    stores: [
      store('postgres', { configKeys: ['spring.datasource.url', 'spring.datasource.username', 'spring.datasource.password', 'spring.datasource.driver-class-name'], where: w(APP_YML, 3) }),
      store('redis', { configKeys: ['spring.redis.host', 'spring.redis.port'], where: w(APP_YML, 7) }),
    ],
    outbound: [
      out('api.partner.example', 'http', {}, 'base-url'),
      out('smtp.corp.example', 'smtp', {}, 'host: smtp'),
      out('ldap.corp.example', 'ldap', {}, 'ldap.corp'),
      { host: '10.20.30.40', port: 8080, scheme: 'http', kind: 'http', where: w('src/main/java/D.java', 7), callSite: w('src/main/java/D.java', 7), hardcoded: true, ipLiteral: true },
    ],
    secretKeys: ['jwt.secret', 'spring.datasource.password'],
    questions: [],
    problems: [],
  };
}

const read = (scan: SandboxScan, local = NO_DUMP, o = {}) => planSandbox(scan, local, { readConfig: () => CONFIG, ...o });

interface Compose {
  services: Record<string, { image: string; profiles?: string[]; networks?: string[] | Record<string, { aliases?: string[]; ipv4_address?: string } | null>; ports?: unknown[]; volumes?: string[]; environment?: Record<string, string>; env_file?: string[]; command?: string[]; entrypoint?: string[]; depends_on?: Record<string, unknown> }>;
  networks: Record<string, { internal?: boolean; driver?: string; driver_opts?: Record<string, string>; ipam?: { config: { subnet: string; gateway?: string; aux_addresses?: Record<string, string> }[] } }>;
  volumes: Record<string, unknown>;
}

const parse = (plan: { files: Map<string, string> }): Compose => Bun.YAML.parse(plan.files.get('compose.yml')!) as Compose;
const netNames = (s: Compose['services'][string]): string[] => (s.networks === undefined ? [] : Array.isArray(s.networks) ? s.networks : Object.keys(s.networks));
const netOpts = (s: Compose['services'][string], net: string) => (s.networks && !Array.isArray(s.networks) ? s.networks[net] : null);

describe('compose networks', () => {
  test('every service outside the prep profile is on internal networks only, without published ports', () => {
    const c = parse(read(jvmScan(), { dump: '/data/shop.sql', dumpFormat: 'sql' }));
    expect(Object.keys(c.services).sort()).toEqual(['app', 'db', 'e2e', 'e2e-prep', 'ldap', 'mail', 'prep', 'probe', 'proxy', 'reader', 'redis', 'runner', 'stubs']);
    for (const [name, s] of Object.entries(c.services)) {
      expect(s.ports).toBeUndefined();
      if (s.profiles?.includes('prep')) continue;
      // the reader has no network at all (M6a): nothing to be internal
      if ((s as { network_mode?: string }).network_mode === 'none') {
        expect(name).toBe('reader');
        expect(s.networks).toBeUndefined();
        continue;
      }
      const nets = netNames(s);
      expect(nets.length).toBeGreaterThan(0);
      for (const n of nets) expect({ name, net: n, internal: c.networks[n]?.internal }).toEqual({ name, net: n, internal: true });
      expect(nets).not.toContain('prep');
    }
  });

  test('prep and e2e-prep are the only services on the prep bridge and only in the prep profile', () => {
    const c = parse(read(jvmScan()));
    expect(c.networks.prep).toEqual({ driver: 'bridge' });
    expect(c.networks.prep!.internal).toBeUndefined();
    expect(c.services.prep!.profiles).toEqual(['prep']);
    expect(netNames(c.services.prep!)).toEqual(['prep']);
    const onPrep = Object.entries(c.services).filter(([, s]) => netNames(s).includes('prep')).map(([n]) => n);
    expect(onPrep).toEqual(['e2e-prep', 'prep']);
    expect(c.services['e2e-prep']!.profiles).toEqual(['prep']);
    expect(netNames(c.services.db!)).toEqual(['inner']);
  });

  test('inner is internal with a fixed subnet that can be moved', () => {
    // no address for the host (inhibit_ipv4); the first address stays reserved so nothing answers there
    expect(parse(read(jvmScan())).networks.inner).toEqual({
      internal: true,
      driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' },
      ipam: { config: [{ subnet: '10.231.0.0/24', aux_addresses: { 'goodboy-gateway': '10.231.0.1' } }] },
    });
    const moved = read(jvmScan(), NO_DUMP, { innerSubnet: '10.99.0.0/24' });
    expect(parse(moved).networks.inner!.ipam!.config[0]!.subnet).toBe('10.99.0.0/24');
    expect(moved.innerGateway).toBe('10.99.0.1');
    expect(read(jvmScan()).innerGateway).toBe('10.231.0.1');
  });

  test('the dummies take the real host names as aliases on inner', () => {
    const c = parse(read(jvmScan()));
    expect(netOpts(c.services.mail!, 'inner')).toEqual({ aliases: ['smtp.corp.example'] });
    expect(netOpts(c.services.stubs!, 'inner')).toEqual({ aliases: ['api.partner.example'] });
    expect(netOpts(c.services.ldap!, 'inner')).toEqual({ aliases: ['ldap.corp.example'] });
  });

  test('an IP literal gets its own internal /24 where the dummy holds that exact address and the app joins', () => {
    const c = parse(read(jvmScan()));
    expect(c.networks.ip_10_20_30).toEqual({ internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' }, ipam: { config: [{ subnet: '10.20.30.0/24' }] } });
    expect(netOpts(c.services.stubs!, 'ip_10_20_30')).toEqual({ ipv4_address: '10.20.30.40' });
    expect(netNames(c.services.app!)).toEqual(['inner', 'ip_10_20_30']);
    expect(netNames(c.services.runner!)).toEqual(['inner', 'ip_10_20_30']);
    const plan = read(jvmScan());
    expect(plan.dummies).toContainEqual({ service: 'stubs', host: '10.20.30.40', ip: '10.20.30.40' });
    expect(plan.internalNets).toEqual(['inner', 'ip_10_20_30']);
  });

  test('a literal anywhere in its /24 is fine (no gateway to avoid); a literal in the inner subnet and a second one for a dummy are reported', () => {
    const s = jvmScan();
    s.outbound = [
      { ...out('x', 'http'), host: '192.168.5.254', ipLiteral: true, hardcoded: true },
      { ...out('x', 'smtp'), host: '192.168.5.9', ipLiteral: true, hardcoded: true },
      { ...out('x', 'smtp'), host: '192.168.5.10', ipLiteral: true, hardcoded: true },
      { ...out('x', 'http'), host: '10.231.0.7', ipLiteral: true, hardcoded: true },
    ];
    const plan = read(s);
    expect(parse(plan).networks.ip_192_168_5!.ipam!.config[0]).toEqual({ subnet: '192.168.5.0/24' });
    expect(plan.notes.some((n) => n.includes('192.168.5.10') && n.includes('one address per network'))).toBe(true);
    expect(plan.notes.some((n) => n.includes('10.231.0.7') && n.includes('inner subnet'))).toBe(true);
    expect(plan.dummies.map((d) => d.host)).toEqual(['192.168.5.254', '192.168.5.9']);
  });

  test('other kinds get no dummy and are listed; a host with no call site, a bad name and a service name are reported', () => {
    const s = jvmScan();
    s.outbound.push(out('mq.corp.example', 'other', { port: 5672 }));
    s.outbound.push(out('unused.example', 'http', { callSite: null }));
    s.outbound.push(out('Bad_Name.example', 'http'));
    s.outbound.push(out('db', 'http'));
    s.outbound.push(out('localhost', 'http'));
    const plan = read(s);
    const compose = plan.files.get('compose.yml')!;
    expect(compose).toContain('# No dummy (kind other)');
    expect(compose).toContain('mq.corp.example:5672');
    expect(plan.dummies.map((d) => d.host)).not.toContain('mq.corp.example');
    expect(plan.notes.join('\n')).toContain('unused.example');
    expect(plan.notes.join('\n')).toContain('Bad_Name.example');
    expect(plan.notes.join('\n')).toContain('name of a sandbox service');
    expect(parse(plan).services.stubs!.networks).toEqual({ inner: { aliases: ['api.partner.example'] }, ip_10_20_30: { ipv4_address: '10.20.30.40' } });
  });

  test('no dummy service is made for a kind the project does not use', () => {
    const s = jvmScan();
    s.outbound = [out('api.partner.example', 'http', {}, 'base-url')];
    expect(Object.keys(parse(read(s)).services).sort()).toEqual(['app', 'db', 'e2e', 'e2e-prep', 'prep', 'probe', 'proxy', 'reader', 'redis', 'runner', 'stubs']);
  });
});

describe('compose content', () => {
  test('every image has a pinned tag, never latest', () => {
    for (const scan of [jvmScan(), nodeScan(), pythonScan()]) {
      const c = parse(read(scan));
      for (const [name, s] of Object.entries(c.services)) {
        const tag = s.image.split(':')[1];
        expect({ name, tag: tag !== undefined && tag !== 'latest' && tag !== '' }).toEqual({ name, tag: true });
      }
    }
    expect(Object.values(IMAGES).every((i) => /:[^:]+$/.test(i) && !i.endsWith(':latest'))).toBe(true);
  });

  test('the dump is mounted read-only from a variable, so its path never enters the repo', () => {
    const plan = read(jvmScan(), { dump: '/Users/me/dumps/shop.sql', dumpFormat: 'sql' });
    const c = parse(plan);
    const mounts = c.services.db!.volumes!.filter((v) => v.includes('/dump/'));
    expect(mounts).toEqual(['${GOODBOY_DUMP}:/dump/dump.sql:ro']);
    for (const text of plan.files.values()) expect(text).not.toContain('/Users/me');
    expect(parse(read(jvmScan(), { dump: '/d/x.dump', dumpFormat: 'custom' })).services.db!.volumes).toContain('${GOODBOY_DUMP}:/dump/dump.custom:ro');
    expect(parse(read(jvmScan())).services.db!.volumes!.some((v) => v.includes('/dump/'))).toBe(false);
  });

  test('the db is on inner, never on prep, and its data is a named volume', () => {
    const c = parse(read(jvmScan()));
    expect(c.services.db!.image).toBe('postgres:15-alpine');
    expect(netNames(c.services.db!)).toEqual(['inner']);
    expect(c.services.db!.volumes).toContain('dbdata:/var/lib/postgresql/data');
    expect(c.volumes).toHaveProperty('dbdata');
    expect(c.services.redis!.image).toBe('redis:7-alpine');
    expect(c.services.app!.depends_on).toMatchObject({ db: { condition: 'service_healthy' }, mail: { condition: 'service_started' } });
  });

  test('Postgres: the restore goes into <name>_template once and the reset creates <name> from it', () => {
    const f = read(jvmScan(), { dump: '/d/x.sql', dumpFormat: 'sql' }).files;
    const restore = f.get('db/db/restore.sh')!;
    const reset = f.get('db/db/reset.sh')!;
    expect(restore).toContain('TEMPLATE=shop_template');
    expect(restore).toContain('template $TEMPLATE exists');
    expect(restore).toContain('-f /dump/dump.sql');
    expect(restore).toContain('RENAME TO');
    expect(reset).toContain('DROP DATABASE IF EXISTS "shop" WITH (FORCE)');
    expect(reset).toContain('CREATE DATABASE "shop" TEMPLATE "shop_template"');
    const custom = read(jvmScan(), { dump: '/d/x.dump', dumpFormat: 'custom' }).files.get('db/db/restore.sh')!;
    expect(custom).toContain('pg_restore');
    expect(custom).toContain('/dump/dump.custom');
    const old = jvmScan();
    old.stores[0]!.version = '12';
    expect(read(old).files.get('db/db/reset.sh')).toContain('pg_terminate_backend');
    expect(read(old).files.get('db/db/reset.sh')).not.toContain('WITH (FORCE)');
  });

  test('MySQL and MariaDB reload the app database from the template', () => {
    for (const kind of ['mysql', 'mariadb'] as const) {
      const s = jvmScan();
      s.stores = [store(kind, { version: kind === 'mysql' ? '8.0' : '11', database: 'shop' })];
      const f = read(s, { dump: '/d/x.sql', dumpFormat: 'sql' }).files;
      const cli = kind === 'mysql' ? 'mysql' : 'mariadb';
      expect(f.get('db/db/restore.sh')).toContain(`${cli} -h 127.0.0.1`);
      expect(f.get('db/db/restore.sh')).toContain('__goodboy_loaded');
      expect(f.get('db/db/reset.sh')).toContain(kind === 'mysql' ? 'mysqldump' : 'mariadb-dump');
      expect(f.get('db/db/reset.sh')).toContain('DROP DATABASE IF EXISTS \\`shop\\`');
      expect(parse({ files: f }).services.db!.image).toBe(`${kind}:${s.stores[0]!.version}`);
    }
  });

  test('a store with no pinned version gets a default, not latest', () => {
    const s = jvmScan();
    s.stores[0]!.version = 'latest';
    s.stores[1]!.version = '';
    const c = parse(read(s));
    expect(c.services.db!.image).toBe('postgres:16-alpine');
    expect(c.services.redis!.image).toBe('redis:7-alpine');
  });

  test('WireMock serves HTTP and HTTPS from the sandbox keystore with a catch-all 404 stub', () => {
    const plan = read(jvmScan());
    const stubs = parse(plan).services.stubs!;
    expect(stubs.command).toContain('--https-keystore');
    expect(stubs.command![stubs.command!.indexOf('--https-port') + 1]).toBe('443');
    expect(stubs.volumes).toContain('./ca/server.p12:/certs/server.p12:ro');
    const stub = JSON.parse(plan.files.get('dummies/stubs/mappings/catch-all.json')!);
    expect(stub.response.status).toBe(404);
    expect(stub.request.urlPattern).toBe('.*');
  });

  test('the mail sink listens on the SMTP port the app uses', () => {
    expect(parse(read(jvmScan())).services.mail!.environment!.MP_SMTP_BIND_ADDR).toBe('0.0.0.0:587');
  });

  test('the directory is seeded with a test user and takes its base DN from the config', () => {
    const plan = read(jvmScan());
    expect(parse(plan).services.ldap!.environment).toMatchObject({ LDAP_DOMAIN: 'corp.example' });
    const seed = plan.files.get('dummies/ldap/seed.ldif')!;
    expect(seed).toContain('dn: uid=test,ou=people,dc=corp,dc=example');
    expect(seed).toContain('userPassword: test');
    expect(plan.notes.join('\n')).toContain('dc=corp,dc=example');
    expect(parse(plan).services.ldap!.image).toBe('osixia/openldap:1.5.0');
    const bare = jvmScan();
    expect(parse(planSandbox(bare, NO_DUMP, { readConfig: () => null })).services.ldap!.environment!.LDAP_DOMAIN).toBe('sandbox.test');
  });

  test('the app trusts the CA: the JVM imports it into cacerts at start', () => {
    const plan = read(jvmScan());
    const c = parse(plan);
    expect(c.services.app!.volumes).toContain('./ca/ca.crt:/sandbox/ca.crt:ro');
    expect(c.services.app!.entrypoint).toEqual(['sh', '/sandbox/entrypoint.sh']);
    expect(c.services.app!.command).toEqual(['java', '-jar', 'build/libs/app.jar']);
    expect(c.services.app!.volumes).toContain('build:/build');
    expect(plan.files.get('runtime/entrypoint.sh')).toContain('keytool -importcert -noprompt -trustcacerts -cacerts');
    const jdk8 = jvmScan();
    jdk8.build.runtimeVersion = '1.8';
    expect(read(jdk8).files.get('runtime/entrypoint.sh')).toContain('jre/lib/security/cacerts');
    expect(parse(read(jdk8)).services.app!.image).toBe('eclipse-temurin:8-jdk');
    expect(c.services.app!.environment).toMatchObject({ SPRING_PROFILES_ACTIVE: 'sandbox', SPRING_CONFIG_ADDITIONAL_LOCATION: 'optional:file:/sandbox/overrides/', SERVER_PORT: '8080' });
  });

  test('the runner runs the test command from the source with cache volumes, on inner only', () => {
    const c = parse(read(jvmScan()));
    const r = c.services.runner!;
    expect(r.profiles).toEqual(['tools']);
    expect(r.command).toEqual(['./gradlew', 'test', '--offline']);
    expect(r.volumes).toEqual(expect.arrayContaining(['../..:/work', 'gradle:/gradle-home', 'm2:/root/.m2']));
    expect(c.services.probe).toMatchObject({ image: 'busybox:1.36', profiles: ['tools'], networks: ['inner'] });
  });

  test('prep copies the source into the build volume, builds there, and never gets the dump', () => {
    const plan = read(jvmScan(), { dump: '/d/x.sql', dumpFormat: 'sql' });
    const prep = parse(plan).services.prep!;
    expect(prep.volumes).toContain('../..:/src:ro');
    expect(prep.volumes).toContain('build:/build');
    expect(prep.volumes!.some((v) => v.includes('/dump') || v.includes('GOODBOY_DUMP'))).toBe(false);
    const script = plan.files.get('runtime/prep.sh')!;
    expect(script).toContain('./gradlew dependencies');
    expect(script).toContain('./gradlew bootJar -x test');
    expect(script).toContain('tar xf - -C /build');
  });

  test('a `$` in a command is escaped for compose, and only the dump variable stays', () => {
    const s = jvmScan();
    s.build.startCommand = ['sh', '-c', 'java -jar $APP_JAR'];
    const text = read(s, { dump: '/d/x.sql', dumpFormat: 'sql' }).files.get('compose.yml')!;
    expect(text).toContain('java -jar $$APP_JAR');
    expect(text).toContain('${GOODBOY_DUMP}');
    expect(/(?<!\$)\$APP_JAR/.test(text)).toBe(false);
  });

  test('the sandbox dir ignores the local answers, the output and the keys', () => {
    const ignore = read(jvmScan()).files.get('.gitignore')!.split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['local.json', 'out/', 'ca/*.key', '*.p12']));
  });

  test('a scan with no start command or test command gets no app or runner, with a note', () => {
    const s = jvmScan();
    s.build.startCommand = [];
    s.build.testCommand = [];
    const plan = read(s);
    expect(Object.keys(parse(plan).services)).not.toContain('app');
    expect(Object.keys(parse(plan).services)).not.toContain('runner');
    expect(plan.hasApp).toBe(false);
    expect(plan.notes.join('\n')).toContain('no start command');
  });

  test('a second SQL store is empty and only the first gets the dump', () => {
    const s = jvmScan();
    s.stores.push(store('mysql', { version: '8.0', database: 'other' }));
    const plan = read(s, { dump: '/d/x.sql', dumpFormat: 'sql' });
    const c = parse(plan);
    expect(c.services.db2!.volumes!.some((v) => v.includes('/dump/'))).toBe(false);
    expect(plan.files.has('db/db2/reset.sh')).toBe(true);
    expect(plan.upServices).toEqual(['db', 'db2', 'redis', 'mail', 'stubs', 'ldap']);
  });

  test('the server certificate names every dummy host and address', () => {
    expect(read(jvmScan()).sans).toEqual({ dns: ['api.partner.example', 'smtp.corp.example', 'ldap.corp.example', 'mail', 'stubs', 'ldap', 'localhost'], ips: ['10.20.30.40', '127.0.0.1'] });
  });

  test('the health URL joins the context path and the health path once', () => {
    const s = jvmScan();
    expect(read(s).healthUrl).toBe('http://app:8080/actuator/health');
    s.app.contextPath = '/shop';
    expect(read(s).healthUrl).toBe('http://app:8080/shop/actuator/health');
    s.app.healthPath = '/shop/health';
    expect(read(s).healthUrl).toBe('http://app:8080/shop/health');
  });
});

describe('the config override', () => {
  test('Spring: stores point at the sandbox, hosts keep their shape without credentials, secrets are dummies', () => {
    const plan = read(jvmScan());
    const y = Bun.YAML.parse(plan.files.get('overrides/application-sandbox.yml')!) as Record<string, string>;
    expect(y['spring.datasource.url']).toBe('jdbc:postgresql://db:5432/shop');
    expect(y['spring.datasource.username']).toBe('sandbox');
    expect(y['spring.datasource.password']).toBe('sandbox');
    expect(y['spring.redis.host']).toBe('redis');
    expect(y['spring.redis.port']).toBe('6379');
    expect(y['partner.base-url']).toBe('https://api.partner.example:443/v2');
    expect(y['mail.host']).toBe('smtp.corp.example');
    expect(y['ldap.url']).toBe('ldap://ldap.corp.example:389/dc=corp,dc=example');
    expect(y['jwt.secret']).toMatch(/^[A-Za-z0-9]{64}$/);
    expect(y['spring.datasource.driver-class-name']).toBeUndefined();
    expect(plan.notes.join('\n')).toContain('spring.datasource.driver-class-name');
  });

  test('no real secret, credential or host-only detail from the config reaches any file', () => {
    const plan = read(jvmScan(), { dump: '/Users/me/dump.sql', dumpFormat: 'sql' });
    const all = [...plan.files.values()].join('\n') + plan.notes.join('\n');
    for (const secret of ['Pr0dPassw0rd', 'S3cretToken', 'XYZ123', 'RealJwtSecretValue', 'shop_rw', 'prod-db.corp', 'redis.corp', 'apikey']) expect(all).not.toContain(secret);
  });

  test('MySQL gets a JDBC url that allows key retrieval and root credentials', () => {
    const s = jvmScan();
    s.stores = [store('mysql', { version: '8.0', database: 'shop', configKeys: ['spring.datasource.url', 'spring.datasource.username'] })];
    const y = Bun.YAML.parse(read(s).files.get('overrides/application-sandbox.yml')!) as Record<string, string>;
    expect(y['spring.datasource.url']).toBe('jdbc:mysql://db:3306/shop?useSSL=false&allowPublicKeyRetrieval=true');
    expect(y['spring.datasource.username']).toBe('root');
  });

  test('Node: an env file with the stores, the hosts and dummy secrets; the app trusts the CA by NODE_EXTRA_CA_CERTS', () => {
    const plan = read(nodeScan(), NO_DUMP, { readConfig: () => ENV_FILE });
    const env = plan.files.get('overrides/sandbox.env')!;
    expect(env).toContain('DATABASE_URL=postgresql://sandbox:sandbox@db:5432/shop');
    expect(env).toContain('REDIS_URL=redis://redis:6379');
    expect(env).toContain('PARTNER_API_URL=https://api.partner.example:443/v1');
    expect(env).toContain('JWT_SECRET=goodboysandboxdummysecret');
    for (const secret of ['hunter2', 'sk_live_abc']) expect(env + plan.files.get('compose.yml')!).not.toContain(secret);
    const c = parse(plan);
    expect(c.services.app!.image).toBe('node:20-bookworm');
    expect(c.services.app!.env_file).toEqual(['./overrides/sandbox.env']);
    expect(c.services.app!.environment).toMatchObject({ NODE_EXTRA_CA_CERTS: '/sandbox/ca.crt', PORT: '3000' });
    expect(c.services.app!.environment!.SPRING_PROFILES_ACTIVE).toBeUndefined();
    expect(c.services.app!.volumes).toContain('node_modules:/build/node_modules');
    expect(c.services.runner!.volumes).toContain('node_modules:/work/node_modules');
    expect(c.services.prep!.volumes).toContain('node_modules:/build/node_modules');
    expect(plan.files.get('runtime/entrypoint.sh')).not.toContain('keytool');
  });

  test('a literal `$` in an env file value is written `$$`, which Compose turns back into `$`', () => {
    const s = nodeScan();
    s.outbound = [{ ...out('api.partner.example', 'http'), where: w('.env.production', 3) }];
    const cfg = 'PARTNER_API_URL=https://api.partner.example/v1/$TENANT/${REGION}\n';
    const env = read(s, NO_DUMP, { readConfig: () => cfg.replace(/^/, '\n\n') }).files.get('overrides/sandbox.env')!;
    expect(env).toContain('PARTNER_API_URL=https://api.partner.example:443/v1/$$TENANT/$${REGION}');
    expect(/(?<!\$)\$(?!\$)/.test(env.replace(/\$\$/g, ''))).toBe(false);
  });

  test('Python: the CA bundle variables, a deps volume shared by prep, the app and the runner', () => {
    const plan = read(pythonScan(), NO_DUMP, { readConfig: () => null });
    const c = parse(plan);
    expect(c.services.app!.image).toBe('python:3.12-slim');
    expect(c.services.app!.environment).toMatchObject({ SSL_CERT_FILE: '/sandbox/ca.crt', REQUESTS_CA_BUNDLE: '/sandbox/ca.crt', PYTHONUSERBASE: '/deps/py' });
    for (const s of ['app', 'runner', 'prep']) expect(c.services[s]!.volumes).toContain('deps:/deps');
    expect(c.services.prep!.environment).toMatchObject({ PIP_USER: '1' });
    expect(plan.files.get('overrides/sandbox.env')).toContain('DATABASE_URL=');
  });

  test('a JVM project that is not Spring gets no override and no overrides mount', () => {
    const s = jvmScan();
    s.frameworks = ['jsp'];
    const plan = read(s);
    expect(plan.files.has('overrides/application-sandbox.yml')).toBe(false);
    expect(parse(plan).services.app!.volumes!.some((v) => v.includes('overrides'))).toBe(false);
    expect(parse(plan).services.app!.environment!.SPRING_PROFILES_ACTIVE).toBeUndefined();
    expect(plan.notes.join('\n')).toContain('not a Spring Boot app');
  });

  test('configKeyAt finds the dotted key of a YAML line, a properties key and an env var', () => {
    expect(configKeyAt(APP_YML, CONFIG, lineOf(CONFIG, 'username'))?.key).toBe('spring.datasource.username');
    expect(configKeyAt(APP_YML, CONFIG, lineOf(CONFIG, 'host: redis'))?.key).toBe('spring.redis.host');
    expect(configKeyAt(APP_YML, CONFIG, lineOf(CONFIG, 'base-url'))).toEqual({ key: 'partner.base-url', scheme: 'https', port: null, path: '/v2' });
    expect(configKeyAt(APP_YML, CONFIG, 1)).toBeNull();
    expect(configKeyAt('a.properties', 'x=1\nldap.url = ldap://h:389/dc=a,dc=b\n', 2)).toEqual({ key: 'ldap.url', scheme: 'ldap', port: 389, path: '/dc=a,dc=b' });
    expect(configKeyAt('.env.production', 'export SMTP_HOST="smtp.x.com"\n', 1)).toEqual({ key: 'SMTP_HOST', scheme: null, port: null, path: '' });
    expect(configKeyAt('src/A.java', 'String h = "a.b";', 1)).toBeNull();
    expect(configKeyAt(APP_YML, 'a:\n  - b: c\n', 2)).toBeNull();
  });
});

const ENV_FILE = `DATABASE_URL=postgres://u:hunter2@prod:5432/shop
REDIS_URL=redis://prod-redis:6379
PARTNER_API_URL=https://api.partner.example/v1
JWT_SECRET=sk_live_abc
`;

function nodeScan(): SandboxScan {
  return {
    root: '/nonexistent/node',
    stack: 'node',
    frameworks: ['express'],
    build: { tool: 'npm', runtimeVersion: '20.11.1', depsCommand: ['npm', 'ci'], buildCommand: ['npm', 'run', 'build'], testCommand: ['npm', 'test'], startCommand: ['node', 'dist/server.js'], artifact: 'dist' },
    app: { port: 3000, contextPath: '/', healthPath: '/', configFiles: ['.env.production'] },
    stores: [store('postgres', { configKeys: ['DATABASE_URL'], where: w('.env.production', 1) }), store('redis', { configKeys: ['REDIS_URL'], where: w('.env.production', 2) })],
    outbound: [{ ...out('api.partner.example', 'http'), where: w('.env.production', 3) }],
    secretKeys: ['JWT_SECRET'],
    questions: [],
    problems: [],
  };
}

function pythonScan(): SandboxScan {
  return {
    root: '/nonexistent/py',
    stack: 'python',
    frameworks: ['fastapi'],
    build: { tool: 'pip', runtimeVersion: '3.12.4', depsCommand: ['pip', 'install', '-r', 'requirements.txt'], buildCommand: [], testCommand: ['python', '-m', 'pytest'], startCommand: ['uvicorn', 'main:app', '--host', '0.0.0.0'], artifact: null },
    app: { port: 8000, contextPath: '/', healthPath: '/health', configFiles: [] },
    stores: [store('postgres', { configKeys: ['DATABASE_URL'], where: w('.env', 1) })],
    outbound: [],
    secretKeys: [],
    questions: [],
    problems: [],
  };
}

// ---- the writer ----

function repo(scan: SandboxScan = jvmScan()): string {
  const root = dir();
  mkdirSync(join(root, '.goodboy', 'sandbox'), { recursive: true });
  writeFileSync(join(root, SCAN_FILE), JSON.stringify({ ...scan, root }));
  return root;
}

const cli = (root: string, args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(['bun', CLI, ...args], { cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env }, stdout: 'pipe', stderr: 'pipe' });

const json = (r: ReturnType<typeof cli>) => JSON.parse(r.stdout.toString());
const hasOpenssl = Bun.which('openssl') !== null;

describe('the saved scan and the config root', () => {
  test('the saved scan keeps root as `.`, and the override keys are read from the repo the command runs in', () => {
    const root = dir();
    mkdirSync(dirname(join(root, APP_YML)), { recursive: true });
    writeFileSync(join(root, APP_YML), CONFIG);
    const scan = jvmScan();
    scan.root = root;
    const path = writeScan(root, scan);
    expect(typeof path).toBe('string');
    const saved = JSON.parse(readFileSync(path as string, 'utf8'));
    expect(saved.root).toBe('.');
    expect(readFileSync(path as string, 'utf8')).not.toContain(root);
    expect(readScan(root)).not.toBeInstanceOf(Error);
    const ctx = loadCtx(root, false);
    if (ctx instanceof Error) throw ctx;
    // the base DN of the test directory comes from ldap.url in the config file at root
    expect(ctx.plan.files.get('dummies/ldap/seed.ldif')).toContain('dc=corp,dc=example');
  });
});

describe.skipIf(!hasOpenssl)('sandbox-init', () => {
  test('writes the files and the ledger, and a second run changes nothing', async () => {
    const root = repo();
    const a = json(cli(root, ['sandbox-init']));
    expect(a.written).toContain('compose.yml');
    expect(a.written).toContain('overrides/application-sandbox.yml');
    expect(a.ca).toBe('created');
    expect(readFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'utf8')).toBe(renderSandbox(jvmScan(), NO_DUMP, { readConfig: () => null }).get('compose.yml')!);
    const ledger = JSON.parse(readFileSync(join(root, SANDBOX_DIR, '.written.json'), 'utf8'));
    expect(Object.keys(ledger.files)).toContain('compose.yml');
    const before = readFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'utf8');
    const caBefore = readFileSync(join(root, SANDBOX_DIR, 'ca', 'ca.crt'), 'utf8');
    const r = cli(root, ['sandbox-init']);
    expect(r.exitCode).toBe(0);
    const b = json(r);
    expect(b.written).toEqual([]);
    expect(b.updated).toEqual([]);
    expect(b.stale).toEqual([]);
    expect(b.drift).toEqual([]);
    expect(b.unchanged).toContain('compose.yml');
    expect(b.ca).toBe('kept');
    expect(readFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'utf8')).toBe(before);
    expect(readFileSync(join(root, SANDBOX_DIR, 'ca', 'ca.crt'), 'utf8')).toBe(caBefore);
  });

  test('a file the user changed is drift: reported, never overwritten, not even with --force', () => {
    const root = repo();
    cli(root, ['sandbox-init']);
    const compose = join(root, SANDBOX_DIR, 'compose.yml');
    writeFileSync(compose, readFileSync(compose, 'utf8') + '# my edit\n');
    for (const args of [['sandbox-init'], ['sandbox-init', '--force']]) {
      const r = cli(root, args);
      expect(r.exitCode).toBe(1);
      expect(json(r).drift).toEqual(['compose.yml']);
      expect(readFileSync(compose, 'utf8')).toContain('# my edit');
    }
  });

  test('a file that existed before goodboy wrote anything is drift too', () => {
    const root = repo();
    mkdirSync(join(root, SANDBOX_DIR, 'runtime'), { recursive: true });
    writeFileSync(join(root, SANDBOX_DIR, 'runtime', 'prep.sh'), 'mine\n');
    const r = cli(root, ['sandbox-init']);
    expect(json(r).drift).toEqual(['runtime/prep.sh']);
    expect(readFileSync(join(root, SANDBOX_DIR, 'runtime', 'prep.sh'), 'utf8')).toBe('mine\n');
    expect(r.exitCode).toBe(1);
  });

  test('a render that changed replaces an unchanged file only with --force', () => {
    const root = repo();
    cli(root, ['sandbox-init']);
    const s = jvmScan();
    s.build.startCommand = ['java', '-jar', 'build/libs/other.jar'];
    writeFileSync(join(root, SCAN_FILE), JSON.stringify({ ...s, root }));
    const a = json(cli(root, ['sandbox-init']));
    expect(a.stale).toEqual(['compose.yml']);
    expect(readFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'utf8')).toContain('app.jar');
    const b = json(cli(root, ['sandbox-init', '--force']));
    expect(b.updated).toEqual(['compose.yml']);
    expect(readFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'utf8')).toContain('other.jar');
    expect(json(cli(root, ['sandbox-init'])).unchanged).toContain('compose.yml');
  });

  test('a linked .goodboy is refused and nothing is written through it', () => {
    const root = dir();
    const elsewhere = dir('goodboy-m1-elsewhere-');
    mkdirSync(join(elsewhere, 'sandbox'));
    writeFileSync(join(elsewhere, SCAN_FILE.replace('.goodboy/', '')), JSON.stringify({ ...jvmScan(), root }));
    symlinkSync(elsewhere, join(root, '.goodboy'));
    const r = cli(root, ['sandbox-init']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('link');
    expect(readdirSync(join(elsewhere, 'sandbox'))).toEqual(['scan.json']);
    const l = cli(root, ['sandbox-local', '--dump', join(root, 'x.sql')]);
    expect(l.exitCode).toBe(1);
  });

  test('a linked sandbox subdir is refused', () => {
    const root = repo();
    const elsewhere = dir('goodboy-m1-elsewhere-');
    symlinkSync(elsewhere, join(root, SANDBOX_DIR, 'runtime'));
    const r = cli(root, ['sandbox-init']);
    expect(r.exitCode).toBe(1);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test('it needs a scan without problems', () => {
    const none = dir();
    const r = cli(none, ['sandbox-init']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('sandbox-scan');
    const bad = jvmScan();
    bad.problems = ['no build tool found'];
    const root = repo(bad);
    const r2 = cli(root, ['sandbox-init']);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr.toString()).toContain('no build tool found');
    expect(existsSync(join(root, SANDBOX_DIR, 'compose.yml'))).toBe(false);
    const garbled = repo();
    writeFileSync(join(garbled, SCAN_FILE), '{"stack":"cobol"}');
    expect(cli(garbled, ['sandbox-init']).stderr.toString()).toContain('not a scan goodboy wrote');
  });

  test('questions of the scan are passed on in the report', () => {
    const s = jvmScan();
    s.questions = ['Which profile does production use?'];
    expect(json(cli(repo(s), ['sandbox-init'])).questions).toEqual(['Which profile does production use?']);
  });

  test('a CA is made once; the server certificate names every dummy host and is renewed when they change', async () => {
    const root = repo();
    cli(root, ['sandbox-init']);
    const ca = join(root, SANDBOX_DIR, 'ca');
    expect(readdirSync(ca).sort()).toEqual(['ca.crt', 'ca.key', 'server.crt', 'server.key', 'server.p12', 'server.sans']);
    expect(statSync(join(ca, 'ca.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(ca, 'server.key')).mode & 0o777).toBe(0o600);
    const run = (args: string[]) => Bun.spawnSync(['openssl', ...args], { stdout: 'pipe', stderr: 'pipe' });
    expect(run(['verify', '-CAfile', join(ca, 'ca.crt'), join(ca, 'server.crt')]).stdout.toString()).toContain('OK');
    const text = run(['x509', '-in', join(ca, 'server.crt'), '-noout', '-text']).stdout.toString();
    for (const name of ['DNS:api.partner.example', 'DNS:smtp.corp.example', 'DNS:ldap.corp.example', 'IP Address:10.20.30.40']) expect(text).toContain(name);
    expect(run(['pkcs12', '-in', join(ca, 'server.p12'), '-noout', '-passin', 'pass:password']).exitCode).toBe(0);
    const crt = readFileSync(join(ca, 'ca.crt'), 'utf8');
    const s = jvmScan();
    s.outbound.push(out('extra.partner.example', 'http'));
    writeFileSync(join(root, SCAN_FILE), JSON.stringify({ ...s, root }));
    expect(json(cli(root, ['sandbox-init'])).ca).toBe('server-renewed');
    expect(readFileSync(join(ca, 'ca.crt'), 'utf8')).toBe(crt);
    expect(run(['x509', '-in', join(ca, 'server.crt'), '-noout', '-text']).stdout.toString()).toContain('DNS:extra.partner.example');
    expect(run(['verify', '-CAfile', join(ca, 'ca.crt'), join(ca, 'server.crt')]).stdout.toString()).toContain('OK');
  });

  test('no openssl: the error names it and nothing is written', async () => {
    const root = repo();
    const r = cli(root, ['sandbox-init'], { GOODBOY_OPENSSL_BIN: '/nonexistent/openssl' });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('openssl');
    expect(existsSync(join(root, SANDBOX_DIR, 'compose.yml'))).toBe(false);
  });

  test('initSandbox reports the files out of date after the scan changes', async () => {
    const root = repo();
    const rep = await initSandbox(root, jvmScan(), NO_DUMP, false);
    expect(rep).not.toBeInstanceOf(Error);
    expect(outOfDate(root, planSandbox({ ...jvmScan(), root }, NO_DUMP))).toEqual([]);
    const s = { ...jvmScan(), root };
    s.app.port = 9090;
    expect(outOfDate(root, planSandbox(s, NO_DUMP))).toContain('compose.yml');
  });
});

describe('sandbox-local', () => {
  // A dump must be under the home directory (the docker VMs mount only that): the temp dirs the
  // tests use stand in for it.
  const savedHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = realpathSync(tmpdir());
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  test('writes local.json with mode 0600, a .gitignore that hides it, and reads back', () => {
    const root = dir();
    const dump = join(dir(), 'shop.sql');
    writeFileSync(dump, 'select 1;');
    const r = cli(root, ['sandbox-local', '--dump', dump]);
    expect(r.exitCode).toBe(0);
    const p = join(root, SANDBOX_DIR, 'local.json');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // `realData` is set by --dump (M6a) and stays when the dump is removed
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ dump, dumpFormat: 'sql', realData: true });
    expect(readFileSync(join(root, SANDBOX_DIR, '.gitignore'), 'utf8')).toContain('local.json');
    expect(readLocal(root)).toEqual({ dump, dumpFormat: 'sql', realData: true });
  });

  test('the format is taken from the option, else from the file name', () => {
    const root = dir();
    const d = dir();
    writeFileSync(join(d, 'a.dump'), 'x');
    writeFileSync(join(d, 'b.sql'), 'x');
    expect(json(cli(root, ['sandbox-local', '--dump', join(d, 'a.dump')])).dumpFormat).toBe('custom');
    expect(json(cli(root, ['sandbox-local', '--dump', join(d, 'a.dump'), '--format', 'sql'])).dumpFormat).toBe('sql');
    expect(json(cli(root, ['sandbox-local', '--dump', join(d, 'b.sql')])).dumpFormat).toBe('sql');
  });

  test('refuses a relative path, a missing file, a directory and a bad format', () => {
    const root = dir();
    const d = dir();
    writeFileSync(join(d, 'a.sql'), 'x');
    expect(cli(root, ['sandbox-local', '--dump', 'a.sql']).stderr.toString()).toContain('absolute');
    expect(cli(root, ['sandbox-local', '--dump', join(d, 'nope.sql')]).stderr.toString()).toContain('does not exist');
    expect(cli(root, ['sandbox-local', '--dump', d]).stderr.toString()).toContain('not a file');
    expect(cli(root, ['sandbox-local', '--dump', join(d, 'a.sql'), '--format', 'tar']).exitCode).toBe(1);
    expect(cli(root, ['sandbox-local']).exitCode).toBe(1);
    expect(existsSync(join(root, SANDBOX_DIR, 'local.json'))).toBe(false);
  });

  test('a garbled local.json is an error, not an empty answer', () => {
    const root = dir();
    mkdirSync(join(root, SANDBOX_DIR), { recursive: true });
    writeFileSync(join(root, SANDBOX_DIR, 'local.json'), '{"dump":"relative"}');
    expect(readLocal(root)).toBeInstanceOf(Error);
    expect(writeLocal(root, 'rel', null)).toBeInstanceOf(Error);
  });
});

// ---- the check, with a fake docker ----

interface Fake {
  root: string;
  bin: string;
  state: string;
  ctx: Ctx;
  calls: () => string[];
}

type Tweak = { handAttached?: boolean; gatewayPing?: boolean; gatewayTcp?: boolean; noPingTool?: boolean; noInhibit?: boolean; withGateway?: boolean; bridgeContainer?: boolean; externalNetwork?: boolean; reachOut?: boolean; brokenTool?: boolean; wrongHost?: boolean; cfgPorts?: boolean; cfgDefaultNet?: boolean; noDummyRunning?: boolean; wrongLiteral?: boolean; probeFails?: boolean };

function nslookup(name: string, ips: string[]): string {
  return `@@ ${name}\nServer:\t\t127.0.0.11\nAddress:\t127.0.0.11:53\n\nNon-authoritative answer:\n${ips.map((ip) => `Name:\t${name}\nAddress: ${ip}\n`).join('')}\n`;
}

function fake(t: Tweak = {}, scan: SandboxScan = jvmScan()): Fake {
  const root = repo(scan);
  const state = dir('goodboy-m1-fake-');
  const bin = join(state, 'docker');
  writeFileSync(bin, FAKE_DOCKER);
  chmodSync(bin, 0o755);
  writeFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'services: {}\n');
  const ctx = loadCtx(root, true);
  if (ctx instanceof Error) throw ctx;
  const p = ctx.project;
  const compose = parse(ctx.plan) as Compose & { services: Record<string, Record<string, unknown>> };
  if (t.cfgPorts) compose.services.app!.ports = ['8080:8080'];
  if (t.cfgDefaultNet) delete compose.services.app!.networks;
  const net = (name: string, ip: string) => ({ [`${p}_${name}`]: { IPAddress: ip } });
  const ids: string[] = [];
  const inspect: unknown[] = [];
  const services: Record<string, { inner: string; literal?: [string, string] }> = { mail: { inner: '10.231.0.3' }, stubs: { inner: '10.231.0.4', literal: ['ip_10_20_30', t.wrongLiteral ? '10.20.30.99' : '10.20.30.40'] }, ldap: { inner: '10.231.0.5' }, db: { inner: '10.231.0.6' } };
  for (const [svc, a] of Object.entries(services)) {
    if (t.noDummyRunning && svc === 'mail') continue;
    ids.push(`id-${svc}`);
    inspect.push({
      Id: `id-${svc}`,
      Name: `/${p}-${svc}-1`,
      Config: { Labels: { 'com.docker.compose.service': svc } },
      HostConfig: { NetworkMode: `${p}_inner` },
      NetworkSettings: { Networks: { ...net('inner', a.inner), ...(a.literal ? net(a.literal[0], a.literal[1]) : {}), ...(svc === 'db' && t.bridgeContainer ? { bridge: { IPAddress: '172.17.0.2' } } : {}), ...(svc === 'db' && t.externalNetwork ? { 'other_net': { IPAddress: '10.9.9.9' } } : {}) } },
    });
  }
  const opts = t.noInhibit ? {} : { 'com.docker.network.bridge.inhibit_ipv4': 'true' };
  const ipam = t.withGateway ? { Config: [{ Subnet: '10.231.0.0/24', Gateway: '10.231.0.1' }] } : { Config: [{ Subnet: '10.231.0.0/24' }] };
  const netsJson = [
    { Name: `${p}_inner`, Internal: true, Options: opts, IPAM: ipam, ...(t.handAttached ? { Containers: { 'id-db': {}, 'id-intruder': {} } } : {}) },
    { Name: `${p}_ip_10_20_30`, Internal: true, Options: opts, IPAM: { Config: [{ Subnet: '10.20.30.0/24' }] } },
    ...(t.bridgeContainer ? [{ Name: 'bridge', Internal: false }] : []),
    ...(t.externalNetwork ? [{ Name: 'other_net', Internal: true }] : []),
  ];
  const marks = `${t.reachOut ? 'DNS=open\nTCP=open\nHTTP=open' : 'DNS=blocked\nTCP=blocked\nHTTP=blocked'}\nGW_PING=${t.gatewayPing ? 'open' : 'blocked'}\nGW_TCP=${t.gatewayTcp ? 'open' : 'blocked'}`;
  const ctl = `${t.brokenTool ? 'CTL_DNS=ok\nCTL_NC=fail\nCTL_WGET=ok' : 'CTL_DNS=ok\nCTL_NC=ok\nCTL_WGET=ok'}\nCTL_PING=${t.noPingTool ? 'fail' : 'ok'}`;
  const svcIp: Record<string, string> = { mail: '10.231.0.3', stubs: '10.231.0.4', ldap: '10.231.0.5' };
  const answers = ctx.plan.dummies
    .filter((d) => d.ip === null)
    .flatMap((d) => [nslookup(d.host, [t.wrongHost && d.service === 'stubs' ? '93.184.216.34' : svcIp[d.service]!]), nslookup(d.service, [svcIp[d.service]!])]);
  const probe = t.probeFails ? '' : `${ctl}\n${marks}\n${answers.join('')}@@END\n`;
  const w2 = (f: string, text: string) => writeFileSync(join(state, f), text);
  w2('config.json', JSON.stringify(compose));
  w2('ps.txt', ids.join('\n') + '\n');
  w2('inspect.json', JSON.stringify(inspect));
  w2('network.json', JSON.stringify(netsJson));
  if (t.handAttached) {
    // a container with no compose label, attached by hand to inner and to the default bridge
    w2('netls.txt', `${p}_inner\n`);
    w2('intruder.json', JSON.stringify([{ Id: 'id-intruder', Name: '/intruder', Config: { Labels: {} }, HostConfig: { NetworkMode: `${p}_inner` }, NetworkSettings: { Networks: { ...net('inner', '10.231.0.77'), bridge: { IPAddress: '172.17.0.9' } } } }]));
    netsJson.push({ Name: 'bridge', Internal: false } as never);
    w2('network.json', JSON.stringify(netsJson));
  }
  w2('probe.txt', probe);
  process.env.GOODBOY_DOCKER_BIN = bin;
  process.env.FAKE_DOCKER_DIR = state;
  return { root, bin, state, ctx, calls: () => (existsSync(join(state, 'calls.log')) ? readFileSync(join(state, 'calls.log'), 'utf8').trim().split('\n') : []) };
}

const withFake = (f: Fake, args: string[], env: Record<string, string> = {}) => cli(f.root, args, { GOODBOY_DOCKER_BIN: f.bin, FAKE_DOCKER_DIR: f.state, ...env });

describe('sandbox-check (fake docker)', () => {
  test('passes when every container is on internal networks, nothing gets out and the hosts reach their dummies', async () => {
    const f = fake();
    const c = await checkSandbox(f.ctx);
    expect(c).toEqual({ inner_only: true, egress_blocked: true, hosts_to_dummies: true, problems: [] });
    const r = withFake(f, ['sandbox-check']);
    expect(r.exitCode).toBe(0);
    expect(json(r)).toEqual(c);
    expect(f.calls().some((l) => l.includes(`-p ${f.ctx.project}`) && l.includes('--profile *') && l.includes('ps -q'))).toBe(true);
  });

  test('a container on a bridge network makes inner_only false', async () => {
    const f = fake({ bridgeContainer: true });
    const c = await checkSandbox(f.ctx);
    expect(c.inner_only).toBe(false);
    expect(c.problems.some((p) => p.includes('network bridge') && p.includes('not one of the sandbox'))).toBe(true);
    expect(c.problems.some((p) => p.includes('not internal'))).toBe(true);
    expect(withFake(f, ['sandbox-check']).exitCode).toBe(1);
  });

  test('an internal network that is not the sandbox\'s makes inner_only false too', async () => {
    const c = await checkSandbox(fake({ externalNetwork: true }).ctx);
    expect(c.inner_only).toBe(false);
    expect(c.problems.some((p) => p.includes('other_net'))).toBe(true);
  });

  test('a compose file with a published port or a service on the default network makes inner_only false', async () => {
    expect((await checkSandbox(fake({ cfgPorts: true }).ctx)).problems.some((p) => p.includes('service app publishes ports'))).toBe(true);
    const c = await checkSandbox(fake({ cfgDefaultNet: true }).ctx);
    expect(c.inner_only).toBe(false);
    expect(c.problems.some((p) => p.includes('service app is on network default'))).toBe(true);
  });

  test('a probe that reaches out makes egress_blocked false', async () => {
    const f = fake({ reachOut: true });
    const c = await checkSandbox(f.ctx);
    expect(c.egress_blocked).toBe(false);
    expect(c.problems.filter((p) => p.startsWith('egress is not blocked'))).toHaveLength(3);
    expect(c.inner_only).toBe(true);
    expect(withFake(f, ['sandbox-check']).exitCode).toBe(1);
  });

  test('a host that answers on the gateway address makes egress_blocked false, by ping or by port', async () => {
    const ping = await checkSandbox(fake({ gatewayPing: true }).ctx);
    expect(ping.egress_blocked).toBe(false);
    expect(ping.problems).toEqual([`egress is not blocked: the host's gateway address 10.231.0.1 answered a ping`]);
    const tcp = await checkSandbox(fake({ gatewayTcp: true }).ctx);
    expect(tcp.egress_blocked).toBe(false);
    expect(tcp.problems[0]).toContain('a port of 10.231.0.1 (22, 80, 443, 2375, 2376, 8080) accepted a connection');
  });

  test('a gateway mark the probe did not print fails closed', async () => {
    const f = fake();
    writeFileSync(join(f.state, 'probe.txt'), readFileSync(join(f.state, 'probe.txt'), 'utf8').replace('GW_TCP=blocked\n', ''));
    const c = await checkSandbox(f.ctx);
    expect(c.egress_blocked).toBe(false);
    expect(c.problems.some((p) => p.includes('accepted a connection'))).toBe(true);
  });

  test('a ping tool that does not work is not taken for a blocked gateway', async () => {
    const c = await checkSandbox(fake({ noPingTool: true }).ctx);
    expect(c.egress_blocked).toBe(false);
    expect(c.problems.join('\n')).toContain('CTL_PING');
  });

  test('a network that kept the host address makes inner_only false, from Docker\'s own report and from the compose file', async () => {
    const noOpt = await checkSandbox(fake({ noInhibit: true }).ctx);
    expect(noOpt.inner_only).toBe(false);
    expect(noOpt.problems.some((p) => p.includes('has a host address') && p.includes('Docker 28'))).toBe(true);
    const gw = await checkSandbox(fake({ withGateway: true }).ctx);
    expect(gw.inner_only).toBe(false);
    expect(gw.problems.some((p) => p.includes('has a host address (10.231.0.1)'))).toBe(true);
    expect(await checkSandbox(fake().ctx)).toMatchObject({ inner_only: true, egress_blocked: true });
  });

  test('staticProblems flags an internal network without the option, and passes one with it', () => {
    const cfg = (opts?: Record<string, string>) => ({ services: { app: { networks: ['inner'] } }, networks: { inner: { internal: true, ...(opts ? { driver_opts: opts } : {}) } } });
    expect(staticProblems(cfg())).toEqual([expect.stringContaining('network inner is internal but keeps an address for the host')]);
    expect(staticProblems(cfg({ 'com.docker.network.bridge.inhibit_ipv4': 'false' }))).toHaveLength(1);
    expect(staticProblems(cfg({ 'com.docker.network.bridge.inhibit_ipv4': 'true' }))).toEqual([]);
  });

  test('a container attached by hand to a sandbox network is found through the network, and its other networks count', async () => {
    const f = fake({ handAttached: true });
    const c = await checkSandbox(f.ctx);
    expect(c.inner_only).toBe(false);
    expect(c.problems).toContain("container intruder is on network bridge, which is not one of the sandbox's internal networks");
    // the project's own containers alone pass, with the same network list
    expect(await checkSandbox(fake().ctx)).toMatchObject({ inner_only: true });
  });

  test('staticProblems refuses privileged, added capabilities, devices, host namespaces and the docker socket, prep included', () => {
    const svc = (extra: Record<string, unknown>, profiles?: string[]) => ({ services: { x: { networks: ['inner'], ...(profiles ? { profiles } : {}), ...extra } }, networks: { inner: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' } } } });
    expect(staticProblems(svc({ privileged: true }))).toEqual(['service x is privileged']);
    expect(staticProblems(svc({ cap_add: ['SYS_ADMIN'] }))).toEqual(['service x adds capabilities (SYS_ADMIN)']);
    expect(staticProblems(svc({ devices: [{ source: '/dev/sda' }] }))).toEqual(['service x maps host devices']);
    expect(staticProblems(svc({ pid: 'host' }))).toEqual(["service x shares the host's pid namespace"]);
    expect(staticProblems(svc({ ipc: 'host' }))).toEqual(["service x shares the host's ipc namespace"]);
    expect(staticProblems(svc({ volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }))).toEqual(['service x mounts the docker socket']);
    expect(staticProblems(svc({ privileged: true }, ['prep']))).toEqual(['service x is privileged']);
    expect(staticProblems(svc({ cap_add: [], devices: [], pid: 'container:y' }))).toEqual([]);
  });

  test('sandbox-up and sandbox-prepare check the compose file first and start nothing when it is unsafe', () => {
    const f = fake();
    const cfg = JSON.parse(readFileSync(join(f.state, 'config.json'), 'utf8'));
    cfg.services.app.privileged = true;
    cfg.services.prep.volumes = [...cfg.services.prep.volumes, '/var/run/docker.sock:/var/run/docker.sock'];
    writeFileSync(join(f.state, 'config.json'), JSON.stringify(cfg));
    for (const cmd of ['sandbox-up', 'sandbox-prepare']) {
      const r = withFake(f, [cmd, '--wait-seconds', '5']);
      expect(r.exitCode).toBe(1);
      const err = r.stderr.toString();
      expect(err).toContain('not safe to start');
      expect(err).toContain('service app is privileged');
      expect(err).toContain('service prep mounts the docker socket');
    }
    const calls = f.calls().join('\n');
    expect(calls).not.toContain(' up -d');
    expect(calls).not.toContain(' pull');
    expect(calls).not.toContain(' run --rm');
  });

  test('bind sources are an allowlist: the repo and the dump only; unconfined security profiles are refused', () => {
    const root = '/work/repo';
    const bind = (source: string) => ({ services: { x: { networks: ['inner'], volumes: [{ type: 'bind', source, target: '/t' }] } }, networks: { inner: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' } } } });
    const refused = (src: string) => staticProblems(bind(src), root, '/home/me/dump.sql');
    for (const src of ['/var/run', '/run', '/', '/home/me', '/work', '/work/repo/../other', '/etc']) expect([src, refused(src).length]).toEqual([src, 1]);
    expect(refused('/var/run')[0]).toContain('service x binds /var/run');
    // the repo, its sandbox dir and subdirs, and the dump file
    for (const src of ['/work/repo', '/work/repo/.goodboy/sandbox/out/live', '/work/repo/.goodboy/sandbox/ca/ca.crt', '/home/me/dump.sql']) expect([src, refused(src)]).toEqual([src, []]);
    // a named volume is not a bind; without a root the allowlist does not apply (the socket still does)
    expect(staticProblems({ services: { x: { networks: ['inner'], volumes: [{ type: 'volume', source: 'gradle', target: '/g' }] } }, networks: { inner: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' } } } }, root)).toEqual([]);
    expect(staticProblems(bind('/var/run'))).toEqual([]);
    const sec = (opts: string[]) => ({ services: { x: { networks: ['inner'], security_opt: opts } }, networks: { inner: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' } } } });
    expect(staticProblems(sec(['seccomp=unconfined']))).toEqual(['service x turns off a security profile (security_opt unconfined)']);
    expect(staticProblems(sec(['apparmor=unconfined']))).toHaveLength(1);
    expect(staticProblems(sec(['no-new-privileges:true']))).toEqual([]);
  });

  test('a named volume that is really a host directory, and host network or published ports on prep, are refused; what the render makes passes', () => {
    const inhibit = { 'com.docker.network.bridge.inhibit_ipv4': 'true' };
    const base = (svc: Record<string, unknown>, volumes?: Record<string, unknown>) => ({ services: { prep: { profiles: ['prep'], networks: ['prep'], ...svc } }, networks: { prep: {}, inner: { internal: true, driver_opts: inhibit } }, ...(volumes ? { volumes } : {}) });
    expect(staticProblems(base({}, { gradle: { name: 'p_gradle' }, m2: {}, build: null }))).toEqual([]);
    expect(staticProblems(base({}, { loot: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/Users/me' } } }))).toEqual([expect.stringContaining('volume loot has driver options (type, o, device)')]);
    expect(staticProblems(base({}, { loot: { driver: 'local' } }))).toEqual([]);
    expect(staticProblems(base({}, { loot: { driver: 'nfs' } }))).toEqual(['volume loot uses the nfs driver']);
    expect(staticProblems(base({}, { loot: { external: true, name: 'host_bind_volume' } }))).toEqual([expect.stringContaining('volume loot is external')]);
    expect(staticProblems(base({ network_mode: 'host' }))).toEqual(['service prep sets network_mode host']);
    expect(staticProblems(base({ ports: [{ target: 80, published: '80' }] }))).toEqual(['service prep publishes ports']);
    expect(staticProblems(base({ ports: [] }))).toEqual([]);
  });

  test('the compose file the render makes passes the static check', () => {
    const f = fake();
    expect(staticProblems(JSON.parse(readFileSync(join(f.state, 'config.json'), 'utf8')), f.root)).toEqual([]);
  });

  test('a link in the repo that points outside it is not an allowed bind source', () => {
    const root = dir();
    const outside = dir('goodboy-m1-outside-');
    symlinkSync(outside, join(root, 'shortcut'));
    const cfg = { services: { x: { networks: ['inner'], volumes: [{ type: 'bind', source: join(root, 'shortcut'), target: '/t' }] } }, networks: { inner: { internal: true, driver_opts: { 'com.docker.network.bridge.inhibit_ipv4': 'true' } } } };
    expect(staticProblems(cfg, root)).toHaveLength(1);
  });

  test('a remote daemon gets no container command at all from the check, and sandbox-down is guarded too', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-check'], { DOCKER_HOST: 'tcp://203.0.113.9:2375' });
    expect(r.exitCode).toBe(1);
    expect(json(r)).toMatchObject({ inner_only: false, egress_blocked: false, hosts_to_dummies: false });
    expect(json(r).problems).toHaveLength(1);
    const down = withFake(f, ['sandbox-down'], { DOCKER_HOST: 'ssh://me@box' });
    expect(down.exitCode).toBe(1);
    expect(down.stderr.toString()).toContain('local docker daemon');
    // only the local context lookup ran
    expect(f.calls().every((l) => l.startsWith('context '))).toBe(true);
    const run = withFake(f, ['sandbox-run'], { DOCKER_HOST: 'tcp://203.0.113.9:2375' });
    expect(run.exitCode).toBe(1);
    expect(f.calls().join('\n')).not.toContain(' run --rm');
  });

  test('a remote docker daemon, by DOCKER_HOST or by the current context, is refused by the check, up and prepare', () => {
    const f = fake();
    const viaEnv = withFake(f, ['sandbox-check'], { DOCKER_HOST: 'tcp://10.1.1.1:2375' });
    expect(viaEnv.exitCode).toBe(1);
    expect(json(viaEnv).problems.join('\n')).toContain('DOCKER_HOST is tcp://10.1.1.1:2375');
    expect(withFake(f, ['sandbox-up'], { DOCKER_HOST: 'ssh://me@box' }).stderr.toString()).toContain('local docker daemon');
    expect(withFake(f, ['sandbox-prepare'], { DOCKER_HOST: 'tcp://x:1' }).stderr.toString()).toContain('local docker daemon');
    expect(withFake(f, ['sandbox-check'], { DOCKER_HOST: 'unix:///var/run/docker.sock' }).exitCode).toBe(0);
    writeFileSync(join(f.state, 'context.txt'), 'ssh://me@box\n');
    const viaContext = withFake(f, ['sandbox-check'], { DOCKER_HOST: '' });
    expect(viaContext.exitCode).toBe(1);
    expect(json(viaContext).problems.join('\n')).toContain('docker context points at ssh://me@box');
    writeFileSync(join(f.state, 'context.txt'), 'unix:///Users/me/.colima/default/docker.sock\n');
    expect(withFake(f, ['sandbox-check'], { DOCKER_HOST: '' }).exitCode).toBe(0);
  });

  test('a probe tool that does not work is not taken for a blocked network', async () => {
    const c = await checkSandbox(fake({ brokenTool: true }).ctx);
    expect(c.egress_blocked).toBe(false);
    expect(c.problems.join('\n')).toContain('CTL_NC');
  });

  test('a probe that did not run is not taken for a blocked network', async () => {
    const c = await checkSandbox(fake({ probeFails: true }).ctx);
    expect(c.egress_blocked).toBe(false);
    expect(c.problems.join('\n')).toContain('did not run to its end');
  });

  test('a host that does not resolve to its dummy makes hosts_to_dummies false', async () => {
    const c = await checkSandbox(fake({ wrongHost: true }).ctx);
    expect(c.hosts_to_dummies).toBe(false);
    expect(c.problems.some((p) => p.startsWith('api.partner.example resolves to 93.184.216.34') && p.includes('not to stubs'))).toBe(true);
  });

  test('a dummy that is not running fails the check, and so does an IP literal it does not hold', async () => {
    const c1 = await checkSandbox(fake({ noDummyRunning: true }).ctx);
    expect(c1.hosts_to_dummies).toBe(true);
    const c2 = await checkSandbox(fake({ wrongLiteral: true }).ctx);
    expect(c2.hosts_to_dummies).toBe(false);
    expect(c2.problems.some((p) => p.includes('does not hold 10.20.30.40'))).toBe(true);
  });

  test('a docker that fails fails the check, never passes it', async () => {
    const f = fake();
    process.env.GOODBOY_DOCKER_BIN = '/nonexistent/docker';
    const c = await checkSandbox(f.ctx);
    expect(c.inner_only).toBe(false);
    expect(c.egress_blocked).toBe(false);
    expect(c.hosts_to_dummies).toBe(false);
  });

  test('without the compose file the command says to run sandbox-init; without a scan, sandbox-scan', () => {
    const f = fake();
    rmSync(join(f.root, SANDBOX_DIR, 'compose.yml'));
    expect(withFake(f, ['sandbox-check']).stderr.toString()).toContain('sandbox-init');
    const none = dir();
    expect(cli(none, ['sandbox-run']).stderr.toString()).toContain('sandbox-scan');
  });

  test('parseNslookup reads the answer, not the server, in both busybox layouts', () => {
    expect(parseNslookup('Server:\t127.0.0.11\nAddress:\t127.0.0.11:53\n\nNon-authoritative answer:\nName:\tmail\nAddress: 10.0.0.3\n')).toEqual(['10.0.0.3']);
    expect(parseNslookup('Server:    127.0.0.11\nAddress 1: 127.0.0.11\n\nName:      mail\nAddress 1: 10.0.0.3 mail.x\n')).toEqual([]);
    expect(parseNslookup('Name:\tmail\nAddress 1: 10.0.0.3\nAddress 2: 10.0.0.4\n')).toEqual(['10.0.0.3', '10.0.0.4']);
    expect(parseNslookup("** server can't find nope: NXDOMAIN\n")).toEqual([]);
  });

  test('the probe script verifies its tools first and names every host', () => {
    const s = probeScript(['a.example', 'mail'], '10.231.0.1');
    expect(s.indexOf('CTL_NC')).toBeLessThan(s.indexOf('TCP=open'));
    expect(s.indexOf('CTL_PING')).toBeLessThan(s.indexOf('GW_PING='));
    expect(s).toContain('ping -c 1 -W 2 10.231.0.1');
    // the gateway attempts run side by side and are waited for together
    expect(s).toContain('for p in 22 80 443 2375 2376 8080; do (nc -z -w 2 10.231.0.1 $p');
    expect(s.slice(s.indexOf('ping -c 1 -W 2 10.231.0.1'), s.indexOf('echo GW_PING='))).toContain('wait $pids');
    expect(s).toContain('nc -z -w 3 1.1.1.1 443');
    expect(s).toContain('wget -T 3 -q --spider http://example.com');
    expect(s).toContain('nslookup example.com');
    expect(s).toContain('nslookup a.example');
  });

  test('staticProblems lets prep-only services keep their network', () => {
    expect(staticProblems({ services: { prep: { profiles: ['prep'], networks: { prep: null } } }, networks: { prep: {} } })).toEqual([]);
    expect(staticProblems({ services: { x: { network_mode: 'host' } }, networks: {} })).toEqual(['service x sets network_mode host', 'service x is on network default, which is not internal']);
    expect(staticProblems(undefined)).toEqual(['compose config has no services']);
  });

  test('the project name carries the dir name and a hash of the real path', () => {
    const a = dir('goodboy-m1-same-');
    expect(projectName(a)).toMatch(/^gb-goodboy-m1-same-[a-z0-9]+-[0-9a-f]{6}$/);
    expect(projectName(a)).toBe(projectName(a));
    expect(projectName(a)).not.toBe(projectName(dir('goodboy-m1-same-')));
  });
});

describe('sandbox-run (fake docker)', () => {
  test('a failed check stops the run: exit 1, no runner, a result with the check', () => {
    const f = fake({ bridgeContainer: true });
    const r = withFake(f, ['sandbox-run']);
    expect(r.exitCode).toBe(1);
    expect(f.calls().some((l) => l.includes(' runner'))).toBe(false);
    expect(f.calls().some((l) => l.includes('reset.sh'))).toBe(false);
    const o = json(r);
    expect(o.check.inner_only).toBe(false);
    const res = JSON.parse(readFileSync(o.result, 'utf8'));
    expect(res.check.inner_only).toBe(false);
    expect(res.exit).toBeNull();
    expect(res.stopped).toContain('check failed');
  });

  test('an egress that is open stops the run too', () => {
    const f = fake({ reachOut: true });
    expect(withFake(f, ['sandbox-run']).exitCode).toBe(1);
    expect(f.calls().some((l) => l.includes(' runner'))).toBe(false);
  });

  test('a passing check resets the db from the template, runs the runner, writes the result; the exit code is the suite\'s', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-run', '--suite', 'unit'], { FAKE_RUNNER_EXIT: '3' });
    expect(r.exitCode).toBe(3);
    const calls = f.calls();
    const reset = calls.findIndex((l) => l.includes('exec -T db sh /goodboy-db/reset.sh'));
    const run = calls.findIndex((l) => l.includes('run --rm -T --no-deps --name') && l.includes(' runner'));
    const probe = calls.findIndex((l) => l.includes(' probe '));
    expect(probe).not.toBe(-1); // the check's probe ran (findIndex gives -1 for a call that never happened)
    expect(reset).toBeGreaterThan(probe);
    expect(run).toBeGreaterThan(reset);
    expect(calls[run]).toContain(`-p ${f.ctx.project}`);
    const o = json(r);
    const res = JSON.parse(readFileSync(o.result, 'utf8'));
    expect(res).toMatchObject({ suite: 'unit', exit: 3, command: ['./gradlew', 'test', '--offline'], timedOut: false });
    expect(res.check).toEqual({ inner_only: true, egress_blocked: true, hosts_to_dummies: true, problems: [] });
    expect(res.tail).toContain('runner output line');
    expect(typeof res.durationMs).toBe('number');
    expect(o.result.startsWith(join(f.root, SANDBOX_DIR, 'out'))).toBe(true);
    expect(readFileSync(join(dirname(o.result), 'output.log'), 'utf8')).toContain('runner output line');
  });

  test('a command after -- replaces the test command', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-run', '--', './gradlew', 'test', '--tests', 'com.acme.UserTest']);
    expect(r.exitCode).toBe(0);
    const run = f.calls().find((l) => l.includes(' runner'))!;
    expect(run).toContain('runner ./gradlew test --tests com.acme.UserTest');
    expect(JSON.parse(readFileSync(json(r).result, 'utf8')).command).toEqual(['./gradlew', 'test', '--tests', 'com.acme.UserTest']);
  });

  test('a db that cannot be reset stops the run before the suite', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-run'], { FAKE_EXEC_EXIT: '1' });
    expect(r.exitCode).toBe(1);
    expect(json(r).stopped).toContain('resetting db');
    expect(f.calls().some((l) => l.includes(' runner'))).toBe(false);
  });

  test('a running app is restarted after the reset', () => {
    const f = fake();
    writeFileSync(join(f.state, 'ps-app.txt'), 'id-app\n');
    withFake(f, ['sandbox-run']);
    const calls = f.calls();
    expect(calls.findIndex((l) => l.includes(' restart app'))).toBeGreaterThan(calls.findIndex((l) => l.includes('reset.sh')));
  });

  test('refuses a bad suite and an empty command', () => {
    const f = fake();
    expect(withFake(f, ['sandbox-run', '--suite', 'bogus']).stderr.toString()).toContain('--suite');
    expect(withFake(f, ['sandbox-run', '--']).stderr.toString()).toContain('nothing after');
    expect(f.calls().some((l) => l.includes(' runner'))).toBe(false);
  });

  test('sandbox-up starts the stores and dummies, restores once, resets and waits for the app through the probe', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-up', '--wait-seconds', '5']);
    expect(r.exitCode).toBe(0);
    const calls = f.calls();
    const idx = (s: string) => calls.findIndex((l) => l.includes(s));
    expect(calls[idx('up -d --wait')]).toContain(' db redis mail stubs ldap');
    expect(idx('restore.sh')).toBeGreaterThan(idx('up -d --wait'));
    expect(idx('reset.sh')).toBeGreaterThan(idx('restore.sh'));
    expect(idx('up -d app')).toBeGreaterThan(idx('reset.sh'));
    const health = calls[idx(' probe sh -c')]!;
    expect(health).toContain('http://app:8080/actuator/health');
    expect(json(r).appUrl).toBe('http://app:8080/actuator/health');
  });

  test('sandbox-prepare pulls, then runs prep in its profile; sandbox-down keeps the volumes unless asked', () => {
    const f = fake();
    expect(withFake(f, ['sandbox-prepare']).exitCode).toBe(0);
    const calls = f.calls();
    expect(calls.findIndex((l) => l.includes(' pull'))).toBeLessThan(calls.findIndex((l) => l.includes('--profile prep run --rm -T prep')));
    withFake(f, ['sandbox-down']);
    expect(f.calls().at(-1)).toContain('down --remove-orphans');
    expect(f.calls().at(-1)).not.toContain(' -v');
    expect(json(withFake(f, ['sandbox-down', '--volumes'])).volumes).toBe('removed');
    // the last call is the look at the project's volumes after the down, which decides on the real-data flag
    expect(f.calls().filter((l) => l.includes(' down ')).at(-1)).toContain(' -v');
  });

  test('sandbox-prepare also installs the e2e packages in their own step; sandbox-up starts the proxy and waits on it', () => {
    const f = fake();
    const p = json(withFake(f, ['sandbox-prepare']));
    expect(p.e2e).toMatchObject({ step: 'e2e-prep', exit: 0 });
    expect(f.calls().some((l) => l.includes('--profile prep run --rm -T e2e-prep'))).toBe(true);
    const r = withFake(f, ['sandbox-up', '--wait-seconds', '5']);
    expect(r.exitCode).toBe(0);
    const calls = f.calls();
    const idx = (s: string) => calls.findIndex((l) => l.includes(s));
    expect(idx('up -d proxy')).toBeGreaterThan(idx('up -d app'));
    expect(calls.filter((l) => l.includes(' probe sh -c'))).toHaveLength(2);
    expect(calls.filter((l) => l.includes(' probe sh -c')).at(-1)).toContain('http://proxy:8080/actuator/health');
    expect(json(r).proxyUrl).toBe('http://proxy:8080/actuator/health');
    // /live is a named volume since M6a: nothing of it is made in the checkout
    expect(existsSync(join(f.root, SANDBOX_DIR, 'out', 'live'))).toBe(false);
  });
});

describe('output the model sees (fake docker)', () => {
  const CANARY = 'CANARY-real-person@example.com';

  test('a passing suite prints no output tail; the full output stays in the run dir', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-run', '--suite', 'unit']);
    expect(r.exitCode).toBe(0);
    const o = json(r);
    expect(o.tail).toBe('');
    expect(r.stdout.toString()).not.toContain('runner output line');
    expect(JSON.parse(readFileSync(o.result, 'utf8')).tail).toBe('');
    expect(readFileSync(join(dirname(o.result), 'output.log'), 'utf8')).toContain('runner output line');
  });

  test('a failing suite keeps a tail of at most 2000 characters', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-run', '--suite', 'unit'], { FAKE_RUNNER_EXIT: '1' });
    expect(r.exitCode).toBe(1);
    expect(json(r).tail).toContain('runner output line');
    expect(json(r).tail.length).toBeLessThanOrEqual(2000);
  });

  test('a failed restore shows only the tagged lines, never the client text', () => {
    const f = fake();
    writeFileSync(join(f.state, 'restore-err.txt'), `goodboy: SQLSTATE 23505 at dump line 3\nERROR:  duplicate key (email)=(${CANARY})\n`);
    const r = withFake(f, ['sandbox-up', '--wait-seconds', '5'], { FAKE_RESTORE_EXIT: '1' });
    expect(r.exitCode).toBe(1);
    const text = r.stdout.toString() + r.stderr.toString();
    expect(text).toContain('SQLSTATE 23505 at dump line 3');
    expect(text).not.toContain(CANARY);
    writeFileSync(join(f.state, 'restore-err.txt'), `psql: ${CANARY}\n`);
    const r2 = withFake(f, ['sandbox-up', '--wait-seconds', '5'], { FAKE_RESTORE_EXIT: '1' });
    const text2 = r2.stdout.toString() + r2.stderr.toString();
    expect(text2).toContain('withheld');
    expect(text2).not.toContain(CANARY);
  });

  test('the app log of an app that does not come up is shown only with --app-logs', () => {
    const f = fake();
    writeFileSync(join(f.state, 'app-logs.txt'), `started for ${CANARY}\n`);
    const plain = withFake(f, ['sandbox-up', '--wait-seconds', '5'], { FAKE_HEALTH_EXIT: '1' });
    expect(plain.exitCode).toBe(1);
    const text = plain.stdout.toString() + plain.stderr.toString();
    expect(text).not.toContain(CANARY);
    expect(text).toContain('--app-logs');
    const withLogs = withFake(f, ['sandbox-up', '--wait-seconds', '5', '--app-logs'], { FAKE_HEALTH_EXIT: '1' });
    expect(withLogs.stdout.toString()).toContain(CANARY);
  });
});

// ---- the e2e suite, the proxy log and the coverage reports (M3, with a fake docker) ----

const REPORT = JSON.stringify({ suites: [{ title: 'a.spec.ts', specs: [] }] });
const ACCESS = '{"request":{"method":"GET","uri":"/","headers":{}},"status":200}\n';

/** A fake docker project with the project's e2e tests, a Playwright report and an access log in place. */
function e2eFake(t: Tweak = {}, scan?: SandboxScan): Fake {
  const f = fake(t, scan);
  mkdirSync(join(f.root, 'e2e'), { recursive: true });
  writeFileSync(join(f.root, 'e2e', 'a.spec.ts'), 'export {};\n');
  writeFileSync(join(f.state, 'playwright-report.json'), REPORT);
  // what the proxy writes while the e2e container runs: the fake copies it into the `live` volume then
  writeFileSync(join(f.state, 'access.log'), ACCESS);
  return f;
}

describe('sandbox-run --suite e2e (fake docker)', () => {
  test('starts the proxy and the app fresh, runs the e2e service, stops the app, copies the log and writes the reports into the result', () => {
    const f = e2eFake();
    writeFileSync(join(f.state, 'ps-app.txt'), 'id-app\n');
    const r = withFake(f, ['sandbox-run', '--suite', 'e2e']);
    expect(r.exitCode).toBe(0);
    const calls = f.calls();
    const at = (s: string) => calls.findIndex((l) => l.includes(s));
    const order = [at('up -d proxy'), at('rm -rf /live/jacoco-e2e.exec'), at(' restart app'), at('http://proxy:8080/actuator/health'), at(': > /live/access.log'), at(' e2e'), at('stop -t 60 app'), at('coverage.sh report-e2e')];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const o = json(r);
    const ts = o.ts as string;
    const runDir = join(f.root, SANDBOX_DIR, 'out', ts);
    expect(calls[at(' e2e')]).toContain(`-e GOODBOY_OUT=/outroot/${ts} e2e`);
    expect(o.accessLog).toBe(join(runDir, 'access.log'));
    expect(readFileSync(o.accessLog, 'utf8')).toBe(ACCESS);
    expect(o.playwrightReport).toBe(join(runDir, 'playwright-report.json'));
    expect(o.coverageReports).toEqual([join(runDir, 'coverage', 'jacoco.xml')]);
    expect(existsSync(o.coverageReports[0])).toBe(true);
    const res = JSON.parse(readFileSync(o.result, 'utf8'));
    expect(res).toMatchObject({ suite: 'e2e', exit: 0, accessLog: o.accessLog, playwrightReport: o.playwrightReport, coverageReports: o.coverageReports });
    expect(res.e2e).toMatchObject({ exit: 0, artifacts: 'removed', problems: [] });
    expect(res.unit).toBeUndefined();
    expect(readFileSync(join(runDir, 'e2e-output.log'), 'utf8')).toContain('e2e output line');
  });

  test('a passing run deletes its traces and screenshots; a failing run keeps them and exits with the failure', () => {
    // the traces are in the run's dir of the runout volume (the fake keeps it under its state dir)
    const pass = e2eFake();
    const p = json(withFake(pass, ['sandbox-run', '--suite', 'e2e']));
    expect(existsSync(join(pass.state, 'vol', 'outroot', p.ts, 'e2e-artifacts'))).toBe(false);
    expect(p.e2e.artifacts).toBe('removed');
    const fail = e2eFake();
    const r = withFake(fail, ['sandbox-run', '--suite', 'e2e'], { FAKE_E2E_EXIT: '1' });
    expect(r.exitCode).toBe(1);
    const o = json(r);
    expect(readFileSync(join(fail.state, 'vol', 'outroot', o.ts, 'e2e-artifacts', 'trace.zip'), 'utf8')).toContain('trace');
    expect(JSON.parse(readFileSync(o.result, 'utf8')).e2e).toMatchObject({ exit: 1, artifacts: 'kept' });
  });

  test('--suite all runs the unit suite, resets the database again, then the e2e suite, and one coverage report for both', () => {
    const f = e2eFake();
    const r = withFake(f, ['sandbox-run']);
    expect(r.exitCode).toBe(0);
    const calls = f.calls();
    const resets = calls.map((l, i) => (l.includes('reset.sh') ? i : -1)).filter((i) => i >= 0);
    expect(resets).toHaveLength(2);
    const unit = calls.findIndex((l) => l.includes('--name') && l.includes('-runner-') && l.includes(' runner'));
    const e2e = calls.findIndex((l) => l.includes(' e2e') && l.includes('--name'));
    expect(resets[0]!).toBeLessThan(unit);
    expect(unit).toBeLessThan(resets[1]!);
    expect(resets[1]!).toBeLessThan(e2e);
    expect(calls.filter((l) => l.includes('coverage.sh'))).toHaveLength(1);
    expect(calls.find((l) => l.includes('coverage.sh'))).toContain('report-e2e');
    const res = JSON.parse(readFileSync(json(r).result, 'utf8'));
    expect(res.unit).toMatchObject({ exit: 0 });
    expect(res.e2e).toMatchObject({ exit: 0 });
  });

  test('a failing unit suite does not stop the e2e suite; the exit code is the first failure', () => {
    const f = e2eFake();
    const r = withFake(f, ['sandbox-run'], { FAKE_RUNNER_EXIT: '3', FAKE_E2E_EXIT: '1' });
    expect(r.exitCode).toBe(3);
    const res = JSON.parse(readFileSync(json(r).result, 'utf8'));
    expect(res).toMatchObject({ exit: 3, unit: { exit: 3 }, e2e: { exit: 1 } });
  });

  test('the unit runner gets the run dir of the volume as GOODBOY_OUT, and a unit-only run takes no e2e data into its coverage report', () => {
    const f = e2eFake();
    const r = withFake(f, ['sandbox-run', '--suite', 'unit']);
    expect(r.exitCode).toBe(0);
    const o = json(r);
    const calls = f.calls();
    const runDir = dirname(o.result);
    expect(calls.find((l) => l.includes('-runner-') && l.includes(' runner'))).toContain(`-e GOODBOY_OUT=/outroot/${o.ts} runner`);
    const cov = calls.find((l) => l.includes('coverage.sh'))!;
    expect(cov).toContain('coverage.sh report');
    expect(cov).not.toContain('report-e2e');
    expect(cov).toContain('-e GOODBOY_COVERAGE_OUT= ');
    expect(calls.some((l) => l.includes('up -d proxy'))).toBe(false);
    expect(o.accessLog).toBeNull();
    expect(o.coverageReports).toEqual([join(runDir, 'coverage', 'jacoco.xml')]);
  });

  test('a coverage report that fails is reported in the result and does not change the exit code', () => {
    const f = e2eFake();
    const r = withFake(f, ['sandbox-run', '--suite', 'e2e'], { FAKE_COVERAGE_EXIT: '4' });
    expect(r.exitCode).toBe(0);
    const o = json(r);
    expect(o.coverage).toMatchObject({ ok: false, exit: 4, reports: [] });
    expect(o.coverage.note).toContain('sandbox-prepare');
    expect(o.coverageReports).toEqual([]);
  });

  test('--suite e2e needs the project\'s e2e tests; --suite all without them runs the unit suite only', () => {
    const f = fake();
    const r = withFake(f, ['sandbox-run', '--suite', 'e2e']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('e2e/');
    expect(f.calls().some((l) => l.includes('up -d proxy'))).toBe(false);
    const all = withFake(f, ['sandbox-run']);
    expect(all.exitCode).toBe(0);
    expect(json(all).e2e).toBeUndefined();
    expect(f.calls().some((l) => l.includes(' e2e'))).toBe(false);
  });

  test('a scan with no test command can still run the e2e suite; there is no runner, so the coverage report says so', () => {
    const scan = jvmScan();
    scan.build.testCommand = [];
    const f = e2eFake({}, scan);
    const r = withFake(f, ['sandbox-run', '--suite', 'e2e']);
    expect(r.exitCode).toBe(0);
    expect(json(r).coverage).toMatchObject({ ok: false, exit: null, reports: [] });
    expect(json(r).coverage.note).toContain('no test command');
    expect(f.calls().some((l) => l.includes('coverage.sh'))).toBe(false);
    expect(json(r).accessLog).not.toBeNull();
  });

  test('a command after -- goes to the e2e service for --suite e2e and to the runner otherwise', () => {
    const f = e2eFake();
    withFake(f, ['sandbox-run', '--suite', 'e2e', '--', '/work/node_modules/.bin/playwright', 'test', 'a.spec.ts']);
    expect(f.calls().find((l) => l.includes(' e2e') && l.includes('--name'))).toContain('e2e /work/node_modules/.bin/playwright test a.spec.ts');
    const g = e2eFake();
    withFake(g, ['sandbox-run', '--', './gradlew', 'test']);
    expect(g.calls().find((l) => l.includes(' e2e') && l.includes('--name'))!.endsWith(' e2e')).toBe(true);
    expect(g.calls().find((l) => l.includes('-runner-'))).toContain('runner ./gradlew test');
  });

  test('links a test left in the run dir of the volume are replaced, never written through; the host copies are plain files', () => {
    const f = e2eFake();
    const victim = join(f.state, 'victim.txt');
    writeFileSync(victim, 'VICTIM-ORIGINAL');
    // a failing run keeps its dir in the volume, so the files in it can be looked at
    const r = withFake(f, ['sandbox-run', '--suite', 'all'], { FAKE_PLANT_RUNNER: 'output.log', FAKE_PLANT_E2E: 'e2e-output.log', FAKE_PLANT_COVERAGE: 'result.json', FAKE_VICTIM: victim, FAKE_RUNNER_EXIT: '1' });
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM-ORIGINAL');
    const o = json(r);
    const hostDir = dirname(o.result);
    const volDir = join(f.state, 'vol', 'outroot', o.ts);
    for (const base of [hostDir, volDir]) for (const n of ['output.log', 'e2e-output.log']) expect([base, n, lstatSync(join(base, n)).isFile()]).toEqual([base, n, true]);
    expect(readFileSync(join(volDir, 'output.log'), 'utf8')).toContain('runner output line');
    expect(readFileSync(join(volDir, 'e2e-output.log'), 'utf8')).toContain('e2e output line');
    expect(readFileSync(join(hostDir, 'access.log'), 'utf8')).toBe(ACCESS);
    // the host's own result is untouched by what the container left under that name in the volume
    expect(lstatSync(join(hostDir, 'result.json')).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(hostDir, 'result.json'), 'utf8')).coverageReports.length).toBe(1);
  });

  test('a coverage dir that became a link makes no report: every part below the run dir is checked', () => {
    const f = e2eFake();
    const host = join(f.state, 'hostdir');
    mkdirSync(host);
    writeFileSync(join(host, 'jacoco.xml'), '<host-secret/>');
    const r = withFake(f, ['sandbox-run', '--suite', 'unit'], { FAKE_COVERAGE_LINK: host });
    const res = JSON.parse(readFileSync(json(r).result, 'utf8'));
    expect(res.coverageReports).toEqual([]);
    expect(res.coverage.ok).toBe(false);
    // the same run with a real coverage dir has its report
    const ok = JSON.parse(readFileSync(json(withFake(f, ['sandbox-run', '--suite', 'unit'])).result, 'utf8'));
    expect(ok.coverage.ok).toBe(true);
  });

  test('a Playwright report that is a link is not passed on as the run\'s report', () => {
    const f = e2eFake();
    const victim = join(f.state, 'victim.txt');
    writeFileSync(victim, 'VICTIM-ORIGINAL');
    const r = withFake(f, ['sandbox-run', '--suite', 'e2e'], { FAKE_PLANT_E2E: 'playwright-report.json', FAKE_VICTIM: victim });
    const res = JSON.parse(readFileSync(json(r).result, 'utf8'));
    expect(res.playwrightReport).toBeNull();
    expect(res.e2e.problems).toContain('the e2e run wrote no Playwright report');
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM-ORIGINAL');
  });

  test('a directory where the log goes in the volume does not stop the run: the log is lost, said in the result, and nothing is written outside', () => {
    const f = e2eFake();
    const victim = join(f.state, 'victim.txt');
    writeFileSync(victim, 'VICTIM-ORIGINAL');
    const r = withFake(f, ['sandbox-run', '--suite', 'unit'], { FAKE_PLANT_DIRS: 'output.log', FAKE_VICTIM: victim });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(json(r).result, 'utf8')).problems).toContain('output.log could not be written to the run volume');
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM-ORIGINAL');
  });

  test('an access log that is a link in the volume is refused, not followed or copied', () => {
    const f = e2eFake();
    const elsewhere = join(f.state, 'secret.txt');
    writeFileSync(elsewhere, 'host secret');
    const r = withFake(f, ['sandbox-run', '--suite', 'e2e'], { FAKE_PLANT_LIVE: 'access.log', FAKE_VICTIM: elsewhere });
    const res = JSON.parse(readFileSync(json(r).result, 'utf8'));
    expect(res.accessLog).toBeNull();
    expect(res.e2e.problems.some((p: string) => p.includes('access log') && p.includes('not a regular file'))).toBe(true);
    expect(existsSync(join(dirname(json(r).result), 'access.log'))).toBe(false);
  });

  test('a missing access log is a problem in the result, not a crash', () => {
    const f = e2eFake();
    rmSync(join(f.state, 'access.log'));
    const r = withFake(f, ['sandbox-run', '--suite', 'e2e']);
    const res = JSON.parse(readFileSync(json(r).result, 'utf8'));
    expect(res.accessLog).toBeNull();
    expect(res.e2e.problems.some((p: string) => p.includes('access log'))).toBe(true);
  });
});

// ---- a real docker: opt in with GOODBOY_DOCKER_IT=1 (pulls busybox only) ----

describe.skipIf(process.env.GOODBOY_DOCKER_IT !== '1' || !hasOpenssl)('real docker', () => {
  const docker = (args: string[]) => Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });

  test('a probe on an internal network cannot resolve or reach out; the sandbox check passes and sees an intruder', async () => {
    delete process.env.GOODBOY_DOCKER_BIN;
    const scan = nodeScan();
    scan.stores = [];
    scan.outbound = [];
    scan.secretKeys = [];
    const root = repo(scan);
    const rep = await initSandbox(root, scan, NO_DUMP, false);
    expect(rep).not.toBeInstanceOf(Error);
    const ctx = loadCtx(root, true);
    if (ctx instanceof Error) throw ctx;
    const intruder = `${ctx.project}-intruder`;
    try {
      const c = await checkSandbox(ctx);
      expect(c.problems).toEqual([]);
      expect(c).toEqual({ inner_only: true, egress_blocked: true, hosts_to_dummies: true, problems: [] });
      // The same compose project with one container on the default bridge: inner_only must turn false.
      const run = docker(['run', '-d', '--name', intruder, '--label', `com.docker.compose.project=${ctx.project}`, '--label', 'com.docker.compose.service=intruder', IMAGES.probe, 'sleep', '120']);
      expect(run.exitCode).toBe(0);
      const bad = await checkSandbox(ctx);
      expect(bad.inner_only).toBe(false);
      expect(bad.problems.some((p) => p.includes('intruder') || p.includes('bridge'))).toBe(true);
    } finally {
      docker(['rm', '-f', intruder]);
      Bun.spawnSync(['docker', 'compose', '-f', ctx.composeFile, '-p', ctx.project, '--profile', '*', 'down', '--remove-orphans', '-v'], { stdout: 'pipe', stderr: 'pipe', cwd: ctx.dir });
    }
  }, 240_000);

  test('the probe script itself: on an internal network without a host address nothing answers; one with the usual gateway is caught', () => {
    const third = 20 + Math.floor(Math.random() * 200);
    const mk = (inhibit: boolean) => {
      const net = `gbtest-${Math.random().toString(36).slice(2, 8)}`;
      const subnet = `10.239.${inhibit ? third : third + 1}.0/24`;
      const gw = subnet.replace('.0/24', '.1');
      const args = ['network', 'create', '--internal', '--subnet', subnet, ...(inhibit ? ['-o', 'com.docker.network.bridge.inhibit_ipv4=true', '--aux-address', `goodboy-gateway=${gw}`] : [])];
      return { net, gw, create: () => docker([...args, net]) };
    };
    const probe = (n: { net: string; gw: string }) => docker(['run', '--rm', '--network', n.net, '--name', `${n.net}-probe`, IMAGES.probe, 'sh', '-c', probeScript([], n.gw)]);
    const safe = mk(true);
    const open = mk(false);
    try {
      expect(safe.create().exitCode).toBe(0);
      expect(open.create().exitCode).toBe(0);
      const out = probe(safe).stdout.toString();
      for (const line of ['CTL_DNS=ok', 'CTL_NC=ok', 'CTL_WGET=ok', 'CTL_PING=ok', 'DNS=blocked', 'TCP=blocked', 'HTTP=blocked', 'GW_PING=blocked', 'GW_TCP=blocked', '@@END']) expect(out).toContain(line);
      // the control: with Docker's own gateway the host answers a ping, so the probe sees it
      expect(probe(open).stdout.toString()).toContain('GW_PING=open');
    } finally {
      docker(['network', 'rm', safe.net]);
      docker(['network', 'rm', open.net]);
    }
  }, 180_000);
});

// ---- the docker commands in this process ----
// The tests above start the CLI for the commands that start, run and stop containers; a spawned
// process is not measured by the coverage tool and shows no failure path. These call
// `sandboxCommand` in this process with a wrapper around the fake docker that can fail, answer
// with garbage, sleep or script a sequence for chosen calls (FAKE_FAIL, FAKE_GARBAGE, FAKE_SLEEP
// match a substring of " <arguments> "; FAKE_SEQ is a dir with the answers of a chain of inspect
// calls).

const WRAP = (orig: string) => `#!/bin/sh
# the state dir is where the wrapper sits, so a call that carries no FAKE_DOCKER_DIR still logs there
FAKE_DOCKER_DIR="\${FAKE_DOCKER_DIR:-$(dirname "$0")}"; export FAKE_DOCKER_DIR
if [ -n "$FAKE_FAIL" ]; then case " $* " in *"$FAKE_FAIL"*) echo "fake failure" >&2; exit 1 ;; esac; fi
if [ -n "$FAKE_GARBAGE" ]; then case " $* " in *"$FAKE_GARBAGE"*) echo "not json"; exit 0 ;; esac; fi
if [ -n "$FAKE_SLEEP" ]; then case " $* " in *"$FAKE_SLEEP"*) sleep 4 ;; esac; fi
if [ -n "$FAKE_SEQ" ]; then
  case " $* " in
    *" network inspect "*)
      n=$(cat "$FAKE_SEQ/n" 2>/dev/null || echo 0); echo $((n+1)) > "$FAKE_SEQ/n"
      if [ -f "$FAKE_SEQ/net-$n.json" ]; then cat "$FAKE_SEQ/net-$n.json"; exit 0; fi ;;
    *" inspect id-n"*)
      for a; do last="$a"; done
      if [ -f "$FAKE_SEQ/ins-$last.json" ]; then cat "$FAKE_SEQ/ins-$last.json"; exit 0; fi ;;
  esac
fi
exec ${orig} "$@"
`;

type Run = { out: Record<string, any>; code: number; error?: string };

async function inproc(f: Fake, command: string, args: string[] = [], env: Record<string, string> = {}): Promise<Run> {
  const wrap = join(f.state, 'wrap');
  if (!existsSync(wrap)) {
    writeFileSync(wrap, WRAP(f.bin));
    chmodSync(wrap, 0o755);
  }
  const keys = ['FAKE_DOCKER_DIR', 'GOODBOY_DOCKER_BIN', ...Object.keys(env)];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env.FAKE_DOCKER_DIR = f.state;
  process.env.GOODBOY_DOCKER_BIN = wrap;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const r = await sandboxCommand(command, f.root, args);
    return 'error' in r ? { out: {}, code: 1, error: r.error } : { out: r.out as Record<string, any>, code: r.code };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The compose file as docker resolves it, changed (a service that asks the host for too much). */
function editConfig(f: Fake, change: (cfg: any) => void): void {
  const file = join(f.state, 'config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  change(cfg);
  writeFileSync(file, JSON.stringify(cfg));
}

describe('sandbox-check, failing docker calls (in this process)', () => {
  test('a network list, a container inspect and a network inspect that fail or print no JSON each fail the check with the reason', async () => {
    const f = fake();
    const list = await inproc(f, 'sandbox-check', [], { FAKE_FAIL: ' network ls ' });
    expect(list.code).toBe(1);
    expect(list.out.inner_only).toBe(false);
    expect(list.out.problems.some((p: string) => p.includes("listing the project's networks failed") && p.includes('fake failure'))).toBe(true);
    const ins = await inproc(f, 'sandbox-check', [], { FAKE_FAIL: ' inspect id-' });
    expect(ins.out.inner_only).toBe(false);
    expect(ins.out.problems.some((p: string) => p.includes('docker inspect failed') && p.includes('fake failure'))).toBe(true);
    const garbage = await inproc(f, 'sandbox-check', [], { FAKE_GARBAGE: ' inspect id-' });
    expect(garbage.out.problems.some((p: string) => p.includes('docker inspect failed'))).toBe(true);
    const net = await inproc(f, 'sandbox-check', [], { FAKE_FAIL: ' network inspect ' });
    expect(net.out.inner_only).toBe(false);
    expect(net.out.problems.some((p: string) => p.includes('docker network inspect failed'))).toBe(true);
  });

  test('a chain of containers found through the networks is followed three rounds; what is left is named, and the check fails', async () => {
    const f = fake();
    const p = f.ctx.project;
    const seq = dir('goodboy-m1-seq-');
    const opts = { 'com.docker.network.bridge.inhibit_ipv4': 'true' };
    const net = (name: string, containers: string[]) => ({ Name: `${p}_${name}`, Internal: true, Options: opts, IPAM: { Config: [{ Subnet: '10.231.0.0/24' }] }, Containers: Object.fromEntries(containers.map((c) => [c, {}])) });
    const box = (id: string, netName: string) => [{ Id: id, Name: `/${id}`, Config: { Labels: {} }, HostConfig: { NetworkMode: `${p}_${netName}` }, NetworkSettings: { Networks: { [`${p}_${netName}`]: { IPAddress: '10.231.0.50' } } } }];
    const w3 = (file: string, v: unknown) => writeFileSync(join(seq, file), JSON.stringify(v));
    w3('net-0.json', [net('inner', ['id-n1']), net('ip_10_20_30', [])]);
    w3('ins-id-n1.json', box('id-n1', 'netA'));
    w3('net-1.json', [net('netA', ['id-n2'])]);
    w3('ins-id-n2.json', box('id-n2', 'netB'));
    w3('net-2.json', [net('netB', ['id-n3'])]);
    const r = await inproc(f, 'sandbox-check', [], { FAKE_SEQ: seq });
    expect(r.out.inner_only).toBe(false);
    expect(r.out.problems.some((x: string) => x.includes("1 container(s) on the sandbox's networks could not all be examined"))).toBe(true);
    expect(r.out.problems.some((x: string) => x.includes('id-n1') && x.includes('not one of the sandbox'))).toBe(true);
  });
});

describe('sandbox-prepare, sandbox-up and sandbox-down (in this process)', () => {
  test('an unsafe compose file and a remote daemon are refused before any container is started', async () => {
    const f = fake();
    editConfig(f, (cfg) => {
      cfg.services.app.privileged = true;
    });
    for (const command of ['sandbox-prepare', 'sandbox-up']) {
      const r = await inproc(f, command);
      expect(r.error).toContain(`${command}: the compose file is not safe to start`);
      expect(r.error).toContain('privileged');
    }
    expect(f.calls().some((l) => /\bup -d\b|\bpull\b| run /.test(l))).toBe(false);
    const g = fake();
    for (const command of ['sandbox-prepare', 'sandbox-up', 'sandbox-down']) {
      const r = await inproc(g, command, [], { DOCKER_HOST: 'tcp://build.example:2375' });
      expect(r.error).toContain(`${command}: DOCKER_HOST is tcp://build.example:2375`);
    }
    expect(g.calls().some((l) => /\bup -d\b|\bpull\b| run | down /.test(l))).toBe(false);
  });

  test('sandbox-prepare pulls, runs prep and, with e2e tests, e2e-prep; a failing step stops there with its output tail', async () => {
    const f = e2eFake();
    const ok = await inproc(f, 'sandbox-prepare');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatchObject({ step: 'prep', exit: 0, e2e: { step: 'e2e-prep', exit: 0 } });
    const calls = f.calls();
    const at = (s: string) => calls.findIndex((l) => l.includes(s));
    expect([at(' pull'), at('run --rm -T prep'), at('run --rm -T e2e-prep')].every((i, n, a) => i >= 0 && (n === 0 || i > a[n - 1]!))).toBe(true);
    const pull = await inproc(f, 'sandbox-prepare', [], { FAKE_FAIL: ' pull' });
    expect(pull.code).toBe(1);
    expect(pull.out).toMatchObject({ step: 'pull', exit: 1 });
    expect(pull.out.tail).toContain('fake failure');
    const prep = await inproc(f, 'sandbox-prepare', ['--timeout-ms', '5000'], { FAKE_FAIL: ' -T prep' });
    expect(prep.code).toBe(1);
    expect(prep.out).toMatchObject({ step: 'prep', exit: 1 });
    expect(prep.out.e2e).toBeUndefined();
    const e2e = await inproc(f, 'sandbox-prepare', [], { FAKE_FAIL: ' -T e2e-prep' });
    expect(e2e.code).toBe(1);
    expect(e2e.out).toMatchObject({ exit: 0, e2e: { step: 'e2e-prep', exit: 1 } });
  });

  test('sandbox-up starts the stores, restores, resets, waits for the app and the proxy, in that order', async () => {
    const f = e2eFake();
    writeFileSync(join(f.state, 'restore-out.txt'), 'template shop_template\n');
    const r = await inproc(f, 'sandbox-up', ['--wait-seconds', '5', '--app-logs']);
    expect(r.code).toBe(0);
    expect(r.out.steps).toEqual([
      { step: 'up stores and dummies', ok: true },
      { step: 'restore db', ok: true, note: 'template shop_template' },
      { step: 'reset', ok: true },
      { step: 'data role', ok: true },
      { step: 'app health', ok: true, note: f.ctx.plan.healthUrl },
      { step: 'proxy health', ok: true, note: f.ctx.plan.proxyHealthUrl },
    ]);
    expect(r.out).toMatchObject({ appUrl: f.ctx.plan.healthUrl, proxyUrl: f.ctx.plan.proxyHealthUrl });
    const calls = f.calls();
    const at = (s: string) => calls.findIndex((l) => l.includes(s));
    const order = [at('up -d --wait'), at('restore.sh'), at('reset.sh'), at('up -d app'), at('up -d proxy')];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  test('sandbox-up with no app starts only the stores and says so', async () => {
    const scan = jvmScan();
    scan.build.startCommand = [];
    const f = fake({}, scan);
    expect(f.ctx.plan.hasApp).toBe(false);
    const r = await inproc(f, 'sandbox-up');
    expect(r.code).toBe(0);
    expect(r.out.notes).toEqual(['no app service: nothing to start']);
    expect(f.calls().some((l) => l.includes('up -d app'))).toBe(false);
  });

  test('each failing step of sandbox-up is the last one reported, with what went wrong', async () => {
    const f = e2eFake();
    const stores = await inproc(f, 'sandbox-up', [], { FAKE_FAIL: ' up -d --wait' });
    expect(stores.code).toBe(1);
    expect(stores.out.steps).toEqual([{ step: 'up stores and dummies', ok: false, note: expect.stringContaining('fake failure') }]);

    writeFileSync(join(f.state, 'restore-err.txt'), `${RESTORE_TAG} error 42P01 at dump line 12\nclient text that might quote a row\n`);
    const tagged = await inproc(f, 'sandbox-up', [], { FAKE_RESTORE_EXIT: '3' });
    expect(tagged.code).toBe(1);
    const last = tagged.out.steps[tagged.out.steps.length - 1];
    expect(last).toMatchObject({ step: 'restore db', ok: false });
    expect(last.note).toContain('42P01 at dump line 12');
    expect(last.note).not.toContain('might quote a row');

    rmSync(join(f.state, 'restore-err.txt'));
    const bare = await inproc(f, 'sandbox-up', [], { FAKE_RESTORE_EXIT: '3' });
    expect(bare.out.steps[bare.out.steps.length - 1].note).toContain("exit 3 (the client's output is withheld");

    const reset = await inproc(f, 'sandbox-up', [], { FAKE_FAIL: 'reset.sh' });
    expect(reset.code).toBe(1);
    expect(reset.out.steps[reset.out.steps.length - 1]).toMatchObject({ step: 'reset', ok: false });
    expect(reset.out.steps[reset.out.steps.length - 1].note).toContain('resetting db from its template failed');

    const app = await inproc(f, 'sandbox-up', [], { FAKE_FAIL: ' up -d app' });
    expect(app.out.steps[app.out.steps.length - 1]).toMatchObject({ step: 'start app', ok: false });
    const proxy = await inproc(f, 'sandbox-up', ['--wait-seconds', '5'], { FAKE_FAIL: ' up -d proxy' });
    expect(proxy.out.steps[proxy.out.steps.length - 1]).toMatchObject({ step: 'start proxy', ok: false });
  });

  test('an app that does not answer: the note names the url and the app log stays unread unless --app-logs is passed', async () => {
    const f = e2eFake();
    writeFileSync(join(f.state, 'app-logs.txt'), 'APP-LOG-LINE\n');
    const quiet = await inproc(f, 'sandbox-up', ['--wait-seconds', '5'], { FAKE_HEALTH_EXIT: '1' });
    expect(quiet.code).toBe(1);
    const step = quiet.out.steps[quiet.out.steps.length - 1];
    expect(step).toMatchObject({ step: 'app health', ok: false });
    expect(step.note).toBe(`${f.ctx.plan.healthUrl} did not answer in 5s`);
    expect(step.detail).toContain('--app-logs');
    expect(step.detail).not.toContain('APP-LOG-LINE');
    const loud = await inproc(f, 'sandbox-up', ['--wait-seconds', '5', '--app-logs'], { FAKE_HEALTH_EXIT: '1' });
    expect(loud.out.steps[loud.out.steps.length - 1].detail).toContain('APP-LOG-LINE');
  }, 90_000);

  test('a proxy that does not answer fails the step after the app is up', async () => {
    const f = e2eFake();
    const r = await inproc(f, 'sandbox-up', ['--wait-seconds', '5'], { FAKE_FAIL: 'http://proxy:8080' });
    expect(r.code).toBe(1);
    expect(r.out.steps.map((s: { step: string; ok: boolean }) => [s.step, s.ok]).slice(-2)).toEqual([['app health', true], ['proxy health', false]]);
    expect(r.out.steps[r.out.steps.length - 1].note).toBe(`${f.ctx.plan.proxyHealthUrl} did not answer in 5s`);
  }, 60_000);

  test('sandbox-down removes the containers and keeps the volumes unless asked; a failure is reported', async () => {
    const f = fake();
    const keep = await inproc(f, 'sandbox-down');
    expect(keep).toMatchObject({ code: 0, out: { exit: 0, volumes: 'kept' } });
    const gone = await inproc(f, 'sandbox-down', ['--volumes']);
    expect(gone.out.volumes).toBe('removed');
    expect(f.calls().some((l) => / down --remove-orphans -v$/.test(l))).toBe(true);
    const bad = await inproc(f, 'sandbox-down', [], { FAKE_FAIL: ' down ' });
    expect(bad.code).toBe(1);
    expect(bad.out.tail).toContain('fake failure');
  });
});

describe('sandbox-run (in this process)', () => {
  test('refuses what it cannot run: a suite that does not exist, nothing after --, no e2e tests, no test command, no app', async () => {
    const f = fake();
    expect((await inproc(f, 'sandbox-run', ['--suite', 'smoke'])).error).toContain('--suite is unit, e2e or all');
    expect((await inproc(f, 'sandbox-run', ['--'])).error).toContain('nothing after --');
    expect((await inproc(f, 'sandbox-run', ['--suite', 'e2e'])).error).toContain("needs the project's e2e tests");
    const bare = jvmScan();
    bare.build.startCommand = [];
    expect((await inproc(fake({}, bare), 'sandbox-run', ['--suite', 'e2e'])).error).toContain('needs an app');
    const none = jvmScan();
    none.build.testCommand = [];
    expect((await inproc(fake({}, none), 'sandbox-run')).error).toContain('no test command');
  });

  test('the unit suite restarts a running app, runs the runner with the run dir, builds the coverage report and writes the result', async () => {
    const f = e2eFake();
    writeFileSync(join(f.state, 'ps-app.txt'), 'id-app\n');
    const r = await inproc(f, 'sandbox-run', ['--suite', 'unit']);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ suite: 'unit', exit: 0, timedOut: false, coverage: { ok: true } });
    const calls = f.calls();
    expect(calls.some((l) => l.includes(' restart app'))).toBe(true);
    expect(calls.some((l) => l.includes('up -d proxy'))).toBe(false);
    expect(JSON.parse(readFileSync(r.out.result, 'utf8')).exit).toBe(0);
    expect(readFileSync(join(dirname(r.out.result), 'output.log'), 'utf8')).toContain('runner output line');
  });

  test('a failing runner gives its exit code; a coverage run that fails says why and does not change it', async () => {
    const f = e2eFake();
    const failed = await inproc(f, 'sandbox-run', ['--suite', 'unit'], { FAKE_RUNNER_EXIT: '2' });
    expect(failed.code).toBe(2);
    expect(failed.out.exit).toBe(2);
    for (const [exit, note] of [['4', 'sandbox-prepare'], ['3', 'no coverage data'], ['1', 'fake']] as const) {
      const r = await inproc(f, 'sandbox-run', ['--suite', 'unit'], { FAKE_COVERAGE_EXIT: exit });
      expect(r.code).toBe(0);
      expect(r.out.coverage).toMatchObject({ ok: false, exit: Number(exit), reports: [] });
      if (exit !== '1') expect(r.out.coverage.note).toContain(note);
    }
  });

  test('a runner that outlives --timeout-ms is stopped by name and the run reports a timeout', async () => {
    const f = e2eFake();
    const r = await inproc(f, 'sandbox-run', ['--suite', 'unit', '--timeout-ms', '1000'], { FAKE_SLEEP: ' --name ' });
    expect(r.out.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(f.calls()).toContainEqual(expect.stringMatching(/\brm -f \S+-runner-/));
  }, 60_000);

  test('the unit suite then the e2e suite: both run, the e2e starts from the dump again, the result holds both', async () => {
    const f = e2eFake();
    const r = await inproc(f, 'sandbox-run', ['--wait-seconds', '5']);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ suite: 'all', unit: { exit: 0 }, e2e: { exit: 0, artifacts: 'removed' } });
    expect(f.calls().filter((l) => l.includes('reset.sh')).length).toBe(2);
    const failing = await inproc(f, 'sandbox-run', ['--wait-seconds', '5'], { FAKE_E2E_EXIT: '1' });
    expect(failing.code).toBe(1);
    expect(failing.out.e2e).toMatchObject({ exit: 1, artifacts: 'kept' });
  });

  test('a failed sandbox check or database reset stops the run before any suite, and the result says why', async () => {
    const f = e2eFake();
    editConfig(f, (cfg) => {
      cfg.services.app.privileged = true;
    });
    const unsafe = await inproc(f, 'sandbox-run', ['--suite', 'unit']);
    expect(unsafe.code).toBe(1);
    expect(unsafe.out.stopped).toContain('the sandbox check failed');
    expect(JSON.parse(readFileSync(unsafe.out.result, 'utf8'))).toMatchObject({ exit: null, stopped: 'the sandbox check failed' });
    expect(f.calls().some((l) => l.includes('-runner-'))).toBe(false);
    const g = e2eFake();
    const reset = await inproc(g, 'sandbox-run', ['--suite', 'unit'], { FAKE_FAIL: 'reset.sh' });
    expect(reset.code).toBe(1);
    expect(reset.out.stopped).toContain('resetting db from its template failed');
    expect(g.calls().some((l) => l.includes('-runner-'))).toBe(false);
    const again = e2eFake();
    const second = await inproc(again, 'sandbox-run', ['--suite', 'e2e'], { FAKE_FAIL: 'reset.sh' });
    expect(second.out.stopped).toContain('resetting db');
  });

  test('every step the e2e suite needs can fail, and the run stops with the step named', async () => {
    const f = e2eFake();
    for (const [fail, said] of [
      [' up -d proxy', 'starting the proxy failed'],
      [' proxy sh -c rm -rf /live', 'cleaning /live failed'],
      [' up -d app', 'starting the app failed'],
      [' proxy sh -c : > /live/access.log', 'truncating the access log failed'],
    ] as const) {
      const r = await inproc(f, 'sandbox-run', ['--suite', 'e2e'], { FAKE_FAIL: fail });
      expect({ fail, code: r.code, stopped: String(r.out.stopped).includes(said) }).toEqual({ fail, code: 1, stopped: true });
    }
    writeFileSync(join(f.state, 'ps-app.txt'), 'id-app\n');
    const restart = await inproc(f, 'sandbox-run', ['--suite', 'e2e'], { FAKE_FAIL: ' restart app' });
    expect(String(restart.out.stopped)).toContain('starting the app failed');
    const slow = await inproc(f, 'sandbox-run', ['--suite', 'e2e', '--wait-seconds', '5'], { FAKE_FAIL: 'http://proxy:8080' });
    expect(String(slow.out.stopped)).toContain('did not answer in 5s');
  }, 90_000);

  test('problems of the e2e run that do not stop it are in the result: the app that did not stop, no access log, no Playwright report', async () => {
    const f = e2eFake();
    rmSync(join(f.state, 'access.log'));
    rmSync(join(f.state, 'playwright-report.json'));
    const r = await inproc(f, 'sandbox-run', ['--suite', 'e2e'], { FAKE_FAIL: ' stop -t 60' });
    expect(r.code).toBe(0);
    const problems: string[] = r.out.e2e.problems;
    expect(problems.some((p) => p.includes('stopping the app failed'))).toBe(true);
    expect(problems.some((p) => p.includes('access log could not be copied') && p.includes('it does not exist'))).toBe(true);
    expect(problems).toContain('the e2e run wrote no Playwright report');
    expect(r.out.accessLog).toBeNull();
    expect(r.out.playwrightReport).toBeNull();
  });

  test('a directory planted where the log goes in the volume is a problem of the run, and nothing is written outside', async () => {
    const f = e2eFake();
    const victim = join(f.state, 'victim.txt');
    writeFileSync(victim, 'VICTIM-ORIGINAL');
    const r = await inproc(f, 'sandbox-run', ['--suite', 'unit'], { FAKE_PLANT_DIRS: 'output.log', FAKE_VICTIM: victim });
    expect(r.out.problems).toContain('output.log could not be written to the run volume');
    expect(readFileSync(victim, 'utf8')).toBe('VICTIM-ORIGINAL');
  });
});
