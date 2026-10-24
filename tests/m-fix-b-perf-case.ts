// Child process of tests/m-fix-b-perf.test.ts (not a test itself): builds one pathological
// project in a temp dir, times one call into the scan or the inventory, prints the milliseconds.
// Usage: bun tests/m-fix-b-perf-case.ts <case name>
// A child process, so that a case that is still quadratic can be killed at a time limit instead
// of freezing the test run.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const BYTES = 200_000;
const rep = (unit: string, bytes = BYTES) => unit.repeat(Math.ceil(bytes / unit.length));

const PKG = JSON.stringify({ name: 'x', dependencies: { express: '4', next: '14', react: '18' } });
const BOOT_GRADLE = "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n";

type Files = Record<string, string>;
interface Case {
  run: 'scan' | 'inventory' | 'check' | 'plan' | 'cache';
  files: Files;
  /** For `check`: what uiCheck is given. */
  check?: () => { inventory: unknown; logs: string[]; reports: string[] };
}

/** uiCheck with `items` screens, a passing test per screen with `perTest` requests, and `apis` api
 *  items that only the last requests of the log reach. */
function checkCase(items: number, perTest: number, apis: number): Case {
  return {
    run: 'check',
    files: {},
    check: () => {
      const inv = {
        root: '/x',
        contextPath: '/shop',
        notes: [],
        items: [
          ...Array.from({ length: items }, (_, i) => ({ id: `screen:GET:/p${i}`, kind: 'screen', method: 'GET', route: `/p${i}`, file: 'f', line: 1, input: false, label: `p${i}` })),
          ...Array.from({ length: apis }, (_, i) => ({ id: `api:GET:/api/q${i}`, kind: 'api', method: 'GET', route: `/api/q${i}`, file: 'f', line: 1, input: false, label: `q${i}` })),
        ],
      };
      const lines: string[] = [];
      for (let i = 0; i < items; i++) {
        const claim = `screen:GET:/p${i}:ok`;
        const head = { 'X-Goodboy-Test': [`nonce${String(i).padStart(8, '0')}`], 'X-Goodboy-Ui': [claim] };
        lines.push(JSON.stringify({ request: { method: 'GET', uri: `/shop/p${i}`, headers: { ...head, 'Upgrade-Insecure-Requests': ['1'] } }, status: 200 }));
        for (let k = 1; k < perTest; k++) lines.push(JSON.stringify({ request: { method: 'GET', uri: `/shop/assets/a${k}.js`, headers: head }, status: 200 }));
      }
      const first = { 'X-Goodboy-Test': [`nonce${String(0).padStart(8, '0')}`], 'X-Goodboy-Ui': ['screen:GET:/p0:ok'] };
      for (let i = 0; i < apis; i++) lines.push(JSON.stringify({ request: { method: 'GET', uri: `/shop/api/q${i}`, headers: first }, status: 200 }));
      const specs = Array.from({ length: items }, (_, i) => ({
        title: `t${i}`,
        tests: [
          {
            expectedStatus: 'passed',
            status: 'expected',
            annotations: [
              { type: 'goodboy-ui', description: `screen:GET:/p${i}:ok` },
              { type: 'goodboy-test', description: `nonce${String(i).padStart(8, '0')}` },
            ],
            results: [{ status: 'passed' }],
          },
        ],
      }));
      return { inventory: inv, logs: [lines.join('\n')], reports: [JSON.stringify({ suites: [{ title: 'a.spec.ts', specs }] })] };
    },
  };
}

/** One inventory case: a single file of one repeated unit (the inventory reads Java, JS and templates). */
const inv = (rel: string, unit: string, more: Files = {}): Case => ({ run: 'inventory', files: { 'package.json': PKG, ...more, [rel]: rep(unit) } });

function hostsCase(files: number, hosts: number): Case {
  const f: Files = { 'package.json': PKG };
  f['.env'] = Array.from({ length: hosts }, (_, i) => `SERVICE_${i}_HOST=svc${i}.example.com`).join('\n') + '\n';
  const filler = rep('const x = 1; // nothing that names a host key here\n', 8000);
  for (let i = 0; i < files; i++) f[`src/f${i}.js`] = filler + `fetch("/a${i}");\n`;
  return { run: 'scan', files: f };
}

