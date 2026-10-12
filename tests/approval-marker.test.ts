// lib/approval-marker.ts — per-session approval marker names (A3).

import { describe, expect, test } from 'bun:test';
import { approvalMarkerPath, approvalMarkerRelPath, sessionTag } from '../lib/approval-marker';

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
