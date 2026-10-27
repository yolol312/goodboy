// Changed-line coverage as a rule (track I, I1, issue #2): every changed code line runs in a
// test of the recorded tree. The test records carry `coverage.changed` from `cli.ts
// diff-coverage` (per file, the files the report saw at all, the files the diff has with their
// added lines, and the base); the layer-1 gate reads them here. For each changed file only the
// passing records the other layer-1 checks accepted and that hold the file's current content
// count (R4, v0.36.6: by content, never by time; a tree-less record by time while its checkout is
// unchanged). A
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
// explanation. A record measured against a base other than the start HEAD would hide the
// changes made since, so for a file it counts only where the file is the same at that base and
// at the start (R2, v0.36.6); a session that started with no commit counts a base where the file
// does not exist. A same-user limit stays: a glob written in one
// session counts in the next. GOODBOY_DIFF_COVERAGE=on (default) | warn | off.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { currentHashBatch, spawnGit } from './git-run';
import { knowledgeRoot, parsePolicyEntries, POLICY_FILE } from './project-knowledge';
import { hasSpelling, sameFileSpelling } from './path-spelling';
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
  /** No passing record of the file's current content measured it. */
  | { file: string; unmeasured: true }
  /** (R2) Records of its current content measured it only against `refusedBase`, where the file is
   *  not what it is at the session's start `head` (null: no commit then), so the lines this
   *  session changed could be left out. */
  | { file: string; refusedBase: string; head: string | null };

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

/** git with the protections of lib/git-run.ts (no replace refs, no grafts, no fsmonitor, no lazy
 *  fetch, no filter driver). Exit -1: git did not run or timed out; 128: not a repo (or a bad
 *  object). `left`: the time left of a shared deadline (no call when it is 0). */
function git(cwd: string, args: string[], input?: string, timeoutMs = 5_000, left?: () => number): { code: number; out: string } {
  const r = spawnGit(cwd, args, { ...(input === undefined ? {} : { input }), timeoutMs, ...(left ? { left } : {}) });
  return { code: r.code, out: r.out };
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
 *  driver emptied, so no program from the repo's config runs. Three git calls for all files (the
 *  filter list is kept for the snapshot). `left`: the time left of a shared deadline; with none,
 *  every file counts as changed. */
export function differFromBase(top: string, base: string, rels: string[], left?: () => number): Set<string> {
  const out = new Set(rels);
  if (rels.length === 0) return out;
  const want = treeBlobs(top, base, rels, left);
  const have = blobsNow(top, rels.filter((r) => want.has(r)), left);
  for (const [r, id] of have) if (id === want.get(r)) out.delete(r);
  return out;
}

/** A path's entry in a tree: the mode (`100644`, `100755`, `120000`, `160000`, `040000`), the
 *  object type and its id. */
export interface TreeEntry {
  mode: string;
  type: string;
  id: string;
}

/** The entries a commit or tree has for `rels` (repo-relative, as the caller spells them), or null
 *  when git cannot read it (a missing object, git failing or out of time). A path the tree lacks
 *  has no entry. Git's own spelling of a path is never rewritten: a name git returns in the other
 *  Unicode form (macOS stores NFC) counts as the requested one only when the file system says it
 *  is the same file (lib/path-spelling.ts). */
export function treeEntries(top: string, tree: string, rels: readonly string[], left?: () => number): Map<string, TreeEntry> | null {
  // Sorted, so the same files in another order are the same call (the snapshot keeps its answer).
  const listed = git(top, ['ls-tree', '-z', '--end-of-options', tree, '--', ...[...new Set(rels)].sort()], undefined, 5_000, left);
  if (listed.code !== 0) return null;
  const named = new Map<string, TreeEntry>();
  for (const e of listed.out.split('\0')) {
    const m = e.match(/^(\d+) (\w+) ([0-9a-f]+)\t([^]+)$/);
    if (m) named.set(m[4]!, { mode: m[1]!, type: m[2]!, id: m[3]! });
  }
  const out = new Map<string, TreeEntry>();
  for (const rel of rels) {
    const name = named.has(rel) ? rel : sameFileSpelling(top, rel, named.keys());
    if (name !== null) out.set(rel, named.get(name)!);
  }
  return out;
}

