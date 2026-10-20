// Update checkups (track K, K1 #10, plan §17), step K1a: the checkup state, the changelog range
// since the last check, and the run writer. The `cli-update-check` skill drives them through
// lib/cli.ts; nothing here runs by itself, registers a hook or exempts a gate.
//
// - State lives in ~/.claude/goodboy/checkups/ (GOODBOY_CHECKUP_DIR for tests), never in the
//   versioned plugin cache. Writes are atomic (a new temp file renamed over state.json) and
//   locked (state.lock). `observed`, `pending` and `lastChecked` are kept apart: only a
//   completed run advances `lastChecked`.
// - The changelog range comes from Claude Code's local changelog cache. A range the cache does
//   not cover is "incomplete", never "nothing changed".
// - Reports go only into `runs/<run-id>/` through writeRunFile, never a general write path.

import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { checkDir, checkedPrivateDir, claudeConfigDir, createNew, isUnder, processAlive } from './private-files';
import { readRegular } from './safe-read';

export { claudeConfigDir } from './private-files';

// ---- where ----

/** The checkup dir: GOODBOY_CHECKUP_DIR (absolute), else ~/.claude/goodboy/checkups. */
export function checkupDir(env: NodeJS.ProcessEnv = process.env): string {
  const o = (env.GOODBOY_CHECKUP_DIR ?? '').trim();
  if (o !== '' && isAbsolute(o)) return o;
  return join((env.HOME ?? '').trim() || homedir(), '.claude', 'goodboy', 'checkups');
}

/** The checkup dir after its checks (made 0700 when `create`): never inside Claude Code's
 *  plugins dir or goodboy's own files, which an update replaces; a real dir of this user that
 *  others cannot write. Null when it is missing and not to be made. */
export function checkedCheckupDir(env: NodeJS.ProcessEnv = process.env, create = true): string | null {
  const dir = checkupDir(env);
  for (const [root, what] of [
    [join(claudeConfigDir(env), 'plugins'), "Claude Code's plugins dir"],
    [resolve(import.meta.dir, '..'), "goodboy's own directory"],
  ] as const) {
    if (isUnder(dir, root)) throw new Error(`the checkup dir ${dir} is inside ${what}, which an update replaces`);
  }
  return checkedPrivateDir(dir, 'the checkup dir', create);
}

// ---- versions ----

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/** A CLI version as `x.y.z`; a leading `v` is dropped. Anything else throws: a version that
 *  does not compare would make every range look empty (K1a review). */
export function normalizeVersion(v: string): string {
  const s = v.trim().replace(/^v/i, '');
  if (!VERSION.test(s)) throw new Error(`not a CLI version: ${v} (expected x.y.z)`);
  return s;
}

