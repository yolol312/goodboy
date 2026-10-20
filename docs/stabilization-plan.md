# goodboy stabilization plan

- Date: 2026-10-12 (based on a five-axis review of v0.29.0)
- Status: active. Until v1.0 this track takes precedence over the new-gate items in
  [improvement-plan.md](improvement-plan.md).

## 1. Why

The five-axis review scored v0.29.0 at 4.8/10 ("late alpha"):

| Axis | Score | Summary |
|---|---|---|
| Architecture / code quality | 4 | Clean `lib/` layer; hooks are giant `main` callbacks with many early returns and 9 copies of the retry/escape state machine |
| Robustness / security | 5 | Consistent fail-open and escape hatches; cross-session state bleed, deny paths without exits |
| Tests / verification | 6 | 737 passing black-box tests, typecheck clean; 8 of 15 core-decision mutations survive, no CI |
| Docs / DX / release | 5 | Solid install path; no update procedure, CHANGELOG, or tags; 14 undocumented env vars |
| Design effectiveness / value | 4 | Cost does not scale with change size; gate effectiveness is unmeasured |

Feature coverage is broad (about 18 blocking gates). Operational reliability is not:
core gates can switch off silently, false positives can deadlock a session, and
24 of the last 50 commits are fixes.

## 2. Principles

1. **Feature freeze** — no new gates until v1.0. Exceptions: track G (§10) and track H
   (§14, project knowledge, v0.32.0), both approved by the user on 2026-10-14; track I (§15,
   v0.33.0), track J (§16, v0.34.0) and track K (§17, v0.35.0), approved on 2026-10-16.
2. **Test first** — every fix lands with a regression test that fails before the fix.
3. **Measure before trading cost against detection.**
4. **Proportional cost** — guardrail overhead scales with change size and risk.

Target: v1.0 = "stable" (7/10). An external user can install, run, update, and remove
goodboy from the docs alone, and regressions are caught automatically.

## 3. Release batches

Pushing to `main` ships to users immediately (the marketplace source is the repo root),
so work is released in batches:

