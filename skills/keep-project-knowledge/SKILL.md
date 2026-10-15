---
name: keep-project-knowledge
description: Create or update the project's knowledge files — .goodboy/policy.md (policies and past decisions, each tagged ai or human) and .goodboy/docs.json (the doc map) — so every session starts from them.
when_to_use: Use in create mode when SessionStart says the project has no policy file, and in update mode at the end of a task that made a decision or changed what a mapped doc describes.
user-invocable: true
effort: high
---

# keep-project-knowledge

Keep the project's knowledge files true, so the next session starts with them.

## Inputs
- Mode: `create` (no policy.md yet) or `update` (task end). `$GB`: the plugin root (two levels
  above this skill's base directory).
- Create: the repo (README, CLAUDE.md, docs, configs, `git log --oneline -50`). Update: the
  task's changes and the decisions the user made during it.

## Steps
1. Create mode, first (the main session; an agent without AskUserQuestion uses the answers its
   prompt gives, or returns BLOCKED with the question): ask once with AskUserQuestion whether
   this directory is a project, options "project (프로젝트)" and "non-project (프로젝트 아님)".
   Non-project: add the line `goodboy: non-project` to this directory's CLAUDE.md and stop.
2. Create mode, a project: draft entries from what the repo says (rules in CLAUDE.md, README
   conventions, configs, recurring commit decisions). Each entry in `.goodboy/policy.md`:
   ```
   ## <id> <title>
   - decide: ai | human
   - source: <file:line, commit, or "user YYYY-MM-DD">
   - date: YYYY-MM-DD
   - checked: YYYY-MM-DD
   - evidence: <the command, test or file check that decides it>   (ai entries)
   <one or two lines: the rule>
   ```
   `ai` when evidence can decide the check; otherwise, or unsure, `human`.
3. Ask the user once, batched in Korean, about every `human` entry and every unknown; record
   the answers as the entries' text and source.
4. Write `.goodboy/docs.json`: `{"docs": [{"path": ".goodboy/policy.md", "session_start": true,
   "covers": []}, {"path": "CLAUDE.md", "session_start": false, "covers": ["<globs>"]}, …]}` —
   the key docs and the code paths each one describes.
5. Update mode: add the task's human decisions as entries (they become `ai` checks when
   evidence can decide them next time), fix entries the change made wrong, refresh `checked`.
6. Keep policy.md within 200 lines: merge or drop stale entries rather than grow it.
7. Check: `bun "$GB/lib/cli.ts" knowledge-check`; fix every problem it lists.

## Output
- `.goodboy/policy.md` and `.goodboy/docs.json` in the project root, committed with the task.

## Done when
- [ ] `cli.ts knowledge-check` prints `{"ok":true}`: both files exist, every entry has decide,
      source, date and checked (and evidence for `ai`), and docs.json marks policy.md
      session-start.

## Never
- Never write the non-project marker without the user's answer.
- Never record a decision the user did not make; ask instead.
