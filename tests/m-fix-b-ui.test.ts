// Track M fix round 1, fixer B (plan §19): regression tests for the UI inventory fixes.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdUiCheck, uiCheck } from '../lib/ui-check';
import { cmdUiInventory, uiInventory } from '../lib/ui-inventory';
import { MAX_INVENTORY_ITEMS, Sink } from '../lib/ui-scan-text';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfb-')));
  tmpDirs.push(root);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

// The id format the generated uiTest fixture accepts (lib/sandbox-e2e.ts: no space, comma,
// semicolon or non-ASCII character).
const CLAIMABLE = /^[\x21-\x7e]+$/;

describe('B1/B2: the inventory reads the files test-survey lists, with a time budget and an honest limit note', () => {
  const app = () => ({
    'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n",
    'src/main/java/com/a/C.java': 'package com.a;\n@Controller\npublic class C {\n  @GetMapping("/orders") public String list() { return "orders"; }\n}\n',
    'src/main/resources/templates/orders.html': '<a href="/orders">list</a>\n<button id="go">Go</button>\n',
  });

  test('past its budget the inventory stops with a note and lists what it had (the routes), not the templates', () => {
    const root = repo(app());
    const normal = uiInventory(root);
    expect(normal.items.map((i) => i.id)).toEqual(expect.arrayContaining(['screen:GET:/orders', 'link:GET:/orders']));
    expect(normal.notes.some((n) => n.includes('time budget'))).toBe(false);
    const late = uiInventory(root, { budgetMs: -1 });
    expect(late.notes.some((n) => n.includes('time budget'))).toBe(true);
    expect(late.items.some((i) => i.id.startsWith('link:') || i.id.startsWith('button:'))).toBe(false);
  });

  test('the over-limit note counts the own files that were cut, not every file git lists', () => {
    // 20 500 files under node_modules are not the project's own: nothing is cut, so no note. The
    //   files are only entries of git's index (an empty blob under 20 500 names), which is all
    //   `git ls-files` needs and takes a moment to make.
    const root = repo(app());
    const blob = Bun.spawnSync(['git', 'hash-object', '-w', '--stdin'], { cwd: root, env: GIT_ENV, stdin: new Blob(['']) }).stdout.toString().trim();
    const entries = Array.from({ length: 20_500 }, (_, i) => `100644 ${blob} 0\tnode_modules/pkg/f${i}.txt`).join('\n') + '\n';
    expect(Bun.spawnSync(['git', 'update-index', '--add', '--index-info'], { cwd: root, env: GIT_ENV, stdin: new Blob([entries]) }).exitCode).toBe(0);
    const inv = uiInventory(root);
    expect(inv.notes.filter((n) => n.includes('more than'))).toEqual([]);
    expect(inv.items.map((i) => i.id)).toContain('screen:GET:/orders');
  });

  test('the context path comes from the config files, without a scan of the sources', () => {
    const root = repo({ ...app(), 'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /shop\n' });
    const inv = uiInventory(root);
    expect(inv.contextPath).toBe('/shop');
    // a link that spells the context path out is the same route
    writeFileSync(join(root, 'src/main/resources/templates/orders.html'), '<a href="/shop/orders">list</a>\n');
    expect(uiInventory(root).items.map((i) => i.id)).toContain('link:GET:/orders');
  });
});

