// The sandbox files (track M, M1b; plan §19): `planSandbox` turns a SandboxScan and the local
// answers into the contents of `.goodboy/sandbox/` (compose file, config override, dummies, DB
// scripts), as text. Nothing here touches the disk or docker; lib/sandbox-files.ts writes the
// files and lib/sandbox-run.ts runs them.
//
// The rule the compose file keeps: every service except `prep` is on internal networks only
// (`inner` and one internal network per hard-coded IP literal), with no published port.
// `prep` alone is on a normal bridge, and only in the `prep` profile.

import { resolve } from 'node:path';
import { MAX_DOC_BYTES, readRegular } from './safe-read';
import { caddyfile, coverageRc, coverageScript, e2ePrepScript, E2E_DIR, flushScript, lcovMergeScript, playwrightConfig, playwrightImage, playwrightVersion, PROXY_PORT, uiFixture } from './sandbox-e2e';
import {
  CA_MOUNT,
  CATCH_ALL,
  configKeyAt,
  dataRoleScript,
  DUMMY_PASSWORD,
  DUMMY_SECRET,
  dbName,
  entrypoint,
  envName,
  GITIGNORE,
  HOST,
  firstAddress,
  INHIBIT_IPV4,
  isIpv4,
  KEYSTORE_PASSWORD,
  bareBuildTool,
  buildImage,
  ldif,
  major,
  mysqlScripts,
  pgScripts,
  pinned,
  prepScript,
  Raw,
  RESERVED_NAMES,
  runtimeImage,
  type Sql,
  STORE_DEFAULT_VERSION,
  type StoreEndpoint,
  stackProfile,
  startCommandOf,
  storeValue,
  toYaml,
} from './sandbox-parts';
import { SANDBOX_DIR } from './sandbox-mode';
import { META_DIR, outDirMounts, outputDirsFor, readerMounts, volumeNames } from './sandbox-volumes';
import type { OutboundKind, SandboxLocal, SandboxOutbound, SandboxScan, SandboxStore } from './sandbox-types';

export { CA_MOUNT, configKeyAt, KEYSTORE_PASSWORD };

export const SCAN_FILE = `${SANDBOX_DIR}/scan.json`;
export const DEFAULT_INNER_SUBNET = '10.231.0.0/24';
/** The prep services mount the repo at /src; this path inside it is an empty tmpfs. */
export const PREP_MASK = '/src/.goodboy';

/** Every image is pinned to a tag (checked by tests/m1-sandbox.test.ts). */
export const IMAGES = {
  mail: 'axllent/mailpit:v1.21.8',
  stubs: 'wiremock/wiremock:3.9.1',
  ldap: 'osixia/openldap:1.5.0',
  probe: 'busybox:1.36',
  proxy: 'caddy:2.8.4-alpine',
} as const;

export interface RenderOptions {
  /** The subnet of the `inner` network (default 10.231.0.0/24). */
  innerSubnet?: string;
  /** The repo top the override keys are read from (default: `scan.root`, which a saved scan keeps as `.`). */
  root?: string;
  /** Reads a repo-relative file for the override keys (default: from `root`). */
  readConfig?: (rel: string) => string | null;
}

export type DummyService = 'mail' | 'stubs' | 'ldap';

export interface PlanDummy {
  service: DummyService;
  /** The host name the app uses (an alias of the dummy), or the IP literal. */
  host: string;
  /** The IP literal the dummy holds, else null. */
  ip: string | null;
}

export interface SandboxPlan {
  /** Repo-relative to `.goodboy/sandbox/`. */
  files: Map<string, string>;
  /** What the sandbox does not cover or could not decide; the CLI reports them. */
  notes: string[];
  /** Compose services `sandbox-up` starts before the app, in order. */
  upServices: string[];
  /** The app service exists (the scan has a start command). */
  hasApp: boolean;
  /** The first SQL store's service (restored once, reset before every run), or null. */
  dbService: string | null;
  /** Compose network names that are internal: `inner` and the IP literals' networks. */
  internalNets: string[];
  dummies: PlanDummy[];
  /** Names of the SANs the server certificate needs. */
  sans: { dns: string[]; ips: string[] };
  /** The address the host would have on `inner`: nothing may answer there (sandbox-check probes it). */
  innerGateway: string;
  /** The app's URL path for the health wait. */
  healthUrl: string;
  /** The logging proxy and the e2e service exist (the scan has an app). */
  hasE2e: boolean;
  /** The same health path through the proxy, which the e2e run waits on. */
  proxyHealthUrl: string;
}

