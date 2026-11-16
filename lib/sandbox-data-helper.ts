// The data helper of a real-data sandbox (track M, M6c; plan §19): the text of the files `sandbox-init` writes under
// `.goodboy/sandbox/data/`, which a test imports to use the values `.goodboy/sandbox/data.json` asks for:
//
//   goodboy-data.ts       Playwright e2e tests and TypeScript unit tests
//   goodboy-data.cjs      plain Node unit tests (`require`, or a default import)
//   GoodboyData.java      JVM unit tests (the tester copies it to `src/test/java/goodboy/`)
//
// The helpers hold no value. Before the suites, `sandbox-run` has the database container write the values into
// `values.tsv` in the `data` volume (lib/sandbox-resolve.ts); the runner and e2e containers mount that volume read-only and
// name the file in `GOODBOY_DATA`. The helpers only read it. Its lines, tab-separated:
//
//   V <pick> <row key> <column> <hex of the UTF-8 text, ~ for NULL, ! for a text over 2000 characters>   one per picked row and column
//   N <count name> <count>
//   G <generator name> <kind> <run token>                                  kind: email, phone, text or number
//
// A failure says what the call asked for (an assertion id, a name the file holds), never a value, and a name the file does not
// hold is not echoed ("an unknown pick name"); the error carries no `actual` and `expected` field, so a reporter has nothing of
// the data to print. Outside the sandbox (no `GOODBOY_DATA`) every call fails with `goodboy-data: outside the sandbox`.

/** The reserved space a generator draws from: `gbx-<token>-<seq>` for text and email, `010-0000-<seq>` for a phone number
 *  and 9e12 plus a per-run offset for a number. `sandbox-run` refuses a run when the dump already holds such a value. */
export const GENERATED_PREFIX = 'gbx-';
export const PHONE_PREFIX = '010-0000-';
export const NUMBER_BASE = 9_000_000_000_000;
/** The largest `seq` of `generate`: a generator has 1000 values per run. */
export const MAX_SEQ = 999;
/** A picked cell of more than this many characters is written as `LONG_MARK`, never cut: `valueOf` then fails with
 *  `value too long` naming the pick and the column. */
export const MAX_CELL_CHARS = 2000;
export const LONG_MARK = '!';

/** The format of the manifest, as comment lines for the head of every helper file (a tester reads it there). */
const MANIFEST_DOC = [
  '// .goodboy/sandbox/data.json (tracked in git: conditions, never values):',
  '//   { "version": 1,',
  '//     "picks":    { "<name>": { "table": "users", "where": <condition>, "n": 3, "columns": ["name", "email"] } },',
  '//     "counts":   { "<name>": { "table": "users", "where": <condition> } },',
  '//     "generate": { "<name>": { "table": "users", "column": "email", "kind": "email" } } }   // kind: email, phone, text, number',
  '// <condition> is the --where JSON of sandbox-data: {"col","op","value"}, {"and":[...]} or {"or":[...]}. A pick needs 10 or more',
  `// matching rows; n is 1 to 20 (default 5); a picked value of more than ${MAX_CELL_CHARS} characters makes valueOf fail ("value too long").`,
  '// A run refuses a generator whose reserved space the first 100000 rows of its table already use. A number generator needs a',
  '// bigint column, or a decimal or numeric one with 13 integer digits or more (its values run from 9e12 to 9.1e12).',
].join('\n');

