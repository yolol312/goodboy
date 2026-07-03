#!/usr/bin/env bun
// vcf 보조 CLI — review-changes 슬래시 커맨드/서브에이전트가 Bash로 호출
//
// 사용법:
//   bun ${CLAUDE_PLUGIN_ROOT}/lib/cli.ts <command> [args...]
//
// 지원 명령:
//   review-write [file]   (없으면 stdin에서 ReviewResult JSON을 읽음)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ReviewFinding, ReviewResult, Severity, Verdict } from './types';

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

  // timestamp: optional string (생략/공백이면 생성)
  if (p.timestamp !== undefined && typeof p.timestamp !== 'string') {
    errors.push('timestamp는 문자열이어야 합니다(생략 시 현재 시각으로 채움).');
  }

  if (errors.length > 0) return { ok: false, errors };

  const timestamp =
    typeof p.timestamp === 'string' && p.timestamp.trim() !== ''
      ? p.timestamp
      : new Date().toISOString();

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
  return { ok: true, errors: [], value };
}

/** ISO timestamp를 안전한 파일명으로 변환한다.
 *  ⚠️ timestamp는 리뷰 서브에이전트가 넣는 값(신뢰 불가)일 수 있다. 콜론만 치환하면
 *     `../`·`/` 같은 경로 문자가 통과해 reviews 디렉터리 밖으로 파일을 쓸 수 있다.
 *     → 콜론을 대시로 바꾼 뒤, 파일명에 안전한 화이트리스트([0-9A-Za-z._-]) 외 문자는 전부 '_'로 치환하고,
 *       선행 점(., .., ...)을 제거해 상위경로/숨김파일화를 막는다. 빈 값이면 안전한 기본값. */
export function timestampToFilename(ts: string): string {
  const safe = (typeof ts === 'string' ? ts : '')
    .replace(/:/g, '-')
    .replace(/[^0-9A-Za-z._-]/g, '_')
    .replace(/^\.+/, '');
  return safe === '' ? 'review' : safe;
}

async function cmdReviewWrite(cwd: string, args: string[]): Promise<void> {
  // 입력: 파일 인자가 있으면 파일, 없으면 stdin
  let raw: string;
  const fileArg = args[0];
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
    fail('입력이 비어 있습니다. ReviewResult JSON을 stdin 또는 파일 인자로 전달하세요.');
  }

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
  const filename = `${timestampToFilename(result.timestamp)}.json`;
  const outPath = join(reviewsDir, filename);
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

// ---- main ----

const USAGE =
  '사용법: bun lib/cli.ts <command> [args...]\n' +
  '명령: review-write';

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
