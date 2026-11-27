// N8b (plan §20.12, #44 item 2): a review or a test the user defers to the next push.
//
// The user writes `defer-review: <globs>` or `defer-test: <globs>` into a `decide: human` entry of
// `.goodboy/policy.md`. The Stop's review gate and layer 1 then leave the matching files out of what they judge (the
// docs rule does not), and a `git push` asks for their evidence instead: a passing layer-1 record of the pushed tree
// that lists each deferred code file, and a review of each deferred review file's pushed content with no high finding
// on it. The deferral stays in the policy until the user removes it, so each push is its release point.
//
// Only the user adds the globs: an Edit or Write that adds one is denied (hooks/pre-tool-use.ts, as for the other user
// globs). The globs pinned at the session's start count while the file keeps them; a glob added during the session
// counts at once when no tool wrote the policy file in this session, so a glob the model wrote cannot count before the
// next session's pin (a limit that the other user globs share). A tool wrote it when the edit log names a policy file
// (Edit, Write, a Bash write announced or swept, a subagent's), or when the policy watch saw the file change while the
// model's turn ran (`watchPolicy`: after every tool call and at the Stop, whatever wrote it — a link to the file, a
// script, a call that ended with no post hook). The user's own change between turns is the user's: the watch takes
// the file as it is when the user sends a message (`notePolicySeen`), so it counts from that message's Stop.

