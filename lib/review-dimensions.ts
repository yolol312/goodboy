// 변경 파일 → 필수 리뷰 차원 매핑.
//
// review-changes.md가 정의한 조건부 품질 차원을 "어떤 변경이 어떤 차원을 강제하는지"
// 기계가 판정할 수 있게 만든다. Stop hook이 이 매핑으로 리뷰의 dimensions_checked가
// 충분한지(누락된 필수 차원이 없는지) 검사한다.
//
// 판정은 best-effort: 파일 확장자/이름만 보고 결정한다(파일 내용을 읽지 않는다).
// 의도적으로 단순하게 유지한다 — 오탐(필요 없는 차원 요구)은 retry-cap escape로
// 영구 차단되지 않고, 미탐(필요한데 안 잡음)이 더 위험하므로 넓게 잡는다.

export type ReviewDimension =
  | 'ui-ux-accessibility'
  | 'plan-completeness'
  | 'web-hardening'
  | 'error-path'
  | 'proto-pollution'
  | 'performance'
  // 층2 재편으로 추가된 차원. 동작 검증이 층1(테스트 게이트)로 빠지면서,
  // 리뷰는 리팩토링·성능·보안에 집중한다.
  | 'refactoring-quality'
  | 'security-secrets'
  | 'security-injection'
  | 'security-authz'
  | 'dependency-risk';

/**
 * 리뷰 축 — 병렬 서브에이전트 1개가 담당하는 묶음.
 * 축마다 별도 에이전트가 자기 dimensions_checked를 채워 **부분 리뷰 JSON**을 쓰고,
 * Stop hook이 합집합으로 커버리지를 판정한다(validateReviewCoverage.effective).
 */
export type ReviewAxis = 'refactoring' | 'security' | 'performance' | 'ui' | 'hallucination';

/** 축이 담당하는 차원. hallucination 축은 차원이 아니라 환각/추론 4분류 검증을 맡아 비어 있다. */
export const AXIS_DIMENSIONS: Record<ReviewAxis, ReviewDimension[]> = {
  refactoring: ['refactoring-quality'],
  security: [
    'security-secrets',
    'security-injection',
    'security-authz',
    'dependency-risk',
    'web-hardening',
    'error-path',
    'proto-pollution',
  ],
  performance: ['performance'],
  ui: ['ui-ux-accessibility', 'plan-completeness'],
  hallucination: [],
};

/**
 * 이번 변경에서 실제로 띄워야 하는 리뷰 축.
 * hallucination 축은 변경 내용과 무관하게 **항상** 포함된다 — 환각/추론 검증은
 * 무엇을 고쳤든 매번 확인해야 하기 때문.
 */
export function axesFor(changedFiles: string[]): ReviewAxis[] {
  const dims = new Set<ReviewDimension>(requiredDimensionsFor(changedFiles));
  const axes: ReviewAxis[] = ['hallucination'];
  for (const axis of ['refactoring', 'security', 'performance', 'ui'] as ReviewAxis[]) {
    if (AXIS_DIMENSIONS[axis].some((d) => dims.has(d))) axes.push(axis);
  }
  return axes;
}

/** 프론트엔드/클라이언트 표면을 건드리는 파일.
 *  HTML/CSS/JSX/TSX/Vue/Svelte, 또는 클라이언트 JS(파일명에 client 포함). */
function isFrontendFile(lower: string): boolean {
  if (/\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte)$/.test(lower)) return true;
  // client-side JS: <name>.client.ts/js, /client/ 경로 등
  if (/(^|[\/.])client[\/.]/.test(lower)) return true;
  if (/\.client\.(t|j)sx?$/.test(lower)) return true;
  return false;
}

/** HTTP 서버/라우트/API 코드로 보이는 파일.
 *  파일명/경로 휴리스틱: server/route/router/app/api/handler/middleware/endpoint/http. */
function isServerFile(lower: string): boolean {
  if (!/\.(t|j)sx?$|\.(m|c)?js$/.test(lower)) return false;
  return /(^|[\/._-])(server|serve|route|router|app|api|handler|middleware|endpoint|http|controller)([\/._-]|s?\.)/.test(
    lower,
  );
}

/** 코드 파일 일반(스크립트). 데이터 경로/입력 파싱 휴리스틱에 사용. */
function isCodeFile(lower: string): boolean {
  return /\.(t|j)sx?$|\.(m|c)?js$|\.py$|\.go$|\.rb$|\.rs$|\.java$/.test(lower);
}

/** 외부 입력(쿠키/헤더/URL/쿼리/바디)을 파싱하거나 사용자 입력으로 객체를 키잉할 법한 파일.
 *  파일명 휴리스틱: parse/cookie/header/session/auth/request/query/url/json/serialize/input,
 *  그리고 사용자 입력 객체를 합치는 merge/assign/extend 유틸(프로토타입 오염 표면). */
function looksLikeInputParser(lower: string): boolean {
  return /(parse|cookie|header|session|auth|request|query|url|json|serialize|deserialize|decode|input|payload|body|merge|assign|extend)/.test(
    lower,
  );
}

/** 판정 범위를 마지막 두 경로 조각(부모 디렉터리 + 파일명)으로 좁힌다.
 *
 *  ⚠️ 전체 경로에 부분문자열 매칭을 하면 안 된다 — 상위 경로의 우연한 글자에 걸린다.
 *  실측: 이 플러그인 이름 `goodboy` 안의 `db` 때문에 `/tmp/goodboy-.../src/a.ts` 가
 *  security-injection 으로 오분류돼 리뷰 게이트가 오차단됐다. */
