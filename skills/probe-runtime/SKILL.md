---
name: probe-runtime
description: Answer a runtime question with a short experiment in a temp dir — a repro, CSP or CORS behavior, a limit, a timing — and report command and output pairs.
when_to_use: Use when a claim about behavior can be checked faster by running it than by reading.
user-invocable: false
effort: high
---

# probe-runtime

Settle one question about runtime behavior with evidence.

## Inputs
- The question ("does X throw on Y?", "what is the limit of Z?"), and the code or tool it is
  about.

## Steps
1. Write the question as a yes/no or a number, and what result would answer it.
2. Make a sandbox: `P="$(mktemp -d)"`; copy or import only what the probe needs.
3. Write the smallest program that answers it (a `bun -e` line, a script, a `curl` against a
   server started on localhost).
4. Run it; vary one input at a time (N = 10, 100, 1000; a valid and a malformed input).
5. Run it twice when timing matters; report both.
6. Delete the sandbox when done, and stop anything you started.

## Output
Pairs for the caller (or a finding's `probe`):

```
question: <it>
$ <command>
<output>
answer: <yes | no | value>, because <the line of output that shows it>
```

## Done when
- [ ] The answer cites the output line that shows it.

## Never
- Never probe inside the project tree or against a shared or remote host (R2).
- Never report an answer the output does not show.
