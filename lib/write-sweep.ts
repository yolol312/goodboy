// Writes the Bash write gate cannot see (track G, write-bypass detection): an interpreter or
// a nested shell that writes a project file (`python3 -c "open('a.ts','w')…"`, `node -e`,
// `sh -c "cat > a.ts"`). Seen live: a subagent edited test files with Python heredocs and none
// of them reached the edit log, so the review and test gates did not ask for them. PostToolUse
// now lists the files git sees changed since the call started and records them as edits.
// Since track I (I1) also for commands that move or copy files into place (`mv`, `cp`, `git
// checkout`…), whose named targets are recorded too (`mv` keeps the old mtime). Limited to
// such commands, so ordinary commands pay no `git status`.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { noteBashStart, openBashCalls, restoreProductionHosts, sweepNewMarkers, takeBashStart } from './approval-marker';
import { bashChangedPaths } from './role-limits';
import { restoreGateState, snapshotGateState } from './state-guard';
import { getCurrentTurn, isGoodboyArtifact, recordEdit } from './file-tracker';
import { hookError, logGate } from './gate-log';
import { gitOut } from './git-run';
import { commandSegments, gitSubcommandAt } from './outward-command';
import { envStr } from './token-habits';
import { hookLeft } from './hook-clock';
import { MAX_NESTED_REPOS, nestedRepos, type RepoRef } from './nested-repos';
import { projectRoot } from './project-dir';
import { realDeep } from './private-files';
import { knownTops, nearestGitTop } from './start-pins';
import { safeMtime } from './bash-read';

/** At Stop: finishes the session's Bash calls that never reported back (`exit N` fires no post
 *  hook, G0 M18) as their post hook would have: markers swept, hosts restored, indirect writes
 *  recorded, gate state put back. Runs before the gates read anything.
 *  `keepAgentsOpen` (a subagent still runs): an agent's call may still be running, not ended.
 *  Finished here, its late post hook found no start note and recorded every file changed in
 *  the last five minutes as its edits, and nothing watched what it did after the Stop (#14).
 *  So after finishing it, the Stop notes it again as a call that starts now (from its old
 *  start when this Stop could not sweep its writes), with a fresh gate state snapshot: its
 *  post hook, the next Stop, or its agent's SubagentStop finishes it.
 *  `agent` (SubagentStop): only that agent's calls, which have all ended. */
export function finishOpenBashCalls(sessionId: string, opts: { keepAgentsOpen?: boolean; agent?: string } = {}): { context?: string; notice?: string } {
  const contexts: string[] = [];
  const notices: string[] = [];
  // The Stop has 15 s (security review round 3: three open calls with a slow fsmonitor took
  //   18 s, and a timed-out Stop blocks nothing). After 5 s the git-based write sweep is
  //   skipped; the file restores are cheap and always run.
  const started = Date.now();
  const open = openBashCalls(sessionId).filter((n) => opts.agent === undefined || n.agent === opts.agent);
  for (const n of open.slice(-20)) {
    if (!n.tuid) continue;
    const at = Date.now();
    const r = afterBash(sessionId, n.tuid, n.cwd, n.command, n.agent, { skipGit: Date.now() - started > 5_000, gitTimeoutMs: 3_000 });
    if (r.context) contexts.push(r.context);
    if (r.notice) notices.push(r.notice);
    if (opts.keepAgentsOpen && n.agent) {
      noteBashStart(sessionId, n.tuid, n.cwd, n.command, n.agent, undefined, r.swept === false ? n.t : at);
      snapshotGateState(sessionId, n.tuid);
    }
  }
  return { ...(contexts.length > 0 ? { context: contexts.join('\n') } : {}), ...(notices.length > 0 ? { notice: notices.join('\n') } : {}) };
}

/** What goodboy does after a model Bash call, from PostToolUse or PostToolUseFailure (a
 *  failing command fires only the latter, G0 M18): remove this session's approval markers
 *  the call created, and record project files it wrote indirectly as edits. Returns the note
 *  for the model and the notice for the user. Never throws. */
