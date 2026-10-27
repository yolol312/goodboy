// The one place a hook or library runs git in the model's repo (v0.36.6, gate cost). Before it,
// fourteen sites spawned `git` themselves, each with its own subset of the protections of
// lib/hook-git.ts (some had none), and a Stop repeated byte-identical calls. Every call here
// has, whoever the caller is:
//   - `--no-replace-objects` (a replace ref shows another commit's tree) and no grafts;
//   - no fsmonitor, no signature check, no transport, no lazy fetch (lib/hook-git.ts);
//   - no external diff program and no textconv for a command that diffs (`diff`, `show`, `log`:
//     `--no-ext-diff --no-textconv`; `blame`, `grep`: `--no-textconv`), whatever the repo's config sets;
//   - every filter driver of the repo's config emptied for a command that can run one
//     (`status`, `diff`, `hash-object`, `add`…), counted from `git config` for this call: when
//     that listing fails, the command is not run;
//   - the safety settings after the caller's own `-c` and global options, so a caller's value
//     (or a user command's `-c`, lib/commit-issue.ts) never overrides them, and the safety
//     environment over the caller's: only the names in OPERATIONAL_ENV pass from a caller.
// The binary is the one lib/git-binary.ts picks. Callers keep their own limits: a time limit per
// call (and one shared deadline), raw output, stdin, `maxBuffer`.
//
// The memo. A Stop asks the same question of git more than once (the repo top four times, the
// filter list five, the same start-tree listing twice). Inside a snapshot (`beginGitSnapshot`,
// one Stop) the answers that cannot change while it runs are kept: object reads by full object
// id, the repo top, the filter list, and HEAD resolved once. Never memoized: anything that reads
// the work tree or the index (status, diff, ls-files, hash-object, check-ignore, add,
// write-tree), anything with an env override, an error or a timeout. Outside a snapshot nothing
// is kept. The current content hash of a file is not an answer of that kind: it is shared only
// inside one evaluation that opens a hash batch (`withHashBatch`: lib/changed-coverage.ts hashes a
// file once for the checks of that evaluation), keyed by the file's stat, and dropped when the
// evaluation ends. No cache outlives it.

import { resolveGitBinary } from './git-binary';
import { filterOffArgs, HOOK_GIT_ARGS, HOOK_GIT_ENV, NO_GRAFTS } from './hook-git';

export interface GitResult {
  /** The exit code; -1 when git did not run, was cut off or was killed. */
  code: number;
  out: string;
  raw: Buffer;
  /** Cut off at its time limit, or killed (a time limit, `maxBuffer`): the answer is unknown. */
  stalled: boolean;
  /** False when git was not started (no such directory, no git, no time left, filters unknown). */
  ran: boolean;
}

export interface GitOptions {
  /** stdin; none by default. */
  input?: string | Buffer;
  /** A limit for this call, ms (5 000 by default). */
  timeoutMs?: number;
  /** The time left of a shared deadline, ms: the call gets at most this, and none when it is 0. */
  left?: () => number;
  /** Environment the caller adds: only OPERATIONAL_ENV names pass, never over the safety ones. */
  env?: Record<string, string>;
  maxBuffer?: number;
  /** `--no-optional-locks`: a `status` refresh must not hold the user's index.lock. */
  noOptionalLocks?: boolean;
  /** The caller's command is the user's own, read as git will run it for the user: replace refs
   *  apply (lib/commit-issue.ts). Everything else stays. */
  honorReplace?: boolean;
  /** Never answer from the snapshot (the hand-off checks of lib/push-test.ts read HEAD and the
   *  work tree as they are at that moment). */
  noMemo?: boolean;
  /** The caller needs the repo's clean filters (the work-tree hash of lib/push-test.ts must be
   *  the tree a commit stores). */
  keepFilters?: boolean;
}

