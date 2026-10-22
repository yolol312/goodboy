// Commit issue rule (added at the user's request, 2026-10-15): every `git commit` goodboy sees
// (the main session and agents, in every project) needs an issue number in its message: a Jira
// key (`ABC-123`) or a GitHub/GitLab reference (`#123`, `owner/repo#123`).
//
// - A project sets its own pattern (a JavaScript regular expression), or `off`, in the first
//   line of `.goodboy/commit-issue` (the nearest one from where the commit runs).
// - The user turns the rule off everywhere with GOODBOY_COMMIT_ISSUE=off.
// - A session uses the settings it started with: SessionStart pins the files from the cwd up,
//   and a file first read later counts only when it (and its `.goodboy` dir) is unchanged
//   since the session started and no symlink leads to it; a nearer file that does not count
//   leaves the default rule, never a farther one. So the model cannot switch the rule off for
//   itself (a same-user limit stays: docs/stabilization-plan.md §10.10). The pins are gate
//   state (lib/state-guard.ts), made before the first Bash call runs.
// - The message is read from `-m`/`--message`, `--trailer`, `-F`/`--file` (a regular file, or
//   stdin from a heredoc or a pipe), the heredoc bodies of a computed message (`-m "$(cat
//   <<'EOF' … EOF)"`), and for `--amend` without a new message, `-C`/`-c`, `--fixup` and
//   `--squash`, from the commit it reuses. A commit with no message source opens an editor
//   goodboy cannot read: denied. Git aliases (also `-c alias.x=…`, `!` shell aliases and chains),
//   shells that read a heredoc script and `eval` of a heredoc are followed.
// - One call is bounded: git spawns in number and time, the message bytes it reads, and its
//   total time. Past a bound it denies (final G1 reviews: unbounded lookups and reads ran the
//   hook past its timeout or killed it, and either lets the call through). The git it runs
//   starts no program from the repo's config (fsmonitor, gpg.program).

import { lstatSync, realpathSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { stripHeredocs, type HeredocOwner } from './bash-write';
import { ensureSessionDir } from './file-tracker';
import { HOOK_GIT_ARGS, HOOK_GIT_ENV, splitAliasValue } from './hook-git';
import { GIT_VALUE_OPTS, WHOLE_SUBSTITUTION, cdTarget, mentionsGit, readCommand, shellReadsStdin } from './outward-command';
import { GIT_BUILTINS } from './push-test';
import { readRegular } from './safe-read';

/** Tokens shaped like a Jira key that name standards or licenses, not issues (`UTF-8`). */
const NOT_ISSUE_KEYS: ReadonlySet<string> = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'CVE', 'GPT', 'AES', 'RSA', 'TLS', 'SSL', 'HTTP', 'IPV', 'ECMA', 'PEP', 'WCAG', 'GPL', 'LGPL', 'AGPL', 'PHP', 'BSD', 'MPL']);

/** True when `text` names an issue: `pattern` when the project sets one, else a Jira key or a
 *  `#123` / `owner/repo#123` reference (not an HTML entity like `&#123;`). Linear in the text
 *  (final G1 review: an `owner/repo` regex was quadratic on long runs). */
