// Bash를 통한 파일 쓰기 탐지 (라이브 검증에서 발견된 우회 경로).
//
// 배경: Edit/Write 도구에는 read-before-edit·추론 게이트가 걸려 있고, PostToolUse가
// 편집을 기록해 리뷰 강제/자동 검증으로 이어진다. 그런데 `cat > src/x.ts <<EOF` 같은
// Bash 리다이렉션은 이 모든 층을 통과한다 — 실제로 추론 게이트에 8회 막힌 서브에이전트가
// heredoc으로 우회해 소스를 덮어쓴 사례를 관측했다.
//
// 정책: 프로젝트(cwd) 안의 파일을 Bash로 쓰려 하면 막고 Edit/Write 도구로 유도한다.
// 오탐을 줄이기 위해 (1) 리다이렉션/tee/sed -i/dd of= 라는 명시적 쓰기 구문만 보고,
// (2) cwd 밖 경로(예: mktemp -d 프로브)와 빌드/런타임 산출물 경로는 허용한다.
//
// 알려진 한계: `python -c "open('x','w')"` 처럼 인터프리터 내부에서 쓰는 경우는 잡지 못한다.
// 완전 차단이 아니라 "무심코 우회"를 막는 것이 목적이다.

import { resolve as resolvePath, sep } from 'node:path';

/** 쓰기 대상으로 보이지 않는 리다이렉션 타깃 (fd 복제 등) */
function isFdTarget(target: string): boolean {
  return target.startsWith('&');
}

/** 따옴표 제거 */
function unquote(t: string): string {
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1);
  }
  return t;
}

const TOKEN = `"[^"]*"|'[^']*'|[^\\s;|&<>]+`;

/** heredoc 본문 제거 전처리 (v0.26.1, 실측 오탐 대응).
 *
 *  heredoc 본문은 데이터인데 명령으로 스캔하면 본문의 `>=`·`->` 등이 리다이렉션으로
 *  오탐되고, 종결자(EOF 등)가 쓰기 대상 파일로 오인된다(전부 실측). `<<DELIM`을 찾아
 *  그 지점부터 "줄 전체가 종결자와 일치하는 줄"까지를 제거한다. 단 `<<DELIM`이 있던
 *  줄의 나머지(`cat <<EOF > src/a.ts`의 `> src/a.ts`)는 명령이므로 스캔 대상으로 남긴다.
 *  종결자를 못 찾으면(열린 heredoc) 나머지 전체를 본문으로 간주한다.
 *  `<<<`(herestring)는 heredoc이 아니다. `<<`는 리다이렉션 연산자로 취급하지 않는다. */
