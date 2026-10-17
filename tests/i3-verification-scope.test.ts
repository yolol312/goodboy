import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { addedUserGlobs, globsInText, pinCoverageStart, repoTop, sessionUserGlobs } from '../lib/changed-coverage';
import { isDocumentChange, isDocumentFile } from '../lib/doc-verification';
import { ensureSessionDir } from '../lib/file-tracker';
import { requiredDimensionsFor } from '../lib/review-dimensions';
import * as safeRead from '../lib/safe-read';
import { writeDenial } from '../lib/role-limits';
import { roleOf } from '../lib/routing-policy';
import { classifyFile, classifyPath, needsTests, previewProblem } from '../lib/verification-scope';

// Track I, I3a (#4, plan §15.6): one classifier for documents, static previews and code. It
// replaces the three doc rules (isDocFile, isDocPath, the reasoning gate's copy), so code and
// prototypes under docs/ need tests again, and the review dimensions follow the change.

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-i3-'));
  dirs.push(d);
  return d;
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
const sid = () => {
  const s = `i3-${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
};

const PREVIEW = 'docs/versions/1.0/preview';

describe('the class of a path', () => {
  test('AC-1: documents, previews and code', () => {
    const cases: [string, string][] = [
      ['README.md', 'document'],
      ['docs/guide/setup.MD', 'document'],
      ['notes.txt', 'document'],
      ['Docs/diagram.PNG', 'document'],
      ['doc/spec.pdf', 'document'],
      ['.goodboy/docs.json', 'document'],
      ['.goodboy/policy.md', 'document'],
      [`${PREVIEW}/index.html`, 'preview'],
      [`${PREVIEW}/css/style.css`, 'preview'],
      ['docs/versions/2.1/preview/REQUIREMENTS.htm', 'preview'],
      // Code and prototypes under docs/ are code (today they need no test).
      ['docs/x.ts', 'code'],
      ['docs/versions/1.0/prototype/index.html', 'code'],
      ['docs/versions/1.0/prototype/notes.md', 'code'],
      [`${PREVIEW}/app.js`, 'code'],
      ['docs/page.html', 'code'],
      ['docs/a.css', 'code'],
      ['diagram.png', 'code'],
      // Never a document: MDX holds components; dependency and build files.
      ['docs/intro.mdx', 'code'],
      ['requirements.txt', 'code'],
      ['requirements-dev.txt', 'code'],
      ['py/constraints.txt', 'code'],
      ['CMakeLists.txt', 'code'],
      ['src/a.ts', 'code'],
      ['package.json', 'code'],
    ];
    expect(cases.map(([p]) => [p, classifyPath(p)])).toEqual(cases);
  });

  test('AC-1: a pinned static-preview glob makes HTML and CSS there a preview, nothing else', () => {
    const globs = ['design/mock/**'];
    expect(classifyPath('design/mock/index.html', globs)).toBe('preview');
    expect(classifyPath('design/mock/a/b.css', globs)).toBe('preview');
    expect(classifyPath('design/mock/app.js', globs)).toBe('code');
    expect(classifyPath('design/mock/prototype/index.html', globs)).toBe('code');
    expect(classifyPath('design/other/index.html', globs)).toBe('code');
  });
});

describe('a preview is static only when its content is', () => {
  const html = (body: string) => `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`;

  test('AC-2: plain markup, local styles and images, outside links and data images are static', () => {
    const page = html('<h1>로그인</h1><img src="img/a.png" srcset="img/a.png 1x, img/a@2x.png 2x"><img src="data:image/png;base64,AAAA"><a href="https://example.com">x</a><a href="#top">top</a><p style="color: red">t</p>');
    expect(previewProblem(page, 'html', `${PREVIEW}/index.html`, PREVIEW)).toBeNull();
    expect(previewProblem('a { background: url(img/a.png) } @import "base.css";', 'css', `${PREVIEW}/style.css`, PREVIEW)).toBeNull();
  });

  test('AC-2: scripts, handlers, script URLs, embedded documents and template directives are code', () => {
    const bad = [
      '<script>alert(1)</script>',
      '<p onclick="x()">t</p>',
      '<a href="javascript:x()">t</a>',
      '<a href=" JavaScript:x()">t</a>',
      '<a href="vbscript:x">t</a>',
      '<a href="data:text/html,<script>x</script>">t</a>',
      '<iframe src="a.html"></iframe>',
      '<object data="a.svg"></object>',
      '<embed src="a.swf">',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://x">',
      '<p>Hello {{ name }}</p>',
      '<p>{% if x %}</p>',
      '<p v-if="x">t</p>',
      '<p x-data="{}">t</p>',
      '<p :class="c">t</p>',
      '<button @click="go">t</button>',
      '<div hx-get="/a">t</div>',
      '<p ng-if="x">t</p>',
    ];
    for (const b of bad) expect([b, previewProblem(html(b), 'html', `${PREVIEW}/index.html`, PREVIEW)]).toEqual([b, expect.any(String)]);
  });

  test('AC-2: a resource from outside the preview dir is code: a remote or rooted URL, or a path that climbs out', () => {
    const bad = [
      '<link rel="stylesheet" href="https://cdn.example/x.css">',
      '<link rel="stylesheet" href="//cdn.example/x.css">',
      '<img src="/abs.png">',
      '<img src="../../../secret.png">',
      '<img srcset="ok.png 1x, https://x.example/b.png 2x">',
      '<p style="background: url(https://x.example/t.png)">t</p>',
      '<style>@import url("https://x.example/a.css");</style>',
      '<form action="https://x.example/post"></form>',
      '<svg><use href="https://x.example/s.svg#a"></use></svg>',
    ];
    for (const b of bad) expect([b, previewProblem(html(b), 'html', `${PREVIEW}/index.html`, PREVIEW)]).toEqual([b, expect.any(String)]);
    for (const css of ['@import url(https://x.example/a.css);', 'a { background: url("../../../x.png") }', 'a { width: expression(alert(1)) }', 'a { behavior: url(x.htc) }', 'a { -moz-binding: url(x.xml#b) }', 'a { background: url(javascript:x) }']) {
      expect([css, previewProblem(css, 'css', `${PREVIEW}/style.css`, PREVIEW)]).toEqual([css, expect.any(String)]);
    }
  });

  test('AC-2: classifyFile reads the file: static is a preview, anything else code; a missing file keeps its path class', () => {
    const d = tmp();
    const ok = write(d, `${PREVIEW}/index.html`, '<h1>t</h1>');
    const bad = write(d, `${PREVIEW}/live.html`, '<h1 onclick="x()">t</h1>');
    const css = write(d, `${PREVIEW}/style.css`, 'a { color: red }');
    expect(classifyFile(ok, d)).toBe('preview');
    expect(classifyFile(bad, d)).toBe('code');
    expect(classifyFile(css, d)).toBe('preview');
    expect(classifyFile(join(d, PREVIEW, 'gone.html'), d)).toBe('preview'); // deleted: nothing to run
    expect(classifyFile(join(d, 'README.md'), d)).toBe('document');
  });

  test('AC-2: a preview that cannot be read as a regular file, or is over the cap, is code', () => {
    const d = tmp();
    const fifo = join(d, PREVIEW, 'pipe.html');
    mkdirSync(dirname(fifo), { recursive: true });
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    expect(classifyFile(fifo, d)).toBe('code');
    const big = write(d, `${PREVIEW}/big.html`, `<p>${'x'.repeat(2_000_001)}</p>`);
    expect(classifyFile(big, d)).toBe('code');
  });

  test('AC-2: a glob preview resolves its resources inside the glob base', () => {
    const d = tmp();
    const page = write(d, 'design/mock/a/index.html', '<link rel="stylesheet" href="../style.css"><img src="../../../outside.png">');
    expect(classifyFile(page, d, ['design/mock/**'])).toBe('code');
    write(d, 'design/mock/a/index.html', '<link rel="stylesheet" href="../style.css">');
    expect(classifyFile(page, d, ['design/mock/**'])).toBe('preview');
  });
});

// I3a review round 1: three highs (encoded and animated script URLs, a quadratic CSS scan, a
//   test-named link into code) and five mediums.
describe('the content check cannot be talked around', () => {
  const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
  const page = (body: string) => previewProblem(html(body), 'html', `${PREVIEW}/index.html`, PREVIEW);

  test('AC-2: script URLs spelled with character references, or set by SVG animation, are code', () => {
    const bad = [
      '<a href="&#106;avascript:x()">t</a>',
      '<a href="javascript&colon;x()">t</a>',
      '<a href="&#0000106&#0000097vascript:x()">t</a>',
      '<a href="&#x6A;avascript:x()">t</a>',
      '<a href="java&unknownname;script:x()">t</a>',
      '<svg><a xlink:href="&#x6A;avascript:x()">t</a></svg>',
      '<form><button formaction="&#106;avascript:x()">b</button></form>',
      '<svg><a><animate attributeName="href" values="#a;javascript:x()"/></a></svg>',
      '<svg><a><set attributeName="href" to="javascript:x()"/></a></svg>',
      '<meta http-equiv="&#114;efresh" content="0;url=x">',
    ];
    for (const b of bad) expect([b, page(b)]).toEqual([b, expect.any(String)]);
  });

  test('AC-2: CSS escapes, @import without a space, image-set and encoded attribute URLs still load from outside', () => {
    const bad = [
      '<style>body{background:u\\72l(https://evil.example/x.png)}</style>',
      '<style>@import"https://evil.example/x.css";</style>',
      '<style>body{background-image:image-set("https://evil.example/x.png" 1x)}</style>',
      '<style>body{background-image:-webkit-image-set("https://evil.example/x.png" 1x)}</style>',
      '<div style="background:u&#x72;l(https://evil.example/x.png)">t</div>',
      '<img src="https&colon;//evil.example/x.png">',
      '<style>a{background:url("https://evil.example/x\\".png")}</style>',
    ];
    for (const b of bad) expect([b, page(b)]).toEqual([b, expect.any(String)]);
    expect(page('<style>a{background:image-set("a.png" 1x, "a@2x.png" 2x)} /* note */ b{color:red}</style>')).toBeNull();
  });

  // 120 KB took 5.3 s with the quadratic scan (a Stop is killed at 15 s, and asks several
  //   times); kept small enough that a quadratic mutant fails here instead of hanging the run.
  test('AC-2: the CSS scan is linear: 120 KB of crafted input is decided in well under a second', () => {
    for (const css of ['url('.repeat(30_000), '/*a'.repeat(40_000), `a{b:${'url(x) '.repeat(17_000)}}`, '@import'.repeat(17_000), 'image-set('.repeat(12_000)]) {
      const t0 = performance.now();
      previewProblem(css, 'css', `${PREVIEW}/style.css`, PREVIEW);
      expect([css.slice(0, 12), performance.now() - t0 < 1000]).toEqual([css.slice(0, 12), true]);
    }
  });

  test('AC-3: a test-named link into code is code; a real test file is not', () => {
    const d = tmp();
    write(d, 'src/app.ts', 'export const a = 1;\n');
    write(d, 'tests/real.test.ts', "import { test } from 'bun:test';\ntest('x', () => {});\n");
    mkdirSync(join(d, 'tests', 'more'), { recursive: true });
    fs.symlinkSync('../src/app.ts', join(d, 'tests', 'app.test.ts'));
    fs.symlinkSync('../../src/app.ts', join(d, 'tests', 'more', 'helper.ts'));
    expect(needsTests(join(d, 'tests', 'app.test.ts'), d)).toBe(true);
    expect(needsTests(join(d, 'tests', 'more', 'helper.ts'), d)).toBe(true);
    expect(needsTests(join(d, 'tests', 'real.test.ts'), d)).toBe(false);
  });

  test('AC-3: a hard link from a document path into code is code', () => {
    const d = tmp();
    const code = write(d, 'src/app.ts', 'export const a = 1;\n');
    mkdirSync(join(d, 'docs'), { recursive: true });
    fs.linkSync(code, join(d, 'docs', 'hard.md'));
    expect(classifyFile(join(d, 'docs', 'hard.md'), d)).toBe('code');
    expect(classifyFile(write(d, 'docs/own.md', '# a\n'), d)).toBe('document');
  });

  test('AC-2: an SVG document or preview icon with active content is code; a plain one stays a document', () => {
    const d = tmp();
    expect(classifyFile(write(d, 'docs/diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), d)).toBe('document');
    expect(classifyFile(write(d, 'docs/bad.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'), d)).toBe('code');
    expect(classifyFile(write(d, `${PREVIEW}/icon.svg`, '<svg onload="x()"></svg>'), d)).toBe('code');
    expect(classifyPath('docs/img/favicon.ico')).toBe('document');
    expect(classifyPath('docs/arch.drawio')).toBe('document');
  });

  test('AC-2: a Stop asks for the same files many times: a preview is read once until it changes', () => {
    const d = tmp();
    const f = write(d, `${PREVIEW}/once.html`, '<h1>t</h1>');
    const spy = spyOn(safeRead, 'readRegular');
    try {
      for (let i = 0; i < 3; i++) expect(classifyFile(f, d)).toBe('preview');
      expect(spy).toHaveBeenCalledTimes(1);
      writeFileSync(f, '<h1 onclick="x()">changed, longer</h1>');
      expect(classifyFile(f, d)).toBe('code');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

// I3a review round 2: the CSS check fails closed instead of emulating the tokenizer; XML names
//   by their local part; a DTD entity, a test-named hard link.
describe('round 2: fail closed where the browser reads differently', () => {
  const css = (text: string) => previewProblem(text, 'css', `${PREVIEW}/a.css`, PREVIEW);
  const page = (body: string) => previewProblem(`<html><body>${body}</body></html>`, 'html', `${PREVIEW}/index.html`, PREVIEW);
  const svg = (text: string) => previewProblem(text, 'html', 'docs/diagram.svg', null);

  test('AC-2: CSS that a browser reads past a ")", a "/*" or an escape still loads from outside', () => {
    for (const bad of [
      'b{background:url("https://evil.example/x).png")}',
      'b{background-image:image-set("a).png" 1x, "https://evil.example/x.png" 2x)}',
      'a{content:"/*"} b{background:url(https://evil.example/x.png)} c{content:"*/"}',
      'b{background:url(a\\)/../../../../../src/x.png)}',
      'a{color:red} \\/* {} b{background:url(https://evil.example/x.png)} /* */',
      `b{background:url("${' '.repeat(1100)}https://evil.example/x.png")}`,
    ]) {
      expect([bad.slice(0, 50), css(bad)]).toEqual([bad.slice(0, 50), expect.any(String)]);
    }
    expect(page('<style>/*</style><style>b{background:url(https://evil.example/x.png)}</style><style>*/</style>')).toEqual(expect.any(String));
    expect(page('<svg><style>b{background:u&#x72;l(https://evil.example/x.png)}</style></svg>')).toEqual(expect.any(String));
  });

  test('AC-2: a crafted image-set CSS is decided fast; long data images and & in URLs stay static', () => {
    const block = 'image-set("a" '.repeat(1142) + ')';
    const t0 = performance.now();
    expect(css(block.repeat(28))).toEqual(expect.any(String));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(css(`b{background:url("data:image/png;base64,${'A'.repeat(6000)}")}`)).toBeNull();
    expect(page(`<img srcset="data:image/png;base64,${'A'.repeat(5000)} 1x">`)).toBeNull();
    expect(page('<a href="page.html?a=1&b=2">x</a><img src="img/a.png?v=1&amp;w=2"><a href="https://example.com/?q=caf&eacute;">x</a>')).toBeNull();
    expect(page('<svg><image href="a.png"><set attributeName="href" to="https://evil.example/x.png"/></image></svg>')).toEqual(expect.any(String));
  });

  test('AC-2: an SVG document read as XML: prefixed script, prefixed href and DTD entities are code', () => {
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:script>x()</svg:script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><h:script xmlns:h="http://www.w3.org/1999/xhtml">x()</h:script></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><a x:href="javascript:x()"><text>t</text></a></svg>',
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY s "<script>x()</script>">]><svg xmlns="http://www.w3.org/2000/svg">&s;</svg>',
    ]) {
      expect([bad.slice(0, 60), svg(bad)]).toEqual([bad.slice(0, 60), expect.any(String)]);
    }
    expect(svg('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>')).toBeNull();
  });

  // Closing review: `İ` (U+0130) lowercases to two characters and shifted every window.
  test('AC-2: CSS whose lower case changes length, and the CSS 4 src() function, cannot hide a remote URL', () => {
    expect(css(`a{content:"${'İ'.repeat(40)}"} b{background:url(https://evil.example/x.png)}`)).toEqual(expect.any(String));
    expect(css('b{background-image:src("https://evil.example/x.png")}')).toEqual(expect.any(String));
    expect(css('a{content:"İstanbul"}')).toEqual(expect.any(String)); // known limit: such text is code
  });

  test('AC-3: a test-named hard link into code is code', () => {
    const d = tmp();
    const code = write(d, 'src/app.ts', 'export const a = 1;\n');
    mkdirSync(join(d, 'tests'), { recursive: true });
    fs.linkSync(code, join(d, 'tests', 'app.test.ts'));
    expect(needsTests(join(d, 'tests', 'app.test.ts'), d)).toBe(true);
  });
});

