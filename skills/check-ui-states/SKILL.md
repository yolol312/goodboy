---
name: check-ui-states
description: Check UI states and accessibility — loading, empty, error, disabled, long text, RTL, keyboard and accessible names — and whether the UI exposes what the spec implies.
when_to_use: Use in a UI review or UI test run when components, screens or styles changed.
user-invocable: false
effort: medium
---

# check-ui-states

Find states and capabilities the UI is missing.

## Inputs
- The changed components and screens; the dev-cycle `UIUX.md`, `design/components.html` and
  prototype when they exist; the layer-1 `prototype_diff`.

## Steps
1. For each changed component, list the states it needs: loading, empty, error, disabled,
   long text (overflow), RTL where the product supports it, keyboard focus.
2. Reviewing (static): check each state exists in the design of the code (the branch, the
   copy, the next-action button), semantic elements (no `div` buttons), contrast of the
   tokens, a logical focus order.
3. Testing (runtime, with run-e2e): make each state happen (0 rows, a failed request through
   `page.route`, a delayed response) and assert what is visible during it.
4. `plan-completeness`: capabilities the API or spec has and the UI does not expose; dead-end
   flows; missing create, edit or delete surfaces.
5. Read layer-1 `prototype_diff.mismatches` and decide for each: a design problem or a plain
   omission.
6. Rubric: a control without an accessible name, no focus indicator, a missing error or empty
   state is `medium`; cosmetic is `low`.

## Output
- Findings (review) or acceptance evidence (test); `dimensions_checked` gets
  `ui-ux-accessibility` and `plan-completeness` when assessed.

## Done when
- [ ] Every changed component has its states listed and each one checked or reported missing.

## Never
- Never judge from a screenshot; assert in the browser engine or read the code path.
