// Text helpers of the UI inventory (track M, M3; plan §19): blanking comments without moving a
// line, matching brackets around string literals, and the collector the scanners write into.
// Every loop is linear in the text.

import { createHash } from 'node:crypto';
import { type UiItem, type UiKind, normRoute } from './ui-types';

export interface SrcFile {
  rel: string;
  text: string;
}

/** A route the app serves, kept for linking even when it is no item (a POST handler of a
 *  form): `kind` is the item kind it became, or `handler`. */
export interface Route {
  method: string;
  /** Pattern without the context path. */
  pattern: string;
  file: string;
  line: number;
  kind: UiKind | 'handler';
}

export const lineAt = (text: string, pos: number): number => {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
};

/** Replaces comments with spaces, keeping every newline and every other character at its offset.
 *  `c`: `//` and block comments (Java, JS, TS); `py`: `#` comments and triple-quoted strings;
 *  `html`: `<!-- -->` and `<%-- --%>`. String literals are skipped, so `"http://x"` stays. */
export function blankComments(text: string, style: 'c' | 'py' | 'html'): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  if (style === 'html') {
    for (const re of [/<!--[\s\S]*?-->/g, /<%--[\s\S]*?--%>/g]) for (const m of text.matchAll(re)) blank(m.index!, m.index! + m[0].length);
    return out.join('');
  }
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (style === 'c' && c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (style === 'c' && c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (style === 'py' && c === '#') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end);
      i = end;
    } else if (style === 'py' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      const e = text.indexOf(q, i + 3);
      const end = e < 0 ? n : e + 3;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'" || (c === '`' && style === 'c')) {
      i = skipString(text, i);
    } else i++;
  }
  return out.join('');
}

/** The offset after the string literal that opens at `i`. A `'` or `"` literal ends at its closing
 *  quote or at the end of its line (so a stray quote in a regex harms one line); a template
 *  literal ends at its closing backtick. */
export function skipString(text: string, i: number): number {
  const q = text[i]!;
  let j = i + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '\\') j += 2;
    else if (c === q) return j + 1;
    else if (c === '\n' && q !== '`') return j;
    else j++;
  }
  return text.length;
}

/** The offset of the bracket closing the one at `open` (`(`, `[` or `{`), skipping strings, or -1. */
export function findClose(text: string, open: number): number {
  const o = text[open]!;
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < text.length; ) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
    i++;
  }
  return -1;
}

/** The text of a string literal, quotes and escapes of the simple kind removed. */
export const unquote = (s: string): string => s.trim().replace(/^(["'`])([\s\S]*)\1$/, '$2');

/** `label` as an id part: lower-case ASCII `[a-z0-9_-]`. Text with other characters keeps its ASCII
 *  words and gets a short hash of the whole, so two Korean labels never share an id. */
export function slug(label: string): string {
  const t = label.trim().replace(/\s+/g, ' ');
  const ascii = t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (/^[\x20-\x7e]*$/.test(t) && ascii !== '') return ascii;
  const h = createHash('sha1').update(t).digest('hex').slice(0, 6);
  return ascii === '' ? `u${h}` : `${ascii}-u${h}`;
}

/** A route as it goes into an id: ASCII only, no space, comma or semicolon. */
export const routeForId = (route: string): string => route.replace(/[^\x21-\x7e]|[,;]/gu, (c) => encodeURIComponent(c));

/** Collects items by id: a second sighting of an id is dropped (the first by file order stays),
 *  but `input` is the OR of all, and a route is remembered for linking. */
export class Sink {
  readonly items = new Map<string, UiItem>();
  readonly routes: Route[] = [];
  readonly notes: string[] = [];

  add(item: UiItem): void {
    const prev = this.items.get(item.id);
    if (prev) prev.input = prev.input || item.input;
    else this.items.set(item.id, item);
  }

  /** A route with no item of its own, or the route of an item just added. */
  route(r: Route): void {
    if (!this.routes.some((x) => x.method === r.method && x.pattern === r.pattern)) this.routes.push(r);
  }

  note(text: string): void {
    if (!this.notes.includes(text) && this.notes.length < 200) this.notes.push(text);
  }

  /** An item whose id would repeat inside one file gets `~2`, `~3` (a second "Save" button). */
  addUnique(item: UiItem, seenInFile: Map<string, number>): void {
    const n = (seenInFile.get(item.id) ?? 0) + 1;
    seenInFile.set(item.id, n);
    this.add(n === 1 ? item : { ...item, id: `${item.id}~${n}` });
  }
}

export const idOf = (sub: string, method: string, route: string): string => `${sub}:${method}:${routeForId(normRoute(route))}`;

/** A function from a text offset to its 1-based line (binary search over the line starts). */
export function makeLineOf(text: string): (pos: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
