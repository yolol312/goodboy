import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { restoreProductionHosts } from '../lib/approval-marker';
import {
  classifyHost,
  classifyOutward,
  decideOutward,
  hostOf,
  hostPortOf,
  isLocalHost,
  parseHostEntry,
  parseHostRules,
  readHostRules,
  removedProduction,
  targetLabel,
} from '../lib/outward-command';

// Field report #21: `.goodboy/hosts` entries may carry a port, so two databases on one host
// can be told apart (plan §15.16).

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const t = (cmd: string) => classifyOutward(cmd, '/nonexistent');
/** The (host, port) pairs a command names, in order. */
const hp = (cmd: string) => t(cmd).map((x) => [x.host, x.port]);

describe('ports in command targets', () => {
  test('psql, pg_dump, pg_restore: -h/-p, --host/--port, URLs, conninfo', () => {
    expect(hp('psql -h db.corp.net -p 5433 -c "select 1"')).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql --host=db.corp.net --port=5433 mydb')).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql -hdb.corp.net -p5433 mydb')).toEqual([['db.corp.net', 5433]]);
    expect(hp('pg_dump -h db.corp.net -p 5433 mydb')).toEqual([['db.corp.net', 5433]]);
    expect(hp('pg_restore --host db.corp.net --port 5433 -d mydb dump.sql')).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql postgres://app:pw@db.corp.net:5433/mydb')).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql postgresql://db.corp.net:5433/mydb')).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql -d postgresql://db.corp.net:5433/mydb')).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql "host=db.corp.net port=5433 dbname=mydb user=app"')).toEqual([['db.corp.net', 5433]]);
    expect(hp("psql \"host='db.corp.net' port='5433'\"")).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql -d "dbname=mydb host=db.corp.net port=5433"')).toEqual([['db.corp.net', 5433]]);
  });

  // sqlcmd takes `-S [tcp:]host[\\instance][,port]`; the instance is not part of the host.
  test('sqlcmd: -S tcp:host,port and host\\instance,port', () => {
    expect(hp('sqlcmd -S tcp:db.corp.net,1434 -Q "select 1"')).toEqual([['db.corp.net', 1434]]);
    expect(hp("sqlcmd -S 'db.corp.net\\inst,1434' -Q x")).toEqual([['db.corp.net', 1434]]);
    expect(hp('sqlcmd -S TCP:Db.Corp.Net -Q x')).toEqual([['db.corp.net', undefined]]);
  });

  test('a command that names no port has none; a socket has no target', () => {
    expect(hp('psql -h db.corp.net mydb')).toEqual([['db.corp.net', undefined]]);
    expect(hp('psql "host=db.corp.net dbname=mydb"')).toEqual([['db.corp.net', undefined]]);
    expect(hp('psql postgres://db.corp.net/mydb')).toEqual([['db.corp.net', undefined]]);
    expect(hp('psql -p 5433 mydb')).toEqual([]);
    expect(hp('psql -h /tmp/pgsock -p 5433 mydb')).toEqual([]);
    expect(hp('psql "host=/tmp/pgsock port=5433"')).toEqual([]);
  });

  test('a connection string without a port takes the only -p flag; a SQL text is no connection string', () => {
    expect(hp('psql "host=db.corp.net dbname=x" -p 5433')).toEqual([['db.corp.net', 5433]]);
    expect(hp('psql postgres://db.corp.net/x -p 5433')).toEqual([['db.corp.net', 5433]]);
    expect(hp("psql -c \"select * from t where host = 'evil.corp.net'\" mydb")).toEqual([]);
  });

  test('a libpq host list pairs its ports (one for all, or one per host)', () => {
    expect(hp('psql -h a.corp.net,b.corp.net -p 5432,5433 mydb')).toEqual([['a.corp.net', 5432], ['b.corp.net', 5433]]);
    expect(hp('psql -h a.corp.net,b.corp.net -p 5433 mydb')).toEqual([['a.corp.net', 5433], ['b.corp.net', 5433]]);
    expect(hp('psql "host=a.corp.net,b.corp.net port=1,2"')).toEqual([['a.corp.net', 1], ['b.corp.net', 2]]);
  });

  test('mysql, mysqldump, mariadb: -h/-P, --host/--port, mysql:// (mysql -p is the password)', () => {
    expect(hp('mysql -h db.corp.net -P 3307 -pSecret app')).toEqual([['db.corp.net', 3307]]);
    expect(hp('mysql --host=db.corp.net --port=3307 app')).toEqual([['db.corp.net', 3307]]);
    expect(hp('mysqldump -hdb.corp.net -P3307 app')).toEqual([['db.corp.net', 3307]]);
    expect(hp('mariadb -h db.corp.net -P 3307 app')).toEqual([['db.corp.net', 3307]]);
    expect(hp('mysql mysql://app:pw@db.corp.net:3307/app')).toEqual([['db.corp.net', 3307]]);
    expect(hp('mysql -h db.corp.net -p app')).toEqual([['db.corp.net', undefined]]);
  });

  test('redis-cli: -h/-p, --host/--port, redis://', () => {
    expect(hp('redis-cli -h cache.corp.net -p 6380 flushall')).toEqual([['cache.corp.net', 6380]]);
    expect(hp('redis-cli --host cache.corp.net --port 6380 flushall')).toEqual([['cache.corp.net', 6380]]);
    expect(hp('redis-cli -u redis://:pw@cache.corp.net:6380/0 flushall')).toEqual([['cache.corp.net', 6380]]);
    expect(hp('redis-cli -u rediss://cache.corp.net flushall')).toEqual([['cache.corp.net', undefined]]);
  });

  test('mongosh, mongo: URLs (also several hosts), --host/--port, --host host:port', () => {
    expect(hp('mongosh mongodb://app:pw@m.corp.net:27018/app')).toEqual([['m.corp.net', 27018]]);
    expect(hp('mongo mongodb://m.corp.net:27018/app')).toEqual([['m.corp.net', 27018]]);
    expect(hp('mongosh "mongodb://a.corp.net:1,b.corp.net:2/app?replicaSet=rs"')).toEqual([['a.corp.net', 1], ['b.corp.net', 2]]);
    expect(hp('mongosh --host m.corp.net --port 27018')).toEqual([['m.corp.net', 27018]]);
    expect(hp('mongosh --host m.corp.net:27018')).toEqual([['m.corp.net', 27018]]);
    expect(hp('mongorestore --uri=mongodb://m.corp.net:27018 dump')).toEqual([['m.corp.net', 27018]]);
    expect(hp('mongosh mongodb://m.corp.net/app')).toEqual([['m.corp.net', undefined]]);
  });

  test('curl, wget, httpie: the named port, else the scheme default', () => {
    expect(hp('curl -X POST https://api.corp.net/x')).toEqual([['api.corp.net', 443]]);
    expect(hp('curl -X POST http://api.corp.net/x')).toEqual([['api.corp.net', 80]]);
    expect(hp('curl -X POST http://api.corp.net:8080/x')).toEqual([['api.corp.net', 8080]]);
    expect(hp('curl -X POST https://api.corp.net:8443/x')).toEqual([['api.corp.net', 8443]]);
    expect(hp('curl -X POST api.corp.net/x')).toEqual([['api.corp.net', 80]]); // curl reads a bare host as http
    expect(hp('curl -X POST api.corp.net:8080/x')).toEqual([['api.corp.net', 8080]]);
    expect(hp('curl -X POST --url http://api.corp.net:8080/x')).toEqual([['api.corp.net', 8080]]);
    expect(hp('curl -X POST ftp://f.corp.net/x')).toEqual([['f.corp.net', 21]]);
    expect(hp('wget --post-data=a=1 http://api.corp.net:8080/x')).toEqual([['api.corp.net', 8080]]);
    expect(hp('wget --post-data=a=1 https://api.corp.net/x')).toEqual([['api.corp.net', 443]]);
    expect(hp('http POST http://api.corp.net:8080/x a=1')).toEqual([['api.corp.net', 8080]]);
    expect(hp('http POST https://api.corp.net/x a=1')).toEqual([['api.corp.net', 443]]);
    expect(hp('http POST api.corp.net/x a=1')).toEqual([['api.corp.net', 80]]);
    expect(hp('https POST api.corp.net/x a=1')).toEqual([['api.corp.net', 443]]);
    expect(hp('http POST :3000/x a=1')).toEqual([['localhost', 3000]]);
    expect(hp('http POST /x a=1')).toEqual([['localhost', 80]]);
  });

  test('IPv6 in brackets, in URLs and in -h', () => {
    expect(hp('curl -X POST "http://[::1]:8080/x"')).toEqual([['::1', 8080]]);
    expect(hp('psql postgres://u@[2001:db8::5]:5433/db')).toEqual([['2001:db8::5', 5433]]);
    expect(hp('psql -h [2001:db8::5] -p 5433 db')).toEqual([['2001:db8::5', 5433]]);
    expect(hp('redis-cli -u redis://[2001:db8::5]:6380 flushall')).toEqual([['2001:db8::5', 6380]]);
  });

  test('a port outside 1..65535 reads as no port; hostOf still reads the host', () => {
    expect(hp('psql -h db.corp.net -p 99999 mydb')).toEqual([['db.corp.net', undefined]]);
    expect(hostPortOf('http://x.corp.net:0/a')).toEqual({ host: 'x.corp.net', scheme: 'http' });
    expect(hostOf('postgres://u:p@db.corp.net:5433/x')).toBe('db.corp.net');
    expect(hostOf('[::1]:5432')).toBe('::1');
    expect(hostOf('git@host.corp.net:org/repo.git')).toBe('host.corp.net');
  });

  test('a target with no port keeps its old shape (no port key)', () => {
    const [x] = t('psql -h db.corp.net mydb');
    expect(Object.keys(x!)).toEqual(['kind', 'host', 'mutating']);
    expect(t('git push git@api.corp.net:x.git main')).toEqual([{ kind: 'git push', host: 'api.corp.net', mutating: true }]);
    expect(targetLabel({ host: 'db', port: 5432 })).toBe('db:5432');
    expect(targetLabel({ host: '::1', port: 5432 })).toBe('[::1]:5432');
    expect(targetLabel({ host: 'db' })).toBe('db');
  });
});

