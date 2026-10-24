// Track M fix round 1, fixer B (plan §19): regression tests for the scan's shared helpers (the
// config key lookup of the renderer, the one file lister). What the scan does with its options is
// in tests/m-fix-b-scan-opts.test.ts.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configKeyAt } from '../lib/sandbox-render';
import { configEntryAt } from '../lib/sandbox-scan';
import { isBrowserAsset, listFiles, notOwnCode, notOwnReason, ownFile } from '../lib/test-survey';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfb-scan-')));
  tmpDirs.push(root);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('B3: configKeyAt reads a line the way the scan does', () => {
  test('a quoted YAML key, which the scan reads, has a key here too', () => {
    const yml = '"partner.base-url": "https://api.partner.com:8443/v2"\nplain:\n  "quoted-child": ldap://h:389/dc=a\n';
    expect(configKeyAt('application.yml', yml, 1)).toEqual({ key: 'partner.base-url', scheme: 'https', port: 8443, path: '/v2' });
    expect(configKeyAt('application.yml', yml, 3)).toEqual({ key: 'plain.quoted-child', scheme: 'ldap', port: 389, path: '/dc=a' });
  });

  test('the key and value are the scan entry on that line, in every format', () => {
    const yml = 'a:\n  b: one # note\nc: "two # kept"\n';
    expect(configEntryAt('x.yml', yml, 2)).toEqual({ key: 'a.b', value: 'one' });
    expect(configEntryAt('x.yaml', yml, 3)).toEqual({ key: 'c', value: 'two # kept' });
    expect(configEntryAt('x.properties', 'k.one = v \\\n  cont\nk.two: w\n', 1)).toEqual({ key: 'k.one', value: 'v cont' });
    expect(configEntryAt('x.properties', 'k.one = v \\\n  cont\nk.two: w\n', 3)).toEqual({ key: 'k.two', value: 'w' });
    expect(configEntryAt('.env.local', 'export SMTP_HOST="smtp.x.com"\n', 1)).toEqual({ key: 'SMTP_HOST', value: 'smtp.x.com' });
    expect(configEntryAt('prod.env', 'A_B=c\n', 1)).toEqual({ key: 'A_B', value: 'c' });
  });

  test('no key for other files, empty lines, list items and lines past the end', () => {
    expect(configEntryAt('a.json', '{"a":"b"}', 1)).toBeNull();
    expect(configEntryAt('A.java', 'String h = "a.b";', 1)).toBeNull();
    expect(configEntryAt('x.yml', 'a:\n  - b: c\n  - d\n', 2)).toBeNull();
    expect(configEntryAt('x.yml', 'a:\n  - b: c\n  - d\n', 3)).toBeNull();
    expect(configEntryAt('x.yml', 'a: b\n', 1)).toEqual({ key: 'a', value: 'b' });
    expect(configEntryAt('x.yml', 'a: b\n', 9)).toBeNull();
    expect(configEntryAt('x.yml', 'a:\n  b: c\n', 1)).toBeNull();
  });

  test('a changed text is parsed again (the one-file cache is keyed on file and text)', () => {
    expect(configEntryAt('x.yml', 'a: 1\n', 1)).toEqual({ key: 'a', value: '1' });
    expect(configEntryAt('x.yml', 'z: 2\n', 1)).toEqual({ key: 'z', value: '2' });
    expect(configEntryAt('y.properties', 'z=3\n', 1)).toEqual({ key: 'z', value: '3' });
  });

  test('a long file is parsed once for all the hosts that ask (one lookup per host used to split it again)', () => {
    const yml = Array.from({ length: 60_000 }, (_, i) => `k${i}: v${i}`).join('\n');
    const t0 = performance.now();
    for (let line = 1; line <= 60_000; line += 20) expect(configEntryAt('big.yml', yml, line)?.key).toBe(`k${line - 1}`);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe('round 2: configEntryAt keeps a few files, not one', () => {
  test('hosts in two config files, asked for in turn, parse each file once', () => {
    const file = (tag: string) => Array.from({ length: 60_000 }, (_, i) => `${tag}.k${i}: v${i}`).join('\n');
    const a = file('a');
    const b = file('b');
    const t0 = performance.now();
    for (let n = 0; n < 2000; n++) {
      // a fresh, equal string each time, as the renderer reads the file again for each host
      expect(configEntryAt('application.yml', `${a}`.slice(0), 1 + (n % 50))?.key).toBe(`a.k${n % 50}`);
      expect(configEntryAt('application-dev.yml', `${b}`.slice(0), 1 + (n % 50))?.key).toBe(`b.k${n % 50}`);
    }
    expect(performance.now() - t0).toBeLessThan(3000); // 120 parses of 60 000 lines were 30 s
  });

  test('twelve files asked for in turn are each parsed once (a cache of eight files parsed them again for every host)', () => {
    const files = Array.from({ length: 12 }, (_, f) => Array.from({ length: 20_000 }, (_, i) => `f${f}.k${i}: v${i}`).join('\n'));
    const t0 = performance.now();
    for (let n = 0; n < 1200; n++) expect(configEntryAt(`twelve-${n % 12}.yml`, files[n % 12]!.slice(0), 1 + (n % 40))?.key).toBe(`f${n % 12}.k${n % 40}`);
    expect(performance.now() - t0).toBeLessThan(2000); // 1200 parses of 20 000 lines took 10 s
  });

  test('a changed file is read again, and a file that is asked for after many others still answers', () => {
    for (let i = 0; i < 12; i++) expect(configEntryAt(`f${i}.yml`, `k${i}: v\n`, 1)?.key).toBe(`k${i}`);
    expect(configEntryAt('f0.yml', 'other: v\n', 1)?.key).toBe('other');
    expect(configEntryAt('f11.yml', 'k11: v\n', 1)?.key).toBe('k11');
  });
});

describe('B2: one file lister for the scan, the UI inventory and the coverage gate', () => {
  test('test-survey exports ownFile: config and story files are read, tests, dependencies and virtualenvs are not', () => {
    // read by the scan (a proxy target in vite.config.ts is an outbound host) though notOwnCode drops them
    expect(ownFile('web/vite.config.ts')).toBe(true);
    expect(ownFile('src/Button.stories.tsx')).toBe(true);
    expect(notOwnCode('web/vite.config.ts')).toBe(true);
    for (const rel of ['node_modules/a/b.js', 'venv/lib/python3.12/site-packages/x.py', '.venv/bin/y.py', 'app/__pycache__/m.py', 'src/test/java/A.java', 'src/a.test.ts', 'tests/helper.py', 'static/js/lib/jquery.js', 'public/vendor/x.js', 'web/app.min.js', 'types/a.d.ts', 'build/out.js', '.git/hooks/h.js']) {
      expect({ rel, own: ownFile(rel) }).toEqual({ rel, own: false });
    }
    for (const rel of ['src/main/java/com/acme/build/A.java', 'static/js/app.js', 'app.py', 'src/index.ts']) expect({ rel, own: ownFile(rel) }).toEqual({ rel, own: true });
    expect(isBrowserAsset('src/main/webapp/js/a.js')).toBe(true);
    expect(isBrowserAsset('src/a.js')).toBe(false);
  });

  test('real packages and pages are own files: vendor, lib, plugin, assets, test, spec and e2e below a JVM source root, a page in a lib dir', () => {
    for (const rel of [
      'src/main/java/com/acme/webapp/plugin/PluginController.java',
      'src/main/java/com/acme/assets/lib/AssetController.java',
      'src/main/java/com/acme/vendor/VendorController.java',
      'src/main/webapp/lib/orders.jsp',
      'src/main/java/com/acme/test/TestController.java',
      'src/main/java/com/acme/spec/SpecController.java',
      'src/main/java/com/acme/e2e/E2eController.java',
      'com/acme/test/TestController.java',
      'com/acme/spec/SpecController.java',
      'com/acme/e2e/E2eController.java',
      'src/main/kotlin/com/acme/vendors/VendorsController.kt',
      'src/main/resources/templates/vendor/list.html',
    ]) expect({ rel, own: ownFile(rel), why: notOwnReason(rel) }).toEqual({ rel, own: true, why: null });
  });

  test('and the unambiguous places are still left out, with the reason', () => {
    const why: Record<string, string> = {
      'node_modules/a/b.js': 'dependency and tool dirs',
      'src/main/resources/META-INF/resources/webjars/x/y.js': 'dependency and tool dirs',
      'build/out.js': 'build output',
      'vendor/jquery/jquery.js': 'vendored code',
      'third_party/x.py': 'vendored code',
      'src/main/resources/static/lib/jquery.js': 'a library under a static web root',
      'public/plugins/fancy.css': 'a library under a static web root',
      'web/app.min.js': 'minified and declaration files',
      'src/test/java/com/acme/FooControllerTest.java': 'test code',
      'test/unit/a.js': 'test code',
      'web/e2e/login.ts': 'test code',
      'src/__tests__/a.tsx': 'test code',
      'src/a.spec.ts': 'test code',
      'src/integrationTest/java/com/acme/A.java': 'test code',
    };
    for (const [rel, reason] of Object.entries(why)) expect({ rel, why: notOwnReason(rel) }).toEqual({ rel, why: reason });
  });

  test('listFiles is the one `git ls-files` of the project, sorted', () => {
    const root = repo({ 'b.txt': '1', 'a/z.txt': '2', 'a/y.txt': '3' });
    expect(listFiles(root)).toEqual(['a/y.txt', 'a/z.txt', 'b.txt']);
    expect(listFiles(join(root, 'a'))).not.toBeNull();
  });
});
