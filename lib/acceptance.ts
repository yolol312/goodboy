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

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

export type AcceptanceSource =
  | 'uiux-new'
  | 'uiux-change'
  | 'prototype-structure'
  | 'prototype-control'
  | 'prototype-regression';

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

/** 템플릿 플레이스홀더/빈 칸 판정. `<화면 이름>`, `신규 / 변경 / 그대로`, 빈 문자열, `-`. */
export function isPlaceholderCell(cell: string): boolean {
  const s = (cell ?? '').trim();
  if (s === '' || s === '-') return true;
  // <...> 로 감싼 템플릿 자리표시자
  if (/^<[^>]*>$/.test(s)) return true;
  // 범례를 그대로 남긴 칸 ("신규 / 변경 / 그대로")
  if (/^(신규|변경|그대로)(\s*\/\s*(신규|변경|그대로))+$/.test(s)) return true;
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

/**
 * `## <제목>` 아래의 첫 마크다운 표에서 **데이터 행만** 뽑는다.
 * 헤더 행(첫 행)과 구분선은 버리고, 모든 칸이 플레이스홀더/빈 칸인 행도 버린다.
 */
export function extractTableRows(markdown: string, headingIncludes: string): string[][] {
  const lines = (markdown ?? '').split(/\r?\n/);
  let inSection = false;
  let seenHeaderRow = false;
  let started = false;
  const rows: string[][] = [];

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      // 다른 ## 섹션을 만나면, 이미 표를 읽었으면 종료. 아니면 대상 섹션인지 판정.
      if (inSection && started) break;
      inSection = line.includes(headingIncludes);
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

/** docs/CYCLE.md 에서 `- **현재 버전**: v0.1` 값을 뽑는다. 플레이스홀더면 null. */
export function parseCurrentVersion(cycleMd: string): string | null {
  const m = /^\s*[-*]\s*\*\*현재 버전\*\*\s*:\s*(.+)$/m.exec(cycleMd ?? '');
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

/** 프로젝트에서 dev-cycle 산출물을 찾는다. 없으면 null. */
export function findDevCycleArtifacts(cwd: string): DevCycleArtifacts | null {
  try {
    const cyclePath = resolvePath(cwd, 'docs', 'CYCLE.md');
    if (!existsSync(cyclePath)) return null;
    const version = parseCurrentVersion(readFileSync(cyclePath, 'utf8'));
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

  const screens = extractTableRows(uiuxMd, '화면 목록');
  let newIdx = 0;
  for (const cells of screens) {
    const name = cells[0] ?? '';
    const kind = cells[1] ?? '';
    if (isPlaceholderCell(name)) continue;
    if (kind.trim() !== '신규') continue;
    newIdx += 1;
    out.push({
      id: `UIUX-NEW-${newIdx}`,
      source: 'uiux-new',
      description: `신규 화면이 존재하고 도달 가능하다: ${name}`,
    });
  }

  const changes = extractTableRows(uiuxMd, '무엇이 달라지는가');
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

/**
 * 이 프로젝트에서 테스트가 반드시 커버해야 하는 수용 기준 전체.
 * dev-cycle 산출물이 없으면 빈 배열(= 커버리지 강제 없음).
 */
export function requiredAcceptanceCriteria(cwd: string): AcceptanceCriterion[] {
  const art = findDevCycleArtifacts(cwd);
  if (!art) return [];
  const out: AcceptanceCriterion[] = [];
  if (art.uiuxPath) {
    try {
      out.push(...extractUiuxCriteria(readFileSync(art.uiuxPath, 'utf8')));
    } catch {
      // best-effort
    }
  }
  if (art.prototypePath) {
    try {
      out.push(...extractPrototypeCriteria(readFileSync(art.prototypePath, 'utf8')));
    } catch {
      // best-effort
    }
  }
  return out;
}
