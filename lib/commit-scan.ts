// Commit and push scan (track M, M6f; plan §19): in a project that holds real data, what a `git commit` would put
// into a commit and what a `git push` would send out is scanned for the shapes of lib/pii-patterns.ts (resident and
// business numbers, cards, phones, emails, secrets), and a file, blob or message that cannot be scanned (binary
// content or type, not UTF-8, over 4 MB, past a budget, a command whose tree cannot be told) is reported as not
// scanned, not as clean. A hit names the file, the line and the kind, never the value; the paths shown are redacted
// too. This module is the scanner and the report; the PreToolUse side (reading `git commit` / `git push` commands)
// is lib/commit-scan-guard.ts and the git hooks and CLI commands are lib/git-hooks.ts.
//
// What is scanned:
//   - A commit: the exact tree it would store, read without writing anything. A plain commit is the index against
//     HEAD (`diff-index --cached`); `-a` is the work tree against HEAD for every tracked file; a commit with paths is
//     the work tree of those paths against HEAD (`--only`), or the index plus those paths (`--include`); `--amend`
//     compares against HEAD's parent, so the commit being replaced counts. The message (`-m`, `--message`, `--trailer`,
//     a `-F` file, a heredoc), and every path. Blobs are read by id with `cat-file --batch`; a work-tree file is
//     read from disk (a symlink is its target, as git stores it; a `-F` link is followed to the file git reads). Only
//     what differs from the base is read.
//   - A push: every outgoing ref and every newly reachable object: `rev-list --objects <refs> --not --remotes=<name>`
//     for a configured remote name, and for a URL the remote (or remotes) whose `url` or `pushurl` is that exact string;
//     a URL no remote has, and an unknown name, exclude nothing but the hook's own old ids (the content another remote
//     has is not what this one has). The blobs, the commit and tag messages (the text after the headers, so the
//     author's own address is no hit) and the paths.
// Clean filters run by no goodboy git (lib/git-run.ts): a repo that rewrites content on `add` is scanned as the
// work tree has it.
//
// Budgets: 4 MB per blob, 64 MB and 20000 blobs per call, a time limit that stops at the hook's clock; what is left
// when one runs out is one entry "not scanned". Every entry of the report is bound to its content: the digest is
// the first 16 hex of the SHA-256 of the sorted `path, content id, kind` list, which the user's approval carries.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnGit } from './git-run';
import { hookLeft } from './hook-clock';
import { findSensitive, redactText, type SensitiveKind } from './pii-patterns';
import { readRegular } from './safe-read';
import { realDataForReading, realOrSelf, SANDBOX_DIR } from './sandbox-mode';
import { readRegistry, RegistryError } from './sandbox-registry';

const MAX_BLOB = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_BLOBS = 20_000;
/** The most objects a push may list before the scan gives up (trees and commits count). */
const MAX_OBJECTS = 200_000;
/** The most hits a report keeps (more are counted, and the call stays blocked). */
const MAX_HITS = 5000;
/** The most `path:line kind` entries a denial prints. */
const SHOWN = 20;
const SNIFF = 8192;
/** What one `cat-file --batch` call reads at most (memory). */
const BATCH_BYTES = 16 * 1024 * 1024;
const ZEROS = /^0+$/;
export const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface ScanLimits {
  maxBlob: number;
  maxBytes: number;
  maxBlobs: number;
  /** ms from now; the hook's clock ends it earlier. */
  timeMs: number;
}
export const DEFAULT_LIMITS: ScanLimits = { maxBlob: MAX_BLOB, maxBytes: MAX_SCAN_BYTES, maxBlobs: MAX_SCAN_BLOBS, timeMs: 40_000 };

/** File types read as binary whatever their bytes (images, archives, documents, binaries, media, fonts, databases). */
const BINARY_EXT: ReadonlySet<string> = new Set(
  ('.png .jpg .jpeg .gif .webp .ico .bmp .avif .heic .tif .tiff .psd .sketch .pdf .zip .gz .tgz .tar .7z .rar .xz .bz2 .zst .jar .war .class .exe .dll .so .dylib .bin .wasm ' +
    '.mp3 .mp4 .mov .avi .mkv .webm .wav .ogg .flac .m4a .woff .woff2 .ttf .otf .eot .sqlite .sqlite3 .db .mdb .pyc .o .a .lib .iso .dmg .pkl .npy .npz .parquet .avro ' +
    '.xls .xlsx .doc .docx .ppt .pptx .hwp .hwpx .odt .ods').split(' '),
);

