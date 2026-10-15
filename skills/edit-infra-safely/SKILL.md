---
name: edit-infra-safely
description: Change container, CI or server config with a local validation command and a written rollback, never against production.
when_to_use: Use for edits to Dockerfiles, compose files, CI workflows, Kubernetes manifests or server config.
user-invocable: false
effort: high
---

# edit-infra-safely

Make an infra change that is validated before it is applied and easy to undo.

## Inputs
- The change to make, the config files, the environments they apply to (from
  `.goodboy/hosts` and the files themselves).

## Steps
1. Find where the config applies. Anything marked production, or unknown, is not applied here.
2. Record the current state: `git diff` is empty for the files, or copy them to `mktemp -d`.
3. Make the edit with the smallest change that does the job; pin versions and keep secrets
   out of the files (use the secret store or env the project already uses).
4. Validate locally: `docker compose config`, `docker build`, `actionlint`, `kubectl apply
   --dry-run=client -f`, `terraform validate` / `plan` against a local or sandbox backend.
5. Run it locally when possible (`docker compose up -d --wait`, then stop it).
6. Write the rollback: the exact commands that return to the old state, and anything that
   cannot be undone (data volumes, migrations, deleted resources).

## Output
- The edited files, the validation output, and the rollback note in the hand-back.

## Done when
- [ ] The validation command ran and passed; its output is in the hand-back.
- [ ] The rollback note lists the commands and what cannot be undone.

## Never
- Never apply, deploy or push to a shared or production environment (R2): return `blocked`
  with the command for the user.
- Never put a secret value in a config file or an image.
