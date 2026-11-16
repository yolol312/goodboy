// Track M, M6b (plan §19), round 2 of the review: the two contexts of the rule (a real-data project the shell stands in, and
// a project only the registry knows), the raw output a run left on the host, paths held in variables, recursive readers
// (`find -exec`, `xargs`), programs that run their arguments, Korean paths in either Unicode form, and the registry file.
// The spawned hook is in tests/m6b-hook.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxDataDenial } from '../lib/sandbox-data-guard';
import { projectName } from '../lib/sandbox-mode';
import { registerRealData, registryEntryOf, registryFile } from '../lib/sandbox-registry';
import { put, sandboxIn } from './m6b-helpers';

let base = '';
let repo = '';
let home = '';
let dump = '';
let log = '';
let inputDir = '';
let registryDir = '';
const saved = { home: process.env.HOME, registry: process.env.GOODBOY_REGISTRY_DIR };

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-forms-')));
  repo = join(base, 'repo');
  home = join(base, 'home');
  dump = put(join(home, 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
  log = put(join(home, 'logs', 'app.log'));
  inputDir = join(home, 'inputs');
  put(join(inputDir, 'a.log'));
  put(join(repo, 'src', 'a.txt'));
  sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true, inputs: [log, inputDir] });
  process.env.HOME = home;
  registryDir = join(base, 'registry');
  process.env.GOODBOY_REGISTRY_DIR = registryDir;
});
afterAll(() => {
  for (const [k, v] of [['HOME', saved.home], ['GOODBOY_REGISTRY_DIR', saved.registry]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
  for (const d of ['plain', 'registry', 'korean', 'other', 'away']) rmSync(join(base, d), { recursive: true, force: true });
  rmSync(join(repo, '.goodboy', 'sandbox', 'out'), { recursive: true, force: true });
  rmSync(join(base, 'repo2'), { recursive: true, force: true });
});

const bash = (command: string, cwd = repo): string | null => sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd, projectCwd: cwd })?.what ?? null;
const tool = (toolName: string, toolInput: Record<string, unknown>, cwd = repo): string | null => sandboxDataDenial({ toolName, toolInput, cwd, projectCwd: cwd })?.what ?? null;
const OUT = (): string => join(repo, '.goodboy', 'sandbox', 'out');
const RUN = '20261101T000000Z';

