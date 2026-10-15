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
import { HOOK_GIT_ARGS, HOOK_GIT_ENV, splitAliasValue } from './hook-git';
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
}

/** The working tree itself as a hand-off revision (deploys, publishes). */
export const WORKTREE = ':worktree';

/** A git object id as stored by test-write; anything else is never passed to git. */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Runs git with a time limit: a stalled git (a hung network mount, a slow fsmonitor) fails
 *  the call, so a hand-off check denies instead of being cancelled by the hook timeout. It
 *  starts no program from the repo's config (lib/hook-git.ts), except a clean filter in the
 *  work-tree hash (docs/stabilization-plan.md §10.10). */
function git(cwd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 15_000): string | null {
  try {
    const proc = Bun.spawnSync(['git', ...HOOK_GIT_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...HOOK_GIT_ENV, ...env },
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
function topOf(cwd: string): string | null {
  const cdup = git(cwd, ['rev-parse', '--show-cdup']);
  return cdup === null ? null : resolvePath(cwd, cdup || '.');
}

/** goodboy's own artifacts never count as content, on either side of the comparison:
 *  `.claude/tests` is written after the tree is taken, and repos that do not ignore `.claude/`
 *  may commit them. */
const ARTIFACT_PATHS = ['.claude/tests', '.claude/reviews', '.claude/pending'];
const ARTIFACT_REMOVE = ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...ARTIFACT_PATHS, ':(glob).claude/.goodboy-*'];

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
    git(top, ARTIFACT_REMOVE, env);
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
  const inClaude = git(cwd, ['ls-tree', '--name-only', '--full-tree', tree, '.claude/']);
  const hasArtifacts = (inClaude ?? '')
    .split('\n')
    .some((p) => ARTIFACT_PATHS.includes(p) || p.startsWith('.claude/.goodboy-'));
  if (!hasArtifacts) return tree;
  const top = topOf(cwd);
  if (top === null) return null;
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-tree-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    if (git(top, ['read-tree', tree], env) === null) return null;
    git(top, ARTIFACT_REMOVE, env);
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
  for (let j = 0; j < args.length; j++) {
    const a = args[j]!;
    if (a === '--') {
      pos.push(...args.slice(j + 1));
      break;
    }
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
  if (configDecides) return decided;
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
      out.push(...found);
    } else if (prog === 'gh' || prog === 'glab') {
      const found = mrHandoff([prog, ...words.slice(1)], here ?? cwd);
      if (here === null && found.length > 0) return unclear(LOST_DIR);
      out.push(...found);
    }
    // Checked inside the loop, so a long command stops early (final review): the first unclear
    //   hand-off decides, and so do too many refs.
    const firstUnclear = out.find((h) => h.unclear);
    if (firstUnclear) return [firstUnclear];
    if (out.reduce((n, h) => n + h.revs.length, 0) > 10) return unclear('it hands off too many refs to check');
  }
  if (out.some((h) => h.kind === 'push') && substitutedPush(command)) return unclear('its refs come from a command substitution');
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
  | { ok: true }
  | {
      ok: false;
      why: 'unresolved' | 'no-result' | 'blocked' | 'unclear';
      rev: string;
      tree: string | null;
      blocked?: TestResult;
      /** Files where the handed-off tree differs from the newest passing result's tree. */
      differs?: string[];
    };

/** Paths that differ between two tree hashes, or null when git cannot tell. */
export function treeDiff(cwd: string, a: string, b: string): string[] | null {
  if (!OBJECT_ID.test(a) || !OBJECT_ID.test(b)) return null;
  const out = git(cwd, ['diff-tree', '-r', '--name-only', '--end-of-options', a, b]);
  return out === null ? null : out.split('\n').filter((l) => l !== '');
}

/** A passing result with the evidence the Stop test gate asks for (the same checks, so the two
 *  cannot drift): verdict pass, a well-formed tree, at least one suite that ran, no failing
 *  suite, test files that exist, red-green evidence, no always-true test patterns. A hand-made
 *  JSON with only `verdict` and `tree` is not one. */
function passing(r: TestResult): boolean {
  if (r.verdict !== 'pass' || typeof r.tree !== 'string' || !OBJECT_ID.test(r.tree)) return false;
  const suites = Array.isArray(r.suites) ? r.suites : [];
  if (!suites.some((s) => typeof s?.passed === 'number' && s.passed > 0)) return false;
  const files = Array.isArray(r.test_files) ? r.test_files : [];
  if (files.length === 0 || !files.every((f) => typeof f === 'string' && existsSync(f))) return false;
  return (
    failingSuites([r]) === null &&
    missingTestFiles([r]) === null &&
    validateEvidence([r]) === null &&
    scanForbiddenPatterns(files).length === 0
  );
}

/** The model-facing denial for a failed hand-off check (English, per the repo rule). */
export function pushTestMessage(what: string, o: Exclude<PushTestOutcome, { ok: true }>): string {
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
  return (
    `${what} hands off ${rev} without a passing test result for exactly that content ` +
    `(tree ${o.tree?.slice(0, 10) ?? '?'}).${differs} Run the layer-1 tests (${agentName(ROUTE.test)}; \`test-write\` records the tested tree) ` +
    'on what you hand off, then try again. A commit made after the tests still matches; any edit after them does not. (push test check)'
  );
}

/** Whether every revision a hand-off sends has a passing test result for its exact tree.
 *  `results` are newest first (findRecentTestFiles). */
export function checkHandoff(
  h: Handoff,
  results: TestResult[],
  treeOf: (cwd: string, rev: string) => string | null = revisionTree,
  diffOf: (cwd: string, a: string, b: string) => string[] | null = treeDiff,
): PushTestOutcome {
  if (h.unclear) return { ok: false, why: 'unclear', rev: h.unclear, tree: null };
  for (const rev of h.revs) {
    const tree = treeOf(h.cwd, rev);
    if (tree === null) return { ok: false, why: 'unresolved', rev, tree };
    const forTree = results.filter((r) => r.tree === tree);
    if (forTree.some(passing)) continue;
    const blocked = forTree.find((r) => r.verdict === 'blocked');
    if (blocked) return { ok: false, why: 'blocked', rev, tree, blocked };
    const newestPass = results.find(passing);
    const differs = newestPass ? (diffOf(h.cwd, newestPass.tree!, tree) ?? undefined) : undefined;
    return { ok: false, why: 'no-result', rev, tree, ...(differs ? { differs } : {}) };
  }
  return { ok: true };
}