/** The blob ids a commit or tree has for `rels`, by repo-relative path; none when git fails. */
function treeBlobs(top: string, tree: string, rels: string[], left?: () => number): Map<string, string> {
  const out = new Map<string, string>();
  for (const [rel, e] of treeEntries(top, tree, rels, left) ?? []) if (e.type === 'blob') out.set(rel, e.id);
  return out;
}

/** (#30) A file's content at a commit (a blob, as stored: no filters), or null when the commit
 *  or the path is unknown, the path is no regular file (a symlink 120000 or a gitlink is no
 *  baseline), the blob is over `maxBytes`, or git fails. Three short git calls: the mode first,
 *  then the size, so a huge blob is never read. `left`: the time left of a shared deadline (null
 *  when it runs out). */
export function blobAtCommit(top: string, commit: string, rel: string, maxBytes: number, left?: () => number): string | null {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit) || rel === '' || rel.includes('\n')) return null;
  const entry = git(top, ['ls-tree', '-z', '--end-of-options', commit, '--', rel], undefined, 5_000, left);
  // Exactly one entry, `<mode> blob <id>\t<rel>\0`, of a regular file.
  const tab = entry.out.indexOf('\t');
  if (entry.code !== 0 || tab < 0 || entry.out.slice(tab + 1) !== `${rel}\0` || !/^(?:100644|100755) blob [0-9a-f]+$/.test(entry.out.slice(0, tab))) return null;
  const spec = `${commit}:${rel}`;
  const size = git(top, ['cat-file', '-s', '--end-of-options', spec], undefined, 5_000, left);
  if (size.code !== 0 || !/^\d+$/.test(size.out.trim()) || Number(size.out.trim()) > maxBytes) return null;
  const blob = git(top, ['cat-file', 'blob', '--end-of-options', spec], undefined, 5_000, left);
  return blob.code === 0 ? blob.out : null;
}

/** The repo-relative path (with `/`) of a file inside `top`, or null. */
export function relInside(top: string, file: string): string | null {
  const r = relative(top, resolvePath(file));
  return r === '' || outside(r) ? null : r.split(sep).join('/');
}

/** The largest file whose blob id is computed; a larger one counts as changed. */
const MAX_HASH_BYTES = 16 * 1024 * 1024;

/** Git blob ids of the files' content now, hashed as differFromBase does (filters emptied).
 *  Only regular files (not a symlink, a FIFO or a device, which `hash-object` would follow or
 *  wait on: #23 security review) of at most MAX_HASH_BYTES; the others get no id, so they
 *  count as changed. One call for the files not yet hashed in this evaluation (a hash batch,
 *  lib/git-run.ts): several checks of one evaluation ask for the same files, and a file is hashed
 *  again only when its stat (inode, size, ctime, mtime) is no longer what it was. Outside a batch
 *  nothing is kept. */
function blobsNow(top: string, rels: string[], left?: () => number): Map<string, string> {
  const out = new Map<string, string>();
  const known = currentHashBatch();
  const todo: { rel: string; stat: string }[] = [];
  for (const rel of rels) {
    try {
      const st = lstatSync(join(top, rel));
      if (!st.isFile() || st.size > MAX_HASH_BYTES) continue;
      const stat = `${st.ino}:${st.size}:${st.ctimeMs}:${st.mtimeMs}`;
      const hit = known?.get(`${top}\0${rel}`);
      if (hit?.stat === stat) out.set(rel, hit.id);
      else todo.push({ rel, stat });
    } catch {
      // gone: no id
    }
  }
  if (todo.length === 0) return out;
  const have = git(top, ['hash-object', '--', ...todo.map((t) => t.rel)], undefined, 5_000, left);
  if (have.code !== 0) return out;
  const ids = have.out.trim().split('\n');
  todo.forEach(({ rel, stat }, i) => {
    if (!ids[i]) return;
    out.set(rel, ids[i]!);
    known?.set(`${top}\0${rel}`, { stat, id: ids[i]! });
  });
  return out;
}

