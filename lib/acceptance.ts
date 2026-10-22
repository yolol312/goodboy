// 수용 기준 추출 — dev-cycle 산출물을 테스트 게이트의 "정답지"로 읽는다.
//
// 배경: 층1 테스트 게이트는 "테스트가 통과했는가"가 아니라 "요구한 것을 실제로 만족하는가"를
// 물어야 한다. 그러려면 정답지가 파일로 있어야 하고, dev-cycle 스킬이 남기는 산출물이
// 정확히 그 역할을 한다:
//
//   docs/CYCLE.md                        현재 버전
//   docs/versions/<VER>/UIUX.md          화면 목록 · 변경 화면 표
//   docs/versions/<VER>/prototype/       확정된 프로토타입(= 시각/동작 정답지)
//
// Keys are read in Korean and English (stabilization plan F1), since the language policy
// lets these documents be written in English: `현재 버전`/`Current version`,
// `화면 목록`/`Screens` or `Screen list`, `무엇이 달라지는가`/`What changes`, `컴포넌트`/`Components`, and
// the kinds `신규`/`new`, `변경`/`changed`, `그대로`/`unchanged`. Before, English documents
// read as "no dev-cycle artifacts", and the acceptance criteria silently dropped to zero.
//
// 프로토타입 규격(~/.claude/skills/dev-cycle/assets/PROTOTYPE-SPEC.md)의 "대조 계약"이
// 이 파서의 전제다:
//   - 프로토타입 전용 UI는 `pt-` 접두 예약. 앱 마크업은 `pt-` 접두를 쓰지 않는다.
//   - 대조 루트는 `.pt-frame` 내부, 조작 바(`pt-bar`)는 대조 대상이 아니다.
//   - 기준 상태는 `적용 후`, `수정 전`은 회귀 확인용.
//   - 상태 전환은 `data-state` 속성으로 가능해야 한다.
//
// best-effort: 정규식/표 파싱만 한다. dev-cycle을 쓰지 않는 프로젝트에서는 빈 배열을
// 반환하고, 그때 테스트 게이트는 수용 기준 커버리지를 강제하지 않는다(단위/통합 +
// red-green + 뮤테이션만 남는다). goodboy는 범용 플러그인이므로 dev-cycle 의존을
// 필수로 만들지 않는다.

import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { MAX_DOC_BYTES, readRegular } from './safe-read';

export type AcceptanceSource =
  | 'uiux-new'
  | 'uiux-change'
  | 'uiux-component'
  | 'uiux-component-state'
  | 'prototype-structure'
  | 'prototype-control'
  | 'prototype-regression'
  /** (I2) A REQUIREMENTS.md row a session works on, and a policy entry's `test:` line. */
  | 'requirement'
  | 'policy';

export interface AcceptanceCriterion {
  /** 안정적인 ID. 테스트 결과의 acceptance[].id가 이 값과 일치해야 커버로 인정된다. */
  id: string;
  source: AcceptanceSource;
  description: string;
}

export interface DevCycleArtifacts {
  version: string;
  /** docs/versions/<VER> 절대경로 */
  versionDir: string;
  /** prototype/index.html 절대경로 (없으면 null) */
  prototypePath: string | null;
  /** UIUX.md 절대경로 (없으면 null) */
  uiuxPath: string | null;
}

type Kind = 'new' | 'changed' | 'unchanged';
const KIND_WORDS: Record<Kind, string[]> = {
  new: ['신규', 'new'],
  changed: ['변경', 'changed'],
  unchanged: ['그대로', 'unchanged'],
};

/** A table's kind cell (`신규` / `new`, …), in either language and any case. */
function isKind(cell: string, kind: Kind): boolean {
  return KIND_WORDS[kind].includes((cell ?? '').trim().toLowerCase());
}

