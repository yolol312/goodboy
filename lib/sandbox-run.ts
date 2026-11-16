// Running the sandbox (track M, M1b; plan §19): the `sandbox-*` commands. Every docker call goes
// through GOODBOY_DOCKER_BIN (default `docker`) with the bounded runner and a timeout. Nothing
// here calls the network except `sandbox-prepare` (image pulls and the preparation step, the
// only places the compose file gives network access to).

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { type Bounded, onInterrupt, runBounded } from './bounded';
import { type Boundary, boundary, type Diag, type DiagCode, OPEN, realDataOf } from './sandbox-boundary';
import { addInputs, clearRealData, ensureRealDir, initSandbox, outOfDate, readScan, repoTops, writeAtomic, writeLocal, writePlainLocal, writeScan } from './sandbox-files';
import { E2E_OUTPUT_LOG_FILE, LOCAL_FILE, OUTPUT_LOG_FILE, projectName, readLocal, realOrSelf, SANDBOX_DIR } from './sandbox-mode';
import { registerRealData, registryEntryOf } from './sandbox-registry';
import { noLinksUnder } from './sandbox-proof';
import { COVERAGE_REPORT, E2E_DIR } from './sandbox-e2e';
import { planSandbox, type SandboxPlan } from './sandbox-render';
import { dbName, INHIBIT_IPV4, RESTORE_TAG } from './sandbox-parts';
import { type DataCtx, isRefusal, sandboxData } from './sandbox-data';
import { hasDataVolume, isEmpty, manifestCounts, type Memo, newToken, NO_DATA_VOLUME, readManifest, refusedStop, type ResolveStop, resolveValues } from './sandbox-resolve';
import { scanSandbox } from './sandbox-scan';
import { clearData, type DockOpts, e2eAfter, finish, metaKey, readFiles, sweepRaw, unitAfter, writeState } from './sandbox-store';
import { type E2eSummary, playwrightSummary, type RunSummary, type UnitSummary } from './sandbox-summary';
import type { SandboxCheck, SandboxLocal, SandboxScan } from './sandbox-types';
import { COVERAGE_READ_BYTES, LIVE_DIR, MAX_READ_BYTES, runDirIn, volumeMarker } from './sandbox-volumes';
import { STORED_FILE, storedUiCheck, uiCheck } from './ui-check';
import { uiInventory } from './ui-inventory';
import { ACCESS_LOG_FILE, PLAYWRIGHT_REPORT_FILE } from './ui-types';

const SHORT_MS = 60_000;
const DEFAULT_RUN_MS = 3_600_000;
const MAX_RUN_MS = 7_200_000;
const TAIL_CHARS = 2000;

export const dockerBin = (): string => process.env.GOODBOY_DOCKER_BIN?.trim() || 'docker';

export interface Ctx {
  root: string;
  dir: string;
  project: string;
  composeFile: string;
  scan: SandboxScan;
  local: SandboxLocal;
  plan: SandboxPlan;
  /** What may leave a command, and whether the project holds real data (M6a): see lib/sandbox-boundary.ts.
   *  The one place the mode lives; `preflight` can make it stricter, never looser. */
  out: Boundary;
  /** Runs a compose command of this project (the volume client of lib/sandbox-store.ts uses it). */
  comp(args: string[], timeoutMs: number, o?: DockOpts): Promise<Bounded>;
  /** Answers of one command's docker questions that every step of it shares (set by `preflight`). */
  memo?: Map<string, Promise<unknown>>;
  /** `preflight` made the mode strict only because docker did not answer (see StoreCtx.keepHostRaw). */
  keepHostRaw?: boolean;
  /** The SQL services whose read-only role could not be applied by the last `resetDb`. */
  roleFailed?: string[];
  /** The user-level registry of real-data sandboxes could not be read or written (lib/sandbox-registry.ts): the command
   *  says so next to its output; the PreToolUse rule then keeps to the per-repo reading. */
  registryProblem?: Diag;
}

/** The scan, the local answers and the plan; `needFiles` also wants the compose file written. */
export function loadCtx(root: string, needFiles: boolean): Ctx | Error {
  const scan = readScan(root);
  if (scan instanceof Error) return scan;
  const local = readLocal(root);
  if (local instanceof Error) return local;
  const dir = join(root, SANDBOX_DIR);
  const composeFile = join(dir, 'compose.yml');
  if (needFiles && !existsSync(composeFile)) return new Error(`${composeFile} is missing; run sandbox-init first`);
  const ctx: Ctx = { root, dir, project: projectName(root), composeFile, scan, local, plan: planSandbox(scan, local, { root }), out: boundary(realDataOf(local)), comp: (args, ms, o) => comp(ctx, args, ms, o) };
  return ctx;
}

const env = (ctx: Ctx): NodeJS.ProcessEnv => ({ ...process.env, ...(ctx.local.dump !== null ? { GOODBOY_DUMP: ctx.local.dump } : {}) });

function dock(ctx: Ctx, args: string[], timeoutMs: number, o: DockOpts = {}): Promise<Bounded> {
  return runBounded([dockerBin(), ...args], { cwd: ctx.dir, timeoutMs, env: env(ctx), ...o });
}

const comp = (ctx: Ctx, args: string[], timeoutMs: number, o: DockOpts = {}): Promise<Bounded> =>
  dock(ctx, ['compose', '-f', ctx.composeFile, '-p', ctx.project, ...args], timeoutMs, o);

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter(Boolean);

// ---- sandbox-check ----

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface ComposeService {
  profiles?: string[];
  networks?: Record<string, unknown> | string[];
  ports?: unknown[];
  network_mode?: string;
  volumes?: { type?: string; source?: string; target?: string }[];
  tmpfs?: string[] | string;
  privileged?: boolean;
  cap_add?: string[];
  devices?: unknown[];
  pid?: string;
  ipc?: string;
  userns_mode?: string;
  security_opt?: string[];
}

/** What no sandbox service may ask of the host, prep included: it would let a container (or the
 *  project's own build) act on the host or on the docker daemon itself. */
function hardeningProblems(name: string, svc: ComposeService, bind: BindRule | undefined): string[] {
  const out: string[] = [];
  if (Array.isArray(svc.security_opt) && svc.security_opt.some((o) => /unconfined/i.test(String(o)))) out.push(`service ${name} turns off a security profile (security_opt unconfined)`);
  if (svc.privileged === true) out.push(`service ${name} is privileged`);
  if (Array.isArray(svc.cap_add) && svc.cap_add.length > 0) out.push(`service ${name} adds capabilities (${svc.cap_add.join(', ')})`);
  if (Array.isArray(svc.devices) && svc.devices.length > 0) out.push(`service ${name} maps host devices`);
  for (const k of ['pid', 'ipc', 'userns_mode'] as const) if (svc[k] === 'host') out.push(`service ${name} shares the host's ${k === 'userns_mode' ? 'user namespace' : k} namespace`);
  for (const v of svc.volumes ?? []) {
    const src = String(typeof v === 'string' ? v : (v?.source ?? ''));
    if (/docker\.sock/.test(src)) out.push(`service ${name} mounts the docker socket`);
    // Bind sources are an allowlist (the repo and the dump): a bind of /var/run, /run, / or the
    // home directory would hand over the socket or the host without naming docker.sock.
    if (bind !== undefined && typeof v === 'object' && v !== null && v.type === 'bind' && typeof v.source === 'string' && !bindAllowed(v.source, bind)) {
      out.push(`service ${name} binds ${v.source}, which is neither inside the repository nor the dump file`);
    }
  }
  return out;
}

/** Where a bind mount may come from: the repo (the sandbox dir and its subdirs are inside it) and
 *  the one dump file. Named volumes and tmpfs are not binds. */
interface BindRule {
  tops: string[];
  dump: string | null;
}

function bindAllowed(source: string, rule: BindRule): boolean {
  const lexical = resolve(source);
  const src = [lexical, realOrSelf(lexical)];
  if (rule.dump !== null && src.some((s) => s === rule.dump || s === realOrSelf(rule.dump!))) return true;
  return rule.tops.some((t) => src.every((s) => s === t || s.startsWith(t.endsWith('/') ? t : `${t}/`)));
}

/** The ports of a host that a container on an internal network must not reach on the gateway. */
const GATEWAY_PORTS = [22, 80, 443, 2375, 2376, 8080];

/** The prep services have network access, so they must not see the sandbox's own dir: a bind
 *  of the repo needs an empty tmpfs on its `.goodboy`. */
