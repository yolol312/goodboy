---
name: record-tests
description: Write a layer-1 test result JSON through `cli.ts test-write`, with suites typed and timed, acceptance coverage with red-green evidence, and `blocked` only with evidence.
when_to_use: Use at the end of every test run, after the suites ran.
user-invocable: false
effort: low
---

# record-tests

Record one layer-1 test result the Stop gate and the push check can read.

## Inputs
- The suites you ran with their output, the acceptance criteria and their evidence, the
  environment you started, the files in scope.
- `$GB`: the plugin root (follow-agent-rules).

## Steps
1. `tested_files`: every changed code file in scope, absolute paths.
2. `test_files`: the test files you wrote or ran, absolute paths; they must exist in the repo.
3. `environment`: `{mode: container | local | none, command?, services?, evidence?}`. Give the
   mode you really used, with the health-check output as evidence.
4. `suites`: one entry per run, `{name, command, passed, failed, output, type,
   duration_ms}`. `type` is `unit`, `integration`, `ui` or `e2e`, by what the suite really
   runs (the gate counts types per file: boundary code needs `integration` or `e2e`, UI code
   `ui` or `e2e`); `duration_ms` is the run's
   wall time (from the runner's report, or `date +%s%N`-style timing around the command).
5. `acceptance`: one entry per criterion from `bun "$GB/lib/cli.ts" acceptance-list` and
   per criterion a Stop block message listed (acceptance-list shows the documents now; the
   block message lists the uncovered criteria of the whole session, up to 20, with the rows
   implemented since its start and `POL-*` entries; ids must match). With none listed, number your own `AC-1`, `AC-2` …. Each entry is
   `{id, description, test, red, green, mutation?}`: `description` says what it checks,
   `test` names the test file or test; `red` and `green` are `{command, output, exit_code}`
   with red's exit code not 0 (the old code) and green's 0. `PT-*` and `UIUX-*` also need
   `mutation: {command, output, detected: true, file}` (write-regression-test), `file` being
   the repo-relative path of the product file the probe broke (in its scratch copy: the path
   the file has in this repo). For a product criterion (`PT-*`, `UIUX-*`, `REQ-*`) the
   test and the broken file are product code, never a document (the requirements, the
   prototype, anything under `docs/`): a check of the document proves the document.
6. `prototype_diff`, when a dev-cycle prototype exists: `{prototype_path, mismatches:
   [{selector?, issue, severity}]}`. `coverage`: the measure-coverage record when measured.
7. `verdict`: `pass` (all suites pass, all criteria covered, no high prototype mismatch),
   `needs-changes`, `fail` (cannot be fixed automatically), or `blocked` (the tests cannot
   run here at all) with `blocked: {reason (15+ chars), evidence: [{command, output}]}`.
8. Write it: `cat <<'JSON' | bun "$GB/lib/cli.ts" test-write` … `JSON`. On exit 1, fix and
   retry.

## Output
- `{"ok":true,"path":".claude/tests/<ts>.json",…}`; the file gains `by_type` (suites, tests
  and time per type), `commit` and `tree` (the tested content, set by the CLI). The CLI also
  updates the project's test profile (`.claude/.goodboy-test-profile.json`, for tier advice).

## Done when
- [ ] test-write printed `ok: true`, and every suite has `type` and `duration_ms`.
- [ ] No test file contains `waitForTimeout(`, an empty `.catch(() => {})`,
      `toBeGreaterThanOrEqual(0)`, `expect(true).toBe(true)`, `.skip` or `.todo`.

## Never
- Never set `timestamp`, `commit` or `tree`, or write the file yourself.
- Never use `blocked` for tests that run and fail (that is `needs-changes`).
- Never list a criterion you did not run.
