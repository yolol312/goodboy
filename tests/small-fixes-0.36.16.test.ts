// v0.36.16 (plan §15.32): four small fixes, each with a real boundary where one exists.
//   1. The push check scans only the lines the push adds on the prose path too: a README-only commit on a
//      tested tree is accepted although a test file of the record already had a `test.todo`.
//   2. The state guard reads the program past prefixes and the `rtk` proxy, needs a separator in the session-dir
//      name, and knows more read-only programs (the marker check shares the program reader).
//   3. `test-write` keeps `notes` (cut at 4000) and refuses one that is no string.
//   4. `gitDirOwner` redirects only into a `.git` dir that has a `HEAD`.
// Repos and session dirs are temporary; git and the hook and CLI processes run for real.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bashMarkerWrite } from '../lib/approval-marker';
import { validateTestResultInput } from '../lib/cli';
import { segmentChanging } from '../lib/outward-command';
import { checkHandoff, revisionTree } from '../lib/push-test';
import { writesGateState } from '../lib/state-guard';
import { statusOf } from '../lib/write-sweep';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-s16-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: GIT_ENV });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';
const commit = (cwd: string, msg: string): void => void sh(cwd, `git add -A && git commit -q -m '${msg}'`);

// ── 1. The push check: the prose path reads the lines the push adds ─────────────────────────────────

