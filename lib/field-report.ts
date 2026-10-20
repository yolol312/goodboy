// Field reports (track J1, #8): trouble with goodboy found while using it in another project,
// written as one English report to a durable local inbox (~/.claude/goodboy/inbox/), never a
// temp dir or the versioned plugin cache. goodboy attaches the session's evidence itself
// (versions, gate-log counts, retry counters), so the report does not rest on the model's
// memory. The report keeps project details locally; its public summary is checked for paths,
// names, hosts and secrets before it may go to a public issue, and only after the user
// confirms it (the report-goodboy skill).

import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
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
  const counts = Object.entries(ev.gate_counts ?? {})
    .map(([g, d]) => `${g} ${Object.entries(d ?? {}).map(([k, n]) => `${k} ${n}`).join(', ')}`)
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
  if (isUnder(dir, opts.root)) throw new Error(`the inbox ${dir} is inside goodboy's own directory, which an update replaces`);
  if ((env.GOODBOY_INBOX_DIR ?? '').trim() === '' && [tmpdir(), '/tmp', '/var/tmp'].some((t) => isUnder(dir, t))) {
    throw new Error(`the inbox ${dir} is in a temp dir`);
  }
  checkedInbox(env, true);
  const now = opts.now ?? new Date();
  const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'report';
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const publicText = publicFileText(input, ev);
  const record = { schema: 'goodboy-field-report/1', created: now.toISOString(), status: 'new', cwd: opts.cwd, report: input, evidence: ev };
  const base = createSet(dir, `${stamp}-${slug}`, [
    ['.json', JSON.stringify(record, null, 2) + '\n'],
    ['.public.md', publicText],
  ]);
  return { path: `${base}.json`, publicPath: `${base}.public.md`, publicText };
}

/** The `.public.md` text: the issue body as goodboy wrote it. */
function publicFileText(input: FieldReportInput, ev: Evidence): string {
  return `# ${REPORT_TITLE_TAG} ${input.public_summary.title}\n\n${renderPublic(input, ev)}`;
}

/** Whether `a` is `b` or inside it, with every link resolved as far up as each exists. */
function isUnder(a: string, b: string): boolean {
  const r = relative(realDeep(b), realDeep(a));
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep));
}

/** A directory goodboy keeps reports in: a real directory (not a link), this user's, not
 *  writable by others. */
function checkDir(dir: string, what: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${what} ${dir} is not a directory (a link or a file is at its path)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${what} ${dir} belongs to another user`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${what} ${dir} is writable by others (chmod 700 it)`);
}

/** The inbox after checkDir, made 0700 when `create`; null when it is missing and not to be
 *  made. Every inbox command goes through it (J2 review: listing and moving skipped the
 *  checks the writer made). */
function checkedInbox(env: NodeJS.ProcessEnv, create: boolean): string | null {
  const dir = inboxDir(env);
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else {
    try {
      lstatSync(dir);
    } catch {
      return null;
    }
  }
  checkDir(dir, 'the inbox');
  return dir;
}

/** Creates `<stem><-n><ext>` for every file at the first `n` where all the names are free (a
 *  file or a link at any of them moves on to the next `n`; what was made for it is removed),
 *  and returns `<dir>/<stem><-n>`. */
function createSet(dir: string, stem: string, files: [ext: string, text: string][]): string {
  for (let n = 1; n <= 20; n++) {
    const base = join(dir, `${stem}${n === 1 ? '' : `-${n}`}`);
    const made: string[] = [];
    try {
      for (const [ext, text] of files) {
        if (!createNew(base + ext, text)) break;
        made.push(base + ext);
      }
    } catch (err) {
      for (const p of made) unlinkSync(p);
      throw err;
    }
    if (made.length === files.length) return base;
    for (const p of made) unlinkSync(p);
  }
  throw new Error(`no free name for ${stem} in ${dir}`);
}

/** Creates `path` with `text` (mode 600), written whole and synced to disk, or false when
 *  anything is already at the path: the exclusive create never follows a link there. A write
 *  that fails or stops short removes the file and throws (J2 review: a short write lost a
 *  report whose original was then removed). */
function createNew(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    const buf = Buffer.from(text, 'utf8');
    for (let off = 0; off < buf.length; ) {
      const k = writeSync(fd, buf, off, buf.length - off);
      if (k <= 0) throw new Error(`${path}: the write stopped short`);
      off += k;
    }
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
    throw err;
  }
  closeSync(fd);
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

// ---- the inbox in goodboy's own repo (track J2, #9) ----

