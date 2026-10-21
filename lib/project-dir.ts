// The project dir the gates read their records and scopes from (I10, from the fourth real-use
// trial). Claude Code hands the hooks the shell's current dir as `cwd`, and that dir follows a
// model's `cd` inside the project. Measured on 2.1.306: after `cd sub`, PreToolUse and Stop get
// `<project>/sub`, while CLAUDE_PROJECT_DIR stays `<project>`. A Stop run from the subdir
// counted only the edits below it, so a change elsewhere passed with no test or review.

import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ensureSessionDir, sessionDir } from './file-tracker';
import { isUnder, isDir, realDeep } from './private-files';
import { readRegular } from './safe-read';

const PROJECT_FILE = 'project-dir.txt';

/** CLAUDE_PROJECT_DIR when the hook's `cwd` is that dir or inside it (by path, or through
 *  links); else `cwd`: a dir elsewhere, a test, or a CLI without the variable. An agent's
 *  worktree, which Claude Code makes under `<project>/.claude/worktrees/<name>`, is its own
 *  project (I10 review). Nothing else nested counts: a `.git` anywhere else may be a
 *  submodule, a nested clone, or one a model made to narrow the gates' scope (review 2: an
 *  empty `docs/sub/.git` let a Stop from there pass edits outside it); and a worktree counts
 *  only when git says it shares the project's repository.
 *  Only for what belongs to the project (records, edit scope, state, approval markers); a
 *  relative path in a Bash command still resolves from `cwd`, where the shell runs it. */
export function projectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const p = (env.CLAUDE_PROJECT_DIR ?? '').trim();
  if (p === '' || !isAbsolute(p)) return cwd;
  const dir = resolve(p);
  if (dir === sep || !isUnder(cwd, dir)) return cwd;
  const parts = relative(realDeep(dir), realDeep(resolve(cwd))).split(sep);
  if (parts[0] === '.claude' && parts[1] === 'worktrees' && parts[2]) {
    const wt = join(dir, '.claude', 'worktrees', parts[2]);
    if (sharesRepo(wt, dir)) return wt;
  }
  return dir;
}

/** Whether `wt` is a worktree of the repository at `dir`: git takes `wt` as a work tree's top
 *  (an invalid `.git` there makes git find the project's repo above it instead) and its common
 *  git dir is `dir`'s. */
function sharesRepo(wt: string, dir: string): boolean {
  if (!existsSync(join(wt, '.git'))) return false;
  const ask = (d: string): [string, string] | null => {
    const r = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { cwd: d, stdout: 'pipe', stderr: 'ignore' });
    const lines = r.stdout.toString().trim().split('\n');
    return r.exitCode === 0 && lines.length === 2 ? [realDeep(lines[0]!), realDeep(lines[1]!)] : null;
  };
  const a = ask(wt);
  const b = ask(dir);
  return a !== null && b !== null && a[0] === realDeep(wt) && a[1] === b[1];
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
  if ((env.CLAUDE_PROJECT_DIR ?? '').trim() !== '') return projectDir(cwd, env);
  const sid = (env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (sid === '') return cwd;
  const r = readRegular(join(sessionDir(sid), PROJECT_FILE), 4096, true);
  const noted = typeof r === 'object' ? r.text.trim() : '';
  return noted !== '' && isAbsolute(noted) && isDir(noted) ? projectDir(cwd, { CLAUDE_PROJECT_DIR: noted }) : cwd;
}
