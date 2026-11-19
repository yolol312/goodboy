// Track M (plan §19): the branches of the sandbox files, render and run modules that the other
// sandbox tests do not reach: a scan or ledger that is not what goodboy wrote, a layout file that
// went stale or was edited, hosts the render cannot give a dummy, a mongo store, the sandbox
// commands called in this process, a health probe that fails once, a container on the host network.
// Repos are temp dirs; docker is a small script behind GOODBOY_DOCKER_BIN; openssl is the real one.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSandbox, readScan, writeLocal, writeScan } from '../lib/sandbox-files';
import { SANDBOX_DIR } from '../lib/sandbox-mode';
import { planSandbox } from '../lib/sandbox-render';
import { checkSandbox, loadCtx, sandboxCommand } from '../lib/sandbox-run';
import type { SandboxOutbound, SandboxScan, SandboxStore } from '../lib/sandbox-types';
import { keepEnv } from './m6b-helpers';

setDefaultTimeout(120_000);

const tmpDirs: string[] = [];
const restoreEnv = keepEnv('GOODBOY_DOCKER_BIN', 'DOCKER_HOST', 'HOME', 'FAKE_DOCKER_DIR');
afterEach(() => {
  restoreEnv();
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function dir(prefix = 'goodboy-m6s-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

const where = (file: string, line: number) => ({ file, line });
function store(kind: SandboxStore['kind'], over: Partial<SandboxStore> = {}): SandboxStore {
  return { kind, version: '', database: 'shop', configKeys: [`${kind}.url`], where: where('application.yml', 3), ...over };
}
function outbound(host: string, kind: SandboxOutbound['kind'], over: Partial<SandboxOutbound> = {}): SandboxOutbound {
  return { host, port: null, scheme: null, kind, where: where('application.yml', 5), callSite: where('src/A.java', 9), hardcoded: false, ipLiteral: false, ...over };
}
function scan(over: Partial<SandboxScan> = {}): SandboxScan {
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
    ...over,
  };
}
const NO_DUMP = { dump: null, dumpFormat: null };

describe('planSandbox hosts and stores', () => {
  test('an IP literal flag on a name, a name used by two kinds, a mongo store', () => {
    const p = planSandbox(
      scan({
        stores: [store('mongo')],
        outbound: [outbound('not-an-ip.example', 'http', { ipLiteral: true }), outbound('shared.example', 'http'), outbound('shared.example', 'smtp')],
      }),
      NO_DUMP,
      { readConfig: () => null },
    );
    expect(p.notes.some((n) => n.includes('is not an IPv4 literal: no dummy'))).toBe(true);
    expect(p.notes.some((n) => n.includes('is used as stubs and mail; the alias goes to stubs only'))).toBe(true);
    expect(p.upServices).toContain('mongo');
    const compose = Bun.YAML.parse(p.files.get('compose.yml')!) as { services: Record<string, { image: string }>; volumes: Record<string, unknown> };
    expect(compose.services.mongo!.image).toMatch(/^mongo:/);
    expect(Object.keys(compose.volumes)).toContain('mongodata');
    // a second mongo store is not started and says so
    const two = planSandbox(scan({ stores: [store('mongo'), store('mongo', { where: where('b.yml', 1) })] }), NO_DUMP, { readConfig: () => null });
    expect(two.notes.some((n) => n.includes('second one of its kind'))).toBe(true);
  });
});

describe('the scan, the local file and the ledger of a project that is not what goodboy wrote', () => {
  test('a scan.json that parses but misses fields is refused; a scan that cannot be written is an error', () => {
    const root = dir();
    mkdirSync(join(root, SANDBOX_DIR), { recursive: true });
    writeFileSync(join(root, SANDBOX_DIR, 'scan.json'), JSON.stringify({ ...scan(), build: null, root: '.' }));
    const r = readScan(root);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain('is not a scan goodboy wrote');
    // `.goodboy/sandbox` is a file: no dir can be made there
    const blocked = dir();
    mkdirSync(join(blocked, '.goodboy'), { recursive: true });
    writeFileSync(join(blocked, '.goodboy', 'sandbox'), 'x');
    expect(writeScan(blocked, scan())).toBeInstanceOf(Error);
  });

  test('a dump that does not exist is refused', () => {
    process.env.HOME = realpathSync(tmpdir());
    const r = writeLocal(dir(), join(tmpdir(), 'goodboy-no-such-dump.sql'), null);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain('does not exist');
  });

  test('init: a ledger that is a dir or not JSON is refused', async () => {
    const asDir = dir();
    mkdirSync(join(asDir, SANDBOX_DIR, '.written.json'), { recursive: true });
    expect(((await initSandbox(asDir, scan(), NO_DUMP, false)) as Error).message).toContain('is not a regular file');
    const junk = dir();
    mkdirSync(join(junk, SANDBOX_DIR), { recursive: true });
    writeFileSync(join(junk, SANDBOX_DIR, '.written.json'), '{ not json');
    expect(((await initSandbox(junk, scan(), NO_DUMP, false)) as Error).message).toContain('is not a ledger goodboy wrote');
  });

  test('init: written, kept, stale until forced, updated, drift when edited, drift when not a file', async () => {
    const root = dir();
    const first = await initSandbox(root, scan(), NO_DUMP, false);
    if (first instanceof Error) throw first;
    expect(first.written).toContain('compose.yml');
    expect(first.ca).toBe('created');
    // the same scan again: unchanged, and the CA is kept (its server.sans is read back)
    const again = await initSandbox(root, scan(), NO_DUMP, false);
    if (again instanceof Error) throw again;
    expect(again.unchanged).toContain('compose.yml');
    expect(again.ca).toBe('kept');
    // another port: the render changed and nobody edited the file: stale, then updated with force
    const moved = scan({ app: { port: 3100, contextPath: '/', healthPath: '/', configFiles: [] } });
    const stale = await initSandbox(root, moved, NO_DUMP, false);
    if (stale instanceof Error) throw stale;
    expect(stale.stale).toContain('compose.yml');
    const forced = await initSandbox(root, moved, NO_DUMP, true);
    if (forced instanceof Error) throw forced;
    expect(forced.updated).toContain('compose.yml');
    expect(readFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'utf8')).toContain('3100');
    // an edit by the user is drift, forced or not, and survives
    writeFileSync(join(root, SANDBOX_DIR, 'compose.yml'), '# mine\nservices: {}\n');
    const drift = await initSandbox(root, scan(), NO_DUMP, true);
    if (drift instanceof Error) throw drift;
    expect(drift.drift).toContain('compose.yml');
    expect(readFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'utf8')).toContain('# mine');
    // a dir where a file goes is drift too
    rmSync(join(root, SANDBOX_DIR, 'compose.yml'));
    mkdirSync(join(root, SANDBOX_DIR, 'compose.yml'));
    const notFile = await initSandbox(root, scan(), NO_DUMP, false);
    if (notFile instanceof Error) throw notFile;
    expect(notFile.drift).toContain('compose.yml');
  });
});

