import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readAcceptance } from '../lib/acceptance';
import { validateTestResultInput } from '../lib/cli';
import { ensureSessionDir } from '../lib/file-tracker';
import { MAX_DOC_BYTES, readRegular } from '../lib/safe-read';
import { pinSessionCriteria, policyInScope, policyTests, productEvidenceProblems, requirementRows, requirementsInScope, sessionCriteria } from '../lib/session-criteria';
import { restoreGateState, snapshotGateState } from '../lib/state-guard';
import type { AcceptanceCoverage, TestResult } from '../lib/types';

// Track I, I2 (#3, plan §15.5): every acceptance criterion has a test. Besides the dev-cycle
// UIUX and prototype criteria: the requirements a session works on (REQ-<rank>: in progress,
// or implemented since the session started) and the policy entries with a `test:` line that
// the session added or changed (POL-<id>). A product criterion is never met by a document.

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'lib', 'cli.ts');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'goodboy-i2-'));
  dirs.push(d);
  return d;
}
const sh = (cwd: string, cmd: string) => Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
/** A FIFO at `abs`, checked: a test of a FIFO that was never made would pass on a missing file. */
function fifo(abs: string): void {
  expect(Bun.spawnSync(['mkfifo', abs]).exitCode).toBe(0);
  expect(lstatSync(abs).isFIFO()).toBe(true);
}
/** A session id whose state dir (in this process's tmpdir) is removed after the test. */
const sid = () => {
  const s = `i2-${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
};

const reqs = (rows: [number, string, string][]) =>
  ['# 요구사항 — 1.0', '', '## 버전 목표', '', '내보내기.', '', '## 요구사항 (우선순위 순)', '', '| 순위 | 요구사항 | 설명 | 상태 |', '|---|---|---|---|', ...rows.map(([n, t, s]) => `| ${n} | ${t} | - | ${s} |`), '', '## 이번 버전에서 하지 않을 것 (Non-goals)', '', '- 없음', ''].join('\n');

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A dev-cycle repo at version 1.0, committed. */
function devCycleRepo(requirements: string, policy?: string): string {
  const d = tmp();
  sh(d, 'git init -q -b main . && git config user.email t@e && git config user.name t');
  write(d, 'docs/CYCLE.md', '# Cycle\n\n- **현재 버전**: 1.0\n');
  write(d, 'docs/versions/1.0/REQUIREMENTS.md', requirements);
  if (policy !== undefined) write(d, '.goodboy/policy.md', policy);
  write(d, 'src/a.ts', 'export const a = 1;\n');
  sh(d, "git add -A && git -c commit.gpgsign=false commit -q -m 'ABC-1 init'");
  return d;
}

describe('requirements', () => {
  test('AC-1: the table rows: rank, requirement, status, in Korean or English', () => {
    expect(requirementRows(reqs([[1, '로그인', '구현완료'], [2, '내보내기', '구현중'], [3, '알림', '미구현']]))).toEqual([
      { rank: '1', title: '로그인', status: 'implemented' },
      { rank: '2', title: '내보내기', status: 'in-progress' },
      { rank: '3', title: '알림', status: 'not-started' },
    ]);
    // Template rows (a dash, a <placeholder> cell) are no requirement, even when marked in progress.
    expect(requirementRows(reqs([[1, '로그인', '구현완료'], [2, '-', '구현중'], [3, '<요구사항>', '구현중']]))).toEqual([{ rank: '1', title: '로그인', status: 'implemented' }]);
    const en = ['# Requirements — 1.0', '', '## Requirements (by priority)', '', '| Rank | Requirement | Description | Status |', '|---|---|---|---|', '| 1 | Login | - | Implemented |', '| 2 | Export | - | In progress |', '| 3 | | | Not started |', ''].join('\n');
    expect(requirementRows(en)).toEqual([
      { rank: '1', title: 'Login', status: 'implemented' },
      { rank: '2', title: 'Export', status: 'in-progress' },
    ]);
  });

  test('AC-2: in scope: rows in progress, and rows implemented since the start', () => {
    const rows = (t: string) => requirementRows(t);
    const now = rows(reqs([[1, '로그인', '구현완료'], [2, '내보내기', '구현완료'], [3, '알림', '구현중'], [4, '검색', '미구현']]));
    const start = rows(reqs([[1, '로그인', '구현완료'], [2, '내보내기', '구현중'], [3, '알림', '미구현'], [4, '검색', '미구현']]));
    expect(requirementsInScope(now, start).map((c) => c.id).sort()).toEqual(['REQ-2', 'REQ-3']);
    // No file at the start: every implemented row is new.
    expect(requirementsInScope(now, null).map((c) => c.id).sort()).toEqual(['REQ-1', 'REQ-2', 'REQ-3']);
    // An unknown start: only the rows in progress.
    expect(requirementsInScope(now, undefined).map((c) => c.id)).toEqual(['REQ-3']);
    expect(requirementsInScope(now, start).find((c) => c.id === 'REQ-2')).toMatchObject({ source: 'requirement', description: '내보내기' });
  });

  test('AC-2: a row in progress at the start stays required whatever the file says now (I2 security review)', () => {
    const start = requirementRows(reqs([[1, '로그인', '구현완료'], [2, '내보내기', '구현중']]));
    for (const now of [
      reqs([[1, '로그인', '구현완료'], [2, '내보내기', '미구현']]), // set back
      reqs([[1, '로그인', '구현완료']]), // deleted
      reqs([[1, '로그인', '구현완료'], [2, '내보내기 (v2)', '보류']]), // renamed, an unknown status
      '# nothing here\n', // heading or table gone
    ]) {
      expect(requirementsInScope(requirementRows(now), start).map((c) => c.id)).toContain('REQ-2');
    }
    expect(requirementsInScope([], start).map((c) => c.id)).toEqual(['REQ-2']); // the file removed
  });

  test('AC-2: implemented rows are matched by rank and title as a multiset: a retitled row is not excused', () => {
    const start = requirementRows(reqs([[1, '로그인', '구현완료'], [2, '알림', '미구현']]));
    const now = requirementRows(reqs([[1, '로그인', '구현완료'], [2, '로그인', '구현완료']]));
    expect(requirementsInScope(now, start).map((c) => c.id)).toEqual(['REQ-2']);
  });

  test('AC-2: a row moved to another rank is not excused: the key is rank and title, not the title alone', () => {
    const start = requirementRows(reqs([[1, '로그인', '구현완료'], [2, '알림', '구현완료']]));
    const moved = requirementRows(reqs([[3, '로그인', '구현완료'], [2, '알림', '구현완료']]));
    expect(requirementsInScope(moved, start).map((c) => c.id)).toEqual(['REQ-3']);
    const swapped = requirementRows(reqs([[1, '알림', '구현완료'], [2, '로그인', '구현완료']]));
    expect(requirementsInScope(swapped, start).map((c) => c.id).sort()).toEqual(['REQ-1', 'REQ-2']);
  });

  test('AC-2: one start row excuses one current row, not every row that looks like it', () => {
    const start = requirementRows(reqs([[1, '로그인', '구현완료']]));
    const twice = requirementRows(reqs([[1, '로그인', '구현완료'], [1, '로그인', '구현완료']]));
    expect(requirementsInScope(twice, start).map((c) => c.id)).toEqual(['REQ-1']); // the second copy is new
    expect(requirementsInScope(requirementRows(reqs([[1, '로그인', '구현완료']])), start)).toEqual([]);
  });

  test('AC-1: parser: escaped pipes, P1 and #3 ranks, decorated statuses, a blank line, fenced examples, several sections', () => {
    const md = [
      '## 요구사항',
      '',
      '```',
      '| 순위 | 요구사항 | 설명 | 상태 |',
      '|---|---|---|---|',
      '| 9 | 예시 | - | 구현중 |',
      '```',
      '',
      '| 순위 | 요구사항 | 설명 | 상태 |',
      '|---|---|---|---|',
      '| P1 | a \\| b | - | 🚧 구현중 |',
      '',
      '| #3 | `x|y` 처리 | - | 구현완료 ✅ |',
      '| 4. | 진행 | - | 진행중 (50%) |',
      '| 5 | 미착수 | - | 미구현 |',
      '',
      '## Requirements (extra)',
      '',
      '| Rank | Requirement | Status |',
      '|---|---|---|',
      '| 6 | Hidden | Done |',
    ].join('\n');
    expect(requirementRows(md)).toEqual([
      { rank: '1', title: 'a | b', status: 'in-progress' },
      { rank: '3', title: '`x|y` 처리', status: 'implemented' },
      { rank: '4', title: '진행', status: 'in-progress' },
      { rank: '5', title: '미착수', status: 'not-started' },
      { rank: '6', title: 'Hidden', status: 'implemented' },
    ]);
  });

  test('AC-1: negative and future status words are not started, though they contain the words of done or in progress', () => {
    const words = ['Unimplemented', 'Incomplete', 'Not yet implemented', 'Not completed', 'Not in progress', '진행 전', '미진행', '완료 예정'];
    const rows = requirementRows(reqs(words.map((w, i): [number, string, string] => [i + 1, `r${i}`, w])));
    expect(rows.map((r) => r.status)).toEqual(words.map(() => 'not-started'));
  });

  // Layer-1 round 4: dropping any of these three words from the not-started list went unnoticed.
  test('AC-1: "not implemented", "not done" and "미완료" are not started, though they contain implemented, done and 완료', () => {
    const words = ['Not implemented', 'Not done', '미완료'];
    const rows = requirementRows(reqs(words.map((w, i): [number, string, string] => [i + 1, `r${i}`, w])));
    expect(rows.map((r) => r.status)).toEqual(words.map(() => 'not-started'));
  });

  test('AC-1: a rank keeps at most 6 digits: the id goes into block messages and the seen store', () => {
    expect(requirementRows(reqs([[12345678901, '긴 순위', '구현중']]))[0]?.rank).toBe('123456');
  });

  test('AC-1: the parse is linear: a crafted wide header with many rows stays fast (I2 security review round 2)', () => {
    // Was quadratic: 1000 filler header cells and 30000 rows took 3.8 s, 3000 and 60000 kept the Stop busy 24 s.
    const header = `| ${Array.from({ length: 3000 }, (_, i) => `f${i}`).join(' | ')} | 순위 | 요구사항 | 상태 |`;
    const md = ['## 요구사항', '', header, ...Array.from({ length: 60000 }, () => '|x|a|b|')].join('\n');
    const t0 = performance.now();
    expect(requirementRows(md)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('policy entries with a test line', () => {
  const entry = (id: string, test?: string) => [`## ${id} Rule ${id}`, '- decide: ai', '- source: review', '- date: 2026-10-16', '- checked: 2026-10-16', ...(test ? [`- test: ${test}`] : []), ''].join('\n');
  test('AC-3: in scope when added or changed since the start; an unknown start adds none', () => {
    const start = policyTests([entry('P1', 'every API error has a code'), entry('P2'), entry('P3', 'dates are UTC')].join('\n'));
    const now = policyTests([entry('P1', 'every API error has a code'), entry('P2', 'ids are UUIDs'), entry('P3', 'dates are UTC with an offset'), entry('P4', 'logs carry the request id')].join('\n'));
    expect(policyInScope(now, start).map((c) => c.id)).toEqual(['POL-P2', 'POL-P3', 'POL-P4']);
    expect(policyInScope(now, null).map((c) => c.id)).toEqual(['POL-P1', 'POL-P2', 'POL-P3', 'POL-P4']);
    expect(policyInScope(now, undefined)).toEqual([]);
    expect(policyInScope(now, start)[0]).toMatchObject({ source: 'policy', description: 'ids are UUIDs' });
    // Ids named like Object properties are entries, not prototype members.
    expect(policyInScope(policyTests(entry('constructor', 'x')), policyTests('')).map((c) => c.id)).toEqual(['POL-constructor']);
  });

  test('AC-3: a policy id keeps at most 40 characters', () => {
    const id = 'P'.repeat(100);
    expect(policyInScope(policyTests(entry(id, 'x')), null).map((c) => c.id)).toEqual([`POL-${'P'.repeat(40)}`]);
  });
});

describe('the session criteria', () => {
  test('AC-4: pinned from the working tree at the start; a commit made during the session hides nothing', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중'], [2, '내보내기', '미구현']]));
    const s = sid();
    pinSessionCriteria(s, d);
    write(d, 'docs/versions/1.0/REQUIREMENTS.md', reqs([[1, '로그인', '구현완료'], [2, '내보내기', '구현중']]));
    sh(d, "git add -A && git -c commit.gpgsign=false commit -q -m 'ABC-1 done'");
    expect(sessionCriteria(s, d).criteria.map((c) => c.id).sort()).toEqual(['REQ-1', 'REQ-2']);
  });

  test('AC-4: an uncommitted row implemented before the session is not asked again', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    write(d, 'docs/versions/1.0/REQUIREMENTS.md', reqs([[1, '로그인', '구현완료']])); // done in an earlier session, not committed
    const s = sid();
    pinSessionCriteria(s, d);
    expect(sessionCriteria(s, d).criteria).toEqual([]);
  });

  test('AC-4: a resumed session keeps its start: a second pin of the same repo changes nothing', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const s = sid();
    pinSessionCriteria(s, d);
    write(d, 'docs/versions/1.0/REQUIREMENTS.md', reqs([[1, '로그인', '구현완료']])); // implemented during the session
    pinSessionCriteria(s, d); // SessionStart again (resume, clear, compact)
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['REQ-1']);
  });

  test('AC-4: a criterion a Stop required stays required: deleting the policy line or the file drops nothing', () => {
    const policy = (t?: string) => ['## P1 Ids', '- decide: ai', '- source: review', '- date: 2026-10-16', '- checked: 2026-10-16', ...(t ? [`- test: ${t}`] : []), ''].join('\n');
    const d = devCycleRepo(reqs([[1, '로그인', '미구현']]), policy());
    const s = sid();
    pinSessionCriteria(s, d);
    write(d, '.goodboy/policy.md', policy('ids are UUIDs'));
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['POL-P1']);
    write(d, '.goodboy/policy.md', policy());
    rmSync(join(d, 'docs', 'versions', '1.0', 'REQUIREMENTS.md'));
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['POL-P1']);
  });

  test('AC-5: an unreadable requirements file is a problem, not an empty list', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const s = sid();
    pinSessionCriteria(s, d);
    const f = join(d, 'docs', 'versions', '1.0', 'REQUIREMENTS.md');
    rmSync(f);
    fifo(f); // a FIFO would hang a read
    const out = sessionCriteria(s, d);
    expect(out.problem).toContain('cannot be read');
    expect(out.criteria.map((c) => c.id)).toEqual(['REQ-1']); // the start's row still counts
  });

  test('no dev-cycle requirements and no policy: none', () => {
    const d = tmp();
    sh(d, 'git init -q -b main .');
    expect(sessionCriteria(sid(), d)).toEqual({ criteria: [] });
  });
});

