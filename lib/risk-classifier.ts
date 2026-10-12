// 위험도 분류 룰

import type { RiskLevel } from './types';
import { OP_TOKEN, tokenizeSegments } from './bash-write';

export interface RiskClassifierInput {
  category: string;          // skill name
  fileCount: number;         // 변경 예정 파일 수 (모를 때 0)
  prompt: string;            // 사용자 프롬프트
  riskDefault: RiskLevel;    // skill frontmatter risk_default
  userOverride?: RiskLevel;  // --risk high 등
}

// Risky keywords (stabilization plan A4). Plain substring matching made "prod" match
// "product", "reproduce", and "producer", which locked whole sessions into the risky gate.
// ASCII keywords now match on word boundaries: "prod" on both ends (it is a prefix of
// common words); stems like "migrat" only at the start, so "migrations"/"migrated" still
// count. Korean keywords keep substring matching (JS \b is ASCII-only).
const RISKY_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'prod', re: /\bprod(uction)?\b/ },
  { label: '프로덕션', re: /프로덕션/ },
  { label: '운영', re: /운영/ },
  { label: 'drop table', re: /\bdrop\s+table/ },
  { label: 'delete from', re: /\bdelete\s+from/ },
  { label: 'rm -rf', re: /\brm\s+-rf/ },
  { label: '--force', re: /--force/ },
  { label: 'force push', re: /\bforce[- ]push/ },
  { label: 'migrate', re: /\bmigrat(e|ion)/ },
  { label: '마이그레이션', re: /마이그레이션/ },
];

/** Returns the label of the first risky keyword found in the prompt, or null. */
export function findRiskyKeyword(prompt: string): string | null {
  const lowered = (prompt ?? '').toLowerCase();
  for (const p of RISKY_PATTERNS) {
    if (p.re.test(lowered)) return p.label;
  }
  return null;
}

// Commands that only read state. In a risky session these pass the risk gate so the agent
// can still inspect the repo (`git status`, `ls`, …) while waiting for user approval.
// Deliberately narrow: anything that can run project code (npm run, make, psql, …) or
// write stays gated, because that is exactly what a risky task (e.g. a migration) does.
// Every entry must be unable to write a file or run a program under any option — the
// approval marker is a file, so a single writing option means self-approval (review of
// A4: `git diff --output=.claude/.goodboy-risk-approved.txt` did exactly that). That rules
// out find (-fprint), rg (--pre runs a program), tree (-o), file (-C); search commands are
// delegated to subagents anyway.
const READ_ONLY_COMMANDS = new Set(['cd', 'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'which', 'stat']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame']);
/** git options that write files or run external programs. */
function isUnsafeGitArg(t: string): boolean {
  return (
    t === '-o' ||
    t.startsWith('--output') ||
    t.startsWith('--ext-diff') ||
    t.startsWith('--textconv') ||
    t.startsWith('--open-files-in-pager') ||
    t.startsWith('--exec')
  );
}

// Shell expansion is code execution in disguise. Besides $(…) and backticks, the agent's
// shell may be zsh, where =(…) process substitution, glob qualifiers *(e:'…':) and ${x@P}
// all run programs (security review of A4: `cat =(touch <marker>)` self-approved). Listing
// forms one by one keeps leaking, so the exemption accepts plain words only: any expansion
// metacharacter — quoted or not — disqualifies the command. Only a `2>/dev/null` style
// redirect is tolerated (stripped before the check).
const EXPANSION_CHARS = /[$`(){}*?[\]!~\\<>^]/;
const DEV_NULL_REDIRECT = /(^|\s)[12]?>\s*\/dev\/null(?=$|[\s;&|])/g;

/** True when every segment of the command is an allowlisted read-only command made of
 *  plain words: no expansion metacharacters and no redirection other than to /dev/null. */
export function isReadOnlyBash(command: string): boolean {
  if (typeof command !== 'string' || command.trim() === '') return false;
  if (EXPANSION_CHARS.test(command.replace(DEV_NULL_REDIRECT, ' '))) return false;
  const segments = tokenizeSegments(command);
  if (segments.length === 0) return false;
  for (const seg of segments) {
    const cmd = seg[0] ?? '';
    if (!READ_ONLY_COMMANDS.has(cmd) && cmd !== 'git') return false;
    // seg[1] must be the subcommand itself: `git -c key=value …` can run programs.
    if (cmd === 'git' && (!READ_ONLY_GIT.has(seg[1] ?? '') || seg.some(isUnsafeGitArg))) return false;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] === OP_TOKEN && seg[i + 1] !== '/dev/null') return false;
    }
  }
  return true;
}

const LEVELS: RiskLevel[] = ['simple', 'medium', 'risky'];

function bumpUp(level: RiskLevel): RiskLevel {
  const idx = LEVELS.indexOf(level);
  if (idx === -1) return level;
  const next = LEVELS[Math.min(idx + 1, LEVELS.length - 1)];
  return next ?? level;
}

function isRiskLevel(v: unknown): v is RiskLevel {
  return v === 'simple' || v === 'medium' || v === 'risky';
}

/** 룰 기반 위험도 분류 */
export function classifyRisk(input: RiskClassifierInput): RiskLevel {
  return explainRisk(input).level;
}

/** classifyRisk plus why: 'override' | 'keyword:<label>' | 'default' | 'file-count' | 'none'.
 *  The risk gate's deny message names this cause, so it must come from the same rules. */
export function explainRisk(input: RiskClassifierInput): { level: RiskLevel; reason: string } {
  // 1. userOverride 우선
  if (input.userOverride && isRiskLevel(input.userOverride)) {
    return { level: input.userOverride, reason: 'override' };
  }

  // 2. riskDefault에서 시작
  let level: RiskLevel = isRiskLevel(input.riskDefault) ? input.riskDefault : 'medium';
  let reason = level === 'risky' ? 'default' : 'none';

  // 3. fileCount 가산: 3+ 파일이면 한 단계 상향
  if ((input.fileCount ?? 0) >= 3) {
    const bumped = bumpUp(level);
    if (bumped === 'risky' && level !== 'risky') reason = 'file-count';
    level = bumped;
  }

  // 4. 위험 키워드 검사 → risky로 고정
  const keyword = findRiskyKeyword(input.prompt);
  if (keyword !== null) return { level: 'risky', reason: `keyword:${keyword}` };

  return { level, reason };
}

/** 사용자 프롬프트에서 --risk simple|medium|risky override 감지. 없으면 undefined */
export function detectRiskOverride(prompt: string): RiskLevel | undefined {
  if (typeof prompt !== 'string' || prompt.length === 0) return undefined;
  // --risk=simple, --risk simple, --risk:simple 형태 지원
  const m = prompt.match(/--risk[=:\s]+(simple|medium|risky)\b/i);
  if (!m) return undefined;
  const val = (m[1] ?? '').toLowerCase();
  if (isRiskLevel(val)) return val;
  return undefined;
}