interface ScanHit {
  /** Redacted for display. */
  path: string;
  /** 0 is the file name itself. */
  line: number;
  kind: SensitiveKind;
}
interface ScanUnscanned {
  path: string;
  why: string;
}
export interface ScanReport {
  hits: ScanHit[];
  /** Hits past the report's cap (counted, not listed). */
  moreHits: number;
  unscanned: ScanUnscanned[];
  /** The approval digest: 16 hex of the sorted `path, content id, kind` entries. */
  digest: string;
  /** Any hit or anything not scanned. */
  blocked: boolean;
  scanned: { blobs: number; bytes: number };
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Everything one call finds, and the budgets it runs under. */
export class Acc {
  private hitMap = new Map<string, { real: string; key: string; hit: ScanHit }>();
  private unMap = new Map<string, { real: string; key: string; item: ScanUnscanned }>();
  private skipped: string[] = [];
  private more = 0;
  bytes = 0;
  blobs = 0;
  /** Why the scan stopped taking objects (a budget), or null. */
  stopped: string | null = null;
  private readonly deadline: number;
  /** `salt`: text every `unclear` reason of this call is bound to (the PreToolUse scan binds them to the command; the git
   *  hooks leave it empty). */
  constructor(
    readonly limits: ScanLimits = DEFAULT_LIMITS,
    readonly salt = '',
  ) {
    this.deadline = Date.now() + limits.timeMs;
  }

  /** Ms left of this call's own time (at least 1). */
  left(): number {
    return Math.max(1, this.deadline - Date.now());
  }

  /** The time ran out: this call's own, or the hook's clock (with a margin for the denial and the output). */
  expired(): boolean {
    return Date.now() > this.deadline || hookLeft() < 1500;
  }

  hit(path: string, key: string, kind: SensitiveKind, line: number): void {
    const id = `${path}\0${key}\0${kind}\0${line}`;
    if (this.hitMap.has(id)) return;
    if (this.hitMap.size >= MAX_HITS) {
      this.more++;
      return;
    }
    this.hitMap.set(id, { real: path, key, hit: { path: redactText(path), line, kind } });
  }

  unscanned(path: string, key: string, why: string): void {
    this.unMap.set(`${path}\0${key}\0${why}`, { real: path, key, item: { path: redactText(path), why } });
  }

  /** An object the scan did not reach (a budget ran out); all of them are one entry of the report. */
  skip(key: string): void {
    this.skipped.push(key);
  }

  /** Scans decoded text: a hit per sensitive span, at the line it starts on. `own`: for a commit or tag message, the
   *  addresses (lower case) that are the object's own author, committer or tagger; an email that is one of those, or a
   *  no-reply address, is no hit, on any line. Every other email, and every other kind, still is. */
  text(path: string, key: string, text: string, own?: ReadonlySet<string>): void {
    const spans = findSensitive(text);
    let line = 1;
    let from = 0;
    for (const s of spans) {
      if (own !== undefined && s.kind === 'email' && exemptAddress(text.slice(s.start, s.end), own)) continue;
      for (let nl = text.indexOf('\n', from); nl !== -1 && nl < s.start; nl = text.indexOf('\n', from)) {
        line++;
        from = nl + 1;
      }
      this.hit(path, key, s.kind, line);
    }
  }

  /** The path itself is text too (line 0). */
  pathName(path: string, key: string): void {
    for (const s of findSensitive(path)) this.hit(path, key, s.kind, 0);
  }

  /** Scans content: text is scanned, anything else is "not scanned" with the reason. */
  bytesOf(path: string, key: string, buf: Buffer): void {
    const t = textOf(buf);
    if ('why' in t) this.unscanned(path, key, t.why);
    else this.text(path, key, t.text);
  }

  /** Counts a blob of `size` against the budgets; false (and the object skipped) when one is spent. */
  take(key: string, size: number): boolean {
    if (this.stopped === null && this.expired()) this.stopped = 'time';
    if (this.stopped === null && (this.blobs + 1 > this.limits.maxBlobs || this.bytes + size > this.limits.maxBytes)) this.stopped = 'size';
    if (this.stopped !== null) {
      this.skip(key);
      return false;
    }
    this.blobs++;
    this.bytes += size;
    return true;
  }

