// Track M, M6c (plan §19): the manifest `.goodboy/sandbox/data.json`. It is read like an untrusted file (a regular file of at most
// 64 KB, no link), parsed into null-prototype objects, and every refusal names a field path and a fixed reason, never a value.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRefusal, MAX_PICK } from '../lib/sandbox-data';
import { hasDataVolume, KINDS, lineBounds, type Manifest, manifestCounts, newToken, parseManifest, readManifest } from '../lib/sandbox-resolve';

const made: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-manifest-')));
  made.push(d);
  return d;
};
afterAll(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const CANARY = 'Kim-Minsoo-0101234567';
const ACTIVE = { col: 'status', op: '=', value: 'active' };
const GOOD = {
  version: 1,
  picks: { activeUser: { table: 'users', where: ACTIVE, n: 3, columns: ['name', 'email'] } },
  counts: { activeUsers: { table: 'users', where: ACTIVE } },
  generate: { newUserEmail: { table: 'users', column: 'email', kind: 'email' } },
};
const text = (o: unknown): string => JSON.stringify(o);
const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
const refusal = (src: string | unknown): { field: string; reason: string } => {
  const r = parseManifest(typeof src === 'string' ? src : text(src));
  if (!isRefusal(r)) throw new Error(`not refused: ${JSON.stringify(r)}`);
  return r;
};

describe('a manifest that is accepted', () => {
  test('picks, counts and generators as entries, with their conditions parsed by the grammar of sandbox-data', () => {
    const m = parseManifest(text(GOOD)) as Manifest;
    expect(isRefusal(m)).toBe(false);
    expect(m.picks).toHaveLength(1);
    expect(m.picks[0]).toMatchObject({ name: 'activeUser', table: 'users', n: 3, columns: ['name', 'email'] });
    expect(m.picks[0]!.where).toMatchObject({ kind: 'leaf', col: 'status', op: '=', value: 'active' });
    expect(m.counts[0]).toMatchObject({ name: 'activeUsers', table: 'users' });
    expect(m.generate[0]).toEqual({ name: 'newUserEmail', table: 'users', column: 'email', kind: 'email' });
    expect(manifestCounts(m)).toEqual({ picks: 1, counts: 1, generate: 1 });
  });

  test('a section may be left out, n defaults to 5, a count needs no condition and a table may name its schema', () => {
    const m = parseManifest(text({ version: 1, picks: { a: { table: 'audit.log', where: { col: 'id', op: 'not-null' }, columns: ['id'] } }, counts: { all: { table: 'users' } } })) as Manifest;
    expect(m.picks[0]).toMatchObject({ table: 'audit.log', n: 5 });
    expect(m.counts[0]).toEqual({ name: 'all', table: 'users', where: null });
    expect(m.generate).toEqual([]);
    expect(parseManifest('{"version":1}')).toEqual({ picks: [], counts: [], generate: [] });
  });

  test('the largest manifest it takes: 50 picks of 20 columns, 50 counts, 20 generators, n up to the pick maximum', () => {
    const cols = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const picks = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, { table: 't', where: { col: 'id', op: 'not-null' }, n: MAX_PICK, columns: cols }]));
    const counts = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`c${i}`, { table: 't' }]));
    const generate = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`g${i}`, { table: 't', column: 'x', kind: KINDS[i % KINDS.length] }]));
    const m = parseManifest(text({ version: 1, picks, counts, generate })) as Manifest;
    expect(isRefusal(m)).toBe(false);
    expect([m.picks.length, m.counts.length, m.generate.length]).toEqual([50, 50, 20]);
  });

  test('the lines values.tsv may have: fixed ones for counts and generators, n (at least 10) rows per pick for each column', () => {
    const m = parseManifest(text({ ...GOOD, picks: { a: { table: 't', where: ACTIVE, n: 3, columns: ['x', 'y'] }, b: { table: 't', where: ACTIVE, n: 20, columns: ['x'] } } })) as Manifest;
    // 2 fixed + 3*2 + 20 (n above K=10 may find only 10 rows: 10*1)
    expect(lineBounds(m)).toEqual({ min: 2 + 6 + 10, max: 2 + 6 + 20 });
  });

  test('a run token is 8 lowercase hex digits and is new each time', () => {
    const a = newToken();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(Array.from({ length: 20 }, newToken)).size).toBeGreaterThan(15);
  });
});

