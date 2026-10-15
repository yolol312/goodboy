// Gaps found in the last G1 layer-1 round, pinned down with their fixes: shell keywords at
// the start of a segment (GAP-K), `eval` scopes (GAP-E), option writers and result dirs
// (GAP-O), directory changes other than `cd` (LOW-P) and deploys after a `cd` (LOW-D).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyOutward } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { bashChangedPaths, resultCliWrite, resultDirWrite } from '../lib/role-limits';
import { spawnsClaudeCli } from '../lib/spawn-guard';
import { writesIndirectly } from '../lib/write-sweep';

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const rules = { allow: [], production: [] };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

// The same simple command inside shell compound syntax: the first word of the segment is a
//   reserved word (`then`, `do`, `else`, `{`, `!`, `if`, `while`, `until`), not the program.
const wraps = (c: string) => [
  `if true; then ${c}; fi`,
  `if false; then :; else ${c}; fi`,
  `for b in main; do ${c}; done`,
  `{ ${c}; }`,
  `f() { ${c}; }; f`,
  `! ${c}`,
  `if ${c}; then :; fi`,
  `until ${c}; do sleep 1; done`,
];

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
}

async function hook(cwd: string, base: string, command: string, agentType?: string, outward = 'off') {
  const payload = {
    session_id: `l1g-${Math.random().toString(36).slice(2)}`,
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
    env: { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: outward, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' },
  });
  const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
  await proc.exited;
  const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
  return h.permissionDecision === 'deny';
}

function tempRepo(): { base: string; cwd: string } {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-l1g-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  return { base, cwd };
}

describe('GAP-K (high): a shell reserved word at the start of a segment hides the program from every classifier', () => {
  test('handoffsOf: a push inside if/for/{ }/!/until is still a hand-off', () => {
    expect(handoffsOf('git push origin main', '/x', rules)).toHaveLength(1); // control
    for (const c of wraps('git push origin main')) {
      expect([c, handoffsOf(c, '/x', rules).length > 0]).toEqual([c, true]);
    }
  });

  test('PreToolUse (main session): an untested push inside `if … then … fi` is denied like a bare one', async () => {
    const { base, cwd } = tempRepo();
    expect(await hook(cwd, base, 'git push origin main')).toBe(true); // control
    for (const c of ['if true; then git push origin main; fi', 'for b in main; do git push origin "$b"; done', '{ git push origin main; }', '! git push origin main']) {
      expect([c, await hook(cwd, base, c)]).toEqual([c, true]);
    }
  });

  test('classifyOutward (R2): a mutating curl inside compound syntax is still outward', () => {
    const c0 = 'curl -X DELETE https://api.stripe.com/v1/customers/cus_1';
    expect(classifyOutward(c0, '/proj')).toHaveLength(1); // control
    for (const c of wraps(c0)) {
      expect([c, classifyOutward(c, '/proj').some((t) => t.mutating)]).toEqual([c, true]);
    }
  });

  test('PreToolUse (subagent, R2): an unlisted mutating curl inside `if … then … fi` is denied like a bare one', async () => {
    const { base, cwd } = tempRepo();
    const c0 = 'curl -X DELETE https://api.stripe.com/v1/customers/cus_1';
    expect(await hook(cwd, base, c0, 'general-purpose', 'on')).toBe(true); // control
    expect(await hook(cwd, base, `if true; then ${c0}; fi`, 'general-purpose', 'on')).toBe(true);
  });

  test('resultCliWrite: the result CLI inside compound syntax is still a result write', () => {
    const c0 = `bun ${CLI} test-write < r.json`;
    expect(resultCliWrite(c0)).toBe('test'); // control
    for (const c of wraps(c0)) expect([c, resultCliWrite(c)]).toEqual([c, 'test']);
  });

  test('PreToolUse (main session): `if true; then bun <CLI> test-write …; fi` is denied like a bare one', async () => {
    const { base, cwd } = tempRepo();
    expect(await hook(cwd, base, `bun ${CLI} test-write < r.json`)).toBe(true); // control
    expect(await hook(cwd, base, `if true; then bun ${CLI} test-write < r.json; fi`)).toBe(true);
  });

  test('spawnsClaudeCli / bashChangedPaths / writesIndirectly see through compound syntax', () => {
    for (const c of wraps('claude -p "fix it"')) expect([c, spawnsClaudeCli(c)]).toEqual([c, true]);
    for (const c of wraps('cp a.ts src/b.ts')) expect([c, bashChangedPaths(c, '/proj')]).toEqual([c, ['/proj/src/b.ts']]);
    for (const c of wraps('python3 gen.py')) expect([c, writesIndirectly(c)]).toEqual([c, true]);
  });

  test('PreToolUse (read-only role, spawn guard): compound syntax does not lift the limits', async () => {
    const { base, cwd } = tempRepo();
    expect(await hook(cwd, base, 'cp /etc/hosts src/a.ts', 'goodboy:research-code')).toBe(true); // control
    expect(await hook(cwd, base, 'if true; then cp /etc/hosts src/a.ts; fi', 'goodboy:research-code')).toBe(true);
    expect(await hook(cwd, base, 'claude -p "fix it"', 'goodboy:research-code')).toBe(true); // control
    expect(await hook(cwd, base, '{ claude -p "fix it"; }', 'goodboy:research-code')).toBe(true);
  });
});

