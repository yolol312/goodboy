// N8b (plan §20.12, v0.38.3): the defensive paths of lib/deferral.ts that a normal run never takes. Each says "never
// throws" in its header; these tests make the failure real and check what the code does with it:
//   AC-12a  a session id that cannot name a session dir (the state helpers throw on it): the watch, the Stop's read of
//           the watch and the push's globs fail closed (the file counts as written; the push still asks for the policy
//           file's own globs), against a control with a real session;
//   AC-12b  a config file git lists that cannot be resolved is not a trusted system config.
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pinCoverageStart } from '../lib/changed-coverage';
import { notePolicySeen, policyWrittenThisSession, pushDeferGlobs, systemConfigTrusted, watchPolicy } from '../lib/deferral';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(prefix = 'goodboy-n8bd-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): void {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
}
let counter = 0;
function sessionId(): string {
  const s = `n8bd${Math.random().toString(36).slice(2, 8)}${counter++}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const POLICY = ['## P1 Deferrals', '- decide: human', '- source: user 2026-11-26', '- defer-test: src/a.ts', ''].join('\n');

/** A repo whose policy file holds one `defer-test` glob, the session started in it and the file noted as the user's. */
function started(): { d: string; s: string } {
  const d = tmp();
  sh(d, 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false');
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(d, '.goodboy'));
  writeFileSync(join(d, '.goodboy', 'policy.md'), POLICY);
  sh(d, "git add -A && git commit -q -m 'ABC-1 init'");
  const s = sessionId();
  pinCoverageStart(s, d);
  notePolicySeen(s, d);
  return { d, s };
}

/** A session id the state helpers throw on (they sanitize it with a string method). */
const BAD_SESSION = 42 as unknown as string;

describe('AC-12a: a session record that cannot be read fails closed, never throws', () => {
  test('the control: a real session whose file is unchanged says nothing was written', () => {
    const w = started();
    expect(watchPolicy(w.s, w.d)).toBe(false);
    expect(policyWrittenThisSession(w.s, () => ({ files: [] }) as never)).toBe(false);
    expect(pushDeferGlobs(w.s, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
  });

  test('a session id the helpers throw on: the watch and the Stop count the file as written', () => {
    const w = started();
    expect(() => watchPolicy(BAD_SESSION, w.d)).not.toThrow();
    expect(watchPolicy(BAD_SESSION, w.d)).toBe(true);
    // The edit log names no policy file, so only the watch's own record could say "not written": it cannot be read.
    expect(policyWrittenThisSession(BAD_SESSION, () => ({ files: [] }) as never)).toBe(true);
  });

  test('a session id the helpers throw on: the push still asks for the policy file\'s own globs', () => {
    const w = started();
    expect(pushDeferGlobs(BAD_SESSION, w.d, w.d, 'defer-test')).toEqual(['src/a.ts']);
    expect(pushDeferGlobs(BAD_SESSION, w.d, w.d, 'defer-review')).toEqual([]);
  });
});

describe('AC-12b: a system config file git lists that cannot be resolved is not trusted', () => {
  /** `git config --list --show-origin -z` as a git that names `origin` would print it, the rest the real git. */
  function withGitListing(origin: string, fn: () => void): void {
    const real = Bun.which('git') ?? 'git';
    const bin = tmp();
    const script = join(bin, 'git');
    writeFileSync(
      script,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = --show-origin ]; then printf '${origin}\\0core.a=b\\0'; exit 0; fi; done\nexec "${real}" "$@"\n`,
    );
    chmodSync(script, 0o755);
    const saved = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
    process.env.PATH = `${dirname(script)}${delimiter}${saved.PATH ?? ''}`;
    delete process.env.GIT_CONFIG_NOSYSTEM;
    try {
      fn();
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.GIT_CONFIG_NOSYSTEM !== undefined) process.env.GIT_CONFIG_NOSYSTEM = saved.GIT_CONFIG_NOSYSTEM;
    }
  }

  test('a listed file that does not exist (it was removed after git read it): false, no throw', () => {
    const gone = join(tmp(), 'removed', 'gitconfig');
    withGitListing(`file:${gone}`, () => expect(systemConfigTrusted()).toBe(false));
  });

  test('the control: the same fake git listing a file this user owns is not trusted either, by the owner check', () => {
    const cfg = join(tmp(), 'gitconfig');
    writeFileSync(cfg, '[core]\n\ta = b\n');
    withGitListing(`file:${cfg}`, () => expect(systemConfigTrusted()).toBe(false));
  });
});