describe('a manifest that is refused names the field and a fixed reason', () => {
  const cases: [string, unknown, string, string][] = [
    ['not an object', [], 'data.json', 'bad-shape'],
    ['a string', '"x"', 'data.json', 'bad-shape'],
    ['a stray top-level key', { ...GOOD, extra: 1 }, '[4]', 'bad-shape'],
    ['a stray top-level key that is a word of the manifest', { ...GOOD, value: 1 }, 'value', 'bad-shape'],
    ['no version', { picks: {} }, 'version', 'missing'],
    ['another version', { ...GOOD, version: 2 }, 'version', 'bad-version'],
    ['a version as text', { ...GOOD, version: '1' }, 'version', 'bad-version'],
    ['picks that are a list', { version: 1, picks: [] }, 'picks', 'bad-shape'],
    ['counts that are a string', { version: 1, counts: 'x' }, 'counts', 'bad-shape'],
    ['a pick that is a list', { version: 1, picks: { a: [] } }, 'picks.a', 'bad-shape'],
    ['a pick with a stray key', { version: 1, picks: { a: { ...GOOD.picks.activeUser, foo: 1 } } }, 'picks.a[4]', 'bad-shape'],
    ['a pick with no table', { version: 1, picks: { a: { where: ACTIVE, columns: ['x'] } } }, 'picks.a.table', 'missing'],
    ['a table that is no name', { version: 1, picks: { a: { table: 'users; drop', where: ACTIVE, columns: ['x'] } } }, 'picks.a.table', 'bad-name'],
    ['a table that is a number', { version: 1, picks: { a: { table: 7, where: ACTIVE, columns: ['x'] } } }, 'picks.a.table', 'bad-name'],
    ['a pick with no condition', { version: 1, picks: { a: { table: 't', columns: ['x'] } } }, 'picks.a.where', 'missing'],
    ['a condition that is a list', { version: 1, picks: { a: { table: 't', where: [], columns: ['x'] } } }, 'picks.a.where', 'bad-shape'],
    ['an operator the grammar has not', { version: 1, picks: { a: { table: 't', where: { col: 'x', op: 'like', value: 'a' }, columns: ['x'] } } }, 'picks.a.where.op', 'bad-op'],
    ['a nested condition value with a backslash', { version: 1, counts: { a: { table: 't', where: { and: [ACTIVE, { col: 'x', op: '=', value: `a\\${CANARY}` }] } } } }, 'counts.a.where.and[1].value', 'bad-value'],
    ['a condition column that is no name', { version: 1, counts: { a: { table: 't', where: { col: 'x y', op: 'is-null' } } } }, 'counts.a.where.col', 'bad-name'],
    ['n of 0', { version: 1, picks: { a: { ...GOOD.picks.activeUser, n: 0 } } }, 'picks.a.n', 'bad-number'],
    ['n above the maximum', { version: 1, picks: { a: { ...GOOD.picks.activeUser, n: MAX_PICK + 1 } } }, 'picks.a.n', 'bad-number'],
    ['n with a fraction', { version: 1, picks: { a: { ...GOOD.picks.activeUser, n: 1.5 } } }, 'picks.a.n', 'bad-number'],
    ['n as text', { version: 1, picks: { a: { ...GOOD.picks.activeUser, n: '3' } } }, 'picks.a.n', 'bad-number'],
    ['no columns', { version: 1, picks: { a: { table: 't', where: ACTIVE } } }, 'picks.a.columns', 'missing'],
    ['no column in the list', { version: 1, picks: { a: { table: 't', where: ACTIVE, columns: [] } } }, 'picks.a.columns', 'bad-shape'],
    ['columns that are a string', { version: 1, picks: { a: { table: 't', where: ACTIVE, columns: 'x' } } }, 'picks.a.columns', 'bad-shape'],
    ['21 columns', { version: 1, picks: { a: { table: 't', where: ACTIVE, columns: Array.from({ length: 21 }, (_, i) => `c${i}`) } } }, 'picks.a.columns', 'too-many'],
    ['a column that is no name', { version: 1, picks: { a: { table: 't', where: ACTIVE, columns: ['ok', 'a b'] } } }, 'picks.a.columns[1]', 'bad-name'],
    ['a column that is a number', { version: 1, picks: { a: { table: 't', where: ACTIVE, columns: [3] } } }, 'picks.a.columns[0]', 'bad-shape'],
    ['a column twice', { version: 1, picks: { a: { table: 't', where: ACTIVE, columns: ['x', 'x'] } } }, 'picks.a.columns[1]', 'bad-shape'],
    ['a count with a stray key', { version: 1, counts: { a: { table: 't', n: 1 } } }, 'counts.a.n', 'bad-shape'],
    ['a count that is a string', { version: 1, counts: { a: 'users' } }, 'counts.a', 'bad-shape'],
    ['a generator with no column', { version: 1, generate: { g: { table: 't', kind: 'email' } } }, 'generate.g.column', 'missing'],
    ['a generator column that is no name', { version: 1, generate: { g: { table: 't', column: 'a-b', kind: 'email' } } }, 'generate.g.column', 'bad-name'],
    ['a generator with no kind', { version: 1, generate: { g: { table: 't', column: 'x' } } }, 'generate.g.kind', 'missing'],
    ['a kind that does not exist', { version: 1, generate: { g: { table: 't', column: 'x', kind: 'uuid' } } }, 'generate.g.kind', 'unknown-kind'],
    ['a generator with a stray key', { version: 1, generate: { g: { table: 't', column: 'x', kind: 'text', prefix: 'a' } } }, 'generate.g[3]', 'bad-shape'],
  ];
  for (const [title, doc, field, reason] of cases) {
    test(`${title}: ${field} ${reason}`, () => {
      expect(refusal(doc)).toEqual({ field, reason });
    });
  }

  test('not JSON, and JSON nested deeper than a manifest ever is', () => {
    expect(refusal('{"version":1,')).toEqual({ field: 'data.json', reason: 'bad-json' });
    expect(refusal('')).toEqual({ field: 'data.json', reason: 'bad-json' });
    expect(refusal(`{"version":1,"picks":{"a":${'['.repeat(40)}${']'.repeat(40)}}}`)).toEqual({ field: 'data.json', reason: 'bad-shape' });
  });

  test('over the caps: 51 picks, 51 counts, 21 generators', () => {
    const n = (k: number, v: unknown) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`n${i}`, v]));
    expect(refusal({ version: 1, picks: n(51, GOOD.picks.activeUser) })).toEqual({ field: 'picks', reason: 'too-many' });
    expect(refusal({ version: 1, counts: n(51, { table: 't' }) })).toEqual({ field: 'counts', reason: 'too-many' });
    expect(refusal({ version: 1, generate: n(21, { table: 't', column: 'x', kind: 'text' }) })).toEqual({ field: 'generate', reason: 'too-many' });
  });

  test('a name must be a plain word that no object already has: __proto__, constructor, toString, spaces and a leading digit are refused by place', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '1abc', 'a b', `${CANARY}!`, 'x'.repeat(65)]) {
      // text, not an object: JSON.stringify of a literal `__proto__` key would set the prototype instead of making a key
      const src = `{"version":1,"picks":{"first":${JSON.stringify(GOOD.picks.activeUser)},${JSON.stringify(name)}:${JSON.stringify(GOOD.picks.activeUser)}}}`;
      const r = refusal(src);
      expect(r.reason).toBe('bad-name');
      // the second entry is shown by its place, not by its name
      expect(r.field).toBe('picks[1]');
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
    // the same for the other two sections
    expect(refusal('{"version":1,"counts":{"__proto__":{"table":"t"}}}')).toEqual({ field: 'counts[0]', reason: 'bad-name' });
    expect(refusal('{"version":1,"generate":{"constructor":{"table":"t","column":"x","kind":"text"}}}')).toEqual({ field: 'generate[0]', reason: 'bad-name' });
    // and a stray top-level key with such a name
    expect(refusal('{"version":1,"__proto__":{}}')).toEqual({ field: '[1]', reason: 'bad-shape' });
  });

  test('a manifest with __proto__ in it does not touch Object.prototype', () => {
    parseManifest('{"version":1,"__proto__":{"polluted":true},"picks":{"__proto__":{"polluted":true}}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  test('no refusal holds a value of the input: a canary in a name, a table, a condition value or a column never comes back', () => {
    const docs: unknown[] = [
      { version: 1, picks: { a: { table: CANARY, where: ACTIVE, columns: ['x'] } } },
      { version: 1, picks: { a: { table: 't', where: { col: 'x', op: '=', value: `${CANARY}\\` }, columns: ['x'] } } },
      { version: 1, picks: { a: { table: 't', where: ACTIVE, columns: [`${CANARY} x`] } } },
      { version: 1, generate: { g: { table: 't', column: 'x', kind: CANARY } } },
      { version: 1, [CANARY]: 1 },
      { version: CANARY },
      { version: 1, picks: { a: { table: 't', where: { col: CANARY, op: 'is-null' }, columns: ['x'] } } },
    ];
    for (const d of docs) expect(JSON.stringify(refusal(d))).not.toContain(CANARY);
  });
});