  report(): ScanReport {
    const lines = new Set<string>();
    for (const { real, key, hit } of this.hitMap.values()) lines.add(`${real}\0${key}\0${hit.kind}`);
    const unscanned: ScanUnscanned[] = [...this.unMap.values()].map((u) => u.item);
    for (const { real, key, item } of this.unMap.values()) lines.add(`${real}\0${key}\0unscanned:${item.why}`);
    if (this.skipped.length > 0) {
      const why = this.stopped === 'time' ? 'the time budget ran out' : 'the size budget ran out';
      const key = sha([...this.skipped].sort().join('\n'));
      unscanned.push({ path: `<${this.skipped.length} objects>`, why });
      lines.add(`<objects>\0${key}\0unscanned:${why}`);
    }
    if (this.more > 0) lines.add(`<more hits>\0${this.more}\0more`);
    const hits = [...this.hitMap.values()].map((h) => h.hit).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    const digest = sha([...lines].sort().join('\n')).slice(0, 16);
    return { hits, moreHits: this.more, unscanned, digest, blocked: hits.length > 0 || unscanned.length > 0 || this.more > 0, scanned: { blobs: this.blobs, bytes: this.bytes } };
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** An address a message may carry without being a hit: a no-reply address (local part `noreply` or `no-reply`, with an
 *  optional `+tag`, or a `users.noreply.github.com` address: the Claude Code and GitHub attribution trailers), or one of
 *  the object's own addresses. Exact, case-insensitive. */
const NO_REPLY = /^no-?reply(?:\+[^@]*)?@[^@]+$|^[^@]+@(?:[^@]*\.)?users\.noreply\.github\.com$/i;
function exemptAddress(address: string, own: ReadonlySet<string>): boolean {
  return NO_REPLY.test(address) || own.has(address.toLowerCase());
}

/** The addresses in `<…>` of the `author`, `committer` and `tagger` header lines of a commit or tag object. */
function headerAddresses(headers: string): Set<string> {
  const out = new Set<string>();
  for (const line of headers.split('\n')) {
    const m = /^(?:author|committer|tagger) .*<([^<>]*)>/.exec(line);
    if (m !== null) out.add(m[1]!.toLowerCase());
  }
  return out;
}

/** What the configured identity must not see: the command's own `-c` and environment (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`
 *  and its keys, `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `EMAIL`), which a git hook inherits from the commit it runs for. */
const IDENTITY_ENV = /^(?:GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_AUTHOR_\w+|GIT_COMMITTER_\w+|EMAIL)$/;

/** The address of `git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT`, read as the repo's own configuration says (the
 *  repo-locating options of the command only, no `-c`, none of IDENTITY_ENV): who a commit is by when nothing in the command
 *  says otherwise. One git call each; one that fails gives none. */
function ownAddresses(repo: Repo, acc: Acc): Set<string> {
  const out = new Set<string>();
  const globals: string[] = [];
  for (let i = 0; i < repo.globals.length; i++) {
    if (repo.globals[i] === '-c') i++;
    else globals.push(repo.globals[i]!);
  }
  for (const v of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const r = git({ dir: repo.dir, globals }, ['var', v], { acc, unsetEnv: IDENTITY_ENV });
    const m = r === null ? null : /<([^<>]*)>/.exec(r.out);
    if (m !== null) out.add(m[1]!.toLowerCase());
  }
  return out;
}

/** Whether the environment git gave a hook carries an identity of the commit that overrides the configured one. */
export function identityOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  if (Object.keys(env).some((k) => /^(?:GIT_AUTHOR_(?:NAME|EMAIL)|GIT_COMMITTER_(?:NAME|EMAIL)|EMAIL)$/.test(k) && (env[k] ?? '') !== '')) return true;
  const named = /(?:user|author|committer)\.(?:name|email)/i;
  if (named.test(env.GIT_CONFIG_PARAMETERS ?? '')) return true;
  return Object.keys(env).some((k) => /^GIT_CONFIG_KEY_\d+$/.test(k) && named.test(env[k] ?? ''));
}

/** The commit-msg hook, when git's environment overrides the identity: the identity the commit will have (`git var`, with that
 *  environment) is scanned as text at `<author>`; the configured identity's own address is exempt. */
export function scanIdentity(repo: Repo, acc: Acc): void {
  const own = ownAddresses(repo, acc);
  for (const v of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const r = git(repo, ['var', v], { acc });
    if (r === null) {
      unclear(acc, '<author>', 'git could not tell the author of this commit');
      continue;
    }
    // `Name <address> <seconds> <zone>`: the date is no identity
    const text = r.out.trim().replace(/>[^>]*$/, '>');
    acc.text('<author>', sha(text), text, own);
  }
}

/** The text of `buf` to scan, or why it is not scanned (a binary file type and the size limit are checked before a file is read). */
function textOf(buf: Buffer): { text: string } | { why: string } {
  if (buf.subarray(0, SNIFF).includes(0)) return { why: 'binary content' };
  try {
    return { text: UTF8.decode(buf) };
  } catch {
    return { why: 'not valid UTF-8' };
  }
}

/** The git object id of `buf` as a blob, in the repo's hash. */
function blobId(buf: Buffer, format: 'sha1' | 'sha256'): string {
  return createHash(format).update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// ---- git ----

export interface Repo {
  /** Where git runs (relative pathspecs resolve from here). */
  dir: string;
  /** The `-c` settings and repo options of the command, as git arguments. */
  globals: string[];
  /** The work tree's top, real path. */
  top: string;
  format: 'sha1' | 'sha256';
}

/** One git call under the scan's clock: its output, or null when it failed, was cut off or printed more than
 *  `maxBuffer`. */
function git(repo: { dir: string; globals: string[] }, args: string[], opts: { input?: string; maxBuffer?: number; acc?: Acc; unsetEnv?: RegExp } = {}): { out: string; raw: Buffer } | null {
  const left = opts.acc === undefined ? 20_000 : Math.min(30_000, opts.acc.left());
  const r = spawnGit(repo.dir, [...repo.globals, ...args], { timeoutMs: left, noMemo: true, ...(opts.input !== undefined ? { input: opts.input } : {}), ...(opts.maxBuffer !== undefined ? { maxBuffer: opts.maxBuffer } : {}), ...(opts.unsetEnv !== undefined ? { unsetEnv: opts.unsetEnv } : {}) });
  if (r.stalled || r.code !== 0) return null;
  return { out: r.out, raw: r.raw };
}

/** The repo `dir` is in (with the command's `-c` and repo options), or null: no repo, a bare repo, git gave no answer. */
export function repoOf(dir: string, globals: string[] = []): Repo | null {
  const top = git({ dir, globals }, ['rev-parse', '--show-toplevel']);
  if (top === null || top.out.trim() === '') return null;
  const f = git({ dir, globals }, ['rev-parse', '--show-object-format']);
  return { dir, globals, top: top.out.trim(), format: f?.out.trim() === 'sha256' ? 'sha256' : 'sha1' };
}

const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };

/** One changed file of a commit: where its content is. */
interface Entry {
  path: string;
  /** A blob id, or null for the work tree's file. */
  id: string | null;
}

/** The files `git diff-index` lists (`:oldmode newmode oldid newid status\0path\0`); a deleted file and a submodule
 *  are not content. `undefined` when git failed. */
function diffIndex(repo: Repo, args: string[], pathspecs: string[], acc: Acc): Entry[] | undefined {
  const r = git(repo, ['diff-index', '-z', '--raw', '--no-abbrev', '--no-renames', '--ignore-submodules=none', ...args, '--', ...pathspecs], { maxBuffer: 64 * 1024 * 1024, acc });
  if (r === null) return undefined;
  const f = r.out.split('\0');
  const out: Entry[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(f[i]!);
    if (m === null) return undefined;
    const status = m[5]!;
    const mode = m[2]!;
    if (status === 'D' || mode === '160000') continue;
    out.push({ path: f[i + 1]!, id: ZEROS.test(m[4]!) ? null : m[4]! });
  }
  return out;
}

/** `git cat-file --batch-check` of ids: the type and size of each, or undefined when git failed. */
function checkObjects(repo: Repo, ids: string[], acc: Acc): Map<string, { type: string; size: number }> | undefined {
  const out = new Map<string, { type: string; size: number }>();
  if (ids.length === 0) return out;
  const r = git(repo, ['cat-file', '--batch-check'], { input: `${ids.join('\n')}\n`, maxBuffer: 64 * 1024 * 1024, acc });
  if (r === null) return undefined;
  for (const l of r.out.split('\n')) {
    const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(l);
    if (m !== null) out.set(m[1]!, { type: m[2]!, size: Number(m[3]) });
  }
  return out;
}

interface BlobItem {
  id: string;
  path: string;
  size?: number;
}

/** Scans blobs by id: each is read once, with a size, a type and budget check before it is read. */
function scanBlobs(repo: Repo, items: BlobItem[], acc: Acc): void {
  const known = new Map<string, { type: string; size: number }>();
  const need = items.filter((i) => i.size === undefined).map((i) => i.id);
  if (need.length > 0) {
    const checked = checkObjects(repo, [...new Set(need)], acc);
    if (checked === undefined) {
      for (const i of items) if (i.size === undefined) acc.unscanned(i.path, i.id, 'git could not read the object');
      items = items.filter((i) => i.size !== undefined);
    } else for (const [k, v] of checked) known.set(k, v);
  }
  const fetch: Array<BlobItem & { size: number }> = [];
  for (const i of items) {
    acc.pathName(i.path, i.id);
    const meta = i.size !== undefined ? { type: 'blob', size: i.size } : known.get(i.id);
    if (meta === undefined) {
      acc.unscanned(i.path, i.id, 'object missing');
      continue;
    }
    if (meta.type !== 'blob') {
      acc.unscanned(i.path, i.id, 'not a file');
      continue;
    }
    if (BINARY_EXT.has(extname(i.path).toLowerCase())) {
      acc.unscanned(i.path, i.id, 'binary file type');
      continue;
    }
    if (meta.size > acc.limits.maxBlob) {
      acc.unscanned(i.path, i.id, 'over the size limit');
      continue;
    }
    if (acc.take(i.id, meta.size)) fetch.push({ ...i, size: meta.size });
  }
  for (let from = 0; from < fetch.length; ) {
    let to = from;
    let sum = 0;
    while (to < fetch.length && (to === from || sum + fetch[to]!.size <= BATCH_BYTES)) sum += fetch[to++]!.size;
    const batch = fetch.slice(from, to);
    from = to;
    if (acc.expired()) {
      for (const b of batch) acc.skip(b.id);
      acc.stopped ??= 'time';
      continue;
    }
    const r = git(repo, ['cat-file', '--batch'], { input: `${batch.map((b) => b.id).join('\n')}\n`, maxBuffer: sum + batch.length * 160 + 1024, acc });
    if (r === null) {
      for (const b of batch) acc.unscanned(b.path, b.id, 'git could not read the object');
      continue;
    }
    const read = splitBatch(r.raw, batch.map((b) => b.id), 'blob');
    batch.forEach((b, k) => {
      const body = read[k];
      // a header that is not the one asked for loses the place in the output: this object and the rest are not read
      if (body === null) acc.unscanned(b.path, b.id, 'git could not read the object');
      else acc.bytesOf(b.path, b.id, body);
    });
  }
}

/** The bodies of a `cat-file --batch` output, in the order of `ids` (`<id> <type> <size>\n<body>\n` each). From the first
 *  header that is not the next id's (or has another type), every body is null: the place in the output is lost. */
function splitBatch(raw: Buffer, ids: string[], types: 'blob' | 'commit-tag'): Array<Buffer | null> {
  const want = types === 'blob' ? /^([0-9a-f]+) blob (\d+)$/ : /^([0-9a-f]+) (?:commit|tag) (\d+)$/;
  const out: Array<Buffer | null> = ids.map(() => null);
  let at = 0;
  for (let k = 0; k < ids.length; k++) {
    const nl = raw.indexOf(0x0a, at);
    const m = want.exec(nl < 0 ? '' : raw.subarray(at, nl).toString('latin1'));
    if (nl < 0 || m === null || m[1] !== ids[k]) break;
    const size = Number(m[2]);
    if (nl + 1 + size > raw.length) break;
    out[k] = raw.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
  }
  return out;
}

/** A file of the work tree: its bytes (a symlink is its target), or why not. */
function readWork(abs: string, limits: ScanLimits): { buf: Buffer } | { big: string } | { why: string } {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { why: 'file not readable' };
  }
  if (st.isSymbolicLink()) {
    try {
      return { buf: Buffer.from(readlinkSync(abs, 'buffer')) };
    } catch {
      return { why: 'file not readable' };
    }
  }
  if (!st.isFile()) return { why: 'not a regular file' };
  if (st.size > limits.maxBlob) return { big: `stat:${st.size}:${Math.floor(st.mtimeMs)}` };
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return { why: 'file not readable' };
  }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > limits.maxBlob) return { why: 'file not readable' };
    const buf = Buffer.alloc(fst.size);
    let got = 0;
    while (got < buf.length) {
      const k = readSync(fd, buf, got, buf.length - got, got);
      if (k === 0) break;
      got += k;
    }
    return { buf: buf.subarray(0, got) };
  } catch {
    return { why: 'file not readable' };
  } finally {
    closeSync(fd);
  }
}