export function afterBash(
  sessionId: string,
  toolUseId: string | undefined,
  cwd: string,
  command: unknown,
  agentId: string | undefined,
  opts: { skipGit?: boolean; gitTimeoutMs?: number } = {},
): { context?: string; notice?: string; swept?: false } {
  const notes: string[] = [];
  const notices: string[] = [];
  // Whether the indirect-write sweep this call needs ran in full (none needed counts); the
  //   result says `swept: false` only when it did not.
  let swept = true;
  try {
    const start = takeBashStart(sessionId, toolUseId, cwd);
    const stateRestored = restoreGateState(sessionId, toolUseId);
    if (stateRestored.length > 0) {
      logGate(sessionId, 'state-guard', 'deny', `restored ${stateRestored.join(', ')}`);
      notes.push(
        `goodboy put back its gate state that this command changed (${stateRestored.join(', ')}). ` +
          'The gates decide from it; satisfy the gate instead.',
      );
      notices.push(`[goodboy] 명령이 바꾼 goodboy 게이트 상태를 되돌렸어요: ${stateRestored.join(', ')}`);
    }
    if (envStr('GOODBOY_MARKER_GUARD', 'on') !== 'off') {
      const removed = sweepNewMarkers(sessionId, start);
      if (removed.length > 0) {
        logGate(sessionId, 'marker-guard', 'deny', `removed ${removed.join(', ')}`);
        notes.push(
          `goodboy removed approval markers this command created (${removed.join(', ')}). ` +
            'Only the user creates approval markers; ask the user instead.',
        );
        notices.push(`[goodboy] 모델이 만든 승인 마커를 지웠어요: ${removed.join(', ')}`);
      }
    }
    if (envStr('GOODBOY_OUTWARD_GATE', 'on') !== 'off') {
      const restored = restoreProductionHosts(start);
      if (restored.length > 0) {
        logGate(sessionId, 'outward', 'deny', `hosts restored ${restored.join(', ')}`);
        notes.push(
          `goodboy put back production entries this command removed from .goodboy/hosts (${restored.join('; ')}). ` +
            'Only the user removes a production host (stop rule R2).',
        );
        notices.push(`[goodboy] .goodboy/hosts에서 지워진 production 항목을 되돌렸어요: ${restored.join(', ')}`);
      }
    }
    const sweep = envStr('GOODBOY_BASH_WRITE_GATE', 'deny') !== 'off' && typeof command === 'string' && writesIndirectly(command);
    if (sweep && opts.skipGit) swept = false;
    if (sweep && !opts.skipGit && typeof command === 'string') {
      // PostToolUse has 60 s and PostToolUseFailure 15 s; the Stop path (opts.gitTimeoutMs) less.
      //   Three signals: files changed since the start by mtime or ctime; paths new in git's
      //   status since the PreToolUse snapshot (a directory moved into place keeps its files'
      //   times); and the targets the command names. Both repos are swept: the one the call
      //   started in and the one its shell ended in (`cd <elsewhere> && mv x <start repo>/…`,
      //   I1 review round 7). The snapshot counts only for its own repo: the other repo's
      //   uncommitted files are not this call's writes (round 6). The named targets are read
      //   from the start cwd, as the command's own `cd`s apply from there.
      const timeoutMs = opts.gitTimeoutMs ?? 12_000;
      const startCwd = start.cwd ?? resolvePath(cwd);
      const topOf = new Map<string, string>();
      const views = new Map<string, string[]>();
      for (const dir of new Set([resolvePath(cwd), startCwd])) {
        const s = statusFiles(dir, timeoutMs);
        if (!s) {
          // (#39) A project dir that is no repo: each repo below it is swept (within the same git budget).
          const nested = nestedStatus(dir, timeoutMs, sessionId);
          if (nested === null || nested.views.length === 0 || !nested.complete) swept = false;
          for (const v of nested?.views ?? []) if (!views.has(v.top)) views.set(v.top, v.files);
          continue;
        }
        topOf.set(dir, s.top);
        if (!views.has(s.top)) views.set(s.top, s.files);
      }
      const fresh: string[] = [];
      for (const [top, files] of views) {
        const before = start.status && start.status.top === top ? new Set(start.status.files) : null;
        for (const f of files) {
          try {
            const st = statSync(f);
            if (st.isFile() && (Math.max(st.mtimeMs, st.ctimeMs) >= start.since || (before !== null && !before.has(f)))) fresh.push(f);
          } catch {
            // gone
          }
        }
      }
      // (#36) A file the call put back with the content it had at the start is no write of it.
      const same = (f: string): boolean => {
        const h = start.status?.hashes?.[f];
        return h !== undefined && contentHash(f) === h;
      };
      const written = [...new Set([...fresh, ...placedFiles(command, startCwd, topOf.get(startCwd) ?? startCwd)])].filter((f) => !same(f));
      if (written.length > 0) {
        const turn = getCurrentTurn(sessionId);
        for (const f of written) recordEdit(sessionId, f, turn, agentId, safeMtime(f));
        logGate(sessionId, 'bash-write', 'warn', `indirect(${written.length}) ${written.slice(0, 3).join(', ')}`);
        notes.push(
          `This command wrote project files outside Edit/Write: ${written.slice(0, 5).join(', ')}` +
            `${written.length > 5 ? ` and ${written.length - 5} more` : ''}. They are recorded as edits and need review and tests like any other; use Edit/Write for project files.`,
        );
      }
    }
  } catch (err) {
    swept = false;
    hookError(sessionId, 'after-bash', 'sweep error', err);
  }
  return { ...(notes.length > 0 ? { context: notes.join('\n') } : {}), ...(notices.length > 0 ? { notice: notices.join('\n') } : {}), ...(swept ? {} : { swept: false as const }) };
}

