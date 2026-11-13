// The layer-1 test of the sandbox's own files (track M, M5 trial, session 1; plan §19). What
// `sandbox-init` renders under `.goodboy/sandbox/` (compose, runtime and db scripts, overrides,
// dummies, proxy, the e2e fixture, the CA files) is not code a unit test imports: a passing
// sandbox run is its integration test. So the Stop's test gate counts such a changed file as
// tested at file level when a passing test record is bound to a sandbox run (`sandbox: {run}`)
// that verifies as backfill-mark's evidence does (lib/sandbox-proof.ts) and started at or after
// the file's last edit. Such files then need no changed-line coverage, no test-type suite and no
// existing-test edge: the gate leaves them out of every other rule (hooks/stop.ts
// needsTestCoverage). Their review stays the normal review.
//
// The exemption is narrow. Only the files the renderer writes count (SANDBOX_LAYOUT; a test keeps
// the list equal to lib/sandbox-render.ts), by the path as spelled and as resolved; any other file
// under the dir is ordinary code. A layout file that a changed file of the project imports or
// names loses the exemption (sandboxUsers): the app would run it, and a sandbox run does not
// measure it. Loaded by the Stop hook: it imports no sandbox renderer or scanner.

import { statSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { jsLoads } from './existing-tests';
import { realish } from './review-scope';
import { MAX_DOC_BYTES, readRegular } from './safe-read';
import { e2ePassed, runStartsAfter, sandboxProof } from './sandbox-proof';
import { JS_SPECIFIER, recordStandsAlone, withoutComments } from './test-types';
import { isTestFile } from './test-validator';
import { isTrustedTimestamp } from './trusted-time';
import type { TestResult } from './types';

/** Where goodboy's sandbox commands write, with a trailing slash (lib/sandbox-render.ts
 *  SANDBOX_DIR is the same path without it; tests/m5-sandbox-gate.test.ts keeps them equal). */
export const SANDBOX_PREFIX = '.goodboy/sandbox/';

/** The files goodboy's sandbox commands write below the sandbox dir, by path: what the renderer
 *  puts in its plan, the CA files, and the scan, the local answers and the ledger. A test builds
 *  plans for each stack and checks that every file of them matches. */
const SANDBOX_LAYOUT: readonly RegExp[] = [
  /^(?:compose\.yml|\.gitignore|scan\.json|local\.json|\.written\.json)$/,
  /^runtime\/(?:entrypoint\.sh|prep\.sh|coverage\.sh|flush\.cjs|lcov-merge\.cjs|coveragerc|e2e-prep\.sh)$/,
  /^db\/[\w.-]+\/(?:restore|reset)\.sh$/,
  /^overrides\/(?:application-sandbox\.yml|sandbox\.env)$/,
  /^dummies\/stubs\/mappings\/[\w.-]+\.json$/,
  /^dummies\/ldap\/[\w.-]+\.ldif$/,
  /^proxy\/Caddyfile$/,
  /^e2e\/(?:goodboy-ui\.ts|playwright\.config\.ts)$/,
  /^ca\/(?:ca\.crt|ca\.key|server\.crt|server\.key|server\.p12|server\.sans)$/,
];
/** `sandbox-run`'s own output, `out/<run>/…` (git-ignored): no test applies, and no run starts
 *  after it. */
const RUN_OUTPUT = /^out\/\d{8}T\d{6}Z\//;
/** Files only the e2e path uses: a run that did not run the e2e step does not exercise them. */
const E2E_ONLY = /^(?:e2e\/|proxy\/|runtime\/e2e-prep\.sh$)/;
/** The one layout file a test may import. */
const E2E_FIXTURE = 'e2e/goodboy-ui';

/** Whether a path below the sandbox dir is one the sandbox commands write. */
export function isSandboxLayout(rel: string): boolean {
  return SANDBOX_LAYOUT.some((r) => r.test(rel));
}

const toPosix = (p: string) => p.split('\\').join('/');

/** The path of a file below `<top>/.goodboy/sandbox/` when it is below it both as spelled and as
 *  resolved (a link from outside into the dir is not a sandbox file: `src/x.ts -> …/sandbox/y.ts`
 *  is code; nor is one out of it), and not a hard link (which may share its content with code);
 *  else null. */
export function sandboxRel(abs: string, top: string): string | null {
  // The spelled path must hold the dir (checked below); most files do not, and skip the real paths.
  if (!toPosix(resolve(abs)).includes(`/${SANDBOX_PREFIX}`)) return null;
  const real = toPosix(relative(realish(top), realish(abs)));
  if (!real.startsWith(SANDBOX_PREFIX)) return null;
  // The spelled path, against the top as the caller spells it and as it resolves.
  const spelled = [resolve(top), realish(top)].map((t) => toPosix(relative(t, resolve(abs)))).find((r) => r.startsWith(SANDBOX_PREFIX));
  if (spelled === undefined || spelled !== real) return null;
  try {
    if (statSync(abs).nlink > 1) return null;
  } catch {
    // deleted: nothing to run
  }
  return real.slice(SANDBOX_PREFIX.length);
}

/** The path below the sandbox dir of a file that leaves the ordinary layer-1 rules: a layout
 *  file, or run output. */
export function sandboxExemptRel(abs: string, top: string): string | null {
  const rel = sandboxRel(abs, top);
  return rel !== null && (isSandboxLayout(rel) || RUN_OUTPUT.test(rel)) ? rel : null;
}

/** The path below the sandbox dir of a layout file that needs a sandbox run as its test. */
export function sandboxTestRel(abs: string, top: string): string | null {
  const rel = sandboxExemptRel(abs, top);
  return rel === null || RUN_OUTPUT.test(rel) ? null : rel;
}

/** Which layout files the changed files of the project use. `all`: a changed file names the
 *  sandbox dir in a way the import check cannot resolve, so no layout file is exempt. */
export interface SandboxUsers {
  /** Paths below the sandbox dir (with and without extension) that a changed file imports. */
  files: ReadonlySet<string>;
  all: boolean;
}

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.rb', '.go', '.java', '.kt', '.php', '.cs', '.rs', '.sh']);
const JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const MAX_USERS_READ = 400;
const MAX_USER_BYTES = 512 * 1024;
const noExt = (rel: string) => rel.replace(/\.[cm]?[jt]sx?$/, '');

/** The sandbox layout files that the changed files (absolute paths) of the project import: a
 *  relative specifier (as lib/existing-tests.ts reads them, comments ignored) that resolves into
 *  the sandbox dir. A file that is no test and names the dir otherwise (a path in a string, a
 *  Python `sys.path` entry, a `require` built at run time) makes `all`. The e2e fixture
 *  `e2e/goodboy-ui` may be imported by tests. Files of the sandbox dir are not users. */
export function sandboxUsers(top: string, changed: readonly string[]): SandboxUsers {
  const files = new Set<string>();
  let all = false;
  const root = realish(top);
  let read = 0;
  for (const abs of changed) {
    if (read >= MAX_USERS_READ) {
      all = true; // too many to read: fail closed
      break;
    }
    const ext = extname(abs).toLowerCase();
    if (!CODE_EXT.has(ext) || sandboxRel(abs, top) !== null) continue;
    const rel = toPosix(relative(root, realish(abs)));
    if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) continue;
    const text = readRegular(abs, MAX_USER_BYTES);
    if (text === 'refused') {
      // Too large (a generated bundle over 512 KB counts too) or no regular file: what it uses is unknown, so
      //   every layout file counts as used (fail closed) and needs its layer-1 test.
      all = true;
      break;
    }
    if (text === 'absent') continue; // deleted: it uses nothing
    read++;
    const test = isTestFile(rel) || /(?:^|\/)e2e\//.test(rel);
    if (JS_EXT.has(ext)) {
      for (const k of jsLoads(text.text, rel)) {
        if (k === SANDBOX_PREFIX.slice(0, -1)) all = true; // the dir itself
        if (!k.startsWith(SANDBOX_PREFIX)) continue;
        const below = k.slice(SANDBOX_PREFIX.length);
        if (test && noExt(below).replace(/\/index$/, '') === E2E_FIXTURE) continue;
        files.add(below);
      }
    }
    if (!test) {
      // A mention the specifier check did not read: what is left once the import specifiers (read
      //   above) and the fixture's path are taken out.
      const rest = withoutComments(text.text).replace(JS_SPECIFIER, '').replace(/\.goodboy\/sandbox\/e2e\/goodboy-ui/g, '');
      if (rest.includes(SANDBOX_PREFIX.slice(0, -1))) all = true;
    }
  }
  return { files, all };
}

