// The PreToolUse side of the commit and push scan (track M, M6f; lib/commit-scan.ts is the scanner): reads the
// `git commit` and `git push` a shell command runs (lib/commit-issue.ts `gitCallsOf` finds them through aliases,
// `-C`, shells, heredocs and `rtk`), turns each into what it would publish, and scans that, only for a call that runs
// in a real-data project. A command that is no commit and no push, a project that holds no real data, and a registry
// with no project cost a file check or two and no git call.
//
// What a call is read as:
//   - A commit: `-a`/`--all`, paths (`--only`, `-o`, `-i`/`--include`), `--amend`, `-m`/`--message`/`--trailer`, `-F`,
//     a heredoc message. `--dry-run` publishes nothing. What cannot be told exactly is "not scanned" (it blocks): an
//     interactive commit (`-p`, `--interactive`), a pathspec file, a message from stdin that is no heredoc, git config
//     or repository from the environment, and a command that runs something before the commit that can change what it
//     reads (`git add … && git commit`: the check runs before the command, so it would read the index as it was; run
//     the add as its own command first). For a commit that reads the work tree (`-a`, paths, a `-F` file) a segment that
//     writes a file (an output redirect, `tee`, `sort -o`) and a program that is not read-only count too. A message
//     from stdin is a heredoc only when it is the stdin of the commit itself, and `-F <(…)` is never read. Options are
//     read by their full names only (git also takes any unambiguous abbreviation and
//     `--no-<option>`): another long option, and a negation of an option that changes what is read, is "not scanned".
//   - A push: the remote, the refspecs (`src:dst`, `tag <name>`, `+src`), `--all`, `--mirror`, `--branches`, `--tags`,
//     `--follow-tags`, the current branch by default and every branch when git config decides (the same test as the push
//     test check). `--dry-run` and deletions send nothing. A command that runs a git command that changes commits or refs,
//     or another program, before the push is "not scanned" the same way as for a commit, as in the push test check.
//   - A `git update-ref` or `git symbolic-ref` that names a ref under `refs/remotes/`: "not scanned", because the push scan
//     takes the remote-tracking refs as what the remote already has.
// A command the reader cannot follow (a program or subcommand built at run time, a shell reading a script from a pipe,
// `eval` of built text, a config write or an exported git variable before a call), or a git command whose repository
// cannot be told, is "not scanned" when the command runs in a real-data project. What a script file, `make` or another
// tool runs is not read (stated in the README).

import { basename, resolve } from 'node:path';
import { COMMIT_ATTACHED_ONLY, COMMIT_VALUE_OPTS, gitCallsOf, heredocMessages, type GitCall, type GitMover } from './commit-issue';
import { Acc, type CommitInput, type PushInput, type ScanLimits, type ScanReport, realDataRootOf, registryHoldsProjects, scanCommit, scanPush, unclear } from './commit-scan';
import { spawnGit } from './git-run';
import { gitSubcommandAt, mentionsGit } from './outward-command';
import { changesCommits, PUSH_VALUE_OPTS, pushConfigSendsMore } from './push-test';

/** git commands that change the index or the work tree and that `changesCommits` counts as reads. */
const INDEX_GIT: ReadonlySet<string> = new Set([
  'add', 'rm', 'mv', 'restore', 'apply', 'update-index', 'read-tree', 'checkout-index',
  'stash', 'checkout', 'switch', 'reset', 'merge', 'pull', 'cherry-pick', 'revert', 'rebase', 'am', 'clean',
]);
/** Programs that leave the index, the work tree, commits and refs as they are. */
const SAFE_PROGS: ReadonlySet<string> = new Set([
  'echo', 'printf', 'true', 'false', ':', 'test', '[', '[[', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'which', 'type', 'command', 'date', 'sleep',
  'cd', 'pushd', 'popd', 'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'unset', 'wait', 'read', 'exit', 'return', 'shift', 'for', 'select', 'case', 'done', 'fi', 'esac',
  'break', 'continue', 'sort', 'uniq', 'cut', 'tr', 'diff', 'stat', 'file', 'jq', 'basename', 'dirname', 'realpath', 'readlink',
]);

const SHELLS = /^(?:ba|z|da|k|c|tc|fi)?sh$/;
const nameOf = (prog: string): string => (/^[\w.+-]+$/.test(prog) ? prog : 'a command');

