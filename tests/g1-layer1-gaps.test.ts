import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { restoreProductionHosts } from '../lib/approval-marker';
import { ensureSessionDir } from '../lib/file-tracker';
import { parseHostRules } from '../lib/outward-command';
import { handoffsOf } from '../lib/push-test';
import { bashChangedPaths, resultDirWrite } from '../lib/role-limits';
import { restoreGateState, restoreOrphanGateState, snapshotGateState } from '../lib/state-guard';

// Track G step G1, layer-1 gap coverage: behaviors of the newest rules that no other test
// pinned down (found by mutation probes: each test here fails on a mutant of the rule).

const ROOT = resolve(import.meta.dir, '..');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const rules = { allow: [], production: [] };

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
}

/** A temp git repo with one commit and an `origin` remote that is never contacted. */
function repo(): string {
  const base = mkdtempSync(join(tmpdir(), 'goodboy-l1gap-'));
  tmpDirs.push(base);
  const cwd = join(base, 'repo');
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com');
  git(cwd, 'config', 'user.name', 't');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'a.txt'), 'a\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'init');
  git(cwd, 'remote', 'add', 'origin', 'https://example.org/r.git');
  return cwd;
}

/** A fresh session dir under the real tmpdir, removed after the test. */
function sessionDir(): { sid: string; dir: string } {
  const sid = `l1gap-${Math.random().toString(36).slice(2)}`;
  const dir = ensureSessionDir(sid);
  tmpDirs.push(dir);
  return { sid, dir };
}

describe('state guard: what a Bash call changed is put back', () => {
  const JSONL = ['edits.jsonl', 'dispatch-log.jsonl', 'skill-evidence.jsonl'];
  const CURSORS = ['.goodboy-last-review-0123abcd.json', '.goodboy-last-test-0123abcd.json'];
  const VALIDATION = '.goodboy-validation-failed.json';

  test('every guarded file: wiped logs, rewritten cursors and a removed validation failure', () => {
    const { sid, dir } = sessionDir();
    const before: Record<string, string> = {};
    for (const n of JSONL) before[n] = `{"n":"${n}"}\n`;
    for (const n of CURSORS) before[n] = '{"turn":1}';
    before[VALIDATION] = '{"files":["a.ts"]}';
    for (const [n, text] of Object.entries(before)) writeFileSync(join(dir, n), text);

    snapshotGateState(sid, 'toolu_l1_all');
    for (const n of JSONL) writeFileSync(join(dir, n), ''); // what the command did
    for (const n of CURSORS) writeFileSync(join(dir, n), '{"turn":99}');
    rmSync(join(dir, VALIDATION));

    expect(restoreGateState(sid, 'toolu_l1_all').sort()).toEqual(Object.keys(before).sort());
    for (const [n, text] of Object.entries(before)) expect([n, readFileSync(join(dir, n), 'utf8')]).toEqual([n, text]);
  });

  test('lines other hooks appended while the call wiped the log are kept after the old ones', () => {
    const { sid, dir } = sessionDir();
    const edits = join(dir, 'edits.jsonl');
    writeFileSync(edits, '{"file":"/p/a.ts"}\n');
    snapshotGateState(sid, 'toolu_l1_mixed');
    writeFileSync(edits, '{"file":"/p/b.ts"}\n'); // wiped, then a hook appended b.ts
    expect(restoreGateState(sid, 'toolu_l1_mixed')).toEqual(['edits.jsonl']);
    expect(readFileSync(edits, 'utf8')).toBe('{"file":"/p/a.ts"}\n{"file":"/p/b.ts"}\n');
  });

  test('a restored snapshot is gone: a cursor written later survives the next Stop', () => {
    const { sid, dir } = sessionDir();
    writeFileSync(join(dir, 'edits.jsonl'), '{"file":"/p/a.ts"}\n');
    snapshotGateState(sid, 'toolu_l1_once');
    expect(restoreGateState(sid, 'toolu_l1_once')).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.startsWith('bash-guard-'))).toEqual([]);
    const later = join(dir, '.goodboy-last-review-feedbeef.json');
    writeFileSync(later, '{"turn":2}'); // a review accepted after the call
    expect(restoreOrphanGateState(sid)).toEqual([]);
    expect(existsSync(later)).toBe(true);
  });
});