describe('a plain project, with other projects in the registry, is not slowed or stopped', () => {
  const plainWithRegistry = (): { plain: string; other: string } => {
    const plain = join(base, 'plain');
    sandboxIn(plain, { dump: null, dumpFormat: null, realData: false });
    const other = join(base, 'other');
    sandboxIn(other, { dump: dump, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(other, { dump, dumpFormat: 'sql', realData: true, inputs: [log] }))).toBeNull();
    return { plain, other };
  };

  test('docker exec, logs, compose exec, an attached up and a client at `db` all pass', () => {
    const { plain } = plainWithRegistry();
    for (const cmd of [
      'docker exec web ls',
      'docker exec -it mydb psql -U me',
      'docker logs web',
      'docker logs -f gb-abc-db-1',
      'docker compose exec web sh',
      'docker compose -f docker-compose.yml exec web sh',
      'docker compose -f .goodboy/sandbox/compose.yml exec db sh',
      'docker compose up',
      'docker compose -f docker-compose.yml up',
      'docker exec $ID sh',
      'docker ps -aq | xargs docker logs',
      'psql -h db -U me app',
      'mysql -h db2 -u root',
      'curl --unix-socket /var/run/docker.sock http://localhost/containers/json',
      'watch docker logs web',
      'ssh host docker exec x sh',
    ]) {
      expect([cmd, bash(cmd, plain)]).toEqual([cmd, null]);
    }
  });

  test('the size caps are not asked of it: 450 files in `git add`, a 3000-character commit message, a 2.6 KB header', () => {
    const { plain } = plainWithRegistry();
    const files = Array.from({ length: 450 }, (_, i) => `src/file${i}.ts`).join(' ');
    expect(bash(`git add ${files}`, plain)).toBeNull();
    expect(bash(`git commit -m "${'a long message '.repeat(215)}"`, plain)).toBeNull();
    expect(bash(`curl -H "Authorization: ${'x'.repeat(2600)}" http://localhost:8080/`, plain)).toBeNull();
    expect(bash(`echo ${'y '.repeat(60_000)}`, plain)).toBeNull();
  });

  test('what the registry holds stays held from there: the project\'s own name, its dump and its inputs', () => {
    const { plain, other } = plainWithRegistry();
    const name = projectName(other);
    expect(bash(`docker exec ${name}-db-1 sh`, plain)).toMatch(/docker exec/);
    expect(bash(`docker logs ${name}-app-1`, plain)).toMatch(/docker logs/);
    expect(bash(`docker run --rm -v ${name}_db1data:/d busybox ls /d`, plain)).toMatch(/docker run/);
    expect(bash(`cat ${dump}`, plain)).toMatch(/dump or an input log/);
    expect(bash(`cat ${log}`, plain)).toMatch(/dump or an input log/);
    expect(bash(`cat ${home}/dumps/*`, plain)).toMatch(/dump or an input log/);
    expect(tool('Read', { file_path: dump }, plain)).toMatch(/dump or an input log/);
  });

  test('a hit from outside the registered project names that project: `sandbox-data` answers there, not here (live verify)', () => {
    const { plain, other } = plainWithRegistry();
    const from = (toolName: string, toolInput: Record<string, unknown>, cwd: string) => sandboxDataDenial({ toolName, toolInput, cwd, projectCwd: cwd })?.from;
    expect(from('Bash', { command: `cat ${dump}` }, plain)).toEqual([other]);
    expect(from('Bash', { command: `docker exec ${projectName(other)}-db-1 sh` }, plain)).toEqual([other]);
    expect(from('Read', { file_path: dump }, plain)).toEqual([other]);
    // a call inside a guarded project that reaches only its own data: sandbox-data answers from where it is
    expect(sandboxDataDenial({ toolName: 'Bash', toolInput: { command: `cat ${inputDir}/a.log` }, cwd: repo, projectCwd: repo })).toEqual({ what: 'a path of the dump or an input log' });
    expect(sandboxDataDenial({ toolName: 'Read', toolInput: { file_path: dump }, cwd: other, projectCwd: other })?.from).toBeUndefined();
  });

  test('with two registered projects, the one the call names by path or project name is told; a call naming none lists both', () => {
    const { plain, other } = plainWithRegistry();
    const second = join(base, 'repo2');
    const dump2 = put(join(second, 'data', 'b.sql'), 'COPY b FROM stdin;');
    sandboxIn(second, { dump: dump2, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(second, { dump: dump2, dumpFormat: 'sql', realData: true }))).toBeNull();
    const from = (toolName: string, toolInput: Record<string, unknown>) => sandboxDataDenial({ toolName, toolInput, cwd: plain, projectCwd: plain })?.from;
    expect(from('Bash', { command: `cat ${dump2}` })).toEqual([second]);
    expect(from('Read', { file_path: dump })).toEqual([other]);
    expect(from('Bash', { command: `docker logs ${projectName(second)}-app-1` })).toEqual([second]);
    // `~/dumps/dump.sql` names neither by its text: both are listed
    expect(from('Bash', { command: 'cat ~/dumps/dump.sql' })?.sort()).toEqual([other, second].sort());
    // a session in another real-data project is told the project it reached, not its own
    const inRepo = (command: string) => sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd: repo, projectCwd: repo })?.from;
    expect(inRepo(`cat ${dump2}`)).toEqual([second]);
    expect(inRepo(`docker exec ${projectName(second)}-db-1 sh`)).toEqual([second]);
    expect(inRepo(`docker exec ${projectName(repo)}-db-1 sh`)).toBeUndefined();
    // the words are read up to 100000 characters for the names (the hook answers before its timeout): a dump outside
    // its project's dir (found by its text, not by the walk) past them names nothing, so every guarded project is told
    const filler = Array.from({ length: 60 }, () => 'a'.repeat(2000)).join(' ');
    expect(from('Bash', { command: `cat ${filler} ${dump}` })?.sort()).toEqual([other, second].sort());
    expect(from('Bash', { command: `cat ${dump} ${filler}` })).toEqual([other]);
    // following the text: goodboy's own command run from that project's dir passes
    const cli = join(import.meta.dir, '..', 'lib', 'cli.ts');
    expect(sandboxDataDenial({ toolName: 'Bash', toolInput: { command: `cd "${second}" && bun "${cli}" sandbox-data schema` }, cwd: plain, projectCwd: plain })).toBeNull();
  });

  test('a call from a dir that holds a protected path is read to the caps: a word that long could be a path to it', () => {
    const { other } = plainWithRegistry();
    expect(bash(`echo ${'x'.repeat(2100)}`, other)).toMatch(/too long to check/);
    expect(bash(`cat ${Array.from({ length: 410 }, (_, i) => `a${i}`).join(' ')}`, other)).toMatch(/too long to check/);
  });
});

