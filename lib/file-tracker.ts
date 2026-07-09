// Read-before-edit 검증을 위한 파일 Read 기록.
//
// 상태 저장 형식 (sessionDir 안):
//   reads.jsonl  — 각 줄: { file: string, turn: number, timestamp: string }
//   edits.jsonl  — 같은 형식
//   turn.txt     — 현재 턴 번호 (정수)

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface TrackRecord {
  file: string;
  turn: number;
  timestamp: string;
  /** H2-01: Read 시점의 파일 수정시각(mtimeMs). 없을 수 있음(하위호환). */
  mtime?: number;
  /** D2: 이 기록을 남긴 에이전트의 agent_id. 없으면 메인 에이전트('main' 스코프)로 취급.
   *  재-Read 게이트가 에이전트별로 공정하게 판정하기 위한 스코프 키(구버전 라인 하위호환). */
  agent?: string;
}

/** 기록의 스코프 키. agent 필드 없는 구버전/메인 기록은 'main'. */
const MAIN_SCOPE = 'main';

function recordScope(r: TrackRecord): string {
  return r.agent ?? MAIN_SCOPE;
}

function sessionDir(sessionId: string): string {
  // sessionId에 path traversal 위험 문자가 있을 수 있으니 소독
  const safe = (sessionId ?? 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_');
  return join(tmpdir(), `goodboy-session-${safe}`);
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
): void {
  const dir = ensureSessionDir(sessionId);
  const record: TrackRecord = {
    file: normalize(filePath),
    turn,
    timestamp: new Date().toISOString(),
  };
  if (typeof mtime === 'number' && Number.isFinite(mtime)) record.mtime = mtime;
  if (typeof agent === 'string' && agent !== '') record.agent = agent;
  appendRecord(dir, 'reads.jsonl', record);
}

/** filePath가 최근 withinTurns 안에 Read 됐는지 확인.
 *  agent 지정 시 그 에이전트 스코프의 기록만 본다(미지정 = 스코프 무시, 전체 매칭). */
export function wasFileReadRecently(
  sessionId: string,
  filePath: string,
  currentTurn: number,
  withinTurns: number,
  agent?: string,
): boolean {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'reads.jsonl');
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

/** H2-01: filePath를 최근 withinTurns 안에 Read한 기록 중 가장 최근(높은 turn)의 mtime.
 *  기록이 없거나 mtime이 없으면 null. 재-Read 게이트가 "그 사이 파일 변경 여부"를
 *  판정하는 데 사용한다(mtime을 모르면 null → 게이트는 fail-open으로 허용). */
export function getRecentReadMtime(
  sessionId: string,
  filePath: string,
  currentTurn: number,
  withinTurns: number,
  agent?: string,
): number | null {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'reads.jsonl');
  const target = normalize(filePath);
  const cutoff = currentTurn - withinTurns;
  let best: number | null = null;
  let bestTurn = -Infinity;
  for (const r of records) {
    if (agent !== undefined && recordScope(r) !== agent) continue;
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
 *  ⚠️ edits.jsonl은 지우지 않는다 — 리뷰 커서/검증 스코프가 의존한다. */
export function clearReadRecords(sessionId: string): void {
  try {
    const path = join(ensureSessionDir(sessionId), 'reads.jsonl');
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** 이번 턴 안에 Edit/Write로 변경된 파일 기록. agent는 D2 스코프용(선택). */
export function recordEdit(sessionId: string, filePath: string, turn: number, agent?: string): void {
  const dir = ensureSessionDir(sessionId);
  const record: TrackRecord = {
    file: normalize(filePath),
    turn,
    timestamp: new Date().toISOString(),
  };
  if (typeof agent === 'string' && agent !== '') record.agent = agent;
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
 *  커서 부재(첫 리뷰)는 cursorTurn=0 으로 호출 → 모든 편집 포함. */
export function getEditsSince(sessionId: string, cursorTurn: number): string[] {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  const out = new Set<string>();
  for (const r of records) {
    if (r.turn >= cursorTurn) out.add(r.file);
  }
  return Array.from(out);
}

/** getEditsSince 대상 파일 중 가장 최근 편집의 ISO 타임스탬프. 없으면 null.
 *  리뷰 staleness 판정에 사용: 리뷰가 이 시각보다 더 나중이어야 한다. */
export function getLatestEditTimestampSince(sessionId: string, cursorTurn: number): string | null {
  const dir = ensureSessionDir(sessionId);
  const records = readRecords(dir, 'edits.jsonl');
  let latest: string | null = null;
  for (const r of records) {
    if (r.turn >= cursorTurn) {
      if (latest === null || r.timestamp > latest) latest = r.timestamp;
    }
  }
  return latest;
}
