// Changed-line coverage as a rule (track I, I1, issue #2): every changed code line runs in a
// test of the recorded tree. The test records carry `coverage.changed` from `cli.ts
// diff-coverage` (per file, the files the report saw at all, the files the diff has with their
// added lines, and the base); the layer-1 gate reads them here. For each changed file only the
// passing records the other layer-1 checks accepted and made after its last edit (or on its
// current content, #23) count. A
// changed code file with added lines that the report lacks ran in no test (M24: code started
// in a child process is not measured; M25), so it counts as not covered; so does an edited
// file the diff does not have unless it equals the base (reverted): git can be told to hide a
// file (ignore rules, assume-unchanged, a nested repo), so the diff alone is not evidence. Not
// counted: a file that is not code, a JS/TS file with no runtime code (types only), a
// deleted file.
//
// The user decides the exemptions: `coverage-exempt:` globs of `decide: human` entries in the
// repo's policy file. SessionStart pins them with the HEAD the session started from (like the
// project mode, lib/project-mode.ts; the state guard restores the pin after a Bash call): a
// glob added during the session counts from the next one, so whatever writes it, the model
// cannot exempt its own change. PreToolUse also denies an Edit/Write that adds one, as an early
// explanation. A record measured against a commit made after the session started would hide
// the committed changes, so it does not count; a session that started with no commit, or
// outside a repo, accepts only the empty tree. A same-user limit stays: a glob written in one
// session counts in the next. GOODBOY_DIFF_COVERAGE=on (default) | warn | off.

import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { filterOffArgs, HOOK_GIT_ARGS, HOOK_GIT_ENV, NO_GRAFTS } from './hook-git';
import { knowledgeRoot, parsePolicyEntries, POLICY_FILE } from './project-knowledge';
import { recordPath } from './record-paths';
import { readRegular } from './safe-read';
import { freshFor, stripLiteralsAndComments } from './test-validator';
import type { ChangedFileEdit } from './review-validator';
import { isTrustedTimestamp } from './trusted-time';
import type { TestResult } from './types';

export type DiffCoverageMode = 'on' | 'warn' | 'off';

export function diffCoverageMode(env: Record<string, string | undefined> = process.env): DiffCoverageMode {
  const v = (env.GOODBOY_DIFF_COVERAGE ?? 'on').trim().toLowerCase();
  return v === 'off' || v === 'warn' ? v : 'on';
}

export type CoverageGap =
  /** `file` is relative to the repo top, `/` separators. */
  | { file: string; covered: number; total: number }
  /** The diff has added lines in the file and no test run loaded it. */
  | { file: string; absent: true }
  /** Edited, not in the record's diff, and not equal to the base. */
  | { file: string; hidden: true }
  /** No passing record made after the file's last edit measured it. */
  | { file: string; unmeasured: true };

const MAX_POLICY_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** Time for reading changed files to see whether they hold code, across all of them. */
const READ_BUDGET_MS = 3_000;
const PIN_FILE = 'coverage-pin.json';
/** `--base empty`: diff against the empty tree (no commit when the session started). */
export const EMPTY_BASE = 'empty';

/** Files a coverage tool measures: a changed one the report lacks ran in no test. */
const CODE_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.java', '.kt', '.kts', '.scala', '.groovy', '.rb', '.rs', '.php', '.cs',
  '.swift', '.dart', '.ex', '.exs', '.lua', '.c', '.cc', '.cpp', '.cxx', '.m', '.mm',
]);
const JS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** git with no replace refs and no grafts (either would show another commit's tree or make a
 *  later commit an ancestor). Exit -1: git did not run or timed out; 128: not a repo (or a bad
 *  object). */
function git(cwd: string, args: string[], input?: string, timeoutMs = 5_000): { code: number; out: string } {
  try {
    const r = Bun.spawnSync(['git', '--no-replace-objects', ...HOOK_GIT_ARGS, ...args], { cwd, env: { ...process.env, ...HOOK_GIT_ENV, ...NO_GRAFTS }, ...(input === undefined ? {} : { stdin: Buffer.from(input) }), stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs });
    return { code: r.exitCode ?? -1, out: r.stdout.toString() };
  } catch {
    return { code: -1, out: '' };
  }
}

/** The hook's git (no fsmonitor, no lazy fetch, no grafts), for other lib modules (#32). */
export const hookGit = git;

/** The empty tree's id in this repo's hash (sha1 or sha256), or null outside a repo. */
export function emptyTree(cwd: string): string | null {
  const r = git(cwd, ['hash-object', '-t', 'tree', '/dev/null']);
  return r.code === 0 ? r.out.trim() : null;
}

