// Track M (plan §19): branches of the UI scanners and the UI check that no other test drives: a
// JSX spread attribute, an unclosed one, a form action, axios and jQuery calls in every spelling, a
// Kotlin controller, a report with odd shapes. Pure inputs in memory; temp dirs where a project is read.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCurrentTurn, recordEdit } from '../lib/file-tracker';
import { sandboxOwnFile, sandboxUsersOf } from '../lib/stop-groups';
import { cmdUiCheck, parseReport } from '../lib/ui-check';
import { jsxActions } from '../lib/ui-js';
import { Sink } from '../lib/ui-scan-text';
import type { SrcFile } from '../lib/ui-scan-text';
import { springRoutes, stringConstants } from '../lib/ui-spring';
import { addCalls, jsCalls, scanTemplate, urlPattern } from '../lib/ui-templates';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const env = (routes: string[] = []) => ({ has: (p: string) => routes.includes(p), ctx: '/' });
const file = (rel: string, text: string): SrcFile => ({ rel, text });

describe('jsxActions', () => {
  test('a spread attribute is skipped, an unclosed one ends the tag, a form action is an item', () => {
    const sink = new Sink();
    jsxActions(file('a.tsx', 'const A = () => <form {...props} action="/save" method="post"><input name="q" /></form>;'), sink, env(['/save']));
    expect([...sink.items.values()].map((i) => [i.method, i.route, i.input])).toEqual([['POST', '/save', true]]);
    const open = new Sink();
    jsxActions(file('b.tsx', 'const B = () => <form {...props action="/x"'), open, env());
    jsxActions(file('c.tsx', 'const C = () => <a {...props'), open, env());
    jsxActions(file('d.tsx', 'const D = () => <a href={x'), open, env());
    jsxActions(file('e.tsx', 'const E = () => <a disabled'), open, env());
    expect(open.items.size).toBe(0);
  });
});

describe('jsCalls and addCalls', () => {
  test('axios in every spelling, a call that is no path, a path no route serves', () => {
    const calls = jsCalls(
      ["axios.post('/a', body); axios.get('/b'); axios({ url: '/c', method: 'PUT' }); axios.request({ url: '/d' });", 'axios({ nourl: 1 }); axios.create({});'].join('\n'),
    );
    expect(calls.map((c) => [c.method, c.expr])).toEqual([
      ['POST', "'/a'"],
      ['GET', "'/b'"],
      ['PUT', "'/c'"],
      ['GET', "'/d'"],
    ]);
    const sink = new Sink();
    addCalls(jsCalls("fetch(someVar); fetch('/nowhere'); fetch('/ok'); fetch('https://x.example/y'); fetch('/logo.png')"), 'a.js', () => 1, sink, env(['/ok']));
    expect([...sink.items.values()].map((i) => i.route)).toEqual(['/ok']);
    expect(sink.notes.some((n) => n.includes('is not a path it can read'))).toBe(true);
    expect(sink.notes.some((n) => n.includes('matches no route of the app'))).toBe(true);
  });
});

describe('scanTemplate', () => {
  test('a form action it cannot read is a note; labels fall back to handler, data attribute, icon, class, tag', () => {
    const sink = new Sink();
    scanTemplate(
      file(
        'p.html',
        [
          '<form action="${x}"><input name="q"></form>',
          '<button onclick="openModal(1)"></button>',
          '<button onclick="if (a) { confirm(1) }"  data-target="#dlg"></button>',
          '<button data-bs-toggle="modal"></button>',
          '<button><i class="fa fa-trash"></i></button>',
          '<button class="btn btn-primary danger"></button>',
          '<button></button>',
        ].join('\n'),
      ),
      sink,
      env(),
    );
    expect(sink.notes.some((n) => n.includes('form action'))).toBe(true);
    // a Thymeleaf link whose closing paren has no opener is read whole
    expect(urlPattern('@{/x)}')).toBe('/x)');
    const labels = [...sink.items.values()].map((i) => i.label);
    expect(labels.join('|')).toContain('openModal');
  });
});

describe('springRoutes on Kotlin and odd annotations', () => {
  test('a Kotlin fun with a return type, one without, a stray @ and a trailing annotation', () => {
    const sink = new Sink();
    const f = file(
      'C.kt',
      [
        'package a',
        '@RestController',
        'class C {',
        '  @GetMapping("/k1") fun one(): String { return "x" }',
        '  @GetMapping("/k2") fun two() { }',
        '  @GetMapping("/k3") fun <T> three(x: T): List<T> = listOf()',
        '  val s = "a@b"',
        '}',
        '@interface Marker { }',
        '@Broken(unclosed',
        '@Deprecated',
      ].join('\n'),
    );
    springRoutes([f], stringConstants([f]), sink);
    expect(sink.routes.map((r) => r.pattern).sort()).toEqual(['/k1', '/k2', '/k3']);
  });
});

describe('parseReport shapes', () => {
  test('a test that is not an object, annotations that are not a list', () => {
    const problems: string[] = [];
    parseReport(JSON.stringify({ suites: [{ title: 's', specs: [{ title: 't', tests: [5, { status: 'expected', annotations: 'x', results: [] }] }] }] }), 'r.json', problems);
    expect(problems.some((p) => p.includes('is not an object'))).toBe(true);
    expect(problems.some((p) => p.includes('are not a list'))).toBe(true);
  });
});

describe('cmdUiCheck', () => {
  test('a run that is a file, not a dir, is no run dir', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6-')));
    tmpDirs.push(root);
    const out = join(root, '.goodboy', 'sandbox', 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, '20261022T101500Z'), 'x');
    const r = cmdUiCheck(root, ['--run', '20261022T101500Z']);
    expect('error' in r && r.error).toContain('is not a run dir');
  });
});

describe('sandboxUsersOf', () => {
  test('the sandbox layout files the session\'s changed files use, read once per session and dir', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6-')));
    tmpDirs.push(root);
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    mkdirSync(join(root, '.goodboy', 'sandbox'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, '.goodboy', 'sandbox', 'compose.yml'), 'services: {}\n');
    writeFileSync(join(root, 'src', 'a.ts'), "export const a = 'unrelated';\n");
    const sid = `m6-users-${Math.random().toString(36).slice(2, 10)}`;
    recordEdit(sid, join(root, 'src', 'a.ts'), getCurrentTurn(sid), undefined, Date.now());
    const first = sandboxUsersOf(sid, root);
    expect(first.all).toBe(false);
    expect(sandboxUsersOf(sid, root)).toBe(first);
    expect(sandboxOwnFile(sid, root, join(root, '.goodboy', 'sandbox', 'compose.yml'), root)).toBe(true);
    expect(sandboxOwnFile(sid, root, join(root, 'src', 'a.ts'), root)).toBe(false);
  });
});
