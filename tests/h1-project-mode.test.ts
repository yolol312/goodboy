// H1 project mode (track H §14.2): the marker line, its write guard with user evidence, the
// test gate off in a non-project directory (the review gate stays), and evidence logs the
// state guard puts back exactly. Directories and session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureSessionDir } from '../lib/file-tracker';
import { answerChoseNonProject, hasMarkerEvidence, markerWriteDenial, markerWriteTarget, pinProjectMode, projectMode, recordMarkerEvidence } from '../lib/project-mode';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h1-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `h1${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

async function hook(name: string, cwd: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const p = Bun.spawn(['bun', join(ROOT, 'hooks', `${name}.ts`)], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify({ cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off', GOODBOY_SKILL_GATE: 'off', ...env },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(out || '{}') as { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
}

describe('the marker', () => {
  test("only the cwd's own CLAUDE.md, only as a line of its own", () => {
    const d = tmp();
    expect(projectMode(d)).toBe('project');
    writeFileSync(join(d, 'CLAUDE.md'), '# notes\nthis is not goodboy: non-project at all\n');
    expect(projectMode(d)).toBe('project');
    writeFileSync(join(d, 'CLAUDE.md'), '# notes\n  goodboy: non-project  \n<!-- 프로젝트가 아닌 작업 공간 -->\n');
    expect(projectMode(d)).toBe('non-project');
    mkdirSync(join(d, 'sub'));
    expect(projectMode(join(d, 'sub'))).toBe('project'); // no inheritance
  });

  test('a write that adds it is found in Write, Edit, MultiEdit and Bash', () => {
    const d = tmp();
    expect(markerWriteTarget('Write', { file_path: 'CLAUDE.md', content: 'goodboy: non-project\n' }, d)).toBe(join(d, 'CLAUDE.md'));
    expect(markerWriteTarget('Edit', { file_path: join(d, 'CLAUDE.md'), old_string: 'a', new_string: 'a\ngoodboy: non-project' }, d)).toBe(join(d, 'CLAUDE.md'));
    expect(markerWriteTarget('MultiEdit', { file_path: 'CLAUDE.md', edits: [{ old_string: 'a', new_string: 'goodboy: non-project' }] }, d)).toBe(join(d, 'CLAUDE.md'));
    expect(markerWriteTarget('Bash', { command: "printf 'goodboy: non-project\\n' >> CLAUDE.md" }, d)).toBe(join(d, 'CLAUDE.md'));
    expect(markerWriteTarget('Bash', { command: 'echo "goodboy: non-project" | tee -a sub/CLAUDE.md' }, d)).toBe(join(d, 'sub', 'CLAUDE.md'));
    expect(markerWriteTarget('Write', { file_path: 'README.md', content: 'goodboy: non-project' }, d)).toBeNull();
    expect(markerWriteTarget('Bash', { command: 'cat CLAUDE.md' }, d)).toBeNull();
    // Already marked: editing around it adds nothing.
    writeFileSync(join(d, 'CLAUDE.md'), 'goodboy: non-project\n');
    expect(markerWriteTarget('Write', { file_path: 'CLAUDE.md', content: 'goodboy: non-project\nmore\n' }, d)).toBeNull();
  });

  test('it needs the user evidence of this session', () => {
    const d = tmp();
    const s = sid();
    const input = { file_path: 'CLAUDE.md', content: 'goodboy: non-project\n' };
    expect(markerWriteDenial(s, 'Write', input, d)).toContain('Only the user can mark a directory as non-project');
    expect(answerChoseNonProject({ answers: { '이 디렉터리는?': '프로젝트 (project)' } })).toBe(false);
    expect(answerChoseNonProject({ answers: { '이 디렉터리는?': 'non-project (프로젝트 아님)' } })).toBe(true);
    expect(answerChoseNonProject(null)).toBe(false);
    recordMarkerEvidence(s, 'answered');
    expect(hasMarkerEvidence(s)).toBe(true);
    expect(markerWriteDenial(s, 'Write', input, d)).toBeNull();
  });
});

describe('through the hooks', () => {
  test('a typed marker or a non-project answer lets the write through; nothing else does', async () => {
    const d = tmp();
    const write = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(d, 'CLAUDE.md'), content: 'goodboy: non-project\n' }, tool_use_id: 'w1' };
    const a = sid();
    expect((await hook('pre-tool-use', d, { session_id: a, ...write })).hookSpecificOutput?.permissionDecision).toBe('deny');
    await hook('user-prompt-submit', d, { session_id: a, hook_event_name: 'UserPromptSubmit', prompt: '이 폴더는 프로젝트가 아니야. CLAUDE.md에 goodboy: non-project 넣어줘' });
    expect((await hook('pre-tool-use', d, { session_id: a, ...write })).hookSpecificOutput?.permissionDecision).not.toBe('deny');
    const b = sid();
    await hook('post-tool-use', d, { session_id: b, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { answers: { '프로젝트인가요?': 'non-project (프로젝트 아님)' } } });
    expect((await hook('pre-tool-use', d, { session_id: b, ...write })).hookSpecificOutput?.permissionDecision).not.toBe('deny');
    // A subagent's answer is no user evidence.
    const c = sid();
    await hook('post-tool-use', d, { session_id: c, agent_type: 'goodboy:build-docs', agent_id: 'x1', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_input: {}, tool_response: { answers: { q: 'non-project' } } });
    expect((await hook('pre-tool-use', d, { session_id: c, ...write })).hookSpecificOutput?.permissionDecision).toBe('deny');
  }, 40_000);

  test('a non-project directory has no test gate; the review gate still blocks', async () => {
    const d = tmp();
    Bun.spawnSync(['sh', '-c', "git init -q -b main && git config user.email t@e && git config user.name t && mkdir -p src tests && echo 'test(\"t\",()=>{})' > tests/a.test.ts && echo '{}' > package.json && git add -A && git -c commit.gpgsign=false commit -qm init"], { cwd: d });
    const s = sid();
    const edit = async () => {
      writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
      await hook('post-tool-use', d, { session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(d, 'src', 'a.ts'), content: 'x' }, tool_response: {} }, { GOODBOY_AUTOVALIDATE: 'off' });
    };
    const stop = async (session: string) => hook('stop', d, { session_id: session, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: '' });
    await hook('session-start', d, { session_id: s, hook_event_name: 'SessionStart', source: 'startup' });
    await edit();
    expect((await stop(s)).reason ?? '').toContain('No test result covers the changed code');
    // A marker written during the session, without the user's evidence, does not count.
    writeFileSync(join(d, 'CLAUDE.md'), 'goodboy: non-project\n');
    await edit(); // a turn that changes code: one that changed none is not blocked again (#32, #37)
    expect((await stop(s)).reason ?? '').toContain('No test result covers the changed code');
    // The next session starts with the marker: no test gate; the review gate still blocks.
    const next = sid();
    await hook('session-start', d, { session_id: next, hook_event_name: 'SessionStart', source: 'startup' });
    writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 2;\n');
    await hook('post-tool-use', d, { session_id: next, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(d, 'src', 'a.ts'), content: 'x' }, tool_response: {} }, { GOODBOY_AUTOVALIDATE: 'off' });
    const nonProject = await stop(next);
    expect(nonProject.reason ?? '').not.toContain('No test result covers the changed code');
    expect(nonProject.decision).toBe('block');
    expect(nonProject.reason ?? '').toContain('Review is required');
  }, 60_000);

  test('a mid-session marker counts with the user evidence; removing it always counts', () => {
    const d = tmp();
    const s = sid();
    pinProjectMode(s, d);
    writeFileSync(join(d, 'claude.md'.toUpperCase()), 'goodboy: non-project\n');
    expect(projectMode(d, s)).toBe('project');
    expect(projectMode(d)).toBe('non-project'); // what the file says, without a session
    recordMarkerEvidence(s, 'typed');
    expect(projectMode(d, s)).toBe('non-project');
    const t = sid();
    pinProjectMode(t, d);
    expect(projectMode(d, t)).toBe('non-project');
    writeFileSync(join(d, 'CLAUDE.md'), '# notes\n');
    expect(projectMode(d, t)).toBe('project');
  });

  test('a symlinked CLAUDE.md says nothing; a lower-case name and a read are handled', () => {
    const d = tmp();
    writeFileSync(join(d, 'other.md'), 'goodboy: non-project\n');
    symlinkSync(join(d, 'other.md'), join(d, 'CLAUDE.md'));
    expect(projectMode(d)).toBe('project');
    const e = tmp();
    expect(markerWriteTarget('Write', { file_path: 'claude.md', content: 'goodboy: non-project' }, e)).toBe(join(e, 'claude.md'));
    expect(markerWriteTarget('Bash', { command: "grep -n 'goodboy: non-project' CLAUDE.md" }, d)).toBeNull();
    expect(markerWriteTarget('Bash', { command: "git commit -m 'docs: explain goodboy: non-project in CLAUDE.md'" }, d)).toBeNull();
    expect(markerWriteTarget('Bash', { command: 'cp CLAUDE.md.bak CLAUDE.md' }, d)).toBeNull();
  });
});

describe('evidence logs under the state guard', () => {
  test('a skill-gap note added by the CLI from Bash stays; a forged skill line does not', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    const skill = join(dir, 'skill-evidence.jsonl');
    writeFileSync(skill, '');
    snapshotGateState(s, 'tu-gap');
    const gap = '{"k":"skill-gap","t":5,"note":{"considered":[],"would_fit":"x"}}';
    writeFileSync(skill, `${gap}\n{"k":"skill","t":6,"name":"fix-bug"}\n`);
    restoreGateState(s, 'tu-gap');
    expect(readFileSync(skill, 'utf8')).toBe(`${gap}\n`);
  });

  test('edit tools may not write goodboy session state', async () => {
    const d = tmp();
    const s = sid();
    const target = join(ensureSessionDir(s), 'marker-evidence.jsonl');
    const out = await hook('pre-tool-use', d, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target, content: '{"t":1,"how":"typed"}\n' }, tool_use_id: 'w9' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason ?? '').toContain("goodboy's own session state");
    // Also through a symlink in the project that points at it, dangling (the log is not written
    //   yet) or not (H1 review round 2).
    symlinkSync(target, join(d, 'dangling.txt'));
    const dangling = await hook('pre-tool-use', d, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(d, 'dangling.txt'), content: 'x' }, tool_use_id: 'w11' });
    expect(dangling.hookSpecificOutput?.permissionDecision).toBe('deny');
    writeFileSync(target, '');
    symlinkSync(target, join(d, 'notes.txt'));
    const viaLink = await hook('pre-tool-use', d, { session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(d, 'notes.txt'), content: 'x' }, tool_use_id: 'w10' });
    expect(viaLink.hookSpecificOutput?.permissionDecision).toBe('deny');
  }, 20_000);

  test('an appended or created evidence line is removed after the Bash call', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    const skill = join(dir, 'skill-evidence.jsonl');
    writeFileSync(skill, '{"k":"skill","t":1,"name":"fix-bug"}\n');
    snapshotGateState(s, 'tu-ev');
    writeFileSync(skill, '{"k":"skill","t":1,"name":"fix-bug"}\n{"k":"skill","t":2,"name":"add-feature"}\n');
    writeFileSync(join(dir, 'marker-evidence.jsonl'), '{"t":3,"how":"typed"}\n');
    restoreGateState(s, 'tu-ev');
    expect(readFileSync(skill, 'utf8')).toBe('{"k":"skill","t":1,"name":"fix-bug"}\n');
    expect(existsSync(join(dir, 'marker-evidence.jsonl'))).toBe(false);
  });
});