/** Scans work-tree files of the entries (their content is the file as it is now). */
function scanWorkFiles(repo: Repo, paths: string[], acc: Acc): void {
  for (const p of paths) {
    acc.pathName(p, 'path');
    const abs = join(repo.top, p);
    const r = readWork(abs, acc.limits);
    if ('why' in r) {
      acc.unscanned(p, 'work-tree', r.why);
      continue;
    }
    if ('big' in r) {
      acc.unscanned(p, r.big, 'over the size limit');
      continue;
    }
    const id = blobId(r.buf, repo.format);
    if (BINARY_EXT.has(extname(p).toLowerCase())) {
      acc.unscanned(p, id, 'binary file type');
      continue;
    }
    if (acc.take(id, r.buf.length)) acc.bytesOf(p, id, r.buf);
  }
}

// ---- a commit ----

export interface CommitInput {
  /** Where git runs. */
  dir: string;
  globals: string[];
  /** `index`: the index; `all`: `-a`; `only`: paths against HEAD; `include`: the index and those paths. */
  mode: 'index' | 'all' | 'only' | 'include';
  paths: string[];
  amend: boolean;
  /** The message as the command gives it (`-m`, `--trailer`, a heredoc body). */
  messages: string[];
  /** `-F` files, resolved. */
  files: string[];
  /** Why the exact tree or message cannot be told (interactive, a pathspec file, stdin, the environment…). */
  unclear: string[];
  /** Text the command sets as who the commit is by (`-c user.name=…`, `--author=…`, `GIT_AUTHOR_NAME=…`): scanned at `<author>`. */
  identity: string[];
}

