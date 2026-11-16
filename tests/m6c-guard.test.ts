// Track M, M6c (plan §19): the PreToolUse rule for a sandbox that may hold real data (lib/sandbox-data-guard.ts) keeps the
// resolved values out of reach the way it keeps the database out of reach: the `data` volume is a volume of the project, so a
// `docker run` that mounts it, an exec or cp into the database or a test container, and a compose run that reads
// /goodboy-data are denied, while goodboy's own CLI (which resolves and clears the values itself) and the manifest, which holds
// conditions and no value, are not.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxDataDenial } from '../lib/sandbox-data-guard';
import { projectName } from '../lib/sandbox-mode';
import { volumeNames } from '../lib/sandbox-volumes';
import { keepEnv, put, sandboxIn } from './m6b-helpers';

let base = '';
let repo = '';
let P = '';
const restoreEnv = keepEnv('HOME', 'GOODBOY_REGISTRY_DIR');

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-guard-')));
  repo = join(base, 'repo');
  const home = join(base, 'home');
  const dump = put(join(home, 'dumps', 'dump.sql'), 'COPY users FROM stdin;');
  put(join(repo, 'src', 'a.txt'));
  sandboxIn(repo, { dump, dumpFormat: 'sql', realData: true });
  put(join(repo, '.goodboy', 'sandbox', 'data.json'), '{"version":1}');
  P = projectName(repo);
  process.env.HOME = home;
  process.env.GOODBOY_REGISTRY_DIR = join(base, 'registry');
});
afterAll(() => {
  restoreEnv();
  rmSync(base, { recursive: true, force: true });
});

const OWN_CLI = join(import.meta.dir, '..', 'lib', 'cli.ts');
const bash = (command: string): string | null => sandboxDataDenial({ toolName: 'Bash', toolInput: { command }, cwd: repo, projectCwd: repo })?.what ?? null;

describe('the data volume', () => {
  test('is one of the volumes the compose file makes, named <project>_data', () => {
    expect(volumeNames()).toContain('data');
    expect(`${P}_data`).toMatch(/^gb-[a-z0-9-]+_data$/);
  });

  test('cannot be mounted by a docker run, in any of the spellings, with or without a read-only flag', () => {
    const forms = [
      `docker run --rm -v ${P}_data:/d busybox cat /d/values.tsv`,
      `docker run --rm -v ${P}_data:/goodboy-data:ro alpine sh -c 'cat /goodboy-data/values.tsv'`,
      `docker run --rm --volume ${P}_data:/d alpine ls /d`,
      `docker run --rm --volume=${P}_data:/d alpine ls /d`,
      `docker run --rm --mount source=${P}_data,target=/d busybox cat /d/values.tsv`,
      `docker run --rm --mount type=volume,src=${P}_data,dst=/d,readonly busybox cat /d/values.tsv`,
      `docker run --rm -v "${P}_data":/d busybox cat /d/values.tsv`,
      `docker container run --rm -v ${P}_data:/d busybox cat /d/values.tsv`,
      `podman run --rm -v ${P}_data:/d busybox cat /d/values.tsv`,
      `docker create --name x -v ${P}_data:/d busybox`,
    ];
    for (const c of forms) expect([c, bash(c) !== null]).toEqual([c, true]);
  });

  test('cannot be read through the containers that mount it: exec, cp and a compose run of the database or a test service', () => {
    const forms = [
      `docker exec ${P}-db-1 cat /goodboy-data/values.tsv`,
      `docker exec -it ${P}-runner-1 sh -c 'cat /goodboy-data/values.tsv'`,
      `docker cp ${P}-db-1:/goodboy-data/values.tsv /tmp/values.tsv`,
      `docker compose -p ${P} exec db cat /goodboy-data/values.tsv`,
      `docker compose -f .goodboy/sandbox/compose.yml run --rm runner cat /goodboy-data/values.tsv`,
      `docker compose -f .goodboy/sandbox/compose.yml run --rm reader cat /goodboy-data/values.tsv`,
      `docker compose -f .goodboy/sandbox/compose.yml run --rm e2e sh -c 'cat $GOODBOY_DATA'`,
      `docker run --rm --volumes-from ${P}-db-1 busybox cat /goodboy-data/values.tsv`,
      `docker logs ${P}-runner-1`,
    ];
    for (const c of forms) expect([c, bash(c) !== null]).toEqual([c, true]);
  });

  test("goodboy's own CLI resolves, runs and clears the values, and the manifest (conditions, no value) may be read", () => {
    expect(bash(`bun ${OWN_CLI} sandbox-run --suite all`)).toBeNull();
    expect(bash(`bun ${OWN_CLI} sandbox-up`)).toBeNull();
    expect(bash('cat .goodboy/sandbox/data.json')).toBeNull();
    expect(bash('cat .goodboy/sandbox/data/GoodboyData.java')).toBeNull();
    expect(bash('cp .goodboy/sandbox/data/GoodboyData.java src/test/java/goodboy/GoodboyData.java')).toBeNull();
  });

  test('another project\'s volume of the same name is not this sandbox, and a plain docker run with no project word passes', () => {
    expect(bash('docker run --rm -v somevolume_data:/d busybox ls /d')).toBeNull();
    expect(bash('docker run --rm busybox echo hello')).toBeNull();
  });
});