function maskProblems(name: string, svc: ComposeService, root: string): string[] {
  const tops = new Set(repoTops(root));
  const tmpfs = [...(Array.isArray(svc.tmpfs) ? svc.tmpfs : typeof svc.tmpfs === 'string' ? [svc.tmpfs] : []).map((t) => String(t).split(':')[0]!), ...(svc.volumes ?? []).filter((v) => v?.type === 'tmpfs').map((v) => v.target ?? '')];
  const out: string[] = [];
  for (const v of svc.volumes ?? []) {
    if (v?.type !== 'bind' || typeof v.source !== 'string' || typeof v.target !== 'string' || !tops.has(v.source)) continue;
    if (!tmpfs.includes(`${v.target.replace(/\/+$/, '')}/.goodboy`)) out.push(`service ${name} mounts the repository at ${v.target} without an empty tmpfs on ${v.target}/.goodboy (local.json, the keys and the run output would be visible to a service with network access)`);
  }
  return out;
}

/** Why a compose config (`config --format json`) is not safe to start or run in, one string per
 *  problem. Every service, prep included: privileged, added capabilities, devices, host
 *  pid/ipc/user namespaces, the docker socket, an unconfined security profile, `network_mode`,
 *  published ports. Top-level volumes that are not plain named ones (driver options, another
 *  driver, external) and internal networks that keep a host address. Services outside the prep
 *  profile must be on internal networks only. With `root`, bind sources are an allowlist (the
 *  repo, and `dump` when given) and a prep service that mounts the repo needs an empty tmpfs on
 *  its `.goodboy`. */
export function staticProblems(cfg: unknown, root?: string, dump: string | null = null): string[] {
  const out: string[] = [];
  const c = cfg as { services?: Record<string, ComposeService>; networks?: Record<string, { internal?: boolean; driver_opts?: Record<string, unknown> }>; volumes?: Record<string, { driver?: string; driver_opts?: Record<string, unknown>; external?: unknown } | null> } | undefined;
  if (!c || typeof c !== 'object' || typeof c.services !== 'object' || c.services === null) return ['compose config has no services'];
  // The compose file makes only plain named volumes. One with driver options (`device`, `o=bind`
  // through the local driver) or one that is external is a host directory under a volume's name.
  for (const [name, vol] of Object.entries(c.volumes ?? {})) {
    if (vol && (vol.driver_opts !== undefined && Object.keys(vol.driver_opts).length > 0)) out.push(`volume ${name} has driver options (${Object.keys(vol.driver_opts).join(', ')}): it can be a host directory`);
    if (vol && vol.driver !== undefined && vol.driver !== '' && vol.driver !== 'local') out.push(`volume ${name} uses the ${vol.driver} driver`);
    if (vol && vol.external !== undefined && vol.external !== false) out.push(`volume ${name} is external: the sandbox makes its own volumes only`);
  }
  // An internal network with a host address lets a container reach the host's own services.
  for (const [name, net] of Object.entries(c.networks ?? {})) {
    if (net?.internal === true && String(net.driver_opts?.[INHIBIT_IPV4]) !== 'true') out.push(`network ${name} is internal but keeps an address for the host (driver_opts ${INHIBIT_IPV4} is not "true"): the host's own services are reachable from it`);
  }
  const bind: BindRule | undefined = root === undefined ? undefined : { tops: repoTops(root), dump };
  for (const [name, svc] of Object.entries(c.services)) {
    out.push(...hardeningProblems(name, svc, bind));
    // No service, prep included, shares a network namespace or publishes a port: prep needs only
    // the `prep` network, and nothing in the file is reached from the host.
    // `none` is allowed for the reader alone: a service with no network at all
    if (svc.network_mode && !(svc.network_mode === 'none' && name === 'reader')) out.push(`service ${name} sets network_mode ${svc.network_mode}`);
    if (Array.isArray(svc.ports) && svc.ports.length > 0) out.push(`service ${name} publishes ports`);
    const profiles = svc.profiles ?? [];
    if (profiles.length > 0 && profiles.every((p) => p === 'prep')) {
      if (root !== undefined) out.push(...maskProblems(name, svc, root));
      continue;
    }
    if (svc.network_mode === 'none' && name === 'reader') continue;
    const nets = svc.networks === undefined ? ['default'] : Array.isArray(svc.networks) ? svc.networks : Object.keys(svc.networks);
    for (const n of nets) if (c.networks?.[n]?.internal !== true) out.push(`service ${name} is on network ${n}, which is not internal`);
  }
  return out;
}

/** Why the docker daemon is not the local one, or null: the sandbox mounts local paths and keeps
 *  its data on the daemon's machine, so a remote daemon (`DOCKER_HOST` or the current context
 *  pointing at tcp://, ssh://) is refused. */
async function endpointProblem(ctx: Ctx): Promise<string | null> {
  const local = (h: string): boolean => h.startsWith('unix://') || h.startsWith('npipe://');
  const fromEnv = process.env.DOCKER_HOST?.trim();
  if (fromEnv) return local(fromEnv) ? null : `DOCKER_HOST is ${fromEnv}: the sandbox needs the local docker daemon (a remote one would not see its mounts and would hold the database copy on another machine)`;
  // the context's endpoint is asked once per command; the text is made at use, with the mode the command ends up with
  const h = await once(ctx, 'endpoint', async () => {
    const c = await dock(ctx, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], SHORT_MS);
    return c.code === 0 ? c.stdout.trim() : '';
  });
  // the endpoint is docker's own text: a code in real-data mode
  return h !== '' && !local(h) ? ctx.out.text(`the current docker context points at ${h}: the sandbox needs the local docker daemon (a remote one would not see its mounts and would hold the database copy on another machine)`, 'docker-failed', 'endpoint') : null;
}

/** `f()` once per command when `preflight` set the memo (the sweep and the command then share one
 *  `context inspect`, one `compose config` and one volume list), else every time. */
function once<T>(ctx: Ctx, key: string, f: () => Promise<T>): Promise<T> {
  if (ctx.memo === undefined) return f();
  let p = ctx.memo.get(key);
  if (p === undefined) {
    p = f();
    ctx.memo.set(key, p);
  }
  return p as Promise<T>;
}

/** The project's volumes (`docker volume ls`, by the compose project's label), or null when docker could not answer. */
async function projectVolumes(ctx: Ctx): Promise<string[] | null> {
  const r = await dock(ctx, ['volume', 'ls', '--filter', `label=com.docker.compose.project=${ctx.project}`, '--format', '{{.Name}}'], SHORT_MS);
  return r.code === 0 ? lines(r.stdout) : null;
}

/** A volume that holds the database copy: a SQL store's data or the Mongo store's. */
const isDataVolume = (ctx: Ctx, name: string): boolean => new RegExp(`^${ctx.project.replace(/[^a-z0-9-]/g, '')}_(?:db\\d*data|mongodata)$`).test(name);

/** What a command asks docker before it starts (M6a): is the daemon local, and does the project's database
 *  volume exist? A database volume, or a docker that cannot say, makes the project real-data whatever
 *  `local.json` says (the file is untracked and can be gone with `git clean`): `ctx.out` is made strict
 *  before any text of this command is built. Returns the project's volumes (null: unknown; undefined: the daemon is not local,
 *  and nothing was asked of it). */
async function preflight(ctx: Ctx): Promise<{ volumes: string[] | null | undefined }> {
  ctx.memo = new Map();
  // a project that says real data is in the user-level registry (a sandbox of M6a gets there with its next command)
  if (ctx.out.realData) register(ctx);
  if ((await endpointProblem(ctx)) !== null) return { volumes: undefined };
  const volumes = await once(ctx, 'volumes', () => projectVolumes(ctx));
  if ((volumes === null || volumes.some((v) => isDataVolume(ctx, v))) && !ctx.out.realData) {
    // A docker that did not answer makes the output strict, which is all it can justify: the sweep must not
    // take it for proof that the host's old raw files are a real-data run's (a plain project's output.log
    // would be deleted by an outage). A database volume is proof, and the registry hears of it.
    if (volumes === null) ctx.keepHostRaw = true;
    else register(ctx);
    ctx.out = boundary(true);
  }
  // docker answered, no database volume, no local file: the project is plain, and says so from now on
  if (volumes !== null && !ctx.out.realData && !existsSync(join(ctx.root, LOCAL_FILE))) writePlainLocal(ctx.root);
  return { volumes };
}

/** Puts the project in the user-level registry of real-data sandboxes; a failure goes next to the command's output. */
function register(ctx: Ctx): void {
  const err = registerRealData(registryEntryOf(ctx.root, ctx.local));
  if (err === null) return;
  ctx.registryProblem = { code: 'registry-failed', step: 'registry', reason: err.code };
}

/** The expiry sweep of every command but scan and init: raw files the host kept from before are removed
 *  where the host keeps none now, and the runs volume is swept when it exists and the setup is safe. A
 *  command with no runs volume (a down of a project that never ran) starts no container for it. */
async function sweepIfSafe(ctx: Ctx, pre: { volumes: string[] | null | undefined }): Promise<Diag | null> {
  const here = pre.volumes?.includes(`${ctx.project}_runout`) === true;
  return sweepRaw(ctx, here && (await guard(ctx)) === null);
}

/** The problems of the compose file as docker resolves it (`config --format json`): the static
 *  check, or why the config could not be read. Empty when it is fine. */
