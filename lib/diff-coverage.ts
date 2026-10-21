// Changed-line coverage (track G §10.8, `measure-coverage`): which changed lines a test run
// executed. The coverage report comes from the project's own tool (lcov, Cobertura XML,
// JaCoCo XML, a Go profile); the changed lines come from git (the working tree against a base,
// untracked files whole). Since track I (I1) the test gate reads it: every changed code line
// must have run (lib/changed-coverage.ts); test-write still warns about idle files.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { HOOK_GIT_ARGS, HOOK_GIT_ENV, NO_GRAFTS } from './hook-git';

/** Per file (repo-relative): line → executed (true) or not (false), for executable lines. */
export type LineHits = Map<string, Map<number, boolean>>;

export type ReportFormat = 'lcov' | 'cobertura' | 'jacoco' | 'go';

function git(cwd: string, args: string[]): string | null {
  try {
    // No replace refs: `git replace` would show the diff of another commit (I1 security review).
    const p = Bun.spawnSync(['git', '--no-replace-objects', ...HOOK_GIT_ARGS, ...args], { cwd, env: { ...process.env, ...HOOK_GIT_ENV, ...NO_GRAFTS }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** A path from a diff header: C-quoted when git quotes it (`"b/caf\303\251.ts"`), with the
 *  trailing tab git adds to a name with a space. */
function headerPath(raw: string): string {
  let p = raw.replace(/\t$/, '');
  if (p.startsWith('"') && p.endsWith('"')) {
    const bytes: number[] = [];
    const s = p.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== '\\') {
        bytes.push(...Buffer.from(s[i]!, 'utf8'));
        continue;
      }
      const oct = s.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
      } else {
        const c = s[++i] ?? '';
        bytes.push(...Buffer.from(({ n: '\n', t: '\t', '"': '"', '\\': '\\' } as Record<string, string>)[c] ?? c, 'utf8'));
      }
    }
    p = Buffer.from(bytes).toString('utf8');
  }
  return p;
}

/** Changed lines of the working tree against `base` (default HEAD), per repo-relative file:
 *  the new side of each hunk, and every line of an untracked file. Null outside a repo; an
 *  error when the diff fails (a base that does not exist). */
export function changedLines(cwd: string, base = 'HEAD'): { top: string; files: Map<string, Set<number>> } | { error: string } | null {
  const cdup = git(cwd, ['rev-parse', '--show-cdup']);
  if (cdup === null) return null;
  const top = resolvePath(cwd, cdup.trim() || '.');
  const files = new Map<string, Set<number>>();
  // Fixed prefixes, no quoting and rename detection without copies, whatever the user's config
  //   says (diff.mnemonicPrefix, diff.noprefix, core.quotePath; diff.renames=copies would show a
  //   staged near-copy as a few changed lines, I1 security review round 6).
  //   No textconv: a diff driver's conversion would number the converted text, not the source
  //   lines the coverage report uses (Codex review).
  const diff = git(top, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--end-of-options', base, '--']);
  if (diff === null) return { error: `git diff against ${base} failed (is it a commit?)` };
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    // A pure rename or copy has no hunk: the file is in the diff with no added line.
    const moved = line.match(/^(?:rename|copy) to (.+)$/);
    if (moved) {
      const p = headerPath(moved[1]!);
      if (!files.has(p)) files.set(p, new Set());
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = headerPath(line.slice(4));
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file !== null) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      const set = files.get(file) ?? new Set<number>();
      for (let n = start; n < start + count; n++) set.add(n);
      files.set(file, set);
    }
  }
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '';
  for (const f of untracked.split('\0').filter(Boolean)) {
    try {
      const text = readFileSync(join(top, f), 'utf8');
      const n = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      files.set(f, new Set(Array.from({ length: n }, (_, i) => i + 1)));
    } catch {
      // unreadable: no lines
    }
  }
  return { top, files };
}

/** The report's format from its text. */
export function reportFormat(text: string): ReportFormat | null {
  if (/^mode: (?:set|count|atomic)\s*$/m.test(text.slice(0, 200))) return 'go';
  if (/^(?:TN|SF):/m.test(text)) return 'lcov';
  if (/<report\b[^>]*>/.test(text) && /<sourcefile\b/.test(text)) return 'jacoco';
  if (/<coverage\b/.test(text) && /<class\b/.test(text)) return 'cobertura';
  return null;
}

