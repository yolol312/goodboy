// Outward-command classifier (track G stop rule R2, plan §10.6) — which shell commands change
// a system outside the machine, and where they point.
//
// R2: never act on live external or production systems; retarget to a sandbox, otherwise ask
// (main session) or return BLOCKED with the command (subagent). The hook backstop:
//   - `.goodboy/hosts` lists `allow <pattern>` (dev, staging, sandbox: mutating calls pass,
//     also from subagents) and `production <pattern>` (always blocked until the user approves);
//   - built-in allow: loopback, localhost, the reserved names (.test, .invalid, .example,
//     .localhost, example.com/net/org) and local Kubernetes contexts. Private IP ranges are
//     not allowed by default: a LAN host may be a real server;
//   - unlisted: a subagent's mutating call is denied with a retarget hint; the main session
//     gets advice. Reads always pass.
//
// The classifier is a static reading of the command, like lib/bash-write.ts: it targets the
// casual case, not an adversarial model.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { stripHeredocs } from './bash-write';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

export interface OutwardTarget {
  /** Tool family, e.g. `curl`, `ssh`, `git push`, `kubectl`. */
  kind: string;
  /** Host name, or a pseudo-host for tools without one (`aws`, `kube:<context>`). */
  host: string;
  /** True when the command changes the target; false for reads. */
  mutating: boolean;
}

export type HostClass = 'local' | 'allow' | 'production' | 'unlisted';

// ---- shell reading ------------------------------------------------------------------

/** Subshell nesting goodboy reads; deeper text is marked `truncated` (security-injection
 *  review: 20,000 nested `(` overflowed the stack and the hook let the call through). */
const MAX_SCOPE_DEPTH = 64;

/** Compound commands: their words open and close a list level, so a `;` inside `{ …; }` or
 *  `if …; fi` does not end the job the whole group is part of (`{ cd /tmp; } &`). */
const GROUP_OPEN: ReadonlySet<string> = new Set(['{', 'if', 'while', 'until', 'for', 'select', 'case']);
const GROUP_CLOSE: ReadonlySet<string> = new Set(['}', 'fi', 'done', 'esac']);
const GROUP_MID: ReadonlySet<string> = new Set(['then', 'else', 'elif', 'do', '!']);

/** Splits a command into segments of words at unquoted `;`, `&&`, `||`, `|`, `&` and
 *  newlines, with quotes removed (`$'…'` too) and backslash-newlines joined. A command
 *  substitution (`$(…)` or backticks, inside double quotes too: `out="$(git push)"` runs the
 *  push, final G1 review) is read as segments of its own, before the command it is part of;
 *  that command keeps its text in the word (`cd "$(git rev-parse --show-toplevel)"`).
 *
 *  `scopes`, when given, gets each segment's subshell scope in step: `0` at the top, `0.1`
 *  inside the first `( … )`, `$( … )` or backtick pair, `0.1.2` deeper (a `cd` in a scope does
 *  not move its parent). A job is a scope too (closing G1 round, measured in bash and zsh):
 *  `0.s4` runs in a subshell in both shells (a pipeline element before the last, the last
 *  pipeline of a list ending in `&`); `0.a5` runs in a subshell in bash but in the shell in
 *  zsh (the last pipeline element, the pipelines before the last of a list ending in `&`), so a
 *  `cd` directly in it leaves the shell's dir unclear. */