function composeProblems(ctx: Ctx): Promise<string[]> {
  return once(ctx, 'compose', async () => {
    const c = await composeConfig(ctx);
    return 'problem' in c ? [c.problem] : staticProblems(c.cfg, ctx.root, ctx.local.dump);
  });
}

/** The compose config as docker resolves it (`config --format json`), parsed, or why it could not be read. One call per
 *  command when `preflight` set the memo. */
function composeConfig(ctx: Ctx): Promise<{ cfg: unknown } | { problem: string }> {
  return once(ctx, 'compose-config', async () => {
    const cfg = await comp(ctx, ['--profile', '*', 'config', '--format', 'json'], SHORT_MS);
    if (cfg.code !== 0) return { problem: `docker compose config failed: ${ctx.out.why(cfg, 'docker-failed')}` };
    const parsed = parseJson(cfg.stdout);
    return parsed === undefined ? { problem: 'docker compose config printed no JSON' } : { cfg: parsed };
  });
}

/** Before anything is started: the daemon is local and the compose file is static-checked. An
 *  error message, or null. */
async function guard(ctx: Ctx): Promise<string | null> {
  const endpoint = await endpointProblem(ctx);
  if (endpoint !== null) return endpoint;
  const sp = await composeProblems(ctx);
  return sp.length > 0 ? `the compose file is not safe to start:\n- ${sp.join('\n- ')}` : null;
}

/** The IPv4 addresses an `nslookup` answered with (the server's own address is not one). */
export function parseNslookup(text: string): string[] {
  const i = text.search(/^Name:/m);
  const ips = new Set<string>();
  if (i >= 0) for (const m of text.slice(i).matchAll(/^Address(?:\s+\d+)?:\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/gm)) ips.add(m[1]!);
  return [...ips].sort();
}

/** The probe's script: controls prove that nslookup, nc, wget and ping work here (a tool that
 *  does not run would look like a blocked network), then the outward attempts, the host's
 *  gateway address (`gateway`: nothing may answer there, by ping or on the usual ports), then
 *  the name lookups. */
export function probeScript(names: readonly string[], gateway: string): string {
  return [
    'echo ok > /tmp/index.html',
    'httpd -p 127.0.0.1:18081 -h /tmp >/dev/null 2>&1',
    'sleep 1',
    // The container's own name always resolves on a user-defined network (its short id is an alias).
    'timeout 15 nslookup "$(hostname)" >/dev/null 2>&1 && echo CTL_DNS=ok || echo CTL_DNS=fail',
    'nc -z -w 2 127.0.0.1 18081 >/dev/null 2>&1 && echo CTL_NC=ok || echo CTL_NC=fail',
    'wget -T 2 -q --spider http://127.0.0.1:18081/ >/dev/null 2>&1 && echo CTL_WGET=ok || echo CTL_WGET=fail',
    'ping -c 1 -W 2 127.0.0.1 >/dev/null 2>&1 && echo CTL_PING=ok || echo CTL_PING=fail',
    'timeout 15 nslookup example.com >/dev/null 2>&1 && echo DNS=open || echo DNS=blocked',
    'nc -z -w 3 1.1.1.1 443 >/dev/null 2>&1 && echo TCP=open || echo TCP=blocked',
    'wget -T 3 -q --spider http://example.com >/dev/null 2>&1 && echo HTTP=open || echo HTTP=blocked',
    // the gateway attempts run side by side (each waits up to 2 s); a ping that left no answer prints
    // `unknown`, which the check counts as open
    'mkdir -p /tmp/gw; rm -f /tmp/gw/*; pids=""',
    `(ping -c 1 -W 2 ${gateway} >/dev/null 2>&1 && echo open > /tmp/gw/ping || echo blocked > /tmp/gw/ping) & pids="$pids $!"`,
    `for p in ${GATEWAY_PORTS.join(' ')}; do (nc -z -w 2 ${gateway} $p >/dev/null 2>&1 && echo open > /tmp/gw/tcp$p) & pids="$pids $!"; done`,
    'wait $pids',
    'echo GW_PING=$(cat /tmp/gw/ping 2>/dev/null || echo unknown)',
    'GW=blocked; for f in /tmp/gw/tcp*; do [ -e "$f" ] && GW=open; done; echo GW_TCP=$GW',
    ...names.map((n) => `echo "@@ ${n}"; timeout 15 nslookup ${n} 2>&1`),
    'echo "@@END"',
  ].join('\n');
}

interface Seen {
  id: string;
  name: string;
  service: string;
  nets: Record<string, string>;
}

/** What `sandbox-run` checks before a suite: containers on internal networks only, no way
 *  out from the internal network, every outbound host answered by its dummy. */