describe('the file', () => {
  const sandbox = (root: string): string => join(root, '.goodboy', 'sandbox');
  const put = (root: string, content: string): string => {
    mkdirSync(sandbox(root), { recursive: true });
    const p = join(sandbox(root), 'data.json');
    writeFileSync(p, content);
    return p;
  };

  test('there is none: null, and a run has no resolve step', () => {
    const root = tmp();
    mkdirSync(sandbox(root), { recursive: true });
    expect(readManifest(root)).toBeNull();
    expect(readManifest(join(root, 'no-such-dir'))).toBeNull();
  });

  test('a regular file is read and parsed', () => {
    const root = tmp();
    put(root, text(GOOD));
    expect(isRefusal(readManifest(root))).toBe(false);
    expect((readManifest(root) as Manifest).picks[0]!.name).toBe('activeUser');
    put(root, '{"version":3}');
    expect(readManifest(root)).toEqual({ field: 'version', reason: 'bad-version' });
  });

  test('64 KB is the most it reads: a larger file is unreadable, not parsed', () => {
    const root = tmp();
    const body = text({ version: 1, counts: {} });
    put(root, body + ' '.repeat(64 * 1024 - body.length));
    expect(isRefusal(readManifest(root))).toBe(false);
    put(root, body + ' '.repeat(64 * 1024 - body.length + 1));
    expect(readManifest(root)).toEqual({ field: 'data.json', reason: 'unreadable' });
  });

  test('a link to a file, a directory in its place and a link on the way are all unreadable', () => {
    const root = tmp();
    mkdirSync(sandbox(root), { recursive: true });
    const real = join(root, 'elsewhere.json');
    writeFileSync(real, text(GOOD));
    symlinkSync(real, join(sandbox(root), 'data.json'));
    expect(readManifest(root)).toEqual({ field: 'data.json', reason: 'unreadable' });
    rmSync(join(sandbox(root), 'data.json'));
    mkdirSync(join(sandbox(root), 'data.json'));
    expect(readManifest(root)).toEqual({ field: 'data.json', reason: 'unreadable' });

    // `.goodboy/sandbox` itself a link to another directory that holds a good file
    const other = tmp();
    mkdirSync(join(other, 'real'), { recursive: true });
    writeFileSync(join(other, 'real', 'data.json'), text(GOOD));
    const root2 = tmp();
    mkdirSync(join(root2, '.goodboy'), { recursive: true });
    symlinkSync(join(other, 'real'), join(root2, '.goodboy', 'sandbox'));
    expect(readManifest(root2)).toEqual({ field: 'data.json', reason: 'unreadable' });
  });
});

