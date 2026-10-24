// Track M fix round 1, fixer A, A6 (plan §19): the DB restore scripts fail closed and never print
// a row of the dump. The rendered restore.sh runs against fake db clients in a temp dir.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSandbox } from '../lib/sandbox-render';
import type { SandboxScan } from '../lib/sandbox-types';

setDefaultTimeout(60_000);

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function dir(prefix = 'goodboy-mfa-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const CANARY = 'CANARY-real-person@example.com';

function scanWith(kind: 'postgres' | 'mysql'): SandboxScan {
  return {
    root: '/nonexistent/repo',
    stack: 'jvm',
    frameworks: ['spring-boot'],
    build: { tool: 'gradle', runtimeVersion: '17', depsCommand: [], buildCommand: [], testCommand: [], startCommand: [], artifact: null },
    app: { port: 8080, contextPath: '/', healthPath: '/', configFiles: [] },
    stores: [{ kind, version: kind === 'postgres' ? '16' : '8.0', database: 'shop', configKeys: [], where: { file: 'a.yml', line: 1 } }],
    outbound: [],
    secretKeys: [],
    questions: [],
    problems: [],
  };
}

const restoreScript = (kind: 'postgres' | 'mysql', format: 'sql' | 'custom'): string =>
  planSandbox(scanWith(kind), { dump: '/d/x', dumpFormat: format }, { readConfig: () => null }).files.get('db/db/restore.sh')!;

interface Opts {
  dumpLines?: string[];
  /** What psql writes to stderr while loading; @DUMP@ stands for the dump's path. */
  stderr?: string;
  tables?: number;
  clientExit?: number;
  clientStderr?: string;
}

interface Run {
  code: number;
  out: string;
  log: string;
}

/** Runs the rendered restore.sh with fake db clients on PATH and the dump and error paths in a temp dir. */
function restore(kind: 'postgres' | 'mysql', format: 'sql' | 'custom', o: Opts = {}): Run {
  const work = dir();
  const dump = join(work, 'dump.sql');
  writeFileSync(dump, (o.dumpLines ?? ['SELECT 1;']).join('\n') + '\n');
  writeFileSync(join(work, 'stderr.txt'), (o.stderr ?? '').replaceAll('@DUMP@', dump));
  writeFileSync(join(work, 'client-stderr.txt'), o.clientStderr ?? '');
  const script = restoreScript(kind, format).replaceAll('/dump/dump.sql', dump).replaceAll('/dump/dump.custom', dump).replaceAll('/tmp/goodboy-restore.err', join(work, 'restore.err'));
  writeFileSync(join(work, 'restore.sh'), script);
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${work}/calls.log"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    'psql',
    `case "$*" in
  *pg_database*) exit 0 ;;
  *"count(*)"*) echo ${o.tables ?? 3} ;;
  *" -f "*) cat "${work}/stderr.txt" >&2 ;;
esac
exit 0`,
  );
  fake('pg_restore', `cat "${work}/client-stderr.txt" >&2\nexit ${o.clientExit ?? 0}`);
  fake(
    'mysql',
    `case "$*" in
  *__goodboy_loaded*) echo 0 ;;
  *"COUNT(*)"*) echo ${o.tables ?? 3} ;;
  *" -e "*) exit 0 ;;
  *) cat > /dev/null; cat "${work}/client-stderr.txt" >&2; exit ${o.clientExit ?? 0} ;;
esac`,
  );
  const r = Bun.spawnSync(['sh', join(work, 'restore.sh')], { cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const calls = join(work, 'calls.log');
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), log: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

/** The template was made: Postgres renamed the loading database, MySQL wrote the marker table. */
const made = (r: Run): boolean => r.log.includes('RENAME TO') || r.log.includes('__goodboy_loaded (id INT)');

describe('A6: the DB restore fails closed and never prints a row of the dump', () => {
  test('Postgres plain SQL: no error and tables present makes the template', () => {
    const r = restore('postgres', 'sql');
    expect(r.code).toBe(0);
    expect(r.out).toContain('restored');
    expect(made(r)).toBe(true);
  });

  test('Postgres plain SQL: a missing role in OWNER TO and GRANT is tolerated', () => {
    const r = restore('postgres', 'sql', {
      dumpLines: ['CREATE TABLE t (a int);', 'ALTER TABLE public.t OWNER TO prod_user;', 'GRANT ALL ON TABLE public.t TO prod_ro;'],
      stderr: 'psql:@DUMP@:2: ERROR:  42704\npsql:@DUMP@:3: ERROR:  42704\npsql:@DUMP@:3: NOTICE:  00000\n',
    });
    expect(r.code).toBe(0);
    expect(made(r)).toBe(true);
  });

  test('Postgres plain SQL: any other error fails, names code and line only, and no template is made', () => {
    const r = restore('postgres', 'sql', {
      dumpLines: ['CREATE TABLE t (a text);', `INSERT INTO t VALUES ('${CANARY}');`, `INSERT INTO t VALUES ('${CANARY}');`],
      stderr: 'psql:@DUMP@:3: ERROR:  23505\n',
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('goodboy: SQLSTATE 23505 at dump line 3');
    expect(r.out).not.toContain(CANARY);
    expect(made(r)).toBe(false);
  });

  test('Postgres plain SQL: 42704 on a statement that is not a role statement still fails', () => {
    const r = restore('postgres', 'sql', { dumpLines: ['CREATE TABLE t (a no_such_type);'], stderr: 'psql:@DUMP@:1: ERROR:  42704\n' });
    expect(r.code).toBe(1);
    expect(made(r)).toBe(false);
  });

  test('Postgres plain SQL: only the exact SQLSTATE line is read; with another verbosity a message, a 5-letter word or a notice with text is withheld', () => {
    const r = restore('postgres', 'sql', {
      dumpLines: ['x'],
      stderr: [
        `psql:@DUMP@:7: ERROR:  ${CANARY}`,
        'psql:@DUMP@:8: ERROR:  duplicate key value CANARY_RAISE_ZXQ',
        'psql:@DUMP@:9: ERROR:  23505',
        'psql:@DUMP@:10: ERROR:  ADMIN',
        'psql:@DUMP@:11: ERROR:  ZZZZZ',
        `psql:@DUMP@:12: NOTICE:  table CANARY_NOTICE_QQ does not exist, skipping`,
        'psql:@DUMP@:13: NOTICE:  00000',
        '',
      ].join('\n'),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('SQLSTATE 23505 at dump line 9');
    expect(r.out).toContain('not a plain SQLSTATE report');
    // the five lines that are not the exact format: reported (not tolerated), never quoted
    expect(r.out).toContain('the restore had 6 error(s)');
    for (const leak of ['CANARY', 'ADMIN', 'ZZZZZ']) expect([leak, r.out.includes(leak)]).toEqual([leak, false]);
  });

  test('Postgres plain SQL: output that is not a notice is withheld and fails; a dump that made no table fails', () => {
    const odd = restore('postgres', 'sql', { stderr: `psql: error: something broke near ${CANARY}\n` });
    expect(odd.code).toBe(1);
    expect(odd.out).not.toContain(CANARY);
    expect(made(odd)).toBe(false);
    const empty = restore('postgres', 'sql', { tables: 0 });
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('no table');
    expect(made(empty)).toBe(false);
  });

  test('pg_restore: a non-zero exit fails without its text; a clean one makes the template', () => {
    const bad = restore('postgres', 'custom', { clientExit: 1, clientStderr: `pg_restore: error: COPY failed for table "t": ${CANARY}\npg_restore: warning: errors ignored on restore: 2\n` });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('errors ignored on restore: 2');
    expect(bad.out).not.toContain(CANARY);
    expect(made(bad)).toBe(false);
    const good = restore('postgres', 'custom');
    expect(good.code).toBe(0);
    expect(made(good)).toBe(true);
  });

  test('MySQL: no --force; an error fails with code, state and line only; no table fails; a clean load marks the template', () => {
    expect(restoreScript('mysql', 'sql')).not.toContain('--force');
    const bad = restore('mysql', 'sql', { clientExit: 1, clientStderr: `ERROR 1062 (23000) at line 5: Duplicate entry '${CANARY}' for key 'email'\n` });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('error 1062 (23000) at dump line 5');
    expect(bad.out).not.toContain(CANARY);
    expect(made(bad)).toBe(false);
    const empty = restore('mysql', 'sql', { tables: 0 });
    expect(empty.code).toBe(1);
    expect(made(empty)).toBe(false);
    const good = restore('mysql', 'sql');
    expect(good.code).toBe(0);
    expect(made(good)).toBe(true);
  });
});