export function shellSegments(
  command: string,
  opts: { keepSubstitutions?: boolean; scopes?: string[]; budget?: { truncated: boolean; nested?: number } } = {},
): string[][] {
  const segs: string[][] = [];
  const scopes: string[] = [];
  let words: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  // Open subshells. A substitution keeps the command around it (`outer`), where it started and
  //   the quote it was opened in, to go back to when it closes.
  interface Frame {
    id: string;
    tick: boolean;
    start: number;
    ret: '"' | null;
    outer?: { words: string[]; cur: string };
    /** Levels below this frame's own (its list level is levels[levelBase - 1]). */
    levelBase: number;
  }
  const frames: Frame[] = [];
  // Per list level (the top, a subshell, a group): where its current list, that list's last
  //   pipeline and that pipeline's current element start, and whether the pipeline has a `|`.
  interface Level {
    list: number;
    pipe: number;
    elem: number;
    piped: boolean;
    caseBody: boolean;
  }
  const levels: Level[] = [{ list: 0, pipe: 0, elem: 0, piped: false, caseBody: false }];
  let opened = 0;
  // Ids unique across the nested readings of one command, which share the budget.
  const nextId = () => (opts.budget && typeof opts.budget.nested === 'number' ? ++opts.budget.nested : ++opened);
  const here = () => ['0', ...frames.slice(0, MAX_SCOPE_DEPTH).map((f) => f.id)].join('.');
  const level = () => levels[levels.length - 1]!;
  // Segments `from`..`to` run as one job of `kind` below the current scope.
  const tag = (from: number, to: number, kind: 's' | 'a') => {
    if (to < from) return;
    const base = here();
    const t = `.${kind}${nextId()}`;
    for (let k = from; k <= to; k++) scopes[k] = base + t + scopes[k]!.slice(base.length);
  };
  const pushLevel = (start: number, caseBody = false) => {
    levels.push({ list: start, pipe: start, elem: start, piped: false, caseBody });
    if (levels.length > 4 * MAX_SCOPE_DEPTH && opts.budget) opts.budget.truncated = true;
  };
  // The current pipeline ends: its last element, when it had a `|`, is an `a` job.
  const endPipeline = () => {
    const L = level();
    if (L.piped) tag(L.elem, segs.length - 1, 'a');
    L.piped = false;
  };
  const groups = (seg: string[], idx: number) => {
    for (const w of seg) {
      if (GROUP_OPEN.has(w)) pushLevel(idx, w === 'case');
      else if (GROUP_CLOSE.has(w)) {
        if (levels.length > (frames[frames.length - 1]?.levelBase ?? 1)) {
          endPipeline();
          levels.pop();
        }
      } else if (!GROUP_MID.has(w)) break;
    }
  };
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  // `sep`: what ends the segment: `;` (also a newline and `;;`), `&&` (also `||`), `|` or `&`;
  //   none at a subshell edge.
  const endSeg = (sep?: ';' | '&&' | '|' | '&') => {
    endWord();
    if (words.length > 0) {
      segs.push(words);
      scopes.push(here());
      groups(words, segs.length - 1);
    }
    words = [];
    if (sep === undefined) return;
    const L = level();
    const last = segs.length - 1;
    if (sep === '|') {
      tag(L.elem, last, 's');
      L.piped = true;
      L.elem = segs.length;
      return;
    }
    endPipeline();
    if (sep === '&&') {
      L.pipe = L.elem = segs.length;
      return;
    }
    if (sep === '&') {
      tag(L.pipe, last, 's');
      tag(L.list, L.pipe - 1, 'a');
    }
    L.list = L.pipe = L.elem = segs.length;
  };
  const open = (f: Omit<Frame, 'id' | 'levelBase'>) => {
    pushLevel(segs.length);
    frames.push({ id: String(nextId()), levelBase: levels.length, ...f });
    if (frames.length > MAX_SCOPE_DEPTH && opts.budget) opts.budget.truncated = true;
  };
  // A substitution starting at `start`: the command around it waits until it closes.
  const openSubstitution = (tick: boolean, start: number) => {
    const outer = { words, cur };
    open({ tick, start, ret: quote === '"' ? '"' : null, outer });
    words = [];
    cur = '';
    inWord = false;
    quote = null;
  };
  // Closes the innermost subshell at `end` (its last character): its pipeline ends there. After
  //   a substitution, the command around it goes on with the substitution's text in its word.
  const close = (end: number) => {
    endSeg();
    const f = frames[frames.length - 1]!;
    while (levels.length >= f.levelBase) {
      endPipeline();
      levels.pop();
    }
    frames.pop();
    if (!f.outer) return;
    words = f.outer.words;
    cur = f.outer.cur + command.slice(f.start, end + 1);
    inWord = true;
    quote = f.ret;
  };
  const finish = () => {
    for (let k = 0; k < scopes.length; k++) opts.scopes?.push(scopes[k]!);
    return segs;
  };
  for (let i = 0; i < command.length; i++) {
    // Past the nesting goodboy reads, the rest is not read at all (the caller denies it).
    if (opts.budget?.truncated) return finish();
    const c = command[i]!;
    if (c === '\\' && command[i + 1] === '\n' && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && !opts.keepSubstitutions && (c === '`' || (c === '$' && command[i + 1] === '('))) {
        openSubstitution(c === '`', i);
        if (c === '$') i++;
      } else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    // `$'…'` takes backslash escapes, `\'` included (layer-1 round: it ended the string there).
    if (c === '$' && command[i + 1] === "'") {
      i += 2;
      while (i < command.length && command[i] !== "'") {
        if (command[i] === '\\' && i + 1 < command.length) {
          cur += command[i + 1];
          i += 2;
        } else cur += command[i++];
      }
      inWord = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += command[++i];
      inWord = true;
      continue;
    }
    // `2>&1`, `<&3`, `&> file`, `&>> file` are redirections, not the `&` separator.
    if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<')) {
      cur += c;
      inWord = true;
      continue;
    }
    if (c === '&' && command[i + 1] === '>') {
      endWord();
      cur = c;
      inWord = true;
      continue;
    }
    // `&&` and `||` chain pipelines; `|` and `|&` pipe; a lone `&` backgrounds the list.
    if (c === ';' || c === '\n') {
      endSeg(';');
      continue;
    }
    if (c === '&' || c === '|') {
      if (command[i + 1] === c) {
        i++;
        endSeg('&&');
      } else {
        if (c === '|' && command[i + 1] === '&') i++;
        endSeg(c);
      }
      continue;
    }
    // `keepSubstitutions`: `$(…)`, backticks and parentheses stay inside their word, so a caller
    //   can tell which simple command a substitution belongs to (the push check).
    if (!opts.keepSubstitutions && (c === '`' || c === '(' || c === ')')) {
      const top = frames[frames.length - 1];
      if (c === '(') {
        endSeg();
        open({ tick: false, start: i, ret: null });
      } else if (c === ')') {
        // A `case` pattern's `)` closes nothing (layer-1 round: it closed `$( … )`); the
        //   pattern is no command.
        endWord();
        const pattern = words[0] === 'case' || (level().caseBody && words.length > 0 && words[0] !== 'esac');
        if (pattern && words[0] !== 'case') words = [];
        if (top && !top.tick && !pattern) close(i);
        else endSeg();
      } else if (top?.tick) close(i);
      else openSubstitution(true, i);
      continue;
    }
    if (c === '$' && command[i + 1] === '(' && !opts.keepSubstitutions) {
      openSubstitution(false, i);
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    cur += c;
    inWord = true;
  }
  // An unclosed substitution still ends the command around it.
  while (frames.length > 0) close(command.length - 1);
  endSeg();
  while (levels.length > 0) {
    endPipeline();
    levels.pop();
  }
  return finish();
}

const PREFIX_WORDS = new Set(['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin', 'nice', 'timeout', 'coproc', 'noglob']);
/** Each prefix word's options that take a value (layer-1 round: one list for all of them made
 *  `sudo -n`, `time -p` and `command -p` take the program as their value). */
const PREFIX_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-U', '-D', '-R', '-T', '-C', '-r', '-t', '--user', '--group', '--host', '--prompt', '--other-user', '--chdir', '--chroot', '--command-timeout', '--close-from', '--role', '--type']),
  // `-P altpath`: macOS env's search path for the program.
  env: new Set(['-u', '-C', '-S', '-P', '--unset', '--chdir', '--split-string']),
  time: new Set(['-o', '-f', '--output', '--format']),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
};

/** Nested readings goodboy follows (`eval eval …`, `sh -c "sh -c …"`); a deeper one marks the
 *  reading `truncated` (final G1 review: past depth 3 the rest passed unread). */
const MAX_NESTING = 4;

/** Segments one command may produce, nested readings included (security-injection review: a
 *  2 KB `find -exec find -exec …` fanned out to millions and ran PreToolUse past its timeout,
 *  which lets the call through). Past it the reading stops and is marked `truncated`. */
export const MAX_SEGMENTS = 5000;

/** Every command segment a shell command runs, words with prefixes stripped, with the scripts
 *  of `sh|bash|zsh -c '<script>'` and `eval …` read again (MAX_NESTING deep). The one reader
 *  for every classifier (R2, push test, role limits, `claude -p`, markers, gate state), so a
 *  nested shell cannot get past one of them only (refactoring review). Redirections are
 *  dropped unless `keepRedirects` is set (for classifiers that ask whether a segment writes). */
export function commandSegments(command: string, opts: ReadOpts = {}, depth = 0): string[][] {
  const out: string[][] = [];
  // Heredoc bodies are data (a result JSON piped to the CLI, a script for a remote host), not
  //   commands of this shell: a `git push` in a test result's evidence is no push. A body fed
  //   to a local shell (`bash <<EOF`) is judged by the push check's stdin rule. The
  //   substitutions of an unquoted body (`<<EOF`) do run, so they are read (closing G1 round).
  const budget = opts.budget ?? { left: MAX_SEGMENTS, truncated: false, nested: 0 };
  const segScopes: string[] = [];
  const segs = shellSegments(stripHeredocs(command, { expansions: true }), { scopes: segScopes, budget });
  // Read inside a segment (`eval`, `sh -c`): this text's top scope is `opts.scope` itself, and
  //   its subshells and jobs hang below it (their ids are unique across one command's readings).
  const base = opts.scope;
  const scopeOf = (s: string) => (base === undefined ? s : base + s.slice(1));
  segs.forEach((seg, i) => expandSegment(seg, { ...opts, budget, scope: scopeOf(segScopes[i] ?? '0') }, depth, out));
  return out;
}

