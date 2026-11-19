// Track M, release review M7, groups G5 (coverage and UI) and G6 (role limits): one regression
// test per fix, each red without it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { coverageCheck } from '../lib/coverage-check';
import { jsLoadGroups } from '../lib/existing-tests';
import { roleOf } from '../lib/routing-policy';
import { bashChangedPaths, writeDenial } from '../lib/role-limits';
import { realDataHeld } from '../lib/real-data-held';
import { coverageRc } from '../lib/sandbox-e2e';
import { registerRealData, registryEntryOf } from '../lib/sandbox-registry';
import { privacyOptionsFor } from '../lib/stop-groups';
import { uiInventory } from '../lib/ui-inventory';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g5-')));
  tmpDirs.push(root);
  if (Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV }).exitCode !== 0) throw new Error('git init failed');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const TS = 'export function calc(x: number) {\n  if (x > 1) return x;\n  return -x;\n}\n';

function check(root: string, name: string, text: string) {
  writeFileSync(join(root, `.report-${name}`), text);
  return coverageCheck(root, [join(root, `.report-${name}`)]);
}

const NO_BRANCH_DATA = /no branch data/;

describe('G5 high 1: a report without branch data is not "100% lines and branches"', () => {
  // What Bun 1.3.11 `bun test --coverage --coverage-reporter=lcov` writes: no BRDA, no BRF.
  const BUN_LCOV = (sf: string, hits = 1) => `TN:\nSF:${sf}\nFNF:1\nFNH:1\nDA:1,${hits}\nDA:2,${hits}\nDA:3,${hits}\nLF:3\nLH:${hits > 0 ? 3 : 0}\nend_of_record\n`;

  test('a Bun-shaped lcov (a format with no branch records) passes on full lines and says branches are unmeasured', () => {
    const root = repo({ 'src/calc.ts': TS });
    const out = check(root, 'bun.info', BUN_LCOV('src/calc.ts'));
    expect(out).toMatchObject({ ok: true, problems: [], gaps: [], branches: 'unmeasured', branches_unmeasured: ['src/calc.ts'] });
    expect(out.totals.branches).toEqual({ covered: 0, total: 0 });
  });

  test('an unmeasured format still fails on a missed line', () => {
    const root = repo({ 'src/calc.ts': TS });
    const out = check(root, 'bun0.info', BUN_LCOV('src/calc.ts', 0));
    expect(out).toMatchObject({ ok: false, branches: 'unmeasured' });
    expect(out.gaps[0]).toMatchObject({ rel: 'src/calc.ts', lines_missed: [1, 2, 3] });
  });

  test('an lcov with BRF (istanbul, c8, jest) is measured, also BRF:0: no unmeasured field', () => {
    const root = repo({ 'src/calc.ts': TS });
    const lines = 'TN:\nSF:src/calc.ts\nDA:1,1\nDA:2,1\nDA:3,1\nLF:3\nLH:3\n';
    const proved = check(root, 'b.info', `${lines}BRF:0\nBRH:0\nend_of_record\n`);
    expect(proved).toMatchObject({ ok: true, problems: [], branches: 'measured', branches_unmeasured: [] });
  });

  test('the lines-only judgment is per file: an istanbul lcov merged with a coverage.py Cobertura without branch = True is a problem', () => {
    const root = repo({ 'web/a.ts': TS, 'm.py': 'def g(x):\n    if x > 1:\n        return x\n    return -x\n' });
    writeFileSync(join(root, '.report-js.info'), 'TN:\nSF:web/a.ts\nDA:2,1\nDA:3,1\nBRDA:2,0,0,1\nBRDA:2,0,1,1\nBRF:2\nBRH:2\nLF:2\nLH:2\nend_of_record\n');
    const lines = ['1', '2', '3', '4'].map((n) => `<line number="${n}" hits="1"/>`).join('');
    writeFileSync(join(root, '.report-py.xml'), `<?xml version="1.0" ?>\n<coverage version="7"><sources><source>${root}</source></sources><packages><package name="p"><classes><class name="m" filename="m.py"><lines>${lines}</lines></class></classes></package></packages></coverage>\n`);
    const out = coverageCheck(root, [join(root, '.report-js.info'), join(root, '.report-py.xml')]);
    expect(out.ok).toBe(false);
    expect(out.problems.filter((p) => p.includes('no branch data for m.py'))).toHaveLength(1);
    expect(out.problems.some((p) => p.includes('web/a.ts'))).toBe(false);
  });

  test('an lcov with BRF on only some files: the file without BRF or BRDA is lines-only, a file with BRF:0 is fine', () => {
    const root = repo({ 'src/a.ts': TS, 'src/b.ts': TS.replace('calc', 'b'), 'src/c.ts': 'export const c = 1;\n' });
    const text = (sf: string, extra: string) => `TN:\nSF:${sf}\nDA:2,1\nDA:3,1\nLF:2\nLH:2\n${extra}end_of_record\n`;
    const partial = check(root, 'p.info', text('src/a.ts', 'BRDA:2,0,0,1\nBRDA:2,0,1,1\nBRF:2\nBRH:2\n') + text('src/b.ts', '') + text('src/c.ts', 'BRF:0\nBRH:0\n'));
    expect(partial.ok).toBe(false);
    expect(partial.problems).toHaveLength(1);
    expect(partial.problems[0]).toContain('no branch data for src/b.ts');
    expect(partial.problems[0]).not.toContain('src/a.ts');
    expect(partial.problems[0]).not.toContain('src/c.ts');
    // the same report with BRF:0 on the branchless files: istanbul's shape, all fine
    const istanbul = check(root, 'i.info', text('src/a.ts', 'BRDA:2,0,0,1\nBRDA:2,0,1,1\nBRF:2\nBRH:2\n') + text('src/b.ts', 'BRF:0\nBRH:0\n') + text('src/c.ts', 'BRF:0\nBRH:0\n'));
    expect(istanbul).toMatchObject({ ok: true, problems: [], branches: 'measured' });
  });

  test('a Cobertura with a branch attribute somewhere measures every file of the report (coverage.py writes it on branch lines only)', () => {
    const root = repo({ 'pkg/a.py': 'def f(x):\n    if x:\n        return 1\n    return 2\n', 'pkg/b.py': 'def g():\n    return 1\n' });
    const text = `<?xml version="1.0" ?>\n<coverage version="7"><sources><source>${root}</source></sources><packages><package name="p"><classes><class name="a" filename="pkg/a.py"><lines><line number="1" hits="1"/><line number="2" hits="1" branch="true" condition-coverage="100% (2/2)"/><line number="3" hits="1"/><line number="4" hits="1"/></lines></class><class name="b" filename="pkg/b.py"><lines><line number="1" hits="1"/><line number="2" hits="1"/></lines></class></classes></package></packages></coverage>\n`;
    expect(check(root, 'cb.xml', text)).toMatchObject({ ok: true, problems: [], branches: 'measured' });
  });

  test('one Bun-shaped report next to a measured one is partly unmeasured, and still passes', () => {
    const root = repo({ 'src/calc.ts': TS, 'src/util.ts': TS.replace('calc', 'util') });
    writeFileSync(join(root, '.report-bun.info'), BUN_LCOV('src/util.ts'));
    writeFileSync(join(root, '.report-jest.info'), 'TN:\nSF:src/calc.ts\nDA:1,1\nDA:2,1\nDA:3,1\nBRDA:2,0,0,1\nBRDA:2,0,1,1\nBRF:2\nBRH:2\nend_of_record\n');
    const out = coverageCheck(root, [join(root, '.report-bun.info'), join(root, '.report-jest.info')]);
    expect(out).toMatchObject({ ok: true, branches: 'partly', branches_unmeasured: ['src/util.ts'] });
  });

  test('lcov with BRDA records passes, and one file with BRF:0 among others without branch records is enough evidence', () => {
    const root = repo({ 'src/calc.ts': TS });
    const withBrda = check(root, 'c.info', 'TN:\nSF:src/calc.ts\nDA:1,1\nDA:2,1\nDA:3,1\nBRDA:2,0,0,1\nBRDA:2,0,1,1\nend_of_record\n');
    expect(withBrda).toMatchObject({ ok: true, totals: { branches: { covered: 2, total: 2 } } });
  });

  test('Cobertura from coverage.py without branch = True (no branch attribute on any line) is a problem', () => {
    const root = repo({ 'pkg/mod.py': 'def f(x):\n    if x:\n        return 1\n    return 2\n' });
    const cob = (lines: string) =>
      `<?xml version="1.0" ?>\n<coverage version="7"><sources><source>${root}</source></sources><packages><package name="p"><classes><class name="c" filename="pkg/mod.py"><lines>${lines}</lines></class></classes></package></packages></coverage>\n`;
    const bare = check(root, 'a.xml', cob('<line number="1" hits="1"/><line number="2" hits="1"/><line number="3" hits="1"/><line number="4" hits="1"/>'));
    expect(bare.ok).toBe(false);
    expect(bare.problems.some((p) => NO_BRANCH_DATA.test(p))).toBe(true);
    const measured = check(root, 'b.xml', cob('<line number="1" hits="1" branch="false"/><line number="2" hits="1" branch="false"/><line number="3" hits="1" branch="false"/><line number="4" hits="1" branch="false"/>'));
    expect(measured).toMatchObject({ ok: true, problems: [] });
  });

  test('a JaCoCo report always carries branch counters: no problem for a file without branches', () => {
    const root = repo({ 'src/main/java/com/acme/Foo.java': 'package com.acme;\npublic class Foo {\n  public int run(int x) {\n    return x;\n  }\n}\n' });
    const jacoco = '<report name="a"><package name="com/acme"><sourcefile name="Foo.java"><line nr="4" mi="0" ci="2" mb="0" cb="0"/></sourcefile></package></report>';
    expect(check(root, 'j.xml', jacoco)).toMatchObject({ ok: true, problems: [], branches: 'measured', branches_unmeasured: [] });
  });

  test('the Python coverage rc turns branch coverage on', () => {
    expect(coverageRc()).toMatch(/^branch = True$/m);
  });
});

