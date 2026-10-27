// A coverage report the test run wrote is no code to test (v0.36.6, plan §15.22).
//
// `bun test --coverage --coverage-reporter=lcov` writes `coverage/lcov.info` (through a temp file,
// `coverage/.lcov.info.<id>.tmp`, that it renames), and the write sweep records the report as an
// edit of the session. Layer 1 then asked for a test of an lcov file. The exemption is narrow, since
// a path under `coverage/` is not evidence of what the file holds: only the two names above, at the
// repo top, and only a file that is plainly the tool's output:
//   - untracked now (not in the index, so not staged either) and absent from the session-start
//     HEAD (a report the repo already had is a file someone keeps); an unknown start is no;
//   - an existing regular file with one link and no link on its path, not executable, no shebang;
//   - a complete, well-formed LCOV report: bounded in size and lines, every line a known tag of the
//     format, every record opened by `SF:` and closed by `end_of_record`, nothing after the last
//     one. A truncated or hand-made text is not one, so an incomplete temp report stays required.
// Any read or git failure is a no: the file keeps its obligation. This is layer-1 scope only
// (hooks/stop.ts needsTestCoverage); the review keeps the file in its edit set, and
// `classifyPath` (lib/verification-scope.ts) still calls every path under `coverage/` code.

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainSize } from './build-copies';
import { hookGit, relInside } from './changed-coverage';
import { snapshotMemo } from './git-run';

/** The largest report read, and the most lines and the longest line it may have. */
export const MAX_LCOV_BYTES = 8 * 1024 * 1024;
export const MAX_LCOV_LINES = 400_000;
const MAX_LCOV_LINE = 4096;

const REPORT_NAME = /^coverage\/(?:lcov\.info|\.lcov\.info\.[^/]+\.tmp)$/;

const COUNT = /^\d+$/;

// The text of a report is free text in the format (a test name, a path, a function name), and a
// file that is complete LCOV could also be a script: `TN:` and `FNDA:` read as labels in
// JavaScript, `FNDA:1,require('x').y()` is a call, a line of shell can hold `;` or `$(...)`. So
// the values are limited to what the tools write, and nothing that makes code is accepted: no
// quote, backtick, brace, `=` (except as the base64 padding of a `DA` checksum), `;`, `&`, `|`, `\`,
// `!`, `?`, `*`; a parenthesis only as a whole path
// segment (`(group)`, which is never a call) or as `(anonymous_N)`; `<`/`>` only as a whole name
// (`<instance_members_initializer>`). A report outside this is not exempt (it stays test-required,
// the safe side); a tool that writes a name outside it only loses the exemption.
const WORD = '\\p{L}\\p{N}_';
/** A test name: usually empty. */
const TEST_NAME = new RegExp(`^[${WORD}. -]*$`, 'u');
/** A source path as bun, c8 and nyc write it: segments of letters, digits, `_ . @ + ~ % # $ -`,
 *  spaces and `[id]` brackets; a parenthesis only around a whole segment (`PATH_GROUP`). */
const PATH_CHARS = new RegExp(`^[${WORD}.@+~%#$ \\[\\]/-]+$`, 'u');
const PATH_GROUP = new RegExp(`(?<=^|/)\\([${WORD}.-]+\\)(?=/|$)`, 'gu');
/** A function name: words and `. # $ [ ]` and spaces (`Foo.bar`, `get x`, `[Symbol.iterator]`,
 *  `#priv`), `(anonymous_N)` (istanbul), or `<name>` (v8: `<instance_members_initializer>`). */
const FN_NAME = `(?:\\(anonymous_\\d+\\)|<[A-Za-z_]+>|[${WORD}.#$ \\[\\]]+)`;
/** The line checksum of `DA`: base64, padded at the end only. */
const CHECKSUM = '[A-Za-z0-9+/]{0,88}={0,2}';

const isSourcePath = (value: string): boolean => PATH_CHARS.test(value.replace(PATH_GROUP, '_'));

