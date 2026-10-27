// Acceptance criteria a session works on (track I, I2, issue #3, plan §15.5): every criterion
// has a test. lib/acceptance.ts reads the dev-cycle UIUX and prototype criteria; this adds
//   - REQ-<rank>: the dev-cycle REQUIREMENTS.md rows in progress (at the session's start or
//     now), and those implemented now that were not at the start (a row implemented before
//     was tested then; breaking it later is for I4 and I5);
//   - POL-<id>: the policy entries whose `test:` line is new or changed since the start.
// SessionStart pins the rows and the `test:` lines of the working tree (criteria-pin.json), and
// every Stop remembers what it required (criteria-seen.json), so editing the documents never
// drops a criterion (I2 security review: a row set back to not started, renamed, deleted, a
// heading or the version changed, the file removed). The state guard puts both back after a
// Bash call and removes one a call created; they are read only as regular files and written
// by a rename. With no pin the start is unknown: only the rows in progress now count, and no
// policy entry.
//
// The pin is for the checkout the session started in. Every other checkout (a linked worktree of
// the repository, #33) has a baseline and a seen list of its own, keyed like its start pin
// (lib/start-pins.ts): the worktrees that existed at the session's start are pinned then, from
// their work trees; a later one is read from its start commit, never from its documents now. A
// baseline that cannot be read or is unknown blocks (its criteria are not dropped).
//
// A product criterion (PT-*, UIUX-*, REQ-*) is about the product: its test is no document, and
// a mutation probe names the product file it broke (a check of the requirements proves the
// file, not the app).