// A docker that answers from files in FAKE_DOCKER_DIR: `config` prints config.json, `ps -q` the ids in
// ps.txt, `inspect` inspect.json, the health probe fails as many times as fails.txt says, then passes.
const FAKE = `#!/bin/sh
d="$FAKE_DOCKER_DIR"
case " $* " in
  *" context "*) exit 0 ;;
  *" network ls "*) exit 0 ;;
  *" network inspect "*) echo '[]' ;;
  *" inspect "*) cat "$d/inspect.json" ;;
  *" config "*) cat "$d/config.json" ;;
  *" ps "*) cat "$d/ps.txt" 2>/dev/null ;;
  *" run "*)
    case " $* " in
      *"wget -S"*)
        n=$(cat "$d/fails.txt" 2>/dev/null || echo 0)
        if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$d/fails.txt"; exit 1; fi
        exit 0 ;;
    esac ;;
esac
exit 0
`;

async function fakeProject(): Promise<{ root: string; state: string }> {
  const root = dir();
  const w = writeScan(root, scan());
  if (w instanceof Error) throw w;
  const state = dir('goodboy-m6s-docker-');
  const bin = join(state, 'docker');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  mkdirSync(join(root, SANDBOX_DIR), { recursive: true });
  writeFileSync(join(root, SANDBOX_DIR, 'compose.yml'), 'services: {}\n');
  const ctx = loadCtx(root, true);
  if (ctx instanceof Error) throw ctx;
  writeFileSync(join(state, 'config.json'), JSON.stringify(Bun.YAML.parse(ctx.plan.files.get('compose.yml')!)));
  writeFileSync(join(state, 'ps.txt'), '');
  writeFileSync(join(state, 'inspect.json'), '[]');
  process.env.GOODBOY_DOCKER_BIN = bin;
  process.env.FAKE_DOCKER_DIR = state;
  delete process.env.DOCKER_HOST;
  return { root, state };
}

