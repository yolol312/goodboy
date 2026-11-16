// Track M, M6b (plan §19): the user-level registry of real-data sandboxes (lib/sandbox-registry.ts), who writes it (the
// sandbox commands) and the plain `local.json` they write once a project is known to hold no real data.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { addInputs, writeLocal } from '../lib/sandbox-files';
import { LOCAL_FILE, projectName, SANDBOX_DIR } from '../lib/sandbox-mode';
import { readRegistry, REGISTRY_MAX, REGISTRY_MAX_PATHS, type RegistryEntry, RegistryError, registerRealData, registryDir, registryEntryOf, registryFile } from '../lib/sandbox-registry';
import { cleanupFakeProjects, fakeProject } from './m6a-project';
import { put } from './m6b-helpers';

setDefaultTimeout(120_000);
const dirs: string[] = [];
const saved = { home: process.env.HOME, registry: process.env.GOODBOY_REGISTRY_DIR };
afterEach(() => {
  for (const [k, v] of [['HOME', saved.home], ['GOODBOY_REGISTRY_DIR', saved.registry]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupFakeProjects();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-reg-')));
  dirs.push(d);
  return d;
};
const entry = (n: number, extra: Partial<RegistryEntry> = {}): RegistryEntry => {
  const e = { top: `/projects/p${n}`, project: `gb-p${n}-abcdef`, dump: null, inputs: [], ...extra };
  return { paths: [...(e.dump !== null ? [e.dump] : []), ...e.inputs], dirs: [], ...e };
};
const envOf = (dir: string): NodeJS.ProcessEnv => ({ GOODBOY_REGISTRY_DIR: dir });

describe('the registry file', () => {
  test('its place: GOODBOY_REGISTRY_DIR, else <HOME>/.claude/goodboy/sandbox/real-data.json (HOME as the inbox reads it)', () => {
    expect(registryDir({ GOODBOY_REGISTRY_DIR: '/x/reg' })).toBe('/x/reg');
    expect(registryFile({ GOODBOY_REGISTRY_DIR: '/x/reg' })).toBe('/x/reg/real-data.json');
    expect(registryFile({ HOME: ' /home/u ' })).toBe('/home/u/.claude/goodboy/sandbox/real-data.json');
    expect(registryDir({ HOME: '' })).toBe(join(homedir(), '.claude', 'goodboy', 'sandbox'));
    expect(registryDir({})).toBe(join(homedir(), '.claude', 'goodboy', 'sandbox'));
  });

  test('no file is no entries; entries are added, updated by their top, and the file is mode 0600 in a 0700 dir', () => {
    const dir = join(tmp(), 'nested', 'reg');
    const env = envOf(dir);
    expect(readRegistry(env)).toEqual([]);
    expect(registerRealData(entry(1), env)).toBeNull();
    expect(registerRealData(entry(2, { dump: '/d/x.sql', inputs: ['/l/a.log'] }), env)).toBeNull();
    expect(readRegistry(env)).toEqual([entry(1), entry(2, { dump: '/d/x.sql', inputs: ['/l/a.log'] })]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(registryFile(env)).mode & 0o777).toBe(0o600);
    // the same top is updated in place, never added twice
    expect(registerRealData(entry(1, { dump: '/d/y.sql' }), env)).toBeNull();
    expect(readRegistry(env)).toEqual([entry(1, { dump: '/d/y.sql' }), entry(2, { dump: '/d/x.sql', inputs: ['/l/a.log'] })]);
  });

  test('nothing is written when nothing changed', () => {
    const env = envOf(tmp());
    expect(registerRealData(entry(1), env)).toBeNull();
    const before = statSync(registryFile(env)).mtimeMs;
    const text = readFileSync(registryFile(env), 'utf8');
    for (let i = 0; i < 3; i++) expect(registerRealData(entry(1), env)).toBeNull();
    expect(readFileSync(registryFile(env), 'utf8')).toBe(text);
    expect(statSync(registryFile(env)).mtimeMs).toBe(before);
  });

  test('at most 100 entries: a full registry refuses a new one with an error and drops none; an entry already there still updates', () => {
    const env = envOf(tmp());
    for (let i = 0; i < REGISTRY_MAX; i++) expect(registerRealData(entry(i), env)).toBeNull();
    const before = readFileSync(registryFile(env), 'utf8');
    const err = registerRealData(entry(REGISTRY_MAX), env);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err!.code).toBe('full');
    expect(err!.message).toContain('is full (100 projects)');
    expect(err!.message).toContain('never drops an entry');
    expect(readFileSync(registryFile(env), 'utf8')).toBe(before);
    expect((readRegistry(env) as RegistryEntry[]).map((e) => e.top)).toEqual(Array.from({ length: REGISTRY_MAX }, (_, i) => `/projects/p${i}`));
    expect(registerRealData(entry(7, { dump: '/d/new.sql' }), env)).toBeNull();
    expect((readRegistry(env) as RegistryEntry[])[7]!.dump).toBe('/d/new.sql');
  });

  test('a file that is not what goodboy wrote is an Error, and nothing is added to it', () => {
    const bads: [string, string][] = [
      ['not json', '{no'],
      ['a wrong schema', JSON.stringify({ schema: 2, entries: [] })],
      ['entries not a list', JSON.stringify({ schema: 1, entries: {} })],
      ['a relative top', JSON.stringify({ schema: 1, entries: [{ top: 'p', project: 'gb-p-abc', dump: null, inputs: [] }] })],
      ['a project name that is no sandbox\'s', JSON.stringify({ schema: 1, entries: [{ top: '/p', project: 'x', dump: null, inputs: [] }] })],
      ['a relative dump', JSON.stringify({ schema: 1, entries: [{ top: '/p', project: 'gb-p-abc', dump: 'd.sql', inputs: [] }] })],
      ['a relative input', JSON.stringify({ schema: 1, entries: [{ top: '/p', project: 'gb-p-abc', dump: null, inputs: ['a.log'] }] })],
      ['more than 100 entries', JSON.stringify({ schema: 1, entries: Array.from({ length: 101 }, (_, i) => entry(i)) })],
      ['more than 10000 inputs', JSON.stringify({ schema: 1, entries: [entry(1, { inputs: Array.from({ length: 10_001 }, (_, i) => `/l/${i}`) })] })],
      ['more than 200 paths', JSON.stringify({ schema: 1, entries: [entry(1, { paths: Array.from({ length: 201 }, (_, i) => `/l/${i}`) })] })],
      ['a relative path', JSON.stringify({ schema: 1, entries: [entry(1, { paths: ['l/a.log'] })] })],
      ['an entry without paths and dirs (a file of before)', JSON.stringify({ schema: 1, entries: [{ top: '/p', project: 'gb-p-abc', dump: null, inputs: [] }] })],
    ];
    for (const [name, text] of bads) {
      const dir = tmp();
      put(join(dir, 'real-data.json'), text);
      const env = envOf(dir);
      expect([name, readRegistry(env) instanceof Error]).toEqual([name, true]);
      expect([name, registerRealData(entry(1), env) instanceof Error]).toEqual([name, true]);
      expect(readFileSync(join(dir, 'real-data.json'), 'utf8')).toBe(text);
    }
  });

  test('a link or a directory in the file\'s place is an Error, and a link is not written through', () => {
    const dir = tmp();
    const victim = put(join(tmp(), 'victim.json'), 'untouched');
    symlinkSync(victim, join(dir, 'real-data.json'));
    expect(readRegistry(envOf(dir))).toBeInstanceOf(Error);
    expect(registerRealData(entry(1), envOf(dir))).toBeInstanceOf(Error);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(lstatSync(join(dir, 'real-data.json')).isSymbolicLink()).toBe(true);
    const dir2 = tmp();
    mkdirSync(join(dir2, 'real-data.json'));
    expect(readRegistry(envOf(dir2))).toBeInstanceOf(Error);
  });

  test('registryEntryOf: the real path, the project name, the dump, a copy of the inputs, and every path as typed and as resolved', () => {
    const root = tmp();
    const inputs = ['/l/a.log'];
    const e = registryEntryOf(root, { dump: '/d/x.sql', dumpFormat: 'sql', realData: true, inputs });
    expect(e).toEqual({ top: realpathSync(root), project: projectName(root), dump: '/d/x.sql', inputs: ['/l/a.log'], paths: ['/d/x.sql', '/l/a.log'], dirs: [] });
    inputs.push('/l/b.log');
    expect(e.inputs).toEqual(['/l/a.log']);
    expect(registryEntryOf(root, { dump: null, dumpFormat: null }).inputs).toEqual([]);
  });

  test('registryEntryOf: a link is kept by its own name and by its target, a directory is told from a file', () => {
    const d = tmp();
    const real = join(d, 'real-logs');
    mkdirSync(real);
    const file = put(join(d, 'dump.sql'), 'SELECT 1;');
    const link = join(d, 'logs-link');
    symlinkSync(real, link);
    const e = registryEntryOf(d, { dump: file, dumpFormat: 'sql', realData: true, inputs: [link] });
    expect(e.paths.sort()).toEqual([file, link, real].sort());
    expect(e.dirs.sort()).toEqual([link, real].sort());
  });

  test('registryEntryOf: paths are stored NFC-normalized (a Korean name typed as NFD is the same file)', () => {
    const d = tmp();
    const nfd = join(d, '로그'.normalize('NFD'), 'a.log');
    const e = registryEntryOf(d, { dump: null, dumpFormat: null, realData: true, inputs: [nfd] });
    expect(e.paths).toEqual([join(d, '로그'.normalize('NFC'), 'a.log')]);
    expect(e.inputs).toEqual([nfd]);
  });
});

describe('an entry never loses a path', () => {
  test('a later write merges: the paths and inputs of both stay, the last dump wins, a write with no dump keeps the old one', () => {
    const env = envOf(tmp());
    expect(registerRealData(entry(1, { dump: '/d/x.sql', inputs: ['/l/a.log'] }), env)).toBeNull();
    expect(registerRealData(entry(1, { dump: '/d/y.sql', inputs: ['/l/b.log'], dirs: ['/l/b.log'] }), env)).toBeNull();
    expect(readRegistry(env)).toEqual([entry(1, { dump: '/d/y.sql', inputs: ['/l/a.log', '/l/b.log'], paths: ['/d/x.sql', '/l/a.log', '/d/y.sql', '/l/b.log'], dirs: ['/l/b.log'] })]);
    expect(registerRealData(entry(1, { dump: null }), env)).toBeNull();
    const [e] = readRegistry(env) as RegistryEntry[];
    expect(e!.dump).toBe('/d/y.sql');
    expect(e!.paths).toEqual(['/d/x.sql', '/l/a.log', '/d/y.sql', '/l/b.log']);
  });

  test('a write that adds nothing leaves the file as it was; the same write twice is one entry', () => {
    const env = envOf(tmp());
    registerRealData(entry(1, { dump: '/d/x.sql', inputs: ['/l/a.log'] }), env);
    const text = readFileSync(registryFile(env), 'utf8');
    expect(registerRealData(entry(1, { dump: '/d/x.sql', inputs: ['/l/a.log'] }), env)).toBeNull();
    expect(registerRealData(entry(1, { dump: null, inputs: ['/l/a.log'], paths: ['/l/a.log'] }), env)).toBeNull();
    expect(readFileSync(registryFile(env), 'utf8')).toBe(text);
  });

  test('past 200 paths for a project a write is refused with its own code, and none is dropped', () => {
    const env = envOf(tmp());
    const many = (from: number, n: number): string[] => Array.from({ length: n }, (_, i) => `/l/${from + i}.log`);
    expect(registerRealData(entry(1, { inputs: many(0, REGISTRY_MAX_PATHS) }), env)).toBeNull();
    const before = readFileSync(registryFile(env), 'utf8');
    const err = registerRealData(entry(1, { inputs: many(REGISTRY_MAX_PATHS, 1) }), env);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err!.code).toBe('too-many-paths');
    expect(err!.message).toContain('never drops a path');
    expect(readFileSync(registryFile(env), 'utf8')).toBe(before);
    // a path already there is no new path
    expect(registerRealData(entry(1, { inputs: many(5, 1) }), env)).toBeNull();
  });

  test('codes: unreadable for a file that is not the registry, busy for a lock that stays, write-failed for a dir that cannot be made', () => {
    const bad = tmp();
    put(join(bad, 'real-data.json'), '{no');
    expect((registerRealData(entry(1), envOf(bad)) as RegistryError).code).toBe('unreadable');
    expect((readRegistry(envOf(bad)) as RegistryError).code).toBe('unreadable');
    const blocked = put(join(tmp(), 'a-file'), 'x');
    expect((registerRealData(entry(1), envOf(join(blocked, 'reg'))) as RegistryError).code).toBe('write-failed');
  });

  test('a lock held by another command makes the writer wait and then say busy; a stale lock is taken over', () => {
    const dir = tmp();
    const env = envOf(dir);
    const lock = put(join(dir, 'real-data.lock'), '1\n');
    const t0 = Date.now();
    const err = registerRealData(entry(1), env);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err!.code).toBe('busy');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(existsSync(registryFile(env))).toBe(false);
    // the same lock, 30 s old: taken over
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    expect(registerRealData(entry(1), env)).toBeNull();
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir).filter((n) => n.includes('.stale.') || n.endsWith('.lock'))).toEqual([]);
    expect((readRegistry(env) as RegistryEntry[]).length).toBe(1);
  });

  test('writers in two processes at once never drop each other\'s entry', async () => {
    const dir = tmp();
    const script = (from: number): string => `import { registerRealData } from ${JSON.stringify(join(import.meta.dir, '..', 'lib', 'sandbox-registry'))};
for (let i = ${from}; i < ${from + 15}; i++) { const e = registerRealData({ top: '/projects/p' + i, project: 'gb-p' + i + '-abcdef', dump: null, inputs: [], paths: [], dirs: [] }); if (e) { console.error(e.code); process.exit(1); } }`;
    const run = (from: number) => Bun.spawn(['bun', '-e', script(from)], { env: { ...process.env, GOODBOY_REGISTRY_DIR: dir }, stdout: 'pipe', stderr: 'pipe' });
    const [a, b] = [run(0), run(100)];
    expect([await a.exited, await b.exited]).toEqual([0, 0]);
    expect((readRegistry(envOf(dir)) as RegistryEntry[]).length).toBe(30);
  });
});

