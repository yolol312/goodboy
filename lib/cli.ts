#!/usr/bin/env bun
// goodboy helper CLI, run through Bash by the review and test agents and their tool skills
// (record-review, record-tests, measure-coverage).
//
// 사용법:
//   bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts <command> [args...]
//
// 지원 명령:
//   review-write [file]   (없으면 stdin에서 ReviewResult JSON을 읽음)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  ReviewFinding,
  ReviewResult,
  Severity,
  TestEnvMode,
  TestResult,
  TestSuiteRun,
  TestType,
  TestVerdict,
  Verdict,
} from './types';
import { workTreeState } from './push-test';
import { diffCoverageOf } from './diff-coverage';
import { knowledgeRoot, validateKnowledge } from './project-knowledge';
import { decisionItems } from './decision-authority';
import { catalogRows, renderCatalog, TEST_CATALOG_FILE } from './test-catalog';
import { recordTestProfile } from './test-profile';
import { changedLineCount, reviewPlan, reviewPlanNote } from './review-scope';
import { agentName, ROUTE } from './routing-policy';
import {
  findDevCycleArtifacts,
  prototypeContractWarnings,
  requiredAcceptanceCriteria,
} from './acceptance';
import { AXIS_DIMENSIONS, axesFor, requiredDimensionsFor } from './review-dimensions';
import { appendSkillGapLog, recordSkillEvidence, validateSkillGapNote } from './skill-rule';

// ---- 유틸 ----

