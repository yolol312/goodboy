// Running the sandbox (track M, M1b; plan §19): the `sandbox-*` commands. Every docker call goes
// through GOODBOY_DOCKER_BIN (default `docker`) with the bounded runner and a timeout. Nothing
// here calls the network except `sandbox-prepare` (image pulls and the preparation step, the
// only places the compose file gives network access to).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { type Bounded, onInterrupt, runBounded } from './bounded';
import { ensureRealDir, initSandbox, noLinksUnder, outOfDate, readLocal, readScan, realOrSelf, repoTops, writeAtomic, writeLocal, writeScan } from './sandbox-files';
import { COVERAGE_REPORT, E2E_DIR } from './sandbox-e2e';
import { planSandbox, SANDBOX_DIR, type SandboxPlan } from './sandbox-render';
import { INHIBIT_IPV4, RESTORE_TAG } from './sandbox-parts';
import { scanSandbox } from './sandbox-scan';
import type { SandboxCheck, SandboxLocal, SandboxScan } from './sandbox-types';
import { readRegular } from './safe-read';
import { ACCESS_LOG_FILE, PLAYWRIGHT_REPORT_FILE } from './ui-types';

const SHORT_MS = 60_000;
const DEFAULT_RUN_MS = 3_600_000;
const MAX_RUN_MS = 7_200_000;
const TAIL_CHARS = 2000;
const MAX_ACCESS_LOG_BYTES = 64 * 1024 * 1024;

export const dockerBin = (): string => process.env.GOODBOY_DOCKER_BIN?.trim() || 'docker';

/** The compose project of a repo: its dir name and a short hash of its real path, so two
 *  checkouts of one name never share networks or volumes. */
export function projectName(root: string): string {
  const real = realOrSelf(root);
  const slug = basename(real).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'project';
  return `gb-${slug}-${createHash('sha256').update(real).digest('hex').slice(0, 6)}`;
}

export interface Ctx {
  root: string;
  dir: string;
  project: string;
  composeFile: string;
  scan: SandboxScan;
  local: SandboxLocal;
  plan: SandboxPlan;
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
  return { root, dir, project: projectName(root), composeFile, scan, local, plan: planSandbox(scan, local, { root }) };
}

const env = (ctx: Ctx): NodeJS.ProcessEnv => ({ ...process.env, ...(ctx.local.dump !== null ? { GOODBOY_DUMP: ctx.local.dump } : {}) });

function dock(ctx: Ctx, args: string[], timeoutMs: number, o: { keep?: 'head' | 'tail'; max?: { stdout: number; stderr: number }; onSpawn?: (kill: (s: 'SIGTERM' | 'SIGKILL') => void) => void } = {}): Promise<Bounded> {
  return runBounded([dockerBin(), ...args], { cwd: ctx.dir, timeoutMs, env: env(ctx), ...o });
}

const comp = (ctx: Ctx, args: string[], timeoutMs: number, o: Parameters<typeof dock>[3] = {}): Promise<Bounded> =>
  dock(ctx, ['compose', '-f', ctx.composeFile, '-p', ctx.project, ...args], timeoutMs, o);

const why = (b: Bounded): string => (b.error ?? (b.timedOut ? 'timed out' : (b.stderr || b.stdout).trim().slice(-400))) || `exit ${b.code}`;
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
    if (svc.network_mode) out.push(`service ${name} sets network_mode ${svc.network_mode}`);
    if (Array.isArray(svc.ports) && svc.ports.length > 0) out.push(`service ${name} publishes ports`);
    const profiles = svc.profiles ?? [];
    if (profiles.length > 0 && profiles.every((p) => p === 'prep')) {
      if (root !== undefined) out.push(...maskProblems(name, svc, root));
      continue;
    }
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
  const c = await dock(ctx, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], SHORT_MS);
  const h = c.code === 0 ? c.stdout.trim() : '';
  return h !== '' && !local(h) ? `the current docker context points at ${h}: the sandbox needs the local docker daemon (a remote one would not see its mounts and would hold the database copy on another machine)` : null;
}