/** (v0.36.6) How many files, and how many bytes in all, `extraBlobsFor` hashes for one record. Past
 *  either the rest are left out: those files stay unverified, which fails closed. */
const EXTRA_BLOBS_MAX_FILES = 64;
const EXTRA_BLOBS_MAX_BYTES = 8 * 1024 * 1024;

/** (v0.36.6) The content ids a record keeps for the listed files its `tree` cannot show. A file
 *  that git ignores, or that the work-tree hash leaves out, is in no record tree, so no record could
 *  ever evidence an edit to it (an ignored `.env.local`, a local `scripts/local.js`). `test-write`
 *  and `review-write` call this with the files they list (absolute paths, as stored) and keep the
 *  answer as `extra_blobs`, keyed by those paths; the agent never supplies it. Only a file that is
 *  inside the repo (its real parent too), an existing regular file with one link, and absent from
 *  `tree` is hashed, with `blobsNow`: the method the Stop's current-content check uses, so both sides
 *  agree. A tree git cannot read, or no tree, gives nothing; past the caps the rest is left out.
 *  Undefined when there is nothing to keep. */
export function extraBlobsFor(
  top: string,
  tree: string | null | undefined,
  files: readonly string[],
  caps: { files?: number; bytes?: number } = {},
): Record<string, string> | undefined {
  if (typeof tree !== 'string' || !TREE_ID.test(tree) || files.length === 0) return undefined;
  const maxFiles = caps.files ?? EXTRA_BLOBS_MAX_FILES;
  const maxBytes = caps.bytes ?? EXTRA_BLOBS_MAX_BYTES;
  let realTop: string;
  try {
    realTop = realpathSync(top);
  } catch {
    return undefined;
  }
  const rels = new Map<string, string>(); // repo-relative → the path as stored
  for (const file of files) {
    const rel = relInside(top, file);
    if (rel === null || rels.has(rel)) continue;
    try {
      const st = lstatSync(join(top, rel));
      if (!st.isFile() || st.nlink !== 1) continue;
      const parent = relative(realTop, realpathSync(dirname(join(top, rel))));
      if (outside(parent)) continue;
    } catch {
      continue;
    }
    rels.set(rel, file);
  }
  if (rels.size === 0) return undefined;
  const entries = treeEntries(top, tree, [...rels.keys()]);
  if (entries === null) return undefined;
  const out: Record<string, string> = {};
  let bytes = 0;
  const pick: string[] = [];
  for (const rel of rels.keys()) {
    if (entries.has(rel)) continue; // the tree shows it: judged by the tree
    let size: number;
    try {
      size = lstatSync(join(top, rel)).size;
    } catch {
      continue;
    }
    if (pick.length >= maxFiles || bytes + size > maxBytes) break; // the rest is left out
    pick.push(rel);
    bytes += size;
  }
  const ids = blobsNow(top, pick);
  for (const rel of pick) {
    const id = ids.get(rel);
    if (id !== undefined) out[rels.get(rel)!] = id;
  }
  return Object.keys(out).length === 0 ? undefined : out;
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

/** (v0.36.6, branch diagnostic) The files of `rels` that differ from the session's start HEAD only
 *  because HEAD is no longer on the start's line: each equals its blob at merge-base(start, HEAD),
 *  so the session did not change it. The note a block adds when some obligation is one of these:
 *  it still blocks (the comparison base is the start, R1 is later), and a session started on this
 *  branch does not count them. Null when HEAD is the start, there is no start commit, there is no
 *  common ancestor, or git fails. */
export function divergedFromStart(top: string, startHead: string | null | undefined, rels: readonly string[]): { head: string; mergeBase: string; files: string[] } | null {
  if (typeof startHead !== 'string' || rels.length === 0) return null;
  const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const headId = head.code === 0 ? head.out.trim() : '';
  if (!TREE_ID.test(headId) || headId === startHead) return null;
  const mb = git(top, ['merge-base', '--end-of-options', startHead, headId]);
  const mergeBase = mb.code === 0 ? mb.out.trim() : '';
  if (!TREE_ID.test(mergeBase) || mergeBase === startHead) return null; // HEAD is ahead of the start: its changes are the session's
  const present = [...treeBlobs(top, mergeBase, [...rels]).keys()];
  const differ = differFromBase(top, mergeBase, present);
  const files = present.filter((r) => !differ.has(r));
  return files.length === 0 ? null : { head: headId, mergeBase, files };
}

const TREE_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** At most this many record trees are read per Stop (one `git ls-tree` each, all the files a tree
 *  is asked about in that call), within this time. A tree past either limit is not read, and its
 *  record is not evidence (it never falls back to its time). */
const MAX_TREES = 30;
const TREE_BUDGET_MS = 2_000;
/** Distinct commits of tree-less records whose checkout is compared with HEAD, per Stop. */
const MAX_EPOCH_COMMITS = 20;

export interface SameContentOptions {
  /** The clock in ms (a test's). */
  now?: () => number;
  maxTrees?: number;
  budgetMs?: number;
}

/** A file's content and kind now: not there, a regular file (its blob id, and whether it is
 *  executable), or something git's tree cannot be compared with here (a link, a directory, a file
 *  too large to hash, a read error). */
type NowState = { kind: 'absent' } | { kind: 'file'; id: string; exec: boolean } | { kind: 'unknown' };

function currentStates(top: string, rels: readonly string[], left?: () => number): Map<string, NowState> {
  const out = new Map<string, NowState>();
  const regular: string[] = [];
  const exec = new Map<string, boolean>();
  for (const rel of rels) {
    try {
      const st = lstatSync(join(top, rel));
      if (st.isFile()) {
        regular.push(rel);
        exec.set(rel, (st.mode & 0o111) !== 0);
      } else out.set(rel, { kind: 'unknown' });
    } catch (err) {
      out.set(rel, (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown' });
    }
  }
  const ids = blobsNow(top, regular, left);
  for (const rel of regular) {
    const id = ids.get(rel);
    out.set(rel, id === undefined ? { kind: 'unknown' } : { kind: 'file', id, exec: exec.get(rel)! });
  }
  return out;
}

/** Whether a tree entry is the file as it is now: the same content and kind. */
function sameAsNow(entry: TreeEntry | undefined, now: NowState, execIgnored: () => boolean): boolean {
  if (now.kind === 'absent') return entry === undefined;
  if (now.kind !== 'file' || entry === undefined || entry.type !== 'blob' || entry.id !== now.id) return false;
  if (entry.mode === (now.exec ? '100755' : '100644')) return true;
  // The other regular mode: the same file only where the repo does not track the executable bit.
  return (entry.mode === '100644' || entry.mode === '100755') && execIgnored();
}

/** Whether the repo ignores the executable bit (`core.fileMode=false`); asked only after a mismatch. */
function fileModeOff(top: string): boolean {
  const r = git(top, ['config', '--bool', 'core.fileMode']);
  return r.code === 0 && r.out.trim() === 'false';
}

/** Whether `top` is outside any git repo (git says 128 to `rev-parse --git-dir`). */
function noRepo(top: string, left: () => number): boolean {
  return git(top, ['rev-parse', '--git-dir'], undefined, 5_000, left).code === 128;
}

/** The records with no `tree` key whose time cannot be trusted: HEAD now is not the checkout they
 *  were made on, or it is not known. Such a record is judged by time, and time proves nothing
 *  after `git checkout`, `reset` or a branch switch (the edit log does not see them). Trusted
 *  only while the record's commit is HEAD or an ancestor of it, which a checkout of another line
 *  does not keep. A repo whose HEAD does not resolve (no commit yet, or `git checkout --orphan`
 *  from a committed one) has no checkout to trust, and neither has one where git did not run: every
 *  such record is distrusted. Outside a repo (git says 128) there is no checkout to doubt. A
 *  residual: a switch to a later commit of the same line looks unchanged. */
function distrustedLegacy(top: string, legacy: readonly { commit?: string | null }[], left: () => number): Set<object> {
  const out = new Set<object>();
  if (legacy.length === 0) return out;
  const all = (): Set<object> => new Set<object>(legacy as object[]);
  const head = git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], undefined, 5_000, left);
  if (head.code !== 0) return noRepo(top, left) ? out : all();
  const headId = head.out.trim();
  const verdict = new Map<string, boolean>();
  for (const r of legacy) {
    const commit = typeof r.commit === 'string' && TREE_ID.test(r.commit) ? r.commit : null;
    if (commit === null) {
      out.add(r as object);
      continue;
    }
    let ok = verdict.get(commit);
    if (ok === undefined) {
      ok =
        commit === headId ||
        (verdict.size < MAX_EPOCH_COMMITS && left() > 0 && git(top, ['merge-base', '--is-ancestor', '--end-of-options', commit, headId], undefined, 5_000, left).code === 0);
      verdict.set(commit, ok);
    }
    if (!ok) out.add(r as object);
  }
  return out;
}

/** The content id a record kept for `abs` in `extra_blobs` (absolute paths as stored; another
 *  Unicode spelling counts only through the file system), or undefined. */
function extraBlobOf(rec: { extra_blobs?: unknown }, abs: string): string | undefined {
  const m = rec.extra_blobs;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return undefined;
  const byPath = new Map<string, unknown>();
  for (const [k, v] of Object.entries(m)) byPath.set(recordPath(k), v);
  const key = byPath.has(abs) ? abs : sameFileSpelling('', abs, byPath.keys());
  const id = key === null ? undefined : byPath.get(key);
  return typeof id === 'string' && TREE_ID.test(id) ? id : undefined;
}

/** (#23, R4) Each edit with what its records show about its current content: `sameContentTrees`,
 *  the record trees that hold the file's content and kind now; `unverifiedTrees`, trees that list
 *  it and could not be compared (not readable, past MAX_TREES or the time budget); and
 *  `distrustedRecords`, records with no `tree` key whose time is not trusted (distrustedLegacy);
 *  `timeTrustedRecords`, records with `tree: null` outside a git repo (any other `tree: null`
 *  record is unverified, see `freshness`). Only the
 *  records that list the file (`filesOf`: a test record's tested files, #26 a review's reviewed
 *  files) count, whatever their time: a checkout changes a file with no edit in the log, so a
 *  record is judged by content, never by "made after the last edit". The records' trees are read
 *  once each, with every file they are asked about in one call. */
export function withSameContent<T extends ChangedFileEdit, R extends Pick<TestResult, 'timestamp' | 'tree' | 'commit' | 'extra_blobs'> = TestResult>(
  edits: T[],
  results: readonly R[],
  top: string,
  filesOf: (r: R) => readonly unknown[] | undefined = (r) => (r as Partial<TestResult>).tested_files,
  options: SameContentOptions = {},
): T[] {
  const now = options.now ?? Date.now;
  const t0 = now();
  const left = (): number => (options.budgetMs ?? TREE_BUDGET_MS) - (now() - t0);
  // Newest first, each with its listed files resolved once (performance review).
  const records = [...results]
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    .map((r) => ({ r, listed: new Set((filesOf(r) ?? []).filter((f): f is string => typeof f === 'string').map((f) => recordPath(f))) }));
  const lists = (listed: ReadonlySet<string>, abs: string): boolean => listed.has(abs) || hasSpelling('', abs, listed);

  const want = new Map<string, Set<string>>(); // tree → rels to look up, in the order the trees are read
  const trees = new Map<string, { edit: number; rel: string; abs: string; rec: R }[]>(); // tree → the edits that ask
  const overflow = new Map<number, Set<string>>(); // edit → trees past the cap
  const legacyFor = new Map<number, Set<object>>(); // edit → records with no tree key that list it
  const nullFor = new Map<number, Set<object>>(); // edit → records with `tree: null` that list it
  const maxTrees = options.maxTrees ?? MAX_TREES;
  const asks: { edit: number; rel: string; abs: string; recs: R[] }[] = []; // per edit, its tree-bearing records newest first
  edits.forEach((e, i) => {
    const abs = resolvePath(e.file);
    const rel = relInside(top, abs);
    const recs: R[] = [];
    for (const { r, listed } of records) {
      if (!lists(listed, abs)) continue;
      const tree = r.tree;
      if (tree === null) nullFor.set(i, (nullFor.get(i) ?? new Set()).add(r as object));
      else if (rel === null) continue; // outside the repo: no tree to read
      else if (tree === undefined) legacyFor.set(i, (legacyFor.get(i) ?? new Set()).add(r as object));
      else if (typeof tree === 'string' && TREE_ID.test(tree)) recs.push(r); // malformed: freshness says unverified
    }
    if (rel !== null && recs.length > 0) asks.push({ edit: i, rel, abs, recs });
  });
  // The cap is spent newest first across the edits, one record per edit at a time: every file's
  //   newest records are read before any file's older ones, so a file with many old records never
  //   starves another file's newest. A tree already wanted costs nothing (one read serves every
  //   edited path that asks), whichever record brought it.
  for (let depth = 0; asks.some((a) => a.recs.length > depth); depth++) {
    for (const { edit, rel, abs, recs } of asks) {
      const rec = recs[depth];
      if (rec === undefined) continue;
      const tree = rec.tree as string;
      if (!want.has(tree) && want.size >= maxTrees) {
        overflow.set(edit, (overflow.get(edit) ?? new Set()).add(tree));
        continue;
      }
      want.set(tree, (want.get(tree) ?? new Set()).add(rel));
      trees.set(tree, [...(trees.get(tree) ?? []), { edit, rel, abs, rec }]);
    }
  }

  const same = new Map<number, Set<string>>(); // edit → trees with its current content
  const unverified = new Map<number, Set<string>>(); // edit → trees that could not be compared
  const extraSame = new Map<number, Set<object>>(); // edit → records whose `extra_blobs` hold its content
  const add = (m: Map<number, Set<string>>, i: number, tree: string): void => {
    m.set(i, (m.get(i) ?? new Set()).add(tree));
  };
  for (const [i, set] of overflow) for (const t of set) add(unverified, i, t);
  if (want.size > 0) {
    const states = currentStates(top, [...new Set([...want.values()].flatMap((rels) => [...rels]))], left);
    let execIgnored: boolean | undefined;
    for (const [tree, rels] of want) {
      // A time budget over the tree reads: a tree not read is not evidence (never the time rule).
      const entries = left() > 0 ? treeEntries(top, tree, [...rels], left) : null;
      for (const { edit, rel, abs, rec } of trees.get(tree)!) {
        const state = states.get(rel)!;
        if (entries === null || state.kind === 'unknown') add(unverified, edit, tree);
        else if (sameAsNow(entries.get(rel), state, () => (execIgnored ??= fileModeOff(top)))) add(same, edit, tree);
        else if (entries.get(rel) === undefined && state.kind === 'file' && extraBlobOf(rec, abs) === state.id) {
          // (v0.36.6) The tree lacks the file (ignored, or left out of the hash): the id the record
          //   itself took of it counts, for this record only (not for the tree).
          extraSame.set(edit, (extraSame.get(edit) ?? new Set()).add(rec as object));
        }
      }
    }
  }
  const treeless = new Set<object>();
  for (const set of legacyFor.values()) for (const r of set) treeless.add(r);
  const distrusted = distrustedLegacy(top, [...treeless] as { commit?: string | null }[], left);
  // A record with `tree: null` is never judged by time, except where no repo could give it a tree.
  const nulls = new Set<object>();
  for (const set of nullFor.values()) for (const r of set) nulls.add(r);
  const timeTrusted = nulls.size > 0 && noRepo(top, left) ? nullFor : new Map<number, Set<object>>();

  if (same.size === 0 && unverified.size === 0 && distrusted.size === 0 && extraSame.size === 0 && timeTrusted.size === 0) return edits;
  return edits.map((e, i) => {
    const own = [...(legacyFor.get(i) ?? [])].filter((r) => distrusted.has(r));
    if (!same.has(i) && !unverified.has(i) && !extraSame.has(i) && own.length === 0 && !timeTrusted.has(i)) return e;
    return {
      ...e,
      ...(same.has(i) ? { sameContentTrees: same.get(i)! } : {}),
      ...(unverified.has(i) ? { unverifiedTrees: unverified.get(i)! } : {}),
      ...(extraSame.has(i) ? { extraBlobRecords: extraSame.get(i)! } : {}),
      ...(own.length > 0 ? { distrustedRecords: new Set(own) } : {}),
      ...(timeTrusted.has(i) ? { timeTrustedRecords: timeTrusted.get(i)! } : {}),
    };
  });
}

/** The edits with every record unverified: the answer when the content check itself failed (a
 *  record that cannot be read, an error). A record with no tree is not judged by time, and one
 *  with a tree is not the file's content, so nothing counts as evidence. */
export function allUnverified<T extends ChangedFileEdit>(edits: T[], results: readonly Pick<TestResult, 'tree'>[]): T[] {
  const distrustedRecords = new Set<object>(results);
  const unverifiedTrees = new Set(results.flatMap((r) => (typeof r.tree === 'string' ? [r.tree] : [])));
  return edits.map((e) => ({ ...e, distrustedRecords, unverifiedTrees }));
}

export interface GapsOut {
  /** False when no record carries usable changed-line coverage (and some file needs it). */
  measured: boolean;
  gaps: CoverageGap[];
  /** (#23) Files counted as run on a record's subprocess evidence (file level, not lines). */
  subprocess?: string[];
}

/** The key of `obj` that names `file` (repo-relative): the same spelling, or its Unicode twin that
 *  is the same file on disk; null when there is none. */
function keyIn(top: string, obj: Record<string, unknown>, file: string): string | null {
  if (Object.hasOwn(obj, file)) return file;
  return NON_ASCII.test(file) ? sameFileSpelling(top, file, Object.keys(obj)) : null;
}
const NON_ASCII = /[^\x00-\x7f]/;

/** `file` is in a list of repo-relative paths (the spelling, or its twin on disk). */
function listed(top: string, names: readonly string[], file: string): boolean {
  return names.includes(file) || (NON_ASCII.test(file) && hasSpelling(top, file, names));
}

/** An absolute path is in a set of them (the spelling, or its twin on disk). */
function hasPath(paths: ReadonlySet<string>, abs: string): boolean {
  return paths.has(abs) || (NON_ASCII.test(abs) && hasSpelling('', abs, paths));
}

/** Two tree entries are one file: the same mode and blob, or neither exists. */
function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mode === b.mode && a.type === b.type && a.id === b.id;
}

