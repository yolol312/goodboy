// lib/test-validator.ts — 층1 테스트 게이트의 판정 로직.
//
// 여기서 지키려는 성질은 하나다: **통과했다는 주장만으로는 인정하지 않는다.**
// red-green 증거, 뮤테이션 프로브, 파일 실재, 가짜 테스트 패턴이 전부 그 성질을 위한 것이다.

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AcceptanceCoverage, TestResult } from '../lib/types';
import {
  detectTestInfrastructure,
  evidenceProblems,
  failingSuites,
  isDocFile,
  isTestFile,
  missingTestFiles,
  requiresMutationProbe,
  scanForbiddenPatterns,
  stripLiteralsAndComments,
  uncoveredCriteria,
  validateEvidence,
  validateTestCoverage,
} from '../lib/test-validator';

const sandboxes: string[] = [];
function newSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodboy-testval-'));
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

function cov(over: Partial<AcceptanceCoverage> = {}): AcceptanceCoverage {
  return {
    id: 'AC-1',
    description: '설명',
    test: 'tests/a.test.ts',
    red: { command: 'git stash && bun test', output: '1 fail', exit_code: 1 },
    green: { command: 'git stash pop && bun test', output: '1 pass', exit_code: 0 },
    ...over,
  };
}

function result(over: Partial<TestResult> = {}): TestResult {
  return {
    timestamp: new Date().toISOString(),
    tested_files: ['/abs/a.ts'],
    category: 'add-feature',
    test_files: [],
    environment: { mode: 'none' },
    suites: [],
    acceptance: [],
    verdict: 'pass',
    ...over,
  };
}

describe('evidenceProblems — red-green', () => {
  test('정상 red(실패)+green(성공)은 문제가 없다', () => {
    expect(evidenceProblems(cov())).toEqual([]);
  });

  test('red가 성공(exit 0)이면 거부 — 되돌려도 통과하는 테스트는 아무것도 검증하지 않는다', () => {
    const problems = evidenceProblems(cov({ red: { command: 'x', output: 'ok', exit_code: 0 } }));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain('아무것도 검증하지 않습니다');
  });

  test('red에 exit_code가 없으면 거부 — 실패를 종료 코드로 증명해야 한다', () => {
    const problems = evidenceProblems(cov({ red: { command: 'x', output: '실패한 것 같음' } }));
    expect(problems.some((p) => p.includes('exit_code'))).toBe(true);
  });

  test('green이 실패면 거부', () => {
    const problems = evidenceProblems(cov({ green: { command: 'x', output: 'boom', exit_code: 1 } }));
    expect(problems.some((p) => p.includes('green 증거가 실패'))).toBe(true);
  });

  test('red 명령이 비어 있으면 거부', () => {
    const problems = evidenceProblems(cov({ red: { command: '   ', output: '', exit_code: 1 } }));
    expect(problems.some((p) => p.includes('실행한 명령이 없습니다'))).toBe(true);
  });
});

describe('뮤테이션 프로브 요구 범위', () => {
  test('UI 축(PT-/UIUX-) 기준만 뮤테이션을 요구한다', () => {
    expect(requiresMutationProbe('PT-CTRL-grp-sort')).toBe(true);
    expect(requiresMutationProbe('UIUX-CHG-1')).toBe(true);
    expect(requiresMutationProbe('AC-1')).toBe(false);
  });

  test('UI 기준에 뮤테이션이 없으면 거부', () => {
    const problems = evidenceProblems(cov({ id: 'PT-STRUCT' }));
    expect(problems.some((p) => p.includes('뮤테이션 프로브가 없습니다'))).toBe(true);
  });

  test('뮤테이션이 실패를 감지하지 못하면(detected=false) 거부 — 그 테스트는 무효', () => {
    const problems = evidenceProblems(
      cov({ id: 'PT-STRUCT', mutation: { command: 'remove node', output: '1 passed', detected: false } }),
    );
    expect(problems.some((p) => p.includes('감지하지 못했습니다'))).toBe(true);
  });

  test('뮤테이션이 감지했으면 통과', () => {
    expect(
      evidenceProblems(
        cov({ id: 'PT-STRUCT', mutation: { command: 'remove node', output: '1 failed', detected: true } }),
      ),
    ).toEqual([]);
  });

  test('비-UI 기준은 뮤테이션 없이도 통과', () => {
    expect(evidenceProblems(cov({ id: 'AC-9' }))).toEqual([]);
  });
});

