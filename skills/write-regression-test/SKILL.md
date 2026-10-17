---
name: write-regression-test
description: Write a test that fails before the fix and passes after it, prove it with red-green exit codes and a mutation run in a scratch copy, and keep it in the repo.
when_to_use: Use for every behavior change or bug fix that a layer-1 run covers.
user-invocable: false
effort: high
---

# write-regression-test

Leave a test in the repo that really guards the change.

## Inputs
- The changed behavior or the bug (its reproduction), the changed files, the project's test
  layout and runner, the base the change starts from (default `HEAD` while it is uncommitted).

## Steps
1. Find the project's test location and naming (`tests/`, `__tests__/`, `*.test.ts`,
   `*.spec.ts`) and follow it.
2. Write the test: the changed behavior plus its failure modes (boundaries, malformed input,
   error paths). An integration test talks to the real process you started, not a mock.
3. red, in a scratch copy of the code before the change (you may write only test files in the
   project, so never revert or edit the code there):
   `SB="$(mktemp -d)"; git archive <base> | tar -x -C "$SB"`, copy your test files to the same
   paths in `$SB`, link dependencies (`ln -s "$PWD/node_modules" "$SB/node_modules"`), and run
   the test there. It must fail with a non-zero exit code.
4. green: run the same test in the project; it passes with exit code 0.
5. Mutation, in a scratch copy of the current tree:
   `MB="$(mktemp -d)"; tar --exclude=.git --exclude=node_modules -cf - . | tar -x -C "$MB"`,
   link dependencies, break the thing the test guards in the copy, always by its absolute
   path (`sed -i.bak 's/…/…/' "$MB/src/x.ts"`: a relative path is read as a project file and
   denied), and run the test there. It must fail (`detected: true`); if it passes, the test
   guards nothing: fix the test and repeat.
6. Run the whole suite once in the project, so the new test does not break the others.

## Output
- The test file in the repo, and for record-tests: `red`, `green` and `mutation` with each
  command, output and exit code; `mutation.file` is the repo-relative path of the file you
  broke (not its scratch copy's path), product code for a `PT-*`, `UIUX-*` or `REQ-*`
  criterion.

## Done when
- [ ] red exit code is not 0, green is 0, and the mutation was detected.
- [ ] `git status` shows no change outside your test files.

## Never
- Never use `waitForTimeout`, empty catches, always-true assertions, `.skip` or `.todo`.
- Never edit, stash or revert the code under test in the project; report a failure instead.
