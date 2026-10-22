// Track M, M3 (plan §19): the UI check. A canned Caddy access log and a canned Playwright JSON
// report are joined against a small inventory.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdUiCheck, parseAccessLog, parseReport, uiCheck } from '../lib/ui-check';
import type { UiInventory, UiItem } from '../lib/ui-types';

const item = (o: Partial<UiItem> & Pick<UiItem, 'id' | 'kind'>): UiItem => ({ file: 'f', line: 1, input: false, label: o.id, ...o });

const INVENTORY: UiInventory = {
  root: '/x',
  contextPath: '/shop',
  notes: [],
  items: [
    item({ id: 'screen:GET:/orders', kind: 'screen', method: 'GET', route: '/orders' }),
    item({ id: 'screen:GET:/orders/{id}', kind: 'screen', method: 'GET', route: '/orders/{id}' }),
    item({ id: 'form:POST:/orders/save', kind: 'action', method: 'POST', route: '/orders/save', input: true }),
    item({ id: 'link:GET:/orders/new', kind: 'action', method: 'GET', route: '/orders/new' }),
    item({ id: 'button:t.html#refresh', kind: 'action' }),
    item({ id: 'api:GET:/api/orders', kind: 'api', method: 'GET', route: '/api/orders' }),
  ],
};

/** One Caddy access-log line. */
function entry(method: string, uri: string, status: number, claims: string[] = []): string {
  return JSON.stringify({
    level: 'info',
    ts: 1_700_000_000.5,
    logger: 'http.log.access.log0',
    msg: 'handled request',
    request: { remote_ip: '10.231.0.9', proto: 'HTTP/1.1', method, host: 'proxy:8080', uri, headers: { 'User-Agent': ['Playwright'], ...(claims.length > 0 ? { 'X-Goodboy-Ui': [claims.join(',')] } : {}) } },
    bytes_read: 0,
    duration: 0.01,
    size: 100,
    status,
    resp_headers: {},
  });
}

interface T {
  title: string;
  status?: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  result?: 'passed' | 'failed' | 'timedOut' | 'skipped';
  claims?: string[];
  expectedStatus?: string;
  annotations?: unknown[];
}

/** A Playwright JSON report with one suite per file, as the JSON reporter writes it. */
function report(tests: T[]): string {
  return JSON.stringify({
    config: {},
    suites: [
      {
        title: 'orders.spec.ts',
        file: 'orders.spec.ts',
        specs: tests.map((t) => ({
          title: t.title,
          ok: (t.status ?? 'expected') === 'expected',
          tests: [
            {
              projectName: 'chromium',
              expectedStatus: t.expectedStatus ?? 'passed',
              status: t.status ?? 'expected',
              annotations: t.annotations ?? (t.claims ?? []).map((c) => ({ type: 'goodboy-ui', description: c })),
              results: [{ status: t.result ?? ((t.status ?? 'expected') === 'expected' ? 'passed' : 'failed') }],
            },
          ],
        })),
      },
    ],
    errors: [],
    stats: {},
  });
}

const FULL_LOG = [
  entry('GET', '/shop/orders', 200, ['screen:GET:/orders:ok']),
  entry('GET', '/shop/css/site.css', 200, ['screen:GET:/orders:ok']),
  entry('GET', '/shop/orders/42', 200, ['screen:GET:/orders/{id}:ok']),
  entry('GET', '/shop/orders/new?from=list', 200, ['link:GET:/orders/new:ok']),
  entry('POST', '/shop/orders/save', 302, ['form:POST:/orders/save:ok']),
  entry('POST', '/shop/orders/save', 200, ['form:POST:/orders/save:error']),
  entry('GET', '/shop/orders', 200, ['button:t.html#refresh:ok']),
  entry('GET', '/shop/api/orders', 200, ['button:t.html#refresh:ok']),
].join('\n');

const FULL_REPORT = report([
  { title: 'lists orders', claims: ['screen:GET:/orders:ok'] },
  { title: 'shows an order', claims: ['screen:GET:/orders/{id}:ok'] },
  { title: 'follows the new link', claims: ['link:GET:/orders/new:ok'] },
  { title: 'saves an order', claims: ['form:POST:/orders/save:ok'] },
  { title: 'rejects a bad order', claims: ['form:POST:/orders/save:error'] },
  { title: 'refreshes', claims: ['button:t.html#refresh:ok'] },
]);