describe('validateEvidence — 결과 전체', () => {
  test('문제가 없으면 null', () => {
    expect(validateEvidence([result({ acceptance: [cov()] })])).toBe(null);
  });

  test('문제가 있으면 사유 문자열', () => {
    const bad = result({ acceptance: [cov({ red: { command: 'x', output: '', exit_code: 0 } })] });
    expect(validateEvidence([bad])).toContain('아무것도 검증하지 않습니다');
  });

  test('acceptance가 비면 거부 — red-green 전체를 건너뛰는 우회 (라이브 실측)', () => {
    // dev-cycle 산출물이 없으면 필수 기준이 비어 커버리지 검사도 통과한다.
    // 그때 acceptance까지 비면 이 게이트는 "테스트가 돌았다"만 확인하게 된다.
    expect(validateEvidence([result({ acceptance: [] })])).toContain('acceptance가 비어 있습니다');
  });

  test('결과가 아예 없으면 이 규칙을 적용하지 않는다 (커버리지 검사 소관)', () => {
    expect(validateEvidence([])).toBe(null);
  });

  test('여러 결과 중 하나라도 acceptance가 있으면 통과', () => {
    expect(validateEvidence([result({ acceptance: [] }), result({ acceptance: [cov()] })])).toBe(null);
  });
});

describe('failingSuites', () => {
  test('전부 통과면 null', () => {
    const r = result({ suites: [{ name: 'unit', command: 'bun test', passed: 3, failed: 0, output: '' }] });
    expect(failingSuites([r])).toBe(null);
  });

  test('실패가 있으면 스위트 이름과 건수를 보고한다', () => {
    const r = result({ suites: [{ name: 'e2e', command: 'pw', passed: 1, failed: 2, output: '' }] });
    expect(failingSuites([r])).toContain('e2e(2건 실패)');
  });
});

describe('missingTestFiles — 테스트는 repo에 남는 자산이어야 한다', () => {
  test('실재하는 파일이면 null', () => {
    const dir = newSandbox();
    const f = join(dir, 'a.test.ts');
    writeFileSync(f, 'test("x", () => {});', 'utf8');
    expect(missingTestFiles([result({ test_files: [f] })])).toBe(null);
  });

  test('없는 파일이면 거부 — 임시 프로브를 테스트로 위장한 경우', () => {
    const msg = missingTestFiles([result({ test_files: ['/nope/gone.test.ts'] })]);
    expect(msg).toContain('존재하지 않습니다');
    expect(msg).toContain('임시 프로브가 아님');
  });
});

describe('uncoveredCriteria', () => {
  const required = [
    { id: 'PT-STRUCT', source: 'prototype-structure' as const, description: '구조' },
    { id: 'UIUX-NEW-1', source: 'uiux-new' as const, description: '신규 화면' },
  ];

  test('전부 커버하면 빈 배열', () => {
    const r = result({ acceptance: [cov({ id: 'PT-STRUCT' }), cov({ id: 'UIUX-NEW-1' })] });
    expect(uncoveredCriteria([r], required)).toEqual([]);
  });

  test('일부만 커버하면 나머지를 돌려준다', () => {
    const r = result({ acceptance: [cov({ id: 'PT-STRUCT' })] });
    expect(uncoveredCriteria([r], required).map((c) => c.id)).toEqual(['UIUX-NEW-1']);
  });

  test('required가 비면 강제하지 않는다 (dev-cycle 미사용 프로젝트)', () => {
    expect(uncoveredCriteria([result()], [])).toEqual([]);
  });

  test('여러 결과의 커버리지를 합집합으로 본다 (테스트 분할 실행)', () => {
    const a = result({ acceptance: [cov({ id: 'PT-STRUCT' })] });
    const b = result({ acceptance: [cov({ id: 'UIUX-NEW-1' })] });
    expect(uncoveredCriteria([a, b], required)).toEqual([]);
  });
});

