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
