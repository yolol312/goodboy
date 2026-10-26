// The one place a test or review record's relative path is resolved (issue #32, plan §15.21).
//
// A record names files (`tested_files`, `test_files`, `reviewed_files`, a finding's `file`). A
// relative name used to be resolved with `path.resolve(name)`, that is against the hook
// process's current dir, which follows the model's `cd` (I10: the Stop's `cwd` is the shell's
// dir; the project dir is pinned apart). A record written from the project's root then named
// other files from a Stop run in `docs/ui`, and the gate reported files the record names as
// untested. A relative name now resolves against the project dir the Stop pinned
// (`setRecordBase`, called once by the Stop), and `test-write` and `review-write` store absolute
// paths, so a new record never depends on it. Without a pinned dir (a unit test, another
// caller) the process cwd is the base, as before.

import { resolve } from 'node:path';
import { openedPath } from './file-tracker';

let pinned: string | undefined;

/** Pins the dir relative record paths resolve against (the Stop's project dir); no dir unpins. */
export function setRecordBase(dir?: string): void {
  pinned = dir === undefined ? undefined : resolve(dir);
}

/** The dir relative record paths resolve against now. */
export function recordBase(): string {
  return pinned ?? process.cwd();
}

/** A record's path as an absolute one, as the OS opens it: a link is followed before each `..`
 *  (`openedPath`, the spelling the edit log uses; issue #29). `base` overrides the pinned dir.
 *  Never throws: openedPath returns the spelled path when it cannot be resolved. */
export function recordPath(p: string, base?: string): string {
  return openedPath(base ?? recordBase(), p);
}
