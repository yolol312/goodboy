// Field report #44, plan §15.36 items 1, 3, 4 and 5: the changed lines the hook-child suites cannot show to the coverage
// tool. The post hook, the Stop and the CLI run these as processes in the other suites; here the same library functions
// run in this process, on real temporary files and real git repos, so the coverage report sees them.
//
// Everything runs against a private TMPDIR (session dirs, project state dirs, start notes): nothing under the real
// ~/.claude/goodboy, no docker, no network (the git "remote" is a bare repo on disk).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { noteBashStart, peekBashStart } from '../lib/approval-marker';
import { beginGitSnapshot, endGitSnapshot } from '../lib/git-run';
import { shellValidationPass } from '../lib/shell-validation-pass';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';
import { writeCatalog } from '../lib/test-catalog';
import { TREE_RECORD_WINDOW_MIN } from '../lib/test-validator';
import { treeRecordWindow } from '../lib/unpushed-work';
import { failureMarkerRoot, readValidationFailure, validationPassFile, writeValidationFailure } from '../lib/validation-state';
import { resnapshotAgentCalls } from '../lib/write-sweep';

const SID = 'sess-44-cov';
const TYPECHECK = 'bun run typecheck';

let prevTmp: string | undefined;
let box = '';
let proj = '';

beforeEach(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-v44cov-')));
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = box;
  proj = join(box, 'proj');
  mkdirSync(join(proj, 'sub'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"fixture"}');
});
afterEach(() => {
  endGitSnapshot();
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  // A read-only dir a test made must be writable again before it can go.
  try {
    chmodSync(join(box, 'repo', '.goodboy'), 0o755);
  } catch {
    // none made
  }
  rmSync(box, { recursive: true, force: true });
});

const sessionDir = (): string => join(box, `goodboy-session-${SID}`);
const sh = (cwd: string, cmd: string): string => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();

/** Every file named `name` below `dir` (the snapshot dirs of the state guard live under the session dir). */
function findFiles(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, name));
    else if (e.name === name) out.push(p);
  }
  return out;
}

// --- lib/approval-marker.ts peekBashStart and lib/shell-validation-pass.ts shellValidationPass ---

describe('peekBashStart (the post hook reads the start note without taking it)', () => {
  test('returns the start time, cwd and command of a note, and leaves the note', () => {
    noteBashStart(SID, 'tu-peek', proj, TYPECHECK, undefined, undefined, 1_700_000_000_000);
    expect(peekBashStart(SID, 'tu-peek')).toEqual({ t: 1_700_000_000_000, cwd: proj, command: TYPECHECK });
    expect(peekBashStart(SID, 'tu-peek')).not.toBeNull(); // not taken
  });

  test('a note without a command has no command key', () => {
    noteBashStart(SID, 'tu-nocmd', proj, undefined, undefined, undefined, 1_700_000_000_000);
    expect(peekBashStart(SID, 'tu-nocmd')).toEqual({ t: 1_700_000_000_000, cwd: proj });
  });

  test('no id, no note, a torn note and a note without a usable time or cwd give null', () => {
    expect(peekBashStart(SID, undefined)).toBeNull();
    expect(peekBashStart(SID, '')).toBeNull();
    expect(peekBashStart(SID, 'tu-never-noted')).toBeNull();
    noteBashStart(SID, 'tu-torn', proj, TYPECHECK);
    const note = readdirSync(sessionDir()).find((n) => n.includes('tu-torn'))!;
    writeFileSync(join(sessionDir(), note), '{"t": ');
    expect(peekBashStart(SID, 'tu-torn')).toBeNull();
    writeFileSync(join(sessionDir(), note), JSON.stringify({ t: 'soon', cwd: proj }));
    expect(peekBashStart(SID, 'tu-torn')).toBeNull();
    writeFileSync(join(sessionDir(), note), JSON.stringify({ t: Date.now() }));
    expect(peekBashStart(SID, 'tu-torn')).toBeNull();
    writeFileSync(join(sessionDir(), note), 'null');
    expect(peekBashStart(SID, 'tu-torn')).toBeNull();
  });
});