describe('G5 low: an lcov file named without a DA line, and a Cobertura branch line without counts', () => {
  test('lcov SF with neither DA nor LF is not full: the file is missing from the report', () => {
    const root = repo({ 'src/calc.ts': TS });
    const out = check(root, 'e.info', 'TN:\nSF:src/calc.ts\nBRF:0\nend_of_record\n');
    expect(out.ok).toBe(false);
    expect(out.gaps).toEqual([{ rel: 'src/calc.ts', lines_missed: [], branches_missed: [], missing_from_report: true }]);
  });

  test('an istanbul-shaped re-export barrel (SF with LF:0 BRF:0 and no DA) has nothing to cover: not a gap', () => {
    const root = repo({ 'src/index.ts': "export * from './a';\n", 'src/a.ts': TS });
    const out = check(
      root,
      'barrel.info',
      'TN:\nSF:src/index.ts\nFNF:0\nFNH:0\nLF:0\nLH:0\nBRF:0\nBRH:0\nend_of_record\nTN:\nSF:src/a.ts\nFNF:1\nFNH:1\nDA:2,1\nDA:3,1\nLF:2\nLH:2\nBRDA:2,0,0,1\nBRDA:2,0,1,1\nBRF:2\nBRH:2\nend_of_record\n',
    );
    expect(out).toMatchObject({ ok: true, gaps: [], problems: [], required: 2, full: 2, branches: 'measured' });
  });

  test('explicit zero line counters of a JaCoCo source file and an empty Cobertura <lines/> are nothing to cover too', () => {
    const jroot = repo({
      'src/main/java/com/acme/Foo.java': 'package com.acme;\n\npublic class Foo {\n  public int run(int x) {\n    return x > 1 ? x : -x;\n  }\n}\n',
      'src/main/java/com/acme/Bar.java': 'package com.acme;\n\npublic class Bar {\n  public int run(int x) {\n    return x > 1 ? x : -x;\n  }\n}\n',
    });
    const jac =
      '<report name="a"><package name="com/acme"><sourcefile name="Foo.java"><line nr="5" mi="0" ci="2" mb="0" cb="2"/></sourcefile>' +
      '<sourcefile name="Bar.java"><counter type="LINE" missed="0" covered="0"/></sourcefile></package></report>';
    expect(check(jroot, 'jz.xml', jac)).toMatchObject({ ok: true, gaps: [], required: 2, full: 2 });
    const croot = repo({ 'pkg/__init__.py': 'import os\n', 'pkg/mod.py': 'def f(x):\n    return x\n' });
    const cob = `<?xml version="1.0" ?>\n<coverage version="7"><sources><source>${croot}</source></sources><packages><package name="p"><classes><class name="i" filename="pkg/__init__.py"><methods/><lines/></class><class name="m" filename="pkg/mod.py"><lines><line number="1" hits="1" branch="false"/><line number="2" hits="1" branch="false"/></lines></class></classes></package></packages></coverage>\n`;
    expect(check(croot, 'cz.xml', cob)).toMatchObject({ ok: true, gaps: [], required: 2, full: 2 });
  });

  test('Cobertura branch="true" without condition-coverage is a report error, never a pass', () => {
    const root = repo({ 'pkg/mod.py': 'def f(x):\n    if x:\n        return 1\n    return 2\n' });
    const text = `<?xml version="1.0" ?>\n<coverage version="7"><sources><source>${root}</source></sources><packages><package name="p"><classes><class name="c" filename="pkg/mod.py"><lines><line number="1" hits="1"/><line number="2" hits="1" branch="true"/></lines></class></classes></package></packages></coverage>\n`;
    const out = check(root, 'x.xml', text);
    expect(out.ok).toBe(false);
    expect(out.report_errors.some((e) => e.includes('branch="true"') && e.includes('condition-coverage'))).toBe(true);
  });
});

