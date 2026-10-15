---
name: record-review
description: Write a review result JSON through `cli.ts review-write`, with the fields, severity rubric, dimension rules and verdict rules the Stop gate checks.
when_to_use: Use at the end of every review run, once the findings are known.
user-invocable: false
effort: low
---

# record-review

Record one review result the Stop gate can read.

## Inputs
- Your findings, the files you reviewed, the dimensions you assessed, the category.
- `$GB`: the plugin root (follow-agent-rules).

## Steps
1. `reviewed_files`: every changed file in scope, absolute paths, even those without findings.
2. Each finding: `{file, line?, issue, severity, probe?, source?}`.
   - `severity` rubric:
     - `high`: data loss or corruption, a silent wrong result, a security or trust-boundary
       break, a crash on realistic input, a non-atomic write or race on persistent state,
       an unverified guess built into the code. Rare triggers do not lower data loss.
     - `medium`: missing validation or error handling with recoverable effects, a missing
       test for a real failure mode, avoidable duplication.
     - `low`: style, wording, docs, minor UX.
   - `probe` is required for `high` and `medium`: the command you ran and the output you saw
     (for a static axis, the `file:line` quote and the Grep output).
   - `source: "codex"` only for a finding from run-codex-review.
3. `dimensions_checked`: only the dimensions you really assessed (`bun "$GB/lib/cli.ts"
   review-axes <files>` lists the required ones per axis), never empty: an empty list reads as
   a hallucination review and could clear its findings. Markers: `hallucination` for the
   evidence check (and in a one-pass all-axes run), `infra-config` for an infra review,
   `spec-coverage` for a spec review, `codex` for a Codex-only record. Listing a dimension you
   did not assess is a false record.
4. `unknown_assumptions_checked`: one entry per guess or assumption the main session declared,
   `{assumption, reasonable, note}`; `[]` when it declared none.
5. `verdict`: `pass` (no high, nothing critical), `needs-changes` (any high, or several
   medium), `fail` (systemic, needs the user). A high finding never allows `pass`.
6. With GOODBOY_CODEX=on, add `codex: {status: "ran" | "skipped", reason?, output?}`.
7. Write it:
   `cat <<'JSON' | bun "$GB/lib/cli.ts" review-write` … `JSON`. Leave out `timestamp`.
8. On exit 1, read the errors, fix the JSON and run it again.

## Output
- `{"ok":true,"path":".claude/reviews/<ts>.json",…}` from the CLI; put the path in `artifacts`.

## Done when
- [ ] review-write printed `ok: true`.
- [ ] Every high and medium finding has a probe; the verdict follows the rubric.

## Never
- Never write the JSON file yourself or set `timestamp`.
- Never list a dimension you did not assess, or soften a data-loss finding.
