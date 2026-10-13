// ## 근거(구 ## 추론) 섹션 파싱 (사실/판단/가정/추측 4분류)

import type { ReasoningSection } from './types';

// '## 근거'가 현행 헤딩, and '## Rationale' is its English form (stabilization plan F3: English
//   subagent replies). '## 추론'/'## Reasoning'은 하위 호환으로 계속 인정한다. Guidance text
//   never suggests "Reasoning" (server safeguard false positive, v0.29.0).
const HEADING_REGEX = /^##\s+(근거|Rationale|추론|Reasoning)\s*$/i;
const SUBHEADING_REGEX = /^###\s+(.+?)\s*$/;

interface Bucket {
  facts: string[];
  inferences: string[];
  assumptions: string[];
  speculations: string[];
}

function emptyBucket(): Bucket {
  return { facts: [], inferences: [], assumptions: [], speculations: [] };
}

/** 서브헤딩 라벨을 4분류 키로 매핑. 한국어/영어 모두 지원. */
function mapSubheading(label: string): keyof Bucket | null {
  // 꼬리 장식 제거: 게이트 안내문이 "### 추측 ⚠️"처럼 이모지를 붙이도록 지시하므로,
  //   라벨 비교 전 후행 비문자/비숫자(이모지·공백·기호)를 잘라 정확 매칭이 깨지지 않게 한다.
  // Only the first word is the label. The skills' own template writes "### 사실 (검증됨)"
  //   and "### 추측 ⚠️ (근거 약함)"; with the description kept, no label matched, every
  //   bucket came out empty, and the assumption-review link at Stop never fired.
  const first = label.trim().split(/[\s(（:：—]/u)[0] ?? '';
  const l = first.toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '').trim();
  if (l === '사실' || l === 'facts' || l === 'fact') return 'facts';
  if (
    l === '판단' ||
    l === '추론' ||
    l === 'judgments' ||
    l === 'judgment' ||
    l === 'judgements' ||
    l === 'judgement' ||
    l === 'inferences' ||
    l === 'inference'
  ) {
    return 'inferences';
  }
  if (l === '가정' || l === 'assumptions' || l === 'assumption') return 'assumptions';
  if (l === '추측' || l === 'speculations' || l === 'speculation') return 'speculations';
  return null;
}

/** 한 줄에서 bullet point 또는 일반 텍스트를 정리. 비어있으면 null. */
function extractBulletText(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  // bullet 마커 제거: - * +
  const m = trimmed.match(/^[-*+]\s+(.*)$/);
  if (m) {
    const text = (m[1] ?? '').trim();
    return text === '' ? null : text;
  }
  return trimmed;
}

/** 모델 출력 텍스트에서 ## 추론 섹션을 찾아 4분류로 파싱.
 *  없으면 null. */
export function parseReasoningSection(text: string): ReasoningSection | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split(/\r?\n/);

  // 추론 헤딩 위치 찾기
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_REGEX.test((lines[i] ?? '').trim())) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;

  const bucket = emptyBucket();
  let currentKey: keyof Bucket | null = null;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // 같은 레벨(##) 헤딩 만나면 종료
    if (/^##\s+/.test(trimmed) && !HEADING_REGEX.test(trimmed)) break;
    // 더 상위(#) 헤딩 만나면 종료
    if (/^#\s+/.test(trimmed)) break;

    // 서브헤딩
    const subMatch = trimmed.match(SUBHEADING_REGEX);
    if (subMatch) {
      const mapped = mapSubheading(subMatch[1] ?? '');
      currentKey = mapped;
      continue;
    }

    if (currentKey === null) continue;

    const text = extractBulletText(line);
    if (text !== null) {
      bucket[currentKey].push(text);
    }
  }

  return bucket;
}

/** 텍스트에 ## 추론 헤딩이 존재하는지만 빠르게 검사 */
export function hasReasoningSection(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (HEADING_REGEX.test(line.trim())) return true;
  }
  return false;
}

const PLACEHOLDER_ITEMS = new Set([
  '없음',
  '없습니다',
  '해당 없음',
  '해당없음',
  '해당 사항 없음',
  '해당사항 없음',
  '특별히 없음',
  '특이사항 없음',
  'none',
  'none so far',
  'n/a',
  'na',
  'nothing',
  'no assumptions',
  'no assumption',
  'no speculation',
  'no speculations',
  '-',
  '—',
  '–',
]);

/** An item that only says the category is empty, such as `- 없음`, which the rationale
 *  gate tells the agent to write for an empty category. A placeholder followed by a note
 *  in parentheses or after a dash or colon (`없음 (모두 Read로 확인)`, `없음 — 사용자 확인
 *  완료`) is one too: counting it blocked clean reviews that explain their empty category
 *  (round-3 final security review). Unless the note states an assumption itself
 *  (`없음 — 단, 백엔드가 JSON을 반환한다고 가정`): then the item counts (round-3 closing
 *  security review). */
export function isPlaceholderItem(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/^[(*_`]+|[)*_`.。!]+$/gu, '')
    .trim();
  if (PLACEHOLDER_ITEMS.has(t)) return true;
  const head = /^(.+?)\s*(?:[(（—–:：]|\s-\s)/u.exec(t)?.[1];
  if (head === undefined || !PLACEHOLDER_ITEMS.has(head.replace(/[*_`]+$/u, '').trim())) return false;
  return !ASSUMPTION_WORDS.test(t.slice(head.length));
}

// Words that make a note an assumption: 가정, 추정, 추측, 전제, 아마, assume, suppose, presume, probably, likely.
const ASSUMPTION_WORDS = /가정|추정|추측|전제|아마|assum|suppos|presum|probabl|likely/u;

/** Assumptions plus speculations, without placeholder items. The Stop's assumption-review
 *  link counts these. The parser keeps the placeholders, because the rationale gate (A1)
 *  counts `- 없음` as content. Once F3 parsed the skill template's labels, a template-
 *  following section with only `- 없음` placeholders blocked a clean review (round-3
 *  security review). */
export function countDeclaredUnknowns(section: ReasoningSection): number {
  if (!section) return 0;
  const real = (items: unknown): number =>
    Array.isArray(items) ? items.filter((t) => typeof t === 'string' && !isPlaceholderItem(t)).length : 0;
  return real(section.speculations) + real(section.assumptions);
}
