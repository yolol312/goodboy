// I9 (#17), from the fourth real-use trial: the claim gate resolves citations from the repo root
// (as its message says), not from the hook's `cwd`. Claude Code keeps a model's `cd` inside the
// project for later calls and hands that dir to the hooks; after `cd src/main/resources`, a
// corrected repo-relative citation was reported as "no such file".

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { excludeUserOriginated, extractCitations, mayCite, verifyCitations } from '../lib/claim-check';

const STOP_HOOK = resolve(import.meta.dir, '..', 'hooks', 'stop.ts');
const RES = 'src/main/resources';
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function dir(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

/** A git repo with `src/main/resources/static/js/common.js` (3 lines), its session state and a
 *  read record for that file (else the unread check would ask for a read first). */
function sandbox(): { tmp: string; root: string; sub: string; file: string; sessionId: string } {
  const tmp = dir('goodboy-i9-tmp-');
  const root = dir('goodboy-i9-repo-');
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const sub = join(root, RES);
  const file = join(sub, 'static', 'js', 'common.js');
  mkdirSync(join(sub, 'static', 'js'), { recursive: true });
  writeFileSync(file, 'a\nb\nc\n');
  const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
  const sdir = join(tmp, `goodboy-session-${sessionId}`);
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, 'turn.txt'), '2');
  writeFileSync(join(sdir, 'reads.jsonl'), JSON.stringify({ file, turn: 3, timestamp: new Date().toISOString() }) + '\n');
  return { tmp, root, sub, file, sessionId };
}

function transcript(at: string, text: string): string {
  const p = join(at, 'transcript.jsonl');
  writeFileSync(
    p,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'explain it' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
      JSON.stringify({ message: { model: 'claude-3-5-sonnet', usage: { input_tokens: 1000 } } }),
    ].join('\n') + '\n',
  );
  return p;
}

/** The Stop hook run from `cwd` (the hook input's and the process's), as Claude Code runs it
 *  after the model's `cd`. */
async function stop(s: ReturnType<typeof sandbox>, cwd: string, text: string, active = false): Promise<{ decision?: string; reason?: string; systemMessage?: string }> {
  const proc = Bun.spawn(['bun', STOP_HOOK], {
    cwd,
    env: { ...process.env, TMPDIR: s.tmp, HOME: s.tmp },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: s.sessionId, cwd, hook_event_name: 'Stop', transcript_path: transcript(s.tmp, text), stop_hook_active: active })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    return {};
  }
}

describe('I9: citations resolve from the repo root, whatever the shell cwd', () => {
  test('after a cd into a subdir, a repo-relative citation passes', async () => {
    const s = sandbox();
    const out = await stop(s, s.sub, `The same bug is in \`${RES}/static/js/common.js:2\`.`);
    expect(out.decision).toBeUndefined();
  }, 30_000);

  test('a path written from the current dir passes too', async () => {
    const s = sandbox();
    const out = await stop(s, s.sub, 'The same bug is in `static/js/common.js:2`.');
    expect(out.decision).toBeUndefined();
  }, 30_000);

  test('a path that exists from neither is still denied, named as written', async () => {
    const s = sandbox();
    const out = await stop(s, s.sub, `See \`${RES}/static/js/nope.js:2\`.`);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain(`${RES}/static/js/nope.js:2 — no such file`);
  }, 30_000);

  test('from the repo root a short subdir-relative path is still no such file (unchanged)', async () => {
    const s = sandbox();
    const out = await stop(s, s.root, 'The same bug is in `static/js/common.js:2`.');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('static/js/common.js:2 — no such file');
  }, 30_000);

  test('the stop_hook_active check no longer warns on a corrected citation (trial 4)', async () => {
    const s = sandbox();
    const out = await stop(s, s.sub, `Corrected: \`${RES}/static/js/common.js:2\`.`, true);
    expect(out.systemMessage ?? '').not.toContain('정정 후에도');
  }, 30_000);

  test('extractCitations: the root first, then the extra dir, only for a relative path', () => {
    const s = sandbox();
    const [a, b, c, d] = [
      `${RES}/static/js/common.js:1`,
      'static/js/common.js:1',
      'static/js/none.js:1',
      `${s.file}:1`,
    ].map((t) => extractCitations(t, s.root, {}, s.sub)[0]!.abs);
    expect([a, b, c, d]).toEqual([s.file, s.file, join(s.root, 'static/js/none.js'), s.file]);
    // Without the extra dir, nothing changes.
    expect(extractCitations('static/js/common.js:1', s.root)[0]!.abs).toBe(join(s.root, 'static/js/common.js'));
  });
});

