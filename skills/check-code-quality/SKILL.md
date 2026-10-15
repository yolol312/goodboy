---
name: check-code-quality
description: Design and performance check — duplication, cohesion, complexity, dead code, misleading names and hot paths, with measurements where it matters (not lint).
when_to_use: Use in a quality review or an all-axes review; skip what lint and the type checker already enforce.
user-invocable: false
effort: medium
---

# check-code-quality

Find what raises the cost of keeping the code right, and what makes it slow.

## Inputs
- The changed files and the summarize-diff map.

## Steps
1. `refactoring-quality`, static; quote `file:line` and the Grep output as the probe:
   - duplication: Grep for code that does the same thing; a copy of a reusable piece is
     `medium`;
   - cohesion and coupling: one function mixing concerns, a new import cycle;
   - complexity: deep nesting plus long functions, `low` to `medium`;
   - dead code: code the change made unreachable, exports nothing uses;
   - names that say something other than what the code does;
   - mixed levels (low-level byte work next to policy in one function);
   - a problem solved differently from the rest of the project.
2. `performance`: synchronous IO on a request path, a full rewrite per request, N+1 queries,
   structures that grow without bound, repeated work in a loop. Measure when you can: run it
   in `mktemp -d` at N = 10, 100, 1000 and quote the timings. Name every one, with a severity
   that fits the scope (`low` to `medium` for a demo).
3. Drop taste: "prettier this way" is not a finding. Keep what costs maintenance or time.

## Output
- Findings for record-review; `dimensions_checked` gets `refactoring-quality` and
  `performance` (`review-axes` requires both for any code file).

## Done when
- [ ] Both dimensions were assessed for every code file in scope.
- [ ] Every duplication finding names the other place; every performance finding has a
      measurement or a quoted hot path.

## Never
- Never report lint-level style; never edit the code.
