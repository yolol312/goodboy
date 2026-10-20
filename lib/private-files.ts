// Private files goodboy keeps outside a project and outside its own versioned plugin cache:
// field reports (track J, lib/field-report.ts) and update checkups (track K, lib/checkup.ts).
// A dir must be a real dir of this user that others cannot write; a file is created
// exclusively, never through a link, written whole and synced, or removed again.

import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Claude Code's config dir: CLAUDE_CONFIG_DIR when set (resolved), else `~/.claude` under
 *  HOME (or the OS home). One rule for every caller (K1a review: three variants differed). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const c = (env.CLAUDE_CONFIG_DIR ?? '').trim();
  if (c !== '') return resolve(c);
  return join((env.HOME ?? '').trim() || homedir(), '.claude');
}

/** A private dir after checkDir, made 0700 when `create`; null when it is missing and not to
 *  be made. */
export function checkedPrivateDir(dir: string, what: string, create: boolean): string | null {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else {
    try {
      lstatSync(dir);
    } catch {
      return null;
    }
  }
  checkDir(dir, what);
  return dir;
}

/** Whether `p` is a dir, through links. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `a` is `b` or inside it, with every link resolved as far up as each exists. */
export function isUnder(a: string, b: string): boolean {
  const r = relative(realDeep(b), realDeep(a));
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep));
}

/** A directory goodboy keeps its files in: a real directory (not a link), this user's, not
 *  writable by others. Throws with `what` named otherwise. */
export function checkDir(dir: string, what: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`${what} ${dir} is not a directory (a link or a file is at its path)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`${what} ${dir} belongs to another user`);
  if ((st.mode & 0o022) !== 0) throw new Error(`${what} ${dir} is writable by others (chmod 700 it)`);
}

/** Creates `path` with `text` (mode 600), written whole and synced to disk, or false when
 *  anything is already at the path: the exclusive create never follows a link there. A write
 *  that fails or stops short removes the file and throws (J2 review: a short write lost a
 *  report whose original was then removed). */
export function createNew(path: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    const buf = Buffer.from(text, 'utf8');
    for (let off = 0; off < buf.length; ) {
      const k = writeSync(fd, buf, off, buf.length - off);
      if (k <= 0) throw new Error(`${path}: the write stopped short`);
      off += k;
    }
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
    throw err;
  }
  closeSync(fd);
  return true;
}

/** `p` with every link resolved, as far up as it exists: a dir not made yet under a linked
 *  `~/.claude` still resolves to where it would be made (J1 review). */
export function realDeep(p: string): string {
  const abs = resolve(p);
  for (let dir = abs; ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), relative(dir, abs));
    } catch {
      if (dirname(dir) === dir) return abs;
    }
  }
}

/** Whether a process runs (or exists under another user: EPERM). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
