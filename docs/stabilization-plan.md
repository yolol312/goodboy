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
   (§14, project knowledge, v0.32.0), both approved by the user on 2026-10-14.
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
| v0.32.0 | the rest of B (cost) + C (measurement) + F5, F8, and track H (knowledge; branch `feat/h-knowledge`, stacked on `feat/g-routing`) |
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
- Coverage, measured and recorded, not a gate (`measure-coverage`):
  - line and branch coverage from the project's own tool (bun, vitest, jest, pytest-cov,
    JaCoCo, go cover); nothing is installed, and a missing tool is recorded as
    `unavailable` with the reason;
  - changed-line coverage: the report (lcov, Cobertura, JaCoCo XML, Go profile) against the
    diff, in `lib/diff-coverage.ts`;
  - JS coverage of E2E runs on Chromium;
  - mutation detection rate.
  - The existing coverage checks (acceptance criteria, changed files, review axes) stay.
  - A warning when a code file in `tested_files` has no executed changed line. Whether it
    becomes a block is decided after a month of data.
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
| PreToolUse/post hooks, Bash | gate state guard (`lib/state-guard.ts`): a command that changes a goodboy session dir is denied; the guarded files are snapshotted before each Bash call and restored after it (or at the next Stop); `.goodboy/hosts` production entries cannot be removed by the model (Edit/Write denied, a Bash removal restored), and the files are merged up the tree; files an interpreter or nested shell wrote are recorded as edits (`lib/write-sweep.ts`); a shell write into `.claude/tests` or `.claude/reviews` is a project write (results come only from the CLI) |
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
- `/Users/seongmo/ccworkspace/CLAUDE.md` gets the marker only with the user's OK.

### 14.3 Policy file, read gate and the knowledge skill (H2)

- `.goodboy/policy.md`, git-managed and committed in every repo: one `## <id> <title>`
  section per entry with `decide: ai|human`, `source:`, `date:` and `checked:` lines (and
  `evidence:` for an `ai` entry). Size budget: 200 lines; SessionStart warns above it.
- `.goodboy/docs.json`, the doc map: `{"docs": [{"path", "session_start", "covers": [globs]}]}`.
- SessionStart (all four sources, project mode): names the required files (policy.md and the
  `session_start` docs) and tells the model to Read them first; a missing policy.md asks for
  the skill's create mode, with a Korean notice to the user.
- Read gate (PreToolUse, main session only; subagents get the policy in their prompt): until
  each required file has a full Read in this session, every other tool is denied with the
  unread files named. Evidence is the read log; partial reads count when their ranges cover
  the file. A Read is required again after a compaction and when the file changed since the
  read (not by this session's own edits). Always allowed: Read, the knowledge skill,
  AskUserQuestion, ToolSearch. The required files are exempt from the re-read gate. An
  unreadable file fails open with a warning. No model-side escape; `GOODBOY_POLICY_GATE=off`
  for the user.
- The skill `keep-project-knowledge` (§10.4 format, user-invocable too): create mode asks
  once whether the directory is a project (not one: write the marker; one: scan README,
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