describe('scanForbiddenPatterns — 통과하지만 아무것도 검증하지 않는 테스트', () => {
  function withContent(content: string): string {
    const dir = newSandbox();
    const f = join(dir, 'x.spec.ts');
    writeFileSync(f, content, 'utf8');
    return f;
  }

  test('waitForTimeout을 잡는다', () => {
    const hits = scanForbiddenPatterns([withContent('await page.waitForTimeout(3000);')]);
    expect(hits.map((h) => h.key)).toContain('wait-timeout');
  });

  test('빈 catch를 잡는다', () => {
    const hits = scanForbiddenPatterns([withContent('await page.click("#a").catch(() => {});')]);
    expect(hits.map((h) => h.key)).toContain('swallowed-catch');
  });

  test('항상 참인 단언을 잡는다', () => {
    const hits = scanForbiddenPatterns([
      withContent('expect(await page.locator(".i").count()).toBeGreaterThanOrEqual(0);'),
    ]);
    expect(hits.map((h) => h.key)).toContain('always-true-count');
  });

  test('skip/todo 테스트를 잡는다', () => {
    const hits = scanForbiddenPatterns([withContent('test.skip("나중에", () => {});')]);
    expect(hits.map((h) => h.key)).toContain('skipped-test');
  });

  test('정상 테스트는 걸리지 않는다', () => {
    const hits = scanForbiddenPatterns([
      withContent('await expect(page.getByRole("button", { name: "저장" })).toBeVisible();'),
    ]);
    expect(hits).toEqual([]);
  });

  test('읽을 수 없는 파일은 건너뛴다 (fail-open)', () => {
    expect(scanForbiddenPatterns(['/nope/none.ts'])).toEqual([]);
  });

  // 자기-호스팅 결함(라이브 실측): 이 스캐너를 검증하는 메타 테스트는 금지 패턴을
  // **픽스처 문자열로 반드시 포함**한다. 그걸 위반으로 세면 해소 방법이 "정당한 테스트를
  // 지우기"밖에 없어 게이트가 영구 오탐이 된다 — goodboy 자신의 테스트 2개가 실제로
  // 걸려서, 층1이 이 저장소에서 통과 불가능했다.
  test('문자열 리터럴 안의 금지 패턴은 위반이 아니다 (실행되지 않는다)', () => {
    const src = [
      'const bad = "await page.waitForTimeout(3000);";',
      "const bad2 = 'test.skip(\"x\", () => {});';",
      'const bad3 = `expect(n).toBeGreaterThanOrEqual(0)`;',
      'expect(scan([bad, bad2, bad3])).toHaveLength(3);',
    ].join('\n');
    expect(scanForbiddenPatterns([withContent(src)])).toEqual([]);
  });

  test('주석 안의 금지 패턴도 위반이 아니다', () => {
    const src = [
      '// waitForTimeout 을 쓰지 마세요',
      '/* test.skip 으로 남기지 마세요 */',
      'await expect(page.getByRole("button")).toBeVisible();',
    ].join('\n');
    expect(scanForbiddenPatterns([withContent(src)])).toEqual([]);
  });

  test('실행되는 코드의 금지 패턴은 여전히 잡는다 (문자열로 숨겨도 소용없게)', () => {
    const src = [
      'const doc = "waitForTimeout 은 금지";',
      'await page.waitForTimeout(1000);',
    ].join('\n');
    expect(scanForbiddenPatterns([withContent(src)]).map((h) => h.key)).toContain('wait-timeout');
  });

  test('정규식의 \\/ 를 줄 주석으로 오인해 그 줄을 통째로 지우지 않는다', () => {
    // 오인하면 뒤따르는 실제 위반이 조용히 사라진다(= 미검출). 위반 방향으로 틀리면 안 된다.
    const src = 'const re = /https?:\\/\\//; await page.waitForTimeout(500);';
    expect(scanForbiddenPatterns([withContent(src)]).map((h) => h.key)).toContain('wait-timeout');
  });

  test('닫히지 않은 아포스트로피가 파일 끝까지 삼키지 않는다', () => {
    // "don't" 같은 주석 속 아포스트로피 하나로 이후 전부가 문자열 취급되면
    // 그 아래 모든 위반이 숨는다. 따옴표 문자열은 줄을 넘지 않는다.
    const src = ["const s = 'don", 'await page.waitForTimeout(500);'].join('\n');
    expect(scanForbiddenPatterns([withContent(src)]).map((h) => h.key)).toContain('wait-timeout');
  });

  test('goodboy 자신의 메타 테스트가 위반으로 잡히지 않는다 (자기-호스팅 회귀)', () => {
    const own = [
      resolve(import.meta.dir, 'test-validator.test.ts'),
      resolve(import.meta.dir, 'stop-test-gate.test.ts'),
    ];
    expect(scanForbiddenPatterns(own)).toEqual([]);
  });
});

