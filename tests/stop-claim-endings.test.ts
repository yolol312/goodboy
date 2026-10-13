// Layer 0 recognizes `file:line` citations that end in "?", "!", ":<col>" or Hangul, and
// resolves bare file names in deep package trees — end to end through the real Stop hook.
//
// Layer-1 test run: "Is the bug at src/nope.ts:42?" was not recognized, so the user's
// question was not excluded and the honest answer "There is no src/nope.ts:42 in this
// repo." was blocked as a missing file. The same ending let a hallucinated citation in an
// answer through. Hallucination-axis review: a walk depth limit of 12 marked the file-name
// index of a Java/Maven tree incomplete, so every bare name there was "could not resolve".
// No lib API is imported, so the file also runs against older trees (red runs).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STOP = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
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

interface Box {
  tmp: string;
  cwd: string;
}

function newBox(): Box {
  const tmp = mkdtempSync(join(tmpdir(), 'goodboy-cle-tmp-'));
  tmpDirs.push(tmp);
  const cwd = mkdtempSync(join(tmpdir(), 'goodboy-cle-cwd-'));
  tmpDirs.push(cwd);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'a.ts'), 'a\nb\nc\n', 'utf8');
  return { tmp, cwd };
}

/** One answered prompt; `answer` is the latest assistant text. */
function transcript(box: Box, user: string, answer: string): string {
  const path = join(box.tmp, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: user } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } }),
      JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
    ].join('\n') + '\n',
    'utf8',
  );
  return path;
}

async function stop(box: Box, user: string, answer: string): Promise<{ decision?: string; reason?: string }> {
  const proc = Bun.spawn(['bun', STOP], {
    cwd: box.cwd,
    env: {
      ...process.env,
      TMPDIR: box.tmp,
      HOME: box.tmp,
      GOODBOY_TEST_GATE: 'off',
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_DISABLE_DELEGATION: '1',
    },
    stdin: new TextEncoder().encode(
      JSON.stringify({
        session_id: `sess-${Math.random().toString(36).slice(2)}`,
        cwd: box.cwd,
        hook_event_name: 'Stop',
        transcript_path: transcript(box, user, answer),
      }),
    ),
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

describe("layer 0 — a user's citation ending in ? or Hangul is the user's, not the answer's", () => {
  test('an honest "no such file" answer to a question ending in "?" passes', async () => {
    const box = newBox();
    const out = await stop(box, 'Is the bug at src/nope.ts:42?', 'There is no src/nope.ts:42 in this repo.');
    expect(out.decision).toBeUndefined();
  }, 30_000);

  test('the same for a question ending in a Hangul particle', async () => {
    const box = newBox();
    const out = await stop(box, 'src/nope.ts:42에서 에러가 나요', 'src/nope.ts:42 는 이 저장소에 없습니다.');
    expect(out.decision).toBeUndefined();
  }, 30_000);

  test('control: the same answer, unprompted, is a missing file', async () => {
    const box = newBox();
    const out = await stop(box, 'Where is the bug?', 'There is no src/nope.ts:42 in this repo.');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/nope.ts:42 — no such file');
  }, 30_000);
});

describe('layer 0 — a hallucinated citation in the answer is caught whatever ends it', () => {
  for (const answer of [
    'Could it be src/ghost.ts:12?',
    'It crashes at src/ghost.ts:12!',
    'src/ghost.ts:12:5 throws a TypeError.',
    'src/ghost.ts:12에서 터집니다.',
  ]) {
    test(JSON.stringify(answer), async () => {
      const box = newBox();
      const out = await stop(box, 'Why does it crash?', answer);
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('src/ghost.ts:12 — no such file');
    }, 30_000);
  }

  test('a real file and line with the same endings passes', async () => {
    const box = newBox();
    const out = await stop(box, 'Why does it crash?', 'Is it src/a.ts:2? Yes: src/a.ts:3! Also src/a.ts:1:4에서.');
    expect(out.decision).toBeUndefined();
  }, 30_000);
});

describe('layer 0 — bare file names in a deep package tree', () => {
  const PKG = ['src', 'main', 'java', 'com', 'acme', 'shop', 'order', 'api', 'v2', 'internal', 'web', 'dto', 'view', 'model', 'detail', 'item', 'line', 'price'];

  test('a unique name 18 levels down resolves, and a line past its end is caught', async () => {
    const box = newBox();
    const deep = join(box.cwd, ...PKG);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'OrderView.java'), 'class OrderView {\n  int x;\n}\n', 'utf8');

    expect((await stop(box, 'Where is the view?', 'OrderView.java:2 holds the field.')).decision).toBeUndefined();
    const wrong = await stop(box, 'Where is the view?', 'OrderView.java:40 holds the field.');
    expect(wrong.decision).toBe('block');
    expect(wrong.reason).toContain('OrderView.java:40 — the file has only 3 lines');
  }, 30_000);

  test('a tree deeper than the walk limit leaves a missing name unresolvable, never a missing file', async () => {
    const box = newBox();
    const tooDeep = join(box.cwd, ...Array.from({ length: 40 }, (_, i) => `d${i}`));
    mkdirSync(tooDeep, { recursive: true });
    writeFileSync(join(tooDeep, 'Deep.java'), 'class Deep {}\n', 'utf8');

    const out = await stop(box, 'Where is it?', 'Missing.java:1 does it.');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Missing.java:1 — could not resolve this file name; cite the repo-relative path');
    expect(out.reason ?? '').not.toContain('no such file');
  }, 30_000);
});