describe('shellValidationPass (the pass a finished Bash call proves)', () => {
  const started = 1_700_000_000_000;

  function failed(commands: string[] = [TYPECHECK]): void {
    writeValidationFailure(SID, commands, proj);
  }

  test('the exact failed command run from the project root is a pass, dated by its start', () => {
    failed();
    noteBashStart(SID, 'tu-ok', proj, TYPECHECK, undefined, undefined, started);
    expect(shellValidationPass(SID, 'tu-ok', { command: TYPECHECK }, { stdout: '' })).toEqual({
      root: proj,
      command: TYPECHECK,
      startedAt: new Date(started).toISOString(),
    });
  });

  test('a start in the future is dated now, never later', () => {
    failed();
    noteBashStart(SID, 'tu-future', proj, TYPECHECK, undefined, undefined, Date.now() + 10 * 60_000);
    const pass = shellValidationPass(SID, 'tu-future', { command: TYPECHECK }, {});
    expect(pass).not.toBeNull();
    expect(Date.parse(pass!.startedAt)).toBeLessThanOrEqual(Date.now());
  });

  test('a call that was not clean, or not this command, is no pass', () => {
    failed();
    noteBashStart(SID, 'tu-x', proj, TYPECHECK);
    expect(shellValidationPass(SID, 'tu-x', { command: TYPECHECK, run_in_background: true }, {})).toBeNull();
    expect(shellValidationPass(SID, 'tu-x', { command: 42 }, {})).toBeNull();
    expect(shellValidationPass(SID, 'tu-x', {}, {})).toBeNull();
    expect(shellValidationPass(SID, 'tu-x', { command: TYPECHECK }, { is_error: true })).toBeNull();
    expect(shellValidationPass(SID, 'tu-x', { command: TYPECHECK }, { error: 'boom' })).toBeNull();
    expect(shellValidationPass(SID, 'tu-x', { command: TYPECHECK }, { interrupted: true })).toBeNull();
    expect(shellValidationPass(SID, 'tu-x', { command: `${TYPECHECK} | tail` }, {})).toBeNull();
    expect(shellValidationPass(SID, 'tu-x', { command: 'bun run build' }, {})).toBeNull();
    // the same call, clean: a pass (the null results above did not consume the note)
    expect(shellValidationPass(SID, 'tu-x', { command: TYPECHECK }, 'plain text response')).not.toBeNull();
  });

  test('no failed marker, a marker with no root or no command, and no start note give null', () => {
    noteBashStart(SID, 'tu-y', proj, TYPECHECK);
    expect(shellValidationPass(SID, 'tu-y', { command: TYPECHECK }, {})).toBeNull(); // no marker
    writeValidationFailure(SID, [TYPECHECK]); // no root
    expect(shellValidationPass(SID, 'tu-y', { command: TYPECHECK }, {})).toBeNull();
    writeValidationFailure(SID, [], proj); // no command
    expect(shellValidationPass(SID, 'tu-y', { command: TYPECHECK }, {})).toBeNull();
    failed();
    expect(shellValidationPass(SID, 'tu-no-note', { command: TYPECHECK }, {})).toBeNull();
    expect(shellValidationPass(SID, undefined, { command: TYPECHECK }, {})).toBeNull();
  });

  test('a call that started in another directory is no pass', () => {
    failed();
    noteBashStart(SID, 'tu-elsewhere', box, TYPECHECK);
    expect(shellValidationPass(SID, 'tu-elsewhere', { command: TYPECHECK }, {})).toBeNull();
  });

  test('never throws: an input that is not an object gives null', () => {
    failed();
    expect(shellValidationPass(SID, 'tu-x', null as unknown as Record<string, unknown>, {})).toBeNull();
  });
});

// --- lib/validation-state.ts failureMarkerRoot ---

