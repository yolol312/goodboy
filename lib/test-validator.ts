// 테스트 결과 JSON 검증 (Stop hook 층1 게이트에서 사용)
//
// 리뷰 검증(review-validator.ts)과 같은 신뢰 모델을 따른다:
//   - timestamp는 에이전트가 쓰는 필드라 위조 가능 → 쓰기 시점(cli.ts 서버 시각 강제)과
//     검증 시점(미래 거부) 두 겹으로 막는다.
//   - 파일별 커버리지 + 파일별 staleness — 부분 테스트 2개가 서로를 무효화하지 않게.
//
// 리뷰 검증에 없는 축이 셋 있다. 전부 "통과했다는 주장"을 못 믿기 때문에 존재한다:
//   (1) red-green — 되돌린 상태에서 실패함을 먼저 보여야 그 테스트가 뭔가를 붙잡고 있다.
//   (2) 뮤테이션 프로브 — 검증 대상을 훼손해도 통과하면 그 테스트는 무효다.
//   (3) 수용 기준 커버리지 — dev-cycle 산출물이 요구한 항목을 실제로 커버했는가.

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalTimestamp, isTrustedTimestamp } from './trusted-time';
import type { AcceptanceCoverage, TestResult, TestVerdict } from './types';
import type { AcceptanceCriterion } from './acceptance';
// 변경 파일 + 마지막 편집 시각. 리뷰 게이트와 같은 타입을 쓴다(같은 커버리지 의미론).
import type { ChangedFileEdit } from './review-validator';

function isVerdict(v: unknown): v is TestVerdict {
  return v === 'pass' || v === 'needs-changes' || v === 'fail' || v === 'blocked';
}

/** An evidence-backed BLOCKED result (track G): verdict `blocked` with a reason and at least
 *  one command and its output that show why the tests could not run. */
export function isEvidencedBlocked(r: TestResult): boolean {
  if (r.verdict !== 'blocked' || !r.blocked) return false;
  const { reason, evidence } = r.blocked;
  return (
    typeof reason === 'string' &&
    reason.trim().length >= 15 &&
    Array.isArray(evidence) &&
    evidence.length > 0 &&
    evidence.every((e) => typeof e?.command === 'string' && e.command.trim() !== '' && typeof e.output === 'string' && e.output.trim() !== '')
  );
}

function normalizePath(p: string): string {
  try {
    return resolve(p);
  } catch {
    return p;
  }
}

function safeReadTest(path: string): TestResult | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TestResult>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Stored in one format, so the string comparisons below follow time order (as for reviews).
    const timestamp = canonicalTimestamp(parsed.timestamp);
    if (timestamp === null) return null;
    parsed.timestamp = timestamp;
    if (!Array.isArray(parsed.tested_files)) return null;
    if (typeof parsed.category !== 'string') return null;
    if (!Array.isArray(parsed.test_files)) return null;
    if (!Array.isArray(parsed.suites)) return null;
    if (!isVerdict(parsed.verdict)) return null;
    if (!Array.isArray(parsed.acceptance)) parsed.acceptance = [];
    if (typeof parsed.environment !== 'object' || parsed.environment === null) {
      parsed.environment = { mode: 'none' };
    }
    return parsed as TestResult;
  } catch {
    return null;
  }
}

