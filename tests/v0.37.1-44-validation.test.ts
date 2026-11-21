// Field report #44, plan §15.36 item 3: a passing validation run in the shell clears the failed-validation
// marker, and the pass record cannot be forged by a shell write.
//
// Everything runs against a private TMPDIR (session dir, project state dir, start notes): nothing under the
// real ~/.claude/goodboy, no docker, no network.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { noteBashStart } from '../lib/approval-marker';
import { exactMarkerCommand } from '../lib/shell-validation-pass';
import { restoreGateState, snapshotGateState, writesGateState } from '../lib/state-guard';
import {
  failureMarkerRoot,
  readValidationFailure,
  recordValidationPass,
  validationPassFile,
  writeValidationFailure,
} from '../lib/validation-state';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'post-tool-use.ts');
const TYPECHECK = 'bun run typecheck';
const LINT = 'bun run lint';

let prevTmp: string | undefined;
let box = '';
let proj = '';
const SID = 'sess-44';

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'goodboy-v44-'));
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = box;
  proj = join(box, 'proj');
  mkdirSync(join(proj, 'sub'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), '{"name":"fixture"}');
});
afterEach(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = prevTmp;
  rmSync(box, { recursive: true, force: true });
});

/** The next millisecond, so a later start is strictly after the failure's timestamp. */
function tick(): void {
  const t = Date.now();
  while (Date.now() === t) {
    // spin
  }
}

/** Runs the real PostToolUse hook for a finished Bash call whose start note PreToolUse would have written. */
async function bashDone(
  command: string,
  opts: { startCwd?: string; startedAt?: number; input?: Record<string, unknown>; response?: Record<string, unknown> } = {},
): Promise<void> {
  const cwd = opts.startCwd ?? proj;
  const tuid = `tu-${Math.random().toString(36).slice(2)}`;
  noteBashStart(SID, tuid, cwd, command, undefined, undefined, opts.startedAt ?? Date.now());
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: SID,
        cwd,
        tool_name: 'Bash',
        tool_use_id: tuid,
        tool_input: { command, ...(opts.input ?? {}) },
        tool_response: { stdout: '', stderr: '', interrupted: false, ...(opts.response ?? {}) },
      }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TMPDIR: box, GOODBOY_AUTOVALIDATE: 'off' },
  });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  await proc.exited;
}

function fail(commands: string[] = [TYPECHECK]): void {
  writeValidationFailure(SID, commands, proj);
  tick();
}

const markerFile = (): string => join(box, `goodboy-session-${SID}`, '.goodboy-validation-failed.json');

