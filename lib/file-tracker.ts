// Read-before-edit 검증을 위한 파일 Read 기록.
//
// 상태 저장 형식 (sessionDir 안):
//   reads.jsonl  — 각 줄: { file: string, turn: number, timestamp: string }
//   edits.jsonl  — 같은 형식
//   turn.txt     — 현재 턴 번호 (정수)

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface TrackRecord {
  file: string;
  turn: number;
  timestamp: string;
  /** H2-01: Read 시점의 파일 수정시각(mtimeMs). 없을 수 있음(하위호환).
   *  On an edit record: the file's mtime right after the edit (read-before-edit, track G). */
  mtime?: number;
  /** D2: 이 기록을 남긴 에이전트의 agent_id. 없으면 메인 에이전트('main' 스코프)로 취급.
   *  재-Read 게이트가 에이전트별로 공정하게 판정하기 위한 스코프 키(구버전 라인 하위호환). */
  agent?: string;
  /** A7: the read showed only part of the file (offset/limit/pages, head, tail, sed -n).
   *  A later full read of such a file is not a redundant re-read. Absent = full read. */
  partial?: boolean;
  /** A partial Read's first and last line (track H: partial reads that together cover a file
   *  count as a full read for the policy read gate). Absent when unknown. */
  range?: [number, number];
}

/** 기록의 스코프 키. agent 필드 없는 구버전/메인 기록은 'main'. */
const MAIN_SCOPE = 'main';

function recordScope(r: TrackRecord): string {
  return r.agent ?? MAIN_SCOPE;
}

