// v0.36.14 (#39 follow-up, plan §15.30): the one catch of the new library code that no input reaches. Every call
// under `isNoRepoProject` (`topIdentity`, `realDeep`, `fsDirs`, `spawnGit`) catches its own failures and returns a
// value (probed: an empty, NUL-holding, 6 000-character, missing or lone-surrogate path never reaches the catch),
// so the guard only runs when a call that never throws throws. This file makes that call throw, in this process
// only: `mock.module` patches `topIdentity`, and the original is put back after every test and after the file
// (the unit tests share one process).
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as startPins from '../lib/start-pins';
import { isNoRepoProject, resetStopGroups } from '../lib/stop-groups';

const original = { ...startPins };
const restore = (): void => {
  mock.module('../lib/start-pins', () => original);
  resetStopGroups();
};
const dirs: string[] = [];
afterEach(() => {
  restore();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
afterAll(restore);

describe('isNoRepoProject when the identity check itself fails', () => {
  test('a failure while asking is not a project dir that is no repo: the Stop keeps the one group it always had', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-i3914f-')));
    dirs.push(dir);
    resetStopGroups();
    expect(isNoRepoProject(dir)).toBe(true); // a plain dir, as the check really sees it
    resetStopGroups();
    mock.module('../lib/start-pins', () => ({
      ...original,
      topIdentity: (): never => {
        throw new Error('the identity check failed');
      },
    }));
    expect(isNoRepoProject(dir)).toBe(false);
    expect(isNoRepoProject(dir)).toBe(false); // the answer is kept for the Stop, like any other
    restore();
    expect(isNoRepoProject(dir)).toBe(true); // the real check is back
  });
});