import { existsSync, lstatSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { findDevCycleArtifacts, isPlaceholderCell, parseCurrentStage, parseCurrentVersion, readCurrentStage, VERIFY_STAGE, type AcceptanceCriterion } from './acceptance';
import { blobAtCommitResult, hookGit, repoTop } from './changed-coverage';
import { isDocumentFile } from './doc-verification';
import { ensureSessionDir } from './file-tracker';
import { knowledgeRoot, parsePolicyEntries, POLICY_FILE } from './project-knowledge';
import { realDeep } from './private-files';
import { projectRelative } from './role-limits';
import { MAX_DOC_BYTES, MAX_STATE_BYTES, readRegular } from './safe-read';
import { earlierKeys, topIdentity, topStart, worktreesAtStart, writeOnce, type TopIdentity } from './start-pins';
import { evidenceProblems, isTestFile, requiresMutationProbe, TEST_RUNNER_CONFIG } from './test-validator';
import { classifyFile, isTestkitHarness, needsTests } from './verification-scope';
import type { AcceptanceCoverage, TestResult } from './types';

export type RequirementStatus = 'implemented' | 'in-progress' | 'not-started';

export interface RequirementRow {
  rank: string;
  title: string;
  status: RequirementStatus;
}

const MAX_ROWS = 500;
/** Id lengths: the ids go into block messages and criteria-seen.json, which reads back only
 *  ids of these lengths and at most MAX_SEEN entries (the Stop stores no more). */
const RANK_DIGITS = 6;
const POLICY_ID_CHARS = 40;
const MAX_SEEN = 2 * MAX_ROWS;
const PIN_RANK = new RegExp(`^\\d{1,${RANK_DIGITS}}$`);
const RANK_HEAD = /^(?:순위|우선순위|rank|priority|#|no\.?)$/i;
const TITLE_HEAD = /^(?:요구사항|requirement)$/i;
const STATUS_HEAD = /^(?:상태|status)$/i;
const SECTION = /^##\s+(?:요구사항|requirements(?:\s|$|\())/i;

/** The cells of a table row: `|` splits, but not an escaped one or one inside backticks. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let code = false;
  const s = line.trim().replace(/^\|/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '`') {
      code = !code;
      cur += ch;
    } else if (ch === '|' && !code) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out;
}

/** A status cell, in Korean or English, with decorations (`🚧 구현중`, `구현완료 ✅`, `구현중 (50%)`). */
function statusOf(cell: string): RequirementStatus {
  const s = cell.toLowerCase();
  // The negative and future forms first: they contain the words of the others.
  if (/미구현|미완료|미착수|미진행|진행\s*전|예정|not started|not implemented|not done|not yet|not complete|not in[ -]progress|unimplemented|incomplete|todo|pending/.test(s)) {
    return 'not-started';
  }
  if (/완료|implemented|\bdone\b|complete/.test(s)) return 'implemented';
  if (/구현\s*중|진행|in[ -]progress|\bwip\b|implementing/.test(s)) return 'in-progress';
  return 'not-started';
}

/** The rows of every requirements table: the first table under each `## 요구사항…` or
 *  `## Requirements…` heading (all of them: an added section never hides the real one),
 *  columns found by their header names, fenced code skipped. Placeholder rows and rows with
 *  no number in their rank (`1`, `1.`, `P1`, `#3`) are left out. */
export function requirementRows(md: string): RequirementRow[] {
  const lines = (md ?? '').split(/\r\n|\r|\n/);
  const out: RequirementRow[] = [];
  let fence = false;
  let inSection = false;
  let header: { rank: number; title: number; status: number } | null = null;
  let tableDone = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^(?:```|~~~)/.test(t)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^#{1,2}\s/.test(t)) {
      inSection = SECTION.test(t);
      header = null;
      tableDone = false;
      continue;
    }
    if (!inSection || tableDone) continue;
    if (t === '') continue;
    if (!t.startsWith('|')) {
      if (header) tableDone = true;
      continue;
    }
    const c = cells(t);
    if (!header) {
      // The columns, once per table (per row, a crafted header made the parse quadratic).
      const at = (re: RegExp) => c.findIndex((h) => re.test(h.replace(/[*_`]/g, '').trim()));
      header = { rank: at(RANK_HEAD), title: at(TITLE_HEAD), status: at(STATUS_HEAD) };
      if (header.rank < 0 || header.title < 0 || header.status < 0) tableDone = true;
      continue;
    }
    if (c.every((x) => /^:?-+:?$/.test(x))) continue;
    const rank = /^(?:p|#|r|req-?)?(\d+)\.?$/i.exec((c[header.rank] ?? '').replace(/[*_`]/g, '').trim())?.[1]?.slice(0, RANK_DIGITS);
    const title = c[header.title] ?? '';
    if (!rank || title === '' || isPlaceholderCell(title)) continue;
    out.push({ rank, title, status: statusOf(c[header.status] ?? '') });
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

const key = (r: { rank: string; title: string }) => `${r.rank}\u0000${r.title}`;
const short = (s: string) => s.replace(/[\r\n\t]+/g, ' ').slice(0, 80);

/** The requirements in scope. `start`: the rows at the start; null when there was no file
 *  (every implemented row is new); undefined when the start is unknown (only the rows in
 *  progress now). In scope:
 *  - rows in progress at the start, by their start rank and title, whatever the file says now;
 *  - rows in progress now;
 *  - rows implemented now that were not implemented at the start, matched by rank and title as
 *    a multiset (one start row excuses one current row). */
export function requirementsInScope(now: RequirementRow[], start: RequirementRow[] | null | undefined): AcceptanceCriterion[] {
  const out = new Map<string, AcceptanceCriterion>();
  const add = (r: RequirementRow) => {
    const id = `REQ-${r.rank}`;
    const prev = out.get(id);
    if (!prev) out.set(id, { id, source: 'requirement', description: short(r.title) });
    else if (!prev.description.split(' / ').includes(short(r.title))) prev.description = short(`${prev.description} / ${r.title}`);
  };
  for (const r of start ?? []) if (r.status === 'in-progress') add(r);
  const excused = new Map<string, number>();
  for (const r of start ?? []) if (r.status === 'implemented') excused.set(key(r), (excused.get(key(r)) ?? 0) + 1);
  for (const r of now) {
    if (r.status === 'in-progress') add(r);
    else if (r.status === 'implemented' && start !== undefined) {
      const n = excused.get(key(r)) ?? 0;
      if (n > 0) excused.set(key(r), n - 1);
      else add(r);
    }
  }
  return [...out.values()];
}

/** The `test:` lines of a policy text, by entry id (the first entry of an id counts). */
export function policyTests(text: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const e of parsePolicyEntries(text)) if (e.fields.test && !(e.id in out)) out[e.id] = e.fields.test;
  return out;
}