export async function checkSandbox(ctx: Ctx): Promise<SandboxCheck> {
  const problems: string[] = [];
  let inner = true;
  const allowed = new Set(ctx.plan.internalNets.map((n) => `${ctx.project}_${n}`));

  // a remote daemon: no container command at all, not even the probe
  const remote = await endpointProblem(ctx);
  if (remote !== null) return { inner_only: false, egress_blocked: false, hosts_to_dummies: false, problems: [remote] };

  // (a) the compose file, then the containers that run
  const sp = await composeProblems(ctx);
  if (sp.length > 0) inner = false;
  problems.push(...sp);
  const seen: Seen[] = [];
  let inspected = true;
  // `compose ps` lists the services of this file; a container that carries the project's label
  // but is no service of it (an orphan, a hand-made one) shows only in the label filter.
  const ps = await comp(ctx, ['--profile', '*', 'ps', '-q'], SHORT_MS);
  const labelled = await dock(ctx, ['ps', '-q', '--filter', `label=com.docker.compose.project=${ctx.project}`], SHORT_MS);
  // A container attached by hand to one of the sandbox's networks (`docker network connect`)
  // carries no label: the networks' own member lists find it.
  const netList = await dock(ctx, ['network', 'ls', '--format', '{{.Name}}', '--filter', `label=com.docker.compose.project=${ctx.project}`], SHORT_MS);
  if (ps.code !== 0 || labelled.code !== 0) {
    inner = false;
    inspected = false;
    problems.push(`listing the project's containers failed: ${ctx.out.why(ps.code !== 0 ? ps : labelled, 'docker-failed')}`);
  } else {
    if (netList.code !== 0) {
      inner = false;
      problems.push(`listing the project's networks failed: ${ctx.out.why(netList, 'docker-failed')}`);
    }
    const known = new Set<string>();
    const netsDone = new Set<string>();
    let pending = [...new Set([...lines(ps.stdout), ...lines(labelled.stdout)])];
    let pendingNets = netList.code === 0 ? lines(netList.stdout).filter((n) => allowed.has(n)) : [];
    for (let round = 0; round < 3 && (pending.length > 0 || pendingNets.length > 0); round++) {
      const netNames = new Set<string>(pendingNets);
      pendingNets = [];
      if (pending.length > 0) {
        const ins = await dock(ctx, ['inspect', ...pending], SHORT_MS, { max: { stdout: 8 * 1024 * 1024, stderr: 64 * 1024 } });
        pending = [];
        const arr = ins.code === 0 ? parseJson(ins.stdout) : undefined;
        if (!Array.isArray(arr)) {
          inner = false;
          inspected = false;
          problems.push(`docker inspect failed: ${ctx.out.why(ins, 'docker-failed')}`);
          break;
        }
        for (const c of arr as { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> }; HostConfig?: { NetworkMode?: string }; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }[]) {
          const nets = c.NetworkSettings?.Networks ?? {};
          const name = (c.Name ?? c.Id ?? '?').replace(/^\//, '');
          if (c.Id) known.add(c.Id);
          seen.push({ id: c.Id ?? '', name, service: c.Config?.Labels?.['com.docker.compose.service'] ?? '', nets: Object.fromEntries(Object.entries(nets).map(([k, v]) => [k, v?.IPAddress ?? ''])) });
          if (c.HostConfig?.NetworkMode === 'host') {
            inner = false;
            problems.push(ctx.out.text(`container ${name} uses the host network`, 'check-failed', 'containers'));
          }
          for (const n of Object.keys(nets)) {
            netNames.add(n);
            if (!allowed.has(n)) {
              inner = false;
              problems.push(ctx.out.text(`container ${name} is on network ${n}, which is not one of the sandbox's internal networks`, 'check-failed', 'containers'));
            }
          }
        }
      }
      const todo = [...netNames].filter((n) => !netsDone.has(n));
      for (const n of todo) netsDone.add(n);
      if (todo.length === 0) continue;
      const ni = await dock(ctx, ['network', 'inspect', ...todo], SHORT_MS, { max: { stdout: 8 * 1024 * 1024, stderr: 64 * 1024 } });
      const na = ni.code === 0 ? parseJson(ni.stdout) : undefined;
      if (!Array.isArray(na)) {
        inner = false;
        problems.push(`docker network inspect failed: ${ctx.out.why(ni, 'docker-failed')}`);
        break;
      }
      for (const n of na as { Name?: string; Internal?: boolean; Options?: Record<string, string>; IPAM?: { Config?: { Gateway?: string }[] }; Containers?: Record<string, unknown> }[]) {
        if (n.Internal !== true) {
          inner = false;
          problems.push(ctx.out.text(`network ${n.Name ?? '?'} is not internal (Internal=${String(n.Internal)})`, 'check-failed', 'networks'));
        }
        // Docker 28 or later; an older daemon ignores the option and the host answers on the gateway
        const gw = (n.IPAM?.Config ?? []).map((c) => c.Gateway).filter((g): g is string => typeof g === 'string' && g !== '');
        if (n.Options?.[INHIBIT_IPV4] !== 'true' || gw.length > 0) {
          inner = false;
          problems.push(ctx.out.text(`network ${n.Name ?? '?'} has a host address${gw.length > 0 ? ` (${gw.join(', ')})` : ''}: ${INHIBIT_IPV4} is not applied (it needs Docker 28 or later); recreate the network with sandbox-down and sandbox-up`, 'check-failed', 'networks'));
        }
        for (const id of Object.keys(n.Containers ?? {})) if (!known.has(id) && !pending.includes(id)) pending.push(id);
      }
    }
    if (pending.length > 0) {
      inner = false;
      problems.push(`${pending.length} container(s) on the sandbox's networks could not all be examined`);
    }
  }

  // (b) and (c): one probe container on `inner`
  const dnsDummies = ctx.plan.dummies.filter((d) => d.ip === null);
  const names = [...new Set(dnsDummies.flatMap((d) => [d.host, d.service]))];
  const probe = await comp(ctx, ['run', '--rm', '-T', '--no-deps', 'probe', 'sh', '-c', probeScript(names, ctx.plan.innerGateway)], 3 * SHORT_MS);
  let egress = false;
  const marks = new Map<string, string>();
  const answers = new Map<string, string[]>();
  if (probe.code !== 0 || !probe.stdout.includes('@@END')) problems.push(`the probe did not run to its end: ${ctx.out.why(probe, 'docker-failed')}`);
  else {
    const [head, ...sections] = probe.stdout.split(/^@@ /m);
    for (const l of lines(head ?? '')) {
      const m = /^([A-Z_]+)=(\w+)$/.exec(l);
      if (m) marks.set(m[1]!, m[2]!);
    }
    for (const sec of sections) {
      const nl = sec.indexOf('\n');
      const name = (nl < 0 ? sec : sec.slice(0, nl)).trim();
      if (name !== 'END') answers.set(name, parseNslookup(sec));
    }
    const broken = ['CTL_DNS', 'CTL_NC', 'CTL_WGET', 'CTL_PING'].filter((k) => marks.get(k) !== 'ok');
    if (broken.length > 0) problems.push(`the probe's own tools could not be verified (${broken.join(', ')} failed against the probe itself), so a blocked network cannot be told from a broken tool`);
    else {
      // a mark that is missing counts as open: the check fails closed
      const open = (['DNS', 'TCP', 'HTTP', 'GW_PING', 'GW_TCP'] as const).filter((k) => marks.get(k) !== 'blocked');
      const what = {
        DNS: 'nslookup example.com resolved',
        TCP: 'nc reached 1.1.1.1:443',
        HTTP: 'wget reached http://example.com',
        GW_PING: `the host's gateway address ${ctx.plan.innerGateway} answered a ping`,
        GW_TCP: `a port of ${ctx.plan.innerGateway} (${GATEWAY_PORTS.join(', ')}) accepted a connection`,
      };
      for (const k of open) problems.push(`egress is not blocked: ${what[k]}`);
      egress = open.length === 0;
    }
  }
  let hosts = true;
  for (const d of ctx.plan.dummies) {
    if (d.ip !== null) {
      const c = seen.find((x) => x.service === d.service);
      const net = `${ctx.project}_ip_${d.ip.split('.').slice(0, 3).join('_')}`;
      if (!inspected || !c) {
        hosts = false;
        problems.push(`${d.service} is not running, so ${d.ip} is not held by its dummy`);
      } else if (c.nets[net] !== d.ip) {
        hosts = false;
        problems.push(ctx.out.text(`${d.service} does not hold ${d.ip} (it has ${c.nets[net] || 'no address'} on ${net})`, 'check-failed', 'hosts'));
      }
      continue;
    }
    const a = answers.get(d.host) ?? [];
    const b = answers.get(d.service) ?? [];
    if (a.length === 0 || a.join() !== b.join()) {
      hosts = false;
      problems.push(ctx.out.text(`${d.host} resolves to ${a.join(', ') || 'nothing'} inside inner, not to ${d.service} (${b.join(', ') || 'not found'})`, 'check-failed', 'hosts'));
    }
  }
  return { inner_only: inner, egress_blocked: egress, hosts_to_dummies: hosts, problems: [...new Set(problems)] };
}

const checkOk = (c: SandboxCheck): boolean => c.inner_only && c.egress_blocked && c.hosts_to_dummies;

// ---- the other commands ----

type Result = { out: unknown; code: number } | { error: string };

const msOpt = (args: string[], dflt: number): number => {
  const i = args.indexOf('--timeout-ms');
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isInteger(n) && n >= 1000 && n <= MAX_RUN_MS ? n : dflt;
};

/** A step that stopped a run: the reason (text outside real-data mode, a code inside) and its diagnostic. */
interface Stop {
  stop: string;
  diagnostic?: Diag;
}
const isStop = (v: unknown): v is Stop => typeof v === 'object' && v !== null && 'stop' in v;

/** Why a restore failed, for the model: only the lines the restore script tags (code and line
 *  of an error), never the client's own text, which can quote a row of the dump. In real-data
 *  mode even those are withheld (`ctx.out.text` decides). */
function restoreNote(b: Bounded): string {
  if (b.error !== undefined) return b.error;
  if (b.timedOut) return 'timed out';
  const tagged = lines(`${b.stdout}\n${b.stderr}`).filter((l) => l.startsWith(RESTORE_TAG)).slice(0, 25).map((l) => l.slice(0, 200));
  return tagged.length > 0 ? tagged.join('; ') : `exit ${b.code} (the client's output is withheld: it can quote the dump; run the restore script by hand to read it)`;
}

/** `sandbox-prepare` is outside real-data handling: the preparation step has network access and
 *  never sees the dump or the database (plan §19, M6a), so its output tails stay (OPEN). */
async function prepare(ctx: Ctx, args: string[]): Promise<Result> {
  const unsafe = await guard(ctx);
  if (unsafe !== null) return { error: `sandbox-prepare: ${unsafe}` };
  const pull = await comp(ctx, ['--profile', '*', 'pull'], 30 * 60_000, { keep: 'tail' });
  if (pull.code !== 0) return { out: { step: 'pull', exit: pull.code, tail: OPEN.tail(pull, TAIL_CHARS) }, code: 1 };
  const big = { keep: 'tail' as const, max: { stdout: 256 * 1024, stderr: 64 * 1024 } };
  const prep = await comp(ctx, ['--profile', 'prep', 'run', '--rm', '-T', 'prep'], msOpt(args, DEFAULT_RUN_MS), big);
  const out: Record<string, unknown> = { step: 'prep', exit: prep.code, timedOut: prep.timedOut, durationMs: prep.ms, tail: OPEN.tail(prep, TAIL_CHARS) };
  if (prep.code !== 0 || !ctx.plan.hasE2e) return { out, code: prep.code === 0 ? 0 : 1 };
  // the e2e packages go into their own volume, so a failure here leaves the build usable
  const e2e = await comp(ctx, ['--profile', 'prep', 'run', '--rm', '-T', 'e2e-prep'], msOpt(args, DEFAULT_RUN_MS), big);
  out.e2e = { step: 'e2e-prep', exit: e2e.code, timedOut: e2e.timedOut, durationMs: e2e.ms, tail: OPEN.tail(e2e, TAIL_CHARS) };
  return { out, code: e2e.code === 0 ? 0 : 1 };
}

const sqlServices = (ctx: Ctx): string[] => ctx.plan.upServices.filter((s) => /^db\d*$/.test(s));

/** Resets each SQL service's app database from its template, and after each reset applies the read-only role of
 *  `sandbox-data` (M6b, `db/<svc>/data-role.sh`): the database is made again, and its grants went with the old
 *  one. The role step does not look at the template marker (a template restored before M6b gets its role too)
 *  and stops nothing when it fails: the services are in `ctx.roleFailed`, and only `sandbox-data` needs the role. */
