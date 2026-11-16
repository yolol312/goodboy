// Where a sandbox run keeps its raw artifacts (track M, M6a; plan §19): Docker volumes, not the
// checkout. A run's raw output (the suites' output, the e2e traces, the Playwright report, the
// proxy's access log, the test output dirs) can hold rows of a real database, so none of it is
// written into `.goodboy/sandbox/out/`, where a model reads files. The volumes are:
//   runout     /outroot       one dir per run, `/outroot/<ts>/` (the container's `/out` is a link to it)
//   live       /live          what the app, the proxy and the runner share (the access log, e2e coverage data)
//   tout_<dir> /work/<dir>    one volume over each known test output dir (JUnit XML, HTML reports)
//   meta       /meta          the handle key of `sandbox-data` (M6b), kept for the sandbox's life
//   data       /goodboy-data  the values of `.goodboy/sandbox/data.json` (M6c), written inside the database container before
//                             the suites and cleared after them; the test containers mount it read-only
// The host reads or removes what it needs through the `reader` service (a pinned busybox with no
// network) with the scripts below, in memory and under a byte budget, and never prints it.
//
// Everything here is pure text and parsing, so it can be tested without docker; the calls are in
// lib/sandbox-store.ts, the expiry rules in lib/sandbox-expiry.ts.

import { createHash } from 'node:crypto';
import { E2E_ARTIFACTS_DIR, E2E_OUTPUT_LOG_FILE, OUTPUT_LOG_FILE } from './sandbox-mode';
import { ACCESS_LOG_FILE, PLAYWRIGHT_REPORT_FILE } from './ui-types';

export const OUT_ROOT = '/outroot';
export const OUTDIRS_ROOT = '/outdirs';
export const LIVE_DIR = '/live';
/** The `meta` volume (M6b): what goodboy keeps for the sandbox's life, the handle key. Only the `reader` mounts it
 *  (M6c did not need it: the data helper reads values the database container resolved, not handles);
 *  `sandbox-down --volumes` removes it. */
export const META_DIR = '/meta';
const META_KEY_FILE = 'handle.key';
/** The `data` volume (M6c): where the database container writes the resolved values (`values.tsv`) of a run, and where the
 *  runner and e2e containers read them (read-only). The host never reads the file, only counts its lines. */
export const DATA_DIR = '/goodboy-data';
export const DATA_VOLUME = 'data';
export const DATA_FILE = 'values.tsv';

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
export const volumeNames = (dirs: readonly string[] = OUTPUT_DIRS): string[] => ['runout', 'live', 'meta', DATA_VOLUME, ...dirs.map(outDirVolume)];

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

/** Empties the `data` volume (the resolved values of a run). A reader of a sandbox made before M6c has no such mount:
 *  there is nothing to clear then. */
const CLEAR_DATA = `clear_data() {
  if [ -d ${DATA_DIR} ]; then find ${DATA_DIR} -mindepth 1 -maxdepth 1 -exec rm -rf {} + || return 1; fi
  return 0
}`;

/** Clears what a run leaves outside its run dir: the e2e coverage data and the access log in /live
 *  (the log is truncated, not removed: the proxy keeps it open; a log that became a link is dropped),
 *  everything in the output dirs, and the resolved values (M6c). */
const CLEAR = `${CLEAR_DATA}
clear_scratch() {
  clear_data || return 1
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
wlog "$ts" ${OUTPUT_LOG_FILE}
find ${OUTDIRS_ROOT} -type f -name 'TEST-*.xml' | sort | head -n "$cap" | while IFS= read -r f; do emit "$f" || break; done
${END}`;

/** `e2e-after <ts> <max> <total> <rm|keep>`: stdin becomes e2e-output.log, then the Playwright report and the
 *  access log are read, and the run's `e2e-artifacts` is looked up (`@@P present`) and removed with `rm`
 *  (`@@P left` when it is still there after that). */
export const E2E_AFTER_SCRIPT = `${marker('e2e-after')}
ts="$1"; max="$2"; total="$3"; action="$4"; used=0
${EMIT}
${WLOG}
wlog "$ts" ${E2E_OUTPUT_LOG_FILE}
emit "${OUT_ROOT}/$ts/${PLAYWRIGHT_REPORT_FILE}" || true
emit "${LIVE_DIR}/${ACCESS_LOG_FILE}" || true
a="${OUT_ROOT}/$ts/${E2E_ARTIFACTS_DIR}"
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

/** `clear-data`: empties the `data` volume alone (the end of the suites; the coverage step after them still needs
 *  /live and the output dirs). `@@END` only when it worked. */
export const CLEAR_DATA_SCRIPT = `${marker('clear-data')}
${CLEAR_DATA}
if clear_data; then ${END}; fi`;

/** `meta-key`: the handle key of the sandbox (M6b), a file of the `meta` volume. stdin is a candidate (64 hex
 *  digits goodboy made at random); it is written only when there is no key yet (`set -C`: the first writer
 *  wins, two calls at once agree), mode 0600, never through a link. The key that stands is printed as one file
 *  frame, which the host keeps in memory only. */
export const META_KEY_SCRIPT = `${marker('meta-key')}
max=4096; total=4096; used=0
${EMIT}
f="${META_DIR}/${META_KEY_FILE}"
IFS= read -r cand || cand=''
case "$cand" in *[!0-9a-f]*) cand='' ;; esac
if [ "\${#cand}" -eq 64 ] && [ ! -e "$f" ] && [ ! -L "$f" ]; then
  ( umask 077; set -C; printf '%s\\n' "$cand" > "$f" ) 2>/dev/null || true
fi
emit "$f" || true
${END}`;

/** The key out of a `meta-key` call's frames: 64 hex digits, or null (no key, a refused file, a bad shape). */
export function parseMetaKey(stdout: string): string | null {
  const f = parseFrames(stdout)?.files.get(`${META_DIR}/${META_KEY_FILE}`);
  if (f?.kind !== 'text') return null;
  const key = f.text.trim();
  return /^[0-9a-f]{64}$/.test(key) ? key : null;
}

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