export function hasIssueRef(text: string, pattern: RegExp | null = null): boolean {
  if (pattern) return pattern.test(text);
  for (const m of text.matchAll(/(?<![\w-])([A-Z][A-Z0-9_]+)-\d+(?!\w)/g)) if (!NOT_ISSUE_KEYS.has(m[1]!)) return true;
  const part = (c: string | undefined) => c !== undefined && /[\w.-]/.test(c);
  for (const m of text.matchAll(/#\d+(?!\w)/g)) {
    const at = m.index!;
    const before = text[at - 1];
    if (before === undefined || !/[\w&/.-]/.test(before)) return true;
    // `owner/repo#N`: back over the repo name to a `/`, then over a non-empty owner.
    let j = at;
    while (part(text[j - 1])) j--;
    if (j < at && text[j - 1] === '/' && part(text[j - 2])) return true;
  }
  return false;
}

const CONFIG = join('.goodboy', 'commit-issue');
const PINS_FILE = 'commit-issue-pins.json';

/** The session's settings: when it started, and each `.goodboy/commit-issue` it uses (the
 *  file's first line, or '' when it has none). */
interface SessionPins {
  since: number;
  pins: Record<string, string>;
}

/** The directory with symlinks resolved, so a symlinked spelling of a repo finds its pins. */
function realDir(dir: string): string {
  try {
    return realpathSync(resolvePath(dir));
  } catch {
    return resolvePath(dir);
  }
}

/** A config file as it is now: its first line ('' when none); undefined when there is none;
 *  null when it cannot be trusted: reached through a symlink, not a regular file, or changed
 *  (or moved into place with its `.goodboy` dir) after `since`. */
function configNow(d: string, since: number): string | null | undefined {
  let meta: Stats;
  try {
    meta = lstatSync(join(d, '.goodboy'));
  } catch {
    return undefined;
  }
  if (!meta.isDirectory()) return meta.isSymbolicLink() ? null : undefined;
  const read = readRegular(join(d, CONFIG), 64 * 1024, true);
  if (read === 'absent') return undefined;
  if (read === 'refused') return null;
  if (Math.floor(Math.max(read.st.mtimeMs, read.st.ctimeMs, meta.ctimeMs)) > since) return null;
  const line = read.text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  return line ?? '';
}

/** The rule for a commit run in `dir`: off, or the pattern to match (null: the default). The
 *  nearest config decides: a pinned one as pinned, else one unchanged since `since` (then
 *  pinned into `pins` when given); one that cannot be trusted leaves the default. */
export function commitIssueRule(dir: string, since: number, pins?: Record<string, string>): { on: boolean; pattern: RegExp | null } {
  for (let d = realDir(dir); ; d = dirname(d)) {
    const p = join(d, CONFIG);
    let line: string | null | undefined = pins && Object.hasOwn(pins, p) ? pins[p] : undefined;
    if (line === undefined) {
      line = configNow(d, since);
      if (typeof line === 'string' && pins) pins[p] = line;
    }
    if (line === null) return { on: true, pattern: null };
    if (line !== undefined) {
      if (line.trim() === '') return { on: true, pattern: null };
      if (line.trim().toLowerCase() === 'off') return { on: false, pattern: null };
      try {
        return { on: true, pattern: new RegExp(line) };
      } catch {
        return { on: true, pattern: null }; // a broken pattern keeps the default
      }
    }
    if (dirname(d) === d) return { on: true, pattern: null };
  }
}

/** The session's pins file: null when there is none; one that cannot be read (not a regular
 *  file, oversized, not pins) trusts no file it did not pin, so the default rule applies. */
function readPins(sessionId: string): SessionPins | null {
  const read = readRegular(join(ensureSessionDir(sessionId), PINS_FILE), 1024 * 1024);
  if (read === 'absent') return null;
  try {
    if (read !== 'refused') {
      const parsed = JSON.parse(read.text) as SessionPins;
      if (typeof parsed?.since === 'number' && parsed.pins && typeof parsed.pins === 'object') return parsed;
    }
  } catch {
    // not pins
  }
  return { since: 0, pins: {} };
}

function writePins(sessionId: string, state: SessionPins): void {
  try {
    // Through a rename: the path itself may be anything a model call left there (a FIFO).
    const p = join(ensureSessionDir(sessionId), PINS_FILE);
    writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(state), 'utf8');
    renameSync(`${p}.${process.pid}.tmp`, p);
  } catch {
    // best-effort: without the record, later calls judge files against a newer time
  }
}

/** SessionStart (startup, resume, clear): the session uses the settings on disk now, from
 *  `cwd` up. */
export function pinCommitIssueSettings(sessionId: string, cwd: string): void {
  const state: SessionPins = { since: Date.now(), pins: {} };
  for (let d = realDir(cwd); ; d = dirname(d)) {
    const line = configNow(d, Number.MAX_SAFE_INTEGER);
    if (typeof line === 'string') state.pins[join(d, CONFIG)] = line;
    if (dirname(d) === d) break;
  }
  writePins(sessionId, state);
}

/** The session's pins; without a SessionStart record (installed mid-session), since the
 *  session's state dir was made. */
function sessionPins(sessionId: string): SessionPins {
  const known = readPins(sessionId);
  if (known) return known;
  let since = Date.now();
  try {
    const born = statSync(ensureSessionDir(sessionId)).birthtimeMs;
    if (born > 0 && born < since) since = Math.floor(born);
  } catch {
    // no birth time on this file system
  }
  const state: SessionPins = { since, pins: {} };
  writePins(sessionId, state);
  return state;
}