/** testsDir 안의 유효 테스트 결과를 최신순으로 반환 (withinMinutes 이내만). */
export function findRecentTestFiles(testsDir: string, withinMinutes: number): TestResult[] {
  try {
    const now = Date.now();
    const candidates: Array<{ path: string; mtime: number }> = [];
    for (const name of readdirSync(testsDir)) {
      if (!name.endsWith('.json')) continue;
      const full = join(testsDir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if ((now - st.mtimeMs) / 60000 > withinMinutes) continue;
        candidates.push({ path: full, mtime: st.mtimeMs });
      } catch {
        continue;
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const out: TestResult[] = [];
    for (const c of candidates) {
      const r = safeReadTest(c.path);
      if (r !== null) out.push(r);
    }
    return out;
  } catch {
    return [];
  }
}

/** 보존 기간이 지난 테스트 결과 파일 삭제 (리뷰 파일 정리와 동일 위생 작업).
 *  @param nowMs 기준 시각. 생략하면 `Date.now()`. pruneOldReviewFiles와 같은 이유로
 *    주입 가능하다 — 경계를 벽시계 경쟁 없이 검증하기 위해서다. */
export function pruneOldTestFiles(
  testsDir: string,
  olderThanMinutes: number,
  nowMs?: number,
): number {
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes <= 0) return 0;
  let pruned = 0;
  try {
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
    for (const name of readdirSync(testsDir)) {
      if (!name.endsWith('.json')) continue;
      const full = join(testsDir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if ((now - st.mtimeMs) / 60000 <= olderThanMinutes) continue;
        unlinkSync(full);
        pruned++;
      } catch {
        continue;
      }
    }
  } catch {
    // 정리는 위생 작업 — 조용히 넘어간다.
  }
  return pruned;
}

/**
 * 테스트 파일 자체인가 — 커버리지 요구 대상에서 뺀다.
 *
 * 라이브 검증 실측: 모델이 `tests/hello.test.ts` 를 만들자 게이트가 그 파일을
 * "테스트되지 않은 변경 파일"로 요구했다. 테스트를 테스트하라는 무한 후퇴다.
 * 테스트 파일은 검증 **수단**이지 검증 **대상**이 아니다.
 *
 * 파일명/경로 휴리스틱만 쓴다(결과 JSON의 test_files에 의존하면 "결과가 자기 대상을
 * 정하는" 순환이 된다 — 대상 집합을 스스로 비워 게이트를 무력화할 수 있다).
 */
export function isTestFile(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath === '') return false;
  const f = filePath.split('\\').join('/').toLowerCase();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(f)) return true;
  if (/(^|\/)(tests?|__tests__|spec|e2e)\//.test(f)) return true;
  if (/(^|\/)test_[^/]+\.py$/.test(f) || /_test\.(py|go|rb)$/.test(f)) return true;
  return false;
}


/**
 * 이 저장소에 **테스트를 돌릴 수단이 있는가**.
 *
 * 층1 게이트를 무조건 켜 두면 테스트 인프라가 없는 저장소에서 마찰만 남는다 — 라이브
 * 실측에서 빈 저장소에 파일 하나 만드는 작업이 3회 차단 후 escape로 끝났다. escape는
 * 아무것도 검증하지 못하면서 사용자에게 경고만 남기므로 게이트의 최악 결말이다.
 *
 * 실행하지 않고 파일 존재만 본다(빠르고 부작용 없음). 언어 표준 러너가 있는 생태계
 * (go/rust)는 그 자체를 신호로 본다 — `go test`/`cargo test`는 설정 없이 바로 돈다.
 */
export interface TestInfraSignal {
  present: boolean;
  /** 무엇을 보고 판단했는지 — 게이트 로그와 사용자 안내에 쓴다. */
  evidence: string;
}

const TEST_CONFIG_FILES = [
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'jest.config.cjs',
  'jest.config.json',
  'vitest.config.js',
  'vitest.config.ts',
  'vitest.config.mts',
  'playwright.config.js',
  'playwright.config.ts',
  'karma.conf.js',
  'pytest.ini',
  'tox.ini',
  'phpunit.xml',
  'phpunit.xml.dist',
  '.rspec',
];

const TEST_DIRS = ['tests', 'test', '__tests__', 'spec', 'e2e'];

/** npm init이 넣어 두는 자리표시자 — 테스트가 있다는 증거가 아니다. */
const NPM_PLACEHOLDER_TEST = /no test specified/i;

