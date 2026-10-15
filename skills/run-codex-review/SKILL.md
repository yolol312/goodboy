---
name: run-codex-review
description: Get a read-only Codex second opinion on the uncommitted diff when GOODBOY_CODEX=on, and add its findings to the review result marked `source: "codex"`.
when_to_use: Use once per review round in review-all or review-lead, only when GOODBOY_CODEX is on.
user-invocable: false
effort: low
---

# run-codex-review

Add a second model's review to this round without letting it decide alone.

## Inputs
- `GOODBOY_CODEX` (off by default: it sends the diff to OpenAI under the user's own Codex
  login) and `GOODBOY_CODEX_MODEL` (optional).

## Steps
1. `[ "$GOODBOY_CODEX" = on ] || exit 0` — when off, skip this skill and record nothing.
2. Check the CLI: `command -v codex`. Missing → `codex: {status: "skipped", reason: "codex
   not installed", output: "<command output>"}` and go on with the review.
3. Run it read-only, in the background, with a 10-minute limit (`perl … alarm`: macOS has
   no `timeout`). The model goes in as a TOML string, for the review too (plan M13: the
   config default was refused). With GOODBOY_CODEX_MODEL set:
   `perl -e 'alarm shift; exec @ARGV' 600 codex review --uncommitted -c "model=\"$GOODBOY_CODEX_MODEL\"" -c "review_model=\"$GOODBOY_CODEX_MODEL\"" > "$OUT" 2>&1`
   (without it, leave out both `-c`), with `OUT="$(mktemp -d)/codex.txt"`. Start it with
   `run_in_background`, keep reviewing, and read `$OUT` when it ends.
4. Exit code not 0, a login prompt, or the time limit → `status: "skipped"` with the reason
   and the last 40 lines of output.
5. Parse lines tagged `[P0]` to `[P3]`: P0 and P1 → `high`, P2 → `medium`, P3 → `low`. Each
   becomes a finding with `source: "codex"`, its file and line, the issue text, and as `probe`
   the Codex line plus your own check of it (Read the cited line; drop findings you can show
   are wrong and say so in the summary).
6. Set `codex: {status: "ran"}`.

## Output
- Codex findings and the `codex` status in the same review-write call (record-review).

## Done when
- [ ] With GOODBOY_CODEX=on, the result has `codex.status` `ran` or `skipped` with a reason.

## Never
- Never run Codex with write access or outside this repo; never retry a failed run in a loop.
- Never pass a Codex finding on unchecked; it is a second opinion, not a verdict.
