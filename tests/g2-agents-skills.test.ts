// G2 contract (track G §10.3–10.4): the 24 agent files and the tool skills (23 from G2, one
// from H2) match the plan.
// The expected values are an independent fixture taken from the plan's tables, not the policy
// table itself (§10.10: contract tests use independent fixtures).
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROLES } from '../lib/routing-policy';

const ROOT = resolve(import.meta.dir, '..');

/** Plan §10.3: model / effort, and whether the agent writes files and calls members. */
const AGENTS: Record<string, { model: string; effort: string; write: boolean; agent: boolean; web: boolean }> = {
  'research-lead': { model: 'opus', effort: 'medium', write: false, agent: true, web: false },
  'research-web': { model: 'sonnet', effort: 'medium', write: false, agent: false, web: true },
  'research-code': { model: 'sonnet', effort: 'medium', write: false, agent: false, web: false },
  'research-cause': { model: 'opus', effort: 'high', write: false, agent: false, web: false },
  'build-backend': { model: 'sonnet', effort: 'high', write: true, agent: false, web: false },
  'build-frontend': { model: 'sonnet', effort: 'high', write: true, agent: false, web: false },
  'build-data': { model: 'opus', effort: 'high', write: true, agent: false, web: false },
  'build-infra': { model: 'sonnet', effort: 'high', write: true, agent: false, web: false },
  'build-docs': { model: 'sonnet', effort: 'medium', write: true, agent: false, web: false },
  'build-run': { model: 'haiku', effort: 'low', write: false, agent: false, web: false },
  'review-lead': { model: 'sonnet', effort: 'high', write: false, agent: true, web: false },
  'review-all': { model: 'sonnet', effort: 'high', write: false, agent: false, web: false },
  'review-spec': { model: 'sonnet', effort: 'high', write: false, agent: false, web: false },
  'review-quality': { model: 'sonnet', effort: 'medium', write: false, agent: false, web: false },
  'review-security': { model: 'opus', effort: 'high', write: false, agent: false, web: false },
  'review-ui': { model: 'sonnet', effort: 'medium', write: false, agent: false, web: false },
  'review-infra': { model: 'sonnet', effort: 'high', write: false, agent: false, web: false },
  'review-evidence': { model: 'opus', effort: 'high', write: false, agent: false, web: false },
  'test-lead': { model: 'sonnet', effort: 'high', write: false, agent: true, web: false },
  'test-unit': { model: 'sonnet', effort: 'high', write: true, agent: false, web: false },
  'test-spec': { model: 'sonnet', effort: 'high', write: true, agent: false, web: false },
  'test-ui': { model: 'sonnet', effort: 'high', write: true, agent: false, web: false },
  'test-security': { model: 'opus', effort: 'high', write: true, agent: false, web: false },
  'test-probe': { model: 'sonnet', effort: 'high', write: false, agent: false, web: true },
};

/** Plan §10.4 and §14.3: the 24 tool skills and their effort (follow-agent-rules is a preload,
 *  no effort). */
const TOOL_SKILLS: Record<string, string | null> = {
  'write-migration': 'xhigh',
  'isolate-cause': 'high',
  'write-api-contract': 'high',
  'edit-infra-safely': 'high',
  'check-spec-coverage': 'high',
  'check-security': 'high',
  'check-infra-config': 'high',
  'check-evidence': 'high',
  'write-regression-test': 'high',
  'probe-runtime': 'high',
  'attack-sandbox': 'high',
  'cite-sources': 'medium',
  'summarize-diff': 'medium',
  'follow-design-tokens': 'medium',
  'check-code-quality': 'medium',
  'check-ui-states': 'medium',
  'run-e2e': 'medium',
  'record-review': 'low',
  'record-tests': 'low',
  'run-long-command': 'low',
  'run-codex-review': 'low',
  'measure-coverage': 'low',
  'follow-agent-rules': null,
  // Track H (§14.3): also user-invocable.
  'keep-project-knowledge': 'high',
  // Track J (§16, J1): user-invocable, run by the user in any project.
  'report-goodboy': 'medium',
  // Track K (§17, K1d): user-invocable, run by the user after a CLI update.
  'cli-update-check': 'high',
};
const USER_INVOCABLE_TOOL_SKILLS = new Set(['keep-project-knowledge', 'report-goodboy', 'cli-update-check']);

