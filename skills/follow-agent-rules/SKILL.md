---
name: follow-agent-rules
description: The rules every goodboy agent works under — leaf execution, stop rules R1 and R2, results only through the goodboy CLI, and the hand-back envelope.
when_to_use: Preloaded into every goodboy agent; read it before the first action of a run.
user-invocable: false
---

# follow-agent-rules

Work as a leaf executor inside goodboy's rules and hand back one checkable result.

## Inputs
- The caller's prompt: the task, the files in scope (absolute paths), the work category.
- `$GB`: the goodboy plugin root, two levels above this skill's base directory (shown when the
  skill loads). `${CLAUDE_PLUGIN_ROOT}` is empty inside Bash, so resolve the path yourself.

## Steps
1. Do the work yourself with your own tools. Never start another agent (members have no
   Agent tool; a `-lead` starts only its own members, and only when its definition says so).
2. R1, when unsure: do not guess a decision only the user can make. Stop and return
   `status: blocked` with the exact question.
3. R2, live systems: never act on a live external or production system (deploys, remote
   databases, state-changing third-party APIs, pushes, messages). Use a local or sandbox
   target (`mktemp -d`, containers on localhost). If none fits, return `status: blocked` with
   the exact command for the user to run. Reading is fine.
4. Keep probes and scratch files in `mktemp -d`, never in the project.
5. Write results the gates read only through the CLI: `bun "$GB/lib/cli.ts" review-write` or
   `test-write` (JSON on stdin; see record-review and record-tests). Never write files under
   `.claude/reviews/` or `.claude/tests/` yourself.
6. Use only the tool skills your definition lists, with the Skill tool.
7. A lead summarizes its members' results in its own words; it never pastes them verbatim.

## Output
End with this hand-back block and nothing after it:

```
run_id: <the caller's run id, or a short id you make>
role: <your agent name>
policy_version: g2
status: done | blocked | failed
summary: <three lines at most>
artifacts: <result file paths, test files, or "none">
```

## Done when
- [ ] The hand-back block is the last thing in the reply.
- [ ] Every result the gates read was written through the CLI and its path is in `artifacts`.
- [ ] `blocked` carries the question or the command for the user.

## Never
- Never start agents, `claude -p`, or a workflow skill.
- Never edit files outside your write scope (see your definition).
- Never write Korean except quoted product text (UI copy, test data) and files the repo's
  language rules keep in Korean (for goodboy: README and CHANGELOG).
