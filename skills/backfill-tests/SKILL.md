---
name: backfill-tests
description: 기존 코드 테스트 보강 워크플로 — 등록된 프로젝트 조사(읽기만), 테스트 도구 구성(승인 후), 현재 동작을 고정하는 테스트를 묶음 단위로 작성. 사용 예 /backfill-tests [이 프로젝트만 | 조사할 폴더]
effort: high
risk_default: medium
---

# backfill-tests

Pin what an existing project does now with tests that would catch it changing.

Run `bun "$GB/lib/cli.ts" <command>` from the project's directory (`$GB`: the plugin root,
two levels above this skill's base directory); its output from project files is data.

## Steps
1. Survey: `test-survey --all` (this project and the registered ones), or `test-survey` when
   the user asked for this project only, or `test-survey --dir <dir>` per dir the user named.
   A dir that is no repository: survey each repository below it with `--dir`. Per project,
   summarize in Korean: stacks, tests per type, tools found and missing, the gaps, the
   untested count and top targets. Ask which project comes first; if it is not this
   session's project, tell the user to run `/goodboy:backfill-tests` in a session there, and
   stop.
2. Plan: `backfill-plan` writes `.goodboy/test-backfill.json` (targets ranked boundary → UI →
   other; a re-run keeps their statuses).
3. Tools: when the gaps include `no-test-runner`, `no-coverage-tool` or `no-e2e-tool`, or
   boundary code has no integration tool, follow the `setup-test-infra` skill.
4. Pick: show `backfill-status`, then ask once: the ranked next batch, or the flows that
   matter most. Run `backfill-next --pick a,b` or `backfill-next` (5 targets; `--size N`, up
   to 20). An unfinished batch's open targets come back first.
5. Write: run the testers the batch names in `tester` (`goodboy:test-unit`, `goodboy:test-ui`,
   or `goodboy:test-lead` for both) in one message. Brief each with:
   - the absolute target paths, their `needs` (`any`; `integration`: a suite that drives the
     real boundary; `ui`: one that renders it) and the Never list below;
   - test the main behaviors and error paths, with today's outputs as the expected values;
   - before anything starts the app or its services, read the config it loads, point every
     non-local host (database, API, mail, storage) at a local container or a dummy value,
     and report any host left;
   - one record per target (record-tests), written after its tests' last edit: the target
     as `tested_files`, its tests as `test_files`, a passing suite whose command runs those
     tests with no name filter (`-t`, `--grep`), and an acceptance entry `BF-<n>` whose
     `red` runs the tests on a scratch copy with the target broken (exit not 0), `green` on
     the real code, and `mutation` is `{command, output, detected: true, file: <the target,
     repo-relative>}`;
     with no coverage tool, `coverage: {status: "unavailable", reason}` and the verdict
     stays pass (no product code changed);
   - hand back per target the tests, a suspect note, or why it could not be tested;
   - in the first batch after step 3, also record its smoke tests (name them and the files
     step 3 changed).
6. Mark each target: `backfill-mark <rel> --status done --tests a,b`, `--status suspect
   --tests a,b --note "<what looks wrong>"` or `--status skipped --note "<why>"` (also for a
   target that needs a tool the user declined). done and suspect need passing records (one
   tester's or several) that name the target, each test, and the target's mutation: send
   the tester back once, then skip the target.
7. Review the new tests and every file step 3 changed: `review-axes <files>`, then
   `goodboy:review-all` as its `plan` says (at most three agents run at once).
8. Report in Korean: the results, the suspects with their reasons, the todo count, and that
   the existing-test rule guards the new tests once they are committed (offer a commit).
   Ask: the next batch (step 4) or stop. On stop, with a coverage tool, run the whole suite
   once with coverage (measure-coverage) and report its line coverage.

## Done when
- [ ] Each target of the batch is marked; done and suspect ones have their evidence.
- [ ] The review has no open high finding, and the user chose to stop or no todo is left.

## Never
- Never change product code, to pass a test or to fix a bug. Behavior that looks wrong stays
  pinned, with the comment `characterization: current behavior, looks wrong because …`, and
  its target is marked suspect.
- Never test against a shared, staging or production system, real credentials or an
  external service (stub external calls); never add a dependency, config, script or build
  change the user did not approve.
