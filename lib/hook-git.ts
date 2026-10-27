// Settings for every git a goodboy hook runs in the model's repo (final G1 test rounds). Such a
// git runs outside any model Bash call, so a program the repo's config names would make files
// the guards take as the user's (a Stop approval marker): fsmonitor, gpg.program behind
// log.showSignature, the upload-pack of a partial clone's lazy fetch, a clean filter.
// Every site runs git through lib/git-run.ts, which applies the settings below.

/** No fsmonitor, no signature check. */
export const HOOK_GIT_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false'];

/** No transport: reading a missing object in a partial clone fetches it, running
 *  `remote.<name>.uploadpack`. GIT_ALLOW_PROTOCOL (any git) overrides every `protocol.*`
 *  setting; GIT_NO_LAZY_FETCH needs git 2.44. */
export const HOOK_GIT_ENV: Readonly<Record<string, string>> = { GIT_ALLOW_PROTOCOL: 'goodboy-none', GIT_NO_LAZY_FETCH: '1' };

/** No grafts: `.git/info/grafts` rewrites history like a replace ref (with
 *  `--no-replace-objects`, for the git whose diffs and ancestry are evidence: track I, I1). */
export const NO_GRAFTS: Readonly<Record<string, string>> = { GIT_GRAFT_FILE: '/dev/null' };

/** `-c` settings that empty every filter driver the repo's config names (`git status` runs
 *  a clean filter to hash a touched file), from `git config --name-only --get-regexp
 *  '^filter\.'` output. */
export function filterOffArgs(configNames: string): string[] {
  const drivers = new Set<string>();
  for (const line of configNames.split('\n')) {
    const m = line.trim().match(/^filter\.(.+)\.[^.]+$/i);
    if (m) drivers.add(m[1]!);
  }
  return [...drivers].flatMap((d) => ['-c', `filter.${d}.clean=`, '-c', `filter.${d}.process=`, '-c', `filter.${d}.required=false`]);
}

/** An alias value split into words as git splits it (split_cmdline): blanks separate words;
 *  single quotes, double quotes and backslashes group and escape (`'commit' -m x`). */
export function splitAliasValue(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let word = false;
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < value.length) cur += value[++i];
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (word) out.push(cur);
      cur = '';
      word = false;
      continue;
    }
    word = true;
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\' && i + 1 < value.length) cur += value[++i];
    else cur += c;
  }
  if (word) out.push(cur);
  return out;
}