const INTERPRETERS = /^(?:python[0-9.]*|node|perl|ruby|php|deno|tsx|ts-node|osascript|xargs|g?awk|parallel)$/;
/** Programs that move or copy files into place (I1 security review: `mv a.ts b.ts` after a
 *  test record put unrun code in a file no edit recorded). */
const FILE_PLACERS = new Set(['mv', 'cp', 'ln', 'install', 'rsync', 'patch', 'tar', 'unzip', 'ditto']);
const GIT_PLACING = new Set(['mv', 'checkout', 'restore', 'apply', 'am', 'cherry-pick', 'merge', 'pull', 'rebase', 'reset', 'revert', 'stash', 'switch', 'checkout-index', 'read-tree']);

/** True when a shell command runs, in command position, a program that can write files the
 *  write gate cannot read: an interpreter, `xargs`/`awk`, `bun -e|run`, `sh -c`, `find -exec`,
 *  or one that moves or copies files into place (`mv`, `cp`, `git checkout`…). */
export function writesIndirectly(command: string): boolean {
  for (const words of commandSegments(command)) {
    const prog = (words[0] ?? '').split('/').pop() ?? '';
    if (INTERPRETERS.test(prog) || FILE_PLACERS.has(prog)) return true;
    if (prog === 'git' && GIT_PLACING.has(words[gitSubcommandAt(words)] ?? '')) return true;
    if (prog === 'bun' && ['-e', '--eval', 'run', 'x'].includes(words[1] ?? '')) return true;
    if (/^(?:ba|z|da|k)?sh$/.test(prog) && words.includes('-c')) return true;
    if (prog === 'find' && words.some((w) => w === '-exec' || w === '-execdir')) return true;
  }
  return false;
}

/** The project files a `mv`/`cp`/`ln`/`install` names as its targets that exist after it
 *  (absolute; inside the repo `top`, not under `.git`). A directory target is left to the
 *  status snapshot (the files it holds are new paths there). */
export function placedFiles(command: string, cwd: string, top: string = cwd): string[] {
  const out: string[] = [];
  for (const p of bashChangedPaths(command, cwd)) {
    const r = relative(resolvePath(top), p);
    if (r === '' || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r) || r === '.git' || r.startsWith(`.git${sep}`)) continue;
    try {
      if (statSync(p).isFile()) out.push(p);
    } catch {
      // gone (the source of a move)
    }
  }
  return out;
}

/** git without optional locks (a `status` refresh must not hold the user's index.lock while a
 *  parallel `git add` runs: performance review, 71 of 112 concurrent adds failed) and with a
 *  time limit below the post hooks' timeouts. It starts no program from the repo's config
 *  (lib/git-run.ts). */
function git(cwd: string, args: string[], timeoutMs: number): string | null {
  return gitOut(cwd, args, { timeoutMs, noOptionalLocks: true });
}

/** The project files (absolute) git sees as modified, added, renamed or untracked, with the
 *  repo top. Ignored files, deletions and goodboy's own artifacts are left out. Null outside a
 *  git repo or when git fails. */
export function statusFiles(cwd: string, timeoutMs = 30_000): { top: string; files: string[] } | null {
  // The top in cwd's own spelling (`--show-cdup`), not git's real path: on macOS /var is
  //   /private/var, and the edit log must match the paths the Stop gates compare with cwd.
  const cdup = git(cwd, ['rev-parse', '--show-cdup'], timeoutMs);
  if (cdup === null) return null;
  const top = resolvePath(cwd, cdup.trim() || '.');
  // Every filter driver is emptied for `status` (it runs a clean filter to hash a touched file:
  //   final G1 test round; lib/git-run.ts). The sweep only needs names, so a filtered file
  //   reading as changed is fine.
  const out = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs);
  if (out === null) return null;
  const parts = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++; // the next part is the original path
    if (xy.includes('D')) continue;
    const abs = join(top, entry.slice(3));
    if (!isGoodboyArtifact(abs)) files.push(abs);
  }
  return { top, files };
}

/** (#39, item 3) One walk down per project dir per hook process: the call's dir and the shell's start dir ask for the
 *  same root, and the walk is the costly part (a stat per dir, a git call per `.git`). */
const walks = new Map<string, ReturnType<typeof nestedRepos>>();
function walkOnce(root: string): ReturnType<typeof nestedRepos> {
  let w = walks.get(root);
  if (w === undefined) {
    w = nestedRepos(root);
    walks.set(root, w);
  }
  return w;
}

/** Forgets the walks (the unit tests share one process; a hook is one). */
export function resetWriteSweep(): void {
  walks.clear();
}