describe('I9 review: two readings, a symlinked cwd, bare names', () => {
  /** A monorepo: `src/index.ts` (3 lines) at the root and `packages/foo/src/index.ts` (20 lines),
   *  the package's copy read in the session. */
  function monorepo(): ReturnType<typeof sandbox> & { pkg: string; pkgFile: string } {
    const s = sandbox();
    const pkg = join(s.root, 'packages', 'foo');
    const pkgFile = join(pkg, 'src', 'index.ts');
    mkdirSync(join(s.root, 'src'), { recursive: true });
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(s.root, 'src', 'index.ts'), 'a\nb\nc\n');
    writeFileSync(pkgFile, Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n');
    writeFileSync(join(s.tmp, `goodboy-session-${s.sessionId}`, 'reads.jsonl'), JSON.stringify({ file: pkgFile, turn: 3, timestamp: new Date().toISOString() }) + '\n');
    return { ...s, pkg, pkgFile };
  }

  test('a path that exists from both the root and the cwd holds when either reading checks out', async () => {
    const s = monorepo();
    // Line 10 is past the root copy's end and in the package's copy, which was read.
    expect((await stop(s, s.pkg, 'See `src/index.ts:10`.')).decision).toBeUndefined();
    expect((await stop(s, s.pkg, 'See `./src/index.ts:10`.')).decision).toBeUndefined();
    // Past both ends: denied.
    const out = await stop(s, s.pkg, 'See `src/index.ts:30`.');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('src/index.ts:30 — the file has only 3 lines');
  }, 30_000);

  test('Codex review: an unread other reading asks for a read; the user\'s spelling of either reading is excluded', () => {
    const s = monorepo();
    const cites = extractCitations('See `src/index.ts:10`.', s.root, {}, s.pkg);
    // Neither copy read: past the root copy's end, inside the package's, so read it first.
    const problems = verifyCitations(cites, { readTrackingAvailable: true, wasRead: () => false });
    expect(problems.map((p) => p.kind)).toEqual(['unread']);
    // The user wrote `./src/index.ts:999`, the model repeats `src/index.ts:999`: the user's claim.
    const mine = extractCitations('There is no `src/index.ts:999`.', s.root, {}, s.pkg);
    expect(excludeUserOriginated(mine, ['Is the bug at ./src/index.ts:999?'], s.root, {}, s.pkg)).toEqual([]);
  });

  test('`./` names the current dir first', () => {
    const s = monorepo();
    expect(extractCitations('./src/index.ts:1', s.root, {}, s.pkg)[0]).toMatchObject({ abs: s.pkgFile, alt: join(s.root, 'src', 'index.ts') });
    expect(extractCitations('src/index.ts:1', s.root, {}, s.pkg)[0]).toMatchObject({ abs: join(s.root, 'src', 'index.ts'), alt: s.pkgFile });
  });

  test('a bare name unique below the cwd resolves there, not as ambiguous', () => {
    const s = monorepo();
    const c = extractCitations('index.ts:2', s.root, {}, s.pkg)[0]!;
    expect([c.abs, c.candidates]).toEqual([s.pkgFile, undefined]);
    expect(extractCitations('index.ts:2', s.root, {})[0]!.candidates?.length).toBe(2);
  });

  test('a symlinked cwd whose computed top is no repo still checks citations', async () => {
    const s = sandbox();
    // A link two levels below `/` into a dir two levels inside the repo: the repo top computed
    //   from it (`--show-cdup` is `../../`) is `/`, which used to drop every citation.
    const deep = join(s.root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'x.ts'), 'a\nb\nc\n');
    const link = join('/tmp', `goodboy-i9-link-${Math.random().toString(36).slice(2)}`);
    symlinkSync(deep, link);
    tmpDirs.push(link);
    const out = await stop(s, link, 'See `x.ts:99`.');
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('x.ts:99 — the file has only 3 lines');
  }, 30_000);

  test('mayCite: only text shaped like a citation', () => {
    expect([mayCite('See `src/a.ts:3`.'), mayCite('No citations here: 3 files, v1.2'), mayCite('')]).toEqual([true, false, false]);
  });
});
