// The structured result of a sandbox run (track M, M6a; plan §19): counts only. Per-suite counts
// from JUnit XML (JVM) and the stats and per-file counts of the Playwright JSON report; any other
// runner leaves its exit code and duration. No test case name, message, `system-out` or title is
// read into the result: those can hold rows of a real database. The parsers are bounded and fail
// closed: input that is not what they expect gives `unreadable: true`, never its text.

import { E2E_DIR } from './sandbox-e2e';

/** At most this many bytes per XML file and this many files are read (the reader enforces it too). */
export const MAX_JUNIT_BYTES = 2 * 1024 * 1024;
export const MAX_JUNIT_FILES = 500;
/** More suites than this in all are cut off and flagged `truncated`. */
const MAX_SUITES = 2000;
const MAX_SPEC_FILES = 500;

export interface JUnitSuite {
  name: string;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  time: number;
}

export interface UnitSummary {
  exit: number;
  durationMs: number;
  timedOut: boolean;
  suites?: JUnitSuite[];
  /** More suites than the cap, or more files than the count cap. */
  truncated?: true;
  /** The read budget of the reader call was reached: some files were not read. */
  partial?: true;
  /** Files left out: over the per-file cap, or not regular files. */
  skipped_files?: number;
  /** A JVM run that left no JUnit XML in the volumes (its module's output dir may not be one). */
  counts?: 'missing';
  unreadable?: true;
}

export interface E2eStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  duration: number;
}

export interface E2eSummary {
  exit: number;
  durationMs: number;
  timedOut: boolean;
  stats?: E2eStats;
  files?: { file: string; passed: number; failed: number }[];
  unreadable?: true;
}

export interface RunSummary {
  unit?: UnitSummary;
  e2e?: E2eSummary;
}

/** A name that looks like a Java or Kotlin class (inner classes with `$`). Anything else is a
 *  display name a test author wrote, and may be data. */
const CLASS_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[\w:.-]/;
const SPACE = /\s/;

/** The attributes of the text of a start tag after its name, `name="value"` or `name='value'`, read in
 *  one pass; it stops at the first thing that is not one. */
function attributes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  const skip = (): void => {
    while (i < text.length && SPACE.test(text[i]!)) i++;
  };
  for (;;) {
    skip();
    if (i >= text.length || !NAME_START.test(text[i]!)) return out;
    const from = i;
    while (i < text.length && NAME_CHAR.test(text[i]!)) i++;
    const name = text.slice(from, i);
    skip();
    if (text[i] !== '=') return out;
    i++;
    skip();
    const q = text[i];
    if (q !== '"' && q !== "'") return out;
    const close = text.indexOf(q, i + 1);
    if (close < 0) return out;
    out.set(name, text.slice(i + 1, close));
    i = close + 1;
  }
}
/** A start tag longer than this is no test report's: the attribute scan stays short. */
const MAX_TAG_CHARS = 16 * 1024;

const count = (v: string | undefined, dflt: number): number | null => {
  if (v === undefined) return dflt;
  return /^\d{1,9}$/.test(v) ? Number(v) : null;
};

/** The end of the tag that opens at `from` (the index of its `>`), reading quoted values whole, or -1
 *  when it is not closed within MAX_TAG_CHARS. One forward pass. */
