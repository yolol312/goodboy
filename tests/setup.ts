// Preloaded once per `bun test` run from the repo root (bunfig.toml; a run started inside
// tests/ does not read it). Removes the developer's GOODBOY_* settings from the environment,
// so a hook test does not depend on the shell it runs in. The tests spawn hooks with
// `{ ...process.env, … }` and pin only some of these variables; a GOODBOY_TEST_GATE or
// GOODBOY_BASH_WRITE_GATE set in the shell leaked into the others (round-3 refactoring
// review). It runs before the first test file, not before each: a test that sets one of
// these variables in process.env restores it itself.

import { afterEach } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { resolveGitBinary } from '../lib/git-binary';

// GOODBOY_DOCKER_IT is an opt-in switch for the real-docker test of track M
// (tests/m1-sandbox.test.ts), not a gate setting: it stays.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('GOODBOY_') && key !== 'GOODBOY_DOCKER_IT') delete process.env[key];
}

// The sandbox commands read DOCKER_HOST to tell a local daemon from a remote one (lib/sandbox-run.ts), and DOCKER_CONTEXT picks
// the daemon of the docker binary itself; the tests answer through a fake docker that says which daemon it is. A developer's
// colima or remote setting would make every sandbox test see a daemon that is not the fake's. The real-docker test keeps both
// (it talks to the developer's daemon).
if (process.env.GOODBOY_DOCKER_IT === undefined) {
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_CONTEXT;
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

// The privacy run gate (track M, M6g) refuses a real-data `sandbox-run` without a data-privacy review of the setup,
// which the older run fixtures (fake projects that are no git repositories) do not have. Off for the suite;
// tests/m6g-run-gate.test.ts turns it on.
process.env.GOODBOY_SANDBOX_PRIVACY_GATE = 'off';

// The friction notice (track J3) adds a line to a Stop's systemMessage once per session, which
// older Stop tests that switch gates or block three times would see. Off for the suite;
// tests/j3-friction.test.ts turns it on.
process.env.GOODBOY_FRICTION_NOTICE = 'off';

// The update checkup (track K1c) runs `claude`: no test may run the real one. A path that
// does not exist makes a missed fake fail loudly; tests/k1c-health-smoke.test.ts sets a fake.
process.env.GOODBOY_CLAUDE_BIN = '/nonexistent/goodboy-tests/claude';

// The sandbox commands register a real-data project in a user-level file (lib/sandbox-registry.ts, track M
// M6b); a test never writes the developer's own: the registry dir is a temp dir of this run. `bun test` fires no
// `exit` event in the preload (bun 1.3.11, round-4 review), so the dir of this run stays; the dirs earlier runs left
// are removed here once they are a day old (a run still going is younger than that).
const DAY_MS = 24 * 60 * 60 * 1000;
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith('goodboy-test-registry-')) continue;
  const p = join(tmpdir(), name);
  try {
    if (Date.now() - statSync(p).mtimeMs > DAY_MS) rmSync(p, { recursive: true, force: true });
  } catch {
    // gone already, or not ours to remove
  }
}
const testRegistry = mkdtempSync(join(tmpdir(), 'goodboy-test-registry-'));
process.env.GOODBOY_REGISTRY_DIR = testRegistry;
// The data guard protects the dump and input paths of every registered project wherever the shell is, so a project one test
// registered here would deny `grep -r foo /` in a hook test that runs later (full run: tests/outward-gate-hooks.test.ts). Each
// test starts with the shared registry empty. A test that needs a registry sets its own dir (tests/m6a-project.ts,
// tests/m6b-*.test.ts) and is not touched by this.
afterEach(() => {
  rmSync(join(testRegistry, 'real-data.json'), { force: true });
});

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
