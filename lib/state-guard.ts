// Gate state guard (track G security review): the Stop gates read state from the session dir
// in $TMPDIR (edit log, review/test cursors, dispatch log, skill evidence, validation
// failure, the commit issue, project mode, coverage and criteria pins, the per-checkout start pins, the criteria a Stop
// required, the weakened tests a review judged), outside the project, where the Bash write gate allows writes. One
// `rm "$TMPDIR"/goodboy-session-*/edits.jsonl` would end a turn with neither tests nor review.
//
// So a model Bash call is bracketed: PreToolUse snapshots the guarded files, and the post
// hooks put back what the call removed or rewrote (append-only logs keep their old lines;
// cursors return to their old content; a cursor, an evidence log or a file only the hooks
// write that the call created is removed, by name: an mtime can be set back). A call that
// never reports back (`exit N`, G0 M18) is restored at the next Stop. A command that names a
// session dir with a mutating program is denied up front. Hooks and the model run as the same
// OS user, so this raises the bar; it cannot make the state tamper-proof.
//
// Every session file a hook reads to decide a gate is either guarded here or read through
// lib/safe-read.ts (`readStateText`: a regular file within a cap, never a FIFO waited on or a
// directory read; #12). A guarded name a call created as anything but a regular file (a directory
// at `edits.jsonl` before the first edit, a FIFO) is removed after it. The turn counter (`turn.txt`)
// is written by the Stop only, and the Stop writes it before it restores a call's snapshot, so it is
// never put back to the snapshot's value: it only never goes down (a deleted or lowered counter put
// later edits before the review cursor).
//
// The snapshot dir sits in the session dir, where the call it guards can write. Its index is sealed with a keyed
// hash (HMAC) over the call id, the names, the copies' content and what existed, with a key kept in the session dir
// (`.seal-key`, this user's regular file, mode 0600), and each snapshot taken leaves a note outside the snapshot dir
// (`.seal-notes/<call>` in the session dir), so a deleted snapshot dir is seen. An index that is missing, unsealed,
// forged, names anything but a guarded file, or whose copies changed, and a snapshot dir gone while its note stays,
// are not trusted (v0.36.18 reviews: a call that deleted the index and planted copies had them written back; one that
// deleted the dir kept a cursor it created). The untrusted restore writes no cursor or evidence copy and removes the
// cursors and evidence logs now there (the gates ask again); a hook-only file (a pin) stays, and one the call removed
// comes back from the copy (a removed pin made the gates skip what they compare with it); a removed validation failure
// comes back; the edit and unswept logs keep their lines plus the copy's (a union only adds obligations); the turn
// counter takes the highest valid value of the copy, the file and the edit log. A guarded log past the state cap is
// not copied, and the Stop blocks on it (`oversizedLogs`). The model can still read the key, a call that removes both
// the snapshot dir and its note reads as one that took none, and a pin it forges while the index is gone stays: this
// raises the bar only.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir, parseTurn, TURN_FILE, turnFloor } from './file-tracker';
import { segmentChanging } from './outward-command';
import { safeToolUseId } from './approval-marker';
import { MAX_STATE_BYTES, readRegular, readStateText } from './safe-read';
import { failureMarkerRoot, findProjectRoot, validationPassFile } from './validation-state';

const GUARDED = /^(?:turn\.txt|oversized-logs\.json|edits\.jsonl|unswept\.jsonl|dispatch-log\.jsonl|skill-evidence\.jsonl|commit-issue-pins\.json|marker-evidence\.jsonl|project-mode-pin\.json|coverage-pin\.json|criteria-pin\.json|criteria-seen\.json|judged-weakened\.json|agent-deferral\.json|worktrees\.txt|start-tips(?:-[0-9a-f]{16})?\.json|(?:start-pin|criteria-pin|criteria-seen)-[0-9a-f]{16}\.json|\.goodboy-last-(?:review|test)-[0-9a-f]+\.json|\.goodboy-validation-failed\.json|validation-passed\.json)$/;
const CURSOR = /^\.goodboy-last-(?:review|test)-[0-9a-f]+\.json$/;
/** Evidence logs: a line added during a model Bash call would be forged evidence (a skill run,
 *  the user's non-project answer), so these keep only their old lines, and one the call
 *  created is removed (track H). The exception is a skill-gap note: the skill rule asks the
 *  model to record it through `cli.ts skill-gap` from Bash, and it is the model's own note
 *  (H1 review: dropping it kept the skill rule denying). */
