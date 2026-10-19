// Existing tests (track I, I5; plan §15.8). A change runs with the tests that already covered
// it, and an existing test is never quietly weakened.
// - Affected tests: the test files tracked at the session's start HEAD whose start content
//   loads a changed code file (a relative JS/TS import, a Python import of its module, a Go
//   test in its package dir), at their path now: a renamed test is followed, a deleted one is
//   the weakened rule's. The layer-1 Stop needs each in a passing record made after the code
//   file's last edit, with a suite that ran it (a test command naming it or its dir, or one
//   naming no test path and no filter: the whole suite).
// - Weakened tests: a start test file whose checks went down since the start HEAD (fewer
//   assertions or cases, more skips or focused tests; deleted, or renamed to a weaker or a
//   non-test file). The changes come from git (`git diff -M <head>`), so a deletion or a rename
//   by any command counts. The review gate needs a finding on each from a review made after
//   the test last changed: weakening is a review finding, which the reviewer rates (high when
//   it hides a regression, low with the reason when the behavior changed on purpose). An
//   accepted review pins the weakened tests it let through by their content
//   (judged-weakened.json), so a later change does not ask again for the same state.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { filterOffArgs, HOOK_GIT_ARGS, HOOK_GIT_ENV } from './hook-git';
import type { ChangedFileEdit } from './review-validator';
import { MAX_STATE_BYTES, readRegular } from './safe-read';
import { TEST_FILE } from './test-catalog';
import { JS_SPECIFIER, recordStandsAlone } from './test-types';
import { stripLiteralsAndComments } from './test-validator';
import { isTrustedTimestamp } from './trusted-time';
import type { ReviewResult, TestResult } from './types';

export type ExistingTestsMode = 'on' | 'warn' | 'off';

/** `GOODBOY_EXISTING_TESTS`: on (default) blocks, warn tells the user, off skips both rules. */
export function existingTestsMode(env: Record<string, string | undefined> = process.env): ExistingTestsMode {
  const v = (env.GOODBOY_EXISTING_TESTS ?? 'on').trim().toLowerCase();
  return v === 'off' || v === 'warn' ? v : 'on';
}

const MAX_TEST_BYTES = 1_000_000;
/** At most this many start test files are listed (a Stop must stay fast): Go tests and
 *  plain-`mv` renames past it are not followed. */
const MAX_LISTED = 50_000;
/** Start contents read per Stop, in all; candidates past it count as loading the changed file
 *  (fails closed: a whole-suite run covers them). */
const MAX_READ_BYTES = 64_000_000;
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

function git(cwd: string, args: string[], timeout = 5_000, stdin?: Buffer): { code: number; out: string; raw: Buffer } {
  try {
    const r = Bun.spawnSync(['git', '--no-replace-objects', ...HOOK_GIT_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...HOOK_GIT_ENV },
      stdin: stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout,
    });
    return { code: r.exitCode ?? -1, out: r.stdout.toString(), raw: r.stdout };
  } catch {
    return { code: -1, out: '', raw: Buffer.alloc(0) };
  }
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const validHead = (head: unknown): head is string => typeof head === 'string' && OBJECT_ID.test(head);
const outside = (r: string) => r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);
const toRel = (top: string, abs: string): string | null => {
  const r = relative(top, resolvePath(abs));
  return r === '' || outside(r) ? null : r.split(sep).join('/');
};

/** Object contents by name (`<rev>:<path>` or an object id), two git calls in all. A blob over
 *  MAX_TEST_BYTES, or past MAX_READ_BYTES in all, is 'too-large'; a missing one is left out. */
function readBlobs(top: string, specs: readonly string[]): Map<string, string | 'too-large'> {
  const out = new Map<string, string | 'too-large'>();
  const list = [...new Set(specs)].filter((s) => s !== '' && !s.includes('\n'));
  if (list.length === 0) return out;
  const check = git(top, ['cat-file', '--batch-check'], 10_000, Buffer.from(`${list.join('\n')}\n`));
  if (check.code !== 0) return out;
  const sizes = check.out.split('\n');
  const small: string[] = [];
  let total = 0;
  list.forEach((s, i) => {
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(sizes[i] ?? '');
    if (!m) return;
    const size = Number(m[1]);
    if (size > MAX_TEST_BYTES || total + size > MAX_READ_BYTES) out.set(s, 'too-large');
    else {
      total += size;
      small.push(s);
    }
  });
  if (small.length === 0) return out;
  const r = git(top, ['cat-file', '--batch'], 20_000, Buffer.from(`${small.join('\n')}\n`));
  if (r.code !== 0) return out;
  let at = 0;
  for (const s of small) {
    const nl = r.raw.indexOf(10, at);
    if (nl < 0) break;
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(r.raw.subarray(at, nl).toString());
    if (!m) {
      at = nl + 1; // "<name> missing"
      continue;
    }
    const size = Number(m[1]);
    out.set(s, r.raw.subarray(nl + 1, nl + 1 + size).toString());
    at = nl + 1 + size + 1;
  }
  return out;
}

