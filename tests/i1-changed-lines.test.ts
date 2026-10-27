// I1 changed lines (track I §15, issue #2): every changed code line runs in a test of the
// recorded tree. diff coverage reports the files a report saw at all, the files the diff has
// and its base; per changed file only passing records of its current content count; a
// changed code file the diff has and the report lacks counts as not covered (M24/M25);
// exemptions are file globs the user decided in the policy file, pinned at the session start
// with the start HEAD; the test gate blocks on gaps (GOODBOY_DIFF_COVERAGE=on|warn|off).
// Repos and session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  addedUserGlobs,
  changedLineGaps,
  changedLineReason,
  coverageExemptions,
  diffCoverageMode,
  emptyTree,
  exemptionsInText,
  isPolicyFile,
  pinCoverageStart,
  repoTop,
  sessionCoverageStart,
} from '../lib/changed-coverage';
import { changedLines, diffCoverage, diffCoverageOf } from '../lib/diff-coverage';
import { ensureSessionDir, recordEdit, textAfterEdit } from '../lib/file-tracker';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';
import { afterBash, changedFilesSince, placedFiles, statusFiles, writesIndirectly } from '../lib/write-sweep';
import { noteBashStart, safeToolUseId, takeBashStart } from '../lib/approval-marker';
import type { ChangedFileEdit } from '../lib/review-validator';
import type { TestResult } from '../lib/types';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const BASE = 'a'.repeat(40);
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i1-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `i1${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
function gitRepo(d: string): void {
  sh(d, "git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false");
}
const policy = (globs: string) => ['## P1 Hooks run in child processes', '- decide: human', '- source: user 2026-10-16', `- coverage-exempt: ${globs}`, ''].join('\n');
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

type Changed = NonNullable<NonNullable<TestResult['coverage']>['changed']>;
/** A passing record that tests `tested` (absolute paths), made `msAgo` ago. */
const result = (changed: Changed | undefined, tested: string[], msAgo = 0, verdict = 'pass'): TestResult =>
  ({
    timestamp: iso(msAgo),
    verdict,
    tested_files: tested,
    coverage: changed ? { status: 'measured', changed } : { status: 'unavailable', reason: 'no tool here' },
  }) as unknown as TestResult;
/** diff coverage output; `diff` defaults to one added line in each file named. */
const changed = (files: Record<string, [number, number]>, inReport: string[] = Object.keys(files), base = BASE, diff?: Record<string, number>): Changed => ({
  covered: Object.values(files).reduce((s, [c]) => s + c, 0),
  total: Object.values(files).reduce((s, [, t]) => s + t, 0),
  files_without_executed_changes: [],
  files: Object.fromEntries(Object.entries(files).map(([f, [c, t]]) => [f, { covered: c, total: t }])),
  in_report: inReport,
  diff_lines: diff ?? Object.fromEntries([...new Set([...Object.keys(files), ...inReport])].map((f) => [f, 1])),
  base,
});
/** Edits with no time (any record that tests the file counts), or edited `msAgo` ago. */
const edits = (files: string[], msAgo?: number): ChangedFileEdit[] => files.map((file) => ({ file, lastEditTimestamp: msAgo === undefined ? null : iso(msAgo) }));
/** A temp dir with these files (default: one line of runtime code each). */
function proj(files: Record<string, string> | string[]): { d: string; f: (rel: string) => string } {
  const d = tmp();
  const all = Array.isArray(files) ? Object.fromEntries(files.map((p) => [p, 'export const a = 1;\n'])) : files;
  for (const [p, text] of Object.entries(all)) {
    mkdirSync(join(d, p, '..'), { recursive: true });
    writeFileSync(join(d, p), text);
  }
  return { d, f: (rel) => join(d, rel) };
}

describe('diff coverage', () => {
  test('in_report lists every changed file the report has; diff_lines every file the diff has', () => {
    const hits = new Map([
      ['src/a.ts', new Map([[1, true], [2, false]])],
      ['src/types.ts', new Map([[9, true]])],
    ]);
    const want = new Map([
      ['src/a.ts', new Set([1, 2])],
      ['src/types.ts', new Set([3])], // only a non-executable line changed
      ['src/b.ts', new Set([1])], // no test loaded it
      ['src/old.ts', new Set<number>()], // only lines removed
    ]);
    const out = diffCoverage(hits, '/r', want);
    expect(out.files).toEqual({ 'src/a.ts': { covered: 1, total: 2 } });
    expect(out.in_report).toEqual(['src/a.ts', 'src/types.ts']);
    expect(out.diff_lines).toEqual({ 'src/a.ts': 2, 'src/b.ts': 1, 'src/old.ts': 0, 'src/types.ts': 1 });
  });

  test('a report path is matched against every repo file, not only the changed ones', () => {
    // A Go profile names files by module path: example.com/app/cmd/tool/main.go is
    //   cmd/tool/main.go, not a changed root main.go.
    const hits = new Map([['example.com/app/cmd/tool/main.go', new Map([[1, true], [2, true]])]]);
    const want = new Map([['main.go', new Set([1, 2, 3, 4, 5])]]);
    const known = new Set(['main.go', 'cmd/tool/main.go']);
    const out = diffCoverage(hits, '/r', want, known);
    expect(out.files).toEqual({});
    expect(out.in_report).toEqual([]);
    // The module path maps it to the root file; without the module, a longer report path is no repo file.
    expect(diffCoverage(new Map([['example.com/app/main.go', new Map([[1, true]])]]), '/r', want, known, [['example.com/app', '']]).in_report).toEqual(['main.go']);
    expect(diffCoverage(new Map([['example.com/app/main.go', new Map([[1, true]])]]), '/r', want, known).in_report).toEqual([]);
    // A shorter report path (a JaCoCo package path) needs one repo file that ends with it.
    const java = new Map([['com/x/A.java', new Set([3])]]);
    expect(diffCoverage(new Map([['com/x/A.java', new Map([[3, true]])]]), '/r', new Map([['src/main/java/com/x/A.java', new Set([3])]]), new Set(['src/main/java/com/x/A.java'])).files).toEqual({ 'src/main/java/com/x/A.java': { covered: 1, total: 1 } });
    expect(diffCoverage(new Map([['x/A.java', new Map([[3, true]])]]), '/r', java, new Set(['com/x/A.java', 'org/x/A.java'])).in_report).toEqual([]); // ambiguous
    // A Cobertura path from a src layout: pkg/app.py is src/pkg/app.py, not a root app.py.
    const py = new Map([['src/pkg/app.py', new Set([1])]]);
    expect(diffCoverage(new Map([['pkg/app.py', new Map([[1, true]])]]), '/r', py, new Set(['app.py', 'src/pkg/app.py'])).in_report).toEqual(['src/pkg/app.py']);
    // A Go module in a subdirectory whose module name is not its dir name.
    const goSub = new Map([['backend/pkg/x.go', new Set([1])]]);
    expect(diffCoverage(new Map([['example.com/svc/pkg/x.go', new Map([[1, true]])]]), '/r', goSub, new Set(['backend/go.mod', 'backend/pkg/x.go']), [['example.com/svc', 'backend']]).in_report).toEqual(['backend/pkg/x.go']);
  });

  test('a report path that names a file outside the repo, or one git does not list, is not ours', () => {
    const { d } = proj({ 'index.ts': 'export const i = 1;\n', 'node_modules/dep/index.ts': 'export const n = 1;\n' });
    const want = new Map([['index.ts', new Set([1])]]);
    const run = (p: string) => diffCoverage(new Map([[p, new Map([[1, true]])]]), d, want, new Set(['index.ts'])).in_report;
    expect(run('node_modules/dep/index.ts')).toEqual([]); // on disk, not a repo file
    expect(run('/elsewhere/checkout/index.ts')).toEqual([]); // another checkout
    // Longer than the repo file, and not on disk: a sibling package, a build dir, a bundler path.
    for (const p of ['../shared/index.ts', 'dist/index.ts', 'webpack://x/./index.ts']) expect([p, run(p)]).toEqual([p, []]);
    // A Go -coverpkg=all dependency is not the root errors.go.
    const errs = new Map([['errors.go', new Set([1])]]);
    expect(diffCoverage(new Map([['github.com/pkg/errors/errors.go', new Map([[1, false]])]]), d, errs, new Set(['errors.go', 'go.mod']), [['example.com/app', '']]).in_report).toEqual([]);
    expect(run(join(d, 'index.ts'))).toEqual(['index.ts']);
    expect(run('index.ts')).toEqual(['index.ts']);
    // A shorter report path that a file on disk owns (an ignored build dir) is not the changed
    //   file that merely ends with it; with no such file on disk, the suffix names it.
    const gen = new Map([['src/build/gen.ts', new Set([1])]]);
    const genHits = new Map([['build/gen.ts', new Map([[1, true]])]]);
    const onDisk = proj({ 'build/gen.ts': 'export const g = 1;\n', 'src/build/gen.ts': 'export const g = 2;\n' }).d;
    expect(diffCoverage(genHits, onDisk, gen, new Set(['src/build/gen.ts'])).in_report).toEqual([]);
    expect(diffCoverage(genHits, proj({ 'src/build/gen.ts': 'export const g = 2;\n' }).d, gen, new Set(['src/build/gen.ts'])).in_report).toEqual(['src/build/gen.ts']);
  });

  test('a move or copy records its target as an edit (mv keeps the old mtime)', () => {
    const { d } = proj(['src/foo.ts']);
    sh(d, 'mv src/foo.ts src/bar.ts');
    expect(writesIndirectly('mv src/foo.ts src/bar.ts')).toBe(true);
    expect(writesIndirectly('git -C . checkout -- a.ts')).toBe(true);
    expect(writesIndirectly('git status')).toBe(false);
    expect(placedFiles('mv src/foo.ts src/bar.ts', d)).toEqual([join(d, 'src', 'bar.ts')]);
    expect(placedFiles('cp src/bar.ts /tmp/elsewhere.ts', d)).toEqual([]); // outside the project
  });

  /** A committed src/foo.ts whose mtime is an hour old, then moved to src/bar.ts: `mv` keeps the mtime. */
  function movedOldFile(): { d: string; bar: string } {
    const d = tmp();
    gitRepo(d);
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src', 'foo.ts'), 'export const f = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(d, 'src', 'foo.ts'), old, old);
    sh(d, 'mv src/foo.ts src/bar.ts');
    const bar = join(d, 'src', 'bar.ts');
    expect(Date.now() - statSync(bar).mtimeMs).toBeGreaterThan(30 * 60_000); // the old mtime survived the move
    expect(changedFilesSince(d, Date.now() - 5 * 60_000)).toEqual([bar]); // the rename moved its ctime
    return { d, bar };
  }

  test('a directory moved into place, and a git mv, are recorded from the status snapshot and ctime', () => {
    const d = tmp();
    gitRepo(d);
    mkdirSync(join(d, 'src', 'pkg'), { recursive: true });
    mkdirSync(join(d, 'lib'));
    writeFileSync(join(d, 'src', 'pkg', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(join(d, 'src', 'y.ts'), 'export const y = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(d, 'src', 'pkg', 'x.ts'), old, old);
    Bun.sleepSync(1_200); // its ctime is now before the call's start
    const s = sid();
    noteBashStart(s, 'toolu_i1dir', d, 'mv src/pkg lib/ && git mv src/y.ts lib/y.ts', undefined, statusFiles(d) ?? undefined);
    sh(d, 'mv src/pkg lib/ && git mv src/y.ts lib/y.ts');
    const x = join(d, 'lib', 'pkg', 'x.ts');
    expect(changedFilesSince(d, Date.now() - 1_000)).not.toContain(x); // a moved directory keeps its files' times
    const after = afterBash(s, 'toolu_i1dir', d, 'mv src/pkg lib/ && git mv src/y.ts lib/y.ts', undefined);
    expect(after.context ?? '').toContain(x);
    expect(after.context ?? '').toContain(join(d, 'lib', 'y.ts'));
  });

  test("the status snapshot counts only for its own repo: another repo's uncommitted files are not this call's writes", () => {
    const a = tmp();
    gitRepo(a);
    writeFileSync(join(a, 'a.ts'), 'export const a = 1;\n');
    sh(a, "git add -A && git commit -q -m 'ABC-1 init'");
    const b = tmp();
    gitRepo(b);
    writeFileSync(join(b, 'README.md'), 'b\n');
    sh(b, "git add -A && git commit -q -m 'ABC-1 init'");
    writeFileSync(join(b, 'wip1.ts'), 'export const w = 1;\n'); // the user's work in progress in b
    Bun.sleepSync(1_500); // its times are before the call's start
    const s = sid();
    const command = `cd ${b} && git checkout -- README.md`;
    noteBashStart(s, 'toolu_i1other', a, command, undefined, statusFiles(a) ?? undefined);
    // The post hook reports the cwd the shell ended in: b.
    const after = afterBash(s, 'toolu_i1other', b, command, undefined);
    expect(after.context ?? '').not.toContain(join(b, 'wip1.ts'));
  });

  test('a start note whose status is not {top, files} gives no snapshot instead of a crash', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'README.md'), 'r\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const wip = join(d, 'wip.ts');
    writeFileSync(wip, 'export const w = 1;\n'); // the user's work in progress, older than the call
    Bun.sleepSync(1_500);
    const s = sid();
    const note = (id: string, status: unknown) =>
      writeFileSync(join(ensureSessionDir(s), `bash-start-${safeToolUseId(id)}.json`), JSON.stringify({ t: Date.now(), cwd: d, tuid: id, markers: [], status }));
    // An older note kept a list of paths; anything but {top: string, files: array} is no snapshot.
    const bad: unknown[] = [[wip], { top: d }, { top: d, files: 'wip.ts' }, { top: 7, files: [] }, { files: [wip] }, null, 'wip.ts', 3];
    bad.forEach((status, i) => {
      const id = `toolu_i1bad${i}`;
      note(id, status);
      const start = takeBashStart(s, id, d);
      expect([JSON.stringify(status), 'status' in start]).toEqual([JSON.stringify(status), false]);
      expect(start.since).toBeGreaterThan(Date.now() - 10_000); // the note was read: not the 5-minute fallback
    });
    note('toolu_i1good', { top: d, files: [wip] });
    expect(takeBashStart(s, 'toolu_i1good', d).status).toEqual({ top: d, files: [wip] });
    // Through afterBash: a half-formed snapshot must not turn the repo's uncommitted files into this call's writes.
    const command = 'git checkout -- README.md';
    for (const status of [{ top: d }, { top: d, files: 'wip.ts' }]) {
      note('toolu_i1half', status);
      expect(afterBash(s, 'toolu_i1half', d, command, undefined).context ?? '').not.toContain(wip);
    }
    // The same call with a whole snapshot that lacks wip.ts does record it.
    note('toolu_i1whole', { top: d, files: [] });
    expect(afterBash(s, 'toolu_i1whole', d, command, undefined).context ?? '').toContain(wip);
  });

  test('a call that cds out of its repo and moves files into it: the start repo is swept too', () => {
    const a = tmp();
    gitRepo(a);
    mkdirSync(join(a, 'lib'));
    mkdirSync(join(a, 'src'));
    writeFileSync(join(a, 'lib', '.keep'), '');
    sh(a, "git add -A && git commit -q -m 'ABC-1 init'");
    const o = tmp(); // no repo
    mkdirSync(join(o, 'pkg'));
    writeFileSync(join(o, 'pkg', 'x.ts'), 'export const x = 1;\n');
    writeFileSync(join(o, 'y.ts'), 'export const y = 1;\n');
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(o, 'pkg', 'x.ts'), old, old);
    Bun.sleepSync(1_500); // x.ts's ctime is before the call's start
    const s = sid();
    const command = `cd ${o} && mv pkg ${a}/lib/ && mv y.ts ${a}/src/y.ts`;
    noteBashStart(s, 'toolu_i1out', a, command, undefined, statusFiles(a) ?? undefined);
    sh(a, command);
    // The post hook reports the cwd the shell ended in: o, outside any repo.
    const after = afterBash(s, 'toolu_i1out', o, command, undefined);
    expect(after.context ?? '').toContain(join(a, 'lib', 'pkg', 'x.ts')); // from the snapshot
    expect(after.context ?? '').toContain(join(a, 'src', 'y.ts'));
  });

  test('afterBash records the file a mv placed, also with its old mtime', () => {
    const { d, bar } = movedOldFile();
    const s = sid();
    const after = afterBash(s, undefined, d, 'mv src/foo.ts src/bar.ts', undefined);
    expect(after.context ?? '').toContain('wrote project files outside Edit/Write');
    expect(after.context ?? '').toContain(bar);
    expect(readFileSync(join(ensureSessionDir(s), 'edits.jsonl'), 'utf8')).toContain(bar);
    // A command that places nothing is not swept, and records nothing.
    const s2 = sid();
    expect(afterBash(s2, undefined, d, 'git status', undefined)).toEqual({});
    expect(() => readFileSync(join(ensureSessionDir(s2), 'edits.jsonl'), 'utf8')).toThrow();
  });

  test('the PostToolUse hook records the target of a mv in the edit log', async () => {
    const { d, bar } = movedOldFile();
    const base = tmp(); // the hook's TMPDIR, and so its session dir
    const s = `i1m${Math.random().toString(36).slice(2, 10)}`;
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'post-tool-use.ts')], {
      cwd: d,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, cwd: d, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_i1mv', tool_input: { command: 'mv src/foo.ts src/bar.ts' }, tool_response: { stdout: '' } })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1' },
    });
    const out = JSON.parse((await new Response(p.stdout).text()) || '{}') as { hookSpecificOutput?: { additionalContext?: string } };
    await p.exited;
    expect(out.hookSpecificOutput?.additionalContext ?? '').toContain(bar);
    expect(readFileSync(join(base, `goodboy-session-${s}`, 'edits.jsonl'), 'utf8')).toContain(bar);
  }, 30_000);

  test('a directory moved into place is recorded through the real hooks: PreToolUse takes the status snapshot, PostToolUse reads it', async () => {
    const d = tmp();
    gitRepo(d);
    mkdirSync(join(d, 'src', 'pkg'), { recursive: true });
    mkdirSync(join(d, 'lib'));
    writeFileSync(join(d, 'src', 'pkg', 'x.ts'), 'export const x = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(d, 'src', 'pkg', 'x.ts'), old, old);
    Bun.sleepSync(1_300); // its ctime is before the call's start by more than the sweep's 1 s margin
    const base = tmp(); // the hooks' TMPDIR, and so their session dir
    const s = `i1d${Math.random().toString(36).slice(2, 10)}`;
    const command = 'mv src/pkg lib/';
    const run = async (hook: string, event: string, extra: Record<string, unknown>) => {
      const p = Bun.spawn(['bun', join(ROOT, 'hooks', hook)], {
        cwd: d,
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, cwd: d, hook_event_name: event, tool_name: 'Bash', tool_use_id: 'toolu_i1hookdir', tool_input: { command }, ...extra })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_POLICY_GATE: 'off' },
      });
      const out = JSON.parse((await new Response(p.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
      await p.exited;
      return out.hookSpecificOutput ?? {};
    };
    const pre = await run('pre-tool-use.ts', 'PreToolUse', {});
    expect(pre.permissionDecision, pre.permissionDecisionReason).not.toBe('deny');
    sh(d, command);
    const x = join(d, 'lib', 'pkg', 'x.ts');
    expect(changedFilesSince(d, Date.now() - 1_000)).not.toContain(x); // a moved directory keeps its files' times
    const post = await run('post-tool-use.ts', 'PostToolUse', { tool_response: { stdout: '' } });
    expect(post.additionalContext ?? '').toContain(x);
    expect(readFileSync(join(base, `goodboy-session-${s}`, 'edits.jsonl'), 'utf8')).toContain(x);
  }, 30_000);

  test('a target above a subdirectory cwd is recorded: the project boundary is the repo top, not the cwd', () => {
    const d = tmp();
    gitRepo(d);
    mkdirSync(join(d, 'src'));
    mkdirSync(join(d, 'lib'));
    writeFileSync(join(d, 'src', 'foo.ts'), 'export const f = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const cwd = join(d, 'src');
    const command = 'mv foo.ts ../lib/bar.ts';
    sh(cwd, command);
    const bar = join(d, 'lib', 'bar.ts');
    Bun.sleepSync(1_300); // the call "starts" after the move: neither its mtime nor its ctime reaches the sweep
    const s = sid();
    noteBashStart(s, 'toolu_i1up', cwd, command);
    expect(changedFilesSince(cwd, Date.now() - 1_000)).toEqual([]); // so only the command's own target can say
    expect(placedFiles(command, cwd, d)).toEqual([bar]);
    expect(placedFiles('mv foo.ts ../../outside.ts', cwd, d)).toEqual([]); // above the repo top: not the project
    const after = afterBash(s, 'toolu_i1up', cwd, command, undefined);
    expect(after.context ?? '').toContain(bar);
    expect(readFileSync(join(ensureSessionDir(s), 'edits.jsonl'), 'utf8')).toContain(bar);
  });

  test('a Go profile names files by module path; a go.mod in a subdirectory maps them', () => {
    const d = tmp();
    gitRepo(d);
    mkdirSync(join(d, 'backend', 'pkg'), { recursive: true });
    writeFileSync(join(d, 'backend', 'go.mod'), 'module example.com/svc\n\ngo 1.22\n');
    writeFileSync(join(d, 'backend', 'pkg', 'x.go'), 'package pkg\n\nfunc X() int { return 1 }\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    writeFileSync(join(d, 'backend', 'pkg', 'x.go'), 'package pkg\n\nfunc X() int { return 2 }\n');
    writeFileSync(join(d, 'cover.out'), 'mode: set\nexample.com/svc/pkg/x.go:3.1,3.30 1 1\n');
    expect(diffCoverageOf(d, 'cover.out')).toMatchObject({ files: { 'backend/pkg/x.go': { covered: 1, total: 1 } }, in_report: ['backend/pkg/x.go'] });
    // A module path that no go.mod declares names no file of ours.
    writeFileSync(join(d, 'cover.out'), 'mode: set\nexample.com/other/pkg/x.go:3.1,3.30 1 1\n');
    expect(diffCoverageOf(d, 'cover.out')).toMatchObject({ files: {}, in_report: [] });
  });

  test('a staged pure rename is in the diff with no added line, so the gate does not call it hidden', () => {
    const d = tmp();
    gitRepo(d);
    sh(d, 'git config diff.renames true'); // the default, set so a user config cannot change what is tested
    mkdirSync(join(d, 'src'));
    writeFileSync(join(d, 'src', 'foo.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    const base = sh(d, 'git rev-parse HEAD');
    sh(d, 'git mv src/foo.ts src/bar.ts');
    expect(changedLines(d)).toEqual({ top: d, files: new Map([['src/bar.ts', new Set<number>()]]) });
    writeFileSync(join(d, 'lcov.info'), 'SF:src/other.ts\nDA:1,1\nend_of_record\n');
    expect(diffCoverageOf(d, 'lcov.info')).toMatchObject({ diff_lines: { 'src/bar.ts': 0 } });
    const bar = [join(d, 'src', 'bar.ts')];
    const out = changedLineGaps({ results: [result(changed({}, [], base, { 'src/bar.ts': 0 }), bar)], edits: edits(bar), top: d, exempt: [], startHead: base });
    expect(out.gaps).toEqual([]);
    // Were the rename missing from the diff, the file would count as edited but hidden from it.
    const hidden = changedLineGaps({ results: [result(changed({}, [], base, {}), bar)], edits: edits(bar), top: d, exempt: [], startHead: base });
    expect(hidden.gaps).toEqual([{ file: 'src/bar.ts', hidden: true }]);
  });

  test("a staged near-copy counts all its lines, whatever the user's diff.renames says", () => {
    const d = tmp();
    gitRepo(d);
    sh(d, 'git config diff.renames copies');
    const body = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    writeFileSync(join(d, 'a.ts'), `${body}\n`);
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    writeFileSync(join(d, 'b.ts'), `${body}\nexport const extra = 1;\n`);
    writeFileSync(join(d, 'a.ts'), `${body}\n// x\n`); // copies are found from modified files
    sh(d, 'git add b.ts');
    const r = changedLines(d);
    expect(r !== null && 'files' in r ? r.files.get('b.ts')?.size : -1).toBe(41);
  });

  test('--base empty diffs against the empty tree, for a repo with no commit yet', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, 'git add a.ts');
    writeFileSync(join(d, 'lcov.info'), 'SF:a.ts\nDA:1,1\nend_of_record\n');
    const out = diffCoverageOf(d, 'lcov.info', 'empty');
    expect(out).toMatchObject({ files: { 'a.ts': { covered: 1, total: 1 } }, base: emptyTree(d)! });
    expect(diffCoverageOf(d, 'lcov.info')).toEqual({ error: 'git diff against HEAD failed (is it a commit?)' });
  });

  test('git replace does not change the diff the changed lines are taken from', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const base = sh(d, 'git rev-parse HEAD');
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    // A commit whose tree already holds the edited file stands in for the base through a replace ref.
    const blob = sh(d, 'git hash-object -w a.ts');
    const tree = sh(d, `printf '100644 blob ${blob}\\ta.ts\\n' | git mktree`);
    sh(d, `git replace ${base} $(git commit-tree ${tree} -m fake)`);
    expect(sh(d, `git diff --stat ${base}`)).toBe(''); // git itself is fooled
    expect(changedLines(d, base)).toEqual({ top: d, files: new Map([['a.ts', new Set([2])]]) });
  });
});

