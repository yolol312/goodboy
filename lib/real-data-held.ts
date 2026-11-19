// Whether a repository holds real data, for the review gate (track M, M6g; plan §19): the sandbox's own state
// (`realDataForReading`: the local file, a dump or input, raw files a run left) or the user-level registry, which
// the PreToolUse rule and the commit scan read (lib/commit-scan.ts `realDataRootOf`) and which outlives `local.json`
// and the raw files (`git clean -xfd` with the database volume kept). One answer for the Stop (lib/stop-groups.ts)
// and `review-axes` (lib/cli.ts), so the two cannot differ.

import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { realDataForReading, realOrSelf, SANDBOX_DIR } from './sandbox-mode';
import { readRegistry, RegistryError } from './sandbox-registry';

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** The real-data project `dir` belongs to (its dir), or null: a project dir whose sandbox says real data
 *  (lib/sandbox-mode.ts `realDataForReading`), or one the user-level registry holds. No git call. A registry that
 *  cannot be read is left out, as the sandbox rule does (it logs it). Used by the commit scan (lib/commit-scan.ts
 *  re-exports it) and by the PreToolUse hook before it loads the scan modules. */
export function realDataRootOf(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const start = resolve(dir);
  const real = realOrSelf(start);
  const reg = readRegistry(env);
  if (!(reg instanceof RegistryError)) {
    for (const e of reg) if (inside(real, e.top) || inside(start, e.top)) return e.top;
  }
  let cur = start;
  for (let i = 0; i < 64; i++) {
    if (isDir(join(cur, SANDBOX_DIR)) && realDataForReading(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/** Whether the user-level registry names any project (a command anywhere may then touch one). */
export function registryHoldsProjects(env: NodeJS.ProcessEnv = process.env): boolean {
  const reg = readRegistry(env);
  return !(reg instanceof RegistryError) && reg.length > 0;
}

/** Whether the registry holds the project `top`, or a project that `top` is in. A registry that cannot be read is left
 *  out, as the PreToolUse rule does (it logs it). */
function registryHolds(top: string): boolean {
  const reg = readRegistry();
  if (reg instanceof RegistryError) return false;
  const start = resolve(top);
  const real = realOrSelf(start);
  return reg.some((e) => inside(real, e.top) || inside(start, e.top));
}

/** Whether the repository at `top` holds real data: the sandbox says so (fail closed on an unreadable state), or the
 *  registry holds it. */
export function realDataHeld(top: string): boolean {
  return realDataForReading(top) || registryHolds(top);
}
