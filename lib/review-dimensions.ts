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
  | 'performance';

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
 * 일반 코드 파일(예: util.ts)은 performance만 요구한다 — 입력 파싱/서버/프론트엔드
 * 신호가 없으면 보안/접근성 차원을 강제하지 않는다(오탐 최소화).
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
    }
  }

  return Array.from(required).sort();
}
