---
name: check-security
description: Security check with runtime probes in a temp dir — secrets, injection, authorization, dependencies, web hardening, error paths and prototype pollution.
when_to_use: Use in a security review, or in an all-axes review of code that handles input, auth, secrets, dependencies or HTTP.
user-invocable: false
effort: high
---

# check-security

Find vulnerabilities by running probes, not by reading alone.

## Inputs
- The changed files and what they handle: input parsing, queries or commands, auth,
  manifests, an HTTP server.

## Steps
Run each probe in `mktemp -d` or against an instance you started on localhost, and keep the
command and output for the finding's `probe`. Assess every security dimension `bun
"$GB/lib/cli.ts" review-axes <files>` lists (`security-secrets` for any code file), and no other.
1. `security-secrets`: `grep -nE '(api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]'`
   on the changed files; a real value (not a placeholder) is `high`.
2. `security-injection`: feed `'; DROP--`, `$(id)` and backticks into the input that reaches a
   query or a command; string concatenation without binding is `high`.
3. `security-authz`: request another user's resource id; success is `high` (IDOR). Check token
   expiry and signature checks, and checks done only in the client.
4. `dependency-risk` (manifest or lock file changed): who the new package is, whether it is
   needed, `npm audit` / `bun audit` where available, ranges without a lock file.
5. `web-hardening` (HTTP server code): send real requests; check CSP, X-Frame-Options,
   X-Content-Type-Options, Referrer-Policy, 405 with `Allow`, 404, HEAD, an explicit error
   handler, body and field size limits. Source, stack or path leaks without auth are `high`;
   no size limit is `medium`.
6. `error-path` (external input parsing): malformed percent-encoding (`%ZZ`), cut and oversized
   input; a reachable unhandled throw is `high` when exposed, else `medium`.
7. `proto-pollution` (JSON or user-keyed objects): send `__proto__`, `constructor` and nested
   keys; polluted state or `Object.prototype` is `high`.

## Output
- Findings with probes for record-review; `dimensions_checked` lists only the dimensions you
  assessed.

## Done when
- [ ] Each assessed dimension has at least one probe command and its output.

## Never
- Never probe a live or shared system; localhost and temp dirs only (R2).
- Never give a verdict from reading alone on input or HTTP code.
