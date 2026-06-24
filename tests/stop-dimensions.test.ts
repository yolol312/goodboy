import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
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

/** Isolated TMPDIR so file-tracker session state lives in its own sandbox. */
function newSandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = mkdtempSync(join(tmpdir(), 'vcf-stop-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-stop-cwd-'));
  tmpDirs.push(cwd);
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  return { tmp, cwd, sessionId };
}

/** Seed file-tracker session state inside the sandboxed TMPDIR.
 *  Mirrors file-tracker.ts layout: tmp/vcf-session-<sanitized>/ {turn.txt, edits.jsonl} */
function seedSession(
  tmp: string,
  sessionId: string,
  turn: number,
  editFiles: string[],
): void {
  const safe = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const dir = join(tmp, `vcf-session-${safe}`);
  mkdirSync(dir, { recursive: true });
  // Stop increments turn first, so write turn-1 so it lands on `turn` after increment.
  writeFileSync(join(dir, 'turn.txt'), String(turn - 1), 'utf8');
  const ts = new Date().toISOString();
  const lines = editFiles
    .map((f) => JSON.stringify({ file: resolve(f), turn, timestamp: ts }))
    .join('\n');
  writeFileSync(join(dir, 'edits.jsonl'), lines + '\n', 'utf8');
}

function writeReview(cwd: string, review: Record<string, unknown>): void {
  const reviewsDir = join(cwd, '.claude', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  // Filename irrelevant; findRecentReviewFile picks newest by mtime.
  writeFileSync(join(reviewsDir, 'review.json'), JSON.stringify(review), 'utf8');
}

interface StopOut {
  decision?: string;
  reason?: string;
  systemMessage?: string;
}

async function runStop(
  tmp: string,
  cwd: string,
  sessionId: string,
): Promise<StopOut> {
  const input = JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: 'Stop',
  });
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: tmp },
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(stdout) as StopOut;
  } catch {
    return {};
  }
}

const FRONTEND_FILE = '/repo/index.html';

function baseReview(cwd: string, dimensions: string[]): Record<string, unknown> {
  return {
    timestamp: new Date(Date.now() + 60000).toISOString(), // future-dated: never stale
    reviewed_files: [resolve(FRONTEND_FILE)],
    category: 'add-feature',
    findings: [],
    unknown_assumptions_checked: [],
    verdict: 'pass',
    dimensions_checked: dimensions,
  };
}

describe('Stop hook — dimension coverage enforcement', () => {
  test('BLOCKS when frontend changed but ui-ux-accessibility not in dimensions_checked', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [FRONTEND_FILE]);
    // dimensions omits ui-ux-accessibility
    writeReview(cwd, baseReview(cwd, ['plan-completeness']));
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('ui-ux-accessibility');
    expect(out.reason).toContain('재시도 1/3');
  });

  test('PASSES when all required dimensions are present', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [FRONTEND_FILE]);
    writeReview(cwd, baseReview(cwd, ['ui-ux-accessibility', 'plan-completeness']));
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
  });

  test('retry-cap escape: after MAX_RETRIES the missing dimension is allowed with systemMessage', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, [FRONTEND_FILE]);
    // Pre-seed retry counter at 2 so the next attempt (count=3) hits the cap.
    const claudeDir = join(cwd, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.vcf-retry-count.txt'), '2', 'utf8');
    writeReview(cwd, baseReview(cwd, ['plan-completeness'])); // still missing ui-ux
    const out = await runStop(tmp, cwd, sessionId);
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toContain('ui-ux-accessibility');
    expect(out.systemMessage).toContain('재시도 3회');
  });

  test('BACKWARD COMPAT: old review (no dimensions_checked) + change requiring no dimensions → no block, no crash', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    // README.md change requires zero dimensions.
    seedSession(tmp, sessionId, 1, ['/repo/README.md']);
    const old = {
      timestamp: new Date(Date.now() + 60000).toISOString(),
      reviewed_files: [resolve('/repo/README.md')],
      category: 'write-doc',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
      // no dimensions_checked field at all (old on-disk format)
    };
    writeReview(cwd, old);
    const out = await runStop(tmp, cwd, sessionId);
    // No required dimensions → no dimension block; old format must not crash Stop.
    expect(out.decision).toBeUndefined();
  });

  test('old review (no dimensions_checked) + code change requiring performance → clean block, no crash', async () => {
    const { tmp, cwd, sessionId } = newSandbox();
    seedSession(tmp, sessionId, 1, ['/repo/util.ts']);
    const old = {
      timestamp: new Date(Date.now() + 60000).toISOString(),
      reviewed_files: [resolve('/repo/util.ts')],
      category: 'refactor',
      findings: [],
      unknown_assumptions_checked: [],
      verdict: 'pass',
    };
    writeReview(cwd, old);
    const out = await runStop(tmp, cwd, sessionId);
    // util.ts requires "performance"; old review lacks it → clean block (proves no crash + sane msg).
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('performance');
  });
});
