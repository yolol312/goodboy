// Track M fix round 1, fixer B (plan §19): the uiTest fixture, run for real against a stand-in for
// `@playwright/test`. Each uiTest gets its own nonce, which it sends as a request header and records
// as an annotation; that is what lets ui-check join a request to the one test that sent it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coverageScript, uiFixture } from '../lib/sandbox-e2e';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A stand-in for @playwright/test that records what the fixture asks of it. */
const PLAYWRIGHT_STUB = `
const registered = [];
const scopes = [];
function test(title, fn) { registered.push({ title, fn, use: Object.assign({}, ...scopes) }); }
test.extend = (defs) => { test.defs = defs; return test; };
test.describe = (fn) => { scopes.push({}); try { fn(); } finally { scopes.pop(); } };
test.use = (options) => { Object.assign(scopes[scopes.length - 1], options); };
module.exports = { test, expect: () => {}, registered };
`;

async function loadFixture(): Promise<{ uiTest: (ids: string[], title: string, fn: () => void) => void; registered: { title: string; use: Record<string, unknown> }[]; defs: Record<string, unknown> }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfb-e2e-')));
  tmpDirs.push(dir);
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put('node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', main: 'index.js' }));
  put('node_modules/@playwright/test/index.js', PLAYWRIGHT_STUB);
  put('e2e/goodboy-ui.ts', uiFixture());
  const mod = await import(join(dir, 'e2e/goodboy-ui.ts'));
  const stub = await import(join(dir, 'node_modules/@playwright/test/index.js'));
  const pw = (stub.default ?? stub) as { test: { defs: Record<string, unknown> }; registered: { title: string; use: Record<string, unknown> }[] };
  return { uiTest: mod.uiTest, registered: pw.registered, defs: pw.test.defs };
}

describe('B4: the uiTest fixture gives each test its own nonce', () => {
  test('two uiTests send different nonces, in the header and in the annotation option', async () => {
    const { uiTest, registered } = await loadFixture();
    uiTest(['screen:GET:/orders:ok'], 'lists orders', () => {});
    uiTest(['screen:GET:/orders:ok'], 'lists orders again', () => {});
    expect(registered).toHaveLength(2);
    const [a, b] = registered.map((t) => t.use as { goodboyNonce: string; goodboyClaims: string[]; extraHTTPHeaders: Record<string, string> });
    expect(a!.goodboyNonce).toMatch(/^[0-9a-f]{16}$/);
    expect(b!.goodboyNonce).toMatch(/^[0-9a-f]{16}$/);
    expect(a!.goodboyNonce).not.toBe(b!.goodboyNonce);
    // the header a request carries is the nonce the annotation records, and the claims travel with it
    expect(a!.extraHTTPHeaders['x-goodboy-test']).toBe(a!.goodboyNonce);
    expect(b!.extraHTTPHeaders['x-goodboy-test']).toBe(b!.goodboyNonce);
    expect(a!.extraHTTPHeaders['x-goodboy-ui']).toBe('screen:GET:/orders:ok');
    expect(a!.goodboyClaims).toEqual(['screen:GET:/orders:ok']);
  });

  test('the auto fixture records the claims and the nonce as annotations of the running test', async () => {
    const { uiTest, registered, defs } = await loadFixture();
    uiTest(['form:POST:/orders/save:ok', 'form:POST:/orders/save:error'], 'saves', () => {});
    const use = registered[0]!.use as { goodboyNonce: string; goodboyClaims: string[] };
    const annotations: { type: string; description: string }[] = [];
    const [run] = (defs.goodboyAnnotate as [(f: unknown, use: () => Promise<void>, info: { annotations: typeof annotations }) => Promise<void>])!;
    await run({ goodboyClaims: use.goodboyClaims, goodboyNonce: use.goodboyNonce }, async () => {}, { annotations });
    expect(annotations).toEqual([
      { type: 'goodboy-ui', description: 'form:POST:/orders/save:ok' },
      { type: 'goodboy-ui', description: 'form:POST:/orders/save:error' },
      { type: 'goodboy-test', description: use.goodboyNonce },
    ]);
  });

  test('a test that is not a uiTest records no nonce (the option defaults to empty)', async () => {
    const { defs } = await loadFixture();
    expect(defs.goodboyNonce).toEqual(['', { option: true }]);
    const annotations: unknown[] = [];
    const [run] = defs.goodboyAnnotate as [(f: unknown, use: () => Promise<void>, info: { annotations: unknown[] }) => Promise<void>];
    await run({ goodboyClaims: [], goodboyNonce: '' }, async () => {}, { annotations });
    expect(annotations).toEqual([]);
  });

  test('a claim that is not <id>:ok|error is refused before the test is registered', async () => {
    const { uiTest, registered } = await loadFixture();
    expect(() => uiTest(['screen:GET:/orders'], 't', () => {})).toThrow('is not <id>:ok|error');
    expect(() => uiTest(['screen:GET:/주문:ok'], 't', () => {})).toThrow('is not <id>:ok|error');
    expect(registered).toHaveLength(0);
  });
});

