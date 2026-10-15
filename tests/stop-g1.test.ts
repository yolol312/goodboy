import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Track G, step G1 in the Stop hook: the review/test gates wait for running agents (G0 M10),
// and effort advice (§10.5).

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-stopg1-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const sid = `stopg1-${Math.random().toString(36).slice(2)}`;
  const dir = join(base, `goodboy-session-${sid}`);
  mkdirSync(dir, { recursive: true });
  const edit = (rel: string) => {
    writeFileSync(join(cwd, rel), 'x\n');
    appendFileSync(join(dir, 'edits.jsonl'), JSON.stringify({ file: join(cwd, rel), turn: 0, timestamp: new Date().toISOString() }) + '\n');
  };
  const stop = async (payload: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, hook_event_name: 'Stop', ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_TEST_GATE: 'off', GOODBOY_CLAIM_GATE: 'off', ...env },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    return out;
  };
  return { cwd, sid, dir, edit, stop };
}

const RUNNING = [{ id: 'a1', type: 'subagent', status: 'running', description: 'review', agent_type: 'goodboy:review-changes' }];

describe('gates wait for running agents', () => {
  test('an unreviewed edit blocks, but not while an agent runs', async () => {
    const s = setup();
    s.edit('src/a.ts');
    expect((await s.stop({ background_tasks: RUNNING })).decision).toBeUndefined();
    expect((await s.stop({ background_tasks: [] })).decision).toBe('block');
  });

  test('a background shell (a dev server) does not defer the gates', async () => {
    const s = setup();
    s.edit('src/a.ts');
    const shell = [{ id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' }];
    expect((await s.stop({ background_tasks: shell })).decision).toBe('block');
  });

  test('finished agents do not defer', async () => {
    const s = setup();
    s.edit('src/a.ts');
    expect((await s.stop({ background_tasks: [{ ...RUNNING[0], status: 'completed' }] })).decision).toBe('block');
  });
});

describe('review required, no review at all', () => {
  test("blocks on every Stop, tells the user from the 2nd; the user's marker passes once", async () => {
    const s = setup();
    s.edit('src/a.ts');
    const first = await s.stop();
    expect(first.decision).toBe('block');
    expect(String(first.reason)).toContain('(block 1)');
    expect(first.systemMessage ?? '').not.toContain('goodboy-stop-approved');
    const second = await s.stop();
    expect(String(second.reason)).toContain('(block 2)');
    expect(String(second.systemMessage)).toContain(`.goodboy-stop-approved-${s.sid.slice(0, 8)}.txt`);
    expect((await s.stop()).decision).toBe('block'); // no count-based pass
    mkdirSync(join(s.cwd, '.claude'), { recursive: true });
    writeFileSync(join(s.cwd, '.claude', `.goodboy-stop-approved-${s.sid.slice(0, 8)}.txt`), '');
    expect((await s.stop()).decision).toBeUndefined();
    // The cursor moved: the same edit no longer blocks; a new one does.
    expect((await s.stop()).decision).toBeUndefined();
  });
});

describe('round-1 review fixes', () => {
  const marker = (s: ReturnType<typeof setup>) => join(s.cwd, '.claude', `.goodboy-stop-approved-${s.sid.slice(0, 8)}.txt`);

  test("the user's review override restarts every review block count", async () => {
    const s = setup();
    s.edit('src/a.ts');
    writeFileSync(join(s.dir, '.goodboy-retry-count.txt'), '2'); // left by earlier high-severity blocks
    writeFileSync(join(s.dir, '.goodboy-review-validate-retry-count.txt'), '2'); // and "no review" blocks
    mkdirSync(join(s.cwd, '.claude'), { recursive: true });
    writeFileSync(marker(s), '');
    expect((await s.stop()).decision).toBeUndefined();
    expect(require('node:fs').existsSync(join(s.dir, '.goodboy-retry-count.txt'))).toBe(false);
    expect(require('node:fs').existsSync(join(s.dir, '.goodboy-review-validate-retry-count.txt'))).toBe(false);
  });

  test('an accepted review restarts the review-validation block count too (refactoring review)', async () => {
    const s = setup();
    s.edit('notes.md'); // a doc: the hallucination axis alone covers it
    writeFileSync(join(s.dir, '.goodboy-review-validate-retry-count.txt'), '2');
    mkdirSync(join(s.cwd, '.claude', 'reviews'), { recursive: true });
    writeFileSync(
      join(s.cwd, '.claude', 'reviews', 'r.json'),
      JSON.stringify({
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        reviewed_files: [join(s.cwd, 'notes.md')],
        category: 'write-doc',
        findings: [],
        unknown_assumptions_checked: [],
        verdict: 'pass',
        dimensions_checked: ['hallucination'],
      }),
    );
    expect((await s.stop()).decision).toBeUndefined();
    expect(require('node:fs').existsSync(join(s.dir, '.goodboy-review-validate-retry-count.txt'))).toBe(false);
  });

  test('a docs/ file that is not text (a diagram) needs no test (one doc rule for all gates)', async () => {
    const s = setup();
    mkdirSync(join(s.cwd, 'docs'), { recursive: true });
    mkdirSync(join(s.cwd, 'tests'), { recursive: true });
    writeFileSync(join(s.cwd, 'tests', 'a.test.ts'), 'test("a", () => {});\n'); // test infrastructure is present
    s.edit('docs/arch.svg');
    const out = await s.stop({}, { GOODBOY_TEST_GATE: 'on' });
    expect(String(out.reason ?? '')).not.toContain('테스트 게이트');
  });

  test('GOODBOY_AUTOVALIDATE=off lifts the validation gate it names', async () => {
    const s = setup();
    writeFileSync(join(s.dir, '.goodboy-validation-failed.json'), JSON.stringify({ sessionId: s.sid, timestamp: new Date().toISOString(), commands: ['bun run typecheck'] }));
    expect(String((await s.stop()).reason ?? '')).toContain('자동 검증이 실패한 상태');
    expect(String((await s.stop({}, { GOODBOY_AUTOVALIDATE: 'off' })).reason ?? '')).not.toContain('자동 검증');
  });

  test('a BLOCKED result accepted on the stop_hook_active path tells the user too', async () => {
    const s = setup();
    s.edit('src/a.ts');
    mkdirSync(join(s.cwd, 'tests'), { recursive: true });
    writeFileSync(join(s.cwd, 'tests', 'a.test.ts'), 'test("a", () => {});\n');
    mkdirSync(join(s.cwd, '.claude', 'tests'), { recursive: true });
    writeFileSync(
      join(s.cwd, '.claude', 'tests', 'b.json'),
      JSON.stringify({
        timestamp: new Date(Date.now() + 60_000).toISOString(),
        tested_files: [join(s.cwd, 'src', 'a.ts')],
        category: 'x',
        test_files: [],
        environment: { mode: 'none' },
        suites: [],
        acceptance: [],
        verdict: 'blocked',
        blocked: { reason: 'no container runtime on this host', evidence: [{ command: 'docker info', output: 'command not found' }] },
      }),
    );
    const out = await s.stop({ stop_hook_active: true }, { GOODBOY_TEST_GATE: 'on' });
    expect(String(out.systemMessage ?? '')).toContain('테스트를 실행하지 못해');
  });
});

describe('effort advice', () => {
  test('a workflow command above the current effort, shown once', async () => {
    const s = setup();
    writeFileSync(
      join(s.dir, '.goodboy-session-state.json'),
      JSON.stringify({ category: 'migrate', risk: 'medium', turn: 0, updatedAt: new Date().toISOString(), sessionId: s.sid }),
    );
    mkdirSync(join(s.cwd, '.claude'), { recursive: true });
    writeFileSync(
      join(s.cwd, '.claude', '.goodboy-session-state.json'),
      JSON.stringify({ category: 'migrate', risk: 'medium', turn: 0, updatedAt: new Date().toISOString(), sessionId: s.sid }),
    );
    const first = await s.stop({ effort: { level: 'high' } });
    expect(String(first.systemMessage)).toContain('/effort xhigh');
    const second = await s.stop({ effort: { level: 'high' } });
    expect(String(second.systemMessage ?? '')).not.toContain('/effort');
  });

  test('a doc-only change at high gets a lower suggestion; GOODBOY_EFFORT_ADVICE=off hides it', async () => {
    const off = setup();
    mkdirSync(join(off.cwd, 'docs'));
    off.edit('docs/guide.md');
    const hidden = await off.stop({ effort: { level: 'high' }, background_tasks: RUNNING }, { GOODBOY_EFFORT_ADVICE: 'off' });
    expect(String(hidden.systemMessage ?? '')).not.toContain('/effort');

    const s = setup();
    mkdirSync(join(s.cwd, 'docs'));
    s.edit('docs/guide.md');
    const out = await s.stop({ effort: { level: 'high' }, background_tasks: RUNNING });
    expect(String(out.systemMessage)).toContain('/effort medium');
  });

  test('a change that also edits a code file is not doc-only', async () => {
    const s = setup();
    mkdirSync(join(s.cwd, 'docs'));
    s.edit('docs/guide.md');
    s.edit('src/a.ts');
    const out = await s.stop({ effort: { level: 'high' }, background_tasks: RUNNING });
    expect(String(out.systemMessage ?? '')).not.toContain('/effort');
  });

  test('one rule denying twice since the last advice suggests one level up, once', async () => {
    const s = setup();
    const ev = (gate: string, decision: string) =>
      JSON.stringify({ ts: new Date(Date.now() - 60_000).toISOString(), gate, decision }) + '\n';
    appendFileSync(join(s.dir, 'gate-log.jsonl'), ev('skill-rule', 'deny') + ev('outward', 'deny') + ev('skill-rule', 'deny'));
    const first = await s.stop({ effort: { level: 'medium' } });
    expect(String(first.systemMessage)).toContain('/effort high');
    expect(String(first.systemMessage)).toContain('두 번 막혔어요');
    // The same denials are before the advice now, so they do not count again: not at the
    // same effort, and not after the user followed it (no push on to xhigh).
    const second = await s.stop({ effort: { level: 'medium' } });
    expect(String(second.systemMessage ?? '')).not.toContain('/effort');
    const followed = await s.stop({ effort: { level: 'high' } });
    expect(String(followed.systemMessage ?? '')).not.toContain('/effort');
    // Warnings do not count as blocks.
    const w = setup();
    appendFileSync(join(w.dir, 'gate-log.jsonl'), ev('skill-rule', 'warn') + ev('skill-rule', 'warn'));
    expect(String((await w.stop({ effort: { level: 'medium' } })).systemMessage ?? '')).not.toContain('/effort');
  });

  test('no effort in the payload, no advice', async () => {
    const s = setup();
    mkdirSync(join(s.cwd, 'docs'));
    s.edit('docs/guide.md');
    expect(String((await s.stop({ background_tasks: RUNNING })).systemMessage ?? '')).not.toContain('/effort');
  });
});