describe('S16-AC-1: checkHandoff scans the lines the push adds on the prose path', () => {
  const TEST_REL = 'tests/a.test.ts';
  const OLD_TEST = 'test("a", () => { expect(1).toBe(1); });\ntest.todo("a documented limit");\n';
  const RED_GREEN = [
    {
      id: 'AC-1',
      description: 'a is 1',
      test: 'a.test.ts',
      red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
      green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
    },
  ];

  /** A repo whose first commit (with a test file holding an old `test.todo`) is on its remote, so the push
   *  boundary is that commit. */
  function pushedRepo() {
    const base = tmp();
    const remote = join(base, 'remote.git');
    const d = join(base, 'repo');
    mkdirSync(d);
    sh(base, `git init -q --bare '${remote}'`);
    sh(d, GIT_INIT);
    write(d, 'src/a.ts', 'export const a = 1;\n');
    write(d, TEST_REL, OLD_TEST);
    write(d, 'README.md', '# repo\n\n| v1 | planned |\n');
    commit(d, 'one');
    sh(d, `git remote add origin '${remote}' && git push -q origin HEAD:refs/heads/main && git fetch -q origin`);
    const testFile = join(d, TEST_REL);
    const handoff = { kind: 'push' as const, what: 'git push origin main', cwd: d, revs: ['HEAD'] };
    /** A full-suite style record of `tree`, listing the test file (as a record that ran every test file does). */
    const record = (tree: string): TestResult =>
      ({
        timestamp: '2026-11-05T00:00:00.000Z',
        tested_files: [],
        category: 'fix-bug',
        test_files: [testFile],
        environment: { mode: 'none' },
        suites: [{ name: 'u', command: 'bun test', passed: 3, failed: 0, output: '' }],
        acceptance: RED_GREEN,
        verdict: 'pass',
        tree,
      }) as unknown as TestResult;
    const treeOfHead = (): string => sh(d, 'git rev-parse HEAD^{tree}');
    return { d, testFile, handoff, record, treeOfHead };
  }

  test('a README-only commit on a tested tree is accepted although the record\'s test file already had a todo', () => {
    const w = pushedRepo();
    write(w.d, 'src/a.ts', 'export const a = 2;\n');
    commit(w.d, 'code');
    const tested = w.treeOfHead();
    write(w.d, 'README.md', '# repo\n\n| v1 | released |\n');
    commit(w.d, 'readme');
    expect(w.treeOfHead()).not.toBe(tested);
    expect(checkHandoff(w.handoff, [w.record(tested)])).toEqual({ ok: true, docsOnly: { HEAD: [tested] } });
  });

  test('the exact tree of the record still passes (the old todo is not this push\'s)', () => {
    const w = pushedRepo();
    write(w.d, 'src/a.ts', 'export const a = 2;\n');
    commit(w.d, 'code');
    expect(checkHandoff(w.handoff, [w.record(w.treeOfHead())])).toEqual({ ok: true });
  });

  test('a push that adds a new test.todo line to a test file is still refused, on the exact tree and on a README-only commit', () => {
    const w = pushedRepo();
    write(w.d, TEST_REL, `${OLD_TEST}test.todo("a new one");\n`);
    commit(w.d, 'adds a todo');
    const tested = w.treeOfHead();
    const exact = checkHandoff(w.handoff, [w.record(tested)]);
    expect(exact).toMatchObject({ ok: false, why: 'no-result', rejected: 'a test file has an always-true pattern' });
    write(w.d, 'README.md', '# repo\n\n| v1 | released |\n');
    commit(w.d, 'readme');
    expect(checkHandoff(w.handoff, [w.record(tested)])).toMatchObject({ ok: false, why: 'no-result' });
  });

  test('with no single boundary (no remote-tracking ref) the whole file is scanned: the old todo refuses the README-only commit', () => {
    const w = pushedRepo();
    write(w.d, 'src/a.ts', 'export const a = 2;\n');
    commit(w.d, 'code');
    const tested = w.treeOfHead();
    write(w.d, 'README.md', '# repo\n\n| v1 | released |\n');
    commit(w.d, 'readme');
    sh(w.d, 'git remote remove origin');
    expect(checkHandoff(w.handoff, [w.record(tested)])).toMatchObject({ ok: false, why: 'no-result' });
  });

  test('a code change on top of a tested tree is refused and names what differs from the newest passing record', () => {
    const w = pushedRepo();
    write(w.d, 'src/a.ts', 'export const a = 2;\n');
    commit(w.d, 'code');
    const tested = w.treeOfHead();
    write(w.d, 'src/b.ts', 'export const b = 1;\n');
    commit(w.d, 'more code');
    // `differs` reads the passing record with the push's lines: the old todo does not make it "not passing".
    expect(checkHandoff(w.handoff, [w.record(tested)])).toMatchObject({ ok: false, why: 'no-result', differs: ['src/b.ts'] });
  });

  test('a failed record of the pushed tree does not hide the older passing record: `differs` is read against it', () => {
    const w = pushedRepo();
    write(w.d, 'src/a.ts', 'export const a = 2;\n');
    commit(w.d, 'code');
    const tested = w.treeOfHead();
    write(w.d, 'src/b.ts', 'export const b = 1;\n');
    commit(w.d, 'more code');
    const treeOf = (cwd: string, rev: string) => revisionTree(cwd, rev);
    // Two records: one of the pushed tree that fails (its verdict), one older that passes.
    const bad = { ...w.record(w.treeOfHead()), verdict: 'needs-changes' } as unknown as TestResult;
    const out = checkHandoff(w.handoff, [bad, w.record(tested)], treeOf);
    expect(out).toMatchObject({ ok: false, why: 'no-result', differs: ['src/b.ts'] });
  });
});

// ── 2. The state guard ──────────────────────────────────────────────────────────────────────────────

