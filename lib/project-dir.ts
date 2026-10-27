// The project dir the gates read their records and scopes from (I10, from the fourth real-use
// trial). Claude Code hands the hooks the shell's current dir as `cwd`, and that dir follows a
// model's `cd` inside the project. Measured on 2.1.306: after `cd sub`, PreToolUse and Stop get
// `<project>/sub`, while CLAUDE_PROJECT_DIR stays `<project>`. A Stop run from the subdir
// counted only the edits below it, so a change elsewhere passed with no test or review.

import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureSessionDir, sessionDir } from './file-tracker';
import { spawnGit } from './git-run';
import { isUnder, isDir, realDeep } from './private-files';
import { readRegular } from './safe-read';

const PROJECT_FILE = 'project-dir.txt';

/** CLAUDE_PROJECT_DIR when the hook's `cwd` is that dir or inside it (by path, or through
 *  links); else `cwd`: a dir elsewhere, a test, or a CLI without the variable. A worktree of
 *  the project's repository nested inside it is its own project: Claude Code's agent worktrees
 *  under `.claude/worktrees/<name>` (I10 review), and since #21 one anywhere else that existed
 *  when the session started (a field report: a version's worktree in a dot-folder of the
 *  project was read as the main checkout, with the other version's criteria and records; the
 *  session's id names the note, pinWorktrees). The nearest such dir above `cwd` counts only
 *  when git says it is a work tree's top sharing the project's repository and listed among its
 *  worktrees: a submodule, a nested clone or a `.git` a model made to narrow the gates' scope
 *  (review 2: `docs/sub/.git`) stays part of the project.
 *  Only for what belongs to the project (records, edit scope, state, approval markers); a
 *  relative path in a Bash command still resolves from `cwd`, where the shell runs it. */
export function projectDir(cwd: string, env: NodeJS.ProcessEnv = process.env, sessionId?: string): string {
  const p = (env.CLAUDE_PROJECT_DIR ?? '').trim();
  if (p === '' || !isAbsolute(p)) return cwd;
  const dir = resolve(p);
  if (dir === sep || !isUnder(cwd, dir)) return cwd;
  const parts = relative(realDeep(dir), realDeep(resolve(cwd))).split(sep).filter((s) => s !== '');
  // Elsewhere than `.claude/worktrees`, only a worktree that existed when the session started
  //   (#21 security review: one a model adds mid-session and cds into would drop the main
  //   checkout's edits from the gates' scope and lift the role limits there).
  const pinned = parts[0] === '.claude' && parts[1] === 'worktrees' ? null : pinnedWorktrees(sessionId);
  // Nearest first: a worktree inside a worktree's folder is the inner one.
  for (let n = parts.length; n > 0; n--) {
    const wt = join(dir, ...parts.slice(0, n));
    if (pinned !== null && !pinned.has(realDeep(wt))) continue;
    // A linked worktree's `.git` is a file; a directory there is a nested clone (no git call).
    if (isGitFile(join(wt, '.git')) && sharesRepo(wt, dir)) return wt;
  }
  return dir;
}

function isGitFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

const WORKTREES_FILE = 'worktrees.txt';

/** The worktrees SessionStart noted for the session; empty with no session or no note. */
function pinnedWorktrees(sessionId: string | undefined): Set<string> {
  if (!sessionId) return new Set();
  const r = readRegular(join(sessionDir(sessionId), WORKTREES_FILE), 256 * 1024, true);
  return new Set(typeof r === 'object' ? r.text.split('\n').filter((l) => isAbsolute(l)) : []);
}

/** SessionStart: notes the project repository's worktrees as they are now, kept for a resumed
 *  session. Best-effort; only with CLAUDE_PROJECT_DIR. */
