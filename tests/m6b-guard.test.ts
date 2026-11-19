// Track M, M6b (plan §19): the PreToolUse rule for sandboxes that may hold real data, as a function
// (lib/sandbox-data-guard.ts): every form it denies, every form it lets pass, the tools, the user-level registry, and the
// projects it leaves alone. The spawned hook is in tests/m6b-hook.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globMatches, isGoodboySandboxCli, sandboxDataDenial, sandboxDataMessage, shownDir, wordsText } from '../lib/sandbox-data-guard';
import { projectName } from '../lib/sandbox-mode';
import { registerRealData, registryEntryOf } from '../lib/sandbox-registry';
import { keepEnv, put, sandboxIn } from './m6b-helpers';

let base = '';
let repo = '';
let home = '';
let dump = '';
let log = '';
let inputDir = '';
let P = '';
const restoreEnv = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-guard-')));
  repo = join(base, 'repo');
  home = join(base, 'home');
  dump = put(join(home, 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
  put(join(home, 'dumps', 'other.sql'));
  log = put(join(home, 'logs', 'app.log'));
  inputDir = join(home, 'inputs');
  put(join(inputDir, 'a.log'));
  put(join(repo, 'src', 'a.txt'));
  put(join(repo, 'README.md'));
  symlinkSync(dump, join(repo, 'link.sql'));
  sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true, inputs: [log, inputDir] });
  P = projectName(repo);
  process.env.HOME = home;
  // an empty registry of this file: the per-repo reading is what most tests are about
  process.env.GOODBOY_REGISTRY_DIR = join(base, 'registry');
});
afterAll(() => {
  restoreEnv();
  rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
  for (const d of ['plain', 'nosandbox', 'nolocal', 'garbage', 'inputsonly', 'away', 'parent', 'registry']) rmSync(join(base, d), { recursive: true, force: true });
});

const OWN_CLI = join(import.meta.dir, '..', 'lib', 'cli.ts');
const bash = (command: string, cwd = repo): string | null => sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd, projectCwd: cwd })?.what ?? null;
const tool = (toolName: string, toolInput: Record<string, unknown>, cwd = repo): string | null => sandboxDataDenial({ toolName, toolInput, cwd, projectCwd: cwd })?.what ?? null;

