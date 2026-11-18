// Which files the privacy review covers (track M, M6g; plan §19). In a project that may hold real data, the files that
// decide what a test or the sandbox can do with the data are reviewed for it (`data-privacy`, lib/review-dimensions.ts):
//   - the sandbox's own files (SANDBOX_LAYOUT of lib/sandbox-gate.ts) and the manifest `.goodboy/sandbox/data.json`,
//     except the files that hold state or keys and no behaviour (scan, local answers, ledger, CA files, .gitignore);
//   - any source file of the project (code, scripts, `.json`, `.yml`; a test or not) that uses the data helper (M6c): a
//     JS/TS file whose relative import reduces to the helper module, a Java/Kotlin file that names `GoodboyData`, a
//     file of any language that names the env var of the resolved values (`GOODBOY_DATA`) or the helper's dir
//     (`.goodboy/sandbox/data/`), and the copies of the helper itself.
// `privacyFilesOf` answers for given (changed) files, `privacySetupOf` lists the current setup of a project for the
// run gate (lib/sandbox-privacy-gate.ts). Both are bounded and fail closed: a file that cannot be read in full counts as
// a privacy file (a changed one), and a setup that cannot be listed in full is refused with a fixed reason. No text of a
// file leaves this module; the answers are paths. Loaded by the Stop hook: no renderer, no scanner.
//
// Not privacy files: goodboy's own record files, the `.json` files directly in a `.claude/reviews/`, `.claude/tests/` or
// `.claude/tests/regression/` (at the project top or below it: the session's project dir may be a subdirectory of the
// repository, and `review-write` and `test-write` write to its `.claude/`). A review record names the paths it reviewed,
// among them the helper's dir, so it would otherwise count as a source file that uses the helper and ask a review of the
// review itself, for good (found by the M6 canary step, 2026-11-18). Nothing else of `.claude/` is excluded: a source file
// or script kept there, or a settings file, that names the helper is asked as any other. A `.json` file a model puts in a
// record dir is not asked for (a data file, not code the project's tests run).
//
// Stated limits (the review and the gate decide by what a file names; a program written to hide it is not read): a file
// that reaches the helper through a barrel or wrapper it imports (`src/testing/db.ts` re-exporting it), through an alias
// (a tsconfig path, a bundler alias), or by a path computed at run time (`path.join` of pieces) names none of the above
// and is not found; the wrapper itself, which imports the helper, is. The run gate lists what git lists (tracked, and
// untracked that are not ignored): a git-ignored source file is not in its setup, though a changed one is asked of the
// Stop. In the setup a non-test source file over the size cap is not read (a test over it refuses the setup).