export interface InboxEntry {
  path: string;
  created: string;
  title: string;
  public_title: string;
  session: string | null;
  /** The issue the public summary went to (report-filed), or null. */
  filed: string | null;
  /** The user chose to keep the report local (report-filed --local): it is never filed. */
  keep_local: boolean;
}

const MAX_INBOX_ENTRIES = 200;
const MAX_INBOX_READS = 1000;
/** A report's file name: a word character first, so never `.`, `..` or a hidden name (J2
 *  review: `...json` had the stem `..` and was copied out of the inbox). */
const REPORT_NAME = /^\w[\w.-]{0,118}\.json$/;
const ISSUE_URL = /^https:\/\/github\.com\/yolol312\/goodboy\/issues\/\d{1,7}$/;
const MAX_REPORT_BYTES = 1024 * 1024;

type ReportRecord = Record<string, unknown> & {
  schema: 'goodboy-field-report/1';
  created?: unknown;
  cwd?: unknown;
  report: FieldReportInput;
  evidence?: Evidence;
  filed?: { url?: unknown };
  keep_local?: unknown;
};

/** A report record, or null when the text is not one. */
function parseReport(text: string): ReportRecord | null {
  try {
    const rec = JSON.parse(text) as ReportRecord;
    return rec?.schema === 'goodboy-field-report/1' && typeof rec.report?.title === 'string' ? rec : null;
  } catch {
    return null;
  }
}

/** The untriaged reports at the inbox's top level (triaged ones are in `done/`), oldest first:
 *  up to 200 of the first 1000 report-like names (other JSON files cannot hide them all); a
 *  link, a non-file or a file that is not a report is skipped. */
export function listInbox(env: NodeJS.ProcessEnv = process.env): InboxEntry[] {
  const dir = checkedInbox(env, false);
  if (dir === null) return [];
  recoverClaims(dir);
  const names = readdirSync(dir).filter((n) => REPORT_NAME.test(n)).sort().slice(0, MAX_INBOX_READS);
  const out: InboxEntry[] = [];
  for (const n of names) {
    if (out.length >= MAX_INBOX_ENTRIES) break;
    const r = readRegular(join(dir, n), MAX_REPORT_BYTES, true);
    const rec = typeof r === 'object' ? parseReport(r.text) : null;
    if (!rec) continue;
    out.push({
      path: join(dir, n),
      created: typeof rec.created === 'string' ? rec.created : '',
      title: rec.report.title,
      public_title: typeof rec.report.public_summary?.title === 'string' ? rec.report.public_summary.title : '',
      session: typeof rec.evidence?.session === 'string' ? rec.evidence.session : null,
      filed: typeof rec.filed?.url === 'string' ? rec.filed.url : null,
      keep_local: rec.keep_local !== undefined && rec.keep_local !== false,
    });
  }
  return out;
}

/** Why a report's public summary may not be filed now (empty when it may): the user kept it
 *  local, it was filed already, its `.public.md` is not the text goodboy wrote (the file is
 *  what `gh --body-file` posts), its title would break the `gh` command line, or its text
 *  names private details, checked again against the report's project dir when it is still
 *  there (J2 review: a summary kept local, or edited by hand, was filed from a table row). */
export function publishProblems(file: string, env: NodeJS.ProcessEnv = process.env, terms = new Map<string, string[]>()): string[] {
  try {
    const { abs, rec } = topReport(file, env);
    const out: string[] = [];
    if (rec.keep_local !== undefined && rec.keep_local !== false) out.push('the user chose to keep it local');
    if (typeof rec.filed?.url === 'string') out.push(`it was filed already: ${rec.filed.url}`);
    const v = validateFieldReport(rec.report);
    if (!v.ok || !v.value) return [...out, 'the report does not follow the template', ...v.errors];
    // goodboy's footer is rendered from the evidence: it must still be goodboy's numbers and
    //   names (J2 review: a path in an edited footer passed).
    if (!evidenceIntact(rec.evidence)) return [...out, 'its evidence was changed (versions or gate counts)'];
    const pub = readRegular(abs.replace(/\.json$/, '.public.md'), MAX_REPORT_BYTES, true);
    if (typeof pub !== 'object') out.push('its .public.md is missing or not a regular file');
    else if (pub.text !== publicFileText(v.value, rec.evidence)) out.push('its .public.md was changed after goodboy wrote it');
    const cwd = typeof rec.cwd === 'string' && isDirectory(rec.cwd) ? rec.cwd : process.cwd();
    // One git read per project dir, not per report (J2 review: 200 reports took 17 s).
    if (!terms.has(cwd)) terms.set(cwd, privateTerms(cwd));
    out.push(...publicLeaks(`${v.value.public_summary.title}\n${v.value.public_summary.body}`, terms.get(cwd)!));
    return out;
  } catch (err) {
    // One broken report never breaks the list (J2 review).
    return [`it could not be checked: ${(err as Error).message}`];
  }
}

