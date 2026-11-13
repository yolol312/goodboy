// Where a sandbox run keeps its raw artifacts (track M, M6a; plan §19): Docker volumes, not the
// checkout. A run's raw output (the suites' output, the e2e traces, the Playwright report, the
// proxy's access log, the test output dirs) can hold rows of a real database, so none of it is
// written into `.goodboy/sandbox/out/`, where a model reads files. The volumes are:
//   runout     /outroot       one dir per run, `/outroot/<ts>/` (the container's `/out` is a link to it)
//   live       /live          what the app, the proxy and the runner share (the access log, e2e coverage data)
//   tout_<dir> /work/<dir>    one volume over each known test output dir (JUnit XML, HTML reports)
// The host reads or removes what it needs through the `reader` service (a pinned busybox with no
// network) with the scripts below, in memory and under a byte budget, and never prints it.
//
// Everything here is pure text and parsing, so it can be tested without docker; the calls are in
// lib/sandbox-store.ts, the expiry rules in lib/sandbox-expiry.ts.

import { createHash } from 'node:crypto';

export const OUT_ROOT = '/outroot';
export const OUTDIRS_ROOT = '/outdirs';
export const LIVE_DIR = '/live';

/** One cap for a file read out of a volume: the access log, the Playwright report. */
export const MAX_READ_BYTES = 64 * 1024 * 1024;
/** What one reader call may print in all for the e2e files, and for the coverage report and the JUnit files. */
export const E2E_READ_TOTAL = 96 * 1024 * 1024;
export const COVERAGE_READ_BYTES = 128 * 1024 * 1024;
export const JUNIT_READ_TOTAL = 16 * 1024 * 1024;

/** The test output dirs of the project root that get a volume over them in the runner and the e2e
 *  service. */
export const OUTPUT_DIRS = ['build/test-results', 'build/reports', 'target/surefire-reports', 'target/failsafe-reports', 'test-results', 'playwright-report'] as const;
/** What a module (named by the scan's test command) gets: the JVM dirs. */
const MODULE_OUTPUT_DIRS = ['build/test-results', 'build/reports', 'target/surefire-reports', 'target/failsafe-reports'] as const;
const MAX_MODULES = 8;
const MODULE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** The modules a test command names: Gradle task paths (`:app:test`, `:a:b:check`), Maven `-pl a,b` /
 *  `--projects`, Gradle `-p dir` / `--project-dir dir`. Only plain relative paths count (a Maven
 *  `:artifactId` or `!exclusion` names no directory); at most 8, in order of appearance. */
export function moduleDirs(testCommand: readonly string[]): string[] {
  const out: string[] = [];
  const add = (raw: string): void => {
    const p = raw.replace(/\/+$/, '');
    if (MODULE_PATH.test(p) && !p.split('/').some((s) => s === '.' || s === '..') && !out.includes(p) && out.length < MAX_MODULES) out.push(p);
  };
  testCommand.forEach((t, i) => {
    const next = testCommand[i + 1];
    const task = /^:([\w.-]+(?::[\w.-]+)*):[\w.-]+$/.exec(t);
    if (task) add(task[1]!.replace(/:/g, '/'));
    else if ((t === '-pl' || t === '--projects') && next !== undefined) for (const m of next.split(',')) add(m);
    else if ((t === '-p' || t === '--project-dir') && next !== undefined) add(next);
    else if (t.startsWith('--project-dir=')) add(t.slice('--project-dir='.length));
    else if (t.startsWith('--projects=')) for (const m of t.slice('--projects='.length).split(',')) add(m);
  });
  return out;
}

/** The output dirs that get a volume: the root's, and each named module's JVM dirs. */
export const outputDirsFor = (testCommand: readonly string[]): string[] => [...OUTPUT_DIRS, ...moduleDirs(testCommand).flatMap((m) => MODULE_OUTPUT_DIRS.map((d) => `${m}/${d}`))];

/** The volume of an output dir: `tout_` and the path with every other character as `_`; a module's
 *  dir also carries a short hash of its path, so two paths never share a name. */
export function outDirVolume(dir: string): string {
  const base = `tout_${dir.replace(/[^A-Za-z0-9]+/g, '_')}`;
  return (OUTPUT_DIRS as readonly string[]).includes(dir) ? base : `${base}_${createHash('sha1').update(dir).digest('hex').slice(0, 6)}`;
}

/** The `volumes:` entries that mount every output dir over its place in `/work`. */
export const outDirMounts = (dirs: readonly string[] = OUTPUT_DIRS): string[] => dirs.map((d) => `${outDirVolume(d)}:/work/${d}`);