const cov = (id: string, test: string, mutationFile?: string): AcceptanceCoverage => ({
  id,
  description: 'x',
  test,
  red: { command: 'bun test', output: '1 fail', exit_code: 1 },
  green: { command: 'bun test', output: '1 pass', exit_code: 0 },
  ...(mutationFile !== undefined ? { mutation: { command: 'bun test', output: '1 fail', detected: true, file: mutationFile } } : {}),
});

describe('a product criterion is never met by a document', () => {
  const res = (acceptance: AcceptanceCoverage[]) => [{ acceptance } as unknown as TestResult];
  const root = '/r/proj';

  test('AC-6: a document as the test or as the broken file is refused for PT, UIUX and REQ', () => {
    expect(productEvidenceProblems(res([cov('REQ-1', 'docs/versions/1.0/REQUIREMENTS.md')]), root).join()).toContain('REQ-1');
    expect(productEvidenceProblems(res([cov('PT-1', 'tests/ui.test.ts', 'docs/versions/1.0/prototype/../REQUIREMENTS.md')]), root).join()).toContain('PT-1');
    expect(productEvidenceProblems(res([cov('UIUX-2', 'tests/ui.test.ts', `${root}/README.md`)]), root).join()).toContain('UIUX-2');
  });

  test('AC-6: a test of the product code passes; other criteria are not product criteria', () => {
    expect(productEvidenceProblems(res([cov('PT-1', 'tests/ui.test.ts', 'src/a.ts'), cov('REQ-1', 'tests/a.test.ts'), cov('REQ-2', 'clamp returns lo')]), root)).toEqual([]);
    expect(productEvidenceProblems(res([cov('AC-1', 'docs/guide.md')]), root)).toEqual([]);
  });

  test('AC-6: a scratch copy path for mutation.file is refused; code under a docs folder or MDX is product code', () => {
    expect(productEvidenceProblems(res([cov('PT-6', 'tests/ui.test.ts', '/tmp/mb/docs/versions/1.0/REQUIREMENTS.md')]), root).join()).toContain('scratch copy');
    expect(productEvidenceProblems(res([cov('REQ-3', '/elsewhere/tests/a.test.ts')]), root).join()).toContain('not in this repo');
    expect(productEvidenceProblems(res([cov('PT-7', 'apps/docs/src/App.test.tsx', 'apps/docs/src/App.tsx'), cov('UIUX-8', 'tests/p.test.ts', 'content/post.mdx')]), root)).toEqual([]);
    expect(productEvidenceProblems(res([cov('PT-9', 'tests/ui.test.ts', 'docs/versions/1.0/prototype/index.html')]), root).join()).toContain('broke a document');
  });

  test('AC-6: `..` is resolved before the check: it neither hides a document nor makes product code one', () => {
    expect(productEvidenceProblems(res([cov('PT-4', 'tests/ui.test.ts', 'docs/../src/a.ts')]), root)).toEqual([]);
    expect(productEvidenceProblems(res([cov('PT-5', 'tests/ui.test.ts', 'src/../docs/shot.png')]), root).join()).toContain('PT-5');
  });

  test('AC-7: test-write: a PT or UIUX entry names the file its mutation broke', () => {
    const base = {
      timestamp: new Date().toISOString(),
      tested_files: ['/r/proj/src/a.ts'],
      category: 'add-feature',
      test_files: [],
      environment: { mode: 'none', command: 'none', evidence: 'library' },
      suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass', type: 'unit', duration_ms: 10 }],
      verdict: 'blocked',
      blocked: { reason: 'no runner for this probe test', evidence: 'n/a' },
    };
    const mut = (file?: string) => ({ command: 'bun test', output: '1 fail', detected: true, ...(file !== undefined ? { file } : {}) });
    const entry = (id: string, file?: string) => ({ ...cov(id, 'tests/ui.test.ts'), mutation: mut(file) });
    const errs = (a: unknown[]) => validateTestResultInput({ ...base, acceptance: a }).errors.join(' ');
    expect(errs([entry('PT-1')])).toContain('mutation.file');
    expect(errs([entry('PT-1', 'src/a.ts')])).not.toContain('mutation.file');
    expect(errs([entry('AC-1')])).not.toContain('mutation.file');
    expect(errs([entry('AC-1', '')])).toContain('mutation.file');
    expect(errs([entry('PT-1', '/tmp/scratch/src/a.ts')])).toContain('repo-relative');
  });
});

