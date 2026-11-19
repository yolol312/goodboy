// The run gate of the privacy review (track M, M6g; plan §19). A real-data `sandbox-run` runs the project's tests inside
// the sandbox, against values the model never sees; what those tests and the sandbox files can do with the values is
// what the `data-privacy` review judges (skills/check-data-privacy). So a real-data run starts only when the current
// setup (lib/privacy-files.ts `privacySetupOf`: the sandbox's files, `data.json`, the source files that use the data
// helper) is covered by passing reviews of its current content that list `data-privacy` in `dimensions_checked`.
//
// A review counts for a file when it lists the file in `reviewed_files`, lists `data-privacy`, has a `tree` (a record
// without one is judged by time elsewhere; here it is no evidence) and that tree (or `extra_blobs`) holds the file's
// content now (lib/changed-coverage.ts `withSameContent`, the freshness rule of the Stop). Of the reviews that cover a
// file so, the newest decides, as in the Stop: it must have verdict `pass` and no finding of severity high or medium
// (a record is bound to the content it saw, so a finding it holds is open for that content; a fix is a new review).
// Content decides, so the window of the reviews read is wide, but the Stop deletes review files older than its retention
// (GOODBOY_REVIEW_RETENTION_MIN, 3 days by default, lib/review-validator.ts pruneOldReviewFiles), so in practice an
// unchanged setup is asked for again after that many idle days. Reviews are read from the repository top's
// `.claude/reviews` and from the session's project dir's (where `review-write` writes: they differ when the project dir
// is a subdirectory of the repository).
//
// A sandbox file whose current bytes are exactly what goodboy renders for this project is not asked for (user decision
// 2026-11-18, after the M6 canary step: goodboy's own code is reviewed in goodboy's repo, and a reviewer cannot judge
// the Playwright config or the proxy's access log of goodboy's own render in a project's terms, so the gate would block
// a real-data project for good). The gate re-renders the layout itself, with the pure renderer `sandbox-init` uses, from a
// FRESH in-memory scan of the project (the read-only scanner `sandbox-scan` runs, `scanSandbox`) and the project's
// `local.json` (`renderedUnchanged`), and exempts a file only when its bytes equal that render. No file the model can
// write counts as proof: not the `.written.json` ledger, and not `scan.json` either (a hand-edited scan yields files that
// differ from the fresh render, so they are asked). A scan that throws, has problems or does not finish within
// `RENDER_SCAN_BUDGET_MS` (the scanner's own 60 s), a render that fails, or a local file that cannot be read exempts nothing. A project whose
// sources changed since `sandbox-scan` and `sandbox-init` renders differently now, so its files are asked until `sandbox-init
// --force` writes the new render. What stays asked: a rendered file that differs from its render, a layout file the render
// does not make for this scan, `data.json`, and the source files that use the helper.
//
// Fails closed: a setup that cannot be listed in full (git cannot list, a cap, an unreadable file) is refused with its
// own fixed reason. A refusal names relative paths and a fixed text, never file contents, and the run writes no
// result.json. The user can turn the gate off in their settings; the refusal does not name how, and the PreToolUse data
// guard (lib/sandbox-data-guard.ts) denies a command that sets that switch, so it reaches the CLI only from the process
// environment the user's settings give it.

import { join, resolve } from 'node:path';
import { withSameContent } from './changed-coverage';
import { privacySetupOf } from './privacy-files';
import { recordPath } from './record-paths';
import { MAX_DOC_BYTES, readRegular } from './safe-read';
import { realish } from './review-scope';
import type { DiagCode } from './sandbox-boundary';
import { findRecentReviewFiles, validateReviewCoverage } from './review-validator';
import { SANDBOX_PREFIX } from './sandbox-gate';
import { SANDBOX_DIR } from './sandbox-mode';
import { type RenderFailure, RENDER_SCAN_BUDGET_MS, renderSandboxFiles } from './sandbox-render-files';
import { scanSandbox } from './sandbox-scan';
import type { ReviewResult } from './types';