/** The edits that are layout files a sandbox run tests (not run output, not used by a changed file),
 *  each with its path below the sandbox dir. `usersOf` is called only when an edit is such a file,
 *  so a session that changed no sandbox file never pays for reading the changed files. */
export function sandboxTestEdits<T extends { file: string }>(edits: readonly T[], top: string, usersOf: () => SandboxUsers): (T & { rel: string })[] {
  const out: (T & { rel: string })[] = [];
  for (const e of edits) {
    const rel = sandboxTestRel(e.file, top);
    if (rel !== null && !sandboxUsed(usersOf(), rel)) out.push({ ...e, rel });
  }
  return out;
}

/** Whether a changed file's use of this layout file takes the exemption away. */
export function sandboxUsed(users: SandboxUsers, rel: string): boolean {
  return users.all || users.files.has(rel) || users.files.has(noExt(rel));
}

export interface SandboxGap {
  rel: string;
  why: string;
}

/** The changed sandbox files (path below the sandbox dir, last edit time) that no record's run
 *  tests. The proof is a passing record that stands alone, with a trusted timestamp, whose
 *  `sandbox` run verifies (sandboxProof); one such record covers every sandbox file edited before
 *  its run started (its tested_files need not list them). An e2e-only file needs a run whose e2e
 *  step ran, exited 0 and wrote its Playwright report (result.json says so; the requested suite
 *  alone does not). */