/** Time the rule may take in one call, and one git spawn within it: PreToolUse has 60 s for
 *  every rule. */
const BUDGET_MS = 10_000;
const SPAWN_MS = 5_000;
/** The most one message (a file, MERGE_MSG, a reused message) and all of them in one call may be. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** git spawns one command may cost the rule (alias lookups, reused messages). */
const MAX_GIT_CALLS = 8;
/** Alias chains and heredoc shells inside heredoc shells, followed this deep. */
const MAX_DEPTH = 2;
/** Every git the rule runs starts no program from the repo's config (lib/hook-git.ts). */
const SAFE_GIT = HOOK_GIT_ARGS;
/** Env that moves git's config or repository away from what goodboy reads. */
const ENV_MOVES_GIT = /^(?:GIT_CONFIG\w*|GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|HOME|XDG_CONFIG_HOME)$/;

const NO_MESSAGE =
  'This `git commit` has no message goodboy can read (it would open an editor, or its message file does not exist yet), and every commit needs an issue number (commit issue rule). Pass the message with -m, including the issue key (e.g. `ABC-123`) or `#123`. If you do not know the issue number, ask the user.';
const TOO_MANY = 'This command runs more git aliases or reused commit messages than goodboy reads in one call (commit issue rule). Split it into smaller commands.';
const TOO_SLOW =
  'goodboy could not finish checking this command in time (commit issue rule: a git lookup stalled or printed too much, or the command is too large). Split it, or commit with `git commit -m "<message with the issue number>"`.';
const TOO_MUCH = 'This command makes goodboy read more than 4 MB of commit messages (commit issue rule). Use a smaller message, or split the command.';
const TOO_DEEP = 'This command nests git aliases, or shells that read a heredoc script, deeper than goodboy follows (commit issue rule). Run the git command they stand for.';
const UNREADABLE = 'A script in this command is too large or nested for goodboy to read, so the commit issue rule cannot be checked. Split it into smaller commands.';
const EVAL = 'This command runs the output of a command substitution (`eval "$(…)"`, `sh -c "$(…)"`) and mentions a commit, which goodboy cannot read (commit issue rule). Run the commands directly.';
const envConfig = (sub: string) =>
  `This command runs \`git ${sub}\` with git config or the repository from the environment (GIT_CONFIG*, GIT_DIR, HOME, …) or \`--config-env\`, so goodboy cannot tell what it runs or which commit it reuses (commit issue rule). Run git without them.`;

/** Ends the check with a denial from deep inside it (a timeout, a budget). */
class Denied extends Error {}

/** A text the rule reads commands from: the command, a heredoc script, a shell alias. */
interface Src {
  text: string;
  bodies: string[] | null;
  owners: Array<HeredocOwner | undefined>;
  reads: Map<string, ReturnType<typeof readCommand>>;
  /** Shared verdicts (the bodies, the whole text) per pattern, and the scripts checked. */
  hits: Map<string, boolean>;
  checked: Set<string>;
}

/** What a git call passes to the git it runs (an alias, a shell alias's commands): `-c`
 *  settings, the repo options, and whether env moved its config. */
interface GitScope {
  cfg: string[];
  repo: string[];
  moved: boolean;
}
const NO_SCOPE: GitScope = { cfg: [], repo: [], moved: false };

interface Ctx {
  pins: SessionPins;
  deadline: number;
  calls: number;
  bytes: number;
  srcs: Map<string, Src>;
  reused: Map<string, string | null>;
  aliases: Map<string, string[] | null>;
  files: Map<string, string | null>;
}

function srcOf(ctx: Ctx, text: string): Src {
  let src = ctx.srcs.get(text);
  if (!src) {
    src = { text, bodies: null, owners: [], reads: new Map(), hits: new Map(), checked: new Set() };
    ctx.srcs.set(text, src);
  }
  return src;
}

function bodiesOf(src: Src): string[] {
  if (src.bodies === null) {
    const bodies: string[] = [];
    stripHeredocs(src.text, { bodies, owners: src.owners });
    src.bodies = bodies;
  }
  return src.bodies;
}

/** The heredoc bodies a shell reading its stdin may run: all but what `cat` reads inside a
 *  substitution (`-m "$(cat <<'EOF' … EOF)"` is a message: a line of it starting with `git
 *  commit` was read as a commit). */
