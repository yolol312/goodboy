// The project dir the gates read their records and scopes from (I10, from the fourth real-use
// trial). Claude Code hands the hooks the shell's current dir as `cwd`, and that dir follows a
// model's `cd` inside the project. Measured on 2.1.306: after `cd sub`, PreToolUse and Stop get
// `<project>/sub`, while CLAUDE_PROJECT_DIR stays `<project>`. A Stop run from the subdir
// counted only the edits below it, so a change elsewhere passed with no test or review.

import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureSessionDir, sessionDir } from './file-tracker';
import { linkedWorktreeOf } from './git-dirs';
import { isUnder, isDir, realDeep } from './private-files';
import { readRegular } from './safe-read';

const PROJECT_FILE = 'project-dir.txt';

/** CLAUDE_PROJECT_DIR when the hook's `cwd` is that dir or inside it (by path, or through
 *  links); else `cwd`: a dir elsewhere, a test, or a CLI without the variable. The enclosing
 *  project dir, before any nested worktree is taken apart (projectDir). */
export function projectRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const p = (env.CLAUDE_PROJECT_DIR ?? '').trim();
  if (p === '' || !isAbsolute(p)) return cwd;
  const dir = resolve(p);
  return dir === sep || !isUnder(cwd, dir) ? cwd : dir;
}

/** The project dir the gates use for `cwd`: projectRoot, or the nearest linked worktree of the
 *  project's repository nested in it that holds `cwd`. Claude Code's agent worktrees under
 *  `.claude/worktrees/<name>` (I10 review), and since #35 one anywhere else, whenever it was made
 *  (#21 took only those that existed when the session started, so a worktree made mid-session in a
 *  dot-folder was judged with the main checkout's start and blocked). Leaving the main checkout's
 *  edits behind by a `cd` into one (#21 security review) is closed in the Stop: it blocks on edits
 *  another checkout of the project has not had verified (hooks/stop.ts, otherCheckouts). What a
 *  linked worktree is comes from `linkedWorktreeOf` (lib/git-dirs.ts), the rule the edit scope uses
 *  too: a submodule, a nested clone or a `.git` a model made to narrow the gates' scope (review 2:
 *  `docs/sub/.git`) stays part of the project.
 *  Only for what belongs to the project (records, edit scope, state, approval markers); a
 *  relative path in a Bash command still resolves from `cwd`, where the shell runs it. */
export function projectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = projectRoot(cwd, env);
  if (dir === cwd) return cwd;
  const parts = relative(realDeep(dir), realDeep(resolve(cwd))).split(sep).filter((s) => s !== '');
  // Nearest first: a worktree inside a worktree's folder is the inner one.
  for (let n = parts.length; n > 0; n--) {
    const wt = join(dir, ...parts.slice(0, n));
    if (linkedWorktreeOf(wt, dir)) return wt;
  }
  return dir;
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
  if ((env.CLAUDE_PROJECT_DIR ?? '').trim() !== '') return projectDir(cwd, env);
  if (sid === undefined) return cwd;
  const r = readRegular(join(sessionDir(sid), PROJECT_FILE), 4096, true);
  const noted = typeof r === 'object' ? r.text.trim() : '';
  return noted !== '' && isAbsolute(noted) && isDir(noted) ? projectDir(cwd, { CLAUDE_PROJECT_DIR: noted }) : cwd;
}
