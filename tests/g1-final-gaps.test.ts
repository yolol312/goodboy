// Layer-1 gaps found in the final G1 round, and the re-review's false denials, each pinned
// down with its fix.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyOutward } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { bashChangedPaths, resultCliWrite, resultDirWrite } from '../lib/role-limits';

const ROOT = resolve(import.meta.dir, '..');
const HOOK = join(ROOT, 'hooks', 'pre-tool-use.ts');
const CLI = join(ROOT, 'lib', 'cli.ts');
const rules = { allow: [], production: [] };
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function makeRepo(dir: string, content: string) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'src', 'a.ts'), content);
  writeFileSync(join(dir, 'a.test.ts'), 'test("a", () => {});\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function hook(cwd: string, base: string, sid: string, command: string) {
  const proc = Bun.spawn(['bun', HOOK], {
    cwd,
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TMPDIR: base, GOODBOY_OUTWARD_GATE: 'off', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' },
  });
  const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as Record<string, unknown>;
  await proc.exited;
  const h = (out.hookSpecificOutput ?? {}) as Record<string, string>;
  return { denied: h.permissionDecision === 'deny', reason: h.permissionDecisionReason ?? '' };
}

describe('GAP-1 false denial: `xargs git <builtin>` is read as an unclear push', () => {
  test('handoffsOf: xargs running git add / branch -d / rm / diff is no hand-off', () => {
    for (const c of [
      'git ls-files -m | xargs git add',
      'git branch --merged | grep -v main | xargs git branch -d',
      "find . -name '*.orig' -print0 | xargs -0 git rm",
      'git diff --name-only | xargs git diff --stat',
      'git diff --name-only | xargs -n1 git diff --stat',
    ]) {
      expect([c, handoffsOf(c, '/x', rules)]).toEqual([c, []]);
    }
    // Not over-corrected: a push, or a word that may be an alias, fed by xargs stays unclear.
    expect(handoffsOf('echo main | xargs git push origin', '/x', rules)[0]?.unclear).toBe('its arguments come from xargs');
    expect(handoffsOf('echo main | xargs git p origin', '/x', rules)[0]?.unclear).toBe('its arguments come from xargs');
  });

  test('PreToolUse: `git ls-files -m | xargs git add` passes in the main session', async () => {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-gap1-'));
    tmpDirs.push(base);
    const cwd = join(base, 'repo');
    makeRepo(cwd, 'export const a = 1;\n');
    const r = await hook(cwd, base, `gap1-${Math.random().toString(36).slice(2)}`, 'git ls-files -m | xargs git add');
    expect([r.denied, r.reason.includes('push test check')]).toEqual([false, false]);
  });
});

