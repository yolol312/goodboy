// Skill frontmatter 파싱 + 누락 input 검출 + AskUserQuestion 컨텍스트 빌드
//
// 외부 YAML 라이브러리 없이 매우 단순한 형태만 지원한다.
// 지원 형태:
//   ---
//   name: skill-name
//   description: "..."
//   risk_default: medium
//   required_inputs:
//     - name: reproduction_steps
//       question: "버그를 어떻게 재현하나요?"
//       allow_unknown: true
//     - name: expected_behavior
//       question: 기대 동작은?
//       allow_unknown: false
//   ---

import { readFileSync } from 'node:fs';
import type { RequiredInput, RiskLevel } from './types';

export interface SkillFrontmatter {
  name: string;
  description: string;
  required_inputs: RequiredInput[];
  risk_default: RiskLevel;
}

/** 따옴표 제거 헬퍼 */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** "true"/"false" 문자열을 boolean으로. 기본값은 true */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === 'y') return true;
  if (v === 'false' || v === 'no' || v === 'n') return false;
  return fallback;
}

function parseRiskLevel(raw: string | undefined): RiskLevel {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'simple' || v === 'medium' || v === 'risky') return v;
  return 'medium';
}

/** required_inputs 블록을 파싱. 들여쓰기 기반 매우 단순한 YAML. */
function parseRequiredInputsBlock(lines: string[], startIdx: number): { items: RequiredInput[]; nextIdx: number } {
  const items: RequiredInput[] = [];
  let i = startIdx;
  let current: Partial<RequiredInput> | null = null;
  const baseIndentRegex = /^(\s*)-\s*(.*)$/;
  // 첫 list item의 들여쓰기를 기준으로 함
  let listIndent = -1;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') { i++; continue; }
    // 들여쓰기가 풀린 줄 → 블록 종료
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1]!.length : 0;
    const trimmed = line.trim();

    // 새 키 (`some_key:`)가 들여쓰기 0에서 시작하면 블록 종료
    if (indent === 0 && /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(trimmed)) {
      break;
    }

    const itemMatch = line.match(baseIndentRegex);
    if (itemMatch && (listIndent === -1 || indent === listIndent)) {
      if (listIndent === -1) listIndent = indent;
      // 새 아이템 시작
      if (current && current.name !== undefined) {
        items.push({
          name: current.name,
          question: current.question ?? '',
          allow_unknown: current.allow_unknown ?? true,
        });
      }
      current = {};
      const afterDash = itemMatch[2] ?? '';
      // `- name: foo` 같은 인라인 형태 처리
      const kv = afterDash.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (kv) {
        const key = kv[1]!;
        const val = unquote(kv[2] ?? '');
        if (key === 'name') current.name = val;
        else if (key === 'question') current.question = val;
        else if (key === 'allow_unknown') current.allow_unknown = parseBool(val, true);
      }
      i++;
      continue;
    }

    // 아이템 내부의 추가 키 (들여쓰기가 listIndent보다 깊음)
    if (current && indent > listIndent) {
      const kv = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (kv) {
        const key = kv[1]!;
        const val = unquote(kv[2] ?? '');
        if (key === 'name') current.name = val;
        else if (key === 'question') current.question = val;
        else if (key === 'allow_unknown') current.allow_unknown = parseBool(val, true);
      }
      i++;
      continue;
    }

    // 그 외의 경우 블록 종료
    break;
  }

  if (current && current.name !== undefined) {
    items.push({
      name: current.name,
      question: current.question ?? '',
      allow_unknown: current.allow_unknown ?? true,
    });
  }

  return { items, nextIdx: i };
}