describe('what needs a test', () => {
  test('AC-3: code anywhere, prototypes included; not documents, previews or test files', () => {
    const d = tmp();
    write(d, `${PREVIEW}/index.html`, '<h1>t</h1>');
    const need = (rel: string) => needsTests(join(d, rel), d);
    expect(need('docs/x.ts')).toBe(true);
    expect(need('docs/versions/1.0/prototype/index.html')).toBe(true);
    expect(need('src/a.ts')).toBe(true);
    expect(need('docs/intro.mdx')).toBe(true);
    expect(need('README.md')).toBe(false);
    expect(need('docs/diagram.svg')).toBe(false);
    expect(need(`${PREVIEW}/index.html`)).toBe(false);
    expect(need('tests/a.test.ts')).toBe(false);
  });

  test('AC-3: the Stop test gate asks for a test of code under docs/, and none for a preview', async () => {
    const run = async (rel: string, text: string) => {
      const box = tmp();
      const cwd = join(box, 'proj');
      mkdirSync(cwd);
      sh(cwd, 'git init -q . && printf \'{"scripts":{"test":"bun test"}}\' > package.json');
      const s = `i3s-${Math.random().toString(36).slice(2)}`;
      const abs = write(cwd, rel, text);
      const hook = async (script: string, payload: Record<string, unknown>) => {
        const p = Bun.spawn(['bun', join(ROOT, 'hooks', script)], {
          cwd,
          env: { ...process.env, TMPDIR: box, HOME: box, CLAUDE_PLUGIN_ROOT: ROOT, GOODBOY_TEST_GATE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0' },
          stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, cwd, ...payload })),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out ? (JSON.parse(out) as { decision?: string; reason?: string }) : {};
      };
      await hook('post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: abs } });
      return hook('stop.ts', { hook_event_name: 'Stop' });
    };
    const code = await run('docs/x.ts', 'export const x = 1;\n');
    expect(code.decision).toBe('block');
    expect(code.reason).toContain('No test result covers the changed code');
    expect(code.reason).toContain('docs/x.ts');
    const preview = await run(`${PREVIEW}/index.html`, '<h1>t</h1>\n');
    expect(preview.reason ?? '').not.toContain('No test result covers');
  }, 60_000);
});

// Layer-1 record of I3a: the hook call sites had no test of their own.
describe('the hooks use the classifier', () => {
  function box() {
    const b = tmp();
    const cwd = join(b, 'proj');
    mkdirSync(cwd);
    sh(cwd, 'git init -q . && printf \'{"scripts":{"test":"bun test"}}\' > package.json');
    return { b, cwd, s: `i3h-${Math.random().toString(36).slice(2)}` };
  }
  type Box = ReturnType<typeof box>;
  async function hook(x: Box, script: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', script)], {
      cwd: x.cwd,
      env: { ...process.env, TMPDIR: x.b, HOME: x.b, CLAUDE_PLUGIN_ROOT: ROOT, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_POLICY_GATE: 'off', ...env },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: x.s, cwd: x.cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }
  const gateLog = (x: Box) => {
    try {
      return readFileSync(join(x.b, `goodboy-session-${x.s}`, 'gate-log.jsonl'), 'utf8');
    } catch {
      return '';
    }
  };
  const human = (key: string, globs: string) => ['## P1 Mockups', '- decide: human', '- source: user 2026-10-17', `- ${key}: ${globs}`, ''].join('\n');

  test('AC-3: the skill rule applies to code under docs/, not to a document', async () => {
    const x = box();
    const write = (rel: string) => hook(x, 'pre-tool-use.ts', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(x.cwd, rel), content: 'x\n' } }, { GOODBOY_SKILL_GATE: 'on' });
    await write('docs/tool.ts');
    await write('docs/guide.md');
    expect(gateLog(x)).toContain('"gate":"skill-rule","decision":"deny","reason":"docs/tool.ts"');
    expect(gateLog(x)).not.toContain('docs/guide.md');
  }, 30_000);

  test("AC-6: the Stop honours the user's pinned static-preview glob; without it the same page needs a test", async () => {
    const stopAfterEdit = async (policy: string) => {
      const x = box();
      write(x.cwd, '.goodboy/policy.md', policy);
      await hook(x, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });
      const page = write(x.cwd, 'design/mock/index.html', '<h1>t</h1>\n');
      await hook(x, 'post-tool-use.ts', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: page } });
      return hook(x, 'stop.ts', { hook_event_name: 'Stop' }, { GOODBOY_TEST_GATE: 'on' });
    };
    expect(await stopAfterEdit(human('static-preview', 'design/mock/**'))).not.toContain('No test result covers');
    expect(await stopAfterEdit(human('coverage-exempt', 'other/**'))).toContain('No test result covers');
  }, 60_000);

  test('AC-6: with the changed-line rule off, a coverage-exempt glob may be added, a static-preview glob may not', async () => {
    const x = box();
    const policy = join(x.cwd, '.goodboy', 'policy.md');
    const add = (text: string) => hook(x, 'pre-tool-use.ts', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: policy, content: text } }, { GOODBOY_DIFF_COVERAGE: 'off' });
    expect(await add(human('coverage-exempt', 'hooks/**'))).not.toContain('"permissionDecision":"deny"');
    expect(await add(human('static-preview', 'design/**'))).toContain('static-preview: design/**');
  }, 30_000);
});

