// Track M, M6b (plan §19): the real-data sandbox rule through the spawned PreToolUse hook, the way
// tests/outward-gate-hooks.test.ts runs R2: each denied form, the passing forms, the user's one-use marker, the env
// switch, Read/Grep/Glob, a subagent's payload, and projects the rule leaves alone.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { projectName } from '../lib/sandbox-mode';
import { registerRealData, registryEntryOf } from '../lib/sandbox-registry';
import { CLI } from './m6a-project';
import { put, sandboxIn } from './m6b-helpers';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');

let base = '';
let repo = '';
let home = '';
let dump = '';
let log = '';
let P = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-hook-')));
  repo = join(base, 'repo');
  home = join(base, 'home');
  dump = put(join(home, 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
  log = put(join(home, 'logs', 'app.log'));
  put(join(repo, 'README.md'));
  symlinkSync(dump, join(repo, 'link.sql'));
  sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true, inputs: [log] });
  P = projectName(repo);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

interface Call {
  tool?: string;
  input?: Record<string, unknown>;
  sub?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}
interface Result {
  denied: boolean;
  reason: string;
  system: string;
}

/** One session: every call is a fresh hook process with the same session id, TMPDIR and HOME. */
function session(cwdDefault?: string) {
  const sid = `m6b-${Math.random().toString(36).slice(2)}`;
  const call = async (c: Call): Promise<Result> => {
    const cwd = c.cwd ?? cwdDefault ?? repo;
    const payload = {
      session_id: sid,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: c.tool ?? 'Bash',
      tool_input: c.input ?? {},
      tool_use_id: `t-${Math.random().toString(36).slice(2)}`,
      ...(c.sub ? { agent_type: 'goodboy:build-infra', agent_id: 'b1' } : {}),
    };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, HOME: home, GOODBOY_REGISTRY_DIR: join(base, 'registry'), ...(c.env ?? {}) },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', system: String(out.systemMessage ?? '') };
  };
  const bash = (command: string, o: Omit<Call, 'tool' | 'input'> = {}): Promise<Result> => call({ ...o, input: { command } });
  const marker = (): string => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    const p = join(repo, `.claude/.goodboy-sandbox-data-approved-${sid.slice(0, 8)}.txt`);
    writeFileSync(p, '');
    return p;
  };
  return { sid, call, bash, marker };
}

