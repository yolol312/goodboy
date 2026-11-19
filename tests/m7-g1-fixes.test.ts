// Track M, M7 full review, group G1 (sandbox setup): store image tags, the store order, and the
// fail-closed reading of raw run files. Each test fails on the code before the fix.

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mysqlScripts } from '../lib/sandbox-parts';
import { planSandbox } from '../lib/sandbox-render';
import { rawMayRemain } from '../lib/sandbox-mode';
import { scanSandbox, STORE_DEFAULT_VERSION, storeTagVersion } from '../lib/sandbox-scan';
import type { SandboxScan, SandboxStore } from '../lib/sandbox-types';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      chmodSync(d, 0o755);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g1-')));
  tmpDirs.push(root);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const BUILD = "plugins { id 'org.springframework.boot' version '3.2.0' }\n";
const YML = 'src/main/resources/application.yml';

const where = { file: YML, line: 3 };
const store = (kind: SandboxStore['kind'], version: string): SandboxStore => ({ kind, version, database: 'shop', configKeys: [], where });

function scanWith(stores: SandboxStore[]): SandboxScan {
  return {
    root: '/nonexistent/repo',
    stack: 'node',
    frameworks: [],
    build: { tool: 'npm', runtimeVersion: '20', depsCommand: ['npm', 'ci'], buildCommand: [], testCommand: ['npm', 'test'], startCommand: ['node', 'a.js'], artifact: null },
    app: { port: 3000, contextPath: '/', healthPath: '/', configFiles: [] },
    stores,
    outbound: [],
    secretKeys: [],
    questions: [],
    problems: [],
  } as SandboxScan;
}

const images = (stores: SandboxStore[]): { image: string; notes: string[] } => {
  const plan = planSandbox(scanWith(stores), { dump: null, dumpFormat: null }, { readConfig: () => null });
  const c = Bun.YAML.parse(plan.files.get('compose.yml')!) as { services: Record<string, { image: string }> };
  const first = stores[0]!.kind;
  const svc = first === 'redis' ? 'redis' : first === 'mongo' ? 'mongo' : 'db';
  return { image: c.services[svc]!.image, notes: plan.notes };
};

describe('G1-1: a suffixed store image tag keeps its version', () => {
  test('storeTagVersion reads the leading version and nothing else', () => {
    expect(storeTagVersion('17-alpine')).toBe('17');
    expect(storeTagVersion('8.4-oracle')).toBe('8.4');
    expect(storeTagVersion('16.2')).toBe('16.2');
    expect(storeTagVersion('7.2.4-alpine')).toBe('7.2.4');
    for (const odd of ['alpine', 'bookworm', 'lts', 'latest', '', 'v16']) expect({ odd, v: storeTagVersion(odd) }).toEqual({ odd, v: null });
  });

  test('the scan reads `postgres:17-alpine` and `mysql:8.4-oracle` from a compose file as 17 and 8.4', () => {
    const pg = scanSandbox(
      repo({
        'build.gradle': BUILD,
        'docker-compose.yml': 'services:\n  db:\n    image: postgres:17-alpine\n',
        [YML]: 'spring:\n  datasource:\n    url: jdbc:postgresql://h.example.org:5432/shop\n',
      }),
    );
    expect(pg.stores[0]).toMatchObject({ kind: 'postgres', version: '17' });
    expect(pg.questions.some((q) => q.startsWith('postgres: '))).toBe(false);
    const my = scanSandbox(
      repo({
        'build.gradle': BUILD,
        'docker-compose.yml': 'services:\n  db:\n    image: mysql:8.4-oracle\n',
        [YML]: 'spring:\n  datasource:\n    url: jdbc:mysql://h.example.org:3306/shop\n',
      }),
    );
    expect(my.stores[0]).toMatchObject({ kind: 'mysql', version: '8.4' });
  });

  test('a tag that names no version is a question that names the tag, and the default is used', () => {
    const scan = scanSandbox(
      repo({
        'build.gradle': BUILD,
        'docker-compose.yml': 'services:\n  db:\n    image: postgres:bookworm\n',
        [YML]: 'spring:\n  datasource:\n    url: jdbc:postgresql://h.example.org:5432/shop\n',
      }),
    );
    expect(scan.stores[0]).toMatchObject({ kind: 'postgres', version: STORE_DEFAULT_VERSION.postgres });
    const q = scan.questions.find((x) => x.startsWith('postgres: '));
    expect(q).toContain('`bookworm` names no version');
    expect(q).toContain(`default ${STORE_DEFAULT_VERSION.postgres}`);
  });

  test('the renderer keeps the major of a suffixed tag in the image', () => {
    expect(images([store('postgres', '17-alpine')]).image).toBe('postgres:17-alpine');
    expect(images([store('postgres', '15.4-bookworm')]).image).toBe('postgres:15.4-alpine');
    expect(images([store('mysql', '8.4-oracle')]).image).toBe('mysql:8.4');
    expect(images([store('mariadb', '10.11-jammy')]).image).toBe('mariadb:10.11');
    expect(images([store('redis', '6.2-alpine')]).image).toBe('redis:6.2-alpine');
    expect(images([store('mongo', '6-jammy')]).image).toBe('mongo:6');
  });

  test('a tag the renderer cannot map is a note, not silence; latest and no tag stay quiet', () => {
    const odd = images([store('postgres', 'bookworm')]);
    expect(odd.image).toBe(`postgres:${STORE_DEFAULT_VERSION.postgres}-alpine`);
    expect(odd.notes.some((n) => n.includes('`bookworm` names no version') && n.includes(`${where.file}:3`))).toBe(true);
    for (const quiet of ['latest', '']) expect(images([store('mysql', quiet)]).notes.filter((n) => n.includes('names no version'))).toEqual([]);
  });

  test('the scan default and the renderer default are one table (MySQL 8.4)', () => {
    expect(STORE_DEFAULT_VERSION.mysql).toBe('8.4');
    expect(images([store('mysql', '')]).image).toBe('mysql:8.4');
    const scan = scanSandbox(repo({ 'build.gradle': BUILD, [YML]: 'spring:\n  datasource:\n    url: jdbc:mysql://h.example.org:3306/shop\n' }));
    expect(scan.stores[0]!.version).toBe('8.4');
    expect(images([scan.stores[0]!]).image).toBe('mysql:8.4');
  });
});

