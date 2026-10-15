---
name: run-long-command
description: Run a long build or test command with its output in a log file, then report the exit code, the time and the tail, without interpreting it.
when_to_use: Use for full builds, full test suites and other runs longer than a minute.
user-invocable: false
effort: low
---

# run-long-command

Run one long command and report exactly what it did.

## Inputs
- The command (it may contain `&&` and pipes), the directory to run it in, a time limit
  (default 20 minutes).

## Steps
1. Make a log path: `LOG="$(mktemp -d)/run.log"`.
2. Run it through `sh -c`, with the limit (`perl … alarm` works where `timeout` is missing,
   as on macOS) and the start and end times:
   `cd <dir> && S=$(date +%s) && perl -e 'alarm shift; exec @ARGV' <seconds> sh -c '<command>' > "$LOG" 2>&1; echo "exit=$? seconds=$(( $(date +%s) - S ))"`
   For runs over ten minutes, start it with `run_in_background` and wait for its completion.
3. Read the exit code (142 means the limit stopped it), the seconds, and the last 60 lines of
   the log.
4. Grep the log for a summary line (`pass`, `fail`, `error`, `Tests:`) and copy it as is.

## Output
Hand back, inside the follow-agent-rules block's summary and artifacts:

```
command: <command>
exit: <code>   time: <seconds> s
summary: <the runner's own summary line, or "none">
log: <path>
tail: <last lines>
```

## Done when
- [ ] The exit code, the time and the log path are reported.

## Never
- Never fix, retry or explain failures; the caller decides.
- Never run a deploy, a push or anything against a live system (R2).