| Version | Contents |
|---|---|
| v0.30.0 | A (fixes) + F1–F4 (language-policy prerequisites), released 2026-10-13 |
| v0.31.0 | G (routing: rules, roles, tools), which also covers B2, B3 and F7. Prepared 2026-10-15 on `feat/g-routing` (G0 1312639, G1 bf9c5b9, G2 8e46b84, G3 891c2ef, version bump); the merge and the push to `main` (the release) wait for the user |
| v0.32.0 | the rest of B (cost) + C (measurement) + F5, F8, and track H (knowledge; branch `feat/h-knowledge`, stacked on `feat/g-routing`). G and H were merged into the local `main` on 2026-10-16 (not pushed) |
| v0.33.0 | track I (test automation, §15; branch `feat/i-test-automation`, issues #1–#7) |
| v0.34.0 | track J (field reports, §16; issues #8, #9, #11) |
| v0.35.0 | track K (update checkups, §17; issue #10 for K1, the later steps are proposals) |
| v1.0.0-rc | D (release readiness) + F9–F10 |

## 4. A — Fix silent failures and deadlocks

| # | Item | Where | Done when |
|---|---|---|---|
| A1 | CI: `bun test` + `bun run typecheck` on ubuntu-latest and macos-latest | `.github/workflows/ci.yml` | runs on push and PR, green |
| A2 | E2E chain test: PostToolUse records a Read, PreToolUse decides the Edit, same TMPDIR | `tests/` | fails when the Read record is dropped |
| A3 | Keep per-session gate state in the session state dir, bound to `sessionId`: retry counters, review/test cursors (one per project directory, since the review set is scoped to the Stop's cwd), the auto-validation failure marker, and the risk state the gate reads. The repo-level `.goodboy-session-state.json` is still written for the subagents. Both copies are written independently, and the repo copy is the fallback when the session copy is missing or unusable: an unwritable `$TMPDIR`, or after `/reload-plugins`. A usable session copy always wins (the agent can write the repo copy), and one that cannot be overwritten is removed so the fallback carries the new task (unless the session dir is read-only too; see §8). Approval markers carry a session tag; a new category command withdraws the session's risk approval in every directory its gate checked. Each used to be one repo-level file, so a concurrent session in the same repo overwrote it: B's accept re-gated A's edits, B's failing validation replaced A's failure marker, B's category command lifted A's risk gate, and an approval for B unlocked A. Shared state stays shared where it is about the shared tree: a failure is stale once each of its commands passed in a run that started after it, in any session (per-command start times in an owner-checked project dir). Findings block a session when their review names a file the session ever edited (moved and deleted files included), whoever wrote the review; high findings of other reviews are shown, not blocking, at every move of the review cursor (passes and escapes). Round 3: a finding is superseded only when a file its review covered changed after that review and reviews written after the change list the flagged file and cover, together, every axis of the finding's review (a review without dimensions, or with the `hallucination` marker that the single all-axes run writes, is the hallucination axis; a listed file that is missing is no change unless it is the flagged file). Any newer review of the file used to clear it, so in the per-axis flow a later clean axis cleared another axis's high finding; matching dimensions instead of axes left the hallucination axis open and made re-reviewing the fixed file alone never enough. Recorded timestamps must be ISO date-times and are stored in one form, since the gates order them as strings | `lib/review-cursor.ts`, `lib/retry-counter.ts`, `lib/validation-state.ts`, `lib/session-state.ts`, `lib/approval-marker.ts`, `hooks/stop.ts` | cross-session regression tests: B's edits are gated; B never touches A's budget, cursor, risk gate, or approval; B's failing validation does not replace A's marker; B's high finding on B's own files is shown to A but does not block A |
| A4 | Risk classifier: word-boundary match for ASCII keywords (`prod` must not match `product`); read-only inspection Bash (git status/diff/log/show, ls, cat, head, tail — no option that writes or runs a program) allowed in a risky session; the deny message names the cause and the exits (user runs `! touch …`, or `--risk simple`) | `lib/risk-classifier.ts`, `hooks/pre-tool-use.ts` | "add product page" is not risky; `git status` passes; `git diff --output=<marker>` is denied |
| A5 | Auto-validation: "tool unavailable" only for exit 127 or spawn ENOENT; a timeout is inconclusive (no failure marker) | `hooks/post-tool-use.ts` | a TS error whose output contains "not found" still fails; a timeout does not block |
| A6 | Bash write classifier honors `cd <dir> &&` before relative targets | `lib/bash-write.ts` | writes after `cd /outside/project` are not project writes |
| A7 | Deny paths without exits: the re-Read gate treats `pages` as a partial read and records partial reads as partial; the compact escape latches per session | `hooks/pre-tool-use.ts`, `hooks/post-tool-use.ts`, `hooks/stop.ts` | PDF pages 6–10 after 1–5 pass; no block/block/pass cycle |
| A8 | Layer-0 citation check: recognize `file:10-20` and `file:14,51`; resolve a bare basename to a unique repo file; say "use the full path" instead of "file does not exist" | `lib/claim-check.ts` | tests for range, list, unique basename, ambiguous basename |
| A9 | Message fixes: no nonexistent `/review-changes` command; retry wording matches behavior; embed the real plugin root instead of `${CLAUDE_PLUGIN_ROOT}` in Bash instructions | `hooks/stop.ts`, other message builders | message tests |
| A10 | A missing subagent transcript skips only the rationale gate, not the risk gate | `hooks/pre-tool-use.ts` | a subagent Write in a risky session is gated |

## 5. B — Cost reduction

| # | Item |
|---|---|
| B1 | Doc-only changes are exempt from review |
| B2 | Single reviewer by default; per-axis split only for risky or large changes, capped at 2–3 (implements improvement-plan §3.5.3) |
| B3 | Per-prompt guidance (B2 / H5-04 text) is injected only for task-type prompts |
| B4 | Drop filename-substring dimension triggers (e.g. `merge-sort.ts` → prototype-pollution probe). Also match the repo-relative path only: `requiredDimensionsFor` scans the absolute path, so a directory above the repo (`client/`, `api-…/`, `author…/`) adds dimensions — or the UI axis — to every file, and a random temp-dir name flaked a Stop test. The CLI (`review-axes`) and the Stop hook must resolve the same repo root, or they disagree on the required axes. The same root fixes a pre-existing gap: the review and test sets are scoped to the Stop's cwd, which follows the shell (A-phase review: 22 of 65 local transcripts changed cwd), so a session that stays in a subdirectory never reviews its edits elsewhere in the repo |
| B5 | Remove or implement dead rules: the `fileCount: 0` risk bump, unused TOKEN_HABITS catalog values |
| B6 | The H2-02 flood warning must not assume rtk is installed |

Done when: per-session subagent count and injected text drop against the C1 baseline,
while high-severity detection on the review corpus is unchanged.

## 6. C — Measurement

| # | Item |
|---|---|
| C1 | Persistent gate-log under `~/.claude/goodboy/logs/`, including allow/pass events, schema `{ts, session, gate, decision, reason, scope}` (improvement-plan §4.3), plus a small summary script |

## 7. D — Release readiness (Korean-user-centric distribution)

| # | Item |
|---|---|
| D1 | Env registry `{name, default, range, doc}` as the single source; generated README table; warn on unknown `GOODBOY_*` (improvement-plan §4.1) |
| D2 | README: update/uninstall section (`/plugin marketplace update` → `/plugin update` → `/reload-plugins`), table of contents, fix the doc/code mismatches found in the review |
| D3 | Disclose side effects: Docker, Playwright install and `git stash` in test-changes; add `.claude/tests/` to the .gitignore advice |
| D4 | `CHANGELOG.md` and git tags |
| D5 | Statusline registered through a version-independent path |

README, CHANGELOG, and user-visible output stay Korean (product UI for Korean users).

## 8. E — Deferred until after v1.0

- Full gate-pipeline refactor. Extract opportunistically while fixing: a shared
  retry/escape helper, a single acceptance decision, a single transcript parse per hook.
- `/verify` scripting with N-run success rates; review-corpus expansion;
  with/without-goodboy comparison data (recommended once after release).
- Bash write bypass detection (`cp`, `mv`, `perl -pi`) and review-artifact forgery protection.
  Round 3 of phase A closed `>|`, zsh's `>>|`/`>&|`, `>& file`, file arguments after a
  redirection, `<<` inside quotes, comments or arithmetic, and the heredoc of a double-quoted
  `$( … )`. Still open, from the same bash/zsh comparison: a write inside `$( … )` in an
  unquoted heredoc body; `FOO=>file` (read as an arrow function); `cd >/dev/null dir` (the
  target dir is lost); ANSI-C quoting (`$'a\'b'`).
- One shell-word reader for lib/bash-write.ts (closing refactoring review, round 3):
  `heredocDelimiter`, `readWord` and the redirect-target scan read words three ways. So
  `cd ".."/proj && echo x > a.ts` misses the write, `> src/'a.ts'` names the path with the
  quotes, and `echo "$(echo "a > b")"` is denied as a write. All pre-existing.
- `currentFindings` per-file index: 222 ms at 800 reviews and 766 ms at 1,600 now, 31 ms and
  66 ms with an index (closing performance review, round 3).
- Token waste in auto-validation: while a multi-file change leaves the tree failing the
  typecheck, PostToolUse appends the same full tsc output after every edit (seen in round
  3: dozens of repeats of about 25 lines). Show it once, then only when it changes.
- Verification cost: a round of three per-axis reviews plus a layer-1 run took 0.9–1.3M
  tokens, and phase A ran several rounds after round 2. Use the single all-axes review for
  small follow-up diffs, and move pre-existing low findings to this list instead of starting
  another round.
- Deliberate pre-approval of a risky task, both pre-existing and needing a planted file plus
  a chmod: a risk marker created during a simple task survives the next category command when
  its directory is made read-only (withdrawal swallows the unlink error), and a planted repo
  state copy applies when both state writes fail. Fix idea for the first: honour a marker
  only when its mtime is later than the task's start. Also: a session state copy made
  read-only inside a read-only session dir can be neither written nor removed, so the old
  task's risk stays (fix idea: restore the dir's and file's modes before writing).
  Known static-analysis limit of the A6 `cd` tracking: a `cd` that does not take effect
  (`false && cd /tmp; …`, a failing `cd`) can hide a project write. The gate targets
  casual bypass, not an adversarial model.
- Per-session recursion-guard cap (the observed incident pattern, identical prompts, is already caught). Moved to G (§10.7).
- Performance lows from the A-phase review, none with practical impact today:
  build the layer-0 bare-name index from `git ls-files` (complete in large repos; the
  A8 walk stops at 300 ms and then asks for the full path); the A6 `cd` replay grows
  super-linearly with the number of `cd`s (2.6 s at 1,000; real commands have ≤ 10);
  layer 0 re-parses `reads.jsonl` once per citation (101 ms at 10k records); the 300 ms
  walk cap is checked per directory, so one directory of ~1M entries overshoots it
  (0.7–1.0 s; the largest directory in local repos has ~1k entries).
- Session-state hardening with no practical impact today: two session ids that sanitize
  to the same name share a state dir (real ids are UUIDs); a missing `session_id` maps every
  repo to one `unknown` dir; the session dir is reused without checking its owner or mode,
  which matters only on a shared `/tmp` (Linux without `$TMPDIR`). The project pass dir got
  that check in A3 because its name is computable from the project path.
- Shared per-session helpers (refactoring review, round 2): one session-id sanitizer (three
  exist, with different rules), one path key (two sha256 variants), one session-file helper,
  and session id first in every per-session API. Test helpers for the state layout (66
  hand-built session-dir paths in 28 files), so the next layout change is not 66 edits.
- Shared hook-test harness (refactoring review, round 3): 59 test files define their own
  hook runner, `writeReview` is copied into 10 files and the layer-1 result fixture into 6,
  so the next review or test-result schema change is a multi-file edit. One tests/ helper
  (hook runner, `writeReview`, `writeTestResult`) would make it one. The environment leak
  those copies had (each pinned a different subset of `GOODBOY_*`) is fixed by the
  `tests/setup.ts` preload.
- Layer-0 false positive: with the `?`/Hangul citation endings, host:port text such as
  `api.example.com:443?` reads as a citation (host:port before a space or period already did).
- Hangul-ratio enforcement hook for the language policy.
- New gates from improvement-plan.md (evidence gate, risk catalog tier 2, coexistence mode, …).

## 9. F — Language policy (English artifacts)

The global policy lives in `~/.claude/CLAUDE.md` (since 2026-10-12): stored artifacts in
English, chat and approval-gate summaries in Korean, end-user product content in its
original language, team conventions and skill templates win.

Side effects found before enabling it:

1. `lib/acceptance.ts` finds dev-cycle docs by Korean keys (`**현재 버전**`, `화면 목록`,
   `무엇이 달라지는가`, `신규` / `그대로`). English docs make it report "no dev-cycle
   artifacts", so layer-1 acceptance criteria silently drop to zero (fail-open).
2. dev-cycle routing greps `- **현재 버전**:` and `- **현재 단계**:` from `docs/CYCLE.md`;
   English keys yield empty values.
3. Prototype markup is carried into the implementation almost verbatim; translating UI
   copy would put English UI into a Korean product.
4. The rationale parser accepts only `근거|추론|Reasoning` and has no English label for
   판단; English subagent replies would trigger repeated warnings (or denies in deny mode).
   "Reasoning" must not be used because of the server safeguard false-positive history.
5. A global rule leaks into team repos (commits, comments, PR/MR, CHANGELOG from /ship,
   Jira text from /done whose template is Korean).
6. In-flight projects already have Korean CYCLE.md / UIUX.md.
7. Translating hook messages requires updating about 32 test files that assert Korean text.
8. Terminal/IDE-viewed files (e.g. testkit reports) cannot use Chrome translation.
9. The token benefit is assumed, not measured; translated instructions may change behavior.

| # | Item | Addresses |
|---|---|---|
| F1 | Bilingual keys: `lib/acceptance.ts` and dev-cycle routing accept Korean and English (`현재 버전`/`Current version`, `현재 단계`/`Current stage`, `화면 목록`/`Screens` or `Screen list`, `무엇이 달라지는가`/`What changes`, `컴포넌트`/`Components`, `신규·변경·그대로`/`new·changed·unchanged`). Done: English headings and kinds match in any case; dev-cycle routing (`~/.claude/skills/dev-cycle/SKILL.md`, outside this repo) also reads `done` as the finished stage, and its grep follows the parser's key rule (any case, `-` or `*` bullet, optional spaces). Without an exact `## Screens`, the screen list no longer falls back to the `## Changed screens — What changes` table | 1, 2, 6 |
| F2 | Warn when dev-cycle artifacts exist but zero acceptance criteria are extracted. Done: shown once per session with code edits; also when `docs/CYCLE.md` has no current-version line in either language, or exists but cannot be read. The test gate takes one reading of the documents per Stop (`readAcceptance`) for its on/off switch, the criteria and the warning | 1 |
| F3 | English rationale section: accept `## Rationale` and `### Facts / Judgments / Assumptions / Speculation`; keep "Reasoning" out of guidance text. Done; guidance text never used "Reasoning". Found on the way: a label followed by a description (`### 사실 (검증됨)`, the skills' own template) matched nothing, so every bucket was empty and the Stop's assumption-review link never fired; the first word is now the label. With the labels parsed, the link counted placeholder items (`- 없음`, which the rationale gate asks for) as declared assumptions and blocked clean reviews; it now skips them, also with a short note after them (`- 없음 (모두 확인)`), while the rationale gate still counts them as content | 4 |
| F4 | Precedence rules in the global policy (done) | 3, 5 |
| F5 | Measure tokens, Korean vs English, for the per-prompt injection and both agent definitions; go/no-go for F8. F7 no longer waits for it: G writes the new injection and agent definitions in English from the start, as the language policy requires, and F5 measures the result after the fact | 9 |
| F6 | Global policy applied (done), with a temporary clause that keeps tool-parsed Korean keys verbatim until F1/F3 ship | 1, 2, 4 |
| F7 | Translate high-frequency model-facing text: per-prompt injection (with B3), `agents/review-changes.md`, `agents/test-changes.md`, English JSON output. Moved to G: G1 rewrites the injection, G2 replaces both agent definitions with English ones | cost |
| F8 | Translate the remaining hook deny/block reasons and update the affected tests (A4/A7/A8/A9 already translated the messages they touched) | 7 |
| F9 | dev-cycle: English templates (keys per F1), Korean key-decision summary at each gate, preview HTML `lang` (`en` for docs, the product language for prototypes), check Chrome translation on `file://` previews | 3, 8 |
| F10 | Verify with tests and `/verify`: same behavior, no safeguard flags | 9 |

The temporary "tool-parsed keys" clause was removed from the global policy on 2026-10-14,
after v0.30.0 (F1, F3) was installed; dev-cycle routing reads `Current stage` as well.

Order: A → F1–F4 → G → B with F5, F8 → F9 → C, D.

## 10. G — Routing: rules, roles and tools

Added 2026-10-14 with the user's approval, as the one exception to the feature freeze.
It takes over B2 (single reviewer by default), B3 (per-prompt text only for task prompts),
F7 (English agent definitions and injection) and the per-session recursion-guard cap in E.

### 10.1 Why

- Local transcripts, 2026-06-24..10-14 (871 sessions; counted with one-off scripts, not
  reproducible from the repo):

  | Called | Count |
  |---|---|
  | general-purpose subagent | 297 (mostly web research; also implementation, audits, app start/stop, commits, docs, diff summaries) |
  | review-changes | 277 (many re-review rounds) |
  | Explore | 54 |
  | test-changes | 52 |
  | goodboy skills, typed by the user | 3 |
  | skill calls inside 800 subagent transcripts | 2 |

- Both agents run `model: inherit` with no effort, so every delegation runs at the main
  session's model and effort, whatever the job.
- Typed namespaced commands skip category pre-classification: `SLASH_REGEX` in
  `hooks/user-prompt-submit.ts` has no `:`, so `/goodboy:migrate` never matches. It also
  matches a command inside pasted text. A category registered by a follow-up prompt resets
  approvals and retries.
- The `migrate` skill contradicts itself ("execute the migration" vs "stop at the dry run").
- Nested subagents are on by default (3 levels). Only concurrency is capped (20 at once,
  M6); no default per-session cap was found (M6). A runaway
  re-delegation loop (about 6,000 delegations of one "run pytest" task, 2026-06-14) is the
  failure to prevent.
- Escapes that pass a rule after a written reason or a number of retries were used to skip
  work that could have been done.

### 10.2 Model

- **Hooks are rules.** A rule passes on evidence. When it is not met, the hook blocks and
  names what satisfies it. A rule the model can always satisfy has no model-side escape
  (no written reason, no retry count); only the user can override it. A requirement that
  may be impossible (no test runner, no browser, a host that cannot be reached) ends in an
  evidence-backed `BLOCKED` result, and the user gets a Korean notice every time.
- **Agents are roles**, each with a fixed job, model, effort and tool allowlist. The main
  session coordinates.
- **Skills are tools.** Tool skills hold the know-how and are shared by the main session and
  agents. Workflow skills compose tool skills and agents for the main session.
- Teams (`research`, `build`, `review`, `test`) are a naming grouping only, unrelated to
  Claude Code's agent-teams feature.

### 10.3 Agents (24)

Names are `<team>-<role>`; leads end in `-lead`. Tools: R = Read/Grep/Glob, B = Bash,
W = Write/Edit, J = writes its own result JSON only, Web = WebSearch/WebFetch,
Br = browser through Bash (Playwright), A(…) = the members a lead may call.

| Team | Agent | Job | Model / effort | Tools |
|---|---|---|---|---|
| research | research-lead | split a large question, run members in parallel, merge | opus / medium | R, A(web, code, cause) |
| research | research-web | external docs, prices, limits, versions; a URL per fact | sonnet / medium | R, Web |
| research | research-code | diff summaries, module maps, impact analysis | sonnet / medium | R, B |
| research | research-cause | root-cause hypotheses with evidence, no fixes | opus / high | R, B |
| build | build-backend | server logic, API, data access | sonnet / high (opus per call when risky) | R, B, W |
| build | build-frontend | components, skins, CSS; screenshots | sonnet / high | R, B, W, Br |
| build | build-data | schema, migrations, SQL | opus / high | R, B, W |
| build | build-infra | containers, CI, server config; never production | sonnet / high | R, B, W |
| build | build-docs | docs, guides, dev-cycle artifacts | sonnet / medium | R, W |
| build | build-run | long builds and full runs | haiku / low | R, B |
| review | review-lead | pick axes, run members in parallel, merge one summary | sonnet / high | R, B, J, A(the 7 reviewers) |
| review | review-all | one-pass all-axes review (was review-changes) | sonnet / high | R, B, J |
| review | review-spec | requirements and acceptance criteria vs implementation | sonnet / high | R, B, J |
| review | review-quality | design, duplication, performance (not lint territory) | sonnet / medium | R, B, J |
| review | review-security | authN/authZ, injection, secrets, dependencies | opus / high | R, B, J |
| review | review-ui | design tokens and prototype match, states, accessibility | sonnet / medium | R, B, J, Br |
| review | review-infra | config safety, exposed ports, rollback | sonnet / high | R, B, J |
| review | review-evidence | hallucination check, facts vs assumptions | opus / high | R, B, J |
| test | test-lead | pick the needed tests, start one shared environment | sonnet / high | R, B, J, A(unit, spec, ui, security) |
| test | test-unit | unit and integration tests, mutation probes (was test-changes) | sonnet / high | R, B, W (test files), J |
| test | test-spec | acceptance criteria as E2E flows | sonnet / high | R, B, W (test files), J, Br |
| test | test-ui | browser checks against the prototype, state reproduction | sonnet / high | R, B, W (test files), J, Br |
| test | test-security | dynamic attacks against a local sandbox only | opus / high | R, B, W (test files), J |
| test | test-probe | experiments during work (repro, CSP/CORS, limits) | sonnet / high | R, B, Web, Br |

- Members never get the Agent tool. Agents use tool skills, never workflow skills.
- Agent files stay thin: role, limits, model, effort, tool-skill list. Procedures live in
  tool skills.
- Every reference to an agent name comes from the policy table, so the two renames are one
  change each.
- No `permissionMode`: plugin agents ignore it (M5). Tool allowlists and goodboy hooks are
  the limits, including who may call whom and which tool skills an agent may use (M5, M9).
- An agent joins routing only after a capability check shows it produces its artifact.
  Leads are enabled last, after the delegation guards pass their tests.
- G2 (2026-10-15): all 24 agent files exist, thin as above, each preloading
  `follow-agent-rules`. The gates and hook messages name agents only through
  `ROUTE`/`CHECKED_ROLES` in `lib/routing-policy.ts`: today `review-all` and `test-unit`, the
  two checked live (M19); the others can be called directly and join routing when their check
  passes. Leads summarize and list their members' result files; they write no merged result,
  so no finding is counted twice. The pre-G2 names stay recognized as result writers
  (`LEGACY_AGENTS`) for sessions started before an upgrade. Contract tests
  (`tests/g2-agents-skills.test.ts`) keep the files, the table and the plan in step; they
  moved three tool skills: `review-all` also uses check-ui-states and follow-design-tokens
  (it runs the ui axis), `test-unit` uses check-spec-coverage (it covers acceptance
  criteria), and `test-lead` uses none (its members record). The G2 review then gave
  `test-ui` and `test-security` the test-file write scope (a result needs test files that
  exist; `test-security` also uses write-regression-test) and took summarize-diff from
  `research-lead` (it has no Bash). Every review lists a dimension or marker
  (`hallucination`, `infra-config`, `spec-coverage`, `codex`): an empty list reads as a
  hallucination review and could clear its findings.

### 10.4 Skills

Format for every goodboy skill: English, one purpose, inputs → steps → output → done
criteria, a "use when" description, and a machine-checkable artifact so a hook can tell
the skill was applied. Skills ask the user nothing; they return `BLOCKED` with the question.

Workflow skills (main session):

| Skill | Was | Effort |
|---|---|---|
| add-feature | add-feature | high |
| fix-bug | fix-bug | high |
| diagnose-failure | debug | high |
| refactor-code | refactor | high |
| prepare-migration | migrate (production apply is authorized separately) | xhigh |
| write-doc | write-doc | medium |
| request-review | request-review | low |
| setup-statusline | setup-statusline (user-invoked only) | low |

Tool skills (hidden from the menu; main session and agents):

| Skill | Effort | Used by |
|---|---|---|
| write-migration | xhigh | build-data, prepare-migration |
| isolate-cause | high | research-cause, diagnose-failure |
| write-api-contract | high | build-backend, build-frontend, add-feature |
| edit-infra-safely | high | build-infra |
| check-spec-coverage | high | review-spec, test-spec, test-unit |
| check-security | high | review-security, review-all |
| check-infra-config | high | review-infra |
| check-evidence | high | review-evidence, review-all |
| write-regression-test | high | test-unit, fix-bug |
| probe-runtime | high | test-probe, research-cause |
| attack-sandbox | high | test-security |
| cite-sources | medium | research-web |
| summarize-diff | medium | research-code, reviewers |
| follow-design-tokens | medium | build-frontend, review-ui, review-all |
| check-code-quality | medium | review-quality, review-all |
| check-ui-states | medium | review-ui, review-all, test-ui |
| run-e2e | medium | test-spec, test-ui |
| record-review | low | reviewers |
| record-tests | low | testers |
| run-long-command | low | build-run |
| run-codex-review | low | review-lead, review-all |
| measure-coverage | low | test-unit, test-spec |
| follow-agent-rules | none (preload) | every agent |

- The existing eight skills shrink to about 30–50 lines each (setup-statusline stays as is).
  The migrate contradiction is fixed in prepare-migration.
- `/verify` stays repo-only under that name and gains scenarios for the new rules.
- Skill rule: a main-session code edit needs a workflow skill invoked in the current task
  (recorded in `skill-evidence.jsonl` by PostToolUse for a Skill call and by UserPromptSubmit
  for a typed command). When none fits, the main session records a skill-gap note
  (skills considered, why each did not fit, what skill would) and goes on. Reviews check
  that the note is honest; the monthly review uses the notes to improve or add skills.
  There is no catch-all skill.

### 10.5 Effort and model

- A skill or agent that declares an effort runs at it. When it ends, the session is back at
  the user's own setting (skill effort lasts the invoking turn, agent effort the agent's
  run). Applied without a prompt, with a one-line notice (PostToolUse on a goodboy Skill
  call whose frontmatter effort differs from the session's); `GOODBOY_SKILL_EFFORT=auto|off`
  (G2: `ask` was dropped, since the frontmatter effort applies natively, M2).
- Skills never set a model, to keep the prompt cache.
- Advice:
  - SessionStart (new and resumed sessions): configuration warnings only, such as
    `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL` overriding everything, or the
    spawn-depth setting.
  - Before the first action of a new or resumed task: `effort.level` against the policy.
  - During work, on signals: raise after the same rule blocks twice, repeated test failures
    or high findings; lower for doc-only stretches. Shown at the end of the turn.
  - Agent dispatch: model and effort checked against the policy table; the applied effort
    is logged.
  - Advice repeats only when the recommendation changes. No permission-mode advice.

### 10.6 Stop rules

- R1: when unsure, the main session asks; a subagent returns `BLOCKED` with the question.
- R2: never act on live external or production systems. Retarget to a sandbox or temporary
  target; otherwise ask, or return `BLOCKED` with the command for the user to run.
- Hook backstop, `.goodboy/hosts`:
  - `allow` (dev, staging, sandbox): mutating calls pass, also from subagents.
  - `production`: always blocked; the user's approval marker lifts it.
  - unlisted: a subagent's mutating call is blocked with a retarget hint; the main
    session gets advice.
  - Built in: loopback, `localhost`, `.test`, `.invalid`, `.example` are allowed. Private
    IP ranges are not. Reads (GET) always pass.
- Subagents get R1 and R2 from the `follow-agent-rules` preload, since per-prompt text does
  not reach them.

### 10.7 Delegation guards

- Depth 2: main → lead → member. A lead calls only its own members, and its calls are
  rewritten to run in the foreground so it can merge the results (M15); members and other
  agents cannot delegate; `claude -p` from Bash is blocked; inside a subagent the guard
  fails closed.
- Caps in the policy table, tunable: 8 agents per task, 6 per lead call, 3 at once, 40 per
  session. A spent budget ends the work as incomplete, never as passed.
- The same role on the same scope runs again only with evidence: a scope file changed since
  the last run; the last result was `BLOCKED` for an environment reason, or is missing (one
  retry each); an escalation to a stronger model or effort (once); or a new user request
  since. Otherwise the call is denied with a pointer to the existing result.
- When leads are enabled, the recursion rule in the user's `~/.claude/CLAUDE.md` becomes
  "only `-lead` agents call their own members" (with the user's OK).

### 10.8 Review and test additions

- Dispatch from the policy table: a small change gets one `review-all`; a large or risky one
  gets `review-lead` with per-axis members. Lint stays in hooks, CI and pre-commit.
- Codex second opinion (`run-codex-review`): when `GOODBOY_CODEX=on`, each review round also
  runs the local Codex CLI on the diff, read-only, in the background. Off by default, since
  it sends the diff to OpenAI under the user's own Codex login. Results use the review JSON
  with `source: "codex"` and are handled like any other finding. When Codex is missing, not
  logged in, over 10 minutes or failing, the round records `skipped` with the error output
  and goes on.
- Coverage, measured and recorded, not a gate (`measure-coverage`; since track I the
  changed lines are a gate, §15.2a):
  - line and branch coverage from the project's own tool (bun, vitest, jest, pytest-cov,
    JaCoCo, go cover); nothing is installed, and a missing tool is recorded as
    `unavailable` with the reason;
  - changed-line coverage: the report (lcov, Cobertura, JaCoCo XML, Go profile) against the
    diff, in `lib/diff-coverage.ts`;
  - JS coverage of E2E runs on Chromium;
  - mutation detection rate.
  - The existing coverage checks (acceptance criteria, changed files, review axes) stay.
  - A warning when a code file in `tested_files` has no executed changed line. Track I made
    unrun changed lines a test-gate block (§15.2a); test-write still only warns.
- Push test check (G1, added by the user 2026-10-14): before every hand-off — `git push`
  (feature branches and tags; not `--dry-run` or deletions), MR/PR creation (`gh pr create`,
  `glab mr create`), a deploy that `lib/outward-command.ts` classifies as mutating toward a
  host that is neither local nor `allow`, and the `/ship` and `/land-and-deploy` skills — a
  passing layer-1 result must exist for exactly the content handed off. Evidence:
  `test-write` records the tested working tree as a git tree hash (`tree`, plus `commit`),
  untracked files included, ignored files and goodboy artifacts not (on both sides); the
  hand-off passes when the commit it sends has that tree, or for a deploy, when the working
  tree does (a deploy ships the files as they are). A commit after the tests still matches;
  an edit after them does not. The result must also show a suite that ran and test files that
  exist. A push of every branch or tag (`--all`, `--tags`, `--mirror`) is denied as unclear:
  name the refs. Pushes inside `sh -c`, `eval` and git aliases count. No re-run. Checked
  before R2, so a denial never uses a production approval. A `blocked` result never passes;
  only the user overrides (one-use marker or `GOODBOY_PUSH_TEST_GATE`). A typed `/ship` is
  not checked at prompt time; its pushes are.
- Test measurement (G2, with `record-tests`): every layer-1 result records, per test type
  (unit, integration, ui, e2e), the count and the duration. Measured, not gated; no extra
  runs; no test tiers (the tier advice is track H). Done in G2: `test-write` requires `type`
  and `duration_ms` on each suite and adds `by_type`; `coverage` (`measured` with line,
  branch and changed-line numbers from `cli.ts diff-coverage`, or `unavailable` with a reason)
  is optional, and a tested code file whose changed lines never ran prints a warning. Codex
  findings go into the round's own review JSON with `source: "codex"`, and the round records
  `codex: {status: ran | skipped, reason, output}`.

### 10.9 Monthly review

- Per agent and skill: calls, tokens, accepted and dismissed findings, misroutes, `BLOCKED`
  results, skill-gap notes; Codex findings and tokens as their own row.
- Thresholds start a review, never an automatic removal: fewer than 3 calls in 90 days;
  over 20 % misroutes across at least 20 calls; over 30 % incorrect across at least 20
  findings; over 20 % agent-caused incomplete runs.
- Before the first review: a result envelope (`run_id`, role, policy version, status) in
  every agent result; a disposition ledger (the main session records dispositions, the user
  spot-checks); a report command; a seeded-defect corpus to measure misses.

### 10.10 Hooks and libraries

| Event | Change |
|---|---|
| SessionStart (new) | configuration warnings; after a compaction (`source: compact`, M17) reset what read-before-edit counts as known. Recording the model moves to track H (model-change checkup) |
| PreToolUse, Agent | delegation guards; model and effort check; dispatch log |
| PreToolUse, Bash | block `claude -p`; push test check before R2; R2; deny writes from read-only roles; commit issue rule (added by the user 2026-10-15, `lib/commit-issue.ts`): every `git commit`, in the main session and in agents (also through aliases, `-c alias.*`, `!` aliases and shells reading a heredoc script), names an issue in its message (a Jira key or `#123` by default, a project pattern or `off` in `.goodboy/commit-issue`, pinned at SessionStart (startup, resume, clear) under the repo's real path, and the pins made before the first Bash call runs; a file first read later counts only when it and its `.goodboy` dir are unchanged since and not behind a symlink, and one that does not count leaves the default rule, never a farther file; `GOODBOY_COMMIT_ISSUE=off`). Message files are read only when regular and at most 1 MB (4 MB per call, each file once), reused commits through `git log --end-of-options`, git spawns are capped at 8 per call and 5 s each, a call at 10 s, and a git that stalls or prints over 1 MB denies; aliases keep the call's `-c` settings (also `include.path`) and `--git-dir`/`--work-tree`, chains and heredoc shells are followed two deep and denied deeper, `eval`/`sh -c` of a heredoc substitution is read, and an alias or a reuse under env config (`GIT_CONFIG*`, `GIT_DIR`, `HOME`, `--config-env`) is denied; `--cleanup=strip` and `-e` drop `#` lines first (final G1 reviews: an option-shaped `-C` value made the hook write a file; unbounded alias lookups, re-read files, a 3 GB MERGE_MSG and heredoc scripts read with the cube of their number ran it past its timeout or killed it). The git it runs, and the push check's and write sweep's, has fsmonitor off and no signature check. Commits made by `git merge`, `revert`, `cherry-pick` and `commit-tree` are outside the rule |
| PreToolUse, Skill | `/ship` and `/land-and-deploy` need the push test evidence for HEAD |
| PreToolUse, Write/Edit | role limits and result-path limits; skill rule; read-before-edit asks what the editor itself knows (its own reads and edits by `agent_id`, the file unchanged since by mtime, nothing from before the last compaction) |
| PreToolUse, any write | approval markers are the user's: a model write to `.claude/.goodboy-*-approved-*` (any letter case) is denied; after a Bash call the post hooks remove the markers it created (by name against a snapshot taken at the start, not by mtime), and a marker made during a call that never reported back (`exit N`, M18) is not used |
| PreToolUse/post hooks, Bash | gate state guard (`lib/state-guard.ts`): a command that changes a goodboy session dir is denied; the guarded files are snapshotted before each Bash call and restored after it (or at the next Stop); `.goodboy/hosts` production entries cannot be removed by the model (Edit/Write denied, a Bash removal restored), and the files are merged up the tree; files an interpreter or nested shell wrote, and files moved or copied into place (`mv`, `cp`, `git mv`, `git checkout`…, by mtime, ctime and a git-status snapshot; track I), are recorded as edits (`lib/write-sweep.ts`); a shell write into `.claude/tests` or `.claude/reviews` is a project write (results come only from the CLI) |
| PreToolUse, Bash in a read-only role | besides redirects: `cp`/`mv`/`rm`/`touch`/`chmod`…, `perl -i`, mutating git commands, and no `.git/`/`.claude/` exemptions |
| PreToolUse, search | relax H2-03 so small searches run in the main session; a path the shell expands (`~`, `$VAR`, `$(…)`) is never small |
| UserPromptSubmit | every prompt that is not a task notification gets the R1 (ask when unclear) and R2 lines; a workflow command gets R2 plus its checklist; fixed slash regex; argument-free commands allowed; the risk gate only from commands the user typed. Moved to G3: delegation lines and a skill or agent suggestion, registering a task once, and the effort check before a task's first action |
| Stop | effort advice; accept evidence-backed `BLOCKED`; defer the review and test gates while `background_tasks` lists running agents (M10); no count-based escape: a gate blocks until its evidence is there, and only the user's one-use marker (`.goodboy-stop-approved-<tag>`) passes it, with a Korean notice from the 2nd block; H1-03 compaction is a notice, never a block. Review and test messages from the policy table move to G2 (they name G2 agents) |
| PostToolUse, Agent | completion status into the log |
| PostToolUseFailure, Agent and Bash (new) | a failed Agent call counts as done/blocked, so it stops counting as running and gets one retry (M16); a failing Bash call gets the same after-Bash sweeps as PostToolUse (M18) |

- Kept on purpose: the reasoning gate's lag escape (it covers the harness's transcript flush
  lag, not the model), and the `stop_hook_active` pass. On a Stop that follows a block,
  goodboy accepts what it can and does not block again, except that after accepting a test
  result it goes on to the full gates (validation, claim, review), which can block. So a turn
  can end once after a block without its evidence; the review and test cursors do not move,
  so the next turn's Stop blocks again (the claim gate checks each turn's own answer).
  The user decided (2026-10-14) that this needs no work unless the Ralph plugin is used.
- Round 2 of the G1 security review added: results only from their agents (`test-write` from
  test roles, `review-write` from review roles, `GOODBOY_RESULT_GUARD`), no copies or `$`-named
  redirects into the result dirs, and a Write to any `.claude/tests|reviews/` on the path;
  marker origin also by ctime against recorded model Bash windows (`bash-windows.jsonl`), so a
  marker made in another directory during a call is refused; production hosts never shrink
  within a session (`production-hosts.json`), so `chmod 000`, a directory or a symlink in place
  of the hosts file lifts nothing; one shared shell reader (`commandSegments`, with `-lc`-style
  clusters) for every classifier; an alias-lookup budget; `$(…)`, env-config and config-decided
  pushes are unclear; read-only roles also cannot `tar -x`, `unzip`, `curl -o`, `wget`, `rsync`,
  `ditto` or `git read-tree` into the project; the Stop finishes Bash calls that never reported
  back before any gate reads state.
- Round 3 added: a symlink is no approval marker; a `.goodboy/hosts` that exists but cannot be
  read as a plain file (or a `.goodboy` dir that cannot be listed) makes every external host
  production, in later sessions too; a result CLI call whose subcommand is built at run time
  counts as a result write; the Stop's finishing of open Bash calls skips the git sweep after
  5 s (Stop has 15 s); the shared reader also reads `xargs` and `find -exec` commands and
  csh/tcsh/fish `-c`; pushes fed to a shell on stdin, with `xargs` arguments, or of more than
  10 refs are unclear; a literal `cd` before a push moves where it is checked; alias names
  ignore case; result-dir targets are normalized; a Write into a package's result dir below
  the cwd is denied too.
- The final review added: a result-dir path is found anywhere in a word, so interpreter code
  that names one (`python3 -c "open('.claude/tests/x','w')"`) is denied; a result CLI path held
  in a variable or a glob counts as a result write of unknown kind; the push check stops at the
  first unclear hand-off or past 10 refs; the PostToolUse write sweep has 12 s again (3 s at
  Stop). Its second pass undid four false denials of normal work that came from reading the
  whole command text: every rule now reads segments (lib/outward-command.ts). The result CLI
  counts only when a JS runtime runs a `lib/cli.ts` (`cat lib/cli.ts`, `bun src/cli.ts --help`
  pass); a result dir counts as written only by a redirect, a file program's target, `sed -i`,
  an interpreter, a work-tree git command or `find -delete|-exec`, and only when it is this
  session's (lib/result-dir.ts: a mktemp sandbox's `.claude/tests` is not); env or
  `--git-dir`/`--work-tree` make only a push or a possible alias unclear (`git rev-parse
  --git-dir` and `GIT_DIR=… git log` pass); the stdin-shell, xargs and substitution rules need a
  shell reading stdin, an xargs running git, or a substitution among the push's own words.
  The re-review and the last layer-1 round then narrowed them further: xargs running a git
  built-in other than push passes; a copy out of a result dir is a read, while a write to a
  loop or `read` variable over the dir, or an xargs writer's input, is not; option writers
  (`curl -o`, `tar -x -C`, `unzip -d`, `cp -t`) and a CLI behind runtime flags (`bun --cwd .`,
  `bunx tsx`) are seen; `command -v` runs nothing. The last round made the shared reader skip
  compound-command words (`if … then`, `do`, `{`, `!`), which had hidden the program from every
  classifier, and gave each segment a subshell scope, so `cd` is followed per scope and `eval`
  stays in its parent's; xargs running `sed -i`/`perl -pi` on its input counts as a write.
  Its injection pass found a fan-out (`find -exec find …` with no terminator) that ran
  PreToolUse past its timeout, which lets a call through: the reader now has a budget
  (`MAX_SEGMENTS`, 5000) and a command over it is denied ("split it"). One reader function,
  `readCommand`, gives every segment the dir it runs in (subshell scopes, `pushd`/`popd` stack,
  `builtin cd`, `env -C`), shared by the push check, deploys, role limits and the result guard.
  The closing rounds (compared with real bash and zsh) made it read a command substitution
  inside double quotes and in an unquoted heredoc body as commands, before the command around
  it, which keeps the substitution's text in its word; join backslash-newlines; read `$'…'`;
  take prefix options per prefix word (`sudo -n`, `time -p`, `env -S`, `sudo -D`); treat a
  job as a scope (a piped or backgrounded command or group runs in a subshell; where bash and
  zsh differ, the shell's dir after a `cd` there is unclear); stop at 64 nested subshells and
  4 nested readings (`eval eval …`) with `truncated`; and deny when the reader throws.
- Known limits: hooks and the model's Bash run as the same OS user, so a determined model can
  still forge goodboy's own state; the guards make it hard and visible, not impossible. Seen
  and not closed: a detached background process that creates a marker after its call ended;
  removing the session dir's snapshots with a glob the text check misses (the state is then
  not restored); a result forged by a script that builds the result path at run time or
  imports the CLI module; interpreter writes by a read-only role are recorded as edits, not
  denied; `push.followTags=true` in config is not read; a directory change goodboy cannot
  follow (`cd -`, a computed dir, a `popd` past what it saw, `env -C` with a computed dir, a
  `cd` that moves the shell in zsh but not in bash: the last pipeline element, a pipeline
  before the last of a list ending in `&`) makes a later push or deploy unclear rather than
  checked, so such commands need a literal `cd`; a script file a
  shell runs
  (`bash release.sh`) is not read; a result written into a dir named by a variable other than
  `$PWD` is not seen; nor is a write into a parent of the result dirs (`tar -x -C .claude`,
  `cp -r x/tests .claude/`, `rsync … .claude/`), since a plain copy into `.claude/` is normal
  work. A push, or a git word that may be an alias, run with config or repository
  from the environment (`GIT_CONFIG*`, `HOME`, `XDG_CONFIG_HOME`, `GIT_DIR`, `GIT_WORK_TREE`,
  `--config-env`, `--git-dir`, `-c include.*`) is unclear and denied; built-in commands pass,
  since git never lets an alias hide one. An indirect write is not recorded when `git status`
  takes longer than 12 s (3 s at Stop, skipped after 5 s there). The state guard can also undo a
  write goodboy's own hooks made during a long Bash call (a background agent's validation
  pass), which only makes a gate stricter. The shared reader also leaves these open (closing
  G1 round, all fail closed or rare): a function body is read as if it ran where it is
  defined; an unquoted heredoc body's substitutions are read after the line, so a `cd` later
  on that line moves them; `git -C "$(git rev-parse --show-toplevel)" push` is denied as
  unresolved; a substitution's output used as an argument of an interpreter or a writer counts
  as a write when its text names a result dir; `$(echo git) push` shows no push (the program
  is known only at run time); `>` inside `(( … ))` reads as a redirect (v0.30 behavior).
  goodboy's own git calls start no program from the repo's config (lib/hook-git.ts: no
  fsmonitor, signature check or transport, so no lazy fetch in a partial clone; the write
  sweep empties every filter driver), except a clean filter in the push check's work-tree hash
  (turning filters off would break the hash of an LFS repo) and config inside submodules; the
  post hook's auto-verify runs the project's own typecheck command, which the model can edit.
  These are the same class as the detached background process above. The shared reader reads a
  program name in lower case (case-insensitive APFS runs `GIT` as git; `cd`, `pushd` and `popd`
  keep their case) and git's dashed programs (`git-push`) as git. The commit issue
  rule also leaves these open (final G1 rounds; most fail closed): pins changed by a Bash call
  that fires no post hook (`exit N`) count until the next Stop puts them back; its setting comes from the
  shell's dir, not the repo `--git-dir`/`GIT_DIR` names; `commit.cleanup` and
  `core.commentChar` in config are not read; env exported earlier in the command
  (`export GIT_CONFIG_COUNT=…`) and external `git-<name>` programs are not seen; a script
  file a shell runs is not read; a heredoc that `cat` reads inside a substitution is taken as
  a message, so `echo "$(cat <<EOF … EOF)" | bash` is not read; more than 8 unknown git words in one
  command are denied (`git lfs` repeats are looked up once).
- Proposed for later (v0.32 or after, the user's call): a git `pre-push` hook that runs the
  same push check inside git, where shell spelling, aliases and env config cannot hide a
  push. The PreToolUse check stays as the early, explained denial.
- Spawn concurrency (3) counts the main session's calls; a lead's members count against its
  per-run cap (6).

- Libraries: `lib/routing-policy.ts` (one table of roles, models, efforts, tools, caps and
  review/test dispatch), `lib/outward-command.ts`, `lib/diff-coverage.ts`, the gate log
  extended with dispatch and completion records, and `lib/recursion-guard.ts` as a session
  budget.
- Contract tests use independent fixtures, not the policy table itself.
- New env (G1): `GOODBOY_SPAWN_GATE`, `GOODBOY_SPAWN_LIMIT`, `GOODBOY_SPAWN_LIMIT_LEAD`,
  `GOODBOY_SPAWN_LIMIT_SESSION`, `GOODBOY_SPAWN_CONCURRENCY`, `GOODBOY_ROUTING_GATE`,
  `GOODBOY_OUTWARD_GATE`, `GOODBOY_SKILL_GATE`, `GOODBOY_LOG_DIR`, `GOODBOY_EFFORT_ADVICE`,
  `GOODBOY_BASH_SEARCH_SMALL`, `GOODBOY_PUSH_TEST_GATE`, `GOODBOY_MARKER_GUARD`,
  `GOODBOY_RESULT_GUARD`, `GOODBOY_COMMIT_ISSUE`; G2:
  `GOODBOY_SKILL_EFFORT`, `GOODBOY_CODEX`, `GOODBOY_CODEX_MODEL`. Repo config lives under
  `.goodboy/`. Renames of existing names wait for D1.

### 10.11 Steps

Branch `feat/g-routing`. After each step: tests, typecheck, one all-axes review, one
`/verify` probe, README (Korean) updated, and the user's OK before the next step.

| Step | Contents |
|---|---|
| G0 | This plan; the measurements in §10.12 |
| G1 | Rules (§10.5–10.7, §10.10), tests first. The audit of existing reason- and count-based escapes comes last. Done 2026-10-14; the user added the push test check and the read-before-edit knowledge rules during the step. B3 note: skipping per-prompt text for short prompts was rejected, since a short prompt can be a new, vague task |
| G2 | Tool skills and the 24 agents together, since agents depend on the skills; the two renames; capability checks; leads enabled last. Done 2026-10-15: two review and two test rounds (sonnet, narrow), the capability check M19, and a /verify probe (the Stop test gate names goodboy:test-unit). Leads are written but not routed until their own check |
| G3 | Workflow skills: slimmed, renamed, effort set. Done 2026-10-15: the seven workflow skills are 35–50 lines, English (the menu description, the questions for the user and the rationale headings stay Korean), with `effort` from §10.4; `debug`, `refactor` and `migrate` became `diagnose-failure`, `refactor-code` and `prepare-migration`; the prompt hook registers the new names, and the skill rule still counts the old ones for sessions started before an upgrade. prepare-migration ends at a local dry run and hands the apply and rollback commands to the user (the old skill both ran the migration and said a person triggers it) |

### 10.12 Step-0 measurements

Measured 2026-10-14 on Claude Code 2.1.299 and codex-cli 0.162.1. Method: `claude -p` in a
scratch git repo with `--setting-sources project,local` (the installed goodboy off) and a
probe plugin whose hooks log every payload; main session on haiku, probe agents with and
without model/effort.

| # | Question | Result | Decision |
|---|---|---|---|
| M1 | Does a subagent without `effort` inherit the main session's effort? | Yes (`high` in, `high` in the agent). An agent's `effort: low` applies (`low` on its tool events) | the policy table sets effort on every agent |
| M2 | Does skill-frontmatter effort apply to the invoking turn and revert after it? | Yes. From the Skill call to the end of that turn, including tool calls after the skill's own steps; the next turn is back at the session value. Inside an agent, the skill's effort stays for the agent's remaining run | §10.5 holds; agents should call low-effort tool skills last or not at all |
| M3 | Can PreToolUse `updatedInput` on Agent set model or effort? | Yes. A hook rewrite to sonnet/low ran the agent on `claude-sonnet-5-5` at `low` | dispatch enforces the policy table instead of advising |
| M4 | Does hook input inside a subagent identify the agent? | Yes: `agent_id` and `agent_type` (`<plugin>:<agent>`, e.g. `goodboy:review-all`) on every tool event; `SubagentStart`/`SubagentStop` exist, the latter with `agent_transcript_path` | role limits are enforceable per agent |
| M5 | Which plugin-agent frontmatter keys apply? | `model` yes, `effort` yes, `tools` yes (no Write when not listed), `skills` preload yes. `Agent(…)` allowlist no: a lead with `Agent(probe-plain)` or `Agent(probe:probe-plain)` launched another agent. `permissionMode` no: `acceptEdits` on a plugin agent left Write denied in a `default` session | goodboy hooks enforce who may call whom; `permissionMode` is dropped from §10.3 |
| M6 | Is there a cap on concurrent agents? | Yes: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, default 20, error "Concurrent subagent limit reached … Do not retry". Depth default 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, may be changed remotely). `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` exists; default not found | goodboy keeps its own lower caps (§10.7) |
| M7 | Does ExitPlanMode return to bypassPermissions? | Not measurable headless: plan-mode tools are absent in `-p` | prepare-migration asks for approval in chat; plan mode is not used |
| M8 | Do subagents receive CLAUDE.md? | Yes (a project CLAUDE.md canary was answered without reading files) | follow-agent-rules does not repeat CLAUDE.md |
| M9 | Does `Skill(name)` in an agent's tools restrict which skills it can call? | No, with bare or namespaced names: the agent ran a skill not in the list | goodboy hooks enforce tool-skill access (PreToolUse on Skill with `agent_type`) |
| M10 | Can a Stop hook tell that background agents are still running? | Yes: Stop and SubagentStop carry `background_tasks` (`id`, `type`, `status`, `description`, `agent_type`) and `session_crons`. Agents run in the background unless the call sets `run_in_background: false`, and each background completion reaches the main session as a UserPromptSubmit whose prompt is a `<task-notification>` block | Stop defers the review/test gates while agents run; UserPromptSubmit treats task notifications as non-user prompts (no injection, no task registration, never "a new user request") |
| M11 | Does an effort change invalidate the prompt cache? | No: high → low on a resumed session read 48.5k cached tokens and wrote 2.6k; the turn before, low (left by a skill) → high, read 43.4k and wrote 2.6k. Both reused the whole cached prefix | effort advice has no cache cost |
| M12 | What does the hook payload hold for a typed `/plugin:skill …` command? | The raw text, e.g. `/probe:probe-b hello there` | the slash regex accepts `:` |
| M13 | Codex CLI | `codex login status` exits 0 ("Logged in using ChatGPT"). `codex review --uncommitted` (also `--base`, `--commit`) runs without prompts; a 5-line diff took 91 s and found the planted off-by-one as `[P1] … file:line`. Failures exit 1: the configured default model was rejected for a ChatGPT login (logged in `m13-default-model.err`), and once the model was "at capacity" (seen in the session; that log was overwritten by the successful run). No token count is printed | run-codex-review passes the model explicitly (`GOODBOY_CODEX_MODEL`), parses `[P0]`–`[P3]`, and records `skipped` with stderr on a non-zero exit; tokens are not tracked for Codex |
| M14 | Can a lead merge its members' results? | Only with foreground calls. With background calls (the default), the lead's turn ended after launching both members, their completions went to the main session, and no merge arrived. With `run_in_background: false` (m5) the lead got each result in its own turn and merged them | see M15 |
| M15 | Can a hook force a lead's member calls into the foreground, and do they still run in parallel? | Yes. A PreToolUse rewrite to `run_in_background: false` on Agent calls made by an agent: two calls in one message started 0.25 s apart, ran at the same time (about 3 s each), and the lead returned both results merged. A lead that pasted member hand-backs verbatim tripped the harness's frame-forgery flag | the delegation guard rewrites every agent-made Agent call to the foreground; lead definitions summarize member output, never paste it (G2) |
| M16 | Does a failed Agent call fire a hook? (measured during G1) | Yes: `PostToolUseFailure` with `tool_name`, `tool_input`, `tool_use_id`, `error` (e.g. "Agent type '…' not found"), `is_interrupt`, `duration_ms`; PostToolUse does not fire | a PostToolUseFailure hook records the call as done/blocked. Open: a call allowed by goodboy and denied by another hook leaves no record and counts as running for 30 min |
| M17 | How is a compaction seen? (measured during G1) | `/compact` on a resumed session fired `SessionStart` with `source: "compact"` and the same `session_id` (plus a SubagentStop for the summarizer) | SessionStart resets what read-before-edit counts as known; the Stop context-drop heuristic stays as a second signal |
| M18 | Which hook fires after a Bash command that fails? (measured during G1) | `echo hi; false` fired `PostToolUseFailure` (`error: "Exit code 1\nhi"`) and no PostToolUse; `exit 3` fired no post hook at all | the after-Bash sweeps also run from PostToolUseFailure; a Bash call with no post hook is caught by the open start note (markers) and the next Stop (gate state) |
| M19 | Capability check (G2, 2026-10-15): do the routed agents produce their artifact? | In a temp repo with `--plugin-dir` and a haiku main session, foreground calls: `review-all` wrote two valid review JSONs (all axes, `hallucination` marker). `test-unit` first wrote none: its red step edited `src/` in place, which its role limits deny (tests only). With write-regression-test running red in a `git archive <base>` copy and the mutation in a copy of the tree, it wrote a passing result with `by_type` (`unit`: 1 suite, 9 tests) and `coverage` measured, red failing on HEAD and the mutation caught | `review-all` and `test-unit` are routed (`CHECKED_ROLES`); red and mutation never touch the project |
| M20 | H0, 2026-10-15: what does SessionStart carry per source? | `startup` and `clear`: `cwd`, `session_id`, `source`, `transcript_path`. `resume` adds `context_tokens`, `estimated_cache_write_usd`, `prompt_cache_likely_expired`, `seconds_since_last_response`. `compact` adds `model` and `prompt_id` | SessionStart handles all four sources; the policy notice needs only `cwd` and `source` |
| M21 | Does a resumed or cleared session keep its session id? | `--resume` keeps it (the read log carries over, and so does the context); `/clear` starts a new id | resume needs no re-read; clear starts a fresh read log, so the gate asks for the reads again |
| M22 | How is a compaction seen? | `PreCompact` (`trigger: manual`, `custom_instructions`) then `SessionStart` `compact` with the same id | the read records reset on `compact` (G1), so the read gate requires the files again |

So the lead design in §10.3 and §10.7 stands: leads dispatch their own members, in parallel
and in the foreground, enforced by the PreToolUse rewrite. The fallbacks considered were
(a) a lead that only plans and merges while the main session dispatches, (b) leads polling
result files, and (c) no leads.

## 11. Exit criteria for v1.0

- No known high-severity issues; CI green on macOS and Linux.
- Core-decision mutation survival ≤ 1 of the 15 in the appendix.
- Gate-log over two weeks: at most one false block per gate per session (improvement-plan §2.3).
- Four weeks without a fix chain in one area (three or more consecutive fixes).
- One person other than the author installs, updates, and removes goodboy using only the docs.

## 12. Corrections to improvement-plan.md

- §2.2.4 state scoping must also cover repo-level state (cursors, retry counters), not only `agent_id`.
- §2.2.5 "PreToolUse warnings never reach the agent" was contradicted once on 2026-10-12
  (a subagent received rationale-gate guidance). Re-measure before relying on it; it affects the H2-03 default.

## 13. Assumptions

- Supported OS: macOS and Linux (the launcher is a sh script).
- 0.x allows state-file format changes; legacy files are ignored rather than migrated.
- Sizes are relative (S/M/L); there are no calendar estimates.

## 14. H — Project knowledge (v0.32.0)

Approved by the user on 2026-10-14 as a feature-freeze exception, like G. Reasons and the
user's decisions are in the framework-improvement backlog (items 1, 2, 3, 6, 8, 9). Branch
`feat/h-knowledge`, stacked on `feat/g-routing`: the precondition "G merged" became "G
committed" while the user is away (their instruction, 2026-10-14); G merges first.

### 14.1 Why

A session starts without the project's background (policies, past decisions), so the same
questions come back and the docs drift from the code. H makes the project's knowledge a
file every session reads first, splits every check into `ai` (evidence decides) and `human`
(the user decides), and keeps the key docs in step with the code they describe.

### 14.2 Project mode (H1)

- A directory is non-project only when its own `CLAUDE.md` has the line
  `goodboy: non-project` (trimmed, exact). Everything else is a project. Only the session's
  cwd counts: no inheritance, and `~/.claude/CLAUDE.md` is never read for this.
- The marker is written only with user evidence: the user typed `goodboy: non-project` in a
  prompt, or an AskUserQuestion answer in this session chose an option containing
  `non-project`. PreToolUse denies an Edit, Write or Bash redirect that adds it without that
  evidence, as early feedback; what holds is the session pin (H1 review: `cp`, interpreters,
  another letter case and symlinks wrote it anyway). SessionStart (startup, resume, clear;
  not compact) pins the cwd's mode, and a marker that appears during the session counts only
  with the evidence; removing it always counts; a symlinked CLAUDE.md says nothing. The
  evidence log is gate state that a model Bash call can only lose lines from (the state
  guard keeps only a `cli.ts skill-gap` note it adds to the skill evidence), and edit tools
  may not write any goodboy session state (a gap since G1: cursors could be written too).
  Known limits: a marker written in one session counts in the next; evidence the user gives
  while a model Bash call is open can be lost with that call's restore (stricter only).
- Non-project mode turns off the policy read gate, the docs rule and the test gate. The
  review gate stays (evidence and hallucination checks included), and so do R2, the spawn
  and recursion guards and write-bypass detection.
- The user's workspace `CLAUDE.md` gets the marker only with the user's OK.

### 14.3 Policy file, read gate and the knowledge skill (H2)

- `.goodboy/policy.md`, git-managed and committed in every repo: one `## <id> <title>`
  section per entry with `decide: ai|human`, `source:`, `date:` and `checked:` lines (and
  `evidence:` for an `ai` entry). Size budget: 200 lines; SessionStart warns above it.
- `.goodboy/docs.json`, the doc map: `{"docs": [{"path", "session_start", "covers": [globs]}]}`.
- SessionStart (all four sources, project mode): names the required files (policy.md and the
  `session_start` docs) and tells the model to Read them first; a missing policy.md asks the
  model to offer the skill's create mode once after the first task, never before it (I6, #13),
  with a Korean notice to the user.
- Read gate (PreToolUse, main session only; subagents get the policy in their prompt): until
  each required file has a full Read in this session, every other tool is denied with the
  unread files named. Evidence is the read log; partial reads count when their ranges cover
  the file. A Read is required again after a compaction and when the file changed since the
  read (not by this session's own edits). Always allowed: Read, the knowledge skill,
  AskUserQuestion, ToolSearch. The required files are exempt from the re-read gate. An
  unreadable file fails open with a warning. No model-side escape; `GOODBOY_POLICY_GATE=off`
  for the user.
- The skill `keep-project-knowledge` (§10.4 format, user-invocable too): create mode takes a
  directory with a git repo and source code as a project and asks only when that is unclear
  (I6, #13) (not one: write the marker; one: scan README,
  CLAUDE.md, docs, configs and git history, draft entries with sources and tags, ask once
  about the `human` and unknown items, write both files); update mode at task end applies the
  change, records the human decisions of the task and refreshes `checked`. Done when the files
  exist, every entry has source, date and tag, and docs.json marks policy.md session-start.
- Built in H2 (`lib/project-knowledge.ts`): the root is the nearest directory with
  policy.md from the cwd up, else the git top-level; a missing policy.md gets the
  create-mode notice only, not a block (every project would stop on upgrade otherwise). The
  read evidence is the read log, now with the line range of a partial Read; the newest read
  or own edit must be of the file as it is now (same mtime), after the last compaction.
  `build-docs` runs the skill (it gained Bash for `cli.ts knowledge-check`, and its write
  scope takes `.goodboy/docs.json`).

### 14.4 Decision authority (H3)

- Every check is `ai` (verified with evidence, passed without asking; each names its
  evidence) or `human` (the work stops: the main session asks once per gate, batched, in
  Korean; a subagent returns BLOCKED; a hook blocks until the user's marker). An unlisted
  check that evidence can decide is `ai`; otherwise, or when unsure, `human`. Neither has a
  written-reason escape.
- goodboy ships the generic defaults (`lib/decision-authority.ts`); policy.md adds project
  items. The hook-enforced `human` checks are the existing ones, and they hold only part of
  their category (H3 review): the outward-command gate denies changes to hosts
  `.goodboy/hosts` lists as production (other hosts get the R2 advice), the risk gate holds
  a goodboy workflow command whose prompt names `rm -rf`, `--force` or a migration, and dev-cycle's stage approvals are a
  skill's, not a hook's. Policy `human` entries reach the model through the
  SessionStart context and reviews (review-evidence, review-spec). Recorded human decisions
  become `ai` entries next time (update mode).
- Built in H3 (`lib/decision-authority.ts`): nine human defaults (the categories above) and
  seven ai defaults, each ai one naming its evidence and the hook that decides it. A policy
  entry is `ai` only when tagged so with an `evidence:` line; any other tag, or none, is
  `human`. Policy entries add to the defaults and never replace one. SessionStart (every
  source, project mode only, not tied to `GOODBOY_POLICY_GATE`) sends the rule, the defaults,
  the project's human entries (twelve named, the rest counted) and `cli.ts decisions`, the
  full list. An item the request, the user's answers or a policy entry already settles is
  not open. Reviews: check-evidence raises a human item settled without the user's decision
  as `high` for a project entry and `medium` for a default (a fuzzy default as `high` would
  hold reviews shut); check-spec-coverage raises unapproved scope as `medium` (was `low`);
  follow-agent-rules points R1 at the list. The done check and the decision list read entries
  with one parser, `parsePolicyEntries` (lib/project-knowledge.ts).

### 14.5 Doc map and docs rule (H4)

- docs.json lists CLAUDE.md, key docs, the policy file and the test catalog, each with the
  paths it covers and whether it is session-start.
- Stop rule (project mode): a changed file a doc covers, with that doc not changed in the
  task, blocks and names the doc. The skill's update mode either edits the doc or records in
  docs.json that it checked the doc against the change (`checked` with the time); a check
  recorded after the change passes. Changes the map cannot see go to review.
- `cli.ts test-catalog` generates `.goodboy/test-catalog.md` (feature → test type) from the
  test files. A missing CLAUDE.md gets one `/init` suggestion; CLAUDE.md has a size budget
  (300 lines, warned at SessionStart).
- `/done` (outside this repo, not under git) is changed only with the user's OK, after a
  backup: it would read docs.json and never attach-and-delete a mapped doc.
- Built in H4 (`lib/doc-map.ts`, `lib/test-catalog.ts`): the task is the edits since the
  review cursor, inside the knowledge root; the rule runs after the test gate and before the
  review gate (so the doc update is reviewed), with the user's Stop marker and
  `GOODBOY_DOCS_GATE=off` as the only ways past (an edit that drops or narrows a map entry
  is a change the review sees). The stop_hook_active path mirrors it (H4 review): while a doc
  is stale it accepts no review, so a plain second Stop cannot move the cursor past the
  change, and a doc fixed after the block goes on to the review gate, as a test accept does.
  Edits to the doc map or to another mapped doc, with or without covers, make no doc stale.
  A recorded `checked` (an ISO time with a zone) counts when it is at or after the change
  (from the start of its second, as `date -u` writes) and no later than this task's edit of
  docs.json, with no skew, so a time written ahead passes nothing. The test catalog is
  checked by regenerating it (its CLI write leaves no edit record), so it carries no date;
  when git cannot list the test files the CLI writes nothing and the rule fails open. Test
  types come from paths and imports (e2e, integration, ui, else unit). The /init suggestion
  is once per project per machine (`~/.claude/goodboy/logs/init-suggested.json`, startup
  only) and only when the session gets no CLAUDE.md at all (the cwd and its parents count);
  the size warning shows at startup and resume. Both are user-facing only. `/done` was not
  changed (the user's OK is pending).

### 14.6 Global rules without a global CLAUDE.md (H5)

- No shipped CLAUDE.md and no import line. Rules a hook enforces need no text; guidance no
  hook can check travels in goodboy's own injection (UserPromptSubmit already carries R1 and
  R2 for task prompts; SessionStart adds the project-knowledge lines).
- A proposal to the user lists the lines of `~/.claude/CLAUDE.md` that hooks now enforce; none
  is removed without their OK.
- Done in H5 (no code): what goodboy delivers without a global CLAUDE.md is already in place
  and pinned by tests: R1 (ask when unsure) for general task prompts, whose place goodboy's
  commands give to their required-inputs checklist, and R2 (no live systems) for both, in
  UserPromptSubmit's injection (tests/user-prompt-submit-g1.test.ts), the leaf rule in every
  goodboy agent's preloaded follow-agent-rules, and the delegation guard that denies the Agent
  tool to every subagent but a lead and `claude -p` to every subagent
  (tests/spawn-guard.test.ts), plus the H2–H4 SessionStart lines. The proposal (which lines
  of the user's own file these cover) went to the user in the track H report, not into this
  public repo; it holds only once a goodboy with track G is installed (v0.30.0 has neither
  guard).

### 14.7 Test tier advice (H6)

- `test-write` keeps a per-project test profile (per type: tests, duration, last measured) in
  `.claude/goodboy-test-profile.json` (local: machine-written on every run, so it is not
  committed next to the doc map).
- Advice only, at SessionStart and at most once a session, when the measured total crosses a
  threshold (tuned with data): ≤ ~10 min, run everything at task end; ≤ 1 h, unit and
  integration at commit, everything before push; > 1 h, affected tests before push, full E2E
  on release or request. Applying a tier setup is a `human` decision.
- Built in H6 (`lib/test-profile.ts`): the profile is `.claude/.goodboy-test-profile.json` at
  the knowledge root (a `.goodboy-*` name, so the push check's tree comparison leaves it out
  like goodboy's other files; the full suite caught the plain name changing the tree). Per type it
  keeps the run closest to a full one: a run with at least as many tests replaces the entry,
  a narrower run does not, unless the entry is 30 days old. No advice up to ten minutes (that
  is the default already); above it, SessionStart (project mode) gives the model the advice
  with the measured split and tells it the setup is the user's to decide, and gives the user a
  Korean line. Once a session: a flag in the session dir, so resume and compaction do not
  repeat it.

### 14.7a Lighter verification (H7)

Added on 2026-10-16 at the user's request ("the verification is too heavy, probably the
framework's or the skills' fault; improve them too"); they chose three of four proposals. The
gates are unchanged; what they ask for is sized:

- `cli.ts review-axes` also reports the changed lines (git, against HEAD, untracked files
  whole) and a `plan`: one review-all for every axis when the diff is at most 200 lines or has
  one axis, one per axis otherwise or when the size is unknown (`lib/review-scope.ts`). The
  Stop hook's "review required" message points at that plan instead of "one per axis".
- A delta review: when the only problem is files changed after their review, the Stop message
  says so and asks for one review-all with `mode: delta` and those files; review-all then
  reads the newest review that lists them and checks only its findings against the code now
  and the new hunks, on every dimension `review-axes` lists for those files (after a per-axis
  round the newest review holds one axis, and the gate's dimension and supersession checks need
  them all; H7 review). The high-finding message points at it too.
- Rounds: request-review runs a new full review only after a high; mediums are fixed and
  proven by a test, then a delta review; lows are deferred and start no round.
- Not chosen: limiting mutation probes to guard logic (test-unit keeps them for every
  behavior change).

### 14.8 Steps

| Step | Contents |
|---|---|
| H0 | This section; measurements M20–M22 (§10.12) |
| H1 | Project mode and the marker guard |
| H2 | policy.md, docs.json, the SessionStart notice, the read gate, the knowledge skill |
| H3 | Decision-authority defaults and their delivery |
| H4 | The docs rule, the test catalog, the CLAUDE.md checks |
| H5 | Hook-delivered guidance; the proposal for `~/.claude/CLAUDE.md` |
| H6 | The test profile and the tier advice |
| H7 | Lighter verification (§14.7a), added by the user on 2026-10-16 |

Each step: tests first, typecheck, one narrow review and one test record (at most two rounds;
§10.11's cost lesson; from 2026-10-16 a new round only after a high, the full suite once before
the commit), a /verify probe per new rule, README (Korean). Merge and push wait for the user.

## 15. I — Test automation (v0.33.0)

Asked by the user on 2026-10-16 ("I want 100% test automation through this framework") and
approved as designed the same day. Branch `feat/i-test-automation` from the local `main` (G
and H merged); one GitHub issue per step, named in its commits (#1 I0 … #6 I5; #7 I1b, added the same day).

### 15.1 What "100%" means

Four guarantees, each enforced by a gate on evidence (the user chose all four):

1. Changed lines: every changed code line runs in a test of the recorded tree.
2. Acceptance criteria: every criterion (dev-cycle documents, the policy file, the task's
   stated goals) has a test that would fail if it broke.
3. Test types: the types a change needs are all there: unit for code; integration for
   boundaries (server, database, CLI, file or network IO); ui or e2e for UI changes.
4. Regression: a full suite (or, past the one-hour tier, the affected tests) passed on the
   pushed tree before a push.

Not testable, so outside "100%": decisions that are the user's (§14.4: wording, UX choices),
and live external systems (R2: only sandboxes and fakes).

### 15.2 Measurements (I0)

| # | What | Result |
|---|---|---|
| M23 | bun coverage into goodboy's diff coverage | `bun test --coverage --coverage-reporter=lcov --coverage-dir=<dir>` writes an lcov file that `cli.ts diff-coverage` reads: per file, the changed lines that ran |
| M24 | code run in a child process | absent from bun's report: goodboy's hooks run through `Bun.spawn` in their tests, so their changed lines are not measured at all |
| M25 | changed files missing from a report | `diffCoverage` skips them silently (counted nowhere, listed nowhere); I1 must count a changed code file the report lacks as not covered |
| M26 | tools on this machine | python3 without pytest or coverage, no go, openjdk 21, node; diff coverage reads lcov, Cobertura, JaCoCo and Go reports |

Consequences for the design:
- I1 counts a changed code file absent from the report as uncovered, and says why (a child
  process, a file no test loads). Projects whose tests run code in child processes need
  either in-process tests or a recorded human exemption for those files (goodboy itself is
  one: its hook tests spawn the hooks).
- A project with no coverage tool records a `blocked` result with the evidence; enabling a
  tool, or an exemption, is the user's decision.
- E2E is detected by its config (`playwright.config.*`, `cypress.config.*`) or dependency
  (`@playwright/test`, `cypress`); without a runner or a browser the result is `blocked` with
  the evidence, for the user.

### 15.2a Built in I1 (#2)

- `lib/changed-coverage.ts`: the layer-1 gate's last check, after the acceptance criteria.
  Every changed code file of the task (the test cursor's edits that need tests) must have all
  its changed lines run in a record the other layer-1 checks accepted, made after its last
  edit, that tests it (an older record's coverage would describe an older file; security
  review); several such records: the best run counts. A file with added lines that the
  report lacks counts as not run (M24/M25): diff coverage now lists the changed files a
  report has (`in_report`) and every file the diff has with its added lines (`diff_lines`),
  so a file whose changed lines are all non-executable is no gap, nor one with only removals.
  An edited file the diff does not have must equal the base blob, hashed as git stores it
  (line-ending attributes apply, filter drivers off): an undone edit. Git can hide a file
  (ignore rules, assume-unchanged, a nested repo), and both libraries run git with
  `--no-replace-objects` and no graft file. Only existing code a coverage tool measures
  needs its lines run (not `package.json`, YAML, SQL…, nor a deleted file), and a JS/TS file
  only when it has runtime code: types-only imports trimmed, a types-only file transpiles to
  nothing but `export {}`; a `.d.ts` is a declaration file and never measured (code hidden in
  one that a test imports by its full name is a known limit). A change with nothing to
  measure passes.
- Report paths are matched against every repo file, not only the changed ones (security
  review): an absolute path only inside the repo; a Go module path through its go.mod's
  `module` line; a path that exists but is no file the repo lists (`node_modules/…`) is not
  ours; else, by base name, the repo file that ends with the report path (a Cobertura
  `pkg/app.py` is `src/pkg/app.py`, not a root `app.py`); a tie matches nothing. A report
  path longer than the repo file never matches it (round 6: a Go `-coverpkg=all` dependency's
  `github.com/pkg/errors/errors.go`, or `../shared/index.ts`, credited the root file). A
  report path outside the repo (tests run in a container, `/app/src/a.ts`) matches nothing,
  and the gate says so. A pure rename is in the diff with no added line; the diff detects
  renames but not copies, whatever `diff.renames` says.
- Moved and copied files: the after-Bash sweep now also runs for `mv`, `cp`, `ln`,
  `install`, `rsync`, `patch`, `tar`, `unzip` and the git commands that put files in place
  (`checkout`, `restore`, `apply`, `mv`…). `mv`, `cp -p` and an interpreter's rename keep the
  mtime, so a file counts by mtime or ctime; a directory moved into place keeps its files'
  times, so PreToolUse snapshots git's status for such a command and the post hook records
  every path new in it (only when both are of the same repo: after `cd <other repo>` its
  uncommitted files are not the call's writes, round 6). The sweep covers both the repo the
  call started in and the one its shell ended in (`cd <elsewhere> && mv x <start repo>/…`,
  round 7). Only the start repo has a snapshot, so a directory moved into another repo the
  shell cds to is not seen; a file moved there counts by ctime only when the shell ended in
  that repo, and the named targets count only inside the start repo, so a file moved into
  another repo by an absolute path, with no `cd`, is not seen either. A call that starts
  outside any repo sweeps no repo it did not end in (known
  limits; Claude Code puts the shell back into the project after a call that leaves it,
  seen on 2026-10-16, so a call starts in the project). The targets the command names count too,
  read from the start cwd (security review: a move
  after a record put unrun code in a file no edit recorded; the review gate missed it too).
- Paths: the repo top in the cwd's own spelling (`--show-cdup`), so a symlinked cwd is still
  checked; a file name that starts with `..` is inside the repo.
- The base: diff coverage records the object it diffed against (`base`). SessionStart pins
  the HEAD the session started from (kept on resume); a record whose base is after it would
  hide committed changes, so it does not count, and the gate prints the right `--base`. A
  session that started with no commit, or outside a repo, pins null: only `--base empty`
  (the empty tree) counts. A repo whose top differs from the pinned one (made during the
  session, a linked worktree) keeps the pinned HEAD only when that commit is in it, and no
  exemptions (their globs meant other paths).
- Exemptions: `coverage-exempt: <glob>, …` lines of `decide: human` policy entries only (the
  policy parser now takes keys with a hyphen; commas inside braces stay in the glob). An `ai`
  entry exempts nothing. They are the user's, so the model cannot write its own (security
  review): SessionStart pins them, and a glob added during a session counts from the next one
  (like the project mode, §14.2), whatever wrote it (`cp`, an interpreter). The state guard
  restores the pin after a Bash call, like the other session pins. PreToolUse also denies an
  Edit/Write that adds one to any `.goodboy/policy.md` (any letter case of the path), as an
  early explanation; the gate counts only a policy file inside the repo. A same-user limit
  stays: a glob the model wrote in one session counts in the next.
- No changed-line coverage in the result: blocked, with the way out (measure it; or, with no
  tool, a `blocked` result with the evidence, which ends the turn as unverified).
- `GOODBOY_DIFF_COVERAGE=on` (default) | `warn` (a Korean line to the user) | `off`. The test
  suite runs with it off (tests/setup.ts), like the skill and commit-issue rules; the I1
  tests turn it on.
- measure-coverage and test-unit say the rule; the record keeps diff coverage whole (`files`,
  `in_report`, `diff_lines`, `base`; test-write checks their shape when present); the gate
  counts a record without one of them as not measured.
- goodboy itself: its hook tests spawn the hooks, so with the rule on its own hook files
  need in-process tests or the user's exemption (a decision for when a version with I1 is
  installed).
- Deferred (low findings of the round-6 and round-7 reviews):
  - Programs whose writes the sweep does not see: shell scripts (`bash x.sh`, `./x.sh`),
    build and fix tools (`npm run`, `make`, `prettier --write`, `eslint --fix`), downloads
    and clones (`curl -o`, `git clone`, `git worktree add`), `gtar`, `bsdtar`, `gmv`.
  - `ditto` is missing from the list of placing programs above.
  - `differFromBase` fails as a whole batch (one directory or unreadable path makes every
    file in it hidden), and a name starting with `:` is read as pathspec magic.
  - `git reset --soft HEAD~1` records committed, tested files as edits again.
  - Report paths `src/./a.ts`, and a different letter case on macOS, match nothing. Since
    round 6 these forms match nothing either (fail-closed, never another file): a
    `../shared/…` path of a sibling package, Kotlin sources whose package differs from their
    dir, Go without a go.mod, a path with an extra root prefix.
  - The repo tops are compared as strings: a cwd spelled through a symlink in one hook and
    not the other records the same file under both spellings (`recordEdit` resolves the
    path, it does not follow links). A `cd` inside the same repo runs `git status` twice.
  - An unstaged `mv` counts every line of the file; a staged rename counts none.
  - `changedFilesSince` is unused in production; `matchFile` is quadratic for huge reports,
    and its scoring loop and the `copy to` branch of `changedLines` are dead since round 6;
    the git helpers and the empty-tree lookup are duplicated.
  - Older: files under `build/`, `dist/` and similar dirs never reach the edit scope.

### 15.3 Steps

| Step | Issue | Contents |
|---|---|---|
| I0 | #1 | This section; measurements M23–M26 |
| I1 | #2 | Changed lines run in tests: diff coverage from a warning to a rule. Done: bcbabc1 |
| I1b | #7 | Bounded verification for document changes: guidance (§15.4) |
| I2 | #3 | Every acceptance criterion has a test; a document check never satisfies a product criterion (§15.4) |
| I3 | #4 | Test types complete per change kind; several types go to test-lead. Also the change classifier and the review dimensions per change (§15.4). Done: I3a 6b26102, I3b (§15.6) |
| I4 | #5 | Full regression on the pushed tree before a push (§15.7) |
| I5 | #6 | Existing tests that cover the change run with it; weakening a test is a finding (§15.8) |
| I6 | #13 | Fixes from the first real-use trial (§15.9) |
| I7 | #14 | Fixes from the second real-use trial (§15.10) |
| I8 | #15 | Fixes from the third real-use trial (§15.11) |

Each step: tests first, the §14.7a review sizing, a /verify probe per new rule, README
(Korean), and `/done #<issue>` (GitHub mode) to close it. Merge and push wait for the user.

### 15.4 Document changes (field report, 2026-10-16)

A field report (a handoff from another session, discussed with Codex in two rounds against
v0.30.0): a dev-cycle requirements task changed only documents (the requirements file, its
static HTML/CSS preview, the cycle and backlog files). Each of about five edit rounds
re-armed full test and review runs; test subagents took 12 to 105 minutes, reviews 5 to 10.
The subagents built mutation harnesses for prose and swept print and render matrices; the
main session fixed nonblocking findings, which started new rounds, and edited before the
user's answers were in.

Checked against the current source (not v0.30.0):
- The agents are now `test-unit` and `review-all`.
- Since G1, `needsTestCoverage` uses `isDocPath`: everything under `docs/` needs no test, so
  the preview's red/green demand is gone already. The other side is a gap: code and
  dev-cycle prototypes under `docs/` need no test either.
- H7 already sizes reviews (one review up to 200 changed lines), asks for delta reviews and
  defers lows. Missing: guidance for document work, budgets, deferring mediums on documents,
  review dimensions per change, one reviewer for a document change, and one doc rule (three
  disagree today: `isDocFile`, `isDocPath`, a copy of the regex in the reasoning gate).

Decided by the user (2026-10-16), all three as recommended:
- Into track I: the guidance as I1b (#7) right after I1; the classifier and the review
  dimensions into I3 (#4); the product-criterion rule into I2: a product criterion
  (`PT-*`, `UIUX-*`) is met only by a test of the product code, never by a check of the
  requirements document.
- Static previews: `docs/versions/*/preview/**` by default, other paths as `decide: human`
  entries in `.goodboy/policy.md`, pinned at session start like `coverage-exempt`. Not the
  proposed `.claude/goodboy.json`: goodboy's project settings live in `.goodboy/`, and the
  pin already stops a session from lowering its own checks.
- No `document-check` evidence kind for now: documents need no test record, so nothing has to
  be manufactured; their evidence is the review (plan-completeness, hallucination).

I1b (#7), guidance only:
- A document change, until I3's classifier: every changed file is a document
  (`isDocumentFile`): a doc by `isDocPath` that is prose (`.md`, `.txt`, `.rst`, `.adoc`), or
  a static asset under a docs dir (`.html`, `.css`, images, `.pdf`), outside any `prototype`
  dir, whose review needs no dimension beyond plan-completeness and ui-ux-accessibility. Not
  a document: code under a docs dir, MDX, `requirements.txt` (dependency-risk),
  `CMakeLists.txt` (the I1b review). The effort advice uses the same rule. Its budget: one
  review of at most 10 minutes, presentation checks included; no test run (documents need
  none). A mixed change gets no document budget. 10 minutes is a first value: the field
  report's document reviews took 5 to 10 minutes each, and the I1b probe's whole session
  about 40 seconds. A large rewrite may need more; the reviewer then lists what it did not
  verify. J3's duration records will tune the value, or scale it by size.
- `agents/test-unit.md`, `agents/review-all.md` and the Stop-hook messages, for a document
  change:
  - verify the delta and what it affects;
  - run the existing relevant checks, and check changed claims against their sources;
  - check presentation only where it changed (print only when pagination may change);
  - build no new harness or mutation sweep;
  - stop at the budget and list what was not verified;
  - use one combined document review;
  - report nonblocking medium and low findings and defer them to the next planned edit.
- The Stop message shows the computed files, the change class and its budget first. A budget
  is a limit, never a pass criterion.
- The pre-edit guidance (B2, `lib/required-inputs.ts`): collect the user's open decisions in
  one question before the first edit; record unanswered ones as assumptions.
- Built: `lib/doc-verification.ts` (the class, the budget, the note; the effort advice uses
  the same rule) appended to both "run a review" messages of the review gate;
  `agents/review-all.md` (a "Document changes" section, triggered by the note in its prompt),
  `agents/test-unit.md` (documents need no test), `skills/request-review` steps 4 and 6 (the
  main session puts the note in the review prompt, since a subagent never sees the gate's
  message; a document change's mediums wait for the next planned edit), the B2 line, README.
  Tests: `tests/i1b-doc-guidance.test.ts`. Live probe: a docs-only session ended in 41 s with
  one review and no test run, and the note reached the transcript.

I3 (#4) additions:
- `lib/verification-scope.ts::classifyVerificationScope()` sorts each file into document,
  static preview or code, from the resolved repo-relative path, the artifact's role and its
  content. It becomes the one doc rule for every call site of the three rules: the test gate
  (`needsTestCoverage`), the skill rule (`hooks/pre-tool-use.ts`), the effort advice and the
  I1b note (`lib/doc-verification.ts`), the docs role's write limit (`lib/role-limits.ts`)
  and the reasoning gate's copy. The review dimensions (`requiredDimensionsFor`, which
  classifies with its own helpers today) start using it too. Today's `DOC_DIR` matches a
  `docs/` or `doc/` directory at any depth; the classifier decides by the artifact, not the
  folder name alone.
- A static preview is `.html`/`.css` only, with no `prototype` path component. Its HTML is
  parsed (Bun's HTMLRewriter), not grepped: no scripts, inline handlers, `javascript:` URLs,
  embedded executable documents or template directives. Its stylesheets and imports stay
  within the declared assets. Anything else is code; code and prototypes under `docs/` need
  tests again.
- Review dimensions:

  | Change | Dimensions |
  |---|---|
  | Requirements Markdown only | plan-completeness |
  | Markdown and preview content | plan-completeness, ui-ux-accessibility (the changed content, not a viewport sweep) |
  | Preview HTML only | ui-ux-accessibility, plus plan-completeness when the changed content states requirements |
  | Preview CSS only | ui-ux-accessibility |
  | Generic Markdown wording | none |

  One reviewer covers them all plus hallucination. The freshness checks and
  `currentFindings()` stay.
- Mixed changes keep the code requirements for their code part. Diff size can raise
  scrutiny, never prove a change harmless.

Proposed, not scheduled: delta scoping for documents. It would keep immutable baseline
snapshots with file and dependency hashes, have the plugin compute the delta, and fall back
to full document scope on a missing baseline, unknown dependencies or a policy change.

Not prevented: a business decision or a database-derived number cannot be proved without an
authoritative input; semantic dependencies between prose sections are not all found; an
agent can still over-investigate, edit before the answers arrive, or keep fixing optional
findings. Budgets and check lists make that visible but do not stop it.

### 15.5 Built in I2 (#3)

Every acceptance criterion a session works on has a test (`lib/session-criteria.ts`):
- The criteria:
  - the dev-cycle UIUX and prototype criteria, as before;
  - `REQ-<rank>`: the rows of the version's `REQUIREMENTS.md` that were in progress at the
    start (by their start rank and title, whatever the file says now), the rows in progress
    now, and the rows implemented now that were not at the start (matched by rank and title
    as a multiset: one start row excuses one current row). A row implemented before the
    session was tested then; breaking it later is for I4 and I5;
  - `POL-<id>`: `.goodboy/policy.md` entries whose optional `test:` line is new or changed.
- The tables: the first table under every `## 요구사항…` or `## Requirements…` heading (an
  added section never hides the real one), fenced code skipped; rank, requirement and status
  columns found by their header names; ranks like `1`, `1.`, `P1`, `#3`; escaped or
  backticked `|` kept in a cell; statuses in Korean or English, with decorations
  (`🚧 구현중`, `구현완료 ✅`, `진행중 (50%)`).
- "The start": SessionStart pins the rows and the `test:` lines of the working tree
  (`criteria-pin.json`; a resumed session keeps its pin), so an uncommitted row done in an
  earlier session is not asked again, and a commit made during the session hides nothing.
  Every Stop remembers what it required (`criteria-seen.json`). Both files are state-guarded:
  put back after a Bash call that changed them, and removed when a call created them. A
  created file is told by name, against the snapshot's list of every guarded name, not by
  mtime, which a call can set back; this also covers the cursors, the evidence logs and the
  coverage and project-mode pins (I2 security review round 3). They are read only as regular
  files, never through a link, and written by a rename; a seen entry is rebuilt from its
  string fields (ids of at most 6 rank digits or 40 policy characters, at most 1000 entries).
  Editing the documents never drops a criterion: setting a row back, renaming or deleting it,
  changing a heading or the version, removing the file or a `test:` line (I2 security review,
  two highs). With no pin, only the rows in progress now count, and no policy entry.
- A requirements or policy file that cannot be read (a FIFO, a directory, too large) blocks
  with the reason instead of counting as no criteria. Every dev-cycle document (`docs/CYCLE.md`,
  UIUX.md, the prototype, the requirements, the policy) is read through one descriptor opened
  without waiting on a FIFO, only when regular and at most 2 MB: a FIFO or a link to
  `/dev/zero` hung every Stop. An unreadable UIUX.md or prototype is the F2 `unreadable`
  warning, naming the file. The tables are parsed in linear time (the columns are found once
  per table: a crafted header made a 0.44 MB file take 24 s).
- Known limits (I2 review lows, deferred): the pin is ignored when the repo top changes (a
  `git init` in a subdirectory); no warning when there is no pin; a `test:` line added and
  removed between two Stops leaves no criterion; heading or header variants outside the
  template give zero rows without a warning; the product-evidence check reads path strings
  (a named test, a nonexistent `mutation.file`); a Bash call whose PreToolUse comes while a
  Stop runs removes the `criteria-seen.json` (or cursor) that Stop first writes, as created,
  as the mtime rule did; an unreadable UIUX.md or prototype warns (F2), it does not block;
  UIUX and prototype criteria are not pinned, so editing those documents can still drop them.
- Older than I2, found by its round-4 security review, left to a separate issue (#12, the
  track G state guard): the session files besides the cursors, evidence logs and pins are outside the
  name-based removal and the regular-file reads (`turn.txt` is not guarded at all; a
  directory at `edits.jsonl` before the first edit; a FIFO at a file a hook reads hangs every
  Stop); a Stop restores the snapshot of a Bash call that is still running (a background
  subagent's), so what that call writes afterwards stays; the guard trusts the snapshot index
  kept in the same session dir.
- The gate blocks on an uncovered criterion and lists up to 20: the gate's list is the
  session's. `acceptance-list` shows the dev-cycle criteria and the rows in progress now, as
  advice.
- A product criterion (`PT-*`, `UIUX-*`, `REQ-*`) is never met by a document: a document by
  the I1b rule (`isDocumentFile`) or a dev-cycle artifact (`docs/CYCLE.md`, anything under
  `docs/versions/`, the prototype included). Code under a `docs/` folder and MDX are product
  code. Its `test` may not be one, and a `PT-*` or `UIUX-*` mutation names the file it broke
  as a repo-relative path (`mutation.file`, required by `test-write`; a scratch copy's path
  is refused), which may not be one either. Symlinks are resolved. A check of the
  requirements or the prototype proves the document, not the product.
- The task's stated goals stay self-numbered `AC-n` under the existing rule (at least one
  entry, each with red and green). Nothing extracts them from the prompt; that is a known
  limit.
- Docs: `skills/record-tests`, `skills/check-spec-coverage`, `skills/keep-project-knowledge`
  (the `test:` line), README. Tests: `tests/i2-acceptance.test.ts`.

### 15.6 I3 (#4) design

Two commits under #4: I3a (the classifier and the review dimensions, §15.4) and I3b (the test
types). The user chose on 2026-10-17: boundary code is found by path and by content, broadly,
with the user's exemption for false positives; every code file needs a test of any type, and
the types below come on top.

I3a: one classifier, `lib/verification-scope.ts`.
- `classifyPath(rel)`: `document`, `preview` or `code` from the repo-relative path (`/`
  separators, letter case ignored for dirs and extensions):
  - `document`: prose (`.md`, `.markdown`, `.txt`, `.rst`, `.adoc`, `.asciidoc`) anywhere;
    images, PDFs, video and diagram sources (`.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`,
    `.avif`, `.bmp`, `.ico`, `.tif(f)`, `.pdf`, `.mp4`, `.webm`, `.drawio`, `.excalidraw`, `.mmd`,
    `.puml`) under a `docs/` or `doc/` dir; the doc map `.goodboy/docs.json`. Never a document: a path with a `prototype`
    component, a dependency or build file (`requirements*.txt`, `constraints*.txt`,
    `CMakeLists.txt`), MDX.
  - `preview`: `.html`, `.htm` or `.css` under `docs/versions/<v>/preview/` or a pinned
    `static-preview:` glob, with no `prototype` component.
  - `code`: everything else, code and prototypes under `docs/` included.
- `classifyFile(abs, root, globs)`: the path class, and a `preview` only when its content is
  static (read through `lib/safe-read.ts`; unreadable or over the cap is `code`). HTML is parsed
  with Bun's HTMLRewriter: no `script`, `iframe`, `frame`, `object`, `embed`, `portal` or `base`
  element, no `on*` attribute, no template directive (`{{`, `{%`, `<%`, or `v-`, `x-`, `ng-`,
  `hx-`, `:` and `@` attributes), no `javascript:` or `vbscript:` URL (also in SVG animation
  `values`/`to`/`from`/`by`) and `data:` only for images. Attribute values are decoded first
  (numeric and named character references; an unknown named one fails the URL). A link
  (`a`/`area` `href`, `ping`) may point anywhere but never at a script URL; every other
  `href`, `src`, `srcset`, `action` and CSS `url()`, `image-set()` string and `@import` is
  relative and resolves inside the preview's `preview/` dir (or its glob's base). Element and
  attribute names count by their local part (`svg:script`, `x:href`), and a DTD entity
  declaration is code.
- CSS (files, `<style>` text decoded like an SVG's, `style` attributes) does not emulate the
  CSS tokenizer: two review rounds found escapes, comments and strings read differently from a
  browser each time. It fails closed instead: any backslash escape is code; `expression(`,
  `behavior`, `-moz-binding`, `javascript:`, `vbscript:` anywhere are code; comments are not
  removed, so a commented-out remote URL counts too; after every `url(`, `src(`, `image-set(`
  and `@import`, each quoted string and a bare `url(` argument within 1024 characters is checked as
  a resource URL, and a quoted URL that does not close there (other than a data image) is code.
  More than 2000 references is code. That keeps a Stop fast: the round-1 regexes took 5.3 s on
  120 KB and the round-2 scan 15.8 s on 450 KB, against the 15 s Stop timeout that skips every
  gate.
- Also code: a document or preview that is a hard link (it shares its content with another
  path), an SVG document with active content (checked like preview HTML, without the locality
  rule; one over 2 MB too), and a test-named file that is a hard link or a symlink into code.
  Each Stop classifies a file once until it changes (memo by path and file identity).
- Known limits (I3a review lows, accepted): CSS escapes in a static preview (`content:
  "\201C"`) make it code; any string near a reference that names a remote URL does too; so
  does CSS with a character whose lower case is longer (`İ`, U+0130: the closing review found
  it shifted every window past its URL). CSS 4 `src()` counts as a reference.
- `static-preview: <glob>, …` lines of `decide: human` policy entries: the user's, pinned at
  every session start next to the coverage exemptions (`coverage-pin.json`, now written
  whatever `GOODBOY_DIFF_COVERAGE` is), counted from the next session when added during one;
  PreToolUse denies an Edit/Write that adds one. The globs match repo-top-relative paths, like
  the coverage exemptions.
- The call sites: the test gate (`needsTestCoverage`: only `code` needs tests), the I1b note
  and the effort advice (every file `document` or `preview`, content read), the skill rule and
  the reasoning gate's exemption, the docs role's write limit, `requiredDimensionsFor`, and
  I2's product-evidence check (`isProductDoc`), the last four by path. Known limit: the
  path-only sites do not know the user's glob previews, so such a file is code there (more
  dimensions and the skill rule, never less checking).
- Deferred (I3a review lows): the "realpath, else the nearest existing parent" helper exists
  four times (`review-scope`, `session-criteria`, `file-tracker`, `verification-scope`).
- Review dimensions of documents and previews (code keeps its rules):

  | File | Dimensions |
  |---|---|
  | Requirements Markdown: `.md` under `docs/versions/`, `REQUIREMENTS*.md`, `BACKLOG*.md`, `docs/CYCLE.md` | plan-completeness |
  | Preview HTML | ui-ux-accessibility, plan-completeness (a preview states requirements; checking that is cheap when it does not) |
  | Preview CSS | ui-ux-accessibility |
  | Other documents | none |

  A change's dimensions are the union of its files'.

I3b: the test types.
- Every changed `code` file needs a test, as today (`tested_files`, I1's changed lines). On
  top, per file:
  - `integration` (an `integration` or `e2e` suite) for boundary code: a path token of a
    server, route, API, handler, database, SQL, migration, shell, exec, spawn or CLI (`cli`,
    `bin/`), or content that imports or calls file, network, database or process IO (JS/TS:
    `fs`, `child_process`, `net`, `http`, `https`, `http2`, `dgram`, `tls`, `fetch(`,
    `axios`, `undici`, `ws`, database clients, `Bun.spawn`, `Bun.serve`, `Bun.file`,
    `Bun.write`, `bun:sqlite`, `process.argv`; Python: `subprocess`, `socket`, `requests`,
    `httpx`, `sqlite3`, `open(`; Go: `os/exec`, `net/http`, `database/sql`, `os.Open`);
  - `ui` (a `ui` or `e2e` suite) for UI code: `.jsx`, `.tsx`, `.vue`, `.svelte`, `.html`,
    `.css`, `.scss`, `.sass`, `.less`, and `client` paths (the review rule's `isFrontendFile`).
- A type is met by a passing record, made after the file's last edit, that lists the file in
  `tested_files` and has a suite of that type (`suites[].type`, required since G2). The suite
  type is the test agent's label; the reviewer checks it against the test files.
- The block names each file with its missing types. A change that needs more than one type
  goes to test-lead (its members: test-unit, test-ui, test-spec); the gate messages name it.
- No runner or browser for a type: the agent records `blocked` with the evidence (the turn ends
  unverified, as today); adding the tool is the user's decision.
- `test-type-exempt: <glob>, …` lines of `decide: human` entries: for the matching files any
  test type is enough. Pinned and guarded like `coverage-exempt`.
- `GOODBOY_TEST_TYPES=on` (default) | `warn` (a Korean line to the user) | `off`; off in the
  test suite (tests/setup.ts), like the changed-line rule.
- Built (I3b, `lib/test-types.ts`; the Stop's layer-1 decision, after the criteria and before
  the changed lines):
  - Path words are split at `/`, `.`, `_`, `-` and camelCase (acronyms too: `HTTPServer`),
    the extension included (`userRoutes.ts`, `schema.sql`); plurals, `router`, `endpoint`,
    `controller`, `middleware`, `db`, `http` and `socket` count too, and so do shell scripts.
    Content is read for JS/TS (imports by module, IO names imported from `bun`, calls in code
    without comments and literals), Python (`import a, b` lists too) and Go; other languages by
    path only. A types-only import does no IO: the nearest `import`/`export` before its `from`
    starts a statement, says `type`, and no `;` or quote lies between (2000 characters back at
    most). More than 5000 module specifiers, a source that is not a regular file or one over
    2 MB is boundary code (fails closed); a deleted one needs nothing. A `client` path is UI
    unless the file is boundary code (`src/db/client.ts`).
  - A type may come from any record that meets it, not only the newest per file: a test-lead
    run leaves one record per member. A record the other checks did not already accept counts
    only when it stands alone (no failing suite, its test files exist, its evidence holds, no
    do-nothing pattern).
  - The tester: test-lead when the change needs `ui` and another type (unit or integration),
    test-ui for UI only, else test-unit (it writes unit and integration tests, so a
    unit-plus-integration change needs no lead); for a type gap, by what is missing. A gate
    names test-ui or test-lead only once its capability check passed (`CHECKED_ROLES`, §10.3,
    review medium); until then it names test-unit with the types. Follow-up: the capability
    checks of test-ui (needs a browser) and test-lead. The no-record block names the types per
    file.
  - `test-type-exempt` joins the user globs: pinned in `coverage-pin.json` with the others,
    and PreToolUse denies adding one while the rule is on.
  - The agents: test-unit labels a suite `integration` only when it runs the real boundary;
    record-tests says the gate counts types per file; the reviewer's hallucination pass checks
    suite labels against the test files.

### 15.7 I4 (#5): full regression before a push

The push test check (track G, `lib/push-test.ts`) already needs a passing layer-1 result for
the exact tree handed off. That result proves the change's own tests; I4 adds the rest of the
suite (§15.1, guarantee 4).

- `cli.ts regression` (`lib/regression.ts`): goodboy, not the agent, picks the project's whole
  test command from the repo top, runs it, times it and records it with the tree it ran on:
  - commands, every ecosystem found: package.json `scripts.test:all`, else `scripts.test`
    (npm's exact "no test specified" placeholder is none), run by the lockfile's package
    manager (bun, pnpm, yarn, else npm), then a `test:e2e`, `e2e` or `test-e2e` script; pytest
    (`pytest.ini`, `conftest.py`, `tox.ini`, `[tool.pytest` in pyproject.toml); `go test ./...`;
    `cargo test`; a Makefile `test` target only when nothing else is found. All commands run,
    through `sh -c`, each with its exit code, the program it resolved to on PATH (evidence), its
    time to exit, and the last 6000 characters of stdout and 2000 of stderr. After a command
    exits its pipes are read 2 s longer, so a background child neither holds the run nor
    stretches its time; a command still running at `--timeout-min` (default 180, at most a
    day) is killed and
    fails (124). None found: the CLI says so, nothing is recorded, and the agent records a
    `blocked` result for the user.
  - the record (`.claude/tests/regression/<ts>.json` under the CLI's cwd, like `test-write`;
    the newest 20 kept; outside the layer-1 records the Stop reads): HEAD and the working tree
    hash when the run started (`workTreeState`), the tree when it ended, the source, the runs,
    the total time, the verdict. A run that changed the working tree fails and lists the
    changed files: it proves neither tree (review: a file present only during the run).
  - Only test agents run it: the result guard counts it with `test-write`, and so does a
    command with a JS runtime that names `writeRegressionRecord` or `lib/regression` anywhere
    (a variable, a heredoc). The agent passes nothing but the call (a timeout
    can only make a run fail).
- The push check: after the layer-1 check passes for a hand-off, each revision's tree needs a
  passing regression record of that tree (every run exited 0, the tree unchanged at the end),
  read from the session's cwd only (review high: a forged record in another worktree passed a
  `git -C <worktree> push`). Otherwise the hand-off is denied with what to run, or with the
  failing command and its output tail. Each revision is hashed once for both checks (a deploy
  hashes the whole working tree; two hashes could overrun the hook timeout). The user's
  one-use push-test marker covers it; warn mode never uses the marker and goes on to the next
  hand-off. `GOODBOY_PUSH_REGRESSION=on` (default) | `warn` | `off` (off in tests/setup.ts);
  `GOODBOY_PUSH_TEST_GATE=off` turns off both.
- The one-hour tier (§15.1, H6): when the newest passing regression goodboy timed (any tree)
  took over an hour, the layer-1 result suffices and the user is told once per hand-off. A
  failing run proves no length (a crafted command could sleep). The push check asks only for
  a passing layer-1 result of the tree; that the existing tests ran with the change is the
  Stop's rule (§15.8), which warn or off mode relaxes.
- Known limits (the same-user limits of §10.10): the whole-suite command comes from the repo's
  own files, which the model can edit (a changed `scripts.test` is part of the diff the review
  sees, and of the tree handed off, except for the one-hour tier: a passing run of a
  temporarily slowed script, reverted afterwards, relaxes later pushes and is in neither);
  the run inherits the caller's environment, so a PATH that
  puts a fake runner first records a pass (the resolved `program` shows it); a copied or
  symlinked CLI under another name, or code read from a file at run time (`bun -e "$(cat
  x)"`), is not recognized as a result write; killing `sh` at the
  timeout may leave its children running. No user override of the command yet. A suite longer
  than the agent's Bash timeout runs in the background (agents/test-unit.md).

### 15.8 I5 (#6): existing tests run with the change and are never quietly weakened

Two rules (`lib/existing-tests.ts`), both against the session's start HEAD (pinned in
`coverage-pin.json`); without a start commit there are no existing tests.

- Affected tests (layer 1, the Stop's test decision, after the test types and before the
  changed lines): the test files tracked at the start HEAD (by name: `*.test.*`, `*.spec.*`,
  `*_test.go`, `test_*.py`, `*_test.py`) that load a changed code file:
  - JS/TS: a relative import, require or dynamic import resolving to it (extension and
    `index` resolution, a `.js` specifier naming a `.ts` source);
  - Python: an import of its module or a module under it (`a.b`, also without a leading
    `src/`), or `from a import b`;
  - Go: the `_test.go` files of its dir.
  - Candidates come from one `git grep` of the start tree for the changed files' stems (an
    index file: its dir's name and the `.`/`..` specifiers), and each is read once from the
    start tree (`git cat-file --batch`) and parsed once into what it loads (set lookups, not a
    scan per changed file): the start content decides, so a test emptied in the session still
    counts. One over 1 MB, or past 64 MB read in all, counts as loading the file (fails
    closed). Direct loads only, not transitive ones.
  - A test is required at its path now: a renamed one is followed (git's rename detection
    against the start HEAD, or an untracked test file with the same content after a plain
    `mv`, each copy taken once); a deleted one is not required here, it is a weakened test
    (below).
  - Each needs a passing record with a trusted timestamp after the code file's last edit that
    lists it in `test_files` and has a passing suite that ran it. `suiteRan` reads only the
    test runs of the command (`bun test`, `npm test`/`run test:*`, `jest`, `vitest`, `pytest`,
    `go test`, `cargo test`, `node --test`, a test script by name…); setup steps before them
    (`node scripts/setup.js &&`, `bun build … &&`) name no tests, and a command with no test
    run ran nothing known. A test-name or partial-selection flag (`-t`, `--testNamePattern`,
    `--testPathPattern`, jest and vitest projects, `-k`, pytest `-m`/`--deselect`/`--lf`,
    `--grep`, `--fgrep`, `-run`, `-skip`, `--shard`, changed-only runs, a cargo filter or
    target) or a pytest node id (`x.py::t`) makes it partial; otherwise a test path naming the
    file or a dir above it (also an absolute one inside the repo, or a `--dir`/`--root` value;
    for bun, jest and vitest any part of the path, as their path filters work), or no test
    path at all (the whole suite). Redirects, the values of flags named like a path, file,
    output or setting, and absolute paths outside the repo are not test paths. For `go test`
    the package patterns decide (`./...`, `./x/...`, `./x`; none is the top package). A record
    outside the accepted set counts when it stands alone (as in I3b). The block names each
    file and its tests and says a failing existing test is updated, never weakened. An error
    in this rule is logged and skips only it, not the changed-line rule after it.
- Weakened tests (layer 2, the review gate, after the dimensions; also in the stop_hook_active
  accept): the start test files under the cwd that git sees changed against the start HEAD
  (`git diff --raw -M`, so a deletion or a rename by any command counts, not only recorded
  edits; the repo's filter drivers are emptied for it, as in I1, or a configured clean filter
  would run inside the hook: round-2 security review) whose checks went down: fewer
  assertions or cases, or more skips (JS/TS `.skip`, `.todo`, `.only` and `fit`/`xit`; Python
  `skip*`/`xfail` marks, `skipTest`, `pytest.skip`; Go `t.Skip*`), counted in code without
  comments (JS/TS also without literals, Python without triple-quoted strings, Go without
  block comments) by linear patterns. A deleted
  test, one renamed to a non-test name, or a changed one over 1 MB counts as weakened (fails
  closed); a rename is compared with its source. Each needs a finding on that file (its start
  path or its path now; relative to the cwd or the repo top, a `:line` suffix ignored) in a
  recent review with a trusted timestamp after the test last changed (the file's change time;
  for a deletion or a move, the time of the dir it left), any recent review, also one that
  lists only a deleted test ("weakening a test is a review finding", #6): a finding made
  before a further weakening does not judge it (round-2 review high). The reviewer rates it
  (high when it hides a regression, low with the reason when the behavior changed on
  purpose), and the usual severity rules follow. Like a missing dimension, only the user's
  marker passes it. Every accepted review pins the weakened tests it let through by their
  path and content hash (`judged-weakened.json` in the session dir, written only by the Stop
  and kept by the state guard), so a later change is not asked again unless the test's
  content changes. The list is computed once per Stop.
- `GOODBOY_EXISTING_TESTS=on` (default) | `warn` (a Korean line to the user) | `off`; off in
  tests/setup.ts.
- I4's one-hour tier: past an hour, a push needs the layer-1 result of its tree; the push
  check does not repeat this rule, so the result ran the affected tests only when the Stop's
  rule was on for it.
- Agents: test-unit runs the listed existing tests (or the whole suite) and updates a failing
  one to the new behavior; review-all records a finding on each weakened test.
- Known limits: languages other than JS/TS, Python and Go have no affected tests; transitive
  loads (a test of a module that imports the changed one) are not required; a suite command
  is the agent's report (as everywhere in layer 1), and `suiteRan` reads it lexically: a
  bare path filter word (`bun test calc`), a dotted unittest module or a `cd` into a subdir
  before the runner is read as the whole suite; counting checks is lexical, so moving
  assertions into a helper reads as weakening (the reviewer then rates it low); a test moved
  with a plain `mv` and edited, or rewritten past git's rename threshold, counts as deleted;
  a change pulled from upstream that weakens a start test asks for a finding too; the review
  gate starts from recorded edits, so a turn whose only change is deleting a test is asked at
  the next review of the session; a test moved into a dir the runner does not collect keeps
  its counts and is neither weakened nor really run; the user's marker on a review gate pins
  the weakened tests without naming them again; the module keeps its own git runner (a
  shared one is a later refactor).

### 15.9 I6 (#13): fixes from the first real-use trial

The unreleased G, H and I work ran for the first time on a real project (2026-10-19): a copy of
a Java 21 / Spring Boot / Gradle repo, headless `claude -p` on opus, the repo plugin only,
endpoints pointed at dead local ports, a local bare repo as the remote. Tasks: a bug fix, a
feature, a docs-only change, commit and push. The work was good (red-checked tests, caught
mutants, kept scope, a policy file with the decisions; about $10 and 29 minutes in all), but
the gates around it ran into eight problems:

1. The project knowledge notice asked for the knowledge files before the first task, so the
   model asked "is this directory a project?" and a headless session ended with no work done.
   Now the notice says to do the task first and offer the files once afterwards; a directory
   with a git repo and source code is a project (the skill asks only when that is unclear).
2. A docs-only push needed red-green acceptance evidence, which a document change cannot have.
   Now a hand-off revision whose tree differs from the tree of a passing result (one of the
   newest five) only in prose passes without a new result: Markdown, reStructuredText or
   AsciiDoc under a top-level `docs/` or `doc/`, or a root README, CHANGELOG, LICENSE and the
   like, as regular files (no submodule or symlink; `git diff-tree --ignore-submodules=none`,
   which no diff config changes; replace refs and grafts are off for every push check git
   call, so `git replace` cannot make code read as prose or a commit as a tested one). Not
   when the tree handed off has a failed result of its own. Its full regression may be the
   one of a tested tree under it, unless the tree handed off has a failed run itself. Not
   every `classifyPath` document: a requirements.txt, a prompt the app loads or a SKILL.md
   that tests assert can break a run. Not on top of what the remote-tracking refs have
   either: the model can move them (`git update-ref`, `git fetch . HEAD:refs/remotes/…`), so
   a docs-only push with no tested tree under it needs the user's marker (4). A deploy of the
   working tree never passes this way (I6 review).
3. The push denial said there was no passing result when one for exactly that tree existed and
   was rejected; it now says why the newest result for the tree did not count.
4. The push denial (and the regression denial) did not give the model the user's marker path,
   so it guessed the session tag; the main session's denial now names it.
5. The result guard took a read-only `python3 -c "json.load(open('.claude/tests/…'))"` for a
   result write. It still does: telling reading code from writing code by its text failed
   (the I6 review wrote a fake result with `from os import remove`, `require('fs')['…']` and
   the like through a pattern of write calls, and the pattern was quadratic on large code).
   The denial now says to read results with the Read tool, `cat` or `jq`, which pass.
6. A new, uncommitted `.goodboy/policy.md` made the tested tree differ from every commit that
   left it out. goodboy's own files there (`policy.md`, `docs.json`, `test-catalog.md`,
   `hosts`, `commit-issue`) join its artifacts, which never count as content on either side of
   the comparison, as regular files only; other files under `.goodboy/`, or a directory named
   like one of these, still do (code the project may load).
7. The skill rule denied seven edits at once: one assistant message with seven parallel edits
   before a workflow skill. The next message used the skill, so the deny worked; no change.
8. The outward gate denied `psql -h $D` to a temporary unix-socket Postgres. A database host
   written as a literal absolute path is a local socket now, when every host the call names
   is one (each `-h`/`--host` and `-S`, each entry of a libpq host list). A host in a variable stays a
   host: its value cannot be read from the command text (assigned later, as a command prefix,
   inside a string, by `read`, `for` or `printf -v`; I6 review). A subagent's denial for such
   a host says to write the socket directory as a literal path.

- Known limits: tests that read prose under `docs/` or a root README would not run for a
  docs-only hand-off (2); a docs-only push on top of content no goodboy result covers needs
  the user's marker (2).

### 15.10 I7 (#14): fixes from the second real-use trial

The same four tasks ran on a fresh copy of the same project after I6 (2026-10-19; about 19
minutes and $5.6). The I6 fixes held: both code sessions did the task first and offered the
knowledge files at the end; the push passed layer 1 as prose (the docs session's change) on
the feature session's tested tree; the denial named the marker and the model asked the user
for it with the exact command; after the result guard's denial the model read with `jq`.
Four new problems:

1. Layer 1 was off in the JVM project: `detectTestInfrastructure` knew no `src/test`,
   `build.gradle(.kts)`, `settings.gradle(.kts)` or `pom.xml` (gate log "inactive:
   no-test-infrastructure"). Tests were written only because the workflow skills asked. Now
   those count, like `go.mod`; Gradle's files are one list for this and the regression.
2. `cli.ts regression` found no whole-suite command for Gradle or Maven, so every push of a JVM
   project needed the user's marker; the test agent then wrote a stray layer-1 record trying to
   satisfy the check. Now Gradle (`build.gradle(.kts)` or `settings.gradle(.kts)`) runs the
   repo's `./gradlew test` (`sh ./gradlew test` when the wrapper is not executable) or
   `gradle test`, and Maven (`pom.xml`) `./mvnw test` or `mvn test`; both when both are
   there. Gradle skips a test task whose inputs match a run that passed, which counts as a pass.
3. Review agents ran `cd <plugin root> && bun lib/cli.ts review-write`, so records landed in
   goodboy's own directory, where no gate of the project reads them (and the session then
   deleted them there, outside its project). `review-write` and `test-write` now refuse, when
   they run anywhere inside goodboy's own directory (an installed plugin's is no git repo), a
   record that names a file outside it; the agent rule says to run the CLI from the project's
   directory.
4. The main session's Stop finished a background agent's Bash call that was still running
   (it took every open call for one that ended with `exit N`). The call's real post hook then
   found no start note and fell back to a five-minute window, so seven unchanged files were
   recorded as the agent's edits and a finished review turned stale; and nothing watched what
   the call did after the Stop (an approval marker it made then counted as the user's: I7
   review, as at HEAD). The Stop still finishes every open call (leaving an agent's call open
   let one that ended with `exit N` keep a model-made marker past the 30-minute note limit:
   I7 review), and while a subagent runs it notes each agent call again as one that starts at
   the Stop (from its old start when the Stop could not sweep its writes), with a fresh gate
   state snapshot that the Stop's orphan-snapshot restore leaves alone. The call's own post
   hook, the next Stop, or the agent's SubagentStop (new:
   it finishes that agent's open calls, which have all ended) closes it. A marker the user
   makes while such a call is open counts as the model's, as during any open model call.

- Seen and left as designed: the skill rule denied a batch of five parallel edits before the
  workflow skill (as in §15.9 item 7); read-before-edit denied an Edit in a test agent's
  temporary copy that it had not read.

### 15.11 I8 (#15): fixes from the third real-use trial

The same four tasks on a fresh copy after I7 (2026-10-19). The push went through with no user
approval: the code sessions recorded tests with JaCoCo changed-line coverage, the commit
session committed, the push check asked for a full regression, the test agent ran
`cli.ts regression` (`./gradlew test`), and the push passed. (The first commit session was cut
off by an account switch and ran again.) Two problems:

1. The changed-line rule asked for lines of a MyBatis mapper interface (two parameter types
   changed). An interface with only abstract methods has no bytecode lines, so JaCoCo leaves
   it out of the report and no test can ever run it; the session ended asking the user to
   waive the check. A changed `.java` file that declares only interfaces or annotation types,
   with no method body, no class, enum or record and no field but compile-time constants (a
   primitive or String field set to a literal; `null`, `Foo.class`, a method reference or any
   other initializer runs in a static initializer), now has nothing to measure, like a
   types-only TypeScript file. It is read by linear scans (the shared literal stripper, which
   now knows Java text blocks, then annotations), never by a regex that backtracks: a crafted
   file ran the Stop past its timeout (I8 review). A unicode escape anywhere (javac reads
   `\u007b` as `{`), a FIFO or anything unsure counts as code, and so does any character
   outside comments and strings that is not printable ASCII or whitespace: javac takes
   non-ASCII names (`class 매출`) and ignores control and format characters inside a word
   (round 2). A lone CR ends a line comment, for the JS forbidden-pattern scan too. Reading
   changed files to tell has 3 s in all; after that a file counts as code unread. It matters
   only for a file missing from every report: a file in a report is measured as before.
2. `git add … && git commit … && git push` was judged before the command ran, so against the
   commit before the new one, and the denial said the content was edited after the tests. A
   command before a push or an MR creation (`gh pr create`, `glab mr create`) in the same
   command that may change commits now gets a denial that names it and says to run it first
   and the hand-off as a separate command (the user's notice says so too); between two pushes
   it counts for the later one (closing check). After the last push in a plain sequence it
   runs too late to matter (round 2: `git push && git switch main`); with
   a loop or a function (`for`, `while`, `until`, `select`, `function`, `()`) any position
   counts. Read-only git: status, log, diff, show, add, rm, mv, restore, rev-parse and the
   other plumbing readers, push; `branch` and `tag` when every flag only reads (a read mode
   such as `--list` or `--contains`, or a listing option) and, with operands, a read mode is
   set (round 2: `tag -a` annotates, `branch -v -f` moves, git deletes before it lists);
   `checkout` and `reset` with paths after a `--` (a bare `--` at the end names none),
   `reset` without an operand, `stash` but `stash branch`, `remote` with no operand, `show`
   or `get-url`, `config` reads, `fetch` with no `:` in any word (a `src:dst` refspec or
   `--refmap`). A git command with a config set for it (`-c`, `--config-env`, `--exec-path`,
   or GIT_CONFIG*, GIT_EXTERNAL_DIFF or GIT_EXEC_PATH in its env) or a flag that runs a
   program (`--upload-pack`, `--exec`, `grep -O`) counts as a change: `diff.external` ran a
   commit. So does an alias, an unknown git command, and any other
   program but a short list of readers (echo, printf, test, sleep, ls, cat, head, tail, grep
   and the like, `command -v`, and the loop and flow words): `npm version`, `make release`
   and scripts commit (round 2). A shell's `-c`, `eval`, `xargs`
   and `find -exec` are not counted themselves, as their command is read. A git command is
   named before another program. It only ever denies. A push in a `trap` is now unclear (it
   was never read: I8 review).

- Known limits: Kotlin and Groovy interfaces still count as code, and so does a constant
  expression (`1 << 10`, `"a" + "b"`), an annotation-only `package-info.java` or a Java file
  with non-ASCII names (the safe side). Some harmless commands next to a push are denied too
  (`git branch feat`, `git checkout main`, `bun test && git push`, `git fetch <url>`): the
  denial says to split the command. Not seen: a program the repo's own config runs from a
  read-only git command (`core.fsmonitor`, a textconv driver) or from another global config
  (a HOME or XDG_CONFIG_HOME set for it), a redirect that writes into `.git`, and a fetch
  refspec from the remote's config that writes local branches.

## 16. J — Field reports (v0.34.0)

Asked by the user on 2026-10-16: improvements and bugs found while using goodboy elsewhere
should reach this repo in a form that can be checked and planned. Until now a report lived
in another session's temporary scratchpad and was relayed by hand, with no fixed contents.

| Step | Issue | Contents |
|---|---|---|
| J1 | #8 | The `report-goodboy` skill and a local inbox |
| J2 | #9 | Inbox notice in this repo, the `triage-reports` skill, a GitHub issue form |
| J3 | #11 | A friction notice at Stop that suggests a report |

- J1: in any project with goodboy, the skill writes one English report from a fixed
  template:
  - what happened (observed vs. expected) and the user's words;
  - evidence: goodboy and Claude Code versions, gate-log lines, block counts and timings,
    the commands or files involved;
  - suspected causes, a proposed change, and what is not known.

  Reports go to `~/.claude/goodboy/inbox/`, never a temp dir or the versioned plugin cache.
  A report keeps project details locally, and carries a public summary with project names,
  paths, people and company details removed. A short Korean summary goes to the user.
- J1 as built (`lib/field-report.ts`, `cli.ts report-evidence` / `report-write`, the
  user-invocable `report-goodboy` skill):
  - The session is the one named by `--session <id or tag>`, else the one the command runs
    in (`CLAUDE_CODE_SESSION_ID`, set for Claude Code's Bash calls), else the newest
    transcript of the dir and all its parents in Claude Code's projects dir (a link named like
    a transcript is skipped; another terminal in the same dir may be newer, so the skill
    names `--session`). goodboy attaches the evidence itself: its version (plugin.json), the
    Claude Code version (the transcript's last `version`), gate decisions per gate, the first
    and last gate-log time, the last 30 gate-log lines (local only) and the Stop retry
    counters. The gate log is read without blocking: a FIFO or a device there is refused
    (also for the Stop gates that share the reader).
  - The report is JSON with exactly the template's fields (unknown fields, gaps and long texts
    are refused). The public summary's title holds no quotes, backticks, `$`, backslashes or
    line breaks, as it goes into a `gh issue create --title "…"` line.
  - The public summary (its title and body; goodboy's own footer of versions and gate counts
    is not the user's) is refused when it holds a local path (any absolute path with a
    directory, a home path but `~/.claude/`, a file URL, a Windows path), an email, an IPv4
    or IPv6 address, a URL with any scheme to a host but goodboy's repo and Anthropic's, a
    domain ending in a top-level domain or a backwards package name (well-known public
    library roots aside), a secret (cloud, GitHub, GitLab, Stripe-style, Google, npm and
    Slack tokens, private keys, JWTs, bearer tokens, a password in a URL, `key: value` and
    `--password x` forms with a value that has a letter), or a name this machine knows to be
    the user's: the repo's dir name; each remote's owner and repo name, and its host's
    labels when it is not a public code host; git's whole user.name and the parts of
    user.email; the login and the host name. Names match in any case, NFC or NFD, with `-`,
    `_`, `.`, a space or nothing between their parts, as whole words; generic words (`api`,
    `platform`) are no names, and a first or last name alone is not checked. Company names
    that appear nowhere on the machine are left to the skill's instructions and the user's
    confirmation of the exact text.
  - The inbox (`GOODBOY_INBOX_DIR` for tests) is refused inside goodboy's own dir, in a temp
    dir by default (both judged with every link resolved, as far up as the path exists),
    when it is a link, another user's, or writable by others; it is made 0700. A report is
    two new files, `<time>-<slug>.json` (report, evidence, status `new`) and `.public.md`
    (the issue body), each created exclusively (mode 600): a file or a link at either name
    is never written through or reused; the next free name is used.
  - Known limits: a private name inside a longer camelCase identifier (`billingCoreService`),
    a UNC path, `~bob/x` and a path of non-ASCII directory names only are not found; plain
    phrases such as `GET /api/users`, `/tmp/x` or `password: required` are refused and need
    rewording. The user's confirmation of the exact text is the last check.
- Other users: goodboy runs no server, so the channel is this repo's issues. The repo is
  public with issues open (checked 2026-10-16), so anyone with a GitHub account can file.
  After the user confirms the text, the skill files the public summary with `gh`, with
  `[field-report]` in the title: a non-collaborator cannot set labels, while the issue form
  applies the `field-report` label.
- J2: a session in this repo starts with one line when the inbox has new reports; nothing
  runs by itself. `triage-reports` (repo-local, like `/verify`):
  - reads the inbox and the field-report issues (by label or title);
  - re-verifies every claim against the current source;
  - merges duplicates and matches them to this plan, the backlog and open issues;
  - proposes where each item goes;
  - after the user approves, updates the plan and opens or comments on issues with public
    summaries only;
  - moves a triaged report to `inbox/done/`.
- J2 as built (`lib/field-report.ts` listInbox / inboxNotice / markTriaged, `cli.ts
  report-list` / `report-done`, `.claude/skills/triage-reports`, `.github/ISSUE_TEMPLATE/
  field-report.yml`):
  - The notice comes at a new, resumed or cleared session (not after a compaction) when the
    cwd is in goodboy's own repo (a git checkout whose root has goodboy's plugin manifest,
    outside Claude Code's plugins dir: an installed copy has no `.git`, the marketplace
    clone there has one) and the inbox's top level holds reports: one Korean line for the
    user, one English line for the model that says not to triage unasked; silent when the
    inbox is unsafe. `GOODBOY_INBOX_NOTICE=off` turns it off.
  - Every inbox command (write, list, file, triage) refuses an inbox that is a link, another
    user's or writable by others. A report name starts with a word character (`...json`
    had the stem `..`). The list reads up to 200 reports among the first 1000 report-like
    names; a link, a non-file or a file that is not a `goodboy-field-report/1` record is
    skipped.
  - Every file goodboy makes there is created exclusively (mode 600), written whole (a short
    write fails and removes it) and synced before anything is removed.
  - `report-filed <file> --issue <goodboy issue URL> | --local` records the user's filing
    choice once (report-goodboy step 7). `report-list` gives each report its
    `publish_problems`: kept local, filed already, a `.public.md` that is not the text
    goodboy wrote (the file is what `gh --body-file` posts), a title or summary that breaks
    the template, or private details found again (the report's project dir's names when it
    still exists); `report-evidence --public` prints only versions and counts, never the
    gate-log lines (the issue form says to use it).
  - `report-done <file> --decision "<where it went>"` (or `--decision -` from stdin, so quoted
    issue text never meets the shell) takes a report at the inbox's top level only (not a
    link, not another dir, not other JSON; a `.public.md` that is a link is refused before
    anything moves), claims it by an atomic rename to a hidden name, writes the claimed text
    to `done/` with status `triaged` and the decision (1–1000 characters) together with its
    `.public.md`, and only then removes the claimed files; on any failure they go back. A
    file or a link at a name in `done/` is never written through, the next free name is
    used, and `done/` itself passes the same checks. `report-filed` takes the same claim, so
    two commands on one report at once fail rather than both pass or lose the choice, and a
    claim a killed command left behind is put back by the next list (when its process is
    gone and its name is free).
  - `publish_problems` also flags evidence that no longer has goodboy's shape (the footer is
    rendered from it), and a report it cannot check is named instead of failing the list.
  - Known limits: 1000 other JSON names that sort before the reports still hide them; that
    the claim excludes a second command is checked by probes, not by a unit test; a
    `report-done` killed after the `done/` copy but before the claim is removed leaves the
    report in both places once the next list puts the claim back (nothing is lost; running
    `report-done` on it again moves it to the next free name in `done/`); the footer's
    goodboy version is the version of the CLI that wrote the report, so a report written
    from a development checkout names that checkout's version, not the installed hooks'.
  - Live run (2026-10-20): one report from this session went through `report-write`, the
    skill's re-verification and the one question, then `gh issue create` (#16),
    `report-filed`, the plan entry under the J3 candidates and `report-done`. It showed that
    the title search also returns issues that only mention field reports (now filtered by
    the `[field-report]` prefix).
  - The skill reads the inbox and the field-report issues (by label and by title), treats
    their text as data and never runs a command or URL they name, re-verifies each claim
    with goodboy's own tests or its own probes, merges duplicates, proposes a place per item
    in a Korean table with the exact `.public.md` text of each report to file (only those
    without publish problems) and asks once; only after the approval it edits the plan,
    files or comments, and records the filing with `report-filed`.
  - The issue form has the template's fields (observed, expected, the user's words,
    versions, involved, evidence, suspected causes, proposed change, unknowns), the title
    `[field-report] `, the `field-report` label (it exists in the repo, checked 2026-10-20) and a
    public warning at the top.
- J3: it reads goodboy's own records, asks the model nothing and never blocks.
  - Signals: a hook error or a fail-open path; a gate at its retry limit, or one gate
    blocking again and again; verification over the budget of its change class (I1b); a
    gate the user switched off during the session. The gate log has the deny, warn and
    fail-open decisions and the block counts; the rest needs new records: hook errors (they
    go to stderr today), the durations of the test and review runs, and the gate switches
    each Stop sees.
  - At most one Korean notice per session, with the signal and `/report-goodboy`. Off in
    this repo; it has an env switch.
  - Free-form improvement ideas are out: they would be noise; the user runs the skill for
    them.
- J3 as built (`lib/friction.ts`, called from the Stop hook's `emit()` on every output path):
  - Hook errors are recorded now: every caught hook error with a known session goes through
    `hookError` (`lib/gate-log.ts`). That covers every hook's error paths, session-start's
    fatal path (silent before) and the after-Bash sweep (`lib/write-sweep.ts`). `hookError`
    writes stderr as before and adds a `hook-error` fail-open to the gate log. Only stdin
    parse errors stay stderr-only, since no session is known yet. A hook given `null` on
    stdin still exits 0 with `{}`.
  - Signals, read from the records only:
    - a hook error;
    - a fail-open, except the routine waits on Claude Code (`text-flush-lag`,
      `limit-unconfident`, `subagent-transcript-not-found`). This repo's own session logged
      over a hundred of those, so counting them would make the notice show every time;
    - a Stop gate blocking 3 times in a row. The gates' block counters are read at the Stop
      (`STOP_BLOCK_COUNTERS`; 3 was their retry limit before track G). PreToolUse denies do
      not count: the review replayed real sessions turn by turn, and 3 denies of one gate in
      a turn would have shown the notice in 3 of 4 sessions. They were the model's own
      mistakes that the gates corrected (fix loops, read-before-edit, bash-write);
    - a document change past its I1b budget. A review or test run is judged by the
      session's edits: those after the previous run of the same team was dispatched, up to
      this dispatch. This matches what the I1b note judges. A prompt can name only a spec
      document for a code change, so the files a prompt names are not used. When all those
      edits are documents, two things count:
      - a review that ran longer than `DOC_REVIEW_BUDGET_MINUTES`, from dispatch to done,
        matched by tool-use id or agent id;
      - any test run;
    - the user's one-use Stop marker letting a gate pass (`user-override`). PreToolUse
      approvals of risky commands are normal approvals, not friction;
    - a `GOODBOY_*` switch that is `off` now and was not at the session's first Stop. The
      notice switches themselves do not count.
  - At most one Korean `systemMessage` per session: the first signal, how many more, then
    `/report-goodboy` and the switch. The notice is never part of a block reason or the
    model's context.
  - A gate or hook name from the records shows only when it is a plain short name; any other
    name shows as `unknown`.
  - The state is `friction-notice.json` in the session dir: the switches at the first Stop,
    and whether the notice was shown. The notice shows only once that latch is written, so a
    state dir that cannot be written shows nothing rather than a notice at every Stop.
  - The state file and the block counters are read as regular files only (`readRegular`,
    not through a link; `readRetryCount` too, for every gate). The state is written without
    blocking and only into a regular file, so a FIFO placed at either never hangs the Stop
    (refactoring/authz review).
  - `GOODBOY_FRICTION_NOTICE=off` turns it off everywhere; `on` turns it on in goodboy's own
    repo, where it is off by default (`inGoodboyRepo`). It is off for the test suite
    (`tests/setup.ts`); `tests/j3-friction.test.ts` turns it on.
  - Known limits:
    - a run with no edit since the previous run of its team, or with both documents and code
      in its change, is never judged against a budget;
    - the duration counts from the dispatch, so time a background agent waited to start
      counts too;
    - the budget for code changes is not defined yet (I1b set only the document one), so
      only document changes have this signal;
    - a switch changed in the environment is seen only if Claude Code passes the new value to
      the hooks;
    - until the notice has shown, each Stop reads the session's logs again. The review
      measured 15 ms at 1k gate events and 140 ms at 10k;
    - whether `transcript-unparsed` and `usage-parse-failed` fire in healthy sessions is not
      known: they never appeared in the 7 real gate logs the review read;
    - the notice is advice, and anything that can write the session dir or the project can
      silence it. A model can write `noticed: true` into the state. A project can set
      `GOODBOY_FRICTION_NOTICE=off` in its settings, or add a fake goodboy
      `.claude-plugin/plugin.json` with a `.git`. That is the same trust as every other
      `GOODBOY_*` switch, and no gate gets weaker;
    - the dispatch and edit logs are still read with plain reads. A FIFO there is the older
      session-file gap of #12, which other hooks already read the same way;
    - the effort advice's `hasRepeatedBlock` (2 denies of one gate since the last advice) and
      this `repeated-block` (3 Stop blocks in a row) are separate definitions on purpose. The
      advice suggests more effort early; the notice points at goodboy.
- First candidate, seen here on 2026-10-16: while a background review or test agent is
  still running, the Stop gates block every chat turn, and answering the user burns the
  retries although the evidence is on its way.
  - Triaged 2026-10-20 (the J2 live run, filed as #16): seen again with the released 0.30.0
    hooks (review deny 12, test deny 12 in one session). Already fixed in the source: Stop
    defers the review and test gates while a subagent runs (`hooks/stop.ts` B5.8, G1
    bf9c5b9; `tests/stop-g1.test.ts`). Not released yet; after the release that carries it,
    confirm in a real session that the gates stay quiet while agents run and block again
    after they finish, then close #16.

## 17. K — Update checkups (v0.35.0)

From a field handoff of 2026-10-16 (Claude and Codex, three rounds; facts measured on Claude
Code 2.1.301). The goal is to keep the user's customizations (skills, subagent definitions,
plugins, hooks, CLAUDE.md) working and useful across CLI and model updates. Subagent
definitions were added in round 3, by the user's decision: their instructions can lose
quality on a model update like a skill's.
- CLI updates can change hook events, fields and frontmatter rules, or stop a plugin from
  loading; they can also make a customization redundant.
- Model updates can make detailed instructions hurt output quality.

Decided by the user in that handoff:
- two separate skills (CLI update, model update);
- a detector only notifies;
- third-party skills are pruned by usage only;
- one fixed eval suite per target, versioned and extended only after a real failure;
- every paid run and every customization fix needs the user's approval;
- English reports with a short Korean summary.

Measured (phase 0):
- `claude -p "/skill-doctor"` costs nothing and prints usage per skill.
- `claude plugin eval <skill folder>` runs a with/without ablation on a plain skill folder,
  in isolation. Always pass `--output-dir`.
- SessionStart input has no model in `-p`. `Pre/PostModelSwitch` fire on `/model`. Every
  assistant transcript entry has `message.model` and `version`.
- `--safe-mode` drops CLAUDE.md, settings hooks and installed plugins.
  `--setting-sources project,local` drops user plugins and hooks but keeps the user
  CLAUDE.md. `--bare` needs an API key.
- `--debug-file` logs each hook run with its plugin and exit status.
- Subagents, from the docs and the changelog:
  - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` sets the nesting depth. 2.1.217 turned nesting
    off by default; 2.1.219 turned it back on, to depth 3.
  - The retirement or remap warning covers agent frontmatter. In `-p` it goes to stderr,
    and only with text output. The result's `modelUsage` shows what ran.
  - `plugin eval` loads a plugin's agents; in the no-plugin baseline arm a dispatch fails
    with "Agent type … not found". A project's `.claude/agents/` never loads in eval.
  - A definition without `tools:` inherits every tool, the Agent tool included.

K1 (#10): a manual `cli-update-check` skill, with no new hook registrations and no gate
exemptions.
- State in `~/.claude/goodboy/checkups/`: atomic, locked writes. `observed`, `pending` and
  `lastChecked` are kept apart, and only a completed check advances `lastChecked`.
- Inventory: configured vs. loaded components, their source, hash and owner, and the hook
  events, JSON fields, frontmatter keys and flags they use.
- Changelog: the version range since the last check, from the local changelog cache. A gap
  is "incomplete", never "nothing changed". Identifiers are matched first; then the whole
  range is triaged, with a bucket for unmapped but possibly relevant entries. Each finding
  carries the excerpt, the affected contract, a confidence and a proposed probe.
- Health: `claude plugin validate`, plugin-load warnings from a debug log, `/skill-doctor`,
  and a bounded `/doctor` that stops before repairs.
- Smoke tests check trigger → decision → consequence, never just exit 0:
  - goodboy's own hooks are fed hook JSON with zero model turns, unique session IDs and
    disposable state, with the JSON `cwd` and the process cwd both set;
  - then at most 3 small integration sessions, only after the user approves an estimate.
- User hooks of other tools get smoke cases the user defines in local config next to the
  state. The public plugin ships no one's personal setup (a change from the handoff, which
  listed this user's hooks).
- Reports go through a constrained CLI writer limited to `runs/<run-id>/`, run through Bash
  so a report never goes through Edit/Write, and never a general write path.
- `PostModelSwitch` is not registered while the README claims v2.1.138+: nothing guarantees
  that older CLIs ignore an unknown event.
- Subagent definitions (round 3):
  - Inventory: goodboy's own agents, user agents, and project agents from an explicit
    registry of project paths. The registry holds the current project automatically; other
    paths come from the user, and discovered ones are only suggested, never scanned
    silently. Per definition:
    - canonical path, scope, owner;
    - configured, loaded or shadowed;
    - whole-file, body and frontmatter hashes;
    - raw frontmatter, the requested model and the observed model with its source;
    - tool restrictions, delegation references, unresolved contracts.
  - Static checks, each with versioned evidence and an uncertainty flag:
    - pinned model IDs, kept apart from verified retirement, remap or unavailability;
    - `tools:` that resolves to nothing (MCP availability stays unknown until runtime);
    - MCP `tools:` syntax against the running CLI's contract;
    - frontmatter keys the running CLI ignores (not counted as load failures);
    - duplicate names in one scope, and shadowing across scopes, reported separately;
    - copies grouped by hash, with their differences (divergence alone is no defect);
    - delegation against policy: a definition that can call the Agent tool, given
      `disallowedTools`, the depth setting and goodboy's delegation guard. goodboy's leads
      (`test-lead`, `review-lead`, `research-lead`) delegate by design (§10.7). Any other
      definition that can call the Agent tool (it lists it, or inherits it with no `tools:`)
      conflicts with the leaf rule.
  - Agent-related changelog entries are matched too, including changed defaults that touch
    omitted fields (depth, background spawns, tool filters).
  - Zero model turns: parsing, hashing, collisions, drift, contract matching, log reading.
    They cannot prove a dispatch or the effective tools.
  - Model-turn probes: a dispatch, the effective tools, depth enforcement and model
    resolution. They share K1's sessions where they can (at most 3); any beyond those are in
    the same estimate the user approves.
    - The depth probe is one Haiku parent dispatching one Haiku child. It passes only on
      tool-schema evidence of what the child can call; a self-reported tool list is not
      enough, and without that evidence the result is inconclusive.
    - Forks need a separate check.
    - The probe never runs an uncontrolled recursive chain.
  - A pinned model ID is "pinned; intent unconfirmed". Its lifecycle:
    - retirement announced: breakage risk;
    - verified rejection: unavailable;
    - verified substitution: behavior change.

    First check: the text-mode stderr warning (silence proves nothing). Then, with
    approval, one minimal request read through `modelUsage`.
  - The depth setting: the checkup recommends `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` as a
    user-settings change outside goodboy, with its own approval. The documented semantic is
    the number of subagent layers below the main conversation (`1`: a subagent cannot start
    another); the depth probe confirms it under `2` before the checkup recommends the value.
    `2` is main → lead → member, goodboy's designed depth. The handoff proposed `1`, but it
    was written against v0.30.0, which had only leaf agents; under `1` goodboy's leads still
    run but cannot start their members (SessionStart already warns below 2). Within depth 2,
    goodboy's delegation guard still allows only a lead to delegate. The setting also covers
    sessions where goodboy is off. Rate limits stay: depth does not bound sibling dispatches.
- Tests: the state transitions; the changelog range (gaps, downgrades, empty); the writer's
  containment (escapes, symlinks); the fixtures' isolation from real user state; every smoke
  case, allowed and blocked. For agents: frontmatter parsing and unknown keys; collisions
  and shadowing; `tools:` resolution; delegation-policy conflicts (goodboy's leads allowed);
  pin classification; hash dedupe and drift; project-registry isolation.
- Reports keep problems that already existed apart from update regressions.

K1 is built in four steps, all under #10. Each step is reviewed and committed before the next:
- K1a: the state, the changelog range and triage, and the run writer;
- K1b: the inventory, with the subagent definitions and their static checks;
- K1c: health (plugin validate, plugin-load warnings, skill-doctor, a bounded doctor) and the
  zero-turn smoke cases, including the user's own cases from local config;
- K1d: the `cli-update-check` skill that ties them together, and a full check on this
  machine. Integration sessions run only after the user approves an estimate.

K1a as built (`lib/checkup.ts`, `lib/private-files.ts`, `cli.ts checkup-*`):
- The safe file helpers of track J (`checkDir`, `createNew`, `isUnder`, `realDeep`,
  `processAlive`) moved to `lib/private-files.ts` for both tracks, with `checkedPrivateDir`
  (the inbox and the checkup dir) and `claudeConfigDir`. `claudeConfigDir` is one rule for
  Claude Code's config dir: `CLAUDE_CONFIG_DIR` resolved, else `~/.claude` under HOME. It
  replaces three variants that differed (field-report's session lookup ignored HOME).
- The checkup dir is `~/.claude/goodboy/checkups/`, or an absolute `GOODBOY_CHECKUP_DIR`. It
  is refused inside Claude Code's plugins dir and inside goodboy's own files. It must be a
  real dir of this user that others cannot write.
- State (`state.json`, schema 1):
  - `observed` is the CLI of the last run that began.
  - `pending` is the run begun. It records its Claude Code session (`CLAUDE_CODE_SESSION_ID`)
    and the range its changelog step saw.
  - `lastChecked` is the CLI of the last completed run, with that range: a run completed over
    a gap tells the next one (`last_range`, `previous_range`).
  - Only `checkup-complete` moves `lastChecked`; an abort leaves it.
  - Only the session that began a run may complete it or note its range; any session may
    abort it. Round 2 of the review found that another session could complete a run it never
    checked, which moved `lastChecked`.
  - Another session's pending run younger than 24 hours blocks a new one. It can be replaced
    only with `--replace`, and the output names the replaced run. The same session may begin
    again, and an older run counts as abandoned. The review found that the pid used before
    was the begin command's own, which ends at once.
  - Writes are atomic: an exclusive temp file, synced, renamed over the state. They run under
    `state.lock`, which appears with its whole text at once (a complete temp file hard-linked
    to the lock name).
    - A live lock fails the command.
    - A lock whose process is gone, or that is older than 10 minutes, is stale. It is moved
      aside by an atomic rename and dropped only if what moved is the lock judged stale. A
      fresh lock moved by mistake is linked back when its name is still free.
    - If a third command took the name first, the moved lock's holder finds its lock gone
      right before it writes, and writes nothing. Round 2 lost 26 of 900 updates in that
      race with dead locks planted over and over. What is left is the instant between that
      check and the rename.
    - A lock is never removed unread, and a dir at the lock is named in the error.
    - The review saw 561 of 600 updates kept with two writers under the first lock. A test
      now runs 4 writers × 40 updates and checks that all 160 are kept.
  - A state that is not goodboy's shape, a link or a FIFO is an error, never reset: a reset
    would lose `lastChecked` and make the next range look complete.
- Versions are `x.y.z`, with a leading `v` dropped. Anything else is refused. The review
  found that `--from v2.1.301` gave "complete" with no versions.
- Changelog (`~/.claude/cache/changelog.md`, read as a regular file up to 8 MB):
  - The range is the versions after `lastChecked` up to the running CLI (`claude --version`,
    or `--cli`). It is `incomplete` with the gap named when the cache has no entry for the
    running version or starts after the last check. `empty` means the same version,
    `downgrade` lists the versions rolled back, and `first-run` checks only the running
    version.
  - Triage puts every entry of the range in one bucket:
    - matched: it names an identifier in use as a whole token (`Stop` is not in
      `StopFailure` or `SubagentStop`). Confidence is high, and the first probe depends on
      the kind: a hook event, a payload field, an env var, a flag, or another name;
    - unmapped: it names a topic customizations depend on (hooks, plugins, skills, agents,
      frontmatter, settings, CLAUDE.md, MCP, permissions, and so on). Confidence is low;
    - other: counted only.
    Identifiers come from the caller (`--ids`); K1b's inventory supplies them. The token
    search is a plain search, not a regex for each pair: the review measured 7.5 s for the
    whole cache with 300 identifiers.
  - The output lists at most 200 matched and 50 unmapped findings (`--max-matched`,
    `--max-unmapped`) and counts what it left out. Before, the whole cache came to about
    1 MB of JSON.
- Run writer (`checkup-write --run <id> --name <file>`, text on stdin):
  - it writes one new file into `runs/<run-id>/` of the pending run only;
  - the name is plain, with a `.md`, `.json` or `.txt` extension;
  - the runs dir and the run dir must be real and private;
  - the file is created exclusively, never through a link, up to 2 MB;
  - every check runs before stdin is read, and stdin is read only up to the cap.
- Tests: `tests/k1a-checkup.test.ts`, 25 tests. 34 mutants were tried and 33 caught. The one
  left is equivalent: without the stdin cap, the writer still refuses an oversized report,
  only after buffering it.
- Known limits:
  - on the real 4-version range (2.1.301–2.1.304) the unmapped bucket held 70 of 191 entries;
    the skill triages it, and K1b's identifiers move entries into `matched`;
  - `checkup-begin` makes the run dir after the state is written. If that fails, the run
    stays pending until it is aborted or replaced, or its session begins again;
  - `hooks/stop.ts` (`settingsJsonPath`) still reads `~/.claude/settings.json` without
    `CLAUDE_CONFIG_DIR`. That is older than K1a, and its fix belongs with the next Stop
    change;
  - the writer checks the run dir, then opens the file by path. The same user could swap the
    dir for a link in between. Another user cannot: the checkup dir and the runs dir are
    0700. The review swapped it 4000 times and nothing landed outside;
  - a plain lowercase identifier (`prompt`, `model`, `hooks`) matches only in its code form,
    in backticks: the inventory's keys matched 44 entries of the real range as prose
    (K1b). With the rule, 5 entries match, each a real use;
  - a pending run outside Claude Code has no session. Only `--replace` or the 24-hour age
    replaces it.

K1b as built (`lib/inventory.ts`, `cli.ts checkup-inventory`, `checkup-projects`,
`checkup-changelog --inventory`). It makes zero model turns and runs no hook or command; it
reads files only.
- Components, each with its scope (user, project, local, plugin), owner (`user`,
  `project:<root>` or the plugin id) and canonical path (links resolved):
  - plugins: configured against installed. Configured means enabled by the settings that
    apply to the current project, last wins (user, then project, then local `enabledPlugins`);
    a registered project's settings do not count. Installed means an entry in
    `installed_plugins.json` for the current project, or one without a project, with an
    existing install dir; another project's install never counts. The summary names plugins
    that are enabled but not installed, and installed but disabled. Only an enabled plugin's
    hooks, skills, agents and commands are listed;
  - hooks from the user, project and local settings and from plugins' `hooks/hooks.json`,
    each as `Event[matcher]` with its command: the first 2000 characters, secrets masked
    after the cut (two patterns are slow on long text: 20 s on a 200 KB command in review).
    A command past 64 KB is read in part and named. A `hooks` value that is not an
    object of events, an event that is not a list and an entry that is not an object are named
    as problems: on this machine, a local plugin's hooks.json is a list in another format,
    which Claude Code likely does not load (K1c's validate confirms it). So is a settings,
    `installed_plugins.json` or hooks.json file that is there but is not a readable JSON
    object up to 1 MB: it is never skipped silently;
  - skills, agents and commands, with their frontmatter keys and the whole-file, body and
    frontmatter hashes. An agent also keeps the values the checks read (name, model, tools,
    disallowedTools); nothing else of a definition is stored (an agent's `mcpServers` can hold
    tokens). Frontmatter whose YAML aliases expand past 5000 values or 1 MB is a problem, not
    parsed further (a 431-byte file ran out of memory in review). A file that is there but
    not readable (over 1 MB, not a regular file) is named; a skill dir without SKILL.md is not
    a skill. CLAUDE.md files of the user and of each project. One file is one component.
- Projects: the current one (the nearest dir up with `.claude` or `.git`) and the ones the
  user registered with `checkup-projects --add <absolute dir>`. A dir whose `.claude` is the
  config dir (HOME) is never a project: its files are the user's, listed once. The walk up
  stops there, so no dir above HOME becomes the project. The registry
  is kept in the checkup state under its lock. No other project is scanned. The model can
  call `--add` too, so the K1d skill asks the user before it registers a project.
- Identifiers in use, for the changelog triage:
  - hook events;
  - the payload fields Claude Code documents (`PAYLOAD_FIELDS`), named as whole tokens in a
    hook's command or in the scripts it runs. That covers the files a command names, with
    `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}` and `$HOME` expanded and quoted parts
    joined (a path is text: a dir named `a$&b` is followed), and every script in a plugin's
    `hooks/`. Only files under the root that owns the hook are read (the plugin root, the
    project root, or HOME and the config dir; a link out of it is not followed), at most 600
    files and 32 MB in all;
  - env vars (shell basics left out), long flags, and the frontmatter and settings keys;
  - each kind keeps at most 2000 identifiers of up to 100 characters, and a definition at
    most 200 keys. Problems are kept once each, at most 200 and a note; a cap that was
    reached is always named.
- Agent checks; each finding is `confirmed` (read from the file) or `uncertain` (the running
  CLI decides, K1c/K1d):
  - a model that is not an alias is pinned, "intent unconfirmed" (uncertain);
  - tools entries goodboy does not know (uncertain), and MCP entries that are not
    `mcp__<server>` or `mcp__<server>__<tool>` (confirmed);
  - frontmatter keys goodboy does not know (uncertain);
  - duplicate names in one scope and owner, a project agent shadowing a user agent, and
    copies by body hash, each reported apart;
  - delegation: an agent that can call the Agent tool, because it lists it, or has no
    `tools:` and no bare `Agent` in `disallowedTools` (which Claude Code ignores when
    `tools:` is set; `Agent(x)` limits the tool, it does not remove it). goodboy's leads are
    allowed;
  - definitions that do not parse.

  Values from the file are cut to 100 characters in a finding, and one agent gives at most
  10 findings of a kind plus a count.
- `checkup-inventory --run <id>` writes the inventory to the run dir as compact
  `inventory.json`. Past the run-file cap the last components are left out, then agent
  findings, then identifiers past 100 per kind, each named as a problem, so the step does
  not fail on a large setup. It prints a summary (counts, plugin mismatches capped at 30
  each, unreadable definitions, identifier counts, problems) and capped lists: the agent
  findings (30) and the identifiers (200 per kind), with what was left out. Text from
  definition files is printed on one line, at most 200 characters; it is data from files
  any cloned repo can hold. `checkup-changelog --inventory` matches the range against all
  the identifiers.
- On this machine (Claude Code 2.1.304), 67 ms:
  - 7 plugins, 8 hooks, 84 skills, 2 agents, 4 commands, 2 CLAUDE.md files;
  - 115 identifiers;
  - the range 2.1.300→2.1.304 has 5 matched entries.
- Tests: `tests/k1b-inventory.test.ts`, 32 tests on fixtures in a temp HOME (21 of them for
  the two review rounds); 18 mutants caught before the reviews and 34 after round 1.
- Secret masking (`lib/secret-patterns.ts`, shared with field reports since K1b) also
  covers `curl -u user:password` and Slack webhook URLs; a Bearer token under 16 characters
  is not caught.
- Known limits:
  - the known tool names, agent keys and model aliases are goodboy's lists, checked against
    the 2.1.304 binary. A newer CLI's additions show as uncertain findings until the lists
    are updated;
  - payload fields are found by name in scripts, so a field used through a variable is
    missed;
  - "loaded" is not known yet: the inventory reads configuration. K1c reads what Claude Code
    actually loaded (plugin validate, the debug log).

Proposals (later steps, not scheduled):
- K2: quiet detection. A fail-open SessionStart reads the CLI version once, corroborated by
  the transcript. Model observations come from main-session transcript entries read
  incrementally at Stop, classified by family under the configured alias: an off-family ID
  is an override, and "model updated" is set only after an explicit startup probe. One
  notice per transition, with snooze; no instruction injection and no Stop gate. Agents use
  aliases other than the main session's: an approved startup probe per alias in use (for
  example `sonnet` and `opus`; `inherit` follows the parent). Passive subagent-transcript
  observations are deferred and may only support a finding.
- K3: a `model-update-check` pilot on two self-written targets plus CLAUDE.md.
  - `plugin eval` is the only suite, with frozen suite and grader hashes.
  - Benefit is success with minus success without, reported with absolute success.
  - Screening uses 3 pairs; confirmation uses 10 fresh pairs, judged by a 95% Newcombe
    interval with a ±0.10 margin. At these sizes "equivalent" is out of reach, so
    inconclusive means keep.
  - Safety guards are never removed on saturated scores.
  - Agents: the no-plugin delta measures "agent missing", so it is not used.
    - Two wrapper-plugin variants with matched definitions differ only in the body: the
      custom body vs. a minimal neutral one. Name, description, tools, model, effort,
      permissions and the required safety rules are the same in both.
    - They run through the frozen suite with `--ablation none` and are compared by the same
      pairing and statistics.
    - Wrapper loading and arm equivalence are proved by a positive control first.
    - One representative self-written leaf agent joins the pilot as a third target, in the
      same per-run estimate.
    - An unchanged pinned model is left out of alias-update runs, not out of manual
      benefit tests.
  - Deferred for agents: orchestrator quality evals, cross-repo sync, passive subagent model
    tracking, description and routing ablations, and settings or guard fixes. Native
    multi-component interaction evals go to K4.
- K4: goodboy self-evaluation on a frozen copy, with the gates active in the treatment arm.

Not prevented:
- A plugin that fails to load cannot report itself.
- Isolated ablations miss interactions between skills, CLAUDE.md, hooks and MCP.
- Headless smoke tests miss interactive approval, resume, compaction and long sessions.
- A stable model ID can hide backend changes.
- Usage counts prioritize; they do not justify a removal.

## Appendix — mutation set (2026-10-12 review)

Each line is a deliberate break; a good suite fails on every one.

| # | Mutation | Caught on 2026-10-12 |
|---|---|---|
| 1 | Stop validation gate: drop the session binding | yes |
| 2 | Stop validation gate: retry bound `<` → `<=` | yes |
| 3 | Stop validation gate: no counter reset when the marker is absent | **no** |
| 4 | Read-before-edit: remove the core deny | yes (2 tests) |
| 5 | Read-before-edit: remove the mtime re-read check | yes (1 test) |
| 6 | Read-before-edit: ignore the edit-history exemption | **no** |
| 7 | Read-before-edit: allow Write over an unread existing file | **no** |
| 8 | Recursion guard: `>=` → `>` | yes |
| 9 | Recursion guard: stop guarding Task calls | yes |
| 10 | Recursion guard: effective window 60 s → 5 s | **no** |
| 11 | Delegation gate: drop the deny output | **no** |
| 12 | PostToolUse: stop recording Reads | **no** |
| 13 | UserPromptSubmit: stop deleting the risk-approval marker | **no** |
| 14 | Stop: remove the high-severity escape | **no** |
| 15 | Layer 1: remove the red exit-code check | yes |
