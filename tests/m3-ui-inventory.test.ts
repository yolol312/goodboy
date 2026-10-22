// Track M, M3 (plan §19): the UI inventory. Fixture projects are built in temp dirs: a Spring
// Thymeleaf app, a Spring JSP app, a Next app, a react-router app, an Express app and a FastAPI app.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdUiInventory, uiInventory } from '../lib/ui-inventory';
import { blankComments, slug } from '../lib/ui-scan-text';
import { exprPattern, urlPattern } from '../lib/ui-templates';
import { pathOf, routeMatches, toPattern, underContext } from '../lib/ui-types';
import type { UiItem } from '../lib/ui-types';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m3-')));
  tmpDirs.push(root);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const byId = (items: UiItem[], id: string): UiItem | undefined => items.find((i) => i.id === id);
const ids = (items: UiItem[]): string[] => items.map((i) => i.id);

const BUILD_GRADLE = `plugins {
  id 'org.springframework.boot' version '3.2.0'
  id 'java'
}
dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web'
  implementation 'org.springframework.boot:spring-boot-starter-thymeleaf'
}
`;

function thymeleafApp(): Record<string, string> {
  return {
    'build.gradle': BUILD_GRADLE,
    gradlew: '#!/bin/sh\n',
    'settings.gradle': "rootProject.name = 'shop'\n",
    'src/main/resources/application.yml': 'server:\n  port: 8080\n  servlet:\n    context-path: /shop\n',
    'src/main/java/com/acme/Paths.java': `package com.acme;
public final class Paths {
  public static final String API = "/api";
  public static final String ORDERS_API = API + "/orders";
}
`,
    'src/main/java/com/acme/OrderController.java': `package com.acme;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;

// @GetMapping("/commented") String nope() { return "x"; }
@Controller
@RequestMapping("/orders")
public class OrderController {
  @GetMapping
  public String list(Model model) { return "orders/list"; }

  @GetMapping("/{id}")
  public String show(@PathVariable Long id, @RequestParam(required = false) String q) { return "orders/show"; }

  @GetMapping(value = {"/new", "/create"})
  public String form() { return "orders/new"; }

  @PostMapping("/save")
  public String save(@Valid @ModelAttribute OrderForm form, BindingResult result) { return "redirect:/orders"; }

  @RequestMapping(value = "/{id}/cancel", method = RequestMethod.POST)
  public String cancel(@PathVariable Long id) { return "redirect:/orders"; }

  @GetMapping("/export")
  @ResponseBody
  public byte[] export() { return new byte[0]; }

  @GetMapping("/profile")
  public ModelAndView profile() { return new ModelAndView("orders/profile"); }
}
`,
    'src/main/java/com/acme/OrderApi.java': `package com.acme;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(Paths.ORDERS_API)
public class OrderApi {
  @GetMapping
  public List<String> all() { return null; }

  @PostMapping("/{id}/notes")
  public ResponseEntity<Void> note(@PathVariable Long id, @RequestBody String text) { return null; }

  @RequestMapping(value = "/legacy", method = {RequestMethod.GET, RequestMethod.POST})
  public String legacy() { return "ok"; }
}
`,
    'src/main/resources/templates/orders/list.html': `<!DOCTYPE html>
<html xmlns:th="http://www.thymeleaf.org">
<body>
  <!-- <a th:href="@{/orders/commented}">gone</a> -->
  <a th:href="@{/orders/new}">New order</a>
  <a th:href="@{/orders/{id}(id=\${o.id})}" th:each="o : \${orders}">Open</a>
  <a th:href="@{/orders/new}">New order again</a>
  <a href="https://example.com/docs">External</a>
  <a th:href="@{/nowhere}">Dead</a>
  <a href="#top">Top</a>
  <button type="button" id="refresh">Refresh</button>
  <button type="button" name="notes">Add a note</button>
  <button type="button">저장</button>
  <div onclick="location.href='/shop/orders/profile'">Profile</div>
  <script th:inline="javascript">
    $('#refresh').on('click', function () {
      $.ajax({ url: /*[[@{/api/orders/7/notes}]]*/ '/api/orders/7/notes', type: 'POST', data: {} });
      $.get('/shop/api/orders');
    });
  </script>
</body>
</html>
`,
    'src/main/resources/templates/orders/new.html': `<html xmlns:th="http://www.thymeleaf.org">
<body>
  <form th:action="@{/orders/save}" method="post" th:object="\${form}">
    <input type="text" name="title">
    <input type="hidden" name="_csrf" value="x">
    <button type="submit">Save</button>
  </form>
  <form th:action="@{/orders/7/cancel}" method="post">
    <input type="hidden" name="_csrf" value="x">
    <button type="submit">Cancel order</button>
  </form>
  <form th:action="@{/orders}" method="get">
    <select name="state"><option>open</option></select>
    <button type="submit">Filter</button>
  </form>
  <form th:action="@{/login}" method="post"><input name="username"><input name="password"></form>
</body>
</html>
`,
    'src/main/resources/static/js/orders.js': `function cancel(id) {
  fetch('/shop/api/orders/' + id + '/notes', { method: 'POST', body: '{}' });
}
function nav() { window.location = '/shop/orders'; }
`,
    'src/main/resources/static/help.html': '<html><body><a href="/shop/orders">Orders</a></body></html>\n',
  };
}

