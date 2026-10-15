// The Stop's assumption-review link (A2) with English and described labels (stabilization
// plan F3), through the real PostToolUse and Stop hooks. tests/stop-assumptions-gate.test.ts
// covers `## 추론` with bare labels; tests/reasoning-parser.test.ts the parser alone.
//
// A declared assumption requires the review to have checked assumptions
// (unknown_assumptions_checked), also when it is declared under `## Rationale` /
// `### Assumptions (unverified)` or under the skill template's `### 가정 (정보 부족)`.
// Before F3, both read as no assumptions, so the link never fired.
// No lib API is imported, so the file also runs against older trees (red runs).

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const LINK = 'guess-review link';
const DOC = 'README.md'; // no required review dimensions: the assumption link is the gate under test
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-sra-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-sra-cwd-'));
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

/** Edits the doc through PostToolUse and leaves a review of it, newer than the edit. */
async function editAndReview(repo: Repo, sid: string, assumptionsChecked: boolean): Promise<void> {
  const abs = resolve(repo.cwd, DOC);
  writeFileSync(abs, '# Setup\n', 'utf8');
  await run(repo, POST, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
  const dir = join(repo.cwd, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'review.json'),
    JSON.stringify({
      timestamp: new Date(Date.now() + 60_000).toISOString(),
      reviewed_files: [abs],
      category: 'write-doc',
      findings: [],
      unknown_assumptions_checked: assumptionsChecked
        ? [{ assumption: 'the CI image ships bun 1.3', reasonable: true, note: 'the workflow pins it' }]
        : [],
      verdict: 'pass',
      dimensions_checked: [],
    }),
    'utf8',
  );
}

/** A transcript whose last assistant text is `text` (with a low-usage line for the context gate). */
function transcript(repo: Repo, text: string): string {
  const path = join(repo.cwd, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
    JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

async function stop(repo: Repo, sid: string, transcriptPath: string, active = false): Promise<HookOut> {
  return run(repo, STOP, {
    session_id: sid,
    hook_event_name: 'Stop',
    transcript_path: transcriptPath,
    ...(active ? { stop_hook_active: true } : {}),
  });
}

function acceptedOnStopActive(repo: Repo, sid: string): boolean {
  const p = join(repo.tmp, `goodboy-session-${sid}`, 'gate-log.jsonl');
  return existsSync(p) && readFileSync(p, 'utf8').includes('accept-on-stop-active');
}

// One assumption, no speculation: the assumption alone has to trigger the link.
const RATIONALE = [
  'Updated the setup steps.',
  '',
  '## Rationale',
  '### Facts: verified',
  '- the setup section lists three steps',
  '### Judgments (from the facts)',
  '- the order of the steps matters',
  '### Assumptions (unverified)',
  '- the CI image ships bun 1.3',
].join('\n');

const TEMPLATE_KO = [
  '설치 절차를 고쳤습니다.',
  '',
  '## 근거',
  '### 사실 (검증됨)',
  '- 설치 절이 세 단계로 되어 있다',
  '### 가정 (정보 부족)',
  '- CI 이미지에 bun 1.3이 있다',
].join('\n');

describe('the assumption-review link with English and described labels (F3)', () => {
  test('an assumption under "## Rationale / ### Assumptions (unverified)" needs a review that checked it', async () => {
    const repo = newRepo();
    await editAndReview(repo, 'sess-en', false);
    const out = await stop(repo, 'sess-en', transcript(repo, RATIONALE));
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain(LINK);
    expect(out.reason ?? '').toContain('declared 1 guesses or assumptions');
  }, 30_000);

  test('the same section passes once the review checked the assumption', async () => {
    const repo = newRepo();
    await editAndReview(repo, 'sess-en-ok', true);
    const out = await stop(repo, 'sess-en-ok', transcript(repo, RATIONALE));
    expect(out.decision).toBeUndefined();
    expect(`${out.reason ?? ''}${out.systemMessage ?? ''}`).not.toContain(LINK);
  }, 30_000);

  test('an assumption under the skill template\'s "### 가정 (정보 부족)" needs it too', async () => {
    const repo = newRepo();
    await editAndReview(repo, 'sess-ko', false);
    const out = await stop(repo, 'sess-ko', transcript(repo, TEMPLATE_KO));
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain(LINK);
    expect(out.reason ?? '').toContain('declared 1 guesses or assumptions');
  }, 30_000);

  // Round 3 (security review): the rationale gate asks for `- 없음` in an empty category.
  //   Once F3 parsed the template's labels, those placeholders counted as 2 declared
  //   unknowns and blocked a clean review.
  test('placeholder items alone ("- 없음") declare nothing, at the full Stop and at the accept', async () => {
    const placeholders = [
      '설치 절차를 고쳤습니다.',
      '',
      '## 근거',
      '### 사실 (검증됨)',
      '- 설치 절이 세 단계로 되어 있다',
      '### 판단 (확인된 사실에서 나온 결론)',
      '- 순서를 바꾸면 안 된다',
      '### 가정 (정보 부족)',
      '- 없음',
      '### 추측 ⚠️ (근거 약함)',
      '- 없음',
    ].join('\n');
    const full = newRepo();
    await editAndReview(full, 'sess-none', false);
    const out = await stop(full, 'sess-none', transcript(full, placeholders));
    expect(out.decision).toBeUndefined();
    expect(`${out.reason ?? ''}${out.systemMessage ?? ''}`).not.toContain(LINK);

    const active = newRepo();
    await editAndReview(active, 'sess-none-active', false);
    expect((await stop(active, 'sess-none-active', transcript(active, placeholders), true)).decision).toBeUndefined();
    expect(acceptedOnStopActive(active, 'sess-none-active')).toBe(true);
  }, 30_000);

  test('a real assumption next to a placeholder still counts, once', async () => {
    const repo = newRepo();
    await editAndReview(repo, 'sess-mixed', false);
    const out = await stop(repo, 'sess-mixed', transcript(repo, `${TEMPLATE_KO}\n### 추측 ⚠️ (근거 약함)\n- 없음`));
    expect(out.decision).toBe('block');
    expect(out.reason ?? '').toContain('declared 1 guesses or assumptions');
  }, 30_000);

  test('the stop_hook_active accept is held for it, and the next full Stop blocks', async () => {
    const repo = newRepo();
    await editAndReview(repo, 'sess-active', false);
    const tp = transcript(repo, TEMPLATE_KO);
    expect((await stop(repo, 'sess-active', tp, true)).decision).toBeUndefined(); // never blocks here
    expect(acceptedOnStopActive(repo, 'sess-active')).toBe(false);
    const next = await stop(repo, 'sess-active', tp);
    expect(next.decision).toBe('block');
    expect(next.reason ?? '').toContain(LINK);
  }, 30_000);
});
