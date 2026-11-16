// Track M, M6b (plan §19): the least-privilege role of `sandbox-data` (the rendered `db/<svc>/data-role.sh` of each
// engine) and when it is applied: by `sandbox-up` after the restore, and again after every reset.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataRoleScript, MY_READER, PG_READER } from '../lib/sandbox-parts';
import { planSandbox } from '../lib/sandbox-render';
import { isSandboxLayout } from '../lib/sandbox-gate';
import type { SandboxScan } from '../lib/sandbox-types';
import { cleanupFakeProjects, fakeProject, plainScan } from './m6a-project';

setDefaultTimeout(120_000);
const scratch: string[] = [];
afterEach(() => {
  cleanupFakeProjects();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

const scanOf = (kind: 'postgres' | 'mysql' | 'mariadb', version: string): SandboxScan => {
  const s = plainScan();
  s.stores = [{ kind, version, database: 'shop', configKeys: [], where: { file: 'application.yml', line: 3 } }];
  return s;
};
const roleOf = (kind: 'postgres' | 'mysql' | 'mariadb', version: string, local = { dump: null, dumpFormat: null } as const): string => {
  const plan = planSandbox(scanOf(kind, version), local, { readConfig: () => null });
  return plan.files.get('db/db/data-role.sh')!;
};

/** `sh -n`: the script parses. */
function parses(text: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-m6b-sh-'));
  scratch.push(dir);
  writeFileSync(join(dir, 's.sh'), text);
  return Bun.spawnSync(['sh', '-n', join(dir, 's.sh')]).exitCode === 0;
}

describe('the role script of each engine', () => {
  test('postgres: a login role with no rights but SELECT, read-only by setting, with time limits', () => {
    const t = roleOf('postgres', '16');
    expect(PG_READER).toBe('goodboy_reader');
    expect(t).toContain("CREATE ROLE goodboy_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;");
    expect(t).toContain('ALTER ROLE goodboy_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;');
    expect(t).toContain('ALTER ROLE goodboy_reader SET default_transaction_read_only = on;');
    expect(t).toContain("ALTER ROLE goodboy_reader SET statement_timeout = '5s';");
    expect(t).toContain("ALTER ROLE goodboy_reader SET lock_timeout = '1s';");
    expect(t).toContain("ALTER ROLE goodboy_reader SET idle_in_transaction_session_timeout = '10s';");
    expect(t).toContain('GRANT CONNECT ON DATABASE "shop" TO goodboy_reader;');
    expect(t).toContain("EXECUTE format('GRANT USAGE ON SCHEMA %I TO goodboy_reader', s);");
    expect(t).toContain("EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO goodboy_reader', s);");
    // no password, and only the grants above
    // (PGPASSWORD is how the script itself logs in as the superuser)
    expect(t).not.toMatch(/(?<!PG)PASSWORD|ALL PRIVILEGES|WITH GRANT OPTION|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER/i);
    expect(t.match(/GRANT [A-Z ]+ ON/g)).toEqual(['GRANT CONNECT ON', 'GRANT USAGE ON', 'GRANT SELECT ON']);
    // no right is granted: every attribute is spelled with its NO
    expect(t).not.toMatch(/(?<!NO)SUPERUSER|(?<!NO)CREATEDB|(?<!NO)CREATEROLE|(?<!NO)REPLICATION|(?<!NO)BYPASSRLS/);
    expect(parses(t)).toBe(true);
  });

  test('postgres: made once and kept (idempotent), as the database superuser, in both databases', () => {
    const t = roleOf('postgres', '16');
    expect(t).toContain("IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'goodboy_reader')");
    expect(t).toContain('-v ON_ERROR_STOP=1');
    expect(t).toContain('-d postgres');
    expect(t).toContain('-d "shop"');
    expect(t.match(/-U sandbox/g)).toHaveLength(2);
  });

  test('mysql and mariadb: SELECT on the app database only, two connections, no password, from the container itself', () => {
    expect(MY_READER).toBe('gb_reader');
    for (const [kind, client] of [['mysql', 'mysql'], ['mariadb', 'mariadb']] as const) {
      const t = roleOf(kind, kind === 'mysql' ? '8.0' : '11');
      expect(t).toContain(`MY="${client} -h 127.0.0.1 -uroot -psandbox"`);
      expect(t).toContain("CREATE USER IF NOT EXISTS 'gb_reader'@'localhost';");
      expect(t).toContain("ALTER USER 'gb_reader'@'localhost' WITH MAX_USER_CONNECTIONS 2;");
      expect(t).toContain("GRANT SELECT ON `shop`.* TO 'gb_reader'@'localhost';");
      expect(t.match(/GRANT [A-Z ]+ ON/g)).toEqual(['GRANT SELECT ON']);
      expect(t).not.toMatch(/IDENTIFIED|ALL PRIVILEGES|GRANT OPTION|'%'|\*\.\*/i);
      expect(parses(t)).toBe(true);
    }
  });

  test('no script reads the template marker: it runs whether or not the template exists', () => {
    for (const [kind, v] of [['postgres', '16'], ['mysql', '8.0'], ['mariadb', '11']] as const) {
      const t = roleOf(kind, v, { dump: '/dumps/x.sql', dumpFormat: 'sql' } as never)
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n');
      expect(t).not.toMatch(/__goodboy_loaded|_template|template/i);
      expect(t).not.toMatch(/exit 0/);
    }
  });

  test('it is a layout file of the sandbox, in every plan', () => {
    for (const kind of ['postgres', 'mysql', 'mariadb'] as const) {
      const plan = planSandbox(scanOf(kind, kind === 'postgres' ? '16' : '8.0'), { dump: null, dumpFormat: null }, { readConfig: () => null });
      const names = [...plan.files.keys()].filter((n) => n.startsWith('db/'));
      expect(names.sort()).toEqual(['db/db/data-role.sh', 'db/db/reset.sh', 'db/db/restore.sh']);
      for (const n of names) expect(isSandboxLayout(n)).toBe(true);
    }
  });

  test('a second SQL store gets its own script', () => {
    const s = scanOf('postgres', '16');
    s.stores.push({ kind: 'mysql', version: '8.0', database: 'other', configKeys: [], where: { file: 'application.yml', line: 9 } });
    const plan = planSandbox(s, { dump: null, dumpFormat: null }, { readConfig: () => null });
    expect(plan.files.get('db/db2/data-role.sh')).toContain("GRANT SELECT ON `other`.*");
    expect(plan.files.get('db/db/data-role.sh')).toContain('goodboy_reader');
  });

  test('the script text of a store is a pure function of it', () => {
    const store = scanOf('postgres', '16').stores[0]!;
    const sql = { store, svc: 'db', name: 'shop', v: '16', port: 5432 };
    expect(dataRoleScript(sql)).toBe(dataRoleScript({ ...sql }));
  });
});

describe('when the role is applied', () => {
  const execs = (calls: string[]): string[] => calls.filter((l) => / exec -T db sh \/goodboy-db\//.test(l)).map((l) => /goodboy-db\/([\w-]+\.sh)/.exec(l)![1]!);

  test('sandbox-up: the restore, then each reset followed by the role', async () => {
    const f = fakeProject(null);
    const r = await f.inproc('sandbox-up', ['--wait-seconds', '5']);
    expect(r.code).toBe(0);
    expect(execs(f.calls())).toEqual(['restore.sh', 'reset.sh', 'data-role.sh']);
    expect(r.out.steps).toContainEqual({ step: 'data role', ok: true });
  });

  test('sandbox-up runs the role when the template already exists (the restore reports it and stops)', async () => {
    const f = fakeProject(null);
    writeFileSync(join(f.state, 'restore-out.txt'), 'template shop_template exists\n');
    const r = await f.inproc('sandbox-up', ['--wait-seconds', '5']);
    expect(r.code).toBe(0);
    expect(execs(f.calls())).toEqual(['restore.sh', 'reset.sh', 'data-role.sh']);
  });

  test('sandbox-run: each reset, before the suites and again before the browser suite, is followed by the role', async () => {
    const f = fakeProject(null);
    const r = await f.inproc('sandbox-run', ['--suite', 'all']);
    expect(r.code).toBe(0);
    expect(execs(f.calls())).toEqual(['reset.sh', 'data-role.sh', 'reset.sh', 'data-role.sh']);
  });

  test('a role that cannot be made stops no suite and no start: it is a step of sandbox-up and a problem of the run', async () => {
    const f = fakeProject(null);
    const up = await f.inproc('sandbox-up', ['--wait-seconds', '5'], { FAKE_FAIL: 'data-role.sh', FAKE_FAIL_TEXT: 'ERROR: relation "Kim-0101234567" does not exist' });
    expect(up.code).toBe(0);
    const step = up.out.steps.find((s: any) => s.step === 'data role db');
    expect(step).toMatchObject({ ok: false, diagnostic: { code: 'data-failed', step: 'data role db' } });
    expect(step.note).toContain('sandbox-data fails until it works');
    expect(up.text).not.toContain('Kim-0101234567');
    const run = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_FAIL: 'data-role.sh', FAKE_FAIL_TEXT: 'ERROR: Kim-0101234567' });
    expect(run.code).toBe(0);
    expect(run.out.problems).toEqual([expect.stringContaining('read-only role of sandbox-data could not be made')]);
    expect(run.text).not.toContain('Kim-0101234567');
  });

  test('a reset that fails still stops everything, and the role is not tried after it', async () => {
    const f = fakeProject(null);
    const r = await f.inproc('sandbox-run', ['--suite', 'unit'], { FAKE_FAIL: 'reset.sh' });
    expect(r.code).toBe(1);
    expect(execs(f.calls())).toEqual([]);
  });
});
