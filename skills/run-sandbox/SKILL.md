---
name: run-sandbox
description: Run a project's unit, integration and browser suites inside its isolated container sandbox (internal network, dummies for every outside host, a local copy of the database), then check the 100% coverage and UI gates and record the sandbox check in the test result.
when_to_use: Use in a test run when `.goodboy/sandbox/compose.yml` exists in the project, for every suite you run and for the e2e tests you write.
user-invocable: false
effort: medium
---

# run-sandbox

Run suites where nothing can leave the machine, and prove it in the record.

## Inputs
- The project with `.goodboy/sandbox/compose.yml` (made by `sandbox-init`; the backfill-tests
  skill sets it up with the user). `$GB` is the plugin root (follow-agent-rules).
- The targets or flows to test, and for UI work the inventory: `bun "$GB/lib/cli.ts"
  ui-inventory` (`--summary` for the counts). Each item has an id; one with `input: true`
  is a form or request that takes input.

## Steps
1. `bun "$GB/lib/cli.ts" sandbox-check` must print `inner_only`, `egress_blocked` and
   `hosts_to_dummies` all true. Anything else: stop and report its `problems`; never edit the
   compose file, the network or the check to get past it. If the containers are down, ask the
   main session to run `sandbox-up`.
2. Write the tests. Expected values are today's outputs (characterization), taken from a run
   in the sandbox. Find data through the app's own screens and ids at run time (a list page,
   a search, an id from the inventory): a test never hard-codes a row of the database copy.
3. e2e tests live in `e2e/` and use the fixture, not the bare Playwright `test`:
   `import { uiTest } from '../.goodboy/sandbox/e2e/goodboy-ui';` then
   `uiTest(['<id>:ok'], 'title', async ({ page }) => { … })`. Use the inventory's ids:
   `<id>:ok` for the normal path of each screen and action, and for an item with `input: true`
   also `<id>:error` (a rejected or invalid submit). One test may claim several ids it really
   visits; a claim the test does not exercise covers nothing.
4. Run every suite through `bun "$GB/lib/cli.ts" sandbox-run --suite unit|e2e|all` (a command
   after `--` for one test file). Never run the project's own runner on the host for these
   tests. The run checks the sandbox first, resets the database from the dump, and writes
   `.goodboy/sandbox/out/<ts>/result.json` with `check`, `exit`, `accessLog`,
   `playwrightReport` and `coverageReports`. A red suite is fixed in the tests (or reported as
   suspect), never skipped.
5. After an `all` run: `bun "$GB/lib/cli.ts" coverage-check <the run's coverageReports>
   --root-map /work=.` and `bun "$GB/lib/cli.ts" ui-check --run <ts>`. Report the gaps (files,
   lines, branches, ids and what each lacks) to the main session, and write the tests that
   close the ones that can be reached.
6. Record (record-tests): suites typed by what they run, and `sandbox: {inner_only,
   egress_blocked, hosts_to_dummies, run: "<ts>"}` copied from that run's `check`. A record
   without it does not count for a backfill target.
7. Traces and screenshots: `sandbox-run` removes a passing run's (`artifacts: removed`) and
   keeps a failing run's for analysis. If a passing run still shows `kept`, delete them. They
   stay local in `.goodboy/sandbox/out/` and are never added to git.

## Output
- Per run: the result path, the exit code, and the two gate results with their gaps.
- The tests written and the record path, with the sandbox object in it.

## Done when
- [ ] `sandbox-check` was ok before the first suite and every suite ran through `sandbox-run`.
- [ ] The record carries `sandbox` from the run's check, with the run's `ts`.
- [ ] Each gap the gates report is closed or listed for the main session.

## Never
- Never point a test, a config or a command at a real host: not a database, an API, a mail
  or directory server, nor a package registry during a run (preparation is not yours).
- Never put rows or personal data from the database copy into tests, fixtures, records,
  comments or reports; refer to data by screen, route or id only.
- Never keep the traces of a passing run, or move anything out of `.goodboy/sandbox/`.
- Never weaken a test, skip it or add a coverage exemption to pass a gate: an exemption is
  the user's decision.