describe('G5 medium 2: web servers the inventory does not read are named, not a silent partial or noUi', () => {
  const cases: [string, string, string][] = [
    ['Koa', 'app.js', "const Koa = require('koa');\nconst app = new Koa();\napp.use(ctx => { ctx.body = 'x'; });\n"],
    ['Koa', 'app.ts', "import Koa from 'koa';\nconst app = new Koa();\n"],
    ['Fastify', 'server.js', "import Fastify from 'fastify';\nconst app = Fastify();\napp.get('/orders', async () => 'x');\n"],
    ['NestJS', 'src/orders.controller.ts', "import { Controller, Get } from '@nestjs/common';\n@Controller('orders')\nexport class C { @Get() list() { return 1; } }\n"],
    ['Hapi', 'server.js', "const Hapi = require('@hapi/hapi');\nconst s = Hapi.server({ port: 3000 });\n"],
    ['node:http server', 'server.js', "const http = require('http');\nhttp.createServer((req, res) => {\n  if (req.url === '/orders') return res.end('x');\n  res.end('home');\n}).listen(3000);\n"],
    ['node:http server', 'server.mjs', "import { createServer } from 'node:http';\nconst s = createServer(async function (req, res) {\n  if (req.method === 'GET' && req.url === '/orders') res.end('x');\n});\n"],
    ['node:http server', 'tls.mjs', "import { createServer } from 'node:https';\ncreateServer(opts, (req, res) => {\n  switch (req.url) { case '/a': return res.end('a'); }\n}).listen(443);\n"],
    ['Servlet (HttpServlet, @WebServlet)', 'src/main/java/com/acme/OrderServlet.java', 'package com.acme;\npublic class OrderServlet extends HttpServlet {\n  protected void doGet(HttpServletRequest q, HttpServletResponse r) {}\n}\n'],
    ['Servlet (HttpServlet, @WebServlet)', 'src/main/java/com/acme/S.java', 'package com.acme;\n@WebServlet("/orders")\npublic class S {}\n'],
  ];
  for (const [name, rel, text] of cases) {
    test(`${name} (${rel}): the inventory says the framework was not read`, () => {
      const root = repo({ 'package.json': '{"name":"x"}', [rel]: text });
      const inv = uiInventory(root);
      expect(inv.truncated).toEqual([`framework not read: ${name} (for example ${rel}): its routes are not listed`]);
      expect(inv.noUi).toBeUndefined();
    });
  }

  test('no false alarm for ordinary Express and Next apps that start a node:http server (the three reviewer cases)', () => {
    const express = (name: string, files: Record<string, string>) => {
      const inv = uiInventory(repo({ 'package.json': '{"name":"x"}', ...files }));
      expect([name, inv.truncated]).toEqual([name, undefined]);
      return inv;
    };
    // Express with a CORS middleware that reads req.method, in the file that calls http.createServer(app)
    const a = express('express+cors', {
      'server.js': "const http = require('http');\nconst express = require('express');\nconst app = express();\napp.use((req, res, next) => { if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });\napp.get('/', (req, res) => res.send('<a href=\"/x\">x</a>'));\nhttp.createServer(app).listen(3000);\n",
    });
    expect(a.items.map((i) => i.id)).toContain('api:GET:/');
    // https.createServer(opts, app) with a function in the file that logs req.url
    express('express+https', {
      'server.js': "import https from 'https';\nimport express from 'express';\nconst app = express();\napp.get('/', (req, res) => res.send('x'));\nhttps.createServer(opts, app).listen(3000);\nfunction log(req) { console.log(req.url); }\n",
    });
    // the Next.js custom server of the Next docs
    express('next custom server', {
      'pages/index.js': 'export default function P() { return <a href="/a">a</a>; }\n',
      'server.js': "const { createServer } = require('http');\nconst { parse } = require('url');\nconst next = require('next');\nconst app = next({ dev: true });\nconst handle = app.getRequestHandler();\napp.prepare().then(() => {\n  createServer((req, res) => {\n    const parsedUrl = parse(req.url, true);\n    handle(req, res, parsedUrl);\n  }).listen(3000);\n});\n",
    });
    // an inline handler that does not route, and a handler passed by name, are no hand-routed server either
    express('inline, no routing', { 'server.js': "const http = require('http');\nhttp.createServer((req, res) => res.end('x')).listen(3000);\n" });
    express('named handler', { 'server.js': "const http = require('http');\nfunction h(req, res) { if (req.url === '/a') res.end('a'); }\nhttp.createServer(h).listen(3000);\n" });
  });

  test('no false alarm: Express with createServer(app), a Spring controller using HttpServletRequest, and koa-router in a string', () => {
    const express = uiInventory(
      repo({
        'package.json': '{"name":"x"}',
        'app.js': "const express = require('express');\nconst app = express();\napp.get('/orders', (req, res) => res.send('x'));\nmodule.exports = app;\n",
        'server.js': "const http = require('http');\nconst app = require('./app');\nhttp.createServer(app).listen(3000);\n",
      }),
    );
    expect(express.truncated).toBeUndefined();
    expect(express.items.map((i) => i.id)).toContain('api:GET:/orders');
    const spring = uiInventory(
      repo({
        'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n",
        'src/main/java/com/a/C.java': 'package com.a;\n@Controller\npublic class C {\n  @GetMapping("/a") public String a(HttpServletRequest req) { return "v"; }\n}\n',
      }),
    );
    expect(spring.truncated).toBeUndefined();
    const text = uiInventory(repo({ 'package.json': '{"name":"x"}', 'lib/names.js': "module.exports = ['koa', 'fastify', '@nestjs/core'];\nconst s = \"require('koa-router')\";\n" }));
    expect(text.truncated).toBeUndefined();
  });
});