/** The test files (by name, lib/test-catalog.ts) tracked at `head`, repo-relative; [] without
 *  a start commit. */
export function startTestFiles(top: string, head: string | null | undefined): string[] {
  if (!validHead(head)) return [];
  const r = git(top, ['ls-tree', '-r', '-z', '--name-only', '--end-of-options', head]);
  if (r.code !== 0) return [];
  return r.out.split('\0').filter((p) => p !== '' && TEST_FILE.test(p)).slice(0, MAX_LISTED);
}

export interface StartTestChange {
  /** Its path now: itself when modified, the target when renamed to a test file name; null
   *  when deleted or renamed to a non-test name. */
  now: string | null;
  /** Its blob at the start. */
  blob: string;
}

/** The start test files that changed since `head`, by git's view of the working tree against it
 *  (index and work tree, with rename detection). The repo's filter drivers are emptied: a
 *  configured clean filter would run inside the hook (round-2 security review). A deleted test
 *  whose exact content sits in an untracked test file (a plain `mv`) counts as renamed there,
 *  each copy taken once. Unchanged tests are left out. */
export function changedStartTests(top: string, head: string | null | undefined): Map<string, StartTestChange> {
  const out = new Map<string, StartTestChange>();
  if (!validHead(head)) return out;
  const filters = filterOffArgs(git(top, ['config', '--name-only', '--get-regexp', '^filter\\.']).out);
  const r = git(
    top,
    [...filters, 'diff', '--raw', '--no-abbrev', '-M', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules', '--end-of-options', head, '--'],
    10_000,
  );
  if (r.code !== 0) return out;
  const parts = r.out.split('\0');
  const deleted: { rel: string; blob: string }[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i] ?? '';
    if (!meta.startsWith(':')) {
      i++;
      continue;
    }
    const f = meta.slice(1).split(' ');
    const blob = f[2] ?? '';
    const status = f[4] ?? '';
    const pair = /^[RC]/.test(status);
    const src = parts[i + 1] ?? '';
    const dst = pair ? (parts[i + 2] ?? '') : src;
    i += pair ? 3 : 2;
    // A copy leaves its source, and an added file was not there at the start.
    if (status.startsWith('C') || status === 'A' || !TEST_FILE.test(src)) continue;
    if (status === 'D') deleted.push({ rel: src, blob });
    else out.set(src, { now: status.startsWith('R') ? (TEST_FILE.test(dst) ? dst : null) : src, blob });
  }
  if (deleted.length > 0) {
    const byBlob = new Map<string, string[]>();
    const o = git(top, ['ls-files', '-o', '--exclude-standard', '-z'], 10_000);
    const untracked = o.code === 0 ? o.out.split('\0').filter((p) => p !== '' && TEST_FILE.test(p) && !p.includes('\n')).slice(0, MAX_LISTED) : [];
    if (untracked.length > 0) {
      const h = git(top, ['hash-object', '--no-filters', '--stdin-paths'], 10_000, Buffer.from(`${untracked.join('\n')}\n`));
      if (h.code === 0) {
        h.out.split('\n').forEach((id, k) => {
          if (k < untracked.length && OBJECT_ID.test(id)) byBlob.set(id, [...(byBlob.get(id) ?? []), untracked[k]!]);
        });
      }
    }
    for (const d of deleted) out.set(d.rel, { now: byBlob.get(d.blob)?.shift() ?? null, blob: d.blob });
  }
  return out;
}

/** The module names a changed file can be imported by: its dotted module (also without a
 *  leading `src/`) for Python. */
function pythonModules(rel: string): string[] {
  const noExt = rel.replace(/\.py$/, '').replace(/\/__init__$/, '');
  const mods = [noExt.split('/').join('.')];
  if (noExt.startsWith('src/')) mods.push(noExt.slice(4).split('/').join('.'));
  return mods;
}