export function detectTestInfrastructure(cwd: string): TestInfraSignal {
  const none: TestInfraSignal = { present: false, evidence: '' };
  try {
    for (const f of TEST_CONFIG_FILES) {
      if (existsSync(join(cwd, f))) return { present: true, evidence: f };
    }
    for (const d of TEST_DIRS) {
      const p = join(cwd, d);
      if (existsSync(p) && statSync(p).isDirectory()) return { present: true, evidence: `${d}/` };
    }
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const script = pkg.scripts?.test;
      if (typeof script === 'string' && script !== '' && !NPM_PLACEHOLDER_TEST.test(script)) {
        return { present: true, evidence: 'package.json scripts.test' };
      }
    }
    const pyproject = join(cwd, 'pyproject.toml');
    if (existsSync(pyproject) && /pytest/.test(readFileSync(pyproject, 'utf8'))) {
      return { present: true, evidence: 'pyproject.toml (pytest)' };
    }
    // 언어 표준 러너 — 설정 없이 `go test` / `cargo test` 가 돈다.
    if (existsSync(join(cwd, 'go.mod'))) return { present: true, evidence: 'go.mod (go test)' };
    if (existsSync(join(cwd, 'Cargo.toml'))) {
      return { present: true, evidence: 'Cargo.toml (cargo test)' };
    }
    return none;
  } catch {
    // 판별 실패는 "없다"로 본다 — 확신 없이 차단하지 않는다.
    return none;
  }
}

export interface TestValidation {
  ok: boolean;
  reason?: string;
  /** 커버리지를 실제로 구성한 결과들 */
  effective: TestResult[];
}

function hasTrustedTimestamp(r: TestResult, nowMs: number): boolean {
  return isTrustedTimestamp(r.timestamp, nowMs);
}

/**
 * 파일별 커버리지 + staleness. 의미론은 validateReviewCoverage와 동일하다
 * (각 변경 파일은 "그 파일의 마지막 편집보다 나중이고 그 파일을 커버하는" 결과가 있으면 통과).
 */
export function validateTestCoverage(
  results: TestResult[],
  changedEdits: ChangedFileEdit[],
): TestValidation {
  if (!Array.isArray(results) || results.length === 0) {
    return { ok: false, reason: '테스트 결과 없음', effective: [] };
  }
  const nowMs = Date.now();
  const trusted = results.filter((r) => hasTrustedTimestamp(r, nowMs));
  const rejectedFuture = results.length - trusted.length;
  if (trusted.length === 0) {
    return {
      ok: false,
      reason: '유효한 테스트 결과가 없습니다(timestamp가 미래이거나 손상됨 — 게이트 우회로 간주해 거부).',
      effective: [],
    };
  }
  if (!Array.isArray(changedEdits) || changedEdits.length === 0) {
    const newest = trusted[0]!;
    if (newest.verdict === 'fail') {
      return { ok: false, reason: '테스트 verdict이 fail', effective: [newest] };
    }
    return { ok: true, effective: [newest] };
  }
  const sorted = [...trusted].sort((a, b) =>
    a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? 1 : -1,
  );
  const missing: string[] = [];
  const stale: string[] = [];
  const failed: string[] = [];
  const effective = new Set<TestResult>();
  for (const edit of changedEdits) {
    const key = normalizePath(edit.file);
    let coveredStale = false;
    let chosen: TestResult | null = null;
    for (const r of sorted) {
      if (!(r.tested_files ?? []).some((f) => normalizePath(f) === key)) continue;
      const isFresh =
        typeof edit.lastEditTimestamp !== 'string' ||
        edit.lastEditTimestamp === '' ||
        r.timestamp > edit.lastEditTimestamp;
      if (isFresh) {
        chosen = r;
        break;
      }
      coveredStale = true;
    }
    if (chosen === null) {
      if (coveredStale) stale.push(edit.file);
      else missing.push(edit.file);
      continue;
    }
    if (chosen.verdict === 'fail') {
      failed.push(edit.file);
      continue;
    }
    effective.add(chosen);
  }
  const futureNote =
    rejectedFuture > 0 ? ` (미래 timestamp 결과 ${rejectedFuture}개는 위조 의심으로 무시됨)` : '';
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `테스트되지 않은 변경 파일 ${missing.length}개: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}${futureNote}`,
      effective: Array.from(effective),
    };
  }
  if (stale.length > 0) {
    return {
      ok: false,
      reason: `테스트가 마지막 편집보다 오래된 파일 ${stale.length}개: ${stale.slice(0, 3).join(', ')}${stale.length > 3 ? ' …' : ''}. 해당 파일을 다시 테스트하세요.${futureNote}`,
      effective: Array.from(effective),
    };
  }
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `최신 테스트 verdict이 fail인 파일 ${failed.length}개: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ' …' : ''}`,
      effective: Array.from(effective),
    };
  }
  return { ok: true, effective: Array.from(effective) };
}

