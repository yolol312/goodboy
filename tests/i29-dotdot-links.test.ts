// #29: a tool's file path with a `..` after a symlinked dir. `path.resolve` collapses it before
//   the link is followed, so the recorded path was not the file the OS opened, and every
//   name-based rule (test names, the testkit harness, repository metadata) judged the wrong path.
//   One helper (lib/file-tracker.ts openedPath) now turns a tool's path into the path the OS
//   opens; the recorder, the read-before-edit lookup and the Bash read classification use it.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { classifyBashRead } from '../lib/bash-read';
import { openedPath } from '../lib/file-tracker';

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
  const s = `i29${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
const CODE = 'export const a = 1;\n';

/** A committed scratch repo with real files (its path is real: no alias in $TMPDIR). */
function repo(files: Record<string, string> = {}, links: Record<string, string> = {}): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i29-')));
  dirs.push(d);
  for (const [p, t] of Object.entries({ 'src/a.ts': CODE, '.gitignore': 'node_modules\n', 'notes.md': 'hello\n', ...files })) write(d, p, t);
  for (const [p, target] of Object.entries(links)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    symlinkSync(target, join(d, p));
  }
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  return d;
}
/** `<root>/<raw>` with the `..` kept (join would collapse it). */
const spell = (d: string, raw: string) => `${d}/${raw}`;

async function runHook(hook: string, cwd: string, session: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: session, cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', ...env },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(out || '{}') as { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
}
const editEvent = (file: string) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
  tool_response: {},
});
function recordedEdits(session: string): string[] {
  try {
    return readFileSync(join(tmpdir(), `goodboy-session-${session}`, 'edits.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { file: string }).file);
  } catch {
    return [];
  }
}

describe('openedPath: the path the OS opens', () => {
  test('a path without `..` is plain resolve', () => {
    expect(openedPath('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts');
    expect(openedPath('/work/proj', '/abs/x.ts')).toBe('/abs/x.ts');
    expect(openedPath('/work/proj', './src//a.ts')).toBe('/work/proj/src/a.ts');
  });

  test('a `..` after a link goes up from the link target, not from the link', () => {
    const d = repo({ 'sub/deep/x.txt': 'x\n', 'sub/y.txt': 'y\n' }, { lnk: 'sub/deep', self: '.' });
    expect(openedPath(d, 'lnk/../y.txt')).toBe(join(d, 'sub', 'y.txt'));
    expect(openedPath('/elsewhere', `${d}/lnk/../y.txt`)).toBe(join(d, 'sub', 'y.txt'));
    expect(openedPath(d, 'self/../src/a.ts')).toBe(join(dirname(d), 'src', 'a.ts')); // self -> d, so `..` leaves d
    expect(openedPath(d, 'sub/deep/../y.txt')).toBe(join(d, 'sub', 'y.txt')); // a plain dir: as resolve
    expect(openedPath(d, 'lnk/../../src/a.ts')).toBe(join(d, 'src', 'a.ts')); // two ups: link target, then its parent
    expect(openedPath(d, 'src/../lnk/../y.txt')).toBe(join(d, 'sub', 'y.txt'));
  });

  test('a prefix that does not exist or is no dir goes up by name', () => {
    const d = repo();
    expect(openedPath(d, 'nope/../src/a.ts')).toBe(join(d, 'src', 'a.ts'));
    expect(openedPath(d, 'src/a.ts/../b.ts')).toBe(join(d, 'src', 'b.ts'));
    expect(openedPath('/', '../../x')).toBe('/x');
  });

  test('the Bash read classification records the same path', () => {
    const d = repo({ 'sub/deep/x.txt': 'x\n', 'sub/y.txt': 'y\n' }, { lnk: 'sub/deep' });
    expect(classifyBashRead('cat lnk/../y.txt', d)).toEqual([join(d, 'sub', 'y.txt')]);
    expect(classifyBashRead('cat src/a.ts', d)).toEqual([join(d, 'src', 'a.ts')]);
  });
});

describe('the recorder stores the file the OS opens, and each such edit needs a test at the Stop gate', () => {
  const NO_RESULT = /No test result covers the changed code/;

  /** Edit `raw` (with a `..` after a link) in a scratch repo; `target` is the repo-relative file the OS opens. */
  async function editThroughLink(d: string, raw: string, target: string, content: string) {
    write(d, target, content); // the edit's effect: the real file changes
    const s = sid();
    const post = await runHook('post-tool-use', d, s, editEvent(spell(d, raw)));
    expect(post.decision).toBeUndefined();
    const recorded = recordedEdits(s);
    const stop = await runHook(
      'stop',
      d,
      s,
      { hook_event_name: 'Stop', stop_hook_active: false },
      { GOODBOY_TEST_GATE: 'on', GOODBOY_TEST_TYPES: 'on', GOODBOY_DIFF_COVERAGE: 'on', GOODBOY_EXISTING_TESTS: 'on', GOODBOY_DOCS_GATE: 'off' },
    );
    return { recorded, stop };
  }

  test('tests/self -> . : `tests/self/../src/a.ts` is src/a.ts', async () => {
    const d = repo({ 'tests/ok.test.ts': CODE }, { 'tests/self': '.' });
    const { recorded, stop } = await editThroughLink(d, 'tests/self/../src/a.ts', 'src/a.ts', 'export const a = 2;\n');
    expect(recorded).toEqual([join(d, 'src', 'a.ts')]);
    expect(stop.decision).toBe('block');
    expect(stop.reason).toMatch(NO_RESULT);
    expect(stop.reason).toContain('src/a.ts');
  }, 60_000);

  test('testkit/self -> . with the testkit marker: `testkit/self/../src/a.ts` is src/a.ts', async () => {
    const d = repo({ 'testkit/testkit.config.json': '{}\n' }, { 'testkit/self': '.' });
    const { recorded, stop } = await editThroughLink(d, 'testkit/self/../src/a.ts', 'src/a.ts', 'export const a = 2;\n');
    expect(recorded).toEqual([join(d, 'src', 'a.ts')]);
    expect(stop.decision).toBe('block');
    expect(stop.reason).toMatch(NO_RESULT);
    expect(stop.reason).toContain('src/a.ts');
  }, 60_000);

  test('a CI workflow behind .github/ISSUE_TEMPLATE/lnk -> ../foo is the workflow', async () => {
    const d = repo({ '.github/workflows/ci.yml': 'on: push\n', '.github/foo/keep.txt': 'k\n' }, { '.github/ISSUE_TEMPLATE/lnk': '../foo' });
    const { recorded, stop } = await editThroughLink(d, '.github/ISSUE_TEMPLATE/lnk/../workflows/ci.yml', '.github/workflows/ci.yml', 'on: push\njobs: {}\n');
    expect(recorded).toEqual([join(d, '.github', 'workflows', 'ci.yml')]);
    expect(stop.decision).toBe('block');
    expect(stop.reason).toMatch(NO_RESULT);
    expect(stop.reason).toContain('.github/workflows/ci.yml');
  }, 60_000);

  test('lnk/../.gitignore reaches real/.gitignore, a link to code, not the exempt root .gitignore', async () => {
    const d = repo({ 'real/sub/x.txt': 'x\n' }, { lnk: 'real/sub', 'real/.gitignore': '../src/a.ts' });
    // The edit writes through the link to src/a.ts.
    const { recorded, stop } = await editThroughLink(d, 'lnk/../.gitignore', 'src/a.ts', 'export const a = 2;\n');
    expect(recorded).toEqual([join(d, 'real', '.gitignore')]);
    expect(stop.decision).toBe('block');
    expect(stop.reason).toMatch(NO_RESULT);
  }, 60_000);

  test('a plain path is recorded as before, and a `..` through a plain dir as resolve', async () => {
    const d = repo({ 'src/b.ts': CODE });
    const s = sid();
    await runHook('post-tool-use', d, s, editEvent(join(d, 'src', 'a.ts')));
    await runHook('post-tool-use', d, s, editEvent('src/b.ts'));
    await runHook('post-tool-use', d, s, editEvent(spell(d, 'src/../notes.md')));
    expect(recordedEdits(s)).toEqual([join(d, 'src', 'a.ts'), join(d, 'src', 'b.ts'), join(d, 'notes.md')]);
  }, 60_000);
});

describe('read-before-edit agrees on the file the OS opens', () => {
  const readEvent = (file: string) => ({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file }, tool_response: {} });
  const tryEdit = async (d: string, s: string, file: string) => {
    const out = await runHook('pre-tool-use', d, s, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string: 'hello', new_string: 'world' },
    });
    return { denied: out.hookSpecificOutput?.permissionDecision === 'deny', reason: out.hookSpecificOutput?.permissionDecisionReason ?? '' };
  };
  // notes.md is a document: only read-before-edit decides. docs/self -> . so `docs/self/../notes.md` is notes.md.
  const sandbox = () => repo({ 'docs/x.md': 'x\n' }, { 'docs/self': '.' });

  test('without a read, an edit through `..` is denied and names the real file', async () => {
    const d = sandbox();
    const r = await tryEdit(d, sid(), spell(d, 'docs/self/../notes.md'));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain(join(d, 'notes.md'));
  }, 60_000);

  test('a read through the same `..` path allows the edit', async () => {
    const d = sandbox();
    const s = sid();
    const raw = spell(d, 'docs/self/../notes.md');
    await runHook('post-tool-use', d, s, readEvent(raw));
    expect((await tryEdit(d, s, raw)).denied).toBe(false);
  }, 60_000);

  test('a read through the plain path allows an edit through `..`, and the reverse', async () => {
    const d = sandbox();
    const s = sid();
    await runHook('post-tool-use', d, s, readEvent(join(d, 'notes.md')));
    expect((await tryEdit(d, s, spell(d, 'docs/self/../notes.md'))).denied).toBe(false);
    const d2 = sandbox();
    const s2 = sid();
    await runHook('post-tool-use', d2, s2, readEvent(spell(d2, 'docs/self/../notes.md')));
    expect((await tryEdit(d2, s2, join(d2, 'notes.md'))).denied).toBe(false);
  }, 60_000);

  test('a Bash cat through `..` counts as a read of the real file', async () => {
    const d = sandbox();
    const s = sid();
    await runHook('post-tool-use', d, s, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'cat docs/self/../notes.md' },
      tool_response: { stdout: 'hello\n' },
    });
    expect((await tryEdit(d, s, join(d, 'notes.md'))).denied).toBe(false);
  }, 60_000);
});

// Coverage closers (test-unit): the MultiEdit recorder lines and the re-Read lookup also use the
//   path the OS opens.
describe('MultiEdit and the re-Read gate use the path the OS opens', () => {
  // docs/self -> . so `docs/self/../notes.md` is notes.md and `docs/self/../src/a.ts` is src/a.ts.
  const sandbox = () => repo({ 'docs/x.md': 'x\n' }, { 'docs/self': '.' });

  test('MultiEdit records the real file for its file_path and for each edit file_path', async () => {
    const d = sandbox();
    const s = sid();
    const post = await runHook('post-tool-use', d, s, {
      hook_event_name: 'PostToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: spell(d, 'docs/self/../notes.md'),
        edits: [{ old_string: 'a', new_string: 'b' }, { file_path: spell(d, 'docs/self/../src/a.ts'), old_string: 'a', new_string: 'b' }],
      },
      tool_response: {},
    });
    expect(post.decision).toBeUndefined();
    expect(recordedEdits(s)).toEqual([join(d, 'notes.md'), join(d, 'src', 'a.ts')]);
  }, 60_000);

  test('a second full Read through `..` of an unchanged file is the redundant re-Read of the real file', async () => {
    const d = sandbox();
    const s = sid();
    const raw = spell(d, 'docs/self/../notes.md');
    const read = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: raw }, tool_response: {} };
    await runHook('post-tool-use', d, s, read);
    const again = (file: string) => runHook('pre-tool-use', d, s, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file } });
    for (const file of [raw, join(d, 'notes.md')]) {
      const out = await again(file);
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('H2-01');
    }
    // A file never read is no re-Read.
    expect((await again(spell(d, 'docs/self/../src/a.ts'))).hookSpecificOutput?.permissionDecision).not.toBe('deny');
  }, 60_000);
});