describe('entries with a port', () => {
  test('parseHostEntry: host, host:port, [v6], [v6]:port, globs, a bare IPv6 address', () => {
    expect(parseHostEntry('db.corp.net')).toEqual({ host: 'db.corp.net' });
    expect(parseHostEntry('db.corp.net:5432')).toEqual({ host: 'db.corp.net', port: 5432 });
    expect(parseHostEntry('*.corp.net:5432')).toEqual({ host: '*.corp.net', port: 5432 });
    expect(parseHostEntry('[::1]:5432')).toEqual({ host: '::1', port: 5432 });
    expect(parseHostEntry('[::1]')).toEqual({ host: '::1' });
    expect(parseHostEntry('2001:db8::5')).toEqual({ host: '2001:db8::5' });
    expect(parseHostEntry('db.corp.net:99999')).toEqual({ host: 'db.corp.net', bad: true });
  });

  test('a production entry with a port blocks only that port', () => {
    const rules = parseHostRules('production db.corp.net:5432\n');
    expect(classifyHost('db.corp.net', rules, 5432)).toBe('production');
    expect(classifyHost('db.corp.net', rules, 5433)).toBe('unlisted');
    expect(classifyHost('db.corp.net', rules, 443)).toBe('unlisted');
    expect(classifyHost('other.corp.net', rules, 5432)).toBe('unlisted');
  });

  test('a production entry with a port also blocks a target whose port is unknown (fail closed)', () => {
    const rules = parseHostRules('production db.corp.net:5432\n');
    expect(classifyHost('db.corp.net', rules)).toBe('production');
    expect(classifyHost('db.corp.net', rules, undefined)).toBe('production');
    // IPv6, and a glob host
    expect(classifyHost('::1', parseHostRules('production [::1]:5432\n'), 5432)).toBe('production');
    expect(classifyHost('::1', parseHostRules('production [::1]:5432\n'))).toBe('production');
    expect(classifyHost('::1', parseHostRules('production [::1]:5432\n'), 6379)).toBe('local');
    expect(classifyHost('a.corp.net', parseHostRules('production *.corp.net:5432\n'), 5432)).toBe('production');
    expect(classifyHost('a.corp.net', parseHostRules('production *.corp.net:5432\n'), 80)).toBe('unlisted');
  });

  test('a production entry with a bad port blocks every port (fail closed)', () => {
    const rules = parseHostRules('production db.corp.net:99999\n');
    expect(classifyHost('db.corp.net', rules, 5432)).toBe('production');
    expect(classifyHost('db.corp.net', rules)).toBe('production');
  });

  test('an allow entry with a port allows only that port', () => {
    const rules = parseHostRules('allow db.corp.net:5433\n');
    expect(classifyHost('db.corp.net', rules, 5433)).toBe('allow');
    expect(classifyHost('db.corp.net', rules, 5432)).toBe('unlisted');
    expect(classifyHost('db.corp.net', rules)).toBe('unlisted'); // unknown port: not allowed
    expect(classifyHost('::1', parseHostRules('allow [2001:db8::5]:5433\n'), 5433)).toBe('local');
    expect(classifyHost('2001:db8::5', parseHostRules('allow [2001:db8::5]:5433\n'), 5433)).toBe('allow');
    expect(classifyHost('2001:db8::5', parseHostRules('allow [2001:db8::5]:5433\n'), 5432)).toBe('unlisted');
    expect(classifyHost('db.corp.net', parseHostRules('allow db.corp.net:99999\n'), 5432)).toBe('unlisted');
  });

  test('specificity: a port narrows its entry; production still wins where both match', () => {
    const rules = parseHostRules('production db.corp.net:5432\nallow db.corp.net\n');
    expect(classifyHost('db.corp.net', rules, 5432)).toBe('production'); // host:port over host
    expect(classifyHost('db.corp.net', rules, 5433)).toBe('allow'); // the host-wide allow covers the rest
    expect(classifyHost('db.corp.net', rules)).toBe('production'); // unknown port, fail closed
    const both = parseHostRules('production db.corp.net:5432\nallow db.corp.net:5433\n');
    expect(classifyHost('db.corp.net', both, 5432)).toBe('production');
    expect(classifyHost('db.corp.net', both, 5433)).toBe('allow');
    expect(classifyHost('db.corp.net', both, 5434)).toBe('unlisted');
  });

  test('an allow entry never lifts a production one that matches the same target (the model may add allow lines)', () => {
    const rules = parseHostRules('production db.corp.net\nallow db.corp.net:5432\n');
    expect(classifyHost('db.corp.net', rules, 5432)).toBe('production');
    expect(classifyHost('db.corp.net', parseHostRules('production *.corp.net\nallow db.corp.net:5432\n'), 5432)).toBe('production');
  });

  test('a host-only entry keeps matching every port (old files unchanged)', () => {
    const old = parseHostRules('production api.corp.net\nallow dev.corp.net\nallow *.stage.net\n');
    for (const port of [undefined, 80, 443, 5432, 65535]) {
      expect(classifyHost('api.corp.net', old, port)).toBe('production');
      expect(classifyHost('dev.corp.net', old, port)).toBe('allow');
      expect(classifyHost('x.stage.net', old, port)).toBe('allow');
      expect(classifyHost('else.corp.net', old, port)).toBe('unlisted');
    }
    expect(old).toEqual({ allow: ['dev.corp.net', '*.stage.net'], production: ['api.corp.net'] });
  });

  test('decideOutward: the unknown port against production host:port, and the allowed port from a subagent', () => {
    const rules = parseHostRules('production db.corp.net:5432\nallow db.corp.net:5433\n');
    const run = (cmd: string, sub = true) => decideOutward(t(cmd), rules, sub).action;
    expect(run('psql -h db.corp.net -p 5432 -c "delete from t" app')).toBe('deny-production');
    expect(run('psql -h db.corp.net -c "delete from t" app')).toBe('deny-production'); // port not named
    expect(run('psql "host=db.corp.net dbname=app" -c "delete from t"')).toBe('deny-production');
    expect(run('psql -h db.corp.net -p 5433 -c "delete from t" app')).toBe('pass');
    expect(run('psql "host=db.corp.net port=5433 dbname=app" -c "delete from t"')).toBe('pass');
    expect(run('psql postgres://db.corp.net:5433/app -c "delete from t"')).toBe('pass');
    expect(run('psql -h db.corp.net -p 5434 -c "delete from t" app')).toBe('deny-unlisted');
    expect(run('psql -h db.corp.net -p 5434 -c "delete from t" app', false)).toBe('advise');
    expect(run('pg_dump -h db.corp.net -p 5432 app')).toBe('pass'); // a read
  });

  test('decideOutward: web ports and default ports', () => {
    const rules = parseHostRules('production api.corp.net:8443\nproduction web.corp.net:443\nallow api.corp.net:8080\n');
    const run = (cmd: string) => decideOutward(t(cmd), rules, true).action;
    expect(run('curl -X POST https://api.corp.net:8443/x')).toBe('deny-production');
    expect(run('curl -X POST http://api.corp.net:8080/x')).toBe('pass');
    expect(run('curl -X POST http://api.corp.net/x')).toBe('deny-unlisted'); // port 80: neither entry
    expect(run('curl -X POST https://web.corp.net/x')).toBe('deny-production'); // the scheme's default, 443
    expect(run('curl -X POST http://web.corp.net/x')).toBe('deny-unlisted');
  });
});

