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

1. **Feature freeze** — no new gates until v1.0.
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
| v0.30.0 | A (fixes) + F1–F4 (language-policy prerequisites) |
| v0.31.0 | B (cost) + C (measurement) + F5–F8 |
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
- Per-session recursion-guard cap (the observed incident pattern, identical prompts, is already caught).
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
| F5 | Measure tokens, Korean vs English, for the per-prompt injection and both agent definitions; go/no-go for F7/F8 | 9 |
| F6 | Global policy applied (done), with a temporary clause that keeps tool-parsed Korean keys verbatim until F1/F3 ship | 1, 2, 4 |
| F7 | Translate high-frequency model-facing text: per-prompt injection (with B3), `agents/review-changes.md`, `agents/test-changes.md`, English JSON output | cost |
| F8 | Translate the remaining hook deny/block reasons and update the affected tests (A4/A7/A8/A9 already translated the messages they touched) | 7 |
| F9 | dev-cycle: English templates (keys per F1), Korean key-decision summary at each gate, preview HTML `lang` (`en` for docs, the product language for prototypes), check Chrome translation on `file://` previews | 3, 8 |
| F10 | Verify with tests and `/verify`: same behavior, no safeguard flags | 9 |

After F1 and F3 ship, remove the temporary "tool-parsed keys" clause from the global policy.

Order: A → F1–F4 → B with F5–F8 → F9 → C, D.

## 10. Exit criteria for v1.0

- No known high-severity issues; CI green on macOS and Linux.
- Core-decision mutation survival ≤ 1 of the 15 in the appendix.
- Gate-log over two weeks: at most one false block per gate per session (improvement-plan §2.3).
- Four weeks without a fix chain in one area (three or more consecutive fixes).
- One person other than the author installs, updates, and removes goodboy using only the docs.

## 11. Corrections to improvement-plan.md

- §2.2.4 state scoping must also cover repo-level state (cursors, retry counters), not only `agent_id`.
- §2.2.5 "PreToolUse warnings never reach the agent" was contradicted once on 2026-10-12
  (a subagent received rationale-gate guidance). Re-measure before relying on it; it affects the H2-03 default.

## 12. Assumptions

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
