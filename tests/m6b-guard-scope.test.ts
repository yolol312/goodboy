// Track M, M6b (plan §19), round 3 of the review: `cd "$HOME/…"`, compose set by the environment, raw output below a parent dir,
// the needle spellings on Linux, path boundaries, the work bound, a registered project whose sandbox dir is gone, and the cache
// of the registry's paths. The glob matcher is in tests/m6b-glob.test.ts, the earlier forms in tests/m6b-guard-forms.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdTarget } from '../lib/outward-command';
import { sandboxDataDenial } from '../lib/sandbox-data-guard';
import { projectName } from '../lib/sandbox-mode';
import { registerRealData, registryEntryOf, registryFile } from '../lib/sandbox-registry';
import { keepEnv, put, sandboxIn } from './m6b-helpers';

let base = '';
let repo = '';
let home = '';
let dump = '';
let log = '';
let registryDir = '';
const restoreEnv = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-scope-')));
  repo = join(base, 'repo');
  home = join(base, 'home');
  dump = put(join(home, 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
  log = put(join(home, 'logs', 'app.log'));
  put(join(repo, 'src', 'a.txt'));
  sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true, inputs: [log] });
  process.env.HOME = home;
  registryDir = join(base, 'registry');
  process.env.GOODBOY_REGISTRY_DIR = registryDir;
});
afterAll(() => {
  restoreEnv();
  rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
  for (const d of ['registry', 'parent', 'away', 'plain', 'gone']) rmSync(join(base, d), { recursive: true, force: true });
  rmSync(join(repo, '.goodboy', 'sandbox', 'out'), { recursive: true, force: true });
  rmSync(join(repo, '.git'), { recursive: true, force: true });
  rmSync(join(home, 'Downloads'), { recursive: true, force: true });
});

const bash = (command: string, cwd = repo): string | null => sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd, projectCwd: cwd })?.what ?? null;
const tool = (toolName: string, toolInput: Record<string, unknown>, cwd = repo): string | null => sandboxDataDenial({ toolName, toolInput, cwd, projectCwd: cwd })?.what ?? null;
const away = (): string => {
  const d = join(base, 'away');
  mkdirSync(d, { recursive: true });
  return d;
};
const DUMP_HIT = /dump or an input log/;

describe('cd into a dir spelled from $HOME', () => {
  test('cdTarget reads $HOME and ${HOME} as the home dir, and any other variable as unknown', () => {
    const h = process.env.HOME!;
    expect(cdTarget(['cd', '$HOME/dumps'], '/a')).toBe(join(h, 'dumps'));
    expect(cdTarget(['cd', '${HOME}/dumps'], '/a')).toBe(join(h, 'dumps'));
    expect(cdTarget(['cd', '$HOME'], '/a')).toBe(h);
    expect(cdTarget(['cd', '~/dumps'], '/a')).toBe(join(h, 'dumps'));
    expect(cdTarget(['cd', '$HOME/$X'], '/a')).toBeNull();
    expect(cdTarget(['cd', '$HOMEDIR/x'], '/a')).toBeNull();
    expect(cdTarget(['cd', '$X/dumps'], '/a')).toBeNull();
    expect(cdTarget(['cd', 'dumps'], '/a')).toBe('/a/dumps');
  });

  test('after cd "$HOME/dumps" a bare dump name is the dump: in the real-data project and from a shell outside it', () => {
    const other = join(base, 'parent', 'app');
    sandboxIn(other, { dump, dumpFormat: 'sql', realData: true, inputs: [log] });
    expect(registerRealData(registryEntryOf(other, { dump, dumpFormat: 'sql', realData: true, inputs: [log] }))).toBeNull();
    for (const cwd of [repo, away()]) {
      for (const cmd of ['cd "$HOME/dumps" && cat dump.sql', 'cd ${HOME}/dumps && head -3 dump.sql', "cd '$HOME/dumps'; cat dump.sql", 'cd $HOME/logs && tail app.log', 'cd ~/dumps && cat dump.sql', '(cd "$HOME/dumps" && cat dump.sql)']) {
        // single quotes keep `$HOME` from the shell, but the command reader drops quotes and expands it anyway (a
        //   fail-closed over-match, round-4 review); the shell's own answer is what this table checks, so it is skipped
        if (cmd.includes("'$HOME")) continue;
        expect([cwd.slice(base.length), cmd, bash(cmd, cwd)]).toEqual([cwd.slice(base.length), cmd, expect.stringMatching(DUMP_HIT)]);
      }
      for (const cmd of ['cd "$HOME/dumps" && ls', 'cd "$HOME/dumps" && cat other.sql', 'cd "$HOME/$X" && cat dump.sql', 'cd "$HOME/x" && cat dump.sql']) {
        expect([cwd.slice(base.length), cmd, bash(cmd, cwd)]).toEqual([cwd.slice(base.length), cmd, null]);
      }
    }
  });
});