/** `name` inside dir `dir` ('.' is the repo top). */
const under = (dir: string, name: string) => (dir === '.' || dir === '' ? name : `${dir}/${name}`);

/** What a JS/TS test file at `testRel` loads by relative specifiers, as repo-relative keys: each
 *  target with and without its extension and as a dir's `index`. A changed file is loaded when
 *  its path or its path without the extension is a key (`.js` naming a `.ts` source too). */
function jsLoads(text: string, testRel: string): Set<string> {
  const keys = new Set<string>();
  const base = posix.dirname(testRel);
  for (const m of text.matchAll(JS_SPECIFIER)) {
    const spec = m[2]!;
    if (!spec.startsWith('.')) continue;
    const target = posix.normalize(posix.join(base, spec)).replace(/\/$/, '');
    const targetNoExt = target.replace(/\.[cm]?[jt]sx?$/, '');
    for (const k of [target, targetNoExt, under(target, 'index'), under(targetNoExt, 'index')]) keys.add(k);
  }
  return keys;
}

/** The absolute modules a Python test imports, with their parents (`import a.b.c` loads `a`,
 *  `a.b` and `a.b.c`; `from a import b, c` also names `a.b` and `a.c`). Relative imports are
 *  not resolved. */
function pyLoads(text: string): Set<string> {
  const code = text.replace(/#[^\n]*/g, '');
  const mods = new Set<string>();
  const add = (dotted: string) => {
    if (!/^[\w.]+$/.test(dotted) || dotted.startsWith('.')) return;
    const parts = dotted.split('.');
    for (let i = 1; i <= parts.length; i++) mods.add(parts.slice(0, i).join('.'));
  };
  const names = (list: string) =>
    list
      .replace(/[()\\]/g, ' ')
      .split(',')
      .map((n) => n.trim().split(/[ \t\n]+/)[0] ?? '')
      .filter((n) => n !== '');
  // The parenthesized list is bounded, so unclosed parens cannot make the scan quadratic.
  for (const m of code.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]{0,4000}\)|[^\n]*)/gm)) {
    if (m[1]!.startsWith('.')) continue;
    add(m[1]!);
    for (const n of names(m[2]!)) if (n !== '*') add(`${m[1]}.${n}`);
  }
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n]*)/gm)) for (const n of names(m[1]!)) add(n);
  return mods;
}

/** Per changed code file (repo-relative), the start test files whose start content loads it, at
 *  their path now (deleted ones left out). Candidates come from one `git grep` of the start tree
 *  for the files' stems (fast at any size); each is read and parsed once. A Go file's tests are
 *  the `_test.go` files of its dir. */
export function affectedTests(top: string, head: string | null | undefined, changed: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!validHead(head)) return out;
  const tests = startTestFiles(top, head);
  if (tests.length === 0) return out;
  const moved = changedStartTests(top, head);
  const nowOf = (t: string): string | null => (moved.has(t) ? moved.get(t)!.now : t);
  const code = [...new Set(changed.map((f) => toRel(top, f)).filter((r): r is string => r !== null && !TEST_FILE.test(r)))];
  const stems = new Set<string>();
  for (const r of code) {
    const b = posix.basename(r).replace(/\.[^.]+$/, '');
    if (b !== 'index' && b !== '__init__') {
      if (b.length >= 2) stems.add(b);
      continue;
    }
    // An index file is named by its dir ('.', '..' or the dir's name).
    const dir = posix.dirname(r);
    if (dir !== '.') stems.add(posix.basename(dir));
    for (const s of [`'.'`, `"."`, `'./'`, `"./"`, `..'`, `.."`, `../'`, `../"`, `/index`]) stems.add(s);
  }
  let candidates: string[] = [];
  if (stems.size > 0) {
    const g = git(top, ['grep', '-z', '-l', '-I', '-F', ...[...stems].flatMap((s) => ['-e', s]), head, '--'], 10_000);
    const prefix = `${head}:`;
    candidates = g.code === 0 ? g.out.split('\0').filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).filter((p) => TEST_FILE.test(p)) : [];
  }
  // Each candidate read and parsed once: what it loads, or 'all' when too large to read.
  const texts = readBlobs(top, candidates.map((c) => `${head}:${c}`));
  const loads = new Map<string, Set<string> | 'all'>();
  for (const t of candidates) {
    const text = texts.get(`${head}:${t}`);
    if (text === undefined) continue;
    const tExt = extname(t).toLowerCase();
    if (text === 'too-large') loads.set(t, 'all');
    else if (tExt === '.py') loads.set(t, pyLoads(text));
    else if (JS_EXT.includes(tExt)) loads.set(t, jsLoads(text, t));
  }
  for (const r of code) {
    const ext = extname(r).toLowerCase();
    const hits: string[] = [];
    if (ext === '.go') {
      const dir = posix.dirname(r);
      hits.push(...tests.filter((t) => t.endsWith('_test.go') && posix.dirname(t) === dir));
    } else if (JS_EXT.includes(ext) || ext === '.py') {
      const keys = ext === '.py' ? pythonModules(r) : [r, r.replace(/\.[cm]?[jt]sx?$/, '')];
      for (const [t, l] of loads) {
        const tExt = extname(t).toLowerCase();
        if (ext === '.py' ? tExt !== '.py' : !JS_EXT.includes(tExt)) continue;
        // Too large to read: counts as loading it (fails closed).
        if (l === 'all' || keys.some((k) => l.has(k))) hits.push(t);
      }
    }
    const now = [...new Set(hits.map(nowOf).filter((t): t is string => t !== null))].sort();
    if (now.length > 0) out.set(r, now);
  }
  return out;
}

