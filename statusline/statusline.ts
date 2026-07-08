#!/usr/bin/env bun
// Good Boy 동봉 상태바 (3층 구조의 3층, 선택 설치).
//
// 핵심 설계: 컨텍스트 %는 강제 compact 게이트가 실제로 쓰는 계산기(getContextUsage)로
// 직접 계산한다 — 사용자가 보는 숫자와 프레임워크가 행동하는 기준이 항상 일치한다
// (외부 상태바는 다른 방식으로 계산해 "상태바는 16%인데 왜 강제?"류 혼란을 만들 수 있다).
//
// 나머지 상태(카테고리/위험도/리뷰 대기/검증 실패/게이트 deny 누계)는 Stop hook이
// 매 턴 갱신하는 status.json 스냅샷에서 읽는다.
//
// 입력: Claude Code statusline 표준 stdin JSON (session_id / transcript_path / model / cwd 등).
// 출력: 한 줄. 어떤 실패에도 최소 '🐶 goodboy'는 출력한다(fail-open).
//
// 설치: /setup-statusline 스킬 참고 (settings.json의 statusLine.command로 등록).
// 기존 상태바 보유자: 이 스크립트 대신 status.json을 직접 읽어 한 칸 추가할 수 있다
// (경로: readStatusSnapshot / statusFilePath — README '상태바' 절 참고).

import { resolve as resolvePath } from 'node:path';
import { getContextUsage, readStatusSnapshot } from '../lib';

interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string } | string;
  workspace?: { current_dir?: string; project_dir?: string };
}

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function settingsJsonPath(): string | null {
  try {
    const home = process.env.HOME;
    if (!home || home.trim() === '') return null;
    return resolvePath(home, '.claude', 'settings.json');
  } catch {
    return null;
  }
}

/** 위험도 → 이모지. */
function riskBadge(risk: string | null | undefined): string | null {
  if (risk === 'simple') return '🟢';
  if (risk === 'medium') return '🟡';
  if (risk === 'risky') return '🔴';
  return null;
}

async function main(): Promise<void> {
  let line = '🐶 goodboy';
  try {
    const raw = await readStdin();
    const input: StatuslineInput = raw.trim() === '' ? {} : (JSON.parse(raw) as StatuslineInput);

    const parts: string[] = [];

    // (1) 컨텍스트 % — 게이트와 동일 계산기. 모델 힌트는 stdin의 model.id를 전달.
    const modelHint =
      typeof input.model === 'string' ? input.model : (input.model?.id ?? undefined);
    let ctx: { percent: number; confident: boolean } | null = null;
    if (input.transcript_path) {
      try {
        const usage = getContextUsage(input.transcript_path, {
          hookInput: modelHint ? { model: modelHint } : null,
          settingsPath: settingsJsonPath(),
        });
        if (usage) ctx = { percent: usage.percent, confident: usage.confident };
      } catch {
        ctx = null;
      }
    }

    // (2) Stop 스냅샷 — 위험도/리뷰/검증/게이트 상태 (+ 컨텍스트 폴백).
    const snapshot = input.session_id ? readStatusSnapshot(input.session_id) : null;
    if (ctx === null && snapshot?.context) {
      ctx = { percent: snapshot.context.percent, confident: snapshot.context.confident };
    }

    if (ctx) {
      // 미확정 한도(강제 보류 상태)는 '?'로 표기해 사용자가 GOODBOY_CONTEXT_LIMIT 설정 필요를 알게 한다.
      parts.push(`🧠 ${Math.round(ctx.percent)}%${ctx.confident ? '' : '?'}`);
    }

    if (snapshot) {
      const badge = riskBadge(snapshot.risk);
      if (snapshot.category) parts.push(`${badge ?? ''}${snapshot.category}`);
      if (snapshot.validationFailed) parts.push('🔧 검증실패');
      if (snapshot.reviewPending) parts.push('📋 리뷰대기');
      if (typeof snapshot.gateDenies === 'number' && snapshot.gateDenies > 0) {
        parts.push(`🚧 ${snapshot.gateDenies}`);
      }
    }

    line = parts.length > 0 ? `🐶 ${parts.join(' | ')}` : '🐶 goodboy';
  } catch {
    // fail-open — 최소 출력 유지
  }
  try {
    process.stdout.write(line);
  } catch {
    // best-effort
  }
}

if (import.meta.main) {
  main();
}