describe('compose set by the environment', () => {
  const nested = (): { top: string; project: string } => {
    const top = join(base, 'parent', 'app');
    sandboxIn(top, { dump, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(top, { dump, dumpFormat: 'sql', realData: true }))).toBeNull();
    return { top, project: projectName(top) };
  };

  test('COMPOSE_PROJECT_NAME with the exact registered name, inline, exported or by env, with a deny verb: denied from anywhere', () => {
    const { project } = nested();
    for (const cmd of [
      `COMPOSE_PROJECT_NAME=${project} docker compose logs`,
      `COMPOSE_PROJECT_NAME=${project} docker compose exec db sh`,
      `export COMPOSE_PROJECT_NAME=${project}; docker compose logs`,
      `export COMPOSE_PROJECT_NAME=${project} && docker compose exec db sh`,
      `env COMPOSE_PROJECT_NAME=${project} docker compose exec db sh`,
      `COMPOSE_PROJECT_NAME=${project} docker-compose logs app`,
      `docker compose -p ${project} logs`,
    ]) {
      expect([cmd, bash(cmd, away())]).toEqual([cmd, expect.stringMatching(/docker/)]);
    }
    for (const cmd of [`COMPOSE_PROJECT_NAME=${project} docker compose ps`, 'COMPOSE_PROJECT_NAME=other docker compose logs', `COMPOSE_PROJECT_NAME=${project}x docker compose logs`, 'docker compose logs']) {
      expect([cmd, bash(cmd, away())]).toEqual([cmd, null]);
    }
  });

  test('COMPOSE_FILE naming the registered sandbox\'s compose file, inline, exported or by env: denied from the project\'s parent and by its absolute path', () => {
    const { top } = nested();
    const parent = join(base, 'parent');
    for (const cmd of [
      'COMPOSE_FILE=app/.goodboy/sandbox/compose.yml docker compose exec db sh',
      'export COMPOSE_FILE=app/.goodboy/sandbox/compose.yml; docker compose logs',
      'env COMPOSE_FILE=app/.goodboy/sandbox/compose.yml docker compose exec db sh',
      `COMPOSE_FILE=${top}/.goodboy/sandbox/compose.yml docker compose exec db sh`,
      `export COMPOSE_FILE=${top}/.goodboy/sandbox/compose.yml && docker compose logs`,
      `env COMPOSE_FILE=${top}/.goodboy/sandbox/compose.yml docker compose cp db:/x .`,
      'docker compose -f app/.goodboy/sandbox/compose.yml exec db sh',
    ]) {
      expect([cmd, bash(cmd, parent)]).toEqual([cmd, expect.stringMatching(/docker/)]);
    }
    expect(bash(`COMPOSE_FILE=${top}/.goodboy/sandbox/compose.yml docker compose exec db sh`, away())).toMatch(/docker/);
    for (const cmd of ['COMPOSE_FILE=docker-compose.yml docker compose exec web sh', `COMPOSE_FILE=${top}/.goodboy/sandbox/compose.yml docker compose ps`]) {
      expect([cmd, bash(cmd, parent)]).toEqual([cmd, null]);
    }
  });

  test('in the real-data project itself the same environment forms are denied', () => {
    const project = projectName(repo);
    for (const cmd of [`COMPOSE_PROJECT_NAME=${project} docker compose logs`, 'COMPOSE_FILE=.goodboy/sandbox/compose.yml docker compose exec db sh', `env COMPOSE_PROJECT_NAME=${project} docker compose exec db sh`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/docker/)]);
    }
  });
});