/** A `.goodboy/policy.md` path, in any letter case (macOS file names ignore it). */
export function isPolicyFile(p: string): boolean {
  return basename(p).toLowerCase() === 'policy.md' && basename(dirname(resolvePath(p))).toLowerCase() === '.goodboy';
}

/** Splits `a/**, src/*.{ts,tsx}` on the commas outside braces. */
function splitGlobs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((g) => g.trim()).filter(Boolean);
}

/** Policy keys whose globs only the user sets: the changed-line exemptions (I1), the static
 *  previews (I3a, lib/verification-scope.ts), the test-type exemptions (I3b,
 *  lib/test-types.ts). All are pinned at session start together. */
export const USER_GLOB_KEYS = ['coverage-exempt', 'static-preview', 'test-type-exempt'] as const;
export type UserGlobKey = (typeof USER_GLOB_KEYS)[number];

/** `<key>: <glob>, <glob>` of the `decide: human` entries in a policy text. An `ai` entry
 *  sets nothing. */
export function globsInText(text: string, key: UserGlobKey): string[] {
  return parsePolicyEntries(text)
    .filter((e) => e.fields.decide?.split(/\s/)[0] === 'human' && e.fields[key])
    .flatMap((e) => splitGlobs(e.fields[key]!));
}

export function exemptionsInText(text: string): string[] {
  return globsInText(text, 'coverage-exempt');
}

/** The user globs `after` sets that `before` did not, per key. */
export function addedUserGlobs(before: string, after: string): { key: UserGlobKey; glob: string }[] {
  return USER_GLOB_KEYS.flatMap((key) => {
    const had = new Set(globsInText(before, key));
    return [...new Set(globsInText(after, key))].filter((g) => !had.has(g)).map((glob) => ({ key, glob }));
  });
}

const outside = (r: string) => r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);

/** The exemptions of the policy file at the knowledge root, as the file says now. Only a
 *  policy file inside the repo counts (a parent directory's is not the project's). */
export function coverageExemptions(cwd: string, top: string = repoTop(cwd)): string[] {
  return policyGlobs(cwd, top, 'coverage-exempt');
}

/** A user glob key's globs in the policy file at the knowledge root, as the file says now
 *  (also the test survey's, track L). */
export function policyGlobs(cwd: string, top: string, key: UserGlobKey): string[] {
  const { root, policyExists } = knowledgeRoot(cwd);
  if (!policyExists || outside(relative(top, root))) return [];
  try {
    const p = join(root, POLICY_FILE);
    if (!existsSync(p) || statSync(p).size > MAX_POLICY_BYTES) return [];
    return globsInText(readFileSync(p, 'utf8'), key);
  } catch {
    return [];
  }
}

/** The repo top in cwd's own spelling (`--show-cdup`, not git's real path: through a symlinked
 *  cwd the edit log's paths must still fall inside it), or the cwd outside a repo. */
export function repoTop(cwd: string): string {
  const r = git(cwd, ['rev-parse', '--show-cdup']);
  return r.code === 0 ? resolvePath(cwd, r.out.trim() || '.') : resolvePath(cwd);
}

interface CoveragePin {
  top: string;
  /** HEAD when the session started; null: no commit, or no repo; absent: git could not say. */
  head?: string | null;
  exemptions: string[];
  /** The other user globs by key (I3a); absent in a pin from before them: none. */
  globs?: Partial<Record<UserGlobKey, string[]>>;
}

const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((g) => typeof g === 'string');

function readPin(sessionId: string): CoveragePin | null {
  try {
    const p = JSON.parse(readFileSync(join(ensureSessionDir(sessionId), PIN_FILE), 'utf8')) as CoveragePin;
    const headOk = p?.head === undefined || p.head === null || typeof p.head === 'string';
    const globsOk = p?.globs === undefined || (typeof p.globs === 'object' && p.globs !== null && Object.values(p.globs).every(stringList));
    return typeof p?.top === 'string' && headOk && stringList(p.exemptions) && globsOk ? p : null;
  } catch {
    return null;
  }
}

/** The start HEAD: a commit id; null in a repo with no commit or outside a repo (a repo made
 *  later starts empty); undefined when git did not run. */
function startHeadNow(top: string): string | null | undefined {
  const now = git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (now.code === 0) return now.out.trim();
  const dir = git(top, ['rev-parse', '--git-dir']);
  return dir.code === 0 || dir.code === 128 ? null : undefined;
}

/** SessionStart (startup, resume, clear): the exemptions as they are now, and the HEAD the
 *  session started from (kept from the first start, so a resume does not move it past commits
 *  made earlier in the session). */
