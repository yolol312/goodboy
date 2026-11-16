// Track M, M6b (plan §19): changed lines that only a few paths reach, each run here in this process (a child process of the
// CLI is not measured):
//   1. `sandbox-data` through `sandboxCommand` against the fake docker: the data context (target, readiness check, handle key
//      out of the `meta` volume) and the dispatch of the command;
//   2. a local file that cannot be written is an error, not a throw;
//   3. the glob reader of the data guard: a bracket or a POSIX class that never closes, and the two bounds (the work budget of
//      one call, and a brace with more alternatives than the rule expands).

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globMatches, sandboxDataDenial } from '../lib/sandbox-data-guard';
import { handleOf } from '../lib/sandbox-data';
import { writeLocal } from '../lib/sandbox-files';
import { registerRealData, registryEntryOf } from '../lib/sandbox-registry';
import { cleanupFakeProjects, fakeProject, type FakeProject, plainScan } from './m6a-project';
import { keepEnv, put, sandboxIn } from './m6b-helpers';

setDefaultTimeout(120_000);
afterEach(cleanupFakeProjects);

// ---- 1. sandbox-data in this process ----

const SCHEMA = ['C\tpublic\tusers\tid\tinteger\tNO', 'C\tpublic\tusers\tage\tinteger\tYES', 'S\t1', 'K\tpublic\tusers\tid\tp\t1'].join('\n') + '\n';
const ROW_HEX = Buffer.from('row-1').toString('hex');
const ANSWERS: Record<string, string> = { 'schema.out': SCHEMA, 'rowcounts.out': 'R\t0\t40\n', 'count.out': 'N\t77\n', 'pick.out': `M\t10\nP\t${ROW_HEX}\nP\t3132\n` };
const REAL = { dump: null, dumpFormat: null, realData: true } as const;
const PICK = ['pick', 'users', '--where', '{"col":"age","op":">","value":1}'];

function answers(f: FakeProject): void {
  mkdirSync(join(f.state, 'db'), { recursive: true });
  for (const [name, text] of Object.entries(ANSWERS)) writeFileSync(join(f.state, 'db', name), text);
}
const keyOf = (f: FakeProject): string => readFileSync(join(f.state, 'vol', 'meta', 'handle.key'), 'utf8').trim();

describe('sandbox-data through sandboxCommand', () => {
  test('schema, count and pick answer with goodboy\'s own JSON, and the handles use the key of the meta volume', async () => {
    const f = fakeProject(REAL);
    answers(f);
    const schema = await f.inproc('sandbox-data', ['schema']);
    expect([schema.code, schema.out.op, schema.out.ok]).toEqual([0, 'schema', true]);
    const count = await f.inproc('sandbox-data', ['count', 'users']);
    expect([count.code, count.out.op, count.out.count]).toEqual([0, 'count', 77]);
    expect(existsSync(join(f.state, 'vol', 'meta', 'handle.key'))).toBe(false); // schema and count need no key
    const pick = await f.inproc('sandbox-data', PICK);
    expect([pick.code, pick.out.op, pick.out.ok]).toEqual([0, 'pick', true]);
    const key = keyOf(f);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(pick.out.handles).toEqual([handleOf(key, 'postgres', 'shop', 'users', [ROW_HEX]), handleOf(key, 'postgres', 'shop', 'users', ['3132'])]);
    // the same rows give the same handles on a second call: the key was kept, not made again
    const again = await f.inproc('sandbox-data', PICK);
    expect(again.out.handles).toEqual(pick.out.handles);
    expect(keyOf(f)).toBe(key);
  });

  test('the readiness check runs before any query: a remote daemon stops the call with no SQL', async () => {
    const f = fakeProject(REAL);
    answers(f);
    const r = await f.inproc('sandbox-data', ['count', 'users'], { DOCKER_HOST: 'tcp://203.0.113.9:2375' });
    expect([r.code, r.out]).toEqual([1, { op: 'count', ok: false, diagnostic: { code: 'data-failed', step: 'count' } }]);
    expect(existsSync(join(f.state, 'db-sql.log'))).toBe(false);
    // the same project and answers, on the local daemon: the call runs
    const ok = await f.inproc('sandbox-data', ['count', 'users']);
    expect([ok.code, ok.out.count]).toEqual([0, 77]);
    expect(existsSync(join(f.state, 'db-sql.log'))).toBe(true);
  });

  test('a project with no SQL store has no target: the call is refused as a data call, with no SQL', async () => {
    const scan = plainScan();
    scan.stores = [];
    const f = fakeProject(REAL, scan);
    answers(f);
    const r = await f.inproc('sandbox-data', ['count', 'users']);
    expect([r.code, r.out]).toEqual([1, { op: 'count', ok: false, diagnostic: { code: 'data-refused', step: 'count', field: 'store', reason: 'no-sql-store' } }]);
    expect(existsSync(join(f.state, 'db-sql.log'))).toBe(false);
  });
});

