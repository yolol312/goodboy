// The coverage gate of the sandbox (track M, M2; plan §19): every non-UI code file of the
// project reaches 100% lines and branches in the merged coverage of the unit, integration and
// e2e runs, minus the user's approved `coverage-exempt:` entries. Read-only: the reports are
// read (JaCoCo XML, lcov, Cobertura XML), git lists the files, nothing runs and nothing is
// written. Fail closed: a malformed or oversized report is an error, never a pass.
//
// Merging several reports never overstates: a line is covered when any report covers it;
// lcov branches are united by (line, block, branch); JaCoCo and Cobertura only give a count per
// line, so per line the report with the most branches wins and, among those with that total,
// the most covered (a report with fewer branches cannot prove the others ran).
//
// An exemption is `glob` (the whole file) or `glob#L10-L20` (those lines and their branches),
// the same `coverage-exempt:` entries the changed-line rule reads (lib/changed-coverage.ts; it
// takes a ranged entry as a glob that matches no file, so a range never exempts more there).
// One that exempts nothing is stale and reported.

import { lstatSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve as resolvePath, sep } from 'node:path';
import { measurableCode, policyGlobs } from './changed-coverage';
import { readRegular } from './safe-read';
import { inSkippedDir, isTestCode, listFiles, MAX_FILES, notOwnCode } from './test-survey';
import { typeNeedOf } from './test-types';

export interface CoverageGapFile {
  /** Repo-relative, `/` separators. */
  rel: string;
  lines_missed: number[];
  branches_missed: { line: number; missed: number; total: number }[];
  /** No report has the file: it counts as 0%. */
  missing_from_report: boolean;
}

export interface CoverageCheck {
  ok: boolean;
  /** Required files, after the whole-file exemptions. */
  required: number;
  /** Required files at 100% lines and branches (after line exemptions). */
  full: number;
  gaps: CoverageGapFile[];
  exempt_used: { entry: string; files: string[] }[];
  /** Entries that exempted nothing (no such file, or a range with no missed line or branch). */
  stale_exemptions: string[];
  /** Over the required files that a report has, after the exemptions; a file no report has adds
   *  nothing (its size is unknown) and shows as a gap. */
  totals: { lines: { covered: number; total: number }; branches: { covered: number; total: number } };
  problems: string[];
  /** The reports that could not be read or parsed (also in `problems`). */
  report_errors: string[];
}

const MAX_REPORTS = 64;
const MAX_REPORT_BYTES = 128 * 1024 * 1024;
const MAX_REPORTS_TOTAL = 256 * 1024 * 1024;
const MAX_XML_DEPTH = 256;
const MAX_LINE_NO = 100_000_000;
const WEB_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
/** Time for reading candidate files to see whether they hold code, across all of them. */
const READ_BUDGET_MS = 30_000;

// ---------------------------------------------------------------------------------------------
// Coverage of one file

interface Branch {
  covered: number;
  total: number;
}

class FileCov {
  readonly lines = new Map<number, boolean>();
  /** JaCoCo and Cobertura: a count per line, merged by the max rule. */
  private readonly counts = new Map<number, Branch>();
  /** lcov: taken or not per (block, branch), united. */
  private readonly keyed = new Map<number, Map<string, boolean>>();

  addLine(line: number, covered: boolean): void {
    this.lines.set(line, (this.lines.get(line) ?? false) || covered);
  }

  addCount(line: number, b: Branch): void {
    if (b.total <= 0) return;
    const had = this.counts.get(line);
    this.counts.set(line, had ? mergeCounts(had, b) : b);
  }

  addKey(line: number, key: string, taken: boolean): void {
    let m = this.keyed.get(line);
    if (!m) this.keyed.set(line, (m = new Map()));
    m.set(key, (m.get(key) ?? false) || taken);
  }

  /** What this file's lines and branches say once merged. */
  branches(): Map<number, Branch> {
    const out = new Map(this.counts);
    for (const [line, m] of this.keyed) {
      let covered = 0;
      for (const taken of m.values()) if (taken) covered++;
      const b = { covered, total: m.size };
      const had = out.get(line);
      out.set(line, had ? mergeCounts(had, b) : b);
    }
    return out;
  }