export function pinCoverageStart(sessionId: string, cwd: string): void {
  try {
    const top = repoTop(cwd);
    const old = readPin(sessionId);
    const head = old && old.top === top && old.head !== undefined ? old.head : startHeadNow(top);
    const pin: CoveragePin = {
      top,
      ...(head !== undefined ? { head } : {}),
      exemptions: coverageExemptions(cwd, top),
      globs: Object.fromEntries(USER_GLOB_KEYS.filter((k) => k !== 'coverage-exempt').map((k) => [k, policyGlobs(cwd, top, k)])),
    };
    writeFileSync(join(ensureSessionDir(sessionId), PIN_FILE), JSON.stringify(pin), 'utf8');
  } catch {
    // best-effort: without a pin, the policy file counts only when older than the session
  }
}

/** What the gate may use this session: the exemptions pinned at its start that the policy
 *  file still has (without a pin: the file's, when it is older than the session dir), and the
 *  start HEAD (undefined: unknown, no base check). A pin for another top (a repo made during
 *  the session, a linked worktree) exempts nothing (its globs meant other paths) and keeps its
 *  HEAD only when that commit is in this repo; otherwise only the empty tree counts. */
export function sessionCoverageStart(sessionId: string, cwd: string, top: string): { exempt: string[]; head?: string | null } {
  const pin = readPin(sessionId);
  const exempt = sessionUserGlobs(sessionId, cwd, top, 'coverage-exempt', pin);
  if (pin && pin.top === top) return { exempt, ...(pin.head !== undefined ? { head: pin.head } : {}) };
  if (pin) {
    const known = typeof pin.head === 'string' && git(top, ['cat-file', '-e', '--end-of-options', `${pin.head}^{commit}`]).code === 0;
    return { exempt, head: known ? pin.head! : null };
  }
  return { exempt };
}

/** A user glob key's globs this session may use: those pinned at its start that the policy
 *  file still has. Without a pin: the file's, when it is older than the session dir. A pin for
 *  another top sets none (its globs meant other paths). */
export function sessionUserGlobs(sessionId: string, cwd: string, top: string, key: UserGlobKey, pin: CoveragePin | null = readPin(sessionId)): string[] {
  const current = policyGlobs(cwd, top, key);
  if (pin) {
    if (pin.top !== top) return [];
    const pinned = key === 'coverage-exempt' ? pin.exemptions : (pin.globs?.[key] ?? []);
    return current.filter((g) => pinned.includes(g));
  }
  if (current.length === 0) return [];
  try {
    const born = statSync(ensureSessionDir(sessionId)).birthtimeMs;
    const changed = statSync(join(knowledgeRoot(cwd).root, POLICY_FILE)).mtimeMs;
    return born > 0 && changed <= born ? current : [];
  } catch {
    return [];
  }
}

/** A changed file that needs its lines run: an existing code file a coverage tool measures,
 *  and for JS/TS only one with runtime code (types-only imports trimmed; a types-only file
 *  transpiles to nothing but `export {}`). A `.d.ts` is a declaration file: TypeScript never
 *  runs one (`export * from`, `export =` are declarations there), so it is not measured; code
 *  hidden in one that a test imports by its full name is a known limit (plan §15.2a). After
 *  `until` (epoch ms) a file counts as code unread (I8 review: many crafted files must not run
 *  the Stop past its timeout). */
function measurableCode(abs: string, until: number): boolean {
  const ext = extname(abs).toLowerCase();
  // A Gradle Kotlin build script runs in the build, never in a test (track L review: a test
  //   tool setup that adds JaCoCo could not pass).
  if (!CODE_EXT.has(ext) || !existsSync(abs) || /\.d\.[mc]?ts$/i.test(abs) || /\.gradle\.kts$/i.test(abs)) return false;
  if (Date.now() > until) return true;
  if (ext === '.java') return !codeFreeJava(abs);
  if (!JS_EXT.has(ext)) return true;
  try {
    // A FIFO or a device named like code would never finish reading (I8 review).
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return true;
    const loader = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : ['.js', '.mjs', '.cjs'].includes(ext) ? 'js' : 'ts';
    const js = new Bun.Transpiler({ loader, trimUnusedImports: true }).transformSync(readFileSync(abs, 'utf8'));
    return js.replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '').trim() !== '';
  } catch {
    return true;
  }
}