function scriptsOf(src: Src): string[] {
  return bodiesOf(src).filter((_, k) => {
    const o = src.owners[k];
    return !(o?.substitution && /^cat(?:\s|$)/.test(o.words));
  });
}

function take(ctx: Ctx, bytes: number): void {
  ctx.bytes += bytes;
  if (ctx.bytes > MAX_READ_BYTES) throw new Denied(TOO_MUCH);
}

/** git under the call's bounds: null when it fails as git would for the command too; a stall,
 *  or more output than a message may be, denies (as "no alias" it would let the call through). */
function runGit(ctx: Ctx, cwd: string, args: string[]): string | null {
  if (++ctx.calls > MAX_GIT_CALLS) throw new Denied(TOO_MANY);
  const left = ctx.deadline - Date.now();
  if (left <= 0) throw new Denied(TOO_SLOW);
  let proc;
  try {
    proc = Bun.spawnSync(['git', ...args], {
      cwd,
      env: { ...process.env, ...HOOK_GIT_ENV },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: Math.min(SPAWN_MS, left),
      maxBuffer: MAX_MESSAGE_BYTES,
    });
  } catch {
    return null; // no such directory: git fails the same way
  }
  if (proc.exitedDueToTimeout || proc.signalCode) throw new Denied(TOO_SLOW);
  if (proc.exitCode !== 0) return null;
  const out = proc.stdout.toString();
  take(ctx, out.length);
  return out;
}

/** A message file's text, read once per call; null when there is none. */
function readMessage(ctx: Ctx, p: string, shown: string): string | null {
  if (ctx.files.has(p)) return ctx.files.get(p)!;
  const read = readRegular(p, MAX_MESSAGE_BYTES);
  if (read === 'refused') {
    throw new Denied(`The message file \`${shown}\` is not a regular file of at most 1 MB that goodboy can read (commit issue rule). Write the message to a file, or pass it with -m, including the issue number.`);
  }
  const text = read === 'absent' ? null : read.text;
  if (text !== null) take(ctx, text.length);
  ctx.files.set(p, text);
  return text;
}

/** Options of `git commit` that take a value (also as the last letter of a cluster: `-am x`).
 *  `-S[keyid]` and `-u[mode]` take one only attached. */
const VALUE_OPTS: ReadonlySet<string> = new Set(['-m', '-F', '-C', '-c', '-t', '--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--template', '--author', '--date', '--cleanup', '--trailer', '--pathspec-from-file']);
const ATTACHED_ONLY = new Set(['S', 'u']);

interface CommitSource {
  /** `-m` values in order, then `--trailer` values. */
  messages: string[];
  files: string[];
  /** The commit whose message this one reuses (`--amend`, `-C`), and whether only its subject
   *  is used (`--fixup`, `--squash`). */
  reuse: { ref: string; subject: boolean } | null;
  noEdit: boolean;
  /** git removes `#` lines from the message: `--cleanup=strip`, or an edited message (`-e`). */
  strip: boolean;
}

function commitSource(args: string[]): CommitSource {
  const out: CommitSource = { messages: [], files: [], reuse: null, noEdit: false, strip: false };
  const trailers: string[] = [];
  let amend = false;
  let edit = false;
  let cleanup: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w === '--') break;
    if (!w.startsWith('-') || w === '-') continue;
    let name = w;
    let value: string | undefined;
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      if (eq > 0) {
        name = w.slice(0, eq);
        value = w.slice(eq + 1);
      } else if (VALUE_OPTS.has(w)) value = args[++i];
    } else {
      for (let k = 1; k < w.length; k++) {
        if (ATTACHED_ONLY.has(w[k]!)) break;
        if (w[k] === 'e') edit = true;
        if (!VALUE_OPTS.has(`-${w[k]}`)) continue;
        name = `-${w[k]}`;
        value = k < w.length - 1 ? w.slice(k + 1) : args[++i];
        break;
      }
    }
    if (name === '--amend') amend = true;
    if (name === '--edit') edit = true;
    if (name === '--no-edit') {
      out.noEdit = true;
      edit = false;
    }
    if (value === undefined) continue;
    if (name === '-m' || name === '--message') out.messages.push(value);
    else if (name === '--trailer') trailers.push(value);
    else if (name === '-F' || name === '--file') out.files.push(value);
    else if (name === '--cleanup') cleanup = value;
    else if (['-C', '-c', '--reuse-message', '--reedit-message'].includes(name)) out.reuse = { ref: value, subject: false };
    else if (name === '--fixup' || name === '--squash') out.reuse = { ref: value.replace(/^(?:amend|reword):/, ''), subject: true };
  }
  out.messages.push(...trailers);
  if (amend && out.messages.length === 0 && out.files.length === 0 && out.reuse === null) out.reuse = { ref: 'HEAD', subject: false };
  out.strip = cleanup === 'strip' || (edit && (cleanup === undefined || cleanup === 'default'));
  return out;
}