describe('G5 low: jsLoadGroups reads code without comments', () => {
  test('a commented-out import loads nothing; a real one does', () => {
    const text = "// import a from './gone'\n/* const b = require('./also-gone'); */\nimport c from './real';\nconst d = require('./real2');\n";
    expect(jsLoadGroups(text, 'tests/x.test.ts').map((g) => g.target)).toEqual(['tests/real', 'tests/real2']);
  });
});

describe('G6 medium 1: a tester writes .goodboy/sandbox/data.json and nothing else under .goodboy/', () => {
  const tester = roleOf('test-unit')!;
  const project = () => repo({ 'src/a.ts': 'export const a = 1;\n' });

  test('the file at the project top and under a nested project is allowed, other .goodboy files are not', () => {
    const root = project();
    expect(writeDenial(tester, join(root, '.goodboy/sandbox/data.json'), root)).toBeNull();
    expect(writeDenial(tester, join(root, 'svc/api/.goodboy/sandbox/data.json'), root)).toBeNull();
    for (const p of ['.goodboy/sandbox/other.json', '.goodboy/sandbox/data.json.bak', '.goodboy/policy.md', '.goodboy/docs.json', '.goodboy/sandbox/runtime/data.json', '.goodboy/data.json', '.goodboy/sandbox/data.jsonx']) {
      expect([p, writeDenial(tester, join(root, p), root)]).toEqual([p, expect.stringContaining('test files only')]);
    }
  });

  test('a link on the way takes it away (it would write somewhere else)', () => {
    const root = project();
    mkdirSync(join(root, '.goodboy/sandbox'), { recursive: true });
    symlinkSync(join(root, 'src/a.ts'), join(root, '.goodboy/sandbox/data.json'));
    expect(writeDenial(tester, join(root, '.goodboy/sandbox/data.json'), root)).toContain('test files only');
    const root2 = project();
    mkdirSync(join(root2, 'elsewhere'), { recursive: true });
    symlinkSync(join(root2, 'elsewhere'), join(root2, '.goodboy'));
    expect(writeDenial(tester, join(root2, '.goodboy/sandbox/data.json'), root2)).toContain('test files only');
  });

  test('other roles are unchanged: a docs role and a result-only role may not write it', () => {
    const root = project();
    expect(writeDenial(roleOf('build-docs')!, join(root, '.goodboy/sandbox/data.json'), root)).toContain('docs only');
    expect(writeDenial(roleOf('review-all')!, join(root, '.goodboy/sandbox/data.json'), root)).toContain('writes only its result');
  });
});

