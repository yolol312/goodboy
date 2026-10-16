---
name: measure-coverage
description: Measure line, branch and changed-line coverage with the project's own coverage tool and record it in the test result; every changed code line must have run (the test gate checks it), and a missing tool is recorded as unavailable.
when_to_use: Use in a unit or spec test run after the suites pass, when the project's runner can report coverage.
user-invocable: false
effort: low
---

# measure-coverage

Record how much of the change the tests executed. The changed lines are a gate (track I):
every changed code line runs in a test, or the user exempted its file.

## Inputs
- The project's test runner and the files in scope; `$GB`, the plugin root.

## Steps
1. Find the tool the project already has; install nothing:
   - bun: `bun test --coverage --coverage-reporter=lcov` (writes `coverage/lcov.info`)
   - vitest or jest: `--coverage` with the lcov reporter
   - pytest: `pytest --cov --cov-report=xml` (Cobertura `coverage.xml`)
   - JaCoCo: the build's `jacocoTestReport` (XML)
   - Go: `go test -coverprofile=cover.out ./...`
2. With no tool, record `coverage: {status: "unavailable", reason: "<what is missing>"}`, and
   the result as `blocked` with the evidence (the gate needs changed lines; a tool is the
   user's decision). Stop here.
3. Run it once over the tests of the change and take line and branch percentages from its
   summary.
4. Changed lines: `bun "$GB/lib/cli.ts" diff-coverage <report> [--base <rev>|empty]` (the
   base: the commit the session started from, when the task committed already; `empty` when
   the repo had no commit then; else HEAD. The gate rejects a later base and prints the right
   one). It prints `{covered, total, files_without_executed_changes, files, in_report,
   diff_lines, base}`; copy it whole into a passing result made after the last edit.
5. Every changed code file must be in `in_report`, with `covered` equal to `total` in `files`.
   A gap means a changed line no test ran: write the test (write-regression-test) and measure
   again. A file the report lacks ran in no test (a types-only JS/TS file and a non-code file
   do not count); code started only in a child process is not measured, so test it
   in-process, or name it for the user (an exemption is theirs: never write one). An edited
   file must be in the diff: never hide one from git.

## Output
For record-tests:

```
"coverage": {"status": "measured", "tool": "bun test --coverage", "line_pct": 81.2,
  "branch_pct": 70.5, "changed": {"covered": 52, "total": 52,
  "files_without_executed_changes": [], "files": {"src/a.ts": {"covered": 52, "total": 52}},
  "in_report": ["src/a.ts"], "diff_lines": {"src/a.ts": 52}, "base": "<commit id>"}}
```

## Done when
- [ ] `coverage` is `measured` with the whole `changed`, and no changed code line is left
      unrun; or `unavailable` with a reason and the result `blocked`.

## Never
- Never install a coverage tool or change the project's test config to get one.
- Never invent percentages; copy them from the tool's output.
