// Track M fix round 1, fixer B (plan §19): the linear replacements agree with the regexes and loops
// they replaced. Each test runs the old code (copied here) and the new code over many small random
// inputs from an alphabet of the characters that matter, and expects the same answer. The timing of
// the new code is tests/m-fix-b-perf.test.ts.

import { describe, expect, test } from 'bun:test';
import { resolveDefaults, stringLiterals } from '../lib/sandbox-scan';
import { findClose, skipString } from '../lib/ui-scan-text';
import { markupOf } from '../lib/ui-templates';
import { RouteIndex, routeMatches } from '../lib/ui-types';

/** A small deterministic random source, so a failure can be reproduced. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomText(rnd: () => number, alphabet: string[], maxLen: number): string {
  const n = Math.floor(rnd() * (maxLen + 1));
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
}

describe('resolveDefaults (was /\\$\\{[^}:]*:([^}]*)\\}/g)', () => {
  const OLD = (v: string) => v.replace(/\$\{[^}:]*:([^}]*)\}/g, '$1');

  test('gives the old answer on 30 000 random strings of the characters that matter', () => {
    const rnd = rng(1);
    for (let i = 0; i < 30_000; i++) {
      const v = randomText(rnd, ['$', '{', '}', ':', 'a', 'b', ' ', '${', '}:', ':}'], 14);
      expect({ v, got: resolveDefaults(v) }).toEqual({ v, got: OLD(v) });
    }
  });

  test('the cases that decide it', () => {
    expect(resolveDefaults('${a.b:8080}')).toBe('8080');
    expect(resolveDefaults('jdbc:x://${HOST:db.local}:${PORT:5432}/${NAME}')).toBe('jdbc:x://db.local:5432/${NAME}');
    expect(resolveDefaults('${a}${b:c}')).toBe('${a}c');
    expect(resolveDefaults('${a:${b:c}}')).toBe('${b:c}'); // the default of the outer one stops at the first `}`
    expect(resolveDefaults('${unterminated:x')).toBe('${unterminated:x');
    expect(resolveDefaults('')).toBe('');
  });
});

describe('stringLiterals (was a regex over "…", \'…\' and `…` with backslash escapes)', () => {
  const OLD_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;
  const OLD = (line: string) => [...line.matchAll(OLD_RE)].map((m) => m[0].slice(1, -1));

  test('gives the old answer on 40 000 random lines', () => {
    const rnd = rng(2);
    for (let i = 0; i < 40_000; i++) {
      const line = randomText(rnd, ['"', "'", '`', '\\', 'a', 'b', ' ', '\r', '\\"', "\\'"], 16);
      expect({ line, got: stringLiterals(line) }).toEqual({ line, got: OLD(line) });
    }
  });

  test('an unterminated quote does not hide the literals that follow it', () => {
    expect(stringLiterals(`it's "a.example.com" and 'b'`)).toEqual(OLD(`it's "a.example.com" and 'b'`));
    expect(stringLiterals(`x "a" 'unterminated "b"`)).toEqual(['a', 'b']);
  });
});

describe('markupOf (was TAG_RE over the whole text)', () => {
  const TAG_RE = /<([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  function oldTags(html: string) {
    const tags: { name: string; attrs: [string, string][]; start: number; end: number }[] = [];
    for (const m of html.matchAll(TAG_RE)) {
      const attrs = new Map<string, string>();
      for (const a of m[2]!.matchAll(ATTR_RE)) {
        const key = a[1]!.toLowerCase();
        if (key === '/') continue;
        const val = a[2] === undefined ? '' : a[2].replace(/^(["'])([\s\S]*)\1$/, '$2');
        if (!attrs.has(key)) attrs.set(key, val);
      }
      tags.push({ name: m[1]!.toLowerCase(), attrs: [...attrs], start: m.index!, end: m.index! + m[0].length });
    }
    return tags;
  }
  const NEW = (html: string) => markupOf(html).tags.map((t) => ({ name: t.name, attrs: [...t.attrs], start: t.start, end: t.end }));

  test('finds the same tags, attributes and offsets in 40 000 random fragments', () => {
    const rnd = rng(3);
    const alphabet = ['<', '>', 'a', 'b', ' ', '"', "'", '=', '/', '<a ', '<b x=', 'href=', '\n', '>"', '<!', '-', ':', 'x="1"', "y='2'", '</a>'];
    for (let i = 0; i < 40_000; i++) {
      const html = randomText(rnd, alphabet, 16);
      expect({ html, got: NEW(html) }).toEqual({ html, got: oldTags(html) });
    }
  });

  test('a quoted value may hold > and <; an unterminated quote makes no tag', () => {
    expect(NEW('<a href="x>y" title=\'<b>\'>t</a>')).toEqual(oldTags('<a href="x>y" title=\'<b>\'>t</a>'));
    expect(markupOf('<a href="x>y">').tags).toHaveLength(1);
    expect(markupOf('<a href="x').tags).toHaveLength(0);
    expect(markupOf('<a <b c="1">').tags.map((t) => t.name)).toEqual(['a']); // the first `>` ends the first tag, `<b …` is inside it
    expect(NEW('<a <b c="1">')).toEqual(oldTags('<a <b c="1">'));
  });
});

/** routeMatches as it was: one regex per pattern segment (`{x}` is `[^/]+`, `*` is `[^/]*`, `?` is `[^/]`). */
function oldRouteMatches(pattern: string, path: string): boolean {
  const norm = (p: string) => {
    const s = `/${p}`.replace(/\/{2,}/g, '/');
    return s.length > 1 ? s.replace(/\/+$/, '') : s;
  };
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const segRe = (seg: string): RegExp => {
    let out = '';
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === '{') {
        const j = seg.indexOf('}', i);
        if (j > 0) {
          out += '[^/]+';
          i = j;
          continue;
        }
      }
      out += seg[i] === '*' ? '[^/]*' : seg[i] === '?' ? '[^/]' : seg[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`);
  };
  const pat = norm(pattern).split('/').filter(Boolean);
  const got = norm(path).split('/').filter(Boolean).map(decode);
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '{*}') return true;
    if (i >= got.length) return false;
    if (!segRe(pat[i]!).test(got[i]!)) return false;
  }
  return got.length === pat.length;
}

describe('segment matching (was one regex per segment)', () => {
  test('the glob walk agrees with the regex on 40 000 random segment patterns and segments', () => {
    const rnd = rng(7);
    const pieces = ['a', 'b', '-', '.', '*', '?', '{x}', '{', '}', '%2F', 'ab'];
    const texts = ['a', 'b', '-', '.', '/', 'ab', 'x'];
    for (let i = 0; i < 40_000; i++) {
      const pattern = `/${randomText(rnd, pieces, 6)}`;
      const path = `/${randomText(rnd, texts, 8).replace(/\//g, '%2F')}`;
      expect({ pattern, path, got: routeMatches(pattern, path) }).toEqual({ pattern, path, got: oldRouteMatches(pattern, path) });
    }
  });

  test('a segment with many wildcards or placeholders does not backtrack: 8 of them against a near miss (4.5 s and 9.3 s as regexes)', () => {
    const stars = `/x/${'a*'.repeat(8)}b`;
    const near = `/x/${'a'.repeat(60)}`;
    const dashes = `/files/${Array.from({ length: 8 }, (_, i) => `{p${i}}`).join('-')}.csv`;
    const dashed = `/files/${'a-'.repeat(60)}x`;
    const t0 = performance.now();
    expect(routeMatches(stars, near)).toBe(false);
    expect(routeMatches(dashes, dashed)).toBe(false);
    expect(routeMatches(dashes, `/files/${'a-'.repeat(7)}a.csv`)).toBe(true);
    const index = new RouteIndex<true>();
    index.add(stars, true);
    index.add(dashes, true);
    expect(index.has(near)).toBe(false);
    expect(index.has(dashed)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('RouteIndex (was routeMatches against every route)', () => {
  test('finds exactly the patterns routeMatches accepts, over 20 000 random route sets and paths', () => {
    const rnd = rng(4);
    const segs = ['a', 'b', 'c', '{id}', '{}', '*', 'x?', '{*}', 'a{}', 'pre*', '{n:\\d+}', 'a%20b'];
    const parts = ['a', 'b', 'c', 'x1', 'x', 'a%20b', 'a b', 'preq', 'a1', '42', ''];
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    for (let i = 0; i < 20_000; i++) {
      const patterns = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => `/${Array.from({ length: Math.floor(rnd() * 4) }, () => pick(segs)).join('/')}`);
      const path = `/${Array.from({ length: Math.floor(rnd() * 4) }, () => pick(parts)).join('/')}`;
      const index = new RouteIndex<string>();
      for (const p of patterns) index.add(p, p);
      const want = [...new Set(patterns.filter((p) => oldRouteMatches(p, path)))].sort();
      const got = [...new Set(index.find(path))].sort();
      expect({ patterns, path, got }).toEqual({ patterns, path, got: want });
      expect(index.has(path)).toBe(want.length > 0);
    }
  });

  test('several patterns that differ only in a variable name share a node and all report', () => {
    const index = new RouteIndex<string>();
    index.add('/orders/{id}', 'screen');
    index.add('/orders/{orderId}', 'api');
    index.add('/orders/new', 'link');
    expect(index.find('/orders/new').sort()).toEqual(['api', 'link', 'screen']);
    expect(index.find('/orders/7').sort()).toEqual(['api', 'screen']);
    expect(index.find('/orders')).toEqual([]);
  });

  test('a very deep path does not recurse', () => {
    const index = new RouteIndex<true>();
    index.add('/a/{*}', true);
    expect(index.has(`/a/${'b/'.repeat(200_000)}`)).toBe(true);
    expect(index.has(`/${'b/'.repeat(200_000)}`)).toBe(false);
  });
});

describe('findClose (was a scan from each open bracket)', () => {
  /** The scan the old function made: from the open bracket, counting its own kind, skipping strings. */
  function oldFindClose(text: string, open: number): number {
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

  test('matches the old answer for every bracket of long random texts without quotes (the single-pass path)', () => {
    const rnd = rng(5);
    for (let t = 0; t < 40; t++) {
      const text = randomText(rnd, ['(', ')', '[', ']', '{', '}', 'a', ' ', '\n', 'fetch('], 4000).padEnd(600, ' ');
      for (let i = 0; i < text.length; i++) if ('([{'.includes(text[i]!)) expect({ t, i, got: findClose(text, i) }).toEqual({ t, i, got: oldFindClose(text, i) });
    }
  });

  test('matches the old answer for brackets outside strings in long texts with quotes', () => {
    const rnd = rng(6);
    for (let t = 0; t < 40; t++) {
      // one quote kind per line and a closing quote on the same line keeps every string state clear
      const lines = Array.from({ length: 80 }, () => `${randomText(rnd, ['(', ')', '{', '}', 'a', ' '], 8)} "${randomText(rnd, ['(', ')', 'b'], 6)}" ${randomText(rnd, ['(', ')', '[', ']', 'c'], 8)}`);
      const text = lines.join('\n');
      // (an even number of quotes before it on its line: the bracket is outside a string)
      const outsideString = (i: number) => text.slice(text.lastIndexOf('\n', i) + 1, i).split('"').length % 2 === 1;
      for (let i = 0; i < text.length; i++) if ('([{'.includes(text[i]!) && outsideString(i)) expect({ t, i, got: findClose(text, i) }).toEqual({ t, i, got: oldFindClose(text, i) });
    }
  });

  test('a bracket that sits inside a string of a long text is still looked up (a call written in a string)', () => {
    const text = `${' '.repeat(600)}const s = "call fetch('/x') like this"; foo(bar)`;
    const open = text.indexOf("('/x')");
    expect(findClose(text, open)).toBe(oldFindClose(text, open));
    expect(text[findClose(text, open)]).toBe(')');
  });

  test('an unclosed open does not stop the later ones from matching', () => {
    const text = `${'('.repeat(3)}${' '.repeat(600)}fetch(a)(b)`;
    expect(findClose(text, text.indexOf('fetch(') + 5)).toBe(text.indexOf('fetch(') + 7);
    expect(findClose(text, 0)).toBe(-1);
  });
});
