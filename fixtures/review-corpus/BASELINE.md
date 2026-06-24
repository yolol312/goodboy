# Review-Corpus Live Baseline

This file records a **live run of the strengthened review** (`agents/review-changes.md`
§7.5 conditional quality dimensions) against each fixture in this corpus. The leaf
executor acted as the reviewer and ran the **mandatory runtime probes** (not static
reading) against every `bad/` and `good/` sample.

It answers: does the current review catch each seeded defect at the **expected
dimension + ≥ expected severity** on `bad/`, and stay **clean (no false high)** on `good/`?

- Run date: 2026-06-16
- Probe tooling: real `curl` against a live `Bun.serve`; real `decodeURIComponent`
  throw probe; real Playwright (chromium) headless load + DOM/focus audit +
  screenshot-then-read; real `__proto__.polluted` pollution probe in Bun.
- Re-run instructions: see `README.md` in this directory.

## Results

| Fixture | Variant | Mandatory probe run | Seeded defect caught? | Dimension | Severity | Pass/Fail |
| --- | --- | --- | --- | --- | --- | --- |
| web-hardening | bad | `curl -H 'Cookie: %ZZ'` → live `bad/server.ts` | YES — HTTP 500 + Bun dev error overlay in body (`__bunfallback` blob) + **source code leaked in stderr** (lines 9-14 of server.ts) + `URIError` | error-path / web-hardening | **high** (source/internals leak via unhandled throw) | **PASS** |
| web-hardening | good | same probe → live `good/server.ts` | n/a (fixed) — HTTP 400 "bad request", no throw, no leak, clean stderr | error-path | none | **PASS** (no false high) |
| ui-ux-accessibility | bad | Playwright load (1024px + 390px) + DOM audit + focus probe + screenshot read | YES — 1 icon-only button w/ no accessible name; 2 inputs w/ no `<label>`; `*:focus{outline:none}` and **no `:focus-visible` replacement** (computed `outline-style:none`) | ui-ux-accessibility | **medium** | **PASS** |
| ui-ux-accessibility | good | same probe → `good/index.html` | n/a (fixed) — 0 buttons w/o name, 0 inputs w/o label, `:focus-visible` rule present (computed `outline-style:solid`); labels "Query"/"Tag" visible in screenshot | ui-ux-accessibility | none | **PASS** (no false high) |
| proto-pollution | bad | `applyJson({}, '{"__proto__.polluted":true}')` then read `({}).polluted` | YES — `({}).polluted === true` → **Object.prototype polluted** | proto-pollution | **high** | **PASS** |
| proto-pollution | good | same probe → `good/merge.ts` | n/a (fixed) — `({}).polluted === undefined`; legitimate `theme` field still applied; dangerous path dropped | proto-pollution | none | **PASS** (no false high) |

## Raw probe evidence

### web-hardening
```
BAD  (Cookie: %ZZ)  → HTTP 500, body starts: <!doctype html> ... <script id="__bunfallback" type="binary/peechy"> (Bun dev error overlay)
                       stderr leaks source: "14 | const sid = decodeURIComponent(cookie);  ^  URIError: URI error"
GOOD (Cookie: %ZZ)  → HTTP 400, body: "bad request", stderr clean (no source/stack)
BAD/GOOD (Cookie: sid=abc) → HTTP 200, body: "session: sid=abc"
```

### ui-ux-accessibility
```
BAD  DOM audit (1024 & 390px): {"buttonsNoName":1,"inputsNoLabel":2,"totalInputs":2,"totalButtons":1}
BAD  focus probe: {"outlineWidth":"3px","outlineStyle":"none","hasFocusVisibleRule":false}
GOOD DOM audit:  {"buttonsNoName":0,"inputsNoLabel":0,"totalInputs":2,"totalButtons":1}
GOOD focus probe: {"outlineWidth":"2px","outlineStyle":"solid","hasFocusVisibleRule":true}
(screenshots read: BAD shows unlabeled fields + magnifier-only button; GOOD shows "Query"/"Tag" labels)
```

### proto-pollution
```
BAD:  applyJson({}, '{"__proto__.polluted":true}') → ({}).polluted = true   [Object.prototype POLLUTED]
GOOD: applyJson({theme:"light"}, '{"__proto__.polluted":true,"theme":"dark"}')
      → ({}).polluted = undefined ; target = {"theme":"dark"}   [clean, legit field applied]
```

## Summary

| | bad caught at expected dim/severity | good clean (no false high) |
| --- | --- | --- |
| web-hardening (error-path, high) | YES | YES |
| ui-ux-accessibility (medium) | YES | YES |
| proto-pollution (high) | YES | YES |

**3/3 seeded defects caught at the expected dimension and severity; 3/3 good fixtures
clean.** The strengthened review + dimension mapping currently catches what it should.

### Mapping gap found and fixed during baselining

While wiring the deterministic guard, `requiredDimensionsFor(["merge.ts"])` returned
only `["performance"]` — the proto-pollution surface was **not** required for a file
named `merge.ts` (the input-parser heuristic keyed on parse/json/body/… but not on
merge/assign/extend). This is precisely the silent weakening the corpus guards against.
Fixed by broadening `looksLikeInputParser` to include `merge|assign|extend`, so a
JSON-body merge utility now requires `proto-pollution` + `error-path`. `util.ts` still
maps to `performance` only (no over-detection regression).