describe('the review dimensions of documents and previews', () => {
  test('AC-4: requirements Markdown needs plan-completeness; preview HTML both; preview CSS ui-ux; other documents none', () => {
    expect(requiredDimensionsFor(['docs/versions/1.0/REQUIREMENTS.md'])).toEqual(['plan-completeness']);
    expect(requiredDimensionsFor(['docs/BACKLOG.md'])).toEqual(['plan-completeness']);
    expect(requiredDimensionsFor(['docs/CYCLE.md'])).toEqual(['plan-completeness']);
    expect(requiredDimensionsFor([`${PREVIEW}/index.html`])).toEqual(['plan-completeness', 'ui-ux-accessibility']);
    expect(requiredDimensionsFor([`${PREVIEW}/style.css`])).toEqual(['ui-ux-accessibility']);
    expect(requiredDimensionsFor(['README.md', 'docs/guide.md', 'docs/a.png'])).toEqual([]);
    expect(requiredDimensionsFor(['docs/versions/1.0/REQUIREMENTS.md', `${PREVIEW}/style.css`])).toEqual(['plan-completeness', 'ui-ux-accessibility']);
  });

  test('AC-4: code keeps its rules; dependency files of every name need dependency-risk', () => {
    expect(requiredDimensionsFor(['docs/x.ts'])).toContain('refactoring-quality');
    for (const f of ['requirements.txt', 'requirements-dev.txt', 'constraints.txt']) expect(requiredDimensionsFor([f])).toContain('dependency-risk');
  });

  test('AC-4: the I1b document class: every file a document or a static preview', () => {
    const d = tmp();
    const req = write(d, 'docs/versions/1.0/REQUIREMENTS.md', '# R\n');
    const ok = write(d, `${PREVIEW}/index.html`, '<h1>t</h1>');
    const live = write(d, `${PREVIEW}/live.html`, '<script>x()</script>');
    expect(isDocumentChange([req, ok], d)).toBe(true);
    expect(isDocumentChange([req, live], d)).toBe(false);
    expect(isDocumentFile('requirements-dev.txt')).toBe(false);
    expect(isDocumentFile('docs/x.ts')).toBe(false);
  });
});

