// Track M, M6b (plan §19): `sandbox-local --input <path>` registers input logs in local.json: validated like the dump,
// shown only as a count, and, like a dump, they put the project in real-data mode.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realDataOf } from '../lib/sandbox-boundary';
import { addInputs, clearRealData, inputProblem, writeLocal } from '../lib/sandbox-files';
import { LOCAL_FILE, MAX_INPUTS, readLocal } from '../lib/sandbox-mode';
import { cleanupFakeProjects, fakeProject } from './m6a-project';

setDefaultTimeout(120_000);
const scratch: string[] = [];
const savedHome = process.env.HOME;
afterEach(() => {
  // a dump has to be under the home directory (dumpProblem); two tests move it
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  cleanupFakeProjects();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

const outside = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-input-')));
  scratch.push(d);
  return d;
};
const file = (dir: string, name: string, text = 'GET /users/42?email=a@b.c 200'): string => {
  const p = join(dir, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const localOf = (root: string) => JSON.parse(readFileSync(join(root, LOCAL_FILE), 'utf8')) as { dump: string | null; dumpFormat: string | null; realData?: boolean; inputs?: string[] };

describe('sandbox-local --input', () => {
  test('registers a file: realData goes on, mode 0600, and the output says how many, not which', async () => {
    const f = fakeProject(null);
    const logs = outside();
    const a = file(logs, 'access.log');
    const r = await f.inproc('sandbox-local', ['--input', a]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ dump: null, dumpFormat: null, realData: true, inputs: 1 });
    expect(r.text).not.toContain(a);
    expect(r.text).not.toContain(logs);
    expect(localOf(f.root)).toEqual({ dump: null, dumpFormat: null, realData: true, inputs: [a] });
    expect(statSync(join(f.root, LOCAL_FILE)).mode & 0o777).toBe(0o600);
  });

  test('repeatable, in one call or over several; the same file twice (also through a link) is one', async () => {
    const f = fakeProject(null);
    const logs = outside();
    const a = file(logs, 'a.log');
    const b = file(logs, 'b.log');
    const dir = join(logs, 'dir');
    file(dir, 'c.log');
    const r = await f.inproc('sandbox-local', ['--input', a, '--input', b, '--input', a]);
    expect(r.out.inputs).toBe(2);
    symlinkSync(b, join(logs, 'link.log'));
    const r2 = await f.inproc('sandbox-local', ['--input', join(logs, 'link.log'), '--input', dir]);
    expect(r2.out.inputs).toBe(3);
    expect(localOf(f.root).inputs).toEqual([a, b, dir]);
  });

  test('with --dump in one call, and a later --dump keeps the inputs', async () => {
    const f = fakeProject(null);
    const logs = outside();
    const a = file(logs, 'a.log');
    const dump = file(logs, 'dump.sql', 'SELECT 1;');
    process.env.HOME = logs;
    const r = await f.inproc('sandbox-local', ['--dump', dump, '--input', a]);
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ dump, realData: true, inputs: 1 });
    // the dump is replaced, the input stays
    const dump2 = file(logs, 'dump2.sql', 'SELECT 2;');
    const r2 = await f.inproc('sandbox-local', ['--dump', dump2]);
    expect(r2.out).toMatchObject({ dump: dump2, inputs: 1 });
    expect(localOf(f.root)).toMatchObject({ dump: dump2, inputs: [a] });
    // and an input added later keeps the dump
    const b = file(logs, 'b.log');
    await f.inproc('sandbox-local', ['--input', b]);
    expect(localOf(f.root)).toMatchObject({ dump: dump2, dumpFormat: 'sql', inputs: [a, b] });
  });

  test('refused like a dump that cannot be used: relative, missing, in the repo, above the repo, not a file or dir', async () => {
    const f = fakeProject(null);
    const logs = outside();
    const inRepo = file(f.root, 'logs/app.log');
    expect(inputProblem(f.root, 'relative/app.log')).toContain('absolute');
    expect(inputProblem(f.root, join(logs, 'nope.log'))).toContain('does not exist');
    expect(inputProblem(f.root, inRepo)).toContain('inside the repository');
    expect(inputProblem(f.root, join(f.root, 'logs'))).toContain('inside the repository');
    expect(inputProblem(f.root, join(f.root, '..'))).toContain('holds the repository');
    expect(inputProblem(f.root, tmpdir())).toContain('holds the repository');
    expect(inputProblem(f.root, file(logs, 'ok.log'))).toBeNull();
    expect(inputProblem(f.root, logs)).toBeNull();
    // a link into the repo is inside it too
    symlinkSync(inRepo, join(logs, 'into-repo.log'));
    expect(inputProblem(f.root, join(logs, 'into-repo.log'))).toContain('inside the repository');
    for (const bad of ['relative/app.log', join(logs, 'nope.log'), inRepo]) {
      const r = await f.inproc('sandbox-local', ['--input', bad]);
      expect(r.code).toBe(1);
      expect(r.error).toMatch(/^sandbox-local: /);
    }
    // a refused input leaves the local file as it was
    expect(readLocalSafe(f.root)).toBeNull();
  });

  test('a usage error when --input has no value, or there is neither --dump nor --input', async () => {
    const f = fakeProject(null);
    for (const args of [['--input'], ['--input', '--dump', '/x'], ['--dump'], [], ['--format', 'sql']]) {
      const r = await f.inproc('sandbox-local', args);
      expect(r.code).toBe(1);
      expect(r.error).toContain('sandbox-local: pass --dump <absolute path>');
      expect(r.error).toContain('--input <absolute path>');
    }
  });

  test('at most 50', () => {
    const f = fakeProject(null);
    const logs = outside();
    const many = Array.from({ length: MAX_INPUTS + 1 }, (_, i) => file(logs, `l${i}.log`));
    expect(addInputs(f.root, many)).toBeInstanceOf(Error);
    expect(addInputs(f.root, many.slice(0, MAX_INPUTS))).not.toBeInstanceOf(Error);
    expect(addInputs(f.root, [many[MAX_INPUTS]!])).toBeInstanceOf(Error);
  });
});

