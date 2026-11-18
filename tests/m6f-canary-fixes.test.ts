// M6f (track M, #19): the fix after the M6 canary step S3 (2026-11-18). A sandbox file whose proposed content is
// byte-equal to goodboy's own render (re-rendered from a fresh scan and local.json, never scan.json or the ledger) is not
// scanned by the commit and push scan; a changed rendered file, data.json, records and every other file are. Real temp
// repos, the PreToolUse scan, the git hooks (in process and spawned), the hand-run commands and the push scan.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Acc, DEFAULT_LIMITS, scanIndex } from '../lib/commit-scan';
import { commitScanOfCommand } from '../lib/commit-scan-guard';
import { commitScanCommand, pushScanCommand } from '../lib/git-hooks';
import { resetHookClock, startHookClock } from '../lib/hook-clock';
import { findSensitive } from '../lib/pii-patterns';
import { renderSandboxFiles } from '../lib/sandbox-render-files';
import { CANARY, cleanup, commit, type Fixture, fixture, git, put, useEnv, withRemote } from './m6f-helpers';
import { sandboxIn } from './m6b-helpers';

setDefaultTimeout(60_000);

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const SB = '.goodboy/sandbox';
const PROJECT = {
  'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\ndependencies {\n  runtimeOnly 'org.postgresql:postgresql'\n}\n",
  gradlew: '',
  'src/main/resources/application.yml': 'server:\n  port: 8080\nspring:\n  datasource:\n    url: jdbc:postgresql://localhost:5432/shop\n',
};

let f: Fixture;
let undo: () => void;
beforeEach(() => {
  f = fixture({ realData: true });
  undo = useEnv(f);
});
afterEach(() => {
  undo();
  cleanup();
});

interface Rendered {
  /** The project's dir (the repo, or a dir below it). */
  root: string;
  /** Repo-relative prefix of the sandbox dir. */
  prefix: string;
  /** Sandbox-relative path to the render's text. */
  files: Map<string, string>;
}

/** A Spring + Postgres project (committed) in `sub` of the repo ('' = the repo's top), and goodboy's whole render of it
 *  written into its sandbox dir and staged (`add -f`: the fixture's exclude file hides `.goodboy/`). `local.json` stays out. */
function rendered(fx: Fixture, sub = ''): Rendered {
  const root = sub === '' ? fx.repo : join(fx.repo, sub);
  if (sub !== '') sandboxIn(root, { dump: null, dumpFormat: null, realData: true });
  const at = (rel: string) => (sub === '' ? rel : `${sub}/${rel}`);
  commit(fx, Object.fromEntries(Object.entries(PROJECT).map(([k, v]) => [at(k), v])), 'project #1');
  const r = renderSandboxFiles(root);
  expect(r.failure).toBeNull();
  const prefix = at(`${SB}/`);
  for (const [rel, text] of r.files!) {
    put(fx, `${prefix}${rel}`, text);
    git(fx, ['add', '-f', `${prefix}${rel}`]);
  }
  return { root, prefix, files: r.files! };
}

const guard = (command: string, cwd = f.repo) => commitScanOfCommand(command, cwd, cwd, { env: f.env });
const hitsOf = (r: ReturnType<typeof guard>) => (r?.report.hits ?? []).map((h) => `${h.path}:${h.line} ${h.kind}`);

describe('the render the exemption compares with is one that would hit', () => {
  test('goodboy\'s own compose file has the dummy password the detector reads as a secret (so the tests below can fail)', () => {
    const p = rendered(f);
    expect(findSensitive(p.files.get('compose.yml')!).map((s) => s.kind)).toContain('secret');
  });
});