describe('round 2: constants stay short, FastAPI routers are still read', () => {
  test('constants that double per line (A_i = A_(i-1) + A_(i-1)) are dropped past 4 KB, not grown until the process runs out of memory', () => {
    const lines = ['  static final String A0 = "/a";', ...Array.from({ length: 39 }, (_, i) => `  static final String A${i + 1} = A${i} + A${i};`)];
    const root = repo({
      'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n",
      'src/main/java/com/a/C.java': `package com.a;\n@Controller\npublic class C {\n${lines.join('\n')}\n  @GetMapping(A39) public String big() { return "v"; }\n  @GetMapping(A3) public String small() { return "v"; }\n}\n`,
    });
    const inv = uiInventory(root);
    // A3 is "/a" eight times: short enough to be a path; A39 is dropped and said so
    expect(inv.items.map((i) => i.route)).toEqual(['/a/a/a/a/a/a/a/a']);
    expect(inv.notes.some((n) => n.includes('path is not a literal or a known constant'))).toBe(true);
  });

  test('a router with a prefix, included with another, is read through the bounded call search', () => {
    const root = repo({
      'package.json': '{"name":"x"}',
      'app.py': 'import fastapi\nfrom fastapi import APIRouter\nrouter = APIRouter(prefix="/items", tags=["a"])\n\n@router.get("/{item_id}")\ndef get(item_id: int):\n    return {}\n\napp = fastapi.FastAPI()\napp.include_router(router, prefix="/api")\n',
    });
    expect(uiInventory(root).items.map((i) => i.id)).toContain('api:GET:/api/items/{item_id}');
    // a call whose `)` is further away than the bound is not read, and an unclosed one does not stop the rest
    const far = repo({ 'package.json': '{"name":"x"}', 'app.py': `import fastapi\napp.include_router(\n${' '.repeat(3000)}\n)\n@router.get("/x")\ndef f():\n    return 1\nrouter = APIRouter(prefix="/p"\n` });
    expect(uiInventory(far).items.map((i) => i.id)).toContain('api:GET:/x');
  });
});

