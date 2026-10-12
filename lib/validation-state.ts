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
//   - A confirmed pass is recorded per project root (recordValidationPass). The checks run
//     on the working tree that every session of the project shares, so a later pass of
//     the same commands in any session makes an older failure stale. The single file got
//     that right by deleting the marker; per-session markers alone re-blocked a session
//     after another session had fixed the tree (hallucination-axis review).
// 형식: { sessionId, timestamp, commands: string[], root? }
//
// The marker names its session, and a mismatch is ignored (the dir name is only a
// sanitized id).
//
// fail-open: 모든 IO 실패는 삼킨다 — 마커를 못 쓰면 게이트가 안 걸릴 뿐(권고는 여전히 감),
// 마커를 못 읽으면 차단하지 않는다.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { ensureSessionDir } from './file-tracker';

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

/** Per-project state dir, outside the repo so a pass on every edit causes no file churn. */
function projectStateDir(root: string): string {
  const key = createHash('sha256').update(resolvePath(root)).digest('hex').slice(0, 16);
  const dir = join(tmpdir(), `goodboy-project-${key}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
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

/** Records a confirmed pass of `commands` in the project at `root`, for every session. */
export function recordValidationPass(root: string, commands: string[]): void {
  try {
    writeFileSync(
      join(projectStateDir(root), VALIDATION_PASS_FILE),
      JSON.stringify({ timestamp: new Date().toISOString(), commands: stringList(commands) }),
      'utf8',
    );
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
 *  that names another session, or one a later pass of the same commands made stale. */
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

/** True when the project recorded a pass of every one of `commands` after `since`. */
function passedSince(root: string, since: string, commands: string[]): boolean {
  try {
    const p = JSON.parse(readFileSync(join(projectStateDir(root), VALIDATION_PASS_FILE), 'utf8')) as {
      timestamp?: unknown;
      commands?: unknown;
    } | null;
    if (!p || typeof p.timestamp !== 'string' || p.timestamp <= since) return false;
    const passed = stringList(p.commands);
    return commands.every((c) => passed.includes(c));
  } catch {
    return false;
  }
}
