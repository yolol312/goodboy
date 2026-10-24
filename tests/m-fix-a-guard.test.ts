// Track M fix round 1, fixer A, A8 (plan §19): a test record counts a sandbox run by the
// result.json of that run, so the model must not be able to write one. The Write and Edit tools
// are denied under .goodboy/sandbox/out/ (hooks/pre-tool-use.ts), and a shell write there counts
// as a project write even for a `.log` file (lib/bash-write.ts).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyBashWrite } from '../lib/bash-write';
import { resultDirWrite } from '../lib/role-limits';
import { namesOwnResultDir } from '../lib/result-dir';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sandbox(): { tmp: string; cwd: string; sessionId: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfa-tmp-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-mfa-cwd-')));
  tmpDirs.push(tmp, cwd);
  return { tmp, cwd, sessionId: `sess-${Math.random().toString(36).slice(2)}` };
}

async function hook(s: { tmp: string; cwd: string; sessionId: string }, toolName: string, toolInput: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ decision?: string; reason: string }> {
  const proc = Bun.spawn(['bun', HOOK], {
    cwd: s.cwd,
    env: { ...process.env, TMPDIR: s.tmp, HOME: s.tmp, ...env },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: s.sessionId, cwd: s.cwd, hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    const o = JSON.parse(out) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return { decision: o.hookSpecificOutput?.permissionDecision, reason: o.hookSpecificOutput?.permissionDecisionReason ?? '' };
  } catch {
    return { reason: '' };
  }
}

const RUN = '20261022T100000Z';

describe('A8: the sandbox run results are written only by sandbox-run', () => {
  test('Write to result.json of a run is denied and points at sandbox-run', async () => {
    const s = sandbox();
    const r = await hook(s, 'Write', { file_path: join(s.cwd, '.goodboy', 'sandbox', 'out', RUN, 'result.json'), content: '{}' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('sandbox-run');
    expect(r.reason).toContain('forged run');
  });

  test('Edit of an existing result.json is denied too', async () => {
    const s = sandbox();
    const dir = join(s.cwd, '.goodboy', 'sandbox', 'out', RUN);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'result.json'), '{}');
    const r = await hook(s, 'Edit', { file_path: join(dir, 'result.json'), old_string: '{}', new_string: '{"a":1}' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('sandbox-run');
  });

  test('the gate switch turns it off; other sandbox files, other projects and plain sources pass this gate', async () => {
    const s = sandbox();
    const result = join(s.cwd, '.goodboy', 'sandbox', 'out', RUN, 'result.json');
    expect((await hook(s, 'Write', { file_path: result, content: '{}' }, { GOODBOY_ARTIFACT_WRITE_GATE: 'off' })).reason).not.toContain('forged run');
    expect((await hook(s, 'Write', { file_path: join(s.cwd, '.goodboy', 'sandbox', 'compose.yml'), content: 'x' })).reason).not.toContain('forged run');
    expect((await hook(s, 'Write', { file_path: join(s.cwd, 'src', 'a.ts'), content: 'x' })).reason).not.toContain('forged run');
    expect((await hook(s, 'Write', { file_path: join(s.tmp, '.goodboy', 'sandbox', 'out', RUN, 'result.json'), content: '{}' })).reason).not.toContain('forged run');
  });

  test('a link to the out dir is the out dir, and so is a link to the result dirs of .claude', async () => {
    const s = sandbox();
    mkdirSync(join(s.cwd, '.goodboy', 'sandbox', 'out'), { recursive: true });
    mkdirSync(join(s.cwd, '.claude', 'tests'), { recursive: true });
    symlinkSync(join(s.cwd, '.goodboy', 'sandbox', 'out'), join(s.cwd, 'shortcut'));
    symlinkSync(join(s.cwd, '.claude', 'tests'), join(s.cwd, 'evidence'));
    const viaOut = await hook(s, 'Write', { file_path: join(s.cwd, 'shortcut', RUN, 'result.json'), content: '{}' });
    expect(viaOut.decision).toBe('deny');
    expect(viaOut.reason).toContain('forged run');
    const viaTests = await hook(s, 'Write', { file_path: join(s.cwd, 'evidence', 'r.json'), content: '{}' });
    expect(viaTests.decision).toBe('deny');
    expect(viaTests.reason).toContain('test-write');
    // a link to somewhere else is not the out dir
    mkdirSync(join(s.cwd, 'docs'));
    symlinkSync(join(s.cwd, 'docs'), join(s.cwd, 'elsewhere'));
    expect((await hook(s, 'Write', { file_path: join(s.cwd, 'elsewhere', 'a.md'), content: 'x' })).reason).not.toContain('forged run');
  });

  // macOS ignores case in paths, so the guard must as well (elsewhere the names are distinct dirs)
  test.skipIf(process.platform !== 'darwin')('on macOS the case of the path does not matter', async () => {
    const s = sandbox();
    const out = await hook(s, 'Write', { file_path: join(s.cwd, '.GOODBOY', 'Sandbox', 'OUT', RUN, 'result.json'), content: '{}' });
    expect(out.decision).toBe('deny');
    expect(out.reason).toContain('forged run');
    const tests = await hook(s, 'Write', { file_path: join(s.cwd, '.Claude', 'Tests', 'r.json'), content: '{}' });
    expect(tests.decision).toBe('deny');
    expect(tests.reason).toContain('test-write');
  });

  test('a shell write under the out dir counts as a project write, even to a .log file', () => {
    const { cwd } = sandbox();
    expect(classifyBashWrite(`echo '{}' > .goodboy/sandbox/out/${RUN}/result.json`, cwd).length).toBeGreaterThan(0);
    expect(classifyBashWrite(`echo x > .goodboy/sandbox/out/${RUN}/output.log`, cwd).length).toBeGreaterThan(0);
    // a log elsewhere is still the usual harmless case
    expect(classifyBashWrite('echo x > build.log', cwd)).toEqual([]);
  });
});

describe('A8: the shell command families that write a result dir also cover the sandbox out dir', () => {
  const O = '.goodboy/sandbox/out';
  const cwd = '/p/repo';

  test('cp, mv, ln, tee, rm, an interpreter and a redirect naming result.json, a run dir or out/ are denied', () => {
    for (const c of [
      `cp /tmp/forged.json ${O}/${RUN}/result.json`,
      `mv /tmp/forged.json ${O}/${RUN}/result.json`,
      `ln -s /tmp/forged.json ${O}/${RUN}/result.json`,
      `cp -r /tmp/forged-run ${O}/`,
      `cp -r /tmp/forged-run ${O}/${RUN}`,
      `echo '{}' | tee ${O}/${RUN}/result.json`,
      `echo '{}' > ${O}/${RUN}/result.json`,
      `rm ${O}/${RUN}/result.json`,
      `python3 -c "open('${O}/${RUN}/result.json','w').write('{}')"`,
      `bun -e "require('node:fs').writeFileSync('${O}/${RUN}/result.json','{}')"`,
      `node -e "require('fs').writeFileSync('./${O}/${RUN}/result.json','{}')"`,
      `cp x ${O}/*/result.json`,
      `cp x ${O}/${RUN}/e2e-artifacts/../result.json`,
      `cp x .goodboy/sandbox/o*t/${RUN}/result.json`,
      `cp x .GOODBOY/Sandbox/OUT/${RUN}/RESULT.json`,
      `cd ${O}/${RUN} && cp /tmp/forged.json result.json`,
    ]) expect([c, resultDirWrite(c, cwd) !== null]).toEqual([c, true]);
  });

  test('the goodboy commands that read the run, removing kept traces, and plain reads stay possible', () => {
    for (const c of [
      'bun "$GB/lib/cli.ts" sandbox-run --suite unit -- bun test src/a.test.ts',
      'bun "$GB/lib/cli.ts" sandbox-run --suite all',
      `bun "$GB/lib/cli.ts" coverage-check ${O}/${RUN}/coverage/jacoco.xml --root-map /work=.`,
      `bun "$GB/lib/cli.ts" ui-check --run ${RUN}`,
      `bun "$GB/lib/cli.ts" ui-check --log ${O}/${RUN}/access.log --report ${O}/${RUN}/playwright-report.json`,
      `rm -rf ${O}/${RUN}/e2e-artifacts`,
      `cat ${O}/${RUN}/result.json`,
      `jq .exit ${O}/${RUN}/result.json`,
      `ls ${O}`,
      `cp ${O}/${RUN}/access.log /tmp/`,
      `cp ${O}/${RUN}/result.json /tmp/copy.json`,
      'cp /tmp/x .goodboy/sandbox/compose.yml.bak',
    ]) expect([c, resultDirWrite(c, cwd)]).toEqual([c, null]);
  });

  test('one long word costs time linear in its length (80 KB under 50 ms)', () => {
    const words = [
      `${'.goodboy/sandbox/'}${'['.repeat(80_000)}`,
      '.goodboy/sandbox/out/'.repeat(4000),
      '.goodboy/sandbox/'.repeat(5000),
      `.goodboy/sandbox/out/${'a/'.repeat(40_000)}`,
      `.goodboy/sandbox/out/${'x'.repeat(80_000)}`,
      `${'.goodboy/sandbox/o*'.repeat(4000)}`,
    ];
    for (const w of words) {
      const t0 = performance.now();
      namesOwnResultDir(w, cwd, cwd);
      const ms = performance.now() - t0;
      expect([w.slice(0, 40), ms < 50]).toEqual([w.slice(0, 40), true]);
    }
    // and the answers are still right on such words
    expect(namesOwnResultDir(`.goodboy/sandbox/out/${'a/'.repeat(10)}../x`, cwd, cwd)).toBe(true);
    expect(namesOwnResultDir(`.goodboy/sandbox/${'['.repeat(100)}`, cwd, cwd)).toBe(false);
    expect(namesOwnResultDir(`.goodboy/sandbox/${'['.repeat(100)}/x`, cwd, cwd)).toBe(true);
    expect(namesOwnResultDir('.goodboy/sandbox/out/a/b/*', cwd, cwd)).toBe(true);
  });

  test('a word names an own result dir only inside this project', () => {
    expect(namesOwnResultDir(`${O}/${RUN}/result.json`, cwd, cwd)).toBe(true);
    expect(namesOwnResultDir(`/p/repo/${O}/${RUN}/result.json`, cwd, cwd)).toBe(true);
    expect(namesOwnResultDir(`/elsewhere/${O}/${RUN}/result.json`, cwd, cwd)).toBe(false);
    expect(namesOwnResultDir(`${O}/${RUN}/coverage/jacoco.xml`, cwd, cwd)).toBe(false);
    expect(namesOwnResultDir(`${O}/${RUN}/result.json.bak`, cwd, cwd)).toBe(false);
    expect(namesOwnResultDir('.goodboy/sandbox/outer/x', cwd, cwd)).toBe(false);
    expect(namesOwnResultDir('.claude/tests/x.json', cwd, cwd)).toBe(true);
  });
});