describe('Bash', () => {
  test('each denied form is stopped with the reason, the way to the data and the way past', async () => {
    const s = session();
    const forms = [
      `docker exec -it ${P}-db-1 psql -U sandbox`,
      `docker cp ${P}-db-1:/var/lib/postgresql/data /tmp/x`,
      `docker logs ${P}-app-1`,
      `docker inspect gb-abc-app-1`,
      'docker compose -f .goodboy/sandbox/compose.yml exec db sh',
      `docker run --rm -v ${P}_db1data:/d busybox ls /d`,
      'docker exec $ID sh',
      'curl --unix-socket /var/run/docker.sock http://localhost/containers/json',
      'psql -h db -U sandbox shop',
      `cat ${dump}`,
      `head -3 ${log}`,
      'cat link.sql',
    ];
    const results = await Promise.all(forms.map((f) => s.bash(f)));
    results.forEach((r, i) => {
      expect([forms[i], r.denied]).toEqual([forms[i], true]);
      expect(r.reason).toContain('sandbox that may hold real data');
      expect(r.reason).toContain('sandbox-data schema|shape|count|pick');
      expect(r.reason).toContain('sandbox-run');
      expect(r.reason).toContain(`! touch .claude/.goodboy-sandbox-data-approved-${s.sid.slice(0, 8)}.txt`);
      expect(r.reason).not.toContain(dump);
      expect(r.system).toContain('[goodboy]');
    });
  });

  test('ordinary docker use, goodboy\'s own sandbox commands and other files pass', async () => {
    const s = session();
    for (const c of ['docker ps', 'docker images', 'docker compose ps', 'docker exec web ls', `bun ${CLI} sandbox-data schema`, `bun ${CLI} sandbox-local --dump ${dump}`, `bun ${CLI} sandbox-run --suite unit`, 'cat README.md', `cat ${home}/dumps/other.sql`, 'psql -h localhost -U me']) {
      const r = await s.bash(c);
      expect([c, r.denied, r.reason]).toEqual([c, false, '']);
    }
  });

  test('the dir the shell is in does not matter: from a subdirectory, and a command naming the project from outside', async () => {
    const s = session();
    mkdirSync(join(repo, 'src'));
    expect((await s.bash(`docker exec ${P}-db-1 sh`, { cwd: join(repo, 'src') })).denied).toBe(true);
    // the shell has gone to a dir outside the project: CLAUDE_PROJECT_DIR still says which project the session is in
    const other = join(base, 'other');
    mkdirSync(other);
    const env = { CLAUDE_PROJECT_DIR: repo };
    expect((await s.bash(`cat ${dump}`, { cwd: other, env })).denied).toBe(true);
    expect((await s.call({ cwd: other, env, tool: 'Read', input: { file_path: log } })).denied).toBe(true);
    expect((await s.bash('docker ps', { cwd: other, env })).denied).toBe(false);
    // and a project that is only named: the path points into it
    expect((await s.bash(`cat ${join(repo, 'link.sql')}`, { cwd: other })).denied).toBe(true);
  });

  test('the Monitor tool and any tool with a shell command are read like Bash (the hook matcher is every tool)', async () => {
    const s = session();
    const matcher = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].matcher;
    expect(matcher).toBe('*');
    for (const tool of ['Monitor', 'PowerShell']) {
      const r = await s.call({ tool, input: { command: `docker logs -f ${P}-db-1` } });
      expect([tool, r.denied]).toEqual([tool, true]);
      expect((await s.call({ tool, input: { command: `tail -f ${log}` } })).denied).toBe(true);
      expect((await s.call({ tool, input: { command: 'docker ps' } })).denied).toBe(false);
    }
    // a tool with no command and no path is passed at once
    expect((await s.call({ tool: 'Agent', input: { prompt: `docker exec ${P}-db-1 sh` } })).denied).toBe(false);
  });

  test('a registered project is held from a shell that is nowhere near it, and a project that is not registered is not', async () => {
    const s = session();
    const away = join(base, 'away');
    mkdirSync(away);
    const cmd = `docker logs ${P}-app-1`;
    // nothing in the session leads to the project (no CLAUDE_PROJECT_DIR, no path of it in the command)
    expect((await s.bash(cmd, { cwd: away })).denied).toBe(false);
    expect((await s.bash(`cat ${dump}`, { cwd: away })).denied).toBe(false);
    const env = { GOODBOY_REGISTRY_DIR: join(base, 'registry') };
    expect(registerRealData(registryEntryOf(repo, { dump, dumpFormat: 'sql', realData: true, inputs: [log] }), env)).toBeNull();
    expect((await s.bash(cmd, { cwd: away })).denied).toBe(true);
    expect((await s.bash(`cat ${dump}`, { cwd: away })).denied).toBe(true);
    expect((await s.call({ cwd: away, tool: 'Read', input: { file_path: log } })).denied).toBe(true);
    expect((await s.bash('docker ps', { cwd: away })).denied).toBe(false);
    // the registry holds it even with the project's own files gone
    rmSync(join(repo, '.goodboy'), { recursive: true, force: true });
    expect((await s.bash(`cat ${dump}`, { cwd: away })).denied).toBe(true);
  });

  test('the user\'s marker lets one command through; the next is denied again', async () => {
    const s = session();
    const cmd = `docker exec ${P}-db-1 psql -U sandbox -c 'select 1'`;
    expect((await s.bash(cmd)).denied).toBe(true);
    const m = s.marker();
    expect((await s.bash(cmd)).denied).toBe(false);
    expect(existsSync(m)).toBe(false);
    expect((await s.bash(cmd)).denied).toBe(true);
  });

  test('a marker of another session unlocks nothing', async () => {
    const s = session();
    const other = session();
    other.marker();
    expect((await s.bash(`cat ${dump}`)).denied).toBe(true);
  });

  test('a subagent has no marker: its call is denied with BLOCKED, and the marker stays for the main session', async () => {
    const s = session();
    const m = s.marker();
    const r = await s.bash(`docker exec ${P}-db-1 sh`, { sub: true });
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('return BLOCKED');
    expect(r.reason).not.toContain('touch');
    expect(existsSync(m)).toBe(true);
    expect((await s.bash(`docker exec ${P}-db-1 sh`)).denied).toBe(false);
  });

  test('a subagent\'s ordinary commands pass, and its docker, socket and dump reads do not', async () => {
    const s = session();
    expect((await s.bash('docker ps', { sub: true })).denied).toBe(false);
    expect((await s.bash('ls', { sub: true })).denied).toBe(false);
    for (const c of [`docker logs ${P}-app-1`, `cat ${dump}`, 'psql -h db2 -U x', 'curl --unix-socket /var/run/docker.sock http://x/containers/json']) expect([c, (await s.bash(c, { sub: true })).denied]).toEqual([c, true]);
  });

  test('GOODBOY_SANDBOX_DATA_GATE=off turns the rule off', async () => {
    const s = session();
    const env = { GOODBOY_SANDBOX_DATA_GATE: 'off' };
    expect((await s.bash(`docker exec ${P}-db-1 sh`, { env })).denied).toBe(false);
    expect((await s.call({ tool: 'Read', input: { file_path: dump }, env })).denied).toBe(false);
    expect((await s.bash(`docker exec ${P}-db-1 sh`, { env: { GOODBOY_SANDBOX_DATA_GATE: 'on' } })).denied).toBe(true);
  });

  test('the model cannot make the marker: a Bash or Write to its name is denied', async () => {
    const s = session();
    const name = `.claude/.goodboy-sandbox-data-approved-${s.sid.slice(0, 8)}.txt`;
    const b = await s.bash(`mkdir -p .claude && touch ${name}`);
    expect(b.denied).toBe(true);
    expect(b.reason).toContain('only be created by the user');
    const w = await s.call({ tool: 'Write', input: { file_path: join(repo, name), content: '' } });
    expect(w.denied).toBe(true);
    expect(w.reason).toContain('only be created by the user');
    expect(existsSync(join(repo, name))).toBe(false);
  });
});

