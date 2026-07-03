// 공통 타입 정의 — goodboy 전체에서 import

export type RiskLevel = 'simple' | 'medium' | 'risky';
export type Severity = 'high' | 'medium' | 'low';
export type Verdict = 'pass' | 'needs-changes' | 'fail';

export interface ReasoningSection {
  facts: string[];
  inferences: string[];
  assumptions: string[];
  speculations: string[];
}

export interface RequiredInput {
  name: string;
  question: string;
  allow_unknown: boolean;
  value?: string;
}

export interface ReviewFinding {
  file: string;
  line?: number;
  issue: string;
  severity: Severity;
  /** 프로브 증거(실행한 명령 + 관찰된 출력). high/medium finding은 review-write에서 필수.
   *  구버전 리뷰(필드 없음) 읽기는 계속 허용 — 새 write에서만 강제. */
  probe?: string;
}

export interface ReviewResult {
  timestamp: string;
  reviewed_files: string[];
  category: string;
  findings: ReviewFinding[];
  unknown_assumptions_checked: Array<{ assumption: string; reasonable: boolean; note?: string }>;
  verdict: Verdict;
  /** 이번 리뷰가 평가한 품질 차원 목록 (예: "ui-ux-accessibility", "web-hardening").
   *  생략 시 []로 취급 — 구버전 리뷰 읽기는 계속 허용, Stop hook이 커버리지 검사에 사용. */
  dimensions_checked?: string[];
}

export interface HookEvent {
  type: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface HookInputCommon {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
}