function routesLinksCase(n: number): Case {
  const methods = Array.from({ length: n }, (_, i) => `  @GetMapping("/p${i}/{id}") public String m${i}(Model m) { return "v${i}"; }\n`).join('');
  const f: Files = {
    'build.gradle': BOOT_GRADLE,
    'src/main/java/com/a/C.java': `package com.a;\n@Controller\npublic class C {\n${methods}}\n`,
  };
  const per = 20;
  for (let t = 0; t < n / per; t++) {
    f[`src/main/resources/templates/t${t}.html`] = Array.from({ length: per }, (_, k) => `<a href="/p${t * per + k}/\${id}">x</a>\n<a href="/nowhere${k}">y</a>\n`).join('');
  }
  return { run: 'inventory', files: f };
}

/** `n` URL constants in one file (a TypeScript or a Java one), and nothing that calls out. */
function constantsCase(n: number, java: boolean): Case {
  const decl = (i: number) => (java ? `  public static final String H${i} = "https://h${i}.example.com";\n` : `export const H${i} = "https://h${i}.example.com";\n`);
  const body = Array.from({ length: n }, (_, i) => decl(i)).join('');
  return java
    ? { run: 'scan', files: { 'package.json': PKG, 'src/main/java/C.java': `package a;\npublic class C {\n${body}}\n` } }
    : { run: 'scan', files: { 'package.json': PKG, 'src/c.ts': body, 'src/use.ts': 'fetch(H1);\n' } };
}

/** `n` String constants that double: A0 = "/a", A_i = A_{i-1} + A_{i-1}; the controller maps the last. */
function diamondCase(n: number): Case {
  const lines = ['  static final String A0 = "/a";', ...Array.from({ length: n - 1 }, (_, i) => `  static final String A${i + 1} = A${i} + A${i};`)];
  return {
    run: 'inventory',
    files: { 'build.gradle': BOOT_GRADLE, 'src/main/java/com/a/C.java': `package com.a;\n@Controller\npublic class C {\n${lines.join('\n')}\n  @GetMapping(A${n - 1}) public String m() { return "v"; }\n}\n` },
  };
}

/** One Spring controller whose class maps `prefixes` paths and whose method maps `paths` paths. */
function springProductCase(prefixes: number, paths: number): Case {
  const list = (n: number, tag: string) => `{${Array.from({ length: n }, (_, i) => `"/${tag}${i}"`).join(', ')}}`;
  return {
    run: 'inventory',
    files: { 'build.gradle': BOOT_GRADLE, 'src/main/java/com/a/C.java': `package com.a;\n@Controller\n@RequestMapping(${list(prefixes, 'p')})\npublic class C {\n  @GetMapping(${list(paths, 'q')}) public String m() { return "v"; }\n}\n` },
  };
}

/** planSandbox with `hosts` hosts spread over two config files of `filler` unrelated keys each. */
function planCase(hosts: number, filler: number, nfiles = 2, dense = false): Case {
  // host i is in file i % nfiles, and the plan visits the hosts by name (h0, h1, h10, h100, …): it
  // switches from one file to another at almost every host
  const file = (k: number) =>
    [...Array.from({ length: filler }, (_, j) => (dense ? `k${j}: 1` : `filler.k${j}: value${j}`)), ...Array.from({ length: hosts }, (_, i) => i).filter((i) => i % nfiles === k).map((i) => `partner.h${i}.url: https://h${i}.example.com/x`)].join('\n') + '\n';
  const configs: Record<string, string> = { 'config.yml': file(0) };
  for (let k = 1; k < nfiles; k++) configs[`config.e${k}.yml`] = file(k);
  // (a call that reads a `url`: every host key ends in it, so each host gets a call site and a dummy)
  return { run: 'plan', files: { 'package.json': PKG, 'src/a.js': 'const url = 1; fetch(url);\n', ...configs } };
}