describe('LOW-P: directory changes other than a literal `cd` are followed or make the push unclear', () => {
  test('handoffsOf: pushd / builtin cd / env -C move the push, or make it unclear', () => {
    for (const c of ['pushd ../B && git push origin main', 'builtin cd ../B && git push origin main', 'env -C ../B git push origin main']) {
      const h = handoffsOf(c, '/x/A', rules)[0];
      expect([c, h?.cwd === '/x/B' || h?.unclear !== undefined]).toEqual([c, true]);
    }
    // The pushd stack is followed: popd goes back to A (last review: it was unclear).
    const back = handoffsOf('pushd ../B && git status && popd && git push origin main', '/x/A', rules)[0];
    expect([back?.cwd, back?.unclear]).toEqual(['/x/A', undefined]);
    // A rotation or a popd past what goodboy saw is unclear; `pushd -n` does not move.
    for (const c of ['pushd && git push origin main', 'pushd +1 && git push origin main', 'popd && git push origin main']) {
      expect([c, handoffsOf(c, '/x/A', rules)[0]?.unclear]).toEqual([c, expect.any(String)]);
    }
    expect(handoffsOf('pushd -n ../B && git push origin main', '/x/A', rules).map((h) => [h.cwd, h.unclear ?? null])[0]).toEqual(['/x/A', null]);
    // GNU `env --chdir dir` (separate value) runs elsewhere too: in that literal dir.
    expect(handoffsOf('env --chdir ../B git push origin main', '/x/A', rules)[0]).toMatchObject({ cwd: '/x/B' });
    expect(handoffsOf('env -C "$(echo ../B)" git push origin main', '/x/A', rules)[0]?.unclear).toContain('cannot follow');
  });
});

async function recordPass(repo: string, base: string) {
  const result = {
    tested_files: [join(repo, 'src', 'a.ts')],
    category: 'add-feature',
    test_files: [join(repo, 'a.test.ts')],
    environment: { mode: 'local' },
    suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
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

function twoRepos(): { base: string; A: string; B: string } {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-l1g-'));
  tmpDirs.push(base);
  const mk = (dir: string, content: string) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'src', 'a.ts'), content);
    writeFileSync(join(dir, 'a.test.ts'), 'test("a", () => {});\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
  };
  const A = join(base, 'A');
  const B = join(base, 'B');
  mk(A, 'export const a = 1;\n');
  mk(B, 'export const b = "untested";\n');
  return { base, A, B };
}