describe('Spring controllers', () => {
  test('GET view handlers are screens, with the class prefix, path arrays, variables and the context path', () => {
    const inv = uiInventory(repo(thymeleafApp()));
    expect(inv.contextPath).toBe('/shop');
    const screens = inv.items.filter((i) => i.kind === 'screen').map((i) => i.id);
    expect(screens).toEqual(
      expect.arrayContaining(['screen:GET:/orders', 'screen:GET:/orders/{id}', 'screen:GET:/orders/new', 'screen:GET:/orders/create', 'screen:GET:/orders/profile', 'screen:GET:/help.html']),
    );
    expect(screens).not.toContain('screen:GET:/orders/commented');
    expect(screens).not.toContain('screen:GET:/orders/export');
    const show = byId(inv.items, 'screen:GET:/orders/{id}')!;
    expect(show).toMatchObject({ kind: 'screen', method: 'GET', route: '/orders/{id}', file: 'src/main/java/com/acme/OrderController.java', input: false });
    expect(show.line).toBe(byId(inv.items, 'screen:GET:/orders/{id}')!.line);
  });

  test('bodies are APIs: @ResponseBody, @RestController, constants in the prefix, RequestMapping methods', () => {
    const inv = uiInventory(repo(thymeleafApp()));
    const apis = inv.items.filter((i) => i.kind === 'api').map((i) => i.id);
    expect(apis).toEqual(
      expect.arrayContaining(['api:GET:/orders/export', 'api:GET:/api/orders', 'api:POST:/api/orders/{id}/notes', 'api:GET:/api/orders/legacy', 'api:POST:/api/orders/legacy']),
    );
    expect(byId(inv.items, 'api:POST:/api/orders/{id}/notes')!.input).toBe(false);
  });

  test('a form target (a non-GET view handler) is no item of its own', () => {
    const inv = uiInventory(repo(thymeleafApp()));
    expect(ids(inv.items).some((i) => i.includes('/orders/save') && i.startsWith('screen'))).toBe(false);
    expect(ids(inv.items).some((i) => i.startsWith('api:POST:/orders/save'))).toBe(false);
  });

  test('a path it cannot read is a note, not a guess', () => {
    const files = thymeleafApp();
    files['src/main/java/com/acme/Odd.java'] = `package com.acme;
import org.springframework.stereotype.Controller;
@Controller
public class Odd {
  @GetMapping(Elsewhere.PATH)
  public String odd() { return "odd"; }
}
`;
    const inv = uiInventory(repo(files));
    expect(inv.notes.some((n) => n.includes('Odd.java') && n.includes('not a literal'))).toBe(true);
  });
});

