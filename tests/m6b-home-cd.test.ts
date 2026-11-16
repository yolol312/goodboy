// Track M, M6b (plan §19), final security review: `cd "$HOME/x"` and `cd ${HOME}/x` are read as `cd ~/x` by the shared command
// reader (lib/outward-command.ts, literalDir), so every consumer of readCommand judges what follows in that dir:
//   1. the outward push rule (lib/push-test.ts handoffsOf): the push is checked in the repo the `cd` names;
//   2. the commit issue rule (lib/commit-issue.ts): the repo's own setting applies, also for `git -C "$HOME/x"`;
//   3. the role limits (lib/role-limits.ts bashChangedPaths), alone and through the spawned PreToolUse hook.
// Any other variable stays a dir goodboy cannot tell (`${HOME:-/x}`, `$HOMEX`, `$HOME/$X`, `$HOME/*`): a push is then unclear,
// and the other two rules judge from the dir the shell starts in, as before.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commitIssueDenial } from '../lib/commit-issue';
import { cdTarget, readCommand } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { bashChangedPaths } from '../lib/role-limits';
import { keepEnv } from './m6b-helpers';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const RULES = { allow: [], production: [] };
const restoreHome = keepEnv('HOME');

let base = '';
let home = '';
let away = '';
let proj = '';
const sessions: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6b-homecd-')));
  home = join(base, 'home');
  away = join(base, 'away');
  proj = join(home, 'proj');
  mkdirSync(away, { recursive: true });
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'tests'), { recursive: true });
  mkdirSync(join(proj, '.goodboy'), { recursive: true });
  writeFileSync(join(proj, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(proj, 'tests', 'a.test.ts'), '\n');
  // This repo wants ZED keys; the repo the shell starts in (`away`, no repo) has the default rule.
  writeFileSync(join(proj, '.goodboy', 'commit-issue'), '\\bZED-\\d+\\b\n');
  git(proj, 'init', '-q', '-b', 'main');
  git(proj, 'config', 'user.email', 't@example.com');
  git(proj, 'config', 'user.name', 't');
  git(proj, 'config', 'commit.gpgsign', 'false');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-q', '-m', 'ZED-1 init');
  process.env.HOME = home;
});
afterAll(() => {
  restoreHome();
  rmSync(base, { recursive: true, force: true });
});
afterEach(() => {
  while (sessions.length) rmSync(join(tmpdir(), `goodboy-session-${sessions.pop()}`), { recursive: true, force: true });
});

const sid = (): string => {
  const s = `hcd${Math.random().toString(36).slice(2, 10)}`;
  sessions.push(s);
  return s;
};

/** Spellings that name the home dir (then `/proj`), and the ones that must stay unknown. */
const KNOWN = ['cd "$HOME/proj" && ', 'cd ${HOME}/proj && ', 'cd "${HOME}/proj" && ', 'cd $HOME/proj && ', 'cd ~/proj && '];
const UNKNOWN = ['cd "${HOME:-/x}/proj" && ', 'cd $HOMEX/proj && ', 'cd "$HOME/$X" && ', 'cd "$HOME/*" && ', 'cd "$HOME/pro?" && ', 'cd "$HOME/`echo proj`" && '];

describe('the outward push rule judges the push in the dir a $HOME cd names', () => {
  test('a push after cd "$HOME/proj" is checked in proj, with its refs', () => {
    for (const c of KNOWN) {
      const h = handoffsOf(`${c}git push origin main`, away, RULES);
      expect([c, h.map((x) => ({ cwd: x.cwd, revs: x.revs, unclear: x.unclear }))]).toEqual([c, [{ cwd: proj, revs: ['main'], unclear: undefined }]]);
    }
  });

  test('cd "$HOME" alone is the home dir', () => {
    const h = handoffsOf('cd "$HOME" && git push origin main', away, RULES);
    expect(h.map((x) => ({ cwd: x.cwd, revs: x.revs }))).toEqual([{ cwd: home, revs: ['main'] }]);
  });

  test('${HOME:-/x}, $HOMEX, $HOME/$X, $HOME/* and a substitution are a dir goodboy cannot tell: the push is unclear', () => {
    for (const c of UNKNOWN) {
      const h = handoffsOf(`${c}git push origin main`, away, RULES);
      expect([c, h.length, h[0]?.unclear]).toEqual([c, 1, expect.stringContaining('goodboy cannot follow')]);
      expect(h[0]!.revs).toEqual([]);
    }
  });

  test('a later cd out of the home dir moves the push with it', () => {
    const h = handoffsOf('cd "$HOME/proj" && cd src && git push origin main', away, RULES);
    expect(h.map((x) => x.cwd)).toEqual([join(proj, 'src')]);
  });
});

