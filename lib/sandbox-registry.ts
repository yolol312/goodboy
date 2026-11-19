// The user-level registry of real-data sandboxes (track M, M6b; plan §19): `<HOME>/.claude/goodboy/sandbox/real-data.json`.
// The PreToolUse rule of lib/sandbox-data-guard.ts guards a project from what its own `local.json` says, and
// finds that file by walking up from the dirs of the session. A project the session does not stand in (a nested
// repo below a non-repo project dir), a deleted `.goodboy/sandbox`, and a deleted or corrupt `local.json` would
// then lose the protection of its dump, its input logs and its containers. The registry keeps, outside the
// project, who holds real data: the sandbox commands write it, the hook reads it and guards every entry's own
// project name and protected paths wherever the shell is.
//
// An entry never loses a path: every dump and input path ever registered for a project stays (`paths`, with the
// resolved real path of each, NFC-normalized, stored at write time so the hook never resolves them per call; `dirs`
// are those that were directories), a later write merges into the entry and never replaces it. At most 200 paths
// for a project (past it a write is refused, none is dropped) and 100 projects (a full registry refuses a new one).
// Entries are never removed: that would be a project that went back to plain with no dump and no input, and there
// is no command for that yet. Writers are serialized by a lock file (O_EXCL, retried for 1.5 s, a stale lock is moved aside and taken
// over), so two commands cannot drop each other's entry. A registry that cannot be read is "unknown": the rule then
// keeps the per-repo reading, the hook logs it, and the sandbox commands report it.
//
// Light on purpose (no renderer, no scanner): the hook loads it on every tool call.

import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readRegular } from './safe-read';
import { projectName, realOrSelf } from './sandbox-mode';
import type { SandboxLocal } from './sandbox-types';

export interface RegistryEntry {
  /** The project's real path. */
  top: string;
  /** Its compose project name (`gb-<slug>-<hash>`). */
  project: string;
  /** The dump the last write named, or the one before it when the last named none. */
  dump: string | null;
  /** Every input path ever registered. */
  inputs: string[];
  /** Every dump and input path ever registered, each as typed and as resolved, NFC-normalized. */
  paths: string[];
  /** Those of `paths` that were directories when they were written. */
  dirs: string[];
}

export type RegistryErrorCode = 'unreadable' | 'full' | 'too-many-paths' | 'busy' | 'write-failed';

/** An error of the registry with a code to tell it by (the sandbox commands print the code, never the message). */
export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const REGISTRY_MAX = 100;
export const REGISTRY_MAX_PATHS = 200;
const MAX_BYTES = 8 * 1024 * 1024;
const LOCK_STALE_MS = 10_000;
const LOCK_TRIES = 60;
const LOCK_WAIT_MS = 25;

const nfc = (p: string): string => p.normalize('NFC');

/** What the registry keeps of a project: its real path and project name, the dump and inputs its local file names
 *  and, resolved now, every path of them (as typed and as resolved, NFC) and which are directories. */
export function registryEntryOf(root: string, local: SandboxLocal): RegistryEntry {
  const named = [...(local.dump !== null ? [local.dump] : []), ...(local.inputs ?? [])];
  const paths = new Set<string>();
  const dirs = new Set<string>();
  for (const p of named) {
    for (const v of new Set([resolve(p), realOrSelf(p)])) {
      paths.add(nfc(v));
      try {
        if (statSync(v).isDirectory()) dirs.add(nfc(v));
      } catch {
        // not there (yet)
      }
    }
  }
  return { top: realOrSelf(root), project: projectName(root), dump: local.dump, inputs: [...(local.inputs ?? [])], paths: [...paths], dirs: [...dirs] };
}

/** The registry's dir: GOODBOY_REGISTRY_DIR (tests), else `<HOME>/.claude/goodboy/sandbox` (HOME as the inbox of
 *  lib/field-report.ts reads it). */
export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
  const o = (env.GOODBOY_REGISTRY_DIR ?? '').trim();
  return o !== '' ? resolve(o) : join((env.HOME ?? '').trim() || homedir(), '.claude', 'goodboy', 'sandbox');
}

export const registryFile = (env: NodeJS.ProcessEnv = process.env): string => join(registryDir(env), 'real-data.json');

const absStrings = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && isAbsolute(x));

const isEntry = (e: unknown): e is RegistryEntry => {
  const o = e as Partial<RegistryEntry> | null;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.top === 'string' &&
    isAbsolute(o.top) &&
    typeof o.project === 'string' &&
    /^gb-[a-z0-9-]+$/.test(o.project) &&
    (o.dump === null || (typeof o.dump === 'string' && isAbsolute(o.dump))) &&
    absStrings(o.inputs, 50 * REGISTRY_MAX_PATHS) &&
    absStrings(o.paths, REGISTRY_MAX_PATHS) &&
    absStrings(o.dirs, REGISTRY_MAX_PATHS)
  );
};

/** The entries; none when there is no file; an error with code `unreadable` when the file cannot be read as the
 *  registry (a link, a non-regular file, a size over the cap, text that is not what goodboy wrote). */