import { createHash } from 'node:crypto';
import { realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { globsInText, isPolicyFile, pinnedUserGlobs, policyGlobs, sessionUserGlobs } from './changed-coverage';
import { ensureSessionDir, getEditHistory } from './file-tracker';
import { OBJECT_ID, spawnGit } from './git-run';
import { hasSpelling } from './path-spelling';
import { knowledgeRoot, POLICY_FILE } from './project-knowledge';
import { recordPath } from './record-paths';
import { readRegular } from './safe-read';
import type { ReviewResult, TestResult } from './types';

export type DeferKey = 'defer-review' | 'defer-test';

/** The deferral globs of a key: those that count now, and those the policy file has that count from the next session. */
export interface DeferGlobs {
  globs: string[];
  waiting: string[];
}

// ── The policy watch ────────────────────────────────────────────────────────────────────────────

/** The policy file's content as the hooks last saw it, in the session dir: `{"hash": <sha1 | "none" | "unreadable">,
 *  "written"?: true, "globs"?: {"defer-review"?: string[], "defer-test"?: string[]}}` (`globs`: the deferral globs the
 *  file held at the session start and at the user's prompts, which a push still owes). `written` stays once set: a tool, or a change while the model's turn ran, wrote the file. A
 *  state-guard file (lib/state-guard.ts GUARDED and HOOK_ONLY): a model command that rewrites or removes it is put back
 *  to the call's snapshot, whose older hash the next watch then finds changed. */
export const POLICY_SEEN_FILE = 'policy-seen.json';

const MAX_POLICY_READ = 1_000_000;
/** The record's read cap: it holds the user's deferral globs too. */
const MAX_SEEN_READ = 256 * 1024;

const DEFER_KEYS: readonly DeferKey[] = ['defer-review', 'defer-test'];

interface PolicySeen {
  hash: string;
  written?: true;
  /** The deferral globs the policy file had when the hooks took it as the user's (a prompt, the session start), kept
   *  for the session: a push owes them also after a tool removed the line. */
  globs?: Partial<Record<DeferKey, string[]>>;
}

/** The project's policy file (the one the gates read, from `dir`) as a hash: `none` when there is none, `unreadable`
 *  when it is no regular file of up to 1 MB (a link to one is read); and its text when it was read. */
function policyRead(dir: string): { hash: string; text: string | null } {
  const r = readRegular(join(knowledgeRoot(dir).root, POLICY_FILE), MAX_POLICY_READ);
  if (r === 'absent') return { hash: 'none', text: null };
  if (r === 'refused') return { hash: 'unreadable', text: null };
  return { hash: createHash('sha1').update(r.text).digest('hex'), text: r.text };
}

/** Each key's globs of both, unioned (only strings are kept). */
function unionGlobs(a: PolicySeen['globs'], b: PolicySeen['globs']): PolicySeen['globs'] {
  const out: Partial<Record<DeferKey, string[]>> = {};
  for (const k of DEFER_KEYS) {
    const all = [...(a?.[k] ?? []), ...(b?.[k] ?? [])].filter((g): g is string => typeof g === 'string');
    if (all.length > 0) out[k] = [...new Set(all)];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function seenPath(sessionId: string): string {
  return join(ensureSessionDir(sessionId), POLICY_SEEN_FILE);
}

/** The watch's record, `absent`, or `refused` when it is no plain small file or not one the watch wrote. */
function readSeen(sessionId: string): PolicySeen | 'absent' | 'refused' {
  const r = readRegular(seenPath(sessionId), MAX_SEEN_READ, true);
  if (r === 'absent' || r === 'refused') return r;
  try {
    const v = JSON.parse(r.text) as Partial<PolicySeen> | null;
    if (v === null || typeof v !== 'object' || typeof v.hash !== 'string') return 'refused';
    const g = v.globs !== null && typeof v.globs === 'object' ? v.globs : undefined;
    const globs = unionGlobs(
      g === undefined ? undefined : Object.fromEntries(DEFER_KEYS.map((k) => [k, Array.isArray(g[k]) ? g[k] : []])),
      undefined,
    );
    return { hash: v.hash, ...(v.written === true ? { written: true as const } : {}), ...(globs ? { globs } : {}) };
  } catch {
    return 'refused';
  }
}

/** Replaces the record (a link in its place is removed, never written through). */
function writeSeen(sessionId: string, seen: PolicySeen): void {
  const p = seenPath(sessionId);
  rmSync(p, { force: true });
  writeFileSync(p, JSON.stringify(seen), { flag: 'wx', mode: 0o600 });
}

/** (UserPromptSubmit; SessionStart at a start, a resume or a clear) The user's turn: the policy file as it is now is
 *  the user's, so a deferral glob it has counts from this turn's Stop. `written` stays when it was set, and a record
 *  that cannot be read counts as written. Never throws. */
export function notePolicySeen(sessionId: string, dir: string): void {
  try {
    const seen = readSeen(sessionId);
    const written = seen === 'refused' || (typeof seen === 'object' && seen.written === true);
    const now = policyRead(dir);
    const user = now.text === null ? undefined : Object.fromEntries(DEFER_KEYS.map((k) => [k, globsInText(now.text!, k)]));
    const globs = unionGlobs(typeof seen === 'object' ? seen.globs : undefined, user);
    writeSeen(sessionId, { hash: now.hash, ...(written ? { written: true as const } : {}), ...(globs ? { globs } : {}) });
  } catch {
    // best-effort: with no record, the next watch counts the file as written (fails closed)
  }
}

/** (PostToolUse and PostToolUseFailure of every tool, main or subagent, after the state guard's restore; the Stop
 *  before its gates) Whether the policy file counts as written by a tool this session: it changed since the hooks last
 *  saw it, so a tool wrote it, by any path, or the user changed it while the model worked; either way a glob it added
 *  waits for the next session. No record to compare with (none, or one that cannot be read) counts as written too.
 *  Never throws; an error counts as written. */
export function watchPolicy(sessionId: string, dir: string): boolean {
  try {
    const seen = readSeen(sessionId);
    const { hash } = policyRead(dir);
    if (typeof seen === 'object' && seen.hash === hash) return seen.written === true;
    // The user's globs stay (a tool's change adds none of its own to them).
    const globs = typeof seen === 'object' ? seen.globs : undefined;
    writeSeen(sessionId, { hash, written: true, ...(globs ? { globs } : {}) });
    return true;
  } catch {
    return true;
  }
}

/** Whether the watch's record says written; a missing or unreadable record counts as written (the Stop watches before
 *  its gates, so a missing one there is one that could not be written). */
function seenWritten(sessionId: string): boolean {
  try {
    const seen = readSeen(sessionId);
    return typeof seen !== 'object' || seen.written === true;
  } catch {
    return true;
  }
}

/** Whether a tool wrote a policy file in this session: the edit log names one, or the policy watch marked the file. An
 *  unreadable log counts as written. */
export function policyWrittenThisSession(
  sessionId: string,
  history: typeof getEditHistory = getEditHistory,
  watched: (sessionId: string) => boolean = seenWritten,
): boolean {
  try {
    if (history(sessionId).files.some((f) => isPolicyFile(f))) return true;
  } catch {
    return true;
  }
  return watched(sessionId);
}

/** The deferral globs of `key` this session may use now (see the header). `top` is the project's top, as for the other
 *  user globs. `written` says whether a tool wrote a policy file this session (a seam for the tests). */
export function deferGlobs(
  sessionId: string,
  cwd: string,
  top: string,
  key: DeferKey,
  written: () => boolean = () => policyWrittenThisSession(sessionId),
): DeferGlobs {
  const current = policyGlobs(cwd, top, key);
  if (current.length === 0) return { globs: [], waiting: [] };
  if (!written()) return { globs: current, waiting: [] };
  const pinned = sessionUserGlobs(sessionId, cwd, top, key);
  return { globs: pinned, waiting: current.filter((g) => !pinned.includes(g)) };
}

/** The deferral globs a push asks evidence for: every glob the policy file has now (also one that waits for the next
 *  session), the session's pinned ones and the ones the user's policy file had at a prompt this session, whether or
 *  not the file still has them. A push asks more than the Stop skipped, never less: a tool that removes or narrows
 *  the line does not drop what is owed (security delta review). A glob in the record that a forged restore planted only
 *  adds what a push owes. */
export function pushDeferGlobs(sessionId: string, cwd: string, top: string, key: DeferKey): string[] {
  let seen: string[] = [];
  try {
    const s = readSeen(sessionId);
    seen = typeof s === 'object' ? (s.globs?.[key] ?? []) : [];
  } catch {
    seen = [];
  }
  return [...new Set([...policyGlobs(cwd, top, key), ...pinnedUserGlobs(sessionId, top, key), ...seen])];
}

/** A matcher of absolute paths against deferral globs. */
export interface DeferMatch {
  /** Whether any glob is set (no glob: nothing is deferred and nothing is asked at a push). */
  any: boolean;
  /** Whether a glob matches the file named from the project dir, or from `repoTop` when given (a nested repo's file
   *  matches a glob written for the repo, as `static-preview` does). */
  test: (abs: string, repoTop?: string) => boolean;
}

/** `abs` from `from` with `/` separators, or null outside it. */
function inside(from: string, abs: string): string | null {
  const r = relative(from, abs);
  if (r === '' || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) return null;
  return r.split(sep).join('/');
}

export function deferMatcher(globs: readonly string[], projectDir: string): DeferMatch {
  if (globs.length === 0) return { any: false, test: () => false };
  const compiled = globs.map((g) => new Bun.Glob(g));
  return {
    any: true,
    test: (abs, repoTop) => {
      const names = [inside(projectDir, abs), repoTop !== undefined ? inside(repoTop, abs) : null].filter((n): n is string => n !== null);
      return names.some((n) => compiled.some((g) => g.match(n)));
    },
  };
}

// ── At the push ─────────────────────────────────────────────────────────────────────────────────

/** Most files a push is checked for; a push that sends more cannot be judged (it is denied; the user's marker passes). */
export const MAX_PUSH_FILES = 5000;
/** Most deferral globs (both keys) a push judges with; more cannot be judged in the hook's time (denied likewise). */
export const MAX_DEFER_GLOBS = 1000;

/** `rev` as a commit id, or null when git cannot resolve it. `--end-of-options`: a name from the command line never
 *  reads as an option (`--output=<file>` would have git write that file). */
export function commitOf(cwd: string, rev: string): string | null {
  const r = spawnGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  const id = r.code === 0 ? r.out.trim() : '';
  return OBJECT_ID.test(id) ? id : null;
}

/** A remote named as a word (`origin`), not a URL or a path. */
const REMOTE_NAME = /^[\w.-]+$/;
/** `scheme://…` or scp-like `host:path` (a colon before any slash): a URL git resolves itself. */
const URL_LIKE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[^/:]+:)/;
/** How long the remote may take to answer, ms (the hook's own clock still bounds it). */
const LS_REMOTE_MS = 20_000;
/** Where `ls-remote` runs: the file system root, where no repo is found (a user cannot make `/.git`, while a model can
 *  `git init` the temp dir, whose config git would then read). */
const NEUTRAL_DIR = '/';

/** The URL git pushes to for `url` given on the command line, as git rewrites it (remote.c): the longest matching
 *  `url.<base>.pushInsteadOf` prefix, else the longest matching `url.<base>.insteadOf`, else `url` itself; null when
 *  git cannot list the rules. */
export function pushRewrite(cwd: string, url: string): string | null {
  const r = spawnGit(cwd, ['config', '-z', '--get-regexp', '^url\\.']);
  // Exit 1: no such key, so no rule.
  if (r.code !== 0 && r.code !== 1) return null;
  const rules: { push: boolean; from: string; to: string }[] = [];
  for (const entry of r.code === 0 ? r.out.split('\0') : []) {
    const nl = entry.indexOf('\n');
    if (nl < 0) continue;
    const key = entry.slice(0, nl);
    const from = entry.slice(nl + 1);
    const dot = key.lastIndexOf('.');
    const name = key.slice(dot + 1).toLowerCase();
    // An empty value is a prefix of every URL, as git reads it (security delta review: `url.<x>.pushInsteadOf ''` sent
    //   `git push . main` to <x>).
    if (name !== 'insteadof' && name !== 'pushinsteadof') continue;
    rules.push({ push: name === 'pushinsteadof', from, to: key.slice('url.'.length, dot) });
  }
  const best = (push: boolean): string | null => {
    let hit: { from: string; to: string } | null = null;
    for (const rule of rules) if (rule.push === push && url.startsWith(rule.from) && (hit === null || rule.from.length > hit.from.length)) hit = rule;
    return hit === null ? null : hit.to + url.slice(hit.from.length);
  };
  return best(true) ?? best(false) ?? url;
}

/** Every URL a push to `remote` (a name, a URL or a path; absent: the one git uses) sends to, or null when they cannot
 *  be told. A name's push URLs (`remote get-url --push --all`, which applies `pushInsteadOf`/`insteadOf` as the push
 *  does): git pushes to each `pushurl`, or to each `url` when there is none (security review: reading only the first
 *  let a mirror that already held the commits stand in for the real remote listed after it). A relative path is made
 *  absolute from the work tree's top, where git resolves it (git runs a push from there; security review: from a
 *  subdir, a bare repo at `<subdir>/<path>` stood in for the real one). */
export function pushUrlsOf(cwd: string, remote: string | undefined, defaultRemote: (cwd: string) => string): string[] | null {
  const named = remote ?? defaultRemote(cwd);
  if (named === '' || named.startsWith('-') || /[\0\r\n]/.test(named)) return null;
  let urls: string[] | null = null;
  if (REMOTE_NAME.test(named)) {
    const r = spawnGit(cwd, ['remote', 'get-url', '--push', '--all', named]);
    if (r.code === 0) urls = r.out.split('\n').filter((u) => u !== '');
    else if (remote === undefined) return null; // the default remote is not configured: git would not push
  }
  if (urls === null) {
    // A URL or a path on the command line: the push rewrites it too (security delta review: a mirror path plus
    //   `url.<real>.pushInsteadOf` sent the push to the real remote). `remote get-url` knows configured remotes only.
    const url = pushRewrite(cwd, named);
    if (url === null) return null;
    urls = [url];
  }
  // A local path git expands from a home dir (`~/x`, `~user/x`) cannot be told: git reads $HOME, which the push's own
  //   command can set (security delta review: `~/origin.git` was resolved under the repo top, where a decoy stood in).
  const homeRelative = (u: string): boolean => u.startsWith('~') && !URL_LIKE.test(u);
  if (urls.length === 0 || urls.some((u) => u === '' || u.startsWith('-') || /[\0\r\n]/.test(u) || homeRelative(u))) return null;
  let top: string | undefined;
  const base = (): string => {
    if (top === undefined) {
      const t = spawnGit(cwd, ['rev-parse', '--show-toplevel']);
      // No work tree (a bare repo, or inside .git): git resolves from the cwd there too.
      top = t.code === 0 && t.out.trim() !== '' ? t.out.trim() : resolvePath(cwd);
    }
    return top;
  };
  return [...new Set(urls.map((u) => (URL_LIKE.test(u) ? u : resolvePath(base(), u))))];
}

/** Whether this git honors GIT_CONFIG_GLOBAL (2.32 and later), which a remote read needs to leave out the user's own
 *  config (lib/git-run.ts REMOTE_READ_ENV): an older git reads `~/.gitconfig`, where a model can set a program (security
 *  review). Asked once per process; an answer git does not give counts as older. */
let configGlobalHonored: boolean | undefined;
export function gitHonorsConfigGlobal(): boolean {
  if (configGlobalHonored === undefined) {
    const m = /\bgit version (\d+)\.(\d+)/.exec(spawnGit(NEUTRAL_DIR, ['version']).out);
    configGlobalHonored = m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 32));
  }
  return configGlobalHonored;
}

