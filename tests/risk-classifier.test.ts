import { describe, expect, test } from 'bun:test';
import { classifyRisk, detectRiskOverride, explainRisk, findRiskyKeyword, isReadOnlyBash } from '../lib/risk-classifier';

describe('classifyRisk', () => {
  test('userOverride takes precedence over everything', () => {
    expect(
      classifyRisk({
        category: 'fix-bug',
        fileCount: 10,
        prompt: 'drop table users in production',
        riskDefault: 'simple',
        userOverride: 'simple',
      }),
    ).toBe('simple');
  });

  test('starts from riskDefault', () => {
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'hello', riskDefault: 'simple' })).toBe('simple');
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'hello', riskDefault: 'medium' })).toBe('medium');
  });

  test('invalid riskDefault falls back to medium', () => {
    expect(
      classifyRisk({ category: 'x', fileCount: 0, prompt: 'hi', riskDefault: 'bogus' as never }),
    ).toBe('medium');
  });

  test('3+ files bumps one level up', () => {
    expect(classifyRisk({ category: 'x', fileCount: 3, prompt: 'hi', riskDefault: 'simple' })).toBe('medium');
    expect(classifyRisk({ category: 'x', fileCount: 5, prompt: 'hi', riskDefault: 'medium' })).toBe('risky');
  });

  test('bump cannot exceed risky', () => {
    expect(classifyRisk({ category: 'x', fileCount: 9, prompt: 'hi', riskDefault: 'risky' })).toBe('risky');
  });

  test('risky keyword forces risky regardless of base level', () => {
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'deploy to production now', riskDefault: 'simple' })).toBe('risky');
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'run rm -rf /tmp', riskDefault: 'simple' })).toBe('risky');
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: '마이그레이션 진행', riskDefault: 'simple' })).toBe('risky');
  });

  test('keyword match is case-insensitive', () => {
    expect(classifyRisk({ category: 'x', fileCount: 0, prompt: 'DROP TABLE accounts', riskDefault: 'simple' })).toBe('risky');
  });

  // A4: substring matching made "prod" match ordinary words and locked sessions as risky.
  test('ASCII keywords match whole words only: product/reproduce/producer are not risky', () => {
    for (const prompt of ['add product search page', 'reproduce the crash', 'kafka producer retry', 'preprod smoke test']) {
      expect(classifyRisk({ category: 'x', fileCount: 0, prompt, riskDefault: 'simple' })).toBe('simple');
    }
  });

  test('real risky phrasings still match', () => {
    for (const prompt of ['deploy to prod', 'point it at the prod-db', 'PROD hotfix', 'run migrations', 'migrated schema', 'git push --force-with-lease', 'force push main']) {
      expect(classifyRisk({ category: 'x', fileCount: 0, prompt, riskDefault: 'simple' })).toBe('risky');
    }
  });

  test('explainRisk gives the same level as classifyRisk plus the cause', () => {
    const base = { category: 'x', fileCount: 0, riskDefault: 'simple' as const };
    expect(explainRisk({ ...base, prompt: 'deploy to prod' })).toEqual({ level: 'risky', reason: 'keyword:prod' });
    expect(explainRisk({ ...base, prompt: 'x', riskDefault: 'risky' })).toEqual({ level: 'risky', reason: 'default' });
    expect(explainRisk({ ...base, prompt: 'prod', userOverride: 'simple' })).toEqual({ level: 'simple', reason: 'override' });
    expect(explainRisk({ ...base, prompt: 'x', fileCount: 5, riskDefault: 'medium' })).toEqual({ level: 'risky', reason: 'file-count' });
    expect(explainRisk({ ...base, prompt: 'hello' })).toEqual({ level: 'simple', reason: 'none' });
  });

  test('findRiskyKeyword names the matched keyword', () => {
    expect(findRiskyKeyword('deploy to production')).toBe('prod');
    expect(findRiskyKeyword('운영 DB 확인')).toBe('운영');
    expect(findRiskyKeyword('add product page')).toBeNull();
  });
});

describe('isReadOnlyBash (risk-gate exemption, A4)', () => {
  test('allows inspection commands', () => {
    for (const cmd of [
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'ls -la',
      'cat src/a.ts | head -n 5',
      'cd src && ls',
      'git show HEAD:README.md 2>/dev/null',
      'tail -n 20 build.log',
    ]) {
      expect(isReadOnlyBash(cmd)).toBe(true);
    }
  });

  // Review of A4 (high): an allowlisted command with a writing option is self-approval —
  // the risk marker is just a file.
  test('rejects allowlisted commands with options that write files or run programs', () => {
    for (const cmd of [
      'git diff --output=.claude/.goodboy-risk-approved.txt',
      'git log --output .claude/.goodboy-risk-approved.txt',
      'git diff -o x',
      'git diff --ext-diff',
      'git log -p --textconv',
      'git -c core.pager=sh log',
      'find . -fprint .claude/.goodboy-risk-approved.txt',
      'rg --pre sh x',
      'tree -o .claude/.goodboy-risk-approved.txt',
      'file -C -m magic',
      'grep -rn TODO .',
    ]) {
      expect(isReadOnlyBash(cmd)).toBe(false);
    }
  });

  // Security review of A4 (high): zsh expansions run programs inside "read-only" commands.
  test('rejects any shell expansion, including zsh-only forms', () => {
    for (const cmd of [
      'cat =(touch .claude/.goodboy-risk-approved.txt)',
      "ls *(e:'touch .claude/.goodboy-risk-approved.txt':)",
      'cat ${x@P}',
      'cat $HOME/.zshrc',
      'cat "$(id)"',
      "cat '`id`'",
      'ls ~',
      'git log !1',
      'cat a{1,2}',
      'ls src/*.ts',
      'cat a\\ b',
      'git status 2>&1',
    ]) {
      expect(isReadOnlyBash(cmd)).toBe(false);
    }
  });

  test('rejects anything that can run project code or write', () => {
    for (const cmd of [
      'npm run migrate',
      'bun run db:migrate',
      'echo hi',
      'echo hi > a.txt',
      'ls > out.txt',
      'cat $(rm -rf x)',
      'cat `rm x`',
      'cat <(rm x)',
      'find . -delete',
      'find . -exec rm {} ;',
      'git push --force',
      'git branch -D feature',
      'git checkout -- .',
      'rm -rf build',
      'FOO=1 ls',
      '',
    ]) {
      expect(isReadOnlyBash(cmd)).toBe(false);
    }
  });
});

describe('detectRiskOverride', () => {
  test('parses --risk=value, --risk value, --risk:value', () => {
    expect(detectRiskOverride('fix this --risk=risky')).toBe('risky');
    expect(detectRiskOverride('fix this --risk medium')).toBe('medium');
    expect(detectRiskOverride('fix this --risk:simple')).toBe('simple');
  });

  test('case-insensitive flag', () => {
    expect(detectRiskOverride('--risk RISKY')).toBe('risky');
  });

  test('returns undefined when absent or invalid', () => {
    expect(detectRiskOverride('no flag here')).toBeUndefined();
    expect(detectRiskOverride('--risk=banana')).toBeUndefined();
    expect(detectRiskOverride('')).toBeUndefined();
  });
});
