// The sandbox scan (track M, M1; plan §19): what a project needs to run in the test sandbox: its
// build, its port, the data stores it talks to and, most important, the outside hosts it calls.
// It is read-only: git lists the files (with the hook git settings, so the repo's config runs no
// program), the manifests, config and source files are read, no project tool runs and nothing is
// written. Every regex and every loop is linear in the text it reads (no unbounded `\s*` run next
// to another, no `^\s*` under /m, unterminated quotes and placeholders found once, per-file and
// per-key lookups cached), every file and total read is capped, and the whole scan has a time
// budget (ScanOptions.budgetMs): past it the rest is left out and a question says so.
//
// What the scan gets wrong must fail toward the safe side. A missed outbound host would be a call
// the sandbox could not answer, so a host is kept when anything suggests it (a config value, a
// literal in code) and an unproven one only has `callSite: null`; a false host only adds a dummy.
// A file it cannot parse is a question, never silence. Secrets are reported by key name only: no
// value that sits under a secret-looking key is read into the output.

import { join, posix } from 'node:path';
import { readRegular } from './safe-read';
import type {
  OutboundKind,
  SandboxApp,
  SandboxBuild,
  SandboxOutbound,
  SandboxScan,
  SandboxStack,
  SandboxStore,
  StoreKind,
  Where,
} from './sandbox-types';
import { inSkippedDir, isBrowserAsset, listFiles, MAX_FILES, ownFile } from './test-survey';

const MAX_CONFIG_BYTES = 1_000_000;
const MAX_SRC_BYTES = 512 * 1024;
const MAX_SRC_TOTAL = 64_000_000;
const MAX_OUTBOUND = 300;
const MAX_SECRET_KEYS = 300;
/** Wall time for a whole scan; past it the rest is left out and said so in a question. */
export const SCAN_BUDGET_MS = 60_000;

/** Pinned image tags for a store whose version the project does not state. */
const DEFAULT_VERSION: Record<StoreKind, string> = { postgres: '16', mysql: '8.4', mariadb: '11', redis: '7', mongo: '7' };

// --- Which files count --------------------------------------------------------------------

// The file lister and the ownership rules are lib/test-survey.ts's (listFiles, inSkippedDir,
// ownFile, isBrowserAsset): the scan, the UI inventory and the coverage gate see one file set.

const extOf = (rel: string): string => {
  const base = posix.basename(rel);
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i + 1).toLowerCase();
};

function readText(root: string, rel: string, max: number): string | null {
  const r = readRegular(join(root, rel), max, true);
  return typeof r === 'object' ? r.text : null;
}

// --- Config parsers: flatten a file into key/value entries ------------------------------------

interface Raw {
  key: string;
  value: string;
  line: number;
}
/** `bad` counts the lines the parser could not make sense of: the caller turns them into a
 *  question rather than trusting what is left. */
interface Parsed {
  entries: Raw[];
  bad: number;
}

/** A `#` comment cut off the end of a YAML line, leaving quoted `#` alone. */
function stripYamlComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') i++;
    } else if (c === '"' || c === "'") {
      // An apostrophe inside a plain word is no quote.
      if (i === 0 || /[\s:[{,'"-]/.test(s[i - 1]!)) q = c;
    } else if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
      return s.slice(0, i);
    }
  }
  return s;
}

/** `key: rest` of a YAML line (the colon must end the line or be followed by a blank), or null. */
function splitYamlKey(s: string): { key: string; rest: string } | null {
  const c0 = s[0];
  if (c0 === '[' || c0 === '{') return null;
  if (c0 === '"' || c0 === "'") {
    let i = 1;
    while (i < s.length && s[i] !== c0) {
      if (c0 === '"' && s[i] === '\\') i++;
      i++;
    }
    if (i >= s.length) return null;
    const key = s.slice(1, i);
    i++;
    while (s[i] === ' ') i++;
    if (s[i] !== ':' || (i + 1 < s.length && s[i + 1] !== ' ')) return null;
    return key === '' ? null : { key, rest: s.slice(i + 1).trim() };
  }
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ':' && (i + 1 === s.length || s[i + 1] === ' ')) {
      const key = s.slice(0, i).trim();
      return key === '' ? null : { key, rest: s.slice(i + 1).trim() };
    }
  }
  return null;
}

/** A YAML scalar's text (quotes removed), or null when it is malformed: an unterminated quote,
 *  text after a closing quote, an unclosed flow collection. */
function yamlScalar(rest: string): string | null {
  if (rest === '') return '';
  const c = rest[0]!;
  if (c === '"' || c === "'") {
    let i = 1;
    while (i < rest.length) {
      if (c === '"' && rest[i] === '\\') {
        i += 2;
        continue;
      }
      if (rest[i] === c) {
        if (c === "'" && rest[i + 1] === "'") {
          i += 2;
          continue;
        }
        break;
      }
      i++;
    }
    if (i >= rest.length || rest.slice(i + 1).trim() !== '') return null;
    return rest.slice(1, i);
  }
  if (c === '[') return rest.endsWith(']') ? rest : null;
  if (c === '{') return rest.endsWith('}') ? rest : null;
  return rest;
}

/** The indentation-based subset of YAML that config files use: nested maps, lists of scalars or
 *  maps, quoted values, block scalars (skipped), several documents (all flattened: Spring profile
 *  documents). Anything else (a tab indent, a key under a scalar, a bad quote) counts as `bad`. */
function flattenYaml(text: string): Parsed {
  const entries: Raw[] = [];
  let bad = 0;
  interface Frame {
    indent: number;
    path: string;
    item: boolean;
    scalar: boolean;
  }
  let stack: Frame[] = [];
  let counters = new Map<string, number>();
  let blockParent = -1;
  const lines = text.split('\n');

  const handleKey = (kv: { key: string; rest: string }, indent: number, parentPath: string, line: number) => {
    const path = parentPath === '' ? kv.key : `${parentPath}.${kv.key}`;
    const rest = kv.rest;
    if (rest === '') {
      stack.push({ indent, path, item: false, scalar: false });
      return;
    }
    if (rest[0] === '|' || rest[0] === '>') {
      blockParent = indent;
      stack.push({ indent, path, item: false, scalar: true });
      return;
    }
    const v = yamlScalar(rest);
    stack.push({ indent, path, item: false, scalar: true });
    if (v === null) {
      bad++;
      return;
    }
    if (kv.key === '<<') return; // a merge key, its anchor holds nothing new
    entries.push({ key: path, value: v, line });
    if (rest[0] === '[') {
      v.slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^(["'])(.*)\1$/, '$2'))
        .filter((x) => x !== '')
        .forEach((x, i) => entries.push({ key: `${path}[${i}]`, value: x, line }));
    }
  };

  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!.replace(/\r$/, '');
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(raw)) {
      stack = [];
      counters = new Map();
      blockParent = -1;
      continue;
    }
    const trimmed = raw.trim();
    if (blockParent >= 0) {
      if (trimmed === '' || raw.length - raw.trimStart().length > blockParent) continue;
      blockParent = -1;
    }
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('%')) continue;
    const lead = raw.length - raw.trimStart().length;
    if (raw.slice(0, lead).includes('\t')) {
      bad++;
      continue;
    }
    const indent = lead;
    const content = stripYamlComment(trimmed).trimEnd();
    if (content === '') continue;
    const top = () => stack[stack.length - 1];
    if (content === '-' || content.startsWith('- ')) {
      while (stack.length > 0 && (top()!.indent > indent || (top()!.indent === indent && top()!.item))) stack.pop();
      const parent = top();
      if (parent?.scalar) {
        bad++;
        continue;
      }
      const ppath = parent?.path ?? '';
      const idx = counters.get(ppath) ?? 0;
      counters.set(ppath, idx + 1);
      const ipath = `${ppath}[${idx}]`;
      const rest = content.slice(1).trimStart();
      const kIndent = indent + (content.length - rest.length);
      if (rest === '') {
        stack.push({ indent, path: ipath, item: true, scalar: false });
        continue;
      }
      const kv = splitYamlKey(rest);
      if (kv) {
        stack.push({ indent, path: ipath, item: true, scalar: false });
        handleKey(kv, kIndent, ipath, n + 1);
        continue;
      }
      const v = yamlScalar(rest);
      if (v === null) bad++;
      else entries.push({ key: ipath, value: v, line: n + 1 });
      continue;
    }
    while (stack.length > 0 && top()!.indent >= indent) stack.pop();
    const parent = top();
    if (parent?.scalar) {
      bad++; // a nested line under a value: not a YAML mapping
      continue;
    }
    const kv = splitYamlKey(content);
    if (!kv) {
      bad++;
      continue;
    }
    handleKey(kv, indent, parent?.path ?? '', n + 1);
  }
  return { entries, bad };
}

/** `key=value` / `key: value` lines (Java properties, ini). A line with no separator, or a
 *  control character, counts as bad: such a file is not the config it looks like. */
function flattenProps(text: string): Parsed {
  const entries: Raw[] = [];
  let bad = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let line = lines[i]!.replace(/\r$/, '').trimStart();
    if (line === '' || line[0] === '#' || line[0] === '!' || line[0] === ';') continue;
    // A line ending in an odd number of backslashes continues on the next one. The pieces are
    //   joined once at the end: joining each time made a long continuation quadratic.
    const pieces: string[] = [];
    for (;;) {
      let k = 0;
      while (line[line.length - 1 - k] === '\\') k++;
      if (k % 2 === 0 || i + 1 >= lines.length) break;
      pieces.push(line.slice(0, -1));
      line = lines[++i]!.replace(/\r$/, '').trimStart();
    }
    if (pieces.length > 0) line = pieces.join('') + line;
    if (/^\[[^\]]*\]$/.test(line.trim())) continue; // an ini section header
    if (/[\0-\x08\x0e-\x1f]/.test(line)) {
      bad++;
      continue;
    }
    const idx = line.search(/[=:]/);
    const key = idx < 0 ? '' : line.slice(0, idx).trim();
    if (key === '') {
      bad++;
      continue;
    }
    entries.push({ key, value: line.slice(idx + 1).trim(), line: start + 1 });
  }
  return { entries, bad };
}

/** `KEY=value` lines of a dotenv file; quotes removed, an unquoted ` #` comment cut. */
function flattenEnv(text: string): Parsed {
  const entries: Raw[] = [];
  let bad = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '').trim().replace(/^export\s+/, '');
    if (line === '' || line[0] === '#') continue;
    const eq = line.indexOf('=');
    const key = eq < 0 ? '' : line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      bad++;
      continue;
    }
    let v = line.slice(eq + 1).trim();
    const q = v[0];
    if (q === '"' || q === "'") {
      const close = v.indexOf(q, 1);
      if (close < 0) {
        bad++;
        continue;
      }
      v = v.slice(1, close);
    } else {
      const c = v.search(/\s#/);
      if (c >= 0) v = v.slice(0, c).trim();
    }
    entries.push({ key, value: v, line: i + 1 });
  }
  return { entries, bad };
}

/** String leaves of a JSON config file (`config/default.json`); the line is the first one that
 *  names the leaf's key. */