interface ReadOpts {
  keepRedirects?: boolean;
  /** Filled in step with the segments (readCommand). */
  meta?: SegmentMeta[];
  /** The scope being read (internal). */
  scope?: string;
  /** Work left for this command and whether it ran out (shared by every nested reading). */
  budget?: { left: number; truncated: boolean; nested: number };
}

interface SegmentMeta {
  /** The names a segment assigns before its program (`HOME=/x git …`, `env GIT_DIR=… git`; a
   *  bare `HOME=/x` segment has no program), and `:chdir` for `env -C` / `sudo -D`. */
  env: string[];
  /** Its subshell scope (shellSegments). A nested `sh -c` script is a child shell (`0/sh2`, its
   *  subshells `0/sh2.3`); an `eval` runs in the same shell, so its top scope is its parent's
   *  (a `cd` in it moves the parent). Parents are found by cutting at the last `.` or `/`. */
  scope: string;
  /** The dir `env -C dir` / `sudo -D dir` runs the program in (null: none goodboy can name),
   *  and the scope what that program runs is read in (`env -C dir sh -c '…'`). */
  chdir?: string | null;
  child?: string;
}

/** One segment of a command with the directory it runs in. */
export interface ReadSegment {
  /** Words with prefixes stripped; redirections kept only with `keepRedirects`. */
  words: string[];
  /** Env names assigned before the program; `:chdir` for `env -C dir` / `sudo -D dir`. */
  env: string[];
  scope: string;
  /** Where it runs: `cd`, `pushd`, `popd` and `builtin cd` move their scope (a subshell or a
   *  job, shellSegments) and the scopes opened inside it later; `env -C dir` runs one program
   *  in dir. Null when goodboy cannot tell (`cd -`, a computed dir, a `popd` past what it saw,
   *  after a `cd` that moves the shell in zsh only). A cd segment carries the dir it moved to. */
  dir: string | null;
  /** A cd that moves the shell in zsh but not in bash (`true | cd x`, `cd x && cmd &`): the
   *  shell's dir after it is unclear. */
  unsure?: boolean;
}

