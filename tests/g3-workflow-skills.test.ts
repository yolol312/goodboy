// G3 contract (track G §10.4): the workflow skills are slim, English, renamed and carry the
// plan's effort; the prompt hook registers exactly them as category commands. Fixture from the
// plan's table, independent of the code.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSkillFrontmatter } from '../lib/required-inputs';
import { WORKFLOW_EFFORT } from '../lib/effort-advice';
import { isWorkflowSkill } from '../lib/skill-rule';

const ROOT = resolve(import.meta.dir, '..');

const WORKFLOWS: Record<string, { effort: string; risk: string }> = {
  'add-feature': { effort: 'high', risk: 'medium' },
  'fix-bug': { effort: 'high', risk: 'simple' },
  'diagnose-failure': { effort: 'high', risk: 'simple' },
  'refactor-code': { effort: 'high', risk: 'medium' },
  'prepare-migration': { effort: 'xhigh', risk: 'risky' },
  'write-doc': { effort: 'medium', risk: 'simple' },
  'request-review': { effort: 'low', risk: 'simple' },
};

describe('workflow skills', () => {
  for (const [name, want] of Object.entries(WORKFLOWS)) {
    test(`${name}: slim, English, effort and risk as planned`, () => {
      const path = join(ROOT, 'skills', name, 'SKILL.md');
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n').length;
      expect([name, lines >= 30 && lines <= 55]).toEqual([name, true]);
      const fm = parseSkillFrontmatter(path)!;
      expect([fm.name, fm.risk_default]).toEqual([name, want.risk as never]);
      expect(text).toMatch(new RegExp(`^effort: ${want.effort}$`, 'm'));
      expect(WORKFLOW_EFFORT[name]).toBe(want.effort as never);
      expect(isWorkflowSkill(`goodboy:${name}`)).toBe(true);
      // The body is English; Korean stays in the menu description, the questions for the user
      //   and the rationale headings the reasoning parser reads.
      const body = text.slice(text.indexOf('\n---', 4) + 4);
      const hangul = (body.match(/[가-힣]+/g) ?? []).filter((w) => !['근거', '사실', '판단', '가정', '추측', '확인', '필요'].includes(w));
      expect([name, hangul]).toEqual([name, []]);
      // Tests and review go to the routed agents.
      if (name !== 'diagnose-failure') expect(body).toContain('goodboy:review-all');
    });
  }

  test('the pre-G3 names are gone from skills/; they count as evidence only with the goodboy prefix', () => {
    for (const old of ['debug', 'refactor', 'migrate']) {
      expect([old, existsSync(join(ROOT, 'skills', old))]).toEqual([old, false]);
      expect([old, isWorkflowSkill(`goodboy:${old}`), isWorkflowSkill(old)]).toEqual([old, true, false]);
    }
    // The English rationale labels are the ones the parser reads.
    for (const name of ['fix-bug', 'add-feature']) {
      const text = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
      expect([name, text.includes('Speculations'), text.includes('Guesses')]).toEqual([name, true, false]);
    }
  });

  test('prepare-migration stops at a local dry run (the migrate contradiction)', () => {
    const text = readFileSync(join(ROOT, 'skills', 'prepare-migration', 'SKILL.md'), 'utf8');
    expect(text).toContain('Never run a migration against a shared, staging or production system');
    expect(text).not.toMatch(/run the migration (?:in|on) production/i);
  });

  test('the prompt hook knows exactly these category commands', () => {
    const src = readFileSync(join(ROOT, 'hooks', 'user-prompt-submit.ts'), 'utf8');
    const set = src.match(/const KNOWN_CATEGORIES = new Set\(\[([^\]]*)\]/)![1]!;
    const names = [...set.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort();
    expect(names).toEqual(Object.keys(WORKFLOWS).sort());
  });
});
