// Which review findings a session's Stop sees (stabilization plan A3, round 2), end to end
// with the real PostToolUse and Stop hooks. Complements tests/a3-round2-regressions.test.ts
// (F7, H1) and tests/stop-session-findings.test.ts:
//
//   - a foreign high finding is shown only when its review is newer than the session's
//     first edit (and its cursor): not one from before the session's work began, but one
//     written between its first and its last edit;
//   - supersession runs over every review: a newer review of the flagged file clears a
//     finding even when that review names none of the session's files. Since round 3 only
//     when a file the finding's review covered changed after it, and reviews written after
//     the change cover every axis of that review (no dimensions: the hallucination axis);
//   - the stop_hook_active accept (the usual end of "block -> review -> turn end") shows
//     the foreign high findings too; it moves the cursor, so the full Stop never would.
//
// No lib API is imported, so the file also runs against older trees (red runs).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AXIS_DIMENSIONS } from '../lib/review-dimensions';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-ffw-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-ffw-cwd-'));
  tmpDirs.push(cwd);
  return { tmp, cwd };
}

interface HookOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
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

async function edit(repo: Repo, sessionId: string, rel: string): Promise<void> {
  const abs = resolve(repo.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(repo, POST, { session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
}

async function stop(repo: Repo, sessionId: string, active = false): Promise<HookOut> {
  return run(repo, STOP, { session_id: sessionId, hook_event_name: 'Stop', ...(active ? { stop_hook_active: true } : {}) });
}

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

function high(repo: Repo, rel: string, issue: string): Record<string, unknown> {
  return { file: resolve(repo.cwd, rel), issue, severity: 'high' };
}

const ALL_DIMENSIONS = Object.values(AXIS_DIMENSIONS).flat();

/** A review of `files` stamped `timestamp` (every dimension checked unless `dims` says). */
function writeReview(
  repo: Repo,
  name: string,
  files: string[],
  findings: Array<Record<string, unknown>>,
  timestamp: string,
  dims: string[] = ALL_DIMENSIONS,
): void {
  const dir = join(repo.cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      timestamp,
      reviewed_files: files.map((f) => resolve(repo.cwd, f)),
      category: 'fix-bug',
      findings,
      unknown_assumptions_checked: [],
      verdict: findings.length > 0 ? 'needs-changes' : 'pass',
      dimensions_checked: dims,
    }),
    'utf8',
  );
}

function gateLog(repo: Repo, sessionId: string): string {
  const p = join(repo.tmp, `goodboy-session-${sessionId}`, 'gate-log.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

const text = (o: HookOut): string => `${o.reason ?? ''}\n${o.systemMessage ?? ''}`;

describe("foreign high findings and the session's first edit (A3)", () => {
  test('one from before the first edit is not shown; one from after it is', async () => {
    const repo = newRepo();
    // Another session's review, finished before this session edited anything.
    writeReview(repo, 'before.json', ['src/old.ts'], [high(repo, 'src/old.ts', 'secret in the old log line')], iso(-60_000));
    await Bun.sleep(20);
    await edit(repo, 'sess-a', 'src/a.ts');
    await Bun.sleep(20);
    writeReview(repo, 'after.json', ['src/other.ts'], [high(repo, 'src/other.ts', 'SQL built from input')], iso(0));
    writeReview(repo, 'a.json', ['src/a.ts'], [], iso(60_000));

    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('SQL built from input');
    expect(out.systemMessage ?? '').not.toContain('secret in the old log line');
  }, 30_000);

  test('one written between the first and the last edit is shown', async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await Bun.sleep(20);
    writeReview(repo, 'other.json', ['src/other.ts'], [high(repo, 'src/other.ts', 'SQL built from input')], iso(0));
    await Bun.sleep(20);
    await edit(repo, 'sess-a', 'src/b.ts'); // the last edit comes after that review
    writeReview(repo, 'ab.json', ['src/a.ts', 'src/b.ts'], [], iso(60_000));

    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage ?? '').toContain('SQL built from input');
  }, 30_000);
});

describe('supersession across every review (A3, rule from round 3)', () => {
  /** util.ts exists before the review that flags it; the session edits only a.ts. */
  async function flaggedUtil(repo: Repo, dims: string[] = ALL_DIMENSIONS): Promise<void> {
    writeUtil(repo, 'export const util = (x: string) => x.length;\n', -60_000);
    await edit(repo, 'sess-a', 'src/a.ts');
    await Bun.sleep(20);
    // The review of this change flagged a caller in a file the session did not edit.
    writeReview(repo, 'a.json', ['src/a.ts'], [high(repo, 'src/util.ts', 'caller passes null')], iso(0), dims);
    if (dims !== ALL_DIMENSIONS) writeReview(repo, 'a-all.json', ['src/a.ts'], [], iso(0)); // the other axes, clean
    const blocked = await stop(repo, 'sess-a');
    expect(blocked.decision).toBe('block');
    expect(blocked.reason ?? '').toContain('caller passes null');
  }

  /** Writes util.ts with its mtime `offsetMs` from now. Set explicitly: on a filesystem that
   *  keeps whole seconds, a write right after the review could carry an older time. */
  function writeUtil(repo: Repo, body: string, offsetMs: number): void {
    const file = join(repo.cwd, 'src', 'util.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf8');
    const at = new Date(Date.now() + offsetMs);
    utimesSync(file, at, at);
  }
  const FIXED = 'export const util = (x: string | null) => x?.length ?? 0;\n';

  test("a newer review of the fixed file clears this session's finding, though it names none of the session's files", async () => {
    const repo = newRepo();
    await flaggedUtil(repo);
    // Someone fixed util.ts and had it re-reviewed: a newer review of util.ts alone.
    writeUtil(repo, FIXED, 10_000);
    writeReview(repo, 'util.json', ['src/util.ts'], [], iso(60_000));
    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBeUndefined();
    expect(text(out)).not.toContain('caller passes null');
  }, 30_000);

  test('a re-review without a change to the file does not clear it', async () => {
    const repo = newRepo();
    await flaggedUtil(repo);
    writeReview(repo, 'util.json', ['src/util.ts'], [], iso(60_000));
    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('caller passes null');
  }, 30_000);

  test("another axis's newer review does not clear a security finding; a security re-review does", async () => {
    const repo = newRepo();
    await flaggedUtil(repo, AXIS_DIMENSIONS.security);
    writeUtil(repo, FIXED, 10_000);
    writeReview(repo, 'util-ref.json', ['src/util.ts'], [], iso(30_000), AXIS_DIMENSIONS.refactoring);
    const still = await stop(repo, 'sess-a');
    expect(still.decision).toBe('block');
    expect(still.reason ?? '').toContain('caller passes null');
    expect(still.reason ?? '').toContain('(security)'); // the axis to re-run

    // Fewer dimensions than the first review: the security axis lists what util.ts alone triggers.
    writeReview(repo, 'util-sec.json', ['src/util.ts'], [], iso(60_000), ['security-secrets']);
    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBeUndefined();
    expect(text(out)).not.toContain('caller passes null');
  }, 30_000);

  // Round 3 (final security and hallucination reviews, high): the hallucination axis writes no
  //   dimensions, so "covers the same dimensions" held for any review. A touch, plus the
  //   batch's other axes written after the hallucination review, cleared its high finding.
  test('a hallucination finding survives a touch and the batch’s other axes; a hallucination re-review after the change clears it', async () => {
    const repo = newRepo();
    await flaggedUtil(repo, []);
    writeReview(repo, 'util-batch.json', ['src/util.ts'], [], iso(5_000)); // the other axes, same batch
    writeUtil(repo, 'export const util = (x: string) => x.length;\n', 10_000); // touched, not fixed
    const still = await stop(repo, 'sess-a');
    expect(still.decision).toBe('block');
    expect(still.reason ?? '').toContain('caller passes null');
    expect(still.reason ?? '').toContain('(hallucination)');

    writeReview(repo, 'util-hall.json', ['src/util.ts'], [], iso(60_000), []);
    const out = await stop(repo, 'sess-a');
    expect(out.decision).toBeUndefined();
    expect(text(out)).not.toContain('caller passes null');
  }, 30_000);
});

describe('foreign high findings at the stop_hook_active accept (A3)', () => {
  test('the accept shows them, and the next Stop does not repeat them', async () => {
    const repo = newRepo();
    await edit(repo, 'sess-a', 'src/a.ts');
    await Bun.sleep(20);
    writeReview(repo, 'other.json', ['src/other.ts'], [high(repo, 'src/other.ts', 'SQL built from input')], iso(0));
    writeReview(repo, 'a.json', ['src/a.ts'], [], iso(60_000));

    const accepted = await stop(repo, 'sess-a', true);
    expect(accepted.decision).toBeUndefined();
    expect(gateLog(repo, 'sess-a')).toContain('accept-on-stop-active');
    expect(accepted.systemMessage ?? '').toContain('SQL built from input');

    // The accept moved the cursor past that review: the next task's Stop stays quiet.
    await Bun.sleep(20);
    await edit(repo, 'sess-a', 'src/a.ts');
    writeReview(repo, 'a2.json', ['src/a.ts'], [], iso(120_000));
    const next = await stop(repo, 'sess-a');
    expect(next.decision).toBeUndefined();
    expect(text(next)).not.toContain('SQL built from input');
  }, 30_000);
});