export { RENDER_SCAN_BUDGET_MS, type RenderFailure };
export const PRIVACY_DIMENSION = 'data-privacy';
const PRIVACY_CODES = ['privacy-review-missing', 'privacy-setup-unreadable'] as const satisfies readonly DiagCode[];
export type PrivacyCode = (typeof PRIVACY_CODES)[number];

/** How far back the reviews are read, in minutes (30 days): the content decides, not the age. The Stop's retention
 *  (3 days by default) deletes older review files first, so the window is an upper bound, not a promise. */
export const PRIVACY_REVIEW_WINDOW_MIN = 30 * 24 * 60;
/** The most files a refusal names. */
const SHOWN = 20;

const SWITCH = 'GOODBOY_SANDBOX_PRIVACY_GATE';
/** The files Bun loads into the environment on its own from the process's dir, for any NODE_ENV. */
const DOTENV_FILES = ['.env', '.env.local', ...['development', 'production', 'test'].flatMap((e) => [`.env.${e}`, `.env.${e}.local`])];
const SETS_SWITCH = new RegExp(`^\\s*(?:export\\s+)?["']?${SWITCH}["']?\\s*[=:]`, 'm');

/** Whether the switch may have come from a file rather than the user's settings: Bun reads `.env` files from the
 *  process's dir on its own, and the files a `--env-file` flag names, and a file a command or a tool wrote is no
 *  command the data guard reads (review delta, M6g). A dotenv file that cannot be read as a regular file counts too. */
export function switchFromFile(cwd: string = process.cwd(), execArgv: readonly string[] = process.execArgv): boolean {
  if (execArgv.some((a) => a.startsWith('--env-file'))) return true;
  for (const name of DOTENV_FILES) {
    const r = readRegular(join(cwd, name), 1 << 20, true);
    if (r === 'absent') continue;
    if (r === 'refused' || SETS_SWITCH.test(r.text)) return true;
  }
  return false;
}

/** The user's switch (an environment variable of the CLI's process, set in their settings) that skips the run gate; any
 *  other value keeps it, and so does a switch that may have come from a dotenv file (`switchFromFile`). Its name is in
 *  the README and the plan, not in any text a model is shown. */
export function privacyGateOff(env: Record<string, string | undefined> = process.env, fromFile: () => boolean = switchFromFile): boolean {
  return (env[SWITCH] ?? 'on').trim().toLowerCase() === 'off' && !fromFile();
}

export type PrivacyGate = { ok: true } | { ok: false; code: PrivacyCode; files: string[]; reason: string };

const how =
  'Run goodboy:review-all with `axis: data-privacy` on these files, record the result with review-write (dimensions_checked lists data-privacy), ' +
  'and run sandbox-run again. A change to a listed file after its review asks for a new review, and so does a review file the Stop has deleted as old. ' +
  'The user can turn this check off in their settings.';

/** What the gate reads, replaceable by a test (the answers of `privacySetupOf`, `findRecentReviewFiles` and `renderedUnchanged`). */
export interface GateReaders {
  setup?: typeof privacySetupOf;
  reviews?: typeof findRecentReviewFiles;
  rendered?: typeof renderedUnchanged;
}

/** Why the files could not be re-rendered, as the fixed words a refusal uses. */
const RENDER_FAILURE = {
  'scan-threw': 'the project scan failed',
  'scan-problems': 'the project scan reports problems (git cannot list the files, or it is not a git repository)',
  'scan-slow': 'the project scan did not finish within its time budget',
  'local-unreadable': 'the local answers file of the sandbox cannot be read',
  'render-failed': 'the render failed',
} as const satisfies Record<RenderFailure, string>;

