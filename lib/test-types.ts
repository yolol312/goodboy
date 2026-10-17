// Test types per change kind (track I, I3b; plan §15.6). Every changed code file needs a test
// of any type (the coverage check, lib/test-validator.ts). On top, per file: boundary code
// needs an `integration` or `e2e` suite, UI code a `ui` or `e2e` suite. Boundary code is found
// by path and by content, broadly (the user's choice, 2026-10-17); the user's
// `test-type-exempt:` globs (decide: human policy entries, pinned at the session start) take the
// extra types away for false positives.

import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { isFrontendFile } from './review-dimensions';
import type { ChangedFileEdit } from './review-validator';
import { readRegular } from './safe-read';
import { failingSuites, missingTestFiles, scanForbiddenPatterns, stripLiteralsAndComments, validateEvidence } from './test-validator';
import { isTrustedTimestamp } from './trusted-time';
import type { TestResult, TestType } from './types';

export type TestTypesMode = 'on' | 'warn' | 'off';

/** `GOODBOY_TEST_TYPES`: on (default) blocks, warn tells the user, off skips the rule. */
export function testTypesMode(env: Record<string, string | undefined> = process.env): TestTypesMode {
  const v = (env.GOODBOY_TEST_TYPES ?? 'on').trim().toLowerCase();
  return v === 'off' || v === 'warn' ? v : 'on';
}

/** The types asked for on top of "any test". */
export type ExtraType = 'integration' | 'ui';
export const SATISFIED_BY: Readonly<Record<ExtraType, readonly TestType[]>> = {
  integration: ['integration', 'e2e'],
  ui: ['ui', 'e2e'],
};

/** Path words of boundary code (a server, route, API, handler, database, SQL, migration,
 *  shell, process or CLI), matched against the path's words: split at `/`, `.`, `_`, `-` and
 *  camelCase, the extension included. */
const BOUNDARY_WORDS = new Set([
  'server', 'servers', 'serve', 'route', 'routes', 'router', 'routers', 'routing', 'api', 'apis',
  'handler', 'handlers', 'endpoint', 'endpoints', 'controller', 'controllers', 'middleware',
  'database', 'databases', 'db', 'sql', 'migration', 'migrations', 'migrate', 'shell', 'exec',
  'spawn', 'cli', 'http', 'socket', 'sockets',
]);
const UI_EXT = /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/;
const SHELL_EXT = new Set(['.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd']);
const JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']);

/** Node built-ins and packages whose import makes JS/TS boundary code (file, network,
 *  database or process IO), by the module's first segment (two for a scoped package). */