describe('the production guard covers host:port entries', () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'goodboy-hostport-'));
    tmpDirs.push(d);
    return d;
  };

  test('removedProduction: dropping, rewriting or widening a host:port production line counts as removal', () => {
    const before = 'production db.corp.net:5432\nproduction [::1]:5432\nallow db.corp.net:5433\n';
    expect(removedProduction(before, before)).toEqual([]);
    expect(removedProduction(before, 'production [::1]:5432\n')).toEqual(['db.corp.net:5432']);
    expect(removedProduction(before, 'production db.corp.net\nproduction [::1]:5432\n')).toEqual(['db.corp.net:5432']);
    expect(removedProduction(before, 'allow db.corp.net:5432\nallow [::1]:5432\n')).toEqual(['db.corp.net:5432', '[::1]:5432']);
    expect(removedProduction(before, `${before}production x.corp.net:1\n`)).toEqual([]);
  });

  test('restoreProductionHosts puts back a removed host:port production line, also IPv6', () => {
    const d = dir();
    const file = join(d, 'hosts');
    writeFileSync(file, 'allow dev.corp.net:5433\n'); // the command dropped the production lines
    const restored = restoreProductionHosts({ since: 0, dirs: [], hosts: { [file]: ['db.corp.net:5432', '[::1]:5432'] } });
    expect(restored).toEqual([`${file}: db.corp.net:5432`, `${file}: [::1]:5432`]);
    const after = parseHostRules(readFileSync(file, 'utf8'));
    expect(after.production).toEqual(['db.corp.net:5432', '[::1]:5432']);
    expect(after.allow).toEqual(['dev.corp.net:5433']);
    // nothing is put back twice
    expect(restoreProductionHosts({ since: 0, dirs: [], hosts: { [file]: ['db.corp.net:5432', '[::1]:5432'] } })).toEqual([]);
  });

  test('a deleted file is recreated with its host:port production line', () => {
    const d = dir();
    const file = join(d, '.goodboy', 'hosts');
    restoreProductionHosts({ since: 0, dirs: [], hosts: { [file]: ['db.corp.net:5432'] } });
    expect(readHostRules(d).production).toEqual(['db.corp.net:5432']);
  });
});

