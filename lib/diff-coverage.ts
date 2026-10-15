// Changed-line coverage (track G §10.8, `measure-coverage`): which changed lines a test run
// executed. The coverage report comes from the project's own tool (lcov, Cobertura XML,
// JaCoCo XML, a Go profile); the changed lines come from git (the working tree against a base,
// untracked files whole). Measured and recorded, never a gate: a code file with changed
// executable lines and none of them executed is reported, so test-write can warn about it.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { HOOK_GIT_ARGS, HOOK_GIT_ENV } from './hook-git';

/** Per file (repo-relative): line → executed (true) or not (false), for executable lines. */
export type LineHits = Map<string, Map<number, boolean>>;

export type ReportFormat = 'lcov' | 'cobertura' | 'jacoco' | 'go';

function git(cwd: string, args: string[]): string | null {
  try {
    const p = Bun.spawnSync(['git', ...HOOK_GIT_ARGS, ...args], { cwd, env: { ...process.env, ...HOOK_GIT_ENV }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
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
  // Fixed prefixes and no quoting, whatever the user's config says (diff.mnemonicPrefix,
  //   diff.noprefix, core.quotePath).
  const diff = git(top, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--end-of-options', base, '--']);
  if (diff === null) return { error: `git diff against ${base} failed (is it a commit?)` };
  let file: string | null = null;
  for (const line of diff.split('\n')) {
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

/** The changed file a report path names: the same repo-relative path, or the one whose path
 *  ends with it (JaCoCo and Go name files from a source root or a module path). */
function matchFile(reportPath: string, top: string, changed: Map<string, Set<number>>): string | null {
  const rel = isAbsolute(reportPath) ? relative(top, reportPath) : reportPath.replace(/^\.\//, '');
  if (changed.has(rel)) return rel;
  const hits = [...changed.keys()].filter((f) => f.endsWith(`/${rel}`) || rel.endsWith(`/${f}`));
  return hits.length === 1 ? hits[0]! : null;
}

export interface DiffCoverage {
  covered: number;
  total: number;
  files_without_executed_changes: string[];
  files: Record<string, { covered: number; total: number }>;
}

/** Changed executable lines the report saw executed. Lines the report does not list
 *  (comments, blank lines, files it did not instrument) are not executable and do not count. */
export function diffCoverage(hits: LineHits, top: string, changed: Map<string, Set<number>>): DiffCoverage {
  const perFile = new Map<string, { covered: number; total: number }>();
  for (const [reportPath, lines] of hits) {
    const file = matchFile(reportPath, top, changed);
    if (file === null) continue;
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
  return { covered, total, files_without_executed_changes: none, files };
}

/** `cli.ts diff-coverage <report> [--base <rev>]`: the report against the changed lines. */
export function diffCoverageOf(cwd: string, reportPath: string, base?: string): DiffCoverage | { error: string } {
  const p = resolvePath(cwd, reportPath);
  if (!existsSync(p)) return { error: `no coverage report at ${p}` };
  const text = readFileSync(p, 'utf8');
  const format = reportFormat(text);
  if (format === null) return { error: 'the report is not lcov, Cobertura XML, JaCoCo XML or a Go coverage profile' };
  const changed = changedLines(cwd, base);
  if (changed === null) return { error: 'not inside a git repository' };
  if ('error' in changed) return changed;
  return diffCoverage(parseReport(text, format), changed.top, changed.files);
}