/** A dev-cycle repo with a session in it: the hooks run as processes in `d`, with their own
 *  TMPDIR and HOME. `start` is the SessionStart; `edit` is a code edit with its test file;
 *  `record` writes a passing test result that covers `ids`. */
function rig(d: string) {
  const box = tmp();
  const s = sid();
  const env = { ...process.env, TMPDIR: box, HOME: box, CLAUDE_PLUGIN_ROOT: ROOT, GOODBOY_CLAIM_FLUSH_WAIT_MS: '0', GOODBOY_DISABLE_DELEGATION: '1', GOODBOY_TEST_GATE: 'on' };
  const run = async (hook: string, payload: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const p = Bun.spawn(['bun', join(ROOT, 'hooks', `${hook}.ts`)], { cwd: d, env: { ...env, ...extra }, stdin: new TextEncoder().encode(JSON.stringify({ session_id: s, cwd: d, ...payload })), stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    try {
      return JSON.parse(out) as { decision?: string; reason?: string };
    } catch {
      return {};
    }
  };
  return {
    box,
    s,
    run,
    start: () => run('session-start', { hook_event_name: 'SessionStart', source: 'startup' }),
    stop: () => run('stop', { hook_event_name: 'Stop' }),
    edit: async () => {
      write(d, 'src/a.ts', 'export const a = 2;\n');
      await run('post-tool-use', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(d, 'src', 'a.ts') } });
      write(d, 'tests/a.test.ts', 'test("a", () => { expect(1).toBe(1); });\n');
    },
    record: (ids: string[]) => {
      mkdirSync(join(d, '.claude', 'tests'), { recursive: true });
      writeFileSync(
        join(d, '.claude', 'tests', 'r.json'),
        JSON.stringify({
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          tested_files: [join(d, 'src', 'a.ts')],
          category: 'add-feature',
          test_files: [join(d, 'tests', 'a.test.ts')],
          environment: { mode: 'none', command: 'none', evidence: 'library' },
          suites: [{ name: 'unit', command: 'bun test', passed: 1, failed: 0, output: '1 pass' }],
          acceptance: ids.map((id) => cov(id, 'tests/a.test.ts')),
          verdict: 'pass',
        }),
      );
    },
  };
}