describe('raw host output while some is left, below a parent dir', () => {
  const out = (): string => join(repo, '.goodboy', 'sandbox', 'out');
  const left = (): void => {
    put(join(repo, '.goodboy', 'sandbox', '.gitignore'), 'local.json\nout/\nca/*.key\n'); // what sandbox-local writes
    put(join(out(), '20260101T000000Z', 'output.log'), 'row 1');
    put(join(out(), 'live', 'access.log'), 'row 2');
  };
  const git = (): void => {
    mkdirSync(join(repo, '.git'), { recursive: true });
  };
  const READERS = (root: string): string[] => [
    `grep -r foo ${root}`,
    `grep -R foo ${root}`,
    `grep -rn foo ${root} | head`,
    `cp -r ${root} /tmp/x`,
    `tar czf /tmp/x.tgz ${root}`,
    `rsync -a ${root}/ /tmp/x`,
    `zip -r /tmp/x.zip ${root}`,
    `find ${root} -name '*.log' -exec cat {} +`,
  ];

  test('recursive readers over the project root, .goodboy and .goodboy/sandbox are denied, with the way to clear the leftovers', () => {
    left();
    for (const root of ['.', repo, '.goodboy', '.goodboy/sandbox', join(repo, '.goodboy', 'sandbox')]) {
      for (const cmd of READERS(root)) {
        const r = bash(cmd);
        expect([cmd, r]).toEqual([cmd, expect.stringMatching(/raw output/)]);
        expect(r).toContain('leftovers');
        expect(r).toContain('removes them');
        expect(r).toContain('out/live');
      }
    }
    // with no operand, from inside those dirs
    expect(bash('grep -r foo', repo)).toMatch(/raw output/);
    expect(bash('grep -r foo', join(repo, '.goodboy'))).toMatch(/raw output/);
    expect(bash('cd .goodboy/sandbox && grep -r foo')).toMatch(/raw output/);
  });

  test('names a substitution builds, a pipe feeds, and find lists are read too', () => {
    left();
    for (const cmd of [
      'cat $(ls .goodboy/sandbox/out/*/output.log)',
      'head -3 `ls .goodboy/sandbox/out/live/*`',
      'cd .goodboy/sandbox/out/live && ls | xargs cat',
      'find .goodboy/sandbox/out | xargs cat',
      'find . -type f | xargs cat',
      'ls .goodboy/sandbox/out/20260101T000000Z | xargs -I{} cat .goodboy/sandbox/out/20260101T000000Z/{}',
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/raw output|fed the names|pipe or a substitution/)]);
    }
  });

  test('rg and ag skip the ignored out/ in a git repository, unless told not to; ack and grep -r do not', () => {
    left();
    git();
    for (const cmd of ['rg foo .', 'rg foo', 'rg foo .goodboy/sandbox', `rg foo ${repo}`, 'rg --hidden foo .', 'ag foo .', 'rg -n foo src']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    for (const cmd of ['rg -u foo .', 'rg -uu foo .', 'rg -uuu foo .goodboy', 'rg --no-ignore foo .', 'rg --no-ignore-vcs foo .', 'rg --unrestricted foo .', 'ag -U foo .', 'ag --skip-vcs-ignores foo .', 'ag -u foo .goodboy/sandbox', 'ack foo .', 'grep -r foo .']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/raw output/)]);
    }
    // a path inside out/ is denied for every program: the explicit path is not skipped
    expect(bash('rg foo .goodboy/sandbox/out')).toMatch(/raw output/);
  });

  test('outside a git repository rg does not read .gitignore, so it is denied like grep -r; so is a sandbox whose .gitignore lacks out/', () => {
    left();
    expect(bash('rg foo .')).toMatch(/raw output/);
    expect(bash('ag foo .goodboy/sandbox')).toMatch(/raw output/);
    git();
    expect(bash('rg foo .')).toBeNull();
    put(join(repo, '.goodboy', 'sandbox', '.gitignore'), 'local.json\n');
    expect(bash('rg foo .')).toMatch(/raw output/);
    put(join(repo, '.goodboy', 'sandbox', '.gitignore'), 'local.json\n/out/\n');
    expect(bash('rg foo .')).toBeNull();
  });

  test('the Grep tool is ripgrep: it passes over the project in a git repo and is denied outside one or inside out/', () => {
    left();
    expect(tool('Grep', { pattern: 'row' })).toMatch(/raw output/); // no repo
    expect(tool('Grep', { pattern: 'row', path: repo })).toMatch(/raw output/);
    git();
    expect(tool('Grep', { pattern: 'row' })).toBeNull();
    expect(tool('Grep', { pattern: 'row', path: repo })).toBeNull();
    expect(tool('Grep', { pattern: 'row', path: join(repo, '.goodboy', 'sandbox') })).toBeNull();
    expect(tool('Grep', { pattern: 'row', path: out() })).toMatch(/raw output/);
    expect(tool('Grep', { pattern: 'row', path: join(out(), 'live') })).toMatch(/raw output/);
    expect(tool('Glob', { pattern: '**/*.log', path: repo })).toBeNull(); // names only
  });

  test('with no raw output left nothing is held: the same readers pass', () => {
    put(join(out(), '20260101T000000Z', 'result.json'), '{"realData": true}');
    for (const cmd of [...READERS('.'), 'rg foo .', 'cat $(ls .goodboy/sandbox/out/*/result.json)']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    expect(tool('Grep', { pattern: 'x' })).toBeNull();
  });
});

