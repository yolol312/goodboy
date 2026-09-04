import { describe, expect, test } from 'bun:test';
import { AXIS_DIMENSIONS, axesFor, requiredDimensionsFor } from '../lib/review-dimensions';

describe('axesFor — 병렬 리뷰 축 결정', () => {
  test('hallucination 축은 변경 내용과 무관하게 항상 포함된다', () => {
    expect(axesFor([])).toEqual(['hallucination']);
    expect(axesFor(['README.md'])).toEqual(['hallucination']);
    expect(axesFor(['util.ts'])).toContain('hallucination');
  });

  test('코드 파일이면 refactoring · security · performance 축이 붙는다', () => {
    const axes = axesFor(['util.ts']);
    expect(axes).toContain('refactoring');
    expect(axes).toContain('security');
    expect(axes).toContain('performance');
    expect(axes).not.toContain('ui'); // 프론트엔드 신호 없음
  });

  test('프론트엔드 변경이면 ui 축이 붙는다', () => {
    expect(axesFor(['index.html'])).toContain('ui');
  });

  test('의존성 매니페스트만 바뀌면 security 축만 붙는다', () => {
    const axes = axesFor(['package.json']);
    expect(axes).toEqual(['hallucination', 'security']);
  });

  test('축에 배정된 차원의 합집합이 필수 차원을 모두 덮는다 (커버 불가 차원 없음)', () => {
    const files = ['index.html', 'src/server.ts', 'src/db/query.ts', 'src/auth/login.ts', 'package.json', '.env'];
    const required = requiredDimensionsFor(files);
    const covered = new Set(axesFor(files).flatMap((a) => AXIS_DIMENSIONS[a]));
    const orphans = required.filter((d) => !covered.has(d));
    expect(orphans).toEqual([]);
  });
});

describe('requiredDimensionsFor', () => {
  test('server code requires web-hardening + error-path (+ proto-pollution)', () => {
    const dims = requiredDimensionsFor(['src/server.ts']);
    expect(dims).toContain('web-hardening');
    expect(dims).toContain('error-path');
    expect(dims).toContain('proto-pollution');
  });

  test('route/api files trigger server dimensions', () => {
    expect(requiredDimensionsFor(['app/api/users.ts'])).toContain('web-hardening');
    expect(requiredDimensionsFor(['lib/router.ts'])).toContain('web-hardening');
    expect(requiredDimensionsFor(['handlers/request-handler.js'])).toContain('web-hardening');
  });

  test('HTML files require ui-ux-accessibility + plan-completeness', () => {
    const dims = requiredDimensionsFor(['index.html']);
    expect(dims).toContain('ui-ux-accessibility');
    expect(dims).toContain('plan-completeness');
  });

  test('CSS / JSX / client JS trigger frontend dimensions', () => {
    expect(requiredDimensionsFor(['styles/main.css'])).toContain('ui-ux-accessibility');
    expect(requiredDimensionsFor(['components/Button.tsx'])).toContain('ui-ux-accessibility');
    expect(requiredDimensionsFor(['src/app.client.ts'])).toContain('ui-ux-accessibility');
  });

  test('plain util code file requires performance + refactoring + secrets (no web/a11y)', () => {
    // 층2 재편: 리팩토링·시크릿은 변경의 종류를 가리지 않으므로 코드 파일이면 항상 요구된다.
    const dims = requiredDimensionsFor(['util.ts']);
    expect(dims).toEqual(['performance', 'refactoring-quality', 'security-secrets']);
    expect(dims).not.toContain('proto-pollution');
    expect(dims).not.toContain('web-hardening');
    expect(dims).not.toContain('ui-ux-accessibility');
    expect(dims).not.toContain('security-injection');
    expect(dims).not.toContain('security-authz');
  });

  test('input-parser-named code file triggers error-path + proto-pollution', () => {
    const dims = requiredDimensionsFor(['lib/cookie-parser.ts']);
    expect(dims).toContain('error-path');
    expect(dims).toContain('proto-pollution');
  });

  test('plain non-code files require nothing', () => {
    expect(requiredDimensionsFor(['README.md'])).toEqual([]);
    expect(requiredDimensionsFor(['docs/data.json'])).toEqual([]);
  });

  test('dependency manifests require dependency-risk', () => {
    expect(requiredDimensionsFor(['package.json'])).toEqual(['dependency-risk']);
    expect(requiredDimensionsFor(['bun.lock'])).toEqual(['dependency-risk']);
    expect(requiredDimensionsFor(['requirements.txt'])).toEqual(['dependency-risk']);
    // 이름이 비슷하지만 매니페스트가 아닌 파일은 트리거하지 않는다.
    expect(requiredDimensionsFor(['docs/package.json.md'])).toEqual([]);
  });

  test('config-like files require security-secrets', () => {
    expect(requiredDimensionsFor(['.env'])).toEqual(['security-secrets']);
    expect(requiredDimensionsFor(['deploy/docker-compose.yml'])).toEqual(['security-secrets']);
  });

  test('injection / authz surfaces trigger their security dimensions', () => {
    expect(requiredDimensionsFor(['src/db/query.ts'])).toContain('security-injection');
    expect(requiredDimensionsFor(['src/auth/login.ts'])).toContain('security-authz');
    // 코드 파일이 아니면 트리거하지 않는다(문서에 sql이 들어가도).
    expect(requiredDimensionsFor(['docs/sql-guide.md'])).toEqual([]);
  });

  test('empty / invalid input returns []', () => {
    expect(requiredDimensionsFor([])).toEqual([]);
    // @ts-expect-error testing runtime robustness
    expect(requiredDimensionsFor(null)).toEqual([]);
    expect(requiredDimensionsFor(['', '   '])).toEqual([]);
  });

  test('multiple files union their dimensions (deduped + sorted)', () => {
    const dims = requiredDimensionsFor(['index.html', 'src/server.ts', 'util.ts']);
    expect(dims).toContain('ui-ux-accessibility');
    expect(dims).toContain('plan-completeness');
    expect(dims).toContain('web-hardening');
    expect(dims).toContain('error-path');
    expect(dims).toContain('proto-pollution');
    expect(dims).toContain('performance');
    // sorted + unique
    expect([...dims]).toEqual([...new Set(dims)].sort());
  });

  test('absolute paths work the same', () => {
    expect(requiredDimensionsFor(['/abs/repo/src/server.ts'])).toContain('web-hardening');
    expect(requiredDimensionsFor(['/abs/repo/public/index.html'])).toContain(
      'ui-ux-accessibility',
    );
  });
});