describe('B-low: the JVM coverage script keeps a dir name in one word', () => {
  /** Runs `coverage.sh report` for the JVM with its /build, /out, /live and /jacoco moved under a temp
   *  dir and a fake `java` that writes its arguments, one per line, to a file. */
  function runReport(dirs: string[]): { exit: number | null; args: string[]; out: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfb-cov-')));
    tmpDirs.push(root);
    const sh = coverageScript('jvm').replace(/(^|[\s"'=])\/(build|out|live|jacoco)(?=[/\s"'])/gm, `$1${root}/$2`);
    mkdirSync(join(root, 'jacoco'), { recursive: true });
    writeFileSync(join(root, 'jacoco/jacococli.jar'), 'x');
    mkdirSync(join(root, 'out/coverage-raw/unit'), { recursive: true });
    writeFileSync(join(root, 'out/coverage-raw/unit/jacoco.exec'), 'data');
    for (const d of dirs) mkdirSync(join(root, 'build', d), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    // the fake java: `merge` leaves its destfile, `report` records the arguments it was given
    writeFileSync(join(root, 'bin/java'), `#!/bin/sh\nif [ "$3" = merge ] || [ "$2" = merge ]; then :; else printf '%s\\n' "$@" > "${root}/report-args"; fi\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(root, 'coverage.sh'), sh);
    const r = Bun.spawnSync(['sh', join(root, 'coverage.sh'), 'report'], { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' });
    let args: string[] = [];
    try {
      args = readFileSync(join(root, 'report-args'), 'utf8').split('\n').filter((l) => l !== '').map((l) => l.replaceAll(root, '<root>'));
    } catch {
      // no report call
    }
    return { exit: r.exitCode, args, out: r.stdout.toString() + r.stderr.toString() };
  }

  test('class and source dirs with a space, a glob character or an option in their name stay one argument each', () => {
    const r = runReport(['with space/target/classes', 'star*/target/classes', 'opt --sourcefiles x/target/classes', 'app/src/main/java']);
    expect(r.exit).toBe(0);
    const pairs: string[] = [];
    for (let i = 0; i < r.args.length; i++) if (r.args[i]!.startsWith('--') && /^--(?:classfiles|sourcefiles)$/.test(r.args[i]!)) pairs.push(`${r.args[i]} ${r.args[i + 1]}`);
    expect(pairs.sort()).toEqual([
      '--classfiles <root>/build/opt --sourcefiles x/target/classes',
      '--classfiles <root>/build/star*/target/classes',
      '--classfiles <root>/build/with space/target/classes',
      '--sourcefiles <root>/build/app/src/main/java',
    ]);
    expect(r.args).toContain('--xml');
  });

  test('no compiled classes: the script says so and exits 6 without calling the report', () => {
    const r = runReport(['app/src/main/java']);
    expect(r.exit).toBe(6);
    expect(r.out).toContain('no compiled classes in /build');
    expect(r.args).toEqual([]);
  });
});
