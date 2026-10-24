// The UI check (track M, M3; plan §19): did the browser tests reach every screen and action of the
// inventory, as the server saw it? Two records are joined:
//   - the proxy's access log (Caddy, JSON lines): each request with its method, URI, status, the
//     `X-Goodboy-Test` nonce of the test that sent it, the `X-Goodboy-Ui` claims, and the headers
//     that tell a page navigation from a script's request;
//   - the Playwright JSON report: each test with its status, its `goodboy-ui` annotations
//     (`<id>:ok|error`) and its `goodboy-test` nonce, which `uiTest` in
//     `.goodboy/sandbox/e2e/goodboy-ui.ts` writes.
// The join is per test: a request belongs to the test whose nonce it carries, so a claim is met
// only by requests of a passing test that holds that claim (a failing test, or another test with
// the same claim, covers nothing; a request with no nonce counts for nothing). A passing test
// with claims and no nonce is a problem: its requests cannot be told from another test's.
// Anything unreadable fails the check; it never passes on what it could not read.
//
// Rules (a "navigation" is a request the browser made to load a page: `Upgrade-Insecure-Requests`,
// `Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`, or an `Accept` for `text/html`; a
// script's fetch or the `request` fixture sends none of them):
//   screen, form, link, button with a route
//                   a passing `<id>:ok` test with a navigation to the route answered below 400; an
//                   item with `input` (a form with fields; a POST, PUT or PATCH) also needs a
//                   passing `<id>:error` test with a navigation to the route (any status: a form
//                   shown again with its errors answers 200)
//   ajax            the same with any request of the test to the route
//   item without a route (button, click, submit, a self-posting form)
//                   a passing claim whose test loaded at least one page
//   api             covered when a passing test sent a request that reaches its route
// Evidence strength: the test code can set any header itself, and the access log lives in a dir
// the test run can write; this check judges what the files say, as the coverage gate does.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readRegular } from './safe-read';
import { SANDBOX_DIR } from './sandbox-render';
import { uiInventory } from './ui-inventory';
import {
  ACCESS_LOG_FILE,
  NONCE_ANNOTATION,
  NONCE_HEADER,
  NONCE_RE,
  PLAYWRIGHT_REPORT_FILE,
  RouteIndex,
  type UiInventory,
  type UiItem,
  methodMatches,
  parseClaim,
  pathOf,
  underContext,
} from './ui-types';

export type Missing = 'ok' | 'error' | 'request';

export interface UiGap {
  id: string;
  missing: Missing[];
}

export interface UiCheckResult {
  ok: boolean;
  /** How many items the inventory has, and how many of them are covered. */
  items: number;
  covered: number;
  gaps: UiGap[];
  /** Claims of tests that name no item of the inventory (a typo or an item that is gone). */
  unknown_claims: string[];
  /** Why a log or a report could not be trusted; any of these fails the check. */
  problems: string[];
}

export interface Req {
  method: string;
  path: string;
  status: number;
  claims: Set<string>;
  /** The `X-Goodboy-Test` nonce of the test that sent it; null when it carries none. */
  nonce: string | null;
  /** The browser made it to load a page (see the rules above). */
  nav: boolean;
}

interface TestClaims {
  title: string;
  passed: boolean;
  claims: string[];
  /** The test's `goodboy-test` nonce; null when it has none. */
  nonce: string | null;
}

const CLAIM_HEADER = 'x-goodboy-ui';
const MAX_PROBLEMS = 20;

/** Calls `on` for each request of one access log, one line at a time (no list of all requests is
 *  built); a line that is not an access entry is a problem. */
