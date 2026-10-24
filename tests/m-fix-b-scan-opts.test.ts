// Track M fix round 1, fixer B (plan §19): what the scan does with the project's files and with
// its options. Only scanSandbox is imported, so these fail on the unfixed code by what they assert.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanSandbox } from '../lib/sandbox-scan';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfb-opts-')));
  tmpDirs.push(root);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const PKG = JSON.stringify({ name: 'x', scripts: { start: 'node a.js' }, dependencies: {} });

describe('B2: the scan reads the files test-survey lists as own', () => {
  test('a storybook dir and a virtualenv are skipped, a vite config is read', () => {
    const root = repo({
      'package.json': PKG,
      'a.js': 'module.exports = 1;\n',
      '.storybook/main.js': 'const u = fetch("http://storybook.example.com/x");\n',
      'venv/lib/mod.py': 'import requests\nrequests.get("http://venv.example.com/x")\n',
      'web/vite.config.ts': "export default { server: { proxy: { '/api': { target: 'http://backend.example.com' } } } };\n",
    });
    const hosts = scanSandbox(root).outbound.map((o) => o.host);
    expect(hosts).toContain('backend.example.com');
    expect(hosts).not.toContain('storybook.example.com');
    expect(hosts).not.toContain('venv.example.com');
  });
});

describe('B1: the scan has a time budget, and the inventory asks for the context path without reading sources', () => {
  const app = () =>
    repo({
      'package.json': PKG,
      'src/a.js': 'const u = fetch("http://partner.example.com/x");\n',
      '.env': 'PARTNER_HOST=api.partner.example.com\n',
    });

  test('past its budget the scan leaves the rest out and says so in a question', () => {
    const root = app();
    const normal = scanSandbox(root);
    expect(normal.outbound.map((o) => o.host)).toContain('partner.example.com');
    expect(normal.questions.some((q) => q.includes('time budget'))).toBe(false);
    const late = scanSandbox(root, { budgetMs: -1 });
    expect(late.questions.some((q) => q.includes('time budget'))).toBe(true);
    expect(late.outbound.map((o) => o.host)).not.toContain('partner.example.com');
    expect(late.problems).toEqual(normal.problems);
  });

  test('sources: false reads the build and config files only (the context path of the inventory)', () => {
    const root = repo({
      'build.gradle': "plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\n",
      'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /shop\n',
      'src/main/java/A.java': 'class A { String u = "http://partner.example.com/x"; Object c = new org.springframework.web.client.RestTemplate(); }\n',
    });
    const full = scanSandbox(root);
    expect(full.outbound.map((o) => o.host)).toContain('partner.example.com');
    const light = scanSandbox(root, { sources: false });
    expect(light.app.contextPath).toBe('/shop');
    expect(light.outbound).toEqual([]);
  });

  test("files: the caller's list is used as it is (no second git ls-files)", () => {
    const root = repo({ 'package.json': PKG, '.env': 'PORT=4123\n' });
    expect(scanSandbox(root).app.port).toBe(4123);
    expect(scanSandbox(root, { files: ['package.json'] }).app.port).not.toBe(4123);
  });
});

describe('round 2: a question when there is no health route to find', () => {
  const NO_HEALTH = 'no health route found';
  const springBuild = (extra = '') => `plugins {\n  id 'org.springframework.boot' version '3.2.0'\n}\ndependencies {\n  implementation 'org.springframework.boot:spring-boot-starter-web'\n${extra}}\n`;

  test('a Spring app without the actuator is asked for a health path; with it, not', () => {
    const plain = scanSandbox(repo({ 'build.gradle': springBuild(), 'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /shop\n' }));
    expect(plain.app.healthPath).toBe('/shop');
    expect(plain.questions.find((q) => q.includes(NO_HEALTH))).toContain('requests `/shop`');
    const actuator = scanSandbox(repo({ 'build.gradle': springBuild("  implementation 'org.springframework.boot:spring-boot-starter-actuator'\n") }));
    expect(actuator.app.healthPath).toBe('/actuator/health');
    expect(actuator.questions.some((q) => q.includes(NO_HEALTH))).toBe(false);
  });

  test('a Node app is asked unless a /health handler is written in its code', () => {
    expect(scanSandbox(repo({ 'package.json': PKG, 'src/a.js': 'module.exports = 1;\n' })).questions.some((q) => q.includes(NO_HEALTH))).toBe(true);
    const handler = scanSandbox(repo({ 'package.json': PKG, 'src/a.js': "app.get('/health', (req, res) => res.send('ok'));\n" }));
    expect(handler.app.healthPath).toBe('/health');
    expect(handler.questions.some((q) => q.includes(NO_HEALTH))).toBe(false);
  });
});

describe('B1: what the faster lookups must keep', () => {
  test('a host key is read by the code that names it, as a word, whatever its case', () => {
    const root = repo({
      'package.json': PKG,
      '.env': 'PARTNER_HOST=api.partner.example.com\nOTHER_HOST=api.other.example.com\n',
      'src/a.js': 'const h = process.env.partner_host; fetch(`https://${h}/x`);\n', // names PARTNER_HOST in another case
      'src/b.js': 'const nothing = "OTHER_HOST_EXTRA"; // only a longer word\n',
    });
    const hosts = scanSandbox(root).outbound;
    expect(hosts.find((o) => o.host === 'api.partner.example.com')?.callSite).toEqual({ file: 'src/a.js', line: 1 });
    expect(hosts.find((o) => o.host === 'api.other.example.com')?.callSite).toBeNull();
  });

  test('a constant is used by the files that name it with the exact case, as a word', () => {
    const root = repo({
      'package.json': PKG,
      'src/consts.js': 'export const API_URL = "http://svc.example.com/v1";\n',
      'src/use.js': 'import { API_URL } from "./consts";\nfetch(API_URL);\n',
      'src/lower.js': 'fetch(api_url);\n', // another case: not a use of API_URL
    });
    const o = scanSandbox(root).outbound.find((x) => x.host === 'svc.example.com');
    expect(o?.callSite).toEqual({ file: 'src/use.js', line: 2 });
  });
});