describe('through the PreToolUse hook', () => {
  function setup(hosts: string) {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-hostport-hook-'));
    tmpDirs.push(base);
    const cwd = join(base, 'repo');
    mkdirSync(join(cwd, '.goodboy'), { recursive: true });
    const file = join(cwd, '.goodboy', 'hosts');
    writeFileSync(file, hosts);
    const sid = `hp-${Math.random().toString(36).slice(2)}`;
    const run = async (toolName: string, toolInput: Record<string, unknown>, sub = false) => {
      const payload = {
        session_id: sid,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        ...(sub ? { agent_type: 'goodboy:build-infra', agent_id: 'b1' } : {}),
      };
      const proc = Bun.spawn(['bun', HOOK], {
        cwd,
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1' },
      });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
      await proc.exited;
      const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
      return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
    };
    return { base, file, run };
  }

  const hosts = 'production db.corp.net:5432\nallow db.corp.net:5433\n';

  test("a subagent may change the user's dev database on the shared host, not the production one", async () => {
    const s = setup(hosts);
    const sql = (p: string) => `psql -h db.corp.net -p ${p} -c "delete from t" app`;
    const dev = await s.run('Bash', { command: sql('5433') }, true);
    expect(dev.denied).toBe(false);
    const prod = await s.run('Bash', { command: sql('5432') }, true);
    expect(prod.denied).toBe(true);
    expect(prod.reason).toContain('db.corp.net:5432');
    expect(prod.reason).toContain('production');
    const unnamed = await s.run('Bash', { command: 'psql -h db.corp.net -c "delete from t" app' }, true);
    expect(unnamed.denied).toBe(true);
    expect(unnamed.reason).toContain('production');
    const other = await s.run('Bash', { command: sql('5434') }, true);
    expect(other.denied).toBe(true);
    expect(other.reason).toContain('does not list');
  });

  test('Edit and Write that drop or rewrite a host:port production line are denied', async () => {
    const s = setup(hosts);
    const drop = await s.run('Edit', { file_path: s.file, old_string: 'production db.corp.net:5432\n', new_string: '' });
    expect(drop.denied).toBe(true);
    expect(drop.reason).toContain('db.corp.net:5432');
    const widen = await s.run('Write', { file_path: s.file, content: 'production db.corp.net\nallow db.corp.net:5433\n' });
    expect(widen.denied).toBe(true);
    const add = await s.run('Edit', { file_path: s.file, old_string: 'allow db.corp.net:5433\n', new_string: 'allow db.corp.net:5433\nproduction cache.corp.net:6379\n' });
    expect(add.reason).not.toContain('production entries');
  });

  test('with an unreadable hosts file up the tree, a port the entry does not name is "treated as production", not "listed"', async () => {
    const s = setup(hosts);
    mkdirSync(join(s.base, '.goodboy'));
    writeFileSync(join(s.base, '.goodboy', 'hosts'), 'allow x.corp.net\n');
    chmodSync(join(s.base, '.goodboy', 'hosts'), 0);
    try {
      const listed = await s.run('Bash', { command: 'psql -h db.corp.net -p 5432 -c "delete from t" app' });
      expect(listed.reason).toContain('listed as production');
      const other = await s.run('Bash', { command: 'psql -h db.corp.net -p 5434 -c "delete from t" app' });
      expect(other.denied).toBe(true);
      expect(other.reason).toContain('treated as production');
      expect(other.reason).toContain('db.corp.net:5434');
    } finally {
      chmodSync(join(s.base, '.goodboy', 'hosts'), 0o644);
    }
  });

  test('a host set in the environment, a URI query host and a service name are denied like a named one', async () => {
    const s = setup(hosts);
    const env = await s.run('Bash', { command: 'export PGHOST=db.corp.net PGPORT=5432; psql -c "delete from t" app' }, true);
    expect(env.denied).toBe(true);
    expect(env.reason).toContain('db.corp.net:5432');
    const query = await s.run('Bash', { command: 'psql "postgresql://dev.corp.net:5433/app?host=db.corp.net&port=5432" -c "delete from t"' }, true);
    expect(query.denied).toBe(true);
    expect(query.reason).toContain('db.corp.net:5432');
    const encoded = await s.run('Bash', { command: 'psql "postgresql://u@d%62.corp.net:5432/app" -c "delete from t"' }, true);
    expect(encoded.denied).toBe(true);
    const service = await s.run('Bash', { command: 'PGSERVICE=prodsvc psql -c "delete from t" app' }, true);
    expect(service.denied).toBe(true);
    expect(service.reason).toContain('pg-service:prodsvc');
    const dev = await s.run('Bash', { command: 'PGHOST=db.corp.net PGPORT=5433 psql -c "delete from t" app' }, true);
    expect(dev.denied).toBe(false);
  });

  test('a host whose % does not decode is denied with the "cannot be decoded" reason, not "listed as production"', async () => {
    const s = setup(hosts);
    const r = await s.run('Bash', { command: 'psql "postgresql://pro%zz.db/app" -c "delete from t"' }, true);
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('cannot be decoded');
    expect(r.reason).not.toContain('listed as production');
    // a plain listed host keeps the old wording
    const listed = await s.run('Bash', { command: 'psql -h db.corp.net -p 5432 -c "delete from t" app' }, true);
    expect(listed.reason).toContain('listed as production');
    expect(listed.reason).not.toContain('cannot be decoded');
  });
});

