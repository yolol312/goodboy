---
name: setup-test-infra
description: Add the test tools a project lacks (unit runner, coverage, integration tests with containers, e2e tests in a browser). The user approves every package, file and command first, and each tool is proved with one smoke test that runs.
when_to_use: Use from backfill-tests when the survey finds a missing tool, or when the user asks to set up unit, integration or e2e testing in a project.
user-invocable: false
effort: medium
---

# setup-test-infra

Make each kind of test runnable in the project, with the least change to it.

## Inputs
- The survey from `bun "$GB/lib/cli.ts" test-survey`: stacks, frameworks, tools per kind and
  gaps. `$GB` is the plugin root, two levels above this skill's base directory.
- The defaults by stack. Keep what the project already uses, and add only what is missing.

| Stack | Runner | Coverage | Integration | E2E |
|---|---|---|---|---|
| Node or TypeScript | vitest (jest when jest is set up) | `@vitest/coverage-v8`, `jest --coverage` | supertest for an HTTP server; testcontainers for a database | `@playwright/test` |
| Bun | `bun test` | `bun test --coverage` | testcontainers | `@playwright/test` |
| Spring Boot (Gradle, Maven) | JUnit 5 via `spring-boot-starter-test` | the JaCoCo plugin | MockMvc slices; Testcontainers for the database | Playwright for Java, or `@playwright/test` in `e2e/` |
| Java without Spring | JUnit 5 | JaCoCo | Testcontainers | Playwright |
| Python | pytest | pytest-cov | testcontainers-python | pytest-playwright |
| Go | `go test` | `go test -cover` | testcontainers-go | `@playwright/test` in `e2e/` |

## Steps
1. List per missing kind: the packages at the versions the package manager reports now
   (`npm view <pkg> version`; Gradle and Maven take a BOM's versions), the files to add or
   change (config, scripts, a build plugin block), the commands, and what each costs to run
   (Playwright downloads browsers; containers need Docker).
2. Ask once with AskUserQuestion (multiSelect), one option per kind with its list. Install
   only what the user picked.
3. Install with the project's own package manager or build tool, so its lock file stays
   current. A conflict is reported, never forced.
4. Per installed kind, write one smoke test against real project code and run it; then break
   that code in a scratch copy and show the test fails. E2E: before starting the app, read
   the config it loads (`.env`, `application*.yml`, settings modules), point every non-local
   host (database, API, mail, storage) at a local container or a dummy value, and ask the
   user about any host left; then start it locally and open its first page.
5. Record the smoke tests with record-tests: `tested_files` name the code they run and every
   build or config file this setup changed (runner configs such as `vitest.config.ts` are
   test files and need no test). A kind that cannot run (the app does not start locally) is
   `blocked`, with the command and its output. Run `test-survey` again.

## Output
- The installed kinds with their smoke tests and record, the blocked kinds with what is
  missing, and the declined ones: for backfill-tests to report and to skip their targets.
- The files this setup changed, for backfill-tests' review.

## Done when
- Each picked kind is installed and its smoke test fails on broken code and passes on the
  real one, or it is recorded as blocked with evidence.

## Never
- Never upgrade or remove a dependency the project already has.
- Never change product code, production configs or CI unless the user picked that change.
- Never use real credentials or external systems: tests use dummy values and local services.
- Never write a smoke test that checks nothing (`expect(true)`).