export function readRegistry(env: NodeJS.ProcessEnv = process.env): RegistryEntry[] | RegistryError {
  const r = readRegular(registryFile(env), MAX_BYTES, true);
  if (r === 'absent') return [];
  if (r === 'refused') return new RegistryError('unreadable', 'the registry of real-data sandboxes is not a regular file');
  try {
    const j = JSON.parse(r.text) as { schema?: unknown; entries?: unknown };
    if (j.schema === 1 && Array.isArray(j.entries) && j.entries.length <= REGISTRY_MAX && j.entries.every(isEntry)) return j.entries;
  } catch {
    // below
  }
  return new RegistryError('unreadable', 'the registry of real-data sandboxes is not a file goodboy wrote');
}

/** The entry with its fields in the order the file keeps them (so two writes of one content are one text). */
const canonical = (e: RegistryEntry): RegistryEntry => ({ top: e.top, project: e.project, dump: e.dump, inputs: [...e.inputs], paths: [...e.paths], dirs: [...e.dirs] });

/** `old` with `next` merged in: every path of both, the latest dump (the old one when `next` has none). */
function merged(old: RegistryEntry, next: RegistryEntry): RegistryEntry {
  const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
  return { top: old.top, project: next.project, dump: next.dump ?? old.dump, inputs: union(old.inputs, next.inputs), paths: union(old.paths, next.paths), dirs: union(old.dirs, next.dirs) };
}

const same = (a: RegistryEntry, b: RegistryEntry): boolean => JSON.stringify(a) === JSON.stringify(b);

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A lock older than 10 s is taken over by moving it aside (a rename: one contender gets that file). What was moved may be a
 *  fresh lock made after the age was read; it is then put back when nothing has taken its place. The window between the age and
 *  the rename remains (a limit: two contenders and a lock made in between), and is a few microseconds. */
function takeOverStale(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return;
    const aside = `${lock}.stale.${process.pid}.${Date.now()}`;
    renameSync(lock, aside);
    try {
      if (Date.now() - statSync(aside).mtimeMs <= LOCK_STALE_MS) linkSync(aside, lock);
    } catch {
      // another lock is already in its place
    }
    unlinkSync(aside);
  } catch {
    // gone meanwhile
  }
}

/** Runs `f` holding the registry's lock file: made with O_EXCL and a token of its own, retried for 1.5 s (60 tries, 25 ms
 *  apart), a lock older than 10 s taken over. The lock is removed only when it still holds our token (it may have been taken
 *  over as stale meanwhile). A `busy` error when it could not be had. */
function withLock<T>(dir: string, f: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, 'real-data.lock');
  const mine = `${process.pid}:${randomBytes(6).toString('hex')}\n`;
  for (let i = 0; i < LOCK_TRIES; i++) {
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      takeOverStale(lock);
      pause(LOCK_WAIT_MS);
      continue;
    }
    try {
      writeSync(fd, mine);
      return f();
    } finally {
      closeSync(fd);
      try {
        if (readFileSync(lock, 'utf8') === mine) unlinkSync(lock);
      } catch {
        // taken over as stale
      }
    }
  }
  throw new RegistryError('busy', 'the registry of real-data sandboxes is locked by another command');
}

/** Adds the entry, or merges it into the one of the same `top` (never replaces it); the file is written only when
 *  something changed, through a temp name and a rename, mode 0600 in a dir of mode 0700, under the lock. A
 *  RegistryError (never thrown) when the registry cannot be read, is full for a new `top`, would hold more than
 *  200 paths for the project, is locked, or cannot be written. */
export function registerRealData(entry: RegistryEntry, env: NodeJS.ProcessEnv = process.env): RegistryError | null {
  const dir = registryDir(env);
  const file = registryFile(env);
  const tmp = join(dir, `.real-data.${process.pid}.${Date.now()}.tmp`);
  try {
    return withLock(dir, () => {
      const have = readRegistry(env);
      if (have instanceof RegistryError) return have;
      const at = have.findIndex((e) => e.top === entry.top);
      const next = at >= 0 ? merged(have[at]!, entry) : canonical(entry);
      if (next.paths.length > REGISTRY_MAX_PATHS) {
        return new RegistryError('too-many-paths', `the registry of real-data sandboxes would hold more than ${REGISTRY_MAX_PATHS} paths for one project; goodboy never drops a path: remove the entry from ${file} by hand if those files are gone`);
      }
      if (at >= 0 && same(have[at]!, next)) return null;
      if (at < 0 && have.length >= REGISTRY_MAX) {
        return new RegistryError('full', `the registry of real-data sandboxes is full (${REGISTRY_MAX} projects); goodboy never drops an entry: remove ${file} by hand if those projects are gone`);
      }
      // (a link at `file` was refused by readRegistry above; the rename below replaces a link, it never writes through it)
      const entries = at >= 0 ? have.map((e, i) => (i === at ? next : e)) : [...have, next];
      writeFileSync(tmp, `${JSON.stringify({ schema: 1, entries }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(tmp, file);
      return null;
    });
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // not made
    }
    return err instanceof RegistryError ? err : new RegistryError('write-failed', err instanceof Error ? err.message : String(err));
  }
}
