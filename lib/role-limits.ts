// Role limits (track G §10.3, §10.10) — what a goodboy agent may write and which tool skills
// it may invoke. Plugin agents ignore `permissionMode` and `Skill(...)` entries (G0 M5, M9),
// so the PreToolUse hook enforces these from the policy table.
//
// Write scopes, for files inside the project (outside it, e.g. a mktemp probe dir, writes
// pass): `none` and `result` write nothing (results go through the goodboy CLI); `tests`
// writes test files only; `docs` writes docs only; `code` writes anything.

import { basename, relative, resolve as resolvePath, sep } from 'node:path';
import { commandSegments, dropRedirects, gitSubcommandAt, plainWord, readCommand, xargsCommandAt } from './outward-command';
import { namesOwnResultDir } from './result-dir';
import { agentName, LEGACY_AGENTS, roleOf, ROUTE, type RoleSpec } from './routing-policy';
import { isTestFile, TEST_RUNNER_CONFIG } from './test-validator';
import { classifyPath } from './verification-scope';

// Beyond layer 1's isTestFile: more test dirs, JVM/.NET/Ruby names, test-runner configs.
const TEST_DIR_EXTRA = /(^|\/)(__mocks__|specs|cypress|playwright|fixtures|testdata)\//;
const TEST_FILE_EXTRA =
  /(\.e2e\.[cm]?[jt]sx?$)|(_test\.exs?$)|((^|\/)conftest\.py$)|(Tests?\.(java|kt|cs|swift)$)|(_spec\.rb$)/;

/** Project-relative path with `/` separators, or null when the file is outside the project. */
export function projectRelative(absPath: string, projectRoot: string): string | null {
  const rel = relative(projectRoot, absPath);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) return null;
  return rel.split(sep).join('/');
}

export function isTestPath(rel: string): boolean {
  return isTestFile(rel) || TEST_DIR_EXTRA.test(rel) || TEST_FILE_EXTRA.test(rel) || TEST_RUNNER_CONFIG.test(rel);
}

/** Why the role may not write this file, or null when it may. */
export function writeDenial(role: RoleSpec, absPath: string, projectRoot: string): string | null {
  // The project root itself is inside (`tar -xf a.tgz` extracts into it).
  const rel = resolvePath(absPath) === resolvePath(projectRoot) ? '.' : projectRelative(absPath, projectRoot);
  if (rel === null) return null; // outside the project
  switch (role.writes) {
    case 'code':
      return null;
    case 'tests':
      return isTestPath(rel) ? null : `${role.name} writes test files only, not ${rel}. Report the needed change instead.`;
    case 'docs':
      // Documents and static previews (lib/verification-scope.ts), never code under docs/.
      return classifyPath(rel) !== 'code' ? null : `${role.name} writes docs only, not ${rel}. Report the needed change instead.`;
    case 'result':
      return `${role.name} writes only its result, through the goodboy CLI, not ${rel}. Report the needed change as a finding instead.`;
    default:
      return `${role.name} is read-only and may not write ${rel}. Report what you found instead.`;
  }
}

const FILE_MUTATORS = new Set(['cp', 'mv', 'rm', 'ln', 'install', 'patch', 'truncate', 'chmod', 'chown', 'touch', 'unlink', 'rmdir', 'shred', 'mkdir']);
const COPY_LIKE = new Set(['cp', 'ln', 'install']);
const CHMOD_MODE = /^(?:[0-7]{1,4}|[ugoa]*[-+=][rwxXstugo]*(?:,[ugoa]*[-+=][rwxXstugo]*)*)$/;
const GIT_MUTATING = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'checkout-index', 'cherry-pick', 'clean', 'commit', 'config', 'merge',
  'merge-file', 'mv', 'pull', 'read-tree', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag',
  'update-index', 'update-ref', 'worktree',
]);

/** The value of a short flag that ends a cluster (`-sSLo file` → file for `o`), or undefined. */
function clusterValue(words: string[], flag: string): string | undefined {
  const k = words.findIndex((w, i) => i > 0 && new RegExp(`^-[a-zA-Z]+${flag}$`).test(w));
  return k > 0 ? words[k + 1] : undefined;
}

