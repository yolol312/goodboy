import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isWorkflowSkill, validateSkillGapNote } from '../lib/skill-rule';

// Track G skill rule (plan §10.4). The suite runs with GOODBOY_SKILL_GATE=off (tests/setup.ts);
// these tests turn it on.

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('isWorkflowSkill', () => {
  test('current and renamed workflow skills, bare or goodboy-namespaced', () => {
    for (const s of ['fix-bug', 'goodboy:fix-bug', '/goodboy:add-feature', 'diagnose-failure', 'goodboy:prepare-migration']) {
      expect([s, isWorkflowSkill(s)]).toEqual([s, true]);
    }
  });

  test('tool skills, setup-statusline and other plugins do not count', () => {
    for (const s of ['check-security', 'goodboy:record-review', 'setup-statusline', 'other:fix-bug', 'codex']) {
      expect([s, isWorkflowSkill(s)]).toEqual([s, false]);
    }
  });
});

describe('validateSkillGapNote', () => {
  const good = {
    considered: [{ skill: 'fix-bug', why_not: 'nothing is broken; this is a rename' }],
    would_fit: 'a rename skill that updates references',
    task: 'rename review-changes',
  };

  test('a complete note passes', () => {
    expect(validateSkillGapNote(good)).toMatchObject({ ok: true, value: good });
  });

  test('missing parts, short reasons and unknown skills fail', () => {
    expect(validateSkillGapNote({ ...good, considered: [] }).ok).toBe(false);
    expect(validateSkillGapNote({ ...good, considered: [{ skill: 'fix-bug', why_not: 'no' }] }).errors.join()).toContain('why_not');
    expect(validateSkillGapNote({ ...good, considered: [{ skill: 'make-change', why_not: 'it does not fit at all' }] }).errors.join()).toContain('not a workflow skill');
    expect(validateSkillGapNote({ ...good, would_fit: 'x' }).errors.join()).toContain('would_fit');
    expect(validateSkillGapNote('text').ok).toBe(false);
  });
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-skill-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs'), { recursive: true });
  const logDir = join(base, 'logs');
  const sid = `skill-${Math.random().toString(36).slice(2)}`;
  const env = { ...process.env, TMPDIR: base, GOODBOY_SKILL_GATE: 'on', GOODBOY_LOG_DIR: logDir, GOODBOY_REASONING_GATE: 'off', CLAUDE_PLUGIN_ROOT: ROOT };
  const hook = async (name: string, payload: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${name}.ts`)], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...env, ...extra },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    return out;
  };
  const write = async (rel: string, extra: Record<string, unknown> = {}, envExtra: Record<string, string> = {}) => {
    const out = await hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: join(cwd, rel), content: 'x' }, ...extra }, envExtra);
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '' };
  };
  const cliRaw = async (args: string[], stdin: string) => {
    const proc = Bun.spawn(['bun', join(ROOT, 'lib', 'cli.ts'), 'skill-gap', ...args], {
      cwd,
      stdin: new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stdout, stderr };
  };
  const cli = (note: unknown, session = sid) => cliRaw(['--session', session], JSON.stringify(note));
  return { cwd, sid, base, logDir, hook, write, cli, cliRaw };
}

describe('the rule in the hooks', () => {
  test('a code edit without evidence is denied with the exact CLI command', async () => {
    const { sid, write } = setup();
    const r = await write('src/a.ts');
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('skill rule');
    expect(r.reason).toContain(`skill-gap --session ${sid}`);
    expect(r.reason).toContain(join(ROOT, 'lib', 'cli.ts'));
  });

  test('docs, files outside the project and subagents are exempt', async () => {
    const { base, write } = setup();
    expect((await write('docs/guide.md')).denied).toBe(false);
    expect((await write('README.md')).denied).toBe(false);
    const outside = await write('../outside.ts');
    expect(outside.reason).not.toContain('skill rule');
    expect((await write('src/a.ts', { agent_type: 'general-purpose', agent_id: 'g1' })).reason).not.toContain('skill rule');
    expect(base).toBeTruthy();
  });

  test('a workflow Skill call in the main session is evidence; a tool skill or a subagent call is not', async () => {
    const s = setup();
    await s.hook('post-tool-use', { tool_name: 'Skill', tool_input: { skill: 'goodboy:check-security' } });
    await s.hook('post-tool-use', { tool_name: 'Skill', tool_input: { skill: 'goodboy:fix-bug' }, agent_type: 'goodboy:test-unit', agent_id: 't1' });
    expect((await s.write('src/a.ts')).denied).toBe(true);
    await s.hook('post-tool-use', { tool_name: 'Skill', tool_input: { skill: 'goodboy:fix-bug' } });
    expect((await s.write('src/a.ts')).denied).toBe(false);
  });

  test('a typed workflow command is evidence', async () => {
    const s = setup();
    await s.hook('user-prompt-submit', { prompt: '/goodboy:refactor split the parser' });
    expect((await s.write('src/a.ts')).denied).toBe(false);
  });

  test('a skill-gap note is evidence and is logged for the monthly review', async () => {
    const s = setup();
    const bad = await s.cli({ considered: [], would_fit: '' });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('considered');
    expect((await s.write('src/a.ts')).denied).toBe(true);
    const ok = await s.cli({
      considered: [{ skill: 'refactor', why_not: 'behavior changes on purpose here' }],
      would_fit: 'a skill for policy-table edits',
      task: 'tune the caps',
    });
    expect(ok.code).toBe(0);
    expect((await s.write('src/a.ts')).denied).toBe(false);
    const log = readFileSync(join(s.logDir, 'skill-gaps.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ session: s.sid, note: { would_fit: 'a skill for policy-table edits' } });
  });

  test('an accepted review closes the change: the next edit needs new evidence', async () => {
    const s = setup();
    await s.hook('post-tool-use', { tool_name: 'Skill', tool_input: { skill: 'goodboy:fix-bug' } });
    expect((await s.write('src/a.ts')).denied).toBe(false);
    await Bun.sleep(5);
    // The Stop hook writes this cursor when it accepts a review (lib/review-cursor.ts).
    const { cursorFileName, REVIEW_CURSOR_FILE } = await import('../lib/review-cursor');
    const dir = join(s.base, `goodboy-session-${s.sid}`);
    writeFileSync(join(dir, cursorFileName(REVIEW_CURSOR_FILE, s.cwd)), JSON.stringify({ turn: 1, timestamp: new Date().toISOString(), sessionId: s.sid }));
    expect(existsSync(dir)).toBe(true);
    expect((await s.write('src/b.ts')).denied).toBe(true);
  });

  test('evidence recorded after the accepted review unlocks the next change', async () => {
    const s = setup();
    const { cursorFileName, REVIEW_CURSOR_FILE } = await import('../lib/review-cursor');
    const dir = join(s.base, `goodboy-session-${s.sid}`);
    await s.hook('post-tool-use', { tool_name: 'Skill', tool_input: { skill: 'goodboy:fix-bug' } });
    await Bun.sleep(5);
    writeFileSync(join(dir, cursorFileName(REVIEW_CURSOR_FILE, s.cwd)), JSON.stringify({ turn: 1, timestamp: new Date().toISOString(), sessionId: s.sid }));
    expect((await s.write('src/b.ts')).denied).toBe(true);
    await Bun.sleep(5);
    await s.hook('post-tool-use', { tool_name: 'Skill', tool_input: { skill: 'goodboy:add-feature' } });
    expect((await s.write('src/b.ts')).denied).toBe(false);
  });

  test('skill-gap without --session or with a non-JSON note fails and records nothing', async () => {
    const s = setup();
    const note = JSON.stringify({
      considered: [{ skill: 'refactor', why_not: 'behavior changes on purpose here' }],
      would_fit: 'a skill for policy-table edits',
    });
    const noSession = await s.cliRaw([], note);
    expect(noSession.code).toBe(1);
    expect(noSession.stderr).toContain('--session');
    const emptySession = await s.cliRaw(['--session'], note);
    expect(emptySession.code).toBe(1);
    const notJson = await s.cliRaw(['--session', s.sid], 'refactor does not fit');
    expect(notJson.code).toBe(1);
    expect(notJson.stderr).toContain('not JSON');
    expect((await s.write('src/a.ts')).denied).toBe(true);
    expect(existsSync(join(s.logDir, 'skill-gaps.jsonl'))).toBe(false);
  });

  test('warn mode advises instead of denying', async () => {
    const s = setup();
    const r = await s.write('src/a.ts', {}, { GOODBOY_SKILL_GATE: 'warn' });
    expect(r.denied).toBe(false);
    expect(r.context).toContain('skill rule');
  });
});