const check = (log = FULL_LOG, rep = FULL_REPORT, inv = INVENTORY) => uiCheck(inv, [log], [rep]);

describe('uiCheck', () => {
  test('full coverage passes: every item has its passing claim and a request that reached its route', () => {
    const r = check();
    expect(r).toEqual({ ok: true, items: 6, covered: 6, gaps: [], unknown_claims: [], problems: [] });
  });

  test('a form with input also needs an error claim with a matching request', () => {
    const report0 = report([
      { title: 'lists orders', claims: ['screen:GET:/orders:ok'] },
      { title: 'shows an order', claims: ['screen:GET:/orders/{id}:ok'] },
      { title: 'follows the new link', claims: ['link:GET:/orders/new:ok'] },
      { title: 'saves an order', claims: ['form:POST:/orders/save:ok'] },
      { title: 'refreshes', claims: ['button:t.html#refresh:ok'] },
    ]);
    const r = check(FULL_LOG, report0);
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([{ id: 'form:POST:/orders/save', missing: ['error'] }]);
    expect(r.covered).toBe(5);
  });

  test('an error claim whose request never reached the route is a request gap', () => {
    const log = FULL_LOG.split('\n').filter((l) => !l.includes(':error')).join('\n') + '\n' + entry('GET', '/shop/orders', 200, ['form:POST:/orders/save:error']);
    const r = check(log);
    expect(r.gaps).toEqual([{ id: 'form:POST:/orders/save', missing: ['request'] }]);
  });

  test('a claim without a matching request covers nothing: wrong path, wrong method, outside the context path, or an error status', () => {
    const cases: [string, string][] = [
      ['wrong path', entry('GET', '/shop/orders/', 200, ['screen:GET:/orders/{id}:ok'])],
      ['wrong method', entry('POST', '/shop/orders/42', 200, ['screen:GET:/orders/{id}:ok'])],
      ['no context path', entry('GET', '/orders/42', 200, ['screen:GET:/orders/{id}:ok'])],
      ['other context path', entry('GET', '/shopping/orders/42', 200, ['screen:GET:/orders/{id}:ok'])],
      ['status 404', entry('GET', '/shop/orders/42', 404, ['screen:GET:/orders/{id}:ok'])],
      ['status 500', entry('GET', '/shop/orders/42', 500, ['screen:GET:/orders/{id}:ok'])],
      ['claimed under another id', entry('GET', '/shop/orders/42', 200, ['screen:GET:/orders:ok'])],
      ['no header', entry('GET', '/shop/orders/42', 200)],
    ];
    for (const [name, line] of cases) {
      const log = FULL_LOG.split('\n').filter((l) => !l.includes('/shop/orders/42')).join('\n') + '\n' + line;
      const r = check(log);
      expect({ name, gaps: r.gaps }).toEqual({ name, gaps: [{ id: 'screen:GET:/orders/{id}', missing: ['request'] }] });
    }
  });

  test('a test that claims nothing is no coverage: no claim, a gap for ok', () => {
    const rep = report([{ title: 'lists orders', claims: [] }]);
    const r = check(FULL_LOG, rep);
    expect(r.ok).toBe(false);
    expect(r.gaps.filter((g) => g.id !== 'api:GET:/api/orders').every((g) => g.missing.includes('ok'))).toBe(true);
    expect(r.gaps.find((g) => g.id === 'form:POST:/orders/save')!.missing).toEqual(['ok', 'error']);
    expect(r.gaps).toHaveLength(6); // the api is reached by no passing claim either
    expect(r.gaps.find((g) => g.id === 'api:GET:/api/orders')!.missing).toEqual(['request']);
  });

  test('a failed, skipped, flaky or test.fail() test does not count, however good its requests', () => {
    for (const bad of [
      { status: 'unexpected', result: 'failed' },
      { status: 'unexpected', result: 'timedOut' },
      { status: 'skipped', result: 'skipped' },
      { status: 'flaky', result: 'passed' },
      { status: 'expected', result: 'failed', expectedStatus: 'failed' },
      { status: 'expected', result: 'skipped' },
    ] as Partial<T>[]) {
      const rep = report([
        { title: 'lists orders', claims: ['screen:GET:/orders:ok'], ...bad },
        { title: 'shows an order', claims: ['screen:GET:/orders/{id}:ok'] },
        { title: 'follows the new link', claims: ['link:GET:/orders/new:ok'] },
        { title: 'saves an order', claims: ['form:POST:/orders/save:ok'] },
        { title: 'rejects a bad order', claims: ['form:POST:/orders/save:error'] },
        { title: 'refreshes', claims: ['button:t.html#refresh:ok'] },
      ]);
      const r = check(FULL_LOG, rep);
      expect({ bad, gaps: r.gaps }).toEqual({ bad, gaps: [{ id: 'screen:GET:/orders', missing: ['ok'] }] });
    }
  });

  test('a failing test with the same claim as a passing one changes nothing for the passing one', () => {
    const rep = report([
      { title: 'lists orders (fails)', claims: ['screen:GET:/orders:ok'], status: 'unexpected' },
      { title: 'lists orders', claims: ['screen:GET:/orders:ok'] },
      { title: 'shows an order', claims: ['screen:GET:/orders/{id}:ok'] },
      { title: 'follows the new link', claims: ['link:GET:/orders/new:ok'] },
      { title: 'saves an order', claims: ['form:POST:/orders/save:ok'] },
      { title: 'rejects a bad order', claims: ['form:POST:/orders/save:error'] },
      { title: 'refreshes', claims: ['button:t.html#refresh:ok'] },
    ]);
    expect(check(FULL_LOG, rep).ok).toBe(true);
  });

  test('an item with no route needs only its passing ok claim', () => {
    const rep = report([{ title: 'refreshes', claims: ['button:t.html#refresh:ok'] }]);
    const r = uiCheck({ ...INVENTORY, items: [INVENTORY.items[4]!] }, [''], [rep]);
    expect(r).toEqual({ ok: true, items: 1, covered: 1, gaps: [], unknown_claims: [], problems: [] });
    expect(uiCheck({ ...INVENTORY, items: [INVENTORY.items[4]!] }, [''], [report([])]).gaps).toEqual([{ id: 'button:t.html#refresh', missing: ['ok'] }]);
  });

  test('an api is covered by any passing claim whose request reaches it; a failing test is no cover', () => {
    const noApi = FULL_LOG.split('\n').filter((l) => !l.includes('/api/orders')).join('\n');
    expect(check(noApi).gaps).toEqual([{ id: 'api:GET:/api/orders', missing: ['request'] }]);
    const failing = report([
      { title: 'lists orders', claims: ['screen:GET:/orders:ok'] },
      { title: 'shows an order', claims: ['screen:GET:/orders/{id}:ok'] },
      { title: 'follows the new link', claims: ['link:GET:/orders/new:ok'] },
      { title: 'saves an order', claims: ['form:POST:/orders/save:ok'] },
      { title: 'rejects a bad order', claims: ['form:POST:/orders/save:error'] },
      { title: 'refreshes', claims: ['button:t.html#refresh:ok'], status: 'unexpected' },
    ]);
    const r = check(FULL_LOG, failing);
    expect(r.gaps.map((g) => g.id).sort()).toEqual(['api:GET:/api/orders', 'button:t.html#refresh']);
  });

  test('a claim for an id that is not in the inventory is listed, and does not fail the check by itself', () => {
    const rep = report([
      { title: 'lists orders', claims: ['screen:GET:/orders:ok', 'screen:GET:/typo:ok'] },
      { title: 'shows an order', claims: ['screen:GET:/orders/{id}:ok'] },
      { title: 'follows the new link', claims: ['link:GET:/orders/new:ok'] },
      { title: 'saves an order', claims: ['form:POST:/orders/save:ok'] },
      { title: 'rejects a bad order', claims: ['form:POST:/orders/save:error'] },
      { title: 'refreshes', claims: ['button:t.html#refresh:ok'] },
    ]);
    const r = check(FULL_LOG, rep);
    expect(r.unknown_claims).toEqual(['screen:GET:/typo:ok']);
    expect(r.ok).toBe(true);
  });

  test('several claims in one header each count; the header name is matched without regard to case', () => {
    const line = JSON.stringify({ request: { method: 'GET', uri: '/shop/orders', headers: { 'x-goodboy-ui': ['screen:GET:/orders:ok, button:t.html#refresh:ok'] } }, status: 200 });
    const reqs = parseAccessLog(line, 'log', []);
    expect([...reqs[0]!.claims]).toEqual(['screen:GET:/orders:ok', 'button:t.html#refresh:ok']);
  });

  test('an ANY method serves every request method', () => {
    const inv: UiInventory = { ...INVENTORY, items: [item({ id: 'api:ANY:/api/x', kind: 'api', method: 'ANY', route: '/api/x' })] };
    const log = entry('DELETE', '/shop/api/x', 200, ['screen:GET:/orders:ok']);
    const rep = report([{ title: 't', claims: ['screen:GET:/orders:ok'] }]);
    expect(uiCheck(inv, [log], [rep]).ok).toBe(true);
  });
});