  /** Another report's data for the same file. */
  absorb(o: FileCov): void {
    for (const [line, c] of o.lines) this.addLine(line, c);
    for (const [line, b] of o.counts) this.addCount(line, b);
    for (const [line, m] of o.keyed) for (const [k, t] of m) this.addKey(line, k, t);
  }
}

/** Two reports' branch counts for one line, merged without overstating: the one with more
 *  branches wins (a report with fewer cannot show that the others ran); with the same total, the
 *  one with more covered (the same code, run in more places). */
function mergeCounts(a: Branch, b: Branch): Branch {
  if (a.total !== b.total) return a.total > b.total ? a : b;
  return a.covered >= b.covered ? a : b;
}

/** A path a report names and the data under it; `suffix`: a JaCoCo package path and file
 *  name, matched against the end of the project's files. */
interface Entry {
  candidates: string[];
  suffix: boolean;
  cov: FileCov;
}

// ---------------------------------------------------------------------------------------------
// XML: a tokenizer, no entities expanded beyond the five predefined and numeric references, no
// DTD, linear in the text.

type XmlEvent =
  | { t: 'open'; name: string; attrs: Map<string, string> }
  | { t: 'close'; name: string }
  | { t: 'text'; text: string };

const spaceAt = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c === 32 || c === 9 || c === 10 || c === 13;
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#([0-9]{1,7})|#x([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (all, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name]!;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : all;
  });
}

/** Calls `on` for each element start, element end (also for `<a/>`) and run of text. Throws on
 *  anything that is not well formed: a bad tag, an unclosed or mismatched element, text outside
 *  the root, a second root, an internal DTD subset (where entities would be declared). */
