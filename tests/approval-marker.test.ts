// lib/approval-marker.ts — per-session approval marker names (A3).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approvalMarkerPath,
  approvalMarkerRelPath,
  noteRiskApprovalPath,
  sessionTag,
  withdrawRiskApprovals,
} from '../lib/approval-marker';

describe('approval markers (A3)', () => {
  test('the tag is the first 8 characters of the sanitized session id', () => {
    expect(sessionTag('7d9ae000-267a-4875-b861-0da0234c82e5')).toBe('7d9ae000');
    expect(sessionTag('sess-A')).toBe('sess-A');
    expect(sessionTag('')).toBe('unknown');
  });

  test('names differ per session and per gate', () => {
    expect(approvalMarkerRelPath('risk', '7d9ae000-267a')).toBe('.claude/.goodboy-risk-approved-7d9ae000.txt');
    expect(approvalMarkerRelPath('bash-write', 'sess-A')).toBe('.claude/.goodboy-bash-write-approved-sess-A.txt');
    expect(approvalMarkerRelPath('risk', 'a1')).not.toBe(approvalMarkerRelPath('risk', 'b2'));
  });

  test('a hostile session id stays a file name inside .claude/', () => {
    expect(approvalMarkerPath('/repo', 'risk', '../../etc/passwd')).toBe('/repo/.claude/.goodboy-risk-approved-______et.txt');
  });
});

// The noted paths live in the session state dir, so these run against a private TMPDIR.
describe('risk approval withdrawal (A3)', () => {
  let prevTmp: string | undefined;
  let box = '';
  beforeEach(() => {
    box = mkdtempSync(join(tmpdir(), 'goodboy-am-'));
    prevTmp = process.env.TMPDIR;
    process.env.TMPDIR = box;
  });
  afterEach(() => {
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    rmSync(box, { recursive: true, force: true });
  });

  test("withdraws this session's markers wherever the gate looked, and nothing else", () => {
    const repo = mkdtempSync(join(box, 'repo-'));
    const pkg = join(repo, 'pkg');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    mkdirSync(join(pkg, '.claude'), { recursive: true });
    const here = approvalMarkerPath(repo, 'risk', 'sess-w');
    const there = approvalMarkerPath(pkg, 'risk', 'sess-w');
    const otherSession = approvalMarkerPath(repo, 'risk', 'sess-x');
    const keep = join(repo, 'keep.ts');
    for (const p of [here, there, otherSession, keep]) writeFileSync(p, '', 'utf8');

    noteRiskApprovalPath('sess-w', there);
    noteRiskApprovalPath('sess-w', keep); // as if the list were tampered with: not a marker
    withdrawRiskApprovals('sess-w', repo);

    expect(existsSync(here)).toBe(false);
    expect(existsSync(there)).toBe(false);
    expect(existsSync(otherSession)).toBe(true);
    expect(existsSync(keep)).toBe(true);
  });

  // Round 3 (refactoring review): the list was one JSON array that each note rewrote. A
  //   concurrent note (a subagent in another cwd) or a torn write lost the paths noted
  //   before it, and a lost path is an approval the next task does not withdraw.
  test('a torn write does not lose the paths noted before it', () => {
    const repo = mkdtempSync(join(box, 'repo-'));
    const dirs = ['a', 'b', 'c'].map((d) => join(repo, d));
    const markers = dirs.map((d) => approvalMarkerPath(d, 'risk', 'sess-t'));
    for (const d of dirs) mkdirSync(join(d, '.claude'), { recursive: true });
    for (const m of markers) writeFileSync(m, '', 'utf8');
    noteRiskApprovalPath('sess-t', markers[0]!);
    noteRiskApprovalPath('sess-t', markers[1]!);
    const list = readdirSync(join(box, 'goodboy-session-sess-t')).find((f) => f.startsWith('risk-approval-paths'));
    appendFileSync(join(box, 'goodboy-session-sess-t', list!), '\n"/half-writ', 'utf8'); // a record cut short
    noteRiskApprovalPath('sess-t', markers[2]!);
    withdrawRiskApprovals('sess-t', repo);
    for (const m of markers) expect(existsSync(m)).toBe(false);
  });

  // Layer-1 round 4: with each process noting whenever it got there, a list rewritten whole
  //   on each note (read, add, write) failed in 1 of 10 runs and the pre-fix JSON array in
  //   7 of 10. Here every process waits for one start time, so the notes overlap: both
  //   failed 10 of 10 runs.
  test('notes that start at the same instant are all kept', async () => {
    const repo = mkdtempSync(join(box, 'repo-'));
    const markers = Array.from({ length: 12 }, (_, i) => {
      const d = join(repo, `pkg${i}`);
      mkdirSync(join(d, '.claude'), { recursive: true });
      const m = approvalMarkerPath(d, 'risk', 'sess-b');
      writeFileSync(m, '', 'utf8');
      return m;
    });
    const lib = join(import.meta.dir, '..', 'lib', 'approval-marker.ts');
    const startAt = Date.now() + 2_000; // after every process has loaded the module
    await Promise.all(
      markers.map(async (m) => {
        const proc = Bun.spawn(
          [
            'bun',
            '-e',
            `const { noteRiskApprovalPath } = await import(${JSON.stringify(lib)}); ` +
              `while (Date.now() < ${startAt}); noteRiskApprovalPath('sess-b', ${JSON.stringify(m)});`,
          ],
          { env: { ...process.env, TMPDIR: box }, stdout: 'ignore', stderr: 'ignore' },
        );
        await proc.exited;
      }),
    );
    withdrawRiskApprovals('sess-b', repo);
    expect(markers.filter((m) => existsSync(m))).toEqual([]);
  }, 30_000);
});