const readLocalSafe = (root: string): string | null => {
  try {
    return readFileSync(join(root, LOCAL_FILE), 'utf8');
  } catch {
    return null;
  }
};

describe('inputs in the local file and in the mode', () => {
  test('readLocal reads them back, refuses a bad list, and a project with an input is real data', () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: false, inputs: ['/logs/a.log'] });
    const l = readLocal(f.root);
    expect(l).toEqual({ dump: null, dumpFormat: null, realData: false, inputs: ['/logs/a.log'] });
    expect(realDataOf(l as never)).toBe(true);
    for (const inputs of ['/logs/a.log', ['rel.log'], [1], { a: 1 }, Array.from({ length: 51 }, (_, i) => `/l/${i}`)]) {
      writeFileSync(join(f.root, LOCAL_FILE), JSON.stringify({ dump: null, dumpFormat: null, inputs }));
      expect(readLocal(f.root)).toBeInstanceOf(Error);
    }
    writeFileSync(join(f.root, LOCAL_FILE), JSON.stringify({ dump: null, dumpFormat: null, realData: false, inputs: [] }));
    expect(realDataOf(readLocal(f.root) as never)).toBe(false);
  });

  test('clearing the real-data flag keeps the inputs, and the mode with them', () => {
    const f = fakeProject({ dump: null, dumpFormat: null, realData: true, inputs: ['/logs/a.log'] });
    expect(clearRealData(f.root)).toBeNull();
    expect(localOf(f.root)).toEqual({ dump: null, dumpFormat: null, realData: false, inputs: ['/logs/a.log'] });
    expect(realDataOf(readLocal(f.root) as never)).toBe(true);
  });

  test('sandbox-down --volumes does not end the mode while an input is registered', async () => {
    const withInput = fakeProject({ dump: null, dumpFormat: null, realData: true, inputs: ['/logs/a.log'] });
    const r = await withInput.inproc('sandbox-down', ['--volumes']);
    expect(r.out.realData).toBe('kept');
    const without = fakeProject({ dump: null, dumpFormat: null, realData: true });
    expect((await without.inproc('sandbox-down', ['--volumes'])).out.realData).toBe('cleared');
  });

  test('a sandbox run with an input registered runs in real-data mode', async () => {
    const f = fakeProject({ dump: null, dumpFormat: null, inputs: ['/logs/a.log'] });
    const r = await f.inproc('sandbox-run', ['--suite', 'unit']);
    expect(r.out.realData).toBe(true);
    expect(r.out.tail).toBe('');
  });

  test('writeLocal still takes a dump alone', () => {
    const f = fakeProject(null);
    const home = outside();
    const dump = file(home, 'dump.sql', 'SELECT 1;');
    process.env.HOME = home;
    const w = writeLocal(f.root, dump, null);
    expect(w).not.toBeInstanceOf(Error);
    expect(localOf(f.root)).toEqual({ dump, dumpFormat: 'sql', realData: true });
  });
});
