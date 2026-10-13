// Foreign high findings on the review gate's escapes (stabilization plan A3, round 3), end to
// end with the real PostToolUse and Stop hooks.
//
// High findings about files outside this session's edit history do not block; the Stop
// shows them once, when the review cursor moves. Only the passes showed them. The four
// escapes also move the cursor, and the next Stop starts after it, so a foreign high
// finding written while the session was blocked was never shown (refactoring and
// security reviews). The high-severity and dimension escapes also left the status
// snapshot at "review pending" after moving the cursor.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const ALL_DIMENSIONS = Object.values(AXIS_DIMENSIONS).flat();
const FOREIGN_ISSUE = 'SQL built from input';
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Repo {
  tmp: string;
  cwd: string;
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

function newRepo(): Repo {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-sefn-tmp-'));
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-sefn-cwd-'));
  tmpDirs.push(tmp, cwd);
  return { tmp, cwd };
}

async function run(repo: Repo, script: string, payload: Record<string, unknown>): Promise<HookOut> {
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
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: repo.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as HookOut;
  } catch {
    return {};
  }
}

const SID = 'sess-escape';

async function editA(repo: Repo): Promise<void> {
  const abs = resolve(repo.cwd, 'src/a.ts');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const a = 1;\n', 'utf8');
  await run(repo, POST, { session_id: SID, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
}

function writeReview(repo: Repo, name: string, review: Record<string, unknown>): void {
  const dir = join(repo.cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      timestamp: new Date(Date.now() + 30_000).toISOString(),
      category: 'fix-bug',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      dimensions_checked: ALL_DIMENSIONS,
      ...review,
    }),
    'utf8',
  );
}

/** Another session's review of a file this session never edited, with a high finding. */
function writeForeignReview(repo: Repo): void {
  const other = resolve(repo.cwd, 'src/other.ts');
  writeReview(repo, 'other.json', {
    reviewed_files: [other],
    findings: [{ file: other, issue: FOREIGN_ISSUE, severity: 'high' }],
    verdict: 'needs-changes',
  });
}

function transcript(repo: Repo, text: string): string {
  const path = join(repo.tmp, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

/** Two blocks, then the escape. */
async function stopUntilEscape(repo: Repo, transcriptPath?: string): Promise<HookOut> {
  const payload = { session_id: SID, hook_event_name: 'Stop', ...(transcriptPath ? { transcript_path: transcriptPath } : {}) };
  for (let i = 1; i <= 2; i++) {
    const blocked = await run(repo, STOP, payload);
    expect(blocked.decision).toBe('block');
    expect(blocked.reason ?? '').not.toContain(FOREIGN_ISSUE); // a note for the user, not a block reason
  }
  const escaped = await run(repo, STOP, payload);
  expect(escaped.decision).toBeUndefined();
  return escaped;
}

function reviewPending(repo: Repo): unknown {
  const status = JSON.parse(readFileSync(join(repo.tmp, `goodboy-session-${SID}`, 'status.json'), 'utf8')) as {
    reviewPending?: boolean;
  };
  return status.reviewPending;
}

function expectForeignNote(out: HookOut): void {
  expect(out.systemMessage ?? '').toContain('사용자 확인이 필요합니다');
  expect(out.systemMessage ?? '').toContain(`이 세션의 편집 기록에 없는 파일에 대한 high 지적(차단하지 않음): [high]`);
  expect(out.systemMessage ?? '').toContain(FOREIGN_ISSUE);
}

describe('foreign high findings on the escapes (A3, round 3)', () => {
  test('the high-severity escape', async () => {
    const repo = newRepo();
    await editA(repo);
    const a = resolve(repo.cwd, 'src/a.ts');
    writeReview(repo, 'a.json', {
      reviewed_files: [a],
      findings: [{ file: a, issue: 'token logged', severity: 'high' }],
      verdict: 'needs-changes',
    });
    writeForeignReview(repo);
    const out = await stopUntilEscape(repo);
    expectForeignNote(out);
    expect(out.systemMessage ?? '').toContain('token logged');
    expect(reviewPending(repo)).toBe(false);
  }, 60_000);

  test('the review-validation escape', async () => {
    const repo = newRepo();
    await editA(repo);
    writeForeignReview(repo); // the only review: src/a.ts stays unreviewed
    expectForeignNote(await stopUntilEscape(repo));
  }, 60_000);

  test('the assumption-review escape', async () => {
    const repo = newRepo();
    await editA(repo);
    writeReview(repo, 'a.json', { reviewed_files: [resolve(repo.cwd, 'src/a.ts')] });
    writeForeignReview(repo);
    const tp = transcript(repo, ['Done.', '', '## 근거', '### 사실', '- a is exported', '### 가정', '- callers pass a string'].join('\n'));
    expectForeignNote(await stopUntilEscape(repo, tp));
  }, 60_000);

  test('the dimension escape', async () => {
    const repo = newRepo();
    await editA(repo);
    writeReview(repo, 'a.json', { reviewed_files: [resolve(repo.cwd, 'src/a.ts')], dimensions_checked: ['performance'] });
    writeForeignReview(repo);
    const out = await stopUntilEscape(repo);
    expectForeignNote(out);
    expect(reviewPending(repo)).toBe(false);
  }, 60_000);
});