describe('the gaps', () => {
  test('the rule is on unless switched to warn or off', () => {
    expect(diffCoverageMode({})).toBe('on');
    expect(diffCoverageMode({ GOODBOY_DIFF_COVERAGE: 'WARN' })).toBe('warn');
    expect(diffCoverageMode({ GOODBOY_DIFF_COVERAGE: 'off' })).toBe('off');
    expect(diffCoverageMode({ GOODBOY_DIFF_COVERAGE: 'nonsense' })).toBe('on');
  });

  test('not measured: no coverage, a failed run, or a record without the whole diff-coverage output', () => {
    const { d: top, f } = proj(['src/a.ts']);
    const a = [f('src/a.ts')];
    expect(changedLineGaps({ results: [result(undefined, a)], edits: edits(a), top, exempt: [] })).toEqual({ measured: false, gaps: [] });
    expect(changedLineGaps({ results: [result(changed({ 'src/a.ts': [5, 5] }), a, 0, 'fail')], edits: edits(a), top, exempt: [] }).measured).toBe(false);
    for (const k of ['files', 'in_report', 'diff_lines', 'base'] as const) {
      const c = { ...changed({ 'src/a.ts': [5, 5] }), [k]: undefined };
      const out = changedLineGaps({ results: [result(c, a)], edits: edits(a), top, exempt: [] });
      expect(out).toEqual({ measured: false, gaps: [] });
      expect(changedLineReason(out, 'cli.ts')).toContain('`files`, `in_report`, `diff_lines` and `base`');
    }
  });

  test('nothing to measure: only non-code, exempt or deleted files changed', () => {
    const { d: top, f } = proj({ 'styles.css': 'a{}\n', 'ci.yml': 'on: push\n', 'hooks/stop.ts': 'export const s = 1;\n' });
    const all = [f('styles.css'), f('ci.yml'), f('hooks/stop.ts'), f('src/gone.ts')];
    expect(changedLineGaps({ results: [result(undefined, all)], edits: edits(all), top, exempt: ['hooks/**'] })).toEqual({ measured: true, gaps: [] });
  });

  test('lines that did not run, and files no test loaded; a file with no executable change, or no added line, is fine', () => {
    const { d: top, f } = proj(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/types.ts', '..evil.ts', 'src/old.ts']);
    const all = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/types.ts', '..evil.ts', 'src/old.ts'].map(f);
    const diff = { '..evil.ts': 1, 'src/a.ts': 4, 'src/b.ts': 1, 'src/c.ts': 5, 'src/types.ts': 1, 'src/old.ts': 0 };
    const r = result(changed({ 'src/a.ts': [3, 4], 'src/c.ts': [5, 5] }, ['src/a.ts', 'src/c.ts', 'src/types.ts'], BASE, diff), all);
    const out = changedLineGaps({ results: [r], edits: edits(all), top, exempt: [] });
    expect(out).toEqual({
      measured: true,
      gaps: [
        { file: '..evil.ts', absent: true }, // a name that starts with `..` is inside the repo
        { file: 'src/a.ts', covered: 3, total: 4 },
        { file: 'src/b.ts', absent: true },
      ],
    });
    expect(changedLineReason(out, 'cli.ts')).toContain('src/a.ts (3 of 4 lines ran); src/b.ts (not in the coverage report)');
    expect(changedLineReason(out, 'cli.ts')).toContain('a path outside this repo (tests run in a container or another checkout)');
  });

  test('a file the report lacks counts only when it is code with runtime statements', () => {
    const d = tmp();
    mkdirSync(join(d, 'src'));
    const files: Record<string, string> = {
      'package.json': '{"name":"x"}\n',
      'ci.yml': 'on: push\n',
      'src/types.ts': 'export interface A { x: number }\nexport type B = A | null;\n',
      'src/env.d.ts': "declare module 'x' { export const y: number }\n",
      'src/global.d.ts': 'declare global { interface W { x: 1 } }\nexport {};\n',
      'src/marker.ts': 'export interface M { m: 1 }\nexport {};\n',
      'src/code.ts': 'export const a = 1;\n',
      'src/tool.py': 'x = 1\n',
      // An import used only as a type is dropped at run time, so no test loads this file.
      'src/admin.ts': "import { User } from './user';\nexport interface Admin extends User { level: number }\n",
      'src/setup.ts': "import './polyfill';\nexport interface S {}\n", // a side-effect import runs
    };
    for (const [p, text] of Object.entries(files)) writeFileSync(join(d, p), text);
    const abs = Object.keys(files).map((p) => join(d, p));
    const out = changedLineGaps({ results: [result(changed({}, [], BASE, Object.fromEntries(Object.keys(files).map((p) => [p, 1]))), abs)], edits: edits(abs), top: d, exempt: [] });
    expect(out.gaps).toEqual([
      { file: 'src/code.ts', absent: true },
      { file: 'src/setup.ts', absent: true },
      { file: 'src/tool.py', absent: true },
    ]);
  });

  test('a file named like an Object property is looked up as a file, not as a property of the record', () => {
    // The record is parsed JSON: `files.constructor` is Object's, not a measurement.
    const { d: top, f } = proj({ constructor: 'plain text\n', toString: 'plain text\n', 'src/a.ts': 'export const a = 1;\n' });
    const names = [f('constructor'), f('toString')];
    const rec = result(changed({ 'src/a.ts': [1, 1] }), [f('src/a.ts')]);
    // Neither is code nor in any report: nothing to measure.
    expect(changedLineGaps({ results: [rec], edits: edits(names), top, exempt: [] })).toEqual({ measured: true, gaps: [] });
    // One a report did measure (an own entry in an older record) is judged by the fresh record's
    //   own entries: it has none for `constructor`, and the diff has added lines there.
    const edited = [f('constructor')];
    const older = result(changed({ constructor: [1, 1] as [number, number] }), edited, 60_000);
    const fresh = result(changed({}, [], BASE, { constructor: 2 }), edited);
    expect(changedLineGaps({ results: [older, fresh], edits: edits(edited, 30_000), top, exempt: [] }).gaps).toEqual([{ file: 'constructor', absent: true }]);
  });

  test('an edited file the diff does not have counts unless it equals the base', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'kept.ts'), 'export const k = 1;\n');
    writeFileSync(join(d, 'hidden.ts'), 'export const h = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const base = sh(d, 'git rev-parse HEAD');
    writeFileSync(join(d, 'hidden.ts'), 'export const h = 2;\nexport function never() { return 3; }\n');
    sh(d, 'git update-index --assume-unchanged hidden.ts'); // git diff no longer shows it
    writeFileSync(join(d, 'gen.ts'), 'export const g = 1;\n'); // never committed, not in the diff
    const all = ['kept.ts', 'hidden.ts', 'gen.ts'].map((p) => join(d, p));
    const out = changedLineGaps({ results: [result(changed({}, [], base, {}), all)], edits: edits(all), top: d, exempt: [], startHead: base });
    expect(out.gaps).toEqual([
      { file: 'gen.ts', hidden: true },
      { file: 'hidden.ts', hidden: true },
    ]); // kept.ts was edited back to its base content
    expect(changedLineReason(out, 'cli.ts')).toContain('gen.ts (edited, but not in the coverage diff)');
    expect(changedLineReason(out, 'cli.ts')).toContain('has to be in it to be measured');
  });

  test('an undone edit equals the base also where git converts line endings', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, '.gitattributes'), '*.ts text eol=crlf\n');
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const base = sh(d, 'git rev-parse HEAD');
    expect(readFileSync(join(d, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\r\n'); // as a checkout writes it
    expect(sh(d, 'git diff --stat')).toBe('');
    const a = [join(d, 'a.ts')];
    expect(changedLineGaps({ results: [result(changed({}, [], base, {}), a)], edits: edits(a), top: d, exempt: [], startHead: base }).gaps).toEqual([]);
  });

  test('grafts do not make a later commit an ancestor of the start', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const start = sh(d, 'git rev-parse HEAD');
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\n');
    sh(d, "git commit -qam 'ABC-1 two'");
    const later = sh(d, 'git rev-parse HEAD');
    writeFileSync(join(d, '.git', 'info', 'grafts'), `${start} ${later}\n`);
    const a = [join(d, 'a.ts')];
    const out = changedLineGaps({ results: [result(changed({ 'a.ts': [1, 1] }, ['a.ts'], later), a)], edits: edits(a), top: d, exempt: [], startHead: start });
    // (R2) a.ts is not what it was at the start, in the later commit: the base is refused for it,
    //   whatever a graft says about the commits' history (ancestry decides nothing here).
    expect(out).toEqual({ measured: true, gaps: [{ file: 'a.ts', refusedBase: later, head: start }] });
  });

  test('a declaration file is no code, also when a transpiler would reject its text', () => {
    const d = tmp();
    mkdirSync(join(d, 'src'));
    // In a .d.ts every declaration is ambient: `export const y: number;` is valid there, and
    // Bun's transpiler refuses it ("must be initialized"), which would count it as code.
    const text = 'export const y: number;\n';
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(text)).toThrow();
    const files = ['src/ambient.d.ts', 'src/ambient.d.mts', 'src/ambient.d.cts', 'src/ambient.ts'];
    for (const p of files) writeFileSync(join(d, p), text);
    const abs = files.map((p) => join(d, p));
    const out = changedLineGaps({ results: [result(changed({}, [], BASE, Object.fromEntries(files.map((p) => [p, 1]))), abs)], edits: edits(abs), top: d, exempt: [] });
    expect(out.gaps).toEqual([{ file: 'src/ambient.ts', absent: true }]); // a plain .ts that does not parse stays code
    // `export * from` and `export =` are declarations in a .d.ts, though they transpile to code:
    //   a .d.ts is never measured (code hidden in one is a known limit, plan §15.2a).
    writeFileSync(join(d, 'src', 'ambient.d.ts'), "export * from './real';\nexport default K;\n");
    expect(changedLineGaps({ results: [result(changed({}, [], BASE, { 'src/ambient.d.ts': 2 }), abs)], edits: edits([abs[0]!]), top: d, exempt: [] }).gaps).toEqual([]);
  });

  test('only records made after the file was last edited count for it', () => {
    const { d: top, f } = proj(['src/a.ts']);
    const a = [f('src/a.ts')];
    const old = result(changed({ 'src/a.ts': [3, 3] }), a, 60_000); // before the edit
    const args = { edits: edits(a, 30_000), top, exempt: [] };
    expect(changedLineGaps({ ...args, results: [old, result(changed({ 'src/a.ts': [3, 5] }), a)] }).gaps).toEqual([{ file: 'src/a.ts', covered: 3, total: 5 }]);
    const noCov = changedLineGaps({ ...args, results: [old, result(undefined, a)] });
    expect(noCov).toEqual({ measured: true, gaps: [{ file: 'src/a.ts', unmeasured: true }] });
    expect(changedLineReason(noCov, 'cli.ts')).toContain('no passing record of its current content measured it');
    // A newer record that does not test the file does not count for it either.
    expect(changedLineGaps({ ...args, results: [old, result(changed({ 'src/a.ts': [3, 3] }), [f('src/other.ts')])] }).gaps).toEqual([{ file: 'src/a.ts', unmeasured: true }]);
  });

  test('several fresh records: the best run of each file counts; exempt globs are left out', () => {
    const { d: top, f } = proj(['src/a.ts', 'src/b.ts', 'hooks/stop.ts']);
    const a = [f('src/a.ts')];
    const r1 = result(changed({ 'src/a.ts': [1, 4] }), a);
    const r2 = result(changed({ 'src/a.ts': [4, 4] }), a);
    expect(changedLineGaps({ results: [r1, r2], edits: edits(a), top, exempt: [] }).gaps).toEqual([]);
    const three = [f('src/a.ts'), f('src/b.ts'), f('hooks/stop.ts')];
    const out = changedLineGaps({ results: [result(changed({ 'src/a.ts': [1, 4] }, ['src/a.ts'], BASE, { 'hooks/stop.ts': 1, 'src/a.ts': 4, 'src/b.ts': 1 }), three)], edits: edits(three), top, exempt: ['hooks/**', 'src/{a,b}.ts'] });
    expect(out).toEqual({ measured: true, gaps: [] });
  });

  test('a cwd reached through a symlink keeps its spelling, so its files are checked', () => {
    const real = tmp();
    gitRepo(real);
    const link = join(tmp(), 'link');
    symlinkSync(real, link);
    expect(repoTop(link)).toBe(link);
    expect(repoTop(join(real, '..'))).toBe(resolve(real, '..')); // outside a repo: the cwd
    mkdirSync(join(real, 'src'));
    writeFileSync(join(real, 'src', 'a.ts'), 'export const a = 1;\n');
    const a = [join(link, 'src', 'a.ts')];
    const out = changedLineGaps({ results: [result(changed({}, [], BASE, { 'src/a.ts': 1 }), a)], edits: edits(a), top: repoTop(link), exempt: [] });
    expect(out.gaps).toEqual([{ file: 'src/a.ts', absent: true }]);
  });

  test('a record measured against a commit after the session started does not count', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const start = sh(d, 'git rev-parse HEAD');
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\n');
    sh(d, "git commit -qam 'ABC-1 two'");
    const later = sh(d, 'git rev-parse HEAD');
    const a = [join(d, 'a.ts')];
    const rec = (base: string) => [result(changed({ 'a.ts': [1, 1] }, ['a.ts'], base), a)];
    const args = { edits: edits(a), top: d, exempt: [], startHead: start };
    const late = changedLineGaps({ ...args, results: rec(later) });
    // (R2) The later base is refused for a.ts: the file is not what it was at the start there.
    expect(late).toEqual({ measured: true, gaps: [{ file: 'a.ts', refusedBase: later, head: start }] });
    expect(changedLineReason(late, 'cli.ts')).toContain(`--base ${start}`);
    expect(changedLineReason(late, 'cli.ts')).toContain(`measured only against ${later.slice(0, 12)}`);
    expect(changedLineGaps({ ...args, results: rec(start) })).toEqual({ measured: true, gaps: [] });
    // Another start (the later commit): the old base is an ancestor of it, but a.ts differs there: refused too.
    expect(changedLineGaps({ ...args, startHead: later, results: rec(start) }).gaps).toEqual([{ file: 'a.ts', refusedBase: start, head: later }]);
    expect(changedLineGaps({ ...args, results: rec('f'.repeat(40)) }).gaps).toEqual([{ file: 'a.ts', refusedBase: 'f'.repeat(40), head: start }]); // unknown to git
    // No commit when the session started: a base where the file exists is refused; only one without it counts.
    const none = changedLineGaps({ ...args, startHead: null, results: rec(start) });
    expect(none.gaps).toEqual([{ file: 'a.ts', refusedBase: start, head: null }]);
    expect(changedLineReason(none, 'cli.ts')).toContain('--base empty');
    expect(changedLineGaps({ ...args, startHead: null, results: rec(emptyTree(d)!) }).gaps).toEqual([]);
  });
});