describe('sandboxCommand in this process', () => {
  test('sandbox-scan writes the scan and its exit code follows the problems', async () => {
    const root = dir();
    Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    writeFileSync(join(root, 'README.md'), 'x');
    const r = await sandboxCommand('sandbox-scan', root, []);
    if ('error' in r) throw new Error(r.error);
    expect(r.code).toBe(1); // no build tool found
    expect(existsSync(join(root, SANDBOX_DIR, 'scan.json'))).toBe(true);
    const blocked = dir();
    mkdirSync(join(blocked, '.goodboy'), { recursive: true });
    writeFileSync(join(blocked, '.goodboy', 'sandbox'), 'x');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: blocked, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect('error' in (await sandboxCommand('sandbox-scan', blocked, []))).toBe(true);
  });

  test('sandbox-local: the arguments are checked, the dump is written', async () => {
    process.env.HOME = realpathSync(tmpdir());
    const root = dir();
    const dump = join(dir(), 'shop.sql');
    writeFileSync(dump, 'select 1;');
    for (const args of [[], ['--dump'], ['--dump', '--format'], ['--dump', dump, '--format', 'xml']]) {
      expect('error' in (await sandboxCommand('sandbox-local', root, args))).toBe(true);
    }
    expect('error' in (await sandboxCommand('sandbox-local', root, ['--dump', join(dump, 'nope')]))).toBe(true);
    const ok = await sandboxCommand('sandbox-local', root, ['--dump', dump, '--format', 'sql']);
    expect('out' in ok && ok.code).toBe(0);
  });

  test('sandbox-init: no scan, a scan with problems, a local file that is not one, then the files', async () => {
    const none = dir();
    expect('error' in (await sandboxCommand('sandbox-init', none, []))).toBe(true);
    const bad = dir();
    writeScan(bad, scan({ problems: ['no build tool'] }));
    const r = await sandboxCommand('sandbox-init', bad, []);
    expect('error' in r && r.error).toContain('the scan has problems');
    const junkLocal = dir();
    writeScan(junkLocal, scan());
    writeFileSync(join(junkLocal, SANDBOX_DIR, 'local.json'), '{ not json');
    expect('error' in (await sandboxCommand('sandbox-init', junkLocal, []))).toBe(true);
    const good = dir();
    writeScan(good, scan());
    const ok = await sandboxCommand('sandbox-init', good, []);
    expect('out' in ok && ok.code).toBe(0);
    // an edited file is drift: the exit code says so
    writeFileSync(join(good, SANDBOX_DIR, 'compose.yml'), '# mine\n');
    const drift = await sandboxCommand('sandbox-init', good, []);
    expect('out' in drift && drift.code).toBe(1);
    // no file rendered yet: an error for a command that needs them
    const noFiles = dir();
    writeScan(noFiles, scan());
    expect('error' in (await sandboxCommand('sandbox-check', noFiles, []))).toBe(true);
    expect('error' in (await sandboxCommand('sandbox-nope', good, []))).toBe(true);
  });

  test('sandbox-up waits for an app health probe that fails once, then reports the app up', async () => {
    const { root, state } = await fakeProject();
    writeFileSync(join(state, 'fails.txt'), '1');
    const r = await sandboxCommand('sandbox-up', root, ['--wait-seconds', '30']);
    if ('error' in r) throw new Error(r.error);
    expect(r.code).toBe(0);
    expect(readFileSync(join(state, 'fails.txt'), 'utf8').trim()).toBe('0');
  }, 60_000);
});

describe('checkSandbox', () => {
  test('a container on the host network is a problem', async () => {
    const { root, state } = await fakeProject();
    writeFileSync(join(state, 'ps.txt'), 'id-1\n');
    writeFileSync(join(state, 'inspect.json'), JSON.stringify([{ Id: 'id-1', Name: '/hosty', Config: { Labels: {} }, HostConfig: { NetworkMode: 'host' }, NetworkSettings: { Networks: {} } }]));
    const ctx = loadCtx(root, true);
    if (ctx instanceof Error) throw ctx;
    const c = await checkSandbox(ctx);
    expect(c.inner_only).toBe(false);
    expect(c.problems).toContain('container hosty uses the host network');
  });

  test('docker inspect that prints no list fails closed', async () => {
    const { root, state } = await fakeProject();
    writeFileSync(join(state, 'ps.txt'), 'id-1\n');
    writeFileSync(join(state, 'inspect.json'), 'not json');
    const ctx = loadCtx(root, true);
    if (ctx instanceof Error) throw ctx;
    const c = await checkSandbox(ctx);
    expect(c.inner_only).toBe(false);
    expect(c.problems.some((p) => p.startsWith('docker inspect failed'))).toBe(true);
  });
});