function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i] ?? '';
    // 한 줄에 여러 heredoc(`cat <<A <<B`)이 있을 수 있어 반복 수집.
    const delims: Array<{ delim: string; stripTabs: boolean }> = [];
    let m: RegExpExecArray | null;
    while ((m = /(?<!<)<<(?!<)(-?)\s*(['"]?)(\w+)\2/.exec(line)) !== null) {
      delims.push({ delim: m[3] ?? '', stripTabs: m[1] === '-' });
      // 연산자+종결자 표기를 명령 텍스트에서 제거(공백으로 치환) — 줄의 나머지는 유지.
      line = line.slice(0, m.index) + ' ' + line.slice(m.index + m[0].length);
    }
    out.push(line);
    i++;
    // 본문 스킵: 각 heredoc 순서대로, 줄 전체가 종결자와 일치하는 줄까지 소비.
    for (const { delim, stripTabs } of delims) {
      while (i < lines.length) {
        const body = lines[i] ?? '';
        const cmp = stripTabs ? body.replace(/^\t+/, '') : body;
        i++;
        if (cmp === delim) break;
      }
    }
  }
  return out.join('\n');
}

/** 리다이렉션(> >> &> 2>) 타깃 — 따옴표 상태를 추적하는 문자 단위 스캐너 (v0.26.1).
 *
 *  기존 정규식 방식은 따옴표 안의 꺾쇠(`git commit -m '<a@b.com>'`), 화살표 함수(`=>`),
 *  비교 연산자(`>=`)를 리다이렉션으로 오탐했다(전부 실측). 규칙:
 *   - 작은따옴표/큰따옴표 안의 `>`는 무시한다.
 *   - 직전 문자가 `=`인 `>`(화살표 함수 `=>`), 직후 문자가 `=`인 `>`(비교 `>=`)는 제외.
 *   - fd 복제(`2>&1`, `>&2`)는 대상이 `&`로 시작하므로 제외.
 *   - 대상 토큰은 따옴표를 벗겨 추출한다(따옴표로 감싼 대상 경로의 정상 탐지는 유지). */
function redirectTargets(command: string): string[] {
  const out: string[] = [];
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && !inSingle) {
      i++; // 백슬래시 이스케이프 — 다음 문자는 리터럴
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch !== '>') continue;
    if (i > 0 && command[i - 1] === '=') continue; // 화살표 함수 `=>`
    let j = i + 1;
    if (command[j] === '>') j++; // `>>` append
    if (command[j] === '=') {
      i = j; // 비교 연산자 `>=`
      continue;
    }
    if (command[j] === '&') {
      i = j; // fd 복제 `>&2`, `2>&1`
      continue;
    }
    while (command[j] === ' ' || command[j] === '\t' || command[j] === '\n') j++;
    // 대상 토큰 추출(따옴표 인식)
    let target = '';
    const q = command[j];
    if (q === '"' || q === "'") {
      j++;
      while (j < command.length && command[j] !== q) {
        target += command[j];
        j++;
      }
      j++; // 닫는 따옴표
    } else {
      while (j < command.length && !/[\s;|&<>]/.test(command[j] ?? '')) {
        target += command[j];
        j++;
      }
    }
    // 프로세스 치환 `>(cmd)`은 파일 쓰기가 아니다.
    if (target !== '' && !isFdTarget(target) && !target.startsWith('(')) out.push(target);
    i = j - 1;
  }
  return out;
}

/** tee [-a] FILE... */
function teeTargets(command: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\btee\\b((?:\\s+-\\S+)*)((?:\\s+(?:${TOKEN}))+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    for (const raw of (m[2] ?? '').trim().split(/\s+/)) {
      const t = unquote(raw);
      if (t !== '' && !t.startsWith('-')) out.push(t);
    }
  }
  return out;
}

/** 토큰이 sed 스크립트로 보이는가 (s/a/b/, y|a|b|, 3d, '1,2p' 등) */
function looksLikeSedScript(t: string): boolean {
  if (/^\d*(?:,\d+)?\s*[sy]\W/.test(t)) return true; // s/.../.../, 1,2s|a|b|
  if (/^\d+(?:,\d+)?[a-z]$/.test(t)) return true; // 3d, 1,2p
  if (/^-?e$/.test(t)) return true;
  return false;
}

/** sed -i ... FILE (in-place 편집) */
function sedInPlaceTargets(command: string): string[] {
  const out: string[] = [];
  for (const seg of command.split(/[;|]|&&|\|\|/)) {
    if (!/\bsed\b/.test(seg)) continue;
    // -i, -i.bak, -i '' (BSD), 결합 옵션(-ie) 모두 in-place
    if (!/\s-\w*i/.test(seg)) continue;
    const tokens = seg.trim().split(/\s+/);
    const sedIdx = tokens.findIndex((t) => t === 'sed' || t.endsWith('/sed'));
    if (sedIdx < 0) continue;
    for (const raw of tokens.slice(sedIdx + 1)) {
      const t = unquote(raw);
      if (t === '' || t.startsWith('-')) continue;
      if (looksLikeSedScript(t)) continue;
      out.push(t);
    }
  }
  return out;
}