/** The changed code files whose changed lines no recorded run executed. `results` are the
 *  records that pass every other layer-1 check on their own (not only the one each file's time
 *  picked: a content-matching record that measured the file counts wherever it stands in the
 *  list). A record counts when it passed and has the whole diff-coverage output (`files`,
 *  `in_report`, `diff_lines`, `base`); for each file, only such records that test it and hold its
 *  current content (`freshFor`), the best of them. (R2) A base other than the session's start
 *  HEAD is accepted for a file only when the file's entry there (mode and blob, or none) is its
 *  entry at the start: a diff against another base can list other lines, and ancestry says
 *  nothing about that. */
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
    const reported = existsSync(abs) && whole.some((t) => keyIn(args.top, t.coverage!.changed!.files!, file) !== null);
    if (!reported && !measurableCode(abs, readUntil)) continue;
    need.push({ abs, file, edit });
  }
  if (need.length === 0) return { measured: true, gaps: [] };

  if (whole.length === 0) return { measured: false, gaps: [] };
  const tested = new Map(whole.map((t) => [t, new Set((t.tested_files ?? []).map((f) => recordPath(f)))]));

  // (R2) A base is accepted per file: the start HEAD itself, or one where the file is what it is
  //   at the start. Each base is read once for all the files, and the start once.
  const rels = need.map((n) => n.file);
  let startEntries: Map<string, TreeEntry> | null | undefined; // read when a base other than the start's is met
  const baseOk = new Map<string, Map<string, boolean>>(); // base → file → accepted
  const acceptsBase = (base: string, file: string): boolean => {
    if (args.startHead === undefined || base === args.startHead) return true;
    let per = baseOk.get(base);
    if (per === undefined) {
      if (startEntries === undefined) startEntries = typeof args.startHead === 'string' ? treeEntries(args.top, args.startHead, rels) : new Map();
      const start = startEntries;
      const at = TREE_ID.test(base) ? treeEntries(args.top, base, rels) : null;
      per = new Map(rels.map((f) => [f, at !== null && start !== null && sameEntry(at.get(f), start.get(f))]));
      baseOk.set(base, per);
    }
    return per.get(file) === true;
  };

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
    const own = whole.filter((t) => hasPath(tested.get(t)!, abs) && freshFor(t, edit));
    if (own.length === 0) {
      gaps.push({ file, unmeasured: true });
      continue;
    }
    const fresh = own.filter((t) => acceptsBase(t.coverage!.changed!.base!, file));
    if (fresh.length === 0) {
      gaps.push({ file, refusedBase: own[0]!.coverage!.changed!.base!, head: args.startHead ?? null });
      continue;
    }
    let best: { covered: number; total: number } | undefined;
    for (const t of fresh) {
      const files = t.coverage!.changed!.files!;
      const key = keyIn(args.top, files, file);
      const c = key === null ? undefined : files[key];
      if (c && (!best || c.covered / Math.max(1, c.total) > best.covered / Math.max(1, best.total))) best = c;
    }
    if (best) {
      if (best.covered < best.total && !acceptAsProcess(fresh, file)) gaps.push({ file, covered: best.covered, total: best.total });
      continue;
    }
    if (fresh.some((t) => listed(args.top, t.coverage!.changed!.in_report!, file))) continue;
    const added = fresh
      .map((t) => {
        const lines = t.coverage!.changed!.diff_lines!;
        const key = keyIn(args.top, lines, file);
        return key === null ? undefined : lines[key];
      })
      .filter((n): n is number => typeof n === 'number');
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
          ? `${g.file} (no passing record of its current content measured it)`
          : 'hidden' in g
            ? `${g.file} (edited, but not in the coverage diff)`
            : 'refusedBase' in g
              ? `${g.file} (measured only against ${g.refusedBase.slice(0, 12)}, where the file is not what it was when the session started${g.head === null ? ', with no commit' : ` at ${g.head.slice(0, 12)}`})`
              : `${g.file} (${g.covered} of ${g.total} lines ran)`,
    )
    .join('; ');
  const refused = out.gaps.find((g): g is Extract<CoverageGap, { refusedBase: string }> => 'refusedBase' in g);
  const base = refused
    ? `A coverage run against a commit other than the session's start counts for a file only where the file is the same ` +
      `there: measure again with \`bun "${cliPath}" diff-coverage <report> --base ${refused.head ?? EMPTY_BASE}\` and record it. `
    : '';
  const hidden = out.gaps.some((g) => 'hidden' in g)
    ? 'A file git does not show in the diff (ignored, assume-unchanged, a nested repo) has to be in it to be measured, or be the user\'s exemption. '
    : '';
  const absent = out.gaps.some((g) => 'absent' in g)
    ? 'A file is missing from a report when no test loaded it, or when the report names it by a path outside this ' +
      'repo (tests run in a container or another checkout): run the tests from this checkout. '
    : '';
  return (
    `Changed lines that no test ran: ${list}${out.gaps.length > 6 ? ` and ${out.gaps.length - 6} more` : ''}. ` +
    `Write tests that run them (write-regression-test) and record the coverage again. ${absent}${hidden}${base}A file whose code runs only in a ` +
    'child process needs an in-process test, or the user can exempt it: a `decide: human` entry in .goodboy/policy.md ' +
    'with `coverage-exempt: <glob>`, which the user adds and which counts from the next session. (changed-line coverage)'
  );
}