function fail(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ---- 명령: review-write ----

const VALID_SEVERITIES: Severity[] = ['high', 'medium', 'low'];
const VALID_VERDICTS: Verdict[] = ['pass', 'needs-changes', 'fail'];
const VALID_TEST_VERDICTS: TestVerdict[] = [...VALID_VERDICTS, 'blocked'];

/** stdin을 끝까지 읽는다. */
async function readAllStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

/** ReviewResult 스키마 검증. 문제가 있으면 사람이 읽을 수 있는 오류 메시지 배열을 반환. */
export function validateReviewResultInput(parsed: unknown): {
  ok: boolean;
  errors: string[];
  value?: ReviewResult;
} {
  const errors: string[] = [];
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['최상위 값이 JSON 객체가 아닙니다.'] };
  }
  const p = parsed as Record<string, unknown>;

  // reviewed_files: non-empty array of strings
  if (!Array.isArray(p.reviewed_files) || p.reviewed_files.length === 0) {
    errors.push('reviewed_files는 비어 있지 않은 배열이어야 합니다.');
  } else if (!p.reviewed_files.every((f) => typeof f === 'string')) {
    errors.push('reviewed_files의 모든 항목은 문자열이어야 합니다.');
  }

  // category: string
  if (typeof p.category !== 'string') {
    errors.push('category는 문자열이어야 합니다.');
  }

  // findings: array of {file, issue, severity, optional line}
  if (!Array.isArray(p.findings)) {
    errors.push('findings는 배열이어야 합니다.');
  } else {
    p.findings.forEach((f, i) => {
      if (typeof f !== 'object' || f === null) {
        errors.push(`findings[${i}]가 객체가 아닙니다.`);
        return;
      }
      const finding = f as Record<string, unknown>;
      if (typeof finding.file !== 'string') {
        errors.push(`findings[${i}].file은 문자열이어야 합니다.`);
      }
      if (typeof finding.issue !== 'string') {
        errors.push(`findings[${i}].issue는 문자열이어야 합니다.`);
      }
      if (!VALID_SEVERITIES.includes(finding.severity as Severity)) {
        errors.push(
          `findings[${i}].severity는 ${VALID_SEVERITIES.join('|')} 중 하나여야 합니다 (입력: ${String(finding.severity)}).`,
        );
      }
      if (finding.line !== undefined && typeof finding.line !== 'number') {
        errors.push(`findings[${i}].line은 숫자여야 합니다.`);
      }
      // probe: high/medium finding은 프로브 증거(실행 명령 + 관찰 출력)를 반드시 포함해야 한다.
      //   low finding은 생략 가능. probe가 있으면 항상 문자열이어야 한다.
      if (finding.probe !== undefined && typeof finding.probe !== 'string') {
        errors.push(`findings[${i}].probe는 문자열이어야 합니다(실행 명령 + 관찰 출력).`);
      }
      if (finding.source !== undefined && finding.source !== 'codex') {
        errors.push(`findings[${i}].source can only be "codex" (a Codex second-opinion finding); leave it out for your own.`);
      }
      if (finding.severity === 'high' || finding.severity === 'medium') {
        if (typeof finding.probe !== 'string' || finding.probe.trim() === '') {
          errors.push(
            `findings[${i}](severity=${String(finding.severity)})에 probe 증거가 없습니다. ` +
              `high/medium finding은 실제 실행한 명령과 관찰된 출력을 probe 필드에 기록해야 합니다 (예: "echo '[{\\"text\\":\\"x\\"}]' > db.json; bun -e '...' → nextId=NaN").`,
          );
        }
      }
    });
  }

  // verdict
  if (!VALID_VERDICTS.includes(p.verdict as Verdict)) {
    errors.push(`verdict는 ${VALID_VERDICTS.join('|')} 중 하나여야 합니다 (입력: ${String(p.verdict)}).`);
  }

  // unknown_assumptions_checked: optional array, default []
  if (p.unknown_assumptions_checked !== undefined && !Array.isArray(p.unknown_assumptions_checked)) {
    errors.push('unknown_assumptions_checked는 배열이어야 합니다(생략 시 []로 채움).');
  }

  // dimensions_checked: optional string array, default []
  if (p.dimensions_checked !== undefined) {
    if (!Array.isArray(p.dimensions_checked)) {
      errors.push('dimensions_checked는 문자열 배열이어야 합니다(생략 시 []로 채움).');
    } else if (!p.dimensions_checked.every((d) => typeof d === 'string')) {
      errors.push('dimensions_checked의 모든 항목은 문자열이어야 합니다.');
    }
  }

  // codex: optional {status: ran|skipped, reason, output}; a skip says why (track G §10.8).
  if (p.codex !== undefined) {
    const c = p.codex as Record<string, unknown> | null;
    if (typeof c !== 'object' || c === null || (c.status !== 'ran' && c.status !== 'skipped')) {
      errors.push('codex must be {status: "ran" | "skipped", reason?, output?}.');
    } else if (c.status === 'skipped' && (typeof c.reason !== 'string' || c.reason.trim() === '')) {
      errors.push('codex.status "skipped" needs a reason (and the error output in codex.output).');
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // (E 보안) timestamp는 호출자 입력을 받지 않는다 — staleness 검사가 하한만 보므로
  //   미래 시각을 넘기면 이후 편집까지 "리뷰됨"이 되는 게이트 우회가 성립한다.
  //   호출자가 넘긴 값은 무시하고 항상 서버 시각을 기록한다(무시는 조용히: 리뷰
  //   에이전트 재시도 루프를 끊지 않기 위해 에러로 만들지 않는다).
  const timestamp = new Date().toISOString();

  const value: ReviewResult = {
    timestamp,
    reviewed_files: p.reviewed_files as string[],
    category: p.category as string,
    findings: p.findings as ReviewFinding[],
    unknown_assumptions_checked:
      (p.unknown_assumptions_checked as ReviewResult['unknown_assumptions_checked']) ?? [],
    verdict: p.verdict as Verdict,
    dimensions_checked: (p.dimensions_checked as string[]) ?? [],
  };
  if (p.codex !== undefined) value.codex = p.codex as ReviewResult['codex'];
  return { ok: true, errors: [], value };
}

/** ISO timestamp를 안전한 파일명으로 변환한다.
 *  ⚠️ timestamp는 리뷰 서브에이전트가 넣는 값(신뢰 불가)일 수 있다. 콜론만 치환하면
 *     `../`·`/` 같은 경로 문자가 통과해 reviews 디렉터리 밖으로 파일을 쓸 수 있다.
 *     → 콜론을 대시로 바꾼 뒤, 파일명에 안전한 화이트리스트([0-9A-Za-z._-]) 외 문자는 전부 '_'로 치환하고,
 *       선행 점(., .., ...)을 제거해 상위경로/숨김파일화를 막는다. 빈 값이면 안전한 기본값. */
/** 이미 있는 파일명이면 `-2`, `-3` … 을 붙여 비어 있는 경로를 고른다.
 *  축별 리뷰 에이전트를 **병렬로** 돌리면 같은 밀리초에 결과를 쓸 수 있어, 먼저 쓴 결과가
 *  조용히 덮어써지면 그 축의 dimensions_checked가 통째로 사라진다(차원 게이트가 오차단).
 *  후보를 다 쓰면 마지막 후보를 반환한다(무한 루프 방지). */
export function uniqueJsonPath(dir: string, base: string): string {
  let candidate = join(dir, `${base}.json`);
  for (let i = 2; i <= 50 && existsSync(candidate); i++) {
    candidate = join(dir, `${base}-${i}.json`);
  }
  return candidate;
}

export function timestampToFilename(ts: string): string {
  const safe = (typeof ts === 'string' ? ts : '')
    .replace(/:/g, '-')
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .replace(/^\.+/, '');
  return safe === '' ? 'review' : safe;
}

/** 입력 읽기: 파일 인자가 있으면 파일, 없으면 stdin. 비어 있으면 종료. */
async function readInput(fileArg: string | undefined, schemaName: string): Promise<string> {
  let raw: string;
  if (fileArg) {
    if (!existsSync(fileArg)) {
      fail(`입력 파일을 찾을 수 없습니다: ${fileArg}`);
    }
    try {
      raw = readFileSync(fileArg, 'utf8');
    } catch (err) {
      fail(`입력 파일 읽기 실패: ${fileArg} (${String(err)})`);
    }
  } else {
    raw = await readAllStdin();
  }
  if (raw.trim() === '') {
    fail(`입력이 비어 있습니다. ${schemaName} JSON을 stdin 또는 파일 인자로 전달하세요.`);
  }
  return raw;
}

async function cmdReviewWrite(cwd: string, args: string[]): Promise<void> {
  const raw = await readInput(args[0], 'ReviewResult');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`JSON 파싱 실패: ${String(err)}`);
  }

  const validated = validateReviewResultInput(parsed);
  if (!validated.ok || !validated.value) {
    fail('ReviewResult 스키마 검증 실패:\n' + validated.errors.map((e) => `  - ${e}`).join('\n'));
  }

  const result = validated.value;
  const reviewsDir = join(cwd, '.claude', 'reviews');
  ensureDir(reviewsDir);
  const outPath = uniqueJsonPath(reviewsDir, timestampToFilename(result.timestamp));
  // 방어적 컨테인먼트: 소독을 우회하는 특이 케이스 대비, 최종 경로가 reviewsDir 하위인지 확인.
  //   (timestampToFilename이 경로 구분자를 제거하므로 정상적으로는 항상 통과한다.)
  const resolvedReviews = resolve(reviewsDir);
  const resolvedOut = resolve(outPath);
  if (resolvedOut !== resolvedReviews && !resolvedOut.startsWith(resolvedReviews + sep)) {
    fail(`출력 경로가 reviews 디렉터리를 벗어납니다: ${resolvedOut}`);
  }
  writeJson(outPath, result);

  process.stdout.write(
    JSON.stringify({ ok: true, path: outPath, timestamp: result.timestamp }) + '\n',
  );
}