describe('Thymeleaf templates', () => {
  const inv = () => uiInventory(repo(thymeleafApp()));

  test('a form with fields: its method, its action route and input true; hidden inputs and submit buttons are no fields', () => {
    const items = inv().items;
    const save = byId(items, 'form:POST:/orders/save')!;
    expect(save).toMatchObject({ kind: 'action', method: 'POST', route: '/orders/save', file: 'src/main/resources/templates/orders/new.html', input: true });
    expect(byId(items, 'form:GET:/orders')).toMatchObject({ method: 'GET', input: true });
    // a POST with only a CSRF field still has a body: it needs an error path too
    expect(byId(items, 'form:POST:/orders/7/cancel')!.input).toBe(true);
    // a form to a route no controller maps (Spring Security's login) stays an item
    expect(byId(items, 'form:POST:/login')).toBeDefined();
  });

  test('a submit button inside a form is the form, not a second item', () => {
    const items = inv().items;
    expect(ids(items).filter((i) => i.startsWith('button:') && i.includes('new.html'))).toEqual([]);
  });

  test('links to routes of the app, once however many pages carry them; external, anchors and unknown routes are no items', () => {
    const inv0 = inv();
    const links = ids(inv0.items).filter((i) => i.startsWith('link:'));
    expect(links).toEqual(expect.arrayContaining(['link:GET:/orders/new', 'link:GET:/orders/{id}', 'link:GET:/orders']));
    expect(links.filter((l) => l === 'link:GET:/orders/new')).toHaveLength(1);
    expect(links.some((l) => l.includes('example.com') || l.includes('commented') || l.includes('top'))).toBe(false);
    expect(links).not.toContain('link:GET:/nowhere');
    expect(inv0.notes.some((n) => n.includes('/nowhere'))).toBe(true);
  });

  test('buttons are labelled by id, name or text; Korean text gets a stable ASCII slug', () => {
    const items = inv().items;
    const file = 'src/main/resources/templates/orders/list.html';
    expect(byId(items, `button:${file}#refresh`)).toMatchObject({ kind: 'action', label: 'refresh', input: false });
    expect(byId(items, `button:${file}#notes`)).toBeDefined();
    const korean = ids(items).find((i) => i.startsWith(`button:${file}#u`));
    expect(korean).toMatch(/^button:[\x21-\x7e]+$/);
    expect(inv().items.find((i) => i.id === korean)!.label).toBe('저장');
  });

  test('an element with onclick is an action; its location.href is linked to the route', () => {
    const items = inv().items;
    const profile = ids(items).find((i) => i.includes('list.html#profile'))!;
    expect(byId(items, profile)).toMatchObject({ kind: 'action', route: '/orders/profile', method: 'GET' });
  });

  test('AJAX calls in inline scripts and static JS are linked to their routes, the context path removed', () => {
    const items = inv().items;
    expect(byId(items, 'ajax:POST:/api/orders/7/notes')).toMatchObject({ kind: 'action', method: 'POST', route: '/api/orders/7/notes', input: true });
    expect(byId(items, 'ajax:GET:/api/orders')).toMatchObject({ kind: 'action', method: 'GET', input: false });
    // `'/shop/api/orders/' + id + '/notes'` from static JS: the context path is not an app route, so no match
    expect(ids(items).some((i) => i.startsWith('ajax:POST:/shop'))).toBe(false);
    expect(byId(items, 'link:GET:/orders')).toMatchObject({ kind: 'action' });
  });

  test('ids are the same on a second run and in a different order of creation', () => {
    const a = uiInventory(repo(thymeleafApp()));
    const files = Object.fromEntries(Object.entries(thymeleafApp()).reverse());
    const b = uiInventory(repo(files));
    expect(ids(a.items)).toEqual(ids(b.items));
    expect(ids(a.items)).toEqual([...ids(a.items)].sort());
    for (const i of a.items) expect(i.id).toMatch(/^[\x21-\x7e]+$/);
    for (const i of a.items) expect(i.id).not.toMatch(/[,;\s]/);
  });

  test('an unrelated file added to the project does not change an id', () => {
    const a = uiInventory(repo(thymeleafApp()));
    const files = thymeleafApp();
    files['src/main/java/com/acme/Other.java'] = 'package com.acme;\npublic class Other {}\n';
    files['src/main/resources/templates/about.html'] = '<html><body><button type="button" id="refresh">x</button></body></html>\n';
    const b = uiInventory(repo(files));
    for (const id of ids(a.items)) expect(ids(b.items)).toContain(id);
  });
});

