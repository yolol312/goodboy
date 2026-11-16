// A fake docker for the sandbox tests (track M, M6a; plan §19): a shell script behind
// GOODBOY_DOCKER_BIN that answers from files in FAKE_DOCKER_DIR, plays the volumes of raw
// artifacts as directories under `$FAKE_DOCKER_DIR/vol`, and runs the real scripts of the
// `reader` service (lib/sandbox-volumes.ts) against them, with the volume paths moved. Shared by
// tests/m1-sandbox.test.ts and tests/m6a-*.test.ts.
//
// Knobs (environment of the call): FAKE_RUNNER_EXIT, FAKE_E2E_EXIT, FAKE_COVERAGE_EXIT,
// FAKE_RESTORE_EXIT, FAKE_EXEC_EXIT, FAKE_HEALTH_EXIT; FAKE_FAIL (a substring of " <arguments> "
// that makes the call fail with FAKE_FAIL_TEXT on stderr); FAKE_READER_FAIL (a `case` pattern of
// the reader call's kind, which each script of lib/sandbox-volumes.ts names in its first line,
// `# goodboy-reader: <kind>`: list, read, unit-after, e2e-after, finish); FAKE_PLANT_RUNNER,
// FAKE_PLANT_E2E, FAKE_PLANT_COVERAGE, FAKE_PLANT_DIRS and FAKE_VICTIM (links and dirs a test
// leaves in the run's dir of the volume); FAKE_PLANT_LIVE (links the e2e container leaves in the
// `live` volume); FAKE_COVERAGE_LINK. Files in the state dir: volumes.txt (what `docker volume ls`
// prints: the project's volume names; absent means none), restore-out.txt, restore-err.txt,
// app-logs.txt, playwright-report.json, access.log (what the proxy wrote: copied into the `live`
// volume while the e2e container runs), runner-out.txt, runner-err.txt, e2e-out.txt, e2e-err.txt,
// junit/ (copied into the build/test-results volume, `tout_build_test_results`, by the unit runner).
// M6b: a `psql`, `mysql` or `mariadb` exec answers from db/<tag>.out, .err and .exit (see the branch below), and the
// `meta` volume (the handle key of the reader's `meta-key` script) is the directory vol/meta.

