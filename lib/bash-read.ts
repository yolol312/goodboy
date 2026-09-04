// Bash를 통한 파일 읽기 탐지 — 편집 기록의 짝을 맞춘다.
//
// 배경: PostToolUse는 `Read` **도구** 호출만 읽기로 기록한다. 그런데 bypass permissions
// 모드에서는 시스템 프롬프트가 "파일은 cat/head/sed -n 으로 읽어라"라고 지시한다.
// 그 결과 정직하게 파일을 읽고 정확히 인용한 세션조차 읽기 기록이 하나도 남지 않는다
// (이 플러그인을 만든 세션이 정확히 그 상태였다 — Read 도구 호출 0회, cat/sed 수십 회).
//
// 그 공백이 두 곳을 무력화한다:
//   1. read-before-edit 게이트 — cat으로 읽고 Edit하면 "안 읽었다"고 차단(오차단)
//   2. 층0 인용 검증 — 인용의 근거가 되는 "그 파일을 봤는가"를 판정할 수 없음
//
// 정책: **파일 내용을 보여주는 명령**만 읽기로 기록한다.
//   기록함: cat, bat, head, tail, less, more, view, sed -n(-i 아님), nl
//   기록 안 함: grep, rg, awk, find …
//     — 검색은 "그 파일을 봤다"는 증거가 못 된다. `grep -l foo .` 후 편집을 허용하면
//       read-before-edit이 실질적으로 무력화된다. Read 도구의 offset/limit 부분 읽기가
//       이미 읽기로 인정되므로 head/tail/sed -n 을 인정하는 것과는 성격이 다르다.
//
// fail-open: 파싱 실패는 빈 배열(기록 없음). 절대 throw 하지 않는다.

import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { OP_TOKEN, stripHeredocs, tokenizeSegments } from './bash-write';

/** 파일 내용을 그대로 보여주는 명령들. */
const CONTENT_READERS = new Set(['cat', 'bat', 'head', 'tail', 'less', 'more', 'view', 'nl']);

/** 값을 인자로 받는 옵션 — 다음 토큰은 파일이 아니라 옵션 값이다. */
const VALUE_OPTS = new Set(['-n', '-c', '-q', '--lines', '--bytes', '-C', '-A', '-B']);

/** 토큰이 파일 경로 후보인가. 옵션·빈 토큰·연산자 마커·와일드카드/치환은 제외. */
function looksLikePath(token: string): boolean {
  if (token === '' || token === OP_TOKEN) return false;
  if (token.startsWith('-')) return false;
  // 변수/치환/글롭이 섞이면 판정 불가 → 기록하지 않는다(잘못된 경로를 읽었다고 기록하는 것보다 낫다)
  if (/[$`*?]/.test(token)) return false;
  return true;
}

/** 한 세그먼트(파이프/세미콜론으로 나뉜 한 명령)에서 읽은 파일 후보를 뽑는다. */
function readTargetsInSegment(tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  // 앞쪽의 env 대입(FOO=bar cmd …)은 건너뛴다.
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
  const head = tokens[i] ?? '';
  const base = head.includes('/') ? (head.split('/').pop() ?? '') : head;
  if (base === '') return [];

  const rest = tokens.slice(i + 1);
  const out: string[] = [];

  if (CONTENT_READERS.has(base)) {
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k] ?? '';
      if (t === OP_TOKEN) break; // 리다이렉션 이후는 읽기 대상이 아니다
      if (VALUE_OPTS.has(t)) {
        k++; // 옵션 값 건너뛰기 (`head -n 20 file`)
        continue;
      }
      if (looksLikePath(t)) out.push(t);
    }
    return out;
  }

  if (base === 'sed') {
    // in-place 편집은 읽기가 아니라 쓰기다(bash-write 소관).
    if (rest.some((t) => /^-\w*i/.test(t))) return [];
    // `sed -n '10,40p' file` — 스크립트 토큰을 지나 파일 인자만 취한다.
    let sawScript = false;
    for (const t of rest) {
      if (t === OP_TOKEN) break;
      if (t === '' || t.startsWith('-')) continue;
      if (!sawScript) {
        // 첫 비옵션 토큰은 sed 스크립트다.
        sawScript = true;
        continue;
      }
      if (looksLikePath(t)) out.push(t);
    }
    return out;
  }

  return [];
}

/**
 * 이 Bash 명령이 **프로젝트(cwd) 안의** 어떤 파일을 읽었는지 절대경로로 반환한다.
 * 실재하지 않는 경로는 제외한다(오탈자/리다이렉션 잔여물이 읽기로 기록되지 않게).
 */
export function classifyBashRead(command: string, cwd: string): string[] {
  if (typeof command !== 'string' || command.trim() === '') return [];
  let targets: string[];
  try {
    const scanned = stripHeredocs(command);
    targets = tokenizeSegments(scanned).flatMap((tokens) => readTargetsInSegment(tokens));
  } catch {
    return [];
  }
  if (targets.length === 0) return [];

  const cwdAbs = (() => {
    try {
      return resolvePath(cwd);
    } catch {
      return '';
    }
  })();
  if (cwdAbs === '') return [];

  const found = new Set<string>();
  for (const t of targets) {
    let abs: string;
    try {
      abs = resolvePath(cwdAbs, t);
    } catch {
      continue;
    }
    // 프로젝트 밖 파일은 추적하지 않는다 — 게이트가 보는 대상이 프로젝트 파일뿐이다.
    if (abs !== cwdAbs && !abs.startsWith(cwdAbs + sep)) continue;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    } catch {
      continue;
    }
    found.add(abs);
  }
  return Array.from(found);
}

/** 읽기 기록에 함께 남길 mtime. 실패하면 undefined(= mtime 없이 기록). */
export function safeMtime(abs: string): number | undefined {
  try {
    return statSync(abs).mtimeMs;
  } catch {
    return undefined;
  }
}