const EVIDENCE = /^(?:skill-evidence|marker-evidence)\.jsonl$/;
/** Written only by SessionStart (the pins) and the Stop (the criteria it required, the weakened
 *  tests a review judged): one a Bash call created would set the session's start or criteria
 *  (I2 security review round 2: a crafted seen list failed the gate open). The worktree pin
 *  (#21) is no longer written or read since v0.36.10 (#35: a nested worktree is its own project
 *  whenever made); it stays guarded, so a session started on an older version keeps it as it was.
 *  The start pins of v0.36.7 (#33: the frozen ref tips, one start pin and one criteria baseline per
 *  checkout, the criteria a Stop required there) are the same kind: a forged one would set a
 *  checkout's start. The tips are one file per repository (#39): `start-tips.json` for the session's
 *  own, `start-tips-<hash>.json` for each nested repo of a project dir that is no repo. The deferral clock
 *  (`agent-deferral.json`, lib/agent-deferral.ts, #44) is the Stop's: a call that restarted or removed it would
 *  lengthen the time the gates wait for agents. */
const HOOK_ONLY = /^(?:(?:project-mode-pin|coverage-pin|criteria-pin|criteria-seen|judged-weakened|agent-deferral|oversized-logs)\.json|worktrees\.txt|start-tips(?:-[0-9a-f]{16})?\.json|(?:start-pin|criteria-pin|criteria-seen)-[0-9a-f]{16}\.json)$/;

function keptEvidenceLine(name: string, line: string): boolean {
  if (name !== 'skill-evidence.jsonl') return false;
  try {
    return (JSON.parse(line) as { k?: unknown }).k === 'skill-gap';
  } catch {
    return false;
  }
}

/** An evidence log's text with only the lines a Bash call may add kept after `before`. */
function evidenceText(name: string, before: string, now: string | null): string {
  const oldLines = new Set(before.split('\n'));
  const added = (now ?? '').split('\n').filter((l) => l !== '' && !oldLines.has(l) && keptEvidenceLine(name, l));
  return before + added.map((l) => `${l}\n`).join('');
}
const SNAP_PREFIX = 'bash-guard-';

function snapDir(sessionId: string, toolUseId: string): string {
  return join(ensureSessionDir(sessionId), `${SNAP_PREFIX}${safeToolUseId(toolUseId)}`);
}

/** The seal key and the snapshot notes live in the session dir (this user's, 0700), not in $TMPDIR (round-2 delta
 *  review: a key and a notes dir in a shared /tmp could be taken by another user, and a link there made the Stop
 *  delete the files it pointed to). Their names are no GUARDED names, so no snapshot copies them. */
const KEY_FILE = '.seal-key';
const NOTES_DIR = '.seal-notes';
const INDEX_FILE = '.index.json';

/** Whether `p` is this user's real directory (no link). */
function ownDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && (typeof process.getuid !== 'function' || st.uid === process.getuid());
  } catch {
    return false;
  }
}

/** The session's notes dir when it is a real dir of this user's (made when `create`), else null: a link there is
 *  never followed, so neither a note write nor the Stop's note listing or removal reaches elsewhere. */
function notesDir(sessionId: string, create = false): string | null {
  const dir = join(ensureSessionDir(sessionId), NOTES_DIR);
  if (create) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      // there already, or cannot be made
    }
  }
  return ownDir(dir) ? dir : null;
}

/** Whether a note says a snapshot was taken for `id`. */
function hasNote(sessionId: string, id: string): boolean {
  const dir = notesDir(sessionId);
  if (dir === null) return false;
  try {
    return lstatSync(join(dir, id)).isFile();
  } catch {
    return false;
  }
}

function dropNote(sessionId: string, id: string): void {
  const dir = notesDir(sessionId);
  if (dir !== null) rmSync(join(dir, id), { force: true });
}

/** The seal key: 32 random bytes (hex) in the session dir, used only when it is this user's regular file with no
 *  group or other bits. `create` (the snapshot only) makes it when absent and replaces a bad one (a link, a dir, junk,
 *  other bits): the bad entry is removed, and the new key written whole under a temporary name, then linked into place,
 *  so a parallel hook never reads half a key. Null when no good key can be had (the snapshot is then unsealed, and its
 *  restore not trusted: fail closed). */
