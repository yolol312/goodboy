---
name: check-spec-coverage
description: Map each requirement and acceptance criterion to the code that implements it and the test that proves it, and report the gaps.
when_to_use: Use in a spec review or a spec test run, when the project has dev-cycle documents or the caller gives requirements.
user-invocable: false
effort: high
---

# check-spec-coverage

Show, criterion by criterion, where the change meets its spec and where it does not.

## Inputs
- `bun "$GB/lib/cli.ts" acceptance-list` (criteria from the dev-cycle documents); the
  requirements the caller passes; the changed files and test files.

## Steps
1. Get the criteria. With `dev_cycle: null` and no requirements from the caller, use the
   task's stated goals and number them `AC-1`, `AC-2` ….
2. For each criterion, find the implementing code (`file:line`) by reading the changed files
   and Grep; write "not found" when nothing implements it.
3. For each criterion, find the test that exercises it and the assertion that would fail if it
   broke; write "no test" when none does.
4. Check the reverse: changed behavior no criterion asks for (scope creep, or a missing
   criterion to raise with the user).
5. Reviewing: a criterion with no code is `high`; with code but no test, `medium`; behavior no
   criterion covers, `low` with a note. Testing: write the missing tests (write-regression-test
   or run-e2e) before recording.

## Output
A coverage table in the result (review findings or test `acceptance` entries), shaped like:

```
| id | code | test | status |
| UIUX-STATE-1 | src/List.tsx:40 | e2e/list.spec.ts > empty | covered |
```

## Done when
- [ ] Every criterion from acceptance-list has a row; ids match exactly.

## Never
- Never mark a criterion covered without the test that would fail when it breaks.