describe('replace refs', () => {
  test('git replace does not change what the gate sees of the base file', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'hidden.ts'), 'export const h = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const base = sh(d, 'git rev-parse HEAD');
    writeFileSync(join(d, 'hidden.ts'), 'export const h = 2;\nexport function never() { return 3; }\n');
    sh(d, 'git update-index --assume-unchanged hidden.ts'); // git diff no longer shows it
    // A commit whose tree holds the edited file stands in for the base through a replace ref.
    const blob = sh(d, 'git hash-object -w hidden.ts');
    const tree = sh(d, `printf '100644 blob ${blob}\\thidden.ts\\n' | git mktree`);
    sh(d, `git replace ${base} $(git commit-tree ${tree} -m fake)`);
    expect(sh(d, `git rev-parse ${base}:hidden.ts`)).toBe(blob); // git itself is fooled
    const all = [join(d, 'hidden.ts')];
    const out = changedLineGaps({ results: [result(changed({}, [], base, {}), all)], edits: edits(all), top: d, exempt: [], startHead: base });
    expect(out.gaps).toEqual([{ file: 'hidden.ts', hidden: true }]);
  });

  test('git replace does not change the history the base is checked against', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const start = sh(d, 'git rev-parse HEAD');
    // The start commit gets a parent it never had, which makes an unrelated commit look like
    // one the session started from.
    const other = sh(d, `git commit-tree ${emptyTree(d)} -m other`);
    sh(d, `git replace ${start} $(git commit-tree $(git rev-parse ${start}^{tree}) -p ${other} -m fake)`);
    expect(sh(d, `git merge-base --is-ancestor ${other} ${start} && echo yes`)).toBe('yes'); // git itself is fooled
    const a = [join(d, 'a.ts')];
    const late = changedLineGaps({ results: [result(changed({ 'a.ts': [1, 1] }, ['a.ts'], other), a)], edits: edits(a), top: d, exempt: [], startHead: start });
    // (R2) `other` is an empty tree, where a.ts does not exist: not what the start has, so refused.
    expect(late).toEqual({ measured: true, gaps: [{ file: 'a.ts', refusedBase: other, head: start }] });
  });
});

