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
// `<sub>:<file>#<label>` for elements with no route (`button`, `click`, `submit`); the file part
// is percent-encoded when it holds a character an id cannot (a space, a non-ASCII letter).
//
// The inventory is linear in the text it reads: routes are matched through a trie, brackets and
// tags are matched once per file, and a wall-time budget (`opts.budgetMs`) stops it with a note.
// It reads the files the sandbox scan reads (`ownFile` of lib/test-survey.ts: the coverage gate's
// `notOwnCode` also drops config and story files, which are read here). A cut is never a pass: what
// it leaves out because it cannot read it, or because a cap or the time ran out, goes into
// `truncated` (ui-check fails on any), and an empty inventory passes ui-check only when it says the
// project has no UI source at all (`noUi`).

import { join, posix } from 'node:path';
import { readRegular } from './safe-read';
import { readScan } from './sandbox-files';
import { scanSandbox } from './sandbox-scan';
import { isBrowserAsset, listFiles, MAX_FILES, notOwnReason, ownFile } from './test-survey';
import { type SrcFile, Sink, bounded, idOf } from './ui-scan-text';
import { expressRoutes, fastapiRoutes, jsxActions, nextRoutes, reactRoutes } from './ui-js';
import { springRoutes, stringConstants } from './ui-spring';
import { type Env, TEMPLATE_EXT, scanScript, scanTemplate } from './ui-templates';
import { RouteIndex, type UiInventory, toPattern } from './ui-types';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 64_000_000;
/** Wall time for a whole inventory; past it the files not read yet are left out, with a note. */
const INVENTORY_BUDGET_MS = 60_000;

/** What the inventory reads as JavaScript: exactly these. Vue and Svelte single-file components are
 *  not a supported stack (track M), and the JS readers would make items of them that the UI gate
 *  would then demand tests for; lib/test-survey.ts's wider set is for its own survey. */
const JS_EXT = /\.(?:jsx?|tsx?|mjs|cjs)$/;

/** A `{name}` in a route pattern (bounded: see PLACEHOLDER_MAX). */
const PATTERN_VARIABLE = bounded(/\{[^}]{0,N}\}/g);

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

/** The context path from the sandbox scan: the saved one, else a scan that reads the build and
 *  config files from the file list the inventory already has (not the sources, and no second
 *  `git ls-files`). */
function contextPathOf(root: string, listed: string[]): string {
  const saved = readScan(root);
  if (!(saved instanceof Error)) return saved.app.contextPath || '/';
  try {
    return scanSandbox(root, { files: listed, sources: false }).app.contextPath || '/';
  } catch {
    return '/';
  }
}