/** A file or dir only root can change: owned by uid 0 and not writable by group or others. */
function rootOnly(p: string): boolean {
  try {
    const st = statSync(p);
    return st.uid === 0 && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Whether a remote read may keep git's system config: every file git reads for it (`--show-origin`, includes too;
 *  the hook's own command-line settings are skipped, and any other origin but a file is not trusted),
 *  through its real path, and that path's dir, are root's (`rootOnly`), so no model could have set a program there.
 *  macOS's own git (/usr/bin/git) sets the keychain credential helper in such a file, without which a private https
 *  remote could not be read. A Homebrew git's system config is the user's: not trusted. Never throws. */
export function systemConfigTrusted(): boolean {
  if (process.platform === 'win32') return false;
  try {
    // With no global config and outside any repo, what git lists is the system level: /etc/gitconfig, or the file
    //   Apple's git reads (/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig), which `--system` does not
    //   name but GIT_CONFIG_NOSYSTEM turns off too.
    const r = spawnGit(NEUTRAL_DIR, ['config', '--list', '--show-origin', '-z'], { env: { GIT_CONFIG_GLOBAL: '/dev/null' } });
    if (r.code !== 0) return false;
    const files = new Set<string>();
    const parts = r.out.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const origin = parts[i]!;
      // The hook's own `-c` safety settings (lib/hook-git.ts) and its process environment: not a model's.
      if (origin === 'command line:') continue;
      if (!origin.startsWith('file:')) return false;
      files.add(origin.slice('file:'.length));
    }
    if (files.size === 0) return false;
    for (const f of files) {
      const real = realpathSync(f);
      if (!rootOnly(real) || !rootOnly(dirname(real))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** For each URL a push to `remote` sends to (`pushUrlsOf`), the commits that URL really has (its branches and tags, as
 *  `git ls-remote` reads them) that this repo holds; null when any URL cannot be read, or git is older than 2.32
 *  (`gitHonorsConfigGlobal`). Run from a dir outside any repo (`NEUTRAL_DIR`) with no user, system or ssh config
 *  (lib/git-run.ts REMOTE_READ_ENV: a program a model set there would run inside the hook); the remote's answer, not the
 *  local remote-tracking refs, which a command can set to anything (`git update-ref refs/remotes/origin/x HEAD` emptied
 *  `--not --remotes`, security delta review). A tip this repo lacks excludes nothing: its commits count as sent, as git
 *  push also sends them (a `git fetch` first narrows that). All URLs share one `LS_REMOTE_MS` budget. */
export function remoteTips(cwd: string, remote: string | undefined, defaultRemote: (cwd: string) => string): string[][] | null {
  if (!gitHonorsConfigGlobal()) return null;
  const urls = pushUrlsOf(cwd, remote, defaultRemote);
  if (urls === null) return null;
  const remoteRead = systemConfigTrusted() ? 'system' : true;
  const end = Date.now() + LS_REMOTE_MS;
  const out: string[][] = [];
  for (const url of urls) {
    const left = end - Date.now();
    if (left <= 0) return null;
    const tips = urlTips(cwd, url, remoteRead, left);
    if (tips === null) return null;
    out.push(tips);
  }
  return out;
}

/** The commits `url` has that this repo holds (see `remoteTips`), or null when it cannot be read in `timeoutMs`. */
function urlTips(cwd: string, url: string, remoteRead: true | 'system', timeoutMs: number): string[] | null {
  const r = spawnGit(NEUTRAL_DIR, ['ls-remote', '--refs', '--', url, 'refs/heads/*', 'refs/tags/*'], { remoteRead, timeoutMs });
  if (r.code !== 0) return null;
  const ids = [...new Set(r.out.split('\n').flatMap((l) => {
    const id = l.split('\t')[0] ?? '';
    return OBJECT_ID.test(id) ? [id] : [];
  }))];
  if (ids.length === 0) return [];
  const known = spawnGit(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${ids.join('\n')}\n` });
  if (known.code !== 0) return null;
  return known.out.split('\n').flatMap((l) => {
    const m = /^([0-9a-f]{40,64}) (?:commit|tag)$/.exec(l);
    return m ? [m[1]!] : [];
  });
}

/** The files (repo-relative, `/` separators, as git spells them) changed in the commits `commit` (an id) sends that the
 *  remote's `tips` (ids this repo holds) do not reach, or null when git cannot list them or they are more than
 *  `MAX_PUSH_FILES`. Git puts nothing between the commits' lists, so every name is a file's (a name with a line break
 *  is kept as it is). The revisions go on stdin (`^<id>` excludes), never as arguments. A merge commit lists the files
 *  it changed against every parent (`--cc`: an edit made in the merge itself, not each file the other parent brought in,
 *  which that parent's own commits list when they are sent; quality delta review: without it a file changed only in a
 *  merge owed nothing). */
export function unpushedFiles(cwd: string, commit: string, tips: readonly string[]): string[] | null {
  if (!OBJECT_ID.test(commit) || !tips.every((t) => OBJECT_ID.test(t))) return null;
  const input = `${commit}\n${tips.map((t) => `^${t}\n`).join('')}`;
  const r = spawnGit(cwd, ['log', '--format=', '--name-only', '--no-renames', '--cc', '-z', '--stdin'], { input, timeoutMs: LS_REMOTE_MS });
  if (r.code !== 0) return null;
  const out = new Set<string>();
  for (const name of r.out.split('\0')) {
    if (name === '') continue;
    out.add(name);
    if (out.size > MAX_PUSH_FILES) return null;
  }
  return [...out];
}

/** The blob id of each `<treeish>:<path>` spec, null when it names no blob (a file deleted there), or null for the
 *  whole call when git cannot answer. A spec with a line break cannot be asked (it would split the batch), so the call
 *  cannot answer then either (a file it names must not read as deleted). */
export function objectIds(cwd: string, specs: readonly string[]): Map<string, string | null> | null {
  if (specs.some((s) => /[\r\n]/.test(s))) return null;
  const asked = [...new Set(specs)];
  const out = new Map<string, string | null>();
  if (asked.length === 0) return out;
  const r = spawnGit(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${asked.join('\n')}\n` });
  if (r.code !== 0) return null;
  const lines = r.out.split('\n');
  for (let i = 0; i < asked.length; i++) {
    const m = /^([0-9a-f]{40,64}) blob$/.exec(lines[i] ?? '');
    out.set(asked[i]!, m ? m[1]! : null);
  }
  return out;
}

/** What a push still owes for the files it sends whose review or test the user deferred. */
export interface DeferredDue {
  /** Deferred-test files with no passing layer-1 record of the pushed tree that lists them (names from the repo top). */
  test: string[];
  /** Deferred-review files with no review of their pushed content (`no-review`), with a high finding on that content
   *  (`high`), or whose newest review of that content failed (`fail`). */
  review: { file: string; why: 'no-review' | 'high' | 'fail' }[];
  /** Why the files could not be judged (git could not list or read them), when it could not. */
  unknown?: string;
}

export interface PushDeferralInput {
  /** The repo's dir (the push's `-C` dir or the shell's). */
  cwd: string;
  /** The repo top, spelled as the project dir is, and its real top (the key of a record's `trees`). */
  top: string;
  realTop: string;
  /** The project dir: a finding's relative `file` resolves against it, as the Stop resolves it. */
  projectDir: string;
  rev: string;
  /** The push's remote as the command names it (absent: the one git uses, `defaultRemote`). */
  remote?: string;
  /** The remote a push that names none uses (lib/push-test.ts pushRemoteOf). */
  defaultRemote: (cwd: string) => string;
  testMatch: DeferMatch;
  reviewMatch: DeferMatch;
  /** Whether layer 1 asks a test for the file (absolute; a code file, not a test file, a doc or an image). Default all. */
  asked?: (abs: string) => boolean;
  /** Passing layer-1 records of the pushed tree (the caller judges "passing" as the push test check does). */
  passing: readonly TestResult[];
  /** Review records, newest first. */
  reviews: readonly ReviewResult[];
  /** Seams for the tests. */
  commit?: (cwd: string, rev: string) => string | null;
  /** One list of tips per URL the push goes to (`remoteTips`). */
  tips?: (cwd: string, remote: string | undefined, defaultRemote: (cwd: string) => string) => string[][] | null;
  files?: (cwd: string, commit: string, tips: readonly string[]) => string[] | null;
  ids?: (cwd: string, specs: readonly string[]) => Map<string, string | null> | null;
}

/** A record's file list as a set of absolute paths, made once per record (asked per file, a list would be read files ×
 *  records times). */
function fileSet(memo: Map<object, Set<string>>, record: object, files: readonly unknown[] | undefined): Set<string> {
  let s = memo.get(record);
  if (s === undefined) {
    s = new Set((Array.isArray(files) ? files : []).flatMap((f) => (typeof f === 'string' ? [recordPath(f)] : [])));
    memo.set(record, s);
  }
  return s;
}

/** The deferred files `rev` sends that still lack their evidence, or null when none does (or nothing is deferred). */
export function deferredDueAtPush(o: PushDeferralInput): DeferredDue | null {
  if (!o.testMatch.any && !o.reviewMatch.any) return null;
  const commit = (o.commit ?? commitOf)(o.cwd, o.rev);
  if (commit === null) return { test: [], review: [], unknown: `git could not resolve ${o.rev}` };
  const tipSets = (o.tips ?? remoteTips)(o.cwd, o.remote, o.defaultRemote);
  if (tipSets === null) {
    return {
      test: [],
      review: [],
      unknown: `git could not read what the remote ${o.remote ?? 'of the push'} has (\`git ls-remote\`; a remote that needs your git or ssh config, or a git older than 2.32, cannot be read)`,
    };
  }
  // The push goes to every URL of the remote: it sends what any one of them lacks.
  let listed: string[] | null = [];
  const seen = new Set<string>();
  for (const tips of tipSets) {
    const k = [...tips].sort().join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    const files = (o.files ?? unpushedFiles)(o.cwd, commit, tips);
    if (files === null) {
      listed = null;
      break;
    }
    listed = [...new Set([...listed, ...files])];
    if (listed.length > MAX_PUSH_FILES) {
      listed = null;
      break;
    }
  }
  if (listed === null) {
    return {
      test: [],
      review: [],
      unknown: `git could not list the files ${o.rev} sends, or they are more than ${MAX_PUSH_FILES} (when the remote has commits this clone lacks, \`git fetch\` first)`,
    };
  }
  const asked = o.asked ?? (() => true);
  const forTest: string[] = [];
  const forReview: string[] = [];
  for (const rel of listed) {
    const abs = join(o.top, ...rel.split('/'));
    if (o.testMatch.test(abs, o.top) && asked(abs)) forTest.push(rel);
    if (o.reviewMatch.test(abs, o.top)) forReview.push(rel);
  }
  if (forTest.length === 0 && forReview.length === 0) return null;
  const ids = o.ids ?? objectIds;
  // A file the pushed commit deletes has no content to test or review.
  const pushed = ids(o.cwd, [...new Set([...forTest, ...forReview])].map((rel) => `${commit}:${rel}`));
  if (pushed === null) return { test: [], review: [], unknown: `git could not read the files ${o.rev} sends` };
  const present = (rel: string): boolean => (pushed.get(`${commit}:${rel}`) ?? null) !== null;
  const keys = new Map<string, string>();
  const key = (rel: string): string => {
    let k = keys.get(rel);
    if (k === undefined) {
      k = recordPath(join(o.top, ...rel.split('/')));
      keys.set(rel, k);
    }
    return k;
  };
  const sets = new Map<object, Set<string>>();
  const test = forTest.filter((rel) => present(rel) && !o.passing.some((r) => hasSpelling('', key(rel), fileSet(sets, r, r.tested_files))));
  const review: DeferredDue['review'] = [];
  const reviewed = forReview.filter(present);
  if (reviewed.length > 0) {
    const treeOf = (r: ReviewResult): string | null => {
      const more = r.trees;
      const t = more !== null && typeof more === 'object' && Object.hasOwn(more, o.realTop) ? more[o.realTop] : r.tree;
      return typeof t === 'string' && OBJECT_ID.test(t) ? t : null;
    };
    const lists = (r: ReviewResult, rel: string): boolean => hasSpelling('', key(rel), fileSet(sets, r, r.reviewed_files));
    const asks: string[] = [];
    for (const r of o.reviews) {
      const t = treeOf(r);
      if (t === null) continue;
      for (const rel of reviewed) if (lists(r, rel)) asks.push(`${t}:${rel}`);
    }
    const seen = asks.length > 0 ? ids(o.cwd, asks) : new Map<string, string | null>();
    if (seen === null) return { test, review: [], unknown: 'git could not read the reviewed trees' };
    // Each review's high findings as absolute paths, made once.
    const highs = new Map<ReviewResult, Set<string>>();
    const highIn = (r: ReviewResult): Set<string> => {
      let s = highs.get(r);
      if (s === undefined) {
        s = new Set((r.findings ?? []).flatMap((f) => (f?.severity === 'high' && typeof f.file === 'string' ? [recordPath(f.file, o.projectDir)] : [])));
        highs.set(r, s);
      }
      return s;
    };
    for (const rel of reviewed) {
      const want = pushed.get(`${commit}:${rel}`);
      const covering = o.reviews.filter((r) => {
        const t = treeOf(r);
        return t !== null && lists(r, rel) && seen.get(`${t}:${rel}`) === want;
      });
      if (covering.length === 0) {
        review.push({ file: rel, why: 'no-review' });
        continue;
      }
      // A high finding on exactly this content is unfixed, whichever review of it came later.
      if (covering.some((r) => highIn(r).has(key(rel)))) review.push({ file: rel, why: 'high' });
      else if (covering[0]!.verdict === 'fail') review.push({ file: rel, why: 'fail' });
    }
  }
  return test.length === 0 && review.length === 0 ? null : { test, review };
}

/** The push's denial for what it still owes (model-facing, English). */
export function deferredDueMessage(what: string, due: DeferredDue, testAgent: string): string {
  const list = (xs: readonly string[]): string => `${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ` and ${xs.length - 5} more` : ''}`;
  const head =
    `${what} sends files whose review or tests the user deferred to the push (\`defer-review\`/\`defer-test\` in ` +
    '.goodboy/policy.md)';
  if (due.unknown !== undefined) return `${head}, and ${due.unknown}, so their evidence cannot be checked. (deferral due at push, N8b)`;
  const parts: string[] = [];
  if (due.test.length > 0) parts.push(`tests: ${list(due.test)} (no passing layer-1 record of the pushed tree lists them; run ${testAgent} on them)`);
  const of = (why: DeferredDue['review'][number]['why']): string[] => due.review.filter((r) => r.why === why).map((r) => r.file);
  const missing = of('no-review');
  const high = of('high');
  const failed = of('fail');
  if (missing.length > 0) parts.push(`review: ${list(missing)} (no review of the content pushed; run the \`review-axes\` plan on them)`);
  if (high.length > 0) parts.push(`review: ${list(high)} (an open high finding on the content pushed; fix it and review again)`);
  if (failed.length > 0) parts.push(`review: ${list(failed)} (the newest review of the content pushed failed; fix what it found and review again)`);
  return `${head}; the push is where they are due, and this evidence is missing: ${parts.join('; ')}. Then push again. (deferral due at push, N8b)`;
}