describe('G6 low: the review gate reads the registry like the PreToolUse rule', () => {
  const HELPER_IMPORT = "import { pick } from '../.goodboy/sandbox/data/goodboy-data';\nexport const u = pick;\n";
  const withRegistry = <T>(dir: string, fn: () => T): T => {
    const before = process.env.GOODBOY_REGISTRY_DIR;
    process.env.GOODBOY_REGISTRY_DIR = dir;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.GOODBOY_REGISTRY_DIR;
      else process.env.GOODBOY_REGISTRY_DIR = before;
    }
  };

  test('after git clean -xfd (no local.json, no raw files) a registered project still needs data-privacy; an unregistered one does not', () => {
    const root = repo({ 'src/leak.ts': HELPER_IMPORT, '.goodboy/sandbox/compose.yml': 'services: {}\n' });
    const f = join(root, 'src/leak.ts');
    const regDir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g5-reg-')));
    tmpDirs.push(regDir);
    // an empty registry: the project holds no real data as far as anything says
    expect(withRegistry(regDir, () => privacyOptionsFor('m7g5-a', root, [f]).privacy!(f))).toBe(false);
    expect(withRegistry(regDir, () => realDataHeld(root))).toBe(false);
    const env = { ...process.env, GOODBOY_REGISTRY_DIR: regDir };
    expect(registerRealData(registryEntryOf(root, { dump: null, dumpFormat: null, realData: true }), env)).toBeNull();
    expect(withRegistry(regDir, () => privacyOptionsFor('m7g5-b', root, [f]).privacy!(f))).toBe(true);
    expect(withRegistry(regDir, () => realDataHeld(root))).toBe(true);
    // a registry for another project changes nothing here
    const other = repo({ 'src/leak.ts': HELPER_IMPORT });
    const regOther = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g5-reg-')));
    tmpDirs.push(regOther);
    expect(registerRealData(registryEntryOf(other, { dump: null, dumpFormat: null, realData: true }), { ...process.env, GOODBOY_REGISTRY_DIR: regOther })).toBeNull();
    expect(withRegistry(regOther, () => privacyOptionsFor('m7g5-c', root, [f]).privacy!(f))).toBe(false);
  });

  test('review-axes, the other path of the same answer, asks data-privacy for a registered project too', () => {
    const root = repo({ 'src/leak.ts': HELPER_IMPORT });
    const regDir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g5-reg-')));
    tmpDirs.push(regDir);
    expect(registerRealData(registryEntryOf(root, { dump: null, dumpFormat: null, realData: true }), { ...process.env, GOODBOY_REGISTRY_DIR: regDir })).toBeNull();
    const axes = (reg: string) =>
      JSON.parse(Bun.spawnSync(['bun', join(import.meta.dir, '..', 'lib', 'cli.ts'), 'review-axes', 'src/leak.ts'], { cwd: root, env: { ...process.env, GOODBOY_REGISTRY_DIR: reg }, stdout: 'pipe', stderr: 'pipe' }).stdout.toString()) as { required_dimensions: string[] };
    expect(axes(regDir).required_dimensions).toContain('data-privacy');
    expect(axes(join(regDir, 'none')).required_dimensions).not.toContain('data-privacy');
  });
});

