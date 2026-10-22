// Templates and scripts for the UI inventory (track M, M3; plan §19): the forms, links, buttons and
// AJAX calls a browser can trigger, found in Thymeleaf, JSP, FreeMarker and plain HTML templates,
// in inline `<script>` blocks and inline handlers, and in static JS. Each URL is turned into the
// route pattern the controllers use (context path removed, `${x}` and `+ x` becoming `{}`) so an
// action can be linked to its route. This is text matching, not a parser: what it cannot read
// becomes a note, never a guess.

import { BODY_METHODS, toPattern } from './ui-types';
import { type SrcFile, Sink, blankComments, findClose, idOf, makeLineOf, slug } from './ui-scan-text';
import { splitTop } from './ui-spring';

export const TEMPLATE_EXT = /\.(?:html?|jsp|jspx|jspf|ftlh?|vm|mustache|hbs|ejs|njk|jinja2?|j2|xhtml)$/i;
const ASSET_EXT = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|bmp|woff2?|ttf|eot|otf)$/i;
const NON_URL = /^(?:#|javascript:|mailto:|tel:|data:|sms:|blob:|about:)/i;
/** The first part of a URL that is the app's base (`${pageContext.request.contextPath}`, `${ctx}`,
 *  `<%=request.getContextPath()%>`, `[[@{/}]]`): the context path is removed from every route. */
const CONTEXT_EXPR = /^(?:\$\{[^}]*\}|<%=[^%]*%>|\[\[[^\]]*\]\]|\{\}|<c:url[^>]*>)/;

/** The route pattern a URL written in a template or script stands for, or null when it is not an
 *  internal path (external, relative, an asset, a `#`, a bare variable). */
