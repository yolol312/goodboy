---
name: summarize-diff
description: Build a compact map of a diff — files, purpose, risky spots and which tests cover them — before reviewing or researching it.
when_to_use: Use at the start of a review or code research run, when the change spans more than one file.
user-invocable: false
effort: medium
---

# summarize-diff

Turn a diff into a short map that tells you where to look first.

## Inputs
- The files in scope from the caller, or the working tree against `HEAD`.

## Steps
1. List the change: `git diff --stat HEAD`, `git status --porcelain`, and the untracked files.
2. For each file, read the diff hunks (`git diff HEAD -- <file>`) and, for new files, the
   file itself.
3. Write one line per file: what changed and why it seems to have changed.
4. Mark risky spots, each with `file:line`: input parsing, auth checks, file and network
   writes, concurrency, migrations, deleted error handling, changed public interfaces.
5. Find the tests that touch each risky spot (`grep -rn <symbol> tests/`); write "no test"
   when none does.
6. Note what the diff does not show and you still need (config, callers, schema).

## Output
A block in your working notes (not a file), in this shape:

```
files: <n> changed, <n> new
- <path>: <what changed>
risky:
- <path>:<line> <why> — tests: <test file or "no test">
gaps: <what to read next>
```

## Done when
- [ ] Every changed file has a line, and every risky spot names its tests or "no test".

## Never
- Never judge the change here; findings belong to the review checks.
- Never paste whole diffs into the map.
