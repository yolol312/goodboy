// Unicode spelling of a path (v0.36.6, plan §15.22). Git keeps a path's spelling as it was added
// (macOS git precomposes it to NFC by default), while the edit log and a record keep the
// spelling a tool wrote, which can be NFD. Two spellings name one file only when the file system
// says so: both resolve to the same inode. Nothing here merges two paths because their
// normalized forms are equal: on Linux `é` (NFC) and `é` (NFD) are two files, and one of them
// may be a different file than the one a record is about. Git's own spelling is never rewritten;
// a caller asks which of the names it already has is the file on disk.

import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';

/** Whether two paths name one file on disk: both exist and have the same device and inode. */
export type SameFile = (a: string, b: string) => boolean;

const sameFileOnDisk: SameFile = (a, b) => {
  try {
    const x = lstatSync(a);
    const y = lstatSync(b);
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
};

// Every character below U+0080 is its own NFC and NFD form: such a path has no twin.
const ASCII = /^[\x00-\x7f]*$/;

/** The name in `names` that is `name` itself, else the one that differs from it only by Unicode
 *  normalization (NFC or NFD) and is the same file on disk (`dir` resolves relative names);
 *  null when there is none, or when more than one such name would be the file. `same` is the file
 *  system's answer (a test's). */
export function sameFileSpelling(dir: string, name: string, names: Iterable<string>, same: SameFile = sameFileOnDisk): string | null {
  const list = names instanceof Set ? names : new Set(names);
  if (list.has(name)) return name;
  if (ASCII.test(name)) return null;
  const nfc = name.normalize('NFC');
  const twins = [...list].filter((n) => n !== name && !ASCII.test(n) && n.normalize('NFC') === nfc);
  const hits = twins.filter((n) => same(resolve(dir, name), resolve(dir, n)));
  return hits.length === 1 ? hits[0]! : null;
}

/** `sameFileSpelling` as a membership test. */
export function hasSpelling(dir: string, name: string, names: Iterable<string>, same?: SameFile): boolean {
  return sameFileSpelling(dir, name, names, same) !== null;
}