async function resetDb(ctx: Ctx): Promise<{ note: string; diagnostic?: Diag } | null> {
  ctx.roleFailed = [];
  for (const svc of sqlServices(ctx)) {
    const r = await comp(ctx, ['exec', '-T', svc, 'sh', '/goodboy-db/reset.sh'], 5 * SHORT_MS);
    if (r.code !== 0) {
      const f = ctx.out.fail(r, 'reset-failed', `reset ${svc}`);
      return { ...f, note: `resetting ${svc} from its template failed: ${f.note}` };
    }
    const role = await comp(ctx, ['exec', '-T', svc, 'sh', '/goodboy-db/data-role.sh'], 2 * SHORT_MS);
    if (role.code !== 0) ctx.roleFailed.push(svc);
  }
  return null;
}

const ROLE_NOTE = 'the read-only role of sandbox-data could not be made (run sandbox-init --force if the sandbox was set up before M6b); suites are not affected, sandbox-data fails until it works';

const APP_LOGS_REFUSED = "sandbox-up: --app-logs is not available in a sandbox that holds real data: the app's log can hold rows of the database";
const APP_LOG_HIDDEN = "the app's log is not shown; pass --app-logs to sandbox-up to include its last lines";

async function up(ctx: Ctx, args: string[]): Promise<Result> {
  const logs = args.includes('--app-logs');
  if (logs && !ctx.out.appLogs) return { error: APP_LOGS_REFUSED };
  const unsafe = await guard(ctx);
  if (unsafe !== null) return { error: `sandbox-up: ${unsafe}` };
  const stale = outOfDate(ctx.root, ctx.plan);
  const steps: { step: string; ok: boolean; note?: string; diagnostic?: Diag }[] = [];
  const bad = async (step: string, b: Bounded, code: DiagCode): Promise<Result> => ({ out: { steps: [...steps, { step, ok: false, ...ctx.out.fail(b, code, step) }], stale }, code: 1 });
  if (ctx.plan.upServices.length > 0) {
    const r = await comp(ctx, ['up', '-d', '--wait', '--wait-timeout', '300', ...ctx.plan.upServices], 10 * 60_000);
    if (r.code !== 0) return bad('up stores and dummies', r, 'docker-failed');
    steps.push({ step: 'up stores and dummies', ok: true });
  }
  for (const svc of sqlServices(ctx)) {
    const r = await comp(ctx, ['exec', '-T', svc, 'sh', '/goodboy-db/restore.sh'], 30 * 60_000);
    if (r.code !== 0) {
      const f = ctx.out.fail(r, 'restore-failed', `restore ${svc}`);
      return { out: { steps: [...steps, { step: `restore ${svc}`, ok: false, ...f, note: ctx.out.text(restoreNote(r), 'restore-failed') }], stale }, code: 1 };
    }
    const done = lines(r.stdout).slice(-1)[0];
    steps.push({ step: `restore ${svc}`, ok: true, ...(done?.startsWith('template ') ? { note: ctx.out.text(done, 'withheld') } : {}) });
  }
  const err = await resetDb(ctx);
  if (err) return { out: { steps: [...steps, { step: 'reset', ok: false, ...err }], stale }, code: 1 };
  if (sqlServices(ctx).length > 0) steps.push({ step: 'reset', ok: true });
  // the read-only role of sandbox-data: goodboy's own fixed words, in both modes, and no stop
  for (const svc of ctx.roleFailed ?? []) steps.push({ step: `data role ${svc}`, ok: false, note: ROLE_NOTE, diagnostic: { code: 'data-failed', step: `data role ${svc}` } });
  if (sqlServices(ctx).length > 0 && (ctx.roleFailed ?? []).length === 0) steps.push({ step: 'data role', ok: true });
  if (!ctx.plan.hasApp) return { out: { steps, stale, notes: ['no app service: nothing to start'] }, code: 0 };
  const a = await comp(ctx, ['up', '-d', 'app'], 5 * SHORT_MS);
  if (a.code !== 0) return bad('start app', a, 'app-failed');
  const waitS = waitSeconds(args);
  const url = ctx.plan.healthUrl;
  if (!(await waitHealth(ctx, url, waitS))) return { out: { steps: [...steps, { step: 'app health', ok: false, note: `${url} did not answer in ${waitS}s`, detail: await appLog(ctx, logs), ...diagOf(ctx, 'app-down', 'app health') }], stale }, code: 1 };
  steps.push({ step: 'app health', ok: true, note: url });
  if (!ctx.plan.hasE2e) return { out: { steps, stale, appUrl: url }, code: 0 };
  // the logging proxy: the browser tests reach the app only through it
  const p = await comp(ctx, ['up', '-d', 'proxy'], 5 * SHORT_MS);
  if (p.code !== 0) return bad('start proxy', p, 'proxy-failed');
  if (!(await waitHealth(ctx, ctx.plan.proxyHealthUrl, waitS))) return { out: { steps: [...steps, { step: 'proxy health', ok: false, note: `${ctx.plan.proxyHealthUrl} did not answer in ${waitS}s`, detail: await appLog(ctx, logs), ...diagOf(ctx, 'app-down', 'proxy health') }], stale }, code: 1 };
  steps.push({ step: 'proxy health', ok: true, note: ctx.plan.proxyHealthUrl });
  return { out: { steps, stale, appUrl: url, proxyUrl: ctx.plan.proxyHealthUrl }, code: 0 };
}

/** The diagnostic of a step that failed without a docker call, as a result field (real-data mode only). */
const diagOf = (ctx: Ctx, code: DiagCode, step: string): { diagnostic?: Diag } => {
  const d = ctx.out.diag(code, step);
  return d === undefined ? {} : { diagnostic: d };
};

const waitSeconds = (args: string[]): number => {
  const i = args.indexOf('--wait-seconds');
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isInteger(n) && n >= 5 && n <= 3600 ? n : 240;
};

/** Waits until `url` answers from inside `inner`; false when it did not in `waitS` seconds.
 *  Any answer but an error status counts as up: a secured app answers 401 or 403. */
async function waitHealth(ctx: Ctx, url: string, waitS: number): Promise<boolean> {
  const script = 'wget -S -T 3 -O /dev/null "$0" 2>&1 | grep -E "HTTP/[0-9.]+ (2|3|401|403)" >/dev/null';
  const until = Date.now() + waitS * 1000;
  // A `do … while` with the answer after it: Bun's line coverage never counts the closing brace of a
  //   `for (;;)` that only exits by `return` (M rebase test record).
  let up = false;
  let late = false;
  do {
    const h = await comp(ctx, ['run', '--rm', '-T', '--no-deps', 'probe', 'sh', '-c', script, url], 2 * SHORT_MS);
    up = h.code === 0;
    late = !up && Date.now() > until;
    if (!up && !late) await Bun.sleep(3000);
  } while (!up && !late);
  return up;
}

/** The app's last log lines with `--app-logs` (they can hold rows of the database: only where the boundary
 *  allows them), else a note that says so. */
async function appLog(ctx: Ctx, withLogs: boolean): Promise<string> {
  if (!withLogs || !ctx.out.appLogs) return APP_LOG_HIDDEN;
  const logs = await comp(ctx, ['logs', '--tail', '40', 'app'], SHORT_MS);
  return (logs.stdout + logs.stderr).slice(-3000);
}

/** A regular file at `p` under `base` with no link on the way (noLinksUnder): a `coverage/` that
 *  became a link to a host dir does not make a host file a report that other readers are handed.
 *  The host writes its own files into the run dir through writeAtomic, a temp name and a rename,
 *  which replaces a planted link, never follows it, and fails on a planted directory. (Since M6a no
 *  container mounts the run dir; the check stays as the second line.) */
function isRegularFile(base: string, p: string): boolean {
  const parts = relative(base, p).split(sep).filter(Boolean);
  return parts.length > 0 && parts[0] !== '..' && noLinksUnder(base, parts, 'file');
}

/** Removes a container by name, bounded: a hung docker never holds the run (nor an interrupt). */
function rmContainer(name: string): void {
  Bun.spawnSync([dockerBin(), 'rm', '-f', name], { stdout: 'ignore', stderr: 'ignore', timeout: 30_000 });
}

const stamp = (d = new Date()): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const BIG = { keep: 'tail' as const, max: { stdout: 256 * 1024, stderr: 64 * 1024 } };

// ---- the suites ----

/** What a suite step leaves in the result. */
interface StepResult {
  exit: number;
  durationMs: number;
  timedOut: boolean;
  tail: string;
}

const stepOf = (ctx: Ctx, b: Bounded): StepResult => ({ exit: b.code ?? 1, durationMs: b.ms, timedOut: b.timedOut, tail: ctx.out.tail(b, TAIL_CHARS) });

/** The e2e dir of the project exists and has something in it. */
function hasE2eTests(ctx: Ctx): boolean {
  try {
    return readdirSync(join(ctx.root, E2E_DIR)).length > 0;
  } catch {
    return false;
  }
}

const logText = (b: Bounded): string => b.stdout + (b.stderr ? '\n--- stderr ---\n' + b.stderr : '');