describe('approval markers and model Bash calls, through the hooks', () => {
  function sandbox() {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-l1mk-'));
    tmpDirs.push(base);
    const cwd = join(base, 'repo');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    const sid = `l1mk-${Math.random().toString(36).slice(2)}`;
    const tag = sid.slice(0, 8);
    const bash = async (hook: 'pre-tool-use' | 'post-tool-use', tuid: string, command: string, at: string = cwd) => {
      const proc = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], {
        cwd: at,
        stdin: new TextEncoder().encode(
          JSON.stringify({ session_id: sid, cwd: at, tool_name: 'Bash', tool_use_id: tuid, tool_input: { command }, ...(hook === 'post-tool-use' ? { tool_response: {} } : {}) }),
        ),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, TMPDIR: base, GOODBOY_DISABLE_DELEGATION: '1' },
      });
      const out = JSON.parse((await new Response(proc.stdout).text()) || '{}') as { hookSpecificOutput?: { permissionDecision?: string } };
      await proc.exited;
      return { denied: out.hookSpecificOutput?.permissionDecision === 'deny' };
    };
    const marker = (dir: string) => join(dir, '.claude', `.goodboy-bash-write-approved-${tag}.txt`);
    return { cwd, bash, marker };
  }

  test("the user's marker made after a finished call works (the window ends at the post hook)", async () => {
    const s = sandbox();
    await s.bash('pre-tool-use', 'toolu_l1_done', 'ls');
    await s.bash('post-tool-use', 'toolu_l1_done', 'ls');
    writeFileSync(s.marker(s.cwd), ''); // the user's `! touch`, after the call ended
    expect((await s.bash('pre-tool-use', 'toolu_l1_write', 'echo x > src.ts')).denied).toBe(false);
  });

  test('a marker made in another directory during a call is refused by its ctime, whatever its mtime (`touch -t`)', async () => {
    const s = sandbox();
    const pkg = join(s.cwd, 'pkg');
    await s.bash('pre-tool-use', 'toolu_l1_old', 'sh ./mk.sh');
    mkdirSync(join(pkg, '.claude'), { recursive: true });
    writeFileSync(s.marker(pkg), ''); // what the command did, outside its cwd
    const old = Date.now() / 1000 - 7200;
    utimesSync(s.marker(pkg), old, old);
    await s.bash('post-tool-use', 'toolu_l1_old', 'sh ./mk.sh');
    expect((await s.bash('pre-tool-use', 'toolu_l1_pkg', 'echo x > a.ts', pkg)).denied).toBe(true);
    expect(existsSync(s.marker(pkg))).toBe(false);
  });

  test('a marker made during a call that never reported back (`exit 1`) is refused by the next call, and removed', async () => {
    const s = sandbox();
    await s.bash('pre-tool-use', 'toolu_l1_exit', 'k=bash-write; touch .claude/.goodboy-$k-approved-x.txt; exit 1');
    writeFileSync(s.marker(s.cwd), ''); // what the command did; no post hook follows
    expect((await s.bash('pre-tool-use', 'toolu_l1_next', 'echo x > src.ts')).denied).toBe(true);
    expect(existsSync(s.marker(s.cwd))).toBe(false);
  });
});

describe('restoreProductionHosts', () => {
  test('an entry put back after a last line without a newline keeps both lines', () => {
    const d = mkdtempSync(join(tmpdir(), 'goodboy-l1hosts-'));
    tmpDirs.push(d);
    const file = join(d, 'hosts');
    writeFileSync(file, 'allow dev.corp.net'); // the command dropped the production line
    expect(restoreProductionHosts({ since: 0, dirs: [], hosts: { [file]: ['api.corp.net'] } })).toEqual([`${file}: api.corp.net`]);
    const after = parseHostRules(readFileSync(file, 'utf8'));
    expect(after.production).toEqual(['api.corp.net']);
    expect(after.allow).toEqual(['dev.corp.net']);
  });
});

