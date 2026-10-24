// Text helpers of the UI inventory (track M, M3; plan §19): blanking comments without moving a
// line, matching brackets around string literals, and the collector the scanners write into.
// Every loop is linear in the text: a bracket is matched once per text (not scanned for from each
// open one), a comment is closed by one search, and a line number is a binary search.

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

/** Replaces comments with spaces, keeping every newline and every other character at its offset.
 *  `c`: `//` and block comments (Java, JS, TS); `py`: `#` comments and triple-quoted strings;
 *  `html`: `<!-- -->` and `<%-- --%>`. String literals are skipped, so `"http://x"` stays. */
export function blankComments(text: string, style: 'c' | 'py' | 'html'): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  if (style === 'html') {
    // By search, not by `<!--[\s\S]*?-->`: that scans to the end from every `<!--` that has no
    //   `-->`. Once one search finds no close, no later start has one either.
    for (const [open, close] of [['<!--', '-->'], ['<%--', '--%>']] as const) {
      for (let i = text.indexOf(open); i >= 0; ) {
        const e = text.indexOf(close, i + open.length);
        if (e < 0) break;
        blank(i, e + close.length);
        i = text.indexOf(open, e + close.length);
      }
    }
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

/** Below this length a bracket is looked for directly; above it the brackets of the text are
 *  matched once (a scan from each unmatched open one ran to the end of the text each time). */
const MATCH_FROM_LENGTH = 512;
/** How far to look from an open bracket that the single pass read as part of a string (it is no
 *  open bracket there, but a caller may ask about one: `"call fetch('/x') like this"`). */
const IN_STRING_WINDOW = 4000;
const BRACKETS = ['(', '[', '{'] as const;
const PAIR_CACHE_MAX = 8;
const pairCache = new Map<string, Map<number, number>[]>();

/** Every bracket of one kind in the text, matched in a single pass (strings skipped, a stray close
 *  ignored): open offset → close offset, -1 for an open that is never closed. */
function pairsOf(text: string, kind: number): Map<number, number> {
  let perKind = pairCache.get(text);
  if (!perKind) {
    if (pairCache.size >= PAIR_CACHE_MAX) pairCache.delete(pairCache.keys().next().value!);
    pairCache.set(text, (perKind = []));
  }
  let pairs = perKind[kind];
  if (pairs) return pairs;
  pairs = new Map();
  perKind[kind] = pairs;
  const o = BRACKETS[kind];
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  const stack: number[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === o) {
      stack.push(i);
      pairs.set(i, -1);
    } else if (ch === c && stack.length > 0) pairs.set(stack.pop()!, i);
    i++;
  }
  return pairs;
}

function findCloseFrom(text: string, open: number, limit: number): number {
  const o = text[open]!;
  const c = o === '(' ? ')' : o === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < limit; ) {
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

/** The offset of the bracket closing the one at `open` (`(`, `[` or `{`), skipping strings, or -1. */
export function findClose(text: string, open: number): number {
  if (text.length < MATCH_FROM_LENGTH) return findCloseFrom(text, open, text.length);
  const hit = pairsOf(text, text[open] === '(' ? 0 : text[open] === '[' ? 1 : 2).get(open);
  if (hit !== undefined) return hit;
  return findCloseFrom(text, open, Math.min(text.length, open + IN_STRING_WINDOW));
}

/** The longest body of a placeholder, a quoted import path, a tag or the like that the scanners'
 *  regexes look for. An unbounded `[^}]*` rescans to the end of the text from every opener that has
 *  no closer (`${` repeated); no real one is this long. */
export const PLACEHOLDER_MAX = 300;

/** A regex whose `,N}` bounds are PLACEHOLDER_MAX: write `{0,N}` or `{1,N}` in the literal (there it
 *  is plain text, not yet a quantifier), so the number is named in one place. */
export function bounded(re: RegExp): RegExp {
  return new RegExp(re.source.replaceAll(',N}', `,${PLACEHOLDER_MAX}}`), re.flags);
}

/** The index of the first element of the ascending `xs` that is `>= x` (`xs.length` when none). */
export function lowerBound(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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

/** The most items (and the most routes) one inventory holds. Far above a real app; past it the rest
 *  is dropped and `Sink.truncated` says so, so that a pathological file cannot make the inventory
 *  as large as its text multiplied by itself. */
export const MAX_INVENTORY_ITEMS = 50_000;

/** Collects items by id: a second sighting of an id is dropped (the first by file order stays),
 *  but `input` is the OR of all, and a route is remembered for linking. */
export class Sink {
  readonly items = new Map<string, UiItem>();
  readonly routes: Route[] = [];
  readonly notes: string[] = [];
  /** Why the inventory is not complete (a cap dropped items, the time ran out): ui-check fails on any. */
  readonly truncated: string[] = [];
  private readonly routeKeys = new Set<string>();

  /** Records that something was left out, once per reason (a note says it too). */
  incomplete(reason: string): void {
    if (!this.truncated.includes(reason) && this.truncated.length < 50) {
      this.truncated.push(reason);
      this.note(reason);
    }
  }

  add(item: UiItem): void {
    const prev = this.items.get(item.id);
    if (prev) prev.input = prev.input || item.input;
    else if (this.items.size >= MAX_INVENTORY_ITEMS) this.incomplete(`the inventory holds ${MAX_INVENTORY_ITEMS} items and no more: the rest are not listed`);
    else this.items.set(item.id, item);
  }

  /** A route with no item of its own, or the route of an item just added. */
  route(r: Route): void {
    const key = `${r.method} ${r.pattern}`;
    if (this.routeKeys.has(key)) return;
    if (this.routes.length >= MAX_INVENTORY_ITEMS) {
      this.incomplete(`the inventory holds ${MAX_INVENTORY_ITEMS} routes and no more: the rest are not listed`);
      return;
    }
    this.routeKeys.add(key);
    this.routes.push(r);
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

/** The id of an element with no route: `<sub>:<file>#<label>`. The file part goes through
 *  routeForId, so a path with a space or a non-ASCII character (`templates/주문/list.html`) still
 *  makes an id a test can claim; an ASCII path without a space or comma is unchanged. */
export const fileIdOf = (sub: string, file: string, label: string): string => `${sub}:${routeForId(file)}#${slug(label)}`;

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