function flattenJson(text: string): Parsed {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { entries: [], bad: 1 };
  }
  // The first line each quoted string stands on, found in one pass (a lookup per leaf that scanned
  //   the lines made a large file quadratic). A key with an escape in it is not found: line 1.
  const firstLine = new Map<string, number>();
  text.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(/"([^"\\]*)"/g)) if (!firstLine.has(m[1]!)) firstLine.set(m[1]!, i + 1);
  });
  const lineOf = (k: string) => firstLine.get(k) ?? 1;
  const entries: Raw[] = [];
  const walk = (v: unknown, path: string, last: string, depth: number) => {
    if (typeof v === 'string') entries.push({ key: path, value: v, line: lineOf(last) });
    else if (typeof v === 'number') entries.push({ key: path, value: String(v), line: lineOf(last) });
    else if (depth < 6 && Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, last, depth + 1));
    else if (depth < 6 && v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path === '' ? k : `${path}.${k}`, k, depth + 1);
  };
  walk(doc, '', '', 0);
  return { entries, bad: 0 };
}

function parseConfig(rel: string, text: string): Parsed {
  const base = posix.basename(rel);
  const ext = extOf(rel);
  if (/^\.env(?:\.|$)/.test(base)) return flattenEnv(text);
  if (ext === 'yml' || ext === 'yaml') return flattenYaml(text);
  if (ext === 'json') return flattenJson(text);
  return flattenProps(text); // .properties, .ini
}

/** The first parsed entry of each line of the config files `configEntryAt` was asked about, per
 *  file: the renderer asks once per host, and the hosts of a project sit in several files
 *  (application.yml, application-dev.yml, …), so one slot, or a handful, parsed a file again for
 *  each host. The cache is bounded by an estimate of the heap it holds, the least recently used
 *  file going first: a project's own config files all fit. The estimate counts the parsed entries,
 *  not only the text: a dense file (one key per 10 characters) costs several times its text in
 *  entries (measured on 400 000-line files: 104 bytes of heap per entry for YAML, 137 for properties,
 *  205 for env, so 200 are counted), and a bound on characters let 60 such files be kept at once. */
const CONFIG_CACHE_BYTES = 100 * 1024 * 1024;
const BYTES_PER_CACHED_ENTRY = 200;
const configCache = new Map<string, { text: string; byLine: Map<number, { key: string; value: string }>; cost: number }>();
let configCacheCost = 0;

/** The key and value the scan's own parser reads on `line` (1-based) of a YAML, properties or
 *  `.env` file, or null for any other file, a line with no entry, and a key that sits inside a
 *  list (it has no stable name to override). The renderer uses this so it never disagrees with
 *  the scan about which key a host was written at. */
export function configEntryAt(file: string, text: string, line: number): { key: string; value: string } | null {
  let cached = configCache.get(file);
  if (cached !== undefined && cached.text !== text) cached = undefined;
  if (configCache.has(file)) configCacheCost -= configCache.get(file)!.cost;
  if (cached === undefined) {
    const base = posix.basename(file);
    let parsed: Parsed | null = null;
    if (/\.ya?ml$/i.test(file)) parsed = flattenYaml(text);
    else if (/\.properties$/i.test(file)) parsed = flattenProps(text);
    else if (base.startsWith('.env') || /\.env$/i.test(base)) parsed = flattenEnv(text);
    const byLine = new Map<number, { key: string; value: string }>();
    for (const e of parsed?.entries ?? []) if (!byLine.has(e.line)) byLine.set(e.line, { key: e.key, value: e.value });
    cached = { text, byLine, cost: text.length + byLine.size * BYTES_PER_CACHED_ENTRY };
  }
  // (re)insert last: the map's order is the order of use
  configCache.delete(file);
  configCache.set(file, cached);
  configCacheCost += cached.cost;
  while (configCacheCost > CONFIG_CACHE_BYTES && configCache.size > 1) {
    const [oldest, entry] = configCache.entries().next().value!;
    configCache.delete(oldest);
    configCacheCost -= entry.cost;
  }
  const e = cached.byLine.get(line);
  return e === undefined || /\[\d+\]/.test(e.key) ? null : e;
}

// --- Config entries -----------------------------------------------------------------------

interface Entry {
  key: string;
  value: string;
  where: Where;
  /** `dev` for application-dev.yml, null for the base file. */
  profile: string | null;
  /** A config file the app reads beyond application*.yml (a properties file under resources). */
  extra: boolean;
}

const normKey = (k: string) => k.toLowerCase().replace(/[-_]/g, '');

/** Split a key into its prefix and its last name. A dotted key (`spring.mail.host`) splits at the
 *  last dot; an env key (`SMTP_HOST`) at the last underscore. The name is lower-cased without
 *  `-` and `_`, so `jdbc-url` and `jdbcUrl` agree. */
function keyParts(key: string): { prefix: string; name: string } {
  const dot = key.lastIndexOf('.');
  if (dot >= 0) return { prefix: key.slice(0, dot), name: normKey(key.slice(dot + 1)) };
  const us = key.lastIndexOf('_');
  return us >= 0 ? { prefix: key.slice(0, us), name: key.slice(us + 1).toLowerCase() } : { prefix: '', name: normKey(key) };
}

const SECRET_KEY = /passw(?:or)?d|pwd|passphrase|secret|token|credential|private[-_.]?key|api[-_.]?key|access[-_.]?key|(?:^|[^a-zA-Z])key(?:$|[^a-zA-Z])/i;
const SECRET_CAMEL = /[a-z]Key(?:$|[A-Z.\-_[])/;
/** A last name that says the value is no secret even when the key holds `token` or `secret`. */
const NOT_SECRET_NAME = /(?:url|uri|host|endpoint|path|file|ttl|expir\w*|timeout|header|prefix|enabled|name|type|length|size|algorithm|location|seconds|millis|minutes|days|validity)s?$/;

/** Whether a key looks like it holds a secret. Its value is never read into the output. */
function isSecretKey(key: string): boolean {
  if (!SECRET_KEY.test(key) && !SECRET_CAMEL.test(key)) return false;
  return !NOT_SECRET_NAME.test(keyParts(key).name);
}

/** `${a.b:default}` placeholders replaced by their default. A value still holding `${` after it
 *  has an unresolved host. */
export function resolveDefaults(v: string): string {
  // The regex `\$\{[^}:]*:([^}]*)\}` rescans to the end of the text from every `${a:` that has no
  //   `}`; here the next `:`/`}` and the next `}` are looked up once and reused (both only move on).
  let out = '';
  let from = 0;
  // `found(a)` caches the answer of a search that starts at `a`: while the next start is at or
  //   before the hit, nothing in between can change it.
  let stop = { from: 0, at: -2 }; // the next `:` or `}`; at -1: none, -2: not searched yet
  let close = { from: 0, at: -2 }; // the next `}`
  const nextStop = (a: number): number => {
    if (stop.at !== -2 && stop.from <= a && (stop.at === -1 || stop.at >= a)) return stop.at;
    let at = -1;
    for (let i = a; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 58 || c === 125) {
        at = i;
        break;
      }
    }
    stop = { from: a, at };
    return at;
  };
  const nextClose = (a: number): number => {
    if (close.at !== -2 && close.from <= a && (close.at === -1 || close.at >= a)) return close.at;
    close = { from: a, at: v.indexOf('}', a) };
    return close.at;
  };
  for (;;) {
    const s = v.indexOf('${', from);
    if (s < 0) break;
    const colon = nextStop(s + 2);
    if (colon < 0) break; // no `:` or `}` ahead: no later start can match either
    if (v.charCodeAt(colon) === 125) {
      out += v.slice(from, s + 2); // `${abc}`: not a placeholder with a default
      from = s + 2;
      continue;
    }
    const end = nextClose(colon + 1);
    if (end < 0) break; // no `}` after the colon: no later start can match either
    out += v.slice(from, s) + v.slice(colon + 1, end);
    from = end + 1;
  }
  return out + v.slice(from);
}

// --- Hosts ----------------------------------------------------------------------------------

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const isIpv4 = (h: string) => IPV4.test(h) && h.split('.').every((o) => Number(o) <= 255);
// A bare `12:30:45` is a time, not an address: an IPv6 literal has `::` or all eight groups.
const isIpv6 = (h: string) => /^[0-9a-f:.]+$/i.test(h) && (h.includes('::') || h.split(':').length === 8);

function isLocalHost(h: string): boolean {
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1' || h === 'host.docker.internal' ||
    /^127\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('::ffff:127.')
  );
}

/** XML and schema namespaces, license and documentation hosts: URLs that are names, not calls. */
const NAMESPACE_HOSTS = new Set([
  'www.w3.org', 'w3.org', 'java.sun.com', 'xmlns.jcp.org', 'www.thymeleaf.org', 'thymeleaf.org', 'www.ultraq.net.nz', 'ultraq.net.nz',
  'springframework.org', 'www.springframework.org', 'maven.apache.org', 'schemas.xmlsoap.org', 'schemas.microsoft.com',
  'schemas.openxmlformats.org', 'purl.org', 'www.jcp.org', 'mybatis.org', 'json-schema.org', 'www.sitemaps.org', 'xml.org',
  'www.opengis.net', 'jakarta.ee', 'www.gnu.org', 'opensource.org', 'www.opensource.org',
]);
/** Hosts a browser loads assets from: not server calls. Applied to templates and front-end files. */
const CDN_HOST = /^cdn\d*\.|\.cdn\.|(?:^|\.)(?:jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|bootstrapcdn\.com|fontawesome\.com|googleapis\.com|gstatic\.com|googletagmanager\.com|google-analytics\.com|jquery\.com|cloudflare\.com)$/;
const XML_CONTEXT = /xmlns|xsi:|DOCTYPE|schemaLocation|<!ENTITY/i;

interface HostRef {
  host: string;
  ipLiteral: boolean;
}

/** A usable remote host from a name or address: null for a local address, a placeholder and an
 *  unresolved or wildcard value. */
function hostRef(raw: string): HostRef | null {
  const h = raw.trim().toLowerCase();
  if (h === '' || /[${}*%\s]/.test(h) || h.length > 253) return null;
  if (isLocalHost(h)) return null;
  const ipLiteral = isIpv4(h) || isIpv6(h);
  if (!ipLiteral && !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(h)) return null;
  if (isIpv4(h) && (h.startsWith('0.') || h.startsWith('255.'))) return null;
  return { host: h, ipLiteral };
}

