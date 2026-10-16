import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DOC_REVIEW_BUDGET_MINUTES, documentChangeNote, isDocumentChange } from '../lib/doc-verification';
import { ASK_WHEN_UNCLEAR_INSTRUCTION } from '../lib/required-inputs';

// Track I, I1b (#7, plan §15.4): bounded verification for document changes. A change whose
// every file is a doc gets the document class and its budget in the review gate's message,
// with the guidance that keeps document verification short.

const ROOT = resolve(import.meta.dir, '..');
const STOP = join(ROOT, 'hooks', 'stop.ts');
const POST = join(ROOT, 'hooks', 'post-tool-use.ts');
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('the document class', () => {
  const root = '/r/proj';
  test('every changed file a doc: Markdown anywhere, anything under docs/ (a static preview too)', () => {
    expect(isDocumentChange([`${root}/README.md`, `${root}/docs/versions/1.0/preview/REQ.html`, `${root}/docs/versions/1.0/preview/_style.css`], root)).toBe(true);
  });

  test('not a document change: code under docs/, a manifest, MDX, a prototype (I1b review)', () => {
    for (const f of ['app/docs/page.tsx', 'src/docs/handler.ts', 'requirements.txt', 'CMakeLists.txt', 'docs/guide.mdx', 'docs/versions/1.0/prototype/index.html']) {
      expect([f, isDocumentChange([`${root}/${f}`], root)]).toEqual([f, false]);
    }
    for (const f of ['NOTES.txt', 'docs/diagram.svg', 'docs/versions/1.0/preview/REQ.html', 'doc/manual.rst']) {
      expect([f, isDocumentChange([`${root}/${f}`], root)]).toEqual([f, true]);
    }
  });

  test('not a document change: a code file among them, nothing changed, or a file outside the project', () => {
    expect(isDocumentChange([`${root}/docs/REQ.md`, `${root}/src/a.ts`], root)).toBe(false);
    expect(isDocumentChange([], root)).toBe(false);
    expect(isDocumentChange(['/elsewhere/notes.md'], root)).toBe(false);
  });

  test('the note: files, class and budget first, then the guidance', () => {
    const files = [1, 2, 3, 4, 5, 6, 7].map((n) => `${root}/docs/d${n}.md`);
    const note = documentChangeNote(files, root);
    expect(DOC_REVIEW_BUDGET_MINUTES).toBe(10);
    expect(note).toContain('Document change (class: document; 7 files: docs/d1.md, docs/d2.md, docs/d3.md, docs/d4.md, docs/d5.md and 2 more)');
    expect(note.indexOf('Budget: one review of at most 10 minutes')).toBeGreaterThan(note.indexOf('class: document'));
    expect(note).toContain('no test run');
    for (const rule of [
      'the changed parts and what they affect',
      'check changed claims against their sources',
      'print only when pagination may change',
      'no new harness or mutation sweep',
      'list what was not verified',
      'one combined review',
      'defer them to the next planned edit',
    ]) {
      expect([rule, note.includes(rule)]).toEqual([rule, true]);
    }
    expect(note).toContain('a limit, not a pass criterion');
    expect(note).toContain("Put this note in the reviewer's prompt"); // a subagent never sees the gate's message
  });

  test('the file list shows five names: five files get no "more", six get "and 1 more"', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `${root}/docs/d${i + 1}.md`);
    const five = documentChangeNote(names(5), root);
    expect(five).toContain('5 files: docs/d1.md, docs/d2.md, docs/d3.md, docs/d4.md, docs/d5.md)');
    expect(five).not.toContain(' more');
    expect(documentChangeNote(names(6), root)).toContain('6 files: docs/d1.md, docs/d2.md, docs/d3.md, docs/d4.md, docs/d5.md and 1 more)');
    expect(documentChangeNote(names(1), root)).toContain('1 file: docs/d1.md)');
  });

  test('no note for a change that is not a document change', () => {
    expect(documentChangeNote([`${root}/docs/REQ.md`, `${root}/src/a.ts`], root)).toBe('');
  });
});

describe('the pre-edit guidance (B2)', () => {
  test('open decisions are collected in one question before the first edit', () => {
    expect(ASK_WHEN_UNCLEAR_INSTRUCTION).toContain('before the first edit');
    expect(ASK_WHEN_UNCLEAR_INSTRUCTION).toContain('(ask when unclear, B2)');
  });
});

