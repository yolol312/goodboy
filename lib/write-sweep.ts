// Writes the Bash write gate cannot see (track G, write-bypass detection): an interpreter or
// a nested shell that writes a project file (`python3 -c "open('a.ts','w')…"`, `node -e`,
// `sh -c "cat > a.ts"`). Seen live: a subagent edited test files with Python heredocs and none
// of them reached the edit log, so the review and test gates did not ask for them. PostToolUse
// now lists the files git sees changed since the call started and records them as edits.
// Since track I (I1) also for commands that move or copy files into place (`mv`, `cp`, `git
// checkout`…), whose named targets are recorded too (`mv` keeps the old mtime). Limited to
// such commands, so ordinary commands pay no `git status`.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { noteBashStart, openBashCalls, restoreProductionHosts, sweepNewMarkers, takeBashStart } from './approval-marker';
import { bashChangedPaths } from './role-limits';
import { restoreGateState, snapshotGateState } from './state-guard';
import { getCurrentTurn, isGoodboyArtifact, recordEdit } from './file-tracker';
import { hookError, logGate } from './gate-log';
import { spawnGit } from './git-run';
import { commandSegments, gitSubcommandAt } from './outward-command';
import { envStr } from './token-habits';
import { hookLeft } from './hook-clock';
import { MAX_NESTED_REPOS, nestedRepos, type RepoRef } from './nested-repos';
import { projectRoot } from './project-dir';
import { realDeep } from './private-files';
import { knownTops, nearestGitTop } from './start-pins';
import { safeMtime } from './bash-read';
import type { GitStatusSnapshot } from './approval-marker';
import { LOST_RECORD, noteUnswept, readUnswept, replaceUnswept, writeUnswept, type UnsweptCall } from './unswept';

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
    // A call kept open (below) is swept again later from its old start: no unswept record for it (#40).
    const keepOpen = opts.keepAgentsOpen === true && n.agent !== undefined;
    const r = afterBash(sessionId, n.tuid, n.cwd, n.command, n.agent, { skipGit: Date.now() - started > 5_000, gitTimeoutMs: 3_000, keepOpen });
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
  opts: { skipGit?: boolean; gitTimeoutMs?: number; keepOpen?: boolean } = {},
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
    const startCwd = start.cwd ?? resolvePath(cwd);
    const dirs = [...new Set([resolvePath(cwd), startCwd])];
    // (#40) Writes git did not list are kept for the Stop, which tries again and blocks while they stay unlisted (they
    //   were dropped: those writes were in no edit list). A call kept open is swept again from its start instead.
    const keepUnlisted = (stalled: string[]): void => {
      if (opts.keepOpen || typeof command !== 'string') return;
      noteUnswept(sessionId, { tuid: toolUseId ?? '', since: start.since, dirs, startDir: startCwd, command, ...(agentId ? { agent: agentId } : {}), ...(start.status ? { status: start.status } : {}), stalled });
      logGate(sessionId, 'bash-write', 'warn', `unswept: ${stalled.slice(0, 3).join(', ')}`);
    };
    if (sweep && opts.skipGit) {
      swept = false;
      keepUnlisted([startCwd]); // the Stop ran out of its sweep time: the call's writes are unknown, not none
    }
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
      const v = sweepViews(sessionId, dirs, timeoutMs);
      if (!v.complete) swept = false;
      if (v.stalled.length > 0) keepUnlisted(v.stalled);
      const fresh = freshFiles(v.views, start.since, start.status);
      const written = [...new Set([...fresh, ...placedFiles(command, startCwd, v.topOf.get(startCwd) ?? startCwd)])].filter((f) => !sameAsStart(f, start.status));
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

/** git's view of each dir a call's sweep reads, by repo top: the dir's own repo, or for a project dir that is no repo
 *  the repos below it (#39). `complete` is false when part could not be read; `stalled` names what git did not answer
 *  for (#40), apart from a dir that is in no repo or a cap. */