describe('the $HOME needles on Linux', () => {
  const asLinux = <T>(f: () => T): T => {
    const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      return f();
    } finally {
      Object.defineProperty(process, 'platform', was);
    }
  };

  test('an assignment that spells the dump from $HOME, ${HOME} or ~ is denied when the platform does not lower-case paths', () => {
    asLinux(() => {
      expect(process.platform).toBe('linux');
      for (const cmd of ['DUMP=$HOME/dumps/dump.sql; head $DUMP', 'DUMP=${HOME}/dumps/dump.sql; head $DUMP', 'X=$HOME/logs/app.log; cat "$X"', 'D=~/dumps/dump.sql; cat $D', 'DUMP=$HOME/dumps/dump.sql cat $DUMP']) {
        expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(DUMP_HIT)]);
      }
      expect(bash('DUMP=$HOME/dumps/other.sql; head $DUMP')).toBeNull();
      expect(bash(`cat ${dump}`)).toMatch(DUMP_HIT);
    });
  });
});

describe('a protected path is held as text at a path boundary', () => {
  const downloads = (): { dir: string } => {
    const dir = join(home, 'Downloads');
    mkdirSync(dir, { recursive: true });
    put(join(dir, 'x.log'));
    const proj = join(base, 'parent', 'dl');
    sandboxIn(proj, { dump: null, dumpFormat: null, realData: true, inputs: [dir] });
    expect(registerRealData(registryEntryOf(proj, { dump: null, dumpFormat: null, realData: true, inputs: [dir] }))).toBeNull();
    return { dir };
  };

  test('~/Downloads registered: ~/Downloads2, ~/Downloads-old and a commit message that says ~/Downloadsx pass; the dir and its files do not', () => {
    const { dir } = downloads();
    const a = away();
    for (const cmd of [`cat ${home}/Downloads2/x.txt`, `cat ${home}/Downloads-old/x.txt`, `git commit -m "see ${home}/Downloadsx"`, `cat ~/Downloads2/x.txt`, 'cat $HOME/Downloads-old/a', `echo ${home}/Downloads.bak`, `cat ${home}/Documents/x`]) {
      expect([cmd, bash(cmd, a)]).toEqual([cmd, null]);
    }
    for (const cmd of [`cat ${dir}/x.log`, `cat ${dir}`, 'cat ~/Downloads/x.log', 'cat $HOME/Downloads/x.log', `X=${dir}; cat $X/x.log`, `FILE="${dir}/x.log" sh -c 'cat $FILE'`, `cat '${dir}/x.log'`, `echo "${dir}"`]) {
      expect([cmd, bash(cmd, a)]).toEqual([cmd, expect.stringMatching(DUMP_HIT)]);
    }
  });
});