/** (#15) A Java file that declares only interfaces or annotation types with no executable code:
 *  no method body (default, static or private methods), no class, enum or record, and no field
 *  but compile-time constants (a primitive or String field set to a literal; any other
 *  initializer, `null`, `Foo.class` or a method reference runs in a static initializer). The
 *  compiler emits no bytecode lines for it, so JaCoCo leaves it out of the report and no test
 *  can run its lines (real-use trial 3: a MyBatis mapper interface). Read without comments,
 *  strings and annotations by linear scans (no regex that backtracks: a crafted file must not
 *  run the Stop past its timeout). Anything unsure counts as code: a unicode escape (javac
 *  reads a backslash, `u` and four hex digits as that character before anything else), and,
 *  outside comments and strings, any character but printable ASCII and whitespace (I8 review:
 *  javac takes non-ASCII names, `class 매출`, and ignores control and format characters
 *  inside a word, so `cl`, U+0001, `ass` is `class`). */
export function codeFreeJava(abs: string): boolean {
  let text: string;
  try {
    const st = statSync(abs);
    // A FIFO or a device named `.java` would never finish reading.
    if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return false;
    text = readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  if (/\\u+[0-9a-fA-F]{4}/.test(text)) return false;
  const bare = withoutAnnotations(stripLiteralsAndComments(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, true));
  if (bare === null || /[^\t\n\f\r\x20-\x7e]/.test(bare) || !/\binterface\b/.test(bare)) return false;
  if (/\b(?:class|enum|record)\s+[A-Za-z_$]/.test(bare)) return false;
  if (hasMethodBody(bare)) return false;
  // Every `=` must start a compile-time constant: `int A = 1;`, `String S = "…";` (blanked).
  for (const part of bare.split(/[;{}]/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (!CONSTANT_LEFT.test(part.slice(0, eq)) || !CONSTANT_RIGHT.test(part.slice(eq + 1))) return false;
  }
  return true;
}

const CONSTANT_LEFT = /^\s*(?:(?:public|static|final)\s+)*(?:byte|short|int|long|float|double|boolean|char|String)\s+[A-Za-z_$][\w$]*\s*$/;
const CONSTANT_RIGHT = /^\s*(?:[-+]?\s*[0-9][0-9a-fA-FxXbB_.]*(?:[eE][-+]?[0-9]+)?[lLfFdD]?|"\s*"|"""\s*"""|'\s*'|true|false)\s*$/;

/** Whether some `)` opens a body: `) {`, `)[] {`, `) throws A, B {`. Each `)` scans only the
 *  run after it, and no run holds a `)`, so the scans never overlap. */
function hasMethodBody(text: string): boolean {
  for (let i = text.indexOf(')'); i >= 0; i = text.indexOf(')', i + 1)) {
    let j = i + 1;
    const skip = () => {
      while (j < text.length && /\s/.test(text[j]!)) j++;
    };
    skip();
    while (text[j] === '[') {
      j++;
      skip();
      if (text[j] !== ']') break;
      j++;
      skip();
    }
    if (text.startsWith('throws', j) && !/[\w$]/.test(text[j + 6] ?? '')) {
      j += 6;
      while (j < text.length && /[\w$.<>,?&\s]/.test(text[j]!)) j++;
    }
    if (text[j] === '{') return true;
  }
  return false;
}

/** `text` without its annotations (`@Name`, `@a.b.Name(…)` with balanced parentheses; strings
 *  are already blanked), or null when the parentheses do not balance. `@interface` stays. */
function withoutAnnotations(text: string): string | null {
  const name = /@\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/y;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    name.lastIndex = i;
    const m = text[i] === '@' ? name.exec(text) : null;
    if (!m || m[1] === 'interface') {
      out += text[i];
      continue;
    }
    let j = i + m[0].length;
    while (j < text.length && /\s/.test(text[j]!)) j++;
    if (text[j] === '(') {
      let depth = 0;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) break;
      }
      if (depth !== 0) return null;
      j++;
    }
    out += ' ';
    i = j - 1;
  }
  return out;
}

/** The files of `rels` (repo-relative) that are not the base's blob, i.e. not an edit that was
 *  undone. Hashed as git would store them (line-ending attributes apply) with every filter
 *  driver emptied, so no program from the repo's config runs. Three git calls for all files. */
export function differFromBase(top: string, base: string, rels: string[]): Set<string> {
  const out = new Set(rels);
  if (rels.length === 0) return out;
  const want = treeBlobs(top, base, rels);
  const have = blobsNow(top, rels.filter((r) => want.has(r)));
  for (const [r, id] of have) if (id === want.get(r)) out.delete(r);
  return out;
}

