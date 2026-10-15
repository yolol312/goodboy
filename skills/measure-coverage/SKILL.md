---
name: measure-coverage
description: Measure line, branch and changed-line coverage with the project's own coverage tool and record it in the test result; a missing tool is recorded as unavailable.
when_to_use: Use in a unit or spec test run after the suites pass, when the project's runner can report coverage.
user-invocable: false
effort: low
---

# measure-coverage

Record how much of the change the tests executed. It is measured, never a gate.

## Inputs
- The project's test runner and the files in scope; `$GB`, the plugin root.

## Steps
1. Find the tool the project already has; install nothing:
   - bun: `bun test --coverage --coverage-reporter=lcov` (writes `coverage/lcov.info`)
   - vitest or jest: `--coverage` with the lcov reporter
   - pytest: `pytest --cov --cov-report=xml` (Cobertura `coverage.xml`)
   - JaCoCo: the build's `jacocoTestReport` (XML)
   - Go: `go test -coverprofile=cover.out ./...`
2. With no tool, record `coverage: {status: "unavailable", reason: "<what is missing>"}` and
   stop here.
3. Run it once and take line and branch percentages from its summary.
4. Changed lines: `bun "$GB/lib/cli.ts" diff-coverage <report> [--base <rev>]`. It prints
   `{covered, total, files_without_executed_changes, files}`.
5. A code file listed in `files_without_executed_changes` that you put in `tested_files`
   means the tests never ran its changed lines; add a test, or say why in the summary.

## Output
For record-tests:

```
"coverage": {"status": "measured", "tool": "bun test --coverage", "line_pct": 81.2,
  "branch_pct": 70.5, "changed": {"covered": 40, "total": 52,
  "files_without_executed_changes": []}}
```

## Done when
- [ ] `coverage` is in the result as `measured` with `changed`, or `unavailable` with a reason.

## Never
- Never install a coverage tool or change the project's test config to get one.
- Never invent percentages; copy them from the tool's output.