/** `dir` resolved from `from`, or null when it is computed (`$`, a glob) or `from` is unknown. */
function literalDir(dir: string | null, from: string | null): string | null {
  if (dir === null || dir === '-' || /[$`*?]/.test(dir) || from === null) return null;
  if (dir === '~' || dir.startsWith('~/')) return resolvePath(homedir(), dir.slice(2));
  return resolvePath(from, dir);
}

/** Where a `cd` moves from `from`, or null when goodboy cannot tell. `cd -P dir` moves to dir;
 *  a bare `cd` and `~` go home; `cd "$(git rev-parse --show-toplevel)"` stays in the same repo,
 *  which is all a repo-wide check needs. */
export function cdTarget(words: string[], from: string | null): string | null {
  const dir = words.slice(1).find((w) => !w.startsWith('-') || w === '-');
  if (dir === undefined) return homedir();
  if (/^(?:\$\(|`)\s*git rev-parse --show-toplevel\s*(?:\)|`)$/.test(dir)) return from;
  return literalDir(dir, from);
}

/** The shared reader with directories: every segment of `command` (commandSegments) and where
 *  it runs, starting in `cwd`. `truncated` when the command is too large to read whole. */
export function readCommand(command: string, cwd: string, opts: { keepRedirects?: boolean } = {}): { segments: ReadSegment[]; truncated: boolean } {
  const meta: SegmentMeta[] = [];
  const budget = { left: MAX_SEGMENTS, truncated: false, nested: 0 };
  const all = commandSegments(command, { keepRedirects: opts.keepRedirects, meta, budget });
  const dirOf = new Map<string, string | null>();
  // Per scope, the dirs `popd` goes back to, the next one last.
  const stacks = new Map<string, (string | null)[]>();
  // A scope's dir is its own once it moved, else its parent's (walked up without recursion).
  const dirFor = (scope: string): string | null => {
    const unset: string[] = [];
    let s = scope;
    let d: string | null = cwd;
    for (;;) {
      if (dirOf.has(s)) {
        d = dirOf.get(s)!;
        break;
      }
      unset.push(s);
      const cut = Math.max(s.lastIndexOf('.'), s.lastIndexOf('/'), s.lastIndexOf(':'));
      if (cut < 0) break;
      s = s.slice(0, cut);
    }
    for (const u of unset) dirOf.set(u, d);
    return d;
  };
  const segments = all.map((words, s): ReadSegment => {
    const { env: names, scope, chdir, child } = meta[s] ?? { env: [], scope: '0' };
    const plain = dropRedirects(words);
    const prog = basename(plain[0] ?? '');
    // Only the built-in moves the shell: `/usr/bin/cd x` runs a child shell's cd (round-4
    //   review).
    const builtin = (plain[0] ?? '').includes('/') ? '' : prog;
    const args = plain.slice(1);
    const from = dirFor(scope);
    // A cd directly in an `a` job moves the shell in zsh, not in bash: the shell's dir is
    //   unclear after it (`true | cd x`, `cd x && cmd &`).
    const unsure = /\.a\d+$/.test(scope);
    const move = (to: string | null, stack: (string | null)[]) => {
      dirOf.set(scope, to);
      stacks.set(scope, stack);
      if (unsure) {
        const shell = scope.slice(0, scope.lastIndexOf('.'));
        dirOf.set(shell, null);
        stacks.set(shell, []);
      }
    };
    const seg = (dir: string | null): ReadSegment => (unsure ? { words, env: names, scope, dir, unsure } : { words, env: names, scope, dir });
    const stack = [...(stacks.get(scope) ?? [])];
    if (builtin === 'cd' || builtin === 'pushd') {
      // `pushd -n dir` puts dir on the stack without moving; bare `pushd` and `pushd +N` rotate.
      const rotate = prog === 'pushd' && (args.length === 0 || args.some((w) => /^[+-]\d/.test(w)));
      const to = rotate ? null : cdTarget(plain, from);
      if (prog === 'pushd' && args.includes('-n')) {
        move(from, [...stack, to]);
        return seg(from);
      }
      move(to, prog === 'pushd' ? [...stack, from] : stack);
      return seg(to);
    }
    if (builtin === 'popd') {
      const numbered = args.some((w) => /^[+-]\d/.test(w));
      const top = stack.length > 0 && !numbered ? stack.pop()! : null;
      // `popd -n` drops the top entry without moving (layer-1 round); `popd +N` is not followed.
      const to = args.includes('-n') ? from : top;
      move(to, numbered ? [] : stack);
      return seg(to);
    }
    const dir = chdir === undefined ? from : literalDir(chdir, from);
    if (child !== undefined) dirOf.set(child, dir);
    return { words, env: names, scope, dir };
  });
  return { segments, truncated: budget.truncated };
}

/** Index of the command `xargs` runs in its words (`xargs -n1 -I{} git …` → the `git`), or the
 *  length when there is none. Value-taking flags: -I, -n, -L, -P, -d, -E, -s, -J, -R (GNU's
 *  `-i[replace]` takes its value attached, so `-i git …` runs git: final G1 review). */
export function xargsCommandAt(words: string[], from = 1): number {
  let i = from;
  while (i < words.length && words[i]!.startsWith('-')) i += /^-[InLPdEsJR]$/.test(words[i]!) ? 2 : 1;
  return i;
}

/** git's global options that take a value as the next word. */
export const GIT_VALUE_OPTS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);

/** Index of git's subcommand in a `git …` segment's words, after the global options. */
export function gitSubcommandAt(words: string[], from = 1): number {
  let i = from;
  while (i < words.length && words[i]!.startsWith('-')) i += GIT_VALUE_OPTS.has(words[i]!) ? 2 : 1;
  return i;
}

/** One segment, then the commands it runs from its arguments, each read the same way (so a
 *  `sh -c` inside `xargs` or `find -exec` is read too, final review). */
function expandSegment(seg: string[], opts: ReadOpts, depth: number, out: string[][]): void {
  const budget = opts.budget!;
  if (budget.left <= 0) {
    budget.truncated = true;
    return;
  }
  budget.left--;
  const { rest: raw, names, chdir } = readPrefix(seg, budget);
  // `env -C dir` / `sudo -D dir` runs the program, and what it runs, elsewhere: also reported
  //   as the name `:chdir`.
  const child = chdir === undefined ? undefined : `${opts.scope ?? '0'}.c${++budget.nested}`;
  opts.meta?.push({ env: chdir === undefined ? names : [...names, ':chdir'], scope: opts.scope ?? '0', chdir, child });
  const inner = child === undefined ? opts : { ...opts, scope: child };
  const read = dropRedirects(raw);
  const plain = programWords(read);
  out.push(opts.keepRedirects ? (raw[0] === read[0] ? programWords(raw) : raw) : plain);
  const prog = basename(plain[0] ?? '');
  // Programs that run a command from their arguments (security review round 3): the command
  //   after `xargs`' flags, each `find -exec|-execdir|-ok … ;`, a shell's `-c` script (also in
  //   a flag cluster: `-lc`, `-ec`) and `eval`.
  const shellC = SHELLS.test(prog) ? plain.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) : -1;
  const runs =
    prog === 'xargs' ? xargsCommandAt(plain) < plain.length : prog === 'find' ? plain.some((w) => FIND_EXEC.has(w)) : shellC >= 0 || (prog === 'eval' && plain.length > 1);
  if (!runs) return;
  if (depth >= MAX_NESTING) {
    budget.truncated = true;
    return;
  }
  if (prog === 'xargs') {
    expandSegment(plain.slice(xargsCommandAt(plain)), inner, depth + 1, out);
  } else if (prog === 'find') {
    for (let i = 1; i < plain.length; i++) {
      if (!FIND_EXEC.has(plain[i]!)) continue;
      const end = plain.findIndex((w, j) => j > i && (w === ';' || w === '\\;' || w === '+'));
      expandSegment(plain.slice(i + 1, end < 0 ? undefined : end), inner, depth + 1, out);
      // With no terminator the command runs to the end, later `-exec`s included: read once.
      if (end < 0) break;
      i = end;
    }
  } else if (shellC >= 0) {
    // The script is the next word that is not a flag. A nested shell is a child scope of its
    //   own (`0/sh2`): its `cd` stays inside it, and a sibling `sh -c` does not share it.
    const script = plain.slice(shellC + 1).find((w) => !w.startsWith('-'));
    if (script !== undefined) out.push(...commandSegments(script, { ...inner, scope: `${inner.scope ?? '0'}/sh${++budget.nested}` }, depth + 1));
  } else {
    out.push(...commandSegments(plain.slice(1).join(' '), { ...inner, scope: inner.scope ?? '0' }, depth + 1));
  }
}

const SHELLS = /^(?:ba|z|da|k|c|tc|fi)?sh$/;
const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/** Built-ins whose capitalized spelling runs another program (macOS's `/usr/bin/cd` runs `cd`
 *  in a child shell and moves nothing): their spelling is kept. */
const CASE_KEPT: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd']);

/** A segment's program word as the system finds it (final G1 test round): on a
 *  case-insensitive file system (macOS) `GIT` and `CURL` run git and curl, so a name is read in
 *  lower case; git's dashed programs (`…/git-core/git-push`) run `git push`. */
function programWords(words: string[]): string[] {
  const w = words[0];
  if (w === undefined) return words;
  const slash = w.lastIndexOf('/');
  const base = w.slice(slash + 1);
  const lower = base.toLowerCase();
  const dashed = lower.match(/^git-([a-z][a-z0-9-]*)$/);
  if (dashed) return ['git', dashed[1]!, ...words.slice(1)];
  if (lower === base || CASE_KEPT.has(lower)) return words;
  return [w.slice(0, slash + 1) + lower, ...words.slice(1)];
}

/** A word that is one whole command substitution (`$(…)`, `` `…` ``): its text is known only
 *  at run time. */
export const WHOLE_SUBSTITUTION = /^\$\([^]*\)$|^`[^]*`$/;

/** True when a command may run git: its text names git in any letter case once quotes and
 *  backslashes are gone (`g''it`, `gi\t`, `GIT`, `git-commit`). */
export function mentionsGit(command: string): boolean {
  return /git/i.test(command.replace(/["'\\]/g, ''));
}

/** True when a shell segment (`bash …`) reads its script from stdin: no script operand
 *  (`bash`, `bash -e`, `bash -o errexit`, `bash -`), `-s`, or `/dev/stdin` as the script
 *  (final G1 test round: a value of `-o` read as the script). */
export function shellReadsStdin(words: string[]): boolean {
  let k = 1;
  while (k < words.length) {
    const w = words[k]!;
    if (w === '-' || w === '--') {
      k++;
      break;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) return false;
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(w)) return true;
    // `-o name`, also at the end of a cluster (`-eo pipefail`)
    if (/^[-+][a-zA-Z]*[oO]$/.test(w) || w === '--rcfile' || w === '--init-file') {
      k += 2;
      continue;
    }
    if (!w.startsWith('-') && !w.startsWith('+')) break;
    k++;
  }
  const script = words[k];
  return script === undefined || script === '/dev/stdin' || script === '/dev/fd/0';
}

const REDIRECT_WORD = /^\d*(?:&?>>?|>\||>&)/;

/** A word with quotes and backslashes removed and `.` / `//` path parts folded, for name
 *  checks (`.cl""aude/./te\sts` reads as `.claude/tests`). */
export function plainWord(w: string): string {
  return w.replace(/["'\\]/g, '').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');
}

/** The first word that `names` matches in a segment that changes it: a redirect whose target
 *  is that word, or a program outside `readProgs` that names it (`ls marker 2>/dev/null` is a
 *  read). Null when no segment does. */
export function segmentChanging(command: string, names: (word: string) => boolean, readProgs: ReadonlySet<string>): string | null {
  for (const words of commandSegments(command, { keepRedirects: true })) {
    const named = (w: string) => names(w) || names(plainWord(w));
    // Redirect targets: the text after an operator, or the next word when it stands alone.
    for (let i = 0; i < words.length; i++) {
      const m = words[i]!.match(REDIRECT_WORD);
      if (!m) continue;
      const target = words[i]!.slice(m[0].length) || words[i + 1] || '';
      if (named(target)) return target;
    }
    const plainWords = dropRedirects(words);
    const hit = plainWords.find(named);
    if (!hit) continue;
    const prog = basename(plainWords[0] ?? '');
    if (!readProgs.has(prog)) return hit;
    if (prog === 'find' && plainWords.some((w) => w === '-delete' || w === '-exec' || w === '-execdir')) return hit;
  }
  return null;
}

const REDIRECT = /^\d*(&>>?|>>?|<<<|<<|<|>&|<&)(.*)$/;

/** A segment's words without redirections: `2>&1`, `>out`, `> out`, `&>/dev/null`, `<<EOF`.
 *  An operator standing alone takes the next word as its target. */
export function dropRedirects(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = words[i]!.match(REDIRECT);
    if (!m) {
      out.push(words[i]!);
      continue;
    }
    if (m[2] === '') i++; // the target is the next word
  }
  return out;
}

/** Compound-command words that start a segment without being its program (`if x; then git
 *  push …; fi`, `{ git push; }`: final G1 review). `for`, `case` and `select` headers stay, as
 *  their words are no command. */
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '}']);

/** A segment's words without leading shell keywords, env assignments and prefix commands
 *  (sudo, env, timeout …). */
export function stripPrefix(words: string[]): string[] {
  return readPrefix(words).rest;
}

/** A prefix word's option at `ws[i]`: its name, its value (attached, or the next word when it
 *  takes one) and how many words it spans. In a short cluster (`sudo -nu root`) the first
 *  letter that takes a value takes the rest of the cluster or the next word. */
function prefixOption(ws: string[], i: number, valued: ReadonlySet<string> | undefined): { name: string; value?: string; span: number } {
  const w = ws[i]!;
  if (w.startsWith('--')) {
    const eq = w.indexOf('=');
    if (eq > 0) return { name: w.slice(0, eq), value: w.slice(eq + 1), span: 1 };
    return valued?.has(w) ? { name: w, value: ws[i + 1], span: 2 } : { name: w, span: 1 };
  }
  for (let k = 1; k < w.length; k++) {
    const name = `-${w[k]}`;
    if (valued?.has(name)) return k < w.length - 1 ? { name, value: w.slice(k + 1), span: 1 } : { name, value: ws[i + 1], span: 2 };
  }
  return { name: w, span: 1 };
}

/** `env -S` strings read again in one segment; more mark the reading truncated (closing G1
 *  review: each re-read copies the words, so a long chain was quadratic). */
const MAX_SPLIT_STRINGS = 16;

/** stripPrefix with what the prefix said: the names assigned before the program, and the dir
 *  `env -C dir` or `sudo -D dir` runs it in (null when that dir is missing). `env -S 'prog
 *  args'` runs its split string (layer-1 round: it hid the program). A word that is a whole
 *  command substitution names the program at run time (`$(which env) git push`): it is
 *  skipped like a prefix word, so the command after it is read (closing G1 review). */
export function readPrefix(words: string[], budget?: { truncated: boolean }): { rest: string[]; names: string[]; chdir?: string | null } {
  let ws = words;
  const names: string[] = [];
  let chdir: string | null | undefined;
  let splits = 0;
  let i = 0;
  next: while (i < ws.length) {
    const w = ws[i]!;
    // A prefix program by the name the system finds (`/usr/bin/env`, `SUDO` on macOS).
    const p = basename(w).toLowerCase();
    if (SHELL_KEYWORDS.has(w)) i++;
    // `function f { …; }`: the name is no program (layer-1 round: the body was hidden).
    else if (w === 'function') i += 2;
    else if (/^\$\([^]*\)$|^`[^]*`$/.test(w)) i++;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      names.push(w.slice(0, w.indexOf('=')));
      i++;
    }
    // `command -v sh` looks a name up and runs nothing (layer-1 round: it read as a shell).
    else if (p === 'command' && /^-[a-zA-Z]*[vV]/.test(ws[i + 1] ?? '')) break;
    else if (PREFIX_WORDS.has(p)) {
      i++;
      while (i < ws.length && ws[i]!.startsWith('-')) {
        if (ws[i] === '--') {
          i++;
          break;
        }
        const o = prefixOption(ws, i, PREFIX_VALUE_OPTS[p]);
        i += o.span;
        if ((p === 'env' && o.name === '-C') || (p === 'sudo' && o.name === '-D') || ((p === 'env' || p === 'sudo') && o.name === '--chdir')) {
          chdir = o.value ?? null;
        }
        if (p === 'env' && (o.name === '-S' || o.name === '--split-string')) {
          if (++splits > MAX_SPLIT_STRINGS) {
            if (budget) budget.truncated = true;
            break next;
          }
          ws = [...(o.value ?? '').split(/\s+/).filter(Boolean), ...ws.slice(i)];
          i = 0;
          continue next;
        }
      }
      // timeout's duration (`timeout 1.5 cmd`, `timeout 30s cmd`)
      if (p === 'timeout' && /^\d+(?:\.\d+)?[smhd]?$/.test(ws[i] ?? '')) i++;
    } else break;
  }
  return chdir === undefined ? { rest: ws.slice(i), names } : { rest: ws.slice(i), names, chdir };
}