describe('Read, Grep and Glob', () => {
  test('Read of the dump, an input log, a link to the dump, and raw output is denied; other files are read', async () => {
    const s = session();
    put(join(repo, '.goodboy', 'sandbox', 'out', '20260101T000000Z', 'output.log'));
    for (const p of [dump, log, join(repo, 'link.sql'), join(repo, '.goodboy/sandbox/out/20260101T000000Z/output.log')]) {
      const r = await s.call({ tool: 'Read', input: { file_path: p } });
      expect([p, r.denied]).toEqual([p, true]);
      expect(r.reason).toContain('sandbox that may hold real data');
    }
    expect((await s.call({ tool: 'Read', input: { file_path: join(repo, 'README.md') } })).denied).toBe(false);
  });

  test('a subagent\'s Grep and Glob: the dump and the inputs are denied, the project\'s own files are searched', async () => {
    const s = session();
    expect((await s.call({ sub: true, tool: 'Grep', input: { pattern: 'COPY', path: dump } })).denied).toBe(true);
    expect((await s.call({ sub: true, tool: 'Grep', input: { pattern: 'x', path: join(home, 'logs') } })).denied).toBe(true);
    expect((await s.call({ sub: true, tool: 'Glob', input: { pattern: `${home}/dumps/*.sql` } })).denied).toBe(true);
    expect((await s.call({ sub: true, tool: 'Read', input: { file_path: dump } })).denied).toBe(true);
    expect((await s.call({ sub: true, tool: 'Grep', input: { pattern: 'x', path: repo } })).denied).toBe(false);
    expect((await s.call({ sub: true, tool: 'Glob', input: { pattern: '**/*.md', path: repo } })).denied).toBe(false);
    expect((await s.call({ sub: true, tool: 'Read', input: { file_path: join(repo, 'README.md') } })).denied).toBe(false);
  });

  test('the marker covers one Read too', async () => {
    const s = session();
    expect((await s.call({ tool: 'Read', input: { file_path: log } })).denied).toBe(true);
    s.marker();
    expect((await s.call({ tool: 'Read', input: { file_path: log } })).denied).toBe(false);
    expect((await s.call({ tool: 'Read', input: { file_path: log } })).denied).toBe(true);
  });
});

describe('projects the rule leaves alone', () => {
  test('a plain project (no real data) and a project with no sandbox: every form passes', async () => {
    const plain = join(base, 'plain');
    sandboxIn(plain, { dump: null, dumpFormat: null, realData: false });
    const none = join(base, 'none');
    mkdirSync(none);
    const s = session();
    for (const cwd of [plain, none]) {
      for (const c of [`docker exec ${P}-db-1 sh`, 'docker exec gb-abc-db-1 sh', 'psql -h db -U x', `cat ${dump}`, 'ls /var/run/docker.sock']) {
        const r = await s.bash(c, { cwd });
        expect([cwd.slice(base.length), c, r.denied]).toEqual([cwd.slice(base.length), c, false]);
      }
      expect((await s.call({ cwd, tool: 'Read', input: { file_path: dump } })).denied).toBe(false);
    }
  });

  test('a compose file with no local.json is not held by itself (a sandbox command writes a plain one); a local.json that cannot be read is', async () => {
    const lost = join(base, 'lost');
    sandboxIn(lost, null);
    const garbled = join(base, 'garbled');
    sandboxIn(garbled, '{not json');
    const s = session();
    expect((await s.bash('docker exec gb-abc-db-1 sh', { cwd: lost })).denied).toBe(false);
    expect((await s.bash('docker exec gb-abc-db-1 sh', { cwd: garbled })).denied).toBe(true);
  });
});