/** The same volumes in the reader service, side by side under /outdirs. */
export const readerMounts = (dirs: readonly string[] = OUTPUT_DIRS): string[] => dirs.map((d) => `${outDirVolume(d)}:${OUTDIRS_ROOT}/${outDirVolume(d)}`);

/** Every volume this module adds to the compose file. */
export const volumeNames = (dirs: readonly string[] = OUTPUT_DIRS): string[] => ['runout', 'live', ...dirs.map(outDirVolume)];

/** The in-volume dir of a run, as the container sees it (`GOODBOY_OUT`). */
export const runDirIn = (ts: string): string => `${OUT_ROOT}/${ts}`;

/** What `playwrightReport` of result.json says when the report is in the volume only: the proof
 *  (lib/sandbox-proof.ts) needs a string there, and a path of the volume names no host file. */
export const volumeMarker = (ts: string, file: string): string => `volume:runout/${ts}/${file}`;

// ---- the reader's scripts ----
// Each starts with a `# goodboy-reader: <kind>` line (the fake docker of the tests keys on it) and
// prints `@@END` as its last line when it ran to its end; a missing mark means a failed or cut-off
// run, which the host takes as failure. They run under busybox `sh` and are written in POSIX shell
// (the tests run them under the host's `sh`, with the volume paths moved).

const END = "echo '@@END'";
const marker = (kind: string): string => `# goodboy-reader: ${kind}`;

/** One regular file, base64 on one line: `@@A path` absent, `@@R path` refused (a link, not a
 *  regular file, larger than `$max`, or below a link), `@@F path` and the data line. `$total` is a byte
 *  budget for all the files of the call (`$used` so far): the file that would pass it is not printed,
 *  `@@PARTIAL` is, and `emit` returns 1 so the caller stops. */
const EMIT = `emit() {
  p="$1"
  if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "@@A $p"; return 0; fi
  dir=\${p%/*}
  if [ -L "$p" ] || [ ! -f "$p" ] || [ "$(cd "$dir" 2>/dev/null && pwd -P)" != "$dir" ]; then echo "@@R $p"; return 0; fi
  sz=$(wc -c < "$p" | tr -d ' ')
  if [ "$sz" -gt "$max" ]; then echo "@@R $p"; return 0; fi
  if [ $((used + sz)) -gt "$total" ]; then echo "@@PARTIAL"; return 1; fi
  used=$((used + sz))
  echo "@@F $p"
  base64 < "$p" | tr -d '\\n'
  echo
}`;

/** `wlog <ts> <file>`: stdin into the run's dir, replacing what is there (a planted link is replaced,
 *  never written through; a planted dir fails the write). Prints `@@W ok` or `@@W fail`. */
const WLOG = `wlog() {
  d="${OUT_ROOT}/$1"
  if mkdir -p "$d" && rm -f -- "$d/$2" && cat > "$d/$2"; then echo "@@W ok"; else echo "@@W fail"; fi
}`;

/** Clears what a run leaves outside its run dir: the e2e coverage data and the access log in /live
 *  (the log is truncated, not removed: the proxy keeps it open; a log that became a link is dropped) and
 *  everything in the output dirs. */
const CLEAR = `clear_scratch() {
  rm -rf ${LIVE_DIR}/jacoco-e2e.exec ${LIVE_DIR}/v8-e2e ${LIVE_DIR}/py-e2e || return 1
  if [ -L ${LIVE_DIR}/access.log ]; then rm -f ${LIVE_DIR}/access.log || return 1
  elif [ -f ${LIVE_DIR}/access.log ]; then : > ${LIVE_DIR}/access.log || return 1; fi
  for d in ${OUTDIRS_ROOT}/*; do
    if [ -d "$d" ]; then find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} + || return 1; fi
  done
  return 0
}`;

/** `read <max> <total> <path>...`: the files, as above. */
export const READ_SCRIPT = `${marker('read')}
max="$1"; total="$2"; shift 2; used=0
${EMIT}
for p; do emit "$p" || break; done
${END}`;

/** `unit-after <ts> <max> <total> <count>`: stdin becomes the run's output.log, then the JUnit XML
 *  files (`TEST-*.xml`, regular files) of the output dirs, sorted, at most `count`, are read. */
export const UNIT_AFTER_SCRIPT = `${marker('unit-after')}
ts="$1"; max="$2"; total="$3"; cap="$4"; used=0
${EMIT}
${WLOG}
wlog "$ts" output.log
find ${OUTDIRS_ROOT} -type f -name 'TEST-*.xml' | sort | head -n "$cap" | while IFS= read -r f; do emit "$f" || break; done
${END}`;

