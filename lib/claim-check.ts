// 층0 — 인용 검증. 작업이든 답변이든, 매 턴 환각을 기계적으로 확인한다.
//
// 배경: 기존 게이트는 전부 **편집이 있을 때만** 동작한다(Stop hook은 편집이 없으면
// 즉시 통과, 추론 게이트는 Edit/Write에만 걸림). 그래서 코드베이스에 대해 길게
// 설명하는 답변 턴은 완전히 무방비다 — 파일과 줄 번호를 대고 단정해도 아무것도
// 확인하지 않는다. 실제로 이 플러그인을 설계한 대화에서 수십 건의 `파일:줄` 주장이
// 아무 검증 없이 오갔다.
//
// 이 모듈은 LLM 없이 결정적으로 판정 가능한 것만 본다:
//   C1 인용한 파일이 실제로 존재하는가          → 위반 = 확정 환각
//   C2 인용한 줄 번호가 파일 길이 안인가         → 위반 = 확정 환각
//   C3 그 파일을 이 세션에서 실제로 읽었는가      → 위반 = 근거 미확인
//
// **`파일:줄` 형식만** 인용으로 본다. 백틱으로 감싼 경로(`package.json` 같은)는
// 단순 언급일 수 있어 제외한다 — 오탐을 만들면 게이트 자체가 꺼진다.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';

export interface Citation {
  /** 원문에 쓰인 그대로의 경로 */
  raw: string;
  /** cwd 기준 절대경로 */
  abs: string;
  line: number;
}

export type CitationProblemKind = 'missing-file' | 'line-out-of-range' | 'unread';

export interface CitationProblem {
  kind: CitationProblemKind;
  citation: Citation;
  detail: string;
}

/** 코드 파일로 보이는 확장자만 인용 대상으로 본다(버전 문자열 `v1.2:3` 등 오탐 방지).
 *
 *  경계 문자에 마크다운 강조(`*` `_`)를 포함한다 — 실측(P10)에서 모델이 인용을
 *  `**src/app.ts:3**` 로 굵게 써서 게이트가 통째로 놓쳤다. 강조는 인용을 **강조할 때**
 *  쓰는 표기라, 이걸 빼면 가장 단정적인 주장부터 빠져나간다. */
