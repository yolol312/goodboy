// Writes the Bash write gate cannot see (track G, write-bypass detection): an interpreter or
// a nested shell that writes a project file (`python3 -c "open('a.ts','w')…"`, `node -e`,
// `sh -c "cat > a.ts"`). Seen live: a subagent edited test files with Python heredocs and none
// of them reached the edit log, so the review and test gates did not ask for them. PostToolUse
// now lists the files git sees changed since the call started and records them as edits.
// Limited to commands that run such programs, so ordinary commands pay no `git status`.

import { statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { openBashCalls, restoreProductionHosts, sweepNewMarkers, takeBashStart } from './approval-marker';
import { restoreGateState } from './state-guard';
import { getCurrentTurn, isGoodboyArtifact, recordEdit } from './file-tracker';
import { logGate } from './gate-log';
import { filterOffArgs, HOOK_GIT_ARGS, HOOK_GIT_ENV } from './hook-git';
import { commandSegments } from './outward-command';
import { envStr } from './token-habits';
import { safeMtime } from './bash-read';

/** At Stop: finishes the session's Bash calls that never reported back (`exit N` fires no post
 *  hook, G0 M18) as their post hook would have: markers swept, hosts restored, indirect writes
 *  recorded, gate state put back. Runs before the gates read anything. */
export function finishOpenBashCalls(sessionId: string): { context?: string; notice?: string } {
  const contexts: string[] = [];
  const notices: string[] = [];
  // The Stop has 15 s (security review round 3: three open calls with a slow fsmonitor took
  //   18 s, and a timed-out Stop blocks nothing). After 5 s the git-based write sweep is
  //   skipped; the file restores are cheap and always run.
  const started = Date.now();
  for (const n of openBashCalls(sessionId).slice(-20)) {
    if (!n.tuid) continue;
    const r = afterBash(sessionId, n.tuid, n.cwd, n.command, n.agent, { skipGit: Date.now() - started > 5_000, gitTimeoutMs: 3_000 });
    if (r.context) contexts.push(r.context);
    if (r.notice) notices.push(r.notice);
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
): { context?: string; notice?: string } {
  const notes: string[] = [];
  const notices: string[] = [];
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
    if (!opts.skipGit && envStr('GOODBOY_BASH_WRITE_GATE', 'deny') !== 'off' && typeof command === 'string' && writesIndirectly(command)) {
      // PostToolUse has 60 s and PostToolUseFailure 15 s; the Stop path (opts.gitTimeoutMs) less.
      const written = changedFilesSince(cwd, start.since, opts.gitTimeoutMs ?? 12_000);
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
    process.stderr.write(`[goodboy] after-Bash sweep error: ${String(err)}\n`);
  }
  return { ...(notes.length > 0 ? { context: notes.join('\n') } : {}), ...(notices.length > 0 ? { notice: notices.join('\n') } : {}) };
}

const INTERPRETERS = /^(?:python[0-9.]*|node|perl|ruby|php|deno|tsx|ts-node|osascript|xargs|g?awk|parallel)$/;

/** True when a shell command runs, in command position, a program that can write files the
 *  write gate cannot read: an interpreter, `xargs`/`awk`, `bun -e|run`, `sh -c`, `find -exec`. */
export function writesIndirectly(command: string): boolean {
  for (const words of commandSegments(command)) {
    const prog = (words[0] ?? '').split('/').pop() ?? '';
    if (INTERPRETERS.test(prog)) return true;
    if (prog === 'bun' && ['-e', '--eval', 'run', 'x'].includes(words[1] ?? '')) return true;
    if (/^(?:ba|z|da|k)?sh$/.test(prog) && words.includes('-c')) return true;
    if (prog === 'find' && words.some((w) => w === '-exec' || w === '-execdir')) return true;
  }
  return false;
}

/** git without optional locks (a `status` refresh must not hold the user's index.lock while a
 *  parallel `git add` runs: performance review, 71 of 112 concurrent adds failed) and with a
 *  time limit below the post hooks' timeouts. It starts no program from the repo's config
 *  (lib/hook-git.ts). */
function git(cwd: string, args: string[], timeoutMs: number): string | null {
  try {
    const p = Bun.spawnSync(['git', '--no-optional-locks', ...HOOK_GIT_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...HOOK_GIT_ENV },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** Project files (absolute paths) that git sees as modified or untracked and that changed at
 *  or after `sinceMs`. Ignored files, deletions and goodboy's own artifacts are left out.
 *  Empty outside a git repo. */
export function changedFilesSince(cwd: string, sinceMs: number, timeoutMs = 30_000): string[] {
  // The top in cwd's own spelling (`--show-cdup`), not git's real path: on macOS /var is
  //   /private/var, and the edit log must match the paths the Stop gates compare with cwd.
  const cdup = git(cwd, ['rev-parse', '--show-cdup'], timeoutMs);
  if (cdup === null) return [];
  const top = resolvePath(cwd, cdup.trim() || '.');
  // Every filter driver emptied: status runs a clean filter to hash a touched file (final G1
  //   test round). The sweep only needs names, so a filtered file reading as changed is fine.
  const filters = filterOffArgs(git(top, ['config', '--name-only', '--get-regexp', '^filter\\.'], timeoutMs) ?? '');
  const out = git(top, [...filters, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], timeoutMs);
  if (out === null) return [];
  const parts = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    if (xy.includes('R') || xy.includes('C')) i++; // the next part is the original path
    if (xy.includes('D')) continue;
    const abs = join(top, entry.slice(3));
    if (isGoodboyArtifact(abs)) continue;
    try {
      const st = statSync(abs);
      if (st.isFile() && st.mtimeMs >= sinceMs) files.push(abs);
    } catch {
      // gone meanwhile
    }
  }
  return files;
}
