// Node and Python routes and React actions for the UI inventory (track M, M3; plan §19): Next
// `pages/` and `app/` routes and API routes, react-router `<Route path>` and
// `createBrowserRouter([...])` paths, the JSX elements a user clicks or submits, Express routes
// and FastAPI routes. Source text is read with comments blanked; a route it cannot read is a note.

import { posix } from 'node:path';
import { BODY_METHODS, normRoute, toPattern } from './ui-types';
import { type SrcFile, Sink, blankComments, findClose, idOf, makeLineOf, skipString, slug } from './ui-scan-text';
import { splitTop } from './ui-spring';
import { type Env, addCalls, jsCalls, urlPattern } from './ui-templates';

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const PAGE_EXT = /\.(?:tsx|ts|jsx|js|mdx?)$/;

const dirOf = (rel: string): string => (posix.dirname(rel) === '.' ? '' : posix.dirname(rel));

/** Dirs whose package.json depends on `dep`. */
function packageDirs(files: SrcFile[], dep: string): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (posix.basename(f.rel) !== 'package.json') continue;
    try {
      const j = JSON.parse(f.text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (j.dependencies?.[dep] !== undefined || j.devDependencies?.[dep] !== undefined) out.push(dirOf(f.rel));
    } catch {
      // not JSON
    }
  }
  return out;
}

function addRoute(sink: Sink, kind: 'screen' | 'api', method: string, route: string, file: string, line: number, label: string): void {
  sink.route({ method, pattern: route, file, line, kind });
  sink.add({ id: idOf(kind, method, route), kind, method, route, file, line, input: false, label });
}

// ---- Next ----

function verbsIn(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g)) set.add(m[1] ?? m[2]!);
  return [...set];
}

