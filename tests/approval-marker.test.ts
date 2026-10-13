// lib/approval-marker.ts — per-session approval marker names (A3).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