/** The policy entries in scope: a `test:` line new or changed since the start (`start`: id →
 *  test line; null when there was no file; undefined when unknown, which adds none). */
export function policyInScope(now: Record<string, string>, start: Record<string, string> | null | undefined): AcceptanceCriterion[] {
  if (start === undefined) return [];
  const out: AcceptanceCriterion[] = [];
  for (const id of Object.keys(now)) {
    if (start !== null && Object.prototype.hasOwnProperty.call(start, id) && start[id] === now[id]) continue;
    out.push({ id: `POL-${id.slice(0, POLICY_ID_CHARS)}`, source: 'policy', description: short(now[id]!) });
  }
  return out;
}

/** A document's text (lib/safe-read.ts: FIFOs, devices, directories and huge files are not
 *  read), null when there is none, 'unreadable' otherwise. */
function readDoc(abs: string): string | null | 'unreadable' {
  const read = readRegular(abs, MAX_DOC_BYTES);
  return read === 'absent' ? null : read === 'refused' ? 'unreadable' : read.text;
}

interface Docs {
  rows: RequirementRow[] | null;
  policy: Record<string, string> | null;
  problems: string[];
}

/** The requirement rows and the policy `test:` lines of the working tree now. */
function currentDocs(cwd: string, top: string): Docs {
  const problems: string[] = [];
  let rows: RequirementRow[] | null = null;
  const art = findDevCycleArtifacts(cwd);
  if (art) {
    const text = readDoc(join(art.versionDir, 'REQUIREMENTS.md'));
    if (text === 'unreadable') problems.push(`${join(art.versionDir, 'REQUIREMENTS.md')} cannot be read`);
    else if (text !== null) rows = requirementRows(text);
  }
  let policy: Record<string, string> | null = null;
  const kr = knowledgeRoot(cwd);
  const policyPath = join(kr.root, POLICY_FILE);
  if (kr.policyExists && projectRelative(policyPath, top) !== null) {
    const text = readDoc(policyPath);
    if (text === 'unreadable') problems.push(`${policyPath} cannot be read`);
    else if (text !== null) policy = policyTests(text);
  }
  return { rows, policy, problems };
}

interface CriteriaPin {
  top: string;
  rows: RequirementRow[] | null;
  policy: Record<string, string> | null;
  /** (I11) The dev-cycle stage at the start: UI criteria are pending only when it and the
   *  stage now are both before verification, so setting the stage back mid-session relaxes
   *  nothing (I11 review). Absent in an older pin: unknown. */
  stage?: number | 'done' | null;
}

const PIN = 'criteria-pin.json';
const SEEN = 'criteria-seen.json';

/** A session file's JSON: a regular file only, never through a link (a FIFO or a link to
 *  /dev/zero hung every Stop; a link out of the session dir let a call rewrite it; I2
 *  security review round 3). Null when there is none or it is something else. */
function readState(sessionId: string, name: string): unknown {
  try {
    const read = readRegular(join(ensureSessionDir(sessionId), name), MAX_STATE_BYTES, true);
    return typeof read === 'string' ? null : (JSON.parse(read.text) as unknown);
  } catch {
    return null;
  }
}

/** Writes a session file by a rename, so a link, a FIFO or a directory put at its path is
 *  replaced, never written through. Throws when it cannot. */
