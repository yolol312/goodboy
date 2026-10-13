// Stabilization plan F1/F2 through the real PostToolUse and Stop hooks: English dev-cycle
// documents feed layer 1, and documents that yield no acceptance criteria are reported
// once per session instead of silently dropping the criteria to zero.

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const WARNING = '수용 기준을';
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

async function run(repo: Repo, script: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const p = Bun.spawn(['bun', script], {
    cwd: repo.cwd,
    env: {
      ...process.env,
      TMPDIR: repo.tmp,
      HOME: repo.tmp,
      CLAUDE_PLUGIN_ROOT: ROOT,
      GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
      GOODBOY_AUTOVALIDATE: 'off',
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

async function edit(repo: Repo, sid: string, rel: string): Promise<void> {
  const abs = resolve(repo.cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'export const x = 1;\n', 'utf8');
  await run(repo, POST, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
}

async function stopText(repo: Repo, sid: string): Promise<string> {
  const out = (await run(repo, STOP, { session_id: sid, hook_event_name: 'Stop' })) as { reason?: string; systemMessage?: string };
  return `${out.reason ?? ''}\n${out.systemMessage ?? ''}`;
}

function devCycle(repo: Repo, cycle: string, uiux: string): void {
  mkdirSync(join(repo.cwd, 'docs', 'versions', 'v0.1'), { recursive: true });
  writeFileSync(join(repo.cwd, 'docs', 'CYCLE.md'), cycle, 'utf8');
  writeFileSync(join(repo.cwd, 'docs', 'versions', 'v0.1', 'UIUX.md'), uiux, 'utf8');
}

describe('layer 1 with English and unreadable dev-cycle documents (F1/F2)', () => {
  test('English documents turn the gate on and their criteria are required', async () => {
    const repo = { tmp: newDir('goodboy-acc-tmp-'), cwd: newDir('goodboy-acc-cwd-') };
    devCycle(
      repo,
      '- **Current version**: v0.1\n- **Current stage**: 5\n',
      '## Screens\n\n| Screen | Kind |\n|---|---|\n| Settings | new |\n',
    );
    await edit(repo, 'sess-en', 'src/settings.ts');
    const text = await stopText(repo, 'sess-en');
    expect(text).toContain('테스트가 없습니다'); // layer 1 is on (dev-cycle artifacts found)
    expect(text).not.toContain(WARNING);
  }, 30_000);

  test('documents that yield no criteria are reported once per session', async () => {
    const repo = { tmp: newDir('goodboy-acc-tmp-'), cwd: newDir('goodboy-acc-cwd-') };
    devCycle(repo, '- **현재 버전**: v0.1\n', '## Pantallas\n\n| Pantalla | Tipo |\n|---|---|\n| Ajustes | nuevo |\n');
    await edit(repo, 'sess-x', 'src/a.ts');
    const first = await stopText(repo, 'sess-x');
    expect(first).toContain(WARNING);
    expect(first).toContain('UIUX.md');
    await edit(repo, 'sess-x', 'src/b.ts');
    expect(await stopText(repo, 'sess-x')).not.toContain(WARNING);
  }, 30_000);

  test('a CYCLE.md without a current-version line is reported', async () => {
    const repo = { tmp: newDir('goodboy-acc-tmp-'), cwd: newDir('goodboy-acc-cwd-') };
    devCycle(repo, '- **Version now**: v0.1\n', '## Screens\n\n| Screen | Kind |\n|---|---|\n| Settings | new |\n');
    await edit(repo, 'sess-k', 'src/a.ts');
    expect(await stopText(repo, 'sess-k')).toContain('현재 버전 줄');
  }, 30_000);
});

// Layer-1 round 5: readAcceptance reports an unreadable CYCLE.md, but no test checked that the
//   Stop shows the report. Without it, a CYCLE.md made unreadable drops the criteria with no sign.
describe('an unreadable CYCLE.md at the Stop (F2)', () => {
  // As root the chmod blocks nothing and the test would prove nothing.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'is reported once a code file was edited',
    async () => {
      const repo = { tmp: newDir('goodboy-acc-tmp-'), cwd: newDir('goodboy-acc-cwd-') };
      devCycle(repo, '- **현재 버전**: v0.1\n', '## 화면 목록\n\n| 화면 | 구분 |\n|---|---|\n| 설정 | 신규 |\n');
      const cycle = join(repo.cwd, 'docs', 'CYCLE.md');
      chmodSync(cycle, 0o000);
      try {
        await edit(repo, 'sess-u', 'src/a.ts');
        expect(await stopText(repo, 'sess-u')).toContain('docs/CYCLE.md 를 읽을 수 없습니다');
      } finally {
        chmodSync(cycle, 0o644);
      }
    },
    30_000,
  );
});