const GOODBOY_DATA_TS = String.raw`// The data helper of the sandbox (goodboy sandbox-init, track M6c). Do not put a value of the database in a test:
// declare what you need in .goodboy/sandbox/data.json and use these calls. The run resolves the values inside the database
// container, before the suites, into a read-only file named by GOODBOY_DATA; this file only reads it.
//
//   import { pick, fillFrom, assertMatches, expectedCount, generate } from '../.goodboy/sandbox/data/goodboy-data';
//   const user = pick('activeUser', 0);                    // a handle of the first row picked by data.json "picks.activeUser"
//   await fillFrom(page, '#name', user, 'name');           // types the row's value; the test never holds it
//   assertMatches(await page.textContent('#owner'), other, 'name', 'order-owner-name');
//   const n = expectedCount('activeUsers');                // data.json "counts.activeUsers": a number from the database
//   const email = generate('newUserEmail', 0);             // a new value in the reserved space, for an input the test creates
//
// A failure names the assertion id, never a value. Expected sides come from the database or from a relation (another
// handle, a count), never from the value under test: do not compare a value with itself.
//
${MANIFEST_DOC}
import { readFileSync } from 'node:fs';

export type Handle = Readonly<{ pick: string; row: number }>;
/** A picked cell: its text, null for NULL, or LONG for a text the run did not write (over the cell limit). */
const LONG = Symbol('long');
type Row = Map<string, string | null | typeof LONG>;
interface Data {
  picks: Map<string, Row[]>;
  counts: Map<string, number>;
  gens: Map<string, { kind: string; token: string }>;
}
/** What fillFrom needs of a Playwright page. */
interface Fillable {
  fill(selector: string, value: string): Promise<void>;
}

/** The only error of the helper: fixed words and names the file holds, never a value (a name it does not hold is not echoed). */
export class GoodboyDataError extends Error {
  constructor(what: string) {
    super('goodboy-data: ' + what);
    this.name = 'GoodboyDataError';
  }
}

let cache: Data | undefined;

function data(): Data {
  if (cache !== undefined) return cache;
  const path = process.env.GOODBOY_DATA;
  if (path === undefined || path === '') throw new GoodboyDataError('outside the sandbox');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new GoodboyDataError('no data');
  }
  const picks = new Map<string, Map<string, Row>>();
  const counts = new Map<string, number>();
  const gens = new Map<string, { kind: string; token: string }>();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const f = line.split('\t');
    if (f[0] === 'V' && f.length === 5 && (f[4] === '~' || f[4] === '${LONG_MARK}' || /^(?:[0-9a-f]{2})*$/.test(f[4]!))) {
      const rows = picks.get(f[1]!) ?? new Map<string, Row>();
      picks.set(f[1]!, rows);
      const row = rows.get(f[2]!) ?? new Map<string, string | null | typeof LONG>();
      rows.set(f[2]!, row);
      row.set(f[3]!, f[4] === '~' ? null : f[4] === '${LONG_MARK}' ? LONG : Buffer.from(f[4]!, 'hex').toString('utf8'));
    } else if (f[0] === 'N' && f.length === 3 && /^\d{1,15}$/.test(f[2]!)) counts.set(f[1]!, Number(f[2]));
    else if (f[0] === 'G' && f.length === 4 && /^[0-9a-f]{8}$/.test(f[3]!)) gens.set(f[1]!, { kind: f[2]!, token: f[3]! });
    else throw new GoodboyDataError('malformed data');
  }
  cache = { picks: new Map([...picks].map(([k, rows]) => [k, [...rows.values()]])), counts, gens };
  return cache;
}

/** The handle of row i (0 by default) of the pick name of data.json. */
export function pick(name: string, i = 0): Handle {
  const rows = data().picks.get(name);
  if (rows === undefined) throw new GoodboyDataError('an unknown pick name');
  if (!Number.isInteger(i)) throw new GoodboyDataError('a bad row index');
  if (i < 0 || i >= rows.length) throw new GoodboyDataError('no row ' + i);
  return Object.freeze({ pick: name, row: i });
}

/** The value of a column of a picked row, or null for NULL. For passing into code under test; never print it. A value of
 *  more than ${MAX_CELL_CHARS} characters is not in the file (never cut): the call fails with "value too long", naming the pick and column. */
export function valueOf(h: Handle, column: string): string | null {
  const row = data().picks.get(h.pick)?.[h.row];
  if (row === undefined) throw new GoodboyDataError('an unknown row');
  const v = row.get(column);
  if (v === undefined) throw new GoodboyDataError('an unknown column name');
  if (v === LONG) throw new GoodboyDataError('value too long for pick ' + h.pick + ' column ' + column);
  return v;
}

/** Types the value of a column of a picked row into the element selector. */
export async function fillFrom(page: Fillable, selector: string, h: Handle, column: string): Promise<void> {
  await page.fill(selector, valueOf(h, column) ?? '');
}

/** Throws goodboy-data: assertion <id> failed unless actual is the value of the column (a number is compared as a number). The
 *  error holds neither value. assertionId is 1 to 64 of letters, digits and . _ : -. */
export function assertMatches(actual: unknown, h: Handle, column: string, assertionId: string): void {
  if (typeof assertionId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(assertionId)) throw new GoodboyDataError('bad assertion id');
  const want = valueOf(h, column);
  // a number is compared as a number (12.5 matches the text 12.50), anything else as text
  const same = typeof actual === 'number' ? want !== null && want.trim() !== '' && Number(want) === actual : (actual === null || actual === undefined ? null : String(actual)) === want;
  if (!same) throw new GoodboyDataError('assertion ' + assertionId + ' failed');
}

/** The count of data.json "counts.<name>": a number from the database. */
export function expectedCount(name: string): number {
  const n = data().counts.get(name);
  if (n === undefined) throw new GoodboyDataError('an unknown count name');
  return n;
}

/** A new value of the generator name of data.json, the same one for the same seq (0 to 999) in a run. */
export function generate(name: string, seq: number): string {
  const g = data().gens.get(name);
  if (g === undefined) throw new GoodboyDataError('an unknown generator name');
  if (!Number.isInteger(seq) || seq < 0 || seq > ${MAX_SEQ}) throw new GoodboyDataError('bad sequence');
  if (g.kind === 'text') return '${GENERATED_PREFIX}' + g.token + '-' + seq;
  if (g.kind === 'email') return '${GENERATED_PREFIX}' + g.token + '-' + seq + '@example.invalid';
  if (g.kind === 'phone') return '${PHONE_PREFIX}' + String(seq).padStart(4, '0');
  if (g.kind === 'number') return String(${NUMBER_BASE} + (parseInt(g.token, 16) % 100000000) * 1000 + seq);
  throw new GoodboyDataError('malformed data');
}
`;

