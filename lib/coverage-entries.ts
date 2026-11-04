// The repo a changed-line coverage entry belongs to (#39, plan §15.30 item 6). A run that covers several
// repos of a project dir that is no repo (`be/`, `fe/`) records one `cli.ts diff-coverage` output per repo,
// so `coverage.changed` is one object or a list of them, and `coverage.subprocess` pairs may name their repo;
// each carries `top` (the repo's real top). Every reader asks for the entries of one repo through the
// functions here, so `be/src/x.ts` and `fe/src/x.ts` never satisfy each other.
//
// An entry without `top` is from a project dir that is a repo (or from before v0.36.14): it belongs to the
// project dir's own repo, and to no repo when the project dir has none.

import { isAbsolute, join } from 'node:path';
import { repoOfFile, topOf, type RepoWalkMemo } from './nested-repos';
import { realDeep } from './private-files';
import type { ChangedCoverage, CoverageRecord, SubprocessPair } from './types';

/** At most this many `coverage.changed` entries of a record are read (one per repo, and a run covers few). */
export const MAX_CHANGED_ENTRIES = 64;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether something labelled `top` belongs to the repo whose real top is `realTop`. `ownRealTop`: the real
 *  top of the project dir's own repo, null when the project dir is no repo. */
function belongsTo(top: unknown, realTop: string | null, ownRealTop: string | null): boolean {
  if (realTop === null) return false;
  if (top === undefined) return ownRealTop !== null && ownRealTop === realTop;
  return typeof top === 'string' && isAbsolute(top) && realDeep(top) === realTop;
}

/** The `coverage.changed` entries of a record that belong to the repo whose real top is `realTop`.
 *  `ownRealTop` is the real top of the project dir's own repo (null: the project dir is no repo, so an entry
 *  without `top` belongs to no repo); left out, it is `realTop`, which is the single-top reading of a project
 *  dir that is a repo: an entry without `top` belongs to the repo asked for. An entry with `top` belongs to the
 *  repo whose real top it names (compared as `realDeep`, so a link in the label does not matter). `realTop`
 *  null (no repo: loose files) has no entries. Not entries that are no objects; their fields are not checked
 *  here (the readers check what they read). */
export function changedEntries(r: { coverage?: CoverageRecord }, realTop: string | null, ownRealTop: string | null = realTop): ChangedCoverage[] {
  const changed: unknown = r.coverage?.changed;
  if (changed === undefined || changed === null) return [];
  const list: unknown[] = Array.isArray(changed) ? changed.slice(0, MAX_CHANGED_ENTRIES) : [changed];
  return list.filter((e): e is ChangedCoverage => isObject(e) && belongsTo(e.top, realTop, ownRealTop));
}

/** The `coverage.subprocess` pairs of a record that belong to the repo whose real top is `realTop`
 *  (the rules of `changedEntries`). */
export function subprocessPairs(r: { coverage?: CoverageRecord }, realTop: string | null, ownRealTop: string | null = realTop): SubprocessPair[] {
  const pairs: unknown = r.coverage?.subprocess;
  if (!Array.isArray(pairs)) return [];
  return pairs.filter((p): p is SubprocessPair => isObject(p) && belongsTo(p.top, realTop, ownRealTop));
}

/** (test-write) Keeps the entries of `coverage.changed` and the pairs of `coverage.subprocess` whose `top` is a
 *  repo inside the project dir, and drops the others. The label is the agent's, so this only keeps a record from
 *  carrying a repo that does not exist here (the base check of the Stop and the content freshness stay the real
 *  checks). A kept `top` is rewritten to the repo's real top. A repo inside the project dir is the project's own
 *  repo (its top may be above the project dir), or one that `repoOfFile` finds below it. Returns one warning per
 *  dropped entry. Mutates `coverage`; a `changed` left with no entry is removed. */
export function scopeCoverageTops(coverage: CoverageRecord, projectDir: string): string[] {
  const warnings: string[] = [];
  const ownTop = topOf(projectDir);
  const ownReal = ownTop === null ? null : realDeep(ownTop);
  const memo: RepoWalkMemo = new Map();
  const scoped = new Map<string, string | null>(); // a top as written → its real top, or null: no repo of the project
  const resolveTop = (top: string): string | null => {
    if (scoped.has(top)) return scoped.get(top)!;
    let real: string | null = null;
    if (isAbsolute(top)) {
      const t = realDeep(top);
      // A pseudo file in the dir: the repo of a file is the nearest repo-top dir up to the project dir.
      real = t === ownReal || repoOfFile(join(t, '.goodboy-probe'), projectDir, memo)?.realTop === t ? t : null;
    }
    scoped.set(top, real);
    return real;
  };
  const keep = <T extends { top?: unknown }>(item: T, what: string): boolean => {
    if (item.top === undefined) return true;
    const real = typeof item.top === 'string' ? resolveTop(item.top) : null;
    if (real === null) {
      warnings.push(`warning: ${what} names ${typeof item.top === 'string' ? item.top : 'a top that is no path'}, which is not a git repository inside the project dir; it is dropped.`);
      return false;
    }
    (item as { top?: string }).top = real;
    return true;
  };
  if (coverage.changed !== undefined) {
    if (Array.isArray(coverage.changed)) {
      const kept = coverage.changed.filter((e, i) => keep(e, `coverage.changed[${i}]`));
      if (kept.length > 0) coverage.changed = kept;
      else delete coverage.changed;
    } else if (!keep(coverage.changed, 'coverage.changed')) {
      delete coverage.changed;
    }
  }
  if (Array.isArray(coverage.subprocess)) {
    coverage.subprocess = coverage.subprocess.filter((p, i) => keep(p, `coverage.subprocess[${i}]`));
  }
  return warnings;
}