/** `src`: the text the commit's words come from (its computed `-m` bodies); `stdin`: what a
 *  `-F -` reads (for a shell alias, the command that runs it). */
function checkCommit(args: string[], here: string, ctx: Ctx, scope: GitScope, src: Src, stdin: Src): string | null {
  const rule = commitIssueRule(here, ctx.pins.since, ctx.pins.pins);
  if (!rule.on) return null;
  const msg = commitSource(args);
  // A set: a file named 1300 times is one text to judge.
  const texts = new Set<string>();
  // `-m` values are paragraphs of one message; a computed one (`"$(cat <<'EOF' … EOF)"`) is
  //   its heredoc bodies (each one a candidate, so a pattern anchored at `^` sees the subject).
  let bodies = false;
  let fromStdin = false;
  if (msg.messages.length > 0) {
    bodies = msg.messages.some((m) => /\$\(|`/.test(m));
    texts.add(msg.messages.join('\n\n'));
  }
  for (const f of msg.files) {
    // stdin: a heredoc body, or what the command pipes in (read leniently: its whole text).
    if (f === '-' || f === '/dev/stdin') fromStdin = true;
    else {
      const text = readMessage(ctx, resolvePath(here, f), f);
      if (text !== null) texts.add(text);
    }
  }
  const lookup = msg.reuse !== null || (texts.size === 0 && !fromStdin && msg.noEdit);
  if (lookup && scope.moved) return envConfig('commit');
  if (msg.reuse !== null) {
    if (msg.reuse.ref.startsWith('-')) return `The commit \`${msg.reuse.ref}\` this one reuses looks like an option (commit issue rule). Name the commit (e.g. HEAD).`;
    const key = [here, msg.reuse.ref, msg.reuse.subject, ...scope.repo].join('\0');
    if (!ctx.reused.has(key)) {
      const format = `--format=${msg.reuse.subject ? '%s' : '%B'}`;
      ctx.reused.set(key, runGit(ctx, here, [...SAFE_GIT, ...scope.repo, 'log', '-1', '--no-show-signature', format, '--end-of-options', msg.reuse.ref, '--']));
    }
    const reused = ctx.reused.get(key);
    if (reused) texts.add(reused);
  } else if (lookup) {
    // After a conflicted merge, `git commit --no-edit` takes MERGE_MSG.
    const path = runGit(ctx, here, [...SAFE_GIT, ...scope.repo, 'rev-parse', '--git-path', 'MERGE_MSG'])?.trim();
    const text = path ? readMessage(ctx, resolvePath(here, path), 'MERGE_MSG') : null;
    if (text !== null) texts.add(text);
  }
  if (texts.size === 0 && !fromStdin) return NO_MESSAGE;
  const hit = (t: string) => hasIssueRef(msg.strip ? t.split('\n').filter((l) => !l.startsWith('#')).join('\n') : t, rule.pattern);
  // The bodies and the whole text are shared by every commit in it: judged once per pattern.
  const shared = (of: Src, what: 'bodies' | 'text'): boolean => {
    const key = `${what}\0${msg.strip}\0${rule.pattern?.source ?? ''}`;
    let v = of.hits.get(key);
    if (v === undefined) {
      v = what === 'bodies' ? bodiesOf(of).some(hit) : hit(of.text);
      of.hits.set(key, v);
    }
    return v;
  };
  if ([...texts].some(hit) || (bodies && shared(src, 'bodies')) || (fromStdin && (shared(stdin, 'bodies') || shared(stdin, 'text')))) return null;
  const want = rule.pattern ? `a match for this project's pattern \`${rule.pattern.source}\` (.goodboy/commit-issue)` : 'an issue key (e.g. `ABC-123`) or `#123`';
  return `This commit message has no issue number (commit issue rule): add ${want} to the message. If you do not know the issue number, ask the user; do not make one up.`;
}

/** What `git <sub>` stands for: its alias's words (one `!…` word for a shell alias), or null. */
function aliasOf(ctx: Ctx, sub: string, here: string, scope: GitScope): string[] | null {
  const name = sub.toLowerCase();
  const key = [here, name, ...scope.cfg, ...scope.repo].join('\0');
  if (ctx.aliases.has(key)) return ctx.aliases.get(key)!;
  // Config keys ignore case (`alias.CI` is `alias.ci`); the last `-c` wins.
  let value: string | null = null;
  for (const c of scope.cfg) {
    const m = c.match(/^alias\.([^=]+)=([\s\S]*)$/i);
    if (m && m[1]!.toLowerCase() === name) value = m[2]!;
  }
  // The call's own `-c` settings go along: `-c include.path=…` can define the alias.
  value ??= runGit(ctx, here, [...scope.cfg.flatMap((c) => ['-c', c]), ...SAFE_GIT, ...scope.repo, 'config', '--get', `alias.${sub}`]);
  const v = value?.trim() ?? '';
  const out = v === '' ? null : v.startsWith('!') ? [v] : splitAliasValue(v);
  ctx.aliases.set(key, out);
  return out;
}

const SHELLS = /^(?:ba|z|da|k|c|tc|fi)?sh$/;

function checkGit(words: string[], dir: string, ctx: Ctx, depth: number, from: GitScope, src: Src, stdin: Src): string | null {
  let here = dir;
  const cfg = [...from.cfg];
  let moved = from.moved;
  // `--git-dir` and `--work-tree` are relative to the dir after every `-C`.
  const repo: Array<[string, string]> = [];
  // A repo that cannot be told matters only to a command that may commit (trial 5: `git -C
  //   "$P" status` was denied).
  let unknownRepo: string | null = null;
  let i = 1;
  while (i < words.length && words[i]!.startsWith('-')) {
    const w = words[i]!;
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    const name = eq > 0 ? w.slice(0, eq) : w;
    const value = eq > 0 ? w.slice(eq + 1) : words[i + 1];
    if (w === '-C' && value !== undefined) {
      const to = cdTarget(['cd', value], here);
      if (to === null) unknownRepo ??= `goodboy cannot tell which repo \`git -C ${value}\` commits in (commit issue rule). Use a literal path.`;
      else here = to;
    } else if (w === '-c' && value !== undefined) cfg.push(value);
    else if ((name === '--git-dir' || name === '--work-tree') && value !== undefined) {
      if (/[$`*?[]/.test(value)) unknownRepo ??= `goodboy cannot tell which repo \`git ${name} ${value}\` commits in (commit issue rule). Use a literal path.`;
      else repo.push([name, value]);
    } else if (name === '--config-env') moved = true;
    i += GIT_VALUE_OPTS.has(w) ? 2 : 1;
  }
  const scope: GitScope = { cfg, repo: [...from.repo, ...repo.map(([n, v]) => `${n}=${resolvePath(here, v)}`)], moved };
  const sub = words[i];
  if (sub === undefined) return null;
  // git never lets an alias hide a built-in, so only `commit` or another word may commit.
  const builtin = GIT_BUILTINS.has(sub) || sub === 'push' || !/^[\w.-]+$/.test(sub);
  // In an unknown repo only a named built-in passes: a subcommand built at run time (`$S`)
  //   may be `commit`.
  if (unknownRepo !== null) return sub !== 'commit' && (GIT_BUILTINS.has(sub) || sub === 'push') ? null : unknownRepo;
  const rest = words.slice(i + 1);
  if (sub === 'commit') return checkCommit(rest, here, ctx, scope, src, stdin);
  if (builtin) return null;
  if (scope.moved) return envConfig(sub);
  const expansion = aliasOf(ctx, sub, here, scope);
  if (expansion === null) return null;
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  if (expansion[0]!.startsWith('!')) {
    // A shell alias runs its text with the arguments after it, on the command's stdin.
    const quoted = rest.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    return checkCommand(`${expansion[0]!.slice(1)} ${quoted}`, here, ctx, depth + 1, scope, stdin);
  }
  return checkGit(['git', ...expansion, ...rest], here, ctx, depth + 1, scope, src, stdin);
}

/** The scripts a segment runs from heredocs: a shell reading its stdin (`bash <<'EOF' … EOF`,
 *  `cat <<EOF | sh`, `sh -s`), or the output of a substitution (`eval "$(cat <<'EOF' … EOF)"`,
 *  `sh -c "$(…)"`): all the text's bodies. null for anything else. */
function heredocScripts(words: string[], prog: string, src: Src): { kind: string; bodies: string[] } | 'eval' | null {
  const substitution = (w: string | undefined) => w !== undefined && /\$\(|`/.test(w);
  let runsOutput = prog === 'eval' && words.slice(1).some(substitution);
  if (SHELLS.test(prog)) {
    if (shellReadsStdin(words)) return { kind: 'stdin', bodies: scriptsOf(src) };
    // A `-c` script that is a whole substitution; a literal one is read by the shared reader.
    const c = words.findIndex((w, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    if (c > 0 && WHOLE_SUBSTITUTION.test(words.slice(c + 1).find((w) => !w.startsWith('-')) ?? '')) runsOutput = true;
  }
  if (!runsOutput) return null;
  // Its script is known only when it is the text's heredocs: a commit named outside them is not.
  if (/commit/i.test(stripHeredocs(src.text).replace(/["'\\]/g, ''))) return 'eval';
  return { kind: 'all', bodies: bodiesOf(src) };
}

function checkCommand(command: string, cwd: string, ctx: Ctx, depth: number, scope: GitScope, stdinSrc?: Src): string | null {
  if (!mentionsGit(command)) return null;
  const src = srcOf(ctx, command);
  const stdin = stdinSrc ?? src;
  let read = src.reads.get(cwd);
  if (!read) {
    read = readCommand(command, cwd);
    src.reads.set(cwd, read);
  }
  if (read.truncated) return UNREADABLE;
  for (const { words, dir, env } of read.segments) {
    if (Date.now() > ctx.deadline) throw new Denied(TOO_SLOW);
    const here = dir ?? cwd;
    const prog = (words[0] ?? '').split('/').pop() ?? '';
    const segScope = !scope.moved && env.some((n) => ENV_MOVES_GIT.test(n)) ? { ...scope, moved: true } : scope;
    const scripts = heredocScripts(words, prog, src);
    if (scripts === 'eval') return EVAL;
    if (scripts !== null && scripts.bodies.some(mentionsGit)) {
      if (depth >= MAX_DEPTH) return TOO_DEEP;
      // Each script is read once per place and scope (final G1 test round: every shell re-read
      //   every body, which grew with the cube of the command).
      const key = [scripts.kind, depth, here, segScope.moved, ...segScope.cfg, '', ...segScope.repo].join('\0');
      if (!src.checked.has(key)) {
        for (const body of scripts.bodies) {
          const why = checkCommand(body, here, ctx, depth + 1, segScope);
          if (why !== null) return why;
        }
        src.checked.add(key);
      }
    }
    if (prog !== 'git') continue;
    const why = checkGit(words, here, ctx, depth, segScope, src, stdin);
    if (why !== null) return why;
  }
  return null;
}

/** Why `command` may not run under the rule, or null. */
export function commitIssueDenial(command: string, cwd: string, sessionId: string): string | null {
  // Every Bash call makes sure the session has its pins, before the state snapshot that runs
  //   after the rules, so pins a model call writes are put back (final G1 review: pins written
  //   before the session's first git command were trusted).
  const pins = sessionPins(sessionId);
  if (!mentionsGit(command)) return null;
  const before = JSON.stringify(pins.pins);
  const ctx: Ctx = { pins, deadline: Date.now() + BUDGET_MS, calls: 0, bytes: 0, srcs: new Map(), reused: new Map(), aliases: new Map(), files: new Map() };
  let why: string | null;
  try {
    why = checkCommand(command, cwd, ctx, 0, NO_SCOPE);
  } catch (err) {
    why = err instanceof Denied ? err.message : `goodboy could not check this command for the commit issue rule (${String(err).slice(0, 120)}), so it does not run. Split it into simpler commands.`;
  }
  if (JSON.stringify(pins.pins) !== before) writePins(sessionId, pins);
  return why;
}

/** The bodies of every heredoc in `command`, quoted or not. */
export function heredocBodies(command: string): string[] {
  const bodies: string[] = [];
  stripHeredocs(command, { bodies });
  return bodies;
}
