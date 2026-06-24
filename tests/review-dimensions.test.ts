import { describe, expect, test } from 'bun:test';
import { requiredDimensionsFor } from '../lib/review-dimensions';

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

  test('plain util code file requires only performance (no security/a11y)', () => {
    const dims = requiredDimensionsFor(['util.ts']);
    expect(dims).toEqual(['performance']);
    expect(dims).not.toContain('proto-pollution');
    expect(dims).not.toContain('web-hardening');
    expect(dims).not.toContain('ui-ux-accessibility');
  });

  test('input-parser-named code file triggers error-path + proto-pollution', () => {
    const dims = requiredDimensionsFor(['lib/cookie-parser.ts']);
    expect(dims).toContain('error-path');
    expect(dims).toContain('proto-pollution');
  });

  test('non-code files (e.g. README.md, data.json) require nothing', () => {
    expect(requiredDimensionsFor(['README.md'])).toEqual([]);
    expect(requiredDimensionsFor(['package.json'])).toEqual([]);
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
