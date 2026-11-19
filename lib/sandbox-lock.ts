// One sandbox command at a time per project (track M, M7 review G2; plan §19): `sandbox-prepare`, `-up`, `-run` and `-down`
// clear scratch volumes, reset the database from its template and start and stop services, so a second one that starts
// while the first runs would wipe what the first is using. A lock file under `out/` (git-ignored) holds the pid, the
// start time and the command of its holder. A second command does not wait: it fails at once and names the holder.
//
// A holder that is gone leaves a stale lock (a command killed by a signal never removes it): a lock whose pid no longer
// exists is taken over, so is one older than MAX_AGE_MS (a pid that was reused by an unrelated process must not block
// the project for good). Known limit: two commands that both find the same stale lock can take it in turn; the window is
// the time between reading the lock and removing it, a few microseconds.

import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readRegular } from './safe-read';

/** The longest a command may hold the lock (above the longest run, MAX_RUN_MS, and a prepare with its pulls). */
const MAX_AGE_MS = 6 * 3_600_000;
/** A lock file with no readable content is a holder that has just made it (or a broken file): taken over after this long. */
const EMPTY_GRACE_MS = 10_000;

export const LOCK_FILE = '.lock';

interface Holder {
  pid: number;
  started: string;
  command: string;
}

export type SandboxLock = { release: () => void } | { busy: string };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // it exists, owned by another user
  }
};

function parse(text: string): Holder | null {
  try {
    const h = JSON.parse(text) as Partial<Holder> | null;
    if (h !== null && typeof h === 'object' && Number.isInteger(h.pid) && h.pid! > 0 && typeof h.started === 'string' && typeof h.command === 'string' && !Number.isNaN(Date.parse(h.started))) return h as Holder;
  } catch {
    // not ours
  }
  return null;
}

const describe = (h: Holder): string => `${h.command} (pid ${h.pid}, started ${h.started})`;

/** Takes the project's lock for `command`, or says who holds it. `outDir` is `<sandbox dir>/out`, which must exist. */
export function lockSandbox(outDir: string, command: string, now: () => number = Date.now): SandboxLock {
  const file = join(outDir, LOCK_FILE);
  const mine: Holder = { pid: process.pid, started: new Date(now()).toISOString(), command };
  const text = `${JSON.stringify(mine)}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => {
          try {
            if (readFileSync(file, 'utf8') === text) unlinkSync(file);
          } catch {
            // already gone or taken over as stale
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const r = readRegular(file, 4096, true);
    if (r === 'absent') continue; // released meanwhile: try again
    if (r === 'refused') return { busy: `the lock ${file} is not a regular file; remove it if no sandbox command is running` };
    const h = parse(r.text);
    const age = now() - r.st.mtimeMs;
    const stale = h === null ? age > EMPTY_GRACE_MS : !alive(h.pid) || now() - Date.parse(h.started) > MAX_AGE_MS;
    if (!stale) {
      return { busy: h === null ? `the lock ${file} was just made by another sandbox command` : `another sandbox command of this project is running: ${describe(h)}; wait for it to end, or stop it (if none is running, a reused pid may hold the lock: remove ${file})` };
    }
    try {
      if (readFileSync(file, 'utf8') === r.text) unlinkSync(file); // still the stale one: take it over
    } catch {
      // gone meanwhile
    }
  }
  return { busy: `the lock ${file} could not be taken; another sandbox command started at the same time` };
}