const CASES: Record<string, () => Case> = {
  // ---- the scan ----
  'scan-gradle-blank-lines': () => ({ run: 'scan', files: { 'build.gradle': rep('\n') } }),
  'scan-gradle-id-spaces': () => ({ run: 'scan', files: { 'build.gradle': `id${' '.repeat(BYTES)}` } }),
  'scan-gradle-source-compat-spaces': () => ({ run: 'scan', files: { 'build.gradle': `sourceCompatibility${' '.repeat(BYTES)}` } }),
  'scan-pom-java-version-spaces': () => ({ run: 'scan', files: { 'pom.xml': `<java.version>${' '.repeat(BYTES)}` } }),
  'scan-pyproject-blank-lines': () => ({ run: 'scan', files: { 'pyproject.toml': rep('\n') } }),
  'scan-java-escaped-quotes': () => ({ run: 'scan', files: { 'package.json': PKG, 'src/main/java/A.java': rep('"\\\'') } }),
  'scan-url-trailing-punctuation': () => ({ run: 'scan', files: { 'package.json': PKG, 'src/f.js': `http://a${';'.repeat(BYTES)}x` } }),
  'scan-placeholder-defaults': () => ({ run: 'scan', files: { 'package.json': PKG, '.env': `A=${rep('${a:')}\n` } }),
  'scan-properties-continuation': () => ({ run: 'scan', files: { 'build.gradle': BOOT_GRADLE, 'src/main/resources/application.properties': rep('a=b\\\n') } }),
  'scan-json-leaves': () => ({
    run: 'scan',
    files: { 'package.json': PKG, 'config/default.json': `{\n${Array.from({ length: 70_000 }, (_, i) => `"k${i}":"v"`).join(',\n')}\n}\n` },
  }),
  'scan-many-host-literals': () => ({ run: 'scan', files: { 'package.json': PKG, 'src/a.js': rep('const h = "h1.example.com"; // host\n') } }),
  'scan-uvicorn-calls': () => ({ run: 'scan', files: { 'requirements.txt': 'fastapi\n', 'app.py': `app = FastAPI()\n${rep('uvicorn.run(')}` } }),
  'scan-hosts-times-files': () => hostsCase(3000, 300),
  'scan-constants-one-file': () => constantsCase(4000, false),
  'scan-java-constants-no-call': () => constantsCase(4000, true),
  'plan-two-config-files': () => planCase(280, 20_000),
  'plan-twelve-config-files': () => planCase(280, 20_000, 12),
  // the cache itself: 60 dense config files of 0.7 MB (one key per 11 characters) asked for in turn; prints the heap it keeps
  'config-cache-dense-files': () => ({ run: 'cache', files: {} }),
  // ---- the UI inventory ----
  'inv-spring-unclosed-annotations': () => inv('src/main/java/A.java', '@GetMapping('),
  'inv-spring-unclosed-request-mapping': () => inv('src/main/java/A.java', '@RequestMapping('),
  'inv-html-open-tags': () => inv('src/main/resources/templates/a.html', '<a '),
  'inv-html-open-quotes': () => inv('src/main/resources/templates/a.html', '<a href="x '),
  'inv-html-forms-no-close': () => inv('src/main/resources/templates/a.html', '<form action="/x"><input name="a">\n'),
  'inv-html-unclosed-comments': () => inv('src/main/resources/templates/a.html', '<!--'),
  'inv-html-unclosed-scripts': () => inv('src/main/resources/templates/a.html', '<script>'),
  'inv-html-script-src-no-gt': () => inv('src/main/resources/templates/a.html', '<script src'),
  'inv-html-placeholders': () => inv('src/main/resources/templates/a.html', '<a href="${'),
  'inv-html-c-url': () => inv('src/main/resources/templates/a.html', '<a href="<c:url '),
  'inv-html-onclick': () => inv('src/main/resources/templates/a.html', '<button onclick="'),
  'inv-js-open-fetch': () => inv('src/f.js', 'fetch('),
  'inv-js-nested-fetch': () => inv('src/f.js', 'fetch(fetch('),
  'inv-js-closed-nested-fetch': () => ({ run: 'inventory', files: { 'package.json': PKG, 'src/f.js': `${'fetch('.repeat(20_000)}${')'.repeat(20_000)}` } }),
  'inv-js-location-closers': () => ({ run: 'inventory', files: { 'package.json': PKG, 'src/f.js': `location=${')'.repeat(BYTES)}x` } }),
  'inv-js-router-arrays': () => inv('src/f.js', 'createBrowserRouter(['),
  'inv-jsx-open-handlers': () => inv('src/f.jsx', '<A onClick={'),
  'inv-tsx-unclosed-forms': () => inv('src/f.tsx', '<form onSubmit={x}>'),
  'inv-express-open-routes': () => ({ run: 'inventory', files: { 'package.json': PKG, 'src/f.js': `const express = require("express");\n${rep('app.get("')}` } }),
  'inv-fastapi-router-open': () => ({ run: 'inventory', files: { 'package.json': PKG, 'app.py': `import fastapi\n${rep('r = APIRouter(\n')}` } }),
  'inv-fastapi-decorators': () => ({ run: 'inventory', files: { 'package.json': PKG, 'app.py': `import fastapi\n${rep('@app.get("/x")\n')}` } }),
  'inv-routes-times-links': () => routesLinksCase(3000),
  'inv-constants-diamond': () => diamondCase(26),
  'inv-spring-path-product': () => springProductCase(3000, 3000),
  'inv-fastapi-unclosed-include': () => ({ run: 'inventory', files: { 'package.json': PKG, 'app.py': `import fastapi\n${rep('app.include_router(', 512_000)}` } }),
  // ---- the UI check ----
  'check-items-times-requests': () => checkCase(2500, 40, 1000),
  'check-garbage-log': () => ({ run: 'check', files: {}, check: () => ({ inventory: { root: '/x', contextPath: '/', notes: [], items: [] }, logs: [rep('x\n', 16 * 1024 * 1024)], reports: ['{"suites":[]}'] }) }),
};

