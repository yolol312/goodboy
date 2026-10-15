// The last G1 layer-1 round's gaps, pinned down with their fixes: deploys compared where they
// run (GAP-D2), `function f { … }` bodies (GAP-F), cd scopes in the result guard and role limits
// (GAP-RS), sibling nested shells (GAP-NS), more option writers (GAP-OD), the "inside a result
// dir" state per segment (LOW-FP) and more prefix words (LOW-PF). Writes into a parent of the
// result dirs (`tar -x -C .claude`, `cp -r … .claude/`) are a known limit (plan §10.10).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyOutward, readCommand } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { bashChangedPaths, resultCliWrite, resultDirWrite } from '../lib/role-limits';
import { spawnsClaudeCli } from '../lib/spawn-guard';

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const rules = { allow: [], production: [] };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
}

async function hook(cwd: string, base: string, command: string, agentType?: string) {
  const payload = {
    session_id: `l1h-${Math.random().toString(36).slice(2)}`,
    cwd,
    ...(agentType ? { agent_type: agentType, agent_id: 'a1' } : {}),
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  };
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' },
  });
  const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
  await proc.exited;
  const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
  return h.permissionDecision === 'deny';
}

function mk(dir: string, content: string) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'src', 'a.ts'), content);
  writeFileSync(join(dir, 'a.test.ts'), 'test("a", () => {});\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"l1h-pkg","version":"0.0.1"}\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
}

function twoRepos(): { base: string; A: string; B: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-l1h-')));
  tmpDirs.push(base);
  const A = join(base, 'A');
  const B = join(base, 'B');
  mk(A, 'export const a = 1;\n');
  mk(B, 'export const b = "untested";\n');
  return { base, A, B };
}