/** What an earlier segment of the command is called when it can change what the call reads or sends; null when it
 *  cannot. `worktree`: the call reads the work tree (a program may change it). `push`: any program may commit. */
function moverName(m: GitMover, worktree: boolean, push: boolean): string | null {
  if (m.call) return null;
  const words = m.words;
  const prog = basename(words[0] ?? '');
  // A redirect into a file writes it (`echo x >> tracked.md`, `echo m > msg.txt`), whatever program it is on; so does `sort -o`
  // (also `--output FILE` and getopt's abbreviations of it: `--out=FILE`).
  const sortWrites = prog === 'sort' && words.some((w) => /^-[a-zA-Z]*o/.test(w) || (w.startsWith('--o') && 'output'.startsWith(w.slice(2).split('=')[0]!)));
  // `uniq IN OUT` writes OUT
  const uniqWrites = prog === 'uniq' && words.slice(1).filter((w) => !w.startsWith('-')).length >= 2;
  if (!push && worktree && (m.writes || sortWrites || uniqWrites)) return words.length > 0 ? `${nameOf(prog)} with an output redirect` : 'a redirect';
  // `rg --pre CMD` and `--hostname-bin CMD` run a program: no read-only program
  if (prog === 'rg' && words.some((w) => /^--(?:pre|hostname-bin)(?:=|$)/.test(w))) return push || worktree ? 'rg' : null;
  if (prog === 'git') {
    const at = gitSubcommandAt(words, 1);
    const sub = words[at];
    if (sub === undefined) return null;
    const args = words.slice(at + 1);
    // `git stash list` and `show` only read
    const reads = sub === 'stash' && ['list', 'show'].includes(args[0] ?? '');
    const changes = push ? changesCommits(sub, args) : (INDEX_GIT.has(sub) && !reads) || changesCommits(sub, args);
    return changes ? (/^[\w.-]+$/.test(sub) ? `git ${sub}` : 'git') : null;
  }
  if (SAFE_PROGS.has(prog)) return null;
  // programs that run a command from their arguments: that command is a segment of its own
  if (prog === 'eval' || prog === 'xargs' || (SHELLS.test(prog) && words.some((w, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)))) return null;
  return push || worktree ? nameOf(prog) : null;
}

const moverText = (name: string, what: string): string => `it runs \`${name}\` before the ${what}, which can change what the ${what} reads, and goodboy checks the command before it runs (run that part as its own command first)`;

/** The long options git 2.39 lists for `git commit` (`--git-completion-helper-all`), by full name. */
const COMMIT_LONG: ReadonlySet<string> = new Set(
  ('quiet verbose file author date message reedit-message reuse-message fixup squash reset-author trailer signoff template edit cleanup status gpg-sign all include interactive patch only no-verify verify dry-run short branch ahead-behind porcelain long null amend no-post-rewrite post-rewrite untracked-files pathspec-from-file pathspec-file-nul allow-empty allow-empty-message').split(' '),
);
/** Options of `git commit` whose negation (`--no-<name>`) changes what is read. */
const COMMIT_NEGATION_CHANGES: ReadonlySet<string> = new Set('all include only interactive patch amend dry-run message file trailer pathspec-from-file reuse-message reedit-message fixup squash'.split(' '));
/** The same for `git push` (git 2.39's list, and `--branches` of 2.46). */
const PUSH_LONG: ReadonlySet<string> = new Set(
  ('verbose quiet repo all branches mirror delete tags dry-run porcelain force force-with-lease force-if-includes recurse-submodules thin receive-pack exec set-upstream progress prune no-verify verify follow-tags signed atomic push-option ipv4 ipv6').split(' '),
);
const PUSH_NEGATION_CHANGES: ReadonlySet<string> = new Set('repo all branches mirror delete tags dry-run follow-tags'.split(' '));

const UNKNOWN_OPTION = 'it has a long option goodboy does not know by its full name (git also takes abbreviations of long options; spell the option out)';
const NEGATED_OPTION = 'it negates an option that changes what it reads or sends (`--no-<option>`), which goodboy does not follow';

/** How goodboy reads a long option (`name` without the dashes): a known full name or a harmless negation, a negation of an
 *  option that changes what is read, or one it does not know (git takes any unambiguous prefix of a name). */
