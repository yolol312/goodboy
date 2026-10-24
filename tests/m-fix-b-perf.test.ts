// Track M fix round 1, fixer B (plan §19): the scan, the UI inventory and the UI check are linear in
// what they read. Each case builds one pathological project (a file of one repeated unit that used
// to make a regex or a loop rescan to the end of the text from every start) and times one call in a
// child process, so that a case that is still quadratic is killed at the limit instead of freezing
// the run. The bounds are generous: the linear code takes a small fraction of them, the quadratic
// code took 2 s to more than a minute at these sizes.
//
// Four cases were already fast before the fixes (inv-express-open-routes, scan-properties-continuation,
// inv-fastapi-decorators, inv-html-forms-no-close: 0.1 to 0.7 s at HEAD): they are guards against a
// regression, not proofs of a fix. Their limits are the same as the others'.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const WORKER = join(import.meta.dir, 'm-fix-b-perf-case.ts');
/** A child still running at this point is killed and its case fails (GOODBOY_PERF_KILL_MS shortens it
 *  when the tests are run against the unfixed code to prove they fail). */
const KILL_AFTER_MS = Number(process.env.GOODBOY_PERF_KILL_MS ?? 45_000);

/** The case's milliseconds and the resident memory of its process in MB (printed as `<ms> <rss>`). */
function timeCase(name: string): { ms: number | null; rssMb: number | null; exit: number | null; stderr: string } {
  const r = Bun.spawnSync(['bun', WORKER, name], { timeout: KILL_AFTER_MS, stdout: 'pipe', stderr: 'pipe' });
  const [ms, rss] = r.exitCode === 0 ? r.stdout.toString().trim().split('\n').pop()!.split(' ').map(Number) : [null, null];
  return { ms: ms ?? null, rssMb: rss ?? null, exit: r.exitCode, stderr: r.stderr.toString().slice(0, 300) };
}

/** Cases that also bound the memory (MB): 9 million routes were 12 GB. */
const MAX_RSS_MB: Record<string, number> = { 'inv-spring-path-product': 700, 'config-cache-dense-files': 200 };

/** [case, limit in ms]: what each case takes now is a few tens of ms to a second. */
const SCAN: [string, number][] = [
  ['scan-gradle-blank-lines', 3000], // `^\s*war\s*\{` under /m
  ['scan-gradle-id-spaces', 3000], // `\bid\s*\(?\s*`
  ['scan-gradle-source-compat-spaces', 3000], // `sourceCompatibility\s*=?\s*`
  ['scan-pom-java-version-spaces', 3000], // `<java.version>\s*([^<]+)<`
  ['scan-pyproject-blank-lines', 3000], // `^\s*python\s*=` under /m
  ['scan-java-escaped-quotes', 3000], // the string-literal regex
  ['scan-url-trailing-punctuation', 3000], // `[.,;:)]+$`
  ['scan-placeholder-defaults', 3000], // `\$\{[^}:]*:([^}]*)\}`
  ['scan-properties-continuation', 3000], // continuation lines joined one by one
  ['scan-json-leaves', 3000], // one line search per JSON leaf
  ['scan-many-host-literals', 3000], // a whole-file regex pass per host literal
  ['scan-uvicorn-calls', 3000], // `uvicorn\.run\([^)]*`
  ['scan-hosts-times-files', 6000], // hosts x files: lower-casing every file for every host (1.3 s now, 8.9 s before)
  ['scan-constants-one-file', 2000], // 4000 URL constants in one file: a regex over the file per constant (9.4 s before)
  ['scan-java-constants-no-call', 2000], // the same in Java with no call in the file (12.3 s before)
  ['plan-two-config-files', 1000], // 280 hosts in two 400 KB config files: the file parsed again per host (2.4 s before)
  ['config-cache-dense-files', 4000], // 60 dense 0.7 MB files in turn: the heap kept is bounded too (200 MB; 544 MB when the bound counted text only)
  ['plan-twelve-config-files', 1000], // the same over twelve: more files than a handful-of-files cache holds
];

const INVENTORY: [string, number][] = [
  ['inv-spring-unclosed-annotations', 2000],
  ['inv-spring-unclosed-request-mapping', 2000],
  ['inv-html-open-tags', 2000],
  ['inv-html-open-quotes', 2000],
  ['inv-html-forms-no-close', 2000],
  ['inv-html-unclosed-comments', 2000],
  ['inv-html-unclosed-scripts', 2000],
  ['inv-html-script-src-no-gt', 2000],
  ['inv-html-placeholders', 2000],
  ['inv-html-c-url', 2000],
  ['inv-html-onclick', 2000],
  ['inv-js-open-fetch', 2000],
  ['inv-js-nested-fetch', 2000],
  ['inv-js-closed-nested-fetch', 2000],
  ['inv-js-location-closers', 2000],
  ['inv-js-router-arrays', 2000],
  ['inv-jsx-open-handlers', 2000],
  ['inv-tsx-unclosed-forms', 2000],
  ['inv-express-open-routes', 2000],
  ['inv-fastapi-router-open', 2000],
  ['inv-fastapi-decorators', 2000],
  ['inv-routes-times-links', 3000], // routes x links: every link was tried against every route
  ['inv-spring-path-product', 3000], // @RequestMapping({3000 paths}) x @GetMapping({3000 paths}): 9 million items, 12 GB, 39 s before
  ['inv-constants-diamond', 2000], // A_i = A_(i-1) + A_(i-1), 26 lines: the value doubled per line (15 s before; 30 lines ran out of memory)
  ['inv-fastapi-unclosed-include', 1000], // 512 KB of `.include_router(`: a 2000-character rescan from each (2.2 s before)
];

const CHECK: [string, number][] = [
  ['check-items-times-requests', 3000], // items x requests
  ['check-garbage-log', 2000], // 16 MiB of lines that are no JSON: a thrown error per line (6.6 s before)
];

describe('B1: the scan and the plan are linear in the text they read', () => {
  test.each(SCAN)('%s', (name, limit) => {
    const r = timeCase(name);
    expect({ name, exit: r.exit, stderr: r.exit === 0 ? '' : r.stderr }).toEqual({ name, exit: 0, stderr: '' });
    expect(r.ms!).toBeLessThan(limit);
    if (MAX_RSS_MB[name] !== undefined) expect(r.rssMb!).toBeLessThan(MAX_RSS_MB[name]!);
  }, 60_000);
});

describe('B1: the UI inventory is linear in the text it reads', () => {
  test.each(INVENTORY)('%s', (name, limit) => {
    const r = timeCase(name);
    expect({ name, exit: r.exit, stderr: r.exit === 0 ? '' : r.stderr }).toEqual({ name, exit: 0, stderr: '' });
    expect(r.ms!).toBeLessThan(limit);
    if (MAX_RSS_MB[name] !== undefined) expect(r.rssMb!).toBeLessThan(MAX_RSS_MB[name]!);
  }, 60_000);
});

describe('B1: the UI check is linear in items plus requests', () => {
  test.each(CHECK)('%s', (name, limit) => {
    const r = timeCase(name);
    expect({ name, exit: r.exit, stderr: r.exit === 0 ? '' : r.stderr }).toEqual({ name, exit: 0, stderr: '' });
    expect(r.ms!).toBeLessThan(limit);
    if (MAX_RSS_MB[name] !== undefined) expect(r.rssMb!).toBeLessThan(MAX_RSS_MB[name]!);
  }, 60_000);
});
