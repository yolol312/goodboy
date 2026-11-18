// The git side of the commit and push scan (track M, M6f; lib/commit-scan.ts is the scanner): `cli.ts git-hooks
// install [--force] | uninstall`, and the commands the hooks run, `commit-scan [--hook pre-commit|commit-msg <file>]`
// and `push-scan [--hook pre-push <remote> <url>]`. They cover commits and pushes made outside Claude Code (an IDE,
// a terminal), where the PreToolUse check (lib/commit-scan-guard.ts) does not run. The user installs them.
//
// The hooks: `pre-commit` scans the index (git points GIT_INDEX_FILE at the exact tree for `-a` and paths), `commit-msg`
// the message file, `pre-push` what the refs on its stdin send. Each runs goodboy's CLI; one that cannot (the plugin
// moved, no bun) stops the commit with a message (fail closed). In a project that holds no real data they exit 0 and
// scan nothing. Where the hooks go: the repo's hooks dir, `core.hooksPath` honoured (install prints the dir it used; a
// shared one is shared by every repo that uses it, and `uninstall` in any of them removes it for all); a hook
// goodboy did not write is never overwritten without `--force`, which keeps it as `<name>.goodboy-saved` and chains
// it (it runs after goodboy's, with the same arguments and stdin); `uninstall` removes only goodboy's hooks and puts a
// saved one back. `--no-verify` skips git hooks: that is git's, and stated in the README.
//
// A hit or an unscanned file stops the commit or push with the list (no value), unless the user's one-use approval is
// there: a file `.claude/.goodboy-commit-scan-approved-<anything>.txt` in the project (or the repo) whose content is
// the digest the message prints, consumed when it passes. The PreToolUse check has its own approval per session, so a
// commit Claude Code runs after that approval needs this one too when the hooks are installed.

import { lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { consumeApprovalMarker } from './approval-marker';
import { Acc, commitScanText, DEFAULT_LIMITS, markerHoldsDigest, pushInputFromHook, realDataRootOf, identityOverridden, repoOf, scanIdentity, scanIndex, scanMessageFile, scanPush, type ScanReport } from './commit-scan';
import { pushInputOf } from './commit-scan-guard';
import { spawnGit } from './git-run';
import { readRegular } from './safe-read';

const HOOK_NAMES = ['pre-commit', 'commit-msg', 'pre-push'] as const;
type HookName = (typeof HOOK_NAMES)[number];
/** The line that marks a hook as goodboy's. */
export const HOOK_SIGNATURE = '# goodboy-git-hook v1';
const MARKER_FILE = /^\.goodboy-commit-scan-approved-[^/\\]*\.txt$/i;
const HOOK_MS = 50_000;

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The text of one hook. `bun` and `cli` are absolute. */
export function hookScript(name: HookName, bun: string, cli: string): string {
  const head = [
    '#!/bin/sh',
    HOOK_SIGNATURE,
    `# ${name}: scans what a commit or push publishes in a project that holds real data. Installed by \`bun ${cli} git-hooks install\`;`,
    '# \`git-hooks uninstall\` removes it. After a plugin update run install again (the path below changes).',
    `GB_BUN=${q(bun)}`,
    `GB_CLI=${q(cli)}`,
    'if [ ! -f "$GB_CLI" ]; then echo "goodboy: $GB_CLI is gone (the plugin moved or was updated). Run git-hooks install again from the new plugin, or delete this hook." >&2; exit 1; fi',
    'if [ ! -x "$GB_BUN" ]; then GB_BUN=$(command -v bun); fi',
    'if [ -z "$GB_BUN" ]; then echo "goodboy: bun was not found, so the commit scan cannot run. Install bun, or delete this hook." >&2; exit 1; fi',
    `saved="$(dirname "$0")/${name}.goodboy-saved"`,
  ];
  const body: Record<HookName, string[]> = {
    'pre-commit': ['"$GB_BUN" "$GB_CLI" commit-scan --hook pre-commit || exit $?', 'if [ -x "$saved" ]; then exec "$saved" "$@"; fi', 'exit 0'],
    'commit-msg': ['"$GB_BUN" "$GB_CLI" commit-scan --hook commit-msg "$1" || exit $?', 'if [ -x "$saved" ]; then exec "$saved" "$@"; fi', 'exit 0'],
    'pre-push': [
      'refs=$(cat)',
      'printf \'%s\\n\' "$refs" | "$GB_BUN" "$GB_CLI" push-scan --hook pre-push "$@" || exit $?',
      'if [ -x "$saved" ]; then printf \'%s\\n\' "$refs" | "$saved" "$@"; exit $?; fi',
      'exit 0',
    ],
  };
  return `${[...head, ...body[name]].join('\n')}\n`;
}

const isOurs = (p: string): boolean => {
  const r = readRegular(p, 1024 * 1024, true);
  return typeof r === 'object' && r.text.split('\n').slice(0, 5).includes(HOOK_SIGNATURE);
};

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The dir git runs hooks from for the repo at `top` (core.hooksPath honoured), or null. */
function hooksDirOf(top: string): string | null {
  const r = spawnGit(top, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { timeoutMs: 10_000, noMemo: true });
  const out = r.code === 0 ? r.out.trim() : '';
  return out === '' ? null : resolve(top, out);
}

type CliResult = { out: Record<string, unknown>; code: number } | { error: string };

/** `git-hooks install [--force]` and `git-hooks uninstall`, for the repo the shell is in. */
export function gitHooksCommand(args: string[], shell: string, cli: string, bun: string): CliResult {
  const sub = args[0];
  const force = args.includes('--force');
  if ((sub !== 'install' && sub !== 'uninstall') || args.slice(1).some((a) => a !== '--force') || (sub === 'uninstall' && force)) {
    return { error: 'git-hooks: use `git-hooks install [--force]` or `git-hooks uninstall`' };
  }
  const repo = repoOf(shell);
  if (repo === null) return { error: 'git-hooks: the shell is not in a git repository (a bare repository has no work tree to scan)' };
  const dir = hooksDirOf(repo.top);
  if (dir === null) return { error: 'git-hooks: git could not tell the hooks directory' };
  if (sub === 'uninstall') {
    const removed: string[] = [];
    const restored: string[] = [];
    const foreign: string[] = [];
    for (const name of HOOK_NAMES) {
      const target = join(dir, name);
      if (!exists(target)) continue;
      if (!isOurs(target)) {
        foreign.push(name);
        continue;
      }
      unlinkSync(target);
      removed.push(name);
      const saved = `${target}.goodboy-saved`;
      if (exists(saved)) {
        renameSync(saved, target);
        restored.push(name);
      }
    }
    return { out: { ok: true, dir, removed, restored, foreign_left: foreign }, code: 0 };
  }
  // every check runs first: a foreign hook refused (or its saved name taken) stops before anything is written
  const plan: Array<{ name: HookName; target: string; keep: boolean }> = [];
  for (const name of HOOK_NAMES) {
    const target = join(dir, name);
    const has = exists(target);
    const ours = has && isOurs(target);
    if (has && !ours && !force) return { error: `git-hooks: ${target} is a hook goodboy did not write; nothing was changed. Run \`git-hooks install --force\` to keep it as ${name}.goodboy-saved and run it after goodboy's` };
    if (has && !ours && exists(`${target}.goodboy-saved`)) return { error: `git-hooks: ${target}.goodboy-saved already exists, so ${target} cannot be kept there; nothing was changed. Move one of them away` };
    plan.push({ name, target, keep: has && !ours });
  }
  mkdirSync(dir, { recursive: true });
  // Every new hook is written to a temp name first (a write that fails displaces nothing); the renames then go one by one.
  for (const { name, target } of plan) writeFileSync(`${target}.goodboy-tmp-${process.pid}`, hookScript(name, bun, cli), { mode: 0o755 });
  const kept: string[] = [];
  for (const { name, target, keep } of plan) {
    if (keep) {
      renameSync(target, `${target}.goodboy-saved`);
      kept.push(name);
    }
    renameSync(`${target}.goodboy-tmp-${process.pid}`, target);
  }
  return { out: { ok: true, dir, installed: [...HOOK_NAMES], kept_as_saved: kept, note: '`git commit --no-verify` and `git push --no-verify` skip these hooks; run install again after a plugin update' }, code: 0 };
}

function summary(report: ScanReport, realData: boolean): Record<string, unknown> {
  return {
    real_data: realData,
    blocked: report.blocked,
    hits: report.hits.slice(0, 200),
    more_hits: report.moreHits + Math.max(0, report.hits.length - 200),
    unscanned: report.unscanned.slice(0, 200),
    digest: report.digest,
    scanned: report.scanned,
  };
}

/** Whether the user's approval for exactly `digest` is there: a marker file in `<root>/.claude` or `<top>/.claude`
 *  holding it. It is used up. */
function approved(dirs: string[], digest: string): boolean {
  for (const d of new Set(dirs)) {
    let names: string[];
    try {
      names = readdirSync(join(d, '.claude'));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!MARKER_FILE.test(n)) continue;
      const p = join(d, '.claude', n);
      try {
        if (!lstatSync(p).isFile()) continue;
      } catch {
        continue;
      }
      if (markerHoldsDigest(p, digest) && consumeApprovalMarker(p)) return true;
    }
  }
  return false;
}

