// Track M, release review M7: tests for the changed lines the other m7 tests left unrun, found by the changed-line
// coverage of the whole suite: a `..` that survives in a glob of the Glob tool (lib/sandbox-data-guard.ts), a glob the
// matcher cannot read (a range that runs backwards, an unknown POSIX class), a lock that cannot be taken after two tries
// (lib/sandbox-lock.ts) and a node:http handler whose call never closes (lib/ui-inventory.ts).

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sandboxDataDenial } from '../lib/sandbox-data-guard';
import { LOCK_FILE, lockSandbox } from '../lib/sandbox-lock';
import { uiInventory } from '../lib/ui-inventory';
import { keepEnv, put, sandboxIn } from './m6b-helpers';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('the data rule reads a glob the way a shell would', () => {
  let base = '';
  let repo = '';
  let home = '';
  const restoreEnv = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7-cov-')));
    repo = join(base, 'repo');
    home = join(base, 'home');
    const dump = put(join(home, 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
    put(join(repo, 'src', 'a.txt'));
    mkdirSync(join(repo, 'src', 'sub'), { recursive: true });
    // a link to the dir that holds the dump, and a link to a dir above it
    symlinkSync(join(home, 'dumps'), join(repo, 'dl'));
    symlinkSync(home, join(repo, 'hl'));
    sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true });
    process.env.HOME = home;
    process.env.GOODBOY_REGISTRY_DIR = join(base, 'registry');
  });
  afterAll(() => {
    restoreEnv();
    rmSync(base, { recursive: true, force: true });
  });

  const bash = (command: string): string | null => sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd: repo, projectCwd: repo })?.what ?? null;
  // the Glob tool's absolute pattern reaches the rule as it is spelled: a `..` after a glob part is not collapsed
  const globTool = (pattern: string): string | null => sandboxDataDenial({ toolName: 'Glob', toolInput: { pattern }, cwd: repo, projectCwd: repo })?.what ?? null;

  test('a `..` after a glob part goes to the real parent of a linked match, so a dir above a link is reached', () => {
    // `*` matches the link `dl`; the shell's `dl/..` is the parent of what it points to (home), not the repo
    expect(globTool(`${repo}/*/../dumps/dump.sql`)).toBe('Glob of the dump or an input log');
    expect(globTool(`${repo}/hl/*/../dumps/*`)).toBe('Glob of the dump or an input log');
  });

  test('a `..` after a glob part over plain dirs, or as the last part, reaches nothing protected', () => {
    expect(globTool(`${repo}/src/*/../a*`)).toBeNull();
    expect(globTool(`${repo}/src/*/..`)).toBeNull();
    expect(globTool(`${repo}/hl/*/..`)).toBeNull();
    // the real parent of the link `dl` is home: it holds the dump's dir, not the dump
    expect(globTool(`${repo}/dl/..`)).toBeNull();
  });

  test('a glob the matcher cannot read is denied with its own text, never let through', () => {
    const unreadable = 'a glob the rule cannot read (a bracket range that runs backwards, an unknown class, an extended glob, more than 64 alternatives): write the path out or simplify the pattern';
    for (const cmd of ['cat src/[b-a]*', 'cat src/[[:nope:]]*', 'cat src/[z-a]*/x']) expect([cmd, bash(cmd)]).toEqual([cmd, unreadable]);
    // the same patterns written as valid ones pass
    for (const cmd of ['cat src/[a-b]*', 'cat src/[[:alpha:]]*']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
  });

  test('an unreadable glob in the dir of the dump is held for the dump', () => {
    expect(bash('cat dl/[b-a]*')).toBe('a path of the dump or an input log');
  });
});