function sealKey(sessionId: string, create: boolean): string | null {
  const path = join(ensureSessionDir(sessionId), KEY_FILE);
  const read = (): string | null => {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || (typeof process.getuid === 'function' && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0) return null;
    } catch {
      return null;
    }
    const r = readRegular(path, 256, true);
    if (r === 'absent' || r === 'refused') return null;
    const k = r.text.trim();
    return /^[0-9a-f]{64}$/.test(k) ? k : null;
  };
  const have = read();
  if (have !== null || !create) return have;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    // A bad entry goes first, unless a parallel hook made a good key meanwhile (round-3 review: removing it sealed
    //   that hook's index with a key then replaced); a link then fails with EEXIST when one appears after this check.
    if (read() === null) rmSync(path, { recursive: true, force: true });
    linkSync(tmp, path);
  } catch {
    // read below
  } finally {
    rmSync(tmp, { force: true });
  }
  return read();
}

interface IndexBody {
  id: string;
  names: string[];
  present: string[];
  /** sha256 of each copy, in `names` order. */
  sums: string[];
}

function seal(key: string, body: IndexBody): string {
  return createHmac('sha256', key).update(JSON.stringify([body.id, body.names, body.present, body.sums])).digest('hex');
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Copies the guarded gate files before a model Bash call. `cwd`: the shell's dir, for the project whose pass record
 *  is kept too (omitted: only the project the session's failure marker names). */
export function snapshotGateState(sessionId: string, toolUseId: string, cwd?: string): void {
  try {
    const dir = ensureSessionDir(sessionId);
    const snap = snapDir(sessionId, toolUseId);
    // A snapshot taken again for the same call (a Stop noting a running call, #14) starts clean: a copy
    //   of a file since gone must not stay in the dir the restore reads.
    rmSync(snap, { recursive: true, force: true });
    mkdirSync(snap, { recursive: true });
    // A guarded log past the cap is not copied: its name goes in a small hook-only flag first, which is copied and
    //   guarded, so a call that then deletes the log still leaves the Stop something to block on (round-3 review).
    flagOversized(dir);
    const names: string[] = [];
    const sums: string[] = [];
    const present: string[] = []; // every guarded name, copied or not: what the call did not create
    for (const name of readdirSync(dir)) {
      if (!GUARDED.test(name)) continue;
      present.push(name);
      const p = join(dir, name);
      try {
        // Through readRegular alone (no link, no FIFO waited on, within the cap). A log past the cap is not copied:
        //   the Stop blocks on it (B5.96, oversizedLogs).
        const r = readRegular(p, MAX_STATE_BYTES, true);
        if (r === 'absent' || r === 'refused') continue;
        const data = Buffer.from(r.text, 'utf8');
        writeFileSync(join(snap, name), data);
        names.push(name);
        sums.push(sha(data));
      } catch {
        // unreadable: not guarded this time
      }
    }
    // The project's pass record (#44), which lives outside the session dir: a copy of it, with its project root,
    //   is kept under its own name so the restore can put it back. On every call, marker or not: a pass planted before
    //   the breaking edit would make the next failure stale at once.
    const passCopy = passRecordCopy(sessionId, cwd);
    if (passCopy !== null) {
      const data = Buffer.from(passCopy, 'utf8');
      writeFileSync(join(snap, PASS_RECORD), data);
      names.push(PASS_RECORD);
      sums.push(sha(data));
    }
    const body: IndexBody = { id: safeToolUseId(toolUseId), names, present, sums };
    const key = sealKey(sessionId, true);
    writeFileSync(join(snap, INDEX_FILE), JSON.stringify({ t: Date.now(), ...body, ...(key !== null ? { seal: seal(key, body) } : {}) }), 'utf8');
    // The note that this snapshot was taken, outside its dir: a dir gone while the note stays was removed.
    const notes = notesDir(sessionId, true);
    if (notes !== null) writeFileSync(join(notes, body.id), '', { mode: 0o600 });
  } catch {
    // best-effort
  }
}

/** The pass record (lib/validation-state.ts) is in the project's state dir, not the session dir. A pass there lifts
 *  a failed validation, and only the post hook records one, after it ran the exact command (#44). A model Bash call
 *  that wrote one (an `echo` of a passes object into the project dir's validation-passed.json) forged a pass, so the
 *  snapshot keeps `{ root, text }` under this name and the restore puts the record back. */
const PASS_RECORD = 'validation-passed.json';

/** The copy of the pass records of the projects a call may touch, as `{ records: [{ root, text }] }`: the root of the
 *  call's cwd (where the next edit's checks will record, so a pass planted before any failure is caught) and the root
 *  the session's failure marker names. `text` is null for no record. Null when there is no root at all. Nothing is
 *  created: no project state dir is made for a project that has none. */
function passRecordCopy(sessionId: string, cwd: string | undefined): string | null {
  try {
    const roots = new Set<string>();
    const fromMarker = failureMarkerRoot(sessionId);
    if (fromMarker !== null) roots.add(fromMarker);
    const fromCwd = cwd === undefined || cwd === '' ? null : findProjectRoot(cwd)?.root ?? null;
    if (fromCwd !== null) roots.add(fromCwd);
    const records: { root: string; text: string | null }[] = [];
    for (const root of roots) {
      const file = validationPassFile(root, false);
      // No trusted dir: nothing is read or written there, by the gates or by this guard.
      if (file === null) {
        records.push({ root, text: null });
        continue;
      }
      const r = readRegular(file, MAX_STATE_BYTES, true);
      // Absent, or a link, a FIFO or a file past the cap: no record to keep (a restore removes what a call puts there).
      records.push({ root, text: r === 'absent' || r === 'refused' ? null : r.text });
    }
    return records.length === 0 ? null : JSON.stringify({ records });
  } catch {
    return null;
  }
}

/** Puts one pass record back as the snapshot saw it: the file goes when `text` is null. True when it changed. */
function restoreOnePassRecord(root: string, text: string | null): boolean {
  const file = validationPassFile(root, false);
  if (file === null) return false;
  const now = readRegular(file, MAX_STATE_BYTES, true);
  if (text === null) {
    if (now === 'absent') return false;
    rmSync(file, { recursive: true, force: true });
    return true;
  }
  if (now !== 'absent' && now !== 'refused' && now.text === text) return false;
  rmSync(file, { recursive: true, force: true });
  writeFileSync(file, text, 'utf8');
  return true;
}

/** Puts the pass records back as the snapshot saw them; an untrusted copy is not believed: those records go (the
 *  failed validation passes again, which re-records them). True when it changed any. */
function restorePassRecord(sessionId: string, before: string, trusted: boolean): boolean {
  const records: { root: string; text: string | null }[] = [];
  try {
    const c = JSON.parse(before) as { records?: unknown } | null;
    if (c && Array.isArray(c.records)) {
      for (const r of c.records as { root?: unknown; text?: unknown }[]) {
        if (r && typeof r.root === 'string' && r.root !== '') records.push({ root: r.root, text: trusted && typeof r.text === 'string' ? r.text : null });
      }
    }
  } catch {
    // an unreadable copy names no root
  }
  if (records.length === 0) {
    const root = failureMarkerRoot(sessionId);
    if (root !== null) records.push({ root, text: null });
  }
  let changed = false;
  for (const { root, text } of records) {
    try {
      if (restoreOnePassRecord(root, text)) changed = true;
    } catch {
      // this one could not be put back; the others still are
    }
  }
  return changed;
}

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((n) => typeof n === 'string') ? (v as string[]) : null);

interface Snapshot {
  /** Each copy's text, by name: the bytes the seal was checked against when trusted (one read, so a copy
   *  swapped between the check and the use is not taken; refactoring review). */
  copies: Map<string, string>;
  present: string[];
  trusted: boolean;
}

/** What a snapshot dir holds and may be believed to: its index when the seal matches the copies in the dir;
 *  else (missing, unreadable, forged or unsealed index, a name that is no guarded file, a copy changed or gone,
 *  no key, a dir gone) the copies the dir lists, untrusted. An unsealed index is never trusted (round-2 delta
 *  review: trusting it on a note made the downgrade one write away); the key lives in the session dir, where a
 *  snapshot can always make one. */
function readSnapshot(sessionId: string, snap: string): Snapshot {
  const readCopies = (names: readonly string[]): Map<string, string> | null => {
    const copies = new Map<string, string>();
    for (const n of names) {
      const c = readRegular(join(snap, n), MAX_STATE_BYTES, true);
      if (c === 'absent' || c === 'refused') return null;
      copies.set(n, c.text);
    }
    return copies;
  };
  const listed = (): Snapshot => {
    const copies = new Map<string, string>();
    try {
      for (const n of readdirSync(snap).filter((x) => GUARDED.test(x))) {
        const c = readRegular(join(snap, n), MAX_STATE_BYTES, true);
        if (c !== 'absent' && c !== 'refused') copies.set(n, c.text);
      }
    } catch {
      // no dir: no copies
    }
    return { copies, present: [], trusted: false };
  };
  try {
    const r = readRegular(join(snap, INDEX_FILE), 1024 * 1024, true);
    if (r === 'absent' || r === 'refused') return listed();
    const idx = JSON.parse(r.text) as { id?: unknown; names?: unknown; present?: unknown; sums?: unknown; seal?: unknown } | null;
    const names = strings(idx?.names);
    const present = strings(idx?.present);
    const sums = strings(idx?.sums);
    if (!idx || !names || !present || !sums || sums.length !== names.length || typeof idx.id !== 'string') return listed();
    if (idx.id !== snap.slice(snap.lastIndexOf(SNAP_PREFIX) + SNAP_PREFIX.length)) return listed();
    // Only guarded basenames (security review: a sealed `../../x` was written outside the session dir).
    if (![...names, ...present].every((n) => GUARDED.test(n))) return listed();
    const key = sealKey(sessionId, false);
    if (typeof idx.seal !== 'string' || key === null || seal(key, { id: idx.id, names, present, sums }) !== idx.seal) return listed();
    const copies = readCopies(names);
    if (copies === null || names.some((n, i) => sha(Buffer.from(copies.get(n)!, 'utf8')) !== sums[i])) return listed();
    return { copies, present, trusted: true };
  } catch {
    return listed();
  }
}

/** Most the turn counter may rise during one call: only the Stop writes it (before it restores a snapshot) and it
 *  takes a running call's snapshot again (#14), so a call's snapshot is at most a Stop or two behind. */
const TURN_SLACK = 2;
/** Logs an untrusted restore joins with the copy's lines: more records only add obligations. Not the dispatch log,
 *  whose prompt lines reset the delegation caps. */
const UNION_LOGS = new Set(['edits.jsonl', 'unswept.jsonl']);
/** A failed validation blocks the Stop: an untrusted restore puts back one the call removed. */
const VALIDATION_FAILED = '.goodboy-validation-failed.json';

/** The text of a plain state file, or null when it is none. */
function textOrNull(p: string): string | null {
  try {
    return readStateText(p);
  } catch {
    return null;
  }
}

/** Whether `p` is a regular file within the state cap (lstat: a link is not). */
function plainState(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isFile() && st.size <= MAX_STATE_BYTES;
  } catch {
    return false;
  }
}

