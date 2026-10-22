// The UI inventory (track M, M3; plan §19): every screen, action and API of a project with an id
// that stays the same from run to run, so a browser test can claim what it covers
// (`x-goodboy-ui: <id>:ok`) and `ui-check` can tell what is left. Read-only: git lists the files
// (with the hook git settings), sources and templates are read with caps, nothing runs.
//
// Where the items come from:
//   Spring MVC     controller mappings (screens: GET handlers returning a view; APIs: bodies),
//                  static pages and JSPs under the web root
//   templates      forms, links to routes, buttons and AJAX calls in Thymeleaf/JSP/FreeMarker/HTML
//                  and in static JS
//   React / Next   Next pages and API routes, react-router paths, JSX clicks, submits and links,
//                  fetch/axios calls linked to API routes
//   Express, FastAPI  route calls and decorators (APIs; FastAPI HTML responses are screens)
// An id is `<sub>:<METHOD>:<route>` for routes (`screen`, `api`, `form`, `link`, `ajax`) and
// `<sub>:<file>#<label>` for elements with no route (`button`, `click`, `submit`).

import { join, posix } from 'node:path';
import { readRegular } from './safe-read';
import { readScan } from './sandbox-files';
import { listFiles, ownFile, scanSandbox } from './sandbox-scan';
import { type SrcFile, Sink, idOf } from './ui-scan-text';
import { expressRoutes, fastapiRoutes, jsxActions, nextRoutes, reactRoutes } from './ui-js';
import { springRoutes, stringConstants } from './ui-spring';
import { type Env, TEMPLATE_EXT, scanScript, scanTemplate } from './ui-templates';
import { type UiInventory, routeMatches, toPattern } from './ui-types';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 64_000_000;
const MAX_FILES = 20_000;

const JS_EXT = /\.(?:jsx?|tsx?|mjs|cjs)$/;
const STATIC_ROOTS = new Set(['static', 'public', 'assets', 'webapp', 'www', 'wwwroot']);

/** A static page the web server serves as it is: `static/*.html` and a JSP outside WEB-INF. */
function staticScreen(rel: string): string | null {
  const html = /(?:^|\/)src\/main\/resources\/(?:static|public|resources|META-INF\/resources)\/(.+\.html?)$/.exec(rel);
  if (html) return /(?:^|\/)index\.html?$/.test(html[1]!) ? posix.dirname(`/${html[1]!}`) : `/${html[1]!}`;
  const jsp = /(?:^|\/)src\/main\/webapp\/(.+\.jsp)$/.exec(rel);
  if (jsp && !jsp[1]!.split('/').includes('WEB-INF')) return `/${jsp[1]!}`;
  return null;
}

/** Node files that run on the server or by hand: their requests are not what a person does in the
 *  browser (an API route calling another service, a seed script). */
const SERVER_ONLY = /(?:^|\/)(?:scripts?|bin|tools|migrations?|seeds?)\/|(?:^|\/)route\.[cm]?[jt]s$|(?:^|\/)pages\/api\/|(?:^|\/)middleware\.[cm]?[jt]s$|\.config\.[cm]?[jt]s$/;

const isBrowserAsset = (rel: string): boolean => rel.split('/').slice(0, -1).some((d) => STATIC_ROOTS.has(d));

/** The context path from the sandbox scan: the saved one, or a fresh read-only scan. */
function contextPathOf(root: string): string {
  const saved = readScan(root);
  if (!(saved instanceof Error)) return saved.app.contextPath || '/';
  try {
    return scanSandbox(root).app.contextPath || '/';
  } catch {
    return '/';
  }
}

/** The inventory of the project at `root`. */
export function uiInventory(root: string): UiInventory {
  const sink = new Sink();
  const all = listFiles(root);
  if (all === null) {
    return { root, contextPath: '/', items: [], notes: ['the project is not a git repository, so its files cannot be listed'] };
  }
  const files: SrcFile[] = [];
  let total = 0;
  for (const rel of all.filter(ownFile).slice(0, MAX_FILES)) {
    const wanted = /\.(?:java|kt|py)$/.test(rel) || JS_EXT.test(rel) || TEMPLATE_EXT.test(rel) || posix.basename(rel) === 'package.json';
    if (!wanted) continue;
    const r = readRegular(join(root, rel), MAX_FILE_BYTES, true);
    if (typeof r !== 'object') continue;
    total += r.text.length;
    if (total > MAX_TOTAL_BYTES) {
      sink.note('the project has more source text than the inventory reads: the rest is not listed');
      break;
    }
    files.push({ rel, text: r.text });
  }
  if (all.length > MAX_FILES) sink.note(`the project has more than ${MAX_FILES} files: the inventory reads the first ${MAX_FILES}`);

  const jvm = files.filter((f) => /\.(?:java|kt)$/.test(f.rel));
  const js = files.filter((f) => JS_EXT.test(f.rel));
  const templates = files.filter((f) => TEMPLATE_EXT.test(f.rel));

  // 1. the routes the app serves
  springRoutes(jvm, stringConstants(jvm), sink);
  for (const f of templates) {
    const route = staticScreen(f.rel);
    if (route === null) continue;
    const pattern = toPattern(route);
    sink.route({ method: 'GET', pattern, file: f.rel, line: 1, kind: 'screen' });
    sink.add({ id: idOf('screen', 'GET', pattern), kind: 'screen', method: 'GET', route: pattern, file: f.rel, line: 1, input: false, label: `GET ${pattern} (${f.rel})` });
  }
  nextRoutes(files, sink);
  for (const f of js) if (!isBrowserAsset(f.rel)) reactRoutes(f, sink);
  expressRoutes(js, sink);
  fastapiRoutes(files, sink);

  // 2. what a person can do on those screens
  const contextPath = contextPathOf(root);
  const env: Env = {
    has: (pattern) => {
      const concrete = pattern.replace(/\{[^}]*\}/g, 'x');
      return sink.routes.some((r) => routeMatches(r.pattern, concrete));
    },
    ctx: contextPath,
  };
  for (const f of templates) scanTemplate(f, sink, env);
  for (const f of js) {
    if (/\.d\.ts$/.test(f.rel) || SERVER_ONLY.test(f.rel)) continue;
    const frontend = /\.(?:jsx|tsx)$/.test(f.rel) || /from\s+['"](?:react|next|vue|react-router|@angular)/.test(f.text);
    if (isBrowserAsset(f.rel) && !frontend) scanScript(f, sink, env, false);
    else if (frontend) jsxActions(f, sink, env);
    else scanScript(f, sink, env, false);
  }

  const items = [...sink.items.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { root, contextPath, items, notes: sink.notes };
}

/** `ui-inventory`: the inventory as JSON; `--summary` counts by kind. */
export function cmdUiInventory(root: string, args: string[]): { out: unknown; code: number } | { error: string } {
  const bad = args.find((a) => a !== '--summary');
  if (bad !== undefined) return { error: `ui-inventory: unknown option ${bad}; the only one is --summary` };
  const inv = uiInventory(root);
  if (args.includes('--summary')) {
    const count = (k: string) => inv.items.filter((i) => i.kind === k).length;
    return { out: { root: inv.root, contextPath: inv.contextPath, screens: count('screen'), actions: count('action'), apis: count('api'), input: inv.items.filter((i) => i.input).length, notes: inv.notes }, code: 0 };
  }
  return { out: inv, code: 0 };
}