// The template's legend left in a cell ("신규 / 변경 / 그대로", "new / changed / unchanged"),
//   built from KIND_WORDS so that a kind word added there is recognized here too.
const ANY_KIND = Object.values(KIND_WORDS).flat().join('|');
const LEGEND_CELL = new RegExp(`^(?:${ANY_KIND})(?:\\s*\\/\\s*(?:${ANY_KIND}))+$`, 'i');

/** 템플릿 플레이스홀더/빈 칸 판정. `<화면 이름>`, `신규 / 변경 / 그대로`, 빈 문자열, `-`. */
export function isPlaceholderCell(cell: string): boolean {
  const s = (cell ?? '').trim();
  if (s === '' || s === '-') return true;
  // <...> 로 감싼 템플릿 자리표시자
  if (/^<[^>]*>$/.test(s)) return true;
  if (LEGEND_CELL.test(s)) return true;
  return false;
}

/** 마크다운 표의 한 줄을 셀 배열로 자른다. 구분선(|---|)이면 null. */
function parseTableRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  // 구분선: 모든 셀이 --- 형태
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return null;
  return cells;
}

/** `## 제목` 줄에서 제목 텍스트만. `##` 과 앞뒤 공백을 벗긴다. */
function headingText(line: string): string {
  return line.replace(/^#+\s*/, '').trim();
}

/**
 * `## <제목>` 아래의 첫 마크다운 표에서 **데이터 행만** 뽑는다.
 * 헤더 행(첫 행)과 구분선은 버리고, 모든 칸이 플레이스홀더/빈 칸인 행도 버린다.
 *
 * **정확히 일치하는 제목이 있으면 그것만 본다.** 없을 때만 부분 일치로 폴백한다.
 * 부분 일치만 쓰면 같은 낱말을 품은 다른 절이 앞에 있을 때 그 표를 읽고 끝나버린다 —
 * 실측: `## 화면별 컴포넌트 배치` 가 `## 컴포넌트` 앞에 있으면 화면 이름이 컴포넌트
 * 기준으로 둔갑하고 진짜 표의 상태 기준이 **조용히 사라졌다.** 크래시가 아니라
 * 오탑재라 더 나쁘다. 폴백은 `'무엇이 달라지는가'`(실제 제목은
 * `## 변경 화면 — 무엇이 달라지는가`)처럼 처음부터 부분 일치를 전제한 호출을 위해 남긴다.
 * The fallback skips headings that contain any of `avoid`: those of another section.
 */
export function extractTableRows(
  markdown: string,
  headingIncludes: string,
  ignoreCase = false,
  avoid: string[] = [],
): string[][] {
  const lines = (markdown ?? '').split(/\r?\n/);
  const fold = (s: string): string => (ignoreCase ? s.toLowerCase() : s);
  const target = fold(headingIncludes.trim());
  // 정확 일치 제목이 **존재하는지**로 먼저 판정한다. "행이 비면 폴백"이 아니다 —
  //   정확 일치 절의 표가 비어 있을 때 엉뚱한 절로 새는 것을 막아야 한다.
  const hasExact = lines.some((l) => /^##\s/.test(l) && fold(headingText(l)) === target);
  const matches = (line: string): boolean =>
    hasExact
      ? fold(headingText(line)) === target
      : fold(line).includes(fold(headingIncludes)) && !avoid.some((a) => fold(line).includes(fold(a)));

  let inSection = false;
  let seenHeaderRow = false;
  let started = false;
  const rows: string[][] = [];

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      // 다른 ## 섹션을 만나면, 이미 표를 읽었으면 종료. 아니면 대상 섹션인지 판정.
      if (inSection && started) break;
      inSection = matches(line);
      seenHeaderRow = false;
      started = false;
      continue;
    }
    if (!inSection) continue;

    const cells = parseTableRow(line);
    if (cells === null) {
      // 표가 시작된 뒤 표 아닌 줄을 만나면 그 표는 끝난 것으로 본다(구분선은 null이라
      // 여기 걸리므로, started는 헤더 행을 실제로 본 뒤에만 세운다).
      if (started && line.trim() !== '' && !line.trim().startsWith('|')) break;
      continue;
    }
    if (!seenHeaderRow) {
      seenHeaderRow = true;
      started = true;
      continue;
    }
    if (cells.every((c) => isPlaceholderCell(c))) continue;
    rows.push(cells);
  }
  return rows;
}

