// The closing G1 layer-1 round: gaps the substitution model and the GAP-BG fix still leave in
// the shared shell reader, measured against bash and zsh (scratchpad l1close/sem). Each test
// states what the real shell does; they fail until lib/outward-command.ts reads it that way.
//
// - GAP-BG2: a `cd` inside a group `{ …; }` or a compound command (`if …; fi`) that is
//   backgrounded or piped runs in a subshell in bash and zsh, so the shell does not move. An
//   AND-OR list ending in `&` (`cd X && cmd &`) runs whole in the background in bash, but zsh
//   backgrounds only its last pipeline: shell-dependent, so unclear.
// - GAP-HD: an unquoted heredoc body (`<<EOF`) expands `$(…)` and backticks like double quotes
//   do (GAP-DQ); only a quoted delimiter (`<<'EOF'`) makes the body data.
// - GAP-ANSI: `$'…'` takes `\'` as a quote character; the reader ended the string there and
//   read the rest of the command as one quoted word.
// - GAP-CASE: a `case` pattern's `)` inside `$( … )` does not close the substitution.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyOutward } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { bashChangedPaths, resultDirWrite } from '../lib/role-limits';

const rules = { allow: [], production: [] };
const stripe = 'curl -X DELETE https://api.stripe.com/v1/customers/cus_1';

describe('GAP-BG2: a backgrounded or piped group or compound command does not move the shell', () => {
  // bash and zsh both print A for each of these (`… ; pwd` run from A).
  const subshelled = ['{ cd /tmp; } & ', '{ cd /tmp; } | cat; ', 'if cd /tmp; then :; fi & ', '{ cd /tmp && true; } & '];

  test('the next segment runs where the shell was', () => {
    for (const pre of subshelled) {
      expect([pre, resultDirWrite(`${pre}cp /tmp/f.json .claude/tests/x.json`, '/proj')]).toEqual([pre, '.claude/tests/x.json']);
      expect([pre, bashChangedPaths(`${pre}cp /etc/hosts src/a.ts`, '/proj')]).toEqual([pre, ['/proj/src/a.ts']]);
      const push = handoffsOf(`${pre.replace('/tmp', '../B')}git push origin main`, '/x/A', rules)[0];
      expect([pre, push?.cwd, push?.unclear]).toEqual([pre, '/x/A', undefined]);
    }
  });

  test('`cd X && cmd &` moves the shell in zsh, not in bash: a later push is unclear', () => {
    for (const pre of ['cd ../B && true & ', 'cd ../B || true & ', 'cd ../B && sleep 1 | cat & ']) {
      expect([pre, handoffsOf(`${pre}git push origin main`, '/x/A', rules)[0]?.unclear]).toEqual([pre, expect.stringContaining('cannot follow')]);
    }
    // Writes are then read from the cwd, where bash runs them.
    expect(resultDirWrite('cd /tmp && true & cp /tmp/f.json .claude/tests/x.json', '/proj')).not.toBeNull();
    expect(bashChangedPaths('cd /tmp && true & cp /etc/hosts src/a.ts', '/proj')).toEqual(['/proj/src/a.ts']);
  });
});

describe('GAP-HD: an unquoted heredoc body runs its substitutions', () => {
  test('pushes, R2 calls and result writes in `<<EOF` bodies are read', () => {
    expect(handoffsOf('cat <<EOF\n$(git push origin main)\nEOF', '/x', rules)).toHaveLength(1);
    expect(handoffsOf('cat > notes.md <<EOF\nsent: `git push origin main`\nEOF', '/x', rules)).toHaveLength(1);
    expect(classifyOutward(`cat <<EOF\n$(${stripe})\nEOF`, '/proj').some((t) => t.mutating)).toBe(true);
    expect(resultDirWrite('cat <<EOF\n$(cp /tmp/f.json .claude/tests/x.json)\nEOF', '/proj')).not.toBeNull();
  });

  test('a quoted delimiter keeps the body data (the commit-message pattern)', () => {
    for (const d of ["'EOF'", '"EOF"', '\\EOF']) {
      const c = `git commit -m "$(cat <<${d}\nrun \`git push origin main\` and $(git push origin main) later\nEOF\n)"`;
      expect([d, handoffsOf(c, '/x', rules)]).toEqual([d, []]);
    }
  });
});

describe('GAP-ANSI: `$\'…\'` quoting', () => {
  test("an escaped quote inside `$'…'` does not end it; the next command is read", () => {
    expect(handoffsOf("echo $'a\\'b'; git push origin main", '/x', rules)).toHaveLength(1);
    expect(classifyOutward(`printf $'it\\'s\\n'; ${stripe}`, '/proj').some((t) => t.mutating)).toBe(true);
    expect(resultDirWrite("echo $'a\\'b' && cp /tmp/f.json .claude/tests/x.json", '/proj')).not.toBeNull();
  });
});