describe('who may write what', () => {
  test('AC-5: the docs role writes documents and previews, not code under docs/', () => {
    const d = tmp();
    const docs = roleOf('build-docs')!;
    expect(writeDenial(docs, join(d, 'README.md'), d)).toBeNull();
    expect(writeDenial(docs, join(d, PREVIEW, 'index.html'), d)).toBeNull();
    expect(writeDenial(docs, join(d, '.goodboy', 'docs.json'), d)).toBeNull();
    expect(writeDenial(docs, join(d, 'docs', 'x.ts'), d)).toContain('writes docs only');
    expect(writeDenial(docs, join(d, 'docs', 'versions', '1.0', 'prototype', 'index.html'), d)).toContain('writes docs only');
  });
});

describe("the user's static-preview globs", () => {
  const entry = (decide: string, globs: string) => ['## P1 Mockups', `- decide: ${decide}`, '- source: user 2026-10-17', `- static-preview: ${globs}`, ''].join('\n');

  test('AC-6: only human entries count; an added glob is reported by key', () => {
    expect(globsInText(entry('human', 'design/mock/**, ui/*.{html,css}'), 'static-preview')).toEqual(['design/mock/**', 'ui/*.{html,css}']);
    expect(globsInText(entry('ai', 'design/mock/**'), 'static-preview')).toEqual([]);
    expect(addedUserGlobs('', entry('human', 'design/mock/**'))).toEqual([{ key: 'static-preview', glob: 'design/mock/**' }]);
    expect(addedUserGlobs(entry('human', 'design/mock/**'), entry('human', 'design/mock/**'))).toEqual([]);
  });

  test('AC-6: pinned at the session start: a glob added during the session counts from the next one', () => {
    const d = tmp();
    sh(d, 'git init -q .');
    write(d, '.goodboy/policy.md', entry('human', 'design/a/**'));
    const s = sid();
    pinCoverageStart(s, d);
    write(d, '.goodboy/policy.md', entry('human', 'design/a/**, design/b/**'));
    const top = repoTop(d);
    expect(sessionUserGlobs(s, d, top, 'static-preview')).toEqual(['design/a/**']);
    const next = sid();
    pinCoverageStart(next, d);
    expect(sessionUserGlobs(next, d, top, 'static-preview')).toEqual(['design/a/**', 'design/b/**']);
  });

  test('AC-6: PreToolUse denies an Edit or Write that adds a static-preview glob', async () => {
    const box = tmp();
    const cwd = join(box, 'proj');
    mkdirSync(cwd);
    sh(cwd, 'git init -q .');
    const policy = join(cwd, '.goodboy', 'policy.md');
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'pre-tool-use.ts')], {
      cwd,
      env: { ...process.env, TMPDIR: box, HOME: box, CLAUDE_PLUGIN_ROOT: ROOT, GOODBOY_DISABLE_DELEGATION: '1' },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: `i3p-${Math.random().toString(36).slice(2)}`, cwd, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: policy, content: entry('human', 'design/mock/**') } })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    expect(out).toContain('"permissionDecision":"deny"');
    expect(out).toContain('static-preview');
  }, 30_000);

  test('AC-6: the session pin is read back with the globs of each key', () => {
    const d = tmp();
    sh(d, 'git init -q .');
    write(d, '.goodboy/policy.md', ['## P1 Hooks', '- decide: human', '- source: u', '- coverage-exempt: hooks/**', '- static-preview: design/**', ''].join('\n'));
    const s = sid();
    pinCoverageStart(s, d);
    const pin = JSON.parse(readFileSync(join(ensureSessionDir(s), 'coverage-pin.json'), 'utf8')) as { exemptions: string[]; globs?: Record<string, string[]> };
    expect(pin.exemptions).toEqual(['hooks/**']);
    expect(pin.globs?.['static-preview']).toEqual(['design/**']);
  });
});