function longOption(name: string, known: ReadonlySet<string>, negation: ReadonlySet<string>): 'known' | 'negated' | 'unknown' {
  if (known.has(name)) return 'known';
  if (name.startsWith('no-') && known.has(name.slice(3))) return negation.has(name.slice(3)) ? 'negated' : 'known';
  return 'unknown';
}

const NOT_A_HEREDOC = 'the message comes from a file or a stream goodboy does not read (it is read from stdin, which is not exactly one heredoc of this commit)';
const IDENTITY_UNSEEN = 'its author or committer comes from the environment or a setting whose value goodboy cannot see (GIT_AUTHOR_*, GIT_COMMITTER_*, EMAIL, a computed -c user.* or --author)';
const IDENTITY_KEY = /^(?:user|author|committer)\.(?:name|email)$/i;

/** The heredocs of the command (`heredocMessages`) and which of the commits that read their message from stdin this is (the
 *  nth of them, in order, takes the nth feeder: a second commit never reuses another's heredoc). */
interface MessageTie {
  cats: string[];
  feeders: string[];
  ordinal: number;
}

/** A `git commit` call as what it commits; `skip` when it publishes nothing (`--dry-run`); `stdin` when its message comes from
 *  stdin (`-F -`, a bare `$(cat)`). Without `tie` the heredocs are not read (a first pass, to number the stdin commits). */
