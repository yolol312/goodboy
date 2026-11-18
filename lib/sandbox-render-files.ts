// What goodboy renders for a project's sandbox dir now (track M, M6g and M6f; plan §19): the layout `sandbox-init` would
// write, made by the pure renderer `planSandbox` from a FRESH in-memory scan of the project (`scanSandbox`, read-only,
// nothing written) and the project's `local.json`. Neither `scan.json` nor the `.written.json` ledger is read: no file the
// model can write counts as proof of what goodboy renders. Two callers compare real bytes with this map: the run gate of
// the privacy review (lib/sandbox-privacy-gate.ts `renderedUnchanged`, the file on disk) and the commit and push scan
// (lib/commit-scan.ts, the content a commit or push would hold). A scan that throws, has problems or ran past its budget,
// an unreadable local file, or a render that throws gives no map and says why (fail closed: nothing is exempt).

import { readLocal } from './sandbox-mode';
import { planSandbox } from './sandbox-render';
import { SCAN_BUDGET_MS, scanSandbox } from './sandbox-scan';
import type { SandboxLocal, SandboxScan } from './sandbox-types';

/** The wall time the fresh scan may take, in ms: the scanner's own budget (`SCAN_BUDGET_MS`, 60 s), so a scan that
 *  `sandbox-scan` accepted is one the callers accept. The scan is synchronous and stops itself at its budget (leaving the
 *  rest out); a scan that took that long is not trusted. Measured (2026-11-18, idle): 10 to 19 ms on a small project, 112 to 147 ms
 *  on this repository, 1.07 to 1.19 s on a large one (a reviewer saw 159 ms and 1152 ms). Nothing is cached between processes: the
 *  PreToolUse scan, the pre-commit hook and the pre-push hook each render again. */
export const RENDER_SCAN_BUDGET_MS = SCAN_BUDGET_MS;

export type RenderFailure = 'scan-threw' | 'scan-problems' | 'scan-slow' | 'local-unreadable' | 'render-failed';

/** The files of the render (path relative to the sandbox dir to exact text), or null and why. One scan and one render.
 *  `budgetMs` (default `RENDER_SCAN_BUDGET_MS`) is the scan's budget; `scanner` is a test seam. */
export function renderSandboxFiles(root: string, scanner: typeof scanSandbox = scanSandbox, budgetMs: number = RENDER_SCAN_BUDGET_MS): { files: Map<string, string> | null; failure: RenderFailure | null } {
  const none = (failure: RenderFailure) => ({ files: null, failure });
  const local = ((): SandboxLocal | Error => {
    try {
      return readLocal(root);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  })();
  if (local instanceof Error) return none('local-unreadable');
  let scan: SandboxScan;
  const t0 = Date.now();
  try {
    scan = scanner(root, { budgetMs });
  } catch {
    return none('scan-threw');
  }
  if (Date.now() - t0 >= budgetMs) return none('scan-slow');
  if (scan.problems.length > 0) return none('scan-problems');
  try {
    return { files: new Map(planSandbox(scan, local, { root }).files), failure: null };
  } catch {
    return none('render-failed');
  }
}