export const CASE_NAMES = Object.keys(CASES);

const name = process.argv[2];
if (name !== undefined) {
  const make = CASES[name];
  if (!make) throw new Error(`no case ${name}`);
  const c = make();
  const root = mkdtempSync(join(tmpdir(), 'goodboy-mfb-perf-'));
  try {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    for (const [rel, text] of Object.entries(c.files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    const input = c.check?.();
    let t0 = performance.now();
    let mem: number | null = null; // what is printed after the time: the resident MB, or the heap the case kept
    if (c.run === 'scan') (await import('../lib/sandbox-scan')).scanSandbox(root);
    else if (c.run === 'inventory') (await import('../lib/ui-inventory')).uiInventory(root);
    else if (c.run === 'plan') {
      // only the plan is timed: the scan that makes its input is not
      const scan = (await import('../lib/sandbox-scan')).scanSandbox(root);
      if (scan.outbound.filter((o) => o.callSite !== null).length < 250) throw new Error(`only ${scan.outbound.length} hosts with a call site found`);
      const { planSandbox } = await import('../lib/sandbox-render');
      t0 = performance.now();
      planSandbox(scan, { dump: null, dumpFormat: null }, { root });
    } else if (c.run === 'cache') {
      const { configEntryAt } = await import('../lib/sandbox-scan');
      const texts = Array.from({ length: 60 }, (_, f) => Array.from({ length: 64_000 }, (_, j) => `k${j}: ${f}`).join('\n'));
      Bun.gc(true);
      const before = process.memoryUsage().heapUsed;
      t0 = performance.now();
      for (let f = 0; f < 60; f++) configEntryAt(`c${f}.yml`, texts[f]!.slice(0), 1 + f);
      const ms = Math.round(performance.now() - t0);
      // let the collector finish before counting what is still held
      await Bun.sleep(300);
      Bun.gc(true);
      await Bun.sleep(300);
      Bun.gc(true);
      mem = Math.round((process.memoryUsage().heapUsed - before) / 1048576);
      t0 = performance.now() - ms;
    } else {
      const { uiCheck } = await import('../lib/ui-check');
      const r = uiCheck(input!.inventory as never, input!.logs, input!.reports);
      if (r.covered !== (input!.inventory as { items: unknown[] }).items.length) throw new Error(`covered ${r.covered}, expected all (problems: ${r.problems.join('; ')})`);
    }
    console.log(Math.round(performance.now() - t0), mem ?? Math.round(process.memoryUsage().rss / 1048576));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