describe('round 3: the inventory has a size, and says when it was cut', () => {
  const list = (n: number, tag: string) => `{${Array.from({ length: n }, (_, i) => `"/${tag}${i}"`).join(', ')}}`;
  const controller = (prefixes: number, paths: number) => ({
    'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n",
    'src/main/java/com/a/C.java': `package com.a;\n@Controller\n@RequestMapping(${list(prefixes, 'p')})\npublic class C {\n  @GetMapping(${list(paths, 'q')}) public String m() { return "v"; }\n  @GetMapping("/one") public String one() { return "v"; }\n}\n`,
  });

  test('a method maps at most 200 path and prefix combinations; the rest is said so, and ui-check fails on it', () => {
    const inv = uiInventory(repo(controller(20, 20))); // 400 combinations
    const ids = inv.items.map((i) => i.id);
    expect(ids.filter((id) => /\/q\d+$/.test(id))).toHaveLength(200);
    expect(ids).toContain('screen:GET:/p0/one'); // the other methods are untouched
    expect(inv.truncated).toHaveLength(1);
    expect(inv.truncated![0]).toContain('C.m maps 400 path and method combinations: only the first 200 are listed');
    expect(inv.notes).toContain(inv.truncated![0]!);
    const r = uiCheck(inv, [''], ['{"suites":[]}']);
    expect(r.problems).toContain(`the inventory is incomplete: ${inv.truncated![0]}`);
    // a method within the cap leaves the inventory complete
    const ok = uiInventory(repo(controller(10, 10)));
    expect(ok.truncated).toBeUndefined();
    expect(uiCheck(ok, [''], ['{"suites":[]}']).problems.some((p) => p.includes('incomplete'))).toBe(false);
  });

  test('the inventory holds at most 50 000 items and 50 000 routes, and says so', () => {
    const sink = new Sink();
    for (let i = 0; i < MAX_INVENTORY_ITEMS + 5; i++) {
      sink.add({ id: `api:GET:/a${i}`, kind: 'api', method: 'GET', route: `/a${i}`, file: 'f', line: 1, input: false, label: 'x' });
      sink.route({ method: 'GET', pattern: `/a${i}`, file: 'f', line: 1, kind: 'api' });
    }
    expect(sink.items.size).toBe(MAX_INVENTORY_ITEMS);
    expect(sink.routes).toHaveLength(MAX_INVENTORY_ITEMS);
    expect(sink.truncated).toHaveLength(2);
    // an item already held still takes an update after the cap
    sink.add({ id: 'api:GET:/a0', kind: 'api', method: 'GET', route: '/a0', file: 'f', line: 1, input: true, label: 'x' });
    expect(sink.items.get('api:GET:/a0')!.input).toBe(true);
  });

  test('a source file over 512 KB is not read, and the inventory says which: ui-check exits 1 naming it', () => {
    const big = `package com.a;\n@Controller\npublic class Big {\n  @GetMapping("/big") public String big() { return "v"; }\n  // ${'x'.repeat(600 * 1024)}\n}\n`;
    const root = repo({ 'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n", 'src/main/java/com/a/Big.java': big });
    const inv = uiInventory(root);
    expect(inv.items).toEqual([]); // nothing was read from it
    expect(inv.truncated).toHaveLength(1);
    expect(inv.truncated![0]).toContain('src/main/java/com/a/Big.java was not read (over 512 KB');
    writeFileSync(join(root, 'a.log'), '');
    writeFileSync(join(root, 'r.json'), '{"suites":[]}');
    const r = cmdUiCheck(root, ['--log', 'a.log', '--report', 'r.json']);
    expect('out' in r && r.code).toBe(1);
    expect('out' in r && (r.out as { problems: string[] }).problems).toEqual([`the inventory is incomplete: ${inv.truncated![0]}`]);
    // a file that is gone between the listing and the read is no loss
    expect(uiInventory(repo({ 'package.json': '{"name":"x"}' })).truncated).toBeUndefined();
  });

  test('controllers in packages named vendor, plugin, lib, test, spec or e2e are in the inventory', () => {
    const ctl = (pkg: string, name: string, path: string) => `package com.acme.${pkg};\n@Controller\npublic class ${name} {\n  @GetMapping("${path}") public String m() { return "v"; }\n}\n`;
    const root = repo({
      'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n",
      'src/main/java/com/acme/vendor/VendorController.java': ctl('vendor', 'VendorController', '/vendors'),
      'src/main/java/com/acme/webapp/plugin/PluginController.java': ctl('webapp.plugin', 'PluginController', '/plugins'),
      'src/main/java/com/acme/assets/lib/AssetController.java': ctl('assets.lib', 'AssetController', '/assets'),
      'src/main/java/com/acme/test/TestController.java': ctl('test', 'TestController', '/tests'),
      'src/main/java/com/acme/spec/SpecController.java': ctl('spec', 'SpecController', '/specs'),
      'src/main/java/com/acme/e2e/E2eController.java': ctl('e2e', 'E2eController', '/e2e'),
      'src/main/webapp/lib/orders.jsp': '<a href="/vendors">v</a>\n',
    });
    const inv = uiInventory(root);
    expect(inv.items.map((i) => i.id)).toEqual(expect.arrayContaining(['screen:GET:/vendors', 'screen:GET:/plugins', 'screen:GET:/assets', 'screen:GET:/tests', 'screen:GET:/specs', 'screen:GET:/e2e', 'link:GET:/vendors']));
    expect(inv.truncated).toBeUndefined();
  });

  test('source files left out as tests, build output or vendored code are counted in a note', () => {
    const root = repo({
      'package.json': '{"name":"x"}',
      'src/a.js': 'module.exports = 1;\n',
      'src/a.test.js': 'test();\n',
      'test/unit/b.js': 'x;\n',
      'build/c.js': 'y;\n',
      'node_modules/d/index.js': 'z;\n',
    });
    const note = uiInventory(root).notes.find((n) => n.startsWith('source files left out of the inventory'))!;
    expect(note).toContain('2 as test code (for example src/a.test.js)');
    expect(note).toContain('1 as build output (for example build/c.js)');
    expect(note).not.toContain('node_modules'); // dependencies are never the project's: not counted
  });

  test('no git repository: the inventory is incomplete, and ui-check fails instead of passing on nothing', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfb-nogit-')));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'a.log'), '');
    writeFileSync(join(dir, 'r.json'), '{"suites":[]}');
    const inv = uiInventory(dir);
    expect(inv.items).toEqual([]);
    expect(inv.truncated?.[0]).toContain('not a git repository');
    const r = cmdUiCheck(dir, ['--log', 'a.log', '--report', 'r.json']);
    expect('out' in r && r.code).toBe(1);
    expect('out' in r && (r.out as { problems: string[] }).problems[0]).toContain('the inventory is incomplete: the project is not a git repository');
    expect('out' in r && (r.out as { notes: string[] }).notes[0]).toContain('not a git repository');
  });

  test('a project with no UI source says so (noUi), a project with templates but no items does not', () => {
    expect(uiInventory(repo({ 'package.json': '{"name":"x"}', 'README.md': 'x' })).noUi).toBe(true);
    expect(uiInventory(repo({ 'build.gradle': 'x', 'src/main/java/A.java': 'class A {}\n' })).noUi).toBe(true);
    expect(uiInventory(repo({ 'build.gradle': 'x', 'src/main/resources/templates/a.html': '<p>hi</p>\n' })).noUi).toBeUndefined();
    expect(uiInventory(repo({ 'package.json': '{"name":"x"}', 'src/a.js': 'const x = 1;\n' })).noUi).toBeUndefined();
    expect(uiInventory(repo({ 'package.json': '{"name":"x"}', 'src/a.js': 'const x = 1;\n' })).items).toEqual([]);
  });

  test('every Spring mapping the reader cannot resolve makes the inventory incomplete: a long constant, an unknown one', () => {
    const big = `${'/x'.repeat(2100)}`; // over 4096 characters
    const root = repo({
      'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n",
      'src/main/java/com/acme/C.java': `package com.acme;\n@RestController\npublic class C {\n  static final String BIG = "${big}";\n  @GetMapping(BIG) public String a() { return "a"; }\n  @GetMapping(Elsewhere.PATH) public String b() { return "b"; }\n  @GetMapping("/ok") public String c() { return "c"; }\n}\n`,
    });
    const inv = uiInventory(root);
    expect(inv.items.map((i) => i.id)).toEqual(['api:GET:/ok']);
    expect(inv.truncated).toHaveLength(2);
    expect(inv.truncated!.every((t) => t.includes('src/main/java/com/acme/C.java:') && t.includes('its routes are not listed'))).toBe(true);
    const r = uiCheck(inv, [''], ['{"suites":[]}']);
    expect(r.problems.filter((p) => p.startsWith('the inventory is incomplete: src/main/java/com/acme/C.java:'))).toHaveLength(2);
    expect(r.ok).toBe(false);
  });

  test('a web framework the inventory does not read makes it incomplete, naming the framework: ui-check exits 1', () => {
    const cases: [string, string, Record<string, string>][] = [
      ['Flask', 'app.py', { 'app.py': 'from flask import Flask\napp = Flask(__name__)\n\n@app.route("/orders")\ndef orders():\n    return "x"\n' }],
      ['Flask', 'views.py', { 'views.py': 'from flask import Blueprint\nbp = Blueprint("a", __name__)\n' }],
      ['Flask', 'api.py', { 'api.py': 'bp = None\n  @bp.route("/x", methods=["POST"])\ndef x():\n    pass\n' }],
      ['Django', 'shop/urls.py', { 'shop/urls.py': 'from django.urls import path\nurlpatterns = [path("orders/", views.orders)]\n' }],
      ['JAX-RS', 'src/main/java/com/acme/OrderResource.java', { 'src/main/java/com/acme/OrderResource.java': 'package com.acme;\n@Path("/orders")\npublic class OrderResource {\n  @GET public String list() { return "x"; }\n}\n' }],
      ['Micronaut', 'src/main/java/com/acme/C.java', { 'src/main/java/com/acme/C.java': 'import io.micronaut.http.annotation.Controller;\n@Controller("/orders")\npublic class C {}\n' }],
      ['Ktor', 'src/main/kotlin/App.kt', { 'src/main/kotlin/App.kt': 'import io.ktor.server.routing.*\nfun Application.module() { routing { get("/x") { } } }\n' }],
      ['Spring WebFlux', 'src/main/java/com/acme/Routes.java', { 'src/main/java/com/acme/Routes.java': 'import org.springframework.web.reactive.function.server.RouterFunction;\npublic class Routes { RouterFunction<?> r; }\n' }],
    ];
    for (const [name, example, files] of cases) {
      const root = repo({ 'package.json': '{"name":"x"}', ...files });
      const inv = uiInventory(root);
      expect({ name, items: inv.items, noUi: inv.noUi }).toEqual({ name, items: [], noUi: undefined });
      expect(inv.truncated).toEqual([`framework not read: ${name === 'JAX-RS' ? 'JAX-RS (Quarkus, Jersey, RESTEasy)' : name === 'Spring WebFlux' ? 'Spring WebFlux functional routes' : name} (for example ${example}): its routes are not listed`]);
      writeFileSync(join(root, 'a.log'), '');
      writeFileSync(join(root, 'r.json'), '{"suites":[]}');
      const r = cmdUiCheck(root, ['--log', 'a.log', '--report', 'r.json']);
      expect({ name, code: 'out' in r && r.code }).toEqual({ name, code: 1 });
      expect('out' in r && (r.out as { problems: string[] }).problems[0]).toContain(`framework not read: ${name}`);
    }
  });

  test('a plain Python or Java library with no web marker has no UI source: noUi, and ui-check passes', () => {
    const root = repo({
      'package.json': '{"name":"x"}',
      'lib/util.py': 'import os\n\ndef route(a, b):\n    return a + b\n\n# route( is a word here, and `@Path` in a comment only: no decorator\nx = route(1, 2)\n',
      'src/main/java/com/acme/Money.java': 'package com.acme;\npublic class Money {\n  public String path() { return "p"; }\n  public Object pathVariable(@PathVariable("id") String id) { return id; }\n}\n',
      'src/main/kotlin/Plain.kt': 'class Plain { fun routing() = 1 }\n',
    });
    const inv = uiInventory(root);
    expect(inv).toMatchObject({ items: [], noUi: true });
    expect(inv.truncated).toBeUndefined();
    writeFileSync(join(root, 'a.log'), '');
    writeFileSync(join(root, 'r.json'), '{"suites":[]}');
    const r = cmdUiCheck(root, ['--log', 'a.log', '--report', 'r.json']);
    expect('out' in r && r.code).toBe(0);
  });

  test('the supported stacks are unchanged: Spring, FastAPI and Express are read, not flagged', () => {
    const spring = uiInventory(repo({ 'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n", 'src/main/java/com/a/C.java': 'package com.a;\n@Controller\npublic class C {\n  @GetMapping("/a") public String a(@PathVariable("id") String id) { return "v"; }\n}\n' }));
    expect(spring.items.map((i) => i.id)).toEqual(['screen:GET:/a']);
    expect(spring.truncated).toBeUndefined();
    const fastapi = uiInventory(repo({ 'package.json': '{"name":"x"}', 'app.py': 'import fastapi\napp = fastapi.FastAPI()\n@app.get("/x")\ndef f():\n    return 1\n' }));
    expect(fastapi.items.map((i) => i.id)).toEqual(['api:GET:/x']);
    expect(fastapi.truncated).toBeUndefined();
    const express = uiInventory(repo({ 'package.json': '{"name":"x","dependencies":{"express":"4"}}', 'server.js': 'const express = require("express");\nconst app = express();\napp.get("/y", (q, r) => r.send("y"));\n' }));
    expect(express.items.map((i) => i.id)).toEqual(['api:GET:/y']);
    expect(express.truncated).toBeUndefined();
  });

  test('--summary shows what was cut and whether there is no UI source', () => {
    const root = repo({ 'build.gradle': 'x', 'src/main/java/A.java': 'class A {}\n' });
    const r = cmdUiInventory(root, ['--summary']);
    expect('out' in r && (r.out as { truncated: string[]; noUi: boolean })).toMatchObject({ truncated: [], noUi: true });
    const cut = repo({ 'package.json': '{"name":"x"}', 'src/big.js': `// ${'x'.repeat(600 * 1024)}\n` });
    const c = cmdUiInventory(cut, ['--summary']);
    expect('out' in c && (c.out as { truncated: string[] }).truncated[0]).toContain('src/big.js was not read');
  });

  test('a time-budget or file-limit cut counts as incomplete too', () => {
    const late = uiInventory(repo({ 'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n", 'src/main/resources/templates/a.html': '<button id="go">Go</button>\n' }), { budgetMs: -1 });
    expect(late.truncated?.[0]).toContain('time budget');
  });
});

describe('the inventory reads only js/jsx/ts/tsx/mjs/cjs as JavaScript', () => {
  test('a Vue or Svelte single-file component with a fetch, a link and a route yields no item', () => {
    const sfc = '<template>\n  <div><a href="/api/orders">orders</a><button @click="load">Load</button></div>\n</template>\n<script>\nexport default { methods: { load() { fetch("/api/orders"); } } };\nconst routes = [{ path: "/orders", component: Orders }];\n</script>\n';
    const files = {
      'package.json': JSON.stringify({ name: 'x', dependencies: { express: '4', vue: '3' } }),
      'server.js': 'const express = require("express");\nconst app = express();\napp.get("/api/orders", (req, res) => res.json([]));\n',
    };
    const base = uiInventory(repo(files));
    expect(base.items.map((i) => i.id)).toEqual(['api:GET:/api/orders']);
    for (const rel of ['src/App.vue', 'src/App.svelte', 'src/App.mts', 'src/App.cts']) {
      const inv = uiInventory(repo({ ...files, [rel]: sfc }));
      expect({ rel, ids: inv.items.map((i) => i.id) }).toEqual({ rel, ids: ['api:GET:/api/orders'] });
    }
    // the same text in a .js file is read: its fetch becomes an item
    const js = uiInventory(repo({ ...files, 'src/App.js': sfc }));
    expect(js.items.map((i) => i.id)).toEqual(expect.arrayContaining(['ajax:GET:/api/orders']));
  });
});

describe('B5: ids of route-less items are claimable whatever the file path holds', () => {
  const root = () =>
    repo({
      'src/main/resources/templates/주문 목록/list.html': '<html><body>\n<button id="del">Delete</button>\n<form id="f"><input name="q"><button type="submit">Go</button></form>\n</body></html>\n',
      'src/컴포넌트/Cancel.tsx': 'export function Cancel({ go, save }) {\n  return (<div><button onClick={go}>Cancel</button><form onSubmit={save}><input name="n"/></form></div>);\n}\n',
    });

  test('button, form, click and submit ids hold only ASCII, no space and no comma', () => {
    const items = uiInventory(root()).items;
    const wanted = items.filter((i) => /^(?:button|form|click|submit):/.test(i.id));
    expect(wanted.map((i) => i.id.split(':')[0]).sort()).toEqual(['button', 'click', 'form', 'submit']);
    for (const i of wanted) expect(i.id).toMatch(CLAIMABLE);
    for (const i of wanted) expect(i.id).not.toMatch(/[,;]/);
  });

  test('the file path stays readable in the id and is percent-encoded, the real path stays in `file`', () => {
    const items = uiInventory(root()).items;
    const del = items.find((i) => i.id.startsWith('button:') && i.id.endsWith('#del'))!;
    expect(del.id).toBe(`button:src/main/resources/templates/${encodeURIComponent('주')}${encodeURIComponent('문')}%20${encodeURIComponent('목')}${encodeURIComponent('록')}/list.html#del`);
    expect(del.file).toBe('src/main/resources/templates/주문 목록/list.html');
  });

  test('an ASCII path keeps the id it always had', () => {
    const r = repo({ 'src/main/resources/templates/orders/list.html': '<button id="del">Delete</button>\n' });
    expect(uiInventory(r).items.map((i) => i.id)).toContain('button:src/main/resources/templates/orders/list.html#del');
  });
});
