import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { findRecentReviewFile, validateReview } from '../lib/review-validator';
import { timestampToFilename, validateReviewResultInput } from '../lib/cli';

const CLI = resolve(import.meta.dir, '..', 'lib', 'cli.ts');
const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function newCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'vcf-rw-'));
  tmpDirs.push(cwd);
  return cwd;
}

async function runReviewWrite(
  cwd: string,
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI, 'review-write'], {
    cwd,
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const validReview = {
  timestamp: '2026-05-11T14:23:00Z',
  reviewed_files: ['/repo/a.ts', '/repo/b.ts'],
  category: 'fix-bug',
  findings: [
    {
      file: '/repo/a.ts',
      line: 42,
      issue: '환각 의심',
      severity: 'high',
      probe: "bun -e 'import(\"./a.ts\")' → ReferenceError: foo is not defined",
    },
  ],
  unknown_assumptions_checked: [],
  verdict: 'needs-changes',
};

describe('review-write CLI (#7)', () => {
  test('valid input writes a schema-valid file loadable by findRecentReviewFile + validateReview', async () => {
    const cwd = newCwd();
    const { code, stdout } = await runReviewWrite(cwd, JSON.stringify(validReview));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { ok: boolean; path: string; timestamp: string };
    expect(out.ok).toBe(true);
    expect(out.timestamp).toBe('2026-05-11T14:23:00Z');

    // Filename: colons replaced by dashes
    const reviewsDir = join(cwd, '.claude', 'reviews');
    const files = readdirSync(reviewsDir);
    expect(files).toContain('2026-05-11T14-23-00Z.json');
    // macOS는 $TMPDIR을 /private로 symlink resolve할 수 있어 prefix가 다를 수 있다.
    expect(out.path.endsWith('/.claude/reviews/2026-05-11T14-23-00Z.json')).toBe(true);

    // findRecentReviewFile can load it (withinMinutes large because of fixed timestamp -> use mtime, fresh)
    const loaded = findRecentReviewFile(reviewsDir, 60);
    expect(loaded).not.toBeNull();
    expect(loaded!.verdict).toBe('needs-changes');

    // validateReview accepts it for the reviewed files
    const vr = validateReview(loaded!, ['/repo/a.ts']);
    expect(vr.ok).toBe(true);
  });

  test('missing timestamp is generated (ISO now)', async () => {
    const cwd = newCwd();
    const { timestamp, ...noTs } = validReview;
    const { code, stdout } = await runReviewWrite(cwd, JSON.stringify(noTs));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { timestamp: string };
    // valid ISO
    expect(Number.isNaN(Date.parse(out.timestamp))).toBe(false);
  });

  test('unknown_assumptions_checked defaults to [] when omitted', async () => {
    const cwd = newCwd();
    const { unknown_assumptions_checked, ...noUac } = validReview;
    const { code } = await runReviewWrite(cwd, JSON.stringify(noUac));
    expect(code).toBe(0);
    const loaded = findRecentReviewFile(join(cwd, '.claude', 'reviews'), 60);
    expect(loaded!.unknown_assumptions_checked).toEqual([]);
  });

  test('invalid: bad verdict => exit 1 with message', async () => {
    const cwd = newCwd();
    const bad = { ...validReview, verdict: 'maybe' };
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('verdict');
  });

  test('invalid: missing reviewed_files => exit 1', async () => {
    const cwd = newCwd();
    const { reviewed_files, ...bad } = validReview;
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('reviewed_files');
  });

  test('invalid: empty reviewed_files array => exit 1', async () => {
    const cwd = newCwd();
    const bad = { ...validReview, reviewed_files: [] };
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('reviewed_files');
  });

  test('invalid: bad severity => exit 1', async () => {
    const cwd = newCwd();
    const bad = {
      ...validReview,
      findings: [{ file: '/repo/a.ts', issue: 'x', severity: 'critical' }],
    };
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('severity');
  });

  test('invalid: empty stdin => exit 1', async () => {
    const cwd = newCwd();
    const { code, stderr } = await runReviewWrite(cwd, '');
    expect(code).toBe(1);
    expect(stderr).toContain('비어');
  });

  test('REJECTS a high finding lacking probe (exit 1, mentions probe)', async () => {
    const cwd = newCwd();
    const bad = {
      ...validReview,
      findings: [{ file: '/repo/a.ts', line: 1, issue: 'data loss', severity: 'high' }],
    };
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('probe');
  });

  test('REJECTS a medium finding lacking probe (exit 1)', async () => {
    const cwd = newCwd();
    const bad = {
      ...validReview,
      verdict: 'pass',
      findings: [{ file: '/repo/a.ts', issue: 'missing validation', severity: 'medium' }],
    };
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('probe');
  });

  test('ACCEPTS the same high finding when probe is present', async () => {
    const cwd = newCwd();
    const good = {
      ...validReview,
      findings: [
        {
          file: '/repo/a.ts',
          line: 1,
          issue: 'data loss',
          severity: 'high',
          probe: "echo '{}' > db.json; bun run cli → overwrote db.json (data loss reproduced)",
        },
      ],
    };
    const { code, stdout } = await runReviewWrite(cwd, JSON.stringify(good));
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  test('REJECTS empty-string probe on high finding', async () => {
    const cwd = newCwd();
    const bad = {
      ...validReview,
      findings: [{ file: '/repo/a.ts', issue: 'x', severity: 'high', probe: '   ' }],
    };
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('probe');
  });

  test('low finding may omit probe', async () => {
    const cwd = newCwd();
    const ok = {
      ...validReview,
      verdict: 'pass',
      findings: [{ file: '/repo/a.ts', issue: 'cosmetic', severity: 'low' }],
    };
    const { code } = await runReviewWrite(cwd, JSON.stringify(ok));
    expect(code).toBe(0);
  });

  test('dimensions_checked is accepted and persisted', async () => {
    const cwd = newCwd();
    const withDims = {
      ...validReview,
      dimensions_checked: ['web-hardening', 'error-path'],
    };
    const { code } = await runReviewWrite(cwd, JSON.stringify(withDims));
    expect(code).toBe(0);
    const loaded = findRecentReviewFile(join(cwd, '.claude', 'reviews'), 60);
    expect(loaded!.dimensions_checked).toEqual(['web-hardening', 'error-path']);
  });

  test('dimensions_checked defaults to [] when omitted', async () => {
    const cwd = newCwd();
    const { code } = await runReviewWrite(cwd, JSON.stringify(validReview));
    expect(code).toBe(0);
    const loaded = findRecentReviewFile(join(cwd, '.claude', 'reviews'), 60);
    expect(loaded!.dimensions_checked).toEqual([]);
  });

  test('dimensions_checked must be a string array', async () => {
    const cwd = newCwd();
    const bad = { ...validReview, dimensions_checked: [1, 2] };
    const { code, stderr } = await runReviewWrite(cwd, JSON.stringify(bad));
    expect(code).toBe(1);
    expect(stderr).toContain('dimensions_checked');
  });

  test('BACKWARD COMPAT: old review JSON (no probe / no dimensions_checked) still loads', async () => {
    const cwd = newCwd();
    // Simulate an old on-disk review file written before probe/dimensions existed.
    const reviewsDir = join(cwd, '.claude', 'reviews');
    mkdirSync(reviewsDir, { recursive: true });
    const old = {
      timestamp: '2026-01-01T00:00:00Z',
      reviewed_files: ['/repo/a.ts'],
      category: 'fix-bug',
      findings: [{ file: '/repo/a.ts', issue: 'old high finding', severity: 'high' }],
      unknown_assumptions_checked: [],
      verdict: 'needs-changes',
    };
    writeFileSync(join(reviewsDir, '2026-01-01T00-00-00Z.json'), JSON.stringify(old), 'utf8');
    const loaded = findRecentReviewFile(reviewsDir, 99999999);
    expect(loaded).not.toBeNull();
    expect(loaded!.verdict).toBe('needs-changes');
    // missing dimensions_checked defaulted to []
    expect(loaded!.dimensions_checked).toEqual([]);
    // old high finding without probe still readable
    expect(loaded!.findings[0]!.severity).toBe('high');
  });
});

describe('validateReviewResultInput (unit)', () => {
  test('accepts a valid result and normalizes defaults', () => {
    const { unknown_assumptions_checked, timestamp, ...minimal } = validReview;
    const r = validateReviewResultInput(minimal);
    expect(r.ok).toBe(true);
    expect(r.value!.unknown_assumptions_checked).toEqual([]);
    expect(typeof r.value!.timestamp).toBe('string');
  });

  test('collects multiple errors', () => {
    const r = validateReviewResultInput({ category: 5, verdict: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(1);
  });
});

describe('review-write path traversal hardening (1-B)', () => {
  test('malicious ../ timestamp cannot escape reviews dir', async () => {
    const cwd = newCwd();
    const malicious = { ...validReview, timestamp: '../../../evil' };
    const { code, stdout } = await runReviewWrite(cwd, JSON.stringify(malicious));
    expect(code).toBe(0);
    const out = JSON.parse(stdout) as { path: string };
    // macOS $TMPDIR은 /private로 심링크되어 자식의 process.cwd()가 realpath로 해석된다.
    //   양쪽을 realpathSync로 정규화해 심링크 차이 없이 컨테인먼트를 검증한다.
    const reviewsDir = realpathSync(join(cwd, '.claude', 'reviews'));
    expect(realpathSync(out.path).startsWith(reviewsDir + sep)).toBe(true);
    // 정확히 한 파일, 파일명에 경로 구분자/선행 점 없음.
    const files = readdirSync(join(cwd, '.claude', 'reviews'));
    expect(files.length).toBe(1);
    expect(files[0]).not.toContain('/');
    expect(files[0]!.startsWith('.')).toBe(false);
    // reviews 밖으로 새어나간 파일이 없어야 한다.
    expect(existsSync(join(cwd, 'evil.json'))).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'evil.json'))).toBe(false);
  });

  test('timestamp with slashes flattens to underscores (unit)', () => {
    expect(timestampToFilename('a/b/c')).toBe('a_b_c');
    expect(timestampToFilename('../x')).toBe('_x');
    expect(timestampToFilename('2026-05-11T14:23:00Z')).toBe('2026-05-11T14-23-00Z');
  });

  test('all-dot / empty timestamp falls back to a safe name (unit)', () => {
    expect(timestampToFilename('...')).toBe('review');
    expect(timestampToFilename('')).toBe('review');
    expect(timestampToFilename('/')).toBe('_');
  });
});