function eachRequest(text: string, label: string, problems: string[], on: (r: Req) => void): void {
  let bad = 0;
  let n = 0;
  const fail = (why: string) => {
    bad++;
    if (problems.length < MAX_PROBLEMS) problems.push(`${label}:${n} ${why}`);
  };
  for (let from = 0; from <= text.length; ) {
    let to = text.indexOf('\n', from);
    if (to < 0) to = text.length;
    const raw = text.slice(from, to);
    from = to + 1;
    n++;
    const line = raw.trim();
    if (line === '') continue;
    // A line that does not open an object is no entry (`[]` and `null` are JSON, but no entry
    //   either); saying so without JSON.parse throwing for it (a thrown error costs most of a
    //   microsecond: 16 MiB of garbage lines took 6.6 s).
    if (line.charCodeAt(0) !== 123) {
      fail('is not a JSON object');
      continue;
    }
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      fail('is not JSON');
      continue;
    }
    const r = (e as { request?: { method?: unknown; uri?: unknown; headers?: unknown } } | null)?.request;
    const status = (e as { status?: unknown } | null)?.status;
    if (typeof r !== 'object' || r === null || typeof r.method !== 'string' || typeof r.uri !== 'string') {
      fail('has no request with a method and a uri');
      continue;
    }
    if (typeof status !== 'number' || !Number.isFinite(status)) {
      fail('has no numeric status');
      continue;
    }
    const claims = new Set<string>();
    let nonce: string | null = null;
    let nav = false;
    const headers = r.headers;
    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) {
      fail('has headers that are not an object');
      continue;
    }
    let badHeader: string | null = null;
    for (const [k, v] of Object.entries((headers as Record<string, unknown> | undefined) ?? {})) {
      const name = k.toLowerCase();
      if (name !== CLAIM_HEADER && name !== NONCE_HEADER && !NAV_HEADERS.has(name)) continue;
      const values = Array.isArray(v) ? v : [v];
      for (const one of values) {
        if (typeof one !== 'string') {
          badHeader = k;
          break;
        }
        if (name === CLAIM_HEADER) {
          for (const c of one.split(',')) if (c.trim() !== '') claims.add(c.trim());
        } else if (name === NONCE_HEADER) {
          if (NONCE_RE.test(one.trim())) nonce = one.trim();
        } else if (isNavHeader(name, one)) nav = true;
      }
    }
    if (badHeader !== null) {
      fail(`has a ${badHeader} header that is not text`);
      continue;
    }
    on({ method: r.method.toUpperCase(), path: pathOf(r.uri), status, claims, nonce, nav });
  }
  if (bad > MAX_PROBLEMS) problems.push(`${label}: ${bad} unreadable lines in all`);
}

const NAV_HEADERS = new Set(['upgrade-insecure-requests', 'sec-fetch-mode', 'sec-fetch-dest', 'accept']);
function isNavHeader(name: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (name === 'upgrade-insecure-requests') return v === '1';
  if (name === 'sec-fetch-mode') return v === 'navigate';
  if (name === 'sec-fetch-dest') return v === 'document';
  return v.startsWith('text/html'); // accept
}

/** The requests of one access log; a line that is not an access entry is a problem. */
export function parseAccessLog(text: string, label: string, problems: string[]): Req[] {
  const out: Req[] = [];
  eachRequest(text, label, problems, (r) => out.push(r));
  return out;
}

interface RawTest {
  status?: unknown;
  expectedStatus?: unknown;
  annotations?: unknown;
  results?: unknown;
}