/** Programs that write files named by an option or into a directory (security review round 2). */
function optionTargets(prog: string, words: string[], base: string): string[] | null {
  const valueOf = (names: string[]): string | undefined => {
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      for (const n of names) {
        if (w === n) return words[i + 1];
        if (n.startsWith('--') && w.startsWith(`${n}=`)) return w.slice(n.length + 1);
        if (!n.startsWith('--') && w.startsWith(n) && w.length > n.length) return w.slice(n.length);
      }
    }
    return undefined;
  };
  const args = words.slice(1).filter((w) => !w.startsWith('-'));
  switch (prog) {
    case 'tar':
    case 'gtar':
    case 'bsdtar': {
      const extracting = words.some((w, i) => i > 0 && (w === '-x' || w === '--extract' || (/^-?[a-zA-Z]*x[a-zA-Z]*$/.test(w) && !w.startsWith('--'))));
      return extracting ? [resolvePath(base, valueOf(['-C', '--directory']) ?? '.')] : [];
    }
    case 'unzip':
      return [resolvePath(base, valueOf(['-d']) ?? '.')];
    case 'curl': {
      // Also inside a short-flag cluster: `-so file`, `-sSLo file`, `-sO` (layer-1 round).
      const o = valueOf(['-o', '--output']) ?? clusterValue(words, 'o');
      // `--output-dir dir` holds a relative -o file (curl 7.73+).
      if (o !== undefined) return [resolvePath(base, valueOf(['--output-dir']) ?? '.', o)];
      const remoteName = words.some((w, i) => i > 0 && (w === '--remote-name' || w === '--remote-name-all' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(w)));
      return remoteName ? [resolvePath(base, valueOf(['--output-dir']) ?? '.')] : [];
    }
    case 'wget': {
      const o = valueOf(['-O', '--output-document']) ?? clusterValue(words, 'O') ?? valueOf(['-P', '--directory-prefix']);
      return [resolvePath(base, o ?? '.')];
    }
    case 'rsync':
    case 'ditto':
    case 'scp':
      return args.length > 0 && !/^[^/]*:/.test(args[args.length - 1]!) ? [resolvePath(base, args[args.length - 1]!)] : [];
    default:
      return null;
  }
}

/** Paths a shell command changes through file programs (cp/mv/rm/touch/chmod/…, perl or ruby
 *  -i) and a mutating git command (reported as the repo's `.git`), for role limits. The
 *  redirect-based writes come from classifyBashWrite. Arguments with `$`, globs or backticks
 *  are taken literally (a non-matching path is outside the project and passes). */