describe('a passing shell run clears the failed marker (#44 item 4)', () => {
  test('the exact command, run from the project root, clears it and removes the marker file', async () => {
    fail();
    expect(readValidationFailure(SID)).not.toBeNull();
    await bashDone(TYPECHECK);
    expect(readValidationFailure(SID)).toBeNull();
    expect(existsSync(markerFile())).toBe(false);
  });

  test('`cd <root> &&` in front, from another directory, clears it', async () => {
    fail();
    await bashDone(`cd ${proj} && ${TYPECHECK}`, { startCwd: join(proj, 'sub') });
    expect(readValidationFailure(SID)).toBeNull();
  });

  test('a quoted cd target and a relative one resolve to the root', async () => {
    fail();
    await bashDone(`cd "${proj}" && ${TYPECHECK}`, { startCwd: box });
    expect(readValidationFailure(SID)).toBeNull();
    fail();
    await bashDone(`cd .. && ${TYPECHECK}`, { startCwd: join(proj, 'sub') });
    expect(readValidationFailure(SID)).toBeNull();
  });

  test.each([
    ['`|| true`', `${TYPECHECK} || true`],
    ['a pipe', `${TYPECHECK} | tail -3`],
    ['`;`', `${TYPECHECK}; echo done`],
    ['`&&` after the command', `${TYPECHECK} && echo done`],
    ['a background `&`', `${TYPECHECK} &`],
    ['a redirect', `${TYPECHECK} > /dev/null`],
    ['a command substitution', `echo $(${TYPECHECK})`],
    ['backticks', `echo \`${TYPECHECK}\``],
    ['a newline', `true\n${TYPECHECK}`],
    ['an echo of the command', `echo ${TYPECHECK}`],
    ['another command', 'bun run build'],
    ['an extra argument', `${TYPECHECK} --silent`],
    ['a cd that expands', `cd $HOME && ${TYPECHECK}`],
  ])('%s is no pass', async (_name, command) => {
    fail();
    await bashDone(command);
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test.each([
    ['rtk', `rtk ${TYPECHECK}`],
    ['rtk proxy', `rtk proxy ${TYPECHECK}`],
    // @ROOT@ is the project dir, which is made per test (after this table is built).
    ['cd, then rtk', `cd @ROOT@ && rtk ${TYPECHECK}`],
    ['cd, then rtk proxy', `cd @ROOT@ && rtk proxy ${TYPECHECK}`],
  ])('the RTK hook\'s rewrite counts as the command: %s', async (_name, template) => {
    fail();
    const command = template.replace('@ROOT@', proj);
    await bashDone(command, { startCwd: command.startsWith('cd ') ? join(proj, 'sub') : proj });
    expect(readValidationFailure(SID)).toBeNull();
  });

  test.each([
    ['rtk with a flag', `rtk -v ${TYPECHECK}`],
    ['rtk proxy with a flag', `rtk proxy -v ${TYPECHECK}`],
    ['another rtk subcommand', `rtk gain ${TYPECHECK}`],
    ['rtk twice', `rtk rtk ${TYPECHECK}`],
    ['rtk proxy rtk', `rtk proxy rtk ${TYPECHECK}`],
    ['rtk before the cd', `rtk cd @ROOT@ && ${TYPECHECK}`],
    ['rtk with an env prefix', `rtk env ${TYPECHECK}`],
    ['rtk with a pipe', `rtk ${TYPECHECK} | tail -3`],
    ['rtk with || true', `rtk proxy ${TYPECHECK} || true`],
    ['rtk alone', 'rtk'],
  ])('%s is no pass', async (_name, template) => {
    fail();
    // From the root, or from below it when the command cds to it: the prefix alone is what makes each no pass.
    await bashDone(template.replace('@ROOT@', proj), { startCwd: template.includes('@ROOT@') ? join(proj, 'sub') : proj });
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a different working directory is no pass', async () => {
    fail();
    await bashDone(TYPECHECK, { startCwd: join(proj, 'sub') });
    expect(readValidationFailure(SID)).not.toBeNull();
    await bashDone(`cd ${join(proj, 'sub')} && ${TYPECHECK}`);
    expect(readValidationFailure(SID)).not.toBeNull();
    await bashDone(TYPECHECK, { startCwd: box });
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a run that started before the failure is no pass', async () => {
    const startedBefore = Date.now() - 5_000;
    fail();
    await bashDone(TYPECHECK, { startedAt: startedBefore });
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a background run, an interrupted run and an error response are no pass', async () => {
    fail();
    await bashDone(TYPECHECK, { input: { run_in_background: true } });
    await bashDone(TYPECHECK, { response: { interrupted: true } });
    await bashDone(TYPECHECK, { response: { is_error: true } });
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a marker with two commands is lifted only when both passed after it', async () => {
    fail([TYPECHECK, LINT]);
    await bashDone(TYPECHECK);
    expect(readValidationFailure(SID)).not.toBeNull();
    await bashDone(LINT);
    expect(readValidationFailure(SID)).toBeNull();
  });

  test('with no failed marker the call records nothing (no project state dir is made)', async () => {
    await bashDone(TYPECHECK);
    expect(readdirSync(box).filter((n) => n.startsWith('goodboy-project-'))).toEqual([]);
  });

  test('a marker without a root (written before roots were recorded) is left alone', async () => {
    writeValidationFailure(SID, [TYPECHECK]);
    tick();
    await bashDone(TYPECHECK);
    expect(readValidationFailure(SID)).not.toBeNull();
  });
});

describe('exactMarkerCommand', () => {
  const cmds = [TYPECHECK, LINT];
  test('accepts the exact command and the cd prefix; rejects the rest', () => {
    expect(exactMarkerCommand(TYPECHECK, cmds, proj, proj)).toBe(TYPECHECK);
    expect(exactMarkerCommand(`  ${LINT}  `, cmds, proj, proj)).toBe(LINT);
    expect(exactMarkerCommand(`cd ${proj} && ${LINT}`, cmds, proj, box)).toBe(LINT);
    expect(exactMarkerCommand(`cd ${proj}&&${LINT}`, cmds, proj, box)).toBe(LINT);
    expect(exactMarkerCommand(TYPECHECK, cmds, proj, box)).toBeNull();
    expect(exactMarkerCommand(`cd ${box} && ${TYPECHECK}`, cmds, proj, proj)).toBeNull();
    expect(exactMarkerCommand(`cd ${proj} && cd ${proj} && ${TYPECHECK}`, cmds, proj, proj)).toBeNull();
    expect(exactMarkerCommand(`rtk ${TYPECHECK}`, cmds, proj, proj)).toBe(TYPECHECK);
    expect(exactMarkerCommand(`rtk proxy ${LINT}`, cmds, proj, proj)).toBe(LINT);
    expect(exactMarkerCommand(`cd ${proj} && rtk  proxy  ${LINT}`, cmds, proj, box)).toBe(LINT);
    expect(exactMarkerCommand(`rtk -v ${TYPECHECK}`, cmds, proj, proj)).toBeNull();
    expect(exactMarkerCommand(`rtk proxy rtk ${TYPECHECK}`, cmds, proj, proj)).toBeNull();
    expect(exactMarkerCommand(`rtk ${TYPECHECK}`, cmds, proj, box)).toBeNull();
    expect(exactMarkerCommand('', cmds, proj, proj)).toBeNull();
    expect(exactMarkerCommand(TYPECHECK, [], proj, proj)).toBeNull();
  });
});

// --- the state guard: a shell write cannot forge a pass ---

/** A planted record whose entry starts `aheadMs` from now: 0 is what the read rule cannot tell from a real pass. */
function forgedPass(command = TYPECHECK, aheadMs = 0): string {
  return JSON.stringify({ passes: { [command]: new Date(Date.now() + aheadMs).toISOString() } });
}

function shellWrite(file: string, text: string): void {
  // A real shell, as a model Bash call would do it.
  Bun.spawnSync(['sh', '-c', 'printf %s "$1" > "$2"', 'sh', text, file]);
}

describe('the state guard keeps the pass record (#44)', () => {
  test('a pass a shell call wrote is removed after it, and the failure still blocks', () => {
    fail();
    const file = validationPassFile(proj)!;
    expect(existsSync(file)).toBe(false);
    snapshotGateState(SID, 'tu-forge');
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    shellWrite(file, forgedPass());
    expect(readValidationFailure(SID)).toBeNull(); // the forgery works without the guard
    expect(restoreGateState(SID, 'tu-forge')).toContain('validation-passed.json');
    expect(existsSync(file)).toBe(false);
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a record the call rewrote goes back to what it held', () => {
    fail();
    const old = new Date(Date.now() - 60_000).toISOString();
    recordValidationPass(proj, [LINT], old);
    const file = validationPassFile(proj)!;
    const before = readFileSync(file, 'utf8');
    snapshotGateState(SID, 'tu-rewrite');
    shellWrite(file, forgedPass());
    expect(readValidationFailure(SID)).toBeNull();
    expect(restoreGateState(SID, 'tu-rewrite')).toContain('validation-passed.json');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a call that did not touch the record changes nothing', () => {
    fail();
    recordValidationPass(proj, [LINT], new Date(Date.now() - 60_000).toISOString());
    const file = validationPassFile(proj)!;
    const before = readFileSync(file, 'utf8');
    snapshotGateState(SID, 'tu-quiet');
    expect(restoreGateState(SID, 'tu-quiet')).not.toContain('validation-passed.json');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('an index the call deleted (untrusted snapshot) drops the record rather than believe a planted copy', () => {
    fail();
    snapshotGateState(SID, 'tu-untrusted');
    const file = validationPassFile(proj)!;
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    shellWrite(file, forgedPass());
    rmSync(join(box, `goodboy-session-${SID}`, 'bash-guard-tu-untrusted', '.index.json'));
    expect(restoreGateState(SID, 'tu-untrusted')).toContain('validation-passed.json');
    expect(existsSync(file)).toBe(false);
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('a validation-passed.json the call made in the session dir is removed', () => {
    fail();
    snapshotGateState(SID, 'tu-session-file');
    const stray = join(box, `goodboy-session-${SID}`, 'validation-passed.json');
    shellWrite(stray, forgedPass());
    restoreGateState(SID, 'tu-session-file');
    expect(existsSync(stray)).toBe(false);
  });

  test('with no failed marker and no project dir nothing is copied or restored', () => {
    expect(failureMarkerRoot(SID)).toBeNull();
    snapshotGateState(SID, 'tu-none');
    expect(restoreGateState(SID, 'tu-none')).toEqual([]);
    snapshotGateState(SID, 'tu-none-cwd', proj);
    expect(restoreGateState(SID, 'tu-none-cwd')).toEqual([]);
    expect(readdirSync(box).filter((n) => n.startsWith('goodboy-project-'))).toEqual([]); // the guard makes no dir
  });

  // #44 security review: a pass planted before the breaking edit made the next failure stale at once.
  test('a pass planted before any failure exists is removed after the call (plant first)', () => {
    const file = validationPassFile(proj)!; // a project dir, as an earlier validation made it
    snapshotGateState(SID, 'tu-plant', proj); // no failure marker yet
    shellWrite(file, forgedPass(TYPECHECK, 1_500));
    expect(restoreGateState(SID, 'tu-plant')).toContain('validation-passed.json');
    expect(existsSync(file)).toBe(false);
    fail(); // the breaking edit
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('the project of a subdirectory cwd is the one kept', () => {
    const file = validationPassFile(proj)!;
    snapshotGateState(SID, 'tu-sub', join(proj, 'sub'));
    shellWrite(file, forgedPass(TYPECHECK, 1_500));
    expect(restoreGateState(SID, 'tu-sub')).toContain('validation-passed.json');
    expect(existsSync(file)).toBe(false);
  });

  test('a project dir the call made itself, with a record in it, is cleaned', () => {
    // Where a call makes the dir (mode 0700 as a shell with umask 077 would), the guard still removes the record.
    const dir = join(validationPassFile(proj)!, '..');
    rmSync(dir, { recursive: true, force: true });
    snapshotGateState(SID, 'tu-made', proj);
    mkdirSync(dir, { mode: 0o700 });
    shellWrite(join(dir, 'validation-passed.json'), forgedPass(TYPECHECK, 1_500));
    expect(restoreGateState(SID, 'tu-made')).toContain('validation-passed.json');
    expect(existsSync(join(dir, 'validation-passed.json'))).toBe(false);
  });

  test('a pass entry that starts after its record was written is not read (planted ahead)', () => {
    fail();
    const file = validationPassFile(proj)!;
    shellWrite(file, forgedPass(TYPECHECK, 4 * 60_000)); // 4 minutes inside the old clock-skew bound
    expect(readValidationFailure(SID)).not.toBeNull();
    shellWrite(file, forgedPass(TYPECHECK, 500)); // a real run starts before its record is written
    expect(readValidationFailure(SID)).toBeNull();
  });

  test('each of the two read rules rejects on its own', () => {
    fail();
    const file = validationPassFile(proj)!;
    // Later than the record's write time, though not later than now: the write time is set back.
    shellWrite(file, forgedPass(TYPECHECK, 0));
    utimesSync(file, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
    expect(readValidationFailure(SID)).not.toBeNull();
    // Later than now, though not later than the write time: the write time is set ahead too.
    shellWrite(file, forgedPass(TYPECHECK, 4 * 60_000));
    utimesSync(file, new Date(Date.now() + 10 * 60_000), new Date(Date.now() + 10 * 60_000));
    expect(readValidationFailure(SID)).not.toBeNull();
  });

  test('the hook records its pass after the restore: the cleared marker stays cleared', async () => {
    fail();
    await bashDone(TYPECHECK);
    expect(readValidationFailure(SID)).toBeNull();
    expect(readFileSync(validationPassFile(proj)!, 'utf8')).toContain(TYPECHECK);
  });
});

describe('the agent-deferral clock is state-guarded (#44 item 3, lib/agent-deferral.ts)', () => {
  const clock = (): string => join(box, `goodboy-session-${SID}`, 'agent-deferral.json');
  const started = JSON.stringify({ start: Date.now() - 50 * 60_000 });

  test('a clock a call deleted or restarted goes back to its old start', () => {
    mkdirSync(join(box, `goodboy-session-${SID}`), { recursive: true });
    writeFileSync(clock(), started);
    snapshotGateState(SID, 'tu-clock-rm');
    rmSync(clock());
    expect(restoreGateState(SID, 'tu-clock-rm')).toContain('agent-deferral.json');
    expect(readFileSync(clock(), 'utf8')).toBe(started);
    snapshotGateState(SID, 'tu-clock-rw');
    shellWrite(clock(), JSON.stringify({ start: Date.now() }));
    expect(restoreGateState(SID, 'tu-clock-rw')).toContain('agent-deferral.json');
    expect(readFileSync(clock(), 'utf8')).toBe(started);
  });

  test('a clock a call made is removed, as the Stop writes it and no call may', () => {
    mkdirSync(join(box, `goodboy-session-${SID}`), { recursive: true });
    snapshotGateState(SID, 'tu-clock-new');
    shellWrite(clock(), JSON.stringify({ start: Date.now() }));
    expect(restoreGateState(SID, 'tu-clock-new')).toContain('agent-deferral.json');
    expect(existsSync(clock())).toBe(false);
  });
});

// --- the file tools: the real PreToolUse hook denies goodboy's project state dir like its session dirs ---

async function preToolUse(tool: string, input: Record<string, unknown>): Promise<{ denied: boolean; reason: string }> {
  const proc = Bun.spawn(['bun', resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts')], {
    cwd: proj,
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: SID, cwd: proj, tool_name: tool, tool_use_id: 'tu-pre', tool_input: input })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TMPDIR: box, GOODBOY_DISABLE_DELEGATION: '1' },
  });
  const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  await proc.exited;
  const h = out.hookSpecificOutput ?? {};
  return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
}

describe('file-tool writes to goodboy-project-* are denied (#44 security review)', () => {
  test.each([
    ['Write', { content: '{}' }],
    ['Edit', { old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }] }],
  ])('%s to the pass record', async (tool, extra) => {
    const file = validationPassFile(proj)!;
    const r = await preToolUse(tool, { file_path: file, ...extra });
    expect([tool, r.denied, r.reason]).toEqual([tool, true, expect.stringContaining('goodboy-project-')]);
  });

  test('NotebookEdit to the pass record', async () => {
    const r = await preToolUse('NotebookEdit', { notebook_path: validationPassFile(proj)!, new_source: 'x' });
    expect(r.denied).toBe(true);
  });

  test('any file in the project state dir, and the dir by a relative path, is denied; the session dir still is', async () => {
    const dir = join(validationPassFile(proj)!, '..');
    expect((await preToolUse('Write', { file_path: join(dir, 'other.json'), content: '{}' })).denied).toBe(true);
    expect((await preToolUse('Write', { file_path: join(dir, '..', 'goodboy-project-x', 'validation-passed.json'), content: '{}' })).denied).toBe(true);
    expect((await preToolUse('Write', { file_path: join(box, 'goodboy-session-other', 'edits.jsonl'), content: '' })).denied).toBe(true);
  });

  test('an ordinary project file is not denied for that reason', async () => {
    const r = await preToolUse('Write', { file_path: join(proj, 'new-file.ts'), content: 'export {}' });
    expect(r.reason).not.toContain('goodboy-project-');
  });
});

// --- whitespace: only the shell's blanks separate words (#44 security review) ---

describe('exactMarkerCommand reads only ASCII spaces and tabs as blanks', () => {
  const NBSP = ' ';
  const cmds = [TYPECHECK];
  test('a no-break space or another Unicode blank is no separator, so no match', () => {
    for (const c of [
      `${TYPECHECK}${NBSP}`,
      `${NBSP}${TYPECHECK}`,
      `${TYPECHECK} `,
      `${TYPECHECK} `,
      `${TYPECHECK}\u000b`,
      `bun${NBSP}run typecheck`,
      `rtk${NBSP}${TYPECHECK}`,
      `cd ${proj}${NBSP}&& ${TYPECHECK}`,
      `cd ${proj} &&${NBSP}${TYPECHECK}`,
      `cd${NBSP}${proj} && ${TYPECHECK}`,
    ]) {
      expect([JSON.stringify(c), exactMarkerCommand(c, cmds, proj, proj)]).toEqual([JSON.stringify(c), null]);
    }
  });

  test('ASCII spaces and tabs around the command and between the prefix words still match', () => {
    expect(exactMarkerCommand(`\t ${TYPECHECK} \t`, cmds, proj, proj)).toBe(TYPECHECK);
    expect(exactMarkerCommand(`cd\t${proj}\t&&\trtk\tproxy\t${TYPECHECK}`, cmds, proj, box)).toBe(TYPECHECK);
  });

  test('the hook: a trailing no-break space is no pass', async () => {
    fail();
    await bashDone(`${TYPECHECK}${NBSP}`);
    expect(readValidationFailure(SID)).not.toBeNull();
    await bashDone(`${TYPECHECK} `);
    expect(readValidationFailure(SID)).toBeNull();
  });
});

describe('the shell pre-check names the project state dir like the session dir', () => {
  test('a command that changes goodboy-project-* (or a glob that can match it) is a gate-state write; a read is not', () => {
    for (const cmd of [
      'rm /tmp/goodboy-project-abc/validation-passed.json',
      'printf x > /tmp/goodboy-project-abc/validation-passed.json',
      'rm -rf /tmp/goodboy-p*',
      'rm -rf /tmp/goodboy-proj*',
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, true]);
    }
    expect(writesGateState('cat /tmp/goodboy-project-abc/validation-passed.json')).toBe(false);
    expect(writesGateState('rm src/goodboyProjectHelper.ts')).toBe(false);
  });

  // v0.37.2: both state dirs are `goodboy-<kind>-<id>`: the hyphen after the kind is part of the name, and a glob counts
  // when it can still match such a dir (any prefix of the kind word, or `goodboy` alone, then a glob character).
  test('a user dir that only looks like a state dir is no gate-state write', () => {
    for (const cmd of [
      'rm -rf goodboy_project/build',
      'rm -rf ~/work/goodboy-project/x',
      'mkdir goodboy_session',
      'rm -rf goodboy_session/x',
      'rm -rf goodboy-session/x',
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, false]);
    }
  });

  test('a glob that can match a state dir is a gate-state write, whichever prefix of the kind word it keeps', () => {
    for (const cmd of [
      'rm -rf /tmp/goodboy-pr*',
      'rm -rf /tmp/goodboy-se*',
      'rm -rf /tmp/goodboy-?roject-x',
      'rm /tmp/goodboy-proj[e]ct-a/x',
      'rm -rf /tmp/goodboy-*',
      'rm -rf /tmp/goodboy*',
      'rm -rf /tmp/goodboy-sess?on-x',
      'rm -rf /tmp/goodboy-session-abc',
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, true]);
    }
  });

  // The shell can supply the hyphen after the kind (an expansion, a brace list, a quote, a backslash): those words can
  // still name a state dir, so they stay writes.
  test('an expansion after the kind word can supply the hyphen: still a gate-state write', () => {
    for (const cmd of [
      'rm -rf /tmp/goodboy-session$E-abc',
      'rm -rf /tmp/goodboy-session${E}-abc',
      'rm -rf /tmp/goodboy-session$(echo -abc)',
      'rm -rf /tmp/goodboy-session{-abc,}',
      'rm -rf /tmp/goodboy-project$E-abc',
      'rm -rf /tmp/goodboy-project`echo -x`',
      'rm -rf /tmp/goodboy-session\\-abc',
      "rm -rf /tmp/goodboy-session'-x'",
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, true]);
    }
  });

  // A bare `goodboy` needs `*`, or `?` / a `[...]` class that goes on toward a kind (`-`, `s`, `p` or a glob character).
  test('a bare `goodboy?` or `goodboy[...]` counts only when it goes on toward a state dir', () => {
    for (const cmd of [
      'rm -rf /tmp/goodboy?session-x',
      'rm -rf /tmp/goodboy[-]project-x',
      'rm -rf /tmp/goodboy?pro*',
      'rm -rf /tmp/goodboy?*',
      'rm -rf /tmp/goodboy[-]s*',
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, true]);
    }
    for (const cmd of [
      'git commit -m "fix goodboy?"',
      'bun test tests/goodboy[0-9].test.ts',
      'rm tests/goodboy[0-9].test.ts',
      'rm goodboy?x',
      'rm -rf goodboy-project.bak',
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, false]);
    }
  });

  // After the kind word, anything but the end of the word, `/`, `.` or `_` can still go on to `-<id>` (an escape that
  // spells the hyphen, an extglob), so it counts; the end, a path separator, a file extension and an underscore do not.
  test('anything after the kind word but its end, `/`, `.` or `_` can complete a state dir name', () => {
    for (const cmd of [
      "rm -rf /tmp/goodboy-session$'\\x2dabc'",
      "rm -rf /tmp/goodboy-session$'\\055abc'",
      'rm -rf /tmp/goodboy-session@(-abc)',
      'rm -rf /tmp/goodboy-session+(-)abc',
      'rm -rf /tmp/goodboy-sessions-x',
      'rm -rf /tmp/goodboy-session-x',
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, true]);
    }
    for (const cmd of [
      'rm -rf goodboy-project.md',
      'rm goodboy_session',
      'rm -rf /tmp/goodboy-session',
      'rm -rf goodboy-project/x',
      'rm -rf goodboy-session_x',
    ]) {
      expect([cmd, writesGateState(cmd)]).toEqual([cmd, false]);
    }
  });

  test('a very long word of repeated `goodboy[` is judged in linear time (the bracket class is bounded)', () => {
    const cmd = `rm -rf ${'goodboy['.repeat(100_000)}`; // 800 KB
    const started = Date.now();
    writesGateState(cmd);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
