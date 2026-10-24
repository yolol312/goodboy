// The UI inventory and its check (track M, M3; plan §19): the shapes shared by lib/ui-inventory.ts,
// which lists a project's screens, actions and APIs with stable ids, and lib/ui-check.ts, which
// judges the e2e run against them, plus the route patterns both match requests with.

export type UiKind = 'screen' | 'action' | 'api';

/** One thing a browser test must reach. `id` is `<sub>:<METHOD>:<route>` for routes and
 *  `<sub>:<file>#<label>` for elements with no route; it holds no space, comma or non-ASCII
 *  character, so it travels in an HTTP header and a Playwright annotation as it is. */
export interface UiItem {
  id: string;
  kind: UiKind;
  /** `GET`, `POST`, …; `ANY` when the handler takes every method. */
  method?: string;
  /** The route pattern without the context path: `{name}` is one segment, `{*}` the rest. */
  route?: string;
  file: string;
  line: number;
  /** The user types something (a form with fields) or the request has a body (POST, PUT,
   *  PATCH): the item also needs an error-path test. */
  input: boolean;
  /** What a person sees: the id, name or text of the element, the handler, the route. */
  label: string;
}

export interface UiInventory {
  root: string;
  /** `/` or the servlet context path (from the sandbox scan). */
  contextPath: string;
  items: UiItem[];
  /** What the inventory saw but could not turn into an item (a link to no known route, a route
   *  built from a constant it could not read). */
  notes: string[];
  /** Why the inventory is not complete (a cap dropped items, the time ran out); ui-check fails when any. */
  truncated?: string[];
  /** The project has no UI source at all (no templates, no JS or TS files, no routes): an empty inventory is then the right one. */
  noUi?: true;
}

export const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Files `sandbox-run` writes into `out/<ts>/` for an e2e run and `ui-check` reads. */
export const ACCESS_LOG_FILE = 'access.log';
/** The per-test nonce `uiTest` sends as a request header and records as a Playwright annotation:
 *  `ui-check` joins a request to the one test that sent it by it (lib/sandbox-e2e.ts writes the
 *  fixture, lib/ui-check.ts reads both sides). */
export const NONCE_HEADER = 'x-goodboy-test';
export const NONCE_ANNOTATION = 'goodboy-test';
/** What a nonce looks like (the fixture makes 16 hex digits). */
export const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
export const PLAYWRIGHT_REPORT_FILE = 'playwright-report.json';

/** `/a//b/` → `/a/b`; the root stays `/`. */
export function normRoute(p: string): string {
  const s = `/${p}`.replace(/\/{2,}/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/** The segments of a route: a segment holding `{name}` or `{name:regex}` is one path variable. */
const VAR = /\{([^{}/]*(?::[^{}]*)?)\}/g;

/** A route written in any framework's style as the one pattern the inventory and the check share:
 *  `{id}`, `{id:\d+}`, `:id` (Express, react-router), `[id]` (Next) and `{}` (a template's
 *  `/x/${id}`) all keep a name or become `{}`; `[...slug]` and `**` become `{*}`, and so does a
 *  `*` segment when `starIsRest` (react-router splats; in a Spring ant pattern `*` is one segment). */
export function toPattern(raw: string, starIsRest = false): string {
  const parts = normRoute(raw.trim())
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      let m = /^\[\[?\.\.\.([\w-]*)\]?\]$/.exec(seg);
      if (m) return '{*}';
      if (seg === '**' || (starIsRest && seg === '*')) return '{*}';
      m = /^\{\*[\w.-]*\}$/.exec(seg);
      if (m) return '{*}';
      m = /^\[([\w-]+)\]$/.exec(seg);
      if (m) return `{${m[1]}}`;
      m = /^:([\w-]+)\*?\??$/.exec(seg);
      if (m) return seg.endsWith('*') ? '{*}' : `{${m[1]}}`;
      return seg.replace(VAR, (_all, inner: string) => {
        const name = inner.split(':')[0]!.trim();
        const conv = inner.includes(':') ? inner.slice(inner.indexOf(':') + 1).trim() : '';
        if (name.startsWith('*') || conv === 'path' || conv === '.*') return '{*}';
        return `{${name}}`;
      });
    });
  return `/${parts.join('/')}`;
}

/** One segment pattern, matched against a decoded path segment. `{name}` is one or more
 *  characters, `*` any number, `?` one; none of them matches a `/`. */
interface SegmentMatcher {
  /** The same for segments that mean the same (`{id}` and `{x}`), so a trie shares a node. */
  key: string;
  test(segment: string): boolean;
}

const WILD_ONE = '\u0001'; // one character (not `/`)
const WILD_ANY = '\u0002'; // any number of characters (not `/`)
const segmentCache = new Map<string, SegmentMatcher>();

/** A segment pattern as a matcher (one per distinct segment). A glob walk, not a regex: a regex
 *  with several wildcards (`[^/]+-[^/]+-…`) backtracks polynomially in their number; the walk
 *  keeps one place to go back to (the last `*`), so it is at most pattern x segment steps. */
function segmentMatcher(seg: string): SegmentMatcher {
  let m = segmentCache.get(seg);
  if (m) return m;
  let tokens = '';
  for (let i = 0; i < seg.length; i++) {
    const j = seg[i] === '{' ? seg.indexOf('}', i) : -1;
    if (j > 0) {
      tokens += WILD_ONE + WILD_ANY; // `[^/]+`
      i = j;
    } else if (seg[i] === '*') tokens += WILD_ANY;
    else if (seg[i] === '?') tokens += WILD_ONE;
    else tokens += seg[i];
  }
  tokens = tokens.replace(/\u0002{2,}/g, WILD_ANY); // `**` is `*`
  m = { key: tokens, test: (s) => globMatches(tokens, s) };
  if (segmentCache.size >= 10_000) segmentCache.clear();
  segmentCache.set(seg, m);
  return m;
}

