// M6g (track M, #19): the privacy files module shares what it knows of the sandbox helper with lib/sandbox-gate.ts instead of
// keeping a copy, and its surface carries no dead export or shadowed name.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as files from '../lib/privacy-files';
import * as gateModule from '../lib/sandbox-privacy-gate';
import { privacyGate } from '../lib/sandbox-privacy-gate';
import * as shared from '../lib/sandbox-gate';

const ROOT = resolve(import.meta.dir, '..');
const source = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('one definition of the helper facts', () => {
  test('lib/sandbox-gate.ts exports what lib/privacy-files.ts needs, and privacy-files defines none of it again', () => {
    for (const name of ['bareModule', 'noExt', 'toPosix', 'JS_EXT', 'CODE_EXT', 'DATA_HELPER', 'HELPER_COPY', 'MAX_USER_BYTES', 'isTestOrE2e']) expect([name, name in shared]).toEqual([name, true]);
    const own = source('lib/privacy-files.ts');
    expect(own).toMatch(/from '\.\/sandbox-gate'/);
    for (const dup of ['toPosix', 'noExt', 'bareModule', 'JS_EXT', 'HELPER_COPY', 'IMPORTABLE']) expect([dup, new RegExp(`(?:const|function)\\s+${dup}\\b`).test(own)]).toEqual([dup, false]);
    // no private test-or-e2e rule, and the byte cap is the shared number
    expect(own).not.toMatch(/\(\?:\^\|\\\/\)e2e\\\//);
    expect(files.PRIVACY_FILE_BYTES).toBe(shared.MAX_USER_BYTES);
  });

  test('the sandbox-gate rule of who may import the helper uses the same test-or-e2e rule', () => {
    expect(shared.isTestOrE2e('tests/a.test.ts')).toBe(true);
    expect(shared.isTestOrE2e('app/e2e/flow.ts')).toBe(true);
    expect(shared.isTestOrE2e('src/a.ts')).toBe(false);
    expect(shared.bareModule('data/goodboy-data.ts')).toBe(shared.DATA_HELPER);
    expect(shared.bareModule('data/goodboy-data/index.js')).toBe(shared.DATA_HELPER);
    expect(shared.toPosix('a\\b')).toBe('a/b');
  });
});

describe('the surface', () => {
  test('the privacy file byte cap is named for what it is, not as the other MAX_FILE_BYTES of the repo', () => {
    expect('MAX_FILE_BYTES' in files).toBe(false);
    expect('PRIVACY_FILE_BYTES' in files).toBe(true);
  });

  test('the codes list of the run gate is private: a test reads the codes from the gate’s answers', () => {
    expect('PRIVACY_CODES' in gateModule).toBe(false);
  });

  test('a refusal says that a review file the Stop has deleted as old asks for a new review', () => {
    const g = privacyGate('/nonexistent-m6g', { GOODBOY_SANDBOX_PRIVACY_GATE: 'on' }, { setup: () => ({ ok: true, files: ['a.ts'] }), reviews: () => [] });
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('a review file the Stop has deleted as old');
  });
});