/** Test-name and partial-selection flags (bun/jest/vitest `-t`, jest `--testPathPattern` and
 *  projects, vitest `--project`, pytest `-k`/`--deselect`/`--lf`, mocha `--grep`/`--fgrep`, go
 *  `-run`/`-skip`, sharding, changed-only runs): a run with one is partial even when it names
 *  no file. */
const PARTIAL =
  /^(?:-t|--test-name-pattern|--testNamePattern|--testPathPattern|--testPathPatterns|--shard|-k|--deselect|--lf|--last-failed|--sw|--stepwise|--grep|-g|--fgrep|-run|-skip|--skip|--exact|--filter|--onlyChanged|--changed|--changedSince|--findRelatedTests|--related|--project|--projects|--selectProjects|--ignoreProjects)(?:=.*)?$/;
/** Flags whose value is a dir the run is limited to (vitest `--dir`/`--root`, jest
 *  `--rootDir`/`--roots`): the value is a test path. */
const DIR_FLAG = /^(?:--dir|--root|--rootDir|--roots)$/;
/** Flags whose next word is a value, not a test path: these, and any long flag named like a
 *  path, a file, an output or a setting (`--coverage.reportsDirectory`, `--outputFile`). */
const VALUE_FLAGS = new Set(['-c', '-C', '-r', '-n', '-p', '--cov', '--import', '--loader', '--require', '--preload', '--timeout', '--workers', '--maxWorkers']);
const VALUE_FLAG_NAME = /(?:dir|directory|path|file|output|out|config|report|reports|reporter|cache|cwd|env|tsconfig|basetemp|junitxml)$/i;
const JS_RUNNER = /^(?:bun|bunx|npm|pnpm|yarn|npx|jest|vitest|deno|ava|tap)$/;
/** The programs that start a command a test run may be under. */
const RUNNER = /^(?:bun|bunx|npm|pnpm|yarn|npx|node|deno|python[\d.]*|go|cargo|tox|nox|make|uv|poetry|hatch|pipenv|rspec|phpunit|dotnet|mvn|gradle|gradlew)$/;
/** Test runners by name. */
const TEST_TOOL = /^(?:jest|vitest|mocha|ava|tap|pytest|py\.test|unittest|nextest|tox|nox|playwright|cypress)$/;
/** A test subcommand or script after a runner (`bun test`, `npm t`, `npm run test:unit`, `node --test`). */
const TEST_SUB = /^(?:test|t|--test|test[:_-][\w:.-]*)$/;
/** A test script by its file name (`./scripts/run-tests.sh`). */
const TEST_SCRIPT = /(?:^|[-_.])tests?(?:[-_.][\w.-]*)?\.(?:sh|bash|py|js|mjs|cjs|ts)$/i;

/** Whether a suite ran `testRel` (repo-relative; `top` resolves absolute paths in the command).
 *  Only the command's test runs count (`bun test`, `npm test`, `pytest`, `go test`…, a
 *  test script); a command with none ran nothing known. A test run with a test-name filter or a
 *  partial selection is partial; otherwise it ran the test when a test path names the file or a
 *  dir above it (bun, jest and vitest take a path filter: any part of the path), or when it
 *  names no test path at all (the whole suite). For `go test`, the package patterns decide. */
