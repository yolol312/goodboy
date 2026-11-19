// The PreToolUse rule for sandboxes that may hold real data (track M, M6b; plan §19): a model has no ordinary path to
// the data. `sandbox-data` and `sandbox-run` are the paths; this rule denies the others, in two contexts.
//
// The LOCAL context is a real-data project found by walking up from the call's dirs (the shell's dir, the project dir,
// CLAUDE_PROJECT_DIR, each segment's dir, each path a word names or an assignment holds) whose own `local.json` says real
// data (lib/sandbox-mode.ts `realDataForReading`), or that the registry holds (its `.goodboy/sandbox` or `local.json` may
// be gone). Everything applies there:
//   - docker, podman, nerdctl and compose verbs that open, copy out, log, inspect or run beside the sandbox's
//     containers (`exec cp logs inspect attach export commit run create start top diff save debug checkpoint mount`, and
//     `volume export` and `volume mount`; also as `docker container <verb>`), and an attached
//     `compose up` (it streams logs), when the target is the sandbox: any word of the command naming its project, a
//     `gb-` name or `.goodboy/sandbox` (env assignments and `export` included), a `-f`, `--file`, `--project-directory`
//     or `--env-file` that resolves into the sandbox dir, a cwd inside it, `--volumes-from`, `container:`; and for the
//     verbs that take a container, an operand that is a variable, a hex id or a placeholder, or no operand at all
//     (`xargs` supplies it): such a target cannot be told from a sandbox container;
//   - a program that runs its arguments or stdin as a command and that the shell reader does not open (`watch`,
//     `colima ssh`, `limactl shell`, `ssh`, `script`, `unbuffer`, `tmux`, `screen`, `su -c`, `at`, `batch`, `parallel`, a
//     shell reading stdin) beside docker text with a deny verb;
//   - a program that opens a unix socket from a path it is given (`curl --unix-socket`, `socat`, `nc -U`) on the docker
//     socket; `DOCKER_HOST` in the environment of another program and text in `git`, `echo` or `grep` are no use of it;
//   - database clients (`psql mysql mariadb mongosh pg_dump mysqldump`) pointed at a sandbox host (`db`, `db2`, `gb-*`);
//   - the raw files a sandbox left on the host (`out/live/`, `out/<ts>/` + HOST_RAW_NAMES) in Read, Grep, Glob and any
//     word; recursive readers (`grep -r`, `tar`, `cp -r`, `rsync`, `zip`, `find -exec`, `ack`) over `out/` or over a dir that
//     holds it (the project, `.goodboy`, `.goodboy/sandbox`), and names a substitution, a pipe or `xargs` feeds them, while
//     some are left; `rg`, `ag` and the Grep tool skip the ignored `out/` of a git repository (`out/` in the sandbox's
//     `.gitignore`) unless told not to. The deny text says the files are leftovers and how they go;
//   - a `docker run`, `create` or `compose run` that binds the host's `/` or an engine's data or socket (`/var`, `/var/lib/docker*`,
//     `/var/lib/containers*`, `/run/podman*`, any path ending in `docker.sock`, links followed), or is `--privileged` or
//     `--pid=host`, with no sandbox word: such a container reaches every container's volumes. This is for a real-data project
//     only, not machine-wide: it would stop every other project's containers. The options after the image are read too, so
//     `docker run alpine rsync -av /var /backup` is held by its `-v`; `--device`, `--cap-add` and `--security-opt` are not read;
//   - a command the rule cannot read in time: a word over 2048 characters, a segment of more than 400 words, a command
//     over 100 KB, glob matching past the call's work budget.
// Every guarded context, this one and the next, denies:
//   - any word that resolves (links followed, `~`, `$HOME` and `cd "$HOME/…"` expanded, braces and globs expanded,
//     NFC-normalized) to a dump or a registered input log, a word or the value of an assignment that holds one of those
//     absolute paths as text ending at a path boundary (`DUMP=/path; head $DUMP`), a recursive reader (`grep -r`, `rg`,
//     `ag`, `ack`, `tar`, `zip`, `cp -r`, `rsync`, `scp`, `find -exec`) over a dir that holds one, and a reader with no
//     file operand or a name a substitution builds (`ls | xargs cat`, `cat $(ls)`) in such a dir; `ls`, `stat`, `test` on
//     them pass, and `wc`, `du` and `file` with options that print a count, a size or a type only (SAFE_OPTIONS; not
//     `file -f`, `-m`, `wc --files0-from`: they show the file's lines in an error text); a glob is matched as text against
//     the protected paths, and in a project that holds real data also expanded on disk with each match judged with its links
//     followed (`*/dump.sql` through a link to the dumps; a call whose globs need more than 20,000 directory entries or 2,000
//     matches is denied, to be narrowed); a group in a word (`@(a|b)`, `(a|b)`) is held when its dir holds a protected path;
//     a link made to a protected path or a dir that holds one (`ln -s`, `cp -s`, a link moved or copied as a link); a `docker run` or `create` (and `compose run`) that binds a protected path,
//     a dir above one or the registry dir (`-v`, `--volume`, `--mount source=`, links followed);
//   - Read, Grep and Glob (a subagent's too) on those.
// The registry file and its dir are changed by no tool call (Write, Edit, MultiEdit, NotebookEdit, and a shell segment with
// a program that is no reader and a word naming them, a redirect into them, a glob listing them, `rm` or `mv` of a dir above
// them), in any context. Reading them, and recursive readers over `~` or `~/.claude`, pass: they hold paths, not data.
// The REGISTRY-ONLY context is a project of the user-level registry (lib/sandbox-registry.ts) that the call's dirs do not
// belong to: there only (a) docker deny verbs with a word of the command or an assignment that names that project's exact
// name (`gb-<slug>-<hash>`, whole or as the prefix of `<name>-<svc>-<n>` and `<name>_<vol>`), (b) its protected paths, and (c) the
// data binds of a `docker run` or `create` (a bind of a protected path, a dir above one, or the registry dir; not the engine rules).
// No generic `gb-` rule, no unknown-container rule, no wrappers, no socket rule, no database host rule, and the size caps
// only when a cwd or segment dir holds a protected path (a relative spelling could reach it): a plain project behaves as
// with an empty registry. The rule applies to any tool whose input has a shell `command` (Bash, Monitor, PowerShell).
//
// goodboy's own commands (`bun …/lib/cli.ts sandbox-*`, the path being this guard's own lib/cli.ts or one spelled from
// `$GB` or `$CLAUDE_PLUGIN_ROOT`) pass: they hold the boundary. The rule is advisory against a program written to get
// around it (plan §19 M6): it closes the ordinary paths; the deliberate forms are listed in the plan. The user's
// one-use marker (`sandbox-data`) and GOODBOY_SANDBOX_DATA_GATE=off are the ways past it. One hit is no reach of data and
// has no way past: a command that sets the switch of the privacy run gate (M6g, `setsGateSwitch`), denied in every
// context with a fixed text (`DataGuardHit.fixed`), because the CLI reads that switch from its process environment.
//
// Pure: the hook calls `sandboxDataDenial` and decides what to do with the answer.

import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { followedPath } from './file-tracker';
import { homeOf, plainWord, readCommand, readPrefix, shellReadsStdin, stripPrefix } from './outward-command';
import { projectDir } from './project-dir';
import { readRegular } from './safe-read';
import { HOST_RAW_NAMES, projectName, readLocal, realDataForReading, realOrSelf, RUN_NAME, SANDBOX_DIR } from './sandbox-mode';
import { readRegistry, RegistryError, type RegistryEntry, registryDir, registryFile } from './sandbox-registry';

export interface DataGuardHit {
  /** What was reached, in a few words for the log and the deny text. */
  what: string;
  /** The dirs of the guarded projects whose sandbox holds what the call reached, when that is not the project
   *  `sandbox-data` answers for from the shell's dir now (see `located`): it answers for the dir it runs in, so a `cd`
   *  into one of these reaches its sandbox. Absent when the hit is taken as the session's own project's. */
  from?: string[];
  /** Such dirs nested inside the session's project dir: `sandbox-data` answers for the session's project anywhere below
   *  it, so no `cd` reaches their sandbox from this session; only a session started in that dir does. */
  nested?: string[];
  /** A hit that is no reach of data and has a fixed text of its own (the deny text is this, whatever the context; no
   *  approval marker applies): a command that sets a goodboy gate switch. */
  fixed?: string;
}

/** A sandbox project the call may reach. */
interface Guarded {
  project: string;
  /** The project's dir, as the registry or the walk found it. */
  top: string;
  sandboxDir: string;
  /** A registered project the call is not in: its protected paths, to tell which project a call named. */
  paths?: readonly string[];
}

/** What must not be reached: the dumps and the input logs of every guarded project. */
interface Protected {
  /** Each path as typed and as resolved, NFC-normalized. */
  all: string[];
  /** `all` as compared (lower-cased on a case-insensitive volume). */
  normed: string[];
  /** The sets of `normed`, one for the registry's paths (cached) and one for the project's own. */
  exact: ReadonlySet<string>[];
  /** The registered inputs that are directories: everything below them is protected. */
  dirs: string[];
  /** The text a word may hold: each path as compared, and its `~/`, `$HOME/` and `${HOME}/` spellings. */
  needles: string[];
  /** The dir of each path, as compared, with its trailing `/` (a name built below it by a group or a substitution). */
  dirNeedles: string[];
}

interface Context {
  /** Projects found from the call's dirs whose local file says real data, or that the registry holds. */
  local: Guarded[];
  /** Registered projects the call's dirs do not belong to. */
  remote: Guarded[];
  prot: Protected;
  /** The work left for matching globs against protected paths in this call (in cells of the matcher), and whether it ran out. */
  work: { left: number; over: boolean };
  /** What the call may spend expanding its globs on disk (`expandGlob`): directory entries left, the time it may take (`until`, set
   *  at the first expansion), what it already expanded, and why one could not be (`over`: past a budget, or unreadable). */
  fs: { left: number; over: false | 'big' | 'unreadable'; until: number; cache: Map<string, string[] | 'big' | 'unreadable'> };
  /** The words of the call (a Bash call's first 1600, as `sandboxDataDenial` reads them), read only when a call is denied:
   *  the registered projects it names. */
  words: readonly string[];
  /** Where `sandbox-data` answers from the shell's dir now and from a `cd` (`lib/cli.ts`: the repo top of `cliProjectDir`):
   *  `answers` is the hook's project dir (CLAUDE_PROJECT_DIR when the shell is inside it, else the shell's dir, a linked
   *  worktree being its own), and `roots` the session's project dirs as the CLI knows them (CLAUDE_PROJECT_DIR), each
   *  answered for anywhere below it. */
  answers: string;
  roots: readonly string[];
}

const MAX_WORDS = 400;
const MAX_WORD = 2048;
const MAX_COMMAND = 100_000;
/** The project dirs a deny text lists before "and N more". */
const MAX_FROM_SHOWN = 3;
const MAX_REPOS = 4;
const MAX_WALK = 40;
/** The words a segment is read to in a context where the caps do not apply: a bound on the time, not a denial. */
const UNCAPPED_WORDS = 2000;
const TOO_LONG = 'a command too long to check (split it)';

/** A path as compared: NFC (a Korean name typed decomposed reaches the same file on APFS), lower-cased on macOS. */
const norm = (p: string): string => (process.platform === 'darwin' ? p.normalize('NFC').toLowerCase() : p.normalize('NFC'));

const isDirSync = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Whether a path is a link itself (not what it leads to), false when it is not there. */
const isLinkSync = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

const inside = (p: string, base: string): boolean => {
  const a = norm(p);
  const b = norm(base);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

// ---- globs: a linear matcher (a regular expression per `*` backtracks exponentially on a run of stars) ----

type Tok = { k: 'star'; deep: boolean } | { k: 'any' } | { k: 'lit'; c: string } | { k: 'set'; neg: boolean; ranges: [string, string][]; classes: string[] };

const MAX_ALTS = 64;

/** `{a,b}` expanded, nested too; a brace with no top-level comma stays as it is. Null past 64 alternatives. */
function braceExpand(s: string): string[] | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] !== '{') continue;
    let depth = 0;
    let end = -1;
    const commas: number[] = [];
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '\\') j++;
      else if (d === '{') depth++;
      else if (d === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (d === ',' && depth === 1) commas.push(j);
    }
    if (end < 0 || commas.length === 0) continue;
    const parts: string[] = [];
    let from = i + 1;
    for (const k of commas) {
      parts.push(s.slice(from, k));
      from = k + 1;
    }
    parts.push(s.slice(from, end));
    const out: string[] = [];
    for (const part of parts) {
      const sub = braceExpand(s.slice(0, i) + part + s.slice(end + 1));
      if (sub === null) return null;
      out.push(...sub);
      if (out.length > MAX_ALTS) return null;
    }
    return out;
  }
  return [s];
}

/** `**` + `/` also matches zero directories (zsh, bash with globstar): `a/**` + `/b` matches `a/b`. */
function zeroDirs(s: string): string[] | null {
  const i = s.indexOf('**/');
  if (i < 0) return [s];
  const tail = zeroDirs(s.slice(i + 3));
  if (tail === null) return null;
  const head = s.slice(0, i);
  const out = [...tail.map((t) => `${head}**/${t}`), ...tail.map((t) => head + t)];
  return out.length > MAX_ALTS ? null : out;
}

