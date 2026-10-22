// The e2e side of the sandbox (track M, M3; plan §19): the logging proxy's Caddyfile, the
// Playwright config and the `uiTest` fixture, the e2e dependency step, and the coverage tools and
// scripts (JaCoCo for the JVM, c8 for Node, coverage.py for Python). Pure text: nothing here
// touches the disk or docker; lib/sandbox-render.ts puts the text into the compose project.
//
// The layout inside the containers:
//   /live     out/live of the host: the app writes its e2e coverage data, the proxy its access log
//   /out      out/<ts> of the run (mounted by `sandbox-run` for the runner and the e2e service)
//   /work     the project source; the e2e service runs the project's e2e dir from /work/e2e
//   /build    the build volume the preparation step filled (the app runs from it)

import type { SandboxStack } from './sandbox-types';

export const E2E_DIR = 'e2e';
/** Where the proxy listens inside `inner`; the e2e service's baseURL. */
export const PROXY_PORT = 8080;
export const PLAYWRIGHT_DEFAULT = '1.49.1';
export const JACOCO_VERSION = '0.8.12';
export const C8_VERSION = '10.1.3';
export const COVERAGE_PY_VERSION = '7.6.1';
/** SHA-1 of the two JaCoCo jars on Maven Central (the `.sha1` files next to them). */
const JACOCO_SHA1 = { agent: '2bec6efe140e3a38a81607181476a4016ef2c613', cli: '4b92df4f57d37f7d262ce15f4600d4593f9f1a58' };
const MAVEN = 'https://repo1.maven.org/maven2/org/jacoco';

export const playwrightImage = (version: string): string => `mcr.microsoft.com/playwright:v${version}-jammy`;

/** The `@playwright/test` version the project's e2e dir uses (its lock file, its package.json, the
 *  root package.json), else the pinned default. Only an exact `x.y.z`, with an optional range sign,
 *  counts: the image must match the library to the patch. */
