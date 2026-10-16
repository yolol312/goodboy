// Test tier advice (track H §14.7). `cli.ts test-write` keeps a per-project test profile in
// `.claude/.goodboy-test-profile.json` (local and machine-written: per test type, the tests, the
// duration and when it was measured). SessionStart advises a tier once a session when the
// measured total is over ten minutes. Advice only, never a block: setting a tier up is the
// user's decision.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir } from './file-tracker';
import type { TestResult, TestType } from './types';

/** A `.claude/.goodboy-*` name, so the push check's tree comparison leaves it out like
 *  goodboy's other files (lib/push-test.ts): test-write writes it after the tree is taken. */
export const TEST_PROFILE_FILE = join('.claude', '.goodboy-test-profile.json');

export interface TypeProfile {
  tests: number;
  duration_ms: number;
  measured_at: string;
}
export type TestProfile = Partial<Record<TestType, TypeProfile>>;

/** After this long any new measurement replaces an entry, even a narrower run. */
const STALE_MS = 30 * 86_400_000;
const TIER_1_MAX_MS = 10 * 60_000;
const TIER_2_MAX_MS = 60 * 60_000;
const TYPES: readonly TestType[] = ['unit', 'integration', 'ui', 'e2e'];

const isEntry = (v: unknown): v is TypeProfile => {
  const e = v as TypeProfile;
  return !!e && Number.isFinite(e.tests) && e.tests >= 0 && Number.isFinite(e.duration_ms) && e.duration_ms >= 0 && typeof e.measured_at === 'string' && Number.isFinite(Date.parse(e.measured_at));
};

export function readTestProfile(root: string): TestProfile {
  try {
    const v = JSON.parse(readFileSync(join(root, TEST_PROFILE_FILE), 'utf8')) as Record<string, unknown>;
    const out: TestProfile = {};
    for (const t of TYPES) if (isEntry(v?.[t])) out[t] = v[t] as TypeProfile;
    return out;
  } catch {
    return {};
  }
}

/** The profile after one recorded run. Per type the entry is the closest to a full run: a run
 *  with at least as many tests replaces it, a narrower one does not, unless the entry is a
 *  month old (the suite may really have shrunk). */
export function mergeProfile(prev: TestProfile, byType: TestResult['by_type'], at: string): TestProfile {
  const next: TestProfile = { ...prev };
  const atMs = Date.parse(at);
  for (const t of TYPES) {
    const run = byType?.[t];
    if (!run) continue;
    const old = next[t];
    if (!old || run.tests >= old.tests || atMs - Date.parse(old.measured_at) > STALE_MS) {
      next[t] = { tests: run.tests, duration_ms: run.duration_ms, measured_at: at };
    }
  }
  return next;
}

/** test-write's update (best-effort: a profile that cannot be written only loses advice). */
export function recordTestProfile(root: string, byType: TestResult['by_type'], at: string): void {
  if (!byType || Object.keys(byType).length === 0) return;
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, TEST_PROFILE_FILE), JSON.stringify(mergeProfile(readTestProfile(root), byType, at), null, 2) + '\n');
  } catch {
    // best-effort
  }
}

export function profileTotalMs(p: TestProfile): number {
  return TYPES.reduce((sum, t) => sum + (p[t]?.duration_ms ?? 0), 0);
}

/** 1: up to ten minutes, run everything at task end (no advice); 2: up to an hour; 3: more. */
export function tierOf(totalMs: number): 1 | 2 | 3 {
  return totalMs <= TIER_1_MAX_MS ? 1 : totalMs <= TIER_2_MAX_MS ? 2 : 3;
}

const span = (ms: number) => (ms >= 90 * 60_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`);

/** The SessionStart advice (model context and the user's Korean line), once a session, or
 *  null: tier 1, no profile, or already given in this session. */
export function tierAdvice(root: string, sessionId: string): { context: string; systemMessage: string } | null {
  const p = readTestProfile(root);
  const total = profileTotalMs(p);
  const tier = tierOf(total);
  if (tier === 1) return null;
  const flag = join(ensureSessionDir(sessionId), 'tier-advised');
  if (existsSync(flag)) return null;
  try {
    writeFileSync(flag, '');
  } catch {
    // best-effort: the advice may come again
  }
  const parts = TYPES.filter((t) => p[t]).map((t) => `${t} ${span(p[t]!.duration_ms)} / ${p[t]!.tests} tests`);
  const last = TYPES.map((t) => p[t]?.measured_at ?? '').sort().pop()!.slice(0, 10);
  const what =
    tier === 2
      ? 'unit and integration tests at commit, everything before push'
      : 'the affected tests before push, the full E2E suite on release or on request';
  const what_ko = tier === 2 ? '커밋 때는 unit·integration, 푸시 전에는 전체' : '푸시 전에는 영향받는 테스트만, 전체 E2E는 릴리스나 요청 때';
  const minutes = Math.round(total / 60_000);
  return {
    context:
      `Test tier advice (goodboy): this project's measured test time is about ${span(total)} (${parts.join('; ')}; last measured ${last}). ` +
      `At this size goodboy advises: ${what}. Setting that up (scripts, CI, hooks) is the user's decision: propose it once, ` +
      'and do not change the test setup yourself. (test tier advice)',
    systemMessage: `[goodboy] 이 프로젝트의 테스트는 측정상 약 ${minutes >= 90 ? `${Math.round(minutes / 60)}시간` : `${minutes}분`}이에요. ${what_ko}를 돌리는 구성을 권해요. 적용 여부는 직접 정해 주세요.`,
  };
}