describe('GAP-E (medium, regression of the scope rewrite): `eval` segments keep the cd scope', () => {
  test('handoffsOf: a push run by eval after `cd ../B` runs in B; an eval-ed cd moves the shell', () => {
    for (const c of [
      'cd ../B && eval "git push origin main"',
      'cd ../B && eval git push origin main',
      'eval "cd ../B" && git push origin main',
      'eval cd ../B; git push origin main',
    ]) {
      const h = handoffsOf(c, '/x/A', rules)[0];
      expect([c, h?.cwd === '/x/B' || h?.unclear !== undefined]).toEqual([c, true]);
    }
  });

  test("PreToolUse: A's passing result does not let B's untested main through `eval`", async () => {
    const { base, A } = twoRepos();
    await recordPass(A, base);
    expect(await hook(A, base, 'git push origin main')).toBe(false); // A itself is tested
    expect(await hook(A, base, 'cd ../B && git push origin main')).toBe(true); // control
    expect(await hook(A, base, 'cd ../B && eval "git push origin main"')).toBe(true);
  });
});

describe('GAP-O (medium): option writers that write into the cwd, after `cd` into a result dir, and curl flag clusters', () => {
  test('resultDirWrite', () => {
    expect(resultDirWrite('cd .claude/tests && cp /tmp/forged.json x.json', '/proj')).not.toBeNull(); // control
    for (const c of [
      'cd .claude/tests && tar -xf /tmp/r.tgz',
      'cd .claude/tests && unzip -o /tmp/r.zip',
      'cd .claude/tests && curl -O file:///tmp/x.json',
      'cd .claude/tests && wget http://127.0.0.1:8000/x.json',
      'curl -so .claude/tests/x.json file:///tmp/f.json',
      'curl -sSLo .claude/tests/x.json file:///tmp/f.json',
      'cp -t.claude/tests forged.json',
      'ls .claude/tests/*.json | xargs sed -i "" s/fail/pass/',
      'ls .claude/tests/*.json | xargs perl -pi -e s/fail/pass/',
    ]) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
    // A GNU `-i` replace string is `{}`: copying out stays a read.
    expect(resultDirWrite('ls .claude/tests/*.json | xargs -i cp {} /tmp/bk/', '/proj')).toBeNull();
    expect(resultDirWrite('ls .claude/tests | xargs -i cp forged.json {}', '/proj')).not.toBeNull();
  });

  test('PreToolUse (main session): `cd .claude/tests && tar -xf …` is denied like `tar -xf … -C .claude/tests`', async () => {
    const { base, cwd } = tempRepo();
    expect(await hook(cwd, base, 'tar -xf /tmp/r.tgz -C .claude/tests')).toBe(true); // control
    expect(await hook(cwd, base, 'cd .claude/tests && tar -xf /tmp/r.tgz')).toBe(true);
    expect(await hook(cwd, base, 'curl -so .claude/tests/x.json file:///tmp/f.json')).toBe(true);
  });

  test('bashChangedPaths (role limits): curl flag clusters name the file they write', () => {
    expect(bashChangedPaths('curl -s -o src/a.ts https://example.com/a', '/proj')).toEqual(['/proj/src/a.ts']); // control
    expect(bashChangedPaths('curl -sSLo src/a.ts https://example.com/a', '/proj')).toEqual(['/proj/src/a.ts']);
  });
});

describe('LOW-D: a deploy after `cd` compares the repo it ships', () => {
  test('handoffsOf', () => {
    const { A } = twoRepos();
    const h = handoffsOf('cd ../B && npm publish', A, rules)[0];
    expect(h?.kind).toBe('deploy');
    expect([h?.cwd === join(A, '..', 'B') || h?.unclear !== undefined]).toEqual([true]);
    expect(handoffsOf('cd - && npm publish', A, rules)[0]?.unclear).toBeDefined();
  });
});