import { type Dirent, lstatSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { jsLoadGroups } from './existing-tests';
import { spawnGit } from './git-run';
import { hookLeft } from './hook-clock';
import { realish } from './review-scope';
import { readRegular } from './safe-read';
import { bareModule, CODE_EXT, DATA_HELPER, HELPER_COPY, isSandboxLayout, isTestOrE2e, JS_EXT, MAX_USER_BYTES, SANDBOX_PREFIX, toPosix } from './sandbox-gate';
import { withoutComments } from './test-types';

/** The sandbox files that hold no behaviour a privacy review judges: the scan and the local answers (goodboy writes them
 *  from commands), the ledger of written files, the sandbox's own CA, and its `.gitignore`. They change on every
 *  `sandbox-local`, `sandbox-init` and CA renewal, so a review could never keep up with them. */
const STATE_ONLY = /^(?:scan\.json|local\.json|\.written\.json|\.gitignore|ca\/.*)$/;
/** The manifest of the data a run resolves (M6c). */
const MANIFEST = 'data.json';
/** The helper module, below the sandbox dir, as `bareModule` of lib/sandbox-gate.ts reduces an import to it. */
const HELPER_MODULE = `${SANDBOX_PREFIX}${DATA_HELPER}`;

const JVM_EXT = new Set(['.java', '.kt']);
/** What else holds a mention of the data (config, manifests, build scripts), besides the code files of lib/sandbox-gate.ts. */
const MORE_EXT = new Set(['.json', '.yml', '.yaml', '.kts', '.gradle', '.groovy', '.scala', '.swift', '.vue', '.svelte', '.ps1', '.pl']);

/** The most files `privacyFilesOf` reads and the most bytes it reads in all (per call), the most candidate files one setup
 *  lists, the biggest file read (the same cap as the import check of lib/sandbox-gate.ts), and the most bytes one setup
 *  reads in all. Past a cap, changed files count as privacy files and a setup is refused (fail closed). */
export const MAX_FILES_OF = 400;
export const MAX_BYTES_OF = 16 * 1024 * 1024;
export const MAX_SETUP_FILES = 20_000;
export const PRIVACY_FILE_BYTES = MAX_USER_BYTES;
export const MAX_SETUP_BYTES = 256 * 1024 * 1024;

/** The caps, replaceable by a test (the defaults are the constants above), and `until`, the ms left of the caller's
 *  deadline (default: the hook's own clock, lib/hook-clock.ts; Infinity outside a hook): past it `privacyFilesOf` reads no
 *  more and the rest of its candidates count as privacy files. */
export interface PrivacyCaps {
  files?: number;
  fileBytes?: number;
  totalBytes?: number;
  until?: () => number;
}
/** `git ls-files` is asked for at most this many bytes of paths. */
const MAX_LISTING_BYTES = 16 * 1024 * 1024;

/** The path of `abs` below `top`, `/`-separated, or null when it is outside. Both spellings are tried (as given and as
 *  resolved through links), and the one below the sandbox dir wins, so a path that reaches the dir either way counts. */
function relIn(top: string, abs: string): string | null {
  const real = realish(top);
  let found: string | null = null;
  for (const t of [resolve(top), real]) {
    for (const a of [resolve(abs), realish(abs)]) {
      const r = relative(t, a);
      if (r === '' || r === '..' || r.startsWith('../') || r.startsWith('..\\') || isAbsolute(r)) continue;
      const p = toPosix(r);
      if (p.startsWith(SANDBOX_PREFIX)) return p;
      found ??= p;
    }
  }
  return found;
}

/** goodboy's record files (see the header): no privacy file, whatever they name. */
const RECORD_FILE = /(?:^|\/)\.claude\/(?:reviews|tests|tests\/regression)\/[^/]+\.json$/;
export const isGoodboyRecord = (rel: string): boolean => RECORD_FILE.test(rel);

/** Whether a path below the project top (`/`-separated) is one of the privacy files by its path alone. */
export function isPrivacyPath(rel: string): boolean {
  if (isGoodboyRecord(rel)) return false;
  if (rel.startsWith(SANDBOX_PREFIX)) {
    const sub = rel.slice(SANDBOX_PREFIX.length);
    if (sub === MANIFEST) return true;
    if (isSandboxLayout(sub)) return !STATE_ONLY.test(sub);
  }
  return HELPER_COPY.test(rel);
}

/** Whether the text of a source file uses the data helper. JS/TS: a relative import that reduces to the helper module;
 *  any language: the symbol `GoodboyData`, the env var of the resolved values (`GOODBOY_DATA`) or the helper's dir named
 *  as text. Comments are ignored in JS/TS and JVM files (a mention in another kind of file, whose comment syntax this
 *  does not read, counts: more to review, never less). */
export function usesDataHelper(rel: string, text: string): boolean {
  const ext = extname(rel).toLowerCase();
  const commented = JS_EXT.has(ext) || JVM_EXT.has(ext);
  const code = commented ? withoutComments(text) : text;
  if (/\bGOODBOY_DATA\b/.test(code)) return true;
  if (code.includes(`${SANDBOX_PREFIX}data/`) || /\bGoodboyData\b/.test(code)) return true;
  return JS_EXT.has(ext) && jsLoadGroups(text, rel).some((g) => bareModule(g.target) === HELPER_MODULE);
}

/** A file that can use the helper: a code or script file, or a config or manifest file (`.json`, `.yml`). */
function isHelperCandidate(rel: string): boolean {
  const ext = extname(rel).toLowerCase();
  return CODE_EXT.has(ext) || MORE_EXT.has(ext);
}

/** Which of `files` are privacy files of the project at `top`: by path (the sandbox's files, `data.json`, helper
 *  copies), or a source file that uses the data helper (its text read, at most `PRIVACY_FILE_BYTES` each, `MAX_FILES_OF`
 *  files and `MAX_BYTES_OF` bytes in all, and while `caps.until()` is positive; a candidate it cannot read in full, or
 *  past a cap or the deadline, is a privacy file: the review is asked for what was not looked at). `files` are paths as
 *  given, resolved against `base`; the answer holds them as given. A file outside `top` is not one. */
export function privacyFilesOf(top: string, files: readonly string[], base: string = top, caps: PrivacyCaps = {}): Set<string> {
  const maxFiles = caps.files ?? MAX_FILES_OF;
  const maxBytes = caps.fileBytes ?? PRIVACY_FILE_BYTES;
  const maxTotal = caps.totalBytes ?? MAX_BYTES_OF;
  const left = caps.until ?? hookLeft;
  const out = new Set<string>();
  let read = 0;
  let bytes = 0;
  for (const f of files) {
    if (typeof f !== 'string' || f === '') continue;
    const abs = resolve(base, f);
    const rel = relIn(top, abs);
    if (rel === null || isGoodboyRecord(rel)) continue;
    if (isPrivacyPath(rel)) {
      out.add(f);
      continue;
    }
    if (!isHelperCandidate(rel)) continue;
    if (read >= maxFiles || bytes > maxTotal || left() <= 0) {
      out.add(f); // too many, too much or too late to read: fail closed
      continue;
    }
    const text = readRegular(abs, maxBytes);
    if (text === 'absent') continue; // deleted: it uses nothing now
    read++;
    if (text === 'refused') {
      out.add(f);
      continue;
    }
    bytes += text.text.length;
    if (usesDataHelper(rel, text.text)) out.add(f);
  }
  return out;
}

export type PrivacySetup = { ok: true; files: string[] } | { ok: false; why: 'cap' | 'unreadable' };

/** The privacy files the project at `top` has now, as paths below it (`/`-separated, sorted): the sandbox's files and the
 *  manifest that exist, and the source files that use the data helper among the files git lists (tracked, and untracked
 *  that are not ignored: a git-ignored file is not listed, see the header). Not ok when git cannot list the files, or a
 *  cap is passed: more than `MAX_SETUP_FILES` candidate files, a test over `PRIVACY_FILE_BYTES` or that cannot be read,
 *  more than `MAX_SETUP_BYTES` read in all. A candidate that is no test and is over the size cap or no regular file is
 *  left unread (a generated bundle or a lock file would otherwise refuse every run for good). */
export function privacySetupOf(top: string, caps: PrivacyCaps = {}): PrivacySetup {
  const maxFiles = caps.files ?? MAX_SETUP_FILES;
  const maxBytes = caps.fileBytes ?? PRIVACY_FILE_BYTES;
  const maxTotal = caps.totalBytes ?? MAX_SETUP_BYTES;
  const r = spawnGit(top, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 15_000, maxBuffer: MAX_LISTING_BYTES });
  if (r.code !== 0 || r.stalled) return { ok: false, why: 'unreadable' };
  const listed = new Set(r.out.split('\0').filter((x) => x !== ''));
  const files = new Set<string>();
  let candidates = 0;
  let bytes = 0;
  for (const rel of listed) {
    if (isGoodboyRecord(rel)) continue;
    if (isPrivacyPath(rel)) {
      files.add(rel);
      continue;
    }
    // the rest of the sandbox dir (state, keys, run output) holds no source of the project
    if (rel.startsWith(SANDBOX_PREFIX) || !isHelperCandidate(rel)) continue;
    if (++candidates > maxFiles) return { ok: false, why: 'cap' };
    const text = readRegular(resolve(top, rel), maxBytes);
    if (text === 'absent') continue; // listed, deleted in the work tree
    if (text === 'refused') {
      if (isTestOrE2e(rel)) return { ok: false, why: 'unreadable' };
      continue;
    }
    bytes += text.text.length;
    if (bytes > maxTotal) return { ok: false, why: 'cap' };
    if (usesDataHelper(rel, text.text)) files.add(rel);
  }
  // The sandbox dir itself too: a project's own `.gitignore` may hide it from the listing.
  const onDisk = sandboxFilesOnDisk(top);
  if (onDisk === null) return { ok: false, why: 'unreadable' };
  for (const rel of onDisk) if (isPrivacyPath(rel)) files.add(rel);
  return { ok: true, files: [...files].sort() };
}

