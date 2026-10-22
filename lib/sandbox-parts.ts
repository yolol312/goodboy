// Pure helpers of the sandbox renderer (track M, M1b; plan §19): YAML text, shell scripts, the
// DB restore and reset scripts, config keys and values. lib/sandbox-render.ts composes them.

import { coveragePrep, jacocoEntrypoint } from './sandbox-e2e';
import type { SandboxLocal, SandboxScan, SandboxStack, SandboxStore } from './sandbox-types';

export const CA_MOUNT = '/sandbox/ca.crt';

export const DEFAULT_RUNTIME: Record<SandboxStack, string> = { jvm: '21', node: '20', python: '3.12' };
export const STORE_DEFAULT_VERSION: Record<SandboxStore['kind'], string> = { postgres: '16', mysql: '8.0', mariadb: '11', redis: '7', mongo: '7' };
/** Dummy credentials every sandbox store and secret gets. */
export const DUMMY_PASSWORD = 'sandbox';
export const DUMMY_SECRET = 'goodboysandboxdummysecret0123456789abcdef0123456789abcdef0123456';
/** The keystore password WireMock reads the sandbox server certificate with. */
export const KEYSTORE_PASSWORD = 'password';

// ---- small helpers ----

export class Raw {
  constructor(readonly text: string) {}
}

export const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function scalar(v: unknown, compose: boolean): string {
  if (v instanceof Raw) return JSON.stringify(v.text);
  if (typeof v === 'string') return JSON.stringify(compose ? v.replace(/\$/g, '$$$$') : v);
  return String(v);
}

export function emitValue(v: unknown, ind: number, compose: boolean): string[] {
  const pad = ' '.repeat(ind);
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      if (item !== null && typeof item === 'object' && !(item instanceof Raw)) {
        const sub = emitValue(item, ind + 2, compose);
        out.push(`${pad}- ${sub[0]!.trimStart()}`, ...sub.slice(1));
      } else out.push(`${pad}- ${scalar(item, compose)}`);
    }
    return out;
  }
  const out: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === undefined) continue;
    const key = BARE_KEY.test(k) ? k : JSON.stringify(k);
    if (Array.isArray(val) && val.length === 0) out.push(`${pad}${key}: []`);
    else if (val !== null && typeof val === 'object' && !(val instanceof Raw) && !Array.isArray(val) && Object.keys(val).length === 0) out.push(`${pad}${key}: {}`);
    else if (val !== null && typeof val === 'object' && !(val instanceof Raw)) out.push(`${pad}${key}:`, ...emitValue(val, ind + 2, compose));
    else out.push(`${pad}${key}: ${scalar(val, compose)}`);
  }
  return out;
}

/** YAML for plain data: every string double-quoted. For a compose file `$` is escaped as `$$`
 *  (only a `Raw` string keeps its `${VAR}`). */
export function toYaml(v: Record<string, unknown>, compose: boolean): string {
  return emitValue(v, 0, compose).join('\n') + '\n';
}

/** A string as one shell word. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export const shellLine = (argv: readonly string[]): string => argv.map(shq).join(' ');

export const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export function isIpv4(s: string): boolean {
  const m = IPV4.exec(s);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}
export const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
export const RESERVED_NAMES = new Set(['inner', 'prep', 'app', 'runner', 'probe', 'proxy', 'e2e', 'e2e-prep', 'mail', 'stubs', 'ldap', 'db', 'redis', 'mongo', 'localhost']);

export const major = (v: string): number => Number(v.split('.')[0]);
export const pinned = (v: string | null | undefined): v is string => typeof v === 'string' && /^\d+(\.\d+){0,2}$/.test(v.trim());

export function runtimeImage(stack: SandboxStack, raw: string | null): string {
  let v = (raw ?? '').trim().replace(/^v/, '');
  if (stack === 'jvm') v = v.replace(/^1\./, '');
  if (!/^\d+(\.\d+){0,2}$/.test(v)) v = DEFAULT_RUNTIME[stack];
  if (stack === 'jvm') return `eclipse-temurin:${major(v)}-jdk`;
  if (stack === 'node') return `node:${major(v)}-bookworm`;
  return `python:${v.split('.').slice(0, 2).join('.')}-slim`;
}

export const dbName = (s: SandboxStore): string => {
  const n = (s.database ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return n === '' ? 'app' : n;
};

// ---- config keys of the project (the override) ----

export interface ConfigRef {
  key: string;
  /** The value had a scheme (`ldap://…`): the override keeps that form. */
  scheme: string | null;
  port: number | null;
  /** The URL path (a base DN, a context path); never the user info or the query. */
  path: string;
}