const attr = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** Executed lines per file, as the report names the files. */
export function parseReport(text: string, format: ReportFormat): LineHits {
  const out: LineHits = new Map();
  const mark = (file: string, line: number, hit: boolean) => {
    const m = out.get(file) ?? new Map<number, boolean>();
    m.set(line, (m.get(line) ?? false) || hit);
    out.set(file, m);
  };
  if (format === 'lcov') {
    let file: string | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('SF:')) file = line.slice(3).trim();
      else if (line.startsWith('DA:') && file !== null) {
        const [n, hits] = line.slice(3).split(',');
        mark(file, Number(n), Number(hits) > 0);
      } else if (line.startsWith('end_of_record')) file = null;
    }
  } else if (format === 'cobertura') {
    for (const cls of text.matchAll(/<class\b([^>]*)>([^]*?)<\/class>/g)) {
      const file = attr(cls[1]!, 'filename');
      if (!file) continue;
      for (const l of cls[2]!.matchAll(/<line\b([^>]*)\/?>/g)) mark(file, Number(attr(l[1]!, 'number')), Number(attr(l[1]!, 'hits')) > 0);
    }
  } else if (format === 'jacoco') {
    for (const pkg of text.matchAll(/<package\b([^>]*)>([^]*?)<\/package>/g)) {
      const dir = attr(pkg[1]!, 'name') ?? '';
      for (const src of pkg[2]!.matchAll(/<sourcefile\b([^>]*)>([^]*?)<\/sourcefile>/g)) {
        const name = attr(src[1]!, 'name');
        if (!name) continue;
        const file = dir ? `${dir}/${name}` : name;
        // `ci`: covered instructions on the line.
        for (const l of src[2]!.matchAll(/<line\b([^>]*)\/?>/g)) mark(file, Number(attr(l[1]!, 'nr')), Number(attr(l[1]!, 'ci')) > 0);
      }
    }
  } else {
    for (const line of text.split('\n').slice(1)) {
      const m = line.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/);
      if (!m) continue;
      for (let n = Number(m[2]); n <= Number(m[3]); n++) mark(m[1]!, n, Number(m[4]) > 0);
    }
  }
  return out;
}

/** Repo files for matching report paths: by base name, and Go modules (`module` path → the
 *  dir of its go.mod, longest first). */
interface RepoIndex {
  files: ReadonlySet<string>;
  byName: Map<string, string[]>;
  modules: readonly (readonly [string, string])[];
}

function repoIndex(files: Iterable<string>, modules: readonly (readonly [string, string])[]): RepoIndex {
  const set = new Set(files);
  const byName = new Map<string, string[]>();
  for (const f of set) {
    const name = f.slice(f.lastIndexOf('/') + 1);
    const list = byName.get(name);
    if (list) list.push(f);
    else byName.set(name, [f]);
  }
  return { files: set, byName, modules: [...modules].sort((a, b) => b[0].length - a[0].length) };
}

/** The changed file a report path names (I1 security review: a report path must name the file
 *  it measured, or the gate credits one file's run to another).
 *  - An absolute path: that file, if it is inside the repo.
 *  - A Go module path (`example.com/app/cmd/main.go`): the module prefix becomes its go.mod dir.
 *  - A repo-relative path of a repo file: that file. A path that exists on disk but is no file
 *    the repo lists (`node_modules/dep/index.ts`): that file, so none of ours.
 *  - Else, by base name, the one repo file that ends with the report path (a Cobertura
 *    `pkg/app.py` is `src/pkg/app.py`, not a root `app.py`); several are ambiguous. Never a
 *    repo file shorter than the report path: a
 *    dependency's `github.com/pkg/errors/errors.go` or a `../shared/index.ts` is not the root
 *    `errors.go` or `index.ts` (I1 security review round 6).
 *  Null when that file did not change, or the match is ambiguous. */
function matchFile(reportPath: string, top: string, changed: Map<string, Set<number>>, index: RepoIndex): string | null {
  const pick = (f: string | undefined) => (f !== undefined && changed.has(f) ? f : null);
  if (isAbsolute(reportPath)) {
    const r = relative(top, reportPath);
    return r === '' || r === '..' || r.startsWith('../') || isAbsolute(r) ? null : pick(r.split('\\').join('/'));
  }
  const rel = reportPath.replace(/^\.\//, '');
  const listed = (f: string) => index.files.has(f) || changed.has(f);
  for (const [mod, dir] of index.modules) {
    if (!rel.startsWith(`${mod}/`)) continue;
    const mapped = (dir ? `${dir}/` : '') + rel.slice(mod.length + 1);
    if (listed(mapped)) return pick(mapped);
  }
  if (listed(rel)) return pick(rel);
  if (existsSync(join(top, rel))) return null;
  const parts = rel.split('/');
  const name = parts[parts.length - 1]!;
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const f of new Set([...(index.byName.get(name) ?? []), ...[...changed.keys()].filter((c) => c.endsWith(`/${name}`) || c === name)])) {
    const fp = f.split('/');
    let c = 0;
    while (c < fp.length && c < parts.length && fp[fp.length - 1 - c] === parts[parts.length - 1 - c]) c++;
    if (c !== parts.length) continue; // the repo file does not end with the report path
    if (c > bestScore) {
      best = f;
      bestScore = c;
      tie = false;
    } else if (c === bestScore) {
      tie = true;
    }
  }
  return best !== null && !tie ? pick(best) : null;
}

