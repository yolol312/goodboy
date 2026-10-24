// Track M fix round 1, fixer A (plan §19): what the sandbox keeps out of reach — the dump (A5),
// the prep step's view of the repo (A5), and the static check that guards both.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerKind, dumpProblem, initSandbox, writeLocal } from '../lib/sandbox-files';
import { planSandbox } from '../lib/sandbox-render';
import { staticProblems } from '../lib/sandbox-run';
import type { SandboxScan } from '../lib/sandbox-types';

setDefaultTimeout(60_000);

const tmpDirs: string[] = [];
const savedHome = process.env.HOME;
const savedBin = process.env.GOODBOY_DOCKER_BIN;
const savedHost = process.env.DOCKER_HOST;
afterEach(() => {
  for (const [k, v] of [['GOODBOY_DOCKER_BIN', savedBin], ['DOCKER_HOST', savedHost]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function dir(prefix = 'goodboy-mfa-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

function scan(): SandboxScan {
  return {
    root: '/nonexistent/repo',
    stack: 'node',
    frameworks: ['express'],
    build: { tool: 'npm', runtimeVersion: '20', depsCommand: ['npm', 'ci'], buildCommand: [], testCommand: ['npm', 'test'], startCommand: ['node', 'index.js'], artifact: null },
    app: { port: 3000, contextPath: '/', healthPath: '/', configFiles: [] },
    stores: [],
    outbound: [],
    secretKeys: [],
    questions: [],
    problems: [],
  };
}

interface Svc {
  tmpfs?: string[];
  volumes?: string[];
}
const compose = () => (Bun.YAML.parse(planSandbox(scan(), { dump: null, dumpFormat: null }, { readConfig: () => null }).files.get('compose.yml')!) as { services: Record<string, Svc> }).services;

describe('A5: the prep services do not see the sandbox dir', () => {
  test('prep and e2e-prep mount the repo at /src with an empty tmpfs on /src/.goodboy, and no other service has one', () => {
    const s = compose();
    for (const name of ['prep', 'e2e-prep']) {
      expect(s[name]!.volumes).toContain('../..:/src:ro');
      expect(s[name]!.tmpfs).toEqual(['/src/.goodboy']);
    }
    for (const [name, svc] of Object.entries(s)) if (name !== 'prep' && name !== 'e2e-prep') expect(svc.tmpfs).toBeUndefined();
  });

  const cfg = (extra: Record<string, unknown>) => ({
    services: { prep: { profiles: ['prep'], networks: ['prep'], volumes: [{ type: 'bind', source: '/work/repo', target: '/src', read_only: true }], ...extra } },
    networks: { prep: {} },
  });

  test('the static check flags a prep service that binds the repo without the mask', () => {
    const problems = staticProblems(cfg({}), '/work/repo');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('service prep mounts the repository at /src');
  });

  test('a service-level tmpfs, a tmpfs volume entry and a tmpfs with options all count as the mask', () => {
    expect(staticProblems(cfg({ tmpfs: ['/src/.goodboy'] }), '/work/repo')).toEqual([]);
    expect(staticProblems(cfg({ tmpfs: ['/src/.goodboy:size=1m'] }), '/work/repo')).toEqual([]);
    expect(staticProblems(cfg({ volumes: [{ type: 'bind', source: '/work/repo', target: '/src' }, { type: 'tmpfs', target: '/src/.goodboy' }] }), '/work/repo')).toEqual([]);
  });

  test('a mask on another path does not count; a bind of a dir outside the repo is refused by the allowlist instead; no root means no mount check', () => {
    expect(staticProblems(cfg({ tmpfs: ['/src/other'] }), '/work/repo')).toHaveLength(1);
    expect(staticProblems(cfg({}), '/elsewhere')).toEqual([expect.stringContaining('binds /work/repo, which is neither inside the repository nor the dump file')]);
    expect(staticProblems(cfg({})).length).toBe(0);
  });
});

describe('A5: sandbox-local refuses a dump that is in the repo or outside the home directory', () => {
  /** A fake home with a repo in it and a dump file next to the repo. */
  function setup(): { home: string; root: string; dump: string } {
    const home = dir('goodboy-mfa-home-');
    process.env.HOME = home;
    const root = join(home, 'repo');
    mkdirSync(root);
    const dump = join(home, 'shop.sql');
    writeFileSync(dump, 'select 1;');
    return { home, root, dump };
  }

  test('a dump under the home directory and outside the repo is accepted', () => {
    const { root, dump } = setup();
    const w = writeLocal(root, dump, null);
    expect(w).not.toBeInstanceOf(Error);
  });

  test('a dump inside the repo is refused, also through a link', () => {
    const { home, root } = setup();
    const inside = join(root, 'data', 'x.sql');
    mkdirSync(join(root, 'data'));
    writeFileSync(inside, 'select 1;');
    const w = writeLocal(root, inside, null);
    expect(w).toBeInstanceOf(Error);
    expect((w as Error).message).toContain('inside the repository');
    const link = join(home, 'link.sql');
    symlinkSync(inside, link);
    expect(writeLocal(root, link, null)).toBeInstanceOf(Error);
  });

  /** A fake docker whose current context is `name endpoint`, for the dump rule (nothing else is asked of it). */
  function dockerIs(idLine: string): void {
    const work = dir('goodboy-mfa-docker-');
    const bin = join(work, 'docker');
    writeFileSync(bin, `#!/bin/sh\necho "${idLine}"\n`);
    chmodSync(bin, 0o755);
    process.env.GOODBOY_DOCKER_BIN = bin;
    delete process.env.DOCKER_HOST;
  }

  test('a dump outside the home directory is refused with the reason', () => {
    dockerIs('colima unix:///Users/me/.colima/default/docker.sock');
    const { root } = setup();
    const elsewhere = dir('goodboy-mfa-else-');
    const dump = join(elsewhere, 'x.sql');
    writeFileSync(dump, 'select 1;');
    const w = writeLocal(root, dump, null);
    expect(w).toBeInstanceOf(Error);
    expect((w as Error).message).toContain('outside your home directory');
    expect((w as Error).message).toContain('Colima mounts only the home directory by default');
  });

  test('which docker it is: Colima, Docker Desktop, native Linux, or unknown, from the context and DOCKER_HOST', () => {
    dockerIs('colima unix:///Users/me/.colima/default/docker.sock');
    expect(dockerKind('darwin')).toBe('colima');
    dockerIs('desktop-linux unix:///Users/me/.docker/run/docker.sock');
    expect(dockerKind('darwin')).toBe('desktop');
    dockerIs('default unix:///var/run/docker.sock');
    expect(dockerKind('linux')).toBe('native');
    expect(dockerKind('darwin')).toBe('unknown');
    dockerIs('remote ssh://me@box');
    expect(dockerKind('linux')).toBe('unknown');
    process.env.GOODBOY_DOCKER_BIN = '/nonexistent/docker';
    expect(dockerKind('linux')).toBe('unknown');
    process.env.DOCKER_HOST = 'unix:///Users/me/.colima/default/docker.sock';
    expect(dockerKind('linux')).toBe('colima');
  });

  test('the rule per docker: Colima and unknown refuse outside the home directory, Docker Desktop outside its shared folders, native Linux never', () => {
    const { home, root } = setup();
    const elsewhere = dir('goodboy-mfa-else-');
    const dump = join(elsewhere, 'x.sql');
    writeFileSync(dump, 'select 1;');
    const inHome = join(home, 'shop.sql');
    const d = (kind: 'colima' | 'desktop' | 'native' | 'unknown', platform: NodeJS.Platform, file = dump) => dumpProblem(root, file, { kind, platform });
    // a dump in the home directory is fine everywhere
    for (const kind of ['colima', 'desktop', 'native', 'unknown'] as const) expect([kind, d(kind, 'darwin', inHome)]).toEqual([kind, null]);
    expect(d('colima', 'darwin')).toContain('Colima mounts only the home directory by default');
    expect(d('colima', 'darwin')).toContain("Colima's mounts");
    expect(d('unknown', 'linux')).toContain('could not be told apart');
    expect(d('native', 'linux')).toBeNull();
    // Docker Desktop on macOS: /var/folders (where the temp dir is), /tmp, /private, /Users, /Volumes are shared
    expect(d('desktop', 'darwin')).toBeNull();
    expect(dumpProblem(root, '/usr/bin/env', { kind: 'desktop', platform: 'darwin' })).toContain("outside Docker Desktop's shared folders (/Users, /Volumes, /private, /tmp, /var/folders)");
    // on Linux Docker Desktop shares the home directory only
    expect(d('desktop', 'linux')).toContain('Docker Desktop shares only the home directory');
    // the in-repo rule holds for every docker
    const inside = join(root, 'dump.sql');
    writeFileSync(inside, 'x');
    for (const kind of ['colima', 'desktop', 'native', 'unknown'] as const) expect([kind, d(kind, 'darwin', inside)]).toEqual([kind, expect.stringContaining('inside the repository')]);
  });

  test('writeLocal follows the docker it finds: native Linux accepts a dump outside the home directory', () => {
    dockerIs('default unix:///var/run/docker.sock');
    const { root } = setup();
    const elsewhere = dir('goodboy-mfa-else-');
    const dump = join(elsewhere, 'x.sql');
    writeFileSync(dump, 'select 1;');
    // the platform is the real one: this holds where the check says native (linux) and is skipped elsewhere
    if (process.platform === 'linux') expect(writeLocal(root, dump, null)).not.toBeInstanceOf(Error);
    else expect(writeLocal(root, dump, null)).toBeInstanceOf(Error);
  });

  test('refusing writes nothing', () => {
    dockerIs('colima unix:///Users/me/.colima/default/docker.sock');
    const { root } = setup();
    const elsewhere = dir('goodboy-mfa-else-');
    const dump = join(elsewhere, 'x.sql');
    writeFileSync(dump, 'select 1;');
    writeLocal(root, dump, null);
    expect(Bun.file(join(root, '.goodboy', 'sandbox', 'local.json')).size).toBe(0);
  });
});

describe('lows: the private keys are 0600 before openssl writes them', () => {
  test('ca.key and server.key exist with mode 0600 when openssl is called', async () => {
    const work = dir();
    const log = join(work, 'openssl.log');
    const bin = join(work, 'openssl');
    // a fake openssl: logs the mode of each -keyout file at the moment it is called, then makes the outputs the way a plain umask would
    writeFileSync(
      bin,
      `#!/bin/sh
prev=""
for a in "$@"; do
  case "$prev" in
    -keyout) m=$(stat -f %Lp "$a" 2>/dev/null || stat -c %a "$a" 2>/dev/null || echo missing); echo "$(basename "$a") $m" >> "${log}"; [ -e "$a" ] || : > "$a" ;;
    -out) : > "$a" ;;
  esac
  prev="$a"
done
exit 0
`,
    );
    chmodSync(bin, 0o755);
    const saved = process.env.GOODBOY_OPENSSL_BIN;
    process.env.GOODBOY_OPENSSL_BIN = bin;
    try {
      const root = join(work, 'repo');
      mkdirSync(join(root, '.goodboy', 'sandbox'), { recursive: true });
      const rep = await initSandbox(root, scan(), { dump: null, dumpFormat: null }, false);
      expect(rep).not.toBeInstanceOf(Error);
      const modes = readFileSync(log, 'utf8').trim().split('\n');
      expect(modes).toEqual(['ca.key 600', 'server.key 600']);
      for (const f of ['ca.key', 'server.key']) expect(statSync(join(root, '.goodboy', 'sandbox', 'ca', f)).mode & 0o777).toBe(0o600);
      expect(existsSync(join(root, '.goodboy', 'sandbox', 'ca', 'server.p12'))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GOODBOY_OPENSSL_BIN;
      else process.env.GOODBOY_OPENSSL_BIN = saved;
    }
  });
});

beforeEach(() => {
  // every test starts with the real home; the A5 setup replaces it
  if (savedHome !== undefined) process.env.HOME = savedHome;
});