/** The problems of the compose file as docker resolves it (`config --format json`): the static
 *  check, or why the config could not be read. Empty when it is fine. */
async function composeProblems(ctx: Ctx): Promise<string[]> {
  const cfg = await comp(ctx, ['--profile', '*', 'config', '--format', 'json'], SHORT_MS);
  if (cfg.code !== 0) return [`docker compose config failed: ${why(cfg)}`];
  const parsed = parseJson(cfg.stdout);
  return parsed === undefined ? ['docker compose config printed no JSON'] : staticProblems(parsed, ctx.root, ctx.local.dump);
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
    problems.push(`listing the project's containers failed: ${why(ps.code !== 0 ? ps : labelled)}`);
  } else {
    if (netList.code !== 0) {
      inner = false;
      problems.push(`listing the project's networks failed: ${why(netList)}`);
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
          problems.push(`docker inspect failed: ${why(ins)}`);
          break;
        }
        for (const c of arr as { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> }; HostConfig?: { NetworkMode?: string }; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }[]) {
          const nets = c.NetworkSettings?.Networks ?? {};
          const name = (c.Name ?? c.Id ?? '?').replace(/^\//, '');
          if (c.Id) known.add(c.Id);
          seen.push({ id: c.Id ?? '', name, service: c.Config?.Labels?.['com.docker.compose.service'] ?? '', nets: Object.fromEntries(Object.entries(nets).map(([k, v]) => [k, v?.IPAddress ?? ''])) });
          if (c.HostConfig?.NetworkMode === 'host') {
            inner = false;
            problems.push(`container ${name} uses the host network`);
          }
          for (const n of Object.keys(nets)) {
            netNames.add(n);
            if (!allowed.has(n)) {
              inner = false;
              problems.push(`container ${name} is on network ${n}, which is not one of the sandbox's internal networks`);
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
        problems.push(`docker network inspect failed: ${why(ni)}`);
        break;
      }
      for (const n of na as { Name?: string; Internal?: boolean; Options?: Record<string, string>; IPAM?: { Config?: { Gateway?: string }[] }; Containers?: Record<string, unknown> }[]) {
        if (n.Internal !== true) {
          inner = false;
          problems.push(`network ${n.Name ?? '?'} is not internal (Internal=${String(n.Internal)})`);
        }
        // Docker 28 or later; an older daemon ignores the option and the host answers on the gateway
        const gw = (n.IPAM?.Config ?? []).map((c) => c.Gateway).filter((g): g is string => typeof g === 'string' && g !== '');
        if (n.Options?.[INHIBIT_IPV4] !== 'true' || gw.length > 0) {
          inner = false;
          problems.push(`network ${n.Name ?? '?'} has a host address${gw.length > 0 ? ` (${gw.join(', ')})` : ''}: ${INHIBIT_IPV4} is not applied (it needs Docker 28 or later); recreate the network with sandbox-down and sandbox-up`);
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
  if (probe.code !== 0 || !probe.stdout.includes('@@END')) problems.push(`the probe did not run to its end: ${why(probe)}`);
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
        problems.push(`${d.service} does not hold ${d.ip} (it has ${c.nets[net] || 'no address'} on ${net})`);
      }
      continue;
    }
    const a = answers.get(d.host) ?? [];
    const b = answers.get(d.service) ?? [];
    if (a.length === 0 || a.join() !== b.join()) {
      hosts = false;
      problems.push(`${d.host} resolves to ${a.join(', ') || 'nothing'} inside inner, not to ${d.service} (${b.join(', ') || 'not found'})`);
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

const tailOf = (b: Bounded): string => (b.stdout + (b.stderr ? '\n' + b.stderr : '')).slice(-TAIL_CHARS);

/** The output tail of a step that failed. A passing step prints nothing back: its output can
 *  hold rows of the database copy, and the model sees what the commands print. */
const failTail = (b: Bounded): string => (b.code === 0 && !b.timedOut && b.error === undefined ? '' : tailOf(b));

/** Why a restore failed, for the model: only the lines the restore script tags (code and line
 *  of an error), never the client's own text, which can quote a row of the dump. */
function restoreNote(b: Bounded): string {
  if (b.error !== undefined) return b.error;
  if (b.timedOut) return 'timed out';
  const tagged = lines(`${b.stdout}\n${b.stderr}`).filter((l) => l.startsWith(RESTORE_TAG)).slice(0, 25).map((l) => l.slice(0, 200));
  return tagged.length > 0 ? tagged.join('; ') : `exit ${b.code} (the client's output is withheld: it can quote the dump; run the restore script by hand to read it)`;
}

async function prepare(ctx: Ctx, args: string[]): Promise<Result> {
  const unsafe = await guard(ctx);
  if (unsafe !== null) return { error: `sandbox-prepare: ${unsafe}` };
  const pull = await comp(ctx, ['--profile', '*', 'pull'], 30 * 60_000, { keep: 'tail' });
  if (pull.code !== 0) return { out: { step: 'pull', exit: pull.code, tail: failTail(pull) }, code: 1 };
  const big = { keep: 'tail' as const, max: { stdout: 256 * 1024, stderr: 64 * 1024 } };
  const prep = await comp(ctx, ['--profile', 'prep', 'run', '--rm', '-T', 'prep'], msOpt(args, DEFAULT_RUN_MS), big);
  const out: Record<string, unknown> = { step: 'prep', exit: prep.code, timedOut: prep.timedOut, durationMs: prep.ms, tail: failTail(prep) };
  if (prep.code !== 0 || !ctx.plan.hasE2e) return { out, code: prep.code === 0 ? 0 : 1 };
  // the e2e packages go into their own volume, so a failure here leaves the build usable
  const e2e = await comp(ctx, ['--profile', 'prep', 'run', '--rm', '-T', 'e2e-prep'], msOpt(args, DEFAULT_RUN_MS), big);
  out.e2e = { step: 'e2e-prep', exit: e2e.code, timedOut: e2e.timedOut, durationMs: e2e.ms, tail: failTail(e2e) };
  return { out, code: e2e.code === 0 ? 0 : 1 };
}

const sqlServices = (ctx: Ctx): string[] => ctx.plan.upServices.filter((s) => /^db\d*$/.test(s));

async function resetDb(ctx: Ctx): Promise<string | null> {
  for (const svc of sqlServices(ctx)) {
    const r = await comp(ctx, ['exec', '-T', svc, 'sh', '/goodboy-db/reset.sh'], 5 * SHORT_MS);
    if (r.code !== 0) return `resetting ${svc} from its template failed: ${why(r)}`;
  }
  return null;
}

async function up(ctx: Ctx, args: string[]): Promise<Result> {
  const unsafe = await guard(ctx);
  if (unsafe !== null) return { error: `sandbox-up: ${unsafe}` };
  const stale = outOfDate(ctx.root, ctx.plan);
  const steps: { step: string; ok: boolean; note?: string }[] = [];
  const bad = async (step: string, b: Bounded): Promise<Result> => ({ out: { steps: [...steps, { step, ok: false, note: why(b) }], stale }, code: 1 });
  if (ctx.plan.upServices.length > 0) {
    const r = await comp(ctx, ['up', '-d', '--wait', '--wait-timeout', '300', ...ctx.plan.upServices], 10 * 60_000);
    if (r.code !== 0) return bad('up stores and dummies', r);
    steps.push({ step: 'up stores and dummies', ok: true });
  }
  for (const svc of sqlServices(ctx)) {
    const r = await comp(ctx, ['exec', '-T', svc, 'sh', '/goodboy-db/restore.sh'], 30 * 60_000);
    if (r.code !== 0) return { out: { steps: [...steps, { step: `restore ${svc}`, ok: false, note: restoreNote(r) }], stale }, code: 1 };
    const done = lines(r.stdout).slice(-1)[0];
    steps.push({ step: `restore ${svc}`, ok: true, ...(done?.startsWith('template ') ? { note: done } : {}) });
  }
  const err = await resetDb(ctx);
  if (err) return { out: { steps: [...steps, { step: 'reset', ok: false, note: err }], stale }, code: 1 };
  if (sqlServices(ctx).length > 0) steps.push({ step: 'reset', ok: true });
  if (!ctx.plan.hasApp) return { out: { steps, stale, notes: ['no app service: nothing to start'] }, code: 0 };
  const a = await comp(ctx, ['up', '-d', 'app'], 5 * SHORT_MS);
  if (a.code !== 0) return bad('start app', a);
  const waitS = waitSeconds(args);
  const url = ctx.plan.healthUrl;
  const logs = args.includes('--app-logs');
  const appDown = await waitHealth(ctx, url, waitS, logs);
  if (appDown !== null) return { out: { steps: [...steps, { step: 'app health', ok: false, note: `${url} did not answer in ${waitS}s`, detail: appDown }], stale }, code: 1 };
  steps.push({ step: 'app health', ok: true, note: url });
  if (!ctx.plan.hasE2e) return { out: { steps, stale, appUrl: url }, code: 0 };
  // the logging proxy: the browser tests reach the app only through it
  ensureLive(ctx);
  const p = await comp(ctx, ['up', '-d', 'proxy'], 5 * SHORT_MS);
  if (p.code !== 0) return bad('start proxy', p);
  const pdown = await waitHealth(ctx, ctx.plan.proxyHealthUrl, waitS, logs);
  if (pdown !== null) return { out: { steps: [...steps, { step: 'proxy health', ok: false, note: `${ctx.plan.proxyHealthUrl} did not answer in ${waitS}s`, detail: pdown }], stale }, code: 1 };
  steps.push({ step: 'proxy health', ok: true, note: ctx.plan.proxyHealthUrl });
  return { out: { steps, stale, appUrl: url, proxyUrl: ctx.plan.proxyHealthUrl }, code: 0 };
}

const waitSeconds = (args: string[]): number => {
  const i = args.indexOf('--wait-seconds');
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isInteger(n) && n >= 5 && n <= 3600 ? n : 240;
};

/** The dir the app, the proxy and the runner share (`/live`): made by the host so it is the user's. */
const ensureLive = (ctx: Ctx): void => ensureRealDir(ctx.root, `${SANDBOX_DIR}/out/live`);

/** Waits until `url` answers from inside `inner`, or returns why not: the app's last log lines
 *  with `withLogs` (`--app-logs`, they can hold rows of the database), else a note that says so.
 *  Any answer but an error status counts as up: a secured app answers 401 or 403. */
async function waitHealth(ctx: Ctx, url: string, waitS: number, withLogs = false): Promise<string | null> {
  const script = 'wget -S -T 3 -O /dev/null "$0" 2>&1 | grep -E "HTTP/[0-9.]+ (2|3|401|403)" >/dev/null';
  const until = Date.now() + waitS * 1000;
  for (;;) {
    const h = await comp(ctx, ['run', '--rm', '-T', '--no-deps', 'probe', 'sh', '-c', script, url], 2 * SHORT_MS);
    if (h.code === 0) return null;
    if (Date.now() > until) {
      if (!withLogs) return "the app's log is not shown; pass --app-logs to sandbox-up to include its last lines";
      const logs = await comp(ctx, ['logs', '--tail', '40', 'app'], SHORT_MS);
      return (logs.stdout + logs.stderr).slice(-3000);
    }
    await Bun.sleep(3000);
  }
}

/** A regular file at `p` under `base` with no link on the way (noLinksUnder): a `coverage/` that
 *  became a link to a host dir does not make a host file a report that other readers are handed.
 *  What a container wrote into the run dir (mounted read-write, as root) is never trusted by
 *  name: the host writes its own files there through writeAtomic, a temp name and a rename, which
 *  replaces a planted link, never follows it, and fails on a planted directory. */
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

/** What a suite step leaves in the result. */
interface StepResult {
  exit: number;
  durationMs: number;
  timedOut: boolean;
  tail: string;
}

const stepOf = (b: Bounded): StepResult => ({ exit: b.code ?? 1, durationMs: b.ms, timedOut: b.timedOut, tail: failTail(b) });

/** The e2e dir of the project exists and has something in it. */
function hasE2eTests(ctx: Ctx): boolean {
  try {
    return readdirSync(join(ctx.root, E2E_DIR)).length > 0;
  } catch {
    return false;
  }
}

/** The unit and integration suite: the app is restarted (the reset dropped its connections) and
 *  the runner runs the test command with the run's dir at /out, where the JVM, V8 and coverage.py
 *  hooks write their data. */
async function runUnit(ctx: Ctx, outDir: string, ts: string, custom: string[], timeoutMs: number): Promise<StepResult> {
  if (ctx.plan.hasApp) {
    const running = await comp(ctx, ['ps', '-q', 'app'], SHORT_MS);
    if (running.code === 0 && lines(running.stdout).length > 0) await comp(ctx, ['restart', 'app'], 5 * SHORT_MS);
  }
  const name = `${ctx.project}-runner-${ts}`;
  const rmRunner = () => rmContainer(name);
  const r = await onInterrupt(rmRunner, () => comp(ctx, ['run', '--rm', '-T', '--no-deps', '--name', name, '-v', `${outDir}:/out`, 'runner', ...custom], timeoutMs, BIG));
  if (r.timedOut) rmRunner();
  writeAtomic(join(outDir, 'output.log'), r.stdout + (r.stderr ? '\n--- stderr ---\n' + r.stderr : ''));
  return stepOf(r);
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
 *  coverage data on exit) and the proxy's access log is copied into the run's dir. A passing
 *  run's traces and screenshots are deleted, a failing run's kept. */
async function runE2e(ctx: Ctx, outDir: string, ts: string, custom: string[], timeoutMs: number, waitS: number): Promise<E2eResult | string> {
  const problems: string[] = [];
  ensureLive(ctx);
  const proxy = await comp(ctx, ['up', '-d', 'proxy'], 5 * SHORT_MS);
  if (proxy.code !== 0) return `starting the proxy failed: ${why(proxy)}`;
  // what an earlier run left: stale coverage data must not look like this run's
  const clean = await comp(ctx, ['exec', '-T', 'proxy', 'sh', '-c', 'rm -rf /live/jacoco-e2e.exec /live/v8-e2e /live/py-e2e'], SHORT_MS);
  if (clean.code !== 0) return `cleaning /live failed: ${why(clean)}`;
  const running = await comp(ctx, ['ps', '-q', 'app'], SHORT_MS);
  const start = running.code === 0 && lines(running.stdout).length > 0 ? await comp(ctx, ['restart', 'app'], 5 * SHORT_MS) : await comp(ctx, ['up', '-d', 'app'], 5 * SHORT_MS);
  if (start.code !== 0) return `starting the app failed: ${why(start)}`;
  const down = await waitHealth(ctx, ctx.plan.proxyHealthUrl, waitS);
  if (down !== null) return `${ctx.plan.proxyHealthUrl} did not answer in ${waitS}s: ${down.slice(-600)}`;
  // the log of this run starts here: the health waits above are not in it
  const trunc = await comp(ctx, ['exec', '-T', 'proxy', 'sh', '-c', ': > /live/access.log'], SHORT_MS);
  if (trunc.code !== 0) return `truncating the access log failed: ${why(trunc)}`;

  const name = `${ctx.project}-e2e-${ts}`;
  const rmE2e = () => rmContainer(name);
  const r = await onInterrupt(rmE2e, () => comp(ctx, ['run', '--rm', '-T', '--no-deps', '--name', name, '-v', `${outDir}:/out`, 'e2e', ...custom], timeoutMs, BIG));
  if (r.timedOut) rmE2e();
  writeAtomic(join(outDir, 'e2e-output.log'), r.stdout + (r.stderr ? '\n--- stderr ---\n' + r.stderr : ''));

  // stop the app so the JaCoCo agent, V8 and coverage.py write their data
  const stop = await comp(ctx, ['stop', '-t', '60', 'app'], 3 * SHORT_MS);
  if (stop.code !== 0) problems.push(`stopping the app failed, its coverage data may be missing: ${why(stop)}`);

  let accessLog: string | null = null;
  try {
    // The proxy writes this file inside a dir the containers share, so it is read as an untrusted
    // file: a link, a device or a huge file is refused instead of followed.
    const log = readRegular(join(ctx.dir, 'out', 'live', ACCESS_LOG_FILE), MAX_ACCESS_LOG_BYTES, true);
    if (typeof log !== 'object') throw new Error(log === 'absent' ? 'it does not exist' : `it is not a regular file of at most ${MAX_ACCESS_LOG_BYTES} bytes`);
    writeAtomic(join(outDir, ACCESS_LOG_FILE), log.text);
    accessLog = join(outDir, ACCESS_LOG_FILE);
  } catch (err) {
    problems.push(`the proxy's access log could not be copied: ${err instanceof Error ? err.message : String(err)}`);
  }
  const reportPath = join(outDir, PLAYWRIGHT_REPORT_FILE);
  const playwrightReport = isRegularFile(outDir, reportPath) ? reportPath : null;
  if (playwrightReport === null) problems.push('the e2e run wrote no Playwright report');

  // Traces and screenshots are for analysing a failing run only.
  const artifacts = join(outDir, 'e2e-artifacts');
  let kept: E2eResult['artifacts'] = existsSync(artifacts) ? 'kept' : 'none';
  if (kept === 'kept' && r.code === 0 && !r.timedOut) {
    rmSync(artifacts, { recursive: true, force: true });
    kept = existsSync(artifacts) ? 'kept' : 'removed';
    if (kept === 'kept') problems.push(`${artifacts} could not be removed`);
  }
  return { ...stepOf(r), artifacts: kept, accessLog, playwrightReport, problems };
}

interface CoverageResult {
  ok: boolean;
  exit: number | null;
  reports: string[];
  note: string;
}

/** Merges the unit and e2e coverage data of the run and writes the report (JaCoCo XML, lcov or
 *  Cobertura XML) under `coverage/` in the run's dir. A failure is reported, never fatal: the
 *  suites' own exit code decides the run. */
async function runCoverage(ctx: Ctx, outDir: string, withE2e: boolean): Promise<CoverageResult> {
  const file = COVERAGE_REPORT[ctx.scan.stack];
  const r = await comp(ctx, ['run', '--rm', '-T', '--no-deps', '-e', 'GOODBOY_COVERAGE_OUT=', '-e', 'NODE_V8_COVERAGE=', '-e', 'COVERAGE_PROCESS_START=', '-v', `${outDir}:/out`, 'runner', 'sh', '/sandbox/coverage.sh', withE2e ? 'report-e2e' : 'report'], 10 * SHORT_MS, BIG);
  const path = join(outDir, 'coverage', file);
  const ok = r.code === 0 && isRegularFile(outDir, path);
  const note = ok ? lines(r.stdout).slice(-1)[0] ?? '' : r.code === 4 ? 'the coverage tool is not prepared; run sandbox-prepare' : r.code === 3 ? 'the run left no coverage data' : why(r);
  return { ok, exit: r.code, reports: ok ? [path] : [], note };
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
  const write = (r: Record<string, unknown>): string => {
    const p = join(outDir, 'result.json');
    writeAtomic(p, JSON.stringify(r, null, 2) + '\n');
    return p;
  };
  const stale = outOfDate(ctx.root, ctx.plan);
  const check = await checkSandbox(ctx);
  if (!checkOk(check)) {
    const path = write({ ts, suite, check, command, exit: null, durationMs: 0, tail: '', stopped: 'the sandbox check failed' });
    return { out: { stopped: 'the sandbox check failed; the suite did not run', check, result: path }, code: 1 };
  }
  const stopped = async (why0: string): Promise<Result> => {
    const path = write({ ts, suite, check, command, exit: null, durationMs: 0, tail: '', stopped: why0 });
    return { out: { stopped: why0, check, result: path }, code: 1 };
  };
  ensureLive(ctx);
  const reset = await resetDb(ctx);
  if (reset) return stopped(reset);
  const timeoutMs = msOpt(own, DEFAULT_RUN_MS);

  let unit: StepResult | null = null;
  if (wantUnit) unit = await runUnit(ctx, outDir, ts, custom, timeoutMs);
  let e2e: E2eResult | null = null;
  if (wantE2e) {
    // the unit tests may have written to the database: the browser suite starts from the dump again
    if (wantUnit) {
      const again = await resetDb(ctx);
      if (again) return stopped(again);
    }
    const r = await runE2e(ctx, outDir, ts, onlyE2e ? custom : [], timeoutMs, waitSeconds(own));
    if (typeof r === 'string') return stopped(r);
    e2e = r;
  }
  // the report is made in the runner container, so it needs a test command
  const coverage: CoverageResult =
    ctx.scan.build.testCommand.length > 0 ? await runCoverage(ctx, outDir, e2e !== null) : { ok: false, exit: null, reports: [], note: 'the scan has no test command, so there is no runner service to make the coverage report' };
  const first = unit ?? e2e!;
  const exit = unit !== null && unit.exit !== 0 ? unit.exit : e2e !== null && e2e.exit !== 0 ? e2e.exit : first.exit;
  const result = {
    ts,
    suite,
    check,
    command,
    exit,
    durationMs: first.durationMs,
    timedOut: unit?.timedOut === true || e2e?.timedOut === true,
    tail: first.tail,
    ...(unit !== null && e2e !== null ? { unit } : {}),
    ...(e2e !== null ? { e2e } : {}),
    accessLog: e2e?.accessLog ?? null,
    playwrightReport: e2e?.playwrightReport ?? null,
    coverage,
    coverageReports: coverage?.reports ?? [],
  };
  const path = write(result);
  return { out: { ...result, stale, result: path }, code: exit };
}

async function down(ctx: Ctx, args: string[]): Promise<Result> {
  const remote = await endpointProblem(ctx);
  if (remote !== null) return { error: `sandbox-down: ${remote}` };
  const r = await comp(ctx, ['--profile', '*', 'down', '--remove-orphans', ...(args.includes('--volumes') ? ['-v'] : [])], 5 * SHORT_MS);
  return { out: { exit: r.code, tail: failTail(r), volumes: args.includes('--volumes') ? 'removed' : 'kept' }, code: r.code === 0 ? 0 : 1 };
}

/** The `sandbox-init|local|check|prepare|up|run|down` commands. `error` is a message for the
 *  user; `code` is the exit code (for `sandbox-run`, the suite's). */
export async function sandboxCommand(command: string, root: string, args: string[]): Promise<Result> {
  if (command === 'sandbox-scan') {
    // Read-only on the project; the one write is the scan itself.
    const scan = scanSandbox(root);
    const path = writeScan(root, scan);
    if (path instanceof Error) return { error: `sandbox-scan: ${path.message}` };
    return { out: { path, ...scan }, code: scan.problems.length > 0 ? 1 : 0 };
  }
  if (command === 'sandbox-local') {
    const di = args.indexOf('--dump');
    const dump = di >= 0 ? args[di + 1] : undefined;
    if (dump === undefined || dump.startsWith('--')) return { error: 'sandbox-local: pass --dump <absolute path> [--format sql|custom]' };
    const fi = args.indexOf('--format');
    const f = fi >= 0 ? args[fi + 1] : undefined;
    if (f !== undefined && f !== 'sql' && f !== 'custom') return { error: 'sandbox-local: --format is sql or custom' };
    const w = writeLocal(root, dump, (f as 'sql' | 'custom' | undefined) ?? null);
    return w instanceof Error ? { error: `sandbox-local: ${w.message}` } : { out: { path: w.path, ...w.local }, code: 0 };
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
  switch (command) {
    case 'sandbox-check': {
      const c = await checkSandbox(ctx);
      return { out: c, code: checkOk(c) ? 0 : 1 };
    }
    case 'sandbox-prepare':
      return prepare(ctx, args);
    case 'sandbox-up':
      return up(ctx, args);
    case 'sandbox-run':
      try {
        return await run(ctx, args);
      } catch (err) {
        // e.g. a planted directory where a result file goes: stop with the reason, not a stack
        return { error: `sandbox-run: ${err instanceof Error ? err.message : String(err)}` };
      }
    case 'sandbox-down':
      return down(ctx, args);
    default:
      return { error: `unknown sandbox command ${command}` };
  }
}
