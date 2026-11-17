// M6g (track M, #19): which files the privacy review covers (lib/privacy-files.ts).
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetHookClock, startHookClock } from '../lib/hook-clock';
import { isPrivacyPath, MAX_BYTES_OF, MAX_FILES_OF, PRIVACY_FILE_BYTES, privacyFilesOf, privacySetupOf, usesDataHelper } from '../lib/privacy-files';
import { HELPER_COPY, isSandboxLayout, MAX_USER_BYTES } from '../lib/sandbox-gate';

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}, git = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6g-files-')));
  made.push(root);
  for (const [rel, text] of Object.entries(files)) put(root, rel, text);
  if (git) {
    const r = Bun.spawnSync(['git', 'init', '-q'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
  }
  return root;
}

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const HELPER = '.goodboy/sandbox/data/goodboy-data';

describe('isPrivacyPath: the sandbox files and the manifest, by path', () => {
  test('layout files that carry behaviour, and data.json, are privacy files', () => {
    for (const rel of [
      '.goodboy/sandbox/compose.yml',
      '.goodboy/sandbox/runtime/entrypoint.sh',
      '.goodboy/sandbox/db/shop/restore.sh',
      '.goodboy/sandbox/db/shop/data-role.sh',
      '.goodboy/sandbox/overrides/sandbox.env',
      '.goodboy/sandbox/dummies/stubs/mappings/a.json',
      '.goodboy/sandbox/proxy/Caddyfile',
      '.goodboy/sandbox/e2e/goodboy-ui.ts',
      '.goodboy/sandbox/data/goodboy-data.ts',
      '.goodboy/sandbox/data/GoodboyData.java',
      '.goodboy/sandbox/data.json',
    ]) {
      expect([rel, isPrivacyPath(rel)]).toEqual([rel, true]);
    }
  });

  test('state and key files (scan, local answers, ledger, CA, .gitignore), run output and unknown files are not', () => {
    for (const rel of [
      '.goodboy/sandbox/scan.json',
      '.goodboy/sandbox/local.json',
      '.goodboy/sandbox/.written.json',
      '.goodboy/sandbox/.gitignore',
      '.goodboy/sandbox/ca/ca.key',
      '.goodboy/sandbox/ca/server.crt',
      '.goodboy/sandbox/out/20261101T000000Z/result.json',
      '.goodboy/sandbox/notes.md',
      'src/compose.yml',
      'data.json',
    ]) {
      expect([rel, isPrivacyPath(rel)]).toEqual([rel, false]);
    }
  });

  test('a copy of the helper outside the sandbox dir is one too', () => {
    expect(isPrivacyPath('src/test/java/goodboy/GoodboyData.java')).toBe(true);
    expect(isPrivacyPath('tests/support/goodboy-data.ts')).toBe(true);
    expect(isPrivacyPath('tests/support/goodboy-data-notes.ts')).toBe(false);
  });
});

describe('usesDataHelper: the tests that use the helper', () => {
  test('a relative import that reduces to the helper module, in every form', () => {
    for (const spec of ['../.goodboy/sandbox/data/goodboy-data', '../.goodboy/sandbox/data/goodboy-data.ts', '../.goodboy/sandbox/data/goodboy-data.js']) {
      expect([spec, usesDataHelper('tests/a.test.ts', `import { pick } from '${spec}';\n`)]).toEqual([spec, true]);
    }
    expect(usesDataHelper('tests/a.test.ts', `const h = require('../.goodboy/sandbox/data/goodboy-data.cjs');\n`)).toBe(true);
    expect(usesDataHelper('tests/a.test.ts', `const h = await import('../.goodboy/sandbox/data/goodboy-data');\n`)).toBe(true);
    // a nested test reaches it from its own dir
    expect(usesDataHelper('tests/deep/er/a.test.ts', `import { pick } from '../../../.goodboy/sandbox/data/goodboy-data';\n`)).toBe(true);
  });

  test('another module of the sandbox dir, or one that only looks like the helper, is not enough', () => {
    expect(usesDataHelper('tests/a.test.ts', `import { uiTest } from '../.goodboy/sandbox/e2e/goodboy-ui';\n`)).toBe(false);
    expect(usesDataHelper('tests/a.test.ts', `import { x } from '../src/goodboy-data-notes';\n`)).toBe(false);
  });

  test('a specifier that reaches the helper through a detour counts (the import is read, not the spelling)', () => {
    expect(usesDataHelper('tests/a.test.ts', `import { pick } from '../.goodboy/sandbox/e2e/../data/goodboy-data';\n`)).toBe(true);
    expect(usesDataHelper('tests/a.test.ts', `import { pick } from '../.goodboy/sandbox/e2e/../data/goodboy-data.ts';\n`)).toBe(true);
    expect(usesDataHelper('tests/a.test.ts', `import { pick } from '../.goodboy/sandbox/e2e/../data/index';\n`)).toBe(false);
    expect(usesDataHelper('tests/a.test.ts', `import { pick } from '../.goodboy/sandbox/e2e/../e2e/goodboy-ui';\n`)).toBe(false);
  });

  test('the helper path named any other way counts (a string, a built require; a type-only import too, to be safe)', () => {
    expect(usesDataHelper('tests/a.test.ts', `import type { Handle } from '../.goodboy/sandbox/data/goodboy-data';\n`)).toBe(true);
    expect(usesDataHelper('tests/a.test.ts', `const p = join(root, '.goodboy/sandbox/data/goodboy-data.cjs');\n`)).toBe(true);
  });

  test('a mention in a comment does not count', () => {
    expect(usesDataHelper('tests/a.test.ts', `// uses ../.goodboy/sandbox/data/goodboy-data later\nexport {};\n`)).toBe(false);
    expect(usesDataHelper('src/test/java/A.java', `// GoodboyData would help\n/* GoodboyData */\nclass A {}\n`)).toBe(false);
  });

  test('Java and Kotlin: the symbol GoodboyData, as an import or a name', () => {
    expect(usesDataHelper('src/test/java/A.java', `import goodboy.GoodboyData;\nclass A {}\n`)).toBe(true);
    expect(usesDataHelper('src/test/kotlin/A.kt', `class A { val d = GoodboyData.pick("x") }\n`)).toBe(true);
    expect(usesDataHelper('src/test/java/A.java', `class MyGoodboyDataThing {}\n`)).toBe(false);
  });

  test('any language: the env var of the resolved values', () => {
    expect(usesDataHelper('tests/a.test.ts', `const f = process.env.GOODBOY_DATA;\n`)).toBe(true);
    expect(usesDataHelper('src/test/java/A.java', `String f = System.getenv("GOODBOY_DATA");\n`)).toBe(true);
    expect(usesDataHelper('tests/test_a.py', `x = 1\n`)).toBe(false);
  });
});

describe('privacyFilesOf: the files of a change', () => {
  test('sandbox files and data.json by path; a helper-using test by content; a plain test and code not', () => {
    const root = project({
      '.goodboy/sandbox/compose.yml': 'services: {}\n',
      '.goodboy/sandbox/data.json': '{"version":1}\n',
      '.goodboy/sandbox/scan.json': '{}\n',
      'tests/users.test.ts': `import { pick } from '../${HELPER}';\n`,
      'tests/plain.test.ts': `import { add } from '../src/add';\n`,
      'src/add.ts': 'export const add = 1;\n',
      'src/test/java/UserIT.java': 'import goodboy.GoodboyData;\nclass UserIT {}\n',
      // a file that is no test and imports the helper is a privacy file too (a script `sandbox-run -- bun scripts/x.ts` runs)
      'src/loader.ts': `import { pick } from '../${HELPER}';\nexport const p = pick;\n`,
    });
    const files = ['.goodboy/sandbox/compose.yml', '.goodboy/sandbox/data.json', '.goodboy/sandbox/scan.json', 'tests/users.test.ts', 'tests/plain.test.ts', 'src/add.ts', 'src/loader.ts', 'src/test/java/UserIT.java'];
    expect([...privacyFilesOf(root, files)].sort()).toEqual(['.goodboy/sandbox/compose.yml', '.goodboy/sandbox/data.json', 'src/loader.ts', 'src/test/java/UserIT.java', 'tests/users.test.ts']);
  });

  test('a source file of any kind that names the data counts, not only a test (the first review finding: a file name hid it)', () => {
    const root = project({
      'scripts/leak.ts': `import { pick } from '../${HELPER}';\nexport const p = pick;\n`,
      'scripts/leak.sh': 'echo "$GOODBOY_DATA"\n',
      'scripts/leak.py': "import os\nprint(os.environ['GOODBOY_DATA'])\n",
      'config/run.json': '{"data": ".goodboy/sandbox/data/handles.json"}\n',
      'config/ci.yml': 'env:\n  F: ${GOODBOY_DATA}\n',
      'src/main/kotlin/Loader.kt': 'val d = GoodboyData.pick("x")\n',
      'tests/test_data.py': "x = open('.goodboy/sandbox/data/h.json')\n",
      'tests/go_data_test.go': 'var f = os.Getenv("GOODBOY_DATA")\n',
      'scripts/plain.ts': 'export const a = 1;\n',
      'config/plain.json': '{"a": 1}\n',
      'README.md': 'see GOODBOY_DATA\n',
    });
    const files = ['scripts/leak.ts', 'scripts/leak.sh', 'scripts/leak.py', 'config/run.json', 'config/ci.yml', 'src/main/kotlin/Loader.kt', 'tests/test_data.py', 'tests/go_data_test.go', 'scripts/plain.ts', 'config/plain.json', 'README.md'];
    expect([...privacyFilesOf(root, files)].sort()).toEqual(['config/ci.yml', 'config/run.json', 'scripts/leak.py', 'scripts/leak.sh', 'scripts/leak.ts', 'src/main/kotlin/Loader.kt', 'tests/go_data_test.go', 'tests/test_data.py']);
  });

  test('a path that is no source file (a document, an image) is never read', () => {
    const root = project({ 'notes.md': 'GOODBOY_DATA\n', 'img.png': 'GOODBOY_DATA' });
    expect([...privacyFilesOf(root, ['notes.md', 'img.png'])]).toEqual([]);
  });

  test('absolute paths work, and the answer holds the files as given', () => {
    const root = project({ 'tests/users.test.ts': `import { pick } from '../${HELPER}';\n` });
    const abs = join(root, 'tests/users.test.ts');
    expect([...privacyFilesOf(root, [abs])]).toEqual([abs]);
  });

  test('relative names resolve against the base, a file outside the project is not asked, a deleted test uses nothing', () => {
    const root = project({ 'tests/users.test.ts': `import { pick } from '../${HELPER}';\n`, 'x/y.ts': '' });
    expect([...privacyFilesOf(root, ['users.test.ts'], join(root, 'tests'))]).toEqual(['users.test.ts']);
    const other = project({ 'tests/users.test.ts': `import { pick } from '../${HELPER}';\n` });
    expect([...privacyFilesOf(root, [join(other, 'tests/users.test.ts')])]).toEqual([]);
    expect([...privacyFilesOf(root, ['tests/gone.test.ts'])]).toEqual([]);
    expect([...privacyFilesOf(root, [''])]).toEqual([]);
  });

  test('a link into the sandbox dir still counts as the sandbox file it reaches', () => {
    const root = project({ '.goodboy/sandbox/compose.yml': 'services: {}\n' });
    symlinkSync(join(root, '.goodboy/sandbox/compose.yml'), join(root, 'alias.yml'));
    mkdirSync(join(root, 'lnk'));
    symlinkSync(join(root, '.goodboy/sandbox'), join(root, 'lnk/sb'));
    expect([...privacyFilesOf(root, ['lnk/sb/compose.yml'])]).toEqual(['lnk/sb/compose.yml']);
  });

  test('a test it cannot read in full counts (over the size cap), and so does every test past the count cap', () => {
    const root = project({ 'tests/big.test.ts': 'x'.repeat(PRIVACY_FILE_BYTES + 1), 'tests/small.test.ts': 'export {};\n' });
    expect([...privacyFilesOf(root, ['tests/big.test.ts', 'tests/small.test.ts'])]).toEqual(['tests/big.test.ts']);
    const many = Object.fromEntries(Array.from({ length: MAX_FILES_OF + 3 }, (_, i) => [`tests/t${i}.test.ts`, 'export {};\n']));
    const r2 = project(many);
    const got = privacyFilesOf(r2, Object.keys(many));
    // the first MAX_FILES_OF were read and are plain; the rest were not read and count
    expect(got.size).toBe(3);
    expect([...got].sort()).toEqual(Object.keys(many).slice(MAX_FILES_OF).sort());
  });

  test('the caps can be set by the caller', () => {
    const root = project({ 'tests/a.test.ts': 'export {};\n', 'tests/b.test.ts': 'export {};\n', 'tests/c.test.ts': 'x'.repeat(50) });
    expect([...privacyFilesOf(root, ['tests/a.test.ts', 'tests/b.test.ts'], root, { files: 1 })]).toEqual(['tests/b.test.ts']);
    expect([...privacyFilesOf(root, ['tests/c.test.ts'], root, { fileBytes: 10 })]).toEqual(['tests/c.test.ts']);
  });

  test('a total-bytes cap: once the files read hold more than it, the rest count (the second review finding: 400 big edits ran out the hook)', () => {
    expect(MAX_BYTES_OF).toBe(16 * 1024 * 1024);
    const files = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`src/${n}.ts`, 'x'.repeat(40)]));
    const root = project(files);
    // 40 bytes each: a file is read while the bytes read so far are within the cap
    expect([...privacyFilesOf(root, Object.keys(files), root, { totalBytes: 79 })].sort()).toEqual(['src/c.ts', 'src/d.ts']);
    expect([...privacyFilesOf(root, Object.keys(files), root, { totalBytes: 80 })]).toEqual(['src/d.ts']);
    expect([...privacyFilesOf(root, Object.keys(files), root, { totalBytes: 160 })]).toEqual([]);
  });

  test('a deadline: once the time left is gone, no file is read and every candidate counts; paths are still answered by path', () => {
    const files = { 'src/a.ts': 'export {};\n', 'src/b.ts': 'export {};\n', '.goodboy/sandbox/data.json': '{}\n', 'notes.md': 'x\n' };
    const root = project(files);
    const all = Object.keys(files);
    expect([...privacyFilesOf(root, all, root, { until: () => 0 })].sort()).toEqual(['.goodboy/sandbox/data.json', 'src/a.ts', 'src/b.ts']);
    expect([...privacyFilesOf(root, all, root, { until: () => -5 })].sort()).toEqual(['.goodboy/sandbox/data.json', 'src/a.ts', 'src/b.ts']);
    // time left: read as always
    expect([...privacyFilesOf(root, all, root, { until: () => 1000 })]).toEqual(['.goodboy/sandbox/data.json']);
    // the deadline runs out in the middle: the files after it count
    let calls = 0;
    expect([...privacyFilesOf(root, ['src/a.ts', 'src/b.ts'], root, { until: () => (++calls <= 1 ? 100 : 0) })]).toEqual(['src/b.ts']);
  });

  test('with no deadline given, the hook’s own clock bounds it; outside a hook nothing does', () => {
    const root = project({ 'src/a.ts': 'export {};\n' });
    expect([...privacyFilesOf(root, ['src/a.ts'])]).toEqual([]);
    startHookClock(0);
    try {
      expect([...privacyFilesOf(root, ['src/a.ts'])]).toEqual(['src/a.ts']);
    } finally {
      resetHookClock();
    }
    expect([...privacyFilesOf(root, ['src/a.ts'])]).toEqual([]);
  });

  test('the byte cap is the one the import check of lib/sandbox-gate.ts uses (one fact, shared)', () => {
    expect(PRIVACY_FILE_BYTES).toBe(MAX_USER_BYTES);
    expect(HELPER_COPY.test('data/goodboy-data.ts')).toBe(true);
    // every layout file of the helper's dir is a copy by name, so the two never drift apart
    for (const f of ['goodboy-data.ts', 'goodboy-data.cjs', 'GoodboyData.java']) {
      expect([f, isSandboxLayout(`data/${f}`), HELPER_COPY.test(`data/${f}`)]).toEqual([f, true, true]);
    }
  });
});

