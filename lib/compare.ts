// Update checkups (track K, K1 #10, plan §17), step K1d: problems that already existed, kept
// apart from update regressions. A run's problems (health, smoke, inventory, agent findings,
// integration probes) are compared with the last completed run's, check by check:
//   - new: this run has it, and the last run ran the same check without it (an update
//     regression candidate);
//   - persisting: both runs have it (it was there before this update);
//   - resolved: the last run had it, and this run ran the same check without it;
//   - baseline: the last run did not run that check (the first check, a step that failed, or
//     probes it skipped), so new and old cannot be told apart;
//   - unchecked: the last run had it, and this run did not run that check.

import { readRunFile } from './checkup';

export type Source = 'health' | 'smoke' | 'inventory' | 'agents' | 'probes';

export interface Issue {
  /** The same across runs for the same problem: the source, the kind and subject, and the
   *  message with only what changes between runs dropped (versions, durations, hashes,
   *  times). Other numbers stay: claude-opus-4-1 and claude-opus-4-5 are two models. */
  key: string;
  source: Source;
  /** The check that finds it: a problem is resolved only when that check ran again. */
  check: string;
  text: string;
}

export interface Comparison {
  run: string;
  previous: string | null;
  /** The result files each run has. */
  sources: { current: Source[]; previous: Source[] };
  new: Issue[];
  persisting: Issue[];
  resolved: Issue[];
  baseline: Issue[];
  unchecked: Issue[];
  /** Run files that could not be read, and lists that were cut. */
  problems: string[];
}

/** The run files a comparison reads, and the sources each one gives. */
export const COMPARED_FILES: Record<string, Source[]> = {
  'health.json': ['health'],
  'smoke-results.json': ['smoke'],
  'inventory.json': ['inventory', 'agents'],
  'probes.json': ['probes'],
};

const MAX_ISSUES = 500;

/** What changes between runs of the same problem. */
const volatile = (s: string): string =>
  s
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z?\b/g, '#time')
    .replace(/\bv?\d+(?:\.\d+){2,}(?:[-+][\w.]+)?\b/g, '#version')
    .replace(/\b[0-9a-f]{12,}\b/gi, '#hash')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds?|minutes?)\b/g, '#duration')
    .replace(/\$\d+(?:\.\d+)?/g, '$#');
const part = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): any => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The health check a problem comes from (K1c's steps; validate per plugin). */
function healthCheck(kind: string, subject: string): string {
  if (kind === 'list-error') return 'health:plugin list';
  if (kind === 'validate-error' || kind === 'validate-warning') return `health:validate ${subject}`;
  if (kind === 'not-loaded') return 'health:startup log';
  if (kind === 'skill-doctor-cost') return 'health:skill-doctor';
  if (kind === 'doctor-warning') return 'health:doctor';
  if (kind === 'step-failed') {
    const v = /^plugin validate (.+)$/.exec(subject);
    if (v) return `health:validate ${v[1]}`;
    if (['plugin list', 'skill-doctor', 'startup log', 'doctor'].includes(subject)) return `health:${subject}`;
  }
  return 'health:file';
}

/** The problems in one run file's parsed JSON, the checks that ran in it, and the sources
 *  whose lists were cut (to the run-file cap, or a debug log read in part): a problem missing
 *  from a cut list may still be there. The files come from goodboy's own steps, maybe of an
 *  older version, so every field is checked. */
export function issuesOf(name: string, j: unknown): { issues: Issue[]; covered: string[]; cut: Source[] } {
  const issues: Issue[] = [];
  const covered: string[] = [];
  const cut: Source[] = [];
  // A failed step or session is keyed without its message: failing again differently is the
  //   same problem.
  const add = (source: Source, check: string, parts: string[], text: string) =>
    issues.push({ key: [source, ...parts.map((p, i) => (i === parts.length - 1 ? part(volatile(p)) : part(p)))].join('|'), source, check, text: text.slice(0, 500) });
  const root = obj(j);
  if (name === 'health.json') {
    const failed = new Set(list(root.problems).map(obj).filter((p) => p.kind === 'step-failed' && !/^only the first/.test(str(p.message))).map((p) => healthCheck('step-failed', str(p.subject))));
    covered.push('health:file');
    for (const c of ['health:plugin list', 'health:skill-doctor', 'health:doctor']) if (!failed.has(c)) covered.push(c);
    if (obj(root.startupLog).read === true) covered.push('health:startup log');
    for (const p of list(root.plugins).map(obj)) {
      const v = obj(p.validate);
      if (typeof p.id === 'string' && !('skipped' in v) && !failed.has(`health:validate ${p.id}`)) covered.push(`health:validate ${p.id}`);
    }
    for (const p of list(root.problems).map(obj)) {
      const [kind, subject, message] = [str(p.kind), str(p.subject), str(p.message)];
      if (kind === 'step-failed' && subject === 'health.json') cut.push('health');
      add('health', healthCheck(kind, subject), kind === 'step-failed' ? [kind, subject] : [kind, subject, message], `${kind} ${subject}: ${message}`);
    }
  } else if (name === 'smoke-results.json') {
    covered.push('smoke:cases');
    for (const r of list(root.results).map(obj)) {
      const check = `smoke:${str(r.source)}:${str(r.name)}`;
      covered.push(check);
      if (r.ok !== false) continue;
      const last = obj(list(r.steps).at(-1));
      add('smoke', check, [str(r.source), str(r.name), str(last.what)], `${str(r.name)}: ${str(last.what)}${last.why ? `: ${str(last.why)}` : ''}`);
    }
    for (const p of list(root.problems)) add('smoke', 'smoke:cases', ['case-problem', str(p)], str(p));
  } else if (name === 'inventory.json') {
    covered.push('inventory', 'agents');
    // fitInventory's notes, and the problems cap's.
    if (list(root.problems).some((p) => /^inventory\.json holds the first .*\(size cap\)$|^more problems were left out/.test(str(p)))) cut.push('inventory', 'agents');
    for (const p of list(root.problems)) add('inventory', 'inventory', [str(p)], str(p));
    for (const f of list(root.agent_findings).map(obj)) {
      const agents = list(f.agents).map(str).join(', ');
      add('agents', 'agents', [str(f.check), agents, str(f.detail)], `${str(f.check)} ${agents}: ${str(f.detail)}`);
    }
  } else if (name === 'probes.json') {
    const findings = list(root.findings).map(obj);
    // A probe ran when it has a result and did not fail or get skipped.
    const down = new Set(findings.filter((f) => f.kind === 'session-failed' || f.kind === 'skipped').map((f) => str(f.probe)));
    for (const r of list(root.results).map(obj)) if (typeof r.name === 'string' && !down.has(r.name)) covered.push(`probes:${r.name}`);
    // fitProbes' note, or a debug log read in part.
    if (findings.some((f) => str(f.subject) === 'probes.json' || /^the debug log is over/.test(str(f.message)))) cut.push('probes');
    for (const f of findings) {
      if (f.severity !== 'problem') continue;
      const [probe, kind, subject, message] = [str(f.probe), str(f.kind), str(f.subject), str(f.message)];
      add('probes', `probes:${probe}`, kind === 'session-failed' ? [probe, kind, subject] : [probe, kind, subject, message], `${probe} ${kind} ${subject}: ${message}`);
    }
  }
  return { issues, covered, cut };
}

/** A run's problems, one per key, the checks that ran, the files it has, and the sources whose
 *  lists were cut. */
export function runIssues(dir: string, run: string): { issues: Map<string, Issue>; covered: Set<string>; cut: Set<Source>; sources: Source[]; problems: string[] } {
  const issues = new Map<string, Issue>();
  const covered = new Set<string>();
  const cut = new Set<Source>();
  const sources: Source[] = [];
  const problems: string[] = [];
  for (const [name, gives] of Object.entries(COMPARED_FILES)) {
    const text = readRunFile(dir, run, name);
    if (text === 'absent') continue;
    if (text === 'refused') {
      problems.push(`run ${run}: ${name} is not a readable regular file of up to the run-file cap`);
      continue;
    }
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      problems.push(`run ${run}: ${name} is not JSON`);
      continue;
    }
    sources.push(...gives);
    const got = issuesOf(name, j);
    for (const c of got.covered) covered.add(c);
    for (const s of got.cut) cut.add(s);
    for (const i of got.issues) if (!issues.has(i.key)) issues.set(i.key, i);
  }
  return { issues, covered, cut, sources, problems };
}

