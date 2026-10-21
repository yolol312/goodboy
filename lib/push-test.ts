// Push test check (track G, plan §10.10): a hand-off — a `git push` (branches and tags), an
// MR/PR creation, a deploy to a host that is not local or sandbox, or the /ship and
// /land-and-deploy skills — needs a passing layer-1 test result for exactly the content being
// handed off.
//
// Evidence: `test-write` records the working tree it tested as a git tree hash (`tree`, see
// workTreeState). A hand-off passes when the commit it sends has that tree. So a commit made
// after the tests still matches, and an edit after the result changes the tree and makes the
// result stale by itself. No re-run happens here; a result that says BLOCKED (tests could not
// run) never passes, and only the user overrides (approval marker or env switch).

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { stripHeredocs } from './bash-write';
import { HOOK_GIT_ARGS, HOOK_GIT_ENV, NO_GRAFTS, splitAliasValue } from './hook-git';
import { agentName, ROUTE } from './routing-policy';
import {
  classifyHost,
  classifyOutward,
  GIT_VALUE_OPTS,
  gitSubcommandAt,
  readCommand,
  shellReadsStdin,
  shellSegments,
  WHOLE_SUBSTITUTION,
  stripPrefix,
  xargsCommandAt,
  type HostRules,
} from './outward-command';
import { failingSuites, missingTestFiles, scanForbiddenPatterns, validateEvidence } from './test-validator';
import type { TestResult } from './types';

export type HandoffKind = 'push' | 'mr' | 'deploy';

export interface Handoff {
  kind: HandoffKind;
  /** Short label for messages, e.g. `git push origin feature`. */
  what: string;
  /** Where to resolve `revs` (a `git -C <dir>` changes it). */
  cwd: string;
  /** Revisions whose content is handed off, e.g. ['HEAD'], ['v1.2.0'], or WORKTREE for a
   *  deploy, which ships the files as they are, not a commit. */
  revs: string[];
  /** Set when goodboy cannot tell what is handed off (a push of every branch or tag). */
  unclear?: string;
  /** (#15) The command that may change commits before the push in the same command (`git
   *  commit`, `npm version`): the check runs before the command, so it would judge the commits
   *  as they were. */
  runFirst?: string;
}

/** git commands that leave commits, refs and config as they are: anything else before a push
 *  in one command may change what it hands off (#15; an alias or an unknown command counts). */
const READ_ONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'add', 'rm', 'mv', 'restore', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'ls-remote', 'describe', 'grep', 'blame', 'shortlog', 'cat-file', 'show-ref', 'for-each-ref', 'name-rev', 'var', 'version',
  'help', 'count-objects', 'diff-tree', 'diff-index', 'diff-files', 'merge-base', 'check-ignore', 'check-attr', 'whatchanged',
  'push',
]);
/** Programs that leave commits, refs and config as they are (#15, I8 review): any other program
 *  before a push in one command (`npm version patch`, `make release`, a script) may commit. */
const READ_ONLY_PROGS = new Set([
  'echo', 'printf', 'true', 'false', ':', 'test', '[', '[[', 'sleep', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep',
  'which', 'type', 'date', 'set', 'unset', 'wait', 'for', 'select', 'case', 'done', 'fi', 'esac', 'break', 'continue',
  'exit', 'return', 'shift',
]);
/** `git branch`/`git tag` flags that make it only read: a read mode (its operands are patterns
 *  or names to show), or a listing option (I8 review: `tag -a` annotates, `branch -f` moves). */
