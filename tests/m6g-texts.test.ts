// M6g (track M, #19): the texts that send a reviewer to the data-privacy axis, and the README that describes it.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROLES } from '../lib/routing-policy';

const ROOT = resolve(import.meta.dir, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('the reviewers and the skill', () => {
  test('only review-all may use check-data-privacy, and its definition sends the data-privacy axis to it', () => {
    const users = ROLES.filter((r) => r.toolSkills.includes('check-data-privacy')).map((r) => r.name);
    expect(users).toEqual(['review-all']);
    const body = read('agents/review-all.md');
    expect(body).toMatch(/`data-privacy`[^]*check-data-privacy/);
    expect(body).toContain('reviewed_files');
  });

  test('review-lead sends the axis to a review-all member and names no tool skill of its own for it', () => {
    const body = read('agents/review-lead.md');
    expect(body).toMatch(/`data-privacy`: a review-all member with `axis: data-privacy`/);
    expect(body).not.toContain('check-data-privacy');
  });

  test('record-review makes the dimension its own and says what the run gate needs', () => {
    const body = read('skills/record-review/SKILL.md');
    expect(body).toMatch(/`data-privacy` is a\s+dimension of its own/);
    expect(body).toContain('reviewed_files');
  });

  test('the skill covers the five areas and never reads a value', () => {
    const body = read('skills/check-data-privacy/SKILL.md');
    for (const area of ['Data access', 'Output channels', 'Artifact mounts', 'Helper assertions', 'Exports']) expect(body).toContain(area);
    for (const word of ['sandbox-data', 'valueOf', 'assertMatches', 'expectedCount', '/goodboy-data', 'read-only']) expect(body).toContain(word);
    expect(body).toMatch(/Never run a query against, or read a value from/);
  });

  test('the skill directory exists once, with only a SKILL.md', () => {
    expect(readdirSync(join(ROOT, 'skills', 'check-data-privacy'))).toEqual(['SKILL.md']);
  });
});

describe('the README', () => {
  const readme = read('README.md');

  test('the axis table has the data-privacy row, and the tool skill count is 29 everywhere it is stated', () => {
    expect(readme).toMatch(/^\| `data-privacy` \| `data-privacy` /m);
    expect(readme).toContain('에이전트 24개와 도구 스킬 29개');
    expect(readme).toContain('<도구 스킬 29개>/SKILL.md');
    expect(readme).not.toContain('도구 스킬 28개');
    expect(readme).toContain('check-data-privacy(트랙 M, M6g');
  });

  test('the v0.37.0 details have the M6g bullet with the codes and the switch', () => {
    const i = readme.indexOf('- M6g 개인정보 리뷰(트랙 M, #19)');
    expect(i).toBeGreaterThan(readme.indexOf('- M6d 기록 정화(트랙 M, #19)'));
    const bullet = readme.slice(i, readme.indexOf('\n', i));
    for (const word of ['privacy-review-missing', 'privacy-setup-unreadable', 'GOODBOY_SANDBOX_PRIVACY_GATE=off', 'data.json', 'check-data-privacy', 'review-axes']) expect(bullet).toContain(word);
  });
});
