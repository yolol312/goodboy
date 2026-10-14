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

1. **Feature freeze** — no new gates until v1.0. Exception: track G (§10), approved by
   the user on 2026-10-14.
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
| v0.31.0 | G (routing: rules, roles, tools), which also covers B2, B3 and F7 |
| v0.32.0 | the rest of B (cost) + C (measurement) + F5, F8 |
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
  M6); nothing caps the total number of agents a session spawns by default. A runaway
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
| test | test-ui | browser checks against the prototype, state reproduction | sonnet / high | R, B, J, Br |
| test | test-security | dynamic attacks against a local sandbox only | opus / high | R, B, J |
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
| check-spec-coverage | high | review-spec, test-spec |
| check-security | high | review-security, review-all |
| check-infra-config | high | review-infra |
| check-evidence | high | review-evidence, review-all |
| write-regression-test | high | test-unit, fix-bug |
| probe-runtime | high | test-probe, research-cause |
| attack-sandbox | high | test-security |
| cite-sources | medium | research-web |
| summarize-diff | medium | research-code, reviewers |
| follow-design-tokens | medium | build-frontend, review-ui |
| check-code-quality | medium | review-quality, review-all |
| check-ui-states | medium | review-ui, test-ui |
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
  (read from the transcript). When none fits, the main session records a skill-gap note
  (skills considered, why each did not fit, what skill would) and goes on. Reviews check
  that the note is honest; the monthly review uses the notes to improve or add skills.
  There is no catch-all skill.

### 10.5 Effort and model

- A skill or agent that declares an effort runs at it. When it ends, the session is back at
  the user's own setting (skill effort lasts the invoking turn, agent effort the agent's
  run). Applied without a prompt, with a one-line notice; `GOODBOY_SKILL_EFFORT=auto|ask`.
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
| SessionStart (new) | configuration warnings; record the model |
| PreToolUse, Agent | delegation guards; model and effort check; dispatch log |
| PreToolUse, Bash | block `claude -p`; R2; deny writes from read-only roles |
| PreToolUse, Write/Edit | role limits and result-path limits; skill rule |
| PreToolUse, search | relax H2-03 so small searches run in the main session |
| UserPromptSubmit | task prompts only: R1/R2/delegation lines and a skill or agent suggestion; fixed slash regex; a task is registered once; argument-free commands allowed; the risk gate only from commands the user typed |
| Stop | effort advice; review and test messages from the policy table; accept evidence-backed `BLOCKED`; defer the review and test gates while `background_tasks` lists running agents (M10) |
| PostToolUse, Agent | completion status into the log |

- Libraries: `lib/routing-policy.ts` (one table of roles, models, efforts, tools, caps and
  review/test dispatch), `lib/outward-command.ts`, `lib/diff-coverage.ts`, the gate log
  extended with dispatch and completion records, and `lib/recursion-guard.ts` as a session
  budget.
- Contract tests use independent fixtures, not the policy table itself.
- New env: `GOODBOY_SPAWN_GATE`, `GOODBOY_SPAWN_LIMIT`, `GOODBOY_SPAWN_LIMIT_LEAD`,
  `GOODBOY_OUTWARD_GATE`, `GOODBOY_ROUTING_GATE`, `GOODBOY_SKILL_GATE`,
  `GOODBOY_SKILL_EFFORT`, `GOODBOY_CODEX`. Repo config lives under `.goodboy/`. Renames of
  existing names wait for D1.

### 10.11 Steps

Branch `feat/g-routing`. After each step: tests, typecheck, one all-axes review, one
`/verify` probe, README (Korean) updated, and the user's OK before the next step.

| Step | Contents |
|---|---|
| G0 | This plan; the measurements in §10.12 |
| G1 | Rules (§10.5–10.7, §10.10), tests first. The audit of existing reason- and count-based escapes comes last |
| G2 | Tool skills and the 24 agents together, since agents depend on the skills; the two renames; capability checks; leads enabled last |
| G3 | Workflow skills: slimmed, renamed, effort set |

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
| M15 | Can a hook force a lead's member calls into the foreground, and do they still run in parallel? | Yes. A PreToolUse rewrite to `run_in_background: false` on Agent calls made by an agent: two calls in one message started 0.25 s apart, ran at the same time (about 3 s each), and the lead returned both results merged | the delegation guard rewrites every agent-made Agent call to the foreground |

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
