// Decision authority (track H §14.4): every check is `ai` (evidence decides it: passed without
// asking, naming the evidence) or `human` (the user decides: the work on it stops until they
// do). Neither has a written-reason escape. goodboy ships the generic defaults below;
// `.goodboy/policy.md` adds the project's entries. Hooks hold the machine-checkable ones; the
// rest reach the model through the SessionStart context (decisionAuthorityContext) and the
// reviews, whose skills read `cli.ts decisions` (check-evidence, check-spec-coverage).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { knowledgeRoot, parsePolicyEntries, POLICY_FILE, KNOWLEDGE_SKILL } from './project-knowledge';
import { projectMode } from './project-mode';

export type Decide = 'ai' | 'human';

export interface DecisionItem {
  id: string;
  title: string;
  decide: Decide;
  /** ai: the command, test or file check that decides it. */
  evidence?: string;
  /** The goodboy rule that holds it, when one does. */
  enforcedBy?: string;
  origin: 'goodboy' | 'policy';
}

/** The generic checks. Human: the categories the user keeps (plan §14.4). Ai: the checks
 *  goodboy's hooks already decide on evidence. */
export const DEFAULT_DECISIONS: readonly DecisionItem[] = [
  { id: 'G-requirements', title: 'interpreting a requirement the request leaves open (dev-cycle asks at each stage)', decide: 'human', origin: 'goodboy' },
  { id: 'G-scope', title: 'changing the scope of the task', decide: 'human', origin: 'goodboy' },
  { id: 'G-ux', title: 'UX choices', decide: 'human', origin: 'goodboy' },
  { id: 'G-live', title: 'acting on a live or outward system (deploys, pushes, remote data, messages)', decide: 'human', enforcedBy: 'the outward-command gate denies a change to a host .goodboy/hosts lists as production (other hosts get the R2 advice)', origin: 'goodboy' },
  { id: 'G-delete', title: 'irreversible deletes and migrations', decide: 'human', enforcedBy: 'the risk gate holds a goodboy workflow command (/fix-bug, /prepare-migration …) whose prompt names rm -rf, --force or a migration until the user\'s approval marker', origin: 'goodboy' },
  { id: 'G-tradeoff', title: 'security or cost trade-offs', decide: 'human', origin: 'goodboy' },
  { id: 'G-exception', title: 'an exception to a policy entry or a goodboy rule', decide: 'human', origin: 'goodboy' },
  { id: 'G-wording', title: 'wording and tone of user-facing text', decide: 'human', origin: 'goodboy' },
  { id: 'G-blocked', title: 'an ai check that ended blocked (no evidence could decide it)', decide: 'human', origin: 'goodboy' },
  { id: 'G-knowledge', title: 'the project knowledge files are read', decide: 'ai', evidence: 'the read log', enforcedBy: 'policy read gate', origin: 'goodboy' },
  { id: 'G-read', title: 'a file is read before it is edited', decide: 'ai', evidence: 'the read log', enforcedBy: 'read-before-edit', origin: 'goodboy' },
  { id: 'G-claims', title: 'cited code exists', decide: 'ai', evidence: 'file:line citations against the files read', enforcedBy: 'claim check', origin: 'goodboy' },
  { id: 'G-types', title: 'types check', decide: 'ai', evidence: "the project's typecheck command after each edit", enforcedBy: 'auto-verify', origin: 'goodboy' },
  { id: 'G-tests', title: 'changed code is tested and passes', decide: 'ai', evidence: 'a test record covering the changed files', enforcedBy: 'test gate', origin: 'goodboy' },
  { id: 'G-review', title: 'changed files are reviewed', decide: 'ai', evidence: 'a review record covering them with no high finding', enforcedBy: 'review gate', origin: 'goodboy' },
  { id: 'G-issue', title: 'a commit names its issue', decide: 'ai', evidence: 'the commit message (a Jira key or #number)', enforcedBy: 'commit issue rule', origin: 'goodboy' },
];

/** The policy file's entries as checks. Unsure is human: an entry is `ai` only when tagged so
 *  and naming its evidence; any other tag, or none, leaves it to the user. */