/** SKILL.md 파일을 읽어 frontmatter 파싱. 실패 시 null. */
export function parseSkillFrontmatter(skillPath: string): SkillFrontmatter | null {
  try {
    const content = readFileSync(skillPath, 'utf8');
    const lines = content.split(/\r?\n/);
    if ((lines[0] ?? '').trim() !== '---') return null;

    // 닫는 --- 찾기
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trim() === '---') { endIdx = i; break; }
    }
    if (endIdx === -1) return null;

    const fmLines = lines.slice(1, endIdx);

    let name = '';
    let description = '';
    let riskDefault: RiskLevel = 'medium';
    let requiredInputs: RequiredInput[] = [];

    for (let i = 0; i < fmLines.length; i++) {
      const line = fmLines[i] ?? '';
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      const kv = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1]!;
      const val = kv[2] ?? '';

      if (key === 'name') name = unquote(val);
      else if (key === 'description') description = unquote(val);
      else if (key === 'risk_default') riskDefault = parseRiskLevel(val);
      else if (key === 'required_inputs') {
        if (val.trim() === '' || val.trim() === '[]') {
          // 다음 줄들에서 list 파싱
          const { items, nextIdx } = parseRequiredInputsBlock(fmLines, i + 1);
          requiredInputs = items;
          i = nextIdx - 1;
        }
      }
    }

    return {
      name,
      description,
      risk_default: riskDefault,
      required_inputs: requiredInputs,
    };
  } catch {
    return null;
  }
}

/** 사용자 프롬프트에서 명시되지 않은 required_inputs 추출.
 *  보수적 휴리스틱: input의 name이나 question의 핵심 단어가 프롬프트에 나타나지 않으면 missing.
 *  완벽하지 않지만 후속으로 LLM이 AskUserQuestion으로 묶어 처리한다. */
export function detectMissingInputs(userPrompt: string, required: RequiredInput[]): RequiredInput[] {
  if (!Array.isArray(required) || required.length === 0) return [];
  const prompt = (userPrompt ?? '').toLowerCase();
  const missing: RequiredInput[] = [];

  for (const input of required) {
    const tokens = extractKeyTokens(input);
    // 토큰이 하나라도 prompt에 등장하면 충족된 것으로 본다.
    let matched = false;
    for (const token of tokens) {
      if (token.length < 2) continue;
      if (prompt.includes(token)) { matched = true; break; }
    }
    if (!matched) missing.push(input);
  }
  return missing;
}

