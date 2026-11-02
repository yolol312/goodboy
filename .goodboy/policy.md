# goodboy — project policy

## P1 Language of repo text
- decide: human
- source: CLAUDE.md:5-12
- date: 2026-11-02
- checked: 2026-11-02
English for code comments, commit messages, docs under `docs/`, test names and model-facing hook
text; Korean for `README.md`, `CHANGELOG.md` and user-visible output (systemMessage, statusline).

## P2 Feature freeze until v1.0
- decide: human
- source: CLAUDE.md:16
- date: 2026-11-02
- checked: 2026-11-02
Work follows `docs/stabilization-plan.md`; a new feature outside it is the user's decision.

## P3 A push to main is a release
- decide: human
- source: user 2026-10-16 (recorded in the session memory "Stabilization resume point")
- date: 2026-11-02
- checked: 2026-11-02
Ask the user before merging into main or pushing; after a push, update the installed plugin
(`claude plugin marketplace update goodboy`, `claude plugin update goodboy@goodboy`).

## P4 Version fields move together
- decide: ai
- source: commit 17df5f4 (each release bumps both files and adds a README row)
- date: 2026-11-02
- checked: 2026-11-02
- evidence: `grep '"version"' package.json .claude-plugin/plugin.json` shows one version, and README.md has a `| v<version> |` row
A release bumps `package.json` and `.claude-plugin/plugin.json` to the same version and adds the
version's README row and details block.

## P5 Hook entry files are exempt from changed-line coverage
- decide: human
- source: user 2026-11-02
- date: 2026-11-02
- checked: 2026-11-02
The hooks' `main()` bodies run only in the child processes the tests spawn, so bun's in-process
coverage never measures those lines; spawned-hook tests prove them. Exported helpers that tests
import (`hooks/post-tool-use.ts`, `hooks/session-start.ts`, `hooks/user-prompt-submit.ts`) are
measured; new testable logic belongs in `lib/`.