export function policyDecisions(text: string): DecisionItem[] {
  return parsePolicyEntries(text).map((e) => {
    const evidence = e.fields.evidence;
    const decide: Decide = e.fields.decide?.split(/\s/)[0] === 'ai' && evidence ? 'ai' : 'human';
    return { id: e.id, title: e.title, decide, ...(decide === 'ai' ? { evidence } : {}), origin: 'policy' as const };
  });
}

const MAX_POLICY_BYTES = 256 * 1024;

/** The defaults, then the entries of the policy file the cwd's knowledge root has. */
export function decisionItems(cwd: string): DecisionItem[] {
  const { root, policyExists } = knowledgeRoot(cwd);
  const items = [...DEFAULT_DECISIONS];
  if (!policyExists) return items;
  try {
    const p = join(root, POLICY_FILE);
    if (existsSync(p) && statSync(p).size <= MAX_POLICY_BYTES) items.push(...policyDecisions(readFileSync(p, 'utf8')));
  } catch {
    // unreadable: the defaults still hold (the SessionStart notice warns about the file)
  }
  return items;
}

/** Project human entries named in the context; the rest are counted (the CLI lists all). */
const MAX_LISTED = 12;
/** …and each name is cut to this many characters, so the context stays small. */
const MAX_NAME = 100;
const CLI = resolvePath(import.meta.dir, 'cli.ts');

/** Cut by code point, so an emoji at the cut does not leave half a surrogate pair. */
function clip(s: string): string {
  const chars = Array.from(s);
  return chars.length > MAX_NAME ? `${chars.slice(0, MAX_NAME - 1).join('')}…` : s;
}

/** What SessionStart tells a project session, or null in a non-project directory. */
export function decisionAuthorityContext(cwd: string, sessionId: string): string | null {
  if (projectMode(cwd, sessionId) === 'non-project') return null;
  const items = decisionItems(cwd);
  const human = (origin: DecisionItem['origin']) => items.filter((i) => i.origin === origin && i.decide === 'human');
  const held = human('goodboy').filter((i) => i.enforcedBy);
  const lines = [
    'Decision authority (goodboy): every check is ai or human, and a written reason never moves one to the other.',
    '- ai: evidence decides it (a command, a test, a file check). Pass it on that evidence without asking, and name the evidence. An unlisted check that evidence can decide is ai.',
    '- human: the user decides, and the work on it stops until they do. The main session asks once per gate, batching the open items, in Korean (AskUserQuestion); a subagent returns `status: blocked` with the question. When unsure, it is human. An item the request, the user\'s answers or a policy entry already settles is not open.',
    `- human by default: ${human('goodboy').map((i) => i.title).join('; ')}. Hooks back some of them, only in part (asking stays your duty): ${held.map((i) => `${i.title.split(' (')[0]}: ${i.enforcedBy}`).join('; ')}.`,
    `- ai by default, decided by goodboy's hooks: ${DEFAULT_DECISIONS.filter((i) => i.decide === 'ai').map((i) => i.title).join('; ')}.`,
  ];
  const projectHuman = human('policy');
  const projectAi = items.filter((i) => i.origin === 'policy' && i.decide === 'ai');
  if (projectHuman.length + projectAi.length > 0) {
    const named = projectHuman.slice(0, MAX_LISTED).map((i) => clip(`${i.id} ${i.title}`.trim()));
    const more = projectHuman.length > MAX_LISTED ? ` and ${projectHuman.length - MAX_LISTED} more` : '';
    lines.push(
      `- This project (${POLICY_FILE}): ${projectAi.length} ai, ${projectHuman.length} human${projectHuman.length > 0 ? `: ${named.join('; ')}${more}` : ''}.`,
    );
  }
  lines.push(
    `- \`bun "${CLI}" decisions\` lists every check. A decision the user makes becomes a policy entry (${KNOWLEDGE_SKILL} update mode), an ai check next time. (decision authority)`,
  );
  return lines.join('\n');
}