function restoreFrom(sessionId: string, snap: string): string[] {
  const dir = ensureSessionDir(sessionId);
  const restored: string[] = [];
  const id = snap.slice(snap.lastIndexOf(SNAP_PREFIX) + SNAP_PREFIX.length);
  const { copies, present: presentNames, trusted } = readSnapshot(sessionId, snap);
  for (const [name, before] of copies) {
    // An untrusted snapshot's copy of a cursor or an evidence log may be planted: never written. A hook-only
    //   file (a start, coverage or criteria pin) is written only where the call removed it: a missing pin makes
    //   the gates skip what they compare with it (delta security review), a planted copy is no worse than a
    //   planted file.
    if (!trusted && (CURSOR.test(name) || EVIDENCE.test(name))) continue;
    if (name === PASS_RECORD) {
      try {
        if (restorePassRecord(sessionId, before, trusted)) restored.push(name);
      } catch {
        // the record could not be put back; the others still are
      }
      continue;
    }
    const p = join(dir, name);
    // A file the call made oversized, or replaced with a FIFO, a link or a directory, is
    //   replaced unread (final G1 test rounds: reading a 3 GB sparse file killed the hook, and
    //   a directory stopped the restore of every later file).
    try {
      let now: string | null = null;
      try {
        const st = lstatSync(p);
        if (st.isFile() && st.size <= MAX_STATE_BYTES) now = readStateText(p);
        else rmSync(p, { recursive: true, force: true });
      } catch {
        now = null;
      }
      if (!trusted && name === OVERSIZED_FLAG) {
        // The flag only adds blocks: the copy's names join what is there (round-4 review: a call that rewrote it to []
        //   with the index gone kept it so).
        let copyNames: string[] = [];
        try {
          copyNames = (strings(JSON.parse(before)) ?? []).filter((n) => GUARDED.test(n));
        } catch {
          copyNames = [];
        }
        const all = [...new Set([...flagged(dir), ...copyNames])];
        if (all.length > flagged(dir).length) {
          writeFlag(dir, all);
          restored.push(name);
        }
        continue;
      }
      if (!trusted && HOOK_ONLY.test(name)) {
        if (now === null) {
          writeFileSync(p, before, 'utf8');
          restored.push(name);
        }
        continue;
      }
      if (name === TURN_FILE) {
        // Only the Stop writes it, before this restore: what the call left stands only between the snapshot's value
        //   and TURN_SLACK above it. Lower, gone, no counter, or a jump (security review: 15 digits made the Stop's
        //   increment no counter, and a later 0 put every edit before a cursor of 1e15) goes back to the snapshot's.
        //   An untrusted copy may be planted: the highest valid value of it, the file and the edit log (never lower).
        const was = parseTurn(before);
        const cur = parseTurn(now);
        const want = trusted
          ? was === null
            ? null
            : cur !== null && cur >= was && cur <= was + TURN_SLACK
              ? cur
              : was
          : Math.max(was ?? 0, cur ?? 0, turnFloor(dir));
        if (want !== null && want !== cur) {
          writeFileSync(p, String(want), 'utf8');
          restored.push(name);
        }
      } else if (EVIDENCE.test(name)) {
        const want = evidenceText(name, before, now);
        if (want !== now) {
          writeFileSync(p, want, 'utf8');
          restored.push(name);
        }
      } else if (name.endsWith('.jsonl')) {
        // Untrusted: only the logs whose extra lines only add obligations take the copy's lines.
        if (!trusted && !UNION_LOGS.has(name)) continue;
        // Append-only: every old line must still be there, in front.
        if (now !== null && now.startsWith(before)) continue;
        const oldLines = new Set(before.split('\n'));
        const added = (now ?? '').split('\n').filter((l) => l !== '' && !oldLines.has(l));
        writeFileSync(p, before + added.map((l) => `${l}\n`).join(''), 'utf8');
        restored.push(name);
      } else if (!trusted) {
        // Untrusted: a lost validation failure comes back (it only blocks); no other copy is written.
        if (name === VALIDATION_FAILED && now === null) {
          writeFileSync(p, before, 'utf8');
          restored.push(name);
        }
      } else if (now !== before) {
        writeFileSync(p, before, 'utf8');
        restored.push(name);
      }
    } catch {
      // this file could not be put back; the others still are
    }
  }
  // A cursor the call created would accept work without a review or test; an evidence log it
  //   created would be forged evidence; a pin or criteria list it created would set the
  //   session's start or criteria. Created = absent from the snapshot's list of every guarded
  //   name (not by mtime, which a call can set back; I2 security review round 3). Each is
  //   removed on its own, whatever it is (a directory made unlinkSync throw and ended the loop).
  //   Any other guarded name a call created is removed when it is no plain file (a directory or a
  //   FIFO at `edits.jsonl` stops every later append, #12), or, for the turn counter, no counter.
  //   Without a trusted list nothing counts as having existed: every cursor and evidence log now there is taken
  //   for forged and removed (the gates ask again). Hook-only files stay (a removed pin fails open).
  const existed = new Set(trusted ? presentNames : []);
  let now: string[] = [];
  try {
    now = readdirSync(dir);
  } catch {
    now = [];
  }
  for (const name of now) {
    if (!GUARDED.test(name) || existed.has(name)) continue;
    const p = join(dir, name);
    if (!trusted && HOOK_ONLY.test(name) && plainState(p)) continue;
    // The pass record is never a session file: one there is a call's, and goes.
    const hookOnly = CURSOR.test(name) || EVIDENCE.test(name) || HOOK_ONLY.test(name) || name === PASS_RECORD;
    if (!hookOnly && plainState(p) && (name !== TURN_FILE || parseTurn(textOrNull(p)) !== null)) continue;
    try {
      let kept = '';
      if (EVIDENCE.test(name) && plainState(p)) kept = evidenceText(name, '', readStateText(p));
      if (kept === '') rmSync(p, { recursive: true, force: true });
      else writeFileSync(p, kept, 'utf8');
      // A counter that was no counter goes back to the edit log's highest turn, never to 0 (an absent counter
      //   reads as 0 and puts later edits before the review cursor).
      if (name === TURN_FILE) {
        const floor = turnFloor(dir);
        if (floor > 0) writeFileSync(p, String(floor), 'utf8');
      }
      restored.push(name);
    } catch {
      // this one could not be removed; the others still are
    }
  }
  rmSync(snap, { recursive: true, force: true });
  dropNote(sessionId, id);
  return restored;
}