export const URL_VALUE = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^/:?#]+)(?::(\d+))?(\/[^?#]*)?/i;

export function lineValueShape(raw: string): Omit<ConfigRef, 'key'> {
  const v = raw.trim().replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
  const m = URL_VALUE.exec(v);
  if (!m) return { scheme: null, port: null, path: '' };
  return { scheme: m[1]!.toLowerCase(), port: m[3] ? Number(m[3]) : null, path: m[4] ?? '' };
}

/** The config key a host is written at (line is 1-based) and the shape of its value, or null
 *  when the file is not a YAML, properties or .env file or the line is not `key: value`. */
export function configKeyAt(file: string, text: string, line: number): ConfigRef | null {
  const lines = text.split(/\r?\n/);
  const cur = lines[line - 1];
  if (cur === undefined) return null;
  const base = file.split('/').pop() ?? file;
  if (/\.ya?ml$/i.test(file)) {
    const m = /^(\s*)([A-Za-z0-9_.\-[\]]+)\s*:(?:\s+(.*))?$/.exec(cur);
    if (!m || m[3] === undefined || m[3].trim() === '' || m[3].trim().startsWith('#')) return null;
    const path = [m[2]!];
    let ind = m[1]!.length;
    for (let i = line - 2; i >= 0 && ind > 0; i--) {
      const l = lines[i]!;
      if (/^---\s*$/.test(l)) break;
      if (/^\s*(#.*)?$/.test(l)) continue;
      const pm = /^(\s*)(- +)?([A-Za-z0-9_.\-[\]]+)\s*:\s*(#.*)?$/.exec(l);
      const lead = /^(\s*)/.exec(l)![1]!.length;
      if (lead >= ind) continue;
      if (!pm || pm[2]) return null;
      path.unshift(pm[3]!);
      ind = lead;
    }
    return { key: path.join('.'), ...lineValueShape(m[3]!) };
  }
  if (/\.properties$/i.test(file)) {
    const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(cur);
    return m ? { key: m[1]!, ...lineValueShape(m[2]!) } : null;
  }
  if (base.startsWith('.env') || /\.env$/i.test(base)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(cur);
    return m ? { key: m[1]!, ...lineValueShape(m[2]!) } : null;
  }
  return null;
}

/** The words of a config key (camelCase, dots, dashes and underscores split). */
export const words = (key: string): string[] => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export interface StoreEndpoint {
  svc: string;
  port: number;
  user: string;
  password: string;
  name: string;
  url: string;
  /** Spring's JDBC url, for SQL stores. */
  jdbc?: string;
}

/** The value a store's config key gets, from the words of the key; null when the key is not
 *  one the sandbox knows how to set. */
export function storeValue(kind: SandboxStore['kind'], e: StoreEndpoint, key: string, jdbc: boolean): string | null {
  const w = words(key);
  const last = w[w.length - 1] ?? '';
  const sql = kind === 'postgres' || kind === 'mysql' || kind === 'mariadb';
  if (w.includes('class') || w.includes('driver')) return null;
  if (['password', 'pass', 'pwd', 'secret'].includes(last)) return e.password;
  if (['username', 'user'].includes(last)) return e.user;
  if (['url', 'uri', 'dsn'].includes(last)) return jdbc && sql ? e.jdbc! : e.url;
  if (last === 'port') return String(e.port);
  if (['host', 'hostname', 'server', 'address'].includes(last)) return e.svc;
  if (['database', 'dbname', 'name', 'schema', 'db'].includes(last)) return kind === 'redis' ? '0' : e.name;
  return null;
}

export const envName = (key: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase());

// ---- the db scripts ----

export interface Sql {
  store: SandboxStore;
  svc: string;
  name: string;
  v: string;
  port: number;
}

export function pgScripts(s: Sql, dump: SandboxLocal['dumpFormat'] | undefined, hasDump: boolean): { restore: string; reset: string } {
  const t = `${s.name}_template`;
  const loadStep = !hasDump
    ? '# No dump: the template stays empty (the app creates its schema).'
    : dump === 'custom'
      ? `pg_restore -h 127.0.0.1 -U sandbox -d "$LOADING" --no-owner --no-privileges /dump/dump.custom || echo "pg_restore reported errors; continuing"`
      : `psql -h 127.0.0.1 -U sandbox -v ON_ERROR_STOP=0 -d "$LOADING" -f /dump/dump.sql >/dev/null || echo "psql reported errors; continuing"`;
  const restore = `#!/bin/sh
# Restores the dump into the template database once (goodboy sandbox-init).
set -eu
export PGPASSWORD=${DUMMY_PASSWORD}
TEMPLATE=${t}
LOADING=${t}_loading
PSQL="psql -h 127.0.0.1 -U sandbox -v ON_ERROR_STOP=1 -d postgres"
if [ "$($PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='$TEMPLATE'")" = 1 ]; then
  echo "template $TEMPLATE exists"
  exit 0
fi
$PSQL -c "DROP DATABASE IF EXISTS \\"$LOADING\\"" -c "CREATE DATABASE \\"$LOADING\\""
${loadStep}
# The rename marks the restore as complete: a half-loaded database is never the template.
$PSQL -c "ALTER DATABASE \\"$LOADING\\" RENAME TO \\"$TEMPLATE\\""
echo "template $TEMPLATE restored"
`;
  const drop = major(s.v) >= 13 ? `-c 'DROP DATABASE IF EXISTS "${s.name}" WITH (FORCE)'` : `-c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${s.name}' AND pid <> pg_backend_pid()" -c 'DROP DATABASE IF EXISTS "${s.name}"'`;
  const reset = `#!/bin/sh
# Creates the app database from the template (goodboy sandbox-init). Run before every suite.
set -eu
export PGPASSWORD=${DUMMY_PASSWORD}
psql -h 127.0.0.1 -U sandbox -v ON_ERROR_STOP=1 -d postgres ${drop} -c 'CREATE DATABASE "${s.name}" TEMPLATE "${t}"'
`;
  return { restore, reset };
}

export function mysqlScripts(s: Sql, hasDump: boolean): { restore: string; reset: string } {
  const maria = s.store.kind === 'mariadb';
  const cli = maria ? 'mariadb' : 'mysql';
  const dumper = maria ? 'mariadb-dump' : 'mysqldump';
  const t = `${s.name}_template`;
  const load = hasDump ? `$MY --force "$TEMPLATE" < /dump/dump.sql || echo "${cli} reported errors; continuing"` : '# No dump: the template stays empty (the app creates its schema).';
  const restore = `#!/bin/sh
# Restores the dump into the template database once (goodboy sandbox-init).
set -eu
MY="${cli} -h 127.0.0.1 -uroot -p${DUMMY_PASSWORD}"
TEMPLATE=${t}
if [ "$($MY -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TEMPLATE' AND table_name='__goodboy_loaded'")" = 1 ]; then
  echo "template $TEMPLATE exists"
  exit 0
fi
$MY -e "DROP DATABASE IF EXISTS \\\`$TEMPLATE\\\`; CREATE DATABASE \\\`$TEMPLATE\\\`"
${load}
# The marker table says the restore ran to its end.
$MY -e "CREATE TABLE \\\`$TEMPLATE\\\`.__goodboy_loaded (id INT)"
echo "template $TEMPLATE restored"
`;
  const reset = `#!/bin/sh
# Reloads the app database from the template (goodboy sandbox-init). Run before every suite.
set -eu
MY="${cli} -h 127.0.0.1 -uroot -p${DUMMY_PASSWORD}"
TEMPLATE=${t}
$MY -e "DROP DATABASE IF EXISTS \\\`${s.name}\\\`; CREATE DATABASE \\\`${s.name}\\\`"
${dumper} -h 127.0.0.1 -uroot -p${DUMMY_PASSWORD} --single-transaction --routines --triggers --events --ignore-table="$TEMPLATE.__goodboy_loaded" "$TEMPLATE" > /tmp/goodboy-snapshot.sql
$MY "${s.name}" < /tmp/goodboy-snapshot.sql
rm -f /tmp/goodboy-snapshot.sql
`;
  return { restore, reset };
}

// ---- the plan ----

export const GITIGNORE = 'local.json\nout/\nca/*.key\n*.p12\n';

export const CATCH_ALL = JSON.stringify(
  { priority: 10, request: { urlPattern: '.*' }, response: { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'goodboy sandbox: no stub for this request' } },
  null,
  2,
) + '\n';

export function ldif(base: string, domainPart: string): string {
  return `# Test directory for the sandbox (goodboy sandbox-init): one user, uid=test, password "test".
dn: ou=people,${base}
changetype: add
objectClass: organizationalUnit
ou: people

dn: uid=test,ou=people,${base}
changetype: add
objectClass: inetOrgPerson
objectClass: top
cn: Test User
sn: User
uid: test
mail: test@${domainPart}
userPassword: test
`;
}

export function entrypoint(stack: SandboxStack, jdk: string): string {
  const head = `#!/bin/sh
# Makes the container trust the sandbox CA, then runs the command (goodboy sandbox-init).
set -eu
`;
  if (stack !== 'jvm') return head + 'exec "$@"\n';
  const store = Number(jdk) <= 8 ? '-keystore "$JAVA_HOME/jre/lib/security/cacerts"' : '-cacerts';
  return (
    head +
    `if [ -f ${CA_MOUNT} ]; then
  if ! keytool -list ${store} -storepass changeit -alias goodboy-sandbox >/dev/null 2>&1; then
    keytool -importcert -noprompt -trustcacerts ${store} -storepass changeit -alias goodboy-sandbox -file ${CA_MOUNT} >/dev/null
  fi
fi
${jacocoEntrypoint()}exec "$@"
`
  );
}

export function prepScript(scan: SandboxScan): string {
  const steps = [scan.build.depsCommand, scan.build.buildCommand].filter((c) => c.length > 0).map(shellLine);
  steps.push(...coveragePrep(scan.stack, scan.build.tool));
  return `#!/bin/sh
# The preparation step (goodboy sandbox-init): copies the source into the build volume, then
# downloads the dependencies and builds. It has network access and never sees the dump.
set -eu
find /build -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
(cd /src && tar cf - --exclude=./.git --exclude=./.goodboy --exclude=node_modules --exclude=./build --exclude=./target --exclude=./.gradle .) | tar xf - -C /build
cd /build
${steps.join('\n')}
echo "goodboy: preparation done"
`;
}

export interface Cache {
  vol: string;
  path: string;
}

/** What each stack keeps between the preparation step and a run. */
export function stackProfile(scan: SandboxScan): { caches: Cache[]; /** Volumes the app needs to run (not only to build). */ runtimeVols: (dir: string) => string[]; env: Record<string, string> } {
  const tool = scan.build.tool;
  if (scan.stack === 'jvm') return { caches: [{ vol: 'gradle', path: '/root/.gradle' }, { vol: 'm2', path: '/root/.m2' }, { vol: 'jacoco', path: '/jacoco' }], runtimeVols: () => [], env: {} };
  if (scan.stack === 'node') {
    return {
      caches: [{ vol: 'cache', path: '/root/.cache' }, { vol: 'tools', path: '/goodboy-tools' }],
      runtimeVols: (dir) => [`node_modules:${dir}/node_modules`],
      env: { npm_config_cache: '/root/.cache/npm', YARN_CACHE_FOLDER: '/root/.cache/yarn', npm_config_store_dir: '/root/.cache/pnpm' },
    };
  }
  const env: Record<string, string> = {
    PYTHONUSERBASE: '/deps/py',
    PIP_USER: '1',
    PIP_CACHE_DIR: '/deps/cache',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PATH: '/deps/py/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
  if (tool === 'poetry') env.POETRY_VIRTUALENVS_PATH = '/deps/venvs';
  if (tool === 'uv') env.UV_PROJECT_ENVIRONMENT = '/deps/venv';
  return { caches: [], runtimeVols: () => ['deps:/deps'], env };
}