// ---- 명령: test-write ----

const VALID_ENV_MODES: TestEnvMode[] = ['container', 'local', 'none'];

/** TestEvidence 하나를 검증. label은 오류 메시지용(예: "acceptance[0].red"). */
function validateEvidenceInput(
  raw: unknown,
  label: string,
  errors: string[],
  opts: { requireExitCode: boolean },
): void {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`${label}는 {command, output, exit_code} 객체여야 합니다.`);
    return;
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.command !== 'string' || e.command.trim() === '') {
    errors.push(`${label}.command에 실제로 실행한 명령을 적어야 합니다.`);
  }
  if (typeof e.output !== 'string') {
    errors.push(`${label}.output에 관찰된 출력을 적어야 합니다.`);
  }
  if (opts.requireExitCode && typeof e.exit_code !== 'number') {
    errors.push(`${label}.exit_code(숫자)가 필요합니다 — 성공/실패를 종료 코드로 증명해야 합니다.`);
  }
}

/** TestResult 스키마 검증. 문제가 있으면 사람이 읽을 수 있는 오류 메시지 배열을 반환. */
export function validateTestResultInput(parsed: unknown): {
  ok: boolean;
  errors: string[];
  value?: TestResult;
} {
  const errors: string[] = [];
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: ['최상위 값이 JSON 객체가 아닙니다.'] };
  }
  const p = parsed as Record<string, unknown>;

  if (!Array.isArray(p.tested_files) || p.tested_files.length === 0) {
    errors.push('tested_files는 비어 있지 않은 배열이어야 합니다(이번 테스트가 커버하는 변경 파일).');
  } else if (!p.tested_files.every((f) => typeof f === 'string')) {
    errors.push('tested_files의 모든 항목은 문자열이어야 합니다.');
  }

  if (typeof p.category !== 'string') {
    errors.push('category는 문자열이어야 합니다.');
  }

  // A `blocked` result (track G): the tests could not run. It needs the commands and output
  //   that show why; it may name no test files, since none could run.
  const isBlocked = p.verdict === 'blocked';
  if (isBlocked) {
    const b = p.blocked as Record<string, unknown> | undefined;
    if (typeof b !== 'object' || b === null) {
      errors.push('verdict `blocked` needs blocked: {reason, evidence: [{command, output}]}.');
    } else {
      if (typeof b.reason !== 'string' || b.reason.trim().length < 15) {
        errors.push('blocked.reason must say why the tests cannot run (at least 15 characters).');
      }
      if (!Array.isArray(b.evidence) || b.evidence.length === 0) {
        errors.push('blocked.evidence must list the commands you ran and their output that show it.');
      } else {
        b.evidence.forEach((e, i) => validateEvidenceInput(e, `blocked.evidence[${i}]`, errors, { requireExitCode: false }));
        b.evidence.forEach((e, i) => {
          const o = (e as Record<string, unknown> | null)?.output;
          if (typeof o === 'string' && o.trim() === '') errors.push(`blocked.evidence[${i}].output is empty.`);
        });
      }
    }
  }

  // test_files: repo에 남는 테스트 자산. 존재까지 여기서 확인한다 —
  //   임시 디렉터리에 만들고 지운 프로브를 테스트로 위장하는 것을 쓰기 시점에 막는다.
  if (isBlocked && Array.isArray(p.test_files) && p.test_files.length === 0) {
    // none could run
  } else if (!Array.isArray(p.test_files) || p.test_files.length === 0) {
    errors.push(
      'test_files는 비어 있지 않은 배열이어야 합니다 — 층1 테스트는 repo에 남는 자산입니다(임시 프로브가 아님).',
    );
  } else {
    p.test_files.forEach((f, i) => {
      if (typeof f !== 'string' || f.trim() === '') {
        errors.push(`test_files[${i}]는 비어 있지 않은 문자열이어야 합니다.`);
        return;
      }
      if (!existsSync(f)) {
        errors.push(`test_files[${i}] 파일이 존재하지 않습니다: ${f}`);
      }
    });
  }

  // environment
  if (typeof p.environment !== 'object' || p.environment === null) {
    errors.push('environment는 {mode, command?, services?, evidence?} 객체여야 합니다.');
  } else {
    const env = p.environment as Record<string, unknown>;
    if (!VALID_ENV_MODES.includes(env.mode as TestEnvMode)) {
      errors.push(
        `environment.mode는 ${VALID_ENV_MODES.join('|')} 중 하나여야 합니다 (입력: ${String(env.mode)}).`,
      );
    }
  }

  // suites
  if (!Array.isArray(p.suites)) {
    errors.push('suites는 배열이어야 합니다.');
  } else {
    p.suites.forEach((s, i) => {
      if (typeof s !== 'object' || s === null) {
        errors.push(`suites[${i}]가 객체가 아닙니다.`);
        return;
      }
      const suite = s as Record<string, unknown>;
      if (typeof suite.name !== 'string') errors.push(`suites[${i}].name은 문자열이어야 합니다.`);
      if (typeof suite.command !== 'string') errors.push(`suites[${i}].command는 문자열이어야 합니다.`);
      if (typeof suite.passed !== 'number') errors.push(`suites[${i}].passed는 숫자여야 합니다.`);
      if (typeof suite.failed !== 'number') errors.push(`suites[${i}].failed는 숫자여야 합니다.`);
      if (typeof suite.output !== 'string') errors.push(`suites[${i}].output은 문자열이어야 합니다.`);
      // Per test type, the count and the time (track G §10.8): measured, not gated.
      if (!TEST_TYPES.includes(suite.type as TestType)) {
        errors.push(`suites[${i}].type must be one of ${TEST_TYPES.join('|')} (got ${String(suite.type)}).`);
      }
      if (typeof suite.duration_ms !== 'number' || !Number.isFinite(suite.duration_ms) || suite.duration_ms < 0) {
        errors.push(`suites[${i}].duration_ms must be the suite's wall time in milliseconds (a number ≥ 0).`);
      }
    });
  }

  // coverage: optional, from the project's own tool (measure-coverage); line and branch are
  //   never a gate, the changed lines are one (I1, lib/changed-coverage.ts).
  if (p.coverage !== undefined) validateCoverageInput(p.coverage, errors);

  // acceptance — red/green 증거는 여기가 1차 관문이다.
  if (!Array.isArray(p.acceptance)) {
    errors.push('acceptance는 배열이어야 합니다(생략 시 []).');
  } else {
    p.acceptance.forEach((a, i) => {
      if (typeof a !== 'object' || a === null) {
        errors.push(`acceptance[${i}]가 객체가 아닙니다.`);
        return;
      }
      const cov = a as Record<string, unknown>;
      if (typeof cov.id !== 'string' || cov.id.trim() === '') {
        errors.push(`acceptance[${i}].id는 비어 있지 않은 문자열이어야 합니다.`);
      }
      if (typeof cov.description !== 'string') {
        errors.push(`acceptance[${i}].description은 문자열이어야 합니다.`);
      }
      if (typeof cov.test !== 'string' || cov.test.trim() === '') {
        errors.push(`acceptance[${i}].test에 이 기준을 커버하는 테스트를 적어야 합니다.`);
      }
      validateEvidenceInput(cov.red, `acceptance[${i}].red`, errors, { requireExitCode: true });
      validateEvidenceInput(cov.green, `acceptance[${i}].green`, errors, { requireExitCode: true });
      if (cov.mutation !== undefined) {
        if (typeof cov.mutation !== 'object' || cov.mutation === null) {
          errors.push(`acceptance[${i}].mutation은 {command, output, detected} 객체여야 합니다.`);
        } else {
          const mut = cov.mutation as Record<string, unknown>;
          if (typeof mut.command !== 'string' || mut.command.trim() === '') {
            errors.push(`acceptance[${i}].mutation.command에 실행한 명령을 적어야 합니다.`);
          }
          if (typeof mut.output !== 'string') {
            errors.push(`acceptance[${i}].mutation.output은 문자열이어야 합니다.`);
          }
          if (typeof mut.detected !== 'boolean') {
            errors.push(
              `acceptance[${i}].mutation.detected는 boolean이어야 합니다(훼손 후 테스트가 실패했는가).`,
            );
          }
        }
      }
      // red가 성공(exit 0)이면 그 테스트는 아무것도 검증하지 않는다 — 쓰기 시점에 거부.
      const red = cov.red as Record<string, unknown> | undefined;
      if (red && typeof red.exit_code === 'number' && red.exit_code === 0) {
        errors.push(
          `acceptance[${i}].red가 성공(exit 0)입니다. 되돌린 상태에서 통과하는 테스트는 ` +
            `아무것도 검증하지 않습니다 — 실패하는 것을 먼저 보여야 합니다.`,
        );
      }
      const green = cov.green as Record<string, unknown> | undefined;
      if (green && typeof green.exit_code === 'number' && green.exit_code !== 0) {
        errors.push(`acceptance[${i}].green이 실패(exit ${String(green.exit_code)})입니다.`);
      }
    });
  }

  if (!VALID_TEST_VERDICTS.includes(p.verdict as TestVerdict)) {
    errors.push(`verdict는 ${VALID_TEST_VERDICTS.join('|')} 중 하나여야 합니다 (입력: ${String(p.verdict)}).`);
  }

  if (p.prototype_diff !== undefined) {
    if (typeof p.prototype_diff !== 'object' || p.prototype_diff === null) {
      errors.push('prototype_diff는 {prototype_path, mismatches} 객체여야 합니다.');
    } else {
      const pd = p.prototype_diff as Record<string, unknown>;
      if (typeof pd.prototype_path !== 'string') {
        errors.push('prototype_diff.prototype_path는 문자열이어야 합니다.');
      }
      if (!Array.isArray(pd.mismatches)) {
        errors.push('prototype_diff.mismatches는 배열이어야 합니다.');
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // review-write와 같은 이유로 timestamp는 호출자 입력을 무시하고 서버 시각을 쓴다
  //   (미래 시각을 넣으면 이후 편집까지 "테스트됨"이 되는 게이트 우회가 성립).
  const value: TestResult = {
    timestamp: new Date().toISOString(),
    tested_files: p.tested_files as string[],
    category: p.category as string,
    test_files: p.test_files as string[],
    environment: p.environment as TestResult['environment'],
    suites: (p.suites as TestResult['suites']) ?? [],
    acceptance: (p.acceptance as TestResult['acceptance']) ?? [],
    verdict: p.verdict as TestVerdict,
  };
  if (p.prototype_diff !== undefined) {
    value.prototype_diff = p.prototype_diff as TestResult['prototype_diff'];
  }
  if (isBlocked) value.blocked = p.blocked as TestResult['blocked'];
  if (p.coverage !== undefined) value.coverage = p.coverage as TestResult['coverage'];
  if (value.suites.length > 0) value.by_type = byTestType(value.suites);
  return { ok: true, errors: [], value };
}

const TEST_TYPES: TestType[] = ['unit', 'integration', 'ui', 'e2e'];

/** Per test type: how many suites and tests ran and how long they took. */
export function byTestType(suites: TestSuiteRun[]): NonNullable<TestResult['by_type']> {
  const out: NonNullable<TestResult['by_type']> = {};
  for (const s of suites) {
    if (!s.type) continue;
    const t = (out[s.type] ??= { suites: 0, tests: 0, duration_ms: 0 });
    t.suites++;
    t.tests += s.passed + s.failed;
    t.duration_ms += s.duration_ms ?? 0;
  }
  return out;
}

function validateCoverageInput(raw: unknown, errors: string[]): void {
  const c = raw as Record<string, unknown> | null;
  if (typeof c !== 'object' || c === null || (c.status !== 'measured' && c.status !== 'unavailable')) {
    errors.push('coverage must be {status: "measured" | "unavailable", …}.');
    return;
  }
  if (c.status === 'unavailable' && (typeof c.reason !== 'string' || c.reason.trim() === '')) {
    errors.push('coverage.status "unavailable" needs a reason (no tool, no report).');
  }
  for (const k of ['line_pct', 'branch_pct'] as const) {
    if (c[k] !== undefined && (typeof c[k] !== 'number' || (c[k] as number) < 0 || (c[k] as number) > 100)) {
      errors.push(`coverage.${k} must be a percentage from 0 to 100.`);
    }
  }
  if (c.changed !== undefined) {
    const ch = c.changed as Record<string, unknown> | null;
    const okNum = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
    if (typeof ch !== 'object' || ch === null || !okNum(ch.covered) || !okNum(ch.total) || (ch.covered as number) > (ch.total as number) || !Array.isArray(ch.files_without_executed_changes)) {
      errors.push('coverage.changed must be the whole `cli.ts diff-coverage` output: {covered, total, files_without_executed_changes, files, in_report, diff_lines, base}.');
      return;
    }
    // (I1) The per-file part the test gate reads.
    if (ch.files !== undefined) {
      const files = ch.files as Record<string, unknown> | null;
      const bad =
        typeof files !== 'object' || files === null || Array.isArray(files) ||
        Object.values(files).some((t) => {
          const v = t as Record<string, unknown> | null;
          return typeof v !== 'object' || v === null || !okNum(v.covered) || !okNum(v.total) || (v.covered as number) > (v.total as number);
        });
      if (bad) errors.push('coverage.changed.files must map each file to {covered, total} (whole numbers, covered ≤ total), as diff-coverage prints it.');
    }
    if (ch.in_report !== undefined && (!Array.isArray(ch.in_report) || ch.in_report.some((f) => typeof f !== 'string'))) {
      errors.push('coverage.changed.in_report must be the list of file paths diff-coverage prints.');
    }
    if (ch.diff_lines !== undefined) {
      const d = ch.diff_lines as Record<string, unknown> | null;
      if (typeof d !== 'object' || d === null || Array.isArray(d) || Object.values(d).some((n) => !okNum(n))) {
        errors.push('coverage.changed.diff_lines must map each file to its added lines (a whole number), as diff-coverage prints it.');
      }
    }
    if (ch.base !== undefined && (typeof ch.base !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(ch.base))) {
      errors.push('coverage.changed.base must be the object id diff-coverage prints.');
    }
  }
}

async function cmdTestWrite(cwd: string, args: string[]): Promise<void> {
  const raw = await readInput(args[0], 'TestResult');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`JSON 파싱 실패: ${String(err)}`);
  }

  const validated = validateTestResultInput(parsed);
  if (!validated.ok || !validated.value) {
    fail('TestResult 스키마 검증 실패:\n' + validated.errors.map((e) => `  - ${e}`).join('\n'));
  }

  const result = validated.value;
  // The tested content, taken here and never from the agent (lib/push-test.ts): the push
  //   test check matches a hand-off against `tree`.
  const state = workTreeState(cwd);
  result.commit = state.commit;
  result.tree = state.tree;
  const testsDir = join(cwd, '.claude', 'tests');
  ensureDir(testsDir);
  const outPath = uniqueJsonPath(testsDir, timestampToFilename(result.timestamp));
  const resolvedTests = resolve(testsDir);
  const resolvedOut = resolve(outPath);
  if (resolvedOut !== resolvedTests && !resolvedOut.startsWith(resolvedTests + sep)) {
    fail(`출력 경로가 tests 디렉터리를 벗어납니다: ${resolvedOut}`);
  }
  writeJson(outPath, result);
  // The project's test profile, for the tier advice (track H §14.7).
  recordTestProfile(knowledgeRoot(cwd).root, result.by_type, result.timestamp);

  process.stdout.write(
    JSON.stringify({ ok: true, path: outPath, timestamp: result.timestamp }) + '\n',
  );
  // A warning here; the test gate blocks on unrun changed lines (track I, lib/changed-coverage.ts).
  const idle = (result.coverage?.changed?.files_without_executed_changes ?? []).filter((f) => result.tested_files.includes(f));
  if (idle.length > 0) {
    process.stderr.write(`warning: no changed line of these tested files ran in the tests: ${idle.join(', ')}\n`);
  }
}