/** Environment a caller may set for git: where the index and the objects are, and which user
 *  config counts. Nothing else passes (the safety names are never the caller's). The callers:
 *  GIT_INDEX_FILE, and for a hand-off check's scratch object directory GIT_OBJECT_DIRECTORY and
 *  GIT_ALTERNATE_OBJECT_DIRECTORIES (lib/push-test.ts workTreeState); GIT_CONFIG_GLOBAL and
 *  GIT_CONFIG_NOSYSTEM (lib/probes.ts, lib/smoke.ts). */
const OPERATIONAL_ENV: ReadonlySet<string> = new Set(['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);

const DEFAULT_TIMEOUT_MS = 5_000;
const NOT_RUN: GitResult = { code: -1, out: '', raw: Buffer.alloc(0), stalled: false, ran: false };

// ── Arguments ───────────────────────────────────────────────────────────────────────────────

/** Global options that take the next word as their value. */
const VALUE_GLOBALS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);

/** Where the subcommand is: after the caller's global options (`-c k=v`, `-C dir`, flags). */
function subcommandIndex(args: readonly string[]): number {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (VALUE_GLOBALS.has(a)) i += 2;
    else if (a.startsWith('-')) i++;
    else return i;
  }
  return args.length;
}

/** Subcommands that can run a clean filter or `process` filter of the repo's config. */
const FILTER_COMMANDS = new Set(['status', 'diff', 'diff-files', 'diff-index', 'add', 'hash-object', 'update-index', 'stash', 'commit', 'checkout', 'restore', 'reset', 'blame', 'merge', 'rebase', 'cherry-pick', 'am']);

/** The flags that keep the repo's external diff program and textconv drivers from running, by
 *  subcommand (`blame` and `grep` take only `--no-textconv`). */
const NO_DIFF_PROGRAMS = new Map<string, readonly string[]>([
  ...['diff', 'diff-files', 'diff-index', 'diff-tree', 'show', 'log'].map((c): [string, string[]] => [c, ['--no-ext-diff', '--no-textconv']]),
  ...['blame', 'grep'].map((c): [string, string[]] => [c, ['--no-textconv']]),
]);

const FILTER_LIST = ['config', '--name-only', '--get-regexp', '^filter\\.'];

// ── The memo ────────────────────────────────────────────────────────────────────────────────

interface Snapshot {
  results: Map<string, GitResult>;
  /** Answers of callers' own evaluations that read the work tree or the index (`snapshotMemo`). */
  values: Map<string, unknown>;
}
let snapshot: Snapshot | null = null;

/** Starts a snapshot (a Stop): from here on the immutable answers are kept. Replaces any before. */
export function beginGitSnapshot(): void {
  snapshot = { results: new Map(), values: new Map() };
}

/** `compute()` once per snapshot for `key`; every time outside one. For an evaluation of a caller
 *  that the Stop asks for the same file again and again (the work tree and the index do not change
 *  while a hook runs), unlike the git answers kept by `spawnGit`. */
export function snapshotMemo<T>(key: string, compute: () => T): T {
  if (snapshot === null) return compute();
  if (snapshot.values.has(key)) return snapshot.values.get(key) as T;
  const value = compute();
  snapshot.values.set(key, value);
  return value;
}

export function endGitSnapshot(): void {
  snapshot = null;
}

/** `fn` inside a snapshot; one already open (an outer caller's) is kept. */
export function withGitSnapshot<T>(fn: () => T): T {
  if (snapshot !== null) return fn();
  beginGitSnapshot();
  try {
    return fn();
  } finally {
    endGitSnapshot();
  }
}

type HashBatch = Map<string, { stat: string; id: string }>;
let hashBatch: HashBatch | null = null;

/** `fn` with a hash batch open: the content hashes of work-tree files taken inside it are shared
 *  by everything that asks inside it (one evaluation), each valid while the file's stat is the
 *  same, and gone when `fn` returns. A batch already open (an outer evaluation's) is kept. */
export function withHashBatch<T>(fn: () => T): T {
  if (hashBatch !== null) return fn();
  hashBatch = new Map();
  try {
    return fn();
  } finally {
    hashBatch = null;
  }
}

