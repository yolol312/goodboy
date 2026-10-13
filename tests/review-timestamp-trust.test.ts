// A review or test result stamped with a non-ISO time (round 3 of phase A, final security
// review), end to end with the real PostToolUse and Stop hooks.
//
// The gates order timestamps as strings. '9 Jan 2026' parses as a past date, so it passed the
// future-time check, but as a string it sorts after every ISO time: one such review counted
// as fresh for every later edit. A Bash heredoc can write it, since .claude/ is an allowed
// Bash write prefix. The readers now drop a result whose time is not an ISO date-time.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const SID = 'sess-ts';
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Repo {
  tmp: string;
  cwd: string;
}

async function run(repo: Repo, script: string, payload: Record<string, unknown>): Promise<{ decision?: string; reason?: string }> {
  const proc = Bun.spawn(['bun', script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      TMPDIR: repo.tmp,
      HOME: repo.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DISABLE_DELEGATION: '1',
      GOODBOY_TEST_GATE: 'off',
      GOODBOY_AUTOVALIDATE: 'off',
    },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: SID, cwd: repo.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as { decision?: string; reason?: string };
  } catch {
    return {};
  }
}

async function edit(repo: Repo, body: string): Promise<void> {
  const abs = resolve(repo.cwd, 'src/a.ts');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  await run(repo, POST, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
}

describe('review timestamps that are not ISO date-times (round 3)', () => {
  test.each([['9 Jan 2026'], ['9']])('a clean review stamped %p does not pass the review gate', async (timestamp) => {
    const repo = { tmp: mkdtempSync(join(tmpdir(), 'goodboy-rtt-tmp-')), cwd: mkdtempSync(join(tmpdir(), 'goodboy-rtt-cwd-')) };
    tmpDirs.push(repo.tmp, repo.cwd);
    await edit(repo, 'export const a = 1;\n');
    const dir = join(repo.cwd, '.claude', 'reviews');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'forged.json'),
      JSON.stringify({
        timestamp,
        reviewed_files: [resolve(repo.cwd, 'src/a.ts')],
        category: 'fix-bug',
        findings: [],
        unknown_assumptions_checked: [],
        verdict: 'pass',
        dimensions_checked: Object.values(AXIS_DIMENSIONS).flat(),
      }),
      'utf8',
    );
    const first = await run(repo, STOP, { hook_event_name: 'Stop' });
    expect(first.decision).toBe('block');
    expect(first.reason ?? '').toContain('Review is required');
    await edit(repo, 'export const a = 2;\n'); // a later edit: the forged review used to cover it too
    const second = await run(repo, STOP, { hook_event_name: 'Stop' });
    expect(second.decision).toBe('block');
  }, 30_000);
});