export function sandboxGaps(top: string, edits: readonly { rel: string; lastEdit: number }[], results: readonly TestResult[]): SandboxGap[] {
  if (edits.length === 0) return [];
  const bound = results.filter((r) => r.verdict === 'pass' && isTrustedTimestamp(r.timestamp) && r.sandbox !== undefined && recordStandsAlone(r));
  const proofs: { run: string; e2e: boolean }[] = [];
  const unproven = new Set<string>();
  for (const r of bound) {
    const p = sandboxProof(top, r);
    if (typeof p === 'string') unproven.add(p);
    else proofs.push({ run: p.run, e2e: e2ePassed(p) });
  }
  const gaps: SandboxGap[] = [];
  for (const e of edits) {
    const e2e = E2E_ONLY.test(e.rel);
    const after = proofs.filter((p) => runStartsAfter(p.run, e.lastEdit));
    if (after.some((p) => !e2e || p.e2e)) continue;
    gaps.push({
      rel: e.rel,
      why:
        proofs.length === 0
          ? `no passing record is bound to a verified sandbox run${unproven.size > 0 ? ` (${[...unproven].slice(0, 2).join('; ')})` : ''}`
          : after.length === 0
            ? 'every recorded run started before its last edit'
            : 'it is used only by the e2e path: it needs a run whose e2e step ran and passed (suite e2e or all, with e2e tests)',
    });
  }
  return gaps;
}

/** The block reason for the gaps: what is missing and how to get it. */
export function sandboxGapReason(gaps: readonly SandboxGap[], cliPath: string): string {
  const list = gaps.slice(0, 5).map((g) => `${SANDBOX_PREFIX}${g.rel} (${g.why})`).join('; ') + (gaps.length > 5 ? ` and ${gaps.length - 5} more` : '');
  return (
    `Sandbox files changed without a sandbox run that tests them: ${list}. A passing sandbox run is their test: ` +
    `run \`bun "${cliPath}" sandbox-run --suite all\` after the last edit of these files (e2e/, proxy/ and runtime/e2e-prep.sh need a run whose e2e step passed; ` +
    'the others, any suite), then record it as the run-sandbox skill says (test-write with `sandbox: {run: "<ts>"}`). ' +
    'The unit-test rules, changed-line coverage and test types do not apply to these files.'
  );
}