describe('failureMarkerRoot', () => {
  test('the root the marker names; null for no marker, a torn marker, or one with no root', () => {
    expect(failureMarkerRoot(SID)).toBeNull();
    writeValidationFailure(SID, [TYPECHECK], proj);
    expect(failureMarkerRoot(SID)).toBe(proj);
    const marker = join(sessionDir(), '.goodboy-validation-failed.json');
    writeFileSync(marker, '{"sessionId": ');
    expect(failureMarkerRoot(SID)).toBeNull();
    writeFileSync(marker, JSON.stringify({ sessionId: SID, commands: [TYPECHECK], root: '' }));
    expect(failureMarkerRoot(SID)).toBeNull();
    writeFileSync(marker, 'null');
    expect(failureMarkerRoot(SID)).toBeNull();
  });
});

// --- lib/state-guard.ts: the pass record copy ---

describe('the state guard and an unusable pass record copy', () => {
  const planted = JSON.stringify({ passes: { [TYPECHECK]: new Date(Date.now() + 1000).toISOString() } });

  test('a cwd the guard cannot resolve keeps no copy of the record (and the snapshot does not throw)', () => {
    writeValidationFailure(SID, [TYPECHECK], proj);
    expect(() => snapshotGateState(SID, 'tu-badcwd', 123 as unknown as string)).not.toThrow();
    expect(findFiles(sessionDir(), 'validation-passed.json')).toEqual([]);
  });

  test('a torn copy names no root: the root of the failure marker loses its record', () => {
    writeValidationFailure(SID, [TYPECHECK], proj);
    snapshotGateState(SID, 'tu-torn-copy', proj);
    const copies = findFiles(sessionDir(), 'validation-passed.json');
    expect(copies.length).toBe(1);
    writeFileSync(copies[0]!, '{"records": ');
    const file = validationPassFile(proj)!;
    writeFileSync(file, planted);
    expect(restoreGateState(SID, 'tu-torn-copy')).toContain('validation-passed.json');
    expect(existsSync(file)).toBe(false);
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a copy with no usable record entry is the same: nothing is believed', () => {
    writeValidationFailure(SID, [TYPECHECK], proj);
    snapshotGateState(SID, 'tu-empty-copy', proj);
    const copies = findFiles(sessionDir(), 'validation-passed.json');
    writeFileSync(copies[0]!, JSON.stringify({ records: [{ root: 7, text: 'x' }, null, { root: '' }] }));
    const file = validationPassFile(proj)!;
    writeFileSync(file, planted);
    expect(restoreGateState(SID, 'tu-empty-copy')).toContain('validation-passed.json');
    expect(existsSync(file)).toBe(false);
  });
});

// --- lib/write-sweep.ts resnapshotAgentCalls ---

describe('resnapshotAgentCalls', () => {
  test('takes the snapshot of an open agent call again, so a clock the Stop wrote since is in it', () => {
    mkdirSync(sessionDir(), { recursive: true });
    noteBashStart(SID, 'tu-agent', proj, 'sleep 100', 'goodboy:test-unit');
    snapshotGateState(SID, 'tu-agent', proj);
    const clock = join(sessionDir(), 'agent-deferral.json');
    // The Stop starts the clock after the call's snapshot: the call's post hook would remove it as a file the call made.
    writeFileSync(clock, JSON.stringify({ start: Date.now() - 1000 }));
    resnapshotAgentCalls(SID);
    expect(restoreGateState(SID, 'tu-agent')).not.toContain('agent-deferral.json');
    expect(existsSync(clock)).toBe(true);
  });

  test('a call that is not an agent call is left as it was snapshotted', () => {
    mkdirSync(sessionDir(), { recursive: true });
    noteBashStart(SID, 'tu-model', proj, 'sleep 100');
    snapshotGateState(SID, 'tu-model', proj);
    const clock = join(sessionDir(), 'agent-deferral.json');
    writeFileSync(clock, JSON.stringify({ start: Date.now() - 1000 }));
    resnapshotAgentCalls(SID);
    expect(restoreGateState(SID, 'tu-model')).toContain('agent-deferral.json');
    expect(existsSync(clock)).toBe(false);
  });

  test('no open call, or a session that does not exist, does nothing and does not throw', () => {
    expect(() => resnapshotAgentCalls(SID)).not.toThrow();
    expect(() => resnapshotAgentCalls('')).not.toThrow();
  });
});