describe('the commit issue rule judges the commit in the repo a $HOME cd (or -C) names', () => {
  test('the repo ZED rule applies after cd "$HOME/proj": an ABC key is denied and a ZED key passes', () => {
    for (const c of KNOWN) {
      expect([c, commitIssueDenial(`${c}git commit -m "ABC-1 fix"`, away, sid())]).toEqual([c, expect.stringContaining('ZED')]);
      expect([c, commitIssueDenial(`${c}git commit -m "ZED-2 fix"`, away, sid())]).toEqual([c, null]);
    }
  });

  test('git -C "$HOME/proj" and git -C ${HOME}/proj name the repo too', () => {
    for (const dir of ['"$HOME/proj"', '${HOME}/proj', '~/proj']) {
      expect([dir, commitIssueDenial(`git -C ${dir} commit -m "ABC-1 fix"`, away, sid())]).toEqual([dir, expect.stringContaining('ZED')]);
      expect([dir, commitIssueDenial(`git -C ${dir} commit -m "ZED-2 fix"`, away, sid())]).toEqual([dir, null]);
    }
  });

  test('${HOME:-/x}, $HOMEX, $HOME/$X and $HOME/* stay unknown: the commit is judged in the dir the shell is in (default keys)', () => {
    for (const c of UNKNOWN) {
      expect([c, commitIssueDenial(`${c}git commit -m "ABC-1 fix"`, away, sid())]).toEqual([c, null]);
      expect([c, commitIssueDenial(`${c}git commit -m "fix"`, away, sid())]).toEqual([c, expect.stringContaining('no issue number')]);
    }
  });
});

describe('the role limits judge a change in the dir a $HOME cd names', () => {
  test('bashChangedPaths reads rm, touch and cp after cd "$HOME/proj" in proj, not in the shell dir', () => {
    for (const c of KNOWN) {
      expect([c, bashChangedPaths(`${c}rm src/a.ts`, away)]).toEqual([c, [join(proj, 'src', 'a.ts')]]);
      expect([c, bashChangedPaths(`${c}touch src/b.ts`, away)]).toEqual([c, [join(proj, 'src', 'b.ts')]]);
      expect([c, bashChangedPaths(`${c}cp /tmp/x src/c.ts`, away)]).toEqual([c, [join(proj, 'src', 'c.ts')]]);
    }
  });

  test('an unknown spelling is read from the dir the shell is in, as before', () => {
    for (const c of UNKNOWN) expect([c, bashChangedPaths(`${c}rm src/a.ts`, away)]).toEqual([c, [join(away, 'src', 'a.ts')]]);
  });

  async function hook(cwd: string, command: string): Promise<{ denied: boolean; reason: string }> {
    const sessionId = sid();
    const proc = Bun.spawn(['bun', HOOK], {
      cwd,
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: proj, GOODBOY_CLAIM_FLUSH_WAIT_MS: '0' },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_type: 'goodboy:test-unit', tool_input: { command } })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const o = JSON.parse(out || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    return { denied: o.hookSpecificOutput?.permissionDecision === 'deny', reason: o.hookSpecificOutput?.permissionDecisionReason ?? '' };
  }

  test('a tests-role agent in proj/tests: touch src/b.ts after cd "$HOME/proj" is a source write (denied); the same words after an unknown cd stay in tests/ (allowed)', async () => {
    const cwd = join(proj, 'tests');
    for (const c of ['cd "$HOME/proj" && ', 'cd ${HOME}/proj && ']) {
      const r = await hook(cwd, `${c}touch src/b.ts`);
      expect([c, r.denied, r.reason]).toEqual([c, true, expect.stringContaining('src/b.ts')]);
    }
    for (const c of UNKNOWN) {
      const r = await hook(cwd, `${c}touch src/b.ts`);
      expect([c, r.denied]).toEqual([c, false]);
    }
  });

  test('a tests-role agent may still write a test file through the same spelling', async () => {
    const r = await hook(join(proj, 'src'), 'cd "$HOME/proj" && touch tests/b.test.ts');
    expect(r.denied).toBe(false);
  });
});

describe('the reader itself: the dir a `cd` with HOME leaves', () => {
  test('cd with no operand, $HOME and ${HOME}/x go to the account home when HOME is unset, empty or blank', () => {
    const account = homedir();
    try {
      for (const value of [undefined, '', '   ']) {
        if (value === undefined) delete process.env.HOME;
        else process.env.HOME = value;
        expect([value, cdTarget(['cd'], '/a')]).toEqual([value, account]);
        expect([value, cdTarget(['cd', '$HOME'], '/a')]).toEqual([value, account]);
        expect([value, cdTarget(['cd', '${HOME}/x'], '/a')]).toEqual([value, join(account, 'x')]);
        expect([value, cdTarget(['cd', '~/x'], '/a')]).toEqual([value, join(account, 'x')]);
      }
    } finally {
      process.env.HOME = home;
    }
  });

  test('a segment after cd "$HOME/proj" carries that dir, and one after an unknown spelling carries null', () => {
    const known = readCommand('cd "$HOME/proj" && ls', away).segments.find((s) => s.words[0] === 'ls');
    expect(known?.dir).toBe(proj);
    for (const c of UNKNOWN) {
      const s = readCommand(`${c}ls`, away).segments.find((x) => x.words[0] === 'ls');
      expect([c, s?.dir]).toEqual([c, null]);
    }
  });

  test('$HOME and ${HOME} alone, with a trailing slash, and with .. resolve as the OS would', () => {
    expect(cdTarget(['cd', '$HOME/'], '/a')).toBe(home);
    expect(cdTarget(['cd', '${HOME}/proj/../proj/src'], '/a')).toBe(join(proj, 'src'));
    expect(cdTarget(['cd', '-P', '$HOME/proj'], '/a')).toBe(proj);
    expect(cdTarget(['cd', '$HOME/proj'], null)).toBeNull();
  });
});
