---
name: write-api-contract
description: Write or update the API contract — request and response types, error shapes, status codes — before the code, in one file both the server and the client use.
when_to_use: Use before building or changing an endpoint that a frontend or another service calls.
user-invocable: false
effort: high
---

# write-api-contract

Fix the shape of an API before either side codes against it.

## Inputs
- The endpoint's purpose, the callers, the project's existing contract format (OpenAPI,
  shared TypeScript types, zod or JSON Schema, protobuf).

## Steps
1. Find the existing contract and follow its format and location; with none, use shared types
   in the place both sides import from.
2. Write the request: method, path, path and query parameters, body type, auth requirement.
3. Write each response: success type, and every error with its status code and body shape
   (validation 400 with field errors, 401, 403, 404, 409, 5xx).
4. Note limits and rules: size limits, pagination, idempotency, rate limits, versioning.
5. Check compatibility with current callers: removed or renamed fields and new required
   fields are breaking; mark them and add a migration note.
6. Add a contract test or schema check the project's test runner runs (a request validated
   against the schema, a type test).

## Output
- The contract file path and a short change note (added, changed, breaking) in the hand-back.

## Done when
- [ ] Every response, errors included, has a type and a status code.
- [ ] Breaking changes are marked, or there are none.

## Never
- Never change a published contract silently; never leave an error shape as `any`.