const PATHY = /(?:^|[\s(`'"[*_])((?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z][\w]{0,9}):(\d{1,6})(?=[\s)`'"\],.;*_]|$)/g;

/**
 * 텍스트에서 `파일:줄` 인용을 뽑는다.
 *
 * - `hooks/stop.ts:673`, `` `lib/cli.ts:42` ``, `./src/a.ts:1` 모두 인식
 * - URL(`https://…:443`)은 스킴 뒤 `//` 때문에 경로 패턴과 맞지 않아 걸리지 않는다
 * - 절대경로는 cwd 밖일 수 있으므로 cwd 안의 것만 남긴다(게이트가 보는 범위)
 */
export function extractCitations(text: string, cwd: string): Citation[] {
  const out: Citation[] = [];
  if (typeof text !== 'string' || text === '') return out;
  const cwdAbs = (() => {
    try {
      return resolvePath(cwd);
    } catch {
      return '';
    }
  })();
  if (cwdAbs === '') return out;

  const seen = new Set<string>();
  PATHY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATHY.exec(text)) !== null) {
    const raw = m[1] ?? '';
    const line = Number(m[2]);
    if (raw === '' || !Number.isFinite(line) || line <= 0) continue;
    let abs: string;
    try {
      abs = isAbsolute(raw) ? resolvePath(raw) : resolvePath(cwdAbs, raw);
    } catch {
      continue;
    }
    if (abs !== cwdAbs && !abs.startsWith(cwdAbs + sep)) continue;
    const key = `${abs}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, abs, line });
  }
  return out;
}

/** 파일의 줄 수. 읽을 수 없으면 null. */
function lineCount(abs: string): number | null {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const content = readFileSync(abs, 'utf8');
    if (content === '') return 0;
    // 마지막 줄 개행은 줄 수를 늘리지 않는다.
    const n = content.split('\n').length;
    return content.endsWith('\n') ? n - 1 : n;
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  /** 그 파일을 이 세션에서 읽었는지 판정하는 콜백. 생략하면 C3를 건너뛴다. */
  wasRead?: (abs: string) => boolean;
  /** 읽기 기록 자체가 없으면 C3를 통째로 생략한다(압축 직후 오차단 방지). */
  readTrackingAvailable?: boolean;
}

/**
 * 인용을 검증한다.
 *
 * C2에는 관대한 여유를 둔다: 파일은 세션 중에 편집되어 줄 번호가 밀린다. 실제 줄 수를
 * **넘어서는** 경우만 위반으로 본다(줄 내용이 맞는지까지는 보지 않는다).
 */
export function verifyCitations(
  citations: Citation[],
  opts: VerifyOptions = {},
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  for (const c of citations) {
    const n = lineCount(c.abs);
    if (n === null) {
      problems.push({
        kind: 'missing-file',
        citation: c,
        detail: `${c.raw}:${c.line} — 그런 파일이 없습니다.`,
      });
      continue;
    }
    if (c.line > n) {
      problems.push({
        kind: 'line-out-of-range',
        citation: c,
        detail: `${c.raw}:${c.line} — 그 파일은 ${n}줄까지입니다.`,
      });
      continue;
    }
    if (opts.readTrackingAvailable === true && typeof opts.wasRead === 'function') {
      if (!opts.wasRead(c.abs)) {
        problems.push({
          kind: 'unread',
          citation: c,
          detail: `${c.raw}:${c.line} — 이 세션에서 그 파일을 읽은 기록이 없습니다.`,
        });
      }
    }
  }
  return problems;
}

/**
 * 사용자가 먼저 쓴 인용을 모델의 주장에서 뺀다.
 *
 * 사용자가 `src/auth/session.ts:42` 처럼 존재하지 않는 위치를 프롬프트에 쓰고, 모델이
 * **"그런 파일이 없습니다"라고 정직하게 답하며 그 경로를 되풀이**하면, 그 인용은 모델의
 * 주장이 아니다. 그걸 환각으로 차단하면 정직한 답변을 벌하게 되고 — 실사용에서 사용자가
 * 오타나 추측 경로를 대고 묻는 일은 흔하다 — 게이트 신뢰도가 바로 무너진다.
 */
export function excludeUserOriginated(
  citations: Citation[],
  userTexts: string[],
  cwd: string,
): Citation[] {
  if (!Array.isArray(userTexts) || userTexts.length === 0) return citations;
  const fromUser = new Set<string>();
  for (const t of userTexts) {
    for (const c of extractCitations(t, cwd)) fromUser.add(`${c.abs}:${c.line}`);
  }
  if (fromUser.size === 0) return citations;
  return citations.filter((c) => !fromUser.has(`${c.abs}:${c.line}`));
}

/** 확정 환각(파일 없음/줄 범위 밖)만 추린다. */
export function hallucinatedCitations(problems: CitationProblem[]): CitationProblem[] {
  return problems.filter((p) => p.kind === 'missing-file' || p.kind === 'line-out-of-range');
}

/** 근거 미확인(읽은 기록 없음)만 추린다. */
export function unreadCitations(problems: CitationProblem[]): CitationProblem[] {
  return problems.filter((p) => p.kind === 'unread');
}

export function citationBlockMessage(problems: CitationProblem[]): string {
  const list = problems
    .slice(0, 5)
    .map((p) => `  - ${p.detail}`)
    .join('\n');
  const more = problems.length > 5 ? `\n  … 외 ${problems.length - 5}건` : '';
  return (
    `답변에서 실재하지 않는 위치를 인용했습니다:\n${list}${more}\n` +
    `해당 파일을 실제로 읽어 확인한 뒤 인용을 정정하거나, 근거가 없으면 그 주장을 ` +
    `\`## 근거 > 추측\` 으로 낮춰 다시 답하세요. (층0 인용 검증)`
  );
}

export function unreadBlockMessage(problems: CitationProblem[], escalate: boolean): string {
  const list = problems
    .slice(0, 5)
    .map((p) => `  - ${p.detail}`)
    .join('\n');
  const more = problems.length > 5 ? `\n  … 외 ${problems.length - 5}건` : '';
  const tail = escalate
    ? `반복해서 해소되지 않았습니다 — review-changes 서브에이전트를 \`축: hallucination\` 으로 ` +
      `호출해 인용한 주장들을 검증하고 결과를 기록하세요.`
    : `그 파일을 Read(또는 cat/sed -n)로 실제 확인한 뒤 다시 답하세요. 확인 없이 쓴 것이면 ` +
      `\`## 근거 > 추측\` 으로 분류하세요.`;
  return `인용한 위치를 이 세션에서 확인한 기록이 없습니다:\n${list}${more}\n${tail} (층0 인용 검증)`;
}