describe('exemptions', () => {
  test('only human policy entries exempt, and only a policy file inside the repo', () => {
    const d = tmp();
    mkdirSync(join(d, '.git'));
    mkdirSync(join(d, '.goodboy'));
    writeFileSync(
      join(d, '.goodboy', 'policy.md'),
      [policy('hooks/**, bin/*.sh'), '## P2 Not the user', '- decide: ai', '- evidence: bun test', '- coverage-exempt: src/**', ''].join('\n'),
    );
    expect(coverageExemptions(d)).toEqual(['hooks/**', 'bin/*.sh']);
    expect(coverageExemptions(tmp())).toEqual([]);
    // A parent directory's policy file is not the project's.
    const parent = tmp();
    mkdirSync(join(parent, '.goodboy'));
    writeFileSync(join(parent, '.goodboy', 'policy.md'), policy('**'));
    const repo = join(parent, 'repo');
    mkdirSync(repo);
    gitRepo(repo);
    expect(coverageExemptions(repo)).toEqual([]);
  });

  test('globs split on the commas outside braces; a policy path in any letter case', () => {
    expect(exemptionsInText(policy('src/**/*.{ts,tsx}, gen/**'))).toEqual(['src/**/*.{ts,tsx}', 'gen/**']);
    expect(isPolicyFile('/r/.GOODBOY/POLICY.MD')).toBe(true);
    expect(isPolicyFile('/r/.goodboy/hosts')).toBe(false);
  });

  test('addedUserGlobs: new human coverage exemptions only', () => {
    const added = (before: string, after: string) => addedUserGlobs(before, after).map((a) => `${a.key}: ${a.glob}`);
    expect(added(policy('a/**'), policy('a/**, b/**'))).toEqual(['coverage-exempt: b/**']);
    expect(added('', policy('**'))).toEqual(['coverage-exempt: **']);
    expect(added(policy('a/**'), policy('a/**') + '\nmore text\n')).toEqual([]);
    expect(added(policy('a/**').replace('human', 'ai'), policy('a/**'))).toEqual(['coverage-exempt: a/**']); // ai → human
  });

  test('textAfterEdit inserts new_string as it is', () => {
    expect(textAfterEdit('Edit', { old_string: 'a', new_string: "$&$'$$" }, 'xay')).toBe("x$&$'$$y");
    expect(textAfterEdit('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'aXa')).toBe('bXb');
    expect(textAfterEdit('Write', { content: 'new' }, 'old')).toBe('new');
  });

  test('the gate uses the globs pinned at the session start, and the start HEAD', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const head = sh(d, 'git rev-parse HEAD');
    mkdirSync(join(d, '.goodboy'));
    writeFileSync(join(d, '.goodboy', 'policy.md'), policy('hooks/**'));
    const s = sid();
    pinCoverageStart(s, d);
    writeFileSync(join(d, '.goodboy', 'policy.md'), policy('hooks/**, src/**')); // added during the session
    expect(sessionCoverageStart(s, d, d)).toEqual({ exempt: ['hooks/**'], head });
    // A resume keeps the start HEAD and the grants of the first start: it may take a grant away (the
    // intersection with the policy file now), never add one (#33 rule 6, v0.36.7: the old test here
    // expected the resume to refresh the pin and so to take `src/**` in).
    writeFileSync(join(d, 'a.ts'), 'export const a = 2;\n');
    sh(d, "git commit -qam 'ABC-1 two'");
    pinCoverageStart(s, d);
    expect(sessionCoverageStart(s, d, d)).toEqual({ exempt: ['hooks/**'], head });
    writeFileSync(join(d, '.goodboy', 'policy.md'), policy('src/**')); // the user removed one and added another
    expect(sessionCoverageStart(s, d, d).exempt).toEqual([]);
    pinCoverageStart(s, d); // and a resume after that does not bring the added one in
    expect(sessionCoverageStart(s, d, d).exempt).toEqual([]);
    // A pin of the wrong shape is no pin.
    writeFileSync(join(ensureSessionDir(s), 'coverage-pin.json'), JSON.stringify({ top: d, head: 5, exemptions: ['**'] }));
    expect(sessionCoverageStart(s, d, d).head).toBeUndefined();
    // No pin: the policy file counts only when it is older than the session dir.
    const s2 = sid();
    recordEdit(s2, join(d, 'a.ts'), 0, undefined, Date.now());
    expect(sessionCoverageStart(s2, d, d)).toEqual({ exempt: ['src/**'] });
    Bun.sleepSync(20);
    writeFileSync(join(d, '.goodboy', 'policy.md'), policy('src/**, lib/**'));
    expect(sessionCoverageStart(s2, d, d)).toEqual({ exempt: [] });
    // A repo with no commit yet pins null.
    const fresh = tmp();
    gitRepo(fresh);
    const s3 = sid();
    pinCoverageStart(s3, fresh);
    expect(sessionCoverageStart(s3, fresh, fresh)).toEqual({ exempt: [], head: null });
    // So does a directory that is no repo: a repo made in it later starts from the empty tree.
    const plain = tmp();
    const s4 = sid();
    pinCoverageStart(s4, plain);
    gitRepo(plain);
    writeFileSync(join(plain, 'a.ts'), 'export const a = 1;\n');
    sh(plain, "git add -A && git commit -q -m 'ABC-1 one'");
    expect(sessionCoverageStart(s4, plain, repoTop(plain))).toEqual({ exempt: [], head: null });
    // A repo made in a subdirectory has another top: no exemptions, the empty tree only.
    const sub = join(plain, 'pkg');
    mkdirSync(sub);
    gitRepo(sub);
    expect(sessionCoverageStart(s4, sub, repoTop(sub))).toEqual({ exempt: [], head: null });
  });

  test('a pin for another top exempts nothing and carries no start HEAD, however much it holds', () => {
    const d = tmp();
    gitRepo(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 one'");
    const head = sh(d, 'git rev-parse HEAD');
    mkdirSync(join(d, '.goodboy'));
    writeFileSync(join(d, '.goodboy', 'policy.md'), policy('hooks/**'));
    const s = sid();
    pinCoverageStart(s, d); // top d, a start HEAD, the glob hooks/**
    expect(sessionCoverageStart(s, d, d)).toEqual({ exempt: ['hooks/**'], head });
    // A repo made inside it during the session has another top. Its own policy file has the same
    // glob, but the pin was taken for d: the glob list and the HEAD do not carry over.
    const sub = join(d, 'pkg');
    mkdirSync(join(sub, '.goodboy'), { recursive: true });
    gitRepo(sub);
    writeFileSync(join(sub, '.goodboy', 'policy.md'), policy('hooks/**'));
    expect(coverageExemptions(sub, repoTop(sub))).toEqual(['hooks/**']); // it would exempt, were the pin taken for it
    expect(sessionCoverageStart(s, sub, repoTop(sub))).toEqual({ exempt: [], head: null });
    // A linked worktree of the same repo has the start commit: the HEAD carries over.
    const wt = join(tmp(), 'wt');
    sh(d, `git worktree add -q ${wt}`);
    expect(sessionCoverageStart(s, wt, repoTop(wt))).toEqual({ exempt: [], head });
  });

  test('the state guard puts back a pin a Bash call rewrote', () => {
    const d = tmp();
    gitRepo(d);
    const s = sid();
    pinCoverageStart(s, d);
    const pin = join(ensureSessionDir(s), 'coverage-pin.json');
    const before = readFileSync(pin, 'utf8');
    snapshotGateState(s, 'toolu_i1pin');
    writeFileSync(pin, JSON.stringify({ top: d, exemptions: ['**'] }));
    restoreGateState(s, 'toolu_i1pin');
    expect(readFileSync(pin, 'utf8')).toBe(before);
  });

  /** A PreToolUse run in `cwd` (a repo under `base`, which is also its TMPDIR). */
  function preToolUse(base: string, cwd: string) {
    const s = `i1g${Math.random().toString(36).slice(2, 10)}`;
    return async (tool: string, toolInput: Record<string, unknown>) => {
      const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'pre-tool-use.ts')], {
        cwd,
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, cwd, tool_name: tool, tool_input: toolInput })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_DIFF_COVERAGE: 'on', GOODBOY_POLICY_GATE: 'off' },
      });
      const out = JSON.parse((await new Response(p.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      await p.exited;
      return out.hookSpecificOutput ?? {};
    };
  }

  test('an Edit or MultiEdit with replace_all that turns every ai entry human adds every glob', async () => {
    const base = tmp();
    const cwd = join(base, 'repo');
    mkdirSync(join(cwd, '.goodboy'), { recursive: true });
    const file = join(cwd, '.goodboy', 'policy.md');
    const entry = (n: number, glob: string) => [`## P${n} Entry ${n}`, '- decide: ai', '- evidence: bun test', `- coverage-exempt: ${glob}`, ''].join('\n');
    writeFileSync(file, [entry(1, 'a/**'), entry(2, 'b/**')].join('\n')); // ai entries exempt nothing
    const run = preToolUse(base, cwd);
    const one = await run('Edit', { file_path: file, old_string: 'decide: ai', new_string: 'decide: human' });
    expect(one.permissionDecision).toBe('deny');
    expect(one.permissionDecisionReason).toContain('a/**');
    expect(one.permissionDecisionReason).not.toContain('b/**'); // without replace_all only the first changes
    const all = await run('Edit', { file_path: file, old_string: 'decide: ai', new_string: 'decide: human', replace_all: true });
    expect(all.permissionDecision).toBe('deny');
    expect(all.permissionDecisionReason).toContain('a/**, b/**');
    const multi = await run('MultiEdit', { file_path: file, edits: [{ old_string: 'decide: ai', new_string: 'decide: human', replace_all: true }] });
    expect(multi.permissionDecision).toBe('deny');
    expect(multi.permissionDecisionReason).toContain('a/**, b/**');
  }, 30_000);

  test('PreToolUse denies an Edit or Write that adds a glob; other policy edits pass', async () => {
    const base = tmp();
    const cwd = join(base, 'repo');
    mkdirSync(join(cwd, '.goodboy'), { recursive: true });
    const file = join(cwd, '.goodboy', 'policy.md');
    writeFileSync(file, policy('hooks/**'));
    const run = preToolUse(base, cwd);
    const edit = await run('Edit', { file_path: file, old_string: 'hooks/**', new_string: 'hooks/**, src/**' });
    expect(edit.permissionDecision).toBe('deny');
    expect(edit.permissionDecisionReason).toContain('src/**');
    const write = await run('Write', { file_path: join(cwd, 'pkg', '.goodboy', 'policy.md'), content: policy('**') });
    expect(write.permissionDecision).toBe('deny');
    const other = await run('Edit', { file_path: file, old_string: '- source: user 2026-10-16', new_string: '- source: user 2026-10-16, checked' });
    expect(other.permissionDecisionReason ?? '').not.toContain('exempts files');
  }, 30_000);
});

