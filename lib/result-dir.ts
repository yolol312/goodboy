// goodboy's result dirs (`.claude/tests`, `.claude/reviews`, `.claude/pending`) and whose they
// are. One rule for the Write gate, the Bash write gate and the result guard (final G1 review:
// a mktemp sandbox's `.claude/tests` is not this session's evidence, so writes there pass).

import { homedir } from 'node:os';
import { resolve as resolvePath, sep } from 'node:path';

/** A result-dir path anywhere in a word (`open('.claude/tests/x', 'w')` in a script), ending at a
 *  path boundary. A glob in the dir part (`.claude/te*s/`) may name one too. */
export const RESULT_DIR = /\.claude\/(?:tests|reviews|pending|[^/\s]*[*?[][^/\s]*)(?:\/|$|[^\w-])/;

function within(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/** True when a result dir at `owner/.claude/…` is the cwd's own, a project's above it, or a
 *  package's below it. Another project's same-named dir elsewhere is not. */
export function ownsResultDir(owner: string, cwd: string): boolean {
  const o = resolvePath(owner);
  const c = resolvePath(cwd);
  return within(c, o) || within(o, c);
}

/** Whether a word names one of this session's result dirs, read from `base` (the cwd, or the dir a
 *  literal `cd` moved to). The part before `.claude/` decides: none or a literal path is resolved;
 *  `$PWD` or `$(pwd)` is the base; any other variable or substitution cannot be read and does not
 *  count (fail-open, like every other `$` target). */
export function namesOwnResultDir(word: string, base: string, cwd: string): boolean {
  const plain = word.replace(/["'\\]/g, '').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');
  const m = RESULT_DIR.exec(plain);
  if (!m) return false;
  const before = plain.slice(0, m.index);
  if (/(?:\$\{?PWD\}?|\$\(pwd\)|`pwd`)\/$/.test(before)) return ownsResultDir(base, cwd);
  // The path starts after the last character that cannot be part of it (`open(`, `=`, `,`);
  //   found by a backward scan (a `[^…]*$` search was quadratic on a 30 KB word).
  let k = before.length;
  while (k > 0 && !/[\s(,=:;]/.test(before[k - 1]!)) k--;
  const prefix = before.slice(k);
  if (/[$`)}]/.test(prefix)) return false;
  const p = prefix.startsWith('~') ? homedir() + prefix.slice(1) : prefix;
  return ownsResultDir(resolvePath(base, p || '.'), cwd);
}