/** The tests of one Playwright JSON report; a report of another shape is a problem. */
export function parseReport(text: string, label: string, problems: string[]): TestClaims[] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    problems.push(`${label} is not JSON`);
    return [];
  }
  const root = j as { suites?: unknown } | null;
  if (typeof root !== 'object' || root === null || !Array.isArray(root.suites)) {
    problems.push(`${label} is not a Playwright JSON report (no suites array)`);
    return [];
  }
  const out: TestClaims[] = [];
  const walk = (suite: unknown, path: string[]): void => {
    const s = suite as { title?: unknown; suites?: unknown; specs?: unknown } | null;
    if (typeof s !== 'object' || s === null) {
      problems.push(`${label} has a suite that is not an object`);
      return;
    }
    const here = typeof s.title === 'string' && s.title !== '' ? [...path, s.title] : path;
    if (s.specs !== undefined && !Array.isArray(s.specs)) problems.push(`${label} has a suite whose specs are not a list`);
    for (const spec of Array.isArray(s.specs) ? s.specs : []) {
      const sp = spec as { title?: unknown; tests?: unknown; annotations?: unknown } | null;
      if (typeof sp !== 'object' || sp === null || !Array.isArray(sp.tests)) {
        problems.push(`${label} has a spec with no tests list`);
        continue;
      }
      const title = [...here, typeof sp.title === 'string' ? sp.title : '?'].join(' > ');
      for (const t of sp.tests as RawTest[]) {
        if (typeof t !== 'object' || t === null) {
          problems.push(`${label}: a test of "${title}" is not an object`);
          continue;
        }
        const results = Array.isArray(t.results) ? (t.results as { status?: unknown }[]) : [];
        const last = results[results.length - 1];
        // 'expected' with a final 'passed' result: not skipped, not flaky, not a test.fail() that failed as declared
        const passed = t.status === 'expected' && (t.expectedStatus === undefined || t.expectedStatus === 'passed') && last?.status === 'passed';
        const claims: string[] = [];
        const nonces = new Set<string>();
        for (const list of [t.annotations, sp.annotations]) {
          if (list === undefined) continue;
          if (!Array.isArray(list)) {
            problems.push(`${label}: the annotations of "${title}" are not a list`);
            continue;
          }
          for (const a of list as { type?: unknown; description?: unknown }[]) {
            if (typeof a !== 'object' || a === null) continue;
            if (a.type === NONCE_ANNOTATION) {
              if (typeof a.description !== 'string' || !NONCE_RE.test(a.description.trim())) problems.push(`${label}: "${title}" has a ${NONCE_ANNOTATION} annotation that is not a nonce`);
              else nonces.add(a.description.trim());
              continue;
            }
            if (a.type !== 'goodboy-ui') continue;
            if (typeof a.description !== 'string' || parseClaim(a.description) === null) problems.push(`${label}: "${title}" has a goodboy-ui annotation that is not <id>:ok|error`);
            else claims.push(a.description.trim());
          }
        }
        if (nonces.size > 1) problems.push(`${label}: "${title}" has several ${NONCE_ANNOTATION} nonces`);
        out.push({ title, passed, claims, nonce: nonces.size === 1 ? [...nonces][0]! : null });
      }
    }
    if (s.suites !== undefined && !Array.isArray(s.suites)) problems.push(`${label} has a suite whose suites are not a list`);
    for (const child of Array.isArray(s.suites) ? s.suites : []) walk(child, here);
  };
  for (const s of root.suites) walk(s, []);
  return out;
}

/** Judges the e2e run against the inventory. `accessLogs` and `playwrightReports` are the texts of
 *  the files (JSON lines; JSON). */
