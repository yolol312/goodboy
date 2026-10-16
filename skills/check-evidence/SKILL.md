---
name: check-evidence
description: Hallucination check — verify every claim in code, comments, docs and the main session's rationale against the code and measured facts, and judge each declared assumption.
when_to_use: Use in every review (the hallucination axis runs for any change), and alone when a citation gate keeps blocking.
user-invocable: false
effort: high
---

# check-evidence

Find claims the code or the record does not support.

## Inputs
- The changed files; the main session's rationale (`## 근거` / `## Rationale`, with facts,
  judgments, assumptions and guesses) when the caller passes it.

## Steps
1. Read every changed file. A file you did not read cannot be verified.
2. Calls and imports: for each new call, import or type use, confirm the target exists with
   that signature (Read or Grep the definition; check the version in the manifest and lock
   file for library APIs). A missing or removed API is `high`.
3. Comments and docs in the diff: each statement of behavior, limit or measurement must match
   the code or a measurement you can cite. A wrong one is `medium`; `high` when the code
   relies on it.
4. The rationale, item by item:
   - fact: is it really in the code or the record? If not, `medium`.
   - judgment: does it follow from the facts? A leap is `medium`.
   - assumption (the user said "확인 필요" or did not know): is it reasonable, and does the
     code match it? Unreasonable is `medium`; code that contradicts it is `high`.
   - guess: verify it now (Read, Grep, a probe in `mktemp -d`). An unverified guess built
     into the code is `high`.
5. Project rules: CLAUDE.md, README and the existing patterns; a broken rule is `low` to
   `medium`.
6. Decision authority: `bun "$GB/lib/cli.ts" decisions` lists the ai and human checks. A
   human item the change settles needs the user's decision (in the request, the answers the
   caller passes, or a policy entry): without one, `high` for a project (`policy`) entry and
   `medium` for a goodboy default. An ai item the change relies on needs its evidence: none
   is `medium`.
7. Record each assumption and guess in `unknown_assumptions_checked` with `reasonable` and a
   note on what you checked.

## Output
- Findings and `unknown_assumptions_checked` entries for record-review; add the dimension
  marker `hallucination` to `dimensions_checked`.

## Done when
- [ ] Every new call or import was checked against its definition.
- [ ] Every declared assumption and guess has an entry in `unknown_assumptions_checked`.

## Never
- Never accept a claim because it sounds right; cite the line or the output that shows it.
- Never raise a finding when you agree with a reasonable assumption.