describe('JSP', () => {
  const jsp = (): Record<string, string> => ({
    'pom.xml': `<project><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>b</artifactId><version>1</version>
<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent>
<dependencies><dependency><groupId>org.apache.tomcat.embed</groupId><artifactId>tomcat-embed-jasper</artifactId></dependency></dependencies></project>
`,
    'src/main/java/com/acme/UserController.java': `package com.acme;
@Controller
public class UserController {
  @RequestMapping(value = "/users", method = RequestMethod.GET)
  public String list() { return "users/list"; }
  @GetMapping("/users/new")
  public String form() { return "users/form"; }
  @PostMapping("/users/save")
  public String save() { return "redirect:/users"; }
}
`,
    'src/main/webapp/WEB-INF/views/users/list.jsp': `<%@ page contentType="text/html" %>
<%-- <a href="\${pageContext.request.contextPath}/users/hidden">x</a> --%>
<a href="\${pageContext.request.contextPath}/users/new">Add</a>
<form action="<c:url value='/users/save'/>" method="post"><input name="name"/><input type="submit" value="Go"/></form>
<form:form action="\${ctx}/users/save" method="post" modelAttribute="user"><form:input path="name"/></form:form>
<input type="button" value="Reload" onclick="location.reload()"/>
<script>
  $.post('\${pageContext.request.contextPath}/users/save', {});
</script>
`,
    'src/main/webapp/index.jsp': '<a href="<%=request.getContextPath()%>/users">Users</a>\n',
    'src/main/webapp/WEB-INF/views/users/form.jsp': '<h1>Form</h1>\n',
  });

  test('controller screens, JSP forms, links and AJAX with the contextPath expressions removed', () => {
    const inv = uiInventory(repo(jsp()));
    const all = ids(inv.items);
    expect(all).toEqual(expect.arrayContaining(['screen:GET:/users', 'screen:GET:/users/new', 'screen:GET:/index.jsp', 'link:GET:/users/new', 'link:GET:/users', 'form:POST:/users/save', 'ajax:POST:/users/save']));
    expect(all).not.toContain('link:GET:/users/hidden');
    expect(byId(inv.items, 'form:POST:/users/save')).toMatchObject({ kind: 'action', input: true });
    expect(all.some((i) => i.startsWith('screen:GET:/WEB-INF'))).toBe(false);
    expect(ids(inv.items).some((i) => i.includes('Reload') || i.includes('reload'))).toBe(true);
  });
});