/** The most entries one walk of the sandbox dir looks at, and how deep it goes. */
const MAX_WALK_ENTRIES = 5000;
const MAX_WALK_DEPTH = 6;

/** The files below `<top>/.goodboy/sandbox/` as paths below `top`, without `out/` (run results, git-ignored) and without
 *  following links; a link, or a dir that cannot be read, or more than `MAX_WALK_ENTRIES` entries, gives null (fail
 *  closed). An empty list when there is no sandbox dir. */
function sandboxFilesOnDisk(top: string): string[] | null {
  const base = SANDBOX_PREFIX.slice(0, -1);
  try {
    const st = lstatSync(resolve(top, base));
    if (!st.isDirectory()) return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR' ? [] : null;
  }
  const out: string[] = [];
  let seen = 0;
  const walk = (rel: string, depth: number): boolean => {
    if (depth > MAX_WALK_DEPTH) return false;
    let names: Dirent[];
    try {
      names = readdirSync(resolve(top, rel), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const n of names) {
      if (++seen > MAX_WALK_ENTRIES) return false;
      const child = `${rel}/${n.name}`;
      if (n.isSymbolicLink()) return false;
      if (n.isDirectory()) {
        if (child === `${base}/out`) continue;
        if (!walk(child, depth + 1)) return false;
      } else if (n.isFile()) out.push(child);
    }
    return true;
  };
  return walk(base, 0) ? out : null;
}
