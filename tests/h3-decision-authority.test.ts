// H3 decision authority (track H §14.4): the generic ai/human defaults, the project's policy
// entries merged in (unsure is human), the SessionStart context, the `cli.ts decisions` list
// the reviews read, and the skills that use it. The expected human categories are an
// independent fixture taken from the plan, not the defaults table. Repos are temporary.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_DECISIONS, decisionAuthorityContext, decisionItems, policyDecisions } from '../lib/decision-authority';
import { parsePolicyEntries } from '../lib/project-knowledge';

const ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'goodboy-h3-')));
  dirs.push(d);
  return d;
}
function sid(): string {
  const s = `h3${Math.random().toString(36).slice(2, 10)}`;
  dirs.push(join(tmpdir(), `goodboy-session-${s}`));
  return s;
}

const entry = (id: string, title: string, lines: string[]) => [`## ${id} ${title}`, ...lines, 'The rule.', ''].join('\n');
const DATES = ['- source: user 2026-10-15', '- date: 2026-10-15', '- checked: 2026-10-15'];
const POLICY = [
  '# Policy',
  '',
  entry('P1', 'Tests before push', ['- decide: ai', ...DATES, '- evidence: bun test']),
  entry('P2', 'Copy for the pricing page', ['- decide: human', ...DATES]),
  entry('P3', 'ai without evidence', ['- decide: ai', ...DATES]),
  entry('P4', 'Unknown tag', ['- decide: maybe', ...DATES]),
  entry('P5', 'No tag', DATES),
].join('\n');

function project(policy = POLICY): string {
  const d = tmp();
  mkdirSync(join(d, '.git'));
  mkdirSync(join(d, '.goodboy'));
  writeFileSync(join(d, '.goodboy', 'policy.md'), policy);
  return d;
}

/** Plan §14.4 / the track H request: what the user decides. */
const HUMAN_CATEGORIES: [string, RegExp][] = [
  ['requirement interpretation', /requirement/i],
  ['scope changes', /scope/i],
  ['UX choices', /\bUX\b/],
  ['live or outward systems', /live|outward/i],
  ['irreversible deletes', /irreversible|delete/i],
  ['security or cost trade-offs', /security|cost/i],
  ['policy exceptions', /exception/i],
  ['wording and tone', /wording|tone/i],
  ['ai checks that ended BLOCKED', /blocked/i],
];

describe('the defaults', () => {
  test('every human category of the plan is a human default', () => {
    const human = DEFAULT_DECISIONS.filter((d) => d.decide === 'human').map((d) => d.title);
    for (const [name, re] of HUMAN_CATEGORIES) expect([name, human.some((t) => re.test(t))]).toEqual([name, true]);
  });

  test('every ai default names its evidence and the hook that checks it; ids are unique', () => {
    for (const d of DEFAULT_DECISIONS.filter((x) => x.decide === 'ai')) {
      expect([d.id, (d.evidence ?? '').length > 5, (d.enforcedBy ?? '').length > 3]).toEqual([d.id, true, true]);
    }
    const ids = DEFAULT_DECISIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_DECISIONS.every((d) => d.origin === 'goodboy')).toBe(true);
  });

  test('the hook-held human checks are the existing ones: live systems (R2, hosts) and risky work', () => {
    const held = DEFAULT_DECISIONS.filter((d) => d.decide === 'human' && d.enforcedBy).map((d) => d.enforcedBy!.toLowerCase());
    expect(held.some((e) => e.includes('outward') && e.includes('hosts'))).toBe(true);
    expect(held.some((e) => e.includes('risk gate'))).toBe(true);
  });
});

