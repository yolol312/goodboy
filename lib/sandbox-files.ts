// The sandbox's files on disk (track M, M1b; plan §19): reading the scan and the local answers,
// writing the rendered files without ever overwriting what the user changed, and making the
// sandbox CA with the host's openssl. Every write goes through a temp file and a rename, into a
// directory that is a real directory (a linked `.goodboy` would send the write outside the repo).

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, type Stats, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { runBounded } from './bounded';
import { KEYSTORE_PASSWORD, planSandbox, SANDBOX_DIR, SCAN_FILE, type SandboxPlan } from './sandbox-render';
import { MAX_DOC_BYTES, readRegular } from './safe-read';
import { isStrings, sha } from './sandbox-proof';
import type { SandboxLocal, SandboxScan, SandboxStack } from './sandbox-types';

export const LOCAL_FILE = `${SANDBOX_DIR}/local.json`;
export const LEDGER_FILE = `${SANDBOX_DIR}/.written.json`;
const STACKS: readonly SandboxStack[] = ['jvm', 'node', 'python'];

const isWhere = (v: unknown) => typeof v === 'object' && v !== null && typeof (v as { file?: unknown }).file === 'string' && typeof (v as { line?: unknown }).line === 'number';

/** The scan `sandbox-scan` wrote, or an Error to show. */
export function readScan(root: string): SandboxScan | Error {
  const p = join(root, SCAN_FILE);
  const r = readRegular(p, MAX_DOC_BYTES, true);
  if (r === 'absent') return new Error(`${SCAN_FILE} is missing; run sandbox-scan first`);
  if (r === 'refused') return new Error(`${p} is not a regular file of at most ${MAX_DOC_BYTES} bytes`);
  try {
    const s = JSON.parse(r.text) as SandboxScan;
    const ok =
      typeof s === 'object' &&
      s !== null &&
      typeof s.root === 'string' &&
      STACKS.includes(s.stack) &&
      isStrings(s.frameworks) &&
      typeof s.build === 'object' &&
      s.build !== null &&
      typeof s.build.tool === 'string' &&
      isStrings(s.build.depsCommand) &&
      isStrings(s.build.buildCommand) &&
      isStrings(s.build.testCommand) &&
      isStrings(s.build.startCommand) &&
      typeof s.app === 'object' &&
      s.app !== null &&
      typeof s.app.port === 'number' &&
      typeof s.app.contextPath === 'string' &&
      typeof s.app.healthPath === 'string' &&
      Array.isArray(s.stores) &&
      s.stores.every((x) => typeof x === 'object' && x !== null && typeof x.kind === 'string' && isStrings(x.configKeys) && isWhere(x.where)) &&
      Array.isArray(s.outbound) &&
      s.outbound.every((o) => typeof o === 'object' && o !== null && typeof o.host === 'string' && typeof o.kind === 'string' && isWhere(o.where)) &&
      isStrings(s.secretKeys) &&
      isStrings(s.questions) &&
      isStrings(s.problems);
    if (ok) return s;
  } catch {
    // below
  }
  return new Error(`${p} is not a scan goodboy wrote; run sandbox-scan again`);
}

/** `realpath(p)`, or `p` itself when it does not exist (yet). */
export function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A repo root as the paths under it may spell it: lexical and real, once each. */
export const repoTops = (root: string): string[] => [...new Set([root, realOrSelf(root)])];

/** The local answers; empty ones when there is no local.json, an Error when it is unreadable. */
export function readLocal(root: string): SandboxLocal | Error {
  const p = join(root, LOCAL_FILE);
  const r = readRegular(p, 64 * 1024, true);
  if (r === 'absent') return { dump: null, dumpFormat: null };
  if (r === 'refused') return new Error(`${p} is not a regular file; move it away`);
  try {
    const l = JSON.parse(r.text) as SandboxLocal;
    const okDump = l.dump === null || (typeof l.dump === 'string' && isAbsolute(l.dump));
    const okFormat = l.dumpFormat === null || l.dumpFormat === 'sql' || l.dumpFormat === 'custom';
    if (okDump && okFormat) return { dump: l.dump, dumpFormat: l.dumpFormat };
  } catch {
    // below
  }
  return new Error(`${p} is not a local file goodboy wrote; run sandbox-local --dump <path> again`);
}

/** `root/rel` made a real directory, each part of it: an Error when one is a link or a file
 *  (a write would land outside the repo). */