describe('raw output a run left on the host, through the shell', () => {
  const live = (): string => put(join(OUT(), 'live', 'output.log'), 'row 1');
  const rawRun = (): string => put(join(OUT(), RUN, 'output.log'), 'row 1');

  test('cat, head and a copy of out/live and of a run dir\'s raw files are denied, by every spelling', () => {
    live();
    rawRun();
    put(join(OUT(), RUN, 'e2e-artifacts', 'trace.zip'));
    put(join(OUT(), RUN, 'e2e-output.log'));
    for (const cmd of [
      `cat ${OUT()}/live/output.log`,
      `cat .goodboy/sandbox/out/live/output.log`,
      `head -3 ./.goodboy/sandbox/out/${RUN}/output.log`,
      `cat ${OUT()}/${RUN}/e2e-output.log`,
      `tail -f ${OUT()}/${RUN}/e2e-artifacts/trace.zip`,
      `cp ${OUT()}/live/output.log /tmp/x.log`,
      `cd .goodboy/sandbox/out && cat live/output.log`,
      `cd .goodboy/sandbox/out/${RUN} && cat output.log`,
      `cat .goodboy/sandbox/out/live/*`,
      `cat .goodboy/sandbox/out/${RUN}/{output.log,e2e-output.log}`,
      `grep -r row .goodboy/sandbox/out`,
      `rg row .goodboy/sandbox/out/live`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/raw output|recursive reader/)]);
    }
  });

  test('the files that are not raw, and listing, pass', () => {
    live();
    put(join(OUT(), RUN, 'result.json'), '{"realData": true}');
    for (const cmd of [`cat ${OUT()}/${RUN}/result.json`, `ls ${OUT()}/live`, `ls -la ${OUT()}`, `stat ${OUT()}/live/output.log`, 'cat .goodboy/sandbox/compose.yml']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('with nothing raw left, the run dir\'s own files may be read and searched', () => {
    put(join(OUT(), RUN, 'result.json'), '{"realData": false}');
    expect(bash(`cat ${OUT()}/${RUN}/result.json`)).toBeNull();
    expect(bash(`grep -r status ${OUT()}`)).toBeNull();
  });
});

describe('a path held in a variable, and a reader that is fed names', () => {
  test('an assignment with the path in it, then the use: denied at the assignment\'s text, as a word and as a prefix', () => {
    for (const cmd of [
      `DUMP=${dump}; head $DUMP`,
      `export F=${log} && tail -f $F`,
      `FILE=${dump} sh -c 'cat $FILE'`,
      `DUMP=~/dumps/dump.sql; cat $DUMP`,
      `DUMP=$HOME/dumps/dump.sql cat $DUMP`,
      `X=${inputDir}; for f in $X/*; do cat $f; done`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/dump or an input log/)]);
    }
  });

  test('a variable with another path in it, and a variable alone, pass', () => {
    for (const cmd of [`D=${home}/dumps; ls $D`, `F=${home}/dumps/other.sql; cat $F`, 'F=notes.txt; cat $F', 'cat $UNSET']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('a reader fed names by a pipe, in a dir that holds the dump or an input, is denied', () => {
    for (const cmd of [
      `cd ${home}/dumps && ls | xargs cat`,
      `cd ${home}/dumps && ls | xargs -n1 head`,
      `cd ${home}/logs; ls | xargs grep foo`,
      `find ${home}/dumps -type f | xargs cat`,
      `find ${home}/inputs -name '*.log' | xargs head -5`,
      `ls ${home}/dumps | xargs -I{} cat ${home}/dumps/{}`,
      `cd ${home}/dumps && find . -type f -print0 | xargs -0 cat`,
      `cd ${home}/dumps && cat $(ls)`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/dump or an input log|recursive reader|pipe or a substitution|fed the names/)]);
    }
    for (const cmd of [`cd ${repo}/src && ls | xargs cat`, `ls ${home}/dumps | xargs echo`, `find ${repo}/src -type f | xargs cat`, `cd ${home}/dumps && ls | xargs wc -l`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });
});

describe('find -exec, globs with braces, `**`, classes and extended forms', () => {
  test('find with an exec over a dir that holds the dump or an input is denied; without it, or elsewhere, it passes', () => {
    for (const cmd of [
      `find ${home}/dumps -type f -exec cat {} +`,
      `find ${home} -name '*.sql' -exec head {} \\;`,
      `find ${home}/logs -execdir cat {} \\;`,
      `find ${inputDir} -ok cat {} \\;`,
      `cd ${home}/dumps && find . -exec cat {} +`,
      `cd ${home}/dumps && find -exec cat {} +`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/recursive reader|dump or an input log/)]);
    }
    for (const cmd of [`find ${home}/dumps -type f`, `find ${home} -name '*.sql'`, `find ${repo}/src -exec cat {} +`, 'find . -name "*.ts" -exec wc -l {} +']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('braces, `**`, POSIX classes and extended globs that reach the dump are denied', () => {
    for (const cmd of [
      `cat ${home}/{dumps,logs}/*.sql`,
      `cat ${home}/dumps/dump.{sql,csv}`,
      `cat ${home}/{dumps,x}/d*`,
      `head ${home}/**/dump.sql`,
      `cat ${home}/**/*.sql`,
      `cat ${home}/dumps/[[:alpha:]]ump.sql`,
      `cat ${home}/dumps/[[:alnum:]]*`,
      `cat ${home}/dumps/@(dump|x).sql`,
      `cat ${home}/dumps/!(other).sql`,
      `cat ${home}/dumps/+(d)ump.sql`,
      `cat ${home}/dum{p,q}s/*`,
      `cat ${home}/dumps/dump.sql{,.bak}`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/dump or an input log/)]);
    }
    for (const cmd of [`cat ${home}/{dumps,logs}/*.csv`, `cat ${home}/dumps/other.{sql,csv}`, `cat ${home}/**/*.csv`, `cat ${home}/dumps/[[:digit:]]*`, `cat ${home}/x{a,b}/*`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('a brace list that cannot be read in the bound is read as the worst case', () => {
    const many = Array.from({ length: 70 }, (_, i) => `a${i}`).join(',');
    expect(bash(`cat ${home}/dumps/{${many}}`)).toMatch(/dump or an input log/);
  });

  test('Glob and Grep tools read the same patterns', () => {
    expect(tool('Glob', { pattern: `${home}/{dumps,logs}/*` })).toMatch(/Glob/);
    expect(tool('Glob', { pattern: `${home}/**/*.sql` })).toMatch(/Glob/);
    expect(tool('Glob', { pattern: `${home}/dumps/[[:alpha:]]*` })).toMatch(/Glob/);
    expect(tool('Glob', { pattern: `${home}/{x,y}/*` })).toBeNull();
  });
});

describe('programs that run their arguments or their input', () => {
  test('docker text with a deny verb through tmux, screen, at, batch, parallel, su -c and the like is denied', () => {
    for (const cmd of [
      `tmux new-session -d 'docker logs -f ${projectName(repo)}-app-1'`,
      `tmux send-keys 'docker exec x sh' Enter`,
      `screen -dmS s docker logs web`,
      `echo 'docker logs web' | at now`,
      `at now <<< 'docker exec x sh'`,
      `batch <<EOF\ndocker exec x sh\nEOF`,
      `parallel docker exec {} sh ::: a b`,
      `su -c "docker exec x sh" root`,
      `su root -c 'docker logs web'`,
      `watch docker logs web`,
      `ssh host docker exec x sh`,
      `colima ssh -- docker exec x sh`,
      `limactl shell colima docker logs web`,
      `script -q -c "docker exec x sh" /dev/null`,
      `unbuffer docker logs web`,
      `sh <<EOF\ndocker exec x sh\nEOF`,
      `echo 'docker exec x sh' | bash`,
      `echo 'docker exec x sh' | sh -s`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/cannot read|docker/)]);
    }
    for (const cmd of ['tmux ls', 'screen -ls', 'echo hi | at now', 'su -c "ls" root', 'parallel echo ::: a b', 'ssh host ls', 'echo "docker logs" | cat']) {
      expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    }
  });

  test('the command text of a wrapper is read for the dump too: a path in what `watch`, `ssh` or `su -c` runs', () => {
    for (const cmd of [`watch cat ${dump}`, `ssh host cat ${dump}`, `su -c 'cat ${dump}' root`, `tmux new 'cat ${log}'`]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/dump or an input log/)]);
    }
  });
});

