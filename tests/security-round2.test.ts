import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bashChangedPaths, resultCliWrite, resultWriterDenial } from '../lib/role-limits';
import { roleOf } from '../lib/routing-policy';
import { classifyBashWrite } from '../lib/bash-write';

// G1 security review, round 2: results come from their agents, result dirs take no direct
// writes, and read-only roles cannot change files with tar/rsync/curl/ditto/git read-tree.

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-sec2-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const sid = `sec2-${Math.random().toString(36).slice(2)}`;
  const run = async (tool: string, input: Record<string, unknown>, agentType?: string, at: string = cwd) => {
    const proc = Bun.spawn(['bun', HOOK], {
      cwd: at,
      stdin: new TextEncoder().encode(
        JSON.stringify({ session_id: sid, cwd: at, tool_name: tool, tool_input: input, ...(agentType ? { agent_type: agentType, agent_id: 'a1' } : {}) }),
      ),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
  };
  return { cwd, run };
}

describe('result writers', () => {
  test('resultCliWrite and resultWriterDenial', () => {
    expect(resultCliWrite(`cat r.json | bun "${CLI}" test-write`)).toBe('test');
    expect(resultCliWrite(`bun ${CLI} review-write r.json`)).toBe('review');
    expect(resultCliWrite('bun x.ts test-write')).toBeNull();
    expect(resultWriterDenial('test', 'goodboy:test-changes', null)).toBeNull();
    expect(resultWriterDenial('test', 'goodboy:test-unit', roleOf('goodboy:test-unit'))).toBeNull();
    expect(resultWriterDenial('review', 'goodboy:review-all', roleOf('goodboy:review-all'))).toBeNull();
    expect(resultWriterDenial('test', undefined, null)).toContain('the main session may not');
    expect(resultWriterDenial('test', 'goodboy:review-all', roleOf('goodboy:review-all'))).toContain('may not');
    expect(resultWriterDenial('review', 'general-purpose', null)).toContain('may not');
  });

  test('the main session may not record results; the test agent may', async () => {
    const s = sandbox();
    const cmd = `echo '{}' | bun "${CLI}" test-write`;
    const main = await s.run('Bash', { command: cmd });
    expect(main.denied).toBe(true);
    expect(main.reason).toContain('Only goodboy test agents record test results');
    expect((await s.run('Bash', { command: cmd }, 'goodboy:test-changes')).reason).not.toContain('Only goodboy');
  });

  test('copies, moves and `$`-named redirects into result dirs are denied for everyone; mkdir is fine', async () => {
    const s = sandbox();
    for (const command of ['cp fake.json .claude/tests/r.json', 'mv fake.json .claude/reviews/', 'echo {} > ".claude/tests/f$(date +%s).json"']) {
      const r = await s.run('Bash', { command });
      expect([command, r.denied]).toEqual([command, true]);
    }
    expect((await s.run('Bash', { command: 'mkdir -p .claude/tests' })).denied).toBe(false);
    expect(classifyBashWrite('echo {} > ".claude/tests/f$(date).json"', '/proj')).toEqual(['/proj/.claude/tests/f']);
  });

  test('a Write to <root>/.claude/tests from a subdirectory is denied too', async () => {
    const s = sandbox();
    const r = await s.run('Write', { file_path: join(s.cwd, '.claude', 'tests', 'x.json'), content: '{}' }, undefined, join(s.cwd, 'src'));
    expect(r.denied).toBe(true);
    expect(r.reason).toContain('test-write');
  });
});

describe('round 3', () => {
  test('result-dir targets are normalized; a run-time CLI subcommand counts as a result write', () => {
    for (const c of ['echo {} > .claude/./tests/x.json', 'echo {} > .claude//tests/x.json', 'echo {} > .cl""aude/tests/x.json']) {
      expect([c, classifyBashWrite(c, '/proj').length]).toEqual([c, 1]);
    }
    expect(resultCliWrite(`k=test; bun "${CLI}" \${k}-write`)).toBe('unknown');
    expect(resultCliWrite(`bun "${CLI}" "$(printf test-write)"`)).toBe('unknown');
    expect(resultWriterDenial('unknown', undefined, null)).toContain('built at run time');
    expect(resultWriterDenial('unknown', 'goodboy:test-changes', null)).toBeNull();
  });

  test("a Write from the root into a package's .claude/tests is denied; another project's is not", async () => {
    const s = sandbox();
    const pkg = await s.run('Write', { file_path: join(s.cwd, 'pkg', '.claude', 'tests', 'x.json'), content: '{}' });
    expect(pkg.denied).toBe(true);
    const other = mkdtempSync(join(tmpdir(), 'goodboy-other-'));
    tmpDirs.push(other);
    expect((await s.run('Write', { file_path: join(other, '.claude', 'tests', 'x.json'), content: '{}' })).reason).not.toContain('test-write');
  });
});

describe('final review', () => {
  test('result writes inside nested shells, by globs, backslashes, interpreters or a CLI in a variable are denied', async () => {
    const s = sandbox();
    for (const command of [
      'bash -c "echo {} > .claude/tests/r.json"',
      "eval 'echo {} > .claude/reviews/r.json'",
      'cp forged.json .claude/test?/',
      'echo {} > .claude/te*s/old.json',
      'echo {} > .claude/te\\sts/n.json',
      `python3 -c "open('.claude/tests/x.json','w').write('{}')"`,
      `C=${CLI}; bun "$C" test-write`,
      `bun ${CLI} $(printf 'test-%s' write)`,
    ]) {
      const r = await s.run('Bash', { command });
      expect([command, r.denied]).toEqual([command, true]);
    }
  });

  test('reads and the read-only CLI subcommands still pass in the main session', async () => {
    const s = sandbox();
    for (const command of [
      'cat .claude/reviews/r.json',
      'ls .claude/tests 2>/dev/null',
      `bun "${CLI}" review-axes "$(git diff --name-only)"`,
      `bun "${CLI}" acceptance-list`,
      "cat <<'JSON' | jq .\n{\"command\": \"git push origin evil\"}\nJSON",
    ]) {
      const r = await s.run('Bash', { command });
      expect([command, r.denied]).toEqual([command, false]);
    }
  });
});

describe('final review, round 2: normal work passes again', () => {
  test('reads, git and a commit message that name cli.ts or a result dir pass in the main session', async () => {
    const s = sandbox();
    for (const command of [
      'cat lib/cli.ts',
      'git diff lib/cli.ts',
      'git add lib/cli.ts lib/role-limits.ts',
      'git log --oneline -- lib/cli.ts',
      'git commit -m "update cli.ts"',
      'bun src/cli.ts --help',
      'bun src/cli.ts "$TARGET"', // a project's own CLI, not goodboy's lib/cli.ts
      'diff lib/cli.ts "$OTHER"', // not run by a JS runtime
      'bun run src/cli.ts build',
      'npx tsx src/cli.ts serve',
      'sed -n 1,40p .claude/reviews/x.json',
      "awk 'NR<5' .claude/tests/x.json",
      'for f in .claude/tests/*.json; do jq .verdict "$f"; done',
      "find .claude/tests -name '*.json' -exec jq -r .verdict {} +",
      'git log --oneline -- .claude/reviews',
      'git status --short .claude/tests',
      'git commit -m "fix .claude/tests handling"',
      'echo "see .claude/tests/x.json" > /dev/null',
      'mkdir -p .claude/tests',
    ]) {
      const r = await s.run('Bash', { command });
      expect([command, r.denied, r.reason]).toEqual([command, false, '']);
    }
  });

  test("another project's result dir (a mktemp sandbox) takes Bash writes; this one's still does not", async () => {
    const s = sandbox();
    const sbx = mkdtempSync(join(tmpdir(), 'goodboy-sbx-'));
    tmpDirs.push(sbx);
    for (const command of [
      `mkdir -p ${sbx}/.claude/tests && echo '{}' > ${sbx}/.claude/tests/r.json`,
      `cp ../r.json ${sbx}/.claude/tests/`,
      "D=$(mktemp -d) && mkdir -p $D/.claude/reviews && echo '{}' > $D/.claude/reviews/x.json",
      `cd ${sbx} && echo '{}' > .claude/tests/r.json`,
    ]) {
      const r = await s.run('Bash', { command });
      expect([command, r.denied]).toEqual([command, false]);
    }
    for (const command of [
      'cd .claude/tests && echo {} > forged.json',
      'ls .claude/tests | xargs -I{} cp forged.json {}',
      'for f in .claude/tests/*.json; do cp forged.json "$f"; done',
      `echo {} > "$PWD/.claude/tests/x.json"`,
      `cat r.json | bun ${resolve(import.meta.dir, '..', 'lib')}/cli.t[s] test-write`,
    ]) {
      const r = await s.run('Bash', { command });
      // Denied by the result guard itself, not only by a later gate.
      expect([command, r.denied, /Results come only|Only goodboy test agents|built at run time/.test(r.reason)]).toEqual([command, true, true]);
    }
  });
});

describe('read-only roles and more file programs', () => {
  test('bashChangedPaths reads tar -x, unzip, curl -o, wget, rsync, ditto and git read-tree', () => {
    const cwd = '/p';
    expect(bashChangedPaths('tar -xf a.tgz', cwd)).toEqual(['/p']);
    expect(bashChangedPaths('tar xzf a.tgz -C src', cwd)).toEqual(['/p/src']);
    expect(bashChangedPaths('tar -czf /tmp/a.tgz src', cwd)).toEqual([]); // creating an archive changes nothing here
    expect(bashChangedPaths('unzip a.zip -d src', cwd)).toEqual(['/p/src']);
    expect(bashChangedPaths('curl -o src/a.ts https://x', cwd)).toEqual(['/p/src/a.ts']);
    expect(bashChangedPaths('curl https://x', cwd)).toEqual([]);
    expect(bashChangedPaths('wget -O src/a.ts https://x', cwd)).toEqual(['/p/src/a.ts']);
    expect(bashChangedPaths('rsync -a /tmp/x src/a.ts', cwd)).toEqual(['/p/src/a.ts']);
    expect(bashChangedPaths('rsync -a src/ host:/srv/', cwd)).toEqual([]); // remote target
    expect(bashChangedPaths('ditto /tmp/x src/a.ts', cwd)).toEqual(['/p/src/a.ts']);
    expect(bashChangedPaths('git read-tree -u --reset HEAD', cwd)).toEqual(['/p/.git']);
    expect(bashChangedPaths('cd /tmp && cp x y', cwd)).toEqual(['/tmp/y']);
    expect(bashChangedPaths('cp x $D/y', cwd)).toEqual([]); // unresolvable, as classifyBashWrite
  });

  test('a reviewer may not extract an archive or download into the project', async () => {
    const s = sandbox();
    for (const command of ['tar -xf /tmp/a.tgz', 'curl -o src/a.ts https://example.org/x', "bash -lc 'cp /tmp/x src/a.ts'"]) {
      const r = await s.run('Bash', { command }, 'goodboy:review-all');
      expect([command, r.denied]).toEqual([command, true]);
    }
  });
});
