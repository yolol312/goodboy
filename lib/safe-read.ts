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
 *  refused too. */
export function readRegular(p: string, max: number, noFollow = false): { text: string; st: Stats } | 'absent' | 'refused' {
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'refused';
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return 'refused';
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const k = readSync(fd, buf, got, st.size - got, got);
      if (k === 0) break;
      got += k;
    }
    return { text: buf.subarray(0, got).toString('utf8'), st };
  } catch {
    return 'refused';
  } finally {
    closeSync(fd);
  }
}