function writeState(sessionId: string, name: string, value: unknown): void {
  const p = join(ensureSessionDir(sessionId), name);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
    try {
      renameSync(tmp, p);
    } catch {
      rmSync(p, { recursive: true, force: true }); // a directory: rename cannot replace it
      renameSync(tmp, p);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** SessionStart: the rows and `test:` lines the session starts from. A pin is kept (a resumed
 *  session keeps its start, also when it resumes in another checkout: #33). The session's first
 *  start also pins the criteria of the other worktrees that exist. Never throws. */
export function pinSessionCriteria(sessionId: string, cwd: string): void {
  try {
    const top = repoTop(cwd);
    if (readPin(sessionId)) return;
    const docs = currentDocs(cwd, top);
    const pin: CriteriaPin = { top, rows: docs.rows, policy: docs.policy, stage: readCurrentStage(cwd) };
    writeState(sessionId, PIN, pin);
    pinOtherTops(sessionId, top);
  } catch {
    // no pin: the start counts as unknown
  }
}

/** The criteria of the worktrees that exist at the session's start, other than the first: from their
 *  work trees as they are now. A document that cannot be read pins an unknown baseline, which blocks. */
function pinOtherTops(sessionId: string, startTop: string): void {
  const mine = realDeep(startTop);
  for (const w of worktreesAtStart(sessionId)) {
    if (w.top === mine) continue;
    try {
      const who = topIdentity(w.top);
      if (who.key !== w.key) continue;
      const docs = currentDocs(w.top, w.top);
      const body = docs.problems.length > 0 ? { unknown: docs.problems.join('; ') } : ({ top: who.top, rows: docs.rows, policy: docs.policy, stage: readCurrentStage(w.top) } satisfies CriteriaPin);
      writeOnce(join(ensureSessionDir(sessionId), `criteria-pin-${w.key}.json`), JSON.stringify(body));
    } catch {
      // not pinned: it is read from its start commit when first seen
    }
  }
}

function parsePin(p: Partial<CriteriaPin> | null): CriteriaPin | null {
  try {
    if (!p || typeof p.top !== 'string') return null;
    const rowsOk = p.rows === null || (Array.isArray(p.rows) && p.rows.every((r) => r && typeof r.rank === 'string' && PIN_RANK.test(r.rank) && typeof r.title === 'string' && typeof r.status === 'string'));
    const policyOk = p.policy === null || (typeof p.policy === 'object' && p.policy !== undefined && !Array.isArray(p.policy));
    if (!rowsOk || !policyOk) return null;
    const stage = p.stage === 'done' || (typeof p.stage === 'number' && Number.isInteger(p.stage) && p.stage >= 0 && p.stage < 100) ? p.stage : null;
    return { top: p.top, rows: p.rows as RequirementRow[] | null, policy: p.policy as Record<string, string> | null, stage };
  } catch {
    return null;
  }
}

function readPin(sessionId: string): CriteriaPin | null {
  return parsePin(readState(sessionId, PIN) as Partial<CriteriaPin> | null);
}

/** A document at a commit read as the work-tree read does (`readDoc`): its text; null when the commit
 *  has none; 'refused' when the entry is no regular file (a symlink) or over the size limit, which the
 *  work tree's read refuses too; 'error' when git fails (the answer is not known). */
function docAtCommit(top: string, head: string, rel: string): string | null | 'refused' | 'error' {
  const r = blobAtCommitResult(top, head, rel, MAX_DOC_BYTES);
  return r.kind === 'text' ? r.text : r.kind === 'absent' ? null : r.kind;
}

/** The criteria baseline of a commit: what `currentDocs` reads, from the commit's blobs, with its
 *  rules: an unreadable `docs/CYCLE.md` is no cycle (`readCycleMd`: no rows, no stage), an unreadable
 *  requirements table or policy file is a problem, and so is any git failure. */
function docsAtCommit(top: string, head: string): Omit<CriteriaPin, 'top'> | { problem: string } {
  const at = head.slice(0, 12);
  const cycleRead = docAtCommit(top, head, 'docs/CYCLE.md');
  if (cycleRead === 'error') return { problem: `docs/CYCLE.md at ${at} cannot be read` };
  const cycle = cycleRead === 'refused' ? null : cycleRead;
  const version = cycle === null ? null : parseCurrentVersion(cycle);
  let rows: RequirementRow[] | null = null;
  if (version && /^[A-Za-z0-9][\w.-]*$/.test(version) && !version.includes('..')) {
    const req = docAtCommit(top, head, `docs/versions/${version}/REQUIREMENTS.md`);
    if (req === 'error' || req === 'refused') return { problem: `docs/versions/${version}/REQUIREMENTS.md at ${at} cannot be read` };
    rows = req === null ? null : requirementRows(req);
  }
  const text = docAtCommit(top, head, POLICY_FILE);
  if (text === 'error' || text === 'refused') return { problem: `${POLICY_FILE} at ${at} cannot be read` };
  return { rows, policy: text === null ? null : policyTests(text), stage: cycle === null ? null : parseCurrentStage(cycle) };
}

/** The key of the criteria files (pin, seen list) of a checkout that is not the session's first: its own
 *  identity's, unless it has none yet and an earlier identity registered at its path has a criteria pin
 *  (the checkout was made again there: its criteria stay, #33 round 10). */
function criteriaKey(sessionId: string, who: TopIdentity): string {
  try {
    const dir = ensureSessionDir(sessionId);
    if (existsSync(join(dir, `criteria-pin-${who.key}.json`))) return who.key;
    return earlierKeys(sessionId, who).find((k) => existsSync(join(dir, `criteria-pin-${k}.json`))) ?? who.key;
  } catch {
    return who.key;
  }
}

/** The baseline of a checkout that is not the session's first (#33): its pin of the session's start,
 *  or (first sight) the documents of its start commit, pinned now. */
function otherTopBaseline(sessionId: string, top: string, who: TopIdentity): { pin: CriteriaPin } | { problem: string } {
  const name = `criteria-pin-${criteriaKey(sessionId, who)}.json`;
  const lost = (why: string) => ({ problem: `The criteria ${top} started from cannot be established (${why}). Start a new session in it, or ask the user.` });
  const raw = readState(sessionId, name) as (Partial<CriteriaPin> & { unknown?: unknown }) | null;
  if (raw && typeof raw.unknown === 'string') return lost(raw.unknown);
  const pinned = parsePin(raw);
  if (pinned) return { pin: pinned };
  if (existsSync(join(ensureSessionDir(sessionId), name))) return lost('its pin is unreadable');
  if (who.unknown !== undefined) return lost(`it could not be told what the checkout is: ${who.unknown}`);
  const start = topStart(sessionId, top);
  if (start.kind === 'unknown') return lost(`its start is unknown: ${start.reason}`);
  let pin: CriteriaPin;
  if (start.kind === 'empty') pin = { top: who.top, rows: null, policy: null, stage: null };
  else {
    const d = docsAtCommit(top, start.head);
    if ('problem' in d) return lost(d.problem);
    pin = { top: who.top, ...d };
  }
  try {
    if (who.id !== 'nogit') writeOnce(join(ensureSessionDir(sessionId), name), JSON.stringify(pin)); // a no-git identity is never kept
  } catch {
    // read again from the commit next time
  }
  return { pin };
}

/** (I11) Whether the session started before the verification stage: its pin names a stage
 *  below it. No pin, an older pin or an unknown stage: false (UI criteria block). `top`: the
 *  checkout asked about, when it is not the one the session started in (#33): its own pin, which
 *  the criteria check made. */
export function startedBeforeVerification(sessionId: string, top?: string): boolean {
  let pin = readPin(sessionId);
  if (pin && top !== undefined && pin.top !== top) {
    const raw = readState(sessionId, `criteria-pin-${criteriaKey(sessionId, topIdentity(top))}.json`) as Partial<CriteriaPin> | null;
    pin = parsePin(raw);
  }
  const stage = pin?.stage;
  return typeof stage === 'number' && stage < VERIFY_STAGE;
}

const SEEN_ID = new RegExp(`^(?:REQ-\\d{1,${RANK_DIGITS}}|POL-\\S{0,${POLICY_ID_CHARS}})$`);

/** The criteria earlier Stops required, rebuilt from their string fields only, so formatting
 *  one cannot throw: an entry whose id the Stop could not have written (another type, a long
 *  id) is dropped, a description that is no string is left empty. */
function readSeen(sessionId: string, name = SEEN): AcceptanceCriterion[] {
  try {
    const v = readState(sessionId, name);
    if (!Array.isArray(v)) return [];
    const out: AcceptanceCriterion[] = [];
    for (const c of v.slice(0, MAX_SEEN)) {
      const { id, description } = (c ?? {}) as { id?: unknown; description?: unknown };
      if (typeof id !== 'string' || !SEEN_ID.test(id)) continue;
      out.push({ id, source: id.startsWith('REQ-') ? 'requirement' : 'policy', description: typeof description === 'string' ? short(description) : '' });
    }
    return out;
  } catch {
    return [];
  }
}

export interface SessionCriteria {
  criteria: AcceptanceCriterion[];
  /** Why the criteria could not be read (the gate blocks: unknown criteria are not covered). */
  problem?: string;
}

/** The criteria this session works on: against its pinned start, plus every criterion an
 *  earlier Stop of the session required (remembered, so a document edited since keeps it). */
export function sessionCriteria(sessionId: string, cwd: string): SessionCriteria {
  let seenName = SEEN;
  try {
    const top = repoTop(cwd);
    const pin = readPin(sessionId);
    // The first top's path keeps the first pin and seen list when its checkout was made again: its
    //   criteria stay (#33 round 10); its start is lib/start-pins.ts's.
    const first = pin !== null && pin.top === top;
    let start: CriteriaPin | undefined = first ? pin! : undefined;
    if (pin && !first) {
      // (#33) Another checkout: its own baseline and its own list of what Stops required there.
      const who = topIdentity(top);
      seenName = `criteria-seen-${criteriaKey(sessionId, who)}.json`;
      const base = otherTopBaseline(sessionId, top, who);
      if ('problem' in base) return { criteria: readSeen(sessionId, seenName), problem: base.problem };
      start = base.pin;
    }
    const docs = currentDocs(cwd, top);
    const found = [
      ...requirementsInScope(docs.rows ?? [], start ? start.rows : undefined),
      ...(docs.policy !== null ? policyInScope(docs.policy, start ? start.policy : undefined) : []),
    ];
    const byId = new Map<string, AcceptanceCriterion>();
    for (const c of readSeen(sessionId, seenName)) byId.set(c.id, c);
    for (const c of found) byId.set(c.id, c);
    const criteria = [...byId.values()];
    // The gate's list is never cut; past MAX_SEEN the store drops remembered criteria, never
    //   those found now.
    const now = new Set(found.map((c) => c.id));
    const stored = [...criteria.filter((c) => now.has(c.id)), ...criteria.filter((c) => !now.has(c.id))].slice(0, MAX_SEEN);
    if (stored.length > 0) writeState(sessionId, seenName, stored);
    return { criteria, ...(docs.problems.length > 0 ? { problem: `The acceptance criteria cannot be read: ${docs.problems.join('; ')}.` } : {}) };
  } catch (err) {
    return { criteria: readSeen(sessionId, seenName), problem: `The acceptance criteria cannot be read (${String(err).slice(0, 200)}).` };
  }
}

/** For `acceptance-list` (advice; the gate uses the session's pin and lists what it requires):
 *  the rows in progress now. Policy lines are not listed: their scope needs the session's start. */
export function criteriaNow(cwd: string): AcceptanceCriterion[] {
  try {
    return requirementsInScope(currentDocs(cwd, repoTop(cwd)).rows ?? [], undefined);
  } catch {
    return [];
  }
}

const PRODUCT = /^(?:PT-|UIUX-|REQ-)/;

/** A document for a product criterion's evidence: a document (lib/doc-verification.ts) or a
 *  dev-cycle artifact (`docs/CYCLE.md`, anything under `docs/versions/`: the requirements, the
 *  prototype). */
function isProductDoc(rel: string): boolean {
  return isDocumentFile(rel) || /^docs\/(?:versions\/|cycle\.md$)/i.test(rel);
}

/** A test file under `docs/versions/<version>/` that runs the product (#32): a browser test of the
 *  product script kept next to the version's documents was rejected as a document. Only when the
 *  file is a test by its name, no document or static preview by its class, an existing regular
 *  single-link file of the repo, and THIS acceptance entry holds valid red and green and a
 *  detected mutation of an existing product file (a code file that needs tests: no document, no
 *  test, no harness or runner config, no scratch or git-ignored copy). Any read or git error is
 *  a no. `isProductDoc` itself stays as it was.
 *
 *  `mutation.detected: true` is the testing agent's attestation, as it is for every UIUX- and PT-
 *  criterion (`requiresMutationProbe`); the gate does not re-run the mutation, so it is not proven
 *  causality. What the gate checks is the shape: this entry names a mutation command, a product
 *  file that exists, valid red and green, and a test that is code by its class. */
const VERSION_DIR_TEST = /^docs\/versions\/[^/]+\//i;
export function devCycleTestIsProductEvidence(testRel: string, cov: AcceptanceCoverage, root: string, ignored: IgnoreLookup = ignoreLookup(root, [])): boolean {
  try {
    if (!VERSION_DIR_TEST.test(testRel) || !isTestFile(testRel)) return false;
    const abs = join(root, testRel);
    if (!regularInRepo(abs, root) || classifyFile(abs, root) !== 'code') return false;
    if (evidenceProblems(cov).length > 0) return false;
    const m = cov.mutation;
    if (!m || typeof m.command !== 'string' || m.command.trim() === '' || m.detected !== true) return false;
    return typeof m.file === 'string' && isProductFile(m.file, root, ignored);
  } catch {
    return false;
  }
}

/** Whether git ignores a repo-relative path: true, false, or null when git cannot say. */
export type IgnoreLookup = (rel: string) => boolean | null;

/** One `git check-ignore --stdin` for every path planned (canonical, so aliases of one file are
 *  one path), run on the first question; a path asked that was not planned runs it again with
 *  that path added. A path git cannot decide, or a git that fails, answers null: no product
 *  file. A name starting with `:` is a pathspec magic to `check-ignore`: null. */
export function ignoreLookup(root: string, planned: Iterable<string>): IgnoreLookup {
  const asked = new Set(planned);
  let checked: Set<string> | null = null;
  let ignoredSet: Set<string> | null = null;
  return (rel) => {
    if (rel.startsWith(':')) return null;
    if (checked === null || !checked.has(rel)) {
      asked.add(rel);
      const list = [...asked].filter((p) => !p.startsWith(':'));
      // Exit 0: some ignored, printed; 1: none; anything else: unknown.
      const r = hookGit(root, ['check-ignore', '-z', '--stdin'], list.map((p) => `${p}\0`).join(''));
      checked = new Set(asked);
      ignoredSet = r.code === 0 || r.code === 1 ? new Set(r.out.split('\0').filter((p) => p !== '')) : null;
    }
    return ignoredSet === null ? null : ignoredSet.has(rel);
  };
}

/** An existing regular file with one link, whose real path is inside `root`. */
function regularInRepo(abs: string, root: string): boolean {
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.nlink !== 1) return false;
    return projectRelative(realpathSync(abs), realpathSync(root)) !== null;
  } catch {
    return false;
  }
}

/** A path segment that marks a scratch or build copy, never the product itself. */
const SCRATCH_SEGMENT = /(?:^|\/)(?:target|build|dist|node_modules|\.git|\.claude|\.testkit-run|tmp|temp|scratch)\//i;

/** The repo-relative path of the file a mutation broke when it is an existing product file of the
 *  repo by everything but git's ignore rules (#32), else null. */
function productCandidate(value: string, root: string): string | null {
  const rel = evidencePath(value, root);
  if (rel === null || rel === 'outside' || rel === '') return null;
  const abs = join(root, rel);
  if (!regularInRepo(abs, root)) return null;
  if (isProductDoc(rel) || isTestFile(rel) || TEST_RUNNER_CONFIG.test(rel) || isTestkitHarness(abs, root)) return null;
  if (SCRATCH_SEGMENT.test(rel) || /(?:^|\/)__probe[^/]*$/.test(rel)) return null;
  return needsTests(abs, root) ? rel : null;
}

/** The file a mutation broke is an existing product file of the repo (#32). */
function isProductFile(value: string, root: string, ignored: IgnoreLookup): boolean {
  const rel = productCandidate(value, root);
  // A git-ignored file is a copy, not the product (ignored: a copy; unknown: no).
  return rel !== null && ignored(rel) === false;
}

/** A path-like value as repo-relative (symlinks resolved when the file exists), 'outside' when
 *  it is not in the repo, null when it is no path (a test name). */
function evidencePath(value: string, root: string): string | 'outside' | null {
  if (!/[\\/]/.test(value) && !/\.[A-Za-z0-9]+$/.test(value)) return null;
  let abs = resolvePath(root, value);
  let base = root;
  try {
    if (existsSync(abs)) {
      abs = realpathSync(abs);
      base = realpathSync(root);
    }
  } catch {
    // as written
  }
  const rel = projectRelative(abs, base);
  if (rel === null) return isAbsolute(value) || relative(base, abs).startsWith('..') ? 'outside' : null;
  return rel;
}

/** Why the evidence of a product criterion is a document check (I2), one line each. */
export function productEvidenceProblems(results: TestResult[], root: string): string[] {
  const out: string[] = [];
  // The dev-cycle tests' product files, asked of git once for all of them (v0.36.6): every
  //   path a mutation names that could be product evidence, canonical and without duplicates.
  const planned = new Set<string>();
  for (const r of results) {
    for (const cov of r.acceptance ?? []) {
      const test = typeof cov?.id === 'string' && PRODUCT.test(cov.id) && typeof cov.test === 'string' ? evidencePath(cov.test, root) : null;
      const file = cov?.mutation?.file;
      if (test === null || test === 'outside' || !VERSION_DIR_TEST.test(test) || typeof file !== 'string') continue;
      const rel = productCandidate(file, root);
      if (rel !== null) planned.add(rel);
    }
  }
  const ignored = ignoreLookup(root, planned);
  for (const r of results) {
    for (const cov of r.acceptance ?? []) {
      const id = typeof cov?.id === 'string' ? cov.id : '';
      if (!PRODUCT.test(id)) continue;
      const test = typeof cov.test === 'string' ? evidencePath(cov.test, root) : null;
      if (test === 'outside') out.push(`${id}: its test (${short(cov.test)}) is not in this repo.`);
      else if (test !== null && isProductDoc(test)) {
        if (isDocumentFile(test)) {
          out.push(`${id}: its test is a document (${short(cov.test)}); a product criterion needs a test of the product code.`);
        } else if (!devCycleTestIsProductEvidence(test, cov, root, ignored)) {
          // (#32) Code in the dev-cycle folder: product evidence only with a mutation of the product.
          out.push(
            `${id}: its test (${short(cov.test)}) is in the dev-cycle folder, where it counts as a document. Move the test out ` +
              'of docs/versions, or give a detected mutation of the product file for this criterion (this entry\'s mutation: ' +
              'a command, detected true, and file = the repo path of the product file it broke), with valid red and green.',
          );
        }
      }
      const file = cov.mutation?.file;
      if (requiresMutationProbe(id) && cov.mutation && (typeof file !== 'string' || file.trim() === '')) {
        out.push(`${id}: the mutation probe names no file (mutation.file): give the repo path of the product file it broke.`);
      } else if (typeof file === 'string' && file.trim() !== '') {
        const broken = evidencePath(file, root);
        if (broken === 'outside' || broken === null) {
          out.push(`${id}: mutation.file (${short(file)}) must be the repo path of the file the probe broke, not a scratch copy's path.`);
        } else if (isProductDoc(broken)) {
          out.push(`${id}: its mutation probe broke a document (${short(file)}); break the product code instead.`);
        }
      }
    }
  }
  return out;
}