function extractKeyTokens(input: RequiredInput): string[] {
  const tokens = new Set<string>();
  // name: snake_case -> 단어들
  for (const part of (input.name ?? '').split(/[_\-\s]+/)) {
    if (part) tokens.add(part.toLowerCase());
  }
  // question: 영문 단어 + 한국어 어절 (공백/구두점 분리)
  for (const part of (input.question ?? '').split(/[\s,.\?!:;()\[\]"']+/)) {
    const t = part.trim().toLowerCase();
    if (t && t.length >= 2) tokens.add(t);
  }
  return Array.from(tokens);
}

/** additionalContext로 주입할 한국어 instruction 빌드.
 *  AskUserQuestion으로 묶어 물어보고, 각 질문에 "확인 필요" 옵션을 자동 추가하라고 LLM에게 지시.
 *
 *  @deprecated 키워드 매칭 기반 "누락 N개" 방식은 false-positive가 많고 키워드 스터핑으로
 *  우회 가능하다. 대신 buildRequiredInputsChecklist를 사용해 모델 자기점검(self-attestation)으로
 *  전환했다. 하위호환을 위해 유지한다. */
export function buildAskQuestionsInstruction(missing: RequiredInput[]): string {
  if (!Array.isArray(missing) || missing.length === 0) return '';
  const lines: string[] = [];
  lines.push('이 작업 전에 다음 정보를 사용자에게 묶어서 물어보세요. AskUserQuestion 도구를 사용하고, 각 질문에 "확인 필요" 옵션을 자동으로 추가하세요.');
  lines.push('');
  for (const input of missing) {
    const q = (input.question ?? '').trim() || `${input.name}에 대한 값`;
    lines.push(`- ${input.name}: ${q}`);
  }
  lines.push('');
  lines.push('사용자가 "확인 필요"를 선택한 항목은 가정으로 표시하고, 후속 ## 근거 섹션의 가정 목록에 포함하세요.');
  return lines.join('\n');
}

/** (B2 확장) 일반(비-슬래시) 프롬프트용 부족-입력 질문 유도 지시.
 *
 *  카테고리 커맨드에는 required_inputs 체크리스트가 붙지만, 일반 자연어 프롬프트는
 *  무방비였다. hook은 "요청이 충분한가"를 의미적으로 판정할 수 없으므로(키워드 매칭은
 *  오탐/우회 문제로 의도적 폐기 — 위 @deprecated 참고), 같은 self-assessment 방식을
 *  일반 프롬프트로 일반화한다: 충분한지의 판단은 모델이 하되, 부족하면 지어내지 말고
 *  질문하라는 행동 규칙을 매 프롬프트에 주입한다.
 *
 *  무시에 대한 안전망: 질문 대신 가정하고 진행하면, 그 가정은 근거 섹션(## 근거 > 가정)에
 *  기록해야 하고(근거 게이트 A1 — 기본 warn은 안내, deny면 차단), 기록된 가정은 리뷰가 검증해야 통과된다(추측-리뷰 연동 A2)
 *  — 즉 "묻지 않고 넘어가기"에도 비용이 있다. env GOODBOY_ASK_UNCLEAR=on|off (기본 on). */
export const ASK_WHEN_UNCLEAR_INSTRUCTION = [
  'If this request is a task (changing or writing code, debugging, changing configuration),',
  'check before you start that you have the key facts (self-assessment): what to change and',
  'where, the expected behavior, for a bug how to reproduce it and what happens now, and the scope.',
  '1. Ask only for what is really missing, in one AskUserQuestion call before the first edit',
  '   (every open decision of the task in it; no edits while it is open), and give each question',
  '   a "확인 필요" option.',
  '2. Never make up an answer the user marked "확인 필요" or could not give. Record it as an',
  '   explicit assumption in the rationale section (`## 근거` > `가정`, or `## Rationale` > `Assumptions`).',
  '3. If the facts are already there, or this is a question, a conversation or a small decision,',
  '   do not ask; go ahead.',
  '(ask when unclear, B2)',
].join('\n');

/** (track G, R2) Stop rule for outward effects, injected with the B2 guidance. The hook
 *  backstop for subagents is the outward-command gate; env GOODBOY_OUTWARD_GATE=off drops both. */
export const OUTWARD_EFFECT_INSTRUCTION = [
  'Never run anything that changes a live external or production system (deploys, remote',
  'databases, third-party APIs that change state, pushes, messages). Use a sandbox or',
  'temporary target instead; if none fits the task, ask the user first. Reading is fine.',
  '(stop rule R2)',
].join('\n');

/** additionalContext로 주입할 self-attestation 체크리스트 instruction 빌드.
 *
 *  설계 의도: 훅이 기계적으로 "어떤 input이 누락인지" 판정하지 않는다(키워드 매칭은
 *  false-positive가 많고 단어를 끼워넣으면 우회됨). 대신 해당 스킬의 required_inputs 전체를
 *  모델에게 제시하고, 각 항목을 사용자 프롬프트가 이미 충족하는지 모델이 직접 자기점검하게 한다.
 *  - 이미 충족된 항목은 다시 묻지 않는다.
 *  - 진짜로 충족되지 않은 항목만 AskUserQuestion으로 묶어 묻는다.
 *  - 사용자가 답하지 못하는 항목은 절대 지어내지 말고 `## 근거 > 가정` 섹션에 명시적 가정으로 기록한다. */
export function buildRequiredInputsChecklist(required: RequiredInput[]): string {
  if (!Array.isArray(required) || required.length === 0) return '';
  const lines: string[] = [];
  lines.push('This skill needs the inputs below. For each one, judge whether the user\'s prompt already specifies it (self-assessment).');
  lines.push('');
  lines.push('Required inputs:');
  for (const input of required) {
    const q = (input.question ?? '').trim() || `a value for ${input.name}`;
    const unknownNote = input.allow_unknown === false ? ' (the user must confirm)' : '';
    lines.push(`- ${input.name}: ${q}${unknownNote}`);
  }
  lines.push('');
  lines.push('Rules:');
  lines.push('1. Do not ask again for an input the prompt already covers. Judge by what is actually specified, not by whether a word appears.');
  lines.push('2. Ask only for inputs that are really missing, in one AskUserQuestion call, with a "확인 필요" option on each question.');
  lines.push('3. Never make up an answer for an input the user marked "확인 필요" or cannot answer (no fabrication). Record the assumption you proceed on in the rationale section (`## 근거` > `가정`, or `## Rationale` > `Assumptions`).');
  return lines.join('\n');
}