describe('round 2: the two contexts, the raw output, wrappers, the registry file, through the spawned hook', () => {
  const REG = (): string => join(base, 'registry');
  const registerRepo = (): void => {
    expect(registerRealData(registryEntryOf(repo, { dump, dumpFormat: 'sql', realData: true, inputs: [log] }), { GOODBOY_REGISTRY_DIR: REG() })).toBeNull();
  };
  const plainProject = (): string => {
    const plain = join(base, 'plain');
    sandboxIn(plain, { dump: null, dumpFormat: null, realData: false });
    return plain;
  };

  test('a plain project with a non-empty registry: docker, clients, sockets and long commands pass', async () => {
    registerRepo();
    const plain = plainProject();
    const s = session();
    const files = Array.from({ length: 450 }, (_, i) => `src/file${i}.ts`).join(' ');
    for (const c of [
      'docker exec web ls',
      'docker logs web',
      'docker compose -f docker-compose.yml exec web sh',
      'docker compose up',
      'docker exec $ID sh',
      'psql -h db -U me app',
      'curl --unix-socket /var/run/docker.sock http://localhost/containers/json',
      `git add ${files}`,
      `git commit -m "${'a long message '.repeat(215)}"`,
      `curl -H "Authorization: ${'x'.repeat(2600)}" http://localhost:8080/`,
    ]) {
      const r = await s.bash(c, { cwd: plain });
      expect([c.slice(0, 60), r.denied, r.reason.slice(0, 80)]).toEqual([c.slice(0, 60), false, '']);
    }
    // and the registered project is still held from there
    expect((await s.bash(`docker logs ${P}-app-1`, { cwd: plain })).denied).toBe(true);
    const fromPlain = await s.bash(`cat ${dump}`, { cwd: plain });
    expect(fromPlain.denied).toBe(true);
    // the model is told whose sandbox answers (live verify: it looked for `sandbox-data` in the project it was in)
    expect(fromPlain.reason).toContain(`Raw rows stay in the sandbox of the project at ${JSON.stringify(repo)}:`);
    expect((await s.bash(`cat ${dump}`)).reason).not.toContain('the project at');
  });

  test('raw output a run left on the host is denied through the shell, and result.json is not', async () => {
    const s = session();
    const out = join(repo, '.goodboy', 'sandbox', 'out');
    put(join(out, 'live', 'output.log'), 'row');
    put(join(out, '20261101T000000Z', 'output.log'), 'row');
    put(join(out, '20261101T000000Z', 'result.json'), '{}');
    for (const c of ['cat .goodboy/sandbox/out/live/output.log', `head ${out}/20261101T000000Z/output.log`, 'grep -r row .goodboy/sandbox/out', 'cd .goodboy/sandbox/out/live && cat output.log']) {
      const r = await s.bash(c);
      expect([c, r.denied]).toEqual([c, true]);
    }
    expect((await s.bash(`cat ${out}/20261101T000000Z/result.json`)).denied).toBe(false);
  });

  test('a file named lib/cli.ts that is not the plugin\'s gets no exemption; the plugin\'s own command passes', async () => {
    const s = session();
    put(join(repo, 'lib', 'cli.ts'), 'console.log(1)');
    expect((await s.bash(`bun ./lib/cli.ts sandbox-local --dump ${dump}`)).denied).toBe(true);
    expect((await s.bash(`bun lib/cli.ts sandbox-data schema; cat ${dump}`)).denied).toBe(true);
    expect((await s.bash(`bun ${CLI} sandbox-local --dump ${dump}`)).denied).toBe(false);
  });

  test('wrappers that run a command text: docker through tmux, parallel and su -c is denied', async () => {
    const s = session();
    for (const c of [`tmux new-session -d 'docker logs -f ${P}-app-1'`, 'parallel docker exec {} sh ::: a b', `su -c "docker exec ${P}-db-1 sh" root`, `watch docker logs ${P}-app-1`, `echo 'docker exec x sh' | bash`]) {
      const r = await s.bash(c);
      expect([c, r.denied]).toEqual([c, true]);
    }
    expect((await s.bash('tmux ls')).denied).toBe(false);
  });

  test('variable-held paths, a reader fed by xargs, find -exec, braces and a decomposed Korean name are denied', async () => {
    const korean = put(join(home, '덤프'.normalize('NFC'), '운영.sql'.normalize('NFC')), 'COPY x;');
    sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true, inputs: [log, korean] });
    const s = session();
    for (const c of [
      `DUMP=${dump}; head $DUMP`,
      `find ${home}/dumps -type f | xargs cat`,
      `cd ${home}/dumps && ls | xargs cat`,
      `find ${home}/dumps -exec cat {} +`,
      `cat ${home}/{dumps,logs}/*`,
      `cat ${korean.normalize('NFD')}`,
    ]) {
      const r = await s.bash(c);
      expect([c, r.denied]).toEqual([c, true]);
    }
    expect((await s.call({ tool: 'Read', input: { file_path: korean.normalize('NFD') } })).denied).toBe(true);
  });

  test('the registry file: a command, Write and Edit that change or remove it are denied; reading it is not', async () => {
    registerRepo();
    const s = session();
    const file = join(REG(), 'real-data.json');
    for (const c of [`rm ${file}`, `echo '{}' > ${file}`, `cat notes.txt >> ${file}`, `sed -i s/a/b/ ${file}`, `rm -rf ${REG()}`]) {
      const r = await s.bash(c);
      expect([c, r.denied]).toEqual([c, true]);
      expect(r.reason).toContain('change to the registry');
    }
    for (const c of [`cat ${file}`, `grep -r top ${REG()}`, `jq . ${file}`]) {
      const r = await s.bash(c, { cwd: join(base, 'parent-of-nothing', '..') });
      expect([c, r.denied]).toEqual([c, false]);
    }
    expect((await s.call({ tool: 'Read', input: { file_path: file } })).denied).toBe(false);
    for (const tool of ['Write', 'Edit']) {
      const r = await s.call({ tool, input: { file_path: file, content: '{}', old_string: 'a', new_string: 'b' } });
      expect([tool, r.denied]).toEqual([tool, true]);
      expect(r.reason).toContain('registry');
    }
    expect(JSON.parse(readFileSync(file, 'utf8')).entries.length).toBe(1);
  });

  test('round 3: cd "$HOME/…", compose set by the environment and raw output below the project root are denied; rg over an ignored out/ passes', async () => {
    const s = session();
    const out = join(repo, '.goodboy', 'sandbox', 'out');
    put(join(out, '20261101T000000Z', 'output.log'), 'row');
    put(join(repo, '.goodboy', 'sandbox', '.gitignore'), 'local.json\nout/\n');
    mkdirSync(join(repo, '.git'), { recursive: true });
    for (const c of ['cd "$HOME/dumps" && cat dump.sql', 'cd ${HOME}/logs && tail app.log', 'COMPOSE_FILE=.goodboy/sandbox/compose.yml docker compose exec db sh', `COMPOSE_PROJECT_NAME=${P} docker compose logs`, 'grep -r foo .', 'tar czf /tmp/x.tgz .goodboy', 'cat $(ls .goodboy/sandbox/out/*/output.log)']) {
      const r = await s.bash(c);
      expect([c, r.denied]).toEqual([c, true]);
    }
    const raw = await s.bash('grep -r foo .');
    expect(raw.reason).toContain('leftovers');
    for (const c of ['rg foo .', 'rg -n foo src', 'cat README.md']) expect([c, (await s.bash(c)).denied]).toEqual([c, false]);
    expect((await s.bash('rg -uu foo .')).denied).toBe(true);
  });

  test('round 3: a registered project whose .goodboy is gone is still held from inside its dir', async () => {
    registerRepo();
    rmSync(join(repo, '.goodboy'), { recursive: true, force: true });
    const s = session();
    for (const c of ['docker exec $C sh', 'docker logs', `cat ${dump}`]) expect([c, (await s.bash(c)).denied]).toEqual([c, true]);
    expect((await s.bash('docker ps')).denied).toBe(false);
  });

  test('a registry that cannot be read: the call is judged by the project it stands in, and the gate log says so', async () => {
    put(join(REG(), 'real-data.json'), '{broken');
    const s = session();
    expect((await s.bash('docker exec web ls')).denied).toBe(false);
    expect((await s.bash(`cat ${dump}`)).denied).toBe(true);
    const log = readFileSync(join(base, `goodboy-session-${s.sid}`, 'gate-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { gate: string; decision: string; reason?: string });
    expect(log.some((e) => e.gate === 'sandbox-data' && e.decision === 'warn' && e.reason === 'registry-unreadable')).toBe(true);
  });
});
