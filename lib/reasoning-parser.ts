// ## 추론 섹션 파싱 (사실/추론/가정/추측 4분류)

import type { ReasoningSection } from './types';

const HEADING_REGEX = /^##\s+(추론|Reasoning)\s*$/i;
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
  const l = label.trim().toLowerCase().replace(/[^\p{L}\p{N}]+$/u, '').trim();
  if (l === '사실' || l === 'facts' || l === 'fact') return 'facts';
  if (l === '추론' || l === 'inferences' || l === 'inference') return 'inferences';
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

export function countSpeculations(section: ReasoningSection): number {
  if (!section || !Array.isArray(section.speculations)) return 0;
  return section.speculations.length;
}