export function urlPattern(raw: string, ctx = '/'): string | null {
  let v = raw.trim();
  if (v === '' || NON_URL.test(v)) return null;
  // `<c:url value="/x"/>` and `<spring:url value="/x" />` inside the value
  const cu = /<(?:c|spring):url\b[^>]*?\bvalue\s*=\s*(["'])(.*?)\1/i.exec(v);
  if (cu) v = cu[2]!;
  // Thymeleaf link expression `@{...}` and literal substitution `|...|`
  const th = /^@\{([\s\S]*)\}$/.exec(v);
  if (th) {
    v = th[1]!.trim();
    const params = findParams(v);
    if (params >= 0) v = v.slice(0, params);
    // `@{'/users/' + ${id}}`: a JavaScript-like concatenation
    if (/^["']/.test(v)) return exprPattern(v.replace(/\$\{[^}]*\}/g, 'v'), ctx);
  } else if (/^\|[\s\S]*\|$/.test(v)) v = v.slice(1, -1);
  v = v.replace(/^~/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.startsWith('//')) return null;
  // the leading base: a context variable or a dynamic part followed by `/`
  const lead = CONTEXT_EXPR.exec(v);
  if (lead && /^\//.test(v.slice(lead[0].length))) v = v.slice(lead[0].length);
  v = v.replace(/\$\{[^}]*\}|#\{[^}]*\}|\*\{[^}]*\}|<%=[^%]*%>|\[\[[^\]]*\]\]|<c:out[^>]*>/g, '{}');
  const q = v.search(/[?#]/);
  if (q >= 0) v = v.slice(0, q);
  if (!v.startsWith('/') || v === '/{}') return null;
  // a URL that spells the context path out (`/shop/orders` under `/shop`)
  if (ctx !== '/' && (v === ctx || v.startsWith(`${ctx}/`))) v = v.slice(ctx.length) || '/';
  if (ASSET_EXT.test(v)) return null;
  return toPattern(v);
}

/** The offset of the `(` that starts a Thymeleaf link's parameter list at its end, or -1. */
function findParams(v: string): number {
  if (!v.endsWith(')')) return -1;
  let depth = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    if (v[i] === ')') depth++;
    else if (v[i] === '(' && --depth === 0) return i;
  }
  return -1;
}

/** The route a JavaScript URL expression stands for: a literal, a template literal, or `+` of
 *  them and variables (a variable up front is the API base and is dropped). */
export function exprPattern(expr: string, ctx = '/'): string | null {
  const e = expr.trim();
  if (e === '') return null;
  const terms = splitTop(e, '+');
  let acc = '';
  let first = true;
  for (const t of terms) {
    const lit = /^(["'`])([\s\S]*)\1$/.exec(t);
    let part: string;
    if (lit) part = lit[1] === '`' ? lit[2]!.replace(/\$\{[^}]*\}/g, '{}') : lit[2]!;
    else if (/^[^\s"'`]+$/.test(t)) part = '{}';
    else return null;
    if (first && !lit) {
      // a variable up front is the base URL when a literal path follows
      const next = terms[1];
      if (next !== undefined && /^["'`]\//.test(next.trim())) {
        first = false;
        continue;
      }
    }
    acc += part;
    first = false;
  }
  return urlPattern(acc, ctx);
}

export interface JsCall {
  /** `ajax` for a request, `link` for a navigation. */
  sub: 'ajax' | 'link';
  method: string;
  expr: string;
  pos: number;
}

const VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** The text of property `name` in an object literal's text (`{ url: '/x', type: 'POST' }`). */
function propOf(obj: string, name: string): string | null {
  const t = obj.trim();
  if (!t.startsWith('{')) return null;
  for (const part of splitTop(t.slice(1, -1))) {
    const m = new RegExp(`^["']?${name}["']?\\s*:\\s*([\\s\\S]*)$`).exec(part);
    if (m) return m[1]!.trim();
  }
  return null;
}

function methodIn(text: string): string | null {
  const m = /\b(?:method|type)\s*:\s*(["'`])(\w+)\1/i.exec(text);
  return m ? m[2]!.toUpperCase() : null;
}

/** The first argument of the call whose `(` is at `open`, and the text of the rest. */
function callArgs(code: string, open: number): { first: string; rest: string } | null {
  const close = findClose(code, open);
  if (close < 0) return null;
  const args = splitTop(code.slice(open + 1, close));
  return { first: args[0] ?? '', rest: args.slice(1).join(',') };
}

/** The requests and navigations in JavaScript text (comments already blanked). */
export function jsCalls(code: string, withRouter = false): JsCall[] {
  const out: JsCall[] = [];
  const push = (sub: JsCall['sub'], method: string, expr: string, pos: number) => out.push({ sub, method, expr, pos });
  const re = /(?<![\w$])(fetch|axios(?:\.\w+)?|(?:\$|jQuery)\.(?:ajax|get|post|put|delete|patch|getJSON)|useSWR|(?:\w+\.)?open|location\.(?:assign|replace)|window\.open|router\.(?:push|replace)|history\.(?:push|replace)|navigate)\s*\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const name = m[1]!;
    const open = m.index + m[0].length - 1;
    const a = callArgs(code, open);
    if (!a) continue;
    if (name === 'fetch') push('ajax', methodIn(a.rest) ?? 'GET', a.first, m.index);
    else if (name === 'useSWR') push('ajax', 'GET', a.first, m.index);
    else if (name.startsWith('axios')) {
      const verb = name.split('.')[1];
      if (verb && VERBS.has(verb)) push('ajax', verb.toUpperCase(), a.first, m.index);
      else if (verb === undefined || verb === 'request') {
        const url = propOf(a.first, 'url');
        if (url) push('ajax', methodIn(a.first) ?? 'GET', url, m.index);
      }
    } else if (name.endsWith('.ajax')) {
      const url = propOf(a.first, 'url') ?? (/^["'`]/.test(a.first) ? a.first : null);
      if (url) push('ajax', methodIn(a.first) ?? methodIn(a.rest) ?? 'GET', url, m.index);
    } else if (/^(?:\$|jQuery)\./.test(name)) {
      const verb = name.split('.')[1]!;
      push('ajax', verb === 'getJSON' ? 'GET' : verb.toUpperCase(), a.first, m.index);
    } else if (name.endsWith('open') && !name.startsWith('window')) {
      // xhr.open('POST', url)
      const parts = splitTop(code.slice(open + 1, findClose(code, open)));
      const v = /^["'`](\w+)["'`]$/.exec(parts[0] ?? '');
      if (v && VERBS.has(v[1]!.toLowerCase()) && parts[1] !== undefined) push('ajax', v[1]!.toUpperCase(), parts[1], m.index);
    } else if (name === 'window.open' || name.startsWith('location.')) push('link', 'GET', a.first, m.index);
    else if (withRouter && (name.startsWith('router.') || name.startsWith('history.') || name === 'navigate')) push('link', 'GET', a.first, m.index);
  }
  for (const m of code.matchAll(/(?<![\w$.])(?:window\.|document\.)?location(?:\.href)?\s*=(?!=)\s*([^;\n]+)/g)) push('link', 'GET', m[1]!.replace(/[\s})]+$/, ''), m.index!);
  return out;
}

export interface Env {
  /** Whether the app serves a route that this path pattern (variables as `{}`) is an instance of. */
  has(pattern: string): boolean;
  /** The context path (`/` for none): a URL that spells it out loses it. */
  ctx: string;
}

/** Turns the calls found in `code` into items; `lineOf` gives the line of an offset in it. */
export function addCalls(calls: JsCall[], file: string, lineOf: (pos: number) => number, sink: Sink, env: Env): void {
  for (const c of calls) {
    const pattern = exprPattern(c.expr, env.ctx);
    if (pattern === null) {
      // a literal path that is an asset or an absolute URL is no item; anything else is a note
      if (!/^["'`]\s*(?:\/|https?:)/.test(c.expr.trim())) sink.note(`${file}:${lineOf(c.pos)} ${c.sub === 'ajax' ? 'request' : 'navigation'} to ${c.expr.trim().slice(0, 60)} is not a path it can read`);
      continue;
    }
    if (!env.has(pattern)) {
      sink.note(`${file}:${lineOf(c.pos)} ${c.method} ${pattern} matches no route of the app: not an item`);
      continue;
    }
    const method = c.sub === 'link' ? 'GET' : c.method;
    sink.add({
      id: idOf(c.sub, method, pattern),
      kind: 'action',
      method,
      route: pattern,
      file,
      line: lineOf(c.pos),
      input: BODY_METHODS.has(method),
      label: `${c.sub === 'ajax' ? 'request' : 'navigate'} ${method} ${pattern}`,
    });
  }
}

// ---- HTML-ish templates ----

interface Tag {
  name: string;
  attrs: Map<string, string>;
  start: number;
  end: number;
}

const TAG_RE = /<([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
const EVENT_ATTRS = /^(?:th:)?on[a-z]+$|^(?:@click|v-on:click|x-on:click|ng-click|\(click\))$/i;
const SPRING_FIELD = /^\w+:(?:input|password|select|textarea|checkbox|checkboxes|radiobutton|radiobuttons)$/i;
const NON_FIELD_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function tagsOf(html: string): Tag[] {
  const tags: Tag[] = [];
  for (const m of html.matchAll(TAG_RE)) {
    const attrs = new Map<string, string>();
    for (const a of m[2]!.matchAll(ATTR_RE)) {
      const key = a[1]!.toLowerCase();
      if (key === '/') continue;
      const val = a[2] === undefined ? '' : a[2].replace(/^(["'])([\s\S]*)\1$/, '$2');
      if (!attrs.has(key)) attrs.set(key, val);
    }
    tags.push({ name: m[1]!.toLowerCase(), attrs, start: m.index!, end: m.index! + m[0].length });
  }
  return tags;
}

const attrOf = (t: Tag, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = t.attrs.get(n);
    if (v !== undefined) return v;
  }
  return undefined;
};

/** A label for an item: `x` made of letters and digits, from a Thymeleaf message key, an
 *  expression or plain text. */
function cleanLabel(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x[0-9a-f]+;|&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\$\{[^}]*\}|\[\[[^\]]*\]\]/g, ' ')
    .replace(/[#{}'"|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function innerText(html: string, t: Tag): string {
  const close = new RegExp(`</${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i').exec(html.slice(t.end, t.end + 400));
  const raw = html.slice(t.end, t.end + (close ? close.index : 120));
  return cleanLabel(raw);
}

/** The name of the function an inline handler calls (`openModal(1)` → `openModal`). */
function handlerName(events: [string, string][]): string {
  for (const [, v] of events) {
    const m = /(?:^|[;{\s])(?:return\s+)?([A-Za-z_$][\w$.]*)\s*\(/.exec(v);
    if (m && !/^(?:if|for|while|function|confirm|alert|event|return)$/.test(m[1]!)) return m[1]!;
  }
  return '';
}

/** The label of a button-like element: what a person reads, else what the page calls it. Icon-only
 *  buttons fall back to their handler, their data attribute, their icon or their class, so their id
 *  does not depend on how many buttons come before them. */
function labelOf(html: string, t: Tag, events: [string, string][]): string {
  const own = attrOf(t, 'id', 'name', 'th:id', 'th:name');
  if (own && cleanLabel(own) !== '') return cleanLabel(own);
  const text = t.name === 'input' ? '' : innerText(html, t);
  if (text !== '') return text;
  for (const k of ['th:text', 'th:utext', 'value', 'th:value', 'title', 'aria-label', 'data-testid']) {
    const v = attrOf(t, k);
    if (v && cleanLabel(v) !== '') return cleanLabel(v);
  }
  const handler = cleanLabel(handlerName(events));
  if (handler !== '') return handler;
  for (const k of ['data-bs-target', 'data-target', 'data-action', 'data-role', 'formaction', 'data-bs-toggle', 'data-toggle']) {
    const v = attrOf(t, k);
    if (v && cleanLabel(v) !== '') return cleanLabel(v);
  }
  const icon = /<(?:i|span|svg)\b[^>]*\bclass\s*=\s*["']([^"']+)["']/i.exec(html.slice(t.end, t.end + 200));
  if (icon && cleanLabel(icon[1]!) !== '') return cleanLabel(icon[1]!);
  const cls = (attrOf(t, 'class') ?? '').split(/\s+/).filter((c) => c !== '' && !/^btn(?:-|$)/.test(c)).join(' ');
  return cls !== '' ? cleanLabel(cls) : t.name;
}

/** Forms, links, buttons and the scripts of one template. */
export function scanTemplate(f: SrcFile, sink: Sink, env: Env): void {
  const html = blankComments(f.text, 'html');
  const lineOf = makeLineOf(html);
  const tags = tagsOf(html);
  const seen = new Map<string, number>();
  type FormSpan = { start: number; end: number };
  const forms: FormSpan[] = [];

  for (const t of tags) {
    if (t.name !== 'form' && !t.name.endsWith(':form')) continue;
    const closeAt = new RegExp(`</${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i').exec(html.slice(t.end));
    const end = closeAt ? t.end + closeAt.index : Math.min(html.length, t.end + 4000);
    forms.push({ start: t.start, end });
    const inner = tags.filter((x) => x.start >= t.end && x.start < end);
    const hasFields = inner.some((x) => {
      if (x.name === 'input') return !NON_FIELD_TYPES.has((attrOf(x, 'type') ?? 'text').toLowerCase());
      return x.name === 'select' || x.name === 'textarea' || SPRING_FIELD.test(x.name);
    });
    let method = (attrOf(t, 'method', 'th:method') ?? 'GET').toUpperCase().replace(/[^A-Z]/g, '') || 'GET';
    const override = inner.find((x) => x.name === 'input' && (attrOf(x, 'name') ?? '') === '_method');
    const ov = override ? (attrOf(override, 'value') ?? '').toUpperCase() : '';
    if (/^(?:PUT|PATCH|DELETE)$/.test(ov)) method = ov;
    const action = attrOf(t, 'th:action', 'action');
    // no action, `#` or `javascript:`: the form posts to its own page
    const self = action === undefined || action.trim() === '' || /^(?:#|javascript:)/i.test(action.trim());
    const route = self ? null : urlPattern(action, env.ctx);
    if (!self && route === null) {
      sink.note(`${f.rel}:${lineOf(t.start)} form action ${action.trim().slice(0, 60)} is not an internal path it can read: not an item`);
      continue;
    }
    const label = cleanLabel(attrOf(t, 'id', 'name', 'th:object', 'modelattribute', 'commandname') ?? '') || method;
    const input = hasFields || BODY_METHODS.has(method);
    if (route !== null) sink.add({ id: idOf('form', method, route), kind: 'action', method, route, file: f.rel, line: lineOf(t.start), input, label: `form ${method} ${route}` });
    else sink.addUnique({ id: `form:${f.rel}#${slug(label)}`, kind: 'action', method, file: f.rel, line: lineOf(t.start), input, label: `form ${label} (no action: posts to its own page)` }, seen);
  }
  const inForm = (t: Tag) => forms.some((s) => t.start > s.start && t.start < s.end);

  for (const t of tags) {
    const href = t.name === 'a' || t.name === 'area' ? attrOf(t, 'th:href', 'href') : undefined;
    let linked = false;
    if (href !== undefined) {
      const pattern = urlPattern(href, env.ctx);
      if (pattern !== null) {
        linked = true;
        if (env.has(pattern)) sink.add({ id: idOf('link', 'GET', pattern), kind: 'action', method: 'GET', route: pattern, file: f.rel, line: lineOf(t.start), input: false, label: `link ${pattern}` });
        else sink.note(`${f.rel}:${lineOf(t.start)} link ${pattern} matches no route of the app: not an item`);
      }
    }
    const events = [...t.attrs].filter(([k]) => EVENT_ATTRS.test(k));
    const isButton = (t.name === 'button' && (attrOf(t, 'type') ?? '').toLowerCase() !== 'reset') || (t.name === 'input' && /^(?:submit|button|image)$/i.test(attrOf(t, 'type') ?? ''));
    const submitType = (attrOf(t, 'type') ?? (t.name === 'button' ? 'submit' : '')).toLowerCase() === 'submit' || (t.name === 'input' && (attrOf(t, 'type') ?? '').toLowerCase() === 'image');
    const hasClick = events.some(([k]) => /click/i.test(k));
    const needsItem = !linked && (isButton || hasClick);
    if (needsItem && !(isButton && inForm(t) && submitType && !hasClick)) {
      const label = labelOf(html, t, events);
      const handler = events.map(([, v]) => v).join(' ');
      const nav = jsCalls(blankComments(handler, 'c')).find((c) => c.sub === 'link');
      const pattern = nav ? exprPattern(nav.expr, env.ctx) : null;
      const route = pattern !== null && env.has(pattern) ? pattern : undefined;
      sink.addUnique({ id: `button:${f.rel}#${slug(label)}`, kind: 'action', method: route ? 'GET' : undefined, route, file: f.rel, line: lineOf(t.start), input: false, label }, seen);
    }
    for (const [, v] of events) {
      if (v.trim() === '') continue;
      addCalls(jsCalls(blankComments(thymeleafUrls(v), 'c')), f.rel, () => lineOf(t.start), sink, env);
    }
  }

  // inline <script> blocks
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]!) || m[2]!.trim() === '') continue;
    const bodyStart = m.index! + m[0].indexOf('>') + 1;
    const code = blankComments(thymeleafUrls(m[2]!), 'c');
    const inner = makeLineOf(code);
    const first = lineOf(bodyStart);
    addCalls(jsCalls(code), f.rel, (p) => first + inner(p) - 1, sink, env);
  }
}

/** Requests and navigations in one static JavaScript file. */
export function scanScript(f: SrcFile, sink: Sink, env: Env, withRouter = false): void {
  const code = blankComments(f.text, 'c');
  addCalls(jsCalls(code, withRouter), f.rel, makeLineOf(code), sink, env);
}

/** Thymeleaf's natural-template idiom `/*[[@{/x}]]*\/ '/x'` and a bare `[[@{/x}]]` as a string literal. */
function thymeleafUrls(text: string): string {
  return text
    .replace(/\/\*\[\[(@\{[^\]]*\})\]\]\*\/\s*(?:'[^'\n]*'|"[^"\n]*")?/g, "'$1'")
    .replace(/\[\[(@\{[^\]]*\})\]\]/g, "'$1'");
}
