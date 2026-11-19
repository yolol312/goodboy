// Track M, M7 (release review, G3: data access): regression tests for its findings, on the PreToolUse data rule
// (lib/sandbox-data-guard.ts). Each block names its item: 1 a glob through a linked dir, 2 `file -f` and `--files0-from`,
// 3 the docker verbs `debug`, `checkpoint`, `mount` and `volume export|mount`, 4 the gate switch behind a wrapper, 5 a
// `run`/`create` that binds the engine's data or socket, 6 the redirects of goodboy's own command.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxDataDenial } from '../lib/sandbox-data-guard';
import { registerRealData, registryEntryOf } from '../lib/sandbox-registry';
import { keepEnv, put, sandboxIn } from './m6b-helpers';

let base = '';
let repo = '';
let plain = '';
let home = '';
let dump = '';
const restoreEnv = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m7-g3-')));
  repo = join(base, 'repo');
  plain = join(base, 'plain');
  home = join(base, 'home');
  mkdirSync(plain, { recursive: true });
  dump = put(join(home, 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
  put(join(home, 'dumps', 'other.sql'));
  put(join(repo, 'src', 'a.txt'));
  // a link to the dir that holds the dump, and a link to a dir above it
  symlinkSync(join(home, 'dumps'), join(repo, 'dl'));
  symlinkSync(home, join(repo, 'hl'));
  // links to the engine's dirs and socket (dangling where the machine has none: they are followed by name)
  symlinkSync('/var/run/docker.sock', join(repo, 'sock'));
  symlinkSync('/var/run', join(repo, 'rl'));
  symlinkSync('/var', join(repo, 'vl'));
  symlinkSync('/var/lib/containers', join(repo, 'pl'));
  sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true });
  process.env.HOME = home;
  process.env.GOODBOY_REGISTRY_DIR = join(base, 'registry');
});
afterAll(() => {
  restoreEnv();
  rmSync(base, { recursive: true, force: true });
});

const OWN_CLI = join(import.meta.dir, '..', 'lib', 'cli.ts');
const denial = (command: string, cwd = repo) => sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd, projectCwd: cwd });
const bash = (command: string, cwd = repo): string | null => denial(command, cwd)?.what ?? null;

