# Test catalog

Feature → test type, generated from the test files by goodboy (`cli.ts test-catalog`).
Regenerate it instead of editing it; the docs rule compares it with a fresh copy.

Totals: unit 178 files, 3035 tests; e2e 2 files, 54 tests.

| Feature | Type | File | Tests |
|---|---|---|---|
| F1 — skills name the approval marker the gate checks; F2 — the risk gate with an unwritable $TMPDIR; F3 — readSessionState falls back when the session copy is unusable; F4 — a lifted failure stays lifted; F5 — a pass that started before the breaking edit; F6 — the Bash write deny message in a repo without .claude/ | unit | tests/a3-round2-regressions.test.ts | 13 |
| English headings in any case (F1) | unit | tests/acceptance-english-headings.test.ts | 4 |
| parseCurrentStage (I11, #20); readCurrentStage (I11, #20); readAcceptance: uiPending follows the stage (I11, #20); parseCurrentVersion; isPlaceholderCell; extractTableRows | unit | tests/acceptance.test.ts | 54 |
| risk approval — the deny message names the marker that unlocks this session (A3); Bash write approval — one shot, for the session the message names (A3) | unit | tests/approval-marker-flow.test.ts | 5 |
| approval markers (A3); risk approval withdrawal (A3) | unit | tests/approval-marker.test.ts | 6 |
| classifyBashReadDetailed — partial flag (A7) | unit | tests/bash-read-partial.test.ts | 6 |
| classifyBashReadDetailed — partial flags (A7); classifyBashRead — 내용을 보여주는 명령; classifyBashRead — 읽기로 보지 않는 것; safeMtime | unit | tests/bash-read.test.ts | 22 |
| the fd number of a redirection; file arguments after a redirection (round 3) | unit | tests/bash-write-fd-number.test.ts | 9 |
| classifyBashWrite — 차단해야 하는 쓰기; classifyBashWrite — 허용해야 하는 것 (오탐 방지); classifyBashWrite — v0.26.1 실측 오탐 4종 (전부 비차단이어야 한다); classifyBashWrite — GOODBOY_BASH_WRITE_ALLOW; classifyBashWrite — v0.26.2 실측 오탐 5호: 따옴표 안 tee/sed 단어; classifyBashWrite — heredoc detection (round 3) | unit | tests/bash-write.test.ts | 53 |
| bun guard — bun이 있으면 그대로 실행; bun guard — Windows(Git Bash) 대응; bun guard — bun 없음; bun guard — track G hooks (session-start, subagent-stop, post-tool-use-failure) | unit | tests/bun-guard.test.ts | 13 |
| CI workflow (A1) | unit | tests/ci-workflow.test.ts | 4 |
| extractCitations; verifyCitations — C1/C2 확정 환각; ranges and lists (A8); bare file names (A8); citation endings; bare-name index cache and time budget | unit | tests/claim-check.test.ts | 43 |
| Codex review fixes | unit | tests/codex-review-fixes.test.ts | 3 |
| bounds of one call; aliases keep the call settings; messages as git cleans them; settings | unit | tests/commit-issue-bounds.test.ts | 21 |
| G1: git run by a hook runs programs from the repo's config, outside any model Bash window; G2: reading the heredoc scripts of shells costs cubic time; G3: an oversized file the rule reads kills the hook (no output, so the call runs); G4: a commit in another repo by --git-dir or GIT_DIR reads the cwd repo; G5: commits the push gate reads (its push forms are denied) and this rule does not; G6: a session started by /clear has no pins until its first git command | unit | tests/commit-issue-l1-final.test.ts | 11 |
| F1: a message file the hook cannot finish reading; F2: a reused-message value reaches `git log` as an option; F3: alias lookups are not bounded; F4: the session pin follows symlinks; F5: the session pin is not gate state; F6: a project pattern anchored at the subject's start | unit | tests/commit-issue-l1-gaps.test.ts | 11 |
| hasIssueRef; commitIssueDenial; last review: normal commits read right, settings pinned at the session start; through the PreToolUse hook | unit | tests/commit-issue.test.ts | 15 |
| two sessions in one repo — review and test cursors (A3); two sessions in one repo — review findings (A3); two sessions in one repo — auto-validation failure marker (A3); two sessions in one repo — task state (A3) | unit | tests/concurrent-sessions.test.ts | 9 |
| getContextUsage; getContextUsage — 압축 경계 인식 (v0.27.6, H1-03 오탐); getContextUsage — GOODBOY_CONTEXT_LIMIT env override & safe 1M defaulting; getContextUsage — runtime dynamic 1M detection (low-token false-positive fix); getContextUsage confident (3-A); limitForModel bounded 1m matching (4-4) | unit | tests/context-usage.test.ts | 58 |
| recommendEffort; hasRepeatedBlock | unit | tests/effort-advice.test.ts | 7 |
| GAP-DQ: a command substitution inside double quotes runs, so it is read; GAP-NEST: nesting past what goodboy reads marks the reading truncated; GAP-PV: prefix options are per prefix word (sudo -n, command -p, time -p take no value); GAP-LC: a backslash-newline is a line continuation, not part of a word; GAP-BG: a cd in a background job or a pipeline does not move the shell; closing review: a job is a scope of its own, with what runs inside it | unit | tests/g1-closing-gaps.test.ts | 17 |
| GAP-BG2: a backgrounded or piped group or compound command does not move the shell; GAP-HD: an unquoted heredoc body runs its substitutions; GAP-ANSI: `$\; GAP-CASE: a case pattern inside a substitution; carrier lookup cost, on writers whose every word is a target; through the PreToolUse hook | unit | tests/g1-closing-l1-gaps.test.ts | 9 |
| GAP-1 false denial: `xargs git <builtin>` is read as an unclear push; GAP-2 wrong repo: a `(` anywhere stops `cd` from being followed; GAP-3 result CLI behind a runtime flag that takes a value is not seen; GAP-4 file programs that write by option are not result-dir writers; LOW-5 false denial: `command -v sh` reads as a stdin shell; last review: compound commands, subshell scopes, carriers and option tables | unit | tests/g1-final-gaps.test.ts | 21 |
| GAP-K (high): a shell reserved word at the start of a segment hides the program from every classifier; LOW-P: directory changes other than a literal `cd` are followed or make the push unclear; GAP-E (medium, regression of the scope rewrite): `eval` segments keep the cd scope; GAP-O (medium): option writers that write into the cwd, after `cd` into a result dir, and curl flag clusters; LOW-D: a deploy after `cd` compares the repo it ships | unit | tests/g1-last-gaps.test.ts | 16 |
| state guard: what a Bash call changed is put back; approval markers and model Bash calls, through the hooks; restoreProductionHosts; push test check: more pushes goodboy cannot read; bashChangedPaths: option values in every spelling; result dirs: where a result-dir name ends | unit | tests/g1-layer1-gaps.test.ts | 19 |
| GAP-D2: a deploy is compared where it runs, not where the command ends; GAP-F: a `function name { … }` body is read by every classifier; GAP-RS: the result guard and role limits follow cd scopes (`( … )`, `sh -c`, `cd -`, pushd); GAP-NS: sibling nested shells and evals each get their own scope; GAP-OD: writers whose target is not the result dir word itself; LOW-FP: "inside a result dir" holds only while the shell is there | unit | tests/g1-reader-scopes.test.ts | 23 |
| program names as the system finds them; shells that read their script from stdin; alias values split as git splits them; hook git settings; state guard restore; commit rule caps | unit | tests/g1-round4-fixes.test.ts | 13 |
| D1: a hook git that reads a missing object starts a promisor fetch (remote.<r>.uploadpack); D2: git spelled with quotes, another letter case or its dashed program; D3: alias values are split on spaces, not as git splits them (quotes, backslashes); D4: `git send-pack` pushes without being a push to the push gate or R2; D5: the post hook's write sweep runs a clean filter (git status hashes a touched file); D6: a guarded file replaced by a directory stops the state guard from restoring the rest | unit | tests/g1-round4-l1-gaps.test.ts | 10 |
| the 24 agents; the 27 tool skills (23 from G2, keep-project-knowledge from H2, report-goodboy from J1, cli-update-check from K1d, setup-test-infra from L); the renames are complete | unit | tests/g2-agents-skills.test.ts | 4 |
| PostToolUse: skill effort notice; legacy result writer, hook level; changed-line coverage from a real report, into test-write; role limits of the test agents, through the PreToolUse hook | unit | tests/g2-e2e-hooks.test.ts | 6 |
| test results: suites per type; test results: coverage, recorded not gated; review results: Codex; changed-line coverage; skill effort notice; agent outcomes | unit | tests/g2-results.test.ts | 16 |
| workflow skills | unit | tests/g3-workflow-skills.test.ts | 4 |
| 게이트 로그 (E1); 상태 스냅샷 (E1); 컨텍스트 측정 canary (E1) | unit | tests/gate-log.test.ts | 6 |
| gateMessage; isGateMessage | unit | tests/gate-message.test.ts | 6 |
| the marker; through the hooks; evidence logs under the state guard | unit | tests/h1-project-mode.test.ts | 11 |
| policy read gate and the Read tool default cap | unit | tests/h2-default-read-cap.test.ts | 1 |
| files; what counts as read; the read gate; through the hooks; the skill's done check | unit | tests/h2-project-knowledge.test.ts | 10 |
| the defaults; the project entries; delivery | unit | tests/h3-decision-authority.test.ts | 14 |
| staleDocs; the test catalog; sums; through the Stop hook; CLAUDE.md at SessionStart | e2e | tests/h4-docs-rule.test.ts | 25 |
| the profile; the advice; through the CLI and the hook | unit | tests/h6-test-profile.test.ts | 7 |
| the review size; delta reviews; the review skills | unit | tests/h7-light-review.test.ts | 8 |
| hasBin | unit | tests/has-bin.test.ts | 4 |
| merged rules; PreToolUse; after a Bash call | unit | tests/hosts-guard.test.ts | 10 |
| diff coverage; the gaps; replace refs; exemptions; through test-write and the Stop hook | unit | tests/i1-changed-lines.test.ts | 53 |
| projectDir; the Stop gates after a cd into a subdir; PreToolUse after a cd into a subdir; I10 review: worktrees, approval paths, the CLI | unit | tests/i10-project-dir.test.ts | 11 |
| the document class; the pre-edit guidance (B2); the review gate, end to end | unit | tests/i1b-doc-guidance.test.ts | 12 |
| requirements; the stage pinned at the session start (I11, #20); policy entries with a test line; the session criteria; a product criterion is never met by a document; end to end | unit | tests/i2-acceptance.test.ts | 52 |
| net change: an edit restored to the start blob; content freshness: a record made on the content the file has now; all gaps at once; forbidden patterns on added lines; forbidden patterns: a test file git does not show as changed; subprocess evidence through the hook | unit | tests/i23-gate-scope-stop.test.ts | 23 |
| net change: netChangedEdits; net change: files git cannot hash safely; changedLines: an added line that looks like a file header; changedLines limited to paths; net change: a file that vanished; content freshness: freshFor | unit | tests/i23-gate-scope.test.ts | 65 |
| net change: an edit restored to the start blob needs no review; content freshness: a review made on the content the file has now; withSameContent: which list of files a record names (in-process) | unit | tests/i26-review-net-change.test.ts | 9 |
| needsTests: the harness is a test means when its marker is a regular file; the Stop test gate: a session that edits only testkit/ files | unit | tests/i28-testkit-harness.test.ts | 12 |
| openedPath: the path the OS opens; the recorder stores the file the OS opens, and each such edit needs a test at the Stop gate; read-before-edit agrees on the file the OS opens; MultiEdit and the re-Read gate use the path the OS opens | unit | tests/i29-dotdot-links.test.ts | 15 |
| the class of a path; a preview is static only when its content is; the content check cannot be talked around; round 2: fail closed where the browser reads differently; what needs a test; the hooks use the classifier | unit | tests/i3-verification-scope.test.ts | 33 |
| needsTests: fixed housekeeping names need no test record; needsTests: an empty .gitkeep/.keep; needsTests: package.json and plugin.json with only a version change; blobAtCommit: a file at a commit, or null; needsTests: a test-named path is trusted only inside the repo; needsTests: a dangling test-named link is not trusted | unit | tests/i30-metadata-no-test.test.ts | 34 |
| openedPath spells its result like the cwd; classifyBashWrite reads a target the way the OS opens it; bashChangedPaths takes file and option targets the way the OS opens them; Bash read tracking under an alias cwd; the realpath memo of one evaluation; the spelling walk stops at the first ancestor that is its own real path | unit | tests/i31-bash-opened-paths.test.ts | 39 |
| relative record paths with the shell in a subdirectory; a test under docs/versions as product evidence; git-ignored build copies of a tested source file; build copies: batching, the cap and the budget; record paths in this process; test-write and review-write in this process | unit | tests/i32-stop-gate-repeats.test.ts | 67 |
| the worktree list shared inside one SessionStart; nearestGitTop; writeOnce; the readers of the session files survive a session dir that cannot be named or read; a git dir that git names and the file system does not hold; a first sight whose changes cannot be recorded | unit | tests/i33-worktree-start-inprocess.test.ts | 27 |
| the research repro: a linked worktree is judged against its own start (control: the session starts in it); rule 1: SessionStart freezes the tips and pins the worktrees that exist; rule 2: a checkout first seen mid-session; rule 3: what is already in a checkout when a hook first sees it counts as the session\; rule 4: an unknown start grants nothing and borrows nothing; rule 4: a pin with no HEAD is unknown, never "no base check" | unit | tests/i33-worktree-start.test.ts | 99 |
| #35: a worktree made mid-session at A/.worktrees/b is a checkout of its own; #35: a Stop in A points to edits made this turn in a nested checkout; #35: a Stop in a nested checkout points to edits made this turn in the project dir; #35: a Stop in A/.claude/worktrees/x checks no other checkout; #35: getEditsSince leaves a nested checkout out of the enclosing dir\; #35: edits under a planted .git are judged by A\ | unit | tests/i35-nested-checkouts.test.ts | 15 |
| R4: a record with a tree counts by the content of the file, never by its time; R4: a record with no tree uses its time only while its checkout is not known to have changed; R4: `tree: null` is a work-tree hash that failed, not a record from before the trees; R4: the cap on record trees read does not let one file starve another; R3: a passing record whose test files are gone is no evidence; R2: a coverage base other than the start counts per file, by the file\ | unit | tests/i36-gate-content.test.ts | 79 |
| every git a hook or library runs carries the safety settings; hostile filter, fsmonitor, replace and graft configuration; a command that diffs runs no external diff program and no textconv; the git binary the hooks run (macOS shim); the per-Stop memo of git answers; a Stop with changed files, a build copy, records and a review | unit | tests/i36-git-cost.test.ts | 51 |
| push check: always-true patterns in the lines the push adds | unit | tests/i369-push-scan.test.ts | 15 |
| currentFindings with trees (#38): "changed" is the content the review saw; currentFindings with trees (#38): what is asked, and when; treeContent (#38) on a real repo; currentFindings (#38) with the real lookup | unit | tests/i38-finding-supersession.test.ts | 29 |
| #38 a cleared finding stays cleared when the files are rewritten with the same content; #38 a finding is still open where the content says it is; #38 files the trees cannot judge fall back to the time rule | unit | tests/i38-review-supersession-stop.test.ts | 10 |
| repoTrees; repoTrees: names, and the cap on confirmed repos; treesOf; regressionTop; checkHandoff: a result with no `tree` and the pushed repo\; cmdTestWrite in a plain folder holding repos | unit | tests/i39-nested-repo-push.test.ts | 40 |
| confirmations are bounded; an unconfirmed dir is a group with an unknown start, a repo with no tree; the Stop hook with a planted `.git`; the post hooks run on the clock too; the hook clock bounds the phases after the confirmations | unit | tests/i3914-bounded-confirm.test.ts | 23 |
| the stop-groups seams and the error paths; nestedRepos limits; scopeCoverageTops: the repo a coverage entry names must be a repo inside the project dir; the schema of coverage.changed and coverage.subprocess, in process; review-write for repos past the tree limit; a nested repo whose git dir is elsewhere is pinned at its own HEAD | unit | tests/i3914-branches.test.ts | 25 |
| isNoRepoProject when the identity check itself fails | unit | tests/i3914-injected-faults.test.ts | 1 |
| repoOfFile; nestedRepos; SessionStart in a project dir that is no repo; the session\; the state guard keeps the per-repository tips file; sessionStartRan | unit | tests/i3914-nested-starts.test.ts | 25 |
| review-write records trees and per-repo extra blobs; diff-coverage output; diff-coverage in a nested repo, in a session: the base is the repo\; test-write takes coverage.changed as one object or a list; changedEntries; the readers see only the entries of their repo | unit | tests/i3914-records-cli.test.ts | 36 |
| the Stop in a project dir that is no repo: each repo is judged under its own top; the stop_hook_active path judges the same groups as the full Stop; a record is judged by its tree for the repo; the shared deadline; shell-made changes in a repo below the project dir; the `auto` test gate counts a test runner in any repo below the project dir | unit | tests/i3914-stop-groups.test.ts | 62 |
| boundary code; the types a file needs; missing types; the user globs | unit | tests/i3b-test-types.test.ts | 20 |
| the whole-suite command; cli.ts regression; records and the check; the push check | unit | tests/i4-regression.test.ts | 22 |
| spawnGit stops at the hook clock; statusOf; nestedStatus names what git did not answer for; a Bash call whose writes git could not list is kept; retryUnswept; the record file | unit | tests/i40-git-clock.test.ts | 65 |
| the tests that load a changed file; affected gaps; weakened tests; the Stop | unit | tests/i5-existing-tests.test.ts | 50 |
| finding 1: the project knowledge notice; findings 2–4 and 6: the push test check; finding 5: the result guard; finding 8: a local database socket | unit | tests/i6-trial-fixes.test.ts | 10 |
| finding 1: layer 1 in JVM projects; finding 2: a full regression for Gradle and Maven; finding 3: results written from goodboy's own directory; finding 4: open Bash calls at Stop while agents run | unit | tests/i7-trial2-fixes.test.ts | 7 |
| finding 1: code-free Java interfaces; finding 2: a commit and a push in one command | unit | tests/i8-trial3-fixes.test.ts | 5 |
| I9: citations resolve from the repo root, whatever the shell cwd; I9 review: two readings, a symlinked cwd, bare names | unit | tests/i9-claim-root.test.ts | 13 |
| J1: the template; J1: the public summary check; J1: the session's evidence; J1: the inbox; J1: cli.ts report-write; J1: cli.ts report-evidence and --session | unit | tests/j1-field-report.test.ts | 16 |
| J2: the inbox list and the notice; J2: moving a triaged report to done/; J2: the issue form and the skill; J2: review round 1; J2: review round 2 | unit | tests/j2-field-triage.test.ts | 24 |
| signals from recorded fixtures; once per session, and where it is on; hook errors are recorded; the Stop hook | unit | tests/j3-friction.test.ts | 23 |
| state transitions; state file; the checkup dir; the changelog; the run writer stays in runs/<run>/; the CLI | unit | tests/k1a-checkup.test.ts | 25 |
| the inventory; agent checks; triage with inventory identifiers; the CLI; review round 1 fixes; review round 2 fixes | unit | tests/k1b-inventory.test.ts | 32 |
| health parsers; checkHealth with a fake claude; decisions; goodboy's smoke cases; the user's smoke cases; the CLI | unit | tests/k1c-health-smoke.test.ts | 35 |
| problems that were already there, kept apart from regressions; projects to suggest for the registry; the session probe; the model probes; the CLI; the comparison, check by check (layer-1 additions) | unit | tests/k1d-update-check.test.ts | 49 |
| L2: Java and Kotlin test files; L1: the survey; L3: the backfill state | e2e | tests/l-test-backfill.test.ts | 29 |
| T5-1: an unknown repo matters only to a command that may commit; T5-3: chmod modes are no paths | unit | tests/l-trial5-fixes.test.ts | 3 |
| marker names and Bash writes; PreToolUse; a marker made during a model Bash call that never reported back (`exit N`, G0 M18); a marker made in another directory during a finished call (security review round 2); round 3; PostToolUse sweep | unit | tests/marker-guard.test.ts | 14 |
| redirections; shellSegments; hostOf; curl, wget, httpie; ssh family; git push | unit | tests/outward-command.test.ts | 22 |
| unlisted external hosts; production hosts; gate modes | unit | tests/outward-gate-hooks.test.ts | 12 |
| ports in command targets; entries with a port; the production guard covers host:port entries; through the PreToolUse hook; connection target reading: value flags, URI parameters, host spelling, env; value flags are per tool | unit | tests/outward-host-port.test.ts | 48 |
| buildBashOutputWarning (pure); post-tool-use H2-02 integration | unit | tests/post-tool-use-bash-flood.test.ts | 12 |
| post-tool-use-failure hook | unit | tests/post-tool-use-failure.test.ts | 5 |
| looksUnavailable (#5); buildValidationContext (#5); post-tool-use integration (#5); autoValidate mode (2-A); autoValidateMode (2-A unit) | unit | tests/post-tool-use-validation.test.ts | 18 |
| post-tool-use H2-04 — WebSearch 재검색 경고 (v0.27.9); 압축 epoch 리셋 — 웹 기록도 함께 비운다 (v0.27.9, 리뷰 medium) | unit | tests/post-tool-use-web-refetch.test.ts | 5 |
| PreToolUse — 산출물 쓰기 게이트 | unit | tests/pre-tool-use-artifact-write.test.ts | 7 |
| pre-tool-use no longer emits H2-02 (moved to PostToolUse) | unit | tests/pre-tool-use-bash-flood.test.ts | 3 |
| classifyBashSearch (H2-03 unit); pre-tool-use H2-03 Bash search gate (integration); H2-03 small-scope relaxation (track G) | unit | tests/pre-tool-use-bash-search.test.ts | 19 |
| pre-tool-use bash-write gate — 승인 마커 (v0.27.0) | unit | tests/pre-tool-use-bash-write-approve.test.ts | 5 |
| classifyBareCatDump (pure); pre-tool-use cat 사전 차단 (integration) | unit | tests/pre-tool-use-cat-gate.test.ts | 12 |
| PreToolUse — artifact-write deny names a runnable CLI path (A9) | unit | tests/pre-tool-use-cli-path.test.ts | 2 |
| pre-tool-use read-before-edit — 창 30턴 정렬 (v0.27.9) | unit | tests/pre-tool-use-read-before-edit-window.test.ts | 5 |
| pre-tool-use reasoning gate (recent-window); pre-tool-use reasoning gate — 실질 검사 (A1); pre-tool-use reasoning gate — 무언 편집 차단 (라이브 검증 발견); pre-tool-use reasoning gate — 텍스트 플러시 지연 fail-open (v0.26.1); pre-tool-use reasoning gate — escape 카운터 (v0.26.1, 탈출구 없는 게이트 금지); pre-tool-use reasoning gate — 모드 (GOODBOY_REASONING_GATE) | unit | tests/pre-tool-use-reasoning-gate.test.ts | 43 |
| pre-tool-use H2-01 re-read gate | unit | tests/pre-tool-use-reread-gate.test.ts | 13 |
| pre-tool-use risk gate (2-B) | unit | tests/pre-tool-use-risk-gate.test.ts | 10 |
| isTaskNotification (G0 M10: completions arrive as prompts); parseSlashCommand (G0 M12: typed commands arrive verbatim); isGoodboyCommand | unit | tests/prompt-kind.test.ts | 9 |
| handoffsOf; workTreeState and checkHandoff; the PreToolUse rule | unit | tests/push-test.test.ts | 30 |
| an own edit as knowledge; whose read counts; after a compaction | unit | tests/read-before-edit-knowledge.test.ts | 10 |
| re-Read gate and PDF page ranges (A7); partial reads elsewhere (A7) | unit | tests/read-record-chain-partial.test.ts | 6 |
| read-record chain: PostToolUse record -> PreToolUse decision (A2); re-Read gate counts only full reads (A7) | unit | tests/read-record-chain.test.ts | 8 |
| hasReasoningSection; parseReasoningSection; placeholder items | unit | tests/reasoning-parser.test.ts | 22 |
| recursion-guard hashPrompt; recursion-guard 강화된 임계값 (동일5/총30); recursion-guard checkRecursionGuard; recursion-guard via pre-tool-use hook; recursion-guard prune (3-B: append-only + 원자적) | unit | tests/recursion-guard.test.ts | 15 |
| detectMissingInputs; buildRequiredInputsChecklist | unit | tests/required-inputs.test.ts | 12 |
| H2-01 epoch 리셋 — 압축 감지 시 read 기록 초기화; 위임 재독 주의 (비차단) | unit | tests/reread-epoch-and-delegation.test.ts | 7 |
| review-corpus deterministic guard | unit | tests/review-corpus-guard.test.ts | 3 |
| getEditsSince; getLatestEditTimestampSince; wasFileEditedRecently (FRICTION #4); review cursor persistence; BUG #2 regression: per-feature scope | unit | tests/review-cursor.test.ts | 14 |
| axesFor — 병렬 리뷰 축 결정; requiredDimensionsFor | unit | tests/review-dimensions.test.ts | 18 |
| 리뷰 스코프 — 프로젝트 안으로 한정 (루프 방지); 리뷰 스코프 — 위임 우회 차단; 리뷰 스코프 — 커서 경계; 리뷰 스코프 — 데드락 대응 필터 (A/B/C) | unit | tests/review-scope.test.ts | 12 |
| review timestamps that are not ISO date-times (round 3) | unit | tests/review-timestamp-trust.test.ts | 1 |
| validateReview; validateReviewCoverage (v0.26.5, 리뷰 누적 인정); currentFindings (v0.26.6, finding 단위 대체 의미론); currentFindings: what supersedes a finding (round 3); fileModifiedAt (round 3); review timestamps on read (round 3) | unit | tests/review-validator.test.ts | 49 |
| review-write CLI (#7); validateReviewResultInput (unit); review-write path traversal hardening (1-B) | unit | tests/review-write.test.ts | 23 |
| risk approval withdrawal deletes this session’s risk marker only (A3); the risk deny in a directory without .claude/ (A3) | unit | tests/risk-approval-scope.test.ts | 2 |
| classifyRisk; isReadOnlyBash (risk-gate exemption, A4); detectRiskOverride | unit | tests/risk-classifier.test.ts | 18 |
| risk gate — read-only Bash in a risky session | unit | tests/risk-gate-read-only-bash.test.ts | 2 |
| writes; Bash changes beyond redirects (security review); tool skills | unit | tests/role-limits-hooks.test.ts | 9 |
| projectRelative; test and doc paths; writeDenial by scope; skillDenial | unit | tests/role-limits.test.ts | 9 |
| result writers; round 3; final review; final review, round 2: normal work passes again; read-only roles and more file programs | unit | tests/security-round2.test.ts | 12 |
| configWarnings; the hook; worktree pins | unit | tests/session-start.test.ts | 4 |
| readSessionState fallback (A3); the risk gate through the fallback (A3) | unit | tests/session-state-fallback.test.ts | 5 |
| session state (A3) | unit | tests/session-state.test.ts | 10 |
| isWorkflowSkill; validateSkillGapNote; the rule in the hooks | unit | tests/skill-rule.test.ts | 13 |
| documents name the per-session approval marker (A3) | unit | tests/skills-approval-marker-name.test.ts | 1 |
| who may start agents; running agents and completions; the same agent on the same prompt; caps and gate modes through the hook; runaway and the fuse through the hook (#21); headless Claude runs | unit | tests/spawn-guard-hooks.test.ts | 15 |
| depth: only leads start agents, and only their members; main-session caps; duplicates need evidence; policy rewrite; spawnsClaudeCli (headless runs bypass the Agent guard); namedFiles | unit | tests/spawn-guard.test.ts | 39 |
| writesGateState; through the hooks | unit | tests/state-guard.test.ts | 8 |
| goodboy statusline | unit | tests/statusline.test.ts | 5 |
| Stop hook — stop_hook_active 경로의 비차단 리뷰 수락 (v0.26.7); Stop hook — 리뷰 파일 위생 (v0.27.5) | unit | tests/stop-accept-on-stop-active.test.ts | 10 |
| the F2 warning needs a code edit; the F2 warning and GOODBOY_TEST_GATE; versions the F2 warning leaves alone; a prototype that yields no criteria (F2) | unit | tests/stop-acceptance-warning-scope.test.ts | 6 |
| layer 1 with English and unreadable dev-cycle documents (F1/F2); an unreadable CYCLE.md at the Stop (F2) | unit | tests/stop-acceptance-warning.test.ts | 3 |
| Stop hook — stop_hook_active accepts use this session\ | unit | tests/stop-active-accept-cursors.test.ts | 4 |
| Stop hook — 추측-리뷰 연동 (A2) | unit | tests/stop-assumptions-gate.test.ts | 6 |
| Stop hook — bare-name walk (layer 0 performance) | unit | tests/stop-citation-walk.test.ts | 7 |
| layer 0 — a user's citation ending in ? or Hangul is the user's, not the answer's; layer 0 — a hallucinated citation in the answer is caught whatever ends it; layer 0 — bare file names in a deep package tree | unit | tests/stop-claim-endings.test.ts | 7 |
| Stop hook — 층0 인용 검증 게이트 | unit | tests/stop-claim-gate.test.ts | 16 |
| Stop hook — compaction notice latch (A7, track G) | unit | tests/stop-compact-latch.test.ts | 2 |
| Stop hook — H1-03 compaction notice (>=50%, track G) | unit | tests/stop-compact-warning.test.ts | 11 |
| cursors per project directory — accepts in a subdirectory (A3) | unit | tests/stop-cursor-per-directory.test.ts | 6 |
| Stop hook — dimension coverage enforcement | unit | tests/stop-dimensions.test.ts | 6 |
| foreign high findings on the user overrides (A3, round 3; track G) | unit | tests/stop-escape-foreign-note.test.ts | 4 |
| foreign high findings and the session's first edit (A3); supersession across every review (A3, rule from round 3); foreign high findings at the stop_hook_active accept (A3) | unit | tests/stop-foreign-findings-window.test.ts | 7 |
| gates wait for running agents; review required, no review at all; round-1 review fixes; effort advice | unit | tests/stop-g1.test.ts | 18 |
| Stop hook — H1-03 compaction notice (>=50%); Stop hook — H1-01 long-session warning; Stop hook — H1-01 한도 비례 임계 + 래치 해제 (v0.27.8) | unit | tests/stop-habit-warnings.test.ts | 9 |
| the assumption-review link with English and described labels (F3) | unit | tests/stop-rationale-assumptions.test.ts | 6 |
| Stop hook — per-session block counts (A3) and the user override (track G) | unit | tests/stop-retry-isolation.test.ts | 2 |
| Stop review gate: a turn with no reviewable change is not re-blocked; Stop review gate: every other carry site; Stop review gate: the weakened-tests carry site | unit | tests/stop-review-carry.test.ts | 9 |
| Stop hook — validateReview failure gate: user override (defect D, track G) | unit | tests/stop-review-validate-escape.test.ts | 1 |
| Stop hook — session-bound state (A3) | unit | tests/stop-session-binding.test.ts | 7 |
| findings per session — the stop_hook_active accept (A3); findings per session — files the session edited before its last accept (A3, v0.26.6); findings per session — a review of this session's file (A3); findings per session — medium findings in the accept message (A3) | unit | tests/stop-session-findings.test.ts | 4 |
| layer 1 for a repo that lives under a test-like directory | unit | tests/stop-test-gate-cwd-relative.test.ts | 4 |
| Stop hook — 층1 테스트 게이트; Stop hook — 층1 테스트 게이트 활성 판정 (auto) | unit | tests/stop-test-gate.test.ts | 36 |
| Stop hook — 자동 검증 실패 게이트 (C1); PostToolUse — 검증 실패 마커 기록/해제 (C1) | unit | tests/stop-validation-gate.test.ts | 10 |
| agentTranscriptPath; 추론 게이트 — 서브에이전트는 자기 글로 판정 (실측 회귀) | unit | tests/subagent-reasoning-transcript.test.ts | 7 |
| the test preload | unit | tests/test-env-preload.test.ts | 3 |
| evidenceProblems — red-green; 뮤테이션 프로브 요구 범위; validateEvidence — 결과 전체; failingSuites; missingTestFiles — 테스트는 repo에 남는 자산이어야 한다; uncoveredCriteria | unit | tests/test-validator.test.ts | 63 |
| a blocked result | unit | tests/test-write-blocked.test.ts | 4 |
| test-write CLI; validateTestResultInput (직접 호출); uniqueJsonPath — 병렬 축이 같은 밀리초에 써도 덮어쓰지 않는다 | unit | tests/test-write.test.ts | 13 |
| token-habits catalog; H1-03 compact force threshold; envInt clamp (4-3); H2-02 classifyBashFlood; H5-04 wantsDetail; H2-02 output-size helpers | unit | tests/token-habits.test.ts | 25 |
| parseTokensFromTranscript; assistantEntriesAfterLastText; assistantTextFreshness | unit | tests/transcript-parser.test.ts | 20 |
| isTrustedTimestamp; canonicalTimestamp | unit | tests/trusted-time.test.ts | 5 |
| user-prompt-submit H5-04 concise-first; user-prompt-submit B2 — 일반 프롬프트 부족-입력 질문 유도 | unit | tests/user-prompt-submit-concise.test.ts | 10 |
| task notifications are not user prompts (M10); a workflow command is a task prompt; slash commands (M12); general guidance (English, with R2) | unit | tests/user-prompt-submit-g1.test.ts | 9 |
| user-prompt-submit — riskReason in the session state (A4); user-prompt-submit -> pre-tool-use risk gate chain (A4); concurrent sessions in one repo (A3) | unit | tests/user-prompt-submit-risk-reason.test.ts | 10 |
| a new category command when the repo-level state cannot be written (A3); another session's category command (A3); the risk gate on a malformed state (A3) | unit | tests/user-prompt-submit-state-write.test.ts | 4 |
| user-prompt-submit argument-free category commands (G1; B1 used to block them); user-prompt-submit self-attestation checklist (#3); resolveSkillPath cwd opt-in (2-C) | unit | tests/user-prompt-submit.test.ts | 11 |
| the start time a pass record keeps (A3); the 5-minute clock-skew bound (A3) | unit | tests/validation-pass-record.test.ts | 7 |
| a pass lifts an older failure only in the same project (A3) | unit | tests/validation-pass-scope.test.ts | 4 |
| validation failure marker (A3) | unit | tests/validation-state.test.ts | 15 |
| D4 — 컨텍스트 성장 반복 경고; D5 (H4-03) — 세션 내 모델 전환 감지; D6 (H2-04) — 동일 URL 재페치 경고 | unit | tests/warnings-d4-d5-d6.test.ts | 9 |
| writesIndirectly; changedFilesSince; through the hooks; withContentHashes | unit | tests/write-sweep.test.ts | 6 |