export function playwrightVersion(read: (rel: string) => string | null): string {
  const exact = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const m = /^[\^~>=v\s]*(\d+\.\d+\.\d+)\s*$/.exec(v);
    return m ? m[1]! : null;
  };
  const json = (rel: string): Record<string, unknown> | null => {
    const t = read(rel);
    if (t === null) return null;
    try {
      const j: unknown = JSON.parse(t);
      return typeof j === 'object' && j !== null ? (j as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const lock = json(`${E2E_DIR}/package-lock.json`);
  const locked = exact((lock?.packages as Record<string, { version?: unknown }> | undefined)?.['node_modules/@playwright/test']?.version);
  if (locked) return locked;
  for (const rel of [`${E2E_DIR}/package.json`, 'package.json']) {
    const j = json(rel);
    const v = exact((j?.devDependencies as Record<string, unknown> | undefined)?.['@playwright/test']) ?? exact((j?.dependencies as Record<string, unknown> | undefined)?.['@playwright/test']);
    if (v) return v;
  }
  return PLAYWRIGHT_DEFAULT;
}

/** Caddy: forwards everything to the app and logs each request as one JSON line with all its
 *  headers (`X-Goodboy-Ui` among them) and the status. */
export function caddyfile(appPort: number): string {
  return `# The sandbox's logging proxy (goodboy sandbox-init, track M3). The browser tests reach the app
# only through it; every request is logged to /live/access.log (out/live/ on the host).
{
	admin off
	auto_https off
}

:${PROXY_PORT} {
	log {
		output file /live/access.log {
			mode 0644
			roll_disabled
		}
		format json
	}
	reverse_proxy app:${appPort}
}
`;
}

export function e2ePrepScript(): string {
  return `#!/bin/sh
# The e2e dependencies (goodboy sandbox-init, track M3): installs the project's e2e packages, and
# @playwright/test at the version of the image, into a volume the e2e service runs from offline.
# It has network access and never sees the dump.
set -eu
VERSION="\${E2E_PLAYWRIGHT_VERSION}"
rm -rf /tmp/e2e
mkdir -p /tmp/e2e
cd /tmp/e2e
if [ -f /src/${E2E_DIR}/package.json ]; then
  cp /src/${E2E_DIR}/package.json .
  [ -f /src/${E2E_DIR}/package-lock.json ] && cp /src/${E2E_DIR}/package-lock.json .
  if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts --no-package-lock; fi
else
  echo '{"name":"goodboy-e2e","private":true}' > package.json
fi
INSTALLED="$(node -p "try{require('./node_modules/@playwright/test/package.json').version}catch(e){''}")"
if [ "$INSTALLED" != "$VERSION" ]; then
  echo "goodboy: installing @playwright/test@$VERSION, the version of the browser image (the project had '\${INSTALLED:-none}')"
  npm install --no-save --no-package-lock --ignore-scripts "@playwright/test@$VERSION"
fi
find /deps -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a node_modules/. /deps/
echo "goodboy: e2e preparation done"
`;
}

export function playwrightConfig(): string {
  return `// The Playwright config of the sandbox's e2e service (goodboy sandbox-init, track M3). It runs the
// project's e2e dir against the logging proxy and writes the JSON report \`ui-check\` reads.
// Traces and screenshots are kept for failing tests only, and \`sandbox-run\` removes what is left
// when the run passes.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: process.env.GOODBOY_E2E_DIR ?? '/work/${E2E_DIR}',
  outputDir: '/out/e2e-artifacts',
  preserveOutput: 'failures-only',
  retries: 0,
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: '/out/playwright-report.json' }]],
  use: {
    baseURL: process.env.GOODBOY_BASE_URL ?? 'http://proxy:${PROXY_PORT}',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
`;
}

/** The fixture a tester imports: \`import { uiTest } from '../.goodboy/sandbox/e2e/goodboy-ui';\`. */
export function uiFixture(): string {
  return `// The e2e fixture of the sandbox (goodboy sandbox-init, track M3): ties a browser test to the ids of
// \`bun lib/cli.ts ui-inventory\`. Every request the test sends (page, context and \`request\`) carries
// the header \`x-goodboy-ui: <id>:ok|error\`, which the logging proxy records, and the test carries
// a \`goodboy-ui\` annotation with the same claims, which the Playwright JSON report records.
// \`ui-check\` joins the two: a claim counts only when the test passed and a logged request under
// it reached the item's route.
//
//   import { uiTest } from '../.goodboy/sandbox/e2e/goodboy-ui';
//   uiTest(['form:POST:/orders/save:ok'], 'saves an order', async ({ page }) => { ... });
//   uiTest(['form:POST:/orders/save:error'], 'rejects an empty title', async ({ page }) => { ... });
import {
  test as base,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestInfo,
} from '@playwright/test';

export const HEADER = 'x-goodboy-ui';
export const ANNOTATION = 'goodboy-ui';

/** \`test\` with the claims of the running test as an option and an annotation that records them. */
export const test = base.extend<{ goodboyClaims: string[]; goodboyAnnotate: void }>({
  goodboyClaims: [[], { option: true }],
  goodboyAnnotate: [
    async ({ goodboyClaims }, use, testInfo) => {
      for (const c of goodboyClaims) testInfo.annotations.push({ type: ANNOTATION, description: c });
      await use();
    },
    { auto: true },
  ],
});

type Args = PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions;

/** \`ids\` are claims \`<id>:ok\` or \`<id>:error\`; an id has no space, comma, semicolon or non-ASCII character. */
export function uiTest(ids: string[], title: string, fn: (args: Args, testInfo: TestInfo) => Promise<void> | void): void {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('uiTest: pass at least one claim, "<id>:ok" or "<id>:error"');
  for (const c of ids) {
    if (!/^[\\x21-\\x7e]+:(?:ok|error)$/.test(c) || /[,;]/.test(c)) throw new Error(\`uiTest: "\${c}" is not <id>:ok|error (an id has no space, comma, semicolon or non-ASCII character)\`);
  }
  test.describe(() => {
    test.use({ goodboyClaims: ids, extraHTTPHeaders: { [HEADER]: ids.join(',') } });
    test(title, fn);
  });
}

export { expect } from '@playwright/test';
`;
}

/** Makes V8 write its coverage when the app is stopped: Node dies on SIGTERM without it. */
export function flushScript(): string {
  return `// Loaded into the app by NODE_OPTIONS (goodboy sandbox-init, track M3): V8 writes its coverage
// data at a normal exit, and \`docker stop\` sends SIGTERM, which ends a Node process without one.
// The app's own handler gets a moment first.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    setTimeout(() => process.exit(0), 1500);
  });
}
`;
}

export function coverageRc(): string {
  return `# coverage.py settings of the sandbox (goodboy sandbox-init, track M3): one data file per process,
# paths relative to the source, data saved when the app is stopped with SIGTERM.
[run]
parallel = True
relative_files = True
sigterm = True
omit =
    */site-packages/*
    */tests/*
    */test_*.py
    */conftest.py

[paths]
source =
    /work
    /build
`;
}

/** Merges lcov files into one record per source file (hits added, functions and branches by key):
 *  \`node lcov-merge.cjs <out> <in>...\`. The unit and the e2e report each list the files they ran. */
export function lcovMergeScript(): string {
  return `// Merges lcov files into one record per source file (goodboy sandbox-init, track M3).
const fs = require('node:fs');
const [out, ...ins] = process.argv.slice(2);
if (!out || ins.length === 0) {
  console.error('usage: lcov-merge.cjs <out> <in>...');
  process.exit(2);
}
const files = new Map();
for (const file of ins) {
  let rec = null;
  for (const raw of fs.readFileSync(file, 'utf8').split('\\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const sf = line.slice(3);
      if (!files.has(sf)) files.set(sf, { fn: new Map(), fnda: new Map(), da: new Map(), br: new Map() });
      rec = files.get(sf);
    } else if (line === 'end_of_record') rec = null;
    else if (rec && line.startsWith('FN:')) {
      const i = line.indexOf(',');
      const name = line.slice(i + 1);
      if (!rec.fn.has(name)) rec.fn.set(name, line.slice(3, i));
    } else if (rec && line.startsWith('FNDA:')) {
      const i = line.indexOf(',');
      rec.fnda.set(line.slice(i + 1), (rec.fnda.get(line.slice(i + 1)) || 0) + Number(line.slice(5, i)));
    } else if (rec && line.startsWith('DA:')) {
      const [l, hits] = line.slice(3).split(',');
      rec.da.set(Number(l), (rec.da.get(Number(l)) || 0) + Number(hits));
    } else if (rec && line.startsWith('BRDA:')) {
      const [l, block, branch, taken] = line.slice(5).split(',');
      const key = l + ',' + block + ',' + branch;
      const prev = rec.br.get(key);
      const n = taken === '-' ? null : Number(taken);
      rec.br.set(key, n === null ? (prev === undefined ? null : prev) : (prev || 0) + n);
    }
  }
}
const lines = [];
for (const [sf, r] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  lines.push('SF:' + sf);
  for (const [name, line] of r.fn) lines.push('FN:' + line + ',' + name);
  for (const [name, hits] of r.fnda) lines.push('FNDA:' + hits + ',' + name);
  lines.push('FNF:' + r.fn.size, 'FNH:' + [...r.fnda.values()].filter((h) => h > 0).length);
  for (const [key, taken] of r.br) lines.push('BRDA:' + key + ',' + (taken === null ? '-' : taken));
  lines.push('BRF:' + r.br.size, 'BRH:' + [...r.br.values()].filter((t) => t).length);
  for (const [l, hits] of [...r.da].sort((a, b) => a[0] - b[0])) lines.push('DA:' + l + ',' + hits);
  lines.push('LF:' + r.da.size, 'LH:' + [...r.da.values()].filter((h) => h > 0).length, 'end_of_record');
}
fs.writeFileSync(out, lines.join('\\n') + '\\n');
`;
}

/** The preparation step's lines that fetch the coverage tools (network on). */
export function coveragePrep(stack: SandboxStack, tool: string): string[] {
  if (stack === 'jvm') {
    return [
      '# the coverage tools: the JaCoCo agent (runs inside the app and the test JVMs) and its CLI (merge, report)',
      'mkdir -p /jacoco',
      `fetch() { curl -fsSL --retry 3 -o "/jacoco/$1" "${MAVEN}/$2" && echo "$3  /jacoco/$1" | sha1sum -c -; }`,
      `fetch jacocoagent.jar org.jacoco.agent/${JACOCO_VERSION}/org.jacoco.agent-${JACOCO_VERSION}-runtime.jar ${JACOCO_SHA1.agent}`,
      `fetch jacococli.jar org.jacoco.cli/${JACOCO_VERSION}/org.jacoco.cli-${JACOCO_VERSION}-nodeps.jar ${JACOCO_SHA1.cli}`,
    ];
  }
  if (stack === 'node') {
    return ['# the coverage tool: c8 turns the V8 coverage data into lcov', `npm install --prefix /goodboy-tools --no-save --no-package-lock --ignore-scripts c8@${C8_VERSION}`];
  }
  return [
    '# the coverage tool: coverage.py, started in every Python process by a .pth file when COVERAGE_PROCESS_START is set',
    `pip install coverage==${COVERAGE_PY_VERSION}`,
    ...(tool === 'poetry' || tool === 'uv' ? ['echo "goodboy: this project runs in a poetry or uv environment; the coverage hook is installed for the system Python only"'] : []),
    'SITE="$(python -c \'import site; print(site.getusersitepackages())\')"',
    'mkdir -p "$SITE"',
    `printf '%s\\n' 'import coverage; coverage.process_startup()' > "$SITE/goodboy-coverage.pth"`,
  ];
}

/** The excludes that keep build-tool classes out of the JaCoCo data of the test JVMs. */
const JACOCO_EXCLUDES = 'org.gradle.*:worker.org.gradle.*:org.codehaus.groovy.*:groovy.*:org.apache.maven.*:org.codehaus.plexus.*';

/** The lines of the entrypoint that put the JaCoCo agent into every JVM the container starts
 *  (JAVA_TOOL_OPTIONS), once the CA is imported: the app (data on stop, written fresh each start)
 *  and the runner (data appended by every test JVM). */
export function jacocoEntrypoint(): string {
  return `if [ -f /jacoco/jacocoagent.jar ] && [ -n "\${GOODBOY_COVERAGE_OUT:-}" ]; then
  export JAVA_TOOL_OPTIONS="\${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-javaagent:/jacoco/jacocoagent.jar=output=file,destfile=\${GOODBOY_COVERAGE_OUT},append=\${GOODBOY_COVERAGE_APPEND:-true},excludes=${JACOCO_EXCLUDES}"
fi
`;
}

/** \`coverage.sh report|report-e2e\`, run in the runner container with the run's dir at /out. Both
 *  write the report from the unit data under /out/coverage (JaCoCo XML, lcov, or Cobertura XML);
 *  \`report-e2e\` first moves the e2e data the app left in /live into the run's dir and merges it
 *  in (a unit-only run never takes e2e data of an earlier run). Exit codes: 4 the coverage tool is
 *  not prepared, 3 no data, 5 or 6 the tool failed. */
export function coverageScript(stack: SandboxStack): string {
  const head = `#!/bin/sh
# Coverage staging and reports (goodboy sandbox-init, track M3).
set -u
stage=0
case "\${1:-}" in
  report) ;;
  report-e2e) stage=1 ;;
  *) echo "usage: coverage.sh report|report-e2e" >&2; exit 2 ;;
esac
mkdir -p /out/coverage /out/coverage-raw/e2e
`;
  if (stack === 'jvm') {
    return `${head}if [ ! -f /jacoco/jacococli.jar ]; then echo "goodboy: the JaCoCo CLI is not prepared; run sandbox-prepare"; exit 4; fi
if [ "$stage" = 1 ] && [ -f /live/jacoco-e2e.exec ]; then mv /live/jacoco-e2e.exec /out/coverage-raw/e2e/jacoco.exec; fi
EXECS=""
for f in /out/coverage-raw/unit/jacoco.exec /out/coverage-raw/e2e/jacoco.exec; do
  [ -s "$f" ] && EXECS="$EXECS $f"
done
if [ -z "$EXECS" ]; then echo "goodboy: no JaCoCo execution data"; exit 3; fi
java -jar /jacoco/jacococli.jar merge $EXECS --destfile /out/coverage-raw/merged.exec || exit 5
CLASSES=""
for d in $(find /build -type d \\( -path '*/build/classes/java/main' -o -path '*/build/classes/kotlin/main' -o -path '*/target/classes' \\) ! -path '*/node_modules/*'); do
  CLASSES="$CLASSES --classfiles $d"
done
SOURCES=""
for d in $(find /build -type d \\( -path '*/src/main/java' -o -path '*/src/main/kotlin' \\) ! -path '*/node_modules/*'); do
  SOURCES="$SOURCES --sourcefiles $d"
done
if [ -z "$CLASSES" ]; then echo "goodboy: no compiled classes in /build; run sandbox-prepare"; exit 6; fi
java -jar /jacoco/jacococli.jar report /out/coverage-raw/merged.exec $CLASSES $SOURCES --xml /out/coverage/jacoco.xml || exit 5
echo "goodboy: wrote /out/coverage/jacoco.xml"
`;
  }
  if (stack === 'node') {
    return `${head}C8=/goodboy-tools/node_modules/.bin/c8
if [ ! -x "$C8" ]; then echo "goodboy: c8 is not prepared; run sandbox-prepare"; exit 4; fi
if [ "$stage" = 1 ] && [ -d /live/v8-e2e ]; then
  cp -a /live/v8-e2e/. /out/coverage-raw/e2e/
  rm -rf /live/v8-e2e
fi
rm -rf /out/coverage-raw/lcov
mkdir -p /out/coverage-raw/lcov
PARTS=""
# c8 reads a source file only below its working dir: the unit tests ran from /work, the app from /build
# (both are the repo root, so the paths in each lcov are the same repo-relative ones)
if ls /out/coverage-raw/unit/v8/*.json >/dev/null 2>&1; then
  (cd /work && "$C8" report --temp-directory /out/coverage-raw/unit/v8 --reporter lcovonly --report-dir /out/coverage-raw/lcov/unit) || exit 5
  PARTS="$PARTS /out/coverage-raw/lcov/unit/lcov.info"
fi
if ls /out/coverage-raw/e2e/*.json >/dev/null 2>&1; then
  (cd /build && "$C8" report --temp-directory /out/coverage-raw/e2e --reporter lcovonly --report-dir /out/coverage-raw/lcov/e2e) || exit 5
  PARTS="$PARTS /out/coverage-raw/lcov/e2e/lcov.info"
fi
if [ -z "$PARTS" ]; then echo "goodboy: no V8 coverage data"; exit 3; fi
node /sandbox/lcov-merge.cjs /out/coverage/lcov.info $PARTS || exit 5
echo "goodboy: wrote /out/coverage/lcov.info"
`;
  }
  return `${head}if ! python -c 'import coverage' 2>/dev/null; then echo "goodboy: coverage.py is not prepared; run sandbox-prepare"; exit 4; fi
if [ "$stage" = 1 ] && [ -d /live/py-e2e ]; then
  cp -a /live/py-e2e/. /out/coverage-raw/e2e/
  rm -rf /live/py-e2e
fi
FILES="$(ls /out/coverage-raw/unit/py/.coverage.* /out/coverage-raw/e2e/.coverage.* 2>/dev/null || true)"
if [ -z "$FILES" ]; then echo "goodboy: no coverage.py data"; exit 3; fi
export COVERAGE_PROCESS_START=
cd /work
rm -f /out/coverage-raw/.coverage
python -m coverage combine --keep --rcfile=/sandbox/coveragerc --data-file=/out/coverage-raw/.coverage $FILES || exit 5
python -m coverage xml --rcfile=/sandbox/coveragerc --data-file=/out/coverage-raw/.coverage -o /out/coverage/coverage.xml || exit 5
echo "goodboy: wrote /out/coverage/coverage.xml"
`;
}

/** The report file each stack's \`coverage.sh report\` writes, under out/<ts>/coverage/. */
export const COVERAGE_REPORT: Record<SandboxStack, string> = { jvm: 'jacoco.xml', node: 'lcov.info', python: 'coverage.xml' };