/** The blob ids a commit or tree has for `rels`, by repo-relative path; none when git fails. */
function treeBlobs(top: string, tree: string, rels: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const listed = git(top, ['ls-tree', '-z', '--end-of-options', tree, '--', ...rels]);
  if (listed.code !== 0) return out;
  for (const e of listed.out.split('\0')) {
    const m = e.match(/^\d+ blob ([0-9a-f]+)\t([^]+)$/);
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

/** (#30) A file's content at a commit (a blob, as stored: no filters), or null when the commit
 *  or the path is unknown, the path is no regular file (a symlink 120000 or a gitlink is no
 *  baseline), the blob is over `maxBytes`, or git fails. Three short git calls: the mode first,
 *  then the size, so a huge blob is never read. */
export function blobAtCommit(top: string, commit: string, rel: string, maxBytes: number): string | null {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit) || rel === '' || rel.includes('\n')) return null;
  const entry = git(top, ['ls-tree', '-z', '--end-of-options', commit, '--', rel]);
  // Exactly one entry, `<mode> blob <id>\t<rel>\0`, of a regular file.
  const tab = entry.out.indexOf('\t');
  if (entry.code !== 0 || tab < 0 || entry.out.slice(tab + 1) !== `${rel}\0` || !/^(?:100644|100755) blob [0-9a-f]+$/.test(entry.out.slice(0, tab))) return null;
  const spec = `${commit}:${rel}`;
  const size = git(top, ['cat-file', '-s', '--end-of-options', spec]);
  if (size.code !== 0 || !/^\d+$/.test(size.out.trim()) || Number(size.out.trim()) > maxBytes) return null;
  const blob = git(top, ['cat-file', 'blob', '--end-of-options', spec]);
  return blob.code === 0 ? blob.out : null;
}

/** The repo-relative path of an edited file inside `top`, or null. */
function relInside(top: string, file: string): string | null {
  const r = relative(top, resolvePath(file));
  return r === '' || outside(r) ? null : r.split(sep).join('/');
}

/** The largest file whose blob id is computed; a larger one counts as changed. */
const MAX_HASH_BYTES = 16 * 1024 * 1024;

/** Git blob ids of the files' content now, hashed as differFromBase does (filters emptied).
 *  Only regular files (not a symlink, a FIFO or a device, which `hash-object` would follow or
 *  wait on: #23 security review) of at most MAX_HASH_BYTES; the others get no id, so they
 *  count as changed. */
function blobsNow(top: string, rels: string[]): Map<string, string> {
  const out = new Map<string, string>();
  rels = rels.filter((r) => {
    try {
      const st = lstatSync(join(top, r));
      return st.isFile() && st.size <= MAX_HASH_BYTES;
    } catch {
      return false;
    }
  });
  if (rels.length === 0) return out;
  const filters = filterOffArgs(git(top, ['config', '--name-only', '--get-regexp', '^filter\\.']).out);
  const have = git(top, [...filters, 'hash-object', '--', ...rels]);
  if (have.code !== 0) return out;
  const ids = have.out.trim().split('\n');
  rels.forEach((r, i) => {
    if (ids[i]) out.set(r, ids[i]!);
  });
  return out;
}

/** (#23) The edits that are a change of this session: a file whose content is its blob at the
 *  session-start HEAD (an edit undone, or brought back by a branch switch) is dropped. All kept
 *  when the start is unknown or had no commit, or git fails. */
export function netChangedEdits<T extends { file: string }>(edits: T[], top: string, startHead: string | null | undefined): T[] {
  if (typeof startHead !== 'string' || edits.length === 0) return edits;
  const rels = new Map<string, string>();
  for (const e of edits) {
    const r = relInside(top, e.file);
    if (r !== null && existsSync(resolvePath(e.file))) rels.set(e.file, r);
  }
  if (rels.size === 0) return edits;
  const differ = differFromBase(top, startHead, [...new Set(rels.values())]);
  return edits.filter((e) => !rels.has(e.file) || differ.has(rels.get(e.file)!));
}

const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** At most this many record trees are read per Stop (one `git ls-tree` each), within this time. */
const MAX_TREES = 30;
const TREE_BUDGET_MS = 2_000;

/** (#23) Each edit with the record trees that hold its current content (`sameContentTrees`).
 *  Only the trees of records that list the file (`filesOf`: a test record's tested files, #26 a
 *  review's reviewed files) and are older than its last edit are read: for the rest the time
 *  already decides. */