/** The open batch's hashes (`<top>\0<path>` to the stat and the id), or null outside a batch. */
export function currentHashBatch(): HashBatch | null {
  return hashBatch;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const text = (input: string | Buffer): string => (typeof input === 'string' ? input : input.toString('latin1'));
/** An object named by its full id: the object, `<id>:<path>`, `<id>^{commit}`, `<id>^{tree}`. */
const OBJECT_SPEC = /^[0-9a-f]{40}(?:[0-9a-f]{24})?(?::[^]*|\^\{(?:commit|tree)\})?$/;
const SYMBOLIC_HEAD = /^HEAD(?:\^\{(?:commit|tree)\})?$/;
const LS_TREE_FLAGS = new Set(['-z', '-r', '-t', '-l', '--long', '--name-only', '--name-status', '--full-name', '--full-tree', '--end-of-options']);
const CAT_FILE_FLAGS = new Set(['-s', '-t', '-e', '-p', 'blob', 'tree', 'commit', '--end-of-options']);
const REV_PARSE_FLAGS = new Set(['--verify', '-q', '--quiet', '--end-of-options']);

/** The exit codes of a call whose answer may be kept (a result with another code is never kept),
 *  or null when the call is not one of the kept kinds. `args` start at the subcommand. */
function memoCodes(args: readonly string[], input: string | Buffer | undefined): readonly number[] | null {
  const [sub, ...rest] = args;
  if (sub === 'ls-tree') {
    let i = 0;
    while (i < rest.length && LS_TREE_FLAGS.has(rest[i]!)) i++;
    return OBJECT_ID.test(rest[i] ?? '') ? [0] : null; // a tree by full id: immutable
  }
  if (sub === 'cat-file') {
    if (rest.length > 0 && rest.every((a) => a === '--batch' || a === '--batch-check')) {
      const lines = input === undefined ? [] : text(input).split('\n').filter((l) => l !== '');
      return lines.length > 0 && lines.every((l) => OBJECT_SPEC.test(l)) ? [0] : null;
    }
    const operands = rest.filter((a) => !CAT_FILE_FLAGS.has(a));
    return input === undefined && operands.length === 1 && OBJECT_SPEC.test(operands[0]!) ? [0] : null;
  }
  if (sub === 'rev-parse') {
    if (rest.length === 1 && rest[0] === '--show-cdup') return [0]; // topology: the repo top
    const operands = rest.filter((a) => !REV_PARSE_FLAGS.has(a));
    if (input !== undefined || operands.length === 0) return null;
    // A full id is immutable; HEAD is resolved once per snapshot (it is not immutable, but a
    //   Stop reads one HEAD).
    return operands.every((a) => OBJECT_SPEC.test(a) || SYMBOLIC_HEAD.test(a)) ? [0] : null;
  }
  // The repo's filter list: no match is an answer (exit 1), an error (128) is not.
  if (args.length === FILTER_LIST.length && FILTER_LIST.every((a, i) => args[i] === a)) return [0, 1];
  return null;
}

// ── The call ────────────────────────────────────────────────────────────────────────────────

/** The caller's global options that change which filters git sees: the repo it names (`-C`,
 *  `--git-dir`, `--work-tree`) and config that defines or includes one (`-c filter.*`, `-c include.*`,
 *  `--config-env`). The others (`-c core.quotePath=false`) leave the list as it is, so the Stop's
 *  one memoized listing still serves a caller that passes them. */
function filterGlobals(globals: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < globals.length; i++) {
    const a = globals[i]!;
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--config-env') out.push(a, globals[++i] ?? '');
    else if (a === '-c') {
      const setting = globals[++i] ?? '';
      if (/^(?:filter|include|includeif)\./i.test(setting)) out.push(a, setting);
    } else if (/^--(?:git-dir|work-tree|config-env)=/.test(a)) out.push(a);
  }
  return out;
}

/** The `-c` arguments that empty the filter drivers git would run for `cwd`'s repo, or null when
 *  the list cannot be read (anything but a match or no match). `globals` are the caller's own
 *  options before the subcommand: the list is read as the command will see the repo and its
 *  config, so a `-c filter.X.clean=…` of the caller is listed (and emptied) too. */
