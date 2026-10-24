// Track M fix rounds 1 and 2: the paths of the scan, the UI inventory and the UI check that no other
// test runs in this process (the perf cases and the CLI tests run them in a child process, which the
// coverage tool does not measure).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configEntryAt, scanSandbox } from '../lib/sandbox-scan';
import { uiCheck } from '../lib/ui-check';
import { uiInventory } from '../lib/ui-inventory';
import { jsCalls } from '../lib/ui-templates';
import type { UiInventory } from '../lib/ui-types';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mgap-')));
  tmpDirs.push(root);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('the scan reads a JSON config file and the kind of a bare host literal', () => {
  const PKG = JSON.stringify({ name: 'x', scripts: { start: 'node src/a.js' }, dependencies: {} });

  test('a host in config/default.json is found at the line of its key, and read by the code that names its key', () => {
    const root = repo({
      'package.json': PKG,
      'config/default.json': '{\n  "partner": {\n    "base-url": "https://api.partner.example/v2"\n  },\n  "port": 3000\n}\n',
      'src/a.js': "const cfg = require('config');\nconst u = cfg.get('base-url');\nfetch(u);\n",
    });
    const hit = scanSandbox(root).outbound.find((o) => o.host === 'api.partner.example');
    expect(hit).toMatchObject({ scheme: 'https', hardcoded: false, where: { file: 'config/default.json', line: 3 }, callSite: { file: 'src/a.js' } });
  });

  test('a JSON config that is not JSON gives no host and the scan asks about it', () => {
    const root = repo({ 'package.json': PKG, 'config/default.json': '{ "partner": "https://api.partner.example"', 'src/a.js': 'fetch(1);\n' });
    const scan = scanSandbox(root);
    expect(scan.outbound.some((o) => o.host === 'api.partner.example')).toBe(false);
    expect(scan.questions).toContain('config/default.json: 1 line(s) could not be parsed; values from it may be missing');
  });

  test('a bare IP address in code takes the kind of the one call its file makes', () => {
    const root = repo({ 'package.json': PKG, 'src/a.js': "const host = '10.1.2.3';\nfetch(host + '/x');\n" });
    expect(scanSandbox(root).outbound.find((o) => o.host === '10.1.2.3')).toMatchObject({ kind: 'http', hardcoded: true, ipLiteral: true, where: { file: 'src/a.js', line: 1 } });
  });
});

describe('the config cache holds a bounded amount', () => {
  test('files that together cost more than the bound push the oldest out: the oldest is parsed again, the newest is not', () => {
    // 200 bytes are counted per entry plus the text: a file of 190 000 entries costs about 41 MB, so two fit in the
    //   104.9 MB bound and the third pushes the first out. A parse takes tens of milliseconds, a cached answer
    //   microseconds, so what was kept is told by the time of asking again.
    const file = (tag: string) => Array.from({ length: 190_000 }, (_, i) => `${tag}.k${i}: v`).join('\n');
    const a = file('a');
    const b = file('b');
    const c = file('c');
    const timed = (name: string, text: string, line: number, key: string): number => {
      const t0 = performance.now();
      expect(configEntryAt(name, text, line)?.key).toBe(key);
      return performance.now() - t0;
    };
    const parseA = timed('cache-a.yml', a, 1, 'a.k0');
    timed('cache-b.yml', b, 2, 'b.k1');
    // control: with two files in, the first is still kept
    const keptA = timed('cache-a.yml', a, 3, 'a.k2');
    expect(keptA).toBeLessThan(parseA / 4);
    timed('cache-c.yml', c, 4, 'c.k3');
    const newestC = timed('cache-c.yml', c, 5, 'c.k4');
    const evictedB = timed('cache-b.yml', b, 6, 'b.k5');
    expect(newestC).toBeLessThan(parseA / 4);
    expect(evictedB).toBeGreaterThan(parseA / 4);
  }, 60_000);
});

describe('the UI check reads an access log line that is not JSON', () => {
  const inv: UiInventory = { root: '.', contextPath: '/', notes: [], items: [] };

  test('a line that opens an object but is not JSON is a problem naming the log and the line', () => {
    const r = uiCheck(inv, ['{"request": {}, "status": 200}\n{"request": nope\n'], []);
    expect(r.problems).toContain('access log:2 is not JSON');
    expect(r.ok).toBe(false);
  });
});

describe('xhr.open is read as an ajax call', () => {
  test('a verb and a url make one call; an unknown verb or no url make none', () => {
    expect(jsCalls("var x = new XMLHttpRequest(); x.open('POST', '/orders/save');")).toEqual([{ sub: 'ajax', method: 'POST', expr: "'/orders/save'", pos: expect.any(Number) }]);
    expect(jsCalls("x.open('FETCH', '/a');")).toEqual([]);
    expect(jsCalls("x.open('GET');")).toEqual([]);
  });
});

describe('the inventory stops at the size of source text it reads', () => {
  test('more than 64 MB of templates: the rest is left out and the inventory says so', () => {
    const files: Record<string, string> = {};
    const filler = 'a'.repeat(500_000);
    const button = '<button id="go">Go</button>\n';
    for (let i = 0; i < 135; i++) files[`src/main/resources/templates/t${String(i).padStart(3, '0')}.html`] = i === 0 || i === 134 ? button + filler : filler;
    const inv = uiInventory(repo(files));
    expect((inv.truncated ?? []).some((n) => n.includes('more source text than the inventory reads'))).toBe(true);
    // the first file is read, the last (past the 64 MB) is not
    const ids = inv.items.map((i) => i.id);
    expect(ids.some((id) => id.includes('t000.html#go'))).toBe(true);
    expect(ids.some((id) => id.includes('t134.html#go'))).toBe(false);
  }, 120_000);
});