describe('the project entries', () => {
  test('ai only with evidence; anything unsure is human', () => {
    const got = policyDecisions(POLICY).map((d) => [d.id, d.decide, d.evidence ?? null, d.origin]);
    expect(got).toEqual([
      ['P1', 'ai', 'bun test', 'policy'],
      ['P2', 'human', null, 'policy'],
      ['P3', 'human', null, 'policy'],
      ['P4', 'human', null, 'policy'],
      ['P5', 'human', null, 'policy'],
    ]);
  });

  test('the shared parser: id, title, fields; an empty value is no field', () => {
    const [e] = parsePolicyEntries('intro\n## X9 A title here\n- decide: ai\n- source:\n- evidence:  grep -q x f \n### not an entry\n');
    expect(e).toEqual({ heading: 'X9 A title here', id: 'X9', title: 'A title here', fields: { decide: 'ai', evidence: 'grep -q x f' } });
    const [crlf] = parsePolicyEntries('## C1 Windows\r\n- decide: ai\r\n- evidence: make check\r\n');
    expect(crlf).toEqual({ heading: 'C1 Windows', id: 'C1', title: 'Windows', fields: { decide: 'ai', evidence: 'make check' } });
    // A lone CR ends a line too, and a value may hold U+2028 (LINE SEPARATOR), which `.` misses.
    const LS = String.fromCharCode(0x2028);
    const [cr] = parsePolicyEntries(`## M1 Old Mac\r- decide: ai\r- evidence: make${LS}check\r`);
    expect(cr).toEqual({ heading: 'M1 Old Mac', id: 'M1', title: 'Old Mac', fields: { decide: 'ai', evidence: `make${LS}check` } });
  });

  test('the first line of a key wins, so a later line cannot turn a human entry into ai', () => {
    const text = entry('D1', 'Dup', ['- decide: human', ...DATES, '- decide: ai', '- evidence: bun test']);
    const [e] = parsePolicyEntries(text);
    expect(e!.fields.decide).toBe('human'); // the same line the done check read before the refactor
    expect(policyDecisions(text).map((d) => [d.id, d.decide])).toEqual([['D1', 'human']]);
  });

  test('decisionItems: the defaults, then the project entries from the knowledge root', () => {
    const d = project();
    mkdirSync(join(d, 'pkg'));
    const items = decisionItems(join(d, 'pkg'));
    expect(items.slice(0, DEFAULT_DECISIONS.length)).toEqual([...DEFAULT_DECISIONS]);
    expect(items.slice(DEFAULT_DECISIONS.length).map((i) => i.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    const bare = tmp();
    expect(decisionItems(bare)).toEqual([...DEFAULT_DECISIONS]);
  });

  test('a policy that cannot be read leaves the defaults', () => {
    const dirPolicy = tmp();
    mkdirSync(join(dirPolicy, '.goodboy', 'policy.md'), { recursive: true });
    expect(decisionItems(dirPolicy)).toEqual([...DEFAULT_DECISIONS]);
    const big = project(POLICY + 'x'.repeat(256 * 1024));
    expect(decisionItems(big)).toEqual([...DEFAULT_DECISIONS]);
  });
});

describe('delivery', () => {
  test('the SessionStart context: both classes, how to stop, the project human entries, the CLI', () => {
    const d = project();
    const ctx = decisionAuthorityContext(d, sid())!;
    expect(ctx).toContain('ai');
    expect(ctx).toMatch(/status: blocked/);
    expect(ctx).toMatch(/AskUserQuestion/);
    expect(ctx).toMatch(/Korean/);
    expect(ctx).toMatch(/When unsure, it is human/);
    for (const t of DEFAULT_DECISIONS.filter((x) => x.decide === 'human').map((x) => x.title)) expect(ctx).toContain(t);
    expect(ctx).toContain('P2 Copy for the pricing page');
    expect(ctx).toContain('P3 ai without evidence'); // no evidence: human
    expect(ctx).not.toContain('P1 Tests before push');
    expect(ctx).toContain(`bun "${ROOT}/lib/cli.ts" decisions`);
    expect(ctx.split('\n').length).toBeLessThanOrEqual(12);
  });

  test('many human entries are capped in the context, never dropped from the CLI list', () => {
    const many = ['# Policy', ''].concat(Array.from({ length: 30 }, (_, i) => entry(`H${i}`, `Item ${i}`, ['- decide: human', ...DATES]))).join('\n');
    const d = project(many);
    const ctx = decisionAuthorityContext(d, sid())!;
    expect(ctx).toContain('H11 Item 11');
    expect(ctx).not.toContain('H12 Item 12');
    expect(ctx).toContain('18 more');
    const long = project(['# Policy', '', entry('L1', 'y'.repeat(5000), ['- decide: human', ...DATES])].join('\n'));
    expect(decisionAuthorityContext(long, sid())!.length).toBeLessThan(3000);
    // An emoji across the cut stays whole: no lone surrogate in the context.
    const smile = String.fromCodePoint(0x1f600);
    const emoji = project(['# Policy', '', entry('E1', `${'z'.repeat(95)}${smile.repeat(5)}`, ['- decide: human', ...DATES])].join('\n'));
    const loneHigh = new RegExp('[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])');
    expect(loneHigh.test(decisionAuthorityContext(emoji, sid())!)).toBe(false);
    expect(decisionItems(d).filter((i) => i.origin === 'policy')).toHaveLength(30);
  });

  test('a non-project directory gets no context; a project without a policy gets the defaults', () => {
    const d = project();
    writeFileSync(join(d, 'CLAUDE.md'), 'goodboy: non-project\n');
    expect(decisionAuthorityContext(d, sid())).toBeNull();
    const bare = tmp();
    mkdirSync(join(bare, '.git'));
    const ctx = decisionAuthorityContext(bare, sid())!;
    expect(ctx).toContain(DEFAULT_DECISIONS.find((x) => x.decide === 'human')!.title);
    expect(ctx).not.toContain('This project');
  });

  test('cli.ts decisions prints every item as JSON', () => {
    const d = project();
    const r = Bun.spawnSync(['bun', join(ROOT, 'lib', 'cli.ts'), 'decisions'], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString()) as { root: string; items: { id: string; decide: string }[] };
    expect(out.root).toBe(d);
    expect(out.items).toHaveLength(DEFAULT_DECISIONS.length + 5);
    expect(out.items.find((i) => i.id === 'P3')!.decide).toBe('human');
  });

  test('the SessionStart hook sends it, with the read gate off too', async () => {
    const d = project();
    const run = async (env: Record<string, string>) => {
      const p = Bun.spawn(['bun', join(ROOT, 'hooks', 'session-start.ts')], {
        cwd: d,
        stdin: new TextEncoder().encode(JSON.stringify({ cwd: d, session_id: sid(), source: 'compact' })),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...env },
      });
      const out = await new Response(p.stdout).text();
      await p.exited;
      return (JSON.parse(out || '{}') as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? '';
    };
    const on = await run({});
    expect(on).toMatch(/Decision authority/);
    expect(on).toMatch(/policy read gate/);
    const off = await run({ GOODBOY_POLICY_GATE: 'off' });
    expect(off).toMatch(/Decision authority/);
    expect(off).not.toMatch(/policy read gate/);
  }, 20_000);

  test('the reviews and the agent rules read the list', () => {
    for (const s of ['check-evidence', 'check-spec-coverage', 'follow-agent-rules']) {
      const body = readFileSync(join(ROOT, 'skills', s, 'SKILL.md'), 'utf8');
      expect([s, body.includes('cli.ts" decisions')]).toEqual([s, true]);
    }
  });
});