describe('a Korean path in either Unicode form', () => {
  test('a dump under a Korean dir, typed decomposed or composed, is the same file', () => {
    const dir = join(base, 'home', '덤프'.normalize('NFC'));
    const korean = put(join(dir, '운영.sql'.normalize('NFC')), 'COPY x;');
    const proj = join(base, 'korean');
    sandboxIn(proj, { dump: korean, dumpFormat: 'sql', realData: true });
    for (const form of ['NFC', 'NFD'] as const) {
      const typed = korean.normalize(form);
      expect([form, bash(`cat ${typed}`, proj)]).toEqual([form, expect.stringMatching(/dump or an input log/)]);
      expect([form, tool('Read', { file_path: typed }, proj)]).toEqual([form, expect.stringMatching(/dump or an input log/)]);
      expect([form, bash(`cat ${dir.normalize(form)}/*.sql`, proj)]).toEqual([form, expect.stringMatching(/dump or an input log/)]);
    }
    expect(bash(`cat ${join(dir, 'other.sql').normalize('NFD')}`, proj)).toBeNull();
  });

  test('the registry keeps a Korean path as NFC: a project it holds is guarded from anywhere, whichever form the command types', () => {
    const dir = join(base, 'home', '로그'.normalize('NFD'));
    const input = put(join(dir, 'a.log'));
    const proj = join(base, 'other');
    sandboxIn(proj, { dump: null, dumpFormat: null, realData: true, inputs: [input] });
    expect(registerRealData(registryEntryOf(proj, { dump: null, dumpFormat: null, realData: true, inputs: [input] }))).toBeNull();
    const away = join(base, 'away');
    mkdirSync(away, { recursive: true });
    for (const form of ['NFC', 'NFD'] as const) expect([form, bash(`cat ${input.normalize(form)}`, away)]).toEqual([form, expect.stringMatching(/dump or an input log/)]);
  });
});

