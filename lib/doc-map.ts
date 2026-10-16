// The docs rule (track H §14.5). At Stop, in a project: a file the doc map says a doc covers
// changed in the task while the doc did not, so the doc may be stale; the rule names it. It
// passes when the doc changed in the task, or when `.goodboy/docs.json` records a check of the
// doc (`checked`, a UTC time) made at or after the change, written by a doc map edit of this
// task (a time later than that edit passes nothing). The generated test catalog is checked by
// regenerating it instead. Changes the map cannot see go to review. Also here: the CLAUDE.md
// notices SessionStart shows the user (an /init suggestion once per project, a size budget).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { DOC_MAP_FILE, type DocEntry } from './project-knowledge';
import { catalogIsCurrent, TEST_CATALOG_FILE } from './test-catalog';
import { canonicalTimestamp } from './trusted-time';

export interface StaleDoc {
  /** The doc, relative to the root (`/` separators). */
  doc: string;
  /** The covered files that changed, relative to the root. */
  changed: string[];
}

const posix = (p: string) => p.split(sep).join('/');

export function staleDocs(args: { root: string; edits: Array<{ file: string; lastEditTimestamp: string }>; docs: DocEntry[] }): StaleDoc[] {
  const root = resolvePath(args.root);
  const inRoot = (abs: string): string | null => {
    const r = relative(root, resolvePath(root, abs));
    return r === '' || r.startsWith('..') || isAbsolute(r) ? null : posix(r);
  };
  const edits = args.edits
    .map((e) => ({ rel: inRoot(e.file), at: Date.parse(e.lastEditTimestamp) }))
    .filter((e): e is { rel: string; at: number } => e.rel !== null && Number.isFinite(e.at));
  // Docs are not code: editing the map or another mapped doc makes no doc stale.
  const mapped = new Set<string>([posix(DOC_MAP_FILE)]);
  for (const d of args.docs) {
    const r = inRoot(d.path);
    if (r !== null) mapped.add(r);
  }
  const mapEdit = edits.find((e) => e.rel === posix(DOC_MAP_FILE))?.at ?? null;
  const out: StaleDoc[] = [];
  for (const d of args.docs) {
    const doc = inRoot(d.path);
    if (doc === null || d.covers.length === 0) continue;
    const globs = d.covers.map((c) => new Bun.Glob(c));
    const changed = edits.filter((e) => !mapped.has(e.rel) && globs.some((g) => g.match(e.rel)));
    if (changed.length === 0) continue;
    if (doc === posix(TEST_CATALOG_FILE)) {
      if (catalogIsCurrent(root)) continue; // generated: current is the evidence
    } else {
      if (edits.some((e) => e.rel === doc)) continue;
      // `date -u` writes whole seconds, so the change counts from the start of its second. The
      //   edit record is stamped after the write, so a true check is never later than it; no
      //   skew, or a time written a little ahead would pass (H4 review).
      const since = Math.floor(Math.max(...changed.map((e) => e.at)) / 1000) * 1000;
      const iso = canonicalTimestamp(d.checked);
      const checked = iso === null ? NaN : Date.parse(iso);
      if (Number.isFinite(checked) && mapEdit !== null && checked >= since && checked <= mapEdit) continue;
    }
    out.push({ doc, changed: [...new Set(changed.map((e) => e.rel))].sort() });
  }
  return out;
}

/** The model-facing block reason for stale docs. */
export function staleDocsReason(stale: StaleDoc[], cliPath: string): string {
  const list = stale
    .map((s) => `${s.doc} (covers ${s.changed.slice(0, 5).join(', ')}${s.changed.length > 5 ? ` and ${s.changed.length - 5} more` : ''})`)
    .join('; ');
  const catalog = stale.some((s) => s.doc === posix(TEST_CATALOG_FILE));
  return (
    `Docs this change may have made stale: ${list}. Update each doc to match the change; if one is still right, ` +
    `record the check: set its "checked" in ${posix(DOC_MAP_FILE)} to the current UTC time (\`date -u +%Y-%m-%dT%H:%M:%SZ\`). ` +
    (catalog ? `Regenerate the test catalog with \`bun "${cliPath}" test-catalog\`. ` : '') +
    'The keep-project-knowledge update mode does this. (docs rule)'
  );
}

