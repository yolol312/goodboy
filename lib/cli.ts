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
import { isAbsolute, join, resolve, sep } from 'node:path';
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
import { topOf, treeDiff, workTreeState } from './push-test';
import { cliProjectDir } from './project-dir';
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, outputSummary, type RegressionRecord, regressionCommands, runCommands, writeRegressionRecord } from './regression';
import { diffCoverageOf } from './diff-coverage';
import { criteriaNow } from './session-criteria';
import { requiresMutationProbe } from './test-validator';
import { knowledgeRoot, validateKnowledge } from './project-knowledge';
import { decisionItems } from './decision-authority';
import { catalogRows, renderCatalog, TEST_CATALOG_FILE } from './test-catalog';
import { recordTestProfile } from './test-profile';
import { changedLineCount, realish, reviewPlan, reviewPlanNote } from './review-scope';
import { agentName, ROUTE } from './routing-policy';
import { findDevCycleArtifacts, prototypeContractWarnings, readAcceptance, VERIFY_STAGE } from './acceptance';
import { AXIS_DIMENSIONS, axesFor, requiredDimensionsFor } from './review-dimensions';
import { MAX_DOC_BYTES, readRegular } from './safe-read';
import { appendSkillGapLog, recordSkillEvidence, validateSkillGapNote } from './skill-rule';
import { collectEvidence, findSession, inboxDir, listInbox, markFiled, markTriaged, privateTerms, publicLeaks, publishProblems, REPORT_REPO, REPORT_TITLE_TAG, validateFieldReport, writeFieldReport } from './field-report';
import {
  abortRun,
  beginRun,
  changelogRange,
  checkedCheckupDir,
  claudeConfigDir,
  completeRun,
  limitFindings,
  makeRunDir,
  MAX_RUN_FILE_BYTES,
  newRunId,
  noteRange,
  parseChangelog,
  readChangelogCache,
  readCheckupState,
  runFileTarget,
  runningCliVersion,
  setProject,
  triageChangelog,
  updateCheckupState,
  writeRunFile,
} from './checkup';
import { compareRuns, comparisonSummary } from './compare';
import { checkHealth, fitHealth, healthSummary } from './health';
import { allIdentifiers, buildInventory, fitInventory, inventoryLists, inventorySummary, projectRoots, suggestProjects } from './inventory';
import { fitProbes, probeEstimate, probesSummary, runProbes } from './probes';
import { GOODBOY_CASES, readUserCases, runSmoke, smokeSummary } from './smoke';
import { surveyProject } from './test-survey';
import { BACKFILL_FILE, backfillSummary, DEFAULT_BATCH, markTarget, MAX_TARGETS, mergeSurvey, nextBatch, readBackfill, repoRel, type TargetStatus, withBackfillLock, writeBackfill } from './test-backfill';
import { repoTop } from './changed-coverage';

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

/** goodboy's own directory: the parent of lib/. */
const GOODBOY_ROOT = resolve(import.meta.dir, '..');

/** (#14) A result written from inside goodboy's own directory for files elsewhere: agents ran
 *  `cd <plugin root> && bun lib/cli.ts review-write`, and the record landed where no gate of the
 *  project reads it (second real-use trial). Any cwd under the plugin root counts (an installed
 *  plugin's directory is no git repo). Returns the first such file, or null. */
export function recordOutsideRepo(cwd: string, files: readonly unknown[]): string | null {
  const root = realish(GOODBOY_ROOT);
  const here = realish(resolve(cwd));
  if (here !== root && !here.startsWith(root + sep)) return null;
  for (const f of files) {
    if (typeof f !== 'string' || f === '') continue;
    const abs = resolve(cwd, f);
    const p = realish(abs);
    if (p !== root && !p.startsWith(root + sep)) return f;
    // A relative name that is no goodboy file is another project's (`src/a.ts`).
    if (!isAbsolute(f) && !existsSync(abs)) return f;
  }
  return null;
}

