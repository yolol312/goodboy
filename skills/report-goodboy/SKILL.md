---
name: report-goodboy
description: Write a field report about goodboy itself (a gate that blocked wrongly, a hook error, a slow or confusing check) to the local inbox ~/.claude/goodboy/inbox/, with the session's evidence attached by goodboy, and, if the user agrees, file its public summary as an issue on goodboy's repo.
when_to_use: Use when the user asks to report a goodboy problem or idea (/report-goodboy), or agrees to a report goodboy suggested; never on your own.
user-invocable: true
effort: medium
---

# report-goodboy

Turn trouble with goodboy into one report its maintainer can check and plan from.

## Inputs
- `$GB`: the plugin root (two levels above this skill's base directory). Run the CLI from the
  project's directory, never after `cd "$GB"`.
- What happened in this session, and the user's own words about it.
- The evidence: `bun "$GB/lib/cli.ts" report-evidence` (versions, gate decisions, retry
  counters, the last gate-log lines) for this session; `--session <id or tag>` picks another
  session of this directory (the user's other terminal, say).

## Steps
1. Run `report-evidence`; read the gate lines that match the trouble. Look at the commands or
   files involved; never guess a cause you did not see. A cause you only suspect goes in
   `suspected_causes`, an open question in `unknowns`.
2. Write the report in English as JSON with exactly these fields:
   `title`, `observed`, `expected`, `user_words` (quoted as the user wrote them, any
   language), `involved` (commands or files), `suspected_causes`, `proposed_change`,
   `unknowns`, and `public_summary` `{title, body}`.
3. The public summary may become a public issue: describe goodboy's behavior only. Leave out
   project and company names, paths, hosts, URLs, people, emails, package names and secrets;
   say "a Java project", "a test file". No quotes, backticks, `$` or backslashes in its title.
4. `cat <<'JSON' | bun "$GB/lib/cli.ts" report-write` … `JSON`. On exit 1, fix what it lists:
   fill a template gap; remove a private detail or say it generically, never respell it. Run
   it again. It prints the report's `path`, the `public_path` and the `issue_title`.
5. Tell the user in a short Korean summary what the report says and where it is, then show
   the `public_path` file's text exactly as it would be posted (it goes out under their
   GitHub account).
6. Ask once with AskUserQuestion whether to file that exact text on goodboy's repo (public):
   options to file it, or keep it local only. Only on "file": `gh issue create --repo
   yolol312/goodboy --title "<issue_title>" --body-file "<public_path>"`, and give the URL.
7. Record the choice: `bun "$GB/lib/cli.ts" report-filed "<path>" --issue <URL>`, or
   `--local` (then it is never filed later).

## Output
- `<inbox>/<time>-<slug>.json` (the full report and goodboy's evidence, kept local) and
  `<time>-<slug>.public.md` (the public summary as the issue body).
- With the user's yes, one issue on yolol312/goodboy whose title starts with `[field-report]`.

## Done when
- [ ] `report-write` printed `{"ok":true,…}` and the user got the Korean summary.
- [ ] The user chose whether the public summary is filed, and `report-filed` recorded it;
      nothing was filed without that choice.

## Never
- Never file an issue, or send the report anywhere, without the user's explicit yes.
- Never put the local report (paths, project details, gate-log reasons) in an issue.
- Never edit goodboy's own files or the inbox by hand to make a report pass.
- Never report on your own initiative; the user asks, or agrees to a suggestion.
