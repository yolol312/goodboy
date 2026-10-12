// Stabilization plan A1: CI runs the suite and the typecheck on push and pull request,
// on both supported platforms. Guards the workflow file against silent edits (a dropped
// platform or step would otherwise go unnoticed until a broken commit ships).

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW = resolve(import.meta.dir, '..', '.github', 'workflows', 'ci.yml');

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on?: { push?: { branches?: string[] }; pull_request?: unknown };
  jobs?: Record<string, { strategy?: { matrix?: { os?: string[] } }; 'runs-on'?: string; steps?: Step[] }>;
}

function load(): Workflow {
  return Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
}

describe('CI workflow (A1)', () => {
  test('exists and runs on push to main and on pull requests', () => {
    expect(existsSync(WORKFLOW)).toBe(true);
    const wf = load();
    expect(wf.on?.push?.branches).toContain('main');
    expect(wf.on !== undefined && 'pull_request' in wf.on).toBe(true);
  });

  test('runs on ubuntu-latest and macos-latest', () => {
    const job = Object.values(load().jobs ?? {})[0];
    expect(job?.strategy?.matrix?.os).toEqual(expect.arrayContaining(['ubuntu-latest', 'macos-latest']));
    expect(job?.['runs-on']).toBe('${{ matrix.os }}');
  });

  test('installs from the lockfile, then typechecks and runs the suite', () => {
    const steps = Object.values(load().jobs ?? {})[0]?.steps ?? [];
    const runs = steps.map((s) => s.run).filter((r): r is string => typeof r === 'string');
    expect(runs).toEqual(['bun install --frozen-lockfile', 'bun run typecheck', 'bun test']);
    expect(steps.some((s) => (s.uses ?? '').startsWith('actions/checkout@'))).toBe(true);
    expect(steps.some((s) => (s.uses ?? '').startsWith('oven-sh/setup-bun@'))).toBe(true);
  });

  test('pins the Bun version that package scripts are tested with', () => {
    const setup = (Object.values(load().jobs ?? {})[0]?.steps ?? []).find((s) =>
      (s.uses ?? '').startsWith('oven-sh/setup-bun@'),
    );
    expect(String(setup?.with?.['bun-version'] ?? '')).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