export interface DiffCoverage {
  covered: number;
  total: number;
  files_without_executed_changes: string[];
  files: Record<string, { covered: number; total: number }>;
  /** Every changed file the report has, executable changed lines or not (I1: a changed code
   *  file missing here ran in no test at all, e.g. only in a child process, M24). */
  in_report: string[];
  /** Every file the diff has, with its added lines (0: only removals, or an empty new file).
   *  I1: an edited file outside it must equal the base. */
  diff_lines: Record<string, number>;
  /** The commit, or the empty tree, the diff ran against (set by diffCoverageOf; the I1 gate
   *  checks it is not after the session's start). */
  base?: string;
}

/** Changed executable lines the report saw executed. Lines the report does not list
 *  (comments, blank lines) are not executable and do not count; a file the report lacks is
 *  left out of `files` and `in_report` (the I1 gate counts it as not covered). `known`: every
 *  repo file, for matching report paths (default: the changed ones); `modules`: Go module
 *  paths and their go.mod dirs. */
export function diffCoverage(
  hits: LineHits,
  top: string,
  changed: Map<string, Set<number>>,
  known: Iterable<string> = changed.keys(),
  modules: readonly (readonly [string, string])[] = [],
): DiffCoverage {
  const index = repoIndex(known, modules);
  const perFile = new Map<string, { covered: number; total: number }>();
  const inReport = new Set<string>();
  for (const [reportPath, lines] of hits) {
    const file = matchFile(reportPath, top, changed, index);
    if (file === null) continue;
    inReport.add(file);
    const want = changed.get(file)!;
    const t = perFile.get(file) ?? { covered: 0, total: 0 };
    for (const [n, hit] of lines) {
      if (!want.has(n)) continue;
      t.total++;
      if (hit) t.covered++;
    }
    perFile.set(file, t);
  }
  const files: DiffCoverage['files'] = {};
  let covered = 0;
  let total = 0;
  const none: string[] = [];
  for (const [f, t] of [...perFile].sort()) {
    if (t.total === 0) continue;
    files[f] = t;
    covered += t.covered;
    total += t.total;
    if (t.covered === 0) none.push(join(top, f));
  }
  const diffLines = Object.fromEntries([...changed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, lines]) => [f, lines.size]));
  return { covered, total, files_without_executed_changes: none, files, in_report: [...inReport].sort(), diff_lines: diffLines };
}

/** `cli.ts diff-coverage <report> [--base <rev>|empty]`: the report against the changed lines
 *  (`empty`: the empty tree, for a repo that had no commit when the session started). */
export function diffCoverageOf(cwd: string, reportPath: string, base?: string): DiffCoverage | { error: string } {
  const p = resolvePath(cwd, reportPath);
  if (!existsSync(p)) return { error: `no coverage report at ${p}` };
  const text = readFileSync(p, 'utf8');
  const format = reportFormat(text);
  if (format === null) return { error: 'the report is not lcov, Cobertura XML, JaCoCo XML or a Go coverage profile' };
  if (git(cwd, ['rev-parse', '--git-dir']) === null) return { error: 'not inside a git repository' };
  // The base as an object id, so the gate can check it against the session's start.
  const rev = base ?? 'HEAD';
  const id = (rev === 'empty' ? git(cwd, ['hash-object', '-t', 'tree', '/dev/null']) : git(cwd, ['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{commit}`]))?.trim();
  if (!id) return { error: `git diff against ${rev} failed (is it a commit?)` };
  const changed = changedLines(cwd, id);
  if (changed === null) return { error: 'not inside a git repository' };
  if ('error' in changed) return changed;
  const known = new Set([...(git(changed.top, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']) ?? '').split('\0').filter(Boolean), ...changed.files.keys()]);
  return { ...diffCoverage(parseReport(text, format), changed.top, changed.files, known, format === 'go' ? goModules(changed.top, known) : []), base: id };
}

/** The `module` path of each go.mod in the repo, with its dir ('' for the top). */
function goModules(top: string, known: ReadonlySet<string>): [string, string][] {
  const out: [string, string][] = [];
  for (const f of known) {
    if (f !== 'go.mod' && !f.endsWith('/go.mod')) continue;
    try {
      const m = readFileSync(join(top, f), 'utf8').match(/^\s*module\s+"?([^\s"]+)"?/m);
      if (m) out.push([m[1]!, f === 'go.mod' ? '' : f.slice(0, -'/go.mod'.length)]);
    } catch {
      // unreadable
    }
  }
  return out;
}