/** Compares `run` with `previous` (the last completed run), or with nothing on a first check. */
export function compareRuns(dir: string, run: string, previous: string | null): Comparison {
  const cur = runIssues(dir, run);
  const prev = previous ? runIssues(dir, previous) : { issues: new Map<string, Issue>(), covered: new Set<string>(), cut: new Set<Source>(), sources: [] as Source[], problems: [] as string[] };
  if (previous && prev.sources.length === 0 && prev.problems.length === 0) prev.problems.push(`run ${previous}: none of its result files is there to compare with`);
  const c: Comparison = { run, previous, sources: { current: cur.sources, previous: prev.sources }, new: [], persisting: [], resolved: [], baseline: [], unchecked: [], problems: [...cur.problems, ...prev.problems] };
  for (const [k, i] of cur.issues) {
    if (prev.issues.has(k)) c.persisting.push(i);
    else (prev.covered.has(i.check) ? c.new : c.baseline).push(i);
  }
  // Gone from a list this run cut is not resolved: it may only be past the cut (K1d review 2).
  for (const [k, i] of prev.issues) if (!cur.issues.has(k)) (cur.covered.has(i.check) && !cur.cut.has(i.source) ? c.resolved : c.unchecked).push(i);
  for (const b of ['new', 'persisting', 'resolved', 'baseline', 'unchecked'] as const) {
    if (c[b].length > MAX_ISSUES) {
      c.problems.push(`${b}: ${c[b].length - MAX_ISSUES} more were left out`);
      c[b] = c[b].slice(0, MAX_ISSUES);
    }
  }
  return c;
}

/** The lines the CLI prints; the whole comparison goes to the run dir. */
export function comparisonSummary(c: Comparison, max = 30): Record<string, unknown> {
  const texts = (l: Issue[]) => l.slice(0, max).map((i) => `[${i.source}] ${i.text.slice(0, 300)}`);
  return {
    run: c.run,
    previous: c.previous,
    sources: c.sources,
    counts: { new: c.new.length, persisting: c.persisting.length, resolved: c.resolved.length, baseline: c.baseline.length, unchecked: c.unchecked.length },
    new: texts(c.new),
    persisting: texts(c.persisting),
    resolved: texts(c.resolved),
    baseline: texts(c.baseline),
    unchecked: texts(c.unchecked),
    problems: c.problems.slice(0, 30),
  };
}