export function sessionDir(sessionId: string): string {
  // sessionId에 path traversal 위험 문자가 있을 수 있으니 소독
  const safe = (sessionId ?? 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_');
  return join(tmpdir(), `goodboy-session-${safe}`);
}

/** True for a path inside any goodboy session state dir (`$TMPDIR/goodboy-session-*`), also
 *  through the real path of $TMPDIR (`/var` is `/private/var` on macOS). */
export function inGoodboySessionDir(absPath: string): boolean {
  const roots = new Set([tmpdir()]);
  try {
    roots.add(realpathSync(tmpdir()));
  } catch {
    // no real path
  }
  // Follow symlinks by hand, so a dangling one (its target not made yet) is judged by where it
  //   points (H1 review round 2: a link to the not-yet-written evidence log passed).
  let linked = absPath;
  for (let hop = 0; hop < 8; hop++) {
    try {
      if (!lstatSync(linked).isSymbolicLink()) break;
      linked = resolve(dirname(linked), readlinkSync(linked));
    } catch {
      break;
    }
  }
  let target = linked;
  try {
    target = realpathSync(linked);
  } catch {
    try {
      target = realpathSync(dirname(linked)) + sep + basename(linked);
    } catch {
      // the dir does not exist yet: compare the spelled path
    }
  }
  for (const root of roots) {
    for (const p of [absPath, linked, target]) {
      const rel = relative(root, p);
      if (!rel.startsWith('..') && !isAbsolute(rel) && /^goodboy-session-[^/\\]*(?:[/\\]|$)/.test(rel)) return true;
    }
  }
  return false;
}

/** 세션별 상태 디렉터리 보장. /tmp/goodboy-session-<sessionId>/ */
export function ensureSessionDir(sessionId: string): string {
  const dir = sessionDir(sessionId);
  try {
    // mode 0700: 세션 상태 파일(편집 중 파일 경로 등)이 같은 호스트의 다른 로컬 사용자에게
    //   노출되지 않도록 소유자 전용 권한으로 생성한다(4-1). 이미 존재하면 권한은 유지된다.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }
  return dir;
}

function normalize(filePath: string): string {
  try {
    return resolve(filePath);
  } catch {
    return filePath;
  }
}

function appendRecord(dir: string, fileName: string, record: TrackRecord): void {
  try {
    const path = join(dir, fileName);
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

function readRecords(dir: string, fileName: string): TrackRecord[] {
  try {
    const path = join(dir, fileName);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const out: TrackRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<TrackRecord>;
        if (
          parsed &&
          typeof parsed.file === 'string' &&
          typeof parsed.turn === 'number' &&
          typeof parsed.timestamp === 'string'
        ) {
          const rec: TrackRecord = {
            file: parsed.file,
            turn: parsed.turn,
            timestamp: parsed.timestamp,
          };
          // H2-01: mtime은 있을 때만 보존(구버전 라인은 mtime 없이 무시하고 계속 동작).
          if (typeof parsed.mtime === 'number') rec.mtime = parsed.mtime;
          // D2: agent도 있을 때만 보존(없으면 메인 스코프로 취급).
          if (typeof parsed.agent === 'string' && parsed.agent !== '') rec.agent = parsed.agent;
          if (parsed.partial === true) rec.partial = true;
          const range = parsed.range;
          if (Array.isArray(range) && range.length === 2 && range.every((n) => Number.isInteger(n) && n > 0)) rec.range = [range[0]!, range[1]!];
          out.push(rec);
        }
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** A Read tool call that shows only part of the file (A7). Shared by PostToolUse (record)
 *  and the PreToolUse re-Read exemption so the two cannot drift — the A7 bug was this
 *  predicate missing `pages` in one of them. */
export function isPartialRead(toolInput: Record<string, unknown>): boolean {
  return toolInput.offset !== undefined || toolInput.limit !== undefined || toolInput.pages !== undefined;
}

/** Read 도구 호출 시 기록. PostToolUse hook이 호출.
 *  H2-01: mtime(파일 수정시각 mtimeMs)을 함께 기록하면 재-Read 게이트가
 *  "그 사이 파일이 바뀌었는지"를 판정할 수 있다. mtime 미지정도 허용(하위호환).
 *  D2: agent(agent_id)를 기록하면 재-Read 게이트가 에이전트별로 스코프해 판정한다. */
export function recordRead(
  sessionId: string,
  filePath: string,
  turn: number,
  mtime?: number,
  agent?: string,
  partial?: boolean,
  range?: [number, number],
): void {
  const dir = ensureSessionDir(sessionId);
  const record: TrackRecord = {
    file: normalize(filePath),
    turn,
    timestamp: new Date().toISOString(),
  };
  if (typeof mtime === 'number' && Number.isFinite(mtime)) record.mtime = mtime;
  if (typeof agent === 'string' && agent !== '') record.agent = agent;
  if (partial === true) record.partial = true;
  if (partial === true && range && range.every((n) => Number.isInteger(n) && n > 0)) record.range = range;
  appendRecord(dir, 'reads.jsonl', record);
}

/** What a Read call showed, from its result when it says (`file: {startLine, numLines,
 *  totalLines}`): a Read without offset/limit shows at most the first 2000 lines, so a longer
 *  file read that way is partial (H2 review). Without those fields, from the input. */
export function readShownRange(toolInput: Record<string, unknown>, toolResponse: unknown): { partial: boolean; range?: [number, number] } {
  const f = (toolResponse as { file?: { startLine?: unknown; numLines?: unknown; totalLines?: unknown } } | null)?.file;
  const start = Number(f?.startLine);
  const num = Number(f?.numLines);
  const total = Number(f?.totalLines);
  if (Number.isInteger(start) && Number.isInteger(num) && Number.isInteger(total) && start >= 1 && num >= 0) {
    if (start === 1 && num >= total) return { partial: false };
    return num > 0 ? { partial: true, range: [start, start + num - 1] } : { partial: true };
  }
  const range = readRangeOf(toolInput);
  return isPartialRead(toolInput) ? (range ? { partial: true, range } : { partial: true }) : { partial: false };
}

/** The line range a Read call shows: from `offset` (1-based) for `limit` lines (2000 when
 *  unset, the Read tool's default), or null for a full read or a PDF page range. */
export function readRangeOf(toolInput: Record<string, unknown>): [number, number] | null {
  if (toolInput.offset === undefined && toolInput.limit === undefined) return null;
  if (toolInput.pages !== undefined) return null;
  const start = Math.max(1, Math.floor(Number(toolInput.offset ?? 1)) || 1);
  const limit = Math.max(1, Math.floor(Number(toolInput.limit ?? 2000)) || 2000);
  return [start, start + limit - 1];
}

/** The main-scope (or `agent`) reads of a file's version with mtime `mtime`, after the last
 *  compaction: whether one was full, and the line ranges of the partial ones. */
export function readRangesSince(sessionId: string, filePath: string, mtime: number, agent = MAIN_SCOPE): { full: boolean; ranges: [number, number][] } {
  const dir = ensureSessionDir(sessionId);
  const target = normalize(filePath);
  const epoch = knowledgeEpoch(dir);
  let full = false;
  const ranges: [number, number][] = [];
  for (const r of readRecords(dir, 'reads.jsonl')) {
    if (r.file !== target || recordScope(r) !== agent) continue;
    if (epoch !== '' && r.timestamp <= epoch) continue;
    if (typeof r.mtime !== 'number' || Math.abs(r.mtime - mtime) > 1) continue;
    if (!r.partial) full = true;
    else if (r.range) ranges.push(r.range);
  }
  return { full, ranges };
}

/** filePath가 최근 withinTurns 안에 Read 됐는지 확인.
 *  agent 지정 시 그 에이전트 스코프의 기록만 본다(미지정 = 스코프 무시, 전체 매칭).
 *  fullOnly: ignore partial reads (A7) — the re-Read gate must not treat "saw lines 1–20"
 *  as "already has the whole file"; read-before-edit keeps accepting partial reads. */
export function wasFileReadRecently(
  sessionId: string,
  filePath: string,
  currentTurn: number,
  withinTurns: number,
  agent?: string,
  fullOnly?: boolean,
): boolean {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'reads.jsonl');
  const target = normalize(filePath);
  const cutoff = currentTurn - withinTurns;
  for (const r of records) {
    if (agent !== undefined && recordScope(r) !== agent) continue;
    if (fullOnly === true && r.partial === true) continue;
    if (r.file === target && r.turn >= cutoff && r.turn <= currentTurn) {
      return true;
    }
  }
  return false;
}

/** H2-01: filePath를 최근 withinTurns 안에 Read한 기록 중 가장 최근(높은 turn)의 mtime.
 *  기록이 없거나 mtime이 없으면 null. 재-Read 게이트가 "그 사이 파일 변경 여부"를
 *  판정하는 데 사용한다(mtime을 모르면 null → 게이트는 fail-open으로 허용). */
export function getRecentReadMtime(
  sessionId: string,
  filePath: string,
  currentTurn: number,
  withinTurns: number,
  agent?: string,
  fullOnly?: boolean,
): number | null {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'reads.jsonl');
  const target = normalize(filePath);
  const cutoff = currentTurn - withinTurns;
  let best: number | null = null;
  let bestTurn = -Infinity;
  for (const r of records) {
    if (agent !== undefined && recordScope(r) !== agent) continue;
    if (fullOnly === true && r.partial === true) continue;
    if (
      r.file === target &&
      r.turn >= cutoff &&
      r.turn <= currentTurn &&
      typeof r.mtime === 'number'
    ) {
      if (r.turn >= bestTurn) {
        bestTurn = r.turn;
        best = r.mtime;
      }
    }
  }
  return best;
}

/** filePath가 최근 withinTurns 안에 Edit/Write 됐는지 확인.
 *  FRICTION #4: 세션 내에서 Write/생성한 파일은 이미 내용을 알고 있으므로
 *  read-before-edit를 만족시켜야 한다. wasFileReadRecently를 그대로 미러링. */
export function wasFileEditedRecently(
  sessionId: string,
  filePath: string,
  currentTurn: number,
  withinTurns: number,
  agent?: string,
): boolean {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  const target = normalize(filePath);
  const cutoff = currentTurn - withinTurns;
  for (const r of records) {
    if (agent !== undefined && recordScope(r) !== agent) continue;
    if (r.file === target && r.turn >= cutoff && r.turn <= currentTurn) {
      return true;
    }
  }
  return false;
}

/** 현재 턴 번호 조회. 없으면 0. */
export function getCurrentTurn(sessionId: string): number {
  try {
    const dir = ensureSessionDir(sessionId);
    const path = join(dir, 'turn.txt');
    if (!existsSync(path)) return 0;
    const raw = readFileSync(path, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Stop hook에서 호출, 턴 카운터 증가 */
export function incrementTurn(sessionId: string): number {
  try {
    const dir = ensureSessionDir(sessionId);
    const current = getCurrentTurn(sessionId);
    const next = current + 1;
    writeFileSync(join(dir, 'turn.txt'), String(next), 'utf8');
    return next;
  } catch {
    return getCurrentTurn(sessionId);
  }
}

/** H2-01 epoch 리셋: 세션의 read 기록 전체 삭제(컨텍스트 압축 감지 시).
 *  압축 후에는 앞서 읽은 내용이 모델 컨텍스트에 없으므로, 재-Read 차단의 전제
 *  ("앞서 읽은 내용을 참조할 수 있다")가 깨진다 → 기록을 비워 압축 이후를 새 기준으로 한다.
 *  (v0.27.9, 리뷰 지적) webfetch.jsonl(H2-04 재페치 기록)도 같은 전제를 공유하므로 함께
 *  비운다 — 남겨두면 압축 후 존재하지 않는 "앞선 결과 참조" 경고가 나온다.
 *  ⚠️ edits.jsonl은 지우지 않는다 — 리뷰 커서/검증 스코프가 의존한다. */
export function clearReadRecords(sessionId: string): void {
  for (const name of ['reads.jsonl', 'webfetch.jsonl']) {
    try {
      const path = join(ensureSessionDir(sessionId), name);
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort
    }
  }
  // Edits stay for review, but what the model knew from its own edits left the context too:
  //   read-before-edit counts only edits after this point (lastKnownVersion).
  try {
    writeFileSync(join(ensureSessionDir(sessionId), KNOWLEDGE_EPOCH_FILE), new Date().toISOString(), 'utf8');
  } catch {
    // best-effort
  }
}

const KNOWLEDGE_EPOCH_FILE = 'knowledge-epoch.txt';

function knowledgeEpoch(dir: string): string {
  try {
    return readFileSync(join(dir, KNOWLEDGE_EPOCH_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

/** What read-before-edit knows of a file: the newest read or own edit within the window, in
 *  the given scope (agent_id, 'main', or undefined for any), after the last compaction.
 *  `mtime` is the file's mtime at that read or right after that edit (null when unknown, for
 *  old records). null = not read or edited recently. */
export function lastKnownVersion(
  sessionId: string,
  filePath: string,
  currentTurn: number,
  withinTurns: number,
  agent?: string,
): { via: 'read' | 'edit'; mtime: number | null } | null {
  const dir = ensureSessionDir(sessionId);
  const target = normalize(filePath);
  const cutoff = currentTurn - withinTurns;
  const epoch = knowledgeEpoch(dir);
  let best: { via: 'read' | 'edit'; mtime: number | null; at: string } | null = null;
  for (const via of ['read', 'edit'] as const) {
    for (const r of readRecords(dir, via === 'read' ? 'reads.jsonl' : 'edits.jsonl')) {
      if (r.file !== target || r.turn < cutoff || r.turn > currentTurn) continue;
      if (agent !== undefined && recordScope(r) !== agent) continue;
      if (epoch !== '' && r.timestamp <= epoch) continue;
      if (best === null || r.timestamp >= best.at) best = { via, mtime: r.mtime ?? null, at: r.timestamp };
    }
  }
  return best === null ? null : { via: best.via, mtime: best.mtime };
}

/** 이 세션에 읽기 기록이 하나라도 있는가.
 *
 *  층0 인용 검증의 fail-open 조건이다. 압축(compact) 직후에는 clearReadRecords가
 *  기록을 비우므로, 정직하게 읽고 인용한 턴도 "읽은 적 없음"이 된다. 기록이 통째로
 *  비어 있으면 판정 자체를 생략해 그 오차단을 막는다. */
export function hasAnyReadRecords(sessionId: string): boolean {
  try {
    return readRecords(ensureSessionDir(sessionId), 'reads.jsonl').length > 0;
  } catch {
    return false;
  }
}

/** 이번 턴 안에 Edit/Write로 변경된 파일 기록. agent는 D2 스코프용(선택).
 *  mtime: the file's mtime right after the edit, so a later change by someone else is seen. */
export function recordEdit(sessionId: string, filePath: string, turn: number, agent?: string, mtime?: number): void {
  // (B) goodboy 자체 산출물은 기록 자체를 남기지 않는다 — 리뷰 JSON을 Write 툴로
  //   쓰면 산출물이 스스로 리뷰 대상이 되는 순환이 생긴다(라이브 데드락 재현).
  //   프로브 패턴(C)/존재 필터(A)는 기록 시점에 적용하지 않는다 — 프로브 파일도
  //   read-before-edit 미러(FRICTION #4) 등 리뷰 밖 소비자에게는 유효한 기록이다.
  if (isGoodboyArtifact(filePath)) return;
  const dir = ensureSessionDir(sessionId);
  const record: TrackRecord = {
    file: normalize(filePath),
    turn,
    timestamp: new Date().toISOString(),
  };
  if (typeof agent === 'string' && agent !== '') record.agent = agent;
  if (typeof mtime === 'number' && Number.isFinite(mtime)) record.mtime = mtime;
  appendRecord(dir, 'edits.jsonl', record);
}

/** 특정 턴 안에 Edit/Write된 파일 목록 (중복 제거) */
export function getEditsInTurn(sessionId: string, turn: number): string[] {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  const out = new Set<string>();
  for (const r of records) {
    if (r.turn === turn) out.add(r.file);
  }
  return Array.from(out);
}

/** 최근 withinTurns 안의 Edit/Write 파일 목록 (중복 제거) */
export function getRecentEdits(sessionId: string, withinTurns: number): string[] {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  const current = getCurrentTurn(sessionId);
  const cutoff = current - withinTurns;
  const out = new Set<string>();
  for (const r of records) {
    if (r.turn >= cutoff && r.turn <= current) out.add(r.file);
  }
  return Array.from(out);
}

/** 커서 턴 이상(turn >= cursorTurn)에 Edit/Write된 파일 목록 (중복 제거).
 *  리뷰 커서 용도: 마지막으로 수락된 리뷰 시점(그 Stop의 현재 턴) 이후
 *  변경된 파일만 "리뷰 필요" 대상으로 본다.
 *
 *  경계 설명(왜 >= 인가): 턴 카운터는 Stop hook에서만 증가한다. Stop#N이 턴을 N으로
 *  올린 뒤 리뷰를 수락하고 커서를 N으로 기록한다. 그 다음 에이전트가 만드는 편집은
 *  PostToolUse에서 getCurrentTurn()==N 으로 기록된다. 따라서 "커서 이후의 편집"은
 *  turn >= N 이어야 그 편집들을 포함한다. 이전 피처(turn < N)는 자연히 제외된다.
 *  커서 부재(첫 리뷰)는 cursorTurn=0 으로 호출 → 모든 편집 포함.
 *
 *  withinDir(리뷰 스코프): 그 디렉터리 안의 파일만 센다.
 *  ⚠️ 라이브 검증에서 발견된 자기참조 루프/영구 데드락 대응은 inReviewScope의 3중
 *  필터로 처리한다(mktemp 강제 하나에만 의존하지 않는다 — 그 불변식은 리뷰 에이전트
 *  (review-all, 구 review-changes) 프롬프트에만 있어 다른 서브에이전트에는 적용되지 않았다):
 *    (A) 삭제된 파일(존재하지 않음)은 리뷰 에이전트가 읽을 수 없어 커버리지가 영구
 *        실패하므로 제외(existsSync). (B) goodboy 자체 산출물(.claude/reviews 등)은
 *        제외해 리뷰 JSON이 스스로 리뷰 대상이 되는 순환을 끊는다. (C) __probe* 등
 *        프로브/생성물 패턴은 프로젝트 안에 남아도 제외(GOODBOY_REVIEW_IGNORE로 확장).
 *  두 조회 함수가 반드시 같은 필터를 써야 "커버리지 통과/staleness 실패" 교착이 없다.
 *  ⚠️ 에이전트별로 거르지 않는다 — 서브에이전트가 편집한 프로젝트 파일도 리뷰 대상이다.
 *  (거르면 "편집을 서브에이전트에 시켜 리뷰를 건너뛰는" 우회가 생긴다.) */
export function getEditsSince(
  sessionId: string,
  cursorTurn: number,
  withinDir?: string,
): string[] {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  const out = new Set<string>();
  for (const r of records) {
    if (r.turn < cursorTurn) continue;
    if (!inReviewScope(r.file, withinDir)) continue;
    out.add(r.file);
  }
  return Array.from(out);
}

/** Every file this session ever edited, plus when it first edited one. Unlike
 *  getEditsSince, no review-scope filter applies: a file the session later moved or
 *  deleted, or one outside the Stop's cwd, is still this session's work. The Stop uses
 *  it to tell which reviews are about this session (A3). */
export function getEditHistory(sessionId: string): { files: string[]; firstEditAt: string | null } {
  const records = readRecords(ensureSessionDir(sessionId), 'edits.jsonl');
  const files = new Set<string>();
  let firstEditAt: string | null = null;
  for (const r of records) {
    files.add(r.file);
    if (firstEditAt === null || r.timestamp < firstEditAt) firstEditAt = r.timestamp;
  }
  return { files: Array.from(files), firstEditAt };
}

/** Every edit record of the session with its time (ms), main session and agents alike, in
 *  file order. The friction notice uses it to find the change a review or test run checked
 *  (track J3, lib/friction.ts). */
export function getEditTimeline(sessionId: string): { file: string; t: number }[] {
  const out: { file: string; t: number }[] = [];
  for (const r of readRecords(ensureSessionDir(sessionId), 'edits.jsonl')) {
    const t = Date.parse(r.timestamp);
    if (Number.isFinite(t)) out.push({ file: r.file, t });
  }
  return out;
}

/** withinDir가 주어지면 파일이 그 디렉터리 하위인지 판정. 없으면 항상 true. */
function isWithin(file: string, withinDir?: string): boolean {
  if (!withinDir) return true;
  try {
    const root = resolve(withinDir);
    const f = resolve(file);
    return f === root || f.startsWith(root + sep);
  } catch {
    return true; // 판정 불가 → 포함(fail-closed: 리뷰를 더 요구하는 쪽)
  }
}

// ── 리뷰 스코프 제외 규칙 (라이브 데드락 대응) ─────────────────────────────
//  실사용 세션에서 "존재하지 않는 파일이 리뷰 대상으로 남아 Stop 게이트가 영구
//  차단되는" 데드락이 재현됐다(v0.25.0). 원인:
//   (A) 삭제된 파일이 edits.jsonl에 남는다(단조 증가 집합) → 리뷰 에이전트가 읽을
//       수 없어 커버리지 영구 실패.
//   (B) 리뷰 산출물(.claude/reviews/*.json)을 Write 툴로 쓰면 그 파일이 다시 리뷰
//       대상이 된다(자기참조 무한 후퇴).
//   (C) 프로브 파일의 mktemp 강제는 리뷰 에이전트 프롬프트에만 있는 불변식이라,
//       다른 서브에이전트가 만든 __probe_* 파일이 프로젝트 안에 남는다.
//  대응: 조회 함수 2개(getEditsSince/getLatestEditTimestampSince)에 동일한 필터를
//  적용한다. 두 함수의 대상 집합이 어긋나면 "커버리지 통과/staleness 실패" 교착이
//  생기므로 반드시 같은 필터를 양쪽에 쓴다.

/** goodboy 자체 산출물 경로(자기참조 방지). 기록 시점(recordEdit)에도 제외한다. */
const GOODBOY_ARTIFACT_SEGMENTS = [
  `${sep}.claude${sep}reviews${sep}`,
  // 층1 테스트 결과도 goodboy 산출물이다. 라이브 검증에서 실측: test-changes 에이전트가
  //   결과 JSON을 Write로 쓰자 그 파일이 편집으로 기록되어 리뷰 게이트가
  //   "리뷰되지 않은 변경 파일: .claude/tests/<ts>.json" 으로 영구 차단했다(자기참조 순환).
  `${sep}.claude${sep}tests${sep}`,
  `${sep}.claude${sep}.goodboy`,
  `${sep}.claude${sep}status.json`,
  `${sep}.claude${sep}gate-log.jsonl`,
];

export function isGoodboyArtifact(filePath: string): boolean {
  try {
    const f = resolve(filePath);
    return GOODBOY_ARTIFACT_SEGMENTS.some((s) => f.includes(s));
  } catch {
    return false;
  }
}

/** (C) 프로브/생성물 패턴 제외. GOODBOY_REVIEW_IGNORE(콤마 구분 부분문자열)로 확장. */
const DEFAULT_IGNORE_RE = /(^|\/)__probe[^/]*$|\/(node_modules|\.venv|dist|build|\.git)\//;

function isIgnoredPattern(filePath: string): boolean {
  try {
    const f = resolve(filePath).split(sep).join('/');
    if (DEFAULT_IGNORE_RE.test(f)) return true;
    const extra = process.env.GOODBOY_REVIEW_IGNORE;
    if (typeof extra === 'string' && extra.trim() !== '') {
      for (const part of extra.split(',')) {
        const p = part.trim();
        if (p !== '' && f.includes(p)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** (A) 삭제된 파일 제외 — 리뷰 에이전트가 읽을 수 없어 커버리지가 영구 실패한다.
 *  존재 검사는 git checkout/스크립트 삭제/서브에이전트 rm을 한 번에 덮는다. */
function isReviewable(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/** 리뷰 스코프 공통 필터 — 두 조회 함수가 반드시 함께 쓴다. */
function inReviewScope(file: string, withinDir?: string): boolean {
  if (!isWithin(file, withinDir)) return false;
  if (isGoodboyArtifact(file)) return false; // (B)
  if (isIgnoredPattern(file)) return false; // (C)
  if (!isReviewable(file)) return false; // (A)
  return true;
}

/** getEditsSince와 동일 집합에 대해 파일별 마지막 편집 ISO 타임스탬프를 반환.
 *  리뷰 커버리지의 파일별 staleness 판정에 사용(v0.26.5) — 전역 최신 편집 시각 기준은
 *  "편집 안 된 파일의 유효한 리뷰까지 다른 파일 편집으로 무효화"하는 오차단을 낳는다.
 *  필터는 getEditsSince와 반드시 동일해야 커버리지/staleness 집합이 어긋나지 않는다. */
export function getEditsWithLastTimestampSince(
  sessionId: string,
  cursorTurn: number,
  withinDir?: string,
): Array<{ file: string; lastEditTimestamp: string }> {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  const latestByFile = new Map<string, string>();
  for (const r of records) {
    if (r.turn < cursorTurn) continue;
    if (!inReviewScope(r.file, withinDir)) continue;
    const prev = latestByFile.get(r.file);
    if (prev === undefined || r.timestamp > prev) latestByFile.set(r.file, r.timestamp);
  }
  return Array.from(latestByFile, ([file, lastEditTimestamp]) => ({ file, lastEditTimestamp }));
}

/** getEditsSince 대상 파일 중 가장 최근 편집의 ISO 타임스탬프. 없으면 null.
 *  리뷰 staleness 판정에 사용: 리뷰가 이 시각보다 더 나중이어야 한다.
 *  withinDir는 getEditsSince와 동일 의미 — 두 함수의 대상 집합이 어긋나면
 *  "커버리지는 통과인데 staleness만 실패"하는 교착이 생기므로 반드시 같이 넘긴다. */
export function getLatestEditTimestampSince(
  sessionId: string,
  cursorTurn: number,
  withinDir?: string,
): string | null {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  let latest: string | null = null;
  for (const r of records) {
    if (r.turn < cursorTurn) continue;
    if (!inReviewScope(r.file, withinDir)) continue;
    if (latest === null || r.timestamp > latest) latest = r.timestamp;
  }
  return latest;
}

/** A file's text after this Write/Edit/MultiEdit, from its text before. The edit tools insert
 *  `new_string` as it is, so `$&` and the like stay literal (a replacer function). */
export function textAfterEdit(toolName: string, toolInput: Record<string, unknown>, before: string): string {
  let after = toolName === 'Write' ? String(toolInput.content ?? '') : before;
  const edits = toolName === 'Edit' ? [toolInput] : toolName === 'MultiEdit' && Array.isArray(toolInput.edits) ? (toolInput.edits as Record<string, unknown>[]) : [];
  for (const e of edits) {
    const o = String(e.old_string ?? '');
    const n = String(e.new_string ?? '');
    after = e.replace_all === true ? after.split(o).join(n) : after.replace(o, () => n);
  }
  return after;
}