describe('S16-AC-2: writesGateState reads the program past prefixes and rtk, and needs a separator in the name', () => {
  const READS = [
    'rtk proxy grep -n "goodboy-session" lib/x.ts',
    'rtk grep -rn inGoodboySessionDir lib/',
    'grep -n inGoodboySessionDir lib/x.ts',
    'cut -c1-200 $S/tmp/goodboy-session-*/gate-log.jsonl',
    'env LC_ALL=C cat /tmp/goodboy-session-a/edits.jsonl',
    'timeout 5 tail -n 3 /tmp/goodboy-session-a/gate-log.jsonl',
    'ls -d /tmp/goodboy-session-*',
  ];
  const CHANGES = [
    'rm -rf /tmp/goodboy-session-a',
    'rtk proxy rm -rf /tmp/goodboy-session-a',
    'sudo rm /tmp/goodboy-session-a/edits.jsonl',
    'echo x > /tmp/goodboy-session-a/edits.jsonl',
    'rtk proxy cat a > /tmp/goodboy-session-a/edits.jsonl',
    'env cp x /tmp/goodboy-session-a/edits.jsonl',
    'find /tmp/goodboy-s* -delete',
    'rtk find /tmp/goodboy* -exec rm {} +',
    'truncate -s0 /tmp/GOODBOY-SESSION-a/edits.jsonl',
    'rm -rf /tmp/goodboy_session_a',
    'rm -rf $TMPDIR/goodboy*',
    'timeout 5 sh -c "rm /tmp/goodboy-session-a/x"',
  ];

  test('reads through rtk, prefix commands and cut, and an identifier in a pattern, are not changes', () => {
    for (const c of READS) expect([c, writesGateState(c)]).toEqual([c, false]);
  });

  test('changes through the same wrappers, names with a separator or a glob, and redirects are still caught', () => {
    for (const c of CHANGES) expect([c, writesGateState(c)]).toEqual([c, true]);
  });

  test('every new read-only program reads a session dir without a change', () => {
    for (const p of ['cut -c1-9', 'diff', 'cmp', 'od', 'nl', 'strings', 'readlink', 'realpath', 'shasum', 'md5', 'sha256sum']) {
      const c = `${p} /tmp/goodboy-session-a/edits.jsonl`;
      expect([c, writesGateState(c)]).toEqual([c, false]);
    }
    // A redirect on one of them is still a change.
    expect(writesGateState('nl /tmp/goodboy-session-a/edits.jsonl > /tmp/goodboy-session-a/edits.jsonl')).toBe(true);
  });

  test('the program is read past `rtk` / `rtk proxy` and the prefix commands after it; a nested rtk stays the program', () => {
    expect(writesGateState('rtk /tmp/goodboy-session-a/run.sh')).toBe(true); // runs a script of the session dir
    expect(writesGateState('rtk proxy /tmp/goodboy-session-a/run.sh')).toBe(true);
    expect(writesGateState('/opt/bin/rtk proxy rm /tmp/goodboy-session-a/x')).toBe(true);
    expect(writesGateState('/opt/bin/rtk proxy cat /tmp/goodboy-session-a/x')).toBe(false);
    expect(writesGateState('rtk proxy env LC_ALL=C cat /tmp/goodboy-session-a/x')).toBe(false);
    expect(writesGateState('rtk proxy sudo -n tail /tmp/goodboy-session-a/x')).toBe(false);
    expect(writesGateState('rtk proxy env rm /tmp/goodboy-session-a/x')).toBe(true);
    expect(writesGateState('rtk rtk grep -n x /tmp/goodboy-session-a/x')).toBe(true); // nested: not a read
    expect(writesGateState('rtk proxy rtk grep -n x /tmp/goodboy-session-a/x')).toBe(true);
    expect(writesGateState('rtk proxy')).toBe(false); // names no session dir
  });

  test('an identifier with no separator in the text a non-read program searches is no session dir; a separator or a glob is', () => {
    for (const c of ["git grep -n inGoodboySessionDir lib/", "sed -n '/inGoodboySessionDir/p' lib/x.ts", "awk '/GoodboySession/' lib/x.ts", 'python3 -c "print(goodboysession)"']) {
      expect([c, writesGateState(c)]).toEqual([c, false]);
    }
    for (const c of ['sed -i s/a/b/ /tmp/goodboy_session_a/x', 'sed -i s/a/b/ /tmp/goodboy-session-a/x', 'rm -rf /tmp/goodboy-*', 'rm -rf /tmp/goodboy_*', 'rm /tmp/goodboy-sess*', 'rm /tmp/goodboy*']) {
      expect([c, writesGateState(c)]).toEqual([c, true]);
    }
  });

  test('a read program option that writes a file or runs a command is a change: find -fprint/-rm/-ok, rg --pre, tree -o, file -C, pagers, also through rtk', () => {
    const dir = '/tmp/goodboy-session-a';
    for (const c of [
      `find ${dir} -fprint ${dir}/out`,
      `find ${dir} -fprint0 ${dir}/out`,
      `find ${dir} -fprintf ${dir}/out %p`,
      `find ${dir} -fls ${dir}/out`,
      `find ${dir} -ok rm {} ;`,
      `find ${dir} -okdir rm {} ;`,
      `find ${dir} -rm`,
      `rtk find ${dir} -rm`,
      `find ${dir} "-fprint" /tmp/out`,
      `find ${dir} '-rm'`,
      `rtk find ${dir} -fprint /tmp/out`,
      `rtk proxy find ${dir} -fprint /tmp/out`,
      `rg --pre ./x pattern ${dir}`,
      `rg --pre=./x pattern ${dir}`,
      `rtk proxy rg --pre ./x pattern ${dir}`,
      `rg --hostname-bin ./x pattern ${dir}`,
      `rg --hostname-bin=./x pattern ${dir}`,
      `tree -o /tmp/out ${dir}`,
      `tree -oout ${dir}`,
      `tree -ao /tmp/out ${dir}`,
      `tree -fao /tmp/out ${dir}`,
      `file --compile -m /tmp/magic ${dir}`,
      `file --comp -m /tmp/magic ${dir}`,
      `file --com -m /tmp/magic ${dir}`,
      `file --co -m /tmp/magic ${dir}`,
      `rtk proxy tree -ao /tmp/out ${dir}`,
      `file -C -m /tmp/magic ${dir}`,
      `file -bC ${dir}`,
      `less -o /tmp/log ${dir}/gate-log.jsonl`,
      `more -O /tmp/log ${dir}/gate-log.jsonl`,
    ]) {
      expect([c, writesGateState(c)]).toEqual([c, true]);
    }
    for (const c of [
      `find ${dir} -name x -print`,
      `find ${dir} -type f -printf %p`,
      `rg --pre-glob '*.gz' x ${dir}`,
      `rg -n pattern ${dir}`,
      `rg -n host ${dir}`,
      `rtk proxy find ${dir} -name x`,
      `tree -a ${dir}`,
      `file ${dir}/x`,
      `file -b ${dir}/x`,
      `file --brief ${dir}/x`,
      `file --checking-printout ${dir}/x`,
      `tree --noreport ${dir}`,
      `tree -fa ${dir}`,
    ]) {
      expect([c, writesGateState(c)]).toEqual([c, false]);
    }
  });

  test('the pagers are not on the read list: a plain `less` or `more` of a session file is no read', () => {
    expect(writesGateState('less /tmp/goodboy-session-a/gate-log.jsonl')).toBe(true);
    expect(writesGateState('more /tmp/goodboy-session-a/gate-log.jsonl')).toBe(true);
  });

  test('the approval-marker check shares the program reader: `sudo ls <marker>` is a read, `sudo touch <marker>` a change', () => {
    const marker = '.claude/.goodboy-stop-approved-abcdef12.txt';
    expect(segmentChanging(`sudo ls ${marker}`, (w) => /approved/.test(w), new Set(['ls']))).toBeNull();
    expect(segmentChanging(`sudo touch ${marker}`, (w) => /approved/.test(w), new Set(['ls']))).not.toBeNull();
    expect(bashMarkerWrite(`sudo ls ${marker}`)).toBeNull();
    expect(bashMarkerWrite(`sudo touch ${marker}`)).not.toBeNull();
    expect(bashMarkerWrite(`rtk proxy touch ${marker}`)).not.toBeNull();
    expect(bashMarkerWrite(`rtk proxy cat ${marker}`)).toBeNull();
  });

  /** The PreToolUse hook as a process, with the temp dir as the system temp dir. */
  async function pre(command: string) {
    const base = tmp();
    const cwd = join(base, 'repo');
    mkdirSync(cwd);
    const payload = { session_id: `s16-${Math.random().toString(36).slice(2)}`, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_s16', tool_input: { command } };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1' },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
  }

  test('end to end: the hook lets `rtk proxy grep -n goodboy-session lib/x.ts` through and denies `rtk proxy rm -rf $TMPDIR/goodboy-session-x`', async () => {
    const read = await pre('rtk proxy grep -n goodboy-session lib/x.ts');
    expect(read.reason).not.toContain("goodboy's own session state");
    expect(read.denied).toBe(false);
    const change = await pre('rtk proxy rm -rf $TMPDIR/goodboy-session-x');
    expect(change.denied).toBe(true);
    expect(change.reason).toContain("goodboy's own session state");
  });
});