/** The rows of a section headed in Korean or English: those of the first heading, in
 *  order, whose table has rows. English headings match in any case. */
function extractTableRowsAny(markdown: string, headings: string[], avoid: string[] = []): string[][] {
  for (const heading of headings) {
    const rows = extractTableRows(markdown, heading, true, avoid);
    if (rows.length > 0) return rows;
  }
  return [];
}

// `Screen list` is the literal English of 화면 목록; without it that heading matched nothing
//   and its new screens were dropped with no warning (round-3 final hallucination review).
const SCREENS_HEADINGS = ['화면 목록', 'Screens', 'Screen list'];
const CHANGES_HEADINGS = ['무엇이 달라지는가', 'What changes'];
const COMPONENTS_HEADINGS = ['컴포넌트', 'Components'];

// [ \t] rather than \s: with an empty value, \s* ran past the line end and read the next
//   line (`- **현재 단계**: 1`) as the version.
const CURRENT_VERSION_LINE = /^[ \t]*[-*][ \t]*\*\*(?:현재 버전|current version)\*\*[ \t]*:[ \t]*(.*)$/im;

/** docs/CYCLE.md 에서 `- **현재 버전**: v0.1` (or `- **Current version**: v0.1`) 값을 뽑는다. 플레이스홀더면 null. */
export function parseCurrentVersion(cycleMd: string): string | null {
  const m = CURRENT_VERSION_LINE.exec(cycleMd ?? '');
  if (!m) return null;
  const v = m[1].trim();
  if (v === '') return null;
  // `<v0.1>` 은 dev-cycle 템플릿의 자리표시자다 — 벗겨서 쓰면 아직 확정되지 않은 버전을
  // 확정된 것으로 오인한다. 꺾쇠가 조금이라도 있으면 미확정으로 본다.
  if (v.includes('<') || v.includes('>')) return null;
  // 경로 조립에 쓰이므로 경로 구분자/상위경로를 거부한다(신뢰 불가 입력 방어).
  if (v.includes('/') || v.includes('\\') || v.includes('..')) return null;
  return v;
}

const CURRENT_STAGE_LINE = /^[ \t]*[-*][ \t]*\*\*(?:현재 단계|current stage)\*\*[ \t]*:[ \t]*(.*)$/im;

/** docs/CYCLE.md's `- **현재 단계**: 5` (or `Current stage`): the stage number, `done` (완료),
 *  or null when it is missing or unreadable. */