/** 스위트가 하나라도 실패했으면 사유를 반환. 전부 통과면 null. */
export function failingSuites(results: TestResult[]): string | null {
  const bad: string[] = [];
  for (const r of results) {
    for (const s of r.suites ?? []) {
      if (!s || typeof s.failed !== 'number') continue;
      if (s.failed > 0) bad.push(`${s.name}(${s.failed}건 실패)`);
    }
  }
  if (bad.length === 0) return null;
  return `실패한 테스트 스위트: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ` 외 ${bad.length - 3}개` : ''}`;
}

/**
 * 뮤테이션 프로브를 요구하는 수용 기준인가.
 *
 * UI 축(프로토타입 대조 · UIUX 화면)에서만 요구한다. "요소가 보인다"류 단언은
 * 아무것도 안 하고도 통과하기 쉬워서, 대상을 훼손했을 때 실패하는지 확인해야
 * 그 테스트가 실재하는 것을 붙잡고 있다고 인정할 수 있다.
 */
export function requiresMutationProbe(id: string): boolean {
  return /^(PT-|UIUX-)/.test(id ?? '');
}

/** red-green · 뮤테이션 증거 무결성. 문제가 있으면 사람이 읽는 사유 목록을 반환. */
export function evidenceProblems(cov: AcceptanceCoverage): string[] {
  const out: string[] = [];
  const id = cov?.id ?? '(id 없음)';
  if (!cov || typeof cov !== 'object') return [`${id}: 커버리지 항목이 객체가 아닙니다.`];

  const red = cov.red;
  if (!red || typeof red.command !== 'string' || red.command.trim() === '') {
    out.push(`${id}: red 증거에 실행한 명령이 없습니다.`);
  } else if (typeof red.exit_code !== 'number') {
    out.push(`${id}: red 증거에 exit_code가 없습니다 — 실패했음을 종료 코드로 보여야 합니다.`);
  } else if (red.exit_code === 0) {
    out.push(
      `${id}: red 증거가 성공(exit 0)입니다. 되돌린 상태에서 테스트가 통과했다면 그 테스트는 ` +
        `아무것도 검증하지 않습니다 — 실패하는 것을 먼저 보여야 합니다.`,
    );
  }

  const green = cov.green;
  if (!green || typeof green.command !== 'string' || green.command.trim() === '') {
    out.push(`${id}: green 증거에 실행한 명령이 없습니다.`);
  } else if (typeof green.exit_code !== 'number') {
    out.push(`${id}: green 증거에 exit_code가 없습니다.`);
  } else if (green.exit_code !== 0) {
    out.push(`${id}: green 증거가 실패(exit ${green.exit_code})입니다.`);
  }

  if (requiresMutationProbe(id)) {
    const mut = cov.mutation;
    if (!mut || typeof mut.command !== 'string' || mut.command.trim() === '') {
      out.push(
        `${id}: 뮤테이션 프로브가 없습니다 — 검증 대상을 훼손한 뒤 테스트가 실패하는지 ` +
          `실행으로 확인해야 합니다(UI 단언은 훼손해도 통과하기 쉽습니다).`,
      );
    } else if (mut.detected !== true) {
      out.push(
        `${id}: 뮤테이션 프로브가 실패를 감지하지 못했습니다(detected=false) — ` +
          `대상을 훼손해도 통과하는 테스트는 무효입니다.`,
      );
    }
  }
  return out;
}

