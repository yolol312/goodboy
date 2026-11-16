// Track M, M6d (§19): `runCommands` of lib/regression.ts redacts what the commands print, before the tail is cut.
// It runs real `sh -c` commands in a temp dir (no mock).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommands, STDOUT_TAIL } from '../lib/regression';

const RRN = '900101-1234567';
const MAIL = 'canary.person@corp-mail.co.kr';

describe('M6d runCommands', () => {
  test('stdout and stderr are redacted, the exit code and the program are kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm6d-run-'));
    try {
      const runs = await runCommands(dir, [`echo "mail ${MAIL}"`, `echo "rrn ${RRN}" 1>&2; exit 3`]);
      expect(runs.map((r) => r.exit_code)).toEqual([0, 3]);
      expect(runs[0]!.program).toContain('echo');
      expect(runs[0]!.output_tail).toBe('mail [redacted:email]\n');
      expect(runs[1]!.output_tail).toBe('\n[stderr]\nrrn [redacted:resident-number]\n');
      expect(JSON.stringify(runs.map((r) => r.output_tail))).not.toMatch(/canary|900101/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a value that straddles the start of the tail is dropped whole, never kept in part', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm6d-run-'));
    try {
      // 7 characters of the number fall inside the tail window.
      const after = STDOUT_TAIL - 7;
      const cmd = `printf 'x%.0s' $(seq 1 30000); printf '%s' '${RRN}'; printf 'z%.0s' $(seq 1 ${after})`;
      const [run] = await runCommands(dir, [cmd]);
      expect(run!.exit_code).toBe(0);
      expect(run!.output_tail).not.toContain('234567');
      expect(run!.output_tail.startsWith('z')).toBe(true);
      expect(run!.output_tail.length).toBeLessThanOrEqual(STDOUT_TAIL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a command that cannot start fails and has no program', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm6d-run-'));
    try {
      const [run] = await runCommands(dir, ['definitely-not-a-program-m6d']);
      expect(run!.program).toBeNull();
      expect(run!.exit_code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
