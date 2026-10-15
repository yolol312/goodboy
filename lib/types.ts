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

// ---- 층1 테스트 게이트 ----

/** 테스트를 실행한 환경. container = 컨테이너로 서버/의존 프로세스를 띄운 경우. */
export type TestEnvMode = 'container' | 'local' | 'none';

/** 실행 증거 — 실제로 돌린 명령과 관찰된 출력. 주장만으로는 인정하지 않는다. */
export interface TestEvidence {
  command: string;
  output: string;
  exit_code?: number;
}

/**
 * 수용 기준 1건에 대한 커버리지.
 *
 * red/green을 둘 다 요구하는 이유: 통과 사실만으로는 "아무것도 검증하지 않는 테스트"를
 * 배제할 수 없다. 구현을 되돌린 상태(또는 프로토타입 `수정 전`)에서 **실패하는 것을 먼저
 * 보여야** 그 테스트가 실제로 무언가를 붙잡고 있다는 증거가 된다.
 */
export interface AcceptanceCoverage {
  /** 수용 기준 ID (lib/acceptance.ts가 산출한 것과 일치해야 한다) */
  id: string;
  description: string;
  /** 이 기준을 커버하는 테스트 파일 또는 테스트 이름 */
  test: string;
  /** 기능이 없는/되돌린 상태에서 실패함을 보인 실행 (exit_code 0이면 거부된다) */
  red: TestEvidence;
  /** 현재 통과함을 보인 실행 */
  green: TestEvidence;
  /** 뮤테이션 프로브 — 검증 대상을 훼손했을 때 테스트가 실패했는가(detected=true여야 유효) */
  mutation?: { command: string; output: string; detected: boolean };
}

export interface TestSuiteRun {
  name: string;
  command: string;
  passed: number;
  failed: number;
  output: string;
}

export interface PrototypeMismatch {
  /** 대조가 어긋난 위치(셀렉터/화면명). 없으면 전역 차이 */
  selector?: string;
  issue: string;
  severity: Severity;
}

export interface TestResult {
  timestamp: string;
  /** 이번 테스트가 커버하는 변경 파일(절대경로) */
  tested_files: string[];
  category: string;
  /** repo에 남는 테스트 파일 경로. 리뷰 프로브와 달리 영속 자산이어야 한다. */
  test_files: string[];
  environment: {
    mode: TestEnvMode;
    /** 환경을 띄운 명령 (예: docker compose up -d) */
    command?: string;
    services?: string[];
    /** 기동 확인 증거(헬스체크 출력 등) */
    evidence?: string;
  };
  suites: TestSuiteRun[];
  acceptance: AcceptanceCoverage[];
  /** 프로토타입 대조 결과 (dev-cycle 산출물이 있을 때만) */
  prototype_diff?: {
    prototype_path: string;
    mismatches: PrototypeMismatch[];
  };
  verdict: TestVerdict;
  /** With verdict `blocked`: why the tests could not run, shown by commands and their output
   *  (no runner, no environment). Track G: the Stop test gate accepts it with a notice; a
   *  push never passes on it. */
  blocked?: { reason: string; evidence: TestEvidence[] };
  /** Set by `cli.ts test-write`, never by the agent: HEAD and the working tree it tested as a
   *  git tree hash (lib/push-test.ts workTreeState). The push test check matches `tree`. */
  commit?: string | null;
  tree?: string | null;
}

/** A layer-1 test verdict: a review verdict, or `blocked` when the tests could not run. */
export type TestVerdict = Verdict | 'blocked';

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