describe('push test check: more pushes goodboy cannot read', () => {
  test('--follow-tags also sends tags: unclear', () => {
    expect(handoffsOf('git push --follow-tags origin main', '/x', rules)[0]?.unclear).toBe('it pushes every branch or tag');
  });

  test('repo config that sends more than the current branch: mirror, push.default=matching', () => {
    const cwd = repo();
    expect(handoffsOf('git push origin', cwd, rules)[0]?.unclear).toBeUndefined();
    git(cwd, 'config', 'remote.origin.mirror', 'true');
    expect(handoffsOf('git push origin', cwd, rules)[0]?.unclear).toBe('git config decides which refs it pushes');
    git(cwd, 'config', '--unset', 'remote.origin.mirror');
    git(cwd, 'config', 'push.default', 'matching');
    expect(handoffsOf('git push', cwd, rules)[0]?.unclear).toBe('git config decides which refs it pushes');
  });

  test('config from --config-env or GIT_CONFIG_PARAMETERS: unclear', () => {
    for (const c of ['git --config-env=remote.origin.push=SPEC push origin', `GIT_CONFIG_PARAMETERS="'remote.origin.mirror'='true'" git push origin main`]) {
      // Either reason is right: the push is unclear.
      expect([c, typeof handoffsOf(c, '/x', rules)[0]?.unclear]).toEqual([c, 'string']);
    }
  });

  test('a shell flag after -c (`bash -c -e …`) does not hide the script', () => {
    expect(handoffsOf("bash -c -e 'git push origin evil'", '/x', rules)[0]?.revs).toEqual(['evil']);
  });
});

describe('bashChangedPaths: option values in every spelling', () => {
  test('--opt=value, -ovalue and wget -P', () => {
    const cwd = '/p';
    expect(bashChangedPaths('curl --output=src/a.ts https://example.org/x', cwd)).toEqual(['/p/src/a.ts']);
    expect(bashChangedPaths('curl -osrc/a.ts https://example.org/x', cwd)).toEqual(['/p/src/a.ts']);
    expect(bashChangedPaths('tar -xf a.tgz --directory=src', cwd)).toEqual(['/p/src']);
    expect(bashChangedPaths('wget -P src https://example.org/x', cwd)).toEqual(['/p/src']);
  });
});

// Final G1 round: fixes from the last review that no test pinned down (mutation probes on a
// copy of the repo: each test below fails on a mutant of the named rule).

describe('result dirs: where a result-dir name ends', () => {
  test('the dir itself without a slash and `.`/`//` spellings count; a longer name does not', () => {
    for (const c of ['cp forged.json .claude/tests', 'cat r.json > .claude/reviews', 'cp f .claude/./tests/r.json', 'cp f .claude//reviews/r.json']) {
      expect([c, resultDirWrite(c, '/proj') !== null]).toEqual([c, true]);
    }
    for (const c of ['cp f .claude/tests-archive/r.json', 'cp f .claude/testsuite/r.json', 'cp f .claude/settings.json']) {
      expect([c, resultDirWrite(c, '/proj')]).toEqual([c, null]);
    }
  });
});

describe('bashChangedPaths: the command xargs runs', () => {
  test('rm, cp -I{} and touch -n 1 behind xargs change their targets', () => {
    expect(bashChangedPaths('ls src | xargs rm src/a.ts', '/p')).toEqual(['/p/src/a.ts']);
    expect(bashChangedPaths('find . -name "*.ts" | xargs -I{} cp {} src/', '/p')).toEqual(['/p/src']);
    expect(bashChangedPaths('xargs -n 1 touch src/b.ts < list', '/p')).toEqual(['/p/src/b.ts']);
  });
});

describe('push test check: config from an included file', () => {
  test('-c include.path / includeIf: a push is decided by config, an alias may come from the file', () => {
    expect(handoffsOf('git -c include.path=/tmp/x.cfg push origin main', '/x', rules)[0]?.unclear).toBe('git config decides which refs it pushes');
    for (const c of ['git -c include.path=/tmp/x.cfg p origin main', 'git -c includeIf.onbranch:main.path=/tmp/x p origin main']) {
      expect([c, handoffsOf(c, '/x', rules)[0]?.unclear]).toEqual([c, 'its git config or repository comes from the environment or another file']);
    }
  });
});