function sweepViews(sessionId: string, dirs: readonly string[], timeoutMs: number): { views: Map<string, string[]>; topOf: Map<string, string>; complete: boolean; stalled: string[] } {
  const topOf = new Map<string, string>();
  const views = new Map<string, string[]>();
  const stalled: string[] = [];
  let complete = true;
  for (const dir of dirs) {
    const s = statusOf(dir, timeoutMs);
    if (s === 'stalled') {
      complete = false;
      stalled.push(dir);
      continue;
    }
    if (!s) {
      // (#39) A project dir that is no repo: each repo below it is swept (within the same git budget).
      const nested = nestedStatus(dir, timeoutMs, sessionId);
      if (nested === null || nested.views.length === 0 || !nested.complete) complete = false;
      stalled.push(...(nested?.stalled ?? []));
      for (const v of nested?.views ?? []) if (!views.has(v.top)) views.set(v.top, v.files);
      continue;
    }
    topOf.set(dir, s.top);
    if (!views.has(s.top)) views.set(s.top, s.files);
  }
  return { views, topOf, complete, stalled: [...new Set(stalled)] };
}

/** The listed files a call wrote: changed at or after `since` by mtime or ctime, or new since the start's status (a
 *  directory moved into place keeps its files' times; the snapshot counts only for its own repo). */
function freshFiles(views: ReadonlyMap<string, readonly string[]>, since: number, status: GitStatusSnapshot | undefined, named: readonly string[] = []): string[] {
  const fresh: string[] = [];
  const underNamed = (f: string): boolean => named.some((n) => f === n || f.startsWith(n.endsWith(sep) ? n : `${n}${sep}`));
  for (const [top, files] of views) {
    const before = status && status.top === top ? new Set(status.files) : null;
    for (const f of files) {
      try {
        const st = statSync(f);
        if (st.isFile() && (Math.max(st.mtimeMs, st.ctimeMs) >= since || (before !== null && !before.has(f)) || underNamed(f))) fresh.push(f);
      } catch {
        // gone
      }
    }
  }
  return fresh;
}

/** (#36) A file the call put back with the content it had at the start is no write of it. */
function sameAsStart(f: string, status: GitStatusSnapshot | undefined): boolean {
  const h = status?.hashes?.[f];
  return h !== undefined && contentHash(f) === h;
}

/** (#40) The Stop's second try at the calls whose writes git could not list (lib/unswept.ts), oldest first, within
 *  `budgetMs` and the hook's clock: what git now lists is recorded as the call's edits (changed since its start), and a
 *  call is kept while git still does not answer for part of it (with what it did list recorded). Returns the calls still
 *  kept. An unreadable record (a FIFO or a link in its place) is removed and stands as one call kept for this Stop. */