/** After a model Bash call: puts back what it removed or rewrote. Returns the file names. */
export function restoreGateState(sessionId: string, toolUseId: string | undefined): string[] {
  if (!toolUseId) return [];
  const snap = snapDir(sessionId, toolUseId);
  // No snapshot dir: none was taken, unless its note says one was (the call removed it: an untrusted restore).
  if (!existsSync(snap) && !hasNote(sessionId, safeToolUseId(toolUseId))) return [];
  try {
    return restoreFrom(sessionId, snap);
  } catch {
    return [];
  }
}

/** At Stop: restores the snapshots of calls that never reported back (`exit N`), except those
 *  of `open` calls: a running agent's call the Stop noted again keeps its fresh snapshot for
 *  its own post hook (#14). */
export function restoreOrphanGateState(sessionId: string, open: readonly string[] = []): string[] {
  const out: string[] = [];
  try {
    const dir = ensureSessionDir(sessionId);
    const keep = new Set(open.map((t) => `${SNAP_PREFIX}${safeToolUseId(t)}`));
    const done = new Set<string>();
    for (const name of readdirSync(dir)) {
      if (name.startsWith(SNAP_PREFIX) && !keep.has(name)) {
        done.add(name);
        out.push(...restoreFrom(sessionId, join(dir, name)));
      }
    }
    // A note whose snapshot dir is gone (removed by the call it guarded): the untrusted restore.
    //   Only a real notes dir of this user's is listed (round-2 delta review: through a link the Stop removed the
    //   files of the dir it pointed to), and only plain note files count.
    const notes = notesDir(sessionId);
    let ids: string[] = [];
    try {
      ids = notes === null ? [] : readdirSync(notes).filter((id) => /^[A-Za-z0-9_-]+$/.test(id) && lstatSync(join(notes, id)).isFile());
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const name = `${SNAP_PREFIX}${id}`;
      if (!keep.has(name) && !done.has(name)) out.push(...restoreFrom(sessionId, join(dir, name)));
    }
  } catch {
    // best-effort
  }
  return out;
}

