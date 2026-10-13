// 층0 — 인용 검증. 작업이든 답변이든, 매 턴 환각을 기계적으로 확인한다.
//
// 배경: 기존 게이트는 전부 **편집이 있을 때만** 동작한다(Stop hook은 편집이 없으면
// 즉시 통과, 추론 게이트는 Edit/Write에만 걸림). 그래서 코드베이스에 대해 길게
// 설명하는 답변 턴은 완전히 무방비다 — 파일과 줄 번호를 대고 단정해도 아무것도
// 확인하지 않는다. 실제로 이 플러그인을 설계한 대화에서 수십 건의 `파일:줄` 주장이
// 아무 검증 없이 오갔다.
//
// 이 모듈은 LLM 없이 결정적으로 판정 가능한 것만 본다:
//   C1 인용한 파일이 실제로 존재하는가          → 위반 = 확정 환각
//   C2 인용한 줄 번호가 파일 길이 안인가         → 위반 = 확정 환각
//   C3 그 파일을 이 세션에서 실제로 읽었는가      → 위반 = 근거 미확인
//
// **`파일:줄` 형식만** 인용으로 본다. 백틱으로 감싼 경로(`package.json` 같은)는
// 단순 언급일 수 있어 제외한다 — 오탐을 만들면 게이트 자체가 꺼진다.

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

export interface Citation {
  /** 원문에 쓰인 그대로의 경로 */
  raw: string;
  /** cwd 기준 절대경로 */
  abs: string;
  /** First line referenced. */
  line: number;
  /** Highest line referenced when the citation is a range or a list (A8). */
  lastLine?: number;
  /** The line part as written, e.g. "10-20" or "14,51". */
  spec?: string;
  /** A bare file name that matched several repo files (or could not be resolved). */
  candidates?: string[];
}

export type CitationProblemKind = 'missing-file' | 'line-out-of-range' | 'unread' | 'ambiguous';

export interface CitationProblem {
  kind: CitationProblemKind;
  citation: Citation;
  detail: string;
}

/** 코드 파일로 보이는 확장자만 인용 대상으로 본다(버전 문자열 `v1.2:3` 등 오탐 방지).
 *
 *  경계 문자에 마크다운 강조(`*` `_`)를 포함한다 — 실측(P10)에서 모델이 인용을
 *  `**src/app.ts:3**` 로 굵게 써서 게이트가 통째로 놓쳤다. 강조는 인용을 **강조할 때**
 *  쓰는 표기라, 이걸 빼면 가장 단정적인 주장부터 빠져나간다. */
