// Fixes from a Codex review of the unreleased range (before the v0.35.0 release): the push
// gate with `--repo`, changed lines under a textconv diff driver, and the knowledge files read
// without blocking.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedLines } from '../lib/diff-coverage';
import { readDocMap } from '../lib/project-knowledge';
import { handoffsOf } from '../lib/push-test';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function dir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-codex-')));
  tmpDirs.push(d);
  return d;
}

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' });

describe('Codex review fixes', () => {
  test('a push with --repo leaves the refs to git config (its remote\'s refspecs are not the default\'s)', () => {
    const rules = { allow: [], production: [] };
    for (const cmd of ['git push --repo secondary', 'git push --repo=secondary', 'git push --repo secondary main']) {
      const h = handoffsOf(cmd, '/x', rules);
      expect([cmd, h.length, h[0]?.unclear]).toEqual([cmd, 1, 'git config decides which refs it pushes']);
    }
  });

  test('changed lines are source lines, whatever a textconv diff driver does', () => {
    const d = dir();
    git(d, 'init', '-q');
    writeFileSync(join(d, 'a.ts'), 'one\ntwo\nthree\n');
    git(d, 'add', '.');
    git(d, '-c', 'user.email=p@x', '-c', 'user.name=p', 'commit', '-qm', 'init');
    // A driver that doubles every line: its hunk numbers would be twice the source's.
    writeFileSync(join(d, '.gitattributes'), '*.ts diff=twice\n');
    git(d, 'config', 'diff.twice.textconv', "sed p");
    writeFileSync(join(d, 'a.ts'), 'one\nTWO\nthree\n');
    const r = changedLines(d);
    if (r === null || 'error' in r) throw new Error(`no changed lines: ${JSON.stringify(r)}`);
    expect([...(r.files.get('a.ts') ?? [])]).toEqual([2]);
  });

  test('a doc map or policy file that is a FIFO is named, never waited on', () => {
    const d = dir();
    mkdirSync(join(d, '.goodboy'));
    Bun.spawnSync(['mkfifo', join(d, '.goodboy', 'docs.json')]);
    const t0 = Date.now();
    const m = readDocMap(d);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(m.docs).toEqual([]);
    expect(m.problem).toContain('is not a regular file');
  });
});