// Programs that read the files they name. Their options that write or run something (`find -fprint`, `rg --pre`,
//   `tree -o`, `file -C`) are changes (segmentChanging). The pagers are left out: `less -o <file>` and macOS
//   `more -O <file>` write a log, and no session reads through a pager (v0.36.16 reviews).
const READ_PROGS = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'rg', 'wc', 'jq', 'stat', 'test', '[', 'file', 'tree', 'find', 'du', 'echo', 'cut', 'diff', 'cmp', 'od', 'nl', 'strings', 'readlink', 'realpath', 'shasum', 'md5', 'sha256sum']);

/** A word that names a goodboy session dir (`goodboy-session-…`) or project state dir (`goodboy-project-…`, which
 *  holds the validation pass record, v0.37.1), or a glob that can match one: any prefix of `session` or `project`
 *  after `goodboy-` followed by `*`, `?` or `[` (`goodboy-s*`, `goodboy-pr*`), `goodboy*`, or `goodboy` with a `?` or
 *  a class followed by `-`, `s`, `p` or another glob character (`goodboy?session-*`; a `goodboy?` ending a message or
 *  `goodboy[0-9].ts` is none). Both dirs are `goodboy-<kind>-<id>` (v0.37.2): after the kind, anything but the end of
 *  the word, `/`, `.` or `_` may supply the hyphen (`-`, `$E-x`, `{-x,}`, `$'\x2dx'`, `@(-x)`), so it counts; a user's
 *  `goodboy_project`, `goodboy-project` or `goodboy-project/` dir is no state dir. A separator is required before
 *  `session`: an identifier such as `inGoodboySessionDir` in a searched pattern is no path (it was taken for one).
 *  The class is bounded (64 characters) so that a long word of repeated `goodboy[` stays linear. */