/** A reason the scan cannot tell what goes out: one entry of the report, bound to the reason (and to the call's salt, when
 *  it has one: the command that was read, so the approval of one command does not pass another with the same reason). */
export function unclear(acc: Acc, path: string, why: string): void {
  acc.unscanned(path, sha(acc.salt === '' ? why : `${acc.salt}\0${why}`), why);
}

/** The tree id to compare a commit against: HEAD's, HEAD's parent's for an amend, the empty tree before the first
 *  commit; null when git cannot say. */
function baseTree(repo: Repo, amend: boolean, acc: Acc): string | null {
  const head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { acc });
  if (head === null) return amend ? null : EMPTY_TREE[repo.format];
  if (!amend) return git(repo, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], { acc })?.out.trim() ?? null;
  const parent = git(repo, ['rev-parse', '--verify', '-q', 'HEAD^1^{commit}'], { acc });
  if (parent === null) return EMPTY_TREE[repo.format];
  return git(repo, ['rev-parse', '--verify', '-q', 'HEAD^1^{tree}'], { acc })?.out.trim() ?? null;
}

/** A message file's bytes: `-F` follows a link to the file git reads (a work-tree file of a commit is the link itself). */
function readMessageFile(p: string): Buffer | null {
  const real = realOrSelf(p);
  // a link that leads nowhere is no message (readWork would take the link's text for it)
  if (isLink(real)) return null;
  const r = readWork(real, { ...DEFAULT_LIMITS, maxBlob: 1024 * 1024 });
  return 'buf' in r ? r.buf : null;
}

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Scans one commit: the changed files of its tree, the message and every path. */
export function scanCommit(input: CommitInput, acc: Acc): void {
  const repo = repoOf(input.dir, input.globals);
  if (repo === null) {
    unclear(acc, '<repository>', 'git could not tell the repository of this commit');
    return;
  }
  for (const why of input.unclear) unclear(acc, '<commit>', why);
  const base = baseTree(repo, input.amend, acc);
  if (base === null) unclear(acc, '<commit>', 'git could not tell what this commit is compared with');
  else scanTree(repo, input, base, acc);
  const messages = [...input.messages];
  for (const f of input.files) {
    const buf = readMessageFile(f);
    if (buf === null) unclear(acc, '<message file>', 'the message file cannot be read');
    else {
      const t = textOf(buf);
      if ('why' in t) unclear(acc, '<message file>', `the message file is ${t.why}`);
      else messages.push(t.text);
    }
  }
  if (messages.length > 0) {
    const text = messages.join('\n\n');
    acc.text('<commit message>', sha(text), text, ownAddresses(repo, acc));
  }
  for (const t of input.identity) acc.text('<author>', sha(t), t);
}