describe('end to end', () => {
  test('AC-8: the Stop asks for the requirement in progress; covered, it goes on to the review', async () => {
    const d = devCycleRepo(reqs([[1, '내보내기', '구현중']]));
    const r = rig(d);
    await r.start();
    await r.edit();
    r.record(['AC-1']);
    const blocked = await r.stop();
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('REQ-1');
    r.record(['REQ-1']);
    const next = await r.stop();
    expect(next.reason ?? '').not.toContain('REQ-1');
    expect(next.reason).toContain('Review is required');
  }, 60_000);

  test('AC-8: a forged seen store does not fail the gate open: the requirement in progress still blocks', async () => {
    const d = devCycleRepo(reqs([[1, '내보내기', '구현중']]));
    const r = rig(d);
    await r.start();
    await r.edit();
    r.record(['AC-1']);
    // Before the first Stop no seen store exists; one a model call left there (round 2 threw
    //   on `${description}` and the gate passed REQ-1 untested).
    writeFileSync(join(r.box, `goodboy-session-${r.s}`, 'criteria-seen.json'), JSON.stringify([{ id: 'REQ-9', description: { toString: 1 } }]));
    const blocked = await r.stop();
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('REQ-1(내보내기)');
  }, 60_000);

  test('AC-5: a requirements file that cannot be read blocks the Stop, even when the criteria it knew are covered', async () => {
    const d = devCycleRepo(reqs([[1, '내보내기', '구현중']]));
    const r = rig(d);
    await r.start();
    await r.edit();
    const f = join(d, 'docs', 'versions', '1.0', 'REQUIREMENTS.md');
    const text = readFileSync(f, 'utf8');
    rmSync(f);
    mkdirSync(f); // a directory where the file was: not a regular file
    r.record(['REQ-1']); // the row in progress at the start is covered
    const blocked = await r.stop();
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('cannot be read');
    expect(blocked.reason).toContain('REQUIREMENTS.md');
    // Readable again, the same run goes on to the review.
    rmSync(f, { recursive: true });
    writeFileSync(f, text);
    r.record(['REQ-1']);
    const next = await r.stop();
    expect(next.reason ?? '').not.toContain('cannot be read');
    expect(next.reason).toContain('Review is required');
  }, 60_000);

  test('acceptance-list names the requirement in progress', () => {
    const d = devCycleRepo(reqs([[1, '내보내기', '구현중'], [2, '알림', '미구현']]));
    const out = JSON.parse(Bun.spawnSync(['bun', CLI, 'acceptance-list'], { cwd: d, stdout: 'pipe' }).stdout.toString()) as { criteria: { id: string }[] };
    expect(out.criteria.map((c) => c.id)).toContain('REQ-1');
    expect(out.criteria.map((c) => c.id)).not.toContain('REQ-2');
  });

  test('AC-9: SessionStart pins the criteria, also with the changed-line rule off (which pins no coverage start)', async () => {
    const d = devCycleRepo(reqs([[1, '내보내기', '구현중'], [2, '알림', '구현완료']]));
    const r = rig(d);
    await r.run('session-start', { hook_event_name: 'SessionStart', source: 'startup' }, { GOODBOY_DIFF_COVERAGE: 'off' });
    const dir = join(r.box, `goodboy-session-${r.s}`);
    expect(existsSync(join(dir, 'coverage-pin.json'))).toBe(false);
    expect(existsSync(join(dir, 'criteria-pin.json'))).toBe(true);
    const pin = JSON.parse(readFileSync(join(dir, 'criteria-pin.json'), 'utf8')) as { rows: { rank: string; title: string; status: string }[] };
    expect(pin.rows).toEqual([
      { rank: '1', title: '내보내기', status: 'in-progress' },
      { rank: '2', title: '알림', status: 'implemented' },
    ]);
  }, 30_000);
});