export function parseCurrentStage(cycleMd: string): number | 'done' | null {
  const m = CURRENT_STAGE_LINE.exec(cycleMd ?? '');
  if (!m) return null;
  const v = m[1]!.trim().replace(/[*`]/g, '');
  if (/^(?:완료|done|complete[d]?)$/i.test(v)) return 'done';
  const n = /^(\d{1,2})(?:\s|\.|$|\()/.exec(v);
  return n ? Number(n[1]) : null;
}

/** The dev-cycle stage that verifies the version: from here on every UI criterion blocks. */
export const VERIFY_STAGE = 6;

/** The stage docs/CYCLE.md names now, or null (no file, unreadable, no stage line). */
export function readCurrentStage(cwd: string): number | 'done' | null {
  const cycle = readCycleMd(cwd);
  return typeof cycle === 'string' ? null : parseCurrentStage(cycle.text);
}

/** docs/CYCLE.md: its text, `missing`, or `unreadable` when it exists but cannot be read. */
function readCycleMd(cwd: string): { text: string } | 'missing' | 'unreadable' {
  const read = readRegular(resolvePath(cwd, 'docs', 'CYCLE.md'), MAX_DOC_BYTES);
  return read === 'absent' ? 'missing' : read === 'refused' ? 'unreadable' : { text: read.text };
}

/** 프로젝트에서 dev-cycle 산출물을 찾는다. 없으면 null. */
export function findDevCycleArtifacts(cwd: string): DevCycleArtifacts | null {
  const cycle = readCycleMd(cwd);
  return typeof cycle === 'string' ? null : artifactsFrom(cwd, cycle.text);
}

function artifactsFrom(cwd: string, cycleMd: string): DevCycleArtifacts | null {
  try {
    const version = parseCurrentVersion(cycleMd);
    if (!version) return null;
    const versionDir = resolvePath(cwd, 'docs', 'versions', version);
    if (!existsSync(versionDir)) return null;
    const prototypePath = resolvePath(versionDir, 'prototype', 'index.html');
    const uiuxPath = resolvePath(versionDir, 'UIUX.md');
    return {
      version,
      versionDir,
      prototypePath: existsSync(prototypePath) ? prototypePath : null,
      uiuxPath: existsSync(uiuxPath) ? uiuxPath : null,
    };
  } catch {
    return null;
  }
}

/**
 * UIUX.md → 수용 기준.
 *  - `## 화면 목록` 에서 구분이 `신규` 인 행 → 그 화면이 존재해야 한다.
 *  - `## 변경 화면 — 무엇이 달라지는가` 의 각 행 → 그 변경이 반영돼야 한다.
 *
 * `그대로` 로 분류된 화면은 기준을 만들지 않는다 — 회귀 축(PT-REGRESSION)이 담당한다.
 */
export function extractUiuxCriteria(uiuxMd: string): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];

  // The changes heading names screens too (`## Changed screens — What changes`). Without an
  //   exact `## Screens`, the partial match fell on it and read the changes as the screen
  //   list (found in round 3).
  const screens = extractTableRowsAny(uiuxMd, SCREENS_HEADINGS, CHANGES_HEADINGS);
  let newIdx = 0;
  for (const cells of screens) {
    const name = cells[0] ?? '';
    const kind = cells[1] ?? '';
    if (isPlaceholderCell(name)) continue;
    if (!isKind(kind, 'new')) continue;
    newIdx += 1;
    out.push({
      id: `UIUX-NEW-${newIdx}`,
      source: 'uiux-new',
      description: `신규 화면이 존재하고 도달 가능하다: ${name}`,
    });
  }

  const changes = extractTableRowsAny(uiuxMd, CHANGES_HEADINGS);
  let chgIdx = 0;
  for (const cells of changes) {
    const screen = cells[0] ?? '';
    const after = cells[2] ?? '';
    if (isPlaceholderCell(screen) && isPlaceholderCell(after)) continue;
    chgIdx += 1;
    const what = isPlaceholderCell(after) ? '(이번 버전 칸 비어 있음)' : after;
    out.push({
      id: `UIUX-CHG-${chgIdx}`,
      source: 'uiux-change',
      description: `${isPlaceholderCell(screen) ? '화면' : screen}: ${what}`,
    });
  }

  out.push(...extractComponentCriteria(uiuxMd));

  return out;
}

/**
 * 데이터가 들어가는 컴포넌트가 반드시 가져야 하는 상태.
 *
 * 이 셋이 실무에서 가장 자주 빠진다. 빠지면 구현이 지어내고, 대개 아무 안내 없는 빈
 * 화면이 된다. 그래서 컴포넌트 기준 하나로 뭉치지 않고 **상태마다 따로** 기준을 만든다
 * — 뭉치면 "컴포넌트 만들었다"로 한 번에 커버 처리되어 상태 누락이 그대로 통과한다.
 */
const DATA_STATES: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'EMPTY', label: '빈 상태', re: /빈\s*상태|empty/i },
  { key: 'ERROR', label: '에러 상태', re: /에러|오류|error/i },
  { key: 'LOADING', label: '로딩 상태', re: /로딩|loading|스켈레톤|skeleton/i },
];