describe('item 1: a glob whose dir is a link is judged with the link followed', () => {
  const DENIED = ['cat dl/*', 'cat dl/dum?.sql', 'cat dl/*.sql', 'cat dl/{dump,x}.sql', 'cat dl/dump.s[q]l', 'cd dl && cat *', 'cd dl && cat dum*', 'cat hl/dumps/*', 'cat hl/dumps/dum?.sql', 'grep x dl/*'];
  for (const cmd of DENIED) test(`denied: ${cmd}`, () => expect(bash(cmd)).not.toBeNull());

  test('the same through a link, spelled without a glob, is denied as before', () => {
    expect(bash('cat dl/dump.sql')).not.toBeNull();
  });

  test('a glob through the link that matches no protected file passes', () => {
    for (const cmd of ['cat dl/oth*', 'cat dl/other.?ql', 'cd dl && cat oth*', 'cat hl/src*', 'cat src/*']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
  });

  test('the Glob tool on a pattern below the link is denied too', () => {
    const hit = sandboxDataDenial({ toolName: 'Glob', toolInput: { pattern: join(repo, 'dl', '*') }, cwd: repo, projectCwd: repo });
    expect(hit?.what).toContain('Glob');
  });
});

describe('item 2: `file -f`, `wc --files0-from` and `du --files0-from` read the file as a list of names', () => {
  test('denied on the dump', () => {
    for (const cmd of [`file -f ${dump}`, `file -bf ${dump}`, `file --files-from ${dump}`, `file --files-from=${dump}`, `wc --files0-from=${dump}`, `wc --files0-from ${dump}`, `wc --files0 ${dump}`, `du --files0-from=${dump}`, `du --files0-from ${dump}`]) {
      expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
    }
  });

  test('metadata without a name list still passes', () => {
    for (const cmd of [`file ${dump}`, `file -b ${dump}`, `file -i ${dump}`, `file -bL -- ${dump}`, `file --brief --mime-type ${dump}`, `wc -l ${dump}`, `wc -lcw ${dump}`, `du -sh ${dump}`, `du -d 1 ${dump}`, `wc -c ${dump}`, `du -h ${dump}`, `ls -l ${dump}`, `stat ${dump}`, `file -f /tmp/names.txt`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
});

describe('item 3: docker verbs that open a container or a volume', () => {
  const DENIED = [
    'docker debug gb-abc-db-1',
    'docker container debug gb-abc-db-1',
    'docker debug --shell bash gb-abc-db-1',
    'docker checkpoint create gb-abc-db-1 cp1',
    'docker checkpoint ls gb-abc-db-1',
    'podman volume export gb-abc_db1data -o /tmp/v.tar',
    'podman volume mount gb-abc_db1data',
    'docker volume export gb-abc_db1data -o /tmp/v.tar',
    'podman mount gb-abc-db-1',
    'podman container mount gb-abc-db-1',
    // no name, or one that cannot be read: it cannot be told from a sandbox container
    'podman mount',
    'docker debug $ID',
    'docker ps -q | xargs docker debug',
    'sudo podman volume mount gb-abc_db1data',
  ];
  for (const cmd of DENIED) test(`denied: ${cmd}`, () => expect(bash(cmd)).not.toBeNull());

  test('other volume verbs and names that are no sandbox pass', () => {
    for (const cmd of ['docker volume ls', 'docker volume create cache', 'docker volume rm cache', 'docker volume export cache -o /tmp/v.tar', 'podman volume mount cache']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
});

describe('item 4: the gate switch behind a wrapper', () => {
  const NAME = 'GOODBOY_SANDBOX_PRIVACY_GATE';
  const RUN = `bun ${OWN_CLI} sandbox-run --suite unit`;
  const WRAPPERS = [
    'caffeinate -i env',
    'caffeinate env',
    'stdbuf -o0 env',
    'arch -arm64 env',
    'arch -x86_64 env',
    'doas -u root env',
    'doas env',
    'sudo env',
    'sudo -u me env -i',
    'nice -n 5 env',
    'nohup env',
    'timeout 5 env',
    'gtimeout 5 env',
    'gtimeout -k 2 5 env',
    'env -i env',
    'env -u HOME env',
    'env -i -u HOME',
    'npx cross-env',
    'cross-env',
    'bunx cross-env',
    'caffeinate sudo -u me env',
    'time caffeinate -d env',
  ];
  for (const w of WRAPPERS) {
    test(`denied: ${w} NAME=off`, () => {
      const hit = denial(`${w} ${NAME}=off ${RUN}`, plain);
      expect(hit?.fixed).toBeDefined();
    });
  }
  test('denied: the assignment straight after a wrapper that takes no env', () => {
    for (const cmd of [`caffeinate ${NAME}=off ${RUN}`, `cross-env ${NAME}=off ${RUN}`, `npx cross-env FOO=1 ${NAME}=off ${RUN}`, `stdbuf -oL ${NAME}=off ${RUN}`]) expect([cmd, denial(cmd, plain)?.fixed !== undefined]).toEqual([cmd, true]);
  });
  test('a wrapper with no assignment passes', () => {
    for (const cmd of [`caffeinate -i ${RUN}`, `npx cross-env FOO=1 ${RUN}`, `arch -arm64 ${RUN}`, `echo ${NAME}`, `npx cross-env FOO=1 bun test`]) expect([cmd, denial(cmd, plain)]).toEqual([cmd, null]);
  });
});

describe('item 5: `run` and `create` that bind the engine, its socket or the host, with no sandbox word', () => {
  const DENIED = [
    'docker run --rm -v /var/lib/docker/volumes:/v busybox ls /v',
    'docker run --rm -v /var/lib/docker:/v busybox ls /v',
    'docker run --rm -v /var/lib/docker-x/y:/v busybox ls',
    'docker run --rm -v /:/host busybox ls /host',
    'docker run --rm -v /:/host:ro busybox ls /host',
    'docker run --rm --volume=/var:/v busybox ls /v',
    'docker run --rm --volume /var:/v busybox ls /v',
    'docker run --rm -v /var/lib:/v busybox ls',
    'docker run --rm -v /var/../:/v busybox ls',
    'docker run --rm -v /private/var:/v busybox ls',
    'docker run --rm -itv /:/host busybox sh',
    'docker run --rm -v/:/host busybox sh',
    'docker run --rm -v=/:/host busybox sh',
    'docker run --rm --mount type=bind,source=/,target=/h busybox ls /h',
    'docker run --rm --mount type=bind,src=/var/lib/docker,dst=/d busybox ls /d',
    'docker run --rm --mount=type=bind,source=/var,target=/d busybox ls /d',
    'docker run --rm -v /var/run/docker.sock:/var/run/docker.sock docker ps',
    'docker run --rm -v /run/docker.sock:/s docker ps',
    'docker run --rm -v /private/var/run/docker.sock:/s docker ps',
    `docker run --rm -v ${'~'}/.colima/default/docker.sock:/s docker ps`,
    'docker run --rm -v /somewhere/else/docker.sock:/s docker ps',
    'docker run --rm --mount type=bind,source=/var/run/docker.sock,target=/s docker ps',
    'docker run --rm --privileged busybox ls',
    'docker run --rm --privileged=true busybox ls',
    'docker run --rm --pid=host busybox ps',
    'docker run --rm --pid host busybox ps',
    'docker create -v /:/host busybox',
    'docker create --privileged busybox',
    'docker container run --rm -v /:/host busybox ls',
    'docker compose run --rm -v /:/host app sh',
    'docker-compose run -v /var/run/docker.sock:/s app sh',
    'podman run --rm -v /:/host busybox ls',
    'sudo docker run --rm -v /:/host busybox ls',
    // a container's volumes, by a name that is no sandbox's (it may be one)
    'docker run --rm --volumes-from some-container busybox ls',
    'docker create --volumes-from gb-abc-db-1 busybox',
  ];
  for (const cmd of DENIED) test(`denied: ${cmd}`, () => expect(bash(cmd)).not.toBeNull());

  test('binds of other dirs, named volumes and plain options pass', () => {
    for (const cmd of [
      'docker run --rm busybox ls /',
      'docker run --rm -v /tmp/work:/w busybox ls /w',
      'docker run --rm -v /var/log:/l busybox ls /l',
      'docker run --rm -v /var/folders/x:/l busybox ls /l',
      'docker run --rm -v /private/var/folders/x:/l busybox ls /l',
      'docker run --rm -v cache:/c busybox ls /c',
      'docker run --rm -v ./src:/s busybox ls /s',
      'docker run --rm -v "$(pwd)":/w busybox ls /w',
      'docker run --rm --mount type=volume,source=cache,target=/c busybox ls /c',
      'docker run --rm --mount type=bind,source=/tmp/work,target=/w busybox ls /w',
      'docker run --rm -p 8080:80 nginx',
      'docker run --rm --privileged=false busybox ls',
      'docker run --rm --pid=container-x-unused busybox ls',
      'docker ps',
      'docker build -t x .',
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('a project that holds no real data is left alone', () => {
    for (const cmd of ['docker run --rm -v /:/host busybox ls', 'docker run --privileged busybox ls', 'docker run --rm -v ~/dumps:/d alpine ls /d']) expect([cmd, bash(cmd, plain)]).toEqual([cmd, null]);
  });
});

describe('item 5b: a bind whose source is a protected path or a dir that holds one', () => {
  const DENIED = [
    // the dump's dir (with ~, absolute, trailing slash), the dump, the dir above it
    'docker run --rm -v ~/dumps:/d alpine cat /d/prod.sql',
    () => `docker run --rm -v ${home}/dumps:/d alpine cat /d/prod.sql`,
    () => `docker run --rm -v ${home}/dumps/:/d:ro alpine cat /d/prod.sql`,
    () => `docker run --rm -v ${dump}:/d.sql alpine cat /d.sql`,
    'docker run --rm -v ~:/h alpine ls /h',
    () => `docker run --rm -v ${home}:/h:ro alpine ls /h`,
    () => `docker run --rm -v ${base}:/b alpine ls /b`,
    // the other spellings of a bind
    () => `docker run --rm --volume ${home}/dumps:/d alpine ls`,
    () => `docker run --rm --volume=${home}/dumps:/d alpine ls`,
    () => `docker run --rm -itv ${home}/dumps:/d alpine ls`,
    () => `docker run --rm --mount type=bind,source=${home}/dumps,target=/d alpine ls`,
    () => `docker run --rm --mount type=bind,src=${dump},dst=/d.sql alpine ls`,
    () => `docker create -v ${home}/dumps:/d alpine`,
    () => `docker compose run --rm -v ${home}/dumps:/d app sh`,
    () => `sudo docker run --rm -v ${home}/dumps:/d alpine ls`,
    // relative to the cwd, to the dir a `cd` moved to, and through a link
    () => `docker run --rm -v ../home/dumps:/d alpine ls`,
    () => `cd ${home} && docker run --rm -v ./dumps:/d alpine ls`,
    () => `cd ${home} && docker run --rm -v .:/h alpine ls`,
    './dl:/d',
    './hl:/h',
  ];
  // the commands hold the temp dirs, which exist once the tests run: they are built then, and the title shows their template
  for (const c of DENIED) {
    const cmd = (): string => (typeof c === 'function' ? c() : c.startsWith('./') ? `docker run --rm -v ${c} alpine ls /d` : c);
    test(`denied: ${typeof c === 'function' ? c.toString().replace(/^\(\) => `|`$/g, '') : cmd()}`, () => expect(bash(cmd())).not.toBeNull());
  }

  test('binds that hold no protected path pass', () => {
    for (const cmd of [
      'docker run --rm -v ./src:/src alpine ls /src',
      'docker run --rm -v $PWD/src:/src alpine ls /src',
      `docker run --rm -v ${repo}/src:/src alpine ls /src`,
      `docker run --rm -v ${home}/dumps2:/d alpine ls /d`,
      `docker run --rm -v ${home}/dumps-old:/d alpine ls /d`,
      `docker run --rm -v ${home}/logs:/l alpine ls /l`,
      'docker run --rm -v dumps:/d alpine ls /d',
      'docker run --rm --mount type=volume,source=dumps,target=/d alpine ls /d',
      'docker run --rm -v ./dl-not-there:/d alpine ls /d',
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('the registry dir and a dir above it, with no dump below', () => {
    const was = process.env.GOODBOY_REGISTRY_DIR;
    process.env.GOODBOY_REGISTRY_DIR = join(base, 'elsewhere', 'reg');
    try {
      for (const bind of [join(base, 'elsewhere', 'reg'), join(base, 'elsewhere', 'reg', 'registry.json'), join(base, 'elsewhere')]) {
        const cmd = `docker run --rm -v ${bind}:/r alpine ls /r`;
        expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
      }
      expect(bash(`docker run --rm -v ${join(base, 'elsewhere2')}:/r alpine ls /r`)).toBeNull();
    } finally {
      if (was === undefined) delete process.env.GOODBOY_REGISTRY_DIR;
      else process.env.GOODBOY_REGISTRY_DIR = was;
    }
  });

  test('raw output a sandbox left on the host: the project dir and the dirs down to it are held while some is left', () => {
    // (a bind that spells `.goodboy/sandbox` is a sandbox target already: only the dirs above it are for this rule)
    const binds = ['.:/w', './.goodboy:/g'];
    for (const b of binds) expect([b, bash(`docker run --rm -v ${b} alpine ls`)]).toEqual([b, null]);
    put(join(repo, '.goodboy', 'sandbox', 'out', 'live', 'x.log'));
    try {
      for (const b of binds) expect([b, bash(`docker run --rm -v ${b} alpine ls`)]).not.toEqual([b, null]);
      expect(bash('docker run --rm -v ./src:/src alpine ls /src')).toBeNull();
    } finally {
      rmSync(join(repo, '.goodboy', 'sandbox', 'out'), { recursive: true, force: true });
    }
  });
});

describe('item 6: the redirects of goodboy\'s own command are the shell\'s', () => {
  const CLI = `bun ${OWN_CLI} sandbox-data schema`;
  test('a redirect into or from the dump is denied', () => {
    for (const cmd of [`${CLI} 2> ${dump}`, `${CLI} 2>${dump}`, `${CLI} > ${dump}`, `${CLI} >${dump}`, `${CLI} >> ${dump}`, `${CLI} 2>> ${dump}`, `${CLI} &> ${dump}`, `${CLI} < ${dump}`, `${CLI} > ~/dumps/dump.sql`, `${CLI} 2> dl/dump.sql`, `${CLI} 2> dl/*`]) {
      expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
    }
  });
  test('other redirects, a here-document and the plain command pass', () => {
    for (const cmd of [CLI, `${CLI} 2>&1`, `${CLI} > /tmp/schema.json`, `${CLI} 2> /dev/null`, `${CLI} > ${join(home, 'dumps', 'other.sql')}`, `${CLI} <<EOF\nx\nEOF`, `${CLI} > out.txt`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
  test('the other forms of a redirect into the dump: `>&`, `<>`, `>|`, `2>|`, `&>>`, `3>`, a quoted target, a glob', () => {
    for (const cmd of [`${CLI} >& ${dump}`, `${CLI} >&${dump}`, `${CLI} <> ${dump}`, `${CLI} >| ${dump}`, `${CLI} 2>| ${dump}`, `${CLI} &>> ${dump}`, `${CLI} 3> ${dump}`, `${CLI} >"${dump}"`, `${CLI} > */dump.sql`, `${CLI} > d*/dump.sql`, `${CLI} <&${dump}`]) {
      expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
    }
  });
});

// ---- delta review D1 ----

describe('D1 item 2: a glob with a link anywhere in it is expanded on disk and each match judged', () => {
  const DENIED = ['cat */dump.sql', 'cat d*/dump.sql', 'cat ?l/dump.sql', 'cat [d]l/dump.sql', 'cat h*/dumps/dump.sql', 'cat hl/*/dump.sql', 'cat hl/d*/dump.sql', 'cat hl/d*/*', 'cat ./*/*', 'cat */*', 'cat **/*.sql', 'cat **/dump.sql', 'cat dl/**', 'cat ./**', 'cd hl/dumps && cat *', 'cd dl && cat ./*', 'cat ../*/dumps/*', 'cat ../*/*/*', 'cat src/../dl/*', 'head -n1 -- */dump.sql', 'for f in */dump.sql; do cat $f; done'];
  for (const cmd of DENIED) test(`denied: ${cmd}`, () => expect(bash(cmd)).not.toBeNull());

  test('globs that reach no protected file pass, and so does one a variable builds', () => {
    for (const cmd of ['cat src/*', 'cat ./src/*', 'cat */a.txt', 'cat dl/oth*', 'cat dl/*.txt', 'cat */nothing*', 'cat s*/*.txt', 'cat $PWD/dl/*']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
  });

  test('a glob over more entries than the call may read is denied, whether or not the dir it lists holds a protected path', () => {
    const inHome = join(home, 'big');
    const outside = join(repo, 'big2');
    const underHome = `cat ${home}/*/nothing*`;
    const plainDir = `cat ${outside}/f12*`;
    expect(bash(underHome)).toBeNull();
    for (const d of [inHome, outside]) {
      mkdirSync(d, { recursive: true });
      for (let i = 0; i < 21_000; i++) writeFileSync(join(d, `f${i}`), '');
    }
    try {
      // too large to check: denied, and told to narrow the pattern (the listing of `big2` holds no protected path, and the
      //   pattern matches about 1,100 names, under the limit on matches: it is the listing that is too large)
      expect(bash(underHome)).toContain('narrow the pattern');
      expect(bash(plainDir)).toContain('narrow the pattern');
      // a listing that is small enough passes
      expect(bash(`cat ${repo}/src/*/nothing*`)).toBeNull();
    } finally {
      rmSync(inHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
    expect(bash(plainDir)).toBeNull();
  }, 60_000);
});

describe('D1 item 3: `file`, `wc` and `du` are exempt only with options that print a count, a size or a type', () => {
  test('any other option drops the exemption', () => {
    for (const cmd of [`file -m ${dump} x`, `file --magic-file ${dump} x`, `file --magic-file=${dump} x`, `file -C -m ${dump}`, `file -e soft -f ${dump}`, `file -F, ${dump}`, `file -F : ${dump}`, `file -P name=1 ${dump}`, `wc --total=always --files0-from=${dump}`, `wc --f ${dump}`, `wc -X ${dump}`, `du --exclude-from=${dump} .`, `du -X ${dump} .`, `du --files0 ${dump}`]) {
      expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
    }
  });
  test('count, size and type options pass', () => {
    for (const cmd of [`file -b ${dump}`, `file -bik ${dump}`, `file --mime-encoding ${dump}`, `wc -m ${dump}`, `wc --lines --words ${dump}`, `du -ah ${dump}`, `du --summarize --human-readable ${dump}`, `du --max-depth=1 ${dump}`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
});

describe('D1 item 4: the engine check follows links, and covers podman', () => {
  const DENIED = [
    'docker run --rm -v ./sock:/s docker ps',
    'docker run --rm -v ./rl:/h busybox ls',
    'docker run --rm -v ./vl:/h busybox ls',
    'docker run --rm -v ./pl:/h busybox ls',
    'docker run --rm -v ./rl/:/h busybox ls',
    'docker run --rm --mount type=bind,source=./vl,target=/h busybox ls',
    'docker run --rm -v /var/lib/containers:/s busybox ls',
    'docker run --rm -v /var/lib/containers/storage:/s busybox ls',
    'podman run --rm -v /run/podman/podman.sock:/s busybox ls',
    'podman run --rm -v /run/podman:/s busybox ls',
    'podman run --rm -v /run/user/1000/podman:/p busybox ls',
    'podman run --rm -v /run/user/1000/podman/podman.sock:/p busybox ls',
    'podman run --rm -v /run/user/1000:/p busybox ls',
    'podman run --rm -v /run/user:/p busybox ls',
    'podman run --rm -v ~/.local/share/containers/storage:/s busybox ls',
    'podman run --rm -v ~/.local/share/docker:/s busybox ls',
  ];
  for (const cmd of DENIED) test(`denied: ${cmd}`, () => expect(bash(cmd)).not.toBeNull());
  test('$XDG_RUNTIME_DIR is read from the environment', () => {
    const restore = keepEnv('XDG_RUNTIME_DIR');
    process.env.XDG_RUNTIME_DIR = '/xdg-run-x';
    try {
      expect(bash('podman run --rm -v /xdg-run-x/podman/podman.sock:/s busybox ls')).not.toBeNull();
      expect(bash('podman run --rm -v /xdg-run-x/other:/s busybox ls')).toBeNull();
    } finally {
      restore();
    }
  });
  test('names and other dirs pass', () => {
    for (const cmd of ['docker run --rm -v rl:/h busybox ls', 'docker run --rm -v ./rl-not-there:/h busybox ls', 'docker run --rm -v /run/user-x:/h busybox ls', 'docker run --rm -v /var/log:/h busybox ls']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
});

describe('D1 item 5: a data bind is denied from a shell in another project too (the registry-only context)', () => {
  let other = '';
  let dump2 = '';
  beforeAll(() => {
    other = join(base, 'other');
    dump2 = put(join(home, 'dumps2', 'dump2.sql'), 'COPY t FROM stdin;');
    sandboxIn(other, { dump: dump2, dumpFormat: 'sql', realData: true });
    // registered by the user-level registry of this temp dir
    expect(registerRealData(registryEntryOf(other, { dump: dump2, dumpFormat: 'sql', realData: true }))).toBeNull();
  });
  afterAll(() => rmSync(join(base, 'registry'), { recursive: true, force: true }));

  test('the dump, its dir and a dir above it are held; the cat of the dump is too', () => {
    expect(bash(`cat ${dump2}`, plain)).not.toBeNull();
    for (const cmd of [`docker run -v ~/dumps2:/d alpine cat /d/dump2.sql`, `docker run --rm -v ${home}/dumps2:/d alpine ls`, `docker run --rm -v ${dump2}:/d.sql alpine ls`, `docker run --rm -v ${home}:/h alpine ls`, `docker create -v ~:/h alpine`, `docker run --rm --mount type=bind,source=${home},target=/h alpine ls`]) {
      expect([cmd, bash(cmd, plain)]).not.toEqual([cmd, null]);
    }
  });
  test('the registry dir and a dir above it are held', () => {
    for (const cmd of [`docker run --rm -v ${join(base, 'registry')}:/r alpine ls`, `docker run --rm -v ${base}:/b alpine ls`]) expect([cmd, bash(cmd, plain)]).not.toEqual([cmd, null]);
  });
  test('the engine rules stay for a real-data project: here they pass', () => {
    for (const cmd of ['docker run --rm -v /var/run/docker.sock:/s docker ps', 'docker run --rm --privileged busybox ls', 'docker run --rm --pid=host busybox ps', 'docker run --rm -v /var/lib/docker:/v busybox ls', 'docker run --rm -v ./src:/s busybox ls', 'docker run --rm -v /tmp:/t busybox ls']) {
      expect([cmd, bash(cmd, plain)]).toEqual([cmd, null]);
    }
  });
});

describe('R2: the registry-only context (a shell in a project that holds no real data, with another project registered)', () => {
  let dump2 = '';
  beforeAll(() => {
    const other = join(base, 'other');
    dump2 = put(join(home, 'dumps2', 'dump2.sql'), 'COPY t FROM stdin;');
    sandboxIn(other, { dump: dump2, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(other, { dump: dump2, dumpFormat: 'sql', realData: true }))).toBeNull();
    symlinkSync(join(home, 'dumps2'), join(plain, 'lk'));
  });
  afterAll(() => {
    rmSync(join(base, 'registry'), { recursive: true, force: true });
    rmSync(join(plain, 'lk'), { force: true });
  });

  test('item 3: globs are matched as text, with no walk of the dirs: a link in the middle of one is not followed', () => {
    // the dir before the first pattern character is resolved (as in a project that holds real data), a link below it is not
    expect(bash('cat lk/*', plain)).not.toBeNull();
    for (const cmd of ['cat */dump2.sql', 'cat l*/dump2.sql', 'cat **/*.sql', 'cat ./*/*']) expect([cmd, bash(cmd, plain)]).toEqual([cmd, null]);
  });
  test('item 4: a group in a word is held when its dir holds a registered path, as text; a link to it is not followed', () => {
    for (const cmd of ['cat ~/dumps2/(dump2|x).sql', `cat ${home}/dumps2/@(dump2).sql`, `cat ${home}/dumps2/dump2.s(ql|x)`, 'cat ~/dumps2/!(other).sql', 'cat "~/dumps2/"(dump2|x).sql']) expect([cmd, bash(cmd, plain)]).not.toEqual([cmd, null]);
    for (const cmd of ['cat lk/(dump2|x).sql', 'cat src/(a|b)']) expect([cmd, bash(cmd, plain)]).toEqual([cmd, null]);
  });
  test('item 2: a link to a registered dump or its dir is denied, by a glob or a brace too', () => {
    for (const cmd of [`ln -s ${home}/dumps2 d2`, 'ln -s ~/dumps2/ d2', `ln -s ${dump2} d2.sql`, `cp -s ${home}/dumps2 d2`, `ln -sfn ${join(base, 'registry')} reg`, 'ln -s ~/dump* x', 'ln -s ~/d?mps2 x', 'ln -s ~/{dumps2,q} x', 'ln -s ~/dumps[2] x']) {
      expect([cmd, bash(cmd, plain)]).not.toEqual([cmd, null]);
    }
    for (const cmd of ['ln -s src s2', `ln -s ${home}/logs lg`, 'ln -s ~ h', 'ln -s / r', 'ln -s ~/lo* x', 'ln -s ~/{logs,q} x']) expect([cmd, bash(cmd, plain)]).toEqual([cmd, null]);
    // a pattern the rule cannot read (more than 64 alternatives, a class that runs backwards) is denied, not let through
    const many = `ln -s ~/{${Array.from({ length: 70 }, (_, i) => `a${i}`).join(',')}} x`;
    for (const cmd of [many, 'ln -s ~/[b-a]x y']) expect([cmd.slice(0, 40), bash(cmd, plain)]).not.toEqual([cmd.slice(0, 40), null]);
  });
});

describe('D1 item 6: `--privileged` as a Go boolean', () => {
  test('1, t, T, true, True and TRUE are on', () => {
    for (const v of ['1', 't', 'T', 'true', 'True', 'TRUE']) expect([v, bash(`docker run --rm --privileged=${v} busybox ls`)]).not.toEqual([v, null]);
  });
  test('false, 0, f and the other spellings of off are not', () => {
    for (const v of ['false', 'False', 'FALSE', '0', 'f', 'F']) expect([v, bash(`docker run --rm --privileged=${v} busybox ls`)]).toEqual([v, null]);
  });
});

describe('D1 item 7: the gate switch is denied anywhere among the words of a segment whose program is not text-only', () => {
  const NAME = 'GOODBOY_SANDBOX_PRIVACY_GATE';
  const RUN = `bun ${OWN_CLI} sandbox-run --suite unit`;
  const fixed = (c: string): boolean => denial(c, plain)?.fixed !== undefined;
  test('denied: wrappers of any name, words after `--`, and `-c` strings', () => {
    for (const cmd of [`somewrapper --flag ${NAME}=off ${RUN}`, `somewrapper -- ${NAME}=off ${RUN}`, `unknowntool ${NAME}=off ${RUN}`, `sh -c 'echo hi; ${NAME}=off ${RUN}'`, `bash -lc "cd x && ${NAME}=off ${RUN}"`, `chroot / env ${NAME}=off ${RUN}`, `xcrun ${NAME}=off ${RUN}`, `sed -i s/a/${NAME}=off/ file`, `node -e 'x' -- ${NAME}=off`, `nsenter -t 1 ${NAME}=off ${RUN}`, `systemd-run --setenv ${NAME}=off ${RUN}`, `launchctl setenv ${NAME}=off`, `nohup caffeinate ${NAME}=off ${RUN}`]) {
      expect([cmd, fixed(cmd)]).toEqual([cmd, true]);
    }
  });
  test('passes: text-only programs and words that are other names', () => {
    for (const cmd of [`echo ${NAME}=off`, `printf '%s' ${NAME}=off`, `grep ${NAME}=off README.md`, `rg ${NAME}= .`, `sed s/a/${NAME}=off/ file`, `cat f ${NAME}=off`, `git commit -m "${NAME}=off"`, `git log --grep=${NAME}=`, `unknowntool X${NAME}=off`, `unknowntool ${NAME}x=off`, `unknowntool ${NAME}`, `GOODBOY_SANDBOX_DATA_GATE=off ${RUN}`]) {
      expect([cmd, denial(cmd, plain)]).toEqual([cmd, null]);
    }
  });
});

// ---- round-2 review ----

describe('R2 item 2: a link whose target is a protected path or a dir that holds one is not made', () => {
  const DENIED = [
    () => `ln -s ${home}/dumps dl2`,
    'ln -s ~/dumps dl2',
    () => `ln -s ${home}/dumps/ dl2`,
    () => `ln -sfn ${home}/dumps dl2`,
    () => `ln -s -t . ${home}/dumps`,
    () => `ln --symbolic ${home}/dumps dl2`,
    '../home/dumps',
    () => `ln -s ${dump} x.sql`,
    () => `ln ${dump} x.sql`,
    () => `ln -s ${home}/dumps x/l`,
    () => `mkdir x && ln -s ${home}/dumps x/l && cat x/l/dump.sql`,
    () => `cp -s ${home}/dumps dl2`,
    () => `cp --symbolic-link ${dump} x.sql`,
    // a link copied as a link, or moved: the link already leads there
    'cp -P dl x',
    'cp -a dl x',
    'cp -R dl x',
    'cp --no-dereference dl x',
    'cp -d dl x',
    'mv dl dl3',
    'mv -f dl src/',
  ];
  for (const c of DENIED) {
    const cmd = (): string => (typeof c === 'function' ? c() : c === '../home/dumps' ? 'ln -sr ../home/dumps dl2' : c);
    test(`denied: ${typeof c === 'function' ? c.toString().replace(/^\(\) => `|`$/g, '') : cmd()}`, () => expect(bash(cmd())).toContain('a link to'));
  }
  // a relative target of a symbolic link is read from the dir the link is made in
  test('a relative target is read from the dir the link is made in', () => {
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(bash('ln -s ../../../home/dumps src/deep/l')).not.toBeNull();
    expect(bash('ln -s ../../home/dumps src/deep/l')).toBeNull();
  });
  test('links to other things, to `/` and to $HOME (and above), and copies of plain files pass', () => {
    for (const cmd of ['ln -s ../src/a.txt x', 'ln -s src tlink', 'ln -s ~ hh', 'ln -s ~/ hh', 'ln -s / rr', `ln -s ${base} bb`, `ln -s ${home}/nothing n`, `ln -s ${home}/dumps2 d2`, 'cp -P src/a.txt y', 'cp -s src/a.txt y', 'mv src/a.txt src/b.txt', 'cp -R src s3', 'cp -P sock x2', 'ln -s $PWD/dl x']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
});

describe('R2 item 3: globs are expanded on disk in a project that holds real data, to a budget; a link costs more', () => {
  test('a glob over many links is denied for its cost, with the message to narrow it; fewer links pass', () => {
    const many = join(repo, 'many');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 500; i++) symlinkSync(join(repo, 'src'), join(many, `l${i}`));
    try {
      const big = bash('cat many/*/a.txt');
      expect(big).toContain('narrow the pattern');
      rmSync(many, { recursive: true, force: true });
      mkdirSync(many, { recursive: true });
      for (let i = 0; i < 20; i++) symlinkSync(join(repo, 'src'), join(many, `l${i}`));
      expect(bash('cat many/*/a.txt')).toBeNull();
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });
  test('a glob that matches more than 2000 names is denied', () => {
    const dir = join(repo, 'wide');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 2100; i++) writeFileSync(join(dir, `f${i}`), '');
    try {
      expect(bash('cat wide/*')).toContain('narrow the pattern');
      expect(bash('cat wide/f1*')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R2 item 4: a group in a word (extglob, zsh) is held when its dir holds a protected path, a link followed in a project that holds real data', () => {
  const DENIED = [
    'cat dl/(dump|x).sql',
    'cat dl/dump.s(ql|x)',
    'cat dl/@(dump).sql',
    'cat dl/@(dump|x).sql',
    'cat dl/!(other).sql',
    'cat dl/+(dump).sql',
    'cat dl/?(dump).sql',
    'cat hl/dumps/@(dump).sql',
    'cat hl/dumps/(dump|x).sql',
    'cat ~/dumps/@(dump).sql',
    'cat ~/dumps/(dump|x).sql',
    'cat ~/dumps/dump.s(ql|x)',
    'cat ~/dumps/!(other).sql',
    'cd dl && cat @(dump).sql',
    'cd dl && cat dump.s(ql|x)',
    'cd ~/dumps && cat dump.s(ql|x)',
    'cat $HOME/dumps/@(dump).sql',
  ];
  for (const cmd of DENIED) test(`denied: ${cmd}`, () => expect(bash(cmd)).not.toBeNull());
  test('groups in other dirs, subshells, substitutions and arrays pass', () => {
    for (const cmd of ['cat src/(a|b).txt', 'cat src/@(a).txt', 'cat src/dump.s(ql|x)', 'echo $(date)', 'cat <(echo hi)', '(cd src && ls)', 'x=(a b); echo $x', 'git commit -m "fix (typo) in a"', 'f() { echo hi; }; f', 'echo $((1+2))']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
});

// ---- closing reviews ----

describe('closing item 1: a group in a quoted word is read with the quotes out', () => {
  const DENIED = ['cd ~/dumps && cat "dump.s"(ql|x)', 'cat "dl/"(dump|x).sql', 'cat "dl/"@(dump).sql', 'cat "../home/dumps/"(dump|x).sql', 'cat dl/dump.s"(ql|x)"', "cat 'dl/'(dump|x).sql", 'cat "dl/dump.s"(ql|x)', "cat $'dl/'(dump|x).sql", "cd ~/dumps && cat $'./'(dump|x).sql", 'cat $"dl/"(dump|x).sql'];
  for (const cmd of DENIED) test(`denied: ${cmd}`, () => expect(bash(cmd)).not.toBeNull());
  test('quoted words with parentheses elsewhere pass', () => {
    for (const cmd of ['cat "src/"(a|b)', 'echo "a (b)"', 'git commit -m "fix (typo)"', 'cat "src/"@(a).txt']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
  });
});

describe('closing item 2: the sources of a link are expanded: braces, globs, a pattern that cannot be read', () => {
  test('a glob or a brace that stands for a protected dir or file is denied', () => {
    for (const cmd of ['ln -s ~/dump* x', 'ln -s ~/d?mps x', 'ln -s ~/{dumps,q} x', 'ln -s ~/dump[s] x', `ln -s ${home}/d*/ x`, 'cp -s ~/dump* x', 'ln -s dl/dum* x', 'ln -s ../home/dum* x', 'ln -s ~/{a,dumps}/dump.sql x', 'cp -P d* x', 'mv dl* x', 'mv {dl,src} x']) {
      expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
    }
  });
  test('globs and braces that stand for nothing protected pass', () => {
    for (const cmd of ['ln -s ~/lo* x', 'ln -s ~/{logs,q} x', 'ln -s src/* x', 'ln -s ../s?c x', 'cp -P s* x', 'cp -s src/* x', 'mv src/a.t* src/z.txt', 'ln -s $PWD/d* x']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
  test('a pattern too large or not readable is denied with its own text', () => {
    const many = `ln -s src/{${Array.from({ length: 70 }, (_, i) => `a${i}`).join(',')}} x`;
    // (the registry rule reads a pattern it cannot expand as one that may name the registry, and denies it first, as it always did;
    //   the link rule's own text for these is reached only where that rule does not apply, see `linkSourceVerdict`)
    for (const cmd of ['ln -s src/[b-a]x y', 'ln -s src/[[:nope:]]* y', many]) expect([cmd.slice(0, 30), bash(cmd)]).not.toEqual([cmd.slice(0, 30), null]);
    const wide = join(repo, 'big3');
    mkdirSync(wide, { recursive: true });
    for (let i = 0; i < 21_000; i++) writeFileSync(join(wide, `f${i}`), '');
    try {
      expect(bash('ln -s big3/f12* x')).toContain('narrow the pattern');
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('closing item 3: the expansion of a glob is bounded in work, not only in entries', () => {
  test('a long pattern over many long names is denied at once, with the message to narrow it', () => {
    const dir = join(repo, 'long');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 1500; i++) writeFileSync(join(dir, `${i}-${'a'.repeat(190)}`), '');
    try {
      const cmd = `cat long/${'*a'.repeat(400)}*`;
      const t = performance.now();
      const why = bash(cmd);
      const ms = performance.now() - t;
      expect(why).toContain('narrow the pattern');
      // unbounded this is 1,500 names x 800 tokens x 190 characters; the pattern with 1,000 stars over 20,000 names is minutes
      expect(ms).toBeLessThan(2500);
      // a short pattern over the same names is read in full
      expect(bash('cat long/1-a*')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('closing item 3 (time): an expansion that runs past its wall-clock budget is denied, whatever it has cost so far', () => {
  test('a clock that is past the call\'s budget at the first listing denies the glob', () => {
    const real = Date.now;
    let t = real();
    Date.now = () => (t += 5000);
    try {
      expect(bash('cat src/*')).toContain('narrow the pattern');
    } finally {
      Date.now = real;
    }
    expect(bash('cat src/*')).toBeNull();
  });
});

describe('closing item 4: raw sandbox output reached through a link, by a glob; a link to it', () => {
  const RAW = (): string => join(repo, '.goodboy', 'sandbox', 'out');
  const raw = (on: boolean): void => {
    if (on) put(join(RAW(), 'live', 'x.log'), 'row');
    else rmSync(RAW(), { recursive: true, force: true });
  };
  beforeAll(() => {
    raw(true);
    symlinkSync(join(RAW(), 'live'), join(repo, 'll'));
    symlinkSync(RAW(), join(repo, 'ol'));
    raw(false);
  });
  afterAll(() => {
    rmSync(join(repo, 'll'), { force: true });
    rmSync(join(repo, 'ol'), { force: true });
    raw(false);
  });

  test('a glob through a link to out/live or out/ is denied while raw output is left, and passes after', () => {
    const globs = ['cat ll/*', 'cat ll/x.l*', 'cat ol/*/x.log', 'cat ol/l*/x.log', 'cat o?/live/x.log', 'cat l?/x.log', 'cat */x.log', 'cat ll/x.log', 'cat ol/live/x.log'];
    raw(true);
    try {
      for (const cmd of globs) expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
      expect(sandboxDataDenial({ toolName: 'Glob', toolInput: { pattern: join(repo, 'll', '*') }, cwd: repo, projectCwd: repo })?.what).toContain('Glob');
    } finally {
      raw(false);
    }
    for (const cmd of globs) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
  });
  test('a link to out/, to what is in it, or to `.goodboy` above it is not made while raw output is left', () => {
    const links = ['ln -s .goodboy/sandbox/out o2', 'ln -s .goodboy/sandbox/out/live l2', 'ln -s .goodboy/sandbox/out/live/x.log f2', 'ln -s .goodboy g2', 'ln -s .goodboy/sandbox s2', 'cp -P ll x', 'mv ol y'];
    raw(true);
    try {
      for (const cmd of links) expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
      // the project dir and what is beside `.goodboy` are not held
      for (const cmd of ['ln -s . p2', 'ln -s ../repo p2', 'ln -s src t2']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    } finally {
      raw(false);
    }
    for (const cmd of ['ln -s .goodboy/sandbox/out o2', 'ln -s .goodboy g2']) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
  });
});

describe('closing lows', () => {
  test('docker checkpoint and volume export of a container or volume that cannot be told are denied', () => {
    for (const cmd of ['docker checkpoint create $C cp1', 'docker volume export $V -o /tmp/v.tar', 'docker volume mount $V', 'podman volume export $(podman volume ls -q)']) expect([cmd, bash(cmd)]).not.toEqual([cmd, null]);
  });
  test('a glob that cannot be read has its own text', () => {
    expect(bash('cat src/[b-a]*')).toContain('cannot read');
    expect(bash('cat src/[b-a]*')).not.toContain('narrow');
  });
});