function scanTree(repo: Repo, input: CommitInput, base: string, acc: Acc): void {
  let staged: Entry[] | undefined = [];
  let work: Entry[] | undefined = [];
  if (input.mode === 'index' || input.mode === 'include') staged = diffIndex(repo, ['--cached', base], [], acc);
  if (input.mode === 'all') work = diffIndex(repo, [base], [], acc);
  if (input.mode === 'only' || input.mode === 'include') work = diffIndex(repo, [base], input.paths, acc);
  if (staged === undefined || work === undefined) {
    unclear(acc, '<commit>', 'git could not list the files of this commit');
    return;
  }
  // The work tree's file wins over the index's blob for a path both list.
  const byWork = new Map<string, Entry>();
  for (const e of work) byWork.set(e.path, e);
  const blobs: BlobItem[] = [];
  for (const e of staged) {
    if (byWork.has(e.path)) continue;
    if (e.id === null) byWork.set(e.path, e);
    else blobs.push({ id: e.id, path: e.path });
  }
  const files: string[] = [];
  for (const e of byWork.values()) {
    // A work-tree entry the index agrees with has its blob id already.
    if (e.id !== null) blobs.push({ id: e.id, path: e.path });
    else files.push(e.path);
  }
  scanBlobs(repo, blobs, acc);
  scanWorkFiles(repo, files, acc);
}

/** The git hook side of a commit: the index as it is (git points GIT_INDEX_FILE at the exact tree for `-a` and
 *  paths) against HEAD, and every path. No amend (a hook cannot tell). */
export function scanIndex(dir: string, acc: Acc): void {
  scanCommit({ dir, globals: [], mode: 'index', paths: [], amend: false, messages: [], files: [], unclear: [], identity: [] }, acc);
}

/** The message file git passes to `commit-msg`. */
export function scanMessageFile(file: string, acc: Acc, repo: Repo): void {
  const buf = readMessageFile(file);
  if (buf === null) {
    unclear(acc, '<message file>', 'the message file cannot be read');
    return;
  }
  const t = textOf(buf);
  if ('why' in t) unclear(acc, '<message file>', `the message file is ${t.why}`);
  else acc.text('<commit message>', sha(t.text), t.text, ownAddresses(repo, acc));
}

// ---- a push ----

export interface PushInput {
  dir: string;
  globals: string[];
  /** The remote as the command (or git, for a hook) names it: a configured remote's name, or a URL; null when none. */
  remote: string | null;
  /** Revisions (names or ids) the push sends. */
  revs: string[];
  /** `--all`, `--branches`, `--tags`: whole ref families. */
  flags: Array<'--all' | '--branches' | '--tags'>;
  /** Object ids the remote is known to have (hook mode: the remote's old value of each ref). */
  excluding: string[];
  unclear: string[];
}