describe('G1-2: the stores have one order, whatever the order they were found in', () => {
  test('the first SQL store is the one in the file that sorts first, not the one with the smaller line', () => {
    // `application.yml` sorts before `bootstrap.yml`; the store in the later file has the smaller line
    const BOOT = 'src/main/resources/bootstrap.yml';
    const scan = scanSandbox(
      repo({
        'build.gradle': BUILD,
        [YML]: 'x: 1\nx2: 2\nx3: 3\nx4: 4\nreplica:\n  url: jdbc:postgresql://two.example.org:5432/two\n',
        [BOOT]: 'primary:\n  url: jdbc:postgresql://one.example.org:5432/one\n',
      }),
    );
    expect(scan.stores.map((s) => `${s.where.file}:${s.where.line}`)).toEqual([`${YML}:6`, `${BOOT}:2`]);
  });
});

describe('G1 low: the questions say what goodboy did not read', () => {
  test('a store that only a driver names says that a db.* or database.* prefix is not inferred', () => {
    const scan = scanSandbox(
      repo({
        'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node a.js' }, dependencies: { pg: '8.0.0' } }),
        '.env': 'DB_HOST=db.example.org\n',
        'a.js': 'module.exports = 1;\n',
      }),
    );
    const q = scan.questions.find((x) => x.startsWith('postgres: a driver or client is a dependency'));
    expect(q).toContain('goodboy found no connection config for it');
    expect(q).toContain('`db.*` or `database.*` prefix alone is not inferred');
    expect(q).not.toContain('no connection config was found');
  });

  test('a Node app with no health route says goodboy did not find one, not that the app has none', () => {
    const scan = scanSandbox(repo({ 'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node a.js' }, dependencies: {} }), 'a.js': "require('node:http').createServer((req, res) => res.end(req.url === '/health' ? 'ok' : 'hi')).listen(3000);\n" }));
    const q = scan.questions.find((x) => x.startsWith('no health route found'));
    expect(q).toContain('goodboy found no');
    expect(q).toContain('node:http');
    expect(q).not.toContain('no /health handler');
  });
});

describe('G1 low: raw files fail closed', () => {
  const outOf = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7g1-raw-')));
    tmpDirs.push(root);
    return root;
  };

  test('a refused result.json (a link) counts as raw; a clean one does not', () => {
    const root = outOf();
    const run = join(root, '.goodboy/sandbox/out/20261101T000000Z');
    mkdirSync(run, { recursive: true });
    const real = join(root, 'elsewhere.json');
    writeFileSync(real, '{"realData":false}');
    symlinkSync(real, join(run, 'result.json'));
    expect(rawMayRemain(root)).toBe(true);
    rmSync(join(run, 'result.json'));
    writeFileSync(join(run, 'result.json'), '{"realData":false}');
    expect(rawMayRemain(root)).toBe(false);
  });

  test('an out dir that cannot be listed counts as raw; no out dir does not', () => {
    const root = outOf();
    expect(rawMayRemain(root)).toBe(false);
    const sandbox = join(root, '.goodboy/sandbox');
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, 'out'), 'not a dir'); // readdir fails with ENOTDIR
    expect(rawMayRemain(root)).toBe(true);
  });
});

describe('G1 low: the MySQL restore keeps the client output off the host', () => {
  test('the dump is fed to the client with stdout to /dev/null, like the Postgres path', () => {
    for (const kind of ['mysql', 'mariadb'] as const) {
      const restore = mysqlScripts({ store: store(kind, '8.4'), svc: 'db', name: 'shop', v: '8.4', port: 3306 }, true).restore;
      expect(restore).toContain('< /dump/dump.sql >/dev/null 2>"$ERR"');
    }
  });
});