/** The repos to sweep, in order: the ones the session already knows (a start pin or a tip snapshot names them),
 *  then the walk's other repos, each once by its real top. The walk is capped at 64 repos in sorted order, so a
 *  crowd of repos made later (`a000`..`a063`) could drop a real one; the known ones are never dropped. A repo
 *  made mid-session behind 64 others can still miss the sweep (plan §15.30, known limits). */
function sweepOrder(root: string, walked: readonly RepoRef[], sessionId?: string): RepoRef[] {
  const spelledRoot = resolvePath(root);
  const realRoot = realDeep(root);
  const out: RepoRef[] = [];
  const seen = new Set<string>();
  const add = (ref: RepoRef): void => {
    if (seen.has(ref.realTop)) return;
    seen.add(ref.realTop);
    out.push(ref);
  };
  for (const real of sessionId === undefined ? [] : knownTops(sessionId)) {
    const rel = relative(realRoot, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue; // the project dir itself or outside it
    try {
      lstatSync(join(real, '.git')); // a pin of a repo since removed is no repo to sweep (it would read as an incomplete sweep)
    } catch {
      continue;
    }
    add({ top: join(spelledRoot, rel), realTop: real });
  }
  for (const ref of walked) add(ref);
  return out;
}

/** (#39) git's status per repo below the project dir, for a call that ran in a project dir that is no repo (`dir`
 *  is in no repo, so `statusFiles(dir)` has nothing to say): the repos the session knows first, then every other repo
 *  `nestedRepos` finds, one `statusFiles` each, at most 64, all within `timeoutMs` in all. `complete` is false when
 *  the walk hit a cap or the time ran out before every repo was read (the sweep then did not run in full). Null when
 *  `dir` is not in a project dir of that kind. */
export function nestedStatus(dir: string, timeoutMs: number, sessionId?: string): { views: { top: string; files: string[] }[]; complete: boolean } | null {
  const root = projectRoot(dir);
  if (nearestGitTop(root) !== null) return null;
  // The walk counts against the same time, and nothing runs past the hook's clock (a hook killed here records no
  //   write; the walk's confirmations are bounded by lib/nested-repos.ts, the statuses by `end`).
  const end = Date.now() + Math.min(timeoutMs, hookLeft());
  const views: { top: string; files: string[] }[] = [];
  const read = new Set<string>();
  let complete = true;
  const sweep = (repos: readonly RepoRef[]): void => {
    for (const repo of repos) {
      if (read.has(repo.realTop)) continue;
      const left = end - Date.now();
      if (read.size >= MAX_NESTED_REPOS || left <= 0) {
        complete = false;
        return;
      }
      read.add(repo.realTop);
      const s = statusFiles(repo.top, left);
      if (s === null) complete = false;
      else views.push(s);
    }
  };
  // The known repos are read before the walk: planted `.git` dirs git cannot answer for cost the walk its time
  //   (delta review: with a 3 s budget, the walk alone used it up), never the repos the session started with.
  sweep(sweepOrder(root, [], sessionId));
  if (end - Date.now() <= 0) return { views, complete: false };
  const found = walkOnce(root);
  if (found.capped) complete = false;
  sweep(sweepOrder(root, found.repos));
  return { views, complete };
}

/** Hashes of the content of up to 500 files of at most 1 MB each: the rest are left out, so
 *  they count as written when their times change (fails closed). */
const MAX_HASHED_FILES = 500;
const MAX_HASHED_BYTES = 1_000_000;

export function contentHash(file: string): string | null {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_HASHED_BYTES) return null;
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** (#36) The status snapshot with the content hashes of its files, for the post hook. */
export function withContentHashes(status: { top: string; files: string[] }): { top: string; files: string[]; hashes: Record<string, string> } {
  const hashes: Record<string, string> = {};
  for (const f of status.files.slice(0, MAX_HASHED_FILES)) {
    const h = contentHash(f);
    if (h !== null) hashes[f] = h;
  }
  return { ...status, hashes };
}

/** Project files (absolute paths) that git sees as modified or untracked and that changed at
 *  or after `sinceMs`: modified or, by ctime, renamed, copied with their times (`mv`, `cp -p`,
 *  `git mv`, an interpreter's rename keep the mtime; I1 security review). Ignored files,
 *  deletions and goodboy's own artifacts are left out. Empty outside a git repo. */
export function changedFilesSince(cwd: string, sinceMs: number, timeoutMs = 30_000): string[] {
  const files: string[] = [];
  for (const abs of statusFiles(cwd, timeoutMs)?.files ?? []) {
    try {
      const st = statSync(abs);
      if (st.isFile() && Math.max(st.mtimeMs, st.ctimeMs) >= sinceMs) files.push(abs);
    } catch {
      // gone meanwhile
    }
  }
  return files;
}
