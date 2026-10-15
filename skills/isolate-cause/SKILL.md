---
name: isolate-cause
description: Narrow a failure to its cause by bisecting inputs, commits and config with a minimal reproduction, and keep a table of hypotheses with evidence.
when_to_use: Use when something fails and the cause is not yet known; it finds causes, it does not fix them.
user-invocable: false
effort: high
---

# isolate-cause

Find why it fails, with evidence for each step.

## Inputs
- The symptom (error text, wrong output), how to reproduce it, when it last worked if known.

## Steps
1. Reproduce it in the smallest form you can (one command, one input). No repro: return
   `status: blocked` with what is missing.
2. Write hypotheses, each with a test that would confirm or kill it.
3. Narrow by halving, one dimension at a time:
   - commits: `git bisect run <repro>` between a good and a bad commit (in a worktree:
     `git worktree add "$(mktemp -d)" <rev>`);
   - inputs: cut the failing input in half until the smallest failing piece is left;
   - config and env: remove settings one at a time.
4. Run each test; record its command and output; mark the hypothesis confirmed or killed.
5. Stop at the first confirmed cause that explains every symptom; name the `file:line`.

## Output
A table for the caller:

```
| hypothesis | test command | output (key line) | status |
| cache key ignores locale | LANG=ko bun repro.ts | "expected ko, got en" | confirmed |
cause: <file:line> — <one sentence>
```

## Done when
- [ ] The cause is confirmed by a test whose output shows it, and it explains every symptom.

## Never
- Never change project code to "see if it helps"; experiments go in a worktree or temp dir.
- Never call a hypothesis confirmed without its output.