describe('Next and React', () => {
  const next = (): Record<string, string> => ({
    'package.json': JSON.stringify({ dependencies: { next: '14.2.0', react: '18.2.0' } }),
    'pages/index.tsx': 'export default function Home() { return <a href="/orders/1">Order</a>; }\n',
    'pages/orders/[id].tsx': 'export default function Order() { return <CancelButton />; }\n',
    'pages/orders/index.tsx': 'export default function Orders() { return null; }\n',
    'pages/help/[...slug].tsx': 'export default function Docs() { return null; }\n',
    'pages/_app.tsx': 'export default function App() { return null; }\n',
    'pages/404.tsx': 'export default function NotFound() { return null; }\n',
    'pages/api/orders.ts': `export default function handler(req, res) {
  if (req.method === 'POST') return res.json({});
  return res.json([]);
}
`,
    'app/dashboard/page.tsx': 'export default function Dash() { return null; }\n',
    'app/(shop)/cart/page.tsx': 'export default function Cart() { return null; }\n',
    'app/_private/page.tsx': 'export default function P() { return null; }\n',
    'app/api/ping/route.ts': 'export async function GET() { return Response.json({}); }\nexport async function POST() { return Response.json({}); }\n',
    'components/CancelButton.tsx': `import Link from 'next/link';
export function CancelButton({ id }) {
  async function handleCancel() {
    await fetch(\`/api/orders\`, { method: 'POST' });
    await fetch('/api/ping');
  }
  return (
    <div>
      <button onClick={handleCancel}>Cancel order</button>
      <Link href="/orders">Back</Link>
      <form onSubmit={save}><input name="note" /><button>Send</button></form>
      <button onClick={() => router.push('/dashboard')} id="go-dash">Dashboard</button>
    </div>
  );
}
`,
  });

  test('pages, dynamic segments, route groups and API routes', () => {
    const inv = uiInventory(repo(next()));
    const all = ids(inv.items);
    expect(all).toEqual(
      expect.arrayContaining(['screen:GET:/', 'screen:GET:/orders', 'screen:GET:/orders/{id}', 'screen:GET:/help/{*}', 'screen:GET:/dashboard', 'screen:GET:/cart', 'api:POST:/api/orders', 'api:GET:/api/ping', 'api:POST:/api/ping']),
    );
    expect(all.some((i) => i.includes('_app') || i.includes('404') || i.includes('_private') || i.includes('(shop)'))).toBe(false);
    expect(all).not.toContain('api:GET:/api/orders');
  });

  test('JSX clicks, submits, links and fetch calls linked to the API routes', () => {
    const inv = uiInventory(repo(next()));
    const all = ids(inv.items);
    expect(all).toContain('click:components/CancelButton.tsx#cancel-order');
    expect(all).toContain('click:components/CancelButton.tsx#go-dash');
    expect(all.some((i) => i.includes('#send'))).toBe(false);
    expect(byId(inv.items, 'submit:components/CancelButton.tsx#save')!.input).toBe(true);
    expect(all).toContain('link:GET:/orders');
    expect(byId(inv.items, 'ajax:POST:/api/orders')).toMatchObject({ kind: 'action', route: '/api/orders', input: true });
    expect(all).toContain('ajax:GET:/api/ping');
    expect(all).toContain('link:GET:/dashboard');
  });

  test('react-router: <Route> nesting, index routes and createBrowserRouter objects', () => {
    const inv = uiInventory(
      repo({
        'package.json': JSON.stringify({ dependencies: { react: '18', 'react-router-dom': '6' } }),
        'src/App.tsx': `import { Routes, Route } from 'react-router-dom';
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/users" element={<Layout />}>
        <Route index element={<Users />} />
        <Route path=":id" element={<User />} />
        <Route path=":id/edit" element={<Edit />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
`,
        'src/router.tsx': `import { createBrowserRouter } from 'react-router-dom';
export const router = createBrowserRouter([
  { path: '/', element: <Root />, children: [
    { index: true, element: <Index /> },
    { path: 'settings', element: <Settings />, children: [{ path: 'profile', element: <Profile /> }] },
  ] },
  { path: '/reports/:year', element: <Reports /> },
]);
`,
      }),
    );
    const screens = ids(inv.items).filter((i) => i.startsWith('screen:'));
    expect(screens).toEqual(
      expect.arrayContaining(['screen:GET:/', 'screen:GET:/users', 'screen:GET:/users/{id}', 'screen:GET:/users/{id}/edit', 'screen:GET:/settings', 'screen:GET:/settings/profile', 'screen:GET:/reports/{year}']),
    );
    expect(screens.some((s) => s.includes('*'))).toBe(false);
  });
});