/** The inventory of the project at `root`. */
export function uiInventory(root: string, opts: { budgetMs?: number } = {}): UiInventory {
  const deadline = Date.now() + (opts.budgetMs ?? INVENTORY_BUDGET_MS);
  const sink = new Sink();
  const all = listFiles(root);
  if (all === null) {
    // (no git, git failing, its 30 s limit): nothing was listed, which is not "nothing to list"
    sink.incomplete('the project is not a git repository, or git cannot list its files: no file was read');
    return { root, contextPath: '/', items: [], notes: sink.notes, truncated: sink.truncated };
  }
  const own = all.filter(ownFile);
  noteLeftOut(all, sink);
  let late = false;
  /** Whether the time is up (the first time it is, a note says so). */
  const timeUp = (): boolean => {
    if (!late && Date.now() > deadline) {
      late = true;
      sink.incomplete('the inventory ran out of its time budget: the files after that point are not listed');
    }
    return late;
  };
  const files: SrcFile[] = [];
  let total = 0;
  for (const rel of own.slice(0, MAX_FILES)) {
    const wanted = /\.(?:java|kt|py)$/.test(rel) || JS_EXT.test(rel) || TEMPLATE_EXT.test(rel) || posix.basename(rel) === 'package.json';
    if (!wanted) continue;
    if (timeUp()) break;
    const r = readRegular(join(root, rel), MAX_FILE_BYTES, true);
    if (r === 'absent') continue; // listed but gone
    if (r === 'refused') {
      // Not read is not the same as nothing in it: a 1.2 MB controller would give no routes and ui-check would pass.
      sink.incomplete(`${rel} was not read (over ${MAX_FILE_BYTES / 1024} KB, not a regular file, or unreadable): its routes and actions are not listed; split it, or name a bundle *.min.* or *.bundle.* to leave it out`);
      continue;
    }
    total += r.text.length;
    if (total > MAX_TOTAL_BYTES) {
      sink.incomplete('the project has more source text than the inventory reads: the rest is not listed');
      break;
    }
    files.push({ rel, text: r.text });
  }
  if (own.length > MAX_FILES) sink.incomplete(`the project has more than ${MAX_FILES} own files: the inventory reads the first ${MAX_FILES}`);

  const jvm = files.filter((f) => /\.(?:java|kt)$/.test(f.rel));
  const js = files.filter((f) => JS_EXT.test(f.rel));
  const templates = files.filter((f) => TEMPLATE_EXT.test(f.rel));
  noteUnreadFrameworks(files, sink);

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
  const contextPath = contextPathOf(root, all);
  // The routes as a trie, once: every link and call site asks whether a route serves it, and a
  //   scan of the whole route list per question made the inventory quadratic.
  const index = new RouteIndex();
  for (const r of sink.routes) index.add(r.pattern, true);
  const answers = new Map<string, boolean>();
  const env: Env = {
    has: (pattern) => {
      let a = answers.get(pattern);
      if (a === undefined) {
        // a `{name}` in the pattern is some segment text: `x`
        answers.set(pattern, (a = index.has(pattern.replace(PATTERN_VARIABLE, 'x'))));
      }
      return a;
    },
    ctx: contextPath,
  };
  for (const f of templates) {
    if (timeUp()) break;
    scanTemplate(f, sink, env);
  }
  for (const f of js) {
    if (timeUp()) break;
    if (/\.d\.ts$/.test(f.rel) || SERVER_ONLY.test(f.rel)) continue;
    const frontend = /\.(?:jsx|tsx)$/.test(f.rel) || /from\s+['"](?:react|next|vue|react-router|@angular)/.test(f.text);
    if (isBrowserAsset(f.rel) && !frontend) scanScript(f, sink, env, false);
    else if (frontend) jsxActions(f, sink, env);
    else scanScript(f, sink, env, false);
  }

  const items = [...sink.items.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // No UI source at all: nothing to list is the answer, not a failure of the reading.
  const noUi = items.length === 0 && sink.truncated.length === 0 && templates.length === 0 && js.length === 0 && sink.routes.length === 0;
  return { root, contextPath, items, notes: sink.notes, ...(sink.truncated.length > 0 ? { truncated: sink.truncated } : {}), ...(noUi ? { noUi: true } : {}) };
}

/** The web frameworks the inventory does not read, by a marker in a source file: Flask, Django, JAX-RS
 *  and Quarkus, Micronaut, Ktor and Spring WebFlux. A project that serves routes through one has UI
 *  the inventory cannot list, so `truncated` says "framework not read" (ui-check fails) instead of
 *  leaving the inventory empty and `noUi` true. Plain `includes` checks, a few per file. */
function unreadFramework(f: SrcFile): string | null {
  const t = f.text;
  if (f.rel.endsWith('.py')) {
    if (t.includes('Blueprint(') || decoratedRoute(t)) return 'Flask';
    if (posix.basename(f.rel) === 'urls.py' && t.includes('urlpatterns')) return 'Django';
    return null;
  }
  if (!/\.(?:java|kt)$/.test(f.rel)) return null;
  if (t.includes('io.micronaut')) return t.includes('@Controller') || t.includes('@Get(') || t.includes('@Post(') ? 'Micronaut' : null;
  if (t.includes('@Path(') || t.includes('@Path ')) return 'JAX-RS (Quarkus, Jersey, RESTEasy)';
  if (t.includes('io.ktor') && /\brouting\s*\{/.test(t)) return 'Ktor'; // (`routing`, blanks, `{`: linear)
  if (t.includes('RouterFunction')) return 'Spring WebFlux functional routes';
  return null;
}

/** Whether a line of the text is a decorator `@x.route(` (Flask), found without a regex over the text:
 *  the first 20 places `.route(` stands are looked at. */
function decoratedRoute(t: string): boolean {
  let at = t.indexOf('.route(');
  for (let n = 0; at >= 0 && n < 20; n++, at = t.indexOf('.route(', at + 1)) {
    if (t.slice(t.lastIndexOf('\n', at) + 1, at).trimStart().startsWith('@')) return true;
  }
  return false;
}

/** One `truncated` entry per framework not read, with an example file. */
function noteUnreadFrameworks(files: SrcFile[], sink: Sink): void {
  const seen = new Map<string, string>();
  for (const f of files) {
    const name = unreadFramework(f);
    if (name !== null && !seen.has(name)) seen.set(name, f.rel);
  }
  for (const [name, rel] of seen) sink.incomplete(`framework not read: ${name} (for example ${rel}): its routes are not listed`);
}

/** A note on the source files `ownFile` leaves out (tests, build output, vendored code, libraries
 *  under a static root), so that a file taken for a library is seen: dependency and tool dirs are
 *  not counted, they are never the project's. */
function noteLeftOut(all: string[], sink: Sink): void {
  const byReason = new Map<string, { n: number; first: string }>();
  for (const rel of all) {
    if (!/\.(?:java|kt|py)$/.test(rel) && !JS_EXT.test(rel) && !TEMPLATE_EXT.test(rel)) continue;
    const why = notOwnReason(rel);
    if (why === null || why === 'dependency and tool dirs') continue;
    const e = byReason.get(why);
    if (e) e.n++;
    else byReason.set(why, { n: 1, first: rel });
  }
  if (byReason.size === 0) return;
  sink.note(`source files left out of the inventory: ${[...byReason].map(([why, e]) => `${e.n} as ${why} (for example ${e.first})`).join('; ')}`);
}

/** `ui-inventory`: the inventory as JSON; `--summary` counts by kind. */
export function cmdUiInventory(root: string, args: string[]): { out: unknown; code: number } | { error: string } {
  const bad = args.find((a) => a !== '--summary');
  if (bad !== undefined) return { error: `ui-inventory: unknown option ${bad}; the only one is --summary` };
  const inv = uiInventory(root);
  if (args.includes('--summary')) {
    const count = (k: string) => inv.items.filter((i) => i.kind === k).length;
    return { out: { root: inv.root, contextPath: inv.contextPath, screens: count('screen'), actions: count('action'), apis: count('api'), input: inv.items.filter((i) => i.input).length, notes: inv.notes, truncated: inv.truncated ?? [], noUi: inv.noUi === true }, code: 0 };
  }
  return { out: inv, code: 0 };
}