describe('privacySetupOf: the current setup of a project', () => {
  test('lists the sandbox files, the manifest and the helper-using tests git knows, tracked or not', () => {
    const root = project(
      {
        '.goodboy/sandbox/compose.yml': 'services: {}\n',
        '.goodboy/sandbox/data.json': '{"version":1}\n',
        '.goodboy/sandbox/local.json': '{}\n',
        '.goodboy/sandbox/ca/ca.key': 'k\n',
        '.goodboy/sandbox/out/20261101T000000Z/result.json': '{}\n',
        'tests/users.test.ts': `import { pick } from '../${HELPER}';\n`,
        'tests/plain.test.ts': 'export {};\n',
        'src/main/java/App.java': 'class App {}\n',
      },
      true,
    );
    Bun.spawnSync(['git', 'add', 'tests/users.test.ts'], { cwd: root });
    const s = privacySetupOf(root);
    expect(s).toEqual({ ok: true, files: ['.goodboy/sandbox/compose.yml', '.goodboy/sandbox/data.json', 'tests/users.test.ts'] });
  });

  test('a sandbox dir the project git-ignores is found on disk, and an ignored test is left to git', () => {
    const root = project(
      {
        '.gitignore': '.goodboy/\nignored.test.ts\n',
        '.goodboy/sandbox/compose.yml': 'services: {}\n',
        'ignored.test.ts': `import { pick } from './${HELPER}';\n`,
      },
      true,
    );
    expect(privacySetupOf(root)).toEqual({ ok: true, files: ['.goodboy/sandbox/compose.yml'] });
  });

  test('a source file that is no test is in the setup when it uses the helper; a plain one, a document and the rest of the sandbox dir are not', () => {
    const root = project(
      {
        'scripts/leak.ts': `import { pick } from '../${HELPER}';\nexport const p = pick;\n`,
        'scripts/leak.sh': 'echo "$GOODBOY_DATA"\n',
        'config/run.json': '{"d": ".goodboy/sandbox/data/h.json"}\n',
        'tests/test_data.py': "open('.goodboy/sandbox/data/h.json')\n",
        'scripts/plain.ts': 'export const a = 1;\n',
        'notes.md': 'GOODBOY_DATA\n',
        // a state file of the sandbox dir that names the data holds no source of the project
        '.goodboy/sandbox/local.json': '{"note": "GOODBOY_DATA"}\n',
      },
      true,
    );
    expect(privacySetupOf(root)).toEqual({ ok: true, files: ['config/run.json', 'scripts/leak.sh', 'scripts/leak.ts', 'tests/test_data.py'] });
  });

  test('a big or unreadable source file that is no test is left unread: it does not refuse every run; a test of that size does', () => {
    const root = project({ 'src/generated.ts': 'x'.repeat(PRIVACY_FILE_BYTES + 1), 'package-lock.json': 'x'.repeat(PRIVACY_FILE_BYTES + 1), 'src/a.ts': `import { pick } from '../${HELPER}';\n` }, true);
    expect(privacySetupOf(root)).toEqual({ ok: true, files: ['src/a.ts'] });
    mkdirSync(join(root, 'src/dir.ts'));
    expect(privacySetupOf(root)).toEqual({ ok: true, files: ['src/a.ts'] });
    put(root, 'tests/e2e/big.spec.ts', 'x'.repeat(PRIVACY_FILE_BYTES + 1));
    expect(privacySetupOf(root)).toEqual({ ok: false, why: 'unreadable' });
  });

  test('a project with none of it has an empty setup', () => {
    expect(privacySetupOf(project({ 'src/a.ts': 'export {};\n' }, true))).toEqual({ ok: true, files: [] });
  });

  test('not a git repository: unreadable (fail closed)', () => {
    expect(privacySetupOf(project({ '.goodboy/sandbox/compose.yml': 'x\n' }))).toEqual({ ok: false, why: 'unreadable' });
  });

  test('a candidate over the size cap or past the count cap or the byte cap: refused with its own reason', () => {
    const big = project({ 'tests/big.test.ts': 'x'.repeat(PRIVACY_FILE_BYTES + 1) }, true);
    expect(privacySetupOf(big)).toEqual({ ok: false, why: 'unreadable' });
    const three = project({ 'tests/a.test.ts': 'export {};\n', 'tests/b.test.ts': 'export {};\n', 'tests/c.test.ts': 'export {};\n' }, true);
    expect(privacySetupOf(three, { files: 3 })).toEqual({ ok: true, files: [] });
    expect(privacySetupOf(three, { files: 2 })).toEqual({ ok: false, why: 'cap' });
    expect(privacySetupOf(three, { totalBytes: 33 })).toEqual({ ok: true, files: [] }); // three files of 11 bytes
    expect(privacySetupOf(three, { totalBytes: 32 })).toEqual({ ok: false, why: 'cap' });
  });

  test('run output below out/ is not walked: a link in it does not refuse the setup', () => {
    const root = project({ '.goodboy/sandbox/compose.yml': 'x\n', 'elsewhere.txt': 'y\n' }, true);
    mkdirSync(join(root, '.goodboy/sandbox/out/20261101T000000Z'), { recursive: true });
    symlinkSync(join(root, 'elsewhere.txt'), join(root, '.goodboy/sandbox/out/20261101T000000Z/alias.txt'));
    expect(privacySetupOf(root)).toEqual({ ok: true, files: ['.goodboy/sandbox/compose.yml'] });
  });

  test('a sandbox dir that is itself a link is refused, though the link points at a dir', () => {
    const root = project({ 'real/compose.yml': 'x\n' }, true);
    mkdirSync(join(root, '.goodboy'));
    symlinkSync(join(root, 'real'), join(root, '.goodboy/sandbox'));
    expect(privacySetupOf(root)).toEqual({ ok: false, why: 'unreadable' });
  });

  test('a link or a dir that is no dir inside the sandbox dir: refused', () => {
    const link = project({ '.goodboy/sandbox/compose.yml': 'x\n', 'elsewhere.txt': 'y\n' }, true);
    symlinkSync(join(link, 'elsewhere.txt'), join(link, '.goodboy/sandbox/alias.txt'));
    expect(privacySetupOf(link)).toEqual({ ok: false, why: 'unreadable' });
    const notDir = project({ '.goodboy/sandbox': 'a file where the dir should be\n' }, true);
    expect(privacySetupOf(notDir)).toEqual({ ok: false, why: 'unreadable' });
  });

  test('a dir inside the sandbox dir that cannot be listed: refused (fail closed)', () => {
    const root = project({ '.goodboy/sandbox/compose.yml': 'x\n', '.goodboy/sandbox/db/restore.sh': 'y\n' }, true);
    const sub = join(root, '.goodboy/sandbox/db');
    chmodSync(sub, 0o000);
    try {
      // root can list any dir, so the refusal is only expected for a normal user
      const listed = privacySetupOf(root);
      if (process.getuid?.() === 0) expect(listed.ok).toBe(true);
      else expect(listed).toEqual({ ok: false, why: 'unreadable' });
    } finally {
      chmodSync(sub, 0o755);
    }
  });
});
