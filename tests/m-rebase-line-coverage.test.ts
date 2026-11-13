// Track M rebase (plan §19): the two catches that no input reaches. The config parsers never throw on any
// input tried (lines up to 900 KB, JSON nested 100000 deep, NUL and lone-surrogate text), and scanSandbox did
// not throw on any input tried, so the guards run only when a call that never throws throws. The first test uses
// the `parseConfig` test seam of ScanOptions; the second makes scanSandbox throw in this process only:
// `mock.module` patches it, and the original is put back after every test and after the file (the unit tests
// share one process; see tests/i3914-injected-faults.test.ts).
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as sandboxScan from '../lib/sandbox-scan';
import { uiInventory } from '../lib/ui-inventory';

const original = { ...sandboxScan };
const restore = (): void => {
  mock.module('../lib/sandbox-scan', () => original);
};
const dirs: string[] = [];
afterEach(() => {
  restore();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
afterAll(restore);

function project(files: Record<string, string>, git = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mrebase-')));
  dirs.push(root);
  if (git) Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('scanSandbox when a config parser fails', () => {
  test('the file is a question, not a crash, and the scan goes on', () => {
    const root = project({ 'package.json': JSON.stringify({ name: 'a', dependencies: { express: '4' } }), '.env': 'PORT=4000\n' });
    const s = sandboxScan.scanSandbox(root, {
      files: ['package.json', '.env'],
      parseConfig: () => {
        throw new Error('the parser failed');
      },
    });
    expect(s.questions).toContain('.env could not be parsed: its hosts and stores are unknown');
    expect(s.stack).toBe('node');
    // the real parser reads the same file
    expect(sandboxScan.scanSandbox(root, { files: ['package.json', '.env'] }).app.port).toBe(4000);
  });
});

describe('uiInventory when the sandbox scan fails and none is saved', () => {
  test('the context path falls back to `/`', () => {
    const root = project(
      {
        'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }\n",
        'src/main/resources/application.yml': 'server:\n  servlet:\n    context-path: /shop\n',
      },
      true,
    );
    mock.module('../lib/sandbox-scan', () => ({
      ...original,
      scanSandbox: (): never => {
        throw new Error('the scan failed');
      },
    }));
    expect(uiInventory(root).contextPath).toBe('/');
    restore();
    expect(uiInventory(root).contextPath).toBe('/shop'); // the real scan is back
  });
});
