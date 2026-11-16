// Track M, M6c (plan §19): the Stop gate's list of the files the sandbox commands write (lib/sandbox-gate.ts) holds the data helper
// files, and a test may import the helper the way it imports the e2e fixture without taking away the helper's exemption.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isSandboxLayout, sandboxExemptRel, sandboxTestRel, sandboxUsed, sandboxUsers } from '../lib/sandbox-gate';

const dirs: string[] = [];
afterAll(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const project = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6c-gate-')));
  dirs.push(d);
  return d;
};
const write = (root: string, rel: string, text: string): string => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};

describe('the layout of the sandbox dir', () => {
  test('the three helper files are layout files, and nothing else under data/ is (the manifest is the project\'s own file)', () => {
    for (const f of ['data/goodboy-data.ts', 'data/goodboy-data.cjs', 'data/GoodboyData.java']) expect([f, isSandboxLayout(f)]).toEqual([f, true]);
    for (const f of ['data.json', 'data/values.tsv', 'data/other.ts', 'data/goodboy-data.js', 'data/x/goodboy-data.ts', 'GoodboyData.java']) expect([f, isSandboxLayout(f)]).toEqual([f, false]);
  });

  test('an edit of a helper file leaves the layer-1 rules, and a sandbox run is its test (not run-only, like the e2e files)', () => {
    const d = project();
    const p = write(d, '.goodboy/sandbox/data/goodboy-data.ts', 'export {};\n');
    expect(sandboxExemptRel(p, d)).toBe('data/goodboy-data.ts');
    expect(sandboxTestRel(p, d)).toBe('data/goodboy-data.ts');
    // the manifest is no layout file: it is the project's own file
    expect(sandboxExemptRel(write(d, '.goodboy/sandbox/data.json', '{"version":1}\n'), d)).toBeNull();
  });
});

describe('a test that imports the data helper', () => {
  const f = (d: string, rel: string, text: string): string => write(d, rel, text);

  test('uses it without losing the exemption: for the TS helper, the CJS helper, by import or require, in a unit test or an e2e test', () => {
    const d = project();
    const users = sandboxUsers(d, [
      f(d, 'src/a.test.ts', "import { pick, assertMatches } from '../.goodboy/sandbox/data/goodboy-data';\nconst c = '.goodboy/sandbox/compose.yml';\n"),
      f(d, 'src/b.test.js', "const { pick } = require('../.goodboy/sandbox/data/goodboy-data.cjs');\n"),
      f(d, 'e2e/c.spec.ts', "import { fillFrom } from '../.goodboy/sandbox/data/goodboy-data';\nimport { uiTest } from '../.goodboy/sandbox/e2e/goodboy-ui';\n"),
    ]);
    expect(users.files.size).toBe(0);
    expect(users.all).toBe(false);
    expect(sandboxUsed(users, 'data/goodboy-data.ts')).toBe(false);
    expect(sandboxUsed(users, 'data/goodboy-data.cjs')).toBe(false);
  });

  test('a specifier that ends in /index, index.ts or index.js names the same file as without it (the e2e fixture and the helper)', () => {
    const d = project();
    const specifiers = [
      '../.goodboy/sandbox/data/goodboy-data/index',
      '../.goodboy/sandbox/data/goodboy-data/index.ts',
      '../.goodboy/sandbox/data/goodboy-data/index.js',
      '../.goodboy/sandbox/e2e/goodboy-ui/index',
      '../.goodboy/sandbox/e2e/goodboy-ui/index.ts',
      '../.goodboy/sandbox/e2e/goodboy-ui/index.js',
    ];
    for (const [i, spec] of specifiers.entries()) {
      const users = sandboxUsers(d, [f(d, `src/idx${i}.test.ts`, `import * as x from '${spec}';\nvoid x;\n`)]);
      // the module the specifier names, however it is spelled, is no use of it: a test may import it so
      expect([spec, [...users.files], users.all]).toEqual([spec, [], false]);
    }
    // another layout file, named the same way, is still a use
    for (const spec of ['overrides/index', 'overrides/index.ts', 'overrides/index.js']) {
      const users = sandboxUsers(d, [f(d, 'src/other.test.ts', `import * as x from '../.goodboy/sandbox/${spec}';\nvoid x;\n`)]);
      expect([spec, users.files.has(spec.replace(/\.[cm]?[jt]sx?$/, ''))]).toEqual([spec, true]);
    }
    // production code that imports the fixture through an index is its user, as it is without one
    expect(sandboxUsers(d, [f(d, 'src/prod.ts', "import * as x from '../.goodboy/sandbox/e2e/goodboy-ui/index.ts';\nvoid x;\n")]).files.has('e2e/goodboy-ui/index.ts')).toBe(true);
  });

  test('a directory named like the fixture or the helper is another module: its index is a use, as is a stacked index', () => {
    const d = project();
    for (const spec of ['e2e/goodboy-ui.js/index', 'e2e/goodboy-ui.ts/index.ts', 'data/goodboy-data.cjs/index', 'e2e/goodboy-ui/index/index', 'e2e/goodboy-ui/index.ts/index']) {
      const users = sandboxUsers(d, [f(d, 'src/dir.test.ts', `import * as x from '../.goodboy/sandbox/${spec}';\nvoid x;\n`)]);
      expect([spec, users.files.size > 0 || users.all]).toEqual([spec, true]);
    }
  });

  test('production code that imports it is a user of it: the helper is then judged as code', () => {
    const d = project();
    const users = sandboxUsers(d, [f(d, 'src/h.ts', "import { pick } from '../.goodboy/sandbox/data/goodboy-data';\n")]);
    expect(users.files.has('data/goodboy-data')).toBe(true);
    expect(sandboxUsed(users, 'data/goodboy-data.ts')).toBe(true);
  });

  test('a test that imports any other layout file is still its user, and a file that names the dir some other way is all of them', () => {
    const d = project();
    expect(sandboxUsers(d, [f(d, 'src/x.test.ts', "import raw from '../.goodboy/sandbox/overrides/sandbox.env';\n")]).files.has('overrides/sandbox.env')).toBe(true);
    expect(sandboxUsers(d, [f(d, 'src/y.ts', "const p = join(root, '.goodboy/sandbox/data/GoodboyData.java');\n")]).all).toBe(true);
    // naming the helper by its path in a non-test file is a plain mention of the helper, not of the dir at large
    expect(sandboxUsers(d, [f(d, 'src/z.ts', "// see .goodboy/sandbox/data/goodboy-data\nexport const z = 1;\n")]).all).toBe(false);
    expect(sandboxUsers(d, [f(d, 'src/w.ts', "export const w = '.goodboy/sandbox/data/goodboy-data';\n")]).all).toBe(false);
  });
});