const KIND_SERVICE: Partial<Record<OutboundKind, DummyService>> = { http: 'stubs', smtp: 'mail', ldap: 'ldap' };

export function planSandbox(scan: SandboxScan, local: SandboxLocal, opts: RenderOptions = {}): SandboxPlan {
  const notes: string[] = [];
  const files = new Map<string, string>();
  const stack = scan.stack;
  const innerSubnet = opts.innerSubnet ?? DEFAULT_INNER_SUBNET;
  const readConfig =
    opts.readConfig ??
    ((rel: string) => {
      if (rel.startsWith('/') || rel.split('/').includes('..')) return null;
      const r = readRegular(resolve(opts.root ?? scan.root, rel), MAX_DOC_BYTES, true);
      return typeof r === 'object' ? r.text : null;
    });

  const services: Record<string, Record<string, unknown>> = {};
  const volumes: Record<string, Record<string, never>> = {};
  // No host address on any internal network (INHIBIT_IPV4); `inner` also keeps its first address
  // reserved, so no container holds the address the host would have and sandbox-check can probe it.
  const innerGateway = firstAddress(innerSubnet);
  const networks: Record<string, unknown> = { inner: { internal: true, driver_opts: { [INHIBIT_IPV4]: 'true' }, ipam: { config: [{ subnet: innerSubnet, aux_addresses: { 'goodboy-gateway': innerGateway } }] } } };
  const internalNets = ['inner'];
  const upServices: string[] = [];

  // ---- outbound hosts: dummies, aliases, IP literals ----
  const dummies: PlanDummy[] = [];
  const seen = new Map<string, DummyService>();
  const aliases: Record<DummyService, string[]> = { mail: [], stubs: [], ldap: [] };
  const literalNets = new Map<string, { subnet: string; ips: string[] }>();
  const literalByService: Record<DummyService, Map<string, string>> = { mail: new Map(), stubs: new Map(), ldap: new Map() };
  const innerPrefix = innerSubnet.split('.').slice(0, 3).join('.');
  const other: string[] = [];
  const at = (o: SandboxOutbound) => `${o.host}${o.port ? ':' + o.port : ''} (${o.where.file}:${o.where.line})`;
  for (const o of scan.outbound) {
    const host = o.host.trim().toLowerCase();
    if (host === 'localhost' || host === '0.0.0.0' || host.startsWith('127.')) continue;
    if (o.kind === 'other') {
      other.push(at(o));
      continue;
    }
    if (o.callSite === null) {
      notes.push(`${at(o)} is configured but no call site uses it: no dummy`);
      continue;
    }
    const service = KIND_SERVICE[o.kind]!;
    const literal = o.ipLiteral || isIpv4(host);
    if (literal) {
      if (!isIpv4(host)) {
        notes.push(`${at(o)} is not an IPv4 literal: no dummy`);
        continue;
      }
      const prefix = host.split('.').slice(0, 3).join('.');
      if (prefix === innerPrefix) {
        notes.push(`${at(o)} is inside the inner subnet ${innerSubnet}: pass another innerSubnet`);
        continue;
      }
      const net = `ip_${prefix.replace(/\./g, '_')}`;
      if (dummies.some((d) => d.ip === host)) continue;
      if (literalByService[service].has(net)) {
        notes.push(`${at(o)}: ${service} already holds an address in ${prefix}.0/24 and a service has one address per network: no dummy`);
        continue;
      }
      literalByService[service].set(net, host);
      const known = literalNets.get(net);
      if (known) known.ips.push(host);
      else literalNets.set(net, { subnet: `${prefix}.0/24`, ips: [host] });
      dummies.push({ service, host, ip: host });
      continue;
    }
    if (!HOST.test(host)) {
      notes.push(`${at(o)} is not a valid host name: no dummy`);
      continue;
    }
    if (RESERVED_NAMES.has(host)) {
      notes.push(`${at(o)} has the name of a sandbox service: no dummy`);
      continue;
    }
    const prev = seen.get(host);
    if (prev !== undefined) {
      if (prev !== service) notes.push(`${at(o)} is used as ${prev} and ${service}; the alias goes to ${prev} only`);
      continue;
    }
    seen.set(host, service);
    aliases[service].push(host);
    dummies.push({ service, host, ip: null });
  }
  for (const [net, n] of literalNets) {
    networks[net] = { internal: true, driver_opts: { [INHIBIT_IPV4]: 'true' }, ipam: { config: [{ subnet: n.subnet }] } };
    internalNets.push(net);
  }
  networks.prep = { driver: 'bridge' };

  /** The `networks:` entry of a service: `inner` (with aliases) and its IP literals' networks. */
  const netsOf = (svc: DummyService | 'app' | 'runner'): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const al = svc === 'app' || svc === 'runner' ? [] : aliases[svc];
    out.inner = al.length > 0 ? { aliases: al } : {};
    if (svc === 'app' || svc === 'runner') for (const net of literalNets.keys()) out[net] = {};
    else for (const [net, ip] of literalByService[svc]) out[net] = { ipv4_address: ip };
    return out;
  };

  // ---- stores ----
  const sqlStores = scan.stores.filter((s) => s.kind === 'postgres' || s.kind === 'mysql' || s.kind === 'mariadb');
  const endpoints = new Map<SandboxStore, StoreEndpoint>();
  let dbService: string | null = null;
  const hasDump = local.dump !== null;
  const dumpFile = local.dumpFormat === 'custom' ? 'dump.custom' : 'dump.sql';
  sqlStores.forEach((store, i) => {
    const svc = i === 0 ? 'db' : `db${i + 1}`;
    const v = pinned(store.version) ? store.version.trim() : STORE_DEFAULT_VERSION[store.kind];
    const name = dbName(store);
    const sql: Sql = { store, svc, name, v, port: store.kind === 'postgres' ? 5432 : 3306 };
    const first = i === 0;
    if (!first) notes.push(`${store.kind} store ${i + 1} (${store.where.file}:${store.where.line}) is an empty database: only the first SQL store gets the dump`);
    if (first && hasDump && store.kind !== 'postgres' && local.dumpFormat === 'custom') notes.push('a custom-format dump is for Postgres only; MySQL and MariaDB load plain SQL');
    const vols = [`${svc}data:${store.kind === 'postgres' ? (major(v) >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data') : '/var/lib/mysql'}`, `./db/${svc}:/goodboy-db:ro`];
    volumes[`${svc}data`] = {};
    if (first && hasDump) vols.push('${GOODBOY_DUMP}:/dump/' + dumpFile + ':ro');
    const scripts = store.kind === 'postgres' ? pgScripts(sql, first ? local.dumpFormat : null, first && hasDump) : mysqlScripts(sql, first && hasDump);
    files.set(`db/${svc}/restore.sh`, scripts.restore);
    files.set(`db/${svc}/reset.sh`, scripts.reset);
    files.set(`db/${svc}/data-role.sh`, dataRoleScript(sql));
    const user = store.kind === 'postgres' ? 'sandbox' : 'root';
    const volEntries = vols.map((x) => (x.startsWith('${GOODBOY_DUMP}') ? new Raw(x) : x));
    if (store.kind === 'postgres') {
      services[svc] = {
        image: `postgres:${v}-alpine`,
        environment: { POSTGRES_USER: 'sandbox', POSTGRES_PASSWORD: DUMMY_PASSWORD, POSTGRES_DB: 'postgres' },
        volumes: volEntries,
        networks: ['inner'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U sandbox -d postgres'], interval: '3s', timeout: '3s', retries: 60 },
      };
    } else {
      const maria = store.kind === 'mariadb';
      services[svc] = {
        image: `${store.kind}:${v}`,
        environment: maria ? { MARIADB_ROOT_PASSWORD: DUMMY_PASSWORD } : { MYSQL_ROOT_PASSWORD: DUMMY_PASSWORD },
        volumes: volEntries,
        networks: ['inner'],
        healthcheck: { test: ['CMD-SHELL', `${maria ? 'mariadb-admin' : 'mysqladmin'} ping -h 127.0.0.1 -uroot -p${DUMMY_PASSWORD} --silent`], interval: '3s', timeout: '3s', retries: 60 },
      };
    }
    endpoints.set(store, {
      svc,
      port: sql.port,
      user,
      password: DUMMY_PASSWORD,
      name,
      url: store.kind === 'postgres' ? `postgresql://${user}:${DUMMY_PASSWORD}@${svc}:5432/${name}` : `${store.kind}://${user}:${DUMMY_PASSWORD}@${svc}:3306/${name}`,
      jdbc: store.kind === 'postgres' ? `jdbc:postgresql://${svc}:5432/${name}` : store.kind === 'mysql' ? `jdbc:mysql://${svc}:3306/${name}?useSSL=false&allowPublicKeyRetrieval=true` : `jdbc:mariadb://${svc}:3306/${name}`,
    });
    upServices.push(svc);
    if (first) dbService = svc;
  });
  const redisStore = scan.stores.find((s) => s.kind === 'redis');
  if (redisStore) {
    const v = pinned(redisStore.version) ? redisStore.version.trim() : STORE_DEFAULT_VERSION.redis;
    services.redis = { image: `redis:${v}-alpine`, command: ['redis-server', '--save', '', '--appendonly', 'no'], networks: ['inner'], healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '3s', timeout: '3s', retries: 40 } };
    endpoints.set(redisStore, { svc: 'redis', port: 6379, user: '', password: '', name: '0', url: 'redis://redis:6379' });
    upServices.push('redis');
  }
  const mongoStore = scan.stores.find((s) => s.kind === 'mongo');
  if (mongoStore) {
    const v = pinned(mongoStore.version) ? mongoStore.version.trim() : STORE_DEFAULT_VERSION.mongo;
    volumes.mongodata = {};
    services.mongo = {
      image: `mongo:${v}`,
      volumes: ['mongodata:/data/db'],
      networks: ['inner'],
      healthcheck: { test: ['CMD-SHELL', `mongosh --quiet --eval "db.adminCommand('ping').ok" | grep -q 1`], interval: '3s', timeout: '5s', retries: 40 },
    };
    endpoints.set(mongoStore, { svc: 'mongo', port: 27017, user: '', password: '', name: dbName(mongoStore), url: `mongodb://mongo:27017/${dbName(mongoStore)}` });
    upServices.push('mongo');
  }
  for (const s of scan.stores) if (!endpoints.has(s)) notes.push(`${s.kind} store at ${s.where.file}:${s.where.line} is a second one of its kind: not started`);

  // ---- dummies ----
  const dns = dummies.filter((d) => d.ip === null).map((d) => d.host);
  const ips = dummies.filter((d) => d.ip !== null).map((d) => d.ip!);
  const dummyDeps: Record<string, { condition: string }> = {};
  const outboundOf = (service: DummyService) => scan.outbound.filter((o) => KIND_SERVICE[o.kind] === service && dummies.some((d) => d.host === o.host.trim().toLowerCase() && d.service === service));
  /** The one port a dummy listens on: the most common one the app uses, else `dflt`. */
  const pickPort = (dflt: number, outs: SandboxOutbound[], what: string): number => {
    const ports = outs.map((o) => o.port).filter((p): p is number => p !== null);
    const count = (p: number) => ports.filter((x) => x === p).length;
    const mode = ports.length === 0 ? dflt : [...new Set(ports)].sort((a, b) => count(b) - count(a))[0]!;
    for (const o of outs) if (o.port !== null && o.port !== mode) notes.push(`${at(o)}: ${what} listens on port ${mode} only`);
    return mode;
  };
  if (aliases.mail.length + literalByService.mail.size > 0) {
    const port = pickPort(25, outboundOf('mail'), 'the mail sink');
    services.mail = {
      image: IMAGES.mail,
      environment: {
        MP_SMTP_BIND_ADDR: `0.0.0.0:${port}`,
        MP_UI_BIND_ADDR: '0.0.0.0:8025',
        MP_SMTP_AUTH_ACCEPT_ANY: '1',
        MP_SMTP_AUTH_ALLOW_INSECURE: '1',
        MP_SMTP_TLS_CERT: '/certs/server.crt',
        MP_SMTP_TLS_KEY: '/certs/server.key',
      },
      volumes: ['./ca/server.crt:/certs/server.crt:ro', './ca/server.key:/certs/server.key:ro'],
      networks: netsOf('mail'),
    };
    upServices.push('mail');
    dummyDeps.mail = { condition: 'service_started' };
  }
  if (aliases.stubs.length + literalByService.stubs.size > 0) {
    const httpPorts = outboundOf('stubs').filter((o) => o.scheme !== 'https' && o.port !== 443);
    const httpsPorts = outboundOf('stubs').filter((o) => o.scheme === 'https' || o.port === 443);
    const http = pickPort(80, httpPorts, 'the HTTP stub');
    const https = pickPort(443, httpsPorts, 'the HTTPS stub');
    services.stubs = {
      image: IMAGES.stubs,
      command: ['--port', String(http), '--https-port', String(https), '--https-keystore', '/certs/server.p12', '--keystore-type', 'PKCS12', '--keystore-password', KEYSTORE_PASSWORD, '--key-manager-password', KEYSTORE_PASSWORD, '--global-response-templating', '--verbose'],
      volumes: ['./ca/server.p12:/certs/server.p12:ro', './dummies/stubs/mappings:/home/wiremock/mappings:ro'],
      networks: netsOf('stubs'),
      healthcheck: { disable: true },
    };
    files.set('dummies/stubs/mappings/catch-all.json', CATCH_ALL);
    upServices.push('stubs');
    dummyDeps.stubs = { condition: 'service_started' };
  }
  if (aliases.ldap.length + literalByService.ldap.size > 0) {
    let domain = 'sandbox.test';
    for (const o of outboundOf('ldap')) {
      const ref = o.hardcoded ? null : (() => { const t = readConfig(o.where.file); return t === null ? null : configKeyAt(o.where.file, t, o.where.line); })();
      const dn = ref ? decodeURIComponent(ref.path.replace(/^\//, '')) : '';
      if (/^dc=[A-Za-z0-9-]+(,dc=[A-Za-z0-9-]+)*$/i.test(dn)) {
        domain = dn.split(',').map((p) => p.slice(3)).join('.').toLowerCase();
        break;
      }
    }
    const base = domain.split('.').map((p) => `dc=${p}`).join(',');
    notes.push(`the test directory's base DN is ${base} (user uid=test, password test; admin password ${DUMMY_PASSWORD}); the app's LDAP config must use it`);
    services.ldap = {
      image: IMAGES.ldap,
      command: ['--copy-service'],
      environment: {
        LDAP_ORGANISATION: 'Sandbox',
        LDAP_DOMAIN: domain,
        LDAP_ADMIN_PASSWORD: DUMMY_PASSWORD,
        LDAP_TLS_CRT_FILENAME: 'server.crt',
        LDAP_TLS_KEY_FILENAME: 'server.key',
        LDAP_TLS_CA_CRT_FILENAME: 'ca.crt',
        LDAP_TLS_VERIFY_CLIENT: 'never',
      },
      volumes: [
        './dummies/ldap/seed.ldif:/container/service/slapd/assets/config/bootstrap/ldif/custom/50-seed.ldif:ro',
        './ca/server.crt:/container/service/slapd/assets/certs/server.crt:ro',
        './ca/server.key:/container/service/slapd/assets/certs/server.key:ro',
        './ca/ca.crt:/container/service/slapd/assets/certs/ca.crt:ro',
      ],
      networks: netsOf('ldap'),
    };
    files.set('dummies/ldap/seed.ldif', ldif(base, domain));
    upServices.push('ldap');
    dummyDeps.ldap = { condition: 'service_started' };
  }

  // ---- the override: where the app's config points at the sandbox ----
  const override = new Map<string, string>();
  const springBoot = stack === 'jvm' && scan.frameworks.some((f) => f.toLowerCase().startsWith('spring'));
  const setKey = (key: string, value: string) => {
    const k = springBoot ? key : envName(key);
    if (!override.has(k)) override.set(k, value);
  };
  for (const store of scan.stores) {
    const e = endpoints.get(store);
    if (!e) continue;
    for (const key of store.configKeys) {
      const v = storeValue(store.kind, e, key, springBoot);
      if (v === null) notes.push(`config key ${key} of the ${store.kind} store is not one the sandbox sets: check it by hand`);
      else setKey(key, v);
    }
  }
  scan.outbound.forEach((o) => {
    const host = o.host.trim().toLowerCase();
    if (o.hardcoded || !dummies.some((d) => d.host === host)) return;
    const text = readConfig(o.where.file);
    const ref = text === null ? null : configKeyAt(o.where.file, text, o.where.line);
    if (ref === null) return;
    const port = ref.port ?? o.port;
    setKey(ref.key, ref.scheme !== null ? `${ref.scheme}://${host}${port !== null ? ':' + port : ''}${ref.path}` : host);
  });
  for (const key of scan.secretKeys) setKey(key, DUMMY_SECRET);
  if (springBoot) {
    const body = [...override].map(([k, v]) => [k, v] as const);
    files.set('overrides/application-sandbox.yml', `# Spring profile "sandbox" (goodboy sandbox-init): the app's stores and hosts point at the sandbox, secrets are dummies.\n${toYaml(Object.fromEntries(body), false)}`);
  } else if (stack !== 'jvm') {
    // Compose interpolates `$` in an env_file, so a literal `$` is written `$$` (measured: A=pa$$word reaches the container as pa$word).
    files.set('overrides/sandbox.env', `# The sandbox's config override (goodboy sandbox-init): stores and hosts point at the sandbox, secrets are dummies.\n${[...override].map(([k, v]) => `${k}=${v.replace(/\$/g, '$$$$')}`).join('\n')}${override.size > 0 ? '\n' : ''}`);
  } else notes.push('no config override: this JVM project is not a Spring Boot app; its config must reach the sandbox hosts by their names');

  // ---- app, runner, prep, probe ----
  const image = runtimeImage(stack, scan.build.runtimeVersion);
  const profile = stackProfile(scan);
  const jdkMajor = stack === 'jvm' ? image.replace(/^eclipse-temurin:(\d+)-jdk$/, '$1') : '';
  // A project with no wrapper runs the bare `mvn` or `gradle`: prep and the runner then use the
  // official build image of that tool. The app always keeps the plain JDK image.
  const toolImage = (cmds: readonly (readonly string[])[]): string => {
    const tool = stack === 'jvm' ? cmds.map(bareBuildTool).find((t) => t !== null) ?? null : null;
    return tool === null ? image : buildImage(tool, Number(jdkMajor));
  };
  const prepImage = toolImage([scan.build.depsCommand, scan.build.buildCommand]);
  const runnerImage = toolImage([scan.build.testCommand]);
  const caches = profile.caches.map((c) => c.vol);
  for (const c of caches) volumes[c] = {};
  volumes.build = {};
  // the run's raw artifacts live in volumes, not in the checkout (M6a, lib/sandbox-volumes.ts)
  // the output dirs: the root's and the modules the scan's test command names (their JUnit XML lands there)
  const outDirs = outputDirsFor(scan.build.testCommand);
  for (const v of volumeNames(outDirs)) volumes[v] = {};
  for (const m of profile.runtimeVols('/x')) volumes[m.split(':')[0]!] = {};
  const runtimeEnv: Record<string, string> = { ...profile.env };
  if (stack === 'jvm' && springBoot) {
    runtimeEnv.SPRING_PROFILES_ACTIVE = 'sandbox';
    runtimeEnv.SPRING_CONFIG_ADDITIONAL_LOCATION = 'optional:file:/sandbox/overrides/';
  }
  if (stack === 'node') runtimeEnv.NODE_EXTRA_CA_CERTS = CA_MOUNT;
  if (stack === 'python') Object.assign(runtimeEnv, { SSL_CERT_FILE: CA_MOUNT, REQUESTS_CA_BUNDLE: CA_MOUNT, CURL_CA_BUNDLE: CA_MOUNT });
  const trust = ['./ca/ca.crt:' + CA_MOUNT + ':ro', './runtime/entrypoint.sh:/sandbox/entrypoint.sh:ro', ...(files.has('overrides/application-sandbox.yml') || files.has('overrides/sandbox.env') ? ['./overrides:/sandbox/overrides:ro'] : [])];
  const envFile = files.has('overrides/sandbox.env') ? ['./overrides/sandbox.env'] : undefined;
  const depends: Record<string, { condition: string }> = { ...dummyDeps };
  for (const s of upServices) if (!depends[s]) depends[s] = { condition: s === 'db' || s.startsWith('db') || s === 'redis' || s === 'mongo' ? 'service_healthy' : 'service_started' };
  const cacheMounts = profile.caches.map((c) => `${c.vol}:${c.path}`);
  files.set('runtime/entrypoint.sh', entrypoint(stack, jdkMajor));
  files.set('runtime/prep.sh', prepScript(scan));

  // coverage across the unit run (the runner) and the e2e run (the app): where each writes its data
  const appCoverage: Record<string, string> = {};
  const runnerCoverage: Record<string, string> = {};
  if (stack === 'jvm') {
    Object.assign(appCoverage, { GOODBOY_COVERAGE_OUT: '/live/jacoco-e2e.exec', GOODBOY_COVERAGE_APPEND: 'false' });
    Object.assign(runnerCoverage, { GOODBOY_COVERAGE_OUT: '/out/coverage-raw/unit/jacoco.exec', GOODBOY_COVERAGE_APPEND: 'true' });
  } else if (stack === 'node') {
    Object.assign(appCoverage, { NODE_V8_COVERAGE: '/live/v8-e2e', NODE_OPTIONS: '--require /sandbox/flush.cjs' });
    Object.assign(runnerCoverage, { NODE_V8_COVERAGE: '/out/coverage-raw/unit/v8' });
  } else {
    Object.assign(appCoverage, { COVERAGE_PROCESS_START: '/sandbox/coveragerc', COVERAGE_FILE: '/live/py-e2e/.coverage' });
    Object.assign(runnerCoverage, { COVERAGE_PROCESS_START: '/sandbox/coveragerc', COVERAGE_FILE: '/out/coverage-raw/unit/py/.coverage' });
  }
  const coverageFiles = [...(stack === 'node' ? ['./runtime/flush.cjs:/sandbox/flush.cjs:ro'] : []), ...(stack === 'python' ? ['./runtime/coveragerc:/sandbox/coveragerc:ro'] : [])];
  files.set('runtime/coverage.sh', coverageScript(stack));
  if (stack === 'node') {
    files.set('runtime/flush.cjs', flushScript());
    files.set('runtime/lcov-merge.cjs', lcovMergeScript());
  }
  if (stack === 'python') files.set('runtime/coveragerc', coverageRc());

  const hasApp = scan.build.startCommand.length > 0;
  const ctx = scan.app.contextPath === '/' || scan.app.contextPath === '' ? '' : scan.app.contextPath.replace(/\/+$/, '');
  const hp = scan.app.healthPath.startsWith('/') ? scan.app.healthPath : `/${scan.app.healthPath}`;
  const healthUrl = `http://app:${scan.app.port}${ctx !== '' && (hp === ctx || hp.startsWith(`${ctx}/`)) ? '' : ctx}${hp}`;
  if (hasApp) {
    services.app = {
      image,
      working_dir: '/build',
      entrypoint: ['sh', '/sandbox/entrypoint.sh'],
      command: startCommandOf(scan.build.startCommand),
      environment: { ...runtimeEnv, ...appCoverage, ...(stack === 'jvm' ? { SERVER_PORT: String(scan.app.port) } : { PORT: String(scan.app.port) }) },
      ...(envFile ? { env_file: envFile } : {}),
      volumes: ['build:/build', ...profile.runtimeVols('/build'), ...(stack === 'jvm' ? ['jacoco:/jacoco:ro'] : []), 'live:/live', ...coverageFiles, ...trust],
      networks: Object.keys(netsOf('app')),
      depends_on: depends,
    };
  } else notes.push('the scan has no start command: no app service');
  if (scan.build.testCommand.length > 0) {
    services.runner = {
      image: runnerImage,
      profiles: ['tools'],
      working_dir: '/work',
      entrypoint: ['sh', '/sandbox/entrypoint.sh'],
      command: scan.build.testCommand,
      environment: { ...runtimeEnv, ...runnerCoverage },
      ...(envFile ? { env_file: envFile } : {}),
      volumes: ['../..:/work', ...cacheMounts, ...profile.runtimeVols('/work'), 'build:/build:ro', 'live:/live', 'runout:/outroot', ...outDirMounts(outDirs), './runtime/coverage.sh:/sandbox/coverage.sh:ro', ...(stack === 'node' ? ['./runtime/lcov-merge.cjs:/sandbox/lcov-merge.cjs:ro'] : []), ...coverageFiles, ...trust],
      networks: Object.keys(netsOf('runner')),
      depends_on: depends,
    };
  } else notes.push('the scan has no test command: no runner service');
  // ---- the logging proxy and the e2e service (M3) ----
  if (hasApp) {
    const pwVersion = playwrightVersion(readConfig);
    files.set('proxy/Caddyfile', caddyfile(scan.app.port));
    files.set('e2e/goodboy-ui.ts', uiFixture());
    files.set('e2e/playwright.config.ts', playwrightConfig());
    files.set('runtime/e2e-prep.sh', e2ePrepScript());
    volumes.e2edeps = {};
    services.proxy = {
      image: IMAGES.proxy,
      command: ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
      volumes: ['./proxy/Caddyfile:/etc/caddy/Caddyfile:ro', 'live:/live'],
      networks: ['inner'],
      depends_on: { app: { condition: 'service_started' } },
      healthcheck: { disable: true },
    };
    services.e2e = {
      image: playwrightImage(pwVersion),
      profiles: ['tools'],
      working_dir: `/work/${E2E_DIR}`,
      environment: { GOODBOY_BASE_URL: `http://proxy:${PROXY_PORT}`, GOODBOY_E2E_DIR: `/work/${E2E_DIR}`, CI: 'true' },
      command: ['/work/node_modules/.bin/playwright', 'test', '--config', '/work/.goodboy/sandbox/e2e/playwright.config.ts'],
      volumes: ['../..:/work', 'e2edeps:/work/node_modules', 'runout:/outroot', ...outDirMounts(outDirs)],
      networks: ['inner'],
      depends_on: { proxy: { condition: 'service_started' } },
    };
    services['e2e-prep'] = {
      image: playwrightImage(pwVersion),
      profiles: ['prep'],
      working_dir: '/tmp',
      entrypoint: ['sh', '/sandbox/e2e-prep.sh'],
      environment: { E2E_PLAYWRIGHT_VERSION: pwVersion, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', npm_config_cache: '/tmp/npm-cache' },
      volumes: ['../..:/src:ro', 'e2edeps:/deps', './runtime/e2e-prep.sh:/sandbox/e2e-prep.sh:ro'],
      // an empty tmpfs hides the sandbox's own dir (local.json, keys, run output) from the one service with network access
      tmpfs: [PREP_MASK],
      networks: ['prep'],
    };
    if (scan.build.tool === 'poetry' || scan.build.tool === 'uv') notes.push('Python coverage: the hook is installed for the system Python; a poetry or uv environment does not load it');
  }
  services.prep = {
    image: prepImage,
    profiles: ['prep'],
    working_dir: '/build',
    entrypoint: ['sh', '/sandbox/prep.sh'],
    environment: { ...profile.env },
    volumes: ['../..:/src:ro', 'build:/build', ...cacheMounts, ...profile.runtimeVols('/build'), './runtime/prep.sh:/sandbox/prep.sh:ro'],
    tmpfs: [PREP_MASK],
    networks: ['prep'],
  };
  services.probe = { image: IMAGES.probe, profiles: ['tools'], command: ['sleep', '3600'], networks: ['inner'] };
  // The reader: the one way the host reaches the volumes of raw artifacts (it reads, removes and writes
  // through the scripts of lib/sandbox-volumes.ts); it has no network at all (`network_mode: none`, which
  // the static check allows for a service of this name alone) and no bind of the checkout.
  services.reader = { image: IMAGES.probe, profiles: ['tools'], command: ['sleep', '3600'], volumes: ['runout:/outroot', 'live:/live', `meta:${META_DIR}`, ...readerMounts(outDirs)], network_mode: 'none' };

  const header = [
    '# Generated by goodboy sandbox-init (track M). A file you changed is never overwritten.',
    '# Every service except `prep` is on internal networks only: no egress, no published ports.',
    '# `prep` (profile prep) is the only service with network access; it never sees the dump.',
    ...(other.length > 0 ? ['# No dummy (kind other), the app can not reach these:', ...other.map((x) => `#   ${x}`)] : []),
  ].join('\n');
  files.set('compose.yml', `${header}\n${toYaml({ services, networks, volumes }, true)}`);
  files.set('.gitignore', GITIGNORE);
  for (const x of other) notes.push(`no dummy for ${x} (kind other)`);

  // the SANs of the one server certificate
  const dnsNames = [...new Set([...dns, ...Object.keys(services).filter((s) => s === 'mail' || s === 'stubs' || s === 'ldap'), 'localhost'])];
  return {
    files,
    notes,
    upServices,
    hasApp,
    dbService,
    internalNets,
    dummies,
    sans: { dns: dnsNames, ips: [...new Set([...ips, '127.0.0.1'])] },
    innerGateway,
    healthUrl,
    hasE2e: hasApp,
    proxyHealthUrl: `http://proxy:${PROXY_PORT}${healthUrl.slice(`http://app:${scan.app.port}`.length)}`,
  };
}

/** The sandbox's files as text, repo-relative to `.goodboy/sandbox/`. */
export function renderSandbox(scan: SandboxScan, local: SandboxLocal, opts: RenderOptions = {}): Map<string, string> {
  return planSandbox(scan, local, opts).files;
}