// ---- command: diff-coverage ----

/** `diff-coverage <report> [--base <rev>|empty]`: changed lines a coverage report saw executed. */
function cmdDiffCoverage(cwd: string, args: string[]): void {
  const report = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--base');
  const b = args.indexOf('--base');
  const base = b >= 0 ? args[b + 1] : undefined;
  if (!report) fail('usage: diff-coverage <coverage report> [--base <rev>|empty]');
  const out = diffCoverageOf(cwd, report, base);
  if ('error' in out) fail(out.error);
  process.stdout.write(JSON.stringify(out) + '\n');
}

// ---- 명령: acceptance-list ----

/** 이 프로젝트의 필수 수용 기준을 JSON으로 출력한다(테스트 에이전트가 커버 목록을 맞추는 데 사용). */
function cmdAcceptanceList(cwd: string): void {
  const artifacts = findDevCycleArtifacts(cwd);
  const criteria = requiredAcceptanceCriteria(cwd);
  const warnings: string[] = [];
  if (artifacts?.prototypePath) {
    try {
      warnings.push(...prototypeContractWarnings(readFileSync(artifacts.prototypePath, 'utf8')));
    } catch {
      // best-effort
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        dev_cycle: artifacts
          ? {
              version: artifacts.version,
              version_dir: artifacts.versionDir,
              prototype: artifacts.prototypePath,
              uiux: artifacts.uiuxPath,
            }
          : null,
        criteria,
        warnings,
      },
      null,
      2,
    ) + '\n',
  );
}