describe('who writes it', () => {
  const logs = (): string => {
    const d = tmp();
    process.env.HOME = d;
    return d;
  };

  test('sandbox-local --dump and --input put the project in it, with the dump and the inputs', async () => {
    const f = fakeProject(null);
    const d = logs();
    const dump = put(join(d, 'dump.sql'), 'SELECT 1;');
    const a = put(join(d, 'logs', 'a.log'));
    expect((await f.inproc('sandbox-local', ['--dump', dump])).code).toBe(0);
    expect(readRegistry({ GOODBOY_REGISTRY_DIR: f.registry })).toEqual([{ top: realpathSync(f.root), project: projectName(f.root), dump, inputs: [], paths: [dump], dirs: [] }]);
    expect((await f.inproc('sandbox-local', ['--input', a])).code).toBe(0);
    expect(readRegistry({ GOODBOY_REGISTRY_DIR: f.registry })).toEqual([{ top: realpathSync(f.root), project: projectName(f.root), dump, inputs: [a], paths: [dump, a], dirs: [] }]);
  });

  test('writeLocal and addInputs, called directly, register too; a registry that refuses leaves local.json as it was', () => {
    const f = fakeProject(null);
    const d = logs();
    const dump = put(join(d, 'dump.sql'), 'SELECT 1;');
    const a = put(join(d, 'logs', 'a.log'));
    // a registry full of other projects
    for (let i = 0; i < REGISTRY_MAX; i++) expect(registerRealData(entry(i), { GOODBOY_REGISTRY_DIR: f.registry })).toBeNull();
    const w = writeLocal(f.root, dump, null);
    expect(w).toBeInstanceOf(Error);
    expect((w as Error).message).toContain('is full');
    expect(addInputs(f.root, [a])).toBeInstanceOf(Error);
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
    expect((readRegistry({ GOODBOY_REGISTRY_DIR: f.registry }) as RegistryEntry[]).length).toBe(REGISTRY_MAX);
  });

  test('sandbox-local says so when the registry cannot be read: an error, and no local.json written', async () => {
    const f = fakeProject(null);
    const d = logs();
    put(join(f.registry, 'real-data.json'), '{broken');
    const r = await f.inproc('sandbox-local', ['--dump', put(join(d, 'dump.sql'), 'SELECT 1;')]);
    expect(r.code).toBe(1);
    expect(r.error).toMatch(/^sandbox-local: the registry of real-data sandboxes is not a file goodboy wrote/);
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
  });

  test('a sandbox command registers a project whose local.json says real data (a sandbox of M6a, or one made by hand)', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true, inputs: ['/l/a.log'] });
    expect(readRegistry({ GOODBOY_REGISTRY_DIR: f.registry })).toEqual([]);
    const r = await f.inproc('sandbox-check');
    expect(r.out.registry).toBeUndefined();
    expect(readRegistry({ GOODBOY_REGISTRY_DIR: f.registry })).toEqual([{ top: realpathSync(f.root), project: projectName(f.root), dump: null, inputs: ['/l/a.log'], paths: ['/l/a.log'], dirs: [] }]);
  });

  test('a database volume is real data whatever local.json says, and the project is registered', async () => {
    const f = fakeProject(null);
    writeFileSync(join(f.state, 'volumes.txt'), `${projectName(f.root)}_runout\n${projectName(f.root)}_db1data\n`);
    await f.inproc('sandbox-check');
    expect((readRegistry({ GOODBOY_REGISTRY_DIR: f.registry }) as RegistryEntry[]).map((e) => e.top)).toEqual([realpathSync(f.root)]);
    // and no plain local.json says otherwise
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
  });

  test('a plain project is in no registry', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: false });
    await f.inproc('sandbox-check');
    expect(existsSync(join(f.registry, 'real-data.json'))).toBe(false);
  });

  test('a registry that cannot be read is reported next to the output of the command, which still runs', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    put(join(f.registry, 'real-data.json'), '{broken');
    const r = await f.inproc('sandbox-check');
    expect(r.out.registry).toEqual({ code: 'registry-failed', step: 'registry', reason: 'unreadable' });
    expect(r.out.inner_only).toBe(true);
    expect(r.text).not.toContain('broken');
    const cli = f.cli(['sandbox-check']);
    expect(JSON.parse(cli.stdout).registry).toEqual({ code: 'registry-failed', step: 'registry', reason: 'unreadable' });
  });

  test('a full registry is reported the same way, with its own reason', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true });
    for (let i = 0; i < REGISTRY_MAX; i++) expect(registerRealData(entry(i), { GOODBOY_REGISTRY_DIR: f.registry })).toBeNull();
    const r = await f.inproc('sandbox-check');
    expect(r.out.registry).toEqual({ code: 'registry-failed', step: 'registry', reason: 'full' });
  });
});