describe('the registry file: no command changes or removes it; reading it passes', () => {
  const registered = (): void => {
    const proj = join(base, 'other');
    sandboxIn(proj, { dump, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(proj, { dump, dumpFormat: 'sql', realData: true }))).toBeNull();
  };

  test('Write, Edit and a shell command that changes, moves or removes it or anything in its dir are denied', () => {
    registered();
    const file = registryFile();
    expect(file).toBe(join(registryDir, 'real-data.json'));
    for (const cmd of [
      `rm ${file}`,
      `rm -rf ${registryDir}`,
      `rm ${registryDir}/*`,
      `echo '{}' > ${file}`,
      `echo x >> ${file}`,
      `cat /dev/null >${file}`,
      `cat notes.txt > ${file}`,
      `cat notes.txt 1> ${registryDir}/real-data.json`,
      `sed -i s/a/b/ ${file}`,
      `mv ${file} /tmp/x`,
      `cp /tmp/x ${file}`,
      `tee ${file}`,
      `truncate -s 0 ${file}`,
      `dd if=/dev/null of=${file}`,
      `ln -sf /tmp/x ${file}`,
      `touch ${registryDir}/real-data.lock`,
      `cd ${registryDir} && rm real-data.json`,
      `cd ${registryDir} && echo x > real-data.json`,
      `find ${registryDir} -delete`,
      `rm -rf ${join(registryDir, '..')}`,
      `mv ${join(registryDir, '..')} /tmp/moved`,
      `python3 -c "open('${file}','w')" ${file}`,
    ]) {
      expect([cmd, bash(cmd)]).toEqual([cmd, expect.stringMatching(/change to the registry/)]);
    }
    expect(tool('Write', { file_path: file, content: '{}' })).toMatch(/registry/);
    expect(tool('Edit', { file_path: file, old_string: 'a', new_string: 'b' })).toMatch(/registry/);
    expect(tool('MultiEdit', { file_path: file, edits: [] })).toMatch(/registry/);
    expect(tool('Write', { file_path: join(registryDir, 'real-data.lock'), content: '' })).toMatch(/registry/);
    expect(tool('Write', { file_path: join(registryDir, 'new.json'), content: '' })).toMatch(/registry/);
    // a link to it is it
    symlinkSync(file, join(base, 'away-link.json'));
    expect(tool('Write', { file_path: join(base, 'away-link.json'), content: '{}' })).toMatch(/registry/);
    rmSync(join(base, 'away-link.json'));
  });

  test('reading it, and recursive readers over ~ or ~/.claude, pass: the registry holds paths, not data', () => {
    // a registered project whose data is outside HOME, and a shell that is not in the real-data repo
    const data = put(join(base, 'data', 'x.sql'), 'COPY x;');
    const proj = join(base, 'other');
    sandboxIn(proj, { dump: data, dumpFormat: 'sql', realData: true });
    expect(registerRealData(registryEntryOf(proj, { dump: data, dumpFormat: 'sql', realData: true }))).toBeNull();
    const away = join(base, 'away');
    mkdirSync(away, { recursive: true });
    const file = registryFile();
    for (const cmd of [`cat ${file}`, `head ${file}`, `cat ${registryDir}/*.json`, `grep top ${file}`, `jq . ${file}`, `ls -la ${registryDir}`, `stat ${file}`, `wc -c ${file}`, `grep -r foo ${registryDir}`, `rg foo ${registryDir}`, 'rg foo ~', 'grep -r foo ~/.claude', `grep -rn foo ${join(home, '.claude')}`, `tar czf /tmp/x.tgz ${join(home, '.claude')}`, `find ${join(home, '.claude')} -exec cat {} +`]) {
      expect([cmd, bash(cmd, away)]).toEqual([cmd, null]);
    }
    expect(tool('Read', { file_path: file }, away)).toBeNull();
    expect(tool('Grep', { pattern: 'top', path: registryDir }, away)).toBeNull();
    expect(tool('Grep', { pattern: 'foo' }, join(home, '.claude'))).toBeNull();
    expect(tool('Grep', { pattern: 'foo' }, away)).toBeNull();
    expect(tool('Glob', { pattern: `${registryDir}/*` }, away)).toBeNull();
    // the data itself is still held
    expect(bash(`cat ${data}`, away)).toMatch(/dump or an input log/);
    expect(bash(`grep -r foo ${join(base, 'data')}`, away)).toMatch(/recursive reader/);
  });

  test('other files are not touched by it: a Write elsewhere; the registry dir is held before it exists', () => {
    registered();
    expect(tool('Write', { file_path: join(repo, 'src', 'new.ts'), content: 'x' })).toBeNull();
    expect(tool('Edit', { file_path: join(repo, 'src', 'a.txt'), old_string: 'x', new_string: 'y' })).toBeNull();
    for (const cmd of ['rm -rf build', 'echo x > out.txt', `rm ${home}/x.txt`, 'mv a b', `cd ${repo} && rm -f tmp.txt`]) expect([cmd, bash(cmd)]).toEqual([cmd, null]);
    // the dir is the registry's whether or not it is there yet: a model does not make it
    rmSync(registryDir, { recursive: true, force: true });
    expect(tool('Write', { file_path: join(registryDir, 'real-data.json'), content: '{}' })).toMatch(/registry/);
    expect(bash(`echo '{}' > ${join(registryDir, 'real-data.json')}`)).toMatch(/change to the registry/);
  });

  test('a registry that cannot be read is told to the caller, and nothing more is denied for it', () => {
    put(registryFile(), '{broken');
    const notes: string[] = [];
    const hit = sandboxDataDenial({ toolName: 'Bash', toolInput: { command: 'docker ps' }, cwd: repo, projectCwd: repo, note: (n) => notes.push(n) });
    expect(hit).toBeNull();
    expect(notes).toEqual(['registry-unreadable']);
    expect(bash(`cat ${dump}`)).toMatch(/dump or an input log/); // the project the shell stands in is still held by its own file
    expect(bash('docker exec web ls')).toBeNull();
    // and a change to it is refused all the same
    expect(bash(`rm ${registryFile()}`)).toMatch(/change to the registry/);
  });
});