export function bashChangedPaths(command: string, cwd: string, opts: { skip?: ReadonlySet<string> } = {}): string[] {
  const out: string[] = [];
  // Paths read like classifyBashWrite reads them: each segment from the dir it runs in
  //   (readCommand: subshell scopes, pushd/popd; layer-1 round: `(cd /tmp) && cp x src/a.ts`
  //   was read from /tmp), from the cwd when that dir cannot be told; a path with `$`, a glob
  //   or a backtick cannot be resolved and is skipped (fail-open, as there).
  const literal = (a: string) => !/[$`*?]/.test(a);
  for (const { words, dir } of readCommand(command, cwd).segments) {
    const prog = basename(words[0] ?? '');
    const args = words.slice(1).filter((w) => !w.startsWith('-'));
    if (prog === 'cd' || prog === 'pushd' || prog === 'popd') continue;
    const base = dir ?? cwd;
    if (opts.skip?.has(prog)) continue;
    const viaOptions = optionTargets(prog, words, base);
    if (viaOptions !== null) {
      out.push(...viaOptions.filter((p) => literal(p)));
    } else if (FILE_MUTATORS.has(prog)) {
      // chmod's mode is no path (trial 5: `chmod +x /tmp/x.sh` was read as `<project>/+x`).
      const files = prog === 'chmod' ? args.filter((a) => !CHMOD_MODE.test(a)) : args;
      const targets = COPY_LIKE.has(prog) ? files.slice(-1) : files;
      for (const a of targets) if (literal(a)) out.push(resolvePath(base, a));
    } else if ((prog === 'perl' || prog === 'ruby') && words.some((w) => /^-[a-zA-Z]*i/.test(w))) {
      for (const a of args.slice(1)) if (literal(a)) out.push(resolvePath(base, a)); // the first is the script
    } else if (prog === 'git') {
      if (GIT_MUTATING.has(words[gitSubcommandAt(words)] ?? '')) out.push(resolvePath(base, '.git'));
    }
  }
  return out;
}

const JS_RUNTIMES = /^(?:bun|node|nodejs|tsx|ts-node|deno|bunx|npx)$/;
const UNREADABLE = /[$`*?[]/;

/** Which goodboy result a shell command records through the CLI (`bun … lib/cli.ts test-write`
 *  or `review-write`), 'unknown' when its subcommand cannot be read, or null. Only a JS runtime
 *  running goodboy's CLI counts (final G1 review: `cat lib/cli.ts`, `git add lib/cli.ts` and a
 *  project's own `bun src/cli.ts --help` are no result writes). The script is a `lib/cli.ts`
 *  path, or a variable or glob (`bun "$C" …`, `bun lib/cli.t[s] …`) that may be one. */
export function resultCliWrite(command: string): 'test' | 'review' | 'unknown' | null {
  // (I4) A JS runtime that calls the regression record writer or loads lib/regression itself
  //   records a test result as much as the CLI does, wherever the name sits in the command (a
  //   variable, a heredoc fed to `bun -`); a grep or a commit message naming it, with no JS
  //   runtime, does not (round-2 review, closing check). Code read from a file at run time
  //   (`bun -e "$(cat x)"`) is a same-user limit (plan §15.7).
  const segments = commandSegments(command);
  if (/\bwriteRegressionRecord\b|\blib\/regression(?:\.ts)?\b/.test(command) && segments.some((w) => JS_RUNTIMES.test(basename(w[0] ?? '')))) {
    return 'test';
  }
  for (const words of segments) {
    const prog = basename(words[0] ?? '');
    let at = -1;
    if (/(?:^|\/)lib\/cli\.ts$/.test(plainWord(words[0] ?? ''))) at = 0; // run as an executable
    else if (JS_RUNTIMES.test(prog)) {
      // The script: a `lib/cli.ts` word anywhere after the runtime (behind flags with values,
      //   `--cwd .`, `--require tsx/cjs`, or a loader, `bunx tsx …`: layer-1 round), else the
      //   first word after the flags (and `run` / `x`) when it is a variable or glob.
      at = words.findIndex((w, k) => k > 0 && /(?:^|\/)lib\/cli\.ts$/.test(plainWord(w)));
      if (at < 0) {
        let i = 1;
        while (i < words.length && (words[i]!.startsWith('-') || ['run', 'x', 'exec'].includes(words[i]!))) i++;
        if (words[i] !== undefined && UNREADABLE.test(words[i]!)) at = i;
      }
    }
    if (at < 0) continue;
    const rest = words.slice(at + 1);
    // `regression` (I4) records the full regression run, a test result too.
    if (rest.includes('test-write') || rest.includes('regression')) return 'test';
    if (rest.includes('review-write')) return 'review';
    // A literal subcommand (`review-axes`, `--help`) is no result write; one built at run time
    //   (`${k}-write`, `$(printf 'test-%s' write)`) cannot be read.
    const sub = rest[0];
    if (sub !== undefined && UNREADABLE.test(sub)) return 'unknown';
  }
  return null;
}

const WRITES_ANY = new Set(['mv', 'rm', 'tee', 'sponge', 'touch', 'truncate', 'chmod', 'chown', 'shred', 'unlink', 'rmdir', 'patch', 'dd']);
const WRITES_LAST = new Set(['cp', 'ln', 'install', 'rsync', 'ditto', 'scp']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|deno|bun|bunx|tsx|ts-node|ruby|perl|php|osascript|g?awk|lua)$/;
const GIT_TREE_WRITES = new Set(['checkout', 'restore', 'mv', 'rm', 'checkout-index', 'apply', 'am', 'stash', 'clean']);
const OUT_REDIRECT = /^\d*(?:&?>>?|>\|)/;

function writesProg(prog: string): boolean {
  return WRITES_ANY.has(prog) || WRITES_LAST.has(prog) || INTERPRETERS.test(prog) || prog === 'sed';
}

/** The result-dir word a shell command writes, copies, moves or deletes into, or null (security
 *  reviews: results come only from the CLI, which writes from its own process). A write is a
 *  redirect target, a file program's target (`cp`'s destination; any word of `mv`, `rm`, `tee`,
 *  `touch` …), `sed -i`, an interpreter whose code names the dir, a git command that writes the
 *  work tree, or `find -delete|-exec <writer>`. Every other program only reads what it names
 *  (final G1 review: `sed -n`, `awk`, `for f in .claude/tests/*`, `git log -- .claude/reviews`
 *  and a commit message naming the dir passed in v0.30 and pass again). Programs that write by
 *  option count too (`curl -o`, `wget -O`, `tar -x -C`, `unzip -d`, `cp -t`). A name reached
 *  indirectly counts: a relative write after `cd .claude/tests`, a write to the variable of a
 *  loop over the dir (`for f in .claude/tests/*; do cp x "$f"`, `… | while read f`), or an
 *  `xargs` writer whose target is its input. Copying results out (`cp .claude/tests/x "$D/"`)
 *  is a read. Only the cwd's own result dirs count (lib/result-dir.ts). */
export function resultDirWrite(command: string, cwd: string): string | null {
  // A pure read (no write of its own) that names the dir, and what may carry that name to a
  //   writer: a loop variable, a `read` variable, or the input of an xargs writer.
  let namedByRead: string | null = null;
  const carriers = new Set<string>();
  let xargsWritesInput = false;
  let feedsWriter = false;
  // A `cd` into a result dir that goodboy cannot resolve (`cd .claude/te*s`).
  let maybeInResultDir = false;
  // A target the carried name leads (`"$f"`, `${f}.bak`, `"$(dirname "$f")/x"`), not one that
  //   only uses it later (`"$TMPDIR/$(basename "$f")"` copies out: re-review). The names a word
  //   uses are looked up in a set, so the work grows with the text, not with words × carriers
  //   (final G1 review: 115 KB took 6.8 s).
  const refersTo = (w: string) => {
    if (carriers.size === 0) return false;
    const lead = /^\$\{?(\w+)/.exec(w);
    if (lead && carriers.has(lead[1]!)) return true;
    if (!w.startsWith('$(')) return false;
    for (const m of w.slice(0, w.indexOf(')') + 1).matchAll(/\$\{?(\w+)/g)) if (carriers.has(m[1]!)) return true;
    return false;
  };
  const carry = (v: string) => {
    if (/^\w+$/.test(v)) carriers.add(v);
  };
  for (const { words, dir, unsure } of readCommand(command, cwd, { keepRedirects: true }).segments) {
    // Each segment from the dir it runs in; inside a result dir, relative writes land there.
    const base = dir ?? cwd;
    const inResultDir = maybeInResultDir || (dir !== null && namesOwnResultDir(`${dir}/`, cwd, cwd));
    const named = (w: string) => namesOwnResultDir(w, base, cwd);
    const written: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const m = words[i]!.match(OUT_REDIRECT);
      if (!m) continue;
      const target = words[i]!.slice(m[0].length) || words[i + 1] || '';
      if (target === '' || /^&?\d$/.test(target) || target === '/dev/null') continue;
      if (named(target)) return target;
      written.push(target);
    }
    const plain = dropRedirects(words);
    const prog = basename(plain[0] ?? '');
    const args = plain.slice(1);
    if (prog === 'cd' || prog === 'pushd' || prog === 'popd') {
      // readCommand moved the dir; a target it could not resolve, or a cd that moves the shell
      //   in zsh only (`true | cd .claude/tests`), may still put later writes in a result dir.
      const to = args.find((w) => !w.startsWith('-'));
      if ((dir === null || unsure) && to !== undefined && named(`${to}/`)) maybeInResultDir = true;
      continue;
    }
    const operands = args.filter((w) => !w.startsWith('-'));
    let targets: string[] = [];
    // awk writes only through its program (`print > "f"`); its file operands are input.
    if (/^g?awk$/.test(prog)) targets = operands.slice(0, 1);
    else if (WRITES_ANY.has(prog) || INTERPRETERS.test(prog)) targets = args;
    else if (WRITES_LAST.has(prog)) {
      // GNU `-t dir` / `--target-directory=dir` names the destination up front (cp, ln and
      //   install only: rsync's -t is --times).
      const gnu = ['cp', 'ln', 'install'].includes(prog);
      // `-t` also ends a cluster (`cp -vt dir`, `install -Dt dir`).
      const t = gnu ? args.findIndex((w) => w === '-t' || w === '--target-directory' || /^-[a-zA-Z]+t$/.test(w)) : -1;
      const eq = gnu ? args.find((w) => w.startsWith('--target-directory=') || /^-t./.test(w)) : undefined;
      targets = t >= 0 ? args.slice(t + 1, t + 2) : eq ? [eq.startsWith('-t') ? eq.slice(2) : eq.slice('--target-directory='.length)] : operands.slice(-1);
    } else if (prog === 'sed' && args.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w))) targets = args;
    else if (prog === 'git') {
      const i = gitSubcommandAt(plain) - 1;
      const sub = args[i] ?? '';
      // `git rm --cached` and `git restore --staged` (without --worktree) change the index only.
      const indexOnly =
        (sub === 'rm' && args.includes('--cached')) ||
        (sub === 'restore' && args.some((w) => w === '--staged' || w === '-S') && !args.some((w) => w === '--worktree' || w === '-W'));
      if (GIT_TREE_WRITES.has(sub) && !indexOnly) targets = args.slice(i + 1);
    } else if (prog === 'find') {
      const execIdx = args.findIndex((w) => ['-exec', '-execdir', '-ok', '-okdir'].includes(w));
      if (args.includes('-delete') || (execIdx >= 0 && writesProg(basename(args[execIdx + 1] ?? '')))) targets = args;
    } else if (prog === 'xargs') {
      const i = xargsCommandAt(plain) - 1;
      // The replace string: `-I str`, `-Istr`, GNU `-i` / `--replace` (`{}`), `-istr`, `--replace=str`.
      let token: string | undefined;
      args.slice(0, i).forEach((w, k) => {
        if (w === '-I' || w === '-J') token = args[k + 1]; // BSD -J: where the input goes
        else if (/^-I./.test(w)) token = w.slice(2);
        else if (w === '-i' || w === '--replace') token = '{}';
        else if (/^-i./.test(w)) token = w.slice(2);
        else if (w.startsWith('--replace=')) token = w.slice('--replace='.length);
      });
      const run = basename(args[i] ?? '');
      const runArgs = args.slice(i + 1);
      const runOperands = runArgs.filter((w) => !w.startsWith('-'));
      // A file program whose target is its input: with a replace string, where it stands;
      //   without, appended last. An in-place editor (`sed -i`, `perl -pi`, `ruby -i`) edits its
      //   input (re-review). Other interpreters (`… | xargs bun test`) read it.
      const inPlace =
        (run === 'sed' && runArgs.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w))) ||
        ((run === 'perl' || run === 'ruby') && runArgs.some((w) => /^-[a-zA-Z]*i/.test(w)));
      if (WRITES_ANY.has(run) || inPlace) xargsWritesInput = true;
      else if (WRITES_LAST.has(run)) xargsWritesInput = token === undefined || (runOperands.at(-1) ?? '').includes(token);
    } else {
      // Options that name where a program writes (tar -x -C, unzip -d, curl -o, wget -O).
      targets = optionTargets(prog, plain, base) ?? [];
    }
    const hit = targets.find(named);
    if (hit) return hit;
    written.push(...targets);
    if (written.some(refersTo)) feedsWriter = true;
    // After `cd .claude/tests`, a relative target is inside it.
    const relative = written.find((w) => !w.startsWith('/') && !w.startsWith('~') && !w.startsWith('-'));
    if (inResultDir && relative !== undefined) return `${relative} (after a cd into a result dir)`;
    if (written.length > 0) continue;
    if (prog === 'read') for (const v of operands) carry(v);
    const name = plain.find(named);
    if (name === undefined) continue;
    namedByRead ??= name;
    // `for f in <dir>/*` and `… | while read f` carry the name in a variable.
    if (prog === 'for' && args[1] === 'in') carry(args[0]!);
  }
  return namedByRead !== null && (feedsWriter || xargsWritesInput) ? namedByRead : null;
}