/** The Playwright and TypeScript helper (`.goodboy/sandbox/data/goodboy-data.ts`). */
export const dataHelperTs = (): string => GOODBOY_DATA_TS;

const GOODBOY_DATA_CJS = String.raw`// The data helper of the sandbox for plain Node tests (goodboy sandbox-init, track M6c): the calls of goodboy-data.ts
// without types. Do not put a value of the database in a test: declare what you need in .goodboy/sandbox/data.json.
//
//   const { pick, valueOf, assertMatches, expectedCount, generate } = require('../.goodboy/sandbox/data/goodboy-data.cjs');
//
// The values are read from the read-only file named by GOODBOY_DATA, which the run wrote inside the database container before
// the suites. A failure names the assertion id, never a value. Expected sides come from the database or from a relation,
// never from the value under test: do not compare a value with itself.
//
${MANIFEST_DOC}
'use strict';
const { readFileSync } = require('node:fs');

/** A picked cell that the run did not write because it is over the cell limit. */
const LONG = Symbol('long');

/** The only error of the helper: fixed words and names the file holds, never a value (a name it does not hold is not echoed). */
class GoodboyDataError extends Error {
  constructor(what) {
    super('goodboy-data: ' + what);
    this.name = 'GoodboyDataError';
  }
}

let cache;

function data() {
  if (cache !== undefined) return cache;
  const path = process.env.GOODBOY_DATA;
  if (path === undefined || path === '') throw new GoodboyDataError('outside the sandbox');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new GoodboyDataError('no data');
  }
  const picks = new Map();
  const counts = new Map();
  const gens = new Map();
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const f = line.split('\t');
    if (f[0] === 'V' && f.length === 5 && (f[4] === '~' || f[4] === '${LONG_MARK}' || /^(?:[0-9a-f]{2})*$/.test(f[4]))) {
      const rows = picks.get(f[1]) || new Map();
      picks.set(f[1], rows);
      const row = rows.get(f[2]) || new Map();
      rows.set(f[2], row);
      row.set(f[3], f[4] === '~' ? null : f[4] === '${LONG_MARK}' ? LONG : Buffer.from(f[4], 'hex').toString('utf8'));
    } else if (f[0] === 'N' && f.length === 3 && /^\d{1,15}$/.test(f[2])) counts.set(f[1], Number(f[2]));
    else if (f[0] === 'G' && f.length === 4 && /^[0-9a-f]{8}$/.test(f[3])) gens.set(f[1], { kind: f[2], token: f[3] });
    else throw new GoodboyDataError('malformed data');
  }
  cache = { picks: new Map([...picks].map(([k, rows]) => [k, [...rows.values()]])), counts, gens };
  return cache;
}

/** The handle of row i (0 by default) of the pick name of data.json. */
function pick(name, i = 0) {
  const rows = data().picks.get(name);
  if (rows === undefined) throw new GoodboyDataError('an unknown pick name');
  if (!Number.isInteger(i)) throw new GoodboyDataError('a bad row index');
  if (i < 0 || i >= rows.length) throw new GoodboyDataError('no row ' + i);
  return Object.freeze({ pick: name, row: i });
}

/** The value of a column of a picked row, or null for NULL. For passing into code under test; never print it. A value of
 *  more than ${MAX_CELL_CHARS} characters is not in the file (never cut): the call fails with "value too long", naming the pick and column. */
function valueOf(h, column) {
  const picked = data().picks.get(h.pick);
  const row = picked === undefined ? undefined : picked[h.row];
  if (row === undefined) throw new GoodboyDataError('an unknown row');
  const v = row.get(column);
  if (v === undefined) throw new GoodboyDataError('an unknown column name');
  if (v === LONG) throw new GoodboyDataError('value too long for pick ' + h.pick + ' column ' + column);
  return v;
}

/** Throws goodboy-data: assertion <id> failed unless actual is the value of the column (a number is compared as a number). */
function assertMatches(actual, h, column, assertionId) {
  if (typeof assertionId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(assertionId)) throw new GoodboyDataError('bad assertion id');
  const want = valueOf(h, column);
  // a number is compared as a number (12.5 matches the text 12.50), anything else as text
  const same = typeof actual === 'number' ? want !== null && want.trim() !== '' && Number(want) === actual : (actual === null || actual === undefined ? null : String(actual)) === want;
  if (!same) throw new GoodboyDataError('assertion ' + assertionId + ' failed');
}

/** The count of data.json "counts.<name>": a number from the database. */
function expectedCount(name) {
  const n = data().counts.get(name);
  if (n === undefined) throw new GoodboyDataError('an unknown count name');
  return n;
}

/** A new value of the generator name of data.json, the same one for the same seq (0 to 999) in a run. */
function generate(name, seq) {
  const g = data().gens.get(name);
  if (g === undefined) throw new GoodboyDataError('an unknown generator name');
  if (!Number.isInteger(seq) || seq < 0 || seq > ${MAX_SEQ}) throw new GoodboyDataError('bad sequence');
  if (g.kind === 'text') return '${GENERATED_PREFIX}' + g.token + '-' + seq;
  if (g.kind === 'email') return '${GENERATED_PREFIX}' + g.token + '-' + seq + '@example.invalid';
  if (g.kind === 'phone') return '${PHONE_PREFIX}' + String(seq).padStart(4, '0');
  if (g.kind === 'number') return String(${NUMBER_BASE} + (parseInt(g.token, 16) % 100000000) * 1000 + seq);
  throw new GoodboyDataError('malformed data');
}

exports.GoodboyDataError = GoodboyDataError;
exports.pick = pick;
exports.valueOf = valueOf;
exports.assertMatches = assertMatches;
exports.expectedCount = expectedCount;
exports.generate = generate;
`;