// --- lib/unpushed-work.ts treeRecordWindow ---

describe('treeRecordWindow', () => {
  function repo(pushed: boolean): string {
    const d = join(box, pushed ? 'pushed' : 'local');
    mkdirSync(d, { recursive: true });
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    if (pushed) {
      const bare = join(box, 'bare');
      mkdirSync(bare);
      sh(bare, 'git init -q --bare');
      sh(d, `git remote add origin '${bare}' && git push -q origin main`);
    }
    return d;
  }

  test('30 days while a commit is unpushed, none once everything is pushed', () => {
    expect(treeRecordWindow(repo(false))()).toBe(TREE_RECORD_WINDOW_MIN);
    expect(treeRecordWindow(repo(true))()).toBe(0);
  });

  test('asked again within one Stop, it is the same answer and git is not asked again', () => {
    const d = repo(false);
    beginGitSnapshot();
    const window = treeRecordWindow(d);
    expect(window()).toBe(TREE_RECORD_WINDOW_MIN);
    // A push in between does not change the answer inside the Stop's snapshot (the memo), as the Stop reads it once.
    const bare = join(box, 'bare2');
    mkdirSync(bare);
    sh(bare, 'git init -q --bare');
    sh(d, `git remote add origin '${bare}' && git push -q origin main`);
    expect(window()).toBe(TREE_RECORD_WINDOW_MIN);
    endGitSnapshot();
    expect(treeRecordWindow(d)()).toBe(0);
  });

  test('a directory that is no repo counts as unpushed (git cannot say)', () => {
    const d = join(box, 'plain');
    mkdirSync(d);
    expect(treeRecordWindow(d)()).toBe(TREE_RECORD_WINDOW_MIN);
  });
});

// --- lib/test-catalog.ts writeCatalog: a write that fails ---

describe('writeCatalog when the file cannot be written', () => {
  function catalogRepo(): string {
    const d = join(box, 'repo');
    mkdirSync(join(d, 'tests'), { recursive: true });
    sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
    writeFileSync(join(d, 'tests', 'a.test.ts'), "import { test } from 'bun:test';\ntest('adds up', () => {});\n");
    sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
    return d;
  }

  test('a .goodboy dir that cannot be written to is a refusal with the reason, and no temp file stays', () => {
    const d = catalogRepo();
    mkdirSync(join(d, '.goodboy'));
    chmodSync(join(d, '.goodboy'), 0o555);
    const r = writeCatalog(d);
    chmodSync(join(d, '.goodboy'), 0o755);
    if (process.getuid?.() === 0) return; // root writes anywhere: nothing to refuse
    expect(r).toMatchObject({ ok: false, why: 'error' });
    expect(readdirSync(join(d, '.goodboy'))).toEqual([]);
  });

  test('a catalog path that is a directory fails at the rename, and the temp file is removed', () => {
    const d = catalogRepo();
    mkdirSync(join(d, '.goodboy', 'test-catalog.md'), { recursive: true });
    const r = writeCatalog(d);
    expect(r).toMatchObject({ ok: false, why: 'error' });
    expect(readdirSync(join(d, '.goodboy'))).toEqual(['test-catalog.md']); // no .test-catalog.*.tmp left
  });

  test('a link in the place is still refused as a symlink (the earlier rule is untouched)', () => {
    const d = catalogRepo();
    mkdirSync(join(d, '.goodboy'));
    writeFileSync(join(box, 'elsewhere.md'), 'x');
    symlinkSync(join(box, 'elsewhere.md'), join(d, '.goodboy', 'test-catalog.md'));
    expect(writeCatalog(d)).toEqual({ ok: false, why: 'symlink' });
    expect(readFileSync(join(box, 'elsewhere.md'), 'utf8')).toBe('x');
  });
});