function filtersOff(cwd: string, globals: readonly string[], opts: GitOptions): string[] | null {
  const r = spawnGit(cwd, [...filterGlobals(globals), ...FILTER_LIST], { timeoutMs: opts.timeoutMs, left: opts.left, ...(opts.env ? { env: opts.env } : {}), keepFilters: true });
  if (r.stalled || (r.code !== 0 && r.code !== 1)) return null;
  return r.code === 0 ? filterOffArgs(r.out) : [];
}

/** Runs git with the protections above; never throws. Exit code -1: git did not run or was cut
 *  off (see `ran`, `stalled`); 128: not a repo, or a bad object. */
export function spawnGit(cwd: string, args: readonly string[], opts: GitOptions = {}): GitResult {
  let limit = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (opts.left) {
    const left = opts.left();
    if (!(left > 0)) return { ...NOT_RUN, stalled: true };
    limit = Math.min(limit, Math.max(1, Math.ceil(left)));
  }
  const at = subcommandIndex(args);
  const sub = args[at];
  let filters: string[] = [];
  if (sub !== undefined && FILTER_COMMANDS.has(sub) && !opts.keepFilters) {
    const f = filtersOff(cwd, args.slice(0, at), opts);
    if (f === null) return NOT_RUN; // the drivers are unknown: no command that could run one
    filters = f;
  }
  const safety = [...(opts.honorReplace ? [] : ['--no-replace-objects']), ...(opts.noOptionalLocks ? ['--no-optional-locks'] : []), ...HOOK_GIT_ARGS, ...filters];
  const flags = sub === undefined ? undefined : NO_DIFF_PROGRAMS.get(sub);
  // Right after the subcommand: `git grep <rev> --opt` reads the option as a revision.
  const given = flags === undefined ? args : [...args.slice(0, at + 1), ...flags, ...args.slice(at + 1)];
  const full = [...given.slice(0, at), ...safety, ...given.slice(at)];
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [k, v] of Object.entries(opts.env ?? {})) if (OPERATIONAL_ENV.has(k)) env[k] = v;
  Object.assign(env, HOOK_GIT_ENV, NO_GRAFTS);

  const bin = resolveGitBinary(env, cwd);
  const overridden = Object.keys(opts.env ?? {}).length > 0 || opts.maxBuffer !== undefined || opts.honorReplace === true || opts.noMemo === true;
  // The kind is the subcommand's; the caller's global options (`-c core.quotePath=false`, `-C`) are
  //   part of the key below, so the same question asked with other options is another entry.
  const kept = snapshot !== null && !overridden ? memoCodes(args.slice(at), opts.input) : null;
  let key = '';
  if (kept !== null) {
    key = JSON.stringify([bin, cwd, full, opts.input === undefined ? null : text(opts.input), Object.keys(env).sort().map((k) => `${k}=${env[k]}`)]);
    const known = snapshot!.results.get(key);
    if (known) return known;
  }
  try {
    const r = Bun.spawnSync([bin, ...full], {
      cwd,
      env,
      stdin: opts.input === undefined ? 'ignore' : Buffer.from(opts.input),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: limit,
      ...(opts.maxBuffer === undefined ? {} : { maxBuffer: opts.maxBuffer }),
    });
    const stalled = r.exitedDueToTimeout === true || (r.signalCode ?? null) !== null;
    const result: GitResult = { code: r.exitCode ?? -1, out: r.stdout.toString(), raw: r.stdout, stalled, ran: true };
    if (kept !== null && !stalled && kept.includes(result.code)) snapshot?.results.set(key, result);
    return result;
  } catch {
    return NOT_RUN;
  }
}

/** The output of a call that exited 0, else null. */
export function gitOut(cwd: string, args: readonly string[], opts: GitOptions = {}): string | null {
  const r = spawnGit(cwd, args, opts);
  return r.code === 0 ? r.out : null;
}