const JS_IO_MODULES = new Set([
  'fs', 'child_process', 'net', 'http', 'https', 'http2', 'dgram', 'tls', 'dns', 'bun:sqlite',
  'axios', 'undici', 'ws', 'node-fetch', 'cross-fetch', 'got', 'superagent', 'socket.io',
  'socket.io-client', 'execa', 'zx', 'express', 'fastify', 'koa', 'hono',
  'pg', 'postgres', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongodb', 'mongoose', 'redis',
  'ioredis', 'knex', 'sequelize', 'typeorm', 'drizzle-orm', '@prisma/client', '@libsql/client',
  '@planetscale/database', '@neondatabase/serverless', '@supabase/supabase-js',
]);
// `from '…'`, `require('…')`, `import('…')`, `import '…'`: the raw text, since stripping
//   literals would empty the specifier.
const JS_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"`])([^'"`\n]{1,200})\1/g;
/** More specifiers than this: boundary code (fails closed, keeps a Stop fast). */
const MAX_SPECIFIERS = 5000;
/** IO functions imported by name from `bun`. */
const BUN_IO_NAMES = new Set(['spawn', 'spawnSync', 'serve', 'file', 'write', 'connect', 'listen', '$']);
const BUN_NAMED_IMPORT = /\bimport\s*\{([^}]{0,2000})\}\s*from\s*(['"])bun\2/g;
// Calls, in code with its comments and literals blanked.
const JS_IO_CALL =
  /\bfetch\s*\(|\bBun\s*\.\s*(?:spawn|spawnSync|serve|file|write|connect|listen|\$)|\bprocess\s*\.\s*argv\b|\bnew\s+(?:WebSocket|XMLHttpRequest|EventSource)\b|\bDeno\s*\.\s*(?:open|readFile|readTextFile|writeFile|writeTextFile|Command|run|serve|connect|listen)\b/;

const PY_IO_MODULES =
  '(subprocess|socket|socketserver|requests|httpx|sqlite3|urllib3?|http|aiohttp|psycopg2?|pymysql|MySQLdb|sqlalchemy|asyncpg|pymongo|redis|boto3|paramiko|ftplib|smtplib|shutil)';
// `import a, subprocess` and `from subprocess import run`.
const PY_IO_IMPORT = new RegExp(`^[ \\t]*(?:import[ \\t]+(?:[\\w.]+[ \\t]*,[ \\t]*){0,20}|from[ \\t]+)${PY_IO_MODULES}\\b`, 'm');
const PY_IO_CALL =
  /\bopen\s*\(|\bos\s*\.\s*(?:system|popen|remove|unlink|rename|makedirs|mkdir|rmdir|listdir|scandir|walk|exec\w*|spawn\w*)\s*\(|\.(?:read_text|write_text|read_bytes|write_bytes)\s*\(/;

const GO_IO_IMPORT = /"(os\/exec|net\/http|net|net\/rpc|database\/sql|io\/ioutil)"/;
const GO_IO_CALL = /\bos\s*\.\s*(?:Open|OpenFile|Create|ReadFile|WriteFile|Remove|RemoveAll|Rename|Mkdir|MkdirAll|ReadDir)\s*\(|\bexec\s*\.\s*Command\b/;

/** The largest source file whose content is read; a larger one (or one that is not a regular
 *  file) counts as boundary code: the rule fails closed. */
export const MAX_SOURCE_BYTES = 2_000_000;

function pathWords(rel: string): string[] {
  return rel
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function jsModule(spec: string): string {
  const s = spec.startsWith('node:') ? spec.slice(5) : spec;
  if (s.startsWith('bun:')) return s;
  const parts = s.split('/');
  return s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Whether the `from` at `at` ends a types-only statement (`import type … from`, `export type
 *  … from`): the nearest `import`/`export` before it starts a statement (only spaces back to a
 *  line start or `;`), is followed by `type`, and no `;` or quote lies between. Looks back at
 *  most 2000 characters, so many specifiers stay linear. */
function typeOnlyStatement(text: string, at: number): boolean {
  const lo = Math.max(0, at - 2000);
  const win = text.slice(lo, at);
  const k = Math.max(win.lastIndexOf('import'), win.lastIndexOf('export'));
  if (k < 0) return false;
  const head = win.slice(k);
  if (!/^(?:import|export)\s+type\s/.test(head) || /[;'"`]/.test(head)) return false;
  let i = lo + k - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  return i < 0 || text[i] === '\n' || text[i] === ';';
}

/** Why the content makes boundary code, or null. */
export function boundaryInContent(text: string, ext: string): string | null {
  if (JS_EXT.has(ext)) {
    let n = 0;
    for (const m of text.matchAll(JS_SPECIFIER)) {
      if (++n > MAX_SPECIFIERS) return `over ${MAX_SPECIFIERS} module specifiers`;
      const mod = jsModule(m[2]!);
      // A types-only import (`import type … from 'node:fs'`) does no IO.
      if (JS_IO_MODULES.has(mod) && !(m[0].startsWith('from') && typeOnlyStatement(text, m.index))) return `imports \`${mod}\``;
    }
    for (const m of text.matchAll(BUN_NAMED_IMPORT)) {
      const names = m[1]!.split(',').map((x) => x.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, ''));
      const io = names.find((x) => BUN_IO_NAMES.has(x));
      if (io) return `imports \`${io}\` from \`bun\``;
    }
    const call = stripLiteralsAndComments(text).match(JS_IO_CALL);
    return call ? `calls \`${call[0].replace(/\s+/g, '')}\`` : null;
  }
  if (ext === '.py' || ext === '.pyw') {
    const code = text.replace(/#[^\n]*/g, '');
    const imp = code.match(PY_IO_IMPORT);
    if (imp) return `imports \`${imp[1]}\``;
    const call = code.match(PY_IO_CALL);
    return call ? `calls \`${call[0].replace(/\s+/g, '')}\`` : null;
  }
  if (ext === '.go') {
    const code = text.replace(/\/\/[^\n]*/g, '');
    const imp = code.match(GO_IO_IMPORT);
    if (imp) return `imports \`${imp[1]}\``;
    const call = code.match(GO_IO_CALL);
    return call ? `calls \`${call[0].replace(/\s+/g, '')}\`` : null;
  }
  return null;
}