function parseXml(text: string, on: (ev: XmlEvent) => void): void {
  const n = text.length;
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`malformed XML: ${why}`);
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    const raw = text.slice(i, lt < 0 ? n : lt);
    if (raw.trim() !== '') {
      if (stack.length === 0) fail('text outside the root element');
      on({ t: 'text', text: decodeEntities(raw.trim()) });
    }
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) fail('unterminated comment');
      i = e + 3;
    } else if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) fail('unterminated processing instruction');
      i = e + 2;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) fail('unterminated CDATA section');
      if (stack.length === 0) fail('CDATA outside the root element');
      const t = text.slice(lt + 9, e).trim();
      if (t !== '') on({ t: 'text', text: t });
      i = e + 3;
    } else if (text.startsWith('<!', lt)) {
      // Only a DOCTYPE without an internal subset (`<!DOCTYPE report PUBLIC "…" "report.dtd">`,
      //   which is never fetched): `[` would open entity declarations.
      if (!/^<!DOCTYPE\s/i.test(text.slice(lt, lt + 10)) || stack.length > 0 || roots > 0) fail('unexpected declaration');
      let j = lt + 2;
      let quote = '';
      for (; j < n; j++) {
        const c = text[j]!;
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '[') fail('an internal DTD subset is not accepted');
        else if (c === '>') break;
      }
      if (j >= n) fail('unterminated declaration');
      i = j + 1;
    } else if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt + 2);
      if (e < 0) fail('unterminated end tag');
      const name = text.slice(lt + 2, e).trim();
      if (stack.pop() !== name) fail(`unexpected </${name.slice(0, 40)}>`);
      on({ t: 'close', name });
      i = e + 1;
    } else {
      let j = lt + 1;
      while (j < n && !spaceAt(text, j) && text[j] !== '/' && text[j] !== '>') j++;
      const name = text.slice(lt + 1, j);
      if (name === '' || /["'=<]/.test(name)) fail('bad tag name');
      const attrs = new Map<string, string>();
      let self = false;
      for (;;) {
        while (j < n && spaceAt(text, j)) j++;
        if (j >= n) fail(`unterminated <${name}>`);
        if (text[j] === '>') {
          j++;
          break;
        }
        if (text[j] === '/') {
          if (text[j + 1] !== '>') fail(`bad end of <${name}>`);
          self = true;
          j += 2;
          break;
        }
        const a = j;
        while (j < n && !spaceAt(text, j) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/') j++;
        const key = text.slice(a, j);
        if (key === '' || /["'<]/.test(key)) fail(`bad attribute in <${name}>`);
        while (j < n && spaceAt(text, j)) j++;
        if (text[j] !== '=') fail(`attribute ${key} has no value`);
        j++;
        while (j < n && spaceAt(text, j)) j++;
        const q = text[j];
        if (q !== '"' && q !== "'") fail(`attribute ${key} is not quoted`);
        const e = text.indexOf(q!, j + 1);
        if (e < 0) fail(`unterminated attribute ${key}`);
        const value = text.slice(j + 1, e);
        if (value.includes('<')) fail(`attribute ${key} holds <`);
        if (attrs.has(key)) fail(`attribute ${key} twice in <${name}>`);
        attrs.set(key, decodeEntities(value));
        j = e + 1;
        if (j < n && !spaceAt(text, j) && text[j] !== '>' && text[j] !== '/') fail(`no space after attribute ${key}`);
      }
      if (stack.length === 0 && ++roots > 1) fail('more than one root element');
      on({ t: 'open', name, attrs });
      if (self) on({ t: 'close', name });
      else if (stack.push(name) > MAX_XML_DEPTH) fail('nested too deep');
      i = j;
    }
  }
  if (stack.length > 0) fail(`<${stack[stack.length - 1]}> is not closed`);
  if (roots === 0) fail('no root element');
}

// ---------------------------------------------------------------------------------------------
// The three formats

function integer(v: string | undefined, what: string): number {
  if (v === undefined || !/^[0-9]{1,12}$/.test(v)) throw new Error(`${what} is not a number: ${String(v).slice(0, 40)}`);
  return Number(v);
}

function lineNo(v: string | undefined, what: string): number {
  const n = integer(v, what);
  if (n > MAX_LINE_NO) throw new Error(`${what} is out of range: ${n}`);
  return n;
}

function parseJacoco(text: string): Entry[] {
  const out: Entry[] = [];
  let pkg: string | null = null;
  let cur: Entry | null = null;
  let sawRoot = false;
  parseXml(text, (ev) => {
    if (ev.t === 'text') return;
    if (ev.t === 'close') {
      if (ev.name === 'package') pkg = null;
      else if (ev.name === 'sourcefile' && cur) {
        out.push(cur);
        cur = null;
      }
      return;
    }
    if (!sawRoot) {
      sawRoot = true;
      if (ev.name !== 'report') throw new Error(`root element is <${ev.name}>, not <report>`);
    } else if (ev.name === 'package') {
      const name = ev.attrs.get('name');
      if (name === undefined) throw new Error('a <package> has no name');
      pkg = name;
    } else if (ev.name === 'sourcefile') {
      const name = ev.attrs.get('name');
      if (pkg === null || name === undefined) throw new Error('a <sourcefile> outside a <package>, or without a name');
      cur = { candidates: [pkg === '' ? name : `${pkg}/${name}`], suffix: true, cov: new FileCov() };
    } else if (ev.name === 'line' && cur) {
      const nr = lineNo(ev.attrs.get('nr'), 'line nr');
      const mi = integer(ev.attrs.get('mi'), 'line mi');
      const ci = integer(ev.attrs.get('ci'), 'line ci');
      const mb = integer(ev.attrs.get('mb'), 'line mb');
      const cb = integer(ev.attrs.get('cb'), 'line cb');
      // JaCoCo counts a line as run when one of its instructions ran.
      if (mi + ci > 0) cur.cov.addLine(nr, ci > 0);
      cur.cov.addCount(nr, { covered: cb, total: mb + cb });
    }
  });
  return out;
}

function parseCobertura(text: string): Entry[] {
  const sources: string[] = [];
  const classes: { filename: string; cov: FileCov }[] = [];
  const path: string[] = [];
  let cur: { filename: string; cov: FileCov } | null = null;
  parseXml(text, (ev) => {
    if (ev.t === 'text') {
      if (path[path.length - 1] === 'source' && !sources.includes(ev.text)) sources.push(ev.text);
      return;
    }
    if (ev.t === 'close') {
      path.pop();
      if (ev.name === 'class' && cur) {
        classes.push(cur);
        cur = null;
      }
      return;
    }
    if (path.length === 0 && ev.name !== 'coverage') throw new Error(`root element is <${ev.name}>, not <coverage>`);
    if (ev.name === 'class') {
      const filename = ev.attrs.get('filename');
      if (filename === undefined) throw new Error('a <class> has no filename');
      cur = { filename, cov: new FileCov() };
    } else if (ev.name === 'line' && cur && path[path.length - 1] === 'lines' && path[path.length - 2] === 'class') {
      const nr = lineNo(ev.attrs.get('number'), 'line number');
      const hits = ev.attrs.get('hits');
      if (hits === undefined || !/^[0-9]{1,15}(?:\.[0-9]+)?$/.test(hits)) throw new Error(`line hits is not a number: ${String(hits).slice(0, 40)}`);
      cur.cov.addLine(nr, Number(hits) > 0);
      const cc = ev.attrs.get('branch') === 'true' ? /\(([0-9]{1,12})\/([0-9]{1,12})\)/.exec(ev.attrs.get('condition-coverage') ?? '') : null;
      if (cc) cur.cov.addCount(nr, { covered: Number(cc[1]), total: Number(cc[2]) });
    }
    path.push(ev.name);
  });
  // The class names its file relative to a `source` dir (coverage.py) or to the run's cwd.
  return classes.map((c) => ({
    candidates: [...(isAbsolute(c.filename) ? [] : sources.map((s) => `${s.replace(/[\\/]+$/, '')}/${c.filename}`)), c.filename],
    suffix: false,
    cov: c.cov,
  }));
}

function parseLcov(text: string): Entry[] {
  const files = new Map<string, FileCov>();
  let cur: FileCov | null = null;
  let curPath = '';
  const lines = text.split(/\r\n|\r|\n/);
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]!.trim();
    const at = `lcov line ${k + 1}`;
    if (line.startsWith('SF:')) {
      if (cur) throw new Error(`${at}: SF before end_of_record`);
      curPath = line.slice(3).trim();
      if (curPath === '') throw new Error(`${at}: empty SF`);
      cur = files.get(curPath) ?? new FileCov();
      files.set(curPath, cur);
    } else if (line === 'end_of_record') {
      if (!cur) throw new Error(`${at}: end_of_record without SF`);
      cur = null;
    } else if (line.startsWith('DA:')) {
      const m = /^DA:([0-9]{1,12}),(-?[0-9]{1,15})(?:,[^,]*)?$/.exec(line);
      if (!cur || !m) throw new Error(`${at}: bad DA record`);
      const nr = Number(m[1]);
      if (nr > MAX_LINE_NO) throw new Error(`${at}: line number out of range`);
      if (nr >= 1) cur.addLine(nr, Number(m[2]) > 0);
    } else if (line.startsWith('BRDA:')) {
      const m = /^BRDA:([0-9]{1,12}),([^,]{1,64}),([^,]{1,64}),(-|[0-9]{1,15})$/.exec(line);
      if (!cur || !m) throw new Error(`${at}: bad BRDA record`);
      const nr = Number(m[1]);
      if (nr > MAX_LINE_NO) throw new Error(`${at}: line number out of range`);
      if (nr >= 1) cur.addKey(nr, `${m[2]}:${m[3]}`, m[4] !== '-' && Number(m[4]) > 0);
    } else if (/^(?:TN|FN|FNDA|FNF|FNH|LF|LH|BRF|BRH|VER|FNL|FNA):/.test(line) || line.trim() === '') {
      // function counts, summaries and the test name do not decide line or branch coverage
    } else {
      throw new Error(`${at}: unknown record ${JSON.stringify(line.slice(0, 20))}`);
    }
  }
  if (cur) throw new Error('lcov file ends inside a record (no end_of_record): truncated?');
  if (files.size === 0) throw new Error('lcov file has no SF record');
  return [...files].map(([p, cov]) => ({ candidates: [p], suffix: false, cov }));
}

/** The entries of one report, by its content: XML with a `report` root is JaCoCo, a `coverage`
 *  root Cobertura, else lcov. Throws on anything malformed. */
function parseReport(raw: string): Entry[] {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const head = text.trimStart();
  if (head.startsWith('<')) {
    const root = /<(?!\?|!)([A-Za-z_][\w.-]*)/.exec(head)?.[1];
    if (root === 'report') return parseJacoco(text);
    if (root === 'coverage') return parseCobertura(text);
    throw new Error(`unknown XML report (root <${root ?? '?'}>): JaCoCo (<report>) and Cobertura (<coverage>) are read`);
  }
  if (/^(?:TN|SF):/.test(head)) return parseLcov(text);
  throw new Error('unknown report format: JaCoCo XML, Cobertura XML and lcov are read');
}

// ---------------------------------------------------------------------------------------------
// Paths

/** `--root-map from=to` prefixes, as pairs. */
export type RootMap = Array<[string, string]>;

const outside = (r: string) => r === '..' || r.startsWith(`..${sep}`) || r.startsWith('../') || isAbsolute(r);

/** A path a report names, as a repo-relative path with `/` separators: through the first
 *  (longest) `from` prefix of the root map, else as an absolute path under the root, else as
 *  relative to the root; null when it falls outside the repo. */
function toRepoRel(root: string, rootMap: RootMap, raw: string): string | null {
  const p = raw.replace(/\\/g, '/');
  for (const [from, to] of rootMap) {
    const f = from.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === f || p.startsWith(`${f}/`)) {
      const r = relative(root, resolvePath(root, to, p.slice(f.length).replace(/^\/+/, '')));
      return outside(r) ? null : r.split(sep).join('/');
    }
  }
  if (isAbsolute(p)) {
    const r = relative(root, p);
    return outside(r) ? null : r.split(sep).join('/');
  }
  const n = posix.normalize(p);
  return n === '.' || n.startsWith('../') || n === '..' ? null : n;
}

