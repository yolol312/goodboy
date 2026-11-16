// Track M, M6c (plan §19): clearing the `data` volume through the reader. Its scripts run for real under `sh`, with the volume
// paths moved into a temp dir (as tests/m6a-parts.test.ts does for the others).

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLEAR_DATA_SCRIPT, DATA_DIR, DATA_VOLUME, FINISH_SCRIPT } from '../lib/sandbox-volumes';

const made: string[] = [];
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-volumes-')));
  made.push(d);
  return d;
};
afterAll(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

/** The script with every volume path moved under `root`, run under sh. */
function run(script: string, root: string, args: string[] = []): { code: number; stdout: string; stderr: string } {
  const moved = script.replaceAll('/goodboy-data', `${root}/data`).replaceAll('/outroot', `${root}/outroot`).replaceAll('/live', `${root}/live`).replaceAll('/outdirs', `${root}/outdirs`);
  const r = Bun.spawnSync(['sh', '-c', moved, 'sh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe('clear-data', () => {
  test('empties the data volume, hidden files and directories too, and ends with the mark', () => {
    const root = tmp();
    const data = join(root, 'data');
    mkdirSync(join(data, 'sub'), { recursive: true });
    writeFileSync(join(data, 'values.tsv'), 'V\n');
    writeFileSync(join(data, 'v.tmp'), 'x');
    writeFileSync(join(data, '.hidden'), 'x');
    writeFileSync(join(data, 'sub', 'deep'), 'x');
    const r = run(CLEAR_DATA_SCRIPT, root);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')).toContain('@@END');
    expect(readdirSync(data)).toEqual([]);
    // the volume itself stays
    expect(existsSync(data)).toBe(true);
  });

  test('a reader of a sandbox made before M6c has no such mount: nothing to clear, still the mark', () => {
    const root = tmp();
    const r = run(CLEAR_DATA_SCRIPT, root);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')).toContain('@@END');
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  test('a link in the volume is removed, never followed', () => {
    const root = tmp();
    const data = join(root, 'data');
    const victim = join(root, 'victim');
    mkdirSync(data);
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep'), 'x');
    symlinkSync(victim, join(data, 'link'));
    expect(run(CLEAR_DATA_SCRIPT, root).stdout.split('\n')).toContain('@@END');
    expect(readdirSync(data)).toEqual([]);
    expect(existsSync(join(victim, 'keep'))).toBe(true);
  });

  test('it names itself for the fake docker and clears nothing else', () => {
    expect(CLEAR_DATA_SCRIPT.startsWith('# goodboy-reader: clear-data\n')).toBe(true);
    const root = tmp();
    mkdirSync(join(root, 'live'), { recursive: true });
    writeFileSync(join(root, 'live', 'access.log'), 'log');
    mkdirSync(join(root, 'outroot', '20261116T000000Z'), { recursive: true });
    run(CLEAR_DATA_SCRIPT, root);
    expect(existsSync(join(root, 'live', 'access.log'))).toBe(true);
    expect(existsSync(join(root, 'outroot', '20261116T000000Z'))).toBe(true);
  });
});

describe('finish, with the scratch volumes cleared', () => {
  test('the run start and the sweep empty the data volume with the rest, and a mode that keeps the scratch keeps it', () => {
    const root = tmp();
    const data = join(root, 'data');
    mkdirSync(data);
    mkdirSync(join(root, 'live'), { recursive: true });
    writeFileSync(join(data, 'values.tsv'), 'V\n');
    const keep = run(FINISH_SCRIPT, root, ['keep']);
    expect(keep.stdout.split('\n')).toContain('@@END');
    expect(existsSync(join(data, 'values.tsv'))).toBe(true);
    const clear = run(FINISH_SCRIPT, root, ['clear']);
    expect(clear.stdout.split('\n')).toContain('@@END');
    expect(readdirSync(data)).toEqual([]);
  });

  test('the volume is named data and mounted at /goodboy-data', () => {
    expect([DATA_VOLUME, DATA_DIR]).toEqual(['data', '/goodboy-data']);
  });
});