/**
 * 결과 전체의 증거 무결성 검사. 문제가 없으면 null.
 *
 * ⚠️ `acceptance` 가 비어 있으면 **그 자체가 문제**다. 라이브 검증 실측: dev-cycle 산출물이
 * 없는 프로젝트에서 에이전트가 `"acceptance": []` 로 결과를 냈고, 필수 수용 기준도 비어
 * 있으니 커버리지 검사까지 통과해 red-green·뮤테이션 검증이 통째로 건너뛰어졌다.
 * 그러면 이 게이트는 "테스트가 돌았고 통과했다"만 확인하는 것이 되어 존재 이유를 잃는다.
 * dev-cycle 기준이 없더라도 **무엇을 검증했는지 최소 1건은 red-green으로 증명**해야 한다.
 */
export function validateEvidence(results: TestResult[]): string | null {
  const problems: string[] = [];
  const totalCoverage = results.reduce((n, r) => n + (r.acceptance?.length ?? 0), 0);
  if (results.length > 0 && totalCoverage === 0) {
    return (
      'acceptance가 비어 있습니다 — 무엇을 검증했는지 최소 1건은 기록해야 합니다. ' +
      '각 항목은 되돌린 상태에서 실패(red)하고 지금은 통과(green)함을 실행으로 보여야 합니다.'
    );
  }
  for (const r of results) {
    for (const cov of r.acceptance ?? []) {
      problems.push(...evidenceProblems(cov));
    }
  }
  if (problems.length === 0) return null;
  return `${problems.slice(0, 3).join(' / ')}${problems.length > 3 ? ` 외 ${problems.length - 3}건` : ''}`;
}

/** test_files에 적힌 파일이 실제로 존재하는지. 없으면 사유 반환(휘발성 프로브를 테스트로 위장한 경우). */
export function missingTestFiles(results: TestResult[]): string | null {
  const missing: string[] = [];
  for (const r of results) {
    for (const f of r.test_files ?? []) {
      if (typeof f !== 'string' || f.trim() === '') continue;
      if (!existsSync(f)) missing.push(f);
    }
  }
  if (missing.length === 0) return null;
  return (
    `test_files에 적힌 파일이 존재하지 않습니다: ${missing.slice(0, 3).join(', ')}` +
    `${missing.length > 3 ? ` 외 ${missing.length - 3}개` : ''}. ` +
    `층1 테스트는 repo에 남는 자산이어야 합니다(임시 프로브가 아님).`
  );
}

/** 수용 기준 중 커버되지 않은 것. required가 비면 빈 배열(= 강제 없음). */
export function uncoveredCriteria(
  results: TestResult[],
  required: AcceptanceCriterion[],
): AcceptanceCriterion[] {
  if (!Array.isArray(required) || required.length === 0) return [];
  const covered = new Set<string>();
  for (const r of results) {
    for (const cov of r.acceptance ?? []) {
      if (cov && typeof cov.id === 'string') covered.add(cov.id);
    }
  }
  return required.filter((c) => !covered.has(c.id));
}

// ── 가짜 테스트 패턴 정적 검사 ────────────────────────────────────────────────

export interface ForbiddenPattern {
  key: string;
  /** 매칭 정규식 */
  re: RegExp;
  message: string;
}

/**
 * 통과하지만 아무것도 검증하지 않는 테스트의 대표 패턴.
 * 실제로 LLM이 E2E를 쓸 때 반복적으로 나오는 형태만 담는다(오탐을 줄이기 위해 좁게).
 */
