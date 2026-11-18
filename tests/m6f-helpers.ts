// Shared by tests/m6f-*.test.ts (track M, M6f; plan §19): real temp git repos for the commit and push scan, a
// real-data project fixture (a `local.json` that says `realData`), the canaries (one value of each shape the scanner
// knows), and the environment git runs under in those tests (no user config, no hooks from outside).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sandboxIn } from './m6b-helpers';

/** One value per shape: a resident number, a card (Luhn), a mobile phone, an email, an access key. */
export const CANARY = {
  rrn: '900101-1234567',
  card: '4111111111111111',
  phone: '010-1234-5678',
  email: 'kim.minsu@naver.com',
  secret: 'AKIAIOSFODNN7EXAMPLE',
} as const;
export const KINDS = { rrn: 'resident-number', card: 'card', phone: 'phone', email: 'email', secret: 'secret' } as const;

export interface Fixture {
  base: string;
  repo: string;
  home: string;
  registry: string;
  /** The environment for a spawned git or goodboy command. */
  env: Record<string, string>;
}

const made: string[] = [];

/** Removes every fixture made so far. */
export function cleanup(): void {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
}

/** A repo (branch main, one commit of README.md) in a temp dir. With `realData`, a sandbox `local.json` that says so
 *  (committed? no: untracked, like the real file). */
export function fixture(opts: { realData?: boolean } = {}): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6f-')));
  made.push(base);
  const f: Fixture = {
    base,
    repo: join(base, 'repo'),
    home: join(base, 'home'),
    registry: join(base, 'registry'),
    env: {},
  };
  mkdirSync(f.home, { recursive: true });
  f.env = { HOME: f.home, GOODBOY_REGISTRY_DIR: f.registry, GIT_CONFIG_GLOBAL: join(f.home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  mkdirSync(f.repo, { recursive: true });
  git(f, ['init', '-q', '-b', 'main']);
  git(f, ['config', 'user.email', 'dev@corp.example']);
  git(f, ['config', 'user.name', 'Dev']);
  git(f, ['config', 'commit.gpgsign', 'false']);
  // the sandbox dir is untracked and stays out of `git add -A`, like a project that ignores it
  writeFileSync(join(f.repo, '.git', 'info', 'exclude'), '.goodboy/\n.claude/\n');
  if (opts.realData) sandboxIn(f.repo, { dump: null, dumpFormat: null, realData: true });
  put(f, 'README.md', 'readme\n');
  git(f, ['add', 'README.md']);
  git(f, ['commit', '-q', '-m', 'init #1']);
  return f;
}

/** Applies the fixture's environment to this process (git calls of the library inherit it); returns the undo. */
export function useEnv(f: Fixture): () => void {
  const was = Object.keys(f.env).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(f.env)) process.env[k] = v;
  return () => {
    for (const [k, v] of was) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Writes `text` (a string or bytes) to `rel` in the repo. */
export function put(f: Fixture, rel: string, text: string | Uint8Array): string {
  const p = join(f.repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

export interface Run {
  code: number;
  out: string;
  err: string;
}

/** git in the repo (or `cwd`), under the fixture's environment. Fails the test on a non-zero exit unless `fail` is set. */
export function git(f: Fixture, args: string[], o: { cwd?: string; fail?: boolean; env?: Record<string, string>; input?: string } = {}): Run {
  const p = Bun.spawnSync(['git', ...args], { cwd: o.cwd ?? f.repo, env: { ...process.env, ...f.env, ...(o.env ?? {}) }, stdout: 'pipe', stderr: 'pipe', ...(o.input !== undefined ? { stdin: Buffer.from(o.input) } : {}) });
  const r = { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
  if (r.code !== 0 && o.fail !== true) throw new Error(`git ${args.join(' ')}: ${r.err}`);
  return r;
}

/** A bare repo next to the fixture's repo, set as `origin` with the current main pushed to it (so it has tracking refs). */
export function withRemote(f: Fixture): string {
  const bare = join(f.base, 'origin.git');
  mkdirSync(bare, { recursive: true });
  git(f, ['init', '-q', '--bare', bare], { cwd: f.base });
  git(f, ['remote', 'add', 'origin', bare]);
  git(f, ['push', '-q', 'origin', 'main']);
  return bare;
}

/** Commits `files` (path to text) with `message` in the repo (`--no-verify`: a set-up commit passes installed hooks). */
export function commit(f: Fixture, files: Record<string, string | Uint8Array>, message = 'work #1'): void {
  for (const [rel, text] of Object.entries(files)) put(f, rel, text);
  git(f, ['add', '-A']);
  git(f, ['commit', '-q', '--no-verify', '-m', message]);
}

/** Every canary value (and a few spellings) that must not reach an output. */
export const VALUES: string[] = Object.values(CANARY);

/** The canary that is in `text`, or null. */
export function leaked(text: string): string | null {
  return VALUES.find((v) => text.includes(v)) ?? null;
}

/** The digest a denial text asks the user to approve (`echo <16 hex> > <marker>`), or ''. */
export const digestIn = (text: string): string => /echo ([0-9a-f]{16}) >/.exec(text)?.[1] ?? '';
