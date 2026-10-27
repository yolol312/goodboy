// Which `git` the hooks run (v0.36.6, gate cost). On macOS `/usr/bin/git` is not git but a shim
// that asks xcode-select for the real one on every call: about 20-40 ms before git starts, which
// made a Stop with 25 git calls cost most of its time. `xcrun --find git` names the real binary;
// running that directly skips the shim. Used only when the first `git` on PATH is exactly
// `/usr/bin/git`: any other PATH git (Homebrew, a test's fake) is already a direct binary and is
// kept. Anything unexpected falls back to plain `git`, as before. No cache file: the answer lives
// in a module variable for as long as the variables that select it stay the same.

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

const SHIM = '/usr/bin/git';
const XCRUN = '/usr/bin/xcrun';
/** `xcrun --find` takes ~20 ms; a stall must not cost a hook its budget. */
const XCRUN_TIMEOUT_MS = 2_000;
/** What `xcrun` reads to choose a developer directory or toolchain. */
const SELECTORS = ['PATH', 'DEVELOPER_DIR', 'SDKROOT', 'TOOLCHAINS', 'XCODE_DEVELOPER_DIR_PATH'] as const;

type Env = Record<string, string | undefined>;

export interface GitBinaryOptions {
  /** Defaults to the running platform (a test's). */
  platform?: string;
  /** Defaults to /usr/bin/xcrun (a test's fake). */
  xcrun?: string;
  /** Defaults to /usr/bin/git. */
  shim?: string;
  /** The limit for `xcrun`, ms (a test's). */
  timeoutMs?: number;
}

let memo: { key: string; bin: string } | null = null;

/** Forgets the answer (a test's). */
export function resetGitBinary(): void {
  memo = null;
}

const executableFile = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The first `git` file on PATH as PATH spells it (a symlink is not followed: `/usr/local/bin/git`
 *  pointing at the shim is not the shim's own path); an empty entry is the cwd. */
function firstGitOnPath(env: Env, cwd: string): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir === '' ? '.' : dir, 'git');
    const abs = isAbsolute(candidate) ? candidate : join(cwd, candidate);
    if (executableFile(abs)) return abs;
  }
  return null;
}

/** The output of `xcrun --find git` as a path, or null unless it is one absolute line naming a
 *  regular executable file. */
function xcrunPath(stdout: string): string | null {
  const text = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (text === '' || /[\n\r\0]/.test(text) || !isAbsolute(text)) return null;
  return executableFile(text) ? text : null;
}

/** The command to run for git: an absolute path of the real binary on macOS behind the
 *  `/usr/bin/git` shim, else `git`. Called with the environment and the directory of the git call
 *  that follows. Never throws. */
export function resolveGitBinary(env: Env, cwd: string, opts: GitBinaryOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin') return 'git';
  const key = [...SELECTORS.map((k) => env[k] ?? ''), cwd, opts.xcrun ?? '', opts.shim ?? ''].join('\0');
  if (memo?.key === key) return memo.bin;
  const bin = resolveNow(env, cwd, opts);
  memo = { key, bin };
  return bin;
}

function resolveNow(env: Env, cwd: string, opts: GitBinaryOptions): string {
  try {
    if (firstGitOnPath(env, cwd) !== (opts.shim ?? SHIM)) return 'git';
    const r = Bun.spawnSync([opts.xcrun ?? XCRUN, '--find', 'git'], {
      cwd,
      env: env as Record<string, string>,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: opts.timeoutMs ?? XCRUN_TIMEOUT_MS,
    });
    if (r.exitCode !== 0 || r.exitedDueToTimeout) return 'git';
    return xcrunPath(r.stdout.toString()) ?? 'git';
  } catch {
    return 'git';
  }
}