export const FORBIDDEN_TEST_PATTERNS: ForbiddenPattern[] = [
  {
    key: 'wait-timeout',
    re: /\bwaitForTimeout\s*\(/,
    message: 'waitForTimeout — 타이밍으로 때운 대기. 상태를 단언하는 대기로 바꾸세요.',
  },
  {
    key: 'swallowed-catch',
    re: /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)|\.catch\s*\(\s*\(\s*\)\s*=>\s*\{?\s*\}?\s*\)/,
    message: '빈 catch — 실패를 삼켜서 테스트가 절대 실패하지 않습니다.',
  },
  {
    key: 'always-true-count',
    re: /toBeGreaterThanOrEqual\s*\(\s*0\s*\)/,
    message: 'toBeGreaterThanOrEqual(0) — 항상 참인 단언입니다.',
  },
  {
    key: 'always-true-defined',
    re: /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/,
    message: 'expect(true).toBe(true) — 항상 참인 단언입니다.',
  },
  {
    key: 'skipped-test',
    re: /\b(it|test|describe)\s*\.\s*(skip|todo)\s*\(/,
    message: 'skip/todo로 남은 테스트 — 커버한 것으로 셀 수 없습니다.',
  },
];

export interface ForbiddenHit {
  file: string;
  key: string;
  message: string;
}

/**
 * 문자열·템플릿 리터럴·주석의 **내용**을 공백으로 지운다(길이·줄바꿈은 보존).
 *
 * 금지 패턴은 "실행되는 코드"에서만 의미가 있다. 그런데 정적 스캐너를 검증하는 메타
 * 테스트는 금지 패턴을 **픽스처 문자열로 반드시 포함**한다 — 그걸 위반으로 세면
 * 해소 방법이 "정당한 테스트를 지우기"밖에 없어 게이트가 영구 오탐이 된다.
 * 실측: goodboy 자신의 `tests/test-validator.test.ts` 가 4건, `tests/stop-test-gate.test.ts`
 * 가 1건 걸렸고, 층1이 자기 저장소에서 통과 불가능해졌다.
 *
 * 우회 여지가 없는 방향으로 고른 것이다 — 문자열 안에 숨긴 `waitForTimeout(` 은
 * 애초에 실행되지 않으므로, 지워도 잡아야 할 것을 놓치지 않는다.
 *
 * 정규식 리터럴은 별도로 파싱하지 않는다. 다만 일반 코드의 `\` 는 다음 글자를
 * 건너뛴다 — `/https?:\/\//` 같은 정규식의 `\/` 가 줄 주석 시작으로 오인돼
 * 그 줄이 통째로 지워지는 것(= 위반 미검출)을 막기 위해서다.
 */
export function stripLiteralsAndComments(source: string): string {
  if (typeof source !== 'string' || source === '') return '';
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '\\') {
      i += 2; // 일반 코드의 이스케이프(정규식 `\/` 등)
      continue;
    }
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        const d = source[j]!;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === quote) break;
        // 따옴표 문자열은 줄을 넘지 않는다 — 닫히지 않은 따옴표(아포스트로피 등)가
        //   파일 끝까지 삼켜 위반을 통째로 숨기는 것을 막는다. 템플릿은 넘어간다.
        if (d === '\n' && quote !== '`') break;
        j++;
      }
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
  return out.join('');
}

/** 테스트 파일들에서 가짜 테스트 패턴을 찾는다. 읽기 실패한 파일은 건너뛴다(fail-open). */
export function scanForbiddenPatterns(testFiles: string[]): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const f of testFiles ?? []) {
    if (typeof f !== 'string' || f.trim() === '') continue;
    let content: string;
    try {
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // 문자열·주석은 실행되지 않는다 — 픽스처를 위반으로 세지 않는다.
    const code = stripLiteralsAndComments(content);
    for (const p of FORBIDDEN_TEST_PATTERNS) {
      if (p.re.test(code)) {
        hits.push({ file: f, key: p.key, message: p.message });
      }
    }
  }
  return hits;
}