export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split('.').map(Number);
  const pb = normalizeVersion(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// ---- state ----

export type RangeStatus = 'complete' | 'incomplete' | 'empty' | 'downgrade' | 'first-run';

export interface RangeNote {
  status: RangeStatus;
  gaps: string[];
}

export interface CheckupState {
  schema: 1;
  /** The CLI version of the last run that began. */
  observed: { cli: string; at: string } | null;
  /** A run begun and not yet completed or aborted, with the Claude Code session that began it
   *  and the range its changelog step saw. */
  pending: { cli: string; run: string; started: string; session: string | null; range: RangeNote | null } | null;
  /** The CLI version of the last completed run, and the range that run saw: a completed run
   *  with gaps says so to the next one (K1a review). */
  lastChecked: { cli: string; at: string; run: string; range: RangeNote | null } | null;
}

const STATE_FILE = 'state.json';
const LOCK_FILE = 'state.lock';
export const RUN_ID = /^\d{8}T\d{6}Z-\d{1,10}$/;
const SESSION = /^[\w-]{1,64}$/;
/** A stale lock: its process is gone, or it is older than this. */
const LOCK_STALE_MS = 10 * 60_000;
/** A pending run of another session counts as in progress for this long; after it, it was
 *  abandoned. The CLI process that began it ends at once, so its pid says nothing. */
export const PENDING_TTL_MS = 24 * 60 * 60_000;

export function emptyState(): CheckupState {
  return { schema: 1, observed: null, pending: null, lastChecked: null };
}

function isRangeNote(r: unknown): r is RangeNote | null {
  if (r === null) return true;
  const o = r as RangeNote;
  return !!o && typeof o.status === 'string' && Array.isArray(o.gaps) && o.gaps.every((g) => typeof g === 'string');
}

/** The state, or an empty one when there is none. A state that is not goodboy's shape throws:
 *  resetting it would lose `lastChecked` and make the next range look complete. */
export function readCheckupState(dir: string): CheckupState {
  const r = readRegular(join(dir, STATE_FILE), 64 * 1024, true);
  if (r === 'absent') return emptyState();
  if (r === 'refused') throw new Error(`${join(dir, STATE_FILE)} is not a regular file; move it away`);
  let s: Partial<CheckupState>;
  try {
    s = JSON.parse(r.text) as Partial<CheckupState>;
  } catch {
    throw new Error(`${join(dir, STATE_FILE)} is not valid JSON; move it away (the next check then starts as a first run)`);
  }
  const ok =
    s &&
    s.schema === 1 &&
    (s.observed === null || (typeof s.observed?.cli === 'string' && VERSION.test(s.observed.cli) && typeof s.observed.at === 'string')) &&
    (s.pending === null ||
      (typeof s.pending?.cli === 'string' &&
        VERSION.test(s.pending.cli) &&
        RUN_ID.test(String(s.pending.run)) &&
        typeof s.pending.started === 'string' &&
        (s.pending.session === null || (typeof s.pending.session === 'string' && SESSION.test(s.pending.session))) &&
        isRangeNote(s.pending.range))) &&
    (s.lastChecked === null ||
      (typeof s.lastChecked?.cli === 'string' && VERSION.test(s.lastChecked.cli) && RUN_ID.test(String(s.lastChecked.run)) && isRangeNote(s.lastChecked.range)));
  if (!ok) throw new Error(`${join(dir, STATE_FILE)} is not a checkup state; move it away (the next check then starts as a first run)`);
  return s as CheckupState;
}

/** Writes the state atomically: a new file made exclusively and synced, then renamed over the
 *  state, so a reader sees the old state or the new one, never half of one. */
function writeCheckupState(dir: string, s: CheckupState): void {
  const tmp = join(dir, `.state.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  if (!createNew(tmp, JSON.stringify(s, null, 2) + '\n')) throw new Error(`${tmp} exists`);
  try {
    renameSync(tmp, join(dir, STATE_FILE));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
}

/** Takes `lock` if nothing is there: the lock appears with its whole text at once (a complete
 *  temp file hard-linked to the lock name, which fails if the name is taken), so no other
 *  command ever reads a lock half written (K1a review: an empty lock read as stale). */
function tryLock(lock: string, mine: string): boolean {
  const tmp = `${lock}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  if (!createNew(tmp, mine)) throw new Error(`${tmp} exists`);
  try {
    linkSync(tmp, lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
  }
}

/** Takes the state lock. A live lock fails the command. A stale one (its process gone, or
 *  older than LOCK_STALE_MS) is moved aside by an atomic rename and dropped only if what moved
 *  is the lock judged stale; a fresh lock moved by mistake is linked back when its name is
 *  still free. If a third command took the name first, the moved lock's holder finds its lock
 *  gone before it writes and writes nothing (updateCheckupState). Never removes a lock it did
 *  not read (K1a review: a released lock read as absent, then a third command's fresh lock was
 *  removed). */
function acquireLock(lock: string, mine: string, now: number): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (tryLock(lock, mine)) return;
    const r = readRegular(lock, 256, true);
    if (r === 'absent') continue;
    if (r === 'refused') throw new Error(`${lock} is not a regular file; move it away`);
    const [pid, at] = r.text.trim().split(' ').map(Number);
    const stale = !Number.isInteger(pid) || !processAlive(pid) || !Number.isFinite(at) || now - at > LOCK_STALE_MS;
    if (!stale) throw new Error(`another checkup command holds ${lock} (pid ${pid}); try again when it ends`);
    const aside = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try {
      renameSync(lock, aside);
    } catch {
      continue;
    }
    const moved = readRegular(aside, 256, true);
    if (typeof moved === 'string' || moved.text !== r.text) {
      // Another command's fresh lock: put it back where it was, if the name is still free.
      try {
        linkSync(aside, lock);
      } catch {
        // taken again meanwhile; that command holds it
      }
    }
    try {
      unlinkSync(aside);
    } catch {
      // best-effort
    }
  }
  throw new Error(`could not take ${lock}; try again`);
}

/** Runs `fn` on the state under the lock and writes what it returns. */
export function updateCheckupState(dir: string, fn: (s: CheckupState) => CheckupState, now = Date.now()): CheckupState {
  const lock = join(dir, LOCK_FILE);
  const mine = `${process.pid} ${now} ${Math.random().toString(36).slice(2)}`;
  acquireLock(lock, mine, now);
  try {
    const next = fn(readCheckupState(dir));
    // Still ours right before the write: a rare race in another command's stale takeover can
    //   move a fresh lock away (K1a review round 2); then this command writes nothing.
    const held = readRegular(lock, 256, true);
    if (typeof held === 'string' || held.text !== mine) throw new Error(`lost ${lock} to another checkup command; nothing was written, try again`);
    writeCheckupState(dir, next);
    return next;
  } finally {
    const r = readRegular(lock, 256, true);
    if (typeof r !== 'string' && r.text === mine) {
      try {
        unlinkSync(lock);
      } catch {
        // best-effort
      }
    }
  }
}

/** A new run id from the time and this process: `20261020T051500Z-1234`. */
export function newRunId(now = new Date(), pid = process.pid): string {
  return `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${pid}`;
}

/** Records the CLI version of a run that begins; `lastChecked` and `pending` stay. */
export function observe(s: CheckupState, cli: string, now = new Date()): CheckupState {
  return { ...s, observed: { cli: normalizeVersion(cli), at: now.toISOString() } };
}

/** Begins a run for `cli` in Claude Code session `session` (CLAUDE_CODE_SESSION_ID; null
 *  outside Claude Code). A pending run of another session that began less than PENDING_TTL_MS
 *  ago is in progress and fails this, unless `replace`; the same session may begin again. */
export function beginRun(s: CheckupState, cli: string, run: string, now = new Date(), session: string | null = null, replace = false): CheckupState {
  const v = normalizeVersion(cli);
  if (!RUN_ID.test(run)) throw new Error(`not a run id: ${run}`);
  const sid = session !== null && SESSION.test(session) ? session : null;
  const p = s.pending;
  if (p && !replace && !(sid !== null && p.session === sid)) {
    const age = now.getTime() - Date.parse(p.started);
    if (!(age > PENDING_TTL_MS)) {
      throw new Error(
        `run ${p.run} (begun ${p.started}${p.session ? ` in session ${p.session.slice(0, 8)}` : ''}) is still pending; ` +
          `abort it (checkup-abort --run ${p.run}) or pass --replace. Only the session that began it can complete it`,
      );
    }
  }
  return { ...observe(s, v, now), pending: { cli: v, run, started: now.toISOString(), session: sid, range: null } };
}

/** The pending run `run` when `session` began it (both outside Claude Code counts too): only
 *  that session may note its range or complete it (K1a review round 2: another session
 *  completed a run it never checked, and `lastChecked` moved). */
function ownPending(s: CheckupState, run: string, session: string | null): NonNullable<CheckupState['pending']> {
  if (!s.pending || s.pending.run !== run) throw new Error(`run ${run} is not the pending run (${s.pending?.run ?? 'none'})`);
  const sid = session !== null && SESSION.test(session) ? session : null;
  if (s.pending.session !== sid) throw new Error(`run ${run} belongs to another session; only the session that began it can complete it`);
  return s.pending;
}

/** Notes the range the pending run's changelog step saw; completing the run keeps it. */
export function noteRange(s: CheckupState, run: string, range: RangeNote, session: string | null = null): CheckupState {
  const p = ownPending(s, run, session);
  return { ...s, pending: { ...p, range: { status: range.status, gaps: [...range.gaps] } } };
}

/** Completes the pending run of this session: only now does `lastChecked` move, to the run's
 *  CLI version, with the range it saw. */
export function completeRun(s: CheckupState, run: string, now = new Date(), session: string | null = null): CheckupState {
  const p = ownPending(s, run, session);
  return { ...s, pending: null, lastChecked: { cli: p.cli, at: now.toISOString(), run, range: p.range } };
}

/** Drops the pending run; `lastChecked` stays. */
export function abortRun(s: CheckupState, run: string): CheckupState {
  if (!s.pending || s.pending.run !== run) throw new Error(`run ${run} is not the pending run (${s.pending?.run ?? 'none'})`);
  return { ...s, pending: null };
}

/** The running CLI's version from `claude --version`, or null. */
export function runningCliVersion(): string | null {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
    const m = /(\d{1,4}\.\d{1,4}\.\d{1,6})/.exec(r.stdout ?? '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ---- the changelog ----

export interface ChangelogSection {
  version: string;
  entries: string[];
}

/** The sections of Claude Code's changelog (`## <version>` and `- ` entries; indented lines
 *  continue the entry above). */
export function parseChangelog(text: string): ChangelogSection[] {
  const out: ChangelogSection[] = [];
  let cur: ChangelogSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+v?(\d{1,4}\.\d{1,4}\.\d{1,6})\s*$/.exec(line);
    if (h) {
      cur = { version: h[1], entries: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const e = /^[-*]\s+(.*)$/.exec(line);
    if (e) cur.entries.push(e[1].trim());
    else if (/^\s+\S/.test(line) && cur.entries.length > 0) cur.entries[cur.entries.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

export interface ChangelogRange extends RangeNote {
  from: string | null;
  to: string;
  /** Newest first. For a downgrade: the versions rolled back. For a first run: `to` only. */
  sections: ChangelogSection[];
}

/** The changelog sections after `from` up to `to`. A range the cache does not cover at either
 *  end is incomplete, never "nothing changed"; `to` older than `from` is a downgrade. */
export function changelogRange(all: ChangelogSection[], fromIn: string | null, toIn: string): ChangelogRange {
  const from = fromIn === null ? null : normalizeVersion(fromIn);
  const to = normalizeVersion(toIn);
  const sorted = [...all].sort((a, b) => compareVersions(b.version, a.version));
  const gaps: string[] = [];
  const newest = sorted[0]?.version ?? null;
  const oldest = sorted[sorted.length - 1]?.version ?? null;
  if (newest === null) gaps.push('the changelog cache is empty or missing');
  else if (!sorted.some((s) => s.version === to)) gaps.push(`the changelog cache has no entry for ${to} (newest: ${newest})`);
  if (from === null) {
    return { status: gaps.length > 0 ? 'incomplete' : 'first-run', from, to, sections: sorted.filter((s) => s.version === to), gaps };
  }
  const c = compareVersions(to, from);
  if (c === 0) return { status: 'empty', from, to, sections: [], gaps: [] };
  if (c < 0) {
    return { status: 'downgrade', from, to, sections: sorted.filter((s) => compareVersions(s.version, to) > 0 && compareVersions(s.version, from) <= 0), gaps };
  }
  if (oldest !== null && compareVersions(oldest, from) > 0) gaps.push(`the changelog cache starts at ${oldest}, after the last checked ${from}`);
  const sections = sorted.filter((s) => compareVersions(s.version, from) > 0 && compareVersions(s.version, to) <= 0);
  return { status: gaps.length > 0 ? 'incomplete' : 'complete', from, to, sections, gaps };
}

export interface ChangelogFinding {
  version: string;
  bucket: 'matched' | 'unmapped';
  excerpt: string;
  /** The identifiers it names (matched) or the topic word (unmapped). */
  contracts: string[];
  confidence: 'high' | 'low';
  probe: string;
}

/** Topics a customization can depend on: an entry about them that names no identifier in use
 *  may still matter. */
const RELEVANT = /\b(hooks?|plugins?|skills?|subagents?|agents?|frontmatter|settings(?:\.json)?|CLAUDE\.md|MCP|permissions?|slash commands?|statusline|status line|marketplace|output styles?|allowed-tools|disallowedTools|env(?:ironment)? var(?:iable)?s?)\b/i;

const HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd',
  'UserPromptSubmit', 'Notification', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'PermissionRequest',
]);

/** A first probe for what an entry names. */
function probeFor(ids: string[]): string {
  const id = ids[0] ?? '';
  if (HOOK_EVENTS.has(id)) return `feed goodboy's ${id} hook a recorded payload and check its decision and consequence`;
  if (/^[a-z]+(?:_[a-z]+)+$/.test(id)) return `check that recorded hook payloads still carry \`${id}\` with the same meaning`;
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(id)) return `run a zero-turn smoke case with and without ${id}`;
  if (/^--/.test(id)) return `run the command with ${id} in a disposable dir`;
  return `check the customizations that use \`${id}\` (plugin validate, a smoke case)`;
}

const NAME_CHAR = /[\w-]/;

/** An entry naming `id` as a whole token (not part of a longer name: `Stop` is not in
 *  `StopFailure` or `SubagentStop`). A plain search, no regex per pair (K1a review: 7.5 s for
 *  the whole cache with 300 identifiers). */
function names(entry: string, id: string): boolean {
  for (let i = entry.indexOf(id); i >= 0; i = entry.indexOf(id, i + 1)) {
    const before = i > 0 ? entry[i - 1] : '';
    const after = entry[i + id.length] ?? '';
    if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true;
  }
  return false;
}

/** Every entry of the range sorted into matched (names an identifier in use), unmapped but
 *  possibly relevant (a topic customizations depend on), or other (counted only). */
export function triageChangelog(sections: ChangelogSection[], identifiers: readonly string[]): { findings: ChangelogFinding[]; counts: Record<'matched' | 'unmapped' | 'other', number> } {
  const ids = Array.from(new Set(identifiers.map((x) => x.trim()).filter((x) => x !== '')));
  const findings: ChangelogFinding[] = [];
  const counts = { matched: 0, unmapped: 0, other: 0 };
  for (const s of sections) {
    for (const entry of s.entries) {
      const excerpt = entry.length > 300 ? `${entry.slice(0, 297)}...` : entry;
      const hit = ids.filter((id) => names(entry, id));
      if (hit.length > 0) {
        counts.matched++;
        findings.push({ version: s.version, bucket: 'matched', excerpt, contracts: hit, confidence: 'high', probe: probeFor(hit) });
        continue;
      }
      const topic = RELEVANT.exec(entry);
      if (topic) {
        counts.unmapped++;
        findings.push({ version: s.version, bucket: 'unmapped', excerpt, contracts: [topic[1].toLowerCase()], confidence: 'low', probe: `check whether a customization depends on this ${topic[1].toLowerCase()} change` });
        continue;
      }
      counts.other++;
    }
  }
  return { findings, counts };
}

/** At most `matched` matched and `unmapped` unmapped findings, in order, and how many were
 *  left out: a long range must not flood the model's context (K1a review: about 1 MB of JSON
 *  for the whole cache). */
export function limitFindings(findings: ChangelogFinding[], matched: number, unmapped: number): { listed: ChangelogFinding[]; left_out: { matched: number; unmapped: number } } {
  const m = findings.filter((f) => f.bucket === 'matched');
  const u = findings.filter((f) => f.bucket === 'unmapped');
  const keep = new Set([...m.slice(0, matched), ...u.slice(0, unmapped)]);
  return { listed: findings.filter((f) => keep.has(f)), left_out: { matched: Math.max(0, m.length - matched), unmapped: Math.max(0, u.length - unmapped) } };
}

/** Claude Code's local changelog cache, or null when it is missing or not a regular file. */
export function readChangelogCache(path: string): string | null {
  const r = readRegular(path, 8 * 1024 * 1024, true);
  return typeof r === 'string' ? null : r.text;
}

// ---- the run writer ----

/** A report file name: a plain name with a report extension, no path, no leading dot. */
export const RUN_FILE = /^[A-Za-z0-9][\w.-]{0,79}\.(?:md|json|txt)$/;
export const MAX_RUN_FILE_BYTES = 2 * 1024 * 1024;

/** Makes `runs/<run>/` (0700) for a run that begins. */
export function makeRunDir(dir: string, run: string): string {
  if (!RUN_ID.test(run)) throw new Error(`not a run id: ${run}`);
  const runs = join(dir, 'runs');
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  checkDir(runs, 'the runs dir');
  const rd = join(runs, run);
  mkdirSync(rd, { mode: 0o700 });
  checkDir(rd, 'the run dir');
  return rd;
}

/** The checks writeRunFile makes before it writes, also usable before reading the text (the
 *  CLI checks first, then reads stdin). Returns the file's path. */
export function runFileTarget(dir: string, run: string, name: string): string {
  if (!RUN_ID.test(run)) throw new Error(`not a run id: ${run}`);
  if (!RUN_FILE.test(name) || name.includes('..')) throw new Error(`not a report file name: ${name} (letters, digits, . _ -, ending .md, .json or .txt)`);
  const s = readCheckupState(dir);
  if (s.pending?.run !== run) throw new Error(`run ${run} is not the pending run (${s.pending?.run ?? 'none'})`);
  const runs = join(dir, 'runs');
  checkDir(runs, 'the runs dir');
  const rd = join(runs, run);
  checkDir(rd, 'the run dir');
  if (!isUnder(rd, dir)) throw new Error(`the run dir ${rd} is outside the checkup dir`);
  return join(rd, name);
}

/** Writes one new report file into `runs/<run>/`, and nowhere else: the run must be the
 *  pending one, the dirs real and private, the name plain, and nothing may be at the name
 *  already (never through a link). Returns the path. */
export function writeRunFile(dir: string, run: string, name: string, text: string): string {
  if (Buffer.byteLength(text, 'utf8') > MAX_RUN_FILE_BYTES) throw new Error(`the report is larger than ${MAX_RUN_FILE_BYTES} bytes`);
  const path = runFileTarget(dir, run, name);
  if (!createNew(path, text)) throw new Error(`${path} exists; write the report under another name`);
  return path;
}
