// The mode of a sandbox project, in a module small enough for a hook to load (track M, M6b; plan §19):
// where the sandbox dir is, its compose project name, whether the project holds real data by what is on
// disk, and the names of a run dir and of the raw files a run left on the host. The sandbox commands and the
// PreToolUse rule of lib/sandbox-data-guard.ts import them from here, without the renderer and the scanner
// (the hook runs on every tool call).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { readRegular } from './safe-read';
import { realDataOf } from './sandbox-boundary';
import type { SandboxLocal } from './sandbox-types';
import { ACCESS_LOG_FILE, PLAYWRIGHT_REPORT_FILE } from './ui-types';

export const SANDBOX_DIR = '.goodboy/sandbox';
export const LOCAL_FILE = `${SANDBOX_DIR}/local.json`;

/** The most input paths `sandbox-local --input` registers. */
export const MAX_INPUTS = 50;

/** The name of a run dir under `out/` (`20261022T031816Z`). */
export const RUN_NAME = /^\d{8}T\d{6}Z$/;

/** The names the writers give a run's files (lib/sandbox-run.ts, the reader's scripts in lib/sandbox-volumes.ts, the
 *  Playwright config of lib/sandbox-e2e.ts, lib/ui-types.ts for the other two). */
export const OUTPUT_LOG_FILE = 'output.log';
export const E2E_OUTPUT_LOG_FILE = 'e2e-output.log';
export const E2E_ARTIFACTS_DIR = 'e2e-artifacts';

/** The raw files and dirs a run left next to `result.json` before M6a (and in a plain run): the sweep removes them in
 *  real-data mode (lib/sandbox-store.ts) and the PreToolUse rule keeps a model from reading them. One list, built from
 *  the writers' own names. */
export const HOST_RAW_NAMES: readonly string[] = [OUTPUT_LOG_FILE, E2E_OUTPUT_LOG_FILE, ACCESS_LOG_FILE, PLAYWRIGHT_REPORT_FILE, E2E_ARTIFACTS_DIR];

/** `realpath(p)`, or `p` itself when it does not exist (yet). */
export function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The compose project of a repo: its dir name and a short hash of its real path, so two
 *  checkouts of one name never share networks or volumes. */
export function projectName(root: string): string {
  const real = realOrSelf(root);
  const slug = basename(real).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'project';
  return `gb-${slug}-${createHash('sha256').update(real).digest('hex').slice(0, 6)}`;
}

/** The local answers; empty ones when there is no local.json, an Error when it is unreadable. */
export function readLocal(root: string): SandboxLocal | Error {
  const p = join(root, LOCAL_FILE);
  const r = readRegular(p, 64 * 1024, true);
  if (r === 'absent') return { dump: null, dumpFormat: null };
  if (r === 'refused') return new Error(`${p} is not a regular file; move it away`);
  try {
    const l = JSON.parse(r.text) as SandboxLocal;
    const okDump = l.dump === null || (typeof l.dump === 'string' && isAbsolute(l.dump));
    const okFormat = l.dumpFormat === null || l.dumpFormat === 'sql' || l.dumpFormat === 'custom';
    // `realData` is true, false or absent; anything else is a file goodboy did not write (fail closed)
    const okReal = l.realData === undefined || typeof l.realData === 'boolean';
    // `inputs` (M6b): absolute paths of registered input logs, or absent
    const okInputs = l.inputs === undefined || (Array.isArray(l.inputs) && l.inputs.length <= MAX_INPUTS && l.inputs.every((x) => typeof x === 'string' && isAbsolute(x)));
    if (okDump && okFormat && okReal && okInputs) return { dump: l.dump, dumpFormat: l.dumpFormat, realData: l.realData === true, ...(l.inputs !== undefined ? { inputs: l.inputs } : {}) };
  } catch {
    // below
  }
  return new Error(`${p} is not a local file goodboy wrote; run sandbox-local --dump <path> again`);
}

/** Whether a project holds real data by its local file alone: the flag, a dump or a registered input, and a
 *  file that cannot be read counts as real (fail closed). The one rule `loadCtx` and `ui-check` share; the
 *  commands that talk to docker may also find a database volume (`preflight` in lib/sandbox-run.ts). */
export function realDataOfRoot(root: string): boolean {
  const local = readLocal(root);
  return local instanceof Error || realDataOf(local);
}

/** Whether raw host files of a run that may have held real data can still be there, for a command that
 *  cannot ask docker (`ui-check`): the old `out/live/` dir, or a run dir whose `result.json` does not say
 *  `realData: false` (a run before M6a has no such field, a real-data run says true). A dir with no
 *  result (a run that stopped at once) says nothing; a result that is refused (a link, over 64 KiB, unreadable) or
 *  an `out/` dir that cannot be listed counts as raw. Bounded: the newest 200 run dirs are looked at, 64 KiB
 *  each, and more than that count as raw (fail closed: an older run past the cap may be a real-data one). */
export function rawMayRemain(root: string): boolean {
  const out = join(root, SANDBOX_DIR, 'out');
  let names: string[];
  try {
    names = readdirSync(out);
  } catch (e) {
    // no `out/` dir: nothing was left; a dir that cannot be listed may hold anything (fail closed)
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
  if (names.includes('live')) return true;
  const runs = names.filter((x) => RUN_NAME.test(x)).sort().reverse();
  if (runs.length > 200) return true;
  for (const n of runs) {
    const r = readRegular(join(out, n, 'result.json'), 64 * 1024, true);
    if (r === 'refused') return true; // a result that is a link, too big or unreadable may be any run's
    if (typeof r !== 'object') continue;
    try {
      if ((JSON.parse(r.text) as { realData?: unknown } | null)?.realData !== false) return true;
    } catch {
      return true; // a result goodboy cannot read may be any run's
    }
  }
  return false;
}

/** The mode for reading what a run left behind, without docker: the rule of `realDataOfRoot`, and, when
 *  `local.json` is gone (the file is untracked and goes with `git clean -xfd`), real data as well while raw
 *  host files that may have held it can remain (`rawMayRemain`): the mode is then decided fail-closed
 *  the way the sandbox commands do with the project's database volume. */
export function realDataForReading(root: string): boolean {
  if (realDataOfRoot(root)) return true;
  return !existsSync(join(root, LOCAL_FILE)) && rawMayRemain(root);
}