// ---------------------------------------------------------------------------------------------
// Exemptions

interface Exemption {
  entry: string;
  glob: Bun.Glob;
  /** Inclusive line ranges; none: the whole file. */
  ranges: [number, number][];
}

/** `glob` or `glob#L10-L20` (also `#L10`). An entry whose `#…` is no range is a glob as it is. */
function parseExemption(entry: string): { glob: string; range: [number, number] | null } {
  const m = /^(.*)#L([0-9]{1,9})(?:-L?([0-9]{1,9}))?$/s.exec(entry);
  if (!m || m[1] === '') return { glob: entry, range: null };
  const a = Number(m[2]);
  const b = m[3] === undefined ? a : Number(m[3]);
  return { glob: m[1]!, range: [Math.min(a, b), Math.max(a, b)] };
}

// ---------------------------------------------------------------------------------------------
// The check

function emptyCheck(): CoverageCheck {
  return {
    ok: false,
    required: 0,
    full: 0,
    gaps: [],
    exempt_used: [],
    stale_exemptions: [],
    totals: { lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } },
    problems: [],
    report_errors: [],
  };
}

const byRel = <T extends { rel: string }>(a: T, b: T) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/** Checks the reports (paths) against the project at `root`. */
export function coverageCheck(root: string, reports: string[], opts: { rootMap?: RootMap } = {}): CoverageCheck {
  const res = emptyCheck();
  const rootMap = [...(opts.rootMap ?? [])].sort((a, b) => b[0].length - a[0].length);
  const problem = (s: string) => res.problems.push(s);
  const reportError = (s: string) => {
    res.report_errors.push(s);
    problem(s);
  };

  const listed = listFiles(root);
  if (listed === null) {
    problem('git cannot list the files (not a git repository, or git is missing)');
    return res;
  }
  let files = listed.filter((f) => !inSkippedDir(f));
  if (files.length > MAX_FILES) {
    problem(`${files.length} files; only the first ${MAX_FILES} were checked`);
    files = files.slice(0, MAX_FILES);
  }
  // Where a report path can land: the project's files, tests aside (a test never has coverage
  //   of its own here, and a same-named one must not make a JaCoCo suffix ambiguous).
  const pool = files.filter((f) => !isTestCode(f));
  const poolSet = new Set(pool);
  const byBase = new Map<string, string[]>();
  for (const f of pool) {
    const b = posix.basename(f);
    const l = byBase.get(b);
    if (l) l.push(f);
    else byBase.set(b, [f]);
  }

  // Reports.
  if (reports.length === 0) problem('no coverage report given');
  if (reports.length > MAX_REPORTS) problem(`${reports.length} reports; only the first ${MAX_REPORTS} were read`);
  const merged = new Map<string, FileCov>();
  const ambiguous = new Set<string>();
  let total = 0;
  for (const rp of reports.slice(0, MAX_REPORTS)) {
    const abs = resolvePath(root, rp);
    const read = readRegular(abs, MAX_REPORT_BYTES);
    if (read === 'absent') {
      reportError(`${rp}: no such file`);
      continue;
    }
    if (read === 'refused') {
      reportError(`${rp}: not a regular file, or over ${MAX_REPORT_BYTES / (1024 * 1024)} MB`);
      continue;
    }
    total += read.st.size;
    if (total > MAX_REPORTS_TOTAL) {
      reportError(`${rp}: the reports are over ${MAX_REPORTS_TOTAL / (1024 * 1024)} MB together`);
      break;
    }
    let entries: Entry[];
    try {
      entries = parseReport(read.text);
    } catch (err) {
      reportError(`${rp}: ${(err as Error).message}`);
      continue;
    }
    let mapped = 0;
    for (const e of entries) {
      let rel: string | null = null;
      if (e.suffix) {
        // A JaCoCo package path and file name: the one project file that ends with it.
        const want = e.candidates[0]!;
        const hits = (byBase.get(posix.basename(want)) ?? []).filter((f) => f === want || f.endsWith(`/${want}`));
        if (hits.length === 1) rel = hits[0]!;
        else if (hits.length > 1 && !ambiguous.has(want)) {
          ambiguous.add(want);
          problem(`${rp}: ${want} matches ${hits.length} files (${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ', …' : ''}); its coverage is not used`);
        }
      } else {
        for (const c of e.candidates) {
          const r = toRepoRel(root, rootMap, c);
          if (r !== null && poolSet.has(r)) {
            rel = r;
            break;
          }
        }
      }
      if (rel === null) continue;
      mapped++;
      const into = merged.get(rel);
      if (into) into.absorb(e.cov);
      else merged.set(rel, e.cov);
    }
    if (mapped === 0 && entries.length > 0 && !entries.some((e) => e.suffix && ambiguous.has(e.candidates[0]!))) {
      problem(`${rp}: none of its ${entries.length} files is a file of this project; check the paths in it (--root-map /work=. maps a container path)`);
    }
  }

  // The files that need coverage: code a coverage tool measures, not tests, not the
  //   project's non-own code (generated, vendored, config), not UI (M3 judges that), and not
  //   the user's whole-file exemptions.
  const exemptions: Exemption[] = [];
  const stale: string[] = [];
  for (const entry of policyGlobs(root, root, 'coverage-exempt')) {
    const { glob, range } = parseExemption(entry);
    try {
      exemptions.push({ entry, glob: new Bun.Glob(glob), ranges: range ? [range] : [] });
    } catch {
      problem(`exemption ${entry} is not a valid glob`);
      stale.push(entry);
    }
  }
  const typeExempt = policyGlobs(root, root, 'test-type-exempt');
  const until = Date.now() + READ_BUDGET_MS;
  const candidates: string[] = [];
  for (const rel of pool) {
    if (notOwnCode(rel)) continue;
    const abs = join(root, rel);
    try {
      // A link is no file of the project's own (its target may be outside it).
      if (!lstatSync(abs).isFile()) continue;
    } catch {
      continue; // listed but gone
    }
    if (!measurableCode(abs, until)) continue;
    // UI by the test-type rule, but only in the languages a browser runs: a Java or Python file
    //   under a `client/` dir is server-side code that M3 does not judge, so it stays required.
    if (WEB_EXT.test(rel) && typeNeedOf(abs, root, typeExempt)?.types.includes('ui')) continue;
    candidates.push(rel);
  }
  candidates.sort();

  const used = new Map<string, Set<string>>();
  const touch = (e: Exemption, rel: string) => {
    let s = used.get(e.entry);
    if (!s) used.set(e.entry, (s = new Set()));
    s.add(rel);
  };
  const required: string[] = [];
  for (const rel of candidates) {
    const whole = exemptions.filter((e) => e.ranges.length === 0 && e.glob.match(rel));
    for (const e of whole) touch(e, rel);
    if (whole.length === 0) required.push(rel);
  }

  // Per required file: what is missed, after the line exemptions.
  for (const rel of required) {
    const cov = merged.get(rel);
    if (!cov) {
      res.gaps.push({ rel, lines_missed: [], branches_missed: [], missing_from_report: true });
      continue;
    }
    const mine = exemptions.filter((e) => e.ranges.length > 0 && e.glob.match(rel));
    // Only a missed line or branch uses a range up: one that exempts only covered code is stale.
    const exemptLine = (line: number) => {
      let hit = false;
      for (const e of mine) {
        if (e.ranges.some(([a, b]) => line >= a && line <= b)) {
          hit = true;
          touch(e, rel);
        }
      }
      return hit;
    };
    const gap: CoverageGapFile = { rel, lines_missed: [], branches_missed: [], missing_from_report: false };
    for (const [line, covered] of [...cov.lines].sort((a, b) => a[0] - b[0])) {
      if (!covered && exemptLine(line)) continue;
      res.totals.lines.total++;
      if (covered) res.totals.lines.covered++;
      else gap.lines_missed.push(line);
    }
    for (const [line, b] of [...cov.branches()].sort((a, b) => a[0] - b[0])) {
      if (b.covered < b.total && exemptLine(line)) continue;
      res.totals.branches.total += b.total;
      res.totals.branches.covered += b.covered;
      if (b.covered < b.total) gap.branches_missed.push({ line, missed: b.total - b.covered, total: b.total });
    }
    if (gap.lines_missed.length > 0 || gap.branches_missed.length > 0) res.gaps.push(gap);
  }

  res.gaps.sort(byRel);
  res.required = required.length;
  res.full = required.length - res.gaps.length;
  res.exempt_used = [...used].map(([entry, set]) => ({ entry, files: [...set].sort() })).sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0));
  for (const e of exemptions) if (!used.has(e.entry) && !stale.includes(e.entry)) stale.push(e.entry);
  res.stale_exemptions = stale;
  res.ok = res.gaps.length === 0 && res.problems.length === 0;
  return res;
}