const SESSION_DIR_WORD =
  /goodboy(?:-(?:session|project)(?![/._]|$)|-(?:s(?:e(?:s(?:s(?:i(?:on?)?)?)?)?)?|p(?:r(?:o(?:j(?:e(?:ct?)?)?)?)?)?)?[*?[]|\*|(?:\?|\[[^\]]{0,64}\])[-sp*?[])/i;

/** True when a shell command changes a goodboy session dir: a segment that names
 *  `goodboy-session` (or a glob that matches it) and runs anything but a read, or redirects. */
export function writesGateState(command: string): boolean {
  return segmentChanging(command, (w) => SESSION_DIR_WORD.test(w), READ_PROGS) !== null;
}

const OVERSIZED_FLAG = 'oversized-logs.json';

/** The guarded logs now past the state cap in `dir`. */
function bigLogs(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!GUARDED.test(name) || !name.endsWith('.jsonl')) continue;
      try {
        const st = lstatSync(join(dir, name));
        if (st.isFile() && st.size > MAX_STATE_BYTES) out.push(name);
      } catch {
        // gone meanwhile
      }
    }
  } catch {
    // no dir: none
  }
  return out;
}

/** The names the flag holds (a hook-only file the snapshot writes: a trusted restore puts back a flag a call changed
 *  or removed, an untrusted one joins the copy's names to what is there). */