export function suiteRan(command: string, testRel: string, top?: string): boolean {
  let runs = 0;
  let selectors = 0;
  for (const segment of command.split(/&&|\|\|?|;|\n/)) {
    const words = segment.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '')).filter((w) => w !== '');
    const runnerAt = words.findIndex((w) => RUNNER.test(posix.basename(w)));
    const testAt = words.findIndex(
      (w, i) => TEST_TOOL.test(posix.basename(w)) || TEST_SCRIPT.test(posix.basename(w)) || (runnerAt >= 0 && i > runnerAt && TEST_SUB.test(w)),
    );
    if (testAt < 0) continue;
    runs++;
    const runner = posix.basename(words[runnerAt >= 0 && runnerAt < testAt ? runnerAt : testAt]!);
    const from = Math.min(testAt, runnerAt >= 0 ? runnerAt : testAt) + 1;
    const pytestAt = words.findIndex((w) => /(?:^|\/)(?:py\.test|pytest)$/.test(w));
    for (let i = from; i < words.length; i++) {
      const w = words[i]!;
      if (PARTIAL.test(w)) return false;
      if (w === '-m' && pytestAt >= 0 && i > pytestAt) return false;
      if (w === '-o' && JS_RUNNER.test(runner)) return false; // jest --onlyChanged
    }
    // cargo test: a positional word is a name filter, and a target or package choice is partial.
    if (runner === 'cargo' && words[testAt] === 'test') {
      for (let i = testAt + 1; i < words.length && words[i] !== '--'; i++) {
        const w = words[i]!;
        if (/^(?:--test|--bin|--example|--bench|--lib|--doc|--tests|--bins|--examples|--benches|-p|--package)(?:=.*)?$/.test(w)) return false;
        if (/^(?:--features|-F|--target|--manifest-path|-j|--jobs|--profile|--target-dir|--color|--message-format|--config|-Z)$/.test(w)) i++;
        else if (!w.startsWith('-')) return false;
      }
      continue;
    }
    // go test: the package patterns (none: the package of the current dir, taken as the top).
    if (runner === 'go' && words[testAt] === 'test') {
      const pkgs: string[] = [];
      for (let i = testAt + 1; i < words.length; i++) {
        const w = words[i]!;
        if (w === '--' || w === '-args') break;
        if (w.startsWith('-')) {
          if (!w.includes('=') && /^-(?:p|C|o|exec|tags|timeout|count|parallel|coverprofile|covermode|coverpkg|cpu|bench|benchtime|ldflags|gcflags|mod|modfile|pkgdir|vet|outputdir|trimpath|asmflags|toolexec|overlay)$/.test(w)) i++;
          continue;
        }
        pkgs.push(w);
      }
      const dir = posix.dirname(testRel);
      const inPkg = (p: string): boolean => {
        const recursive = p === '...' || p.endsWith('/...');
        let base = recursive ? p.replace(/\/?\.\.\.$/, '') : p;
        if (top && isAbsolute(base)) base = toRel(top, base) ?? (resolvePath(base) === resolvePath(top) ? '.' : `\0${base}`);
        base = base.replace(/^\.\//, '').replace(/\/$/, '') || '.';
        if (base === '.') return recursive || dir === '.';
        if (recursive) return dir === base || dir.startsWith(`${base}/`) || dir.endsWith(`/${base}`) || dir.includes(`/${base}/`);
        return dir === base || base.endsWith(`/${dir}`);
      };
      if (pkgs.length === 0 ? dir === '.' : pkgs.some(inPkg)) return true;
      selectors++;
      continue;
    }
    for (let i = testAt + 1; i < words.length; i++) {
      let w = words[i]!;
      if (w.startsWith('-')) {
        const eq = w.indexOf('=');
        if (eq > 0 && DIR_FLAG.test(w.slice(0, eq))) w = w.slice(eq + 1);
        else if (eq > 0) continue;
        else if (DIR_FLAG.test(w) && i + 1 < words.length) w = words[++i]!;
        else {
          const name = w.replace(/^-+/, '').split('.').pop() ?? '';
          if (VALUE_FLAGS.has(w) || (w.startsWith('--') && VALUE_FLAG_NAME.test(name))) i++;
          continue;
        }
      } else if (/^(?:\d*|&)[<>]/.test(w)) {
        if (/^(?:\d*|&)[<>]+&?$/.test(w)) i++;
        continue;
      } else if (!/\//.test(w) && !TEST_FILE.test(w) && !/^(?:tests|spec|specs|__tests__|e2e)$/.test(w)) continue;
      // A pytest node id runs part of a file.
      if (w.includes('::')) {
        selectors++;
        continue;
      }
      let p = w;
      if (isAbsolute(p)) {
        // An absolute path outside the repo is a value (a report dir), not a test path.
        const rel = top ? toRel(top, p) : null;
        if (rel === null) {
          if (top && resolvePath(p) === resolvePath(top)) return true;
          continue;
        }
        p = rel;
      }
      selectors++;
      const filter = p.replace(/^(?:\.\/)+/, '');
      p = filter.replace(/\/+$/, '');
      if (p === '' || p === '.' || p === testRel || testRel.startsWith(`${p}/`)) return true;
      if (JS_RUNNER.test(runner) && testRel.includes(filter)) return true;
    }
  }
  return runs > 0 && selectors === 0;
}