describe('the review gate, end to end', () => {
  function box() {
    const tmp = mkdtempSync(join(tmpdir(), 'goodboy-i1b-tmp-'));
    tmpDirs.push(tmp);
    const cwd = join(tmp, 'proj');
    mkdirSync(cwd, { recursive: true });
    return { tmp, cwd, sessionId: `i1b-${Math.random().toString(36).slice(2)}` };
  }
  type Box = ReturnType<typeof box>;

  async function run(b: Box, script: string, payload: Record<string, unknown>): Promise<{ decision?: string; reason?: string; systemMessage?: string }> {
    const proc = Bun.spawn(['bun', script], {
      cwd: b.cwd,
      env: {
        ...process.env,
        TMPDIR: b.tmp,
        HOME: b.tmp,
        CLAUDE_PLUGIN_ROOT: ROOT,
        GOODBOY_CLAIM_FLUSH_WAIT_MS: '0',
        GOODBOY_DISABLE_DELEGATION: '1',
        GOODBOY_TEST_GATE: 'off',
        GOODBOY_EFFORT_ADVICE: 'on',
      },
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: b.sessionId, cwd: b.cwd, ...payload })),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    try {
      return JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string };
    } catch {
      return {};
    }
  }

  async function edit(b: Box, rel: string): Promise<void> {
    const abs = join(b.cwd, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x\n', 'utf8');
    await run(b, POST, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: abs } });
  }

  const stop = (b: Box) => run(b, STOP, { hook_event_name: 'Stop' });

  test('no review yet: a document change gets its class, budget and guidance', async () => {
    const b = box();
    await edit(b, 'docs/versions/1.0/REQUIREMENTS.md');
    await edit(b, 'docs/versions/1.0/preview/REQUIREMENTS.html');
    const out = await stop(b);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review is required');
    expect(out.reason).toContain('Document change (class: document; 2 files:');
    expect(out.reason).toContain('Budget: one review of at most 10 minutes');
  }, 30_000);

  test('a mixed change gets no document budget', async () => {
    const b = box();
    await edit(b, 'docs/REQ.md');
    await edit(b, 'src/a.ts');
    const out = await stop(b);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review is required');
    expect(out.reason ?? '').not.toContain('Document change');
  }, 30_000);

  test('a stale review of a document change: the delta advice comes with the document note', async () => {
    const b = box();
    const doc = join(b.cwd, 'docs', 'REQ.md');
    const dir = join(b.cwd, '.claude', 'reviews');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'r.json'),
      JSON.stringify({
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        reviewed_files: [doc],
        category: 'write-doc',
        findings: [],
        unknown_assumptions_checked: [],
        verdict: 'pass',
        dimensions_checked: ['hallucination'],
      }),
      'utf8',
    );
    await edit(b, 'docs/REQ.md');
    const out = await stop(b);
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('Review validation failed');
    expect(out.reason).toContain('Document change (class: document; 1 file: docs/REQ.md)');
    const log = join(b.tmp, `goodboy-session-${b.sessionId}`, 'gate-log.jsonl');
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toContain('"gate":"review"');
  }, 30_000);

  // The effort advice shares the document class with the review note (stop.ts reads the
  // same isDocumentChange): a docs-only change above medium effort still advises medium.
  const stopAtHigh = (b: Box) => run(b, STOP, { hook_event_name: 'Stop', effort: { level: 'high' } });

  test('effort advice: a docs-only change at high effort advises medium', async () => {
    const b = box();
    await edit(b, 'docs/REQ.md');
    await edit(b, 'README.md');
    const out = await stopAtHigh(b);
    expect(out.systemMessage ?? '').toContain('`/effort medium`');
    expect(out.systemMessage ?? '').toContain('문서만 고치는 중이에요');
  }, 30_000);

  test('effort advice: a mixed change at high effort gets no docs-only advice', async () => {
    const b = box();
    await edit(b, 'docs/REQ.md');
    await edit(b, 'src/a.ts');
    const out = await stopAtHigh(b);
    expect(out.systemMessage ?? '').not.toContain('문서만 고치는 중이에요');
    expect(out.systemMessage ?? '').not.toContain('/effort medium');
  }, 30_000);
});