describe('the state guard', () => {
  test('AC-10: criteria-pin.json and criteria-seen.json are put back after a Bash call rewrote or removed them', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const s = sid();
    pinSessionCriteria(s, d);
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['REQ-1']); // writes the seen store
    const dir = ensureSessionDir(s);
    const pin = join(dir, 'criteria-pin.json');
    const seen = join(dir, 'criteria-seen.json');
    const [pinBefore, seenBefore] = [readFileSync(pin, 'utf8'), readFileSync(seen, 'utf8')];
    expect(seenBefore).toContain('REQ-1');
    snapshotGateState(s, 'toolu_i2guard');
    writeFileSync(pin, JSON.stringify({ top: d, rows: [], policy: null })); // the start rewritten
    rmSync(seen); // what a Stop required, removed
    expect(restoreGateState(s, 'toolu_i2guard').sort()).toEqual(['criteria-pin.json', 'criteria-seen.json']);
    expect(readFileSync(pin, 'utf8')).toBe(pinBefore);
    expect(readFileSync(seen, 'utf8')).toBe(seenBefore);
    // The restored files still drive the criteria: the row in progress at the start stays.
    write(d, 'docs/versions/1.0/REQUIREMENTS.md', reqs([[1, '로그인', '미구현']]));
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['REQ-1']);
  });

  test('AC-10: a criteria-seen.json or criteria-pin.json a Bash call created is removed (I2 security review round 2)', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    snapshotGateState(s, 'toolu_i2created');
    writeFileSync(join(dir, 'criteria-seen.json'), JSON.stringify([{ id: 'REQ-9', description: { toString: 1 } }]));
    writeFileSync(join(dir, 'criteria-pin.json'), JSON.stringify({ top: '/x', rows: [], policy: {} }));
    expect(restoreGateState(s, 'toolu_i2created').sort()).toEqual(['criteria-pin.json', 'criteria-seen.json']);
    expect(existsSync(join(dir, 'criteria-seen.json'))).toBe(false);
    expect(existsSync(join(dir, 'criteria-pin.json'))).toBe(false);
  });

  test('AC-10: a seen store the Stop did not write is read as strings only: no throw, no long id', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const s = sid();
    pinSessionCriteria(s, d);
    const forged = [{ id: 'REQ-9', description: { toString: 1 } }, { id: `REQ-${'9'.repeat(50)}`, description: 'x' }, { id: 7 }, null, 'REQ-8'];
    writeFileSync(join(ensureSessionDir(s), 'criteria-seen.json'), JSON.stringify(forged));
    const got = sessionCriteria(s, d);
    expect(got.problem).toBeUndefined();
    expect(got.criteria).toEqual([
      { id: 'REQ-9', source: 'requirement', description: '' },
      { id: 'REQ-1', source: 'requirement', description: '로그인' },
    ]);
    expect(() => got.criteria.map((c) => `${c.id}(${c.description})`)).not.toThrow();
  });

  test('AC-10: the seen store keeps a policy entry as policy, drops a POL id over 40 characters, and reads at most 1000 entries', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '미구현']])); // nothing in scope from the documents
    const s = sid();
    pinSessionCriteria(s, d);
    const seen = join(ensureSessionDir(s), 'criteria-seen.json');
    const pol = 'P'.repeat(40);
    writeFileSync(seen, JSON.stringify([{ id: `POL-${pol}`, description: 'ids are UUIDs' }, { id: `POL-${pol}P`, description: 'x' }]));
    expect(sessionCriteria(s, d).criteria).toEqual([{ id: `POL-${pol}`, source: 'policy', description: 'ids are UUIDs' }]);
    writeFileSync(seen, JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: `REQ-${i + 1}`, description: 'r' }))));
    const ids = sessionCriteria(s, d).criteria.map((c) => c.id);
    expect(ids).toHaveLength(1000);
    expect(ids[999]).toBe('REQ-1000');
  });

  // I2 security review round 3: what a call created was told by its mtime, which a call can
  //   set back, and a directory with a guarded name ended the removal loop.
  test('AC-10: a created file is removed by name: a backdated cursor, a link, a directory, and what comes after them', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    snapshotGateState(s, 'toolu_i2r3');
    const cursor = join(dir, '.goodboy-last-test-abc123.json');
    writeFileSync(cursor, JSON.stringify({ forged: true }));
    utimesSync(cursor, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
    const outside = join(tmp(), 'old.json');
    writeFileSync(outside, '[]');
    utimesSync(outside, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
    symlinkSync(outside, join(dir, 'criteria-pin.json'));
    mkdirSync(join(dir, 'criteria-seen.json'));
    writeFileSync(join(dir, 'skill-evidence.jsonl'), `${JSON.stringify({ k: 'skill', skill: 'forged' })}\n`);
    expect(restoreGateState(s, 'toolu_i2r3').sort()).toEqual(['.goodboy-last-test-abc123.json', 'criteria-pin.json', 'criteria-seen.json', 'skill-evidence.jsonl']);
    for (const name of ['.goodboy-last-test-abc123.json', 'criteria-pin.json', 'criteria-seen.json', 'skill-evidence.jsonl']) {
      expect(existsSync(join(dir, name))).toBe(false);
    }
    expect(readFileSync(outside, 'utf8')).toBe('[]'); // the link went, not its target
  });

  test('AC-10: a file that existed at the snapshot is never taken for a created one, even one the snapshot could not copy', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    mkdirSync(join(dir, 'criteria-seen.json')); // there before the call, not copied (no regular file)
    writeFileSync(join(dir, 'coverage-pin.json'), JSON.stringify({ top: '/x', exemptions: [] }));
    snapshotGateState(s, 'toolu_i2r3b');
    expect(restoreGateState(s, 'toolu_i2r3b')).toEqual([]);
    expect(lstatSync(join(dir, 'criteria-seen.json')).isDirectory()).toBe(true);
    expect(existsSync(join(dir, 'coverage-pin.json'))).toBe(true);
  });

  test('AC-10: a FIFO or a link at the pin or seen path neither hangs nor redirects: it is read as nothing and replaced', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const s = sid();
    const dir = ensureSessionDir(s);
    fifo(join(dir, 'criteria-pin.json'));
    pinSessionCriteria(s, d); // read as no pin, then written over the FIFO
    expect(lstatSync(join(dir, 'criteria-pin.json')).isFile()).toBe(true);
    const outside = join(tmp(), 'seen.json');
    writeFileSync(outside, JSON.stringify([{ id: 'REQ-7', description: 'outside' }]));
    symlinkSync(outside, join(dir, 'criteria-seen.json'));
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['REQ-1']); // the link's target is not read
    expect(lstatSync(join(dir, 'criteria-seen.json')).isFile()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toContain('REQ-7'); // nor written through
    rmSync(join(dir, 'criteria-seen.json'));
    symlinkSync('/dev/zero', join(dir, 'criteria-seen.json'));
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['REQ-1']);
  });

  // Layer-1 round 4: the mutation probes below went unnoticed by the tests above.
  test('AC-10: a coverage-pin.json or project-mode-pin.json a Bash call created is removed: only the hooks write the pins', () => {
    const s = sid();
    const dir = ensureSessionDir(s);
    snapshotGateState(s, 'toolu_i2r4pins');
    writeFileSync(join(dir, 'coverage-pin.json'), JSON.stringify({ top: '/x', exemptions: ['**'] }));
    writeFileSync(join(dir, 'project-mode-pin.json'), JSON.stringify({ mode: 'off' }));
    expect(restoreGateState(s, 'toolu_i2r4pins').sort()).toEqual(['coverage-pin.json', 'project-mode-pin.json']);
    expect(existsSync(join(dir, 'coverage-pin.json'))).toBe(false);
    expect(existsSync(join(dir, 'project-mode-pin.json'))).toBe(false);
  });

  test('AC-10: a directory at the pin or seen path is replaced when the hooks write it', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const s = sid();
    const dir = ensureSessionDir(s);
    mkdirSync(join(dir, 'criteria-pin.json', 'sub'), { recursive: true }); // not empty
    pinSessionCriteria(s, d);
    expect(lstatSync(join(dir, 'criteria-pin.json')).isFile()).toBe(true);
    mkdirSync(join(dir, 'criteria-seen.json'));
    expect(sessionCriteria(s, d)).toEqual({ criteria: [{ id: 'REQ-1', source: 'requirement', description: '로그인' }] });
    expect(lstatSync(join(dir, 'criteria-seen.json')).isFile()).toBe(true);
  });

  test('AC-10: only the first 1000 entries of the seen store are read: an entry after them is not', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '미구현']])); // nothing in scope from the documents
    const s = sid();
    pinSessionCriteria(s, d);
    const junk = Array.from({ length: 1000 }, () => ({ id: 7 }));
    writeFileSync(join(ensureSessionDir(s), 'criteria-seen.json'), JSON.stringify([...junk, { id: 'REQ-5', description: 'late' }]));
    expect(sessionCriteria(s, d).criteria).toEqual([]);
  });

  test('AC-10: the seen store is written with at most 1000 criteria, those found now first; the gate list is not cut', () => {
    const d = devCycleRepo(reqs([[2000, '내보내기', '구현중']]));
    const s = sid();
    pinSessionCriteria(s, d);
    const seen = join(ensureSessionDir(s), 'criteria-seen.json');
    writeFileSync(seen, JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: `REQ-${i + 1}`, description: 'r' }))));
    const ids = sessionCriteria(s, d).criteria.map((c) => c.id);
    expect(ids).toHaveLength(1001);
    expect(ids).toContain('REQ-2000');
    const stored = (JSON.parse(readFileSync(seen, 'utf8')) as { id: string }[]).map((c) => c.id);
    expect(stored).toHaveLength(1000);
    expect(stored[0]).toBe('REQ-2000');
  });

  test('AC-10: a pin larger than the documents cap is read back: rows with long titles from a 1.1 MB requirements file', () => {
    const long = '"'.repeat(560_000); // JSON doubles each quote: the pin is over 2 MB
    const d = devCycleRepo(reqs([[1, long, '구현중'], [2, `${long}y`, '구현중']]));
    const s = sid();
    pinSessionCriteria(s, d);
    expect(lstatSync(join(ensureSessionDir(s), 'criteria-pin.json')).size).toBeGreaterThan(2_000_000);
    write(d, 'docs/versions/1.0/REQUIREMENTS.md', reqs([[1, '로그인', '미구현']]));
    expect(sessionCriteria(s, d).criteria.map((c) => c.id)).toEqual(['REQ-1', 'REQ-2']);
  });

  // Layer-1 record after round 4: raising the state cap (a 4 GB mutant) failed no test. The
  //   cap is written out here, not imported: padding to the imported constant made that mutant
  //   fail by running out of memory, not by reading the pin.
  test('AC-10: a session state file over the 16 MB cap is not read: an oversized pin counts as none', () => {
    const CAP = 16 * 1024 * 1024;
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const padTo = (s: string, size: number) => {
      const pin = join(ensureSessionDir(s), 'criteria-pin.json');
      const text = readFileSync(pin, 'utf8');
      writeFileSync(pin, text + ' '.repeat(size - Buffer.byteLength(text))); // still valid JSON
    };
    const under = sid();
    const over = sid();
    pinSessionCriteria(under, d);
    pinSessionCriteria(over, d);
    padTo(under, CAP);
    padTo(over, CAP + 1);
    write(d, 'docs/versions/1.0/REQUIREMENTS.md', reqs([[1, '로그인', '미구현']])); // set back: only the pin knows the row
    expect(sessionCriteria(under, d).criteria.map((c) => c.id)).toEqual(['REQ-1']);
    expect(sessionCriteria(over, d).criteria).toEqual([]);
  });
});

