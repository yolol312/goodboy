# goodboy — repo notes

## Language

This repo follows the global language policy in `~/.claude/CLAUDE.md`. Repo specifics:

- English from now on: code comments, commit messages, docs under `docs/`, test names,
  and model-facing hook text (deny/block reasons, additionalContext).
- Korean stays (product UI for Korean users): `README.md`, `CHANGELOG.md`, and
  user-visible output (systemMessage warnings, statusline).
- Existing Korean comments and messages are translated only as part of
  `docs/stabilization-plan.md` F7/F8, together with the tests that assert them.

## Plan

Current work follows `docs/stabilization-plan.md` (feature freeze until v1.0).