function globMatches(tokens: string, s: string): boolean {
  let t = 0;
  let i = 0;
  let starT = -1; // the token after the last `*`, and where in `s` it was last tried
  let starI = 0;
  while (i < s.length) {
    const tok = t < tokens.length ? tokens[t] : undefined;
    if (tok === WILD_ANY) {
      starT = ++t;
      starI = i;
    } else if (tok !== undefined && s[i] !== '/' && (tok === WILD_ONE || tok === s[i])) {
      t++;
      i++;
    } else if (starT >= 0 && s[starI] !== '/') {
      t = starT; // let the last `*` take one more character
      i = ++starI;
    } else return false;
  }
  while (tokens[t] === WILD_ANY) t++;
  return t === tokens.length;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** The path of a request URI: no query, no fragment, no trailing slash, one slash between parts. */
export function pathOf(uri: string): string {
  const q = uri.search(/[?#]/);
  const p = q >= 0 ? uri.slice(0, q) : uri;
  const noOrigin = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return normRoute(noOrigin === '' ? '/' : noOrigin);
}

/** The path under the context path, or null when the path is outside it. */
export function underContext(path: string, contextPath: string): string | null {
  const ctx = contextPath === '/' || contextPath === '' ? '' : normRoute(contextPath);
  if (ctx === '') return path;
  if (path === ctx) return '/';
  return path.startsWith(`${ctx}/`) ? path.slice(ctx.length) : null;
}

/** Whether the request path (no context path, no query) is an instance of the route pattern. The
 *  reference implementation: nothing in lib/ calls it any more (they go through RouteIndex), and
 *  the tests check RouteIndex against it. */
export function routeMatches(pattern: string, path: string): boolean {
  // (One pattern against one path; many patterns go through RouteIndex.)
  const pat = normRoute(pattern).split('/').filter(Boolean);
  const got = normRoute(path).split('/').filter(Boolean).map(safeDecode);
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '{*}') return true; // the rest of the path, possibly empty
    if (i >= got.length) return false;
    if (!segmentMatcher(pat[i]!).test(got[i]!)) return false;
  }
  return got.length === pat.length;
}

interface RouteNode<T> {
  /** Segments with no `{`, `*` or `?`: looked up by text. */
  lit: Map<string, RouteNode<T>>;
  /** The other segments, one child per distinct matcher. */
  dyn: Map<string, { match: SegmentMatcher; node: RouteNode<T> }>;
  /** Values of patterns that end here. */
  end: T[];
  /** Values of patterns with a `{*}` here (the rest of the path, possibly empty). */
  rest: T[];
}

const newNode = <T>(): RouteNode<T> => ({ lit: new Map(), dyn: new Map(), end: [], rest: [] });

/** Route patterns as a trie, so the patterns that match one path are found by walking the path
 *  (cost: its segments times the few patterns that share a prefix), not by trying every pattern.
 *  `find` agrees with `routeMatches` on every pattern and path. */
export class RouteIndex<T = true> {
  private readonly root = newNode<T>();

  add(pattern: string, value: T): void {
    let n = this.root;
    for (const seg of normRoute(pattern).split('/').filter(Boolean)) {
      if (seg === '{*}') {
        n.rest.push(value);
        return;
      }
      if (/[{*?]/.test(seg)) {
        const match = segmentMatcher(seg);
        let d = n.dyn.get(match.key);
        if (!d) n.dyn.set(match.key, (d = { match, node: newNode<T>() }));
        n = d.node;
      } else {
        let c = n.lit.get(seg);
        if (!c) n.lit.set(seg, (c = newNode<T>()));
        n = c;
      }
    }
    n.end.push(value);
  }

  /** The values of the patterns the request path (no context path, no query) is an instance of. */
  find(path: string): T[] {
    const out: T[] = [];
    this.walk(path, (vs) => {
      out.push(...vs);
      return false;
    });
    return out;
  }

  has(path: string): boolean {
    return this.walk(path, () => true);
  }

  /** Visits the matching nodes' value lists; stops when `on` returns true. Iterative and each
   *  (node, depth) once, so neither a deep path nor many overlapping patterns blow it up. */
  private walk(path: string, on: (values: T[]) => boolean): boolean {
    const got = normRoute(path).split('/').filter(Boolean).map(safeDecode);
    const seen: Set<RouteNode<T>>[] = [];
    const stack: [RouteNode<T>, number][] = [[this.root, 0]];
    while (stack.length > 0) {
      const [n, i] = stack.pop()!;
      let visited = seen[i];
      if (!visited) seen[i] = visited = new Set();
      if (visited.has(n)) continue;
      visited.add(n);
      if (n.rest.length > 0 && on(n.rest)) return true;
      if (i === got.length) {
        if (n.end.length > 0 && on(n.end)) return true;
        continue;
      }
      const seg = got[i]!;
      const lit = n.lit.get(seg);
      if (lit) stack.push([lit, i + 1]);
      for (const d of n.dyn.values()) if (d.match.test(seg)) stack.push([d.node, i + 1]);
    }
    return false;
  }
}

/** Whether a request method serves an item's method. */
export const methodMatches = (item: string | undefined, req: string): boolean => item === undefined || item === 'ANY' || item.toUpperCase() === req.toUpperCase();

/** A claim `<id>:ok|error` split at its last colon; null when it has neither form. */
export function parseClaim(text: string): { id: string; kind: 'ok' | 'error' } | null {
  const m = /^(.+):(ok|error)$/.exec(text.trim());
  return m ? { id: m[1]!, kind: m[2] as 'ok' | 'error' } : null;
}