describe('an unchanged render is not scanned', () => {
  test('the PreToolUse scan of `git commit` passes it: no hit, nothing unscanned', () => {
    rendered(f);
    expect(guard('git commit -m "sandbox files #1"')).toBeNull();
  });

  test('the same commit with the work tree (`-a`) and with the paths (`--only`) passes it', () => {
    const p = rendered(f);
    expect(guard('git commit -a -m "sandbox files #1"')).toBeNull();
    expect(guard(`git commit -m "sandbox files #1" -- ${p.prefix}compose.yml`)).toBeNull();
  });

  test('the pre-commit hook in process, and the hand-run commit-scan, pass it', () => {
    rendered(f);
    expect(commitScanCommand(['--hook', 'pre-commit'], f.repo)).toEqual({ code: 0 });
    expect(commitScanCommand([], f.repo)).toMatchObject({ code: 0, out: { real_data: true, blocked: false, hits: [], unscanned: [] } });
  });

  test('a real `git commit` with the installed pre-commit hook goes through; with one changed byte it is stopped', () => {
    const p = rendered(f);
    const run = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: f.repo, env: { ...process.env, ...f.env }, stdout: 'pipe', stderr: 'pipe' });
    const inst = Bun.spawnSync(['bun', CLI, 'git-hooks', 'install'], { cwd: f.repo, env: { ...process.env, ...f.env }, stdout: 'pipe', stderr: 'pipe' });
    expect(inst.exitCode).toBe(0);
    const before = git(f, ['rev-parse', 'HEAD']).out;
    const ok = run(['commit', '-q', '-m', 'sandbox files #1']);
    expect(ok.stderr.toString()).not.toContain('commit scan');
    expect(ok.exitCode).toBe(0);
    expect(git(f, ['rev-parse', 'HEAD']).out).not.toBe(before);
    const head = git(f, ['rev-parse', 'HEAD']).out;
    put(f, `${p.prefix}compose.yml`, `${p.files.get('compose.yml')!}# changed\n`);
    git(f, ['add', '-f', `${p.prefix}compose.yml`]);
    const stopped = run(['commit', '-q', '-m', 'changed compose #1']);
    expect(stopped.exitCode).not.toBe(0);
    expect(stopped.stderr.toString()).toContain(`${p.prefix}compose.yml:9 secret`);
    expect(git(f, ['rev-parse', 'HEAD']).out).toBe(head);
  });

  test('the render runs once per call, however many commits and files; a commit with no file below the sandbox dir renders nothing', () => {
    rendered(f);
    const acc = new Acc(DEFAULT_LIMITS);
    scanIndex(f.repo, acc);
    scanIndex(f.repo, acc);
    expect(acc.renders.size).toBe(1);
    expect(acc.report().blocked).toBe(false);
    git(f, ['commit', '-q', '--no-verify', '-m', 'sandbox files #1']);
    put(f, 'notes.txt', 'plain\n');
    git(f, ['add', 'notes.txt']);
    const plain = new Acc(DEFAULT_LIMITS);
    scanIndex(f.repo, plain);
    expect(plain.renders.size).toBe(0);
  });

  test('the digest binds an exempt file out: the same report as when the render is not in the commit', () => {
    rendered(f);
    put(f, 'notes.txt', `call ${CANARY.phone}\n`);
    git(f, ['add', 'notes.txt']);
    const withRender = new Acc(DEFAULT_LIMITS);
    scanIndex(f.repo, withRender);
    git(f, ['reset', '-q', '--', SB]);
    const without = new Acc(DEFAULT_LIMITS);
    scanIndex(f.repo, without);
    const a = withRender.report();
    expect(a.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['notes.txt:1']);
    expect(a.digest).toBe(without.report().digest);
    expect(a.digest).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('everything else below the sandbox dir is scanned as before', () => {
  test('one changed byte in a rendered file: the file is scanned and hits', () => {
    const p = rendered(f);
    put(f, `${p.prefix}compose.yml`, `${p.files.get('compose.yml')!} `);
    git(f, ['add', '-f', `${p.prefix}compose.yml`]);
    const r = guard('git commit -m "x #1"');
    expect(hitsOf(r)).toEqual([`${p.prefix}compose.yml:9 secret`]);
    expect(commitScanCommand([], f.repo)).toMatchObject({ code: 1, out: { blocked: true } });
  });

  test('staged content that differs from the disk is judged by the staged blob (a plain commit), by the work tree for `-a`', () => {
    const p = rendered(f);
    const compose = `${p.prefix}compose.yml`;
    // staged = the render, disk = changed: a plain commit holds the blob, which is goodboy's
    put(f, compose, `${p.files.get('compose.yml')!}# disk\n`);
    expect(guard('git commit -m "x #1"')).toBeNull();
    // `-a` commits what the work tree has now: changed, so scanned
    expect(hitsOf(guard('git commit -a -m "x #1"'))).toEqual([`${compose}:9 secret`]);
    // staged = changed, disk = the render: a plain commit holds the changed blob; `-a` holds the render
    put(f, compose, `${p.files.get('compose.yml')!}# staged\n`);
    git(f, ['add', '-f', compose]);
    put(f, compose, p.files.get('compose.yml')!);
    expect(hitsOf(guard('git commit -m "x #1"'))).toEqual([`${compose}:9 secret`]);
    expect(guard('git commit -a -m "x #1"')).toBeNull();
  });

  test('data.json with a canary hits, and the rest of the render stays exempt', () => {
    const p = rendered(f);
    put(f, `${p.prefix}data.json`, `{"users":[{"rrn":"${CANARY.rrn}"}]}\n`);
    git(f, ['add', '-f', `${p.prefix}data.json`]);
    expect(hitsOf(guard('git commit -m "x #1"'))).toEqual([`${p.prefix}data.json:1 resident-number`]);
  });

  test('a file that is not in the render hits, even with a forged .written.json that lists it', () => {
    const p = rendered(f);
    put(f, `${p.prefix}extra.sh`, `#!/bin/sh\nPGPASSWORD=sandbox psql\n`);
    put(f, `${p.prefix}.written.json`, JSON.stringify({ files: { 'extra.sh': 'a'.repeat(64), 'compose.yml': 'b'.repeat(64) } }));
    git(f, ['add', '-f', `${p.prefix}extra.sh`, `${p.prefix}.written.json`]);
    expect(hitsOf(guard('git commit -m "x #1"'))).toEqual([`${p.prefix}extra.sh:2 secret`]);
  });

  test('a forged scan.json changes nothing: the render comes from a fresh scan of the project', () => {
    const p = rendered(f);
    put(f, `${p.prefix}scan.json`, JSON.stringify({ stack: 'forged', problems: [] }));
    git(f, ['add', '-f', `${p.prefix}scan.json`]);
    // the same content in a file the render does not make: scanned
    put(f, `${p.prefix}other.yml`, 'POSTGRES_PASSWORD: sandbox\n');
    git(f, ['add', '-f', `${p.prefix}other.yml`]);
    expect(hitsOf(guard('git commit -m "x #1"'))).toEqual([`${p.prefix}other.yml:1 secret`]);
  });

  test('a copy of the render below another dir is no sandbox file of the project: scanned', () => {
    const p = rendered(f);
    put(f, 'docs/.goodboy/sandbox/compose.yml', p.files.get('compose.yml')!);
    put(f, 'docs/compose.yml', p.files.get('compose.yml')!);
    git(f, ['add', '-f', 'docs/.goodboy/sandbox/compose.yml', 'docs/compose.yml']);
    git(f, ['reset', '-q', '--', SB]);
    expect(hitsOf(guard('git commit -m "x #1"')).sort()).toEqual(['docs/.goodboy/sandbox/compose.yml:9 secret', 'docs/compose.yml:9 secret']);
  });

  test('a render that cannot be made exempts nothing: the files are scanned as before', () => {
    const p = rendered(f);
    expect(guard('git commit -m "x #1"')).toBeNull();
    // a local.json goodboy did not write counts as real data and cannot be rendered with
    writeFileSync(join(f.repo, SB, 'local.json'), '{"realData":"yes"}');
    const acc = new Acc(DEFAULT_LIMITS);
    scanIndex(f.repo, acc);
    expect(acc.renders.get(f.repo)).toBeNull();
    expect(hitsOf(guard('git commit -m "x #1"'))).toContain(`${p.prefix}compose.yml:9 secret`);
  });

  test('near the end of the hook\'s clock the render gets what is left of it (it gets the 4.5 s the clock has left past its margin)', () => {
    rendered(f);
    startHookClock(6000);
    try {
      expect(guard('git commit -m "x #1"')).toBeNull();
    } finally {
      resetHookClock();
    }
  });

  test('a call that is out of time renders nothing: the files are scanned as before', () => {
    const p = rendered(f);
    const acc = new Acc({ ...DEFAULT_LIMITS, timeMs: -1 });
    scanIndex(f.repo, acc);
    expect(acc.renders.size).toBe(0);
    expect(acc.report().hits.some((h) => h.path === `${p.prefix}compose.yml`)).toBe(false);
    expect(acc.report().unscanned.length + acc.report().hits.length).toBeGreaterThan(0);
  });
});

describe('a project below the repository top', () => {
  test('the sandbox files of a project dir below the top are exempt; a changed one is not', () => {
    const fx = fixture();
    const off = useEnv(fx);
    try {
      const p = rendered(fx, 'app');
      expect(p.prefix).toBe('app/.goodboy/sandbox/');
      const app = join(fx.repo, 'app');
      expect(commitScanOfCommand('git commit -m "x #1"', app, app, { env: fx.env })).toBeNull();
      put(fx, `${p.prefix}compose.yml`, `${p.files.get('compose.yml')!}# changed\n`);
      git(fx, ['add', '-f', `${p.prefix}compose.yml`]);
      const r = commitScanOfCommand('git commit -m "x #1"', app, app, { env: fx.env });
      expect(hitsOf(r)).toEqual([`app/.goodboy/sandbox/compose.yml:9 secret`]);
    } finally {
      off();
    }
  });
});

describe('a push', () => {
  test('the current render in the pushed commits passes; a pushed changed file is scanned', () => {
    const p = rendered(f);
    withRemote(f);
    git(f, ['commit', '-q', '--no-verify', '-m', 'sandbox files #1']);
    expect(guard('git push origin main')).toBeNull();
    expect(pushScanCommand(['origin', 'main'], f.repo, '')).toMatchObject({ code: 0, out: { blocked: false, hits: [] } });
    put(f, `${p.prefix}compose.yml`, `${p.files.get('compose.yml')!}# changed\n`);
    commit(f, {}, 'changed compose #1');
    expect(hitsOf(guard('git push origin main'))).toEqual([`${p.prefix}compose.yml:9 secret`]);
  });

  test('an older render in the pushed history is scanned (the limit): only blobs equal to the current render are exempt', () => {
    const p = rendered(f);
    const older = p.files.get('compose.yml')!.replace('POSTGRES_PASSWORD: "sandbox"', 'POSTGRES_PASSWORD: "oldsecretvalue"');
    expect(older).not.toBe(p.files.get('compose.yml')!);
    put(f, `${p.prefix}compose.yml`, older);
    git(f, ['add', '-f', `${p.prefix}compose.yml`]);
    withRemote(f);
    git(f, ['commit', '-q', '--no-verify', '-m', 'older render #1']);
    // the current render on top of it
    put(f, `${p.prefix}compose.yml`, p.files.get('compose.yml')!);
    git(f, ['add', '-f', `${p.prefix}compose.yml`]);
    git(f, ['commit', '-q', '--no-verify', '-m', 'current render #1']);
    // what goes out: both blobs of compose.yml; the old one is scanned, the current one is not
    expect(hitsOf(guard('git push origin main'))).toEqual([`${p.prefix}compose.yml:9 secret`]);
    const blobs = git(f, ['rev-list', '--objects', 'main', '--not', '--remotes=origin']).out;
    expect(blobs.split('\n').filter((l) => l.endsWith(`${p.prefix}compose.yml`)).length).toBe(2);
  });
});