describe('a link source glob too long to match as text within the work budget is denied, not let through', () => {
  test('`ln -s` of a huge glob word runs past the matcher work budget and fails closed', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7-cov-work-')));
    tmpDirs.push(base);
    const repo = join(base, 'repo');
    const dump = put(join(base, 'home', 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
    mkdirSync(repo, { recursive: true });
    sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true });
    const restore = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');
    process.env.HOME = join(base, 'home');
    process.env.GOODBOY_REGISTRY_DIR = join(base, 'registry');
    try {
      // 40 brace alternatives, each a long pattern (under the 2048 character word bound): the text match costs more than the budget
      const huge = `${repo}/{${Array.from({ length: 40 }, (_, i) => `d${i}`).join(',')}}/${'a*?'.repeat(500)}`;
      const what = sandboxDataDenial({ toolName: 'Bash', toolInput: { command: `ln -s ${huge} dl` }, cwd: repo, projectCwd: repo })?.what ?? null;
      expect(what).toBe('a command too long to check (split it)');
      const small = sandboxDataDenial({ toolName: 'Bash', toolInput: { command: `ln -s ${repo}/a* dl` }, cwd: repo, projectCwd: repo })?.what ?? null;
      expect(small).toBeNull();
    } finally {
      restore();
    }
  });
});

describe('a lock that cannot be taken after two tries', () => {
  const holder = (command: string): string => `${JSON.stringify({ pid: Bun.spawnSync(['true']).pid, started: new Date().toISOString(), command })}\n`;

  test('a stale lock that is replaced under the reader is not taken over on the first try; the second try ends busy', () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7-lock-')));
    tmpDirs.push(out);
    const file = join(out, LOCK_FILE);
    writeFileSync(file, holder('first'));
    let calls = 0;
    // the second reading of the clock is the first try's age check: another command replaces the stale lock right then, so
    // the content is no longer the one read and the lock is not removed
    const now = (): number => {
      calls++;
      if (calls === 2) writeFileSync(file, holder('second'));
      return Date.now();
    };
    const r = lockSandbox(out, 'sandbox-up', now);
    expect(r).toEqual({ busy: `the lock ${file} could not be taken; another sandbox command started at the same time` });
    // the second try found the replacement stale and removed it, so the next command takes the lock
    expect(existsSync(file)).toBe(false);
    const next = lockSandbox(out, 'sandbox-up');
    expect('release' in next).toBe(true);
    if ('release' in next) next.release();
    expect(existsSync(file)).toBe(false);
  });

  test('a stale lock nobody touches is taken over on the first try', () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7-lock-')));
    tmpDirs.push(out);
    writeFileSync(join(out, LOCK_FILE), holder('old'));
    const r = lockSandbox(out, 'sandbox-up');
    expect('release' in r).toBe(true);
    if ('release' in r) r.release();
  });
});

describe('a node:http handler whose call never closes is still read, to a bound', () => {
  function project(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7-ui-')));
    tmpDirs.push(root);
    if (Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: GIT_ENV }).exitCode !== 0) throw new Error('git init failed');
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  }
  const NOT_READ = ['framework not read: node:http server (for example server.js): its routes are not listed'];

  test('a file cut off inside the createServer call is named as an unread node:http server', () => {
    const cut = "const http = require('http');\nhttp.createServer((req, res) => {\n  if (req.url === '/orders') return res.end('x');\n";
    expect(uiInventory(project({ 'package.json': '{"name":"x"}', 'server.js': cut })).truncated).toEqual(NOT_READ);
  });

  test('a handler longer than the 20 000 character bound is read up to the bound, and a closed one is read whole', () => {
    const head = "const http = require('http');\nhttp.createServer((req, res) => {\n  if (req.url === '/orders') return res.end('x');\n";
    expect(uiInventory(project({ 'package.json': '{"name":"x"}', 'server.js': `${head}${'// pad\n'.repeat(4000)}` })).truncated).toEqual(NOT_READ);
    // the request is read only after the bound: not seen, so no unread framework is named
    const late = `const http = require('http');\nhttp.createServer((res) => {\n${'// pad\n'.repeat(4000)}  if (req.url === '/orders') return res.end('x');\n`;
    expect(uiInventory(project({ 'package.json': '{"name":"x"}', 'server.js': late })).truncated).toBeUndefined();
    const closed = `${head}  res.end('home');\n}).listen(3000);\n`;
    expect(uiInventory(project({ 'package.json': '{"name":"x"}', 'server.js': closed })).truncated).toEqual(NOT_READ);
  });
});