/** Host of a URL or `[user@]host[:port][/path]`; '' when none. */
export function hostOf(raw: string): string {
  let s = raw.trim();
  const scheme = s.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (scheme) s = s.slice(scheme[0].length);
  s = s.replace(/^[^@/]*@/, ''); // credentials or ssh user
  if (s.startsWith('[')) return (s.match(/^\[([^\]]+)\]/)?.[1] ?? '').toLowerCase(); // IPv6
  const host = s.split(/[/:?#]/)[0] ?? '';
  return host.toLowerCase();
}

function isUrlLike(w: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(w) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(w) || /^localhost(:\d+)?(\/|$)/.test(w);
}

/** Non-flag arguments, skipping the values of flags that take one. */
function positionals(args: string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      if (!a.includes('=') && valueFlags.has(a)) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function flagValue(args: string[], names: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    for (const n of names) {
      if (a === n && i + 1 < args.length) return args[i + 1]!;
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
      if (n.length === 2 && !n.startsWith('--') && a.startsWith(n) && a.length > 2 && !a.startsWith('--')) return a.slice(2);
    }
  }
  return null;
}

// ---- tool catalog ---------------------------------------------------------------------

const CURL_VALUE_FLAGS = new Set([
  '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json',
  '-H', '--header', '-o', '--output', '-u', '--user', '-F', '--form', '-T', '--upload-file',
  '-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '--url',
  '-w', '--write-out', '-K', '--config', '--connect-to', '--resolve', '-x', '--proxy',
  '-m', '--max-time', '--retry', '--cacert', '--cert', '--key', '-E',
]);

function curlTargets(args: string[]): OutwardTarget[] {
  const method = (flagValue(args, ['-X', '--request']) ?? '').toUpperCase();
  const sendsBody = args.some((a) =>
    /^(-d|--data(-raw|-binary|-urlencode)?|--json|-F|--form|-T|--upload-file)(=|$)/.test(a) || /^-d./.test(a) || /^-F./.test(a),
  );
  const getMode = args.includes('-G') || args.includes('--get') || args.includes('-I') || args.includes('--head');
  const mutating = method !== '' ? !['GET', 'HEAD', 'OPTIONS'].includes(method) : sendsBody && !getMode;
  const urls = [...positionals(args, CURL_VALUE_FLAGS), ...(flagValue(args, ['--url']) ? [flagValue(args, ['--url'])!] : [])];
  return urls.filter(isUrlLike).map((u) => ({ kind: 'curl', host: hostOf(u), mutating }));
}

function wgetTargets(args: string[]): OutwardTarget[] {
  const method = (flagValue(args, ['--method']) ?? '').toUpperCase();
  const posts = args.some((a) => /^--(post-data|post-file|body-data|body-file)(=|$)/.test(a));
  const mutating = method !== '' ? !['GET', 'HEAD'].includes(method) : posts;
  const vf = new Set(['-O', '--output-document', '-o', '--output-file', '-P', '--directory-prefix', '-U', '--user-agent', '--header', '--post-data', '--post-file', '--method', '--body-data', '--body-file']);
  return positionals(args, vf).filter(isUrlLike).map((u) => ({ kind: 'wget', host: hostOf(u), mutating }));
}

function httpieTargets(args: string[]): OutwardTarget[] {
  const pos = positionals(args, new Set(['-a', '--auth', '-o', '--output', '--session', '--verify', '--cert', '--cert-key']));
  let i = 0;
  let method = '';
  if (pos[0] && /^[A-Z]+$/.test(pos[0])) method = pos[i++]!;
  const url = pos[i];
  if (!url) return [];
  const items = pos.slice(i + 1);
  const hasData = items.some((it) => /^[^=:@]+(:?=|=@|@)/.test(it) && !/^[^:]+:[^=]/.test(it));
  const mutating = method !== '' ? !['GET', 'HEAD', 'OPTIONS'].includes(method) : hasData;
  const host = url.startsWith(':') || url.startsWith('/') ? 'localhost' : hostOf(url);
  return [{ kind: 'httpie', host, mutating }];
}

const SSH_VALUE_FLAGS = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-W', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-w', '-B', '-P']);