describe('GAP-2 wrong repo: a `(` anywhere stops `cd` from being followed', () => {
  test('handoffsOf: the push after `cd ../B` runs in B even when the command has a substitution', () => {
    for (const c of [
      'cd ../B && echo "$(date)" && git push origin main',
      'cd ../B && git push origin main && echo $(date)',
      "cd ../B && git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\" && git push origin main",
    ]) {
      const h = handoffsOf(c, '/x/A', rules)[0];
      // Either B is checked or the push is unclear; checking A is wrong.
      expect([c, h?.cwd === '/x/B' || h?.unclear !== undefined]).toEqual([c, true]);
    }
    // A real subshell still does not move the rest.
    expect(handoffsOf('(cd ../B && ls) && git push origin main', '/x/A', rules).map((h) => [h.cwd, h.unclear ?? null])[0]).toEqual(['/x/A', null]);
  });

  test("PreToolUse: A's passing result does not let B's untested main through", async () => {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-gap2-'));
    tmpDirs.push(base);
    const A = join(base, 'A');
    const B = join(base, 'B');
    makeRepo(A, 'export const a = 1;\n');
    makeRepo(B, 'export const b = "untested";\n');
    const result = {
      tested_files: [join(A, 'src', 'a.ts')],
      category: 'add-feature',
      test_files: [join(A, 'a.test.ts')],
      environment: { mode: 'local' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      acceptance: [
        {
          id: 'AC-1',
          description: 'a',
          test: 'a.test.ts',
          red: { command: 'bun test a.test.ts', output: '1 fail', exit_code: 1 },
          green: { command: 'bun test a.test.ts', output: '1 pass', exit_code: 0 },
        },
      ],
      verdict: 'pass',
    };
    const proc = Bun.spawn(['bun', CLI, 'test-write'], { cwd: A, env: { ...process.env, TMPDIR: base }, stdin: new TextEncoder().encode(JSON.stringify(result)), stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(readFileSync(JSON.parse(out).path, 'utf8')).tree).toMatch(/^[0-9a-f]{40}/);
    const sid = `gap2-${Math.random().toString(36).slice(2)}`;
    // Control: without the substitution the push is checked in B and denied.
    expect((await hook(A, base, sid, 'cd ../B && git push origin main')).denied).toBe(true);
    expect((await hook(A, base, sid, 'cd ../B && echo "$(date)" && git push origin main')).denied).toBe(true);
  });
});

describe('GAP-3 result CLI behind a runtime flag that takes a value is not seen', () => {
  test('resultCliWrite', () => {
    for (const c of [
      `bun --cwd . ${CLI} test-write < r.json`,
      `bun --preload ./x.ts ${CLI} test-write < r.json`,
      `node --require tsx/cjs ${CLI} test-write < r.json`,
      `bunx tsx ${CLI} test-write < r.json`,
      `npx tsx ${CLI} review-write < r.json`,
    ]) {
      expect([c, resultCliWrite(c)]).toEqual([c, c.includes('review-write') ? 'review' : 'test']);
    }
    // Not over-corrected: a project's own CLI stays no result write.
    expect(resultCliWrite('npx tsx src/cli.ts serve')).toBeNull();
  });
});

describe('GAP-4 file programs that write by option are not result-dir writers', () => {
  test('resultDirWrite', () => {
    for (const c of [
      'curl -s -o .claude/tests/x.json file:///tmp/f.json',
      'wget -q -O .claude/reviews/x.json http://127.0.0.1:8000/f.json',
      'tar -xf /tmp/r.tgz -C .claude/tests',
      'git archive HEAD:fixtures | tar -x -C .claude/tests',
      'unzip -o /tmp/r.zip -d .claude/tests',
      'cp -t .claude/tests forged.json', // GNU cp
      'cp --target-directory=.claude/reviews forged.json',
    ]) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
    // Not over-corrected: reading a result into elsewhere stays fine.
    expect(resultDirWrite('curl -s -o /tmp/x.json file:///proj/.claude/tests/a.json', '/proj')).toBeNull();
  });
});

describe('LOW-5 false denial: `command -v sh` reads as a stdin shell', () => {
  test('handoffsOf', () => {
    expect(handoffsOf('command -v sh && git push origin main', '/x', rules)[0]).toMatchObject({ revs: ['main'] });
  });
});

describe('last review: compound commands, subshell scopes, carriers and option tables', () => {
  test('a push, a production call and a file change inside if/for/while/{ } are read', () => {
    expect(handoffsOf('if git diff --quiet; then git push origin main; fi', '/x', rules)[0]).toMatchObject({ revs: ['main'] });
    expect(handoffsOf('for r in origin; do git push "$r" main; done', '/x', rules)[0]).toMatchObject({ revs: ['main'] });
    expect(handoffsOf('while true; do git push origin main; break; done', '/x', rules)[0]).toMatchObject({ revs: ['main'] });
    expect(handoffsOf('{ git push origin main; }', '/x', rules)[0]).toMatchObject({ revs: ['main'] });
    expect(handoffsOf('! git push origin main', '/x', rules)[0]).toMatchObject({ revs: ['main'] });
    expect(classifyOutward('if true; then curl -X POST https://api.example.org/x; fi', '/x').some((t) => t.mutating)).toBe(true);
    expect(bashChangedPaths('if true; then rm src/a.ts; fi', '/p')).toEqual(['/p/src/a.ts']);
  });

  test('cd follows subshell scopes, and a cd that cannot be followed makes the push unclear', () => {
    const lost =
      'it runs after a `cd` goodboy cannot follow (`cd -`, a computed dir, a `popd` past its `pushd`, a `cd` ending a pipeline, `env -C` with a computed dir); cd to a literal path';
    expect(handoffsOf('cd ../B && (git fetch -q origin || true) && git push origin main', '/x/A', rules)[0]).toMatchObject({ cwd: '/x/B' });
    expect(handoffsOf('cd ../B && git status -s && (bun test) ; git push origin main', '/x/A', rules)[0]).toMatchObject({ cwd: '/x/B' });
    expect(handoffsOf('(cd ../B && git push origin main)', '/x/A', rules)[0]).toMatchObject({ cwd: '/x/B' });
    expect(handoffsOf('(cd ../B) && git push origin main', '/x/A', rules).map((h) => [h.cwd, h.unclear ?? null])[0]).toEqual(['/x/A', null]);
    expect(handoffsOf("sh -c 'cd ../B && git push origin main' && git push origin dev", '/x/A', rules).map((h) => h.cwd)).toEqual(['/x/B', '/x/A']);
    expect(handoffsOf('cd - && git push origin main', '/x/A', rules)[0]?.unclear).toBe(lost);
    expect(handoffsOf('cd "$REPO" && git push origin main', '/x/A', rules)[0]?.unclear).toBe(lost);
    expect(handoffsOf('cd $(mktemp -d) && git push origin main', '/x/A', rules)[0]?.unclear).toBe(lost);
    expect(handoffsOf('cd "$(git rev-parse --show-toplevel)" && git push origin main', '/x/A', rules).map((h) => [h.cwd, h.unclear ?? null])[0]).toEqual(['/x/A', null]);
    const top = handoffsOf('cd $(git rev-parse --show-toplevel) && git push origin main', '/x/A', rules)[0];
    expect([top?.cwd, top?.unclear, top?.revs]).toEqual(['/x/A', undefined, ['main']]);
    expect(handoffsOf('cd "$D" && ls', '/x/A', rules)).toEqual([]); // nothing handed off: nothing to decide
  });

  test('backups that only use a carried name, xargs interpreters, rsync -t and restore --staged are reads', () => {
    for (const c of [
      'for f in .claude/tests/*.json; do cp "$f" "$TMPDIR/$(basename "$f")"; done',
      'for f in .claude/reviews/*.json; do jq .verdict "$f" > "$TMPDIR/${f##*/}.v"; done',
      "jq -r '.test_files[]' .claude/tests/x.json | xargs bun test",
      "jq -r '.reviewed_files[]' .claude/reviews/y.json | xargs bunx prettier --check",
      'rsync -a -t .claude/tests/ "$TMPDIR/bk/"',
      'git restore --staged .claude/tests',
    ]) {
      expect([c, resultDirWrite(c, '/proj')]).toEqual([c, null]);
    }
    for (const c of ['for f in .claude/tests/*.json; do cp forged.json "${f}"; done', 'git restore .claude/tests', 'git restore --staged --worktree .claude/tests']) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
  });

  test("xargs -i takes no separate value (GNU's replace string is attached)", () => {
    expect(handoffsOf('echo main | xargs -i git push origin {}', '/x', rules)[0]?.unclear).toBe('its arguments come from xargs');
  });
});

describe('re-review: copies out of a result dir and index-only git are reads', () => {
  test('resultDirWrite: results copied to a variable dir, a loop that backs them up, git rm --cached', () => {
    for (const c of [
      'cp .claude/tests/x.json "$D/"',
      'jq . .claude/tests/x.json > "$TMPDIR/x.json"',
      'cp -R .claude/reviews "$B/"',
      'for f in .claude/tests/*.json; do cp "$f" "$BACKUP/"; done',
      'ls .claude/tests | xargs -I{} cp .claude/tests/{} /tmp/backup/',
      'git rm -r --cached .claude/tests',
      // a writer's own source is no read that feeds another writer
      'cp .claude/tests/x.json /tmp/b/ && ls src | xargs touch',
    ]) {
      expect([c, resultDirWrite(c, '/proj')]).toEqual([c, null]);
    }
    // Not over-corrected: the loop variable, a `read` variable or xargs input as the target.
    for (const c of [
      'for f in .claude/tests/*.json; do cp forged.json "$f"; done',
      'ls .claude/tests/*.json | while read f; do cp forged.json "$f"; done',
      'ls .claude/tests | xargs -I{} cp forged.json {}',
      'ls .claude/tests/*.json | xargs touch',
      'git rm -r .claude/tests',
    ]) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
  });

  test('handoffsOf: `-s` after the script is the script\'s argument, not "read stdin"', () => {
    expect(handoffsOf('bash scripts/release.sh -s --no-push', '/x', rules)).toEqual([]);
    expect(handoffsOf("bash -s main <<'EOF'\ngit push origin \"$1\"\nEOF", '/x', rules)[0]?.unclear).toBe('it feeds a script to a shell on stdin');
  });
});

// Each case below was handled by the fixes but pinned by no test: a mutant of the fix survived
//   every targeted test file (layer-1 mutation round).
describe('layer-1 mutants: spellings the fixes handle that no test pinned', () => {
  test('handoffsOf: a ` (` in a quoted commit message or a heredoc body is no subshell', () => {
    for (const c of [
      'cd ../B && git commit -m "fix: x (y)" && git push origin main',
      "cd ../B && git commit -q -F - <<'EOF'\nfix: x (y)\nEOF\ngit push origin main",
    ]) {
      expect([c, handoffsOf(c, '/x/A', rules)[0]]).toEqual([c, expect.objectContaining({ cwd: '/x/B', revs: ['main'] })]);
    }
  });

  test('handoffsOf: xargs flags that take a value do not hide the git it runs', () => {
    // `-n 1` / `-L 1`: a push fed by xargs stays unclear (not a push of HEAD).
    for (const c of ['echo main | xargs -n 1 git push origin', 'echo main | xargs -L 1 git push origin']) {
      expect([c, handoffsOf(c, '/x', rules)[0]?.unclear]).toEqual([c, 'its arguments come from xargs']);
    }
    // git's own value options before a built-in: still no hand-off.
    for (const c of ['git ls-files -m | xargs git -C . add', 'git ls-files -m | xargs git -c core.quotepath=off add']) {
      expect([c, handoffsOf(c, '/x', rules)]).toEqual([c, []]);
    }
  });

  test('handoffsOf: `-s` inside a flag cluster before the first operand still reads stdin', () => {
    for (const c of ["bash -es main <<'EOF'\ngit push origin \"$1\"\nEOF", "bash -xs main <<'EOF'\ngit push origin \"$1\"\nEOF"]) {
      expect([c, handoffsOf(c, '/x', rules)[0]?.unclear]).toEqual([c, 'it feeds a script to a shell on stdin']);
    }
  });

  test('handoffsOf: `command -V` and `command -pv` run nothing either', () => {
    for (const c of ['command -V sh && git push origin main', 'command -pv sh && git push origin main']) {
      expect([c, handoffsOf(c, '/x', rules)[0]]).toEqual([c, expect.objectContaining({ revs: ['main'] })]);
    }
  });

  test('handoffsOf: cd scopes — a substitution keeps its cd, inner scopes and nested shells start from the parent', () => {
    for (const c of [
      'cd ../B && echo $(cd ../C) && git push origin main',
      'cd ../B && echo `cd ../C` && git push origin main',
      'cd ../B && (git push origin main)',
      'cd ../B && sh -c "git push origin main"',
    ]) {
      expect([c, handoffsOf(c, '/x/A', rules)[0]]).toEqual([c, expect.objectContaining({ cwd: '/x/B', revs: ['main'] })]);
    }
    // A bare `cd` goes home (followed, not lost).
    expect(handoffsOf('cd && git push origin main', '/x/A', rules)[0]).toMatchObject({ cwd: homedir(), revs: ['main'] });
  });

  test('handoffsOf: else / elif / until bodies are read like then / do', () => {
    for (const c of [
      'if false; then :; else git push origin main; fi',
      'if false; then :; elif git push origin main; then :; fi',
      'until git push origin main; do sleep 1; done',
    ]) {
      expect([c, handoffsOf(c, '/x', rules)[0]]).toEqual([c, expect.objectContaining({ revs: ['main'] })]);
    }
  });

  test('handoffsOf: an MR opened after a cd goodboy cannot follow is unclear, like a push', () => {
    for (const c of ['cd - && gh pr create --fill', 'cd "$D" && glab mr create']) {
      expect([c, handoffsOf(c, '/x/A', rules)[0]?.unclear]).toEqual([c, expect.stringContaining('cannot follow')]);
    }
  });
});