export const CLAUDE_MD_LINE_BUDGET = 300;

function logDir(env: Record<string, string | undefined>): string {
  const d = (env.GOODBOY_LOG_DIR ?? '').trim();
  return d !== '' ? d : join(homedir(), '.claude', 'goodboy', 'logs');
}

/** Roots already given the /init suggestion (machine-local, `~/.claude/goodboy/logs`). */
function initSuggested(env: Record<string, string | undefined>): string[] {
  try {
    const v = JSON.parse(readFileSync(join(logDir(env), 'init-suggested.json'), 'utf8')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function noteInitSuggested(root: string, env: Record<string, string | undefined>): void {
  try {
    const dir = logDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'init-suggested.json'), JSON.stringify([...initSuggested(env), root].slice(-500)));
  } catch {
    // best-effort: without the note the suggestion comes again next session
  }
}

/** Larger than this is over the budget without counting (a session reads all of it). */
const MAX_COUNTED_BYTES = 1024 * 1024;

function lines(file: string): number {
  if (statSync(file).size > MAX_COUNTED_BYTES) return Number.POSITIVE_INFINITY;
  const text = readFileSync(file, 'utf8');
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

const isFile = (f: string) => {
  try {
    return existsSync(f) && statSync(f).isFile();
  } catch {
    return false;
  }
};

/** Whether a session in `cwd` gets any project CLAUDE.md: one in the cwd or a directory above
 *  it, or `.claude/CLAUDE.md` from the cwd up to the root (the user's ~/.claude one is not a
 *  project's). */
function hasClaudeMd(root: string, cwd: string): boolean {
  const home = resolvePath(homedir());
  let inProject = true;
  for (let d = resolvePath(cwd); ; d = resolvePath(d, '..')) {
    if (isFile(join(d, 'CLAUDE.md'))) return true;
    if (inProject && d !== home && isFile(join(d, '.claude', 'CLAUDE.md'))) return true;
    if (d === resolvePath(root)) inProject = false;
    if (resolvePath(d, '..') === d) return false;
  }
}

/** The user-facing (Korean) CLAUDE.md notice for a project session, or null: an /init
 *  suggestion once per project when the session gets none (new sessions only), and a warning
 *  when the project's own one is over the budget (new and resumed sessions). */
export function claudeMdNotice(root: string, source: string, env: Record<string, string | undefined> = process.env, cwd: string = root): string | null {
  const files = ['CLAUDE.md', join('.claude', 'CLAUDE.md')].map((f) => join(root, f)).filter(isFile);
  if (files.length === 0) {
    if (source !== 'startup' || hasClaudeMd(root, cwd) || initSuggested(env).includes(root)) return null;
    noteInitSuggested(root, env);
    return '[goodboy] 이 프로젝트에는 CLAUDE.md가 없어요. `/init`으로 만들어 두면 세션마다 프로젝트 규칙이 전달돼요. (한 번만 안내해요)';
  }
  if (source !== 'startup' && source !== 'resume') return null;
  const over: string[] = [];
  for (const f of files) {
    try {
      const n = lines(f);
      if (n > CLAUDE_MD_LINE_BUDGET) over.push(`${posix(relative(root, f))} ${Number.isFinite(n) ? `${n}줄` : '1MB 넘음'}`);
    } catch {
      // unreadable: nothing to measure
    }
  }
  if (over.length === 0) return null;
  return `[goodboy] ${over.join(', ')}: CLAUDE.md 예산(${CLAUDE_MD_LINE_BUDGET}줄)을 넘어요. 세션마다 읽히니 자세한 내용은 docs/로 옮기고 규칙만 남기면 비용이 줄어요.`;
}
