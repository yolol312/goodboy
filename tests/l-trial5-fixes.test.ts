// Findings of the track L real-use trial (trial 5, plan §18): a read-only git command in an
// unknown repo was denied by the commit issue rule, and chmod's mode was read as a path.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitIssueDenial } from '../lib/commit-issue';
import { bashChangedPaths } from '../lib/role-limits';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-t5-')));
  dirs.push(dir);
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'ABC-1 init');
  return dir;
}

const sid = () => `t5-${Math.random().toString(36).slice(2)}`;

describe('T5-1: an unknown repo matters only to a command that may commit', () => {
  test('read-only built-ins pass, a commit or an alias is still denied', () => {
    const r = repo();
    expect(commitIssueDenial('git -C "$P" status --short', r, sid())).toBeNull();
    expect(commitIssueDenial('git -C $P log --oneline -3', r, sid())).toBeNull();
    expect(commitIssueDenial('git --git-dir=$G/.git diff', r, sid())).toBeNull();
    expect(commitIssueDenial('git -C "$P" commit -m fix', r, sid())).toContain('cannot tell which repo');
    expect(commitIssueDenial('git --git-dir=$G/.git commit -m fix', r, sid())).toContain('cannot tell which repo');
    expect(commitIssueDenial('git -C "$P" ci -m fix', r, sid())).toContain('cannot tell which repo');
    expect(commitIssueDenial('git -C "$P" $S -m fix', r, sid())).toContain('cannot tell which repo');
    expect(commitIssueDenial('git -C "$P" "$S"', r, sid())).toContain('cannot tell which repo');
    expect(commitIssueDenial('git -C "$P" -c alias.x=commit x -m fix', r, sid())).toContain('cannot tell which repo');
    expect(commitIssueDenial('git -C "$P" status && git commit -m fix', r, sid())).toContain('no issue number');
  });

  test('a later literal -C does not make an earlier unknown one known; the first unknown is named', () => {
    const r = repo();
    expect(commitIssueDenial('git -C "$P" -C /tmp commit -m fix', r, sid())).toContain('git -C $P');
    expect(commitIssueDenial('git -C "$A" -C "$B" commit -m fix', r, sid())).toContain('git -C $A');
    expect(commitIssueDenial('git -C "$P" -C /tmp status', r, sid())).toBeNull();
    expect(commitIssueDenial('git --work-tree=$W commit -m fix', r, sid())).toContain('cannot tell which repo');
    expect(commitIssueDenial('git --work-tree=$W status', r, sid())).toBeNull();
  });
});

describe('T5-3: chmod modes are no paths', () => {
  test('`chmod +x` outside the project changes nothing inside it; the file is still read', () => {
    expect(bashChangedPaths('chmod +x /tmp/gbwork/bf.sh', '/repo')).toEqual(['/tmp/gbwork/bf.sh']);
    expect(bashChangedPaths('chmod 755 /tmp/a.sh', '/repo')).toEqual(['/tmp/a.sh']);
    expect(bashChangedPaths('chmod u+x,go-w src/a.sh', '/repo')).toEqual(['/repo/src/a.sh']);
    expect(bashChangedPaths('chmod -R a+r src', '/repo')).toEqual(['/repo/src']);
    expect(bashChangedPaths('chmod 755 src/a.ts', '/repo')).toEqual(['/repo/src/a.ts']);
    expect(bashChangedPaths('chmod -x src/a.ts', '/repo')).toEqual(['/repo/src/a.ts']);
  });
});
