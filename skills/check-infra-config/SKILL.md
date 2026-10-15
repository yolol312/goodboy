---
name: check-infra-config
description: Review container, CI and server config for safety — exposed ports, secrets in config, privileges, resource limits, pinned versions and a rollback path.
when_to_use: Use in an infra review when Dockerfiles, compose files, CI workflows, Kubernetes or server config changed.
user-invocable: false
effort: high
---

# check-infra-config

Find config that is unsafe to apply or impossible to roll back.

## Inputs
- The changed config files (Dockerfile, compose, CI workflows, manifests, nginx and the like).

## Steps
1. Validate the syntax locally: `docker compose config`, `actionlint`, `kubectl apply
   --dry-run=client -f`, `nginx -t` in a container, whichever exists. Quote the output.
2. Exposure: ports bound to `0.0.0.0` that should be local, debug endpoints, admin panels,
   permissive CORS.
3. Secrets: values in config or images (`ENV PASSWORD=`, tokens in workflow files, `.env`
   copied into an image); real values are `high`.
4. Privilege: root users, `privileged: true`, host mounts, broad CI permissions
   (`permissions: write-all`), unpinned third-party actions.
5. Limits: no memory or CPU limits, no health checks, restart loops.
6. Versions: `latest` tags and unpinned base images.
7. Rollback: is there a previous version to return to, and is the change reversible (data
   migrations, removed volumes)? A change with no way back is `high`.

## Output
- Findings with the validation output as probes, for record-review.

## Done when
- [ ] Each changed config file was validated or the missing validator was named.

## Never
- Never apply config to a shared or production environment (R2); dry runs and local only.