describe('push test check: the remote a bare `git push` uses (previous layer-1 BUG-2)', () => {
  // `up` is a mirror remote: git sends every branch there. It is never contacted.
  const mirrorRepo = () => {
    const cwd = repo();
    git(cwd, 'remote', 'add', 'up', join(cwd, '..', 'up.git'));
    git(cwd, 'config', 'remote.up.mirror', 'true');
    return cwd;
  };
  for (const key of ['branch.main.pushRemote', 'remote.pushDefault', 'branch.main.remote']) {
    test(`${key}=up makes \`git push\` unclear; a named remote still decides`, () => {
      const cwd = mirrorRepo();
      expect(handoffsOf('git push', cwd, rules)[0]?.unclear).toBeUndefined();
      git(cwd, 'config', key, 'up');
      expect(handoffsOf('git push', cwd, rules)[0]?.unclear).toBe('git config decides which refs it pushes');
      expect(handoffsOf('git push origin', cwd, rules)[0]).toMatchObject({ revs: ['HEAD'] });
    });
  }
});

describe('push test check: env reaches only the command it prefixes (final G1 layer-1)', () => {
  test('HOME or GIT_DIR on another command, or only echoed, leaves a later push readable', () => {
    const elsewhere = 'its git config or repository comes from the environment or another file';
    const read = (c: string) => handoffsOf(c, '/x', rules).map((h) => h.unclear ?? h.revs);
    for (const c of ['HOME=/tmp/h git status; git push origin main', 'GIT_DIR=.git git log -1 && git push origin main', 'echo HOME=$HOME && git push origin main']) {
      expect([c, read(c)]).toEqual([c, [['main']]]);
    }
    // Env on the push itself, or exported before it, still makes it unclear.
    expect(read('HOME=/tmp/h git push origin main')).toEqual([elsewhere]);
    expect(read('export GIT_DIR=/tmp/o.git && git push origin main')).toEqual([elsewhere]);
  });
});

describe('write sweep: a stalled `git status` cannot outlast the hook', () => {
  /** Runs `script` in a child bun whose `git status` hangs for 12 s (other git commands are real). */
  const withSlowGit = (script: string, env: Record<string, string>) => {
    const base = mkdtempSync(join(tmpdir(), 'goodboy-slowgit-'));
    tmpDirs.push(base);
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const realGit = Bun.which('git')!;
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = status ] && exec sleep 12; done\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const p = Bun.spawnSync(['bun', '-e', script], {
      cwd: base,
      env: { ...process.env, ...env, TMPDIR: base, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect([p.exitCode, p.stderr.toString().slice(0, 300)]).toEqual([0, '']);
    return JSON.parse(p.stdout.toString()) as { files?: string[]; ms: number; open?: number };
  };

  test('changedFilesSince gives up after its time limit', () => {
    const cwd = repo();
    const r = withSlowGit(
      `import { changedFilesSince } from '${ROOT}/lib/write-sweep';
       const t = Date.now(); const files = changedFilesSince(process.env.CWD, 0, 500);
       console.log(JSON.stringify({ files, ms: Date.now() - t }));`,
      { CWD: cwd },
    );
    expect(r.files).toEqual([]);
    expect(r.ms).toBeLessThan(4_000);
  }, 30_000);

  test('the Stop finishes four open calls well inside its 15 s: 3 s per git call, the rest skipped after 5 s', () => {
    const cwd = repo();
    const r = withSlowGit(
      `import { finishOpenBashCalls } from '${ROOT}/lib/write-sweep';
       import { noteBashStart, openBashCalls } from '${ROOT}/lib/approval-marker';
       const sid = 'l1gap-slowgit';
       for (let i = 0; i < 4; i++) noteBashStart(sid, 'toolu_slow' + i, process.env.CWD, "python3 -c 'pass'");
       const t = Date.now(); finishOpenBashCalls(sid);
       console.log(JSON.stringify({ ms: Date.now() - t, open: openBashCalls(sid).length }));`,
      { CWD: cwd },
    );
    expect(r.open).toBe(0); // every call was finished, the skipped ones included
    expect(r.ms).toBeLessThan(10_000);
  }, 40_000);
});
