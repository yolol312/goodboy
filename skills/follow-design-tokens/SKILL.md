---
name: follow-design-tokens
description: Use, or check the use of, the project's design tokens and dev-cycle prototype instead of literal colors, sizes and spacing.
when_to_use: Use when building or reviewing components, styles or screens in a project with tokens or a prototype.
user-invocable: false
effort: medium
---

# follow-design-tokens

Keep UI values tied to the design system the project already has.

## Inputs
- The changed UI files; the token source (CSS variables, a theme file, Tailwind config, a
  design-system package); the dev-cycle `design/` files and prototype when they exist.

## Steps
1. Find the tokens: Grep for `--color-`, `theme.`, `tokens`, `tailwind.config`; read the
   prototype's CSS variables.
2. Building: map every color, font size, spacing, radius and shadow to a token; reuse existing
   components before making new ones; match the prototype's structure and classes inside
   `.pt-frame`.
3. Reviewing: Grep the diff for literals (`#[0-9a-f]{3,8}`, `rgb(`, `\d+px`, raw font
   stacks). Each literal with a matching token is a finding (`low`; `medium` when it breaks
   theming or dark mode). A component that duplicates an existing one is `medium`.
4. A value with no token: keep the literal and note that the design system lacks it.

## Output
- Building: code that uses tokens, and a note of missing tokens in the hand-back.
- Reviewing: findings for record-review (dimension `ui-ux-accessibility`).

## Done when
- [ ] Every literal value in the changed UI code maps to a token or is noted as missing one.

## Never
- Never add new tokens or change the theme without the caller asking.