export function ensureRealDir(root: string, rel: string): void {
  let cur = root;
  for (const part of rel.split('/').filter(Boolean)) {
    cur = join(cur, part);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is a link or not a directory; goodboy writes the sandbox only into real directories`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      mkdirSync(cur);
    }
  }
}

/** Writes `text` to `abs` through a temp file and a rename; a link at `abs` is replaced, never
 *  followed. */
export function writeAtomic(abs: string, text: string, mode = 0o644): void {
  const tmp = `${abs}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode });
    renameSync(tmp, abs);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // not made
    }
    throw err;
  }
}

/** Writes `.goodboy/sandbox/scan.json`, the scan `sandbox-init` builds from (M1a). The file is
 *  committed with the repo, so it keeps `root` as `.`: no absolute path of this machine. */
export function writeScan(root: string, scan: SandboxScan): string | Error {
  try {
    ensureRealDir(root, '.goodboy/sandbox');
    const abs = join(root, '.goodboy', 'sandbox', 'scan.json');
    writeAtomic(abs, `${JSON.stringify({ ...scan, root: '.' }, null, 2)}\n`);
    return abs;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const within = (p: string, base: string): boolean => p === base || p.startsWith(base.endsWith(sep) ? base : base + sep);

export type DockerKind = 'colima' | 'desktop' | 'native' | 'unknown';

/** Which docker the commands talk to, from `DOCKER_HOST` or the current context's name and
 *  endpoint: Colima (a VM that mounts only the home directory by default), Docker Desktop (shares
 *  /Users, /Volumes, /private, /tmp and /var/folders on macOS), native Linux docker (no VM), or
 *  unknown (no docker answered, or an endpoint of none of those). */
export function dockerKind(platform: NodeJS.Platform = process.platform): DockerKind {
  let id = process.env.DOCKER_HOST?.trim() ?? '';
  if (id === '') {
    try {
      const r = Bun.spawnSync([process.env.GOODBOY_DOCKER_BIN?.trim() || 'docker', 'context', 'inspect', '--format', '{{.Name}} {{.Endpoints.docker.Host}}'], { stdout: 'pipe', stderr: 'ignore', timeout: 10_000 });
      if (r.exitCode === 0) id = r.stdout.toString().trim();
    } catch {
      // no docker binary: unknown
    }
  }
  if (/colima/i.test(id)) return 'colima';
  if (/desktop|\.docker\/(?:desktop|run)\//i.test(id)) return 'desktop';
  if (platform === 'linux' && /unix:\/\//.test(id)) return 'native';
  return 'unknown';
}

/** The directories Docker Desktop shares with its VM by default. */
const DESKTOP_ROOTS = ['/Users', '/Volumes', '/private', '/tmp', '/var/folders'];

/** Why this dump can not be used, or null. Inside the repo it is one `git add` from being
 *  committed and the preparation step would mount it. Outside what the docker VM mounts the
 *  sandbox would restore an empty file: with Colima (the decided runtime) or an unknown docker,
 *  that is everything outside the home directory; Docker Desktop shares more (DESKTOP_ROOTS on
 *  macOS, the home directory elsewhere); native Linux docker has no such rule. */
export function dumpProblem(root: string, dump: string, opts: { kind?: DockerKind; platform?: NodeJS.Platform } = {}): string | null {
  if (!existsSync(dump)) return null;
  const d = realOrSelf(dump);
  const top = realOrSelf(root);
  if (within(d, top)) return `${dump} is inside the repository (${top}); keep the dump outside it, so it can not be committed or reach the preparation step`;
  const platform = opts.platform ?? process.platform;
  const kind = opts.kind ?? dockerKind(platform);
  if (kind === 'native') return null;
  // $HOME as the process sees it now (os.homedir() can keep the value from the start)
  const home = realOrSelf(process.env.HOME?.trim() || homedir());
  if (kind === 'desktop' && platform === 'darwin') {
    return DESKTOP_ROOTS.some((r) => within(d, realOrSelf(r))) ? null : `${dump} is outside Docker Desktop's shared folders (${DESKTOP_ROOTS.join(', ')}), so the sandbox would see an empty file: move the dump into one of them`;
  }
  if (within(d, home)) return null;
  const who = kind === 'colima' ? 'Colima mounts only the home directory by default' : kind === 'desktop' ? "Docker Desktop shares only the home directory here" : 'the docker VM (Colima, the decided runtime) mounts only the home directory by default, and this docker could not be told apart from it';
  return `${dump} is outside your home directory (${home}); ${who}, so the sandbox would see an empty file: move the dump there${kind === 'colima' ? " or add its directory to Colima's mounts" : ''}`;
}

/** Writes `.goodboy/sandbox/local.json` (mode 0600): the dump path and format. */
export function writeLocal(root: string, dump: string, format: 'sql' | 'custom' | null): { path: string; local: SandboxLocal } | Error {
  if (!isAbsolute(dump)) return new Error('--dump needs an absolute path');
  let st: Stats;
  try {
    st = statSync(dump);
  } catch {
    return new Error(`${dump} does not exist`);
  }
  if (!st.isFile()) return new Error(`${dump} is not a file`);
  const problem = dumpProblem(root, dump);
  if (problem !== null) return new Error(problem);
  const fmt: 'sql' | 'custom' = format ?? (/\.(dump|custom|backup|pgdump)$/i.test(dump) ? 'custom' : 'sql');
  const local: SandboxLocal = { dump: resolve(dump), dumpFormat: fmt };
  ensureRealDir(root, SANDBOX_DIR);
  const ignore = join(root, SANDBOX_DIR, '.gitignore');
  if (!existsSync(ignore)) writeAtomic(ignore, 'local.json\nout/\nca/*.key\n*.p12\n');
  const path = join(root, LOCAL_FILE);
  writeAtomic(path, JSON.stringify(local, null, 2) + '\n', 0o600);
  return { path, local };
}

interface Ledger {
  schema: 1;
  files: Record<string, string>;
}

function readLedger(root: string): Ledger | Error {
  const p = join(root, LEDGER_FILE);
  const r = readRegular(p, MAX_DOC_BYTES, true);
  if (r === 'absent') return { schema: 1, files: {} };
  if (r === 'refused') return new Error(`${p} is not a regular file; move it away`);
  try {
    const l = JSON.parse(r.text) as Ledger;
    if (l?.schema === 1 && typeof l.files === 'object' && l.files !== null && Object.values(l.files).every((h) => typeof h === 'string')) return l;
  } catch {
    // below
  }
  return new Error(`${p} is not a ledger goodboy wrote; move it away to adopt the files again`);
}

export interface InitReport {
  dir: string;
  written: string[];
  /** Owned and unchanged, replaced with a new render (`--force`). */
  updated: string[];
  unchanged: string[];
  /** Owned and unchanged since written, but the render changed: `--force` replaces them. */
  stale: string[];
  /** Changed by the user (or not made by goodboy): never overwritten. */
  drift: string[];
  ca: 'created' | 'kept' | 'server-renewed';
  notes: string[];
  questions: string[];
}

const OPENSSL = () => process.env.GOODBOY_OPENSSL_BIN?.trim() || 'openssl';

async function openssl(cwd: string, args: string[]): Promise<void> {
  const r = await runBounded([OPENSSL(), ...args], { cwd, timeoutMs: 60_000 });
  if (r.error !== undefined || r.code !== 0) throw new Error(`openssl ${args[0]} failed: ${r.error ?? r.stderr.trim().slice(0, 300)}`);
}

const CA_FILES = ['ca.crt', 'ca.key', 'server.crt', 'server.key', 'server.p12', 'server.sans'];

/** Makes `ca/`: a CA (kept once made) and one server certificate for every dummy name, made
 *  again when the names change. A link where a file goes is refused: openssl would write
 *  through it. */
async function ensureCa(root: string, sans: SandboxPlan['sans']): Promise<InitReport['ca']> {
  const caRel = `${SANDBOX_DIR}/ca`;
  ensureRealDir(root, caRel);
  const ca = join(root, caRel);
  for (const f of CA_FILES) {
    try {
      if (lstatSync(join(ca, f)).isSymbolicLink()) throw new Error(`${join(ca, f)} is a link; goodboy writes the CA only into regular files`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const sansText = [...sans.dns.map((d) => `DNS:${d}`), ...sans.ips.map((i) => `IP:${i}`)].join(',');
  const haveCa = existsSync(join(ca, 'ca.crt')) && existsSync(join(ca, 'ca.key'));
  const read = (f: string) => {
    const r = readRegular(join(ca, f), 64 * 1024, true);
    return typeof r === 'object' ? r.text : null;
  };
  const haveServer = ['server.crt', 'server.key', 'server.p12'].every((f) => existsSync(join(ca, f)));
  if (haveCa && haveServer && read('server.sans') === sansText) return 'kept';
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-ca-'));
  try {
    if (!haveCa) {
      for (const f of CA_FILES) rmSync(join(ca, f), { force: true });
      // the key file exists with mode 0600 before openssl writes into it, so it is never readable by others
      writeFileSync(join(ca, 'ca.key'), '', { mode: 0o600 });
      await openssl(tmp, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(ca, 'ca.key'), '-out', join(ca, 'ca.crt'), '-sha256', '-days', '3650', '-subj', '/CN=goodboy sandbox CA']);
      chmodSync(join(ca, 'ca.key'), 0o600);
    }
    for (const f of ['server.crt', 'server.key', 'server.p12', 'server.sans']) rmSync(join(ca, f), { force: true });
    writeFileSync(join(tmp, 'ext.cnf'), `subjectAltName=${sansText}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    writeFileSync(join(ca, 'server.key'), '', { mode: 0o600 });
    await openssl(tmp, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(ca, 'server.key'), '-out', join(tmp, 'server.csr'), '-subj', `/CN=${sans.dns[0] ?? 'sandbox'}`]);
    chmodSync(join(ca, 'server.key'), 0o600);
    await openssl(tmp, ['x509', '-req', '-in', join(tmp, 'server.csr'), '-CA', join(ca, 'ca.crt'), '-CAkey', join(ca, 'ca.key'), '-set_serial', `0x${randomBytes(8).toString('hex')}`, '-days', '825', '-sha256', '-extfile', join(tmp, 'ext.cnf'), '-out', join(ca, 'server.crt')]);
    // 3DES and SHA-1 keep the keystore readable by every JVM WireMock may run on.
    await openssl(tmp, ['pkcs12', '-export', '-in', join(ca, 'server.crt'), '-inkey', join(ca, 'server.key'), '-certfile', join(ca, 'ca.crt'), '-name', 'sandbox', '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-passout', `pass:${KEYSTORE_PASSWORD}`, '-out', join(ca, 'server.p12')]);
    writeAtomic(join(ca, 'server.sans'), sansText);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return haveCa ? 'server-renewed' : 'created';
}

/** Writes the sandbox's files: new files are made; a file goodboy wrote and nobody changed is
 *  replaced only with `force`; a file that differs from what goodboy wrote is drift and is
 *  never touched, `force` or not. The hash of each file written is kept in `.written.json`. */
export async function initSandbox(root: string, scan: SandboxScan, local: SandboxLocal, force: boolean): Promise<InitReport | Error> {
  const plan = planSandbox(scan, local, { root });
  const ledger = readLedger(root);
  if (ledger instanceof Error) return ledger;
  ensureRealDir(root, SANDBOX_DIR);
  const report: InitReport = { dir: join(root, SANDBOX_DIR), written: [], updated: [], unchanged: [], stale: [], drift: [], ca: 'kept', notes: plan.notes, questions: scan.questions };
  report.ca = await ensureCa(root, plan.sans);
  for (const [rel, text] of [...plan.files].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = join(root, SANDBOX_DIR, rel);
    if (rel.split('/').includes('..') || isAbsolute(rel) || !abs.startsWith(join(root, SANDBOX_DIR) + sep)) return new Error(`${rel} is outside the sandbox dir`);
    ensureRealDir(root, `${SANDBOX_DIR}/${dirname(rel) === '.' ? '' : dirname(rel)}`);
    const want = sha(text);
    const cur = readRegular(abs, MAX_DOC_BYTES, true);
    if (cur === 'refused') {
      report.drift.push(rel);
      continue;
    }
    if (cur === 'absent') {
      writeAtomic(abs, text);
      ledger.files[rel] = want;
      report.written.push(rel);
      continue;
    }
    const have = sha(cur.text);
    if (have === want) {
      ledger.files[rel] = want;
      report.unchanged.push(rel);
    } else if (ledger.files[rel] === have) {
      if (force) {
        writeAtomic(abs, text);
        ledger.files[rel] = want;
        report.updated.push(rel);
      } else report.stale.push(rel);
    } else report.drift.push(rel);
  }
  writeAtomic(join(root, LEDGER_FILE), JSON.stringify(ledger, null, 2) + '\n');
  return report;
}

/** The rendered files that differ from what is on disk, for a run's warning. */
export function outOfDate(root: string, plan: SandboxPlan): string[] {
  const out: string[] = [];
  for (const [rel, text] of plan.files) {
    const cur = readRegular(join(root, SANDBOX_DIR, rel), MAX_DOC_BYTES, true);
    if (typeof cur !== 'object' || cur.text !== text) out.push(rel);
  }
  return out;
}
