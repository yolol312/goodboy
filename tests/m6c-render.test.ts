// Track M, M6c (plan §19): what `sandbox-init` renders for the data helper: the `data` volume (written by the database
// containers, read-only in the runner and e2e containers, cleared through the reader), `GOODBOY_DATA` for the test
// containers, and the three helper files under `.goodboy/sandbox/data/`.

import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSandbox, outOfDate } from '../lib/sandbox-files';
import { dataHelperCjs, dataHelperJava, dataHelperTs } from '../lib/sandbox-data-helper';
import { SANDBOX_DIR } from '../lib/sandbox-mode';
import { planSandbox } from '../lib/sandbox-render';
import { staticProblems } from '../lib/sandbox-run';
import type { SandboxScan, SandboxStore } from '../lib/sandbox-types';
import { plainScan } from './m6a-project';

setDefaultTimeout(60_000);

const made: string[] = [];
afterAll(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const NO_DUMP = { dump: null, dumpFormat: null } as const;
type Compose = { services: Record<string, { volumes?: string[]; environment?: Record<string, string> }>; volumes: Record<string, unknown> };
const compose = (scan: SandboxScan): Compose => Bun.YAML.parse(planSandbox(scan, NO_DUMP, { readConfig: () => null }).files.get('compose.yml')!) as Compose;

const store = (kind: SandboxStore['kind'], line: number): SandboxStore => ({ kind, version: '', database: 'shop', configKeys: [], where: { file: 'application.yml', line } });

describe('the compose file', () => {
  test('the database services write the data volume, the runner and the e2e service read it only, the reader clears it', () => {
    const c = compose({ ...plainScan(), stores: [store('postgres', 3), store('mysql', 4)] });
    expect(Object.keys(c.volumes)).toContain('data');
    // every SQL service, not only the first
    for (const svc of ['db', 'db2']) expect(c.services[svc]!.volumes).toContain('data:/goodboy-data');
    for (const svc of ['runner', 'e2e']) {
      expect(c.services[svc]!.volumes).toContain('data:/goodboy-data:ro');
      expect(c.services[svc]!.volumes).not.toContain('data:/goodboy-data');
      expect(c.services[svc]!.environment!.GOODBOY_DATA).toBe('/goodboy-data/values.tsv');
    }
    expect(c.services.reader!.volumes).toContain('data:/goodboy-data');
  });

  test('no other service holds it: not the app, the proxy, the preparation steps or the probe', () => {
    const c = compose(plainScan());
    for (const [name, svc] of Object.entries(c.services)) {
      if (['db', 'runner', 'e2e', 'reader'].includes(name)) continue;
      expect([name, (svc.volumes ?? []).filter((v) => v.includes('goodboy-data'))]).toEqual([name, []]);
      expect([name, svc.environment?.GOODBOY_DATA]).toEqual([name, undefined]);
    }
  });

  test('each engine gets the mount (Postgres, MySQL, MariaDB), and the static check still passes for the whole file', () => {
    for (const kind of ['postgres', 'mysql', 'mariadb'] as const) {
      const scan = { ...plainScan(), stores: [store(kind, 3)] };
      const c = compose(scan);
      expect(c.services.db!.volumes).toContain('data:/goodboy-data');
      expect(staticProblems(c)).toEqual([]);
    }
  });

  test('a Node project gets the same mounts', () => {
    const base = plainScan();
    const node: SandboxScan = { ...base, stack: 'node', frameworks: [], build: { ...base.build, tool: 'npm', depsCommand: ['npm', 'ci'], buildCommand: ['npm', 'run', 'build'], testCommand: ['npm', 'test'], startCommand: ['node', 'server.js'], artifact: '' } };
    const c = compose(node);
    expect(c.services.runner!.volumes).toContain('data:/goodboy-data:ro');
    expect(c.services.e2e!.volumes).toContain('data:/goodboy-data:ro');
    expect(staticProblems(c)).toEqual([]);
  });

  test('a project with no test command and no app has the database and the reader mounts only', () => {
    const base = plainScan();
    const c = compose({ ...base, build: { ...base.build, testCommand: [], startCommand: [] } });
    expect(c.services.runner).toBeUndefined();
    expect(c.services.e2e).toBeUndefined();
    expect(c.services.db!.volumes).toContain('data:/goodboy-data');
  });
});

describe('the helper files', () => {
  const rendered = planSandbox(plainScan(), NO_DUMP, { readConfig: () => null }).files;

  test('sandbox-init renders the three of them under data/, the same text on every render', () => {
    expect(rendered.get('data/goodboy-data.ts')).toBe(dataHelperTs());
    expect(rendered.get('data/goodboy-data.cjs')).toBe(dataHelperCjs());
    expect(rendered.get('data/GoodboyData.java')).toBe(dataHelperJava());
    expect(planSandbox({ ...plainScan(), stack: 'node' }, NO_DUMP, { readConfig: () => null }).files.get('data/goodboy-data.cjs')).toBe(dataHelperCjs());
  });

  test('they hold no value of any database: only readers of the file named by GOODBOY_DATA', () => {
    for (const text of [dataHelperTs(), dataHelperCjs(), dataHelperJava()]) {
      expect(text).toContain('GOODBOY_DATA');
      expect(text).not.toMatch(/\bINSERT\b|jdbc:|postgres:\/\/|mysql:\/\/|psql|fetch\(|http:\/\/|https:\/\//);
    }
    // the TS helper's own example names the e2e import path of the fixture
    expect(dataHelperTs()).toContain("'../.goodboy/sandbox/data/goodboy-data'");
    expect(dataHelperJava()).toContain('src/test/java/goodboy/GoodboyData.java');
  });

  test('sandbox-init writes them into the checkout, and a second init finds them unchanged and in date', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-render-')));
    made.push(root);
    const scan = { ...plainScan(), root };
    const rep = await initSandbox(root, scan, NO_DUMP, false);
    expect(rep).not.toBeInstanceOf(Error);
    for (const [name, text] of [['goodboy-data.ts', dataHelperTs()], ['goodboy-data.cjs', dataHelperCjs()], ['GoodboyData.java', dataHelperJava()]] as const) {
      const p = join(root, SANDBOX_DIR, 'data', name);
      expect(existsSync(p)).toBe(true);
      expect(readFileSync(p, 'utf8')).toBe(text);
    }
    expect(outOfDate(root, planSandbox(scan, NO_DUMP, { root }))).toEqual([]);
    const again = (await initSandbox(root, scan, NO_DUMP, false)) as { written: string[]; unchanged: string[] };
    expect(again.written).toEqual([]);
    expect(again.unchanged).toEqual(expect.arrayContaining(['data/goodboy-data.ts', 'data/goodboy-data.cjs', 'data/GoodboyData.java']));
  });
});
