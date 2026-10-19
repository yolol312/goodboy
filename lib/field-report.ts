// Field reports (track J1, #8): trouble with goodboy found while using it in another project,
// written as one English report to a durable local inbox (~/.claude/goodboy/inbox/), never a
// temp dir or the versioned plugin cache. goodboy attaches the session's evidence itself
// (versions, gate-log counts, retry counters), so the report does not rest on the model's
// memory. The report keeps project details locally; its public summary is checked for paths,
// names, hosts and secrets before it may go to a public issue, and only after the user
// confirms it (the report-goodboy skill).

import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { type GateDecision, type GateEvent, readGateLog } from './gate-log';
import { readRegular } from './safe-read';

/** Where field reports go as issues: this plugin's repo. */
export const REPORT_REPO = 'yolol312/goodboy';
/** The issue title marker: a non-collaborator cannot set labels, the issue form can. */
export const REPORT_TITLE_TAG = '[field-report]';

export interface FieldReportInput {
  title: string;
  observed: string;
  expected: string;
  /** The user's own words about it, quoted as they wrote them (may be empty). */
  user_words: string[];
  /** The commands or files involved. */
  involved: string[];
  suspected_causes: string[];
  proposed_change: string;
  /** What is not known yet. */
  unknowns: string[];
  public_summary: { title: string; body: string };
}

export interface Evidence {
  goodboy_version: string | null;
  claude_code_version: string | null;
  /** The session's tag (the first 8 characters of its id), or null when none was found. */
  session: string | null;
  /** Gate → decision → count, from the session's gate log. */
  gate_counts: Record<string, Partial<Record<GateDecision, number>>>;
  /** The Stop gates' retry counters (file name without `.goodboy-` and `.txt`). */
  retries: Record<string, number>;
  /** The first and the last gate-log time. */
  span: { first: string; last: string } | null;
  /** The last gate-log lines, kept in the local report only. */
  recent: GateEvent[];
}

const RECENT_LINES = 30;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GATE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** The inbox (GOODBOY_INBOX_DIR for tests, default ~/.claude/goodboy/inbox, next to the logs). */
export function inboxDir(env: NodeJS.ProcessEnv = process.env): string {
  const o = (env.GOODBOY_INBOX_DIR ?? '').trim();
  return o !== '' ? resolve(o) : join((env.HOME ?? '').trim() || homedir(), '.claude', 'goodboy', 'inbox');
}

// ---- the template ----

const LIMITS = { title: 120, text: 4000, item: 1000, items: 20, body: 6000 } as const;
const KEYS = ['title', 'observed', 'expected', 'user_words', 'involved', 'suspected_causes', 'proposed_change', 'unknowns', 'public_summary'];

/** The report as the template asks for it, or what is missing or too long. */
export function validateFieldReport(raw: unknown): { ok: boolean; errors: string[]; value?: FieldReportInput } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['the report must be a JSON object'] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) errors.push(`unknown field "${k}" (the template has: ${KEYS.join(', ')})`);
  const text = (k: string, max: number): string => {
    const v = o[k];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`"${k}" must be a non-empty string`);
    else if (v.length > max) errors.push(`"${k}" is longer than ${max} characters`);
    return typeof v === 'string' ? v.trim() : '';
  };
  const list = (k: string, needOne: boolean): string[] => {
    const v = o[k];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
      errors.push(`"${k}" must be an array of non-empty strings`);
      return [];
    }
    if (needOne && v.length === 0) errors.push(`"${k}" needs at least one entry`);
    if (v.length > LIMITS.items) errors.push(`"${k}" has more than ${LIMITS.items} entries`);
    if (v.some((x) => (x as string).length > LIMITS.item)) errors.push(`an entry of "${k}" is longer than ${LIMITS.item} characters`);
    return (v as string[]).map((x) => x.trim());
  };
  const value: FieldReportInput = {
    title: text('title', LIMITS.title),
    observed: text('observed', LIMITS.text),
    expected: text('expected', LIMITS.text),
    user_words: list('user_words', false),
    involved: list('involved', true),
    suspected_causes: list('suspected_causes', true),
    proposed_change: text('proposed_change', LIMITS.text),
    unknowns: list('unknowns', false),
    public_summary: { title: '', body: '' },
  };
  const ps = o.public_summary;
  if (typeof ps !== 'object' || ps === null || Array.isArray(ps)) errors.push('"public_summary" must be {"title": "...", "body": "..."}');
  else {
    const p = ps as Record<string, unknown>;
    const t = typeof p.title === 'string' ? p.title.trim() : '';
    const b = typeof p.body === 'string' ? p.body.trim() : '';
    if (t === '' || t.length > LIMITS.title) errors.push(`"public_summary.title" must be 1–${LIMITS.title} characters`);
    // It goes into a `gh issue create --title "…"` command line.
    if (/["`$\\\n\r]/.test(t)) errors.push('"public_summary.title" must not hold quotes, backticks, $, backslashes or line breaks');
    if (b === '' || b.length > LIMITS.body) errors.push(`"public_summary.body" must be 1–${LIMITS.body} characters`);
    value.public_summary = { title: t, body: b };
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], value };
}