/** dd of=FILE */
function ddTargets(command: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\bdd\\b[^;|]*\\bof=(${TOKEN})`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const t = unquote(m[1] ?? '');
    if (t !== '') out.push(t);
  }
  return out;
}

const ALWAYS_ALLOWED = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** cwd 기준 상대 경로 조각이 산출물/메타 디렉터리인가 */
function isAllowedInsideProject(rel: string): boolean {
  const first = rel.split(sep)[0] ?? '';
  if (['.claude', '.git', 'node_modules', 'dist', 'build', 'coverage', 'target'].includes(first)) {
    return true;
  }
  // 로그 파일은 흔한 정당 용례(빌드 로그 등)
  if (rel.endsWith('.log')) return true;
  return false;
}

/** 사용자 지정 허용 접두사 (콤마 구분, cwd 기준 상대 경로) */
function extraAllowed(): string[] {
  const raw = (process.env.GOODBOY_BASH_WRITE_ALLOW ?? '').trim();
  if (raw === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 이 Bash 명령이 프로젝트 안의 파일을 쓰려 하면 그 경로들을 반환. 없으면 빈 배열.
 *  절대 throw 하지 않는다(파싱 실패 = 빈 배열 = fail-open). */
export function classifyBashWrite(command: string, cwd: string): string[] {
  if (typeof command !== 'string' || command.trim() === '') return [];
  let targets: string[];
  try {
    // heredoc 본문(데이터)을 제거한 명령 텍스트만 스캔한다 — 본문의 연산자 오탐 방지.
    const scanned = stripHeredocs(command);
    targets = [
      ...redirectTargets(scanned),
      ...teeTargets(scanned),
      ...sedInPlaceTargets(scanned),
      ...ddTargets(scanned),
    ];
  } catch {
    return [];
  }
  if (targets.length === 0) return [];

  const allowExtra = extraAllowed();
  const cwdAbs = (() => {
    try {
      return resolvePath(cwd);
    } catch {
      return '';
    }
  })();
  if (cwdAbs === '') return [];

  const denied = new Set<string>();
  for (const t of targets) {
    if (ALWAYS_ALLOWED.has(t)) continue;
    // 변수/치환이 섞인 타깃은 판정 불가 → fail-open(허용)
    if (/[$`*?]/.test(t)) continue;
    let abs: string;
    try {
      abs = resolvePath(cwdAbs, t);
    } catch {
      continue;
    }
    // cwd 밖(예: mktemp -d 프로브, /tmp)은 허용.
    //   ⚠️ "임시 디렉터리 전체 허용"으로 구현하면 안 된다 — 프로젝트가 임시 폴더 안에
    //   있을 때(테스트 샌드박스 등) 게이트가 통째로 무력화된다(실측). cwd 기준만 본다.
    if (abs !== cwdAbs && !abs.startsWith(cwdAbs + sep)) continue;
    const rel = abs.slice(cwdAbs.length + 1);
    if (rel === '') continue;
    if (isAllowedInsideProject(rel)) continue;
    if (allowExtra.some((p) => rel === p || rel.startsWith(p.endsWith(sep) ? p : p + sep))) continue;
    denied.add(abs);
  }
  return Array.from(denied);
}

export function bashWriteMessage(files: string[]): string {
  const preview = files.slice(0, 3).join(', ');
  const more = files.length > 3 ? ` 외 ${files.length - 3}개` : '';
  return (
    `Bash로 프로젝트 파일을 쓰려 합니다: ${preview}${more}. ` +
    '파일 생성·수정은 Edit/Write 도구를 쓰세요 — Bash 리다이렉션(> >> tee sed -i)은 ' +
    'read-before-edit·추론 게이트·리뷰 추적·자동 검증을 모두 우회합니다. ' +
    '임시 프로브 파일이 필요하면 `mktemp -d`가 만든 디렉터리(프로젝트 밖)에 만드세요. ' +
    '(Bash 쓰기 게이트, GOODBOY_BASH_WRITE_GATE=off로 해제 가능)'
  );
}
