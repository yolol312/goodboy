# Review-Corpus — "test the reviewer" regression corpus

This corpus guards against the **review silently regressing** — going back to
rubber-stamping after the review agents (`agents/review-*.md`) or their check skills
(`skills/check-*/SKILL.md`; before G2, `agents/review-changes.md`) are edited. Each dimension has a
minimal `bad/` sample containing ONE clearly-seeded defect and a `good/` sample
with that defect fixed. An `EXPECTED.json` in each variant states the
machine-checkable contract: `{dimension, minSeverity, changedFiles, oneLineDefect}`.

## Layout

```
fixtures/review-corpus/
  web-hardening/        error-path / source-leak via unhandled decodeURIComponent throw
    bad/server.ts       Bun.serve, decodeURIComponent(cookie), NO try/catch, NO error handler
    good/server.ts      guarded (try/catch → 400) + explicit error handler (no leak)
    {bad,good}/EXPECTED.json
  ui-ux-accessibility/  icon-only button, unlabeled inputs, outline:none with no replacement
    bad/index.html      no accessible name / no <label> / *:focus{outline:none}
    good/index.html      aria-label + <label for> + :focus-visible
    {bad,good}/EXPECTED.json
  proto-pollution/      JSON-body merge that pollutes Object.prototype
    bad/merge.ts        setByPath walks dotted keys with no __proto__/constructor guard
    good/merge.ts       allow-list copy + dangerous-segment rejection
    {bad,good}/EXPECTED.json
  BASELINE.md           recorded live-review results (the documented baseline)
  README.md             this file
```

## Two layers of protection

1. **Deterministic guard test** (`tests/review-corpus-guard.test.ts`) — machine-checkable.
   For each `EXPECTED.json`, asserts `requiredDimensionsFor(changedFiles)` includes the
   expected dimension. If someone weakens the file→dimension mapping in
   `lib/review-dimensions.ts`, this test fails. Runs in plain `bun test`.

2. **Live LLM-review baseline** (`BASELINE.md`) — the documented, repeatable proof that
   the *actual review* (following the check skills' mandatory probes) catches
   each seeded defect at the expected dimension + severity on `bad/`, and stays clean on
   `good/`. This is not run by `bun test` — it is a human/agent-driven baseline you
   re-run when the check skills (or the probe set) change.

## How to re-run the live baseline

Act as the reviewer following `skills/check-security` and `skills/check-ui-states` and run the **real**
probes (no static reading). For convenience the exact probes used last time:

### web-hardening (error-path / source leak)
```bash
# decodeURIComponent throws on malformed percent-encoding:
bun -e 'try{decodeURIComponent("%ZZ")}catch(e){console.log("THROWS",e.constructor.name)}'

# live server: boot bad/ or good/server.ts (prints {"port":N} on stdout), then:
curl -s -w 'HTTP %{http_code}\n' "http://localhost:PORT/" -H 'Cookie: %ZZ'
#   bad/  → HTTP 500 + Bun dev-overlay body + source leaked on server stderr  → finding: error-path, HIGH
#   good/ → HTTP 400 "bad request", clean stderr                              → no finding
# NOTE: use a RAW header (-H 'Cookie: %ZZ'); curl's --cookie re-encodes and hides the defect.
```

### ui-ux-accessibility (medium)
Headless load both pages at desktop (1024px) and mobile (≤400px) widths, screenshot,
and **read the screenshot**. Audit accessible names / labels / focus indicator:
```bash
# Playwright chromium (cached under ~/Library/Caches/ms-playwright):
PLAYWRIGHT_BROWSERS_PATH=$HOME/Library/Caches/ms-playwright bun /path/to/shot.ts <file.html> <out.png> <width>
#   bad/  → 1 button w/o accessible name, 2 inputs w/o <label>, outline-style:none + no :focus-visible → ui-ux-accessibility, MEDIUM
#   good/ → 0/0, :focus-visible present                                                                → no finding
```

### proto-pollution (high)
```bash
bun -e 'import {applyJson} from "./bad/merge.ts"; applyJson({}, JSON.stringify({"__proto__.polluted":true})); console.log("polluted:", ({}).polluted)'
#   bad/  → polluted: true  (Object.prototype polluted) → proto-pollution, HIGH
#   good/ → polluted: undefined                          → no finding
```

After running, update the table in `BASELINE.md` (fixture → caught? → dimension →
severity → pass/fail) and note any fixture the review **failed** to catch — a miss is an
important finding, not a thing to hide.
