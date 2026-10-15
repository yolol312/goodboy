// H2 defect (layer-1 test round): the Read tool shows at most the first 2000 lines when it
// gets no offset/limit. The policy read gate records such a Read as a full one, so a required
// file longer than 2000 lines opens the gate with its lines 2001+ never shown. The gate must
// count the lines the Read actually showed (§14.3: "partial reads count when their ranges
// cover the file"). Repos and session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const POLICY = ['# Policy', '', '## P1 Tests before push', '- decide: ai', '- source: CLAUDE.md:12', '- date: 2026-10-15', '- checked: 2026-10-15', '- evidence: bun test', 'Every push carries a passing layer-1 result.', ''].join('\n');

/** A project whose only extra session-start doc, BIG.md, has 2500 lines. */
function project(): { dir: string; policy: string; big: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h2cap-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.goodboy'));
  writeFileSync(join(dir, '.goodboy', 'policy.md'), POLICY);
  writeFileSync(join(dir, 'BIG.md'), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(dir, '.goodboy', 'docs.json'), JSON.stringify({ docs: [{ path: '.goodboy/policy.md', session_start: true, covers: [] }, { path: 'BIG.md', session_start: true, covers: [] }] }));
  return { dir, policy: join(dir, '.goodboy', 'policy.md'), big: join(dir, 'BIG.md') };
}

async function hook(name: string, cwd: string, payload: Record<string, unknown>) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', `${name}.ts`)], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off', GOODBOY_AUTOVALIDATE: 'off' },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
}

describe('policy read gate and the Read tool default cap', () => {
  test('a Read without offset/limit of a 2500-line required file does not open the gate; the rest of the lines do', async () => {
    const { dir, policy, big } = project();
    const session = `h2cap${Math.random().toString(36).slice(2, 10)}`;
    dirs.push(join(tmpdir(), `goodboy-session-${session}`));
    const bash = { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b' };
    const read = (file: string, extra: Record<string, unknown>, response: Record<string, unknown>) =>
      hook('post-tool-use', dir, { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file, ...extra }, tool_response: response });

    await hook('session-start', dir, { session_id: session, hook_event_name: 'SessionStart', source: 'startup' });
    await read(policy, {}, {});
    // What the tool returns for BIG.md without offset/limit: lines 1-2000 of 2500.
    await read(big, {}, { type: 'text', file: { filePath: big, content: 'line 1\n', numLines: 2000, startLine: 1, totalLines: 2500 } });
    const stillGated = await hook('pre-tool-use', dir, bash);
    expect(stillGated.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(stillGated.hookSpecificOutput?.permissionDecisionReason ?? '').toContain('BIG.md');

    await read(big, { offset: 2001, limit: 500 }, { type: 'text', file: { filePath: big, content: 'line 2001\n', numLines: 500, startLine: 2001, totalLines: 2500 } });
    const opened = await hook('pre-tool-use', dir, { ...bash, tool_use_id: 'b2' });
    expect(opened.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  }, 60_000);
});
