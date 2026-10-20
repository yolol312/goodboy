// 게이트 발동 로그 + 상태 스냅샷 (E1) — 3층 출력 구조의 공용 데이터 기반.
//
// 배경: Good Boy의 모든 게이트는 fail-open(불확실하면 조용히 통과)이 원칙이라,
// 게이트가 죽어도(transcript 포맷 변경 등) 겉으로는 티가 나지 않는다.
// 이 모듈은 게이트의 "발동(deny)/경고(warn)/판단불가(fail-open)"를 세션 디렉터리에
// JSONL로 남겨 사후 분석(tokenhabit A/B 대조)과 무력화 감지(canary)를 가능하게 한다.
//
// 상태 스냅샷(status.json)은 상태바/외부 도구가 읽어가는 현재 상태 요약이다:
//   컨텍스트 점유율(게이트가 실제로 쓰는 계산값), 작업 카테고리/위험도,
//   검증 실패/리뷰 대기 여부. Stop hook이 매 턴 갱신한다.
//
// 소비처:
//   1층 대화 내 경고 — hook이 직접 사용
//   2층 이 파일들   — 기계가 읽는 원천 (gate-log.jsonl / status.json)
//   3층 상태바      — status.json을 읽어 표시 (동봉 스크립트 또는 사용자 상태바 연동)
//
// fail-open: 로그/스냅샷 기록 실패는 절대 게이트 동작을 막지 않는다(전부 삼킴).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import { MAX_STATE_BYTES, readRegular } from './safe-read';

export type GateDecision = 'deny' | 'warn' | 'fail-open';

export interface GateEvent {
  ts: string;
  gate: string;
  decision: GateDecision;
  reason?: string;
}

const GATE_LOG_FILE = 'gate-log.jsonl';
const STATUS_FILE = 'status.json';

// reason이 파일에 무한정 쌓이지 않도록 상한. 분석에는 앞부분이면 충분하다.
const REASON_MAX_LEN = 300;

/** 게이트 판정 1건을 기록한다. 통과(allow)는 기록하지 않는다 —
 *  모든 도구 호출마다 줄이 쌓여 노이즈가 되므로, "발동했거나 판단 못 한" 사건만 남긴다.
 *  (hook이 살아있다는 사실 자체는 status.json의 updatedAt이 증명한다.) */
export function logGate(
  sessionId: string,
  gate: string,
  decision: GateDecision,
  reason?: string,
): void {
  try {
    const dir = ensureSessionDir(sessionId);
    const ev: GateEvent = { ts: new Date().toISOString(), gate, decision };
    if (typeof reason === 'string' && reason !== '') ev.reason = reason.slice(0, REASON_MAX_LEN);
    appendFileSync(join(dir, GATE_LOG_FILE), JSON.stringify(ev) + '\n', 'utf8');
  } catch {
    // best-effort
  }
}

/** A hook's caught error: written to stderr as before (`[goodboy <hook>] <where>: <err>`) and,
 *  when the session is known, to the gate log as a `hook-error` fail-open, so the friction
 *  notice can see it (track J3, lib/friction.ts). Never throws. */
export function hookError(sessionId: string | null | undefined, hook: string, where: string, err: unknown): void {
  const text = where !== '' ? `${where}: ${String(err)}` : String(err);
  try {
    process.stderr.write(`[goodboy ${hook}] ${text}\n`);
  } catch {
    // best-effort
  }
  if (sessionId) logGate(sessionId, 'hook-error', 'fail-open', `${hook} ${text}`);
}

/** 세션의 게이트 로그 전체를 읽는다. 없거나 깨졌으면 빈 배열. */
export function readGateLog(sessionId: string): GateEvent[] {
  try {
    const path = join(ensureSessionDir(sessionId), GATE_LOG_FILE);
    // A FIFO or a link to a device at the path is refused, never waited on (J1 review).
    const r = readRegular(path, MAX_STATE_BYTES, true);
    if (typeof r !== 'object') return [];
    const out: GateEvent[] = [];
    for (const line of r.text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<GateEvent>;
        if (
          parsed &&
          typeof parsed.ts === 'string' &&
          typeof parsed.gate === 'string' &&
          (parsed.decision === 'deny' || parsed.decision === 'warn' || parsed.decision === 'fail-open')
        ) {
          out.push(parsed as GateEvent);
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

/** 상태바/외부 도구가 읽는 상태 스냅샷. 소비자는 없는 필드를 무시한다. */
export interface StatusSnapshot {
  updatedAt: string;
  /** 게이트가 실제로 쓰는 컨텍스트 계산값. 측정 실패면 null. */
  context: {
    percent: number;
    tokens: number;
    limit: number;
    confident: boolean;
  } | null;
  category?: string | null;
  risk?: string | null;
  validationFailed?: boolean;
  reviewPending?: boolean;
  /** 층1 테스트 게이트 대기 여부(변경은 있는데 유효한 테스트 결과가 없거나 미달). */
  testPending?: boolean;
  /** 이번 세션의 게이트 deny 누계(참고용). */
  gateDenies?: number;
}

/** status.json 절대경로. 상태바 스크립트가 session_id로 이 경로를 찾는다. */
export function statusFilePath(sessionId: string): string {
  return join(ensureSessionDir(sessionId), STATUS_FILE);
}

/** 상태 스냅샷 기록. updatedAt은 여기서 채운다. */
export function writeStatusSnapshot(
  sessionId: string,
  snapshot: Omit<StatusSnapshot, 'updatedAt'>,
): void {
  try {
    const full: StatusSnapshot = { ...snapshot, updatedAt: new Date().toISOString() };
    writeFileSync(statusFilePath(sessionId), JSON.stringify(full, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

/** 스냅샷 읽기. 없거나 깨졌으면 null. */
export function readStatusSnapshot(sessionId: string): StatusSnapshot | null {
  try {
    const path = statusFilePath(sessionId);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StatusSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.updatedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