function frontmatter(path: string): { fields: Record<string, string>; body: string; lines: number } {
  const text = readFileSync(path, 'utf8');
  const m = text.match(/^---\n([^]*?)\n---\n([^]*)$/);
  if (!m) throw new Error(`no frontmatter: ${path}`);
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^([a-z_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  return { fields, body: m[2]!, lines: text.split('\n').length };
}

const toolList = (s: string) => new Set(s.split(',').map((t) => t.trim()).filter(Boolean));

describe('the 24 agents', () => {
  test('one file per agent, and nothing else in agents/', () => {
    const files = readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    expect(files.sort()).toEqual(Object.keys(AGENTS).sort());
    expect(ROLES.map((r) => r.name).sort()).toEqual(Object.keys(AGENTS).sort());
  });

  for (const [name, want] of Object.entries(AGENTS)) {
    test(`${name}: frontmatter, tools and tool skills`, () => {
      const { fields, body } = frontmatter(join(ROOT, 'agents', `${name}.md`));
      expect([fields.name, fields.model, fields.effort]).toEqual([name, want.model, want.effort]);
      expect(fields.skills).toBe('[follow-agent-rules]');
      expect(fields.permissionMode).toBeUndefined();
      expect((fields.description ?? '').length).toBeGreaterThan(40);
      const tools = toolList(fields.tools ?? '');
      for (const t of ['Read', 'Grep', 'Glob']) expect([name, t, tools.has(t)]).toEqual([name, t, true]);
      expect([name, 'Agent', tools.has('Agent')]).toEqual([name, 'Agent', want.agent]);
      expect([name, 'Write', tools.has('Write') && tools.has('Edit')]).toEqual([name, 'Write', want.write]);
      expect([name, 'Web', tools.has('WebSearch') && tools.has('WebFetch')]).toEqual([name, 'Web', want.web]);
      // Every tool skill the body names exists and is one the policy lets this agent use.
      const role = ROLES.find((r) => r.name === name)!;
      const named = Object.keys(TOOL_SKILLS).filter((s) => s !== 'follow-agent-rules' && new RegExp(`\\b${s}\\b`).test(body));
      for (const s of named) expect([name, s, role.toolSkills.includes(s)]).toEqual([name, s, true]);
      for (const s of role.toolSkills) expect([name, s, named.includes(s)]).toEqual([name, s, true]);
      expect([name, 'Skill', tools.has('Skill')]).toEqual([name, 'Skill', role.toolSkills.length > 0]);
      // Leads name their members; members name no agent to call.
      if (want.agent) for (const m of role.members ?? []) expect([name, m, body.includes(m)]).toEqual([name, m, true]);
    });
  }
});

describe('the 26 tool skills (23 from G2, keep-project-knowledge from H2, report-goodboy from J1, cli-update-check from K1d)', () => {
  for (const [name, effort] of Object.entries(TOOL_SKILLS)) {
    test(`${name}: format`, () => {
      const path = join(ROOT, 'skills', name, 'SKILL.md');
      expect(existsSync(path)).toBe(true);
      const { fields, body, lines } = frontmatter(path);
      expect(fields.name).toBe(name);
      expect(fields['user-invocable']).toBe(USER_INVOCABLE_TOOL_SKILLS.has(name) ? 'true' : 'false');
      expect<string | null>(fields.effort ?? null).toEqual(effort);
      expect((fields.description ?? '').length).toBeGreaterThan(30);
      expect(fields.when_to_use ?? '').toMatch(/^Use|^Preloaded/);
      expect([name, lines >= 30 && lines <= 90]).toEqual([name, true]);
      const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(headings).toEqual(['Inputs', 'Steps', 'Output', 'Done when', 'Never']);
      expect(body.startsWith(`\n# ${name}\n`)).toBe(true);
      // Members never delegate; tool skills are English (quoted product words aside).
      expect(body).not.toMatch(/\bAgent\(/);
      const hangul = body.match(/[가-힣]+/g) ?? [];
      // Allowed: the rationale heading, the "확인 필요" option, and AskUserQuestion labels.
      expect(hangul.filter((w) => !['근거', '확인', '필요', '프로젝트', '아님'].includes(w))).toEqual([]);
    });
  }
});

describe('the renames are complete', () => {
  test('no hook, library, agent or skill names the pre-G2 agents, except the legacy table', () => {
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) scan(p);
        else if (/\.(ts|md|json|sh)$/.test(e.name)) {
          readFileSync(join(ROOT, p), 'utf8')
            .split('\n')
            .forEach((line, i) => {
              // Allowed: the legacy table, "was …" notes and history comments of live probes.
              if (/\b(?:review|test)-changes\b/.test(line) && !/LEGACY_AGENTS|was (?:review|test)-changes|구 (?:review|test)-changes|라이브 검증/i.test(line)) offenders.push(`${p}:${i + 1}`);
            });
        }
      }
    };
    for (const d of ['hooks', 'lib', 'agents', 'skills']) scan(d);
    expect(offenders).toEqual([]);
  });
});
