// Preloaded once per `bun test` run from the repo root (bunfig.toml; a run started inside
// tests/ does not read it). Removes the developer's GOODBOY_* settings from the environment,
// so a hook test does not depend on the shell it runs in. The tests spawn hooks with
// `{ ...process.env, … }` and pin only some of these variables; a GOODBOY_TEST_GATE or
// GOODBOY_BASH_WRITE_GATE set in the shell leaked into the others (round-3 refactoring
// review). It runs before the first test file, not before each: a test that sets one of
// these variables in process.env restores it itself.

for (const key of Object.keys(process.env)) {
  if (key.startsWith('GOODBOY_')) delete process.env[key];
}

// The skill rule (track G) denies a main-session code edit without a workflow skill, which
// every older hook test that edits a source file would hit first. It is off for the suite;
// tests/skill-rule*.test.ts turn it on explicitly.
process.env.GOODBOY_SKILL_GATE = 'off';

// The commit issue rule denies a `git commit` without an issue number, which older hook tests
// that commit would hit first. Off for the suite; tests/commit-issue.test.ts turns it on.
process.env.GOODBOY_COMMIT_ISSUE = 'off';