/** Whether `ev` still has goodboy's shape: versions as versions, gate names as goodboy's,
 *  decisions and counts as numbers. */
function evidenceIntact(ev: unknown): ev is Evidence {
  if (typeof ev !== 'object' || ev === null) return false;
  const e = ev as Record<string, unknown>;
  const version = (v: unknown, re: RegExp) => v === null || (typeof v === 'string' && re.test(v));
  if (!version(e.goodboy_version, /^[\w.+-]{1,40}$/) || !version(e.claude_code_version, /^\d+\.\d+\.\d+[\w.-]{0,20}$/)) return false;
  if (typeof e.gate_counts !== 'object' || e.gate_counts === null || Array.isArray(e.gate_counts)) return false;
  return Object.entries(e.gate_counts).every(
    ([g, d]) =>
      GATE_NAME.test(g) &&
      typeof d === 'object' && d !== null && !Array.isArray(d) &&
      Object.entries(d).every(([k, n]) => ['deny', 'warn', 'fail-open'].includes(k) && Number.isInteger(n) && (n as number) >= 0),
  );
}

function isDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The report `file` at the inbox's top level (not a link, not in a subdir, a report record),
 *  with the inbox's real path. */
function topReport(file: string, env: NodeJS.ProcessEnv): { dir: string; abs: string; rec: ReportRecord } {
  const inbox = checkedInbox(env, false);
  if (inbox === null) throw new Error(`there is no inbox at ${inboxDir(env)}`);
  const dir = realDeep(inbox);
  const abs = join(realDeep(dirname(resolve(file))), basename(file));
  if (dirname(abs) !== dir || !REPORT_NAME.test(basename(abs))) throw new Error(`${file} is not a report at the top of the inbox ${dir}`);
  const r = readRegular(abs, MAX_REPORT_BYTES, true);
  if (typeof r !== 'object') throw new Error(`${file} is not a regular file`);
  const rec = parseReport(r.text);
  if (!rec) throw new Error(`${file} is not a report`);
  return { dir, abs, rec };
}

/** Records the user's filing choice in the report (report-goodboy, triage-reports): the issue
 *  its public summary went to, or that it stays local. Under the same claim as report-done,
 *  from the claimed text: two commands on one report at once never both pass or lose the
 *  choice (J2 review). */
export function markFiled(file: string, choice: { issue: string } | { local: true }, env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  if ('issue' in choice && !ISSUE_URL.test(choice.issue)) throw new Error('the issue must be https://github.com/yolol312/goodboy/issues/<number>');
  const { dir, abs } = topReport(file, env);
  return underClaim(dir, [abs], 'filing', ([text]) => {
    const rec = parseReport(text!);
    if (!rec) throw new Error(`${file} is not a report`);
    if (typeof rec.filed?.url === 'string' || (rec.keep_local !== undefined && rec.keep_local !== false)) {
      throw new Error(`${file} already records the user's filing choice`);
    }
    const at = now.toISOString();
    const out = { ...rec, ...('issue' in choice ? { filed: { url: choice.issue, at } } : { keep_local: { at } }) };
    const tmp = join(dir, `.${basename(abs)}.${process.pid}.${Date.now()}.tmp`);
    if (!createNew(tmp, JSON.stringify(out, null, 2) + '\n')) throw new Error(`${tmp} is taken`);
    renameSync(tmp, abs);
    return abs;
  });
}

/** Claims `paths` (a report and maybe its `.public.md`) by atomic renames to hidden names
 *  (`.<name>.<pid>.<verb>`), so a second command on the same report fails at once; runs `fn`
 *  with the claimed files' texts; removes the claims after it, or puts them back when it
 *  fails (never over a file that took the name meanwhile). A claim left by a killed process
 *  is put back by listInbox. */