export interface AffectedGap {
  rel: string;
  tests: string[];
}

/** Per changed code file, the affected start tests no record ran: a passing record with a
 *  trusted timestamp after the file's last edit that lists the test in `test_files` and has a
 *  passing suite that ran it; the record is one the other checks accepted, or one that stands
 *  alone. */
export function affectedGaps(args: {
  results: readonly TestResult[];
  accepted: ReadonlySet<TestResult>;
  edits: readonly ChangedFileEdit[];
  top: string;
  head: string | null | undefined;
  standsAlone?: (r: TestResult) => boolean;
}): AffectedGap[] {
  const affected = affectedTests(args.top, args.head, args.edits.map((e) => e.file));
  if (affected.size === 0) return [];
  const nowMs = Date.now();
  const alone = new Map<TestResult, boolean>();
  const usable = (r: TestResult): boolean => {
    if (args.accepted.has(r)) return true;
    if (!alone.has(r)) alone.set(r, (args.standsAlone ?? recordStandsAlone)(r));
    return alone.get(r)!;
  };
  const passing = args.results.filter((r) => r.verdict === 'pass' && isTrustedTimestamp(r.timestamp, nowMs));
  const gaps: AffectedGap[] = [];
  for (const edit of args.edits) {
    const rel = toRel(args.top, edit.file);
    const tests = rel === null ? undefined : affected.get(rel);
    if (!tests || gaps.some((g) => g.rel === rel)) continue;
    const last = typeof edit.lastEditTimestamp === 'string' ? edit.lastEditTimestamp : '';
    const fresh = passing.filter((r) => last === '' || r.timestamp > last);
    const missing = tests.filter(
      (t) =>
        !fresh.some(
          (r) =>
            (Array.isArray(r.test_files) ? r.test_files : []).some((f) => typeof f === 'string' && toRel(args.top, resolvePath(args.top, f)) === t) &&
            (Array.isArray(r.suites) ? r.suites : []).some(
              (s) => !!s && s.passed > 0 && s.failed === 0 && suiteRan(typeof s.command === 'string' ? s.command : '', t, args.top),
            ) &&
            usable(r),
        ),
    );
    if (missing.length > 0) gaps.push({ rel: rel!, tests: missing });
  }
  return gaps;
}

/** The block message (model-facing). */
export function affectedReason(gaps: readonly AffectedGap[], tester: string): string {
  const list = gaps
    .slice(0, 5)
    .map((g) => `${g.rel} is loaded by ${g.tests.slice(0, 5).join(', ')}${g.tests.length > 5 ? ` and ${g.tests.length - 5} more` : ''}`)
    .join('; ');
  return (
    `Existing tests that cover the change did not run with it: ${list}${gaps.length > 5 ? ` (${gaps.length - 5} more files)` : ''}. ` +
    `Have ${tester} run them (or the whole suite) after the last edit and list them in test_files. A test that now fails ` +
    'is updated to the new behavior, never weakened or skipped. (existing tests, I5)'
  );
}

export interface Strength {
  assertions: number;
  cases: number;
  skips: number;
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** A test file's checks: assertions, test cases and skips (focused tests too: they skip the
 *  rest), counted in code without comments (and, for JS/TS, without literals; for Python,
 *  without triple-quoted strings). Every pattern is linear. Null for a language it does not
 *  know. */