describe('GAP-CASE: a case pattern inside a substitution', () => {
  test('the `)` of `a)` does not close `$( … )`, so a cd in it stays in the subshell', () => {
    expect(bashChangedPaths('x=$(case $y in a) cd /tmp;; esac); cp f src/a.ts', '/proj')).toEqual(['/proj/src/a.ts']);
    expect(handoffsOf('x=$(case $y in a) cd ../B;; esac); git push origin main', '/x/A', rules).map((h) => [h.cwd, h.unclear ?? null])[0]).toEqual(['/x/A', null]);
  });
});

describe('carrier lookup cost, on writers whose every word is a target', () => {
  // The closing-gaps cost test copies with `cp`, whose only target is the last word, so a
  //   words × carriers lookup passed it in 30 ms. `rm` and `mv` check every word (1.7 s then).
  test('3,000 carriers and 3,000 targets stay fast', () => {
    const vars = Array.from({ length: 3_000 }, (_, i) => `v${i}`).join(' ');
    const words = Array.from({ length: 3_000 }, (_, i) => `/tmp/o${i}`).join(' ');
    for (const prog of ['rm', 'mv']) {
      const started = Date.now();
      expect(resultDirWrite(`ls .claude/tests | while read ${vars}; do ${prog} ${words}; done`, '/proj')).toBeNull();
      expect([prog, Date.now() - started < 1_000]).toEqual([prog, true]);
    }
    // Control: a carried name that leads a target still counts.
    expect(resultDirWrite('ls .claude/tests | while read a b; do rm /tmp/x "$b"; done', '/proj')).not.toBeNull();
  });
});

describe('through the PreToolUse hook', () => {
  const HOOK = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test('a grouped background cd does not hide a result write or a read-only agent\'s code write', async () => {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-l1close-'));
    dirs.push(base);
    const cwd = join(base, 'repo');
    mkdirSync(cwd);
    const run = async (command: string, agent?: string) => {
      const payload = {
        session_id: `l1c-${Math.random().toString(36).slice(2)}`,
        cwd,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        ...(agent ? { agent_type: agent, agent_id: 'a1' } : {}),
      };
      const proc = Bun.spawn(['bun', HOOK], {
        cwd,
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base },
      });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string } };
      await proc.exited;
      return out.hookSpecificOutput?.permissionDecision === 'deny';
    };
    // Controls: the same shapes without a write pass.
    expect(await run('{ cd /tmp; } & ls .claude')).toBe(false);
    expect(await run('{ cd /tmp; } | cat; ls src', 'goodboy:test-probe')).toBe(false);
    expect(await run('{ cd /tmp; } & cp /tmp/f.json .claude/tests/x.json')).toBe(true);
    expect(await run('{ cd /tmp; } | cat; cp /etc/hosts src/a.ts', 'goodboy:test-probe')).toBe(true);
  });

  // A0.79's catch had no test: no input reaches it since the nesting cap (2.3 M fuzzed commands,
  //   none threw), and without it a throw reaches the hook's outer catch, which lets the call
  //   through. A preload plugin makes the shared reader throw.
  test('a reader that throws denies the call (A0.79), it does not let it through', async () => {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-l1close-'));
    dirs.push(base);
    const cwd = join(base, 'repo');
    mkdirSync(cwd);
    const plugin = join(base, 'throwing-reader.ts');
    writeFileSync(
      plugin,
      `import { readFileSync } from 'node:fs';
Bun.plugin({
  name: 'throwing-reader',
  setup(build) {
    build.onLoad({ filter: /lib\\/outward-command\\.ts$/ }, ({ path }) => ({
      loader: 'ts',
      contents: readFileSync(path, 'utf8').replace('export function readCommand(', 'export function readCommand(..._a: unknown[]): never { throw new Error("reader boom"); }\\nfunction unusedReadCommand('),
    }));
  },
});
`,
    );
    const ask = async (preload: boolean) => {
      const payload = { session_id: `l1c-${Math.random().toString(36).slice(2)}`, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
      const proc = Bun.spawn(['bun', ...(preload ? ['--preload', plugin] : []), HOOK], {
        cwd,
        stdin: new TextEncoder().encode(JSON.stringify(payload)),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base },
      });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      await proc.exited;
      return out.hookSpecificOutput ?? {};
    };
    // Control: the same call passes with the real reader.
    expect((await ask(false)).permissionDecision).toBeUndefined();
    const thrown = await ask(true);
    expect(thrown.permissionDecision).toBe('deny');
    expect(thrown.permissionDecisionReason).toContain('too large or nested for goodboy to read');
  });
});