describe('the dev-cycle documents are read only as regular files', () => {
  test('AC-5: UIUX.md or the prototype as a FIFO or a link to /dev/zero is reported unreadable at once, not read', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const uiux = join(d, 'docs', 'versions', '1.0', 'UIUX.md');
    symlinkSync('/dev/zero', uiux);
    expect(readAcceptance(d).problem).toEqual({ kind: 'unreadable', files: [uiux] });
    rmSync(uiux);
    const proto = join(d, 'docs', 'versions', '1.0', 'prototype', 'index.html');
    mkdirSync(dirname(proto), { recursive: true });
    fifo(proto);
    expect(readAcceptance(d).problem).toEqual({ kind: 'unreadable', files: [proto] });
    // acceptance-list reads the prototype too (its contract warnings): it ends at once.
    const list = Bun.spawnSync(['bun', CLI, 'acceptance-list'], { cwd: d, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    expect(list.exitCode).toBe(0);
    const reqFile = join(d, 'docs', 'versions', '1.0', 'REQUIREMENTS.md');
    rmSync(reqFile);
    fifo(reqFile);
    expect(sessionCriteria(sid(), d).problem).toContain('REQUIREMENTS.md cannot be read');
  });

  // Layer-1 round 4: reading docs/CYCLE.md, the size cap and a document that cannot be opened
  //   had no test here (a FIFO first: a mutation that reads it then hangs instead of filling memory).
  test('AC-5: docs/CYCLE.md as a FIFO or a link to /dev/zero is reported unreadable at once, not read', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const cycle = join(d, 'docs', 'CYCLE.md');
    rmSync(cycle);
    fifo(cycle);
    expect(readAcceptance(d).problem).toEqual({ kind: 'unreadable', files: [cycle] });
    rmSync(cycle);
    symlinkSync('/dev/zero', cycle);
    expect(readAcceptance(d).problem).toEqual({ kind: 'unreadable', files: [cycle] });
  });

  test('AC-5: a dev-cycle document over the size cap is reported unreadable, not parsed', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const uiux = join(d, 'docs', 'versions', '1.0', 'UIUX.md');
    writeFileSync(uiux, `## 화면 목록\n\n| 화면 | 구분 |\n|---|---|\n| 설정 | 신규 |\n${' '.repeat(2_000_000)}`);
    expect(readAcceptance(d)).toMatchObject({ criteria: [], problem: { kind: 'unreadable', files: [uiux] } });
    rmSync(uiux);
    writeFileSync(join(d, 'docs', 'versions', '1.0', 'REQUIREMENTS.md'), reqs([[1, '로그인', '구현중']]) + ' '.repeat(2_000_000));
    expect(sessionCriteria(sid(), d).problem).toContain('REQUIREMENTS.md cannot be read');
  });

  // Resume after round 4: the size test above cannot tell a read to the end of the file from a
  //   bounded one; only a file that grows after it was measured can.
  test('AC-5: a document that grows after it was measured is read only up to that size, never past the cap', () => {
    const f = join(tmp(), 'growing.md');
    writeFileSync(f, 'x'.repeat(MAX_DOC_BYTES + 1000));
    const real = fs.fstatSync;
    const spy = spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const st = real(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: MAX_DOC_BYTES });
    }) as typeof fs.fstatSync);
    try {
      const read = readRegular(f, MAX_DOC_BYTES);
      expect(typeof read === 'string' ? read : read.text.length).toBe(MAX_DOC_BYTES);
    } finally {
      spy.mockRestore();
    }
  });

  // As root the chmod blocks nothing and the test would prove nothing (the repo's convention).
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('AC-5: a UIUX.md or prototype that cannot be opened is reported unreadable', () => {
    const d = devCycleRepo(reqs([[1, '로그인', '구현중']]));
    const proto = join(d, 'docs', 'versions', '1.0', 'prototype', 'index.html');
    write(d, 'docs/versions/1.0/prototype/index.html', '<div class="pt-frame"><main class="board"></main></div>\n');
    chmodSync(proto, 0o000);
    try {
      expect(readAcceptance(d).problem).toEqual({ kind: 'unreadable', files: [proto] });
    } finally {
      chmodSync(proto, 0o644);
    }
  });
});