// ---- 명령: review-axes ----

/** 변경 파일 목록으로부터 띄워야 할 리뷰 축과 각 축이 채워야 할 차원을 출력한다.
 *  스킬이 "어떤 축을 병렬로 띄울지"를 눈대중이 아니라 결정적으로 정하게 한다. */
function cmdReviewAxes(cwd: string, args: string[]): void {
  const files = args.filter((a) => typeof a === 'string' && a.trim() !== '');
  const dims = requiredDimensionsFor(files);
  const axes = axesFor(files);
  // (H7) How many review runs: one for every axis when the diff is small.
  const changedLines = changedLineCount(cwd, files);
  const plan = reviewPlan(changedLines, axes.length);
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        files,
        changed_lines: changedLines,
        plan,
        plan_note: reviewPlanNote(plan, agentName(ROUTE.review)),
        required_dimensions: dims,
        // 축별로 "이번 변경에서 실제 요구되는 차원"만 남긴다 — 에이전트가 트리거되지 않은
        // 차원을 dimensions_checked에 적지 않도록.
        axes: axes.map((axis) => ({
          axis,
          dimensions: AXIS_DIMENSIONS[axis].filter((d) => dims.includes(d)),
        })),
      },
      null,
      2,
    ) + '\n',
  );
}

// ---- command: skill-gap (track G skill rule) ----

