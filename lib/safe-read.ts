// Reading files a hook cannot trust to be ordinary (track H commit issue, track I I2): a
// session state file or a repo document may be a FIFO, a device (a link to /dev/zero), a
// directory or a huge file, put there by a model Bash call or by accident. Reading one with a
// plain readFileSync hung or flooded the hook (I2 security reviews: every Stop killed at its
// 15 s timeout).

import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from 'node:fs';

/** The largest dev-cycle or policy document a hook reads (CYCLE.md, UIUX.md, the prototype,
 *  REQUIREMENTS.md, policy.md). */
export const MAX_DOC_BYTES = 2_000_000;

/** The largest session state file a hook reads or the state guard copies. A criteria pin holds
 *  the rows' full titles and the policy lines, so it can be larger than a document. */
export const MAX_STATE_BYTES = 16 * 1024 * 1024;

/** A regular file of at most `max` bytes, opened without blocking (a FIFO or a device is
 *  refused, never waited on) and read through the same descriptor, never past the size fstat
 *  gave (a file growing meanwhile is cut there); with `noFollow`, a symlink at the path is
 *  refused too. With `tail`, a larger file is not refused: its last `max` bytes are read, from a
 *  line boundary (the partial first line is dropped). */
export function readRegular(p: string, max: number, noFollow = false, tail = false): { text: string; st: Stats } | 'absent' | 'refused' {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'refused';
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.size > max && !tail)) return 'refused';
    // A tail starts one byte early, so a window that begins on a line boundary keeps its first line (round-2 review).
    const start = st.size > max ? st.size - max - 1 : 0;
    const buf = Buffer.alloc(st.size - start);
    let got = 0;
    while (got < buf.length) {
      const k = readSync(fd, buf, got, buf.length - got, start + got);
      if (k === 0) break;
      got += k;
    }
    let from = 0;
    if (start > 0) {
      const nl = buf.indexOf(0x0a);
      from = nl === -1 ? got : nl + 1; // no line boundary in the window: nothing whole to read
    }
    return { text: buf.subarray(from, got).toString('utf8'), st };
  } catch {
    return 'refused';
  } finally {
    closeSync(fd);
  }
}

/** The text of a session state file a hook reads to decide a gate (#12): `readFileSync` for a
 *  regular file of at most `max` bytes, and the error `readFileSync` would have thrown for
 *  anything else (absent, a directory, an oversized file), so a caller's `catch` keeps its
 *  meaning. A FIFO is refused unopened instead of waited on (a model Bash call can put one at a
 *  state file, and every Stop then hung until its hook timeout), and a device or a huge file is
 *  never read whole. */
export function readStateText(p: string, max = MAX_STATE_BYTES): string {
  const r = readRegular(p, max);
  if (r === 'absent') throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
  if (r === 'refused') throw Object.assign(new Error(`EINVAL: not a regular file within ${max} bytes: '${p}'`), { code: 'EINVAL' });
  return r.text;
}

/** The text of an append-only record log a hook reads to decide a gate (#12): the whole file within
 *  `max`, else its LAST `max` bytes from a line boundary, never empty (a log read as empty is a gate that
 *  saw nothing: `readStateText` throws for it and a caller's `catch` returned []). A log that large was
 *  padded by a call: the Stop blocks on it (lib/state-guard.ts oversizedLogs), since padding pushes real
 *  records out of the tail. What a caller that needs to be exact must use `readStateText` for (an evidence
 *  log: an oversized one is no evidence, not a tail of one). A FIFO, a directory, a device or an absent
 *  file is the same error as `readStateText`. One reader with readRegular (refactoring review). */
export function readStateTail(p: string, max = MAX_STATE_BYTES): string {
  const r = readRegular(p, max, false, true);
  if (r === 'absent') throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: 'ENOENT' });
  if (r === 'refused') throw Object.assign(new Error(`EINVAL: not a regular file: '${p}'`), { code: 'EINVAL' });
  return r.text;
}
