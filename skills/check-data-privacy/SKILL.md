---
name: check-data-privacy
description: Privacy check of a real-data sandbox setup and of the source files that use its data helper — data access, output channels, artifact mounts, helper assertions and exports — judged on what the code can do with the data, not on helper names.
when_to_use: Use in a data-privacy review, or in an all-axes review, when the changed files are sandbox files, `.goodboy/sandbox/data.json` or source files (tests or scripts) that use the data helper in a project that holds real data.
user-invocable: false
effort: high
---

# check-data-privacy

Judge whether the sandbox and its tests can put a value of the real database in front of a model, a log or a git commit.

## Inputs
- The changed files, and the sandbox setup around them: `compose.yml`, `runtime/`, `db/`, `overrides/`, `data/`, `e2e/`, `proxy/`, `data.json`.
- `$GB`: the plugin root (follow-agent-rules). `bun "$GB/lib/cli.ts" review-axes <files>` lists `data-privacy` when it is required.

## Steps
Out of scope: a rendered sandbox file whose content is exactly what goodboy renders for this project. The run gate re-renders the layout itself and exempts such a file, so you are not asked for it (goodboy's own code is reviewed in goodboy's repo); you are asked for a rendered file that differs from the render, for `data.json` and for the source files that use the data helper. If you were sent a layout file anyway, judge what it can do with the data given the guarantee below, and do not report goodboy's own render as a finding.

Guarantee you can rely on for any layout file (M6a): raw output of the suites, traces, screenshots, the Playwright report and the proxy's access log stay in sandbox volumes; goodboy's commands never print them; they are deleted after a passing run, and after 24 hours at the latest (the next sandbox command sweeps them). A file that writes there, such as the Playwright config's traces and screenshots or the proxy's access log, is therefore not "unjudged" for that reason. A change that moves them to a host path, mounts them elsewhere or prints them breaks the guarantee and is a finding (step 2).

Judge capabilities and evidence. A helper's name proves nothing: a test that calls `valueOf` is as safe as what it does with the result. Never open, print or quote a value of the database or the dump; read code, config and the relative paths of files only. Keep `file:line` and the command you ran for each finding's `probe`.
1. Data access: tests and setup reach the data only through `sandbox-data` and the data helper. A DB client or driver in a test or script (the review is sent the files that name the data helper; a DB client in another file you read on the way is yours to report too), `docker exec` or `docker cp` into a database container, a read of the dump or an input log, or a connection string with a password is `high`.
2. Output channels: nothing prints, logs, snapshots or interpolates a value the helper resolved (`valueOf`, a picked row, a manifest answer); a failure message names an assertion id, never a value. The M6a boundary holds in compose and in the run: no step writes raw output, access logs or reports to a host path, and nothing reads them back. A printed value is `high`.
3. Artifact mounts: the `data` volume is written only by the database service (the resolve step) and the tools-profile `reader` (it clears it), and mounted read-only only in the runner and e2e services, as goodboy renders it; no other service has it, and nothing binds into `/goodboy-data`; the database's own volume is not mounted into the app, the proxy or a test container; no new host bind, published port or network that lets a container reach out. A mount that lets a test container read the database files is `high`.
4. Helper assertions: use `assertMatches` and `expectedCount`; the expected side comes from the database or from a relation, never from a value compared with itself, and never from a literal copied from the database. A literal that looks like real data in a test or in `data.json` (name, number, address, id) is `high`; a tautological assertion is `medium`.
5. Exports: no value reaches a file, a log, a snapshot, a screenshot or trace name, a network call or a test name. A dynamic test title built from a value is `high`.
6. Say what you could not judge (a generated file, a binary, a step you could not trace). Unjudged is a finding of its own, `medium` at least. An output the guarantee above covers is judged, not unjudged.

## Output
- Findings with probes for record-review; `dimensions_checked` lists `data-privacy`, and `reviewed_files` lists every sandbox file and data-helper source file you were asked about, so the run gate can match their content.

## Done when
- [ ] Each of the five areas has at least one `file:line` quote or command output.
- [ ] No finding or probe quotes a value of the database.

## Never
- Never run a query against, or read a value from, the real database or the dump (R2).
- Never pass a file on its name or on a comment that says it is safe.
