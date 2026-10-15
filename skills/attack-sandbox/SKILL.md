---
name: attack-sandbox
description: Run dynamic attacks — injection, auth bypass, IDOR, path traversal, SSRF, oversized input — against a local sandbox of the app only, and record each attack and its result.
when_to_use: Use in a security test run when the change touches input handling, auth or file and network access.
user-invocable: false
effort: high
---

# attack-sandbox

Attack a local copy of the app and record what got through.

## Inputs
- The app's start command or compose file, the endpoints or functions the change touches,
  test accounts or fixtures.

## Steps
1. Start a sandbox on localhost only: `docker compose up -d --wait`, or the dev script with
   a temp database (`mktemp -d`). Confirm it answers and that its URL is `localhost` or
   `127.0.0.1`.
2. Make two users (A and B) in the sandbox data.
3. For each touched endpoint, run the attacks that apply and keep command and response:
   - injection: `'; DROP--`, `$(id)`, `{{7*7}}`, `<script>` in each input;
   - auth: no token, an expired or tampered token, a role that should be refused;
   - IDOR: user A asks for user B's id;
   - path traversal: `../../etc/passwd`, encoded `%2e%2e%2f`;
   - SSRF (URL inputs): `http://127.0.0.1:<admin port>`, `file:///etc/passwd`;
   - size: a body or field far over any sane limit; a deeply nested JSON.
4. A response that leaks data, runs input, or accepts what it should refuse is a failure:
   write a test that reproduces it (write-regression-test) so it stays guarded.
5. Stop the sandbox and remove its data.

## Output
- A suite entry (`type: "integration"`) with the attack runs, tests for each failure, and the
  attacks that passed and failed in the summary, for record-tests.

## Done when
- [ ] Every attack ran against localhost and has its command and response recorded.
- [ ] The sandbox is stopped.

## Never
- Never attack a shared, staging or remote host, even one marked `allow` (R2).
- Never use real user data or credentials.