describe('a compose config with the data volume', () => {
  const svc = (volumes: unknown[]) => ({ volumes });
  const cfg = (o: { db?: unknown[]; runner?: unknown[] | null; e2e?: unknown[] | null }) => ({
    services: { db: svc(o.db ?? ['data:/goodboy-data']), ...(o.runner === null ? {} : { runner: svc(o.runner ?? ['data:/goodboy-data:ro']) }), ...(o.e2e === null ? {} : { e2e: svc(o.e2e ?? ['data:/goodboy-data:ro']) }) },
  });

  test('the database writes it, the test services read it only, as short or as long entries', () => {
    expect(hasDataVolume(cfg({}), ['db'])).toBe(true);
    const long = (ro: boolean) => ({ type: 'volume', source: 'data', target: '/goodboy-data', read_only: ro });
    expect(hasDataVolume(cfg({ db: [long(false)], runner: [long(true)], e2e: [long(true)] }), ['db'])).toBe(true);
    // a sandbox with no e2e service or no runner needs neither mount
    expect(hasDataVolume(cfg({ runner: null, e2e: null }), ['db'])).toBe(true);
  });

  test('a sandbox made before M6c (no mount anywhere) or a mount of the wrong kind does not count', () => {
    expect(hasDataVolume({ services: { db: svc(['db1data:/var/lib/postgresql/data']), runner: svc([]) } }, ['db'])).toBe(false);
    expect(hasDataVolume(cfg({ db: ['db1data:/var/lib/postgresql/data'] }), ['db'])).toBe(false);
    // the database must be able to write; the runner and e2e must not be able to
    expect(hasDataVolume(cfg({ db: ['data:/goodboy-data:ro'] }), ['db'])).toBe(false);
    expect(hasDataVolume(cfg({ runner: ['data:/goodboy-data'] }), ['db'])).toBe(false);
    expect(hasDataVolume(cfg({ e2e: [] }), ['db'])).toBe(false);
    // the reader clears the volume: a reader that cannot reach it leaves the values behind
    const withReader = (reader: unknown[]) => ({ services: { ...cfg({}).services, reader: svc(reader) } });
    expect(hasDataVolume(withReader(['data:/goodboy-data']), ['db'])).toBe(true);
    expect(hasDataVolume(withReader(['runout:/outroot']), ['db'])).toBe(false);
    expect(hasDataVolume(withReader(['data:/goodboy-data:ro']), ['db'])).toBe(false);
    expect(hasDataVolume(cfg({}), [])).toBe(false);
    expect(hasDataVolume(cfg({}), ['db2'])).toBe(false);
    expect(hasDataVolume(undefined, ['db'])).toBe(false);
    expect(hasDataVolume({ services: { db: { volumes: 'x' } } }, ['db'])).toBe(false);
    expect(hasDataVolume({ services: { db: { volumes: [null, 7] } } }, ['db'])).toBe(false);
  });

  describe('only the named volume `data` counts, and only the services that should hold it do', () => {
    const long = (o: Record<string, unknown>) => ({ type: 'volume', source: 'data', target: '/goodboy-data', ...o });
    const base = cfg({}).services;
    const withService = (name: string, volumes: unknown[]) => ({ services: { ...base, [name]: svc(volumes) } });
    const replace = (name: string, volumes: unknown[]) => ({ services: { ...base, [name]: svc(volumes) } });

    test('a bind, or another volume, at /goodboy-data in the database is no data volume (a repo directory would receive the values)', () => {
      for (const bad of [
        ['./values:/goodboy-data'],
        ['/repo/values:/goodboy-data'],
        ['live:/goodboy-data'],
        [{ type: 'bind', source: '/repo/values', target: '/goodboy-data' }],
        [{ type: 'volume', source: 'live', target: '/goodboy-data' }],
        [{ type: 'tmpfs', target: '/goodboy-data' }],
        ['/goodboy-data'],
      ]) expect([JSON.stringify(bad), hasDataVolume(replace('db', bad), ['db'])]).toEqual([JSON.stringify(bad), false]);
      // a long entry of the right kind, with no source, is not it either
      expect(hasDataVolume(replace('db', [{ type: 'volume', target: '/goodboy-data' }]), ['db'])).toBe(false);
    });

    test('a long entry of type bind whose source is the literal `data` is no data volume (db, reader, runner and e2e)', () => {
      const bind = (o: Record<string, unknown> = {}) => ({ type: 'bind', source: 'data', target: '/goodboy-data', ...o });
      for (const name of ['db', 'reader', 'runner', 'e2e']) {
        const ro = name === 'runner' || name === 'e2e';
        expect([name, hasDataVolume(replace(name, [bind(ro ? { read_only: true } : {})]), ['db'])]).toEqual([name, false]);
      }
    });

    test('a mount below the data path, as written or cleaned by docker, is refused for every service (the client would write through it)', () => {
      const below = [
        { type: 'bind', source: '/repo/leak.txt', target: '/goodboy-data/v.tmp' },
        { type: 'bind', source: '/repo/leak.txt', target: '/goodboy-data/values.tsv' },
        { type: 'bind', source: '/repo/dir', target: '/goodboy-data/sub' },
        { type: 'bind', source: '/repo/leak.txt', target: '/x/../goodboy-data/v.tmp' },
        { type: 'bind', source: '/repo/leak.txt', target: '/goodboy-data//v.tmp' },
        { type: 'bind', source: '/repo/leak.txt', target: '/goodboy-data/./v.tmp' },
        { type: 'bind', source: '/repo/leak.txt', target: '//goodboy-data/v.tmp' },
        { type: 'tmpfs', target: '/goodboy-data/sub' },
        { type: 'volume', source: 'live', target: '/goodboy-data/sub' },
        './leak.txt:/goodboy-data/v.tmp',
        './leak.txt:/x/../goodboy-data/v.tmp',
        'live:/goodboy-data/sub:ro',
        '/goodboy-data/sub',
      ];
      for (const extra of below) {
        for (const name of ['db', 'reader', 'runner', 'e2e', 'app', 'extra']) {
          const own = name === 'db' || name === 'reader' ? ['data:/goodboy-data'] : name === 'runner' || name === 'e2e' ? ['data:/goodboy-data:ro'] : [];
          const label = [name, JSON.stringify(extra)];
          expect([...label, hasDataVolume(replace(name, [...own, extra]), ['db'])]).toEqual([...label, false]);
        }
      }
      // the exact data mount, and a path that only starts with the same letters, are fine
      expect(hasDataVolume(replace('db', ['data:/goodboy-data', './x:/goodboy-data-other']), ['db'])).toBe(true);
      expect(hasDataVolume(replace('app', ['./x:/goodboy-datax/y', './y:/x/../work']), ['db'])).toBe(true);
    });

    test('volumes_from on any service is refused: it would hand over the mounts of the database or the runner', () => {
      for (const name of ['app', 'proxy', 'extra', 'reader', 'runner', 'e2e', 'db']) {
        for (const from of [['db'], ['db:ro'], ['runner'], ['app'], ['container:other'], 'db']) {
          const svcs = { ...base, [name]: { ...(base as Record<string, object>)[name], volumes: (base as Record<string, { volumes?: unknown[] }>)[name]?.volumes ?? (name === 'reader' ? ['data:/goodboy-data'] : []), volumes_from: from } };
          expect([name, JSON.stringify(from), hasDataVolume({ services: svcs }, ['db'])]).toEqual([name, JSON.stringify(from), false]);
        }
      }
      // an empty list says nothing
      expect(hasDataVolume({ services: { ...base, app: { volumes: [], volumes_from: [] } } }, ['db'])).toBe(true);
      expect(hasDataVolume({ services: { ...base, reader: { volumes: ['data:/goodboy-data'] } } }, ['db'])).toBe(true);
    });

    test('a top-level volume that is another key for the data volume, or an outside one, is refused', () => {
      const withTop = (volumes: unknown) => ({ ...cfg({}), volumes });
      const own = { data: { name: 'gb-abc_data' }, live: { name: 'gb-abc_live' } };
      expect(hasDataVolume(withTop(own), ['db'])).toBe(true);
      expect(hasDataVolume(withTop({ data: {}, live: {} }), ['db'])).toBe(true);
      expect(hasDataVolume(withTop({ ...own, alias: { name: 'gb-abc_data' } }), ['db'])).toBe(false);
      expect(hasDataVolume(withTop({ ...own, alias: { name: 'gb-abc_data', external: true } }), ['db'])).toBe(false);
      expect(hasDataVolume(withTop({ ...own, alias: { name: 'data' } }), ['db'])).toBe(false);
      expect(hasDataVolume(withTop({ data: { name: 'gb-abc_data', external: true } }), ['db'])).toBe(false);
      expect(hasDataVolume(withTop({ data: { external: true } }), ['db'])).toBe(false);
      expect(hasDataVolume(withTop({ ...own, other: { external: true, name: 'shared' } }), ['db'])).toBe(true);
      expect(hasDataVolume(withTop([]), ['db'])).toBe(false);
    });

    test('the same for the reader, the runner and the e2e service', () => {
      expect(hasDataVolume(replace('reader', [{ type: 'bind', source: '/repo', target: '/goodboy-data' }]), ['db'])).toBe(false);
      expect(hasDataVolume(replace('runner', ['./values:/goodboy-data:ro']), ['db'])).toBe(false);
      expect(hasDataVolume(replace('runner', [{ type: 'bind', source: '/repo', target: '/goodboy-data', read_only: true }]), ['db'])).toBe(false);
      expect(hasDataVolume(replace('e2e', ['live:/goodboy-data:ro']), ['db'])).toBe(false);
    });

    test('the volume at another path, or twice, is refused too', () => {
      expect(hasDataVolume(replace('db', ['data:/goodboy-data', 'data:/elsewhere']), ['db'])).toBe(false);
      expect(hasDataVolume(replace('db', ['data:/elsewhere']), ['db'])).toBe(false);
      expect(hasDataVolume(replace('db', ['data:/goodboy-data', 'data:/goodboy-data']), ['db'])).toBe(false);
      expect(hasDataVolume(replace('db', ['data:/goodboy-data', './x:/goodboy-data']), ['db'])).toBe(false);
      expect(hasDataVolume(replace('runner', ['data:/goodboy-data:ro', 'data:/more:ro']), ['db'])).toBe(false);
    });

    test('a service that holds the volume or the path without being one of them is refused: the app, the proxy, one added by hand', () => {
      for (const name of ['app', 'proxy', 'extra']) {
        for (const volumes of [['data:/goodboy-data'], ['data:/goodboy-data:ro'], [long({ read_only: true })], ['data:/somewhere'], ['./x:/goodboy-data'], [{ type: 'bind', source: '/repo', target: '/goodboy-data' }], ['/goodboy-data']]) {
          expect([name, JSON.stringify(volumes), hasDataVolume(withService(name, volumes), ['db'])]).toEqual([name, JSON.stringify(volumes), false]);
        }
      }
    });

    test('what a service mounts besides it does not matter: binds of the project, other volumes, anonymous volumes', () => {
      const others = ['../..:/work', 'build:/build:ro', './runtime/coverage.sh:/sandbox/coverage.sh:ro', '/var/cache/x', 'runout:/outroot', { type: 'bind', source: '/repo', target: '/work' }];
      for (const name of ['app', 'proxy', 'extra']) expect(hasDataVolume(withService(name, others), ['db'])).toBe(true);
      expect(hasDataVolume(replace('runner', [...others, 'data:/goodboy-data:ro']), ['db'])).toBe(true);
      expect(hasDataVolume(replace('db', ['db1data:/var/lib/postgresql/data', 'data:/goodboy-data']), ['db'])).toBe(true);
    });

    test('a mode other than rw and ro is not known, so it is refused', () => {
      expect(hasDataVolume(replace('runner', ['data:/goodboy-data:ro,z']), ['db'])).toBe(false);
      expect(hasDataVolume(replace('db', ['data:/goodboy-data:z']), ['db'])).toBe(false);
      expect(hasDataVolume(replace('db', ['data:/goodboy-data:rw']), ['db'])).toBe(true);
      expect(hasDataVolume(replace('db', [long({ read_only: false })]), ['db'])).toBe(true);
    });

    test('every SQL service is checked, not only the first', () => {
      const two = { services: { db: svc(['data:/goodboy-data']), db2: svc(['data:/goodboy-data']), runner: svc(['data:/goodboy-data:ro']) } };
      expect(hasDataVolume(two, ['db', 'db2'])).toBe(true);
      expect(hasDataVolume({ services: { ...two.services, db2: svc(['./x:/goodboy-data']) } }, ['db', 'db2'])).toBe(false);
    });
  });
});