describe('Express and FastAPI', () => {
  test('Express routes with the prefix of the file that mounts the router', () => {
    const inv = uiInventory(
      repo({
        'package.json': JSON.stringify({ dependencies: { express: '4' } }),
        'src/server.js': `const express = require('express');
const users = require('./routes/users');
const app = express();
app.use('/api/users', users);
app.get('/health', (req, res) => res.send('ok'));
`,
        'src/routes/users.js': `const router = require('express').Router();
router.get('/', list);
router.post('/:id/reset', reset);
module.exports = router;
`,
      }),
    );
    expect(ids(inv.items)).toEqual(expect.arrayContaining(['api:GET:/health', 'api:GET:/api/users', 'api:POST:/api/users/{id}/reset']));
  });

  test('FastAPI routes with router prefixes and include_router prefixes; an HTML response is a screen', () => {
    const inv = uiInventory(
      repo({
        'requirements.txt': 'fastapi\nuvicorn\n',
        'app/main.py': `from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from app.routers import items
app = FastAPI()
app.include_router(items.router, prefix="/v1")

@app.get("/", response_class=HTMLResponse)
def home():
    return "<h1>hi</h1>"

@app.get("/health")
def health():
    return {"ok": True}
`,
        'app/routers/items.py': `from fastapi import APIRouter
router = APIRouter(prefix="/items")

# @router.get("/commented")
@router.get("/{item_id}")
def read(item_id: int):
    return {}

@router.post("")
def create():
    return {}

@router.get("/page")
def page(request):
    return templates.TemplateResponse("page.html", {"request": request})
`,
      }),
    );
    expect(ids(inv.items)).toEqual(expect.arrayContaining(['screen:GET:/', 'api:GET:/health', 'api:GET:/v1/items/{item_id}', 'api:POST:/v1/items', 'screen:GET:/v1/items/page']));
    expect(ids(inv.items).some((i) => i.includes('commented'))).toBe(false);
  });
});

describe('the inventory command and limits', () => {
  test('ui-inventory prints the inventory, --summary counts by kind, an unknown option is an error', () => {
    const root = repo(thymeleafApp());
    const r = cmdUiInventory(root, []);
    expect('out' in r && (r.out as { items: unknown[] }).items.length).toBeGreaterThan(10);
    const s = cmdUiInventory(root, ['--summary']);
    expect('out' in s && (s.out as { screens: number; apis: number }).screens).toBeGreaterThan(3);
    expect(cmdUiInventory(root, ['--bogus'])).toEqual({ error: expect.stringContaining('--bogus') });
  });

  test('a directory that is not a git repository gives an empty inventory with a note', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m3-nogit-')));
    tmpDirs.push(root);
    const inv = uiInventory(root);
    expect(inv.items).toEqual([]);
    expect(inv.notes[0]).toContain('not a git repository');
  });

  test('a project with no UI has no items', () => {
    expect(uiInventory(repo({ 'README.md': 'x\n', 'src/util.ts': 'export const x = 1;\n' })).items).toEqual([]);
  });
});

