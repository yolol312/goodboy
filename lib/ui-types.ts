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
}

export const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Files `sandbox-run` writes into `out/<ts>/` for an e2e run and `ui-check` reads. */
export const ACCESS_LOG_FILE = 'access.log';
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One segment pattern as a regex over a decoded path segment. */
function segmentRe(seg: string): RegExp {
  let out = '';
  let i = 0;
  while (i < seg.length) {
    if (seg[i] === '{') {
      const j = seg.indexOf('}', i);
      if (j > 0) {
        out += '[^/]+';
        i = j + 1;
        continue;
      }
    }
    if (seg[i] === '*') out += '[^/]*';
    else if (seg[i] === '?') out += '[^/]';
    else out += escapeRe(seg[i]!);
    i++;
  }
  return new RegExp(`^${out}$`);
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

/** Whether the request path (no context path, no query) is an instance of the route pattern. */
export function routeMatches(pattern: string, path: string): boolean {
  const pat = normRoute(pattern).split('/').filter(Boolean);
  const got = normRoute(path).split('/').filter(Boolean).map(safeDecode);
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '{*}') return true; // the rest of the path, possibly empty
    if (i >= got.length) return false;
    if (!segmentRe(pat[i]!).test(got[i]!)) return false;
  }
  return got.length === pat.length;
}

/** Whether a request method serves an item's method. */
export const methodMatches = (item: string | undefined, req: string): boolean => item === undefined || item === 'ANY' || item.toUpperCase() === req.toUpperCase();

/** A claim `<id>:ok|error` split at its last colon; null when it has neither form. */
export function parseClaim(text: string): { id: string; kind: 'ok' | 'error' } | null {
  const m = /^(.+):(ok|error)$/.exec(text.trim());
  return m ? { id: m[1]!, kind: m[2] as 'ok' | 'error' } : null;
}