export function withSameContent<T extends ChangedFileEdit, R extends Pick<TestResult, 'timestamp' | 'tree'> = TestResult>(
  edits: T[],
  results: readonly R[],
  top: string,
  filesOf: (r: R) => readonly unknown[] | undefined = (r) => (r as Partial<TestResult>).tested_files,
): T[] {
  const want = new Map<string, Set<string>>(); // tree → rels to look up
  const relOf = new Map<string, string>();
  // Newest first, each with its tested files resolved once (performance review).
  const newest = results
    .filter((t) => typeof t.tree === 'string' && TREE_ID.test(t.tree))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .map((t) => ({ t, tested: new Set((filesOf(t) ?? []).filter((f): f is string => typeof f === 'string').map((f) => recordPath(f))) }));
  for (const e of edits) {
    const last = e.lastEditTimestamp;
    if (typeof last !== 'string' || last === '') continue;
    const abs = resolvePath(e.file);
    const r = relInside(top, abs);
    if (r === null || !existsSync(abs)) continue;
    for (const { t, tested } of newest) {
      if (t.timestamp > last || !tested.has(abs)) continue;
      if (!want.has(t.tree!) && want.size >= MAX_TREES) continue;
      relOf.set(e.file, r);
      want.set(t.tree!, (want.get(t.tree!) ?? new Set()).add(r));
    }
  }
  if (want.size === 0) return edits;
  const now = blobsNow(top, [...new Set(relOf.values())]);
  const same = new Map<string, Set<string>>(); // rel → trees
  // A time budget over the tree reads: a tree not read leaves its files to the time rule.
  const until = Date.now() + TREE_BUDGET_MS;
  for (const [tree, rels] of want) {
    if (Date.now() > until) break;
    for (const [r, id] of treeBlobs(top, tree, [...rels])) {
      if (now.get(r) === id) same.set(r, (same.get(r) ?? new Set()).add(tree));
    }
  }
  if (same.size === 0) return edits;
  return edits.map((e) => {
    const trees = relOf.has(e.file) ? same.get(relOf.get(e.file)!) : undefined;
    return trees ? { ...e, sameContentTrees: trees } : e;
  });
}

export interface GapsOut {
  /** False when no record carries usable changed-line coverage (and some file needs it). */
  measured: boolean;
  gaps: CoverageGap[];
  /** The record's base when the only measured runs diffed against a base after the start
   *  (`head` null: the session started with no commit, so only the empty tree counts). */
  lateBase?: { base: string; head: string | null };
  /** (#23) Files counted as run on a record's subprocess evidence (file level, not lines). */
  subprocess?: string[];
}

/** The changed code files whose changed lines no recorded run executed. `results` are the
 *  records the other layer-1 checks accepted. A record counts when it passed, has the whole
 *  diff-coverage output (`files`, `in_report`, `diff_lines`, `base`) and its base is not after
 *  the session's start; for each file, only such records that test it and were made after its
 *  last edit, the best of them. */