function pathScope(lower: string): string {
  const parts = lower.split(/[\\/]/).filter((s) => s !== '');
  return parts.slice(-2).join('/');
}

/** 토큰이 경로 구분자/구분기호로 둘러싸여 등장하는지(단어 경계 근사). */
function hasScopedToken(lower: string, tokens: string[]): boolean {
  const scope = pathScope(lower);
  const re = new RegExp(`(^|[\\/._-])(${tokens.join('|')})(s?)([\\/._-]|$)`);
  return re.test(scope);
}

/** SQL/셸/exec 등 인젝션 표면으로 보이는 파일. */
function looksLikeInjectionSurface(lower: string): boolean {
  return hasScopedToken(lower, [
    'sql',
    'query',
    'queries',
    'db',
    'database',
    'repo',
    'repository',
    'repositories',
    'exec',
    'spawn',
    'shell',
    'command',
    'migration',
  ]);
}

/** 인증/인가 표면으로 보이는 파일. */
function looksLikeAuthSurface(lower: string): boolean {
  return hasScopedToken(lower, [
    'auth',
    'login',
    'logout',
    'session',
    'token',
    'jwt',
    'permission',
    'role',
    'acl',
    'guard',
    'policy',
    'middleware',
  ]);
}

/** 의존성 매니페스트/락파일. 경로의 마지막 조각(파일명)으로만 판정한다. */
function isDependencyManifest(lower: string): boolean {
  const base = lower.split(/[\\/]/).pop() ?? '';
  return /^(package\.json|package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile(\.lock)?)$/.test(
    base,
  );
}

/** 시크릿이 섞여 들어가기 쉬운 설정/환경 파일. */
function isConfigLikeFile(lower: string): boolean {
  const base = lower.split(/[\\/]/).pop() ?? '';
  if (/^\.env(\..+)?$/.test(base)) return true;
  return /\.(ya?ml|toml|ini|conf|cfg|properties)$/.test(lower) || /dockerfile|docker-compose/.test(base);
}

/**
 * 변경된 파일 목록으로부터 리뷰가 반드시 평가해야 하는 차원 집합을 계산한다.
 *
 * 규칙(review-changes.md의 트리거와 1:1):
 *  - 프론트엔드(HTML/CSS/JSX/client-JS) → ui-ux-accessibility, plan-completeness
 *  - HTTP 서버/라우트/API 코드 → web-hardening, error-path, proto-pollution
 *    (서버는 외부 입력 파싱 + JSON 바디 키잉을 거의 항상 한다)
 *  - 외부 입력 파서로 보이는 파일(parse/cookie/header/json/…) → error-path, proto-pollution
 *  - 코드 파일 일반(non-trivial 데이터 경로 가능) → performance
 *
 * 층2 재편으로 추가된 규칙:
 *  - 코드 파일 일반 → refactoring-quality, security-secrets
 *    (리팩토링·시크릿은 변경의 종류를 가리지 않으므로 코드면 항상 본다)
 *  - 설정/환경 파일(.env, yaml, Dockerfile 등) → security-secrets
 *  - SQL/셸/exec 표면 → security-injection
 *  - 인증/인가 표면 → security-authz
 *  - 의존성 매니페스트/락파일 → dependency-risk
 *
 * best-effort: 파일명/확장자만으로 판정. 서버/프론트엔드/파서 신호는 넓게 잡는다(미탐 < 오탐).
 * @param changedFiles 변경된 파일 경로 배열(절대/상대 무관)
 * @returns 필수 차원 배열(중복 제거, 정렬)
 */
export function requiredDimensionsFor(changedFiles: string[]): ReviewDimension[] {
  const required = new Set<ReviewDimension>();
  if (!Array.isArray(changedFiles)) return [];

  for (const raw of changedFiles) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const lower = raw.toLowerCase();

    if (isFrontendFile(lower)) {
      required.add('ui-ux-accessibility');
      required.add('plan-completeness');
    }

    if (isServerFile(lower)) {
      required.add('web-hardening');
      required.add('error-path');
      // 서버는 외부 입력 파싱 + JSON 바디 키잉을 거의 항상 한다.
      required.add('proto-pollution');
    }

    if (looksLikeInputParser(lower) && isCodeFile(lower)) {
      // 외부 입력 파서 → 잘못된 인코딩/특수 키 프로빙 필요.
      required.add('error-path');
      required.add('proto-pollution');
    }

    if (isCodeFile(lower)) {
      // non-trivial 데이터 경로 가능 → performance 차원을 항상 후보로 둔다.
      required.add('performance');
      // 층2: 리팩토링과 시크릿은 변경의 종류를 가리지 않는다 — 코드면 항상 본다.
      required.add('refactoring-quality');
      required.add('security-secrets');
    }

    if (isConfigLikeFile(lower)) {
      required.add('security-secrets');
    }

    if (isCodeFile(lower) && looksLikeInjectionSurface(lower)) {
      required.add('security-injection');
    }

    if (isCodeFile(lower) && looksLikeAuthSurface(lower)) {
      required.add('security-authz');
    }

    if (isDependencyManifest(lower)) {
      required.add('dependency-risk');
    }
  }

  return Array.from(required).sort();
}