function underClaim<T>(dir: string, paths: string[], verb: string, fn: (texts: string[]) => T): T {
  const claimed: [claim: string, home: string][] = [];
  const restore = () => {
    for (const [c, home] of claimed) {
      try {
        if (!existsSync(home)) renameSync(c, home);
      } catch {
        // left under its hidden name; listInbox puts it back once this process is gone
      }
    }
  };
  try {
    for (const p of paths) {
      const c = join(dir, `.${basename(p)}.${process.pid}.${verb}`);
      renameSync(p, c);
      claimed.push([c, p]);
    }
  } catch (err) {
    restore();
    throw new Error(`${paths[0]} could not be claimed (moved meanwhile?): ${(err as Error).message}`);
  }
  try {
    const texts = claimed.map(([c]) => {
      const r = readRegular(c, MAX_REPORT_BYTES, true);
      if (typeof r !== 'object') throw new Error(`${c} is not a regular file`);
      return r.text;
    });
    const out = fn(texts);
    for (const [c] of claimed) unlinkSync(c);
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

const CLAIM = /^\.(\w[\w.-]{0,118}\.(?:json|public\.md))\.(\d{1,10})\.(?:triaging|filing)$/;

/** Puts back the files a killed report-filed or report-done left under a claim's hidden name
 *  (its process is gone) when their own name is free (J2 review: they vanished from the list). */
function recoverClaims(dir: string): void {
  for (const n of readdirSync(dir)) {
    const m = n.match(CLAIM);
    if (!m || processAlive(Number(m[2]))) continue;
    try {
      if (lstatSync(join(dir, n)).isFile() && !existsSync(join(dir, m[1]!))) renameSync(join(dir, n), join(dir, m[1]!));
    } catch {
      // gone meanwhile
    }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether `cwd` is in goodboy's own source repo: a git checkout whose root holds goodboy's
 *  plugin manifest, outside Claude Code's plugins dir (an installed copy has no `.git`; the
 *  marketplace clone there has one: J2 review). */
export function inGoodboyRepo(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isUnder(cwd, join((env.CLAUDE_CONFIG_DIR ?? '').trim() || join((env.HOME ?? '').trim() || homedir(), '.claude'), 'plugins'))) return false;
  let dir = resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const r = readRegular(join(dir, '.claude-plugin', 'plugin.json'), 64 * 1024, true);
    if (typeof r === 'object') {
      try {
        return (JSON.parse(r.text) as { name?: unknown }).name === 'goodboy' && existsSync(join(dir, '.git'));
      } catch {
        return false;
      }
    }
    if (dirname(dir) === dir) return false;
    dir = dirname(dir);
  }
  return false;
}

/** The session-start notice in goodboy's repo when the inbox has untriaged reports: one line
 *  for the user and one for the model; nothing runs by itself (GOODBOY_INBOX_NOTICE=off). */
export function inboxNotice(cwd: string, env: NodeJS.ProcessEnv = process.env): { systemMessage: string; context: string } | null {
  if ((env.GOODBOY_INBOX_NOTICE ?? 'on').trim().toLowerCase() === 'off' || !inGoodboyRepo(cwd, env)) return null;
  let n: number;
  try {
    n = listInbox(env).length;
  } catch {
    // An unsafe inbox is refused by report-list with the reason; the notice stays silent.
    return null;
  }
  if (n === 0) return null;
  return {
    systemMessage: `[goodboy] 아직 정리하지 않은 현장 리포트가 ${n}건 있어요(${inboxDir(env)}). /triage-reports로 정리할 수 있어요`,
    context: `${n} untriaged goodboy field report(s) wait in ${inboxDir(env)}. The user may run the repo-local triage-reports skill; do not triage them unless asked.`,
  };
}

/** Moves a triaged report (`<name>.json` and its `.public.md`) from the inbox's top level to
 *  `done/`, with the triage decision written into the report; never over a file there (the
 *  next free name), never a file outside the inbox or a link. The report is claimed first by
 *  an atomic rename to a hidden name, copied whole and synced, and only then removed; on any
 *  failure the claimed files go back (J2 review: two runs at once, or a short write, left two
 *  records or none). */
export function markTriaged(file: string, decision: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  const text = decision.trim();
  if (text === '' || text.length > 1000) throw new Error('the decision must be 1–1000 characters');
  const { dir, abs } = topReport(file, env);
  const done = join(dir, 'done');
  mkdirSync(done, { recursive: true, mode: 0o700 });
  checkDir(done, 'the triaged dir');
  const pub = abs.replace(/\.json$/, '.public.md');
  const pubRead = readRegular(pub, MAX_REPORT_BYTES, true);
  if (pubRead === 'refused') throw new Error(`${pub} is not a regular file; move it away first`);
  // The record written to done/ comes from the claimed text, so a filing choice recorded just
  //   before the claim is kept (J2 review).
  return underClaim(dir, typeof pubRead === 'object' ? [abs, pub] : [abs], 'triaging', ([json, pubText]) => {
    const rec = parseReport(json!);
    if (!rec) throw new Error(`${file} is not a report`);
    const out = { ...rec, status: 'triaged', triage: { at: now.toISOString(), decision: text } };
    const files: [string, string][] = [['.json', JSON.stringify(out, null, 2) + '\n']];
    if (pubText !== undefined) files.push(['.public.md', pubText]);
    return `${createSet(done, basename(abs).replace(/\.json$/, ''), files)}.json`;
  });
}