// Ranges and lists are recognized only without spaces (`a.ts:10-20`, `a.ts:14,51`):
// with spaces, prose such as "a.ts:5, 100 files" would read as a line list.
// A citation may end in `?`, `!`, `:` (a column, `a.ts:12:5`) or Hangul, as in "a.ts:42에서"
// (layer-1 test run: "Is the bug at src/nope.ts:42?" was not recognized, so the user's
// question was not excluded and the honest answer "there is no src/nope.ts:42" was
// blocked as a missing file).
const PATHY =
  /(?:^|[\s(`'"[*_])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][\w]{0,9}):(\d{1,6}(?:[-–]\d{1,6})?(?:,\d{1,6}(?:[-–]\d{1,6})?)*)(?=[\s)`'"\],.;:?!*_ㄱ-ㆎ가-힣]|$)/g;

/** Parses "12", "10-20", "14,51", "3-5, 9" (A8: ranges and lists used to slip through —
 *  `a.ts:10-20` was not recognized at all and `a.ts:14,51` was checked as line 14 only).
 *  Returns null for malformed specs such as reversed ranges. */
function parseLineSpec(spec: string): { first: number; last: number } | null {
  let first = Infinity;
  let last = 0;
  for (const part of spec.split(',')) {
    const [lo, hi] = part.split(/[-–]/).map((s) => Number(s.trim()));
    if (lo === undefined || !Number.isFinite(lo) || lo <= 0) return null;
    const end = hi !== undefined && Number.isFinite(hi) ? hi : lo;
    if (end < lo) return null;
    first = Math.min(first, lo);
    last = Math.max(last, end);
  }
  return Number.isFinite(first) ? { first, last } : null;
}

const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'target', '.next', '.venv', 'vendor']);
const SEARCH_ENTRY_BUDGET = 20_000;
// Deep enough for Java/Maven package trees: one directory past the limit marks the whole
// index incomplete (hallucination-axis review). Symlinks are not followed (a Dirent of a
// link is not a directory), so the entry and time budgets bound the walk, not this.
const SEARCH_DEPTH_LIMIT = 32;
// Wall-clock cap on the walk. The Stop hook has 15 s for every gate, and directory reads
// can be slow (performance review: 2–3.6 s per walk of a real ~/.gradle on a machine with a
// file-monitoring agent). A walk cut short is incomplete, so its bare names come out as
// "unresolvable" (cite the full path), never as hallucinations. The cap is checked before
// each directory is read, so one huge directory can overrun it by its own read time.
const SEARCH_TIME_BUDGET_MS = 300;

/** File-name index of the repo: one bounded walk shared by every bare-name citation
 *  (a walk per citation took ~10 s for 50 citations in a 25k-file repo).
 *  complete=false when the walk hit its entry, depth, or time limit; skippedDirs=true when
 *  a skipped directory (node_modules, dist, …) existed, where a file could still live. */
interface BasenameIndex {
  byName: Map<string, string[]>;
  complete: boolean;
  skippedDirs: boolean;
}

/** Keeps the file-name index between extractCitations calls. The Stop hook passes one
 *  cache for the answer and the user prompts it compares against, so the repo is walked
 *  at most once per Stop — each call used to walk on its own, up to four walks per Stop
 *  (performance review: 15.9–43.9 s on a directory-heavy tree). */
export interface CitationCache {
  root?: string;
  index?: BasenameIndex;
  /** Overrides SEARCH_TIME_BUDGET_MS (tests). */
  timeBudgetMs?: number;
}

function basenameIndexFor(root: string, cache: CitationCache): BasenameIndex {
  if (cache.index === undefined || cache.root !== root) {
    cache.index = buildBasenameIndex(root, cache.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS);
    cache.root = root;
  }
  return cache.index;
}

function buildBasenameIndex(root: string, timeBudgetMs: number): BasenameIndex {
  const byName = new Map<string, string[]>();
  const deadline = Date.now() + timeBudgetMs;
  let budget = SEARCH_ENTRY_BUDGET;
  let depthLimited = false;
  let timedOut = false;
  let skippedDirs = false;
  const walk = (dir: string, depth: number): void => {
    if (budget <= 0 || timedOut) return;
    if (depth > SEARCH_DEPTH_LIMIT) {
      depthLimited = true;
      return;
    }
    if (Date.now() > deadline) {
      timedOut = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget <= 0) return;
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name)) skippedDirs = true;
        else walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const list = byName.get(e.name);
        if (list) list.push(join(dir, e.name));
        else byName.set(e.name, [join(dir, e.name)]);
      }
    }
  };
  walk(root, 0);
  return { byName, complete: budget > 0 && !depthLimited && !timedOut, skippedDirs };
}

/**
 * 텍스트에서 `파일:줄` 인용을 뽑는다.
 *
 * - `hooks/stop.ts:673`, `` `lib/cli.ts:42` ``, `./src/a.ts:1` 모두 인식
 * - URL(`https://…:443`)은 스킴 뒤 `//` 때문에 경로 패턴과 맞지 않아 걸리지 않는다
 * - 절대경로는 cwd 밖일 수 있으므로 cwd 안의 것만 남긴다(게이트가 보는 범위)
 * - Pass the same `cache` to several calls to walk the repo for bare names only once.
 */