async function recordPass(repo: string, base: string) {
  const result = {
    tested_files: [join(repo, 'src', 'a.ts')],
    category: 'add-feature',
    test_files: [join(repo, 'a.test.ts')],
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass' }],
    acceptance: [
      { id: 'AC-1', description: 'a', test: 'a.test.ts', red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 }, green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 } },
    ],
    verdict: 'pass',
  };
  const proc = Bun.spawn(['bun', CLI, 'test-write'], { cwd: repo, env: { ...process.env, TMPDIR: base }, stdin: new TextEncoder().encode(JSON.stringify(result)), stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  expect(JSON.parse(readFileSync(JSON.parse(out).path, 'utf8')).tree).toMatch(/^[0-9a-f]{40}/);
}

describe('GAP-D2: a deploy is compared where it runs, not where the command ends', () => {
  test('handoffsOf: a cd after the deploy neither drops it nor moves it', () => {
    const { A, B } = twoRepos();
    expect(handoffsOf('npm publish', A, rules).filter((h) => h.kind === 'deploy')).toHaveLength(1); // control
    for (const c of ['npm publish && cd /tmp', 'npm publish && cd ..', 'kubectl apply -f k.yaml && cd ..', 'docker push ghcr.io/me/app:1 && cd /tmp']) {
      const d = handoffsOf(c, A, rules).filter((h) => h.kind === 'deploy');
      expect([c, d.length === 1 && (d[0]!.cwd === A || d[0]!.unclear !== undefined)]).toEqual([c, true]);
    }
    const d = handoffsOf('cd ../B && npm publish && cd ../A', A, rules).filter((h) => h.kind === 'deploy');
    expect([d[0]?.cwd === B || d[0]?.unclear !== undefined]).toEqual([true]);
    const e = handoffsOf('npm publish && cd ../B', A, rules).filter((h) => h.kind === 'deploy');
    expect([e[0]?.cwd === A || e[0]?.unclear !== undefined]).toEqual([true]);
  });

  test('PreToolUse (main session): an untested `npm publish && cd /tmp` is denied like `npm publish`', async () => {
    const { base, B } = twoRepos();
    expect(await hook(B, base, 'npm publish')).toBe(true); // control: B is untested
    expect(await hook(B, base, 'npm publish && cd /tmp')).toBe(true);
  });
});

describe('GAP-F: a `function name { … }` body is read by every classifier', () => {
  const fn = (c: string) => `function f { ${c}; }; f`;
  test('the shared reader: push, R2, result CLI, claude -p, role limits, result dir', () => {
    expect(handoffsOf(`function f() { git push origin main; }; f`, '/x', rules)).toHaveLength(1); // control: the () form
    expect(handoffsOf(fn('git push origin main'), '/x', rules)).toHaveLength(1);
    expect(classifyOutward(fn('curl -X DELETE https://api.stripe.com/v1/customers/cus_1'), '/proj').some((t) => t.mutating)).toBe(true);
    expect(resultCliWrite(fn(`bun ${CLI} test-write < r.json`))).toBe('test');
    expect(spawnsClaudeCli(fn('claude -p "fix it"'))).toBe(true);
    expect(bashChangedPaths(fn('cp a.ts src/b.ts'), '/proj')).toEqual(['/proj/src/b.ts']);
    expect(resultDirWrite(fn('cp /tmp/f.json .claude/tests/x.json'), '/proj')).not.toBeNull();
  });

  test('PreToolUse (main session): an untested push inside `function f { … }` is denied like a bare one', async () => {
    const { base, B } = twoRepos();
    expect(await hook(B, base, 'git push origin main')).toBe(true); // control
    expect(await hook(B, base, 'function f { git push origin main; }; f')).toBe(true);
  });
});

describe('GAP-RS: the result guard and role limits follow cd scopes (`( … )`, `sh -c`, `cd -`, pushd)', () => {
  test('resultDirWrite: a cd that does not move the shell does not move the check', () => {
    expect(resultDirWrite('cp /tmp/f.json .claude/tests/x.json', '/proj')).not.toBeNull(); // control
    for (const c of [
      '(cd /tmp) && cp /tmp/f.json .claude/tests/x.json',
      '(cd /tmp) && echo {} > .claude/tests/x.json',
      'sh -c "cd /tmp"; cp /tmp/f.json .claude/tests/x.json',
      'cd /tmp; cd -; cp /tmp/f.json .claude/tests/x.json',
      'pushd .claude/tests && cp /tmp/f.json x.json',
    ]) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
  });

  test('bashChangedPaths: a subshell cd or pushd does not move the project write outside the project', () => {
    expect(bashChangedPaths('cp /etc/hosts src/a.ts', '/proj')).toEqual(['/proj/src/a.ts']); // control
    for (const c of ['(cd /tmp) && cp /etc/hosts src/a.ts', 'sh -c "cd /tmp"; cp /etc/hosts src/a.ts', 'pushd docs && cp /etc/hosts ../src/a.ts']) {
      expect([c, bashChangedPaths(c, '/proj')]).toEqual([c, ['/proj/src/a.ts']]);
    }
  });

  test('PreToolUse: no forged result from the main session, no src/ write from a read-only role', async () => {
    const { base, A } = twoRepos();
    expect(await hook(A, base, 'cp /tmp/f.json .claude/tests/x.json')).toBe(true); // control
    expect(await hook(A, base, '(cd /tmp) && cp /tmp/f.json .claude/tests/x.json')).toBe(true);
    expect(await hook(A, base, 'cp /etc/hosts src/a.ts', 'goodboy:research-code')).toBe(true); // control
    expect(await hook(A, base, '(cd /tmp) && cp /etc/hosts src/a.ts', 'goodboy:research-code')).toBe(true);
    expect(await hook(A, base, 'pushd docs && cp /etc/hosts ../src/a.ts', 'goodboy:research-code')).toBe(true);
  });
});

describe('GAP-NS: sibling nested shells and evals each get their own scope', () => {
  test('handoffsOf', () => {
    expect(handoffsOf('cd ../B && sh -c "git push origin main"', '/x/A', rules)[0]?.cwd).toBe('/x/B'); // control
    const cases: [string, string][] = [
      ['sh -c "git status"; cd ../B; sh -c "git push origin main"', '/x/B'],
      ['eval "(git status)"; cd ../B; eval "(git push origin main)"', '/x/B'],
      ['bash -c "cd ../B"; bash -c "git push origin main"', '/x/A'],
      ['eval "(cd ../B)"; eval "(git push origin main)"', '/x/A'],
      ['sh -c "(cd ../B)"; sh -c "(git push origin main)"', '/x/A'],
    ];
    for (const [c, want] of cases) {
      const h = handoffsOf(c, '/x/A', rules)[0];
      expect([c, h?.cwd === want || h?.unclear !== undefined]).toEqual([c, true]);
    }
  });

  test("PreToolUse: A's passing result does not let B's untested main through a sibling nested shell", async () => {
    const { base, A } = twoRepos();
    await recordPass(A, base);
    expect(await hook(A, base, 'cd ../B && sh -c "git push origin main"')).toBe(true); // control
    expect(await hook(A, base, 'sh -c "git status"; cd ../B; sh -c "git push origin main"')).toBe(true);
  });
});

describe('GAP-OD: writers whose target is not the result dir word itself', () => {
  test('resultDirWrite', () => {
    expect(resultDirWrite('curl -o .claude/tests/x.json file:///tmp/x.json', '/proj')).not.toBeNull(); // control
    for (const c of [
      'curl -O --output-dir .claude/tests file:///tmp/x.json',
      'curl -o x.json --output-dir=.claude/tests file:///tmp/x.json',
      'cp -vt .claude/tests forged.json',
      'install -Dt .claude/tests forged.json',
      'gtar -xf /tmp/r.tgz -C .claude/tests',
      'cat /tmp/f.json | sponge .claude/tests/x.json',
    ]) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
  });
});

describe('LOW-FP: "inside a result dir" holds only while the shell is there', () => {
  test('resultDirWrite', () => {
    expect(resultDirWrite('cd .claude/tests && cp /tmp/f.json x.json', '/proj')).not.toBeNull(); // control
    for (const c of [
      'cd .claude/tests && ls && cd ../.. && cp a.ts b.ts',
      '(cd .claude/tests && ls -t | head -1) && cp a.ts b.ts',
      'cd .claude/tests; cd /proj; touch notes.txt',
      'ls .claude/tests/*.json | xargs -J % cp % /tmp/bk/', // BSD xargs -J (macOS): copying out is a read
    ]) {
      expect([c, resultDirWrite(c, '/proj')]).toEqual([c, null]);
    }
  });

  test('PreToolUse (main session): `cd .claude/tests && ls && cd ../.. && cp a.ts b.ts` passes', async () => {
    const { base, A } = twoRepos();
    expect(await hook(A, base, 'cp src/a.ts src/b.ts')).toBe(false); // control
    expect(await hook(A, base, 'cd .claude/tests && ls && cd ../.. && cp src/a.ts src/b.ts')).toBe(false);
  });
});

describe('LOW-PF: more prefix words', () => {
  test('coproc / noglob (zsh) / exec -a / pushd -n', () => {
    for (const c of ['coproc git push origin main', 'noglob git push origin main', 'exec -a x git push origin main']) {
      expect([c, handoffsOf(c, '/x', rules).length]).toEqual([c, 1]);
    }
    // `pushd -n` adds to the stack without changing dir: the push runs in A.
    const h = handoffsOf('pushd -n ../B && git push origin main', '/x/A', rules)[0];
    expect([h?.cwd === '/x/A' || h?.unclear !== undefined]).toEqual([true]);
  });
});

describe('security-injection review: the reader has a budget', () => {
  test('a `find -exec find …` chain without terminators reads in linear time', () => {
    const cmd = `${Array.from({ length: 200 }, () => 'find -exec').join(' ')} true >/dev/null 2>&1; git push origin main`;
    const started = Date.now();
    expect(handoffsOf(cmd, '/x', rules).length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('PreToolUse denies a command over the segment budget instead of timing out', async () => {
    const { base, A } = twoRepos();
    const huge = Array.from({ length: 6000 }, (_, i) => `echo ${i}`).join('; ');
    const started = Date.now();
    expect(await hook(A, base, huge)).toBe(true);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await hook(A, base, Array.from({ length: 200 }, (_, i) => `echo ${i}`).join('; '))).toBe(false); // a long, normal command
  }, 40_000);

  test('the result-dir prefix scan is linear on a long word', () => {
    const word = `${'a'.repeat(30_000)}/.claude/tests/x.json`;
    const started = Date.now();
    expect(resultDirWrite(`cp f ${word}`, '/proj')).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    // A delimiter right before the result dir: a `[^…]*$` search retries from every start.
    const delimited = `${'a'.repeat(30_000)}=/.claude/tests/x.json`;
    const again = Date.now();
    expect(resultDirWrite(`cp f ${delimited}`, '/proj')).not.toBeNull();
    expect(Date.now() - again).toBeLessThan(500);
  });

  test('a `find -exec` with no terminator is read once, not once per later `-exec`', () => {
    // Four finds and the `true` they end in: five segments, each read once.
    const cmd = `${Array.from({ length: 4 }, () => 'find -exec').join(' ')} true`;
    const read = readCommand(cmd, '/x');
    expect([read.segments.length, read.truncated]).toEqual([5, false]);
  });

  test('a push past the budget is unclear, not dropped with the unread rest', () => {
    const huge = `${Array.from({ length: 6000 }, (_, i) => `echo ${i}`).join('; ')}; git push origin main`;
    expect(handoffsOf(huge, '/x', rules)[0]?.unclear).toContain('too large or nested');
  });

  test('PreToolUse names the budget as the reason, with the push check off', async () => {
    const { base, A } = twoRepos();
    const huge = Array.from({ length: 6000 }, (_, i) => `echo ${i}`).join('; ');
    const payload = { session_id: `l1h-${Math.random().toString(36).slice(2)}`, cwd: A, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: huge } };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd: A,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: 'off', GOODBOY_PUSH_TEST_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain('too large or nested for goodboy to read');
  }, 40_000);
});

describe('final G1 layer-1 record: the budget holds across nested readings', () => {
  const echoes = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join('; ');

  test('`sh -c` and `eval` scripts spend the same budget as the command around them', () => {
    expect(readCommand(`sh -c "${echoes(100)}"`, '/x').truncated).toBe(false); // control
    for (const c of [`sh -c "${echoes(6000)}"`, `eval "${echoes(6000)}"`, `bash -lc 'true; ${echoes(6000)}'`]) {
      expect([c.slice(0, 16), readCommand(c, '/x').truncated]).toEqual([c.slice(0, 16), true]);
    }
  });

  test('two sibling nested shells under the budget each still add up past it', () => {
    expect(readCommand(`sh -c "${echoes(2000)}"; sh -c "${echoes(2000)}"`, '/x').truncated).toBe(false); // control
    expect(readCommand(`sh -c "${echoes(3000)}"; sh -c "${echoes(3000)}"`, '/x').truncated).toBe(true);
    const h = handoffsOf(`sh -c "${echoes(3000)}"; eval "${echoes(3000)}; git push origin main"`, '/x', rules);
    expect(h[0]?.unclear).toContain('too large or nested');
  });

  test('the result-dir prefix scan is linear on a 100 KB delimited word (a quadratic scan takes seconds)', () => {
    const word = `${'a'.repeat(100_000)}=/.claude/tests/x.json`;
    const started = Date.now();
    expect(resultDirWrite(`cp f ${word}`, '/proj')).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
