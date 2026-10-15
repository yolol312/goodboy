// Project knowledge (track H §14.3): `.goodboy/policy.md` (the project's policies and past
// decisions, each tagged `decide: ai|human`) and `.goodboy/docs.json` (the doc map), both
// git-managed. SessionStart names the files a session must read first; until each has a full
// Read in this session, the main session's other tools are denied (the read gate). Subagents
// are exempt: the main session passes them the policy they need. Non-project directories
// (lib/project-mode.ts) have no gate. The skill `keep-project-knowledge` writes both files.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { lastKnownVersion, readRangesSince } from './file-tracker';
import { projectMode } from './project-mode';

export const POLICY_FILE = join('.goodboy', 'policy.md');
export const DOC_MAP_FILE = join('.goodboy', 'docs.json');
export const KNOWLEDGE_SKILL = 'keep-project-knowledge';
/** policy.md is read every session, so it has a budget (lines). */
export const POLICY_LINE_BUDGET = 200;
const MAX_KNOWLEDGE_BYTES = 256 * 1024;
/** Tools the read gate always allows, so it cannot deadlock. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(['Read', 'AskUserQuestion', 'ToolSearch']);

export interface DocEntry {
  path: string;
  session_start: boolean;
  covers: string[];
}

/** The directory whose `.goodboy/` the session uses: the nearest one with policy.md from cwd
 *  up (a sub-repo uses its parent's), else the nearest git top-level, else cwd. */
export function knowledgeRoot(cwd: string): { root: string; policyExists: boolean } {
  let gitTop: string | null = null;
  for (let d = resolvePath(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, POLICY_FILE))) return { root: d, policyExists: true };
    if (gitTop === null && existsSync(join(d, '.git'))) gitTop = d;
    if (dirname(d) === d) break;
  }
  return { root: gitTop ?? resolvePath(cwd), policyExists: false };
}

/** The doc map's entries; a missing map is empty, an unreadable or invalid one says why. */
export function readDocMap(root: string): { docs: DocEntry[]; problem?: string } {
  const p = join(root, DOC_MAP_FILE);
  if (!existsSync(p)) return { docs: [] };
  try {
    if (statSync(p).size > MAX_KNOWLEDGE_BYTES) return { docs: [], problem: `${DOC_MAP_FILE} is over ${MAX_KNOWLEDGE_BYTES} bytes` };
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { docs?: unknown };
    if (!Array.isArray(parsed.docs)) return { docs: [], problem: `${DOC_MAP_FILE} has no "docs" list` };
    const docs: DocEntry[] = [];
    for (const d of parsed.docs as Record<string, unknown>[]) {
      if (!d || typeof d.path !== 'string' || d.path.trim() === '') continue;
      docs.push({
        path: d.path,
        session_start: d.session_start === true,
        covers: Array.isArray(d.covers) ? d.covers.filter((c): c is string => typeof c === 'string') : [],
      });
    }
    return { docs };
  } catch (err) {
    return { docs: [], problem: `${DOC_MAP_FILE} cannot be read: ${String(err).slice(0, 80)}` };
  }
}

/** A file the Read tool can show in full and the read log can record: a readable regular
 *  text file of reasonable size. Anything else (a directory, a binary or PDF, no permission)
 *  would hold the gate shut for good (H2 review), so it is left out and warned about. */
function readableText(abs: string): boolean {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_KNOWLEDGE_BYTES) return false;
    const head = readFileSync(abs).subarray(0, 8192);
    return !head.includes(0) && !/\.(?:pdf|ipynb|png|jpe?g|gif|webp)$/i.test(abs);
  } catch {
    return false;
  }
}

/** Session-start files the gate cannot ask for (see readableText), for the notice. */
export function unreadableKnowledgeFiles(root: string): string[] {
  return candidateKnowledgeFiles(root).filter((f) => !readableText(f));
}

function candidateKnowledgeFiles(root: string): string[] {
  const out: string[] = [];
  if (existsSync(join(root, POLICY_FILE))) out.push(join(root, POLICY_FILE));
  for (const d of readDocMap(root).docs) {
    if (!d.session_start) continue;
    const abs = resolvePath(root, d.path);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) continue; // only the project's own files
    if (existsSync(abs) && !out.includes(abs)) out.push(abs);
  }
  return out;
}

/** The files a session reads first: policy.md and the doc map's session-start docs that
 *  exist inside the root and can be read as text (absolute paths). */
export function requiredKnowledgeFiles(root: string): string[] {
  return candidateKnowledgeFiles(root).filter(readableText);
}