describe('stripLiteralsAndComments', () => {
  test('길이와 줄 구조를 보존한다 (오프셋 기반 보고를 깨지 않게)', () => {
    const src = 'const a = "xx";\n// c\nconst b = 1;\n';
    const out = stripLiteralsAndComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain('const a = "');
    expect(out).not.toContain('xx');
  });

  test('빈/비문자열 입력은 빈 문자열', () => {
    expect(stripLiteralsAndComments('')).toBe('');
    // @ts-expect-error 런타임 견고성 확인
    expect(stripLiteralsAndComments(null)).toBe('');
  });
});

describe('isTestFile — 테스트 파일은 커버리지 요구 대상이 아니다', () => {
  test('확장자 규칙 (.test./.spec.)', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/a.spec.tsx')).toBe(true);
    expect(isTestFile('src/a.test.mjs')).toBe(true);
  });

  test('디렉터리 규칙 (tests/ __tests__/ e2e/)', () => {
    expect(isTestFile('tests/hello.ts')).toBe(true);
    expect(isTestFile('src/__tests__/a.ts')).toBe(true);
    expect(isTestFile('e2e/board.ts')).toBe(true);
  });

  test('다른 언어 관례', () => {
    expect(isTestFile('test_utils.py')).toBe(true);
    expect(isTestFile('utils_test.go')).toBe(true);
  });

  test('일반 소스는 테스트 파일이 아니다', () => {
    expect(isTestFile('src/a.ts')).toBe(false);
    expect(isTestFile('package.json')).toBe(false);
    expect(isTestFile('src/latest.ts')).toBe(false); // 'test'가 부분문자열로 들어간 이름
    expect(isTestFile('')).toBe(false);
  });
});

// 라이브 실측: 문서만 고친 턴에 층1이 README.md·agents/*.md·skills/*.md 5개를 두고
// "테스트되지 않은 변경 파일"로 차단했다. README를 단위 테스트할 수는 없으니 해소
// 방법이 없고, 3회 차단 후 escape로만 끝난다 — 게이트의 최악 결말이다.
describe('isDocFile — 문서는 커버리지 요구 대상이 아니다', () => {
  test('문서 확장자를 인식한다 (추론 게이트의 면제 목록과 동일)', () => {
    for (const f of [
      'README.md',
      'docs/GUIDE.markdown',
      'site/page.mdx',
      'notes.txt',
      'doc.rst',
      'a.adoc',
      'b.asciidoc',
    ]) {
      expect(isDocFile(f)).toBe(true);
    }
  });

  test('대소문자를 가리지 않는다', () => {
    expect(isDocFile('README.MD')).toBe(true);
  });

  test('소스는 문서가 아니다', () => {
    expect(isDocFile('src/a.ts')).toBe(false);
    expect(isDocFile('lib/readme.ts')).toBe(false); // 이름에 readme가 들어갈 뿐
    expect(isDocFile('mdx.ts')).toBe(false); // 확장자가 아니라 이름에 mdx
    expect(isDocFile('')).toBe(false);
  });
});