/** The sandbox files (paths below the repo top) whose current bytes equal what goodboy renders for this project now: the
 *  layout `sandbox-init` would write, made by `planSandbox` from a fresh scan of the project (`scanSandbox`, read-only,
 *  nothing written) and `local.json`. Neither `scan.json` nor the ledger is read. Only a file of that render can be in
 *  `files`, and only when it is a regular file (no link) of the render's exact bytes. A scan that throws, has problems or
 *  ran past `RENDER_SCAN_BUDGET_MS`, an unreadable local file, or a render that throws gives no file and says why in
 *  `failure`: nothing is exempt (fail closed). One scan, one render and at most one read per rendered file. `scanner` is
 *  a test seam. */
export function renderedUnchanged(root: string, scanner: typeof scanSandbox = scanSandbox): { files: Set<string>; failure: RenderFailure | null } {
  const none = (failure: RenderFailure) => ({ files: new Set<string>(), failure });
  const render = renderSandboxFiles(root, scanner);
  if (render.files === null) return none(render.failure ?? 'render-failed');
  const files = new Set<string>();
  // readRegular answers 'absent' or 'refused' instead of throwing, so this loop needs no catch of its own.
  for (const [rel, text] of render.files) {
    const cur = readRegular(join(root, SANDBOX_DIR, rel), MAX_DOC_BYTES, true);
    if (typeof cur === 'object' && cur.text === text && cur.st.size === Buffer.byteLength(text, 'utf8')) files.add(`${SANDBOX_PREFIX}${rel}`);
  }
  return { files, failure: null };
}

/** The first `SHOWN` paths of a group, and how many more. */
const listed = (files: readonly string[]): string => files.slice(0, SHOWN).join(', ') + (files.length > SHOWN ? `, and ${files.length - SHOWN} more` : '');

/** The files of the current setup that no passing, fresh `data-privacy` review of `root` covers, as a gate result.
 *  `projectDir` is the session's project dir as the CLI knows it (`cliProjectDir`): its reviews count too. */
export function privacyGate(root: string, env: Record<string, string | undefined> = process.env, readers: GateReaders = {}, projectDir?: string): PrivacyGate {
  if (privacyGateOff(env)) return { ok: true };
  let setup: ReturnType<typeof privacySetupOf>;
  try {
    setup = (readers.setup ?? privacySetupOf)(root);
  } catch {
    setup = { ok: false, why: 'unreadable' };
  }
  if (!setup.ok) {
    return {
      ok: false,
      code: 'privacy-setup-unreadable',
      files: [],
      reason:
        `sandbox-run refused (privacy-setup-unreadable): this project holds real data, and its privacy setup could not be listed in full (${setup.why === 'cap' ? 'over a size or count cap' : 'git could not list the files, or one could not be read'}). ` +
        'Nothing runs on a setup that was not read in full. Make the setup smaller or readable (tests of the data helper in regular files below 512 KB, in a git repository); ' +
        'the user can turn this check off in their settings.',
    };
  }
  const judge = (files: readonly string[]) => uncoveredFiles(root, files, readers.reviews ?? findRecentReviewFiles, projectDir);
  let { missing, flagged } = judge(setup.files);
  // What goodboy rendered and nobody changed is out of scope. The re-render costs a scan, so it runs only when a file below
  // the sandbox dir is asked for. The files were judged together (the freshness check shares its caps and time budget across
  // them), and the exempt ones are dropped from that answer afterwards: judging the rest alone could only be as strict or
  // looser, so this is the stricter side. A failure to re-render exempts nothing, and the refusal says so.
  let failure: RenderFailure | null = null;
  if ([...missing, ...flagged].some((f) => f.startsWith(SANDBOX_PREFIX))) {
    let rendered: ReturnType<typeof renderedUnchanged>;
    try {
      rendered = (readers.rendered ?? renderedUnchanged)(root);
    } catch {
      rendered = { files: new Set(), failure: 'render-failed' };
    }
    failure = rendered.failure;
    missing = missing.filter((f) => !rendered.files.has(f));
    flagged = flagged.filter((f) => !rendered.files.has(f));
  }
  if (missing.length === 0 && flagged.length === 0) return { ok: true };
  const parts: string[] = [];
  if (failure !== null && [...missing, ...flagged].some((f) => f.startsWith(SANDBOX_PREFIX))) {
    parts.push(
      `goodboy could not re-render its sandbox files (${RENDER_FAILURE[failure]}), so the files below ${SANDBOX_PREFIX} count as unreviewed even when goodboy wrote them. ` +
        'Fix that cause and run sandbox-run again, or have those files reviewed.',
    );
  }
  if (missing.length > 0) parts.push(`${missing.length} file(s) have no data-privacy review of their current content: ${listed(missing)}.`);
  if (flagged.length > 0) {
    parts.push(
      `${flagged.length} file(s) have a data-privacy review of their current content that does not clear them (its newest record holds a high or medium finding, or a verdict other than pass): ${listed(flagged)}. ` +
        'Fix the finding in the file, or answer it, and review the file again; the same record does not clear it.',
    );
  }
  return {
    ok: false,
    code: 'privacy-review-missing',
    files: [...missing, ...flagged],
    reason: `sandbox-run refused (privacy-review-missing): this project holds real data, and its sandbox setup or the source files that use the data helper are not cleared. ${parts.join(' ')} ${how}`,
  };
}