/** The unit and integration suite: the app is restarted (the reset dropped its connections) and
 *  the runner runs the test command with the run's dir of the volume as /out (GOODBOY_OUT), where
 *  the JVM, V8 and coverage.py hooks write their data. Afterwards one reader call stores the step's
 *  output as the run's `output.log` in the volume (the host keeps a copy where the boundary allows) and
 *  reads the JUnit files for their counts. */
async function runUnit(ctx: Ctx, outDir: string, ts: string, custom: string[], timeoutMs: number, problems: string[]): Promise<{ step: StepResult; summary: UnitSummary }> {
  if (ctx.plan.hasApp) {
    const running = await comp(ctx, ['ps', '-q', 'app'], SHORT_MS);
    if (running.code === 0 && lines(running.stdout).length > 0) await comp(ctx, ['restart', 'app'], 5 * SHORT_MS);
  }
  const name = `${ctx.project}-runner-${ts}`;
  const rmRunner = () => rmContainer(name);
  const r = await onInterrupt(rmRunner, () => comp(ctx, ['run', '--rm', '-T', '--no-deps', '--name', name, '-e', `GOODBOY_OUT=${runDirIn(ts)}`, 'runner', ...custom], timeoutMs, BIG));
  if (r.timedOut) rmRunner();
  const log = logText(r);
  const after = await unitAfter(ctx, ts, log, ctx.scan.stack === 'jvm');
  if (!after.wrote) problems.push('output.log could not be written to the run volume');
  if (ctx.out.hostCopies) writeAtomic(join(outDir, OUTPUT_LOG_FILE), log);
  const step = stepOf(ctx, r);
  return { step, summary: { exit: step.exit, durationMs: step.durationMs, timedOut: step.timedOut, ...after.counts } };
}

interface E2eResult extends StepResult {
  /** `kept` for a failing run, `removed` for a passing one, `none` when the run left none. */
  artifacts: 'kept' | 'removed' | 'none';
  accessLog: string | null;
  playwrightReport: string | null;
  problems: string[];
}

/** The browser suite: the app is started fresh behind the logging proxy, the e2e service runs
 *  the project's tests against `http://proxy:8080`, the app is stopped (the JVM writes its
 *  coverage data on exit), and one reader call stores the step's output, reads the proxy's access log
 *  and the Playwright report into memory and removes a passing run's traces and screenshots. The files feed `ui-check`
 *  (the verdict is stored as `ui-check.json`, with no title) and the report's counts feed the summary. Where
 *  the boundary allows host copies the host keeps a copy of both next to result.json. A failing run's
 *  traces and screenshots are kept (in the volume). */
async function runE2e(ctx: Ctx, outDir: string, ts: string, custom: string[], timeoutMs: number, waitS: number): Promise<{ step: E2eResult; summary: E2eSummary } | Stop> {
  const problems: string[] = [];
  const stop = (text: string, f: { note: string; diagnostic?: Diag }): Stop => ({ stop: `${text}${f.note}`, ...(f.diagnostic ? { diagnostic: f.diagnostic } : {}) });
  const proxy = await comp(ctx, ['up', '-d', 'proxy'], 5 * SHORT_MS);
  if (proxy.code !== 0) return stop('starting the proxy failed: ', ctx.out.fail(proxy, 'proxy-failed', 'start proxy'));
  // what an earlier run left: stale coverage data must not look like this run's
  const clean = await comp(ctx, ['exec', '-T', 'proxy', 'sh', '-c', `rm -rf ${LIVE_DIR}/jacoco-e2e.exec ${LIVE_DIR}/v8-e2e ${LIVE_DIR}/py-e2e`], SHORT_MS);
  if (clean.code !== 0) return stop('cleaning /live failed: ', ctx.out.fail(clean, 'live-failed', 'clean live'));
  const running = await comp(ctx, ['ps', '-q', 'app'], SHORT_MS);
  const start = running.code === 0 && lines(running.stdout).length > 0 ? await comp(ctx, ['restart', 'app'], 5 * SHORT_MS) : await comp(ctx, ['up', '-d', 'app'], 5 * SHORT_MS);
  if (start.code !== 0) return stop('starting the app failed: ', ctx.out.fail(start, 'app-failed', 'start app'));
  if (!(await waitHealth(ctx, ctx.plan.proxyHealthUrl, waitS))) return { stop: `${ctx.plan.proxyHealthUrl} did not answer in ${waitS}s`, ...diagOf(ctx, 'app-down', 'proxy health') };
  // the log of this run starts here: the health waits above are not in it
  const trunc = await comp(ctx, ['exec', '-T', 'proxy', 'sh', '-c', `: > ${LIVE_DIR}/access.log`], SHORT_MS);
  if (trunc.code !== 0) return stop('truncating the access log failed: ', ctx.out.fail(trunc, 'live-failed', 'truncate access log'));

  const name = `${ctx.project}-e2e-${ts}`;
  const rmE2e = () => rmContainer(name);
  const r = await onInterrupt(rmE2e, () => comp(ctx, ['run', '--rm', '-T', '--no-deps', '--name', name, '-e', `GOODBOY_OUT=${runDirIn(ts)}`, 'e2e', ...custom], timeoutMs, BIG));
  if (r.timedOut) rmE2e();

  // stop the app so the JaCoCo agent, V8 and coverage.py write their data
  const stopApp = await comp(ctx, ['stop', '-t', '60', 'app'], 3 * SHORT_MS);
  if (stopApp.code !== 0) problems.push(`stopping the app failed, its coverage data may be missing: ${ctx.out.why(stopApp, 'app-failed')}`);

  // The access log and the report are read as untrusted files of the volume: a link, a device or a
  // huge file is refused instead of followed (the reader's script checks), and the text stays in memory.
  const reportPath = `${runDirIn(ts)}/${PLAYWRIGHT_REPORT_FILE}`;
  const logPath = `${LIVE_DIR}/${ACCESS_LOG_FILE}`;
  const log = logText(r);
  const passed = r.code === 0 && !r.timedOut;
  const after = await e2eAfter(ctx, ts, log, passed);
  if (after === null) {
    problems.push('the Playwright report and the access log could not be read from the sandbox volumes');
    problems.push('e2e-output.log could not be written to the run volume');
  } else if (!after.wrote) problems.push('e2e-output.log could not be written to the run volume');
  if (ctx.out.hostCopies) writeAtomic(join(outDir, E2E_OUTPUT_LOG_FILE), log);
  if (after?.partial) problems.push('the Playwright report and the access log are larger than the read budget: some were not read');
  const rep = after?.files.get(reportPath);
  const acc = after?.files.get(logPath);

  let accessLog: string | null = null;
  if (acc?.kind === 'text') {
    if (ctx.out.hostCopies) {
      writeAtomic(join(outDir, ACCESS_LOG_FILE), acc.text);
      accessLog = join(outDir, ACCESS_LOG_FILE);
    }
  } else if (after !== null && !(after.partial && acc === undefined)) {
    const verb = ctx.out.hostCopies ? 'copied' : 'read';
    problems.push(`the proxy's access log could not be ${verb}: ${acc?.kind === 'refused' ? `it is not a regular file of at most ${MAX_READ_BYTES} bytes` : 'it does not exist'}`);
  }
  let playwrightReport: string | null = null;
  const summary: E2eSummary = { exit: r.code ?? 1, durationMs: r.ms, timedOut: r.timedOut };
  if (rep?.kind === 'text') {
    const hostPath = join(outDir, PLAYWRIGHT_REPORT_FILE);
    if (ctx.out.hostCopies) writeAtomic(hostPath, rep.text);
    playwrightReport = ctx.out.reportRef(hostPath, volumeMarker(ts, PLAYWRIGHT_REPORT_FILE));
    const s = playwrightSummary(rep.text);
    if (s === 'unreadable') summary.unreadable = true;
    else {
      summary.stats = s.stats;
      summary.files = s.files;
    }
  } else if (!(after?.partial && rep === undefined)) problems.push('the e2e run wrote no Playwright report');
  if (rep?.kind === 'text' && acc?.kind === 'text') {
    // the verdict of ui-check with no title and no claim text; `ui-check --run` prints it
    try {
      const verdict = uiCheck(uiInventory(ctx.root), [acc.text], [rep.text], { redactTitles: true });
      writeAtomic(join(outDir, STORED_FILE), `${JSON.stringify(storedUiCheck(ts, verdict), null, 2)}\n`);
    } catch {
      problems.push('the ui-check verdict could not be stored');
    }
  }

  // Traces and screenshots are for analysing a failing run only (the same call removed a passing run's).
  let kept: E2eResult['artifacts'] = after?.present === true ? 'kept' : 'none';
  if (kept === 'kept' && passed) {
    kept = after?.left === true ? 'kept' : 'removed';
    if (kept === 'kept') problems.push('the e2e traces and screenshots could not be removed');
  }
  return { step: { ...stepOf(ctx, r), artifacts: kept, accessLog, playwrightReport, problems }, summary };
}

interface CoverageResult {
  ok: boolean;
  exit: number | null;
  reports: string[];
  note: string;
}

