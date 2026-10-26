// M5 trial fixes: (1) a test that names a module only in `import type` / `export type … from`
// does not load it (the statement is erased at run time), while every other spelling keeps the
// edge; (2) the result-guard log names the path when the result-dir rule fired.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { affectedTests } from '../lib/existing-tests';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-m5t-'));
  dirs.push(d);
  return d;
}
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function repo(files: Record<string, string>): { top: string; head: string } {
  const top = join(tmp(), 'repo');
  mkdirSync(top, { recursive: true });
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 't@example.com');
  git(top, 'config', 'user.name', 't');
  git(top, 'config', 'commit.gpgsign', 'false');
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(top, f)), { recursive: true });
    writeFileSync(join(top, f), t);
  }
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'start');
  return { top, head: git(top, 'rev-parse', 'HEAD') };
}

const T = 'import { expect, test } from "bun:test";\n';
const BODY = 'test("x", () => expect(1).toBe(1));\n';

describe('jsLoads: type-only imports do not load a module', () => {
  const files: Record<string, string> = {
    'src/types.ts': 'export type A = { a: number };\nexport const k = 1;\n',
    'tests/type-only.test.ts': `${T}import type { A } from "../src/types";\n${BODY}`,
    'tests/type-multiline.test.ts': `${T}import type {\n  A,\n} from "../src/types";\n${BODY}`,
    'tests/export-type.test.ts': `${T}export type { A } from "../src/types";\n${BODY}`,
    'tests/inline-type.test.ts': `${T}import { type A } from "../src/types";\n${BODY}`,
    'tests/value.test.ts': `${T}import { k } from "../src/types";\n${BODY}`,
    'tests/both.test.ts': `${T}import type { A } from "../src/types";\nimport { k } from "../src/types";\n${BODY}`,
    'tests/dynamic.test.ts': `${T}import type { A } from "../src/types";\ntest("d", async () => { await import("../src/types"); });\n`,
    'tests/require.test.ts': `${T}import type { A } from "../src/types";\nconst m = require("../src/types");\n${BODY}`,
    'tests/default-named-type.test.ts': `${T}import type from "../src/types";\n${BODY}`,
    'tests/default-named-type-2.test.ts': `${T}import type, { k } from "../src/types";\n${BODY}`,
    'tests/comment-default-type.test.ts': `${T}import type /* c */ from "../src/types";\n${BODY}`,
    'tests/comment-in-list.test.ts': `${T}import {\n/*\nimport type\n*/\n  k,\n} from "../src/types";\n${BODY}`,
    'tests/side-effect.test.ts': `${T}import "../src/types";\n${BODY}`,
  };

  test('only a specifier that is nowhere used as a value is dropped', () => {
    const { top, head } = repo(files);
    const got = affectedTests(top, head, [join(top, 'src/types.ts')]).get('src/types.ts') ?? [];
    expect(got).toEqual([
      'tests/both.test.ts',
      'tests/comment-default-type.test.ts',
      'tests/comment-in-list.test.ts',
      'tests/default-named-type-2.test.ts',
      'tests/default-named-type.test.ts',
      'tests/dynamic.test.ts',
      'tests/inline-type.test.ts',
      'tests/require.test.ts',
      'tests/side-effect.test.ts',
      'tests/value.test.ts',
    ]);
  });
});

describe('result-guard log reason', () => {
  test('the result-dir rule logs `dir-write <path> <agent>`, not `null main`', async () => {
    const root = tmp();
    const cwd = join(root, 'p');
    mkdirSync(cwd, { recursive: true });
    const sessionId = `m5t${Math.random().toString(36).slice(2, 10)}`;
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', 'pre-tool-use.ts')], {
      cwd,
      env: { ...process.env, TMPDIR: root, GOODBOY_CLAIM_FLUSH_WAIT_MS: '0' },
      stdin: new TextEncoder().encode(
        JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cp /tmp/x .claude/tests/r.json' } }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.stringify(JSON.parse(out || '{}'))).toContain('deny');
    const log = join(root, `goodboy-session-${sessionId}`, 'gate-log.jsonl');
    expect(existsSync(log)).toBe(true);
    const events = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { gate: string; reason?: string });
    const e = events.find((x) => x.gate === 'result-guard');
    expect(e?.reason).toMatch(/^dir-write \S*\.claude\/tests\S* main$/);
  });
});