// ── 3. test-write keeps `notes` ─────────────────────────────────────────────────────────────────────

describe('S16-AC-3: test-write keeps `notes`, cut at 4000, and refuses one that is no string', () => {
  function input(over: Record<string, unknown> = {}): { parsed: Record<string, unknown>; base: string } {
    const base = tmp();
    write(base, 'a.test.ts', 'test("a", () => {});\n');
    return {
      base,
      parsed: {
        tested_files: ['src/a.ts'],
        category: 'fix-bug',
        test_files: ['a.test.ts'],
        environment: { mode: 'none' },
        suites: [{ name: 'u', command: 'bun test', passed: 1, failed: 0, output: '', type: 'unit', duration_ms: 5 }],
        acceptance: [],
        verdict: 'pass',
        ...over,
      },
    };
  }
  const run = (over: Record<string, unknown>) => {
    const { parsed, base } = input(over);
    return validateTestResultInput(parsed, [base]);
  };

  test('a string note is kept as written', () => {
    const r = run({ notes: 'left out the slow e2e suite; one flaky retry' });
    expect(r.ok).toBe(true);
    expect(r.value?.notes).toBe('left out the slow e2e suite; one flaky retry');
  });

  test('a note longer than 4000 characters is cut at 4000, one of exactly 4000 is whole', () => {
    expect(run({ notes: 'x'.repeat(5000) }).value?.notes).toBe('x'.repeat(4000));
    expect(run({ notes: 'y'.repeat(4000) }).value?.notes).toBe('y'.repeat(4000));
    expect(run({ notes: `${'a'.repeat(4000)}TAIL` }).value?.notes).not.toContain('TAIL');
  });

  test('an empty or blank note is absent from the record', () => {
    for (const notes of ['', '   ', '\n\t ']) {
      const r = run({ notes });
      expect(r.ok).toBe(true);
      expect(r.value).not.toHaveProperty('notes');
    }
    expect(run({}).value).not.toHaveProperty('notes');
  });

  test('a note that is no string is refused with an error', () => {
    for (const notes of [5, { text: 'x' }, ['x'], true, null]) {
      const r = run({ notes });
      expect([JSON.stringify(notes), r.ok]).toEqual([JSON.stringify(notes), false]);
      expect(r.errors).toContain('notes, when given, must be a string.');
    }
  });

  test('through `cli.ts test-write` as a process: the note is in the saved record, cut, and a number is refused', () => {
    const proj = tmp();
    sh(proj, GIT_INIT);
    write(proj, 'src/a.ts', 'export const a = 1;\n');
    write(proj, 'a.test.ts', 'test("a", () => {});\n');
    commit(proj, 'init');
    const env = { ...GIT_ENV } as Record<string, string>;
    delete env.CLAUDE_CODE_SESSION_ID;
    Object.assign(env, { TMPDIR: proj, CLAUDE_PROJECT_DIR: proj });
    const body = {
      tested_files: [join(proj, 'src/a.ts')],
      category: 'fix-bug',
      test_files: [join(proj, 'a.test.ts')],
      environment: { mode: 'none' },
      suites: [{ name: 'u', command: 'bun test', passed: 1, failed: 0, output: '', type: 'unit', duration_ms: 5 }],
      acceptance: [],
      verdict: 'pass',
    };
    const cli = (extra: Record<string, unknown>) => {
      const p = Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: proj, env, stdin: new TextEncoder().encode(JSON.stringify({ ...body, ...extra })), stdout: 'pipe', stderr: 'pipe' });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    const ok = cli({ notes: 'z'.repeat(4500) });
    expect(ok.code).toBe(0);
    const saved = JSON.parse(readFileSync((JSON.parse(ok.out) as { path: string }).path, 'utf8')) as { notes?: string };
    expect(saved.notes).toBe('z'.repeat(4000));
    const bad = cli({ notes: 12 });
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('notes, when given, must be a string.');
    const none = cli({});
    expect(none.code).toBe(0);
    expect(JSON.parse(readFileSync((JSON.parse(none.out) as { path: string }).path, 'utf8'))).not.toHaveProperty('notes');
  });
});

