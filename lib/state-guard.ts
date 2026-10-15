// Gate state guard (track G security review): the Stop gates read state from the session dir
// in $TMPDIR (edit log, review/test cursors, dispatch log, skill evidence, validation
// failure, the commit issue pins), outside the project, where the Bash write gate allows writes. One
// `rm "$TMPDIR"/goodboy-session-*/edits.jsonl` would end a turn with neither tests nor review.
//
// So a model Bash call is bracketed: PreToolUse snapshots the guarded files, and the post
// hooks put back what the call removed or rewrote (append-only logs keep their old lines;
// cursors return to their old content; a cursor the call created is removed). A call that
// never reports back (`exit N`, G0 M18) is restored at the next Stop. A command that names a
// session dir with a mutating program is denied up front. Hooks and the model run as the same
// OS user, so this raises the bar; it cannot make the state tamper-proof.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { segmentChanging } from './outward-command';
import { safeToolUseId } from './approval-marker';

const GUARDED = /^(?:edits\.jsonl|dispatch-log\.jsonl|skill-evidence\.jsonl|commit-issue-pins\.json|marker-evidence\.jsonl|project-mode-pin\.json|\.goodboy-last-(?:review|test)-[0-9a-f]+\.json|\.goodboy-validation-failed\.json)$/;
const CURSOR = /^\.goodboy-last-(?:review|test)-[0-9a-f]+\.json$/;
/** Evidence logs: a line added during a model Bash call would be forged evidence (a skill run,
 *  the user's non-project answer), so these keep only their old lines, and one the call
 *  created is removed (track H). The exception is a skill-gap note: the skill rule asks the
 *  model to record it through `cli.ts skill-gap` from Bash, and it is the model's own note
 *  (H1 review: dropping it kept the skill rule denying). */
const EVIDENCE = /^(?:skill-evidence|marker-evidence)\.jsonl$/;

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
const MAX_BYTES = 16 * 1024 * 1024;

function snapDir(sessionId: string, toolUseId: string): string {
  return join(ensureSessionDir(sessionId), `${SNAP_PREFIX}${safeToolUseId(toolUseId)}`);
}

/** Copies the guarded gate files before a model Bash call. */
export function snapshotGateState(sessionId: string, toolUseId: string): void {
  try {
    const dir = ensureSessionDir(sessionId);
    const snap = snapDir(sessionId, toolUseId);
    mkdirSync(snap, { recursive: true });
    const names: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!GUARDED.test(name)) continue;
      const p = join(dir, name);
      try {
        const st = lstatSync(p);
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        writeFileSync(join(snap, name), readFileSync(p));
        names.push(name);
      } catch {
        // unreadable: not guarded this time
      }
    }
    writeFileSync(join(snap, '.index.json'), JSON.stringify({ t: Date.now(), names }), 'utf8');
  } catch {
    // best-effort
  }
}

function restoreFrom(sessionId: string, snap: string): string[] {
  const dir = ensureSessionDir(sessionId);
  const restored: string[] = [];
  let names: string[] = [];
  try {
    names = (JSON.parse(readFileSync(join(snap, '.index.json'), 'utf8')) as { names?: string[] }).names ?? [];
  } catch {
    names = [];
  }
  const had = new Set(names);
  for (const name of names) {
    const p = join(dir, name);
    let before: string;
    try {
      before = readFileSync(join(snap, name), 'utf8');
    } catch {
      continue;
    }
    // A file the call made oversized, or replaced with a FIFO, a link or a directory, is
    //   replaced unread (final G1 test rounds: reading a 3 GB sparse file killed the hook, and
    //   a directory stopped the restore of every later file).
    try {
      let now: string | null = null;
      try {
        const st = lstatSync(p);
        if (st.isFile() && st.size <= MAX_BYTES) now = readFileSync(p, 'utf8');
        else rmSync(p, { recursive: true, force: true });
      } catch {
        now = null;
      }
      if (EVIDENCE.test(name)) {
        const want = evidenceText(name, before, now);
        if (want !== now) {
          writeFileSync(p, want, 'utf8');
          restored.push(name);
        }
      } else if (name.endsWith('.jsonl')) {
        // Append-only: every old line must still be there, in front.
        if (now !== null && now.startsWith(before)) continue;
        const oldLines = new Set(before.split('\n'));
        const added = (now ?? '').split('\n').filter((l) => l !== '' && !oldLines.has(l));
        writeFileSync(p, before + added.map((l) => `${l}\n`).join(''), 'utf8');
        restored.push(name);
      } else if (now !== before) {
        writeFileSync(p, before, 'utf8');
        restored.push(name);
      }
    } catch {
      // this file could not be put back; the others still are
    }
  }
  // A cursor the call created would accept work without a review or test; an evidence log it
  //   created would be forged evidence.
  try {
    for (const name of readdirSync(dir)) {
      if ((CURSOR.test(name) || EVIDENCE.test(name)) && !had.has(name)) {
        const created = statSync(join(dir, name)).mtimeMs;
        const t = (JSON.parse(readFileSync(join(snap, '.index.json'), 'utf8')) as { t?: number }).t ?? 0;
        if (created >= t - 1000) {
          const kept = EVIDENCE.test(name) ? evidenceText(name, '', readFileSync(join(dir, name), 'utf8')) : '';
          if (kept === '') unlinkSync(join(dir, name));
          else writeFileSync(join(dir, name), kept, 'utf8');
          restored.push(name);
        }
      }
    }
  } catch {
    // best-effort
  }
  rmSync(snap, { recursive: true, force: true });
  return restored;
}

/** After a model Bash call: puts back what it removed or rewrote. Returns the file names. */
export function restoreGateState(sessionId: string, toolUseId: string | undefined): string[] {
  if (!toolUseId) return [];
  const snap = snapDir(sessionId, toolUseId);
  if (!existsSync(snap)) return [];
  try {
    return restoreFrom(sessionId, snap);
  } catch {
    return [];
  }
}

/** At Stop: restores the snapshots of calls that never reported back (`exit N`). */
export function restoreOrphanGateState(sessionId: string): string[] {
  const out: string[] = [];
  try {
    const dir = ensureSessionDir(sessionId);
    for (const name of readdirSync(dir)) {
      if (name.startsWith(SNAP_PREFIX)) out.push(...restoreFrom(sessionId, join(dir, name)));
    }
  } catch {
    // best-effort
  }
  return out;
}

const READ_PROGS = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'rg', 'wc', 'jq', 'stat', 'test', '[', 'file', 'less', 'tree', 'find', 'du', 'echo']);

/** True when a shell command changes a goodboy session dir: a segment that names
 *  `goodboy-session` (or a glob that matches it) and runs anything but a read, or redirects. */
export function writesGateState(command: string): boolean {
  return segmentChanging(command, (w) => /goodboy[-_]?(?:session|sess\*|s\*|\*)/i.test(w), READ_PROGS) !== null;
}
