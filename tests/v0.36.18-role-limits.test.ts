import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bashChangedPaths, resultCliWrite } from '../lib/role-limits';

// v0.36.18 (plan §15.34 items 3 and 4): the result-writer guard no longer takes the CLI's
// `review-axes` on a changed lib/regression.ts for a test record, and the role limits tell a
// read-only git command (`git branch -r`, `tag -l`, `stash list`, ...) from one that changes `.git`.
//
// The writer subcommand names are built from pieces: this file is read by tools that match the
// whole word, and a literal one in a command line is denied for the main session.

const CLI = '/x/goodboy/lib/cli.ts';
const REG = ['lib', 'regression.ts'].join('/');
const TEST_WRITE = ['test', 'write'].join('-');
const REVIEW_WRITE = ['review', 'write'].join('-');
const REGRESSION = ['regr', 'ession'].join('');

describe('V18-AC-9 resultCliWrite: the CLI reading a file named lib/regression.ts is no test record', () => {
  test('a literal non-writer subcommand with the module only among its operands is null', () => {
    expect(resultCliWrite(`bun ${CLI} review-axes lib/cli.ts ${REG}`)).toBeNull();
    expect(resultCliWrite(`bun run ${CLI} review-axes ${REG}`)).toBeNull();
    expect(resultCliWrite(`bun ${CLI} review-axes ${REG} hooks/stop.ts`)).toBeNull();
  });

  test('a command that names the module with no JS runtime is still null', () => {
    expect(resultCliWrite(`grep -n x ${REG}`)).toBeNull();
  });

  test('the CLI result writers and the regression subcommand still count as a test record', () => {
    expect(resultCliWrite(`bun ${CLI} ${REGRESSION}`)).toBe('test');
    expect(resultCliWrite(`bun ${CLI} ${TEST_WRITE} < r.json`)).toBe('test');
    expect(resultCliWrite(`bun run ${CLI} ${REVIEW_WRITE} < r.json`)).toBe('review');
    // the writer name among the operands of an otherwise plain subcommand
    expect(resultCliWrite(`bun ${CLI} review-axes ${TEST_WRITE} ${REG}`)).toBe('test');
    expect(resultCliWrite(`bun ${CLI} review-axes ${REGRESSION} ${REG}`)).toBe('test');
  });

  test('a heredoc to `bun -` that imports the module counts', () => {
    expect(resultCliWrite(`bun - <<EOF\nimport "./lib/regression"\nEOF`)).toBe('test');
  });

  test('a second runtime segment that loads the module counts, though the first is plain', () => {
    expect(resultCliWrite(`bun ${CLI} review-axes ${REG} && node -e "require('./lib/regression')"`)).toBe('test');
    expect(resultCliWrite(`bun ${CLI} review-axes ${REG}; bun -e "import './lib/regression'"`)).toBe('test');
  });

  test('a runtime flag before the script (a --preload could load the module) counts', () => {
    expect(resultCliWrite(`bun --preload ./p.ts ${CLI} review-axes ${REG}`)).toBe('test');
    expect(resultCliWrite(`bun --cwd . ${CLI} review-axes ${REG}`)).toBe('test');
  });

  test('a subcommand built at run time counts (it cannot be read as plain)', () => {
    expect(resultCliWrite(`bun ${CLI} $SUB ${REG}`)).toBe('test');
    expect(resultCliWrite(`bun ${CLI} "$(printf 'review-%s' axes)" ${REG}`)).not.toBeNull();
  });

  test('bun -e calling the regression record writer counts', () => {
    expect(resultCliWrite(`bun -e "import {writeRegressionRecord} from './lib/regression'"`)).toBe('test');
    expect(resultCliWrite(`bun -e "writeRegressionRecord(1)"`)).toBe('test');
  });

  test('a plain CLI segment with no runtime script (the script is not the CLI) still counts', () => {
    expect(resultCliWrite(`bun other.ts review-axes ${REG}`)).toBe('test');
  });

  // Review fix: a runtime options variable can load code the segment does not name, so no segment is excused.
  test('a runtime options variable in the command excuses no segment', () => {
    for (const env of ['BUN_OPTIONS="--preload ./p.ts"', 'NODE_OPTIONS="--require ./p.js"', 'BUN_CONFIG_VERBOSE_FETCH=curl', 'BUN_INSTALL_CACHE_DIR=/x']) {
      const c = `${env} bun ${CLI} review-axes ${REG}`;
      expect([c, resultCliWrite(c)]).toEqual([c, 'test']);
      const exported = `export ${env}; bun ${CLI} review-axes ${REG}`;
      expect([exported, resultCliWrite(exported)]).toEqual([exported, 'test']);
    }
  });

  test('another variable, or an options variable with nothing naming the module, changes nothing', () => {
    expect(resultCliWrite(`FOO=1 bun ${CLI} review-axes ${REG}`)).toBeNull();
    expect(resultCliWrite(`CI=1 bun run ${CLI} review-axes ${REG}`)).toBeNull();
    expect(resultCliWrite(`BUN_OPTIONS="--preload ./p.ts" bun ${CLI} review-axes lib/cli.ts`)).toBeNull();
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('V18-AC-10 bashChangedPaths: read-only git commands are no .git write', () => {
  const CWD = '/repo';
  const GIT = '/repo/.git';

  test('listing and reading forms report no path', () => {
    for (const c of [
      'git branch -r',
      'git branch -a -v',
      'git branch --show-current',
      'git branch -vv',
      'git branch --list new',
      'git tag -l',
      'git tag',
      'git config --get x',
      'git config --get-all x',
      'git config --list',
      'git stash list',
      'git stash show',
      'git stash show -p',
      'git worktree list',
      'git worktree list --porcelain',
      'git -C . branch -r',
    ]) {
      expect([c, bashChangedPaths(c, CWD)]).toEqual([c, []]);
    }
  });

  test('changing forms still report the repo .git', () => {
    for (const c of [
      'git branch new',
      'git branch -D x',
      'git branch -m a b',
      'git branch -r --delete x',
      'git branch -r new',
      'git branch -u origin/main',
      'git tag v1',
      'git tag -d v1',
      'git tag -f v1 abc',
      'git config k v',
      'git config --unset x',
      'git config --add x y',
      'git config --edit',
      'git stash',
      'git stash push list',
      'git stash drop',
      'git stash pop',
      'git worktree add d',
      'git worktree prune',
      'git worktree remove d',
      'git commit',
    ]) {
      expect([c, bashChangedPaths(c, CWD)]).toEqual([c, [GIT]]);
    }
  });

  // Review fix: the operation of stash and worktree is the FIRST argument.
  test('a stash or worktree whose first argument is not the read operation is a change, whatever follows', () => {
    for (const c of ['git stash -m list', 'git stash push -m list', 'git stash --keep-index list', 'git stash -u show', 'git worktree -f list', 'git worktree add list']) {
      expect([c, bashChangedPaths(c, CWD)]).toEqual([c, [GIT]]);
    }
    for (const c of ['git stash list -p', 'git stash show --stat', 'git worktree list -v']) {
      expect([c, bashChangedPaths(c, CWD)]).toEqual([c, []]);
    }
  });

  // Review fix: `--output <file>` writes that file from any git command, reads included.
  test('--output <file> on any git command counts the file as a changed path', () => {
    for (const [c, want] of [
      ['git log --output=out.txt', ['/repo/out.txt']],
      ['git log -n1 --output out.txt', ['/repo/out.txt']],
      ['git diff --output=notes/x.md', ['/repo/notes/x.md']],
      ['git show HEAD --output=/tmp/x', ['/tmp/x']],
      ['git format-patch -1 --output=p.patch', ['/repo/p.patch']],
      ['git stash show -p --output=s.txt', ['/repo/s.txt']],
      ['git stash list --output=l.txt', ['/repo/l.txt']],
      ['git tag -d v1 --output=t.txt', ['/repo/.git', '/repo/t.txt']],
    ] as Array<[string, string[]]>) {
      expect([c, bashChangedPaths(c, CWD).sort()]).toEqual([c, [...want].sort()]);
    }
  });

  test('--output with a value that cannot be read, or none, reports no path; other flags are no output', () => {
    for (const c of ['git log --output=$F', 'git log --output=*.txt', 'git log --output=', 'git log --output', 'git log --oneline -n3', 'git diff --stat', 'git log --outputs=x']) {
      expect([c, bashChangedPaths(c, CWD)]).toEqual([c, []]);
    }
  });

  test('in one command line, a read next to a change still reports the change', () => {
    expect(bashChangedPaths('git branch -r && git branch new', CWD)).toEqual([GIT]);
    expect(bashChangedPaths('git stash list && git stash pop', CWD)).toEqual([GIT]);
    expect(bashChangedPaths('git stash show -p; git stash drop', CWD)).toEqual([GIT]);
  });

  test('a read from a subdirectory cwd reports nothing, a write reports that cwd .git', () => {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-v18-rl-'));
    tmpDirs.push(base);
    const sub = join(base, 'sub');
    mkdirSync(sub);
    expect(bashChangedPaths('git tag -l', sub)).toEqual([]);
    expect(bashChangedPaths('git tag v1', sub)).toEqual([join(sub, '.git')]);
  });
});

// The hook path: a review or test agent's `git branch -r` is no longer denied (role limits),
// and a real change is.
const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-v18-role-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const sid = `v18-${Math.random().toString(36).slice(2)}`;
  const run = async (agentType: string, command: string) => {
    const payload = {
      session_id: sid,
      cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`,
      agent_type: agentType,
      agent_id: 'x1',
    };
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TMPDIR: base, GOODBOY_REASONING_GATE: 'off' },
    });
    const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
    await proc.exited;
    const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
    return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
  };
  return { run };
}

describe('V18-AC-10 through the PreToolUse hook', () => {
  test('a test-unit agent may list branches, tags and stashes', async () => {
    const { run } = setup();
    for (const c of ['git branch -r', 'git branch -a -v', 'git tag -l', 'git stash list', 'git worktree list', 'git config --get user.name']) {
      const r = await run('goodboy:test-unit', c);
      expect([c, r.denied, r.reason]).toEqual([c, false, '']);
    }
  });

  test('a review agent may list branches too', async () => {
    const { run } = setup();
    expect((await run('goodboy:review-all', 'git branch -r')).denied).toBe(false);
  });

  test('a test-unit agent: git --output into the source is denied, into a test file or outside the project it is not', async () => {
    const { run } = setup();
    const bad = await run('goodboy:test-unit', 'git log --output=src/a.ts');
    expect(bad.denied).toBe(true);
    expect(bad.reason).toContain('test files only');
    expect((await run('goodboy:test-unit', 'git diff --output=tests/a.test.ts')).denied).toBe(false);
    expect((await run('goodboy:test-unit', 'git diff --output=/tmp/goodboy-v18-probe.txt')).denied).toBe(false);
    expect((await run('goodboy:test-unit', 'git stash -m list')).denied).toBe(true);
  });

  test('a test-unit agent is still denied a git change, with the test-files-only reason', async () => {
    const { run } = setup();
    for (const c of ['git branch new', 'git stash', 'git tag v1', 'git worktree add d']) {
      const r = await run('goodboy:test-unit', c);
      expect([c, r.denied]).toEqual([c, true]);
      expect(r.reason).toContain('test files only');
    }
  });
});