/** Why this agent may not record that result, or null when it may (security review: with the
 *  count-based escapes gone, a main session writing its own "passing" results was the
 *  cheapest way past the gates). Test results come from test agents and review results from
 *  review agents, the pre-G2 names (LEGACY_AGENTS) included. */
export function resultWriterDenial(kind: 'test' | 'review' | 'unknown', agentType: string | undefined, role: RoleSpec | null): string | null {
  const legacyTeam = agentType?.startsWith('goodboy:') ? roleOf(agentName(LEGACY_AGENTS[agentType.slice('goodboy:'.length)] ?? ''))?.team : undefined;
  const team = role?.team ?? legacyTeam;
  if (kind === 'unknown') {
    return team === 'test' || team === 'review'
      ? null
      : `This runs the goodboy result CLI with a subcommand built at run time; only test and review agents record results, and ${agentType ?? 'the main session'} is neither.`;
  }
  if (team === kind) return null;
  const agent = agentName(kind === 'test' ? ROUTE.test : ROUTE.review);
  return (
    `Only goodboy ${kind} agents record ${kind} results (${agent}${kind === 'test' ? ', test-*' : ', review-*'}); ` +
    `${agentType ? agentType : 'the main session'} may not. Run ${agent} instead.`
  );
}

/** Bare skill name: `goodboy:check-security` → `check-security`; other namespaces are kept. */
export function bareSkillName(skill: string): string {
  const s = skill.trim().replace(/^\//, '');
  return s.startsWith('goodboy:') ? s.slice('goodboy:'.length) : s;
}

/** Why the role may not invoke this skill, or null when it may. */
export function skillDenial(role: RoleSpec, skill: string): string | null {
  const name = bareSkillName(skill);
  if (role.toolSkills.includes(name)) return null;
  const allowed = role.toolSkills.length > 0 ? role.toolSkills.join(', ') : 'none';
  return `${role.name} may use only its tool skills (${allowed}), not ${skill}. Workflow skills belong to the main session.`;
}