function failOutsideRepo(cmd: string, file: string): never {
  fail(
    `${cmd}: ${file} is outside goodboy's own directory, where this command runs. ` +
      `Run \`bun "<goodboy>/lib/cli.ts" ${cmd}\` from the project's directory (cd there first); the gates read results there.`,
  );
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
  const outside = recordOutsideRepo(cwd, result.reviewed_files ?? []);
  if (outside !== null) failOutsideRepo('review-write', outside);
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
          // (I2) A product criterion's probe names the product file it broke (never a document).
          const fileBad =
            mut.file !== undefined
              ? typeof mut.file !== 'string' || mut.file.trim() === '' || isAbsolute(mut.file)
              : requiresMutationProbe(String(cov.id ?? ''));
          if (fileBad) {
            errors.push(
              `acceptance[${i}].mutation.file must be the repo-relative path of the file the probe broke (in its ` +
                'scratch copy: the path that file has in this repo). For a PT-* or UIUX-* criterion it is required and is ' +
                'product code, never a document such as the requirements or the prototype.',
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
  // (#23) Changed files the tests run only as a subprocess, which the coverage tool cannot see.
  if (c.subprocess !== undefined) {
    const s = c.subprocess as unknown[];
    if (
      !Array.isArray(s) ||
      s.some((e) => {
        const v = e as Record<string, unknown> | null;
        return typeof v !== 'object' || v === null || typeof v.file !== 'string' || v.file.trim() === '' || typeof v.test !== 'string' || v.test.trim() === '';
      })
    ) {
      errors.push('coverage.subprocess must be a list of {file, test}: a changed file (repo-relative) and the test file that runs it as a process.');
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
  const outside = recordOutsideRepo(cwd, result.tested_files ?? []);
  if (outside !== null) failOutsideRepo('test-write', outside);
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

// ---- command: regression (track I, I4) ----

/** `regression [--timeout-min <n>]`: runs the project's whole test command from the repo top
 *  and records it under the cwd (lib/regression.ts). The agent supplies nothing but the call
 *  (a timeout can only make a run fail): goodboy picks the commands, times them and takes the
 *  tree. A run that changes the working tree fails. Exit 0 on a pass, 1 otherwise. */
async function cmdRegression(cwd: string, args: string[]): Promise<void> {
  const t = args.indexOf('--timeout-min');
  const minutes = t >= 0 ? Number(args[t + 1]) : NaN;
  const timeoutMs = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes * 60_000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  const top = topOf(cwd);
  if (top === null) fail('regression: not inside a git repository; the push check compares git trees.');
  const found = regressionCommands(top);
  if (found === null) {
    fail(
      'regression: goodboy found no whole-suite test command (package.json scripts.test or scripts.test:all, ' +
        'pytest, go.mod, Cargo.toml, Gradle, Maven, a Makefile test target). Record a `blocked` result with this output and tell the user.',
    );
  }
  const before = workTreeState(top);
  if (before.tree === null) fail('regression: git could not hash the working tree.');
  const timestamp = new Date().toISOString();
  const t0 = Date.now();
  const runs = await runCommands(top, found.commands, timeoutMs);
  const after = workTreeState(top);
  const changed = after.tree !== before.tree;
  const rec: RegressionRecord = {
    timestamp,
    commit: before.commit,
    tree: before.tree,
    tree_after: after.tree,
    ...(changed ? { changed_files: (after.tree ? (treeDiff(top, before.tree, after.tree) ?? []) : []).slice(0, 50) } : {}),
    source: found.source,
    runs,
    duration_ms: Date.now() - t0,
    verdict: runs.every((r) => r.exit_code === 0) && !changed ? 'pass' : 'fail',
  };
  const path = writeRegressionRecord(cwd, rec);
  process.stdout.write(
    JSON.stringify({ ok: rec.verdict === 'pass', path, verdict: rec.verdict, source: rec.source, commands: found.commands, duration_ms: rec.duration_ms, tree: rec.tree }) + '\n',
  );
  const bad = runs.find((r) => r.exit_code !== 0);
  if (bad) process.stderr.write(`regression failed: \`${bad.command}\` exited ${bad.exit_code}\n${outputSummary(bad.output_tail, 1500, 500)}\n`);
  if (changed) {
    process.stderr.write(
      `regression failed: the run changed the working tree (${(rec.changed_files ?? []).slice(0, 10).join(', ') || 'unknown files'}), ` +
        'so it proves neither tree. Ignore what the tests generate (e.g. coverage/) or commit it, then run again.\n',
    );
  }
  if (rec.verdict !== 'pass') process.exit(1);
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
  // (I2) Plus the requirements in progress. The rest of the session's criteria (rows done or
  //   policy lines added since its start) need the session's pin: the gate's message lists them.
  const reading = readAcceptance(cwd);
  const criteria = [...reading.criteria, ...criteriaNow(cwd)];
  const warnings: string[] = [];
  // (I11, #20) Before the verification stage the UI criteria are pending: the gate lists them
  //   without blocking when the session also started before it.
  if (reading.uiPending) {
    warnings.push(`UIUX-*/PT-* criteria are pending until dev-cycle stage ${VERIFY_STAGE} (verification): test them as their screens get product code.`);
  }
  if (artifacts?.prototypePath) {
    // Not a plain read: a FIFO there hung acceptance-list (I2 refactoring review round 4).
    const read = readRegular(artifacts.prototypePath, MAX_DOC_BYTES);
    try {
      if (typeof read !== 'string') warnings.push(...prototypeContractWarnings(read.text));
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

// ---- commands: report-evidence, report-write (track J1, #8) ----

/** `--session <id or tag>` and the other words of `args`. */
function sessionOpt(args: string[]): { session?: string; rest: string[] } {
  const i = args.indexOf('--session');
  if (i < 0) return { rest: args };
  const session = (args[i + 1] ?? '').trim();
  if (!/^[0-9a-f-]{8,36}$/.test(session)) fail('--session takes a session id or its 8-character tag');
  return { session, rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/** Prints what goodboy recorded about the session (the newest one of this dir by default). */
function cmdReportEvidence(cwd: string, args: string[]): void {
  const { session, rest } = sessionOpt(args);
  const s = findSession(cwd, session);
  if (session && !s) fail(`report-evidence: no session ${session} for this directory`);
  const ev = collectEvidence(s, GOODBOY_ROOT);
  // `--public`: only what may go into a public issue (versions and goodboy's counts), never the
  //   gate-log lines, whose reasons hold paths and commands (J2 review: the issue form).
  const out = rest.includes('--public')
    ? { goodboy_version: ev.goodboy_version, claude_code_version: ev.claude_code_version, gate_counts: ev.gate_counts, retries: ev.retries }
    : ev;
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

/** Records the user's filing choice in a report: `report-filed <file> --issue <url>` or
 *  `report-filed <file> --local`. */
function cmdReportFiled(args: string[]): void {
  const i = args.indexOf('--issue');
  const file = args.find((a, k) => !a.startsWith('--') && (i < 0 || k !== i + 1));
  const local = args.includes('--local');
  if (!file || (i < 0) === !local) fail('report-filed: pass <report .json> and either --issue <https://github.com/yolol312/goodboy/issues/N> or --local');
  process.stdout.write(JSON.stringify({ ok: true, path: markFiled(file, local ? { local: true } : { issue: args[i + 1] ?? '' }) }) + '\n');
}

/** Writes a field report to the inbox with the session's evidence, after checking the public
 *  summary for the user's paths, names, hosts and secrets. */
async function cmdReportWrite(cwd: string, args: string[], shell: string = cwd): Promise<void> {
  const { session, rest } = sessionOpt(args);
  let raw: string;
  if (rest[0]) {
    // A FIFO or a device as the file is refused, never waited on (J1 review).
    const r = readRegular(resolve(shell, rest[0]), 1024 * 1024);
    if (typeof r !== 'object') fail(`report-write: ${rest[0]} is missing, not a regular file, or over 1 MB`);
    raw = r.text;
  } else raw = await readAllStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('report-write: the input is not JSON (see the report-goodboy skill for the template)');
  }
  const res = validateFieldReport(parsed);
  if (!res.ok || !res.value) fail(`report-write: the report does not follow the template:\n- ${res.errors.join('\n- ')}`);
  const s = findSession(cwd, session);
  if (session && !s) fail(`report-write: no session ${session} for this directory`);
  const ev = collectEvidence(s, GOODBOY_ROOT);
  // The model's text only: goodboy's own lines (versions, gate names) are not the user's, and
  //   a repo named like one of them could never pass (J1 review).
  const leaks = publicLeaks(`${res.value.public_summary.title}\n${res.value.public_summary.body}`, privateTerms(cwd));
  if (leaks.length > 0) {
    fail(`report-write: the public summary names private details; remove each one (describe it generically, never respell it):\n- ${leaks.join('\n- ')}`);
  }
  const out = writeFieldReport(res.value, ev, { cwd, root: GOODBOY_ROOT });
  process.stdout.write(
    JSON.stringify({ ok: true, path: out.path, public_path: out.publicPath, issue_title: `${REPORT_TITLE_TAG} ${res.value.public_summary.title}`, repo: REPORT_REPO, evidence: { goodboy: ev.goodboy_version, claude_code: ev.claude_code_version, session: ev.session } }) + '\n',
  );
}

// ---- commands: report-list, report-done (track J2, #9; the triage-reports skill) ----

/** Moves a triaged report to the inbox's `done/` with the decision: `report-done <file>
 *  --decision "<where it went>"`. */
async function cmdReportDone(args: string[]): Promise<void> {
  const i = args.indexOf('--decision');
  let decision = i >= 0 ? (args[i + 1] ?? '') : '';
  const file = args.find((a, k) => !a.startsWith('--') && (i < 0 || k !== i + 1));
  // `--decision -` reads it from stdin, so quoted issue text never meets the shell (J2 review).
  if (decision === '-') decision = await readAllStdin();
  if (!file || decision.trim() === '') fail("report-done: pass <report .json> --decision - <<'EOF' (where it went: a plan step, an issue URL, deferred or rejected with the reason) EOF");
  process.stdout.write(JSON.stringify({ ok: true, path: markTriaged(file, decision) }) + '\n');
}

// ---- commands: checkup-* (track K1, #10; the cli-update-check skill) ----

/** Stdin as text, failing as soon as it passes `max` bytes instead of buffering it all. */
async function readStdinCapped(max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk as Uint8Array);
    n += b.length;
    if (n > max) fail(`the input is larger than ${max} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The value after `--name`, or undefined. */
function optValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** `--name N` as an integer from `min` to `max`, else `fallback`. */
function intOpt(args: string[], name: string, fallback: number, min: number, max: number): number {
  const v = optValue(args, name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** `test-survey [--all | --dir <dir>] [--max N]` (track L, L1): read-only. The project, a dir
 *  (from the shell's dir, like every file argument), or with `--all` the project and the
 *  checkup's registered projects (§17). */
function cmdTestSurvey(cwd: string, shell: string, args: string[]): void {
  const all = args.includes('--all');
  const dir = optValue(args, '--dir');
  const max = intOpt(args, '--max', all ? 10 : 30, 0, 1000);
  if (all && dir !== undefined) fail('test-survey: pass --all or --dir, not both');
  if (!all) {
    if (dir !== undefined && (dir === '' || dir.startsWith('--'))) fail('test-survey: --dir needs a directory');
    process.stdout.write(JSON.stringify(surveyProject(repoTop(dir === undefined ? cwd : resolve(shell, dir)), max), null, 2) + '\n');
    return;
  }
  // Never made here: a missing checkup dir means nothing is registered.
  const checkups = checkedCheckupDir(process.env, false);
  const { roots, problems } = projectRoots(cwd, checkups ? (readCheckupState(checkups).projects ?? []) : []);
  process.stdout.write(JSON.stringify({ projects: roots.map((r) => surveyProject(r, max)), problems }, null, 2) + '\n');
}

/** The backfill commands (track L, L3): `backfill-plan`, `backfill-next [--size N] [--pick
 *  a,b]`, `backfill-mark <file> --status done|skipped|suspect [--tests a,b] [--note text]`,
 *  `backfill-status`. The state is the repo's `.goodboy/test-backfill.json`, read and written
 *  under its lock (never left held: errors return, `fail` exits after); the evidence is the
 *  project dir's layer-1 records. */
function cmdBackfill(command: string, cwd: string, args: string[]): void {
  const root = repoTop(cwd);
  const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (command === 'backfill-mark') {
    const status = optValue(args, '--status');
    if (!args[0] || args[0].startsWith('--') || (status !== 'done' && status !== 'skipped' && status !== 'suspect')) {
      fail('backfill-mark: pass <file> --status done|skipped|suspect [--tests a,b] [--note text]');
    }
  }
  if (command === 'backfill-next' && !existsSync(join(root, BACKFILL_FILE))) fail('backfill-next: no backfill state; run backfill-plan first');
  // The survey reads the whole repo: before the lock, so that marks are not held up by it.
  const survey = command === 'backfill-plan' ? surveyProject(root, MAX_TARGETS) : null;
  if (survey?.problems.some((p) => p.startsWith('not a git repository') || p.startsWith('git cannot list'))) fail(`backfill-plan: ${survey.problems.join('; ')}`);
  const result = withBackfillLock(root, (): { error: string } | { value: unknown } => {
    const state = readBackfill(root);
    if (state instanceof Error) return { error: state.message };
    switch (command) {
      case 'backfill-plan': {
        const { state: next, added, dropped } = mergeSurvey(state, survey!.untested.targets);
        const path = writeBackfill(root, next);
        return { value: { path, added, dropped, survey: { ...survey!, untested: { count: survey!.untested.count, targets: survey!.untested.targets.slice(0, 10) } }, ...backfillSummary(next) } };
      }
      case 'backfill-next': {
        const b = nextBatch(state, intOpt(args, '--size', DEFAULT_BATCH, 1, 20), list(optValue(args, '--pick')).map((f) => repoRel(root, f)));
        if (b instanceof Error) return { error: b.message };
        if (!b.resumed) writeBackfill(root, state);
        return { value: b };
      }
      case 'backfill-mark': {
        const m = { rel: args[0]!, status: optValue(args, '--status') as Exclude<TargetStatus, 'todo'>, tests: list(optValue(args, '--tests')), note: optValue(args, '--note') };
        const err = markTarget(state, cwd, root, m);
        if (err) return { error: err.message };
        writeBackfill(root, state);
        return { value: backfillSummary(state) };
      }
      default:
        return { value: backfillSummary(state) };
    }
  });
  if ('error' in result) fail(`${command}: ${result.error}`);
  process.stdout.write(JSON.stringify(result.value, null, 2) + '\n');
}

/** The checkup commands: state, begin, changelog, write, complete, abort (lib/checkup.ts). */
async function cmdCheckup(command: string, args: string[]): Promise<void> {
  const out = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  const dir = checkedCheckupDir();
  if (dir === null) fail(`${command}: no checkup dir`);
  const run = optValue(args, '--run');
  // The Claude Code session that runs the checkup: a pending run of another session is not
  //   replaced unless `--replace`, and only its own session completes it (K1a review: the
  //   begin process's pid ends at once).
  const session = (process.env.CLAUDE_CODE_SESSION_ID ?? '').trim() || null;
  switch (command) {
    case 'checkup-state':
      out({ dir, state: readCheckupState(dir) });
      return;
    case 'checkup-begin': {
      // `--cli <version>` for tests; else the running CLI's own `claude --version`.
      const cli = optValue(args, '--cli') ?? runningCliVersion();
      if (!cli) fail('checkup-begin: cannot read the CLI version (`claude --version`); pass --cli <version>');
      const id = newRunId();
      let replaced: string | null = null;
      const s = updateCheckupState(dir, (st) => {
        replaced = st.pending?.run ?? null;
        return beginRun(st, cli, id, new Date(), session, args.includes('--replace'));
      });
      const runDir = makeRunDir(dir, id);
      out({ run: id, run_dir: runDir, from: s.lastChecked?.cli ?? null, to: s.pending?.cli, replaced, last_range: s.lastChecked?.range ?? null });
      return;
    }
    case 'checkup-changelog': {
      const s = readCheckupState(dir);
      const fromArg = optValue(args, '--from');
      const from = fromArg === undefined ? (s.lastChecked?.cli ?? null) : fromArg === 'none' ? null : fromArg;
      const to = optValue(args, '--to') ?? s.pending?.cli ?? s.observed?.cli;
      if (!to) fail('checkup-changelog: pass --to <version> or begin a run first');
      const path = optValue(args, '--changelog') ?? join(claudeConfigDir(), 'cache', 'changelog.md');
      const text = readChangelogCache(path);
      const range = changelogRange(text === null ? [] : parseChangelog(text), from, to);
      const ids = (optValue(args, '--ids') ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');
      // `--inventory`: the identifiers the user's customizations use (K1b).
      if (args.includes('--inventory')) ids.push(...allIdentifiers(buildInventory(process.cwd(), process.env, s.projects ?? []).identifiers));
      const triage = triageChangelog(range.sections, ids);
      const limit = (name: string, dflt: number) => {
        const n = Number(optValue(args, name) ?? dflt);
        return Number.isInteger(n) && n >= 0 ? n : dflt;
      };
      const { listed, left_out } = limitFindings(triage.findings, limit('--max-matched', 200), limit('--max-unmapped', 50));
      // `--run`: the listed findings also go to the run dir for the report (K1d); checked
      //   before the state is touched.
      const target = run ? optValue(args, '--name') ?? 'changelog.json' : null;
      if (run && target) runFileTarget(dir, run, target);
      // The pending run's own range is noted in the state: completing the run keeps it, so a
      //   run completed over a gap says so to the next one (K1a review).
      const p = s.pending;
      if (p && range.to === p.cli && range.from === (s.lastChecked?.cli ?? null)) {
        try {
          updateCheckupState(dir, (st) => noteRange(st, p.run, range, session));
        } catch (err) {
          // Another session's run: its own changelog step notes its range.
          if (!/another session/.test(String(err))) throw err;
        }
      }
      const result = {
        changelog: path,
        status: range.status,
        from: range.from,
        to: range.to,
        gaps: range.gaps,
        previous_range: s.lastChecked?.range ?? null,
        versions: range.sections.map((x) => x.version),
        counts: triage.counts,
        left_out,
        findings: listed,
      };
      const written = run && target ? writeRunFile(dir, run, target, JSON.stringify(result) + '\n') : null;
      out({ ...result, ...(written ? { written } : {}) });
      return;
    }
    case 'checkup-write': {
      const name = optValue(args, '--name');
      if (!run || !name) fail("checkup-write: pass --run <id> --name <file.md|.json|.txt> <<'EOF' … EOF");
      // Every check before stdin is read, and stdin read only up to the cap (K1a review).
      runFileTarget(dir, run, name);
      out({ ok: true, path: writeRunFile(dir, run, name, await readStdinCapped(MAX_RUN_FILE_BYTES)) });
      return;
    }
    case 'checkup-projects': {
      // The registered projects the inventory scans besides the current one.
      const addP = optValue(args, '--add');
      const removeP = optValue(args, '--remove');
      const s = addP || removeP ? updateCheckupState(dir, (st) => setProject(st, (addP ?? removeP)!, addP !== undefined)) : readCheckupState(dir);
      // `--suggest`: projects Claude Code knows that have customizations, for the user to
      //   choose from; never registered or scanned here (K1d).
      const sug = args.includes('--suggest') ? suggestProjects(process.env, s.projects ?? [], projectRoots(process.cwd(), []).current) : null;
      out({ projects: s.projects ?? [], ...(sug ? { suggested: sug.suggested, more_suggested: sug.more, problems: sug.problems } : {}) });
      return;
    }
    case 'checkup-inventory': {
      // The whole inventory goes to the run dir (`--run`); the model sees the summary and
      //   capped lists only.
      const inv = buildInventory(process.cwd(), process.env, readCheckupState(dir).projects ?? []);
      const fit = run ? fitInventory(inv, MAX_RUN_FILE_BYTES - 1) : inv;
      const path = run ? writeRunFile(dir, run, optValue(args, '--name') ?? 'inventory.json', JSON.stringify(fit) + '\n') : null;
      out({ ...inventorySummary({ ...inv, problems: fit.problems }), ...(path ? { written: path } : {}), ...inventoryLists(inv) });
      return;
    }
    case 'checkup-health': {
      // Claude Code's own checks with zero model turns; the whole result goes to the run dir.
      //   A wrong run id fails before anything runs (K1c review).
      const name = optValue(args, '--name') ?? 'health.json';
      if (run) runFileTarget(dir, run, name);
      const t = Number(optValue(args, '--timeout-ms') ?? 60_000);
      const h = await checkHealth(process.cwd(), { timeoutMs: Number.isInteger(t) && t >= 1000 ? t : 60_000, cli: readCheckupState(dir).pending?.cli ?? null });
      const path = run ? writeRunFile(dir, run, name, JSON.stringify(fitHealth(h, MAX_RUN_FILE_BYTES - 1)) + '\n') : null;
      out({ ...healthSummary(h), ...(path ? { written: path } : {}), problems: h.problems.slice(0, 30) });
      return;
    }
    case 'checkup-smoke': {
      // goodboy's own cases, then the user's from smoke.json in the checkup dir, each in a
      //   sandbox of its own.
      const name = optValue(args, '--name') ?? 'smoke-results.json';
      if (run) runFileTarget(dir, run, name);
      const user = readUserCases(dir);
      const results = await runSmoke([...GOODBOY_CASES, ...user.cases], run ?? newRunId(), GOODBOY_ROOT);
      const path = run ? writeRunFile(dir, run, name, JSON.stringify({ results, problems: user.problems }) + '\n') : null;
      out({ ...smokeSummary(results, user.problems), ...(path ? { written: path } : {}) });
      return;
    }
    case 'checkup-compare': {
      // This run's problems against the last completed run's: new, persisting, resolved, or
      //   baseline when there is nothing of the same step to compare with (K1d).
      if (!run) fail('checkup-compare: pass --run <id>');
      const name = optValue(args, '--name') ?? 'compare.json';
      runFileTarget(dir, run, name);
      const last = readCheckupState(dir).lastChecked?.run ?? null;
      const c = compareRuns(dir, run, last === run ? null : last);
      const path = writeRunFile(dir, run, name, JSON.stringify(c) + '\n');
      out({ ...comparisonSummary(c), written: path });
      return;
    }
    case 'checkup-probe': {
      // Integration sessions make model turns: `--estimate` shows what they run and cost; they
      //   run only with that estimate's id, after the user approved it (K1d).
      if (!run) fail('checkup-probe: pass --run <id> (--estimate, or --estimate-id <id> after the user approved it)');
      const name = optValue(args, '--name') ?? 'probes.json';
      const target = runFileTarget(dir, run, name);
      const inv = buildInventory(process.cwd(), process.env, readCheckupState(dir).projects ?? []);
      const est = probeEstimate(run, inv);
      if (args.includes('--estimate')) {
        out(est);
        return;
      }
      const given = optValue(args, '--estimate-id');
      if (!given) fail('checkup-probe: run --estimate first, show it to the user, and pass --estimate-id <id> only after they approved it');
      // The new id is never printed here: an id comes only from an estimate the user is shown
      //   (K1d review: the refusal handed out the id that passes the gate).
      if (given !== est.id) fail('checkup-probe: the estimate changed since the user approved it; run --estimate again and ask the user');
      // The probes ran already for this run: running them again would pay for them twice and
      //   then fail to write (K1d review). Two runs started at once both pass this check; the
      //   skill starts one and waits for it.
      if (existsSync(target)) fail(`checkup-probe: ${name} exists for this run; the probes ran already (a new checkup run probes again)`);
      const p = fitProbes(await runProbes(inv, est), MAX_RUN_FILE_BYTES - 1);
      try {
        out({ ...probesSummary(p), written: writeRunFile(dir, run, name, JSON.stringify(p) + '\n') });
      } catch (err) {
        // The sessions were paid for: print what they found even when the file cannot be written.
        out({ ...probesSummary(p), write_error: err instanceof Error ? err.message : String(err) });
        process.exitCode = 1;
      }
      return;
    }
    case 'checkup-complete':
      if (!run) fail('checkup-complete: pass --run <id>');
      out({ ok: true, state: updateCheckupState(dir, (st) => completeRun(st, run, new Date(), session)) });
      return;
    case 'checkup-abort':
      if (!run) fail('checkup-abort: pass --run <id>');
      out({ ok: true, state: updateCheckupState(dir, (st) => abortRun(st, run)) });
      return;
  }
}

// ---- main ----

const USAGE =
  '사용법: bun lib/cli.ts <command> [args...]\n' +
  '명령: review-write | test-write | regression | acceptance-list | review-axes <파일...> | skill-gap --session <id> | diff-coverage <report> [--base <rev>|empty] | knowledge-check | decisions | test-catalog | test-survey [--all | --dir <dir>] [--max N] | backfill-plan | backfill-next [--size N] [--pick a,b] | backfill-mark <file> --status done|skipped|suspect [--tests a,b] [--note text] | backfill-status | report-evidence [--session <id>] | report-write [--session <id>] [file] | report-list | report-filed <file> (--issue <url>|--local) | report-done <file> --decision <text> | checkup-state | checkup-begin [--cli <v>] [--replace] | checkup-changelog [--from <v>|none] [--to <v>] [--ids a,b] [--changelog <path>] [--max-matched N] [--max-unmapped N] [--run <id>] | checkup-write --run <id> --name <file> | checkup-complete --run <id> | checkup-abort --run <id> | checkup-projects [--add <dir>|--remove <dir>] [--suggest] | checkup-inventory [--run <id>] (checkup-changelog --inventory adds its identifiers) | checkup-health [--run <id>] [--timeout-ms N] | checkup-smoke [--run <id>] | checkup-compare --run <id> | checkup-probe --run <id> (--estimate | --estimate-id <id>)';

async function main(): Promise<void> {
  // The session's project dir, not the shell's dir after a `cd`: the records written here are
  //   read by the hooks from there (I10). A file named on the command line still resolves
  //   from the shell's dir (I10 review 2).
  const shell = process.cwd();
  const cwd = cliProjectDir(shell);
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
      case 'regression':
        await cmdRegression(cwd, args);
        break;
      case 'acceptance-list':
        cmdAcceptanceList(cwd);
        break;
      case 'review-axes':
        cmdReviewAxes(shell, args);
        break;
      case 'skill-gap':
        await cmdSkillGap(cwd, args);
        break;
      case 'diff-coverage':
        cmdDiffCoverage(shell, args);
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
      case 'test-survey':
        cmdTestSurvey(cwd, shell, args);
        break;
      case 'backfill-plan':
      case 'backfill-next':
      case 'backfill-mark':
      case 'backfill-status':
        cmdBackfill(command, cwd, args);
        break;
      case 'report-evidence':
        cmdReportEvidence(cwd, args);
        break;
      case 'report-write':
        await cmdReportWrite(cwd, args, shell);
        break;
      case 'report-list': {
        // With each report, why its public summary may not be filed now (empty: it may); one
        //   names lookup per project dir.
        const terms = new Map<string, string[]>();
        process.stdout.write(JSON.stringify({ inbox: inboxDir(), reports: listInbox().map((r) => ({ ...r, publish_problems: publishProblems(r.path, process.env, terms) })) }, null, 2) + '\n');
        break;
      }
      case 'report-filed':
        cmdReportFiled(args);
        break;
      case 'report-done':
        await cmdReportDone(args);
        break;
      case 'checkup-state':
      case 'checkup-begin':
      case 'checkup-changelog':
      case 'checkup-write':
      case 'checkup-complete':
      case 'checkup-abort':
      case 'checkup-projects':
      case 'checkup-inventory':
      case 'checkup-health':
      case 'checkup-smoke':
      case 'checkup-compare':
      case 'checkup-probe':
        await cmdCheckup(command, args);
        break;
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
