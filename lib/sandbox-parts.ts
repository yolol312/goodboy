// Pure helpers of the sandbox renderer (track M, M1b; plan §19): YAML text, shell scripts, the
// DB restore and reset scripts, config keys and values. lib/sandbox-render.ts composes them.

import { coveragePrep, jacocoEntrypoint } from './sandbox-e2e';
import { configEntryAt } from './sandbox-scan';
import type { SandboxLocal, SandboxScan, SandboxStack, SandboxStore } from './sandbox-types';

export const CA_MOUNT = '/sandbox/ca.crt';

/** The bridge option that gives an internal network no address on the host's side: without it
 *  the host answers on the network's gateway address (ping, ssh, an exposed docker port). */
export const INHIBIT_IPV4 = 'com.docker.network.bridge.inhibit_ipv4';

/** The first address of a subnet (`10.231.0.0/24` gives `10.231.0.1`), where Docker would put
 *  the host's bridge address. */
export function firstAddress(subnet: string): string {
  const parts = subnet.split('/')[0]!.split('.').map(Number);
  parts[3] = (parts[3] ?? 0) + 1;
  return parts.join('.');
}

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

/** Characters a glob start-command argument may hold and still be placed unquoted in a `for`. */
const GLOB_WORD = /^[A-Za-z0-9_@%+=:,./*?[\]!^-]+$/;
const hasGlob = (a: string): boolean => /[*?[]/.test(a);

/** The compose `command` of the app. An argument with a glob (`build/libs/*.jar`) is resolved
 *  at start through a shell, because compose runs the command without one: the script skips
 *  plain, sources, javadoc and original-* archives and fails unless exactly one file is left.
 *  A command that is already a `sh -c` or has no glob stays as it is. */
export function startCommandOf(argv: readonly string[]): string[] {
  const shell = (argv[0] === 'sh' || argv[0] === 'bash') && argv[1] === '-c';
  if (shell || !argv.some(hasGlob) || !argv.filter(hasGlob).every((a) => GLOB_WORD.test(a))) return [...argv];
  const lines = ['set -eu'];
  const words = argv.map((a, i) => {
    if (!hasGlob(a)) return shq(a);
    lines.push(
      `G${i}=''; N${i}=0`,
      `for f in ${a}; do`,
      '  [ -e "$f" ] || continue',
      '  case "${f##*/}" in *-plain.*|*-sources.jar|*-javadoc.jar|original-*) continue ;; esac',
      `  G${i}="$f"; N${i}=$((N${i} + 1))`,
      'done',
      `[ "$N${i}" = 1 ] || { echo "goodboy: expected exactly one file for ${a}, found $N${i}" >&2; exit 1; }`,
    );
    return `"$G${i}"`;
  });
  lines.push(`exec ${words.join(' ')}`);
  return ['sh', '-c', lines.join('\n')];
}

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

/** Where every JVM service keeps the Gradle cache (see stackProfile). */
export const GRADLE_HOME = '/gradle-home';

/** The JDK majors the official Maven and Gradle images come in. */
const BUILD_JDKS = [8, 11, 17, 21];

/** `mvn` or `gradle` when a command starts with the bare tool: a project without a wrapper needs
 *  the tool in the image, which the JDK image does not have. A wrapper (`./mvnw`) brings its own. */
export function bareBuildTool(cmd: readonly string[]): 'mvn' | 'gradle' | null {
  return cmd[0] === 'mvn' || cmd[0] === 'gradle' ? cmd[0] : null;
}

/** The official build image for a bare tool at a JDK major: the smallest of 8, 11, 17, 21 that is at least
 *  `jdk` (a newer JDK is run on 21). The app keeps its JDK image; only prep and the runner use this. */
export function buildImage(tool: 'mvn' | 'gradle', jdk: number): string {
  const j = BUILD_JDKS.find((x) => x >= jdk) ?? 21;
  return tool === 'mvn' ? `maven:3.9-eclipse-temurin-${j}` : `gradle:8-jdk${j}`;
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
  // The scan's own parser decides what key a line holds, so the two cannot disagree.
  const e = configEntryAt(file, text, line);
  return e === null ? null : { key: e.key, ...lineValueShape(e.value) };
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

/** The SQLSTATE classes that exist (PostgreSQL appendix A): a restore line is read as a code only when
 *  it starts with one, so a 5-letter word of the dump is not taken for a code. */
const SQLSTATE_CLASSES = '(00|01|02|03|08|09|0A|0B|0D|0F|0L|0P|0Z|20|21|22|23|24|25|26|27|28|2B|2D|2F|34|38|39|3B|3D|3F|40|42|44|53|54|55|57|58|72|F0|HV|P0|XX)';

/** What a failed restore may say: only lines that start with this reach the output of
 *  `sandbox-up` (a restore error can quote a row of the dump). */
export const RESTORE_TAG = 'goodboy:';

/** Statements a plain SQL dump holds that name a role the sandbox does not have: they fail
 *  with SQLSTATE 42704 and are the one error a restore tolerates. */
const PG_ROLE_STATEMENT = '^(ALTER .* OWNER TO |GRANT |REVOKE |ALTER DEFAULT PRIVILEGES )';

export function pgScripts(s: Sql, dump: SandboxLocal['dumpFormat'] | undefined, hasDump: boolean): { restore: string; reset: string } {
  const t = `${s.name}_template`;
  const toleranceNote = `# A restore that reports an error fails (the template is not made). To accept an error you know is
# harmless, edit this file: goodboy never overwrites a file you changed.`;
  const countTables = `TABLES=$(psql -h 127.0.0.1 -U sandbox -d "$LOADING" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")
if [ "$TABLES" -lt 1 ]; then
  echo "${RESTORE_TAG} the restore left no table in $LOADING" >&2
  exit 1
fi`;
  const loadStep = !hasDump
    ? '# No dump: the template stays empty (the app creates its schema).'
    : dump === 'custom'
      ? `ERR=/tmp/goodboy-restore.err
if ! pg_restore -h 127.0.0.1 -U sandbox -d "$LOADING" --no-owner --no-privileges /dump/dump.custom >/dev/null 2>"$ERR"; then
  echo "${RESTORE_TAG} pg_restore failed: $(tail -n 1 "$ERR" | grep -E '^pg_restore: warning: errors ignored on restore: [0-9]+$' || echo 'see the dump and this script')" >&2
  rm -f "$ERR"
  exit 1
fi
rm -f "$ERR"
${countTables}`
      : `# VERBOSITY=sqlstate keeps the text of an error, which can quote a row, out of the output.
ERR=/tmp/goodboy-restore.err
psql -h 127.0.0.1 -U sandbox -v ON_ERROR_STOP=0 -v VERBOSITY=sqlstate -d "$LOADING" -f /dump/dump.sql >/dev/null 2>"$ERR" || true
BAD=0
while IFS= read -r l; do
  # Only the exact line psql prints at VERBOSITY=sqlstate is read: psql:<file>:<line>: <LEVEL>:  <SQLSTATE>
  # with a SQLSTATE class that exists. Anything else (a dump can \\set VERBOSITY, and then the line
  # carries message text, which can quote a row) is withheld and counts as an error.
  if printf '%s\\n' "$l" | grep -Eq '^psql:[^:]*:[0-9]+: (NOTICE|WARNING|INFO):  00000$|^psql:[^:]*:[0-9]+: (NOTICE|WARNING|INFO):  ${SQLSTATE_CLASSES}[0-9A-Z]{3}$'; then continue; fi
  if printf '%s\\n' "$l" | grep -Eq '^psql:[^:]*:[0-9]+: ERROR:  ${SQLSTATE_CLASSES}[0-9A-Z]{3}$'; then
    code=\${l##* }
    n=\${l#psql:*:}
    n=\${n%%:*}
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    # a missing role (an OWNER TO or GRANT of the production role) is expected and harmless
    if [ "$code" = 42704 ] && sed -n "\${n}p" /dump/dump.sql | grep -Eiq '${PG_ROLE_STATEMENT}'; then continue; fi
    BAD=$((BAD + 1))
    if [ "$BAD" -le 20 ]; then echo "${RESTORE_TAG} SQLSTATE $code at dump line $n" >&2; fi
  else
    BAD=$((BAD + 1))
    if [ "$BAD" -le 20 ]; then echo "${RESTORE_TAG} psql printed a line that is not a plain SQLSTATE report (withheld: it may hold dump data)" >&2; fi
  fi
done < "$ERR"
rm -f "$ERR"
if [ "$BAD" -gt 0 ]; then
  echo "${RESTORE_TAG} the restore had $BAD error(s); no template made" >&2
  exit 1
fi
${countTables}`;
  const restore = `#!/bin/sh
# Restores the dump into the template database once (goodboy sandbox-init).
${toleranceNote}
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
  const load = hasDump
    ? `ERR=/tmp/goodboy-restore.err
if ! $MY "$TEMPLATE" < /dump/dump.sql 2>"$ERR"; then
  # the client's message can quote a row: only the code, the state and the line leave
  echo "${RESTORE_TAG} ${cli} failed: $(sed -n 's/^ERROR \\([0-9]*\\) (\\([0-9A-Z]*\\)) at line \\([0-9]*\\):.*/error \\1 (\\2) at dump line \\3/p' "$ERR" | head -n 1)" >&2
  rm -f "$ERR"
  exit 1
fi
rm -f "$ERR"
TABLES=$($MY -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$TEMPLATE'")
if [ "$TABLES" -lt 1 ]; then
  echo "${RESTORE_TAG} the restore left no table in $TEMPLATE" >&2
  exit 1
fi`
    : '# No dump: the template stays empty (the app creates its schema).';
  const restore = `#!/bin/sh
# Restores the dump into the template database once (goodboy sandbox-init).
# A restore that reports an error fails (the template is not made). To accept an error you know
# is harmless, edit this file: goodboy never overwrites a file you changed.
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

/** The init script that makes Gradle resolve every resolvable configuration, so the test
 *  dependencies are in the cache before the offline run. */
const GRADLE_RESOLVE_ALL = `allprojects {
    tasks.register('goodboyResolveAll') {
        doLast {
            configurations.matching { it.canBeResolved }.each { c ->
                try { c.resolve() } catch (Throwable t) { println "goodboy: \${c.name} was not resolved: \${t.class.simpleName}" }
            }
        }
    }
}`;

/** What the offline test run needs and the build does not fetch: the test plugins and engines
 *  (Maven: surefire's provider resolves only when a test class matches; Gradle: the test
 *  classpaths are resolved only by the test task). Done here, with network, never at run time. */
export function testPhasePrep(scan: SandboxScan): string[] {
  const test = scan.build.testCommand;
  if (scan.stack !== 'jvm' || test.length === 0) return [];
  if (scan.build.tool === 'maven') {
    const online = [...test.filter((a) => a !== '-o' && a !== '--offline'), '"-Dtest=$CLS#GoodboyNoSuchMethod"', '-DfailIfNoTests=false', '-Dsurefire.failIfNoSpecifiedTests=false'];
    return [
      '# the test plugins and the JUnit provider: surefire fetches them only when a test class matches, so run no test method of one',
      `CLS=$(find . \\( -path '*/src/test/java/*' -o -path '*/src/test/kotlin/*' -o -path '*/src/test/groovy/*' \\) -type f \\( -name '*Test.*' -o -name '*Tests.*' -o -name 'Test*.*' -o -name '*IT.*' \\) 2>/dev/null | head -n 1)`,
      'if [ -n "$CLS" ]; then',
      '  CLS=${CLS##*/}; CLS=${CLS%.*}',
      `  ${online.map((a) => (a.startsWith('"') ? a : shq(a))).join(' ')}`,
      'else',
      '  echo "goodboy: no test class found; the offline test run may miss the test plugins"',
      'fi',
    ];
  }
  if (scan.build.tool === 'gradle') {
    return [
      '# the test dependencies: Gradle resolves them only when the test task runs, so resolve every configuration now',
      "cat > /tmp/goodboy-resolve.gradle <<'GOODBOY_EOF'",
      GRADLE_RESOLVE_ALL,
      'GOODBOY_EOF',
      `${shq(test[0]!)} --no-daemon --init-script /tmp/goodboy-resolve.gradle goodboyResolveAll`,
    ];
  }
  return [];
}

export function prepScript(scan: SandboxScan): string {
  const steps = [scan.build.depsCommand, scan.build.buildCommand].filter((c) => c.length > 0).map(shellLine);
  steps.push(...testPhasePrep(scan));
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
  // The Gradle cache is not at /root/.gradle: in the official Gradle image that path is a link to
  // /home/gradle/.gradle, which the image declares a VOLUME, so a named volume mounted at
  // /root/.gradle is covered by an anonymous one that `run --rm` throws away (measured).
  if (scan.stack === 'jvm') return { caches: [{ vol: 'gradle', path: GRADLE_HOME }, { vol: 'm2', path: '/root/.m2' }, { vol: 'jacoco', path: '/jacoco' }], runtimeVols: () => [], env: { GRADLE_USER_HOME: GRADLE_HOME } };
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