// ── 4. gitDirOwner: a `.git` dir with no HEAD is no redirect ────────────────────────────────────────

describe('S16-AC-4: statusOf redirects only into a `.git` dir that has a HEAD', () => {
  test('a repo under a plain dir named `.git` (no HEAD) reads as that repo, with its files', () => {
    const base = tmp();
    const proj = join(base, '.git', 'proj');
    mkdirSync(join(proj, 'src'), { recursive: true });
    sh(proj, 'git init -q');
    const a = write(proj, 'src/a.py', 'x\n');
    expect(existsSync(join(base, '.git', 'HEAD'))).toBe(false);
    expect(statusOf(join(proj, 'src'), 5_000)).toEqual({ top: proj, files: [a] });
    expect(statusOf(proj, 5_000)).toEqual({ top: proj, files: [a] });
  });

  test('a plain dir named `.git` with no repo inside reads as no repo (not as its parent)', () => {
    const base = tmp();
    mkdirSync(join(base, '.git', 'x'), { recursive: true });
    write(base, 'file.txt', 'f\n'); // the parent is no repo either
    expect(statusOf(join(base, '.git', 'x'), 5_000)).toBeNull();
  });

  test('a git dir below a `.git` with no HEAD is the one taken: `<base>/.git/proj/.git/hooks` reads as `<base>/.git/proj`', () => {
    const base = tmp();
    const proj = join(base, '.git', 'proj');
    mkdirSync(proj, { recursive: true });
    sh(proj, GIT_INIT);
    const a = write(proj, 'src/a.py', 'x\n');
    expect(statusOf(join(proj, '.git', 'hooks'), 5_000)).toEqual({ top: proj, files: [a] });
    expect(statusOf(join(proj, '.git'), 5_000)).toEqual({ top: proj, files: [a] });
  });

  test('only a dir named `.git` counts: a repo that holds a file named HEAD at its top is read as itself', () => {
    const base = tmp();
    const repo = join(base, 'plain', 'repo');
    mkdirSync(repo, { recursive: true });
    sh(repo, GIT_INIT);
    write(repo, 'HEAD', 'not a git dir\n');
    const a = write(repo, 'src/a.py', 'x\n');
    expect(statusOf(join(repo, 'src'), 5_000)).toEqual({ top: repo, files: expect.arrayContaining([a]) });
  });

  test('a real git dir still reads as its work tree: <top>/.git/hooks and <top>/.git', () => {
    const top = tmp();
    sh(top, GIT_INIT);
    const a = write(top, 'src/a.py', 'x\n');
    expect(statusOf(join(top, '.git', 'hooks'), 5_000)).toEqual({ top, files: [a] });
    expect(statusOf(join(top, '.git'), 5_000)).toEqual({ top, files: [a] });
  });

  test('a git dir reached through a link to the project is swept as the project in the link\'s own spelling', () => {
    const base = tmp();
    const top = join(base, 'top');
    mkdirSync(top);
    sh(top, GIT_INIT);
    write(top, 'src/a.py', 'x\n');
    const alias = join(base, 'alias');
    symlinkSync(top, alias);
    expect(statusOf(join(alias, '.git', 'hooks'), 5_000)).toEqual({ top: alias, files: [join(alias, 'src', 'a.py')] });
  });

  test('a link spelled `.git` into a repo is not redirected to the dir that holds the link', () => {
    const base = tmp();
    const r = join(base, 'r');
    mkdirSync(r);
    sh(r, GIT_INIT);
    write(r, 'src/b.py', 'x\n');
    const x = join(base, 'x');
    mkdirSync(x);
    symlinkSync(r, join(x, '.git'));
    // x has no repo of its own; the link's `.git` (the repo r, no HEAD at r/HEAD) is read as git reads it.
    expect(statusOf(join(x, '.git', 'src'), 5_000)).toEqual({ top: join(x, '.git'), files: [join(x, '.git', 'src', 'b.py')] });
  });

  test('a link spelled `.git` to a real git dir is swept as the repo it belongs to, in its real spelling', () => {
    const base = tmp();
    const r = join(base, 'r');
    mkdirSync(r);
    sh(r, GIT_INIT);
    write(r, 'src/b.py', 'x\n');
    const y = join(base, 'y');
    mkdirSync(y);
    symlinkSync(join(r, '.git'), join(y, '.git'));
    expect(statusOf(join(y, '.git', 'hooks'), 5_000)).toEqual({ top: r, files: [join(r, 'src', 'b.py')] });
  });
});