/** The configured remotes the push goes to, for the remote-tracking refs the push scan takes as what the remote has: the
 *  remote itself when `remote` names one (`remote.<name>.url` or `.pushurl` is set), else every remote whose url or
 *  pushurl is exactly `remote` (a URL); none for a name or URL no remote has. Other remotes' refs say nothing about what
 *  this one has. */
function remotesOf(repo: Repo, remote: string | null, acc: Acc): string[] {
  if (remote === null) return [];
  const r = git(repo, ['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], { acc });
  // git exits 1 when no remote has a url: nothing is excluded
  if (r === null) return [];
  const urls = new Map<string, string[]>();
  for (const line of r.out.split('\n')) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const m = /^remote\.(.+)\.(?:url|pushurl)$/i.exec(key);
    if (m === null || !/^[\w.-]+$/.test(m[1]!)) continue;
    urls.set(m[1]!, [...(urls.get(m[1]!) ?? []), sp < 0 ? '' : line.slice(sp + 1)]);
  }
  if (urls.has(remote)) return [remote];
  return [...urls].filter(([, u]) => u.includes(remote)).map(([name]) => name);
}

/** An object id for a name, or null. */
function resolveRev(repo: Repo, rev: string, acc: Acc): string | null {
  if (OBJECT_ID.test(rev)) return rev;
  const r = git(repo, ['rev-parse', '--verify', '-q', '--end-of-options', rev], { acc });
  const id = r?.out.trim() ?? '';
  return OBJECT_ID.test(id) ? id : null;
}

/** Scans what a push would send. */
export function scanPush(input: PushInput, acc: Acc): void {
  const repo = repoOf(input.dir, input.globals);
  if (repo === null) {
    unclear(acc, '<repository>', 'git could not tell the repository of this push');
    return;
  }
  for (const why of input.unclear) unclear(acc, '<push>', why);
  const ids: string[] = [];
  input.revs.forEach((rev, n) => {
    const id = resolveRev(repo, rev, acc);
    if (id === null) unclear(acc, `<pushed ref ${n + 1}>`, 'a pushed ref does not resolve to an object');
    else ids.push(id);
  });
  if (ids.length === 0 && input.flags.length === 0) return;
  const excluding = input.excluding.filter((e) => OBJECT_ID.test(e));
  const remotes = remotesOf(repo, input.remote, acc).map((n) => `--remotes=${n}`);
  const listed = git(repo, ['rev-list', '--objects', ...new Set(ids), ...input.flags, '--not', ...remotes, ...excluding], { maxBuffer: 64 * 1024 * 1024, acc });
  if (listed === null) {
    unclear(acc, '<outgoing objects>', 'git could not list the objects this push sends');
    return;
  }
  const paths = new Map<string, string>();
  for (const line of listed.out.split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    const id = sp < 0 ? line : line.slice(0, sp);
    if (!OBJECT_ID.test(id)) {
      unclear(acc, '<outgoing objects>', 'git listed an object goodboy cannot read');
      return;
    }
    if (!paths.has(id)) paths.set(id, sp < 0 ? '' : line.slice(sp + 1));
    if (paths.size > MAX_OBJECTS) {
      unclear(acc, '<outgoing objects>', 'this push sends more objects than goodboy scans');
      return;
    }
  }
  const types = checkObjects(repo, [...paths.keys()], acc);
  if (types === undefined) {
    unclear(acc, '<outgoing objects>', 'git could not tell the type of the objects this push sends');
    return;
  }
  const blobs: BlobItem[] = [];
  const messages: string[] = [];
  for (const [id, meta] of types) {
    if (meta.type === 'blob') blobs.push({ id, path: paths.get(id) ?? '', size: meta.size });
    else if (meta.type === 'commit' || meta.type === 'tag') messages.push(id);
  }
  for (const id of paths.keys()) if (!types.has(id)) unclear(acc, '<outgoing objects>', 'an outgoing object is missing');
  scanBlobs(repo, blobs, acc);
  scanMessages(repo, messages, types, acc);
}

/** The messages of commits and tags (the text after the headers). */
function scanMessages(repo: Repo, ids: string[], types: Map<string, { type: string; size: number }>, acc: Acc): void {
  for (let from = 0; from < ids.length; ) {
    let to = from;
    let sum = 0;
    while (to < ids.length && (to === from || sum + types.get(ids[to]!)!.size <= BATCH_BYTES)) sum += types.get(ids[to++]!)!.size;
    const batch = ids.slice(from, to);
    from = to;
    if (acc.expired()) {
      for (const id of batch) acc.skip(id);
      acc.stopped ??= 'time';
      continue;
    }
    // a message over the size limit is not read
    if (batch.length === 1 && types.get(batch[0]!)!.size > acc.limits.maxBlob) {
      acc.unscanned(`<commit message ${batch[0]!.slice(0, 7)}>`, batch[0]!, 'over the size limit');
      continue;
    }
    const r = git(repo, ['cat-file', '--batch'], { input: `${batch.join('\n')}\n`, maxBuffer: sum + batch.length * 160 + 1024, acc });
    if (r === null) {
      for (const id of batch) unclear(acc, `<message of ${id.slice(0, 7)}>`, 'git could not read the object');
      continue;
    }
    const read = splitBatch(r.raw, batch, 'commit-tag');
    for (const [k, id] of batch.entries()) {
      const body = read[k];
      if (body === null || body === undefined) {
        unclear(acc, `<message of ${id.slice(0, 7)}>`, 'git could not read the object');
        continue;
      }
      const gap = body.indexOf('\n\n');
      const own = headerAddresses((gap < 0 ? body : body.subarray(0, gap)).toString('utf8'));
      const msg = gap < 0 ? Buffer.alloc(0) : body.subarray(gap + 2);
      const t = textOf(msg);
      const shown = `<commit message ${id.slice(0, 7)}>`;
      if ('why' in t) acc.unscanned(shown, id, `the message is ${t.why}`);
      else acc.text(shown, id, t.text, own);
    }
  }
}

/** The git hook side of a push: the lines git gives `pre-push` on stdin (`<local ref> <local sha> <remote ref> <remote sha>`);
 *  `remote` is the name git gives the hook, or the URL when the push named none. A deleted ref sends nothing. Lines that are not four fields, or whose ids are not ids, are not read (not scanned). */
export function pushInputFromHook(dir: string, remote: string, stdin: string): PushInput {
  const input: PushInput = { dir, globals: [], remote: remote === '' ? null : remote, revs: [], flags: [], excluding: [], unclear: [] };
  const lines = stdin.split('\n').filter((l) => l.trim() !== '');
  if (lines.length > 100) input.unclear.push('this push updates more than 100 refs');
  for (const l of lines.slice(0, 100)) {
    const f = l.split(' ');
    if (f.length !== 4 || !(OBJECT_ID.test(f[1]!) || ZEROS.test(f[1]!)) || !(OBJECT_ID.test(f[3]!) || ZEROS.test(f[3]!))) {
      input.unclear.push('a ref line git gave the hook is not one goodboy can read');
      continue;
    }
    if (!ZEROS.test(f[1]!)) input.revs.push(f[1]!);
    if (!ZEROS.test(f[3]!)) input.excluding.push(f[3]!);
  }
  return input;
}

// ---- real data ----

const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The real-data project `dir` belongs to (its dir), or null: a project dir whose sandbox says real data
 *  (lib/sandbox-mode.ts `realDataForReading`), or one the user-level registry holds. No git call. A registry that
 *  cannot be read is left out, as the sandbox rule does (it logs it). */
export function realDataRootOf(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const start = resolve(dir);
  const real = realOrSelf(start);
  const reg = readRegistry(env);
  if (!(reg instanceof RegistryError)) {
    for (const e of reg) if (inside(real, e.top) || inside(start, e.top)) return e.top;
  }
  let cur = start;
  for (let i = 0; i < 64; i++) {
    if (isDir(join(cur, SANDBOX_DIR)) && realDataForReading(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

/** Whether the user-level registry names any project (a command anywhere may then touch one). */
export function registryHoldsProjects(env: NodeJS.ProcessEnv = process.env): boolean {
  const reg = readRegistry(env);
  return !(reg instanceof RegistryError) && reg.length > 0;
}

// ---- the user's approval ----

/** Whether the marker file holds exactly `digest` (a plain file of at most 256 bytes, never a link). */
export function markerHoldsDigest(path: string, digest: string): boolean {
  const r = readRegular(path, 256, true);
  return typeof r === 'object' && r.text.trim() === digest;
}

// ---- the denial text ----

/** The fixed text of a denial: the hits as `path:line kind` (up to 20, line 0 is the file name), what was not scanned,
 *  and `tail` (how to go on). Never a value: paths are redacted and no content is quoted. */
export function commitScanText(report: ScanReport, what: string, tail: string): string {
  const list = report.hits.slice(0, SHOWN).map((h) => `${h.path}:${h.line} ${h.kind}`);
  const hitCount = report.hits.length + report.moreHits;
  const hits =
    hitCount > 0
      ? ` Matches (${hitCount}): ${list.join(', ')}${hitCount > list.length ? ` and ${hitCount - list.length} more` : ''}.`
      : '';
  const un = report.unscanned.slice(0, SHOWN).map((u) => `${u.path} (${u.why})`);
  const unscanned = report.unscanned.length > 0 ? ` Not scanned (${report.unscanned.length}): ${un.join(', ')}${report.unscanned.length > un.length ? ` and ${report.unscanned.length - un.length} more` : ''}.` : '';
  return (
    `This \`${what}\` would publish content that has the shape of personal data or a secret, or that goodboy cannot scan, in a project that holds real data (commit scan).${hits}${unscanned} ` +
    'The values are never printed; line 0 is the file name itself. Remove or mask them (synthetic data), then run it again.' +
    tail
  );
}