// ---- the session's evidence ----

/** The session to report on: `want` (a session id, or the 8-character tag goodboy prints), else
 *  the one this command runs in (CLAUDE_CODE_SESSION_ID, which Claude Code sets for its Bash
 *  calls), else the newest transcript of `cwd` and its parents in Claude Code's projects dir
 *  (J1 review: the first dir with any transcript could hold an old session; another terminal
 *  in the same dir may still be newer, so `--session` is the sure way). */
export function findSession(cwd: string, want: string | undefined, env: NodeJS.ProcessEnv = process.env): { id: string; transcript: string | null } | null {
  const projects = join((env.CLAUDE_CONFIG_DIR ?? '').trim() || join(homedir(), '.claude'), 'projects');
  const own = (env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  const pick = want ?? (SESSION_ID.test(own) ? own : undefined);
  const all: { id: string; path: string; mtime: number }[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    all.push(...transcriptsIn(join(projects, dir.replace(/[^a-zA-Z0-9]/g, '-'))));
    if (dirname(dir) === dir) break;
  }
  all.sort((a, b) => b.mtime - a.mtime);
  const hit = pick ? all.find((t) => t.id === pick || t.id.startsWith(pick)) : all[0];
  if (hit) return { id: hit.id, transcript: hit.path };
  return pick && SESSION_ID.test(pick) ? { id: pick, transcript: null } : null;
}

/** The transcripts in a projects dir, newest first. */
function transcriptsIn(dir: string): { id: string; path: string; mtime: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { id: string; path: string; mtime: number }[] = [];
  for (const n of names) {
    const id = n.endsWith('.jsonl') ? n.slice(0, -6) : '';
    if (!SESSION_ID.test(id)) continue;
    try {
      const st = lstatSync(join(dir, n));
      if (st.isFile()) out.push({ id, path: join(dir, n), mtime: st.mtimeMs });
    } catch {
      // gone meanwhile
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** The Claude Code version the transcript's last entries name (read from its last 512 KB). */
export function claudeCodeVersion(transcript: string | null): string | null {
  if (transcript === null) return null;
  let fd: number;
  try {
    fd = openSync(transcript, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, st.size - len);
    const all = [...buf.subarray(0, got).toString('utf8').matchAll(/"version":"(\d+\.\d+\.\d+[\w.-]{0,20})"/g)];
    return all.length > 0 ? all[all.length - 1]![1]! : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** goodboy's version from its plugin manifest. */
export function goodboyVersion(root: string): string | null {
  const r = readRegular(join(root, '.claude-plugin', 'plugin.json'), 64 * 1024, true);
  if (typeof r !== 'object') return null;
  try {
    const v = (JSON.parse(r.text) as { version?: unknown }).version;
    return typeof v === 'string' && /^[\w.+-]{1,40}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** What goodboy itself recorded about the session. */
export function collectEvidence(session: { id: string; transcript: string | null } | null, root: string): Evidence {
  const ev: Evidence = {
    goodboy_version: goodboyVersion(root),
    claude_code_version: claudeCodeVersion(session?.transcript ?? null),
    session: session ? session.id.slice(0, 8) : null,
    gate_counts: {},
    retries: {},
    span: null,
    recent: [],
  };
  if (!session) return ev;
  const log = readGateLog(session.id).filter((e) => typeof e.ts === 'string' && typeof e.gate === 'string' && GATE_NAME.test(e.gate));
  // A Map, so a gate named `constructor` is counted, never read off Object's prototype.
  const counts = new Map<string, Partial<Record<GateDecision, number>>>();
  for (const e of log) {
    const g = counts.get(e.gate) ?? {};
    g[e.decision] = (g[e.decision] ?? 0) + 1;
    counts.set(e.gate, g);
  }
  ev.gate_counts = Object.fromEntries(counts);
  if (log.length > 0) ev.span = { first: log[0]!.ts, last: log[log.length - 1]!.ts };
  ev.recent = log.slice(-RECENT_LINES);
  const dir = ensureSessionDir(session.id);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // no session dir
  }
  for (const n of names) {
    const m = n.match(/^\.goodboy-([a-z-]*count)\.txt$/);
    const r = m ? readRegular(join(dir, n), 64, true) : 'absent';
    if (m && typeof r === 'object' && /^\d{1,6}\s*$/.test(r.text)) ev.retries[m[1]!] = Number.parseInt(r.text, 10);
  }
  return ev;
}

// ---- the public summary ----

/** The public summary as it goes into the issue, with goodboy's own numbers (versions, gate
 *  counts: goodboy's names only). */
export function renderPublic(input: FieldReportInput, ev: Evidence): string {
  const counts = Object.entries(ev.gate_counts)
    .map(([g, d]) => `${g} ${Object.entries(d).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    .sort();
  return [
    input.public_summary.body,
    '',
    '---',
    `goodboy ${ev.goodboy_version ?? 'unknown'}, Claude Code ${ev.claude_code_version ?? 'unknown'}.`,
    counts.length > 0 ? `Gate decisions in the session: ${counts.join('; ')}.` : 'No gate decisions recorded in the session.',
    '',
    `Filed with goodboy's report-goodboy skill.`,
    '',
  ].join('\n');
}

/** Generic words a project or a person may be named, which a summary uses in their plain sense. */
const COMMON_WORDS = new Set([
  'api', 'app', 'web', 'www', 'server', 'client', 'backend', 'frontend', 'test', 'tests', 'demo', 'project', 'src', 'main', 'master',
  'core', 'lib', 'docs', 'home', 'user', 'admin', 'root', 'local', 'localhost', 'goodboy', 'yolol312', 'github', 'origin', 'macbook',
  'claude', 'code', 'team', 'work', 'platform', 'service', 'git', 'gitlab', 'bitbucket',
]);
/** Code hosts whose name says nothing about the user. */
const PUBLIC_GIT_HOSTS = /^(?:github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com|dev\.azure\.com)$/i;
/** Labels of a host name that say nothing about its owner. */
const HOST_LABELS = /^(?:com|net|org|io|co|kr|jp|de|uk|ai|dev|cloud|local|internal|corp|lan|git|gitlab|github|bitbucket|www|ssh|scm|code|repo|repos|vcs)$/i;

/** Names this machine knows to be the user's (J1 review: whole names, as people and projects
 *  write them in several spellings): the repo's dir name; each remote's host (when it is not a
 *  public code host), its owner and its repo name; git's user.name and the parts of
 *  user.email; the login name and the host name. A first or a last name alone is not one. */
export function privateTerms(cwd: string): string[] {
  const run = (args: string[]): string => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const terms = new Set<string>();
  const add = (s: string | undefined) => {
    const t = (s ?? '').normalize('NFC').trim().toLowerCase();
    // Two characters are a whole name in Chinese, Japanese or Korean (`王伟`).
    if ((t.length >= 3 || (t.length === 2 && /[^\x00-\x7f]/.test(t))) && !COMMON_WORDS.has(t)) terms.add(t);
  };
  add(basename(run(['rev-parse', '--show-toplevel']) || cwd));
  for (const line of run(['remote', '-v']).split('\n')) {
    const url = line.split(/\s+/)[1] ?? '';
    // scp form `user@host:owner/…/repo.git`, or `scheme://[user@]host[:port]/owner/…/repo.git`.
    const m = url.match(/^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/);
    if (!m) continue;
    if (!PUBLIC_GIT_HOSTS.test(m[1]!)) for (const label of m[1]!.split('.')) if (!HOST_LABELS.test(label)) add(label);
    const parts = m[2]!.split('/').filter(Boolean);
    add(parts[0]);
    add(parts[parts.length - 1]);
  }
  add(run(['config', 'user.name']));
  const email = run(['config', 'user.email']);
  add(email.split('@')[0]);
  for (const label of (email.split('@')[1] ?? '').split('.')) if (!HOST_LABELS.test(label)) add(label);
  try {
    add(userInfo().username);
  } catch {
    // no passwd entry
  }
  add(hostname().split('.')[0]);
  return [...terms];
}

const ALLOWED_HOSTS = /^(?:github\.com|(?:[\w-]+\.)?anthropic\.com|claude\.(?:ai|com))$/i;
/** Public package roots a report may name (a library, not the user's code). */
const PUBLIC_PACKAGES = /^(?:org\.(?:junit|apache|springframework|mybatis|hibernate|slf4j|jetbrains|gradle|mockito|assertj|jacoco)|com\.(?:fasterxml|google)|io\.(?:netty|micrometer))(?:\.|$)/i;
/** Public npm scopes a report may name. */
const PUBLIC_SCOPES = /^@(?:types|babel|vitejs|testing-library|anthropic-ai|typescript-eslint|eslint|playwright|vue|angular|nestjs|prisma|tanstack|reduxjs|mui|emotion|rollup|swc|jest|storybook|aws-sdk|google-cloud|sentry|octokit|modelcontextprotocol)\//i;
/** Top-level domains a host in a report may end with (a file name ends with an extension). */
const TLDS = 'com|net|org|io|ai|de|uk|fr|kr|jp|cn|co|dev|cloud|tech|info|biz|xyz|local|internal|corp|lan|intra';

/** What in `text` names the user's machine, project, people or secrets. */
export function publicLeaks(text: string, terms: string[]): string[] {
  const out: string[] = [];
  const find = (kind: string, re: RegExp, keep?: (m: string) => boolean) => {
    for (const m of text.matchAll(re)) if (!keep || !keep(m[0].trim())) out.push(`${kind}: "${m[0].trim().slice(0, 80)}"`);
  };
  // Any absolute path with a directory in it (`/data/app/x`, `:/Users/…` in a PATH list,
  //   `[/srv/…]`), a home path, a file URL and a Windows path (J1 review); a URL's own path
  //   follows `//host`, so it never matches here.
  find('a local path', /(?:^|[^\w.\/~-])(?:\/[\w.-]+\/[\w./-]*|~\/\S*)|file:\/\/\S+|\b[A-Za-z]:[\\/]\S+/g, (p) => /^[^\w]?~\/\.claude\//.test(p) && !p.includes('..'));
  // A source path or a scoped npm package names its owner (`src/main/java/com/acme/…`,
  //   `@acme/billing-ui`); well-known public ones aside.
  find('a package path or scope', /(?:^|[^\w.])(?:com|net|org|io|kr|jp|co|dev|de)\/[a-z0-9_]+\/[\w./-]*/gi, (p) =>
    PUBLIC_PACKAGES.test(p.replace(/^[^a-z]+/i, '').replace(/\//g, '.')),
  );
  find('a package path or scope', /(?:^|[\s"'`(])@[a-z0-9][\w.-]*\/[\w.-]+/gi, (p) => PUBLIC_SCOPES.test(p.trim().replace(/^[^@]*/, '')));
  // goodboy's repo is the only one a report names, with or without a scheme.
  find('a URL to another host', /(?:^|[^\w./:-])(?:www\.)?github\.com\/[^\s)>\]"']+/gi, (u) => /github\.com\/yolol312\/goodboy(?:[/?#]|$)/i.test(u.trim()));
  find('an email address', /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g);
  find('an IP address', /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|\b[0-9a-f]{1,4}::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\b/gi);
  find('a URL to another host', /\b[a-z][\w+.-]*:\/\/[^\s)>\]"']+/gi, (u) => {
    const host = u.replace(/^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?/i, '').split(/[/:?#]/)[0] ?? '';
    return /^https?:/i.test(u) && ALLOWED_HOSTS.test(host) && (!/^github\.com$/i.test(host) || /^https?:\/\/github\.com\/yolol312\/goodboy(?:[/?#]|$)/i.test(u));
  });
  // A host ends with its top-level domain (`tsconfig.app.json` is a file).
  find('a domain or package name', new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b(?![.-]?[a-z0-9])`, 'gi'), (d) => ALLOWED_HOSTS.test(d));
  // A Java or Kotlin package names its owner's domain backwards (`com.acme.billing`).
  find('a domain or package name', /\b(?:com|net|org|io|kr|jp|co|dev|de)\.[a-z0-9_]+(?:\.[a-z0-9_]+)+/gi, (p) => PUBLIC_PACKAGES.test(p));
  find(
    'a secret',
    new RegExp(
      [
        '\\bAKIA[0-9A-Z]{16}',
        '\\bgh[pousr]_[A-Za-z0-9]{20,}',
        '\\bgithub_pat_\\w{20,}',
        '\\bglpat-[\\w-]{16,}',
        '\\bsk[-_](?:live_|test_)?[A-Za-z0-9_-]{16,}',
        '\\bAIza[\\w-]{30,}',
        '\\bnpm_[A-Za-z0-9]{30,}',
        '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
        '-----BEGIN [A-Z ]*PRIVATE KEY',
        '\\beyJ[\\w-]{10,}\\.[\\w-]{10,}',
        '\\bBearer\\s+[\\w.~+/-]{16,}',
        // A user and password in a URL (`redis://:pw@host`).
        '\\b[a-z][\\w+.-]*://[^\\s:@/]*:[^\\s@/]+@',
        // `password = x`, `"token": "x"`: a value with a letter in it (a token count is no
        //   secret); `--password x` as a flag.
        '(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["\']?\\s*[:=]\\s*["\']?(?=[^\\s"\']*[A-Za-z])[^\\s"\',;]{6,}',
        '--(?:password|passwd|token|secret|api-key)[=\\s]+\\S{4,}',
      ].join('|'),
      'gi',
    ),
  );
  // Names in any spelling: case, NFC/NFD, and `-`, `_`, `.`, a space or nothing between their
  //   parts (`Acme Billing`, `acme_billing`, `AcmeBilling` for `acme-billing`; `김 성모` for
  //   `김성모`); a whole word, not inside a longer one.
  const norm = text.normalize('NFC').toLowerCase();
  for (const t of terms) {
    const chars = [...t.normalize('NFC')];
    const body = chars
      .map((c, i) => {
        if (/[-_.\s]/.test(c)) return '[-_.\\s]?';
        const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Between two non-ASCII letters a space may appear.
        return i > 0 && /[^\x00-\x7f]/.test(c) && /[^\x00-\x7f]/.test(chars[i - 1]!) ? `\\s?${esc}` : esc;
      })
      .join('');
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${body}(?=$|[^a-z0-9])`, 'u').test(norm)) out.push(`a name from this machine or repo: "${t}"`);
  }
  return out;
}

// ---- the inbox ----

/** Writes the report and its public summary as new files in the inbox (never over a file, a
 *  link or anything else at the name), and returns their paths. */
export function writeFieldReport(
  input: FieldReportInput,
  ev: Evidence,
  opts: { cwd: string; root: string; env?: NodeJS.ProcessEnv; now?: Date },
): { path: string; publicPath: string; publicText: string } {
  const env = opts.env ?? process.env;
  const dir = inboxDir(env);
  // Never the versioned plugin cache (gone on the next update) or, by default, a temp dir.
  const under = (a: string, b: string) => {
    const r = relative(realDeep(b), realDeep(a));
    return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && r !== '..');
  };
  if (under(dir, opts.root)) throw new Error(`the inbox ${dir} is inside goodboy's own directory, which an update replaces`);
  if ((env.GOODBOY_INBOX_DIR ?? '').trim() === '' && [tmpdir(), '/tmp', '/var/tmp'].some((t) => under(dir, t))) {
    throw new Error(`the inbox ${dir} is in a temp dir`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`the inbox ${dir} is not a directory (a link or a file is at its path)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`the inbox ${dir} belongs to another user`);
  if ((st.mode & 0o022) !== 0) throw new Error(`the inbox ${dir} is writable by others (chmod 700 it)`);
  const now = opts.now ?? new Date();
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'report';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const publicText = `# ${REPORT_TITLE_TAG} ${input.public_summary.title}\n\n${renderPublic(input, ev)}`;
  const record = { schema: 'goodboy-field-report/1', created: now.toISOString(), status: 'new', cwd: opts.cwd, report: input, evidence: ev };
  for (let n = 1; n <= 20; n++) {
    const base = join(dir, `${stamp}-${slug}${n === 1 ? '' : `-${n}`}`);
    if (!createNew(`${base}.json`, JSON.stringify(record, null, 2) + '\n')) continue;
    // Taken by something else: drop the report just made and try the next name.
    if (createNew(`${base}.public.md`, publicText)) return { path: `${base}.json`, publicPath: `${base}.public.md`, publicText };
    unlinkSync(`${base}.json`);
  }
  throw new Error(`no free report name in ${dir}`);
}

/** Creates `path` with `text` (mode 600), or false when anything is already at the path: the
 *  exclusive create never follows a link there. */
function createNew(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** `p` with every link resolved, as far up as it exists: an inbox not made yet under a linked
 *  `~/.claude` still resolves to where it would be made (J1 review). */
function realDeep(p: string): string {
  const abs = resolve(p);
  for (let dir = abs; ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), relative(dir, abs));
    } catch {
      if (dirname(dir) === dir) return abs;
    }
  }
}
