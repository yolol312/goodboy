// 위험도 분류 룰

import type { RiskLevel } from './types';

export interface RiskClassifierInput {
  category: string;          // skill name
  fileCount: number;         // 변경 예정 파일 수 (모를 때 0)
  prompt: string;            // 사용자 프롬프트
  riskDefault: RiskLevel;    // skill frontmatter risk_default
  userOverride?: RiskLevel;  // --risk high 등
}

const RISKY_KEYWORDS = [
  'production', 'prod', '프로덕션', '운영',
  'drop table', 'delete from', 'rm -rf',
  '--force', 'force-push', 'force push',
  'migrate', 'migration', '마이그레이션',
];

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
  // 1. userOverride 우선
  if (input.userOverride && isRiskLevel(input.userOverride)) {
    return input.userOverride;
  }

  // 2. riskDefault에서 시작
  let level: RiskLevel = isRiskLevel(input.riskDefault) ? input.riskDefault : 'medium';

  // 3. fileCount 가산: 3+ 파일이면 한 단계 상향
  if ((input.fileCount ?? 0) >= 3) {
    level = bumpUp(level);
  }

  // 4. 위험 키워드 검사 → risky로 고정
  const lowered = (input.prompt ?? '').toLowerCase();
  for (const kw of RISKY_KEYWORDS) {
    if (lowered.includes(kw)) {
      level = 'risky';
      break;
    }
  }

  return level;
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
