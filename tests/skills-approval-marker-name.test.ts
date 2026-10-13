// The approval markers carry a session tag (stabilization plan A3). Every document a model
// or a user follows must name the tagged marker, never the pre-A3 shared names: those
// unlock nothing now, so a user told to create one approves nothing and the task stalls.
// The F1 case of tests/a3-round2-regressions.test.ts reads skills/*/SKILL.md; this one
// reads every file under skills/, the repo's own .claude/skills/ and agents/.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const PRE_A3_NAMES = ['.goodboy-risk-approved.txt', '.goodboy-bash-write-approved.txt'];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('documents name the per-session approval marker (A3)', () => {
  test('no skill, repo skill or agent prompt names a pre-A3 marker', () => {
    const files = ['skills', join('.claude', 'skills'), 'agents'].flatMap((d) => filesUnder(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(8); // the walk found the documents
    const hits = files
      .filter((f) => PRE_A3_NAMES.some((n) => readFileSync(f, 'utf8').includes(n)))
      .map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