function tagEnd(xml: string, from: number): number {
  let quote = '';
  const stop = Math.min(xml.length, from + MAX_TAG_CHARS);
  for (let i = from; i < stop; i++) {
    const c = xml[i]!;
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

interface Open {
  attrs: Map<string, string>;
  /** A `<testsuite>` inside it: it repeats the suites inside, and they are the counts. */
  wraps: boolean;
  /** The `<testcase>` elements written directly in it, and what they report, for a suite that wraps
   *  others and has such cases of its own (counted once, as one more suite of its name). */
  direct: { tests: number; failures: number; errors: number; skipped: number };
  inCase: boolean;
}

/** The leaf suites of the JUnit XML texts, one entry per `<testsuite>` that holds no other one
 *  (a wrapping suite repeats the counts of the suites inside it): their counts and, when the name is a
 *  class name, the name (else `suite-<n>`). One forward scanner per text, each marker (comment,
 *  CDATA, processing instruction, tag) is looked for once from where the scan is, so the time is linear
 *  in the text however it is garbled. `unreadable` for a text with no suite, a comment, CDATA, tag or
 *  suite that is not closed, a close with no open, or a count that is not a plain number. */
export function parseJUnit(texts: readonly string[]): { suites: JUnitSuite[]; truncated: boolean } | 'unreadable' {
  const suites: JUnitSuite[] = [];
  let truncated = false;
  let n = 0;
  const emit = (attrs: Map<string, string>): boolean => {
    const tests = count(attrs.get('tests'), 0);
    const failures = count(attrs.get('failures'), 0);
    const errors = count(attrs.get('errors'), 0);
    const skipped = count(attrs.get('skipped') ?? attrs.get('disabled'), 0);
    const t = attrs.get('time');
    const time = t === undefined ? 0 : /^\d{1,9}(?:\.\d{1,9})?$/.test(t) ? Number(t) : null;
    if (tests === null || failures === null || errors === null || skipped === null || time === null) return false;
    n++;
    if (suites.length >= MAX_SUITES) {
      truncated = true;
      return true;
    }
    const name = attrs.get('name');
    suites.push({ name: name !== undefined && name.length <= 200 && CLASS_NAME.test(name) ? name : `suite-${n}`, tests, failures, errors, skipped, time });
    return true;
  };
  for (const xml of texts) {
    const stack: Open[] = [];
    let found = 0;
    for (let i = xml.indexOf('<'); i >= 0; i = xml.indexOf('<', i)) {
      if (xml.startsWith('<!--', i)) {
        const e = xml.indexOf('-->', i + 4);
        if (e < 0) return 'unreadable';
        i = e + 3;
      } else if (xml.startsWith('<![CDATA[', i)) {
        const e = xml.indexOf(']]>', i + 9);
        if (e < 0) return 'unreadable';
        i = e + 3;
      } else if (xml.startsWith('<?', i)) {
        const e = xml.indexOf('?>', i + 2);
        if (e < 0) return 'unreadable';
        i = e + 2;
      } else if (xml.startsWith('</testsuite', i) && /[\s>]/.test(xml[i + 11] ?? '')) {
        const e = tagEnd(xml, i);
        const top = stack.pop();
        if (e < 0 || top === undefined) return 'unreadable';
        if (!top.wraps) {
          if (!emit(top.attrs)) return 'unreadable';
        } else if (top.direct.tests > 0) {
          const own = new Map(top.attrs);
          for (const k of ['tests', 'failures', 'errors', 'skipped'] as const) own.set(k, String(top.direct[k]));
          own.delete('disabled');
          own.delete('time');
          if (!emit(own)) return 'unreadable';
        }
        i = e + 1;
      } else if (xml.startsWith('<testsuite', i) && /[\s>/]/.test(xml[i + 10] ?? '')) {
        const e = tagEnd(xml, i);
        if (e < 0) return 'unreadable';
        found++;
        const attrs = attributes(xml.slice(i + 10, xml[e - 1] === '/' ? e - 1 : e));
        const parent = stack[stack.length - 1];
        if (parent) parent.wraps = true;
        if (xml[e - 1] === '/') {
          if (!emit(attrs)) return 'unreadable';
        } else stack.push({ attrs, wraps: false, direct: { tests: 0, failures: 0, errors: 0, skipped: 0 }, inCase: false });
        i = e + 1;
      } else if (xml.startsWith('<testcase', i) && /[\s>/]/.test(xml[i + 9] ?? '')) {
        const e = tagEnd(xml, i);
        if (e < 0) return 'unreadable';
        const top = stack[stack.length - 1];
        if (top) {
          top.direct.tests++;
          if (xml[e - 1] !== '/') top.inCase = true;
        }
        i = e + 1;
      } else {
        const top = stack[stack.length - 1];
        if (top?.inCase) {
          if (xml.startsWith('</testcase', i)) top.inCase = false;
          else if (/^<(failure|error|skipped)[\s>/]/.test(xml.slice(i, i + 12))) top.direct[xml[i + 1] === 'f' ? 'failures' : xml[i + 1] === 'e' ? 'errors' : 'skipped']++;
        }
        i += 1;
      }
    }
    if (found === 0 || stack.length > 0) return 'unreadable';
  }
  return { suites, truncated };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A project-relative path from a report's `file` (relative to the e2e dir), or null when it is not
 *  a plain path. */
function specFile(file: unknown): string | null {
  if (typeof file !== 'string' || !/^[\w@+./-]{1,200}$/.test(file) || file.split('/').includes('..') || file.startsWith('/')) return null;
  return file.startsWith(`${E2E_DIR}/`) ? file : `${E2E_DIR}/${file}`;
}

/** `stats` and per-file counts of a Playwright JSON report; test titles, annotations and errors
 *  are never read. `unreadable` for a text that is not a report with `suites` and numeric `stats`. */
export function playwrightSummary(text: string): { stats: E2eStats; files: { file: string; passed: number; failed: number }[] } | 'unreadable' {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  const root = j as { suites?: unknown; stats?: Record<string, unknown> } | null;
  if (typeof root !== 'object' || root === null || !Array.isArray(root.suites) || typeof root.stats !== 'object' || root.stats === null) return 'unreadable';
  const s = root.stats;
  if (![s.expected, s.unexpected, s.flaky, s.skipped, s.duration].every(finite)) return 'unreadable';
  const stats: E2eStats = { expected: s.expected as number, unexpected: s.unexpected as number, flaky: s.flaky as number, skipped: s.skipped as number, duration: s.duration as number };
  const byFile = new Map<string, { passed: number; failed: number }>();
  let bad = false;
  const walk = (suite: unknown, inherited: unknown, depth: number): void => {
    const x = suite as { file?: unknown; suites?: unknown; specs?: unknown } | null;
    if (typeof x !== 'object' || x === null || depth > 50) {
      bad = true;
      return;
    }
    const file = x.file ?? inherited;
    if (x.specs !== undefined && !Array.isArray(x.specs)) bad = true;
    for (const sp of Array.isArray(x.specs) ? (x.specs as unknown[]) : []) {
      const spec = sp as { file?: unknown; tests?: unknown } | null;
      if (typeof spec !== 'object' || spec === null || !Array.isArray(spec.tests)) {
        bad = true;
        continue;
      }
      const key = String(spec.file ?? file ?? '');
      const cur = byFile.get(key) ?? { passed: 0, failed: 0 };
      for (const t of spec.tests as { status?: unknown }[]) {
        if (typeof t !== 'object' || t === null) bad = true;
        else if (t.status === 'expected') cur.passed++;
        else if (t.status === 'unexpected') cur.failed++;
      }
      byFile.set(key, cur);
    }
    if (x.suites !== undefined && !Array.isArray(x.suites)) bad = true;
    for (const c of Array.isArray(x.suites) ? (x.suites as unknown[]) : []) walk(c, file, depth + 1);
  };
  for (const sv of root.suites) walk(sv, undefined, 0);
  if (bad || byFile.size > MAX_SPEC_FILES) return 'unreadable';
  // a file that is not a plain path is named by its number among those, never by its text
  let odd = 0;
  const files = [...byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([raw, c]) => ({ file: specFile(raw) ?? `file-${++odd}`, ...c }));
  return { stats, files };
}