export function changedLineGaps(args: { results: TestResult[]; edits: ChangedFileEdit[]; top: string; exempt: string[]; startHead?: string | null }): GapsOut {
  const nowMs = Date.now();
  const whole = args.results.filter((r) => {
    const ch = r.coverage?.status === 'measured' ? r.coverage.changed : undefined;
    return (
      r.verdict === 'pass' &&
      isTrustedTimestamp(r.timestamp, nowMs) &&
      !!ch &&
      typeof ch.files === 'object' && ch.files !== null &&
      Array.isArray(ch.in_report) &&
      typeof ch.diff_lines === 'object' && ch.diff_lines !== null &&
      typeof ch.base === 'string'
    );
  });
  // The files that need their lines run: inside the repo, not exempt, existing code (or a
  //   file a report measured).
  const globs = args.exempt.map((g) => new Bun.Glob(g));
  const need: { abs: string; file: string; edit: ChangedFileEdit }[] = [];
  const seen = new Set<string>();
  const readUntil = Date.now() + READ_BUDGET_MS;
  for (const edit of [...args.edits].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const abs = resolvePath(edit.file);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const r = relative(args.top, abs);
    if (r === '' || outside(r)) continue;
    const file = r.split(sep).join('/');
    if (globs.some((g) => g.match(file))) continue;
    const reported = existsSync(abs) && whole.some((t) => Object.hasOwn(t.coverage!.changed!.files!, file));
    if (!reported && !measurableCode(abs, readUntil)) continue;
    need.push({ abs, file, edit });
  }
  if (need.length === 0) return { measured: true, gaps: [] };

  const empty = args.startHead === null ? emptyTree(args.top) : null;
  const baseOk = new Map<string, boolean>();
  let lateBase: GapsOut['lateBase'];
  const usable = whole.filter((r) => {
    const base = r.coverage!.changed!.base!;
    if (args.startHead === undefined) return true;
    let ok = baseOk.get(base);
    if (ok === undefined) {
      ok =
        args.startHead === null
          ? base === empty
          : base === args.startHead || git(args.top, ['merge-base', '--is-ancestor', '--end-of-options', base, args.startHead]).code === 0;
      baseOk.set(base, ok);
    }
    if (!ok) lateBase ??= { base, head: args.startHead };
    return ok;
  });
  if (usable.length === 0) return { measured: false, gaps: [], ...(lateBase ? { lateBase } : {}) };
  const tested = new Map(usable.map((t) => [t, new Set((t.tested_files ?? []).map((f) => recordPath(f)))]));

  const gaps: CoverageGap[] = [];
  const subprocess: string[] = [];
  const notInDiff = new Map<string, string[]>();
  // (#23) A changed line that did not run in the test process may have run in a process a test
  //   started: file-level evidence, listed apart.
  const read: SubprocessCache = { entry: new Map(), tests: new Map() };
  const acceptAsProcess = (fresh: TestResult[], file: string): boolean => {
    if (!fresh.some((t) => subprocessEvidence(t, file, args.top, read))) return false;
    subprocess.push(file);
    return true;
  };
  for (const { abs, file, edit } of need) {
    const fresh = usable.filter((t) => tested.get(t)!.has(abs) && freshFor(t, edit));
    if (fresh.length === 0) {
      gaps.push({ file, unmeasured: true });
      continue;
    }
    let best: { covered: number; total: number } | undefined;
    for (const t of fresh) {
      const c = Object.hasOwn(t.coverage!.changed!.files!, file) ? t.coverage!.changed!.files![file] : undefined;
      if (c && (!best || c.covered / Math.max(1, c.total) > best.covered / Math.max(1, best.total))) best = c;
    }
    if (best) {
      if (best.covered < best.total && !acceptAsProcess(fresh, file)) gaps.push({ file, covered: best.covered, total: best.total });
      continue;
    }
    if (fresh.some((t) => t.coverage!.changed!.in_report!.includes(file))) continue;
    const added = fresh.map((t) => t.coverage!.changed!.diff_lines![file]).filter((n): n is number => typeof n === 'number');
    if (added.length === 0) {
      const base = fresh[0]!.coverage!.changed!.base!;
      notInDiff.set(base, [...(notInDiff.get(base) ?? []), file]);
    } else if (Math.max(...added) > 0 && !acceptAsProcess(fresh, file)) {
      gaps.push({ file, absent: true });
    }
  }
  // Edited files the diff does not have: a gap unless they equal the base (one batch per base).
  for (const [base, files] of notInDiff) {
    for (const file of differFromBase(args.top, base, files)) gaps.push({ file, hidden: true });
  }
  gaps.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { measured: true, gaps, ...(subprocess.length > 0 ? { subprocess: subprocess.sort() } : {}) };
}

/** A call that starts a process, in the common test runners' languages. */
const SPAWN_CALL = /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|execa|fork|ProcessBuilder|subprocess\.(?:run|Popen|call|check_call|check_output)|exec\.Command)\s*\(/;

/** (#23) The record shows that a test ran `file` (repo-relative) as a process: it names the pair
 *  in `coverage.subprocess`, the test is in its `test_files`, a passing integration or e2e suite
 *  ran, and the test's text names the file (its path or base name, or its stem as a quoted string
 *  next to its directory's name) and starts a process. */
export function subprocessEvidence(t: TestResult, file: string, top: string, cache: SubprocessCache = { entry: new Map(), tests: new Map() }): boolean {
  const pairs = (Array.isArray(t.coverage?.subprocess) ? t.coverage.subprocess.slice(0, MAX_SUBPROCESS_PAIRS) : []).filter(
    (p) => !!p && p.file === file && typeof p.test === 'string',
  );
  if (pairs.length === 0 || t.verdict !== 'pass') return false;
  const typed = (t.suites ?? []).some((s) => !!s && (s.type === 'integration' || s.type === 'e2e') && s.passed > 0 && s.failed === 0);
  if (!typed) return false;
  // Only a file that runs as a program can run as a subprocess (security review: a library
  //   file named in a comment next to any spawn passed). Read once per file and per test file
  //   (performance review).
  let entry = cache.entry.get(file);
  if (entry === undefined) {
    const source = readRegular(join(top, file), MAX_SOURCE_BYTES);
    // The guard in code, not in a string (security review round 2); Python's needs its literal.
    entry = typeof source !== 'string' && (ENTRY_POINT.test(stripLiteralsAndComments(source.text)) || PY_MAIN.test(stripLiteralsAndComments(source.text, false, true)));
    cache.entry.set(file, entry);
  }
  if (!entry) return false;
  const testFiles = new Set((t.test_files ?? []).filter((f) => typeof f === 'string').map((f) => resolvePath(top, f)));
  const name = basename(file);
  const stem = name.slice(0, name.length - extname(name).length);
  const dir = basename(dirname(file));
  for (const p of pairs) {
    const test = resolvePath(top, p.test);
    if (!testFiles.has(test)) continue;
    let read = cache.tests.get(test);
    if (read === undefined) {
      const raw = readRegular(test, MAX_SOURCE_BYTES);
      read = typeof raw === 'string' ? null : { code: stripLiteralsAndComments(raw.text, false, true), spawns: SPAWN_CALL.test(stripLiteralsAndComments(raw.text)) };
      cache.tests.set(test, read);
    }
    if (read === null || !read.spawns) continue;
    // Named in the code, not in a comment, as a whole path part (`a.ts` is not `data.ts`); the
    //   base name also matches the whole path.
    const named =
      new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w.-])`).test(read.code) ||
      (dir !== '.' && dir !== '' && read.code.includes(dir) && new RegExp(`['"\`]${escapeRegExp(stem)}['"\`]`).test(read.code));
    if (named) return true;
  }
  return false;
}