/** Merges the unit and e2e coverage data of the run and writes the report (JaCoCo XML, lcov or
 *  Cobertura XML) under `coverage/` in the run's dir of the volume; the host then copies the report
 *  into `out/<ts>/coverage/`, which `coverage-check` reads (paths and line numbers of the project's
 *  own sources, no data). A failure is reported, never fatal: the suites' own exit code decides the run. */
async function runCoverage(ctx: Ctx, outDir: string, ts: string, withE2e: boolean): Promise<CoverageResult> {
  const file = COVERAGE_REPORT[ctx.scan.stack];
  const r = await comp(ctx, ['run', '--rm', '-T', '--no-deps', '-e', 'GOODBOY_COVERAGE_OUT=', '-e', 'NODE_V8_COVERAGE=', '-e', 'COVERAGE_PROCESS_START=', '-e', `GOODBOY_OUT=${runDirIn(ts)}`, 'runner', 'sh', '/sandbox/coverage.sh', withE2e ? 'report-e2e' : 'report'], 10 * SHORT_MS, BIG);
  if (r.code !== 0) {
    const note = r.code === 4 ? 'the coverage tool is not prepared; run sandbox-prepare' : r.code === 3 ? 'the run left no coverage data' : ctx.out.why(r, 'coverage-failed');
    return { ok: false, exit: r.code, reports: [], note };
  }
  const src = `${runDirIn(ts)}/coverage/${file}`;
  const got = (await readFiles(ctx, [src], COVERAGE_READ_BYTES))?.files.get(src);
  const path = join(outDir, 'coverage', file);
  let ok = false;
  if (got?.kind === 'text') {
    mkdirSync(join(outDir, 'coverage'), { recursive: true });
    writeAtomic(path, got.text);
    ok = isRegularFile(outDir, path);
  }
  return { ok, exit: r.code, reports: ok ? [path] : [], note: ok ? ctx.out.text(lines(r.stdout).slice(-1)[0] ?? '', 'withheld') : 'the coverage report could not be read from the run volume' };
}

async function run(ctx: Ctx, args: string[]): Promise<Result> {
  const dd = args.indexOf('--');
  const own = dd >= 0 ? args.slice(0, dd) : args;
  const custom = dd >= 0 ? args.slice(dd + 1) : [];
  const si = own.indexOf('--suite');
  const suite = si >= 0 ? own[si + 1] : 'all';
  if (suite !== 'unit' && suite !== 'e2e' && suite !== 'all') return { error: 'sandbox-run: --suite is unit, e2e or all' };
  if (dd >= 0 && custom.length === 0) return { error: 'sandbox-run: nothing after --' };
  const onlyE2e = suite === 'e2e';
  const unitCommand = custom.length > 0 && !onlyE2e ? custom : ctx.scan.build.testCommand;
  const e2eReady = ctx.plan.hasE2e && hasE2eTests(ctx);
  if (onlyE2e && !ctx.plan.hasE2e) return { error: 'sandbox-run: --suite e2e needs an app: the scan has no start command' };
  if (onlyE2e && !e2eReady) return { error: `sandbox-run: --suite e2e needs the project's e2e tests in ${E2E_DIR}/ (import uiTest from .goodboy/sandbox/e2e/goodboy-ui)` };
  const wantUnit = !onlyE2e && unitCommand.length > 0;
  const wantE2e = onlyE2e || (suite === 'all' && e2eReady);
  if (!wantUnit && !wantE2e) return { error: 'sandbox-run: the scan has no test command; pass one after --' };
  const command = wantUnit ? unitCommand : ctx.plan.hasE2e ? ['playwright', 'test'] : [];
  const ts = stamp();
  ensureRealDir(ctx.root, `${SANDBOX_DIR}/out`);
  const outDir = join(ctx.dir, 'out', ts);
  mkdirSync(outDir, { recursive: true });
  const started = new Date();
  writeState(outDir, { status: 'running', started: started.toISOString() });
  const finishState = (passed: boolean): void => writeState(outDir, { status: passed ? 'passed' : 'failed', started: started.toISOString(), finished: new Date().toISOString() });
  const write = (r: Record<string, unknown>): string => {
    const p = join(outDir, 'result.json');
    writeAtomic(p, JSON.stringify(r, null, 2) + '\n');
    return p;
  };
  const head = { ts, suite, command, realData: ctx.out.realData };
  const problems: string[] = [];
  // the sandbox check, once it has run: a stop before it (a refused manifest) records none
  let checked: SandboxCheck | undefined;
  const stopped = async (s: Stop): Promise<Result> => {
    const seen = checked === undefined ? {} : { check: checked };
    const extra = { ...(s.diagnostic ? { diagnostic: s.diagnostic } : {}), ...(problems.length > 0 ? { problems } : {}) };
    const path = write({ ...head, ...seen, exit: null, durationMs: 0, tail: '', stopped: s.stop, ...extra });
    finishState(false);
    return { out: { stopped: s.stop, ...seen, result: path, ...extra }, code: 1 };
  };
  // the data the tests ask for (M6c): a manifest that is refused stops the run before the slow sandbox check (a file read
  // and a parse), and a sandbox with no data volume right after it, before any work
  const manifest = readManifest(ctx.root);
  if (isRefusal(manifest)) return stopped(refusedStop(manifest));
  const stale = outOfDate(ctx.root, ctx.plan);
  const check = await checkSandbox(ctx);
  checked = check;
  if (!checkOk(check)) {
    const path = write({ ...head, check, exit: null, durationMs: 0, tail: '', stopped: 'the sandbox check failed' });
    finishState(false);
    return { out: { stopped: 'the sandbox check failed; the suite did not run', check, result: path }, code: 1 };
  }
  if (manifest !== null && !isEmpty(manifest)) {
    if (dataCtx(ctx).target === null) return stopped(refusedStop({ field: 'store', reason: 'no-sql-store' }));
    const c = await composeConfig(ctx);
    if ('problem' in c || !hasDataVolume(c.cfg, sqlServices(ctx))) return stopped(NO_DATA_VOLUME);
  }
  // what the last run left in the shared volumes must not look like this run's
  const cleared = await finish(ctx, [], true);
  if (!cleared.ok) {
    const f = ctx.out.fail(cleared.call, 'volume-failed', 'clear scratch');
    return stopped({ stop: `clearing the previous run's scratch volumes failed: ${f.note}`, ...(f.diagnostic ? { diagnostic: f.diagnostic } : {}) });
  }
  const reset = await resetDb(ctx);
  if (reset) return stopped({ stop: reset.note, ...(reset.diagnostic ? { diagnostic: reset.diagnostic } : {}) });
  const timeoutMs = msOpt(own, DEFAULT_RUN_MS);
  const summary: RunSummary = {};

  const ran: { unit: StepResult | null; e2e: E2eResult | null } = { unit: null, e2e: null };
  // the values of data.json (M6c) are resolved after each reset and live in the `data` volume only while the suites run;
  // phase 1 of the resolve is asked once (the second reset restores the same dump), `memo` keeps its answers
  const token = newToken();
  const memo: Memo = {};
  const resolve = async (): Promise<ResolveStop | null> => (manifest === null ? null : resolveValues(dataCtx(ctx), manifest, token, memo));
  /** The suites, each after a reset and a resolve; a Stop is what ended the run before its end. */
  const suites = async (): Promise<Stop | null> => {
    const resolved = await resolve();
    if (resolved !== null) return resolved;
    if (wantUnit) {
      const u = await runUnit(ctx, outDir, ts, custom, timeoutMs, problems);
      ran.unit = u.step;
      summary.unit = u.summary;
    }
    if (wantE2e) {
      // the unit tests may have written to the database: the browser suite starts from the dump again
      if (wantUnit) {
        const again = await resetDb(ctx);
        if (again) return { stop: again.note, ...(again.diagnostic ? { diagnostic: again.diagnostic } : {}) };
        const second = await resolve();
        if (second !== null) return second;
      }
      const r = await runE2e(ctx, outDir, ts, onlyE2e ? custom : [], timeoutMs, waitSeconds(own));
      if (isStop(r)) return r;
      ran.e2e = r.step;
      summary.e2e = r.summary;
    }
    return null;
  };
  let halt: Stop | null;
  try {
    halt = await suites();
  } finally {
    // the values go as soon as the suites end, pass or fail (the next run clears them too, and the sweep when no run is live)
    if (manifest !== null && !(await clearData(ctx).catch(() => false))) problems.push('the data volume could not be cleared; the next run clears it');
  }
  // reported after the clear, so a clear that failed is in the stopped run's result too
  if (halt !== null) return stopped(halt);
  const { unit, e2e } = ran;
  // the report is made in the runner container, so it needs a test command
  const coverage: CoverageResult =
    ctx.scan.build.testCommand.length > 0 ? await runCoverage(ctx, outDir, ts, e2e !== null) : { ok: false, exit: null, reports: [], note: 'the scan has no test command, so there is no runner service to make the coverage report' };
  if ((ctx.roleFailed ?? []).length > 0) problems.push(ROLE_NOTE);
  const first = unit ?? e2e!;
  const exit = unit !== null && unit.exit !== 0 ? unit.exit : e2e !== null && e2e.exit !== 0 ? e2e.exit : first.exit;
  const timedOut = unit?.timedOut === true || e2e?.timedOut === true;
  const result = {
    ...head,
    check,
    exit,
    durationMs: first.durationMs,
    timedOut,
    tail: first.tail,
    ...(manifest !== null ? { data: manifestCounts(manifest) } : {}),
    ...(unit !== null && e2e !== null ? { unit } : {}),
    ...(e2e !== null ? { e2e } : {}),
    accessLog: e2e?.accessLog ?? null,
    playwrightReport: e2e?.playwrightReport ?? null,
    coverage,
    coverageReports: coverage.reports,
    summary,
    ...(problems.length > 0 ? { problems } : {}),
  };
  const path = write(result);
  const passed = exit === 0 && !timedOut;
  finishState(passed);
  // A passing run's raw artifacts go once the result is recorded, in one call with the scratch volumes; a
  // failing run's stay in the volume until the sweep of a later command removes them after the TTL (also
  // after a crash).
  let cleanup: 'removed' | 'not-removed' | 'kept' = 'kept';
  let cleanupDiag: Diag | undefined;
  if (passed) {
    const gone = (await finish(ctx, [ts], true)).ok;
    cleanup = gone ? 'removed' : 'not-removed';
    if (!gone) cleanupDiag = { code: 'artifacts-not-removed', step: 'cleanup' };
  }
  return { out: { ...result, stale, result: path, cleanup, ...(cleanupDiag ? { diagnostic: cleanupDiag } : {}) }, code: exit };
}