/** The review dirs the gate reads: the repository top's and the project dir's, each once (a link to the same dir counts once). */
function reviewDirs(root: string, projectDir: string | undefined): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const base of [root, projectDir]) {
    if (typeof base !== 'string' || base === '') continue;
    const dir = join(resolve(base), '.claude', 'reviews');
    const key = join(realish(resolve(base)), '.claude', 'reviews');
    if (seen.has(key) || seen.has(dir)) continue;
    seen.add(key).add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/** Whether a review record, the newest that covers a file, clears it: it passed and holds no finding of severity high or medium. */
const clears = (r: ReviewResult): boolean =>
  r.verdict === 'pass' && !(Array.isArray(r.findings) ? r.findings : []).some((f) => f !== null && typeof f === 'object' && (f.severity === 'high' || f.severity === 'medium'));

/** The files (relative paths) with no review that lists `data-privacy` for their current content (`missing`), and those
 *  whose newest such review does not clear them (`flagged`). Any failure to judge counts as missing. */
function uncoveredFiles(root: string, rels: readonly string[], reviewsIn: typeof findRecentReviewFiles, projectDir: string | undefined): { missing: string[]; flagged: string[] } {
  const all = { missing: [...rels], flagged: [] as string[] };
  let records: ReviewResult[];
  try {
    records = reviewDirs(root, projectDir)
      .flatMap((dir) => reviewsIn(dir, PRIVACY_REVIEW_WINDOW_MIN))
      .filter((r) => typeof r.tree === 'string' && Array.isArray(r.dimensions_checked) && r.dimensions_checked.includes(PRIVACY_DIMENSION));
    if (records.length === 0) return all;
    const edits = rels.map((rel) => ({ file: recordPath(rel, root), lastEditTimestamp: null as string | null }));
    const judged = withSameContent(edits, records, root, (r) => r.reviewed_files);
    const v = validateReviewCoverage(records, judged);
    // `byFile` holds, per file, the fresh records that cover it, newest first; a file whose newest one has verdict `fail`
    // is not in it but in `failed`: a review exists and does not clear it
    const byFile = v.byFile;
    if (byFile === undefined) return all;
    const failed = new Set(v.failed ?? []);
    const missing: string[] = [];
    const flagged: string[] = [];
    rels.forEach((rel, i) => {
      const file = edits[i]!.file;
      const newest = byFile.get(file)?.[0];
      if (newest === undefined) (failed.has(file) ? flagged : missing).push(rel);
      else if (!clears(newest)) flagged.push(rel);
    });
    return { missing, flagged };
  } catch {
    return all;
  }
}