describe('malformed input fails closed', () => {
  test('a log line that is not JSON, has no request, or has no numeric status is a problem and fails the check', () => {
    for (const bad of ['not json', '{"msg":"x"}', JSON.stringify({ request: { method: 'GET', uri: '/x' }, status: '200' }), JSON.stringify({ request: { method: 'GET' }, status: 200 }), '[1,2]', 'null']) {
      const r = check(`${FULL_LOG}\n${bad}`);
      expect(r.ok).toBe(false);
      expect(r.problems.length).toBeGreaterThan(0);
      expect(r.problems[0]).toContain('access log:9');
      // the readable lines are still judged
      expect(r.covered).toBe(6);
    }
  });

  test('headers that are not an object or an X-Goodboy-Ui value that is not text fail the check', () => {
    const a = JSON.stringify({ request: { method: 'GET', uri: '/x', headers: [] }, status: 200 });
    const b = JSON.stringify({ request: { method: 'GET', uri: '/x', headers: { 'X-Goodboy-Ui': [7] } }, status: 200 });
    for (const line of [a, b]) expect(check(`${FULL_LOG}\n${line}`).ok).toBe(false);
  });

  test('a report that is not JSON, is not a report, or has a broken suite fails the check', () => {
    for (const bad of ['not json', '{}', '{"suites":{}}', '[]', JSON.stringify({ suites: [null] }), JSON.stringify({ suites: [{ title: 'a', specs: [{ title: 'b' }] }] }), JSON.stringify({ suites: [{ title: 'a', specs: {} }] })]) {
      const r = check(FULL_LOG, bad);
      expect(r.ok).toBe(false);
      expect(r.problems.length).toBeGreaterThan(0);
      expect(r.covered).toBeLessThan(6);
    }
  });

  test('an annotation that is not <id>:ok|error is a problem', () => {
    const rep = report([{ title: 'x', annotations: [{ type: 'goodboy-ui', description: 'screen:GET:/orders' }] }]);
    const r = check(FULL_LOG, rep);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('goodboy-ui annotation');
  });

  test('a report as Playwright 1.49 writes it for uiTest: the claims sit on tests inside an anonymous describe', () => {
    // captured from `playwright test` with the fixture of .goodboy/sandbox/e2e/goodboy-ui.ts, trimmed
    const real = '{"suites":[{"title":"a.spec.ts","suites":[{"title":"","suites":[],"specs":[{"title":"sends the claims","ok":true,"tests":[{"projectName":"","expectedStatus":"passed","status":"expected","annotations":[{"type":"goodboy-ui","description":"screen:GET:/orders:ok"},{"type":"goodboy-ui","description":"form:POST:/x:error"}],"results":[{"status":"passed"}]}]},{"title":"fails","ok":false,"tests":[{"projectName":"","expectedStatus":"passed","status":"unexpected","annotations":[{"type":"goodboy-ui","description":"screen:GET:/fail:ok"}],"results":[{"status":"failed"}]}]}]}],"specs":[]}]}';
    const problems: string[] = [];
    expect(parseReport(real, 'r', problems)).toEqual([
      { title: 'a.spec.ts > sends the claims', passed: true, claims: ['screen:GET:/orders:ok', 'form:POST:/x:error'] },
      { title: 'a.spec.ts > fails', passed: false, claims: ['screen:GET:/fail:ok'] },
    ]);
    expect(problems).toEqual([]);
  });

  test('annotations of other types are ignored', () => {
    const rep = report([{ title: 'x', annotations: [{ type: 'issue', description: 'ABC-1' }, { type: 'skip' }] }]);
    expect(parseReport(rep, 'r', [])[0]!.claims).toEqual([]);
  });

  test('no log and no report given is a problem, never a pass on nothing', () => {
    const r = uiCheck({ ...INVENTORY, items: [] }, [], []);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(['no access log was given', 'no Playwright report was given']);
  });

  test('a log of many bad lines names the first ones and counts the rest', () => {
    const r = check(Array.from({ length: 50 }, () => 'junk').join('\n'));
    expect(r.problems.length).toBeLessThanOrEqual(21);
    expect(r.problems.some((p) => p.includes('50 unreadable lines'))).toBe(true);
  });
});