/**
 * UIUX.md `## 컴포넌트` 표 → 수용 기준.
 *
 *   | 컴포넌트 | 구분 | 변형 | 상태 | 쓰이는 화면 |
 *
 *  - `신규`·`변경` 행 → `UIUX-COMP-<n>` (그 컴포넌트가 명세대로 동작한다)
 *  - `상태` 칸에 빈 상태·에러·로딩이 적혀 있으면 각각 `UIUX-STATE-<n>`
 *
 * `그대로` 는 기준을 만들지 않는다 — 화면과 같은 이유로 회귀 축이 담당한다.
 * 표가 없으면 빈 배열이다(이 절을 쓰지 않는 예전 버전의 UIUX.md 호환).
 */
export function extractComponentCriteria(uiuxMd: string): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  const rows = extractTableRowsAny(uiuxMd ?? '', COMPONENTS_HEADINGS);
  let compIdx = 0;
  let stateIdx = 0;

  for (const cells of rows) {
    const name = cells[0] ?? '';
    // 이름 칸으로만 거른다. 템플릿의 상태 범례("default·hover·disabled …")는
    //   isPlaceholderCell 이 못 잡아서, 행 전체 판정만 믿으면 빈 이름이 새어 들어온다.
    if (isPlaceholderCell(name)) continue;
    if (isKind(cells[1] ?? '', 'unchanged')) continue;

    const variants = cells[2] ?? '';
    const states = cells[3] ?? '';

    compIdx += 1;
    const variantPart = isPlaceholderCell(variants) ? '' : ` (변형: ${variants})`;
    out.push({
      id: `UIUX-COMP-${compIdx}`,
      source: 'uiux-component',
      description: `컴포넌트가 명세된 대로 렌더되고 동작한다: ${name}${variantPart}`,
    });

    if (isPlaceholderCell(states)) continue;
    for (const st of DATA_STATES) {
      if (!st.re.test(states)) continue;
      stateIdx += 1;
      out.push({
        id: `UIUX-STATE-${stateIdx}`,
        source: 'uiux-component-state',
        description:
          `${name} 의 ${st.label}가 실제로 표시된다 — 그 상황을 만들어서 확인한다` +
          ` (코드에 분기가 있다는 것만으로는 충족이 아니다)`,
      });
    }
  }

  return out;
}

/**
 * 프로토타입 HTML에서 앱 영역의 클래스 토큰을 뽑는다.
 *
 * 태그 중첩을 세어 `.pt-frame` 안쪽만 잘라내는 대신, **`pt-` 접두를 뺀 전체 클래스 토큰**을
 * 취한다. 대조 계약이 `pt-` 를 프로토타입 전용 예약 접두사로 못박고 있으므로 두 집합은
 * 같고, 정규식 중첩 파싱보다 훨씬 견고하다(접기/열기로 마크업이 늘어나도 영향 없음).
 */
export function extractAppClasses(html: string): string[] {
  const found = new Set<string>();
  const re = /class\s*=\s*"([^"]*)"|class\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? '')) !== null) {
    const raw = m[1] ?? m[2] ?? '';
    for (const token of raw.split(/\s+/)) {
      const t = token.trim();
      if (t === '') continue;
      if (t.startsWith('pt-')) continue;
      found.add(t);
    }
  }
  return Array.from(found).sort();
}

/**
 * 프로토타입 조작 바에서 **이번 버전이 도입한 선택지** 그룹의 id를 뽑는다.
 *
 * 규격 3절: 상태 토글(①)은 `pt-group` 에 id가 없고 안쪽 `pt-seg` 만 `id="seg-state"` 를 갖는다.
 * 도입 선택지(②)는 `pt-group` 자체에 id가 붙는다 → id 있는 pt-group = 이번 버전의 능력.
 * 방어적으로 state/상태가 들어간 id는 제외한다.
 */