const REF_READ_MODE: Readonly<Record<string, ReadonlySet<string>>> = {
  branch: new Set(['-l', '--list', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']),
  tag: new Set(['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '-v', '--verify']),
};
const REF_LISTING: Readonly<Record<string, ReadonlySet<string>>> = {
  branch: new Set(['-v', '-vv', '--verbose', '-a', '--all', '-r', '--remotes', '--format', '--sort', '--color', '--no-color', '--column', '--no-column', '-i', '--ignore-case', '--abbrev', '--no-abbrev', '--omit-empty']),
  tag: new Set(['--format', '--sort', '--color', '--no-color', '--column', '--no-column', '-i', '--ignore-case', '--omit-empty']),
};
const CONFIG_READING = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']);

/** The hand-off `h`, judged before a command ahead of it in the same command changes commits (#15). */
function runFirstHandoff(h: Handoff, moved: string): Handoff {
  return { kind: h.kind, what: h.what, cwd: h.cwd, revs: [], unclear: `it runs \`${moved}\` before it`, runFirst: moved };
}

/** Whether `git <sub> <args>` may change commits, refs or config (#15): `branch` and `tag` not
 *  when they only read, `checkout` not when it restores paths (after a `--`), `reset` not
 *  without an operand or with paths, `stash` not unless it makes a branch, `remote` not when it
 *  shows, `config` not when it reads, `fetch` not without a `src:dst` refspec or refmap. */
function changesCommits(sub: string, args: readonly string[]): boolean {
  // A flag that runs a program (closing check: `fetch --upload-pack=…`, `grep -O…`).
  if (args.some((w) => /^(?:--upload-pack|--exec|--open-files-in-pager|-O)/.test(w))) return true;
  if (READ_ONLY_GIT.has(sub)) return false;
  const operands = args.filter((w) => !w.startsWith('-'));
  // Paths after a `--`: a bare one at the end names none (`checkout -B main other --`).
  const dd = args.indexOf('--');
  const paths = dd >= 0 && dd < args.length - 1;
  const mode = REF_READ_MODE[sub];
  if (mode) {
    const flags = args.filter((w) => w.startsWith('-')).map((w) => (w.startsWith('--') ? w.split('=')[0]! : w));
    if (!flags.every((f) => mode.has(f) || REF_LISTING[sub]!.has(f))) return true;
    return operands.length > 0 && !flags.some((f) => mode.has(f));
  }
  if (sub === 'checkout') return !paths;
  if (sub === 'reset') return operands.length > 0 && !paths;
  if (sub === 'stash') return operands[0] === 'branch';
  if (sub === 'remote') return operands.length > 0 && operands[0] !== 'show' && operands[0] !== 'get-url';
  if (sub === 'config') return !args.some((w) => CONFIG_READING.has(w));
  if (sub === 'fetch') return args.some((w) => w.includes(':'));
  return true;
}

/** The working tree itself as a hand-off revision (deploys, publishes). */
export const WORKTREE = ':worktree';

/** A git object id as stored by test-write; anything else is never passed to git. */
export const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Runs git with a time limit: a stalled git (a hung network mount, a slow fsmonitor) fails
 *  the call, so a hand-off check denies instead of being cancelled by the hook timeout. It
 *  starts no program from the repo's config (lib/hook-git.ts), except a clean filter in the
 *  work-tree hash (docs/stabilization-plan.md §10.10). No replace refs or grafts: `git replace
 *  <code tree> <prose tree>` made untested code read as tested or as prose (I6 review). */
function git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 15_000): string | null {
  try {
    const proc = Bun.spawnSync(['git', '--no-replace-objects', ...HOOK_GIT_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...HOOK_GIT_ENV, ...NO_GRAFTS, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim();
  } catch {
    return null;
  }
}

/** The repo's top directory in cwd's own spelling, or null outside a repo. */
export function topOf(cwd: string): string | null {
  const cdup = git(cwd, ['rev-parse', '--show-cdup']);
  return cdup === null ? null : resolvePath(cwd, cdup || '.');
}

/** goodboy's own artifacts never count as content, on either side of the comparison:
 *  `.claude/tests` is written after the tree is taken, and repos that do not ignore `.claude/`
 *  may commit them. Nor do goodboy's project files under `.goodboy/` (policy, doc map, test
 *  catalog, hosts, commit issue rule): no test runs them, and a task often leaves a new one
 *  uncommitted, which made every tested tree differ from the commits handed off (real-use
 *  trial, #13). Only these, and only as regular files: other files there, or a directory named
 *  like one of these, may be code the project loads (I6 review). */
const ARTIFACT_DIRS = ['.claude/tests', '.claude/reviews', '.claude/pending'];
const GOODBOY_FILES = ['.goodboy/policy.md', '.goodboy/docs.json', '.goodboy/test-catalog.md', '.goodboy/hosts', '.goodboy/commit-issue'];

/** A path (repo-relative) that may be goodboy's own and never content. */
function isArtifactPath(p: string): boolean {
  return ARTIFACT_DIRS.some((a) => p === a || p.startsWith(`${a}/`)) || GOODBOY_FILES.includes(p) || p.startsWith('.claude/.goodboy-');
}

/** Drops goodboy's artifacts from the index `env` names: the result dirs and markers, and the
 *  project files under `.goodboy/` that are regular files in it. */
function dropArtifacts(top: string, env: Record<string, string>): void {
  git(top, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...ARTIFACT_DIRS, ':(glob).claude/.goodboy-*'], env);
  const staged = git(top, ['ls-files', '-s', '-z', '--', ...GOODBOY_FILES], env) ?? '';
  const files = staged
    .split('\0')
    .map((l) => (/^100(?:644|755) /.test(l) ? l.slice(l.indexOf('\t') + 1) : ''))
    .filter((p) => GOODBOY_FILES.includes(p));
  if (files.length > 0) git(top, ['rm', '-q', '--cached', '--', ...files], env);
}

/** The working tree as a git tree hash, untracked files included (ignored ones and goodboy
 *  artifacts not), plus HEAD. Taken at the repo top, whatever the cwd. Works on a copy of the
 *  index, so the user's index is untouched; the blobs it writes are mostly the ones the next
 *  commit stores anyway. Nulls outside a git repo. */
export function workTreeState(
  cwd: string,
  opts: { scratchObjects?: boolean; timeoutMs?: number } = {},
): { commit: string | null; tree: string | null } {
  const commit = git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  const top = topOf(cwd);
  const indexPath = top === null ? null : git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  if (top === null || indexPath === null) return { commit, tree: null };
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-tree-'));
  try {
    const tmpIndex = join(dir, 'index');
    if (existsSync(indexPath)) {
      copyFileSync(indexPath, tmpIndex);
      // Keep the index's own mtime: git trusts cached stats of entries older than the index
      //   file ("racy git"), so a newer copy hid a same-size edit made in the same second.
      const st = statSync(indexPath);
      utimesSync(tmpIndex, st.atime, st.mtime);
    }
    const env: Record<string, string> = { GIT_INDEX_FILE: tmpIndex };
    // `scratchObjects` (a hand-off check, which needs only the hash): new blobs go to a temp
    //   object dir that is removed afterwards, so the user's .git/objects does not grow.
    if (opts.scratchObjects) {
      const objects = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
      if (objects !== null) {
        mkdirSync(join(dir, 'objects'), { recursive: true });
        env.GIT_OBJECT_DIRECTORY = join(dir, 'objects');
        env.GIT_ALTERNATE_OBJECT_DIRECTORIES = objects;
      }
    }
    // No exclude pathspecs on the add: with `.claude/` ignored they make `git add` exit 1
    //   ("paths are ignored"), which left the tree null in exactly such repos (layer-1 round).
    //   The artifacts are dropped from the copied index right after instead.
    if (git(top, ['add', '-A', '--', '.'], env, opts.timeoutMs ?? 120_000) === null) return { commit, tree: null };
    dropArtifacts(top, env);
    return { commit, tree: git(top, ['write-tree'], env) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The tree of a revision as it would be handed off, without goodboy artifacts (so it compares
 *  with workTreeState), or null when it does not resolve. */
export function revisionTree(cwd: string, rev: string): string | null {
  // Inside PreToolUse (60 s): a timeout below it, so a huge tree fails closed (unresolved →
  //   denied) instead of the hook being cancelled, which would let the deploy through.
  if (rev === WORKTREE) return workTreeState(cwd, { scratchObjects: true, timeoutMs: 40_000 }).tree;
  // `--end-of-options`: a rev from the command line never reads as an option.
  const tree = git(cwd, ['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{tree}`]);
  if (tree === null) return null;
  const listed = git(cwd, ['ls-tree', '--name-only', '--full-tree', tree, '.claude/', '.goodboy/']);
  const hasArtifacts = (listed ?? '').split('\n').some((p) => p !== '' && isArtifactPath(p));
  if (!hasArtifacts) return tree;
  const top = topOf(cwd);
  if (top === null) return null;
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-tree-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    if (git(top, ['read-tree', tree], env) === null) return null;
    dropArtifacts(top, env);
    return git(top, ['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PUSH_VALUE_OPTS = new Set(['--repo', '--receive-pack', '--exec', '-o', '--push-option']);
/** git commands that are never a push, so their name needs no alias lookup (git never lets an
 *  alias hide a built-in; the commit issue rule uses the list the same way). */
export const GIT_BUILTINS: ReadonlySet<string> = new Set([
  'add', 'am', 'apply', 'bisect', 'blame', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit',
  'config', 'describe', 'diff', 'fetch', 'gc', 'grep', 'init', 'log', 'ls-files', 'ls-remote', 'merge', 'mv',
  'notes', 'pull', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'revert', 'rev-parse', 'rm', 'show',
  'stash', 'status', 'submodule', 'switch', 'tag', 'worktree', 'help', 'version',
  // plumbing and other built-ins seen in agent commands (final G1 review: fewer alias lookups)
  'annotate', 'archive', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'checkout-index', 'cherry',
  'commit-tree', 'count-objects', 'diff-files', 'diff-index', 'diff-tree', 'for-each-ref', 'format-patch',
  'fsck', 'hash-object', 'interpret-trailers', 'ls-tree', 'maintenance', 'merge-base', 'name-rev', 'prune',
  'range-diff', 'read-tree', 'repack', 'rerere', 'rev-list', 'shortlog', 'show-branch', 'show-ref',
  'sparse-checkout', 'symbolic-ref', 'update-index', 'update-ref', 'var', 'verify-commit', 'verify-tag',
  'whatchanged', 'write-tree',
]);
/** Kinds of outward targets that deploy or publish (lib/outward-command.ts). */
const DEPLOY_KIND = /^(kubectl|oc|helm|terraform|pulumi|aws|aws s3|gcloud|az|rsync|scp|sftp|gh release|glab release|(docker|podman) push|(npm|pnpm|yarn|bun|cargo|gem|twine|poetry|uv) \S+)$/;

/** What `git <sub>` runs when `sub` is an alias: from `-c alias.<sub>=…` on the command line,
 *  else from the repo's config. Words of the expansion (a `!shell` alias returns its shell text
 *  as one word, prefixed with `!`), or null when it is not an alias. */
function aliasOf(sub: string, inline: Map<string, string>, cwd: string): string[] | null {
  const value = inline.get(sub.toLowerCase()) ?? git(cwd, ['config', '--get', `alias.${sub}`]);
  if (value === null || value === undefined || value.trim() === '') return null;
  const v = value.trim();
  return v.startsWith('!') ? [v] : splitAliasValue(v);
}

/** True when the repo's config makes a refspec-less push send more than the current branch.
 *  With no remote named, the one git uses: branch.<b>.pushRemote, remote.pushDefault,
 *  branch.<b>.remote, then origin (layer-1 round). */
function pushConfigSendsMore(cwd: string, named: string | undefined): boolean {
  let remote = named;
  if (remote === undefined) {
    const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    remote =
      (branch ? git(cwd, ['config', '--get', `branch.${branch}.pushRemote`]) : null) ??
      git(cwd, ['config', '--get', 'remote.pushDefault']) ??
      (branch ? git(cwd, ['config', '--get', `branch.${branch}.remote`]) : null) ??
      'origin';
  }
  if (/^[\w.-]+$/.test(remote)) {
    if (git(cwd, ['config', '--get-all', `remote.${remote}.push`])) return true;
    if (git(cwd, ['config', '--get', `remote.${remote}.mirror`]) === 'true') return true;
  }
  return git(cwd, ['config', '--get', 'push.default']) === 'matching';
}

/** Per-command limits: alias lookups each spawn git (about 25 ms), so a command of thousands
 *  of `git zzN;` segments must not run PreToolUse past its timeout (security review). */
interface ReadBudget {
  aliasLookups: number;
}
const MAX_ALIAS_LOOKUPS = 8;
/** Inline config that decides what a plain `git push` sends. */
const PUSH_CONFIG = /^(?:remote\.[^.]+\.(?:push|mirror)|remote\.pushdefault|branch\.[^.]+\.pushremote|push\.default|include(?:if)?\.)/i;

/** `envConfig`: the segment runs with env that moves git's config or repository (GIT_ENV). */
function gitHandoff(words: string[], cwd: string, depth: number, budget: ReadBudget, envConfig = false): Handoff[] {
  let dir = cwd;
  const inline = new Map<string, string>();
  let configDecides = false;
  // Config or repository from elsewhere: env, `--git-dir`/`--work-tree` or `--config-env`
  //   before the subcommand (after it, `rev-parse --git-dir` is a query), `-c include.*`.
  let elsewhere = envConfig;
  let i = 1;
  while (i < words.length && words[i]!.startsWith('-')) {
    const w = words[i]!;
    if (w === '-C' && words[i + 1] !== undefined) dir = resolvePath(dir, words[i + 1]!);
    if (w === '-c' && words[i + 1] !== undefined) {
      // Config keys ignore case (`alias.P` is `alias.p`).
      const m = words[i + 1]!.match(/^alias\.([^=]+)=(.*)$/i);
      if (m) inline.set(m[1]!.toLowerCase(), m[2]!);
      if (PUSH_CONFIG.test(words[i + 1]!)) configDecides = true;
      if (/^include(?:if)?\./i.test(words[i + 1]!)) elsewhere = true;
    }
    if (/^--(?:config-env|git-dir|work-tree)(?:=|$)/.test(w)) elsewhere = true;
    i += GIT_VALUE_OPTS.has(w) ? 2 : 1;
  }
  const sub = words[i];
  if (sub === undefined) return [];
  const fromElsewhere = (what: string): Handoff[] => [
    { kind: 'push', what, cwd: dir, revs: [], unclear: 'its git config or repository comes from the environment or another file' },
  ];
  // The plumbing that pushes (final G1 test round): its refs are not read here.
  if (sub === 'send-pack' || sub === 'http-push') {
    return [{ kind: 'push', what: `git ${sub}`, cwd: dir, revs: [], unclear: `\`git ${sub}\` pushes refs goodboy does not read; use git push` }];
  }
  if (sub !== 'push') {
    // git never lets an alias hide a built-in command, so only another word may push.
    if (GIT_BUILTINS.has(sub) || depth > 2) return [];
    if (elsewhere) return fromElsewhere(`git ${sub}`);
    if (++budget.aliasLookups > MAX_ALIAS_LOOKUPS) {
      return [{ kind: 'push', what: `git ${sub}`, cwd: dir, revs: [], unclear: 'it runs too many unknown git commands to check' }];
    }
    const expansion = aliasOf(sub, inline, dir);
    if (expansion === null) return [];
    if (expansion[0]!.startsWith('!')) return handoffsOfAt(expansion[0]!.slice(1), dir, depth + 1, undefined, budget);
    return gitHandoff(['git', ...expansion, ...words.slice(i + 1)], dir, depth + 1, budget);
  }
  const args = words.slice(i + 1);
  const pos: string[] = [];
  let all = false;
  // `--repo <remote>` names the remote whose push refspecs git uses; the config lookup below
  //   reads the default remote's, so with it git config decides (Codex review: an untested
  //   branch in remote.<name>.push went through).
  let repoOpt = false;
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === '--') {
      pos.push(...args.slice(j + 1));
      break;
    }
    if (a === '--repo' || a.startsWith('--repo=')) repoOpt = true;
    if (a === '--dry-run' || a === '--delete') return [];
    // --follow-tags also sends annotated tags reachable from the pushed commits.
    if (a === '--all' || a === '--mirror' || a === '--tags' || a === '--branches' || a === '--follow-tags') all = true;
    if (PUSH_VALUE_OPTS.has(a)) {
      j++;
      continue;
    }
    if (/^-o./.test(a)) continue; // `-o<value>`: a push option, not a flag cluster
    if (/^-[a-zA-Z0-9]+$/.test(a)) {
      // A short-flag cluster (-fu, -nv): `n` is a dry run, `d` a deletion.
      if (a.includes('n') || a.includes('d')) return [];
      continue;
    }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const what = ['git', 'push', ...pos].join(' ');
  if (all) {
    return [{ kind: 'push', what, cwd: dir, revs: [], unclear: 'it pushes every branch or tag' }];
  }
  const decided: Handoff[] = [{ kind: 'push', what, cwd: dir, revs: [], unclear: 'git config decides which refs it pushes' }];
  if (configDecides || repoOpt) return decided;
  // The repo's config is not the one git will read, so it is not looked up.
  if (elsewhere) return fromElsewhere(what);
  // With no refspec, config decides what goes out: a push refspec, mirror mode or
  //   push.default=matching can send every branch (security review).
  if (pos.length <= 1 && pushConfigSendsMore(dir, pos[0])) return decided;
  const revs: string[] = [];
  for (const spec of pos.slice(1)) {
    const src = spec.replace(/^\+/, '').split(':')[0] ?? '';
    if (src !== '') revs.push(src); // `:dst` deletes: nothing is handed off
  }
  if (pos.length <= 1) revs.push('HEAD');
  if (revs.length === 0) return [];
  return [{ kind: 'push', what, cwd: dir, revs: Array.from(new Set(revs)) }];
}

const GH_VALUE_OPTS = new Set(['-R', '--repo', '-H', '--head', '-B', '--base', '-t', '--title', '-b', '--body', '-F', '--body-file', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer', '-T', '--template', '-s', '--source-branch', '--target-branch', '-d', '--description', '--hostname']);

function mrHandoff(words: string[], cwd: string): Handoff[] {
  const prog = words[0];
  const positional: string[] = [];
  let head = 'HEAD';
  const headFlags = prog === 'gh' ? ['--head', '-H'] : ['--source-branch', '-s'];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const eq = w.indexOf('=');
    const name = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w;
    if (headFlags.includes(name)) {
      head = eq > 0 && w.startsWith('--') ? w.slice(eq + 1) : (words[i + 1] ?? head);
      if (!(eq > 0 && w.startsWith('--'))) i++;
      continue;
    }
    if (GH_VALUE_OPTS.has(name)) {
      if (!(eq > 0 && w.startsWith('--'))) i++;
      continue;
    }
    if (w.startsWith('-')) continue;
    positional.push(w);
  }
  const [group, verb] = positional;
  const opens = (prog === 'gh' && group === 'pr' && verb === 'create') || (prog === 'glab' && group === 'mr' && verb === 'create');
  return opens ? [{ kind: 'mr', what: `${prog} ${group} create`, cwd, revs: [head] }] : [];
}

/** Env names that move git's config or repository (security reviews, rounds 3–4). */
const GIT_ENV = /^(?:GIT_CONFIG\w*|HOME|XDG_CONFIG_HOME|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR)$/;
/** Env that sets config or a program for one git command (#15). */
const GIT_RUNS_ENV = /^(?:GIT_CONFIG\w*|GIT_EXTERNAL_DIFF|GIT_EXEC_PATH)$/;
const SHELLS = /^(?:ba|z|da|k|c|tc|fi)?sh$/;
const ASSIGNING = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

/** True when a `git … push` names a command substitution among its arguments (`git push
 *  origin $(git branch --show-current)`): its refs are known only at run time. Read with the
 *  substitutions kept in their words, nested `sh -c` and `eval` included. */
function substitutedPush(command: string, depth = 0): boolean {
  for (const seg of shellSegments(stripHeredocs(command), { keepSubstitutions: true })) {
    const words = stripPrefix(seg).map((w) => w.replace(/^\(+/, ''));
    const prog = basename(words[0] ?? '');
    if (prog === 'git') {
      const p = words.indexOf('push');
      if (p > 0 && words.slice(p + 1).some((w) => /\$\(|`|<\(/.test(w))) return true;
    } else if (depth < 3 && SHELLS.test(prog)) {
      const c = words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
      const script = c >= 0 ? words.slice(c + 1).find((w) => !w.startsWith('-')) : undefined;
      if (script !== undefined && substitutedPush(script, depth + 1)) return true;
    } else if (depth < 3 && prog === 'eval' && substitutedPush(words.slice(1).join(' '), depth + 1)) return true;
  }
  return false;
}

const LOST_DIR =
  'it runs after a `cd` goodboy cannot follow (`cd -`, a computed dir, a `popd` past its `pushd`, a `cd` ending a pipeline, `env -C` with a computed dir); cd to a literal path';

/** Programs that may deploy or publish (DEPLOY_KIND), read per segment so the check knows the
 *  dir each one runs in (layer-1 round: `npm publish && cd /tmp` was compared in /tmp). */
const DEPLOY_PROGS = /^(?:kubectl|oc|helm|terraform|tofu|pulumi|aws|gcloud|az|rsync|scp|sftp|gh|glab|docker|podman|npm|pnpm|yarn|bun|cargo|gem|twine|poetry|uv)$/;

function handoffsOfAt(command: string, cwd: string, depth: number, rules?: HostRules, budget: ReadBudget = { aliasLookups: 0 }): Handoff[] {
  const out: Handoff[] = [];
  const unclear = (why: string): Handoff[] => [{ kind: 'push', what: 'git push', cwd, revs: [], unclear: why }];
  // A push word anywhere, quotes and backslashes removed (`pu''sh`, `pu\sh`), heredoc bodies
  //   included: what a shell reads on stdin may push.
  const mentionsPush = /\b(?:push|send-pack)\b/i.test(command.replace(/["'\\]/g, ''));
  // readCommand reads `sh -c`, `eval`, `xargs` and `find -exec` too (the shared reader), and
  //   where each segment runs: a `cd`/`pushd`/`popd` moves its own subshell scope (`cd ../B &&
  //   (git fetch) && git push` pushes from B; `(cd B) && git push` does not). A dir it cannot
  //   follow (`cd -`, a computed dir, `env -C`) makes a later hand-off there unclear instead of
  //   checked in the wrong repo (re-review).
  const { segments, truncated } = readCommand(command, cwd);
  if (truncated) return unclear('it is too large or nested to read');
  const deploys: { what: string; dir: string | null }[] = [];
  // Env set for every later command: `export HOME=/x;`, a bare `GIT_DIR=x;` (HOME is already
  //   exported, so a bare assignment reaches git too).
  const shellEnv = new Set<string>();
  // (#15) A command before a push in the same command that may change commits (`git commit
  //   … && git push`, `npm version patch && git push`, also between two pushes: closing
  //   check). One after the last push runs too late to matter (I8 review: `git push && git
  //   switch main`), unless a loop or a function may run it first. `at` is how many hand-offs
  //   came before it.
  const anyOrder = /\b(?:for|while|until|select|function)\b|\(\s*\)/.test(command);
  const movers: { name: string; git: boolean; at: number }[] = [];
  const mark = (what: string, git: boolean): void => {
    movers.push({ name: what.replace(/\s+/g, ' ').slice(0, 60), git, at: anyOrder ? 0 : out.length });
  };
  for (const { words, env, dir: here } of segments) {
    if (words.length === 0) {
      for (const n of env) shellEnv.add(n);
      continue;
    }
    const prog = basename(words[0]!);
    if (ASSIGNING.has(prog)) {
      for (const w of words.slice(1)) if (/^[A-Za-z_]\w*=/.test(w)) shellEnv.add(w.slice(0, w.indexOf('=')));
      continue;
    }
    if (prog === 'cd' || prog === 'pushd' || prog === 'popd') continue;
    if (rules && DEPLOY_PROGS.test(prog)) {
      const quoted = words.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(' ');
      const t = classifyOutward(quoted, here ?? cwd).find(
        (x) => x.mutating && DEPLOY_KIND.test(x.kind) && !['local', 'allow'].includes(classifyHost(x.host, rules)),
      );
      if (t) deploys.push({ what: `${t.kind} → ${t.host}`, dir: here });
    }
    // Per segment, not on the text (final G1 review: a commit message or a grep pattern with
    //   "push" and "xargs" is no push):
    // - a shell that reads its script on stdin (`… | sh`, `bash -s <<EOF`, `sh <<< …`) in a
    //   command that mentions a push;
    //   (`sh -c '<script>'` and `sh file` have an operand and read no stdin)
    //   (`-s` counts before the first operand only: `bash release.sh -s` passes -s to the script)
    //   (`bash -o errexit` and `bash /dev/stdin` read stdin too: shellReadsStdin)
    if (SHELLS.test(prog) && mentionsPush && shellReadsStdin(words)) return unclear('it feeds a script to a shell on stdin');
    // - a `trap` that runs a push later, on a signal or at exit (I8 review: never read);
    if (prog === 'trap' && mentionsPush) return unclear('it runs a push from a trap');
    // - git run by xargs, whose arguments are known only at run time;
    //   a built-in other than push takes its arguments from xargs harmlessly (`… | xargs git add`).
    if (prog === 'xargs') {
      const i = xargsCommandAt(words);
      if (basename(words[i] ?? '') === 'git') {
        const sub = words[gitSubcommandAt(words, i + 1)];
        if (sub === undefined || sub === 'push' || /[$`*?[]/.test(sub) || !GIT_BUILTINS.has(sub)) return unclear('its arguments come from xargs');
      }
    }
    // - an `eval` of a command substitution's output (`eval "$(echo git push …)"`), in a command
    //   that mentions a push (closing G1 review).
    //   A shell's `-c` script that is a whole substitution is the same (`bash -c "$(cat <<EOF
    //   …)"`); a literal script with one inside is read (`sh -c 'git push "$(…)"'`).
    const shellC = SHELLS.test(prog) ? words.findIndex((w, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) : -1;
    const runsOutput =
      (prog === 'eval' && words.slice(1).some((w) => /\$\(|`/.test(w))) || (shellC > 0 && WHOLE_SUBSTITUTION.test(words.slice(shellC + 1).find((w) => !w.startsWith('-')) ?? ''));
    if (runsOutput && mentionsPush) return unclear('it runs the output of a command substitution');
    if (prog === 'git') {
      const envConfig = [...env, ...shellEnv].some((n) => GIT_ENV.test(n));
      const found = gitHandoff(words, here ?? cwd, depth, budget, envConfig);
      if (here === null && found.length > 0) return unclear(LOST_DIR);
      const at = gitSubcommandAt(words, 1);
      const sub = words[at];
      // A config set for this command (`git -c diff.external=… diff`, GIT_CONFIG_* env) can run
      //   a program from any git command (I8 review). (A HOME or GIT_DIR for it reads another
      //   file or repo: still read-only, final G1 layer-1.)
      const configured =
        [...env, ...shellEnv].some((n) => GIT_RUNS_ENV.test(n)) || words.slice(1, at).some((w) => /^(?:-c|--config-env|--exec-path)/.test(w));
      // A segment that hands off (an alias of push too) is the hand-off, not a change next to it.
      if (found.length === 0 && sub !== undefined && (configured || changesCommits(sub, words.slice(at + 1)))) mark(`git ${sub}`, true);
      out.push(...found);
    } else if (prog === 'gh' || prog === 'glab') {
      const found = mrHandoff([prog, ...words.slice(1)], here ?? cwd);
      if (here === null && found.length > 0) return unclear(LOST_DIR);
      if (found.length === 0) mark(words.slice(0, 3).join(' '), false);
      out.push(...found);
    } else if (!READ_ONLY_PROGS.has(prog) && !(prog === 'command' && /^-[a-zA-Z]*[vV]/.test(words[1] ?? '')) && prog !== 'eval' && shellC < 0 && prog !== 'xargs' && !(prog === 'find' && words.some((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w)))) {
      // A program that runs a command from its arguments (`sh -c`, `eval`, `xargs`, `find
      //   -exec`) is no change itself: the command it runs is read as its own segment.
      mark(words.slice(0, 2).join(' '), false);
    }
    // Checked inside the loop, so a long command stops early (final review): the first unclear
    //   hand-off decides, and so do too many refs.
    const firstUnclear = out.find((h) => h.unclear);
    if (firstUnclear) return [firstUnclear];
    if (out.reduce((n, h) => n + h.revs.length, 0) > 10) return unclear('it hands off too many refs to check');
  }
  if (out.some((h) => h.kind === 'push') && substitutedPush(command)) return unclear('its refs come from a command substitution');
  // The hand-off after a mover; a git command is named before another program (a function's
  //   name reads as one).
  const after = (m: { at: number }) => out.slice(m.at).find((h) => (h.kind === 'push' || h.kind === 'mr') && !h.unclear);
  const first = movers.find((m) => m.git && after(m)) ?? movers.find((m) => after(m));
  if (first) return [runFirstHandoff(after(first)!, first.name)];
  // A deploy ships the files as they are: the working tree it runs in must be the tested one.
  for (const d of deploys.slice(0, 3)) {
    if (d.dir === null) return [{ kind: 'deploy', what: d.what, cwd, revs: [], unclear: LOST_DIR }];
    if (git(d.dir, ['rev-parse', '--git-dir']) !== null) out.push({ kind: 'deploy', what: d.what, cwd: d.dir, revs: [WORKTREE] });
  }
  return out;
}

/** The hand-offs a shell command makes, also inside `sh -c`, `eval` and git aliases. Deploys
 *  count only toward hosts that are neither local nor listed `allow` in .goodboy/hosts, and
 *  only inside a git repo (there is nothing to compare otherwise). */
export function handoffsOf(command: string, cwd: string, rules: HostRules): Handoff[] {
  return handoffsOfAt(command, cwd, 0, rules);
}

/** Workflow skills that hand off (their own pushes are checked again on the way). */
export function isHandoffSkill(name: string): boolean {
  return /^(?:[\w-]+:)?(?:ship|land-and-deploy)$/.test(name.trim());
}

export type PushTestOutcome =
  | {
      ok: true;
      /** Revisions that passed as prose on top of passing trees (#13), with those trees: their
       *  regression counts for them. */
      docsOnly?: Record<string, string[]>;
    }
  | {
      ok: false;
      why: 'unresolved' | 'no-result' | 'blocked' | 'unclear';
      rev: string;
      tree: string | null;
      blocked?: TestResult;
      /** Files where the handed-off tree differs from the newest passing result's tree. */
      differs?: string[];
      /** Why the newest result for exactly this tree did not count (#13: the denial said
       *  "no passing result" although one existed). */
      rejected?: string;
      /** (#15) See Handoff.runFirst. */
      runFirst?: string;
    };

/** Paths that differ between two tree hashes, or null when git cannot tell. */
export function treeDiff(cwd: string, a: string, b: string): string[] | null {
  if (!OBJECT_ID.test(a) || !OBJECT_ID.test(b)) return null;
  const out = git(cwd, ['diff-tree', '-r', '--name-only', '--end-of-options', a, b]);
  return out === null ? null : out.split('\n').filter((l) => l !== '');
}

/** Why a result is not a passing one with the evidence the Stop test gate asks for (the same
 *  checks, so the two cannot drift), or null when it is: verdict pass, a well-formed tree, at
 *  least one suite that ran, no failing suite, test files that exist, red-green evidence, no
 *  always-true test patterns. A hand-made JSON with only `verdict` and `tree` is not one. */
function notPassing(r: TestResult): string | null {
  if (r.verdict !== 'pass') return `its verdict is ${String(r.verdict)}`;
  if (typeof r.tree !== 'string' || !OBJECT_ID.test(r.tree)) return 'it records no tested tree';
  const suites = Array.isArray(r.suites) ? r.suites : [];
  if (!suites.some((s) => typeof s?.passed === 'number' && s.passed > 0)) return 'no suite ran a passing test';
  const files = Array.isArray(r.test_files) ? r.test_files : [];
  if (files.length === 0 || !files.every((f) => typeof f === 'string' && existsSync(f))) return 'it lists no test file, or one that does not exist';
  if (failingSuites([r]) !== null) return 'a suite failed';
  if (missingTestFiles([r]) !== null) return 'a test file it names is missing';
  if (validateEvidence([r]) !== null) {
    return (Array.isArray(r.acceptance) ? r.acceptance.length : 0) === 0
      ? 'it has no acceptance criterion with red-green evidence'
      : "an acceptance criterion's red-green evidence does not hold (its red run, green run or mutation probe)";
  }
  if (scanForbiddenPatterns(files).length > 0) return 'a test file has an always-true pattern';
  return null;
}
const passing = (r: TestResult): boolean => notPassing(r) === null;

/** Prose a docs-only hand-off may change (#13): Markdown, reStructuredText or AsciiDoc under a
 *  top-level `docs/` or `doc/`, or a root file such as README.md, CHANGELOG.md or LICENSE. Not
 *  every `document` in lib/verification-scope.ts: a requirements.txt, a prompt the app loads or
 *  a SKILL.md that tests assert can break a run (I6 review). */
const DOCS_DIR_PROSE = /^docs?\/.*\.(?:md|markdown|rst|adoc|asciidoc)$/i;
const ROOT_PROSE =
  /^(?:readme|changelog|changes|history|contributing|license|licence|notice|authors|code_of_conduct|security|support)(?:\.(?:md|markdown|rst|adoc|asciidoc|txt))?$/i;

/** (#13) The passing trees (of the newest five) that `tree` (handed off as `rev`) adds only
 *  prose to. Such a hand-off needs no new test result: a prose change cannot carry red-green
 *  evidence (real-use trial); the full regression of one of those trees still counts. Only
 *  regular files count: a submodule or a symlink named like a doc does not, and
 *  `--ignore-submodules=none` overrides a config that would hide a submodule bump. A deploy of
 *  the working tree never counts. */
export function docsOnlyBases(cwd: string, rev: string, tree: string, passTrees: readonly string[]): string[] {
  const bases: string[] = [];
  if (rev === WORKTREE || !OBJECT_ID.test(tree)) return bases;
  for (const t of passTrees.slice(0, 5)) {
    if (!OBJECT_ID.test(t)) continue;
    const out = git(cwd, ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--no-renames', '--ignore-submodules=none', '--end-of-options', t, tree]);
    if (out === null) continue;
    const f = out.split('\0');
    let n = 0;
    let prose = true;
    for (let i = 0; i + 1 < f.length && prose; i += 2) {
      const m = /^:(\d{6}) (\d{6}) /.exec(f[i]!);
      const ok = (mode: string) => mode === '100644' || mode === '100755' || mode === '000000';
      prose = m !== null && ok(m[1]!) && ok(m[2]!) && (DOCS_DIR_PROSE.test(f[i + 1]!) || ROOT_PROSE.test(f[i + 1]!));
      n++;
    }
    if (prose && n > 0) bases.push(t);
  }
  return bases;
}

/** The sentence that tells the model the user's one-use approval for a hand-off (#13: the model
 *  guessed the marker's session tag). */
export function handoffApprovalAsk(marker: string): string {
  return ` Only the user can approve a hand-off without it: they run \`! touch ${marker}\` (this once).`;
}

/** The model-facing denial for a failed hand-off check (English, per the repo rule). `marker`:
 *  the user's one-use approval path, for the main session (#13: the model guessed it). */
export function pushTestMessage(what: string, o: Exclude<PushTestOutcome, { ok: true }>, marker?: string): string {
  return pushTestText(what, o) + (marker ? handoffApprovalAsk(marker) : '');
}

function pushTestText(what: string, o: Exclude<PushTestOutcome, { ok: true }>): string {
  if (o.runFirst) {
    return (
      `This command runs \`${o.runFirst}\` before \`${what}\`. goodboy checks a push before the command runs, so it would ` +
      `judge the commits as they were before the \`${o.runFirst}\`. Run that part on its own first, then \`${what}\` as a ` +
      'separate command; the tested content still has to match what you hand off. (push test check)'
    );
  }
  if (o.why === 'unclear') {
    return (
      `goodboy cannot tell what \`${what}\` hands off: ${o.rev}. Push the branches or tags you mean by name ` +
      '(e.g. `git push origin feature v1.2.0`), each with a passing test result, or ask the user to approve. (push test check)'
    );
  }
  if (o.why === 'unresolved') {
    return `Cannot tell what ${what} hands off: ${o.rev} does not resolve to a commit. (push test check)`;
  }
  if (o.why === 'blocked') {
    return (
      `The test result for what ${what} hands off (${o.rev}) is BLOCKED: the tests could not run ` +
      `(${o.blocked?.blocked?.reason ?? 'no reason'}). Do not hand off untested work; tell the user. Only the user can approve it. (push test check)`
    );
  }
  const differs =
    o.differs && o.differs.length > 0
      ? ` It differs from the newest passing result in: ${o.differs.slice(0, 5).join(', ')}${o.differs.length > 5 ? ` and ${o.differs.length - 5} more` : ''}` +
        ' (edited after the tests, or untracked files present at test time that are not committed).'
      : '';
  const rev = o.rev === WORKTREE ? 'the working tree as it is' : o.rev;
  const rejected = o.rejected ? ` A result for exactly this tree exists but does not count: ${o.rejected}.` : '';
  return (
    `${what} hands off ${rev} without a passing test result for exactly that content ` +
    `(tree ${o.tree?.slice(0, 10) ?? '?'}).${rejected}${differs} Run the layer-1 tests (${agentName(ROUTE.test)}; \`test-write\` records the tested tree) ` +
    'on what you hand off, then try again. A commit made after the tests still matches; any edit after them does not. ' +
    (o.rev === WORKTREE
      ? ''
      : 'Commits that change only prose (Markdown under docs/, or a root README, CHANGELOG or LICENSE) on top of a tested tree need no new tests; that tree\'s full regression still counts. ') +
    '(push test check)'
  );
}

/** Whether every revision a hand-off sends has a passing test result for its exact tree.
 *  `results` are newest first (findRecentTestFiles). */
export function checkHandoff(
  h: Handoff,
  results: TestResult[],
  treeOf: (cwd: string, rev: string) => string | null = revisionTree,
  diffOf: (cwd: string, a: string, b: string) => string[] | null = treeDiff,
  docsOnly: (cwd: string, rev: string, tree: string, passTrees: readonly string[]) => string[] = docsOnlyBases,
): PushTestOutcome {
  if (h.unclear) return { ok: false, why: 'unclear', rev: h.unclear, tree: null, ...(h.runFirst ? { runFirst: h.runFirst } : {}) };
  const docRevs: Record<string, string[]> = {};
  const passed = results.filter(passing);
  for (const rev of h.revs) {
    const tree = treeOf(h.cwd, rev);
    if (tree === null) return { ok: false, why: 'unresolved', rev, tree };
    const forTree = results.filter((r) => r.tree === tree);
    if (forTree.some(passing)) continue;
    const blocked = forTree.find((r) => r.verdict === 'blocked');
    if (blocked) return { ok: false, why: 'blocked', rev, tree, blocked };
    // Not when the tree handed off has a failed result of its own (a README doctest).
    const bases = forTree.some((r) => r.verdict !== 'pass') ? [] : docsOnly(h.cwd, rev, tree, passed.map((r) => r.tree!));
    if (bases.length > 0) {
      docRevs[rev] = bases;
      continue;
    }
    const newestPass = passed[0];
    const differs = newestPass ? (diffOf(h.cwd, newestPass.tree!, tree) ?? undefined) : undefined;
    const rejected = forTree.length > 0 ? (notPassing(forTree[0]!) ?? undefined) : undefined;
    return { ok: false, why: 'no-result', rev, tree, ...(differs ? { differs } : {}), ...(rejected ? { rejected } : {}) };
  }
  return Object.keys(docRevs).length > 0 ? { ok: true, docsOnly: docRevs } : { ok: true };
}
