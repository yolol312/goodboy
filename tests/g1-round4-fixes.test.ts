// Round-4 fixes (layer-1 record D1–D6 and its notes): program names as the system finds them,
// shells that read stdin, alias values split as git splits them, hook git settings, and the
// commit rule's spawn cap and depth message. Repos and session dirs are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approvalMarkerPath, userMarkerPresent } from '../lib/approval-marker';
import { commitIssueDenial } from '../lib/commit-issue';
import { filterOffArgs, HOOK_GIT_ENV, splitAliasValue } from '../lib/hook-git';
import { readCommand, shellReadsStdin } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { ensureSessionDir } from '../lib/file-tracker';
import { restoreGateState, snapshotGateState, writesGateState } from '../lib/state-guard';

const PRE = resolve(import.meta.dir, '..', 'hooks', 'pre-tool-use.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function sh(cwd: string, command: string): string {
  const p = Bun.spawnSync(['sh', '-c', command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`${command}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-r4f-')));
  dirs.push(dir);
  sh(dir, "git init -q -b main && git config user.email t@example.com && git config user.name t && git config commit.gpgsign false && echo a > a.txt && git add -A && git commit -q -m 'ABC-1 init' && mkdir .claude");
  return dir;
}

function sid(): string {
  const s = `r4f${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const words = (command: string) => readCommand(command, '/x').segments.map((s) => s.words);
const RULES = { allow: [], production: ['api.corp.net'] };

describe('program names as the system finds them', () => {
  test('letter case, paths of prefix programs and dashed git programs', () => {
    expect(words('GIT push origin main')).toEqual([['git', 'push', 'origin', 'main']]);
    expect(words('/usr/bin/env FOO=1 git push')).toEqual([['git', 'push']]);
    expect(words('SUDO -n CURL -X DELETE https://x.example')).toEqual([['curl', '-X', 'DELETE', 'https://x.example']]);
    expect(words('/opt/git-core/git-push origin main')).toEqual([['git', 'push', 'origin', 'main']]);
    expect(words('/usr/local/bin/Git status')).toEqual([['/usr/local/bin/git', 'status']]);
  });

  test('a read program in capitals is still a read of gate state', () => {
    expect(writesGateState('CAT /tmp/goodboy-session-x/edits.jsonl')).toBe(false);
    expect(writesGateState('RM /tmp/goodboy-session-x/edits.jsonl')).toBe(true);
  });

  test('`CD` is another program (it moves nothing), so the dir stays', () => {
    const segs = readCommand('CD /elsewhere && git push', '/repo').segments;
    expect(segs.map((s) => [s.words[0], s.dir])).toEqual([
      ['CD', '/repo'],
      ['git', '/repo'],
    ]);
    // A cd by path is the same child-shell program.
    expect(readCommand('/usr/bin/cd /elsewhere && git push', '/repo').segments.map((s) => s.dir)).toEqual(['/repo', '/repo']);
    expect(readCommand('cd /elsewhere && git push', '/repo').segments.map((s) => s.dir)).toEqual(['/elsewhere', '/elsewhere']);
  });
});

describe('shells that read their script from stdin', () => {
  test('flags with values, `-` and /dev/stdin', () => {
    for (const c of ['bash', 'bash -e', 'bash -o errexit', 'bash -eo pipefail', 'bash -s x', 'bash /dev/stdin', 'bash -', 'bash --rcfile r']) {
      expect([c, shellReadsStdin(c.split(' '))]).toEqual([c, true]);
    }
    for (const c of ['bash script.sh', 'bash -lc x', 'bash -o errexit script.sh', 'sh -c x', 'bash -- -x.sh']) {
      expect([c, shellReadsStdin(c.split(' '))]).toEqual([c, false]);
    }
  });

  test('the commit rule reads them; a literal `-c` script with a substitution is no eval', () => {
    const r = repo();
    expect(commitIssueDenial("bash -o errexit <<'EOF'\ngit commit -m fix\nEOF", r, sid())).toContain('no issue number');
    expect(commitIssueDenial("bash /dev/stdin <<'EOF'\ngit commit -m fix\nEOF", r, sid())).toContain('no issue number');
    expect(commitIssueDenial(`sh -c 'git commit -m "ABC-1 $(date)"'`, r, sid())).toBeNull();
  });

  test("the push check calls a `-c` script made by a substitution unclear", () => {
    const r = repo();
    const h = handoffsOf("bash -c \"$(cat <<'EOF'\ngit push origin main\nEOF\n)\"", r, RULES);
    expect(h.map((x) => x.unclear)).toEqual(['it runs the output of a command substitution']);
    expect(handoffsOf('bash -o errexit <<EOF\ngit push origin main\nEOF', r, RULES).map((x) => x.unclear)).toEqual(['it feeds a script to a shell on stdin']);
    expect(handoffsOf('bash <<EOF\ngit send-pack ../b.git main\nEOF', r, RULES).map((x) => x.unclear)).toEqual(['it feeds a script to a shell on stdin']);
  });
});

describe('alias values split as git splits them', () => {
  test('quotes and backslashes group and escape', () => {
    expect(splitAliasValue("'commit' -m fix")).toEqual(['commit', '-m', 'fix']);
    expect(splitAliasValue('com\\mit -m "a b"')).toEqual(['commit', '-m', 'a b']);
    expect(splitAliasValue('  log   --oneline ')).toEqual(['log', '--oneline']);
    expect(splitAliasValue("-m ''")).toEqual(['-m', '']);
    expect(splitAliasValue('-m "a\\"b"')).toEqual(['-m', 'a"b']);
  });
});

describe('hook git settings', () => {
  test('filter drivers are emptied by name; no protocol is allowed', () => {
    expect(filterOffArgs('filter.lfs.clean\nfilter.lfs.smudge\nfilter.a.b.process\n')).toEqual([
      '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false',
      '-c', 'filter.a.b.clean=', '-c', 'filter.a.b.process=', '-c', 'filter.a.b.required=false',
    ]);
    const r = repo();
    const p = Bun.spawnSync(['git', 'ls-remote', r], { cwd: r, env: { ...process.env, ...HOOK_GIT_ENV }, stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).not.toBe(0);
  });

  test("the push check's git starts no fsmonitor", async () => {
    const r = repo();
    const s = sid();
    const marker = approvalMarkerPath(r, 'stop', s);
    const trap = join(r, '.git', 'fsmon.sh');
    writeFileSync(trap, `#!/bin/sh\n: > "${marker}"\nexit 1\n`);
    chmodSync(trap, 0o755);
    sh(r, `git config core.fsmonitor "${trap}" && echo new > b.txt`);
    const proc = Bun.spawn(['bun', PRE], {
      cwd: r,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, cwd: r, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm publish' }, tool_use_id: 'tu-fsm' })),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_REASONING_GATE: 'off' },
    });
    await proc.exited;
    expect(existsSync(marker) && userMarkerPresent(s, marker)).toBe(false);
  }, 30_000);
});

describe('state guard restore', () => {
  test('a guarded file replaced by a directory is put back as a file', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    const pins = join(dir, 'commit-issue-pins.json');
    writeFileSync(pins, '{"since":1,"pins":{}}');
    snapshotGateState(s, 'tu-dir');
    rmSync(pins);
    mkdirSync(pins);
    restoreGateState(s, 'tu-dir');
    expect(Bun.file(pins).size).toBeGreaterThan(0);
    expect(require('node:fs').readFileSync(pins, 'utf8')).toBe('{"since":1,"pins":{}}');
  });

  test('a file that cannot be put back does not stop the later ones', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    const pins = join(dir, 'commit-issue-pins.json');
    const edits = join(dir, 'edits.jsonl');
    writeFileSync(pins, '{"since":1,"pins":{}}');
    writeFileSync(edits, '{"file":"/x/a.ts","turn":1}\n');
    snapshotGateState(s, 'tu-ro');
    rmSync(pins);
    mkdirSync(join(pins, 'inner'), { recursive: true });
    chmodSync(pins, 0o555); // its entries cannot be removed
    writeFileSync(edits, '');
    try {
      restoreGateState(s, 'tu-ro');
      expect(require('node:fs').readFileSync(edits, 'utf8')).toBe('{"file":"/x/a.ts","turn":1}\n');
    } finally {
      chmodSync(pins, 0o755);
    }
  });
});

describe('commit rule caps', () => {
  test('a ninth git spawn denies; a third alias level names the depth', () => {
    const r = repo();
    const nine = Array.from({ length: 9 }, (_, i) => `git zz${i}`).join('; ');
    expect(commitIssueDenial(nine, r, sid())).toContain('more git aliases or reused commit messages');
    sh(r, 'git config alias.a b && git config alias.b c && git config alias.c commit');
    expect(commitIssueDenial('git a -m fix', r, sid())).toContain('deeper than goodboy follows');
  });
});

describe('git send-pack', () => {
  test('the push check calls it unclear; R2 sees its host', async () => {
    const r = repo();
    expect(handoffsOf('git send-pack git@api.corp.net:x.git main', r, RULES).map((h) => h.unclear)[0]).toContain('send-pack');
    mkdirSync(join(r, '.goodboy'));
    writeFileSync(join(r, '.goodboy', 'hosts'), 'production api.corp.net\n');
    const { classifyOutward } = await import('../lib/outward-command');
    expect(classifyOutward('git send-pack git@api.corp.net:x.git main', r)).toEqual([{ kind: 'git push', host: 'api.corp.net', mutating: true }]);
  });
});