export function extractControlGroupIds(html: string): string[] {
  const ids: string[] = [];
  const re = /<div\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html ?? '')) !== null) {
    const tag = m[0];
    if (!/class\s*=\s*["'][^"']*\bpt-group\b/.test(tag)) continue;
    const idm = /\bid\s*=\s*["']([^"']+)["']/.exec(tag);
    if (!idm) continue;
    const id = idm[1].trim();
    if (id === '') continue;
    if (/state|상태/i.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 프로토타입에 `수정 전` / `적용 후` 상태 토글이 있는가 (회귀 축의 존재 여부). */
export function hasStateToggle(html: string): boolean {
  const h = html ?? '';
  return /data-state\s*=\s*["']before["']/.test(h) && /data-state\s*=\s*["']after["']/.test(h);
}

/** 대조 계약 위반 경고. 차단용이 아니라 테스트 에이전트에게 알려주기 위한 것. */
export function prototypeContractWarnings(html: string): string[] {
  const warns: string[] = [];
  const h = html ?? '';
  if (!/class\s*=\s*["'][^"']*\bpt-frame\b/.test(h)) {
    warns.push(
      '프로토타입에 `.pt-frame` 앵커가 없습니다 — 대조 루트를 "`pt-*` 를 뺀 나머지"로 폴백합니다 (대조 계약 1·2).',
    );
  }
  if (!/class\s*=\s*["'][^"']*\bpt-bar\b/.test(h)) {
    warns.push('프로토타입에 조작 바(`.pt-bar`)가 없습니다 — 규격 3절을 따르지 않은 산출물일 수 있습니다.');
  }
  if (/\bhttps?:\/\//.test(h.replace(/<!--[\s\S]*?-->/g, ''))) {
    warns.push('프로토타입에 외부 URL이 보입니다 — 규격 0절(외부 연결 금지) 위반 가능성.');
  }
  return warns;
}

/** 프로토타입 → 수용 기준. */
export function extractPrototypeCriteria(html: string): AcceptanceCriterion[] {
  const out: AcceptanceCriterion[] = [];
  const appClasses = extractAppClasses(html);
  if (appClasses.length > 0) {
    out.push({
      id: 'PT-STRUCT',
      source: 'prototype-structure',
      description:
        `프로토타입 앱 영역의 구조/클래스가 구현에 존재한다 ` +
        `(클래스 ${appClasses.length}종, 기준 상태 = 적용 후)`,
    });
  }
  for (const id of extractControlGroupIds(html)) {
    out.push({
      id: `PT-CTRL-${id}`,
      source: 'prototype-control',
      description: `이번 버전이 도입한 선택지가 구현에 존재하고 실제로 동작한다: #${id}`,
    });
  }
  if (hasStateToggle(html)) {
    out.push({
      id: 'PT-REGRESSION',
      source: 'prototype-regression',
      description:
        '프로토타입에서 `수정 전`/`적용 후` 가 동일한 항목(= 안 바뀌어야 하는 것)이 구현에서도 그대로다',
    });
  }
  return out;
}

/** The criteria of UIUX.md and the prototype, and those of the two that cannot be read. */
function criteriaOf(art: DevCycleArtifacts): { criteria: AcceptanceCriterion[]; unreadable: string[] } {
  const criteria: AcceptanceCriterion[] = [];
  const unreadable: string[] = [];
  const sources: [string | null, (text: string) => AcceptanceCriterion[]][] = [
    [art.uiuxPath, extractUiuxCriteria],
    [art.prototypePath, extractPrototypeCriteria],
  ];
  for (const [path, extract] of sources) {
    if (!path) continue;
    const read = readRegular(path, MAX_DOC_BYTES);
    if (read === 'refused') unreadable.push(path);
    else if (read !== 'absent') {
      try {
        criteria.push(...extract(read.text));
      } catch {
        // best-effort
      }
    }
  }
  return { criteria, unreadable };
}

export type AcceptanceProblem =
  /** docs/CYCLE.md exists but has no current-version line in either language. */
  | { kind: 'no-version-key' }
  /** docs/CYCLE.md, UIUX.md or the prototype exists but cannot be read (permissions, a
   *  directory, a FIFO, a huge file). */
  | { kind: 'unreadable'; files: string[] }
  /** UIUX.md or the prototype exists, but no criterion came out of it. */
  | { kind: 'no-criteria'; files: string[] };

/** What layer 1 reads from the dev-cycle documents, with docs/CYCLE.md read once. */
export interface AcceptanceReading {
  /** Whether the dev-cycle artifacts of a current version exist (findDevCycleArtifacts):
   *  in auto mode they switch layer 1 on. */
  devCycle: boolean;
  /** 이 프로젝트에서 테스트가 반드시 커버해야 하는 수용 기준 전체. dev-cycle 산출물이
   *  없으면 빈 배열(= 커버리지 강제 없음). */
  criteria: AcceptanceCriterion[];
  /**
   * Why a project with dev-cycle documents yields no acceptance criteria, or null.
   *
   * Null when there is nothing to report:
   * - no docs/CYCLE.md;
   * - criteria found;
   * - a placeholder version (the cycle has not started);
   * - a missing version folder (dev-cycle reports that itself);
   * - a stage before UIUX.md and the prototype exist.
   *
   * Layer 1 shows the problem as a warning (stabilization plan F2). An unrecognized key or
   * heading made the criteria drop to zero with no sign, and in auto mode it turned the
   * test gate off. A version that really has no new or changed screens also lands on
   * `no-criteria`, which is why this is a warning and not a block.
   */
  problem: AcceptanceProblem | null;
  /** (I11, #20) The stage is before verification (6): the UI criteria are pending, listed but
   *  not blocking, since their screens may have no product code yet. An unknown stage is not
   *  before it: the criteria block as before. Set only when true. */
  uiPending?: true;
}

/** Nothing to read: no dev-cycle documents, or layer 1 switched off. */
export const NO_ACCEPTANCE: AcceptanceReading = { devCycle: false, criteria: [], problem: null };

/** The Stop takes one reading per run for the gate switch, the criteria and the F2
 *  warning. Separate calls read docs/CYCLE.md up to five times and parsed UIUX.md and the
 *  prototype twice (round-3 refactoring review). */
export function readAcceptance(cwd: string): AcceptanceReading {
  try {
    const cycle = readCycleMd(cwd);
    if (cycle === 'missing') return NO_ACCEPTANCE;
    if (cycle === 'unreadable') {
      return { ...NO_ACCEPTANCE, problem: { kind: 'unreadable', files: [resolvePath(cwd, 'docs', 'CYCLE.md')] } };
    }
    if (!CURRENT_VERSION_LINE.test(cycle.text)) return { ...NO_ACCEPTANCE, problem: { kind: 'no-version-key' } };
    const art = artifactsFrom(cwd, cycle.text);
    if (!art) return NO_ACCEPTANCE;
    const { criteria, unreadable } = criteriaOf(art);
    const files = [art.uiuxPath, art.prototypePath].filter((p): p is string => p !== null);
    const stage = parseCurrentStage(cycle.text);
    return {
      devCycle: true,
      criteria,
      ...(typeof stage === 'number' && stage < VERIFY_STAGE ? { uiPending: true as const } : {}),
      problem:
        unreadable.length > 0
          ? { kind: 'unreadable', files: unreadable }
          : criteria.length === 0 && files.length > 0
            ? { kind: 'no-criteria', files }
            : null,
    };
  } catch {
    return NO_ACCEPTANCE;
  }
}

/** readAcceptance(cwd).criteria, for a caller that needs nothing else. */
export function requiredAcceptanceCriteria(cwd: string): AcceptanceCriterion[] {
  return readAcceptance(cwd).criteria;
}
