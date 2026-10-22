// The UI check (track M, M3; plan §19): did the browser tests reach every screen and action of the
// inventory, as the server saw it? Two records are joined:
//   - the proxy's access log (Caddy, JSON lines): each request with its method, URI, status and the
//     `X-Goodboy-Ui` header the test sent (`<id>:ok|error`, several separated by commas);
//   - the Playwright JSON report: each test with its status and its `goodboy-ui` annotations
//     (`<id>:ok|error`), which `uiTest` in `.goodboy/sandbox/e2e/goodboy-ui.ts` writes.
// A claim counts only when a passing test holds it, and for an item with a route only when a
// logged request under that claim matches the route (method, path, context path): a test that
// claims a screen without visiting it covers nothing. Anything unreadable fails the check; it
// never passes on what it could not read.
//
// Rules:
//   screen, action  a passing `<id>:ok` test with a matching request answered below 400; an item
//                   with `input` (a form with fields; a POST, PUT or PATCH) also needs a passing
//                   `<id>:error` test with a matching request (any status: a form shown again
//                   with its errors answers 200)
//   api             covered when a request of any passing claim reaches its route

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readRegular } from './safe-read';
import { SANDBOX_DIR } from './sandbox-render';
import { uiInventory } from './ui-inventory';
import { ACCESS_LOG_FILE, PLAYWRIGHT_REPORT_FILE, type UiInventory, type UiItem, methodMatches, parseClaim, pathOf, routeMatches, underContext } from './ui-types';

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

interface Req {
  method: string;
  path: string;
  status: number;
  claims: Set<string>;
}

interface TestClaims {
  title: string;
  passed: boolean;
  claims: string[];
}

const CLAIM_HEADER = 'x-goodboy-ui';
const MAX_PROBLEMS = 20;

/** The requests of one access log; a line that is not an access entry is a problem. */
export function parseAccessLog(text: string, label: string, problems: string[]): Req[] {
  const out: Req[] = [];
  const lines = text.split('\n');
  let bad = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '') return;
    const fail = (why: string) => {
      bad++;
      if (problems.length < MAX_PROBLEMS) problems.push(`${label}:${i + 1} ${why}`);
    };
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      return fail('is not JSON');
    }
    const r = (e as { request?: { method?: unknown; uri?: unknown; headers?: unknown } } | null)?.request;
    const status = (e as { status?: unknown } | null)?.status;
    if (typeof r !== 'object' || r === null || typeof r.method !== 'string' || typeof r.uri !== 'string') return fail('has no request with a method and a uri');
    if (typeof status !== 'number' || !Number.isFinite(status)) return fail('has no numeric status');
    const claims = new Set<string>();
    const headers = r.headers;
    if (headers !== undefined && (typeof headers !== 'object' || headers === null || Array.isArray(headers))) return fail('has headers that are not an object');
    for (const [k, v] of Object.entries((headers as Record<string, unknown> | undefined) ?? {})) {
      if (k.toLowerCase() !== CLAIM_HEADER) continue;
      const values = Array.isArray(v) ? v : [v];
      for (const one of values) {
        if (typeof one !== 'string') return fail(`has a ${k} header that is not text`);
        for (const c of one.split(',')) if (c.trim() !== '') claims.add(c.trim());
      }
    }
    out.push({ method: r.method.toUpperCase(), path: pathOf(r.uri), status, claims });
  });
  if (bad > MAX_PROBLEMS) problems.push(`${label}: ${bad} unreadable lines in all`);
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
        for (const list of [t.annotations, sp.annotations]) {
          if (list === undefined) continue;
          if (!Array.isArray(list)) {
            problems.push(`${label}: the annotations of "${title}" are not a list`);
            continue;
          }
          for (const a of list as { type?: unknown; description?: unknown }[]) {
            if (typeof a !== 'object' || a === null || a.type !== 'goodboy-ui') continue;
            if (typeof a.description !== 'string' || parseClaim(a.description) === null) problems.push(`${label}: "${title}" has a goodboy-ui annotation that is not <id>:ok|error`);
            else claims.push(a.description.trim());
          }
        }
        out.push({ title, passed, claims });
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
  const reqs: Req[] = [];
  accessLogs.forEach((t, i) => reqs.push(...parseAccessLog(t, accessLogs.length === 1 ? 'access log' : `access log ${i + 1}`, problems)));
  const tests: TestClaims[] = [];
  playwrightReports.forEach((t, i) => tests.push(...parseReport(t, playwrightReports.length === 1 ? 'Playwright report' : `Playwright report ${i + 1}`, problems)));
  if (accessLogs.length === 0) problems.push('no access log was given');
  if (playwrightReports.length === 0) problems.push('no Playwright report was given');

  const passing = new Set<string>();
  for (const t of tests) if (t.passed) for (const c of t.claims) passing.add(c);
  const byId = new Map<string, UiItem>(inventory.items.map((i) => [i.id, i]));
  const unknown = new Set<string>();
  for (const t of tests) for (const c of t.claims) if (!byId.has(parseClaim(c)!.id)) unknown.add(c);

  // a request counts under a claim only when a passing test holds that claim
  const underPassing = reqs.filter((r) => [...r.claims].some((c) => passing.has(c)));

  const reaches = (item: UiItem, r: Req): boolean => {
    if (item.route === undefined) return true;
    if (!methodMatches(item.method, r.method)) return false;
    const path = underContext(r.path, inventory.contextPath);
    return path !== null && routeMatches(item.route, path);
  };

  const gaps: UiGap[] = [];
  let covered = 0;
  for (const item of inventory.items) {
    const missing: Missing[] = [];
    if (item.kind === 'api') {
      if (!underPassing.some((r) => reaches(item, r))) missing.push('request');
    } else {
      const need: ('ok' | 'error')[] = item.input ? ['ok', 'error'] : ['ok'];
      for (const kind of need) {
        const claim = `${item.id}:${kind}`;
        if (!passing.has(claim)) {
          missing.push(kind);
          continue;
        }
        if (item.route === undefined) continue;
        const seen = reqs.some((r) => r.claims.has(claim) && reaches(item, r) && (kind === 'error' || r.status < 400));
        if (!seen && !missing.includes('request')) missing.push('request');
      }
    }
    if (missing.length === 0) covered++;
    else gaps.push({ id: item.id, missing });
  }
  return { ok: problems.length === 0 && gaps.length === 0, items: inventory.items.length, covered, gaps, unknown_claims: [...unknown].sort(), problems };
}

// ---- the command ----

const MAX_LOG_BYTES = 256 * 1024 * 1024;
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
  return { out: { run, logs, reports, ...result }, code: result.ok ? 0 : 1 };
}