describe('ui-check command', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  function project(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m3c-')));
    dirs.push(root);
    return root;
  }
  const writeRun = (root: string, name: string, log: string, rep: string): string => {
    const dir = join(root, '.goodboy', 'sandbox', 'out', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'access.log'), log);
    writeFileSync(join(dir, 'playwright-report.json'), rep);
    return dir;
  };
  const invFile = (root: string): string => {
    const p = join(root, 'inv.json');
    writeFileSync(p, JSON.stringify(INVENTORY));
    return p;
  };

  test('reads the newest run, a given inventory, and exits 0 when everything is covered', () => {
    const root = project();
    writeRun(root, '20261022T100000Z', 'junk', 'junk');
    const newest = writeRun(root, '20261022T110000Z', FULL_LOG, FULL_REPORT);
    const r = cmdUiCheck(root, ['--inventory', invFile(root)]);
    expect('out' in r && r.code).toBe(0);
    expect('out' in r && (r.out as { run: string; ok: boolean }).run).toBe(newest);
    expect('out' in r && (r.out as { ok: boolean }).ok).toBe(true);
  });

  test('a run with gaps exits 1 and lists them; --run picks another run', () => {
    const root = project();
    writeRun(root, '20261022T100000Z', FULL_LOG, report([]));
    writeRun(root, '20261022T110000Z', FULL_LOG, FULL_REPORT);
    const r = cmdUiCheck(root, ['--run', '20261022T100000Z', '--inventory', invFile(root)]);
    expect('out' in r && r.code).toBe(1);
    expect('out' in r && (r.out as { gaps: unknown[] }).gaps.length).toBe(6);
  });

  test('--log and --report take files; a malformed one gives exit 1 with the problem', () => {
    const root = project();
    writeFileSync(join(root, 'a.log'), 'junk\n');
    writeFileSync(join(root, 'r.json'), FULL_REPORT);
    const r = cmdUiCheck(root, ['--log', 'a.log', '--report', 'r.json', '--inventory', invFile(root)]);
    expect('out' in r && r.code).toBe(1);
    expect('out' in r && (r.out as { problems: string[] }).problems[0]).toContain('is not JSON');
  });

  test('missing files, unknown options, a bad run name and a bad inventory are errors, not results', () => {
    const root = project();
    const inv = invFile(root);
    expect(cmdUiCheck(root, ['--inventory', inv])).toEqual({ error: expect.stringContaining('no run with an access log') });
    expect(cmdUiCheck(root, ['--log', 'nope.log', '--report', 'nope.json', '--inventory', inv])).toEqual({ error: expect.stringContaining('does not exist') });
    expect(cmdUiCheck(root, ['--bogus'])).toEqual({ error: expect.stringContaining('--bogus') });
    expect(cmdUiCheck(root, ['--run', '../x', '--inventory', inv])).toEqual({ error: expect.stringContaining('run name') });
    expect(cmdUiCheck(root, ['--run'])).toEqual({ error: expect.stringContaining('needs a value') });
    writeFileSync(join(root, 'bad.json'), '{"items":[{"id":1}]}');
    writeFileSync(join(root, 'a.log'), '');
    writeFileSync(join(root, 'r.json'), FULL_REPORT);
    expect(cmdUiCheck(root, ['--log', 'a.log', '--report', 'r.json', '--inventory', 'bad.json'])).toEqual({ error: expect.stringContaining('not an inventory') });
    expect(cmdUiCheck(root, ['--run', '20261022T110000Z', '--log', 'a.log'])).toEqual({ error: expect.stringContaining('cannot be combined') });
  });
});