const contentMemo = new Map<string, string | null>();

/** Why `abs` (repo-relative `rel`) is boundary code, or null: its path, a shell script, or its
 *  content (JS/TS, Python, Go). A file that cannot be read as a regular file of at most
 *  MAX_SOURCE_BYTES is boundary code; a deleted one is not. Content results are memoized per
 *  process (one hook run) by path, size and mtime. */
export function boundaryReason(abs: string, rel: string): string | null {
  const ext = extname(rel).toLowerCase();
  const words = pathWords(rel);
  const word = words.find((w) => BOUNDARY_WORDS.has(w));
  if (word) return `path word \`${word}\``;
  if (rel.toLowerCase().split('/').slice(0, -1).includes('bin')) return 'under `bin/`';
  if (SHELL_EXT.has(ext)) return 'a shell script';
  if (!JS_EXT.has(ext) && ext !== '.py' && ext !== '.pyw' && ext !== '.go') return null;
  let key: string;
  try {
    const st = statSync(abs);
    key = `${abs}\0${st.size}\0${st.mtimeMs}\0${st.ino}`;
  } catch {
    return null;
  }
  if (contentMemo.has(key)) return contentMemo.get(key)!;
  const read = readRegular(abs, MAX_SOURCE_BYTES);
  const why = read === 'absent' ? null : read === 'refused' ? 'content not readable (not a regular file, or over 2 MB)' : boundaryInContent(read.text, ext);
  contentMemo.set(key, why);
  return why;
}

export interface TypeNeed {
  abs: string;
  /** Repo-top-relative, `/` separators. */
  rel: string;
  types: ExtraType[];
  /** Per type, why it is needed. */
  why: Partial<Record<ExtraType, string>>;
}

const outside = (r: string) => r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);

/** The extra types a changed code file needs, or null: none, outside the repo top, or matched
 *  by one of the user's `test-type-exempt` globs (repo-top-relative, like the coverage ones). */
export function typeNeedOf(file: string, top: string, exempt: readonly string[]): TypeNeed | null {
  const abs = resolvePath(file);
  const r = relative(top, abs);
  // A deleted file needs nothing (plan §15.6).
  if (r === '' || outside(r) || !existsSync(abs)) return null;
  const rel = r.split(sep).join('/');
  if (exempt.some((g) => new Bun.Glob(g).match(rel))) return null;
  const need: TypeNeed = { abs, rel, types: [], why: {} };
  const boundary = boundaryReason(abs, rel);
  if (boundary) {
    need.types.push('integration');
    need.why.integration = boundary;
  }
  // A `client` path is UI unless it is boundary code (`src/db/client.ts`); a UI extension is.
  const lower = rel.toLowerCase();
  if (isFrontendFile(lower) && (!boundary || UI_EXT.test(lower))) {
    need.types.push('ui');
    need.why.ui = 'a UI file';
  }
  return need.types.length > 0 ? need : null;
}

/** The tester for a change: test-ui when only UI types are needed, test-lead when both
 *  test-ui's type (ui) and test-unit's (unit, integration) are, else test-unit. `needs` holds
 *  one entry per changed code file (null: any test type). */
export function testerFor(needs: readonly (TypeNeed | null)[]): 'test-unit' | 'test-ui' | 'test-lead' {
  const ui = needs.some((n) => n?.types.includes('ui'));
  const other = needs.some((n) => n === null || n.types.includes('integration'));
  return ui && other ? 'test-lead' : ui ? 'test-ui' : 'test-unit';
}

export interface TypeGap {
  rel: string;
  missing: ExtraType[];
  why: Partial<Record<ExtraType, string>>;
}