/** Every line of an LCOV report, by tag: the shape of the text after `<tag>:`. */
const TAGS: Record<string, RegExp> = {
  TN: TEST_NAME,
  VER: /^\d+$/,
  FN: new RegExp(`^\\d+(?:,\\d+)?,${FN_NAME}$`, 'u'),
  FNL: /^\d+,\d+(?:,\d+)?$/,
  FNA: new RegExp(`^\\d+,\\d+,${FN_NAME}$`, 'u'),
  FNDA: new RegExp(`^\\d+,${FN_NAME}$`, 'u'),
  FNF: COUNT,
  FNH: COUNT,
  DA: new RegExp(`^\\d+,-?\\d+(?:,${CHECKSUM})?$`),
  LF: COUNT,
  LH: COUNT,
  BRDA: /^\d+,\d+,\d+,(?:\d+|-)$/,
  BRF: COUNT,
  BRH: COUNT,
};

/** Whether `text` is a complete LCOV report: at least one record, each opened by `SF:` and closed
 *  by `end_of_record`, every line a known tag with the shape of its value, nothing after the last
 *  record but its line end. */
export function isCompleteLcov(text: string): boolean {
  if (text === '' || !text.endsWith('\n') || text.startsWith('#!') || text.includes('\0') || text.includes('\r')) return false;
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > MAX_LCOV_LINES) return false;
  let open = false;
  let records = 0;
  for (const line of lines) {
    if (line.length > MAX_LCOV_LINE) return false;
    if (line === 'end_of_record') {
      if (!open) return false;
      open = false;
      records++;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 1) return false;
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (tag === 'SF') {
      if (open || !isSourcePath(value)) return false; // one source file per record, a plain path
      open = true;
      continue;
    }
    const shape = Object.hasOwn(TAGS, tag) ? TAGS[tag] : undefined;
    if (shape === undefined || !shape.test(value)) return false;
    // TN opens a record before its SF; every other tag belongs inside one.
    if (tag !== 'TN' && tag !== 'VER' && !open) return false;
  }
  return !open && records > 0;
}

/** Whether `file` is a coverage report the test run wrote, which layer 1 needs no test for (see
 *  the header). `start` reads the session's start HEAD, and is asked only when the name fits (a
 *  commit id; null: it had no commit; undefined: unknown, which is no). */
export function isGeneratedLcov(file: string, top: string, start: () => string | null | undefined): boolean {
  const rel = relInside(top, file);
  if (rel === null || !REPORT_NAME.test(rel)) return false;
  // Asked again for each pass over the edit set: the two `ls-files` calls and the parse run once
  //   per Stop (the report does not change while the hook runs).
  return snapshotMemo(`lcov\0${top}\0${rel}`, () => readsAsGeneratedLcov(top, rel, start));
}

function readsAsGeneratedLcov(top: string, rel: string, start: () => string | null | undefined): boolean {
  try {
    const startHead = start(); // read only for a report's name: it costs a pin read
    if (startHead === undefined) return false;
    const size = plainSize(top, rel); // a regular file with one link, no link on its path
    if (size === null || size === 0 || size > MAX_LCOV_BYTES) return false;
    const abs = join(top, rel);
    if ((lstatSync(abs).mode & 0o111) !== 0) return false; // executable
    // Untracked now: the index holds no entry (a staged report has one).
    const index = hookGit(top, ['--literal-pathspecs', 'ls-files', '-z', '--', rel]);
    if (index.code !== 0 || index.out !== '') return false;
    // Absent from the session-start HEAD.
    if (startHead !== null) {
      const at = hookGit(top, ['ls-tree', '-z', '--end-of-options', startHead, '--', rel]);
      if (at.code !== 0 || at.out !== '') return false;
    }
    const bytes = readFileSync(abs);
    if (bytes.length !== size) return false; // it changed while read
    return isCompleteLcov(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}
