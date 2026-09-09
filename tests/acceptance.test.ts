// lib/acceptance.ts — dev-cycle 산출물에서 수용 기준을 뽑는 파서 테스트.
//
// 이 파서가 틀리면 층1 게이트가 (a) 없는 기준을 요구해 오차단하거나
// (b) 있는 기준을 놓쳐 무력화된다. 템플릿 플레이스홀더 처리가 특히 중요하다 —
// dev-cycle 템플릿은 빈 표와 `<화면 이름>` 자리표시자를 그대로 남긴 채 시작한다.

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractAppClasses,
  extractComponentCriteria,
  extractControlGroupIds,
  extractPrototypeCriteria,
  extractTableRows,
  extractUiuxCriteria,
  findDevCycleArtifacts,
  hasStateToggle,
  isPlaceholderCell,
  parseCurrentVersion,
  prototypeContractWarnings,
  requiredAcceptanceCriteria,
} from '../lib/acceptance';

const sandboxes: string[] = [];
function newSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-acceptance-'));
  sandboxes.push(dir);
  return dir;
}
afterEach(() => {
  while (sandboxes.length > 0) {
    const d = sandboxes.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('parseCurrentVersion', () => {
  test('확정된 버전을 뽑는다', () => {
    expect(parseCurrentVersion('# 개발 사이클\n\n- **현재 버전**: v0.3\n- **현재 단계**: 5\n')).toBe('v0.3');
  });

  test('템플릿 자리표시자 <v0.1> 은 미확정으로 본다', () => {
    expect(parseCurrentVersion('- **현재 버전**: <v0.1>\n')).toBe(null);
  });

  test('경로 구분자/상위경로가 든 값은 거부한다 (경로 조립에 쓰이므로)', () => {
    expect(parseCurrentVersion('- **현재 버전**: ../../etc\n')).toBe(null);
    expect(parseCurrentVersion('- **현재 버전**: a/b\n')).toBe(null);
  });

  test('항목이 없으면 null', () => {
    expect(parseCurrentVersion('# 개발 사이클\n내용 없음\n')).toBe(null);
  });
});

describe('isPlaceholderCell', () => {
  test('빈 칸·대시·꺾쇠 자리표시자·범례를 자리표시자로 본다', () => {
    expect(isPlaceholderCell('')).toBe(true);
    expect(isPlaceholderCell('  ')).toBe(true);
    expect(isPlaceholderCell('-')).toBe(true);
    expect(isPlaceholderCell('<화면 이름>')).toBe(true);
    expect(isPlaceholderCell('신규 / 변경 / 그대로')).toBe(true);
  });

  test('실제 값은 자리표시자가 아니다', () => {
    expect(isPlaceholderCell('트렌드 보드')).toBe(false);
    expect(isPlaceholderCell('신규')).toBe(false);
  });
});

describe('extractTableRows', () => {
  const md = `## 화면 목록

| 화면 | 구분 | 경로 |
|---|---|---|
| 트렌드 보드 | 변경 | /board |
| 설정 | 신규 | /settings |

## 다른 섹션

| 무시 | 될 표 |
|---|---|
| a | b |
`;

  test('지정한 섹션의 데이터 행만 뽑는다 (헤더/구분선 제외)', () => {
    const rows = extractTableRows(md, '화면 목록');
    expect(rows).toEqual([
      ['트렌드 보드', '변경', '/board'],
      ['설정', '신규', '/settings'],
    ]);
  });

  test('다음 ## 섹션의 표는 포함하지 않는다', () => {
    const rows = extractTableRows(md, '화면 목록');
    expect(rows.some((r) => r.includes('a'))).toBe(false);
  });

  test('템플릿의 빈 행은 버린다', () => {
    const tmpl = '## 화면 목록\n\n| 화면 | 구분 |\n|---|---|\n| | 신규 / 변경 / 그대로 |\n';
    expect(extractTableRows(tmpl, '화면 목록')).toEqual([]);
  });

  test('없는 섹션이면 빈 배열', () => {
    expect(extractTableRows(md, '존재하지 않는 섹션')).toEqual([]);
  });

  // 실측 결함: 부분 일치만 쓰면 같은 낱말을 품은 다른 절이 **앞에** 있을 때 그 표를 읽고
  // 끝나버린다. 크래시가 아니라 오탑재라 더 나쁘다 — 진짜 표의 기준이 조용히 사라진다.
  test('같은 낱말을 품은 선행 절이 있어도 정확 일치 절을 읽는다', () => {
    const doc = `## 화면별 컴포넌트 배치

| 화면 | 슬롯 |
|---|---|
| 대시보드 | 헤더 |

## 컴포넌트

| 컴포넌트 | 구분 |
|---|---|
| LogTable | 신규 |
`;
    expect(extractTableRows(doc, '컴포넌트')).toEqual([['LogTable', '신규']]);
  });

  test('정확 일치 절의 표가 비어도 다른 절로 새지 않는다', () => {
    const doc = `## 컴포넌트 원칙

| 원칙 | 값 |
|---|---|
| 간격 | 4px |

## 컴포넌트

| 컴포넌트 | 구분 |
|---|---|
| | 신규 / 변경 / 그대로 |
`;
    expect(extractTableRows(doc, '컴포넌트')).toEqual([]);
  });

  test('정확 일치 제목이 없으면 부분 일치로 폴백한다', () => {
    // `## 변경 화면 — 무엇이 달라지는가` 처럼 처음부터 부분 일치를 전제한 호출을 위해 남긴다.
    const doc = `## 변경 화면 — 무엇이 달라지는가

| 화면 | 지금 | 이번 버전 |
|---|---|---|
| 대시보드 | 없음 | 표 추가 |
`;
    expect(extractTableRows(doc, '무엇이 달라지는가')).toEqual([['대시보드', '없음', '표 추가']]);
  });
});

describe('extractUiuxCriteria', () => {
  const uiux = `# UI/UX — v0.1

## 화면 목록

| 화면 | 구분 | 경로 | 목적 | 대응 기획 항목 |
|---|---|---|---|---|
| 트렌드 보드 | 변경 | /board | 수집 현황 | 기획 #1 |
| 설정 | 신규 | /settings | 수집기 토글 | 기획 #2 |
| 로그인 | 그대로 | /login | - | - |

## 변경 화면 — 무엇이 달라지는가

| 화면 | 지금 | 이번 버전 | 근거 |
|---|---|---|---|
| 트렌드 보드 | 정렬 없음 | 유튜브 정렬 선택지 추가 | 요구 #3 |
`;

  test('신규 화면만 UIUX-NEW 기준이 된다 (변경/그대로는 아님)', () => {
    const cs = extractUiuxCriteria(uiux);
    const news = cs.filter((c) => c.source === 'uiux-new');
    expect(news).toHaveLength(1);
    expect(news[0]!.id).toBe('UIUX-NEW-1');
    expect(news[0]!.description).toContain('설정');
  });

  test('변경 화면 표의 각 행이 UIUX-CHG 기준이 된다', () => {
    const cs = extractUiuxCriteria(uiux);
    const chg = cs.filter((c) => c.source === 'uiux-change');
    expect(chg).toHaveLength(1);
    expect(chg[0]!.id).toBe('UIUX-CHG-1');
    expect(chg[0]!.description).toContain('유튜브 정렬');
  });

  test('빈 템플릿에서는 기준이 나오지 않는다 (오차단 방지)', () => {
    const tmpl = `## 화면 목록

| 화면 | 구분 | 경로 | 목적 | 대응 기획 항목 |
|---|---|---|---|---|
| | 신규 / 변경 / 그대로 | | | |

## 변경 화면 — 무엇이 달라지는가

| 화면 | 지금 | 이번 버전 | 근거 |
|---|---|---|---|
| | | | |
`;
    expect(extractUiuxCriteria(tmpl)).toEqual([]);
  });
});

// 지키려는 성질: **빈 상태·에러·로딩이 개별 커버 대상이 된다.**
// 이 셋은 실무에서 가장 자주 누락되고, 누락되면 아무 안내 없는 빈 화면이 된다.
// 컴포넌트 기준 하나로 뭉치면 "컴포넌트 만들었다"로 한 번에 커버 처리되어 그대로 통과한다.
describe('extractComponentCriteria', () => {
  const md = (rows: string) => `# UI/UX — v0.1

## 컴포넌트

| 컴포넌트 | 구분 | 변형 | 상태 | 쓰이는 화면 |
|---|---|---|---|---|
${rows}
`;

  test('신규 컴포넌트에 기준을 만들고 변형을 설명에 담는다', () => {
    const cs = extractComponentCriteria(md('| Button | 신규 | primary·secondary | default | 대시보드 |'));
    expect(cs).toHaveLength(1);
    expect(cs[0]!.id).toBe('UIUX-COMP-1');
    expect(cs[0]!.source).toBe('uiux-component');
    expect(cs[0]!.description).toContain('Button');
    expect(cs[0]!.description).toContain('primary·secondary');
  });

  test('데이터 상태 셋을 각각 별도 기준으로 쪼갠다', () => {
    const cs = extractComponentCriteria(
      md('| LogTable | 신규 | - | default·빈 상태·에러·로딩 | 대시보드 |'),
    );
    expect(cs.map((c) => c.id)).toEqual([
      'UIUX-COMP-1',
      'UIUX-STATE-1',
      'UIUX-STATE-2',
      'UIUX-STATE-3',
    ]);
    const states = cs.filter((c) => c.source === 'uiux-component-state');
    expect(states.map((c) => c.description)).toEqual([
      expect.stringContaining('빈 상태'),
      expect.stringContaining('에러 상태'),
      expect.stringContaining('로딩 상태'),
    ]);
  });

  test('영문 표기도 인식한다', () => {
    const cs = extractComponentCriteria(md('| List | 신규 | - | empty / error / loading | 목록 |'));
    expect(cs.filter((c) => c.source === 'uiux-component-state')).toHaveLength(3);
  });

  test('상태가 없는 컴포넌트는 상태 기준을 만들지 않는다', () => {
    const cs = extractComponentCriteria(md('| Badge | 신규 | - | default·hover | 전체 |'));
    expect(cs).toHaveLength(1);
  });

  test('`그대로` 는 기준을 만들지 않는다 (회귀 축이 담당)', () => {
    const cs = extractComponentCriteria(md('| AppHeader | 그대로 | - | default·빈 상태 | 전체 |'));
    expect(cs).toEqual([]);
  });

  test('템플릿 범례 행을 기준으로 만들지 않는다', () => {
    // 상태 칸의 "default·hover·disabled …" 는 isPlaceholderCell 이 못 잡는다 —
    // 행 전체 판정만 믿으면 이름이 빈 기준이 새어 들어온다.
    const cs = extractComponentCriteria(md('| | 신규 / 변경 / 그대로 | | default·hover·disabled … | |'));
    expect(cs).toEqual([]);
  });

  test('`## 컴포넌트` 절이 없으면 빈 배열 (예전 UIUX.md 호환)', () => {
    expect(extractComponentCriteria('# UI/UX\n\n## 화면 목록\n\n| 화면 |\n|---|\n| 대시보드 |\n')).toEqual([]);
    expect(extractComponentCriteria('')).toEqual([]);
  });

  test('extractUiuxCriteria 가 컴포넌트 기준까지 함께 낸다 (배선 확인)', () => {
    const full = `# UI/UX — v0.1

## 컴포넌트

| 컴포넌트 | 구분 | 변형 | 상태 | 쓰이는 화면 |
|---|---|---|---|---|
| LogTable | 신규 | - | 빈 상태 | 대시보드 |

## 화면 목록

| 화면 | 구분 | 경로 | 목적 | 대응 기획 항목 |
|---|---|---|---|---|
| 대시보드 | 신규 | /dash | 로그 확인 | F-1 |
`;
    expect(extractUiuxCriteria(full).map((c) => c.id)).toEqual([
      'UIUX-NEW-1',
      'UIUX-COMP-1',
      'UIUX-STATE-1',
    ]);
  });
});

describe('프로토타입 파싱', () => {
  const proto = `<!doctype html>
<html lang="ko" class="dark">
<body>
  <div class="pt-bar" data-collapsed="false">
    <button class="pt-collapse" aria-expanded="true"><span class="pt-brand">v0.1</span></button>
    <div class="pt-bar-body">
      <div class="pt-group">
        <div class="pt-seg" id="seg-state">
          <button data-state="before">수정 전</button>
          <button data-state="after">적용 후</button>
        </div>
      </div>
      <div class="pt-group" id="grp-sort">
        <div class="pt-seg" id="seg-sort"><button data-sort="views">조회수</button></div>
      </div>
    </div>
  </div>
  <div class="pt-stage"><div class="pt-frame">
    <div class="board-shell"><span class="status-badge status-badge--error">실패</span></div>
  </div></div>
</body>
</html>`;

  test('앱 클래스는 pt- 접두를 제외한 것만 (대조 계약 2)', () => {
    const classes = extractAppClasses(proto);
    expect(classes).toContain('board-shell');
    expect(classes).toContain('status-badge');
    expect(classes).toContain('dark');
    expect(classes.some((c) => c.startsWith('pt-'))).toBe(false);
  });

  test('id가 붙은 pt-group만 도입 선택지로 본다 (상태 토글 제외)', () => {
    expect(extractControlGroupIds(proto)).toEqual(['grp-sort']);
  });

  test('before/after 토글 존재를 감지한다', () => {
    expect(hasStateToggle(proto)).toBe(true);
    expect(hasStateToggle('<div data-state="after"></div>')).toBe(false);
  });

  test('수용 기준으로 PT-STRUCT · PT-CTRL-* · PT-REGRESSION 을 만든다', () => {
    const ids = extractPrototypeCriteria(proto).map((c) => c.id);
    expect(ids).toContain('PT-STRUCT');
    expect(ids).toContain('PT-CTRL-grp-sort');
    expect(ids).toContain('PT-REGRESSION');
  });

  test('.pt-frame 이 없으면 폴백 경고를 낸다', () => {
    const warns = prototypeContractWarnings('<div class="pt-bar"></div><div class="app"></div>');
    expect(warns.some((w) => w.includes('pt-frame'))).toBe(true);
  });

  test('외부 URL이 있으면 경고한다 (규격 0절 위반 가능성)', () => {
    const warns = prototypeContractWarnings(
      '<div class="pt-bar"></div><div class="pt-frame"><img src="https://cdn.example.com/a.png"></div>',
    );
    expect(warns.some((w) => w.includes('외부 URL'))).toBe(true);
  });

  test('주석 안의 URL은 경고하지 않는다', () => {
    const warns = prototypeContractWarnings(
      '<div class="pt-bar"></div><div class="pt-frame"><!-- 출처: https://example.com --></div>',
    );
    expect(warns.some((w) => w.includes('외부 URL'))).toBe(false);
  });
});

describe('findDevCycleArtifacts / requiredAcceptanceCriteria', () => {
  function scaffold(opts: { version?: string; uiux?: string; proto?: string }): string {
    const cwd = newSandbox();
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    if (opts.version) {
      writeFileSync(join(cwd, 'docs', 'CYCLE.md'), `- **현재 버전**: ${opts.version}\n`, 'utf8');
      const vd = join(cwd, 'docs', 'versions', opts.version);
      mkdirSync(vd, { recursive: true });
      if (opts.uiux) writeFileSync(join(vd, 'UIUX.md'), opts.uiux, 'utf8');
      if (opts.proto) {
        mkdirSync(join(vd, 'prototype'), { recursive: true });
        writeFileSync(join(vd, 'prototype', 'index.html'), opts.proto, 'utf8');
      }
    }
    return cwd;
  }

  test('CYCLE.md가 없으면 null — dev-cycle을 안 쓰는 프로젝트', () => {
    const cwd = newSandbox();
    expect(findDevCycleArtifacts(cwd)).toBe(null);
    expect(requiredAcceptanceCriteria(cwd)).toEqual([]);
  });

  test('버전 폴더가 없으면 null (경로만 있고 산출물 없음)', () => {
    const cwd = newSandbox();
    mkdirSync(join(cwd, 'docs'), { recursive: true });
    writeFileSync(join(cwd, 'docs', 'CYCLE.md'), '- **현재 버전**: v9.9\n', 'utf8');
    expect(findDevCycleArtifacts(cwd)).toBe(null);
  });

  test('UIUX + 프로토타입이 있으면 두 출처의 기준을 합친다', () => {
    const cwd = scaffold({
      version: 'v0.1',
      uiux: '## 화면 목록\n\n| 화면 | 구분 |\n|---|---|\n| 설정 | 신규 |\n',
      proto:
        '<div class="pt-bar"><div class="pt-group" id="grp-sort"></div>' +
        '<button data-state="before"></button><button data-state="after"></button></div>' +
        '<div class="pt-frame"><div class="board"></div></div>',
    });
    const ids = requiredAcceptanceCriteria(cwd).map((c) => c.id);
    expect(ids).toContain('UIUX-NEW-1');
    expect(ids).toContain('PT-CTRL-grp-sort');
    expect(ids).toContain('PT-STRUCT');
    expect(ids).toContain('PT-REGRESSION');
  });

  test('프로토타입만 있고 UIUX가 없어도 동작한다', () => {
    const cwd = scaffold({
      version: 'v0.2',
      proto: '<div class="pt-frame"><div class="board"></div></div>',
    });
    const ids = requiredAcceptanceCriteria(cwd).map((c) => c.id);
    expect(ids).toEqual(['PT-STRUCT']);
  });
});