/** The plain Node helper (`.goodboy/sandbox/data/goodboy-data.cjs`). */
export const dataHelperCjs = (): string => GOODBOY_DATA_CJS;

const GOODBOY_DATA_JAVA = String.raw`// The data helper of the sandbox for JVM tests (goodboy sandbox-init, track M6c). Copy this one file to
// src/test/java/goodboy/GoodboyData.java: a Maven or Gradle test build compiles only the project's own test sources.
// Do not put a value of the database in a test: declare what you need in .goodboy/sandbox/data.json.
//
//   GoodboyData.Handle user = GoodboyData.pick("activeUser", 0);
//   String name = GoodboyData.valueOf(user, "name");              // for code under test; never print it
//   GoodboyData.assertMatches(page.owner(), other, "name", "order-owner-name");
//   long n = GoodboyData.expectedCount("activeUsers");
//   String email = GoodboyData.generate("newUserEmail", 0);
//
// The values are read from the read-only file named by GOODBOY_DATA, which the run wrote inside the database container
// before the suites. A failure names the assertion id, never a value. Expected sides come from the database or from a
// relation, never from the value under test: do not compare a value with itself. Java 8 or later, no dependencies.
//
${MANIFEST_DOC}
package goodboy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

public final class GoodboyData {
    private GoodboyData() {}

    /** A row of a pick: the pick's name and the row's place. Holds no value. */
    public static final class Handle {
        public final String pick;
        public final int row;

        private Handle(String pick, int row) {
            this.pick = pick;
            this.row = row;
        }
    }

    private static final class Gen {
        final String kind;
        final String token;

        Gen(String kind, String token) {
            this.kind = kind;
            this.token = token;
        }
    }

    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9._:-]{1,64}$");
    private static final Pattern HEX = Pattern.compile("^(?:[0-9a-f]{2})*$");
    private static final Pattern DIGITS = Pattern.compile("^\\d{1,15}$");
    private static final Pattern TOKEN = Pattern.compile("^[0-9a-f]{8}$");
    /** The cell the run did not write because it is over the cell limit (compared by identity, never by text). */
    private static final String LONG = new String("${LONG_MARK}");

    private static Map<String, List<Map<String, String>>> picks;
    private static Map<String, Long> counts;
    private static Map<String, Gen> gens;

    private static IllegalStateException fail(String what) {
        return new IllegalStateException("goodboy-data: " + what);
    }

    private static byte[] unhex(String h) {
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16);
        return out;
    }

    private static synchronized void load() {
        if (picks != null) return;
        String path = System.getenv("GOODBOY_DATA");
        if (path == null || path.isEmpty()) throw fail("outside the sandbox");
        String text;
        try {
            text = new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
        } catch (IOException | RuntimeException e) {
            throw fail("no data");
        }
        Map<String, Map<String, Map<String, String>>> rowsOf = new LinkedHashMap<>();
        Map<String, Long> c = new HashMap<>();
        Map<String, Gen> g = new HashMap<>();
        for (String line : text.split("\n", -1)) {
            if (line.isEmpty()) continue;
            String[] f = line.split("\t", -1);
            if (f[0].equals("V") && f.length == 5 && (f[4].equals("~") || f[4].equals("${LONG_MARK}") || HEX.matcher(f[4]).matches())) {
                Map<String, Map<String, String>> rows = rowsOf.computeIfAbsent(f[1], k -> new LinkedHashMap<>());
                Map<String, String> row = rows.computeIfAbsent(f[2], k -> new HashMap<>());
                // a NULL stays a key with a null value
                row.put(f[3], f[4].equals("~") ? null : f[4].equals("${LONG_MARK}") ? LONG : new String(unhex(f[4]), StandardCharsets.UTF_8));
            } else if (f[0].equals("N") && f.length == 3 && DIGITS.matcher(f[2]).matches()) {
                c.put(f[1], Long.parseLong(f[2]));
            } else if (f[0].equals("G") && f.length == 4 && TOKEN.matcher(f[3]).matches()) {
                g.put(f[1], new Gen(f[2], f[3]));
            } else {
                throw fail("malformed data");
            }
        }
        Map<String, List<Map<String, String>>> p = new HashMap<>();
        for (Map.Entry<String, Map<String, Map<String, String>>> e : rowsOf.entrySet()) p.put(e.getKey(), new ArrayList<>(e.getValue().values()));
        counts = c;
        gens = g;
        picks = p;
    }

    /** The handle of row i of the pick name of data.json. */
    public static Handle pick(String name, int i) {
        load();
        List<Map<String, String>> rows = picks.get(name);
        if (rows == null) throw fail("an unknown pick name");
        if (i < 0 || i >= rows.size()) throw fail("no row " + i);
        return new Handle(name, i);
    }

    /** The handle of the first row of the pick. */
    public static Handle pick(String name) {
        return pick(name, 0);
    }

    /** The value of a column of a picked row, or null for NULL. For passing into code under test; never print it. A value of
     *  more than ${MAX_CELL_CHARS} characters is not in the file (never cut): the call fails with "value too long", naming the pick and column. */
    public static String valueOf(Handle h, String column) {
        load();
        List<Map<String, String>> rows = picks.get(h.pick);
        if (rows == null || h.row < 0 || h.row >= rows.size()) throw fail("an unknown row");
        Map<String, String> row = rows.get(h.row);
        if (!row.containsKey(column)) throw fail("an unknown column name");
        String v = row.get(column);
        if (v == LONG) throw fail("value too long for pick " + h.pick + " column " + column);
        return v;
    }

    /** Fails with goodboy-data: assertion <id> failed unless actual is the value of the column. The error holds neither value. */
    public static void assertMatches(String actual, Handle h, String column, String assertionId) {
        if (assertionId == null || !ID.matcher(assertionId).matches()) throw fail("bad assertion id");
        String want = valueOf(h, column);
        boolean same = actual == null ? want == null : actual.equals(want);
        if (!same) throw new AssertionError("goodboy-data: assertion " + assertionId + " failed");
    }

    /** The count of data.json "counts.<name>": a number from the database. */
    public static long expectedCount(String name) {
        load();
        Long n = counts.get(name);
        if (n == null) throw fail("an unknown count name");
        return n;
    }

    /** A new value of the generator name of data.json, the same one for the same seq (0 to 999) in a run. */
    public static String generate(String name, int seq) {
        load();
        Gen g = gens.get(name);
        if (g == null) throw fail("an unknown generator name");
        if (seq < 0 || seq > ${MAX_SEQ}) throw fail("bad sequence");
        if (g.kind.equals("text")) return "${GENERATED_PREFIX}" + g.token + "-" + seq;
        if (g.kind.equals("email")) return "${GENERATED_PREFIX}" + g.token + "-" + seq + "@example.invalid";
        if (g.kind.equals("phone")) return "${PHONE_PREFIX}" + String.format("%04d", seq);
        if (g.kind.equals("number")) return String.valueOf(${NUMBER_BASE}L + (Long.parseLong(g.token, 16) % 100000000L) * 1000L + seq);
        throw fail("malformed data");
    }
}
`;

/** The JVM helper (`.goodboy/sandbox/data/GoodboyData.java`). */
export const dataHelperJava = (): string => GOODBOY_DATA_JAVA;
