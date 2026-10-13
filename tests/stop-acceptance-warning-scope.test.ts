// When the Stop reports dev-cycle documents that yield no acceptance criteria
// (stabilization plan F2), through the real PostToolUse and Stop hooks. Complements
// tests/stop-acceptance-warning.test.ts (English documents, once per session, missing
// version key) and the readAcceptance problem block of tests/acceptance.test.ts:
//
//   - only in a session that edited code: not in a Stop without edits or with doc edits only;
//   - never with GOODBOY_TEST_GATE=off;
//   - not for a version whose folder is missing, nor for a placeholder version;
//   - a prototype that yields no criteria is reported by its path.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const WARNING = '수용 기준을';
const REVIEW_BLOCK = 'Review is required'; // proof that the Stop ran to the review gate
const UNREADABLE_UIUX = '## Pantallas\n\n| Pantalla | Tipo |\n|---|---|\n| Ajustes | nuevo |\n';
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

interface Repo {
  tmp: string;
  cwd: string;
}

function newRepo(): Repo {
  return { tmp: newDir('goodboy-aws-tmp-'), cwd: newDir('goodboy-aws-cwd-') };
}

async function run(
  repo: Repo,
  script: string,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const p = Bun.spawn(['bun', script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      TMPDIR: repo.tmp,
      HOME: repo.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_AUTOVALIDATE: 'off',
      ...extra,
    },
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: repo.cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function edit(repo: Repo, sid: string, rel: string, extra: Record<string, string> = {}): Promise<void> {
  const abs = resolve(repo.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(repo, POST, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } }, extra);
}

async function stopText(repo: Repo, sid: string, extra: Record<string, string> = {}): Promise<string> {
  const out = (await run(repo, STOP, { session_id: sid, hook_event_name: 'Stop' }, extra)) as {
    reason?: string;
    systemMessage?: string;
  };
  return `${out.reason ?? ''}\n${out.systemMessage ?? ''}`;
}

function gateLog(repo: Repo, sid: string): string {
  const p = join(repo.tmp, `goodboy-session-${sid}`, 'gate-log.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** docs/CYCLE.md plus docs/versions/v0.1/UIUX.md. */
function devCycle(cwd: string, cycle: string, uiux: string): void {
  mkdirSync(join(cwd, 'docs', 'versions', 'v0.1'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'CYCLE.md'), cycle, 'utf8');
  writeFileSync(join(cwd, 'docs', 'versions', 'v0.1', 'UIUX.md'), uiux, 'utf8');
}

/** docs/CYCLE.md plus a v0.1 prototype only. */
function prototypeOnly(cwd: string, html: string): string {
  const dir = join(cwd, 'docs', 'versions', 'v0.1', 'prototype');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, 'docs', 'CYCLE.md'), '- **현재 버전**: v0.1\n', 'utf8');
  writeFileSync(join(dir, 'index.html'), html, 'utf8');
  return join(dir, 'index.html');
}

describe('the F2 warning needs a code edit', () => {
  test('not in a Stop without edits or with a doc edit only; the first code edit warns', async () => {
    const repo = newRepo();
    devCycle(repo.cwd, '- **현재 버전**: v0.1\n', UNREADABLE_UIUX);
    expect(await stopText(repo, 'sess-d')).not.toContain(WARNING); // no edits at all

    await edit(repo, 'sess-d', 'README.md');
    const docOnly = await stopText(repo, 'sess-d');
    expect(docOnly).toContain(REVIEW_BLOCK);
    expect(docOnly).not.toContain(WARNING);
    expect(gateLog(repo, 'sess-d')).not.toContain('acceptance:');

    await edit(repo, 'sess-d', 'src/a.ts');
    expect(await stopText(repo, 'sess-d')).toContain(WARNING);
    expect(gateLog(repo, 'sess-d')).toContain('acceptance: no-criteria');
  }, 30_000);
});

describe('the F2 warning and GOODBOY_TEST_GATE', () => {
  test('off: no warning; the same documents on auto are reported', async () => {
    const off = newRepo();
    devCycle(off.cwd, '- **현재 버전**: v0.1\n', UNREADABLE_UIUX);
    await edit(off, 'sess-off', 'src/a.ts', { GOODBOY_TEST_GATE: 'off' });
    const quiet = await stopText(off, 'sess-off', { GOODBOY_TEST_GATE: 'off' });
    expect(quiet).toContain(REVIEW_BLOCK);
    expect(quiet).not.toContain(WARNING);
    expect(gateLog(off, 'sess-off')).not.toContain('acceptance:');

    const auto = newRepo();
    devCycle(auto.cwd, '- **현재 버전**: v0.1\n', UNREADABLE_UIUX);
    await edit(auto, 'sess-auto', 'src/a.ts');
    expect(await stopText(auto, 'sess-auto')).toContain(WARNING);
  }, 30_000);
});

describe('versions the F2 warning leaves alone', () => {
  // The v0.1 folder holds unreadable documents in both cases; they are not this version's.
  test.each([
    ['a version whose folder is missing', '- **현재 버전**: v0.2\n'],
    ['a placeholder version', '- **현재 버전**: <v0.1>\n'],
  ])('%s is not reported', async (_label, cycle) => {
    const repo = newRepo();
    devCycle(repo.cwd, cycle, UNREADABLE_UIUX);
    await edit(repo, 'sess-v', 'src/a.ts');
    const out = await stopText(repo, 'sess-v');
    expect(out).toContain(REVIEW_BLOCK);
    expect(out).not.toContain(WARNING);
    expect(gateLog(repo, 'sess-v')).not.toContain('acceptance:');
  }, 30_000);
});

describe('a prototype that yields no criteria (F2)', () => {
  test('is reported by its path', async () => {
    const repo = newRepo();
    prototypeOnly(repo.cwd, '<div class="pt-bar"><button class="pt-btn">x</button></div>\n');
    await edit(repo, 'sess-p', 'src/a.ts');
    const out = await stopText(repo, 'sess-p');
    expect(out).toContain(WARNING);
    expect(out).toContain(join('docs', 'versions', 'v0.1', 'prototype', 'index.html'));
  }, 30_000);

  // Imported when the test runs: older trees lack the function, and the hook tests above
  //   still run there.
  test('readAcceptance names it, and nothing once it yields criteria', async () => {
    const { readAcceptance } = await import('../lib/acceptance');
    const cwd = newDir('goodboy-aws-lib-');
    const html = prototypeOnly(cwd, '<div class="pt-bar"></div>\n');
    expect(readAcceptance(cwd).problem).toEqual({ kind: 'no-criteria', files: [html] });
    writeFileSync(html, '<div class="pt-bar"></div><main class="board"></main>\n', 'utf8'); // PT-STRUCT
    expect(readAcceptance(cwd).problem).toBeNull();
  });

  test('readAcceptance: a missing version folder is not a problem', async () => {
    const { readAcceptance } = await import('../lib/acceptance');
    const cwd = newDir('goodboy-aws-lib-');
    devCycle(cwd, '- **현재 버전**: v0.2\n', UNREADABLE_UIUX);
    expect(readAcceptance(cwd).problem).toBeNull();
  });
});