/** Records why no workflow skill fits the current change, so the skill rule lets main-session
 *  code edits go on; the note also goes to the persistent log for the monthly review. */
async function cmdSkillGap(cwd: string, args: string[]): Promise<void> {
  const i = args.indexOf('--session');
  const sessionId = i >= 0 ? (args[i + 1] ?? '').trim() : '';
  if (sessionId === '') fail('skill-gap: pass --session <session id> (the deny message prints it)');
  const raw = await readAllStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('skill-gap: stdin is not JSON. Shape: {"considered":[{"skill":"fix-bug","why_not":"..."}],"would_fit":"...","task":"..."}');
  }
  const res = validateSkillGapNote(parsed);
  if (!res.ok || !res.value) fail(`skill-gap: the note is incomplete:\n- ${res.errors.join('\n- ')}`);
  const ts = new Date().toISOString();
  recordSkillEvidence(sessionId, { k: 'skill-gap', t: Date.parse(ts), note: res.value });
  appendSkillGapLog({ ts, session: sessionId, cwd, note: res.value });
  process.stdout.write(JSON.stringify({ ok: true, recorded: ts }) + '\n');
}

// ---- main ----

const USAGE =
  '사용법: bun lib/cli.ts <command> [args...]\n' +
  '명령: review-write | test-write | acceptance-list | review-axes <파일...> | skill-gap --session <id> | diff-coverage <report> [--base <rev>|empty] | knowledge-check | decisions | test-catalog';

