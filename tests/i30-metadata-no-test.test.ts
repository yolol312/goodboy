// #30: repository metadata needs no test record: housekeeping names (`.gitignore`, `.mailmap`,
// `.editorconfig`, LICENSE and friends, GitHub contribution templates, FUNDING.yml), an empty
// `.gitkeep`/`.keep`, and a top-level package.json / .claude-plugin/plugin.json that differs from
// its content at the session's start only in its `version` string (needsTests, isMetadataNoTest).
// Identity is as the test-name trust: spelled and real path both qualify, a link is judged by its
// target, a hard link is code. A test-named path whose real path is outside the repo is no test.
// The Stop hook is spawned for real (as tests/i28-testkit-harness.test.ts does). Repos and
// session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { blobAtCommit, pinCoverageStart } from '../lib/changed-coverage';
import { recordEdit } from '../lib/file-tracker';
import { MAX_MANIFEST_BYTES, needsTests } from '../lib/verification-scope';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
function sid(): string {
  const s = `i30${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const CODE = 'export const a = 1;\n';
/** A scratch repo top with real files. */
function tree(files: Record<string, string> = {}): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i30-')));
  dirs.push(d);
  for (const [p, t] of Object.entries({ 'src/a.ts': CODE, ...files })) write(d, p, t);
  return d;
}
const needs = (d: string, rel: string, baseline?: (rel: string) => string | null) => needsTests(join(d, rel), d, [], baseline);

const EXEMPT = [
  '.gitignore',
  'sub/dir/.gitignore',
  '.mailmap',
  '.editorconfig',
  'LICENSE',
  'LICENSE.txt',
  'COPYING',
  'NOTICE',
  'AUTHORS',
  'pkg/LICENSE',
  '.github/ISSUE_TEMPLATE/bug.yml',
  '.github/ISSUE_TEMPLATE/config.yaml',
  '.github/ISSUE_TEMPLATE/forms/feature.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE/hotfix.md',
  '.github/FUNDING.yml',
];

describe('needsTests: fixed housekeeping names need no test record', () => {
  test('each exempt name', () => {
    const d = tree(Object.fromEntries(EXEMPT.map((r) => [r, 'x\n'])));
    for (const rel of EXEMPT) expect([rel, needs(d, rel)]).toEqual([rel, false]);
    expect(needs(d, 'src/a.ts')).toBe(true);
    // the extensionless names cannot sit beside the directory of the same name
    const bare = tree({ '.github/PULL_REQUEST_TEMPLATE': 'x\n', '.github/pull_request_template': 'x\n' });
    expect(needs(bare, '.github/PULL_REQUEST_TEMPLATE')).toBe(false);
    expect(needs(bare, '.github/pull_request_template')).toBe(false);
  });

  test('near misses stay code', () => {
    const near = [
      '.gitattributes',
      '.dockerignore',
      '.npmignore',
      'CODEOWNERS',
      '.github/CODEOWNERS',
      '.github/workflows/ci.yml',
      'LICENSE.js',
      'license',
      '.github/ISSUE_TEMPLATE/x.sh',
      '.github/ISSUE_TEMPLATE/x.json',
      '.github/PULL_REQUEST_TEMPLATE/x.yml',
      '.github/FUNDING.yaml',
      'src/.gitignore.ts',
      'x.gitignore',
      '.gitignore.bak',
      'tsconfig.json',
      '.vscode/settings.json',
    ];
    const d = tree(Object.fromEntries(near.map((r) => [r, 'x\n'])));
    for (const rel of near) expect([rel, needs(d, rel)]).toEqual([rel, true]);
  });

  test('a deleted fixed-name file needs a test record like other code', () => {
    const d = tree();
    expect(needs(d, '.gitignore')).toBe(true);
    expect(needs(d, '.github/FUNDING.yml')).toBe(true);
  });

  test('a symlink is judged by its target', () => {
    const d = tree({ 'other/.gitignore': 'x\n' });
    symlinkSync(join(d, 'src', 'a.ts'), join(d, '.gitignore'));
    symlinkSync(join(d, 'other', '.gitignore'), join(d, '.mailmap')); // target is a different name
    mkdirSync(join(d, 'deep'));
    symlinkSync(join(d, 'other', '.gitignore'), join(d, 'deep', '.gitignore')); // same rule on both sides
    expect(needs(d, '.gitignore')).toBe(true);
    expect(needs(d, '.mailmap')).toBe(true);
    expect(needs(d, 'deep/.gitignore')).toBe(false);
  });

  test('a link that leaves the repo is code', () => {
    const outside = tree({ '.gitignore': 'x\n' });
    const d = tree();
    symlinkSync(join(outside, '.gitignore'), join(d, '.gitignore'));
    expect(needs(d, '.gitignore')).toBe(true);
  });

  test('a hard link is code', () => {
    const d = tree({ '.gitignore': 'x\n' });
    linkSync(join(d, 'src', 'a.ts'), join(d, '.editorconfig'));
    linkSync(join(d, '.gitignore'), join(d, 'copy.txt'));
    expect(needs(d, '.editorconfig')).toBe(true);
    expect(needs(d, '.gitignore')).toBe(true);
  });

  test('a directory with the name is code', () => {
    const d = tree({ '.gitignore/x.txt': 'x\n' });
    expect(needs(d, '.gitignore')).toBe(true);
  });
});

describe('needsTests: an empty .gitkeep/.keep', () => {
  test('empty regular files are exempt', () => {
    const d = tree({ 'data/.gitkeep': '', '.keep': '' });
    expect(needs(d, 'data/.gitkeep')).toBe(false);
    expect(needs(d, '.keep')).toBe(false);
  });

  test('a non-empty one is code', () => {
    const d = tree({ '.gitkeep': 'x', 'sub/.keep': '\n' });
    expect(needs(d, '.gitkeep')).toBe(true);
    expect(needs(d, 'sub/.keep')).toBe(true);
  });

  test('a deleted one needs a test; a link is judged by its target; a hard link is code', () => {
    const d = tree({ 'real/.gitkeep': '' });
    expect(needs(d, '.gitkeep')).toBe(true);
    symlinkSync(join(d, 'real', '.gitkeep'), join(d, '.keep')); // an empty target of the same rule
    expect(needs(d, '.keep')).toBe(false);
    linkSync(join(d, 'real', '.gitkeep'), join(d, 'second.gitkeep'));
    expect(needs(d, 'real/.gitkeep')).toBe(true); // now two names
    symlinkSync(join(d, 'src', 'a.ts'), join(d, 'src', '.gitkeep'));
    expect(needs(d, 'src/.gitkeep')).toBe(true);
  });
});

describe('needsTests: package.json and plugin.json with only a version change', () => {
  const BASE = '{"name":"x","version":"1.0.0","scripts":{"test":"bun test"},"dependencies":{"a":"1"},"files":["a","b"]}\n';
  const reader = (text: string | null) => () => text;
  const swap = (obj: Record<string, unknown>) => `${JSON.stringify(obj, null, 2)}\n`;
  const parsed = () => JSON.parse(BASE) as Record<string, unknown>;

  test('a version-only change is exempt, for both manifests', () => {
    const d = tree({ 'package.json': BASE.replace('1.0.0', '1.0.1'), '.claude-plugin/plugin.json': BASE.replace('1.0.0', '2.0.0') });
    expect(needs(d, 'package.json', reader(BASE))).toBe(false);
    expect(needs(d, '.claude-plugin/plugin.json', reader(BASE))).toBe(false);
  });

  test('formatting is ignored; key order and array order are kept', () => {
    const d = tree({ 'package.json': swap({ ...parsed(), version: '9.9.9', name: 'x' }) });
    expect(needs(d, 'package.json', reader(BASE))).toBe(false);
    const wide = tree({ 'package.json': `${JSON.stringify(parsed(), null, 8).replace('1.0.0', '1.0.1')}\r\n\r\n` });
    expect(needs(wide, 'package.json', reader(BASE))).toBe(false);
    const reordered = tree({ 'package.json': swap({ files: ['b', 'a'], dependencies: { a: '1' }, scripts: { test: 'bun test' }, name: 'x', version: '1.0.0' }) });
    expect(needs(reordered, 'package.json', reader(BASE))).toBe(true);
    const keys = tree({ 'package.json': swap({ version: '3', dependencies: { a: '1' }, files: ['a', 'b'], scripts: { test: 'bun test' }, name: 'x' }) });
    expect(needs(keys, 'package.json', reader(BASE))).toBe(true);
  });

  test('a reorder of the conditions in exports needs a test, a nested one too', () => {
    const before = '{"version":"1.0.0","exports":{".":{"import":"./a.mjs","default":"./a.cjs"}}}\n';
    const after = (exp: unknown) => swap({ version: '1.0.1', exports: exp });
    const same = tree({ 'package.json': after({ '.': { import: './a.mjs', default: './a.cjs' } }) });
    expect(needs(same, 'package.json', reader(before))).toBe(false);
    const nested = tree({ 'package.json': after({ '.': { default: './a.cjs', import: './a.mjs' } }) });
    expect(needs(nested, 'package.json', reader(before))).toBe(true);
    const inBase = '{"version":"1.0.0","imports":{"#a":{"node":"./n.js","default":"./d.js"}}}\n';
    const flipped = tree({ 'package.json': swap({ version: '1.0.1', imports: { '#a': { default: './d.js', node: './n.js' } } }) });
    expect(needs(flipped, 'package.json', reader(inBase))).toBe(true);
  });

  test('any other change needs a test', () => {
    for (const change of [{ scripts: { test: 'rm -rf /' } }, { dependencies: { a: '2' } }, { name: 'y' }, { extra: true }, { files: ['a'] }]) {
      const d = tree({ 'package.json': swap({ ...parsed(), version: '1.0.1', ...change }) });
      expect([change, needs(d, 'package.json', reader(BASE))]).toEqual([change, true]);
    }
    const removed = parsed();
    delete removed.dependencies;
    const d = tree({ 'package.json': swap({ ...removed, version: '1.0.1' }) });
    expect(needs(d, 'package.json', reader(BASE))).toBe(true);
  });

  test('both sides need an own string version', () => {
    const noVersion = tree({ 'package.json': swap({ name: 'x' }) });
    expect(needs(noVersion, 'package.json', reader('{"name":"x"}'))).toBe(true);
    const added = tree({ 'package.json': swap({ name: 'x', version: '1' }) });
    expect(needs(added, 'package.json', reader('{"name":"x"}'))).toBe(true);
    const removed = tree({ 'package.json': swap({ name: 'x' }) });
    expect(needs(removed, 'package.json', reader('{"name":"x","version":"1"}'))).toBe(true);
    const number = tree({ 'package.json': '{"name":"x","version":2}' });
    expect(needs(number, 'package.json', reader('{"name":"x","version":1}'))).toBe(true);
    const array = tree({ 'package.json': '[{"version":"1"}]' });
    expect(needs(array, 'package.json', reader('[{"version":"2"}]'))).toBe(true);
  });

  test('a duplicate key in either text needs a test', () => {
    const topDup = '{"version":"2","scripts":{"test":"evil"},"scripts":{"test":"bun test"},"name":"x","dependencies":{"a":"1"},"files":["a","b"]}';
    const nestedDup = '{"version":"2","name":"x","scripts":{"test":"evil","test":"bun test"},"dependencies":{"a":"1"},"files":["a","b"]}';
    const escapedDup = '{"version":"2","name":"x","\\u0073cripts":{"test":"evil"},"scripts":{"test":"bun test"},"dependencies":{"a":"1"},"files":["a","b"]}';
    for (const text of [topDup, nestedDup, escapedDup]) {
      const d = tree({ 'package.json': text });
      expect(needs(d, 'package.json', reader(BASE))).toBe(true);
    }
    const d = tree({ 'package.json': BASE.replace('1.0.0', '2') });
    expect(needs(d, 'package.json', reader(topDup.replace('"version":"2"', '"version":"1"')))).toBe(true);
    // the same key in different objects is no duplicate
    const twins = '{"version":"1","a":{"k":1},"b":{"k":1},"c":[{"k":1},{"k":2}]}';
    const ok = tree({ 'package.json': twins.replace('"1"', '"2"') });
    expect(needs(ok, 'package.json', reader(twins))).toBe(false);
  });

  test('invalid JSON, no baseline or no reader needs a test', () => {
    const bad = tree({ 'package.json': '{"version":"2",' });
    expect(needs(bad, 'package.json', reader(BASE))).toBe(true);
    const good = tree({ 'package.json': BASE.replace('1.0.0', '2') });
    expect(needs(good, 'package.json', reader('{"version":"1",'))).toBe(true);
    expect(needs(good, 'package.json', reader(null))).toBe(true);
    expect(needs(good, 'package.json', () => {
      throw new Error('git failed');
    })).toBe(true);
    expect(needs(good, 'package.json')).toBe(true);
    expect(needs(good, 'package.json', reader(BASE))).toBe(false);
  });

  test('only the two top-level manifests count', () => {
    const files = { 'pkg/package.json': BASE.replace('1.0.0', '2'), 'plugin.json': BASE.replace('1.0.0', '2'), '.claude-plugin/x/plugin.json': BASE.replace('1.0.0', '2'), 'composer.json': BASE.replace('1.0.0', '2') };
    const d = tree(files);
    for (const rel of Object.keys(files)) expect([rel, needs(d, rel, reader(BASE))]).toEqual([rel, true]);
  });

  test('a deleted manifest, a link and a hard link need a test', () => {
    const d = tree({ 'other/package.json': BASE.replace('1.0.0', '2') });
    expect(needs(d, 'package.json', reader(BASE))).toBe(true); // deleted
    symlinkSync(join(d, 'src', 'a.ts'), join(d, 'package.json'));
    expect(needs(d, 'package.json', reader(BASE))).toBe(true);
    mkdirSync(join(d, '.claude-plugin'));
    linkSync(join(d, 'other', 'package.json'), join(d, '.claude-plugin', 'plugin.json'));
    expect(needs(d, '.claude-plugin/plugin.json', reader(BASE))).toBe(true);
  });

  test('a top-level manifest that links to another manifest path needs a test', () => {
    // the real path must be a top-level manifest too: a baseline read for the target's name would
    // otherwise vouch for a link into a nested manifest
    const d = tree({ 'other/package.json': BASE.replace('1.0.0', '2') });
    symlinkSync(join(d, 'other', 'package.json'), join(d, 'package.json'));
    expect(needs(d, 'package.json', reader(BASE))).toBe(true);
    expect(needs(d, 'other/package.json', reader(BASE))).toBe(true); // the nested one alone is code
    mkdirSync(join(d, '.claude-plugin'));
    symlinkSync(join(d, 'other', 'package.json'), join(d, '.claude-plugin', 'plugin.json'));
    expect(needs(d, '.claude-plugin/plugin.json', reader(BASE))).toBe(true);
  });

  test('a manifest over the size cap needs a test', () => {
    const pad = 'x'.repeat(1_100_000);
    const d = tree({ 'package.json': `{"version":"2","pad":"${pad}"}` });
    expect(needs(d, 'package.json', reader(`{"version":"1","pad":"${pad}"}`))).toBe(true);
  });

  test('the reader is asked for the repo-relative path, and only for a manifest', () => {
    const asked: string[] = [];
    const spy = (rel: string) => {
      asked.push(rel);
      return BASE;
    };
    const d = tree({ 'package.json': BASE.replace('1.0.0', '2'), '.claude-plugin/plugin.json': BASE.replace('1.0.0', '2'), '.gitignore': 'x\n', 'pkg/package.json': BASE });
    for (const rel of ['src/a.ts', '.gitignore', 'pkg/package.json', 'package.json', '.claude-plugin/plugin.json']) needs(d, rel, spy);
    expect(asked).toEqual(['package.json', '.claude-plugin/plugin.json']);
  });
});

describe('blobAtCommit: a file at a commit, or null', () => {
  const SMALL = '{"version":"1"}\n';
  /** A repo with one commit: a small file, a file of exactly 20 bytes, a big one and a directory. */
  function committed(): { d: string; head: string } {
    const d = tree({ 'small.json': SMALL, 'exact.txt': '01234567890123456789', 'big.json': `{"pad":"${'x'.repeat(MAX_MANIFEST_BYTES)}"}`, 'dir/in.txt': 'x\n' });
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    return { d, head: sh(d, 'git rev-parse HEAD') };
  }

  test('returns the committed text, not the working tree', () => {
    const { d, head } = committed();
    write(d, 'small.json', '{"version":"2"}\n');
    expect(blobAtCommit(d, head, 'small.json', MAX_MANIFEST_BYTES)).toBe(SMALL);
    expect(blobAtCommit(d, head, 'dir/in.txt', MAX_MANIFEST_BYTES)).toBe('x\n');
  });

  test('a bad commit id, an unknown commit, an empty path or a newline in the path is null', () => {
    const { d, head } = committed();
    for (const bad of ['HEAD', 'main', head.slice(0, 12), `${head}\n`, '', '--help', `${head.slice(0, 39)}g`]) {
      expect([bad, blobAtCommit(d, bad, 'small.json', MAX_MANIFEST_BYTES)]).toEqual([bad, null]);
    }
    expect(blobAtCommit(d, 'f'.repeat(40), 'small.json', MAX_MANIFEST_BYTES)).toBeNull(); // well-formed, unknown
    expect(blobAtCommit(d, head, '', MAX_MANIFEST_BYTES)).toBeNull();
    expect(blobAtCommit(d, head, 'small.json\nbig.json', MAX_MANIFEST_BYTES)).toBeNull();
  });

  test('a path that is not in the commit, or is a directory, is null', () => {
    const { d, head } = committed();
    write(d, 'new.json', SMALL); // in the tree, never committed
    expect(blobAtCommit(d, head, 'new.json', MAX_MANIFEST_BYTES)).toBeNull();
    expect(blobAtCommit(d, head, 'missing/none.json', MAX_MANIFEST_BYTES)).toBeNull();
    expect(blobAtCommit(d, head, 'dir', MAX_MANIFEST_BYTES)).toBeNull();
  });

  test('only a regular file counts: a symlink or a gitlink baseline is null, an executable is read', () => {
    const d = tree({ 'real.json': SMALL });
    symlinkSync('real.json', join(d, 'link.json'));
    write(d, 'run.sh', '#!/bin/sh\n');
    sh(d, 'chmod +x run.sh');
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    sh(d, `git update-index --add --cacheinfo 160000,${sh(d, 'git rev-parse HEAD')},sub`);
    sh(d, "git commit -q -m 'ABC-2 gitlink'");
    const head = sh(d, 'git rev-parse HEAD');
    expect(sh(d, 'git ls-tree HEAD -- link.json run.sh sub').split('\n').map((l) => l.split(' ')[0])).toEqual(['120000', '100755', '160000']);
    expect(blobAtCommit(d, head, 'real.json', MAX_MANIFEST_BYTES)).toBe(SMALL);
    expect(blobAtCommit(d, head, 'run.sh', MAX_MANIFEST_BYTES)).toBe('#!/bin/sh\n');
    expect(blobAtCommit(d, head, 'link.json', MAX_MANIFEST_BYTES)).toBeNull(); // 120000: its text is a path
    expect(blobAtCommit(d, head, 'sub', MAX_MANIFEST_BYTES)).toBeNull(); // 160000
  });

  test('a git failure (no repository) is null', () => {
    const { head } = committed();
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i30-norepo-')));
    dirs.push(notRepo);
    expect(blobAtCommit(notRepo, head, 'small.json', MAX_MANIFEST_BYTES)).toBeNull();
    expect(blobAtCommit(join(notRepo, 'gone'), head, 'small.json', MAX_MANIFEST_BYTES)).toBeNull();
  });

  test('a blob over the cap is null, one at the cap is read', () => {
    const { d, head } = committed();
    expect(blobAtCommit(d, head, 'big.json', MAX_MANIFEST_BYTES)).toBeNull(); // over MAX_MANIFEST_BYTES
    expect(blobAtCommit(d, head, 'exact.txt', 20)).toBe('01234567890123456789');
    expect(blobAtCommit(d, head, 'exact.txt', 19)).toBeNull();
    expect(blobAtCommit(d, head, 'big.json', MAX_MANIFEST_BYTES + 100)?.length).toBeGreaterThan(MAX_MANIFEST_BYTES);
  });
});

describe('needsTests: a test-named path is trusted only inside the repo', () => {
  test('a test-named symlink that points outside the repo needs a test', () => {
    const outside = tree({ 'tests/x.test.ts': CODE });
    const d = tree();
    mkdirSync(join(d, 'tests'));
    symlinkSync(join(outside, 'tests', 'x.test.ts'), join(d, 'tests', 'x.test.ts'));
    expect(needs(d, 'tests/x.test.ts')).toBe(true);
  });

  test('a test-named path outside the repo needs a test; inside, tests and links to tests stay exempt', () => {
    const outside = tree({ 'tests/y.test.ts': CODE });
    const d = tree({ 'tests/a.test.ts': CODE });
    expect(needsTests(join(outside, 'tests', 'y.test.ts'), d)).toBe(true);
    expect(needs(d, 'tests/a.test.ts')).toBe(false);
    symlinkSync(join(d, 'tests', 'a.test.ts'), join(d, 'tests', 'b.test.ts'));
    expect(needs(d, 'tests/b.test.ts')).toBe(false);
    symlinkSync(join(d, 'src', 'a.ts'), join(d, 'tests', 'c.test.ts'));
    expect(needs(d, 'tests/c.test.ts')).toBe(true);
    expect(needs(d, 'tests/gone.test.ts')).toBe(false); // deleted
  });
});

describe('needsTests: a dangling test-named link is not trusted', () => {
  test('a link to nothing, in tests/ or in the testkit harness, needs a test', () => {
    const d = tree({ 'testkit/testkit.config.json': '{}\n', 'tests/ok.test.ts': CODE, 'testkit/ok.ts': CODE });
    symlinkSync(join(d, 'not-made-yet.ts'), join(d, 'tests', 'dangling.test.ts'));
    symlinkSync('../nowhere-at-all', join(d, 'testkit', 'dangling.ts'));
    symlinkSync(join(tmpdir(), 'goodboy-i30-no-such-target'), join(d, 'tests', 'outside.test.ts'));
    expect(needs(d, 'tests/dangling.test.ts')).toBe(true);
    expect(needs(d, 'testkit/dangling.ts')).toBe(true);
    expect(needs(d, 'tests/outside.test.ts')).toBe(true);
    expect(needs(d, 'tests/ok.test.ts')).toBe(false); // controls
    expect(needs(d, 'testkit/ok.ts')).toBe(false);
  });
});

describe('the Stop test gate: metadata-only sessions', () => {
  const BASE = '{"name":"x","version":"1.0.0","scripts":{"test":"bun test"}}\n';

  /** A committed repo, the session pinned there; `edits` are written after, then Stop runs. */
  async function stopAfter(edits: Record<string, string>, opts: { pin?: boolean; commit?: boolean } = {}) {
    const d = tree({ '.gitignore': 'node_modules\n', 'package.json': BASE, '.claude-plugin/plugin.json': BASE });
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    if (opts.commit !== false) sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const s = sid();
    if (opts.pin !== false) pinCoverageStart(s, d);
    for (const [rel, text] of Object.entries(edits)) {
      write(d, rel, text);
      recordEdit(s, join(d, rel), 0, undefined, Date.now());
    }
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
      cwd: d,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: false })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GOODBOY_TEST_GATE: 'on',
        GOODBOY_TEST_TYPES: 'on',
        GOODBOY_DIFF_COVERAGE: 'on',
        GOODBOY_EXISTING_TESTS: 'on',
        GOODBOY_DISABLE_DELEGATION: '1',
        GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
        GOODBOY_DOCS_GATE: 'off',
      },
    });
    const out = (await new Response(p.stdout).text()) || '{}';
    await p.exited;
    return JSON.parse(out) as { decision?: string; reason?: string };
  }
  const NO_RESULT = /No test result covers the changed code/;

  test('.gitignore and a version-only package.json and plugin.json pass the test gate', async () => {
    const out = await stopAfter({
      '.gitignore': 'node_modules\ndist\n',
      'package.json': `${JSON.stringify({ name: 'x', scripts: { test: 'bun test' }, version: '1.0.1' }, null, 4)}\n`,
      '.claude-plugin/plugin.json': BASE.replace('1.0.0', '1.0.1'),
    });
    const reason = out.reason ?? '';
    expect(reason).not.toMatch(NO_RESULT);
    expect(reason).not.toContain('테스트 게이트');
    expect(reason).not.toContain('Test types missing');
    expect(reason).not.toMatch(/changed-line coverage/);
  }, 60_000);

  test('a package.json with a changed script blocks, and names only it', async () => {
    const out = await stopAfter({
      '.gitignore': 'node_modules\ndist\n',
      'package.json': BASE.replace('1.0.0', '1.0.1').replace('bun test', 'bun test && curl x'),
    });
    expect(out.decision).toBe('block');
    expect(out.reason).toMatch(NO_RESULT);
    expect(out.reason).toContain('package.json');
    expect(out.reason).not.toContain('.gitignore');
  }, 60_000);

  test('a version-only package.json needs a test when the session start HEAD is unknown', async () => {
    const versionOnly = { 'package.json': BASE.replace('1.0.0', '1.0.1'), '.claude-plugin/plugin.json': BASE.replace('1.0.0', '1.0.1') };
    // No pin at all: no start HEAD, so no baseline for the manifests.
    const unpinned = await stopAfter(versionOnly, { pin: false });
    expect(unpinned.decision).toBe('block');
    expect(unpinned.reason).toMatch(NO_RESULT);
    expect(unpinned.reason).toContain('package.json');
    // Pinned in a repo with no commit yet (unborn HEAD): same.
    const unborn = await stopAfter(versionOnly, { commit: false });
    expect(unborn.decision).toBe('block');
    expect(unborn.reason).toMatch(NO_RESULT);
    expect(unborn.reason).toContain('package.json');
  }, 60_000);
});