// ---------------------------------------------------------------------------------------------
// CLI

/** `coverage-check <report...> [--root-map /work=.]`: the check's output and exit code (1 when
 *  not ok), or an error for bad arguments and for a report that cannot be read (its gaps would
 *  mislead). */
export function cmdCoverageCheck(root: string, args: string[]): { out: unknown; code: number } | { error: string } {
  const reports: string[] = [];
  const rootMap: RootMap = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    let spec: string | undefined;
    if (a === '--root-map') {
      spec = args[++i];
      if (spec === undefined) return { error: '--root-map needs from=to (for example /work=.)' };
    } else if (a.startsWith('--root-map=')) spec = a.slice('--root-map='.length);
    else if (a.startsWith('--')) return { error: `unknown option ${a}; usage: coverage-check <report...> [--root-map /work=.]` };
    else {
      reports.push(a);
      continue;
    }
    const eq = spec.indexOf('=');
    if (eq <= 0 || eq === spec.length - 1) return { error: `--root-map ${spec}: expected from=to (for example /work=.)` };
    rootMap.push([spec.slice(0, eq), spec.slice(eq + 1)]);
  }
  if (reports.length === 0) return { error: 'usage: coverage-check <report...> [--root-map /work=.]' };
  const out = coverageCheck(root, reports, { rootMap });
  if (out.report_errors.length > 0) return { error: out.report_errors.join('; ') };
  return { out, code: out.ok ? 0 : 1 };
}