function remoteSpecHost(arg: string): string | null {
  // [user@]host:path, not a URL, a Windows drive, or a local path with a colon after a slash.
  if (arg.includes('://')) return null;
  const m = arg.match(/^(?:[^@/\s]+@)?([^:/\s]+):/);
  if (!m || /^[A-Za-z]$/.test(m[1]!)) return null;
  return m[1]!.toLowerCase();
}

function sshTargets(prog: string, args: string[]): OutwardTarget[] {
  const pos = positionals(args, SSH_VALUE_FLAGS);
  if (prog === 'ssh') {
    const dest = pos[0];
    return dest ? [{ kind: 'ssh', host: hostOf(dest.includes('://') ? dest : `ssh://${dest}`), mutating: true }] : [];
  }
  if (prog === 'sftp') {
    const dest = pos[0];
    return dest ? [{ kind: 'sftp', host: hostOf(`ssh://${dest}`), mutating: true }] : [];
  }
  // scp / rsync: writing to the remote end (the last argument) is mutating; reading is not.
  const out: OutwardTarget[] = [];
  pos.forEach((p, idx) => {
    const host = remoteSpecHost(p);
    if (host) out.push({ kind: prog, host, mutating: idx === pos.length - 1 });
  });
  return out;
}

/** `git push` targets (also `git send-pack` and `git http-push`, final G1 test round): the
 *  remote's URL from .git/config, or the remote name. */
function gitTargets(args: string[], cwd: string): OutwardTarget[] {
  const pos = positionals(args, GIT_VALUE_OPTS);
  const sub = pos[0];
  if (sub !== 'push' && sub !== 'send-pack' && sub !== 'http-push') return [];
  if (args.includes('--dry-run') || args.includes('-n')) return [{ kind: 'git push', host: 'git-remote', mutating: false }];
  const remote = pos[1] ?? 'origin';
  const url = isUrlLike(remote) || remoteSpecHost(remote) ? remote : gitRemoteUrl(cwd, remote);
  const host = url ? (remoteSpecHost(url) ?? hostOf(url)) : `git-remote:${remote}`;
  return [{ kind: 'git push', host: host || `git-remote:${remote}`, mutating: true }];
}