// ---- 2. a local file that cannot be written ----

describe('writeLocal', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test('a sandbox dir that is a file is an Error naming it, not a throw, and no local file is written', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-wl-')));
    dirs.push(base);
    const restoreEnv = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');
    // the dump must sit in the home dir for the docker VM to see it (dumpProblem), so HOME is the temp dir
    process.env.HOME = base;
    process.env.GOODBOY_REGISTRY_DIR = join(base, 'registry');
    try {
      const root = join(base, 'repo');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, '.goodboy'), 'a file where the dir goes\n');
      const dump = put(join(base, 'dumps', 'd.sql'), 'COPY x FROM stdin;');
      const w = writeLocal(root, dump, 'sql');
      expect(w).toBeInstanceOf(Error);
      expect((w as Error).message).toContain(`${join(root, '.goodboy')} is a link or not a directory`);
      expect(existsSync(join(root, '.goodboy', 'sandbox', 'local.json'))).toBe(false);
    } finally {
      restoreEnv();
    }
  });
});

// ---- 3. the data guard's glob reader and bounds ----

describe('glob reader of the data guard', () => {
  test('a bracket that never closes is the character `[` and what follows, as the shell reads it', () => {
    expect(globMatches('a[bc', 'a[bc')).toBe(true);
    expect(globMatches('a[bc', 'abc')).toBe(false);
    expect(globMatches('d/[x*', 'd/[xyz')).toBe(true);
    expect(globMatches('d/[x*', 'd/xyz')).toBe(false);
  });

  test('a `[:` inside a bracket with no `:]` after it is the characters `[` and `:`', () => {
    for (const ch of ['[', ':', 'a']) expect([ch, globMatches('[[:a]', ch)]).toEqual([ch, true]);
    for (const ch of ['b', ']', '/']) expect([ch, globMatches('[[:a]', ch)]).toEqual([ch, false]);
  });

  test('a POSIX class that exists matches, and one that does not makes the glob unreadable', () => {
    expect(globMatches('[[:digit:]]x', '7x')).toBe(true);
    expect(globMatches('[[:digit:]]x', 'ax')).toBe(false);
    expect(globMatches('[[:nope:]]x', '7x')).toBeNull();
  });
});

describe('bounds of one call', () => {
  let base = '';
  let home = '';
  const restoreEnv = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-cov-')));
    home = join(base, 'home');
    mkdirSync(join(base, 'away'), { recursive: true });
    process.env.HOME = home;
    process.env.GOODBOY_REGISTRY_DIR = join(base, 'registry');
  });
  afterAll(() => {
    restoreEnv();
    rmSync(base, { recursive: true, force: true });
  });

  const bash = (command: string): string | null => {
    mkdirSync(join(base, 'away'), { recursive: true });
    const cwd = join(base, 'away');
    return sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd, projectCwd: cwd })?.what ?? null;
  };
  /** `n` projects registered with a dump each in a dir of its own (the registry keeps every one of their dirs as a needle). */
  const registerMany = (n: number): string[] => {
    const dumps: string[] = [];
    for (let i = 0; i < n; i++) {
      const dump = put(join(home, `dumps${i}`, 'dump.sql'), 'COPY x FROM stdin;');
      const top = join(base, 'projects', `p${i}`);
      sandboxIn(top, { dump, dumpFormat: 'sql', realData: true });
      expect(registerRealData(registryEntryOf(top, { dump, dumpFormat: 'sql', realData: true }))).toBeNull();
      dumps.push(dump);
    }
    return dumps;
  };

  test('a command of 100 KB with a `(` and 40 protected dirs spends the work budget: it is not read to the end, and is not denied in the registry-only context', () => {
    const dumps = registerMany(40);
    // the form the rule is for is found while the budget lasts
    expect(bash(`cat ${home}/dumps3/(dump|x).sql`)).toMatch(/dump or an input log/);
    const padded = `echo ( ${'x'.repeat(99_000)}`;
    const t0 = performance.now();
    expect(bash(padded)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(5000);
    // a dump named plainly after the padding is still a hit: only the group form went unread
    expect(bash(`${padded} && cat ${dumps[7]}`)).toMatch(/dump or an input log/);
  });

  test('a brace of more than 64 alternatives in a dir that holds no protected path passes; in one that holds one it is denied', () => {
    const dumps = registerMany(1);
    const many = Array.from({ length: 70 }, (_, i) => `a${i}`).join(',');
    expect(bash(`cat ${join(base, 'elsewhere')}/{${many}}`)).toBeNull();
    expect(bash(`cat ${dumps[0]!.replace(/dump\.sql$/, '')}{${many}}`)).toMatch(/dump or an input log/);
  });
});