export function pinWorktrees(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  const p = (env.CLAUDE_PROJECT_DIR ?? '').trim();
  if (p === '' || !isAbsolute(p)) return;
  try {
    const dir = ensureSessionDir(sessionId);
    if (existsSync(join(dir, WORKTREES_FILE))) return;
    const r = spawnGit(resolve(p), ['worktree', 'list', '--porcelain']);
    if (r.code !== 0) return;
    const list = r.out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => realDeep(l.slice('worktree '.length)));
    const tmp = join(dir, `.${WORKTREES_FILE}.${process.pid}.tmp`);
    rmSync(tmp, { force: true });
    writeFileSync(tmp, list.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(dir, WORKTREES_FILE));
  } catch {
    // best-effort: no note, no nested worktree outside .claude/worktrees counts
  }
}

/** Whether `wt` is a worktree of the repository at `dir`: git takes `wt` as a work tree's top
 *  (an invalid `.git` there makes git find the project's repo above it instead), its common
 *  git dir is `dir`'s, and the repository lists it as one of its worktrees (#21 review: a
 *  `.git` file pointing at the project's own git dir passed the first two). */
function sharesRepo(wt: string, dir: string): boolean {
  if (!existsSync(join(wt, '.git'))) return false;
  // With no git on PATH nothing runs (code -1): then it is no worktree, and the hook goes on (review).
  const git = (d: string, args: string[]) => spawnGit(d, args);
  const ask = (d: string): [string, string] | null => {
    const r = git(d, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    const lines = r.out.trim().split('\n');
    return r.code === 0 && lines.length === 2 ? [realDeep(lines[0]!), realDeep(lines[1]!)] : null;
  };
  const a = ask(wt);
  const b = ask(dir);
  if (a === null || b === null || a[0] !== realDeep(wt) || a[1] !== b[1] || a[0] === b[0]) return false;
  const list = git(dir, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) return false;
  return list.out
    .split('\n')
    .some((l) => l.startsWith('worktree ') && realDeep(l.slice('worktree '.length)) === a[0]);
}

/** Notes the session's project dir for the goodboy CLI. The hooks get CLAUDE_PROJECT_DIR; the
 *  Bash tool's environment, where agents run `cli.ts test-write`, `review-write` and
 *  `regression`, has only CLAUDE_CODE_SESSION_ID (I10 review: records written from a subdir
 *  landed where Stop no longer looks). Best-effort; only when the variable is set. */
export function noteProjectDir(sessionId: string, env: NodeJS.ProcessEnv = process.env): void {
  const p = (env.CLAUDE_PROJECT_DIR ?? '').trim();
  if (p === '' || !isAbsolute(p)) return;
  try {
    // Never through a link: a new file created exclusively, then renamed over the name (a
    //   rename replaces a link itself, not what it points to; error-path review).
    const dir = ensureSessionDir(sessionId);
    const tmp = join(dir, `.${PROJECT_FILE}.${process.pid}.tmp`);
    rmSync(tmp, { force: true });
    writeFileSync(tmp, resolve(p) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(dir, PROJECT_FILE));
  } catch {
    // best-effort: the CLI then uses its own cwd, as before
  }
}

/** The project dir for the goodboy CLI: CLAUDE_PROJECT_DIR when set; else the one the hooks
 *  noted for CLAUDE_CODE_SESSION_ID; with the same rules as projectDir (the cwd must be inside
 *  it; a nested work tree is its own project). Otherwise the cwd. */
export function cliProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const sid = (env.CLAUDE_CODE_SESSION_ID ?? '').trim() || undefined;
  if ((env.CLAUDE_PROJECT_DIR ?? '').trim() !== '') return projectDir(cwd, env, sid);
  if (sid === undefined) return cwd;
  const r = readRegular(join(sessionDir(sid), PROJECT_FILE), 4096, true);
  const noted = typeof r === 'object' ? r.text.trim() : '';
  return noted !== '' && isAbsolute(noted) && isDir(noted) ? projectDir(cwd, { CLAUDE_PROJECT_DIR: noted }, sid) : cwd;
}