describe('docker, podman and compose', () => {
  const DENIED = [
    // each verb of the list, against a container of the sandbox (its project name or a gb- prefix)
    () => `docker exec -it ${P}-db-1 psql -U sandbox`,
    () => `docker cp ${P}-db-1:/var/lib/postgresql/data /tmp/out`,
    () => `docker cp ./x gb-abc-db-1:/tmp/x`,
    () => `docker logs --tail 20 ${P}-app-1`,
    () => `docker inspect ${P}-app-1`,
    () => `docker attach gb-abc-app-1`,
    () => `docker export gb-abc-db-1 -o /tmp/db.tar`,
    () => `docker commit gb-abc-db-1 leak:latest`,
    () => `docker top gb-abc-db-1`,
    () => `docker diff gb-abc-db-1`,
    () => `docker start gb-abc-db-1`,
    () => `docker start -a gb-abc-db-1`,
    () => `docker start --attach -i ${P}-app-1`,
    () => `docker create --name x --volumes-from gb-abc-db-1 busybox`,
    () => `docker save gb-abc-image -o /tmp/i.tar`,
    // `run` with the sandbox's volume or network, or with another container's volumes or namespace
    () => `docker run --rm -v ${P}_db1data:/d busybox ls /d`,
    () => `docker run --rm --mount source=${P}_db1data,target=/d busybox ls /d`,
    () => `docker run --rm --network ${P}_inner busybox wget -qO- http://db:5432`,
    () => `docker run --rm --volumes-from some-container busybox ls`,
    () => `docker run --rm --network container:abc busybox ip a`,
    () => `docker run --rm --pid=container:abc busybox ps`,
    // the container group, compose with the sandbox's file, project or dir
    () => `docker container exec ${P}-db-1 sh`,
    () => `docker container logs gb-abc-db-1`,
    () => `docker compose -f .goodboy/sandbox/compose.yml exec db psql -U sandbox`,
    () => `docker compose --file=.goodboy/sandbox/compose.yml logs app`,
    () => `docker compose -f ./.goodboy/sandbox/compose.yml -p ${P} cp db:/tmp/x .`,
    () => `docker compose -p ${P} exec db sh`,
    () => `docker compose -f ${repo}/.goodboy/sandbox/compose.yml run --rm runner sh`,
    () => `docker-compose -f .goodboy/sandbox/compose.yml exec db sh`,
    () => `podman exec gb-abc-db-1 sh`,
    () => `nerdctl logs gb-abc-db-1`,
    // the target given by the environment, or by a path that is relative to where the command runs
    () => `COMPOSE_FILE=.goodboy/sandbox/compose.yml docker compose exec db psql -U sandbox`,
    () => `COMPOSE_PROJECT_NAME=${P} docker compose exec db sh`,
    () => `export COMPOSE_PROJECT_NAME=${P}; docker compose logs app`,
    () => `export COMPOSE_FILE='.goodboy/sandbox/compose.yml' && docker compose exec db sh`,
    () => `cd .goodboy && docker compose -f sandbox/compose.yml exec db psql -U sandbox`,
    () => `cd .goodboy; docker compose --file sandbox/compose.yml logs`,
    () => `docker compose --project-directory .goodboy/sandbox exec db sh`,
    () => `cd .goodboy && docker compose --project-directory sandbox exec db sh`,
    () => `cd .goodboy/sandbox/ca && docker compose -f ../compose.yml exec db sh`,
    // attached `up` streams the containers' logs
    () => `docker compose -f .goodboy/sandbox/compose.yml up`,
    () => `docker compose -f .goodboy/sandbox/compose.yml up app`,
    () => `docker-compose -f .goodboy/sandbox/compose.yml up --build`,
    // global options before the verb do not hide it
    () => `docker --context desktop exec gb-abc-db-1 sh`,
    () => `docker -H unix:///var/run/x.sock exec ${P}-db-1 sh`,
    () => `docker --config /tmp/c --log-level debug logs gb-abc-db-1`,
    // a container that cannot be told from a sandbox one: a variable, a substitution, a placeholder, a hex id, none
    () => `docker exec -- gb-abc-db-1 sh`,
    () => `docker exec -- $ID sh`,
    () => `docker exec $ID sh`,
    () => `docker exec "$(docker ps -q | head -1)" sh`,
    () => `docker exec \`docker ps -q\` sh`,
    () => `docker exec 3f4a9c0b1d2e sh`,
    () => `docker logs 3f4a9c0b1d2e`,
    () => `docker inspect $(docker ps -q)`,
    () => `docker cp $ID:/data /tmp/x`,
    () => `docker cp 3f4a9c0b1d2e:/data /tmp/x`,
    () => `docker ps -aq | xargs docker logs`,
    () => `docker ps -aq | xargs -n1 docker logs --tail 5`,
    () => `docker ps -aq | xargs -I{} docker inspect {}`,
    () => `docker ps -q | xargs docker top`,
    () => `docker logs`,
    // wrapped and chained
    () => `sudo docker exec gb-abc-db-1 sh`,
    () => `rtk docker exec gb-abc-db-1 sh`,
    () => `rtk proxy docker logs gb-abc-db-1`,
    () => `rtk proxy env docker exec gb-abc-db-1 sh`,
    () => `rtk env docker exec gb-abc-db-1 sh`,
    () => `rtk proxy time docker exec gb-abc-db-1 sh`,
    () => `rtk proxy timeout 5 docker logs ${P}-app-1`,
    () => `sh -c 'docker exec gb-abc-db-1 sh'`,
    () => `true; docker exec gb-abc-db-1 sh`,
    () => `echo hi && docker logs ${P}-app-1 | head`,
    () => `env FOO=1 docker exec gb-abc-db-1 sh`,
    () => `nohup docker exec gb-abc-db-1 sh`,
  ];
  for (const [i, cmd] of DENIED.entries()) {
    test(`denied ${i + 1}: ${cmd().replace(P, '<project>').slice(0, 90)}`, () => {
      expect(bash(cmd())).not.toBeNull();
    });
  }

  test('a cwd inside the sandbox dir makes a compose command the sandbox\'s, `cd` into it too', () => {
    const inSandbox = join(repo, '.goodboy', 'sandbox');
    expect(bash('docker compose exec db sh', inSandbox)).toMatch(/docker exec/);
    expect(bash('docker compose logs app', inSandbox)).toMatch(/docker logs/);
    expect(bash('cd .goodboy/sandbox && docker compose exec db sh')).toMatch(/docker exec/);
    expect(bash('(cd .goodboy/sandbox; docker compose cp db:/x .)')).toMatch(/docker cp/);
    // any word of the command naming the sandbox dir targets it, even in another segment: the rule fails closed
    expect(bash('cd .goodboy/sandbox; cd ..; docker compose exec web sh')).toMatch(/docker exec/);
    expect(bash('cd .goodboy; docker compose exec web sh')).toBeNull();
  });

  test('a program that runs its arguments or stdin as a command: denied beside docker text and a verb, not on plain text', () => {
    for (const cmd of [
      `watch docker logs ${P}-app-1`,
      `watch -n 5 'docker exec gb-abc-db-1 psql -c "select 1"'`,
      `colima ssh -- docker exec ${P}-db-1 psql -U sandbox`,
      `limactl shell colima docker logs gb-abc-db-1`,
      `ssh host docker exec x sh`,
      `script -q -c "docker exec x sh" /dev/null`,
      `unbuffer docker logs web`,
      `bash <<EOF\ndocker exec ${P}-db-1 sh\nEOF`,
      `sh <<'EOF'\ndocker logs ${P}-app-1\nEOF`,
      `echo 'docker exec x sh' | bash`,
      `bash -s <<EOF\ndocker cp ${P}-db-1:/x .\nEOF`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/cannot read|docker/)]);
    }
    for (const cmd of ['echo "docker exec x sh"', 'grep "docker exec" notes.md', 'git commit -m "docker exec fix"', 'watch ls', 'ssh host ls', 'colima status', "bash <<EOF\necho hello\nEOF", 'echo docker | bash']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  const PASSING = [
    'docker ps',
    'docker ps -a --filter name=web',
    'docker images',
    'docker build -t gbtool:latest .',
    'docker pull postgres:16',
    'docker network ls',
    'docker volume ls',
    'docker compose ps',
    'docker compose config',
    'docker compose up -d',
    'docker compose -f docker-compose.yml up',
    'docker compose -f docker-compose.yml exec web sh',
    'docker compose -f docker-compose.yml logs web',
    'docker exec web ls /app',
    "docker exec -it mycontainer sh -c 'echo gb-ok'",
    'docker logs web',
    'docker inspect web',
    'docker cp ./a.txt web:/tmp/a.txt',
    'docker run --rm alpine echo hello',
    'docker run --rm -v /tmp/data:/d alpine ls /d',
    'docker --context desktop ps',
    'podman images',
    'ls -la',
    'git status',
    'bun test',
    'cat README.md',
    'psql -h localhost -U me -d app',
    'psql -h db.example.com -U me',
    'mysql -h 127.0.0.1 -u root',
    'mongosh mongodb://localhost:27017/x',
    'curl http://localhost:8080/health',
  ];
  for (const cmd of PASSING) {
    test(`passes: ${cmd}`, () => {
      expect(bash(cmd)).toBeNull();
    });
  }

  test('a verb outside the list is not stopped even against the sandbox: ps, images, config, and a detached up', () => {
    expect(bash(`docker ps --filter name=${P}`)).toBeNull();
    expect(bash(`docker images ${P}`)).toBeNull();
    expect(bash(`docker compose -f .goodboy/sandbox/compose.yml ps`)).toBeNull();
    expect(bash(`docker compose -f .goodboy/sandbox/compose.yml config`)).toBeNull();
    expect(bash(`docker volume ls --filter name=${P}`)).toBeNull();
    expect(bash(`docker compose -f .goodboy/sandbox/compose.yml up -d`)).toBeNull();
    expect(bash(`docker compose -f .goodboy/sandbox/compose.yml up --detach app`)).toBeNull();
    expect(bash(`docker compose -f .goodboy/sandbox/compose.yml up --wait`)).toBeNull();
    expect(bash(`docker compose -f .goodboy/sandbox/compose.yml up -d --build`)).toBeNull();
  });
});

describe('the docker socket and the database clients', () => {
  test('a program that opens a unix socket from a path it is given is denied; DOCKER_HOST in another program\'s environment and text are not', () => {
    for (const cmd of [
      'curl --unix-socket /var/run/docker.sock http://localhost/containers/json',
      'curl --unix-socket=/x/y.sock http://localhost/',
      'socat - UNIX-CONNECT:/var/run/docker.sock',
      'nc -U /var/run/docker.sock',
      'ncat -U /var/run/docker.sock',
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, 'the docker socket']);
    }
    for (const cmd of [
      'grep -n docker.sock docker-compose.yml',
      'rg docker.sock .',
      'ls -l /var/run/docker.sock',
      'echo docker.sock',
      'cat notes-on-docker.sock.md',
      'git commit -m "mount docker.sock for the agent"',
      'export DOCKER_HOST=unix:///x',
      'DOCKER_HOST=tcp://h:2375 curl http://x',
      'env DOCKER_HOST=ssh://h curl http://x',
      'DOCKER_HOST=unix:///Users/x/.colima/default/docker.sock docker ps',
      'DOCKER_HOST=unix:///Users/x/.colima/default/docker.sock docker compose ps',
      'docker -H unix:///var/run/docker.sock images',
      'nc -z localhost 5432',
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
    // docker itself is read as docker: through the socket it is still `exec` into the sandbox
    expect(bash(`DOCKER_HOST=unix:///x/docker.sock docker exec ${P}-db-1 sh`)).toMatch(/docker exec/);
  });

  test('a client aimed at a sandbox host is denied: db, db2, a gb- name, a URL, a conninfo, PGHOST', () => {
    for (const cmd of [
      'psql -h db -U sandbox shop',
      'psql -hdb2 -U sandbox',
      'psql --host db -U sandbox',
      'psql --host=gb-abc-db-1 -U sandbox',
      'psql postgresql://sandbox:sandbox@db:5432/shop',
      'psql "host=db dbname=shop user=sandbox"',
      'mysql -h db -uroot -psandbox',
      'mariadb --host=db2 -uroot',
      'mongosh mongodb://db/x',
      'pg_dump -h db shop',
      'pg_dump --host=db shop > /tmp/x.sql',
      'mysqldump -h gb-abc-db-1 shop',
      'PGHOST=db psql -U sandbox',
      'PGHOST=gb-abc-db-1 pg_dump shop',
    ]) {
      expect(bash(cmd)).toMatch(/aimed at a sandbox database host/);
    }
  });
});

describe('the dump and the input logs', () => {
  test('any word that resolves to the dump or an input is denied, however it is spelled', () => {
    const cases = [
      `cat ${dump}`,
      `head -5 ${dump}`,
      `grep -c COPY ${dump}`,
      `cat < ${dump}`,
      `cat <${dump}`,
      `cp ${dump} /tmp/copy.sql`,
      `cat ${log}`,
      `tail -f ${inputDir}/a.log`,
      `cat ${inputDir}/../inputs/a.log`,
      `cat ~/dumps/dump.sql`,
      `cat $HOME/dumps/dump.sql`,
      `cat \${HOME}/dumps/dump.sql`,
      `cat ${home}/dumps/./dump.sql`,
      `cat ${home}/dumps/*.sql`,
      `cat ${home}/dumps/dump.s?l`,
      `cat ${home}/dumps/dum[p]*`,
      `cat ${home}/inputs/*`,
      `cat ${home}/inputs/*.log`,
      `cat link.sql`,
      `cat ./link.sql`,
      `cd ${home}/dumps && cat dump.sql`,
      `cd ${home}/dumps; head dump.sql`,
      `cd ${home}/dumps && cat *.sql`,
      `(cd ${home}/logs && cat app.log)`,
      `sh -c 'cat ${dump}'`,
      `psql -f ${dump}`,
      `psql --file=${dump} shop`,
      `dd if=${dump} of=/tmp/x`,
      `strings ${dump}`,
      `rtk proxy cat ${dump}`,
      // a path that a variable builds around the dump's own text
      `cat $PREFIX${dump}`,
      `cat "$X${dump}"`,
    ];
    for (const cmd of cases) expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/dump or an input log/)]);
  });

  test('other files, the dir that holds the dump, and a path a variable would build pass', () => {
    for (const cmd of [`cat ${home}/dumps/other.sql`, `ls ${home}/dumps`, `ls ${home}`, 'cat src/a.txt', 'echo dump.sql', 'cat dump.sql', `cat ${repo}/README.md`, 'cat $SOME/dump.sql', `cd ${home}/dumps && ls`, `cat ${home}/logs/other.log`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('programs that only tell about a file pass: ls, stat, wc, du, file, test, [', () => {
    for (const cmd of [`ls -l ${dump}`, `stat ${dump}`, `wc -l ${dump}`, `wc -c ${dump} | cat`, `du -h ${dump}`, `file ${dump}`, `test -f ${dump}`, `[ -f ${dump} ]`, `ls ${inputDir}/*.log`, `ls ${home}/dumps/*.sql`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
    // anything that reads it does not: and a metadata program does not lend its name to another segment
    expect(bash(`wc -l ${dump}; cat ${dump}`)).not.toBeNull();
    expect(bash(`ls ${dump} && head ${dump}`)).not.toBeNull();
  });

  test('recursive readers over a dir that holds the dump or an input are denied, like the Grep tool', () => {
    for (const cmd of [
      `grep -r foo ${home}/dumps`,
      `grep -R foo ${home}`,
      `grep -rn foo ${home}/logs`,
      `grep --recursive foo ${inputDir}`,
      `grep -d recurse foo ${home}/dumps`,
      `grep -r -e foo ${home}/dumps`,
      `egrep -ri foo ~`,
      `rg foo ${home}/dumps`,
      `rg foo ${home}`,
      `ag foo ${home}/logs`,
      `ack foo ${home}`,
      `tar czf /tmp/o.tgz ${home}/dumps`,
      `tar -cf - ${home}`,
      `zip -r /tmp/o.zip ${home}/inputs`,
      `cp -r ${home}/dumps /tmp/d`,
      `cp -R ${home}/logs /tmp/l`,
      `cp -a ${home} /tmp/h`,
      `cp --recursive ${home}/dumps /tmp/d`,
      `rsync -a ${home}/dumps/ /tmp/d/`,
      `scp -r ${home}/dumps host:/tmp`,
      `cd ${home}/dumps && rg foo`,
      `cd ${home}/dumps && grep -r foo`,
      `cd ${home} && grep -r foo .`,
      `grep -r foo /`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/recursive reader|dump or an input log/)]);
    }
    for (const cmd of [
      'grep -r foo src',
      'grep -r foo .',
      'rg foo',
      'rg foo src',
      'tar czf /tmp/o.tgz src',
      'cp -r src /tmp/src2',
      `cp ${home}/dumps/other.sql /tmp/o.sql`,
      `grep foo ${home}/dumps/other.sql`,
      `grep -r foo ${home}/dumps/other.sql`,
      `rg foo ${repo}/src`,
      `cd ${repo}/src && grep -r foo`,
      `rsync -a src/ /tmp/src/`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('a command the rule cannot read in time is denied, not skipped: a long word, many words, a long command', () => {
    const TOO = /too long to check/;
    expect(bash(`cat ${home}/dumps/${'a'.repeat(2500)}/../dump.sql`)).toMatch(TOO);
    expect(bash(`echo ${'x'.repeat(2100)}`)).toMatch(TOO);
    expect(bash(`cat ${Array.from({ length: 410 }, (_, i) => `a${i}`).join(' ')} ${dump}`)).toMatch(TOO);
    expect(bash(`cat ${Array.from({ length: 410 }, (_, i) => `a${i}`).join(' ')}`)).toMatch(TOO);
    expect(bash(`echo ${'y '.repeat(60_000)}`)).toMatch(TOO);
    // as many words as the cap, each short: read
    expect(bash(`echo ${Array.from({ length: 300 }, (_, i) => `a${i}`).join(' ')}`)).toBeNull();
    // a project that holds nothing is not asked
    const plain = join(base, 'plain');
    sandboxIn(plain, { dump: null, dumpFormat: null, realData: false });
    expect(bash(`echo ${'x'.repeat(2100)}`, plain)).toBeNull();
  });

  test('goodboy\'s own sandbox commands pass, naming the dump or an input', () => {
    const cli = OWN_CLI;
    for (const cmd of [
      `bun ${cli} sandbox-local --dump ${dump}`,
      `bun "$GB/lib/cli.ts" sandbox-local --input ${log}`,
      `bun ${cli} sandbox-data schema`,
      `bun ${cli} sandbox-data pick users --where '{"col":"id","op":"not-null"}'`,
      `bun ${cli} sandbox-run --suite unit -- ./gradlew test`,
      `bun ${cli} sandbox-up`,
      `bun ${cli} sandbox-check`,
      `bun ${cli} sandbox-down --volumes`,
      `node ${cli} sandbox-init --force`,
      `bun "$CLAUDE_PLUGIN_ROOT/lib/cli.ts" sandbox-data count users`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
    // only a sandbox command of goodboy's CLI passes: other commands of it, and other scripts, are read as any command
    expect(bash(`bun ${cli} review-write ${dump}`)).not.toBeNull();
    expect(bash(`bun ./cli.ts sandbox-local --dump ${dump}`)).not.toBeNull();
    // a script that is named `lib/cli.ts` and is not this plugin's is read as any command: a path is the file it is, not its look
    expect(bash(`bun /opt/plugin/lib/cli.ts sandbox-local --dump ${dump}`)).not.toBeNull();
    const planted = put(join(repo, 'lib', 'cli.ts'), 'console.log(1)');
    expect(planted).toContain('lib/cli.ts');
    expect(bash(`bun ./lib/cli.ts sandbox-data schema; cat ${dump}`)).not.toBeNull();
    expect(bash(`bun ./lib/cli.ts sandbox-local --dump ${dump}`)).not.toBeNull();
    expect(bash(`bun lib/cli.ts sandbox-local --input ${log}`)).not.toBeNull();
    rmSync(join(repo, 'lib'), { recursive: true, force: true });
    expect(bash(`bun ${cli} sandbox-data schema; cat ${dump}`)).not.toBeNull();
  });

  test('a glob is matched by a linear matcher: stars, ?, classes, and the path-part limit', () => {
    expect(globMatches(`${home}/dumps/*.sql`, dump)).toBe(true);
    expect(globMatches(`${home}/dumps/*.csv`, dump)).toBe(false);
    expect(globMatches(`${home}/dumps/d?mp.sql`, dump)).toBe(true);
    expect(globMatches(`${home}/*.sql`, dump)).toBe(false);
    expect(globMatches(`${home}/*/dump.sql`, dump)).toBe(true);
    expect(globMatches(`${home}/dumps/[a-e]ump.sql`, dump)).toBe(true);
    expect(globMatches(`${home}/dumps/[!a-e]ump.sql`, dump)).toBe(false);
    expect(globMatches(`${home}/dumps/[^a-e]ump.sql`, dump)).toBe(false);
    expect(globMatches(`${home}/dumps/\\*.sql`, dump)).toBe(false);
    expect(globMatches('/a/*b*c*', '/a/xbxcx')).toBe(true);
    expect(globMatches('/a/*b*c*', '/a/xcxbx')).toBe(false);
    expect(globMatches('/a/*', '/a/b/c')).toBe(false); // one star stays inside a path part
    expect(globMatches('/a/**', '/a/b/c')).toBe(true); // and `**` crosses `/`
    expect(globMatches('/a/**/c', '/a/c')).toBe(true); // zero dirs, as zsh and bash with globstar read it
    expect(globMatches('/a/**/c', '/a/b/x/c')).toBe(true);
    expect(globMatches('/a/**/c', '/a/b/x/d')).toBe(false);
    expect(globMatches(`${home}/{dumps,logs}/*`, dump)).toBe(true);
    expect(globMatches(`${home}/{dumps,logs}/*.csv`, dump)).toBe(false);
    expect(globMatches(`${home}/dumps/dump.{sql,csv}`, dump)).toBe(true);
    expect(globMatches(`${home}/dumps/{d,x}{u,y}mp.sql`, dump)).toBe(true);
    expect(globMatches(`${home}/dumps/{a,{b,d}}ump.sql`, dump)).toBe(true); // nested
    expect(globMatches('/a/{x}', '/a/{x}')).toBe(true); // a brace with no comma is text
    expect(globMatches(`${home}/dumps/[[:alpha:]]ump.sql`, dump)).toBe(true);
    expect(globMatches(`${home}/dumps/[[:digit:]]ump.sql`, dump)).toBe(false);
    expect(globMatches(`${home}/dumps/[[:alnum:]_]ump.sql`, dump)).toBe(true);
    expect(globMatches('/x/[[:nope:]]', '/x/b')).toBeNull();
    expect(globMatches(`${home}/dumps/@(dump|x).sql`, dump)).toBeNull(); // an extended glob: not read here, denied by the caller
    expect(globMatches(`${home}/dumps/!(x).sql`, dump)).toBeNull();
    expect(globMatches(`/x/{${Array.from({ length: 70 }, (_, i) => `a${i}`).join(',')}}`, '/x/a1')).toBeNull(); // past 64 alternatives
    expect(globMatches('a'.repeat(5000), 'a')).toBeNull();
    expect(globMatches('/x/[z-a]', '/x/b')).toBeNull(); // a class that is no class: unreadable, not thrown
    expect(bash(`cat ${home}/dumps/[z-a]ump.sql`)).toMatch(/dump or an input log/); // and a pattern goodboy cannot read is denied
    expect(bash(`cat ${home}/dumps/*.csv`)).toBeNull();
    expect(bash(`cat ${home}/logs/*.csv`)).toBeNull();
  });

  test('a run of stars takes no more time than a short one (it backtracked exponentially: 16 stars took 23 s)', () => {
    const stars = '*'.repeat(40);
    const t0 = performance.now();
    expect(globMatches(`${home}/dumps/${stars}.sql`, dump)).toBe(true);
    expect(globMatches(`${home}/dumps/${stars}.zzz`, dump)).toBe(false);
    expect(globMatches(`${stars}${'?*'.repeat(30)}x`, `${home}/dumps/dump.sqlx`)).toBe(false);
    expect(bash(`cat ${home}/dumps/${stars}.sql`)).toMatch(/dump or an input log/);
    expect(bash(`cat ${home}/dumps/${stars}.zzz`)).toBeNull();
    expect(bash(`ls ${home}/inputs/${'*?'.repeat(40)}.zz`)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
  });

  test('the CLI shape that is goodboy\'s own: this plugin\'s file by its real path, not by a name', () => {
    expect(isGoodboySandboxCli(['bun', OWN_CLI, 'sandbox-run'])).toBe(true);
    expect(isGoodboySandboxCli(['bun', '--bun', OWN_CLI, 'sandbox-data', 'schema'])).toBe(true);
    expect(isGoodboySandboxCli(['bun', '$GB/lib/cli.ts', 'sandbox-run'])).toBe(true);
    expect(isGoodboySandboxCli(['bun', '${CLAUDE_PLUGIN_ROOT}/lib/cli.ts', 'sandbox-run'])).toBe(true);
    expect(isGoodboySandboxCli(['bun', OWN_CLI, 'test-write'])).toBe(false);
    expect(isGoodboySandboxCli(['bun', '/p/lib/cli.ts', 'sandbox-run'])).toBe(false);
    expect(isGoodboySandboxCli(['bun', './lib/cli.ts', 'sandbox-run'], '/somewhere/else')).toBe(false);
    expect(isGoodboySandboxCli(['bun', '$GB/cli.ts', 'sandbox-run'])).toBe(false);
    expect(isGoodboySandboxCli(['bun', '/p/cli.ts', 'sandbox-run'])).toBe(false);
    expect(isGoodboySandboxCli(['sh', OWN_CLI, 'sandbox-run'])).toBe(false);
    expect(isGoodboySandboxCli(['bun'])).toBe(false);
  });

  test('a link to the plugin\'s CLI is the plugin\'s CLI (the real path is compared)', () => {
    const link = join(base, 'cli-link.ts');
    symlinkSync(OWN_CLI, link);
    expect(isGoodboySandboxCli(['bun', link, 'sandbox-data', 'schema'])).toBe(false); // not named lib/cli.ts: the shape is the rule too
    mkdirSync(join(base, 'viaLink', 'lib'), { recursive: true });
    symlinkSync(OWN_CLI, join(base, 'viaLink', 'lib', 'cli.ts'));
    expect(isGoodboySandboxCli(['bun', join(base, 'viaLink', 'lib', 'cli.ts'), 'sandbox-data', 'schema'])).toBe(true);
    rmSync(join(base, 'viaLink'), { recursive: true, force: true });
  });
});

describe('Read, Grep and Glob', () => {
  test('the dump and an input, direct, through a link, or in an input dir, are denied', () => {
    for (const p of [dump, log, join(inputDir, 'a.log'), join(repo, 'link.sql'), 'link.sql', '../home/dumps/dump.sql', `${home}/dumps/../dumps/dump.sql`, '~/dumps/dump.sql']) {
      expect([p, tool('Read', { file_path: p })]).toEqual([p, expect.stringMatching(/dump or an input log/)]);
    }
    expect(tool('Grep', { pattern: 'COPY', path: dump })).toMatch(/dump or an input log/);
    expect(tool('Grep', { pattern: 'x', path: inputDir })).toMatch(/Grep/);
    expect(tool('Glob', { pattern: `${home}/dumps/*.sql` })).toMatch(/Glob/);
    expect(tool('Glob', { pattern: `${inputDir}/*.log` })).toMatch(/Glob/);
    expect(tool('Glob', { pattern: '*.sql', path: join(home, 'dumps') })).toBeNull(); // names of the files of a dir, not their content
  });

  test('a search over the dir that holds the dump, or over the home dir, would read it', () => {
    expect(tool('Grep', { pattern: 'x', path: join(home, 'dumps') })).toMatch(/holds the dump/);
    expect(tool('Grep', { pattern: 'x', path: home })).toMatch(/holds the dump/);
    // a Glob lists names only: the dir above the dump is no read of it (the dump itself, and an input dir as `path`, are)
    expect(tool('Glob', { pattern: '**/*', path: base })).toBeNull();
    expect(tool('Glob', { pattern: '*', path: inputDir })).toMatch(/Glob/);
    expect(tool('Grep', { pattern: 'x', path: join(home, 'logs') })).toMatch(/holds the dump or an input/);
  });

  test('ordinary files and dirs pass', () => {
    expect(tool('Read', { file_path: join(repo, 'README.md') })).toBeNull();
    expect(tool('Read', { file_path: 'src/a.txt' })).toBeNull();
    expect(tool('Read', { file_path: join(home, 'dumps', 'other.sql') })).toBeNull();
    expect(tool('Grep', { pattern: 'x', path: join(repo, 'src') })).toBeNull();
    expect(tool('Grep', { pattern: 'x' })).toBeNull();
    expect(tool('Glob', { pattern: '**/*.ts' })).toBeNull();
    expect(tool('Glob', { pattern: '**/*.ts', path: repo })).toBeNull();
    expect(tool('Edit', { file_path: dump })).toBeNull(); // no tool but these three reads, and a shell command
    expect(tool('Read', {})).toBeNull();
  });

  test('raw output a sandbox left on the host: out/live, and the raw files of a run dir', () => {
    const out = join(repo, '.goodboy', 'sandbox', 'out');
    const live = put(join(out, 'live', 'access.log'));
    const rawLog = put(join(out, '20260101T000000Z', 'output.log'));
    const art = put(join(out, '20260101T000000Z', 'e2e-artifacts', 'trace.zip'));
    const result = put(join(out, '20260101T000000Z', 'result.json'), '{}');
    for (const p of [live, rawLog, art, join(out, 'live', 'anything')]) expect([p, tool('Read', { file_path: p })]).toEqual([p, expect.stringMatching(/raw output/)]);
    expect(tool('Read', { file_path: result })).toBeNull();
    expect(tool('Grep', { pattern: 'x', path: join(out, '20260101T000000Z') })).toMatch(/raw output/);
    expect(tool('Grep', { pattern: 'x', path: out })).toMatch(/raw output/);
    rmSync(out, { recursive: true, force: true });
    // with nothing raw left, the run dir's own files may be searched
    put(join(out, '20260101T000000Z', 'result.json'), '{}');
    expect(tool('Grep', { pattern: 'x', path: join(out, '20260101T000000Z') })).toBeNull();
    rmSync(out, { recursive: true, force: true });
  });
});

describe('any tool whose input is a shell command', () => {
  test('Monitor and PowerShell are read like Bash; a tool with no command is not read', () => {
    for (const toolName of ['Bash', 'Monitor', 'PowerShell', 'SomeNewShellTool']) {
      expect(tool(toolName, { command: `docker logs -f ${P}-db-1` })).toMatch(/docker logs/);
      expect(tool(toolName, { command: `cat ${dump}` })).toMatch(/dump or an input log/);
      expect(tool(toolName, { command: 'docker ps' })).toBeNull();
    }
    expect(tool('Monitor', { pid: 1 })).toBeNull();
    expect(tool('Write', { file_path: dump, content: 'x' })).toBeNull();
    expect(tool('Agent', { prompt: `docker exec ${P}-db-1 sh` })).toBeNull();
  });
});

describe('projects the rule leaves alone, and those it holds', () => {
  const DENIED_CMD = 'docker exec gb-abc-db-1 sh';

  test('a plain project (local.json says no real data) and a dir with no sandbox are untouched', () => {
    const plain = join(base, 'plain');
    sandboxIn(plain, { dump: null, dumpFormat: null, realData: false });
    expect(bash(DENIED_CMD, plain)).toBeNull();
    expect(bash(`cat ${dump}`, plain)).toBeNull();
    expect(tool('Read', { file_path: dump }, plain)).toBeNull();
    const none = join(base, 'nosandbox');
    mkdirSync(none, { recursive: true });
    expect(bash(DENIED_CMD, none)).toBeNull();
    expect(bash('docker compose -f .goodboy/sandbox/compose.yml exec db sh', none)).toBeNull();
  });

  test('a compose file with no local.json is no longer held by itself (the sandbox commands write a plain one); an unreadable local.json and inputs alone hold', () => {
    const nolocal = join(base, 'nolocal');
    sandboxIn(nolocal, null);
    expect(bash(DENIED_CMD, nolocal)).toBeNull();
    const garbage = join(base, 'garbage');
    sandboxIn(garbage, '{not json');
    expect(bash(DENIED_CMD, garbage)).not.toBeNull();
    const inputsOnly = join(base, 'inputsonly');
    sandboxIn(inputsOnly, { dump: null, dumpFormat: null, inputs: [log] });
    expect(bash(DENIED_CMD, inputsOnly)).not.toBeNull();
    expect(bash(`cat ${log}`, inputsOnly)).toMatch(/dump or an input log/);
  });

  test('a command run from a subdirectory, and one that names a path in another project, hold the project of that path', () => {
    expect(bash(DENIED_CMD, join(repo, 'src'))).not.toBeNull();
    const plain = join(base, 'plain');
    sandboxIn(plain, { dump: null, dumpFormat: null, realData: false });
    // the shell is in a plain project, the command names the real-data project's sandbox
    expect(bash(`docker compose -f ${repo}/.goodboy/sandbox/compose.yml exec db sh`, plain)).not.toBeNull();
    expect(bash(`cat ${join(repo, 'link.sql')}`, plain)).not.toBeNull();
  });

  test('the session\'s project dir holds the shell\'s calls from a dir outside the project', () => {
    const away = join(base, 'away');
    mkdirSync(away, { recursive: true });
    const args = (command: string, also?: (string | undefined)[]) => ({ toolName: 'Bash', toolInput: { command }, cwd: away, projectCwd: away, ...(also ? { also } : {}) });
    expect(sandboxDataDenial(args(`cat ${dump}`))).toBeNull(); // nothing says which project this is
    expect(sandboxDataDenial(args(`cat ${dump}`, [repo]))).not.toBeNull();
    expect(sandboxDataDenial(args(`cat ${dump}`, [undefined, 'relative/dir', repo]))).not.toBeNull();
    expect(sandboxDataDenial(args('docker ps', [repo]))).toBeNull();
  });

  test('anything that is not a tool of this rule is not read', () => {
    expect(sandboxDataDenial({ toolName: 'Write', toolInput: { file_path: dump }, cwd: repo, projectCwd: repo })).toBeNull();
    expect(sandboxDataDenial({ toolName: 'Bash', toolInput: {}, cwd: repo, projectCwd: repo })).toBeNull();
    expect(sandboxDataDenial({ toolName: 'Bash', toolInput: { command: 7 }, cwd: repo, projectCwd: repo })).toBeNull();
  });
});

describe('the user-level registry holds a project wherever the shell is', () => {
  /** A real-data project the session never stands in: under a dir that is no repo, with its own local file or none. */
  function nested(name: string, o: { local?: boolean; sandboxDir?: boolean } = {}): { top: string; dump: string; input: string; project: string } {
    const top = join(base, 'parent', name);
    const d = put(join(base, 'parent-data', `${name}-dump.sql`), 'COPY x;');
    const input = put(join(base, 'parent-data', `${name}-access.log`), 'GET /');
    if (o.sandboxDir !== false) sandboxIn(top, o.local === false ? null : { dump: d, dumpFormat: 'sql', realData: true, inputs: [input] });
    else mkdirSync(top, { recursive: true });
    return { top: realpathSync(top), dump: d, input, project: projectName(top) };
  }
  const register = (n: { top: string; dump: string; input: string }): void => {
    expect(registerRealData(registryEntryOf(n.top, { dump: n.dump, dumpFormat: 'sql', realData: true, inputs: [n.input] }))).toBeNull();
  };
  const away = (): string => {
    const d = join(base, 'away');
    mkdirSync(d, { recursive: true });
    return d;
  };

  test('without the registry a nested project under a non-repo dir is not attributed; with it, its docker verbs and paths are held', () => {
    const n = nested('shop');
    expect(bash(`docker exec ${n.project}-db-1 psql`, away())).toBeNull();
    expect(bash(`cat ${n.dump}`, away())).toBeNull();
    register(n);
    expect(bash(`docker exec ${n.project}-db-1 psql`, away())).toMatch(/docker exec/);
    expect(bash(`docker logs ${n.project}-app-1`, away())).toMatch(/docker logs/);
    expect(bash(`cat ${n.dump}`, away())).toMatch(/dump or an input log/);
    expect(bash(`head ${n.input}`, away())).toMatch(/dump or an input log/);
    expect(tool('Read', { file_path: n.dump }, away())).toMatch(/dump or an input log/);
    expect(tool('Grep', { pattern: 'x', path: n.input }, away())).toMatch(/Grep/);
    expect(bash('docker ps', away())).toBeNull();
    expect(bash('cat README.md', away())).toBeNull();
  });

  test('a deleted .goodboy/sandbox, a deleted local.json and a corrupt local.json keep the registered project held', () => {
    const gone = nested('gone', { sandboxDir: false });
    const noLocal = nested('nolocal2', { local: false });
    register(gone);
    register(noLocal);
    for (const n of [gone, noLocal]) {
      expect(bash(`docker exec ${n.project}-db-1 sh`, away())).not.toBeNull();
      expect(bash(`cat ${n.dump}`, away())).not.toBeNull();
      expect(bash(`cat ${n.dump}`, n.top)).not.toBeNull();
    }
    // a walk that finds the sandbox dir of a registered project holds it even with no local.json: the compose file is its
    expect(bash(`docker compose -f ${noLocal.top}/.goodboy/sandbox/compose.yml exec db sh`, away())).not.toBeNull();
    expect(bash('docker compose -f .goodboy/sandbox/compose.yml exec db sh', noLocal.top)).not.toBeNull();
    const bad = nested('corrupt');
    register(bad);
    writeLocalGarbage(bad.top);
    expect(bash(`cat ${bad.dump}`, away())).not.toBeNull();
  });

  const writeLocalGarbage = (top: string): void => {
    put(join(top, '.goodboy', 'sandbox', 'local.json'), '{garbage');
  };

  test('a registry that cannot be read leaves the per-repo reading only: not everything is denied', () => {
    const n = nested('broken');
    register(n);
    expect(bash(`cat ${n.dump}`, away())).not.toBeNull();
    put(join(process.env.GOODBOY_REGISTRY_DIR!, 'real-data.json'), '{not the registry');
    expect(bash(`cat ${n.dump}`, away())).toBeNull();
    expect(bash('docker ps', away())).toBeNull();
    // the project the shell stands in is still held by its own file
    expect(bash(`cat ${n.dump}`, n.top)).not.toBeNull();
    expect(bash(`cat ${dump}`, repo)).not.toBeNull();
  });

  test('a plain project is in no registry and stays untouched', () => {
    const plain = join(base, 'plain');
    sandboxIn(plain, { dump: null, dumpFormat: null, realData: false });
    register(nested('other'));
    for (const cmd of ['docker exec web ls', 'docker logs web', 'cat README.md', `cat ${home}/dumps/other.sql`, 'docker compose -f docker-compose.yml exec web sh']) expect([cmd, bash(cmd, plain)]).toEqual([cmd, null]);
    // the registry holds the registered project's own names wherever the shell is, and only those: not a `gb-` name of another
    const other = nested('other');
    expect(bash(`docker exec ${other.project}-db-1 sh`, plain)).not.toBeNull();
    expect(bash('docker exec gb-abc-db-1 sh', plain)).toBeNull();
  });
});

describe('the text a denied call is told', () => {
  test('main session: what was reached, where the data is, and the one way past; a subagent: BLOCKED', () => {
    const hit = { what: 'docker exec (a sandbox container, volume or network)' };
    const main = sandboxDataMessage(hit, { cli: '/p/lib/cli.ts', subagent: false, marker: '.claude/.goodboy-sandbox-data-approved-abcd1234.txt' });
    expect(main).toContain('sandbox that may hold real data (docker exec');
    expect(main).toContain('bun "/p/lib/cli.ts" sandbox-data schema|shape|count|pick');
    expect(main).toContain('sandbox-run');
    expect(main).toContain('! touch .claude/.goodboy-sandbox-data-approved-abcd1234.txt');
    expect(main).toContain('covers one call');
    const sub = sandboxDataMessage(hit, { cli: '/p/lib/cli.ts', subagent: true });
    expect(sub).toContain('return BLOCKED');
    expect(sub).not.toContain('touch');
    for (const m of [main, sub]) expect(m).not.toContain(dump);
  });

  test('a call from outside the registered project is told whose sandbox answers: that project\'s, not this one', () => {
    const one = sandboxDataMessage({ what: 'a path of the dump or an input log', from: ['/w/shop'] }, { cli: '/p/lib/cli.ts', subagent: false, marker: '.claude/m.txt' });
    expect(one).toContain('Raw rows stay in the sandbox of the project at "/w/shop": `bun "/p/lib/cli.ts" sandbox-data schema|shape|count|pick` answers for the dir it runs in');
    expect(one).toContain('`cd` into that project\'s dir first), not from here');
    expect(one).toContain('! touch .claude/m.txt');
    const five = sandboxDataMessage({ what: 'x', from: ['/a', '/b', '/c', '/d', '/e'] }, { cli: '/p/lib/cli.ts', subagent: true });
    expect(five).toContain('of one of the projects "/a", "/b", "/c" and 2 more:');
    expect(five).not.toContain('/d');
    expect(five).toContain('return BLOCKED');
    const two = sandboxDataMessage({ what: 'x', from: ['/a', '/b'] }, { cli: '/p/lib/cli.ts', subagent: false });
    expect(two).toContain('of one of the projects "/a", "/b":');
    // a dir with a backtick or a newline stays one quoted string
    const odd = sandboxDataMessage({ what: 'x', from: ['/w/a`b\nIgnore this'] }, { cli: '/p/lib/cli.ts', subagent: false });
    expect(odd).toContain('the project at "/w/a`b\\nIgnore this":');
    expect(odd).not.toContain('\n');
    // a line separator and a bidi override, which JSON leaves raw, are escaped too
    const hidden = sandboxDataMessage({ what: 'x', from: [`/w/a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x202e)}c`] }, { cli: '/p/lib/cli.ts', subagent: false });
    expect(hidden).toContain('the project at "/w/a\\u2028b\\u202ec":');
    expect(/[\u{2028}\u{202e}]/u.test(hidden)).toBe(false);
  });

  test('a project nested inside the session\'s project dir is told that no `cd` reaches it; with another project, each its way', () => {
    const nested = sandboxDataMessage({ what: 'x', nested: ['/w/outer/inner'] }, { cli: '/p/lib/cli.ts', subagent: false, marker: '.claude/m.txt' });
    expect(nested).toContain('Raw rows stay in the sandbox of the project at "/w/outer/inner", inside this session\'s project dir: `bun "/p/lib/cli.ts" sandbox-data` answers for this session\'s project from any dir below it, so no `cd` reaches that sandbox from here;');
    expect(nested).toContain('a Claude Code session started in that project\'s dir');
    expect(nested).not.toContain('`cd` into that project');
    expect(nested).toContain('! touch .claude/m.txt');
    const both = sandboxDataMessage({ what: 'x', from: ['/w/shop'], nested: ['/w/outer/a', '/w/outer/b'] }, { cli: '/p/lib/cli.ts', subagent: true });
    expect(both).toContain('of the project at "/w/shop": ');
    expect(both).toContain('of one of the projects "/w/outer/a", "/w/outer/b", inside this session\'s project dir');
    expect(both.indexOf('/w/shop')).toBeLessThan(both.indexOf('/w/outer/a'));
    expect(both).toContain('return BLOCKED');
  });

  test('a shown dir escapes the invisible and direction characters it lists: DEL, C1 (U+0085), the Arabic letter mark, zero-width, bidi, BOM', () => {
    const at = (c: number): string => `/w/a${String.fromCodePoint(c)}b`;
    for (const c of [0x7f, 0x85, 0x9f, 0x61c, 0x200b, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202c, 0x202e, 0x2060, 0x2061, 0x2066, 0x2067, 0x2069, 0xfeff]) {
      expect([c, shownDir(at(c))]).toEqual([c, `"/w/a\\u${c.toString(16).padStart(4, '0')}b"`]);
    }
    // printable text stays as it is, Korean and other scripts included; JSON's own escapes stay
    for (const d of ['/w/가나다', '/w/ü é', '/w/a\u{a0}b', '/w/a\u{202f}b', '/w/a\u{2070}b']) expect(shownDir(d)).toBe(JSON.stringify(d));
    expect(shownDir('/w/a\tb')).toBe('"/w/a\\tb"');
  });

  test('the names are searched in the first 100000 characters of the words, read no further than that', () => {
    expect(wordsText(['a', 'b c', 'd'])).toBe('a\nb c\nd');
    expect(wordsText([])).toBe('');
    // one word longer than the cap is cut too
    expect(wordsText(['y'.repeat(150_000), 'z'])).toBe('y'.repeat(100_000));
    const words = Array.from({ length: 50_000 }, () => 'x'.repeat(10));
    let read = 0;
    const counted = new Proxy(words, {
      get(t, k, r) {
        if (typeof k === 'string' && /^\d+$/.test(k)) read++;
        return Reflect.get(t, k, r);
      },
    });
    expect(wordsText(counted)).toHaveLength(100_000);
    expect(read).toBeLessThanOrEqual(10_001);
  });

  test('a denial names what was reached, never the dump\'s path or a value', () => {
    for (const hit of [bash(`cat ${dump}`), bash(`docker exec ${P}-db-1 sh`), bash('psql -h db'), tool('Read', { file_path: log })]) {
      expect(hit).not.toBeNull();
      expect(hit).not.toContain(home);
      expect(hit).not.toContain(P);
    }
  });
});