function commitInputOf(call: GitCall, command: string, tie?: MessageTie): { input: CommitInput; skip: boolean; stdin: boolean } {
  const input: CommitInput = { dir: call.dir, globals: call.globals, mode: 'index', paths: [], amend: false, messages: [], files: [], unclear: [], identity: [] };
  const identity: string[] = [...call.identity];
  let identityUnseen = call.identityComputed;
  let all = false;
  let include = false;
  let patch = false;
  let dry = false;
  // An option goodboy does not read by its full name may undo `--dry-run` (`--no-dry-run`, an abbreviation of it).
  let odd = false;
  let stdin = false;
  // the message file is a process substitution or a descriptor: a pipe goodboy cannot see
  let pipe = false;
  const paths: string[] = [];
  const messages: string[] = [];
  const trailers: string[] = [];
  const args = call.args;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (w === '--' || w === '--end-of-options') {
      if (w !== '--') {
        input.unclear.push(UNKNOWN_OPTION);
        odd = true;
      }
      paths.push(...args.slice(i + 1));
      break;
    }
    if (!w.startsWith('-') || w === '-') {
      paths.push(w);
      continue;
    }
    let name = w;
    let value: string | undefined;
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      if (eq > 0) {
        name = w.slice(0, eq);
        value = w.slice(eq + 1);
      } else if (COMMIT_VALUE_OPTS.has(w)) value = args[++i];
      const kind = longOption(name.slice(2), COMMIT_LONG, COMMIT_NEGATION_CHANGES);
      if (kind !== 'known') {
        input.unclear.push(kind === 'unknown' ? UNKNOWN_OPTION : NEGATED_OPTION);
        odd = true;
      }
    } else {
      for (let k = 1; k < w.length; k++) {
        const c = w[k]!;
        if (COMMIT_ATTACHED_ONLY.has(c)) break;
        if (c === 'a') all = true;
        else if (c === 'i') include = true;
        else if (c === 'p') patch = true;
        if (!COMMIT_VALUE_OPTS.has(`-${c}`)) continue;
        name = `-${c}`;
        value = k < w.length - 1 ? w.slice(k + 1) : args[++i];
        break;
      }
    }
    if (name === '--all') all = true;
    else if (name === '--include') include = true;
    else if (name === '--interactive' || name === '--patch') patch = true;
    else if (name === '--amend') input.amend = true;
    else if (name === '--dry-run') dry = true;
    else if (name === '--pathspec-from-file') input.unclear.push('this commit takes its paths from a file (--pathspec-from-file)');
    if (value === undefined && COMMIT_VALUE_OPTS.has(name)) {
      // the reader drops a process substitution (`-F <(echo …)`), so the option reads as having no value
      if (name === '-F' || name === '--file') pipe = true;
      else input.unclear.push('an option of this commit takes a value goodboy cannot read (a process substitution?)');
      continue;
    }
    if (value === undefined) continue;
    if (name === '--author') {
      identity.push(value);
      if (/[$`]/.test(value)) identityUnseen = true;
    }
    if (name === '-m' || name === '--message') messages.push(value);
    else if (name === '--trailer') trailers.push(value);
    else if (name === '-F' || name === '--file') {
      if (value === '-' || value === '/dev/stdin' || value === '/dev/fd/0' || value === '/proc/self/fd/0') stdin = true;
      else if (value === '' || /^\/dev\/fd\//.test(value) || /^\/proc\/(?:self|\d+)\/fd\//.test(value)) pipe = true;
      else input.files.push(resolve(call.dir, value));
    }
  }
  const text = [...messages, ...trailers];
  const computed = (m: string): boolean => /\$\(|`/.test(m);
  // A message word that holds only `$(cat <<TAG … TAG)` is that heredoc's body: the reader leaves `$(cat  \n)` (the operator and the
  // body are gone, the line break stays), so the word carries its own heredoc. A bare `$(cat)` reads the commit's own stdin, as
  // `-F -` does; `$(cat FILE)`, `$(cat < FILE)` and any other substitution read the message when the command runs.
  const heredocCat = (m: string): boolean => /^\s*\$\(\s*cat[ \t]*\n\s*\)\s*$/.test(m);
  const bareCat = (m: string): boolean => /^\s*(?:\$\([ \t]*cat[ \t]*\)|`[ \t]*cat[ \t]*`)\s*$/.test(m);
  const readsStdin = stdin || text.some(bareCat);
  // stdin is a heredoc only when it is exactly one heredoc of this commit (or of a plain `cat` piped into it); the nth commit
  // that reads stdin takes the nth such heredoc
  const feeder = tie === undefined ? undefined : tie.feeders[tie.ordinal];
  if (readsStdin && tie !== undefined && feeder === undefined) input.unclear.push(NOT_A_HEREDOC);
  // a process substitution or a descriptor other than stdin: a pipe goodboy cannot see, whatever heredocs the command has
  if (pipe) input.unclear.push('the message file is a pipe or a process substitution, which goodboy cannot see');
  const catWords = text.filter(heredocCat).length;
  if (text.some((m) => computed(m) && !heredocCat(m) && !bareCat(m)) || (tie !== undefined && catWords > tie.cats.length)) input.unclear.push('the message is computed by a command, which is known only when it runs');
  if (text.some((m) => !computed(m) && /\$[A-Za-z_{]/.test(m))) input.unclear.push('the message is built from a shell variable, which is known only when it runs');
  input.messages = [...text.filter((m) => !heredocCat(m) && !bareCat(m)), ...(catWords > 0 && tie !== undefined ? tie.cats : []), ...(readsStdin && feeder !== undefined ? [feeder] : [])];
  // who the commit is by: the settings and the environment the command gives are text to scan; one it does not show is not read
  for (let k = 0; k + 1 < call.globals.length; k++) {
    if (call.globals[k] !== '-c') continue;
    const eq = call.globals[k + 1]!.indexOf('=');
    const key = eq < 0 ? call.globals[k + 1]! : call.globals[k + 1]!.slice(0, eq);
    if (!IDENTITY_KEY.test(key)) continue;
    const value = eq < 0 ? '' : call.globals[k + 1]!.slice(eq + 1);
    identity.push(value);
    if (/[$`]/.test(value)) identityUnseen = true;
  }
  input.identity = identity;
  if (identityUnseen) input.unclear.push(IDENTITY_UNSEEN);
  if (patch) input.unclear.push('an interactive commit (-p, --interactive) chooses its content while it runs');
  if (all && paths.length > 0) input.unclear.push('this commit combines -a with paths');
  input.paths = paths;
  input.mode = all ? 'all' : paths.length > 0 ? (include ? 'include' : 'only') : 'index';
  if (call.moved) input.unclear.push('its git config or repository comes from the environment or another file');
  for (let k = 0; k < call.at; k++) {
    // a `-F` file is read from the work tree too: a program before the commit may write it
    const n = moverName(call.movers[k]!, input.mode !== 'index' || input.files.length > 0, false);
    if (n !== null) {
      input.unclear.push(moverText(n, 'commit'));
      break;
    }
  }
  return { input: { ...input, unclear: [...new Set(input.unclear)] }, skip: dry && !odd, stdin: readsStdin };
}

/** The remote `git push` uses when none is named: the push remote, then `remote.pushDefault`, the branch's remote, `origin`. */
function defaultRemote(dir: string): string | null {
  const one = (args: string[]): string | null => {
    const r = spawnGit(dir, args, { timeoutMs: 5_000, noMemo: true });
    return r.code === 0 && r.out.trim() !== '' ? r.out.trim() : null;
  };
  const branch = one(['symbolic-ref', '--short', '-q', 'HEAD']);
  return (
    (branch !== null ? one(['config', '--get', `branch.${branch}.pushRemote`]) : null) ??
    one(['config', '--get', 'remote.pushDefault']) ??
    (branch !== null ? one(['config', '--get', `branch.${branch}.remote`]) : null) ??
    'origin'
  );
}

/** A `git push` call as what it sends; `skip` when it sends nothing (`--dry-run`). */
export function pushInputOf(call: GitCall): { input: PushInput; skip: boolean } {
  const input: PushInput = { dir: call.dir, globals: call.globals, remote: null, revs: [], flags: [], excluding: [], unclear: [] };
  const pos: string[] = [];
  const args = call.args;
  let family = false;
  let repoOpt: string | undefined;
  let dry = false;
  let odd = false;
  let del = false;
  const flag = (f: PushInput['flags'][number]): void => {
    if (!input.flags.includes(f)) input.flags.push(f);
  };
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === '--' || a === '--end-of-options') {
      if (a !== '--') {
        input.unclear.push(UNKNOWN_OPTION);
        odd = true;
      }
      pos.push(...args.slice(j + 1));
      break;
    }
    if (a.startsWith('--')) {
      const kind = longOption(a.slice(2, a.includes('=') ? a.indexOf('=') : undefined), PUSH_LONG, PUSH_NEGATION_CHANGES);
      if (kind !== 'known') {
        input.unclear.push(kind === 'unknown' ? UNKNOWN_OPTION : NEGATED_OPTION);
        odd = true;
      }
    }
    if (a === '--repo') {
      repoOpt = args[++j] ?? '';
      continue;
    }
    if (a.startsWith('--repo=')) {
      repoOpt = a.slice(7);
      continue;
    }
    if (a === '--dry-run') dry = true;
    else if (a === '--delete') del = true;
    else if (a === '--all' || a === '--mirror') {
      flag('--all');
      family = true;
    } else if (a === '--branches') {
      flag('--branches');
      family = true;
    } else if (a === '--tags') {
      flag('--tags');
      family = true;
    } else if (a === '--follow-tags') flag('--tags');
    if (PUSH_VALUE_OPTS.has(a)) {
      j++;
      continue;
    }
    if (/^-o./.test(a)) continue;
    if (/^-[a-zA-Z0-9]+$/.test(a)) {
      if (a.includes('n')) dry = true;
      if (a.includes('d')) del = true;
      continue;
    }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const named = pos[0];
  // `--delete`: every refspec names a ref to remove, and nothing is sent
  const refspecs = del ? [] : pos.slice(1);
  input.remote = named ?? repoOpt ?? defaultRemote(call.dir);
  for (let n = 0; n < refspecs.length; n++) {
    const r = refspecs[n]!;
    if (r === 'tag' && refspecs[n + 1] !== undefined) {
      input.revs.push(`refs/tags/${refspecs[++n]}`);
      continue;
    }
    const spec = r.replace(/^\+/, '');
    const colon = spec.indexOf(':');
    const src = colon < 0 ? spec : spec.slice(0, colon);
    if (src === '') continue;
    // a pattern refspec (`refs/heads/*:refs/heads/*`): every branch and tag
    if (/[*?[]/.test(src)) flag('--all');
    else input.revs.push(src);
  }
  if (refspecs.length === 0 && !family && !del) {
    input.revs.push('HEAD');
    // config decides what a refspec-less push sends: another remote's refspecs, mirror mode, push.default=matching
    if (pushConfigSendsMore(call.dir, named ?? repoOpt)) flag('--branches');
  }
  if (repoOpt !== undefined || call.globals.some((g) => /^(?:remote\.[^.]+\.(?:push|mirror)|remote\.pushdefault|push\.default)/i.test(g))) flag('--branches');
  if (call.moved) input.unclear.push('its git config or repository comes from the environment or another file');
  for (let k = 0; k < call.at; k++) {
    const n = moverName(call.movers[k]!, false, true);
    if (n !== null) {
      input.unclear.push(moverText(n, 'push'));
      break;
    }
  }
  input.unclear = [...new Set(input.unclear)];
  return { input, skip: dry && !odd };
}

export interface GuardResult {
  report: ScanReport;
  /** `git commit`, `git push`, `git commit and git push`, or `git command` (a command goodboy could not read). */
  what: string;
}

/** The most git calls of one command that are scanned (they share one budget). */
const MAX_CALLS = 6;
const REPOINTS_REMOTE = 'it re-points a remote (git remote set-url or rename, a config of a remote url or url.<base>.insteadOf), after which the push scan would take that remote\'s tracking refs as what the new destination has';
const MOVES_TRACKING_REF = 'it moves a remote-tracking ref (git update-ref or git symbolic-ref on refs/remotes/), which the push scan takes as what the remote already has';

/** What a shell command run in `cwd` would publish through `git commit` and `git push` in a real-data project, when
 *  that has a match or cannot be scanned; null when the command publishes nothing there, or when nothing is wrong. */
export function commitScanOfCommand(command: string, cwd: string, projectCwd: string, o: { limits?: ScanLimits; env?: NodeJS.ProcessEnv } = {}): GuardResult | null {
  if (!mentionsGit(command)) return null;
  const env = o.env ?? process.env;
  // Test seam (as GOODBOY_TEST_HOOK_CLOCK_MS in lib/hook-clock.ts): a check that fails, for the hook's own handling of one.
  if (env.GOODBOY_TEST_COMMIT_SCAN_FAIL === '1') throw new Error('commit scan test failure');
  // The shell is in a real-data project, or the registry names some (a `git -C <dir>` or a nested repo may reach one).
  const here = realDataRootOf(cwd, env) !== null || realDataRootOf(projectCwd, env) !== null;
  if (!here && !registryHoldsProjects(env)) return null;
  const { calls, unreadable, notes } = gitCallsOf(command, cwd);
  const lost = unreadable.length > 0 && here;
  if (calls.length === 0 && !lost) return null;
  // The reasons that name the command as a whole are bound to its text: the user's approval of one command is no approval
  // of another that is "not scanned" for the same reason (`git add ok.txt && git commit` and `git add -A && git commit`).
  const acc = new Acc(o.limits, command);
  let any = false;
  let commits = false;
  let pushes = false;
  if (lost) {
    unclear(acc, '<command>', 'goodboy cannot read this command well enough to tell what it commits or pushes');
    for (const why of notes) unclear(acc, '<command>', why);
    any = true;
  }
  let scanned = 0;
  // the heredocs once; the commits that read stdin are numbered over all of the command's calls, scanned or not
  const heredocs = heredocMessages(command);
  const ordinals = new Map<GitCall, number>();
  let stdinCommits = 0;
  for (const call of calls) if (call.sub === 'commit' && commitInputOf(call, command).stdin) ordinals.set(call, stdinCommits++);
  try {
    for (const call of calls) {
      if (call.sub === 'unknown') {
        if (here) {
          unclear(acc, '<command>', 'goodboy cannot tell which repository a git command in this command runs in');
          any = true;
        }
        continue;
      }
      if (realDataRootOf(call.dir, env) === null) continue;
      any = true;
      if (call.sub === 'refmove' || call.sub === 'repoint') {
        unclear(acc, '<command>', call.sub === 'refmove' ? MOVES_TRACKING_REF : REPOINTS_REMOTE);
        continue;
      }
      if (++scanned > MAX_CALLS) {
        unclear(acc, '<command>', `this command runs more than ${MAX_CALLS} git commits and pushes`);
        break;
      }
      if (call.sub === 'commit') {
        commits = true;
        const c = commitInputOf(call, command, { ...heredocs, ordinal: ordinals.get(call) ?? -1 });
        if (!c.skip) scanCommit(c.input, acc);
      } else {
        pushes = true;
        const p = pushInputOf(call);
        if (!p.skip) scanPush(p.input, acc);
      }
    }
  } catch {
    // a call in a real-data project that the scan fails on is not clean
    unclear(acc, '<command>', 'the scan failed');
    any = true;
  }
  if (!any) return null;
  const report = acc.report();
  if (!report.blocked) return null;
  return { report, what: commits && pushes ? 'git commit and git push' : pushes ? 'git push' : commits ? 'git commit' : 'git command' };
}