/** What a git hook prints and exits with after a scan: nothing and 0 when clean or approved; the list and 1 otherwise. */
function hookVerdict(report: ScanReport, what: string, root: string, top: string): { stderr?: string; code: number } {
  if (!report.blocked) return { code: 0 };
  if (approved([root, top], report.digest)) return { code: 0 };
  const dir = join(root, '.claude');
  const marker = join(dir, '.goodboy-commit-scan-approved-hook.txt');
  const tail =
    ` Only the user can approve content that is known to be safe, once: \`mkdir -p ${q(dir)} && echo ${report.digest} > ${q(marker)}\` (bound to this exact content), then run it again.`;
  return { stderr: `${commitScanText(report, what, tail)}\n`, code: 1 };
}

type ScanRun = { out?: Record<string, unknown>; stderr?: string; code: number } | { error: string };

/** `commit-scan [--hook pre-commit|commit-msg <file>]`. By hand it prints the scan and exits 1 only for a real-data
 *  project that has a match or an unscanned file; as a hook it prints nothing unless it stops the commit. */
export function commitScanCommand(args: string[], shell: string): ScanRun {
  const hook = args[0] === '--hook' ? args[1] : undefined;
  if (args.length > 0 && !(args[0] === '--hook' && ((hook === 'pre-commit' && args.length === 2) || (hook === 'commit-msg' && args.length === 3)))) {
    return { error: 'commit-scan: use `commit-scan` or `commit-scan --hook pre-commit|commit-msg <file>`' };
  }
  const repo = repoOf(shell);
  if (repo === null) return hook !== undefined ? { error: 'commit-scan: not in a git repository' } : { error: 'commit-scan: the shell is not in a git repository' };
  const root = realDataRootOf(repo.top);
  if (hook !== undefined && root === null) return { code: 0 };
  const acc = new Acc({ ...DEFAULT_LIMITS, timeMs: HOOK_MS });
  if (hook === 'commit-msg') {
    scanMessageFile(resolve(shell, args[2]!), acc, repo);
    if (identityOverridden()) scanIdentity(repo, acc);
  }
  else scanIndex(repo.top, acc);
  const report = acc.report();
  if (hook === undefined) return { out: summary(report, root !== null), code: root !== null && report.blocked ? 1 : 0 };
  return hookVerdict(report, 'git commit', root!, repo.top);
}

/** `push-scan [<remote> [<refspec>...]]` by hand, `push-scan --hook pre-push <remote> <url>` as the hook (`stdin`: the
 *  refs git gives it). */
export function pushScanCommand(args: string[], shell: string, stdin: string): ScanRun {
  const hook = args[0] === '--hook';
  if (hook && !(args[1] === 'pre-push' && args.length === 4)) return { error: 'push-scan: use `push-scan [<remote> [<refspec>...]]` or `push-scan --hook pre-push <remote> <url>`' };
  const repo = repoOf(shell);
  if (repo === null) return { error: 'push-scan: the shell is not in a git repository' };
  const root = realDataRootOf(repo.top);
  if (hook && root === null) return { code: 0 };
  const acc = new Acc({ ...DEFAULT_LIMITS, timeMs: HOOK_MS });
  const input = hook ? pushInputFromHook(repo.top, args[2]!, stdin) : pushInputOf({ sub: 'push', args, dir: repo.top, globals: [], moved: false, movers: [], at: 0, identity: [], identityComputed: false }).input;
  scanPush(input, acc);
  const report = acc.report();
  if (!hook) return { out: summary(report, root !== null), code: root !== null && report.blocked ? 1 : 0 };
  return hookVerdict(report, 'git push', root!, repo.top);
}