export const FAKE_DOCKER = `#!/bin/sh
d="$FAKE_DOCKER_DIR"
vol="$d/vol"
mkdir -p "$vol/outroot" "$vol/live" "$vol/outdirs" "$vol/meta"
if [ -n "\${FAKE_FAIL:-}" ]; then case " $* " in *"$FAKE_FAIL"*) echo "\${FAKE_FAIL_TEXT:-fake failure}" >&2; exit 1 ;; esac; fi
# volume paths of the containers, moved under the state dir (and moved back in what the reader prints)
vmap() { printf '%s' "$1" | sed -e "s#/outroot#$vol/outroot#g" -e "s#/live#$vol/live#g" -e "s#/outdirs#$vol/outdirs#g" -e "s#/meta#$vol/meta#g"; }
unvmap() { sed -e "s#$vol/outroot#/outroot#g" -e "s#$vol/live#/live#g" -e "s#$vol/outdirs#/outdirs#g" -e "s#$vol/meta#/meta#g"; }
# the run's dir of the volume a container was given with -e GOODBOY_OUT=/outroot/<ts>
outdir() { for a in "$@"; do case "$a" in GOODBOY_OUT=*) vmap "\${a#GOODBOY_OUT=}"; return ;; esac; done; }
# What a test running as root in a container can do in the run's dir: leave links in it that point
# at a file of the host (the first argument lists the file names, FAKE_VICTIM is the target).
plant() {
  names="$1"; shift
  out="$(outdir "$@")"
  if [ -n "$out" ]; then mkdir -p "$out"; fi
  if [ -n "$out" ] && [ -n "$names" ]; then
    for n in $names; do ln -sf "$FAKE_VICTIM" "$out/$n"; done
  fi
  if [ -n "$out" ]; then for n in \${FAKE_PLANT_DIRS:-}; do mkdir -p "$out/$n" && touch "$out/$n/x"; done; fi
}
is_reader=0
for a in "$@"; do if [ "$a" = reader ]; then is_reader=1; fi; done
if [ "$is_reader" = 1 ]; then
  while [ "$1" != reader ]; do shift; done
  shift
  # now: sh -c SCRIPT sh ARGS...
  script_raw="$3"
  shift 4
  kind="$(printf '%s\n' "$script_raw" | sed -n 's/^# goodboy-reader: //p' | head -n 1)"
  [ -n "$kind" ] || kind=unmarked
  echo "reader:$kind $*" >> "$d/calls.log"
  if [ -n "\${FAKE_READER_FAIL:-}" ]; then case "$kind" in $FAKE_READER_FAIL) echo "\${FAKE_FAIL_TEXT:-reader failed}" >&2; exit 1 ;; esac; fi
  n=$#; i=0
  while [ "$i" -lt "$n" ]; do a="$1"; shift; set -- "$@" "$(vmap "$a")"; i=$((i + 1)); done
  script="$(vmap "$script_raw")"
  sh -c "$script" sh "$@" > "$d/reader.out" 2> "$d/reader.err"
  code=$?
  unvmap < "$d/reader.out"
  cat "$d/reader.err" >&2
  exit $code
fi
echo "$*" >> "$d/calls.log"
case " $* " in
  *" context "*) cat "$d/context.txt" 2>/dev/null ;;
  *" network ls "*) cat "$d/netls.txt" 2>/dev/null ;;
  *" volume ls "*) cat "$d/volumes.txt" 2>/dev/null ;;
  *" network inspect "*) cat "$d/network.json" ;;
  *" inspect "*)
    case " $* " in
      *" id-intruder "*) cat "$d/intruder.json" ;;
      *) cat "$d/inspect.json" ;;
    esac ;;
  *" config "*) cat "$d/config.json" ;;
  *" ps -q app "*|*" ps -q app") cat "$d/ps-app.txt" 2>/dev/null ;;
  *" ps "*) cat "$d/ps.txt" ;;
  *" exec "*)
    case " $* " in
      # M6b: the database client of sandbox-data. The SQL arrives on stdin and is kept (db-sql.log, one
      # "=== <arguments>" line before each); the script names itself in its first line (\`-- goodboy-data: <tag>\`),
      # and the answer is the file db/<tag>.out, its stderr db/<tag>.err, its exit code db/<tag>.exit (or FAKE_DB_EXIT).
      *" psql "*|*" mysql "*|*" mariadb "*)
        cat > "$d/db-sql.in"
        { echo "=== $*"; cat "$d/db-sql.in"; } >> "$d/db-sql.log"
        tag="$(sed -n 's/^-- goodboy-data: //p' "$d/db-sql.in" | head -n 1)"
        [ -f "$d/db/$tag.err" ] && cat "$d/db/$tag.err" >&2
        [ -f "$d/db/$tag.out" ] && cat "$d/db/$tag.out"
        if [ -f "$d/db/$tag.exit" ]; then exit "$(cat "$d/db/$tag.exit")"; fi
        exit "\${FAKE_DB_EXIT:-0}" ;;
      *restore.sh*)
        [ -f "$d/restore-out.txt" ] && cat "$d/restore-out.txt"
        [ -f "$d/restore-err.txt" ] && cat "$d/restore-err.txt" >&2
        exit "\${FAKE_RESTORE_EXIT:-0}" ;;
    esac
    exit "\${FAKE_EXEC_EXIT:-0}" ;;
  *" logs "*) cat "$d/app-logs.txt" 2>/dev/null ;;
  *" run "*)
    case " $* " in
      *" probe "*)
        case " $* " in *"wget -S"*) exit "\${FAKE_HEALTH_EXIT:-0}" ;; esac
        cat "$d/probe.txt" ;;
      *" e2e "*|*" e2e")
        out="$(outdir "$@")"
        echo "e2e output line"
        [ -f "$d/e2e-out.txt" ] && cat "$d/e2e-out.txt"
        [ -f "$d/e2e-err.txt" ] && cat "$d/e2e-err.txt" >&2
        if [ -n "$out" ]; then
          mkdir -p "$out"
          [ -f "$d/playwright-report.json" ] && cp "$d/playwright-report.json" "$out/playwright-report.json"
          mkdir -p "$out/e2e-artifacts" && echo trace > "$out/e2e-artifacts/trace.zip"
        fi
        [ -f "$d/access.log" ] && cp "$d/access.log" "$vol/live/access.log"
        plant "\${FAKE_PLANT_E2E:-}" "$@"
        for n in \${FAKE_PLANT_LIVE:-}; do rm -f "$vol/live/$n"; ln -s "$FAKE_VICTIM" "$vol/live/$n"; done
        exit "\${FAKE_E2E_EXIT:-0}" ;;
      *"coverage.sh "*)
        out="$(outdir "$@")"
        if [ "\${FAKE_COVERAGE_EXIT:-0}" = 0 ] && [ -n "$out" ]; then mkdir -p "$out/coverage" && echo "<report/>" > "$out/coverage/jacoco.xml"; fi
        if [ -n "\${FAKE_COVERAGE_LINK:-}" ] && [ -n "$out" ]; then rm -rf "$out/coverage"; ln -s "$FAKE_COVERAGE_LINK" "$out/coverage"; fi
        plant "\${FAKE_PLANT_COVERAGE:-}" "$@"
        echo "coverage mode: $*"; exit "\${FAKE_COVERAGE_EXIT:-0}" ;;
      *" runner "*|*" runner")
        plant "\${FAKE_PLANT_RUNNER:-}" "$@"
        echo "runner output line"
        [ -f "$d/runner-out.txt" ] && cat "$d/runner-out.txt"
        [ -f "$d/runner-err.txt" ] && cat "$d/runner-err.txt" >&2
        if [ -d "$d/junit" ]; then mkdir -p "$vol/outdirs/tout_build_test_results" && cp -R "$d/junit/." "$vol/outdirs/tout_build_test_results/"; fi
        exit "\${FAKE_RUNNER_EXIT:-0}" ;;
    esac ;;
esac
exit 0
`;