export function extractCitations(text: string, cwd: string, cache: CitationCache = {}): Citation[] {
  const out: Citation[] = [];
  if (typeof text !== 'string' || text === '') return out;
  const cwdAbs = (() => {
    try {
      return resolvePath(cwd);
    } catch {
      return '';
    }
  })();
  if (cwdAbs === '') return out;

  const seen = new Set<string>();
  PATHY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATHY.exec(text)) !== null) {
    const raw = m[1] ?? '';
    const spec = (m[2] ?? '').replace(/\s+/g, '');
    const lines = parseLineSpec(spec);
    if (raw === '' || lines === null) continue;
    let abs: string;
    try {
      abs = isAbsolute(raw) ? resolvePath(raw) : resolvePath(cwdAbs, raw);
    } catch {
      continue;
    }
    if (abs !== cwdAbs && !abs.startsWith(cwdAbs + sep)) continue;
    // A8: a bare file name ("stop.ts:916") resolves against the repo when it names exactly
    //   one file there. It used to be checked at the repo root and reported as "no such
    //   file" even when hooks/stop.ts existed.
    //   Only a definite answer is acted on: one match from a complete walk resolves, and
    //   "no such file" requires a complete walk that skipped nothing. Anything else (several
    //   matches, an incomplete walk, or a skipped node_modules/dist that could hold the file)
    //   is "unresolvable", which asks for the full path instead of claiming a hallucination.
    let candidates: string[] | undefined;
    if (!raw.includes('/') && !existsSync(abs)) {
      const index = basenameIndexFor(cwdAbs, cache); // built only when a bare name needs it
      const matches = index.byName.get(raw) ?? [];
      const definite = index.complete && !index.skippedDirs;
      if (matches.length === 1 && index.complete) abs = matches[0]!;
      else if (matches.length > 1 || !(matches.length === 0 && definite)) {
        candidates = matches.map((p) => relative(cwdAbs, p));
      }
    }
    const c: Citation = { raw, abs, line: lines.first };
    if (lines.last !== lines.first) c.lastLine = lines.last;
    if (spec !== String(lines.first)) c.spec = spec;
    if (candidates) c.candidates = candidates;
    const key = citationKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Identity of a citation: file plus the line spec as written (ranges and lists included). */
function citationKey(c: Citation): string {
  return `${c.abs}:${c.spec ?? c.line}`;
}

function citationLabel(c: Citation): string {
  return `${c.raw}:${c.spec ?? c.line}`;
}

/** 파일의 줄 수. 읽을 수 없으면 null. */
function lineCount(abs: string): number | null {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const content = readFileSync(abs, 'utf8');
    if (content === '') return 0;
    // 마지막 줄 개행은 줄 수를 늘리지 않는다.
    const n = content.split('\n').length;
    return content.endsWith('\n') ? n - 1 : n;
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  /** 그 파일을 이 세션에서 읽었는지 판정하는 콜백. 생략하면 C3를 건너뛴다. */
  wasRead?: (abs: string) => boolean;
  /** 읽기 기록 자체가 없으면 C3를 통째로 생략한다(압축 직후 오차단 방지). */
  readTrackingAvailable?: boolean;
}

/**
 * 인용을 검증한다.
 *
 * C2에는 관대한 여유를 둔다: 파일은 세션 중에 편집되어 줄 번호가 밀린다. 실제 줄 수를
 * **넘어서는** 경우만 위반으로 본다(줄 내용이 맞는지까지는 보지 않는다).
 */
export function verifyCitations(
  citations: Citation[],
  opts: VerifyOptions = {},
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  for (const c of citations) {
    const label = citationLabel(c);
    if (c.candidates !== undefined) {
      const shown = c.candidates.slice(0, 3);
      problems.push({
        kind: 'ambiguous',
        citation: c,
        detail:
          c.candidates.length > 1
            ? `${label} — ambiguous file name (${shown.join(', ')}${c.candidates.length > 3 ? ', …' : ''}); cite the repo-relative path.`
            : `${label} — could not resolve this file name; cite the repo-relative path.`,
      });
      continue;
    }
    const n = lineCount(c.abs);
    if (n === null) {
      problems.push({
        kind: 'missing-file',
        citation: c,
        detail: `${label} — no such file (paths are resolved from the repo root).`,
      });
      continue;
    }
    if ((c.lastLine ?? c.line) > n) {
      problems.push({
        kind: 'line-out-of-range',
        citation: c,
        detail: `${label} — the file has only ${n} lines.`,
      });
      continue;
    }
    if (opts.readTrackingAvailable === true && typeof opts.wasRead === 'function') {
      if (!opts.wasRead(c.abs)) {
        problems.push({
          kind: 'unread',
          citation: c,
          detail: `${label} — no record of reading this file in this session.`,
        });
      }
    }
  }
  return problems;
}

/**
 * 사용자가 먼저 쓴 인용을 모델의 주장에서 뺀다.
 *
 * 사용자가 `src/auth/session.ts:42` 처럼 존재하지 않는 위치를 프롬프트에 쓰고, 모델이
 * **"그런 파일이 없습니다"라고 정직하게 답하며 그 경로를 되풀이**하면, 그 인용은 모델의
 * 주장이 아니다. 그걸 환각으로 차단하면 정직한 답변을 벌하게 되고 — 실사용에서 사용자가
 * 오타나 추측 경로를 대고 묻는 일은 흔하다 — 게이트 신뢰도가 바로 무너진다.
 */
export function excludeUserOriginated(
  citations: Citation[],
  userTexts: string[],
  cwd: string,
  cache: CitationCache = {},
): Citation[] {
  if (citations.length === 0 || !Array.isArray(userTexts) || userTexts.length === 0) return citations;
  const fromUser = new Set<string>();
  for (const t of userTexts) {
    for (const c of extractCitations(t, cwd, cache)) fromUser.add(citationKey(c));
  }
  if (fromUser.size === 0) return citations;
  return citations.filter((c) => !fromUser.has(citationKey(c)));
}

/** 확정 환각(파일 없음/줄 범위 밖)만 추린다. */
export function hallucinatedCitations(problems: CitationProblem[]): CitationProblem[] {
  return problems.filter((p) => p.kind === 'missing-file' || p.kind === 'line-out-of-range');
}

/** 근거 미확인(읽은 기록 없음)만 추린다. Ambiguous names are unverifiable too, not hallucinations. */
export function unreadCitations(problems: CitationProblem[]): CitationProblem[] {
  return problems.filter((p) => p.kind === 'unread' || p.kind === 'ambiguous');
}

function problemList(problems: CitationProblem[]): string {
  const list = problems
    .slice(0, 5)
    .map((p) => `  - ${p.detail}`)
    .join('\n');
  return list + (problems.length > 5 ? `\n  … and ${problems.length - 5} more` : '');
}

export function citationBlockMessage(problems: CitationProblem[]): string {
  return (
    `The answer cites locations that do not exist:\n${problemList(problems)}\n` +
    'Read the file to check, then correct the citation. If there is no evidence, move the claim ' +
    'under `## 근거 > 추측` and answer again. (layer-0 citation check)'
  );
}

export function unreadBlockMessage(problems: CitationProblem[], escalate: boolean): string {
  const tail = escalate
    ? 'This keeps recurring — run the review-changes subagent with `축: hallucination` to verify ' +
      'the cited claims and record the result.'
    : 'Read each cited file (Read, or cat/sed -n) and cite it by its repo-relative path, then answer ' +
      'again. Claims you did not verify go under `## 근거 > 추측`.';
  return `Cited locations could not be verified in this session:\n${problemList(problems)}\n${tail} (layer-0 citation check)`;
}