describe('through test-write and the Stop hook', () => {
  function project(): string {
    const d = tmp();
    gitRepo(d);
    mkdirSync(join(d, 'src'));
    mkdirSync(join(d, 'tests'));
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(d, 'tests', 'a.test.ts'), 'import { a } from "../src/a";\ntest("a", () => { expect(a).toBe(1); });\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    return d;
  }
  function record(d: string, coverage?: unknown, extra: Record<string, unknown> = {}) {
    return {
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      // As test-write stores it (v0.36.6, R4): the HEAD it ran on. A hand-written record with no tree
      //   is judged by time only while its checkout is HEAD or before it.
      commit: sh(d, 'git rev-parse HEAD'),
      tested_files: [join(d, 'src', 'a.ts')],
      category: 'fix-bug',
      test_files: [join(d, 'tests', 'a.test.ts')],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [
        {
          id: 'AC-1',
          description: 'b is exported',
          test: 'tests/a.test.ts',
          red: { command: 'bun test (before)', output: '1 fail', exit_code: 1 },
          green: { command: 'bun test', output: '1 pass', exit_code: 0 },
        },
      ],
      verdict: 'pass',
      ...(coverage ? { coverage } : {}),
      ...extra,
    };
  }
  const cov = (covered: number, total: number) => ({
    status: 'measured',
    changed: {
      covered,
      total,
      files_without_executed_changes: [],
      files: { 'src/a.ts': { covered, total } },
      in_report: ['src/a.ts'],
      diff_lines: { 'src/a.ts': 1 },
      base: BASE,
    },
  });
  function putRecord(d: string, ...recs: unknown[]) {
    const dir = join(d, '.claude', 'tests');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    recs.forEach((rec, i) => writeFileSync(join(dir, `r${i}.json`), JSON.stringify(rec)));
  }
  async function stop(d: string, s: string, env: Record<string, string> = {}, active = false) {
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'stop.ts')], {
      cwd: d,
      stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: s, hook_event_name: 'Stop', stop_hook_active: active })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GOODBOY_TEST_GATE: 'on', GOODBOY_DIFF_COVERAGE: 'on', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DOCS_GATE: 'off', ...env },
    });
    const out = (await new Response(p.stdout).text()) || '{}';
    await p.exited;
    return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
  }
  const testLog = (s: string) => {
    try {
      return readFileSync(join(tmpdir(), `goodboy-session-${s}`, 'gate-log.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('"gate":"test"'));
    } catch {
      return [];
    }
  };

  test('test-write keeps files, in_report, diff_lines and base, and rejects malformed ones', () => {
    const d = project();
    const w = (input: unknown) => Bun.spawnSync(['bun', CLI, 'test-write'], { cwd: d, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
    expect(w(record(d, cov(1, 1))).exitCode).toBe(0);
    const kept = readdirSync(join(d, '.claude', 'tests')).filter((n) => n.endsWith('.json'));
    expect(kept.length).toBe(1);
    expect(JSON.parse(readFileSync(join(d, '.claude', 'tests', kept[0]!), 'utf8')).coverage.changed).toEqual(cov(1, 1).changed);
    const bad = (c: Record<string, unknown>) => w(record(d, { status: 'measured', changed: { ...cov(1, 1).changed, ...c } }));
    expect(bad({ files: { 'src/a.ts': { covered: 2, total: 1 } } }).exitCode).not.toBe(0);
    expect(bad({ in_report: [1] }).stderr.toString()).toContain('in_report');
    expect(bad({ diff_lines: { 'src/a.ts': -1 } }).stderr.toString()).toContain('diff_lines');
    expect(bad({ diff_lines: ['src/a.ts'] }).stderr.toString()).toContain('diff_lines');
    expect(bad({ base: 'HEAD' }).stderr.toString()).toContain('base');
  });

  test('the gate blocks on a changed line no test ran, passes when all ran, and asks for coverage when it is missing', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    putRecord(d, record(d, cov(1, 2)));
    const blocked = await stop(d, s);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toMatch(/changed-line coverage/);
    expect(blocked.reason).toContain('src/a.ts (1 of 2 lines ran)');
    putRecord(d, record(d)); // no coverage at all
    expect((await stop(d, s)).reason).toMatch(/measure-coverage/);
    putRecord(d, record(d, cov(2, 2)));
    expect((await stop(d, s)).reason ?? '').not.toMatch(/changed-line coverage|measure-coverage/);
  }, 60_000);

  test('an evidence-backed blocked result still ends the turn as unverified', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    // Strictly newer than the passing record: the gate takes the newest fresh record per file,
    // and two timestamps taken in the same millisecond tie (a flake when a tick fell between).
    const blockedRun = record(d, { status: 'unavailable', reason: 'no coverage tool in the project' }, {
      timestamp: new Date(Date.now() + 120_000).toISOString(),
      verdict: 'blocked',
      blocked: {
        reason: 'the project has no coverage tool; adding one is the user decision',
        evidence: [{ command: 'bun test --coverage', output: 'error: coverage is not available in this runner' }],
      },
    });
    putRecord(d, record(d), blockedRun);
    const out = await stop(d, s);
    expect(out.reason ?? '').not.toMatch(/changed-line coverage|measure-coverage/);
    expect(out.systemMessage ?? '').toContain('검증되지 않은 상태');
  }, 60_000);

  test('a record the other checks never looked at supplies no coverage', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    // Older than the passing record, so the other checks leave it out: it lists a test file that
    // does not exist (the gate would reject it were it the newest). Its coverage is complete.
    const stale = record(d, cov(2, 2), { timestamp: new Date(Date.now() + 30_000).toISOString(), test_files: [join(d, 'tests', 'gone.test.ts')] });
    putRecord(d, stale, record(d, cov(1, 2)));
    const partial = await stop(d, s);
    expect(partial.decision).toBe('block');
    expect(partial.reason).toContain('src/a.ts (1 of 2 lines ran)');
    putRecord(d, stale, record(d)); // the newest has no coverage at all
    const none = await stop(d, s);
    expect(none.decision).toBe('block');
    expect(none.reason).toMatch(/measure-coverage/);
  }, 60_000);

  test('the stop_hook_active accept applies the same rule', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    putRecord(d, record(d, cov(1, 2)));
    await stop(d, s, {}, true);
    expect(testLog(s).some((l) => l.includes('accept-on-stop-active'))).toBe(false);
    putRecord(d, record(d, cov(2, 2)));
    await stop(d, s, {}, true);
    expect(testLog(s).some((l) => l.includes('accept-on-stop-active'))).toBe(true);
  }, 60_000);

  test('warn mode only warns, in the user message; off checks nothing', async () => {
    const d = project();
    const s = sid();
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    putRecord(d, record(d));
    const warn = await stop(d, s, { GOODBOY_DIFF_COVERAGE: 'warn' });
    expect(warn.reason ?? '').not.toMatch(/measure-coverage/);
    expect(warn.systemMessage ?? '').toContain('바뀐 줄 커버리지(경고 모드)');
    recordEdit(s, join(d, 'src', 'a.ts'), 0, undefined, Date.now());
    const off = await stop(d, s, { GOODBOY_DIFF_COVERAGE: 'off' });
    expect(off.reason ?? '').not.toMatch(/measure-coverage|changed-line coverage/);
    expect(off.systemMessage ?? '').not.toContain('바뀐 줄 커버리지');
  }, 60_000);
});
