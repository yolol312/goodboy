// Secrets in text, for the places goodboy keeps text it did not write: a field report's public
// summary (lib/field-report.ts, track J) and what an update checkup keeps (track K: hook
// commands in the inventory).

/** Tokens, keys and passwords as they appear in output and config. */
export const SECRET_PATTERNS: readonly string[] = [
  '\\bAKIA[0-9A-Z]{16}',
  '\\bgh[pousr]_[A-Za-z0-9]{20,}',
  '\\bgithub_pat_\\w{20,}',
  '\\bglpat-[\\w-]{16,}',
  '\\bsk[-_](?:live_|test_)?[A-Za-z0-9_-]{16,}',
  '\\bAIza[\\w-]{30,}',
  '\\bnpm_[A-Za-z0-9]{30,}',
  '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY',
  '\\beyJ[\\w-]{10,}\\.[\\w-]{10,}',
  '\\bBearer\\s+[\\w.~+/-]{16,}',
  // A user and password in a URL (`redis://:pw@host`), or for curl (`-u user:pw`; a password
  //   with a letter in it, so `-u 1000:1000` is no secret).
  // A scheme is short: an unbounded one made this pattern quadratic (K1b review: 64 KB of
  //   `a.a.…` took seconds).
  '\\b[a-z][\\w+.-]{0,30}://[^\\s:@/]*:[^\\s@/]+@',
  '(?<![\\w-])(?:-u|--user)[=\\s]+[^\\s:@]+:(?=[^\\s@]*[A-Za-z])[^\\s@]+',
  // A Slack incoming webhook is its own secret.
  '\\bhooks\\.slack\\.com/services/[\\w/]{10,}',
  // `password = x`, `"token": "x"`: a value with a letter in it (a token count is no secret);
  //   `--password x` as a flag.
  '(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)["\']?\\s*[:=]\\s*["\']?(?=[^\\s"\']*[A-Za-z])[^\\s"\',;]{6,}',
  '--(?:password|passwd|token|secret|api-key)[=\\s]+\\S{4,}',
];

/** A new global, case-blind matcher for every pattern. */
export function secretRe(): RegExp {
  return new RegExp(SECRET_PATTERNS.join('|'), 'gi');
}

/** The text with each secret replaced by `[secret]`. */
export function maskSecrets(text: string): string {
  return text.replace(secretRe(), '[secret]');
}

/** The first `n` characters of text to keep, masked on a window a little past the cut, so a
 *  secret that spans the cut is still caught, and never on the whole text (masking long text
 *  is slow; K1b review). */
export function maskedClip(s: string, n: number): string {
  return maskSecrets(s.slice(0, n + 200)).slice(0, n);
}