function flagged(dir: string): string[] {
  const r = readRegular(join(dir, OVERSIZED_FLAG), 64 * 1024, true);
  if (r === 'absent' || r === 'refused') return [];
  try {
    return (strings(JSON.parse(r.text)) ?? []).filter((n) => GUARDED.test(n));
  } catch {
    return [];
  }
}

/** Writes the flag's names, never through what a call put at its path (round-4 review: a link was followed, a FIFO
 *  hung the hook, a directory aborted the snapshot): written whole under a new name, then renamed over the path (a
 *  rename replaces a link or a file itself), after anything else there is removed. */
function writeFlag(dir: string, names: readonly string[]): void {
  const p = join(dir, OVERSIZED_FLAG);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    try {
      const st = lstatSync(p);
      if (!st.isFile() && !st.isSymbolicLink()) rmSync(p, { recursive: true, force: true });
    } catch {
      // absent
    }
    rmSync(tmp, { recursive: true, force: true });
    writeFileSync(tmp, JSON.stringify([...new Set(names)].sort()), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(tmp, p);
  } catch {
    // Never out of here: a throw would abandon the snapshot before its index (test round: a dir that cannot be
    //   emptied at the temp name).
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // left; the flag is not written this time
    }
  }
}

/** Adds the logs now past the cap to the flag, before a snapshot copies the guarded files. */
function flagOversized(dir: string): void {
  const now = bigLogs(dir);
  if (now.length > 0) writeFlag(dir, [...flagged(dir), ...now]);
}

/** (B5.96) The guarded append-only logs past the state cap, now or when a snapshot saw them: larger than any real
 *  session, so a Bash call padded them (round-2 delta review: padding pushed the oldest edit out of the part the gates
 *  read, and a log of a few hundred MB made every Stop run into its hook timeout; round 3: a log a hook append pushed
 *  past the cap had no copy, so a call could then delete it unseen). The Stop blocks on them. */
export function oversizedLogs(sessionId: string): string[] {
  const dir = ensureSessionDir(sessionId);
  return [...new Set([...flagged(dir), ...bigLogs(dir)])].sort();
}

/** After the user's marker passed the oversized-log block: the flag goes (a log still past the cap is flagged again
 *  by the next snapshot). */
export function clearOversizedLogs(sessionId: string): void {
  rmSync(join(ensureSessionDir(sessionId), OVERSIZED_FLAG), { force: true });
}

/** The model-facing reason for oversizedLogs (English, per the repo rule). */
export function oversizedLogsReason(names: readonly string[]): string {
  return (
    `goodboy's session logs ${names.join(', ')} are over ${MAX_STATE_BYTES / (1024 * 1024)} MB, larger than any real session: ` +
    'a Bash call padded them, which hides earlier records from the gates. Do not touch goodboy\'s session state; tell the user. ' +
    'Only the user can let this Stop pass.'
  );
}
