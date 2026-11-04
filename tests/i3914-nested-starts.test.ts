// v0.36.14 (#39 follow-up, plan §15.30 items 1-2): a project dir that is no repo (`proj/`) holding the
// repos `be/` (commits) and `fe/` (none) gets a session start per nested repo.
//   item 1: `repoOfFile` (the nearest dir up to the project dir that holds a `.git` entry the repo-top
//           check confirms; a planted `.git` is passed over; a `.git` file counts; spelled like the
//           project dir) and `nestedRepos` (the bounded walk down: no links, depth 4, 2 000 dirs, 64
//           repos, dot dirs and node_modules skipped, caps reported);
//   item 2: one tips file per repository (`start-tips-<hash of the common dir>.json`, the session's own
//           repo keeps `start-tips.json`), the eager pins per nested repo written by the real
//           SessionStart, a repo first seen later (a clone: unknown, with its own text; `git init`:
//           empty), the cap notice, and the state guard keeping the new file name.
// Repos are temporary and git runs for real; SessionStart and PreToolUse are spawned. The library is
// read in this process for the units and for the start of a repo first seen later.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ensureSessionDir } from '../lib/file-tracker';
import { nestedRepos, repoOfFile } from '../lib/nested-repos';
import { sessionStartRan, topStart, worktreesAtStart } from '../lib/start-pins';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';
import { WALK_CAP_NOTICE } from '../hooks/session-start';

const ROOT = resolve(import.meta.dir, '..');
setDefaultTimeout(60_000);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmp(prefix = 'goodboy-i3914-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (p.exitCode !== 0) throw new Error(`${cmd}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const GIT_INIT = 'git init -q -b main && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false';

/** A repo at `dir` with one commit. */
function commitRepo(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  write(dir, 'src/x.ts', `export const ${name} = 1;\n`);
  sh(dir, `${GIT_INIT} && git add -A && git commit -q -m init`);
  return dir;
}
/** A repo at `dir` with no commit. */
function emptyRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, GIT_INIT);
  return dir;
}
const head = (repo: string): string => sh(repo, 'git rev-parse HEAD');
const tipsName = (common: string): string => `start-tips-${createHash('sha256').update(common).digest('hex').slice(0, 16)}.json`;
const commonOf = (repo: string): string => realpathSync(join(repo, '.git'));

interface Proj {
  base: string;
  /** The plain project dir. */
  proj: string;
  be: string;
  fe: string;
  home: string;
  sid: string;
  sdir: string;
}
let counter = 0;
/** A plain `proj/` (no git) holding `be` (one commit) and `fe` (no commit). */
function project(): Proj {
  const base = tmp();
  const proj = join(base, 'proj');
  mkdirSync(proj);
  const be = commitRepo(join(proj, 'be'), 'be');
  const fe = emptyRepo(join(proj, 'fe'));
  const sid = `i3914${Math.random().toString(36).slice(2, 8)}${counter++}`;
  const sdir = join(tmpdir(), `goodboy-session-${sid}`);
  dirs.push(sdir);
  return { base, proj, be, fe, home: tmp('goodboy-i3914-home-'), sid, sdir };
}

const baseEnv = (p: Proj, projectDir: string): Record<string, string> => ({
  ...(process.env as Record<string, string>),
  HOME: p.home,
  CLAUDE_PLUGIN_ROOT: ROOT,
  CLAUDE_PROJECT_DIR: projectDir,
  GOODBOY_DISABLE_DELEGATION: '1',
  GOODBOY_POLICY_GATE: 'off',
  GOODBOY_DOCS_GATE: 'off',
});

