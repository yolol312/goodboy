// H2 project knowledge (track H §14.3): the policy file and doc map, the files a session reads
// first, full-read evidence (whole or covering partial reads, current version only), the read
// gate and its exemptions, the SessionStart notice, and the skill's done check. Repos and
// session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clearReadRecords, recordEdit, recordRead } from '../lib/file-tracker';
import { knowledgeRoot, knowsCurrentContent, policyReadDenial, readDocMap, requiredKnowledgeFiles, validateKnowledge } from '../lib/project-knowledge';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.GOODBOY_POLICY_GATE;
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h2-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `h2${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const POLICY = [
  '# Policy',
  '',
  '## P1 Tests before push',
  '- decide: ai',
  '- source: CLAUDE.md:12',
  '- date: 2026-10-15',
  '- checked: 2026-10-15',
  '- evidence: bun test',
  'Every push carries a passing layer-1 result.',
  '',
].join('\n');

/** A project with policy.md and a doc map naming ARCH.md as session-start. */
function project(): string {
  const d = tmp();
  mkdirSync(join(d, '.git'));
  mkdirSync(join(d, '.goodboy'));
  writeFileSync(join(d, '.goodboy', 'policy.md'), POLICY);
  writeFileSync(join(d, 'ARCH.md'), 'a\nb\nc\n');
  writeFileSync(
    join(d, '.goodboy', 'docs.json'),
    JSON.stringify({ docs: [{ path: '.goodboy/policy.md', session_start: true, covers: [] }, { path: 'ARCH.md', session_start: true, covers: ['src/**'] }, { path: '../outside.md', session_start: true }] }),
  );
  return d;
}

const read = (s: string, f: string, range?: [number, number]) => recordRead(s, f, 0, statSync(f).mtimeMs, undefined, range !== undefined, range);

describe('files', () => {
  test('the root: the nearest policy file up, else the git top, else the cwd', () => {
    const d = project();
    mkdirSync(join(d, 'pkg', 'src'), { recursive: true });
    expect(knowledgeRoot(join(d, 'pkg', 'src'))).toEqual({ root: d, policyExists: true });
    const g = tmp();
    mkdirSync(join(g, '.git'));
    mkdirSync(join(g, 'sub'));
    expect(knowledgeRoot(join(g, 'sub'))).toEqual({ root: g, policyExists: false });
  });

  test('required files: the policy and existing session-start docs inside the project', () => {
    const d = project();
    expect(requiredKnowledgeFiles(d)).toEqual([join(d, '.goodboy', 'policy.md'), join(d, 'ARCH.md')]);
    writeFileSync(join(d, '.goodboy', 'docs.json'), '{oops');
    expect(readDocMap(d).problem).toContain('cannot be read');
    expect(requiredKnowledgeFiles(d)).toEqual([join(d, '.goodboy', 'policy.md')]);
  });
});

describe('what counts as read', () => {
  test('a full Read of the current version, covering partial reads, or an own edit', () => {
    const d = project();
    const f = join(d, 'ARCH.md');
    const s = sid();
    expect(knowsCurrentContent(s, f, 0)).toBe(false);
    read(s, f, [1, 2]);
    expect(knowsCurrentContent(s, f, 0)).toBe(false); // line 3 unseen
    read(s, f, [3, 10]);
    expect(knowsCurrentContent(s, f, 0)).toBe(true);
    // Changed since the reads (not by this session): read again.
    writeFileSync(f, 'a\nb\nc\nd\n');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(knowsCurrentContent(s, f, 0)).toBe(false);
    read(s, f);
    expect(knowsCurrentContent(s, f, 0)).toBe(true);
    // The session's own edit is known content.
    writeFileSync(f, 'edited\n');
    recordEdit(s, f, 0, undefined, statSync(f).mtimeMs);
    expect(knowsCurrentContent(s, f, 0)).toBe(true);
    // After a compaction everything must be read again.
    clearReadRecords(s);
    expect(knowsCurrentContent(s, f, 0)).toBe(false);
  });
});

describe('the read gate', () => {
  test('denies other tools until every required file is read; its exemptions', () => {
    const d = project();
    const s = sid();
    const ask = (toolName: string, toolInput: Record<string, unknown> = {}, agentType?: string) => policyReadDenial({ sessionId: s, cwd: d, turn: 0, toolName, toolInput, agentType });
    expect(ask('Bash', { command: 'ls' })).toContain('.goodboy/policy.md, ARCH.md');
    expect(ask('Edit', { file_path: 'src/a.ts' })).toContain('policy read gate');
    for (const t of ['Read', 'AskUserQuestion', 'ToolSearch']) expect([t, ask(t)]).toEqual([t, null]);
    expect(ask('Skill', { skill: 'goodboy:keep-project-knowledge' })).toBeNull();
    expect(ask('Skill', { skill: 'goodboy:fix-bug' })).not.toBeNull();
    expect(ask('Bash', { command: 'ls' }, 'goodboy:build-backend')).toBeNull(); // subagents exempt
    read(s, join(d, '.goodboy', 'policy.md'));
    expect(ask('Bash', { command: 'ls' })).toContain('ARCH.md');
    read(s, join(d, 'ARCH.md'));
    expect(ask('Bash', { command: 'ls' })).toBeNull();
    const t = sid();
    process.env.GOODBOY_POLICY_GATE = 'off';
    expect(policyReadDenial({ sessionId: t, cwd: d, turn: 0, toolName: 'Bash', toolInput: {} })).toBeNull();
  });

  test('a file Read cannot record is not required (no deadlock); the notice names it', () => {
    const d = project();
    mkdirSync(join(d, 'DIR.md'));
    writeFileSync(join(d, 'BIN.md'), Buffer.from([0x50, 0x00, 0x01]));
    writeFileSync(join(d, 'SPEC.pdf'), '%PDF-1.4');
    writeFileSync(
      join(d, '.goodboy', 'docs.json'),
      JSON.stringify({ docs: ['.goodboy/policy.md', 'DIR.md', 'BIN.md', 'SPEC.pdf'].map((path) => ({ path, session_start: true })) }),
    );
    expect(requiredKnowledgeFiles(d)).toEqual([join(d, '.goodboy', 'policy.md')]);
    const s = sid();
    read(s, join(d, '.goodboy', 'policy.md'));
    expect(policyReadDenial({ sessionId: s, cwd: d, turn: 0, toolName: 'Bash', toolInput: {} })).toBeNull();
  });

  test('no policy file, or a non-project directory: no gate', () => {
    const g = tmp();
    mkdirSync(join(g, '.git'));
    expect(policyReadDenial({ sessionId: sid(), cwd: g, turn: 0, toolName: 'Bash', toolInput: {} })).toBeNull();
    const d = project();
    writeFileSync(join(d, 'CLAUDE.md'), 'goodboy: non-project\n');
    expect(policyReadDenial({ sessionId: sid(), cwd: d, turn: 0, toolName: 'Bash', toolInput: {} })).toBeNull();
  });
});

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
  return JSON.parse(out || '{}') as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string } };
}

describe('through the hooks', () => {
  test('SessionStart names the files; Bash waits until they are read; re-reading them is allowed', async () => {
    const d = project();
    const s = sid();
    const start = await hook('session-start', d, { session_id: s, hook_event_name: 'SessionStart', source: 'startup' });
    expect(start.hookSpecificOutput?.additionalContext ?? '').toContain('.goodboy/policy.md, ARCH.md');
    const bash = { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b1' };
    expect((await hook('pre-tool-use', d, bash)).hookSpecificOutput?.permissionDecision).toBe('deny');
    for (const f of ['.goodboy/policy.md', 'ARCH.md']) {
      const abs = join(d, f);
      for (let i = 0; i < 2; i++) {
        // The second Read of a required file is not stopped by the re-Read gate.
        expect((await hook('pre-tool-use', d, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: abs }, tool_use_id: `r${i}` })).hookSpecificOutput?.permissionDecision).not.toBe('deny');
        await hook('post-tool-use', d, { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: abs }, tool_response: {} });
      }
    }
    expect((await hook('pre-tool-use', d, { ...bash, tool_use_id: 'b2' })).hookSpecificOutput?.permissionDecision).not.toBe('deny');
  }, 60_000);

  test('delegating is no way past the gate', async () => {
    const d = project();
    const s = sid();
    const agent = { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'goodboy:build-backend', prompt: 'do it', description: 'x' }, tool_use_id: 'a1' };
    const out = await hook('pre-tool-use', d, agent);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  }, 20_000);

  test('a project without a policy file gets the create-mode notice, in Korean for the user', async () => {
    const g = tmp();
    mkdirSync(join(g, '.git'));
    const start = await hook('session-start', g, { session_id: sid(), hook_event_name: 'SessionStart', source: 'compact' });
    expect(start.hookSpecificOutput?.additionalContext ?? '').toContain('keep-project-knowledge skill in create mode');
    expect(start.systemMessage ?? '').toContain('정책 파일');
  }, 20_000);
});

describe("the skill's done check", () => {
  test('entries need decide, source, date, checked (and evidence for ai); the map marks the policy', () => {
    const d = project();
    expect(validateKnowledge(d)).toEqual([]);
    writeFileSync(join(d, '.goodboy', 'policy.md'), '## P2 Naming\n- decide: maybe\n- source: x\n');
    expect(validateKnowledge(d)).toEqual(['entry "P2 Naming" has no date: line', 'entry "P2 Naming" has no checked: line', 'entry "P2 Naming" has decide: maybe (ai or human)']);
    // An empty value does not borrow the next line.
    writeFileSync(join(d, '.goodboy', 'policy.md'), '## P3 X\n- decide: human\n- source:\n- date: 2026-10-15\n- checked: 2026-10-15\n');
    expect(validateKnowledge(d)).toEqual(['entry "P3 X" has no source: line']);
    writeFileSync(join(d, '.goodboy', 'docs.json'), JSON.stringify({ docs: [] }));
    expect(validateKnowledge(d)).toContain('.goodboy/docs.json does not list .goodboy/policy.md with "session_start": true');
    const cli = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'knowledge-check'], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
    expect(cli.exitCode).toBe(1);
    expect(JSON.parse(cli.stdout.toString()).ok).toBe(false);
  });
});