function methodsOfPagesApi(text: string): string[] {
  const set = new Set<string>();
  for (const m of text.matchAll(/\bmethod\s*(?:===?|!==?)\s*["'](\w+)["']|\bcase\s+["'](GET|POST|PUT|DELETE|PATCH)["']\s*:/g)) {
    const v = (m[1] ?? m[2]!).toUpperCase();
    if (HTTP_VERBS.includes(v)) set.add(v);
  }
  return set.size > 0 ? [...set] : ['ANY'];
}

export function nextRoutes(files: SrcFile[], sink: Sink): void {
  const roots = packageDirs(files, 'next');
  if (roots.length === 0) return;
  for (const f of files) {
    if (!PAGE_EXT.test(f.rel)) continue;
    const root = roots.filter((r) => r === '' || f.rel.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
    if (root === undefined) continue;
    const inRoot = root === '' ? f.rel : f.rel.slice(root.length + 1);
    const base = posix.basename(inRoot);
    const stem = base.replace(PAGE_EXT, '');
    const pages = /^(?:src\/)?pages\/(.+)$/.exec(inRoot);
    const app = /^(?:src\/)?app\/(.+)$/.exec(inRoot);
    if (pages) {
      const parts = pages[1]!.replace(PAGE_EXT, '').split('/');
      if (parts.some((p) => p.startsWith('_')) || ['404', '500'].includes(parts[parts.length - 1]!) || /\.(?:d|test|spec)$/.test(stem)) continue;
      if (parts[parts.length - 1] === 'index') parts.pop();
      const api = parts[0] === 'api';
      const route = toPattern(`/${parts.join('/')}`);
      const code = blankComments(f.text, 'c');
      if (api) for (const v of methodsOfPagesApi(code)) addRoute(sink, 'api', v, route, f.rel, 1, `${v} ${route} (${f.rel})`);
      else addRoute(sink, 'screen', 'GET', route, f.rel, 1, `GET ${route} (${f.rel})`);
    } else if (app) {
      const dirs = dirOf(app[1]!).split('/').filter(Boolean);
      if (dirs.some((d) => d.startsWith('_') || /^\(\.+\)/.test(d))) continue;
      const segs = dirs.filter((d) => !/^\(.*\)$/.test(d) && !d.startsWith('@'));
      const route = toPattern(`/${segs.join('/')}`);
      if (/^page$/.test(stem) && /\.(?:tsx|jsx|js|ts)$/.test(base)) addRoute(sink, 'screen', 'GET', route, f.rel, 1, `GET ${route} (${f.rel})`);
      else if (/^route$/.test(stem) && /\.(?:ts|js)$/.test(base)) {
        const code = blankComments(f.text, 'c');
        const verbs = verbsIn(code);
        for (const v of verbs.length > 0 ? verbs : ['ANY']) addRoute(sink, 'api', v, route, f.rel, 1, `${v} ${route} (${f.rel})`);
      }
    }
  }
}

// ---- JSX ----

interface JsxOpen {
  name: string;
  attrs: Map<string, string>;
  /** Attribute value kinds: a `"string"` keeps its text, an `{expression}` keeps `{…}`. */
  start: number;
  end: number;
  selfClosing: boolean;
}

/** The opening tag at `start` (`<Name …>`), or null when it is not JSX. */
function jsxOpen(code: string, start: number): JsxOpen | null {
  const m = /^<([A-Za-z][\w.]*)(?=[\s/>])/.exec(code.slice(start, start + 120));
  if (!m) return null;
  const attrs = new Map<string, string>();
  let i = start + m[0].length;
  while (i < code.length) {
    while (i < code.length && /\s/.test(code[i]!)) i++;
    const c = code[i];
    if (c === undefined) return null;
    if (c === '>') return { name: m[1]!, attrs, start, end: i + 1, selfClosing: false };
    if (c === '/' && code[i + 1] === '>') return { name: m[1]!, attrs, start, end: i + 2, selfClosing: true };
    if (c === '{') {
      const e = findClose(code, i); // {...spread}
      if (e < 0) return null;
      i = e + 1;
      continue;
    }
    const am = /^[\w:.@-]+/.exec(code.slice(i, i + 80));
    if (!am) return null;
    i += am[0].length;
    let j = i;
    while (j < code.length && /\s/.test(code[j]!)) j++;
    if (code[j] !== '=') {
      attrs.set(am[0], 'true');
      continue;
    }
    j++;
    while (j < code.length && /\s/.test(code[j]!)) j++;
    const v = code[j];
    if (v === '"' || v === "'") {
      const e = skipString(code, j);
      attrs.set(am[0], code.slice(j + 1, e - 1));
      i = e;
    } else if (v === '{') {
      const e = findClose(code, j);
      if (e < 0) return null;
      attrs.set(am[0], code.slice(j, e + 1));
      i = e + 1;
    } else return null;
  }
  return null;
}

/** The text value of an attribute: a string, `{'string'}` or `{`template`}`; null otherwise. */
function attrText(v: string | undefined): string | null {
  if (v === undefined) return null;
  if (!v.startsWith('{')) return v;
  const inner = v.slice(1, -1).trim();
  const lit = /^(["'`])([\s\S]*)\1$/.exec(inner);
  return lit ? (lit[1] === '`' ? lit[2]!.replace(/\$\{[^}]*\}/g, '{}') : lit[2]!) : null;
}

function jsxText(code: string, o: JsxOpen): string {
  const lt = code.indexOf('<', o.end);
  const raw = code.slice(o.end, lt < 0 ? o.end + 80 : Math.min(lt, o.end + 120));
  return raw.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function handlerName(v: string | undefined): string {
  if (v === undefined) return '';
  const inner = v.replace(/^\{|\}$/g, '').trim();
  const direct = /^(?:this\.)?(?:props\.)?([A-Za-z_$][\w$]*)$/.exec(inner);
  if (direct) return direct[1]!;
  const call = /=>\s*\{?\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(inner);
  return call ? call[1]! : '';
}

const FIELD_JSX = /<(?:input|select|textarea)\b|<[A-Z]\w*(?:Input|Field|Select|TextArea|Textarea|Checkbox|Radio|Switch)\b/;

/** The elements of a React file a user clicks, submits or follows. */
export function jsxActions(f: SrcFile, sink: Sink, env: Env): void {
  const code = blankComments(f.text, 'c');
  if (!/<[A-Za-z]/.test(code)) return;
  const lineOf = makeLineOf(code);
  const seen = new Map<string, number>();
  for (let i = code.indexOf('<'); i >= 0; i = code.indexOf('<', i + 1)) {
    const o = jsxOpen(code, i);
    if (!o) continue;
    const line = lineOf(i);
    const link = o.name === 'a' || o.name === 'Link' || o.name === 'NavLink' ? attrText(o.attrs.get('to') ?? o.attrs.get('href')) : null;
    const pattern = link === null ? null : urlPattern(link, env.ctx);
    if (pattern !== null) {
      if (env.has(pattern)) sink.add({ id: idOf('link', 'GET', pattern), kind: 'action', method: 'GET', route: pattern, file: f.rel, line, input: false, label: `link ${pattern}` });
      else sink.note(`${f.rel}:${line} link ${pattern} matches no route of the app: not an item`);
      continue;
    }
    if (o.name === 'form') {
      const action = attrText(o.attrs.get('action'));
      const method = (attrText(o.attrs.get('method')) ?? 'GET').toUpperCase();
      const close = code.indexOf('</form>', o.end);
      const hasFields = FIELD_JSX.test(code.slice(o.end, close < 0 ? o.end + 4000 : close));
      const route = action === null ? null : urlPattern(action, env.ctx);
      if (route !== null) {
        sink.add({ id: idOf('form', method, route), kind: 'action', method, route, file: f.rel, line, input: hasFields || BODY_METHODS.has(method), label: `form ${method} ${route}` });
        continue;
      }
    }
    const submit = o.name === 'form' && o.attrs.has('onSubmit');
    if (!submit && !o.attrs.has('onClick')) continue;
    const handler = handlerName(o.attrs.get(submit ? 'onSubmit' : 'onClick'));
    const own = o.attrs.get('id') ?? o.attrs.get('data-testid') ?? o.attrs.get('name') ?? o.attrs.get('aria-label');
    const cls = (attrText(o.attrs.get('className')) ?? '').split(/\s+/).filter((c) => c !== '' && !/^btn(?:-|$)/.test(c)).join(' ');
    const label = [attrText(own) ?? '', jsxText(code, o), handler, cls, o.name].find((x) => x.trim() !== '' && !/[{}]/.test(x)) ?? o.name;
    let input = false;
    if (submit) {
      const close = code.indexOf('</form>', o.end);
      input = FIELD_JSX.test(code.slice(o.end, close < 0 ? o.end + 4000 : close));
    }
    sink.addUnique({ id: `${submit ? 'submit' : 'click'}:${f.rel}#${slug(label)}`, kind: 'action', file: f.rel, line, input, label: `${submit ? 'submit' : 'click'} ${label}` }, seen);
  }
  addCalls(jsCalls(code, true), f.rel, lineOf, sink, env);
}

// ---- react-router ----

/** react-router: a child path that starts with `/` is absolute, else it is under its parent. */
const joinPath = (parent: string, own: string): string => (own.startsWith('/') ? own : `${parent === '/' ? '' : parent}/${own}`);
/** Express and FastAPI: a mount prefix and a path always concatenate. */
const concat = (prefix: string, path: string): string => normRoute(`${prefix}/${path}`);

export function reactRoutes(f: SrcFile, sink: Sink): void {
  if (!/\bRoute\b|createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|RouteObject/.test(f.text)) return;
  const code = blankComments(f.text, 'c');
  const lineOf = makeLineOf(code);
  const emit = (path: string, line: number) => {
    const route = toPattern(path, true);
    addRoute(sink, 'screen', 'GET', route, f.rel, line, `GET ${route} (${f.rel})`);
  };
  // <Route path="..."> nesting
  const stack: string[] = [];
  const re = /<(\/?)Route\b/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[1] === '/') {
      stack.pop();
      continue;
    }
    const o = jsxOpen(code, m.index);
    if (!o) continue;
    const parent = stack[stack.length - 1] ?? '/';
    const own = attrText(o.attrs.get('path'));
    const full = own === null || own === '' ? parent : own === '*' ? parent : joinPath(parent, own);
    if (own !== '*' && (own !== null || o.attrs.has('index'))) emit(full, lineOf(m.index));
    if (!o.selfClosing) stack.push(own === '*' ? parent : full);
  }
  // route objects: createBrowserRouter([...]) and `RouteObject[] = [...]`
  const arrays = [...code.matchAll(/(?:create(?:Browser|Hash|Memory)Router|useRoutes|createRoutesFromElements)\s*\(\s*\[|RouteObject\[\]\s*=\s*\[/g)];
  for (const a of arrays) {
    const open = a.index! + a[0].length - 1;
    routeArray(code, open, '/', lineOf, emit);
  }
}

function routeArray(code: string, open: number, parent: string, lineOf: (p: number) => number, emit: (path: string, line: number) => void): void {
  const close = findClose(code, open);
  if (close < 0) return;
  const inner = code.slice(open + 1, close);
  let from = 0;
  for (const el of splitTop(inner)) {
    const at = inner.indexOf(el, from);
    from = at + el.length;
    if (!el.startsWith('{')) continue;
    const body = el.slice(1, -1);
    let path: string | null = null;
    let isIndex = false;
    let children: { text: string; at: number } | null = null;
    let propFrom = 0;
    for (const prop of splitTop(body)) {
      const pat = body.indexOf(prop, propFrom);
      propFrom = pat + prop.length;
      const pm = /^(\w+)\s*:\s*([\s\S]*)$/.exec(prop);
      if (!pm) continue;
      if (pm[1] === 'path') path = attrText(`{${pm[2]!.trim()}}`);
      else if (pm[1] === 'index') isIndex = /^true$/.test(pm[2]!.trim());
      else if (pm[1] === 'children' && pm[2]!.trim().startsWith('[')) children = { text: pm[2]!, at: open + 1 + at + 1 + pat + prop.indexOf('[') };
    }
    const full = path === null || path === '' || path === '*' ? parent : joinPath(parent, path);
    if (path !== '*' && (path !== null || isIndex)) emit(full, lineOf(open + 1 + at));
    if (children) routeArray(code, children.at, full, lineOf, emit);
  }
}

// ---- Express ----

/** The files an Express router is mounted from: `app.use('/api', usersRouter)` with the router
 *  imported from a relative file, one level and nested. */
export function expressRoutes(files: SrcFile[], sink: Sink): void {
  const express = files.filter((f) => /\bfrom\s+['"]express['"]|\brequire\(\s*['"]express['"]\s*\)/.test(f.text));
  if (express.length === 0) return;
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = posix.join(dirOf(from), spec);
    for (const c of [base, ...['.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'].map((e) => base + e), ...['index.ts', 'index.js'].map((i) => posix.join(base, i))]) if (byRel.has(c)) return c;
    return null;
  };
  const prefixes = new Map<string, string>();
  for (let round = 0; round < 3; round++) {
    for (const f of express) {
      const code = blankComments(f.text, 'c');
      const imports = new Map<string, string>();
      for (const m of code.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]|(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const target = resolve(f.rel, m[2] ?? m[4]!);
        if (target) imports.set((m[1] ?? m[3])!, target);
      }
      for (const m of code.matchAll(/\b\w+\.use\(\s*(["'`])([^"'`]+)\1\s*,\s*(\w+)\s*\)/g)) {
        const target = imports.get(m[3]!);
        if (target) prefixes.set(target, concat(prefixes.get(f.rel) ?? '/', m[2]!));
      }
    }
  }
  for (const f of express) {
    const code = blankComments(f.text, 'c');
    const lineOf = makeLineOf(code);
    const prefix = prefixes.get(f.rel) ?? '/';
    for (const m of code.matchAll(/\b(\w+)\.(get|post|put|delete|patch|all)\(\s*(["'`])([^"'`]+)\3/g)) {
      if (!/^(?:app|router|\w*[rR]outer|\w*[rR]outes?|api|server)$/.test(m[1]!)) continue;
      if (!m[4]!.startsWith('/')) continue;
      const verb = m[2] === 'all' ? 'ANY' : m[2]!.toUpperCase();
      const route = toPattern(concat(prefix, m[4]!));
      addRoute(sink, 'api', verb, route, f.rel, lineOf(m.index!), `${verb} ${route} (${f.rel})`);
    }
  }
}

// ---- FastAPI ----

interface PyRouter {
  file: string;
  name: string;
  prefix: string;
}

export function fastapiRoutes(files: SrcFile[], sink: Sink): void {
  const py = files.filter((f) => /\.py$/.test(f.rel) && /\bfastapi\b/i.test(f.text));
  if (py.length === 0) return;
  const routers: PyRouter[] = [];
  const includes: { file: string; arg: string; prefix: string }[] = [];
  const codes = new Map<string, string>();
  for (const f of py) {
    const code = blankComments(f.text, 'py');
    codes.set(f.rel, code);
    for (const m of code.matchAll(/^(\w+)\s*=\s*APIRouter\(([^)]*)\)/gm)) routers.push({ file: f.rel, name: m[1]!, prefix: /prefix\s*=\s*["']([^"']*)["']/.exec(m[2]!)?.[1] ?? '' });
    for (const m of code.matchAll(/\.include_router\(\s*([\w.]+)([^)]*)\)/g)) includes.push({ file: f.rel, arg: m[1]!, prefix: /prefix\s*=\s*["']([^"']*)["']/.exec(m[2]!)?.[1] ?? '' });
  }
  const includePrefix = (r: PyRouter): string => {
    const inc = includes.find((i) => {
      const parts = i.arg.split('.');
      const name = parts[parts.length - 1]!;
      if (parts.length > 1) return name === r.name && posix.basename(r.file, '.py') === parts[parts.length - 2];
      return name === r.name && i.file === r.file;
    }) ?? includes.find((i) => i.arg === r.name || i.arg.endsWith(`_${r.name}`) || i.arg.startsWith(`${posix.basename(r.file, '.py')}_`));
    return inc?.prefix ?? '';
  };
  for (const f of py) {
    const code = codes.get(f.rel)!;
    const lineOf = makeLineOf(code);
    for (const m of code.matchAll(/^[ \t]*@(\w+)\.(get|post|put|delete|patch|head|options)\(\s*(["'])([^"']*)\3([^\n]*)/gm)) {
      const router = routers.find((r) => r.file === f.rel && r.name === m[1]!);
      const prefix = router ? concat(includePrefix(router), router.prefix) : '';
      const route = toPattern(concat(prefix, m[4]!));
      const verb = m[2]!.toUpperCase();
      // the function body: up to the next decorator or top-level statement
      const rest = code.slice(m.index! + m[0].length);
      const def = /\n(?:async\s+)?def\s[^\n]*\n/.exec(rest);
      const afterDef = def ? def.index + def[0].length : 0;
      const next = rest.slice(afterDef).search(/\n(?=[@A-Za-z_])/);
      const body = rest.slice(0, next < 0 ? undefined : afterDef + next);
      const html = verb === 'GET' && (/response_class\s*=\s*HTMLResponse/.test(m[5]!) || /TemplateResponse|HTMLResponse\(|render_template\(/.test(body));
      addRoute(sink, html ? 'screen' : 'api', verb, route, f.rel, lineOf(m.index!), `${verb} ${route} (${f.rel})`);
    }
  }
}