export function gitRemoteUrl(cwd: string, remote: string): string | null {
  let dir = resolvePath(cwd);
  for (let i = 0; i < 40; i++) {
    const cfg = join(dir, '.git', 'config');
    if (existsSync(cfg)) {
      try {
        const text = readFileSync(cfg, 'utf8');
        const sec = text.split(/^\[/m).find((s) => s.startsWith(`remote "${remote}"]`));
        const m = sec?.match(/^\s*url\s*=\s*(.+)$/m);
        return m ? m[1]!.trim() : null;
      } catch {
        return null;
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const KUBE_MUTATING = new Set([
  'apply', 'create', 'delete', 'patch', 'replace', 'scale', 'rollout', 'set', 'label', 'annotate',
  'edit', 'exec', 'cp', 'drain', 'cordon', 'uncordon', 'taint', 'expose', 'run', 'autoscale',
]);

function kubeTargets(prog: string, args: string[]): OutwardTarget[] {
  const ctx = flagValue(args, ['--context', '--kube-context']) ?? 'current';
  const pos = positionals(args, new Set(['-n', '--namespace', '--context', '--kube-context', '-f', '--filename', '-l', '--selector', '-o', '--output', '-c', '--container', '--kubeconfig']));
  const verb = pos[0] ?? '';
  let mutating: boolean;
  if (prog === 'helm') mutating = ['install', 'upgrade', 'uninstall', 'delete', 'rollback', 'push'].includes(verb);
  else mutating = KUBE_MUTATING.has(verb);
  return verb ? [{ kind: prog, host: `kube:${ctx}`, mutating }] : [];
}

function iacTargets(prog: string, args: string[]): OutwardTarget[] {
  const pos = positionals(args, new Set(['-var', '-var-file', '-target', '-chdir', '--stack', '-s']));
  const verb = pos[0] ?? '';
  const sub = pos[1] ?? '';
  const mutating =
    prog === 'pulumi'
      ? ['up', 'destroy', 'import', 'cancel', 'refresh'].includes(verb)
      : ['apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock'].includes(verb) ||
        (verb === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(sub)) ||
        (verb === 'workspace' && sub === 'delete');
  return verb ? [{ kind: prog === 'tofu' ? 'terraform' : prog, host: prog === 'tofu' ? 'terraform' : prog, mutating }] : [];
}

function registryHost(image: string): string {
  const first = image.split('/')[0] ?? '';
  return image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? hostOf(first) : 'docker.io';
}

function publishTargets(prog: string, args: string[]): OutwardTarget[] {
  const pos = positionals(args, new Set(['--registry', '--tag', '--access', '--otp', '-r', '--repository', '--token']));
  const verb = pos[0] ?? '';
  if (prog === 'docker' || prog === 'podman') {
    if (verb !== 'push') return [];
    return [{ kind: `${prog} push`, host: registryHost(pos[1] ?? ''), mutating: true }];
  }
  const npmLike = ['npm', 'pnpm', 'yarn', 'bun'].includes(prog);
  const publishes =
    (npmLike && ['publish', 'unpublish', 'deprecate'].includes(verb)) ||
    (npmLike && verb === 'dist-tag' && ['add', 'rm'].includes(pos[1] ?? '')) ||
    (prog === 'cargo' && ['publish', 'yank'].includes(verb)) ||
    (prog === 'gem' && ['push', 'yank'].includes(verb)) ||
    (prog === 'twine' && verb === 'upload') ||
    (prog === 'poetry' && verb === 'publish') ||
    (prog === 'uv' && verb === 'publish');
  if (!publishes) return [];
  const reg = flagValue(args, ['--registry', '--repository-url']);
  const def: Record<string, string> = { cargo: 'crates.io', gem: 'rubygems.org', twine: 'pypi.org', poetry: 'pypi.org', uv: 'pypi.org' };
  return [{ kind: `${prog} ${verb}`, host: reg ? hostOf(reg) : (def[prog] ?? 'registry.npmjs.org'), mutating: true }];
}

const GH_MUTATING: Record<string, string[]> = {
  pr: ['create', 'merge', 'close', 'edit', 'comment', 'review', 'reopen', 'ready'],
  issue: ['create', 'close', 'comment', 'edit', 'delete', 'reopen', 'transfer', 'lock'],
  release: ['create', 'delete', 'upload', 'edit'],
  repo: ['create', 'delete', 'edit', 'archive', 'rename', 'fork'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
  gist: ['create', 'edit', 'delete'],
  label: ['create', 'edit', 'delete'],
};

function forgeTargets(prog: string, args: string[]): OutwardTarget[] {
  const pos = positionals(args, new Set(['-R', '--repo', '--hostname', '-X', '--method', '-f', '-F', '--field', '--raw-field', '-H', '--header', '-b', '--body', '-t', '--title']));
  const [group = '', verb = ''] = pos;
  const host = flagValue(args, ['--hostname']) ?? (prog === 'gh' ? 'github.com' : 'gitlab.com');
  if (group === 'api') {
    const method = (flagValue(args, ['-X', '--method']) ?? '').toUpperCase();
    const fields = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
    const mutating = method !== '' ? method !== 'GET' : fields;
    return [{ kind: `${prog} api`, host, mutating }];
  }
  const glab: Record<string, string[]> = { mr: ['create', 'merge', 'close', 'note', 'update', 'approve'], issue: ['create', 'close', 'note', 'update', 'delete'] };
  const table = prog === 'gh' ? GH_MUTATING : glab;
  if (!table[group]) return [];
  return [{ kind: `${prog} ${group}`, host, mutating: table[group]!.includes(verb) }];
}

const CLOUD_MUTATING = /^(create|delete|put|update|remove|modify|attach|detach|associate|disassociate|start|stop|terminate|reboot|run|invoke|publish|send|deploy|register|deregister|restore|import|tag|untag|set|enable|disable|reset|revoke|authorize|copy|replace|cancel|execute|apply|upload|add|patch|resize|purge|restart)/;

function cloudTargets(prog: string, args: string[]): OutwardTarget[] {
  const pos = positionals(args, new Set(['--profile', '--region', '--endpoint-url', '--output', '--query', '--project', '--zone', '--subscription', '-g', '--resource-group', '--format']));
  if (pos.length === 0) return [];
  const endpoint = flagValue(args, ['--endpoint-url']);
  const host = endpoint ? hostOf(endpoint) : ({ aws: 'aws', gcloud: 'gcloud', az: 'azure' } as Record<string, string>)[prog]!;
  if (prog === 'aws' && pos[0] === 's3') {
    const verb = pos[1] ?? '';
    const last = pos[pos.length - 1] ?? '';
    const mutating = ['rm', 'mb', 'rb'].includes(verb) || (['cp', 'mv', 'sync'].includes(verb) && last.startsWith('s3://'));
    return [{ kind: 'aws s3', host, mutating }];
  }
  // aws <service> <operation>; gcloud/az put the verb anywhere after the groups.
  const words = prog === 'aws' ? [pos[1] ?? ''] : pos.slice(1);
  return [{ kind: prog, host, mutating: words.some((w) => CLOUD_MUTATING.test(w)) }];
}

const DB_READ_ONLY = new Set(['pg_dump', 'pg_dumpall', 'mysqldump', 'mongodump', 'mongoexport']);

function dbTargets(prog: string, args: string[]): OutwardTarget[] {
  const uri = args.find((a) => /^(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|redis|rediss|clickhouse):\/\//i.test(a));
  let host = uri ? hostOf(uri) : (flagValue(args, ['-h', '--host', '-H', '--hostname', '-S', '--server']) ?? '');
  if (prog === 'sqlcmd') host = host.replace(/^tcp:/i, '').split(/[,\\]/)[0] ?? host;
  if (host === '') return []; // a local socket
  return [{ kind: prog, host: host.toLowerCase(), mutating: !DB_READ_ONLY.has(prog) }];
}

/** Every outward target a shell command names. */
export function classifyOutward(command: string, cwd: string): OutwardTarget[] {
  const out: OutwardTarget[] = [];
  for (const words of commandSegments(command)) {
    if (words.length === 0) continue;
    const prog = basename(words[0]!);
    const args = words.slice(1);
    switch (prog) {
      case 'curl':
        out.push(...curlTargets(args));
        break;
      case 'wget':
        out.push(...wgetTargets(args));
        break;
      case 'http':
      case 'https':
      case 'xh':
      case 'xhs':
        out.push(...httpieTargets(args));
        break;
      case 'ssh':
      case 'scp':
      case 'rsync':
      case 'sftp':
        out.push(...sshTargets(prog, args));
        break;
      case 'git':
        out.push(...gitTargets(args, cwd));
        break;
      case 'kubectl':
      case 'oc':
      case 'helm':
        out.push(...kubeTargets(prog, args));
        break;
      case 'terraform':
      case 'tofu':
      case 'pulumi':
        out.push(...iacTargets(prog, args));
        break;
      case 'docker':
      case 'podman':
      case 'npm':
      case 'pnpm':
      case 'yarn':
      case 'bun':
      case 'cargo':
      case 'gem':
      case 'twine':
      case 'poetry':
      case 'uv':
        out.push(...publishTargets(prog, args));
        break;
      case 'gh':
      case 'glab':
        out.push(...forgeTargets(prog, args));
        break;
      case 'aws':
      case 'gcloud':
      case 'az':
        out.push(...cloudTargets(prog, args));
        break;
      case 'psql':
      case 'pg_dump':
      case 'pg_dumpall':
      case 'pg_restore':
      case 'mysql':
      case 'mariadb':
      case 'mysqldump':
      case 'mongosh':
      case 'mongo':
      case 'mongodump':
      case 'mongoexport':
      case 'mongorestore':
      case 'redis-cli':
      case 'sqlcmd':
      case 'clickhouse-client':
      case 'cqlsh':
        out.push(...dbTargets(prog, args));
        break;
      default:
        break;
    }
  }
  return out.filter((t) => t.host !== '');
}

// ---- host classes ---------------------------------------------------------------------

const LOCAL_KUBE = [/^kube:(kind-.*|k3d-.*|minikube|docker-desktop|rancher-desktop|colima|orbstack)$/];

/** Built-in local or reserved targets (never a real external system). */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || h === 'host.docker.internal') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/\.(test|invalid|example|localhost)$/.test(h) || /^example\.(com|net|org)$/.test(h)) return true;
  return LOCAL_KUBE.some((re) => re.test(h));
}

export interface HostRules {
  allow: string[];
  production: string[];
  /** `.goodboy/hosts` paths that exist but cannot be read as a plain file (no permission, a
   *  directory, a symlink): their entries are unknown, so every external host counts as
   *  production until the user fixes them (security review round 3). */
  broken?: string[];
}

function globMatch(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  if (p === host) return true;
  if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  if (p.endsWith('*')) return host.startsWith(p.slice(0, -1));
  return false;
}

/** The `allow`/`production` entries of a hosts file's text. */
export function parseHostRules(text: string): HostRules {
  const rules: HostRules = { allow: [], production: [] };
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*$/, '').trim().match(/^(allow|production)\s+(\S+)$/i);
    if (m) rules[m[1]!.toLowerCase() as 'allow' | 'production'].push(m[2]!);
  }
  return rules;
}

/** Every `.goodboy/hosts` from cwd up to the root, merged (track G security review): a nearer
 *  file adds entries and never drops a parent's `production` one, so an empty or allow-only
 *  file in a subfolder cannot lift R2. Production still wins over allow (classifyHost). */
export function readHostRules(cwd: string): HostRules {
  const rules: HostRules = { allow: [], production: [], broken: [] };
  for (const file of hostsFilesFrom(cwd)) {
    try {
      // A symlink to a readable file is fine (dotfile setups); /dev/null, a directory or a file
      //   that cannot be read is broken (final review).
      if (!statSync(file).isFile()) throw new Error('not a plain file');
      const r = parseHostRules(readFileSync(file, 'utf8'));
      rules.allow.push(...r.allow);
      rules.production.push(...r.production);
    } catch {
      rules.broken!.push(file);
    }
  }
  return rules;
}

/** The `.goodboy/hosts` paths from cwd up to the root, nearest first: files that exist, and
 *  the path inside a `.goodboy` dir that exists but cannot be listed (so it reads as broken). */
export function hostsFilesFrom(cwd: string): string[] {
  const out: string[] = [];
  let dir = resolvePath(cwd);
  for (let i = 0; i < 40; i++) {
    const meta = join(dir, '.goodboy');
    const file = join(meta, 'hosts');
    let listed = true;
    try {
      // Only a `.goodboy` directory that cannot be listed hides its hosts file; a plain file of
      //   that name is no rules dir at all.
      if (existsSync(meta) && lstatSync(meta).isDirectory()) readdirSync(meta);
    } catch {
      listed = false;
    }
    if (!listed || existsSync(file) || isSymlink(file)) out.push(file);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True for a `.goodboy/hosts` path. */
export function isHostsFile(p: string): boolean {
  return basename(p) === 'hosts' && basename(dirname(resolvePath(p))) === '.goodboy';
}

/** Production entries present in `before` and missing from `after` (lower-cased). The model
 *  may add hosts; removing or downgrading a production one is the user's call (R2). */
export function removedProduction(before: string, after: string): string[] {
  const kept = new Set(parseHostRules(after).production.map((h) => h.toLowerCase()));
  return parseHostRules(before)
    .production.map((h) => h.toLowerCase())
    .filter((h) => !kept.has(h));
}

/** Production wins over allow, so a broad `allow *.corp.com` cannot unlock a listed production host. */
export function classifyHost(host: string, rules: HostRules): HostClass {
  if (rules.production.some((p) => globMatch(p, host))) return 'production';
  if (isLocalHost(host)) return 'local';
  if ((rules.broken ?? []).length > 0) return 'production';
  if (rules.allow.some((p) => globMatch(p, host))) return 'allow';
  return 'unlisted';
}

export type OutwardAction = 'pass' | 'advise' | 'deny-unlisted' | 'deny-production';

/** What the gate does with a command's targets. Reads always pass. */
export function decideOutward(
  targets: OutwardTarget[],
  rules: HostRules,
  inSubagent: boolean,
): { action: OutwardAction; target?: OutwardTarget } {
  const mutating = targets.filter((t) => t.mutating);
  const prod = mutating.find((t) => classifyHost(t.host, rules) === 'production');
  if (prod) return { action: 'deny-production', target: prod };
  const unlisted = mutating.find((t) => classifyHost(t.host, rules) === 'unlisted');
  if (unlisted) return { action: inSubagent ? 'deny-unlisted' : 'advise', target: unlisted };
  return { action: 'pass' };
}