export function uiCheck(inventory: UiInventory, accessLogs: string[], playwrightReports: string[]): UiCheckResult {
  const problems: string[] = [];
  const tests: TestClaims[] = [];
  playwrightReports.forEach((t, i) => tests.push(...parseReport(t, playwrightReports.length === 1 ? 'Playwright report' : `Playwright report ${i + 1}`, problems)));
  if (accessLogs.length === 0) problems.push('no access log was given');
  // An inventory a cap or the time cut short lists fewer items than the app has: a pass on it would
  //   be a pass on the items it kept.
  for (const why of inventory.truncated ?? []) problems.push(`the inventory is incomplete: ${why}`);
  // Nothing to cover is a pass only when the inventory says the project has no UI source: an
  //   inventory that found nothing in a project with templates, scripts or controllers has not read it.
  if (inventory.items.length === 0 && inventory.noUi !== true && (inventory.truncated ?? []).length === 0) {
    problems.push('no UI items found: the inventory lists no screen, action or API and does not say the project has no UI source (see its notes); a pass on nothing is no pass');
  }
  if (playwrightReports.length === 0) problems.push('no Playwright report was given');

  const byId = new Map<string, UiItem>(inventory.items.map((i) => [i.id, i]));
  const unknown = new Set<string>();
  for (const t of tests) for (const c of t.claims) if (!byId.has(parseClaim(c)!.id)) unknown.add(c);

  // The passing tests that hold claims, by their nonce, and who holds each claim.
  const holdersOf = new Map<string, string[]>();
  const testOf = new Set<string>();
  let unbound = 0;
  for (const t of tests) {
    if (!t.passed || t.claims.length === 0) continue;
    if (t.nonce === null) {
      if (++unbound <= MAX_PROBLEMS) problems.push(`"${t.title}" passed with ui claims but has no ${NONCE_ANNOTATION} nonce, so its requests cannot be told from another test's: regenerate the e2e fixture (sandbox-init --force) and run again`);
      continue;
    }
    if (testOf.has(t.nonce)) {
      problems.push(`two passing tests share the ${NONCE_ANNOTATION} nonce ${t.nonce} ("${t.title}"): the requests cannot be told apart`);
      continue;
    }
    testOf.add(t.nonce);
    for (const c of new Set(t.claims)) {
      const l = holdersOf.get(c);
      if (l) l.push(t.nonce);
      else holdersOf.set(c, [t.nonce]);
    }
  }
  if (unbound > MAX_PROBLEMS) problems.push(`${unbound} passing tests have no ${NONCE_ANNOTATION} nonce`);

  // What each request did, by one walk of the log: the items it reaches (a trie over the routes),
  //   kept per test (its nonce) as bit flags; requests with no nonce, or the nonce of a test that
  //   did not pass or holds no claim, are dropped at once.
  const ANY = 1;
  const OK = 2;
  const NAV = 4;
  const NAV_OK = 8;
  const routed = new RouteIndex<UiItem>();
  for (const item of inventory.items) if (item.route !== undefined) routed.add(item.route, item);
  const flags = new Map<string, number>();
  const loadedPage = new Set<string>(); // nonces of tests that made a navigation
  const apiReached = new Set<string>(); // ids of api items a passing test's request reached
  accessLogs.forEach((text, i) => {
    eachRequest(text, accessLogs.length === 1 ? 'access log' : `access log ${i + 1}`, problems, (r) => {
      if (r.nonce === null || !testOf.has(r.nonce)) return;
      if (r.nav) loadedPage.add(r.nonce);
      const path = underContext(r.path, inventory.contextPath);
      if (path === null) return;
      for (const item of routed.find(path)) {
        if (!methodMatches(item.method, r.method)) continue;
        if (item.kind === 'api') {
          apiReached.add(item.id);
          continue;
        }
        const key = `${r.nonce}\0${item.id}`;
        const ok = r.status < 400;
        flags.set(key, (flags.get(key) ?? 0) | ANY | (ok ? OK : 0) | (r.nav ? NAV : 0) | (r.nav && ok ? NAV_OK : 0));
      }
    });
  });

  /** Whether the test with this nonce met the claim `<item>:<kind>` with its requests. */
  const met = (item: UiItem, kind: 'ok' | 'error', nonce: string): boolean => {
    if (item.route === undefined) return loadedPage.has(nonce); // no route to reach: it loaded a page
    const f = flags.get(`${nonce}\0${item.id}`) ?? 0;
    if (item.id.startsWith('ajax:')) return (f & (kind === 'error' ? ANY : OK)) !== 0;
    return (f & (kind === 'error' ? NAV : NAV_OK)) !== 0; // a page, a form submit or a link: a navigation
  };

  const gaps: UiGap[] = [];
  let covered = 0;
  for (const item of inventory.items) {
    const missing: Missing[] = [];
    if (item.kind === 'api') {
      if (!apiReached.has(item.id)) missing.push('request');
    } else {
      const need: ('ok' | 'error')[] = item.input ? ['ok', 'error'] : ['ok'];
      for (const kind of need) {
        const holders = holdersOf.get(`${item.id}:${kind}`);
        if (holders === undefined) {
          missing.push(kind);
          continue;
        }
        if (!holders.some((n) => met(item, kind, n)) && !missing.includes('request')) missing.push('request');
      }
    }
    if (missing.length === 0) covered++;
    else gaps.push({ id: item.id, missing });
  }
  return { ok: problems.length === 0 && gaps.length === 0, items: inventory.items.length, covered, gaps, unknown_claims: [...unknown].sort(), problems };
}

// ---- the command ----

/** The most of an access log read: the copy `sandbox-run` makes into the run dir refuses a larger one. */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const KINDS = new Set(['screen', 'action', 'api']);

/** All the values of a repeatable option; an Error when one has no value. */
function optValues(args: string[], name: string): string[] | Error {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) return new Error(`${name} needs a value`);
    out.push(v);
  }
  return out;
}

/** The newest `out/<ts>` dir that has an access log and a report, or null. */
function latestRun(root: string): string | null {
  const out = join(root, SANDBOX_DIR, 'out');
  let names: string[];
  try {
    names = readdirSync(out);
  } catch {
    return null;
  }
  const runs = names.filter((n) => /^\d{8}T\d{6}Z$/.test(n) && existsSync(join(out, n, ACCESS_LOG_FILE)) && existsSync(join(out, n, PLAYWRIGHT_REPORT_FILE)));
  runs.sort();
  return runs.length > 0 ? runs[runs.length - 1]! : null;
}