/** `e2e-after <ts> <max> <total> <rm|keep>`: stdin becomes e2e-output.log, then the Playwright report and the
 *  access log are read, and the run's `e2e-artifacts` is looked up (`@@P present`) and removed with `rm`
 *  (`@@P left` when it is still there after that). */
export const E2E_AFTER_SCRIPT = `${marker('e2e-after')}
ts="$1"; max="$2"; total="$3"; action="$4"; used=0
${EMIT}
${WLOG}
wlog "$ts" e2e-output.log
emit "${OUT_ROOT}/$ts/playwright-report.json" || true
emit "${LIVE_DIR}/access.log" || true
a="${OUT_ROOT}/$ts/e2e-artifacts"
if [ -e "$a" ] || [ -L "$a" ]; then
  echo "@@P present"
  if [ "$action" = rm ]; then
    rm -rf -- "$a"
    if [ -e "$a" ] || [ -L "$a" ]; then echo "@@P left"; fi
  fi
fi
${END}`;

/** `finish <clear|keep> <name>...`: removes each name (relative to the runs volume: `<ts>`) and, with
 *  `clear`, the scratch volumes. A name that is empty, absolute or holds `..` is skipped, so the script
 *  cannot leave the volume. `@@END` only when every step worked. */
export const FINISH_SCRIPT = `${marker('finish')}
mode="$1"; shift
rc=0
${CLEAR}
for n; do
  case "$n" in ''|/*|*..*) continue ;; esac
  rm -rf -- "${OUT_ROOT}/$n" || rc=1
done
if [ "$mode" = clear ]; then clear_scratch || rc=1; fi
if [ "$rc" = 0 ]; then ${END}; fi`;

/** The entries of the runs volume, one `@@E name` per line (hidden ones too). */
export const LIST_SCRIPT = `${marker('list')}
ls -1A ${OUT_ROOT} 2>/dev/null | while IFS= read -r n; do echo "@@E $n"; done
${END}`;

/** What `docker compose run --rm -T --no-deps reader sh -c <script> sh <args>` needs after `run --rm -T --no-deps`. */
export const readerArgv = (script: string, args: readonly string[]): string[] => ['reader', 'sh', '-c', script, 'sh', ...args];

// ---- parsing what the reader printed ----

export type FileRead = { kind: 'absent' } | { kind: 'refused' } | { kind: 'text'; text: string };

export interface Frames {
  files: Map<string, FileRead>;
  /** The byte budget of the call was reached: the files after it were not printed. */
  partial: boolean;
}

/** The files of a reader run by path, or null when the run did not reach its end (or its output was
 *  cut off, which loses the end mark). A data line that is not base64 is `refused`. */
export function parseFrames(stdout: string): Frames | null {
  const lines = stdout.split('\n');
  if (!lines.includes('@@END')) return null;
  const files = new Map<string, FileRead>();
  let partial = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === '@@END') break;
    if (l === '@@PARTIAL') partial = true;
    else if (l.startsWith('@@A ')) files.set(l.slice(4), { kind: 'absent' });
    else if (l.startsWith('@@R ')) files.set(l.slice(4), { kind: 'refused' });
    else if (l.startsWith('@@F ')) {
      // the data line follows (empty for an empty file); a mark in its place means there was none
      const data = lines[i + 1];
      if (data !== undefined && !data.startsWith('@@')) i++;
      files.set(l.slice(4), data !== undefined && !data.startsWith('@@') && /^[A-Za-z0-9+/]*={0,2}$/.test(data) ? { kind: 'text', text: Buffer.from(data, 'base64').toString('utf8') } : { kind: 'refused' });
    }
  }
  return { files, partial };
}

/** The names a reader run printed under `tag` (`@@E`, `@@P`), or null when it did not reach its end. */
export function parseNames(stdout: string, tag: '@@E' | '@@P'): string[] | null {
  const lines = stdout.split('\n');
  if (!lines.includes('@@END')) return null;
  return lines.filter((l) => l.startsWith(`${tag} `)).map((l) => l.slice(4));
}

/** Whether a `wlog` in the run wrote its file. */
export const wroteLog = (stdout: string): boolean => stdout.split('\n').includes('@@W ok');

/** The most a reader call with a byte budget can print (base64 and framing), which the host caps its capture at. */
export const frameBudget = (totalBytes: number): number => Math.ceil(totalBytes * 1.4) + 65_536;
