// lib/bash-write.ts — the fd number before a redirection (stabilization plan A3, round 2)
// and file arguments after one (round 3). Complements the "fd number" case of
// tests/bash-write.test.ts.
//
// In bash, an unquoted all-digit word right before `>`/`<` is the operator's fd
// (`2>/dev/null`, `3>&-`, `0</dev/null`). Any other word there stays a word: `v2>out`
// passes the file v2, and a quoted `"2">out` passes the file 2.

import { describe, expect, test } from 'bun:test';
import { classifyBashWrite, OP_TOKEN, tokenizeSegments } from '../lib/bash-write';

const CWD = '/proj';
const denied = (cmd: string): string[] => classifyBashWrite(cmd, CWD);

describe('the fd number of a redirection', () => {
  test('is dropped for any fd, either direction, and appends', () => {
    expect(denied("sed -i '' -e 's/a/b/' /tmp/x.sh 3>/dev/null")).toEqual([]);
    expect(denied("sed -i '' -e 's/a/b/' /tmp/x.sh 10>/dev/null")).toEqual([]);
    expect(denied("sed -i '' -e 's/a/b/' /tmp/x.sh 2>>/tmp/log.txt")).toEqual([]);
    expect(denied("sed -i '' -e 's/a/b/' /tmp/x.sh 0</dev/null")).toEqual([]);
    expect(denied('echo x | tee src/a.ts 2>/dev/null')).toEqual(['/proj/src/a.ts']); // not also ./2
  });

  test('a word that only ends in digits is still a file argument', () => {
    expect(denied("sed -i 's/a/b/' src/v2>/dev/null")).toEqual(['/proj/src/v2']);
    expect(denied('echo x | tee notes2>/dev/null')).toEqual(['/proj/notes2']);
  });

  test('a double-quoted fd number is a word too', () => {
    expect(denied(`sed -i 's/a/b/' "2">/dev/null`)).toEqual(['/proj/2']);
  });
});

// Round 3 (security review): the shell takes a redirection anywhere in a command. The
//   tee/sed/dd scans stopped at the first operator, so with the fd number dropped a file
//   after a redirection was not collected and the write was allowed.
describe('file arguments after a redirection (round 3)', () => {
  test('are collected for sed -i, tee and dd', () => {
    expect(denied("sed -i '' -e 's/a/b/' 2>/dev/null src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(denied("sed -i 's/a/b/' >/dev/null src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x | tee 2>/dev/null src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('dd if=/tmp/x 2>/dev/null of=src/a.ts')).toEqual(['/proj/src/a.ts']);
  });

  test('`2>&1`, `>&2` and `&>` are one operator, not a command separator', () => {
    expect(denied("sed -i 's/a/b/' 2>&1 src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x | tee >&2 src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied("sed -i 's/a/b/' &>/dev/null src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(tokenizeSegments("sed -i 's/a/b/' 2>&1 src/a.ts")).toEqual([['sed', '-i', 's/a/b/', OP_TOKEN, '1', 'src/a.ts']]);
  });

  test('a word after `>&` that is not a number or `-` is a file (stdout and stderr)', () => {
    expect(denied('echo x >& src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x >&src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('make >& /tmp/build.txt')).toEqual([]);
    for (const cmd of ['cmd >&2', 'cmd 2>&1', 'cmd >&-', 'cmd 3>&-', 'cmd 2>&10']) expect(denied(cmd)).toEqual([]);
  });

  test('`>|` writes like `>`', () => {
    expect(denied('echo x >| src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x >| /tmp/a.ts')).toEqual([]);
  });

  // Layer-1 round 4: the case above is redirectTargets alone. Read as a pipe, the `|` of `>|`
  //   cut the command in two and lost the file after it; no other test noticed.
  test('`>|` is one operator: a file argument after it is collected for sed -i, tee and dd', () => {
    expect(denied("sed -i 's/a/b/' >| /dev/null src/a.ts")).toEqual(['/proj/src/a.ts']);
    expect(denied('echo x | tee >| /dev/null src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(denied('dd if=/tmp/x >|/dev/null of=src/a.ts')).toEqual(['/proj/src/a.ts']);
    expect(tokenizeSegments("sed -i 's/a/b/' >| /dev/null src/a.ts")).toEqual([
      ['sed', '-i', 's/a/b/', OP_TOKEN, '/dev/null', 'src/a.ts'],
    ]);
  });

  test('the operator target itself is still not a file argument', () => {
    expect(denied('tee /tmp/out.txt > /dev/null')).toEqual([]);
    expect(denied('bun test 2>&1 | tail -5')).toEqual([]);
    expect(denied('cmd 2>&1 | tee /tmp/x.log')).toEqual([]);
    expect(denied("sed -n '1,5p' src/a.ts 2>/dev/null")).toEqual([]); // no -i: a read
    expect(denied('sleep 1 & echo x > src/b.ts')).toEqual(['/proj/src/b.ts']); // a lone & still separates
  });
});