// Security review of the host:port change (2026-10-22): the connection a command really makes
// must be the target that is classified. Each case below was a bypass.
describe('connection target reading: value flags, URI parameters, host spelling, env', () => {
  const prod = parseHostRules('production prod.db\nproduction web.prod\nallow dev.db\n');
  const act = (cmd: string, sub = true) => decideOutward(t(cmd), prod, sub).action;

  describe('value flags are per tool', () => {
    test('psql: -t, -n, -E, -l, -A take no value, so the connection string after them is read', () => {
      for (const flag of ['-t', '-n', '-E', '-l', '-A', '-tAq', '-X']) {
        expect(hp(`psql ${flag} "host=prod.db port=5432" -c 'drop table t'`)).toEqual([['prod.db', 5432]]);
        expect(act(`psql ${flag} "host=prod.db port=5432" -c 'drop table t'`)).toBe('deny-production');
      }
      expect(act(`psql -t postgresql://prod.db:5432/x -c 'drop table t'`)).toBe('deny-production');
    });

    test('a short cluster ends in the option that takes a value: -tAh host, -Atqc sql -h host', () => {
      expect(hp('psql -tAh prod.db -c "select 1"')).toEqual([['prod.db', undefined]]);
      expect(hp('psql -Atqc "select 1" -h prod.db -p5432')).toEqual([['prod.db', 5432]]);
      expect(hp('pg_dump -Fc -hprod.db -p 5432 app')).toEqual([['prod.db', 5432]]);
    });

    test('pg_dump, pg_restore, pg_dumpall: each tool has its own list', () => {
      expect(hp('pg_dump -t users -n public "host=prod.db port=5432"')).toEqual([['prod.db', 5432]]);
      expect(hp('pg_restore -e "host=prod.db port=5432" dump')).toEqual([['prod.db', 5432]]); // -e takes none here
      expect(hp('pg_dumpall -t "host=prod.db port=5432"')).toEqual([['prod.db', 5432]]); // and none here
      expect(hp('pg_dumpall -l postgres -h prod.db')).toEqual([['prod.db', undefined]]);
      expect(hp('pg_restore -L list.txt -d "host=prod.db port=5432" dump')).toEqual([['prod.db', 5432]]);
    });

    test('when unsure which option took a word, a word that starts like a connection string is read anyway', () => {
      expect(hp('psql -U "host=prod.db port=5432" -c x')).toEqual([['prod.db', 5432]]);
      // a free-text option's value is no connection string
      expect(hp('psql -c "host=prod.db" mydb')).toEqual([]);
      expect(hp('psql -v host=prod.db mydb')).toEqual([]);
    });
  });

  describe('URI query parameters and host spelling', () => {
    test('?host= and ?port= win over the authority (libpq stores them later)', () => {
      expect(hp('psql "postgresql:///x?host=prod.db&port=5432"')).toEqual([['prod.db', 5432]]);
      expect(act('psql "postgresql:///x?host=prod.db&port=5432" -c "drop table t"')).toBe('deny-production');
      expect(hp('psql "postgresql://dev.db:5433/x?host=prod.db&port=5432"')).toEqual([['prod.db', 5432]]);
      expect(act('psql "postgresql://dev.db:5433/x?host=prod.db&port=5432" -c "drop table t"')).toBe('deny-production');
      expect(hp('psql "postgresql://dev.db:5433/x?port=5432"')).toEqual([['dev.db', 5432]]);
      expect(hp('psql "postgresql://dev.db:5433/x?host=prod.db"')).toEqual([['prod.db', 5433]]);
      expect(hp('psql "postgresql://dev.db/x?host=a.corp.net,b.corp.net&port=1,2"')).toEqual([['a.corp.net', 1], ['b.corp.net', 2]]);
      expect(hp('psql -d "postgresql://u:p@dev.db/x?sslmode=require&host=prod.db"')).toEqual([['prod.db', undefined]]);
    });

    test('?hostaddr= is a target too, and a parameter value is percent-decoded', () => {
      expect(hp('psql "postgresql://dev.db:5433/x?hostaddr=10.0.0.5"')).toEqual([['dev.db', 5433], ['10.0.0.5', 5433]]);
      expect(hp('psql "postgresql:///x?host=pro%64.db&port=5432"')).toEqual([['prod.db', 5432]]);
      expect(hp('psql "postgresql:///x?host=%2Ftmp%2Fsock"')).toEqual([]);
      expect(hp('psql "postgresql://%2Ftmp%2Fsock/x"')).toEqual([]);
      // libpq decodes the parameter names too
      expect(hp('psql "postgresql:///x?ho%73t=prod.db&p%6frt=%35432"')).toEqual([['prod.db', 5432]]);
    });

    test('a percent-encoded host is decoded: psql and curl connect to the decoded name', () => {
      expect(hp('psql "postgresql://u@pro%64.db:5432/x"')).toEqual([['prod.db', 5432]]);
      expect(act('psql "postgresql://u@pro%64.db:5432/x" -c "drop table t"')).toBe('deny-production');
      expect(hp('curl -X POST http://pro%64.db/x')).toEqual([['prod.db', 80]]);
      expect(act('curl -X POST http://we%62.prod/x')).toBe('deny-production');
      expect(hp('curl -X POST http://%6cocalhost:1/x')).toEqual([['localhost', 1]]);
      expect(act('curl -X POST http://%6cocalhost:1/x')).toBe('pass');
    });

    test('a host whose % does not decode is unknown and counts as production, whatever the rules say', () => {
      const none = { allow: [], production: [] };
      const run = (cmd: string, rules: { allow: string[]; production: string[] } = none) => decideOutward(t(cmd), rules, false).action;
      expect(run('psql "postgresql://pro%zz.db/x" -c "drop table t"')).toBe('deny-production');
      expect(run('curl -X POST "http://pro%zz.db/x"')).toBe('deny-production');
      expect(run('psql "postgresql://pro%zz.db/x" -c "drop table t"', { allow: ['pro%zz.db', '*'], production: [] })).toBe('deny-production');
      expect(classifyHost('pro%zz.db', none)).toBe('production');
      expect(classifyHost('fe80::1%eth0', none)).toBe('unlisted'); // an IPv6 zone id is no encoded name
    });

    test('a trailing dot names the same host, in every tool', () => {
      expect(hp('psql -h prod.db. -p 5432 -c x')).toEqual([['prod.db', 5432]]);
      expect(act('psql -h prod.db. -c x')).toBe('deny-production');
      expect(act('curl -X POST https://prod.db./x')).toBe('deny-production');
      expect(act('curl -X POST https://prod.db../x')).toBe('deny-production');
      expect(act('ssh prod.db. rm x')).toBe('deny-production');
      expect(act('scp f u@prod.db.:/x')).toBe('deny-production');
      expect(act('curl -X POST http://localhost./x')).toBe('pass');
      expect(act('psql "host=prod.db. port=5432" -c x')).toBe('deny-production');
      expect(classifyHost('prod.db.', prod)).toBe('production');
      expect(classifyHost('localhost.', prod)).toBe('local');
      expect(isLocalHost('localhost.')).toBe(true);
      expect(isLocalHost('127.0.0.1.')).toBe(true);
      // a host that is not read from a URL (scp's `user@host:path`) is not decoded: a `%` stays and fails closed
      expect(act('scp f "u@we%62.prod:/x"')).toBe('deny-production');
      expect(classifyHost('dev.db.', prod)).toBe('allow');
    });

    test('the URL authority ends at ?, so an @ in the query is no credential separator', () => {
      expect(hp('curl -X POST "http://prod.db?x=@localhost"')).toEqual([['prod.db', 80]]);
      expect(act('curl -X POST "http://prod.db?x=@localhost"')).toBe('deny-production');
      expect(hostPortOf('http://u:p@h.corp.net:81/x')).toEqual({ host: 'h.corp.net', port: 81, scheme: 'http' });
      expect(hostOf('git@host.corp.net:org/repo.git')).toBe('host.corp.net');
    });
  });

  describe('libpq environment and service names', () => {
    test('PGHOST / PGPORT / PGHOSTADDR before the program, after env, or exported earlier', () => {
      expect(hp('PGHOST=prod.db psql -c x')).toEqual([['prod.db', undefined]]);
      expect(hp('PGHOST=prod.db PGPORT=5432 psql -c x')).toEqual([['prod.db', 5432]]);
      expect(hp('env PGHOST=prod.db PGPORT=5432 psql -c x')).toEqual([['prod.db', 5432]]);
      expect(hp('PGHOSTADDR=10.0.0.5 PGPORT=5432 pg_dump app')).toEqual([['10.0.0.5', 5432]]);
      expect(hp('export PGHOST=prod.db; psql -c x')).toEqual([['prod.db', undefined]]);
      expect(hp('export PGHOST=prod.db PGPORT=5432 && psql -c x')).toEqual([['prod.db', 5432]]);
      expect(hp('PGHOST=prod.db; PGPORT=5432; psql -c x')).toEqual([['prod.db', 5432]]);
      expect(hp('sh -c "export PGHOST=prod.db; psql -c x"')).toEqual([['prod.db', undefined]]);
      expect(act('PGHOST=prod.db psql -c "drop table t"')).toBe('deny-production');
      expect(act('env PGHOST=prod.db psql -c "drop table t"')).toBe('deny-production');
      expect(act('export PGHOST=prod.db; psql -c "drop table t"')).toBe('deny-production');
    });

    test('the command names win over the environment; PGPORT still fills a missing port', () => {
      expect(hp('PGHOST=prod.db psql -h dev.db -c x')).toEqual([['dev.db', undefined]]);
      expect(hp('PGPORT=5433 psql -h dev.db -c x')).toEqual([['dev.db', 5433]]);
      expect(hp('PGPORT=5433 psql "host=dev.db" -c x')).toEqual([['dev.db', 5433]]);
      expect(hp('PGPORT=5433 psql -h dev.db -p 5434 -c x')).toEqual([['dev.db', 5434]]);
      expect(hp('PGHOST=/tmp/pgsock psql -c x')).toEqual([]);
      expect(hp('PGPORT=5433 psql -c x')).toEqual([]);
      expect(hp('FOO=1 ls')).toEqual([]);
    });

    test('a service name stands for a host only pg_service.conf knows: an unknown target, fail closed', () => {
      expect(hp('PGSERVICE=prodsvc psql -c x')).toEqual([['pg-service:prodsvc', undefined]]);
      expect(hp('psql service=prodsvc -c x')).toEqual([['pg-service:prodsvc', undefined]]);
      expect(hp('psql "service=prodsvc dbname=x" -c x')).toEqual([['pg-service:prodsvc', undefined]]);
      expect(hp('psql "postgresql:///x?service=prodsvc" -c x')).toEqual([['pg-service:prodsvc', undefined]]);
      expect(hp('pg_dump "service=prodsvc"')).toEqual([['pg-service:prodsvc', undefined]]);
      expect(act('PGSERVICE=prodsvc psql -c "drop table t"')).toBe('deny-unlisted');
      expect(act('psql service=prodsvc -c "drop table t"')).toBe('deny-unlisted');
      expect(act('psql service=prodsvc -c "drop table t"', false)).toBe('advise');
      expect(act('pg_dump service=prodsvc')).toBe('pass'); // a read
      // the user can list one service as a sandbox
      expect(decideOutward(t('psql service=devsvc -c "drop table t"'), parseHostRules('allow pg-service:devsvc\n'), true).action).toBe('pass');
      // a host the command names is what it connects to
      expect(hp('psql service=prodsvc -h dev.db -c x')).toEqual([['dev.db', undefined]]);
      expect(hp('PGSERVICE=prodsvc psql -h dev.db -c x')).toEqual([['dev.db', undefined]]);
    });
  });

  describe('other tools whose real target the first reading missed', () => {
    test('mongosh and mongo: the positional host[:port]/db address', () => {
      expect(hp('mongosh prod.db:5432/x --eval "db.dropDatabase()"')).toEqual([['prod.db', 5432]]);
      expect(hp('mongosh --username u --password p prod.db:27017/x')).toEqual([['prod.db', 27017]]);
      expect(hp('mongo prod.db:27017')).toEqual([['prod.db', 27017]]);
      expect(hp('mongosh prod.db/x')).toEqual([['prod.db', undefined]]);
      expect(hp('mongosh --eval "db.x.drop()" "[::1]:27017/x"')).toEqual([['::1', 27017]]);
      expect(act('mongosh prod.db:5432/x --eval "db.dropDatabase()"')).toBe('deny-production');
      // a bare word is a database on localhost, a .js file a script
      expect(hp('mongosh mydb')).toEqual([]);
      expect(hp('mongosh script.js')).toEqual([]);
      expect(hp('mongosh --eval "db.x.drop()" mydb')).toEqual([]);
      expect(hp('mongosh --host m.corp.net --port 27018')).toEqual([['m.corp.net', 27018]]);
    });

    test('redis-cli --cluster: the nodes are words after the cluster command', () => {
      expect(hp('redis-cli --cluster create prod.db:7000 prod.db:7001 --cluster-replicas 1')).toEqual([['prod.db', 7000], ['prod.db', 7001]]);
      expect(hp('redis-cli --cluster add-node new.corp.net:7006 prod.db:7000')).toEqual([['new.corp.net', 7006], ['prod.db', 7000]]);
      expect(hp('redis-cli --cluster check "[::1]:7000"')).toEqual([['::1', 7000]]);
      expect(act('redis-cli --cluster fix prod.db:7000')).toBe('deny-production');
      expect(hp('redis-cli set a:1 2')).toEqual([]); // a key is no node
    });

    test('curl --connect-to and --resolve: the redirected destination is classified too', () => {
      expect(hp('curl -X POST https://localhost/x --connect-to localhost:443:web.prod:443')).toEqual([['localhost', 443], ['web.prod', 443]]);
      expect(act('curl -X POST https://localhost/x --connect-to localhost:443:web.prod:443')).toBe('deny-production');
      expect(act('curl -X POST https://localhost/x --connect-to=::web.prod:')).toBe('deny-production');
      // (round-2 review) PORT2 is optional (`HOST1:PORT1:HOST2`); a form goodboy cannot read
      //   names an unknown destination, which is no local host.
      expect(act('curl -X POST https://localhost/x --connect-to ::web.prod')).toBe('deny-production');
      expect(hp('curl -X POST https://localhost/x --connect-to garbage').map(([h]) => h)).toEqual(['localhost', 'garbage']);
      // (round-2 review) psql reads long options with getopt_long: unique abbreviations count.
      expect(hp('psql --ho prod.db -c "drop table t"')).toEqual([['prod.db', undefined]]);
      expect(hp('psql --hos=prod.db --po 5432 -c "drop table t"')).toEqual([['prod.db', 5432]]);
      expect(act('psql --ho prod.db -c "drop table t"')).toBe('deny-production');
      // a 3-character abbreviation that is unique in psql (`--d` is --dbname only)
      expect(hp("psql --d=postgres://prod.db/x -c 'drop table t'")).toEqual([['prod.db', undefined]]);
      expect(act("psql --d=postgres://prod.db/x -c 'drop table t'")).toBe('deny-production');
      expect(act("psql --d='host=prod.db' -c 'drop table t'")).toBe('deny-production');
      expect(hp('curl -X POST https://localhost/x --connect-to localhost:443::8443')).toEqual([['localhost', 443], ['localhost', 8443]]);
      expect(hp('curl -X POST https://a.corp.net/x --connect-to ::[::1]:9')).toEqual([['a.corp.net', 443], ['::1', 9]]);
      expect(hp('curl -X POST https://localhost/x --resolve localhost:443:10.1.2.3')).toEqual([['localhost', 443], ['10.1.2.3', 443]]);
      expect(hp('curl -X POST https://localhost/x --resolve localhost:443:10.1.2.3,[::1]')).toEqual([['localhost', 443], ['10.1.2.3', 443], ['::1', 443]]);
      expect(act('curl -X POST https://localhost/x --resolve localhost:443:prod.db')).toBe('deny-production');
      expect(act('curl -X POST https://localhost/x --resolve=localhost:443:prod.db')).toBe('deny-production');
      // many URLs times many port-only entries stay bounded (no stack overflow in the reading)
      const many = `curl -X POST ${Array.from({ length: 3000 }, (_, i) => `https://a${i}.corp.net/x`).join(' ')} ${Array.from({ length: 3000 }, (_, i) => `--connect-to :443::${i + 1}`).join(' ')}`;
      expect(t(many).length).toBeLessThan(5000);
      // nothing redirected: unchanged
      expect(hp('curl -X POST https://localhost/x')).toEqual([['localhost', 443]]);
      expect(act('curl -X POST https://localhost/x')).toBe('pass');
    });
  });

  describe('end of options and malformed escapes', () => {
    test('words after `--` are positional, so the connection string there is read', () => {
      expect(hp('psql -c "drop table t" -- "host=prod.db port=5432"')).toEqual([['prod.db', 5432]]);
      expect(act('psql -- postgresql://prod.db:5433/app')).toBe('deny-production');
    });

    test('a URI query value with a malformed escape stays as written and fails closed', () => {
      expect(hp('psql "postgresql:///x?host=pro%zzdb&port=5432"')).toEqual([['pro%zzdb', 5432]]);
      expect(act('psql "postgresql:///x?host=pro%zzdb&port=5432" -c "drop table t"')).toBe('deny-production');
    });
  });
});