/** What a glob stands for after braces and `**` + `/`, or null past the bound. */
function alternatives(glob: string): string[] | null {
  const braced = braceExpand(glob);
  if (braced === null) return null;
  const out: string[] = [];
  for (const b of braced) {
    const z = zeroDirs(b);
    if (z === null) return null;
    out.push(...z);
    if (out.length > MAX_ALTS) return null;
  }
  return out;
}

const POSIX_CLASSES: Record<string, RegExp> = {
  alpha: /[A-Za-z]/,
  digit: /[0-9]/,
  alnum: /[A-Za-z0-9]/,
  upper: /[A-Za-z]/, // a case-insensitive volume lower-cases the text: both cases are letters
  lower: /[A-Za-z]/,
  space: /[ \t\n\v\f\r]/,
  blank: /[ \t]/,
  punct: /[!-/:-@[-`{-~]/,
  xdigit: /[0-9A-Fa-f]/,
  cntrl: /[\u0000-\u001f\u007f]/,
  graph: /[!-~]/,
  print: /[ -~]/,
};

/** One bracket expression at `g[i]` (`[`): its token and the index of its closing `]`; 'literal' when it is not closed
 *  (the `[` is a plain character); null when it cannot be read (a range backwards, a class that does not exist). */
function bracket(g: string, i: number): { tok: Tok; end: number } | 'literal' | null {
  let j = i + 1;
  const neg = g[j] === '!' || g[j] === '^';
  if (neg) j++;
  const first = j;
  const ranges: [string, string][] = [];
  const classes: string[] = [];
  for (; j < g.length; j++) {
    const c = g[j]!;
    if (c === ']' && j > first) return { tok: { k: 'set', neg, ranges, classes }, end: j };
    if (c === '[' && g[j + 1] === ':') {
      const close = g.indexOf(':]', j + 2);
      if (close < 0) {
        ranges.push(['[', '[']);
        continue;
      }
      const name = g.slice(j + 2, close);
      if (POSIX_CLASSES[name] === undefined) return null;
      classes.push(name);
      j = close + 1;
      continue;
    }
    if (g[j + 1] === '-' && j + 2 < g.length && g[j + 2] !== ']') {
      if (c > g[j + 2]!) return null;
      ranges.push([c, g[j + 2]!]);
      j += 2;
    } else ranges.push([c, c]);
  }
  return 'literal';
}

/** A shell glob as tokens: `*` (a run of one stays inside a path part; a run of two or more, `**`, crosses `/`), `?`, `[...]`
 *  with ranges, `[!...]` and POSIX classes, `\x` is `x`. Null for a pattern over the word cap, a class that cannot be
 *  read, or an extended glob (`@(` `!(` `+(` `*(` `?(`), which the matcher does not know. */
function compileGlob(glob: string): Tok[] | null {
  if (glob.length > MAX_WORD || /[@!+*?]\(/.test(glob)) return null;
  const g = norm(glob);
  const toks: Tok[] = [];
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      let n = 1;
      while (g[i + 1] === '*') {
        i++;
        n++;
      }
      const last = toks[toks.length - 1];
      if (last?.k === 'star') last.deep ||= n > 1;
      else toks.push({ k: 'star', deep: n > 1 });
    } else if (c === '?') toks.push({ k: 'any' });
    else if (c === '\\' && i + 1 < g.length) toks.push({ k: 'lit', c: g[++i]! });
    else if (c === '[') {
      const b = bracket(g, i);
      if (b === null) return null;
      if (b === 'literal') toks.push({ k: 'lit', c });
      else {
        toks.push(b.tok);
        i = b.end;
      }
    } else toks.push({ k: 'lit', c });
  }
  return toks;
}

/** Whether one text character fits a token that is not a star: a `?` or a class never takes a `/`. */
function oneChar(t: Exclude<Tok, { k: 'star' }>, ch: string): boolean {
  if (t.k === 'lit') return t.c === ch;
  if (ch === '/') return false;
  if (t.k === 'any') return true;
  return (t.ranges.some(([a, b]) => ch >= a && ch <= b) || t.classes.some((n) => POSIX_CLASSES[n]!.test(ch))) !== t.neg;
}

/** Whether the tokens match the whole text. The stars differ (`**` crosses `/`, `*` does not), so one star to go back to is
 *  not enough (`**\/*.sql` against `a/b/dump.sql`): the match is simulated with the set of token positions the text so far
 *  can be at, one pass over the text, O(text x tokens) and no backtracking. */
function matchTokens(toks: readonly Tok[], text: string): boolean {
  const n = toks.length;
  let cur = new Uint8Array(n + 1);
  let next = new Uint8Array(n + 1);
  // a star may match nothing: the position after it is reached with it
  const close = (at: Uint8Array): void => {
    for (let j = 0; j < n; j++) if (at[j] === 1 && toks[j]!.k === 'star') at[j + 1] = 1;
  };
  cur[0] = 1;
  close(cur);
  for (const ch of norm(text)) {
    next.fill(0);
    let any = false;
    for (let j = 0; j < n; j++) {
      if (cur[j] !== 1) continue;
      const t = toks[j]!;
      if (t.k === 'star') {
        if (t.deep || ch !== '/') {
          next[j] = 1;
          any = true;
        }
      } else if (oneChar(t, ch)) {
        next[j + 1] = 1;
        any = true;
      }
    }
    if (!any) return false;
    close(next);
    [cur, next] = [next, cur];
  }
  return cur[n] === 1;
}

/** Whether a shell glob matches a path, braces, `**` and classes included; null when the glob cannot be read (too long,
 *  more than 64 alternatives, a class backwards, an extended glob). Exported for tests/m6b-glob.test.ts: the table of bash results
 *  is checked against this function itself, which no call of the rule reaches as plainly. */
export function globMatches(glob: string, path: string): boolean | null {
  const alts = alternatives(glob);
  if (alts === null) return null;
  let any = false;
  for (const a of alts) {
    const toks = compileGlob(a);
    if (toks === null) return null;
    any ||= matchTokens(toks, path);
  }
  return any;
}

const GLOB_CHARS = /[*?[{]|[@!+]\(/;
const hasGlob = (p: string): boolean => GLOB_CHARS.test(p);

// ---- which projects, and what they protect ----

/** The nearest dir at or above `dir` that holds `.goodboy/sandbox`, or null. */
function sandboxTopOf(dir: string, cache: Map<string, string | null>): string | null {
  const start = resolve(dir);
  if (cache.has(start)) return cache.get(start)!;
  let cur = start;
  let found: string | null = null;
  for (let i = 0; i < MAX_WALK; i++) {
    if (isDirSync(join(cur, SANDBOX_DIR))) {
      found = cur;
      break;
    }
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  cache.set(start, found);
  return found;
}

/** The path a word names: `~` and `$HOME` expanded, relative to `dir`; null when it holds another variable or a
 *  substitution (it cannot be told). */
function pathOfWord(w: string, dir: string): string | null {
  let p = w;
  const home = homeOf();
  if (p === '~' || p.startsWith('~/')) p = join(home, p.slice(1));
  else if (p.startsWith('$HOME/') || p === '$HOME') p = join(home, p.slice(5));
  else if (p.startsWith('${HOME}/') || p === '${HOME}') p = join(home, p.slice(7));
  if (/[$`]/.test(p)) return null;
  return isAbsolute(p) ? p : resolve(dir, p);
}

/** An operator glued to its target (`<dump.sql`, `2>out`): the target is the word. */
const REDIRECT_PREFIX = /^\d*(?:&?>>?\|?|<<?<?|>&|<&)/;
/** The value of `--opt=value` or `key=value`, else the word itself. */
const valueOf = (w: string): string => {
  const eq = w.indexOf('=');
  return eq > 0 && !w.startsWith('/') && !w.startsWith('.') ? w.slice(eq + 1) : w.replace(REDIRECT_PREFIX, '');
};

/** The real path the OS reaches for `p`, when it exists (links followed as the OS does), else `p`. */
const realOf = (p: string): string => (existsSync(p) ? (followedPath(p) ?? p) : p);

/** The cells of glob matching one call may spend (the matcher costs tokens x characters per protected path). */
const WORK_CELLS = 3_000_000;

/** A registry's paths as the rule compares them, built once for a registry file (its mtime, size and inode) and kept. */
interface RegistryBase {
  entries: RegistryEntry[];
  tops: string[];
  paths: string[];
  normed: string[];
  exact: Set<string>;
  dirs: string[];
  needles: string[];
  dirNeedles: string[];
}

/** The text a word may hold of each path: as compared, and its `~/`, `$HOME/` and `${HOME}/` spellings (compared the same way). */
function needlesOf(paths: readonly string[]): string[] {
  const home = norm(homeOf());
  const out = new Set<string>();
  for (const p of paths) {
    const q = norm(p);
    out.add(q);
    if (q.startsWith(home + sep)) for (const spelling of ['~', '$HOME', '${HOME}']) out.add(norm(spelling + q.slice(home.length)));
  }
  return [...out];
}

/** The dir of each path, as compared, with its trailing `/`. */
const dirNeedlesOf = (paths: readonly string[]): string[] => [...new Set(paths.map((p) => `${norm(dirname(p))}/`).filter((d) => d !== '//' && d.length > 3))];

let registryCache: { key: string; base: RegistryBase } | null = null;

/** The registry as the rule uses it, or an error when it cannot be read. The same registry file is not rebuilt per call. */
function registryBase(): RegistryBase | RegistryError {
  const file = registryFile();
  let stamp = 'absent';
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    // no file
  }
  const key = `${file}|${stamp}|${homeOf()}|${process.platform}`;
  if (registryCache?.key === key) return registryCache.base;
  const entries = readRegistry();
  if (entries instanceof RegistryError) return entries;
  const paths = entries.flatMap((e) => e.paths);
  const base: RegistryBase = { entries, tops: entries.map((e) => e.top), paths, normed: paths.map(norm), exact: new Set(paths.map(norm)), dirs: entries.flatMap((e) => e.dirs), needles: needlesOf(paths), dirNeedles: dirNeedlesOf(paths) };
  registryCache = { key, base };
  return base;
}

/** The projects this call may reach, and what they protect (see the header). `note` hears of a registry that cannot be
 *  read: the rule then keeps the per-repo reading only. */
function contextFor(dirs: readonly string[], words: readonly string[], cwd: string, where: Pick<Context, 'answers' | 'roots'>, note?: (n: string) => void): Context {
  const registry = registryBase();
  if (registry instanceof RegistryError) note?.('registry-unreadable');
  const base = registry instanceof RegistryError ? null : registry;
  const paths: string[] = [];
  const pdirs: string[] = [];
  const protect = (p: string): void => {
    for (const v of new Set([resolve(p), realOrSelf(p)])) {
      paths.push(v.normalize('NFC'));
      if (isDirSync(v)) pdirs.push(v.normalize('NFC'));
    }
  };
  // the projects of the call's own dirs and paths: where `.goodboy/sandbox` is, and the tops the registry knows (their sandbox
  // dir may be gone)
  const cache = new Map<string, string | null>();
  const tops = new Set<string>();
  const add = (d: string): void => {
    const t = sandboxTopOf(d, cache) ?? base?.tops.find((top) => inside(d, top)) ?? null;
    if (t !== null && tops.size < MAX_REPOS) tops.add(t);
  };
  for (const d of dirs) add(d);
  let n = 0;
  for (const w of words) {
    if (n >= MAX_WORDS) break;
    if (w.length > MAX_WORD || !w.includes('/')) continue;
    n++;
    const p = pathOfWord(valueOf(plainWord(w)), cwd);
    if (p !== null) add(isDirSync(p) ? p : dirname(p));
  }
  const registered = new Set(base?.tops ?? []);
  const local = new Map<string, Guarded>();
  for (const top of tops) {
    // a project the registry holds stays real data for the walk even when its local file is gone or says plain
    if (!realDataForReading(top) && !registered.has(realOrSelf(top))) continue;
    const real = realOrSelf(top);
    local.set(real, { project: projectName(top), top, sandboxDir: join(top, SANDBOX_DIR) });
    const l = readLocal(top);
    if (!(l instanceof Error)) for (const p of [...(l.dump !== null ? [l.dump] : []), ...(l.inputs ?? [])]) protect(p);
  }
  // the registry: every path it holds is protected wherever the shell is; a project the call's dirs do not belong to is
  // guarded by its own name only
  const remote: Guarded[] = [];
  for (const e of base?.entries ?? []) if (!local.has(e.top)) remote.push({ project: e.project, top: e.top, sandboxDir: join(e.top, SANDBOX_DIR), paths: e.paths });
  const normed = paths.map(norm);
  const prot: Protected = {
    all: [...(base?.paths ?? []), ...paths],
    normed: [...(base?.normed ?? []), ...normed],
    exact: [...(base ? [base.exact] : []), new Set(normed)],
    dirs: [...(base?.dirs ?? []), ...pdirs],
    needles: [...(base?.needles ?? []), ...needlesOf(paths)],
    dirNeedles: [...(base?.dirNeedles ?? []), ...dirNeedlesOf(paths)],
  };
  return { local: [...local.values()], remote, prot, work: { left: WORK_CELLS, over: false }, fs: { left: FS_ENTRIES, over: false, until: 0, cache: new Map() }, words, ...where };
}

/** The dir a glob lists: what is before its first glob character, up to the last `/`. */
function headDir(pattern: string): string {
  const at = pattern.search(GLOB_CHARS);
  const head = at < 0 ? pattern : pattern.slice(0, at);
  return head.endsWith(sep) ? head : dirname(head);
}

/** What a glob names before its first glob character or backslash: a path it matches starts with it. */
const literalPrefix = (glob: string): string => {
  const cuts = [glob.search(GLOB_CHARS), glob.indexOf('\\')].filter((i) => i >= 0);
  return cuts.length > 0 ? glob.slice(0, Math.min(...cuts)) : glob;
};

/** Whether a protected file is the path or below it (a dir that holds the dump or an input log). */
function holdsProtected(prot: Protected, path: string): boolean {
  const real = realOf(path);
  return prot.all.some((p) => inside(p, real) || inside(p, path));
}

/** Whether a path (or a glob that can match one) names a protected file: a dump, an input log, inside an input dir. A glob
 *  the matcher cannot read (an extended glob in a Glob or Grep tool pattern; in a shell word the reader has split it at the
 *  parenthesis already, see `groupAfterDir`) is held when the dir it lists holds a protected path. The matching is bounded by
 *  the call's work budget (`cx.work`) and, for the expansion on disk, its directory budget (`cx.fs`): past either nothing more
 *  is matched and the caller reads `overBudget`. */
function protectedHit(cx: Context, path: string, glob: boolean): boolean {
  const prot = cx.prot;
  if (prot.all.length === 0) return false;
  if (!glob) {
    return [path, realOf(path)].some((p) => {
      const n = norm(p);
      return prot.exact.some((set) => set.has(n)) || prot.dirs.some((d) => inside(p, d));
    });
  }
  // the dir the glob lists may be (or pass through) a link: the pattern is also judged with that part resolved, as a plain path is
  const listed = headDir(path);
  const dirPart = listed.length > 1 && listed.endsWith(sep) ? listed.slice(0, -1) : listed;
  const realDir = realOf(dirPart);
  if (globHit(cx, path) || (realDir !== dirPart && globHit(cx, (realDir === sep ? '' : realDir) + path.slice(dirPart.length)))) return true;
  // a link anywhere in the pattern (`*/dump.sql` with `dl` a link to the dumps, `h*/dumps/*`): in a project that holds real data
  // the pattern is expanded on disk and each match judged as a plain path, links followed. A shell in another project (the
  // registry-only context) judges the pattern as text, as above: no walk of its dirs. Past the budget the call is denied
  // (`cx.fs.over`, read by `overBudget`): a glob that large cannot be told from one that reaches a protected path.
  if (cx.local.length === 0) return false;
  const found = expandGlob(cx, path);
  // (a string: the glob could not be expanded, `cx.fs.over` says why and `overBudget` denies the call)
  return typeof found !== 'string' && found.some((p) => protectedHit(cx, p, false));
}

/** What a call's globs may cost to expand on disk: directory entries read (a link followed costs LINK_COST of them), matches of
 *  one glob, the matcher's work (charged to the call's work budget like the text matching) and WALL_MS of time, well under the
 *  hook's timeout (a call that runs out of it would run). Past any, the call is denied (see `protectedHit`). */
const FS_ENTRIES = 20_000;
const MAX_MATCHES = 2000;
const LINK_COST = 50;
const WALL_MS = 2000;
const GLOB_TOO_BIG = 'a glob that matches too much to check (narrow the pattern)';
const GLOB_UNREADABLE = 'a glob the rule cannot read (a bracket range that runs backwards, an unknown class, an extended glob, more than 64 alternatives): write the path out or simplify the pattern';

/** Why a call is denied for its size or a glob it cannot read: in a project that holds real data. */
function overBudget(cx: Context): string | null {
  if (cx.local.length === 0) return null;
  return cx.work.over ? TOO_LONG : cx.fs.over === 'unreadable' ? GLOB_UNREADABLE : cx.fs.over === 'big' ? GLOB_TOO_BIG : null;
}

/** What a glob matches on disk, links followed as the shell follows them (`**` too, which some shells do not: the rule reads
 *  what any of them could), or why it cannot be told: 'big' (more than MAX_MATCHES matches, the call's directory, work or time
 *  budget spent), 'unreadable' (a class that cannot be read, an extended glob, more than 64 alternatives); `cx.fs.over` is then
 *  set. Only existing names are returned. Hidden names are matched by `*` (the shell would not: more held, not less). Each link
 *  looked up (`holdsProtected`: a real path) is charged LINK_COST entries, each name tried against a pattern its tokens x its
 *  length to the work budget. An expansion is kept for the call (the same glob is asked for by more than one rule). */
function expandGlob(cx: Context, pattern: string): string[] | 'big' | 'unreadable' {
  const kept = cx.fs.cache.get(pattern);
  if (kept !== undefined) return kept;
  const result = expandUncached(cx, pattern);
  cx.fs.cache.set(pattern, result);
  if (typeof result === 'string') cx.fs.over = cx.fs.over === 'unreadable' || result === 'unreadable' ? 'unreadable' : 'big';
  return result;
}

function expandUncached(cx: Context, pattern: string): string[] | 'big' | 'unreadable' {
  const alts = alternatives(pattern);
  if (alts === null) return 'unreadable';
  const out: string[] = [];
  let ok = true;
  let why: 'big' | 'unreadable' = 'big';
  if (cx.fs.until === 0) cx.fs.until = Date.now() + WALL_MS;
  let ticks = 0;
  // the time budget, looked at every 16 steps
  const late = (): boolean => {
    if (ok && ++ticks % 16 === 0 && Date.now() > cx.fs.until) ok = false;
    return !ok;
  };
  const list = (dir: string): string[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    cx.fs.left -= names.length + 1;
    if (cx.fs.left < 0 || Date.now() > cx.fs.until) ok = false;
    return ok ? names : [];
  };
  const found = (p: string): void => {
    out.push(p);
    if (out.length > MAX_MATCHES) ok = false;
  };
  const isDir = (p: string): boolean => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  // whether what a link leads to holds a protected path, the real-path walk charged to the budget
  const linkHolds = (p: string): boolean => {
    cx.fs.left -= LINK_COST;
    if (cx.fs.left < 0) {
      ok = false;
      return false;
    }
    return holdsProtected(cx.prot, p);
  };
  const walk = (cur: string, segs: readonly string[], i: number): void => {
    if (!ok) return;
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (seg === '.') return last ? found(cur) : walk(cur, segs, i + 1);
    if (seg === '..') {
      const up = dirname(followedPath(cur) ?? cur);
      return last ? found(up) : walk(up, segs, i + 1);
    }
    if (/^\*{2,}$/.test(seg)) {
      // zero or more dirs, then the rest; as the last part, every name below
      const seen = new Set<string>();
      const queue = [cur];
      for (let q = 0; q < queue.length && !late(); q++) {
        const d = queue[q]!;
        const names = list(d);
        if (last) for (const n of names) found(join(d, n));
        else walk(d, segs, i + 1);
        for (const n of names) {
          const child = join(d, n);
          // a linked dir is entered only when what it leads to holds a protected path (any other cannot lead to one), and once
          //   (a link back up would loop); a plain dir is entered as it is, the tree below it has no loop
          if (isLinkSync(child)) {
            if (!isDir(child) || !linkHolds(child)) continue;
            const real = followedPath(child) ?? child;
            if (seen.has(real)) continue;
            seen.add(real);
            queue.push(child);
          } else if (isDirSync(child)) queue.push(child);
        }
      }
      return;
    }
    if (!/[*?[\\]/.test(seg)) {
      const next = join(cur, seg);
      if (last) {
        try {
          lstatSync(next);
          found(next);
        } catch {
          // no such name
        }
      } else walk(next, segs, i + 1);
      return;
    }
    const toks = compileGlob(seg);
    if (toks === null) {
      ok = false;
      why = 'unreadable';
      return;
    }
    for (const n of list(cur)) {
      if (late()) return;
      // the matcher's work, charged as the text matching of globs is: a long pattern over many long names would take minutes
      cx.work.left -= (toks.length + 1) * (n.length + 1);
      if (cx.work.left < 0) {
        ok = false;
        return;
      }
      if (!matchTokens(toks, n)) continue;
      const next = join(cur, n);
      if (last) found(next);
      else if (isDir(next)) {
        // a link is looked up (and charged) so that the budget counts the real paths it costs; the walk enters it either way
        if (isLinkSync(next)) linkHolds(next);
        walk(next, segs, i + 1);
      }
    }
  };
  for (const alt of alts) {
    if (!isAbsolute(alt)) return 'unreadable';
    const segs = alt.split(sep).filter((s) => s !== '');
    if (segs.length === 0) continue;
    walk(sep, segs, 0);
    if (!ok) return why;
  }
  return out;
}

/** The glob half of `protectedHit`, for a pattern as spelled. */
function globHit(cx: Context, path: string): boolean {
  const prot = cx.prot;
  const listed = headDir(path);
  const alts = alternatives(path);
  const compiled = alts === null ? null : alts.map((a) => ({ toks: compileGlob(a), prefix: norm(literalPrefix(a)) }));
  if (compiled === null || compiled.some((c) => c.toks === null)) return prot.all.some((t) => inside(t, listed));
  // only a protected path that starts with the glob's literal head can be matched by it
  for (const { toks, prefix } of compiled) {
    for (let i = 0; i < prot.all.length; i++) {
      if (!prot.normed[i]!.startsWith(prefix)) continue;
      cx.work.left -= (toks!.length + 1) * (prot.normed[i]!.length + 1);
      if (cx.work.left < 0) {
        cx.work.over = true;
        return false;
      }
      if (matchTokens(toks!, prot.all[i]!)) return true;
    }
  }
  // inside an input dir, what the pattern lists is a log
  return prot.dirs.some((d) => inside(listed, d));
}

/** The characters that end a path in a word: a protected path is held as text when one of them (or the end) follows it, so
 *  `~/Downloads` is not `~/Downloads2`, `~/Downloads-old` or `~/Downloads.bak`. */
const PATH_END = /[\s/'"`;|&()<>,:=*?[\]{}$!\\]/;

/** Whether a word holds a protected absolute path (or its `~/` or `$HOME/` spelling) as text, ending at a path boundary. */
const holdsText = (prot: Protected, text: string): boolean => {
  if (!text.includes('/')) return false;
  const n = norm(text);
  for (const nd of prot.needles) {
    for (let at = n.indexOf(nd); at >= 0; at = n.indexOf(nd, at + 1)) {
      const next = n[at + nd.length];
      if (next === undefined || PATH_END.test(next)) return true;
    }
  }
  return false;
};

// ---- raw output a sandbox left on the host ----

/** Whether a sandbox left raw files on the host: `out/live/`, or a run dir with one of the raw files of the sweep. */
function rawLeft(g: Guarded): boolean {
  const out = join(g.sandboxDir, 'out');
  if (existsSync(join(out, 'live'))) return true;
  try {
    for (const n of readdirSync(out).filter((x) => RUN_NAME.test(x)).slice(0, 300)) if (HOST_RAW_NAMES.some((r) => existsSync(join(out, n, r)))) return true;
  } catch {
    return false;
  }
  return false;
}

/** Whether a path inside a sandbox's `out/` is a raw file or dir (`out/live/…`, `out/<ts>/<raw name>`). */
function rawPath(g: Guarded, p: string): boolean {
  const out = join(g.sandboxDir, 'out');
  if (!inside(p, out)) return false;
  const rel = p.slice(out.length).split(sep).filter(Boolean);
  if (rel[0]?.toLowerCase() === 'live') return true;
  return rel.length >= 2 && RUN_NAME.test(rel[0]!.toUpperCase()) && HOST_RAW_NAMES.includes(rel[1]!.toLowerCase());
}

/** What a hit on raw output says: the files are leftovers, and how they go. */
const RAW_NOTE = 'raw output a sandbox left on the host (leftovers of an older run: any sandbox-* command removes them in real-data mode, or remove out/live and the old run dirs)';

/** Whether a path is `out/` of the sandbox or below it. */
const inOut = (g: Guarded, p: string): boolean => {
  const out = join(g.sandboxDir, 'out');
  return inside(p, out) || inside(realOf(p), realOrSelf(out));
};

/** Whether a dir is above `out/` of the sandbox, or is it: the project, `.goodboy`, `.goodboy/sandbox`, or a dir over them. */
const holdsOut = (g: Guarded, d: string): boolean => {
  const out = join(g.sandboxDir, 'out');
  return inside(out, d) || inside(realOrSelf(out), realOf(d));
};

/** Whether a search that honors ignore files skips `out/` of the sandbox: `out/` is in the sandbox's own `.gitignore` and a `.git`
 *  is at or above the project (ripgrep reads `.gitignore` only inside a git repository). */
function outIgnored(g: Guarded): boolean {
  let cur = dirname(dirname(g.sandboxDir));
  let repo = false;
  for (let i = 0; i < MAX_WALK && !repo; i++) {
    repo = existsSync(join(cur, '.git'));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (!repo) return false;
  const r = readRegular(join(g.sandboxDir, '.gitignore'), 64 * 1024, true);
  return typeof r === 'object' && r.text.split('\n').some((l) => /^\/?out\/?$/.test(l.trim()));
}

/** `rg` and `ag` skip what the ignore files name unless told not to; `ack` and `grep -r` do not. */
function skipsIgnored(prog: string, words: readonly string[]): boolean {
  if (prog !== 'rg' && prog !== 'ag') return false;
  return !words.slice(1).some((w) => /^-[A-Za-z]*[uU][A-Za-z]*$/.test(w) || w === '--unrestricted' || w.startsWith('--no-ignore') || w === '--skip-vcs-ignores');
}

/** Whether a path or glob reaches the raw output of one of the guards. A glob: the dir it lists (as spelled, or with a link in it
 *  followed) is in `out/` while some is left; in a project that holds real data it is also expanded on disk, as `protectedHit`
 *  does, and each match judged with its links followed (`ll/*` with `ll` a link to `out/live`; `ol/*` + `/x.log` with `ol` a
 *  link to `out/`). A glob that cannot be expanded is read by `overBudget`. */
function rawHit(cx: Context, guards: readonly Guarded[], path: string, glob: boolean): boolean {
  if (!glob) {
    const real = realOf(path);
    return guards.some((g) => rawPath(g, path) || rawPath(g, real));
  }
  const listed = headDir(path);
  const dirPart = listed.length > 1 && listed.endsWith(sep) ? listed.slice(0, -1) : listed;
  const realDir = realOf(dirPart);
  const outOf = (g: Guarded): string => join(g.sandboxDir, 'out');
  if (guards.some((g) => rawLeft(g) && (inside(listed, outOf(g)) || inside(realDir, realOrSelf(outOf(g)))))) return true;
  if (cx.local.length === 0 || !guards.some(rawLeft)) return false;
  const found = expandGlob(cx, path);
  return typeof found !== 'string' && found.some((p) => rawHit(cx, guards, p, false));
}

// ---- docker ----

const DOCKER_PROGS = new Set(['docker', 'podman', 'nerdctl']);
const COMPOSE_PROGS = new Set(['docker-compose', 'podman-compose']);
/** `debug` (docker debug), `checkpoint` (a container's memory), `mount` (podman: a container's file system on the host) and
 *  the two `volume` verbs that hand out a volume's files (`dockerVerb` reads `volume export` as one verb). */
const DENY_VERBS = new Set(['exec', 'cp', 'logs', 'inspect', 'attach', 'export', 'commit', 'run', 'create', 'start', 'top', 'diff', 'save', 'debug', 'checkpoint', 'mount', 'volume export', 'volume mount']);
/** The verbs whose argument names a container: an argument that cannot be read (a variable, a hex id) is denied. */
const CONTAINER_VERBS = new Set(['exec', 'cp', 'logs', 'inspect', 'attach', 'export', 'commit', 'start', 'top', 'diff', 'debug', 'mount', 'checkpoint', 'volume export', 'volume mount']);
/** Of those, the verbs that take one container and then a command or nothing. */
const ONE_CONTAINER = new Set(['exec', 'logs', 'attach', 'export', 'top']);
const GLOBAL_VALUED = new Set(['-H', '--host', '--context', '-c', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey', '--namespace', '-n', '--connection', '--url', '--identity', '--remote', '--cgroup-manager', '--root', '--runroot', '--storage-driver', '--address', '-a']);
const COMPOSE_VALUED = new Set(['-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory', '--ansi', '--progress', '--parallel', '-c', '--context', '-H', '--host']);
/** The options of a compose command that name a file or dir: one that resolves into the sandbox dir targets it. */
const COMPOSE_PATH_OPTS = new Set(['-f', '--file', '--project-directory', '--env-file']);
const VERB_VALUED: Record<string, ReadonlySet<string>> = {
  exec: new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys', '--index']),
  logs: new Set(['-n', '--tail', '--since', '--until', '--index']),
  cp: new Set(),
  inspect: new Set(['-f', '--format', '--type']),
  attach: new Set(['--detach-keys', '--index']),
  export: new Set(['-o', '--output']),
  commit: new Set(['-a', '--author', '-c', '--change', '-m', '--message']),
  start: new Set(['--detach-keys']),
  top: new Set(),
  diff: new Set(),
  debug: new Set(['--shell', '--host']),
  mount: new Set(['--format']),
  checkpoint: new Set(['--checkpoint-dir']),
  'volume export': new Set(['-o', '--output']),
  'volume mount': new Set(),
};

/** The words after `from` that are no option, with the option values skipped; stops after `limit` words. */
function operands(words: readonly string[], from: number, valued: ReadonlySet<string>, limit = Infinity): { rest: string[]; end: number } {
  const rest: string[] = [];
  let i = from;
  for (; i < words.length && rest.length < limit; i++) {
    const w = words[i]!;
    if (w === '--') {
      i++;
      while (i < words.length && rest.length < limit) rest.push(words[i++]!);
      break;
    }
    if (w.startsWith('-') && w.length > 1) {
      if (valued.has(w)) i++;
      continue;
    }
    rest.push(w);
  }
  return { rest, end: i };
}

const HEX_ID = /^[0-9a-f]{4,64}$/;
/** A container operand that cannot be read: a variable, a substitution, an `xargs` placeholder, a hex id. */
const unreadable = (x: string): boolean => /[$`]|\{\}/.test(x) || HEX_ID.test(x);

// ---- the gate switch (M6g) ----

/** The user's switch of the privacy run gate (lib/sandbox-privacy-gate.ts `privacyGateOff`), read from the CLI's process
 *  environment: a command that set it for the CLI would be a way past the gate, so no command may. The user sets it in
 *  their settings (`env`), which reaches the CLI without a command. */
const GATE_SWITCH = 'GOODBOY_SANDBOX_PRIVACY_GATE';
const GATE_SWITCH_CHANGE = 'a command that sets a goodboy gate switch';
const GATE_SWITCH_TEXT = "This command sets one of goodboy's own gate switches. Those switches are the user's settings, outside any command: a command never sets them. Run the command without the assignment.";
/** An assignment of the switch in a word, quotes out: `NAME=…`, `NAME+=…`. Any letter case: the reader lower-cases a
 *  segment's program word (`programWords`, for case-insensitive file systems), and a leading `NAME+=x` is one. */
const GATE_ASSIGN = new RegExp(`^${GATE_SWITCH}\\+?=`, 'i');
/** The same anywhere in a text, quotes out, with blanks allowed around the `=` (PowerShell `$env:NAME = 'x'`, cmd `set NAME=x`). */
const GATE_SPELLED = new RegExp(`(?:^|[^A-Za-z0-9_])${GATE_SWITCH}\\s*\\+?=`);
/** The assignment of the switch anywhere in a word (quotes out), after any character a name cannot hold (a blank, `;`, `/`, a quote:
 *  a `-c` string, a wrapper's argument, a `sed` expression): `X${GATE_SWITCH}=…` and `${GATE_SWITCH}x=…` are other names. */
const GATE_IN_WORD = new RegExp(`(?:^|[^A-Za-z0-9_])${GATE_SWITCH}\\+?=`, 'i');
/** Programs known to only show or search the text they are given, with no way to run it or to make it the environment of one:
 *  a segment that holds the assignment and runs one of them (`echo NAME=x`, `grep NAME=x file`, `git commit -m "…NAME=x…"`) sets
 *  nothing. `sed` is one unless it edits in place. Every other program with the assignment among its words is denied (a wrapper
 *  such as `caffeinate`, `stdbuf`, `arch`, `doas`, `npx cross-env`, a shell or interpreter with a `-c` string, an unknown tool). */
const TEXT_ONLY = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'git', 'cat', 'less', 'more', 'head', 'tail', 'sed']);
/** Programs that run text they are given (a script, a string, stdin) the reader of the command has not followed: a
 *  command that spells the assignment and runs one of them is denied (`echo 'NAME=x cmd' | sh`, `eval "$(…)"`,
 *  `python -c`, a heredoc fed to a shell). `git commit -m` and a `grep` that only name it are no such program. */
const RUNS_TEXT = new Set(['eval', 'xargs', 'source', '.', 'env', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish', 'python', 'python3', 'node', 'bun', 'deno', 'perl', 'ruby', 'awk', 'make']);

/** Whether a command sets the privacy gate switch: an assignment before a program (`NAME=x cmd`, `env NAME=x cmd`,
 *  `env -S 'NAME=x cmd'`, a bare `NAME=x` after `set -a`), `export`/`declare -x`/`typeset -x`/`readonly`/`local` of it, the same in
 *  a nested `sh -c`, `eval`, `xargs` or `find -exec` (the reader follows them), or its spelling in a command that runs
 *  text (RUNS_TEXT). `env -u NAME` and reads of the variable set nothing. A PowerShell call is denied on the spelling alone. */
function setsGateSwitch(toolName: string, command: string, segments: readonly { words: readonly string[]; env: readonly string[] }[], truncated: boolean): boolean {
  const plain = command.replace(/["'\\]/g, '');
  if (!plain.includes(GATE_SWITCH)) return false;
  if (truncated) return true; // too large to read whole: not read to the end
  const spelled = GATE_SPELLED.test(plain);
  if (toolName === 'PowerShell' && spelled) return true;
  let runsText = false;
  for (const seg of segments) {
    if (seg.env.includes(GATE_SWITCH)) return true;
    // the reader has taken the quotes out of the words (`env "NAME=x" cmd` and `export "NAME"=x` assign too)
    const words = [...seg.words];
    const w = words[0] === 'rtk' ? words.slice(words[1] === 'proxy' ? 2 : 1) : words;
    const { rest } = readPrefix(w);
    // the words before the program (`rtk proxy env NAME=x cmd`, `env "NAME=x" cmd`) and the program word itself (an append,
    //   `NAME+=x cmd`: not a name `readPrefix` takes)
    if (w.slice(0, w.length - rest.length + 1).some((x) => GATE_ASSIGN.test(x))) return true;
    const prog = basename(rest[0] ?? '');
    // the class of wrappers and strings `readPrefix` does not follow (`caffeinate env NAME=x cmd`, `npx cross-env NAME=x cmd`,
    //   `doas`, `stdbuf`, `arch`, `sh -c 'a; NAME=x b'`, a word after `--`): the assignment anywhere among the words of a segment
    //   whose program is not known to be text-only
    if (words.some((x) => GATE_IN_WORD.test(x)) && !(TEXT_ONLY.has(prog) && !(prog === 'sed' && rest.some((x) => /^-[A-Za-z]*i|^--in-place/.test(x))))) return true;
    if (RUNS_TEXT.has(prog)) runsText = true;
  }
  return spelled && runsText;
}

/** The values of the assignments in a command text (`FOO=x cmd`, `export FOO=x`, a bare `FOO=x`), quotes out. */
function assignmentValues(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/(?:^|[\s;&|(])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s;&|)]*)/g)) out.push(plainWord(m[1]!));
  return out;
}

/** Whether a docker segment is aimed at the sandbox of `g`: any word of the command names its project, a `gb-` name or
 *  `.goodboy/sandbox`; the segment's own `-f`, `--file`, `--project-directory` or `--env-file` resolves into the sandbox dir; the
 *  dir it runs in is inside it; or it takes volumes or a namespace from a container it does not name. */
function targetsSandbox(g: Guarded, all: readonly string[], words: readonly string[], dir: string | null): boolean {
  if (dir !== null && inside(dir, g.sandboxDir)) return true;
  for (const w of all) if (w.includes(g.project) || /(?:^|[=:])gb-[a-z0-9]/i.test(w) || w.includes('.goodboy/sandbox')) return true;
  for (let i = 1; i < words.length; i++) {
    const w = plainWord(words[i]!);
    if (w === '--volumes-from' || w.startsWith('--volumes-from=') || /container:/i.test(w)) return true;
    const eq = w.indexOf('=');
    const opt = eq > 0 ? w.slice(0, eq) : w;
    if (!COMPOSE_PATH_OPTS.has(opt)) continue;
    const value = eq > 0 ? w.slice(eq + 1) : plainWord(words[i + 1] ?? '');
    const p = value === '' ? null : pathOfWord(value, dir ?? process.cwd());
    if (p !== null && (inside(p, g.sandboxDir) || inside(realOf(p), realOrSelf(g.sandboxDir)))) return true;
  }
  return false;
}

/** The docker verb of a segment and where its words after it start, or null when the segment is no docker command. */
function dockerVerb(words: readonly string[]): { verb: string; compose: boolean; after: number } | null {
  const prog = basename(words[0] ?? '');
  if (COMPOSE_PROGS.has(prog)) {
    const o = operands(words, 1, COMPOSE_VALUED, 1);
    return o.rest[0] === undefined ? null : { verb: o.rest[0], compose: true, after: o.end };
  }
  if (!DOCKER_PROGS.has(prog)) return null;
  const first = operands(words, 1, GLOBAL_VALUED, 1);
  let verb = first.rest[0];
  if (verb === undefined) return null;
  let after = first.end;
  let compose = false;
  if (verb === 'compose') {
    compose = true;
    const o = operands(words, after, COMPOSE_VALUED, 1);
    verb = o.rest[0];
    after = o.end;
  } else if (verb === 'container') {
    const o = operands(words, after, new Set(), 1);
    verb = o.rest[0];
    after = o.end;
  } else if (verb === 'volume') {
    // `volume export` and `volume mount` hand out a volume's files; the other volume verbs do not
    const o = operands(words, after, new Set(), 1);
    if (o.rest[0] === 'export' || o.rest[0] === 'mount') {
      verb = `volume ${o.rest[0]}`;
      after = o.end;
    }
  }
  return verb === undefined ? null : { verb, compose, after };
}

/** `compose up` that streams the containers' logs: no `-d`, `--detach` or `--wait`. */
const attachedUp = (words: readonly string[], after: number): boolean => !words.slice(after).some((w) => w === '--detach' || w === '--wait' || w.startsWith('--wait-timeout') || /^-[A-Za-z]*d[A-Za-z]*$/.test(w));

/** Host dirs that hold or lead to a container engine's data: `/` and the dirs above `/var/lib/docker`, podman's storage and the
 *  sockets, and anything below `/var/lib/docker*`, `/var/lib/containers*`, `/var/run/docker*`, `/run/docker*`, `/run/podman*`,
 *  `/run/containers*`, `/run/user/<uid>/(docker|podman)*`, `$XDG_RUNTIME_DIR/(docker|podman)*` and the rootless storage under
 *  `~/.local/share/(containers|docker)` (macOS spells `/var` as `/private/var`). */
const ENGINE_DIRS = new Set(['/', '/var', '/var/lib', '/var/run', '/run', '/run/user']);
const ENGINE_PREFIXES = ['/var/lib/docker', '/var/lib/containers', '/var/run/docker', '/var/run/podman', '/run/docker', '/run/podman', '/run/containers'];
const ENGINE_USER_RUN = /^\/run\/user\/\d+(?:\/(?:docker|podman)[^/]*(?:\/.*)?)?$/;

/** Whether one spelling of a host path is an engine's data or a dir above it, or a socket (any path ending in `docker.sock`). */
function engineDir(p: string): boolean {
  const canon = (x: string): string => resolve('/', x.replace(/^\/private(?=\/)/, '')).toLowerCase();
  const n = canon(p);
  const home = homeOf();
  const xdg = process.env.XDG_RUNTIME_DIR;
  const own = [join(home, '.local', 'share', 'containers'), join(home, '.local', 'share', 'docker'), ...(xdg ? [join(xdg, 'podman'), join(xdg, 'docker')] : [])].map(canon);
  return ENGINE_DIRS.has(n) || ENGINE_USER_RUN.test(n) || ENGINE_PREFIXES.some((x) => n.startsWith(x)) || own.some((x) => n === x || n.startsWith(`${x}/`)) || n.endsWith('docker.sock');
}

/** Whether a host path, as spelled or with its links followed (`ln -s /var/run/docker.sock s`, a link to `/var/run`), is one. */
const engineHostPath = (p: string): boolean => engineDir(p) || engineDir(followedPath(p) ?? p);

/** The host path a `-v`/`--volume` value (`SRC:DST[:opts]`) or a `--mount` value (`type=bind,source=SRC,…`) binds, when it is one:
 *  a source that starts with `/`, `.`, `~` or `$HOME` (any other is the name of a volume). Null when a variable makes it unreadable. */
function bindSource(value: string, mount: boolean, dir: string): string | null {
  const src = mount ? value.split(',').map((kv) => /^(?:source|src)=(.*)$/.exec(kv)?.[1]).find((x) => x !== undefined) : value.split(':')[0];
  return src === undefined || !/^(?:[/.~]|\$\{?HOME\b)/.test(src) ? null : pathOfWord(src, dir);
}

/** Whether a bind of a host path gives the container the dump, an input log, the registry or raw sandbox output: the path is one of
 *  them, inside an input dir, or a dir above one (links followed). */
function bindReachesData(cx: Context, src: string): boolean {
  if (protectedHit(cx, src, false) || holdsProtected(cx.prot, src)) return true;
  const reg = registryDir();
  if (inside(src, reg) || inside(realOf(src), realOrSelf(reg)) || inside(reg, src) || inside(realOrSelf(reg), realOf(src))) return true;
  return cx.local.some((g) => rawLeft(g) && (inOut(g, src) || holdsOut(g, src)));
}

/** A `run` or `create` that gives the container the host's engine or root (a bind of one of the ENGINE dirs or a docker socket,
 *  `--privileged`, `--pid=host`), or the data the rule protects (a bind whose source `bindReachesData`). Said without a sandbox
 *  word: the container then reaches every container's volumes, or the files the rule keeps from the model. With `engine` false
 *  (a shell in another project, the registry-only context) only the data binds count: the engine, `--privileged` and
 *  `--pid=host` rules are for a project that holds real data, as they would stop every other project's containers machine-wide.
 *  The options after the image are read too (`docker run alpine rsync -av /var /backup` is held by its `-v`); `--device`,
 *  `--cap-add` and `--security-opt` are not read. */
function riskyRun(cx: Context, words: readonly string[], from: number, dir: string, engine = true): string | null {
  for (let i = from; i < words.length; i++) {
    const w = plainWord(words[i]!);
    if (w === '--') break;
    // a Go boolean option: bare, or `=` with 1, t, T, TRUE, true or True (`=false`, `=0`, `=f` are off)
    const flag = /^--(privileged|pid)(?:=(.*))?$/.exec(w);
    if (engine && flag?.[1] === 'privileged' && (flag[2] === undefined || /^(?:1|t|T|TRUE|true|True)$/.test(flag[2]))) return `a privileged container: it reaches every container's volumes`;
    if (engine && (w === '--pid=host' || (w === '--pid' && plainWord(words[i + 1] ?? '') === 'host'))) return `the host process namespace: it reaches every container's volumes`;
    const m = /^(?:--(volume|mount)(?:=(.*))?|-[A-Za-z]*(v)(?:=?(.+))?)$/.exec(w);
    if (m === null) continue;
    // the value: attached, or the next word; in a short cluster `-v` ends it (`-itv /a:/b`) or is followed by it (`-v/a:/b`)
    const value = m[2] ?? m[4] ?? plainWord(words[i + 1] ?? '');
    const src = bindSource(value, m[1] === 'mount', dir);
    if (src === null) continue;
    if (engine && engineHostPath(src)) return `a bind of ${src}: it reaches every container's volumes`;
    if (bindReachesData(cx, src)) return `a bind of ${src}, which is or holds the dump, an input log, the registry or raw sandbox output`;
  }
  return null;
}

/** The docker rule for one segment in the LOCAL context: the hit when it reaches a container, volume or network of a
 *  guarded sandbox, or a container that cannot be told from one; a `run` or `create` that binds the engine's data or socket. */
function dockerHit(cx: Context, guards: readonly Guarded[], all: readonly string[], words: readonly string[], dir: string | null, cwd: string): string | null {
  const v = dockerVerb(words);
  if (v === null) return null;
  const up = v.compose && v.verb === 'up';
  if (!DENY_VERBS.has(v.verb) && !up) return null;
  for (const g of guards) {
    if (!targetsSandbox(g, all, words, dir)) continue;
    if (!up || attachedUp(words, v.after)) return up ? 'docker compose up (attached: it streams the logs)' : `docker ${v.verb} (a sandbox container, volume or network)`;
  }
  if (v.verb === 'run' || v.verb === 'create') {
    const risky = riskyRun(cx, words, v.after, cwd);
    if (risky !== null) return `docker ${v.verb} (${risky})`;
  }
  if (v.compose || !CONTAINER_VERBS.has(v.verb)) return null;
  // a container named by a variable or a hex id, or by nothing (an `xargs` supplies it), cannot be told from a sandbox container
  const o = operands(words, v.after, VERB_VALUED[v.verb] ?? new Set(), ONE_CONTAINER.has(v.verb) ? 1 : Infinity);
  const named = v.verb === 'cp' ? o.rest.map((x) => (x.includes(':') ? x.slice(0, x.indexOf(':')) : '')).filter((x) => x !== '') : o.rest;
  if (named.length === 0 || named.some(unreadable)) return `docker ${v.verb} (a container that cannot be told from a sandbox one)`;
  return null;
}

/** The REGISTRY-ONLY context's bind rule for a `run` or `create`: a bind of a registered path or a dir above one, or the registry
 *  dir (`riskyRun` with the engine rules off). */
function remoteBindHit(cx: Context, words: readonly string[], cwd: string): string | null {
  const v = dockerVerb(words);
  if (v === null || (v.verb !== 'run' && v.verb !== 'create')) return null;
  const risky = riskyRun(cx, words, v.after, cwd, false);
  return risky === null ? null : `docker ${v.verb} (${risky})`;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The name of a project as a word holds it: the whole name, or the start of `<name>-<svc>-<n>` and `<name>_<vol>`, possibly
 *  after `--name=`, `container:` or a `,` of a mount. */
const namesProject = (project: string): RegExp => new RegExp(`(?:^|[=:,/])${escapeRe(project)}(?![A-Za-z0-9])`);

/** The docker rule for one segment in the REGISTRY-ONLY context: a deny verb (or an attached `up`) with a word of the command
 *  or the value of an assignment that names the registered project exactly. */
function remoteDockerHit(guards: readonly Guarded[], words: readonly string[], all: readonly string[]): string | null {
  const v = dockerVerb(words);
  if (v === null) return null;
  const up = v.compose && v.verb === 'up';
  if (!DENY_VERBS.has(v.verb) && !(up && attachedUp(words, v.after))) return null;
  // `all`: the name may be set in another segment or by an assignment (`COMPOSE_PROJECT_NAME=<name> docker compose logs`)
  for (const g of guards) if (all.some((w) => namesProject(g.project).test(w))) return `docker ${v.verb} (a registered sandbox's container, volume or network)`;
  return null;
}

// ---- other words ----

const NC_PROGS = new Set(['nc', 'ncat', 'netcat']);
const DOCKER_SOCK = /docker\.sock/;

/** Whether a program opens a unix socket from a path it is given and is given the docker socket's. */
function socketHit(prog: string, words: readonly string[]): boolean {
  if (prog === 'curl') return words.some((w) => w === '--unix-socket' || w.startsWith('--unix-socket=') || w === '--abstract-unix-socket');
  if (prog === 'socat') return words.some((w) => DOCKER_SOCK.test(plainWord(w)));
  return NC_PROGS.has(prog) && words.some((w) => /^-[A-Za-z]*U/.test(w)) && words.some((w) => DOCKER_SOCK.test(plainWord(w)));
}

/** Programs that tell about a file and read none of it: the dump's name is no read of it. */
const METADATA_PROGS = new Set(['ls', 'stat', 'wc', 'du', 'file', 'test', '[']);
/** The options of `file`, `wc` and `du` that print a count, a size or a type and nothing of the file's text: these programs are
 *  exempt only with options from this list (letters of a short cluster, and the long names). Any other option drops the
 *  exemption: `file -f`/`--files-from` and `wc`/`du --files0-from` read the file as a list of names, `file -m`/`--magic-file`
 *  reads it as a magic file, and both show its lines in the error text of what they cannot parse. */
const SAFE_OPTIONS: Readonly<Record<string, { letters: string; long: RegExp }>> = {
  file: { letters: 'biILhzZkspnN0rv', long: /^--(?:brief|mime|mime-type|mime-encoding|dereference|no-dereference|keep-going|uncompress|uncompress-noreport|special-files|preserve-date|no-pad|raw|print0|no-buffer|apple|extension|version|help)$/ },
  wc: { letters: 'lcwmL', long: /^--(?:lines|bytes|words|chars|max-line-length|total(?:=\w+)?|version|help)$/ },
  du: { letters: 'abcdghHkLmPsSx', long: /^--(?:summarize|human-readable|apparent-size|bytes|total|si|one-file-system|dereference|max-depth=\d+|block-size=\w+|time|all|count-links|separate-dirs|version|help)$/ },
};

/** Whether a metadata program's options are all of the kind that reveal nothing of the file (ls, stat, test: any). */
function onlySafeOptions(prog: string, words: readonly string[]): boolean {
  const safe = SAFE_OPTIONS[prog];
  if (safe === undefined) return true;
  for (const raw of words.slice(1)) {
    const w = plainWord(raw);
    if (w === '--') break;
    if (!w.startsWith('-') || w === '-') continue;
    if (w.startsWith('--') ? !safe.long.test(w) : [...w.slice(1)].some((c) => !safe.letters.includes(c))) return false;
  }
  return true;
}
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'mongosh', 'pg_dump', 'mysqldump']);
const SANDBOX_HOST = /^(?:db\d*|gb-[a-z0-9._-]+)$/i;

/** Whether a database client's words (and the command text, for `PGHOST=db psql`) name a sandbox host. */
function dbClientHit(words: readonly string[], raw: string): boolean {
  // quotes and backslashes out, but not plainWord: it folds `//`, which a URL has
  const plain = words.map((w) => w.replace(/["'\\]/g, ''));
  for (let i = 1; i < plain.length; i++) {
    const w = plain[i]!;
    if ((w === '-h' || w === '--host') && SANDBOX_HOST.test(plain[i + 1] ?? '')) return true;
    const attached = /^(?:--host=|-h=?)(.+)$/.exec(w);
    if (attached && SANDBOX_HOST.test(attached[1]!)) return true;
    if (/\bhost=(?:db\d*|gb-[a-z0-9._-]+)(?:\s|$|&)/i.test(w)) return true;
    // a URL: scheme://user:pass@db:5432/x, scheme://db/x, and the `@db:` form of a connection string
    if (/(?:@|:\/\/)(?:db\d*|gb-[a-z0-9._-]+)(?::\d+)?(?:[/?]|$)/i.test(w)) return true;
  }
  return /\b(?:PGHOST|MYSQL_HOST|MARIADB_HOST|MONGO_HOST)=['"]?(?:db\d*|gb-[a-z0-9._-]+)\b/i.test(raw);
}

/** Whether a `lib/cli.ts` word is this plugin's: spelled from `$GB` or `$CLAUDE_PLUGIN_ROOT` (the shell has not expanded it
 *  in the text the hook reads), or the real path of this guard's own `lib/cli.ts` or of `$CLAUDE_PLUGIN_ROOT/lib/cli.ts`. */
function ownCli(word: string, dir: string): boolean {
  if (/^\$\{?(?:GB|CLAUDE_PLUGIN_ROOT)\}?\/lib\/cli\.ts$/.test(word)) return true;
  const p = pathOfWord(word, dir);
  if (p === null) return false;
  const real = norm(realOf(p));
  const own = [join(import.meta.dir, 'cli.ts'), ...(process.env.CLAUDE_PLUGIN_ROOT ? [join(process.env.CLAUDE_PLUGIN_ROOT, 'lib', 'cli.ts')] : [])];
  return own.some((o) => norm(realOf(o)) === real);
}

/** `bun …/lib/cli.ts sandbox-*` and `node …/lib/cli.ts sandbox-*` of this plugin: goodboy's own commands, which hold the boundary. */
export function isGoodboySandboxCli(words: readonly string[], dir: string = process.cwd()): boolean {
  const prog = basename(words[0] ?? '');
  if (prog !== 'bun' && prog !== 'node' && prog !== 'bunx') return false;
  for (let i = 1; i < Math.min(words.length, 5); i++) {
    const w = words[i]!;
    if (/(?:^|\/)lib\/cli\.ts$/.test(w)) return /^sandbox-(?:scan|init|local|check|prepare|up|run|down|data)$/.test(words[i + 1] ?? '') && ownCli(w, dir);
  }
  return false;
}

/** The segment's program and words past the `rtk` token proxy and the prefix commands after it (`rtk proxy env docker …`), as
 *  the outward rule reads them. */
function pastRtk(words: readonly string[]): string[] {
  if (basename(words[0] ?? '') !== 'rtk') return [...words];
  return stripPrefix(words.slice(words[1] === 'proxy' ? 2 : 1));
}

// ---- programs that read a dir whole, or what a pipe gives them ----

const GREP_LIKE = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const ALWAYS_RECURSIVE = new Set(['rg', 'ag', 'ack', 'tar', 'zip', 'rsync', 'scp']);
const PATTERN_OPTS = new Set(['-e', '-f', '--regexp', '--file']);
const SEARCH_VALUED = new Set(['-e', '-f', '--regexp', '--file', '-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '-j', '--threads', '--include', '--exclude', '--exclude-dir', '--max-depth', '-d', '-D']);
/** Programs that read the files they are given, or their input when they are given none. */
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'tac', 'nl', 'strings', 'od', 'xxd', 'hexdump', 'base64', 'sed', 'awk', 'cut', 'sort', 'uniq', 'zcat', 'bzcat', 'grep', 'egrep', 'fgrep']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** The operands of a search program that name a path: the first is the pattern unless `-e` or `-f` gave one. */
function searchPaths(words: readonly string[]): string[] {
  const ops = operands(words, 1, SEARCH_VALUED).rest;
  return words.slice(1).some((w) => PATTERN_OPTS.has(w) || w.startsWith('--regexp=') || w.startsWith('--file=')) ? ops : ops.slice(1);
}

/** The dirs a recursive reader is aimed at: the operands, or the cwd when a search program names none. Null for a program
 *  that does not recurse here. */
function recursiveTargets(prog: string, words: readonly string[], dir: string): string[] | null {
  const flags = words.slice(1);
  const dashed = (re: RegExp): boolean => flags.some((w) => re.test(w));
  const resolveAll = (ws: readonly string[]): string[] => ws.map((p) => pathOfWord(plainWord(p), dir)).filter((p): p is string => p !== null);
  if (prog === 'find') {
    if (!flags.some((w) => FIND_EXEC.has(w))) return null;
    const ops: string[] = [];
    for (const w of flags) {
      if (w.startsWith('-') || w === '(' || w === '!') break;
      ops.push(w);
    }
    return ops.length === 0 ? [dir] : resolveAll(ops);
  }
  const recursive =
    ALWAYS_RECURSIVE.has(prog) ||
    (GREP_LIKE.has(prog) && (dashed(/^-[A-Za-z]*[rR][A-Za-z]*$/) || flags.includes('--recursive') || flags.some((w, i) => (w === '-d' || w === '--directories') && flags[i + 1] === 'recurse') || flags.includes('--directories=recurse'))) ||
    (prog === 'cp' && (dashed(/^-[A-Za-z]*[rRa][A-Za-z]*$/) || flags.includes('--recursive') || flags.includes('--archive')));
  if (!recursive) return null;
  if (GREP_LIKE.has(prog)) {
    const paths = searchPaths(words);
    return paths.length === 0 ? [dir] : resolveAll(paths);
  }
  return resolveAll(operands(words, 1, new Set()).rest);
}

/** What a reader is given to read: the operands of a program that reads files (a search program's first operand is its
 *  pattern), or null when the program is no reader. None means it reads what a pipe gives it (`ls | xargs cat`). */
function readerOperands(prog: string, words: readonly string[]): string[] | null {
  if (!READERS.has(prog)) return null;
  return GREP_LIKE.has(prog) ? searchPaths(words) : operands(words, 1, SEARCH_VALUED).rest;
}

/** Programs that list names: what `xargs` feeds a reader after them. */
const LISTERS = new Set(['ls', 'find', 'fd', 'tree', 'dir', 'echo', 'printf']);

// ---- programs that run what they are given ----

const WRAPPER_PROGS = new Set(['watch', 'colima', 'limactl', 'ssh', 'script', 'unbuffer', 'tmux', 'screen', 'at', 'batch', 'parallel']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
function runsItsArguments(words: readonly string[]): boolean {
  const prog = basename(words[0] ?? '');
  return WRAPPER_PROGS.has(prog) || (prog === 'su' && words.includes('-c')) || (SHELLS.has(prog) && shellReadsStdin([...words]));
}
/** Text that is a docker-family program followed by a verb of the list on one line. */
const DOCKER_TEXT = new RegExp(`\\b(?:docker|podman|nerdctl|docker-compose|podman-compose)\\b[^;|&\\n]*?\\b(?:${[...DENY_VERBS].join('|')})\\b`);

// ---- the tools ----

function toolHit(cx: Context, tool: string, input: Record<string, unknown>, cwd: string): string | null {
  const str = (k: string): string | null => (typeof input[k] === 'string' && (input[k] as string).trim() !== '' ? (input[k] as string) : null);
  const targets: { path: string; glob: boolean }[] = [];
  const addPath = (v: string | null, glob = false): void => {
    if (v === null) return;
    const p = pathOfWord(v, cwd);
    if (p !== null) targets.push({ path: p, glob });
  };
  if (tool === 'Read') addPath(str('file_path'));
  else {
    addPath(str('path'));
    const pattern = str('pattern');
    if (tool === 'Glob' && pattern !== null && isAbsolute(pattern)) addPath(pattern, hasGlob(pattern));
    // a Grep or Glob with no path searches the cwd
    if (str('path') === null) targets.push({ path: resolve(cwd), glob: false });
  }
  const guards = [...cx.local, ...cx.remote];
  for (const t of targets) {
    if (protectedHit(cx, t.path, t.glob)) return `${tool} of the dump or an input log`;
    if (t.glob) {
      if (rawHit(cx, guards, t.path, true)) return `${tool} of ${RAW_NOTE}`;
      continue;
    }
    if (rawHit(cx, guards, t.path, false)) return `${tool} of ${RAW_NOTE}`;
    // a search below `out/` reads the raw files in it
    if (tool !== 'Read' && guards.some((g) => inOut(g, t.path) && rawLeft(g))) return `${tool} over ${RAW_NOTE}`;
    // a Grep over a dir above `out/` reads them too, unless ripgrep (what the tool runs) skips the ignored `out/`
    if (tool === 'Grep' && cx.local.some((g) => holdsOut(g, t.path) && rawLeft(g) && !outIgnored(g))) return `${tool} over a dir that holds ${RAW_NOTE}`;
    // a Grep over a dir that holds the dump or an input reads them too (a Glob lists names only)
    if (tool === 'Grep' && holdsProtected(cx.prot, t.path)) return `${tool} over a dir that holds the dump or an input log`;
  }
  return overBudget(cx);
}

// ---- the registry file ----

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const REGISTRY_CHANGE = 'a change to the registry of real-data sandboxes';

/** Write and Edit on a file of the registry: it keeps what the rule protects, and only goodboy's commands change it. */
function registryWrite(input: Record<string, unknown>, cwd: string): string | null {
  const v = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
  const p = v === null ? null : pathOfWord(v, cwd);
  if (p === null) return null;
  const dir = registryDir();
  return inside(p, dir) || inside(realOf(p), realOrSelf(dir)) ? REGISTRY_CHANGE : null;
}

/** Programs that only read what they are given: the registry's paths are no secret, so naming its file to one of them passes. */
const REGISTRY_READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'tac', 'nl', 'strings', 'od', 'xxd', 'hexdump', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'stat', 'wc', 'du', 'file', 'test', '[', 'jq', 'diff', 'cmp', 'echo', 'printf', 'tree', 'fd', 'find']);
/** Programs that remove or move what they are given, a dir above the registry's included. */
const REMOVERS = new Set(['rm', 'rmdir', 'mv', 'unlink', 'shred', 'trash']);
const OUT_REDIRECT = /^\d*(?:&?>>?\|?|>&)/;

/** Whether a shell segment changes or removes the registry file or anything in its dir: a program that is not a reader with a
 *  word naming them (or running inside the dir), a redirect that writes to them, a glob that lists them, a `rm` or `mv` of a dir
 *  above them. Reading them, and recursive readers over `~` or `~/.claude`, pass: they hold paths, not data. */
function registryChange(raw: readonly string[], prog: string, dir: string): string | null {
  const regDir = registryDir();
  const insideReg = (p: string): boolean => inside(p, regDir) || inside(realOf(p), realOrSelf(regDir));
  const readsOnly = REGISTRY_READERS.has(prog) && !(prog === 'find' && raw.includes('-delete'));
  if (!readsOnly && insideReg(dir)) return REGISTRY_CHANGE;
  let afterRedirect = false;
  for (const w of raw.slice(0, UNCAPPED_WORDS)) {
    let t = plainWord(w);
    let writes = afterRedirect;
    afterRedirect = false;
    const m = OUT_REDIRECT.exec(t);
    if (m) {
      t = t.slice(m[0].length);
      writes = true;
      if (t === '') {
        afterRedirect = true;
        continue;
      }
    }
    if (!writes && readsOnly) continue;
    const eq = t.indexOf('=');
    for (const c of t.startsWith('-') ? (eq > 0 ? [t.slice(eq + 1)] : []) : eq > 0 ? [t, t.slice(eq + 1)] : [t]) {
      if (c === '' || c.length > MAX_WORD) continue;
      const p = pathOfWord(c, dir);
      if (p === null) continue;
      if (insideReg(p)) return REGISTRY_CHANGE;
      if (hasGlob(p) && (inside(headDir(p), regDir) || globMatches(p, registryFile()) !== false)) return REGISTRY_CHANGE;
      if (REMOVERS.has(prog) && inside(regDir, p)) return REGISTRY_CHANGE;
    }
  }
  return null;
}

// ---- the rule ----

/** The call's words, one per line, cut to MAX_COMMAND characters: the text `located` searches for project names. The hook
 *  must answer before its timeout, or the denied call would run (a review measured 38 s for 3 MB of words uncut). */
export function wordsText(words: readonly string[]): string {
  const kept: string[] = [];
  let size = 0;
  for (const w of words) {
    if (size >= MAX_COMMAND) break;
    kept.push(w);
    size += w.length + 1;
  }
  return kept.join('\n').slice(0, MAX_COMMAND);
}

/** Whether `sandbox-data` run from `top` answers for another project: `top` is below one of the session's project dirs,
 *  which the CLI answers for anywhere below it (`projectDir`, as `cliProjectDir` uses it; a linked worktree answers for
 *  itself). */
function nestedIn(top: string, roots: readonly string[]): boolean {
  return roots.some((r) => realOrSelf(projectDir(top, { CLAUDE_PROJECT_DIR: r })) !== realOrSelf(top));
}

/** A hit with the other projects whose sandbox holds what the call reached, when they are not the one `sandbox-data`
 *  answers for from the shell's dir now: a model told nothing would ask the wrong sandbox, or look for one where there is
 *  none. Told: the guarded projects the call reached by a path inside them (found by the walk) or names by project name
 *  or protected path (in its first 1600 words and MAX_COMMAND characters, `wordsText`), other than that one. When it
 *  names none (a relative path, `~`, a glob): nothing more if that one is guarded (the hit is taken as its own), else
 *  every guarded project. Each is told as `from` (a `cd` into it reaches its sandbox) or `nested` (inside the session's
 *  project dir: no `cd` does). */
function located(what: string, cx: Context): DataGuardHit {
  const answers = realOrSelf(cx.answers);
  const own = (g: Guarded): boolean => inside(answers, realOrSelf(g.top));
  const text = wordsText(cx.words);
  const mentions = (g: Guarded): boolean => text.includes(g.project) || (g.paths ?? []).some((p) => text.includes(p));
  const named = [...cx.local.filter((g) => !own(g)), ...cx.remote.filter(mentions)];
  const told = named.length > 0 || cx.local.some(own) ? named : [...cx.local, ...cx.remote];
  if (told.length === 0) return { what };
  const nested = told.filter((g) => nestedIn(g.top, cx.roots)).map((g) => g.top);
  const from = told.filter((g) => !nested.includes(g.top)).map((g) => g.top);
  return { what, ...(from.length > 0 ? { from } : {}), ...(nested.length > 0 ? { nested } : {}) };
}

/** The invisible and direction-changing characters of these kinds, escaped in a shown dir (other Unicode format characters,
 *  such as the soft hyphen or the tag characters, are not in the list and stay as they are): DEL and the C1 controls (U+0085
 *  among them), the Arabic letter mark, zero-width and direction marks, line and paragraph separators, bidi embeddings,
 *  overrides and isolates, invisible operators, and the byte order mark. */
const UNSEEN = /[\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{2069}\u{feff}]/gu;

/** A project's dir as the deny text shows it: a JSON string (a registered dir is only checked to be absolute, so a
 *  backtick or a newline in it stays text) with the UNSEEN characters escaped as well. */
export function shownDir(d: string): string {
  return JSON.stringify(d).replace(UNSEEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** "the project at X", or "one of the projects X, Y, Z and N more". */
function projectsAt(dirs: readonly string[]): string {
  const shown = dirs.map(shownDir);
  const more = shown.length > MAX_FROM_SHOWN ? ` and ${shown.length - MAX_FROM_SHOWN} more` : '';
  return shown.length === 1 ? `the project at ${shown[0]}` : `one of the projects ${shown.slice(0, MAX_FROM_SHOWN).join(', ')}${more}`;
}

/** What a denied call is told (model-facing): what it reached, where the data is available, and the one way past. */
export function sandboxDataMessage(hit: DataGuardHit, o: { cli: string; subagent: boolean; marker?: string }): string {
  if (hit.fixed !== undefined) return hit.fixed;
  const where: string[] = [];
  const from = hit.from ?? [];
  const nested = hit.nested ?? [];
  if (from.length > 0) {
    where.push(`Raw rows stay in the sandbox of ${projectsAt(from)}: \`bun "${o.cli}" sandbox-data schema|shape|count|pick\` answers for the dir it runs in, so run it there (\`cd\` into that project's dir first), not from here: structure, counts and handles.`);
  }
  if (nested.length > 0) {
    where.push(`Raw rows stay in the sandbox of ${projectsAt(nested)}, inside this session's project dir: \`bun "${o.cli}" sandbox-data\` answers for this session's project from any dir below it, so no \`cd\` reaches that sandbox from here; its structure, counts and handles come from a Claude Code session started in that project's dir.`);
  }
  const use =
    where.length > 0
      ? where.join(' ')
      : `Raw rows stay in the sandbox: use \`bun "${o.cli}" sandbox-data schema|shape|count|pick\` for structure, counts and handles, and \`sandbox-run\` for suites.`;
  if (o.subagent) return `This would reach a sandbox that may hold real data (${hit.what}). ${use} Agents never read it directly: use those commands, or return BLOCKED.`;
  return `This would reach a sandbox that may hold real data (${hit.what}). ${use} If the user approves this one call, have them run \`! touch ${o.marker ?? '.claude/.goodboy-sandbox-data-approved-<session>.txt'}\` and run it again; the approval covers one call.`;
}

/** What one segment is read with. */
interface Seg {
  cx: Context;
  /** Every word of the command and the value of every assignment (a docker segment may be aimed by another segment). */
  all: readonly string[];
  /** The segment's words as read, before `rtk` is stripped, and after. */
  raw: readonly string[];
  words: readonly string[];
  /** The dir the segment runs in when it is known, else null; and where a relative path is resolved from. */
  segDir: string | null;
  dir: string;
  command: string;
  /** The size caps apply (see the header). */
  caps: boolean;
  /** Another segment lists a dir that holds a protected path or raw output and `xargs` feeds a reader (`find dumps | xargs cat`). */
  listed: boolean;
}

/** Whether the command builds a name with a group in a dir that holds a protected path: `dumps/(dump|x).sql` (zsh),
 *  `dumps/@(a|b)`, `!(…)`, `+(…)`, `*(…)`, `?(…)` (extglob), `dump.s(ql|x)`. The shell reader splits a word at the parenthesis
 *  (a substitution `$(` or process substitution `<(` is not one), so the matcher never sees the group: the glob cannot be
 *  expanded and is held when its literal dir holds a protected path. That dir is found two ways: as the text of a protected
 *  dir (`dirNeedles`, any context), and as the dir the word before the `(` names, from each dir the command runs in, `~`,
 *  `$HOME` and links resolved (a project that holds real data: `dl/@(dump).sql` with `dl` a link to the dumps; another
 *  project's shell: its protected paths as text only). A bare `(` (a subshell, `x=(a b)`) is no group. Linear: only the first
 *  100 KB, at most 256 characters after each occurrence, 64 groups, and the call's work budget. */
function groupAfterDir(cx: Context, command: string, dirs: readonly string[]): boolean {
  if (cx.prot.all.length === 0 || !command.includes('(')) return false;
  const cut = command.length > MAX_COMMAND ? command.slice(0, MAX_COMMAND) : command;
  const text = norm(cut);
  for (const d of cx.prot.dirNeedles) {
    cx.work.left -= text.length;
    if (cx.work.left < 0) {
      cx.work.over = true;
      return false;
    }
    for (let at = text.indexOf(d); at >= 0; at = text.indexOf(d, at + d.length)) {
      const from = at + d.length;
      for (let i = from; i < Math.min(text.length, from + 256); i++) {
        const c = text[i]!;
        if (c === '(') return true;
        if (/[\s;|&)$]/.test(c)) break;
      }
    }
  }
  const from = [...new Set(dirs)].slice(0, 8);
  let groups = 0;
  for (let at = cut.indexOf('('); at >= 0 && groups < 64; at = cut.indexOf('(', at + 1)) {
    if (at === 0 || '$<>'.includes(cut[at - 1]!)) continue;
    // the word before the `(` as the shell reads it: quotes are part of a word, not its end (`"dl/"(a|b)`, `dump.s"(ql|x)"`);
    // the `$` of an ANSI-C or locale quote (`$'dl/'`, `$"dl/"`) is part of the quote, not of the name
    let s = at;
    while (s > 0 && !/[\s;|&()<>`]/.test(cut[s - 1]!)) s--;
    const prefix = plainWord(cut.slice(s, at).replace(/\$(?=['"])/g, ''));
    if (prefix === '' || prefix.endsWith('=') || prefix.length > MAX_WORD) continue;
    groups++;
    const slash = prefix.lastIndexOf('/');
    const dirText = slash >= 0 ? prefix.slice(0, slash + 1) : '.';
    for (const d of from) {
      const p = pathOfWord(dirText, d);
      if (p === null) continue;
      if (cx.local.length > 0 ? holdsProtected(cx.prot, p) : cx.prot.all.some((t) => inside(t, p))) return true;
    }
  }
  return false;
}

/** The hit of a tool call that reaches the real data of a sandbox project, or null. `projectCwd` is the hook's project dir
 *  for `cwd` (`projectDir`); `also` holds the session's project dir as the CLI knows it (CLAUDE_PROJECT_DIR; an entry
 *  that is not an absolute path is skipped). `note` hears of a registry that cannot be read. */
export function sandboxDataDenial(input: { toolName: string; toolInput: Record<string, unknown>; cwd: string; projectCwd: string; also?: readonly (string | undefined)[]; note?: (n: string) => void }): DataGuardHit | null {
  const { toolName, toolInput, cwd, projectCwd } = input;
  const roots = (input.also ?? []).filter((d): d is string => typeof d === 'string' && isAbsolute(d));
  const session = [cwd, projectCwd, ...roots];
  const where = { answers: projectCwd, roots };
  if (WRITE_TOOLS.has(toolName)) {
    const why = registryWrite(toolInput, cwd);
    return why === null ? null : { what: why };
  }
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    const named = ['file_path', 'path', 'pattern'].map((k) => toolInput[k]).filter((v): v is string => typeof v === 'string');
    const tcx = contextFor(session, named, cwd, where, input.note);
    const why = toolHit(tcx, toolName, toolInput, cwd);
    return why === null ? null : located(why, tcx);
  }
  // any tool whose input is a shell command: Bash, Monitor, PowerShell
  if (typeof toolInput.command !== 'string') return null;
  const command = toolInput.command;
  const { segments, truncated } = readCommand(command, cwd, { keepRedirects: true });
  // a goodboy gate switch is set by no command, whatever project or context the call is in (own CLI commands included)
  if (setsGateSwitch(toolName, command, segments, truncated)) return { what: GATE_SWITCH_CHANGE, fixed: GATE_SWITCH_TEXT };
  const parsed = segments.map((seg) => {
    const words = pastRtk(seg.words);
    const dir = seg.dir ?? cwd;
    return { seg, words, dir, prog: basename(words[0] ?? ''), own: isGoodboySandboxCli(words, dir) };
  });
  // the registry file and its dir are changed by no command but goodboy's own, whatever project the call is in
  for (const { seg, prog, dir, own } of parsed) {
    const why = own ? null : registryChange(seg.words, prog, dir);
    if (why !== null) return { what: why };
  }
  const dirs = [...session, ...segments.map((s) => s.dir).filter((d): d is string => d !== null)];
  const assigns = assignmentValues(command);
  const cx = contextFor(dirs, [...segments.flatMap((s) => s.words), ...assigns].slice(0, MAX_WORDS * 4), cwd, where, input.note);
  if (cx.local.length === 0 && cx.remote.length === 0 && cx.prot.all.length === 0) return null;
  const holds = new Map<string, boolean>();
  const dirHolds = (d: string): boolean => {
    let h = holds.get(d);
    if (h === undefined) holds.set(d, (h = holdsProtected(cx.prot, d)));
    return h;
  };
  const caps = cx.local.length > 0 || dirs.some(dirHolds);
  if (caps && command.length > MAX_COMMAND) return located(TOO_LONG, cx);
  const all = [...segments.flatMap((s) => s.words.map(plainWord)), ...assigns];
  // a path held in a variable: the value of an assignment that holds a protected path as text
  if (cx.prot.all.length > 0 && assigns.some((v) => holdsText(cx.prot, v))) return located('a path of the dump or an input log', cx);
  // `find ~/dumps -type f | xargs cat`: a segment lists a dir that holds a protected path or raw output, and `xargs` feeds the readers
  const listed =
    (cx.prot.all.length > 0 || cx.local.length > 0) &&
    segments.some((s) => basename(s.words[0] ?? '') === 'xargs') &&
    segments.some((s) => {
      const w = pastRtk(s.words);
      if (!LISTERS.has(basename(w[0] ?? ''))) return false;
      return w.slice(1).some((x) => {
        const p = x.startsWith('-') ? null : pathOfWord(plainWord(x), s.dir ?? cwd);
        return p !== null && (holdsProtected(cx.prot, p) || protectedHit(cx, p, hasGlob(p)) || cx.local.some((g) => (inOut(g, p) || holdsOut(g, p)) && rawLeft(g)));
      });
    });
  if (groupAfterDir(cx, command, dirs)) return located('a path of the dump or an input log', cx);
  let wrapped = false;
  for (const { seg, words, dir, own } of parsed) {
    if (own) {
      // goodboy's command holds the boundary, but its redirects are the shell's: `sandbox-data schema 2> DUMP` truncates the dump
      if (redirectsToProtected(cx, seg.words, dir)) return located('a path of the dump or an input log', cx);
      continue;
    }
    wrapped ||= runsItsArguments(words);
    const hit = segmentHit({ cx, all, raw: seg.words, words, segDir: seg.dir, dir, command, caps, listed }, dirHolds);
    if (hit !== null) return located(hit, cx);
  }
  // glob matching ran past the call's budget: a command that long is not read to the end
  const big = overBudget(cx);
  if (big !== null) return located(big, cx);
  // a program that runs its arguments or stdin as a command, with docker text and a verb the rule would deny
  if (wrapped) {
    const text = command.replace(/["'\\]/g, '');
    if (DOCKER_TEXT.test(text) && (cx.local.length > 0 || cx.remote.some((g) => text.includes(g.project)))) return located('a docker call the rule cannot read', cx);
  }
  return null;
}

/** A redirect operator that names a file, with an optional fd before it: `>`, `>>`, `>|`, `>&`, `&>`, `&>>`, `<`, `<&`, `<>`. Not a
 *  here-document (`<<`) or here-string (`<<<`): their word is text. */
const FILE_REDIRECT = /^(?:\d*>>|\d*>\||\d*>&|\d*>|&>>|&>|\d*<>|\d*<&|\d*<(?!<))/;

/** Whether a segment redirects from or to a protected path (`2> DUMP`, `>DUMP`, `< DUMP`, `>& DUMP`, `<> DUMP`, a glob that
 *  expands to one: a star, a slash and `dump.sql` after `>`). */
function redirectsToProtected(cx: Context, raw: readonly string[], dir: string): boolean {
  let pending = false;
  for (const rawWord of raw.slice(0, UNCAPPED_WORDS)) {
    const t = plainWord(rawWord);
    const m = FILE_REDIRECT.exec(t);
    let target: string | null = null;
    if (pending) target = t;
    else if (m !== null) target = t.slice(m[0].length);
    pending = !pending && m !== null && target === '';
    if (target === null || target === '') continue;
    const p = pathOfWord(target, dir);
    if (p !== null && protectedHit(cx, p, hasGlob(p))) return true;
  }
  return false;
}

// ---- links made to what the rule protects ----

/** Whether a link may not lead to this path: a protected file (or inside an input dir), or a dir that holds one, or the registry
 *  dir or a dir above it. Not `/`, `$HOME` or a dir above `$HOME` (`ln -s ~ h` is a common link and holds everything; what is
 *  read through it is judged word by word). */
function linkTargetHeld(cx: Context, p: string): boolean {
  if (cx.prot.all.length > 0) {
    if (protectedHit(cx, p, false)) return true;
    if (!aboveHome(p)) {
      if (holdsProtected(cx.prot, p)) return true;
      const reg = registryDir();
      if (inside(p, reg) || inside(reg, p) || inside(realOf(p), realOrSelf(reg)) || inside(realOrSelf(reg), realOf(p))) return true;
    }
  }
  // raw output a sandbox left on the host: `out/`, what is in it, and `.goodboy` and `.goodboy/sandbox` above it (not the project)
  return cx.local.some((g) => rawLeft(g) && (inOut(g, p) || (holdsOut(g, p) && inside(p, g.top) && norm(p) !== norm(g.top))));
}

/** Whether a path is `$HOME`, `/` or a dir above `$HOME`. */
function aboveHome(p: string): boolean {
  const home = homeOf();
  return inside(home, p) || inside(realOrSelf(home), realOf(p));
}

/** Whether a glob can match a path a link may not lead to (`linkTargetHeld`), judged as text: a protected path, the dirs above
 *  it up to but not including `$HOME`, the registry file and its dir. Any context; no walk of the dirs. 'unreadable' for a
 *  pattern the matcher cannot read. */
function globReachesHeld(cx: Context, pattern: string): 'held' | 'unreadable' | null {
  const alts = alternatives(pattern);
  if (alts === null) return 'unreadable';
  const roots = [...cx.prot.all, registryDir(), registryFile()];
  for (const alt of alts) {
    const toks = compileGlob(alt);
    if (toks === null) return 'unreadable';
    for (const t of roots) {
      for (let d = t; ; d = dirname(d)) {
        cx.work.left -= (toks.length + 1) * (d.length + 1);
        if (cx.work.left < 0) {
          cx.work.over = true;
          return null;
        }
        if (matchTokens(toks, d) && !aboveHome(d)) return 'held';
        if (dirname(d) === d) break;
      }
    }
  }
  return null;
}

const LINK_VALUED = new Set(['-t', '--target-directory', '-S', '--suffix']);
const LINK_HELD = 'a link to the dump, an input log, raw sandbox output or a dir that holds one';

/** What a link source word comes to: the paths a brace and a glob in it stand for, each judged. `asTarget`: the source is what a
 *  link will lead to (`ln -s`, `cp -s`); else it is a link that is copied or moved, and what it leads to is judged. A glob is
 *  matched as text in any context (`globReachesHeld`) and, in a project that holds real data, expanded on disk to a budget
 *  (`expandGlob`). The verdict is the deny text: held, a pattern too large to expand, or one the rule cannot read. */
function linkSourceVerdict(cx: Context, word: string, base: string, asTarget: boolean): string | null {
  const alts = braceExpand(word);
  if (alts === null) return GLOB_UNREADABLE;
  for (const a of alts) {
    const p = pathOfWord(a, base);
    if (p === null) continue;
    let concrete = [p];
    if (hasGlob(p)) {
      if (asTarget) {
        const text = globReachesHeld(cx, p);
        if (text === 'held') return LINK_HELD;
        if (text === 'unreadable') return GLOB_UNREADABLE;
      }
      concrete = [];
      if (cx.local.length > 0) {
        const found = expandGlob(cx, p);
        if (found === 'big') return GLOB_TOO_BIG;
        if (found === 'unreadable') return GLOB_UNREADABLE;
        concrete = found;
      }
    }
    for (const c of concrete) {
      const to = asTarget ? c : isLinkSync(c) ? followedPath(c) : null;
      if (to !== null && linkTargetHeld(cx, to)) return LINK_HELD;
    }
  }
  return null;
}

/** A command that puts a link into a tree whose target is protected: `ln` (symbolic or hard), `cp -s`, and a link copied as a link
 *  or moved (`cp -P -d -a -R`, `mv`: the link already points there). A link is the way a model gets a protected dir into a path
 *  that no word of a later command names (`ln -s ~/dumps dl; cat dl/dump.sql`). Any guarded context. */
function linkHit(cx: Context, prog: string, words: readonly string[], dir: string): string | null {
  if (prog !== 'ln' && prog !== 'cp' && prog !== 'mv') return null;
  const flags = words.slice(1).filter((w) => w.startsWith('-') && w !== '-');
  const has = (short: string, long: RegExp): boolean => flags.some((w) => (w.startsWith('--') ? long.test(w) : new RegExp(`^-[A-Za-z]*[${short}]`).test(w)));
  const ops = operands(words, 1, LINK_VALUED).rest.map(plainWord);
  const t = words.findIndex((w, i) => i > 0 && (w === '-t' || w === '--target-directory'));
  const tAttached = flags.find((w) => w.startsWith('--target-directory='))?.slice('--target-directory='.length);
  const into = t > 0 ? plainWord(words[t + 1] ?? '') : tAttached !== undefined ? plainWord(tAttached) : null;
  const sources = into !== null ? ops : ops.slice(0, ops.length > 1 ? -1 : ops.length);
  const dest = into ?? (ops.length > 1 ? ops[ops.length - 1]! : '.');
  // where a relative target of a symbolic link is read from: the dir the link is made in
  const destPath = pathOfWord(dest, dir);
  const linkDir = destPath === null ? dir : isDirSync(destPath) || dest.endsWith('/') || into !== null ? destPath : dirname(destPath);
  const judge = (asTarget: boolean, base: string): string | null => {
    for (const s of sources) {
      const v = linkSourceVerdict(cx, s, base, asTarget);
      if (v !== null) return v;
    }
    return null;
  };
  if (prog === 'ln') return judge(true, has('s', /^--symbolic$/) && !has('r', /^--relative$/) ? linkDir : dir);
  if (prog === 'cp' && has('s', /^--symbolic-link$/)) return judge(true, linkDir);
  // a link copied or moved as a link
  if (prog === 'cp' && !has('PdaRr', /^--(?:no-dereference|archive|recursive)$/)) return null;
  return judge(false, dir);
}

/** A word that names where a sandbox keeps its raw output: `sandbox/out`, `out/live`, `out/<run>`, `out/*`. */
const MENTIONS_OUT = /sandbox\/out|(?:^|[/\s(])out\/(?:live|\*|\?|\d{8}T\d{6}Z)/i;

function segmentHit(k: Seg, dirHolds: (d: string) => boolean): string | null {
  const { cx, words, raw, dir } = k;
  const prog = basename(words[0] ?? '');
  const local = cx.local.length > 0;
  // a link whose target is protected (any context)
  const link = linkHit(cx, prog, words, dir);
  if (link !== null) return link;
  // docker: a project of the call's own dirs generically, a registered one by its exact name
  if (DOCKER_PROGS.has(prog) || COMPOSE_PROGS.has(prog)) {
    const d = (local ? dockerHit(cx, cx.local, k.all, words, k.segDir, dir) : null) ?? (cx.remote.length > 0 ? remoteDockerHit(cx.remote, words, k.all) : null) ?? (!local && cx.remote.length > 0 ? remoteBindHit(cx, words, dir) : null);
    if (d !== null) return d;
  }
  if (local && socketHit(prog, raw)) return 'the docker socket';
  if (local && DB_CLIENTS.has(prog) && dbClientHit(words, k.command)) return `${prog} aimed at a sandbox database host`;
  const guards = [...cx.local, ...cx.remote];
  if (k.caps && (raw.length > MAX_WORDS || raw.some((x) => x.length > MAX_WORD))) return TOO_LONG;
  const dirs = recursiveTargets(prog, words, dir);
  if (dirs !== null) {
    if (dirs.some((d) => holdsProtected(cx.prot, d))) return 'a recursive reader over a dir that holds the dump or an input log';
    if (dirs.some((d) => guards.some((g) => inOut(g, d) && rawLeft(g)))) return `a recursive reader over ${RAW_NOTE}`;
    // over a dir above `out/` (the project, `.goodboy`, `.goodboy/sandbox`): `rg` and `ag` skip the ignored `out/` unless told not to
    if (dirs.some((d) => cx.local.some((g) => holdsOut(g, d) && rawLeft(g) && !(skipsIgnored(prog, words) && outIgnored(g))))) return `a recursive reader over a dir that holds ${RAW_NOTE}`;
  }
  // a reader that is given no file, or a name a substitution or a variable builds, in a dir that holds the dump or raw output
  const ops = readerOperands(prog, words);
  if (ops !== null && (ops.length === 0 || ops.some((o) => /[$`]/.test(o))) && (dirHolds(dir) || cx.local.some((g) => inOut(g, dir) && rawLeft(g)))) return 'a reader that takes its files from a pipe or a substitution, in a dir that holds the dump, an input log or raw output';
  if (k.listed && ops !== null && (ops.length === 0 || ops.some((o) => o.includes('{}')))) return 'a reader fed the names of a dir that holds the dump, an input log or raw output';
  // a name built in a substitution that names the raw output (`cat $(ls .goodboy/sandbox/out/*/output.log)`)
  if (ops !== null && raw.some((w) => /[$`]/.test(w) && MENTIONS_OUT.test(w)) && cx.local.some(rawLeft)) return `a path of ${RAW_NOTE}`;
  // a metadata program tells about no file only with options that print no text of it (`file -f`, `wc --files0-from` and
  // `file -m` read the file and show its lines in an error text)
  const metadata = METADATA_PROGS.has(prog) && onlySafeOptions(prog, raw);
  for (const rawWord of raw.slice(0, k.caps ? MAX_WORDS : UNCAPPED_WORDS)) {
    // a redirect's target (`<dump.sql`), `--file=/path` and `if=/path` (the value too); a bare option names no file
    const w = plainWord(rawWord).replace(REDIRECT_PREFIX, '');
    if (!metadata && cx.prot.all.length > 0 && holdsText(cx.prot, w)) return 'a path of the dump or an input log';
    if (w.length > MAX_WORD) continue;
    const eq = w.indexOf('=');
    const candidates = w.startsWith('-') ? (eq > 0 ? [w.slice(eq + 1)] : []) : eq > 0 ? [w, w.slice(eq + 1)] : [w];
    for (const c of candidates) {
      if (c === '') continue;
      const alts = braceExpand(c);
      if (alts === null) {
        // more alternatives than the rule expands: held when the dir the word lists holds a protected path
        if (!metadata && cx.prot.all.some((t) => inside(t, headDir(resolve(dir, c))))) return 'a path of the dump or an input log';
        continue;
      }
      for (const a of alts) {
        const p = pathOfWord(a, dir);
        if (p === null) continue;
        const glob = hasGlob(p);
        if (!metadata && protectedHit(cx, p, glob)) return 'a path of the dump or an input log';
        if (!metadata && rawHit(cx, guards, p, glob)) return `a path of ${RAW_NOTE}`;
      }
    }
  }
  return null;
}