/** A record that the other layer-1 checks would accept on its own: no failing suite, its test
 *  files exist, its evidence holds, no do-nothing test pattern. Used for records outside the
 *  accepted set (a test-lead run leaves one record per member). */
export function recordStandsAlone(r: TestResult): boolean {
  return (
    failingSuites([r]) === null &&
    missingTestFiles([r]) === null &&
    validateEvidence([r]) === null &&
    scanForbiddenPatterns(r.test_files ?? []).length === 0
  );
}

/** Per changed code file, the extra types no record meets. A type is met by a passing record
 *  with a trusted timestamp after the file's last edit that lists the file in `tested_files`
 *  and has a passing suite of a satisfying type; the record is one the other checks accepted,
 *  or one that stands alone. */
export function missingTestTypes(args: {
  results: readonly TestResult[];
  accepted: ReadonlySet<TestResult>;
  edits: readonly ChangedFileEdit[];
  top: string;
  exempt: readonly string[];
  standsAlone?: (r: TestResult) => boolean;
}): { needs: TypeNeed[]; gaps: TypeGap[] } {
  const nowMs = Date.now();
  const alone = new Map<TestResult, boolean>();
  const usable = (r: TestResult): boolean => {
    if (args.accepted.has(r)) return true;
    if (!alone.has(r)) alone.set(r, (args.standsAlone ?? recordStandsAlone)(r));
    return alone.get(r)!;
  };
  const passing = args.results.filter((r) => r.verdict === 'pass' && isTrustedTimestamp(r.timestamp, nowMs));
  const needs: TypeNeed[] = [];
  const gaps: TypeGap[] = [];
  const seen = new Set<string>();
  for (const edit of args.edits) {
    const need = typeNeedOf(edit.file, args.top, args.exempt);
    if (!need || seen.has(need.abs)) continue;
    seen.add(need.abs);
    needs.push(need);
    const last = typeof edit.lastEditTimestamp === 'string' ? edit.lastEditTimestamp : '';
    const fresh = passing.filter(
      (r) => (last === '' || r.timestamp > last) && (r.tested_files ?? []).some((f) => resolvePath(f) === need.abs),
    );
    const missing = need.types.filter(
      (t) =>
        !fresh.some(
          (r) =>
            (r.suites ?? []).some((s) => s.type !== undefined && SATISFIED_BY[t].includes(s.type) && s.passed > 0 && s.failed === 0) &&
            usable(r),
        ),
    );
    if (missing.length > 0) gaps.push({ rel: need.rel, missing, why: need.why });
  }
  return { needs, gaps };
}

const TYPE_TEXT: Record<ExtraType, string> = { integration: 'an integration or e2e suite', ui: 'a ui or e2e suite' };

/** The block message (model-facing). */
export function typeGapReason(gaps: readonly TypeGap[], tester: string): string {
  const list = gaps
    .slice(0, 5)
    .map((g) => `${g.rel} needs ${g.missing.map((t) => `${TYPE_TEXT[t]} (${g.why[t]})`).join(' and ')}`)
    .join('; ');
  return (
    `Test types missing: ${list}${gaps.length > 5 ? ` (${gaps.length - 5} more)` : ''}. A type counts from a passing ` +
    "result made after the file's last edit that lists the file in tested_files and has a passing suite of that " +
    `type; label a suite by what its tests really run. Run ${tester}. Only the user exempts files from this rule ` +
    '(a `test-type-exempt:` glob in a `decide: human` policy entry).'
  );
}

/** The user's line in warn mode (Korean, user-visible). */
export function typeGapWarning(gaps: readonly TypeGap[]): string {
  const ko: Record<ExtraType, string> = { integration: '통합(또는 E2E)', ui: 'UI(또는 E2E)' };
  const list = gaps
    .slice(0, 3)
    .map((g) => `${g.rel}: ${g.missing.map((t) => ko[t]).join('·')}`)
    .join(', ');
  return `[goodboy] 테스트 유형(경고 모드): 필요한 유형의 테스트가 없어요 — ${list}${gaps.length > 3 ? ` 외 ${gaps.length - 3}건` : ''}.`;
}