export function testStrength(text: string, ext: string): Strength | null {
  if (JS_EXT.includes(ext)) {
    const code = stripLiteralsAndComments(text);
    return {
      assertions: count(code, /\bexpect\s*\(|\bassert(?:\s*\.\s*\w+)?\s*\(|\.\s*should\b/g),
      cases: count(code, /\b(?:it|test)\s*(?:\.\s*(?:only|each|concurrent|failing))?\s*\(/g),
      skips: count(code, /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only)\b|\b(?:x|f)(?:it|test|describe)\s*\(/g),
    };
  }
  if (ext === '.py') {
    const code = text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""').replace(/#[^\n]*/g, '');
    return {
      assertions: count(code, /^[ \t]*assert\b|\bself[ \t]*\.[ \t]*assert\w*[ \t]*\(|\bpytest[ \t]*\.[ \t]*raises\b/gm),
      cases: count(code, /^[ \t]*(?:async[ \t]+)?def[ \t]+test_\w*[ \t]*\(/gm),
      skips: count(
        code,
        /@pytest[ \t]*\.[ \t]*mark[ \t]*\.[ \t]*(?:skip\w*|xfail)\b|@unittest[ \t]*\.[ \t]*(?:skip\w*|expectedFailure)\b|\bpytest[ \t]*\.[ \t]*(?:skip|xfail|importorskip)[ \t]*\(|\bself[ \t]*\.[ \t]*skipTest[ \t]*\(/g,
      ),
    };
  }
  if (ext === '.go') {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
    return {
      assertions: count(code, /\bt\s*\.\s*(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\b|\b(?:assert|require)\s*\.\s*\w+\s*\(/g),
      cases: count(code, /^func[ \t]+Test\w*[ \t]*\(/gm),
      skips: count(code, /\bt\s*\.\s*Skip\w*\s*\(/g),
    };
  }
  return null;
}

export interface Weakened {
  /** Its path at the start (repo-relative). */
  rel: string;
  /** Its path now; null when deleted (or renamed to a non-test name). */
  now: string | null;
  /** The absolute paths a finding may name: the start path, and the path now. */
  abs: string[];
  /** Null when too large to count. */
  before: Strength | null;
  after: Strength | null;
  /** Its state now, for the judged pin: the path now and a hash of the content (or "deleted",
   *  or the size and time of a file too large to read). */
  state: string;
  /** When it last changed (ms): the file's change time, or for a deletion or a move the time
   *  of the dir it left. A finding judges it only from a review made after this. */
  changedMs: number;
}

const ZERO: Strength = { assertions: 0, cases: 0, skips: 0 };
const isWithin = (p: string, dir: string) => p === dir || p.startsWith(`${dir}${sep}`);

/** A path's change time (ms), or that of its nearest existing parent dir; 0 when none. */
function changeTime(p: string, top: string): number {
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      const st = statSync(cur);
      return Math.max(st.mtimeMs, st.ctimeMs);
    } catch {
      if (cur === top || dirname(cur) === cur) return 0;
    }
  }
}

/** The start test files under `within` (default: the repo) that lost checks since `head`: fewer
 *  assertions or cases, or more skips; deleted, or renamed to a non-test name; or changed and
 *  too large to count (fails closed). A rename is compared with its source. */
export function weakenedTests(top: string, head: string | null | undefined, within?: string): Weakened[] {
  if (!validHead(head)) return [];
  const changes = changedStartTests(top, head);
  if (changes.size === 0) return [];
  const blobs = readBlobs(top, [...changes.values()].map((c) => c.blob));
  const dir = within === undefined ? null : resolvePath(within);
  const out: Weakened[] = [];
  for (const [rel, c] of changes) {
    const start = join(top, rel);
    const abs = [start, ...(c.now !== null && c.now !== rel ? [join(top, c.now)] : [])];
    if (dir !== null && !abs.some((p) => isWithin(p, dir))) continue;
    const old = blobs.get(c.blob);
    if (old === undefined) continue;
    const before = old === 'too-large' ? null : testStrength(old, extname(rel).toLowerCase());
    let after: Strength | null = ZERO;
    let state = 'deleted';
    // The dir it left counts for a deletion or a move: a moved file keeps its times.
    let changedMs = c.now === rel ? 0 : changeTime(dirname(start), top);
    if (c.now !== null) {
      const path = join(top, c.now);
      changedMs = Math.max(changedMs, changeTime(path, top));
      const read = readRegular(path, MAX_TEST_BYTES);
      if (read === 'absent') after = ZERO;
      else if (read === 'refused') {
        after = null;
        try {
          const st = statSync(path);
          state = `unmeasured:${st.size}:${st.mtimeMs}`;
        } catch {
          state = 'unmeasured';
        }
      } else {
        after = testStrength(read.text, extname(c.now).toLowerCase());
        state = createHash('sha256').update(read.text).digest('hex');
      }
    }
    const weaker =
      c.now === null ||
      before === null ||
      after === null ||
      after.assertions < before.assertions ||
      after.cases < before.cases ||
      after.skips > before.skips;
    if (weaker) out.push({ rel, now: c.now, abs, before, after, state: `${c.now ?? ''}|${state}`, changedMs });
  }
  return out;
}

/** The pin key of a weakened test: its start path and its state now. */
const pinKey = (w: Weakened) => `${w.abs[0]}|${w.state}`;
const JUDGED_FILE = 'judged-weakened.json';
const MAX_JUDGED = 1000;

/** The weakened tests a review of this session already let through, as pin keys. */
export function judgedWeakened(sessionId: string): Set<string> {
  try {
    const p = join(ensureSessionDir(sessionId), JUDGED_FILE);
    if (!existsSync(p) || statSync(p).size > MAX_STATE_BYTES) return new Set();
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** On an accepted review: the weakened tests now count as judged in their current state. */
export function pinJudgedWeakened(sessionId: string, list: readonly Weakened[]): void {
  if (list.length === 0) return;
  try {
    const keys = [...new Set([...judgedWeakened(sessionId), ...list.map(pinKey)])].slice(-MAX_JUDGED);
    writeFileSync(join(ensureSessionDir(sessionId), JUDGED_FILE), JSON.stringify(keys), 'utf8');
  } catch {
    // best-effort: the next review asks again
  }
}

/** The weakened tests not yet judged: not pinned in their current state, and named by no
 *  finding of a review made after the test last changed (a review with a trusted timestamp; a
 *  finding's path resolves against each of `bases`, e.g. the cwd and the repo top; a `:line`
 *  suffix is ignored). Any of the given reviews counts, also one that lists only the test. */
export function unjudgedWeakened(
  weakened: readonly Weakened[],
  reviews: readonly ReviewResult[],
  bases: readonly string[],
  judged: ReadonlySet<string> = new Set(),
): Weakened[] {
  const nowMs = Date.now();
  // Per named path, the newest review time that names it.
  const named = new Map<string, number>();
  for (const r of reviews) {
    if (!r || !isTrustedTimestamp(r.timestamp, nowMs)) continue;
    const at = Date.parse(r.timestamp);
    for (const f of Array.isArray(r.findings) ? r.findings : []) {
      if (typeof f?.file !== 'string' || f.file === '') continue;
      const file = f.file.replace(/:\d+(?::\d+)?$/, '');
      for (const b of bases) {
        const p = resolvePath(b, file);
        named.set(p, Math.max(named.get(p) ?? 0, at));
      }
    }
  }
  return weakened.filter((w) => !judged.has(pinKey(w)) && !w.abs.some((p) => (named.get(p) ?? 0) > w.changedMs));
}

const delta = (w: Weakened) => {
  if (w.now === null) return 'deleted';
  const moved = w.now !== w.rel ? `renamed to ${w.now}` : '';
  if (w.before === null || w.after === null) return [moved, 'too large to count'].filter(Boolean).join(', ');
  return [
    moved,
    w.after.assertions < w.before.assertions ? `assertions ${w.before.assertions} → ${w.after.assertions}` : '',
    w.after.cases < w.before.cases ? `cases ${w.before.cases} → ${w.after.cases}` : '',
    w.after.skips > w.before.skips ? `skips ${w.before.skips} → ${w.after.skips}` : '',
  ]
    .filter(Boolean)
    .join(', ');
};

/** The block message (model-facing). */
export function weakenedReason(list: readonly Weakened[], reviewer: string): string {
  return (
    `These existing tests lost checks since the session started: ${list.slice(0, 5).map((w) => `${w.rel} (${delta(w)})`).join('; ')}` +
    `${list.length > 5 ? ` (${list.length - 5} more)` : ''}. Weakening a test is a review finding (I5): have ${reviewer} judge ` +
    'each and record a finding on that file, in a review made after the test last changed: high when it hides a ' +
    'regression, low with the reason when the behavior changed on purpose or the user asked. Restoring the checks ' +
    'also clears it.'
  );
}

/** The user's line (Korean) for warn mode and for the findings shown after a pass. */
export function weakenedWarning(list: readonly Weakened[]): string {
  return `[goodboy] 기존 테스트의 검사가 줄었어요: ${list.slice(0, 3).map((w) => `${w.rel}(${delta(w)})`).join(', ')}${list.length > 3 ? ` 외 ${list.length - 3}건` : ''}.`;
}