describe('validateTestCoverage', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const now = new Date().toISOString();

  test('결과가 없으면 실패', () => {
    expect(validateTestCoverage([], [{ file: '/a.ts', lastEditTimestamp: past }]).ok).toBe(false);
  });

  test('변경 파일을 커버하고 편집보다 나중이면 통과', () => {
    const r = result({ timestamp: now, tested_files: ['/a.ts'] });
    expect(validateTestCoverage([r], [{ file: '/a.ts', lastEditTimestamp: past }]).ok).toBe(true);
  });

  test('커버하지 않은 변경 파일이 있으면 실패', () => {
    const r = result({ timestamp: now, tested_files: ['/a.ts'] });
    const v = validateTestCoverage([r], [
      { file: '/a.ts', lastEditTimestamp: past },
      { file: '/b.ts', lastEditTimestamp: past },
    ]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('테스트되지 않은 변경 파일');
  });

  test('편집보다 오래된 결과는 stale로 거부', () => {
    const r = result({ timestamp: past, tested_files: ['/a.ts'] });
    const v = validateTestCoverage([r], [{ file: '/a.ts', lastEditTimestamp: now }]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('오래된');
  });

  test('미래 timestamp 결과는 위조로 보고 배제한다 (게이트 우회 방지)', () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const r = result({ timestamp: future, tested_files: ['/a.ts'] });
    const v = validateTestCoverage([r], [{ file: '/a.ts', lastEditTimestamp: past }]);
    expect(v.ok).toBe(false);
  });

  test('verdict=fail인 결과가 그 파일의 최신이면 실패', () => {
    const r = result({ timestamp: now, tested_files: ['/a.ts'], verdict: 'fail' });
    const v = validateTestCoverage([r], [{ file: '/a.ts', lastEditTimestamp: past }]);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('fail');
  });

  test('부분 결과 2개가 합쳐 전체를 커버하면 통과', () => {
    const a = result({ timestamp: now, tested_files: ['/a.ts'] });
    const b = result({ timestamp: now, tested_files: ['/b.ts'] });
    const v = validateTestCoverage([a, b], [
      { file: '/a.ts', lastEditTimestamp: past },
      { file: '/b.ts', lastEditTimestamp: past },
    ]);
    expect(v.ok).toBe(true);
  });
});

// 지키려는 성질: **강제할 수단이 있을 때만 강제한다.** 테스트를 돌릴 방법이 없는
// 저장소에서 게이트를 켜 두면 3회 차단 후 escape로 끝난다 — 검증은 0이고 경고만 남는다.
describe('detectTestInfrastructure', () => {
  test('빈 저장소는 인프라 없음', () => {
    expect(detectTestInfrastructure(newSandbox()).present).toBe(false);
  });

  test('테스트 디렉터리를 신호로 본다', () => {
    for (const d of ['tests', 'test', '__tests__', 'spec', 'e2e']) {
      const cwd = newSandbox();
      mkdirSync(join(cwd, d), { recursive: true });
      const sig = detectTestInfrastructure(cwd);
      expect(sig.present).toBe(true);
      expect(sig.evidence).toBe(`${d}/`);
    }
  });

  test('테스트 설정 파일을 신호로 본다', () => {
    const cwd = newSandbox();
    writeFileSync(join(cwd, 'playwright.config.ts'), '', 'utf8');
    expect(detectTestInfrastructure(cwd).evidence).toBe('playwright.config.ts');
  });

  test('npm init 자리표시자 scripts.test 는 신호가 아니다', () => {
    const cwd = newSandbox();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      'utf8',
    );
    expect(detectTestInfrastructure(cwd).present).toBe(false);
  });

  test('실제 scripts.test 는 신호다', () => {
    const cwd = newSandbox();
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8');
    expect(detectTestInfrastructure(cwd).present).toBe(true);
  });

  test('pyproject.toml 은 pytest 언급이 있을 때만 신호다', () => {
    const a = newSandbox();
    writeFileSync(join(a, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf8');
    expect(detectTestInfrastructure(a).present).toBe(false);

    const b = newSandbox();
    writeFileSync(join(b, 'pyproject.toml'), '[tool.pytest.ini_options]\n', 'utf8');
    expect(detectTestInfrastructure(b).present).toBe(true);
  });

  test('언어 표준 러너가 있는 생태계는 그 자체가 신호다', () => {
    const go = newSandbox();
    writeFileSync(join(go, 'go.mod'), 'module x\n', 'utf8');
    expect(detectTestInfrastructure(go).present).toBe(true);

    const rust = newSandbox();
    writeFileSync(join(rust, 'Cargo.toml'), '[package]\nname = "x"\n', 'utf8');
    expect(detectTestInfrastructure(rust).present).toBe(true);
  });

  test('깨진 package.json은 "없음"으로 본다 — 확신 없이 차단하지 않는다', () => {
    const cwd = newSandbox();
    writeFileSync(join(cwd, 'package.json'), '{ broken', 'utf8');
    expect(detectTestInfrastructure(cwd).present).toBe(false);
  });
});
