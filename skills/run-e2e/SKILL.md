---
name: run-e2e
description: Run Playwright end-to-end tests through Bash against a local server, asserting in the browser engine and comparing with the dev-cycle prototype.
when_to_use: Use for UI and acceptance flows (UIUX-*, PT-* criteria) when a browser test is needed.
user-invocable: false
effort: medium
---

# run-e2e

Prove UI behavior with assertions the browser engine checks.

## Inputs
- The app's start command, the flows or criteria to cover, the dev-cycle prototype path when
  it exists.

## Steps
1. Start the app locally (container or dev script) and wait for the port (`curl -sf`).
2. Use the project's Playwright; if it is missing, add it as a dev dependency (`bun add -d
   @playwright/test && bunx playwright install chromium`). If that is impossible, record it
   in the suite output and leave UI criteria uncovered.
3. Assert with the engine: `toBeVisible()`, a real `click()` (overlays and `pointer-events`
   make it fail), `getByRole(…, { name })`, `scrollWidth > clientWidth` for overflow, the
   rendered colors from `getComputedStyle`, console errors and 4xx/5xx responses, state kept
   after a reload.
4. States: make them happen (0 rows; `page.route` returning 500; a delayed response, asserted
   during the delay).
5. Prototype comparison: open it with `file://` at the same viewport; compare inside
   `.pt-frame` only (skip `pt-` controls), against the `after` state; the `before` state is
   for `PT-REGRESSION` (items equal in both stay equal). Compare structure, classes,
   capabilities and states, never mock values or pixels. Record mismatches with selectors.
6. Screenshots only as evidence attached to a failure; assertions decide.
7. Stop what you started (`docker compose down`, kill the dev server).

## Output
- E2E test files in the repo, suite entries with `type: "e2e"` (or `"ui"`) and
  `duration_ms`, and `prototype_diff.mismatches` for record-tests.

## Done when
- [ ] Each covered criterion has a passing assertion and a detected mutation.
- [ ] Nothing you started is still running.

## Never
- Never judge UI from a screenshot or from reading code; never point a test at a shared host.