/** `scheme://[user:pass@]host[:port]/path`: the parts the scan keeps. Credentials are dropped. */
function urlParts(s: string): { host: string; port: number | null; path: string } | null {
  const i = s.indexOf('://');
  if (i < 0) return null;
  const rest = s.slice(i + 3);
  const end = rest.search(/[/?#]/);
  const auth = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? '' : rest.slice(end);
  const at = auth.lastIndexOf('@');
  const first = (at >= 0 ? auth.slice(at + 1) : auth).split(',')[0]!;
  let host: string;
  let portStr = '';
  if (first.startsWith('[')) {
    const close = first.indexOf(']');
    if (close < 0) return null;
    host = first.slice(1, close);
    portStr = first.slice(close + 1).replace(/^:/, '');
  } else {
    const c = first.lastIndexOf(':');
    host = c < 0 ? first : first.slice(0, c);
    portStr = c < 0 ? '' : first.slice(c + 1);
  }
  return { host, port: /^\d{1,5}$/.test(portStr) ? Number(portStr) : null, path: tail.split(/[?#;]/)[0]! };
}

const URL_RE = /\b(https?|ldaps?|smtps?|wss?|ftps?|sftp):\/\/[^\s"'`<>\\^|{}]+/gi;

const SCHEME_KIND: Record<string, OutboundKind> = {
  http: 'http', https: 'http', ldap: 'ldap', ldaps: 'ldap', smtp: 'smtp', smtps: 'smtp', ws: 'other', wss: 'other', ftp: 'other', ftps: 'other', sftp: 'other',
};

interface UrlHit {
  host: string;
  port: number | null;
  scheme: string;
  kind: OutboundKind;
  ipLiteral: boolean;
}

/** The outbound URLs in a piece of text. `browser` also drops CDN hosts. */
function urlsIn(text: string, browser: boolean): UrlHit[] {
  const out: UrlHit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    // Trailing punctuation off by a loop: `/[.,;:)]+$/` tries every start of a run of it.
    let stop = m[0].length;
    while (stop > 0 && '.,;:)'.includes(m[0][stop - 1]!)) stop--;
    const url = m[0].slice(0, stop);
    const parts = urlParts(url);
    if (!parts) continue;
    const ref = hostRef(parts.host);
    if (!ref || NAMESPACE_HOSTS.has(ref.host)) continue;
    if (/\.(?:xsd|dtd|xsl)$/i.test(parts.path) || /\/licenses?(?:\/|$)/i.test(parts.path)) continue;
    if (browser && CDN_HOST.test(ref.host)) continue;
    const scheme = m[1]!.toLowerCase();
    out.push({ host: ref.host, port: parts.port, scheme, kind: SCHEME_KIND[scheme] ?? 'other', ipLiteral: ref.ipLiteral });
  }
  return out;
}

// --- Stores ---------------------------------------------------------------------------------

const STORE_WORD: [RegExp, StoreKind][] = [
  [/(?:^|[._\-[])(?:postgres(?:ql)?|pg)(?:$|[._\-\]])/i, 'postgres'],
  [/(?:^|[._\-[])mysql(?:$|[._\-\]])/i, 'mysql'],
  [/(?:^|[._\-[])mariadb(?:$|[._\-\]])/i, 'mariadb'],
  [/(?:^|[._\-[])redis(?:$|[._\-\]])/i, 'redis'],
  [/(?:^|[._\-[])mongo(?:db|ose)?(?:$|[._\-\]])/i, 'mongo'],
];
/** A prefix that names a store or its pool: its `host` keys are no outbound host. */
const STORE_PREFIX = /(?:^|[._\-[])(?:postgres(?:ql)?|pg|mysql|mariadb|redis|mongo(?:db|ose)?|datasource|database|db|jdbc|sql|cache)(?:$|[._\-\]])/i;
const STORE_CREATE_NAMES = new Set(['url', 'jdbcurl', 'uri', 'host', 'hostname', 'port', 'database', 'dbname']);
const STORE_KEY_NAMES = new Set([
  'url', 'jdbcurl', 'uri', 'host', 'hostname', 'port', 'username', 'user', 'password', 'passwd', 'database', 'db', 'dbname', 'name',
  'driverclassname', 'schema', 'sslmode', 'ssl', 'authenticationdatabase',
]);

const EMBEDDED_JDBC = new Set(['h2', 'hsqldb', 'derby', 'sqlite', 'sqlite3', 'mem']);
const JDBC_KIND: Record<string, StoreKind> = { postgresql: 'postgres', mysql: 'mysql', mariadb: 'mariadb' };
const URL_STORE_KIND: Record<string, StoreKind> = {
  postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', mariadb: 'mariadb', redis: 'redis', rediss: 'redis', mongodb: 'mongo', 'mongodb+srv': 'mongo',
};

interface StoreUrl {
  kind: StoreKind;
  database: string | null;
  host: string | null;
}

/** A store URL (`jdbc:postgresql://…`, `redis://…`, `postgres://…`), `'unsupported:<driver>'` for
 *  a JDBC driver with no sandbox image, or null when the value is no store URL (an embedded
 *  database is none either: it runs inside the app). */
function storeUrl(v: string): StoreUrl | `unsupported:${string}` | null {
  const j = /^jdbc:(?:(?:log4jdbc|p6spy):)?([a-z0-9]+):/i.exec(v);
  let kind: StoreKind | undefined;
  if (j) {
    const driver = j[1]!.toLowerCase();
    if (EMBEDDED_JDBC.has(driver)) return null;
    kind = JDBC_KIND[driver];
    if (!kind) return `unsupported:${driver}`;
  } else {
    const m = /^([a-z0-9]+(?:\+srv)?)(?:\+[a-z0-9]+)?:\/\//i.exec(v);
    kind = m ? URL_STORE_KIND[m[1]!.toLowerCase()] : undefined;
    if (!kind) return null;
  }
  const parts = urlParts(v);
  const db = parts?.path.replace(/^\//, '').split('/')[0] ?? '';
  return { kind, database: kind !== 'redis' && /^[\w.-]+$/.test(db) ? db : null, host: parts?.host ?? null };
}

/** The store kind a key prefix names (`spring.data.redis`, `REDIS`), or null. */
function wordKind(prefix: string): StoreKind | null {
  for (const [re, kind] of STORE_WORD) if (re.test(prefix)) return kind;
  return null;
}

interface StoreGroup {
  kind: StoreKind;
  prefix: string;
  where: Where;
  database: string | null;
  keys: Set<string>;
}

// --- Outbound call sites --------------------------------------------------------------------

type Lang = 'jvm' | 'node' | 'python';
const LANG_EXT: Record<string, Lang> = {
  java: 'jvm', kt: 'jvm', groovy: 'jvm', scala: 'jvm',
  js: 'node', ts: 'node', jsx: 'node', tsx: 'node', mjs: 'node', cjs: 'node', mts: 'node', cts: 'node', vue: 'node',
  py: 'python',
};
/** Files that may hold a URL literal without being code: templates and XML. */
const TEMPLATE_EXT = new Set(['html', 'htm', 'xhtml', 'jsp', 'jspf', 'ftl', 'ftlh', 'mustache', 'hbs', 'ejs', 'pug', 'twig', 'vm', 'xml']);

type CallKind = 'http' | 'smtp' | 'ldap';

/** What a call site looks like, per language and kind of host. A match on a non-import,
 *  non-comment line is the call site. */
const CALLS: Record<Lang, Record<CallKind, RegExp>> = {
  jvm: {
    http: /\b(?:RestTemplate|WebClient|RestClient|HttpClients?|HttpClientBuilder|HttpURLConnection|OkHttpClient|OkHttp|FeignClient|CloseableHttpClient|HttpGet|HttpPost|HttpPut|HttpDelete|WebServiceTemplate|Unirest)\b|\bHttpRequest\.newBuilder|\bnew\s+URL\s*\(|\.openConnection\s*\(/,
    smtp: /\b(?:JavaMailSender(?:Impl)?|MimeMessage(?:Helper)?|SimpleMailMessage|HtmlEmail|SimpleEmail)\b|\bTransport\.send\b/,
    ldap: /\b(?:InitialDirContext|InitialLdapContext|LdapContext|LdapTemplate|LdapContextSource|LDAPConnection|ActiveDirectoryLdapAuthenticationProvider)\b/,
  },
  node: {
    http: /\b(?:axios|superagent|node-fetch|undici|needle)\b|\bfetch\s*\(|\bgot\s*[.(]|\bky\s*[.(]|\bhttps?\.(?:request|get)\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\$\.(?:ajax|get|post)\s*\(/,
    smtp: /\b(?:nodemailer|createTransport|sendMail|SMTPClient)\b|@sendgrid\/mail/,
    ldap: /\b(?:ldapjs|ldapts|ldapauth|ldap-client)\b|\bldap\.createClient\b/,
  },
  python: {
    http: /\b(?:requests\.(?:get|post|put|delete|patch|head|request|Session)|urllib\.request|urlopen|http\.client|pycurl)\b|\b(?:httpx|aiohttp|urllib3)\./,
    smtp: /\b(?:smtplib|SMTP_SSL|aiosmtplib|yagmail|fastapi_mail|flask_mail|FastMail)\b|\bSMTP\s*\(/,
    ldap: /\b(?:ldap3|python_ldap)\b|\bldap\.initialize\b/,
  },
};
const CALL_KINDS: CallKind[] = ['http', 'smtp', 'ldap'];

const IMPORT_LINE = /^\s*(?:import\b|from\s+[\w.'"/@-]+\s+import\b|export\b.*\bfrom\b|using\b)|\brequire\s*\(/;

function isCommentLine(t: string, ext: string): boolean {
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('<!--') || t.startsWith('<%--')) return true;
  return ext === 'py' && t.startsWith('#');
}

interface Src {
  rel: string;
  ext: string;
  lang: Lang | null;
  /** A browser asset or template: no server-side call sites. */
  browser: boolean;
  text: string;
  lines: string[];
}

/** One candidate outbound host, before its call site is looked up. */
interface Cand {
  host: string;
  port: number | null;
  scheme: string | null;
  kind: OutboundKind;
  where: Where;
  hardcoded: boolean;
  ipLiteral: boolean;
  /** The source file the host was written in (literal candidates). */
  file: string | null;
  /** The constant it was assigned to, when the literal sits in an UPPER_CASE constant. */
  name: string | null;
  /** The config key it came from (config candidates). */
  key: string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (s: string, flags = '') => new RegExp(`(?<![\\w$])${escapeRe(s)}(?![\\w$])`, flags);

/** Top-level domains a bare host name in code must end in (a file extension or a config key is
 *  no host). */
const HOST_TLD = new Set([
  'com', 'net', 'org', 'io', 'co', 'kr', 'jp', 'cn', 'de', 'uk', 'us', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'dev', 'app', 'cloud', 'ai', 'me',
  'tv', 'ru', 'fr', 'eu', 'in', 'br', 'au', 'ca', 'nl', 'se', 'ch', 'es', 'it', 'pl', 'local', 'internal', 'lan', 'corp', 'intra', 'intranet',
]);
const HOST_CONTEXT = /host|server|smtp|ldap|setHost|createTransport|SMTP|connect|InetSocketAddress|socket|broker|endpoint/i;
const FQDN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/;
/** The text inside each `"…"`, `'…'` and `` `…` `` literal of one line (a backslash escapes the next
 *  character; a literal ends on its line). A tokenizer, not a regex: an unterminated quote made
 *  the regex scan to the end of the line from each of its quotes. When the scan from a quote ends
 *  at `stop` without a closing one, no later quote of that kind before `stop` has one either (a
 *  quote's escapes are the backslash runs before it, the same from any earlier start, and the
 *  scan stops at the same place), so those are not tried again. */
export function stringLiterals(line: string): string[] {
  const out: string[] = [];
  const deadUntil = new Map<string, number>();
  const n = line.length;
  let i = 0;
  while (i < n) {
    const q = line[i]!;
    if ((q !== '"' && q !== "'" && q !== '`') || i <= (deadUntil.get(q) ?? -1)) {
      i++;
      continue;
    }
    let end = -1;
    let stop = n;
    for (let j = i + 1; j < n; ) {
      const c = line[j]!;
      if (c === q) {
        end = j;
        break;
      }
      if (c === '\\') {
        const d = line[j + 1];
        if (d === undefined || d === '\r' || d === '\u2028' || d === '\u2029') {
          stop = j; // `\\.` does not match these: the literal cannot go on
          break;
        }
        j += 2;
      } else j++;
    }
    if (end < 0) {
      deadUntil.set(q, stop);
      i++;
    } else {
      out.push(line.slice(i + 1, end));
      i = end + 1;
    }
  }
  return out;
}
const CONST_ASSIGN = /\b([A-Za-z_]\w*)\s*(?::\s*[\w.<>?]+\s*)?=\s*[`"']/;

// --- Stack detection ------------------------------------------------------------------------

interface Manifest {
  stack: SandboxStack;
  rel: string;
  dir: string;
  depth: number;
  /** A Spring Boot build (JVM only): preferred among several build files. */
  boot: boolean;
}

const STACK_ORDER: SandboxStack[] = ['jvm', 'node', 'python'];
const dirOf = (rel: string) => (posix.dirname(rel) === '.' ? '' : posix.dirname(rel));
const depthOf = (dir: string) => (dir === '' ? 0 : dir.split('/').length);
const joinRel = (...p: string[]) => posix.join(...p.filter((x) => x !== ''));

/** The first line (1-based) of a text matching `re`, or 1. Lines that are comments are skipped. */
function lineMatching(text: string, re: RegExp): number {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('<!--')) continue;
    if (re.test(lines[i]!)) return i + 1;
  }
  return 1;
}

/** `1.8` → `8`, `17` → `17`, `VERSION_1_8` → `8`. */
function javaVersion(s: string): string | null {
  const m = /(?:VERSION_)?(\d+)(?:[._](\d+))?/.exec(s);
  if (!m) return null;
  return m[1] === '1' && m[2] ? m[2] : m[1]!;
}

/** The `major.minor` of a Python version spec (`>=3.11,<4` → `3.11`), or null. */
function pythonVersion(s: string): string | null {
  const m = /(\d+\.\d+)/.exec(s);
  return m ? m[1]! : null;
}

/** A Node version spec (`>=20`, `^20.1.0`, `v20.11.0`, `20.x`) → its major, or null. */
function nodeVersion(s: string): string | null {
  const m = /(\d+)/.exec(s);
  return m ? m[1]! : null;
}

/** An empty scan carrying only problems (no git, no build tool). The stack is a placeholder:
 *  with `problems` set the scan stops there. */
function problemScan(root: string, problems: string[], stack: SandboxStack = 'node'): SandboxScan {
  return {
    root,
    stack,
    frameworks: [],
    build: { tool: '', runtimeVersion: null, depsCommand: [], buildCommand: [], testCommand: [], startCommand: [], artifact: null },
    app: { port: 0, contextPath: '/', healthPath: '/', configFiles: [] },
    stores: [],
    outbound: [],
    secretKeys: [],
    questions: [],
    problems,
  };
}

const UNSUPPORTED_MANIFESTS: [RegExp, string][] = [
  [/^go\.mod$/, 'go'],
  [/^Cargo\.toml$/, 'rust'],
  [/^Gemfile$/, 'ruby'],
  [/^composer\.json$/, 'php'],
  [/\.csproj$/, 'dotnet'],
];

/** What a stack builder returns beyond the shared scan parts. */
interface StackInfo {
  frameworks: string[];
  build: SandboxBuild;
  app: SandboxApp;
  /** Store drivers or clients the dependencies name, for a store with no config. */
  deps: { kind: StoreKind; where: Where }[];
  /** Repo-relative text of the dependency files, to find the line of a dependency. */
  questions: string[];
  problems: string[];
}

interface Ctx {
  root: string;
  files: string[];
  manifest: Manifest;
  entries: Entry[];
  configFiles: string[];
  src: Src[];
  read(rel: string): string | null;
  has(rel: string): boolean;
}

/** The entry for the first of `keys` (normalized), base profile first. */
function pick(entries: Entry[], ...keys: string[]): Entry | undefined {
  const want = new Set(keys.map(normKey));
  return entries.find((e) => want.has(normKey(e.key)) && !isSecretKey(e.key));
}

const portOf = (v: string): number | null => {
  const m = /^(\d{1,5})$/.exec(resolveDefaults(v).trim());
  return m && Number(m[1]) > 0 && Number(m[1]) < 65536 ? Number(m[1]) : null;
};

// --- JVM ------------------------------------------------------------------------------------

function scanJvm(ctx: Ctx): StackInfo {
  const { manifest, files, entries } = ctx;
  const questions: string[] = [];
  const problems: string[] = [];
  const isMaven = posix.basename(manifest.rel) === 'pom.xml';
  const appDir = manifest.dir;

  // The dir the build tool runs in: the settings.gradle dir for Gradle, the topmost pom for Maven.
  let wrapperDir = appDir;
  if (isMaven) {
    let d = appDir;
    while (d !== '' && ctx.has(joinRel(dirOf(d), 'pom.xml'))) d = dirOf(d);
    wrapperDir = d;
  } else {
    let d = appDir;
    for (;;) {
      if (ctx.has(joinRel(d, 'settings.gradle')) || ctx.has(joinRel(d, 'settings.gradle.kts'))) {
        wrapperDir = d;
        break;
      }
      if (d === '') break;
      d = dirOf(d);
    }
  }
  const module = wrapperDir === appDir ? '' : posix.relative(wrapperDir || '.', appDir || '.');
  if (wrapperDir !== '') questions.push(`the build runs in \`${wrapperDir}\`, not the repo root: run the build commands from there`);

  // The build text: the app's build file plus the root's (plugins and the JDK often sit there).
  const buildFiles = [manifest.rel];
  const rootBuild = isMaven ? joinRel(wrapperDir, 'pom.xml') : ['build.gradle', 'build.gradle.kts'].map((n) => joinRel(wrapperDir, n)).find((r) => ctx.has(r));
  if (rootBuild && rootBuild !== manifest.rel) buildFiles.push(rootBuild);
  const texts = buildFiles.map((rel) => ({ rel, text: ctx.read(rel) ?? '' }));
  const all = texts.map((t) => t.text).join('\n');

  const boot = /org\.springframework\.boot|spring-boot/.test(all);
  // No `\s*\(?\s*` (two runs of blanks that split a long run in n ways) and no `^\s*` under /m (a run
  //   of blank lines is walked again from each of its starts): both were quadratic.
  const war = isMaven ? /<packaging>\s*war\s*<\/packaging>/.test(all) : /\bid(?:[ \t]*\()?[ \t]*['"]war['"]|apply\s+plugin:\s*['"]war['"]|^[ \t]*war[ \t]*\{/m.test(all);
  const jsp = /tomcat-embed-jasper|\bjstl\b|jakarta\.servlet\.jsp/i.test(all) || files.some((f) => /\.jsp$/i.test(f));
  const frameworks: string[] = [];
  if (boot) frameworks.push('spring-boot');
  if (/thymeleaf/i.test(all)) frameworks.push('thymeleaf');
  if (jsp) frameworks.push('jsp');
  if (/mybatis/i.test(all)) frameworks.push('mybatis');
  if (/spring-boot-starter-data-jpa|hibernate/i.test(all)) frameworks.push('jpa');
  if (/freemarker/i.test(all)) frameworks.push('freemarker');

  // JDK.
  const jdkRules: RegExp[] = isMaven
    ? [/<java\.version>\s*([^<\s][^<]*)</, /<maven\.compiler\.release>\s*([^<\s][^<]*)</, /<maven\.compiler\.source>\s*([^<\s][^<]*)</, /<release>\s*([^<\s][^<]*)</, /<source>\s*([^<\s][^<]*)</]
    : [
        /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/,
        /jvmToolchain\(\s*(\d+)\s*\)/,
        /sourceCompatibility(?:\s*=)?\s*['"]?([\w.]+)/,
        /targetCompatibility(?:\s*=)?\s*['"]?([\w.]+)/,
        /jvmTarget\s*=\s*['"]([\d.]+)['"]/,
      ];
  let runtimeVersion: string | null = null;
  for (const re of jdkRules) {
    const m = re.exec(all);
    if (m && !m[1]!.includes('$')) {
      runtimeVersion = javaVersion(m[1]!);
      if (runtimeVersion) break;
    }
  }
  if (!runtimeVersion) questions.push('the JDK version is not stated in the build file: pick one');

  // Commands.
  const tool = isMaven ? 'maven' : 'gradle';
  let build: SandboxBuild;
  const artifactDir = isMaven ? 'target' : 'build/libs';
  const artifact = joinRel(appDir, artifactDir, war ? '*.war' : '*.jar');
  if (isMaven) {
    const m = ctx.has(joinRel(wrapperDir, 'mvnw')) ? './mvnw' : 'mvn';
    const pl = module === '' ? [] : ['-pl', module, '-am'];
    build = {
      tool,
      runtimeVersion,
      depsCommand: [m, '-B', 'dependency:go-offline', ...pl],
      buildCommand: [m, '-B', '-o', 'package', '-DskipTests', ...pl],
      testCommand: [m, '-B', '-o', 'test', ...pl],
      startCommand: ['java', '-jar', artifact],
      artifact,
    };
  } else {
    const g = ctx.has(joinRel(wrapperDir, 'gradlew')) ? './gradlew' : 'gradle';
    const q = module === '' ? '' : `:${module.split('/').join(':')}:`;
    const task = boot ? (war ? 'bootWar' : 'bootJar') : 'build';
    build = {
      tool,
      runtimeVersion,
      depsCommand: [g, '--no-daemon', `${q}dependencies`],
      buildCommand: [g, '--no-daemon', `${q}${task}`, ...(task === 'build' ? ['-x', 'test'] : [])],
      testCommand: [g, '--offline', `${q}test`],
      startCommand: ['java', '-jar', artifact],
      artifact,
    };
  }
  if (!boot) questions.push('no Spring Boot plugin in the build file: `java -jar` may not start the app');
  if (war) {
    questions.push(
      boot
        ? 'the app builds a WAR: `java -jar` works only for an executable Spring Boot WAR (check that it starts without an external servlet container)'
        : 'the app builds a WAR with no Spring Boot plugin: it is not executable and needs a servlet container',
    );
  } else if (jsp) {
    questions.push('the app uses JSP but builds a JAR: JSP pages do not render from an executable JAR');
  }

  // Spring config: port, context path, health path.
  const portEntry = pick(entries, 'server.port');
  let port = 8080;
  if (portEntry) {
    const p = portOf(portEntry.value);
    if (p) port = p;
    else questions.push(`server.port in ${portEntry.where.file}:${portEntry.where.line} is not a fixed number: the app port is assumed ${port}`);
  }
  const ctxEntry = pick(entries, 'server.servlet.context-path', 'server.context-path');
  let contextPath = '/';
  if (ctxEntry) {
    const c = resolveDefaults(ctxEntry.value).trim().replace(/\/+$/, '');
    if (c.includes('$')) questions.push(`the context path in ${ctxEntry.where.file}:${ctxEntry.where.line} is a placeholder: assumed \`/\``);
    else if (c !== '') contextPath = c.startsWith('/') ? c : `/${c}`;
  }
  let healthPath = contextPath;
  if (/spring-boot-starter-actuator/.test(all)) {
    const base = pick(entries, 'management.endpoints.web.base-path');
    const actuator = base ? `/${resolveDefaults(base.value).replace(/^\/+|\/+$/g, '')}` : '/actuator';
    const include = pick(entries, 'management.endpoints.web.exposure.include');
    const exposed = !include || /\*|health/i.test(include.value);
    if (exposed) healthPath = `${contextPath === '/' ? '' : contextPath}${actuator === '/' ? '' : actuator}/health`;
    else questions.push('the actuator does not expose `health`: the health path is the context path');
    const mgmtPort = pick(entries, 'management.server.port');
    if (mgmtPort && portOf(mgmtPort.value) !== port) questions.push('the actuator listens on its own port (management.server.port): the health check must use it');
  }
  if (healthPath === contextPath) questions.push(noHealthRoute(healthPath));

  // Store drivers and clients from the build files.
  const deps: { kind: StoreKind; where: Where }[] = [];
  const rules: [StoreKind | 'unsupported', RegExp][] = [
    ['postgres', /org\.postgresql|[:'"/>]postgresql[:'"<]/],
    ['mysql', /mysql-connector|com\.mysql/],
    ['mariadb', /mariadb-java-client|org\.mariadb/],
    ['redis', /spring-boot-starter-data-redis|\bjedis\b|lettuce|redisson|spring-session-data-redis/],
    ['mongo', /spring-boot-starter-data-mongodb|mongodb-driver|mongo-java-driver/],
    ['unsupported', /ojdbc|mssql-jdbc|db2jcc|tibero|cubrid/],
  ];
  for (const t of texts) {
    const lines = t.text.split('\n');
    for (const [kind, re] of rules) {
      const i = lines.findIndex((l) => !/^\s*(?:\/\/|#|\*|<!--)/.test(l) && !l.includes('jdbc:') && re.test(l));
      if (i < 0) continue;
      if (kind === 'unsupported') problems.push(`unsupported store: a ${/ojdbc/.test(lines[i]!) ? 'Oracle' : 'proprietary'} JDBC driver in ${t.rel}:${i + 1}; the sandbox has no image for it`);
      else if (!deps.some((d) => d.kind === kind)) deps.push({ kind, where: { file: t.rel, line: i + 1 } });
    }
  }
  return { frameworks, build, app: { port, contextPath, healthPath, configFiles: ctx.configFiles }, deps, questions, problems };
}

// --- Node -----------------------------------------------------------------------------------

function scanNode(ctx: Ctx): StackInfo {
  const { manifest, entries } = ctx;
  const questions: string[] = [];
  const problems: string[] = [];
  const dir = manifest.dir;
  const text = ctx.read(manifest.rel) ?? '';
  let pkg: Record<string, unknown> = {};
  try {
    const p: unknown = JSON.parse(text);
    if (p && typeof p === 'object') pkg = p as Record<string, unknown>;
  } catch {
    problems.push(`${manifest.rel} is not valid JSON`);
  }
  const obj = (k: string): Record<string, unknown> => (pkg[k] && typeof pkg[k] === 'object' ? (pkg[k] as Record<string, unknown>) : {});
  const depNames = new Set([...Object.keys(obj('dependencies')), ...Object.keys(obj('devDependencies')), ...Object.keys(obj('peerDependencies'))]);
  const scripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj('scripts'))) if (typeof v === 'string') scripts[k] = v;

  // Package manager: by lockfile (this dir, then the repo root), then the packageManager field.
  const lockHere = (n: string) => ctx.has(joinRel(dir, n)) || ctx.has(n);
  let tool = 'npm';
  let locked = lockHere('package-lock.json');
  if (lockHere('pnpm-lock.yaml')) (tool = 'pnpm'), (locked = true);
  else if (lockHere('yarn.lock')) (tool = 'yarn'), (locked = true);
  else if (lockHere('bun.lock') || lockHere('bun.lockb')) (tool = 'bun'), (locked = true);
  else if (!locked) {
    const pm = typeof pkg.packageManager === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager) : null;
    if (pm) tool = pm[1]!;
    else questions.push('no lockfile: the package manager is assumed to be npm');
  }

  // Node version.
  let runtimeVersion: string | null = null;
  const engines = obj('engines').node;
  if (typeof engines === 'string') runtimeVersion = nodeVersion(engines);
  for (const n of ['.nvmrc', '.node-version']) {
    if (runtimeVersion) break;
    const t = ctx.read(joinRel(dir, n)) ?? ctx.read(n);
    if (t !== null) runtimeVersion = nodeVersion(t.trim().replace(/^lts\/.*$/i, ''));
  }
  if (!runtimeVersion) {
    const t = ctx.read(joinRel(dir, '.tool-versions')) ?? ctx.read('.tool-versions');
    const m = t ? /^nodejs\s+(\S+)/m.exec(t) : null;
    if (m) runtimeVersion = nodeVersion(m[1]!);
  }
  if (!runtimeVersion) questions.push('the Node version is not stated (engines.node, .nvmrc): pick one');

  const frameworks: string[] = [];
  for (const [name, dep] of [
    ['next', 'next'], ['react', 'react'], ['express', 'express'], ['fastify', 'fastify'], ['nestjs', '@nestjs/core'], ['nuxt', 'nuxt'],
    ['vue', 'vue'], ['vite', 'vite'], ['koa', 'koa'],
  ] as const) {
    if (depNames.has(dep)) frameworks.push(name);
  }
  const isNext = frameworks.includes('next');
  const isVite = frameworks.includes('vite') && !isNext;
  const cra = depNames.has('react-scripts');

  const run = (s: string) => [tool, 'run', s];
  const installLocked: Record<string, string[]> = {
    npm: locked ? ['npm', 'ci'] : ['npm', 'install'],
    pnpm: locked ? ['pnpm', 'install', '--frozen-lockfile'] : ['pnpm', 'install'],
    yarn: locked ? ['yarn', 'install', '--frozen-lockfile'] : ['yarn', 'install'],
    bun: locked ? ['bun', 'install', '--frozen-lockfile'] : ['bun', 'install'],
  };
  const hasBuild = typeof scripts.build === 'string';
  if (!hasBuild) questions.push('no `build` script in package.json');
  const realTest = typeof scripts.test === 'string' && !/no test specified/.test(scripts.test);
  if (!realTest) questions.push('no `test` script in package.json: the test command is empty');
  let startCommand: string[] = [];
  let usesPreview = false;
  if (typeof scripts.start === 'string') startCommand = run('start');
  else if (isVite && typeof scripts.preview === 'string') (startCommand = run('preview')), (usesPreview = true);
  else {
    const main = typeof pkg.main === 'string' ? joinRel(dir, pkg.main) : null;
    const entry = [main, ...['server.js', 'index.js', 'app.js', 'src/index.js', 'src/server.js', 'dist/index.js'].map((f) => joinRel(dir, f))].find((f) => f && ctx.has(f));
    if (entry) startCommand = ['node', posix.relative(dir || '.', entry)];
    else questions.push('no `start` script and no entry file: the start command is empty');
  }

  // Build output.
  let artifact: string | null = null;
  const tsconfig = ctx.read(joinRel(dir, 'tsconfig.json'));
  const outDir = tsconfig ? /"outDir"\s*:\s*"([^"]+)"/.exec(tsconfig)?.[1] : undefined;
  if (isNext) artifact = joinRel(dir, '.next');
  else if (isVite) artifact = joinRel(dir, 'dist');
  else if (cra) artifact = joinRel(dir, 'build');
  else if (outDir && !outDir.startsWith('..') && !outDir.startsWith('/')) artifact = joinRel(dir, outDir.replace(/^\.\//, ''));

  // Port: PORT in .env*, a flag in the start script, a literal in code, then the framework default.
  let port: number | null = null;
  const portEntry = pick(entries, 'PORT');
  if (portEntry) port = portOf(portEntry.value);
  if (!port) {
    const s = `${scripts.start ?? ''} ${scripts.preview ?? ''}`;
    const m = /(?:^|\s)(?:-p|--port)[ =]+(\d{2,5})\b|\bPORT=(\d{2,5})\b/.exec(s);
    if (m) port = Number(m[1] ?? m[2]);
  }
  if (!port) {
    for (const f of ctx.src) {
      if (f.lang !== 'node' || f.browser) continue;
      const m = /process\.env\.PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})\b|\.listen\(\s*(\d{2,5})\b/.exec(f.text);
      if (m) {
        port = Number(m[1] ?? m[2]);
        break;
      }
    }
  }
  if (!port) {
    if (isNext || cra || frameworks.includes('nuxt') || frameworks.includes('nestjs')) port = 3000;
    else if (isVite) port = usesPreview ? 4173 : 5173;
    else {
      port = 3000;
      questions.push('the app port is not stated (PORT, a --port flag, a listen call): assumed 3000');
    }
  }
  const health = healthRoute(ctx.src, 'node');
  if (health === null) questions.push(noHealthRoute('/'));

  const deps: { kind: StoreKind; where: Where }[] = [];
  for (const [kind, names] of [
    ['postgres', ['pg', 'postgres', 'pg-promise']],
    ['mysql', ['mysql2', 'mysql']],
    ['redis', ['redis', 'ioredis', '@redis/client', 'bull', 'bullmq', 'connect-redis']],
    ['mongo', ['mongoose', 'mongodb']],
  ] as [StoreKind, string[]][]) {
    const name = names.find((n) => depNames.has(n));
    if (name) deps.push({ kind, where: { file: manifest.rel, line: lineMatching(text, new RegExp(`"${escapeRe(name)}"`)) } });
  }
  for (const rel of ctx.files) {
    if (posix.basename(rel) !== 'schema.prisma' || inSkippedDir(rel)) continue;
    const t = ctx.read(rel);
    const m = t ? /provider\s*=\s*"(postgresql|mysql|mongodb)"/.exec(t) : null;
    if (m && t) {
      const kind: StoreKind = m[1] === 'postgresql' ? 'postgres' : m[1] === 'mysql' ? 'mysql' : 'mongo';
      if (!deps.some((d) => d.kind === kind)) deps.push({ kind, where: { file: rel, line: lineMatching(t, /provider\s*=/) } });
    }
  }

  const build: SandboxBuild = {
    tool,
    runtimeVersion,
    depsCommand: installLocked[tool]!,
    buildCommand: hasBuild ? run('build') : [],
    testCommand: realTest ? run('test') : [],
    startCommand,
    artifact,
  };
  return { frameworks, build, app: { port, contextPath: '/', healthPath: health ?? '/', configFiles: ctx.configFiles }, deps, questions, problems };
}

/** The question for an app with no health route to find (no actuator, no `/health` handler): the
 *  health check falls back to the root of the app, and a 404 there counts as down. */
function noHealthRoute(path: string): string {
  return `no health route found (no actuator, no /health handler): the health check requests \`${path}\`, and a 404 there counts as down; if the app answers 404 at that path, set app.healthPath to one that answers 2xx, 3xx, 401 or 403`;
}

/** A `/health`-like route written in code (`app.get('/health'`, `@app.get("/healthz")`). */
function healthRoute(src: Src[], lang: Lang): string | null {
  const re = /(?:\.(?:get|use)\(|@\w+\.get\()\s*['"](\/(?:health|healthz|ping|status)[\w/-]*)['"]/;
  for (const f of src) {
    if (f.lang !== lang || f.browser) continue;
    const m = re.exec(f.text);
    if (m) return m[1]!;
  }
  return null;
}

// --- Python ---------------------------------------------------------------------------------

function scanPython(ctx: Ctx): StackInfo {
  const { manifest, entries } = ctx;
  const questions: string[] = [];
  const dir = manifest.dir;
  const rel = (n: string) => joinRel(dir, n);

  // Dependency files: requirements*.txt (and requirements/), pyproject.toml, Pipfile.
  const depFiles = ctx.files.filter((f) => {
    if (inSkippedDir(f) || !(dir === '' || f.startsWith(`${dir}/`))) return false;
    const r = posix.relative(dir || '.', f);
    return /^requirements[\w.-]*\.txt$/.test(r) || /^requirements\/[\w.-]+\.txt$/.test(r) || r === 'pyproject.toml' || r === 'Pipfile';
  });
  const names = new Map<string, Where>(); // normalized dependency name → where
  const pyproject = ctx.read(rel('pyproject.toml')) ?? '';
  for (const f of depFiles) {
    const t = ctx.read(f);
    if (t === null) continue;
    const lines = t.split('\n');
    lines.forEach((l, i) => {
      const m = f.endsWith('.txt') ? /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l) : /^\s*["']([A-Za-z0-9][A-Za-z0-9._-]*)|^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*["'{]/.exec(l);
      const n = (m?.[1] ?? m?.[2])?.toLowerCase().replace(/_/g, '-');
      if (n && !names.has(n)) names.set(n, { file: f, line: i + 1 });
    });
  }
  const has = (...n: string[]) => n.some((x) => names.has(x));
  const frameworks: string[] = [];
  if (has('fastapi')) frameworks.push('fastapi');
  if (has('django')) frameworks.push('django');
  if (has('flask')) frameworks.push('flask');
  if (has('sqlalchemy')) frameworks.push('sqlalchemy');

  // Tool.
  let tool = 'pip';
  if (ctx.has(rel('poetry.lock')) || /\[tool\.poetry\]/.test(pyproject)) tool = 'poetry';
  else if (ctx.has(rel('uv.lock')) || /\[tool\.uv\]/.test(pyproject)) tool = 'uv';
  const prefix = tool === 'poetry' ? ['poetry', 'run'] : tool === 'uv' ? ['uv', 'run'] : [];

  // Python version.
  let runtimeVersion: string | null = null;
  const pv = ctx.read(rel('.python-version')) ?? ctx.read('.python-version');
  if (pv !== null) runtimeVersion = pythonVersion(pv);
  if (!runtimeVersion) {
    const m = /requires-python\s*=\s*["']([^"']+)["']/.exec(pyproject) ?? /^[ \t]*python[ \t]*=[ \t]*["']([^"']+)["']/m.exec(pyproject);
    if (m) runtimeVersion = pythonVersion(m[1]!);
  }
  if (!runtimeVersion) {
    const rt = ctx.read(rel('runtime.txt'));
    const m = rt ? /python-(\d+\.\d+)/.exec(rt) : null;
    if (m) runtimeVersion = m[1]!;
  }
  if (!runtimeVersion) questions.push('the Python version is not stated (requires-python, .python-version): pick one');

  const reqRel = ctx.has(rel('requirements.txt')) ? posix.relative(dir || '.', rel('requirements.txt')) : null;
  const depsCommand =
    tool === 'poetry' ? ['poetry', 'install'] : tool === 'uv' ? ['uv', 'sync'] : reqRel ? ['pip', 'install', '-r', reqRel] : ['pip', 'install', '.'];
  const testCommand = has('pytest') || ctx.files.some((f) => posix.basename(f) === 'conftest.py' || posix.basename(f) === 'pytest.ini') ? [...prefix, ...(prefix.length ? [] : ['python', '-m']), 'pytest'] : [];
  if (testCommand.length === 0) questions.push('no pytest in the dependencies: the test command is empty');

  // Start command, port and health path.
  let startCommand: string[] = [];
  let port: number | null = null;
  const portEntry = pick(entries, 'PORT');
  if (portEntry) port = portOf(portEntry.value);
  let health: string | null = healthRoute(ctx.src, 'python');
  if (frameworks.includes('fastapi')) {
    let spec: string | null = null;
    let appDirFlag: string[] = [];
    for (const f of ctx.src) {
      if (f.lang !== 'python' || (dir !== '' && !f.rel.startsWith(`${dir}/`))) continue;
      const m = /^(\w+)\s*(?::\s*[\w.\[\]]+\s*)?=\s*FastAPI\s*\(/m.exec(f.text);
      if (!m) continue;
      let mod = posix.relative(dir || '.', f.rel).replace(/\.py$/, '').replace(/\/__init__$/, '');
      if (mod.startsWith('src/')) {
        mod = mod.slice(4);
        appDirFlag = ['--app-dir', 'src'];
      }
      spec = `${mod.split('/').join('.')}:${m[1]}`;
      if (/openapi_url\s*=\s*None/.test(f.text) && !health) health = '/';
      break;
    }
    const wherePort = (() => {
      for (const n of ['Dockerfile', 'Procfile']) {
        const t = ctx.read(rel(n));
        const m = t ? /--port[ =]+(\d{2,5})/.exec(t) : null;
        if (m) return Number(m[1]);
      }
      for (const f of ctx.src) {
        if (f.lang !== 'python') continue;
        const m = /uvicorn\.run\([^)]{0,400}\bport\s*=\s*(\d{2,5})/.exec(f.text);
        if (m) return Number(m[1]);
      }
      return null;
    })();
    port ??= wherePort ?? 8000;
    if (spec) startCommand = [...prefix, 'uvicorn', spec, ...appDirFlag, '--host', '0.0.0.0', '--port', String(port)];
    else questions.push('FastAPI is a dependency but no `FastAPI(...)` app object was found: the start command is empty');
    health ??= '/openapi.json';
  } else if (frameworks.includes('django')) {
    port ??= 8000;
    if (ctx.has(rel('manage.py'))) startCommand = [...prefix, 'python', 'manage.py', 'runserver', `0.0.0.0:${port}`];
    else questions.push('Django without a manage.py at the project root: the start command is empty');
  } else {
    questions.push(frameworks.includes('flask') ? 'Flask app: the start command and port are not detected' : 'no web framework found: the start command is empty');
    port ??= frameworks.includes('flask') ? 5000 : 8000;
  }

  const deps: { kind: StoreKind; where: Where }[] = [];
  for (const [kind, n] of [
    ['postgres', ['psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'pg8000']],
    ['mysql', ['pymysql', 'mysqlclient', 'aiomysql', 'mysql-connector-python', 'asyncmy']],
    ['redis', ['redis', 'aioredis']],
    ['mongo', ['pymongo', 'motor', 'beanie', 'mongoengine']],
  ] as [StoreKind, string[]][]) {
    const name = n.find((x) => names.has(x));
    if (name) deps.push({ kind, where: names.get(name)! });
  }
  const build: SandboxBuild = { tool, runtimeVersion, depsCommand, buildCommand: [], testCommand, startCommand, artifact: null };
  if (health === null) questions.push(noHealthRoute('/'));
  return { frameworks, build, app: { port, contextPath: '/', healthPath: health ?? '/', configFiles: ctx.configFiles }, deps, questions, problems: [] };
}

// --- Config files ---------------------------------------------------------------------------

const SPRING_CONFIG = /(?:^|\/)(?:application|bootstrap)(?:-[A-Za-z0-9_.-]+)?\.(?:ya?ml|properties)$/;
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/;

/** The config files of a stack's app: `main` are the ones the app loads (listed in
 *  `app.configFiles`), `extra` are read for hosts and stores only. */
function configFileList(stack: SandboxStack, appDir: string, files: string[]): { main: string[]; extra: string[] } {
  const inApp = (f: string) => appDir === '' || f.startsWith(`${appDir}/`);
  const main: string[] = [];
  const extra: string[] = [];
  for (const f of files) {
    if (!inApp(f) || !ownFile(f)) continue;
    const base = posix.basename(f);
    const ext = extOf(f);
    if (stack === 'jvm') {
      if (SPRING_CONFIG.test(f)) main.push(f);
      else if ((ext === 'properties' || ext === 'yml' || ext === 'yaml') && /(?:^|\/)src\/main\/resources\//.test(f) && !/\/(?:static|templates|META-INF)\//.test(f) && !/^(?:messages|ValidationMessages|logback|log4j)/i.test(base) && !/_[a-z]{2}(?:_[A-Z]{2})?\.properties$/.test(base)) extra.push(f);
    } else if (ENV_FILE.test(base)) {
      main.push(f);
    } else if (stack === 'node' && ext === 'json' && /(?:^|\/)config(?:\/[\w.-]+)?\.json$/.test(f)) {
      main.push(f);
    } else if ((ext === 'yml' || ext === 'yaml') && /^(?:config|settings|default|production|development)(?:\.[\w-]+)?\.ya?ml$/.test(base) && !/compose/.test(base)) {
      main.push(f);
    } else if (stack === 'python' && base === 'alembic.ini') {
      main.push(f);
    }
  }
  return { main, extra };
}

function profileOf(rel: string): string | null {
  const base = posix.basename(rel);
  const m = /^(?:application|bootstrap)-(.+?)\.(?:ya?ml|properties)$/.exec(base) ?? /^\.env\.(.+)$/.exec(base);
  return m ? m[1]! : null;
}

// --- Compose versions -----------------------------------------------------------------------

const IMAGE_KIND: [RegExp, StoreKind][] = [
  [/^(?:postgres|postgresql|postgis|pgvector)$/, 'postgres'],
  [/^mysql$/, 'mysql'],
  [/^mariadb$/, 'mariadb'],
  [/^(?:redis|redis-stack|redis-stack-server|valkey)$/, 'redis'],
  [/^(?:mongo|mongodb)$/, 'mongo'],
];

/** Image tags the repo's compose files already run, per store kind. `latest`, a missing tag and a
 *  variable tag are no version. */
function composeVersions(root: string, files: string[]): Map<StoreKind, string> {
  const out = new Map<StoreKind, string>();
  const composes = files.filter((f) => /^(?:docker-)?compose[\w.-]*\.ya?ml$/.test(posix.basename(f)) && !inSkippedDir(f)).sort((a, b) => depthOf(dirOf(a)) - depthOf(dirOf(b)) || (a < b ? -1 : 1));
  for (const f of composes) {
    const t = readText(root, f, MAX_CONFIG_BYTES);
    if (t === null) continue;
    for (const line of t.split('\n')) {
      const m = /^\s*(?:-\s*)?image:\s*["']?([^\s"'#]+)/.exec(line);
      if (!m) continue;
      const ref = m[1]!;
      const name = posix.basename(ref.split(':')[0]!);
      const tag = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : '';
      const kind = IMAGE_KIND.find(([re]) => re.test(name))?.[1];
      if (kind && tag !== '' && tag !== 'latest' && !tag.includes('$') && !out.has(kind)) out.set(kind, tag);
    }
  }
  return out;
}

// --- The scan -------------------------------------------------------------------------------

export interface ScanOptions {
  /** Wall time for the scan (default 60 s); past it the rest is left out and a question says so. */
  budgetMs?: number;
  /** The project's files when the caller has listed them already (no second `git ls-files`). */
  files?: string[];
  /** `false`: read the build and config files only (stack, port, context path, stores), not the
   *  source files, so no outbound hosts. The UI inventory asks for the context path this way. */
  sources?: boolean;
  /** Test seam: the config parser (default `parseConfig`). The parsers never throw on any input tried, so
   *  only a replaced one reaches the guard that turns a throw into a question. */
  parseConfig?: (rel: string, text: string) => Parsed;
}

/** Scan a project root for the test sandbox. Read-only: it runs no project tool and writes
 *  nothing. A scan with `problems` is not usable; `questions` need the user's answers. */
export function scanSandbox(root: string, opts: ScanOptions = {}): SandboxScan {
  const deadline = Date.now() + (opts.budgetMs ?? SCAN_BUDGET_MS);
  const listed = opts.files ?? listFiles(root);
  if (listed === null) return problemScan(root, ['git cannot list the files (not a git repository, or git is missing)']);
  const questions: string[] = [];
  const problems: string[] = [];
  let files = listed.filter((f) => !inSkippedDir(f));
  if (files.length > MAX_FILES) {
    questions.push(`${files.length} files; only the first ${MAX_FILES} were scanned`);
    files = files.slice(0, MAX_FILES);
  }
  const fileSet = new Set(files);
  // A small read cache: a build file is read for the stack, again for its module, again for the
  //   dependency rules (a pyproject twice, every pom once per module). Big texts are not kept.
  const readCache = new Map<string, string | null>();
  const read = (rel: string): string | null => {
    if (readCache.has(rel)) return readCache.get(rel)!;
    const t = readText(root, rel, MAX_CONFIG_BYTES);
    if (t === null || t.length <= 200_000) {
      if (readCache.size >= 64) readCache.delete(readCache.keys().next().value!);
      readCache.set(rel, t);
    }
    return t;
  };
  const has = (rel: string) => fileSet.has(rel);

  // 1. The stack: the shallowest build file, a Spring Boot build first among Java ones.
  const manifests: Manifest[] = [];
  for (const rel of files) {
    if (!ownFile(rel)) continue;
    const base = posix.basename(rel);
    let stack: SandboxStack | null = null;
    let dir = dirOf(rel);
    if (/^(?:build\.gradle(?:\.kts)?|pom\.xml)$/.test(base)) stack = 'jvm';
    else if (base === 'package.json') stack = 'node';
    else if (/^(?:pyproject\.toml|requirements[\w.-]*\.txt|Pipfile|setup\.py)$/.test(base)) stack = 'python';
    if (!stack && /(?:^|\/)requirements\/[\w.-]+\.txt$/.test(rel)) {
      stack = 'python';
      dir = dirOf(dir);
    }
    if (!stack) continue;
    const text = stack === 'jvm' ? (read(rel) ?? '') : '';
    manifests.push({ stack, rel, dir, depth: depthOf(dir), boot: /spring-boot/.test(text) });
  }
  const best = new Map<SandboxStack, Manifest>();
  for (const m of manifests) {
    const cur = best.get(m.stack);
    const better = !cur || (m.stack === 'jvm' && m.boot !== cur.boot ? m.boot : m.depth < cur.depth);
    if (better) best.set(m.stack, m);
  }
  const chosen = [...best.values()].sort((a, b) => a.depth - b.depth || STACK_ORDER.indexOf(a.stack) - STACK_ORDER.indexOf(b.stack))[0];
  if (!chosen) {
    const other = files.map((f) => UNSUPPORTED_MANIFESTS.find(([re]) => re.test(posix.basename(f)))?.[1]).find((x) => x);
    return {
      ...problemScan(root, [other ? `unsupported stack: ${other} (the sandbox supports JVM, Node and Python)` : 'no build tool found (build.gradle, pom.xml, package.json, pyproject.toml, requirements.txt)']),
      questions,
    };
  }
  const stack = chosen.stack;
  const others = [...best.values()].filter((m) => m.stack !== stack);
  if (others.length > 0) questions.push(`several stacks in the repo: scanned ${stack} at \`${chosen.dir || '.'}\`; also found ${others.map((m) => `${m.stack} at \`${m.dir || '.'}\``).join(', ')}`);
  if (chosen.dir !== '' && stack !== 'jvm') questions.push(`the ${stack} app is in \`${chosen.dir}\`, not the repo root: run its commands from there`);

  // 2. Config entries (all profiles; a file that does not parse cleanly is a question).
  const { main, extra } = configFileList(stack, chosen.dir, files);
  const entries: Entry[] = [];
  for (const [list, isExtra] of [[main, false], [extra, true]] as const) {
    for (const rel of list) {
      const text = read(rel);
      if (text === null) {
        questions.push(`${rel} could not be read (over ${MAX_CONFIG_BYTES} bytes or not a regular file): its hosts and stores are unknown`);
        continue;
      }
      let parsed: Parsed;
      try {
        parsed = (opts.parseConfig ?? parseConfig)(rel, text);
      } catch {
        questions.push(`${rel} could not be parsed: its hosts and stores are unknown`);
        continue;
      }
      if (parsed.bad > 0) questions.push(`${rel}: ${parsed.bad} line(s) could not be parsed; values from it may be missing`);
      for (const e of parsed.entries) entries.push({ key: e.key, value: e.value, where: { file: rel, line: e.line }, profile: profileOf(rel), extra: isExtra });
    }
  }
  // Base files before profile files, so the first entry of a key is the one that applies first.
  entries.sort((a, b) => Number(a.extra) - Number(b.extra) || Number(a.profile !== null) - Number(b.profile !== null));

  // 3. Source files.
  const src: Src[] = [];
  let total = 0;
  let skippedSrc = 0;
  for (const rel of opts.sources === false ? [] : files) {
    if (!ownFile(rel)) continue;
    const ext = extOf(rel);
    const lang = LANG_EXT[ext] ?? null;
    if (!lang && !(TEMPLATE_EXT.has(ext) && posix.basename(rel) !== 'pom.xml')) continue;
    if (total > MAX_SRC_TOTAL || Date.now() > deadline) {
      skippedSrc++;
      continue;
    }
    const text = readText(root, rel, MAX_SRC_BYTES);
    if (text === null) {
      skippedSrc++;
      continue;
    }
    total += text.length;
    src.push({ rel, ext, lang, browser: lang === null || isBrowserAsset(rel), text, lines: text.split('\n') });
  }
  if (skippedSrc > 0) questions.push(`${skippedSrc} source file(s) were not read (over ${MAX_SRC_BYTES} bytes, not regular files, or past the total cap or the time budget): outbound calls in them are unknown`);

  // 4. The stack's build, port and store drivers.
  const ctx: Ctx = { root, files, manifest: chosen, entries, configFiles: main, src, read, has };
  const info = stack === 'jvm' ? scanJvm(ctx) : stack === 'node' ? scanNode(ctx) : scanPython(ctx);
  questions.push(...info.questions);
  problems.push(...info.problems);

  // 5. Stores: from URLs and from key prefixes that name a store, then from the drivers.
  const groups = new Map<string, StoreGroup>();
  for (const e of entries) {
    const { prefix, name } = keyParts(e.key);
    let kind: StoreKind | null = null;
    let url: StoreUrl | null = null;
    if (!isSecretKey(e.key)) {
      const s = storeUrl(resolveDefaults(e.value));
      if (typeof s === 'string') {
        problems.push(`unsupported store: jdbc:${s.slice('unsupported:'.length)} at ${e.where.file}:${e.where.line}; the sandbox has no image for it`);
        continue;
      }
      if (s) {
        kind = s.kind;
        url = s;
      }
    }
    if (!kind && STORE_CREATE_NAMES.has(name) && !isSecretKey(e.key)) kind = wordKind(prefix);
    if (!kind) continue;
    const id = `${kind}|${normKey(prefix)}`;
    const g = groups.get(id) ?? { kind, prefix: normKey(prefix), where: e.where, database: null, keys: new Set<string>() };
    if (!groups.has(id)) groups.set(id, g);
    if (g.database === null && url?.database) g.database = url.database;
  }
  // The groups by normalized prefix: each entry looked at every group.
  const groupsByPrefix = new Map<string, StoreGroup[]>();
  for (const g of groups.values()) {
    const list = groupsByPrefix.get(g.prefix);
    if (list) list.push(g);
    else groupsByPrefix.set(g.prefix, [g]);
  }
  for (const e of entries) {
    const { prefix, name } = keyParts(e.key);
    if (!STORE_KEY_NAMES.has(name)) continue;
    for (const g of groupsByPrefix.get(normKey(prefix)) ?? []) {
      g.keys.add(e.key);
      if (g.database === null && g.kind !== 'redis' && (name === 'database' || name === 'dbname') && /^[\w.-]+$/.test(e.value) && !isSecretKey(e.key)) g.database = e.value;
    }
  }
  const versions = composeVersions(root, files);
  const versionAsked = new Set<StoreKind>();
  const versionOf = (kind: StoreKind): string => {
    const v = versions.get(kind);
    if (v) return v;
    if (!versionAsked.has(kind)) {
      versionAsked.add(kind);
      questions.push(`${kind}: no version found in a compose file; the pinned default ${DEFAULT_VERSION[kind]} is used: confirm it matches production`);
    }
    return DEFAULT_VERSION[kind];
  };
  const stores: SandboxStore[] = [...groups.values()].map((g) => ({
    kind: g.kind,
    version: versionOf(g.kind),
    database: g.database,
    configKeys: [...g.keys].sort(),
    where: g.where,
  }));
  for (const kind of new Set(stores.map((s) => s.kind))) {
    const same = stores.filter((s) => s.kind === kind);
    if (same.length > 1) questions.push(`several ${kind} stores configured (${same.map((s) => `${s.where.file}:${s.where.line}`).join(', ')}): say which the sandbox restores and which are empty`);
  }
  for (const d of info.deps) {
    if (stores.some((s) => s.kind === d.kind)) continue;
    stores.push({ kind: d.kind, version: versionOf(d.kind), database: null, configKeys: [], where: d.where });
    questions.push(`${d.kind}: a driver or client is a dependency (${d.where.file}:${d.where.line}) but no connection config was found: its address and database name are unknown`);
  }
  stores.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.where.file < b.where.file ? -1 : a.where.line - b.where.line));

  // 6. Outbound hosts.
  const outbound = opts.sources === false ? [] : outboundHosts(src, entries, questions, deadline);

  // 7. Secret keys: names only.
  const secretKeys = [...new Set(entries.map((e) => e.key).filter(isSecretKey))].sort();
  if (secretKeys.length > MAX_SECRET_KEYS) {
    questions.push(`${secretKeys.length} secret-looking keys; only the first ${MAX_SECRET_KEYS} are listed`);
    secretKeys.length = MAX_SECRET_KEYS;
  }

  return {
    root,
    stack,
    frameworks: info.frameworks,
    build: info.build,
    app: info.app,
    stores,
    outbound,
    secretKeys,
    questions: [...new Set(questions)],
    problems: [...new Set(problems)],
  };
}

/** The outbound hosts: URLs and host keys in config, URL literals and IP literals in code. A host
 *  gets a call site when code that reads it (or the code it is written in) calls out. */
function outboundHosts(src: Src[], entries: Entry[], questions: string[], deadline: number): SandboxOutbound[] {
  const code = src.filter((f) => f.lang !== null && !f.browser);
  const srcByRel = new Map(src.map((f) => [f.rel, f]));
  // The port key next to a host key (same prefix), first entry wins.
  const portOfPrefix = new Map<string, Entry>();
  for (const x of entries) {
    const kp = keyParts(x.key);
    if (kp.name === 'port' && !portOfPrefix.has(kp.prefix)) portOfPrefix.set(kp.prefix, x);
  }
  let timedOut = false;
  const late = () => {
    if (!timedOut && Date.now() > deadline) timedOut = true;
    return timedOut;
  };

  // Call sites, found per file and kind, first non-comment non-import match.
  const callCache = new Map<string, Where | null>();
  const callIn = (f: Src, kind: OutboundKind): Where | null => {
    if (!f.lang || f.browser) return null;
    const key = `${f.rel}|${kind}`;
    if (callCache.has(key)) return callCache.get(key)!;
    const res = CALL_KINDS.filter((k) => kind === 'other' || k === kind).map((k) => CALLS[f.lang!][k]);
    let hit: Where | null = null;
    for (let i = 0; i < f.lines.length && !hit; i++) {
      const line = f.lines[i]!;
      const t = line.trim();
      if (t === '' || isCommentLine(t, f.ext) || IMPORT_LINE.test(line)) continue;
      if (res.some((re) => re.test(line))) hit = { file: f.rel, line: i + 1 };
    }
    callCache.set(key, hit);
    return hit;
  };
  const anyCall = (kind: OutboundKind): Where | null => {
    for (const f of code) {
      const c = callIn(f, kind);
      if (c) return c;
    }
    return null;
  };

  const cands: Cand[] = [];
  const cap = () => cands.length >= MAX_OUTBOUND * 4;

  // Config: URLs in values, and host keys.
  for (const e of entries) {
    if (cap()) break;
    if (isSecretKey(e.key) || e.value === '') continue;
    const v = resolveDefaults(e.value);
    if (storeUrl(v) !== null && !/\b(?:https?|ldaps?|smtps?):\/\//i.test(v)) continue;
    const { prefix, name } = keyParts(e.key);
    const base = { where: e.where, hardcoded: false, file: null, name: null, key: e.key };
    const urls = urlsIn(v, false);
    for (const u of urls) cands.push({ ...base, host: u.host, port: u.port, scheme: u.scheme, kind: u.kind, ipLiteral: u.ipLiteral });
    if (urls.length > 0 || !HOST_KEY_NAME.has(name) || STORE_PREFIX.test(prefix) || /^(?:server|management)(?:\.|$)/i.test(prefix)) continue;
    const kind: OutboundKind = /mail|smtp/i.test(prefix) ? 'smtp' : /ldap/i.test(prefix) ? 'ldap' : /api|url|http|rest|service|endpoint|client/i.test(prefix) ? 'http' : 'other';
    const sibling = portOfPrefix.get(prefix);
    for (const part of v.split(',')) {
      const m = /^\s*([A-Za-z0-9.:-]+?)(?::(\d{1,5}))?\s*$/.exec(part);
      if (!m) continue;
      const host = m[1]!;
      // A single word is a host only for mail and LDAP keys; elsewhere it is a service alias.
      if (!host.includes('.') && !host.includes(':') && kind !== 'smtp' && kind !== 'ldap') continue;
      const ref = hostRef(host);
      if (!ref) continue;
      const port = m[2] ? Number(m[2]) : sibling ? portOf(sibling.value) : null;
      cands.push({ ...base, host: ref.host, port, scheme: null, kind, ipLiteral: ref.ipLiteral });
    }
  }

  // Code and templates: URL literals, IP literals and host names in host-like calls.
  for (const f of src) {
    if (cap() || late()) break;
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i]!;
      const t = line.trim();
      if (t === '' || isCommentLine(t, f.ext) || XML_CONTEXT.test(line)) continue;
      const where = { file: f.rel, line: i + 1 };
      const name = CONST_ASSIGN.exec(line)?.[1];
      const constName = name && /^[A-Z][A-Z0-9_]{2,}$/.test(name) ? name : null;
      const base = { where, hardcoded: true, file: f.rel, name: constName, key: null };
      const browserish = f.browser || f.ext === 'jsx' || f.ext === 'tsx' || f.ext === 'vue';
      for (const u of urlsIn(line, browserish)) cands.push({ ...base, host: u.host, port: u.port, scheme: u.scheme, kind: u.kind, ipLiteral: u.ipLiteral });
      if (f.lang === null) continue;
      for (const s of stringLiterals(line)) {
        if (s.length > 260 || s.includes('://')) continue;
        let hostStr = s;
        let port: number | null = null;
        const hp = isIpv6(s) ? null : /^([^:\s]+):(\d{1,5})$/.exec(s);
        if (hp) {
          hostStr = hp[1]!;
          port = Number(hp[2]);
        }
        const ref = hostRef(hostStr);
        if (!ref) continue;
        // An IP literal is a host wherever it stands; a name only on a line that talks about hosts.
        const bareName = FQDN.test(ref.host) && HOST_TLD.has(ref.host.slice(ref.host.lastIndexOf('.') + 1)) && HOST_CONTEXT.test(line);
        if (!ref.ipLiteral && !bareName) continue;
        cands.push({ ...base, host: ref.host, port, scheme: null, kind: literalKind(f, line), ipLiteral: ref.ipLiteral });
      }
    }
  }

  // Which code reads a config key (JVM: `${key}` placeholders and @ConfigurationProperties
  // prefixes; Node and Python: the key's name in a file).
  const phIndex = new Map<Src, { keys: Set<string>; prefixes: string[] }>();
  const placeholders = (f: Src) => {
    let r = phIndex.get(f);
    if (!r) {
      r = { keys: new Set<string>(), prefixes: [] };
      for (const m of f.text.matchAll(/\$\{\s*([\w.[\]-]+)/g)) r.keys.add(normKey(m[1]!));
      for (const m of f.text.matchAll(/ConfigurationProperties\s*\(\s*(?:(?:prefix|value)\s*=\s*)?["']([\w.-]+)["']/g)) r.prefixes.push(normKey(m[1]!));
      for (const m of f.text.matchAll(/getProperty\(\s*["']([\w.-]+)["']/g)) r.keys.add(normKey(m[1]!));
      phIndex.set(f, r);
    }
    return r;
  };
  // Does the file name this word? Asked for every host key and every constant, against every file:
  //   a file's words are listed once (lower-cased, the runs of `[\w$]`), then each question is a
  //   set lookup. For a name made of `[\w$]` only, "the word occurs with a non-word character
  //   on each side" is exactly "the name is one of those runs". A name with other characters
  //   (`base-url`) is searched for in the lower-cased text, which is kept per file too.
  const wordSets = new Map<Src, Set<string>>();
  const wordsOf = (f: Src): Set<string> => {
    let s = wordSets.get(f);
    if (!s) wordSets.set(f, (s = new Set(f.text.toLowerCase().split(/[^\w$]+/))));
    return s;
  };
  const lowerOf = new Map<Src, string>();
  const lower = (f: Src): string => {
    let t = lowerOf.get(f);
    if (t === undefined) lowerOf.set(f, (t = f.text.toLowerCase()));
    return t;
  };
  // The same words with their case, for the questions that must match the case exactly (a
  //   constant's name): a regex over the file per constant made a file with many constants quadratic.
  const exactWordSets = new Map<Src, Set<string>>();
  const exactWordsOf = (f: Src): Set<string> => {
    let s = exactWordSets.get(f);
    if (!s) exactWordSets.set(f, (s = new Set(f.text.split(/[^\w$]+/))));
    return s;
  };
  const SIMPLE_NAME = /^[\w$]+$/;
  /** The files that name `name` as a word; case-insensitive, or with the exact case (`exact`). */
  const filesNaming = (name: string, exact: boolean, among: Src[]): Src[] => {
    const simple = SIMPLE_NAME.test(name);
    if (simple && exact) return among.filter((f) => exactWordsOf(f).has(name));
    const lowerName = name.toLowerCase();
    if (simple) return among.filter((f) => wordsOf(f).has(lowerName));
    const re = wordRe(name, exact ? '' : 'i');
    return among.filter((f) => lower(f).includes(lowerName) && re.test(f.text));
  };
  const readerCache = new Map<string, Src[]>();
  const readersOf = (key: string): Src[] => {
    const cached = readerCache.get(key);
    if (cached) return cached;
    const nk = normKey(key);
    const name = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
    const named = new Set(filesNaming(name, false, code.filter((f) => f.lang !== 'jvm')));
    const out = code.filter((f) => {
      if (f.lang !== 'jvm') return named.has(f);
      const ph = placeholders(f);
      return ph.keys.has(nk) || ph.prefixes.some((p) => nk.startsWith(`${p}.`));
    });
    readerCache.set(key, out);
    return out;
  };
  const springAuto = (c: Cand) => {
    if (!c.key) return false;
    return (c.kind === 'smtp' && /^spring\.mail(?:\.|$)/i.test(c.key)) || (c.kind === 'ldap' && /^spring\.ldap(?:\.|$)/i.test(c.key));
  };
  const usersCache = new Map<string, Src[]>();
  const nameUsers = (nm: string, except: string | null, kind: OutboundKind): Where | null => {
    let users = usersCache.get(nm);
    if (!users) {
      users = filesNaming(nm, true, code);
      usersCache.set(nm, users);
    }
    for (const f of users) {
      if (f.rel === except) continue;
      const c = callIn(f, kind);
      if (c) return c;
    }
    return null;
  };
  const callSiteOf = (c: Cand): Where | null => {
    if (c.file !== null) {
      const own = callIn(srcByRel.get(c.file)!, c.kind);
      return own ?? (c.name ? nameUsers(c.name, c.file, c.kind) : null);
    }
    if (springAuto(c)) return anyCall(c.kind);
    const readers = readersOf(c.key!);
    for (const r of readers) {
      const call = callIn(r, c.kind);
      if (call) return call;
    }
    // A properties class (`@ConfigurationProperties`) is used by another class that calls out.
    for (const r of readers) {
      if (r.lang !== 'jvm') continue;
      const cls = posix.basename(r.rel).replace(/\.[^.]+$/, '');
      const call = nameUsers(cls, r.rel, c.kind);
      if (call) return call;
    }
    return null;
  };

  // One entry per host, port, kind and written-in-code flag; a call site wins over none.
  const merged = new Map<string, SandboxOutbound>();
  for (const c of cands) {
    const id = `${c.host}|${c.port ?? ''}|${c.kind}|${c.hardcoded}`;
    const prev = merged.get(id);
    if (prev && prev.callSite) continue;
    // Out of time: the host stays, with no call site (the safe side: it gets a dummy anyway).
    const callSite = late() ? null : callSiteOf(c);
    if (prev && !callSite) continue;
    merged.set(id, {
      host: c.host,
      port: c.port ?? prev?.port ?? null,
      scheme: c.scheme ?? prev?.scheme ?? null,
      kind: c.kind,
      where: prev?.where ?? c.where,
      callSite,
      hardcoded: c.hardcoded,
      ipLiteral: c.ipLiteral,
    });
  }
  let out = [...merged.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : (a.port ?? 0) - (b.port ?? 0)));
  if (out.length > MAX_OUTBOUND) {
    questions.push(`${out.length} outbound hosts; only the first ${MAX_OUTBOUND} are listed`);
    out = out.slice(0, MAX_OUTBOUND);
  }
  if (timedOut) questions.push('the scan ran out of its time budget: outbound hosts and call sites after that point are missing or unproven; review the list by hand');
  for (const o of out) {
    if (o.kind === 'other' && o.callSite) questions.push(`outbound ${o.host}${o.port ? `:${o.port}` : ''} (${o.where.file}:${o.where.line}) speaks a protocol with no dummy: it is reported, not stubbed`);
  }
  return out;
}

/** The last name of a key that holds a host or a list of hosts. */
const HOST_KEY_NAME = new Set(['host', 'hostname', 'server', 'servers', 'hosts', 'bootstrapservers', 'brokers', 'nodes']);

/** The kind a bare host literal has: from the words on its line, else from the one kind of
 *  call its file makes, else `other`. */
function literalKind(f: Src, line: string): OutboundKind {
  if (/smtp|mail/i.test(line)) return 'smtp';
  if (/ldap/i.test(line)) return 'ldap';
  if (!f.lang) return 'other';
  let kinds = FILE_CALL_KINDS.get(f);
  if (!kinds) FILE_CALL_KINDS.set(f, (kinds = CALL_KINDS.filter((k) => CALLS[f.lang!][k].test(f.text))));
  return kinds.length === 1 ? kinds[0]! : 'other';
}

/** The kinds of call a file makes, per file: asked for every host literal in it, and a regex
 *  pass over the whole text each time made a file with many literals quadratic. */
const FILE_CALL_KINDS = new WeakMap<Src, CallKind[]>();