/** Whether any database volume of the project is still there, or docker cannot say (then true). */
async function dataVolumesLeft(ctx: Ctx): Promise<boolean> {
  const v = await projectVolumes(ctx);
  return v === null || v.some((n) => isDataVolume(ctx, n));
}

async function down(ctx: Ctx, args: string[]): Promise<Result> {
  const remote = await endpointProblem(ctx);
  if (remote !== null) return { error: `sandbox-down: ${remote}` };
  const volumes = args.includes('--volumes');
  const r = await comp(ctx, ['--profile', '*', 'down', '--remove-orphans', ...(volumes ? ['-v'] : [])], 5 * SHORT_MS);
  // With `-v` the database volumes are gone, and then the flag in local.json goes (a dump still named there
  // keeps the mode: `realData: kept`); a volume that is still there, or a docker that cannot say, keeps it.
  let flag: 'cleared' | 'kept' | undefined;
  if (volumes && r.code === 0) {
    flag = 'kept';
    if (!(await dataVolumesLeft(ctx)) && clearRealData(ctx.root) === null && ctx.local.dump === null && (ctx.local.inputs?.length ?? 0) === 0) flag = 'cleared';
  }
  return { out: { exit: r.code, tail: ctx.out.tail(r, TAIL_CHARS), volumes: volumes ? 'removed' : 'kept', ...(flag === undefined ? {} : { realData: flag }) }, code: r.code === 0 ? 0 : 1 };
}

/** What `sandbox-data` needs of the project (M6b): the first SQL store's service, engine and app database, a compose
 *  call, a check that the daemon and the compose file are safe (asked after the input is parsed, before any query),
 *  and the handle key out of the `meta` volume. */
function dataCtx(ctx: Ctx): DataCtx {
  const store = ctx.scan.stores.find((s) => s.kind === 'postgres' || s.kind === 'mysql' || s.kind === 'mariadb');
  return {
    target: store === undefined || ctx.plan.dbService === null ? null : { engine: store.kind as 'postgres' | 'mysql' | 'mariadb', svc: ctx.plan.dbService, db: dbName(store) },
    comp: ctx.comp,
    ready: async () => (await guard(ctx)) === null,
    key: (candidate) => metaKey(ctx, candidate),
  };
}

/** Adds the sweep's diagnostic, and the registry's (lib/sandbox-registry.ts), to a command's output (an object), when
 *  one failed. */
function withSweep(r: Result, sweep: Diag | null, ctx: Ctx): Result {
  if ((sweep === null && ctx.registryProblem === undefined) || 'error' in r || typeof r.out !== 'object' || r.out === null || Array.isArray(r.out)) return r;
  return { ...r, out: { ...r.out, ...(sweep !== null ? { sweep } : {}), ...(ctx.registryProblem !== undefined ? { registry: ctx.registryProblem } : {}) } };
}

/** The `sandbox-init|local|check|prepare|up|run|down` commands. `error` is a message for the
 *  user; `code` is the exit code (for `sandbox-run`, the suite's). Every command but `sandbox-scan`
 *  and `sandbox-init` starts with `preflight` (is the daemon local, does the project hold real data) and
 *  the expiry sweep of old raw artifacts. */
export async function sandboxCommand(command: string, root: string, args: string[]): Promise<Result> {
  if (command === 'sandbox-scan') {
    // Read-only on the project; the one write is the scan itself.
    const scan = scanSandbox(root);
    const path = writeScan(root, scan);
    if (path instanceof Error) return { error: `sandbox-scan: ${path.message}` };
    return { out: { path, ...scan }, code: scan.problems.length > 0 ? 1 : 0 };
  }
  if (command === 'sandbox-local') {
    const USAGE = 'sandbox-local: pass --dump <absolute path> [--format sql|custom] and/or --input <absolute path> (once per input log)';
    const di = args.indexOf('--dump');
    const dump = di >= 0 ? args[di + 1] : undefined;
    if (di >= 0 && (dump === undefined || dump.startsWith('--'))) return { error: USAGE };
    const inputs: string[] = [];
    for (let i = args.indexOf('--input'); i >= 0 && i < args.length; i = args.indexOf('--input', i + 1)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: USAGE };
      inputs.push(v);
    }
    if (dump === undefined && inputs.length === 0) return { error: USAGE };
    const fi = args.indexOf('--format');
    const f = fi >= 0 ? args[fi + 1] : undefined;
    if (f !== undefined && f !== 'sql' && f !== 'custom') return { error: 'sandbox-local: --format is sql or custom' };
    let w: { path: string; local: SandboxLocal } | Error | null = null;
    if (dump !== undefined) w = writeLocal(root, dump, (f as 'sql' | 'custom' | undefined) ?? null);
    if (!(w instanceof Error) && inputs.length > 0) w = addInputs(root, inputs);
    if (w instanceof Error) return { error: `sandbox-local: ${w.message}` };
    // the registered input logs are shown as a count only
    const { inputs: registered, ...shown } = w!.local;
    const out = { path: w!.path, ...shown, ...((registered?.length ?? 0) > 0 ? { inputs: registered!.length } : {}) };
    // a sandbox that exists already has its sweep (a project with no compose file has nothing to sweep)
    const known = loadCtx(root, true);
    if (known instanceof Error) return { out, code: 0 };
    return withSweep({ out, code: 0 }, await sweepIfSafe(known, await preflight(known)), known);
  }
  if (command === 'sandbox-init') {
    const scan = readScan(root);
    if (scan instanceof Error) return { error: `sandbox-init: ${scan.message}` };
    if (scan.problems.length > 0) return { error: `sandbox-init: the scan has problems that stop a sandbox:\n- ${scan.problems.join('\n- ')}` };
    const local = readLocal(root);
    if (local instanceof Error) return { error: `sandbox-init: ${local.message}` };
    const rep = await initSandbox(root, scan, local, args.includes('--force'));
    if (rep instanceof Error) return { error: `sandbox-init: ${rep.message}` };
    return { out: rep, code: rep.drift.length > 0 ? 1 : 0 };
  }
  const ctx = loadCtx(root, true);
  if (ctx instanceof Error) return { error: `${command}: ${ctx.message}` };
  try {
    const sweep = await sweepIfSafe(ctx, await preflight(ctx));
    switch (command) {
      case 'sandbox-check': {
        const c = await checkSandbox(ctx);
        return withSweep({ out: c, code: checkOk(c) ? 0 : 1 }, sweep, ctx);
      }
      case 'sandbox-prepare':
        return withSweep(await prepare(ctx, args), sweep, ctx);
      case 'sandbox-up':
        return withSweep(await up(ctx, args), sweep, ctx);
      case 'sandbox-run':
        return withSweep(await run(ctx, args), sweep, ctx);
      case 'sandbox-down':
        return withSweep(await down(ctx, args), sweep, ctx);
      case 'sandbox-data':
        return withSweep(await sandboxData(dataCtx(ctx), args), sweep, ctx);
      default:
        return { error: `unknown sandbox command ${command}` };
    }
  } catch (err) {
    // e.g. a planted directory where a result file goes: stop with the reason, not a stack; in real-data mode the error class only
    return { error: ctx.out.err(command, err) };
  }
}