async function hook(p: Proj, cwd: string, script: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(['bun', join(ROOT, 'hooks', script)], {
    cwd,
    env: baseEnv(p, cwd),
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: p.sid, cwd, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(out || '{}') as Record<string, unknown>;
}
const startSession = (p: Proj, cwd: string = p.proj) => hook(p, cwd, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });

interface Pin {
  top: string;
  start: { kind: string; head?: string; reason?: string };
}
/** Every start pin in the session dir, by top. */
function pins(p: Proj): Record<string, Pin['start']> {
  const out: Record<string, Pin['start']> = {};
  for (const f of readdirSync(p.sdir)) {
    if (!/^start-pin-[0-9a-f]{16}\.json$/.test(f)) continue;
    const e = JSON.parse(readFileSync(join(p.sdir, f), 'utf8')) as Pin;
    out[e.top] = e.start;
  }
  return out;
}
const tipsFiles = (p: Proj): string[] => readdirSync(p.sdir).filter((f) => /^start-tips(?:-[0-9a-f]{16})?\.json$/.test(f)).sort();

// ── Item 1: repoOfFile ───────────────────────────────────────────────────────────────────────

describe('repoOfFile', () => {
  test('the repo of a file is the nearest one up to the project dir; a loose file and a file outside name none', () => {
    const p = project();
    write(p.proj, 'notes.txt', 'x\n');
    write(p.base, 'outside.ts', 'x\n');
    expect(repoOfFile(join(p.be, 'src', 'x.ts'), p.proj)).toEqual({ top: p.be, realTop: p.be });
    expect(repoOfFile(join(p.fe, 'new.ts'), p.proj)).toEqual({ top: p.fe, realTop: p.fe });
    expect(repoOfFile('be/src/deep/er/y.ts', p.proj)).toEqual({ top: p.be, realTop: p.be }); // a relative name resolves against the project dir
    expect(repoOfFile(join(p.proj, 'notes.txt'), p.proj)).toBeNull();
    expect(repoOfFile(join(p.base, 'outside.ts'), p.proj)).toBeNull();
    expect(repoOfFile(`${p.proj}/../outside.ts`, p.proj)).toBeNull();
  });

  test('a `.git` that is no repo top (planted, empty or junk) is passed over and the walk goes on up', () => {
    const p = project();
    mkdirSync(join(p.be, 'src', '.git')); // an empty one
    write(p.be, 'lib/.git/HEAD', 'nothing\n'); // a junk one
    write(p.be, 'gen/.git', 'gitdir: /nonexistent/nowhere\n'); // a `.git` file to nowhere
    for (const f of ['src/y.ts', 'src/deeper/y.ts', 'lib/y.ts', 'gen/y.ts']) expect(repoOfFile(join(p.be, f), p.proj)).toEqual({ top: p.be, realTop: p.be });
    // A planted one in a loose folder of the project dir leaves the file loose.
    write(p.proj, 'loose/.git/HEAD', 'nothing\n');
    expect(repoOfFile(join(p.proj, 'loose', 'y.ts'), p.proj)).toBeNull();
  });

  test('a `.git` file (a submodule or a separate git dir) is a repo top', () => {
    const p = project();
    const mod = join(p.proj, 'mod');
    mkdirSync(mod);
    sh(mod, `git init -q -b main --separate-git-dir ${JSON.stringify(join(p.base, 'mod.git'))} && git config user.email t@e.com && git config user.name t`);
    expect(readFileSync(join(mod, '.git'), 'utf8')).toContain('gitdir:');
    write(mod, 'a.ts', 'x\n');
    expect(repoOfFile(join(mod, 'a.ts'), p.proj)).toEqual({ top: mod, realTop: mod });
  });

  test('a clone inside a repo is its own repo; the project dir that is itself a repo is a top too', () => {
    const p = project();
    const inner = commitRepo(join(p.be, 'vendor', 'lib'), 'lib');
    expect(repoOfFile(join(inner, 'src', 'x.ts'), p.proj)).toEqual({ top: inner, realTop: inner });
    expect(repoOfFile(join(p.be, 'src', 'x.ts'), p.proj)).toEqual({ top: p.be, realTop: p.be });
    expect(repoOfFile(join(p.be, 'src', 'x.ts'), p.be)).toEqual({ top: p.be, realTop: p.be });
  });

  test('`top` is spelled like the project dir; `realTop` is the real dir (a project dir reached through a link)', () => {
    const p = project();
    const link = join(p.base, 'proj-link');
    symlinkSync(p.proj, link);
    // The file spelled through the link, and spelled by its real path, with the project dir spelled through the link.
    for (const file of [join(link, 'be', 'src', 'x.ts'), join(p.be, 'src', 'x.ts')]) {
      expect(repoOfFile(file, link)).toEqual({ top: join(link, 'be'), realTop: p.be });
    }
    // And with the project dir spelled for real, a file spelled through the link.
    expect(repoOfFile(join(link, 'fe', 'a.ts'), p.proj)).toEqual({ top: p.fe, realTop: p.fe });
  });

  test('the answers of one memo are shared by the files of a dir', () => {
    const p = project();
    const memo = new Map();
    repoOfFile(join(p.be, 'src', 'x.ts'), p.proj, memo);
    expect(memo.get(join(p.be, 'src'))).toEqual({ top: p.be, realTop: p.be });
    expect(memo.get(p.be)).toEqual({ top: p.be, realTop: p.be });
    expect(repoOfFile(join(p.be, 'src', 'other.ts'), p.proj, memo)).toEqual({ top: p.be, realTop: p.be });
  });
});

// ── Item 1: nestedRepos ──────────────────────────────────────────────────────────────────────

describe('nestedRepos', () => {
  test('finds the repos below the project dir, sorted, with no cap hit', () => {
    const p = project();
    const mod = join(p.proj, 'mod');
    mkdirSync(mod);
    sh(mod, `git init -q -b main --separate-git-dir ${JSON.stringify(join(p.base, 'mod.git'))}`);
    const out = nestedRepos(p.proj);
    expect(out).toEqual({ repos: [p.be, p.fe, mod].map((r) => ({ top: r, realTop: r })), capped: false, unanswered: [] });
  });

  test('a planted `.git`, a dot dir, node_modules and a symlinked dir are not repos', () => {
    const p = project();
    mkdirSync(join(p.be, 'src', '.git')); // not a repo top
    commitRepo(join(p.proj, '.hidden', 'r'), 'h');
    commitRepo(join(p.proj, 'node_modules', 'pkg'), 'n');
    symlinkSync(p.be, join(p.proj, 'alias')); // never followed
    write(p.proj, 'plain/x.ts', 'x\n');
    expect(nestedRepos(p.proj).repos.map((r) => r.top)).toEqual([p.be, p.fe]);
  });

  test('descends into the repos it finds: a clone inside one is listed', () => {
    const p = project();
    const inner = commitRepo(join(p.be, 'vendor', 'lib'), 'lib');
    expect(nestedRepos(p.proj).repos.map((r) => r.top)).toEqual([p.be, p.fe, inner]);
  });

  test('the spelled top follows the project dir; the real top is the real dir', () => {
    const p = project();
    const link = join(p.base, 'proj-link');
    symlinkSync(p.proj, link);
    expect(nestedRepos(link).repos).toEqual([
      { top: join(link, 'be'), realTop: p.be },
      { top: join(link, 'fe'), realTop: p.fe },
    ]);
  });

  test('depth: a repo 4 levels down is found, one at 5 is not and the walk says it stopped', () => {
    const base = tmp();
    const proj = join(base, 'proj');
    const r4 = commitRepo(join(proj, 'a', 'b', 'c', 'd'), 'r4');
    const r5 = commitRepo(join(base, 'proj2', 'a', 'b', 'c', 'd', 'e'), 'r5');
    expect(nestedRepos(proj)).toEqual({ repos: [{ top: r4, realTop: r4 }], capped: false, unanswered: [] });
    const deep = nestedRepos(join(base, 'proj2'));
    expect(deep.repos).toEqual([]);
    expect(deep.capped).toBe(true);
    expect(r5).toContain('proj2');
  });

  test('the depth limit inside a repo is no cap (the code of a repo is deeper than 4 levels)', () => {
    const p = project();
    mkdirSync(join(p.be, 'src', 'main', 'java', 'com', 'x'), { recursive: true });
    expect(nestedRepos(p.proj)).toEqual({ repos: [p.be, p.fe].map((r) => ({ top: r, realTop: r })), capped: false, unanswered: [] });
  });

  test('the dirs cap (injectable) stops the walk and says so; the shallow repos are kept', () => {
    const p = project();
    for (let i = 0; i < 20; i++) mkdirSync(join(p.proj, 'pad', `d${i}`), { recursive: true });
    const out = nestedRepos(p.proj, { dirs: 6 });
    expect(out.capped).toBe(true);
    expect(out.repos.map((r) => r.top)).toEqual([p.be, p.fe]); // root, be, fe, pad, then the cap
    expect(nestedRepos(p.proj, { dirs: 100 }).capped).toBe(false);
  });

  test('the repos cap (injectable) stops the walk and says so', () => {
    const p = project();
    commitRepo(join(p.proj, 'zz'), 'zz');
    const out = nestedRepos(p.proj, { repos: 2 });
    expect(out.repos.map((r) => r.top)).toEqual([p.be, p.fe]);
    expect(out.capped).toBe(true);
    expect(nestedRepos(p.proj, { repos: 3 }).capped).toBe(false);
  });
});

// ── Item 2: the snapshot at SessionStart ─────────────────────────────────────────────────────

describe('SessionStart in a project dir that is no repo', () => {
  test('each nested repo gets its own tips file and pin: `be` at its HEAD, `fe` empty; the session keeps no start-tips.json', async () => {
    const p = project();
    const wt = join(p.proj, 'be-wt');
    sh(p.be, `git worktree add -q --detach ${JSON.stringify(wt)} HEAD`);
    const out = await startSession(p);
    expect(out.systemMessage ?? '').not.toContain(WALK_CAP_NOTICE);
    expect(tipsFiles(p)).toEqual([tipsName(commonOf(p.be)), tipsName(commonOf(p.fe))].sort());
    const beTips = JSON.parse(readFileSync(join(p.sdir, tipsName(commonOf(p.be))), 'utf8')) as { common: string; tips: string[]; worktrees: { top: string }[] };
    expect(beTips.common).toBe(commonOf(p.be));
    expect(beTips.tips).toEqual([head(p.be)]);
    expect(beTips.worktrees.map((w) => w.top).sort()).toEqual([p.be, wt].sort()); // its linked worktree is pinned too
    const feTips = JSON.parse(readFileSync(join(p.sdir, tipsName(commonOf(p.fe))), 'utf8')) as { tips: string[] };
    expect(feTips.tips).toEqual([]);
    expect(pins(p)).toEqual({ [p.be]: { kind: 'commit', head: head(p.be) }, [wt]: { kind: 'commit', head: head(p.be) }, [p.fe]: { kind: 'empty' } });
    // The same files are found per repository.
    expect(worktreesAtStart(p.sid, commonOf(p.be)).map((w) => w.top).sort()).toEqual([p.be, wt].sort());
    expect(worktreesAtStart(p.sid, commonOf(p.fe)).map((w) => w.top)).toEqual([p.fe]);
    expect(worktreesAtStart(p.sid)).toEqual([]); // no repo of its own: the session's own file does not exist
    expect(sessionStartRan(p.sid)).toBe(true);
  });

  test('the starts read back through topStart: a pin stands after a later commit', async () => {
    const p = project();
    await startSession(p);
    const first = head(p.be);
    write(p.be, 'src/z.ts', 'export const z = 1;\n');
    sh(p.be, 'git add -A && git commit -q -m later');
    write(p.fe, 'a.ts', 'x\n');
    sh(p.fe, 'git add -A && git commit -q -m first');
    expect(topStart(p.sid, p.be)).toEqual({ kind: 'commit', head: first });
    expect(topStart(p.sid, p.fe)).toEqual({ kind: 'empty' });
  });

  test('a repo with a planted `be/src/.git`, a `.git` file repo and a symlinked project dir spelling', async () => {
    const p = project();
    mkdirSync(join(p.be, 'src', '.git'));
    const mod = join(p.proj, 'mod');
    mkdirSync(mod);
    sh(mod, `git init -q -b main --separate-git-dir ${JSON.stringify(join(p.base, 'mod.git'))} && git config user.email t@e.com && git config user.name t && git config commit.gpgsign false`);
    write(mod, 'a.ts', 'x\n');
    sh(mod, 'git add -A && git commit -q -m m');
    const link = join(p.base, 'proj-link');
    symlinkSync(p.proj, link);
    await startSession(p, link);
    // The pins hold real tops (the key is canonical); nothing is pinned for the planted dir.
    expect(pins(p)).toEqual({ [p.be]: { kind: 'commit', head: head(p.be) }, [p.fe]: { kind: 'empty' }, [mod]: { kind: 'commit', head: head(mod) } });
    expect(tipsFiles(p)).toHaveLength(3);
    expect(existsSync(join(p.sdir, tipsName(realpathSync(join(p.be, 'src', '.git')))))).toBe(false);
  });

  test('a repo cloned after the start is unknown, with the first-seen text; one made by `git init` is empty', async () => {
    const p = project();
    await startSession(p);
    const clone = join(p.proj, 'clone');
    sh(p.base, `git clone -q ${JSON.stringify(p.be)} ${JSON.stringify(clone)}`);
    const fresh = emptyRepo(join(p.proj, 'fresh'));
    const s = topStart(p.sid, clone);
    expect(s.kind).toBe('unknown');
    if (s.kind !== 'unknown') throw new Error('unreachable');
    expect(s.reason).toContain('first seen during the session');
    expect(s.reason).toContain('the project dir is no repo');
    expect(s.reason).toContain('only within the caps (depth 4, 2000 dirs, 64 repos)');
    expect(s.reason).not.toContain('before v0.36.7');
    expect(s.incomplete).toBeUndefined();
    expect(topStart(p.sid, fresh)).toEqual({ kind: 'empty' });
    // The answers are pinned, per repo.
    expect(Object.keys(pins(p)).sort()).toEqual([p.be, p.fe, clone, fresh].sort());
  });

  test('a repo past the caps is not snapshotted: SessionStart says so, and the repo is first seen later', async () => {
    const p = project();
    const deep = commitRepo(join(p.proj, 'a', 'b', 'c', 'd', 'e'), 'deep');
    const out = await startSession(p);
    expect(String(out.systemMessage)).toContain(WALK_CAP_NOTICE);
    expect(WALK_CAP_NOTICE.split('\n')).toHaveLength(1); // one short line
    expect(Object.keys(pins(p)).sort()).toEqual([p.be, p.fe].sort());
    const s = topStart(p.sid, deep);
    expect(s.kind === 'unknown' && s.reason).toContain('first seen during the session');
  });

  test('the dirs cap through the real hook: 2 100 plain dirs say so, and the repos found before it are pinned', async () => {
    const p = project();
    for (let i = 0; i < 2100; i++) mkdirSync(join(p.proj, 'pad', `d${i}`), { recursive: true });
    const out = await startSession(p);
    expect(String(out.systemMessage)).toContain(WALK_CAP_NOTICE);
    expect(Object.keys(pins(p)).sort()).toEqual([p.be, p.fe].sort());
  });
});

describe('the session\'s own repository keeps start-tips.json', () => {
  test('a project dir that is a repo: one start-tips.json, no hashed file, worktrees read by its common dir', async () => {
    const p = project();
    const wt = join(p.base, 'wt');
    sh(p.be, `git worktree add -q --detach ${JSON.stringify(wt)} HEAD`);
    const out = await hook(p, p.be, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(String(out.systemMessage ?? '')).not.toContain(WALK_CAP_NOTICE);
    expect(tipsFiles(p)).toEqual(['start-tips.json']);
    expect(worktreesAtStart(p.sid, commonOf(p.be)).map((w) => w.top).sort()).toEqual([p.be, wt].sort());
    expect(worktreesAtStart(p.sid).map((w) => w.top).sort()).toEqual([p.be, wt].sort());
    expect(worktreesAtStart(p.sid, commonOf(p.fe))).toEqual([]); // another repository: no snapshot of it
    // A repo cloned into it keeps the pre-#39 reading: another repository than the one the session started in.
    const clone = join(p.be, 'clone');
    sh(p.base, `git clone -q ${JSON.stringify(p.be)} ${JSON.stringify(clone)}`);
    const s = topStart(p.sid, clone);
    expect(s.kind === 'unknown' && s.reason).toContain('another repository');
  });

  test('a pre-v0.36.7 session of a repo (a coverage pin, no tips) keeps the old text', async () => {
    const p = project();
    await hook(p, p.be, 'session-start.ts', { hook_event_name: 'SessionStart', source: 'startup' });
    rmSync(join(p.sdir, 'start-tips.json'));
    rmSync(join(p.sdir, readdirSync(p.sdir).find((f) => f.startsWith('start-pin-'))!));
    const clone = join(p.be, 'clone');
    sh(p.base, `git clone -q ${JSON.stringify(p.be)} ${JSON.stringify(clone)}`);
    const s = topStart(p.sid, clone);
    expect(s.kind === 'unknown' && s.reason).toContain('the session has no start snapshot (it began before v0.36.7');
  });
});

// ── Item 2: the state guard ──────────────────────────────────────────────────────────────────

describe('the state guard keeps the per-repository tips file', () => {
  test('a tips file a Bash call rewrote is restored, deleted is restored, and one it created is removed', async () => {
    const p = project();
    await startSession(p);
    const dir = ensureSessionDir(p.sid);
    const name = tipsName(commonOf(p.be));
    const before = readFileSync(join(dir, name), 'utf8');
    snapshotGateState(p.sid, 'toolu_i3914a');
    writeFileSync(join(dir, name), '{}');
    rmSync(join(dir, tipsName(commonOf(p.fe))));
    const forged = tipsName(join(p.base, 'elsewhere', '.git')); // another repo's tips: a forged start
    writeFileSync(join(dir, forged), JSON.stringify({ v: 1, common: 'x', tips: [], worktrees: [] }));
    const restored = restoreGateState(p.sid, 'toolu_i3914a');
    expect(restored.sort()).toEqual([forged, name, tipsName(commonOf(p.fe))].sort());
    expect(readFileSync(join(dir, name), 'utf8')).toBe(before);
    expect(existsSync(join(dir, tipsName(commonOf(p.fe))))).toBe(true);
    expect(existsSync(join(dir, forged))).toBe(false);
  });

  test('a Bash command and a Write that name the tips file are refused by PreToolUse', async () => {
    const p = project();
    await startSession(p);
    const target = join(p.sdir, tipsName(commonOf(p.be)));
    const bash = await hook(p, p.proj, 'pre-tool-use.ts', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_i3914b', tool_input: { command: `printf '{}' > ${target}` } });
    const rm = await hook(p, p.proj, 'pre-tool-use.ts', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_i3914c', tool_input: { command: `rm -f ${target}` } });
    const wr = await hook(p, p.proj, 'pre-tool-use.ts', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'toolu_i3914d', tool_input: { file_path: target, content: '{}' } });
    for (const o of [bash, rm, wr]) {
      const h = (o.hookSpecificOutput ?? {}) as Record<string, string>;
      expect(h.permissionDecision).toBe('deny');
      expect(h.permissionDecisionReason).toContain("goodboy's own session state");
    }
    expect(JSON.parse(readFileSync(target, 'utf8')).common).toBe(commonOf(p.be)); // untouched
  });
});

describe('sessionStartRan', () => {
  test('a nested repo\'s tips file alone says SessionStart ran; no file does not', () => {
    const p = project();
    expect(sessionStartRan(p.sid)).toBe(false);
    writeFileSync(join(ensureSessionDir(p.sid), tipsName(commonOf(p.be))), '{}');
    expect(sessionStartRan(p.sid)).toBe(true);
  });
});