export function retryUnswept(sessionId: string, budgetMs: number): UnsweptCall[] {
  const { calls, refused } = readUnswept(sessionId);
  if (refused) {
    writeUnswept(sessionId, []);
    logGate(sessionId, 'bash-write', 'warn', 'unswept record unreadable');
    return [LOST_RECORD];
  }
  if (calls.length === 0) return [];
  const end = Date.now() + Math.min(budgetMs, hookLeft());
  const kept: UnsweptCall[] = [];
  const once: UnsweptCall[] = [];
  const turn = getCurrentTurn(sessionId);
  // Calls in the same dirs share one look (performance review: 100 calls in one repo cleared 11 per Stop).
  const looks = new Map<string, ReturnType<typeof sweepViews>>();
  for (const c of calls) {
    // A lost record (its calls are unknown) blocks this Stop once; nothing can list it later.
    if (c.dirs.length === 0) {
      once.push(c);
      continue;
    }
    const left = end - Date.now();
    if (left <= 0) {
      kept.push(c);
      continue;
    }
    const key = c.dirs.join('\0');
    const v = looks.get(key) ?? sweepViews(sessionId, c.dirs, left);
    looks.set(key, v);
    // With no start status (it stalled too), a directory the command names as a target (`mv <dir> <project>/`) counts
    //   whole: its files keep their old times, and nothing else shows them as new (#40 security review).
    const named = c.status ? [] : bashChangedPaths(c.command, c.startDir ?? c.dirs[c.dirs.length - 1]!);
    const written = freshFiles(v.views, c.since, c.status, named).filter((f) => !sameAsStart(f, c.status));
    for (const f of written) recordEdit(sessionId, f, turn, c.agent, safeMtime(f));
    if (written.length > 0) logGate(sessionId, 'bash-write', 'warn', `indirect-late(${written.length}) ${written.slice(0, 3).join(', ')}`);
    if (v.stalled.length > 0) kept.push({ ...c, stalled: v.stalled });
  }
  // A call another hook appended during the retry stays for the next Stop (#40 delta review); a record unreadable by
  //   now lost what was appended, and this Stop blocks for it.
  const lost = replaceUnswept(sessionId, calls, kept, false);
  return [...once, ...kept, ...(lost ? [LOST_RECORD] : [])];
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

/** The project files (absolute) git sees as modified, added, renamed or untracked, with the
 *  repo top. Ignored files, deletions and goodboy's own artifacts are left out. Null outside a
 *  git repo or when git fails or does not answer. */
export function statusFiles(cwd: string, timeoutMs = 30_000): { top: string; files: string[] } | null {
  const s = statusOf(cwd, timeoutMs);
  return s === 'stalled' ? null : s;
}

/** git's "no repo here, nor in any dir above" (with `LC_ALL=C`), apart from "not a git repository: <path>" (a `.git`
 *  file naming a dir that is gone), which is a repo git cannot read. Also a repo git refuses for its owner
 *  (`safe.directory`): no git call reads it, so no goodboy gate does either; the user lets git read it, not a retry
 *  (#40 delta review: it blocked every Stop with advice on FIFOs). A model's command cannot make a repo read so: it
 *  takes another owner (root) or the hook's environment, and `safe.directory` is not read from the repo's config. */
const NO_REPO_ABOVE = /not a git repository \(or any (?:of the parent directories|parent up to mount point)|detected dubious ownership in repository/;

/** The first `.git` part of absolute `p` that is a git dir (it has a `HEAD`): `gitDir`, up to and with it, and the dir
 *  that holds it (`owner`). Null when `p` has none. A dir named `.git` with no `HEAD` is passed over: a repo can sit
 *  under one (`<base>/.git/proj`), and it was swept as `<base>`, no repo (v0.36.15 review, low). */
function gitPart(p: string): { owner: string; gitDir: string } | null {
  const parts = p.split(sep);
  for (let i = 1; i < parts.length; i++) {
    if (!/^\.git$/i.test(parts[i]!)) continue;
    const gitDir = parts.slice(0, i + 1).join(sep);
    if (existsSync(join(gitDir, 'HEAD'))) return { owner: parts.slice(0, i).join(sep) || sep, gitDir };
  }
  return null;
}

/** The work tree dir that holds the git dir `p` is in (`<top>/.git/hooks` → `<top>`), or null when `p` is in none.
 *  Judged on the real path: a link spelled `.git` that leads into the project is no git dir (confirm review: the
 *  sweep went to the link's dir, no repo, and a write in the project went unlisted). In `p`'s own spelling when that
 *  names the same dir (the edit log keeps cwd's spelling). The owner holds no git dir part before the one taken, so a
 *  caller that recurses on it stops there. */
function gitDirOwner(p: string): string | null {
  const real = gitPart(realDeep(p));
  if (real === null) return null;
  const spelled = gitPart(resolvePath(p));
  return spelled !== null && realDeep(spelled.owner) === real.owner ? spelled.owner : real.owner;
}

/** `statusFiles`, telling a dir that is in no repo (null: git said so, or the dir is gone) from a repo whose changes
 *  git did not list ('stalled', #40): it was cut off at its limit, killed, refused for no time left on the hook's clock,
 *  or failed (a corrupt index, a `.git` file naming a missing dir, no work tree). Only 'stalled' leaves a sweep's writes
 *  unknown; a fast failure read as "no repo" let them pass unlisted (#40 security review). A dir inside `.git/` is
 *  swept as the work tree that holds it: git has no work tree there, and a shell left in `.git/` writes the files
 *  around it (#40 delta review). */
export function statusOf(cwd: string, timeoutMs = 30_000): { top: string; files: string[] } | 'stalled' | null {
  const owner = gitDirOwner(cwd);
  if (owner !== null) return statusOf(owner, timeoutMs);
  if (!existsSync(cwd)) return null;
  // The top in cwd's own spelling (`--show-cdup`), not git's real path: on macOS /var is
  //   /private/var, and the edit log must match the paths the Stop gates compare with cwd.
  //   The plain call is the one a Stop's snapshot memoizes; only a failure is asked again in English, to read why.
  let cdup = spawnGit(cwd, ['rev-parse', '--show-cdup'], { timeoutMs, noOptionalLocks: true });
  if (!cdup.stalled && cdup.code !== 0) cdup = spawnGit(cwd, ['rev-parse', '--show-cdup'], { timeoutMs, noOptionalLocks: true, cLocale: true });
  if (cdup.stalled) return 'stalled';
  if (cdup.code !== 0) return cdup.ran && NO_REPO_ABOVE.test(cdup.err) ? null : 'stalled';
  const top = resolvePath(cwd, cdup.out.trim() || '.');
  // Every filter driver is emptied for `status` (it runs a clean filter to hash a touched file:
  //   final G1 test round; lib/git-run.ts). The sweep only needs names, so a filtered file
  //   reading as changed is fine. A `.git` git cannot read in an untracked dir (a FIFO HEAD) stalls this call (#40).
  //   No optional locks: a `status` refresh must not hold the user's index.lock while a parallel `git add` runs
  //   (performance review, 71 of 112 concurrent adds failed). Every failure here leaves the changes unlisted.
  const st = spawnGit(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs, noOptionalLocks: true });
  // A `status` that fails for want of a work tree stays 'stalled' too: one `git config core.bare true` gives a project
  //   repo that answer, and a write between it and `core.bare false` went unlisted when it read as no repo (#40 confirm
  //   review, high). A bare repo's own dir with its worktrees beside it blocks then as well (plan §15.31, known limits).
  if (st.stalled || st.code !== 0) return 'stalled';
  const parts = st.out.split('\0');
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
 *  the walk hit a cap or the time ran out before every repo was read (the sweep then did not run in full). `stalled`
 *  (#40) names what git did not answer for: a repo whose status did not answer or that the time left unread, a dir
 *  the walk could not confirm, or `root` itself when the time ran out before the walk (its other repos are unknown).
 *  A cap is no stall (a known limit, plan §15.30). Null when `dir` is not in a project dir of that kind. */
export function nestedStatus(dir: string, timeoutMs: number, sessionId?: string): { views: { top: string; files: string[] }[]; complete: boolean; stalled: string[] } | null {
  const root = projectRoot(dir);
  if (nearestGitTop(root) !== null) return null;
  // The walk counts against the same time, and nothing runs past the hook's clock (a hook killed here records no
  //   write; the walk's confirmations are bounded by lib/nested-repos.ts, the statuses by `end`).
  const end = Date.now() + Math.min(timeoutMs, hookLeft());
  const views: { top: string; files: string[] }[] = [];
  const stalled: string[] = [];
  const read = new Set<string>();
  let complete = true;
  const sweep = (repos: readonly RepoRef[]): void => {
    for (const repo of repos) {
      if (read.has(repo.realTop)) continue;
      if (read.size >= MAX_NESTED_REPOS) {
        complete = false;
        return;
      }
      read.add(repo.realTop);
      const left = end - Date.now();
      const s = left > 0 ? statusOf(repo.top, left) : 'stalled';
      if (s === 'stalled') stalled.push(repo.top);
      if (s === 'stalled' || s === null) complete = false;
      else views.push(s);
    }
  };
  // The known repos are read before the walk: planted `.git` dirs git cannot answer for cost the walk its time
  //   (delta review: with a 3 s budget, the walk alone used it up), never the repos the session started with.
  sweep(sweepOrder(root, [], sessionId));
  if (end - Date.now() <= 0) return { views, complete: false, stalled: [...stalled, resolvePath(root)] };
  const found = walkOnce(root);
  if (found.capped) complete = false;
  if (found.unanswered.length > 0) {
    complete = false;
    stalled.push(...found.unanswered);
  }
  sweep(sweepOrder(root, found.repos));
  return { views, complete, stalled };
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
