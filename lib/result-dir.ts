// goodboy's result dirs (`.claude/tests`, `.claude/reviews`, `.claude/pending`, and the sandbox's
// run results under `.goodboy/sandbox/out/`, track M) and whose they are. One rule for the Write
// gate, the Bash write gate and the result guard (final G1 review: a mktemp sandbox's
// `.claude/tests` is not this session's evidence, so writes there pass).

import { homedir } from 'node:os';
import { resolve as resolvePath, sep } from 'node:path';

/** A result-dir path anywhere in a word (`open('.claude/tests/x', 'w')` in a script), ending at a
 *  path boundary. A glob in the dir part (`.claude/te*s/`) may name one too. */
export const RESULT_DIR = /\.claude\/(?:tests|reviews|pending|[^/\s]*[*?[][^/\s]*)(?:\/|$|[^\w-])/;

const SANDBOX_DIR_AT = /\.goodboy\/sandbox\//gi;
const SEGMENT = /[^/\s]*/y;
const OUT_RESULT = /\/(?:[^\s/]+\/)?result\.json(?![\w.-])/iy;
const OUT_DIR_ITSELF = /(?:\/[^\s/]+)?\/?(?![\w./-])/y;
const GLOB = /[*?[]/;

/** Where in `plain` a word names the sandbox's run results (track M), or -1: a test record is
 *  checked against `out/<ts>/result.json`, so `.goodboy/sandbox/out/` itself, a run dir or
 *  `out/<ts>/result.json` as a destination, a `..` or a glob under out/, and a glob in the dir part
 *  (`.goodboy/sandbox/o*t/`) count like a result dir. Files deeper in a run (`coverage/`,
 *  `access.log`, `e2e-artifacts`) are read by the goodboy commands and removed by hand, so they do
 *  not. Case is ignored (macOS). Linear in the word: every step is a sticky match from a fixed
 *  place, the glob and `../` tests share one pass per word (a 100 KB word of `[` or of repeated
 *  `.goodboy/sandbox/out/` cost seconds as one backtracking regex). */
export function sandboxOutAt(plain: string): number {
  let wordEnd = -1;
  let lastBad = -1;
  SANDBOX_DIR_AT.lastIndex = 0;
  for (let m = SANDBOX_DIR_AT.exec(plain); m !== null; m = SANDBOX_DIR_AT.exec(plain)) {
    const at = m.index + m[0].length;
    if (at > wordEnd) {
      // the word this place is in: its end, and the last glob character or `../` in it
      let e = at;
      lastBad = -1;
      while (e < plain.length && !/\s/.test(plain[e]!)) {
        if (GLOB.test(plain[e]!) || (plain[e] === '.' && plain.startsWith('../', e))) lastBad = e;
        e++;
      }
      wordEnd = e;
    }
    SEGMENT.lastIndex = at;
    const seg = SEGMENT.exec(plain)![0];
    const next = at + seg.length;
    if (GLOB.test(seg) && plain[next] === '/') return m.index;
    if (seg.toLowerCase() !== 'out') continue;
    OUT_RESULT.lastIndex = next;
    if (OUT_RESULT.test(plain)) return m.index;
    OUT_DIR_ITSELF.lastIndex = next;
    if (OUT_DIR_ITSELF.test(plain)) return m.index;
    if (plain[next] === '/' && lastBad > next) return m.index;
  }
  return -1;
}

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

/** Whether a word names one of this session's result dirs (`.claude/{tests,reviews,pending}` or
 *  the sandbox's run results, see sandboxOutAt), read from `base` (the cwd, or the dir a literal
 *  `cd` moved to). The part before `.claude/` or `.goodboy/` decides: none or a literal path is resolved;
 *  `$PWD` or `$(pwd)` is the base; any other variable or substitution cannot be read and does not
 *  count (fail-open, like every other `$` target). */
export function namesOwnResultDir(word: string, base: string, cwd: string): boolean {
  const plain = word.replace(/["'\\]/g, '').replace(/\/\.(?=\/)/g, '').replace(/\/{2,}/g, '/');
  const claude = RESULT_DIR.exec(plain);
  const out = sandboxOutAt(plain);
  const at = claude && out >= 0 ? Math.min(claude.index, out) : (claude?.index ?? out);
  if (at < 0) return false;
  const m = { index: at };
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