async function hook(cwd: string, command: string, agent: string): Promise<{ denied: boolean; reason: string }> {
  const sessionId = `m7g5${Math.random().toString(36).slice(2, 10)}`;
  tmpDirs.push(join(tmpdir(), `goodboy-session-${sessionId}`));
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    env: { ...process.env, GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_REGISTRY_DIR: join(cwd, '.empty-registry') },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: agent, tool_input: { command } })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const o = JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  return { denied: o.hookSpecificOutput?.permissionDecision === 'deny', reason: o.hookSpecificOutput?.permissionDecisionReason ?? '' };
}

describe('G6 low: build-docs removes by a pattern inside the docs, as before the removal rule', () => {
  const docsRole = roleOf('build-docs')!;

  test('writeDenial with expanded: a docs dir passes, the repo top, code dirs and a result-only role do not', () => {
    const root = repo({ 'src/a.ts': 'x\n', 'docs/a.md': '# a\n' });
    expect(writeDenial(docsRole, join(root, 'docs'), root, { removal: true, expanded: true })).toBeNull();
    expect(writeDenial(docsRole, join(root, 'docs/versions/v1'), root, { removal: true, expanded: true })).toBeNull();
    for (const p of ['', 'src', 'src/deep']) {
      const abs = join(root, p);
      expect([p, writeDenial(docsRole, abs, root, { removal: true, expanded: true })]).toEqual([p, expect.stringContaining('outside the docs')]);
    }
    expect(writeDenial(roleOf('review-all')!, join(root, 'docs'), root, { removal: true, expanded: true })).toContain('writes only its result');
  });

  test('bashChangedPaths reports docs/*.md as expanded at docs; the hook lets build-docs through and still stops src/*.ts and a bare *', async () => {
    const root = repo({ 'src/a.ts': 'x\n', 'docs/a.md': '# a\n' });
    const expanded: string[] = [];
    bashChangedPaths('rm docs/*.md', root, { removed: [], expanded });
    expect(expanded).toEqual([join(root, 'docs')]);
    // `~+` (the cwd, to the shell) cannot be resolved: skipped, like `~/x` and a variable
    const skipped: string[] = [];
    const none: string[] = [];
    expect(bashChangedPaths('rm -rf ~+/src ~/x "$D"', root, { removed: skipped, expanded: none })).toEqual([]);
    expect([skipped, none]).toEqual([[], []]);
    expect((await hook(root, 'rm docs/*.md', 'goodboy:build-docs')).denied).toBe(false);
    expect((await hook(root, 'rm src/*.ts', 'goodboy:build-docs')).denied).toBe(true);
    expect((await hook(root, 'rm -rf *', 'goodboy:build-docs')).denied).toBe(true);
    // the tests role still may not remove by a pattern
    expect((await hook(root, 'rm tests/*.ts', 'goodboy:test-unit')).denied).toBe(true);
  }, 60_000);
});