async function main(): Promise<void> {
  const cwd = process.cwd();
  const command = process.argv[2];
  const args = process.argv.slice(3);

  if (!command) {
    fail(USAGE);
  }

  try {
    switch (command) {
      case 'review-write':
        await cmdReviewWrite(cwd, args);
        break;
      case 'test-write':
        await cmdTestWrite(cwd, args);
        break;
      case 'acceptance-list':
        cmdAcceptanceList(cwd);
        break;
      case 'review-axes':
        cmdReviewAxes(cwd, args);
        break;
      case 'skill-gap':
        await cmdSkillGap(cwd, args);
        break;
      case 'diff-coverage':
        cmdDiffCoverage(cwd, args);
        break;
      case 'knowledge-check': {
        // The keep-project-knowledge skill's done criteria (track H §14.3).
        const problems = validateKnowledge(knowledgeRoot(cwd).root);
        process.stdout.write(JSON.stringify(problems.length === 0 ? { ok: true } : { ok: false, problems }) + '\n');
        if (problems.length > 0) process.exitCode = 1;
        break;
      }
      case 'decisions':
        // Every ai and human check for this cwd: the defaults and the policy entries (§14.4).
        process.stdout.write(JSON.stringify({ root: knowledgeRoot(cwd).root, items: decisionItems(cwd) }) + '\n');
        break;
      case 'test-catalog': {
        // Writes .goodboy/test-catalog.md, feature → test type, from the test files (§14.5).
        const root = knowledgeRoot(cwd).root;
        const rows = catalogRows(root);
        // Never overwrite a catalog with an empty one because git could not list the files.
        if (rows === null) fail(`test-catalog: git cannot list the test files in ${root} (not a repo, or git is missing)`);
        mkdirSync(join(root, '.goodboy'), { recursive: true });
        writeFileSync(join(root, TEST_CATALOG_FILE), renderCatalog(rows));
        process.stdout.write(JSON.stringify({ ok: true, path: join(root, TEST_CATALOG_FILE), files: rows.length }) + '\n');
        break;
      }
      default:
        fail(`알 수 없는 명령: ${command}\n${USAGE}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`오류: ${msg}`);
  }
}

// 직접 실행될 때만 main()을 호출한다. (테스트 등에서 import 시 부작용 방지)
if (import.meta.main) {
  main().catch((err) => {
    fail(`오류: ${err instanceof Error ? err.message : String(err)}`);
  });
}
