import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkHandoff, handoffsOf, isHandoffSkill, revisionTree, treeDiff, workTreeState, WORKTREE } from '../lib/push-test';
import type { TestResult } from '../lib/types';

// Track G push test check (lib/push-test.ts, PreToolUse A0.87): a hand-off needs a passing
// layer-1 result whose tested tree (recorded by `cli.ts test-write`) is the tree handed off.

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** The red-green evidence the Stop test gate (and so the push check) asks for. */
const RED_GREEN = [
  {
    id: 'AC-1',
    description: 'add() adds',
    test: 'a.test.ts',
    red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
    green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
  },
];

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

/** A temp git repo with one commit, `src/a.ts` and a test file; `.claude/` is not ignored. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-push-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'a.test.ts'), 'test("a", () => {});\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  const sid = `push-${Math.random().toString(36).slice(2)}`;
  const env = { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: 'off' } as Record<string, string>;

  const record = async (verdict: string, extra: Record<string, unknown> = {}) => {
    const result = {
      tested_files: [join(cwd, 'src', 'a.ts')],
      category: 'add-feature',
      test_files: [join(cwd, 'a.test.ts')],
      environment: { mode: 'local' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: RED_GREEN,
      verdict,
      ...extra,
    };
    const proc = Bun.spawn(['bun', CLI, 'test-write'], { cwd, env, stdin: new TextEncoder().encode(JSON.stringify(result)), stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) throw new Error(err);
    return JSON.parse(readFileSync(JSON.parse(out).path, 'utf8')) as TestResult;
  };

  const run = async (tool: { name: string; input: Record<string, unknown> }, opts: { sub?: boolean; env?: Record<string, string> } = {}) => {
    const payload = {
      session_id: sid,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: tool.name,
      tool_input: tool.input,
      ...(opts.sub ? { agent_type: 'goodboy:build-backend', agent_id: 'b1' } : {}),
    };
    const proc = Bun.spawn(['bun', HOOK], { cwd, stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: 'pipe', stderr: 'pipe', env: { ...env, ...(opts.env ?? {}) } });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '', context: h.additionalContext ?? '', system: String(out.systemMessage ?? '') };
  };
  const bash = (command: string, opts: { sub?: boolean; env?: Record<string, string> } = {}) => run({ name: 'Bash', input: { command } }, opts);
  const marker = (kind: string) => join(cwd, '.claude', `.goodboy-${kind}-approved-${sid.slice(0, 8)}.txt`);
  const approve = (kind: string) => {
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(marker(kind), '');
  };
  return { cwd, sid, record, run, bash, marker, approve };
}

describe('handoffsOf', () => {
  const rules = { allow: ['staging.corp.net'], production: [] };
  test('git push forms', () => {
    const cwd = '/x';
    expect(handoffsOf('git push', cwd, rules)[0]).toMatchObject({ kind: 'push', revs: ['HEAD'] });
    expect(handoffsOf('git push -u origin feature', cwd, rules)[0]!.revs).toEqual(['feature']);
    expect(handoffsOf('git push origin HEAD:refs/heads/x +v1.2:v1.2', cwd, rules)[0]!.revs).toEqual(['HEAD', 'v1.2']);
    expect(handoffsOf('git -C sub push origin main', cwd, rules)[0]).toMatchObject({ cwd: '/x/sub', revs: ['main'] });
    expect(handoffsOf('cd x && git push origin main', cwd, rules)).toHaveLength(1);
  });

  test('pushes of every branch or tag are unclear: goodboy cannot tell what goes out', () => {
    for (const c of ['git push --tags origin', 'git push origin feature --tags', 'git push --all', 'git push --mirror origin', 'git push --branches']) {
      expect([c, handoffsOf(c, '/x', rules)[0]?.unclear]).toEqual([c, 'it pushes every branch or tag']);
    }
  });

  test('option parsing (security review): -o values, --signed, short clusters', () => {
    expect(handoffsOf('git push -onotest origin evil', '/x', rules)[0]!.revs).toEqual(['evil']); // not a dry run
    expect(handoffsOf('git push -o ci.skip origin evil', '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf('git push --signed origin evil', '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf('git push -fu origin evil', '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf('git push -nv origin evil', '/x', rules)).toEqual([]); // -n: dry run
    expect(handoffsOf('git push -d origin old', '/x', rules)).toEqual([]); // deletion
  });

  test('round-2 security review: what a push sends cannot be read from the text → unclear', () => {
    const unclear = (c: string, cwd = '/x') => handoffsOf(c, cwd, rules)[0]?.unclear ?? null;
    expect(unclear('git push origin $(echo evil)')).toBe('its refs come from a command substitution');
    expect(unclear('git push origin `echo evil`')).toBe('its refs come from a command substitution');
    expect(unclear('cd "$(git rev-parse --show-toplevel)" && git push origin main')).toBeNull(); // before the push: fine
    expect(unclear('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git push origin main')).toBe('its git config or repository comes from the environment or another file');
    expect(unclear('git -c remote.origin.mirror=true push origin')).toBe('git config decides which refs it pushes');
    expect(unclear('git -c push.default=matching push origin')).toBe('git config decides which refs it pushes');
    const r = repo();
    git(r.cwd, 'config', 'remote.origin.url', 'https://example.org/r.git');
    expect(unclear('git push origin', r.cwd)).toBeNull();
    git(r.cwd, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/*');
    expect(unclear('git push origin', r.cwd)).toBe('git config decides which refs it pushes');
    expect(unclear('git push origin main', r.cwd)).toBeNull(); // an explicit refspec wins
    expect(handoffsOf("bash -lc 'git push origin evil'", '/x', rules)[0]!.revs).toEqual(['evil']);
  });

  test('round-3 security review: launchers, other shells, stdin scripts, other repos, alias case', () => {
    expect(handoffsOf('echo origin evil | xargs git push', '/x', rules)[0]?.unclear).toBe('its arguments come from xargs');
    expect(handoffsOf('find . -maxdepth 0 -exec git push origin evil \\;', '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf("tcsh -c 'git push origin evil'", '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf('echo "git push origin evil" | sh', '/x', rules)[0]?.unclear).toBe('it feeds a script to a shell on stdin');
    expect(handoffsOf('bash <<< "git push origin evil"', '/x', rules)[0]?.unclear).toBe('it feeds a script to a shell on stdin');
    expect(handoffsOf('cd ../other && git push origin main', '/x/repo', rules)[0]).toMatchObject({ cwd: '/x/other', revs: ['main'] });
    expect(handoffsOf('git -c alias.P=push P origin evil', '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin evil', '/x', rules)[0]?.unclear).toBe(
      'its git config or repository comes from the environment or another file',
    );
    expect(handoffsOf('git --config-env=alias.p=P p origin evil', '/x', rules)[0]?.unclear).toBe('its git config or repository comes from the environment or another file');
    const many = Array.from({ length: 11 }, (_, i) => `git push origin b${i}`).join('; ');
    expect(handoffsOf(many, '/x', rules)[0]?.unclear).toBe('it hands off too many refs to check');
  });

  test('final G1 review: commands that only mention push, xargs, a shell or git env are no hand-offs', () => {
    for (const c of [
      'git rev-parse --git-dir',
      'git rev-parse --git-dir >/dev/null 2>&1 && echo in-repo',
      'git status && echo HOME=$HOME',
      'GIT_DIR=.git git log -1',
      'git --git-dir=.git log --oneline -1',
      "git commit -m \"$(cat <<'EOF'\nfix(g1): the push check reads xargs and find -exec\n\nCo-Authored-By: x\nEOF\n)\"",
      'echo "push the branch; then xargs"',
      "rg -n 'xargs' lib/push-test.ts | head  # push",
      'git diff --name-only | grep push-test | xargs wc -l',
      "ls tests/*.test.ts | grep -E 'push|outward' | xargs bun test",
      "cat > scripts/release.sh <<'EOF'\ngit push origin main\nEOF",
      "git commit -F - <<'EOF'\nsee push.sh <<\nEOF",
    ]) {
      expect([c, handoffsOf(c, '/x', rules)]).toEqual([c, []]);
    }
    // A substitution elsewhere in the command is not the push's.
    expect(handoffsOf('git push origin main && echo "done $(date)"', '/x', rules)[0]).toMatchObject({ revs: ['main'] });
    expect(handoffsOf('cd -P sub && git push origin main', '/x', rules)[0]).toMatchObject({ cwd: '/x/sub', revs: ['main'] });
  });

  test('final G1 review: env, repo flags, stdin shells and xargs still make a push unclear', () => {
    const elsewhere = 'its git config or repository comes from the environment or another file';
    const unclear = (c: string) => handoffsOf(c, '/x', rules)[0]?.unclear ?? null;
    expect(unclear('GIT_DIR=.git git push origin main')).toBe(elsewhere);
    expect(unclear('export HOME=/tmp/h; git push origin main')).toBe(elsewhere);
    expect(unclear('HOME=/tmp/h; git p origin main')).toBe(elsewhere); // an alias from that HOME
    expect(unclear('env XDG_CONFIG_HOME=/tmp/c git push origin main')).toBe(elsewhere);
    expect(unclear('git --git-dir=/tmp/o.git push origin main')).toBe(elsewhere);
    expect(unclear('git --work-tree /tmp/w push origin main')).toBe(elsewhere);
    expect(unclear("bash -s <<'EOF'\ngit push origin evil\nEOF")).toBe('it feeds a script to a shell on stdin');
    expect(unclear('printf "git push origin evil" | /bin/zsh')).toBe('it feeds a script to a shell on stdin');
    expect(unclear('echo evil | xargs -n1 git push origin')).toBe('its arguments come from xargs');
    expect(unclear("sh -c 'git push origin $(git branch --show-current)'")).toBe('its refs come from a command substitution');
  });

  test('an unclear push stops the reading at once (final G1 review: push.default=matching took 20 s for 100 segments)', () => {
    const r = repo();
    git(r.cwd, 'config', 'push.default', 'matching');
    const cmd = Array.from({ length: 100 }, (_, i) => `git push r${i}`).join('; ');
    const started = Date.now();
    expect(handoffsOf(cmd, r.cwd, rules)[0]?.unclear).toBe('git config decides which refs it pushes');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a command of many unknown git subcommands stops after the alias-lookup budget', () => {
    const r = repo();
    const cmd = Array.from({ length: 30 }, (_, i) => `git zz${i}`).join('; ') + '; git push origin main';
    const started = Date.now();
    expect(handoffsOf(cmd, r.cwd, rules)[0]?.unclear).toBe('it runs too many unknown git commands to check');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('wrappers: sh -c, eval and git aliases (inline and configured)', () => {
    expect(handoffsOf("sh -c 'git push origin evil'", '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf('bash -c "cd . && git push"', '/x', rules)[0]!.revs).toEqual(['HEAD']);
    expect(handoffsOf('eval git push origin evil', '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf('git -c alias.p=push p origin evil', '/x', rules)[0]!.revs).toEqual(['evil']);
    expect(handoffsOf("git -c 'alias.p=!git push origin evil' p", '/x', rules)[0]!.revs).toEqual(['evil']);
    const r = repo();
    git(r.cwd, 'config', 'alias.shipit', 'push origin');
    expect(handoffsOf('git shipit main', r.cwd, rules)[0]!.revs).toEqual(['main']);
    expect(handoffsOf('git status', r.cwd, rules)).toEqual([]);
  });

  test('redirections are not refspecs (live probe: `git push origin main 2>&1` was read as ref `2>`)', () => {
    for (const c of ['git push origin main 2>&1', 'git push origin main > /tmp/log 2>&1', 'git push origin main &>/dev/null', 'git push origin main 2>/dev/null | tail -3']) {
      expect([c, handoffsOf(c, '/x', rules).map((h) => h.revs)]).toEqual([c, [['main']]]);
    }
    expect(handoffsOf('git push 2>&1', '/x', rules)[0]!.revs).toEqual(['HEAD']);
  });

  test('dry runs, deletions and other git commands hand nothing off', () => {
    for (const c of ['git push --dry-run', 'git push -n origin x', 'git push origin --delete x', 'git push origin :old', 'git status', 'git pull', 'echo git push']) {
      expect([c, handoffsOf(c, '/x', rules)]).toEqual([c, []]);
    }
  });

  test('MR/PR creation; other forge commands are not hand-offs', () => {
    expect(handoffsOf('gh pr create --fill', '/x', rules)[0]).toMatchObject({ kind: 'mr', revs: ['HEAD'] });
    expect(handoffsOf('gh pr create --head feat/a --base develop', '/x', rules)[0]!.revs).toEqual(['feat/a']);
    expect(handoffsOf('glab mr create --source-branch=feat/b -t x', '/x', rules)[0]!.revs).toEqual(['feat/b']);
    expect(handoffsOf('gh pr -R owner/repo create --fill', '/x', rules)[0]).toMatchObject({ kind: 'mr' });
    expect(handoffsOf('glab mr -R g/p create', '/x', rules)[0]).toMatchObject({ kind: 'mr' });
    expect(handoffsOf('gh pr list', '/x', rules)).toEqual([]);
    expect(handoffsOf('gh issue create -t x', '/x', rules)).toEqual([]);
  });

  test('deploys toward hosts that are neither local nor allow, inside a git repo only', () => {
    const r = repo();
    expect(handoffsOf('kubectl apply -f k8s.yaml', r.cwd, rules)[0]).toMatchObject({ kind: 'deploy', revs: [WORKTREE] });
    expect(handoffsOf('npm publish', r.cwd, rules)[0]!.kind).toBe('deploy');
    expect(handoffsOf('kubectl --context kind-dev apply -f k.yaml', r.cwd, rules)).toEqual([]); // local cluster
    expect(handoffsOf('rsync -a dist/ staging.corp.net:/srv', r.cwd, rules)).toEqual([]); // allow-listed
    expect(handoffsOf('kubectl get pods', r.cwd, rules)).toEqual([]); // a read
    expect(handoffsOf('curl -X POST https://api.example.org/x', r.cwd, rules)).toEqual([]); // not a deploy
    expect(handoffsOf('ssh prod.corp.net uptime', r.cwd, rules)).toEqual([]);
    expect(handoffsOf('kubectl apply -f k.yaml', tmpdir(), rules)).toEqual([]); // no repo, no commit
  });

  test('isHandoffSkill', () => {
    for (const s of ['ship', 'land-and-deploy', 'gstack:ship', 'x:land-and-deploy']) expect(isHandoffSkill(s)).toBe(true);
    for (const s of ['shipit', 'review', 'gstack:qa', 'ship-notes']) expect(isHandoffSkill(s)).toBe(false);
  });
});

describe('workTreeState and checkHandoff', () => {
  test('the tested tree equals the commit made from it; an edit changes it; artifacts do not count', async () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(r.cwd, 'src', 'b.ts'), 'export const b = 1;\n'); // untracked, then committed
    const tested = workTreeState(r.cwd);
    mkdirSync(join(r.cwd, '.claude', 'tests'), { recursive: true });
    writeFileSync(join(r.cwd, '.claude', 'tests', 'x.json'), '{}');
    writeFileSync(join(r.cwd, '.claude', '.goodboy-stop-approved-x.txt'), '');
    expect(workTreeState(r.cwd).tree).toBe(tested.tree);
    git(r.cwd, 'add', 'src');
    git(r.cwd, 'commit', '-q', '-m', 'change');
    expect(revisionTree(r.cwd, 'HEAD')).toBe(tested.tree);
    expect(tested.commit).not.toBe(git(r.cwd, 'rev-parse', 'HEAD')); // tested before the commit
    // The user's own index is untouched by the computation.
    expect(git(r.cwd, 'status', '--porcelain')).toContain('?? .claude/');
    writeFileSync(join(r.cwd, 'src', 'a.ts'), 'export const a = 3;\n');
    expect(workTreeState(r.cwd).tree).not.toBe(tested.tree);
  });

  test('a repo that ignores .claude/ (like this one) still gets a tree (layer-1 round: the exclude pathspecs made `git add` fail)', async () => {
    const r = repo();
    writeFileSync(join(r.cwd, '.gitignore'), '.claude/*\n');
    git(r.cwd, 'add', '.gitignore');
    git(r.cwd, 'commit', '-q', '-m', 'ignore');
    mkdirSync(join(r.cwd, '.claude', 'tests'), { recursive: true });
    mkdirSync(join(r.cwd, '.claude', 'reviews'), { recursive: true });
    writeFileSync(join(r.cwd, '.claude', 'tests', 'old.json'), '{}');
    expect(workTreeState(r.cwd).tree).toBe(revisionTree(r.cwd, 'HEAD'));
    await r.record('pass');
    expect((await r.bash('git push origin main')).denied).toBe(false);
  });

  test('taken at the repo top: run from a subdirectory, edits elsewhere still count', () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'a.test.ts'), 'test("b", () => {});\n'); // outside src/
    expect(workTreeState(join(r.cwd, 'src')).tree).toBe(workTreeState(r.cwd).tree);
    expect(workTreeState(join(r.cwd, 'src')).tree).not.toBe(revisionTree(r.cwd, 'HEAD'));
  });

  test('committed goodboy artifacts (a repo that does not ignore .claude/) do not break the match', async () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'src', 'a.ts'), 'export const a = 2;\n');
    await r.record('pass');
    git(r.cwd, 'add', '-A'); // includes .claude/tests/<result>.json
    git(r.cwd, 'commit', '-q', '-m', 'change with artifacts');
    expect(git(r.cwd, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('.claude/tests/');
    expect((await r.bash('git push')).denied).toBe(false);
  });

  test('a same-size edit right after the last index write is seen (racy git: the index copy keeps its mtime)', () => {
    for (let i = 0; i < 3; i++) {
      const r = repo();
      // Same size as the committed `export const a = 1;\n`, in the same second as the commit.
      writeFileSync(join(r.cwd, 'src', 'a.ts'), 'export const a = 9;\n');
      // Cross into the next second, so a fresh copy of the index would look newer than the edit.
      Bun.sleepSync(1050 - (Date.now() % 1000));
      const fresh = (() => {
        const idx = join(r.cwd, '..', `fresh-index-${i}`);
        const env = { ...process.env, GIT_INDEX_FILE: idx };
        Bun.spawnSync(['git', 'add', '-A', '--', '.', ':(exclude).claude'], { cwd: r.cwd, env });
        return Bun.spawnSync(['git', 'write-tree'], { cwd: r.cwd, env }).stdout.toString().trim();
      })();
      expect([i, workTreeState(r.cwd).tree]).toEqual([i, fresh]);
    }
  });

  test('pass needs verdict pass, a suite that ran, no failure and existing test files; blocked is reported; an unknown rev is unresolved', () => {
    const T1 = 'a'.repeat(40);
    const T0 = 'b'.repeat(40);
    const h = { kind: 'push' as const, what: 'git push', cwd: '/x', revs: ['HEAD'] };
    const ran = [{ name: 'u', command: 'c', passed: 3, failed: 0, output: '' }];
    const base = { timestamp: '', tested_files: [], category: '', test_files: [__filename], environment: { mode: 'none' as const }, suites: ran, acceptance: RED_GREEN };
    const treeOf = (_: string, rev: string) => (rev === 'HEAD' ? T1 : null);
    const noDiff = () => null;
    expect(checkHandoff(h, [{ ...base, verdict: 'pass', tree: T1 }], treeOf, noDiff)).toEqual({ ok: true });
    expect(checkHandoff(h, [{ ...base, verdict: 'pass', tree: T0 }], treeOf, noDiff)).toMatchObject({ ok: false, why: 'no-result' });
    expect(checkHandoff(h, [{ ...base, verdict: 'needs-changes', tree: T1 }], treeOf, noDiff)).toMatchObject({ why: 'no-result' });
    const failing = { ...base, verdict: 'pass' as const, tree: T1, suites: [{ name: 'u', command: 'c', passed: 1, failed: 1, output: '' }] };
    expect(checkHandoff(h, [failing], treeOf, noDiff)).toMatchObject({ why: 'no-result' });
    // A hand-made JSON: no suite that ran, no test files, or a tree that is not an object id.
    expect(checkHandoff(h, [{ ...base, verdict: 'pass', tree: T1, suites: [] }], treeOf, noDiff)).toMatchObject({ why: 'no-result' });
    expect(checkHandoff(h, [{ ...base, verdict: 'pass', tree: T1, test_files: [] }], treeOf, noDiff)).toMatchObject({ why: 'no-result' });
    expect(checkHandoff(h, [{ ...base, verdict: 'pass', tree: T1, test_files: ['/nope/x.test.ts'] }], treeOf, noDiff)).toMatchObject({ why: 'no-result' });
    // The same evidence the Stop test gate asks for: red-green entries (refactoring review).
    expect(checkHandoff(h, [{ ...base, verdict: 'pass', tree: T1, acceptance: [] }], treeOf, noDiff)).toMatchObject({ why: 'no-result' });
    const blocked = { ...base, verdict: 'blocked' as const, tree: T1, blocked: { reason: 'no docker daemon here', evidence: [] } };
    expect(checkHandoff(h, [blocked], treeOf, noDiff)).toMatchObject({ why: 'blocked' });
    expect(checkHandoff({ ...h, revs: ['nope'] }, [], treeOf, noDiff)).toMatchObject({ why: 'unresolved', rev: 'nope' });
    expect(checkHandoff({ ...h, revs: [], unclear: 'it pushes every branch or tag' }, [], treeOf, noDiff)).toMatchObject({ why: 'unclear' });
  });

  test('a forged tree is never passed to git as an option (security review: --output=<path>)', () => {
    const r = repo();
    const target = join(r.cwd, 'pwned.txt');
    expect(treeDiff(r.cwd, `--output=${target}`, revisionTree(r.cwd, 'HEAD')!)).toBeNull();
    expect(existsSync(target)).toBe(false);
    expect(revisionTree(r.cwd, `--output=${target}`)).toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  test('a deploy compares the working tree, not HEAD: an edit after the tests is caught', async () => {
    const r = repo();
    await r.record('pass');
    const edited = await (async () => {
      writeFileSync(join(r.cwd, 'src', 'a.ts'), 'export const a = 5;\n'); // not committed
      return r.bash('npm publish');
    })();
    expect(edited.denied).toBe(true);
    expect(edited.reason).toContain('hands off the working tree as it is');
    // The check needs only the hash: its blobs go to a scratch object dir (performance review).
    const before = git(r.cwd, 'count-objects');
    writeFileSync(join(r.cwd, 'src', 'big.ts'), 'x'.repeat(50_000));
    await r.bash('npm publish');
    expect(git(r.cwd, 'count-objects')).toBe(before);
    rmSync(join(r.cwd, 'src', 'big.ts'));
    await r.record('pass');
    expect((await r.bash('npm publish')).denied).toBe(false);
  });
});

describe('the PreToolUse rule', () => {
  test('a push without a result is denied with a Korean notice; a passing result for the tree lets it through', async () => {
    const r = repo();
    const denied = await r.bash('git push origin main');
    expect(denied.denied).toBe(true);
    expect(denied.reason).toContain('without a passing test result');
    expect(denied.system).toContain(`.goodboy-push-test-approved-${r.sid.slice(0, 8)}.txt`);
    const result = await r.record('pass');
    expect(result.tree).toBe(revisionTree(r.cwd, 'HEAD'));
    expect(result.commit).toBe(git(r.cwd, 'rev-parse', 'HEAD'));
    expect((await r.bash('git push origin main')).denied).toBe(false);
  });

  test('tests, then commit, then push passes; an edit after the tests makes the result stale', async () => {
    const r = repo();
    writeFileSync(join(r.cwd, 'src', 'a.ts'), 'export const a = 2;\n');
    await r.record('pass');
    git(r.cwd, 'commit', '-q', '-am', 'change');
    expect((await r.bash('git push')).denied).toBe(false);
    writeFileSync(join(r.cwd, 'src', 'a.ts'), 'export const a = 3;\n');
    git(r.cwd, 'commit', '-q', '-am', 'later');
    const stale = await r.bash('git push');
    expect(stale.denied).toBe(true);
    expect(stale.reason).toContain('differs from the newest passing result in: src/a.ts');
  });

  test('a BLOCKED result never passes; MR creation and the ship skill are checked too', async () => {
    const r = repo();
    await r.record('blocked', {
      test_files: [],
      suites: [],
      blocked: { reason: 'no container runtime on this machine', evidence: [{ command: 'docker info', output: 'command not found: docker' }] },
    });
    const push = await r.bash('git push');
    expect(push.denied).toBe(true);
    expect(push.reason).toContain('BLOCKED');
    expect(push.system).toContain('테스트를 실행하지 못함');
    expect((await r.bash('gh pr create --fill')).denied).toBe(true);
    expect((await r.run({ name: 'Skill', input: { skill: 'gstack:ship' } })).denied).toBe(true);
    expect((await r.run({ name: 'Skill', input: { skill: 'review' } })).denied).toBe(false);
  });

  test("the user's marker passes one hand-off; a subagent gets no override; warn and off modes", async () => {
    const r = repo();
    r.approve('push-test');
    expect((await r.bash('git push')).denied).toBe(false);
    expect(existsSync(r.marker('push-test'))).toBe(false);
    expect((await r.bash('git push')).denied).toBe(true);
    r.approve('push-test');
    const sub = await r.bash('git push', { sub: true });
    expect(sub.denied).toBe(true);
    expect(sub.reason).toContain('return BLOCKED');
    expect(existsSync(r.marker('push-test'))).toBe(true);
    rmSync(r.marker('push-test'));
    const warn = await r.bash('git push', { env: { GOODBOY_PUSH_TEST_GATE: 'warn' } });
    expect(warn.denied).toBe(false);
    expect(warn.context).toContain('push test check, warn mode');
    expect((await r.bash('git push', { env: { GOODBOY_PUSH_TEST_GATE: 'off' } })).denied).toBe(false);
    expect((await r.bash('git push --dry-run')).denied).toBe(false);
  });

  test('order with R2: a push-test denial leaves the production approval unused', async () => {
    const r = repo();
    mkdirSync(join(r.cwd, '.goodboy'));
    writeFileSync(join(r.cwd, '.goodboy', 'hosts'), 'production github.com\n');
    git(r.cwd, 'add', '.goodboy');
    git(r.cwd, 'commit', '-q', '-m', 'hosts');
    git(r.cwd, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    r.approve('outward');
    const out = await r.bash('git push origin main', { env: { GOODBOY_OUTWARD_GATE: 'on' } });
    expect(out.denied).toBe(true);
    expect(out.reason).toContain('passing test result');
    expect(existsSync(r.marker('outward'))).toBe(true);
    // With the tests done, the production approval is used once.
    await r.record('pass');
    expect((await r.bash('git push origin main', { env: { GOODBOY_OUTWARD_GATE: 'on' } })).denied).toBe(false);
    expect(existsSync(r.marker('outward'))).toBe(false);
    expect(readdirSync(join(r.cwd, '.claude')).filter((f) => f.includes('consumed'))).toEqual([]);
  });
});