function readInventory(file: string): UiInventory | Error {
  const r = readRegular(file, 16 * 1024 * 1024, true);
  if (typeof r !== 'object') return new Error(`${file} is not a readable regular file`);
  try {
    const j = JSON.parse(r.text) as UiInventory;
    const ok =
      typeof j === 'object' &&
      j !== null &&
      typeof j.contextPath === 'string' &&
      Array.isArray(j.items) &&
      (j.truncated === undefined || (Array.isArray(j.truncated) && j.truncated.every((t) => typeof t === 'string'))) &&
      j.items.every((i) => typeof i === 'object' && i !== null && typeof i.id === 'string' && KINDS.has(i.kind) && typeof i.input === 'boolean' && (i.route === undefined || typeof i.route === 'string') && (i.method === undefined || typeof i.method === 'string'));
    if (ok) return j;
  } catch {
    // below
  }
  return new Error(`${file} is not an inventory ui-inventory wrote`);
}

/** `ui-check [--run <ts>] [--log <file>]... [--report <file>]... [--inventory <file>]`: judges an
 *  e2e run. By default the newest run under `.goodboy/sandbox/out/` and a fresh inventory. The
 *  exit code is 0 only when every item is covered and every file was readable. */
export function cmdUiCheck(root: string, args: string[]): { out: unknown; code: number } | { error: string } {
  const known = new Set(['--run', '--log', '--report', '--inventory']);
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith('--')) continue;
    if (!known.has(args[i]!)) return { error: `ui-check: unknown option ${args[i]}` };
    i++;
  }
  const runs = optValues(args, '--run');
  const logOpts = optValues(args, '--log');
  const reportOpts = optValues(args, '--report');
  const invOpts = optValues(args, '--inventory');
  for (const v of [runs, logOpts, reportOpts, invOpts]) if (v instanceof Error) return { error: `ui-check: ${v.message}` };
  const inv0 = invOpts as string[];
  if ((runs as string[]).length > 1 || inv0.length > 1) return { error: 'ui-check: --run and --inventory take one value' };
  let run: string | null = null;
  let logs = logOpts as string[];
  let reports = reportOpts as string[];
  if (logs.length === 0 && reports.length === 0) {
    const name = (runs as string[])[0] ?? latestRun(root);
    if (name === null) return { error: 'ui-check: no run with an access log and a Playwright report under .goodboy/sandbox/out/; run sandbox-run --suite e2e, or pass --log and --report' };
    if (!/^\d{8}T\d{6}Z$/.test(name)) return { error: 'ui-check: --run is a run name like 20261022T101500Z' };
    const dir = join(root, SANDBOX_DIR, 'out', name);
    try {
      if (!statSync(dir).isDirectory()) throw new Error('not a dir');
    } catch {
      return { error: `ui-check: ${dir} is not a run dir` };
    }
    run = dir;
    logs = [join(dir, ACCESS_LOG_FILE)];
    reports = [join(dir, PLAYWRIGHT_REPORT_FILE)];
  } else if ((runs as string[]).length > 0) return { error: 'ui-check: --run cannot be combined with --log or --report' };
  const read = (p: string, max: number, what: string): string | Error => {
    const abs = isAbsolute(p) ? p : resolve(root, p);
    const r = readRegular(abs, max);
    if (r === 'absent') return new Error(`${what} ${abs} does not exist`);
    if (r === 'refused') return new Error(`${what} ${abs} is not a regular file of at most ${max} bytes`);
    return r.text;
  };
  const logTexts: string[] = [];
  for (const p of logs) {
    const t = read(p, MAX_LOG_BYTES, 'the access log');
    if (t instanceof Error) return { error: `ui-check: ${t.message}` };
    logTexts.push(t);
  }
  const reportTexts: string[] = [];
  for (const p of reports) {
    const t = read(p, MAX_REPORT_BYTES, 'the Playwright report');
    if (t instanceof Error) return { error: `ui-check: ${t.message}` };
    reportTexts.push(t);
  }
  let inventory: UiInventory;
  if (inv0.length === 1) {
    const abs = isAbsolute(inv0[0]!) ? inv0[0]! : resolve(root, inv0[0]!);
    const i = readInventory(abs);
    if (i instanceof Error) return { error: `ui-check: ${i.message}` };
    inventory = i;
  } else inventory = uiInventory(root);
  const result = uiCheck(inventory, logTexts, reportTexts);
  return { out: { run, logs, reports, ...result, notes: inventory.notes }, code: result.ok ? 0 : 1 };
}