describe('the work of a call is bounded', () => {
  test('a very long command with a protected dir repeated in one run is read in a bounded time, in the registry-only context', () => {
    const other = join(base, 'parent', 'app');
    sandboxIn(other, { dump, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(other, { dump, dumpFormat: 'sql', realData: true }))).toBeNull();
    const run = `(${`${home}/dumps/a`.repeat(8000)}`;
    const t0 = performance.now();
    expect(bash(`echo ${run}`, away())).toBeNull();
    expect(bash(`echo ${run}) x`, away())).toBeNull();
    expect(performance.now() - t0).toBeLessThan(3000);
    // and a group after the dir is still found
    expect(bash(`cat ${home}/dumps/(dump|x).sql`, away())).toMatch(DUMP_HIT);
  });

  test('globs of 64 alternatives each, past the work budget: denied as too long in the project, passed in the registry-only context', () => {
    const alts = Array.from({ length: 64 }, (_, i) => `*a${i}`).join(',');
    const word = `${home}/dumps/dump.{${alts}}`;
    const cmd = `echo ${Array.from({ length: 60 }, () => word).join(' ')}`;
    const t0 = performance.now();
    expect(bash(cmd)).toMatch(/too long to check/);
    const other = join(base, 'parent', 'app');
    sandboxIn(other, { dump, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(other, { dump, dumpFormat: 'sql', realData: true }))).toBeNull();
    expect(bash(cmd, away())).toBeNull();
    expect(performance.now() - t0).toBeLessThan(3000);
    // ordinary globs cost next to nothing and are still matched
    expect(bash(`cat ${home}/dumps/*.sql`, away())).toMatch(DUMP_HIT);
    expect(bash('cat src/**/*.ts', away())).toBeNull();
  });
});

describe('a registered project whose sandbox dir is gone', () => {
  test('a call whose dir is inside its top is the project\'s own: a container that cannot be told, a no-operand logs and the dump are denied', () => {
    const top = join(base, 'gone');
    sandboxIn(top, { dump, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(top, { dump, dumpFormat: 'sql', realData: true }))).toBeNull();
    rmSync(join(top, '.goodboy'), { recursive: true, force: true });
    mkdirSync(join(top, 'src'), { recursive: true });
    for (const cwd of [top, join(top, 'src')]) {
      for (const cmd of ['docker exec $C sh', 'docker logs', 'docker ps -aq | xargs docker logs', 'docker inspect 3f4a9c0b1d2e', `cat ${dump}`, 'psql -h db -U x', 'curl --unix-socket /var/run/docker.sock http://x/']) {
        expect([cwd.slice(base.length), cmd, bash(cmd, cwd) !== null]).toEqual([cwd.slice(base.length), cmd, true]);
      }
      expect(bash('docker ps', cwd)).toBeNull();
      expect(bash('docker exec web ls', cwd)).toBeNull();
    }
    // from elsewhere the registry-only reading stays: only the exact name and the paths
    expect(bash('docker exec $C sh', away())).toBeNull();
  });
});

describe('the registry\'s paths are built once per registry file', () => {
  test('a registry replaced by a file of the same size is read again (the cache key has the inode and mtime)', () => {
    const one = put(join(home, 'cache', 'aaaa.sql'), 'x');
    const two = put(join(home, 'cache', 'bbbb.sql'), 'x');
    const proj = join(base, 'parent', 'c1');
    sandboxIn(proj, { dump: one, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(proj, { dump: one, dumpFormat: 'sql', realData: true }))).toBeNull();
    const a = away();
    expect(bash(`cat ${one}`, a)).toMatch(DUMP_HIT);
    expect(bash(`cat ${two}`, a)).toBeNull();
    // the same project, the other dump, the same number of bytes
    const text = readFileSync(registryFile(), 'utf8');
    rmSync(registryFile());
    put(registryFile(), text.split(one).join(two));
    expect(bash(`cat ${two}`, a)).toMatch(DUMP_HIT);
    expect(bash(`cat ${one}`, a)).toBeNull();
    rmSync(join(home, 'cache'), { recursive: true, force: true });
  });
});