describe('the reason a sandbox command gives is the error\'s code, never a guess from its text', () => {
  test('too many paths for the project is reported as too-many-paths, and a locked registry as busy', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true, inputs: ['/l/new.log'] });
    const many = Array.from({ length: REGISTRY_MAX_PATHS }, (_, i) => `/l/${i}.log`);
    expect(registerRealData(registryEntryOf(f.root, { dump: null, dumpFormat: null, realData: true, inputs: many }), { GOODBOY_REGISTRY_DIR: f.registry })).toBeNull();
    const r = await f.inproc('sandbox-check');
    expect(r.out.registry).toEqual({ code: 'registry-failed', step: 'registry', reason: 'too-many-paths' });
    expect(r.text).not.toContain('/l/');
    const g = fakeProject({ dump: null, dumpFormat: null, realData: true });
    put(join(g.registry, 'real-data.lock'), '1\n');
    expect((await g.inproc('sandbox-check')).out.registry).toEqual({ code: 'registry-failed', step: 'registry', reason: 'busy' });
  });
});

describe('the plain local.json the sandbox commands write', () => {
  const PLAIN = { dump: null, dumpFormat: null, realData: false };
  const localOf = (root: string): unknown => JSON.parse(readFileSync(join(root, LOCAL_FILE), 'utf8'));

  test('a project with no local.json, docker answering and no database volume, gets a plain one (mode 0600)', async () => {
    const f = fakeProject(null);
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
    await f.inproc('sandbox-check');
    expect(localOf(f.root)).toEqual(PLAIN);
    expect(statSync(join(f.root, LOCAL_FILE)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(f.root, SANDBOX_DIR, '.gitignore'), 'utf8')).toContain('local.json');
  });

  test('a run dir of before M6a keeps the project real data for reading: no plain file is written over it', async () => {
    const f = fakeProject(null);
    put(join(f.root, SANDBOX_DIR, 'out', '20250101T000000Z', 'result.json'), '{"ts": "a run from before M6a"}');
    const { realDataForReading } = await import('../lib/sandbox-mode');
    expect(realDataForReading(f.root)).toBe(true);
    await f.inproc('sandbox-check');
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
    expect(realDataForReading(f.root)).toBe(true);
  });

  test('a run dir that says realData false does not hold the plain file back', async () => {
    const f = fakeProject(null);
    put(join(f.root, SANDBOX_DIR, 'out', '20250101T000000Z', 'result.json'), '{"realData": false}');
    await f.inproc('sandbox-check');
    expect(localOf(f.root)).toEqual(PLAIN);
  });

  test('not written: with a local.json already there, with a database volume, or when docker did not answer', async () => {
    const there = fakeProject({ dump: null, dumpFormat: null, realData: true });
    await there.inproc('sandbox-check');
    expect(localOf(there.root)).toEqual({ dump: null, dumpFormat: null, realData: true });
    const withVolume = fakeProject(null);
    writeFileSync(join(withVolume.state, 'volumes.txt'), `${projectName(withVolume.root)}_db1data\n`);
    await withVolume.inproc('sandbox-check');
    expect(existsSync(join(withVolume.root, LOCAL_FILE))).toBe(false);
    const silent = fakeProject(null);
    await silent.inproc('sandbox-check', [], { FAKE_FAIL: 'volume ls' });
    expect(existsSync(join(silent.root, LOCAL_FILE))).toBe(false);
  });

  test('not written when the registry has an entry for the project, or cannot be read (a plain file would hide a real-data project)', async () => {
    const entered = fakeProject(null);
    expect(registerRealData(registryEntryOf(entered.root, { dump: '/d/x.sql', dumpFormat: 'sql', realData: true }), { GOODBOY_REGISTRY_DIR: entered.registry })).toBeNull();
    await entered.inproc('sandbox-check');
    expect(existsSync(join(entered.root, LOCAL_FILE))).toBe(false);
    const unreadable = fakeProject(null);
    put(join(unreadable.registry, 'real-data.json'), '{broken');
    await unreadable.inproc('sandbox-check');
    expect(existsSync(join(unreadable.root, LOCAL_FILE))).toBe(false);
  });

  test('not written while raw host files of a run that may have held real data remain', async () => {
    const f = fakeProject(null);
    put(join(f.root, SANDBOX_DIR, 'out', 'live', 'output.log'), 'rows');
    await f.inproc('sandbox-check');
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
  });

  test('writePlainLocal, called directly, follows the same rules', async () => {
    const { writePlainLocal } = await import('../lib/sandbox-files');
    const f = fakeProject(null);
    registerRealData(registryEntryOf(f.root, { dump: null, dumpFormat: null, realData: true, inputs: ['/l/a.log'] }), { GOODBOY_REGISTRY_DIR: f.registry });
    writePlainLocal(f.root);
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
    const g = fakeProject(null);
    writePlainLocal(g.root);
    expect(localOf(g.root)).toEqual(PLAIN);
  });

  test('not written for a daemon that is not local (nothing was asked of it)', async () => {
    const f = fakeProject(null);
    writeFileSync(join(f.state, 'context.txt'), 'tcp://10.0.0.1:2375\n');
    await f.inproc('sandbox-check');
    expect(existsSync(join(f.root, LOCAL_FILE))).toBe(false);
  });

  test('the file is written once: later commands leave it alone (same bytes, same mtime)', async () => {
    const f = fakeProject(null);
    await f.inproc('sandbox-check');
    const before = statSync(join(f.root, LOCAL_FILE)).mtimeMs;
    const text = readFileSync(join(f.root, LOCAL_FILE), 'utf8');
    await f.inproc('sandbox-check');
    expect(statSync(join(f.root, LOCAL_FILE)).mtimeMs).toBe(before);
    expect(readFileSync(join(f.root, LOCAL_FILE), 'utf8')).toBe(text);
  });
});
