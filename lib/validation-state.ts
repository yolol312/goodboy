// 자동 검증 실패 상태 마커 (C1) — PostToolUse가 기록하고 Stop hook이 게이트로 사용한다.
//
// 배경: PostToolUse는 구조상 도구 실행을 차단할 수 없다(이미 실행됨). 기존에는 검증 실패를
// additionalContext "수정이 필요합니다"로 권고만 했고 모델이 무시하면 그만이었다.
// → 실패를 마커 파일로 영속화하고, Stop hook이 마커가 남아 있는 동안 턴 종료를 차단해
//   "말로만 경고"를 결정적 게이트로 승격한다. 재검증이 통과하면 PostToolUse가 마커를 지운다.
//
// Failures are per session, passes per project (stabilization plan A3).
//   - The failure marker lives in the session state dir ($TMPDIR/goodboy-session-<id>/).
//     It used to be one <cwd>/.claude/ file for every session: another session's failing
//     validation replaced this session's marker with one this session ignores, and the
//     failed check stopped blocking this session's turn.
//   - A confirmed pass is recorded per project root (recordValidationPass), one entry per
//     command. The checks run on the working tree that every session of the project
//     shares. So a failure is stale once every one of its commands has passed, in any
//     session, in a run that started after the failure was recorded. The single file got
//     that right by deleting the marker; per-session markers alone re-blocked a session
//     after another session had fixed the tree (hallucination-axis review). The start
//     time, not the finish time, is what counts: a check that began before the breaking
//     edit can finish after it and still pass (round-2 review).
// 형식: { sessionId, timestamp, commands: string[], root? }
//
// The marker names its session, and a mismatch is ignored (the dir name is only a
// sanitized id).
//
// fail-open: 모든 IO 실패는 삼킨다 — 마커를 못 쓰면 게이트가 안 걸릴 뿐(권고는 여전히 감),
// 마커를 못 읽으면 차단하지 않는다.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { isTrustedTimestamp } from './trusted-time';

export interface ValidationFailureState {
  sessionId: string;
  timestamp: string;
  commands: string[];
  /** Project root the commands ran in. A later pass there of the same commands makes this marker stale. */
  root?: string;
}

export const VALIDATION_FAILURE_FILE = '.goodboy-validation-failed.json';
const VALIDATION_PASS_FILE = 'validation-passed.json';

function markerPath(sessionId: string): string {
  return join(ensureSessionDir(sessionId), VALIDATION_FAILURE_FILE);
}

/** Per-project state dir, outside the repo so a pass on every edit causes no file churn.
 *  Unlike a session dir, its name can be computed from the project path. So on a shared
 *  /tmp another local user can create it first and plant a pass or a symlink. On POSIX it
 *  is trusted only as a real directory that this user owns, with no group or other
 *  access. Otherwise this returns null and no pass is recorded or read. That fails closed:
 *  the failure keeps blocking until its own session passes or escapes. */
function projectStateDir(root: string): string | null {
  const key = createHash('sha256').update(resolvePath(root)).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `goodboy-project-${key}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir); // lstat: a symlink to a directory is not a directory here
    if (!st.isDirectory()) return null;
    if (typeof process.getuid === 'function' && (st.uid !== process.getuid() || (st.mode & 0o077) !== 0)) {
      return null;
    }
    return dir;
  } catch {
    return null;
  }
}

/** The pass record: command → ISO start time of its latest passing run. One entry per
 *  command, so a later pass of other commands (typecheck only) does not erase a pass of
 *  this one (round-2 layer-1 F4). */
function readPasses(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const p = JSON.parse(readFileSync(join(dir, VALIDATION_PASS_FILE), 'utf8')) as { passes?: unknown } | null;
    if (p && typeof p.passes === 'object' && p.passes !== null && !Array.isArray(p.passes)) {
      for (const [cmd, startedAt] of Object.entries(p.passes as Record<string, unknown>)) {
        if (typeof startedAt === 'string') out[cmd] = startedAt;
      }
    }
  } catch {
    // no record, or an unreadable one: no passes
  }
  return out;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
}

/** 검증 실패 마커 기록. 실패한 명령 목록을 함께 남겨 Stop 차단 사유에 인용한다. */
export function writeValidationFailure(sessionId: string, commands: string[], root?: string): void {
  try {
    const state: ValidationFailureState = {
      sessionId,
      timestamp: new Date().toISOString(),
      commands: stringList(commands),
    };
    if (typeof root === 'string' && root !== '') state.root = resolvePath(root);
    writeFileSync(markerPath(sessionId), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

/** Records, for every session, that `commands` passed in the project at `root`, in a run
 *  that started at `startedAt` (ISO). */
export function recordValidationPass(root: string, commands: string[], startedAt: string): void {
  try {
    const dir = projectStateDir(root);
    if (dir === null) return;
    const passes = readPasses(dir);
    for (const cmd of stringList(commands)) {
      const prev = passes[cmd];
      // As times, like passedSince. An entry beyond the clock skew (a clock set back) is
      //   replaced: kept, it outranked every later real pass (round-3 final refactoring review).
      if (!isTrustedTimestamp(prev) || Date.parse(startedAt) > Date.parse(prev)) passes[cmd] = startedAt;
    }
    // Write, then rename into place: a concurrent reader never sees a half-written file.
    const staged = join(dir, `${VALIDATION_PASS_FILE}.${process.pid}.tmp`);
    writeFileSync(staged, JSON.stringify({ passes }), 'utf8');
    renameSync(staged, join(dir, VALIDATION_PASS_FILE));
  } catch {
    // best-effort — without the record, an older failure keeps blocking until its own
    //   session passes or escapes (fail-closed).
  }
}

/** 검증 통과/escape 시 마커 해제 (this session's marker only). */
export function clearValidationFailure(sessionId: string): void {
  try {
    const path = markerPath(sessionId);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** 마커 읽기. 없거나 형식이 깨졌으면 null(차단하지 않음). Null as well for a marker
 *  that names another session, or one that later passes of its commands made stale. */
export function readValidationFailure(sessionId: string): ValidationFailureState | null {
  try {
    const path = markerPath(sessionId);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ValidationFailureState> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.sessionId !== sessionId) return null;
    if (typeof parsed.timestamp !== 'string') return null;
    const commands = stringList(parsed.commands);
    const root = typeof parsed.root === 'string' && parsed.root !== '' ? parsed.root : undefined;
    if (root !== undefined && passedSince(root, parsed.timestamp, commands)) return null;
    const state: ValidationFailureState = { sessionId, timestamp: parsed.timestamp, commands };
    if (root !== undefined) state.root = root;
    return state;
  } catch {
    return null;
  }
}

/** True when every one of `commands` passed in a run that started after `since`. A start
 *  time beyond this clock's skew is not trusted. A failure without commands is never
 *  stale: there is nothing to match. */
function passedSince(root: string, since: string, commands: string[]): boolean {
  const sinceMs = Date.parse(since);
  if (commands.length === 0 || !Number.isFinite(sinceMs)) return false;
  const dir = projectStateDir(root);
  if (dir === null) return false;
  const passes = readPasses(dir);
  const nowMs = Date.now();
  return commands.every((cmd) => {
    const startedAt = passes[cmd];
    return isTrustedTimestamp(startedAt, nowMs) && Date.parse(startedAt) > sinceMs;
  });
}
