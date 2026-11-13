// Track M (plan §19): inGoodboySessionDir judges a path by where the OS leads it, in this process
// (the hook tests spawn the hook, so they do not count toward line coverage of lib/file-tracker.ts).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionDir, inGoodboySessionDir, sessionDir } from '../lib/file-tracker';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('inGoodboySessionDir', () => {
  test('a path is in the session dir when it spells it, links into it, or goes through a link and then `..`', () => {
    const sid = `m6-ft-${Math.random().toString(36).slice(2, 10)}`;
    const state = ensureSessionDir(sid);
    dirs.push(state);
    mkdirSync(join(state, 'sub'), { recursive: true });
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-m6ft-')));
    dirs.push(proj);
    symlinkSync(join(state, 'sub'), join(proj, 'lnk'));
    expect(inGoodboySessionDir(join(sessionDir(sid), 'edits.jsonl'))).toBe(true);
    expect(inGoodboySessionDir(join(proj, 'lnk', 'a'))).toBe(true);
    // `lnk/..` is the session dir (the link is followed first); collapsed by name it would be the project dir
    expect(inGoodboySessionDir(`${proj}/lnk/../x`)).toBe(true);
    expect(inGoodboySessionDir(join(proj, 'plain.txt'))).toBe(false);
  });
});