describe('route helpers', () => {
  test('toPattern keeps names and turns each style of variable into one', () => {
    expect(toPattern('/users/{id}')).toBe('/users/{id}');
    expect(toPattern('/users/{id:\\d+}')).toBe('/users/{id}');
    expect(toPattern('/users/:id')).toBe('/users/{id}');
    expect(toPattern('/users/[id]')).toBe('/users/{id}');
    expect(toPattern('/docs/[...slug]')).toBe('/docs/{*}');
    expect(toPattern('/docs/[[...slug]]')).toBe('/docs/{*}');
    expect(toPattern('/files/{path:path}')).toBe('/files/{*}');
    expect(toPattern('/a//b/')).toBe('/a/b');
    expect(toPattern('/x/**')).toBe('/x/{*}');
    expect(toPattern('/x/*', true)).toBe('/x/{*}');
    expect(toPattern('/x/*')).toBe('/x/*');
  });

  test('routeMatches: variables are one segment, a rest matches the tail, trailing slashes and encoding are tolerated', () => {
    expect(routeMatches('/users/{id}', '/users/7')).toBe(true);
    expect(routeMatches('/users/{id}', '/users')).toBe(false);
    expect(routeMatches('/users/{id}', '/users/7/edit')).toBe(false);
    expect(routeMatches('/users/{id}/edit', '/users/7/edit/')).toBe(true);
    expect(routeMatches('/docs/{*}', '/docs/a/b/c')).toBe(true);
    expect(routeMatches('/docs/{*}', '/docs')).toBe(true);
    expect(routeMatches('/files/*.png', '/files/a.png')).toBe(true);
    expect(routeMatches('/files/*.png', '/files/a.jpg')).toBe(false);
    expect(routeMatches('/', '/')).toBe(true);
    expect(routeMatches('/a b', '/a%20b')).toBe(true);
  });

  test('pathOf and underContext', () => {
    expect(pathOf('/shop/orders/7?x=1#f')).toBe('/shop/orders/7');
    expect(pathOf('http://proxy:8080/shop/')).toBe('/shop');
    expect(underContext('/shop/orders', '/shop')).toBe('/orders');
    expect(underContext('/shop', '/shop')).toBe('/');
    expect(underContext('/shopping', '/shop')).toBeNull();
    expect(underContext('/orders', '/')).toBe('/orders');
  });

  test('urlPattern reads Thymeleaf, JSP and plain URLs and drops the rest', () => {
    expect(urlPattern('@{/a/b}')).toBe('/a/b');
    expect(urlPattern('@{/a/{id}(id=${x.id},q=${y})}')).toBe('/a/{id}');
    expect(urlPattern("@{'/a/' + ${id}}")).toBe('/a/{}');
    expect(urlPattern('@{/}')).toBe('/');
    expect(urlPattern('${pageContext.request.contextPath}/a/${x.id}?q=1')).toBe('/a/{}');
    expect(urlPattern("<c:url value='/a'/>")).toBe('/a');
    expect(urlPattern('<%=request.getContextPath()%>/a')).toBe('/a');
    expect(urlPattern('/a#frag')).toBe('/a');
    for (const bad of ['', '#', 'javascript:void(0)', 'mailto:a@b.c', 'https://x.y/a', '//x.y/a', 'relative/path', '/css/site.css', '/img/a.png', '${url}', '@{${url}}']) expect(urlPattern(bad)).toBeNull();
  });

  test('exprPattern reads literals, templates and concatenations; a variable base is dropped', () => {
    expect(exprPattern("'/api/x'")).toBe('/api/x');
    expect(exprPattern('`/api/x/${id}`')).toBe('/api/x/{}');
    expect(exprPattern("'/api/x/' + id")).toBe('/api/x/{}');
    expect(exprPattern("API_BASE + '/api/x'")).toBe('/api/x');
    expect(exprPattern('`${base}/api/x`')).toBe('/api/x');
    expect(exprPattern('url')).toBeNull();
    expect(exprPattern("'https://a.b/c'")).toBeNull();
  });

  test('blankComments keeps offsets and strings; slug is ASCII and stable', () => {
    const src = 'a // x\nb "http://y" /* z\nw */ c';
    const out = blankComments(src, 'c');
    expect(out).toHaveLength(src.length);
    expect(out).toContain('"http://y"');
    expect(out).not.toContain('x\n');
    expect(out.split('\n')).toHaveLength(3);
    expect(slug('Save order')).toBe('save-order');
    expect(slug('저장')).toBe(slug('저장'));
    expect(slug('저장')).not.toBe(slug('삭제'));
    expect(slug('저장')).toMatch(/^u[0-9a-f]{6}$/);
  });
});
