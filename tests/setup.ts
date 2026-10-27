// Preloaded once per `bun test` run from the repo root (bunfig.toml; a run started inside
// tests/ does not read it). Removes the developer's GOODBOY_* settings from the environment,
// so a hook test does not depend on the shell it runs in. The tests spawn hooks with
// `{ ...process.env, … }` and pin only some of these variables; a GOODBOY_TEST_GATE or
// GOODBOY_BASH_WRITE_GATE set in the shell leaked into the others (round-3 refactoring
// review). It runs before the first test file, not before each: a test that sets one of
// these variables in process.env restores it itself.

import { delimiter, dirname, isAbsolute } from 'node:path';
import { resolveGitBinary } from '../lib/git-binary';

// GOODBOY_DOCKER_IT is an opt-in switch for the real-docker test of track M
// (tests/m1-sandbox.test.ts), not a gate setting: it stays.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GOODBOY_') && key !== 'GOODBOY_DOCKER_IT') delete process.env[key];
}

// The field-report notice asks gh for unanswered issues on goodboy's repo (#20 triage); a test
// never reaches GitHub: gh points at a path that does not exist.
process.env.GOODBOY_GH_BIN = '/nonexistent/goodboy-test-gh';

// The skill rule (track G) denies a main-session code edit without a workflow skill, which
// every older hook test that edits a source file would hit first. It is off for the suite;
// tests/skill-rule*.test.ts turn it on explicitly.
process.env.GOODBOY_SKILL_GATE = 'off';

// The commit issue rule denies a `git commit` without an issue number, which older hook tests
// that commit would hit first. Off for the suite; tests/commit-issue.test.ts turns it on.
process.env.GOODBOY_COMMIT_ISSUE = 'off';

// The changed-line coverage rule (track I, I1) blocks a test result without changed-line
// coverage, which the older layer-1 fixtures do not carry. Off for the suite;
// tests/i1-changed-lines.test.ts turns it on.
process.env.GOODBOY_DIFF_COVERAGE = 'off';

// The test-type rule (track I, I3b) asks boundary and UI code for typed suites, which the older
// layer-1 fixtures do not have. Off for the suite; tests/i3b-test-types.test.ts turns it on.
process.env.GOODBOY_TEST_TYPES = 'off';

// The push regression check (track I, I4) asks a hand-off for a full regression goodboy ran,
// which the older push test fixtures do not have. Off for the suite; tests/i4-regression.test.ts
// turns it on.
process.env.GOODBOY_PUSH_REGRESSION = 'off';

// The existing-test rules (track I, I5) ask for the tests that load a changed file and judge
// weakened tests, which the older fixtures do not set up. Off for the suite;
// tests/i5-existing-tests.test.ts turns them on.
process.env.GOODBOY_EXISTING_TESTS = 'off';

// The friction notice (track J3) adds a line to a Stop's systemMessage once per session, which
// older Stop tests that switch gates or block three times would see. Off for the suite;
// tests/j3-friction.test.ts turns it on.
process.env.GOODBOY_FRICTION_NOTICE = 'off';

// The update checkup (track K1c) runs `claude`: no test may run the real one. A path that
// does not exist makes a missed fake fail loudly; tests/k1c-health-smoke.test.ts sets a fake.
process.env.GOODBOY_CLAUDE_BIN = '/nonexistent/goodboy-tests/claude';

// The hooks read the project dir from CLAUDE_PROJECT_DIR (I10). A suite run inside a Claude Code
// session inherits that session's; tests set it themselves (tests/i10-project-dir.test.ts).
delete process.env.CLAUDE_PROJECT_DIR;

// On macOS `git` on PATH is /usr/bin/git, a shim that asks xcode-select for the real binary on
// every call (20-40 ms; v0.36.6). The tests spawn git thousands of times, so the real tool's
// directory goes first on PATH for every spawn that passes `{ ...process.env }`. The hooks pick
// the same binary themselves (lib/git-binary.ts); a spawn that passes no env keeps the shim. No
// monkeypatch of Bun.spawn: an explicit env stays as the test wrote it. Elsewhere, or when the
// lookup fails, nothing changes.
const gitBin = resolveGitBinary(process.env, process.cwd());
if (isAbsolute(gitBin)) process.env.PATH = `${dirname(gitBin)}${delimiter}${process.env.PATH ?? ''}`;
