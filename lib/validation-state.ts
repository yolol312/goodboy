// 자동 검증 실패 상태 마커 (C1) — PostToolUse가 기록하고 Stop hook이 게이트로 사용한다.
//
// 배경: PostToolUse는 구조상 도구 실행을 차단할 수 없다(이미 실행됨). 기존에는 검증 실패를
// additionalContext "수정이 필요합니다"로 권고만 했고 모델이 무시하면 그만이었다.
// → 실패를 마커 파일로 영속화하고, Stop hook이 마커가 남아 있는 동안 턴 종료를 차단해
//   "말로만 경고"를 결정적 게이트로 승격한다. 재검증이 통과하면 PostToolUse가 마커를 지운다.
//
// 위치: <cwd>/.claude/.goodboy-validation-failed.json
// 형식: { sessionId, timestamp, commands: string[] }
//
// 세션 바인딩(위험도 게이트 2-B와 동일 원칙): 어제 세션/다른 사용자가 커밋한 잔재 마커가
// 새 세션을 억울하게 차단하는 이월 오탐을 막기 위해, Stop은 sessionId가 현재 세션과
// 일치하는 마커만 신뢰한다.
//
// fail-open: 모든 IO 실패는 삼킨다 — 마커를 못 쓰면 게이트가 안 걸릴 뿐(권고는 여전히 감),
// 마커를 못 읽으면 차단하지 않는다.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export interface ValidationFailureState {
  sessionId: string;
  timestamp: string;
  commands: string[];
}

const MARKER_FILE = '.goodboy-validation-failed.json';

function markerPath(cwd: string): string {
  return resolvePath(cwd, '.claude', MARKER_FILE);
}

/** 검증 실패 마커 기록. 실패한 명령 목록을 함께 남겨 Stop 차단 사유에 인용한다. */
export function writeValidationFailure(cwd: string, sessionId: string, commands: string[]): void {
  try {
    mkdirSync(resolvePath(cwd, '.claude'), { recursive: true });
    const state: ValidationFailureState = {
      sessionId,
      timestamp: new Date().toISOString(),
      commands: Array.isArray(commands) ? commands.filter((c) => typeof c === 'string') : [],
    };
    writeFileSync(markerPath(cwd), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

/** 검증 통과/escape 시 마커 해제. */
export function clearValidationFailure(cwd: string): void {
  try {
    const path = markerPath(cwd);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort
  }
}

/** 마커 읽기. 없거나 형식이 깨졌으면 null(차단하지 않음). */
export function readValidationFailure(cwd: string): ValidationFailureState | null {
  try {
    const path = markerPath(cwd);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ValidationFailureState>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.sessionId !== 'string') return null;
    if (typeof parsed.timestamp !== 'string') return null;
    const commands = Array.isArray(parsed.commands)
      ? parsed.commands.filter((c): c is string => typeof c === 'string')
      : [];
    return { sessionId: parsed.sessionId, timestamp: parsed.timestamp, commands };
  } catch {
    return null;
  }
}