export function isRequiredKnowledgeFile(cwd: string, absPath: string): boolean {
  return requiredKnowledgeFiles(knowledgeRoot(cwd).root).includes(resolvePath(absPath));
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** True when the main session has the file's current content: its newest read or own edit
 *  (after the last compaction) is of the file as it is now, and the reads of that version
 *  cover it — one full Read, or partial reads whose line ranges cover every line. */
export function knowsCurrentContent(sessionId: string, file: string, turn: number): boolean {
  let st;
  try {
    st = statSync(file);
  } catch {
    return true; // gone: nothing to read
  }
  const known = lastKnownVersion(sessionId, file, turn, Number.MAX_SAFE_INTEGER, 'main');
  if (known === null) return false;
  if (known.mtime !== null && Math.abs(known.mtime - st.mtimeMs) > 1) return false; // changed since
  if (known.via === 'edit') return true; // the session wrote what is there
  const reads = readRangesSince(sessionId, file, st.mtimeMs, 'main');
  if (reads.full) return true;
  let lines: number;
  try {
    lines = lineCount(readFileSync(file, 'utf8'));
  } catch {
    return true; // unreadable: fail open (the notice warns)
  }
  const covered = new Array<boolean>(lines + 1).fill(false);
  for (const [a, b] of reads.ranges) for (let n = Math.max(1, a); n <= Math.min(lines, b); n++) covered[n] = true;
  for (let n = 1; n <= lines; n++) if (!covered[n]) return false;
  return true;
}

/** Why this main-session tool call waits for the required reads, or null. */
export function policyReadDenial(args: {
  sessionId: string;
  cwd: string;
  turn: number;
  toolName: string;
  toolInput: Record<string, unknown>;
  agentType?: string;
}): string | null {
  if ((process.env.GOODBOY_POLICY_GATE ?? 'on').trim().toLowerCase() === 'off') return null;
  if (args.agentType) return null; // subagents: the main session passes them the policy
  if (ALWAYS_ALLOWED.has(args.toolName)) return null;
  if (args.toolName === 'Skill' && String(args.toolInput.skill ?? '').replace(/^goodboy:/, '') === KNOWLEDGE_SKILL) return null;
  if (projectMode(args.cwd, args.sessionId) === 'non-project') return null;
  const { root } = knowledgeRoot(args.cwd);
  const unread = requiredKnowledgeFiles(root).filter((f) => !knowsCurrentContent(args.sessionId, f, args.turn));
  if (unread.length === 0) return null;
  const list = unread.map((f) => relative(args.cwd, f) || f).join(', ');
  return (
    `Read the project's knowledge files first: ${list}. They hold its policies and past decisions; ` +
    'read each in full (Read, partial reads that together cover the file count), then go on. ' +
    `Read, AskUserQuestion, ToolSearch and the ${KNOWLEDGE_SKILL} skill stay allowed. (policy read gate)`
  );
}

/** What SessionStart tells the session (project mode): the files to read first, or that
 *  policy.md is missing; and size warnings. `systemMessage` is Korean (the user reads it). */
export function knowledgeSessionNotice(cwd: string, sessionId: string): { context?: string; systemMessage?: string } {
  if (projectMode(cwd, sessionId) === 'non-project') return {};
  const { root, policyExists } = knowledgeRoot(cwd);
  if (!policyExists) {
    return {
      context:
        `This project has no ${POLICY_FILE} yet. Before the first task, run the goodboy:${KNOWLEDGE_SKILL} skill in create mode: ` +
        'it asks once whether this directory is a project, then drafts the policy file and the doc map. (project knowledge)',
      systemMessage: `[goodboy] 이 프로젝트에는 정책 파일(${POLICY_FILE})이 없어요. 첫 작업 전에 만들고, 프로젝트가 맞는지 한 번 여쭤볼게요.`,
    };
  }
  const files = requiredKnowledgeFiles(root).map((f) => relative(cwd, f) || f);
  const notes: string[] = [`Read these project knowledge files in full before anything else: ${files.join(', ')}. (policy read gate)`];
  try {
    const n = lineCount(readFileSync(join(root, POLICY_FILE), 'utf8'));
    if (n > POLICY_LINE_BUDGET) notes.push(`${POLICY_FILE} has ${n} lines, over its budget of ${POLICY_LINE_BUDGET}: tighten it in the skill's update mode.`);
  } catch {
    notes.push(`${POLICY_FILE} cannot be read; the read gate lets the session go on.`);
  }
  const map = readDocMap(root);
  if (map.problem) notes.push(`Doc map problem: ${map.problem}.`);
  const skipped = unreadableKnowledgeFiles(root).map((f) => relative(cwd, f) || f);
  if (skipped.length > 0) notes.push(`Not required (not readable as text): ${skipped.join(', ')}; fix them in ${DOC_MAP_FILE}.`);
  return { context: notes.join('\n') };
}

/** The skill's done criteria, checkable: the files exist, every policy entry has its
 *  `decide`, `source`, `date` and `checked` lines, and docs.json marks policy.md
 *  session-start. Problems, or [] when done. */
export function validateKnowledge(root: string): string[] {
  const problems: string[] = [];
  const policy = join(root, POLICY_FILE);
  if (!existsSync(policy)) return [`${POLICY_FILE} is missing`];
  const text = readFileSync(policy, 'utf8');
  const sections = text.split(/^## /m).slice(1);
  if (sections.length === 0) problems.push(`${POLICY_FILE} has no entries (## <id> <title>)`);
  for (const s of sections) {
    const title = s.split('\n')[0]!.trim();
    // `[ \t]*`, not `\s*`: an empty `- source:` line must not borrow the next line's text.
    for (const field of ['decide', 'source', 'date', 'checked']) {
      if (!new RegExp(`^- ${field}:[ \\t]*\\S`, 'm').test(s)) problems.push(`entry "${title}" has no ${field}: line`);
    }
    const decide = s.match(/^- decide:[ \t]*(\S+)/m)?.[1];
    if (decide && decide !== 'ai' && decide !== 'human') problems.push(`entry "${title}" has decide: ${decide} (ai or human)`);
    if (decide === 'ai' && !/^- evidence:[ \t]*\S/m.test(s)) problems.push(`entry "${title}" is ai but names no evidence: line`);
  }
  if (lineCount(text) > POLICY_LINE_BUDGET) problems.push(`${POLICY_FILE} is over ${POLICY_LINE_BUDGET} lines`);
  const map = readDocMap(root);
  if (map.problem) problems.push(map.problem);
  if (!map.docs.some((d) => resolvePath(root, d.path) === policy && d.session_start)) {
    problems.push(`${DOC_MAP_FILE} does not list ${POLICY_FILE} with "session_start": true`);
  }
  return problems;
}
