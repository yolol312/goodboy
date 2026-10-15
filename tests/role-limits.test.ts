import { describe, expect, test } from 'bun:test';
import { roleOf } from '../lib/routing-policy';
import { isDocPath, isTestPath, projectRelative, skillDenial, writeDenial } from '../lib/role-limits';

// Track G role limits. Roles come from the table by name; the expectations are literal.

const ROOT = '/repo';
const role = (n: string) => roleOf(n)!;

describe('projectRelative', () => {
  test('inside, outside, the root itself', () => {
    expect(projectRelative('/repo/src/a.ts', ROOT)).toBe('src/a.ts');
    expect(projectRelative('/tmp/probe/a.ts', ROOT)).toBeNull();
    expect(projectRelative('/repo-other/a.ts', ROOT)).toBeNull();
    expect(projectRelative('/repo', ROOT)).toBeNull();
  });
});

describe('test and doc paths', () => {
  test('test files across ecosystems', () => {
    for (const p of [
      'tests/a.ts', 'src/__tests__/b.tsx', 'e2e/login.spec.ts', 'src/a.test.ts', 'pkg/x_test.go',
      'app/test_views.py', 'conftest.py', 'src/test/java/FooTest.java', 'spec/models/user_spec.rb',
      'playwright.config.ts', 'tests/fixtures/data.json',
    ]) {
      expect([p, isTestPath(p)]).toEqual([p, true]);
    }
    for (const p of ['src/a.ts', 'src/latest.ts', 'contest.py', 'src/attestation.ts', 'package.json']) {
      expect([p, isTestPath(p)]).toEqual([p, false]);
    }
  });

  test('doc files', () => {
    expect(isDocPath('README.md')).toBe(true);
    expect(isDocPath('docs/guide/setup.png')).toBe(true);
    expect(isDocPath('src/a.ts')).toBe(false);
  });
});

describe('writeDenial by scope', () => {
  test('code roles write anything', () => {
    expect(writeDenial(role('build-backend'), '/repo/src/api.ts', ROOT)).toBeNull();
  });

  test('test writers: test files only', () => {
    expect(writeDenial(role('test-unit'), '/repo/tests/api.test.ts', ROOT)).toBeNull();
    expect(writeDenial(role('test-unit'), '/repo/src/api.ts', ROOT)).toContain('test files only');
  });

  test('build-docs: docs only', () => {
    expect(writeDenial(role('build-docs'), '/repo/docs/x.md', ROOT)).toBeNull();
    expect(writeDenial(role('build-docs'), '/repo/src/x.ts', ROOT)).toContain('docs only');
  });

  test('reviewers and read-only roles write nothing in the project; outside is fine', () => {
    expect(writeDenial(role('review-all'), '/repo/src/x.ts', ROOT)).toContain('through the goodboy CLI');
    expect(writeDenial(role('research-code'), '/repo/notes.md', ROOT)).toContain('read-only');
    expect(writeDenial(role('review-all'), '/tmp/probe/x.ts', ROOT)).toBeNull();
  });
});

describe('skillDenial', () => {
  test('own tool skills, bare or namespaced', () => {
    expect(skillDenial(role('review-security'), 'check-security')).toBeNull();
    expect(skillDenial(role('review-security'), 'goodboy:record-review')).toBeNull();
  });

  test('another role tool skill, a workflow skill, another plugin', () => {
    expect(skillDenial(role('review-security'), 'write-migration')).toContain('only its tool skills');
    expect(skillDenial(role('test-unit'), 'goodboy:fix-bug')).toContain('Workflow skills');
    expect(skillDenial(role('test-unit'), 'other:record-tests')).not.toBeNull();
    expect(skillDenial(role('test-lead'), 'record-tests')).toContain('(none)');
    expect(skillDenial(role('build-docs'), 'keep-project-knowledge')).toBeNull();
  });
});