/** What subprocessEvidence read, kept for one evaluation: per changed file whether it runs as a
 *  program, per test file its comment-free text and whether it starts a process (null when
 *  it cannot be read). */
export interface SubprocessCache {
  entry: Map<string, boolean>;
  tests: Map<string, { code: string; spawns: boolean } | null>;
}

/** At most this many `coverage.subprocess` pairs of a record are read. */
const MAX_SUBPROCESS_PAIRS = 50;

/** A file that runs as a program: a JS/TS main guard or a top-level `main()` call, a Go or JVM
 *  main, or a shebang (on literal-free text); Python's guard (on comment-free text). */
const ENTRY_POINT = /import\.meta\.main|require\.main\s*===?\s*module|\bfunc\s+main\s*\(\s*\)|\bstatic\s+void\s+main\s*\(|^\s*(?:void\s+|await\s+)?main\s*\(\s*\)|^#!/m;
const PY_MAIN = /^\s*if\s+__name__\s*==\s*['"]__main__['"]/m;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The model-facing reason (English): what did not run, and the only ways forward. */
export function changedLineReason(out: GapsOut, cliPath: string): string {
  if (out.lateBase) {
    const { base, head } = out.lateBase;
    return (
      `The changed-line coverage was measured against ${base.slice(0, 12)}, ` +
      (head === null ? 'but this repo had no commit the session started from' :`which is not the commit this session started from (${head.slice(0, 12)}) or an ancestor of it`) +
      `, so changes made since could be left out. Measure again with \`bun "${cliPath}" diff-coverage <report> --base ` +
      `${head ?? EMPTY_BASE}\` and record it. (changed-line coverage)`
    );
  }
  if (!out.measured) {
    return (
      'Changed-line coverage is not measured: run the measure-coverage skill and record the whole ' +
      `\`bun "${cliPath}" diff-coverage <report>\` output as \`coverage.changed\` (with its \`files\`, \`in_report\`, ` +
      '`diff_lines` and `base`) in a passing result. With no coverage tool in the project, record a `blocked` result ' +
      "with the evidence; adding a tool is the user's decision. (changed-line coverage)"
    );
  }
  const list = out.gaps
    .slice(0, 6)
    .map((g) =>
      'absent' in g
        ? `${g.file} (not in the coverage report)`
        : 'unmeasured' in g
          ? `${g.file} (no passing record after its last edit measured it)`
          : 'hidden' in g
            ? `${g.file} (edited, but not in the coverage diff)`
            : `${g.file} (${g.covered} of ${g.total} lines ran)`,
    )
    .join('; ');
  const hidden = out.gaps.some((g) => 'hidden' in g)
    ? 'A file git does not show in the diff (ignored, assume-unchanged, a nested repo) has to be in it to be measured, or be the user\'s exemption. '
    : '';
  const absent = out.gaps.some((g) => 'absent' in g)
    ? 'A file is missing from a report when no test loaded it, or when the report names it by a path outside this ' +
      'repo (tests run in a container or another checkout): run the tests from this checkout. '
    : '';
  return (
    `Changed lines that no test ran: ${list}${out.gaps.length > 6 ? ` and ${out.gaps.length - 6} more` : ''}. ` +
    `Write tests that run them (write-regression-test) and record the coverage again. ${absent}${hidden}A file whose code runs only in a ` +
    'child process needs an in-process test, or the user can exempt it: a `decide: human` entry in .goodboy/policy.md ' +
    'with `coverage-exempt: <glob>`, which the user adds and which counts from the next session. (changed-line coverage)'
  );
}
